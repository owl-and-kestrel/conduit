import Darwin
import Foundation
import XCTest
@testable import ConduitMenuBarCore

/// A process table made of fake processes: nothing real is signalled.
final class FakeProcessTable: ProcessTable {
    var processes: [Int32: ProcessEntry] = [:]
    private(set) var sent: [(signal: Int32, pid: Int32)] = []
    /// entries() returns [] (a failed proc_listpids); entry(pid:) still works.
    var listingFails = false
    /// Runs after entries() has taken its snapshot: what changes between the
    /// listing and the signals.
    var afterListing: ((FakeProcessTable) -> Void)?

    init(_ entries: [ProcessEntry]) {
        for entry in entries { processes[entry.pid] = entry }
    }

    func entries() -> [ProcessEntry] {
        let snapshot = listingFails ? [] : processes.values.sorted { $0.pid < $1.pid }
        afterListing?(self)
        return snapshot
    }
    func entry(pid: Int32) -> ProcessEntry? { processes[pid] }

    @discardableResult
    func send(_ signal: Int32, to pid: Int32) -> Bool {
        guard processes[pid] != nil else { return false }
        sent.append((signal, pid))
        return true
    }

    func pids(sent signal: Int32) -> [Int32] { sent.filter { $0.signal == signal }.map(\.pid).sorted() }

    func exit(_ pid: Int32) {
        let orphans = processes.values.filter { $0.ppid == pid }
        processes[pid] = nil
        for orphan in orphans {
            processes[orphan.pid] = ProcessEntry(pid: orphan.pid, ppid: 1, pgid: orphan.pgid, startTime: orphan.startTime)
        }
    }

    func add(_ entry: ProcessEntry) { processes[entry.pid] = entry }
}

/// F-04: Stop all reaches detached children and never signals a reused pid.
final class ProcessTreeKillTests: XCTestCase {
    // The app (pid 50) launched the service root 100, leader of group 100.
    let app: Set<Int32> = [50]
    let appEntry = ProcessEntry(pid: 50, ppid: 1, pgid: 50, startTime: 10)
    let root = ProcessEntry(pid: 100, ppid: 50, pgid: 100, startTime: 1_000)
    let node = ProcessEntry(pid: 101, ppid: 100, pgid: 100, startTime: 1_001)
    let stranger = ProcessEntry(pid: 300, ppid: 1, pgid: 300, startTime: 500)

    func testDoubleForkedChildInTheRootGroupIsStoppedAfterItsParentExits() {
        // node double-forks a daemon (pid 102) that keeps the group.
        let table = FakeProcessTable([appEntry, root, node, stranger, ProcessEntry(pid: 102, ppid: 101, pgid: 100, startTime: 1_002)])
        var tracker = ProcessTreeTracker(root: root)
        table.exit(101)
        XCTAssertEqual(table.entry(pid: 102)?.ppid, 1, "re-parented to launchd")

        let termed = ProcessSignals.terminate(&tracker, table: table, excluding: app)
        XCTAssertEqual(termed.map(\.pid), [100, 102])
        XCTAssertEqual(table.pids(sent: SIGTERM), [102], "the root is terminated by its Process")
        ProcessSignals.killSurvivors(tracker, termed: termed, table: table, excluding: app)
        XCTAssertEqual(table.pids(sent: SIGKILL), [100, 102])
        XCTAssertFalse(table.sent.contains { $0.pid == 300 || $0.pid == 50 })
    }

    func testSetsidChildSeenEarlierIsStoppedAfterItsParentExits() {
        let table = FakeProcessTable([appEntry, root, node, stranger])
        var tracker = ProcessTreeTracker(root: root)
        // node starts a tool run that calls setsid: new session and group.
        table.add(ProcessEntry(pid: 110, ppid: 101, pgid: 110, startTime: 1_010))
        tracker.observe(table.entries(), excluding: app)
        // node exits; the detached child is now outside both tree and group.
        table.exit(101)
        XCTAssertEqual(table.entry(pid: 110), ProcessEntry(pid: 110, ppid: 1, pgid: 110, startTime: 1_010))

        let termed = ProcessSignals.terminate(&tracker, table: table, excluding: app)
        XCTAssertEqual(termed.map(\.pid), [100, 110])
        XCTAssertEqual(table.pids(sent: SIGTERM), [110])
    }

