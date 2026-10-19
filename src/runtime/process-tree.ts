// Process-tree supervision for the Node services, ported from
// macos/ConduitMenuBar/Sources/ConduitMenuBarCore/ProcessTreeKill.swift and
// kept in step with it (see the callouts in the Swift file comment).
//
// Membership rules (identical to the Swift side): a process belongs to a
// service tree when, in the current process table,
//   - it is the root itself (same pid and start time);
//   - it is in the root's process group, and that group is still the one the
//     root created. While the root is alive with its start time the group is
//     certainly ours. Once the root has exited, a group member counts only if
//     it started no later than the newest start time confirmed while the root
//     was still alive, or - an extension over the Swift rules - while every
//     observation since the root was alive has still found the group
//     non-empty (`groupContinuous`): a pid that is a live process-group id is
//     never reused, so a group seen non-empty at every observation since the
//     root was alive is still the original group. Residual: a stranger could
//     have received the root's pid and re-created the group between two
//     observations (one 1 s poll apart);
//   - it was seen as a member at an earlier observation and is still alive
//     with the same start time (a child that called setsid(2) and whose
//     parent then exited);
//   - or it descends (by parent pid) from any of the above.
//
// Every signal goes to a (pid, start time) identity whose start time is
// re-read immediately before kill(2), so a reused pid is never signalled.

