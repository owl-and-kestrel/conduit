import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startControlPanel, type ControlPanelHandle } from '../../src/app/control-panel.js';
import { createApprovalRequest, getApprovalRequest } from '../../src/approvals/approval-store.js';
import type { ClipboardIO } from '../../src/daemon/clipboard-io.js';
import { createConduitUrl } from '../../src/protocol/conduit-url.js';
import { createSession, getSession } from '../../src/sessions/session-store.js';
import { getPauseState } from '../../src/state/pause-state.js';

describe('Conduit Control pause and approval API (S1/S2)', () => {
  let tempRoot: string;
  let projectRoot: string;
  let app: ControlPanelHandle;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-control-api-'));
    projectRoot = path.join(tempRoot, 'project');
    process.env.CONDUIT_STATE_DIR = path.join(tempRoot, 'state');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'README.md'), 'hello control\n', 'utf8');
    app = await startControlPanel({ host: '127.0.0.1', port: 0, clipboard: new MemoryClipboard() });
  });

  afterEach(async () => {
    await app.close();
    delete process.env.CONDUIT_STATE_DIR;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('pauses and resumes globally through the API; paused requests run nothing', async () => {
    const session = await createSession({
      label: 'Trusted',
      permissionProfile: 'read-only',
      allowedRoots: [projectRoot],
      transport: 'clipboard'
    });

    const paused = await postJson(`${app.url}/api/control/pause`, { reason: 'stepping away', by: 'menubar' });
    expect(paused.control).toMatchObject({ paused: true, pause: { pausedBy: 'menubar', reason: 'stepping away' } });
    expect((await getJson(`${app.url}/api/status`)).paused).toBe(true);
    expect((await getJson(`${app.url}/api/control`)).control.paused).toBe(true);

    const opened = await postJson(`${app.url}/api/url/open`, { url: createConduitUrl(requestJson(session.sessionId, session.currentNonce)) });
    expect(opened.execution).toMatchObject({ status: 'rejected', repair: { code: 'paused' } });

    const resumed = await postJson(`${app.url}/api/control/resume`, {});
    expect(resumed.control).toMatchObject({ paused: false, pause: { pausedBy: 'control-app' } });
    const ran = await postJson(`${app.url}/api/url/open`, { url: createConduitUrl(requestJson(session.sessionId, session.currentNonce)) });
    expect(ran.execution.status).toBe('executed');
    expect(ran.execution.rendered).toContain('hello control');
  });

  it('pauses and resumes one session through the API', async () => {
    const session = await createSession({ label: 'Chat', permissionProfile: 'read-only', allowedRoots: [projectRoot] });

    const paused = await postJson(`${app.url}/api/sessions/${session.sessionId}/pause`, {});
    expect(paused.session.state).toBe('paused');
    const status = await getJson(`${app.url}/api/control`);
    expect(status.control.pausedSessions).toEqual([{ sessionId: session.sessionId, label: 'Chat' }]);
    expect(status.control.paused).toBe(false);

    const resumed = await postJson(`${app.url}/api/sessions/${session.sessionId}/resume`, {});
    expect(resumed.session.state).toBe('active');

    await postJson(`${app.url}/api/sessions/${session.sessionId}/revoke`, {});
    const conflict = await fetch(`${app.url}/api/sessions/${session.sessionId}/resume`, { method: 'POST' });
    expect(conflict.status).toBe(409);
    const unknown = await fetch(`${app.url}/api/sessions/sess_missing/pause`, { method: 'POST' });
    expect(unknown.status).toBe(404);
  });

  it('stop-all pauses and revokes every live session', async () => {
    const a = await createSession({ label: 'A', permissionProfile: 'read-only', allowedRoots: [projectRoot] });
    const b = await createSession({ label: 'B', permissionProfile: 'read-only', allowedRoots: [projectRoot] });

    const stopped = await postJson(`${app.url}/api/control/stop-all`, {});
    expect(stopped.control.paused).toBe(true);
    expect(stopped.revokedSessions.sort()).toEqual([a.sessionId, b.sessionId].sort());
    expect((await getSession(a.sessionId))?.state).toBe('revoked');
    // Resume clears the pause but never revives revoked sessions.
    await postJson(`${app.url}/api/control/resume`, {});
    expect((await getSession(b.sessionId))?.state).toBe('revoked');
  });

  it('refuses cross-site and foreign-origin pause, resume, stop-all and session resume', async () => {
    const session = await createSession({ label: 'Chat', permissionProfile: 'read-only', allowedRoots: [projectRoot] });
    await postJson(`${app.url}/api/sessions/${session.sessionId}/pause`, {});
    await postJson(`${app.url}/api/control/pause`, {});

    for (const endpoint of ['/api/control/resume', '/api/control/pause', '/api/control/stop-all', `/api/sessions/${session.sessionId}/resume`]) {
      const foreign = await fetch(`${app.url}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
        body: '{}'
      });
      expect(foreign.status, endpoint).toBe(403);
      const crossSite = await fetch(`${app.url}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
        body: '{}'
      });
      expect(crossSite.status, endpoint).toBe(403);
    }
    expect((await getPauseState()).paused).toBe(true);
    expect((await getSession(session.sessionId))?.state).toBe('paused');

    const port = new URL(app.url).port;
    expect((await rawGet(app.url, '/api/control', `conduit.attacker.example:${port}`)).status).toBe(403);
    expect((await rawGet(app.url, '/api/control', `127.0.0.1:${port}`)).status).toBe(200);

    const sameOrigin = await fetch(`${app.url}/api/control/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: app.url },
      body: '{}'
    });
    expect(sameOrigin.status).toBe(200);
  });

  it('keeps pause and resume off the extension bridge', async () => {
    const bridge = await readFile(path.resolve('src/transports/extension-transport.ts'), 'utf8');
    expect(bridge).not.toContain('/api/control');
    expect(bridge).not.toMatch(/\/(pause|resume|stop-all)['"`]/);
    expect(bridge).not.toContain('pauseSession');
    expect(bridge).not.toContain('resumeSession');
    expect(bridge).not.toContain('clearGlobalPause');
  });

  it('shows one approval, records decidedBy, and refuses a stale or paused approve', async () => {
    const pending = await createApprovalRequest(writeApproval());
    const shown = await getJson(`${app.url}/api/approvals/${pending.approvalId}`);
    expect(shown.approval).toMatchObject({ approvalId: pending.approvalId, status: 'pending' });
    expect((await fetch(`${app.url}/api/approvals/approval_missing`)).status).toBe(404);
    expect((await fetch(`${app.url}/api/approvals/..%2Fsessions`)).status).toBe(404);

    // Approve while paused: refused, still pending. Deny still works.
    await postJson(`${app.url}/api/control/pause`, {});
    const pausedApprove = await fetch(`${app.url}/api/approvals/${pending.approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    expect(pausedApprove.status).toBe(409);
    expect((await getApprovalRequest(pending.approvalId))?.status).toBe('pending');
    const denied = await postJson(`${app.url}/api/approvals/${pending.approvalId}/deny`, { decidedBy: 'notification' });
    expect(denied.approval).toMatchObject({ status: 'denied', decidedBy: 'notification' });
    await postJson(`${app.url}/api/control/resume`, {});

    // Unknown decider labels fall back to the panel, never to something else.
    const other = await createApprovalRequest(writeApproval());
    const decided = await postJson(`${app.url}/api/approvals/${other.approvalId}/approve`, { decidedBy: 'policy' });
    expect(decided.approval.decidedBy).toBe('control-app');

    // Stale untrusted review: expires to deny and the approve is refused, not run.
    const stale = await createApprovalRequest(reviewApproval(projectRoot), { timeoutMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const late = await fetch(`${app.url}/api/approvals/${stale.approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decidedBy: 'cli' })
    });
    expect(late.status).toBe(409);
    const lateBody = await late.json() as any;
    expect(lateBody.approval).toMatchObject({ status: 'expired', decidedBy: 'timeout' });
    expect(lateBody.approval.executionStatus).toBeUndefined();
    expect(lateBody.execution).toBeUndefined();
  });
});

