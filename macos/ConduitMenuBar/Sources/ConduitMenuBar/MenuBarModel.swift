import AppKit
import ConduitMenuBarCore
import SwiftUI

/// What the popover and Settings window render. The AppDelegate owns the
/// supervisor and API calls; this object only holds state and forwards intents.
final class MenuBarModel: ObservableObject {
    struct Banner: Equatable {
        let text: String
        let isError: Bool
    }

    struct ServiceRow: Identifiable, Equatable {
        let id: String
        let label: String
        let status: String
        let actionTitle: String
        let actionEnabled: Bool
    }

    @Published var state = MenuBarState.reduce(
        status: nil,
        control: nil,
        approvals: [],
        services: ServiceSnapshot(controlReachable: false)
    )
    @Published var selection = AskSelection()
    @Published var expanded: Set<String> = []
    @Published var banner: Banner?
    @Published var confirmingStopAll = false
    @Published var busy = false
    @Published var deciding: Set<String> = []
    @Published var services: [ServiceRow] = []
    @Published var hotKeyRegistered = false
    @Published var pauseSupported = true

    weak var actions: MenuBarActions?

    func update(_ newState: MenuBarState) {
        state = newState
        selection.reconcile(with: newState.asks)
        expanded = expanded.filter { id in newState.asks.contains { $0.approvalId == id } }
    }

    func show(_ text: String, isError: Bool) {
        banner = Banner(text: text, isError: isError)
    }

    var selectedAsk: ApprovalSummary? {
        state.asks.first { $0.approvalId == selection.selectedId }
    }

    /// Popover keyboard commands (spec §3.3). Returns whether it was handled.
    @discardableResult
    func handle(_ command: PopoverCommand) -> Bool {
        switch command {
        case .selectPrevious:
            selection.move(-1, in: state.asks)
        case .selectNext:
            selection.move(1, in: state.asks)
        case .toggleDetails:
            guard let id = selection.selectedId else { return false }
            if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
        case .allowOnce:
            guard let ask = selectedAsk else { return false }
            actions?.decide(ask.approvalId, .approve)
        case .allowWithScope:
            guard selectedAsk != nil else { return false }
            show("Remembering a decision for this chat is not available yet. Use Return to allow just this once.", isError: false)
        case .deny:
            guard let ask = selectedAsk else { return false }
            actions?.decide(ask.approvalId, .deny)
        case .togglePause:
            actions?.togglePause()
        case .openSettings:
            actions?.openSettings()
        case .close:
            actions?.closePopover()
        }
        return true
    }
}

protocol MenuBarActions: AnyObject {
    func decide(_ approvalId: String, _ decision: ApprovalDecision)
    func togglePause()
    func stopAll()
    func startAndResume()
    func openDetails(_ approvalId: String)
    func performFix(_ fix: ErrorFix)
    func copyHandshake()
    func openSettings()
    func closePopover()
    func quit()
    func serviceAction(_ serviceId: String)
    func checkForUpdates()
    func openWebPanel()
    func openLogsFolder()
    func reportBug()
}
