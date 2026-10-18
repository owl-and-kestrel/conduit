import Darwin
import XCTest
@testable import ConduitMenuBarCore

/// Which port listener the app may stop. The app stops a listener only when
/// `classify` says `.ours`; `.foreign` is reported and `.gone` is skipped.
final class ListenerOwnershipTests: XCTestCase {
    private let ownPid: Int32 = 4100
    private let checkout = "/x/conduit"
    private let sibling = "/x/conduit-fork"
    private let node = "/opt/homebrew/Cellar/node/22.0.0/bin/node"

    /// The owner's paths are taken as given here (they do not exist, so
    /// ListenerOwner's realpath would drop them).
    private var owner: ListenerOwner {
        ListenerOwner(resolved: ownPid, checkoutRoot: checkout, bundlePath: "\(checkout)/dist/macos/Conduit.app")
    }

    /// The node process tsx starts for `npm run conduit -- listen --project <root>`.
    private func agentListener(root: String, ancestors: [Int32] = [], cwd: String? = nil) -> ProcessSnapshot {
        ProcessSnapshot(
            pid: 7000,
            ancestors: ancestors,
            executablePath: node,
            workingDirectory: cwd ?? root,
            arguments: [
                node, "--require", "\(root)/node_modules/tsx/dist/preflight.cjs",
                "--import", "file://\(root)/node_modules/tsx/dist/loader.mjs",
                "src/cli/index.ts", "listen", "--project", root
            ]
        )
    }

    // MARK: Ours

    func testOurSupervisedChildIsOurs() {
        let child = agentListener(root: checkout, ancestors: [7001, 7002, ownPid, 1])
        XCTAssertEqual(ListenerOwnership.classify(child, service: .agentListener, owner: owner), .ours(.supervisedChild))
    }

    func testAnyProcessInOurTreeIsOursEvenWithoutAServiceCommandLine() {
        let toolRun = ProcessSnapshot(pid: 7100, ancestors: [7000, ownPid], executablePath: "/usr/bin/python3", arguments: ["python3", "-m", "http.server", "3333"])
        XCTAssertEqual(ListenerOwnership.classify(toolRun, service: .agentListener, owner: owner), .ours(.supervisedChild))
    }

    func testPreviousRunOfThisCheckoutIsOurs() {
        // The app restarted; the old run's listener (re-parented to launchd)
        // has not reached its CONDUIT_PARENT_PID watchdog exit yet.
        let stale = agentListener(root: checkout)
        XCTAssertEqual(ListenerOwnership.classify(stale, service: .agentListener, owner: owner), .ours(.thisCheckout))
        let control = ProcessSnapshot(
            pid: 7200,
            executablePath: node,
            workingDirectory: checkout,
            arguments: [node, "\(checkout)/dist/src/cli/index.js", "app", "start", "--port", "47831"]
        )
        XCTAssertEqual(ListenerOwnership.classify(control, service: .control, owner: owner), .ours(.thisCheckout))
    }

    func testRuntimeInsideThisAppBundleIsOurs() {
        let bundled = ProcessSnapshot(
            pid: 7300,
            executablePath: "\(checkout)/dist/macos/Conduit.app/Contents/Resources/runtime/node",
            workingDirectory: "/",
            arguments: ["node", "dist/src/cli/index.js", "listen", "--project", "/y"]
        )
        XCTAssertEqual(ListenerOwnership.classify(bundled, service: .agentListener, owner: owner), .ours(.thisCheckout))
    }

    // MARK: Foreign

    func testSiblingCheckoutListenerIsForeign() {
        // The case that used to be stopped: /x/conduit-fork starts with /x/conduit.
        let fork = agentListener(root: sibling, ancestors: [5101, 5100])
        XCTAssertEqual(ListenerOwnership.classify(fork, service: .agentListener, owner: owner), .foreign)
        // Naming this checkout on its command line does not make it ours.
        let withOurProject = ProcessSnapshot(
            pid: 7050,
            executablePath: node,
            workingDirectory: sibling,
            arguments: [node, "\(sibling)/src/cli/index.ts", "listen", "--project", checkout]
        )
        XCTAssertEqual(ListenerOwnership.classify(withOurProject, service: .agentListener, owner: owner), .foreign)
        let siblingControl = ProcessSnapshot(
            pid: 7400,
            executablePath: node,
            workingDirectory: sibling,
            arguments: [node, "src/cli/index.ts", "app", "start", "--port", "47831"]
        )
        XCTAssertEqual(ListenerOwnership.classify(siblingControl, service: .control, owner: owner), .foreign)
    }

