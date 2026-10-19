// Tiny Arena: the Conduit demo entry (server.mjs). Node built-ins only.
//
// A small "Paint the arena" multiplayer server. Conduit's service.start runs
// it on Conduit's own Node with PORT and HOST in the environment; it prints
// CONDUIT_READY once it is listening. A web page cannot do this part itself:
// browsers cannot accept inbound connections, so a phone could never join a
// game hosted by a page alone.
//
// Realtime channel: Server-Sent Events (server -> players) plus one small
// POST per action (players -> server). See README.md for why not WebSocket.
//
// Cleanup is this program's job, not Conduit's: it ends itself when the last
// player has gone (after a grace), when the host presses End game, and on
// SIGTERM/SIGINT, always with exit code 0.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createGame } from './game.mjs';
import { encodeQr, toSvg } from './qr.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// Bounds, each with the concrete harm it prevents:
// - MAX_BODY_BYTES: one client cannot grow server memory without bound by
//   sending a huge POST body. Real bodies are under 200 bytes.
// - HEARTBEAT_MS: phone browsers and idle-timeout middleboxes drop a quiet
//   stream; a comment line every 15 s keeps it open.
// - RECONNECT_GRACE_MS: a phone that locks its screen or a page that reloads
//   drops its stream; EventSource reconnects by itself, so the player keeps
//   their seat for 15 s instead of vanishing on every blip.
// - EMPTY_GRACE_MS: with no open streams the server holds a port (on the LAN,
//   when started with lan: true) and some CPU for nobody. 60 s is long enough
//   for the last phone to come back from a lock screen or reload; after it
//   the program ends itself and frees the port.
// - EXIT_FORCE_MS: shutdown never waits on a client to hang up; if closing
//   the listener stalls, the process still exits.
const MAX_BODY_BYTES = 4096;
const HEARTBEAT_MS = 15000;
const RECONNECT_GRACE_MS = 15000;
const EMPTY_GRACE_MS = intEnv('TINY_ARENA_EMPTY_GRACE_MS', 60000);
const ROUND_MS = intEnv('TINY_ARENA_ROUND_MS', 45000);
const EXIT_FORCE_MS = 2000;

const PORT = intEnv('PORT', 0);
const HOST = process.env.HOST || '127.0.0.1';

// The room key rides in the QR's join URL. Requests from other machines must
// carry it, which keeps people on the same Wi-Fi who did not scan the code
// out of the game. It is not access control: the game is plain HTTP and
// anyone who sees the URL has the key.
const roomKey = randomBytes(4).toString('hex');

const game = createGame({ roundMs: ROUND_MS });
const tokens = new Map(); // player id -> token (the server's own ledger)
const streams = new Map(); // player id -> Set<ServerResponse>
const removalTimers = new Map(); // player id -> Timeout
let joinUrl = null; // set on listen when the bind is reachable from the LAN
let emptyTimer = null;
let roundTimer = null;
let heartbeatTimer = null;
let shuttingDown = false;

function intEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isLoopbackAddress(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

// The address phones should use: a specific bind address as-is, otherwise
// the first private IPv4 (192.168/16, then 10/8, then 172.16/12), then any
// other non-internal IPv4. Link-local 169.254/16 is skipped.
function lanAddress(host = HOST, interfaces = os.networkInterfaces()) {
  if (isLoopbackAddress(host)) return null;
  if (host !== '0.0.0.0' && host !== '::') return host;
  const rank = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  let best = null;
  for (const list of Object.values(interfaces)) {
    for (const nic of list ?? []) {
      if (nic.family !== 'IPv4' && nic.family !== 4) continue;
      if (nic.internal || nic.address.startsWith('169.254.')) continue;
      if (best === null || rank(nic.address) < rank(best)) best = nic.address;
    }
  }
  return best;
}

// ---- HTTP helpers -------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendEmpty(res, status) {
  res.writeHead(status, { 'Cache-Control': 'no-store' });
  res.end();
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Reads a JSON object body of at most MAX_BODY_BYTES. Any content type is
// accepted: navigator.sendBeacon posts text/plain.
function readJson(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      req.resume(); // discard; the 413 goes out regardless
      reject(new HttpError(413, 'body too large'));
      return;
    }
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(new HttpError(413, 'body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = JSON.parse(raw === '' ? '{}' : raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'bad json'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'body read failed')));
  });
}

