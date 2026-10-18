import readline from 'node:readline';
import {
  APPROVAL_TIMEOUT_DECIDER,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  createApprovalRequest,
  resolveApprovalRequest,
  waitForApprovalDecision,
  type ApprovalRecord,
  type ConfirmationRequest
} from '../approvals/approval-store.js';
import { addSessionGrant, findSessionGrant } from '../approvals/session-grants.js';
import type { PolicyDecision } from '../policy/policy-engine.js';
import { evaluateActionPolicy } from '../policy/policy-engine.js';
import type { ToolAction, ToolResult } from '../protocol/schemas.js';
import type { ConduitSession } from '../sessions/session-store.js';
import { appendJsonl } from '../state/logs.js';
import { checkExecutionGate } from '../state/pause-state.js';
import { getTool } from '../tools/registry.js';
import { executeToolAction } from '../tools/types.js';

/** Told to the agent when an ask expired: nobody refused it, and nothing ran. */
export const APPROVAL_EXPIRED_ERROR =
  'The approval request expired before anyone approved it, so nothing ran. Resend the request to ask again.';

export interface ExecuteActionsInput {
  actions: ToolAction[];
  projectRoot: string;
  runId: string;
  runDir: string;
  turn: number;
  yes?: boolean;
  policySession?: ConduitSession;
  confirm?: ConfirmFn;
}

/**
 * Outcome of an ask. A plain boolean is accepted from simple callers; the
 * object form lets the shared approval path report who decided (`decidedBy`)
 * so every decision in `policy-decisions.jsonl` carries one.
 */
export type ConfirmationOutcome = boolean | {
  approved: boolean;
  decidedBy?: string;
  approvalId?: string;
  /** The person chose "Allow for this chat": remember it for this session only. */
  remember?: 'session';
};
export type ConfirmFn = (request: ConfirmationRequest) => Promise<ConfirmationOutcome>;

export async function executeActions(input: ExecuteActionsInput): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  const policySession = input.policySession ?? createEphemeralPolicySession(input.projectRoot);
  const confirm = input.confirm ?? defaultConfirmation;

  for (const action of input.actions) {
    await appendJsonl(input.runDir, 'actions.jsonl', {
      turn: input.turn,
      ...action,
      timestamp: new Date().toISOString()
    });

    // Pause gate before policy: a paused runtime creates no ask. This also
    // covers --yes and trusted auto-runs, which never reach a confirmation.
    const pausedBeforePolicy = await pausedResult(action, input, policySession.sessionId);
    if (pausedBeforePolicy) {
      results.push(pausedBeforePolicy);
      continue;
    }

    const policyDecision = await evaluateActionPolicy({
      action,
      session: policySession
    });
    await appendJsonl(input.runDir, 'policy-decisions.jsonl', {
      turn: input.turn,
      actionId: action.id,
      tool: action.tool,
      ...policyDecision,
      ...(policyDecision.decision === 'requires_confirmation' ? {} : { decidedBy: 'policy' }),
      timestamp: new Date().toISOString()
    });

    const policyResult = await handlePolicyDecision(action, policyDecision, {
      yes: input.yes,
      confirm,
      runId: input.runId,
      runDir: input.runDir,
      projectRoot: input.projectRoot,
      sessionId: policySession.sessionId,
      turn: input.turn
    });
    if (policyResult) {
      results.push(policyResult);
      continue;
    }

    // Gate again immediately before the tool runs: a pause (or session pause or
    // revoke) that landed while an ask was pending still wins over the approval.
    const pausedBeforeTool = await pausedResult(action, input, policySession.sessionId);
    if (pausedBeforeTool) {
      results.push(pausedBeforeTool);
      continue;
    }

    const tool = getTool(action.tool);
    if (!tool) {
      results.push({
        id: action.id,
        tool: action.tool,
        status: 'denied',
        error: `Unknown tool: ${action.tool}`
      });
      continue;
    }

    results.push(await executeToolAction(action, tool, {
      projectRoot: input.projectRoot,
      runId: input.runId,
      runDir: input.runDir
    }));
  }

  for (const result of results) {
    await appendJsonl(input.runDir, 'tool-results.jsonl', result);
  }

  return results;
}

async function pausedResult(
  action: ToolAction,
  input: Pick<ExecuteActionsInput, 'runDir' | 'turn'>,
  sessionId: string
): Promise<ToolResult | null> {
  const gate = await checkExecutionGate(sessionId);
  if (gate.ok) return null;
  await appendJsonl(input.runDir, 'policy-decisions.jsonl', {
    turn: input.turn,
    actionId: action.id,
    tool: action.tool,
    decision: 'deny',
    reason: gate.reason,
    decidedBy: gate.scope === 'global' ? 'pause' : 'session-pause',
    timestamp: new Date().toISOString()
  });
  return {
    id: action.id,
    tool: action.tool,
    status: 'denied',
    error: gate.reason
  };
}

