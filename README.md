# Conduit Runtime

Conduit is a local control plane for consent-shaped agent execution.

The core use case is deliberately humble: when a chat model says "paste this in
your terminal and run it," Conduit gives it a structured, policy-checked way to
ask the local machine for the same work instead.

Conduit is not a ChatGPT wrapper, not an auth bypass, and not a magic sandbox.
It is a local runtime plus transports:

- a macOS menu-bar app that supervises the local services
- an exact-envelope clipboard daemon for compliance-mode execution
- a browser-extension bridge for paired ChatGPT agent loops
- a local control panel for sessions, starter envelopes, clipboard checks, and
  handshake generation
- shared approval requests for write, patch, and shell actions
- a TypeScript CLI/runtime with policy-routed local tools

## Quick Start

```txt
npm install
npm test
npm run build
npm run macos:run
```

`npm run macos:run` builds and launches `dist/macos/Conduit.app`. The menu-bar
app starts three supervised child services by default:

- control panel: `http://127.0.0.1:47831`
- browser-extension agent listener: `http://127.0.0.1:3333`
- clipboard watcher daemon

On confirmed quit, the menu-bar app stops the supervised children. The child
services also have a deadman switch: if the parent app disappears, they exit
instead of continuing autonomous execution in the background.

To build a drag-to-install preview DMG:

```txt
npm run macos:package
```

That creates `dist/macos/Conduit.dmg` and
`dist/macos/Conduit.dmg.sha256`, plus `dist/macos/conduit-appcast.json` and
`dist/macos/RELEASE_NOTES.txt` for the download page and update checker. The DMG
contains `Conduit.app`, an `Applications` shortcut, and first-launch notes. This
preview package is not signed or notarized, so macOS may require right-click
**Open** on first launch.
If `dist/macos/Conduit.app` is already staged and SwiftPM is temporarily broken,
`npm run macos:package -- --skip-build` packages the existing app bundle.

Release metadata can be pointed at hosted artifacts without changing the local
build:

```txt
CONDUIT_RELEASE_BASE_URL="https://github.com/owl-and-kestrel/conduit/releases/download/v0.0.1" npm run macos:package
```

For launch builds, O&K owns the signed release channel. Provide
`OK_RELEASE_PRIVATE_KEY_PEM` when packaging to wrap the Conduit appcast in an
`ok.signed-manifest.v1` envelope. The menu-bar app pins the O&K publisher
identity from the app bundle, verifies the signed manifest, verifies the DMG
SHA-256, then installs the update in place and relaunches Conduit. Unsigned local
manifests remain useful for preview checks, but the installer refuses to replace
the app from an unsigned manifest.

## Common Commands

```txt
npm run doctor
npm run app
npm run listen
npm run spike
npm run site:dev
npm run eval:protocol
npm run macos:build
npm run macos:run
npm run macos:package
npm run extension:package
npm run windows:package
npm run linux:package
npm run conduit -- session list
npm run conduit -- daemon once
npm run conduit -- daemon start
```

`npm run spike` runs the fake transport against `fixtures/fake-project`.

`npm run site:dev` serves the static web presence at
`http://127.0.0.1:47832`.

The package also keeps the older Playwright login helpers around for debugging:

```txt
npm run login
npm run login:system
npm run login:chrome
npm run login:chromium
```

The durable v0 browser path is the extension bridge, not Playwright-controlled
ChatGPT. Human auth happens in the user's normal browser.

For release operations, human setup steps, and launch gotchas, see
[docs/launch-handoff.md](docs/launch-handoff.md).

## Protocol Model Evals

Conduit includes a live eval harness for checking whether small models can emit
valid compact protocol requests. It is opt-in and never runs during normal
tests. Provide a Google AI Studio key through the environment:

```txt
GOOGLE_AI_STUDIO_API_KEY="..." npm run eval:protocol
```

Useful knobs:

```txt
CONDUIT_EVAL_MODELS="gemini-2.5-flash-lite,gemini-2.5-flash" npm run eval:protocol
CONDUIT_EVAL_OUTPUT="dist/evals/protocol-model-eval.json" npm run eval:protocol
```

The harness asks each model for compact Conduit requests, scores whether it used
one separated `conduit` block, checks that the block parses locally, and records
which tools were normalized from the response.

