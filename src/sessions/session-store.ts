import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../state/atomic-write.js';
import { withFileLock } from '../state/file-lock.js';
import { getStateRoot } from '../state/paths.js';
import { createNonce, createSessionId } from './nonce.js';
import { isPermissionProfileName, type PermissionProfileName } from './profiles.js';

export const SESSION_TRANSPORTS = ['clipboard', 'extension', 'browser-yolo', 'api'] as const;

export type SessionTransport = typeof SESSION_TRANSPORTS[number];

export interface ConduitSession {
  sessionId: string;
  label: string;
  createdAt: string;
  expiresAt?: string;
  state: 'active' | 'paused' | 'awaiting_result_paste' | 'expired' | 'revoked';
  transport: SessionTransport;
  permissionProfile: PermissionProfileName;
  allowedRoots: string[];
  currentNonce: string;
  usedNonces: string[];
  lastActionAt?: string;
}

export interface CreateSessionInput {
  label: string;
  permissionProfile: PermissionProfileName;
  allowedRoots: string[];
  transport?: SessionTransport;
  expiresAt?: string;
}

export type SessionNonceValidation =
  | { ok: true; session: ConduitSession }
  | { ok: false; reason: string; sessionState?: ConduitSession['state'] };

const ConduitSessionSchema: z.ZodType<ConduitSession> = z.object({
  sessionId: z.string().min(1),
  label: z.string().min(1),
  createdAt: z.string().min(1),
  expiresAt: z.string().optional(),
  state: z.enum(['active', 'paused', 'awaiting_result_paste', 'expired', 'revoked']),
  transport: z.enum(SESSION_TRANSPORTS),
  permissionProfile: z.custom<PermissionProfileName>((value) => (
    typeof value === 'string' && isPermissionProfileName(value)
  ), 'unknown permission profile'),
  allowedRoots: z.array(z.string().min(1)),
  currentNonce: z.string().min(1),
  usedNonces: z.array(z.string().min(1)),
  lastActionAt: z.string().optional()
});

const SessionStoreFileSchema = z.object({
  sessions: z.array(ConduitSessionSchema)
});

export async function createSession(input: CreateSessionInput): Promise<ConduitSession> {
  const session: ConduitSession = {
    sessionId: createSessionId(),
    label: input.label,
    createdAt: new Date().toISOString(),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    state: 'active',
    transport: input.transport ?? 'clipboard',
    permissionProfile: input.permissionProfile,
    allowedRoots: input.allowedRoots.map((root) => path.resolve(root)),
    currentNonce: createNonce(),
    usedNonces: []
  };

  await mutateSessionStore((store) => {
    store.sessions.push(session);
  });
  return session;
}

export async function listSessions(): Promise<ConduitSession[]> {
  return (await readSessionStore()).sessions;
}

export async function getSession(sessionId: string): Promise<ConduitSession | null> {
  return (await readSessionStore()).sessions.find((session) => session.sessionId === sessionId) ?? null;
}

export async function revokeSession(sessionId: string): Promise<ConduitSession> {
  return updateSession(sessionId, (session) => ({
    ...session,
    state: 'revoked'
  }));
}

/**
 * Per-session pause (spec S1). Reuses the `paused` session state: a paused
 * session fails nonce validation and the runtime gate, so nothing runs for it,
 * but its nonce and grants are kept so `resumeSession` restores it unchanged.
 * Only an active session can be paused; pausing a paused session is a no-op.
 */
export async function pauseSession(sessionId: string): Promise<ConduitSession> {
  return updateSession(sessionId, (session) => {
    if (session.state === 'paused') return session;
    if (session.state !== 'active') {
      throw new Error(`Cannot pause a ${session.state} session.`);
    }
    return { ...session, state: 'paused' };
  });
}

