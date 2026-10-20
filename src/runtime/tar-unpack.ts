import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import path from 'node:path';

// Bounded, link-free unpack of a gzipped POSIX tar in `npm pack` layout.
//
// Package format (and why): an `npm pack` tarball is a gzipped POSIX tar in
// which every entry lives under one top-level `package/` directory and
// `package/package.json` is the manifest. It is the smallest sane choice:
// any JS author makes one with `npm pack`, Node has gzip built in
// (`node:zlib`), and the tar subset accepted here is small enough to parse by
// hand with no dependency. Everything outside that subset — hard links,
// symlinks, devices, fifos, GNU long names, base-256 sizes — is refused rather
// than interpreted, because each of those would let an entry name bytes or
// paths the header does not state.

export interface UnpackLimits {
  maxEntries: number;
  maxUnpackedBytes: number;
  maxPaxHeaderBytes: number;
}

export interface UnpackResult {
  entryCount: number;
  unpackedBytes: number;
  /** Relative paths (without the package/ prefix) of regular files. */
  files: string[];
}

export class PackageArchiveError extends Error {}

const BLOCK = 512;
const READ_CHUNK = 256 * 1024;

/**
 * Small exact-bytes reader over the (async-iterable) gunzip stream: it never
 * buffers the whole archive, only what the next request needs.
 */
class ExactReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(stream: NodeJS.ReadableStream) {
    this.iterator = (stream as unknown as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  }

  /** Exactly `length` bytes, or null when the stream ended first. */
  async readExact(length: number): Promise<Buffer | null> {
    if (length === 0) {
      return Buffer.alloc(0);
    }
    while (this.pending.length < length) {
      if (this.ended) {
        return null;
      }
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        return null;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    }
    const out = this.pending.subarray(0, length);
    this.pending = this.pending.subarray(length);
    return out;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) {
      return false;
    }
  }
  return true;
}

/** Octal-ASCII field (NUL/space terminated), or null when unreadable. */
function parseOctal(field: Buffer): number | null {
  const text = field.toString('latin1').replace(/[\0 ]/g, '');
  if (text === '') {
    return 0;
  }
  if (!/^[0-7]+$/.test(text)) {
    return null;
  }
  return parseInt(text, 8);
}

function nulTerminated(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const stop = field.indexOf(0);
  return field.subarray(0, stop < 0 ? undefined : stop).toString('latin1');
}

/** `<len> key=value\n` pax records; a record's len includes itself and the newline. */
function parsePaxRecords(body: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) {
      break;
    }
    const lengthText = body.toString('utf8', offset, space);
    const recordLength = Number(lengthText);
    if (!Number.isInteger(recordLength) || recordLength <= 0 || offset + recordLength > body.length) {
      break;
    }
    // Skip the length digits and the single space after them.
    const record = body.toString('utf8', space + 1, offset + recordLength).replace(/\n$/, '');
    const equals = record.indexOf('=');
    if (equals > 0) {
      records.set(record.slice(0, equals), record.slice(equals + 1));
    }
    offset += recordLength;
  }
  return records;
}

/**
 * Resolves one entry name to its relative path under `destDir`, enforcing every
 * path rule. Returns null for the bare `package/` directory entry (skipped).
 * Refuses with PackageArchiveError naming the entry otherwise.
 */
function resolveEntryRelPath(name: string, typeflag: string): string | null {
  if (name.includes('\0')) {
    throw new PackageArchiveError(`Package entry '${name}' contains a NUL character.`);
  }
  if (name.includes('\\')) {
    throw new PackageArchiveError(`Package entry '${name}' contains a backslash.`);
  }
  if (name.startsWith('/')) {
    throw new PackageArchiveError(`Package entry '${name}' is an absolute path.`);
  }
  if (name !== 'package' && !name.startsWith('package/')) {
    throw new PackageArchiveError(`Package entry '${name}' is outside the top-level package/ directory.`);
  }
  let relative = name === 'package' ? '' : name.slice('package/'.length);
  if (typeflag === '5' && relative.endsWith('/')) {
    relative = relative.slice(0, -1);
  }
  if (relative === '') {
    // The bare `package/` directory entry itself is skipped.
    return null;
  }
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new PackageArchiveError(`Package entry '${name}' contains an unsafe path segment.`);
    }
  }
  return relative;
}

