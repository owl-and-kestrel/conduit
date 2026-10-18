# Conduit Bridge Extension

This is the foundational boilerplate for the Conduit Chrome Extension, built to tether the user's organic, already-authenticated ChatGPT web interface to the local Conduit CLI runtime.

The extension does not bypass auth, solve verification challenges, extract cookies, or disguise automation. The user signs in normally, then explicitly enables the extension bridge.

## Current Capabilities (Spike Phase)
- Injects a content script into `https://chatgpt.com/*`.
- Decorates visible Conduit protocol code blocks with a distinct header and a copy-only-block button.
- Observes visible assistant messages for `conduit`, `conduit-call`, `conduit-final`, and `conduit-handshake-request` code blocks.
- Keeps legacy `<<<ACTIONS_JSON` and `<<<FINAL_JSON` support for compatibility.
- De-duplicates protocol blocks across DOM updates.
- Passes the payload from the restricted content script to the unrestricted background service worker.
- Forwards the payload via `POST` to `http://127.0.0.1:3333/api/conduit-call`.
- Polls `http://127.0.0.1:3333/api/conduit-outbound` for harness messages to send back into ChatGPT.
- Reports content-script heartbeat status to `http://127.0.0.1:3333/api/conduit-tab-status`.
- Shows an extension-only fallback in the popup when the local desktop app/listener is not reachable.

## Pairing

The local bridge answers only this extension. On its first call the extension
`POST`s `/api/conduit-pair`; the bridge accepts that only from a
`chrome-extension://` (or `moz-extension://`) origin, which web pages cannot
send, pins that origin and returns a per-process token. Every other bridge call
(`bridge-client.js`) sends the token as `X-Conduit-Bridge-Token`; after a bridge
or service-worker restart the extension re-pairs on its own. There is nothing
to configure.

- Web-page origins get 403 on every endpoint, including CORS preflights.
- Requests must be addressed to `127.0.0.1` or `localhost` on the bridge port
  (DNS rebinding is refused).
- The Conduit control panel origin may read `/health` and request a retry;
  Origin-less local clients (menu-bar app, `curl`) may read `/health`.
- Unpacked extension IDs depend on the install folder. If you load the
  extension from a new folder while the bridge is running, it answers 403
  ("paired with another extension"): restart Conduit. To pin known IDs
  instead of first-come pairing, set
  `CONDUIT_EXTENSION_ORIGINS=chrome-extension://<id>[,...]`.

Extension-only mode is intentionally non-executing. It can make Conduit blocks easier to recognize and copy, but local execution and approval require the Conduit desktop app and daemon.

## Alpha Package

Package the optional alpha extension from the repo root:

```txt
npm run extension:package
```

That creates `dist/extension/conduit-bridge-extension.zip` with a small install
note for developer-mode testers.

When Conduit desktop is installed, the dogfood path is a `conduit://` link from
the download page or the Conduit Control **Download Extension** button. That link
opens a one-time local review for `conduit.extension.prepareAlphaInstall`, then
prepares the same folder under `~/Downloads/Conduit`.

## How to Install (Unpacked)

Until the extension is approved as an unlisted Chrome Web Store item, alpha
testers need the dirty developer-mode path:

1. Open Google Chrome or Brave.
2. Navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top right).
4. Unzip `dist/extension/conduit-bridge-extension.zip`, or use the repository
   `extension/` directory for local development.
5. Click **Load unpacked**.
6. Select the unzipped `conduit-bridge-extension` folder or local `extension/`
   directory.
7. Reload your ChatGPT tab.

## How to Run

Start a Conduit run with extension transport:

```txt
npm run conduit -- run --transport extension --project fixtures/fake-project --task "Read README.md and summarize it."
```

Then open an authenticated ChatGPT tab with the extension enabled.

For the persistent v0 listener, prefer:

```txt
npm run conduit -- listen --project fixtures/fake-project
```

Lifecycle:

- `run --transport extension` sends an initial task and exits on `conduit-final`.
- `listen` keeps the bridge open.
- In `listen` mode, a `conduit` or `conduit-call` request must include a valid paired session id and current nonce before actions execute.
- Simple requests may use compact shortcuts such as `read`, `list`, `diff`, and `status`; the runtime normalizes them before policy checks.
- In `listen` mode, a `conduit-final` closes the current session but leaves the listener active.
- A later `conduit-call` starts a new session.
- A `conduit-handshake-request` never creates a session by itself. It returns a repair/approval message asking the local user to choose **Copy Agent Handshake** from Conduit.

## Current Hardening Notes

- The content script uses both `MutationObserver` and periodic scans.
- Browser-side block presentation is cosmetic/copy-only; it is not a consent boundary.
- The runtime queues inbound protocol blocks even if they arrive before `waitForAssistantTurn`.
- The runtime queues outbound messages until the extension polls.
- Outbound messages include a visible `Conduit transport id: out-N` marker.
- The extension only reports `sent` after it observes the `transportId` committed in a user message.
- The content script retries browser sends through composer stabilization, upload settling, send-button readiness, click, and commit verification.
- Retry dedupe is based on the visible `transportId`, so ambiguous retries should not duplicate already-sent messages.
- Persistent `listen` mode stays active after `conduit-final`.
- Extension listener execution is paired-session gated: no valid active `extension`/`browser-yolo` session and current nonce means no local action execution.
- `/health` is available on the local bridge.
- Send results are reported to `/api/conduit-send-result` with `transportId`, `attempts`, `messageChars`, and optional `error`.
- The extension popup displays bridge health and can manually retry a pending, retrying, or exhausted outbound send through `/api/conduit-retry`.
- `file.read` supports `offset` plus `nextOffset` metadata so large files can be read in continuation slices.

Useful health check:

```txt
curl http://127.0.0.1:3333/health
```

Interpretation:

- `tabStatusCount === 0`: no ChatGPT content script has reported in. Reload the unpacked extension from `chrome://extensions/`, then reload the ChatGPT tab.
- `tabAvailability.status === "missing"`: no tab heartbeat has reached the bridge yet.
- `tabAvailability.status === "stale"`: the last heartbeat is too old; reload or focus the ChatGPT tab before retrying.
- `tabAvailability.status === "unavailable"`: the latest tab status reported a known unusable state, such as an invalidated extension context.
- `tabAvailability.status === "ready"`: the local listener has a fresh ChatGPT content-script heartbeat.
- `lastTabStatus.url`: the latest ChatGPT tab that reported the content script alive.
- `outboundQueued > 0`: the extension has not picked up the next harness message yet.
- `deliveredOutboundCount` increased but `pendingSendResults > 0`: the content script has accepted an outbound message and is still trying to insert/send it. The listener can continue processing inbound protocol blocks while this confirmation remains pending.
- `retryingOutbound > 0`: the daemon is retrying a failed or timed-out outbound send with backoff. The retry reuses the same `transportId` so the content script can dedupe if the message actually committed.
- `lastTransportError.status === "stalled"` or `lastTransportError.error` mentioning send progress: the extension picked up an outbound message but stopped reporting send stages. The daemon will requeue it with backoff rather than waiting for the full send-result timeout.
- `attentionOutbound > 0` or `lastTransportError.needsAttention === true`: daemon retries are exhausted. Reload the ChatGPT tab/extension if needed, then use the popup or control panel retry control.
- `lastTabStatus.status` beginning with `outbound_`: the content script is reporting its current send stage, such as outbound receipt, composer insertion, send-button wait, or commit verification.
- `lastTransportError`: the local runtime saw an outbound send failure, timeout, retry, or exhausted retry state.
- `lastSendResult.status === "failed"`: the content script could not insert/send the outbound message. The error is telemetry; the persistent listener remains alive for later inbound blocks.
- `lastSendResult.status === "sent"`: the runtime has confirmed the outbound message was committed to the conversation.

## Next Steps for Development

1. Detect discarded/throttled/unavailable tabs.
2. Add extension UI for pending handshake requests and pairing status.
3. Make composer insertion more robust across ChatGPT UI changes.
4. Add static DOM fixture tests for content-script extraction helpers.
