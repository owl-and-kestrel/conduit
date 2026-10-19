# Consent-loop demo results

> Conduit does not make local execution safe. It makes local execution legible.

`scripts/demo-consent-loop.ts` (`npm run demo:consent`) checks that claim with
the real CLI. It drives one trusted session through three arms and counts what
happened: daemon events, approval asks (`conduit approvals list`) and runs
(`conduit runs list`).

| Arm | Envelope | Expected outcome |
|---|---|---|
| trusted | the exact starter envelope `session create` prints, with the session's live one-shot nonce | runs quietly: 1 execution, 0 asks, results on the clipboard |
| untrusted (nonce missing) | the same envelope with `nonce` removed | never runs silently: exactly 1 `conduit.review` ask, then denied through `conduit approvals deny`; 0 runs before and after the denial |
| replay (consumed nonce) | the trusted envelope again; arm A used its nonce | refused with a repair envelope: 0 executions, 0 asks |

The replay arm shows the third path. A known session presenting a stale nonce
is refused outright. It does not become an ask.

## Isolation

- Every CLI call runs with a fresh `CONDUIT_STATE_DIR` in a temp dir, deleted
  at the end.
- `pbpaste`/`pbcopy` are file-backed shims on `PATH`, so the demo never touches
  the real clipboard and runs on Linux.
- Conduit Control starts with `app start --port 0` on loopback. The script
  refuses to run if it lands on 47831 or 3333.
- The committed JSON redacts ids and nonces.

## Results (Cedar, linux-arm64, Node v22.23.2, base 7324f102)

All 23 checks passed in each of three consecutive runs (2026-10-19 00:18Z to 00:20Z UTC).

| Run | trusted: daemon / arm ms | untrusted: daemon / arm / deny ms | replay: daemon / arm ms | asks (trusted / untrusted / replay) | executions |
|---|---|---|---|---|---|
| [1](consent-loop-cedar-run1.json) | 965 / 5970 | 1109 / 6184 / 980 | 975 / 5992 | 0 / 1 / 0 | 1 |
| [2](consent-loop-cedar-run2.json) | 1037 / 6204 | 1161 / 6744 / 1072 | 1026 / 6229 | 0 / 1 / 0 | 1 |
| [3](consent-loop-cedar-run3.json) | 1232 / 6693 | 994 / 6341 / 1086 | 1092 / 6278 | 0 / 1 / 0 | 1 |

How to read the times:
- **daemon ms** is wall time for one `conduit daemon once`, from reading the
  envelope to the outcome.
- **arm ms** adds the five verification CLI calls.
- Each call is a fresh Node + tsx process, so start-up dominates. These are
  not throughput numbers.

What the counts show:
- The trusted envelope and the untrusted one differ only in the nonce.
- The trusted envelope ran with no human in the loop.
- The untrusted one produced exactly one ask and no run, both before and
  after it was denied.