export async function unpackTarGz(archivePath: string, destDir: string, limits: UnpackLimits): Promise<UnpackResult> {
  const source = createReadStream(archivePath);
  const gunzip = createGunzip();
  // A read error on the archive file ends the gunzip stream with that error,
  // so the reader below rejects instead of waiting for bytes that never come.
  source.on('error', (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  const fail = (error: unknown): Error =>
    error instanceof PackageArchiveError
      ? error
      : new PackageArchiveError(`Package archive could not be read: ${message(error)}`);
  await mkdir(destDir, { recursive: true, mode: 0o755 });

  const files: string[] = [];
  const seenPaths = new Set<string>();
  let entryCount = 0;
  let paxHeaders = 0;
  let fileBytes = 0;

  try {
    const reader = new ExactReader(gunzip);
    let pendingPax: { path?: string; size?: number } | null = null;

    for (;;) {
      const header = await reader.readExact(BLOCK);
      if (!header) {
        throw new PackageArchiveError(`Package archive is truncated (missing ${BLOCK}-byte header block).`);
      }
      if (isZeroBlock(header)) {
        // First all-zero 512-byte block: end of archive. Stop reading and
        // destroy the stream; whatever follows is not part of this archive.
        break;
      }

      const rawName = nulTerminated(header, 0, 100);
      let name = rawName;
      const prefix = nulTerminated(header, 345, 155);
      if (prefix !== '') {
        name = `${prefix}/${name}`;
      }

      // Checksum: field 148..156, octal, computed with the field as 8 spaces.
      let checksum = 0;
      for (let i = 0; i < BLOCK; i += 1) {
        checksum += i >= 148 && i < 156 ? 0x20 : header[i];
      }
      const storedChecksum = parseOctal(header.subarray(148, 156));
      if (storedChecksum === null || storedChecksum !== checksum) {
        throw new PackageArchiveError(`Package entry '${name}' has a corrupt ustar header (checksum mismatch).`);
      }
      if (header.toString('latin1', 257, 262) !== 'ustar') {
        throw new PackageArchiveError(`Package entry '${name}' is not in a ustar header.`);
      }

      const sizeField = header.subarray(124, 136);
      if ((sizeField[0] & 0x80) !== 0) {
        // Base-256 sizes are only used for sizes far beyond anything a package
        // needs; refuse instead of interpreting.
        throw new PackageArchiveError(`Package entry '${name}' has a base-256 size, which is too large to accept.`);
      }
      let size = parseOctal(sizeField);
      if (size === null) {
        throw new PackageArchiveError(`Package entry '${name}' has an unreadable ustar size field.`);
      }
      const typeflag = String.fromCharCode(header[156]);

      // A pax header applies to the NEXT entry only.
      if (pendingPax?.path !== undefined) {
        name = pendingPax.path;
      }
      if (pendingPax?.size !== undefined) {
        size = pendingPax.size;
      }
      pendingPax = null;

      const skipPadding = async (bodySize: number): Promise<void> => {
        const pad = (BLOCK - (bodySize % BLOCK)) % BLOCK;
        if (pad > 0 && (await reader.readExact(pad)) === null) {
          throw new PackageArchiveError(`Package archive is truncated in the padding after '${name}'.`);
        }
      };

      if (typeflag === 'x' || typeflag === 'g') {
        // Pax extended (x) or global (g) header: the body is pax records.
        // Pax headers count toward maxEntries: thousands of them would keep the start busy too.
        if (entryCount + paxHeaders + 1 > limits.maxEntries) {
          throw new PackageArchiveError(`Package has more entries than the limit of ${limits.maxEntries} (at pax header '${name}').`);
        }
        paxHeaders += 1;
        if (size > limits.maxPaxHeaderBytes) {
          throw new PackageArchiveError(
            `Package pax header '${name}' is ${size} bytes; the limit is ${limits.maxPaxHeaderBytes}.`
          );
        }
        const body = await reader.readExact(size);
        if (!body) {
          throw new PackageArchiveError(`Package archive is truncated in the pax header '${name}'.`);
        }
        await skipPadding(size);
        if (typeflag === 'x') {
          // Honour only path and size; every other key is ignored.
          const records = parsePaxRecords(body);
          const paths = records.get('path');
          const sizes = records.get('size');
          if (paths !== undefined && paths !== '') {
            pendingPax = { path: paths };
          }
          if (sizes !== undefined) {
            const paxSize = Number.parseInt(sizes, 10);
            if (!Number.isSafeInteger(paxSize) || paxSize < 0) {
              throw new PackageArchiveError(`Package pax header '${name}' has an unreadable size record ${JSON.stringify(sizes)}.`);
            }
            pendingPax = { ...(pendingPax ?? {}), size: paxSize };
          }
        }
        continue;
      }

      if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '5') {
        throw new PackageArchiveError(
          `Package entry '${name}' has typeflag ${JSON.stringify(typeflag)}: packages may hold only regular files and directories.`
        );
      }

      const isDirectory = typeflag === '5';
      if (isDirectory && size !== 0) {
        // A directory has no data. Skipping a non-zero body would desync the
        // headers that follow, so refuse it.
        throw new PackageArchiveError(`Package directory entry '${name}' declares ${size} data bytes.`);
      }
      const relative = resolveEntryRelPath(name, typeflag === '5' ? typeflag : '0');
      if (relative === null) {
        continue;
      }
      if (seenPaths.has(relative)) {
        throw new PackageArchiveError(`Package has a second entry for the same relative path '${relative}'.`);
      }
      seenPaths.add(relative);

      // Bounds are checked from the header, BEFORE any data is written.
      const entryBytes = isDirectory ? 0 : size;
      if (entryCount + paxHeaders + 1 > limits.maxEntries) {
        throw new PackageArchiveError(`Package has more entries than the limit of ${limits.maxEntries} (at '${name}').`);
      }
      if (fileBytes + entryBytes > limits.maxUnpackedBytes) {
        throw new PackageArchiveError(
          `Package is larger unpacked (${fileBytes + entryBytes} bytes) than the limit of ${limits.maxUnpackedBytes} (at '${name}').`
        );
      }

      // Only regular files and directories are ever created, so no symlink can
      // exist inside destDir.
      const target = path.join(destDir, relative);
      if (isDirectory) {
        await mkdir(target, { recursive: true, mode: 0o755 });
        entryCount += 1;
      } else {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
        // 'wx' (O_CREAT|O_EXCL): never follows or overwrites anything.
        const handle = await open(target, 'wx', 0o644);
        try {
          let remaining = size;
          while (remaining > 0) {
            const want = Math.min(remaining, READ_CHUNK);
            const chunk = await reader.readExact(want);
            if (!chunk) {
              throw new PackageArchiveError(`Package archive is truncated in the data of '${name}'.`);
            }
            await handle.write(chunk);
            remaining -= want;
          }
        } finally {
          await handle.close();
        }
        fileBytes += size;
        files.push(relative);
        entryCount += 1;
      }

      const pad = (BLOCK - (size % BLOCK)) % BLOCK;
      if (pad > 0 && (await reader.readExact(pad)) === null) {
        throw new PackageArchiveError(`Package archive is truncated in the padding after '${name}'.`);
      }
    }

    return {
      entryCount,
      unpackedBytes: fileBytes,
      files
    };
  } catch (error) {
    throw fail(error);
  } finally {
    source.destroy();
    gunzip.destroy();
  }
}
