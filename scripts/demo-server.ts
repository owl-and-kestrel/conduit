/**
 * scripts/demo-server.ts  (npm run demo:server)
 *
 * The "start a server" demo, headless, end to end through Conduit:
 *
 *   A web page cannot accept connections, so it cannot host a game a phone
 *   joins. Conduit can start the game server for it, after asking once.
 *
 * The harness plays the web page, the person and the players:
 *   - it opens the launcher's `conduit://` request through Conduit Control
 *     (`POST /api/url/open`, the path the macOS app forwards links to), which
 *     becomes one review ask; it approves it, and `service.start` runs
 *     demo/tiny-arena/server.mjs on Conduit's own Node until it prints
 *     CONDUIT_READY;
 *   - headless players join over the game's real channel (POST + SSE).
 *
 * Arms, one fresh game each:
 *   A. play + End game: 3 players, each sends 100 moves during a round; every
 *      move must reach both other players (600/600). The host presses End game;
 *      the program ends itself (exit 0) and leaves 0 processes.
 *   B. last player leaves: the program ends itself after its empty grace.
 *   C. Stop: Conduit's Stop (SIGTERM to the group); the program exits 0 itself.
 *   E. package (S2): the same game as an `npm pack` tarball served on
 *      loopback. First start: fetched, verified, one ask, approved with
 *      "Always allow this exact package". Second start of the same sha256:
 *      0 asks, 0 bytes. A package with one changed byte asks again.
 *   D. parent loss: the Conduit parent dies (SIGKILL); the deadman watchdog
 *      stops the game's process group within 2 s. (Runs last.)
 *
 * Measured: Conduit asks per start, time to playable (request -> ask ->
 * approve -> CONDUIT_READY -> first page load), moves delivered, latency,
 * time to exit, processes left, and bytes fetched for a package start.
 *
 * Isolation and limits: a fresh CONDUIT_STATE_DIR in a temp dir (deleted
 * afterwards), Control on an ephemeral loopback port (refuses 47831/3333),
 * the game on loopback only (never `lan: true`: Cedar has a public IP), and a
 * stand-in parent process for the deadman watchdog. It kills only processes
 * it started. Approval in the harness is immediate, so time to playable here
 * excludes human reading time.
 *
 * Run: npx tsx scripts/demo-server.ts [--json-out <file>] [--keep]
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { chmodSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createConduitUrl } from '../src/protocol/conduit-url.js';
import { closeClientSockets, joinPlayer, packTinyArena, postJson, type Player } from './tiny-arena-client.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_DIR = path.join(REPO_ROOT, 'demo', 'tiny-arena');
const ENTRY = 'server.mjs';
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const APP_URL_PATTERN = /Conduit app: (http:\/\/127\.0\.0\.1:\d+)/;
const FORBIDDEN_PORTS = new Set([47831, 3333]);
const APP_START_TIMEOUT_MS = 60_000;
const MOVES_PER_PLAYER = 100;
const PLAYERS = 3;
// The game's empty grace for this run (the default is 60 s). Short so arm B
// finishes quickly; long enough that players joining right after ready keep
// the game alive.
const EMPTY_GRACE_MS = 5000;
const EXIT_WAIT_MS = 10_000;
const PARENT_LOSS_TARGET_MS = 2000;
const STATEMENT = 'Better than curl | sh: a web page asks Conduit once to start a game server on this computer, which a page alone cannot do (browsers cannot accept connections). Approval runs the code; it does not make it safe. The game ends itself.';

interface Check { arm: string; check: string; expected: unknown; actual: unknown; pass: boolean; }
interface StartTiming {
  asks: number; pendingAfterApprove: number;
  openToAskMs: number | null; approveToReadyMs: number | null; openToReadyMs?: number; readyToPageMs: number; timeToPlayableMs: number;
  host: string; state: string;
  /** Package form only: whether the digest was already cached, and the bytes Conduit fetched. */
  packageCached?: boolean; bytesFetched?: number;
}
interface Started { timing: StartTiming; url: string; port: number; pid: number; serviceId: string; }
interface ServiceRecordLike { serviceId: string; state: string; exitCode?: number | null; signal?: string | null; stoppedBy?: string; }