    func testCheckoutNestedInsideThisOneIsForeign() {
        let nested = "\(checkout)/.worktrees/feature"
        XCTAssertEqual(ListenerOwnership.classify(agentListener(root: nested), service: .agentListener, owner: owner), .foreign)
    }

    func testStalePathIsForeign() {
        // The working directory no longer resolves (checkout moved or deleted).
        let moved = agentListener(root: checkout)
        let unresolved = ProcessSnapshot(
            pid: moved.pid,
            executablePath: moved.executablePath,
            workingDirectory: nil,
            arguments: moved.arguments
        )
        XCTAssertEqual(ListenerOwnership.classify(unresolved, service: .agentListener, owner: owner), .foreign)
        // The old matcher's dist/cli/index.js is not a path the build emits.
        let oldPath = ProcessSnapshot(
            pid: 7500,
            executablePath: node,
            workingDirectory: checkout,
            arguments: [node, "dist/cli/index.js", "listen", "--project", checkout]
        )
        XCTAssertEqual(ListenerOwnership.classify(oldPath, service: .agentListener, owner: owner), .foreign)
    }

    func testUnrelatedServerInThisCheckoutIsForeign() {
        // An unrelated server started in this checkout (for example a tool run
        // that left the app's tree) is not a Conduit listener.
        let detached = ProcessSnapshot(pid: 7600, executablePath: "/usr/bin/python3", workingDirectory: checkout, arguments: ["python3", "-m", "http.server", "3333"])
        XCTAssertEqual(ListenerOwnership.classify(detached, service: .agentListener, owner: owner), .foreign)
    }

    func testWrongServiceIsForeign() {
        let listener = agentListener(root: checkout)
        XCTAssertEqual(ListenerOwnership.classify(listener, service: .control, owner: owner), .foreign)
    }

    func testUnreadableProcessIsForeign() {
        XCTAssertEqual(ListenerOwnership.classify(ProcessSnapshot(pid: 7700), service: .agentListener, owner: owner), .foreign)
    }

    func testNoCheckoutOrBundleMeansOnlyOurTree() {
        let bare = ListenerOwner(resolved: ownPid, checkoutRoot: nil, bundlePath: nil)
        XCTAssertEqual(ListenerOwnership.classify(agentListener(root: checkout), service: .agentListener, owner: bare), .foreign)
        XCTAssertEqual(ListenerOwnership.classify(agentListener(root: checkout, ancestors: [ownPid]), service: .agentListener, owner: bare), .ours(.supervisedChild))
    }

    // MARK: Gone

    func testMissingProcessIsNotKilled() {
        XCTAssertEqual(ListenerOwnership.classify(nil, service: .agentListener, owner: owner), .gone)
    }

    // MARK: Helpers

    func testPathContainmentUsesWholeComponents() {
        XCTAssertTrue(ListenerOwnership.isPath("/x/conduit", inside: "/x/conduit"))
        XCTAssertTrue(ListenerOwnership.isPath("/x/conduit/sub", inside: "/x/conduit/"))
        XCTAssertFalse(ListenerOwnership.isPath("/x/conduit-fork", inside: "/x/conduit"))
        XCTAssertFalse(ListenerOwnership.isPath("/x/conduitx/sub", inside: "/x/conduit"))
        XCTAssertFalse(ListenerOwnership.isPath("/x/conduit", inside: "/"))
        XCTAssertFalse(ListenerOwnership.isPath("/x/conduit", inside: ""))
    }

    func testServiceSignature() {
        XCTAssertTrue(ListenerOwnership.isService(.agentListener, arguments: ["node", "src/cli/index.ts", "listen", "--project", "/x"]))
        XCTAssertTrue(ListenerOwnership.isService(.control, arguments: ["node", "/x/dist/src/cli/index.js", "app", "start", "--port", "47831"]))
        XCTAssertFalse(ListenerOwnership.isService(.control, arguments: ["node", "src/cli/index.ts", "listen"]))
        XCTAssertFalse(ListenerOwnership.isService(.agentListener, arguments: ["node", "src/cli/index.ts", "--", "listen"]))
        XCTAssertFalse(ListenerOwnership.isService(.agentListener, arguments: ["node", "other/src/cli/index.tsx", "listen"]))
        XCTAssertFalse(ListenerOwnership.isService(.agentListener, arguments: ["sh", "-c", "tsx src/cli/index.ts listen"]))
    }
}

