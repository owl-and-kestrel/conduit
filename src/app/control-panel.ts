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
import { renderAppHtml, renderAppJs } from './control-panel-ui.js';

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

