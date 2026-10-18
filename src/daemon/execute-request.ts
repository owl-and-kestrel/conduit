import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createApprovalRequest, type ApprovalRecord, type ConfirmationRequest } from '../approvals/approval-store.js';
import { parseClipboardEnvelope } from '../protocol/parse-clipboard-envelope.js';
import { renderConduitRepair, renderConduitResults, type ConduitRepairEnvelope } from '../protocol/render-results.js';
import { classifyRepairCode, createRepairEnvelope } from '../protocol/repair.js';
import { ActionRequestBlockSchema, type ActionRequestBlock, type ToolResult } from '../protocol/schemas.js';
import type { ConduitSession } from '../sessions/session-store.js';
import { consumeSessionNonce, validateSessionNonce } from '../sessions/session-store.js';
import { getRunDir } from '../state/paths.js';
import { checkExecutionGate } from '../state/pause-state.js';
import { ensureRunDir, writeTextFile } from '../state/logs.js';
import { createRunId } from '../util/ids.js';
import { executeActions } from '../runtime/execute-actions.js';

export type ExecuteRequestStatus = 'executed' | 'ignored' | 'rejected' | 'requires_review';

export interface ExecuteRequestInput {
  text: string;
  yes?: boolean;
  confirm?: (request: ConfirmationRequest) => Promise<boolean>;
}

export interface ExecuteRequestOutput {
  status: ExecuteRequestStatus;
  runId?: string;
  runDir?: string;
  sessionId?: string;
  nextNonce?: string;
  approvalId?: string;
  results?: ToolResult[];
  rendered?: string;
  reason?: string;
  repair?: ConduitRepairEnvelope;
}

export async function executeRequestFromText(input: ExecuteRequestInput): Promise<ExecuteRequestOutput> {
  const parseResult = parseClipboardEnvelope(input.text);
  if (!parseResult.ok) {
    if (parseResult.kind === 'none') {
      return { status: 'ignored', reason: 'No Conduit request found.' };
    }
    const repair = createRepairEnvelope({
      reason: parseResult.error ?? `Request parse failed: ${parseResult.kind}.`,
      code: parseResult.kind === 'multiple' ? 'multiple_envelopes' : classifyRepairCode(parseResult.error),
    });
    return {
      status: 'rejected',
      reason: repair.reason,
      repair,
      rendered: renderConduitRepair(repair)
    };
  }

  return executeConduitRequest(parseResult.block, {
    yes: input.yes,
    confirm: input.confirm
  });
}

export async function executeRequestFromUnknown(
  payload: unknown,
  options: Pick<ExecuteRequestInput, 'yes' | 'confirm'> = {}
): Promise<ExecuteRequestOutput> {
  try {
    const request = ActionRequestBlockSchema.parse(payload);
    return executeConduitRequest(request, options);
  } catch (error) {
    const repair = createRepairEnvelope({
      reason: error instanceof Error ? error.message : String(error),
      code: 'malformed_json'
    });
    return {
      status: 'rejected',
      reason: repair.reason,
      repair,
      rendered: renderConduitRepair(repair)
    };
  }
}