## Browser Extension Loop

The browser extension is optional. Clipboard-only Conduit workflows work without
it. Install the extension only if you want paired ChatGPT transport, protocol
block presentation, and browser-side retry controls.

Until the extension is approved as an unlisted Chrome Web Store item, alpha
testers can use the developer-mode package:

```txt
npm run extension:package
```

This creates `dist/extension/conduit-bridge-extension.zip`.

Dogfood install path:

1. Install and launch the Conduit desktop app.
2. Open the download page or Conduit Control.
3. Click **Prepare extension with Conduit** / **Download Extension**.
4. Approve the one-time Conduit review.
5. Chrome or Brave opens its extension page; choose **Load unpacked** and select the prepared folder.

The link uses `conduit://run?payload=...` and requests
`conduit.extension.prepareAlphaInstall`, which downloads or locally builds the
alpha extension package, verifies the package hash when one is supplied, extracts
it under `~/Downloads/Conduit`, and opens `chrome://extensions/`.

Dirty alpha install:

1. Open Chrome or Brave.
2. Go to `chrome://extensions/`.
3. Enable Developer mode.
4. Unzip `dist/extension/conduit-bridge-extension.zip`.
5. Click **Load unpacked**.
6. Select the unzipped `conduit-bridge-extension` folder.
7. Reload your ChatGPT tab.

For local extension development, load the repository `extension/` directory
directly and reload the extension after each code change.

If the desktop app or local listener is not running, the extension still acts as
a browser-side helper: it can highlight Conduit protocol blocks, provide a
copy-only-block affordance, and point the user to Conduit. It must not approve
or execute local actions by itself.

Start Conduit with the menu-bar app, then choose:

```txt
Conduit menu -> Copy Agent Handshake
```

Paste the handshake into a real ChatGPT tab. The handshake creates an
`extension` session with a one-shot nonce and teaches the agent to emit future
requests as a clearly separated fenced `conduit` block. The agent can still
talk to the user before or after that block; the block is the executable part.

Handshake messages are framed as Conduit protocol cards, not normal user prose:

```txt
+------------------------------------------------------------------+
| CONDUIT PROTOCOL :: AGENT HANDSHAKE                              |
| This is a local execution bridge control message.                 |
| Treat it as protocol metadata, not as a user-authored task.       |
+------------------------------------------------------------------+
```

Accepted agent-loop request shape:

```conduit
{
  "schema": "conduit.request.v1",
  "source": {
    "kind": "chat",
    "trust": "paired-session"
  },
  "permissions": [
    {
      "kind": "filesystem",
      "scope": "project",
      "access": "read"
    }
  ],
  "sessionId": "sess_...",
  "nonce": "call_...",
  "list": ".",
  "reason": "Inspect the project root.",
  "risk": "low"
}
```

The listener validates the paired session and nonce before executing actions.
Successful results include `nextNonce`; the agent must use that nonce on the
next request.

For simple requests, Conduit accepts compact action shortcuts:

- `help` / `.help` / `do: "help"` -> `conduit.help`
- `about` / `.about` / `do: "about"` -> `conduit.about`
- `read: "README.md"` -> `file.read`
- `list: "."` -> `file.list`
- `diff: "README.md"` -> `git.diff`
- `status: true` -> `git.status`
- `write: "path.txt", content: "...", mode: "create"` -> `file.write`
- `patch: "diff --git ..."` -> `file.patch`
- `shell: "npm test"` -> `shell.run`

Small-model-friendly aliases are accepted too:

```conduit
{
  "v": "1",
  "session": "sess_...",
  "n": "call_...",
  "do": "list",
  "path": ".",
  "why": "Orient before making changes."
}
```

For multiple simple actions, use `do: [...]`:

```conduit
{
  "v": "1",
  "session": "sess_...",
  "n": "call_...",
  "do": [
    "list .",
    "read README.md",
    "status"
  ],
  "why": "Get oriented."
}
```

Canonical `actions: [...]` remains supported for precise multi-action calls.
Each item can still use compact objects, string commands such as
`"read README.md"`, or canonical tool calls. Conduit normalizes everything into
canonical tool calls before policy checks.

Completion shape:

```conduit-final
{
  "status": "complete",
  "summary": "Done."
}
```

