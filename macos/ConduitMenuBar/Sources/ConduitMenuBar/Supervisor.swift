import AppKit
import ConduitMenuBarCore
import Foundation

// Process supervision for the services the menu bar launches (control app,
// agent listener, clipboard daemon). Moved out of main.swift in S5.

struct AppError: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? {
        message
    }
}

final class ManagedProcess {
    let label: String
    let logName: String
    private(set) var process: Process?
    private var logHandle: FileHandle?
    private let onExit: () -> Void
    private var lastExitSummary: String?
    private var stopRequested = false
    /// Exited on its own with a non-zero status (not stopped by Conduit or the
    /// person). Feeds the status item's error state.
    private(set) var crashed = false

    init(label: String, logName: String, onExit: @escaping () -> Void) {
        self.label = label
        self.logName = logName
        self.onExit = onExit
    }

    var isRunning: Bool {
        process?.isRunning == true
    }

    var statusSummary: String {
        if isRunning {
            return "running"
        }
        return lastExitSummary ?? "stopped"
    }

    func start(arguments: [String]) throws {
        if isRunning {
            return
        }

        let launched = Process()
        let repoRoot = RepoLocator.repoRoot()
        let shellCommand = ShellCommand.npm(arguments: arguments, in: repoRoot)
        launched.executableURL = URL(fileURLWithPath: "/bin/zsh")
        launched.arguments = ["-lc", shellCommand]
        launched.currentDirectoryURL = URL(fileURLWithPath: repoRoot)

        let handle = try LogFiles.openLogHandle(named: logName)
        logHandle = handle
        lastExitSummary = nil
        stopRequested = false
        crashed = false
        writeLogLine("Starting \(label): \(shellCommand)")
        launched.standardOutput = handle
        launched.standardError = handle

        launched.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else {
                    return
                }
                let status = launched.terminationStatus
                let expected = self.stopRequested || status == 0
                self.lastExitSummary = expected ? "stopped" : "exited \(status)"
                self.crashed = !expected
                self.writeLogLine("Stopped \(self.label) with exit status \(status).")
                self.logHandle?.closeFile()
                self.logHandle = nil
                self.process = nil
                self.onExit()
            }
        }

        try launched.run()
        process = launched
    }

    /// Stops the whole process tree. With `force`, anything in the tree still
    /// alive after `grace` seconds gets SIGKILL: Stop all is a kill switch, so a
    /// tool run that ignores SIGTERM must not outlive it.
    func stop(force: Bool = false, grace: TimeInterval = 3) {
        guard let process else {
            return
        }
        stopRequested = true
        crashed = false
        writeLogLine(force ? "Stop all requested for \(label)." : "Stop requested for \(label).")
        if process.isRunning {
            let tree = ProcessTree.descendants(of: process.processIdentifier) + [process.processIdentifier]
            ProcessTree.terminateChildren(of: process.processIdentifier)
            process.terminate()
            if force {
                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + grace) {
                    ProcessTree.killSurvivors(tree)
                }
            }
        } else {
            logHandle?.closeFile()
            logHandle = nil
            self.process = nil
            lastExitSummary = "stopped"
            onExit()
        }
    }

    private func writeLogLine(_ text: String) {
        guard let data = "[\(Date())] \(text)\n".data(using: .utf8) else {
            return
        }
        logHandle?.write(data)
    }
}

enum ProcessTree {
    static func terminateTree(of pid: Int32) {
        terminateChildren(of: pid)
        kill(pid, SIGTERM)
    }

    static func terminateChildren(of pid: Int32) {
        for child in childPids(of: pid) {
            terminateTree(of: child)
        }
    }

    /// Every descendant pid, depth first, snapshotted before any signal so a
    /// child re-parented to launchd after its parent dies is still covered.
    static func descendants(of pid: Int32) -> [Int32] {
        childPids(of: pid).flatMap { [$0] + descendants(of: $0) }
    }

    /// SIGKILL whatever in a snapshotted tree is still alive. Runs seconds
    /// after the snapshot, so pid reuse in between is not a practical concern.
    static func killSurvivors(_ pids: [Int32]) {
        for pid in pids where kill(pid, 0) == 0 {
            kill(pid, SIGKILL)
        }
    }

    private static func childPids(of pid: Int32) -> [Int32] {
        let pkill = Process()
        let output = Pipe()
        pkill.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        pkill.arguments = ["-P", String(pid)]
        pkill.standardOutput = output
        pkill.standardError = FileHandle.nullDevice
        do {
            try pkill.run()
        } catch {
            return []
        }
        pkill.waitUntilExit()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        let text = String(data: data, encoding: .utf8) ?? ""
        return text
            .split(whereSeparator: \.isWhitespace)
            .compactMap { Int32($0) }
    }
}

enum PortListeners {
    static func listenerPids(on port: Int) throws -> [Int32] {
        let lsof = Process()
        let output = Pipe()
        lsof.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        lsof.arguments = ["-nP", "-t", "-iTCP:\(port)", "-sTCP:LISTEN"]
        lsof.standardOutput = output
        lsof.standardError = FileHandle.nullDevice
        try lsof.run()
        lsof.waitUntilExit()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        let text = String(data: data, encoding: .utf8) ?? ""
        return text
            .split(whereSeparator: \.isWhitespace)
            .compactMap { Int32($0) }
    }

