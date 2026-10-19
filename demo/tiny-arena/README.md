# Tiny Arena

A tiny multiplayer game for the Conduit "start a server" demo. A web page asks
Conduit to start the game server on the laptop; a phone on the same Wi-Fi
scans a QR code and joins. A web page alone cannot do this: browsers cannot
accept inbound connections.

Conduit is better than `curl | sh`, not a safety product. Approving the ask
runs this code; it does not make the code safe.

**The game, "Paint the arena":** a 12x12 board, up to 8 players. During a
45 s round every step paints the cell you land on, stealing it from whoever
had it. Walls and other players block you. Most cells at the end wins.
Steer by swiping on the board, with the on-screen arrows, or with the arrow
keys / WASD.

## Files

| File | What it is |
|---|---|
| `package.json` | Manifest: `conduit.entry` `server.mjs`, `runtime` `node`, `listen` `lan`, `ready` `CONDUIT_READY`. No dependencies. |
| `server.mjs` | The entry: HTTP server, realtime channel, lifecycle. Node built-ins only. |
| `game.mjs` | Pure game rules (no I/O, no timers; time is passed in). |
| `qr.mjs` | QR encoder written for this demo (byte mode, versions 1-10, levels L/M/Q/H). Nothing vendored. |
| `public/index.html` | The game client (inline CSS and JS, nothing loaded from the network). |
| `launcher.html` | The plain web page with the **Host game** link. |

## Run it

- **Through Conduit (today):** run Conduit Control with `CONDUIT_DEMO_PROFILE=1`
  and this directory as its working directory, then open `launcher.html` and
  click **Host game**. Approve the one review ask. The approval result names
  the game URL; open it. `npm run demo:server` does all of this headless.
- **On its own:** `PORT=8080 node demo/tiny-arena/server.mjs` (loopback), or
  add `HOST=0.0.0.0` so phones on your network can join.

Environment: `PORT` (default: a free port), `HOST` (default `127.0.0.1`),
`TINY_ARENA_EMPTY_GRACE_MS` (default 60000), `TINY_ARENA_ROUND_MS` (default
45000). When it is listening it prints `CONDUIT_READY http://127.0.0.1:<port>/`.

## Protocol: Server-Sent Events + POST

| Route | Who | What |
|---|---|---|
| `GET /` | anyone | the game page |
| `GET /api/info` | anyone | `{isHost, joinUrl, lan, phase}`; `joinUrl` only for the host |
| `GET /join.svg` | host only | QR code of the join URL (404 on a loopback-only bind) |
| `POST /api/join` `{name}` | player | `{id, token, color}`; 409 when 8 are playing |
| `GET /events?id&token` | player | the event stream |
| `POST /api/move` `{id, token, dir, seq}` | player | 204; the result goes to every stream |
| `POST /api/start` `{id, token}` | player | starts a round |
| `POST /api/leave` `{id, token}` | player | leaves (also accepts `text/plain` for `navigator.sendBeacon`) |
| `POST /api/end` | host only | End game |

"Host" means the request came from this computer (a loopback address).
Events are `data: <json>` lines: `hello`, `join`, `leave`, `mv`
(`{id, seq, x, y, painted}`), `round`, `results`, `end`; `: hb` comments keep
the stream open.

**Why SSE + POST, not WebSocket.** Server-to-player traffic is a stream of
small events, which is exactly what SSE is. Player-to-server traffic is one
tiny POST per move, which is fine on a LAN (the harness measures sub-ms on
loopback). In exchange there is no hand-written WebSocket frame parser,
masking or close handshake to get wrong, `EventSource` reconnects by itself
when a phone locks or changes networks, every phone browser supports it, and
tests use plain HTTP.

**Room key.** The join URL in the QR code carries `?k=<8 hex chars>`, and
requests from other computers must carry it. This keeps people on the same
Wi-Fi who did not scan the code out of the game. It is not access control:
the game is plain HTTP and anyone who sees the URL has the key.

## Lifecycle: the game ends itself

Cleanup is this program's job (its author's), not Conduit's. Every path exits
with code 0, and every bound names the harm it prevents:

| When | What happens | Why this bound |
|---|---|---|
| No open player streams for 60 s (also right after start) | ends: `last player left` | An empty game holds a port (on the LAN when started with `lan: true`) and CPU for nobody. 60 s lets the last phone come back from a lock screen or reload. |
| A player's stream drops | their seat is kept for 15 s | `EventSource` reconnects by itself; a blip should not cost you your color and cells. |
| The host presses **End game** | ends: `host ended the game` | The person who started it decides when it is over. Phones can only leave. |
| SIGTERM / SIGINT (Conduit's Stop, Ctrl-C) | ends: `stopped` | |
| Any shutdown | tells every player, closes streams and the listener, exits; never waits more than 2 s on a client | A client that does not hang up must not keep the port open. |

Other bounds: POST bodies are capped at 4096 bytes (one client cannot grow
server memory without bound), and the stream sends a heartbeat every 15 s
(phone browsers and idle-timeout middleboxes drop quiet connections).

## What exists today and what later slices add

Conduit can start this game two ways, both only with `CONDUIT_DEMO_PROFILE=1`:

- **Path form (S1), what `launcher.html` sends today:** `{path: "server.mjs",
  sha256}`, run from Conduit Control's project root, which must be this
  directory. The sha256 covers `server.mjs` only, not the files it imports.
- **Package form (S2):** `{package: {url, sha256, size}}`. Conduit fetches the
  `npm pack` tarball of this directory (`package.json` lists the shipped
  files and names the entry), verifies the sha256 before unpacking, and runs
  it from the read-only `cache/packages/<sha256>/` tree, so the hash covers
  every file. Approving with "Always allow this exact package" makes the next
  start of the same sha256 ask nothing and fetch nothing; any other hash asks
  again. `npm run demo:server` exercises this (arm E). The launcher switches
  to it once the package has a published https URL (a publishing decision).

| | Today | Later (S4, Mac) |
|---|---|---|
| Asking | The `conduit://` link becomes one review ask (0 for an allowed package). | The menu-bar ask shows the sha256 and "accepts connections from your network". |
| Opening the game | The URL is in the result; you open it. | The browser opens it when the game is ready. |
| Stopping | `conduit services stop <id>` (SIGTERM; the game exits 0). | A Services row with Stop. |
| Phone join | Needs a Mac on a real LAN (`lan: true`); the harness runs loopback only. | Recorded Mac run with a phone. |
