import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startControlPanel, type ControlPanelHandle } from '../../src/app/control-panel.js';
import { createApprovalRequest } from '../../src/approvals/approval-store.js';
import type { ClipboardIO } from '../../src/daemon/clipboard-io.js';
import { createConduitUrl } from '../../src/protocol/conduit-url.js';
import { createSession } from '../../src/sessions/session-store.js';

describe('control panel app', () => {
  let tempRoot: string;
  let projectRoot: string;
  let app: ControlPanelHandle;
  let clipboard: FakeClipboard;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-control-panel-'));
    projectRoot = path.join(tempRoot, 'project');
    process.env.CONDUIT_STATE_DIR = path.join(tempRoot, 'state');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'README.md'), 'hello app\n', 'utf8');
    clipboard = new FakeClipboard('');
    app = await startControlPanel({
      host: '127.0.0.1',
      port: 0,
      clipboard
    });
  });

  afterEach(async () => {
    await app.close();
    delete process.env.CONDUIT_STATE_DIR;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('serves the app shell and status API', async () => {
    const html = await fetchText(`${app.url}/`);
    expect(html).toContain('Conduit Control');
    expect(html).toContain('Extension Bridge');
    expect(html).toContain('Retry Outbound');
    expect(html).toContain('Download Extension');
    expect(html).toContain('conduit://run?payload=');
    expect(html).toContain('Report Bug');
    expect(html).toContain('diagnosticsView');
    const script = await fetchText(`${app.url}/app.js`);
    expect(script).toContain('initialView');
    expect(script).toContain("location.hash");
    expect(script).toContain('/api/diagnostics');
    expect(script).toContain('Untrusted Conduit request');
    expect(script).toContain('Approve once runs under read-only local policy');
    expect(script).toContain('Declared permissions');

    const status = await fetchJson(`${app.url}/api/status`);
    expect(status).toMatchObject({
      status: 'ok',
      mode: 'Compliance',
      exactEnvelopeParsing: true,
      embeddedBlockParsing: false,
      capabilities: {
        agentHandshake: true,
        conduitUrlOpen: true,
        approvals: true
      }
    });
  });

  it('serves a redacted diagnostic bundle for bug reports', async () => {
    const session = await createSession({
      label: 'Diagnostics',
      permissionProfile: 'read-only',
      allowedRoots: [projectRoot],
      transport: 'clipboard'
    });
    await createApprovalRequest({
      action: {
        id: 'write_notes',
        tool: 'file.write',
        args: {
          path: 'notes.txt',
          content: 'do not include this file content',
          nonce: 'call_should_not_leak'
        },
        reason: 'Persist notes.',
        risk: 'high'
      },
      policyReason: 'Tool requires confirmation: file.write',
      prompt: 'Allow?'
    });

    const diagnostics = await fetchJson(`${app.url}/api/diagnostics`);
    expect(diagnostics.bundle).toMatchObject({
      schema: 'conduit.diagnostic-bundle.v1',
      app: {
        version: '0.0.1'
      },
      state: {
        redaction: {
          excludesClipboardContents: true,
          excludesRequestPayloads: true,
          excludesSessionNonces: true,
          excludesApiKeys: true
        }
      }
    });
    expect(diagnostics.bundle.sessions[0]).toMatchObject({
      sessionId: session.sessionId,
      hasCurrentNonce: true
    });
    expect(JSON.stringify(diagnostics.bundle)).not.toContain(session.currentNonce);
    expect(JSON.stringify(diagnostics.bundle)).not.toContain('do not include this file content');
    expect(JSON.stringify(diagnostics.bundle)).not.toContain('call_should_not_leak');
  });

  it('creates and revokes sessions through the API', async () => {
    const created = await fetchJson(`${app.url}/api/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        label: 'App test',
        root: projectRoot,
        profile: 'read-only'
      })
    });

    expect(created.session.label).toBe('App test');
    expect(created.starterEnvelope.schema).toBe('conduit.request.v1');
    expect(created.starterEnvelope.list).toBe('.');

    const listed = await fetchJson(`${app.url}/api/sessions`);
    expect(listed.sessions).toHaveLength(1);

    const revoked = await fetchJson(`${app.url}/api/sessions/${created.session.sessionId}/revoke`, {
      method: 'POST'
    });
    expect(revoked.session.state).toBe('revoked');
  });

  it('checks clipboard once through the API', async () => {
    const session = await createSession({
      label: 'Clipboard',
      permissionProfile: 'read-only',
      allowedRoots: [projectRoot],
      transport: 'clipboard'
    });
    clipboard.text = [
      '```conduit',
      JSON.stringify({
        schema: 'conduit.request.v1',
        source: { kind: 'clipboard', trust: 'untrusted' },
        permissions: [],
        sessionId: session.sessionId,
        nonce: session.currentNonce,
        actions: [
          { id: 'read', tool: 'file.read', args: { path: 'README.md' } }
        ]
      }),
      '```'
    ].join('\n');

    const checked = await fetchJson(`${app.url}/api/clipboard/check`, { method: 'POST' });
    expect(checked.status).toBe('executed');
    expect(clipboard.text).toContain('CONDUIT_RESULTS_JSON');
    expect(clipboard.text).toContain('hello app');

    const runs = await fetchJson(`${app.url}/api/runs`);
    expect(runs.runs.length).toBeGreaterThan(0);
  });

  it('accepts conduit:// request URLs through the API', async () => {
    const session = await createSession({
      label: 'URL',
      permissionProfile: 'read-only',
      allowedRoots: [projectRoot],
      transport: 'api'
    });
    const conduitUrl = createConduitUrl(JSON.stringify({
      schema: 'conduit.request.v1',
      source: { kind: 'conduit-link', trust: 'untrusted' },
      permissions: [],
      sessionId: session.sessionId,
      nonce: session.currentNonce,
      actions: [
        { id: 'read', tool: 'file.read', args: { path: 'README.md' } }
      ]
    }));

    const opened = await fetchJson(`${app.url}/api/url/open`, {
      method: 'POST',
      body: JSON.stringify({ url: conduitUrl })
    });

    expect(opened.command).toBe('run');
    expect(opened.execution).toMatchObject({
      status: 'executed',
      sessionId: session.sessionId
    });
    expect(opened.execution.rendered).toContain('hello app');
  });

  it('lists and resolves pending approval requests through the API', async () => {
    const approval = await createApprovalRequest({
      action: {
        id: 'write_notes',
        tool: 'file.write',
        args: { path: 'notes.txt', content: 'hello' },
        reason: 'Persist notes.',
        risk: 'high'
      },
      policyReason: 'Tool requires confirmation: file.write',
      prompt: 'Allow?'
    });

    const listed = await fetchJson(`${app.url}/api/approvals`);
    expect(listed.approvals[0]).toMatchObject({
      approvalId: approval.approvalId,
      status: 'pending',
      action: {
        tool: 'file.write'
      }
    });

    const approved = await fetchJson(`${app.url}/api/approvals/${approval.approvalId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Approved in test.' })
    });
    expect(approved.approval).toMatchObject({
      approvalId: approval.approvalId,
      status: 'approved',
      decidedBy: 'control-app',
      decisionReason: 'Approved in test.'
    });
  });

  it('executes an approved untrusted review once through the API', async () => {
    const approval = await createApprovalRequest({
      action: {
        id: 'review_untrusted_request',
        tool: 'conduit.review',
        args: {
          source: { kind: 'clipboard', trust: 'untrusted' },
          permissions: [],
          actions: [
            { id: 'read', tool: 'file.read', args: { path: 'README.md' } }
          ],
          noncePresent: false
        },
        reason: 'Review untrusted Conduit request before execution.',
        risk: 'high'
      },
      policyReason: 'Request is not attached to a trusted session.',
      prompt: 'Review?',
      projectRoot
    });

    const approved = await fetchJson(`${app.url}/api/approvals/${approval.approvalId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Approved once in test.' })
    });
    expect(approved.approval).toMatchObject({
      approvalId: approval.approvalId,
      status: 'approved',
      executionStatus: 'ran'
    });
    expect(approved.approval.executionRunId).toBeTruthy();
    expect(approved.execution).toMatchObject({
      status: 'executed',
      approvalId: approval.approvalId
    });
    expect(approved.execution.rendered).toContain('CONDUIT_RESULTS_JSON');
    expect(approved.execution.rendered).toContain('hello app');
    expect(approved.copiedToClipboard).toBe(true);
    expect(clipboard.text).toBe(approved.execution.rendered);
    expect(clipboard.text).toContain('CONDUIT_RESULTS_JSON');
    expect(clipboard.text).toContain('hello app');

    const runs = await fetchJson(`${app.url}/api/runs`);
    expect(runs.runs[0]).toMatchObject({
      runId: approved.execution.runId,
      mode: 'approved-review',
      approvalId: approval.approvalId,
      status: 'request'
    });
    await expect(readFile(path.join(approved.execution.runDir, 'policy-decisions.jsonl'), 'utf8'))
      .resolves.toContain('"decision":"allow"');

    const approvedAgain = await fetchJson(`${app.url}/api/approvals/${approval.approvalId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Approve again.' })
    });
    expect(approvedAgain.approval).toMatchObject({
      approvalId: approval.approvalId,
      status: 'approved',
      executionStatus: 'ran',
      executionRunId: approved.execution.runId
    });
    expect(approvedAgain.execution).toBeUndefined();
  });

  it('keeps approved untrusted reviews read-only', async () => {
    const approval = await createApprovalRequest({
      action: {
        id: 'review_untrusted_request',
        tool: 'conduit.review',
        args: {
          source: { kind: 'clipboard', trust: 'untrusted' },
          permissions: [{ kind: 'filesystem', scope: 'project', access: 'write' }],
          actions: [
            { id: 'write', tool: 'file.write', args: { path: 'notes.txt', content: 'nope\n', mode: 'create' } }
          ],
          noncePresent: false
        },
        reason: 'Review untrusted Conduit request before execution.',
        risk: 'high'
      },
      policyReason: 'Request is not attached to a trusted session.',
      prompt: 'Review?',
      projectRoot
    });

    const approved = await fetchJson(`${app.url}/api/approvals/${approval.approvalId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Approved once in test.' })
    });
    expect(approved.execution).toMatchObject({
      status: 'executed',
      approvalId: approval.approvalId
    });
    expect(approved.execution.rendered).toContain('"status": "denied"');
    expect(approved.execution.rendered).toContain('Tool denied by read-only profile: file.write');
    expect(approved.approval).toMatchObject({
      executionStatus: 'ran',
      executionRunId: approved.execution.runId
    });
    await expect(readFile(path.join(projectRoot, 'notes.txt'), 'utf8')).rejects.toThrow();
  });

  it('creates and copies an agent-loop handshake through the API', async () => {
    const created = await fetchJson(`${app.url}/api/agent-handshake`, {
      method: 'POST',
      body: JSON.stringify({
        label: 'ChatGPT handshake',
        root: projectRoot,
        profile: 'read-only',
        transport: 'extension',
        docsUrl: 'https://example.test/conduit-api'
      })
    });

    expect(created.copied).toBe(true);
    expect(created.session.label).toBe('ChatGPT handshake');
    expect(created.session.transport).toBe('extension');
    expect(created.handshake).toContain('Conduit agent-loop handshake');
    expect(created.handshake).toContain('conduit.handshake.v1');
    expect(created.handshake).toContain('https://example.test/conduit-api');
    expect(created.handshake).toContain(created.session.sessionId);
    expect(created.handshake).toContain(created.session.currentNonce);
    expect(clipboard.text).toBe(created.handshake);

    const listed = await fetchJson(`${app.url}/api/sessions`);
    expect(listed.sessions.some((session: any) => session.sessionId === created.session.sessionId)).toBe(true);
  });

  it('returns the handshake for manual copy when no system clipboard is available', async () => {
    clipboard.failWrites = true;
    const created = await fetchJson(`${app.url}/api/agent-handshake`, {
      method: 'POST',
      body: JSON.stringify({ label: 'No clipboard', root: projectRoot })
    });
    expect(created.copied).toBe(false);
    expect(created.clipboardError).toContain('no clipboard');
    expect(created.handshake).toContain(created.session.sessionId);
  });

  it('ships a clearly labelled demo data mode that never calls the local API', async () => {
    const html = await fetchText(`${app.url}/`);
    expect(html).toContain('Demo data');
    expect(html).toContain('Nothing on this page reads or changes your machine');
    expect(html).toContain('prefers-color-scheme: dark');
    const script = await fetchText(`${app.url}/app.js`);
    expect(script).toContain("new URLSearchParams(location.search).has('demo')");
    expect(script).toContain('if (DEMO) return demoApi(path, options);');
    expect(script).toContain('demo mode does not read your clipboard');
  });

  it('refuses cross-origin and DNS-rebinding requests to the local API', async () => {
    const pending = await createApprovalRequest({
      action: { id: 'write_notes', tool: 'file.write', args: { path: 'notes.txt', content: 'x' }, reason: 'Persist notes.', risk: 'high' },
      policyReason: 'Tool requires confirmation: file.write',
      prompt: 'Allow?'
    });

    const crossOrigin = await fetch(`${app.url}/api/approvals/${pending.approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
      body: '{}'
    });
    expect(crossOrigin.status).toBe(403);

    const crossSite = await fetch(`${app.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ label: 'csrf', root: projectRoot, profile: 'shell-manual' })
    });
    expect(crossSite.status).toBe(403);

    const listed = await fetchJson(`${app.url}/api/approvals`);
    expect(listed.approvals.find((approval: any) => approval.approvalId === pending.approvalId).status).toBe('pending');

    const rebound = await rawRequest(app.url, '/api/status', 'conduit.attacker.example:47831');
    expect(rebound.status).toBe(403);

    const sameOrigin = await fetch(`${app.url}/api/approvals/${pending.approvalId}/deny`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: app.url },
      body: JSON.stringify({ reason: 'same-origin UI' })
    });
    expect(sameOrigin.status).toBe(200);
  });

  it('refuses to bind the control panel to a non-loopback host', async () => {
    await expect(startControlPanel({ host: '0.0.0.0', port: 0, clipboard })).rejects.toThrow(/non-loopback/);
  });
});

class FakeClipboard implements ClipboardIO {
  failWrites = false;

  constructor(public text: string) {}

  async read(): Promise<string> {
    return this.text;
  }

  async write(text: string): Promise<void> {
    if (this.failWrites) throw new Error('no clipboard on this host');
    this.text = text;
  }
}

function rawRequest(baseUrl: string, requestPath: string, host: string): Promise<{ status: number }> {
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

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }
  return data;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.text();
}
