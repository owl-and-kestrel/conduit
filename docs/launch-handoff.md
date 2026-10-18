# Conduit Launch Handoff

This document is the operator handoff for getting Conduit from the current
source checkout to an alpha users can download, install, update, and extend.

## Launch Definition

v0 is useful when a user can:

1. Download and install the macOS app.
2. Launch Conduit from the menu bar.
3. Copy or open a Conduit request.
4. Review the requested local action.
5. Approve once or use a trusted session.
6. See the result locally.
7. Receive future app updates with minimal friction.

The browser extension is optional for v0. Clipboard-only use must keep working
without it. The extension improves the ChatGPT loop, presentation, and retry
flow, but should not be required for the core promise.

## Current Launchable Surface

The macOS app is the primary v0 install:

- `npm run macos:package` creates `dist/macos/Conduit.dmg`.
- The DMG includes `Conduit.app`, an Applications shortcut, release notes, and
  first-launch guidance.
- The menu-bar app supervises the control panel, extension listener, and
  clipboard daemon.
- Conduit Control exposes sessions, approvals, runs, diagnostics, bridge health,
  outbound retry, copy-agent-handshake, and Download Extension.
- `conduit://run?payload=...` links are registered by the macOS bundle and
  routed through the same local review/approval path as other Conduit requests.

The update path is also v0-critical:

- Conduit checks `https://owlandkestrel.com/releases/conduit/appcast.json`.
- Launch builds should sign the appcast as `ok.signed-manifest.v1`.
- The app pins O&K publisher metadata in its bundle.
- Verified updates are downloaded, hash-checked, installed over the existing app,
  and relaunched.
- Unsigned local appcasts remain preview-only; replacement install refuses them.

The extension alpha path is dogfooded:

- `npm run extension:package` creates
  `dist/extension/conduit-bridge-extension.zip`.
- The O&K route
  `https://owlandkestrel.com/releases/conduit/conduit-bridge-extension.zip`
  should redirect to the current ZIP.
- The public download page and Conduit Control expose Conduit links that request
  `conduit.extension.prepareAlphaInstall`.
- The tool prepares `~/Downloads/Conduit/conduit-bridge-extension`, opens
  `chrome://extensions/`, and leaves the final Load unpacked step to the user.

## Human Intervention

Before alpha distribution:

1. Buy or configure the Apple Developer account if we want signed/notarized DMGs.
   Unsigned preview DMGs can work for alpha, but users may need right-click Open.
2. Generate and protect the O&K release signing key:
   - public key goes into Conduit launch builds via
     `CONDUIT_OK_PUBLISHER_PUBLIC_KEY_PEM`
   - private key is supplied only to release packaging as
     `OK_RELEASE_PRIVATE_KEY_PEM`
3. Publish the DMG and extension ZIP somewhere stable.
4. Register the Conduit release in the O&K trust registry:
   - product: `conduit`
   - channel: `stable` for public alpha, or `alpha` if the audience is gated
   - manifest URL and SHA-256
   - DMG artifact URL and SHA-256
   - extension ZIP URL and SHA-256 when present
   - O&K release key id and public key metadata
5. Deploy O&K after the trust record exists.
6. Confirm compatibility routes resolve through the trust registry:
   - `https://owlandkestrel.com/releases/conduit/appcast.json`
   - `https://owlandkestrel.com/releases/conduit/conduit-bridge-extension.zip`
7. Install the generated `Conduit.app` once on a local machine and verify macOS
   registers `conduit://`.
8. Buy/configure the Google Chrome Web Store developer account when ready.
   Until then, the extension uses the developer-mode dirty install path.

Later, for the Web Store path:

- Create an unlisted Chrome Web Store item.
- Package and upload the extension through the store flow.
- Update Conduit docs/UI from developer-mode Load unpacked to direct store link.
- Keep the Conduit link as a fallback or diagnostic path.

## Release Checklist

Run from the repository root:

```txt
npm install
npm run build
npm test
npm run macos:build
npm run extension:package
```

For a local preview DMG:

```txt
npm run macos:package
```

For a launch appcast, provide hosted artifact URLs and the O&K signing key:

```txt
CONDUIT_RELEASE_BASE_URL="https://example.test/conduit/v0.0.1" \
OK_RELEASE_PRIVATE_KEY_PEM="$OK_RELEASE_PRIVATE_KEY_PEM" \
npm run macos:package
```

Expected outputs:

- `dist/macos/Conduit.dmg`
- `dist/macos/Conduit.dmg.sha256`
- `dist/macos/conduit-appcast.payload.json`
- `dist/macos/conduit-appcast.json`
- `dist/macos/RELEASE_NOTES.txt`
- `dist/extension/conduit-bridge-extension.zip`

