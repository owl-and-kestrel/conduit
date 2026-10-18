import XCTest
@testable import ConduitMenuBarCore

/// Return on shell-command asks (Jon 2026-10-18) and "Allow for this chat".
final class ReturnKeyGateTests: XCTestCase {
    private let shell = Fixtures.approval(tool: "shell.run", path: nil, command: "npm test", sessionId: "sess_1")

    func testReturnOnAShellCommandWithDetailsClosedOpensTheDetails() {
        XCTAssertTrue(ReturnKeyGate.opensDetailsFirst(shell, detailsOpen: false, returnApprovesShellWithoutDetails: false))
    }

    func testReturnOnAShellCommandWithDetailsOpenAllows() {
        XCTAssertFalse(ReturnKeyGate.opensDetailsFirst(shell, detailsOpen: true, returnApprovesShellWithoutDetails: false))
    }

    func testTheBypassSettingLetsReturnAllowWithDetailsClosed() {
        XCTAssertFalse(ReturnKeyGate.opensDetailsFirst(shell, detailsOpen: false, returnApprovesShellWithoutDetails: true))
    }

    func testOtherAsksAreNotGated() {
        XCTAssertFalse(ReturnKeyGate.opensDetailsFirst(Fixtures.approval(), detailsOpen: false, returnApprovesShellWithoutDetails: false))
        XCTAssertFalse(ReturnKeyGate.opensDetailsFirst(Fixtures.approval(tool: "file.patch", path: nil, patch: "diff"), detailsOpen: false, returnApprovesShellWithoutDetails: false))
    }

    func testAllowForThisChatIsOfferedOnlyForExactActionsFromAChat() {
        XCTAssertTrue(AllowForThisChat.isOffered(for: shell))
        XCTAssertTrue(AllowForThisChat.isOffered(for: Fixtures.approval(sessionId: "sess_1")))
        // No chat (a terminal run), a patch, an empty command, a decided ask.
        XCTAssertFalse(AllowForThisChat.isOffered(for: Fixtures.approval(tool: "shell.run", path: nil, command: "npm test")))
        XCTAssertFalse(AllowForThisChat.isOffered(for: Fixtures.approval(tool: "file.patch", path: nil, patch: "diff", sessionId: "sess_1")))
        XCTAssertFalse(AllowForThisChat.isOffered(for: Fixtures.approval(tool: "shell.run", path: nil, command: "", sessionId: "sess_1")))
        XCTAssertFalse(AllowForThisChat.isOffered(for: Fixtures.approval(status: "approved", sessionId: "sess_1")))
        XCTAssertFalse(AllowForThisChat.isOffered(for: Fixtures.approval(executionStatus: "running", sessionId: "sess_1")))
    }

    func testAnUntrustedReviewIsNeverOfferedAllowForThisChat() {
        let review = Fixtures.approval(tool: "conduit.review", path: nil, sessionId: "sess_1")
        XCTAssertFalse(AllowForThisChat.isOffered(for: review))
    }
}
