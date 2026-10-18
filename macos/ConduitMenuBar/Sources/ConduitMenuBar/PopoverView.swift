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
                Image(systemName: headerSymbol)
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
                    .disabled(model.busy || !controlUp)
                    .help("Pause or resume everything (⌘P)")
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
                Text("↑↓ select · Space details · Return allow once · ⌘⌫ deny · Esc close")
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
                        Text(AskPresentation.title(for: decided))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Text(AskPresentation.decisionLine(for: decided))
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
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Button("Copy Agent Handshake") { model.actions?.copyHandshake() }
            Spacer()
            if !isStopped && !model.confirmingStopAll {
                Button("Stop all…") { model.confirmingStopAll = true }
                    .disabled(model.busy)
            }
            Button("Settings…") { model.actions?.openSettings() }
            Button("Quit") { model.actions?.quit() }
        }
        .buttonStyle(.borderless)
        .font(.callout)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var isStopped: Bool {
        model.state.stopped
    }

    private var controlUp: Bool {
        if case .error(_, .restartServices) = model.state.kind { return false }
        return true
    }

    private var headerSymbol: String {
        switch model.state.kind {
        case .idle: return "checkmark.circle"
        case .running: return "arrow.triangle.2.circlepath"
        case .needsYou: return "hand.raised"
        case .paused: return "pause.circle"
        case .error: return "exclamationmark.triangle"
        }
    }

    private var headerColor: Color {
        switch model.state.kind {
        case .needsYou: return .accentColor
        case .error: return .orange
        default: return .secondary
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
            if expanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(AskPresentation.details(for: ask).enumerated()), id: \.offset) { _, row in
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
                Button(ask.isReview ? "Approve once" : "Allow once") { model.actions?.decide(ask.approvalId, .approve) }
                    .disabled(deciding)
                Button("Deny") { model.actions?.decide(ask.approvalId, .deny) }
                    .disabled(deciding)
                Spacer()
                Button(expanded ? "Hide details" : "Details") {
                    if expanded { model.expanded.remove(ask.approvalId) } else { model.expanded.insert(ask.approvalId) }
                }
                .buttonStyle(.borderless)
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
