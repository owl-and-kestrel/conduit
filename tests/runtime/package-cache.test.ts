import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { preparePackage, getPackageCacheRoot, PackageError, PACKAGE_MAX_REDIRECTS } from '../../src/runtime/package-cache.js';
import { PackageArchiveError } from '../../src/runtime/tar-unpack.js';
import { makeTarGz, paxRecords } from '../helpers/tar-fixture.js';
import { removeTree } from '../helpers/remove-tree.js';

const VALID_MANIFEST = { name: 'demo-pkg', conduit: { entry: 'server.mjs', runtime: 'node' } };

function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Fixture tars for tests that do not care about the exact contents. */
function validPackageTar(): Buffer {
  return makeTarGz([
    { name: 'package/', type: '5' },
    { name: 'package/package.json', body: JSON.stringify(VALID_MANIFEST) },
    { name: 'package/server.mjs', body: 'export default "server";\n' },
    { name: 'package/lib/', type: '5' },
    { name: 'package/lib/util.mjs', body: 'export const util = () => 1;\n' }
  ]);
}

describe('package cache (preparePackage, in-process, loopback only)', () => {
  let tempRoot: string;
  let fixtureServer: Server | undefined;
  let fixturePort = 0;
  let serverRequests = 0;
  let serverBytes = 0;
  const fixtures = new Map<string, Buffer>();

  const packageUrl = (name = 'x.tgz'): string => `http://127.0.0.1:${fixturePort}/${name}`;
  /** Serves exactly these bytes at a path named by their digest, and returns its URL. */
  const serve = (archive: Buffer): string => {
    const name = `${sha256Of(archive)}.tgz`;
    fixtures.set(`/${name}`, archive);
    return packageUrl(name);
  };

  beforeEach(async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'conduit-package-cache-'));
    process.env.CONDUIT_STATE_DIR = path.join(tempRoot, 'state');
    mkdirSync(process.env.CONDUIT_STATE_DIR, { recursive: true });
    serverRequests = 0;
    serverBytes = 0;
    fixtures.clear();
    fixtures.set('/x.tgz', validPackageTar());
    fixtureServer = createServer((req, res) => {
      serverRequests += 1;
      // One redirect hop fixture: /hop.tgz redirects to /x.tgz.
      if ((req.url ?? '/').split('?')[0] === '/hop.tgz') {
        res.writeHead(302, { location: packageUrl() });
        res.end();
        return;
      }
      const bytes = fixtures.get((req.url ?? '/').split('?')[0]);
      if (!bytes) {
        res.writeHead(404);
        res.end();
        return;
      }
      // Count the bytes we send, like the tests do for the fetch count.
      serverBytes += bytes.length;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) });
      res.end(bytes);
    });
    await new Promise<void>((resolve, reject) => {
      fixtureServer!.once('error', reject);
      fixtureServer!.listen(0, '127.0.0.1', () => {
        fixturePort = (fixtureServer!.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (fixtureServer) {
      await new Promise<void>((resolve) => fixtureServer!.close(() => resolve()));
      fixtureServer = undefined;
    }
    delete process.env.CONDUIT_STATE_DIR;
    // The cache tree (inside the temp state dir) is chmod'ed read-only.
    if (tempRoot) {
      removeTree(tempRoot);
    }
  });

  it('fetches once, verifies, unpacks read-only, and records provenance', async () => {
    const archive = validPackageTar();
    const ref = { url: serve(archive), sha256: sha256Of(archive), size: archive.length };
    const prepared = await preparePackage(ref);

    expect(prepared.cached).toBe(false);
    expect(prepared.bytesFetched).toBe(archive.length);
    expect(prepared.sha256).toBe(ref.sha256);

    const cacheDir = path.join(getPackageCacheRoot(), ref.sha256);
    expect(prepared.dir).toBe(cacheDir);
    expect(prepared.entry).toBe(path.join(cacheDir, 'server.mjs'));
    expect(existsSync(path.join(cacheDir, 'server.mjs'))).toBe(true);
    expect(existsSync(path.join(cacheDir, 'lib', 'util.mjs'))).toBe(true);
    expect(existsSync(path.join(cacheDir, 'package.json'))).toBe(true);
    // Read-only modes: every file 0o444, every directory 0o555.
    expect(statSync(cacheDir).mode & 0o777).toBe(0o555);
    expect(statSync(path.join(cacheDir, 'lib')).mode & 0o777).toBe(0o555);
    expect(statSync(path.join(cacheDir, 'server.mjs')).mode & 0o777).toBe(0o444);
    expect(statSync(path.join(cacheDir, 'lib', 'util.mjs')).mode & 0o777).toBe(0o444);

    // Provenance json.
    const provenance = JSON.parse(
      readFileSync(path.join(getPackageCacheRoot(), `${ref.sha256}.json`), 'utf8')
    ) as Record<string, unknown>;
    expect(provenance).toMatchObject({
      sha256: ref.sha256,
      url: ref.url,
      bytes: archive.length,
      // package.json, server.mjs, lib/ and lib/util.mjs; the bare package/
      // directory entry itself is skipped.
      entryCount: 4,
      unpackedBytes: expect.any(Number),
      entry: 'server.mjs'
    });
    expect(serverRequests).toBe(1);
    expect(serverBytes).toBe(archive.length);
  });

  it('honours a pax path record for the next entry and ignores other pax keys', async () => {
    const longName = `package/${'d'.repeat(60)}/${'f'.repeat(60)}.mjs`;
    const archive = makeTarGz([
      { name: 'package/package.json', body: JSON.stringify(VALID_MANIFEST) },
      { name: 'package/server.mjs', body: 'x' },
      { name: 'global', type: 'g', body: paxRecords({ comment: 'ignored' }) },
      { name: 'pax', type: 'x', body: paxRecords({ path: longName, 'LIBARCHIVE.xattr.com.apple.provenance': 'AQIAAA' }) },
      { name: 'package/short-placeholder', body: 'long' }
    ]);
    const prepared = await preparePackage({ url: serve(archive), sha256: sha256Of(archive) });
    expect(readFileSync(path.join(prepared.dir, longName.slice('package/'.length)), 'utf8')).toBe('long');
    expect(existsSync(path.join(prepared.dir, 'short-placeholder'))).toBe(false);
  });

  it('a second prepare of the same digest is a cache hit and never fetches', async () => {
    const archive = validPackageTar();
    const ref = { url: serve(archive), sha256: sha256Of(archive), size: archive.length };
    await preparePackage(ref);
    const prepared = await preparePackage(ref);

    expect(prepared.cached).toBe(true);
    expect(prepared.bytesFetched).toBe(0);
    expect(prepared.entry).toBe(path.join(getPackageCacheRoot(), ref.sha256, 'server.mjs'));
    expect(serverRequests).toBe(1);
  });

  it('refuses a byte-flipped archive with no unpacked or temp leftovers', async () => {
    const archive = validPackageTar();
    const originalSha = sha256Of(archive);
    const flipped = Buffer.from(archive);
    flipped[0] = flipped[0] ^ 0x01;
    fixtures.set('/flipped.tgz', flipped);

    const error = await preparePackage({
      url: packageUrl('flipped.tgz'),
      sha256: originalSha,
      size: flipped.length
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PackageError);
    expect(String(error)).toMatch(/sha256 mismatch/);

    const root = getPackageCacheRoot();
    expect(existsSync(path.join(root, originalSha))).toBe(false);
    expect(readdirSync(root).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
  });

  describe('traversal and link refusals (nothing is created)', () => {
    const cases: Array<{ name: string; tar: Buffer; expected: RegExp }> = [
      {
        name: 'package/../evil.mjs',
        tar: makeTarGz([{ name: 'package/', type: '5' }, { name: 'package/package.json', body: JSON.stringify(VALID_MANIFEST) }, { name: 'package/../evil.mjs', body: 'x' }]),
        expected: /unsafe path segment/
      },
      {
        name: 'absolute /abs.mjs',
        tar: makeTarGz([{ name: '/abs.mjs', body: 'x' }]),
        expected: /absolute path/
      },
      {
        name: 'package/a/../../evil.mjs',
        tar: makeTarGz([{ name: 'package/a/../../evil.mjs', body: 'x' }]),
        expected: /unsafe path segment/
      },
      {
        name: 'other/x.mjs outside package/',
        tar: makeTarGz([{ name: 'other/x.mjs', body: 'x' }]),
        expected: /outside the top-level package\//
      },
      {
        name: 'symlink entry',
        tar: makeTarGz([{ name: 'package/link', type: '2', linkname: '/etc/passwd' }]),
        expected: /only regular files and directories/
      },
      {
        name: 'hard link entry',
        tar: makeTarGz([{ name: 'package/ln', type: '1', linkname: 'package/server.mjs' }]),
        expected: /only regular files and directories/
      },
      {
        name: 'pax path override with traversal',
        tar: makeTarGz([
          { name: 'pax', type: 'x', body: paxRecords({ path: 'package/../evil.mjs' }) },
          { name: 'innocent', body: 'x' }
        ]),
        expected: /unsafe path segment/
      },
      {
        name: 'duplicate package/server.mjs',
        tar: makeTarGz([
          { name: 'package/package.json', body: JSON.stringify(VALID_MANIFEST) },
          { name: 'package/server.mjs', body: 'a' },
          { name: 'package/server.mjs', body: 'b' }
        ]),
        expected: /second entry/
      }
    ];

    for (const testCase of cases) {
      it(`refuses ${testCase.name}`, async () => {
        const error = await preparePackage({
          url: serve(testCase.tar),
          sha256: sha256Of(testCase.tar),
          size: testCase.tar.length
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(PackageArchiveError);
        expect(String(error)).toMatch(testCase.expected);
        // No temp artifacts left in the cache root, and nothing was created
        // outside the state dir (there is no cache dir until a start succeeds).
        // Nothing at all is left in the cache root (no temp dir, no escaped
        // file beside it, no archive or cache dir for the refused digest), and
        // nothing was created outside the state dir.
        expect(readdirSync(getPackageCacheRoot())).toEqual([]);
        expect(readdirSync(tempRoot)).toEqual(['state']);
      });
    }
  });

  describe('bounds via options.limits', () => {
    it('maxEntries 2 with 3 entries is rejected', async () => {
      const archive = makeTarGz([
        { name: 'package/package.json', body: JSON.stringify(VALID_MANIFEST) },
        { name: 'package/server.mjs', body: 'x' },
        { name: 'package/lib/util.mjs', body: 'x' }
      ]);
      const error = await preparePackage(
        { url: serve(archive), sha256: sha256Of(archive), size: archive.length },
        { limits: { maxEntries: 2 } }
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PackageArchiveError);
      expect(String(error)).toMatch(/more entries than the limit/);
    });

    it('pax headers count toward maxEntries', async () => {
      const archive = makeTarGz([
        { name: 'global', type: 'g', body: paxRecords({ comment: 'one' }) },
        { name: 'global', type: 'g', body: paxRecords({ comment: 'two' }) },
        { name: 'package/package.json', body: JSON.stringify(VALID_MANIFEST) },
        { name: 'package/server.mjs', body: 'x' }
      ]);
      const error = await preparePackage(
        { url: serve(archive), sha256: sha256Of(archive), size: archive.length },
        { limits: { maxEntries: 3 } }
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PackageArchiveError);
      expect(String(error)).toMatch(/more entries than the limit of 3/);
    });

    it('maxUnpackedBytes 10 with a 20-byte file is rejected', async () => {
      const archive = makeTarGz([
        { name: 'package/package.json', body: JSON.stringify(VALID_MANIFEST) },
        { name: 'package/big.mjs', body: '01234567890123456789' }
      ]);
      const error = await preparePackage(
        { url: serve(archive), sha256: sha256Of(archive), size: archive.length },
        { limits: { maxUnpackedBytes: 10 } }
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PackageArchiveError);
      expect(String(error)).toMatch(/limit of 10/);
    });

    it('pax header bytes count toward maxUnpackedBytes', async () => {
      const archive = makeTarGz([
        { name: 'global', type: 'g', body: paxRecords({ comment: 'x'.repeat(200) }) },
        { name: 'package/package.json', body: JSON.stringify(VALID_MANIFEST) },
        { name: 'package/server.mjs', body: 'x' }
      ]);
      const error = await preparePackage(
        { url: serve(archive), sha256: sha256Of(archive), size: archive.length },
        { limits: { maxUnpackedBytes: 150 } }
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PackageArchiveError);
      expect(String(error)).toMatch(/pax headers included\) than the limit of 150/);
    });

    it('a size that is given but wrong is rejected', async () => {
      const archive = validPackageTar();
      const error = await preparePackage({
        url: serve(archive),
        sha256: sha256Of(archive),
        size: archive.length + 7
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PackageError);
      expect(String(error)).toMatch(/size mismatch/);
    });

    it('maxArchiveBytes smaller than the archive is rejected', async () => {
      const archive = validPackageTar();
      const error = await preparePackage(
        { url: serve(archive), sha256: sha256Of(archive) },
        { limits: { maxArchiveBytes: 64 } }
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PackageError);
      expect(String(error)).toMatch(/archive limit/);
      expect(readdirSync(getPackageCacheRoot()).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
    });
  });

  describe('URL rule and manifest validation', () => {
    it('refuses a non-https, non-loopback URL before any request at all', async () => {
      const calls: string[] = [];
      const recordingFetch = (async (input: string | URL | Request) => {
        calls.push(String(input));
        throw new Error('preparePackage must never fetch this URL.');
      }) as unknown as typeof fetch;
      const archive = validPackageTar();
      const error = await preparePackage(
        { url: 'http://example.invalid/x.tgz', sha256: sha256Of(archive) },
        { fetchImpl: recordingFetch }
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PackageError);
      expect(String(error)).toMatch(/https/);
      expect(calls).toEqual([]);
    });

    it('refuses a manifest without conduit.entry', async () => {
      const archive = makeTarGz([{ name: 'package/package.json', body: JSON.stringify({ conduit: { runtime: 'node' } }) }]);
      const error = await preparePackage({ url: serve(archive), sha256: sha256Of(archive), size: archive.length })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PackageError);
      expect(String(error)).toMatch(/conduit\.entry/);
    });

    it('refuses a manifest with a non-node runtime', async () => {
      const archive = makeTarGz([{
        name: 'package/package.json',
        body: JSON.stringify({ conduit: { entry: 'server.mjs', runtime: 'deno' } })
      }]);
      const error = await preparePackage({ url: serve(archive), sha256: sha256Of(archive), size: archive.length })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PackageError);
      expect(String(error)).toMatch(/runtime must be 'node'/);
    });
  });

  it('follows redirect hops and re-checks the target of each hop', async () => {
    const archive = validPackageTar();
    const prepared = await preparePackage({
      url: packageUrl('hop.tgz'),
      sha256: sha256Of(archive),
      size: archive.length
    });
    // One hop request, then the archive from the re-checked hop target.
    expect(prepared.cached).toBe(false);
    expect(prepared.bytesFetched).toBe(archive.length);
    expect(serverRequests).toBe(2);
  });

  it('refuses a redirect hop to plain http on a non-loopback host', async () => {
    const calls: string[] = [];
    const downgradingFetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(null, { status: 302, headers: { location: 'http://example.invalid/x.tgz' } });
    }) as unknown as typeof fetch;
    const error = await preparePackage(
      { url: 'http://127.0.0.1/x.tgz', sha256: sha256Of(validPackageTar()) },
      { fetchImpl: downgradingFetch }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PackageError);
    expect(String(error)).toMatch(/https/);
    // The refused hop was never requested.
    expect(calls).toEqual(['http://127.0.0.1/x.tgz']);
  });

  it('refuses more redirect hops than allowed', async () => {
    let hops = 0;
    const loopingFetch = (async () => {
      hops += 1;
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/next.tgz' } });
    }) as unknown as typeof fetch;
    const error = await preparePackage(
      { url: 'http://127.0.0.1/x.tgz', sha256: sha256Of(validPackageTar()) },
      { fetchImpl: loopingFetch }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PackageError);
    expect(String(error)).toMatch(/more than 5 redirects/);
    expect(hops).toBe(PACKAGE_MAX_REDIRECTS + 1);
  });
});
