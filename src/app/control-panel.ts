import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { ClipboardWatcher } from '../daemon/clipboard-watcher.js';
import { MacClipboardIO, type ClipboardIO } from '../daemon/clipboard-io.js';
import { getRunsRoot, getStateRoot, isSafeRunId, resolveRunFile, RunPathError } from '../state/paths.js';
import { createSession, getSession, listSessions, pauseSession, resumeSession, revokeSession } from '../sessions/session-store.js';
import { isPermissionProfileName } from '../sessions/profiles.js';
import { renderAgentHandshake } from '../protocol/render-agent-handshake.js';
import { createConduitUrl, parseConduitUrl } from '../protocol/conduit-url.js';
import {
  getApprovalRequest,
  isApprovalDecider,
  listApprovalRequests,
  markApprovalExecutionFinished,
  markApprovalExecutionRunning,
  resolveApprovalRequest,
  type ApprovalRecord
} from '../approvals/approval-store.js';
import { isRememberableAction, REMEMBER_FOR_THIS_CHAT } from '../approvals/session-grants.js';
import { executeApprovedReview, executeRequestFromUnknown } from '../daemon/execute-request.js';
import { createDiagnosticBundle } from '../diagnostics/diagnostic-bundle.js';
import { getPauseState } from '../state/pause-state.js';
import { getSettings, parseSettingsUpdate, SettingsValidationError, updateSettings } from '../state/settings.js';
import { getControlStatus, pauseAll, resumeAll, stopAll } from './control-operations.js';
import { getControlIdentity } from './control-identity.js';
import { renderAppHtml, renderAppJs } from './control-panel-ui.js';
import { CONTROL_PANEL_DEFAULT_PORT, isLoopbackHostname, refuseNonLocalRequest } from '../util/loopback-guard.js';

export { renderAppJs };

export interface ControlPanelOptions {
  host?: string;
  port?: number;
  open?: boolean;
  clipboard?: ClipboardIO;
}