function requirePlayer(body) {
  const { id, token } = body;
  if (typeof id !== 'string' || typeof token !== 'string' || tokens.get(id) !== token) {
    throw new HttpError(401, 'unknown player or token');
  }
  return id;
}

// ---- events -------------------------------------------------------------

function send(res, event) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const set of streams.values()) {
    for (const res of set) {
      if (!res.writableEnded) res.write(line);
    }
  }
}

function openStreamCount() {
  let count = 0;
  for (const set of streams.values()) count += set.size;
  return count;
}

function openStream(req, res, id) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive'
  });
  res.on('error', () => {});
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);

  // Back (or here for the first time): keep the seat and stay alive.
  clearTimeout(removalTimers.get(id));
  removalTimers.delete(id);
  clearTimeout(emptyTimer);
  emptyTimer = null;

  if (!streams.has(id)) streams.set(id, new Set());
  streams.get(id).add(res);
  send(res, { t: 'hello', you: id, snapshot: game.snapshot(Date.now()) });

  res.on('close', () => {
    const set = streams.get(id);
    if (!set || !set.delete(res)) return;
    if (set.size === 0) {
      streams.delete(id);
      if (!shuttingDown && tokens.has(id)) {
        removalTimers.set(id, setTimeout(() => {
          removalTimers.delete(id);
          if (!streams.has(id)) removePlayer(id, 'disconnected');
        }, RECONNECT_GRACE_MS));
      }
    }
    armEmptyTimer();
  });
}

function removePlayer(id, reason) {
  if (!tokens.delete(id)) return;
  game.leave(id);
  clearTimeout(removalTimers.get(id));
  removalTimers.delete(id);
  for (const res of streams.get(id) ?? []) res.end();
  streams.delete(id);
  broadcast({ t: 'leave', id, reason, snapshot: game.snapshot(Date.now()) });
  armEmptyTimer();
}

// ---- lifecycle ----------------------------------------------------------

function armEmptyTimer() {
  if (shuttingDown || emptyTimer || openStreamCount() > 0) return;
  emptyTimer = setTimeout(() => {
    emptyTimer = null;
    if (openStreamCount() === 0) shutdown('last player left');
  }, EMPTY_GRACE_MS);
}

function endRound() {
  roundTimer = null;
  const now = Date.now();
  if (game.tick(now)) broadcast({ t: 'results', scores: game.lastResults, snapshot: game.snapshot(now) });
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`tiny-arena: ending: ${reason}\n`);
  clearTimeout(emptyTimer);
  clearTimeout(roundTimer);
  clearInterval(heartbeatTimer);
  for (const timer of removalTimers.values()) clearTimeout(timer);
  removalTimers.clear();
  broadcast({ t: 'end', reason });
  for (const set of streams.values()) {
    for (const res of set) res.end();
  }
  streams.clear();
  // Stop accepting, drop idle keep-alive sockets, and exit once the listener
  // is closed. Never wait on a client: EXIT_FORCE_MS bounds the wait.
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), EXIT_FORCE_MS).unref();
}

// ---- routes -------------------------------------------------------------

