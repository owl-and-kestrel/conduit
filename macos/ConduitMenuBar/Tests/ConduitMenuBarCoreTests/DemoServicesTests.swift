import XCTest
@testable import ConduitMenuBarCore

/// Demo profile (S4) Core answers: capability gate, review decoding, uptime,
/// browser tracking and the add-always-allow-package decision body.
final class DemoServicesTests: XCTestCase {
    // 64 lowercase hex characters.
    private let sha = "4a1b6c8e2f7d3a5b9c0e1d2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b"

    private func review(actions: String) -> ApprovalSummary {
        let json = #"{"approvalId":"approval_start","status":"pending","action":{"tool":"conduit.review","args":{"title":"Run the demo","actions":\#(actions)}}}"#
        return try! JSONDecoder().decode(ApprovalSummary.self, from: Data(json.utf8))
    }

    private func startActionArgs(_ inner: String) -> String {
        #"{"id":"start","tool":"service.start","args":\#(inner)}"#
    }

    private var packageStart: String {
        startActionArgs(#"{"name":"Tiny Arena","package":{"url":"https://example.test/a.tgz","sha256":"\#(sha)"},"lan":true}"#)
    }

    // MARK: DemoProfile

    func testDemoProfileOffUnlessTheCapabilityIsTrue() {
        XCTAssertFalse(DemoProfile.isOn(nil))
        XCTAssertFalse(DemoProfile.isOn(Fixtures.okStatus))
        let off = ControlStatusResponse(paused: false, capabilities: ControlCapabilities(demoProfile: false, services: true, packageAllows: true))
        XCTAssertFalse(DemoProfile.isOn(off))
        let on = ControlStatusResponse(paused: false, capabilities: ControlCapabilities(agentHandshake: true, conduitUrlOpen: true, pause: true, demoProfile: true, services: true, packageAllows: true))
        XCTAssertTrue(DemoProfile.isOn(on))
    }

    func testServiceAskIsNilWhenDemoProfileIsOff() {
        XCTAssertNil(ServiceAsk.make(for: review(actions: "[" + packageStart + "]"), demoProfile: false))
        XCTAssertNil(ServiceAsk.make(for: Fixtures.approval(), demoProfile: true))
    }

    // MARK: ServiceAsk

    func testServiceAskDecodesPackageFormFromJSON() throws {
        let json = #"{"approvalId":"approval_start","status":"pending","action":{"tool":"conduit.review","args":{"actions":[{"id":"start","tool":"service.start","args":{"name":"Tiny Arena","package":{"url":"https://example.test/a.tgz","sha256":"\#(sha)"},"lan":true}}]}}}"#
        let approval = try JSONDecoder().decode(ApprovalSummary.self, from: Data(json.utf8))
        let ask = try XCTUnwrap(ServiceAsk.make(for: approval, demoProfile: true))
        XCTAssertEqual(ask.serviceNames, ["Tiny Arena"])
        XCTAssertEqual(ask.packageDigests, [sha])
        XCTAssertEqual(ask.pathDigests, [])
        XCTAssertTrue(ask.acceptsLocalNetwork)
        XCTAssertTrue(ask.packageOnly)
        XCTAssertTrue(ask.offersAlwaysAllow)
        XCTAssertEqual(ask.requester, AskPresentation.source(for: approval))
        XCTAssertEqual(ask.requester, "Unknown source (no trusted chat)")
        XCTAssertEqual(ServiceAsk.shortDigest(sha), "4a1b6c8e2f7d")
        XCTAssertFalse(ServiceAsk.localNetworkDisclosure.isEmpty)
        XCTAssertFalse(ServiceAsk.runsCodeNotice.isEmpty)
    }

    func testPackageOnlyIsFalseWhenAnotherActionIsPresent() throws {
        let actions = "[" + packageStart + "," + #"{"id":"sh","tool":"shell.run","args":{"command":"rm -rf dep"}}"# + "]"
        let ask = try XCTUnwrap(ServiceAsk.make(for: review(actions: actions), demoProfile: true))
        XCTAssertEqual(ask.serviceNames, ["Tiny Arena"])
        XCTAssertEqual(ask.packageDigests, [sha])
        XCTAssertFalse(ask.packageOnly)
        XCTAssertFalse(ask.offersAlwaysAllow)
    }

    func testRepeatedDigestsAreListedOnce() throws {
        let second = #"{"id":"start2","tool":"service.start","args":{"name":"Tiny Arena 2","package":{"url":"https://example.test/a.tgz","sha256":"\#(sha)"}}}"#
        let ask = try XCTUnwrap(ServiceAsk.make(for: review(actions: "[" + packageStart + "," + second + "]"), demoProfile: true))
        XCTAssertEqual(ask.serviceNames, ["Tiny Arena", "Tiny Arena 2"])
        XCTAssertEqual(ask.packageDigests, [sha])
        XCTAssertTrue(ask.packageOnly)
    }

    // MARK: Always allow remembers the network mode (Jon 2026-10-20)

    private var localPackageStart: String {
        startActionArgs(#"{"name":"Tiny Arena","package":{"url":"https://example.test/a.tgz","sha256":"\#(sha)"}}"#)
    }

    func testLocalAskRecordsLocalAndSaysALocalAllowDoesNotCoverLAN() throws {
        for start in [localPackageStart, startActionArgs(#"{"name":"Tiny Arena","package":{"url":"https://example.test/a.tgz","sha256":"\#(sha)"},"lan":false}"#)] {
            let ask = try XCTUnwrap(ServiceAsk.make(for: review(actions: "[" + start + "]"), demoProfile: true))
            XCTAssertFalse(ask.acceptsLocalNetwork)
            XCTAssertTrue(ask.offersAlwaysAllow)
            XCTAssertEqual(ask.alwaysAllowNetwork, "local")
            XCTAssertEqual(ask.alwaysAllowHelp, ServiceAsk.alwaysAllowHelpLocal)
            XCTAssertTrue(ask.alwaysAllowHelp.contains("on this Mac only"))
            XCTAssertTrue(ask.alwaysAllowHelp.contains("does not cover a later request for it to accept connections from your local network"))
            // No LAN note on a local ask.
            XCTAssertNil(ask.localAllowNote(packageAllowsSupported: true))
        }
    }

    func testLANAskRecordsLANAndExplainsALocalAllowDoesNotCoverIt() throws {
        let ask = try XCTUnwrap(ServiceAsk.make(for: review(actions: "[" + packageStart + "]"), demoProfile: true))
        XCTAssertTrue(ask.acceptsLocalNetwork)
        XCTAssertEqual(ask.alwaysAllowNetwork, "lan")
        XCTAssertEqual(ask.alwaysAllowHelp, ServiceAsk.alwaysAllowHelpLAN)
        XCTAssertTrue(ask.alwaysAllowHelp.contains("including when it accepts connections from your local network"))
        XCTAssertEqual(ask.localAllowNote(packageAllowsSupported: true), ServiceAsk.localAllowDoesNotCoverLAN)
        // Without the packageAllows capability there is no Always allow, so no note.
        XCTAssertNil(ask.localAllowNote(packageAllowsSupported: false))
        // One LAN start makes the whole request a LAN allow.
        let mixed = try XCTUnwrap(ServiceAsk.make(for: review(actions: "[" + localPackageStart + "," + packageStart + "]"), demoProfile: true))
        XCTAssertEqual(mixed.alwaysAllowNetwork, "lan")
    }

    func testNoHelpTextClaimsAnAllowCoversAnyMode() {
        // The S4 help said an allow covered a later LAN request; it no longer does.
        XCTAssertFalse(ServiceAsk.alwaysAllowHelpLocal.contains("including a later request"))
        XCTAssertFalse(ServiceAsk.alwaysAllowHelpLAN.contains("including a later request"))
    }

    func testLANNoteIsNilWhenAlwaysAllowIsNotOffered() throws {
        let actions = "[" + packageStart + "," + #"{"id":"sh","tool":"shell.run","args":{"command":"echo hi"}}"# + "]"
        let ask = try XCTUnwrap(ServiceAsk.make(for: review(actions: actions), demoProfile: true))
        XCTAssertTrue(ask.acceptsLocalNetwork)
        XCTAssertFalse(ask.offersAlwaysAllow)
        XCTAssertNil(ask.localAllowNote(packageAllowsSupported: true))
    }

    func testPackageOnlyIsFalseForThePathForm() throws {
        let pathStart = startActionArgs(#"{"name":"Tiny Arena","sha256":"\#(sha)","path":"server.mjs"}"#)
        let ask = try XCTUnwrap(ServiceAsk.make(for: review(actions: "[" + pathStart + "]"), demoProfile: true))
        XCTAssertEqual(ask.pathDigests, [sha])
        XCTAssertEqual(ask.packageDigests, [])
        XCTAssertFalse(ask.packageOnly)
        XCTAssertFalse(ask.offersAlwaysAllow)
    }

    // MARK: RunningServiceRow

    func testRunningServiceRowsFilterAndFormatUptime() throws {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        let now = try XCTUnwrap(formatter.date(from: "2026-10-18T06:06:30Z"))
        let services = [
            ServiceSummary(serviceId: "svc_a", name: "A", state: "starting", url: "http://127.0.0.1:8899", port: 8899, startedAt: "2026-10-18T06:04:50Z"),
            ServiceSummary(serviceId: "svc_b", name: "B", state: "ready", port: 8899, startedAt: "ignore", readyAt: "2026-10-18T06:06:10.500Z"),
            ServiceSummary(serviceId: "svc_c", name: "C", state: "ready", startedAt: "2026-10-18T04:06:30Z"),
            ServiceSummary(serviceId: "svc_d", name: "D", state: "exited", startedAt: "2026-10-18T06:00:00Z", readyAt: "2026-10-18T06:01:00Z", exitedAt: "2026-10-18T06:05:00Z"),
            ServiceSummary(serviceId: "svc_e", name: "E", state: "stopping", startedAt: "not a date"),
            ServiceSummary(serviceId: "svc_f", name: "F", state: "ready", startedAt: "2026-10-18T06:06:40Z")
        ]
        let rows = RunningServiceRow.rows(services, now: now)
        XCTAssertEqual(rows.map(\.id), ["svc_a", "svc_b", "svc_c", "svc_e", "svc_f"])
        XCTAssertEqual(rows[0].address, "http://127.0.0.1:8899")
        XCTAssertEqual(rows[0].uptime, "1m 40s")
        // Fallback to "port N" when Control sends no URL.
        XCTAssertEqual(rows[1].address, "port 8899")
        XCTAssertEqual(rows[1].uptime, "19s")
        XCTAssertEqual(rows[2].address, "")
        XCTAssertEqual(rows[2].uptime, "2h 0m")
        XCTAssertEqual(rows[3].address, "")
        XCTAssertEqual(rows[3].uptime, "")
        // Started in the future: clamped to 0.
        XCTAssertEqual(rows[4].uptime, "0s")
    }

    // MARK: BrowserOpenTracker

    func testBrowserOpenTrackerOpensTrackedReadyLoopbackOnce() {
        var tracker = BrowserOpenTracker()
        tracker.track(runId: "run_1")
        let services = [
            ServiceSummary(serviceId: "svc_a", name: "A", state: "ready", url: "http://127.0.0.1:8899", port: 8899, runId: "run_1"),
            ServiceSummary(serviceId: "svc_b", name: "B", state: "ready", url: "http://localhost:9000", port: 9000, runId: "run_1"),
            ServiceSummary(serviceId: "svc_c", name: "C", state: "ready", url: "http://192.168.1.5:9000", port: 9000, runId: "run_1"),
            ServiceSummary(serviceId: "svc_d", name: "D", state: "ready", url: "http://127.0.0.1:9001", port: 9001, runId: "run_2"),
            ServiceSummary(serviceId: "svc_e", name: "E", state: "starting", url: "http://127.0.0.1:9002", port: 9002, runId: "run_1")
        ]
        let first = tracker.servicesToOpen(services)
        XCTAssertEqual(first.map(\.serviceId), ["svc_a", "svc_b"])
        XCTAssertEqual(tracker.openedServiceIds, ["svc_a", "svc_b"])
        // Already opened: not offered again.
        XCTAssertEqual(tracker.servicesToOpen(services), [])

        tracker.track(runId: "run_2")
        XCTAssertEqual(tracker.servicesToOpen(services).map(\.serviceId), ["svc_d"])

        // Value type: a copy carries its own sets.
        var other = tracker
        other.track(runId: "run_3")
        XCTAssertEqual(tracker.trackedRunIds, ["run_1", "run_2"])
        XCTAssertEqual(other.trackedRunIds, ["run_1", "run_2", "run_3"])
    }

    // MARK: decisionBody

    func testDecisionBodyDefaultOutputIsUnchanged() {
        XCTAssertEqual(ControlClient.decisionBody(.approve, channel: .menubar), ["decidedBy": "menubar", "reason": "Approved from Conduit menu bar."])
        XCTAssertEqual(ControlClient.decisionBody(.approve, channel: .menubar, forThisChat: true), ["decidedBy": "menubar", "reason": "Allowed for this chat from Conduit menu bar.", "remember": "session"])
        XCTAssertEqual(ControlClient.decisionBody(.deny, channel: .menubar), ["decidedBy": "menubar", "reason": "Denied from Conduit menu bar."])
        XCTAssertEqual(ControlClient.decisionBody(.approve, channel: .notification), ["decidedBy": "notification", "reason": "Approved from Conduit notification."])
    }

    func testAlwaysAllowPackageAddsRememberPackage() {
        XCTAssertEqual(
            ControlClient.decisionBody(.approve, channel: .menubar, alwaysAllowPackage: true),
            ["decidedBy": "menubar", "reason": "Always allowed this exact package from Conduit menu bar.", "remember": "package"]
        )
        // "Always allow this exact package" wins over "for this chat".
        XCTAssertEqual(ControlClient.decisionBody(.approve, channel: .menubar, forThisChat: true, alwaysAllowPackage: true)["remember"], "package")
        // A deny is never remembered.
        XCTAssertNil(ControlClient.decisionBody(.deny, channel: .menubar, alwaysAllowPackage: true)["remember"])
        XCTAssertEqual(ControlClient.decisionBody(.deny, channel: .menubar, alwaysAllowPackage: true)["reason"], "Denied from Conduit menu bar.")
    }

    // MARK: endpoints and service ids

    func testServiceEndpointsMatchTheCliParityTable() {
        XCTAssertEqual(ControlEndpoint.services.method, "GET")
        XCTAssertEqual(ControlEndpoint.services.path, "/api/services")
        XCTAssertEqual(ControlEndpoint.stopService(id: "svc_a").method, "POST")
        XCTAssertEqual(ControlEndpoint.stopService(id: "svc_a").path, "/api/services/svc_a/stop")
    }

    func testIsValidServiceId() {
        XCTAssertTrue(isValidServiceId("svc_a"))
        XCTAssertTrue(isValidServiceId("svc_20261018_a-9"))
        XCTAssertFalse(isValidServiceId("../x"))
        XCTAssertFalse(isValidServiceId("svc_../x"))
        XCTAssertFalse(isValidServiceId("svc_"))
        XCTAssertFalse(isValidServiceId("SVC_a"))
        XCTAssertFalse(isValidServiceId("approval_1"))
        XCTAssertFalse(isValidServiceId(""))
    }

    func testStopServiceWithInvalidIdThrowsWithoutARequest() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let client = ControlClient(session: URLSession(configuration: configuration))
        StubURLProtocol.requests = []
        StubURLProtocol.reply = .init(status: 200, body: "{}")
        do {
            _ = try await client.stopService(id: "../x")
            XCTFail("expected a refusal")
        } catch {
            XCTAssertTrue(StubURLProtocol.requests.isEmpty)
        }
    }
}

/// With the demo profile off, the ask details are exactly what they were
/// before S4; on, only a review's Decision line changes.
final class DemoProfileOffUnchangedTests: XCTestCase {
    private func review() throws -> ApprovalSummary {
        let sha = String(repeating: "ab", count: 32)
        let json = #"{"approvalId":"approval_r","status":"pending","policyReason":"Untrusted request.","action":{"tool":"conduit.review","args":{"source":{"kind":"web","trust":"untrusted"},"title":"Host Tiny Arena","actions":[{"id":"host","tool":"service.start","args":{"name":"Tiny Arena","package":{"url":"http://127.0.0.1:9/p.tgz","sha256":"\#(sha)"},"lan":true}}]}}}"#
        return try JSONDecoder().decode(ApprovalSummary.self, from: Data(json.utf8))
    }

    private func flatten(_ rows: [(label: String, value: String)]) -> [String] {
        rows.map { "\($0.label)=\($0.value)" }
    }

    func testDetailsDefaultEqualsDemoOffAndKeepsTheReadOnlyDecision() throws {
        let ask = try review()
        XCTAssertEqual(flatten(AskPresentation.details(for: ask)), flatten(AskPresentation.details(for: ask, demoProfile: false)))
        XCTAssertEqual(
            flatten(AskPresentation.details(for: ask)),
            [
                "Source=web / untrusted",
                "Actions=host: service.start",
                "Policy=Untrusted request.",
                "Decision=Approve once runs this one request under a read-only policy. It does not trust the source."
            ]
        )
        XCTAssertNil(ServiceAsk.make(for: ask, demoProfile: false))
    }

    func testDemoOnChangesOnlyTheDecisionLine() throws {
        let ask = try review()
        let off = flatten(AskPresentation.details(for: ask))
        let on = flatten(AskPresentation.details(for: ask, demoProfile: true))
        XCTAssertEqual(Array(off.dropLast()), Array(on.dropLast()))
        XCTAssertEqual(on.last, "Decision=" + AskPresentation.demoReviewDecision)
        // Non-review asks are unaffected by the switch.
        let write = Fixtures.approval()
        XCTAssertEqual(flatten(AskPresentation.details(for: write)), flatten(AskPresentation.details(for: write, demoProfile: true)))
    }

    func testDemoCopyMakesNoSafetyClaim() {
        for text in [ServiceAsk.localNetworkDisclosure, ServiceAsk.runsCodeNotice, AskPresentation.demoReviewDecision, ServiceAsk.alwaysAllowHelpLocal, ServiceAsk.alwaysAllowHelpLAN, ServiceAsk.localAllowDoesNotCoverLAN] {
            let lower = text.lowercased()
            for word in ["safe", "secure", "protect", "sandbox", "verified", "trusted"] {
                XCTAssertFalse(lower.contains(word), "\(word) in: \(text)")
            }
        }
    }

    func testOlderControlStatusDecodesWithDemoOff() throws {
        let json = #"{"paused":false,"capabilities":{"agentHandshake":true,"conduitUrlOpen":true,"pause":true,"settings":true}}"#
        let status = try JSONDecoder().decode(ControlStatusResponse.self, from: Data(json.utf8))
        XCTAssertFalse(DemoProfile.isOn(status))
        XCTAssertNil(status.capabilities.services)
        let demo = #"{"paused":false,"capabilities":{"agentHandshake":true,"demoProfile":true,"services":true,"packageAllows":true}}"#
        let on = try JSONDecoder().decode(ControlStatusResponse.self, from: Data(demo.utf8))
        XCTAssertTrue(DemoProfile.isOn(on))
        XCTAssertEqual(on.capabilities.packageAllows, true)
    }

    func testRequestedActionsWithoutArgsStillDecode() throws {
        let json = #"{"approvalId":"approval_x","status":"pending","action":{"tool":"conduit.review","args":{"actions":[{"id":"a","tool":"file.read"},{"id":"b","tool":"shell.run","args":"not an object"}]}}}"#
        let approval = try JSONDecoder().decode(ApprovalSummary.self, from: Data(json.utf8))
        XCTAssertEqual(approval.action.args?.actions.map(\.tool), ["file.read", "shell.run"])
        XCTAssertNil(ServiceAsk.make(for: approval, demoProfile: true))
    }
}
