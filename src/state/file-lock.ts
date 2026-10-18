import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Advisory lock for read-modify-write of Conduit state files, shared across
 * processes (the Control app server, a `--local` CLI, the listener) and across
 * concurrent async callers inside one process.
 *
 * Acquisition is atomic and never half-written: the lock contents are written
 * to a unique temp file and `link()`ed into place, so a competing acquirer
 * either wins the link (holds the lock) or EEXISTs (someone else does).
 *
 * A lock left behind by a dead process is stale-recovered by judging the
 * owning PID. Recovery first takes a guard lock (`<target>.lock.recover`) so
 * only one recoverer works at a time, then re-verifies the stale token under
 * that guard before deleting: while the guard is held, no other recoverer can
 * delete the lock and no acquirer can replace it (the link fails with EEXIST),
 * so the token we verified is still the one we delete.
 *
 * Readers do not need this lock: `writeFileAtomic` renames whole files, so a
 * reader always sees one complete store even without synchronization.
 */

export interface FileLockOptions {
  /** How long to wait for a live holder before giving up (ms). */
  hungHolderWaitMs?: number;
}

export class FileLockTimeoutError extends Error {}

/**
 * Default value for {@link FileLockOptions.hungHolderWaitMs}.
 *
 * A live but wedged holder -- or a PID reused by an unrelated process -- would
 * otherwise hang every CLI command and every Control request that writes the
 * state store forever. Real holds last milliseconds, so 10 s sits far above
 * any genuine hold and only fires when a holder is actually stuck.
 */
export const HUNG_HOLDER_WAIT_MS = 10_000;

interface LockFileContents {
  pid: number;
  token: string;
  acquiredAt: unknown;
}

/**
 * What the lock file looked like when we inspected it: a parsed live/stale
 * candidate, `null` when the file is gone (lock just released), or
 * `'cannot-judge'` when the contents are unparseable or lack the required
 * `pid`/`token` fields (treated as a live holder we must not disturb).
 */
type ExistingLock = LockFileContents | 'cannot-judge' | null;

export async function withFileLock<T>(targetPath: string, fn: () => Promise<T>, options?: FileLockOptions): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const hungHolderWaitMs = options?.hungHolderWaitMs ?? HUNG_HOLDER_WAIT_MS;
  const token = randomBytes(8).toString('hex');
  const startedAt = Date.now();

  await mkdir(path.dirname(targetPath), { recursive: true });

  for (;;) {
    if (await tryAcquire(lockPath, token)) {
      break;
    }

    const existing = await readLockFile(lockPath);
    let heldBy: unknown;
    let since: unknown;
    if (existing === null) {
      continue; // The lock vanished between our link and our read: retry now.
    }
    if (existing === 'cannot-judge') {
      heldBy = 'unknown';
      since = 'unknown';
    } else if (!isPidAlive(existing.pid)) {
      // Dead owner. Set these first so the timeout message stays defined even
      // when we lose the guard race below and fall through to the wait
      // instead of spinning.
      heldBy = existing.pid;
      since = existing.acquiredAt;
      if (await recoverStaleLock(lockPath, existing.token)) {
        continue;
      }
    } else {
      heldBy = existing.pid;
      since = existing.acquiredAt;
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > hungHolderWaitMs) {
      throw new FileLockTimeoutError(
        `Timed out after ${elapsedMs} ms waiting for ${lockPath}, held by live process ${heldBy} since ${since}. `
          + 'If that process is hung, stop it; if no Conduit process is running, delete the lock file.'
      );
    }

    // Random 5..25 ms jitter so contending acquirers do not retry in lockstep.
    await new Promise<void>((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
  }

  try {
    return await fn();
  } finally {
    await releaseLock(lockPath, token);
  }
}

/**
 * One acquire attempt: write the lock contents to a unique temp file, link it
 * into place. `link` fails with EEXIST when the lock is already held, which
 * makes the acquisition atomic and the lock file never half-written.
 */
async function tryAcquire(lockPath: string, token: string): Promise<boolean> {
  const tempPath = `${lockPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const contents = `${JSON.stringify({
    pid: process.pid,
    token,
    acquiredAt: new Date().toISOString()
  })}\n`;
  try {
    await writeFile(tempPath, contents, 'utf8');
    await link(tempPath, lockPath);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/** Read and judge a lock file: gone, unjudgable, or a full candidate. */
async function readLockFile(lockPath: string): Promise<ExistingLock> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null; // Lock just released; the next acquire attempt may win.
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'cannot-judge';
  }
  if (
    typeof parsed === 'object'
    && parsed !== null
    && 'pid' in parsed
    && 'token' in parsed
    && typeof parsed.pid === 'number'
    && typeof parsed.token === 'string'
  ) {
    return { pid: parsed.pid, token: parsed.token, acquiredAt: (parsed as { acquiredAt?: unknown }).acquiredAt };
  }
  return 'cannot-judge';
}

/**
 * Recover a lock whose owning PID is dead, returning whether we removed it.
 *
 * A guard lock (`<lockPath>.recover`) makes the removal airtight: while we
 * hold the guard no other recoverer can delete lockPath; the stale owner is
 * dead so it cannot release; and no acquirer can replace lockPath while it
 * exists (link fails with EEXIST). So the token we verified under the guard
 * is still the one we delete. The only residual is a recoverer that dies
 * inside this window while another recoverer races the guard cleanup, which
 * needs a crash during recovery.
 */
async function recoverStaleLock(lockPath: string, staleToken: string): Promise<boolean> {
  const guardPath = `${lockPath}.recover`;
  const guardToken = randomBytes(8).toString('hex');
  if (!(await tryAcquire(guardPath, guardToken))) {
    const existing = await readLockFile(guardPath);
    if (existing !== null && existing !== 'cannot-judge' && !isPidAlive(existing.pid)) {
      // A recoverer died mid-recovery and stranded its guard: clear it.
      // releaseLock only deletes the guard while it still carries that token.
      await releaseLock(guardPath, existing.token);
    }
    return false; // Another recoverer holds the guard: the caller waits and retries.
  }

  try {
    const existing = await readLockFile(lockPath);
    if (
      existing !== null
      && existing !== 'cannot-judge'
      && existing.token === staleToken
      && !isPidAlive(existing.pid)
    ) {
      await rm(lockPath, { force: true });
      return true;
    }
    // The lock was already released or replaced by a live holder: never touch it.
    return false;
  } finally {
    await releaseLock(guardPath, guardToken);
  }
}

/**
 * Release: only delete the lock file while its token is still ours, so we
 * never remove a lock someone else now holds. ENOENT is fine.
 */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // Contents changed; do not delete what we cannot prove is ours.
  }
  if (typeof parsed === 'object' && parsed !== null && 'token' in parsed && parsed.token === token) {
    await rm(lockPath, { force: true });
  }
}

/**
 * Whether a PID could belong to a running process. `process.kill(pid, 0)`
 * does not actually signal; it just checks. Fail safe: return true for any
 * error we cannot interpret, so we never break a lock we cannot judge.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoException(error)) {
      if (error.code === 'EPERM') {
        return true; // The process exists but belongs to someone else.
      }
      if (error.code === 'ESRCH') {
        return false; // No process with that PID.
      }
    }
    return true;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string';
}
