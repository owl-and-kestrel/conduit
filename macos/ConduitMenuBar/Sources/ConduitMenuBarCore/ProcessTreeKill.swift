import Darwin
import Foundation

// Which processes belong to a service tree this app launched, and how Stop all
// signals them without hitting anything else (review finding F-04).
// The Node services run the same rules in TypeScript:
// src/runtime/process-tree.ts.
//
// A launched service is `/bin/zsh -lc "... exec npm ..."` started with
// Foundation's Process, which makes the child the leader of a new process
// group (pgid == pid) in the app's session. A process counts as a member of
// that tree when, in the current process table:
//   - it is the root itself (same pid and start time);
//   - it is in the root's process group, and that group is still the one the
//     root created. This covers a double-forked or `nohup … &` child that was
//     re-parented to launchd but kept its group. While the root is alive with
//     its start time the group is certainly ours. Once the root has exited,
//     a group member counts only if it started no later than the newest
//     process seen at an observation where the root was still alive: XNU
//     never hands out a pid that is a live process-group id, so a stranger
//     can only re-create a group with the root's pid after the original
//     group has emptied, and anything in that new group started after it;
//   - it was seen as a member at an earlier observation (the supervisor
//     observes each tree on its 2 s poll) and is still alive with the same
//     start time. This covers a child that called setsid(2) (new session and
//     group) and whose parent then exited;
//   - or it descends (by parent pid) from any of the above.
//
// Residual, documented: a child that calls setsid and loses its parent
// between two observations is not found. macOS has no unprivileged
// equivalent of cgroups or NOTE_TRACK, and it does not return another
// process's environment (see ProcessProbe), so there is no inherited mark to
// find it by afterwards.
//
// Every signal is sent to a (pid, start time) identity and the start time is
// re-read immediately before kill(2), so a pid that was reused during the
// TERM→KILL grace (or since it was observed) is never signalled. The app's own
// pid, launchd and pid 0 are never signalled.

/// A process as the kernel reports it. `startTime` is microseconds since the
/// epoch, so together with `pid` it names one process for its whole life.
public struct ProcessEntry: Equatable {
    public let pid: Int32
    public let ppid: Int32
    public let pgid: Int32
    public let startTime: UInt64

    public init(pid: Int32, ppid: Int32, pgid: Int32, startTime: UInt64) {
        self.pid = pid
        self.ppid = ppid
        self.pgid = pgid
        self.startTime = startTime
    }

    public var identity: ProcessIdentity {
        ProcessIdentity(pid: pid, startTime: startTime)
    }
}

/// One process, robust to pid reuse.
public struct ProcessIdentity: Hashable {
    public let pid: Int32
    public let startTime: UInt64

    public init(pid: Int32, startTime: UInt64) {
        self.pid = pid
        self.startTime = startTime
    }
}

/// The process table and kill(2), behind a protocol so the membership and
/// signalling rules are tested with fake processes.
public protocol ProcessTable {
    /// Every process this user can signal.
    func entries() -> [ProcessEntry]
    /// One process, or nil when no process has this pid.
    func entry(pid: Int32) -> ProcessEntry?
    /// kill(2). True when the signal was delivered.
    @discardableResult
    func send(_ signal: Int32, to pid: Int32) -> Bool
}

/// The membership of one launched service tree, carried from launch to the
/// last SIGKILL. A value type: the deferred SIGKILL works on its own copy.
public struct ProcessTreeTracker: Equatable {
    public let root: ProcessIdentity
    /// The root leads its own process group (true for Foundation's Process).
    /// When false the group is shared with something else, so group
    /// membership is never used.
    public let ownsGroup: Bool
    /// Members seen at earlier observations, pruned when they exit.
    public private(set) var seen: Set<ProcessIdentity> = []
    /// The newest start time in the process table at the last observation
    /// where the root was alive. Group members that started later are not
    /// trusted once the root is gone (see the file comment).
    public private(set) var groupConfirmedThrough: UInt64

    public init(root: ProcessEntry) {
        self.root = root.identity
        self.ownsGroup = root.pgid == root.pid
        self.seen = [root.identity]
        self.groupConfirmedThrough = root.startTime
    }

    /// nil when the root has already gone (nothing left to identify it by).
    public init?(rootPid: Int32, table: ProcessTable) {
        guard let entry = table.entry(pid: rootPid) else {
            return nil
        }
        self.init(root: entry)
    }