let controlChild: ChildProcess | null = null;
let standIn: ChildProcess | null = null;
let controlUrl = '';
const servicePids: number[] = [];
const openPlayers: Player[] = [];

function note(message: string): void {
  console.error(`demo-server: ${message}`);
}

const round = (ms: number): number => Math.round(ms);

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! * 10) / 10;
}

async function api<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${controlUrl}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function reviewAsks(): Promise<{ all: number; pending: number }> {
  const { approvals } = await api<{ approvals: Array<{ status?: string; action?: { tool?: string } | null }> }>('GET', '/api/approvals');
  const reviews = approvals.filter((approval) => approval.action?.tool === 'conduit.review');
  return { all: reviews.length, pending: reviews.filter((approval) => approval.status === 'pending').length };
}

async function services(): Promise<ServiceRecordLike[]> {
  return (await api<{ services: ServiceRecordLike[] }>('GET', '/api/services')).services;
}

/** Live members of a process group (the service leads its own group under
 * supervision). Zombies hold nothing and are not counted. */
function groupMembers(pgid: number): number[] {
  const members: number[] = [];
  if (process.platform === 'linux') {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
        if (fields[0] !== 'Z' && Number(fields[2]) === pgid) members.push(Number(name));
      } catch {
        // exited while listing
      }
    }
    return members;
  }
  const out = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' });
  for (const line of out.split('\n')) {
    const [pid, pg, stat] = line.trim().split(/\s+/);
    if (pid && pg && stat && !stat.startsWith('Z') && Number(pg) === pgid) members.push(Number(pid));
  }
  return members;
}

function tcpRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error: NodeJS.ErrnoException) => { socket.destroy(); resolve(error.code === 'ECONNREFUSED'); });
  });
}

/** Waits for a condition the harness itself controls the timing of (local
 * API or /proc reads every 25 ms, bounded by `timeoutMs`). */
async function waitUntil<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitExited(serviceId: string, timeoutMs: number): Promise<ServiceRecordLike> {
  return waitUntil(async () => {
    const record = (await services()).find((service) => service.serviceId === serviceId);
    return record && (record.state === 'exited' || record.state === 'failed') ? record : undefined;
  }, timeoutMs, `service ${serviceId} to exit`);
}

async function groupEmptyAfter(pid: number, timeoutMs: number): Promise<number> {
  const startedAt = performance.now();
  await waitUntil(() => (groupMembers(pid).length === 0 ? true : undefined), timeoutMs, 'the service process group to empty');
  return round(performance.now() - startedAt);
}

function startControl(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`no Conduit app URL within ${APP_START_TIMEOUT_MS} ms`)), APP_START_TIMEOUT_MS);
    // cwd = the package directory: an approved review's project root is
    // Control's cwd, so service.start's `path: server.mjs` resolves there.
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, 'app', 'start', '--port', '0', '--host', '127.0.0.1'], {
      cwd: PACKAGE_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    controlChild = child;
    child.stderr?.resume();
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (settled) return;
      const match = stdout.match(APP_URL_PATTERN);
      if (!match) return;
      const port = Number(new URL(match[1]!).port);
      if (FORBIDDEN_PORTS.has(port)) {
        fail(new Error(`refusing to run against port ${port}: the demo Control must be ephemeral`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(match[1]!);
    });
    child.on('error', (error) => fail(error));
    child.on('exit', (code) => fail(new Error(`app start exited before printing a URL (code ${String(code)})`)));
  });
}

function hostRequest(args: Record<string, unknown>): Record<string, unknown> {
  // The launcher's request (demo/tiny-arena/launcher.html), always with
  // lan: false so the game binds loopback only.
  return {
    schema: 'conduit.request.v1',
    source: { kind: 'web', trust: 'untrusted' },
    title: 'Host Tiny Arena',
    description: 'Start the Tiny Arena game server on this computer so phones on your Wi-Fi can join.',
    actions: [{ id: 'host', tool: 'service.start', args: { name: 'Tiny Arena', ...args, lan: false } }]
  };
}

const pathArgs = (sha256: string): Record<string, unknown> => ({ path: ENTRY, sha256 });

/** Serves package bytes on an ephemeral loopback port (S2 allows http only on
 * loopback) and counts what it served, independently of Conduit's own count. */
