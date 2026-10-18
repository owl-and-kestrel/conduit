import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listApprovalRequests, resolveApprovalRequest } from '../../src/approvals/approval-store.js';
import {
  addSessionGrant,
  clearAllSessionGrants,
  findSessionGrant,
  isRememberableAction
} from '../../src/approvals/session-grants.js';
import type { ToolAction } from '../../src/protocol/schemas.js';
import { executeActions, type ConfirmFn } from '../../src/runtime/execute-actions.js';
import { createSession, pauseSession, resumeSession, revokeSession, type ConduitSession } from '../../src/sessions/session-store.js';

/**
 * "Allow for this chat" (Jon 2026-10-18): a remembered approval is scoped to
 * that one chat (session). It is allowed again in the same session, asked
 * again in a new session, and gone after a revoke or a restart.
 */
describe('Allow for this chat (session-scoped remembered approvals)', () => {
  let tempRoot: string;
  let projectRoot: string;
  let runCount = 0;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-grants-'));
    projectRoot = path.join(tempRoot, 'project');
    process.env.CONDUIT_STATE_DIR = path.join(tempRoot, 'state');
    await mkdir(projectRoot, { recursive: true });
    clearAllSessionGrants();
  });

  afterEach(async () => {
    clearAllSessionGrants();
    delete process.env.CONDUIT_STATE_DIR;
    await rm(tempRoot, { recursive: true, force: true });
  });

  function shell(command: string, id = 'sh'): ToolAction {
    return { id, tool: 'shell.run', args: { command }, reason: 'Run it.' };
  }

  async function chat(profile: ConduitSession['permissionProfile'] = 'shell-manual'): Promise<ConduitSession> {
    return createSession({ label: 'Chat', permissionProfile: profile, allowedRoots: [projectRoot] });
  }

  async function run(session: ConduitSession, actions: ToolAction[], confirm: ConfirmFn) {
    runCount += 1;
    const runDir = path.join(tempRoot, 'runs', `run_${runCount}`);
    await mkdir(runDir, { recursive: true });
    const results = await executeActions({ actions, projectRoot, runId: `run_${runCount}`, runDir, turn: 1, policySession: session, confirm });
    const decisions = (await readFile(path.join(runDir, 'policy-decisions.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    return { results, decisions };
  }

  const rememberOnce: ConfirmFn = async () => ({ approved: true, decidedBy: 'control-app', approvalId: 'approval_first', remember: 'session' });

  it('allows the same exact command again in the same session without asking', async () => {
    const session = await chat();
    const first = await run(session, [shell('echo grant-ok')], rememberOnce);
    expect(first.results[0]).toMatchObject({ status: 'ok' });

    const confirm = vi.fn<ConfirmFn>(async () => false);
    const second = await run(session, [shell('echo grant-ok')], confirm);
    expect(confirm).not.toHaveBeenCalled();
    expect(second.results[0]).toMatchObject({ status: 'ok' });
    expect(second.decisions.at(-1)).toMatchObject({ decision: 'allow', decidedBy: 'grant:approval_first', reason: 'Allowed for this chat.' });

    // Exact match only: a different command in the same chat still asks.
    const other = await run(session, [shell('echo something-else')], confirm);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(other.results[0]).toMatchObject({ status: 'denied', error: 'User denied this action.' });
  });

  it('asks again in a new session', async () => {
    const first = await chat();
    await run(first, [shell('echo grant-ok')], rememberOnce);

    const second = await chat();
    const confirm = vi.fn<ConfirmFn>(async () => false);
    const result = await run(second, [shell('echo grant-ok')], confirm);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.results[0]).toMatchObject({ status: 'denied' });
  });

  it('is cleared when the session is revoked, and kept across a session pause', async () => {
    const session = await chat();
    await run(session, [shell('echo grant-ok')], rememberOnce);
    const lookup = { sessionId: session.sessionId, action: shell('echo grant-ok'), projectRoot };

    await pauseSession(session.sessionId);
    expect(await findSessionGrant(lookup)).not.toBeNull();
    await resumeSession(session.sessionId);
    expect(await findSessionGrant(lookup)).not.toBeNull();

    await revokeSession(session.sessionId);
    expect(await findSessionGrant(lookup)).toBeNull();
    // Dropped, not just hidden: nothing new can be added for a revoked chat.
    expect(await addSessionGrant({ ...lookup, approvalId: 'approval_late' })).toBeNull();
    expect(await findSessionGrant(lookup)).toBeNull();
  });

  it('expires with the session', async () => {
    const session = await createSession({
      label: 'Short chat',
      permissionProfile: 'shell-manual',
      allowedRoots: [projectRoot],
      expiresAt: new Date(Date.now() + 200).toISOString()
    });
    const lookup = { sessionId: session.sessionId, action: shell('echo grant-ok'), projectRoot };
    expect(await addSessionGrant(lookup)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await findSessionGrant(lookup)).toBeNull();
  });

  it('does not survive a restart: grants are in memory only and nothing is written to disk', async () => {
    const session = await chat();
    await run(session, [shell('echo grant-ok')], rememberOnce);
    const lookup = { sessionId: session.sessionId, action: shell('echo grant-ok'), projectRoot };
    expect(await findSessionGrant(lookup)).not.toBeNull();

    // A restarted process loads the module fresh.
    vi.resetModules();
    const fresh = await import('../../src/approvals/session-grants.js');
    expect(await fresh.findSessionGrant(lookup)).toBeNull();

    const stateFiles = await readdir(process.env.CONDUIT_STATE_DIR!, { recursive: true });
    for (const file of stateFiles) {
      const full = path.join(process.env.CONDUIT_STATE_DIR!, String(file));
      const text = await readFile(full, 'utf8').catch(() => '');
      expect(text, String(file)).not.toContain('approval_first');
    }
  });

  it('never lifts a deny: a grant cannot run a tool the profile denies', async () => {
    const session = await chat('edit-with-confirmation');
    expect(await addSessionGrant({ sessionId: session.sessionId, action: shell('echo grant-ok'), projectRoot })).not.toBeNull();
    const confirm = vi.fn<ConfirmFn>(async () => true);
    const result = await run(session, [shell('echo grant-ok')], confirm);
    expect(confirm).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ status: 'denied' });
    expect(result.decisions[0]).toMatchObject({ decision: 'deny', decidedBy: 'policy' });
  });

  it('remembers file writes by exact path only, and never patches', async () => {
    const session = await chat('edit-with-confirmation');
    const write = (target: string, content: string): ToolAction => ({ id: 'w', tool: 'file.write', args: { path: target, content } });
    await run(session, [write('notes.txt', 'one')], async () => ({ approved: true, approvalId: 'approval_w', remember: 'session' }));

    const confirm = vi.fn<ConfirmFn>(async () => false);
    const again = await run(session, [write('./notes.txt', 'two')], confirm);
    expect(confirm).not.toHaveBeenCalled();
    expect(again.results[0]).toMatchObject({ status: 'ok' });
    expect(await readFile(path.join(projectRoot, 'notes.txt'), 'utf8')).toBe('two');

    await run(session, [write('other.txt', 'x')], confirm);
    expect(confirm).toHaveBeenCalledTimes(1);

    expect(isRememberableAction({ tool: 'file.patch', args: { patch: 'diff --git a/x b/x' } })).toBe(false);
    expect(isRememberableAction({ tool: 'conduit.review', args: {} })).toBe(false);
    expect(isRememberableAction({ tool: 'shell.run', args: { command: '' } })).toBe(false);
  });

  it('remembers nothing for an approve-once or for a session that is not stored', async () => {
    const session = await chat();
    await run(session, [shell('echo grant-ok')], async () => ({ approved: true, approvalId: 'approval_once' }));
    expect(await findSessionGrant({ sessionId: session.sessionId, action: shell('echo grant-ok'), projectRoot })).toBeNull();

    // The ephemeral agent-loop session is not a chat: nothing is remembered.
    const ephemeral = { ...session, sessionId: 'sess_ephemeral_agent_loop' };
    await run(ephemeral, [shell('echo grant-ok')], rememberOnce);
    expect(await findSessionGrant({ sessionId: 'sess_ephemeral_agent_loop', action: shell('echo grant-ok'), projectRoot })).toBeNull();
  });

  it('turns a shared approval recorded with remember into a grant for that session', async () => {
    const session = await chat();
    // No confirm callback: the real shared-approval path (approval record + wait).
    runCount += 1;
    const runDir = path.join(tempRoot, 'runs', `run_${runCount}`);
    await mkdir(runDir, { recursive: true });
    const pending = executeActions({ actions: [shell('echo grant-ok')], projectRoot, runId: `run_${runCount}`, runDir, turn: 1, policySession: session });
    let approvalId: string | undefined;
    for (let attempt = 0; attempt < 100 && !approvalId; attempt += 1) {
      approvalId = (await listApprovalRequests()).find((record) => record.status === 'pending')?.approvalId;
      if (!approvalId) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(approvalId).toBeDefined();
    await resolveApprovalRequest(approvalId!, 'approved', 'Allowed for this chat.', 'cli', { remember: 'session' });
    expect((await pending)[0]).toMatchObject({ status: 'ok' });

    const grant = await findSessionGrant({ sessionId: session.sessionId, action: shell('echo grant-ok'), projectRoot });
    expect(grant).toMatchObject({ sessionId: session.sessionId, approvalId });
  });
});
