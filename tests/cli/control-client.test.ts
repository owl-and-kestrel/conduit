import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startControlPanel, type ControlPanelHandle } from '../../src/app/control-panel.js';
import { createApprovalRequest, getApprovalRequest } from '../../src/approvals/approval-store.js';
import { CONTROL_CLI_ROUTES, ControlApiError, ControlClient, resolveControlUrl } from '../../src/cli/control-client.js';
import type { ClipboardIO } from '../../src/daemon/clipboard-io.js';
import { createSession, getSession } from '../../src/sessions/session-store.js';
import { getPauseState } from '../../src/state/pause-state.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli/index.ts');
const tsxPath = path.resolve('node_modules/.bin/tsx');

describe('CLI / API parity for pause and approvals (S1/S2)', () => {
  let tempRoot: string;
  let stateRoot: string;
  let projectRoot: string;
  let app: ControlPanelHandle;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-cli-parity-'));
    stateRoot = path.join(tempRoot, 'state');
    projectRoot = path.join(tempRoot, 'project');
    process.env.CONDUIT_STATE_DIR = stateRoot;
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'README.md'), 'hello cli\n', 'utf8');
    app = await startControlPanel({ host: '127.0.0.1', port: 0, clipboard: new MemoryClipboard() });
  });

  afterEach(async () => {
    await app.close();
    delete process.env.CONDUIT_STATE_DIR;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('sends exactly the panel endpoint for every CLI verb', async () => {
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
      });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const client = new ControlClient({ url: 'http://127.0.0.1:47831', fetchImpl });

    await client.status();
    await client.pause({ reason: 'r' });
    await client.resume();
    await client.stopAll();
    await client.pause({ sessionId: 'sess_1' });
    await client.resume({ sessionId: 'sess_1' });
    await client.listApprovals();
    await client.showApproval('approval_1');
    await client.decideApproval('approval_1', 'approve', 'ok');
    await client.decideApproval('approval_1', 'deny');
    await client.listRuns();
    await client.runResult('run_1');
    await client.appStatus();
    await client.diagnostics();
    await client.agentHandshake({ label: 'L' });
    await client.openConduitUrl('conduit://run?payload=x');

    const expected = Object.values(CONTROL_CLI_ROUTES).map((route) => ({
      method: route.method,
      path: route.path.replace(':id', route.path.includes('/sessions/') ? 'sess_1' : route.path.includes('/runs/') ? 'run_1' : 'approval_1')
    }));
    expect(calls.map(({ method, path: callPath }) => ({ method, path: callPath }))).toEqual(expected);
    expect(calls[1].body).toEqual({ by: 'cli', reason: 'r' });
    expect(calls[8].body).toEqual({ decidedBy: 'cli', reason: 'ok' });
    expect(calls[9].body).toEqual({ decidedBy: 'cli' });
    expect(calls[14].body).toEqual({ label: 'L', copy: false });
    expect(calls[15].body).toEqual({ url: 'conduit://run?payload=x' });
  });

  it('gets the same answers as the API and records CLI decisions as cli', async () => {
    const client = new ControlClient({ url: app.url });
    const approval = await createApprovalRequest({
      action: { id: 'write', tool: 'file.write', args: { path: 'notes.txt', content: 'x' }, reason: 'Persist.', risk: 'high' },
      policyReason: 'Tool requires confirmation: file.write',
      prompt: 'Allow?'
    });

    expect(await client.listApprovals()).toEqual(await (await fetch(`${app.url}/api/approvals`)).json());
    expect(await client.showApproval(approval.approvalId))
      .toEqual(await (await fetch(`${app.url}/api/approvals/${approval.approvalId}`)).json());

    const decided = await client.decideApproval(approval.approvalId, 'approve', 'from cli');
    expect(decided.approval).toMatchObject({ status: 'approved', decidedBy: 'cli', decisionReason: 'from cli' });

    // A second, contradictory decision is a 409 for the CLI exactly as for the panel.
    await expect(client.decideApproval(approval.approvalId, 'deny')).rejects.toMatchObject({ status: 409 });

    const paused = await client.pause({ reason: 'from cli' });
    expect(paused.control).toMatchObject({ paused: true, pause: { pausedBy: 'cli', reason: 'from cli' } });
    expect(await client.status()).toEqual(await (await fetch(`${app.url}/api/control`)).json());
    await client.resume();
    expect((await getPauseState()).paused).toBe(false);
  });

  it('refuses to talk to a non-loopback Control URL', () => {
    expect(() => resolveControlUrl('http://example.com:47831')).toThrow(/loopback/);
    expect(() => resolveControlUrl('https://127.0.0.1:47831')).toThrow(/loopback/);
    expect(resolveControlUrl('http://127.0.0.1:1234/ignored')).toBe('http://127.0.0.1:1234');
  });

  it('surfaces API refusals as ControlApiError', async () => {
    const client = new ControlClient({ url: app.url });
    const error = await client.showApproval('approval_missing').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControlApiError);
    expect((error as ControlApiError).status).toBe(404);
  });

  it('refuses a traversal run id, and the CLI reports the refusal cleanly', async () => {
    await mkdir(path.join(stateRoot, 'secret'), { recursive: true });
    await writeFile(path.join(stateRoot, 'secret', 'result.txt'), 'TOP SECRET', 'utf8');
    const client = new ControlClient({ url: app.url });
    const error = await client.runResult('../secret').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControlApiError);
    expect((error as ControlApiError).status).toBe(400);

    const failed = await runCli(['runs', 'result', '../secret', '--url', app.url], stateRoot).then(
      () => null,
      (caught: { code?: number; stdout?: string; stderr?: string }) => caught
    );
    expect(failed?.code).toBe(1);
    expect(failed?.stderr).toContain('conduit: Invalid run id.');
    expect(`${failed?.stdout ?? ''}${failed?.stderr ?? ''}`).not.toContain('TOP SECRET');
  }, 60_000);

  it('drives approvals and pause through the public CLI against a running Control', async () => {
    const approval = await createApprovalRequest({
      action: { id: 'write', tool: 'file.write', args: { path: 'notes.txt', content: 'x' }, reason: 'Persist.', risk: 'high' },
      policyReason: 'Tool requires confirmation: file.write',
      prompt: 'Allow?'
    });
    const session = await createSession({ label: 'Chat', permissionProfile: 'read-only', allowedRoots: [projectRoot] });

    const listed = await runCli(['approvals', 'list', '--url', app.url], stateRoot);
    expect(listed.stdout).toContain(approval.approvalId);
    expect(listed.stdout).toContain('pending  file.write');

    const denied = await runCli(['approvals', 'deny', approval.approvalId, '--reason', 'not now', '--url', app.url], stateRoot);
    expect(denied.stdout).toContain('denied');
    expect(await getApprovalRequest(approval.approvalId)).toMatchObject({ status: 'denied', decidedBy: 'cli', decisionReason: 'not now' });

    await runCli(['pause', '--session', session.sessionId, '--url', app.url], stateRoot);
    expect((await getSession(session.sessionId))?.state).toBe('paused');

    const status = await runCli(['status', '--url', app.url], stateRoot);
    expect(status.stdout).toContain('Conduit: running (not paused)');
    expect(status.stdout).toContain(`${session.sessionId} (Chat)`);

    await runCli(['resume', '--session', session.sessionId, '--url', app.url], stateRoot);
    expect((await getSession(session.sessionId))?.state).toBe('active');
  }, 60_000);

  it('pauses and resumes with --local when Control is not running, and fails clearly without it', async () => {
    const unreachable = 'http://127.0.0.1:9';
    const failed = await runCli(['pause', '--url', unreachable], stateRoot).then(
      () => null,
      (error: { code?: number; stderr?: string }) => error
    );
    expect(failed?.code).toBe(1);
    expect(failed?.stderr).toContain('Conduit Control is not reachable');
    expect((await getPauseState()).paused).toBe(false);

    const paused = await runCli(['pause', '--local', '--reason', 'kill switch'], stateRoot);
    expect(paused.stdout).toContain('Conduit: PAUSED');
    expect(paused.stdout).toContain('kill switch');
    expect(await getPauseState()).toMatchObject({ paused: true, pausedBy: 'cli' });

    const status = await runCli(['status', '--local', '--json'], stateRoot);
    expect(JSON.parse(status.stdout).control.paused).toBe(true);

    await runCli(['resume', '--local'], stateRoot);
    expect((await getPauseState()).paused).toBe(false);
  }, 60_000);
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

async function runCli(args: string[], stateRoot: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(tsxPath, [cliPath, ...args], {
    cwd: path.resolve('.'),
    env: { ...withoutControlUrl(process.env), CONDUIT_STATE_DIR: stateRoot },
    timeout: 20_000,
    maxBuffer: 1024 * 1024
  });
}

function withoutControlUrl(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { CONDUIT_CONTROL_URL: _ignored, ...rest } = env;
  return rest;
}
