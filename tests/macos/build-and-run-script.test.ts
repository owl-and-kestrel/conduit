import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// script/build_and_run.sh must never stop a Conduit it did not start from this
// checkout (finding D-1), nor another checkout's services (review F-01). These
// tests use its dry-run switch, so they build, stop and launch nothing.
const scriptSource = fileURLToPath(new URL('../../script/build_and_run.sh', import.meta.url));
const appExecutable = (root: string) => path.join(root, 'dist', 'macos', 'Conduit.app', 'Contents', 'MacOS', 'Conduit');

// Command lines of the services the app supervises, in the shapes the removed
// `pkill -f "$ROOT.*…"` sweeps matched (tsx from the checkout, and the compiled CLI).
const serviceCommands = (root: string): string[][] => [
  [path.join(root, 'node_modules', '.bin', 'tsx'), 'src/cli/index.ts', 'app', 'start', '--port', '47831'],
  [path.join(root, 'node_modules', '.bin', 'tsx'), 'src/cli/index.ts', 'daemon', 'start', '--interval-ms', '1000'],
  [path.join(root, 'node_modules', '.bin', 'tsx'), 'src/cli/index.ts', 'listen', '--project', root],
  [path.join(root, 'dist', 'cli', 'index.js'), 'app', 'start', '--port', '47831'],
  [path.join(root, 'dist', 'cli', 'index.js'), 'daemon', 'start'],
  [path.join(root, 'dist', 'src', 'cli', 'index.js'), 'listen', '--project', root]
];

