# Conduit — Local Capability Runner Spec

## 0. Purpose

Conduit is a local capability runner for executing permissioned action requests on a user’s machine.

It fills the gap between:

```txt
“Install this full auto-updating app with a release channel”
```

and:

```txt
“Open Terminal and paste this command”
```

Conduit gives software, webpages, documents, emails, chats, and AI agents a standard way to request local work through structured manifests, while leaving final authority with the user’s local machine.

The core primitive is:

```txt
arbitrary source
  -> Conduit request / manifest
  -> local policy review
  -> permissioned local execution
  -> auditable result
```

Conduit is arbitrary code execution by design. It is roughly comparable to running a downloaded program or a shell script. It is not a safety product and not a sandbox. Its bar is `curl | sh`, which is how people already run arbitrary code from the internet; Conduit aims to clear it.

What it adds is the trust gate: you know who is asking. Sources you trust (a paired session) run quietly. Anything else asks you once. A request cannot be replayed, and the macOS menu-bar app supervises the services it starts and stops their process trees when you quit.

Conduit decides who may ask; it does not sandbox what runs.

---

## 1. Relationship to Veyr

Conduit is generalized from the Veyr Runtime prototype.

Veyr proved the initial loop:

```txt
ChatGPT message
  -> structured tool request
  -> local harness execution
  -> tool result returned to ChatGPT
```

Conduit extracts the reusable substrate:

```txt
source-independent action manifest
  -> local daemon
  -> permission profile
  -> tool execution
  -> result channel
```

Veyr can become one Conduit client. ChatGPT can emit Conduit requests. But Conduit is not a ChatGPT wrapper.

Veyr is cognition.

Conduit is hands.

---

## 2. Product Thesis

Running real code on your own machine still assumes a power user: download an installer, open a terminal, follow setup steps. AI agents can now run code locally when they have a local connection, so the larger point is letting anyone run arbitrary code with one click, no installer, no terminal.

Direction, not built yet: a one-click "Start a server" flow, for example a multiplayer game button that runs the game's server code as a background process on your machine with no separate download or install; an optional "run clean" mode; and a reusable package that can stay behind and age off on its own. Cleanup is the job of whoever writes the code that runs.

People already run untrusted local actions through bad interfaces:

- terminal commands copied from docs
- `curl | bash`
- npm scripts
- GitHub issue snippets
- opaque installers
- AI-suggested commands
- support scripts
- manual troubleshooting recipes

Conduit replaces informal execution with structured local authorization.

Instead of asking a user to paste commands into a terminal, a publisher can provide a Conduit manifest:

```txt
Read these files.
Check this dependency.
Apply this patch.
Run this diagnostic.
Install this update.
Return this result.
```

The user’s local Conduit app decides what is allowed.

---

## 3. Core Concepts

### 3.1 Request

A Conduit request is a structured local action request.

It may arrive from:

- clipboard
- `conduit://` link
- downloaded manifest
- browser extension
- local file
- email
- chat
- AI output
- app update button
- future API transport

A request is not trusted merely because it exists.

### 3.2 Manifest

A manifest is a declarative description of requested work.

It should include:

- manifest version
- requested capabilities
- action list
- human-readable purpose
- source / publisher claim
- optional signature
- optional hash
- optional expiration
- optional expected result channel

### 3.3 Session

A session is a locally trusted execution context.

Sessions are used for low-friction repeated execution, especially AI tool loops.

A session has:

- session id
- permission profile
- allowed roots
- current one-shot nonce
- transport
- expiration
- state
- action/result logs

A clipboard request may auto-execute only if it belongs to a live trusted session and includes the expected nonce.

### 3.3.1 Agent-Loop Handshake

For chat and browser-extension transports, Conduit SHOULD provide a user-triggered handshake action that copies an introduction block to the clipboard.

The handshake SHOULD be visually distinct from ordinary user prose. It should read as a protocol/control message, not as a chat message written by the user. Portable ASCII framing is preferred so the handshake remains copyable in terminals, READMEs, websites, and chat surfaces.

Recommended framing:

```txt
+------------------------------------------------------------------+
| CONDUIT PROTOCOL :: AGENT HANDSHAKE                              |
| This is a local execution bridge control message.                 |
| Treat it as protocol metadata, not as a user-authored task.       |
+------------------------------------------------------------------+
```