function servePackages(files: Map<string, Buffer>): Promise<{ base: string; served: () => { requests: number; bytes: number }; close: () => Promise<void> }> {
  let requests = 0;
  let bytes = 0;
  const server = http.createServer((req, res) => {
    const body = files.get(req.url ?? '');
    requests += 1;
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    bytes += body.length;
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': body.length });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        served: () => ({ requests, bytes }),
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

interface StartOptions {
  /** The request's service.start args (path form or package form). */
  args: Record<string, unknown>;
  /** Approve with "Always allow this exact package" (package form only). */
  rememberPackage?: boolean;
}

type ServiceResult = { id: string; status: string; error?: string; content?: Record<string, unknown> };

async function startGame(options: StartOptions): Promise<Started> {
  const before = await reviewAsks();
  const t0 = performance.now();
  const opened = await api<{ execution?: { status?: string; approvalId?: string; results?: ServiceResult[] } }>('POST', '/api/url/open', {
    url: createConduitUrl(JSON.stringify(hostRequest(options.args)))
  });
  const tAsk = performance.now();
  const afterOpen = await reviewAsks();
  let results: ServiceResult[] | undefined;
  let tApprove = tAsk;
  const asked = opened.execution?.status === 'requires_review';
  if (asked && opened.execution?.approvalId) {
    // The person reads the ask and approves (immediately, in the harness).
    tApprove = performance.now();
    const approved = await api<{ execution?: { results?: ServiceResult[] } }>(
      'POST', `/api/approvals/${encodeURIComponent(opened.execution.approvalId)}/approve`,
      { decidedBy: 'cli', ...(options.rememberPackage ? { remember: 'package' } : {}) }
    );
    results = approved.execution?.results;
  } else if (opened.execution?.status === 'executed') {
    // No ask: an allowed package digest ran directly.
    results = opened.execution.results;
  } else {
    throw new Error(`unexpected request outcome: ${String(opened.execution?.status)}`);
  }
  const tReady = performance.now();
  const result = results?.find((entry) => entry.id === 'host');
  if (result?.status !== 'ok' || !result.content) throw new Error(`service.start failed: ${String(result?.error ?? result?.status)}`);
  const url = String(result.content.url);
  const pid = Number(result.content.pid);
  servicePids.push(pid);
  const page = await fetch(`${url}/`);
  const html = await page.text();
  const tPage = performance.now();
  if (page.status !== 200 || !html.includes('Tiny Arena')) throw new Error(`game page answered ${page.status}`);
  const pendingAfter = (await reviewAsks()).pending;
  const pkg = result.content.package as { cached?: boolean; bytesFetched?: number } | undefined;
  return {
    url,
    pid,
    port: Number(result.content.port),
    serviceId: String(result.content.serviceId),
    timing: {
      asks: afterOpen.all - before.all,
      pendingAfterApprove: pendingAfter,
      // With an ask: request -> ask, then approve -> ready. Without one (an
      // allowed package): request -> ready, and the two ask fields are null.
      openToAskMs: asked ? round(tAsk - t0) : null,
      approveToReadyMs: asked ? round(tReady - tApprove) : null,
      ...(asked ? {} : { openToReadyMs: round(tReady - t0) }),
      readyToPageMs: round(tPage - tReady),
      // request -> ask, plus approve -> page loaded. Leaves out the time a
      // person spends reading the ask (0 here) and the harness's own ask count.
      timeToPlayableMs: round(tAsk - t0 + (tPage - tApprove)),
      host: String(result.content.host),
      state: String(result.content.state),
      ...(pkg ? { packageCached: pkg.cached === true, bytesFetched: Number(pkg.bytesFetched) } : {})
    }
  };
}

async function join(url: string, name: string): Promise<Player> {
  const player = await joinPlayer(url, name);
  openPlayers.push(player);
  return player;
}

function closePlayers(): void {
  for (const player of openPlayers.splice(0)) player.stream.close();
}

function addStartChecks(checks: Check[], arm: string, started: Started): void {
  const t = started.timing;
  checks.push({ arm, check: 'asks', expected: 1, actual: t.asks, pass: t.asks === 1 });
  checks.push({ arm, check: 'pendingAfterApprove', expected: 0, actual: t.pendingAfterApprove, pass: t.pendingAfterApprove === 0 });
  checks.push({ arm, check: 'state', expected: 'ready', actual: t.state, pass: t.state === 'ready' });
  checks.push({ arm, check: 'host', expected: '127.0.0.1', actual: t.host, pass: t.host === '127.0.0.1' });
}

async function addExitChecks(checks: Check[], arm: string, started: Started, record: ServiceRecordLike): Promise<{ groupEmptyMs: number; portRefused: boolean; left: number }> {
  checks.push({ arm, check: 'exitCode', expected: 0, actual: record.exitCode, pass: record.exitCode === 0 });
  checks.push({ arm, check: 'signal', expected: null, actual: record.signal ?? null, pass: (record.signal ?? null) === null });
  const groupEmptyMs = await groupEmptyAfter(started.pid, 5000).catch(() => -1);
  const left = groupMembers(started.pid).length;
  checks.push({ arm, check: 'processesLeft', expected: 0, actual: left, pass: left === 0 });
  const portRefused = await tcpRefused(started.port);
  checks.push({ arm, check: 'portRefused', expected: true, actual: portRefused, pass: portRefused });
  return { groupEmptyMs, portRefused, left };
}

async function armPlay(sha256: string, checks: Check[]): Promise<Record<string, unknown>> {
  const arm = 'A play + End game';
  const started = await startGame({ args: pathArgs(sha256) });
  addStartChecks(checks, arm, started);
  const players: Player[] = [];
  for (let i = 0; i < PLAYERS; i += 1) players.push(await join(started.url, `Bot ${i + 1}`));
  // Everyone has seen everyone join before the round starts.
  for (const player of players) {
    for (const other of players) {
      await player.stream.waitFor((event) => event.t === 'hello' || (event.t === 'join' && (event.player as { id: string }).id === other.id));
    }
  }
  const starter = players[0]!;
  await postJson(started.url, '/api/start', { id: starter.id, token: starter.token });
  await Promise.all(players.map((player) => player.stream.waitFor((event) => event.t === 'round')));

  const sentAt = new Map<string, number>(); // `${sender}:${seq}` -> performance.now()
  const directions = ['up', 'down', 'left', 'right'] as const;
  let rejected = 0;
  await Promise.all(players.map(async (player, index) => {
    for (let seq = 1; seq <= MOVES_PER_PLAYER; seq += 1) {
      const dir = directions[(seq * 7 + index * 3) % 4]!;
      sentAt.set(`${player.id}:${seq}`, performance.now());
      const response = await postJson(started.url, '/api/move', { id: player.id, token: player.token, dir, seq });
      if (response.status !== 204) rejected += 1;
    }
  }));
  // Wait for the last move of every sender at every other player.
  for (const observer of players) {
    for (const sender of players) {
      if (sender === observer) continue;
      await observer.stream.waitFor((event) => event.t === 'mv' && event.id === sender.id && event.seq === MOVES_PER_PLAYER, 10_000).catch(() => undefined);
    }
  }
  const pairs: Array<{ sender: string; observer: string; delivered: number; inOrder: boolean }> = [];
  const latencies: number[] = [];
  let delivered = 0;
  for (const observer of players) {
    for (const sender of players) {
      if (sender === observer) continue;
      const seen = observer.stream.events.filter((entry) => entry.event.t === 'mv' && entry.event.id === sender.id);
      const seqs = seen.map((entry) => Number(entry.event.seq));
      const unique = new Set(seqs.filter((seq) => seq >= 1 && seq <= MOVES_PER_PLAYER));
      for (const entry of seen) {
        const sent = sentAt.get(`${sender.id}:${String(entry.event.seq)}`);
        if (sent !== undefined) latencies.push(entry.at - sent);
      }
      delivered += unique.size;
      pairs.push({
        sender: `Bot ${players.indexOf(sender) + 1}`,
        observer: `Bot ${players.indexOf(observer) + 1}`,
        delivered: unique.size,
        inOrder: seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]!)
      });
    }
  }
  const expected = PLAYERS * (PLAYERS - 1) * MOVES_PER_PLAYER;
  checks.push({ arm, check: 'movesRejected', expected: 0, actual: rejected, pass: rejected === 0 });
  checks.push({ arm, check: 'movesDelivered', expected: `${expected}/${expected}`, actual: `${delivered}/${expected}`, pass: delivered === expected });
  checks.push({ arm, check: 'everyPair100of100InOrder', expected: true, actual: pairs.every((pair) => pair.delivered === MOVES_PER_PLAYER && pair.inOrder), pass: pairs.every((pair) => pair.delivered === MOVES_PER_PLAYER && pair.inOrder) });

  const tEnd = performance.now();
  const endResponse = await postJson(started.url, '/api/end', {});
  checks.push({ arm, check: 'endStatus', expected: 204, actual: endResponse.status, pass: endResponse.status === 204 });
  const record = await waitExited(started.serviceId, EXIT_WAIT_MS);
  const endToExitMs = round(performance.now() - tEnd);
  const endSeen = (await Promise.all(players.map((player) => player.stream.waitFor((event) => event.t === 'end', 2000).then(() => true, () => false)))).filter(Boolean).length;
  checks.push({ arm, check: 'playersToldEnd', expected: PLAYERS, actual: endSeen, pass: endSeen === PLAYERS });
  const exit = await addExitChecks(checks, arm, started, record);
  closePlayers();
  return {
    arm,
    start: started.timing,
    players: PLAYERS,
    movesPerPlayer: MOVES_PER_PLAYER,
    movesDelivered: `${delivered}/${expected}`,
    pairs,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: percentile(latencies, 100), samples: latencies.length },
    endToExitMs,
    exitCode: record.exitCode,
    signal: record.signal ?? null,
    processesLeft: exit.left,
    portRefused: exit.portRefused
  };
}