    func testDescendantsOfADetachedMemberAreStoppedToo() {
        let table = FakeProcessTable([appEntry, root, node])
        var tracker = ProcessTreeTracker(root: root)
        table.add(ProcessEntry(pid: 110, ppid: 101, pgid: 110, startTime: 1_010))
        tracker.observe(table.entries(), excluding: app)
        table.exit(101)
        table.add(ProcessEntry(pid: 111, ppid: 110, pgid: 110, startTime: 1_020))
        XCTAssertEqual(tracker.members(in: table.entries(), excluding: app).map(\.pid), [100, 110, 111])
    }

    func testDetachedChildNeverObservedIsTheDocumentedResidual() {
        let table = FakeProcessTable([appEntry, root, node])
        let tracker = ProcessTreeTracker(root: root)
        table.add(ProcessEntry(pid: 110, ppid: 101, pgid: 110, startTime: 1_010))
        table.exit(101)
        XCTAssertEqual(tracker.members(in: table.entries(), excluding: app).map(\.pid), [100])
    }

    func testPidReusedDuringTheGraceIsNotKilled() {
        let table = FakeProcessTable([appEntry, root, node])
        var tracker = ProcessTreeTracker(root: root)
        let termed = ProcessSignals.terminate(&tracker, table: table, excluding: app)
        XCTAssertEqual(termed.map(\.pid), [100, 101])
        // Within the 3 s grace, both exit and an unrelated process gets pid 101.
        table.exit(101)
        table.exit(100)
        table.add(ProcessEntry(pid: 101, ppid: 1, pgid: 101, startTime: 9_999))

        let killed = ProcessSignals.killSurvivors(tracker, termed: termed, table: table, excluding: app)
        XCTAssertEqual(killed, [])
        XCTAssertEqual(table.pids(sent: SIGKILL), [], "start time differs, so pid 101 is someone else now")
    }

    func testSurvivorThatIgnoredTermIsKilled() {
        let table = FakeProcessTable([appEntry, root, node])
        var tracker = ProcessTreeTracker(root: root)
        let termed = ProcessSignals.terminate(&tracker, table: table, excluding: app)
        table.exit(100)
        XCTAssertEqual(ProcessSignals.killSurvivors(tracker, termed: termed, table: table, excluding: app).map(\.pid), [101])
    }

    func testChildForkedDuringTheGraceIsKilled() {
        let table = FakeProcessTable([appEntry, root, node])
        var tracker = ProcessTreeTracker(root: root)
        let termed = ProcessSignals.terminate(&tracker, table: table, excluding: app)
        table.add(ProcessEntry(pid: 120, ppid: 101, pgid: 120, startTime: 1_100))
        ProcessSignals.killSurvivors(tracker, termed: termed, table: table, excluding: app)
        XCTAssertEqual(table.pids(sent: SIGKILL), [100, 101, 120])
    }

    func testGroupRecreatedByAStrangerWithTheRootPidIsNotOurs() {
        let table = FakeProcessTable([appEntry, root, node])
        var tracker = ProcessTreeTracker(root: root)
        tracker.observe(table.entries(), excluding: app)
        // The whole tree exits; pid 100 is reused by a stranger that leads a
        // new group 100 and forks, then the stranger exits.
        table.exit(101)
        table.exit(100)
        table.add(ProcessEntry(pid: 100, ppid: 1, pgid: 100, startTime: 5_000))
        table.add(ProcessEntry(pid: 130, ppid: 100, pgid: 100, startTime: 5_001))
        XCTAssertEqual(tracker.members(in: table.entries(), excluding: app), [], "pid 100 holder has another start time")
        table.exit(100)
        XCTAssertEqual(tracker.members(in: table.entries(), excluding: app), [], "started after the group was last confirmed ours")
    }

    func testGroupMembersStillCountAfterTheRootExits() {
        let daemon = ProcessEntry(pid: 102, ppid: 1, pgid: 100, startTime: 1_002)
        let table = FakeProcessTable([appEntry, root, node, daemon])
        var tracker = ProcessTreeTracker(root: root)
        tracker.observe(table.entries(), excluding: app)
        table.exit(100)
        table.exit(101)
        XCTAssertEqual(tracker.members(in: table.entries(), excluding: app).map(\.pid), [102])
    }

