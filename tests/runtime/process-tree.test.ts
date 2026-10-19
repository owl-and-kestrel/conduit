import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import {
  ProcessTreeSet,
  ProcessTreeTracker,
  terminateTrees,
  createSupervision,
  type ProcessEntry,
  type ProcessTable
} from '../../src/runtime/process-tree.js';

/** A stand-in for node's ChildProcess used with the fake table. */
const fakeChild: ChildProcess = { pid: 200 } as unknown as ChildProcess;

/** A process table made of fake processes: nothing real is signalled. */
class FakeProcessTable implements ProcessTable {
  readonly processes = new Map<number, ProcessEntry>();
  readonly sent: { signal: NodeJS.Signals; pid: number }[] = [];
  listingFails = false;
  /** Processes exit as soon as they receive SIGTERM. */
  exitOnTerm = false;
  /** Runs after entries() has taken its nth snapshot: what happens between
   * the listing and the signals. */
  onEntries?: (table: FakeProcessTable, call: number) => void;

  constructor(entries: ProcessEntry[] = []) {
    for (const entry of entries) {
      this.processes.set(entry.pid, entry);
    }
  }

  entries(): ProcessEntry[] {
    const snapshot = this.listingFails
      ? []
      : [...this.processes.values()].sort((a, b) => a.pid - b.pid);
    if (this.onEntries) {
      this.onEntries(this, this.entriesCalls);
    }
    this.entriesCalls += 1;
    return snapshot;
  }

  entriesCalls = 0;

  entry(pid: number): ProcessEntry | undefined {
    return this.processes.get(pid);
  }

  send(signal: NodeJS.Signals, pid: number): boolean {
    if (!this.processes.has(pid)) {
      return false;
    }
    this.sent.push({ signal, pid });
    if (this.exitOnTerm && signal === 'SIGTERM') {
      this.exit(pid);
    }
    return true;
  }

  add(entry: ProcessEntry): void {
    this.processes.set(entry.pid, entry);
  }

  exit(pid: number): void {
    const orphans = [...this.processes.values()].filter((e) => e.ppid === pid);
    this.processes.delete(pid);
    for (const orphan of orphans) {
      this.processes.set(orphan.pid, { ...orphan, ppid: 1 });
    }
  }

  pids(signal: NodeJS.Signals): number[] {
    return this.sent.filter((s) => s.signal === signal).map((s) => s.pid);
  }
}

// The service (pid 50, same role as the app's pid in the Swift tests)
// launched the root 100, leader of group 100.
const APP_PID = 50;
const appEntry: ProcessEntry = { pid: APP_PID, ppid: 1, pgid: 50, startTime: 10 };
const root: ProcessEntry = { pid: 100, ppid: APP_PID, pgid: 100, startTime: 1000 };
const node: ProcessEntry = { pid: 101, ppid: 100, pgid: 100, startTime: 1001 };
const stranger: ProcessEntry = { pid: 300, ppid: 1, pgid: 300, startTime: 500 };

