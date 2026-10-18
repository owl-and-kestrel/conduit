import XCTest
@testable import ConduitMenuBarCore

/// S5: reducer, API JSON -> idle, running, needs-you, paused or error.
final class MenuBarStateTests: XCTestCase {
    func testDecodesControlApiJsonIntoNeedsYou() throws {
        let status = try JSONDecoder().decode(ControlStatusResponse.self, from: Fixtures.json("""
        {"status":"ok","mode":"Compliance","paused":false,"stateRoot":"/x","capabilities":{"agentHandshake":true,"conduitUrlOpen":true,"approvals":true,"pause":true}}
        """))
        let control = try JSONDecoder().decode(ControlEnvelope.self, from: Fixtures.json("""
        {"control":{"paused":false,"pause":{"paused":false},"liveSessions":2,"pausedSessions":[],"pendingApprovals":1}}
        """)).control
        let approvals = try JSONDecoder().decode(ApprovalsResponse.self, from: Fixtures.json("""
        {"approvals":[
          {"approvalId":"approval_new","status":"pending","createdAt":"2026-10-18T06:05:00.000Z","policyReason":"ask","prompt":"p",
           "action":{"id":"a1","tool":"shell.run","args":{"command":"npm test"}}},
          {"approvalId":"approval_old","status":"pending","createdAt":"2026-10-18T06:01:00.000Z",
           "action":{"id":"a1","tool":"file.write","args":{"path":"src/app.ts","content":"x","mode":"overwrite"}}},
          {"approvalId":"approval_done","status":"approved","decidedBy":"cli","decidedAt":"2026-10-18T05:00:00.000Z","createdAt":"2026-10-18T04:59:00.000Z",
           "action":{"tool":"conduit.review","args":{"title":"Read README","actions":[{"id":"r1","tool":"file.read"}],"permissions":[]}}},
          {"approvalId":"approval_weird","status":"pending","createdAt":"2026-10-18T06:02:00.000Z","executionStatus":"running",
           "action":{"tool":"conduit.review","args":"not-an-object"}}
        ]}
        """)).approvals

        let state = MenuBarState.reduce(status: status, control: control, approvals: approvals, services: Fixtures.up)

        XCTAssertEqual(state.kind, .needsYou(count: 2))
        XCTAssertEqual(state.asks.map(\.approvalId), ["approval_old", "approval_new"], "oldest first; executing records are not asks")
        XCTAssertEqual(state.recentDecisions.map(\.approvalId), ["approval_done"])
        XCTAssertEqual(state.asks.last?.action.args?.command, "npm test")
        XCTAssertNil(approvals[3].action.args, "a malformed args field does not lose the record")
    }

    func testIdleHeadlineCountsTrustedChats() {
        let state = MenuBarState.reduce(
            status: Fixtures.okStatus,
            control: ControlState(paused: false, liveSessions: 3),
            approvals: [],
            services: Fixtures.up
        )
        XCTAssertEqual(state.kind, .idle)
        XCTAssertEqual(state.headline, "Quiet · 3 chats trusted")
        XCTAssertFalse(state.paused)
    }

    func testRunningWhenAReviewExecutesOrADecisionIsInFlight() {
        let executing = Fixtures.approval(status: "approved", executionStatus: "running")
        XCTAssertEqual(
            MenuBarState.reduce(status: Fixtures.okStatus, control: nil, approvals: [executing], services: Fixtures.up).kind,
            .running
        )
        XCTAssertEqual(
            MenuBarState.reduce(status: Fixtures.okStatus, control: nil, approvals: [], services: Fixtures.up, inFlightDecisions: 1).kind,
            .running
        )
    }

    func testNeedsYouWinsOverRunning() {
        let ask = Fixtures.approval(id: "approval_ask")
        let executing = Fixtures.approval(id: "approval_run", status: "approved", executionStatus: "running")
        let state = MenuBarState.reduce(status: Fixtures.okStatus, control: nil, approvals: [ask, executing], services: Fixtures.up, inFlightDecisions: 1)
        XCTAssertEqual(state.kind, .needsYou(count: 1))
    }

