import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConduitUrl } from '../../src/protocol/conduit-url.js';
import { addPackageAllows, findActivePackageAllow, revokePackageAllow } from '../../src/approvals/package-allows.js';
import { executeRequestFromUnknown } from '../../src/daemon/execute-request.js';
import { makeTarGz } from '../helpers/tar-fixture.js';
import { removeTree } from '../helpers/remove-tree.js';

const execFileAsync = promisify(execFile);
const tsxBin = path.resolve('node_modules/.bin/tsx');
const cliEntry = path.resolve('src/cli/index.ts');

// Pids this test recorded, so afterEach kills exactly what we started.
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

/** The program inside the package: prints CONDUIT_READY and answers where it
 * runs and whether it could change its own package (it must not: the cache is
 * read-only, so a later start of the same digest runs the verified bytes). */
const PACKAGE_SERVER = [
  "import http from 'node:http';",
  "import { appendFileSync, writeFileSync } from 'node:fs';",
  'function attempt(fn) { try { fn(); return null; } catch (error) { return error.code ?? String(error); } }',
  'const server = http.createServer((req, res) => {',
  "  const newFileError = attempt(() => writeFileSync('planted.mjs', 'x'));",
  "  const entryWriteError = attempt(() => appendFileSync(new URL(import.meta.url), '// changed'));",
  "  res.writeHead(200, { 'content-type': 'application/json' });",
  '  res.end(JSON.stringify({ cwd: process.cwd(), pid: process.pid, newFileError, entryWriteError }));',
  '});',
  "server.listen(Number(process.env.PORT), process.env.HOST, () => { console.log('CONDUIT_READY http://127.0.0.1:' + process.env.PORT); });",
  'setInterval(() => {}, 1 << 30);'
].join('\n') + '\n';

function startStandInParent(): number {
  const parent = spawn('sleep', ['120'], { stdio: 'ignore' });
  recordedPids.push(parent.pid as number);
  expect(parent.pid).toBeGreaterThan(1);
  return parent.pid as number;
}

/** The Conduit Control process, supervised: `conduit app start` with cwd the
 * project dir, demo switch on or off. */
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

/** Stops this test's Control (its watchdog stops its services on SIGTERM) and
 * stand-in parent, and waits for Control to exit. */
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

async function postJson(url: string, pathName: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${url}${pathName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

function packageEnvelope(packageRef: { url: string; sha256: string }): string {
  return JSON.stringify({
    schema: 'conduit.request.v1',
    source: { kind: 'web', trust: 'untrusted' },
    title: 'Package service',
    actions: [{ id: 'svc', tool: 'service.start', args: { name: 'pkg', package: packageRef } }]
  });
}

async function openConduitUrl(url: string, envelope: string): Promise<any> {
  const opened = await postJson(url, '/api/url/open', { url: createConduitUrl(envelope) });
  return opened.body.execution;
}

async function approvalCount(url: string): Promise<number> {
  const response = await fetch(`${url}/api/approvals`);
  const body = await response.json() as { approvals: unknown[] };
  return body.approvals.length;
}

/** Stops every service Control lists and records their pids for cleanup.
 * Tolerates Control already being gone, and demo-off 404s. */
async function stopAllServices(url: string | undefined): Promise<void> {
  if (!url) {
    return;
  }
  try {
    const response = await fetch(`${url}/api/services`);
    if (!response.ok) {
      return;
    }
    const list = await response.json() as { services: Array<{ serviceId: string; pid: number | null }> };
    for (const service of list.services) {
      if (service.pid) {
        recordedPids.push(service.pid);
      }
      await postJson(url, `/api/services/${encodeURIComponent(service.serviceId)}/stop`, {});
    }
  } catch {
    // Control is gone; its watchdog already stopped the trees.
  }
}

describe('package allow scope (in-process, no fetch)', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'conduit-package-scope-'));
    process.env.CONDUIT_STATE_DIR = path.join(tempRoot, 'state');
    process.env.CONDUIT_DEMO_PROFILE = '1';
  });

  afterEach(() => {
    delete process.env.CONDUIT_DEMO_PROFILE;
    delete process.env.CONDUIT_STATE_DIR;
    removeTree(tempRoot);
  });

  it('an allowed digest never covers another action in the same request', async () => {
    const sha = 'b'.repeat(64);
    await addPackageAllows({
      packages: [{ sha256: sha, url: 'https://packages.example/pkg.tgz', network: 'local' }],
      approvalId: 'approval_test',
      decidedBy: 'cli'
    });
    expect((await findActivePackageAllow(sha, 'local'))?.sha256).toBe(sha);

    const mixed = await executeRequestFromUnknown({
      schema: 'conduit.request.v1',
      source: { kind: 'web', trust: 'untrusted' },
      actions: [
        { id: 'svc', tool: 'service.start', args: { name: 'pkg', package: { url: 'https://packages.example/pkg.tgz', sha256: sha } } },
        { id: 'sh', tool: 'shell.run', args: { command: 'echo hi' } }
      ]
    });
    expect(mixed.status).toBe('requires_review');
    expect(mixed.allowIds).toBeUndefined();

    // Revoked: the same package-only request would now ask too.
    expect((await revokePackageAllow(sha, 'cli')).map((allow) => allow.state)).toEqual(['revoked']);
    const asked = await executeRequestFromUnknown({
      schema: 'conduit.request.v1',
      source: { kind: 'web', trust: 'untrusted' },
      actions: [{ id: 'svc', tool: 'service.start', args: { name: 'pkg', package: { url: 'https://packages.example/pkg.tgz', sha256: sha } } }]
    });
    expect(asked.status).toBe('requires_review');
  });
});