export interface ControlPanelHandle {
  server: http.Server;
  url: string;
  close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = CONTROL_PANEL_DEFAULT_PORT;

export async function startControlPanel(options: ControlPanelOptions = {}): Promise<ControlPanelHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  if (!isLoopbackHostname(host)) {
    // The control panel can approve and execute local actions and has no login,
    // so it must never be reachable from another machine.
    throw new Error(`Refusing to bind the Conduit control panel to non-loopback host ${host}. Use 127.0.0.1.`);
  }
  const server = createControlPanelServer(options);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;
  if (options.open) {
    openBrowser(url).catch((error) => {
      console.error(`[Conduit app] Failed to open browser: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  return {
    server,
    url,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

export function createControlPanelServer(options: ControlPanelOptions = {}): http.Server {
  const clipboard = options.clipboard ?? new MacClipboardIO();
  return http.createServer((req, res) => {
    void handleRequest(req, res, clipboard);
  });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, clipboard: ClipboardIO): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const refusal = refuseNonLocalRequest(req);
  if (refusal) {
    sendJson(res, 403, { error: refusal });
    return;
  }
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      sendHtml(res, renderAppHtml({
        cwd: process.cwd(),
        extensionInstallUrl: createConduitUrl(JSON.stringify(createExtensionInstallRequest(), null, 2))
      }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/app.js') {
      sendJs(res, renderAppJs());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const pause = await getPauseState();
      sendJson(res, 200, {
        status: 'ok',
        mode: 'Compliance',
        paused: pause.paused,
        stateRoot: getStateRoot(),
        // Which checkout this Control runs from. The menu-bar app adopts a
        // Control already on its port only when this is its own checkout.
        identity: getControlIdentity(),
        exactEnvelopeParsing: true,
        embeddedBlockParsing: false,
        clipboardWatcher: 'available',
        capabilities: {
          agentHandshake: true,
          clipboardCheck: true,
          conduitUrlOpen: true,
          approvals: true,
          sessions: true,
          runs: true,
          pause: true,
          settings: true,
          rememberForThisChat: true
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
      sendJson(res, 200, {
        bundle: await createDiagnosticBundle({
          services: {
            controlPanel: {
              status: 'ok',
              port: req.socket.localPort
            }
          }
        })
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      sendJson(res, 200, { sessions: await listSessions() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      const body = await readJsonBody(req) as {
        label?: unknown;
        root?: unknown;
        profile?: unknown;
        transport?: unknown;
      };
      const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'App session';
      const root = typeof body.root === 'string' && body.root.trim() ? body.root.trim() : process.cwd();
      const profile = typeof body.profile === 'string' && isPermissionProfileName(body.profile) ? body.profile : 'read-only';
      const transport = body.transport === 'extension' || body.transport === 'browser-yolo' || body.transport === 'api'
        ? body.transport
        : 'clipboard';
      const session = await createSession({
        label,
        permissionProfile: profile,
        allowedRoots: [root],
        transport
      });
      sendJson(res, 201, { session, starterEnvelope: createStarterEnvelope(session.sessionId, session.currentNonce) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/agent-handshake') {
      const body = await readJsonBody(req) as {
        label?: unknown;
        root?: unknown;
        profile?: unknown;
        transport?: unknown;
        docsUrl?: unknown;
        copy?: unknown;
      };
      const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'Agent handshake';
      const root = typeof body.root === 'string' && body.root.trim() ? body.root.trim() : process.cwd();
      const profile = typeof body.profile === 'string' && isPermissionProfileName(body.profile) ? body.profile : 'read-only';
      const transport = body.transport === 'extension' || body.transport === 'browser-yolo' || body.transport === 'api'
        ? body.transport
        : 'extension';
      const session = await createSession({
        label,
        permissionProfile: profile,
        allowedRoots: [root],
        transport
      });
      const handshake = renderAgentHandshake({
        session,
        docsUrl: typeof body.docsUrl === 'string' && body.docsUrl.trim() ? body.docsUrl.trim() : undefined
      });
      let copied = false;
      let clipboardError: string | undefined;
      if (body.copy !== false) {
        try {
          await clipboard.write(handshake);
          copied = true;
        } catch (error) {
          // No system clipboard (e.g. Linux without pbcopy): the UI shows the
          // handshake for a manual copy instead of failing after the session exists.
          clipboardError = error instanceof Error ? error.message : String(error);
        }
      }
      sendJson(res, 201, { session, handshake, copied, clipboardError });
      return;
    }

    const revokeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/revoke$/);
    if (req.method === 'POST' && revokeMatch?.[1]) {
      sendJson(res, 200, { session: await revokeSession(decodeURIComponent(revokeMatch[1])) });
      return;
    }

    // Per-session pause/resume (S1). Like every trust-changing endpoint these
    // live only on this Origin-guarded panel, never on the extension bridge.
    const sessionPauseMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(pause|resume)$/);
    if (req.method === 'POST' && sessionPauseMatch?.[1] && sessionPauseMatch?.[2]) {
      const sessionId = decodeURIComponent(sessionPauseMatch[1]);
      try {
        const session = sessionPauseMatch[2] === 'pause'
          ? await pauseSession(sessionId)
          : await resumeSession(sessionId);
        sendJson(res, 200, { session });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, message.startsWith('Unknown session') ? 404 : 409, { error: message });
      }
      return;
    }

    // Global pause / kill switch (S1).
    if (req.method === 'GET' && url.pathname === '/api/control') {
      sendJson(res, 200, { control: await getControlStatus() });
      return;
    }

    const controlMatch = url.pathname.match(/^\/api\/control\/(pause|resume|stop-all)$/);
    if (req.method === 'POST' && controlMatch?.[1]) {
      const body = await readJsonBody(req) as { reason?: unknown; by?: unknown };
      const by = isApprovalDecider(body.by) ? body.by : 'control-app';
      const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;
      if (controlMatch[1] === 'pause') {
        sendJson(res, 200, { control: await pauseAll({ by, reason }) });
      } else if (controlMatch[1] === 'resume') {
        sendJson(res, 200, { control: await resumeAll({ by }) });
      } else {
        sendJson(res, 200, await stopAll({ by, reason }));
      }
      return;
    }

    // Settings (UI is an API control plane): the panel, the menu bar's Settings
    // window and `conduit settings show/set` all make these same two calls.
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      sendJson(res, 200, { settings: await getSettings() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      try {
        const update = parseSettingsUpdate(await readJsonBody(req));
        sendJson(res, 200, { settings: await updateSettings(update) });
      } catch (error) {
        if (error instanceof SettingsValidationError) {
          sendJson(res, 400, { error: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/runs') {
      sendJson(res, 200, { runs: await listRuns() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/approvals') {
      sendJson(res, 200, { approvals: await listApprovalRequests() });
      return;
    }

    const approvalShowMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (req.method === 'GET' && approvalShowMatch?.[1]) {
      const approval = await getApprovalRequest(decodeURIComponent(approvalShowMatch[1]));
      if (!approval) {
        sendJson(res, 404, { error: 'Unknown approval request.' });
        return;
      }
      sendJson(res, 200, { approval });
      return;
    }

    const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|deny)$/);
    if (req.method === 'POST' && approvalMatch?.[1] && approvalMatch?.[2]) {
      const body = await readJsonBody(req) as { reason?: unknown; decidedBy?: unknown; remember?: unknown };
      const decision = approvalMatch[2] === 'approve' ? 'approved' : 'denied';
      const approvalId = decodeURIComponent(approvalMatch[1]);
      // decidedBy is an audit label for the channel (panel, menu bar,
      // notification, CLI); it grants nothing, so it is caller-declared from a
      // fixed list and defaults to the panel.
      const decidedBy = isApprovalDecider(body.decidedBy) ? body.decidedBy : 'control-app';
      const before = await getApprovalRequest(approvalId);
      if (!before) {
        sendJson(res, 404, { error: 'Unknown approval request.' });
        return;
      }
      if (decision === 'approved' && before.status === 'pending' && (await getPauseState()).paused) {
        // Nothing runs while paused, so an approval now could only fire later
        // against a workspace the user has not looked at. Resume first.
        sendJson(res, 409, { error: 'Conduit is paused. Resume before approving.', approval: before });
        return;
      }
      // "Allow for this chat" (Jon 2026-10-18: remembered for this chat only).
      // Refused up front, with nothing decided, unless the ask is a confirmation
      // from a live session for an action that can be remembered exactly. An
      // untrusted review can never be remembered: approve once creates no trust.
      const remember = body.remember === undefined || body.remember === null ? undefined : body.remember;
      if (remember !== undefined) {
        const refusal = await rememberRefusal(remember, decision, before);
        if (refusal) {
          sendJson(res, 400, { error: refusal, approval: before });
          return;
        }
      }
      const approval = await resolveApprovalRequest(
        approvalId,
        decision,
        typeof body.reason === 'string' ? body.reason : undefined,
        decidedBy,
        remember === undefined ? {} : { remember: REMEMBER_FOR_THIS_CHAT }
      );
      if (approval.status !== decision) {
        // Already decided another way, or expired (timeout = deny). A late
        // approve must not look like it worked.
        sendJson(res, 409, { error: `Approval is ${approval.status}, not pending.`, approval });
        return;
      }
      if (
        decision === 'approved'
        && before?.status === 'pending'
        && !before.executionStatus
        && approval.action.tool === 'conduit.review'
      ) {
        const running = await markApprovalExecutionRunning(approval.approvalId);
        try {
          const execution = await executeApprovedReview(running, { yes: true });
          if (execution.repair?.code === 'paused') {
            // Pause landed after the check above but before the review ran, so
            // nothing ran. Fail closed: the record stays approved with its
            // execution failed and is never re-run later against a workspace the
            // user has not looked at. Say so plainly; the user resends after resume.
            const message = 'Conduit was paused before this approved review ran, so nothing ran. Resume Conduit, then resend the request.';
            const updated = await markApprovalExecutionFinished(approval.approvalId, { status: 'failed', error: message });
            sendJson(res, 409, { error: message, approval: updated, execution });
            return;
          }
          let copiedToClipboard = false;
          let clipboardError: string | undefined;
          if (execution.rendered) {
            try {
              await clipboard.write(execution.rendered);
              copiedToClipboard = true;
            } catch (error) {
              clipboardError = error instanceof Error ? error.message : String(error);
            }
          }
          const updated = execution.runId
            ? await markApprovalExecutionFinished(approval.approvalId, { status: 'ran', runId: execution.runId })
            : await markApprovalExecutionFinished(approval.approvalId, { status: 'failed', error: execution.reason ?? 'Execution did not produce a run.' });
          sendJson(res, 200, { approval: updated, execution, copiedToClipboard, clipboardError });
        } catch (error) {
          const updated = await markApprovalExecutionFinished(approval.approvalId, {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error)
          });
          sendJson(res, 500, { approval: updated, error: updated.executionError });
        }
        return;
      }
      sendJson(res, 200, { approval });
      return;
    }

    const runResultMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/result$/);
    if (req.method === 'GET' && runResultMatch?.[1]) {
      let runId: string;
      try {
        runId = decodeURIComponent(runResultMatch[1]);
      } catch {
        // A malformed percent escape is a bad request, not a server fault.
        sendJson(res, 400, { error: 'Invalid run id.' });
        return;
      }
      if (!isSafeRunId(runId)) {
        sendJson(res, 400, { error: 'Invalid run id.' });
        return;
      }
      try {
        const result = await readRunFile(runId, 'result.txt')
          ?? await readRunFile(runId, 'final.md')
          ?? '';
        sendJson(res, 200, { runId, result });
      } catch (error) {
        // A symlinked run path escaping the runs root is just a missing run.
        if (error instanceof RunPathError) {
          sendJson(res, 404, { error: 'Unknown run.' });
          return;
        }
        throw error;
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/clipboard/check') {
      const watcher = new ClipboardWatcher({ clipboard });
      sendJson(res, 200, await watcher.checkOnce());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/url/open') {
      const body = await readJsonBody(req) as { url?: unknown };
      if (typeof body.url !== 'string' || !body.url.trim()) {
        sendJson(res, 400, { error: 'Missing Conduit URL.' });
        return;
      }
      const parsed = parseConduitUrl(body.url);
      const execution = await executeRequestFromUnknown(JSON.parse(parsed.text));
      sendJson(res, 200, { command: parsed.command, execution });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function rememberRefusal(
  remember: unknown,
  decision: 'approved' | 'denied',
  approval: ApprovalRecord
): Promise<string | null> {
  if (remember !== REMEMBER_FOR_THIS_CHAT) return 'remember must be "session" (this chat only).';
  if (decision !== 'approved') return 'Only an approval can be remembered for this chat.';
  if (approval.status !== 'pending') return null; // the normal 409 path reports it
  if (approval.action.tool === 'conduit.review') {
    return 'An untrusted request can only be approved once; it cannot be remembered.';
  }
  if (!isRememberableAction(approval.action)) {
    return `${approval.action.tool} cannot be remembered for this chat. Allow it once instead.`;
  }
  const session = approval.sessionId ? await getSession(approval.sessionId) : null;
  if (!session || session.state !== 'active') {
    return 'This request is not from a live chat, so it cannot be remembered. Allow it once instead.';
  }
  return null;
}

async function listRuns(): Promise<Array<Record<string, unknown>>> {
  let runIds: string[];
  try {
    runIds = await readdir(getRunsRoot());
  } catch {
    return [];
  }

  const runs = await Promise.all(runIds.filter(isSafeRunId).sort().reverse().slice(0, 50).map(async (runId): Promise<Record<string, unknown> | null> => {
    try {
      const metadata = await readRunJson(runId, 'metadata.json');
      const final = await readRunJson(runId, 'final.json');
      const resultText = await readRunFile(runId, 'result.txt');
      return {
        runId,
        mode: metadata?.mode ?? 'agent-loop',
        approvalId: metadata?.approvalId,
        projectRoot: metadata?.projectRoot,
        startedAt: metadata?.startedAt,
        status: final?.status ?? (resultText ? 'request' : 'unknown'),
        summary: final?.summary,
        hasResult: Boolean(resultText)
      };
    } catch (error) {
      // A run whose path escapes the runs root through a symlink is left out
      // of the list; its files are never read.
      if (error instanceof RunPathError) return null;
      throw error;
    }
  }));
  return runs.filter((run): run is Record<string, unknown> => run !== null);
}

async function readRunFile(runId: string, fileName: string): Promise<string | null> {
  const resolved = await resolveRunFile(runId, fileName);
  return resolved ? readOptionalFile(resolved) : null;
}

async function readRunJson(runId: string, fileName: string): Promise<Record<string, unknown> | null> {
  const text = await readRunFile(runId, fileName);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function createStarterEnvelope(sessionId: string, nonce: string): Record<string, unknown> {
  return {
    schema: 'conduit.request.v1',
    source: { kind: 'clipboard', trust: 'untrusted' },
    permissions: [{ kind: 'filesystem', scope: 'project', access: 'read' }],
    sessionId,
    nonce,
    list: '.',
    reason: 'List the project root.',
    risk: 'low'
  };
}

function createExtensionInstallRequest(): Record<string, unknown> {
  return {
    schema: 'conduit.request.v1',
    source: {
      kind: 'conduit-link',
      trust: 'untrusted',
      publisher: 'owl-kestrel',
      domain: 'owlandkestrel.com'
    },
    permissions: [
      { kind: 'browser-extension', scope: 'conduit-alpha', access: 'prepare' }
    ],
    title: 'Prepare Conduit Bridge extension alpha install',
    description: 'Downloads the Conduit Bridge alpha extension package, extracts it, and opens Chrome extension settings.',
    actions: [
      {
        id: 'prepare_extension_alpha',
        tool: 'conduit.extension.prepareAlphaInstall',
        args: {
          url: 'https://owlandkestrel.com/releases/conduit/conduit-bridge-extension.zip'
        },
        reason: 'Prepare optional browser extension for paired ChatGPT transport.',
        risk: 'low'
      }
    ],
    resultMode: { transport: 'app', format: 'markdown' }
  };
}

function sendHtml(res: http.ServerResponse, html: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJs(res: http.ServerResponse, js: string): void {
  res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
  res.end(js);
}

function sendJson(res: http.ServerResponse, statusCode: number, value: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile('open', [url], (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.on('error', reject);
  });
}
