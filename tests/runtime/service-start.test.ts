import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createConduitUrl } from '../../src/protocol/conduit-url.js';

const execFileAsync = promisify(execFile);
const tsxBin = path.resolve('node_modules/.bin/tsx');
const cliEntry = path.resolve('src/cli/index.ts');

// Pids this test recorded (services, stand-in parents), so afterEach kills
// exactly what we started. See tests/cli/parent-watchdog.test.ts.
const recordedPids: number[] = [];
const recordedChildren: ChildProcess[] = [];

afterEach(() => {
  for (const pid of recordedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  recordedPids.length = 0;
  for (const child of recordedChildren) {
    if (child.exitCode === null && !child.signalCode) {
      child.kill('SIGKILL');
    }
  }
  recordedChildren.length = 0;
});

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error: any) {
    return error.code === 'ESRCH';
  }
  if (process.platform === 'linux') {
    // A zombie holds nothing and cannot be signalled any more.
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const state = close >= 0 ? stat.slice(close + 1).trim().split(/\s+/)[0] : '';
      return state === 'Z';
    } catch {
      return true;
    }
  }
  return false;
}

async function waitDead(pid: number, timeoutMs: number, message: string): Promise<void> {
  await waitUntil(() => isDead(pid), timeoutMs, message);
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

/** Live members of the service's process group (the service leads its own
 * group under supervision). */
function groupMembers(pgid: number): number[] {
  const members: number[] = [];
  if (process.platform === 'linux') {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) {
        continue;
      }
      const pid = Number(name);
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        if (close < 0) {
          continue;
        }
        const fields = stat.slice(close + 1).trim().split(/\s+/);
        // index 0 state (index 0 after the last `)`), index 2 pgrp.
        if (fields[0] === 'Z') {
          continue; // zombies hold no group membership
        }
        if (Number(fields[2]) === pgid) {
          members.push(pid);
        }
      } catch {
        // exited while listing
      }
    }
    return members;
  }
  const out = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' });
  for (const line of out.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) {
      continue;
    }
    const pid = Number(fields[0]);
    const pg = Number(fields[1]);
    const stat = fields[2] ?? '';
    if (!Number.isFinite(pid) || !Number.isFinite(pg) || stat.startsWith('Z')) {
      continue;
    }
    if (pg === pgid) {
      members.push(pid);
    }
  }
  return members;
}

/** True when nothing accepts the connection any more (the port refuses). */
function tcpRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (refused: boolean): void => {
      socket.destroy();
      resolve(refused);
    };
    socket.once('connect', () => done(false));
    socket.once('error', (error: NodeJS.ErrnoException) => done(error.code === 'ECONNREFUSED'));
  });
}

// Fixtures for the demo service tests (loopback only; never a LAN service in
// tests: CI hosts can have public IPs).
const SERVER_FIXTURE = [
  "import http from 'node:http';",
  "const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('tiny-ok ' + process.pid); });",
  "server.listen(Number(process.env.PORT), process.env.HOST, () => { console.log('CONDUIT_READY http://127.0.0.1:' + process.env.PORT); });",
  'setInterval(() => {}, 1 << 30);'
].join('\n') + '\n';

const QUIET_FIXTURE = [
  "import http from 'node:http';",
  "const server = http.createServer(() => {});",
  "server.listen(Number(process.env.PORT), process.env.HOST, () => { // never prints the ready line\n });",
  'setInterval(() => {}, 1 << 30);'
].join('\n') + '\n';

const CRASH_FIXTURE = 'process.exit(3);\n';

// A stand-in parent, like the watchdog test: the watchdog's own pid target.
function startStandInParent(): number {
  const parent = spawn('sleep', ['120'], { stdio: 'ignore' });
  recordedPids.push(parent.pid as number);
  expect(parent.pid).toBeGreaterThan(1);
  return parent.pid as number;
}

/** The Conduit Control process, supervised: it runs `conduit app start` from
 * `projectDir` (its cwd = the project root), with the demo switch on. */
