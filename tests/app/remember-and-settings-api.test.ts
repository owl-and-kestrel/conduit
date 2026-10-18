import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderAppJs, startControlPanel, type ControlPanelHandle } from '../../src/app/control-panel.js';
import { createApprovalRequest, getApprovalRequest } from '../../src/approvals/approval-store.js';
import type { ClipboardIO } from '../../src/daemon/clipboard-io.js';
import { ControlClient } from '../../src/cli/control-client.js';
import { createSession, revokeSession } from '../../src/sessions/session-store.js';
import { getSettings } from '../../src/state/settings.js';

describe('Allow for this chat and settings through Conduit Control', () => {
  let tempRoot: string;
  let projectRoot: string;
  let app: ControlPanelHandle;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-remember-api-'));
    projectRoot = path.join(tempRoot, 'project');
    process.env.CONDUIT_STATE_DIR = path.join(tempRoot, 'state');
    await mkdir(projectRoot, { recursive: true });
    app = await startControlPanel({ host: '127.0.0.1', port: 0, clipboard: new MemoryClipboard() });
  });

  afterEach(async () => {
    await app.close();
    delete process.env.CONDUIT_STATE_DIR;
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function shellAsk(sessionId?: string) {
    return createApprovalRequest({
      action: { id: 'sh', tool: 'shell.run', args: { command: 'npm test' }, reason: 'Run tests.' },
      policyReason: 'Tool requires confirmation: shell.run',
      prompt: 'Allow?',
      ...(sessionId ? { sessionId } : {})
    });
  }

  it('records remember=session on an approval from a live chat (API and CLI)', async () => {
    const session = await createSession({ label: 'Chat', permissionProfile: 'shell-manual', allowedRoots: [projectRoot] });
    const ask = await shellAsk(session.sessionId);
    const decided = await post(`/api/approvals/${ask.approvalId}/approve`, { remember: 'session' });
    expect(decided.status).toBe(200);
    expect(decided.body.approval).toMatchObject({ status: 'approved', remember: 'session' });

    // The CLI flag is the same call.
    const viaCli = await shellAsk(session.sessionId);
    const result = await new ControlClient({ url: app.url }).decideApproval(viaCli.approvalId, 'approve', undefined, { forThisChat: true });
    expect(result.approval).toMatchObject({ status: 'approved', remember: 'session', decidedBy: 'cli' });

    // A plain approve is never remembered.
    const once = await shellAsk(session.sessionId);
    expect((await post(`/api/approvals/${once.approvalId}/approve`, {})).body.approval.remember).toBeUndefined();
  });

  it('refuses to remember anything that is not an exact action from a live chat, deciding nothing', async () => {
    const session = await createSession({ label: 'Chat', permissionProfile: 'shell-manual', allowedRoots: [projectRoot] });
    const cases: Array<[string, Promise<{ approvalId: string }>, unknown]> = [
      ['no chat', shellAsk(), 'session'],
      ['untrusted review', createApprovalRequest({
        action: { id: 'review', tool: 'conduit.review', args: { actions: [] }, reason: 'Review.' },
        policyReason: 'Request is not attached to a trusted session.',
        prompt: 'Review?',
        sessionId: session.sessionId
      }), 'session'],
      ['patch', createApprovalRequest({
        action: { id: 'p', tool: 'file.patch', args: { patch: 'diff --git a/a b/a' } },
        policyReason: 'Tool requires confirmation: file.patch',
        prompt: 'Allow?',
        sessionId: session.sessionId
      }), 'session'],
      ['unknown scope', shellAsk(session.sessionId), 'forever']
    ];
    for (const [label, created, remember] of cases) {
      const ask = await created;
      const response = await post(`/api/approvals/${ask.approvalId}/approve`, { remember });
      expect(response.status, label).toBe(400);
      expect((await getApprovalRequest(ask.approvalId))?.status, label).toBe('pending');
    }

    const deny = await shellAsk(session.sessionId);
    expect((await post(`/api/approvals/${deny.approvalId}/deny`, { remember: 'session' })).status).toBe(400);

    const revokedAsk = await shellAsk(session.sessionId);
    await revokeSession(session.sessionId);
    const revoked = await post(`/api/approvals/${revokedAsk.approvalId}/approve`, { remember: 'session' });
    expect(revoked.status).toBe(400);
    expect(revoked.body.error).toContain('not from a live chat');
    expect((await getApprovalRequest(revokedAsk.approvalId))?.status).toBe('pending');
  });

  it('reads and writes the Return setting (default off) through the API and the CLI client', async () => {
    expect((await get('/api/settings')).settings).toEqual({ returnApprovesShellWithoutDetails: false });

    const on = await post('/api/settings', { returnApprovesShellWithoutDetails: true });
    expect(on.status).toBe(200);
    expect(on.body.settings.returnApprovesShellWithoutDetails).toBe(true);
    expect((await getSettings()).returnApprovesShellWithoutDetails).toBe(true);

    const cli = new ControlClient({ url: app.url });
    expect((await cli.updateSettings({ returnApprovesShellWithoutDetails: false })).settings.returnApprovesShellWithoutDetails).toBe(false);
    expect((await cli.settings()).settings.returnApprovesShellWithoutDetails).toBe(false);

    expect((await post('/api/settings', { returnApprovesShellWithoutDetails: 'yes' })).status).toBe(400);
    expect((await post('/api/settings', { somethingElse: true })).status).toBe(400);
    expect((await post('/api/settings', {})).status).toBe(400);
    expect((await getSettings()).returnApprovesShellWithoutDetails).toBe(false);
    expect((await get('/api/status')).capabilities).toMatchObject({ settings: true, rememberForThisChat: true });
  });

  it('refuses a cross-site settings change', async () => {
    const response = await fetch(`${app.url}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ returnApprovesShellWithoutDetails: true })
    });
    expect(response.status).toBe(403);
    expect((await getSettings()).returnApprovesShellWithoutDetails).toBe(false);
  });

  async function get(route: string): Promise<any> {
    const response = await fetch(`${app.url}${route}`);
    expect(response.ok).toBe(true);
    return response.json();
  }

  async function post(route: string, body: unknown): Promise<{ status: number; body: any }> {
    const response = await fetch(`${app.url}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  }
});

/**
 * Return on a shell command in the web panel (Jon 2026-10-18). The decision is
 * the panel's own returnKeyAction, evaluated from the served script.
 */
describe('web panel Return key on shell commands', () => {
  function panelFunction(name: string): (input: any) => any {
    const script = renderAppJs();
    const start = script.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    const end = script.indexOf('\n}\n', start);
    return new Function(`${script.slice(start, end + 2)}; return ${name};`)() as (input: any) => any;
  }

  it('closed details expand, open details approve, and the bypass setting approves', () => {
    const returnKeyAction = panelFunction('returnKeyAction');
    expect(returnKeyAction({ tool: 'shell.run', detailsOpen: false, bypass: false })).toBe('expand');
    expect(returnKeyAction({ tool: 'shell.run', detailsOpen: true, bypass: false })).toBe('approve');
    expect(returnKeyAction({ tool: 'shell.run', detailsOpen: false, bypass: true })).toBe('approve');
    expect(returnKeyAction({ tool: 'file.write', detailsOpen: false, bypass: false })).toBe('approve');
  });

  it('wires the gate to Enter on approve buttons, before the click, and offers the setting and Allow for this chat', () => {
    const script = renderAppJs();
    expect(script).toMatch(/addEventListener\('keydown', \(event\) => \{\s+if \(event\.key !== 'Enter'/);
    const start = script.indexOf("document.addEventListener('keydown'");
    const handler = script.slice(start, script.indexOf('\n}, ', start) + 10);
    expect(handler).toContain("closest('[data-approve]')");
    expect(handler).toContain('event.preventDefault();');
    // Capture phase, so it runs before anything else can act on the key.
    expect(handler.endsWith('\n}, true);')).toBe(true);
    expect(script).toContain("'Allow for this chat'".slice(1, -1));
    expect(script).toContain("api('/api/settings', {");
  });
});

class MemoryClipboard implements ClipboardIO {
  text = '';
  async read(): Promise<string> {
    return this.text;
  }
  async write(text: string): Promise<void> {
    this.text = text;
  }
}