async function armLastPlayerLeaves(sha256: string, checks: Check[]): Promise<Record<string, unknown>> {
  const arm = 'B last player leaves';
  const started = await startGame({ args: pathArgs(sha256) });
  addStartChecks(checks, arm, started);
  const a = await join(started.url, 'Bot 1');
  const b = await join(started.url, 'Bot 2');
  await postJson(started.url, '/api/leave', { id: a.id, token: a.token });
  // The second leave is what a phone's pagehide beacon sends: text/plain.
  await postJson(started.url, '/api/leave', JSON.stringify({ id: b.id, token: b.token }), 'text/plain;charset=UTF-8');
  const tLeft = performance.now();
  await Promise.all([a.stream.waitClosed(), b.stream.waitClosed()]);
  const record = await waitExited(started.serviceId, EMPTY_GRACE_MS + EXIT_WAIT_MS);
  const leaveToExitMs = round(performance.now() - tLeft);
  checks.push({ arm, check: 'endedAfterGrace', expected: `>= ${EMPTY_GRACE_MS} ms`, actual: leaveToExitMs, pass: leaveToExitMs >= EMPTY_GRACE_MS - 100 });
  const exit = await addExitChecks(checks, arm, started, record);
  closePlayers();
  return { arm, start: started.timing, emptyGraceMs: EMPTY_GRACE_MS, leaveToExitMs, exitCode: record.exitCode, signal: record.signal ?? null, processesLeft: exit.left, portRefused: exit.portRefused };
}

