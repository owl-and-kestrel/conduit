import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { getStateRoot } from '../state/paths.js';
import { writeFileAtomic } from '../state/atomic-write.js';
import { isLoopbackHostname } from '../util/loopback-guard.js';
import { unpackTarGz } from './tar-unpack.js';

/**
 * Content-addressed cache for packages started by `service.start` with the
 * `package` form: an archive fetched over HTTPS, verified by sha256, unpacked
 * into `<state>/cache/packages/<sha256>/` and spawned FROM that directory, so
 * the bytes a service runs are the bytes that were verified (S1 review F-02).
 * Only filled and read while the demo profile supplies the tool that calls it.
 */

/**
 * The digest can only be checked after the last byte, so without a cap an
 * endless or huge response would fill the person's disk before Conduit could
 * refuse it: refuse above this archive size instead.
 */
export const PACKAGE_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/**
 * A small gzip can expand ~1000x (decompression bomb) and fill the disk;
 * this caps what one accepted archive may expand to.
 */
export const PACKAGE_MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

/**
 * Millions of tiny entries exhaust inodes and keep the start busy for
 * minutes; this bounds how many files and directories one package may hold.
 */
export const PACKAGE_MAX_ENTRIES = 50_000;

/**
 * A pax header is held in memory to parse it, so an unbounded one exhausts
 * Control's memory; this bounds the memory one pax header can hold.
 */
export const PACKAGE_MAX_PAX_HEADER_BYTES = 1024 * 1024;

/**
 * A server that stops sending keeps the start, and the person, waiting
 * forever; the fetch is aborted after this much time without bytes.
 */
export const PACKAGE_FETCH_IDLE_MS = 30_000;

/**
 * A redirect loop never ends; at most this many 3xx hops are followed, and
 * every hop must pass the URL rule again.
 */
export const PACKAGE_MAX_REDIRECTS = 5;

export interface PackageRef {
  url: string;
  sha256: string;
  size?: number;
}

export interface PackageManifest {
  name?: string;
  entry: string;
  runtime: 'node';
}

export interface PreparedPackage {
  sha256: string;
  /** `<cache>/<sha256>`, read-only. */
  dir: string;
  /** Absolute path of the entry file inside `dir`. */
  entry: string;
  manifest: PackageManifest;
  /** True when no fetch happened. */
  cached: boolean;
  /** 0 when cached. */
  bytesFetched: number;
}

export interface PreparePackageOptions {
  fetchImpl?: typeof fetch;
  limits?: Partial<{
    maxArchiveBytes: number;
    maxUnpackedBytes: number;
    maxEntries: number;
    maxPaxHeaderBytes: number;
    idleMs: number;
  }>;
}

export class PackageError extends Error {}

export function getPackageCacheRoot(): string {
  return path.join(getStateRoot(), 'cache', 'packages');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

/** The rename target already holds the same verified object. */
function alreadyPlaced(error: unknown): boolean {
  return isErrno(error, 'EEXIST') || isErrno(error, 'ENOTEMPTY');
}

function assertPackageUrlAllowed(packageUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(packageUrl);
  } catch {
    throw new PackageError(`Package URL is not a valid URL: ${packageUrl}`);
  }
  // https only, except http on a loopback host so the local test server works.
  if (parsed.protocol === 'https:') {
    return;
  }
  if (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)) {
    return;
  }
  throw new PackageError(`Package URL must be https (or http on a loopback host), got: ${packageUrl}`);
}

