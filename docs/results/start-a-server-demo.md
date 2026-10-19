# "Start a server" demo results

> A web page asks Conduit once to start a game server on this computer. A
> page alone cannot do this: browsers cannot accept inbound connections, so a
> phone could never join a game a page hosts. Conduit is better than
> `curl | sh`, not a safety product: approving runs the code; it does not make
> the code safe.

`scripts/demo-server.ts` (`npm run demo:server`) runs the demo headless through
Conduit and counts what happened. The game is
[`demo/tiny-arena`](../../demo/tiny-arena/README.md).

Each start goes through the same path as the launcher page's **Host game**
link: the `conduit://` request reaches Control at `POST /api/url/open`. Unless
its package is already allowed, it becomes one review ask. On approval,
`service.start` (demo profile) runs the game on Conduit's own Node until it
prints `CONDUIT_READY`. The game page is then loaded and played over its real
channel (POST + Server-Sent Events) by headless players.

| Arm | What it does | Pass when |
|---|---|---|
| A. play + End game | 3 players join, a round starts, and each sends 100 moves at the same time as the others | every move reaches both other players, in order (600/600). After End game the program exits 0 by itself, 0 processes are left and the port is closed |
| B. last player leaves | 2 players join and leave (one through a `text/plain` beacon) | the program ends itself after its empty grace (5 s in the harness, 60 s by default), exits 0 and leaves 0 processes |
| C. Stop | Conduit's Stop (`POST /api/services/:id/stop`, SIGTERM to the group) | the program exits 0 on its own (not killed by the signal), the player is told why, and 0 processes are left |
| E. package form (S2) | the game as an `npm pack` tarball served on loopback. First start: fetched, verified, asks once, and the person picks "Always allow this exact package". Then the same sha256 again. Then the same package with one byte changed | first start: 1 ask, all bytes fetched. Second start: **0 asks, 0 bytes fetched** (Conduit's count and the server's own count agree). Changed package: 1 ask; when denied it starts nothing and nothing is fetched |
| D. parent loss (last) | the Conduit parent stand-in is SIGKILLed | the deadman watchdog empties the game's process group within 2 s, and Control exits 0 |

A, B, C and D use the path form that `launcher.html` sends today: the entry
`server.mjs` is pinned by its sha256, and Control's project root is the
package directory.

## Isolation

- A fresh `CONDUIT_STATE_DIR` in a temp dir, deleted at the end. The
  package cache in it is read-only, so the harness makes it writable before
  removing it.
- Control runs `app start --port 0 --host 127.0.0.1` with
  `CONDUIT_DEMO_PROFILE=1`. Its working directory is the package directory. It
  refuses ports 47831 and 3333.
- The game binds loopback only. The harness asks with `lan: false`, because
  Cedar has a public IP. The package server is loopback http, which S2 allows
  only on loopback.
- `CONDUIT_PARENT_PID` is a `sleep` stand-in, so the service leads its own
  process group and arm D can kill the parent.
- The harness kills only processes it started. The JSON has no ids, tokens,
  ports or pids. The only hashes in it are `entrySha256` (of `server.mjs`) and
  the package sha256.

## Results (Cedar, linux-arm64, Node v22.23.2, npm 10.9.8)

Three consecutive runs, 2026-10-19 14:51:05Z to 14:51:40Z UTC, on code tree
`39f4b4d6` (the round-end fix). The commit that carries these files adds only
them on top. All 56 checks passed in each run.

| Run | asks per start (A/B/C/E1/E2/D) | time to playable, ms (A/B/C/E1/E2/D) | moves delivered | latency p50 / p95 / max, ms | End game -> exit, ms | last leave -> exit, ms | Stop -> exit, ms | package bytes, E1 / E2 | changed package | parent kill -> group empty, ms | processes left |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [1](start-a-server-cedar-run1.json) | 1/1/1/1/**0**/1 | 121 / 96 / 94 / 130 / 91 / 94 | 600/600 | 0.9 / 1.6 / 7.1 | 37 | 5024 | 115 | 20234 / **0** | 1 ask, denied | 381 | 0 |
| [2](start-a-server-cedar-run2.json) | 1/1/1/1/**0**/1 | 121 / 98 / 93 / 130 / 90 / 99 | 600/600 | 0.9 / 1.8 / 6.3 | 36 | 5021 | 116 | 20234 / **0** | 1 ask, denied | 355 | 0 |
| [3](start-a-server-cedar-run3.json) | 1/1/1/1/**0**/1 | 120 / 98 / 96 / 129 / 88 / 92 | 600/600 | 0.9 / 1.8 / 5.9 | 37 | 5019 | 117 | 20234 / **0** | 1 ask, denied | 382 | 0 |

Time to playable:
- **Path-form starts with an ask** (A, B, C, D; 12 starts): p50 96 ms, max
  121 ms.
- **First package start** (fetch, verify, unpack, ask): 129-130 ms.
- **Allowed package, no ask** (E2): 88-91 ms.

How to read the numbers:
- **Time to playable** is request -> ask (`POST /api/url/open`) plus approve
  -> `CONDUIT_READY` -> first page load (HTTP 200). With no ask, it is request
  -> page load. It leaves out the time a person spends reading the ask, which
  is 0 in the harness. Approve -> ready (82-99 ms on path starts) is mostly
  the game's Node start-up.
- **Latency** is from one player sending a move to another player's stream
  receiving it, on loopback. A LAN adds the Wi-Fi round trip.
- **Last leave -> exit** is the program's own empty grace (5 s here) plus
  shutdown.
- **Stop -> exit** includes Conduit's TERM and the game telling its players.
- **Package bytes** are what Conduit reports it fetched (`bytesFetched`). The
  harness's loopback server counted the same total, 20234 bytes, across all
  three starts. The package sha256 depends on the npm and zlib versions that
  pack it, so it differs between hosts. The harness computes it each run.

## Not measured here (Mac, S4)

These need a Mac on a real LAN and are not covered by these runs:
- the `conduit://` click from Safari and Chrome through to the menu-bar ask;
- the browser opening the game;
- a phone joining by QR over the LAN;
- the browser's external-protocol dialog and the macOS firewall prompt (to be
  counted and reported separately);
- parent loss with the real menu-bar app.

`launcher.html` still sends the path form. It moves to the package form once
the package has a published https URL.
