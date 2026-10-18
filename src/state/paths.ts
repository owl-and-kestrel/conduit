import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function getStateRoot(): string {
  return process.env.CONDUIT_STATE_DIR ?? path.join(os.homedir(), '.conduit');
}

export function getRunsRoot(): string {
  return path.join(getStateRoot(), 'runs');
}

// Run ids and run-file names become path segments everywhere (control panel
// API, run directories), so a caller-supplied id like `..%2F..%2Fsecret` must
// never be able to leave the runs root. Restrict segments to a plain filename
// charset and refuse anything that could traverse up or out.
const SAFE_RUN_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeRunId(runId: unknown): runId is string {
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > 128) return false;
  return SAFE_RUN_SEGMENT.test(runId) && !runId.includes('..');
}

export class RunPathError extends Error {}

/**
 * The real path of `fileName` inside run `runId`, for reading, or null when it
 * cannot be resolved (missing, unreadable, a symlink loop): null means read
 * nothing. Throws RunPathError when either segment is unsafe or when the real
 * path, after following every symlink, is not inside the real runs root.
 * Every reader that turns a run id into a file goes through here. Residual:
 * a symlink swapped in between this check and the read needs write access to
 * the state dir, which already controls everything Conduit does.
 */
export async function resolveRunFile(runId: string, fileName: string): Promise<string | null> {
  if (!isSafeRunId(runId) || !isSafeRunId(fileName)) {
    throw new RunPathError(`Unsafe run path segment: ${JSON.stringify(runId)} / ${JSON.stringify(fileName)}`);
  }
  const runsRoot = getRunsRoot();
  let realRoot: string;
  try {
    realRoot = await realpath(runsRoot);
  } catch {
    return null;
  }
  let realFile: string;
  try {
    realFile = await realpath(path.join(runsRoot, runId, fileName));
  } catch {
    return null;
  }
  const rel = path.relative(realRoot, realFile);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    // A symlink (or other indirection) resolved outside the runs root.
    throw new RunPathError(`Run path escapes the runs root: ${runId}/${fileName}`);
  }
  return realFile;
}

export function getRunDir(runId: string): string {
  if (!isSafeRunId(runId)) {
    throw new RunPathError(`Unsafe run id: ${JSON.stringify(runId)}`);
  }
  return path.join(getRunsRoot(), runId);
}
