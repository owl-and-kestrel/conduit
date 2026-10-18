import CryptoKit
import Foundation

// Signed-manifest updater (unchanged by S5/S6; moved out of main.swift).

struct UpdateManifest: Decodable {
    let schema: String
    let appId: String?
    let publisherId: String?
    let publisherDomain: String?
    let version: String
    let channel: String
    let releaseNotes: String?
    let publishedAt: String?
    let artifacts: [UpdateArtifact]
}

struct UpdateArtifact: Decodable {
    let platform: String
    let url: String
    let sha256: String?
    let sizeBytes: Int?
    let signature: String?
}

struct UpdateCheckResult {
    let isUpdateAvailable: Bool
    let message: String
    let manifest: UpdateManifest
    let artifact: UpdateArtifact?
    let verifiedPublisher: String?

    static func localPreviewMissingPinnedKey() -> UpdateCheckResult {
        UpdateCheckResult(
            isUpdateAvailable: false,
            message: [
                "This local Conduit build cannot verify signed O&K release manifests because it was built without the pinned release public key.",
                "",
                "That is normal for a local preview/dev build. Updates remain disabled here instead of installing anything unverifiable. Use a signed release build, or rebuild with CONDUIT_OK_PUBLISHER_PUBLIC_KEY_PEM, to enable update checks."
            ].joined(separator: "\n"),
            manifest: UpdateManifest(
                schema: "conduit.update-manifest.v1",
                appId: "conduit",
                publisherId: "owl-kestrel",
                publisherDomain: "owlandkestrel.com",
                version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.1",
                channel: "local-preview",
                releaseNotes: nil,
                publishedAt: nil,
                artifacts: []
            ),
            artifact: nil,
            verifiedPublisher: nil
        )
    }
}

struct SignedManifestEnvelope: Decodable {
    let schema: String
    let publisher: SignedManifestPublisher
    let signedPayload: String
    let signature: SignedManifestSignature
}

struct SignedManifestPublisher: Decodable {
    let id: String
    let name: String
    let domain: String
    let keyId: String
}

struct SignedManifestSignature: Decodable {
    let alg: String
    let value: String
}

enum Base64URL {
    static func decode(_ text: String) throws -> Data {
        var normalized = text
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = (4 - normalized.count % 4) % 4
        normalized.append(String(repeating: "=", count: padding))
        guard let data = Data(base64Encoded: normalized) else {
            throw AppError("Invalid base64url data in signed manifest.")
        }
        return data
    }
}

enum ShellEscaper {
    static func quote(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }
}

