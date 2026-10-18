import Foundation
import XCTest
@testable import ConduitMenuBarCore

/// The app adopts the Control already on 47831 only when it reports this
/// checkout. Another checkout's is never used, and one that does not report a
/// checkout is unverified (replaced by Restart services only when its process
/// is this checkout's).
final class ControlAdoptionTests: XCTestCase {
    private let checkout = "/x/conduit"
    private let sibling = "/x/conduit-fork"
    /// The test paths do not exist, so compare them as given.
    private let asGiven: (String) -> String? = { _ in nil }

    private func status(checkoutRoot: String?) -> ControlStatusResponse {
        ControlStatusResponse(
            paused: false,
            capabilities: ControlCapabilities(agentHandshake: true, conduitUrlOpen: true, pause: true),
            identity: ControlIdentity(checkoutRoot: checkoutRoot)
        )
    }

    func testThisCheckoutsControlIsAdopted() {
        let adoption = ControlAdoption.evaluate(status(checkoutRoot: checkout), appCheckoutRoot: checkout, resolve: asGiven)
        XCTAssertEqual(adoption, .thisCheckout)
        XCTAssertTrue(adoption.adopted)
    }

    func testSiblingCheckoutsControlIsNotAdopted() {
        let adoption = ControlAdoption.evaluate(status(checkoutRoot: sibling), appCheckoutRoot: checkout, resolve: asGiven)
        XCTAssertEqual(adoption, .otherCheckout(reportedRoot: sibling))
        XCTAssertFalse(adoption.adopted)
    }

    func testCheckoutNestedInThisOneIsAnotherCheckout() {
        let nested = "\(checkout)/.worktrees/feature"
        XCTAssertEqual(
            ControlAdoption.evaluate(status(checkoutRoot: nested), appCheckoutRoot: checkout, resolve: asGiven),
            .otherCheckout(reportedRoot: nested)
        )
    }

    func testControlWithoutIdentityIsUnverified() throws {
        // A Control from before identity existed: the exact /api/status shape it sends.
        let legacy = try JSONDecoder().decode(ControlStatusResponse.self, from: Fixtures.json("""
        {"status":"ok","mode":"Compliance","paused":false,"stateRoot":"/x","capabilities":{"agentHandshake":true,"pause":true}}
        """))
        XCTAssertNil(legacy.identity)
        XCTAssertEqual(ControlAdoption.evaluate(legacy, appCheckoutRoot: checkout, resolve: asGiven), .unverified)
        XCTAssertEqual(ControlAdoption.evaluate(status(checkoutRoot: nil), appCheckoutRoot: checkout, resolve: asGiven), .unverified)
        XCTAssertEqual(ControlAdoption.evaluate(status(checkoutRoot: ""), appCheckoutRoot: checkout, resolve: asGiven), .unverified)
        XCTAssertFalse(ControlAdoption.unverified.adopted)
    }

    func testAppWithoutACheckoutAdoptsNothing() {
        XCTAssertEqual(ControlAdoption.evaluate(status(checkoutRoot: checkout), appCheckoutRoot: nil, resolve: asGiven), .unverified)
    }

    func testNothingAnswering() {
        XCTAssertEqual(ControlAdoption.evaluate(nil, appCheckoutRoot: checkout, resolve: asGiven), .noAnswer)
        XCTAssertFalse(ControlAdoption.noAnswer.adopted)
    }

    func testDecodesIdentityFromControlStatus() throws {
        // The shape src/app/control-panel.ts sends.
        let decoded = try JSONDecoder().decode(ControlStatusResponse.self, from: Fixtures.json("""
        {"status":"ok","paused":false,"stateRoot":"/x","identity":{"checkoutRoot":"/x/conduit-fork"},"capabilities":{"agentHandshake":true,"pause":true}}
        """))
        XCTAssertEqual(decoded.identity, ControlIdentity(checkoutRoot: sibling))
        XCTAssertEqual(ControlAdoption.evaluate(decoded, appCheckoutRoot: checkout, resolve: asGiven), .otherCheckout(reportedRoot: sibling))
    }

    /// Real paths: a symlink to this checkout is this checkout; a sibling whose
    /// name extends this one is not.
    func testResolvesSymlinksWithRealpath() throws {
        let temp = try XCTUnwrap(ProcessProbe.resolvedPath(NSTemporaryDirectory()))
        let base = (temp as NSString).appendingPathComponent("conduit-adoption-\(UUID().uuidString)")
        let real = (base as NSString).appendingPathComponent("conduit")
        let fork = (base as NSString).appendingPathComponent("conduit-fork")
        let link = (base as NSString).appendingPathComponent("linked")
        try FileManager.default.createDirectory(atPath: real, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(atPath: fork, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: real)
        defer { try? FileManager.default.removeItem(atPath: base) }

        XCTAssertEqual(ControlAdoption.evaluate(status(checkoutRoot: real), appCheckoutRoot: link), .thisCheckout)
        XCTAssertEqual(ControlAdoption.evaluate(status(checkoutRoot: link), appCheckoutRoot: real), .thisCheckout)
        XCTAssertEqual(ControlAdoption.evaluate(status(checkoutRoot: fork), appCheckoutRoot: link), .otherCheckout(reportedRoot: fork))
    }

    // MARK: Status item

    func testAnotherCheckoutsControlIsAnErrorThatNamesItAndShowsNoAsks() {
        let state = MenuBarState.reduce(
            status: nil,
            control: nil,
            approvals: [Fixtures.approval()],
            services: ServiceSnapshot(controlReachable: true, controlAdoption: .otherCheckout(reportedRoot: sibling))
        )
        guard case .error(let reason, .restartServices) = state.kind else {
            return XCTFail("expected an error with Restart services, got \(state.kind)")
        }
        XCTAssertTrue(reason.contains(sibling))
        XCTAssertTrue(reason.contains("47831"))
        XCTAssertTrue(state.asks.isEmpty)
    }

    func testUnverifiedControlIsAnErrorWithRestart() {
        let state = MenuBarState.reduce(
            status: nil, control: nil, approvals: [],
            services: ServiceSnapshot(controlReachable: true, controlAdoption: .unverified)
        )
        guard case .error(let reason, .restartServices) = state.kind else {
            return XCTFail("expected an error with Restart services, got \(state.kind)")
        }
        XCTAssertTrue(reason.contains("does not say which checkout"))
    }

    func testStopAllStillWinsOverAnotherCheckoutsControl() {
        let state = MenuBarState.reduce(
            status: nil, control: nil, approvals: [],
            services: ServiceSnapshot(controlReachable: true, stoppedByUser: true, controlAdoption: .otherCheckout(reportedRoot: sibling))
        )
        XCTAssertEqual(state.kind, .paused(pendingCount: 0))
        XCTAssertTrue(state.stopped)
    }

    func testAdoptedControlBehavesAsBefore() {
        let state = MenuBarState.reduce(
            status: Fixtures.okStatus, control: nil, approvals: [],
            services: ServiceSnapshot(controlReachable: true, controlAdoption: .thisCheckout)
        )
        XCTAssertEqual(state.kind, .idle)
    }
}
