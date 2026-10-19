import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeApprovedReview, executeRequestFromUnknown } from '../../src/daemon/execute-request.js';
import {
  createApprovalRequest,
  listApprovalRequests,
  resolveApprovalRequest
} from '../../src/approvals/approval-store.js';
import { isDemoProfileEnabled } from '../../src/runtime/demo-profile.js';
import { buildServiceEnv } from '../../src/runtime/service-registry.js';
import { evaluateActionPolicy } from '../../src/policy/policy-engine.js';
import { startControlPanel, type ControlPanelHandle } from '../../src/app/control-panel.js';
import { isPermissionProfileName } from '../../src/sessions/profiles.js';
import type { ConduitSession } from '../../src/sessions/session-store.js';
import { getTool, listTools } from '../../src/tools/registry.js';
import type { ClipboardIO } from '../../src/daemon/clipboard-io.js';

// The tool list of today, with the demo switch off.
const TOOLS_OFF = [
  'file.read',
  'file.list',
  'git.status',
  'git.diff',
  'conduit.about',
  'conduit.help',
  'conduit.extension.prepareAlphaInstall',
  'file.write',
  'file.patch',
  'shell.run'
];

// No real services are started here: the service tests live in
// tests/runtime/service-start.test.ts.
describe('demo profile (CONDUIT_DEMO_PROFILE)', () => {
  let tempRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-demo-profile-'));
    projectRoot = path.join(tempRoot, 'project');
    await mkdir(projectRoot, { recursive: true });
    process.env.CONDUIT_STATE_DIR = path.join(tempRoot, 'state');
    delete process.env.CONDUIT_DEMO_PROFILE;
    await writeFile(path.join(projectRoot, 'README.md'), 'hello demo\n', 'utf8');
  });

  afterEach(async () => {
    delete process.env.CONDUIT_DEMO_PROFILE;
    delete process.env.CONDUIT_STATE_DIR;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('is enabled only for exactly "1"', () => {
    for (const [value, expected] of [
      ['1', true],
      [undefined, false],
      ['', false],
      ['0', false],
      ['true', false],
      ['yes', false],
      [' 1', false]
    ] as Array<[string | undefined, boolean]>) {
      if (value === undefined) {
        delete process.env.CONDUIT_DEMO_PROFILE;
      } else {
        process.env.CONDUIT_DEMO_PROFILE = value;
      }
      expect(isDemoProfileEnabled(), `CONDUIT_DEMO_PROFILE=${JSON.stringify(value)}`).toBe(expected);
    }
    delete process.env.CONDUIT_DEMO_PROFILE;
  });

  describe('tool registry', () => {
    it('off: service.start is an unknown tool and the tool list is unchanged', () => {
      delete process.env.CONDUIT_DEMO_PROFILE;
      expect(getTool('service.start')).toBeNull();
      expect(listTools().map((tool) => tool.name)).toEqual(TOOLS_OFF);
    });

    it('on: service.start is registered last', () => {
      process.env.CONDUIT_DEMO_PROFILE = '1';
      expect(listTools().map((tool) => tool.name)).toEqual([...TOOLS_OFF, 'service.start']);
      expect(getTool('service.start')?.name).toBe('service.start');
      delete process.env.CONDUIT_DEMO_PROFILE;
    });
  });

  it('isPermissionProfileName never accepts demo-review', () => {
    expect(isPermissionProfileName('demo-review')).toBe(false);
    process.env.CONDUIT_DEMO_PROFILE = '1';
    expect(isPermissionProfileName('demo-review')).toBe(false);
    delete process.env.CONDUIT_DEMO_PROFILE;
    expect(isPermissionProfileName('read-only')).toBe(true);
  });

  it('policy denies demo-review actions while the switch is off', async () => {
    const policySession: ConduitSession = {
      sessionId: 'sess_demo_test',
      label: 'Demo policy test',
      createdAt: new Date().toISOString(),
      state: 'active',
      transport: 'api',
      permissionProfile: 'demo-review',
      allowedRoots: [projectRoot],
      currentNonce: 'n_demo',
      usedNonces: []
    };
    const decision = await evaluateActionPolicy({
      action: { id: 'a', tool: 'shell.run', args: { command: 'echo hi' } },
      session: policySession
    });
    expect(decision).toEqual({
      decision: 'deny',
      reason: 'The demo profile is off (CONDUIT_DEMO_PROFILE is not 1).'
    });
  });

  it('on: no live-session profile can use service.start; only the approved-review profile has it', async () => {
    process.env.CONDUIT_DEMO_PROFILE = '1';
    for (const profile of ['read-only', 'edit-with-confirmation', 'shell-manual'] as const) {
      const decision = await evaluateActionPolicy({
        action: { id: 'svc', tool: 'service.start', args: { name: 'tiny', path: 'server.mjs' } },
        session: {
          sessionId: `sess_${profile}`,
          label: profile,
          createdAt: new Date().toISOString(),
          state: 'active',
          transport: 'extension',
          permissionProfile: profile,
          allowedRoots: [projectRoot],
          currentNonce: 'n',
          usedNonces: []
        }
      });
      expect(decision).toEqual({ decision: 'deny', reason: `Tool is not in ${profile} profile: service.start` });
    }
    delete process.env.CONDUIT_DEMO_PROFILE;
  });

  // See tests/runtime/pause.test.ts (approved untrusted review) for the same
  // shape: a conduit.review approval created directly, resolved approved, then
  // executed.
  function reviewRequest(actions: Array<Record<string, unknown>>) {
    return {
      action: {
        id: 'review_untrusted_request',
        tool: 'conduit.review',
        args: { actions },
        reason: 'Review.',
        risk: 'high' as const
      },
      policyReason: 'Request is not attached to a trusted session.',
      prompt: 'Review?',
      projectRoot
    };
  }

  it('off: an approved review runs read-only only, and its metadata has no profile key', async () => {
    delete process.env.CONDUIT_DEMO_PROFILE;
    const approval = await createApprovalRequest(reviewRequest([
      { id: 'run', tool: 'shell.run', args: { command: 'echo demo-off' } },
      { id: 'svc', tool: 'service.start', args: { name: 'tiny', path: 'server.mjs' } },
      { id: 'read', tool: 'file.read', args: { path: 'README.md' } }
    ]));
    const approved = await resolveApprovalRequest(approval.approvalId, 'approved', 'test', 'cli');
    const execution = await executeApprovedReview(approved, { yes: true });
    expect(execution.status).toBe('executed');
    const results = execution.results ?? [];
    expect(results.find((result) => result.id === 'run')).toMatchObject({
      status: 'denied',
      error: 'Tool denied by read-only profile: shell.run'
    });
    expect(results.find((result) => result.id === 'svc')).toMatchObject({
      status: 'denied',
      error: 'Unknown tool: service.start'
    });
    expect(results.find((result) => result.id === 'read')).toMatchObject({ status: 'ok' });
    const metadata = JSON.parse(await readFile(path.join(execution.runDir as string, 'metadata.json'), 'utf8')) as { profile?: string };
    expect(metadata.profile).toBeUndefined();
  });

  it('on: an approved review may run shell.run, still cannot write files, and records the profile', async () => {
    process.env.CONDUIT_DEMO_PROFILE = '1';
    const approval = await createApprovalRequest(reviewRequest([
      { id: 'run', tool: 'shell.run', args: { command: 'echo demo-on' } },
      { id: 'write', tool: 'file.write', args: { path: 'notes.txt', content: 'x\n', mode: 'create' } }
    ]));
    const approved = await resolveApprovalRequest(approval.approvalId, 'approved', 'test', 'cli');
    const execution = await executeApprovedReview(approved, { yes: true });
    expect(execution.status).toBe('executed');
    const results = execution.results ?? [];
    const run = results.find((result) => result.id === 'run');
    expect(run).toMatchObject({ status: 'ok' });
    expect(String(run?.content)).toContain('demo-on');
    expect(results.find((result) => result.id === 'write')).toMatchObject({
      status: 'denied',
      error: 'Tool denied by demo-review profile: file.write'
    });
    const metadata = JSON.parse(await readFile(path.join(execution.runDir as string, 'metadata.json'), 'utf8')) as { profile?: string };
    expect(metadata.profile).toBe('demo-review');
    delete process.env.CONDUIT_DEMO_PROFILE;
  });

  it('mentions the demo profile on the review prompt only while it is on', async () => {
    delete process.env.CONDUIT_DEMO_PROFILE;
    const opened = await executeRequestFromUnknown({
        schema: 'conduit.request.v1',
        source: { kind: 'web', trust: 'untrusted' },
        title: 'Readme review',
        actions: [{ id: 'read', tool: 'file.read', args: { path: 'README.md' } }]
      });
    expect(opened.status).toBe('requires_review');
    const off = (await listApprovalRequests()).find((record) => record.approvalId === opened.approvalId);
    expect(off?.prompt).not.toContain('Demo profile');
    await resolveApprovalRequest(off!.approvalId, 'denied', 'cleanup', 'cli');

    process.env.CONDUIT_DEMO_PROFILE = '1';
    const onOpened = await executeRequestFromUnknown({
        schema: 'conduit.request.v1',
        source: { kind: 'web', trust: 'untrusted' },
        title: 'Readme review',
        actions: [{ id: 'read2', tool: 'file.read', args: { path: 'README.md' } }]
      });
    expect(onOpened.status).toBe('requires_review');
    const on = (await listApprovalRequests()).find((record) => record.approvalId === onOpened.approvalId);
    expect(on?.prompt).toContain('Demo profile is on: approving lets these actions run programs on this computer.');
    await resolveApprovalRequest(on!.approvalId, 'denied', 'cleanup', 'cli');
    delete process.env.CONDUIT_DEMO_PROFILE;
  });

  it('buildServiceEnv is pure and sets PORT and HOST only', () => {
    expect(buildServiceEnv({ A: '1' }, { port: 5000, lan: false, serviceId: 'svc_x' })).toEqual({
      A: '1',
      PORT: '5000',
      HOST: '127.0.0.1',
      CONDUIT_SERVICE_ID: 'svc_x'
    });
    expect(buildServiceEnv({ A: '1' }, { port: 5000, lan: true, serviceId: 'svc_x' }).HOST).toBe('0.0.0.0');
  });

  describe('control API', () => {
    let app: ControlPanelHandle | undefined;

    class MemoryClipboard implements ClipboardIO {
      text = '';
      async read(): Promise<string> {
        return this.text;
      }
      async write(text: string): Promise<void> {
        this.text = text;
      }
    }

    afterEach(async () => {
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    it('off: services routes answer 404 and capabilities are unchanged', async () => {
      app = await startControlPanel({ host: '127.0.0.1', port: 0, clipboard: new MemoryClipboard() });

      const services = await fetch(`${app.url}/api/services`);
      expect(services.status).toBe(404);
      expect(await services.json()).toEqual({ error: 'Not found' });

      const stop = await fetch(`${app.url}/api/services/x/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      expect(stop.status).toBe(404);
      expect(await stop.json()).toEqual({ error: 'Not found' });

      // Exactly the capabilities Control reported before the demo profile existed.
      const status = await (await fetch(`${app.url}/api/status`)).json() as any;
      expect(status.capabilities).toEqual({
        agentHandshake: true,
        clipboardCheck: true,
        conduitUrlOpen: true,
        approvals: true,
        sessions: true,
        runs: true,
        pause: true,
        settings: true,
        rememberForThisChat: true
      });
    });

    it('on: services list is served and capabilities include services', async () => {
      process.env.CONDUIT_DEMO_PROFILE = '1';
      app = await startControlPanel({ host: '127.0.0.1', port: 0, clipboard: new MemoryClipboard() });

      const services = await fetch(`${app.url}/api/services`);
      expect(services.status).toBe(200);
      expect(await services.json()).toEqual({ services: [] });

      const status = await (await fetch(`${app.url}/api/status`)).json() as any;
      expect(status.capabilities.services).toBe(true);
    });

    it('on: a malformed percent escape in a service id is a 400, not a 500', async () => {
      process.env.CONDUIT_DEMO_PROFILE = '1';
      app = await startControlPanel({ host: '127.0.0.1', port: 0, clipboard: new MemoryClipboard() });

      const stop = await fetch(`${app.url}/api/services/%E0%A4%A/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      expect(stop.status).toBe(400);
      expect(await stop.json()).toEqual({ error: 'Invalid service id.' });

      // A well-formed id that names no service is still the 404 it was.
      const unknown = await fetch(`${app.url}/api/services/svc_none/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      expect(unknown.status).toBe(404);
    });
  });
});