async function handlePolicyDecision(
  action: ToolAction,
  decision: PolicyDecision,
  input: {
    yes?: boolean;
    confirm: ConfirmFn;
    runId: string;
    runDir: string;
    projectRoot: string;
    sessionId?: string;
    turn: number;
  }
): Promise<ToolResult | null> {
  if (decision.decision === 'allow') {
    return null;
  }

  if (decision.decision === 'requires_confirmation') {
    if (input.yes) {
      await logConfirmation(input, action, { approved: true, decidedBy: 'yes-flag' });
      return null;
    }

    // "Allow for this chat": an earlier approval in this same session covers
    // exactly this action. Policy already said "ask", so this never lifts a deny.
    const grant = await findSessionGrant({ sessionId: input.sessionId, action, projectRoot: input.projectRoot });
    if (grant) {
      await logConfirmation(input, action, {
        approved: true,
        decidedBy: `grant:${grant.approvalId ?? 'session'}`,
        reason: 'Allowed for this chat.'
      });
      return null;
    }

    const prompt = [
      '',
      `[Conduit] The assistant requests to run ${action.tool}.`,
      `Reason: ${action.reason ?? '(none provided)'}`,
      `Policy: ${decision.reason}`,
      `Args: ${JSON.stringify(action.args)}`,
      'Allow this action? (y/N): '
    ].join('\n');
    const outcome = normalizeOutcome(await input.confirm({
      action,
      policyReason: decision.reason,
      prompt,
      runId: input.runId,
      runDir: input.runDir,
      projectRoot: input.projectRoot,
      sessionId: input.sessionId
    }));
    await logConfirmation(input, action, outcome);
    if (outcome.approved) {
      if (outcome.remember === 'session') {
        // Remembered only for this session, in this process's memory.
        await addSessionGrant({
          sessionId: input.sessionId,
          action,
          projectRoot: input.projectRoot,
          approvalId: outcome.approvalId
        });
      }
      return null;
    }

    // An expired ask was never refused by a person. Say so, so the agent knows
    // nothing ran and can resend. The status stays 'denied' (fail closed).
    return {
      id: action.id,
      tool: action.tool,
      status: 'denied',
      error: outcome.decidedBy === APPROVAL_TIMEOUT_DECIDER
        ? APPROVAL_EXPIRED_ERROR
        : 'User denied this action.'
    };
  }

  return {
    id: action.id,
    tool: action.tool,
    status: decision.decision === 'requires_review' ? 'requires_confirmation' : 'denied',
    error: decision.reason
  };
}

type NormalizedOutcome = Exclude<ConfirmationOutcome, boolean>;

function normalizeOutcome(outcome: ConfirmationOutcome): NormalizedOutcome {
  return typeof outcome === 'boolean' ? { approved: outcome } : outcome;
}

async function logConfirmation(
  input: { runDir: string; turn: number },
  action: ToolAction,
  outcome: NormalizedOutcome & { reason?: string }
): Promise<void> {
  await appendJsonl(input.runDir, 'policy-decisions.jsonl', {
    turn: input.turn,
    actionId: action.id,
    tool: action.tool,
    decision: outcome.approved ? 'allow' : 'deny',
    reason: outcome.reason ?? (outcome.approved ? 'Confirmed.' : 'Not confirmed.'),
    decidedBy: outcome.decidedBy ?? 'confirm-callback',
    ...(outcome.approvalId ? { approvalId: outcome.approvalId } : {}),
    timestamp: new Date().toISOString()
  });
}

function createEphemeralPolicySession(projectRoot: string): ConduitSession {
  return {
    sessionId: 'sess_ephemeral_agent_loop',
    label: 'Ephemeral agent loop',
    createdAt: new Date().toISOString(),
    state: 'active',
    transport: 'api',
    permissionProfile: 'shell-manual',
    allowedRoots: [projectRoot],
    currentNonce: 'call_ephemeral_agent_loop',
    usedNonces: []
  };
}

function defaultConfirmation(request: ConfirmationRequest): Promise<ConfirmationOutcome> {
  return requestSharedApproval(request);
}

async function requestSharedApproval(request: ConfirmationRequest): Promise<ConfirmationOutcome> {
  const record = await createApprovalRequest(request, { timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS });
  const closeTerminalPrompt = offerTerminalApproval(record, request);
  try {
    const decided = await waitForApprovalDecision(record.approvalId, DEFAULT_APPROVAL_TIMEOUT_MS);
    return {
      approved: decided.status === 'approved',
      approvalId: decided.approvalId,
      ...(decided.decidedBy ? { decidedBy: decided.decidedBy } : {}),
      ...(decided.status === 'approved' && decided.remember === 'session' ? { remember: 'session' as const } : {})
    };
  } finally {
    closeTerminalPrompt?.();
  }
}

function offerTerminalApproval(record: ApprovalRecord, request: ConfirmationRequest): (() => void) | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }

  let closed = false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const close = () => {
    if (closed) return;
    closed = true;
    rl.close();
  };

  const prompt = [
    request.prompt.trimEnd(),
    '',
    `Approval ID: ${record.approvalId}`,
    'You can also approve or deny this action in Conduit Control.',
    'Allow from terminal? (y/N): '
  ].join('\n');

  rl.question(prompt, (answer) => {
    if (closed) return;
    closed = true;
    const approved = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
    void resolveApprovalRequest(
      record.approvalId,
      approved ? 'approved' : 'denied',
      approved ? 'Approved from terminal.' : 'Denied from terminal.',
      'terminal'
    );
    rl.close();
  });

  return close;
}
