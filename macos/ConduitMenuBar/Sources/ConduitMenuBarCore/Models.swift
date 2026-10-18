import Foundation

// Decodable views of the Conduit Control API (`127.0.0.1:47831`). Decoding is
// deliberately lenient: an unknown or missing optional field never makes the
// menu bar lose the whole approvals list.

public struct ApprovalsResponse: Decodable {
    public let approvals: [ApprovalSummary]
}

public struct ApprovalResponse: Decodable {
    public let approval: ApprovalSummary
}

public struct ApprovalSummary: Decodable, Equatable, Identifiable {
    public let approvalId: String
    public let status: String
    public let policyReason: String?
    public let prompt: String?
    /// Set when the ask comes from a live session (a trusted chat).
    public let sessionId: String?
    public let createdAt: String?
    public let expiresAt: String?
    public let decidedAt: String?
    public let decidedBy: String?
    public let decisionReason: String?
    public let executionStatus: String?
    public let executionError: String?
    public let executionFinishedAt: String?
    public let action: ApprovalActionSummary

    public var id: String { approvalId }

    public init(
        approvalId: String,
        status: String,
        policyReason: String? = nil,
        prompt: String? = nil,
        sessionId: String? = nil,
        createdAt: String? = nil,
        expiresAt: String? = nil,
        decidedAt: String? = nil,
        decidedBy: String? = nil,
        decisionReason: String? = nil,
        executionStatus: String? = nil,
        executionError: String? = nil,
        executionFinishedAt: String? = nil,
        action: ApprovalActionSummary
    ) {
        self.approvalId = approvalId
        self.status = status
        self.policyReason = policyReason
        self.prompt = prompt
        self.sessionId = sessionId
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.decidedAt = decidedAt
        self.decidedBy = decidedBy
        self.decisionReason = decisionReason
        self.executionStatus = executionStatus
        self.executionError = executionError
        self.executionFinishedAt = executionFinishedAt
        self.action = action
    }

    enum CodingKeys: String, CodingKey {
        case approvalId, status, policyReason, prompt, sessionId, createdAt, expiresAt, decidedAt, decidedBy
        case decisionReason, executionStatus, executionError, executionFinishedAt, action
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        approvalId = try c.decode(String.self, forKey: .approvalId)
        status = try c.decode(String.self, forKey: .status)
        action = try c.decode(ApprovalActionSummary.self, forKey: .action)
        policyReason = try? c.decode(String.self, forKey: .policyReason)
        prompt = try? c.decode(String.self, forKey: .prompt)
        sessionId = try? c.decode(String.self, forKey: .sessionId)
        createdAt = try? c.decode(String.self, forKey: .createdAt)
        expiresAt = try? c.decode(String.self, forKey: .expiresAt)
        decidedAt = try? c.decode(String.self, forKey: .decidedAt)
        decidedBy = try? c.decode(String.self, forKey: .decidedBy)
        decisionReason = try? c.decode(String.self, forKey: .decisionReason)
        executionStatus = try? c.decode(String.self, forKey: .executionStatus)
        executionError = try? c.decode(String.self, forKey: .executionError)
        executionFinishedAt = try? c.decode(String.self, forKey: .executionFinishedAt)
    }

    /// Waiting for a person: pending and not already handed to execution.
    public var isAwaitingDecision: Bool {
        status == "pending" && executionStatus == nil
    }

    public var isReview: Bool {
        action.tool == "conduit.review"
    }
}

public struct ApprovalActionSummary: Decodable, Equatable {
    public let id: String?
    public let tool: String
    public let reason: String?
    public let args: ApprovalActionArgs?

    public init(id: String? = nil, tool: String, reason: String? = nil, args: ApprovalActionArgs? = nil) {
        self.id = id
        self.tool = tool
        self.reason = reason
        self.args = args
    }

    enum CodingKeys: String, CodingKey { case id, tool, reason, args }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tool = try c.decode(String.self, forKey: .tool)
        id = try? c.decode(String.self, forKey: .id)
        reason = try? c.decode(String.self, forKey: .reason)
        args = try? c.decode(ApprovalActionArgs.self, forKey: .args)
    }
}

/// Union of the arg shapes the menu bar displays: tool args for confirmations
/// (`file.write` path, `file.patch` patch, `shell.run` command) and the request
/// summary that `conduit.review` records carry.
public struct ApprovalActionArgs: Decodable, Equatable {
    public let path: String?
    public let patch: String?
    public let command: String?
    public let source: ApprovalSource?
    public let title: String?
    public let description: String?
    public let permissions: [ApprovalPermission]
    public let requestedCapabilities: [String]?
    public let actions: [ApprovalRequestedAction]
    public let sessionId: String?

    public init(
        path: String? = nil,
        patch: String? = nil,
        command: String? = nil,
        source: ApprovalSource? = nil,
        title: String? = nil,
        description: String? = nil,
        permissions: [ApprovalPermission] = [],
        requestedCapabilities: [String]? = nil,
        actions: [ApprovalRequestedAction] = [],
        sessionId: String? = nil
    ) {
        self.path = path
        self.patch = patch
        self.command = command
        self.source = source
        self.title = title
        self.description = description
        self.permissions = permissions
        self.requestedCapabilities = requestedCapabilities
        self.actions = actions
        self.sessionId = sessionId
    }

