import Foundation

/// Where a person made a decision. Sent as `decidedBy` (approvals) or `by`
/// (pause / resume / stop-all) so the audit trail says which surface was used
/// (spec invariant 6). It is a label, not a credential: the server accepts it
/// only from a fixed list and it grants nothing.
public enum DecisionChannel: String, Equatable {
    /// The status-item popover, its keyboard shortcuts and the global hotkey.
    case menubar
    /// An action button on a macOS notification.
    case notification
}

public enum ApprovalDecision: String, Equatable {
    case approve
    case deny
}

/// Every Control endpoint the menu bar calls. Each one is the same call the CLI
/// verb makes (`CONTROL_CLI_ROUTES` in src/cli/control-client.ts); the menu bar
/// adds no endpoint of its own (spec §3.5).
public enum ControlEndpoint: Equatable {
    case status
    case control
    case pause
    case resume
    case stopAll
    case approvals
    case approval(id: String)
    case decide(id: String, ApprovalDecision)
    case settings
    case updateSettings
    /// Demo profile only: `GET /api/services`.
    case services
    /// Demo profile only: `POST /api/services/:id/stop`.
    case stopService(id: String)

    public var method: String {
        switch self {
        case .status, .control, .approvals, .approval, .settings, .services:
            return "GET"
        case .pause, .resume, .stopAll, .decide, .updateSettings, .stopService:
            return "POST"
        }
    }

    public var path: String {
        switch self {
        case .status: return "/api/status"
        case .control: return "/api/control"
        case .pause: return "/api/control/pause"
        case .resume: return "/api/control/resume"
        case .stopAll: return "/api/control/stop-all"
        case .approvals: return "/api/approvals"
        case .approval(let id): return "/api/approvals/\(id)"
        case .decide(let id, .approve): return "/api/approvals/\(id)/approve"
        case .decide(let id, .deny): return "/api/approvals/\(id)/deny"
        case .settings: return "/api/settings"
        case .updateSettings: return "/api/settings"
        case .services: return "/api/services"
        case .stopService(let id): return "/api/services/\(id)/stop"
        }
    }
}

