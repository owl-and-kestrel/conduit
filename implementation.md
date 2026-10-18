# Conduit — Implementation Guide

> **History.** This is the original v0 build guide, kept for design context.
> Most phases below are done, and some details changed during the build. For
> current behavior read the [README](README.md) and [spec.md](spec.md); for
> what is next read [NEXT_STEPS.md](NEXT_STEPS.md). "Veyr" is the earlier
> prototype that Conduit was generalized from.

## 0. Goal

Build Conduit v0: an installable local app/daemon that watches for Conduit requests, validates them, executes permitted local actions, and returns results through clipboard/app UI.

The first implementation should not attempt to solve every future trust problem.

The first implementation must prove:

```txt
valid request copied
  -> local daemon detects it
  -> policy validates it
  -> tool executes inside sandbox
  -> result copied back
  -> action logged
```

Use the sibling `veyr` project as the predecessor reference. Veyr already contains working pieces for:

- structured action schemas
- named protocol block parsing
- file tools
- sandboxing
- sensitive path denial
- result rendering
- output compaction
- run logs
- ChatGPT bridge loop

Conduit should extract and generalize those pieces.

---

## 1. Recommended Stack

Use TypeScript and Node for v0.

Recommended:

```txt
typescript
tsx
zod
vitest
commander
chokidar or clipboard polling helper
fs/promises
execa or child_process
```

For desktop apps:

```txt
macOS SwiftPM menu-bar shell
Windows tray shell
Linux tray/status shell
Tauri or native wrappers if a shared shell becomes cheaper than per-platform UI
```

Do not start with Electron unless needed.

For v0, a CLI plus desktop shells is the product shape. macOS is the first
working shell, but Windows and Linux should become real apps rather than
documentation-only ports.

---

## 2. Repository Structure

```txt
conduit/
  package.json
  tsconfig.json
  src/
    cli/
      index.ts
      commands/
        doctor.ts
        listen.ts
        run.ts
        session.ts
        inspect.ts
    daemon/
      clipboard-watcher.ts
      daemon.ts
      status.ts
    app/
      control-panel.ts
      modes.ts
    protocol/
      schemas.ts
      parse-request.ts
      render-result.ts
      blocks.ts
      canonical-json.ts
    manifests/
      fetch-manifest.ts
      verify-digest.ts
      verify-signature.ts
      review.ts
    sessions/
      session-store.ts
      nonce.ts
      pairing.ts
      profiles.ts
    policy/
      policy-engine.ts
      risk.ts
      sandbox.ts
      sensitive-paths.ts
      budgets.ts
    tools/
      types.ts
      registry.ts
      file-read.ts
      file-list.ts
      git-status.ts
      git-diff.ts
      file-patch.ts
      file-write.ts
      shell-run.ts
    state/
      paths.ts
      logs.ts
      config.ts
    transports/
      clipboard.ts
      link-handler.ts
      extension.ts
    util/
      ids.ts
      time.ts
      json.ts
      text.ts
  tests/
    protocol/
    sessions/
    policy/
    tools/
    daemon/
    integration/
  fixtures/
    fake-project/
```

MVP can omit `app/`, `manifests/verify-signature.ts`, and risky tools until needed, but create stable module boundaries early.

---

## 3. Build Phases

## Phase 0 — Repo Setup

Tasks:

1. Initialize TypeScript project.
2. Add `vitest`.
3. Add `commander`.
4. Add `zod`.
5. Add base CLI.
6. Add state path helpers.

Scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "dev": "tsx src/cli/index.ts",
    "conduit": "tsx src/cli/index.ts",
    "doctor": "tsx src/cli/index.ts doctor"
  }
}
```

Acceptance:

```txt
npm install
npm test
npm run build
npm run doctor
```

all work.

---

## Phase 1 — Protocol Schema

Implement:

```txt
src/protocol/schemas.ts
src/protocol/blocks.ts
src/protocol/parse-request.ts
src/protocol/render-result.ts
```

### 1.1 Request Block Format

For clipboard/chat flows, support named code blocks:

````txt
```conduit
{
  "type": "conduit.request.v1",
  "sessionId": "sess_...",
  "nonce": "call_...",
  "actions": []
}
```

### 1.1 Request Block Format

For clipboard/chat flows, support named code blocks. Use four-backtick fences in documentation when showing examples that themselves contain triple-backtick fences.

````txt
```conduit
{
  "type": "conduit.request.v1",
  "sessionId": "sess_...",
  "nonce": "call_...",
  "actions": []
}
```
````

Also support raw JSON beginning with a Conduit type for link/file/API flows.

### 1.2 Request Schema

Implement a Zod schema equivalent to:

````ts
export const ConduitActionSchema = z.object({
  id: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.unknown()),
  reason: z.string().optional(),
  risk: z.enum(['low', 'medium', 'high']).optional()
});

export const ConduitRequestSchema = z.object({
  type: z.literal('conduit.request.v1'),
  sessionId: z.string().optional(),
  nonce: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  requestedCapabilities: z.array(z.string()).optional(),
  actions: z.array(ConduitActionSchema).min(1),
  resultMode: z.object({
    transport: z.enum(['clipboard', 'app', 'file', 'extension', 'none']),
    format: z.enum(['json', 'markdown', 'text']).optional()
  }).optional()
}).superRefine((request, ctx) => {
  const seen = new Set<string>();
  for (const action of request.actions) {
    if (seen.has(action.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate action id: ${action.id}`,
        path: ['actions']
      });
    }
    seen.add(action.id);
  }
});
````

The parser also normalizes compact action shortcuts before schema validation.
This keeps the model-facing form small while preserving the canonical executor
contract:

````json
{ "do": "help" }
{ "do": ".help", "topic": "examples" }
{ "read": "README.md" }
{ "list": "." }
{ "diff": "src/index.ts" }
{ "status": true }
{ "write": "notes.txt", "content": "hello\n", "mode": "create" }
{ "patch": "diff --git ..." }
{ "shell": "npm test" }
````

For multiple actions, `actions` may contain compact objects:

````json
{
  "actions": [
    { "id": "list_project", "list": "." },
    { "id": "read_readme", "read": "README.md" }
  ]
}
````

For simple multi-action requests, `do` may be an array:

````json
{ "do": ["list .", "read README.md", "status"] }
````

All compact forms normalize to `actions: [{ id, tool, args, reason?, risk? }]`
before policy evaluation.

### 1.3 Parse Result

````ts
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'none' | 'multiple' | 'malformed'; error?: string };
````

Rules:

```txt
- ignore ordinary clipboard text
- accept exactly one Conduit block
- reject multiple blocks
- reject malformed JSON
- reject invalid schema
- never infer actions from prose
```

Acceptance tests:

```txt
parses valid conduit block
ignores non-Conduit text
rejects duplicate action ids
rejects malformed JSON
rejects multiple Conduit blocks
requires actions array
requires action args
```

---

## Phase 2 — State Paths and Logs

Implement:

```txt
src/state/paths.ts
src/state/logs.ts
src/state/config.ts
```

Default state:

```txt
~/.conduit/
  config.json
  sessions.json
  runs/
  logs/
```

Run directory:

```txt
~/.conduit/runs/{runId}/
  request.json
  policy.json
  actions.jsonl
  results.jsonl
  final.json
  clipboard.txt
```

Acceptance:

```txt
- run ids are sortable
- logs are append-only
- state dir can be overridden with CONDUIT_STATE_DIR
```

---

## Phase 3 — Session Store and Nonces

Implement:

```txt
src/sessions/session-store.ts
src/sessions/nonce.ts
src/sessions/profiles.ts
```

### 3.1 Session Schema

````ts
export interface ConduitSession {
  sessionId: string;
  label: string;
  createdAt: string;
  expiresAt?: string;
  state: 'active' | 'paused' | 'awaiting_result_paste' | 'expired' | 'revoked';
  transport: 'clipboard' | 'extension' | 'browser-yolo' | 'api';
  permissionProfile: string;
  allowedRoots: string[];
  currentNonce: string;
  usedNonces: string[];
  lastActionAt?: string;
}
````

### 3.2 Nonce Rules

```txt
- generate cryptographically random nonce
- each session has exactly one current nonce
- request must match current nonce
- consume nonce before execution
- never reuse consumed nonce
- result includes next nonce
```

### 3.3 CLI

Commands:

```txt
conduit session create --label "ChatGPT" --profile read-only --root /path
conduit session list
conduit session revoke <id>
```

Output should include a starter request block or session descriptor.

Acceptance tests:

```txt
creates session
validates current nonce
rejects stale nonce
rejects unknown session
rejects revoked session
rotates nonce after accepted call
```

---