function isCleanRelative(entry: string): boolean {
  if (entry === '' || entry.includes('\\') || path.isAbsolute(entry)) {
    return false;
  }
  return entry.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

async function readManifest(dir: string, unpackedFiles?: string[]): Promise<PackageManifest> {
  let text: string;
  try {
    text = await readFile(path.join(dir, 'package.json'), 'utf8');
  } catch {
    throw new PackageError('The package has no readable package.json manifest.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PackageError('The package manifest package.json is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PackageError('The package manifest package.json is not an object.');
  }
  const manifestRoot = parsed as Record<string, unknown>;
  const name = typeof manifestRoot.name === 'string' ? manifestRoot.name : undefined;
  const conduit = manifestRoot.conduit;
  if (typeof conduit !== 'object' || conduit === null) {
    throw new PackageError("The package manifest package.json has no 'conduit' section with entry and runtime.");
  }
  const conduitSection = conduit as Record<string, unknown>;
  const entry = conduitSection.entry;
  if (typeof entry !== 'string' || !isCleanRelative(entry)) {
    throw new PackageError(
      `The package manifest conduit.entry must be a relative path with no '..', '.', empty or doubled segments, and no backslash; got: ${JSON.stringify(entry)}`
    );
  }
  const runtime = conduitSection.runtime;
  if (runtime !== 'node') {
    // Jon D3: JS packages run on Conduit's own Node; nothing is installed.
    throw new PackageError(
      `The package manifest conduit.runtime must be 'node' (JS packages run on Conduit's own Node), got: ${JSON.stringify(runtime)}`
    );
  }
  if (unpackedFiles) {
    if (!unpackedFiles.includes(entry)) {
      throw new PackageError(`The package manifest conduit.entry '${entry}' is not a regular file in the package.`);
    }
  } else {
    // A cached dir was verified at unpack; the entry file must still be there.
    const entryStat = await lstat(path.join(dir, entry));
    if (!entryStat.isFile()) {
      throw new PackageError(`The package manifest conduit.entry '${entry}' is not a regular file in the package.`);
    }
  }
  return {
    ...(name !== undefined ? { name } : {}),
    entry,
    runtime: 'node' as const
  };
}

/**
 * Read-only, deepest first, the root last: every file 0o444, every directory
 * 0o555. The service runs with this directory as its cwd, so read-only stops
 * the program (or anything else running as the person by accident) from
 * changing the bytes a later start of the same digest would run; a same-user
 * process can still chmod it back, which needs the same access that already
 * controls Conduit's state dir.
 */
async function makeReadOnly(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await makeReadOnly(child);
      await chmod(child, 0o555);
    } else {
      await chmod(child, 0o444);
    }
  }
  await chmod(dir, 0o555);
}

