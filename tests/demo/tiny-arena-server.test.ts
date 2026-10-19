// Tiny Arena server over its real channel: a real `node server.mjs` process
// on loopback (never a LAN bind in tests: CI hosts can have public IPs).
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConduitUrl, parseConduitUrl } from '../../src/protocol/conduit-url.js';
import { EventStream, joinPlayer, postJson, type Player } from '../../scripts/tiny-arena-client.js';

const packageDir = path.resolve('demo/tiny-arena');
const serverEntry = path.join(packageDir, 'server.mjs');

interface Server {
  child: ChildProcess;
  url: string;
  port: number;
  stdout: () => string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const children: ChildProcess[] = [];
const streams: EventStream[] = [];

afterEach(() => {
  for (const stream of streams) stream.close();
  streams.length = 0;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.length = 0;
});

function startServer(env: Record<string, string> = {}): Promise<Server> {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: packageDir,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push(child);
  let out = '';
  child.stderr?.resume();
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no CONDUIT_READY line within 10 s')), 10_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
      const match = out.match(/^CONDUIT_READY (http:\/\/127\.0\.0\.1:(\d+)\/)$/m);
      if (match) {
        clearTimeout(timer);
        resolve({ child, url: match[1]!, port: Number(match[2]), stdout: () => out, exit });
      }
    });
    child.once('exit', () => reject(new Error(`server exited before ready: ${out}`)));
  });
}

async function join(server: Server, name: string): Promise<Player> {
  const player = await joinPlayer(server.url, name);
  streams.push(player.stream);
  return player;
}

function tcpRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error: NodeJS.ErrnoException) => { socket.destroy(); resolve(error.code === 'ECONNREFUSED'); });
  });
}

async function exitWithin(server: Server, ms: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return Promise.race([
    server.exit,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`server still running after ${ms} ms`)), ms))
  ]);
}

