import Darwin
import Foundation

/// The global pause flag read straight from the state root, for when Control
/// does not answer. `conduit pause --local` writes the same `control.json`
/// that Control and every execution path read (src/state/pause-state.ts), so
/// a pause made while Control is down is still known and must still show as
/// Paused.
///
/// The rules mirror `getPauseState()`: a missing file means not paused; a
/// file that exists but cannot be read, is not a regular file, or has no
/// boolean `paused` field means paused (fail closed), shown as unreadable.
public struct LocalPauseState: Equatable {
    public let paused: Bool
    public let detail: PauseDetail?

    public init(paused: Bool, detail: PauseDetail? = nil) {
        self.paused = paused
        self.detail = detail
    }

    static let notPaused = LocalPauseState(paused: false)
    static let unreadable = LocalPauseState(paused: true, detail: PauseDetail(unreadable: true))
}

public enum LocalPause {
    /// Larger than any real control.json by orders of magnitude. The harm the
    /// cap prevents: this is read on the main thread on every poll while
    /// Control is down, and a huge file there would stall the menu bar.
    static let maxBytes = 64 * 1024

    /// `CONDUIT_STATE_DIR`, else `~/.conduit`, as src/state/paths.ts resolves
    /// it. An empty `CONDUIT_STATE_DIR` is used as given there (`??`), which
    /// makes the path relative to the CLI's working directory, the checkout.
    public static func stateRoot(environment: [String: String], home: String, workingDirectory: String) -> String {
        guard let configured = environment["CONDUIT_STATE_DIR"] else {
            return (home as NSString).appendingPathComponent(".conduit")
        }
        if configured.hasPrefix("/") {
            return configured
        }
        return (workingDirectory as NSString).appendingPathComponent(configured)
    }

    public static func flagPath(stateRoot: String) -> String {
        (stateRoot as NSString).appendingPathComponent("control.json")
    }

    /// Never blocks: opened non-blocking and checked to be a regular file
    /// before reading, so a FIFO or device planted at the path cannot hang the
    /// menu bar.
    public static func read(path: String) -> LocalPauseState {
        let fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else {
            return errno == ENOENT ? .notPaused : .unreadable
        }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= maxBytes else {
            return .unreadable
        }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while data.count <= maxBytes {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count == 0 {
                break
            }
            guard count > 0 else {
                return .unreadable
            }
            data.append(contentsOf: buffer[0..<count])
        }
        return parse(data)
    }

    static func parse(_ data: Data) -> LocalPauseState {
        guard data.count <= maxBytes,
              let object = try? JSONSerialization.jsonObject(with: data),
              let fields = object as? [String: Any],
              let flag = fields["paused"] as? NSNumber,
              CFGetTypeID(flag) == CFBooleanGetTypeID()
        else {
            return .unreadable
        }
        guard flag.boolValue else {
            return .notPaused
        }
        return LocalPauseState(paused: true, detail: PauseDetail(
            pausedAt: fields["pausedAt"] as? String,
            pausedBy: fields["pausedBy"] as? String,
            reason: fields["reason"] as? String
        ))
    }
}