async function armStop(sha256: string, checks: Check[]): Promise<Record<string, unknown>> {
  const arm = 'C Stop (SIGTERM)';
  const started = await startGame({ args: pathArgs(sha256) });
  addStartChecks(checks, arm, started);
  const player = await join(started.url, 'Bot 1');
  const tStop = performance.now();
  await api('POST', `/api/services/${encodeURIComponent(started.serviceId)}/stop`);
  const record = await waitExited(started.serviceId, EXIT_WAIT_MS);
  const stopToExitMs = round(performance.now() - tStop);
  const told = await player.stream.waitFor((event) => event.t === 'end', 2000).then((event) => String(event.reason), () => 'none');
  checks.push({ arm, check: 'playerToldWhy', expected: 'stopped', actual: told, pass: told === 'stopped' });
  checks.push({ arm, check: 'stoppedBy', expected: 'person', actual: record.stoppedBy, pass: record.stoppedBy === 'person' });
  const exit = await addExitChecks(checks, arm, started, record);
  closePlayers();
  return { arm, start: started.timing, stopToExitMs, exitCode: record.exitCode, signal: record.signal ?? null, processesLeft: exit.left, portRefused: exit.portRefused };
}

async function endGame(started: Started): Promise<ServiceRecordLike> {
  await postJson(started.url, '/api/end', {});
  return waitExited(started.serviceId, EXIT_WAIT_MS);
}