export async function preparePackage(ref: PackageRef, options: PreparePackageOptions = {}): Promise<PreparedPackage> {
  const limits = {
    maxArchiveBytes: options.limits?.maxArchiveBytes ?? PACKAGE_MAX_ARCHIVE_BYTES,
    maxUnpackedBytes: options.limits?.maxUnpackedBytes ?? PACKAGE_MAX_UNPACKED_BYTES,
    maxEntries: options.limits?.maxEntries ?? PACKAGE_MAX_ENTRIES,
    maxPaxHeaderBytes: options.limits?.maxPaxHeaderBytes ?? PACKAGE_MAX_PAX_HEADER_BYTES,
    idleMs: options.limits?.idleMs ?? PACKAGE_FETCH_IDLE_MS
  };
  const fetchImpl = options.fetchImpl ?? fetch;

  if (typeof ref.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ref.sha256)) {
    throw new PackageError(`Package sha256 must be 64 lowercase hex digits, got: ${JSON.stringify(ref.sha256)}`);
  }
  if (ref.size !== undefined && (!Number.isSafeInteger(ref.size) || ref.size <= 0)) {
    throw new PackageError(`Package size must be a positive integer of bytes, got: ${JSON.stringify(ref.size)}`);
  }

  const root = getPackageCacheRoot();
  const cacheDir = path.join(root, ref.sha256);

  // Cache hit: no network at all.
  try {
    const cachedStat = await lstat(cacheDir);
    if (cachedStat.isDirectory()) {
      const manifest = await readManifest(cacheDir);
      return {
        sha256: ref.sha256,
        dir: cacheDir,
        entry: path.join(cacheDir, manifest.entry),
        manifest,
        cached: true,
        bytesFetched: 0
      };
    }
    // Not a directory (a stray file or symlink is not a verified package):
    // treat as a miss, and the rename below will complain if it matters.
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      // A real filesystem error is not a cache miss.
      throw error;
    }
  }

  // Checked here before any request, and applied to every redirect hop.
  assertPackageUrlAllowed(ref.url);

  const hex = randomBytes(8).toString('hex');
  const archivePath = path.join(root, `.tmp-${hex}.tgz`);
  const unpackDir = path.join(root, `.tmp-${hex}`);
  const controller = new AbortController();
  let idleFired = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdle = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      idleFired = true;
      controller.abort();
    }, limits.idleMs);
  };
  const idleError = (): PackageError =>
    new PackageError(
      `Package fetch was aborted after ${limits.idleMs} ms without bytes: a server that stops sending keeps the start, and the person, waiting forever.`
    );

  resetIdle();
  try {
    // mkdir first: the open below and every later write expect the root.
    await mkdir(root, { recursive: true });

    // Redirects are followed by hand (redirect: 'manual'), so every hop is
    // re-checked against the URL rule before it is requested.
    let currentUrl = ref.url;
    let redirectsLeft = PACKAGE_MAX_REDIRECTS;
    let response: Response;
    for (;;) {
      let attempt: Response;
      try {
        attempt = await fetchImpl(currentUrl, { redirect: 'manual', signal: controller.signal });
      } catch (error) {
        throw idleFired ? idleError() : new PackageError(`Package fetch failed at ${currentUrl}: ${message(error)}`);
      }
      if (attempt.status >= 300 && attempt.status < 400) {
        const location = attempt.headers.get('location');
        void attempt.body?.cancel().catch(() => undefined);
        if (!location) {
          throw new PackageError(`Package fetch redirected without a location header at ${currentUrl}.`);
        }
        if (redirectsLeft <= 0) {
          throw new PackageError(`Package fetch followed more than ${PACKAGE_MAX_REDIRECTS} redirects.`);
        }
        redirectsLeft -= 1;
        currentUrl = new URL(location, currentUrl).toString();
        assertPackageUrlAllowed(currentUrl);
        resetIdle();
        continue;
      }
      if (!attempt.ok) {
        throw new PackageError(`Package fetch failed: HTTP ${attempt.status} for ${currentUrl}.`);
      }
      response = attempt;
      break;
    }

    // Stream the body into the temp archive while hashing and counting, abort
    // and refuse as soon as bytes exceed the cap: the digest cannot be checked
    // before the last byte, so without the cap a huge response fills the disk.
    const capBytes = ref.size !== undefined
      ? Math.min(ref.size, limits.maxArchiveBytes)
      : limits.maxArchiveBytes;
    const hash = createHash('sha256');
    let bytes = 0;
    const target = await open(archivePath, 'wx', 0o600);
    try {
      if (response.body !== null) {
        const bodyIterator = (response.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
        let next = await bodyIterator.next().catch((error: unknown) => {
          throw idleFired ? idleError() : new PackageError(`Package fetch failed reading the body: ${message(error)}`);
        });
        while (!next.done) {
          const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
          resetIdle();
          bytes += chunk.length;
          if (bytes > capBytes) {
            await response.body.cancel().catch(() => undefined);
            throw new PackageError(
              `Package download exceeded the archive limit of ${capBytes} bytes; it is refused before the person's disk is filled.`
            );
          }
          hash.update(chunk);
          await target.write(chunk);
          next = await bodyIterator.next().catch((error: unknown) => {
            throw idleFired ? idleError() : new PackageError(`Package fetch failed reading the body: ${message(error)}`);
          });
        }
      }
      if (ref.size !== undefined && bytes !== ref.size) {
        throw new PackageError(`Package size mismatch: ${ref.size} bytes expected, got ${bytes}.`);
      }
    } finally {
      await target.close();
    }

    const actualSha256 = hash.digest('hex');

    // Step 6: nothing is unpacked before this check passes.
    if (actualSha256 !== ref.sha256) {
      throw new PackageError(
        `Package sha256 mismatch: expected ${ref.sha256}, got ${actualSha256}. Nothing was unpacked.`
      );
    }

    await mkdir(unpackDir, { recursive: true, mode: 0o700 });
    const unpacked = await unpackTarGz(archivePath, unpackDir, limits);
    const manifest = await readManifest(unpackDir, unpacked.files);

    const provenance = {
      sha256: ref.sha256,
      url: ref.url,
      bytes,
      fetchedAt: new Date().toISOString(),
      entryCount: unpacked.entryCount,
      unpackedBytes: unpacked.unpackedBytes,
      entry: manifest.entry
    };

    // Step 8: the verified archive next to the cache dir (EEXIST/ENOTEMPTY
    // means the same digest is already there: the same object).
    try {
      await rename(archivePath, path.join(root, `${ref.sha256}.tgz`));
    } catch (error) {
      if (!alreadyPlaced(error)) {
        throw error;
      }
    }
    await writeFileAtomic(path.join(root, `${ref.sha256}.json`), `${JSON.stringify(provenance, null, 2)}\n`);

    // Step 9: a rename that lost a race to another start falls back to the
    // existing verified directory.
    let placed = true;
    try {
      await rename(unpackDir, cacheDir);
    } catch (error) {
      if (!alreadyPlaced(error)) {
        throw error;
      }
      placed = false;
      await rm(unpackDir, { recursive: true, force: true });
    }
    if (placed) {
      await makeReadOnly(cacheDir);
    }

    return {
      sha256: ref.sha256,
      dir: cacheDir,
      entry: path.join(cacheDir, manifest.entry),
      manifest,
      cached: false,
      bytesFetched: bytes
    };
  } catch (error) {
    // Everything written so far is still writable, so the temp artifacts can
    // always be removed before the failure surfaces.
    await rm(archivePath, { force: true }).catch(() => undefined);
    await rm(unpackDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    // Release the socket behind the response body, whether it was read or not.
    controller.abort();
  }
}