function requestJson(sessionId: string, nonce: string): string {
  return JSON.stringify({
    schema: 'conduit.request.v1',
    source: { kind: 'conduit-link', trust: 'untrusted' },
    permissions: [],
    sessionId,
    nonce,
    actions: [{ id: 'read', tool: 'file.read', args: { path: 'README.md' } }]
  });
}

function writeApproval() {
  return {
    action: { id: 'write_notes', tool: 'file.write', args: { path: 'notes.txt', content: 'x' }, reason: 'Persist notes.', risk: 'high' as const },
    policyReason: 'Tool requires confirmation: file.write',
    prompt: 'Allow?'
  };
}

function reviewApproval(projectRoot: string) {
  return {
    action: {
      id: 'review_untrusted_request',
      tool: 'conduit.review',
      args: { actions: [{ id: 'read', tool: 'file.read', args: { path: 'README.md' } }] },
      reason: 'Review.',
      risk: 'high' as const
    },
    policyReason: 'Request is not attached to a trusted session.',
    prompt: 'Review?',
    projectRoot
  };
}

class MemoryClipboard implements ClipboardIO {
  text = '';
  async read(): Promise<string> {
    return this.text;
  }
  async write(text: string): Promise<void> {
    this.text = text;
  }
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function postJson(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

function rawGet(baseUrl: string, requestPath: string, host: string): Promise<{ status: number }> {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: target.hostname, port: target.port, path: requestPath, method: 'GET', headers: { Host: host } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on('error', reject);
    req.end();
  });
}