final class UpdateChecker {
    private var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.1"
    }
    private var trustedPublisherID: String {
        Bundle.main.object(forInfoDictionaryKey: "ConduitOKPublisherID") as? String ?? "owl-kestrel"
    }
    private var trustedPublisherDomain: String {
        Bundle.main.object(forInfoDictionaryKey: "ConduitOKPublisherDomain") as? String ?? "owlandkestrel.com"
    }
    private var trustedPublisherKeyID: String {
        Bundle.main.object(forInfoDictionaryKey: "ConduitOKPublisherKeyID") as? String ?? "ok-release-p256-v1"
    }
    private var trustedPublisherPublicKeyPEM: String? {
        guard let pem = Bundle.main.object(forInfoDictionaryKey: "ConduitOKPublisherPublicKeyPEM") as? String,
              !pem.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return pem
    }

    func check() async throws -> UpdateCheckResult {
        let loaded = try await loadManifest()
        let manifest = loaded.manifest
        let artifact = manifest.artifacts.first { $0.platform == "macos-universal" || $0.platform == "macos-arm64" || $0.platform == "macos" }
        let updateAvailable = compareVersions(manifest.version, currentVersion) == .orderedDescending
        let signatureState = loaded.verifiedPublisher.map { "Verified publisher: \($0)." } ?? "Unsigned local preview manifest."
        let notes = manifest.releaseNotes ?? "No release notes."
        let message = updateAvailable
            ? "Version \(manifest.version) is available on \(manifest.channel). \(signatureState)\n\n\(notes)"
            : "Current version \(currentVersion) is at least as new as \(manifest.version). \(signatureState)"

        return UpdateCheckResult(
            isUpdateAvailable: updateAvailable,
            message: message,
            manifest: manifest,
            artifact: artifact,
            verifiedPublisher: loaded.verifiedPublisher
        )
    }

    func install(result: UpdateCheckResult) async throws {
        guard result.isUpdateAvailable else {
            throw AppError("No newer Conduit version is available.")
        }
        guard result.verifiedPublisher != nil else {
            throw AppError("Refusing to install an update from an unsigned manifest.")
        }
        guard let artifact = result.artifact, let downloadURL = URL(string: artifact.url) else {
            throw AppError("The update manifest does not include a usable macOS artifact URL.")
        }
        guard let expectedSha256 = artifact.sha256, expectedSha256.range(of: #"^[0-9a-fA-F]{64}$"#, options: .regularExpression) != nil else {
            throw AppError("The update artifact is missing a valid SHA-256 digest.")
        }

        let downloaded = try await downloadArtifact(from: downloadURL)
        let actualSha256 = try sha256Hex(of: downloaded)
        guard actualSha256.caseInsensitiveCompare(expectedSha256) == .orderedSame else {
            throw AppError("Downloaded update hash did not match the signed manifest.")
        }

        let helper = try writeInstallHelper(dmgURL: downloaded)
        try launchInstallHelper(helper)
    }

    private func loadManifest() async throws -> (manifest: UpdateManifest, verifiedPublisher: String?) {
        let manifestURL = resolvedManifestURL()
        if manifestURL.isFileURL {
            let data = try Data(contentsOf: manifestURL)
            return try decodeManifest(data)
        }

        let (data, _) = try await URLSession.shared.data(from: manifestURL)
        return try decodeManifest(data)
    }

    private func decodeManifest(_ data: Data) throws -> (manifest: UpdateManifest, verifiedPublisher: String?) {
        if let envelope = try? JSONDecoder().decode(SignedManifestEnvelope.self, from: data),
           envelope.schema == "ok.signed-manifest.v1" {
            return try verifySignedManifest(envelope)
        }
        return (try JSONDecoder().decode(UpdateManifest.self, from: data), nil)
    }

    private func verifySignedManifest(_ envelope: SignedManifestEnvelope) throws -> (manifest: UpdateManifest, verifiedPublisher: String?) {
        guard envelope.publisher.id == trustedPublisherID,
              envelope.publisher.domain == trustedPublisherDomain,
              envelope.publisher.keyId == trustedPublisherKeyID else {
            throw AppError("The update manifest publisher is not trusted by this Conduit build.")
        }
        guard envelope.signature.alg == "ECDSA_P256_SHA256_DER" else {
            throw AppError("Unsupported update manifest signature algorithm: \(envelope.signature.alg).")
        }
        guard let pem = trustedPublisherPublicKeyPEM else {
            throw AppError("This Conduit build does not include a pinned O&K release public key.")
        }
        let payload = try Base64URL.decode(envelope.signedPayload)
        let signatureData = try Base64URL.decode(envelope.signature.value)
        let publicKey = try P256.Signing.PublicKey(pemRepresentation: pem)
        let signature = try P256.Signing.ECDSASignature(derRepresentation: signatureData)
        guard publicKey.isValidSignature(signature, for: payload) else {
            throw AppError("The update manifest signature is invalid.")
        }
        let manifest = try JSONDecoder().decode(UpdateManifest.self, from: payload)
        guard manifest.appId == nil || manifest.appId == "conduit" else {
            throw AppError("The signed manifest is not for Conduit.")
        }
        guard manifest.publisherId == nil || manifest.publisherId == envelope.publisher.id else {
            throw AppError("The signed manifest publisher does not match the envelope.")
        }
        guard manifest.publisherDomain == nil || manifest.publisherDomain == envelope.publisher.domain else {
            throw AppError("The signed manifest publisher domain does not match the envelope.")
        }
        return (manifest, "\(envelope.publisher.name) (\(envelope.publisher.domain))")
    }

    private func resolvedManifestURL() -> URL {
        if let configured = ProcessInfo.processInfo.environment["CONDUIT_UPDATE_MANIFEST_URL"],
           let url = URL(string: configured) {
            return url
        }

        let localManifest = URL(fileURLWithPath: RepoLocator.repoRoot())
            .appendingPathComponent("dist/macos/conduit-appcast.json")
        if FileManager.default.fileExists(atPath: localManifest.path) {
            return localManifest
        }

        if let url = URL(string: "https://owlandkestrel.com/releases/conduit/appcast.json") {
            return url
        }

        let previewManifest = URL(fileURLWithPath: RepoLocator.repoRoot())
            .appendingPathComponent("website/releases/conduit-appcast.json")
        return previewManifest
    }

    private func downloadArtifact(from url: URL) async throws -> URL {
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("Conduit-\(UUID().uuidString).dmg")
        if url.isFileURL {
            try FileManager.default.copyItem(at: url, to: destination)
            return destination
        }
        let (downloaded, response) = try await URLSession.shared.download(from: url)
        guard (response as? HTTPURLResponse)?.statusCode ?? 200 < 400 else {
            throw AppError("The update artifact could not be downloaded.")
        }
        try FileManager.default.moveItem(at: downloaded, to: destination)
        return destination
    }

    private func sha256Hex(of fileURL: URL) throws -> String {
        let data = try Data(contentsOf: fileURL)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func writeInstallHelper(dmgURL: URL) throws -> URL {
        let currentBundle = Bundle.main.bundleURL
        guard currentBundle.pathExtension == "app" else {
            throw AppError("Conduit is not running from an app bundle.")
        }
        let helperURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("conduit-update-\(UUID().uuidString).sh")
        let script = """
        #!/usr/bin/env bash
        set -euo pipefail
        DMG_PATH=\(ShellEscaper.quote(dmgURL.path))
        APP_PATH=\(ShellEscaper.quote(currentBundle.path))
        CURRENT_PID=\(getpid())
        LOG_DIR="$HOME/Library/Logs/Conduit"
        LOG_FILE="$LOG_DIR/update-helper.log"
        mkdir -p "$LOG_DIR"
        exec >>"$LOG_FILE" 2>&1
        echo "Starting Conduit update helper at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
        while /bin/kill -0 "$CURRENT_PID" >/dev/null 2>&1; do
          /bin/sleep 0.2
        done
        MOUNT_OUTPUT="$(/usr/bin/hdiutil attach "$DMG_PATH" -nobrowse -readonly)"
        MOUNT_POINT="$(printf '%s\\n' "$MOUNT_OUTPUT" | /usr/bin/awk '/\\/Volumes\\// { for (i=1; i<=NF; i++) if ($i ~ /^\\/Volumes\\//) { print $i; exit } }')"
        if [[ -z "$MOUNT_POINT" ]]; then
          echo "Could not determine mounted DMG path."
          exit 1
        fi
        trap '/usr/bin/hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1 || true' EXIT
        if [[ ! -d "$MOUNT_POINT/Conduit.app" ]]; then
          echo "Mounted DMG did not contain Conduit.app."
          exit 1
        fi
        BACKUP_PATH="${APP_PATH}.previous"
        /bin/rm -rf "$BACKUP_PATH"
        if [[ -d "$APP_PATH" ]]; then
          /bin/mv "$APP_PATH" "$BACKUP_PATH"
        fi
        /usr/bin/ditto "$MOUNT_POINT/Conduit.app" "$APP_PATH"
        /bin/rm -rf "$BACKUP_PATH"
        /usr/bin/open -n "$APP_PATH"
        echo "Conduit update complete."
        """
        try script.write(to: helperURL, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helperURL.path)
        return helperURL
    }

    private func launchInstallHelper(_ helperURL: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = [helperURL.path]
        try process.run()
    }

    private func compareVersions(_ lhs: String, _ rhs: String) -> ComparisonResult {
        let left = lhs.split(separator: ".").map { Int($0) ?? 0 }
        let right = rhs.split(separator: ".").map { Int($0) ?? 0 }
        let count = max(left.count, right.count)
        for index in 0..<count {
            let a = index < left.count ? left[index] : 0
            let b = index < right.count ? right[index] : 0
            if a > b { return .orderedDescending }
            if a < b { return .orderedAscending }
        }
        return .orderedSame
    }
}
