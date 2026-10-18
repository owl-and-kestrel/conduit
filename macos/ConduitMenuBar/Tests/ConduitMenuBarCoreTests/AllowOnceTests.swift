import XCTest
@testable import ConduitMenuBarCore

/// S6: Allow once eligibility. Shell and review never get Allow once.
final class AllowOnceTests: XCTestCase {
    func testFileWriteWithPathIsEligible() {
        XCTAssertEqual(AllowOnce.eligibility(for: Fixtures.approval()), .eligible(path: "src/app.ts"))
    }

    func testShellIsNeverEligible() {
        let shell = Fixtures.approval(tool: "shell.run", path: nil, command: "npm test")
        XCTAssertEqual(AllowOnce.eligibility(for: shell), .ineligible)
        // Even with a path-looking arg smuggled in.
        let sneaky = Fixtures.approval(tool: "shell.run", path: "src/app.ts", command: "rm -rf src")
        XCTAssertEqual(AllowOnce.eligibility(for: sneaky), .ineligible)
    }

    func testUntrustedReviewIsNeverEligible() {
        let review = Fixtures.approval(tool: "conduit.review", path: "README.md")
        XCTAssertEqual(AllowOnce.eligibility(for: review), .ineligible)
    }

    func testOtherToolsAreNotEligible() {
        for tool in ["conduit.extension.prepareAlphaInstall", "network.fetch", "file.read", "git.diff", "unknown.tool"] {
            XCTAssertEqual(AllowOnce.eligibility(for: Fixtures.approval(tool: tool)), .ineligible, tool)
        }
    }

    func testWriteWithoutADisplayablePathIsNotEligible() {
        XCTAssertEqual(AllowOnce.eligibility(for: Fixtures.approval(path: nil)), .ineligible)
        XCTAssertEqual(AllowOnce.eligibility(for: Fixtures.approval(path: "")), .ineligible)
        XCTAssertEqual(AllowOnce.eligibility(for: Fixtures.approval(path: "a\nb")), .ineligible)
        XCTAssertEqual(AllowOnce.eligibility(for: Fixtures.approval(path: String(repeating: "x/", count: 100))), .ineligible)
    }

    func testDecidedOrExecutingRecordsAreNotEligible() {
        XCTAssertEqual(AllowOnce.eligibility(for: Fixtures.approval(status: "expired")), .ineligible)
        XCTAssertEqual(AllowOnce.eligibility(for: Fixtures.approval(status: "approved")), .ineligible)
        XCTAssertEqual(AllowOnce.eligibility(for: Fixtures.approval(executionStatus: "running")), .ineligible)
    }

    func testSingleFilePatchIsEligible() {
        let patch = """
        diff --git a/src/app.ts b/src/app.ts
        --- a/src/app.ts
        +++ b/src/app.ts
        @@ -1 +1 @@
        -old
        +new
        """
        XCTAssertEqual(AllowOnce.eligibility(for: Fixtures.approval(tool: "file.patch", path: nil, patch: patch)), .eligible(path: "src/app.ts"))
        let created = "--- /dev/null\n+++ b/docs/new.md\n@@ -0,0 +1 @@\n+hi\n"
        XCTAssertEqual(AllowOnce.eligibility(for: Fixtures.approval(tool: "file.patch", path: nil, patch: created)), .eligible(path: "docs/new.md"))
    }

    func testMultiFileRenameAndDeletePatchesAreNotEligible() {
        let two = "--- a/a.ts\n+++ b/a.ts\n@@\n-x\n+y\n--- a/b.ts\n+++ b/b.ts\n@@\n-x\n+y\n"
        let rename = "diff --git a/a.ts b/z.ts\nrename from a.ts\nrename to z.ts\n"
        let delete = "diff --git a/a.ts b/a.ts\ndeleted file mode 100644\n--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n"
        let mismatched = "--- src/app.ts.orig\n+++ src/app.ts\n@@\n-x\n+y\n"
        for patch in [two, rename, delete, mismatched, ""] {
            XCTAssertEqual(AllowOnce.eligibility(for: Fixtures.approval(tool: "file.patch", path: nil, patch: patch)), .ineligible, patch)
        }
    }

    func testNotificationNamesTheExactPathAndCategory() {
        let note = AskNotification.make(for: Fixtures.approval())
        XCTAssertEqual(note.categoryIdentifier, AskNotification.categoryAllowOnce)
        XCTAssertTrue(note.body.hasPrefix("Edit src/app.ts"), note.body)
        XCTAssertEqual(note.userInfo["path"], "src/app.ts")
        XCTAssertEqual(note.userInfo["tool"], "file.write")
        XCTAssertEqual(note.identifier, "conduit-approval-approval_1")

        let shell = AskNotification.make(for: Fixtures.approval(tool: "shell.run", path: nil, command: "npm test"))
        XCTAssertEqual(shell.categoryIdentifier, AskNotification.categoryReviewOnly)
        XCTAssertNil(shell.userInfo["path"])
        XCTAssertTrue(shell.body.contains("Open Conduit"))

        let review = AskNotification.make(for: Fixtures.approval(tool: "conduit.review", path: nil))
        XCTAssertEqual(review.categoryIdentifier, AskNotification.categoryReviewOnly)
        XCTAssertEqual(review.title, "Conduit review required")
    }

    func testAllowOnceFromANotificationReChecksWhatWasShown() {
        let current = Fixtures.approval()
        XCTAssertTrue(AskNotification.allowOnceStillMatches(current: current, shownTool: "file.write", shownPath: "src/app.ts"))
        XCTAssertFalse(AskNotification.allowOnceStillMatches(current: current, shownTool: "file.write", shownPath: "src/other.ts"))
        XCTAssertFalse(AskNotification.allowOnceStillMatches(current: current, shownTool: "file.patch", shownPath: "src/app.ts"))
        XCTAssertFalse(AskNotification.allowOnceStillMatches(current: Fixtures.approval(status: "expired"), shownTool: "file.write", shownPath: "src/app.ts"))
        XCTAssertFalse(AskNotification.allowOnceStillMatches(current: current, shownTool: nil, shownPath: nil))
    }

    func testSourceLabels() {
        XCTAssertEqual(AskPresentation.source(for: Fixtures.approval()), "Local run")
        let fromChat = try! JSONDecoder().decode(ApprovalSummary.self, from: Fixtures.json(#"{"approvalId":"approval_s","status":"pending","sessionId":"session_1","action":{"tool":"file.write","args":{"path":"a"}}}"#))
        XCTAssertEqual(AskPresentation.source(for: fromChat), "Trusted chat")
        XCTAssertEqual(AskPresentation.source(for: Fixtures.approval(tool: "conduit.review", path: nil)), "Unknown source (no trusted chat)")
    }

    func testHumanTitles() {
        XCTAssertEqual(AskPresentation.title(for: Fixtures.approval()), "Edit src/app.ts")
        XCTAssertEqual(AskPresentation.title(for: Fixtures.approval(tool: "shell.run", path: nil, command: "npm test")), "Run npm test")
        XCTAssertEqual(AskPresentation.title(for: Fixtures.approval(tool: "conduit.review", path: nil)), "Review a Conduit request")
        XCTAssertEqual(
            AskPresentation.decisionLine(for: Fixtures.approval(status: "approved", decidedBy: "notification")),
            "approved · you · notification"
        )
    }
}