describe('ProcessTreeTracker', () => {
  it('finds direct descendants', () => {
    const table = new FakeProcessTable([appEntry, root, node]);
    table.add({ pid: 120, ppid: 101, pgid: 120, startTime: 1100 });
    const tracker = new ProcessTreeTracker(root, { useGroup: false });
    expect(tracker.members(table.entries(), new Set([APP_PID])).map((e) => e.pid))
      .toEqual([100, 101, 120]);
  });

  it('finds a group member re-parented to pid 1 while the root is alive', () => {
    const table = new FakeProcessTable([appEntry, root, node, stranger]);
    table.add({ pid: 102, ppid: 1, pgid: 100, startTime: 1002 });
    const tracker = new ProcessTreeTracker(root);
    const members = tracker.members(table.entries(), new Set([APP_PID]));
    expect(members.map((e) => e.pid)).toEqual([100, 101, 102]);
    expect(members.some((e) => e.pid === stranger.pid)).toBe(false);
  });

  it('counts a group member after the root exits while the group stayed continuous', () => {
    const daemon: ProcessEntry = { pid: 102, ppid: 1, pgid: 100, startTime: 1002 };
    const table = new FakeProcessTable([appEntry, root, node, daemon]);
    const tracker = new ProcessTreeTracker(root);
    tracker.observe(table.entries(), new Set([APP_PID]));
    table.exit(100);
    table.exit(101);
    tracker.observe(table.entries(), new Set([APP_PID]));
    expect(tracker.groupContinuous).toBe(true);

    // A later group member that started before the last confirmed
    // observation is still trusted.
    const laterDaemon: ProcessEntry = { pid: 103, ppid: 102, pgid: 100, startTime: 1003 };
    table.add(laterDaemon);
    tracker.observe(table.entries(), new Set([APP_PID]));
    expect(tracker.members(table.entries(), new Set([APP_PID])).map((e) => e.pid))
      .toEqual([102, 103]);
  });

  it('does not trust a group the root pid re-created after the group emptied', () => {
    const table = new FakeProcessTable([appEntry, root, node]);
    const tracker = new ProcessTreeTracker(root);
    tracker.observe(table.entries(), new Set([APP_PID]));
    // The whole tree exits; pid 100 is later reused by a stranger that
    // leads a new group 100 and forks into it.
    table.exit(101);
    table.exit(100);
    tracker.observe(table.entries(), new Set([APP_PID]));
    expect(tracker.groupContinuous).toBe(false);

    table.add({ pid: 130, ppid: 100, pgid: 100, startTime: 5001 });
    expect(tracker.members(table.entries(), new Set([APP_PID]))).toEqual([]);
  });

  it('still counts a member seen earlier after its parent exits (setsid scenario)', () => {
    const table = new FakeProcessTable([appEntry, root, node]);
    const tracker = new ProcessTreeTracker(root);
    table.add({ pid: 110, ppid: 101, pgid: 110, startTime: 1010 });
    tracker.observe(table.entries(), new Set([APP_PID]));
    table.exit(101);
    expect(tracker.members(table.entries(), new Set([APP_PID])).map((e) => e.pid))
      .toEqual([100, 110]);
  });

  it('ignores an empty snapshot (a failed read) instead of pruning', () => {
    const table = new FakeProcessTable([appEntry, root, node]);
    const tracker = new ProcessTreeTracker(root);
    tracker.observe(table.entries(), new Set([APP_PID]));
    table.exit(101);
    tracker.observe(table.entries(), new Set([APP_PID]));
    const seen = [...tracker.seen.keys()];
    tracker.observe([]);
    expect([...tracker.seen.keys()]).toEqual(seen);
  });
});

describe('terminateTrees', () => {
  it('never signals a reused pid', async () => {
    const table = new FakeProcessTable([appEntry, root, node]);
    const set = new ProcessTreeSet();
    set.adopt(root);
    set.observe(table.entries(), new Set([APP_PID]));
    let reused = false;
    table.onEntries = (current, call) => {
      // The second snapshot inside terminateTrees is phase 2 (the first was
      // the initial observation, the next phase 1): both exit and an
      // unrelated process gets pid 101 before the SIGKILL re-reads.
      if (call === 2 && !reused) {
        reused = true;
        current.exit(101);
        current.exit(100);
        current.add({ pid: 101, ppid: 1, pgid: 101, startTime: 9999 });
      }
    };

    const { killed } = await terminateTrees(set, table, {
      graceMs: 1,
      pollMs: 1,
      excluding: new Set([APP_PID])
    });
    expect(table.pids('SIGTERM')).toEqual([100, 101]);
    expect(killed).toEqual([]);
    expect(table.pids('SIGKILL')).toEqual([]);
  });

  it('kills survivors that ignored SIGTERM and never signals the service itself', async () => {
    // A corrupt table claims the service (pid 50) is in the tree.
    const table = new FakeProcessTable([
      { pid: APP_PID, ppid: 100, pgid: 100, startTime: 10 },
      root,
      node
    ]);
    const set = new ProcessTreeSet();
    set.adopt(root);
    set.observe(table.entries(), new Set([APP_PID]));

    const { killed } = await terminateTrees(set, table, {
      graceMs: 1,
      pollMs: 1,
      excluding: new Set([APP_PID])
    });
    expect(table.pids('SIGTERM')).toEqual([100, 101]);
    expect(killed.map((e) => e.pid)).toEqual([100, 101]);
    expect(table.pids('SIGKILL')).toEqual([100, 101]);
    expect(table.sent.some((s) => s.pid === APP_PID || s.pid === 1)).toBe(false);
  });
});

