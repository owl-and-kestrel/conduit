// Tiny Arena as a Conduit package (S2's package form): `npm pack` of the demo
// directory goes through Conduit's real fetch + verify + unpack path from a
// loopback server, and the cached entry runs and ends itself. Loopback only.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preparePackage } from '../../src/runtime/package-cache.js';
import { packTinyArena } from '../../scripts/tiny-arena-client.js';

const children: ChildProcess[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
const savedStateDir = process.env.CONDUIT_STATE_DIR;

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  if (savedStateDir === undefined) delete process.env.CONDUIT_STATE_DIR;
  else process.env.CONDUIT_STATE_DIR = savedStateDir;
});

// The cache tree is read-only by design: chmod -R u+w before removing.
function removeTree(root: string): void {
  const walk = (target: string): void => {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) return;
    chmodSync(target, stats.isDirectory() ? 0o700 : 0o600);
    if (stats.isDirectory()) for (const name of readdirSync(target)) walk(path.join(target, name));
  };
  walk(root);
  rmSync(root, { recursive: true, force: true });
}

function serve(body: Buffer): Promise<{ url: string; served: () => number }> {
  let bytes = 0;
  const server = http.createServer((_req, res) => {
    bytes += body.length;
    res.writeHead(200, { 'Content-Length': body.length }).end(body);
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/tiny-arena.tgz`, served: () => bytes });
    });
  });
}

describe('Tiny Arena package (S2 package form)', () => {
  it('npm pack is reproducible and ships only the runtime files', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tiny-arena-pack-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const first = packTinyArena(path.join(root, 'a'));
    const second = packTinyArena(path.join(root, 'b'));
    expect(second.sha256).toBe(first.sha256);
    expect(first.bytes.length).toBeLessThan(64 * 1024);
  }, 60_000);

  it('is fetched, verified, unpacked and cached by Conduit, and its entry runs from the cache', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tiny-arena-package-'));
    cleanups.push(() => removeTree(root));
    process.env.CONDUIT_STATE_DIR = path.join(root, 'state');
    const packed = packTinyArena(root);
    const host = await serve(packed.bytes);

    const prepared = await preparePackage({ url: host.url, sha256: packed.sha256, size: packed.bytes.length });
    expect(prepared.cached).toBe(false);
    expect(prepared.bytesFetched).toBe(packed.bytes.length);
    expect(prepared.manifest).toMatchObject({ entry: 'server.mjs', runtime: 'node' });
    expect(prepared.entry).toBe(path.join(prepared.dir, 'server.mjs'));
    expect(readdirSync(prepared.dir).sort()).toEqual(['README.md', 'game.mjs', 'package.json', 'public', 'qr.mjs', 'server.mjs']);

    // Second time: from the cache, nothing fetched.
    const again = await preparePackage({ url: host.url, sha256: packed.sha256, size: packed.bytes.length });
    expect(again).toMatchObject({ cached: true, bytesFetched: 0, dir: prepared.dir });
    expect(host.served()).toBe(packed.bytes.length);

    // The verified bytes run from the read-only cache dir (cwd = that dir)
    // and end themselves on SIGTERM with exit 0.
    const child = spawn(process.execPath, [prepared.entry], {
      cwd: prepared.dir,
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'ignore']
    });
    children.push(child);
    const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const url = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('no CONDUIT_READY')), 10_000);
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        out += chunk;
        const match = out.match(/^CONDUIT_READY (\S+)$/m);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
    });
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Tiny Arena');
    child.kill('SIGTERM');
    expect(await exit).toBe(0);
  }, 60_000);
});