describe('package service.start with "Always allow this exact package" (real processes, loopback only)', () => {
  it.skipIf(process.platform === 'win32')(
    'demo on: approve with remember: package, then the same package runs without an ask, until revoked',
    async () => {
      const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'conduit-package-allow-'));
      const projectDir = path.join(tempRoot, 'project');
      const stateDir = path.join(tempRoot, 'state');
      mkdirSync(projectDir, { recursive: true });

      // The package tarball served over loopback; requests and bytes counted.
      const served = { requests: 0, bytes: 0 };
      const packageTar = makeTarGz([
        { name: 'package/package.json', body: JSON.stringify({ conduit: { entry: 'server.mjs', runtime: 'node' } }) },
        { name: 'package/server.mjs', body: PACKAGE_SERVER }
      ]);
      const sha = createHash('sha256').update(packageTar).digest('hex');
      let otherTar: Buffer | undefined;
      let otherSha = '';
      let fixturePort = 0;
      const fixtureServer = createServer((req, res) => {
        served.requests += 1;
        const bytes = (req.url ?? '').startsWith('/other.tgz')
          ? otherTar
          : packageTar;
        if (!bytes) {
          res.writeHead(404);
          res.end();
          return;
        }
        served.bytes += bytes.length;
        res.writeHead(200, { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream' });
        res.end(bytes);
      });
      await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
      fixturePort = (fixtureServer.address() as { port: number }).port;
      const packageUrl = `http://127.0.0.1:${fixturePort}/pkg.tgz`;

      let control: ChildProcess | undefined;
      let url: string | undefined;
      const standIn = startStandInParent();
      try {
        control = startSupervisedControl(projectDir, stateDir, standIn, true);
        url = await controlUrl(control);

        const envelope = packageEnvelope({ url: packageUrl, sha256: sha });
        const first = await openConduitUrl(url, envelope);
        expect(first.status).toBe('requires_review');
        const approvalId = first.approvalId as string;
        expect(served).toEqual({ requests: 0, bytes: 0 });

        // The review prompt tells the person about the exact-package choice.
        const show = await (await fetch(`${url}/api/approvals/${encodeURIComponent(approvalId)}`)).json() as { approval: { prompt: string } };
        expect(show.approval.prompt).toContain('Always allow this exact package');

        const approvalsBefore = await approvalCount(url);
        const approved = await postJson(url, `/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
          decidedBy: 'cli',
          remember: 'package'
        });
        expect(approved.status).toBe(200);
        const result = (approved.body.execution?.results ?? []).find((entry: any) => entry.id === 'svc');
        expect(result.status).toBe('ok');
        // The approval response records the allow.
        expect((approved.body.packageAllows as Array<any>).some((allow) => allow.sha256 === sha)).toBe(true);
        expect((approved.body.packageAllows as Array<any>).find((allow) => allow.sha256 === sha)?.network).toBe('local');

        // Served from inside the package cache, by the pid the result names.
        const pid = result.content.pid as number;
        recordedPids.push(pid);
        const answer = JSON.parse(await (await fetch(result.content.url)).text()) as {
          cwd: string; pid: number; newFileError: string | null; entryWriteError: string | null;
        };
        expect(answer.pid).toBe(pid);
        const expectedDir = path.join(stateDir, 'cache', 'packages', sha);
        expect(realpathSync(expectedDir)).toBe(realpathSync(answer.cwd));
        // The running program cannot add to or change its own verified package.
        expect(answer.newFileError).toBe('EACCES');
        expect(answer.entryWriteError).toBe('EACCES');
        expect(result.content.package).toEqual({ sha256: sha, cached: false, bytesFetched: packageTar.length });

        await stopAllServices(url);
        expect(served).toEqual({ requests: 1, bytes: packageTar.length });

        // Same request again runs without an ask and without fetching.
        const second = await openConduitUrl(url, envelope);
        expect(second.status).toBe('executed');
        const secondResult = (second.results ?? []).find((entry: any) => entry.id === 'svc');
        expect(secondResult?.status).toBe('ok');
        recordedPids.push(secondResult.content.pid as number);
        expect(secondResult.content.package).toEqual({ sha256: sha, cached: true, bytesFetched: 0 });
        expect((await (await fetch(secondResult.content.url)).json() as { cwd: string }).cwd).toBe(answer.cwd);
        expect(second.approvalId).toBeUndefined();
        expect(second.allowIds).toBeTruthy();
        const approvalsAfter = await approvalCount(url);
        expect(approvalsAfter).toBe(approvalsBefore);
        expect(served).toEqual({ requests: 1, bytes: packageTar.length });
        await stopAllServices(url);
        // The CLI lists it.
        const allowed = await execFileAsync(tsxBin, [cliEntry, 'packages', 'allowed', '--url', url, '--json'], { timeout: 60_000 });
        expect((JSON.parse(allowed.stdout) as { allows: Array<{ sha256: string }> }).allows.map((allow) => allow.sha256)).toContain(sha);

        // A different sha256 asks again.
        otherTar = makeTarGz([
          { name: 'package/package.json', body: JSON.stringify({ conduit: { entry: 'server.mjs', runtime: 'node' } }) },
          { name: 'package/server.mjs', body: PACKAGE_SERVER.replace('process.cwd()', 'process.cwd().toUpperCase()') }
        ]);
        otherSha = createHash('sha256').update(otherTar).digest('hex');
        const secondPackage = await openConduitUrl(url, packageEnvelope({ url: `http://127.0.0.1:${fixturePort}/other.tgz`, sha256: otherSha }));
        expect(secondPackage.status).toBe('requires_review');
        await postJson(url, `/api/approvals/${encodeURIComponent(secondPackage.approvalId)}/deny`, { decidedBy: 'cli' });
        expect(served).toEqual({ requests: 1, bytes: packageTar.length });

        // Revoking restores the ask.
        const revoked = await execFileAsync(tsxBin, [cliEntry, 'packages', 'revoke', sha, '--url', url, '--json'], { timeout: 60_000 });
        expect(JSON.parse(revoked.stdout).allows.map((allow: any) => allow.sha256)).toContain(sha);
        const third = await openConduitUrl(url, envelope);
        expect(third.status).toBe('requires_review');
        await postJson(url, `/api/approvals/${encodeURIComponent(third.approvalId)}/deny`, { decidedBy: 'cli' });
      } finally {
        await fixtureServer.close();
        await stopAllServices(url);
        await stopSupervisors(control, standIn);
        removeTree(tempRoot);
      }
    },
    120_000
  );

  it.skipIf(process.platform === 'win32')(
    'demo off: remember: package is refused with the existing text, and service.start stays unknown',
    async () => {
      const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'conduit-package-off-'));
      const projectDir = path.join(tempRoot, 'project');
      const stateDir = path.join(tempRoot, 'state');
      mkdirSync(projectDir, { recursive: true });

      const served = { requests: 0, bytes: 0 };
      const packageTar = makeTarGz([
        { name: 'package/package.json', body: JSON.stringify({ conduit: { entry: 'server.mjs', runtime: 'node' } }) },
        { name: 'package/server.mjs', body: 'console.log("never started");\n' }
      ]);
      const sha = createHash('sha256').update(packageTar).digest('hex');
      const fixtureServer = createServer((req, res) => {
        served.requests += 1;
        res.writeHead(200, { 'content-length': String(packageTar.length) });
        served.bytes += packageTar.length;
        res.end(packageTar);
      });
      await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
      const packageUrl = `http://127.0.0.1:${(fixtureServer.address() as { port: number }).port}/pkg.tgz`;

      let control: ChildProcess | undefined;
      let url: string | undefined;
      const standIn = startStandInParent();
      try {
        writeFileSync(path.join(projectDir, 'README.md'), 'hello\n');
        control = startSupervisedControl(projectDir, stateDir, standIn, false);
        url = await controlUrl(control);

        const first = await openConduitUrl(url, packageEnvelope({ url: packageUrl, sha256: sha }));
        expect(first.status).toBe('requires_review');

        const refused = await postJson(url, `/api/approvals/${encodeURIComponent(first.approvalId)}/approve`, {
          decidedBy: 'cli',
          remember: 'package'
        });
        expect(refused.status).toBe(400);
        expect(refused.body.error).toBe('remember must be "session" (this chat only).');

        // A plain approval still cannot start a service with the switch off.
        const plain = await postJson(url, `/api/approvals/${encodeURIComponent(first.approvalId)}/approve`, { decidedBy: 'cli' });
        expect(plain.status).toBe(200);
        const result = (plain.body.execution?.results ?? []).find((entry: any) => entry.id === 'svc');
        expect(result).toMatchObject({ status: 'denied', error: 'Unknown tool: service.start' });
        expect(served).toEqual({ requests: 0, bytes: 0 });

        // The package-allows route is a 404 like any unknown route.
        const allows = await fetch(`${url}/api/package-allows`);
        expect(allows.status).toBe(404);
        expect(await allows.json()).toEqual({ error: 'Not found' });
      } finally {
        await fixtureServer.close();
        await stopSupervisors(control, standIn);
        removeTree(tempRoot);
      }
    },
    60_000
  );
});