/// Mirrors the server's service-id check (`svc_[A-Za-z0-9_-]+`). A service id
/// is interpolated into the stop URL, so it is never used unchecked.
public func isValidServiceId(_ value: String) -> Bool {
    value.range(of: #"^svc_[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil
}

/// Mirrors the server's approval-id check (`approval_[A-Za-z0-9_-]+`). An id
/// from a notification payload is never interpolated into a URL unchecked.
public func isValidApprovalId(_ value: String) -> Bool {
    value.range(of: #"^approval_[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil
}

public struct ControlAPIError: LocalizedError, Equatable {
    public let statusCode: Int?
    public let userMessage: String
    /// The approval record the server returned with the error, if any, so the
    /// caller can update its list (e.g. drop an ask that expired).
    public let approvalStatus: String?

    public init(statusCode: Int?, userMessage: String, approvalStatus: String? = nil) {
        self.statusCode = statusCode
        self.userMessage = userMessage
        self.approvalStatus = approvalStatus
    }

    public var errorDescription: String? { userMessage }
}

/// Turns Control's refusals into plain sentences. The 409s matter most: they
/// are the server saying "nothing ran", and the person needs to know why and
/// what to do next.
public enum ControlErrorMessages {
    public static func message(statusCode: Int, body: Data, endpoint: ControlEndpoint) -> ControlAPIError {
        let parsed = try? JSONDecoder().decode(ControlErrorBody.self, from: body)
        let serverText = parsed?.error ?? String(data: body, encoding: .utf8)
        let approvalStatus = parsed?.approval?.status

        switch statusCode {
        case 409:
            if parsed?.execution?.repair?.code == "paused" || serverText?.contains("paused before this approved review ran") == true {
                return ControlAPIError(
                    statusCode: 409,
                    userMessage: "Conduit was paused before this request ran, so nothing ran. Resume Conduit, then ask the agent to send the request again.",
                    approvalStatus: approvalStatus
                )
            }
            if approvalStatus == "expired" || serverText?.contains("is expired") == true {
                return ControlAPIError(
                    statusCode: 409,
                    userMessage: "This request waited too long without a decision, so it expired and was denied. Nothing ran. Ask the agent to send it again if you still want it.",
                    approvalStatus: "expired"
                )
            }
            if approvalStatus == "pending" || serverText?.contains("Resume before approving") == true {
                return ControlAPIError(
                    statusCode: 409,
                    userMessage: "Conduit is paused, so this was not approved and nothing ran. Resume Conduit, then approve it. It keeps waiting until it expires.",
                    approvalStatus: approvalStatus ?? "pending"
                )
            }
            if let approvalStatus, approvalStatus == "approved" || approvalStatus == "denied" {
                return ControlAPIError(
                    statusCode: 409,
                    userMessage: "This request was already \(approvalStatus) somewhere else.",
                    approvalStatus: approvalStatus
                )
            }
            if case .decide = endpoint {
                return ControlAPIError(statusCode: 409, userMessage: "This request is no longer waiting for a decision.", approvalStatus: approvalStatus)
            }
            return ControlAPIError(statusCode: 409, userMessage: serverText ?? "Conduit refused the change.", approvalStatus: approvalStatus)
        case 404:
            if case .decide = endpoint {
                return ControlAPIError(statusCode: 404, userMessage: "This request no longer exists in Conduit.")
            }
            if case .approval = endpoint {
                return ControlAPIError(statusCode: 404, userMessage: "This request no longer exists in Conduit.")
            }
            return ControlAPIError(statusCode: 404, userMessage: "This Conduit Control does not support that action. Restart it from Settings so it is up to date.")
        case 403:
            return ControlAPIError(statusCode: 403, userMessage: "Conduit Control refused the request as not local. \(serverText ?? "")".trimmingCharacters(in: .whitespaces))
        default:
            return ControlAPIError(statusCode: statusCode, userMessage: serverText?.isEmpty == false ? serverText! : "Conduit Control answered \(statusCode).", approvalStatus: approvalStatus)
        }
    }
}

/// The menu bar's only way to talk to Conduit Control. Loopback only, one call
/// per action, no client-side policy.
public final class ControlClient {
    public let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL = URL(string: "http://127.0.0.1:47831")!, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func request(_ endpoint: ControlEndpoint, body: [String: Any]? = nil, timeout: TimeInterval = 5) throws -> URLRequest {
        guard let url = URL(string: endpoint.path, relativeTo: baseURL) else {
            throw ControlAPIError(statusCode: nil, userMessage: "Invalid Conduit Control URL.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method
        request.timeoutInterval = timeout
        if endpoint.method == "POST" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body ?? [:], options: [.sortedKeys])
        }
        return request
    }

    public func status(timeout: TimeInterval = 0.75) async throws -> ControlStatusResponse {
        try await send(.status, timeout: timeout)
    }

    public func approvals(timeout: TimeInterval = 0.75) async throws -> [ApprovalSummary] {
        let response: ApprovalsResponse = try await send(.approvals, timeout: timeout)
        return response.approvals
    }

    public func approval(id: String) async throws -> ApprovalSummary {
        guard isValidApprovalId(id) else {
            throw ControlAPIError(statusCode: nil, userMessage: "That is not a Conduit request id.")
        }
        let response: ApprovalResponse = try await send(.approval(id: id))
        return response.approval
    }

    public func control(timeout: TimeInterval = 0.75) async throws -> ControlState {
        let response: ControlEnvelope = try await send(.control, timeout: timeout)
        return response.control
    }

    public func pause(by channel: DecisionChannel, reason: String? = nil) async throws -> ControlState {
        var body = ["by": channel.rawValue]
        if let reason { body["reason"] = reason }
        let response: ControlEnvelope = try await send(.pause, body: body)
        return response.control
    }

    public func resume(by channel: DecisionChannel) async throws -> ControlState {
        let response: ControlEnvelope = try await send(.resume, body: ["by": channel.rawValue])
        return response.control
    }

    public func stopAll(by channel: DecisionChannel, reason: String? = nil) async throws -> StopAllResponse {
        var body = ["by": channel.rawValue]
        if let reason { body["reason"] = reason }
        return try await send(.stopAll, body: body)
    }

    /// Approve or deny. `decidedBy` is always the channel the person used.
    /// `forThisChat` is "Allow for this chat": Control remembers the approval
    /// for that one chat (session) only, and refuses it for anything else.
    /// `alwaysAllowPackage` is "Always allow this exact package" (demo
    /// profile): Control remembers the approved package by digest.
    public func decide(
        approvalId: String,
        _ decision: ApprovalDecision,
        channel: DecisionChannel,
        reason: String? = nil,
        forThisChat: Bool = false,
        alwaysAllowPackage: Bool = false
    ) async throws -> ApprovalDecisionResponse {
        guard isValidApprovalId(approvalId) else {
            throw ControlAPIError(statusCode: nil, userMessage: "That is not a Conduit request id.")
        }
        let body = Self.decisionBody(decision, channel: channel, reason: reason, forThisChat: forThisChat, alwaysAllowPackage: alwaysAllowPackage)
        // Approving a review runs it before Control answers, so allow time.
        return try await send(.decide(id: approvalId, decision), body: body, timeout: 60)
    }

    public static func decisionBody(
        _ decision: ApprovalDecision,
        channel: DecisionChannel,
        reason: String? = nil,
        forThisChat: Bool = false,
        alwaysAllowPackage: Bool = false
    ) -> [String: String] {
        let defaultReason: String
        switch (decision, channel) {
        case (.approve, .menubar):
            if alwaysAllowPackage {
                defaultReason = "Always allowed this exact package from Conduit menu bar."
            } else {
                defaultReason = forThisChat ? "Allowed for this chat from Conduit menu bar." : "Approved from Conduit menu bar."
            }
        case (.deny, .menubar): defaultReason = "Denied from Conduit menu bar."
        case (.approve, .notification): defaultReason = "Approved from Conduit notification."
        case (.deny, .notification): defaultReason = "Denied from Conduit notification."
        }
        var body = ["decidedBy": channel.rawValue, "reason": reason ?? defaultReason]
        // "Always allow this exact package" wins over "for this chat".
        if alwaysAllowPackage && decision == .approve {
            body["remember"] = "package"
        } else if forThisChat && decision == .approve {
            body["remember"] = "session"
        }
        return body
    }

    /// `GET /api/settings`, the same call as `conduit settings show`.
    public func settings(timeout: TimeInterval = 0.75) async throws -> ConduitSettings {
        let response: SettingsResponse = try await send(.settings, timeout: timeout)
        return response.settings
    }

    /// `POST /api/settings`, the same call as `conduit settings set`.
    public func setReturnApprovesShellWithoutDetails(_ value: Bool) async throws -> ConduitSettings {
        let response: SettingsResponse = try await send(.updateSettings, body: ["returnApprovesShellWithoutDetails": value])
        return response.settings
    }

    /// Demo profile only: `GET /api/services`, the programs Control started.
    public func services(timeout: TimeInterval = 0.75) async throws -> [ServiceSummary] {
        let response: ServicesResponse = try await send(.services, timeout: timeout)
        return response.services
    }

    /// Demo profile only: `POST /api/services/:id/stop`.
    public func stopService(id: String) async throws -> ServiceSummary {
        guard isValidServiceId(id) else {
            throw ControlAPIError(statusCode: nil, userMessage: "That is not a Conduit service id.")
        }
        // Control answers after the program exits: TERM, up to 3 s grace,
        // then KILL and its wait. 15 s covers that with room to spare, so a
        // slow stop is not reported as a failure while it is still working.
        let response: ServiceStopResponse = try await send(.stopService(id: id), body: [:], timeout: 15)
        return response.service
    }

    private func send<T: Decodable>(_ endpoint: ControlEndpoint, body: [String: Any]? = nil, timeout: TimeInterval = 5) async throws -> T {
        let request = try request(endpoint, body: body, timeout: timeout)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw ControlAPIError(statusCode: nil, userMessage: "Conduit Control is not reachable. \(error.localizedDescription)")
        }
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(statusCode) else {
            throw ControlErrorMessages.message(statusCode: statusCode, body: data, endpoint: endpoint)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ControlAPIError(statusCode: statusCode, userMessage: "Conduit Control sent an answer this menu bar does not understand.")
        }
    }
}