describe('supervision', () => {
  const shell: ProcessEntry = { pid: 200, ppid: APP_PID, pgid: 200, startTime: 2000 };

  function supervised(): { table: FakeProcessTable; sup: ReturnType<typeof createSupervision> } {
    const table = new FakeProcessTable([appEntry, root, node, shell]);
    const sup = createSupervision(table, 'darwin', APP_PID);
    sup.activate();
    return { table, sup };
  }

  it('spawns children detached only while active and off win32', () => {
    const idle = createSupervision(new FakeProcessTable(), 'darwin', APP_PID);
    expect(idle.childSpawnOptions()).toEqual({ detached: false });
    idle.activate();
    expect(idle.childSpawnOptions()).toEqual({ detached: true });
    const win = createSupervision(new FakeProcessTable(), 'win32', APP_PID);
    win.activate();
    expect(win.childSpawnOptions()).toEqual({ detached: false });
  });

  it('adopt uses the child process group and observation finds its members', () => {
    const { table, sup } = supervised();
    sup.adopt(fakeChild);
    table.add({ pid: 201, ppid: 200, pgid: 200, startTime: 2010 });
    sup.observe();
    // The service's own pid is never a member of an adopted tree walk.
    expect(table.entry(201)!.pgid).toBe(200);
    expect(sup.active).toBe(true);
  });

  it('stopAll TERMs and KILLs the adopted tree, never the service pid', async () => {
    const { table, sup } = supervised();
    sup.adopt(fakeChild);
    table.add({ pid: 201, ppid: 200, pgid: 200, startTime: 2010 });
    await sup.stopAll(1);
    expect(table.pids('SIGTERM')).toEqual(expect.arrayContaining([200, 201]));
    expect(table.pids('SIGKILL')).toEqual(expect.arrayContaining([200, 201]));
    expect(table.sent.some((s) => s.pid === APP_PID || s.pid <= 1)).toBe(false);
  });

  it('terminateTreeOf TERMs and then KILLs the adopted tree', async () => {
    const { table, sup } = supervised();
    sup.adopt(fakeChild);
    table.add({ pid: 201, ppid: 200, pgid: 200, startTime: 2010 });
    await sup.terminateTreeOf(fakeChild, 1);
    expect(table.pids('SIGTERM')).toContain(200);
    expect(table.pids('SIGKILL')).toContain(200);
    expect(table.sent.some((s) => s.pid === APP_PID)).toBe(false);
  });

  it('a failed table read stops nothing but throws nowhere', async () => {
    const table = new FakeProcessTable([appEntry]);
    table.listingFails = true;
    const sup = createSupervision(table, 'darwin', APP_PID);
    sup.activate();
    sup.adopt(fakeChild);
    await expect(sup.stopAll(1)).resolves.toBeUndefined();
  });

  it('stopAll returns once the signalled members exit, not after the whole grace', async () => {
    // The service's own tree always contains the (never signalled) service
    // pid; waiting on it would use up the whole grace every time.
    const { table, sup } = supervised();
    table.exitOnTerm = true;
    sup.adopt(fakeChild);
    const started = Date.now();
    await sup.stopAll(5000);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(table.pids('SIGTERM')).toContain(200);
    expect(table.pids('SIGKILL')).toEqual([]);
  });

  it('adopts nothing while not supervised (terminal use)', async () => {
    const table = new FakeProcessTable([appEntry, shell]);
    const sup = createSupervision(table, 'darwin', APP_PID);
    sup.adopt(fakeChild);
    await sup.stopAll(1);
    // Only the service's descendants are reached, through its own tree.
    expect(table.pids('SIGTERM')).toEqual([200]);
  });

  it('adopts a new child that reuses the pid of an earlier one', async () => {
    const { table, sup } = supervised();
    sup.adopt(fakeChild);
    table.exit(200);
    sup.observe();
    table.add({ pid: 200, ppid: APP_PID, pgid: 200, startTime: 7000 });
    table.add({ pid: 205, ppid: 1, pgid: 200, startTime: 7005 });
    sup.adopt(fakeChild);
    await sup.terminateTreeOf(fakeChild, 1);
    expect(table.pids('SIGTERM')).toEqual(expect.arrayContaining([200, 205]));
  });
});
