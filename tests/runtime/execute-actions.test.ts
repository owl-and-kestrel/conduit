import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPROVAL_EXPIRED_ERROR, executeActions } from '../../src/runtime/execute-actions.js';
import { createSession } from '../../src/sessions/session-store.js';
import type { ConfirmationRequest } from '../../src/approvals/approval-store.js';
import { createApprovalRequest, getApprovalRequest, waitForApprovalDecision } from '../../src/approvals/approval-store.js';

describe('executeActions', () => {
  let tempRoot: string;
  let projectRoot: string;
  let runDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-execute-actions-'));
    projectRoot = path.join(tempRoot, 'project');
    runDir = path.join(tempRoot, 'run');
    process.env.CONDUIT_STATE_DIR = path.join(tempRoot, 'state');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.CONDUIT_STATE_DIR;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('executes confirmation-required actions when the app approval callback approves', async () => {
    const session = await createSession({
      label: 'Edit session',
      permissionProfile: 'edit-with-confirmation',
      allowedRoots: [projectRoot],
      transport: 'clipboard'
    });
    let approval: ConfirmationRequest | null = null;

    const results = await executeActions({
      actions: [
        {
          id: 'write_notes',
          tool: 'file.write',
          args: { path: 'notes.txt', content: 'hello approval\n', mode: 'create' },
          reason: 'Persist notes.',
          risk: 'high'
        }
      ],
      projectRoot,
      runId: 'run_test',
      runDir,
      turn: 1,
      policySession: session,
      confirm: async (request) => {
        approval = request;
        return true;
      }
    });

    expect(approval).toMatchObject({
      action: {
        tool: 'file.write'
      },
      policyReason: 'Tool requires confirmation: file.write',
      sessionId: session.sessionId
    });
    expect(results[0]).toMatchObject({ status: 'ok', tool: 'file.write' });
    await expect(readFile(path.join(projectRoot, 'notes.txt'), 'utf8')).resolves.toBe('hello approval\n');
  });

  it('denies confirmation-required actions when the approval callback denies', async () => {
    const session = await createSession({
      label: 'Edit session',
      permissionProfile: 'edit-with-confirmation',
      allowedRoots: [projectRoot],
      transport: 'clipboard'
    });

    const results = await executeActions({
      actions: [
        {
          id: 'write_notes',
          tool: 'file.write',
          args: { path: 'notes.txt', content: 'hello approval\n', mode: 'create' },
          reason: 'Persist notes.',
          risk: 'high'
        }
      ],
      projectRoot,
      runId: 'run_test',
      runDir,
      turn: 1,
      policySession: session,
      confirm: async () => false
    });

    expect(results[0]).toMatchObject({
      status: 'denied',
      error: 'User denied this action.'
    });
    await expect(readFile(path.join(projectRoot, 'notes.txt'), 'utf8')).rejects.toThrow();
  });

  it('keeps the user-denied message when a person denies through the object outcome', async () => {
    const session = await createSession({
      label: 'Edit session',
      permissionProfile: 'edit-with-confirmation',
      allowedRoots: [projectRoot],
      transport: 'clipboard'
    });

    const results = await executeActions({
      actions: [
        {
          id: 'write_notes',
          tool: 'file.write',
          args: { path: 'notes.txt', content: 'hello approval\n', mode: 'create' },
          reason: 'Persist notes.',
          risk: 'high'
        }
      ],
      projectRoot,
      runId: 'run_test',
      runDir,
      turn: 1,
      policySession: session,
      confirm: async () => ({ approved: false, decidedBy: 'menubar', approvalId: 'approval_test_denied' })
    });

    expect(results[0]).toMatchObject({ status: 'denied', error: 'User denied this action.' });
    await expect(readFile(path.join(projectRoot, 'notes.txt'), 'utf8')).rejects.toThrow();
  });

  it('tells the agent an expired ask ran nothing instead of saying the user denied it', async () => {
    const session = await createSession({
      label: 'Edit session',
      permissionProfile: 'edit-with-confirmation',
      allowedRoots: [projectRoot],
      transport: 'clipboard'
    });

    const results = await executeActions({
      actions: [
        {
          id: 'write_notes',
          tool: 'file.write',
          args: { path: 'notes.txt', content: 'hello approval\n', mode: 'create' },
          reason: 'Persist notes.',
          risk: 'high'
        }
      ],
      projectRoot,
      runId: 'run_test',
      runDir,
      turn: 1,
      policySession: session,
      confirm: async () => ({ approved: false, decidedBy: 'timeout', approvalId: 'approval_test_expired' })
    });

    expect(results[0]).toMatchObject({ id: 'write_notes', tool: 'file.write', status: 'denied', error: APPROVAL_EXPIRED_ERROR });
    expect(results[0].error).not.toContain('User denied');
    await expect(readFile(path.join(projectRoot, 'notes.txt'), 'utf8')).rejects.toThrow();
    const decisions = (await readFile(path.join(runDir, 'policy-decisions.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(decisions.at(-1)).toMatchObject({
      actionId: 'write_notes',
      decision: 'deny',
      decidedBy: 'timeout',
      approvalId: 'approval_test_expired'
    });
  });

  it('reports a real approval-store expiry to the agent as expired, nothing ran', async () => {
    const session = await createSession({
      label: 'Edit session',
      permissionProfile: 'edit-with-confirmation',
      allowedRoots: [projectRoot],
      transport: 'clipboard'
    });
    let approvalId = '';

    const results = await executeActions({
      actions: [
        {
          id: 'write_notes',
          tool: 'file.write',
          args: { path: 'notes.txt', content: 'hello approval\n', mode: 'create' },
          reason: 'Persist notes.',
          risk: 'high'
        }
      ],
      projectRoot,
      runId: 'run_test',
      runDir,
      turn: 1,
      policySession: session,
      // Same shape as the default shared-approval path, with a 50 ms timeout and no decider.
      confirm: async (request) => {
        const record = await createApprovalRequest(request, { timeoutMs: 50 });
        approvalId = record.approvalId;
        const decided = await waitForApprovalDecision(record.approvalId, 50);
        return {
          approved: decided.status === 'approved',
          approvalId: decided.approvalId,
          ...(decided.decidedBy ? { decidedBy: decided.decidedBy } : {})
        };
      }
    });

    expect(results[0]).toMatchObject({ status: 'denied', error: APPROVAL_EXPIRED_ERROR });
    await expect(getApprovalRequest(approvalId)).resolves.toMatchObject({ status: 'expired', decidedBy: 'timeout' });
    await expect(readFile(path.join(projectRoot, 'notes.txt'), 'utf8')).rejects.toThrow();
  });
});