async function makeCheckout(parent: string, name: string): Promise<string> {
  const root = path.join(parent, name);
  await mkdir(path.join(root, 'script'), { recursive: true });
  await copyFile(scriptSource, path.join(root, 'script', 'build_and_run.sh'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  return root;
}

function runDry(root: string, args: string[]) {
  return spawnSync('/bin/bash', [path.join(root, 'script', 'build_and_run.sh'), ...args], {
    env: { ...process.env, CONDUIT_BUILD_DRY_RUN: '1' },
    encoding: 'utf8',
    timeout: 20_000
  });
}

function dryRunList(stdout: string, label: string): string[] {
  const match = new RegExp(`^Dry run: would stop ${label}: (.*)$`, 'm').exec(stdout);
  if (!match) throw new Error(`no "${label}" line in: ${stdout}`);
  return match[1] === 'none' ? [] : match[1].split(' ').sort();
}

const wouldStop = (stdout: string) => dryRunList(stdout, "this checkout's app");
const wouldStopChildren = (stdout: string) => dryRunList(stdout, "the app's child processes");

// Every process a run mode would signal is named on one of these two lines.
function expectOnlyStopLines(stdout: string): void {
  const wouldLines = stdout.split('\n').filter((line) => line.includes('would'));
  expect(wouldLines).toHaveLength(2);
  expect(wouldLines[0]).toMatch(/^Dry run: would stop this checkout's app: /);
  expect(wouldLines[1]).toMatch(/^Dry run: would stop the app's child processes: /);
}

function childPids(pid: number): number[] {
  return spawnSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === 'win32')('script/build_and_run.sh process scoping', () => {
  let tempRoot: string;
  let fakes: ChildProcess[];
  let extraPids: number[];

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-build-and-run-'));
    fakes = [];
    extraPids = [];
  });

  afterEach(async () => {
    for (const pid of [...extraPids, ...fakes.map((fake) => fake.pid ?? 0)]) {
      if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  // A stand-in process whose argv[0] (what ps reports as comm on macOS) is the given
  // executable path. It is /bin/sleep underneath; nothing is copied or signed. With
  // `withChildren`, it first forks a child and a grandchild (plain sleeps), like the
  // app's supervised services under it.
  async function startFake(argv0: string, withChildren = false): Promise<number> {
    const script = withChildren
      ? 'if (fork) { exec { "/bin/sleep" } $ARGV[0], "60" } elsif (fork) { exec "/bin/sleep", "60" } else { exec "/bin/sleep", "60" }'
      : 'exec { "/bin/sleep" } $ARGV[0], "60"';
    const child = spawn('/usr/bin/perl', ['-e', script, argv0], { stdio: 'ignore' });
    fakes.push(child);
    const pid = child.pid;
    if (!pid) throw new Error('fake process did not start');
    for (let i = 0; i < 50; i += 1) {
      const comm = spawnSync('/bin/ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      const children = childPids(pid);
      const grandchildren = children.flatMap(childPids);
      extraPids.push(...children, ...grandchildren);
      if (comm === argv0 && (!withChildren || (children.length === 1 && grandchildren.length === 1))) return pid;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`fake process ${pid} never showed ${argv0}`);
  }

  // A stand-in service: a sleeping perl whose command line reads like a Conduit service.
  async function startFakeService(commandLine: string[]): Promise<number> {
    const child = spawn('/usr/bin/perl', ['-e', 'sleep 60', '--', ...commandLine], { stdio: 'ignore' });
    fakes.push(child);
    const pid = child.pid;
    if (!pid) throw new Error('fake service did not start');
    for (let i = 0; i < 50; i += 1) {
      const command = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
      if (command.includes(commandLine.join(' '))) return pid;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`fake service ${pid} never showed its command line`);
  }

  it('never stops processes by name or command-line pattern', async () => {
    const source = await readFile(scriptSource, 'utf8');
    expect(source).not.toMatch(/pkill/);
    expect(source).not.toMatch(/pgrep\s+-x/);
    expect(source).not.toMatch(/pgrep\s+-f/);
    expect(source).not.toMatch(/killall/);
    // The only signal the script sends goes to this checkout's app and its child processes.
    const signalLines = source.split('\n').filter((line) => /\bkill\s+-(?!0\b)/.test(line));
    expect(signalLines.map((line) => line.trim())).toEqual(['kill -TERM $child_pids $app_pids 2>/dev/null || true']);
  });

  it('rejects an unknown option before building or stopping anything', async () => {
    const root = await makeCheckout(tempRoot, 'checkout');
    const result = runDry(root, ['--bogus']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown option: --bogus');
    expect(result.stdout).not.toContain('Dry run');
  });

  it('--build-only stops no process', async () => {
    const root = await makeCheckout(tempRoot, 'checkout');
    const result = runDry(root, ['--build-only']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dry run: --build-only stops no process.');
    expect(result.stdout).not.toContain('would stop');
  });

  it('run modes on a checkout with no running app would stop nothing', async () => {
    const root = await makeCheckout(tempRoot, 'checkout');
    for (const mode of [[], ['--verify'], ['--logs'], ['--debug']]) {
      const result = runDry(root, mode);
      expect(result.status).toBe(0);
      expectOnlyStopLines(result.stdout);
      expect(wouldStop(result.stdout)).toEqual([]);
      expect(wouldStopChildren(result.stdout)).toEqual([]);
    }
  });

  it('run modes would signal nothing outside this checkout, and sibling-checkout services survive (F-01)', async () => {
    // `checkout-fork` has `checkout` as a string prefix: the removed sweeps matched it.
    const root = await makeCheckout(tempRoot, 'checkout');
    const sibling = await makeCheckout(tempRoot, 'checkout-fork');
    const siblingServices: number[] = [];
    for (const commandLine of serviceCommands(sibling)) siblingServices.push(await startFakeService(commandLine));
    // A service started by hand from this checkout is not the app's child either.
    const byHand = await startFakeService(serviceCommands(root)[1]);

    // The stand-ins are real targets: the removed unanchored sweep pattern finds the sibling's.
    const oldSweep = spawnSync('/usr/bin/pgrep', ['-f', `${root}.*src/cli/index.ts app start --port 47831`], { encoding: 'utf8' });
    expect(oldSweep.stdout.split(/\s+/).filter(Boolean).map(Number)).toContain(siblingServices[0]);

    for (const mode of [[], ['--verify'], ['--logs'], ['--debug']]) {
      const result = runDry(root, mode);
      expect(result.status).toBe(0);
      expectOnlyStopLines(result.stdout);
      expect(wouldStop(result.stdout)).toEqual([]);
      expect(wouldStopChildren(result.stdout)).toEqual([]);
    }

    for (const pid of [...siblingServices, byHand]) {
      expect(isAlive(pid)).toBe(true);
    }
  });

  it.runIf(process.platform === 'darwin')('run modes would stop only the app running from this checkout\'s bundle and its child processes', async () => {
    const root = await makeCheckout(tempRoot, 'checkout');
    const sibling = await makeCheckout(tempRoot, 'checkout-fork');
    const own = await startFake(appExecutable(root), true);
    const ownChildren = childPids(own);
    const ownTree = [...ownChildren, ...ownChildren.flatMap(childPids)];
    const ownReal = await startFake(appExecutable(await realpath(root)));
    const siblingApp = await startFake(appExecutable(sibling), true);
    const siblingChildren = childPids(siblingApp);
    const siblingTree = [...siblingChildren, ...siblingChildren.flatMap(childPids)];
    const siblingServices: number[] = [];
    for (const commandLine of serviceCommands(sibling)) siblingServices.push(await startFakeService(commandLine));
    const installedLookalike = await startFake(path.join(tempRoot, 'Applications', 'Conduit.app', 'Contents', 'MacOS', 'Conduit'));
    expect(ownTree).toHaveLength(2);
    expect(siblingTree).toHaveLength(2);

    const buildOnly = runDry(root, ['--build-only']);
    expect(buildOnly.status).toBe(0);
    expect(buildOnly.stdout).not.toContain('would stop');

    for (const mode of [[], ['--verify'], ['--logs'], ['--debug']]) {
      const result = runDry(root, mode);
      expect(result.status).toBe(0);
      expectOnlyStopLines(result.stdout);
      expect(wouldStop(result.stdout)).toEqual([String(own), String(ownReal)].sort());
      expect(wouldStopChildren(result.stdout)).toEqual(ownTree.map(String).sort());
    }

    for (const pid of [own, ownReal, ...ownTree, siblingApp, ...siblingTree, ...siblingServices, installedLookalike]) {
      expect(isAlive(pid)).toBe(true);
    }
  });
});