## Phase 4 — Permission Profiles and Policy Engine

Implement:

```txt
src/policy/policy-engine.ts
src/policy/risk.ts
src/policy/budgets.ts
src/sessions/profiles.ts
```

### 4.1 Default Profiles

````ts
export const PROFILES = {
  'read-only': {
    autoAllow: ['file.read', 'file.list', 'git.status', 'git.diff'],
    requireConfirmation: [],
    deny: ['file.patch', 'file.write', 'shell.run']
  },
  'edit-with-confirmation': {
    autoAllow: ['file.read', 'file.list', 'git.status', 'git.diff'],
    requireConfirmation: ['file.patch', 'file.write'],
    deny: ['shell.run']
  },
  'shell-manual': {
    autoAllow: ['file.read', 'file.list', 'git.status', 'git.diff'],
    requireConfirmation: ['file.patch', 'file.write', 'shell.run'],
    deny: []
  }
};
````

### 4.2 Policy Decision

````ts
export type PolicyDecision =
  | { decision: 'allow' }
  | { decision: 'requires_review'; reason: string }
  | { decision: 'requires_confirmation'; reason: string }
  | { decision: 'deny'; reason: string };
````

### 4.3 Core Rules

Trusted session:

```txt
- allow only tools in profile
- enforce allowed roots
- enforce budgets
- deny sensitive reads
```

Untrusted request:

```txt
- no auto-execute
- return requires_review
```

Idiot Mode:

```txt
- allow valid clipboard requests according to global profile
- still apply hard deny rules
```

Acceptance tests:

```txt
trusted read-only session allows file.read
trusted read-only session denies file.write
untrusted request requires review
Idiot Mode allows valid request under global profile
outside-root path denied
sensitive path denied
unknown tool denied
```

---

## Phase 5 — Local Tools

Port/adapt from the sibling `veyr` project.

Implement first:

```txt
file.read
file.list
git.status
git.diff
```

### 5.1 Sandbox

Implement:

```txt
src/policy/sandbox.ts
```

Rules:

```txt
- resolve real project root
- resolve requested path
- allow missing paths only for create/write operations
- deny paths outside allowed roots
```

### 5.2 Sensitive Paths

Implement:

```txt
src/policy/sensitive-paths.ts
```

Patterns:

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

### 5.3 file.read

Args:

````ts
{
  path: string;
  maxChars?: number;
  offset?: number;
  startLine?: number;
  endLine?: number;
}
````

Behavior:

```txt
- UTF-8 only
- default maxChars 20000
- max maxChars 100000
- include metadata
- include nextOffset if truncated
```

### 5.4 file.list

Args:

````ts
{
  path?: string;
  depth?: number;
  glob?: string;
  maxItems?: number;
}
````

Behavior:

```txt
- default path "."
- default depth 2
- ignore .git, node_modules, dist, build, .next, coverage
- cap max items
- include truncation metadata
```

### 5.5 git.status

Run:

```txt
git status --short --branch
```

### 5.6 git.diff

Run:

```txt
git diff -- {path?}
```

Include max char cap.

Acceptance tests:

```txt
file.read inside root works
file.read outside root denied
file.read .env denied
file.read truncates
file.read offset continues
file.list ignores node_modules
file.list caps output
git.status works in repo
git.status handles non-repo gracefully
git.diff truncates
```

---

## Phase 6 — Clipboard Watcher

Implement:

```txt
src/daemon/clipboard-watcher.ts
src/transports/clipboard.ts
src/daemon/daemon.ts
```

### 6.1 MVP Polling

Use polling first.

Behavior:

```txt
- read clipboard every 500ms or 1000ms
- hash last clipboard content
- ignore unchanged content
- parse changed content
- if no request, do nothing
- if valid request, pass to policy/executor
```

Do not over-optimize.

### 6.2 Status Stub

When a request is accepted for execution, immediately write status to clipboard:

```txt
Conduit is still working.

The request was accepted and is executing.
Paste again when the result is ready.

Run: {runId}
Session: {sessionId}
```

### 6.3 Result Clipboard

When complete, write:

```txt
Conduit results:

<<<CONDUIT_RESULTS_JSON
{ ... }
CONDUIT_RESULTS_JSON>>>
```

For ChatGPT/Conduit compatibility, optionally support rendering as:

```txt
Tool results from the harness:

<<<TOOL_RESULTS_JSON
{ ... }
TOOL_RESULTS_JSON>>>
```