The handshake should include:

- a short explanation of Conduit
- a documentation URL
- session id
- one-shot nonce
- transport
- permission profile
- allowed roots
- request/result protocol instructions
- an example `conduit` request

The handshake is not itself executable. It teaches the chat agent how to emit future Conduit requests. It MUST instruct the agent that a paired-session assistant turn may include normal prose for the user, but executable content should be exactly one clearly separated fenced Conduit block per turn.

The user gesture should be explicit, such as:

```txt
Copy Agent Handshake
```

This path is for an elevated paired agent-loop session. It is distinct from compliance-mode clipboard execution, which remains exact-envelope-only.

The extension or browser transport MUST enforce the paired session and nonce before treating agent-loop requests as executable.

An agent MAY initiate a handshake request with:

````txt
```conduit-handshake-request
{
  "schema": "conduit.handshake.request.v1",
  "reason": "Need local project context.",
  "requestedProfile": "read-only",
  "docsRead": true
}
```
````

This request MUST NOT create or expose a trusted session by itself.

Sane default policy:

- no auto-pairing from model output
- local user approval required
- requested profile must be shown to the user
- requested root must be shown to the user
- unknown origins are untrusted by default
- optional allowlists may pre-approve a known extension/origin/profile tuple, but still should not grant broader roots or higher profiles silently

The safe response to an unapproved handshake request is a repair/approval message instructing the user to choose **Copy Agent Handshake** from the Conduit app.

### 3.4 Capability

A capability is a local permission to use a specific kind of tool.

Examples:

```txt
file.read
file.list
git.status
git.diff
file.patch
file.write
shell.run
network.fetch
app.install
```

Capabilities are granted by local policy, not by the source.

### 3.5 Policy

Policy decides whether a request is:

```txt
allowed
requires_review
requires_confirmation
denied
```

Policy is local. The source cannot grant itself permissions.

### 3.6 Result

A result is the structured output of executed actions.

Results may be:

- copied to clipboard
- shown in the app
- returned to a browser extension
- written to log
- returned to an AI/chat session
- saved as an artifact

---

## 4. High-Level System Shape

```txt
Source
  -> clipboard / link / extension / file / API
  -> Conduit App
  -> Conduit Daemon
  -> Policy Engine
  -> Tool Registry
  -> Local Machine
  -> Result Channel
```

Components:

```txt
conduit/
  app/
  daemon/
  protocol/
  policy/
  tools/
  sessions/
  manifests/
  transports/
  state/
  tests/
```

---

## 5. Default Modes

### 5.1 Compliance Mode

Default mode.

Behavior:

- no page scraping
- no hidden browser automation
- clipboard/link mediated
- clipboard execution uses exact-envelope parsing only
- copied prose containing embedded Conduit blocks is ignored
- trusted sessions may auto-execute low-risk valid requests
- untrusted requests open manifest review
- edits require confirmation
- shell/manual commands require explicit approval
- all actions logged

This is the distributable default.

### 5.2 YOLO Mode

Advanced unsafe mode.

Behavior:

- may automate browser/page interaction
- may read compatible page state
- may paste/send results automatically
- may enable embedded Conduit block parsing for authenticated agent turns
- still obeys local permission profiles
- clearly labeled as unsafe

YOLO Mode is for local experimental use.

It should require deliberate activation.

### 5.3 Idiot Mode

Explicitly unsafe clipboard auto-execution mode.

Behavior:

- any valid clipboard Conduit request may execute according to global policy
- does not require a trusted live session
- still uses exact-envelope parsing by default
- embedded block parsing requires an additional unsafe setting
- still validates schema
- still applies hard deny rules unless further unsafe toggles are enabled
- always visibly indicated when active

Activation should require typed confirmation:

```txt
I AM THE IDIOT
```

Warning copy:

```txt
Idiot Mode automatically executes valid Conduit requests found on your clipboard,
including requests copied from webpages, emails, chats, documents, or AI outputs.

This is inherently unsafe. Your clipboard becomes an execution surface.

You are responsible for anything run in Idiot Mode.
```

### 5.4 Full Send / Nuclear Mode

Optional dev-only mode.

Behavior:

- global filesystem access
- shell auto-execution
- unsigned install/update manifests
- minimal confirmation

This should not be enabled in ordinary builds.