import { execFileSync, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

/** A process as the kernel reports it. `startTime` is a number that,
 * together with `pid`, names one process for its whole life. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  startTime: number;
}

/** The process table and kill(2), behind an interface so membership and
 * signalling rules can be tested with fake processes. */
export interface ProcessTable {
  /** Every process, or [] when the read failed. */
  entries(): ProcessEntry[];
  /** One process, or undefined when no process has this pid. Zombies are
   * left out unless `includeZombie` (adoption reads a child that may already
   * have exited but not yet been reaped: its pid and group are still held). */
  entry(pid: number, options?: { includeZombie?: boolean }): ProcessEntry | undefined;
  /** kill(2). True when the signal was delivered. */
  send(signal: NodeJS.Signals, pid: number): boolean;
}

function identityOf(entry: { pid: number; startTime: number }): string {
  return `${entry.pid}:${entry.startTime}`;
}

/** The membership of one service tree, carried from adoption to the last
 * SIGKILL. Port of Swift's `ProcessTreeTracker` plus the `groupContinuous`
 * extension described in the file comment. */
export class ProcessTreeTracker {
  readonly root: { pid: number; startTime: number };
  /** The root leads its own process group. When false the group is shared
   * with something else, so group membership is never used. */
  readonly ownsGroup: boolean;
  /** Members seen at earlier observations, pruned when they exit. */
  readonly seen = new Map<string, ProcessEntry>();
  /** The newest start time in the table at the last observation where the
   * root was alive. Group members that started later are not trusted once
   * the root is gone. */
  groupConfirmedThrough: number;
  /** Extension: while true, group members are trusted even after the root
   * has exited, as long as every observation keeps finding the group
   * non-empty. Never becomes true again once it has gone false. */
  groupContinuous = true;
  /** Pids never to walk through when computing members: empty for the
   * service's own tree, the service's own pid for adopted children (the
   * service is their parent, so a corrupt table claiming a descendant link
   * must not pull the service in). */
  membershipExcluding: Set<number> = new Set<number>();

  constructor(root: ProcessEntry, options?: { useGroup?: boolean }) {
    this.root = { pid: root.pid, startTime: root.startTime };
    this.ownsGroup = options?.useGroup !== false && root.pgid === root.pid;
    this.seen.set(identityOf(root), root);
    this.groupConfirmedThrough = root.startTime;
  }

  /** The tree's members in this snapshot of the process table. */
  members(entries: ProcessEntry[], excluding?: Set<number>): ProcessEntry[] {
    const skip = excluding ?? this.membershipExcluding;
    const byPid = new Map<number, ProcessEntry>();
    for (const entry of entries) {
      if (!byPid.has(entry.pid)) {
        byPid.set(entry.pid, entry);
      }
    }
    const found = new Map<number, ProcessEntry>();
    const add = (entry: ProcessEntry): void => {
      if (entry.pid <= 1 || skip.has(entry.pid) || found.has(entry.pid)) {
        return;
      }
      found.set(entry.pid, entry);
    };

    // Members seen at earlier observations, identity-checked.
    for (const entry of this.seen.values()) {
      const current = byPid.get(entry.pid);
      if (current && current.startTime === entry.startTime) {
        add(current);
      }
    }
    if (this.ownsGroup) {
      const rootEntry = byPid.get(this.root.pid);
      const rootAlive = rootEntry !== undefined && rootEntry.startTime === this.root.startTime;
      if (rootAlive || rootEntry === undefined) {
        for (const entry of entries) {
          if (entry.pgid !== this.root.pid) {
            continue;
          }
          const newestConfirmed = this.groupConfirmedThrough;
          if (rootAlive
            || entry.startTime <= newestConfirmed
            || this.groupContinuous) {
            add(entry);
          }
        }
      }
    }
    // Descendants of members, to a fixed point. Parent links are only
    // followed from live, identity-checked members, so a reused parent pid
    // cannot pull in strangers.
    const children = new Map<number, ProcessEntry[]>();
    for (const entry of entries) {
      const list = children.get(entry.ppid);
      if (list) {
        list.push(entry);
      } else {
        children.set(entry.ppid, [entry]);
      }
    }
    const frontier = [...found.keys()];
    while (frontier.length > 0) {
      const pid = frontier.pop() as number;
      for (const child of children.get(pid) ?? []) {
        if (found.has(child.pid)) {
          continue;
        }
        add(child);
        if (found.has(child.pid)) {
          frontier.push(child.pid);
        }
      }
    }
    return [...found.values()].sort((a, b) => a.pid - b.pid);
  }

  /** Remembers the current members (so one that later detaches with setsid
   * is still found) and forgets members that exited. An empty table means
   * the read failed, so nothing is forgotten. */
  observe(entries: ProcessEntry[], excluding?: Set<number>): void {
    if (entries.length === 0) {
      return;
    }
    const rootEntry = entries.find((entry) => entry.pid === this.root.pid);
    const rootAlive = rootEntry !== undefined && rootEntry.startTime === this.root.startTime;
    if (rootAlive) {
      let newest = entries[0]!.startTime;
      for (const entry of entries) {
        if (entry.startTime > newest) {
          newest = entry.startTime;
        }
      }
      this.groupConfirmedThrough = Math.max(this.groupConfirmedThrough, newest);
      // `groupContinuous` stays whatever it was: it can only ever go false
      // (after the root is gone), never back to true.
    } else if (this.groupContinuous && !entries.some((entry) => entry.pgid === this.root.pid)) {
      this.groupContinuous = false;
    }
    const live = new Set(entries.map(identityOf));
    for (const key of this.seen.keys()) {
      if (!live.has(key)) {
        this.seen.delete(key);
      }
    }
    for (const member of this.members(entries, excluding)) {
      this.seen.set(identityOf(member), member);
    }
  }
}

/** Every tree one service has launched and that still has live members.
 * Port of Swift's `ProcessTreeSet`. */
export class ProcessTreeSet {
  trees: ProcessTreeTracker[] = [];

  get isEmpty(): boolean {
    return this.trees.length === 0;
  }

  /** A new tree. Earlier trees are kept. */
  adopt(root: ProcessEntry, options?: { useGroup?: boolean }): ProcessTreeTracker {
    const tracker = new ProcessTreeTracker(root, options);
    this.trees.push(tracker);
    return tracker;
  }

  /** Records members of every tree and drops trees with none left. */
  observe(entries: ProcessEntry[], excluding?: Set<number>): void {
    if (entries.length === 0) {
      return;
    }
    for (const tree of this.trees) {
      tree.observe(entries, excluding);
    }
    this.trees = this.trees.filter((tree) => tree.members(entries).length > 0);
  }
}

/** Send `signal` to each (pid, start time) identity whose pid still names
 * the same process (start time re-read just before kill(2)). Returns the
 * identities signalled. */
export function sendToIdentities(
  signal: NodeJS.Signals,
  identities: ProcessEntry[],
  table: ProcessTable,
  excluding: Set<number>
): ProcessEntry[] {
  const sent: ProcessEntry[] = [];
  for (const identity of identities) {
    if (identity.pid <= 1 || excluding.has(identity.pid)) {
      continue;
    }
    const current = table.entry(identity.pid);
    if (!current || current.startTime !== identity.startTime) {
      continue;
    }
    if (table.send(signal, identity.pid)) {
      sent.push(current);
    }
  }
  return sent;
}

interface Identity {
  pid: number;
  startTime: number;
}

function includeUnseen(target: ProcessEntry[], source: ProcessEntry[]): void {
  const known = new Set(target.map(identityOf));
  for (const entry of source) {
    if (!known.has(identityOf(entry))) {
      target.push(entry);
    }
  }
}

function identityAlive(identity: Identity, table: ProcessTable): boolean {
  const current = table.entry(identity.pid);
  return current !== undefined && current.startTime === identity.startTime;
}

/** Stop: phase 1 TERMs every member of every tree (identity-checked, never
 * `excluding`), waits for them to exit or for the grace to elapse, then
 * phase 2 SIGKILLs whatever is still around on a fresh snapshot, plus
 * phase-1 identities that are still the same processes. */
export async function terminateTrees(
  set: ProcessTreeSet,
  table: ProcessTable,
  options: { graceMs: number; excluding: Set<number>; pollMs?: number }
): Promise<{ termed: ProcessEntry[]; killed: ProcessEntry[] }> {
  const pollMs = options.pollMs ?? 100;
  // Phase 1: record members first, so the SIGKILL phase remembers them even
  // if their membership changes later.
  const entries = table.entries();
  set.observe(entries);
  const termed: ProcessEntry[] = [];
  for (const tree of set.trees) {
    includeUnseen(termed, tree.members(entries));
  }
  const delivered = sendToIdentities('SIGTERM', termed, table, options.excluding);

  // Wait for the TERMed processes to exit, or for the grace to elapse.
  // Nothing was signalled (the trees are empty): no wait, go straight to
  // phase 2.
  // Only what was actually signalled is waited for: `termed` can include an
  // excluded pid (the service itself is the root of its own tree), which
  // never exits here and would otherwise always use up the whole grace.
  const deadline = Date.now() + options.graceMs;
  while (delivered.length > 0
    && Date.now() < deadline
    && delivered.some((identity) => identityAlive(identity, table))) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  // Phase 2: fresh observations. The current members of every tree (which
  // covers children forked during the grace) plus phase-1 identities still
  // alive with the same start time; sendToIdentities skips reused pids.
  const fresh = table.entries();
  set.observe(fresh);
  const targets = [...termed];
  for (const tree of set.trees) {
    includeUnseen(targets, tree.members(fresh));
  }
  const killed = sendToIdentities('SIGKILL', targets, table, options.excluding);
  return { termed, killed };
}

/** The real process table: /proc on Linux, `ps` elsewhere, no native
 * addons. On win32 the table is empty (no process groups there); the tree
 * kill is a no-op and the old behaviour remains. */
export class KernelProcessTable implements ProcessTable {
  entries(): ProcessEntry[] {
    if (process.platform === 'win32') {
      return [];
    }
    if (process.platform === 'linux') {
      return this.linuxEntries();
    }
    return this.psEntries();
  }

  entry(pid: number, options?: { includeZombie?: boolean }): ProcessEntry | undefined {
    if (pid <= 0 || process.platform === 'win32') {
      return undefined;
    }
    const includeZombie = options?.includeZombie === true;
    if (process.platform === 'linux') {
      return readLinuxEntry(pid, includeZombie);
    }
    return this.psEntries(['-p', String(pid)], includeZombie).find((entry) => entry.pid === pid);
  }

  send(signal: NodeJS.Signals, pid: number): boolean {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  private linuxEntries(): ProcessEntry[] {
    try {
      const entries: ProcessEntry[] = [];
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) {
          continue;
        }
        const entry = readLinuxEntry(Number(name));
        if (entry) {
          entries.push(entry);
        }
      }
      return entries.sort((a, b) => a.pid - b.pid);
    } catch {
      // A failed read looks like an empty table, which observe() ignores.
      return [];
    }
  }

  /** `ps` on macOS/BSD. Any error returns [] (a failed read). */
  private psEntries(selection: string[] = ['-A'], includeZombie = false): ProcessEntry[] {
    let output: string;
    try {
      output = execFileSync('ps', [...selection, '-o', 'pid=,ppid=,pgid=,stat=,lstart='],
        {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C' },
          timeout: 5000
        });
    } catch {
      return [];
    }
    const entries: ProcessEntry[] = [];
    for (const line of output.split('\n')) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 9) {
        continue;
      }
      if (!includeZombie && fields[3]!.startsWith('Z')) {
        continue;
      }
      const entry: ProcessEntry = {
        pid: Number(fields[0]),
        ppid: Number(fields[1]),
        pgid: Number(fields[2]),
        startTime: parseLstartMs(fields.slice(4).join(' '))
      };
      if ([entry.pid, entry.ppid, entry.pgid, entry.startTime].every(Number.isFinite)) {
        entries.push(entry);
      }
    }
    return entries.sort((a, b) => a.pid - b.pid);
  }
}