### 6.4 Duplicate Prevention

Rules:

```txt
- consume nonce before execution
- store clipboard hash of accepted request
- ignore same request hash if seen
- do not execute while session state is awaiting_result_paste unless explicitly configured
```

Acceptance tests:

```txt
ordinary clipboard ignored
valid request detected
accepted request writes working status
result replaces status
same nonce cannot execute twice
same clipboard content cannot execute twice
```

---

## Phase 7 — Request Execution Pipeline

Implement:

```txt
src/daemon/execute-request.ts
```

Pipeline:

```txt
parse request
create run id
load session if sessionId exists
evaluate policy
if requires_review:
  open review / print review
if requires_confirmation:
  create shared approval request and expose it to terminal/app approval surfaces
if denied:
  render denial result
if allowed:
  consume nonce if session request
  execute actions in order
  log actions/results
  rotate nonce
  render results
```

Confirmation-required execution writes pending approval records under the
Conduit state directory. The control app lists those records, and interactive
terminal runs also attach a terminal prompt to the same record. Approving or
denying from any surface resolves the single pending action, records the decision
source, and clears the request from pending UI. An approval is single-use for the
pending action; it does not modify the session profile or bypass hard denials.

### 7.1 Result Schema

````ts
export interface ConduitResultBlock {
  type: 'conduit.results.v1';
  runId: string;
  sessionId?: string;
  nonceUsed?: string;
  nextNonce?: string;
  results: ToolResult[];
}
````

### 7.2 Tool Result

````ts
export interface ToolResult {
  id: string;
  tool: string;
  status: 'ok' | 'error' | 'denied' | 'requires_confirmation' | 'requires_review';
  content?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}
````

---

## Phase 8 — CLI

Implement:

```txt
conduit doctor
conduit listen
conduit run --file request.json
conduit session create
conduit session list
conduit session revoke
conduit inspect <runId>
```

### 8.1 doctor

Checks:

```txt
state dir
clipboard read/write access
tool registry
session store
config
```

### 8.2 listen

Starts daemon:

```txt
conduit listen
conduit listen --profile read-only
conduit listen --idiot-mode
```

Should show:

```txt
Conduit listening.
Mode: Compliance
Clipboard watcher: active
Sessions: 1 active
```

### 8.3 run

Runs a request file manually.

Useful for tests and debugging.

---

## Phase 9 — Manifest Review

Implement after core session loop works.

Files:

```txt
src/manifests/review.ts
src/manifests/fetch-manifest.ts
src/transports/link-handler.ts
```

### 9.1 Review Display

For untrusted requests show:

```txt
Conduit Request

Title:
Setup Project

Claimed Source:
example.com

Trust:
Unverified

Requested capabilities:
file.read
git.status

Actions:
1. file.read package.json
2. git.status

Decision:
[Deny] [Run Once] [Trust Source Later]
```

### 9.2 CLI Review First

MVP can review in terminal.

Desktop UI later.

### 9.3 Link Handler

Register `conduit://` later. Do not block clipboard MVP on URL handler packaging.

---

## Phase 10 — Desktop App / Control Plane

After CLI works, add a small native menu-bar app first. Tauri can still be a later richer shell if needed.

Responsibilities:

```txt
- start/stop daemon
- start/stop local control app
- open control panel
- copy agent-loop handshake
- show mode
- show live sessions
- show pending reviews
- show pending confirmations
- show recent action log
- check for app updates
- configure allowed roots
- configure permission profiles
- enable YOLO / Idiot Mode
```

Do not put execution logic in UI.

The daemon owns execution.

The app owns consent UX.

Current local preview:

```txt
macos/ConduitMenuBar/
script/build_and_run.sh
npm run macos:build
npm run macos:run
```

The local preview stages `dist/macos/Conduit.app`, supervises the Node control app, extension agent listener, and clipboard daemon, and checks `website/releases/conduit-appcast.json` unless `CONDUIT_UPDATE_MANIFEST_URL` is set. Supervised services receive `CONDUIT_PARENT_PID` and exit if that menu-bar parent disappears, so closing the app cannot leave local execution processes running silently. Run modes of the local build/run script stop only the app running from this checkout's bundle and that app's child processes (exact executable path, then its process tree, never a name or command-line pattern); `--build-only` stops nothing. Before starting Control (47831) or the agent listener (3333), the app stops a process already holding that port only when it is in the app's own process tree, or is that Conduit service running from this checkout or app bundle (its resolved working directory is the checkout itself, or its executable is inside the checkout or bundle); a listener from another checkout or an installed Conduit is left running and reported (`ListenerOwnership` in `ConduitMenuBarCore`).