The extension still accepts `conduit-call`, `veyr-call`, `veyr-final`, and
legacy action/final delimiters for migration compatibility, but new agents
should use `conduit` and `conduit-final`.

## Clipboard Execution

The clipboard daemon uses exact-envelope parsing by default. It trims leading
and trailing whitespace, then executes only if the entire clipboard is exactly
one valid Conduit envelope.

Agents, docs, and webpages can still explain what a Conduit request does around
a copyable code block. The important boundary is what lands on the clipboard:
copying just the fenced `conduit` block is valid; copying the whole surrounding
message is not.

Accepted clipboard forms:

- one fenced `conduit` block containing strict JSON
- one fenced `conduit-json` block containing strict JSON
- one raw JSON Conduit request object

The daemon rejects clipboard buffers containing arbitrary prose, README
fragments, webpages, chats, or markdown that merely contain an embedded Conduit
block. Embedded block parsing belongs to authenticated agent-loop transports or
explicit unsafe power-user settings, not compliance-mode clipboard monitoring.

Exact untrusted envelopes without a live trusted session are not executed by
default. Conduit writes a review-required message and creates a pending review
record in the control panel so the user can inspect the claimed source,
permissions, actions, and reasons before deciding.

Clipboard-origin requests must include:

- `schema: "conduit.request.v1"`
- `source`
- `permissions`
- either one compact action shortcut or `actions: [...]`
- stable action `id` values for explicit multi-action requests

Trusted clipboard execution additionally requires a live `sessionId` and
one-shot `nonce`. Requests without those session fields can still be valid
Conduit envelopes, but they stop at local review until the user explicitly
approves the one request.

## Health And Logs

Extension bridge health:

```txt
curl http://127.0.0.1:3333/health
```

Useful fields:

- `tabStatusCount`: whether a ChatGPT content script has reported in
- `tabAvailability`: whether the latest ChatGPT tab is `ready`, `missing`,
  `stale`, or explicitly `unavailable`, with a human-readable reason
- `lastTabStatus`: latest tab heartbeat or outbound send stage
- `outboundQueued`: messages waiting for the extension to pick up
- `pendingPolls`: extension long-polls waiting for outbound messages
- `pendingSendResults` and `pendingSendResultIds`: outbounds delivered to the
  extension but not yet confirmed as sent
- `lastSendResult`: last extension send result
- `lastTransportError`: last abandoned or failed outbound send

The extension popup and control panel show the same bridge health. If outbound
delivery exhausts retries, use **Retry outbound** from either surface after
reloading the ChatGPT tab or extension.

Service logs live in:

```txt
~/Library/Logs/Conduit/agent-listener.log
~/Library/Logs/Conduit/clipboard-daemon.log
~/Library/Logs/Conduit/control-app.log
```

If the extension appears enabled but `tabStatusCount` is `0`, reload the
unpacked extension, then reload the ChatGPT tab.

If `tabAvailability.status` is `stale` or `unavailable`, the bridge is up but
the ChatGPT tab is not currently a reliable send target. Reload the ChatGPT tab
or extension, then retry the outbound message if one is available.

If `lastTabStatus.status` starts with `outbound_`, the content script is
reporting its current browser-send stage, such as composer insertion, send
button wait, or commit verification.

## Approvals

Read-only tools can run automatically under read-oriented profiles. Write,
patch, and shell actions are confirmation-gated by profile:

- `edit-with-confirmation`: confirms `file.write` and `file.patch`; denies shell
- `shell-manual`: confirms `file.write`, `file.patch`, and `shell.run`

Confirmation-required actions create one pending approval in shared state.
Terminal runs and the local control app are both approval surfaces for that same
record: approve or deny from either place, and the other UI will observe the
resolved decision. Approval records store where the decision came from, such as
`terminal` or `control-app`. Open the control panel and use the **Approvals** tab
to inspect action, reason, policy, and args before approving or denying.

Untrusted exact clipboard envelopes also create approval records. These records
are labeled as `conduit.review` and summarize the claimed source, declared
permissions, requested capabilities, actions, and whether session credentials
were present. Approving one executes the reviewed actions once under a narrow
read-only local policy rooted at the review's project root. It does not grant a
standing permission, create a trusted session, or broaden future execution
policy. Review approvals keep execution lifecycle metadata, so the control app
can show whether a reviewed request is pending, running, ran, or failed, and can
link directly to the resulting run. The macOS menu-bar app watches for pending
approvals and posts a system notification that opens the control panel directly
to the Approvals view.

