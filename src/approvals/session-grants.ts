import path from 'node:path';
import type { ToolAction } from '../protocol/schemas.js';
import { getSession, type ConduitSession } from '../sessions/session-store.js';

/**
 * "Allow for this chat": a remembered approval (menu-bar-first spec §2.3).
 *
 * Jon, 2026-10-18: a remembered approval lasts for that one chat only. A chat
 * is a Conduit session, so a grant is keyed by the existing `sessionId`; there
 * is no other identity. The scope rules, and how each is enforced:
 *
 * - **Never another session.** Grants are looked up by the asking session's id
 *   only. A new chat gets a new session id and is asked again.
 * - **Never after a revoke or expiry.** Every lookup re-reads the session from
 *   the session store. If it is gone, revoked or expired, all of its grants are
 *   dropped and nothing matches. (A paused session keeps them, like its nonce;
 *   nothing runs for it while paused anyway.)
 * - **Never after a restart.** Grants live only in the memory of the process
 *   that asked (the extension listener, clipboard daemon or Control). Nothing is
 *   written to disk, so a restarted Conduit asks again.
 *
 * A grant only turns a `requires_confirmation` into an allow for an exact
 * match. It never touches `deny` or `requires_review`: policy runs first, and
 * the grant is consulted only when policy already said "ask".
 *
 * Exact matches only: `shell.run` by the exact command string, `file.write` by
 * the exact path (resolved against the project root). `file.patch` declares no
 * single path, so it is never rememberable; nor is anything else.
 */
export const REMEMBER_FOR_THIS_CHAT = 'session' as const;
export type RememberScope = typeof REMEMBER_FOR_THIS_CHAT;

export interface SessionGrant {
  sessionId: string;
  key: string;
  tool: string;
  approvalId?: string;
  createdAt: string;
}

const grants = new Map<string, Map<string, SessionGrant>>();

/** Whether an approval for this action can be remembered for its chat. */
export function isRememberableAction(action: Pick<ToolAction, 'tool' | 'args'> | undefined): boolean {
  return rememberKey(action, '/') !== null;
}

/** The exact-match key for an action, or null when it is not rememberable. */
export function rememberKey(action: Pick<ToolAction, 'tool' | 'args'> | undefined, projectRoot: string): string | null {
  if (!action || typeof action.args !== 'object' || action.args === null) return null;
  if (action.tool === 'shell.run') {
    const command = action.args.command;
    return typeof command === 'string' && command.length > 0 ? `shell.run\u0000${command}` : null;
  }
  if (action.tool === 'file.write') {
    const target = action.args.path;
    return typeof target === 'string' && target.length > 0
      ? `file.write\u0000${path.resolve(projectRoot, target)}`
      : null;
  }
  return null;
}

/** Live means the session can still run work later: active or paused, not expired. */
function isLiveSession(session: ConduitSession | null): session is ConduitSession {
  if (!session) return false;
  if (session.state !== 'active' && session.state !== 'paused') return false;
  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) return false;
  return true;
}

/**
 * Remembers an approved action for its chat. Returns null (and remembers
 * nothing) when the session is not a live stored session (for example the
 * ephemeral agent-loop session) or the action is not rememberable.
 */
export async function addSessionGrant(input: {
  sessionId: string | undefined;
  action: ToolAction;
  projectRoot: string;
  approvalId?: string;
}): Promise<SessionGrant | null> {
  if (!input.sessionId) return null;
  const key = rememberKey(input.action, input.projectRoot);
  if (!key) return null;
  if (!isLiveSession(await getSession(input.sessionId))) {
    grants.delete(input.sessionId);
    return null;
  }
  const grant: SessionGrant = {
    sessionId: input.sessionId,
    key,
    tool: input.action.tool,
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    createdAt: new Date().toISOString()
  };
  const forSession = grants.get(input.sessionId) ?? new Map<string, SessionGrant>();
  forSession.set(key, grant);
  grants.set(input.sessionId, forSession);
  return grant;
}

/** The grant covering this action in this chat, if any. Re-checks the session every time. */
export async function findSessionGrant(input: {
  sessionId: string | undefined;
  action: ToolAction;
  projectRoot: string;
}): Promise<SessionGrant | null> {
  if (!input.sessionId) return null;
  const forSession = grants.get(input.sessionId);
  if (!forSession || forSession.size === 0) return null;
  if (!isLiveSession(await getSession(input.sessionId))) {
    grants.delete(input.sessionId);
    return null;
  }
  const key = rememberKey(input.action, input.projectRoot);
  return key ? forSession.get(key) ?? null : null;
}

/** Forgets every grant in this process (tests, and a full stop). */
export function clearAllSessionGrants(): void {
  grants.clear();
}