export async function executeConduitRequest(
  request: ActionRequestBlock,
  options: Pick<ExecuteRequestInput, 'yes' | 'confirm'> = {}
): Promise<ExecuteRequestOutput> {
  // Pause gate first: while paused nothing runs, no review or ask is created,
  // and no nonce is consumed (the same envelope is valid again after resume).
  const gate = await checkExecutionGate();
  if (!gate.ok) {
    return pausedOutput(request, gate.reason);
  }

  if (!request.sessionId || !request.nonce) {
    const review = await createUntrustedRequestReview(request, 'Request is not attached to a trusted session.');
    return {
      status: 'requires_review',
      approvalId: review.approvalId,
      reason: 'Request is not attached to a trusted session. Local review is required before execution.',
      rendered: renderReviewRequired(review.approvalId, request)
    };
  }

  const validation = await validateSessionNonce(request.sessionId, request.nonce);
  if (!validation.ok && validation.reason === 'Unknown session.') {
    const review = await createUntrustedRequestReview(request, validation.reason);
    return {
      status: 'requires_review',
      sessionId: request.sessionId,
      approvalId: review.approvalId,
      reason: 'Request references an unknown session. Local review is required before execution.',
      rendered: renderReviewRequired(review.approvalId, request)
    };
  }

  if (!validation.ok && validation.sessionState === 'paused') {
    return pausedOutput(request, `Session ${request.sessionId} is paused. Nothing runs for it until it is resumed.`);
  }

  if (!validation.ok) {
    const repair = createRepairEnvelope({
      reason: validation.reason,
      code: 'invalid_session',
      request,
      sessionId: request.sessionId
    });
    return {
      status: 'rejected',
      sessionId: request.sessionId,
      reason: repair.reason,
      repair,
      rendered: renderConduitRepair(repair)
    };
  }

  const session = validation.session;
  const projectRoot = await resolveProjectRoot(session.allowedRoots);
  const runId = createRunId();
  const runDir = getRunDir(runId);

  await ensureRunDir(runDir);
  await writeTextFile(runDir, 'request.json', `${JSON.stringify(request, null, 2)}\n`);
  await writeTextFile(runDir, 'metadata.json', `${JSON.stringify({
    runId,
    sessionId: session.sessionId,
    projectRoot,
    mode: 'request',
    startedAt: new Date().toISOString()
  }, null, 2)}\n`);

  const consumedSession = await consumeSessionNonce(request.sessionId, request.nonce);
  const results = await executeActions({
    actions: request.actions,
    projectRoot,
    runId,
    runDir,
    turn: 1,
    yes: options.yes,
    confirm: options.confirm,
    policySession: consumedSession
  });
  const status = summarizeResults(results);
  const rendered = renderConduitResults({
    type: 'conduit.results.v1',
    runId,
    sessionId: consumedSession.sessionId,
    nextNonce: consumedSession.currentNonce,
    results,
    status
  });
  await writeTextFile(runDir, 'result.txt', rendered);

  return {
    status: 'executed',
    runId,
    runDir,
    sessionId: consumedSession.sessionId,
    nextNonce: consumedSession.currentNonce,
    results,
    rendered
  };
}

export async function executeApprovedReview(
  approval: ApprovalRecord,
  options: Pick<ExecuteRequestInput, 'yes' | 'confirm'> = {}
): Promise<ExecuteRequestOutput> {
  if (approval.status !== 'approved') {
    return {
      status: 'rejected',
      approvalId: approval.approvalId,
      reason: `Approval is ${approval.status}, not approved.`
    };
  }
  if (approval.action.tool !== 'conduit.review') {
    return {
      status: 'ignored',
      approvalId: approval.approvalId,
      reason: 'Approval is not an untrusted Conduit request review.'
    };
  }

  const gate = await checkExecutionGate();
  if (!gate.ok) {
    return {
      ...pausedOutput({}, gate.reason),
      approvalId: approval.approvalId
    };
  }

  const args = approval.action.args as Record<string, unknown>;
  const actions = Array.isArray(args.actions) ? args.actions as ActionRequestBlock['actions'] : [];
  if (actions.length === 0) {
    return {
      status: 'rejected',
      approvalId: approval.approvalId,
      reason: 'Reviewed request did not include executable actions.'
    };
  }

  const projectRoot = await resolveProjectRoot([approval.projectRoot ?? process.cwd()]);
  const runId = createRunId();
  const runDir = getRunDir(runId);
  const policySession = createApprovedReviewPolicySession(projectRoot, approval.approvalId);

  await ensureRunDir(runDir);
  await writeTextFile(runDir, 'request.json', `${JSON.stringify({
    type: 'approved-untrusted-review',
    approvalId: approval.approvalId,
    source: args.source ?? null,
    permissions: args.permissions ?? [],
    requestedCapabilities: args.requestedCapabilities ?? [],
    actions
  }, null, 2)}\n`);
  await writeTextFile(runDir, 'metadata.json', `${JSON.stringify({
    runId,
    approvalId: approval.approvalId,
    projectRoot,
    mode: 'approved-review',
    startedAt: new Date().toISOString()
  }, null, 2)}\n`);

  const results = await executeActions({
    actions,
    projectRoot,
    runId,
    runDir,
    turn: 1,
    yes: options.yes,
    confirm: options.confirm,
    policySession
  });
  const status = summarizeResults(results);
  const rendered = renderConduitResults({
    type: 'conduit.results.v1',
    runId,
    sessionId: policySession.sessionId,
    results,
    status
  });
  await writeTextFile(runDir, 'result.txt', rendered);

  return {
    status: 'executed',
    approvalId: approval.approvalId,
    runId,
    runDir,
    sessionId: policySession.sessionId,
    results,
    rendered
  };
}

