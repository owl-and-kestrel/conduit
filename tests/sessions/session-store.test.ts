import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  consumeSessionNonce,
  createSession,
  getSession,
  listSessions,
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
});
