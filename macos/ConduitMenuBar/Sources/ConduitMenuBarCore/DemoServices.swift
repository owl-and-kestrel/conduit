import Foundation

// Demo profile only (S4). Everything here is inert unless Control reports
// `capabilities.demoProfile == true`; nothing in this file calls Control on
// its own and no assumption below loosens a default.

/// `capabilities.demoProfile` on `GET /api/status`: true only when Control
/// says so. An older Control (field absent) keeps every demo surface off.
public enum DemoProfile {
    public static func isOn(_ status: ControlStatusResponse?) -> Bool {
        status?.capabilities.demoProfile == true
    }
}

/// A `conduit.review` ask that starts services, reduced to what the demo
/// surface shows and decides on. Built only when the demo profile is on.
public struct ServiceAsk: Equatable {
    /// Human names of the programs that would start (`args.name`, "service"
    /// when Control did not send one).
    public let serviceNames: [String]
    /// `args.package.sha256` of each start, when it is 64 lowercase hex.
    public let packageDigests: [String]
    /// Path-form `args.sha256` of each start, when it is 64 lowercase hex.
    public let pathDigests: [String]
    /// True when any start asked to accept connections from the local network.
    public let acceptsLocalNetwork: Bool
    /// True when every requested action is a `service.start` that names an
    /// exact package: digest and package URL present. This mirrors the
    /// server's packageOnlyDigests, which decides if "Always allow this exact
    /// package" is offered.
    public let packageOnly: Bool
    public let requester: String

    public var offersAlwaysAllow: Bool { packageOnly }

    public init(
        serviceNames: [String],
        packageDigests: [String],
        pathDigests: [String],
        acceptsLocalNetwork: Bool,
        packageOnly: Bool,
        requester: String
    ) {
        self.serviceNames = serviceNames
        self.packageDigests = packageDigests
        self.pathDigests = pathDigests
        self.acceptsLocalNetwork = acceptsLocalNetwork
        self.packageOnly = packageOnly
        self.requester = requester
    }

    public static func make(for approval: ApprovalSummary, demoProfile: Bool) -> ServiceAsk? {
        guard demoProfile, approval.isReview else { return nil }
        let starts = (approval.action.args?.actions ?? []).filter { $0.tool == "service.start" }
        guard !starts.isEmpty else { return nil }

        let serviceNames = starts.map { $0.args?.name ?? "service" }
        // Each digest once, in request order: two starts of the same package
        // pin the same bytes, and the UI lists digests by value (review G-02).
        let packageDigests = unique(starts.compactMap { $0.args?.package?.sha256 }.filter(isSha256Digest))
        let pathDigests = unique(starts.compactMap { $0.args?.sha256 }.filter(isSha256Digest))
        let acceptsLocalNetwork = starts.contains { $0.args?.lan == true }

        let actions = approval.action.args?.actions ?? []
        let packageOnly = actions.allSatisfy { $0.tool == "service.start" }
            && starts.allSatisfy { start in
                guard let sha = start.args?.package?.sha256, isSha256Digest(sha) else { return false }
                guard let url = start.args?.package?.url, !url.isEmpty else { return false }
                return true
            }

        return ServiceAsk(
            serviceNames: serviceNames,
            packageDigests: packageDigests,
            pathDigests: pathDigests,
            acceptsLocalNetwork: acceptsLocalNetwork,
            packageOnly: packageOnly,
            requester: AskPresentation.source(for: approval)
        )
    }

    static func unique(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }

    /// The first 12 hex digits of a digest, for one line of UI.
    public static func shortDigest(_ sha: String) -> String {
        String(sha.prefix(12))
    }

    public static func isSha256Digest(_ value: String) -> Bool {
        value.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil
    }

    public static let localNetworkDisclosure = "This program asks to accept connections from your local network. Other devices on this network may be able to reach it while it runs."
    public static let runsCodeNotice = "Allowing runs this program on this Mac. Conduit shows what will run and pins its exact bytes; it does not check what the program does."
}

/// One row of the popover's Services list (demo profile).
public struct RunningServiceRow: Equatable, Identifiable {
    public let id: String
    public let name: String
    /// The service URL, else "port N", else "".
    public let address: String
    public let state: String
    /// Time since the service became ready (or started), e.g. "1m 30s"; ""
    /// when Control gave no usable timestamp.
    public let uptime: String

    public init(id: String, name: String, address: String, state: String, uptime: String) {
        self.id = id
        self.name = name
        self.address = address
        self.state = state
        self.uptime = uptime
    }

    public static func rows(_ services: [ServiceSummary], now: Date) -> [RunningServiceRow] {
        let live = ["starting", "ready", "stopping"]
        return services.filter { live.contains($0.state) }.map { summary in
            let address: String
            if let url = summary.url, !url.isEmpty {
                address = url
            } else if let port = summary.port {
                address = "port \(port)"
            } else {
                address = ""
            }
            return RunningServiceRow(
                id: summary.serviceId,
                name: summary.name,
                address: address,
                state: summary.state,
                uptime: uptime(of: summary, now: now)
            )
        }
    }

    private static func uptime(of summary: ServiceSummary, now: Date) -> String {
        guard let stamp = summary.readyAt ?? summary.startedAt,
              let started = ServiceTimestamp.parse(stamp)
        else { return "" }
        let seconds = max(0, Int(now.timeIntervalSince(started)))
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m \(seconds % 60)s" }
        return "\(seconds / 3600)h \((seconds % 3600) / 60)m"
    }
}

enum ServiceTimestamp {
    static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    static let plain = ISO8601DateFormatter()

    /// Control stamps use `2026-10-18T06:00:00.000Z`; the plain form is the
    /// fallback for older responses.
    static func parse(_ value: String) -> Date? {
        fractional.date(from: value) ?? plain.date(from: value)
    }
}

/// Which ready services the menu bar may open in a browser (demo profile).
///
/// The menu bar opens a browser only for services that were started by a
/// request a person allowed from this app in this session, or by a
/// `conduit://` link this app handed to Control in this session; never for
/// services started elsewhere (CLI, agents, before launch), and never a
/// non-loopback URL.
///
/// `track(runId:)` = this app allowed the run (an approve here, or a conduit://
/// open it handed over). Value type: the tracker is owned and copied per
/// session, so nothing outside the session decides.
public struct BrowserOpenTracker: Equatable {
    public private(set) var trackedRunIds: Set<String> = []
    public private(set) var openedServiceIds: Set<String> = []

    public init() {}

    public mutating func track(runId: String) {
        trackedRunIds.insert(runId)
    }

    /// The tracked services that are ready, not yet opened, and reachable only
    /// on loopback; marks them opened.
    public mutating func servicesToOpen(_ services: [ServiceSummary]) -> [ServiceSummary] {
        let toOpen = services.filter { service in
            guard let runId = service.runId else { return false }
            guard trackedRunIds.contains(runId) else { return false }
            guard service.state == "ready" else { return false }
            guard !openedServiceIds.contains(service.serviceId) else { return false }
            guard let url = service.url, Self.isLoopbackHTTP(url) else { return false }
            return true
        }
        openedServiceIds.formUnion(toOpen.map { $0.serviceId })
        return toOpen
    }

    /// A URL that points at this Mac only: `http://127.0.0.1/...` or
    /// `http://localhost/...`. Anything else (other hosts, https, other
    /// schemes) is never auto-opened.
    static func isLoopbackHTTP(_ value: String) -> Bool {
        guard let url = URL(string: value), url.scheme == "http" else { return false }
        return url.host == "127.0.0.1" || url.host == "localhost"
    }
}
