# Conduit Handoff Notes

## Current state (2026-10-18)

- Public repo: https://github.com/owl-and-kestrel/conduit (Apache-2.0).
- Released: v0.0.1 closed alpha on GitHub Releases. The macOS app is unsigned
  and not notarized; its update manifest is O+K-signed.
- Portfolio polish pass: redesigned control panel with consent cards, a
  labelled demo data mode (`?demo=1`), restyled website and extension popup,
  loopback-only / same-origin guard on the control API, extension bridge
  restricted to loopback hosts and the paired extension, README quickstart
  split into Linux-and-macOS vs macOS-only, and `npm run screenshots`.

Next, in rough priority order:

1. Apple Developer ID signing and notarization (Next Gate 3 below).
2. Linux and Windows clipboard I/O. `src/daemon/clipboard-io.ts` only has
   `MacClipboardIO` (`pbpaste`/`pbcopy`), so the clipboard daemon and the
   panel's clipboard buttons do not work on the Linux/Windows previews yet.
3. Release hygiene: the published v0.0.1 `Conduit.dmg.sha256` contains the
   build machine's absolute path (fixed for future builds in
   `script/package_dmg.sh`), and the owlandkestrel.com release redirects still
   go through the old jon-vs-moloch repository URL.

The gate log below is the build history. Read it for context; the list above
is the current queue.

Current state:

- Conduit was scaffolded from the sibling `veyr` project.
- Package/bin/state identity is now Conduit:
  - package name: `conduit`
  - bin: `conduit`
  - env override: `CONDUIT_STATE_DIR`
  - default state root: `~/.conduit`
- The agent loop works through the existing run/listen architecture.
- Native request blocks are accepted:

````txt
```conduit
{
  "type": "conduit.request.v1",
  "actions": [
    {
      "id": "read_readme",
      "tool": "file.read",
      "args": { "path": "README.md" },
      "reason": "Need context.",
      "risk": "low"
    }
  ]
}
```
````

- Compatibility blocks are still accepted:
  - `conduit-call`
  - `conduit-final`
  - `veyr-call`
  - `veyr-final`
  - legacy `ACTIONS_JSON` / `FINAL_JSON`
- Compact action shortcuts are accepted and normalized before policy/execution:
  - `read: "README.md"` -> `file.read`
  - `list: "."` -> `file.list`
  - `diff: "src/index.ts"` -> `git.diff`
  - `status: true` -> `git.status`
  - `write`, `patch`, and `shell` map to their corresponding high-risk tools
- Small-model-friendly aliases are accepted:
  - `session` -> `sessionId`
  - `n` -> `nonce`
  - `v: "1"` -> `schema: "conduit.request.v1"`
  - `do` / `op` select the action alias
  - `why` -> action `reason`
  - `do: ["list .", "read README.md", "status"]` normalizes into multi-action requests
  - `do: "help"` / `do: ".help"` and `do: "about"` expose progressive protocol help
  - string actions such as `"read README.md"` normalize into canonical actions
- Protocol prompts now use an ASCII Conduit protocol card so handshakes and
  harness prompts look like control messages rather than user-authored prose.
- Session primitives are implemented:
  - `src/sessions/nonce.ts`
  - `src/sessions/profiles.ts`
  - `src/sessions/session-store.ts`
  - `conduit session create/list/revoke`
  - nonce validation, consumption, and rotation
- Policy primitives are implemented:
  - `src/policy/policy-engine.ts`
  - `src/policy/budgets.ts`
  - `src/policy/risk.ts`
  - profile decisions for allow/review/confirm/deny
  - allowed-root checks
  - sensitive file read denial
  - action-count budget denial
  - confirmation-required actions can create shared approval requests for the control app
- Shared action execution is implemented:
  - `src/runtime/execute-actions.ts`
  - run/listen loops route actions through policy
  - actions, policy decisions, and tool results are logged
  - confirmation-required actions still honor `--yes`
- Trusted request execution is implemented:
  - `src/daemon/execute-request.ts`
  - parses copied `conduit` request text
  - requires `sessionId` and `nonce`
  - exact envelopes without a live trusted session create a pending review record instead of executing
  - consumes nonce before local execution
  - executes through the shared policy/action executor
  - renders `CONDUIT_RESULTS_JSON`
