import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApprovalRequest, getApprovalRequest, listApprovalRequests, resolveApprovalRequest } from '../../src/approvals/approval-store.js';
import { executeApprovedReview, executeRequestFromText } from '../../src/daemon/execute-request.js';
import { executeActions } from '../../src/runtime/execute-actions.js';
import { processListenTurn } from '../../src/runtime/listen-loop.js';
import {
  createSession,
  getSession,
  pauseSession,
  resumeSession,
  revokeAllLiveSessions,
  revokeSession
} from '../../src/sessions/session-store.js';
import {
  checkExecutionGate,
  clearGlobalPause,
  getPauseState,
  getPauseStatePath,
  setGlobalPause
} from '../../src/state/pause-state.js';
import { FakeTransport } from '../../src/transports/fake-transport.js';

describe('pause / kill switch (S1)', () => {
  let tempRoot: string;
  let projectRoot: string;
  let stateRoot: string;
  let runDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-pause-'));
    projectRoot = path.join(tempRoot, 'project');
    stateRoot = path.join(tempRoot, 'state');
    runDir = path.join(tempRoot, 'run');
    process.env.CONDUIT_STATE_DIR = stateRoot;
    await mkdir(projectRoot, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(projectRoot, 'README.md'), 'hello pause\n', 'utf8');
  });

  afterEach(async () => {
    delete process.env.CONDUIT_STATE_DIR;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('is not paused by default and persists the flag in the state root across reads', async () => {
    await expect(getPauseState()).resolves.toEqual({ paused: false });
    await setGlobalPause({ by: 'cli', reason: 'lunch' });
    // A restarted process reads the same file; there is no in-memory copy.
    const onDisk = JSON.parse(await readFile(getPauseStatePath(), 'utf8'));
    expect(onDisk).toMatchObject({ paused: true, pausedBy: 'cli', reason: 'lunch' });
    await expect(getPauseState()).resolves.toMatchObject({ paused: true, reason: 'lunch' });
    await clearGlobalPause({ by: 'cli' });
    await expect(getPauseState()).resolves.toMatchObject({ paused: false });
  });

  it('fails closed when the pause state file is unreadable', async () => {
    await mkdir(stateRoot, { recursive: true });
    await writeFile(getPauseStatePath(), '{not json', 'utf8');
    const gate = await checkExecutionGate();
    expect(gate).toMatchObject({ ok: false, scope: 'global' });
    expect(gate.ok ? '' : gate.reason).toContain('fail closed');
  });

  it('survives concurrent pause/resume writers without a shared temp file', async () => {
    await expect(Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? setGlobalPause({ by: 'cli' }) : clearGlobalPause({ by: 'cli' }))))).resolves.toHaveLength(20);
    const state = await getPauseState();
    expect(state.unreadable).toBeUndefined();
    expect((await readdir(stateRoot)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('denies (fail closed) instead of throwing when the session store is unreadable', async () => {
    await mkdir(stateRoot, { recursive: true });
    await writeFile(path.join(stateRoot, 'sessions.json'), '{not json', 'utf8');
    const gate = await checkExecutionGate('sess_unreadable');
    expect(gate).toMatchObject({ ok: false, scope: 'session' });
    expect(gate.ok ? '' : gate.reason).toContain('fail closed');
  });

  it('blocks a trusted request while paused: no tool runs, no ask, nonce kept, paused repair returned', async () => {
    const session = await createSession({
      label: 'Trusted',
      permissionProfile: 'read-only',
      allowedRoots: [projectRoot],
      transport: 'clipboard'
    });
    await setGlobalPause({ by: 'cli' });

    const output = await executeRequestFromText({ text: trustedRequest(session.sessionId, session.currentNonce) });

    expect(output.status).toBe('rejected');
    expect(output.repair?.code).toBe('paused');
    expect(output.rendered).toContain('"code": "paused"');
    expect(output.runId).toBeUndefined();
    expect(output.results).toBeUndefined();
    await expect(readdir(path.join(stateRoot, 'runs'))).rejects.toThrow();
    await expect(listApprovalRequests()).resolves.toEqual([]);
    expect((await getSession(session.sessionId))?.usedNonces).toEqual([]);

    // Resume: the very same envelope now runs.
    await clearGlobalPause({ by: 'cli' });
    const resumed = await executeRequestFromText({ text: trustedRequest(session.sessionId, session.currentNonce) });
    expect(resumed.status).toBe('executed');
    expect(resumed.rendered).toContain('hello pause');
  });

  it('creates no review for an untrusted request while paused', async () => {
    await setGlobalPause({ by: 'cli' });
    const output = await executeRequestFromText({
      text: conduitBlock({
        schema: 'conduit.request.v1',
        source: { kind: 'clipboard', trust: 'untrusted' },
        permissions: [],
        actions: [{ id: 'read', tool: 'file.read', args: { path: 'README.md' } }]
      })
    });
    expect(output.status).toBe('rejected');
    expect(output.repair?.code).toBe('paused');
    await expect(listApprovalRequests()).resolves.toEqual([]);
  });

  it('blocks trusted auto-runs and --yes while paused, without asking', async () => {
    const session = await createSession({
      label: 'Edit',
      permissionProfile: 'edit-with-confirmation',
      allowedRoots: [projectRoot],
      transport: 'clipboard'
    });
    await setGlobalPause({ by: 'menubar' });
    let asked = 0;

    const results = await executeActions({
      actions: [
        { id: 'read', tool: 'file.read', args: { path: 'README.md' } },
        { id: 'write', tool: 'file.write', args: { path: 'notes.txt', content: 'nope\n', mode: 'create' } }
      ],
      projectRoot,
      runId: 'run_paused',
      runDir,
      turn: 1,
      yes: true,
      policySession: session,
      confirm: async () => {
        asked += 1;
        return true;
      }
    });

    expect(results.map((result) => result.status)).toEqual(['denied', 'denied']);
    expect(results[0].error).toContain('paused');
    expect(asked).toBe(0);
    await expect(readFile(path.join(projectRoot, 'notes.txt'), 'utf8')).rejects.toThrow();
    const decisions = await readFile(path.join(runDir, 'policy-decisions.jsonl'), 'utf8');
    expect(decisions).toContain('"decidedBy":"pause"');
    expect(decisions).not.toContain('"decision":"allow"');
  });

  it('a pause that lands while an ask is pending wins over the approval', async () => {
    const session = await createSession({
      label: 'Edit',
      permissionProfile: 'edit-with-confirmation',
      allowedRoots: [projectRoot],
      transport: 'clipboard'
    });

    const results = await executeActions({
      actions: [
        { id: 'write', tool: 'file.write', args: { path: 'notes.txt', content: 'late\n', mode: 'create' } },
        { id: 'read', tool: 'file.read', args: { path: 'README.md' } }
      ],
      projectRoot,
      runId: 'run_pause_mid_ask',
      runDir,
      turn: 1,
      policySession: session,
      confirm: async () => {
        await setGlobalPause({ by: 'cli' });
        return true;
      }
    });

    expect(results.map((result) => result.status)).toEqual(['denied', 'denied']);
    await expect(readFile(path.join(projectRoot, 'notes.txt'), 'utf8')).rejects.toThrow();
  });

  it('pauses and resumes a single session without affecting others', async () => {
    const paused = await createSession({
      label: 'Paused chat',
      permissionProfile: 'read-only',
      allowedRoots: [projectRoot],
      transport: 'clipboard'
    });
    const other = await createSession({
      label: 'Other chat',
      permissionProfile: 'read-only',
      allowedRoots: [projectRoot],
      transport: 'clipboard'
    });
    await pauseSession(paused.sessionId);
    await expect(pauseSession(paused.sessionId)).resolves.toMatchObject({ state: 'paused' });

    const blocked = await executeRequestFromText({ text: trustedRequest(paused.sessionId, paused.currentNonce) });
    expect(blocked.status).toBe('rejected');
    expect(blocked.repair?.code).toBe('paused');
    expect((await getSession(paused.sessionId))?.usedNonces).toEqual([]);

    const unaffected = await executeRequestFromText({ text: trustedRequest(other.sessionId, other.currentNonce) });
    expect(unaffected.status).toBe('executed');

    // executeActions also refuses work for a stored session that is paused.
    const direct = await executeActions({
      actions: [{ id: 'read', tool: 'file.read', args: { path: 'README.md' } }],
      projectRoot,
      runId: 'run_session_paused',
      runDir,
      turn: 1,
      policySession: paused
    });
    expect(direct[0]).toMatchObject({ status: 'denied' });
    expect(direct[0].error).toContain('is paused');

    await resumeSession(paused.sessionId);
    const resumed = await executeRequestFromText({ text: trustedRequest(paused.sessionId, paused.currentNonce) });
    expect(resumed.status).toBe('executed');
  });

  it('never resumes a revoked session and cannot pause one', async () => {
    const session = await createSession({
      label: 'Revoked',
      permissionProfile: 'read-only',
      allowedRoots: [projectRoot]
    });
    await revokeSession(session.sessionId);
    await expect(resumeSession(session.sessionId)).rejects.toThrow(/Cannot resume a revoked session/);
    await expect(pauseSession(session.sessionId)).rejects.toThrow(/Cannot pause a revoked session/);
  });

  it('stop-all revokes live sessions, which also halts the rest of an in-flight batch', async () => {
    const session = await createSession({
      label: 'Edit',
      permissionProfile: 'edit-with-confirmation',
      allowedRoots: [projectRoot],
      transport: 'clipboard'
    });

    const results = await executeActions({
      actions: [
        { id: 'read', tool: 'file.read', args: { path: 'README.md' } },
        { id: 'write', tool: 'file.write', args: { path: 'notes.txt', content: 'x\n', mode: 'create' } }
      ],
      projectRoot,
      runId: 'run_kill',
      runDir,
      turn: 1,
      policySession: session,
      confirm: async () => {
        await revokeAllLiveSessions();
        return true;
      }
    });

    expect(results[0]).toMatchObject({ status: 'ok' });
    expect(results[1]).toMatchObject({ status: 'denied' });
    expect(results[1].error).toContain('revoked');
    await expect(readFile(path.join(projectRoot, 'notes.txt'), 'utf8')).rejects.toThrow();
  });

  it('does not run an approved untrusted review while paused', async () => {
    const approval = await createApprovalRequest({
      action: {
        id: 'review_untrusted_request',
        tool: 'conduit.review',
        args: { actions: [{ id: 'read', tool: 'file.read', args: { path: 'README.md' } }] },
        reason: 'Review.',
        risk: 'high'
      },
      policyReason: 'Request is not attached to a trusted session.',
      prompt: 'Review?',
      projectRoot
    });
    const approved = await resolveApprovalRequest(approval.approvalId, 'approved', 'test', 'cli');
    await setGlobalPause({ by: 'cli' });

    const execution = await executeApprovedReview(approved, { yes: true });
    expect(execution.status).toBe('rejected');
    expect(execution.repair?.code).toBe('paused');
    expect(execution.runId).toBeUndefined();
    expect((await getApprovalRequest(approval.approvalId))?.status).toBe('approved');
  });

  it('refuses extension listener calls while paused without consuming the nonce', async () => {
    const paired = await createSession({
      label: 'Extension',
      permissionProfile: 'read-only',
      allowedRoots: [projectRoot],
      transport: 'extension'
    });
    await setGlobalPause({ by: 'cli' });
    const transport = new FakeTransport([]);

    const turn = await processListenTurn({
      assistantTurn: { text: trustedRequest(paired.sessionId, paired.currentNonce), timestamp: '2026-10-18T00:00:00.000Z' },
      projectRoot,
      transport,
      session: null,
      yes: true,
      requireTrustedSession: true
    });

    expect(turn.status).toBe('protocol_error');
    expect(transport.sentMessages[0]).toContain('"code": "paused"');
    expect(transport.sentMessages[0]).not.toContain('hello pause');
    expect((await getSession(paired.sessionId))?.usedNonces).toEqual([]);

    // A paused session (global flag clear) is refused the same way.
    await clearGlobalPause({ by: 'cli' });
    await pauseSession(paired.sessionId);
    const sessionPaused = await processListenTurn({
      assistantTurn: { text: trustedRequest(paired.sessionId, paired.currentNonce), timestamp: '2026-10-18T00:00:01.000Z' },
      projectRoot,
      transport,
      session: turn.session,
      requireTrustedSession: true
    });
    expect(sessionPaused.status).toBe('protocol_error');
    expect(transport.sentMessages[1]).toContain('"code": "paused"');
  });
});

function trustedRequest(sessionId: string, nonce: string): string {
  return conduitBlock({
    schema: 'conduit.request.v1',
    source: { kind: 'clipboard', trust: 'untrusted' },
    permissions: [],
    sessionId,
    nonce,
    actions: [{ id: 'read', tool: 'file.read', args: { path: 'README.md' } }]
  });
}

function conduitBlock(value: unknown): string {
  return ['```conduit', JSON.stringify(value), '```'].join('\n');
}
