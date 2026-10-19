// In-memory registry of long-lived services started by the `service.start`
// tool. It lives in the process that started the services (Conduit Control).
//
// It is deliberately NOT persisted. A service cannot outlive the process that
// started it: under the menu-bar app the deadman watchdog stops every adopted
// tree on parent loss or Stop all, and in a terminal Ctrl-C reaches the same
// process group and takes it down. A persisted list would therefore only ever
// hold dead entries, so a fresh process starts with no services.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { stat, mkdir, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { resolveInsideProject } from '../policy/sandbox.js';
import { CONTROL_PANEL_DEFAULT_PORT, EXTENSION_BRIDGE_DEFAULT_PORT } from '../util/loopback-guard.js';
import { supervision } from './process-tree.js';

export const SERVICE_READY_LINE = 'CONDUIT_READY';
export const DEFAULT_SERVICE_READY_SECONDS = 30;

/** TERM grace before KILL, the same 3 s a timed-out shell.run gets. */
export const SERVICE_STOP_GRACE_MS = 3000;

export type ServiceState = 'starting' | 'ready' | 'stopping' | 'exited' | 'failed';

export interface ServiceRecord {
  serviceId: string;
  name: string;
  entry: string;
  sha256: string;
  projectRoot: string;
  runId: string;
  logPath: string;
  host: '127.0.0.1' | '0.0.0.0';
  lan: boolean;
  port: number;
  url: string;
  pid: number | null;
  ownGroup: boolean;
  state: ServiceState;
  startedAt: string;
  readyAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  stoppedBy?: 'person' | 'ready-deadline';
  error?: string;
}

export interface StartServiceInput {
  name: string;
  path: string;
  args?: string[];
  sha256?: string;
  port?: number;
  lan?: boolean;
  readySeconds?: number;
  projectRoot: string;
  runId: string;
  runDir: string;
}

