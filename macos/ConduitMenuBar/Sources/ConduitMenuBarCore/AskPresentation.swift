import Foundation

/// How an ask is shown: the action in human terms ("Edit `src/app.ts`", "Run
/// `npm test`"), plus the source and reason (spec §2.2 item 3).
public enum AskPresentation {
    public static func title(for approval: ApprovalSummary) -> String {
        let args = approval.action.args
        switch approval.action.tool {
        case "conduit.review":
            if let title = args?.title, !title.isEmpty {
                return "Review: \(oneLine(title, limit: 80))"
            }
            return "Review a Conduit request"
        case "file.write":
            if let path = args?.path, !path.isEmpty {
                return "Edit \(oneLine(path, limit: 80))"
            }
            return "Write a file"
        case "file.patch":
            let paths = AllowOnce.patchTargets(args?.patch ?? "")
            let files = paths.filter { !$0.hasPrefix("<") }
            if paths.count == 1, let path = paths.first {
                return "Patch \(oneLine(path, limit: 80))"
            }
            if files.count < paths.count {
                return "Patch: open details to check everything it changes"
            }
            return files.isEmpty ? "Apply a patch" : "Patch \(files.count) files"
        case "shell.run":
            if let command = args?.command, !command.isEmpty {
                return "Run \(oneLine(command, limit: 80))"
            }
            return "Run a shell command"
        default:
            return humanToolName(approval.action.tool).capitalizedFirst
        }
    }

    public static func subtitle(for approval: ApprovalSummary) -> String {
        if let description = approval.action.args?.description, !description.isEmpty {
            return description
        }
        if let reason = approval.action.reason, !reason.isEmpty {
            return reason
        }
        if let policyReason = approval.policyReason, !policyReason.isEmpty {
            return policyReason
        }
        return "A local action is waiting for approval."
    }

    public static func source(for approval: ApprovalSummary) -> String {
        if let source = approval.action.args?.source {
            let parts = [source.kind, source.publisher, source.domain, source.trust].compactMap { $0 }
            if !parts.isEmpty {
                return parts.joined(separator: " / ")
            }
        }
        if approval.isReview {
            return "Unknown source (no trusted chat)"
        }
        return approval.sessionId == nil ? "Local run" : "Trusted chat"
    }

    /// Detail lines for the expanded row. Everything a person needs to see
    /// before saying yes: the exact command, path, patch or requested actions.
    public static func details(for approval: ApprovalSummary) -> [(label: String, value: String)] {
        var rows: [(String, String)] = [("Source", source(for: approval))]
        let args = approval.action.args
        if let command = args?.command { rows.append(("Command", command)) }
        if let path = args?.path { rows.append(("Path", path)) }
        if let patch = args?.patch { rows.append(("Patch", truncate(patch, limit: 2000))) }
        if let actions = args?.actions, !actions.isEmpty {
            let lines = actions.prefix(12).map { action in
                "\(action.id): \(humanToolName(action.tool))\(action.reason.map { " - \($0)" } ?? "")"
            }
            let overflow = actions.count > 12 ? ["\(actions.count - 12) more action(s)"] : []
            rows.append(("Actions", (lines + overflow).joined(separator: "\n")))
        }
        if let capabilities = args?.requestedCapabilities, !capabilities.isEmpty {
            rows.append(("Permissions", capabilities.joined(separator: ", ")))
        } else if let permissions = args?.permissions, !permissions.isEmpty {
            rows.append(("Permissions", permissions.map { [$0.kind, $0.scope, $0.access].compactMap { $0 }.joined(separator: ": ") }.joined(separator: ", ")))
        }
        if let policy = approval.policyReason, !policy.isEmpty { rows.append(("Policy", policy)) }
        if approval.isReview {
            rows.append(("Decision", "Approve once runs this one request under a read-only policy. It does not trust the source."))
        }
        return rows
    }