Agent-loop handshake:

```txt
src/protocol/render-agent-handshake.ts
POST /api/agent-handshake
Copy Agent Handshake
```

The handshake creates an `extension` session and copies a self-contained introduction for a real chat tab. It includes an ASCII Conduit protocol card, session id, nonce, allowed roots, profile, docs URL, protocol rules, and an example request. This is not compliance-mode clipboard execution; it is the start of an elevated paired agent loop. The card framing is intentional: Conduit control messages should look like protocol metadata rather than user-authored prose.

Deterministic transcript harness:

```txt
src/runtime/agent-loop-harness.ts
tests/e2e/agent-loop-harness.test.ts
```

The harness creates a real paired `extension` session, feeds scripted assistant
turns through `processListenTurn`, captures outbound Conduit messages, and
refreshes the active nonce between turns. It is the local browser-free lab bench
for agent-loop scenarios: prose plus one `conduit` block, nonce rotation,
structured repair, `.help` recovery, result rendering, and final run logs.

---

## Phase 11 — ChatGPT Extension

Optional adapter.

Purpose:

```txt
- status indicator
- result ready indicator
- easier copy/paste workflow
- later YOLO automation
```

Implemented bridge UX:

- popup reads `http://127.0.0.1:3333/health`
- popup surfaces tab heartbeat, outbound queue/send/retry state, and last errors
- popup can manually retry pending, retrying, or exhausted outbounds through `/api/conduit-retry`
- control panel overview mirrors bridge health and exposes the same retry path

Compliance mode should not depend on the extension.

The extension can be added after clipboard daemon works.

---

## Phase 12 — Packaging

### 12.1 macOS v0

Options:

```txt
npm global CLI first
native SwiftPM menu-bar preview
Tauri app later if richer shell is needed
```

Initial local install may be:

```txt
npm install -g conduit-local
```

or repo-local:

```txt
npm run build
npm run macos:build
npm link
conduit listen
```

For local app preview:

```txt
npm run macos:build
open dist/macos/Conduit.app
```

Production packaging still needs signing, notarization, signed update metadata, artifact hashing, and a replacement/rollback story.

### 12.2 Cross-Platform App Primer

The app shell is the user's safety dashboard. Each supported platform should
offer the same core controls even if the native packaging differs:

- run state for the control app, clipboard daemon, and agent listener
- pending approvals and native notifications
- copy agent handshake
- open control panel, logs, docs, and downloads
- check for updates and open release artifacts only after hash/signature review
- quit/minimize choice that makes supervised execution state explicit
- report a bug with a redacted diagnostic bundle preview

Bug reporting is part of the safety story. Every shell and browser surface
should have a route to report failures, especially when Conduit is handling
autonomous execution. Reports should include version, platform, service health,
recent non-secret logs, last transport status, update metadata, and action/run
IDs. Reports must not silently include clipboard contents, request payloads,
file contents, session nonces, API keys, or secrets.

### 12.3 URL Handler

For Tauri, register `conduit://` custom protocol.

For CLI-only v0, skip URL handler.

### 12.4 Native Messaging

Only needed for browser extension integration.

Do not block core v0 on native messaging.

---

## 13. Testing Strategy

### 13.1 Unit Tests

Protocol:

```txt
parse valid request
reject malformed
reject duplicate action ids
reject multiple blocks
ignore normal text
```

Sessions:

```txt
create session
consume nonce
rotate nonce
reject stale nonce
reject revoked session
```

Policy:

```txt
trusted session allow
untrusted review
Idiot Mode auto path
outside root denied
sensitive path denied
unknown tool denied
```

Tools:

```txt
file.read
file.list
git.status
git.diff
```

Clipboard:

```txt
detect request
ignore unchanged clipboard
write status
write result
prevent replay
```

### 13.2 Integration Tests

Fake clipboard integration:

```txt
1. create session
2. render request block with nonce
3. feed clipboard watcher
4. execute file.read
5. verify result
6. verify nonce rotation
7. retry old request
8. verify denial
```

Untrusted manifest integration:

```txt
1. feed unsigned request without session
2. verify review required
3. approve once
4. execute low-risk action
5. log result
```

