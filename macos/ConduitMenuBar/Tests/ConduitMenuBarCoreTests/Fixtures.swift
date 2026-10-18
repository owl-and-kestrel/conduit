import Foundation
@testable import ConduitMenuBarCore

enum Fixtures {
    static func approval(
        id: String = "approval_1",
        status: String = "pending",
        tool: String = "file.write",
        path: String? = "src/app.ts",
        patch: String? = nil,
        command: String? = nil,
        createdAt: String = "2026-10-18T06:00:00.000Z",
        executionStatus: String? = nil,
        executionFinishedAt: String? = nil,
        decidedBy: String? = nil,
        sessionId: String? = nil
    ) -> ApprovalSummary {
        ApprovalSummary(
            approvalId: id,
            status: status,
            policyReason: "Profile requires confirmation.",
            sessionId: sessionId,
            createdAt: createdAt,
            decidedBy: decidedBy,
            executionStatus: executionStatus,
            executionError: executionStatus == "failed" ? "Tool failed." : nil,
            executionFinishedAt: executionFinishedAt,
            action: ApprovalActionSummary(
                id: "a1",
                tool: tool,
                reason: "Agent wants to edit a file.",
                args: ApprovalActionArgs(path: path, patch: patch, command: command)
            )
        )
    }

    static let okStatus = ControlStatusResponse(
        paused: false,
        capabilities: ControlCapabilities(agentHandshake: true, conduitUrlOpen: true, pause: true)
    )

    static let pausedStatus = ControlStatusResponse(
        paused: true,
        capabilities: ControlCapabilities(agentHandshake: true, conduitUrlOpen: true, pause: true)
    )

    static let up = ServiceSnapshot(controlReachable: true)

    static func json(_ text: String) -> Data {
        Data(text.utf8)
    }
}