function pausedOutput(request: Partial<ActionRequestBlock>, reason: string): ExecuteRequestOutput {
  const repair = createRepairEnvelope({
    reason,
    code: 'paused',
    request,
    ...(request.sessionId ? { sessionId: request.sessionId } : {})
  });
  return {
    status: 'rejected',
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    reason: repair.reason,
    repair,
    rendered: renderConduitRepair(repair)
  };
}

async function createUntrustedRequestReview(request: ActionRequestBlock, policyReason: string) {
  const projectRoot = await resolveProjectRoot([process.cwd()]);
  return createApprovalRequest({
    action: {
      id: 'review_untrusted_request',
      tool: 'conduit.review',
      args: {
        source: request.source ?? null,
        title: request.title ?? null,
        description: request.description ?? null,
        permissions: request.permissions ?? [],
        requestedCapabilities: request.requestedCapabilities ?? [],
        actions: request.actions,
        sessionId: request.sessionId ?? null,
        noncePresent: Boolean(request.nonce)
      },
      reason: request.description ?? request.title ?? 'Review untrusted Conduit request before execution.',
      risk: 'high'
    },
    policyReason,
    projectRoot,
    prompt: [
      '[Conduit] Review untrusted request before execution.',
      '',
      `Source: ${JSON.stringify(request.source ?? null)}`,
      `Permissions: ${JSON.stringify(request.permissions ?? [])}`,
      `Actions: ${request.actions.map((action) => `${action.id}:${action.tool}`).join(', ') || '(none)'}`,
      '',
      'Approve only if you trust the source and intended local effects.'
    ].join('\n')
  });
}

function createApprovedReviewPolicySession(projectRoot: string, approvalId: string): ConduitSession {
  return {
    sessionId: `sess_approved_${approvalId}`,
    label: 'Approved untrusted request',
    createdAt: new Date().toISOString(),
    state: 'active',
    transport: 'clipboard',
    permissionProfile: 'read-only',
    allowedRoots: [projectRoot],
    currentNonce: `approved_${approvalId}`,
    usedNonces: []
  };
}

function renderReviewRequired(approvalId: string, request: ActionRequestBlock): string {
  return [
    'Conduit review required.',
    '',
    'This exact Conduit envelope is not attached to a trusted live session, so it was not executed.',
    'Open Conduit Control -> Approvals to inspect the requested source, permissions, actions, and reasons.',
    '',
    `Approval ID: ${approvalId}`,
    `Actions: ${request.actions.map((action) => `${action.id}:${action.tool}`).join(', ') || '(none)'}`,
    '',
    'Approving this review does not broaden future permissions. It is a one-request consent decision.'
  ].join('\n');
}


async function resolveProjectRoot(allowedRoots: string[]): Promise<string> {
  const firstRoot = allowedRoots[0];
  if (!firstRoot) {
    throw new Error('Session has no allowed roots.');
  }
  return realpath(path.resolve(firstRoot));
}

function summarizeResults(results: ToolResult[]): 'ok' | 'partial' | 'denied' | 'error' {
  if (results.every((result) => result.status === 'ok')) {
    return 'ok';
  }
  if (results.every((result) => result.status === 'denied' || result.status === 'requires_confirmation')) {
    return 'denied';
  }
  if (results.some((result) => result.status === 'error')) {
    return 'error';
  }
  return 'partial';
}
