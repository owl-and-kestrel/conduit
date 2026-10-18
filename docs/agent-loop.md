# Conduit agent loop and request dialects

This is the detailed reference for paired agent loops: the handshake, the
request dialects agents may emit, completion blocks and the browser-extension
bridge. The README covers the consent model and quickstart; [spec.md](../spec.md)
is the security contract.

Clipboard (compliance-mode) execution is stricter than everything here: the
clipboard daemon only acts on a clipboard that is exactly one envelope, and
embedded blocks inside prose are ignored. Embedded-block parsing belongs to
authenticated agent-loop transports that the user explicitly started.

## Browser extension loop

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
Conduit menu-bar popover -> Copy Agent Handshake
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

## Bridge health and troubleshooting

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
