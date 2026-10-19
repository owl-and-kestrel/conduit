import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Pids this test recorded, so afterEach can kill exactly what we started.
const recordedPids: number[] = [];
const recordedChildren: ChildProcess[] = [];

// The service runs from a script file, not `tsx -e`, as the app runs
// `tsx src/cli/index.ts`: only file mode gives tsx its parent<->child signal
// channel, without which a SIGTERM to the tsx wrapper force-kills the
// service after 60 ms.
function spawnService(script: string, parentPid: number, pidDir: string): ChildProcess {
  const entry = path.join(pidDir, 'service.ts');
  writeFileSync(entry, script);
  const child = spawn(path.resolve('node_modules/.bin/tsx'), [entry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONDUIT_PARENT_PID: String(parentPid),
      CONDUIT_TEST_PID_DIR: pidDir
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  // Drain stderr so a large watchdog log cannot block the service.
  child.stderr?.resume();
  recordedChildren.push(child);
  return child;
}

function startStandInParent(): number {
  const parent = spawn('sleep', ['60'], { stdio: 'ignore' });
  recordedPids.push(parent.pid as number);
  expect(parent.pid).toBeGreaterThan(1);
  return parent.pid as number;
}

async function waitForPidFiles(files: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (files.every((file) => existsSync(file))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`pid files not written in time: ${files.join(', ')}`);
}

function readPid(file: string): number {
  const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
  expect(Number.isFinite(pid) && pid > 1).toBe(true);
  recordedPids.push(pid);
  return pid;
}

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

async function waitDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isDead(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`pid ${pid} is still alive`);
}

function exitCodeWithin(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watchdog service did not exit')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

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

describe('parent watchdog', () => {
  it('exits supervised CLI services when the parent pid is gone', async () => {
    const child = spawn(path.resolve('node_modules/.bin/tsx'), [
      '-e',
      [
        'import { startParentWatchdogFromEnv } from "./src/cli/parent-watchdog.ts";',
        'startParentWatchdogFromEnv();',
        'setTimeout(() => process.exit(99), 5000);'
      ].join('\n')
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONDUIT_PARENT_PID: '999999'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    expect(exitCode).toBe(0);
  });

  // setsid(1) is not on macOS; perl's POSIX::setsid then exec works on both.
  const SETSID = `perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV'`;

  // Every process the command starts runs `sleep <token>`, so survivors
  // are also counted by command line (not only by the pids written below).
  function survivorsRunning(token: string): number[] {
    const needle = `sleep ${token}`;
    const found: number[] = [];
    if (process.platform === 'linux') {
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) {
          continue;
        }
        try {
          const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').join(' ');
          if (args.includes(needle) && !isDead(Number(name))) {
            found.push(Number(name));
          }
        } catch {
          // exited while listing
        }
      }
      return found;
    }
    const out = execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match && match[2]!.includes(needle) && !isDead(Number(match[1]))) {
        found.push(Number(match[1]));
      }
    }
    return found;
  }

  async function crashParentAndExpectNoSurvivors(
    command: (dir: string, token: string) => string,
    pidNames: string[],
    settleMs = 0,
    stopBy: 'parent-crash' | 'service-sigterm' = 'parent-crash'
  ): Promise<void> {
    const pidDir = mkdtempSync(path.join(os.tmpdir(), 'conduit-watchdog-'));
    // A fractional duration no other process is likely to be sleeping for.
    const token = `${3000 + Math.floor(Math.random() * 6000)}.${process.pid}${Math.floor(Math.random() * 1000)}`;
    const standIn = startStandInParent();
    const src = (file: string) => JSON.stringify(path.resolve('src', file));
    const service = spawnService([
      `import { startParentWatchdogFromEnv } from ${src('cli/parent-watchdog.ts')};`,
      `import { shellRunTool } from ${src('tools/shell-run.ts')};`,
      'import { writeFileSync } from "node:fs";',
      '// Keep the event loop alive until the watchdog stops the process.',
      'setInterval(() => {}, 10000);',
      'startParentWatchdogFromEnv({ intervalMs: 200, graceMs: 1000 });',
      `writeFileSync(${JSON.stringify(path.join(pidDir, 'SERVICE'))}, String(process.pid));`,
      `const command = ${JSON.stringify(command(pidDir, token))};`,
      'void shellRunTool.run({ command }, { projectRoot: process.cwd(), runId: "test", runDir: "." });'
    ].join('\n'), standIn, pidDir);

    try {
      const files = pidNames.map((name) => path.join(pidDir, name));
      await waitForPidFiles(files, 10000);
      const pids = files.map(readPid);
      if (settleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, settleMs));
      }
      expect(survivorsRunning(token).length).toBeGreaterThan(0);

      if (stopBy === 'parent-crash') {
        process.kill(standIn, 'SIGKILL');
      } else {
        // The app's Stop all / Quit SIGTERMs every process it observed in
        // the service tree: here the tsx wrapper and the Node service, but
        // not the `nohup` orphan, which it never saw.
        const servicePid = Number(readFileSync(path.join(pidDir, 'SERVICE'), 'utf8'));
        process.kill(servicePid, 'SIGTERM');
        process.kill(service.pid as number, 'SIGTERM');
      }
      const exitCode = await exitCodeWithin(service, 10000);
      expect(exitCode).toBe(stopBy === 'parent-crash' ? 0 : 143);

      for (const pid of pids) {
        await waitDead(pid, 5000);
      }
      expect(survivorsRunning(token)).toEqual([]);
    } finally {
      // On failure, do not leave this test's sleeps behind (only processes
      // running this test's unique `sleep <token>` are signalled).
      for (const pid of survivorsRunning(token)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      rmSync(pidDir, { recursive: true, force: true });
    }
  }

  it.skipIf(process.platform === 'win32')(
    'stops an in-flight command, its children, a setsid grandchild and a TERM-ignoring child when the parent crashes',
    async () => {
      await crashParentAndExpectNoSurvivors((dir, token) => [
        `sleep ${token} & echo $! > ${dir}/A;`,
        `sh -c 'sleep ${token}' & echo $! > ${dir}/B;`,
        `(${SETSID} sleep ${token} & echo $! > ${dir}/C; wait) &`,
        `sh -c 'trap "" TERM; echo $$ > ${dir}/D; while :; do sleep ${token}; done' &`,
        'wait'
      ].join(' '), ['A', 'B', 'C', 'D']);
    }, 30000
  );

  it.skipIf(process.platform === 'win32')(
    'stops a nohup-ed orphan that kept the command process group after the shell exited',
    async () => {
      await crashParentAndExpectNoSurvivors((dir, token) =>
        `nohup sleep ${token} > /dev/null 2>&1 & echo $! > ${dir}/E`, ['E']);
    }, 30000
  );

  it.skipIf(process.platform === 'win32')(
    'stops a setsid child seen while its parent lived, after that parent exited',
    async () => {
      // The subshell outlives a few 200 ms observations, then exits: the
      // setsid child is then in no tracked group and has no tracked parent,
      // and is found only because it was seen earlier.
      await crashParentAndExpectNoSurvivors((dir, token) =>
        `(${SETSID} sleep ${token} > /dev/null 2>&1 & echo $! > ${dir}/F; sleep 1) > /dev/null 2>&1 &`, ['F'], 2000);
    }, 30000
  );

  it.skipIf(process.platform === 'win32')(
    'stops the command tree when the app SIGTERMs the service (Stop all / Quit)',
    async () => {
      await crashParentAndExpectNoSurvivors((dir, token) => [
        `nohup sleep ${token} > /dev/null 2>&1 & echo $! > ${dir}/G;`,
        `sleep ${token} & echo $! > ${dir}/H;`,
        'wait'
      ].join(' '), ['G', 'H'], 500, 'service-sigterm');
    }, 30000
  );
});
