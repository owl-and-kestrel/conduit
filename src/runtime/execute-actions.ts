import readline from 'node:readline';
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  createApprovalRequest,
  resolveApprovalRequest,
  waitForApprovalDecision,
  type ApprovalRecord,
  type ConfirmationRequest
} from '../approvals/approval-store.js';
import type { PolicyDecision } from '../policy/policy-engine.js';
import { evaluateActionPolicy } from '../policy/policy-engine.js';
import type { ToolAction, ToolResult } from '../protocol/schemas.js';
import type { ConduitSession } from '../sessions/session-store.js';
import { appendJsonl } from '../state/logs.js';
import { checkExecutionGate } from '../state/pause-state.js';
import { getTool } from '../tools/registry.js';
import { executeToolAction } from '../tools/types.js';

export interface ExecuteActionsInput {
  actions: ToolAction[];
  projectRoot: string;
  runId: string;
  runDir: string;
  turn: number;
  yes?: boolean;
  policySession?: ConduitSession;
  confirm?: (request: ConfirmationRequest) => Promise<boolean>;
}

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
      timestamp: new Date().toISOString()
    });

    const policyResult = await handlePolicyDecision(action, policyDecision, {
      yes: input.yes,
      confirm,
      runId: input.runId,
      runDir: input.runDir,
      projectRoot: input.projectRoot,
      sessionId: policySession.sessionId
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
    confirm: (request: ConfirmationRequest) => Promise<boolean>;
    runId: string;
    runDir: string;
    projectRoot: string;
    sessionId?: string;
  }
): Promise<ToolResult | null> {
  if (decision.decision === 'allow') {
    return null;
  }

  if (decision.decision === 'requires_confirmation') {
    if (input.yes) {
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
    const confirmed = await input.confirm({
      action,
      policyReason: decision.reason,
      prompt,
      runId: input.runId,
      runDir: input.runDir,
      projectRoot: input.projectRoot,
      sessionId: input.sessionId
    });
    if (confirmed) {
      return null;
    }

    return {
      id: action.id,
      tool: action.tool,
      status: 'denied',
      error: 'User denied this action.'
    };
  }

  return {
    id: action.id,
    tool: action.tool,
    status: decision.decision === 'requires_review' ? 'requires_confirmation' : 'denied',
    error: decision.reason
  };
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

function defaultConfirmation(request: ConfirmationRequest): Promise<boolean> {
  return requestSharedApproval(request);
}

async function requestSharedApproval(request: ConfirmationRequest): Promise<boolean> {
  const record = await createApprovalRequest(request);
  const closeTerminalPrompt = offerTerminalApproval(record, request);
  try {
    const decided = await waitForApprovalDecision(record.approvalId, DEFAULT_APPROVAL_TIMEOUT_MS);
    return decided.status === 'approved';
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
