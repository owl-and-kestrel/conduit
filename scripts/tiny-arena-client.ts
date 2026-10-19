/**
 * scripts/tiny-arena-client.ts
 *
 * Tiny Arena tooling shared by scripts/demo-server.ts and tests/demo/: the
 * package as `npm pack` ships it, and a headless player over the game's real
 * channel (POST + SSE).
 * Node built-ins only; it talks to whatever base URL it is given and never
 * binds anything itself.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TINY_ARENA_DIR = path.join(REPO_ROOT, 'demo', 'tiny-arena');

/** The package exactly as an author ships it: `npm pack` of demo/tiny-arena,
 * the npm-pack layout Conduit's package cache unpacks (S2). npm pack is
 * reproducible (fixed mtimes and file order), so the same files give the
 * same sha256 with the same npm and zlib. Runs offline; writes only into
 * `outDir`. */
export function packTinyArena(outDir: string): { file: string; bytes: Buffer; sha256: string } {
  mkdirSync(outDir, { recursive: true });
  const out = execFileSync('npm', ['pack', TINY_ARENA_DIR, '--pack-destination', outDir, '--json', '--ignore-scripts', '--offline'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const [first] = JSON.parse(out) as Array<{ filename: string }>;
  if (!first) throw new Error('npm pack printed no package');
  const file = path.join(outDir, first.filename);
  const bytes = readFileSync(file);
  return { file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export interface ArenaEvent {
  t: string;
  [key: string]: unknown;
}

export interface ReceivedEvent {
  event: ArenaEvent;
  /** performance.now() when the event was parsed. */
  at: number;
}

export interface PostResult {
  status: number;
  body: string;
}

/** POST a JSON (or raw string) body; resolves with status and body text. */
export function postJson(baseUrl: string, path: string, body: unknown, contentType = 'application/json'): Promise<PostResult> {
  const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      agent: keepAlive,
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// One keep-alive agent for moves, like a browser reusing its connection.
const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 16 });

/** Close idle keep-alive sockets so a caller's process can exit promptly. */
export function closeClientSockets(): void {
  keepAlive.destroy();
}

/** An open SSE stream with every parsed `data:` event kept in order. */
export class EventStream {
  readonly events: ReceivedEvent[] = [];
  private request: http.ClientRequest | null = null;
  private waiters: Array<() => void> = [];
  closed = false;
  status = 0;

  static open(baseUrl: string, path: string, timeoutMs = 10_000): Promise<EventStream> {
    const stream = new EventStream();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no SSE response from ${path} in ${timeoutMs} ms`)), timeoutMs);
      const req = http.get(new URL(path, baseUrl), { headers: { Accept: 'text/event-stream' } }, (res) => {
        clearTimeout(timer);
        stream.status = res.statusCode ?? 0;
        if (stream.status !== 200) {
          res.resume();
          reject(new Error(`SSE ${path} answered ${stream.status}`));
          return;
        }
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let split = buffer.indexOf('\n\n');
          while (split >= 0) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
            if (data) stream.push(JSON.parse(data) as ArenaEvent);
            split = buffer.indexOf('\n\n');
          }
        });
        const done = (): void => {
          stream.closed = true;
          stream.notify();
        };
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
        resolve(stream);
      });
      req.on('error', (error) => {
        clearTimeout(timer);
        stream.closed = true;
        stream.notify();
        reject(error);
      });
      stream.request = req;
    });
  }

  private push(event: ArenaEvent): void {
    this.events.push({ event, at: performance.now() });
    this.notify();
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /** Resolves with the first event matching `predicate` (already received or
   * future); rejects after `timeoutMs` or when the stream closes first. */
  waitFor(predicate: (event: ArenaEvent) => boolean, timeoutMs = 10_000): Promise<ArenaEvent> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const check = (): void => {
        const found = this.events.find((entry) => predicate(entry.event));
        if (found) {
          resolve(found.event);
          return;
        }
        if (this.closed) {
          reject(new Error('stream closed before the expected event'));
          return;
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          reject(new Error(`no matching event within ${timeoutMs} ms`));
          return;
        }
        const timer = setTimeout(check, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          check();
        });
      };
      check();
    });
  }

  /** Resolves when the server ends the stream. */
  waitClosed(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const check = (): void => {
        if (this.closed) {
          resolve();
          return;
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          reject(new Error(`stream still open after ${timeoutMs} ms`));
          return;
        }
        const timer = setTimeout(check, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          check();
        });
      };
      check();
    });
  }

  close(): void {
    this.closed = true;
    this.request?.destroy();
    this.notify();
  }
}

export interface Player {
  id: string;
  token: string;
  color: string;
  stream: EventStream;
}

/** Join as `name` and open the player's event stream. */
export async function joinPlayer(baseUrl: string, name: string): Promise<Player> {
  const joined = await postJson(baseUrl, '/api/join', { name });
  if (joined.status !== 200) throw new Error(`join answered ${joined.status}: ${joined.body}`);
  const { id, token, color } = JSON.parse(joined.body) as { id: string; token: string; color: string };
  const stream = await EventStream.open(baseUrl, `/events?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`);
  await stream.waitFor((event) => event.t === 'hello');
  return { id, token, color, stream };
}