export function buildServiceEnv(base: NodeJS.ProcessEnv, input: { port: number; lan: boolean; serviceId: string }): NodeJS.ProcessEnv {
  // HOST and PORT are what the program is TOLD to bind; Conduit cannot enforce
  // what arbitrary code actually binds, so this is a disclosure, not an
  // enforcement. Loopback by default; 0.0.0.0 only comes about through the
  // per-service `lan: true` flag, which exists only under the demo profile
  // (Jon D4: LAN disclosure only).
  return {
    ...base,
    PORT: String(input.port),
    HOST: input.lan ? '0.0.0.0' : '127.0.0.1',
    CONDUIT_SERVICE_ID: input.serviceId
  };
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (exited(child)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve();
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

export class ServiceRegistry {
  /** Oldest first (insertion order). Kept after exit so the person can see
   * how a service ended. */
  private records = new Map<string, ServiceRecord>();
  /** Live ChildProcess beside each record; never exposed. */
  private children = new Map<string, ChildProcess>();

  async start(input: StartServiceInput): Promise<ServiceRecord> {
    // Sandbox: the entry must be inside the project root, like every file tool
    // path (resolveInsideProject throws "outside project root", which the tool
    // layer reports as denied). It must also be a regular file.
    const entry = await resolveInsideProject(input.path, input.projectRoot);
    const entryStat = await stat(entry);
    if (!entryStat.isFile()) {
      throw new Error(`Service entry is not a file: ${input.path}`);
    }

    // Hash before spawning anything, so a wrong digest never starts a program.
    const sha256 = createHash('sha256').update(await readFile(entry)).digest('hex');
    if (input.sha256 !== undefined && input.sha256 !== sha256) {
      throw new Error(`Service entry sha256 mismatch: expected ${input.sha256}, got ${sha256}`);
    }

    // Port: pick or probe on loopback only. Conduit never binds 0.0.0.0 for
    // its own probing. Conduit's own HTTP surfaces are reserved.
    const port = input.port ?? await freeLoopbackPort();
    if (port === CONTROL_PANEL_DEFAULT_PORT || port === EXTENSION_BRIDGE_DEFAULT_PORT) {
      throw new Error(`Port ${port} belongs to Conduit (Conduit Control ${CONTROL_PANEL_DEFAULT_PORT}, extension bridge ${EXTENSION_BRIDGE_DEFAULT_PORT}).`);
    }
    if (input.port !== undefined && !(await isLoopbackPortFree(port))) {
      throw new Error(`Port ${port} is in use.`);
    }

    const serviceId = `svc_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
    await mkdir(input.runDir, { recursive: true });
    const logPath = path.join(input.runDir, `service-${serviceId}.log`);
    const logStream = createWriteStream(logPath, { flags: 'a' });
    logStream.on('error', () => {
      // Best effort: a service keeps running even if its log cannot be written.
    });

    // D3: the service runs on the Node that runs Conduit (process.execPath);
    // nothing is installed. Under supervision (CONDUIT_PARENT_PID set) the
    // service leads its own process group, so the watchdog can stop its whole
    // tree; without supervision it stays in the terminal's group so Ctrl-C
    // still reaches it, exactly like shell.run.
    const childSpawnOptions = supervision.childSpawnOptions();
    const ownGroup = childSpawnOptions.detached;
    const child = spawn(process.execPath, [entry, ...(input.args ?? [])], {
      cwd: input.projectRoot,
      env: buildServiceEnv(process.env, { port, lan: input.lan ?? false, serviceId }),
      stdio: ['ignore', 'pipe', 'pipe'],
      ...childSpawnOptions
    });
    supervision.adopt(child);

    const startedAt = new Date().toISOString();
    const lan = input.lan ?? false;
    const host: ServiceRecord['host'] = lan ? '0.0.0.0' : '127.0.0.1';
    const record: ServiceRecord = {
      serviceId,
      name: input.name,
      entry,
      sha256,
      projectRoot: input.projectRoot,
      runId: input.runId,
      logPath,
      host,
      lan,
      port,
      // Always the loopback address: that is where this computer reaches the
      // service, whichever host it was told to bind.
      url: `http://127.0.0.1:${port}`,
      pid: child.pid ?? null,
      ownGroup,
      state: 'starting',
      startedAt
    };
    this.records.set(serviceId, record);
    this.children.set(serviceId, child);

    let startSettled = false;
    let resolveStart!: (record: ServiceRecord) => void;
    let rejectStart!: (error: Error) => void;
    const startPromise = new Promise<ServiceRecord>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });

    const readySeconds = input.readySeconds ?? DEFAULT_SERVICE_READY_SECONDS;

    // No lifetime bound on purpose: a long-lived service is not subject to
    // shell.run's 30 s timeout and has no maximum lifetime. It stops when the
    // person stops it, when the program exits by itself (the code author owns
    // that cleanup), or when the watchdog stops Conduit's trees. Every limit
    // must name a concrete harm, and no lifetime cap was found to prevent one
    // that Stop and the deadman watchdog do not already cover.
    const timer = setTimeout(() => {
      if (startSettled) {
        return;
      }
      // Concrete harm if missed: without a deadline the requester and the
      // person wait forever on a program that never serves, while it holds a
      // port nobody was told about.
      record.state = 'failed';
      record.stoppedBy = 'ready-deadline';
      record.error = `Service did not print CONDUIT_READY within ${readySeconds} s.`;
      startSettled = true;
      clearTimeout(timer);
      rejectStart(new Error(record.error));
      // Stop the tree the same way a person stop does (TERM, then KILL).
      void supervision.terminateTreeOf(child, SERVICE_STOP_GRACE_MS);
    }, readySeconds * 1000);

    child.on('error', (error) => {
      if (!startSettled) {
        record.state = 'failed';
        record.error = error.message;
        startSettled = true;
        clearTimeout(timer);
        rejectStart(error);
      }
    });

    child.on('exit', (code, signal) => {
      record.exitCode = code;
      record.signal = signal;
      record.exitedAt = new Date().toISOString();
      if (record.state === 'ready' || record.state === 'stopping') {
        record.state = 'exited';
        // Stopped before it was ever ready: settle start, which was still
        // waiting for a ready line that will now never come.
        failStart(new Error(`Service was stopped before it was ready (code ${code ?? 'null'}, signal ${signal ?? 'null'}).`));
      } else if (record.state === 'starting') {
        record.state = 'failed';
        record.error = `Service exited before it was ready (code ${code ?? 'null'}, signal ${signal ?? 'null'}).`;
        failStart(new Error(record.error));
      }
    });

    // stdout and stderr both go to the log stream, always: pipes are drained
    // forever so a full pipe can never block the program. stdout is split
    // into lines only until ready.
    child.stderr?.on('data', (chunk: Buffer) => {
      logStream.write(chunk);
    });
    let lineBuffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      logStream.write(chunk);
      if (startSettled) {
        return;
      }
      const lines = (lineBuffer + chunk.toString('utf8')).split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (isReadyLine(line)) {
          markReady();
          return;
        }
      }
    });

    function isReadyLine(line: string): boolean {
      const trimmed = line.trim();
      return trimmed === SERVICE_READY_LINE || trimmed.startsWith(`${SERVICE_READY_LINE} `);
    }

    function markReady(): void {
      record.readyAt = new Date().toISOString();
      record.state = 'ready';
      startSettled = true;
      clearTimeout(timer);
      resolveStart({ ...record });
    }

    function failStart(error: Error): void {
      if (startSettled) {
        return;
      }
      startSettled = true;
      clearTimeout(timer);
      rejectStart(error);
    }

    child.on('close', () => {
      // Stream end may hold a final un-newlined ready line.
      if (!startSettled && isReadyLine(lineBuffer)) {
        markReady();
      }
      logStream.end();
    });

    return startPromise;
  }

  list(): ServiceRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  get(id: string): ServiceRecord | undefined {
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  async stop(id: string): Promise<ServiceRecord | undefined> {
    const record = this.records.get(id);
    if (!record) {
      return undefined;
    }
    const child = this.children.get(id);
    if (!child) {
      return { ...record };
    }
    if (record.state === 'starting' || record.state === 'ready') {
      record.state = 'stopping';
      record.stoppedBy = 'person';
      // TERM to the tree, KILL after the grace: the same rules as a timed-out
      // shell.run.
      await supervision.terminateTreeOf(child, SERVICE_STOP_GRACE_MS);
      await waitExit(child, SERVICE_STOP_GRACE_MS + 2000);
    } else if (supervision.active) {
      // Already exited: stop once more, so any member of its group or tree
      // that outlived the root is stopped. Only under supervision, where the
      // tree was adopted at spawn with the root's start time: unsupervised,
      // terminateTreeOf would adopt on demand by pid, and the exited root's
      // pid may already belong to a stranger.
      await supervision.terminateTreeOf(child, SERVICE_STOP_GRACE_MS);
    }
    return { ...record };
  }
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    // Probing binds 127.0.0.1 only: Conduit never opens 0.0.0.0 for itself.
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1' }, () => {
      server.close(() => resolve(true));
    });
  });
}

export const serviceRegistry = new ServiceRegistry();