    func testPausedFromControlWinsOverNeedsYouAndKeepsTheCount() {
        let control = ControlState(paused: true, pause: PauseDetail(pausedAt: "2026-10-18T14:02:00.000Z", pausedBy: "menubar"))
        let state = MenuBarState.reduce(
            status: Fixtures.okStatus,
            control: control,
            approvals: [Fixtures.approval()],
            services: Fixtures.up
        )
        XCTAssertEqual(state.kind, .paused(pendingCount: 1))
        XCTAssertTrue(state.paused)
        XCTAssertTrue(state.headline.hasPrefix("Paused since "), state.headline)
        XCTAssertEqual(state.asks.count, 1, "asks stay visible (deny still works while paused)")
    }

    func testPausedFromStatusAloneAndUnreadableFailsClosed() {
        XCTAssertEqual(
            MenuBarState.reduce(status: Fixtures.pausedStatus, control: nil, approvals: [], services: Fixtures.up).kind,
            .paused(pendingCount: 0)
        )
        let unreadable = MenuBarState.reduce(
            status: Fixtures.pausedStatus,
            control: ControlState(paused: true, pause: PauseDetail(unreadable: true)),
            approvals: [],
            services: Fixtures.up
        )
        XCTAssertTrue(unreadable.headline.contains("unreadable"))
    }

    func testControlUnreachableIsAnErrorNotIdle() {
        let state = MenuBarState.reduce(status: nil, control: nil, approvals: [], services: ServiceSnapshot(controlReachable: false))
        XCTAssertEqual(state.kind, .error(reason: "Conduit Control is not running.", fix: .restartServices))
    }

    func testControlStartingIsNotAnError() {
        let state = MenuBarState.reduce(status: nil, control: nil, approvals: [], services: ServiceSnapshot(controlReachable: false, controlStarting: true))
        XCTAssertEqual(state.kind, .running)
        XCTAssertEqual(state.headline, "Starting Conduit…")
    }

    func testStoppedByUserIsPausedEvenWithControlDown() {
        let state = MenuBarState.reduce(status: nil, control: nil, approvals: [], services: ServiceSnapshot(controlReachable: false, stoppedByUser: true))
        XCTAssertEqual(state.kind, .paused(pendingCount: 0))
        XCTAssertTrue(state.stopped)
    }

    func testCrashedServiceAndListenerAttentionAreErrors() {
        let crashed = MenuBarState.reduce(
            status: Fixtures.okStatus, control: nil, approvals: [],
            services: ServiceSnapshot(controlReachable: true, crashedServices: ["Agent listener"])
        )
        XCTAssertEqual(crashed.kind, .error(reason: "Agent listener stopped unexpectedly.", fix: .restartServices))

        let listener = MenuBarState.reduce(
            status: Fixtures.okStatus, control: nil, approvals: [],
            services: ServiceSnapshot(controlReachable: true, agentListenerNeedsAttention: true)
        )
        guard case .error(_, .openLogs) = listener.kind else {
            return XCTFail("expected an error with Open Logs, got \(listener.kind)")
        }
    }

    func testRecentFailedExecutionIsAnErrorUntilDismissedOrOld() {
        let now = parseISODate("2026-10-18T06:10:00.000Z")!
        let failed = Fixtures.approval(id: "approval_failed", status: "approved", executionStatus: "failed", executionFinishedAt: "2026-10-18T06:05:00.000Z")

        let fresh = MenuBarState.reduce(status: Fixtures.okStatus, control: nil, approvals: [failed], services: Fixtures.up, now: now)
        XCTAssertEqual(fresh.kind, .error(reason: "Tool failed.", fix: .reviewFailure(approvalId: "approval_failed")))

        let dismissed = MenuBarState.reduce(status: Fixtures.okStatus, control: nil, approvals: [failed], services: Fixtures.up, dismissedFailureIds: ["approval_failed"], now: now)
        XCTAssertEqual(dismissed.kind, .idle)

        let later = MenuBarState.reduce(status: Fixtures.okStatus, control: nil, approvals: [failed], services: Fixtures.up, now: now.addingTimeInterval(3600))
        XCTAssertEqual(later.kind, .idle)
    }

    func testOlderControlWithoutPauseFieldIsNotReportedPaused() {
        let legacy = ControlStatusResponse(paused: nil, capabilities: ControlCapabilities(agentHandshake: true))
        XCTAssertEqual(MenuBarState.reduce(status: legacy, control: nil, approvals: [], services: Fixtures.up).kind, .idle)
    }
}