If included, it should be hidden behind developer config and extreme warnings.

---

## 6. Request Handling Rules

### 6.1 Trusted Session Request

A clipboard or transport request may auto-execute if all are true:

```txt
- exactly one request block exists
- JSON parses
- schema validates
- session id matches a live local session
- session is trusted / paired
- nonce matches current expected nonce
- nonce has not been used
- requested tools fit the session permission profile
- requested paths fit allowed roots
- action count fits budgets
- result size fits transport limits
```

### 6.2 Untrusted Request

If a request has no trusted live session:

```txt
- do not auto-execute
- parse and validate if possible
- open manifest review
- show claimed source, requested capabilities, actions, risks
- require explicit user decision
```

### 6.3 Idiot Mode Request

If Idiot Mode is enabled:

```txt
- valid clipboard requests may auto-execute without trusted session
- global policy still applies
- hard denials still apply
- every execution is logged
- status indicator must remain visible
```

---

## 7. Clipboard Transport

### 7.1 Purpose

Clipboard transport allows one-click-ish execution without browser scraping or terminal use.

Flow:

```txt
1. Source displays Conduit block.
2. User copies block.
3. Conduit daemon detects clipboard change.
4. Daemon validates request.
5. Daemon either executes, opens review, or denies.
6. Daemon updates clipboard with status or result.
7. User pastes result where needed.
```

### 7.2 Premature Paste Handling

When a valid call is accepted, Conduit should immediately replace the clipboard with a status message:

```txt
Conduit is still working.

The request was accepted and is executing.
Paste again when the result is ready, or open Conduit to view progress.
```

When complete, Conduit replaces the clipboard with the result.

### 7.3 Clipboard Safety

Clipboard watcher must not execute arbitrary text.

It may only execute:

- valid Conduit request blocks
- matching known schema
- with policy approval
- with session/nonce or explicit mode authorization

---

## 8. Links and Manifests

### 8.1 `conduit://` Links

Conduit should register a URL handler.

Examples:

```txt
conduit://run?manifest=https%3A%2F%2Fexample.com%2Fconduit%2Fsetup.json
conduit://install?manifest=https%3A%2F%2Fexample.com%2Fconduit%2Finstall.json
conduit://session/start?profile=read-only
```

Opening a link should not imply execution.

Default behavior:

```txt
link opened
  -> fetch/parse manifest
  -> show review
  -> apply local policy
  -> execute only after authorization
```

### 8.2 Inline Manifest

Clipboard blocks may include full manifest JSON.

Useful for AI/chat flows and small requests.

### 8.3 Remote Manifest

Clipboard blocks or links may reference a remote manifest.

Remote manifests should include a digest when possible.

```json
{
  "type": "conduit.intent.v1",
  "manifestUrl": "https://example.com/conduit/setup.json",
  "manifestSha256": "..."
}
```

Conduit should fetch the manifest itself and verify the digest if provided.

---

## 9. Trust, Identity, and Provenance

### 9.1 Clipboard Provenance Is Impossible

Copied text cannot prove where it came from.

Any copied block may falsely claim:

```json
{
  "publisher": "trusted.example.com"
}
```

Therefore, Conduit must treat clipboard provenance as untrusted.

### 9.2 Integrity

Hashes prove that bytes match expected bytes.

A hash does not prove who authored a manifest.

### 9.3 Authenticity

Signatures prove that some key signed a manifest.

A signature does not prove that the manifest is safe.

### 9.4 Trust UI

Conduit should distinguish:

```txt
Unverified
Hash verified
Signed by known key
Signed by trusted publisher
Expired signature
Signature mismatch
```

Important copy:

```txt
Verified means this payload was signed by this identity.
It does not mean the requested action is safe.
```

### 9.5 Future Signing

Future versions may support:

- Ed25519 signed manifests
- Sigstore/cosign-style signing
- transparency logs
- TUF-style update metadata
- SLSA provenance for installers/build artifacts

MVP may defer signing but should design manifest fields with signatures in mind.

---

## 10. Manifest Schema

### 10.1 Manifest Envelope

```ts
export interface ConduitManifest {
  type: 'conduit.manifest.v1'
  id?: string
  title: string
  description?: string
  publisher?: PublisherClaim
  source?: SourceClaim
  requestedCapabilities: string[]
  actions: ConduitAction[]
  expiresAt?: string
  resultMode?: ResultMode
  signature?: ManifestSignature
}
```

