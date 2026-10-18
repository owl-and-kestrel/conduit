# Conduit

**A local control plane for consent-shaped agent execution.**

When a chat model says "paste this in your terminal and run it", Conduit gives
it a structured, policy-checked way to ask your machine for the same work
instead. You see where the request came from, what it may touch and every
action it will run, and nothing with local effects happens until you approve it.

Conduit is not a ChatGPT wrapper, not an auth bypass, and not a magic sandbox.
It is a local runtime plus transports, built by Owl + Kestrel.

> **Status: preview.** v0.0.1 is a closed-alpha build. The macOS app is
> **not code-signed or notarized by Apple**, so macOS will warn on first
> launch. Treat every capability boundary as load-bearing.
> Licensed under [Apache-2.0](LICENSE).

| Approvals (demo data) | Overview, dark (demo data) |
| --- | --- |
| ![Conduit Control showing an untrusted request with its source, declared permissions and actions, waiting for Approve once or Deny](docs/screenshots/control-approvals-desktop-light.png) | ![Conduit Control overview in dark mode with pending decisions, local services and the extension bridge](docs/screenshots/control-overview-desktop-dark.png) |

| Website | Phone |
| --- | --- |
| ![The Conduit website hero: "Copy the request. Only the request."](docs/screenshots/website-home-desktop-light.png) | ![Conduit Control approvals on a 390px-wide phone](docs/screenshots/control-approvals-mobile-light.png) |

More sizes and both color schemes live in [docs/screenshots](docs/screenshots).
Every control-panel screenshot is **demo data** (see below), not a real machine.

## What is in the box

- **macOS menu-bar app** (Swift) that supervises the local services, posts
  approval notifications and stops everything on quit.
- **Control panel** at `http://127.0.0.1:47831` for sessions, starter
  envelopes, clipboard checks, agent handshakes, approvals, runs and redacted
  bug reports.
- **Clipboard daemon** that only acts on an *exact* Conduit envelope.
- **Browser-extension bridge** on `127.0.0.1:3333` for paired ChatGPT agent
  loops (optional).
- **TypeScript CLI/runtime** with policy-routed local tools
  (`file.read`, `file.list`, `git.status`, `git.diff`, `file.write`,
  `file.patch`, `shell.run`).
- **Static website** in `website/`.

## Quickstart

You need Node 20 or newer and git.

```sh
git clone https://github.com/owl-and-kestrel/conduit
cd conduit
npm ci
npm test
```

`npm ci` pulls one dev-only package, `@owl-kestrel/hatch-contracts`, from the
Owl + Kestrel registry configured in `.npmrc`. It needs no login.
`npm ci --omit=dev` skips it.

### Works on Linux and macOS

| Command | What it does |
| --- | --- |
| `npm run app` | Starts the control panel on `http://127.0.0.1:47831`. |
| open `http://127.0.0.1:47831/?demo=1` | The same panel with **demo data**: sample sessions, approvals and runs. |
| `npm run spike` | Runs the fake transport end to end against `fixtures/fake-project`. |
| `npm run doctor` | Checks the local runtime environment. |
| `npm run conduit -- session create --label Demo --root fixtures/fake-project` | Pairs a session (see `session list`, `session revoke`). |
| `npm run listen` | Starts the extension bridge listener on `127.0.0.1:3333`. |
| `npm run site:dev` | Serves `website/` on `http://127.0.0.1:47832`. |
| `npm run build` | Type-checks and compiles to `dist/` (`node dist/src/cli/index.js --help`). |
| `npm run linux:package` | Builds the Linux preview tarball (launchers, no tray app yet). |
| `npm run screenshots` | Regenerates `docs/screenshots` (run `npx playwright install chromium` once). |

### macOS only

| Command | What it does |
| --- | --- |
| `npm run macos:run` | Builds and launches `dist/macos/Conduit.app` (Swift toolchain required). |
| `npm run macos:package` | Builds an unsigned preview `Conduit.dmg`, checksum, appcast and release notes. |
| `npm run conduit -- daemon start` | Watches the clipboard for exact envelopes. Uses `pbpaste`/`pbcopy`. |
| **Check Clipboard Once** / **Copy Agent Handshake** | Read and write the system clipboard. On Linux the handshake is shown for a manual copy instead. |
| `npm run extension:package` | Zips the browser extension (needs `/usr/bin/zip`). |

The menu-bar app starts three supervised children: the control panel
(`:47831`), the extension listener (`:3333`) and the clipboard daemon. They
have a deadman switch and exit if the parent app disappears.

### Demo data mode

Open the control panel with `?demo=1`, or choose **View demo data** in the
sidebar. A banner labels the page. Everything is in-memory sample data, so
approve and deny decisions are simulated in the tab. Demo mode never calls the
local API, never reads or writes the clipboard and never executes anything.
Without `?demo=1` the panel talks only to your real local services.

## How consent works

**Exact envelopes.** The clipboard daemon trims whitespace and acts only if the
entire clipboard is one valid Conduit envelope: a fenced `conduit` or
`conduit-json` block, or one raw JSON request object. A README, chat reply or
web page that merely *contains* a block is text, not consent.