    func testSharedGroupIsNeverUsed() {
        // A root that is not its own group leader shares the app's group.
        let sharedRoot = ProcessEntry(pid: 100, ppid: 50, pgid: 50, startTime: 1_000)
        let sibling = ProcessEntry(pid: 200, ppid: 50, pgid: 50, startTime: 1_500)
        let table = FakeProcessTable([appEntry, sharedRoot, sibling])
        let tracker = ProcessTreeTracker(root: sharedRoot)
        XCTAssertFalse(tracker.ownsGroup)
        XCTAssertEqual(tracker.members(in: table.entries(), excluding: app).map(\.pid), [100])
    }

    func testNeverSignalsTheAppLaunchdOrPidZero() {
        // A corrupt table claims the app and launchd are in the tree.
        let table = FakeProcessTable([
            ProcessEntry(pid: 50, ppid: 100, pgid: 100, startTime: 10),
            ProcessEntry(pid: 1, ppid: 0, pgid: 100, startTime: 1),
            root
        ])
        var tracker = ProcessTreeTracker(root: root)
        let termed = ProcessSignals.terminate(&tracker, table: table, excluding: app)
        XCTAssertEqual(termed.map(\.pid), [100])
        ProcessSignals.killSurvivors(tracker, termed: termed + [ProcessIdentity(pid: 0, startTime: 0)], table: table, excluding: app)
        XCTAssertEqual(table.pids(sent: SIGKILL), [100])
    }

    func testFailedTableReadForgetsNothing() {
        let table = FakeProcessTable([appEntry, root, node])
        var tracker = ProcessTreeTracker(root: root)
        tracker.observe(table.entries(), excluding: app)
        let seen = tracker.seen
        tracker.observe([], excluding: app)
        XCTAssertEqual(tracker.seen, seen)
    }

    func testExitedMembersArePrunedFromSeen() {
        let table = FakeProcessTable([appEntry, root, node])
        var tracker = ProcessTreeTracker(root: root)
        tracker.observe(table.entries(), excluding: app)
        table.exit(101)
        tracker.observe(table.entries(), excluding: app)
        XCTAssertEqual(tracker.seen, [root.identity])
    }
}

/// r1 review F-01/F-02: trees outlive their root; a missing tracker is made
/// on the next observation.
final class ProcessTreeSetTests: XCTestCase {
    let app: Set<Int32> = [50]
    let appEntry = ProcessEntry(pid: 50, ppid: 1, pgid: 50, startTime: 10)
    let root = ProcessEntry(pid: 100, ppid: 50, pgid: 100, startTime: 1_000)
    let daemon = ProcessEntry(pid: 102, ppid: 100, pgid: 100, startTime: 1_002)

    func testStopAfterTheRootExitedStillStopsWhatOutlivedIt() {
        let table = FakeProcessTable([appEntry, root, daemon])
        var set = ProcessTreeSet()
        set.launched(rootPid: 100, table: table)
        set.observe(table.entries(), runningRootPid: 100, excluding: app)
        // The service root exits (crash or exit 0); the daemon it double-forked
        // keeps running in its group, re-parented to launchd.
        table.exit(100)
        set.observe(table.entries(), runningRootPid: nil, excluding: app)
        XCTAssertFalse(set.isEmpty, "the tree is kept while a member lives")

        let termed = set.terminate(runningRootPid: nil, table: table, excluding: app)
        XCTAssertEqual(table.pids(sent: SIGTERM), [102])
        ProcessTreeSet.killSurvivors(termed, table: table, excluding: app)
        XCTAssertEqual(table.pids(sent: SIGKILL), [102])
    }

    func testTreeIsDroppedOnceNothingOfItIsLeft() {
        let table = FakeProcessTable([appEntry, root, daemon])
        var set = ProcessTreeSet()
        set.launched(rootPid: 100, table: table)
        table.exit(100)
        table.exit(102)
        set.observe(table.entries(), runningRootPid: nil, excluding: app)
        XCTAssertTrue(set.isEmpty)
        XCTAssertEqual(set.terminate(runningRootPid: nil, table: table, excluding: app), [])
        XCTAssertTrue(table.sent.isEmpty)
    }

