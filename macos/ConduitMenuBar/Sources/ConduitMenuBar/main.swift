import AppKit
import ConduitMenuBarCore
import Foundation
import SwiftUI
import UserNotifications

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

/// Conduit's menu-bar app (spec menu-bar-first S5/S6): a process supervisor and
/// thin Control API client. Trusted work runs quietly; the status item shows
/// state, and the popover or a notification asks "do you wanna do this?" when
/// policy says ask. It never executes anything itself (spec §15.3).
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let model = MenuBarModel()
    private let client = ControlClient()
    private let popover = NSPopover()
    private lazy var settingsWindow = SettingsWindowController(model: model)
    private lazy var hotKey = GlobalHotKey { [weak self] in
        self?.showPopover(focusOldestAsk: true)
    }
    private lazy var controlApp = ManagedProcess(label: "Control app", logName: "control-app.log") { [weak self] in
        self?.recompute()
    }
    private lazy var daemon = ManagedProcess(label: "Clipboard daemon", logName: "clipboard-daemon.log") { [weak self] in
        self?.recompute()
    }
    private lazy var agentListener = ManagedProcess(label: "Agent listener", logName: "agent-listener.log") { [weak self] in
        self?.recompute()
    }
    private lazy var updater = UpdateChecker()
    private var keyMonitor: Any?
    /// Something answered `/api/status` on 47831 (this checkout's Control or not).
    private var controlAppExternalAvailable = false
    /// The Control on 47831 is this checkout's (ControlAdoption) and supports
    /// the agent handshake: the only Control this app uses. False makes it
    /// "stale", so actions go through restartStaleControlApp.
    private var controlAppSupportsAgentHandshake = false
    private var controlAdoption: ControlAdoption = .noAnswer
    /// The other checkout last reported in an alert, so a poll every 2 s does
    /// not raise the same alert again. Cleared once the port changes hands.
    private var alertedOtherCheckoutRoot: String?
    private lazy var appCheckoutRoot: String? = PortListeners.appOwner().checkoutRoot
    private var agentListenerNeedsAttention = false
    private var notifiedTransportIds = Set<String>()
    private var notifiedApprovalIds = Set<String>()
    /// Ask notifications that may still be on screen.
    private var deliveredAskIds = Set<String>()
    private var lastStatus: ControlStatusResponse?
    private var lastControl: ControlState?
    private var lastApprovals: [ApprovalSummary] = []
    private var inFlightDecisions = 0
    private var dismissedFailureIds = Set<String>()
    private var stoppedByUser = false
    private var pollInFlight = false
    /// An ask a link or notification pointed at that the last poll has not
    /// seen yet; selected as soon as it arrives.
    private var pendingFocusApprovalId: String?
    private var healthTimer: Timer?
    private var terminationConfirmed = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        model.actions = self
        UNUserNotificationCenter.current().delegate = self
        registerNotificationCategories()
        requestNotificationAuthorization()
        configureStatusItem()
        configurePopover()
        hotKey.register()
        model.hotKeyRegistered = hotKey.isRegistered
        if (try? PortListeners.listenerPids(on: 47831).isEmpty) == true {
            startControlApp()
        } else {
            refreshControlAppHealth()
        }
        startAgentListener()
        startDaemon()
        recompute()
        // The 2 s poll stays until S8 moves approvals to server-sent events.
        healthTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.poll()
        }
        scheduleStartupUpdateCheck()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminationConfirmed {
            return .terminateNow
        }
        return confirmTermination() ? .terminateNow : .terminateCancel
    }

    func applicationWillTerminate(_ notification: Notification) {
        healthTimer?.invalidate()
        hotKey.unregister()
        controlApp.stop()
        agentListener.stop()
        daemon.stop()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "conduit" {
            handleConduitURL(url)
        }
    }

    // MARK: Status item and popover

    private func configureStatusItem() {
        guard let button = statusItem.button else { return }
        ConduitIcon.apply(.idle, to: button)
        button.target = self
        button.action = #selector(statusItemClicked(_:))
    }

    private func configurePopover() {
        let hosting = NSHostingController(rootView: PopoverView(model: model))
        hosting.sizingOptions = [.preferredContentSize]
        popover.contentViewController = hosting
        popover.behavior = .transient
        popover.animates = false
    }

    @objc private func statusItemClicked(_ sender: Any?) {
        if popover.isShown {
            closePopover()
        } else {
            showPopover(focusOldestAsk: false)
        }
    }

    /// Opens the popover. The hotkey and notifications focus an ask; a click
    /// keeps the current selection.
    private func showPopover(focusOldestAsk: Bool, approvalId: String? = nil) {
        guard let button = statusItem.button else { return }
        if let approvalId {
            pendingFocusApprovalId = approvalId
            focusPendingAsk()
        } else if focusOldestAsk {
            model.selection = AskSelection(selectedId: model.state.asks.first?.approvalId)
        }
        NSApp.activate(ignoringOtherApps: true)
        if !popover.isShown {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
        popover.contentViewController?.view.window?.makeKey()
        installKeyMonitor()
        poll()
    }

    func closePopover() {
        popover.performClose(nil)
        model.confirmingStopAll = false
        removeKeyMonitor()
    }

    /// Popover keys (spec §3.3). Only while the popover is the key window; a
    /// confirmation in progress keeps Return for its own default button.
    private func installKeyMonitor() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.popover.isShown, event.window == self.popover.contentViewController?.view.window else {
                return event
            }
            guard let input = PopoverKeys.input(from: event), let command = KeyBindings.command(for: input) else {
                return event
            }
            if self.model.confirmingStopAll {
                if command == .close {
                    self.model.confirmingStopAll = false
                    return nil
                }
                return event
            }
            return self.model.handle(command) ? nil : event
        }
    }

    private func removeKeyMonitor() {
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
        }
        keyMonitor = nil
    }

    // MARK: Polling and state

    private func poll() {
        guard !pollInFlight else { return }
        pollInFlight = true
        let checkoutRoot = appCheckoutRoot
        Task {
            let status = try? await client.status()
            // Nothing beyond /api/status is read from another checkout's Control.
            let adopted = ControlAdoption.evaluate(status, appCheckoutRoot: checkoutRoot).adopted
            let control: ControlState? = if adopted && status?.capabilities.pause == true { try? await client.control() } else { nil }
            let approvals: [ApprovalSummary]? = if adopted { try? await client.approvals() } else { nil }
            await MainActor.run {
                self.pollInFlight = false
                self.applyPoll(status: status, control: control, approvals: approvals)
            }
        }
        refreshAgentListenerHealth()
        observeServiceTrees()
    }

    /// Records each launched service's process-tree members, so Stop all also
    /// reaches a child that detached (setsid) after it was seen (F-04).
    private func observeServiceTrees() {
        let services = [controlApp, agentListener, daemon]
        guard services.contains(where: \.hasProcesses) else { return }
        let entries = KernelProcessTable().entries()
        for service in services {
            service.observeTree(entries)
        }
    }

    private func applyPoll(status: ControlStatusResponse?, control: ControlState?, approvals: [ApprovalSummary]?) {
        applyControlStatus(status)
        lastControl = control
        if let approvals {
            lastApprovals = approvals
            let asks = MenuBarState.orderAsks(approvals)
            for ask in asks where !notifiedApprovalIds.contains(ask.approvalId) {
                notifiedApprovalIds.insert(ask.approvalId)
                deliveredAskIds.insert(ask.approvalId)
                notifyApprovalRequired(ask)
            }
            // A notification for an ask that is no longer waiting is withdrawn,
            // so nobody acts on a stale one (the action handler re-checks too).
            let waiting = Set(asks.map(\.approvalId))
            let stale = deliveredAskIds.subtracting(waiting)
            if !stale.isEmpty {
                deliveredAskIds.subtract(stale)
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: stale.map { "conduit-approval-\($0)" })
            }
        } else if !controlAdoption.adopted {
            lastApprovals = []
        }
        recompute()
    }

    /// Adopts the Control on 47831 only when it reports this checkout
    /// (ControlAdoption). Another checkout's is never used: it counts as
    /// stale, so Restart services and every action that needs Control go
    /// through restartStaleControlApp, which stops nothing that is not this
    /// checkout's and reports who holds the port. On first seeing another
    /// checkout's Control the app shows that report straight away.
    private func applyControlStatus(_ status: ControlStatusResponse?) {
        controlAdoption = ControlAdoption.evaluate(status, appCheckoutRoot: appCheckoutRoot)
        controlAppExternalAvailable = status != nil
        controlAppSupportsAgentHandshake = controlAdoption.adopted && status?.capabilities.agentHandshake == true
        lastStatus = controlAdoption.adopted ? status : nil
        guard case .otherCheckout(let reportedRoot) = controlAdoption else {
            alertedOtherCheckoutRoot = nil
            return
        }
        if alertedOtherCheckoutRoot != reportedRoot {
            alertedOtherCheckoutRoot = reportedRoot
            presentError("Not using the control app on port 47831.", PortListeners.otherCheckoutControlError(reportedRoot: reportedRoot))
        }
    }

    private func recompute() {
        let snapshot = ServiceSnapshot(
            controlReachable: controlAppExternalAvailable,
            crashedServices: [controlApp, agentListener, daemon].filter(\.crashed).map(\.label),
            agentListenerNeedsAttention: agentListenerNeedsAttention,
            stoppedByUser: stoppedByUser,
            controlStarting: controlApp.isRunning && !controlAppExternalAvailable,
            controlAdoption: controlAdoption,
            localPause: controlAppExternalAvailable || stoppedByUser ? nil : readLocalPause()
        )
        let state = MenuBarState.reduce(
            status: lastStatus,
            control: lastControl,
            approvals: lastApprovals,
            services: snapshot,
            inFlightDecisions: inFlightDecisions,
            dismissedFailureIds: dismissedFailureIds
        )
        model.update(state)
        focusPendingAsk()
        model.pauseSupported = lastStatus == nil || lastStatus?.capabilities.pause == true
        model.services = serviceRows()
        if let button = statusItem.button {
            ConduitIcon.apply(state.kind, to: button)
        }
    }

    /// The pause flag `conduit pause --local` writes, read while Control does
    /// not answer. The state root is resolved from this app's environment;
    /// the CLI also inherits it (a login shell could still override
    /// CONDUIT_STATE_DIR, which this cannot see).
    private func readLocalPause() -> LocalPauseState {
        let root = LocalPause.stateRoot(
            environment: ProcessInfo.processInfo.environment,
            home: NSHomeDirectory(),
            workingDirectory: RepoLocator.repoRoot()
        )
        return LocalPause.read(path: LocalPause.flagPath(stateRoot: root))
    }

    private func focusPendingAsk() {
        guard let id = pendingFocusApprovalId, model.state.asks.contains(where: { $0.approvalId == id }) else { return }
        model.selection.select(id, in: model.state.asks)
        model.expanded.insert(id)
        pendingFocusApprovalId = nil
    }

    private func serviceRows() -> [MenuBarModel.ServiceRow] {
        [
            MenuBarModel.ServiceRow(
                id: "control",
                label: "Control app",
                status: controlAppStatusSummary(),
                actionTitle: controlAppToggleTitle(),
                actionEnabled: controlAppToggleEnabled()
            ),
            MenuBarModel.ServiceRow(
                id: "agent",
                label: "Agent listener",
                status: agentListenerNeedsAttention ? "needs attention" : agentListener.statusSummary,
                actionTitle: agentListener.isRunning ? "Stop Agent Listener" : "Start Agent Listener",
                actionEnabled: true
            ),
            MenuBarModel.ServiceRow(
                id: "daemon",
                label: "Clipboard daemon",
                status: daemon.statusSummary,
                actionTitle: daemon.isRunning ? "Stop Clipboard Daemon" : "Start Clipboard Daemon",
                actionEnabled: true
            )
        ]
    }

    private func controlAppStatusSummary() -> String {
        if controlApp.isRunning {
            return controlAppExternalAvailable ? "running" : "starting"
        }
        if case .otherCheckout(let reportedRoot) = controlAdoption {
            return "another checkout's (\(reportedRoot))"
        }
        if controlAppExternalAvailable {
            return controlAppSupportsAgentHandshake ? "available (started outside this app)" : "stale"
        }
        return controlApp.statusSummary
    }

    private func controlAppToggleTitle() -> String {
        if controlApp.isRunning {
            return "Stop Control App"
        }
        if case .otherCheckout = controlAdoption {
            return "Control App From Another Checkout"
        }
        if controlAppExternalAvailable {
            return controlAppSupportsAgentHandshake ? "Control App Already Running" : "Control App Needs Restart"
        }
        return "Start Control App"
    }

    private func controlAppToggleEnabled() -> Bool {
        controlApp.isRunning || !controlAppExternalAvailable || !controlAppSupportsAgentHandshake
    }

    private func refreshControlAppHealth(completion: ((Bool) -> Void)? = nil) {
        Task {
            let status = try? await client.status()
            await MainActor.run {
                self.applyControlStatus(status)
                self.recompute()
                completion?(status != nil)
            }
        }
    }

    private func refreshAgentListenerHealth() {
        guard agentListener.isRunning, let url = URL(string: "http://127.0.0.1:3333/health") else {
            if agentListenerNeedsAttention {
                agentListenerNeedsAttention = false
                recompute()
            }
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 0.75
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let health = data.flatMap { try? JSONDecoder().decode(AgentListenerHealthResponse.self, from: $0) }
            let exhausted = (response as? HTTPURLResponse)?.statusCode == 200 && health?.lastTransportError?.needsAttention == true
            DispatchQueue.main.async {
                guard let self else {
                    return
                }
                let changed = self.agentListenerNeedsAttention != exhausted
                self.agentListenerNeedsAttention = exhausted
                if exhausted, let error = health?.lastTransportError {
                    self.notifyAgentSendFailure(error)
                }
                if changed {
                    self.recompute()
                }
            }
        }.resume()
    }

    // MARK: Decisions (decidedBy: menubar | notification)

    private func decide(_ approvalId: String, _ decision: ApprovalDecision, channel: DecisionChannel) {
        guard !model.deciding.contains(approvalId) else { return }
        // Asks come only from this checkout's Control; if the port changed
        // hands since, decide nothing rather than answer another checkout's.
        guard controlAdoption.adopted else {
            model.show("Nothing was decided: the control app on port 47831 is not this checkout's.", isError: true)
            poll()
            return
        }
        model.deciding.insert(approvalId)
        inFlightDecisions += 1
        recompute()
        Task {
            let message: String
            let isError: Bool
            let settledStatus: String?
            do {
                let response = try await client.decide(approvalId: approvalId, decision, channel: channel)
                message = decision == .approve ? response.statusMessage : "Denied. Nothing ran."
                isError = false
                settledStatus = decision == .approve ? "approved" : "denied"
            } catch let error as ControlAPIError {
                message = error.userMessage
                isError = true
                settledStatus = error.approvalStatus == "pending" ? nil : error.approvalStatus
            } catch {
                message = error.localizedDescription
                isError = true
                settledStatus = nil
            }
            await MainActor.run {
                self.model.deciding.remove(approvalId)
                self.inFlightDecisions -= 1
                if settledStatus != nil {
                    self.lastApprovals.removeAll { $0.approvalId == approvalId && $0.isAwaitingDecision }
                }
                self.model.show(message, isError: isError)
                if channel == .notification || !self.popover.isShown {
                    let title = isError
                        ? "Conduit could not \(decision == .approve ? "approve" : "deny") that"
                        : "Conduit approval \(decision == .approve ? "approved" : "denied")"
                    self.postNotice(title, body: message)
                }
                self.recompute()
                self.poll()
            }
        }
    }

    /// Allow once from a notification. The notification showed one tool and
    /// one path; re-read the record and approve only if that is still exactly
    /// what would run. Otherwise open the popover and decide nothing.
    private func allowOnceFromNotification(_ approvalId: String, shownTool: String?, shownPath: String?) {
        Task {
            do {
                let current = try await client.approval(id: approvalId)
                let matches = AskNotification.allowOnceStillMatches(current: current, shownTool: shownTool, shownPath: shownPath)
                await MainActor.run {
                    if matches {
                        self.decide(approvalId, .approve, channel: .notification)
                    } else {
                        self.postNotice("Nothing was approved", body: "That request changed or is no longer waiting. Open Conduit to review it.")
                        self.showPopover(focusOldestAsk: false, approvalId: approvalId)
                    }
                }
            } catch let error as ControlAPIError {
                await MainActor.run {
                    self.postNotice("Nothing was approved", body: error.userMessage)
                }
            } catch {
                await MainActor.run {
                    self.postNotice("Nothing was approved", body: error.localizedDescription)
                }
            }
        }
    }

    // MARK: Pause, resume, stop all

    func togglePause() {
        guard !model.busy else { return }
        if stoppedByUser {
            startAndResume()
            return
        }
        let wasPaused = model.state.paused
        if wasPaused && model.state.controlUnreachable {
            // Resume always goes through Control; there is no --local resume.
            model.show("Conduit stays paused: Control is not running. Choose Restart services, then resume.", isError: true)
            return
        }
        model.busy = true
        Task {
            let message: String
            let isError: Bool
            let unreachable: Bool
            do {
                let control = wasPaused
                    ? try await client.resume(by: .menubar)
                    : try await client.pause(by: .menubar, reason: "Paused from the menu bar.")
                await MainActor.run { self.lastControl = control }
                message = wasPaused ? "Resumed. Trusted requests run again." : "Paused. Nothing runs until you resume."
                isError = false
                unreachable = false
            } catch let error as ControlAPIError {
                message = error.userMessage
                isError = true
                unreachable = error.statusCode == nil
            } catch {
                message = error.localizedDescription
                isError = true
                unreachable = false
            }
            await MainActor.run {
                if !wasPaused && unreachable {
                    // A pause must not depend on Control being up: write it
                    // directly with the CLI's --local path (S1).
                    self.pauseLocally()
                    return
                }
                self.model.busy = false
                self.model.show(message, isError: isError)
                self.poll()
            }
        }
    }

    private func pauseLocally() {
        ConduitCommand.run(arguments: ["run", "conduit", "--", "pause", "--local", "--reason", "Paused from the menu bar (Control did not answer)."]) { [weak self] status in
            guard let self else { return }
            self.model.busy = false
            if status == 0 {
                self.model.show("Paused. Control did not answer, so the pause was written directly.", isError: false)
            } else {
                self.model.show("Could not pause: Control did not answer and the direct pause failed. Use Stop all, or run `conduit pause --local`.", isError: true)
            }
            self.poll()
        }
    }

    /// Kill switch (spec invariant 7): pause and revoke every session through
    /// Control, then stop the process trees this app launched, including any
    /// tool runs under them (SIGKILL after a short grace). If Control does not
    /// answer, the services are stopped anyway and the pause + revoke is
    /// written with `conduit stop-all --local`.
    func stopAll() {
        guard !model.busy else { return }
        model.confirmingStopAll = false
        model.busy = true
        Task {
            let revoked: Int?
            let apiError: String?
            do {
                let response = try await client.stopAll(by: .menubar, reason: "Stopped from the menu bar.")
                revoked = response.revokedSessions.count
                apiError = nil
            } catch let error as ControlAPIError {
                revoked = nil
                apiError = error.userMessage
            } catch {
                revoked = nil
                apiError = error.localizedDescription
            }
            await MainActor.run {
                self.stoppedByUser = true
                self.controlApp.stop(force: true)
                self.agentListener.stop(force: true)
                self.daemon.stop(force: true)
                if let revoked {
                    let chats = revoked == 1 ? "1 chat" : "\(revoked) chats"
                    self.finishStopAll("Stopped. Conduit is paused, \(chats) disconnected, and its services are off.", isError: false)
                    return
                }
                self.recompute()
                ConduitCommand.run(arguments: ["run", "conduit", "--", "stop-all", "--local", "--reason", "Stopped from the menu bar (Control did not answer)."]) { status in
                    if status == 0 {
                        self.finishStopAll("Stopped. Control did not answer, so the pause and disconnect were written directly. Services are off.", isError: false)
                    } else {
                        self.finishStopAll("Services are off, but the pause could not be recorded (\(apiError ?? "Control did not answer")). Run `conduit stop-all --local` before starting Conduit again.", isError: true)
                    }
                }
            }
        }
    }

    private func finishStopAll(_ message: String, isError: Bool) {
        model.busy = false
        model.show(message, isError: isError)
        postNotice(isError ? "Conduit stop all needs attention" : "Conduit stopped", body: message)
        recompute()
    }

    /// After Stop all: start the services again, wait for Control, then resume.
    func startAndResume() {
        guard !model.busy else { return }
        model.busy = true
        stoppedByUser = false
        if !controlApp.isRunning && !controlAppExternalAvailable {
            startControlApp()
        }
        if !agentListener.isRunning {
            startAgentListener()
        }
        if !daemon.isRunning {
            startDaemon()
        }
        waitForControlAppHealth { [weak self] ready in
            guard let self else { return }
            guard ready else {
                self.model.busy = false
                self.model.show("Conduit Control did not start, so Conduit is still paused. Open Logs from Settings.", isError: true)
                self.recompute()
                return
            }
            Task {
                let message: String
                let isError: Bool
                do {
                    _ = try await self.client.resume(by: .menubar)
                    message = "Resumed. Chats disconnected by Stop all need a new handshake."
                    isError = false
                } catch let error as ControlAPIError {
                    message = "Services started, but Conduit is still paused: \(error.userMessage)"
                    isError = true
                } catch {
                    message = error.localizedDescription
                    isError = true
                }
                await MainActor.run {
                    self.model.busy = false
                    self.model.show(message, isError: isError)
                    self.poll()
                }
            }
        }
    }

    func performFix(_ fix: ErrorFix) {
        switch fix {
        case .restartServices:
            stoppedByUser = false
            for service in [controlApp, agentListener, daemon] where service.crashed {
                service.stop()
            }
            if controlAppExternalAvailable && !controlAppSupportsAgentHandshake {
                restartStaleControlApp()
            } else if !controlApp.isRunning && !controlAppExternalAvailable {
                startControlApp()
            }
            if !agentListener.isRunning { startAgentListener() }
            if !daemon.isRunning { startDaemon() }
        case .openLogs:
            openLogsFolder()
        case .reviewFailure(let approvalId):
            dismissedFailureIds.insert(approvalId)
        }
        recompute()
    }

    // MARK: Notifications (S6)

    private func registerNotificationCategories() {
        // Allow once only on the category whose body names the exact path
        // (file.write / single-file patch). It also requires an unlocked Mac.
        let allowOnce = UNNotificationAction(
            identifier: AskNotification.actionAllowOnce,
            title: "Allow once",
            options: [.authenticationRequired]
        )
        let deny = UNNotificationAction(identifier: AskNotification.actionDeny, title: "Deny", options: [.destructive])
        let review = UNNotificationAction(identifier: AskNotification.actionReview, title: "Review…", options: [.foreground])
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: AskNotification.categoryAllowOnce, actions: [allowOnce, deny, review], intentIdentifiers: []),
            UNNotificationCategory(identifier: AskNotification.categoryReviewOnly, actions: [review, deny], intentIdentifiers: [])
        ])
    }

    private func notifyApprovalRequired(_ approval: ApprovalSummary) {
        let ask = AskNotification.make(for: approval)
        let content = UNMutableNotificationContent()
        content.title = ask.title
        content.body = ask.body
        content.sound = .default
        content.categoryIdentifier = ask.categoryIdentifier
        content.userInfo = ask.userInfo
        let request = UNNotificationRequest(identifier: ask.identifier, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    private func notifyAgentSendFailure(_ error: AgentTransportError) {
        let transportId = error.transportId ?? "unknown"
        if notifiedTransportIds.contains(transportId) {
            return
        }
        notifiedTransportIds.insert(transportId)
        postNotice(
            "Conduit send needs attention",
            body: "Agent message \(transportId) could not be sent after retries. Reload the ChatGPT tab or extension, then retry."
        )
    }

    private func postNotice(_ title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: "conduit-notice-\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    private func requestNotificationAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    // MARK: conduit:// links

    private func handleConduitURL(_ url: URL) {
        ensureControlAppReady { [weak self] ready in
            guard let self else {
                return
            }
            guard ready else {
                self.presentError("Could not open Conduit link.", AppError("The control app did not become available."))
                return
            }
            Task {
                do {
                    let result = try await self.submitConduitURL(url)
                    await MainActor.run {
                        if result.execution.status == "requires_review", let approvalId = result.execution.approvalId {
                            // The person just clicked a link, so show the ask
                            // in the popover (details open) rather than a modal alert.
                            self.showPopover(focusOldestAsk: false, approvalId: approvalId)
                        } else if let runId = result.execution.runId {
                            self.postNotice("Conduit link executed", body: "Run \(runId) is ready in Conduit.")
                        } else {
                            self.postNotice("Conduit link handled", body: result.execution.reason ?? "Conduit handled the request.")
                        }
                    }
                } catch {
                    await MainActor.run {
                        self.presentError("Could not open Conduit link.", error)
                    }
                }
            }
        }
    }

    private func ensureControlAppReady(completion: @escaping (Bool) -> Void) {
        if controlAppExternalAvailable && controlAppSupportsAgentHandshake {
            completion(true)
            return
        }
        if !controlApp.isRunning && !controlAppExternalAvailable {
            startControlApp()
        } else if controlAppExternalAvailable && !controlAppSupportsAgentHandshake {
            restartStaleControlApp(completion: completion)
            return
        }
        waitForControlAppHealth(completion: completion)
    }

    private func submitConduitURL(_ conduitURL: URL) async throws -> ConduitURLResponse {
        guard let url = URL(string: "http://127.0.0.1:47831/api/url/open") else {
            throw AppError("Invalid control app URL.")
        }
        let payload: [String: Any] = [
            "url": conduitURL.absoluteString
        ]
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw AppError(String(data: data, encoding: .utf8) ?? "Conduit link request failed.")
        }
        return try JSONDecoder().decode(ConduitURLResponse.self, from: data)
    }

    // MARK: Footer and Settings actions

    func copyHandshake() {
        if !controlApp.isRunning && !controlAppExternalAvailable {
            startControlApp()
        }
        if !agentListener.isRunning {
            startAgentListener()
        }
        if controlAppExternalAvailable && !controlAppSupportsAgentHandshake {
            restartStaleControlApp { [weak self] restarted in
                guard restarted else {
                    return
                }
                self?.copyHandshake()
            }
            return
        }

        Task {
            do {
                let handshake = try await requestAgentHandshake()
                await MainActor.run {
                    let pasteboard = NSPasteboard.general
                    pasteboard.clearContents()
                    pasteboard.setString(handshake.handshake, forType: .string)
                    self.model.show("Agent handshake copied. Paste it into the chat you want to trust.", isError: false)
                    self.refreshControlAppHealth()
                }
            } catch {
                await MainActor.run {
                    self.presentError("Could not copy the agent handshake.", error)
                }
            }
        }
    }

    func openSettings() {
        closePopover()
        recompute()
        settingsWindow.show()
    }

    func quit() {
        closePopover()
        NSApp.terminate(nil)
    }

    func serviceAction(_ serviceId: String) {
        switch serviceId {
        case "control":
            if controlApp.isRunning {
                controlApp.stop()
            } else if controlAppExternalAvailable && !controlAppSupportsAgentHandshake {
                restartStaleControlApp()
            } else if controlAppExternalAvailable {
                openWebPanel()
            } else {
                startControlApp()
            }
        case "agent":
            if agentListener.isRunning {
                agentListener.stop()
            } else {
                startAgentListener()
            }
        case "daemon":
            if daemon.isRunning {
                daemon.stop()
            } else {
                startDaemon()
            }
        default:
            break
        }
        recompute()
    }

    func openDetails(_ approvalId: String) {
        // The per-approval deep link (`#approval/<id>`) arrives with S7.
        openControlPanelURL(path: "#approvals")
    }

    func openWebPanel() {
        openControlPanelURL(path: "")
    }

    func openLogsFolder() {
        NSWorkspace.shared.open(LogFiles.logDirectory)
    }

    func reportBug() {
        openDiagnostics()
    }

    func checkForUpdates() {
        checkForUpdates(notifyWhenCurrent: true)
    }

    private func openDiagnostics() {
        openControlPanelURL(path: "#diagnostics")
    }

    private func openControlPanelURL(path: String) {
        if !controlApp.isRunning && !controlAppExternalAvailable {
            startControlApp()
        }
        if let url = URL(string: "http://127.0.0.1:47831\(path)") {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: Updates

    private func scheduleStartupUpdateCheck() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.checkForUpdates(notifyWhenCurrent: false)
        }
    }

    private func checkForUpdates(notifyWhenCurrent: Bool) {
        Task {
            do {
                let result = try await updater.check()
                await MainActor.run {
                    if result.isUpdateAvailable || notifyWhenCurrent {
                        presentUpdateResult(result)
                    }
                }
            } catch {
                await MainActor.run {
                    if notifyWhenCurrent {
                        if isMissingPinnedReleaseKeyError(error) {
                            presentUpdateResult(UpdateCheckResult.localPreviewMissingPinnedKey())
                        } else {
                            presentError("Could not check for updates.", error)
                        }
                    }
                }
            }
        }
    }

    private func isMissingPinnedReleaseKeyError(_ error: Error) -> Bool {
        error.localizedDescription.contains("does not include a pinned O&K release public key")
    }

    private func presentUpdateResult(_ result: UpdateCheckResult) {
        let alert = NSAlert()
        alert.messageText = result.isUpdateAvailable ? "Conduit update available" : "Conduit is up to date"
        alert.informativeText = result.message
        if result.isUpdateAvailable, result.artifact != nil {
            alert.addButton(withTitle: "Install Update")
            alert.addButton(withTitle: "Later")
            if alert.runModal() == .alertFirstButtonReturn {
                installUpdate(result)
            }
        } else {
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
    }

    private func installUpdate(_ result: UpdateCheckResult) {
        Task {
            do {
                try await updater.install(result: result)
                await MainActor.run {
                    self.terminationConfirmed = true
                    NSApp.terminate(nil)
                }
            } catch {
                await MainActor.run {
                    presentError("Could not install the update.", error)
                }
            }
        }
    }

    // MARK: Supervisor

    private func startControlApp() {
        do {
            try controlApp.start(arguments: ["run", "conduit", "--", "app", "start", "--port", "47831"])
        } catch {
            presentError("Could not start the control app.", error)
        }
        recompute()
    }

    private func restartStaleControlApp(completion: ((Bool) -> Void)? = nil) {
        do {
            // One lsof: stop only a control app that is ours; another
            // checkout's (or an installed Conduit's) is left running and
            // reported. Exited pids are in neither list.
            let listeners = try PortListeners.ownedListeners(on: 47831, service: .control)
            if !listeners.foreign.isEmpty {
                throw PortListeners.foreignListenerError(port: 47831, listeners.foreign)
            }
            if listeners.ours.isEmpty {
                controlAppExternalAvailable = false
                controlAppSupportsAgentHandshake = false
                startControlApp()
                waitForControlAppHealth(completion: completion)
                return
            }

            for pid in listeners.ours {
                ProcessTree.terminateTree(of: pid)
            }
            recompute()
            waitForPortToClear(47831) {
                self.controlAppExternalAvailable = false
                self.controlAppSupportsAgentHandshake = false
                self.startControlApp()
                self.waitForControlAppHealth(completion: completion)
            }
        } catch {
            presentError("Could not restart the control app.", error)
            completion?(false)
        }
    }

    private func waitForPortToClear(_ port: Int, completion: @escaping () -> Void) {
        DispatchQueue.global(qos: .utility).async {
            for _ in 0..<30 {
                if (try? PortListeners.listenerPids(on: port).isEmpty) == true {
                    break
                }
                Thread.sleep(forTimeInterval: 0.1)
            }
            DispatchQueue.main.async(execute: completion)
        }
    }

    private func waitForControlAppHealth(attemptsRemaining: Int = 30, completion: ((Bool) -> Void)?) {
        refreshControlAppHealth { [weak self] available in
            guard let self else {
                completion?(false)
                return
            }
            if available && self.controlAppSupportsAgentHandshake {
                completion?(true)
                return
            }
            guard attemptsRemaining > 0 else {
                completion?(false)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self.waitForControlAppHealth(attemptsRemaining: attemptsRemaining - 1, completion: completion)
            }
        }
    }

    private func startDaemon() {
        do {
            try daemon.start(arguments: ["run", "conduit", "--", "daemon", "start", "--interval-ms", "1000"])
        } catch {
            presentError("Could not start the clipboard daemon.", error)
        }
        recompute()
    }

    private func startAgentListener() {
        do {
            // Stop only an agent listener that is ours; another checkout's (or
            // an installed Conduit's) is left running and reported.
            let listeners = try PortListeners.ownedListeners(on: 3333, service: .agentListener)
            if !listeners.foreign.isEmpty {
                throw PortListeners.foreignListenerError(port: 3333, listeners.foreign)
            }
            for pid in listeners.ours {
                ProcessTree.terminateTree(of: pid)
            }
            waitForPortToClear(3333) {
                do {
                    try self.agentListener.start(arguments: ["run", "conduit", "--", "listen", "--project", RepoLocator.repoRoot()])
                } catch {
                    self.presentError("Could not start the agent listener.", error)
                }
                self.recompute()
            }
        } catch {
            presentError("Could not start the agent listener.", error)
        }
        recompute()
    }

    private func requestAgentHandshake() async throws -> AgentHandshakeResponse {
        guard let url = URL(string: "http://127.0.0.1:47831/api/agent-handshake") else {
            throw AppError("Invalid control app URL.")
        }
        let payload: [String: Any] = [
            "label": "Chat agent loop",
            "root": RepoLocator.repoRoot(),
            "profile": "read-only",
            "transport": "extension",
            "copy": false
        ]
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 201 else {
            throw AppError(String(data: data, encoding: .utf8) ?? "Handshake request failed.")
        }
        return try JSONDecoder().decode(AgentHandshakeResponse.self, from: data)
    }

    private func confirmTermination() -> Bool {
        let alert = NSAlert()
        alert.messageText = "Quit Conduit?"
        alert.informativeText = "Quitting stops the control app, agent listener, and clipboard daemon processes started by Conduit. Choose Keep Running if you want Conduit to stay in the menu bar supervising local execution."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Quit and Stop Services")
        alert.addButton(withTitle: "Keep Running")
        let shouldQuit = alert.runModal() == .alertFirstButtonReturn
        terminationConfirmed = shouldQuit
        return shouldQuit
    }

    private func presentError(_ title: String, _ error: Error) {
        let alert = NSAlert(error: error)
        alert.messageText = title
        alert.informativeText = [
            error.localizedDescription,
            "",
            "You can open the bug-report view to preview a redacted diagnostic bundle."
        ].joined(separator: "\n")
        alert.addButton(withTitle: "Report Bug")
        alert.addButton(withTitle: "OK")
        if alert.runModal() == .alertFirstButtonReturn {
            openDiagnostics()
        }
    }
}

extension AppDelegate: MenuBarActions {
    func decide(_ approvalId: String, _ decision: ApprovalDecision) {
        // Popover clicks, its keys and the hotkey are all the menu bar.
        decide(approvalId, decision, channel: .menubar)
    }
}

extension AppDelegate: UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        DispatchQueue.main.async {
            guard info["conduitAction"] as? String == "openAsk", let approvalId = info["approvalId"] as? String else {
                return
            }
            switch action {
            case AskNotification.actionAllowOnce:
                self.allowOnceFromNotification(approvalId, shownTool: info["tool"] as? String, shownPath: info["path"] as? String)
            case AskNotification.actionDeny:
                self.decide(approvalId, .deny, channel: .notification)
            case UNNotificationDismissActionIdentifier:
                // Dismissing is no decision, never a yes (spec §2.2 item 4).
                break
            default:
                // Review… or a click on the notification body.
                self.showPopover(focusOldestAsk: false, approvalId: approvalId)
            }
        }
        completionHandler()
    }
}

struct AgentHandshakeResponse: Decodable {
    let handshake: String
}

struct ConduitURLResponse: Decodable {
    let command: String
    let execution: ConduitURLExecution
}

struct ConduitURLExecution: Decodable {
    let status: String
    let runId: String?
    let approvalId: String?
    let reason: String?
}

struct AgentListenerHealthResponse: Decodable {
    let lastTransportError: AgentTransportError?
}

struct AgentTransportError: Decodable {
    let transportId: String?
    let needsAttention: Bool?
}
