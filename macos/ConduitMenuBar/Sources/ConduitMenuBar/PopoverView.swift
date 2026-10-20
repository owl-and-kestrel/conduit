import ConduitMenuBarCore
import SwiftUI

/// The status-item popover (spec §3.2): header with state and Pause all, the
/// "Needs you" asks, recent decisions, and a footer. Every button is one
/// Control API call made by the AppDelegate.
struct PopoverView: View {
    @ObservedObject var model: MenuBarModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if let banner = model.banner {
                BannerView(banner: banner) { model.banner = nil }
            }
            Divider()
            content
            Divider()
            footer
        }
        .frame(width: 380)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                Image(nsImage: ConduitIcon.glyph(for: model.state.kind))
                    .renderingMode(.template)
                    .foregroundStyle(headerColor)
                Text(model.state.headline)
                    .font(.headline)
                    .lineLimit(2)
                Spacer()
                if model.pauseSupported, !isStopped {
                    Toggle("Pause all", isOn: Binding(
                        get: { model.state.paused },
                        set: { _ in model.actions?.togglePause() }
                    ))
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    // Stays enabled while Control is down: that is when the
                    // pause falls back to `conduit pause --local`. Resuming
                    // needs Control; with Control down a paused switch says so
                    // instead of resuming.
                    .disabled(model.busy)
                    .help("Pause or resume everything (⌘P)")
                }
            }
            if model.state.controlUnreachable {
                HStack {
                    Text("Conduit Control is not running. The pause was read from disk; resuming needs Control.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Restart services") { model.actions?.performFix(.restartServices) }
                        .disabled(model.busy)
                }
            }
            if isStopped {
                HStack {
                    Text("Nothing runs until you start Conduit again. Reconnect chats with a new handshake.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Start & Resume") { model.actions?.startAndResume() }
                        .disabled(model.busy)
                }
            } else if model.confirmingStopAll {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Stop everything? This pauses Conduit, disconnects every trusted chat, and stops the services this app started, including anything they are running.")
                        .font(.caption)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Spacer()
                        Button("Cancel") { model.confirmingStopAll = false }
                        Button("Stop all", role: .destructive) { model.actions?.stopAll() }
                            .keyboardShortcut(.defaultAction)
                    }
                }
            }
        }
        .padding(12)
    }

    @ViewBuilder
    private var content: some View {
        if case .error(let reason, let fix) = model.state.kind {
            ErrorRow(reason: reason, fix: fix) { model.actions?.performFix(fix) }
                .padding(12)
            if !model.state.asks.isEmpty { Divider() }
        }
        if !model.state.asks.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Needs you")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(model.state.asks) { ask in
                            AskRow(
                                ask: ask,
                                selected: model.selection.selectedId == ask.approvalId,
                                expanded: model.expanded.contains(ask.approvalId),
                                deciding: model.deciding.contains(ask.approvalId),
                                model: model
                            )
                        }
                    }
                }
                .frame(maxHeight: 340)
                Text("↑↓ select · Esc close · hover a button for its key")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(12)
        }
        if !model.state.recentDecisions.isEmpty {
            if !model.state.asks.isEmpty { Divider() }
            VStack(alignment: .leading, spacing: 4) {
                Text("Recent decisions")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                ForEach(model.state.recentDecisions) { decided in
                    HStack(alignment: .firstTextBaseline) {
                        DecisionBadgeView(badge: AskPresentation.decisionBadge(for: decided))
                        Text(AskPresentation.title(for: decided))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Text(AskPresentation.decisionDetail(for: decided))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .font(.caption)
                }
            }
            .padding(12)
        } else if model.state.asks.isEmpty, case .error = model.state.kind {
            EmptyView()
        } else if model.state.asks.isEmpty {
            Text("Nothing needs you. Trusted requests run quietly.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(12)
        }
        // Demo profile only (CONDUIT_DEMO_PROFILE=1 on Control). Off, nothing
        // here renders and the popover is what it was before S4.
        if model.demoProfile {
            Divider()
            ServicesSection(model: model)
                .padding(12)
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Button("Copy Agent Handshake") { model.actions?.copyHandshake() }
                .buttonStyle(.bordered)
            Spacer()
            if !isStopped && !model.confirmingStopAll {
                Button("Stop all…", role: .destructive) { model.confirmingStopAll = true }
                    .foregroundStyle(.red)
                    .disabled(model.busy)
            }
            Button {
                model.actions?.openSettings()
            } label: {
                Image(systemName: "gearshape")
            }
            .buttonStyle(.borderless)
            .help("Settings… (⌘,)")
            .accessibilityLabel("Settings…")
            Button {
                model.actions?.quit()
            } label: {
                Image(systemName: "power")
            }
            .buttonStyle(.borderless)
            .help("Quit Conduit")
            .accessibilityLabel("Quit")
        }
        .controlSize(.small)
        .buttonStyle(.borderless)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var isStopped: Bool {
        model.state.stopped
    }

    private var headerColor: Color {
        switch model.state.kind {
        case .needsYou: return .accentColor
        case .error: return .orange
        default: return .secondary
        }
    }
}

/// The small capsule badge for a recent decision, colored by the outcome.
private struct DecisionBadgeView: View {
    let badge: AskPresentation.DecisionBadge

    var body: some View {
        Text(badge.label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.15)))
            .foregroundStyle(color)
    }

    private var color: Color {
        switch badge {
        case .approved: return .green
        case .denied: return .red
        case .expired: return .orange
        case .other: return .secondary
        }
    }
}

