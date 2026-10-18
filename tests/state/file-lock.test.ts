import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../../src/state/atomic-write.js';
import { FileLockTimeoutError, withFileLock } from '../../src/state/file-lock.js';

describe('withFileLock', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-file-lock-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('serializes concurrent read-modify-write so no update is lost', async () => {
    const target = path.join(tempRoot, 'counter.txt');
    await writeFile(target, '0');

    await Promise.all(Array.from({ length: 30 }, () => withFileLock(target, async () => {
      const n = Number(await readFile(target, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 1));
      await writeFileAtomic(target, String(n + 1));
    })));

    await expect(readFile(target, 'utf8')).resolves.toBe('30');
    expect(await readdir(tempRoot)).toEqual(['counter.txt']);
  });

  it('recovers a lock left by a dead process', async () => {
    const target = path.join(tempRoot, 'target.json');
    // spawnSync has already waited for the child to exit, so its pid is dead.
    const { pid: deadPid } = spawnSync(process.execPath, ['-e', '']);
    await writeFile(
      `${target}.lock`,
      `${JSON.stringify({ pid: deadPid, token: 'deadbeefdeadbeef', acquiredAt: '2000-01-01T00:00:00.000Z' })}\n`
    );

    await expect(withFileLock(target, async () => 'ran')).resolves.toBe('ran');
    const leftovers = (await readdir(tempRoot)).filter((name) => (
      name.endsWith('.lock') || name.endsWith('.stale') || name.endsWith('.tmp')
    ));
    expect(leftovers).toEqual([]);
  });

  it('lets concurrent acquirers recover one stale lock without overlapping', async () => {
    const target = path.join(tempRoot, 'counter.txt');
    const { pid: deadPid } = spawnSync(process.execPath, ['-e', '']);
    await writeFile(
      `${target}.lock`,
      `${JSON.stringify({ pid: deadPid, token: 'deadbeefdeadbeef', acquiredAt: '2000-01-01T00:00:00.000Z' })}\n`
    );
    await writeFile(target, '0');

    await Promise.all(Array.from({ length: 20 }, () => withFileLock(target, async () => {
      const n = Number(await readFile(target, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 1));
      await writeFileAtomic(target, String(n + 1));
    })));

    await expect(readFile(target, 'utf8')).resolves.toBe('20');
    // The guard and every temp file must be gone: only the target remains.
    expect(await readdir(tempRoot)).toEqual(['counter.txt']);
  });

  it('clears a recovery guard left by a dead recoverer', async () => {
    const target = path.join(tempRoot, 'target.json');
    const { pid: deadPid } = spawnSync(process.execPath, ['-e', '']);
    await writeFile(
      `${target}.lock`,
      `${JSON.stringify({ pid: deadPid, token: 'deadbeefdeadbeef', acquiredAt: '2000-01-01T00:00:00.000Z' })}\n`
    );
    await writeFile(
      `${target}.lock.recover`,
      `${JSON.stringify({ pid: deadPid, token: 'deadguarddeadgua', acquiredAt: '2000-01-01T00:00:00.000Z' })}\n`
    );

    await expect(withFileLock(target, async () => 'ran')).resolves.toBe('ran');
    const leftovers = (await readdir(tempRoot)).filter((name) => (
      name.endsWith('.lock') || name.endsWith('.recover')
    ));
    expect(leftovers).toEqual([]);
  });

  it('never removes a live lock while recovering', async () => {
    const target = path.join(tempRoot, 'target.json');
    const foreignLock = `${JSON.stringify({
      pid: process.pid,
      token: 'livelivelivelive',
      acquiredAt: new Date().toISOString()
    })}\n`;
    await writeFile(`${target}.lock`, foreignLock);
    const { pid: deadPid } = spawnSync(process.execPath, ['-e', '']);
    await writeFile(
      `${target}.lock.recover`,
      `${JSON.stringify({ pid: deadPid, token: 'deadguarddeadgua', acquiredAt: '2000-01-01T00:00:00.000Z' })}\n`
    );

    let calls = 0;
    await expect(withFileLock(target, async () => {
      calls += 1;
      return 'ran';
    }, { hungHolderWaitMs: 200 })).rejects.toThrow(FileLockTimeoutError);
    expect(calls).toBe(0);
    await expect(readFile(`${target}.lock`, 'utf8')).resolves.toBe(foreignLock);
  });

  it('waits for a live holder and times out with a clear error', async () => {
    const target = path.join(tempRoot, 'target.json');
    const foreignLock = `${JSON.stringify({
      pid: process.pid,
      token: 'livelivelivelive',
      acquiredAt: new Date().toISOString()
    })}\n`;
    await writeFile(`${target}.lock`, foreignLock);

    let calls = 0;
    let caught: unknown;
    try {
      await withFileLock(target, async () => {
        calls += 1;
        return 'ran';
      }, { hungHolderWaitMs: 200 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FileLockTimeoutError);
    expect((caught as Error).message).toContain(`${target}.lock`);
    expect((caught as Error).message).toContain(`live process ${process.pid}`);
    expect(calls).toBe(0);
    // We must never delete a live lock we cannot acquire.
    await expect(readFile(`${target}.lock`, 'utf8')).resolves.toBe(foreignLock);
  });

  it('does not release a lock it no longer owns', async () => {
    const target = path.join(tempRoot, 'target.json');
    await withFileLock(target, async () => {
      await writeFile(
        `${target}.lock`,
        `${JSON.stringify({ pid: process.pid, token: 'othertokenother1', acquiredAt: new Date().toISOString() })}\n`
      );
      return 'done';
    });

    await expect(readFile(`${target}.lock`, 'utf8')).resolves.toContain('othertokenother1');
  });

  it('releases the lock when fn throws', async () => {
    const target = path.join(tempRoot, 'target.json');
    await expect(withFileLock(target, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect((await readdir(tempRoot)).filter((name) => name.endsWith('.lock'))).toEqual([]);

    await expect(withFileLock(target, async () => 'again')).resolves.toBe('again');
  });
});
