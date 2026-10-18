import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getSession } from '../sessions/session-store.js';
import { getStateRoot } from './paths.js';

/**
 * Global pause / kill switch (spec: menu-bar-first S1, safety invariant 7).
 *
 * The flag lives in the state root (`control.json`) so it survives restarts and
 * every execution path in every process (control panel, clipboard daemon,
 * extension listener, CLI) sees the same value. The runtime reads it before any
 * tool runs; there is no cached copy.
 *
 * Fail closed: if the file exists but cannot be read or parsed, execution is
 * treated as paused. A corrupt kill switch must never mean "go".
 */
export interface PauseState {
  paused: boolean;
  pausedAt?: string;
  pausedBy?: string;
  reason?: string;
  updatedAt?: string;
  /** Set when the state file was unreadable and the runtime failed closed. */
  unreadable?: boolean;
}

export type ExecutionGate =
  | { ok: true }
  | { ok: false; scope: 'global' | 'session'; reason: string };

export async function getPauseState(): Promise<PauseState> {
  let raw: string;
  try {
    raw = await readFile(getPauseStatePath(), 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) return { paused: false };
    return failClosed(error);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PauseState>;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.paused !== 'boolean') {
      return failClosed(new Error('control.json has no boolean "paused" field'));
    }
    return {
      paused: parsed.paused,
      ...(typeof parsed.pausedAt === 'string' ? { pausedAt: parsed.pausedAt } : {}),
      ...(typeof parsed.pausedBy === 'string' ? { pausedBy: parsed.pausedBy } : {}),
      ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
      ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {})
    };
  } catch (error) {
    return failClosed(error);
  }
}

export async function setGlobalPause(input: { by: string; reason?: string }): Promise<PauseState> {
  const current = await getPauseState();
  const now = new Date().toISOString();
  // Re-pausing keeps the original pausedAt so "Paused since 14:02" stays true.
  const next: PauseState = {
    paused: true,
    pausedAt: current.paused && current.pausedAt && !current.unreadable ? current.pausedAt : now,
    pausedBy: input.by,
    ...(input.reason ? { reason: input.reason } : {}),
    updatedAt: now
  };
  await writePauseState(next);
  return next;
}

export async function clearGlobalPause(input: { by: string }): Promise<PauseState> {
  const next: PauseState = {
    paused: false,
    pausedBy: input.by,
    updatedAt: new Date().toISOString()
  };
  await writePauseState(next);
  return next;
}

/**
 * The single runtime gate. Called before any tool runs (and before any ask is
 * created). Blocks on the global flag, and on the stored state of the session
 * the work runs under when that session is no longer `active` (paused, revoked
 * or expired mid-batch). Ephemeral policy sessions that were never stored (the
 * agent-loop harness, approved one-off reviews) are gated by the global flag.
 */
export async function checkExecutionGate(sessionId?: string): Promise<ExecutionGate> {
  const pause = await getPauseState();
  if (pause.paused) {
    return {
      ok: false,
      scope: 'global',
      reason: pause.unreadable
        ? 'Conduit pause state is unreadable, so execution is paused (fail closed).'
        : `Conduit is paused${pause.reason ? `: ${pause.reason}` : '.'} Nothing runs until it is resumed.`
    };
  }
  if (sessionId) {
    const session = await getSession(sessionId);
    if (session && session.state !== 'active') {
      return {
        ok: false,
        scope: 'session',
        reason: session.state === 'paused'
          ? `Session ${sessionId} is paused. Nothing runs for it until it is resumed.`
          : `Session ${sessionId} is ${session.state}.`
      };
    }
  }
  return { ok: true };
}

async function writePauseState(state: PauseState): Promise<void> {
  const filePath = getPauseStatePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

function failClosed(error: unknown): PauseState {
  return {
    paused: true,
    unreadable: true,
    reason: `pause state unreadable: ${error instanceof Error ? error.message : String(error)}`
  };
}

export function getPauseStatePath(): string {
  return path.join(getStateRoot(), 'control.json');
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}