/** Resumes a paused session. Revoked or expired sessions never come back. */
export async function resumeSession(sessionId: string): Promise<ConduitSession> {
  return updateSession(sessionId, (session) => {
    if (session.state === 'active') return session;
    if (session.state !== 'paused') {
      throw new Error(`Cannot resume a ${session.state} session.`);
    }
    return { ...session, state: 'active' };
  });
}

/** Revokes every session that could still run work. Used by stop-all (kill). */
export async function revokeAllLiveSessions(): Promise<ConduitSession[]> {
  return mutateSessionStore((store) => {
    const revoked: ConduitSession[] = [];
    store.sessions = store.sessions.map((session) => {
      if (session.state === 'revoked' || session.state === 'expired') return session;
      const updated: ConduitSession = { ...session, state: 'revoked' };
      revoked.push(updated);
      return updated;
    });
    return revoked;
  });
}

/**
 * Pure nonce validation, shared by the read-only check and the consuming
 * check-and-set. Unknown sessions report `Unknown session.` so callers that
 * ask to consume a nonce of a missing session see the same error as before.
 */
function checkNonce(session: ConduitSession | null, nonce: string): SessionNonceValidation {
  if (!session) {
    return { ok: false, reason: 'Unknown session.' };
  }

  if (session.state !== 'active') {
    return { ok: false, reason: `Session is ${session.state}.`, sessionState: session.state };
  }

  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
    return { ok: false, reason: 'Session is expired.', sessionState: 'expired' };
  }

  if (session.usedNonces.includes(nonce)) {
    return { ok: false, reason: 'Nonce was already used.' };
  }

  if (session.currentNonce !== nonce) {
    return { ok: false, reason: 'Nonce does not match current session nonce.' };
  }

  return { ok: true, session };
}

export async function validateSessionNonce(sessionId: string, nonce: string): Promise<SessionNonceValidation> {
  return checkNonce(await getSession(sessionId), nonce);
}

export async function consumeSessionNonce(sessionId: string, nonce: string): Promise<ConduitSession> {
  // Check-and-set under the store lock: two concurrent consumers of the same
  // nonce cannot both pass validation, because each one does its validation
  // and rollover against the same freshly read store inside one lock hold.
  return mutateSessionStore((store) => {
    const index = store.sessions.findIndex((session) => session.sessionId === sessionId);
    const validation = checkNonce(index === -1 ? null : store.sessions[index], nonce);
    if (!validation.ok) {
      throw new Error(validation.reason);
    }
    const updated: ConduitSession = {
      ...validation.session,
      currentNonce: createNonce(),
      usedNonces: [...validation.session.usedNonces, nonce],
      lastActionAt: new Date().toISOString()
    };
    store.sessions[index] = updated;
    return updated;
  });
}

/** Every read-modify-write of sessions.json runs under the store lock, so concurrent writers in other processes or async callers cannot lose each other's updates. */
async function mutateSessionStore<T>(mutate: (store: { sessions: ConduitSession[] }) => T | Promise<T>): Promise<T> {
  return withFileLock(getSessionStorePath(), async () => {
    const store = await readSessionStore();
    const result = await mutate(store);
    await writeSessionStore(store);
    return result;
  });
}

async function updateSession(
  sessionId: string,
  updater: (session: ConduitSession) => ConduitSession
): Promise<ConduitSession> {
  return mutateSessionStore((store) => {
    const index = store.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index === -1) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const updated = updater(store.sessions[index]);
    store.sessions[index] = updated;
    return updated;
  });
}

async function readSessionStore(): Promise<{ sessions: ConduitSession[] }> {
  const filePath = getSessionStorePath();
  try {
    const raw = await readFile(filePath, 'utf8');
    return SessionStoreFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isNotFoundError(error)) {
      return { sessions: [] };
    }
    throw error;
  }
}

async function writeSessionStore(store: { sessions: ConduitSession[] }): Promise<void> {
  await writeFileAtomic(getSessionStorePath(), `${JSON.stringify(store, null, 2)}\n`);
}

function getSessionStorePath(): string {
  return path.join(getStateRoot(), 'sessions.json');
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}