/// The kernel probe against real processes this test starts.
final class ProcessProbeTests: XCTestCase {
    private var started: [Process] = []
    private var tempRoot: URL!

    override func setUpWithError() throws {
        tempRoot = FileManager.default.temporaryDirectory.appendingPathComponent("conduit-ownership-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    }

    override func tearDown() {
        for process in started where process.isRunning {
            kill(process.processIdentifier, SIGKILL)
            process.waitUntilExit()
        }
        try? FileManager.default.removeItem(at: tempRoot)
    }

    private func directory(_ name: String) throws -> URL {
        let url = tempRoot.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// A sleeping perl whose argv reads like an agent listener started in `cwd`.
    private func startStandIn(cwd: URL) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
        process.arguments = ["-e", "sleep 30", "--", "src/cli/index.ts", "listen", "--project", cwd.path]
        process.currentDirectoryURL = cwd
        process.environment = ["PATH": "/usr/bin:/bin"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        started.append(process)
        let pid = process.processIdentifier
        // Wait for exec to finish so argv is perl's, not ours.
        for _ in 0..<50 {
            if ProcessProbe.snapshot(pid: pid)?.arguments.contains("listen") == true {
                return pid
            }
            usleep(50_000)
        }
        XCTFail("stand-in \(pid) never showed its arguments")
        return pid
    }

    func testOurChildIsOurs() throws {
        let checkout = try directory("conduit")
        let pid = try startStandIn(cwd: checkout)
        let snapshot = try XCTUnwrap(ProcessProbe.snapshot(pid: pid))
        XCTAssertEqual(snapshot.ancestors.first, getpid())
        XCTAssertEqual(snapshot.workingDirectory, ProcessProbe.resolvedPath(checkout.path))
        XCTAssertEqual(snapshot.arguments.suffix(4), ["src/cli/index.ts", "listen", "--project", checkout.path])
        let owner = ListenerOwner(pid: getpid(), checkoutRoot: nil, bundlePath: nil)
        XCTAssertEqual(ListenerOwnership.classify(snapshot, service: .agentListener, owner: owner), .ours(.supervisedChild))
    }

    func testSiblingCheckoutListenerIsForeign() throws {
        let checkout = try directory("conduit")
        let sibling = try directory("conduit-fork")
        let pid = try startStandIn(cwd: sibling)
        let snapshot = try XCTUnwrap(ProcessProbe.snapshot(pid: pid))
        // An owner pid that is not this test process, so the tree does not decide.
        let notAnAncestor: Int32 = 999_999
        let us = ListenerOwner(pid: notAnAncestor, checkoutRoot: checkout.path, bundlePath: nil)
        XCTAssertEqual(ListenerOwnership.classify(snapshot, service: .agentListener, owner: us), .foreign)
        // Positive control: the probe really reads the working directory.
        let fork = ListenerOwner(pid: notAnAncestor, checkoutRoot: sibling.path, bundlePath: nil)
        XCTAssertEqual(ListenerOwnership.classify(snapshot, service: .agentListener, owner: fork), .ours(.thisCheckout))
    }

    func testStaleWorkingDirectoryIsForeign() throws {
        let checkout = try directory("conduit")
        let us = ListenerOwner(pid: 999_999, checkoutRoot: checkout.path, bundlePath: nil)
        XCTAssertNotNil(us.checkoutRoot)
        let pid = try startStandIn(cwd: checkout)
        try FileManager.default.removeItem(at: checkout)
        let snapshot = try XCTUnwrap(ProcessProbe.snapshot(pid: pid))
        XCTAssertNil(snapshot.workingDirectory)
        XCTAssertEqual(ListenerOwnership.classify(snapshot, service: .agentListener, owner: us), .foreign)
    }

    func testMissingProcessIsGone() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try process.run()
        process.waitUntilExit()
        let pid = process.processIdentifier
        XCTAssertNil(ProcessProbe.snapshot(pid: pid))
        XCTAssertNil(ProcessProbe.snapshot(pid: 0))
        XCTAssertNil(ProcessProbe.snapshot(pid: -1))
        let owner = ListenerOwner(pid: getpid(), checkoutRoot: nil, bundlePath: nil)
        XCTAssertEqual(ListenerOwnership.classify(ProcessProbe.snapshot(pid: pid), service: .agentListener, owner: owner), .gone)
    }
}