    /// "approved · you · menubar", "expired · timeout", for recent activity.
    public static func decisionLine(for approval: ApprovalSummary) -> String {
        var parts = [approval.status]
        if let by = approval.decidedBy {
            switch by {
            case "menubar": parts.append("you · menu bar")
            case "notification": parts.append("you · notification")
            case "cli": parts.append("you · CLI")
            case "control-app": parts.append("you · control panel")
            default: parts.append(by)
            }
        }
        if let execution = approval.executionStatus {
            parts.append(execution)
        }
        return parts.joined(separator: " · ")
    }

    public static func humanToolName(_ tool: String) -> String {
        switch tool {
        case "conduit.extension.prepareAlphaInstall": return "prepare Conduit Bridge extension package"
        case "conduit.review": return "review Conduit request"
        case "file.read": return "read file"
        case "file.write": return "write file"
        case "file.patch": return "apply patch"
        case "shell.run": return "run shell command"
        case "git.status": return "check git status"
        case "git.diff": return "inspect git diff"
        default: return tool
        }
    }

    static func oneLine(_ text: String, limit: Int) -> String {
        let flattened = text.replacingOccurrences(of: "\n", with: " ⏎ ").replacingOccurrences(of: "\r", with: " ")
        return truncate(flattened, limit: limit)
    }

    static func truncate(_ text: String, limit: Int) -> String {
        text.count <= limit ? text : String(text.prefix(limit)) + "…"
    }
}

/// Allow once from a notification (spec §2.2 item 2).
///
/// A notification shows one short line, so it may offer Allow once only when
/// that line names everything the approval does. That is true only for a file
/// write or a single-file patch, where the body names the exact path. Shell
/// commands, untrusted reviews, multi-file patches and anything else must be
/// opened in the popover so the full command or manifest is visible first.
public enum AllowOnce {
    public enum Eligibility: Equatable {
        case eligible(path: String)
        case ineligible
    }

    public static func eligibility(for approval: ApprovalSummary) -> Eligibility {
        guard approval.isAwaitingDecision else { return .ineligible }
        switch approval.action.tool {
        case "file.write":
            guard let path = approval.action.args?.path, isDisplayablePath(path) else { return .ineligible }
            return .eligible(path: path)
        case "file.patch":
            let targets = patchTargets(approval.action.args?.patch ?? "")
            guard targets.count == 1, let path = targets.first, isDisplayablePath(path) else { return .ineligible }
            return .eligible(path: path)
        default:
            return .ineligible
        }
    }

    /// A path that fits on one notification line exactly as it will be acted
    /// on: no control characters and short enough not to be truncated.
    static func isDisplayablePath(_ path: String) -> Bool {
        !path.isEmpty
            && path.count <= 160
            && !path.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }

    /// Files a unified / git diff touches, as `git apply` (file.patch, default
    /// -p1) would act on them. Anything that is not a plain content change of
    /// a regular file adds a marker target ("<...>") on purpose, so such a
    /// patch is never "one file": a line saying "Patch x" must not hide that
    /// x is deleted, moved, made executable or a symlink, or that another
    /// file changes too. Markers:
    /// - rename / copy / delete headers, mode changes, a new file whose mode is
    ///   not 100644, binary patches;
    /// - a `diff --git` section with no `---`/`+++` lines (git apply still
    ///   applies its binary data, new empty file or mode change);
    /// - a `---`/`+++` name without the `a/` / `b/` prefix, or with an empty,
    ///   `.` or `..` component: git apply strips the first component whatever
    ///   it is, so the path shown would not be the path written.
    public static func patchTargets(_ patch: String) -> [String] {
        var targets: [String] = []
        var sectionHeader: Substring?
        var sectionHasFileLines = false
        func closeSection() {
            if let header = sectionHeader, !sectionHasFileLines {
                targets.append("<\(header)>")
            }
            sectionHeader = nil
            sectionHasFileLines = false
        }
        func add(_ raw: Substring, isNewSide: Bool) {
            sectionHasFileLines = true
            var path = raw.trimmingCharacters(in: .whitespaces)
            if let tab = path.firstIndex(of: "\t") { path = String(path[..<tab]) }
            if path == "/dev/null" {
                if isNewSide { targets.append("<deleted>") }
                return
            }
            if path.isEmpty { return }
            let prefix = isNewSide ? "b/" : "a/"
            if path.hasPrefix(prefix) {
                path = String(path.dropFirst(2))
                let components = path.split(separator: "/", omittingEmptySubsequences: false)
                if components.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) {
                    targets.append("<unclear path \(path)>")
                }
            } else {
                targets.append("<unprefixed path \(path)>")
            }
            if !targets.contains(path) { targets.append(path) }
        }
        let markerPrefixes = [
            "rename from ", "rename to ", "rename old ", "rename new ", "copy from ", "copy to ",
            "deleted file mode", "old mode ", "new mode ", "similarity index ", "dissimilarity index ",
            "GIT binary patch", "Binary files "
        ]
        for line in patch.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("diff --git ") {
                closeSection()
                sectionHeader = line
            } else if line.hasPrefix("--- ") {
                add(line.dropFirst(4), isNewSide: false)
            } else if line.hasPrefix("+++ ") {
                add(line.dropFirst(4), isNewSide: true)
            } else if line.hasPrefix("new file mode ") {
                // A new regular file is a plain write; executable or symlink is not.
                if line.trimmingCharacters(in: .whitespaces) != "new file mode 100644" {
                    targets.append("<\(line)>")
                }
            } else if markerPrefixes.contains(where: { line.hasPrefix($0) }) {
                targets.append("<\(line)>")
            }
        }
        closeSection()
        return targets
    }
}

/// Notification text and category for an ask.
public struct AskNotification: Equatable {
    public static let categoryAllowOnce = "conduit.ask.allow-once"
    public static let categoryReviewOnly = "conduit.ask.review-only"
    public static let actionAllowOnce = "conduit.ask.allow-once.action"
    public static let actionDeny = "conduit.ask.deny.action"
    public static let actionReview = "conduit.ask.review.action"

    public let identifier: String
    public let title: String
    public let body: String
    public let categoryIdentifier: String
    public let userInfo: [String: String]

    public static func make(for approval: ApprovalSummary) -> AskNotification {
        let eligibility = AllowOnce.eligibility(for: approval)
        var userInfo = [
            "conduitAction": "openAsk",
            "approvalId": approval.approvalId,
            "tool": approval.action.tool
        ]
        let title: String
        let body: String
        let category: String
        switch eligibility {
        case .eligible(let path):
            // The path shown is the path approved: the action handler re-reads
            // the record and refuses if it no longer matches.
            userInfo["path"] = path
            title = "Conduit: allow this edit?"
            body = "\(approval.action.tool == "file.patch" ? "Patch" : "Edit") \(path)\n\(AskPresentation.oneLine(AskPresentation.subtitle(for: approval), limit: 120))"
            category = categoryAllowOnce
        case .ineligible:
            title = approval.isReview ? "Conduit review required" : "Conduit approval required"
            body = "\(AskPresentation.title(for: approval))\nOpen Conduit to see the full request before allowing it."
            category = categoryReviewOnly
        }
        return AskNotification(
            identifier: "conduit-approval-\(approval.approvalId)",
            title: title,
            body: body,
            categoryIdentifier: category,
            userInfo: userInfo
        )
    }

    /// Re-check before acting on a notification's Allow once: the record must
    /// still be waiting, still eligible, and name the same tool and path the
    /// notification showed.
    public static func allowOnceStillMatches(current: ApprovalSummary, shownTool: String?, shownPath: String?) -> Bool {
        guard case .eligible(let path) = AllowOnce.eligibility(for: current) else { return false }
        return current.action.tool == shownTool && path == shownPath
    }
}

extension String {
    var capitalizedFirst: String {
        guard let first else { return self }
        return first.uppercased() + dropFirst()
    }
}