/** `/proc/<pid>/stat`. Fields after the LAST `)` are: state (index 0),
 * ppid (1), pgrp (2), ... starttime (19, field 22 overall). */
function readLinuxEntry(pid: number, includeZombie = false): ProcessEntry | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = text.lastIndexOf(')');
    if (close < 0) {
      return undefined;
    }
    const fields = text.slice(close + 1).trim().split(/\s+/);
    const state = fields[0];
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    const startTime = Number(fields[19]);
    if ((state === 'Z' && !includeZombie) || !Number.isFinite(ppid) || !Number.isFinite(pgid)
      || !Number.isFinite(startTime)) {
      return undefined;
    }
    return { pid, ppid, pgid, startTime };
  } catch {
    return undefined;
  }
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
};

/** "Mon Oct 19 11:01:29 2026" to epoch ms (seconds resolution). */
function parseLstartMs(lstart: string): number {
  const parts = lstart.trim().split(/\s+/);
  if (parts.length !== 5) {
    return Number.NaN;
  }
  const year = Number(parts[4]);
  const clock = parts[3]!.split(':').map(Number);
  const month = MONTHS[parts[1] ?? ''];
  const day = Number(parts[2]);
  if (month === undefined || clock.length !== 3) {
    return Number.NaN;
  }
  return Date.UTC(year, month, day, clock[0] ?? 0, clock[1] ?? 0, clock[2] ?? 0);
}

