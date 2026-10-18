import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// script/build_and_run.sh must never stop a Conduit it did not start from this
// checkout (finding D-1). These tests use its dry-run switch, so they build,
// stop and launch nothing.
const scriptSource = fileURLToPath(new URL('../../script/build_and_run.sh', import.meta.url));
const appExecutable = (root: string) => path.join(root, 'dist', 'macos', 'Conduit.app', 'Contents', 'MacOS', 'Conduit');

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

function wouldStop(stdout: string): string[] {
  const match = /^Dry run: would stop this checkout's app: (.*)$/m.exec(stdout);
  if (!match) throw new Error(`no stop line in: ${stdout}`);
  return match[1] === 'none' ? [] : match[1].split(' ').sort();
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

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-build-and-run-'));
    fakes = [];
  });

  afterEach(async () => {
    for (const fake of fakes) {
      if (fake.pid && isAlive(fake.pid)) process.kill(fake.pid, 'SIGKILL');
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  // A stand-in process whose argv[0] (what ps reports as comm on macOS) is the given
  // executable path. It is /bin/sleep underneath; nothing is copied or signed.
  async function startFake(argv0: string): Promise<number> {
    const child = spawn('/usr/bin/perl', ['-e', 'exec { "/bin/sleep" } $ARGV[0], "60"', argv0], { stdio: 'ignore' });
    fakes.push(child);
    const pid = child.pid;
    if (!pid) throw new Error('fake process did not start');
    for (let i = 0; i < 50; i += 1) {
      const comm = spawnSync('/bin/ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      if (comm === argv0) return pid;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`fake process ${pid} never showed ${argv0}`);
  }

  it('never stops processes by name', async () => {
    const source = await readFile(scriptSource, 'utf8');
    expect(source).not.toMatch(/pkill\s+-x/);
    expect(source).not.toMatch(/pgrep\s+-x/);
    expect(source).not.toMatch(/killall/);
    expect(source).not.toMatch(/pkill[^\n]*"\$APP_NAME"/);
    expect(source).not.toMatch(/pkill[^\n]*"\$PRODUCT"/);
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
      expect(wouldStop(result.stdout)).toEqual([]);
    }
  });

  it.runIf(process.platform === 'darwin')('run modes would stop only the app running from this checkout\'s bundle', async () => {
    const root = await makeCheckout(tempRoot, 'checkout');
    const other = await makeCheckout(tempRoot, 'other-checkout');
    const own = await startFake(appExecutable(root));
    const ownReal = await startFake(appExecutable(await realpath(root)));
    const otherApp = await startFake(appExecutable(other));
    const installedLookalike = await startFake(path.join(tempRoot, 'Applications', 'Conduit.app', 'Contents', 'MacOS', 'Conduit'));

    const buildOnly = runDry(root, ['--build-only']);
    expect(buildOnly.status).toBe(0);
    expect(buildOnly.stdout).not.toContain('would stop');

    for (const mode of [[], ['--verify'], ['--logs'], ['--debug']]) {
      const result = runDry(root, mode);
      expect(result.status).toBe(0);
      expect(wouldStop(result.stdout)).toEqual([String(own), String(ownReal)].sort());
    }

    for (const pid of [own, ownReal, otherApp, installedLookalike]) {
      expect(isAlive(pid)).toBe(true);
    }
  });
});