- Exact clipboard envelope parsing is implemented for daemon request execution:
  - `src/protocol/parse-clipboard-envelope.ts`
  - trims only leading/trailing whitespace
  - accepts standalone fenced `conduit` / `conduit-json` envelopes or raw JSON envelopes
  - rejects prose-wrapped and multi-envelope clipboard buffers
  - rejects duplicate JSON object keys
  - enforces a maximum envelope size
- The older embedded-block agent parser remains available for run/listen style flows, but should be treated as a YOLO/elevated authenticated-session capability, not as Compliance Mode clipboard behavior.
- Clipboard watcher daemon is implemented:
  - `src/daemon/clipboard-io.ts`
  - `src/daemon/clipboard-watcher.ts`
  - `src/daemon/daemon.ts`
  - `conduit daemon once`
  - `conduit daemon start`
  - writes working status, result text, or rejection text
  - ignores unchanged clipboard content
- Local control app is implemented:
  - `src/app/control-panel.ts`
  - `conduit app start`
  - `npm run app`
  - status/session/run APIs
  - session create/revoke UI
  - recent runs UI
  - clipboard check-once action
  - approvals UI for confirmation-required actions
  - extension bridge health panel and outbound retry button
- Local macOS menu-bar app scaffold is implemented:
  - `macos/ConduitMenuBar/Package.swift`
  - `macos/ConduitMenuBar/Sources/ConduitMenuBar/main.swift`
  - `script/build_and_run.sh`
  - `npm run macos:build`
  - `npm run macos:run`
  - status item controls for the control app and clipboard daemon
  - default startup for the control app and clipboard daemon
  - confirmed quit that stops supervised services
  - update-check menu path using `website/releases/conduit-appcast.json` or `CONDUIT_UPDATE_MANIFEST_URL`
  - Copy Agent Handshake menu action for real chat-tab testing
- Static web presence is implemented:
  - `website/index.html`
  - `website/download.html`
  - `website/about.html`
  - `website/api.html`
  - `npm run site:dev`
- Core tool coverage is implemented:
  - `tests/tools/file-list.test.ts`
  - `tests/tools/git-tools.test.ts`
  - `tests/tools/write-patch-shell.test.ts`
  - coverage for `file.list`, `git.status`, `git.diff`, `file.write`, `file.patch`, and `shell.run`
- End-to-end smoke coverage is implemented:
  - `tests/e2e/cli-e2e.test.ts`
  - public CLI `doctor`, fake `run`, and `session create/list/revoke`
  - existing app tests cover session creation, exact envelope clipboard check, result writes, and run listing through the local app API
- Static-site coverage is implemented:
  - `tests/website/web-presence.test.ts`
  - required page existence, local link integrity, and public API security copy
- Protocol model eval coverage is implemented:
  - `src/evals/protocol-model-eval.ts`
  - `scripts/protocol-model-eval.ts`
  - `npm run eval:protocol`
  - optional Google AI Studio live evals score whether small models emit one separated `conduit` block that parses into expected tools
- macOS package scaffold coverage is implemented:
  - `tests/macos/menu-bar-package.test.ts`
  - SwiftPM package layout, build script, Codex Run action, release metadata knobs, and update manifest shape
- Installer/download polish is implemented:
  - `script/package_dmg.sh` emits a DMG, SHA-256 file, appcast JSON, and release notes
  - release artifact URLs can be supplied with `CONDUIT_RELEASE_ARTIFACT_URL` or `CONDUIT_RELEASE_BASE_URL`
  - `website/download.html` presents the DMG as the primary install path, with source build as the development fallback
- Agent-loop handshake generation is implemented:
  - `src/protocol/render-agent-handshake.ts`
  - `POST /api/agent-handshake`
  - control app toolbar button
  - menu-bar `Copy Agent Handshake` action
  - creates an `extension` session and copies a self-contained protocol intro for a real chat tab
- Persistent extension listener session enforcement is implemented:
  - `npm run conduit -- listen --project ...` requires valid `extension` or `browser-yolo` session id and current nonce before action execution
  - successful extension listener actions consume and rotate the nonce
  - extension listener results return `CONDUIT_RESULTS_JSON` with `nextNonce`
  - missing/invalid/replayed session data returns `CONDUIT_REPAIR_JSON`
  - `conduit-handshake-request` is detected but never auto-pairs; it asks for local user approval via Copy Agent Handshake