## Tools And Policy

Implemented tools:

- `file.read`
- `file.list`
- `git.status`
- `git.diff`
- `file.write`
- `file.patch`
- `shell.run`

High-risk tools are routed through the policy engine. Read/git tools can run
under read-oriented profiles; write, patch, and shell actions require stronger
policy and may require confirmation. `--yes` approves confirmation-required
actions in local development flows.

Hard denials include project-root sandbox violations and secret-looking
filenames.

## Current Status

Working locally:

- TypeScript CLI/runtime
- fake transport spike
- clipboard transport and exact-envelope daemon
- local control panel
- macOS menu-bar app bundle staging
- unsigned macOS preview DMG packaging
- supervised app/control/listener/daemon lifecycle
- control-panel approvals for confirmation-required actions
- review records for untrusted exact clipboard envelopes
- local update-manifest check path
- Chrome/Brave unpacked extension bridge
- extension-only protocol block presentation and copy affordance
- deterministic agent-loop transcript harness
- paired-session nonce enforcement for extension agent loops
- agent-initiated handshake request rejection/repair path
- structured repair envelopes for malformed/rejected requests
- static download/about/API pages
- local session store
- local run logs
- policy-routed local tools
- protocol model eval harness with live Google AI Studio runs
- redacted diagnostic bundle API and bug-report entry points in the control
  panel, extension popup, and macOS menu-bar app
- Windows and Linux preview packaging scaffolds with launchers and shared
  desktop-shell contract
- Vitest coverage for protocol parsing, session/nonce handling, policy,
  clipboard execution, extension transport queueing, deterministic agent-loop
  transcripts, app scaffolding, and CLI e2e flows

Still not production-ready:

- signed and notarized desktop release artifact
- native Windows and Linux tray/status apps beyond preview launchers
- real auto-replacement updater
- hosted release downloads
- Windows/Linux native shell bug-report buttons and global error/crash capture
  across desktop shells, daemon, listener, extension, and control panel
- paid trust-analysis service that can explain requested code/actions before execution
- sandboxed dry-run/test evidence for higher-risk requests
- robust tab discard/throttle detection
- comprehensive live ChatGPT extension tests

## Cross-Platform Desktop Primer

Conduit v0 should ship as a desktop app, not as a terminal ritual with a nice
README. macOS is the first working shell, but Windows and Linux are product
targets rather than vague future ports.

Each platform app should provide the same consent surface:

- start, stop, and health for the control app, agent listener, and clipboard
  daemon
- approval notifications and a visible pending-approval queue
- copy agent handshake
- open control panel, logs, downloads, and docs
- check for updates and open verified release artifacts
- quit confirmation that can stop supervised execution processes
- a **Report Bug** action that attaches useful diagnostics without secrets

Bug reporting should be available from the menu-bar/tray app, control panel,
extension popup, and error screens. A useful report should include app version,
platform, service health, recent non-secret logs, last transport status, update
manifest metadata, and failed action/approval IDs. It must not include clipboard
contents, request payloads, file contents, session nonces, API keys, or secrets
unless the user deliberately expands and approves those fields.

Preview packaging scaffolds:

```txt
npm run windows:package
npm run linux:package
```

The preview packages include launchers and platform metadata. They are not yet
native tray/status apps; the required platform behavior lives in
`platforms/desktop-shell-contract.md`.

## Web Presence

The static site lives in `website/`:

- `website/index.html`
- `website/download.html`
- `website/about.html`
- `website/api.html`
- `website/releases/conduit-appcast.json`

Preview it with:

```txt
npm run site:dev
```

## More Docs

- [spec.md](spec.md): product and security contract
- [implementation.md](implementation.md): implementation notes and roadmap
- [NEXT_STEPS.md](NEXT_STEPS.md): current buildout checklist
- [extension/README.md](extension/README.md): extension install, behavior, and
  transport telemetry
- [docs/auth-troubleshooting.md](docs/auth-troubleshooting.md): browser auth
  background
- [docs/extension-transport-plan.md](docs/extension-transport-plan.md):
  extension architecture plan

Keep the loop small until it is boring.
