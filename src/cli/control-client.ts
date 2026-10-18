import { CONTROL_PANEL_DEFAULT_PORT, isLoopbackHostname } from '../util/loopback-guard.js';

/**
 * CLI client for Conduit Control (spec §3.5, slices S1/S2).
 *
 * Every CLI verb here is exactly one HTTP call to the same endpoint the web
 * panel and the menu-bar app use; authorization stays on the server. The table
 * below is the parity contract and is asserted by tests/cli/control-client.test.ts.
 * Do not add CLI-side logic that the API does not have.
 */
export const CONTROL_CLI_ROUTES = {
  status: { method: 'GET', path: '/api/control' },
  pause: { method: 'POST', path: '/api/control/pause' },
  resume: { method: 'POST', path: '/api/control/resume' },
  'stop-all': { method: 'POST', path: '/api/control/stop-all' },
  'pause --session': { method: 'POST', path: '/api/sessions/:id/pause' },
  'resume --session': { method: 'POST', path: '/api/sessions/:id/resume' },
  'approvals list': { method: 'GET', path: '/api/approvals' },
  'approvals show': { method: 'GET', path: '/api/approvals/:id' },
  'approvals approve': { method: 'POST', path: '/api/approvals/:id/approve' },
  'approvals deny': { method: 'POST', path: '/api/approvals/:id/deny' },
  'runs list': { method: 'GET', path: '/api/runs' }
} as const;

export type ControlCliVerb = keyof typeof CONTROL_CLI_ROUTES;

/** Recorded as `decidedBy` / `by` for decisions made from the CLI. */
export const CLI_ACTOR = 'cli';

export class ControlApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

export interface ControlClientOptions {
  url?: string;
  fetchImpl?: typeof fetch;
}

export function resolveControlUrl(url?: string): string {
  const raw = url ?? process.env.CONDUIT_CONTROL_URL ?? `http://127.0.0.1:${CONTROL_PANEL_DEFAULT_PORT}`;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid Conduit Control URL: ${raw}`);
  }
  // Control has no login; it is only ever a loopback service. Refuse to send
  // approvals or pause decisions anywhere else.
  if (parsed.protocol !== 'http:' || !isLoopbackHostname(parsed.hostname)) {
    throw new Error(`Conduit Control URL must be http on a loopback host, got: ${raw}`);
  }
  return parsed.origin;
}

export class ControlClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ControlClientOptions = {}) {
    this.baseUrl = resolveControlUrl(options.url);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  status(): Promise<any> {
    return this.call('status');
  }

  pause(input: { sessionId?: string; reason?: string } = {}): Promise<any> {
    return input.sessionId
      ? this.call('pause --session', { id: input.sessionId })
      : this.call('pause', {}, { by: CLI_ACTOR, ...(input.reason ? { reason: input.reason } : {}) });
  }

  resume(input: { sessionId?: string } = {}): Promise<any> {
    return input.sessionId
      ? this.call('resume --session', { id: input.sessionId })
      : this.call('resume', {}, { by: CLI_ACTOR });
  }

  stopAll(input: { reason?: string } = {}): Promise<any> {
    return this.call('stop-all', {}, { by: CLI_ACTOR, ...(input.reason ? { reason: input.reason } : {}) });
  }

  listApprovals(): Promise<any> {
    return this.call('approvals list');
  }

  showApproval(approvalId: string): Promise<any> {
    return this.call('approvals show', { id: approvalId });
  }

  decideApproval(approvalId: string, decision: 'approve' | 'deny', reason?: string): Promise<any> {
    return this.call(decision === 'approve' ? 'approvals approve' : 'approvals deny', { id: approvalId }, {
      decidedBy: CLI_ACTOR,
      ...(reason ? { reason } : {})
    });
  }

  listRuns(): Promise<any> {
    return this.call('runs list');
  }

  async call(verb: ControlCliVerb, params: { id?: string } = {}, body?: Record<string, unknown>): Promise<any> {
    const route = CONTROL_CLI_ROUTES[verb];
    const routePath = route.path.replace(':id', encodeURIComponent(params.id ?? ''));
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${routePath}`, {
        method: route.method,
        ...(route.method === 'POST'
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }
          : {})
      });
    } catch (error) {
      throw new Error([
        `Conduit Control is not reachable at ${this.baseUrl} (${error instanceof Error ? error.message : String(error)}).`,
        'Start it with `conduit app start` or the Conduit menu-bar app.'
      ].join(' '));
    }
    const text = await response.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text };
    }
    if (!response.ok) {
      throw new ControlApiError(
        typeof json?.error === 'string' ? json.error : `Conduit Control returned HTTP ${response.status}.`,
        response.status,
        json
      );
    }
    return json;
  }
}

// ---- Text rendering (shared by HTTP and --local paths) ----------------------

export function formatControlStatus(control: any): string {
  const pause = control?.pause ?? {};
  const lines = [
    control?.paused
      ? `Conduit: PAUSED${pause.pausedAt ? ` since ${pause.pausedAt}` : ''}${pause.pausedBy ? ` by ${pause.pausedBy}` : ''}${pause.reason ? ` (${pause.reason})` : ''}`
      : 'Conduit: running (not paused)',
    `Live sessions: ${control?.liveSessions ?? 0}`,
    `Paused sessions: ${Array.isArray(control?.pausedSessions) && control.pausedSessions.length > 0
      ? control.pausedSessions.map((session: any) => `${session.sessionId} (${session.label})`).join(', ')
      : 'none'}`,
    `Pending approvals: ${control?.pendingApprovals ?? 0}`
  ];
  return lines.join('\n');
}

export function formatApprovalLine(approval: any): string {
  const decided = approval.decidedBy ? `  by ${approval.decidedBy}` : '';
  const execution = approval.executionStatus ? `  execution ${approval.executionStatus}` : '';
  return [
    `${approval.approvalId}  ${approval.status}  ${approval.action?.tool ?? '?'}  ${approval.createdAt}${decided}${execution}`,
    `  policy: ${approval.policyReason ?? ''}`,
    ...(approval.status === 'pending' && approval.expiresAt ? [`  expires: ${approval.expiresAt}`] : [])
  ].join('\n');
}

export function formatApprovalDetail(approval: any): string {
  const args = approval.action?.args ?? {};
  return [
    formatApprovalLine(approval),
    `  reason: ${approval.action?.reason ?? '(none provided)'}`,
    ...(approval.sessionId ? [`  session: ${approval.sessionId}`] : []),
    ...(approval.projectRoot ? [`  project: ${approval.projectRoot}`] : []),
    ...(approval.decisionReason ? [`  decision: ${approval.decisionReason}`] : []),
    ...(approval.executionRunId ? [`  run: ${approval.executionRunId}`] : []),
    ...(approval.executionError ? [`  error: ${approval.executionError}`] : []),
    '  args:',
    ...JSON.stringify(args, null, 2).split('\n').map((line) => `    ${line}`)
  ].join('\n');
}

export function formatRunLine(run: any): string {
  return `${run.runId}  ${run.mode ?? '?'}  ${run.status ?? '?'}${run.approvalId ? `  approval ${run.approvalId}` : ''}${run.summary ? `  ${run.summary}` : ''}`;
}
