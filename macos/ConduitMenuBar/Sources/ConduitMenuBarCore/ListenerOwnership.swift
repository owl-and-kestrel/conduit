import Darwin
import Foundation

// Which process holding one of Conduit's ports (47831 Control, 3333 agent
// listener) this app may stop before starting its own service there.
//
// Several Conduit checkouts (and an installed Conduit) can run on one Mac.
// The menu-bar app used to treat any `src/cli/index.ts listen` process as its
// own, so launching the app in /x/conduit terminated /x/conduit-fork's agent
// listener. A listener now counts as ours only when:
//   - it is a descendant of this app process (the app's own supervised tree), or
//   - it is a Conduit service (the CLI entry followed by the service's
//     subcommand) and, after resolving symlinks, its working directory is
//     exactly this app's checkout or bundle, or its executable is inside one
//     of them on a path component boundary (so /x/conduit-fork is not inside
//     /x/conduit, and a checkout nested in this one is not this one). This
//     covers a previous run of this checkout's app whose services have not
//     exited yet.
// Everything else is foreign and is never signalled; the app reports it. A
// listener whose working directory no longer resolves (its checkout was moved
// or deleted) is foreign. A pid that no longer exists is gone and is skipped.

/// The service a port belongs to.
public enum ConduitService: Equatable {
    /// `conduit app start --port 47831`.
    case control
    /// `conduit listen --project <root>` on 3333.
    case agentListener

    var subcommand: [String] {
        switch self {
        case .control: return ["app", "start"]
        case .agentListener: return ["listen"]
        }
    }
}

/// What the app knows about one process, read from the kernel. Empty or nil
/// fields mean "could not be read", never "matches".
public struct ProcessSnapshot: Equatable {
    public let pid: Int32
    /// Parent first, up to (not including) launchd.
    public let ancestors: [Int32]
    /// Symlink-resolved executable path.
    public let executablePath: String?
    /// Symlink-resolved working directory; nil when it no longer resolves.
    public let workingDirectory: String?
    public let arguments: [String]

    public init(
        pid: Int32,
        ancestors: [Int32] = [],
        executablePath: String? = nil,
        workingDirectory: String? = nil,
        arguments: [String] = []
    ) {
        self.pid = pid
        self.ancestors = ancestors
        self.executablePath = executablePath
        self.workingDirectory = workingDirectory
        self.arguments = arguments
    }

    /// One line for an error message: the pid, the executable's name and where
    /// it runs. Never includes the environment.
    public var summary: String {
        let name = executablePath.map { ($0 as NSString).lastPathComponent } ?? "unknown"
        let place = workingDirectory.map { " in \($0)" } ?? ""
        return "pid \(pid) (\(name)\(place))"
    }
}

/// This app's identity for ownership checks. Paths are resolved on init.
public struct ListenerOwner: Equatable {
    public let pid: Int32
    public let checkoutRoot: String?
    public let bundlePath: String?

    public init(pid: Int32, checkoutRoot: String?, bundlePath: String?) {
        self.pid = pid
        self.checkoutRoot = checkoutRoot.flatMap(ProcessProbe.resolvedPath)
        self.bundlePath = bundlePath.flatMap(ProcessProbe.resolvedPath)
    }

    /// Paths taken as given (tests use paths that do not exist).
    init(resolved pid: Int32, checkoutRoot: String?, bundlePath: String?) {
        self.pid = pid
        self.checkoutRoot = checkoutRoot
        self.bundlePath = bundlePath
    }
}

public enum ListenerOwnership: Equatable {
    public enum Reason: Equatable {
        case supervisedChild
        case thisCheckout
    }

    case ours(Reason)
    case foreign
    /// The process no longer exists. Nothing to stop.
    case gone

    public static func classify(
        _ snapshot: ProcessSnapshot?,
        service: ConduitService,
        owner: ListenerOwner
    ) -> ListenerOwnership {
        guard let snapshot else {
            return .gone
        }
        if snapshot.ancestors.contains(owner.pid) {
            return .ours(.supervisedChild)
        }
        // Outside the app's tree, the process must at least be this service:
        // a checkout directory can hold unrelated servers.
        guard isService(service, arguments: snapshot.arguments) else {
            return .foreign
        }
        let roots = [owner.checkoutRoot, owner.bundlePath].compactMap { $0 }
        // npm runs the service with the package root as its working
        // directory, so that must match exactly: a checkout nested inside
        // this one (a worktree, a scratch clone) is another checkout.
        if let directory = snapshot.workingDirectory, roots.contains(directory) {
            return .ours(.thisCheckout)
        }
        // A runtime shipped inside this checkout or bundle.
        if let executable = snapshot.executablePath, roots.contains(where: { isPath(executable, inside: $0) }) {
            return .ours(.thisCheckout)
        }
        return .foreign
    }