    func testEarlierLaunchLeftoversAndTheNewLaunchAreBothStopped() {
        let table = FakeProcessTable([appEntry, root, daemon])
        var set = ProcessTreeSet()
        set.launched(rootPid: 100, table: table)
        set.observe(table.entries(), runningRootPid: 100, excluding: app)
        table.exit(100)
        // Restarted: a new root 200 with its own group.
        table.add(ProcessEntry(pid: 200, ppid: 50, pgid: 200, startTime: 2_000))
        table.add(ProcessEntry(pid: 201, ppid: 200, pgid: 200, startTime: 2_001))
        set.launched(rootPid: 200, table: table)
        set.observe(table.entries(), runningRootPid: 200, excluding: app)
        XCTAssertEqual(set.trees.map(\.root.pid), [100, 200])

        let termed = set.terminate(runningRootPid: 200, table: table, excluding: app)
        XCTAssertEqual(table.pids(sent: SIGTERM), [102, 201], "roots are terminated by their Process")
        ProcessTreeSet.killSurvivors(termed, table: table, excluding: app)
        XCTAssertEqual(table.pids(sent: SIGKILL), [102, 200, 201])
    }

    func testMissingTrackerIsMadeOnTheNextObservationAndAtStop() {
        let table = FakeProcessTable([appEntry, root, daemon])
        var set = ProcessTreeSet()
        // The root's entry could not be read at launch.
        set.observe(table.entries(), runningRootPid: 100, excluding: app)
        XCTAssertEqual(set.trees.map(\.root), [root.identity])

        var atStop = ProcessTreeSet()
        let termed = atStop.terminate(runningRootPid: 100, table: table, excluding: app)
        XCTAssertEqual(termed.first?.members.map(\.pid), [100, 102])
    }

    func testFailedTableReadKeepsEveryTree() {
        let table = FakeProcessTable([appEntry, root])
        var set = ProcessTreeSet()
        set.launched(rootPid: 100, table: table)
        set.observe([], runningRootPid: 100, excluding: app)
        XCTAssertEqual(set.trees.count, 1)
    }
}

/// ProcessTree.terminateTree (restarting a stale Control or agent listener,
/// the CLI-command timeout): one snapshot, Stop all's membership rule,
/// start-time-checked SIGTERM, root last.
final class TerminateTreeTests: XCTestCase {
    let app: Set<Int32> = [50]
    let appEntry = ProcessEntry(pid: 50, ppid: 1, pgid: 50, startTime: 10)
    let stranger = ProcessEntry(pid: 300, ppid: 1, pgid: 300, startTime: 500)
    // A previous run's listener: node (200) under npm (150), which leads the
    // group, so the listener does not lead its own.
    let npm = ProcessEntry(pid: 150, ppid: 1, pgid: 150, startTime: 900)
    let listener = ProcessEntry(pid: 200, ppid: 150, pgid: 150, startTime: 1_000)
    let worker = ProcessEntry(pid: 201, ppid: 200, pgid: 150, startTime: 1_001)
    let grandchild = ProcessEntry(pid: 202, ppid: 201, pgid: 150, startTime: 1_002)

    func testDescendantsAreSignalledBeforeTheRootAndNothingElse() {
        let table = FakeProcessTable([appEntry, stranger, npm, listener, worker, grandchild])
        let signalled = ProcessSignals.terminateTree(rootPid: 200, table: table, excluding: app)
        XCTAssertEqual(signalled.map(\.pid), [201, 202, 200])
        XCTAssertEqual(table.sent.map(\.pid), [201, 202, 200], "root last")
        XCTAssertEqual(Set(table.sent.map(\.signal)), [SIGTERM])
        XCTAssertFalse(table.sent.contains { [50, 150, 300].contains($0.pid) }, "not its parent's group, the app or a stranger")
    }

    func testGroupLedByTheRootIsIncludedSoADoubleForkedChildIsReached() {
        // A timed-out `zsh -lc … npm` command: Foundation's Process made it a
        // group leader; a child double-forked a daemon now under launchd.
        let command = ProcessEntry(pid: 400, ppid: 50, pgid: 400, startTime: 2_000)
        let child = ProcessEntry(pid: 401, ppid: 400, pgid: 400, startTime: 2_001)
        let daemon = ProcessEntry(pid: 402, ppid: 1, pgid: 400, startTime: 2_002)
        let table = FakeProcessTable([appEntry, stranger, command, child, daemon])
        ProcessSignals.terminateTree(rootPid: 400, table: table, excluding: app)
        XCTAssertEqual(table.sent.map(\.pid), [401, 402, 400])
    }