    enum CodingKeys: String, CodingKey {
        case path, patch, command, source, title, description, permissions, requestedCapabilities, actions, sessionId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try? c.decode(String.self, forKey: .path)
        patch = try? c.decode(String.self, forKey: .patch)
        command = try? c.decode(String.self, forKey: .command)
        source = try? c.decode(ApprovalSource.self, forKey: .source)
        title = try? c.decode(String.self, forKey: .title)
        description = try? c.decode(String.self, forKey: .description)
        permissions = (try? c.decode([ApprovalPermission].self, forKey: .permissions)) ?? []
        requestedCapabilities = try? c.decode([String].self, forKey: .requestedCapabilities)
        actions = (try? c.decode([ApprovalRequestedAction].self, forKey: .actions)) ?? []
        sessionId = try? c.decode(String.self, forKey: .sessionId)
    }
}

public struct ApprovalSource: Decodable, Equatable {
    public let kind: String?
    public let trust: String?
    public let publisher: String?
    public let domain: String?

    public init(kind: String? = nil, trust: String? = nil, publisher: String? = nil, domain: String? = nil) {
        self.kind = kind
        self.trust = trust
        self.publisher = publisher
        self.domain = domain
    }
}

public struct ApprovalPermission: Decodable, Equatable {
    public let kind: String?
    public let scope: String?
    public let access: String?
}

public struct ApprovalRequestedAction: Decodable, Equatable {
    public let id: String
    public let tool: String
    public let reason: String?
}

/// `GET /api/status`. `paused` is optional because an older Control (before S1)
/// does not send it; the menu bar then cannot claim either state.
public struct ControlStatusResponse: Decodable, Equatable {
    public let paused: Bool?
    public let capabilities: ControlCapabilities

    public init(paused: Bool?, capabilities: ControlCapabilities) {
        self.paused = paused
        self.capabilities = capabilities
    }
}

public struct ControlCapabilities: Decodable, Equatable {
    public let agentHandshake: Bool?
    public let conduitUrlOpen: Bool?
    public let pause: Bool?

    public init(agentHandshake: Bool? = nil, conduitUrlOpen: Bool? = nil, pause: Bool? = nil) {
        self.agentHandshake = agentHandshake
        self.conduitUrlOpen = conduitUrlOpen
        self.pause = pause
    }
}

/// `GET /api/control` and the body of `POST /api/control/{pause,resume}`.
public struct ControlEnvelope: Decodable, Equatable {
    public let control: ControlState
}

public struct ControlState: Decodable, Equatable {
    public let paused: Bool
    public let pause: PauseDetail?
    public let liveSessions: Int?
    public let pendingApprovals: Int?

    public init(paused: Bool, pause: PauseDetail? = nil, liveSessions: Int? = nil, pendingApprovals: Int? = nil) {
        self.paused = paused
        self.pause = pause
        self.liveSessions = liveSessions
        self.pendingApprovals = pendingApprovals
    }
}

public struct PauseDetail: Decodable, Equatable {
    public let pausedAt: String?
    public let pausedBy: String?
    public let reason: String?
    public let unreadable: Bool?

    public init(pausedAt: String? = nil, pausedBy: String? = nil, reason: String? = nil, unreadable: Bool? = nil) {
        self.pausedAt = pausedAt
        self.pausedBy = pausedBy
        self.reason = reason
        self.unreadable = unreadable
    }
}

/// `POST /api/control/stop-all`.
public struct StopAllResponse: Decodable, Equatable {
    public let control: ControlState
    public let revokedSessions: [String]
}

public struct ApprovalDecisionResponse: Decodable, Equatable {
    public let execution: ApprovalExecutionSummary?
    public let copiedToClipboard: Bool?

    public init(execution: ApprovalExecutionSummary? = nil, copiedToClipboard: Bool? = nil) {
        self.execution = execution
        self.copiedToClipboard = copiedToClipboard
    }

    public var statusMessage: String {
        if let runId = execution?.runId, copiedToClipboard == true {
            return "Run \(runId) completed and the result was copied to the clipboard."
        }
        if let runId = execution?.runId {
            return "Run \(runId) completed."
        }
        return "The approval decision was recorded."
    }
}

public struct ApprovalExecutionSummary: Decodable, Equatable {
    public let runId: String?
    public let repair: RepairSummary?

    public init(runId: String? = nil, repair: RepairSummary? = nil) {
        self.runId = runId
        self.repair = repair
    }
}

public struct RepairSummary: Decodable, Equatable {
    public let code: String?
}

/// Error body Control sends with 4xx/5xx: `{ error, approval?, execution? }`.
public struct ControlErrorBody: Decodable {
    public let error: String?
    public let approval: ApprovalSummary?
    public let execution: ApprovalExecutionSummary?
}
