import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  createApprovalRequest,
  getApprovalRequest,
  listApprovalRequests,
  resolveApprovalRequest,
  type ApprovalRecord
} from '../../src/approvals/approval-store.js';
import { executeRequestFromText } from '../../src/daemon/execute-request.js';
import { executeActions } from '../../src/runtime/execute-actions.js';
import { createSession } from '../../src/sessions/session-store.js';

describe('approval expiry and decidedBy (S2)', () => {
  let tempRoot: string;
  let projectRoot: string;
  let stateRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-approval-expiry-'));
    projectRoot = path.join(tempRoot, 'project');
    stateRoot = path.join(tempRoot, 'state');
    process.env.CONDUIT_STATE_DIR = stateRoot;
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'README.md'), 'hello expiry\n', 'utf8');
  });

  afterEach(async () => {
    delete process.env.CONDUIT_STATE_DIR;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('gives untrusted-request reviews the default expiry', async () => {
    const before = Date.now();
    const output = await executeRequestFromText({
      text: ['```conduit', JSON.stringify({
        schema: 'conduit.request.v1',
        source: { kind: 'clipboard', trust: 'untrusted' },
        permissions: [],
        actions: [{ id: 'read', tool: 'file.read', args: { path: 'README.md' } }]
      }), '```'].join('\n')
    });
    expect(output.status).toBe('requires_review');
    const review = await getApprovalRequest(output.approvalId!);
    expect(review?.action.tool).toBe('conduit.review');
    expect(review?.status).toBe('pending');
    const expiresAt = Date.parse(review!.expiresAt!);
    expect(expiresAt - before).toBeGreaterThanOrEqual(DEFAULT_APPROVAL_TIMEOUT_MS - 1000);
    expect(expiresAt - before).toBeLessThanOrEqual(DEFAULT_APPROVAL_TIMEOUT_MS + 5000);
  });

  it('expires a stale review to deny on read, and an expired review cannot be approved', async () => {
    const review = await createApprovalRequest(reviewRequest(projectRoot), { timeoutMs: 1 });
    await sleep(10);

    const listed = await listApprovalRequests();
    expect(listed[0]).toMatchObject({
      approvalId: review.approvalId,
      status: 'expired',
      decidedBy: 'timeout'
    });

    const approved = await resolveApprovalRequest(review.approvalId, 'approved', 'too late', 'cli');
    expect(approved.status).toBe('expired');
    expect(approved.decidedBy).toBe('timeout');
  });

  it('expires on the decision path even when nothing listed it first', async () => {
    const review = await createApprovalRequest(reviewRequest(projectRoot), { timeoutMs: 1 });
    await sleep(10);
    const approved = await resolveApprovalRequest(review.approvalId, 'approved', 'too late', 'cli');
    expect(approved).toMatchObject({ status: 'expired', decidedBy: 'timeout' });
  });

  it('expires legacy pending reviews that predate expiresAt using createdAt + default timeout', async () => {
    const review = await createApprovalRequest(reviewRequest(projectRoot));
    const filePath = path.join(stateRoot, 'approvals', `${review.approvalId}.json`);
    const legacy = JSON.parse(await readFile(filePath, 'utf8')) as ApprovalRecord;
    delete legacy.expiresAt;
    legacy.createdAt = new Date(Date.now() - DEFAULT_APPROVAL_TIMEOUT_MS - 1000).toISOString();
    await writeFile(filePath, JSON.stringify(legacy), 'utf8');

    await expect(getApprovalRequest(review.approvalId)).resolves.toMatchObject({
      status: 'expired',
      decidedBy: 'timeout'
    });
  });

  it('keeps a fresh review pending and decidable', async () => {
    const review = await createApprovalRequest(reviewRequest(projectRoot));
    await expect(getApprovalRequest(review.approvalId)).resolves.toMatchObject({ status: 'pending' });
    await expect(resolveApprovalRequest(review.approvalId, 'denied', 'no', 'cli')).resolves.toMatchObject({
      status: 'denied',
      decidedBy: 'cli'
    });
  });

  it('refuses approval ids that are not approval ids', async () => {
    await mkdir(stateRoot, { recursive: true });
    await writeFile(path.join(stateRoot, 'sessions.json'), '{"sessions":[]}', 'utf8');
    await expect(getApprovalRequest('../sessions')).resolves.toBeNull();
    await expect(resolveApprovalRequest('../sessions', 'approved')).rejects.toThrow(/Unknown approval request/);
  });

  it('records decidedBy for policy decisions and confirmations', async () => {
    const session = await createSession({
      label: 'Edit',
      permissionProfile: 'edit-with-confirmation',
      allowedRoots: [projectRoot],
      transport: 'clipboard'
    });
    const runDir = path.join(tempRoot, 'run');
    await mkdir(runDir, { recursive: true });

    await executeActions({
      actions: [
        { id: 'read', tool: 'file.read', args: { path: 'README.md' } },
        { id: 'write', tool: 'file.write', args: { path: 'notes.txt', content: 'hi\n', mode: 'create' } },
        { id: 'env', tool: 'file.read', args: { path: '.env' } }
      ],
      projectRoot,
      runId: 'run_decided_by',
      runDir,
      turn: 1,
      policySession: session,
      confirm: async () => ({ approved: true, decidedBy: 'cli', approvalId: 'approval_test' })
    });

    const lines = (await readFile(path.join(runDir, 'policy-decisions.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    const byAction = (id: string) => lines.filter((line) => line.actionId === id);
    expect(byAction('read')).toEqual([expect.objectContaining({ decision: 'allow', decidedBy: 'policy' })]);
    expect(byAction('write').at(-1)).toMatchObject({ decision: 'allow', decidedBy: 'cli', approvalId: 'approval_test' });
    expect(byAction('env')).toEqual([expect.objectContaining({ decision: 'deny', decidedBy: 'policy' })]);
    // Every final decision names who made it; the ask itself is not a decision.
    for (const line of lines.filter((entry) => entry.decision !== 'requires_confirmation')) {
      expect(line.decidedBy, JSON.stringify(line)).toBeTruthy();
    }
  });
});

function reviewRequest(projectRoot: string) {
  return {
    action: {
      id: 'review_untrusted_request',
      tool: 'conduit.review',
      args: { actions: [{ id: 'read', tool: 'file.read', args: { path: 'README.md' } }] },
      reason: 'Review untrusted Conduit request before execution.',
      risk: 'high' as const
    },
    policyReason: 'Request is not attached to a trusted session.',
    prompt: 'Review?',
    projectRoot
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