function startSupervisedControl(projectDir: string, stateDir: string, parentPid: number, demo: boolean): ChildProcess {
  const { CONDUIT_DEMO_PROFILE: _inherited, ...baseEnv } = process.env;
  const child = spawn(tsxBin, [cliEntry, 'app', 'start', '--port', '0'], {
    cwd: projectDir,
    env: {
      ...baseEnv,
      CONDUIT_STATE_DIR: stateDir,
      CONDUIT_PARENT_PID: String(parentPid),
      // Off means absent, exactly as in a normal launch.
      ...(demo ? { CONDUIT_DEMO_PROFILE: '1' } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  // Drain stderr so watchdog logs cannot block the service.
  child.stderr?.resume();
  recordedChildren.push(child);
  return child;
}

function controlUrl(child: ChildProcess, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = child.stdout!;
    stream.setEncoding('utf8');
    const timer = setTimeout(() => reject(new Error('Conduit Control did not announce its URL in time')), timeoutMs);
    let buffered = '';
    const onData = (chunk: string): void => {
      buffered += chunk;
      const match = buffered.match(/Conduit app: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        stream.off('data', onData);
        stream.resume();
        resolve(match[1]!);
      }
    };
    stream.on('data', onData);
  });
}

function exitCodeWithin(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Conduit Control did not exit in time')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Untrusted review through the same API the web page uses; returns the full
 * approve response JSON (with `.execution.results`). */
async function approveServiceActions(url: string, actions: Array<Record<string, unknown>>): Promise<any> {
  const envelope = JSON.stringify({
    schema: 'conduit.request.v1',
    source: { kind: 'web', trust: 'untrusted' },
    title: 'Demo services',
    actions
  });
  const opened = await (await fetch(`${url}/api/url/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: createConduitUrl(envelope) })
  })).json() as any;
  expect(opened.execution?.status).toBe('requires_review');
  const approveResponse = await fetch(`${url}/api/approvals/${opened.execution.approvalId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decidedBy: 'cli' })
  });
  return approveResponse.json();
}

/** Stops this test's Control (its watchdog stops its services on SIGTERM)
 * and stand-in parent, and waits for Control to exit so the temp state dir
 * is no longer in use when it is removed. */
async function stopSupervisors(control?: ChildProcess, standIn?: number): Promise<void> {
  if (control && control.exitCode === null && !control.signalCode) {
    const exited = new Promise((resolve) => control.once('exit', resolve));
    control.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  }
  if (standIn) {
    try {
      process.kill(standIn, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

describe('service.start (demo profile, real processes, loopback only)', () => {
  it.skipIf(process.platform === 'win32')(
    'starts, serves, is listed, stops on Stop, and leaves zero processes',
    async () => {
      const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'conduit-service-start-'));
      const projectDir = path.join(tempRoot, 'project');
      const stateDir = path.join(tempRoot, 'state');
      mkdirSync(projectDir, { recursive: true });
      let control: ChildProcess | undefined;
      const standIn = startStandInParent();
      try {
        writeFileSync(path.join(projectDir, 'server.mjs'), SERVER_FIXTURE);
        control = startSupervisedControl(projectDir, stateDir, standIn, true);
        const url = await controlUrl(control);

        const approved = await approveServiceActions(url, [{ id: 'svc', tool: 'service.start', args: { name: 'tiny', path: 'server.mjs' } }]);
        const result = (approved.execution?.results ?? []).find((entry: any) => entry.id === 'svc');
        expect(result?.status).toBe('ok');
        expect(result?.content).toMatchObject({ state: 'ready', host: '127.0.0.1' });
        expect(typeof result?.content?.readyAt).toBe('string');
        const serviceId = result.content.serviceId as string;
        const pid = result.content.pid as number;
        expect(Number.isFinite(pid)).toBe(true);
        recordedPids.push(pid);
        const port = Number(result.content.port);

        // Served over loopback, by the pid the result names.
        const response = await fetch(result.content.url);
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body.startsWith('tiny-ok ')).toBe(true);
        expect(Number(body.slice('tiny-ok '.length))).toBe(pid);

        // The service leads its own process group under supervision.
        expect(groupMembers(pid)).toContain(pid);

        // Listed by the API...
        const list = await (await fetch(`${url}/api/services`)).json() as { services: any[] };
        expect(list.services.find((service) => service.serviceId === serviceId)).toMatchObject({
          state: 'ready',
          pid
        });

        // ...and by the CLI, which can also stop it.
        const cliList = await execFileAsync(tsxBin, [cliEntry, 'services', 'list', '--url', url, '--json'], { timeout: 60_000 });
        expect((JSON.parse(cliList.stdout) as { services: any[] }).services
          .some((service) => service.serviceId === serviceId)).toBe(true);
        const cliStop = await execFileAsync(tsxBin, [cliEntry, 'services', 'stop', serviceId, '--url', url, '--json'], { timeout: 60_000 });
        expect((JSON.parse(cliStop.stdout) as { service: any }).service.serviceId).toBe(serviceId);

        const after = await (await fetch(`${url}/api/services`)).json() as { services: any[] };
        const record = after.services.find((service) => service.serviceId === serviceId);
        expect(record.state).toBe('exited');
        expect(record.stoppedBy).toBe('person');

        // Zero processes left, and the port refuses connections again.
        await waitUntil(
          () => groupMembers(pid).length === 0,
          5000,
          'service group members are still alive after Stop'
        );
        expect(groupMembers(pid)).toEqual([]);
        await waitUntil(
          () => tcpRefused(port),
          5000,
          `port ${port} still accepted connections after Stop`
        );
      } finally {
        await stopSupervisors(control, standIn);
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    120_000
  );

  it.skipIf(process.platform === 'win32')(
    'stops the service tree and exits with code 0 on parent loss',
    async () => {
      const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'conduit-service-start-'));
      const projectDir = path.join(tempRoot, 'project');
      const stateDir = path.join(tempRoot, 'state');
      mkdirSync(projectDir, { recursive: true });
      let control: ChildProcess | undefined;
      const standIn = startStandInParent();
      try {
        writeFileSync(path.join(projectDir, 'server.mjs'), SERVER_FIXTURE);
        control = startSupervisedControl(projectDir, stateDir, standIn, true);
        const url = await controlUrl(control);

        const approved = await approveServiceActions(url, [{ id: 'svc', tool: 'service.start', args: { name: 'tiny', path: 'server.mjs' } }]);
        const result = (approved.execution?.results ?? []).find((entry: any) => entry.id === 'svc');
        expect(result?.status).toBe('ok');
        const pid = result.content.pid as number;
        recordedPids.push(pid);

        const startedAt = Date.now();
        process.kill(standIn, 'SIGKILL');
        const exitCode = await exitCodeWithin(control, 5000);
        const elapsed = Date.now() - startedAt;
        console.log(`parent-loss stop of the service tree took ${elapsed} ms`);
        await waitUntil(() => groupMembers(pid).length === 0, 5000, 'service group still alive after parent loss');
        expect(groupMembers(pid)).toEqual([]);
        expect(exitCode).toBe(0);
      } finally {
        await stopSupervisors(control, standIn);
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    60_000
  );

  it.skipIf(process.platform === 'win32')(
    'fails and stops the tree when the ready line never arrives',
    async () => {
      const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'conduit-service-start-'));
      const projectDir = path.join(tempRoot, 'project');
      const stateDir = path.join(tempRoot, 'state');
      mkdirSync(projectDir, { recursive: true });
      let control: ChildProcess | undefined;
      const standIn = startStandInParent();
      try {
        writeFileSync(path.join(projectDir, 'quiet.mjs'), QUIET_FIXTURE);
        control = startSupervisedControl(projectDir, stateDir, standIn, true);
        const url = await controlUrl(control);

        const approved = await approveServiceActions(url, [{ id: 'svc', tool: 'service.start', args: { name: 'quiet', path: 'quiet.mjs', readySeconds: 1 } }]);
        const result = (approved.execution?.results ?? []).find((entry: any) => entry.id === 'svc');
        expect(result?.status).toBe('error');
        expect(String(result?.error)).toContain('CONDUIT_READY');

        // The result has no pid on failure; read it from the registry list.
        const after = await (await fetch(`${url}/api/services`)).json() as { services: any[] };
        const record = after.services[0];
        expect(record).toMatchObject({ stoppedBy: 'ready-deadline' });
        expect(Number.isFinite(record.pid)).toBe(true);
        recordedPids.push(record.pid);
        await waitDead(record.pid, 5000, 'quiet service is still alive after the ready deadline');
      } finally {
        await stopSupervisors(control, standIn);
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    60_000
  );

  it.skipIf(process.platform === 'win32')(
    'fails when the program exits before it is ready',
    async () => {
      const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'conduit-service-start-'));
      const projectDir = path.join(tempRoot, 'project');
      const stateDir = path.join(tempRoot, 'state');
      mkdirSync(projectDir, { recursive: true });
      let control: ChildProcess | undefined;
      const standIn = startStandInParent();
      try {
        writeFileSync(path.join(projectDir, 'crash.mjs'), CRASH_FIXTURE);
        control = startSupervisedControl(projectDir, stateDir, standIn, true);
        const url = await controlUrl(control);

        const approved = await approveServiceActions(url, [{ id: 'svc', tool: 'service.start', args: { name: 'crash', path: 'crash.mjs' } }]);
        const result = (approved.execution?.results ?? []).find((entry: any) => entry.id === 'svc');
        expect(result?.status).toBe('error');
        expect(String(result?.error)).toContain('exited before it was ready');
      } finally {
        await stopSupervisors(control, standIn);
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    60_000
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a service entry whose sha256 does not match, before spawning anything',
    async () => {
      const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'conduit-service-start-'));
      const projectDir = path.join(tempRoot, 'project');
      const stateDir = path.join(tempRoot, 'state');
      mkdirSync(projectDir, { recursive: true });
      let control: ChildProcess | undefined;
      const standIn = startStandInParent();
      try {
        writeFileSync(path.join(projectDir, 'server.mjs'), SERVER_FIXTURE);
        control = startSupervisedControl(projectDir, stateDir, standIn, true);
        const url = await controlUrl(control);

        const approved = await approveServiceActions(url, [{ id: 'svc', tool: 'service.start', args: { name: 'tiny', path: 'server.mjs', sha256: '0'.repeat(64) } }]);
        const result = (approved.execution?.results ?? []).find((entry: any) => entry.id === 'svc');
        expect(result?.status).toBe('error');
        expect(String(result?.error)).toContain('sha256 mismatch');

        const list = await (await fetch(`${url}/api/services`)).json() as { services: any[] };
        expect(list.services).toEqual([]);
      } finally {
        await stopSupervisors(control, standIn);
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    60_000
  );

  it.skipIf(process.platform === 'win32')(
    'denies an entry path outside the project root',
    async () => {
      const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'conduit-service-start-'));
      const projectDir = path.join(tempRoot, 'project');
      const stateDir = path.join(tempRoot, 'state');
      mkdirSync(projectDir, { recursive: true });
      let control: ChildProcess | undefined;
      const standIn = startStandInParent();
      try {
        writeFileSync(path.join(projectDir, 'server.mjs'), SERVER_FIXTURE);
        writeFileSync(path.join(tempRoot, 'outside.mjs'), CRASH_FIXTURE);
        control = startSupervisedControl(projectDir, stateDir, standIn, true);
        const url = await controlUrl(control);

        const approved = await approveServiceActions(url, [{ id: 'svc', tool: 'service.start', args: { name: 'outside', path: '../outside.mjs' } }]);
        const result = (approved.execution?.results ?? []).find((entry: any) => entry.id === 'svc');
        expect(result?.status).toBe('denied');
      } finally {
        await stopSupervisors(control, standIn);
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    60_000
  );

  it.skipIf(process.platform === 'win32')(
    'off: service.start and shell.run are both denied in reviews, and the services route answers 404',
    async () => {
      const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'conduit-service-start-'));
      const projectDir = path.join(tempRoot, 'project');
      const stateDir = path.join(tempRoot, 'state');
      mkdirSync(projectDir, { recursive: true });
      let control: ChildProcess | undefined;
      const standIn = startStandInParent();
      try {
        writeFileSync(path.join(projectDir, 'server.mjs'), SERVER_FIXTURE);
        control = startSupervisedControl(projectDir, stateDir, standIn, false);
        const url = await controlUrl(control);

        const approved = await approveServiceActions(url, [
          { id: 'svc', tool: 'service.start', args: { name: 'tiny', path: 'server.mjs' } },
          { id: 'run', tool: 'shell.run', args: { command: 'echo demo-off' } }
        ]);
        const results = approved.execution?.results ?? [];
        expect(results.find((entry: any) => entry.id === 'svc')).toMatchObject({
          status: 'denied',
          error: 'Unknown tool: service.start'
        });
        expect(results.find((entry: any) => entry.id === 'run')).toMatchObject({
          status: 'denied',
          error: 'Tool denied by read-only profile: shell.run'
        });

        const services = await fetch(`${url}/api/services`);
        expect(services.status).toBe(404);
        expect(await services.json()).toEqual({ error: 'Not found' });
      } finally {
        await stopSupervisors(control, standIn);
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    60_000
  );
});
