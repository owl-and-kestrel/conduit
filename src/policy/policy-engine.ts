import type { ToolAction } from '../protocol/schemas.js';
import type { ConduitSession } from '../sessions/session-store.js';
import { PROFILES, type PermissionProfileName } from '../sessions/profiles.js';
import { getTool } from '../tools/registry.js';
import { DEFAULT_POLICY_BUDGETS, type PolicyBudgets } from './budgets.js';
import { resolveInsideAnyRoot } from './sandbox.js';
import { isSensitivePath } from './sensitive-paths.js';
import { isDemoProfileEnabled } from '../runtime/demo-profile.js';

export type PolicyDecision =
  | { decision: 'allow' }
  | { decision: 'requires_review'; reason: string }
  | { decision: 'requires_confirmation'; reason: string }
  | { decision: 'deny'; reason: string };

export interface EvaluateActionPolicyInput {
  action: ToolAction;
  session?: ConduitSession;
  mode?: 'trusted-session' | 'untrusted' | 'idiot';
  globalProfile?: PermissionProfileName;
}

export interface EvaluateRequestPolicyInput {
  actions: ToolAction[];
  session?: ConduitSession;
  mode?: 'trusted-session' | 'untrusted' | 'idiot';
  globalProfile?: PermissionProfileName;
  budgets?: PolicyBudgets;
}

export async function evaluateRequestPolicy(input: EvaluateRequestPolicyInput): Promise<PolicyDecision> {
  const budgets = input.budgets ?? DEFAULT_POLICY_BUDGETS;
  if (input.actions.length > budgets.maxActions) {
    return { decision: 'deny', reason: `Too many actions: ${input.actions.length} > ${budgets.maxActions}.` };
  }

  let strongest: PolicyDecision = { decision: 'allow' };
  for (const action of input.actions) {
    const decision = await evaluateActionPolicy({
      action,
      session: input.session,
      mode: input.mode,
      globalProfile: input.globalProfile
    });
    if (decision.decision === 'deny') {
      return decision;
    }
    if (decision.decision === 'requires_review') {
      strongest = decision;
    } else if (decision.decision === 'requires_confirmation' && strongest.decision === 'allow') {
      strongest = decision;
    }
  }

  return strongest;
}

export async function evaluateActionPolicy(input: EvaluateActionPolicyInput): Promise<PolicyDecision> {
  const mode = input.mode ?? (input.session ? 'trusted-session' : 'untrusted');
  if (mode === 'untrusted') {
    return { decision: 'requires_review', reason: 'Request is not attached to a trusted session.' };
  }

  const profileName = input.session?.permissionProfile ?? input.globalProfile ?? 'read-only';
  // Fail closed: 'demo-review' only ever comes from an approved review, but if
  // the demo switch is not on right now (a process can be started with it, the
  // env can change, or a stale record thinks it is on), deny.
  if (profileName === 'demo-review' && !isDemoProfileEnabled()) {
    return { decision: 'deny', reason: 'The demo profile is off (CONDUIT_DEMO_PROFILE is not 1).' };
  }
  const profile = PROFILES[profileName];
  const tool = getTool(input.action.tool);
  if (!tool) {
    return { decision: 'deny', reason: `Unknown tool: ${input.action.tool}` };
  }

  if (profile.deny.includes(input.action.tool)) {
    return { decision: 'deny', reason: `Tool denied by ${profile.name} profile: ${input.action.tool}` };
  }

  if (!profile.autoAllow.includes(input.action.tool) && !profile.requireConfirmation.includes(input.action.tool)) {
    return { decision: 'deny', reason: `Tool is not in ${profile.name} profile: ${input.action.tool}` };
  }

  const pathDecision = await evaluatePathPolicy(input.action, input.session);
  if (pathDecision.decision !== 'allow') {
    return pathDecision;
  }

  if (profile.requireConfirmation.includes(input.action.tool)) {
    return { decision: 'requires_confirmation', reason: `Tool requires confirmation: ${input.action.tool}` };
  }

  return { decision: 'allow' };
}

async function evaluatePathPolicy(action: ToolAction, session?: ConduitSession): Promise<PolicyDecision> {
  const requestedPath = getActionPath(action);
  if (requestedPath === null) {
    return { decision: 'allow' };
  }

  if (!session) {
    return { decision: 'requires_review', reason: 'Path-scoped action has no trusted session.' };
  }

  // The same containment check the file tools enforce at execution
  // (resolveInsideProject), so this advice cannot disagree with the sandbox:
  // symlinks are resolved through the deepest existing ancestor, and .git,
  // dangling symlinks and symlink loops are refused. Any refusal is a deny.
  let realRequestedPath: string;
  try {
    realRequestedPath = await resolveInsideAnyRoot(requestedPath, session.allowedRoots);
  } catch {
    return { decision: 'deny', reason: `Path is outside allowed roots: ${requestedPath}` };
  }

  if (action.tool === 'file.read' && isSensitivePath(realRequestedPath)) {
    return { decision: 'deny', reason: `Sensitive file read denied: ${requestedPath}` };
  }

  return { decision: 'allow' };
}

function getActionPath(action: ToolAction): string | null {
  if (typeof action.args.path === 'string') {
    return action.args.path;
  }
  return null;
}