/** E (S2 wiring): the package form. The first start fetches the npm-pack
 * tarball, verifies it and asks once; the person picks "Always allow this
 * exact package". The second start of the same sha256 asks nothing and
 * fetches nothing. A package with one changed byte asks again. */
async function armPackage(workDir: string, checks: Check[]): Promise<Record<string, unknown>> {
  const arm = 'E package: ask once, then never';
  const packed = packTinyArena(workDir);
  // The same package with one byte of one file changed: a different digest.
  // It is only ever offered, denied and never run.
  const tar = gunzipSync(packed.bytes);
  tar[tar.indexOf('Tiny Arena')] = 't'.charCodeAt(0);
  const tampered = gzipSync(tar);
  const tamperedSha = createHash('sha256').update(tampered).digest('hex');
  const host = await servePackages(new Map([['/tiny-arena.tgz', packed.bytes], ['/tiny-arena-changed.tgz', tampered]]));
  try {
    const pkgArgs = (file: string, sha: string, size: number): Record<string, unknown> => ({ package: { url: `${host.base}${file}`, sha256: sha, size } });

    const first = await startGame({ args: pkgArgs('/tiny-arena.tgz', packed.sha256, packed.bytes.length), rememberPackage: true });
    addStartChecks(checks, `${arm} (first start)`, first);
    const servedAfterFirst = host.served();
    checks.push({ arm, check: 'firstStartFetchedPackage', expected: packed.bytes.length, actual: first.timing.bytesFetched, pass: first.timing.bytesFetched === packed.bytes.length && first.timing.packageCached === false });
    const firstExit = await endGame(first);
    checks.push({ arm, check: 'firstEndGameExitCode', expected: 0, actual: firstExit.exitCode, pass: firstExit.exitCode === 0 });

    const second = await startGame({ args: pkgArgs('/tiny-arena.tgz', packed.sha256, packed.bytes.length) });
    const servedAfterSecond = host.served();
    checks.push({ arm, check: 'secondStartAsks', expected: 0, actual: second.timing.asks, pass: second.timing.asks === 0 });
    checks.push({ arm, check: 'secondStartBytesFetched', expected: 0, actual: second.timing.bytesFetched, pass: second.timing.bytesFetched === 0 && second.timing.packageCached === true });
    const extraServed = servedAfterSecond.bytes - servedAfterFirst.bytes;
    checks.push({ arm, check: 'secondStartBytesServed', expected: 0, actual: extraServed, pass: extraServed === 0 });
    const secondExit = await endGame(second);
    checks.push({ arm, check: 'secondEndGameExitCode', expected: 0, actual: secondExit.exitCode, pass: secondExit.exitCode === 0 });
    const secondLeft = groupMembers(second.pid).length;
    checks.push({ arm, check: 'processesLeft', expected: 0, actual: secondLeft, pass: secondLeft === 0 });

    // A changed package is a different digest: it asks again; deny it.
    const before = await reviewAsks();
    const opened = await api<{ execution?: { status?: string; approvalId?: string } }>('POST', '/api/url/open', {
      url: createConduitUrl(JSON.stringify(hostRequest(pkgArgs('/tiny-arena-changed.tgz', tamperedSha, tampered.length))))
    });
    const changedAsks = (await reviewAsks()).all - before.all;
    checks.push({ arm, check: 'changedPackageAsks', expected: 1, actual: changedAsks, pass: opened.execution?.status === 'requires_review' && changedAsks === 1 });
    const servicesBeforeDeny = (await services()).length;
    if (opened.execution?.approvalId) {
      await api('POST', `/api/approvals/${encodeURIComponent(opened.execution.approvalId)}/deny`, { decidedBy: 'cli', reason: 'demo: a different package' });
    }
    const servicesAfterDeny = (await services()).length;
    checks.push({ arm, check: 'changedPackageDeniedStartsNothing', expected: 0, actual: servicesAfterDeny - servicesBeforeDeny, pass: servicesAfterDeny === servicesBeforeDeny });
    const changedBytes = host.served().bytes - servedAfterSecond.bytes;
    checks.push({ arm, check: 'changedPackageNotFetchedBeforeApproval', expected: 0, actual: changedBytes, pass: changedBytes === 0 });

    return {
      arm,
      packageBytes: packed.bytes.length,
      packageSha256: packed.sha256,
      first: first.timing,
      firstEndToExit: { exitCode: firstExit.exitCode, signal: firstExit.signal ?? null },
      second: second.timing,
      bytesServedTotal: host.served().bytes,
      changedPackage: { asks: changedAsks, denied: true }
    };
  } finally {
    await host.close();
  }
}

