import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ClipboardWatcher } from '../daemon/clipboard-watcher.js';
import { MacClipboardIO, type ClipboardIO } from '../daemon/clipboard-io.js';
import { getRunsRoot, getStateRoot } from '../state/paths.js';
import { createSession, listSessions, revokeSession } from '../sessions/session-store.js';
import { isPermissionProfileName } from '../sessions/profiles.js';
import { renderAgentHandshake } from '../protocol/render-agent-handshake.js';
import { createConduitUrl, parseConduitUrl } from '../protocol/conduit-url.js';
import {
  getApprovalRequest,
  listApprovalRequests,
  markApprovalExecutionFinished,
  markApprovalExecutionRunning,
  resolveApprovalRequest
} from '../approvals/approval-store.js';
import { executeApprovedReview, executeRequestFromUnknown } from '../daemon/execute-request.js';
import { createDiagnosticBundle } from '../diagnostics/diagnostic-bundle.js';

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
const DEFAULT_PORT = 47831;

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
      sendHtml(res, renderAppHtml());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/app.js') {
      sendJs(res, renderAppJs());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(res, 200, {
        status: 'ok',
        mode: 'Compliance',
        stateRoot: getStateRoot(),
        exactEnvelopeParsing: true,
        embeddedBlockParsing: false,
        clipboardWatcher: 'available',
        capabilities: {
          agentHandshake: true,
          clipboardCheck: true,
          conduitUrlOpen: true,
          approvals: true,
          sessions: true,
          runs: true
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

    if (req.method === 'GET' && url.pathname === '/api/runs') {
      sendJson(res, 200, { runs: await listRuns() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/approvals') {
      sendJson(res, 200, { approvals: await listApprovalRequests() });
      return;
    }

    const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|deny)$/);
    if (req.method === 'POST' && approvalMatch?.[1] && approvalMatch?.[2]) {
      const body = await readJsonBody(req) as { reason?: unknown };
      const decision = approvalMatch[2] === 'approve' ? 'approved' : 'denied';
      const approvalId = decodeURIComponent(approvalMatch[1]);
      const before = await getApprovalRequest(approvalId);
      const approval = await resolveApprovalRequest(
        approvalId,
        decision,
        typeof body.reason === 'string' ? body.reason : undefined,
        'control-app'
      );
      if (
        decision === 'approved'
        && before?.status === 'pending'
        && !before.executionStatus
        && approval.action.tool === 'conduit.review'
      ) {
        const running = await markApprovalExecutionRunning(approval.approvalId);
        try {
          const execution = await executeApprovedReview(running, { yes: true });
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
      const runId = decodeURIComponent(runResultMatch[1]);
      const result = await readOptionalFile(path.join(getRunsRoot(), runId, 'result.txt'))
        ?? await readOptionalFile(path.join(getRunsRoot(), runId, 'final.md'))
        ?? '';
      sendJson(res, 200, { runId, result });
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

async function listRuns(): Promise<Array<Record<string, unknown>>> {
  const runsRoot = getRunsRoot();
  let runIds: string[];
  try {
    runIds = await readdir(runsRoot);
  } catch {
    return [];
  }

  const runs = await Promise.all(runIds.sort().reverse().slice(0, 50).map(async (runId) => {
    const runDir = path.join(runsRoot, runId);
    const metadata = await readJsonFile(path.join(runDir, 'metadata.json'));
    const final = await readJsonFile(path.join(runDir, 'final.json'));
    const resultText = await readOptionalFile(path.join(runDir, 'result.txt'));
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
  }));
  return runs;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  const text = await readOptionalFile(filePath);
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

function renderAppHtml(): string {
  const extensionInstallUrl = createConduitUrl(JSON.stringify(createExtensionInstallRequest(), null, 2));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Conduit Control</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f8;
      --panel: #ffffff;
      --panel-soft: #f0f3f5;
      --text: #172026;
      --muted: #66737c;
      --border: #dce2e6;
      --accent: #0f766e;
      --accent-strong: #0b5f59;
      --danger: #b42318;
      --shadow: 0 12px 30px rgba(23, 32, 38, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    button, input, select { font: inherit; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 240px 1fr; }
    aside { border-right: 1px solid var(--border); background: #fbfcfc; padding: 24px 18px; }
    .brand { font-size: 22px; font-weight: 760; letter-spacing: 0; margin-bottom: 6px; }
    .subtle { color: var(--muted); font-size: 13px; line-height: 1.45; }
    nav { margin-top: 28px; display: grid; gap: 8px; }
    nav button { text-align: left; border: 0; background: transparent; padding: 10px 12px; border-radius: 7px; color: var(--text); cursor: pointer; }
    nav button.active { background: var(--panel-soft); color: var(--accent-strong); font-weight: 650; }
    main { padding: 28px; max-width: 1180px; width: 100%; }
    header { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 22px; }
    h1 { font-size: 28px; line-height: 1.15; margin: 0 0 7px; letter-spacing: 0; }
    h2 { font-size: 17px; margin: 0; letter-spacing: 0; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
    .btn { border: 1px solid var(--border); background: var(--panel); color: var(--text); padding: 9px 12px; border-radius: 7px; cursor: pointer; }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.danger { color: var(--danger); }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
    .metric, .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow); }
    .metric { padding: 16px; }
    .metric b { display: block; font-size: 24px; margin-bottom: 4px; }
    .panel { margin-bottom: 16px; overflow: hidden; }
    .panel-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
    .panel-body { padding: 14px 16px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid var(--border); padding: 11px 8px; font-size: 13px; vertical-align: top; }
    th { color: var(--muted); font-weight: 650; }
    tr:last-child td { border-bottom: 0; }
    code, pre { font-family: "SFMono-Regular", Consolas, monospace; }
    pre { white-space: pre-wrap; overflow: auto; margin: 0; background: #101820; color: #d8efe9; border-radius: 8px; padding: 12px; font-size: 12px; line-height: 1.45; }
    form { display: grid; grid-template-columns: 1fr 1fr 180px auto; gap: 10px; align-items: end; }
    label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; font-weight: 650; }
    input, select { border: 1px solid var(--border); border-radius: 7px; padding: 9px 10px; background: #fff; color: var(--text); min-width: 0; }
    .empty { color: var(--muted); padding: 18px 4px; }
    .status-line { font-size: 13px; color: var(--muted); margin-top: 10px; min-height: 19px; }
    .approval-actions { margin: 0; padding-left: 18px; }
    .approval-actions li { margin: 3px 0; }
    .hidden { display: none; }
    @media (max-width: 820px) {
      .shell { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--border); }
      nav { grid-template-columns: repeat(4, 1fr); }
      main { padding: 20px; }
      header { display: block; }
      .toolbar { margin-top: 12px; }
      .grid { grid-template-columns: 1fr; }
      form { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand">Conduit</div>
      <div class="subtle">Local capability runner control plane</div>
      <nav>
        <button class="active" data-view="overview">Overview</button>
        <button data-view="sessions">Sessions</button>
        <button data-view="approvals">Approvals</button>
        <button data-view="runs">Runs</button>
        <button data-view="diagnostics">Bug Report</button>
      </nav>
    </aside>
    <main>
      <header>
        <div>
          <h1 id="title">Overview</h1>
          <div class="subtle" id="subtitle">Compliance mode, exact clipboard envelopes only.</div>
        </div>
        <div class="toolbar">
          <button class="btn" id="refresh">Refresh</button>
          <button class="btn" id="reportBug">Report Bug</button>
          <button class="btn" id="copyHandshake">Copy Agent Handshake</button>
          <button class="btn primary" id="checkClipboard">Check Clipboard Once</button>
        </div>
      </header>
      <section id="overviewView">
        <div class="grid">
          <div class="metric"><b id="sessionCount">0</b><span class="subtle">sessions</span></div>
          <div class="metric"><b id="runCount">0</b><span class="subtle">recent runs</span></div>
          <div class="metric"><b id="mode">Compliance</b><span class="subtle">active mode</span></div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Runtime</h2></div>
          <div class="panel-body"><pre id="statusJson">{}</pre></div>
        </div>
        <div class="panel">
          <div class="panel-head">
            <h2>Extension Bridge</h2>
            <div class="toolbar">
              <a class="btn" href="${escapeHtml(extensionInstallUrl)}" id="downloadExtension">Download Extension</a>
              <button class="btn" id="retryOutbound">Retry Outbound</button>
            </div>
          </div>
          <div class="panel-body">
            <div class="status-line" id="bridgeAvailability">Checking bridge...</div>
            <pre id="bridgeJson">{}</pre>
          </div>
        </div>
      </section>
      <section id="sessionsView" class="hidden">
        <div class="panel">
          <div class="panel-head"><h2>Create Session</h2></div>
          <div class="panel-body">
            <form id="createSession">
              <label>Label<input name="label" value="Clipboard session"></label>
              <label>Root<input name="root" value="${escapeHtml(process.cwd())}"></label>
              <label>Profile<select name="profile"><option>read-only</option><option>edit-with-confirmation</option><option>shell-manual</option></select></label>
              <button class="btn primary" type="submit">Create</button>
            </form>
            <div class="status-line" id="sessionStatus"></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Sessions</h2></div>
          <div class="panel-body" id="sessionsTable"></div>
        </div>
        <div class="panel hidden" id="starterPanel">
          <div class="panel-head"><h2>Starter Envelope</h2></div>
          <div class="panel-body"><pre id="starterEnvelope"></pre></div>
        </div>
      </section>
      <section id="approvalsView" class="hidden">
        <div class="panel">
          <div class="panel-head"><h2>Pending Approvals</h2></div>
          <div class="panel-body" id="approvalsTable"></div>
        </div>
      </section>
      <section id="runsView" class="hidden">
        <div class="panel">
          <div class="panel-head"><h2>Recent Runs</h2></div>
          <div class="panel-body" id="runsTable"></div>
        </div>
        <div class="panel hidden" id="resultPanel">
          <div class="panel-head"><h2>Result</h2></div>
          <div class="panel-body"><pre id="runResult"></pre></div>
        </div>
      </section>
      <section id="diagnosticsView" class="hidden">
        <div class="panel">
          <div class="panel-head">
            <h2>Bug Report</h2>
            <button class="btn primary" id="copyDiagnostics">Copy Diagnostics</button>
          </div>
          <div class="panel-body">
            <p class="subtle">Preview the redacted diagnostic bundle before attaching it to a report. It excludes clipboard contents, request payloads, file contents, session nonces, API keys, environment variables, and credentials by default.</p>
            <pre id="diagnosticsJson">{}</pre>
          </div>
        </div>
      </section>
      <div class="status-line" id="appStatus"></div>
    </main>
  </div>
  <script src="/app.js"></script>
</body>
</html>`;
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

export function renderAppJs(): string {
  return `
const state = { status: null, bridge: null, sessions: [], approvals: [], runs: [], view: 'overview' };
const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function setStatus(text) { $('appStatus').textContent = text || ''; }

async function refresh() {
  const [status, bridge, sessions, approvals, runs] = await Promise.all([
    api('/api/status'),
    fetchBridgeHealth(),
    api('/api/sessions'),
    api('/api/approvals'),
    api('/api/runs')
  ]);
  state.status = status;
  state.bridge = bridge;
  state.sessions = sessions.sessions;
  state.approvals = approvals.approvals;
  state.runs = runs.runs;
  render();
}

function render() {
  $('sessionCount').textContent = state.sessions.length;
  $('runCount').textContent = state.runs.length;
  $('mode').textContent = state.status?.mode || 'Compliance';
  $('statusJson').textContent = JSON.stringify(state.status, null, 2);
  $('bridgeJson').textContent = JSON.stringify(state.bridge, null, 2);
  $('bridgeAvailability').textContent = bridgeAvailabilityText(state.bridge);
  $('retryOutbound').disabled = !bridgeCanRetry(state.bridge);
  renderSessions();
  renderApprovals();
  renderRuns();
}

function renderSessions() {
  if (state.sessions.length === 0) {
    $('sessionsTable').innerHTML = '<div class="empty">No sessions yet.</div>';
    return;
  }
  $('sessionsTable').innerHTML = '<table><thead><tr><th>Session</th><th>Profile</th><th>Roots</th><th>Nonce</th><th></th></tr></thead><tbody>' +
    state.sessions.map((session) => '<tr>' +
      '<td><strong>' + escapeHtml(session.label) + '</strong><br><span class="subtle">' + escapeHtml(session.sessionId) + ' · ' + escapeHtml(session.state) + '</span></td>' +
      '<td>' + escapeHtml(session.permissionProfile) + '</td>' +
      '<td>' + escapeHtml((session.allowedRoots || []).join(', ')) + '</td>' +
      '<td><code>' + escapeHtml(session.currentNonce) + '</code></td>' +
      '<td><button class="btn danger" data-revoke="' + encodeURIComponent(session.sessionId) + '">Revoke</button></td>' +
    '</tr>').join('') + '</tbody></table>';
}

function renderApprovals() {
  const visible = state.approvals.filter((approval) => approval.status === 'pending' || approval.executionStatus);
  if (visible.length === 0) {
    $('approvalsTable').innerHTML = '<div class="empty">No active approvals.</div>';
    return;
  }
  $('approvalsTable').innerHTML = '<table><thead><tr><th>Request</th><th>State</th><th>Review</th><th>Details</th><th></th></tr></thead><tbody>' +
    visible.map((approval) => '<tr>' +
      '<td>' + approvalRequestHtml(approval) + '</td>' +
      '<td>' + approvalStateHtml(approval) + '</td>' +
      '<td>' + approvalReviewHtml(approval) + '</td>' +
      '<td>' + approvalDetailsHtml(approval) + '</td>' +
      '<td>' + approvalActionsHtml(approval) + '</td>' +
    '</tr>').join('') + '</tbody></table>';
}

function approvalRequestHtml(approval) {
  if (approval.action?.tool === 'conduit.review') {
    return '<strong>Untrusted Conduit request</strong><br><span class="subtle">' + escapeHtml(approval.approvalId) + '</span>';
  }
  return '<strong>' + escapeHtml(approval.action?.tool || '') + '</strong><br><span class="subtle">' + escapeHtml(approval.approvalId) + '</span>';
}

function approvalButtonLabel(approval) {
  return approval.action?.tool === 'conduit.review' ? 'Approve once' : 'Approve';
}

function approvalStateHtml(approval) {
  const state = approval.executionStatus
    ? approval.executionStatus
    : approval.status === 'pending'
      ? 'pending review'
      : approval.status;
  const detail = approval.executionRunId
    ? 'run ' + approval.executionRunId
    : approval.executionError || approval.decisionReason || '';
  return '<strong>' + escapeHtml(state) + '</strong>' + (detail ? '<br><span class="subtle">' + escapeHtml(detail) + '</span>' : '');
}

function approvalReviewHtml(approval) {
  if (approval.action?.tool !== 'conduit.review') {
    return escapeHtml(approval.action?.reason || '(none provided)') + '<br><span class="subtle">' + escapeHtml(approval.policyReason || '') + '</span>';
  }
  const args = approval.action?.args || {};
  return [
    '<strong>' + escapeHtml(sourceLabel(args.source)) + '</strong>',
    '<span class="subtle">' + escapeHtml(permissionSummary(args.permissions)) + '</span>',
    '<span class="subtle">Approve once runs under read-only local policy. It does not create a trusted session.</span>'
  ].join('<br>');
}

function approvalDetailsHtml(approval) {
  if (approval.action?.tool !== 'conduit.review') {
    return '<pre>' + escapeHtml(JSON.stringify(approval.action?.args || {}, null, 2)) + '</pre>';
  }
  const args = approval.action?.args || {};
  const actions = Array.isArray(args.actions) ? args.actions : [];
  const actionList = actions.length > 0
    ? actions.map((action) => '<li><code>' + escapeHtml(action.id || '(no id)') + '</code> ' + escapeHtml(action.tool || '') + '</li>').join('')
    : '<li>No actions declared.</li>';
  const capabilityText = Array.isArray(args.requestedCapabilities) && args.requestedCapabilities.length > 0
    ? '<br><span class="subtle">Capabilities: ' + escapeHtml(args.requestedCapabilities.join(', ')) + '</span>'
    : '';
  const sessionText = args.sessionId
    ? '<br><span class="subtle">Session claim: ' + escapeHtml(args.sessionId) + '</span>'
    : '<br><span class="subtle">No live trusted session.</span>';
  return '<ul class="approval-actions">' + actionList + '</ul>' + capabilityText + sessionText;
}

function sourceLabel(source) {
  if (!source || typeof source !== 'object') return 'Source: unknown';
  const kind = source.kind || 'unknown';
  const trust = source.trust || 'untrusted';
  return 'Source: ' + kind + ' / ' + trust;
}

function permissionSummary(permissions) {
  if (!Array.isArray(permissions) || permissions.length === 0) return 'Declared permissions: none';
  return 'Declared permissions: ' + permissions.map((permission) => {
    if (!permission || typeof permission !== 'object') return 'unknown';
    return [permission.kind, permission.scope, permission.access].filter(Boolean).join(':') || 'unknown';
  }).join(', ');
}

function approvalActionsHtml(approval) {
  if (approval.executionStatus === 'running') {
    return '<button class="btn" disabled>Running...</button>';
  }
  if (approval.executionRunId) {
    return '<button class="btn" data-result="' + encodeURIComponent(approval.executionRunId) + '">View result</button>';
  }
  if (approval.status !== 'pending') {
    return '<span class="subtle">' + escapeHtml(approval.status) + '</span>';
  }
  return '<button class="btn primary" data-approve="' + encodeURIComponent(approval.approvalId) + '">' + approvalButtonLabel(approval) + '</button> ' +
    '<button class="btn danger" data-deny="' + encodeURIComponent(approval.approvalId) + '">Deny</button>';
}

function renderRuns() {
  if (state.runs.length === 0) {
    $('runsTable').innerHTML = '<div class="empty">No runs yet.</div>';
    return;
  }
  $('runsTable').innerHTML = '<table><thead><tr><th>Run</th><th>Status</th><th>Project</th><th>Started</th><th></th></tr></thead><tbody>' +
    state.runs.map((run) => '<tr>' +
      '<td><strong>' + escapeHtml(run.runId) + '</strong><br><span class="subtle">' + escapeHtml(run.mode || '') + '</span></td>' +
      '<td>' + escapeHtml(run.status || 'unknown') + '</td>' +
      '<td>' + escapeHtml(run.projectRoot || '') + '</td>' +
      '<td>' + escapeHtml(run.startedAt || '') + '</td>' +
      '<td><button class="btn" data-result="' + encodeURIComponent(run.runId) + '">View</button></td>' +
    '</tr>').join('') + '</tbody></table>';
}

function setView(view) {
  state.view = view;
  for (const id of ['overview', 'sessions', 'approvals', 'runs', 'diagnostics']) {
    $(id + 'View').classList.toggle('hidden', id !== view);
    document.querySelector('[data-view="' + id + '"]').classList.toggle('active', id === view);
  }
  $('title').textContent = view[0].toUpperCase() + view.slice(1);
  if (location.hash !== '#' + view) {
    history.replaceState(null, '', '#' + view);
  }
}

function initialView() {
  const hash = location.hash.replace(/^#/, '');
  return ['overview', 'sessions', 'approvals', 'runs', 'diagnostics'].includes(hash) ? hash : 'overview';
}

document.addEventListener('click', async (event) => {
  const view = event.target.dataset?.view;
  if (view) setView(view);

  const revoke = event.target.dataset?.revoke;
  if (revoke) {
    await api('/api/sessions/' + revoke + '/revoke', { method: 'POST' });
    setStatus('Session revoked.');
    await refresh();
  }

  const approve = event.target.dataset?.approve;
  if (approve) {
    const result = await api('/api/approvals/' + approve + '/approve', {
      method: 'POST',
      body: JSON.stringify({ reason: 'Approved from Conduit Control.' })
    });
    if (result.execution?.runId && result.copiedToClipboard) {
      setStatus('Approved, executed run ' + result.execution.runId + ', and copied results to clipboard.');
    } else if (result.execution?.runId) {
      setStatus('Approved and executed run ' + result.execution.runId + '.');
    } else {
      setStatus('Action approved.');
    }
    await refresh();
  }

  const deny = event.target.dataset?.deny;
  if (deny) {
    await api('/api/approvals/' + deny + '/deny', {
      method: 'POST',
      body: JSON.stringify({ reason: 'Denied from Conduit Control.' })
    });
    setStatus('Action denied.');
    await refresh();
  }

  const result = event.target.dataset?.result;
  if (result) {
    const data = await api('/api/runs/' + result + '/result');
    $('runResult').textContent = data.result || '(no result text)';
    $('resultPanel').classList.remove('hidden');
  }
});

$('refresh').addEventListener('click', () => refresh().catch((error) => setStatus(error.message)));
$('reportBug').addEventListener('click', async () => {
  setView('diagnostics');
  await loadDiagnostics();
});
$('copyDiagnostics').addEventListener('click', async () => {
  await loadDiagnostics();
  await navigator.clipboard.writeText($('diagnosticsJson').textContent);
  setStatus('Redacted diagnostics copied.');
});
$('checkClipboard').addEventListener('click', async () => {
  setStatus('Checking clipboard...');
  const result = await api('/api/clipboard/check', { method: 'POST' });
  setStatus('Clipboard check: ' + result.status);
  await refresh();
});

$('retryOutbound').addEventListener('click', async () => {
  const transportId = selectRetryTransportId(state.bridge);
  await fetchBridgeRetry(transportId);
  setStatus('Queued outbound retry.');
  await refresh();
});

$('copyHandshake').addEventListener('click', async () => {
  setStatus('Creating agent handshake...');
  const result = await api('/api/agent-handshake', {
    method: 'POST',
    body: JSON.stringify({
      label: 'Chat agent loop',
      root: '${escapeJsString(process.cwd())}',
      profile: 'read-only',
      transport: 'extension'
    })
  });
  setStatus(result.copied ? 'Agent handshake copied to clipboard.' : 'Agent handshake created.');
  await refresh();
});

$('createSession').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const data = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      label: form.get('label'),
      root: form.get('root'),
      profile: form.get('profile')
    })
  });
  $('sessionStatus').textContent = 'Created ' + data.session.sessionId;
  $('starterEnvelope').textContent = '\`\`\`conduit\\n' + JSON.stringify(data.starterEnvelope, null, 2) + '\\n\`\`\`';
  $('starterPanel').classList.remove('hidden');
  await refresh();
});

async function loadDiagnostics() {
  const data = await api('/api/diagnostics');
  $('diagnosticsJson').textContent = JSON.stringify(data.bundle, null, 2);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

async function fetchBridgeHealth() {
  try {
    const response = await fetch('http://127.0.0.1:3333/health');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } catch (error) {
    return {
      status: 'offline',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function fetchBridgeRetry(transportId) {
  const response = await fetch('http://127.0.0.1:3333/api/conduit-retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(transportId ? { transportId } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Retry failed');
  return data;
}

function bridgeCanRetry(bridge) {
  return Boolean(bridge?.attentionOutboundIds?.length || bridge?.retryingOutboundIds?.length || bridge?.pendingSendResultIds?.length);
}

function bridgeAvailabilityText(bridge) {
  if (bridge?.status === 'offline') return 'Bridge offline: ' + (bridge.error || 'local listener is not reachable');
  const availability = bridge?.tabAvailability;
  if (!availability) return 'ChatGPT tab availability unknown.';
  return 'ChatGPT tab ' + availability.status + ': ' + availability.reason;
}

function selectRetryTransportId(bridge) {
  return bridge?.attentionOutboundIds?.[0]
    || bridge?.retryingOutboundIds?.[0]
    || bridge?.pendingSendResultIds?.[0];
}

setView(initialView());
refresh().catch((error) => setStatus(error.message));
`;
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char] ?? char));
}

function escapeJsString(value: string): string {
  return value.replace(/[\\'"]/g, (char) => `\\${char}`).replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Browser-facing guard for the local control API. Binding to 127.0.0.1 keeps
 * other machines out, but any web page the user visits can still send requests
 * to loopback. Refuse:
 * - Host headers that are not loopback (DNS-rebinding pages), and
 * - state-changing requests carrying a foreign Origin or a cross-site
 *   Sec-Fetch-Site (cross-site form/fetch posts that could approve or run work).
 * Non-browser clients (the macOS menu-bar app, curl, tests) send no Origin and
 * are unaffected.
 */
export function refuseNonLocalRequest(req: http.IncomingMessage): string | null {
  const hostHeader = req.headers.host;
  if (hostHeader) {
    let hostname: string;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname;
    } catch {
      return 'Invalid Host header.';
    }
    if (!isLoopbackHostname(hostname)) {
      return 'Conduit Control only answers requests addressed to a loopback host.';
    }
  }

  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return null;
  }

  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return 'Cross-site requests cannot change Conduit state.';
  }

  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    if (!hostHeader || origin !== `http://${hostHeader}`) {
      return 'Cross-origin requests cannot change Conduit state.';
    }
  }
  return null;
}

