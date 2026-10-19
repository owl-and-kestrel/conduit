import { gzipSync } from 'node:zlib';

/**
 * Builds a valid gzipped ustar tar for the package-cache tests: every entry
 * gets a real header (magic `ustar\0`, version `00`, correct octal mode/uid/
 * gid/mtime/size fields and a checksum computed over the field as 8 spaces),
 * its body, padding to the next 512-byte boundary, and the archive ends with
 * two zero blocks. Entries use exactly the typeflags and names the unpacker
 * accepts or is asked to refuse.
 */
export interface TarEntry {
  name: string;
  type?: '0' | '1' | '2' | '5' | 'x' | 'g';
  body?: string | Buffer;
  /** linkname field for the link typeflags. */
  linkname?: string;
  /** ustar prefix field content. */
  prefix?: string;
}

const BLOCK = 512;

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  // length octal digits, then NUL (or space for the last field before chksum).
  const digits = Math.max(1, length - 1);
  const text = value.toString(8).padStart(digits, '0');
  header.write(text + '\0', offset, length, 'latin1');
}

function writeString(header: Buffer, offset: number, length: number, text: string): void {
  header.write(text, offset, length, 'latin1');
}

export function makeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = typeof entry.body === 'string' || entry.body === undefined ? Buffer.from(entry.body ?? '', 'utf8') : entry.body;
    const header = Buffer.alloc(BLOCK, 0);
    writeString(header, 0, 100, entry.name);
    writeOctal(header, 100, 8, entry.type === '5' ? 0o40755 : 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.type === '5' ? 0 : body.length);
    writeOctal(header, 136, 12, 0);
    if (entry.linkname) {
      writeString(header, 157, 100, entry.linkname);
    }
    // magic + version
    writeString(header, 257, 6, 'ustar\0');
    writeString(header, 263, 2, '00');
    if (entry.prefix !== undefined) {
      writeString(header, 345, 155, entry.prefix);
    }
    const typeflag = entry.type ?? '0';
    header[156] = typeflag.charCodeAt(0);
    // Checksum with the checksum field treated as 8 spaces.
    for (let i = 148; i < 156; i += 1) {
      header[i] = 0x20;
    }
    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
    parts.push(header);
    if (body.length > 0) {
      parts.push(body);
      const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
      if (pad > 0) {
        parts.push(Buffer.alloc(pad, 0));
      }
    }
  }
  // End of archive: two all-zero blocks.
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

export function makeTarGz(entries: TarEntry[]): Buffer {
  return gzipSync(makeTar(entries));
}

/**
 * Builds `"<len> <key>=<value>\n"` pax records (the length includes itself, the
 * space separator and the trailing newline), for the pax-header fixtures.
 */
export function paxRecords(records: Record<string, string>): Buffer {
  const pieces: string[] = [];
  for (const [key, value] of Object.entries(records)) {
    const payload = `${key}=${value}`;
    let length = payload.length + 1;
    for (;;) {
      const needed = String(length).length + 1 + payload.length + 1;
      if (needed === length) {
        break;
      }
      length = needed;
    }
    pieces.push(`${length} ${payload}\n`);
  }
  return Buffer.from(pieces.join(''), 'utf8');
}