    /// True when the arguments run the Conduit CLI entry (source or built)
    /// with this service's subcommand right after it.
    public static func isService(_ service: ConduitService, arguments: [String]) -> Bool {
        let entries = ["src/cli/index.ts", "dist/src/cli/index.js"]
        for (index, argument) in arguments.enumerated()
        where entries.contains(where: { argument == $0 || argument.hasSuffix("/" + $0) }) {
            let rest = Array(arguments.dropFirst(index + 1))
            if rest.starts(with: service.subcommand) {
                return true
            }
        }
        return false
    }

    /// `path` is `root` or inside it, compared by whole path components.
    public static func isPath(_ path: String, inside root: String) -> Bool {
        let root = root.count > 1 && root.hasSuffix("/") ? String(root.dropLast()) : root
        guard !root.isEmpty, root != "/" else {
            return false
        }
        return path == root || path.hasPrefix(root + "/")
    }
}

/// Reads a `ProcessSnapshot` from the kernel (libproc and KERN_PROCARGS2). No
/// subprocesses. The environment is not read: CONDUIT_PARENT_PID would be a
/// natural owner mark, but macOS does not return another process's
/// environment through KERN_PROCARGS2 (checked 2026-10-18 on macOS 26: `ps -E`
/// shows none for the user's own processes), so ownership uses the process
/// tree and resolved paths instead.
public enum ProcessProbe {
    /// nil when no process has this pid. A process that exists but cannot be
    /// read (another user's) gets a snapshot with empty fields, so it is
    /// classified foreign rather than gone.
    public static func snapshot(pid: Int32) -> ProcessSnapshot? {
        guard pid > 0 else {
            return nil
        }
        guard let info = bsdInfo(pid) else {
            if kill(pid, 0) == 0 || errno == EPERM {
                return ProcessSnapshot(pid: pid)
            }
            return nil
        }
        return ProcessSnapshot(
            pid: pid,
            ancestors: ancestors(startingAt: Int32(bitPattern: info.pbi_ppid)),
            executablePath: executablePath(pid),
            workingDirectory: workingDirectory(pid),
            arguments: arguments(pid)
        )
    }

    /// realpath(3); nil when the path does not exist.
    public static func resolvedPath(_ path: String) -> String? {
        guard let resolved = realpath(path, nil) else {
            return nil
        }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    private static func bsdInfo(_ pid: Int32) -> proc_bsdinfo? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else {
            return nil
        }
        return info
    }

    private static func ancestors(startingAt parent: Int32) -> [Int32] {
        var chain: [Int32] = []
        var current = parent
        // Bounded: a pid chain is short, and a reused pid could in theory loop.
        while current > 1, chain.count < 64, !chain.contains(current) {
            chain.append(current)
            guard let info = bsdInfo(current) else {
                break
            }
            current = Int32(bitPattern: info.pbi_ppid)
        }
        return chain
    }

    private static func executablePath(_ pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else {
            return nil
        }
        return resolvedPath(String(cString: buffer))
    }

    private static func workingDirectory(_ pid: Int32) -> String? {
        var info = proc_vnodepathinfo()
        let size = Int32(MemoryLayout<proc_vnodepathinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, size) == size else {
            return nil
        }
        let path = withUnsafeBytes(of: &info.pvi_cdir.vip_path) { raw in
            String(cString: raw.bindMemory(to: CChar.self).baseAddress!)
        }
        return path.isEmpty ? nil : resolvedPath(path)
    }

    /// KERN_PROCARGS2: argc, the exec path, padding, then argv (the
    /// environment after it is not read).
    private static func arguments(_ pid: Int32) -> [String] {
        var mib: [Int32] = [CTL_KERN, KERN_ARGMAX]
        var argMax: Int32 = 0
        var size = MemoryLayout<Int32>.size
        guard sysctl(&mib, 2, &argMax, &size, nil, 0) == 0, argMax > 0 else {
            return []
        }
        var buffer = [UInt8](repeating: 0, count: Int(argMax))
        mib = [CTL_KERN, KERN_PROCARGS2, pid]
        size = buffer.count
        guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else {
            return []
        }
        let argc = Int(buffer.withUnsafeBytes { $0.load(as: Int32.self) })
        var index = MemoryLayout<Int32>.size
        func nextString() -> String? {
            guard index < size else {
                return nil
            }
            var end = index
            while end < size, buffer[end] != 0 { end += 1 }
            let value = String(decoding: buffer[index..<end], as: UTF8.self)
            index = end + 1
            return value
        }
        // Skip the exec path and the NUL padding after it.
        _ = nextString()
        while index < size, buffer[index] == 0 { index += 1 }
        var arguments: [String] = []
        while arguments.count < argc, let argument = nextString() {
            arguments.append(argument)
        }
        return arguments
    }
}
