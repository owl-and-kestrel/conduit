import Foundation

// Whether the menu-bar app may use the Conduit Control answering on 47831.
//
// Every Conduit checkout (and an installed Conduit) uses port 47831. At launch
// the app used to adopt any Control already listening there as "started
// outside this app", including one from a sibling checkout: the app in
// /x/conduit then showed, approved and denied /x/conduit-fork's asks. Control
// now reports the checkout its code runs from (`identity.checkoutRoot` on
// `GET /api/status`, src/app/control-identity.ts), and the app adopts only a
// Control that reports its own checkout:
//   - thisCheckout: adopted, used as before.
//   - otherCheckout: never adopted. The app reads nothing else from it, shows
//     who holds the port, and leaves it running.
//   - unverified: a Control from before the field existed (or this app has no
//     checkout to compare). Not adopted; treated like a stale Control, which
//     Restart services replaces only when the listener process is this
//     checkout's (ListenerOwnership) and otherwise reports.
// The port scheme is unchanged.

public enum ControlAdoption: Equatable {
    /// Nothing answered `/api/status`.
    case noAnswer
    case thisCheckout
    /// The Control reports this checkout root, which is not the app's.
    case otherCheckout(reportedRoot: String)
    case unverified

    /// - Parameters:
    ///   - appCheckoutRoot: the app's checkout, nil when it has none.
    ///   - resolve: canonicalises both paths (realpath by default; nil keeps
    ///     the path as given, e.g. a root that no longer exists).
    public static func evaluate(
        _ status: ControlStatusResponse?,
        appCheckoutRoot: String?,
        resolve: (String) -> String? = ProcessProbe.resolvedPath
    ) -> ControlAdoption {
        guard let status else {
            return .noAnswer
        }
        guard let reported = status.identity?.checkoutRoot, !reported.isEmpty else {
            return .unverified
        }
        guard let appCheckoutRoot, !appCheckoutRoot.isEmpty else {
            return .unverified
        }
        let same = (resolve(reported) ?? reported) == (resolve(appCheckoutRoot) ?? appCheckoutRoot)
        return same ? .thisCheckout : .otherCheckout(reportedRoot: reported)
    }

    /// Only a Control that reports this checkout is used.
    public var adopted: Bool {
        self == .thisCheckout
    }
}