- Extension bridge status/recovery is implemented:
  - browser extension popup shows tab availability, outbound, retry, and error state from `/health`
  - `/health` reports `tabAvailability` as `missing`, `ready`, `stale`, or `unavailable`
  - daemon retries failed or stalled outbounds with backoff
  - exhausted outbounds are retained as attention-required retry candidates
  - `/api/conduit-retry` manually requeues pending, retrying, or exhausted outbounds
  - popup and control panel can trigger manual retry
- Extension-only protocol presentation is implemented:
  - ChatGPT content script decorates visible `conduit` protocol blocks with a distinct Conduit header
  - decorated blocks expose a copy-only-block button
  - popup explains that local execution and approvals require the desktop app when the local listener is offline
- Structured repair output is implemented:
  - rejected exact envelopes return `CONDUIT_REPAIR_JSON`
  - malformed JSON, multiple envelopes, and invalid session failures include repair instructions and an example request
  - exact envelopes missing a live trusted session create a review-required approval record
  - clipboard watcher writes repair output back instead of plain rejection text when available
- Approve-once review execution is implemented:
  - `conduit.review` approval records can execute their reviewed actions once from the control app
  - approved untrusted reviews run under a one-shot read-only policy session
  - approved-review runs are logged with `mode: "approved-review"` and the approval id
  - approval records store execution state, run id, and execution errors for UI lifecycle display
- Approval notifications are implemented:
  - the macOS menu-bar app polls the control app for pending approvals
  - new approval ids emit a native notification
  - clicking an approval notification opens the control panel at `#approvals`
- Future paid trust-analysis/sandboxing track is planned:
  - optional LLM review explains requested code/actions before execution
  - higher-risk approvals may include sandboxed dry-run or test evidence
  - sandboxing remains a core roadmap feature, not a substitute for local consent
- Clipboard secret intake is planned:
  - `conduit:key//...` should mean "ingest this secret after approval," not
    "execute arbitrary clipboard text"
  - v0 target provider is Vercel deploy tokens for O&K projects
  - stored secrets should carry provider, account/team, target, capabilities,
    aliases, and last verification metadata
  - downstream workflows should resolve secrets by provider + capability +
    target instead of relying only on human aliases like `ok-prod/vercel`
  - successful intake should rewrite the clipboard to a non-secret reference and
    keep raw secret material out of logs, diagnostics, and result text
- Cross-platform desktop primer is planned:
  - macOS is the first working shell, but Windows and Linux desktop apps are v0 product targets
  - each shell should expose the same consent/health/reporting surface
  - bug report buttons belong in the desktop app, control panel, extension popup, and error screens
  - reports should include non-secret diagnostics and never silently attach clipboard contents, request payloads, nonces, API keys, or file contents
- Redacted diagnostic bundle API is implemented:
  - `GET /api/diagnostics`
  - control panel `#diagnostics` bug-report preview
  - extension popup links to the local bug-report surface
  - macOS menu-bar app has a Report Bug action and error alerts can open diagnostics
  - bundles redact session nonces, request payloads, file contents, API keys, environment variables, and secrets by default
- Windows/Linux preview package scaffolds are implemented:
  - `platforms/desktop-shell-contract.md`
  - `script/package_windows.ps1`
  - `script/package_linux.sh`
  - Windows PowerShell launchers for control, listener, daemon, open control, and report bug
  - Linux launcher scripts and `.desktop` metadata for control and report bug
  - native tray/status shells remain the next platform app step

Verification commands:

```txt
npm install
npm run build
npm test
npm run doctor
npm run spike
npm run macos:build
```

Optional live model eval:

```txt
GOOGLE_AI_STUDIO_API_KEY="..." npm run eval:protocol
```

Known-good verification from the latest protocol model eval pass:

```txt
npm run build  # passed
npm test       # passed, 30 files / 140 tests (at the time of that eval pass)
```

## Completed Gate: GitHub Repository

The repository is initialized and pushed to:

```txt
https://github.com/owl-and-kestrel/conduit
```

## Completed Gate: Session And Nonce Layer

Implemented:

```txt
src/sessions/nonce.ts
src/sessions/session-store.ts
src/sessions/profiles.ts
tests/sessions/session-store.test.ts
```

Behavior:

- `createSession({ label, profile, roots, transport })`
- cryptographically random `sessionId`
- cryptographically random `currentNonce`
- validate `sessionId + nonce`
- consume nonce before execution
- rotate to a new nonce after acceptance
- reject stale, unknown, expired, paused, and revoked sessions
- write session state to `~/.conduit/sessions.json`
- support `CONDUIT_STATE_DIR` in tests

