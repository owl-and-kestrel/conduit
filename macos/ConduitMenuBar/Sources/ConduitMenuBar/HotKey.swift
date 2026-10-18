import AppKit
import Carbon
import ConduitMenuBarCore

/// Global hotkey (⌃⌥C) that opens the popover on the oldest ask (spec §3.3).
/// Carbon `RegisterEventHotKey` delivers only this one chord to us and needs no
/// Accessibility permission, unlike a global NSEvent monitor.
final class GlobalHotKey {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let action: () -> Void
    private(set) var isRegistered = false

    init(action: @escaping () -> Void) {
        self.action = action
    }

    func register() {
        guard !isRegistered else { return }
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let userData = Unmanaged.passUnretained(self).toOpaque()
        let installed = InstallEventHandler(
            GetApplicationEventTarget(),
            { _, _, userData in
                guard let userData else { return OSStatus(eventNotHandledErr) }
                let hotKey = Unmanaged<GlobalHotKey>.fromOpaque(userData).takeUnretainedValue()
                DispatchQueue.main.async { hotKey.action() }
                return noErr
            },
            1,
            &eventType,
            userData,
            &handlerRef
        )
        guard installed == noErr else { return }
        let hotKeyID = EventHotKeyID(signature: OSType(0x434E_4454), id: 1) // "CNDT"
        let status = RegisterEventHotKey(
            UInt32(kVK_ANSI_C),
            UInt32(controlKey | optionKey),
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
        isRegistered = status == noErr
        if !isRegistered, let handlerRef {
            RemoveEventHandler(handlerRef)
            self.handlerRef = nil
        }
    }

    func unregister() {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
        hotKeyRef = nil
        handlerRef = nil
        isRegistered = false
    }

    deinit {
        unregister()
    }
}

/// Maps an AppKit key event onto the pure popover key bindings in the core.
enum PopoverKeys {
    static func input(from event: NSEvent) -> KeyInput? {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let key: KeyInput.Key
        switch Int(event.keyCode) {
        case kVK_UpArrow: key = .up
        case kVK_DownArrow: key = .down
        case kVK_Space: key = .space
        case kVK_Return, kVK_ANSI_KeypadEnter: key = .returnKey
        case kVK_Delete, kVK_ForwardDelete: key = .delete
        case kVK_Escape: key = .escape
        default:
            guard let characters = event.charactersIgnoringModifiers, !characters.isEmpty else { return nil }
            key = .character(characters)
        }
        return KeyInput(
            key,
            command: flags.contains(.command),
            option: flags.contains(.option),
            control: flags.contains(.control),
            shift: flags.contains(.shift)
        )
    }
}
