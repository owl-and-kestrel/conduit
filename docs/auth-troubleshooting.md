# Auth Troubleshooting Plan

Conduit currently has three auth-adjacent paths:

1. `npm run login:system`
   Opens ChatGPT in the user's real default browser with no automation.
2. `npm run login`
   Launches a Playwright-controlled persistent browser on bundled Chromium
   (`npm run login:chrome` uses the installed Chrome channel instead).
3. `npm run conduit -- run --transport clipboard ...`
   Uses the real browser for ChatGPT and manually copies messages through the terminal.

The fake loop and clipboard loop prove the core runtime is tractable. Browser-controlled ChatGPT auth remains the biggest transport risk.

## Observed Issues

### Playwright Chromium Auth Challenge

Bundled Playwright Chromium can land on:

```txt
chatgpt.com/api/auth/error
```

with a Cloudflare "Verify you are human" prompt.

### Playwright Chrome Auth Challenge

Installed Chrome launched by Playwright can still show:

```txt
Chrome is being controlled by automated test software
```

and land on the same Cloudflare verification flow.

This means `--channel chrome` improves browser compatibility but does not make the session equivalent to a normal user browser.

## Boundary

Do not attempt to bypass, evade, or automate Cloudflare or ChatGPT auth checks.

Allowed:

- opening a normal system browser for human login
- asking the user to complete verification manually
- documenting fallback flows
- detecting login failure and giving clear next steps
- using clipboard transport when browser automation is blocked

Not allowed:

- stealth automation
- CAPTCHA solving
- modifying browser fingerprints to evade detection
- scraping hidden auth state
- extracting cookies from the user's regular browser profile
- bypassing rate limits or site security boundaries

## Desired UX

Eventually, Conduit should behave like:

1. User opens the app.
2. App checks whether a usable ChatGPT transport exists.
3. If not signed in, app prompts the user to sign in.
4. If Playwright login is blocked, app offers:
   - open system browser
   - use clipboard mode
   - retry Playwright later
5. App explains what is and is not automated.

For now, implement this behavior in CLI form.

## Implementation Plan

### Phase 1 — Diagnose Transport State

Add a command:

```txt
npm run conduit -- auth:doctor
```

It should check:

- system browser open path works on macOS
- Playwright is installed
- bundled Chromium can launch
- installed Chrome channel can launch, if present
- persistent profile paths exist:
  - `~/.conduit/browser-profiles/chatgpt`
  - `~/.conduit/browser-profiles/chatgpt-chrome`
- whether ChatGPT composer can be detected in each Playwright profile
- current URL if composer is not detected

Acceptance:

- command exits 0 if diagnostics complete
- prints clear statuses
- never requires successful ChatGPT login
- never tries to bypass verification

Suggested output shape:

```txt
Auth doctor
system browser: available
playwright chromium: launches
playwright chrome: launches
profile chromium: exists
profile chrome: exists
chatgpt chromium: blocked at /api/auth/error
chatgpt chrome: blocked at /api/auth/error
recommended next step: npm run login:system + clipboard transport
```

### Phase 2 — Make Login Outcomes Explicit

Improve `login` command output:

```txt
npm run login
npm run login:chrome
npm run login:chromium
```

After opening the page, detect one of:

- composer found: login likely usable
- URL includes `/api/auth/error`: auth challenge or failure
- page text includes `Verify you are human`: human verification required
- timeout: unknown login state

Acceptance:

- on success, prints "ChatGPT composer detected"
- on auth challenge, prints a helpful explanation and fallback command
- on timeout, prints the current URL and suggests `auth:doctor`

Do not close the browser automatically before the user can inspect it.

### Phase 3 — Prefer System-Browser + Clipboard For Real-Chat Spike

Document and optimize this flow:

```txt
npm run login:system
npm run conduit -- run --transport clipboard --project fixtures/fake-project --task "Read README.md and summarize it."
```

Improve clipboard mode as needed:

- print every outbound Conduit message
- print every inbound ChatGPT message
- clearly label direction:
  - `Conduit -> ChatGPT`
  - `ChatGPT -> Conduit`
- never silently overwrite clipboard without printing the content

Acceptance:

- user can complete a real ChatGPT protocol loop without Playwright auth
- run logs include the transcript
- user always knows which message to paste where

### Phase 4 — Add Transport Selection Guidance

Add `transport:recommend` or fold into `auth:doctor`.

Recommendation logic:

1. If Playwright composer works, recommend `--transport chatgpt`.
2. If system browser opens but Playwright auth is blocked, recommend `--transport clipboard`.
3. If no browser is available, recommend fake transport only.

Acceptance:

- recommendation is explicit and actionable
- no false claim that ChatGPT browser transport is ready when auth is blocked

### Phase 5 — Future UI Behavior

When a local UI/app shell exists:

- show auth state as a visible status
- provide buttons:
  - Open System Browser
  - Try Playwright Login
  - Use Clipboard Mode
  - Run Auth Doctor
- show a short explanation if browser automation is blocked
- keep clipboard mode available as a first-class fallback

## Testing Plan

Unit tests:

- auth diagnosis status formatter
- recommendation logic
- URL classification:
  - `/api/auth/error`
  - `https://chatgpt.com/`
  - composer detected
  - timeout

Manual tests:

```txt
npm run build
npm test
npm run conduit -- auth:doctor
npm run login:system
npm run login
npm run login:chrome
npm run conduit -- run --transport clipboard --project fixtures/fake-project --task "Read README.md and summarize it."
```

Do not require live ChatGPT auth in CI.

## Current Recommendation

Until Playwright auth is reliable, treat this as the blessed real-chat path:

```txt
npm run login:system
npm run conduit -- run --transport clipboard --project fixtures/fake-project --task "Read README.md and summarize it."
```

Browser automation should remain a transport-hardening project, not a blocker for protocol/runtime work.

## Long-Term Transport Alternatives Analysis

