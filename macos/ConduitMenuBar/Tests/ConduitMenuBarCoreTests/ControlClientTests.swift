import XCTest
@testable import ConduitMenuBarCore

/// Records requests and answers from a per-test script. URLProtocol is the
/// supported way to fake URLSession without a server.
final class StubURLProtocol: URLProtocol {
    struct Reply {
        let status: Int
        let body: String
    }

    static var reply = Reply(status: 200, body: "{}")
    static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var recorded = request
        if recorded.httpBody == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(buffer, maxLength: 4096)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            buffer.deallocate()
            stream.close()
            recorded.httpBody = data
        }
        Self.requests.append(recorded)
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.reply.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.reply.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class ControlClientTests: XCTestCase {
    private var client: ControlClient!

    override func setUp() {
        super.setUp()
        StubURLProtocol.requests = []
        StubURLProtocol.reply = .init(status: 200, body: "{}")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        client = ControlClient(session: URLSession(configuration: configuration))
    }

    private func lastBody() throws -> [String: String] {
        let request = try XCTUnwrap(StubURLProtocol.requests.last)
        let body = try XCTUnwrap(request.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
    }

    func testMenuBarDecisionsSendDecidedByMenubar() async throws {
        StubURLProtocol.reply = .init(status: 200, body: #"{"approval":{"approvalId":"approval_1","status":"denied","action":{"tool":"file.write"}}}"#)
        _ = try await client.decide(approvalId: "approval_1", .deny, channel: .menubar)
        let request = try XCTUnwrap(StubURLProtocol.requests.last)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:47831/api/approvals/approval_1/deny")
        XCTAssertEqual(try lastBody()["decidedBy"], "menubar")
    }

    func testAllowForThisChatSendsRememberSession() async throws {
        StubURLProtocol.reply = .init(status: 200, body: #"{"approval":{"approvalId":"approval_1","status":"approved","action":{"tool":"shell.run"}}}"#)
        _ = try await client.decide(approvalId: "approval_1", .approve, channel: .menubar, forThisChat: true)
        XCTAssertEqual(StubURLProtocol.requests.last?.url?.path, "/api/approvals/approval_1/approve")
        XCTAssertEqual(try lastBody()["remember"], "session")
        XCTAssertEqual(try lastBody()["decidedBy"], "menubar")
        // Allow once never sends remember.
        _ = try await client.decide(approvalId: "approval_1", .approve, channel: .menubar)
        XCTAssertNil(try lastBody()["remember"])
        // A deny is never remembered, even if asked.
        XCTAssertNil(ControlClient.decisionBody(.deny, channel: .menubar, forThisChat: true)["remember"])
    }

    func testSettingsReadAndWriteUseTheSettingsEndpoint() async throws {
        StubURLProtocol.reply = .init(status: 200, body: #"{"settings":{"returnApprovesShellWithoutDetails":true}}"#)
        let read = try await client.settings()
        XCTAssertTrue(read.returnApprovesShellWithoutDetails)
        XCTAssertEqual(StubURLProtocol.requests.last?.httpMethod, "GET")
        XCTAssertEqual(StubURLProtocol.requests.last?.url?.path, "/api/settings")

        StubURLProtocol.reply = .init(status: 200, body: #"{"settings":{"returnApprovesShellWithoutDetails":false}}"#)
        let written = try await client.setReturnApprovesShellWithoutDetails(false)
        XCTAssertFalse(written.returnApprovesShellWithoutDetails)
        let request = try XCTUnwrap(StubURLProtocol.requests.last)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/settings")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(body["returnApprovesShellWithoutDetails"] as? Bool, false)
    }

    func testMissingOrMalformedSettingsKeepTheCautiousDefault() throws {
        let empty = try JSONDecoder().decode(SettingsResponse.self, from: Data(#"{"settings":{}}"#.utf8))
        XCTAssertFalse(empty.settings.returnApprovesShellWithoutDetails)
        let wrongType = try JSONDecoder().decode(SettingsResponse.self, from: Data(#"{"settings":{"returnApprovesShellWithoutDetails":"yes"}}"#.utf8))
        XCTAssertFalse(wrongType.settings.returnApprovesShellWithoutDetails)
    }

    func testNotificationDecisionsSendDecidedByNotification() async throws {
        StubURLProtocol.reply = .init(status: 200, body: #"{"execution":{"runId":"run_9"},"copiedToClipboard":true}"#)
        let response = try await client.decide(approvalId: "approval_1", .approve, channel: .notification)
        XCTAssertEqual(StubURLProtocol.requests.last?.url?.path, "/api/approvals/approval_1/approve")
        XCTAssertEqual(try lastBody()["decidedBy"], "notification")
        XCTAssertEqual(try lastBody()["reason"], "Approved from Conduit notification.")
        XCTAssertEqual(response.statusMessage, "Run run_9 completed and the result was copied to the clipboard.")
    }

    func testPauseResumeAndStopAllUseTheControlEndpointsAsMenubar() async throws {
        StubURLProtocol.reply = .init(status: 200, body: #"{"control":{"paused":true,"liveSessions":0}}"#)
        let paused = try await client.pause(by: .menubar, reason: "Paused from the menu bar.")
        XCTAssertTrue(paused.paused)
        XCTAssertEqual(StubURLProtocol.requests.last?.url?.path, "/api/control/pause")
        XCTAssertEqual(try lastBody(), ["by": "menubar", "reason": "Paused from the menu bar."])

        StubURLProtocol.reply = .init(status: 200, body: #"{"control":{"paused":false}}"#)
        _ = try await client.resume(by: .menubar)
        XCTAssertEqual(StubURLProtocol.requests.last?.url?.path, "/api/control/resume")
        XCTAssertEqual(try lastBody(), ["by": "menubar"])

        StubURLProtocol.reply = .init(status: 200, body: #"{"control":{"paused":true},"revokedSessions":["s1","s2"]}"#)
        let stopped = try await client.stopAll(by: .menubar)
        XCTAssertEqual(stopped.revokedSessions, ["s1", "s2"])
        XCTAssertEqual(StubURLProtocol.requests.last?.url?.path, "/api/control/stop-all")
        XCTAssertEqual(StubURLProtocol.requests.last?.httpMethod, "POST")
    }

    func testInvalidApprovalIdIsRefusedWithoutARequest() async {
        do {
            _ = try await client.decide(approvalId: "../sessions", .approve, channel: .notification)
            XCTFail("expected a refusal")
        } catch {
            XCTAssertTrue(StubURLProtocol.requests.isEmpty)
        }
        XCTAssertFalse(isValidApprovalId("approval_../x"))
        XCTAssertTrue(isValidApprovalId("approval_20261018_abc-1"))
    }

    func testConflictWhilePausedReadsAsAClearMessage() async {
        StubURLProtocol.reply = .init(status: 409, body: #"{"error":"Conduit is paused. Resume before approving.","approval":{"approvalId":"approval_1","status":"pending","action":{"tool":"file.write"}}}"#)
        await assertDecisionError(contains: "Conduit is paused, so this was not approved", status: "pending")
    }

    func testConflictPausedBeforeRunReadsAsAClearMessage() async {
        StubURLProtocol.reply = .init(status: 409, body: #"{"error":"Conduit was paused before this approved review ran, so nothing ran. Resume Conduit, then resend the request.","approval":{"approvalId":"approval_1","status":"approved","executionStatus":"failed","action":{"tool":"conduit.review"}},"execution":{"repair":{"code":"paused"}}}"#)
        await assertDecisionError(contains: "paused before this request ran, so nothing ran", status: "approved")
    }

    func testConflictExpiredReadsAsAClearMessage() async {
        StubURLProtocol.reply = .init(status: 409, body: #"{"error":"Approval is expired, not pending.","approval":{"approvalId":"approval_1","status":"expired","decidedBy":"timeout","action":{"tool":"file.write"}}}"#)
        await assertDecisionError(contains: "expired and was denied", status: "expired")
    }

    func testConflictAlreadyDecidedReadsAsAClearMessage() async {
        StubURLProtocol.reply = .init(status: 409, body: #"{"error":"Approval is denied, not pending.","approval":{"approvalId":"approval_1","status":"denied","action":{"tool":"file.write"}}}"#)
        await assertDecisionError(contains: "already denied somewhere else", status: "denied")
    }

    func testUnknownApprovalReadsAsGone() async {
        StubURLProtocol.reply = .init(status: 404, body: #"{"error":"Unknown approval request."}"#)
        await assertDecisionError(contains: "no longer exists", status: nil)
    }

    func testEndpointsMatchTheCliParityTable() {
        // Same method + path as CONTROL_CLI_ROUTES in src/cli/control-client.ts.
        let expected: [(ControlEndpoint, String, String)] = [
            (.control, "GET", "/api/control"),
            (.pause, "POST", "/api/control/pause"),
            (.resume, "POST", "/api/control/resume"),
            (.stopAll, "POST", "/api/control/stop-all"),
            (.approvals, "GET", "/api/approvals"),
            (.approval(id: "approval_1"), "GET", "/api/approvals/approval_1"),
            (.decide(id: "approval_1", .approve), "POST", "/api/approvals/approval_1/approve"),
            (.decide(id: "approval_1", .deny), "POST", "/api/approvals/approval_1/deny"),
            (.settings, "GET", "/api/settings"),
            (.updateSettings, "POST", "/api/settings")
        ]
        for (endpoint, method, path) in expected {
            XCTAssertEqual(endpoint.method, method)
            XCTAssertEqual(endpoint.path, path)
        }
    }

    private func assertDecisionError(contains text: String, status: String?, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await client.decide(approvalId: "approval_1", .approve, channel: .menubar)
            XCTFail("expected an error", file: file, line: line)
        } catch let error as ControlAPIError {
            XCTAssertTrue(error.userMessage.contains(text), error.userMessage, file: file, line: line)
            XCTAssertEqual(error.approvalStatus, status, file: file, line: line)
        } catch {
            XCTFail("unexpected error \(error)", file: file, line: line)
        }
    }
}