    /// The tree's members in this snapshot of the process table. Never
    /// includes `excluding` (the app's own pid), launchd or pid 0.
    public func members(in entries: [ProcessEntry], excluding: Set<Int32> = [getpid()]) -> [ProcessIdentity] {
        let byPid = Dictionary(entries.map { ($0.pid, $0) }, uniquingKeysWith: { first, _ in first })
        var found: [Int32: ProcessEntry] = [:]
        func add(_ entry: ProcessEntry) {
            guard entry.pid > 1, !excluding.contains(entry.pid) else {
                return
            }
            found[entry.pid] = entry
        }

        for identity in seen {
            if let entry = byPid[identity.pid], entry.startTime == identity.startTime {
                add(entry)
            }
        }
        if ownsGroup {
            let rootAlive = byPid[root.pid]?.startTime == root.startTime
            for entry in entries where entry.pgid == root.pid
                && (rootAlive || (byPid[root.pid] == nil && entry.startTime <= groupConfirmedThrough)) {
                add(entry)
            }
        }
        // Descendants of members, to a fixed point. Parent links are only
        // followed from live, identity-checked members, so a reused parent pid
        // cannot pull in strangers.
        var children: [Int32: [ProcessEntry]] = [:]
        for entry in entries {
            children[entry.ppid, default: []].append(entry)
        }
        var frontier = Array(found.keys)
        while let pid = frontier.popLast() {
            for child in children[pid] ?? [] where found[child.pid] == nil {
                add(child)
                if found[child.pid] != nil {
                    frontier.append(child.pid)
                }
            }
        }
        return found.values
            .sorted { $0.pid < $1.pid }
            .map(\.identity)
    }

    /// Remembers the current members (so a member that later detaches with
    /// setsid is still found) and forgets members that have exited.
    /// An empty table means the read failed (this app is always in it), so
    /// nothing is forgotten.
    public mutating func observe(_ entries: [ProcessEntry], excluding: Set<Int32> = [getpid()]) {
        guard !entries.isEmpty else {
            return
        }
        if entries.contains(where: { $0.identity == root }), let newest = entries.map(\.startTime).max() {
            groupConfirmedThrough = max(groupConfirmedThrough, newest)
        }
        let live = Set(entries.map(\.identity))
        seen = seen.filter { live.contains($0) }
        seen.formUnion(members(in: entries, excluding: excluding))
    }
}

public enum ProcessSignals {
    /// Sends `signal` to each identity whose pid still names the same process
    /// (start time re-read just before kill). Returns the identities signalled.
    @discardableResult
    public static func send(_ signal: Int32, to identities: [ProcessIdentity], table: ProcessTable, excluding: Set<Int32> = [getpid()]) -> [ProcessIdentity] {
        var signalled: [ProcessIdentity] = []
        for identity in identities where identity.pid > 1 && !excluding.contains(identity.pid) {
            guard let current = table.entry(pid: identity.pid), current.startTime == identity.startTime else {
                continue
            }
            if table.send(signal, to: identity.pid) {
                signalled.append(identity)
            }
        }
        return signalled
    }

    /// Stop all, phase 1: SIGTERM every member except the root (the caller
    /// terminates its own Process). Records the members first, so the
    /// returned tracker also knows them for phase 2.
    public static func terminate(_ tracker: inout ProcessTreeTracker, table: ProcessTable, excluding: Set<Int32> = [getpid()]) -> [ProcessIdentity] {
        let entries = table.entries()
        tracker.observe(entries, excluding: excluding)
        let members = tracker.members(in: entries, excluding: excluding)
        send(SIGTERM, to: members.filter { $0 != tracker.root }, table: table, excluding: excluding)
        return members
    }

    /// Stop all, phase 2, after the grace: SIGKILL whatever is still a member,
    /// including children forked during the grace, plus phase-1 members that
    /// are still the same processes. A reused pid is skipped.
    @discardableResult
    public static func killSurvivors(_ tracker: ProcessTreeTracker, termed: [ProcessIdentity], table: ProcessTable, excluding: Set<Int32> = [getpid()]) -> [ProcessIdentity] {
        var current = tracker
        let entries = table.entries()
        current.observe(entries, excluding: excluding)
        var targets = current.members(in: entries, excluding: excluding)
        for identity in termed where !targets.contains(identity) {
            targets.append(identity)
        }
        return send(SIGKILL, to: targets, table: table, excluding: excluding)
    }

    /// SIGTERM a process this app keeps no tracker for (a previous run's
    /// listener being replaced, a timed-out CLI command) together with its
    /// tree, by the same membership rule as Stop all applied to one snapshot
    /// of the process table: its descendants and, when it leads its own
    /// process group, that group's members. The root is signalled last, and
    /// every signal is checked against the start time seen in the snapshot,
    /// so a pid that exited and was reused in between is skipped. No SIGKILL
    /// follows: the callers wait for the port to clear or the command to
    /// exit. Returns the identities signalled.
    @discardableResult
    public static func terminateTree(rootPid: Int32, table: ProcessTable, excluding: Set<Int32> = [getpid()]) -> [ProcessIdentity] {
        guard rootPid > 1, !excluding.contains(rootPid) else {
            return []
        }
        var entries = table.entries()
        // A failed listing still signals the root itself, as kill(2) on the
        // pid alone did before.
        guard let root = entries.first(where: { $0.pid == rootPid }) ?? table.entry(pid: rootPid) else {
            return []
        }
        if !entries.contains(where: { $0.pid == rootPid }) {
            entries.append(root)
        }
        let members = ProcessTreeTracker(root: root).members(in: entries, excluding: excluding)
        let rootLast = members.filter { $0 != root.identity } + members.filter { $0 == root.identity }
        return send(SIGTERM, to: rootLast, table: table, excluding: excluding)
    }
}

