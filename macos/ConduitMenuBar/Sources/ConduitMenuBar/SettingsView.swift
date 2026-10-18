import AppKit
import ConduitMenuBarCore
import SwiftUI

/// Native Settings window (Jon 2026-10-18: settings live in a native Mac
/// window). For S5 it holds what left the menu: the service start/stop toggles,
/// Check for Updates, logs and bug report. Trusted sources, policies and
/// pairing still open the web panel until those move here (spec §3.4 / S7).
struct SettingsView: View {
    @ObservedObject var model: MenuBarModel

    var body: some View {
        Form {
            Section("General") {
                LabeledContent("Status", value: model.state.headline)
                if model.pauseSupported {
                    Toggle("Pause all (⌘P in the menu)", isOn: Binding(
                        get: { model.state.paused },
                        set: { _ in model.actions?.togglePause() }
                    ))
                    .disabled(model.busy || model.state.stopped)
                }
                Toggle("Return approves shell commands without opening details", isOn: Binding(
                    get: { model.returnApprovesShellWithoutDetails },
                    set: { model.actions?.setReturnApprovesShellWithoutDetails($0) }
                ))
                .disabled(!model.settingsSupported)
                .help("Off: Return on a shell command opens its details first; press Return again to allow it.")
                LabeledContent(
                    "Open Conduit",
                    value: model.hotKeyRegistered ? KeyBindings.hotKeyDescription : "\(KeyBindings.hotKeyDescription) unavailable (in use by another app)"
                )
            }
            Section("Services") {
                ForEach(model.services) { row in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(row.label)
                            Text(row.status).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(row.actionTitle) { model.actions?.serviceAction(row.id) }
                            .disabled(!row.actionEnabled)
                    }
                }
            }
            Section("Trusted sources & pairing") {
                HStack {
                    Text("Chats, workspaces and per-chat pause")
                    Spacer()
                    Button("Open Control Panel") { model.actions?.openWebPanel() }
                }
                HStack {
                    Text("Pair a new chat")
                    Spacer()
                    Button("Copy Agent Handshake") { model.actions?.copyHandshake() }
                }
            }
            Section("Updates & diagnostics") {
                HStack {
                    Button("Check for Updates...") { model.actions?.checkForUpdates() }
                    Button("Open Logs") { model.actions?.openLogsFolder() }
                    Button("Report Bug") { model.actions?.reportBug() }
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .fixedSize(horizontal: false, vertical: true)
    }
}

final class SettingsWindowController {
    private var window: NSWindow?
    private let model: MenuBarModel

    init(model: MenuBarModel) {
        self.model = model
    }

    func show() {
        if window == nil {
            let hosting = NSHostingController(rootView: SettingsView(model: model))
            let created = NSWindow(contentViewController: hosting)
            created.title = "Conduit Settings"
            created.styleMask = [.titled, .closable, .miniaturizable]
            created.isReleasedWhenClosed = false
            created.center()
            window = created
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}