async function armParentLoss(sha256: string, checks: Check[]): Promise<Record<string, unknown>> {
  const arm = 'D parent loss (SIGKILL)';
  const started = await startGame({ args: pathArgs(sha256) });
  addStartChecks(checks, arm, started);
  await join(started.url, 'Bot 1');
  const parent = standIn;
  if (!parent?.pid) throw new Error('no stand-in parent');
  const tKill = performance.now();
  parent.kill('SIGKILL');
  await waitUntil(() => (groupMembers(started.pid).length === 0 ? true : undefined), 5000, 'the game group to empty after parent loss').catch(() => undefined);
  const parentLossToGoneMs = round(performance.now() - tKill);
  const left = groupMembers(started.pid).length;
  checks.push({ arm, check: 'processesLeft', expected: 0, actual: left, pass: left === 0 });
  checks.push({ arm, check: 'goneWithin2s', expected: `<= ${PARENT_LOSS_TARGET_MS} ms`, actual: parentLossToGoneMs, pass: left === 0 && parentLossToGoneMs <= PARENT_LOSS_TARGET_MS });
  const portRefused = await tcpRefused(started.port);
  checks.push({ arm, check: 'portRefused', expected: true, actual: portRefused, pass: portRefused });
  const control = controlChild;
  const controlExit = control && control.exitCode === null && control.signalCode === null
    ? await Promise.race([new Promise<number | null>((resolve) => control.once('exit', (code) => resolve(code))), new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 5000))])
    : control?.exitCode ?? null;
  checks.push({ arm, check: 'controlExitCode', expected: 0, actual: controlExit, pass: controlExit === 0 });
  closePlayers();
  return { arm, start: started.timing, parentLossToGoneMs, processesLeft: left, portRefused, controlExitCode: controlExit };
}

async function stopEverything(): Promise<void> {
  closePlayers();
  closeClientSockets();
  // Parent loss makes Control's watchdog stop every service group it started.
  if (standIn && standIn.exitCode === null && standIn.signalCode === null) standIn.kill('SIGKILL');
  const control = controlChild;
  if (control && control.exitCode === null && control.signalCode === null) {
    await Promise.race([new Promise((resolve) => control.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 8000))]);
    if (control.exitCode === null && control.signalCode === null) control.kill('SIGKILL');
  }
  for (const pid of servicePids) {
    for (const member of groupMembers(pid)) {
      note(`killing leftover game process group member ${member}`);
      try { process.kill(member, 'SIGKILL'); } catch { /* gone */ }
    }
  }
}

/** chmod -R u+w without following links, so the temp dir (which holds
 * Conduit's read-only package cache) can be removed. */
function makeWritable(target: string): void {
  let stats;
  try {
    stats = lstatSync(target);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) return;
  try {
    chmodSync(target, stats.isDirectory() ? 0o700 : 0o600);
  } catch {
    // rm reports anything it still cannot remove
  }
  if (stats.isDirectory()) {
    for (const name of readdirSync(target)) makeWritable(path.join(target, name));
  }
}

interface Args { jsonOut?: string; keep: boolean; }