After publishing:

1. Confirm the O&K appcast URL returns the signed manifest.
2. Confirm the O&K extension URL returns the ZIP.
3. Install the DMG.
4. Launch Conduit.
5. Open Conduit Control.
6. Click Download Extension and approve the review.
7. Confirm the extension folder appears under `~/Downloads/Conduit`.
8. Use Check for Updates from the menu-bar app against a newer test manifest.

## O&K Contract

Conduit should consume O&K affordances instead of growing parallel account,
payment, publisher, or entitlement systems.

For v0, O&K owns:

- canonical domain: `owlandkestrel.com`
- verified publisher identity: Owl & Kestrel
- trust API and release compatibility routes
- future account/payment/publisher registry rails

For Conduit specifically:

- `/api/trust/v1/products/conduit/channels/stable` is the canonical release
  lookup for machines and admin tooling.
- `/releases/conduit/appcast.json` is a compatibility route for the current
  signed appcast.
- `/releases/conduit/conduit-bridge-extension.zip` is a compatibility route for
  the current developer-mode extension ZIP.
- Conduit can say "verified publisher" and "unchanged since signing"; it should
  not say "secure" or imply code safety from identity verification alone.

## Gotchas

- `conduit://` support is a bundle registration issue as well as a Swift issue.
  The generated `Info.plist` in `script/build_and_run.sh` must keep
  `CFBundleURLTypes`.
- A `conduit://` URL carries base64url JSON in `payload`. It is not clipboard
  text and should not be forced through exact-envelope clipboard parsing.
- Very large URL payloads may hit browser or OS URL-length limits. Keep link
  payloads small; future rich links should point at signed manifests instead.
- Approve-once for untrusted requests runs under a constrained read-only policy
  session. The extension-prep tool is allowed there because it is narrow and
  host-restricted, not because arbitrary local installs are okay.
- `conduit.extension.prepareAlphaInstall` trusts approved HTTPS hosts by
  default. Local `file://` packages require
  `CONDUIT_ALLOW_FILE_EXTENSION_PACKAGES=1` and are for dev/test only.
- The extension cannot be silently installed by the desktop app. Chrome/Brave
  still require the user to enable Developer mode and choose Load unpacked for
  this alpha path.
- The app updater installs only verified signed manifests. Raw local appcasts are
  useful for preview checks but intentionally cannot replace the app.
- The update helper expects a DMG containing `Conduit.app` at the mounted volume
  root.
- Do not treat a successful signature as a security audit. v1 publisher registry
  and trusted snippet work can prove authorship/integrity; it does not prove
  code is harmless.
- Diagnostics must remain redacted by default. Do not attach clipboard contents,
  request payloads, nonces, env vars, API keys, or file contents silently.

## Recommended v0 Launch Bar

Ship when these are true:

- `npm test` passes.
- macOS preview DMG installs on a clean-ish machine.
- `conduit://` opens Conduit and creates a local review.
- Clipboard exact-envelope path still works without the extension.
- Download Extension prepares the unpacked extension folder.
- The extension can pair with a real ChatGPT tab through Copy Agent Handshake.
- Update check sees an O&K signed manifest and can install a newer test build.
- Bug Report shows a redacted diagnostic bundle.
- O&K release redirects are configured in production.

## Recommended Next Slices

Highest leverage before a public alpha:

1. Signing/notarization pass for macOS, or an explicit "unsigned alpha" stance.
2. A tiny release script that builds, packages, signs appcast, packages extension,
   and prints the O&K env values/artifacts to publish.
3. Smoke script for the v0 happy path:
   - install/open app
   - open `conduit://` extension link
   - approve once
   - check prepared folder
4. Download page hosted from O&K or linked cleanly from the O&K app profile.
5. Chrome Web Store unlisted extension listing.
6. First v1 registry spike: O&K-only signed manifests generalized into a
   publisher/app/snippet registry contract.
7. Clipboard secret intake:
   - recognize a narrow `conduit:key//...` envelope that means "store this
     secret," never "run arbitrary clipboard text"
   - validate provider-specific tokens before saving them, starting with Vercel
     deploy tokens for O&K projects
   - store secret metadata as provider, account/team, target project, validated
     capabilities, aliases, and last verification result
   - rewrite the clipboard to a non-secret reference such as
     `conduit:secret//provider/account/target`
   - resolve later workflows by provider + capability + target, not by brittle
     alias alone, so failures explain whether no token, multiple tokens, or an
     unverified token blocked the action
   - keep raw secret material out of run logs, diagnostic bundles, result
     clipboard text, and protocol repair output