async function route(req, res) {
  const url = new URL(req.url ?? '/', 'http://tiny-arena.invalid');
  const fromHost = isLoopbackAddress(req.socket.remoteAddress);
  const needsKey = url.pathname.startsWith('/api/') || url.pathname === '/events';
  if (needsKey && !fromHost && url.searchParams.get('k') !== roomKey) {
    throw new HttpError(403, 'scan the QR code on the host screen to join');
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = await readFile(path.join(moduleDir, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/info') {
    // Only the host's own screen sees the join URL (it carries the key).
    sendJson(res, 200, { isHost: fromHost, joinUrl: fromHost ? joinUrl : null, lan: joinUrl !== null, phase: game.phase });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/join.svg') {
    if (!fromHost) throw new HttpError(403, 'host only');
    if (!joinUrl) throw new HttpError(404, 'loopback only: no join URL');
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    res.end(toSvg(encodeQr(joinUrl)));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    const id = requirePlayer({ id: url.searchParams.get('id'), token: url.searchParams.get('token') });
    if (shuttingDown) throw new HttpError(503, 'ending');
    openStream(req, res, id);
    return;
  }

  if (req.method !== 'POST') throw new HttpError(404, 'not found');

  if (url.pathname === '/api/join') {
    const body = await readJson(req);
    const now = Date.now();
    const joined = game.join(typeof body.name === 'string' ? body.name : '', now);
    if (!joined.ok) throw new HttpError(409, joined.error);
    const { token, ...player } = joined.player;
    tokens.set(player.id, token);
    broadcast({ t: 'join', player, snapshot: game.snapshot(now) });
    sendJson(res, 200, { id: player.id, token, color: player.color });
    return;
  }

  if (url.pathname === '/api/move') {
    const body = await readJson(req);
    const id = requirePlayer(body);
    if (!['up', 'down', 'left', 'right'].includes(body.dir)) throw new HttpError(400, 'dir must be up, down, left or right');
    const seq = Number.isSafeInteger(body.seq) ? body.seq : null;
    const moved = game.move(id, body.dir, seq, Date.now());
    broadcast({ t: 'mv', ...moved });
    sendEmpty(res, 204);
    return;
  }

  if (url.pathname === '/api/start') {
    requirePlayer(await readJson(req));
    const now = Date.now();
    if (game.startRound(now)) {
      clearTimeout(roundTimer);
      roundTimer = setTimeout(endRound, ROUND_MS);
      broadcast({ t: 'round', endsAt: game.endsAt, snapshot: game.snapshot(now) });
    }
    sendEmpty(res, 204);
    return;
  }

  if (url.pathname === '/api/leave') {
    removePlayer(requirePlayer(await readJson(req)), 'left');
    sendEmpty(res, 204);
    return;
  }

  if (url.pathname === '/api/end') {
    // Only the computer running the game can end it; phones just leave.
    if (!fromHost) throw new HttpError(403, 'host only');
    await readJson(req);
    res.writeHead(204, { 'Cache-Control': 'no-store', Connection: 'close' });
    res.end(() => shutdown('host ended the game'));
    return;
  }

  throw new HttpError(404, 'not found');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    const status = error instanceof HttpError ? error.status : 500;
    if (!res.headersSent) sendJson(res, status, { error: error instanceof HttpError ? error.message : 'internal error' });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  const lanIp = lanAddress();
  joinUrl = lanIp ? `http://${lanIp}:${port}/?k=${roomKey}` : null;
  heartbeatTimer = setInterval(() => {
    for (const set of streams.values()) {
      for (const res of set) {
        if (!res.writableEnded) res.write(': hb\n\n');
      }
    }
  }, HEARTBEAT_MS);
  armEmptyTimer(); // nobody has joined yet: the same grace applies
  // The readiness line Conduit's service.start waits for, with the address
  // this computer reaches the game at (loopback for a loopback or wildcard
  // bind, which are the two binds Conduit asks for).
  const local = isLoopbackAddress(HOST) || HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
  process.stdout.write(`CONDUIT_READY http://${local}:${port}/\n`);
});

process.on('SIGTERM', () => shutdown('stopped'));
process.on('SIGINT', () => shutdown('stopped'));