    func testPidReusedAfterTheListingIsNotSignalled() {
        let table = FakeProcessTable([appEntry, listener, worker])
        table.afterListing = { table in
            // The worker exits and a stranger gets pid 201 before the kill.
            table.exit(201)
            table.add(ProcessEntry(pid: 201, ppid: 1, pgid: 201, startTime: 9_999))
        }
        let signalled = ProcessSignals.terminateTree(rootPid: 200, table: table, excluding: app)
        XCTAssertEqual(signalled.map(\.pid), [200])
        XCTAssertEqual(table.sent.map(\.pid), [200])
    }

    func testAFailedListingStillSignalsTheRoot() {
        let table = FakeProcessTable([appEntry, listener, worker])
        table.listingFails = true
        XCTAssertEqual(ProcessSignals.terminateTree(rootPid: 200, table: table, excluding: app).map(\.pid), [200])
    }

    func testGoneRootSignalsNothing() {
        let table = FakeProcessTable([appEntry, stranger])
        XCTAssertEqual(ProcessSignals.terminateTree(rootPid: 200, table: table, excluding: app), [])
        XCTAssertTrue(table.sent.isEmpty)
    }

    func testNeverSignalsTheAppLaunchdOrPidZero() {
        // A corrupt table puts the app and launchd under the root.
        let table = FakeProcessTable([
            ProcessEntry(pid: 50, ppid: 200, pgid: 50, startTime: 10),
            ProcessEntry(pid: 1, ppid: 200, pgid: 1, startTime: 1),
            listener
        ])
        XCTAssertEqual(ProcessSignals.terminateTree(rootPid: 200, table: table, excluding: app).map(\.pid), [200])
        for pid: Int32 in [50, 1, 0, -1] {
            XCTAssertEqual(ProcessSignals.terminateTree(rootPid: pid, table: table, excluding: app), [])
        }
        XCTAssertEqual(table.sent.map(\.pid), [200])
    }
}

private struct WaitTimedOut: Error, CustomStringConvertible {
    let description: String
}

/// The same rules against real processes this test starts (each `sleep`
/// gets a long, unusual duration and is killed in teardown by identity).
final class KernelProcessTreeKillTests: XCTestCase {
    private let table = KernelProcessTable()
    private var started: [Process] = []
    private var cleanup: Set<ProcessIdentity> = []

    override func tearDown() {
        ProcessSignals.send(SIGKILL, to: Array(cleanup), table: table)
        for process in started where process.isRunning {
            process.terminate()
        }
        super.tearDown()
    }

