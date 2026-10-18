// swift-tools-version: 5.9
import PackageDescription

// ConduitMenuBarCore holds everything that can be decided without AppKit: the
// Control API models and client, the status-item state reducer, the Allow-once
// eligibility rule, 409 messages and the popover key bindings. The app target
// is the AppKit/SwiftUI shell and process supervisor around it. Tests cover the
// core only (spec menu-bar-first S5/S6).
let package = Package(
    name: "ConduitMenuBar",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "ConduitMenuBar", targets: ["ConduitMenuBar"])
    ],
    targets: [
        .target(
            name: "ConduitMenuBarCore",
            path: "Sources/ConduitMenuBarCore"
        ),
        .executableTarget(
            name: "ConduitMenuBar",
            dependencies: ["ConduitMenuBarCore"],
            path: "Sources/ConduitMenuBar"
        ),
        .testTarget(
            name: "ConduitMenuBarCoreTests",
            dependencies: ["ConduitMenuBarCore"],
            path: "Tests/ConduitMenuBarCoreTests"
        )
    ]
)