### 10.2 Publisher Claim

```ts
export interface PublisherClaim {
  name?: string
  id?: string
  url?: string
  publicKeyId?: string
}
```

### 10.3 Source Claim

```ts
export interface SourceClaim {
  kind?: 'clipboard' | 'link' | 'webpage' | 'email' | 'chat' | 'file' | 'app' | 'unknown'
  origin?: string
  label?: string
}
```

### 10.4 Action

```ts
export interface ConduitAction {
  id: string
  tool: string
  args: Record<string, unknown>
  reason?: string
  risk?: 'low' | 'medium' | 'high'
}
```

### 10.4.1 Compact Action Shortcuts

Conduit SHOULD accept a compact request form for simple model-authored calls,
then normalize it into canonical `ConduitAction[]` before policy evaluation.

The compact form is a usability layer, not a separate permission model.
Session, nonce, source, permissions, policy, sandboxing, and exact-envelope
requirements still apply.

Single-action examples:

```json
{ "do": "help" }
{ "do": ".help", "topic": "examples" }
{ "do": "about" }
{ "read": "README.md" }
{ "list": "." }
{ "diff": "src/index.ts" }
{ "status": true }
{ "write": "notes.txt", "content": "hello\n", "mode": "create" }
{ "patch": "diff --git ..." }
{ "shell": "npm test" }
```

These normalize to:

```ts
{
  id: string
  tool: 'conduit.help' | 'conduit.about' | 'file.read' | 'file.list' | 'git.diff' | 'git.status' | 'file.write' | 'file.patch' | 'shell.run'
  args: Record<string, unknown>
  reason?: string
  risk?: 'low' | 'medium' | 'high'
}
```

For multi-action requests, `do` MAY be an array of simple string actions:

```json
{ "do": ["list .", "read README.md", "status"] }
```

The `actions` array MAY also contain compact action objects. Implementations
SHOULD generate deterministic action IDs when a compact action omits `id`;
explicit stable IDs remain preferred for precise multi-action agent requests.

Conduit SHOULD expose low-risk protocol helper tools such as `conduit.help` and
`conduit.about` so initial handshakes can stay short. Rejection and repair
messages SHOULD mention the helper path, for example: use `.help` for examples.

### 10.5 Result Mode

```ts
export interface ResultMode {
  transport: 'clipboard' | 'app' | 'file' | 'extension' | 'none'
  format?: 'json' | 'markdown' | 'text'
}
```

### 10.6 Signature

```ts
export interface ManifestSignature {
  scheme: 'ed25519' | 'sigstore' | 'unknown'
  keyId?: string
  signature: string
  signedFields?: string[]
}
```

---

## 11. Session Schema

```ts
export interface ConduitSession {
  sessionId: string
  label: string
  createdAt: string
  expiresAt?: string
  state: 'active' | 'paused' | 'awaiting_result_paste' | 'expired' | 'revoked'
  transport: 'clipboard' | 'extension' | 'browser-yolo' | 'api'
  permissionProfile: string
  allowedRoots: string[]
  currentNonce: string
  usedNonces: string[]
  lastActionAt?: string
  metadata?: Record<string, unknown>
}
```

Sessions are owned by the local desktop app / daemon.

The source cannot create a trusted session by assertion.

---

## 12. Permission Profiles

Default profiles:

### 12.1 Read Only

Allows:

```txt
file.read
file.list
git.status
git.diff
```

### 12.2 Edit With Confirmation

Allows read-only tools automatically.

Requires confirmation:

```txt
file.patch
file.write
```

### 12.3 Shell Manual

Allows edit profile.

Requires explicit one-action arming:

```txt
shell.run
```

### 12.4 Installer Review

For install/update manifests.

Requires review of:

- source
- artifact URL
- hash/signature
- install location
- commands/actions
- rollback plan if available

### 12.5 Full Send

Unsafe.

Allows broad execution according to user-configured policy.

Should be disabled by default.

---

## 13. Tool System

### 13.1 Initial Tools

MVP tools:

```txt
file.read
file.list
git.status
git.diff
```

Next tools:

```txt
file.patch
file.write
```

Later tools:

```txt
shell.run
network.fetch
artifact.download
app.install
app.update
browser.open
notification.send
```

Future trust-analysis services MAY attach advisory evidence to approvals:

- LLM explanation of requested code, patches, commands, manifests, or tool plans
- sandboxed dry-run/test results for higher-risk requests
- risk summaries that highlight touched files, network use, persistence, secrets, or installer behavior

These services are advisory. They MUST NOT replace local policy enforcement,
sandboxing, signature checks, or explicit user approval.

### 13.2 Tool Definition

```ts
export interface ToolDefinition<TArgs = unknown> {
  name: string
  description: string
  risk: 'low' | 'medium' | 'high'
  schema: ZodSchema<TArgs>
  run(args: TArgs, context: ToolContext): Promise<ToolResultContent>
}
```

### 13.3 Tool Context

```ts
export interface ToolContext {
  runId: string
  sessionId?: string
  projectRoot?: string
  allowedRoots: string[]
  profile: PermissionProfile
  stateDir: string
}
```

---

## 14. Policy Rules

### 14.1 Hard Deny

Always deny by default:

```txt
unknown tools
paths outside allowed roots
sensitive credential reads
destructive shell commands
permission/config changes requested by a manifest
unsigned installer execution without review
network exfiltration of local files
```

### 14.2 Sensitive Paths

Default-sensitive patterns:

```txt
.env
.env.*
id_rsa
id_ed25519
*.pem
*.key
*.p12
credentials.json
secrets.*
```

### 14.3 Budgets

Default budgets:

```json
{
  "maxActionsPerRequest": 5,
  "maxTotalActionsPerSession": 100,
  "maxToolOutputChars": 30000,
  "maxRuntimeSeconds": 300,
  "maxClipboardResultChars": 30000
}
```

### 14.4 Output Caps

Tool output must be bounded.

Large outputs should be truncated with metadata:

```json
{
  "truncated": true,
  "returnedChars": 20000,
  "totalChars": 93211,
  "nextOffset": 20000
}
```

---

## 15. App UX

### 15.1 Desktop App Responsibilities

The desktop app is the consent/control plane.

It owns:

- mode selection
- session registry
- permission profiles
- allowed roots
- nonce state
- pending confirmations
- logs
- status indicators
- update availability
- panic switch
- YOLO / Idiot Mode toggles
- bug reporting and diagnostic export

The desktop app SHOULD be implemented as real platform apps for supported
operating systems. macOS may ship first, but Windows and Linux are product
targets, not merely CLI compatibility targets. Each app SHOULD expose the same
core safety controls: service health, approvals, sessions, logs, updates,
panic/stop controls, and explicit quit/minimize behavior for supervised
execution.

### 15.2 Bug Reports And Error Capture

Conduit SHOULD expose a **Report Bug** action from:

- the desktop menu/tray app
- the local control panel
- browser extension popup
- error and degraded-health screens

Bug reports SHOULD start as a local diagnostic bundle preview. Users must be
able to inspect what will be attached before it leaves the machine.

Diagnostic bundles SHOULD include:

- Conduit version and build channel
- operating system and app shell
- service health summary
- recent non-secret logs
- last transport and extension bridge status
- update manifest metadata
- run IDs, approval IDs, and action IDs related to the failure

Diagnostic bundles MUST NOT silently include:

- clipboard contents
- full request payloads
- file contents
- session nonces
- API keys
- environment variables
- credentials, tokens, or secret-looking values

Confirmation-required actions SHOULD be represented as durable local approval
requests visible in the app. The approval view SHOULD show at least:

- requested tool
- action id
- action args
- model-provided reason
- policy reason
- session id
- run id
- project root

When a terminal approval prompt is available, it SHOULD resolve the same durable
approval request shown in the app rather than creating a separate confirmation
path. Approving or denying from any UI MUST resolve the shared request for all
other approval surfaces and record the source of the decision.

Approving an action allows that single pending action to continue. Denying it
returns a denied tool result. Approval records MUST NOT broaden the session
profile, grant future approvals, or bypass hard-deny checks.

### 15.2 Minimal Control Panel

```txt
Conduit

Mode:
  Compliance Mode

Clipboard Watcher:
  Watching

Live Sessions:
  ChatGPT compliance run — read-only — active
  Local docs helper — edit-with-confirmation — idle

Recent Actions:
  file.read README.md — ok
  git.status — ok

Buttons:
  Pause Watcher
  Revoke All Sessions
  Open Logs
  Settings
```