If Playwright-driven automation proves permanently brittle due to anti-bot measures like Cloudflare, and given the core constraint that we **must preserve the organic ChatGPT web surface** (to access the user's specific Chat data, personalization, and memory), the following alternative architectures represent the possible paths forward:

### Principledness Summary

Principled approaches:

1. **System browser + clipboard**
   This is the current blessed fallback. It is explicit, user-mediated, and does not attempt to hide automation from auth systems.
2. **Bookmarklet bridge**
   This is conceptually principled because the user logs in normally and explicitly activates the bridge in the page. It may be technically brittle due to CSP, WebSocket, and DOM changes.
3. **Browser extension / native messaging bridge**
   This was initially rejected for installation friction, but it is likely the most principled long-term app architecture if Conduit needs a durable bridge into the organic ChatGPT tab.
4. **macOS AppleScript / JXA**
   This is acceptable as a Mac-only experiment if it remains visible and user-controlled. It should not be framed as "Cloudflare cannot see this"; the better framing is "auth happens in the user's normal browser session."

Not principled:

1. **Stealth plugins / fingerprint evasion**
   This conflicts with the boundary above. Do not pursue it.
2. **Cookie extraction from the user's normal browser profile**
   This conflicts with the boundary above. Do not pursue it.
3. **CAPTCHA solving or anti-bot bypass**
   This conflicts with the boundary above. Do not pursue it.

Recommended direction:

```txt
now:      system browser + clipboard
next:     auth:doctor + better manual transport UX
research: bookmarklet bridge
later:    signed/packaged extension or native messaging bridge
avoid:    stealth/fingerprint/CDP bypass work
```

### 1. The Bookmarklet Bridge (Recommended "Clean Web" Path)
Instead of a full browser extension, we use a simple JavaScript Bookmarklet.
- **How it works:** The user drags a script to their bookmarks bar. They open Chrome/Safari to ChatGPT naturally, and click the bookmark. The script injects itself and opens a secure local WebSocket connection to the local Conduit CLI (e.g., `ws://localhost:8080`).
- **Pros:** Zero installation overhead. Runs entirely inside the organic, Cloudflare-approved browser tab. The CLI sends JSON instructions over the socket, and the bookmarklet manipulates the DOM (`click()`, `fill()`) and streams the responses back.
- **Cons:** Requires the user to manually click the bookmark once per session to "tether" the web app to the local terminal.
- **Principledness:** Good, if it remains user-activated and transparent.
- **Technical risks:** ChatGPT's Content Security Policy may block connections to localhost, including WebSocket connections. DOM selectors remain brittle. Browser behavior may differ across Chrome, Safari, and Firefox.
- **Suggested spike:** Build a tiny local WebSocket server plus bookmarklet that only sends page title/current URL first. Then test whether ChatGPT's page can connect to it before implementing DOM reading/writing.

### 2. macOS AppleScript / JXA (The OS-Native Path)
Using macOS's built-in automation layers to control the actual, daily-driver browser (Safari or Chrome) without WebDriver binaries.
- **How it works:** Conduit runs an AppleScript under the hood: `tell application "Google Chrome" to execute javascript "..." in active tab`.
- **Pros:** Auth occurs in the user's normal browser session. Avoids the security risks of CDP.
- **Cons:** Highly OS-specific (macOS only). Requires granting the Terminal "Accessibility" permissions. Requires the browser to be the active, visible window while Conduit is typing.
- **Principledness:** Reasonable for a local Mac prototype if visible, permissioned, and user-controlled. Avoid claiming it is invisible to auth systems; the goal is normal user auth, not evasion.
- **Technical risks:** Accessibility permissions are scary for users. Browser scripting support differs. UI focus/visibility can make runs flaky.

### 3. The "Arms Race" Path (Stealth Plugins)
Stick with Playwright but wrap it in an evasion layer like `puppeteer-extra-plugin-stealth` (adapted for Playwright).
- **How it works:** Strips out the `webdriver=true` flags, mocks the browser fingerprint, and attempts to trick Cloudflare into thinking the Playwright instance is human.
- **Pros:** Keeps the architecture exactly as built in the current tractability spike.
- **Cons:** It's an exhausting cat-and-mouse game. Cloudflare updates its detection mechanisms frequently, meaning Conduit might randomly break and require constant dependency updates to fix.
- **Principledness:** Not acceptable for Conduit. This is fingerprint evasion and conflicts with the boundary above.

### 4. Browser Extension / Native Messaging Bridge (Principled Long-Term App Path)

The extension path has installation friction, but it may be the cleanest durable design for an eventual app.

- **How it works:** The user installs a Conduit browser extension. The extension runs only on explicitly allowed ChatGPT pages and communicates with the local Conduit app through native messaging or a localhost bridge.
- **Pros:** User-consented, browser-native, durable across sessions, less awkward than bookmarklets, and more appropriate for a polished app.
- **Cons:** Packaging and browser-store distribution add work. Cross-browser support is non-trivial. The extension must be narrowly permissioned and transparent.
- **Principledness:** Strong, provided the extension is explicit about what it can read/send, does not bypass auth, and only acts on user-authorized pages.
- **Suggested spike:** Start as an unpacked Chrome extension with minimal permissions that can detect a `conduit-call` block in the active ChatGPT tab and send it to localhost. Do not implement broad DOM control first.

### Rejected Alternatives
- **Direct APIs (OpenAI/Anthropic):** Bypasses the application surface where the user's specific ChatGPT memory and personalization data reside.
- **Browser Extensions as an immediate spike:** High user friction if started too early. Reconsider for the long-term app path above.
- **Local LLMs:** Do not have access to the ChatGPT context, memory, or specific account data.
- **CDP (Chrome DevTools Protocol):** Launching normal Chrome with `--remote-debugging-port` adds too much vulnerability and risk of Remote Code Execution (RCE), and Cloudflare is increasingly detecting CDP presence.