private struct BannerView: View {
    let banner: MenuBarModel.Banner
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: banner.isError ? "exclamationmark.circle" : "info.circle")
                .foregroundStyle(banner.isError ? Color.orange : Color.secondary)
            Text(banner.text)
                .font(.caption)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button(action: dismiss) { Image(systemName: "xmark") }
                .buttonStyle(.borderless)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }
}

private struct ErrorRow: View {
    let reason: String
    let fix: ErrorFix
    let action: () -> Void

    var body: some View {
        HStack(alignment: .top) {
            Text(reason)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button(fixTitle, action: action)
        }
    }

    private var fixTitle: String {
        switch fix {
        case .restartServices: return "Restart services"
        case .openLogs: return "Open Logs"
        case .reviewFailure: return "Dismiss"
        }
    }
}

private struct AskRow: View {
    let ask: ApprovalSummary
    let selected: Bool
    let expanded: Bool
    let deciding: Bool
    @ObservedObject var model: MenuBarModel

    /// Demo profile only: the request starts programs (service.start). nil
    /// with the profile off, so the row renders as it did before S4.
    private var serviceAsk: ServiceAsk? {
        ServiceAsk.make(for: ask, demoProfile: model.demoProfile)
    }

    private var approveHelp: String {
        guard ask.isReview else { return "Allow this one request (Return; a shell command shows its details first)" }
        // Demo profile only: an approved review runs as demo-review, which can
        // run programs, so "read-only" would be wrong there.
        return model.demoProfile ? "Run this one request now; with the demo profile on it may start programs (Return)" : "Run this one request read-only (Return)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(AskPresentation.title(for: ask))
                        .font(.callout.weight(.medium))
                        .lineLimit(2)
                        .truncationMode(.middle)
                    Text(AskPresentation.source(for: ask) + " · " + AskPresentation.subtitle(for: ask))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer()
            }
            if let serviceAsk {
                ServiceAskRows(serviceAsk: serviceAsk, model: model)
            }
            if expanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(AskPresentation.details(for: ask, demoProfile: model.demoProfile).enumerated()), id: \.offset) { _, row in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(row.label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                            Text(row.value)
                                .font(.system(.caption, design: row.label == "Command" || row.label == "Patch" || row.label == "Path" ? .monospaced : .default))
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            HStack(spacing: 8) {
                if serviceAsk != nil {
                    Button("Allow once") { model.actions?.decide(ask.approvalId, .approve) }
                        .buttonStyle(.borderedProminent)
                        .disabled(deciding)
                        .help("Run this one request now; the next request asks again (Return)")
                    if serviceAsk?.offersAlwaysAllow == true && model.packageAllowsSupported {
                        Button("Always allow this exact package") { model.actions?.decideAlwaysAllowPackage(ask.approvalId) }
                            .buttonStyle(.bordered)
                            .disabled(deciding)
                            .help("Run it now, and start a package with this exact sha256 again without asking. A different sha256 asks again. Revoke with `conduit packages revoke`.")
                    }
                } else {
                    Button(ask.isReview ? "Approve once" : "Allow once") { model.actions?.decide(ask.approvalId, .approve) }
                        .buttonStyle(.borderedProminent)
                        .disabled(deciding)
                        .help(approveHelp)
                }
                if AllowForThisChat.isOffered(for: ask) {
                    Button("Allow for this chat") { model.actions?.decideForThisChat(ask.approvalId) }
                        .buttonStyle(.bordered)
                        .disabled(deciding)
                        .help("Also allow this exact \(ask.action.tool == "shell.run" ? "command" : "file write") again in this chat, until the chat is revoked or Conduit restarts. (⌘Return)")
                }
                Button("Deny") { model.actions?.decide(ask.approvalId, .deny) }
                    .buttonStyle(.bordered)
                    .disabled(deciding)
                    .help("Deny (⌘⌫)")
                Spacer()
                Button(expanded ? "Hide details" : "Details") {
                    if expanded { model.expanded.remove(ask.approvalId) } else { model.expanded.insert(ask.approvalId) }
                }
                .buttonStyle(.borderless)
                .help("Show or hide details (Space)")
                Button("Open in panel") { model.actions?.openDetails(ask.approvalId) }
                    .buttonStyle(.borderless)
                if deciding { ProgressView().controlSize(.small) }
            }
            .controlSize(.small)
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(selected ? Color.accentColor.opacity(0.12) : Color.primary.opacity(0.04))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(selected ? Color.accentColor.opacity(0.6) : Color.clear, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture { model.selection.select(ask.approvalId, in: model.state.asks) }
    }
}

/// Demo profile only: what a service.start request will run, shown on the ask
/// itself (not only in Details): who the request says it is from, the exact
/// sha256 it pins, and whether the program asks to accept connections from the
/// local network. Disclosure only: Conduit does not check what the program does.
private struct ServiceAskRows: View {
    let serviceAsk: ServiceAsk
    @ObservedObject var model: MenuBarModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            labeled("Starts", serviceAsk.serviceNames.joined(separator: ", "))
            labeled("From (as the request claims)", serviceAsk.requester)
            ForEach(serviceAsk.packageDigests, id: \.self) { digest in
                digestRow("Package sha256", digest)
            }
            ForEach(serviceAsk.pathDigests, id: \.self) { digest in
                digestRow("Entry file sha256 (that one file only)", digest)
            }
            if serviceAsk.acceptsLocalNetwork {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "network")
                        .foregroundStyle(.orange)
                    Text(ServiceAsk.localNetworkDisclosure)
                        .font(.caption)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Text(ServiceAsk.runsCodeNotice)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func labeled(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(value).font(.caption).lineLimit(2).truncationMode(.middle)
        }
    }

    private func digestRow(_ label: String, _ digest: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text(ServiceAsk.shortDigest(digest) + "…")
                    .font(.system(.caption, design: .monospaced))
                    .help(digest)
                Button("Copy full sha256") { model.actions?.copyToClipboard(digest, what: "sha256") }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
            }
        }
    }
}

/// Demo profile only: the programs service.start started, with Stop
/// (POST /api/services/:id/stop, the same call as `conduit services stop`).
/// Stop is the person's control, not automatic cleanup.
private struct ServicesSection: View {
    @ObservedObject var model: MenuBarModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Services")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            if model.runningServices.isEmpty {
                Text("No services running.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(model.runningServices) { row in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.name)
                            .font(.callout.weight(.medium))
                            .lineLimit(1)
                        Text([row.address, row.state, row.uptime.isEmpty ? nil : "up \(row.uptime)"].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer()
                    if model.stoppingServiceIds.contains(row.id) {
                        ProgressView().controlSize(.small)
                    }
                    Button("Stop") { model.actions?.stopService(row.id) }
                        .controlSize(.small)
                        .disabled(model.stoppingServiceIds.contains(row.id) || row.state == "stopping")
                        .help("Stop this program (SIGTERM, then SIGKILL after a grace)")
                }
            }
        }
    }
}