### 15.3 Menu Bar / Tray

Menu items:

```txt
Conduit: Compliance Mode
Start/Stop Control App
Open Control Panel
Copy Agent Handshake
Start/Stop Clipboard Daemon
Check for Updates...
Result Ready
Revoke Sessions
Enable YOLO Mode...
Enable Idiot Mode...
Quit
```

The menu-bar app SHOULD supervise the daemon, browser-extension agent listener, and control surface, but MUST NOT become the execution engine. Execution remains in the daemon/runtime layer.

Supervised child services MUST have a deadman switch. If the menu-bar/tray parent process that launched them can no longer be observed, the control surface, agent listener, and daemon MUST stop themselves rather than continue executing in the background. A confirmed app quit MUST also terminate the supervised process tree.

Development build/run tooling SHOULD terminate stale Conduit service processes from the same installation or source checkout before launching a replacement preview app.

### 15.4 App Updates

The app SHOULD be update-aware even before full automatic replacement is implemented.

Minimum v0 behavior:

- check a release/update manifest
- show current version and available version
- show whether artifact signatures are present
- open the download page or artifact URL when the user approves
- never silently install an unsigned update

Future production behavior:

- signed update manifests
- signed and notarized app artifacts
- hash verification before install
- rollback-aware replacement
- explicit consent for major permission/profile changes

### 15.5 Status Visibility

Unsafe modes must be visible whenever active.

Examples:

```txt
⚠ YOLO MODE ACTIVE
⚠ IDIOT MODE ACTIVE — clipboard auto-execution enabled
```

---

## 16. Browser Extension

The extension is optional for compliance mode.

Its roles:

- show Conduit status in browser
- show pending/retrying/exhausted outbound delivery state
- offer a manual retry for a pending or exhausted outbound send
- provide ChatGPT-specific UX helpers
- optionally detect/copy Conduit blocks
- optionally paste results
- pair with the local daemon
- eventually support YOLO browser automation

Compliance mode should work without the extension.

### 16.1 Small-Model Request Forms

The canonical envelope remains the security contract, but agent-loop parsers MAY
accept simpler aliases before policy evaluation. Supported aliases SHOULD
normalize into the canonical action model and SHOULD NOT bypass session, nonce,
source, permission, policy, or logging requirements.

Examples:

```json
{ "v": "1", "session": "sess_...", "n": "call_...", "do": "list", "path": "." }
```

```json
{ "schema": "conduit.request.v1", "sessionId": "sess_...", "nonce": "call_...", "actions": ["read README.md", "status"] }
```

---

## 17. Repair Output

When Conduit rejects an executable-looking request envelope, it SHOULD emit a structured repair block.

Repair output is intended for chat agents and users. It should explain what failed without executing anything.

Format:

```txt
<<<CONDUIT_REPAIR_JSON
{
  "type": "conduit.repair.v1",
  "status": "rejected",
  "reason": "...",
  "code": "malformed_json",
  "expected": {
    "exactEnvelope": true,
    "schema": "conduit.request.v1"
  },
  "repairInstructions": [],
  "example": {}
}
CONDUIT_REPAIR_JSON>>>
```

Repair output SHOULD be used for:

- malformed JSON
- duplicate JSON keys
- multiple envelopes
- missing `schema`
- missing source metadata
- missing permissions
- missing session id or nonce
- invalid, expired, revoked, or replayed sessions

Repair output MUST NOT be treated as executable. It is feedback only.

---

## 18. Logging

Conduit should log:

- request received
- source/transport
- session id
- nonce used
- policy decision
- actions requested
- actions executed
- results
- denials
- confirmations
- errors

Per-run directory:

```txt
~/.conduit/runs/{runId}/
  request.json
  manifest.json
  policy.json
  actions.jsonl
  results.jsonl
  final.json
  clipboard.txt
```

Logs are local by default.

---

## 18. Security Posture

Conduit should be honest:

```txt
This is dangerous.
This can run local actions.
Do not enable unsafe modes casually.
```

But Conduit should also make the case:

```txt
People already execute unstructured local instructions.
Conduit makes those instructions structured, scoped, logged, and reviewable.
```