// -- Supervision of the running service -------------------------------------

/** What the service uses to supervise everything it spawns. */
export interface Supervision {
  readonly active: boolean;
  /** Called by the parent watchdog when CONDUIT_PARENT_PID is set. */
  activate(): void;
  /** Options for exec/spawn: under supervision the child leads its own
   * process group (Node's `detached` calls setsid(2): a new session whose
   * group id is the child's pid), so a `cmd &` or
   * `nohup cmd &` grandchild keeps that group after the shell exits and can
   * be found later by the group rule. Not supervised (terminal use):
   * detached off, so Ctrl-C still reaches children through the terminal's
   * process group exactly as before. */
  childSpawnOptions(): { detached: boolean };
  /** Adds a tracker for everything the child will ever run. A no-op when
   * not active (nothing would observe or prune it); terminateTreeOf adopts
   * on demand instead. */
  adopt(child: ChildProcess): void;
  /** Observes the adopted trees plus the service's own tree. Cheap no-op
   * while nothing was adopted. */
  observe(): void;
  /** TERMs (grace) then KILLs the service's own descendants and every
   * adopted child's tree, never the service itself. Never throws. */
  stopAll(graceMs?: number): Promise<void>;
  /** TERM->grace->KILL just the tree adopted for this child (a timed-out
   * shell.run). Never throws. */
  terminateTreeOf(child: ChildProcess, graceMs?: number): Promise<void>;
}