---

## 14. First Milestone Checklist

Milestone 1: Local trusted session read loop.

Required:

```txt
- repo setup
- protocol parser
- session store
- nonce rotation
- read-only permission profile
- file.read
- file.list
- sandbox
- sensitive path denial
- clipboard watcher
- working status clipboard
- result clipboard
- logs
- tests
```

Demo:

```txt
conduit session create --label ChatGPT --profile read-only --root /path/to/conduit
conduit listen
```

Copy:

````txt
```conduit
{
  "type": "conduit.request.v1",
  "sessionId": "sess_...",
  "nonce": "call_...",
  "actions": [
    {
      "id": "read_readme",
      "tool": "file.read",
      "args": {
        "path": "README.md"
      },
      "reason": "Need project overview."
    }
  ],
  "resultMode": {
    "transport": "clipboard",
    "format": "json"
  }
}
```
````

Expected:

```txt
clipboard immediately becomes “Conduit is still working...”
then becomes CONDUIT_RESULTS_JSON
old request cannot execute again
logs exist
```

---

## 15. Second Milestone Checklist

Milestone 2: Untrusted request review.

Required:

```txt
- untrusted request detection
- manifest review display
- run once approval
- denial result
- claimed source display
- requested capability display
```

Demo:

```txt
copy unsigned Conduit request with no session
Conduit opens review
user approves
Conduit executes read-only action
```

---

## 16. Third Milestone Checklist

Milestone 3: ChatGPT compatibility adapter.

Required:

```txt
- render results as TOOL_RESULTS_JSON option
- generate Conduit-compatible request examples
- optional extension status UI
- docs explaining ChatGPT copy/paste workflow
```

Demo:

```txt
ChatGPT emits conduit request
user clicks copy
Conduit runs
user pastes result
ChatGPT continues
```

---

## 17. Implementation Notes from Veyr

Port carefully from the sibling `veyr` project:

Useful modules:

```txt
src/protocol/schemas.ts
src/protocol/extract-protocol-blocks.ts
src/protocol/render-results.ts
src/tools/file-read.ts
src/tools/file-list.ts
src/tools/git-status.ts
src/tools/git-diff.ts
src/policy/sandbox.ts
src/policy/sensitive-paths.ts
src/state/logs.ts
src/state/paths.ts
src/util/ids.ts
```

Changes needed:

```txt
- rename protocol from veyr-call to conduit
- replace ChatGPT run-loop assumptions with generic request execution
- add sessions and nonces
- add untrusted manifest review path
- split result rendering into Conduit-native and ChatGPT-compatible modes
- add clipboard watcher as first transport
- keep browser automation out of core
```

---

## 18. Do Not Build Yet

Do not build in v0:

```txt
full browser automation
automatic ChatGPT page scraping
signed manifest verification
TUF/Sigstore integration
installer execution
shell auto-execution
multi-machine sync
cloud accounts
payments
team permissions
mobile app
full app updater
```

These are later.

The v0 win is:

```txt
copy block
run local action
paste result
```

---

## 19. Product Warnings

Docs should be blunt.

Suggested copy:

```txt
Conduit can run actions on your computer.

Do not run Conduit requests from sources you do not trust.
Do not enable unsafe modes unless you understand the risk.
Conduit makes local execution more structured and auditable, not magically safe.
```

For Idiot Mode:

```txt
Idiot Mode automatically executes valid Conduit requests from your clipboard.

This is intentionally unsafe. A webpage, email, document, chat, AI output, or remote desktop session may place executable Conduit requests on your clipboard.

Enable this only if you understand that your clipboard becomes an execution surface.

Type I AM THE IDIOT to continue.
```

---

## 20. Final Acceptance Criteria for v0

Conduit v0 is ready when:

1. `conduit doctor` passes.
2. `conduit listen` watches clipboard.
3. Ordinary clipboard text is ignored.
4. Valid trusted session request executes read-only tools.
5. Nonce replay is denied.
6. Result is copied back to clipboard.
7. Working status appears while execution runs.
8. Untrusted request opens review instead of executing.
9. Sensitive paths are denied.
10. Outside-root paths are denied.
11. Logs are written locally.
12. Tests cover parser/session/policy/tools/clipboard loop.
13. ChatGPT copy/paste workflow works manually.
14. Idiot Mode exists only behind explicit typed confirmation.
```