/// The real process table: libproc, no subprocesses.
public struct KernelProcessTable: ProcessTable {
    public init() {}

    public func entries() -> [ProcessEntry] {
        let uid = geteuid()
        // proc_listpids reports the byte count it needs; leave headroom for
        // processes started between the two calls.
        let needed = proc_listpids(UInt32(PROC_UID_ONLY), UInt32(uid), nil, 0)
        guard needed > 0 else {
            return []
        }
        let capacity = Int(needed) / MemoryLayout<pid_t>.size + 64
        var pids = [pid_t](repeating: 0, count: capacity)
        let filled = pids.withUnsafeMutableBytes { raw in
            proc_listpids(UInt32(PROC_UID_ONLY), UInt32(uid), raw.baseAddress, Int32(raw.count))
        }
        guard filled > 0 else {
            return []
        }
        let count = min(Int(filled) / MemoryLayout<pid_t>.size, capacity)
        return pids.prefix(count).compactMap { $0 > 0 ? entry(pid: $0) : nil }
    }

    public func entry(pid: Int32) -> ProcessEntry? {
        guard pid > 0 else {
            return nil
        }
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else {
            return nil
        }
        return ProcessEntry(
            pid: Int32(bitPattern: info.pbi_pid),
            ppid: Int32(bitPattern: info.pbi_ppid),
            pgid: Int32(bitPattern: info.pbi_pgid),
            startTime: info.pbi_start_tvsec &* 1_000_000 &+ info.pbi_start_tvusec
        )
    }

    @discardableResult
    public func send(_ signal: Int32, to pid: Int32) -> Bool {
        kill(pid, signal) == 0
    }
}

/// Every tree one supervised service has launched and that still has live
/// members: the current launch plus earlier launches whose root has exited
/// while group members or detached children outlived it (r1 review F-01).
/// Stop signals all of them; observation drops a tree once nothing of it is
/// left.
public struct ProcessTreeSet: Equatable {
    public private(set) var trees: [ProcessTreeTracker] = []

    public init() {}

    public var isEmpty: Bool {
        trees.isEmpty
    }

    /// A new launch. Trees of earlier launches are kept.
    public mutating func launched(rootPid: Int32, table: ProcessTable) {
        if let tracker = ProcessTreeTracker(rootPid: rootPid, table: table) {
            trees.append(tracker)
        }
    }

    /// Records members of every tree and drops trees with none left. When
    /// the running root has no tracker yet (its entry could not be read at
    /// launch), one is made from this snapshot (r1 review F-02). The running
    /// root is this app's unreaped child, so its pid cannot have been reused.
    public mutating func observe(_ entries: [ProcessEntry], runningRootPid: Int32?, excluding: Set<Int32> = [getpid()]) {
        guard !entries.isEmpty else {
            return
        }
        if let pid = runningRootPid, !trees.contains(where: { $0.root.pid == pid }),
           let root = entries.first(where: { $0.pid == pid }) {
            trees.append(ProcessTreeTracker(root: root))
        }
        for index in trees.indices {
            trees[index].observe(entries, excluding: excluding)
        }
        trees.removeAll { $0.members(in: entries, excluding: excluding).isEmpty }
    }

    /// Stop, phase 1: SIGTERM every member of every tree except a root (the
    /// caller terminates its own running Process). Returns what phase 2 needs.
    public mutating func terminate(runningRootPid: Int32?, table: ProcessTable, excluding: Set<Int32> = [getpid()]) -> [TermedTree] {
        if let pid = runningRootPid, !trees.contains(where: { $0.root.pid == pid }) {
            launched(rootPid: pid, table: table)
        }
        var termed: [TermedTree] = []
        for index in trees.indices {
            let members = ProcessSignals.terminate(&trees[index], table: table, excluding: excluding)
            termed.append(TermedTree(tracker: trees[index], members: members))
        }
        return termed
    }

    /// Stop all, phase 2, after the grace. Returns the identities killed.
    @discardableResult
    public static func killSurvivors(_ termed: [TermedTree], table: ProcessTable, excluding: Set<Int32> = [getpid()]) -> [ProcessIdentity] {
        termed.flatMap { ProcessSignals.killSurvivors($0.tracker, termed: $0.members, table: table, excluding: excluding) }
    }
}

/// One tree as phase 1 of a stop left it.
public struct TermedTree: Equatable {
    public let tracker: ProcessTreeTracker
    public let members: [ProcessIdentity]
}
