import Foundation

/// The status item's state (spec §3.1). Every input comes from the Control API
/// or from the supervisor's own view of the processes it launched.
public enum StatusKind: Equatable {
    case idle
    case running
    case needsYou(count: Int)
    case paused(pendingCount: Int)
    case error(reason: String, fix: ErrorFix)
}

/// The single fix action offered with an error (spec §3.1).
public enum ErrorFix: Equatable {
    case restartServices
    case openLogs
    case reviewFailure(approvalId: String)
}

/// What the supervisor knows about the processes it launched.
public struct ServiceSnapshot: Equatable {
    /// Control answered `/api/status` with 200 on the last poll.
    public var controlReachable: Bool
    /// Labels of supervised children that exited unexpectedly (non-zero) and
    /// were not stopped on purpose.
    public var crashedServices: [String]
    /// The agent listener reported a send it could not deliver after retries.
    public var agentListenerNeedsAttention: Bool
    /// The person used Stop all; services are down on purpose.
    public var stoppedByUser: Bool
    /// The supervisor launched Control and it has not answered yet.
    public var controlStarting: Bool
    /// Whether the Control that answered is this checkout's. One that is not
    /// is never used (the app passes no status for it) and is named here.
    public var controlAdoption: ControlAdoption

    public init(
        controlReachable: Bool,
        crashedServices: [String] = [],
        agentListenerNeedsAttention: Bool = false,
        stoppedByUser: Bool = false,
        controlStarting: Bool = false,
        controlAdoption: ControlAdoption = .thisCheckout
    ) {
        self.controlReachable = controlReachable
        self.crashedServices = crashedServices
        self.agentListenerNeedsAttention = agentListenerNeedsAttention
        self.stoppedByUser = stoppedByUser
        self.controlStarting = controlStarting
        self.controlAdoption = controlAdoption
    }
}

public struct MenuBarState: Equatable {
    public let kind: StatusKind
    /// Asks waiting for a person, oldest first (spec §2.2 item 3).
    public let asks: [ApprovalSummary]
    /// Recently decided approvals, newest first, with who decided.
    public let recentDecisions: [ApprovalSummary]
    public let headline: String
    public let paused: Bool
    /// The person used Stop all: services are off on purpose.
    public var stopped: Bool = false

    /// Oldest first, by `createdAt` (ISO 8601 sorts lexically), then id.
    public static func orderAsks(_ approvals: [ApprovalSummary]) -> [ApprovalSummary] {
        approvals
            .filter(\.isAwaitingDecision)
            .sorted { lhs, rhs in
                let l = lhs.createdAt ?? ""
                let r = rhs.createdAt ?? ""
                return l == r ? lhs.approvalId < rhs.approvalId : l < r
            }
    }