CLI shape:

```txt
conduit session create --label "ChatGPT" --profile read-only --root /path/to/project
conduit session list
conduit session revoke <sessionId>
```

The create command prints a starter `conduit` block containing `sessionId`, `nonce`, and a concrete safe `list: "."` action. The starter block is executable for read-only project-root orientation, which makes first-run clipboard testing less confusing than a deliberately empty template.

## Completed Gate: Real Policy Engine

Policy decision primitives are now implemented and covered by tests.

Implemented:

```txt
src/policy/policy-engine.ts
src/policy/risk.ts
src/policy/budgets.ts
tests/policy/policy-engine.test.ts
```

Decision type:

```ts
type PolicyDecision =
  | { decision: 'allow' }
  | { decision: 'requires_review'; reason: string }
  | { decision: 'requires_confirmation'; reason: string }
  | { decision: 'deny'; reason: string };
```

Profiles:

- `read-only`: allow `file.read`, `file.list`, `git.status`, `git.diff`; deny write/patch/shell.
- `edit-with-confirmation`: auto-allow read/git; confirm write/patch; deny shell.
- `shell-manual`: auto-allow read/git; confirm write/patch/shell.

Runtime integration:

```txt
src/runtime/run-loop.ts
src/runtime/listen-loop.ts
```

Both now call the shared executor, which logs `policy-decisions.jsonl` and routes denies/confirmations through tool results. Interactive CLI runs use a terminal prompt; non-interactive service runs create approval records under the Conduit state directory for the local control app to approve or deny.

## Completed Gate: Request Executor Core

Implemented:

```txt
src/runtime/execute-actions.ts
src/runtime/run-loop.ts
src/runtime/listen-loop.ts
```

Behavior:

- log actions
- apply policy
- log policy decisions
- look up tools
- ask confirmation when needed
- execute tools
- append results
- return `ToolResult[]`

This should make the clipboard watcher and future daemon much easier to add. A future `src/daemon/execute-request.ts` can wrap this lower-level executor with session/nonce consumption and result rendering.

## Completed Gate: Trusted Request Executor

Implemented:

```txt
src/daemon/execute-request.ts
tests/daemon/execute-request.test.ts
```

Behavior:

- ignores ordinary text
- rejects malformed, embedded, or multiple request blocks
- opens local review for requests without a live trusted `sessionId` and `nonce`
- requires clipboard metadata: `schema`, `source`, and `permissions`
- validates session nonce
- consumes nonce before execution
- executes actions through `src/runtime/execute-actions.ts`
- returns and writes Conduit-native result text
- rejects replayed requests because the nonce is already used

This is the core the clipboard watcher should call after detecting changed clipboard text.

## Completed Gate: Clipboard Watcher MVP

Implemented:

```txt
src/daemon/clipboard-io.ts
src/daemon/clipboard-watcher.ts
src/daemon/daemon.ts
tests/daemon/clipboard-watcher.test.ts
```

Behavior:

- poll `pbpaste` every 500-1000ms on macOS
- hash last clipboard content
- ignore unchanged content
- pass changed clipboard text to `executeRequestFromText`
- write a working status to clipboard immediately
- replace clipboard with rendered results
- never re-execute the same nonce or request hash

CLI:

```txt
conduit daemon once
conduit daemon start --interval-ms 1000
```

`daemon once` reads the clipboard once, executes an exact envelope if present, writes result/rejection text, and exits. `daemon start` keeps polling until Ctrl+C.

## Completed Gate: Local Control App MVP

Implemented:

```txt
src/app/control-panel.ts
tests/app/control-panel.test.ts
```

CLI:

```txt
conduit app start --port 47831 --open
npm run app
```

Current surface:

- status view with Compliance mode and exact-envelope state
- sessions view with create/revoke actions
- starter envelope display for new sessions
- recent runs view
- result viewer for request/agent runs
- check clipboard once action

This is intentionally a local web control plane for now. It gives v0 a usable app surface without blocking on Tauri packaging.

## Completed Gate: Core Tool Coverage

Implemented:

```txt
tests/tools/file-list.test.ts
tests/tools/git-tools.test.ts
tests/tools/write-patch-shell.test.ts
```

Covered behavior:

- `file.list` returns deterministic project-root listings, supports shallow recursive scans, and enforces project-root boundaries.
- `git.status` and `git.diff` work in a real temporary repository.
- `file.write` creates files under the project root and rejects paths outside the root.
- `file.patch` applies unified patches and rejects paths outside the root.
- `shell.run` executes explicit shell commands in the project root and captures stdout/stderr/exit code.

## Completed Gate: End-To-End Smoke Coverage

Implemented:

```txt
tests/e2e/cli-e2e.test.ts
src/runtime/agent-loop-harness.ts
tests/e2e/agent-loop-harness.test.ts
```

Covered behavior:

- `conduit doctor` reports the public runtime surface.
- `conduit run --transport fake` completes a real child-process run and writes final run logs under `CONDUIT_STATE_DIR`.
- `conduit session create/list/revoke` works through the public CLI, prints a valid starter envelope, persists the session, and records revocation.
- deterministic agent-loop transcripts create a real paired extension session, accept prose plus one compact `conduit` block, consume/rotate nonces, render `CONDUIT_RESULTS_JSON`, recover from a rejected request via `.help`, and finalize run logs without a live browser.

The local app tests also exercise the request path end to end through app APIs:

- create a session
- place an exact Conduit envelope in a fake clipboard
- call `POST /api/clipboard/check`
- execute via the trusted request executor
- write `CONDUIT_RESULTS_JSON`
- list the resulting run

## Completed Gate: Static Web Presence MVP

Implemented:

```txt
website/index.html
website/download.html
website/about.html
website/api.html
website/assets/site.css
tests/website/web-presence.test.ts
```

Dev preview:

```txt
npm run site:dev
```

The site is intentionally static for v0: home, download, about, and API pages. The download page documents the source-checkout DMG packaging flow until hosted release artifacts exist.

## Completed Gate: Local macOS Menu-Bar App Scaffold

Implemented:

```txt
macos/ConduitMenuBar/Package.swift
macos/ConduitMenuBar/Sources/ConduitMenuBar/main.swift
macos/ConduitMenuBar/Assets/ConduitIcon.svg
script/build_and_run.sh
script/package_dmg.sh
.codex/environments/environment.toml
website/releases/conduit-appcast.json
tests/macos/menu-bar-package.test.ts
```

Commands:

```txt
npm run macos:build
npm run macos:package
npm run macos:package -- --skip-build # package an already staged app if SwiftPM is unavailable
npm run macos:run
./script/build_and_run.sh --verify
```

Behavior:

- builds a SwiftPM AppKit status-bar app
- stages `dist/macos/Conduit.app`
- packages `dist/macos/Conduit.dmg` with `Conduit.app`, an `/Applications` shortcut, install notes, and a SHA-256 checksum
- starts/stops `npm run conduit -- app start --port 47831`
- opens `http://127.0.0.1:47831`
- starts/stops `npm run conduit -- listen --project <repo root>` for the browser extension agent loop
- starts/stops `npm run conduit -- daemon start --interval-ms 1000`
- starts supervised services by default when the menu-bar app launches
- asks for confirmation before quitting and stopping supervised services
- passes a parent PID deadman switch to supervised services, so they exit if the menu-bar app disappears
- run modes of the local build/run script stop only this checkout's app and its child processes (until 2026-10-18 they also swept legacy service processes by command-line pattern, which could reach a sibling checkout's services)
- checks a local update manifest by default
- allows `CONDUIT_UPDATE_MANIFEST_URL` to point at a future hosted manifest
- copies a fresh agent-loop handshake into the clipboard for real ChatGPT tab testing

Important limitation:

- this is a local preview app and unsigned preview DMG, not a signed/notarized distributable
- first launch from the DMG may require right-click Open because Gatekeeper cannot verify a developer identity yet
- update checking can install a verified O&K-signed macOS update by downloading the DMG, checking its SHA-256, replacing `Conduit.app`, and relaunching
- the local preview manifest is intentionally unsigned; replacement is refused unless the manifest verifies against the pinned O&K publisher key

## Next Gate 3: Signed Desktop/Menu-Bar Release

We want an app, too. The CLI daemon can prove the execution loop first, but v0 should include a small local control surface rather than remaining terminal-only.

Recommended scope:

```txt
app/
  macOS menu-bar app
  Windows tray app
  Linux tray/status app
```