Core security principles:

```txt
Do not trust copied text.
Trust only local sessions, local policy, and verified signatures.
Do not infer actions from prose.
Do not allow sources to grant themselves permissions.
Make dangerous actions visible before convenient.
Keep a panic button.
Log everything.
```

---

## 19. MVP Acceptance Criteria

Conduit v0 is complete when:

1. User can install/run the local app.
2. App can watch clipboard.
3. App detects valid Conduit request blocks.
4. App ignores ordinary clipboard text.
5. App maintains trusted sessions with one-shot nonces.
6. Trusted session requests can auto-execute read-only tools.
7. Untrusted requests open manifest review.
8. App can copy “working” status to clipboard while executing.
9. App copies result to clipboard when complete.
10. App logs all requests/actions/results.
11. App denies outside-root file access.
12. App denies sensitive file reads.
13. App enforces permission profiles.
14. App exposes mode controls.
15. Idiot Mode exists but requires explicit typed confirmation.
16. A ChatGPT/Conduit workflow can use Conduit as its local execution layer.

---

## 20. First Demo

Demo task:

```txt
ChatGPT emits a Conduit request to read README.md from a project.
User copies the block.
Conduit validates session + nonce.
Conduit reads the file.
Conduit puts TOOL_RESULTS_JSON on clipboard.
User pastes result into ChatGPT.
ChatGPT summarizes the file.
```

This proves:

- clipboard transport
- session nonce
- local file tool
- result return
- ChatGPT-as-client without browser scraping

Second demo:

```txt
A webpage offers a conduit:// diagnostic link.
User opens it.
Conduit shows manifest review.
User approves read-only diagnostic.
Conduit runs file.list and git.status.
Conduit displays result.
```

This proves:

- arbitrary-source manifest
- review flow
- non-ChatGPT use case

---

## 21. Future Vision

Conduit can become a local standard for permissioned action manifests.

Future integrations:

- ChatGPT
- Claude
- Gemini
- local LLMs
- GitHub
- docs sites
- support portals
- installers
- app updaters
- internal company tooling
- Astrata agents

The long-term primitive:

```txt
Any sufficiently trusted text can ask your machine to do work.
Your machine remains the authority.
```

---

## Amendment: Exact Clipboard Envelope Parsing

Conduit clipboard execution MUST default to **exact-envelope parsing**.

When the daemon observes clipboard contents, it MUST NOT search arbitrary copied text for embedded Conduit blocks. The clipboard buffer is executable only if, after trimming leading and trailing whitespace, the entire clipboard contents are exactly one valid Conduit envelope.

### Rationale

Clipboard monitoring is intentionally a low-friction bridge, but it is also injection-prone. Users routinely copy large blobs of text from webpages, chats, documents, READMEs, issue comments, and support pages. If Conduit scans copied text for embedded executable blocks, a malicious or compromised source could hide a valid Conduit request inside otherwise ordinary text.

Conduit should treat the act of copying a standalone Conduit envelope as a deliberate consent-shaped gesture.

It is safe and often desirable for a webpage, README, support answer, or chat assistant message to explain what a Conduit block will do. The explanatory text is not the executable payload. If the UI lets the user copy the fenced Conduit block as a single unit, that copied block is sufficient; copying the whole surrounding paragraph, webpage section, README section, or chat response is not.

### Default Parser Rule

After trimming leading and trailing whitespace, the clipboard contents MUST match exactly one of the following allowed envelope forms:

1. A single fenced code block with language `conduit`, `conduit-json`, or another explicitly registered Conduit MIME/language tag.
2. A single canonical JSON Conduit request envelope.
3. A single Conduit deep link or compact signed envelope format, if supported by the daemon.

There MUST be no prose, HTML, comments, additional code blocks, or other non-envelope content before or after the envelope in the clipboard buffer. A markdown fence is allowed only when it is the envelope wrapper itself.

### Examples

Accepted:

```conduit
{
  "schema": "conduit.request.v1",
  "source": {
    "kind": "clipboard",
    "trust": "untrusted"
  },
  "permissions": [
    {
      "kind": "filesystem",
      "scope": "project",
      "access": "read"
    }
  ],
  "actions": [
    {
      "id": "list_project",
      "tool": "file.list",
      "args": {
        "path": "."
      }
    }
  ]
}
```