**Reviews for untrusted requests.** An exact envelope without a live paired
session is never executed silently. It becomes a `conduit.review` approval
showing the claimed source, declared permissions, requested capabilities and
actions. **Approve once** runs those actions once under a narrow read-only
policy rooted at the project. It does not create a trusted session or widen
future policy.

**Sessions and nonces.** Trusted execution needs a paired session with a
permission profile, allowed roots and a one-shot nonce. Every successful result
returns `nextNonce`. Revoking a session kills its nonce.

**Profiles.**

- `read-only`: reads, listings and git inspection run; writes, patches and
  shell are denied.
- `edit-with-confirmation`: reads run; `file.write` and `file.patch` wait for
  approval; shell is denied.
- `shell-manual`: reads run; writes, patches and every `shell.run` wait for
  approval.

Confirmation-required actions create one shared approval record. The terminal
and the control panel are both approval surfaces for it, and the record stores
where the decision came from. Hard denials include project-root sandbox
violations and secret-looking filenames.

**Local-only API.** Every Conduit service binds `127.0.0.1`. The control panel refuses
to bind anything else, answers only loopback `Host` headers (DNS rebinding) and
rejects state-changing requests from other origins. The menu-bar app, curl and
the tests send no `Origin` and are unaffected.

A request looks like this:

```conduit
{
  "schema": "conduit.request.v1",
  "source": { "kind": "clipboard", "trust": "untrusted" },
  "permissions": [{ "kind": "filesystem", "scope": "project", "access": "read" }],
  "sessionId": "sess_...",
  "nonce": "call_...",
  "list": ".",
  "reason": "List the project root.",
  "risk": "low"
}
```

Compact shortcuts (`read`, `list`, `diff`, `status`, `write`, `patch`,
`shell`, `help`, `about`), the small-model dialect (`v`, `session`, `n`, `do`,
`why`), the agent handshake and the extension loop are documented in
[docs/agent-loop.md](docs/agent-loop.md).

## Health and logs

```sh
curl http://127.0.0.1:47831/api/status
curl http://127.0.0.1:3333/health        # extension bridge, when running
```

On macOS, service logs live in `~/Library/Logs/Conduit/`. Session, approval
and run state lives in `~/.conduit` (override with `CONDUIT_STATE_DIR`).
**Report Bug** in the control panel previews a redacted diagnostic bundle that
excludes clipboard contents, request payloads, file contents, nonces, API keys
and environment variables.

## Project status

Working today:

- TypeScript CLI/runtime, policy engine, session/nonce store, local tools and
  run logs
- exact-envelope clipboard daemon (macOS clipboard)
- control panel with approvals, review records and execution lifecycle,
  demo data mode and redacted diagnostics
- macOS menu-bar app with supervised services and approval notifications
- unsigned macOS preview DMG, with O+K-signed update manifests verified before
  an in-place update
- Chrome/Brave unpacked extension bridge with paired-session nonce enforcement
- deterministic agent-loop transcript harness and a protocol model eval harness
- Windows and Linux preview packages (launchers and metadata)

Not production-ready yet:

- Apple code signing and notarization
- clipboard support on Linux and Windows (the daemon uses `pbpaste`/`pbcopy`)
- native Windows and Linux tray apps
- a Chrome Web Store listing for the extension
- the same origin guard on the extension bridge (`:3333`) that the control
  panel now has
- sandboxed dry runs and trust analysis for higher-risk requests
- robust tab discard/throttle detection and live ChatGPT extension tests

See [NEXT_STEPS.md](NEXT_STEPS.md) for the buildout log and next gates.

## Release notes for maintainers

`npm run macos:package` writes `dist/macos/Conduit.dmg`, its `.sha256`,
`conduit-appcast.json` and `RELEASE_NOTES.txt`. Point release metadata at
hosted artifacts with:

```sh
CONDUIT_RELEASE_BASE_URL="https://github.com/owl-and-kestrel/conduit/releases/download/v0.0.1" npm run macos:package
```

Launch builds wrap the appcast in an `ok.signed-manifest.v1` envelope when
`OK_RELEASE_PRIVATE_KEY_PEM` and `OK_RELEASE_SIGNER` (the O+K
`sign-manifest.mjs`) are set. The menu-bar app pins the O+K publisher
identity, verifies the signed manifest and the DMG SHA-256, then installs in
place. It refuses to replace the app from an unsigned manifest. Operational
details are in [docs/launch-handoff.md](docs/launch-handoff.md).

The opt-in protocol model eval (`npm run eval:protocol`) needs
`GOOGLE_AI_STUDIO_API_KEY` in the environment and never runs in `npm test`.

## More docs

- [spec.md](spec.md): product and security contract
- [docs/agent-loop.md](docs/agent-loop.md): handshake, request dialects and the
  extension loop
- [extension/README.md](extension/README.md): extension install, behavior and
  telemetry
- [platforms/desktop-shell-contract.md](platforms/desktop-shell-contract.md):
  what every desktop shell must provide
- [implementation.md](implementation.md): the original v0 build guide (history)
- [docs/auth-troubleshooting.md](docs/auth-troubleshooting.md),
  [docs/extension-transport-plan.md](docs/extension-transport-plan.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Keep the loop small until it is boring.