    private func launch(_ script: String) throws -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", script]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        started.append(process)
        if let entry = table.entry(pid: process.processIdentifier) {
            cleanup.insert(entry.identity)
        }
        return process
    }

    private func waitFor<T>(_ what: String, timeout: TimeInterval = 5, _ probe: () -> T?) throws -> T {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let value = probe() { return value }
            Thread.sleep(forTimeInterval: 0.02)
        }
        throw WaitTimedOut(description: "timed out waiting for \(what)")
    }

    func testEntryReportsPidGroupAndAStableStartTime() throws {
        let process = try launch("exec /bin/sleep 61.7")
        let pid = process.processIdentifier
        let first = try XCTUnwrap(table.entry(pid: pid))
        XCTAssertEqual(first.pgid, pid, "Foundation's Process makes the child a group leader")
        XCTAssertEqual(first.ppid, getpid())
        XCTAssertEqual(table.entry(pid: pid)?.startTime, first.startTime)
        XCTAssertTrue(table.entries().contains(first))
    }

    func testDoubleForkedOrphanIsKilledAndNothingElse() throws {
        // The subshell forks a sleep and exits: the sleep is re-parented to
        // launchd but stays in the root's group.
        let process = try launch("( /bin/sleep 62.3 & ) ; exec /bin/sleep 62.4")
        let rootPid = process.processIdentifier
        var tracker = try XCTUnwrap(ProcessTreeTracker(rootPid: rootPid, table: table))
        let orphan = try waitFor("the orphan") {
            table.entries().first { $0.pgid == rootPid && $0.pid != rootPid && $0.ppid == 1 }
        }
        cleanup.insert(orphan.identity)

        let termed = ProcessSignals.terminate(&tracker, table: table)
        XCTAssertTrue(termed.contains(orphan.identity))
        XCTAssertTrue(termed.allSatisfy { $0.pid != getpid() })
        process.terminate()
        ProcessSignals.killSurvivors(tracker, termed: termed, table: table)
        _ = try waitFor("the orphan to exit") { table.entry(pid: orphan.pid)?.startTime == orphan.startTime ? nil : true }
    }

    func testOrphanIsStoppedAfterTheRootHasExited() throws {
        // The root starts a double-forked sleep and then exits on its own.
        let process = try launch("( /bin/sleep 64.3 & ) ; /bin/sleep 0.3")
        let rootPid = process.processIdentifier
        var set = ProcessTreeSet()
        set.launched(rootPid: rootPid, table: table)
        let orphan = try waitFor("the orphan") {
            table.entries().first { $0.pgid == rootPid && $0.pid != rootPid && $0.ppid == 1 }
        }
        cleanup.insert(orphan.identity)
        set.observe(table.entries(), runningRootPid: rootPid)
        process.waitUntilExit()
        set.observe(table.entries(), runningRootPid: nil)
        XCTAssertFalse(set.isEmpty)

        let termed = set.terminate(runningRootPid: nil, table: table)
        XCTAssertTrue(termed.flatMap(\.members).contains(orphan.identity))
        XCTAssertFalse(termed.flatMap(\.members).contains { $0.pid == getpid() })
        ProcessTreeSet.killSurvivors(termed, table: table)
        _ = try waitFor("the orphan to exit") { table.entry(pid: orphan.pid)?.startTime == orphan.startTime ? nil : true }
    }

    func testTerminateTreeStopsTheRootItsChildAndItsDoubleForkedOrphan() throws {
        let process = try launch("( /bin/sleep 66.3 & ) ; /bin/sleep 66.1 & exec /bin/sleep 66.2")
        let rootPid = process.processIdentifier
        // The orphan reaches launchd only once the subshell has exited, so
        // after it appears the only child of the root is the backgrounded sleep.
        let orphan = try waitFor("the orphan") {
            table.entries().first { $0.pgid == rootPid && $0.pid != rootPid && $0.ppid == 1 }
        }
        cleanup.insert(orphan.identity)
        let child = try waitFor("the child") { table.entries().first { $0.ppid == rootPid } }
        cleanup.insert(child.identity)

        let signalled = ProcessSignals.terminateTree(rootPid: rootPid, table: table)
        XCTAssertEqual(signalled.last?.pid, rootPid, "root last")
        XCTAssertTrue(signalled.contains(child.identity))
        XCTAssertTrue(signalled.contains(orphan.identity))
        XCTAssertFalse(signalled.contains { $0.pid == getpid() })
        process.waitUntilExit()
        XCTAssertEqual(process.terminationReason, .uncaughtSignal)
        XCTAssertEqual(process.terminationStatus, SIGTERM)
        for member in [child, orphan] {
            _ = try waitFor("pid \(member.pid) to exit") { table.entry(pid: member.pid)?.startTime == member.startTime ? nil : true }
        }
    }

    func testSetsidChildObservedBeforeItsParentDiesIsKilled() throws {
        // A child that calls setsid (perl's POSIX::setsid) and then execs sleep.
        let process = try launch("/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec q(/bin/sleep), q(63.1)' & exec /bin/sleep 63.2")
        let rootPid = process.processIdentifier
        var tracker = try XCTUnwrap(ProcessTreeTracker(rootPid: rootPid, table: table))
        let detached = try waitFor("the setsid child") {
            table.entries().first { $0.ppid == rootPid && $0.pgid == $0.pid }
        }
        cleanup.insert(detached.identity)
        tracker.observe(table.entries())
        XCTAssertTrue(tracker.seen.contains(detached.identity))

        // The parent dies first: the child is now outside tree and group.
        process.terminate()
        process.waitUntilExit()
        _ = try waitFor("re-parenting") { table.entry(pid: detached.pid)?.ppid == 1 ? true : nil }

        let termed = ProcessSignals.terminate(&tracker, table: table)
        XCTAssertTrue(termed.contains(detached.identity))
        ProcessSignals.killSurvivors(tracker, termed: termed, table: table)
        _ = try waitFor("the detached child to exit") { table.entry(pid: detached.pid)?.startTime == detached.startTime ? nil : true }
    }
}