Accepted:

```json
{
  "schema": "conduit.request.v1",
  "source": {
    "kind": "clipboard",
    "trust": "untrusted"
  },
  "permissions": [],
  "actions": []
}
```

Rejected:

````markdown
Here is the command you should run:

```conduit
{
  "schema": "conduit.request.v1",
  "permissions": [],
  "actions": []
}
```

Thanks!
````

Accepted when the user copies only the code block from a larger assistant message:

````markdown
I am going to ask Conduit to list the project root so I can orient myself before making changes.

```conduit
{
  "schema": "conduit.request.v1",
  "source": {
    "kind": "clipboard",
    "trust": "untrusted"
  },
  "permissions": [],
  "actions": []
}
```
````

In this case, the assistant message may contain explanation, but the clipboard buffer seen by Conduit is only the fenced `conduit` block.

Rejected:

````markdown
Some copied README text.

```conduit
{
  "schema": "conduit.request.v1",
  "permissions": [],
  "actions": []
}
```
````

Rejected:

````markdown
```conduit
{
  "schema": "conduit.request.v1",
  "permissions": [],
  "actions": []
}
```

```conduit
{
  "schema": "conduit.request.v1",
  "permissions": [],
  "actions": []
}
```
````

### Security Requirements

The clipboard parser MUST:

- Trim only leading and trailing whitespace before envelope detection.
- Reject buffers containing more than one possible Conduit envelope.
- Reject buffers containing any non-envelope text.
- Reject malformed JSON.
- Reject duplicate JSON object keys.
- Reject comments, trailing commas, and non-standard JSON unless a specific non-JSON envelope format is being parsed.
- Enforce maximum clipboard envelope size.
- Require an explicit `schema` field.
- Require source metadata.
- Require declared permissions, even if the permission list is empty.
- Require stable action IDs for multi-action requests.
- Treat all clipboard-origin requests as untrusted unless they include a valid active paired-session nonce.

### Trusted Session Handling

Even for trusted paired sessions, exact-envelope parsing SHOULD remain the default.

A trusted session MAY allow a wrapper format only if:

- The wrapper itself is part of the canonical Conduit envelope format.
- The request includes a valid one-shot nonce.
- The daemon can bind the nonce to an active session, origin, and permission profile.
- The parsed executable payload is still structurally unambiguous.

The daemon MUST NOT treat arbitrary markdown prose containing a valid nonce-bearing Conduit block as executable by default.

### Authenticated Agent Parser

Conduit MAY retain a looser agent-turn parser that scans a larger assistant message for embedded Conduit protocol blocks, but that parser is an elevated session capability.

The agent-turn parser MUST NOT be used for default clipboard monitoring or Compliance Mode clipboard execution. It may be used only after the transport or session has already been authenticated and paired, such as a live browser-extension bridge, local API session, explicit agent loop started by the user, or YOLO/unsafe mode that visibly enables embedded-block parsing.

Compliance Mode MUST prefer exact-envelope parsing even for paired sessions unless the local user has enabled an explicit elevated parser setting. A valid nonce inside arbitrary markdown prose is not enough to make that prose executable.

The elevated parser should be bound to:

- an active paired session,
- a permission profile,
- an origin or transport identity when available,
- one-shot nonce handling where the transport is not otherwise session-bound,
- explicit local mode state showing that embedded agent messages may be interpreted.

In other words, the loose parser belongs to authenticated agent transports, not arbitrary clipboard text.

### Unsafe / Developer Option

Implementations MAY expose an unsafe option to parse embedded Conduit blocks from larger clipboard buffers.

This option MUST be disabled by default.

Recommended label:

> Parse embedded Conduit blocks from copied text

Recommended warning:

> Unsafe. Allows Conduit requests embedded inside larger copied text to be detected. This weakens injection resistance and may cause copied webpages, chats, READMEs, or support messages to become executable prompts. Leave disabled unless you are deliberately testing or debugging Conduit behavior.

For intentionally reckless profiles, this setting may be grouped under the broader unsafe execution profile, such as **Idiot Mode** or **Exceptionally Dangerous Mode**.

### Design Principle

The default clipboard gesture should be:

> Copy the Conduit request, and only the Conduit request.

That gesture is clear, inspectable, and consent-shaped.

Everything else is text.