function parseArgs(argv: string[]): Args {
  const args: Args = { keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json-out' && argv[i + 1]) {
      args.jsonOut = path.resolve(argv[i + 1]!);
      i += 1;
    } else if (argv[i] === '--keep') {
      args.keep = true;
    } else {
      throw new Error(`Unknown argument: ${String(argv[i])} (supported: --json-out <file>, --keep)`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const root = await mkdtemp(path.join(os.tmpdir(), 'conduit-demo-server-'));
  const stateDir = path.join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  const sha256 = createHash('sha256').update(await readFile(path.join(PACKAGE_DIR, ENTRY))).digest('hex');

  standIn = spawn('sleep', ['600'], { stdio: 'ignore' });
  const { CONDUIT_CONTROL_URL: _real, CONDUIT_DEMO_PROFILE: _inherited, ...baseEnv } = process.env;
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    CONDUIT_STATE_DIR: stateDir,
    CONDUIT_DEMO_PROFILE: '1',
    CONDUIT_PARENT_PID: String(standIn.pid),
    TINY_ARENA_EMPTY_GRACE_MS: String(EMPTY_GRACE_MS)
  };

  const checks: Check[] = [];
  const arms: Array<Record<string, unknown>> = [];
  let failure: string | null = null;
  try {
    controlUrl = await startControl(env);
    note('Conduit Control on an ephemeral loopback port with the demo profile; state is isolated.');
    arms.push(await armPlay(sha256, checks));
    arms.push(await armLastPlayerLeaves(sha256, checks));
    arms.push(await armStop(sha256, checks));
    arms.push(await armPackage(root, checks));
    arms.push(await armParentLoss(sha256, checks));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    note(`failed: ${failure}`);
  } finally {
    await stopEverything();
    const leftovers = servicePids.reduce((sum, pid) => sum + groupMembers(pid).length, 0);
    checks.push({ arm: 'all', check: 'gameProcessesLeftAtExit', expected: 0, actual: leftovers, pass: leftovers === 0 });
    const controlDead = controlChild === null || controlChild.exitCode !== null || controlChild.signalCode !== null;
    checks.push({ arm: 'all', check: 'controlStopped', expected: true, actual: controlDead, pass: controlDead });
    if (!args.keep) {
      makeWritable(root); // the package cache is read-only by design
      await rm(root, { recursive: true, force: true });
    }
    else note(`kept ${root} (${(await readdir(root)).join(', ')})`);
  }

  const pass = failure === null && checks.every((check) => check.pass);
  const starts: StartTiming[] = arms.flatMap((arm) => [arm.start, arm.first, arm.second].filter(Boolean) as StartTiming[]);
  const playable = starts.map((start) => start.timeToPlayableMs);
  const results = {
    schema: 'conduit.demo.start-a-server.v1',
    statement: STATEMENT,
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    entrySha256: sha256,
    arms,
    checks,
    failure,
    pass,
    totals: {
      starts: starts.length,
      asksPerStart: starts.map((start) => start.asks),
      packageSecondStart: (() => {
        const e = arms.find((arm) => String(arm.arm).startsWith('E')) as { second?: StartTiming } | undefined;
        return e?.second ? { asks: e.second.asks, bytesFetched: e.second.bytesFetched ?? null } : null;
      })(),
      timeToPlayableMs: { values: playable, p50: percentile(playable, 50), max: percentile(playable, 100) },
      movesDelivered: arms[0]?.movesDelivered ?? null,
      processesLeftAfterEndGame: arms[0]?.processesLeft ?? null,
      gameProcessesLeftAtExit: checks.find((check) => check.check === 'gameProcessesLeftAtExit')?.actual ?? null
    },
    notMeasuredHere: ['the macOS menu-bar ask, browser.open and a phone joining over a real LAN (S4)']
  };
  const a = arms[0] as { movesDelivered?: string; latencyMs?: { p50: number }; endToExitMs?: number } | undefined;
  console.log([
    `demo-server: ${pass ? 'PASS' : 'FAIL'}`,
    `asks per start ${starts.map((start) => start.asks).join('/')}`,
    `time to playable ${playable.join('/')} ms`,
    `moves ${a?.movesDelivered ?? '-'} (p50 ${a?.latencyMs?.p50 ?? '-'} ms)`,
    `End game -> exit ${a?.endToExitMs ?? '-'} ms`,
    `left ${String(results.totals.gameProcessesLeftAtExit)}`
  ].join(' | '));
  process.exitCode = pass ? 0 : 1;
  // Write the file before printing, so a closed stdout cannot lose it.
  if (args.jsonOut) {
    await writeFile(args.jsonOut, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
    note('results written to --json-out file.');
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch(async (error: unknown) => {
  console.error(`demo-server: failed: ${error instanceof Error ? error.message : String(error)}`);
  await stopEverything().catch(() => undefined);
  process.exitCode = 1;
});