    /// The listeners on a port, split into those this app may stop and those
    /// it must leave running (see ListenerOwnership in ConduitMenuBarCore).
    /// Pids that have already exited are in neither list.
    static func ownedListeners(on port: Int, service: ConduitService) throws -> (ours: [Int32], foreign: [ProcessSnapshot]) {
        let owner = appOwner()
        var ours: [Int32] = []
        var foreign: [ProcessSnapshot] = []
        for pid in try listenerPids(on: port) {
            let snapshot = ProcessProbe.snapshot(pid: pid)
            switch ListenerOwnership.classify(snapshot, service: service, owner: owner) {
            case .ours:
                ours.append(pid)
            case .foreign:
                if let snapshot {
                    foreign.append(snapshot)
                }
            case .gone:
                break
            }
        }
        return (ours, foreign)
    }

    /// The error shown when a port is held by a process that is not ours.
    static func foreignListenerError(port: Int, _ foreign: [ProcessSnapshot]) -> AppError {
        let holders = foreign.map(\.summary).joined(separator: ", ")
        return AppError(
            "Port \(port) is in use by a process this Conduit app did not start and that is not from its checkout (\(RepoLocator.repoRoot())): \(holders). "
                + "Conduit left it running. Quit the other Conduit app or stop that process, then choose Restart services."
        )
    }

    /// The error shown when the Control on 47831 reports another checkout
    /// (ControlAdoption.otherCheckout). Names that checkout and every process
    /// holding the port. Nothing is signalled.
    static func otherCheckoutControlError(reportedRoot: String) -> AppError {
        let holders = ((try? listenerPids(on: 47831)) ?? []).compactMap(ProcessProbe.snapshot(pid:)).map(\.summary)
        let heldBy = holders.isEmpty ? "" : ": \(holders.joined(separator: ", "))"
        return AppError(
            "Port 47831 is in use by Conduit Control from another checkout (\(reportedRoot)), not this app's checkout (\(RepoLocator.repoRoot()))\(heldBy). "
                + "Conduit is not using it and left it running. Quit the other Conduit app or stop that process, then choose Restart services."
        )
    }

    /// This app's pid, its checkout (only when it really is one) and its
    /// .app bundle (only when running from one, not from a bare build dir).
    /// The checkout is also what a Control must report to be adopted.
    static func appOwner() -> ListenerOwner {
        let repoRoot = RepoLocator.repoRoot()
        let isCheckout = FileManager.default.fileExists(atPath: "\(repoRoot)/package.json")
        let bundle = Bundle.main.bundleURL
        return ListenerOwner(
            pid: getpid(),
            checkoutRoot: isCheckout ? repoRoot : nil,
            bundlePath: bundle.pathExtension == "app" ? bundle.path : nil
        )
    }
}

enum ShellCommand {
    static func npm(arguments: [String], in repoRoot: String) -> String {
        let command = (["npm"] + arguments).map(quote).joined(separator: " ")
        let pathExports = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "\(NSHomeDirectory())/.nvm/current/bin"
        ].joined(separator: ":")
        return [
            "export PATH=\(quote(pathExports)):$PATH",
            "export CONDUIT_PARENT_PID=\(quote(String(ProcessInfo.processInfo.processIdentifier)))",
            "export NVM_DIR=\"$HOME/.nvm\"",
            "[ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\"",
            "cd \(quote(repoRoot))",
            "exec \(command)"
        ].joined(separator: "; ")
    }

    private static func quote(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }
}

enum LogFiles {
    static let logDirectory = FileManager.default
        .urls(for: .libraryDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Logs/Conduit", isDirectory: true)

    static func openLogHandle(named name: String) throws -> FileHandle {
        try FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        let url = logDirectory.appendingPathComponent(name)
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        return handle
    }
}

enum RepoLocator {
    static func repoRoot() -> String {
        if let configured = ProcessInfo.processInfo.environment["CONDUIT_REPO_ROOT"], !configured.isEmpty {
            return configured
        }

        let bundleCandidate = Bundle.main.bundleURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .path
        if FileManager.default.fileExists(atPath: "\(bundleCandidate)/package.json") {
            return bundleCandidate
        }

        return FileManager.default.currentDirectoryPath
    }
}

/// Runs one Conduit CLI command to completion (bounded), outside the managed
/// services. Used by Stop all as the fallback when Control does not answer:
/// `conduit stop-all --local` writes the same pause + revoke to the state root,
/// so the kill switch never depends on Control being up (S1 `--local`).
enum ConduitCommand {
    static func run(arguments: [String], timeout: TimeInterval = 30, completion: @escaping (Int32?) -> Void) {
        let process = Process()
        let repoRoot = RepoLocator.repoRoot()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", ShellCommand.npm(arguments: arguments, in: repoRoot)]
        process.currentDirectoryURL = URL(fileURLWithPath: repoRoot)
        process.standardOutput = (try? LogFiles.openLogHandle(named: "menubar-commands.log")) ?? FileHandle.nullDevice
        process.standardError = process.standardOutput
        process.terminationHandler = { finished in
            DispatchQueue.main.async { completion(finished.terminationStatus) }
        }
        do {
            try process.run()
        } catch {
            completion(nil)
            return
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) {
            if process.isRunning {
                ProcessTree.terminateTree(of: process.processIdentifier)
            }
        }
    }
}
