import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  consumeSessionNonce,
  createSession,
  getSession,
  listSessions,
  pauseSession,
  resumeSession,
  revokeSession,
  validateSessionNonce
} from '../../src/sessions/session-store.js';

describe('session store', () => {
  let tempRoot: string;
  let stateRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-session-store-'));
    stateRoot = path.join(tempRoot, 'state');
    process.env.CONDUIT_STATE_DIR = stateRoot;
  });

  afterEach(async () => {
    delete process.env.CONDUIT_STATE_DIR;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('creates and persists a session', async () => {
    const session = await createSession({
      label: 'ChatGPT',
      permissionProfile: 'read-only',
      allowedRoots: ['fixtures/fake-project'],
      transport: 'clipboard'
    });

    expect(session.sessionId).toMatch(/^sess_/);
    expect(session.currentNonce).toMatch(/^call_/);
    expect(session.state).toBe('active');
    expect(session.allowedRoots[0]).toBe(path.resolve('fixtures/fake-project'));

    await expect(readFile(path.join(stateRoot, 'sessions.json'), 'utf8')).resolves.toContain(session.sessionId);
    await expect(listSessions()).resolves.toHaveLength(1);
    await expect(getSession(session.sessionId)).resolves.toMatchObject({
      label: 'ChatGPT',
      permissionProfile: 'read-only'
    });
  });

  it('validates and consumes the current nonce exactly once', async () => {
    const session = await createSession({
      label: 'Agent loop',
      permissionProfile: 'read-only',
      allowedRoots: [tempRoot]
    });

    await expect(validateSessionNonce(session.sessionId, session.currentNonce)).resolves.toMatchObject({
      ok: true
    });

    const updated = await consumeSessionNonce(session.sessionId, session.currentNonce);
    expect(updated.currentNonce).not.toBe(session.currentNonce);
    expect(updated.usedNonces).toContain(session.currentNonce);

    await expect(validateSessionNonce(session.sessionId, session.currentNonce)).resolves.toEqual({
      ok: false,
      reason: 'Nonce was already used.'
    });
    await expect(validateSessionNonce(session.sessionId, updated.currentNonce)).resolves.toMatchObject({
      ok: true
    });
  });

  it('rejects unknown sessions and mismatched nonces', async () => {
    const session = await createSession({
      label: 'Agent loop',
      permissionProfile: 'read-only',
      allowedRoots: [tempRoot]
    });

    await expect(validateSessionNonce('sess_missing', session.currentNonce)).resolves.toEqual({
      ok: false,
      reason: 'Unknown session.'
    });
    await expect(validateSessionNonce(session.sessionId, 'call_wrong')).resolves.toEqual({
      ok: false,
      reason: 'Nonce does not match current session nonce.'
    });
  });

  it('rejects revoked and expired sessions', async () => {
    const active = await createSession({
      label: 'Active then revoked',
      permissionProfile: 'read-only',
      allowedRoots: [tempRoot]
    });
    await revokeSession(active.sessionId);

    await expect(validateSessionNonce(active.sessionId, active.currentNonce)).resolves.toEqual({
      ok: false,
      reason: 'Session is revoked.',
      sessionState: 'revoked'
    });

    const expired = await createSession({
      label: 'Expired',
      permissionProfile: 'read-only',
      allowedRoots: [tempRoot],
      expiresAt: '2000-01-01T00:00:00.000Z'
    });

    await expect(validateSessionNonce(expired.sessionId, expired.currentNonce)).resolves.toEqual({
      ok: false,
      reason: 'Session is expired.',
      sessionState: 'expired'
    });
  });

  it('survives concurrent store writers without a shared temp file', async () => {
    const session = await createSession({
      label: 'Concurrent',
      permissionProfile: 'read-only',
      allowedRoots: [tempRoot]
    });

    await expect(Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? pauseSession(session.sessionId) : resumeSession(session.sessionId))))).resolves.toHaveLength(20);

    const stored = JSON.parse(await readFile(path.join(stateRoot, 'sessions.json'), 'utf8'));
    expect(stored.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([session.sessionId]);
    expect((await readdir(stateRoot)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps every concurrent update to different sessions (no lost update)', async () => {
    const sessions: Awaited<ReturnType<typeof createSession>>[] = [];
    for (let i = 0; i < 12; i += 1) {
      sessions.push(await createSession({
        label: `Session ${i}`,
        permissionProfile: 'read-only',
        allowedRoots: [tempRoot]
      }));
    }

    await Promise.all(sessions.map((session) => pauseSession(session.sessionId)));

    const stored = JSON.parse(await readFile(path.join(stateRoot, 'sessions.json'), 'utf8')) as {
      sessions: Array<{ sessionId: string; state: string }>;
    };
    expect(stored.sessions).toHaveLength(12);
    for (const session of sessions) {
      const persisted = stored.sessions.find((s) => s.sessionId === session.sessionId);
      expect(persisted?.state).toBe('paused');
    }
    expect((await readdir(stateRoot)).filter((name) => (
      name.endsWith('.lock') || name.endsWith('.tmp') || name.endsWith('.stale')
    ))).toEqual([]);
  });

  it('keeps concurrent creates', async () => {
    const sessions = await Promise.all(Array.from({ length: 15 }, (_, i) => createSession({
      label: `Concurrent ${i}`,
      permissionProfile: 'read-only',
      allowedRoots: [tempRoot]
    })));

    expect(new Set(sessions.map((session) => session.sessionId)).size).toBe(15);

    const listed = await listSessions();
    expect(listed).toHaveLength(15);
    expect(new Set(listed.map((session) => session.sessionId)).size).toBe(15);
  });

  it('consumes a nonce at most once under concurrency', async () => {
    const session = await createSession({
      label: 'Nonce race',
      permissionProfile: 'read-only',
      allowedRoots: [tempRoot]
    });

    const results = await Promise.allSettled(Array.from({ length: 8 }, () => (
      consumeSessionNonce(session.sessionId, session.currentNonce)
    )));

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const result of rejected) {
      expect(['Nonce was already used.', 'Nonce does not match current session nonce.']).toContain(
        (result as PromiseRejectedResult).reason.message
      );
    }

    const stored = await getSession(session.sessionId);
    expect(stored?.usedNonces).toEqual([session.currentNonce]);
  });

  it('keeps updates from two concurrent processes', async () => {
    const sessions: Awaited<ReturnType<typeof createSession>>[] = [];
    for (let i = 0; i < 60; i += 1) {
      sessions.push(await createSession({
        label: `Process ${i}`,
        permissionProfile: 'read-only',
        allowedRoots: [tempRoot]
      }));
    }
    const ids = sessions.map((session) => session.sessionId);
    const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pause-many.ts');
    const goFile = path.join(tempRoot, 'go');
    const readyFiles = [path.join(tempRoot, 'ready-0'), path.join(tempRoot, 'ready-1')];
    const startChild = (index: number, childIds: string[]) => spawn(
      process.execPath,
      ['--import', 'tsx', fixturePath, ...childIds],
      {
        env: {
          ...process.env,
          CONDUIT_STATE_DIR: stateRoot,
          CONDUIT_TEST_READY_FILE: readyFiles[index],
          CONDUIT_TEST_GO_FILE: goFile
        },
        stdio: 'inherit'
      }
    );

    const children = [startChild(0, ids.slice(0, 30)), startChild(1, ids.slice(30))];
    const exits = children.map((child) => new Promise<number>((resolve, reject) => {
      child.on('exit', (code) => resolve(code ?? -1));
      child.on('error', reject);
    }));
    // Open the start barrier only once both children are up, so their
    // read-modify-writes overlap instead of running one process after the other.
    const readyDeadline = Date.now() + 20_000;
    while (!readyFiles.every((file) => existsSync(file)) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await writeFile(goFile, 'go');
    expect(await Promise.all(exits)).toEqual([0, 0]);

    const stored = JSON.parse(await readFile(path.join(stateRoot, 'sessions.json'), 'utf8')) as {
      sessions: Array<{ sessionId: string; state: string }>;
    };
    expect(stored.sessions).toHaveLength(60);
    expect(stored.sessions.filter((s) => s.state !== 'paused').map((s) => s.sessionId)).toEqual([]);
  }, 30_000);

  it('recovers a stale sessions.json lock from a dead process', async () => {
    const session = await createSession({
      label: 'Stale lock',
      permissionProfile: 'read-only',
      allowedRoots: [tempRoot]
    });
    // spawnSync has already waited for the child to exit, so its pid is dead.
    const { pid: deadPid } = spawnSync(process.execPath, ['-e', '']);
    await writeFile(
      path.join(stateRoot, 'sessions.json.lock'),
      `${JSON.stringify({ pid: deadPid, token: 'deadbeefdeadbeef', acquiredAt: '2000-01-01T00:00:00.000Z' })}\n`
    );

    const paused = await pauseSession(session.sessionId);
    expect(paused.state).toBe('paused');

    expect((await readdir(stateRoot)).filter((name) => name.endsWith('.lock'))).toEqual([]);
  });
});
