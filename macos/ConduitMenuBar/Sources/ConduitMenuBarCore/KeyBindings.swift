import Foundation

/// Popover keyboard flow (spec §3.3). Pure so it can be tested without AppKit;
/// the app maps NSEvent key codes and modifier flags onto `KeyInput`.
public enum PopoverCommand: Equatable {
    case selectPrevious
    case selectNext
    case toggleDetails
    case allowOnce
    /// ⌘Return: "Allow for this chat" (remembered for this chat/session only,
    /// Jon 2026-10-18). Only offered where `AllowForThisChat.isOffered` says so.
    case allowWithScope
    case deny
    case togglePause
    case openSettings
    case close
}

public struct KeyInput: Equatable {
    public enum Key: Equatable {
        case up, down, space, returnKey, delete, escape
        case character(String)
    }

    public let key: Key
    public let command: Bool
    public let option: Bool
    public let control: Bool
    public let shift: Bool
    /// An auto-repeated keyDown (the key is being held).
    public let isRepeat: Bool

    public init(_ key: Key, command: Bool = false, option: Bool = false, control: Bool = false, shift: Bool = false, isRepeat: Bool = false) {
        self.key = key
        self.command = command
        self.option = option
        self.control = control
        self.shift = shift
        self.isRepeat = isRepeat
    }
}

public enum KeyBindings {
    /// Global hotkey: ⌃⌥C opens the popover on the oldest ask. Registered with
    /// Carbon `RegisterEventHotKey`, which needs no Accessibility permission.
    public static let hotKeyCharacter = "c"
    public static let hotKeyDescription = "⌃⌥C"

    public static func command(for input: KeyInput) -> PopoverCommand? {
        // Ignore anything with ⌃ or ⌥: those belong to the system or the
        // global hotkey, never to an approval.
        if input.control || input.option { return nil }
        // A held key never decides: after the selected ask is decided the
        // selection falls back to the next one, so an auto-repeated Return or
        // ⌘⌫ would otherwise decide asks the person has not looked at.
        if input.isRepeat, input.key == .returnKey || input.key == .delete { return nil }
        switch input.key {
        case .up where !input.command: return .selectPrevious
        case .down where !input.command: return .selectNext
        case .space where !input.command: return .toggleDetails
        case .returnKey: return input.command ? .allowWithScope : (input.shift ? nil : .allowOnce)
        case .delete where input.command: return .deny
        case .escape: return .close
        case .character(let c) where input.command:
            switch c.lowercased() {
            case "p": return .togglePause
            case ",": return .openSettings
            default: return nil
            }
        default:
            return nil
        }
    }
}

/// Return on a shell command (Jon 2026-10-18). With the ask's details closed,
/// Return (and ⌘Return) opens them instead of allowing, so a command is never
/// approved unseen. With them open it allows. The setting "Return approves
/// shell commands without opening details" (off by default; `POST
/// /api/settings`) turns this off. Clicking the buttons is not affected.
public enum ReturnKeyGate {
    public static func opensDetailsFirst(
        _ ask: ApprovalSummary,
        detailsOpen: Bool,
        returnApprovesShellWithoutDetails: Bool
    ) -> Bool {
        ask.action.tool == "shell.run" && !detailsOpen && !returnApprovesShellWithoutDetails
    }
}

/// Whether "Allow for this chat" is offered: a confirmation from a chat for an
/// exact shell command or a single-file write. Control re-checks all of this
/// (and that the chat is still live) and refuses anything else.
public enum AllowForThisChat {
    public static func isOffered(for ask: ApprovalSummary) -> Bool {
        guard ask.isAwaitingDecision, !ask.isReview, let sessionId = ask.sessionId, !sessionId.isEmpty else { return false }
        switch ask.action.tool {
        case "shell.run": return !(ask.action.args?.command ?? "").isEmpty
        case "file.write": return !(ask.action.args?.path ?? "").isEmpty
        default: return false
        }
    }
}

/// Which ask is selected. Survives list refreshes by id; falls back to the
/// oldest ask when the selected one is decided or expires.
public struct AskSelection: Equatable {
    public private(set) var selectedId: String?

    public init(selectedId: String? = nil) {
        self.selectedId = selectedId
    }

    public mutating func reconcile(with asks: [ApprovalSummary]) {
        if let selectedId, asks.contains(where: { $0.approvalId == selectedId }) {
            return
        }
        selectedId = asks.first?.approvalId
    }

    public mutating func select(_ id: String, in asks: [ApprovalSummary]) {
        if asks.contains(where: { $0.approvalId == id }) {
            selectedId = id
        }
    }

    public mutating func move(_ delta: Int, in asks: [ApprovalSummary]) {
        guard !asks.isEmpty else {
            selectedId = nil
            return
        }
        let current = asks.firstIndex { $0.approvalId == selectedId } ?? 0
        let next = min(max(current + delta, 0), asks.count - 1)
        selectedId = asks[next].approvalId
    }
}
