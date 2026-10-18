import Darwin
import Foundation
import XCTest
@testable import ConduitMenuBarCore

/// After `conduit pause --local` with Control down, the menu bar shows Paused
/// (read from control.json), not the Control-down error.
final class LocalPauseTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("conduit-local-pause-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func write(_ text: String) -> String {
        let path = directory.appendingPathComponent("control.json").path
        FileManager.default.createFile(atPath: path, contents: Data(text.utf8))
        return path
    }

    // What `conduit pause --local` writes (src/state/pause-state.ts).
    private let localPauseJson = """
    {
      "paused": true,
      "pausedAt": "2026-10-18T14:02:00.000Z",
      "pausedBy": "cli",
      "reason": "Paused from the menu bar (Control did not answer).",
      "updatedAt": "2026-10-18T14:02:00.000Z"
    }
    """

    func testReadsTheFlagPauseLocalWrites() {
        let state = LocalPause.read(path: write(localPauseJson))
        XCTAssertTrue(state.paused)
        XCTAssertEqual(state.detail?.pausedAt, "2026-10-18T14:02:00.000Z")
        XCTAssertNil(state.detail?.unreadable)
    }

    func testMissingFileOrResumedFlagIsNotPaused() {
        XCTAssertEqual(LocalPause.read(path: directory.appendingPathComponent("control.json").path), LocalPauseState(paused: false))
        XCTAssertEqual(LocalPause.read(path: write(#"{"paused":false,"pausedBy":"menubar"}"#)), LocalPauseState(paused: false))
    }

    func testUnreadableFlagFailsClosedLikeTheRuntime() {
        for text in ["", "{", "[]", #"{"paused":"yes"}"#, #"{"paused":1}"#, #"{"pausedAt":"x"}"#] {
            let state = LocalPause.read(path: write(text))
            XCTAssertTrue(state.paused, text)
            XCTAssertEqual(state.detail?.unreadable, true, text)
        }
        // A directory where the file should be is unreadable too.
        let path = directory.appendingPathComponent("control.json").path
        try? FileManager.default.removeItem(atPath: path)
        XCTAssertNoThrow(try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: false))
        XCTAssertEqual(LocalPause.read(path: path).detail?.unreadable, true)
    }

    func testFifoAtThePathDoesNotBlock() {
        let path = directory.appendingPathComponent("control.json").path
        XCTAssertEqual(mkfifo(path, 0o600), 0)
        let started = Date()
        let state = LocalPause.read(path: path)
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
        XCTAssertEqual(state.detail?.unreadable, true)
    }

    func testOversizedFileIsUnreadable() {
        let padding = String(repeating: " ", count: LocalPause.maxBytes)
        XCTAssertEqual(LocalPause.read(path: write(#"{"paused":false}"# + padding)).detail?.unreadable, true)
    }

    func testStateRootMatchesTheCli() {
        XCTAssertEqual(LocalPause.stateRoot(environment: [:], home: "/Users/a", workingDirectory: "/repo"), "/Users/a/.conduit")
        XCTAssertEqual(LocalPause.stateRoot(environment: ["CONDUIT_STATE_DIR": "/s"], home: "/Users/a", workingDirectory: "/repo"), "/s")
        XCTAssertEqual(LocalPause.stateRoot(environment: ["CONDUIT_STATE_DIR": "rel"], home: "/Users/a", workingDirectory: "/repo"), "/repo/rel")
        XCTAssertEqual(LocalPause.flagPath(stateRoot: "/s"), "/s/control.json")
    }

    // MARK: Reducer

    private let controlDown = ServiceSnapshot(controlReachable: false)

    func testControlDownWithLocalPauseShowsPausedLikeANormalPause() {
        var services = controlDown
        services.localPause = LocalPause.read(path: write(localPauseJson))
        let state = MenuBarState.reduce(status: nil, control: nil, approvals: [], services: services)
        let normal = MenuBarState.reduce(
            status: Fixtures.pausedStatus,
            control: ControlState(paused: true, pause: PauseDetail(pausedAt: "2026-10-18T14:02:00.000Z")),
            approvals: [],
            services: Fixtures.up
        )
        XCTAssertEqual(state.kind, .paused(pendingCount: 0))
        XCTAssertEqual(state.kind, normal.kind)
        XCTAssertEqual(state.headline, normal.headline)
        XCTAssertTrue(state.paused)
        XCTAssertTrue(state.controlUnreachable)
        XCTAssertFalse(normal.controlUnreachable)
        XCTAssertFalse(state.stopped)
    }

    func testControlDownWithUnreadableFlagShowsFailClosedPause() {
        var services = controlDown
        services.localPause = LocalPause.read(path: write("{"))
        let state = MenuBarState.reduce(status: nil, control: nil, approvals: [], services: services)
        XCTAssertEqual(state.kind, .paused(pendingCount: 0))
        XCTAssertEqual(state.headline, "Paused · pause state unreadable (fail closed)")
    }

    func testControlDownWithoutLocalPauseIsStillTheError() {
        for local in [nil, LocalPauseState(paused: false)] {
            var services = controlDown
            services.localPause = local
            let state = MenuBarState.reduce(status: nil, control: nil, approvals: [], services: services)
            XCTAssertEqual(state.kind, .error(reason: "Conduit Control is not running.", fix: .restartServices))
            XCTAssertFalse(state.controlUnreachable)
        }
    }

    func testLocalPauseWinsOverStartingSoThePauseStaysVisible() {
        var services = ServiceSnapshot(controlReachable: false, controlStarting: true)
        services.localPause = LocalPauseState(paused: true)
        XCTAssertEqual(MenuBarState.reduce(status: nil, control: nil, approvals: [], services: services).kind, .paused(pendingCount: 0))
    }

    func testStopAllStillWinsAndControlUpIgnoresTheLocalRead() {
        var stopped = ServiceSnapshot(controlReachable: false, stoppedByUser: true)
        stopped.localPause = LocalPauseState(paused: true)
        XCTAssertTrue(MenuBarState.reduce(status: nil, control: nil, approvals: [], services: stopped).stopped)

        var up = Fixtures.up
        up.localPause = LocalPauseState(paused: true)
        XCTAssertEqual(MenuBarState.reduce(status: Fixtures.okStatus, control: ControlState(paused: false), approvals: [], services: up).kind, .idle,
                       "with Control up, Control's answer is the state")
    }
}