describe('Tiny Arena server (loopback, real process)', () => {
  it('prints CONDUIT_READY, serves the page and tells the host it is loopback only', async () => {
    const server = await startServer();
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('Tiny Arena');
    const info = await (await fetch(new URL('/api/info', server.url))).json();
    expect(info).toEqual({ isHost: true, joinUrl: null, lan: false, phase: 'lobby' });
    expect((await fetch(new URL('/join.svg', server.url))).status).toBe(404);
    expect((await fetch(new URL('/nope', server.url))).status).toBe(404);
    // Tokens and the room key never reach stdout.
    expect(server.stdout().split('\n').filter(Boolean)).toEqual([`CONDUIT_READY ${server.url}`]);
  }, 30_000);

  it('delivers every move to every other player in order', async () => {
    const server = await startServer();
    const a = await join(server, 'Ada');
    const b = await join(server, 'Bo');
    await a.stream.waitFor((event) => event.t === 'join' && (event.player as { id: string }).id === b.id);
    for (let seq = 1; seq <= 20; seq += 1) {
      const dir = (['right', 'down', 'left', 'up'] as const)[seq % 4]!;
      expect((await postJson(server.url, '/api/move', { id: a.id, token: a.token, dir, seq })).status).toBe(204);
    }
    await b.stream.waitFor((event) => event.t === 'mv' && event.id === a.id && event.seq === 20);
    const seen = b.stream.events.map((entry) => entry.event).filter((event) => event.t === 'mv' && event.id === a.id).map((event) => event.seq);
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // The join broadcast carries no token.
    expect(JSON.stringify(a.stream.events.map((entry) => entry.event))).not.toContain(b.token);
  }, 30_000);

  it('runs a round and announces the results', async () => {
    const server = await startServer({ TINY_ARENA_ROUND_MS: '600' });
    const a = await join(server, 'Ada');
    expect((await postJson(server.url, '/api/start', { id: a.id, token: a.token })).status).toBe(204);
    await a.stream.waitFor((event) => event.t === 'round');
    await postJson(server.url, '/api/move', { id: a.id, token: a.token, dir: 'right', seq: 1 });
    const painted = await a.stream.waitFor((event) => event.t === 'mv' && event.seq === 1);
    expect(painted.painted).toBe(true);
    const results = await a.stream.waitFor((event) => event.t === 'results', 5000);
    expect(results.scores).toEqual([{ id: a.id, name: 'Ada', color: a.color, cells: 2 }]);
  }, 30_000);

  it('ends itself with exit 0 after the last player leaves and the grace passes', async () => {
    const server = await startServer({ TINY_ARENA_EMPTY_GRACE_MS: '500' });
    const a = await join(server, 'Ada');
    const b = await join(server, 'Bo');
    expect((await postJson(server.url, '/api/leave', { id: a.id, token: a.token })).status).toBe(204);
    await a.stream.waitClosed();
    // navigator.sendBeacon posts text/plain.
    expect((await postJson(server.url, '/api/leave', JSON.stringify({ id: b.id, token: b.token }), 'text/plain;charset=UTF-8')).status).toBe(204);
    await b.stream.waitClosed();
    const left = Date.now();
    const exit = await exitWithin(server, 5000);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(Date.now() - left).toBeGreaterThanOrEqual(400);
    expect(server.stdout()).toContain('tiny-arena: ending: last player left');
    expect(await tcpRefused(server.port)).toBe(true);
  }, 30_000);

  it('keeps running while a player is connected, past the empty grace', async () => {
    const server = await startServer({ TINY_ARENA_EMPTY_GRACE_MS: '300' });
    await join(server, 'Ada');
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(server.child.exitCode).toBeNull();
    expect((await fetch(server.url)).status).toBe(200);
  }, 30_000);

  it('ends itself when nobody ever joins', async () => {
    const server = await startServer({ TINY_ARENA_EMPTY_GRACE_MS: '300' });
    expect(await exitWithin(server, 5000)).toEqual({ code: 0, signal: null });
    expect(server.stdout()).toContain('tiny-arena: ending: last player left');
  }, 30_000);

  it('exits 0 on SIGTERM and tells connected players', async () => {
    const server = await startServer();
    const a = await join(server, 'Ada');
    server.child.kill('SIGTERM');
    const end = await a.stream.waitFor((event) => event.t === 'end');
    expect(end.reason).toBe('stopped');
    expect(await exitWithin(server, 5000)).toEqual({ code: 0, signal: null });
    expect(server.stdout()).toContain('tiny-arena: ending: stopped');
  }, 30_000);

  it('ends on End game from the host, closes every stream and frees the port', async () => {
    const server = await startServer();
    const a = await join(server, 'Ada');
    const b = await join(server, 'Bo');
    expect((await postJson(server.url, '/api/end', {})).status).toBe(204);
    for (const player of [a, b]) {
      const end = await player.stream.waitFor((event) => event.t === 'end');
      expect(end.reason).toBe('host ended the game');
      await player.stream.waitClosed();
    }
    expect(await exitWithin(server, 5000)).toEqual({ code: 0, signal: null });
    expect(await tcpRefused(server.port)).toBe(true);
  }, 30_000);

  it('refuses bad tokens, bad JSON, oversized bodies and bad moves', async () => {
    const server = await startServer();
    const a = await join(server, 'Ada');
    expect((await postJson(server.url, '/api/move', { id: a.id, token: '0'.repeat(16), dir: 'up', seq: 1 })).status).toBe(401);
    expect((await postJson(server.url, '/api/move', { id: 'p9', token: a.token, dir: 'up', seq: 1 })).status).toBe(401);
    expect((await postJson(server.url, '/api/move', { id: a.id, token: a.token, dir: 'jump', seq: 1 })).status).toBe(400);
    expect((await postJson(server.url, '/api/join', '{not json')).status).toBe(400);
    expect((await postJson(server.url, '/api/join', { name: 'x'.repeat(5000) })).status).toBe(413);
    await expect(EventStream.open(server.url, `/events?id=${a.id}&token=nope`)).rejects.toThrow(/401/);
    // Still serving afterwards.
    expect((await postJson(server.url, '/api/move', { id: a.id, token: a.token, dir: 'down', seq: 2 })).status).toBe(204);
  }, 30_000);
});

describe('Tiny Arena launcher page', () => {
  const html = readFileSync(path.join(packageDir, 'launcher.html'), 'utf8');

  it('pins the sha256 of the entry it asks Conduit to start', () => {
    const pinned = html.match(/const ENTRY_SHA256 = '([0-9a-f]{64})';/)?.[1];
    const actual = createHash('sha256').update(readFileSync(serverEntry)).digest('hex');
    expect(pinned).toBe(actual);
  });

  it('builds a service.start request that survives the conduit:// round trip', () => {
    const json = html.match(/<script type="application\/json" id="request">([\s\S]*?)<\/script>/)?.[1];
    expect(json).toBeDefined();
    const pinned = html.match(/const ENTRY_SHA256 = '([0-9a-f]{64})';/)?.[1] ?? '';
    const request = JSON.parse(json!.replace('__ENTRY_SHA256__', pinned)) as { actions: Array<{ tool: string; args: Record<string, unknown> }> };
    expect(request.actions).toHaveLength(1);
    expect(request.actions[0]).toMatchObject({ tool: 'service.start', args: { path: 'server.mjs', lan: true, sha256: pinned } });
    const parsed = parseConduitUrl(createConduitUrl(JSON.stringify(request)));
    expect(parsed.command).toBe('run');
    expect(JSON.parse(parsed.text)).toEqual(request);
  });

  it('loads nothing from the network', () => {
    for (const file of ['launcher.html', 'public/index.html']) {
      const text = readFileSync(path.join(packageDir, file), 'utf8');
      expect(text).not.toMatch(/(src|href)=["']https?:/);
      expect(text).not.toMatch(/@import|fonts\.googleapis|cdn/i);
    }
  });
});