export function createSupervision(
  table: ProcessTable,
  platform: NodeJS.Platform = process.platform,
  selfPid: number = process.pid
): Supervision {
  let active = false;
  const set = new ProcessTreeSet();
  const trackerByPid = new Map<number, ProcessTreeTracker>();
  let selfTracker: ProcessTreeTracker | undefined;

  const ensureSelfTracker = (): ProcessTreeTracker | undefined => {
    if (selfTracker) {
      return selfTracker;
    }
    // The service does not own its group (the app launches it as
    // zsh -> npm -> node, and npm leads the group), so its members are just
    // its descendants. Its own pid is still included in members (so
    // descendants are walked from it) but is excluded when signalling.
    const entry = table.entry(selfPid);
    if (!entry) {
      return undefined;
    }
    selfTracker = new ProcessTreeTracker(entry, { useGroup: false });
    return selfTracker;
  };

  // Forget index entries whose tree the set has dropped (nothing left).
  const pruneIndex = (): void => {
    const live = new Set(set.trees);
    for (const [pid, tracker] of trackerByPid) {
      if (!live.has(tracker)) {
        trackerByPid.delete(pid);
      }
    }
  };

  return {
    get active(): boolean {
      return active;
    },
    activate(): void {
      active = true;
    },
    childSpawnOptions(): { detached: boolean } {
      return { detached: active && platform !== 'win32' };
    },
    adopt(child: ChildProcess): void {
      // Not supervised (terminal use): nothing observes or prunes the set,
      // so adopting would only grow it. terminateTreeOf adopts on demand.
      if (!active) {
        return;
      }
      const pid = child.pid;
      if (pid === undefined || pid <= 1) {
        return;
      }
      const entry = table.entry(pid, { includeZombie: true });
      if (!entry) {
        return;
      }
      const existing = trackerByPid.get(pid);
      if (existing && existing.root.startTime === entry.startTime) {
        return;
      }
      if (existing) {
        // An earlier child with this pid is gone; keep its tree (it may have
        // members left) but index the new child.
        trackerByPid.delete(pid);
      }
      const tracker = new ProcessTreeTracker(entry, { useGroup: true });
      // The tree walk must never come back across the service itself.
      tracker.membershipExcluding = new Set([selfPid]);
      set.trees.push(tracker);
      trackerByPid.set(pid, tracker);
    },
    observe(): void {
      if (!active || set.isEmpty) {
        return;
      }
      const entries = table.entries();
      if (entries.length === 0) {
        return;
      }
      set.observe(entries);
      pruneIndex();
      const self = ensureSelfTracker();
      if (self) {
        self.observe(entries);
      }
    },
    async stopAll(graceMs = 3000): Promise<void> {
      try {
        let entries: ProcessEntry[] = [];
        try {
          entries = table.entries();
        } catch {
          entries = [];
        }
        if (entries.length > 0) {
          set.observe(entries);
          const self = ensureSelfTracker();
          if (self) {
            self.observe(entries);
          }
        }
        // Adopted trees plus the service's own tree. Never signals
        // `selfPid` itself.
        const stopSet = new ProcessTreeSet();
        for (const tree of set.trees) {
          stopSet.trees.push(tree);
        }
        const self = ensureSelfTracker();
        if (self) {
          stopSet.trees.push(self);
        }
        await terminateTrees(stopSet, table, { graceMs, excluding: new Set([selfPid]) });
      } catch {
        // Stopping is best effort; never propagate to the caller.
      }
    },
    async terminateTreeOf(child: ChildProcess, graceMs = 3000): Promise<void> {
      try {
        const pid = child.pid;
        if (pid === undefined) {
          return;
        }
        const tracker = trackerByPid.get(pid);
        const treeSet = new ProcessTreeSet();
        if (!tracker) {
          // Adoption missed the spawn (entry not readable then): adopt now.
          const entry = table.entry(pid, { includeZombie: true });
          if (entry) {
            const fresh = new ProcessTreeTracker(entry, { useGroup: true });
            fresh.membershipExcluding = new Set([selfPid]);
            trackerByPid.set(pid, fresh);
            treeSet.trees.push(fresh);
          }
        } else {
          treeSet.trees.push(tracker);
        }
        if (treeSet.isEmpty) {
          return;
        }
        await terminateTrees(treeSet, table, { graceMs, excluding: new Set([selfPid]) });
      } catch {
        // Best effort, like stopAll.
      }
    }
  };
}

export const supervision = createSupervision(new KernelProcessTable());