The app should own consent and visibility:

- daemon status: running, paused, stopped
- current mode: Compliance, YOLO, Idiot/unsafe
- obvious warning when any embedded-block parser setting is enabled
- session list with labels, profiles, roots, current state, and revoke action
- recent runs list with status, source, actions, and log path
- signed/notarized distribution and real update replacement
- copy/view latest result
- settings for clipboard watcher polling and exact-envelope behavior
- bug report button with redacted diagnostic bundle preview
- top-level error catcher that routes crashes, service failures, update errors,
  extension bridge failures, and approval execution failures to logs and the
  report flow
- platform-specific install/update affordances:
  - macOS: DMG/app bundle first, signing/notarization later
  - Windows: installer or portable app plus tray shell
  - Linux: AppImage/deb/rpm or tarball plus tray/status shell

Keep first release version modest:

- no native extension pairing UI beyond showing status/token if needed
- no marketplace/release-channel work
- no silent self-replacement without artifact hash/signature checks

The app is the control/consent plane. The daemon owns execution. The CLI remains useful for scripting and tests.

## Completed Gate: Browser Protocol Presentation

Implemented:

```txt
extension/content.js
extension/popup.html
extension/popup.css
extension/popup.js
```

Behavior:

- extension-only mode is useful but non-executing
- visible Conduit protocol blocks get a distinct browser-side header
- decorated protocol blocks offer copy-only-block behavior
- the popup shows a desktop-app CTA when the local listener is offline
- local execution and approval remain owned by the desktop app/daemon

## Completed Gate: Approve-Once Untrusted Review Execution

Implemented:

```txt
src/daemon/execute-request.ts
src/app/control-panel.ts
tests/app/control-panel.test.ts
```

Behavior:

- exact untrusted clipboard envelopes create `conduit.review` approvals
- the control app labels these approvals as one-request decisions
- approving one moves the review through pending/running/ran/failed UI states
- stale or repeated approval calls do not execute the reviewed actions again
- execution uses a one-shot read-only policy session rooted at the review project
- write, patch, shell, or other non-read-only actions do not become trusted just because the review was approved
- resulting runs are visible in the Runs view with `mode: "approved-review"`

## Completed Gate: Approval Notifications

Implemented:

```txt
macos/ConduitMenuBar/Sources/ConduitMenuBar/main.swift
src/app/control-panel.ts
tests/macos/menu-bar-package.test.ts
tests/app/control-panel.test.ts
```

Behavior:

- menu-bar app polls `GET /api/approvals`
- each new pending approval id triggers one native notification
- notification title distinguishes untrusted request reviews from generic action approvals
- clicking the notification opens Conduit Control directly to `#approvals`
- control-panel hash routing preserves direct links to Approvals, Sessions, Runs, or Overview

## Planned Gate: Trust Analysis And Sandboxing

Future paid/platform feature:

- have an LLM inspect requested code, patches, shell commands, manifests, and tool plans before execution
- explain likely effects, risks, touched files, and suspicious behavior in plain language
- optionally run the request or generated patch in a sandbox first and summarize test results
- attach the explanation and sandbox evidence to the approval record
- keep this advisory: local policy, sandboxing, signatures, and explicit user approval remain authoritative

## Completed Gate: Native Result Blocks

Current agent-loop result rendering is still ChatGPT/Veyr-compatible:

```txt
<<<TOOL_RESULTS_JSON
...
TOOL_RESULTS_JSON>>>
```

Conduit-native request execution now renders:

```txt
<<<CONDUIT_RESULTS_JSON
...
CONDUIT_RESULTS_JSON>>>
```

Keep `TOOL_RESULTS_JSON` as a compatibility mode for chat agent loops.

## Notes

- The browser extension recognizes fenced and rendered `conduit` blocks. Keep rendered-code detection boundary-aware so bare `conduit` does not collide with longer labels such as `conduit-call` and `conduit-final`.
- Keep the distinction sharp: `parseClipboardEnvelope` is for Compliance Mode clipboard/daemon execution; `parseActions` is for authenticated agent-loop turns only after the user has explicitly started or paired that transport, or enabled a YOLO/unsafe embedded-block setting.
- `npm install` reports 5 moderate vulnerabilities inherited from the current dependency graph. Do not run `npm audit fix --force` casually; it may introduce breaking upgrades.
- `dist/` is generated by `npm run build`. Do not edit generated files.
