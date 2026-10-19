import { supervision } from '../runtime/process-tree.js';

export interface ParentWatchdogOptions {
  intervalMs?: number;
  graceMs?: number;
}

export function startParentWatchdogFromEnv(options?: ParentWatchdogOptions): void {
  const rawParentPid = process.env.CONDUIT_PARENT_PID;
  if (!rawParentPid) {
    return;
  }

  const parentPid = Number.parseInt(rawParentPid, 10);
  if (!Number.isFinite(parentPid) || parentPid <= 1) {
    console.error(`[Conduit watchdog] Invalid CONDUIT_PARENT_PID: ${rawParentPid}`);
    process.exit(1);
  }

  const intervalMs = options?.intervalMs ?? 1000;
  const graceMs = options?.graceMs ?? 3000;
  supervision.activate();

  let stopping = false;
  const stop = (signalGraceMs: number, exitCode: number): void => {
    if (stopping) {
      return; // the interval keeps ticking while stopAll is awaited
    }
    stopping = true;
    void supervision.stopAll(signalGraceMs).finally(() => process.exit(exitCode));
  };

  // Stop all / Quit in the app SIGTERMs every process of the service tree it
  // observed. Supervised children lead their own process groups, so a
  // `nohup cmd &` the app never saw is outside its tree: the service stops
  // its trees itself (2 s grace stays inside the app's 3 s TERM->KILL
  // grace). `on`, not `once`: the same TERM often arrives twice (directly
  // and relayed by a tsx wrapper), and a second one must not fall through to
  // the default action and kill the service mid-stop.
  process.on('SIGTERM', () => stop(2000, 143));
  process.on('SIGHUP', () => stop(2000, 129));

  const interval = setInterval(() => {
    if (isProcessAlive(parentPid)) {
      supervision.observe();
      return;
    }
    if (stopping) {
      return;
    }
    console.error(`[Conduit watchdog] Parent process ${parentPid} is gone. Stopping Conduit service.`);
    console.error('[Conduit watchdog] Stopping supervised children.');
    stop(graceMs, 0);
  }, intervalMs);
  interval.unref();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