    /// The reducer. Precedence, highest first:
    /// 1. Control unreachable, or not this checkout's (ControlAdoption), while
    ///    not stopped on purpose: error. Without this checkout's Control the
    ///    menu bar cannot know whether anything is paused or waiting.
    /// 2. Paused (global flag, or stopped by the person): nothing executes, and
    ///    that must always be visible. Pending asks still show as a count.
    /// 3. Needs you: pending asks win over running (spec §3.1).
    /// 4. Other errors: a crashed child, an undeliverable agent send, or an
    ///    approved run that failed recently and was not dismissed.
    /// 5. Running: an approved review is executing, or a decision is in flight.
    /// 6. Idle.
    public static func reduce(
        status: ControlStatusResponse?,
        control: ControlState?,
        approvals: [ApprovalSummary],
        services: ServiceSnapshot,
        inFlightDecisions: Int = 0,
        dismissedFailureIds: Set<String> = [],
        now: Date = Date(),
        failureWindow: TimeInterval = 10 * 60
    ) -> MenuBarState {
        let asks = orderAsks(approvals)
        let recent = approvals
            .filter { !$0.isAwaitingDecision && $0.status != "pending" }
            .sorted { ($0.decidedAt ?? $0.createdAt ?? "") > ($1.decidedAt ?? $1.createdAt ?? "") }
        let recentDecisions = Array(recent.prefix(5))
        let paused = control?.paused ?? status?.paused ?? false

        if services.stoppedByUser {
            return MenuBarState(
                kind: .paused(pendingCount: asks.count),
                asks: asks,
                recentDecisions: recentDecisions,
                headline: "Stopped. Services are off and chats were disconnected.",
                paused: true,
                stopped: true
            )
        }

        // A Control on 47831 that is not this checkout's is not used. Restart
        // services replaces it only if its process is this checkout's;
        // otherwise the app reports who holds the port and leaves it running.
        switch services.controlAdoption {
        case .otherCheckout(let reportedRoot):
            let reason = "Port 47831 is held by Conduit Control from another checkout (\(reportedRoot)), so this app is not using it."
            return MenuBarState(kind: .error(reason: reason, fix: .restartServices), asks: [], recentDecisions: [], headline: reason, paused: false)
        case .unverified:
            let reason = "Conduit Control on port 47831 does not say which checkout it is from, so this app is not using it. Restart services to replace it."
            return MenuBarState(kind: .error(reason: reason, fix: .restartServices), asks: [], recentDecisions: [], headline: reason, paused: false)
        case .noAnswer, .thisCheckout:
            break
        }

        guard services.controlReachable, status != nil else {
            if services.controlStarting {
                return MenuBarState(kind: .running, asks: [], recentDecisions: [], headline: "Starting Conduit…", paused: false)
            }
            return MenuBarState(
                kind: .error(reason: "Conduit Control is not running.", fix: .restartServices),
                asks: [],
                recentDecisions: [],
                headline: "Conduit Control is not running.",
                paused: false
            )
        }

        if paused {
            return MenuBarState(
                kind: .paused(pendingCount: asks.count),
                asks: asks,
                recentDecisions: recentDecisions,
                headline: pausedHeadline(control?.pause),
                paused: true
            )
        }

        if !asks.isEmpty {
            return MenuBarState(
                kind: .needsYou(count: asks.count),
                asks: asks,
                recentDecisions: recentDecisions,
                headline: asks.count == 1 ? "1 request needs you" : "\(asks.count) requests need you",
                paused: false
            )
        }

        if let crashed = services.crashedServices.first {
            return MenuBarState(
                kind: .error(reason: "\(crashed) stopped unexpectedly.", fix: .restartServices),
                asks: asks,
                recentDecisions: recentDecisions,
                headline: "\(crashed) stopped unexpectedly.",
                paused: false
            )
        }
        if services.agentListenerNeedsAttention {
            let reason = "An agent message could not be sent after retries. Reload the ChatGPT tab or extension, then retry."
            return MenuBarState(
                kind: .error(reason: reason, fix: .openLogs),
                asks: asks,
                recentDecisions: recentDecisions,
                headline: "Agent listener needs attention",
                paused: false
            )
        }
        if let failure = recentFailure(approvals, dismissed: dismissedFailureIds, now: now, window: failureWindow) {
            return MenuBarState(
                kind: .error(reason: failure.executionError ?? "An approved request failed to run.", fix: .reviewFailure(approvalId: failure.approvalId)),
                asks: asks,
                recentDecisions: recentDecisions,
                headline: "An approved request failed",
                paused: false
            )
        }

        if inFlightDecisions > 0 || approvals.contains(where: { $0.executionStatus == "running" }) {
            return MenuBarState(kind: .running, asks: asks, recentDecisions: recentDecisions, headline: "Running…", paused: false)
        }

        let sessions = control?.liveSessions
        let headline: String
        switch sessions {
        case .some(0): headline = "Quiet · no chats trusted"
        case .some(1): headline = "Quiet · 1 chat trusted"
        case .some(let n): headline = "Quiet · \(n) chats trusted"
        case .none: headline = "Quiet"
        }
        return MenuBarState(kind: .idle, asks: asks, recentDecisions: recentDecisions, headline: headline, paused: false)
    }

    static func recentFailure(_ approvals: [ApprovalSummary], dismissed: Set<String>, now: Date, window: TimeInterval) -> ApprovalSummary? {
        approvals.first { approval in
            guard approval.executionStatus == "failed", !dismissed.contains(approval.approvalId) else {
                return false
            }
            guard let finished = approval.executionFinishedAt.flatMap(parseISODate) else {
                return false
            }
            return now.timeIntervalSince(finished) <= window
        }
    }

    static func pausedHeadline(_ pause: PauseDetail?) -> String {
        if pause?.unreadable == true {
            return "Paused · pause state unreadable (fail closed)"
        }
        guard let pausedAt = pause?.pausedAt.flatMap(parseISODate) else {
            return "Paused"
        }
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return "Paused since \(formatter.string(from: pausedAt))"
    }
}

/// Control writes `toISOString()` timestamps (with milliseconds).
public func parseISODate(_ text: String) -> Date? {
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = withFraction.date(from: text) {
        return date
    }
    return ISO8601DateFormatter().date(from: text)
}
