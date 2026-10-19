// Structural checks for the from-scratch QR encoder. During authoring the
// encoder's output was also decoded by an independent reader (Apple Core
// Image CIDetector) at every version 1-10 x level L/M/Q/H capacity edge, 40/40
// exact; these tests pin the structure that made that true.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeQr, rsCheck, rsGenerator, toSvg, type EccLevel, type QrCode } from '../../demo/tiny-arena/qr.mjs';

// Byte-mode capacities from ISO/IEC 18004 Table 7, versions 1..10.
const CAPACITY: Record<EccLevel, number[]> = {
  L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271],
  M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
  Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151],
  H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119]
};
const ECC_BITS: Record<EccLevel, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

const at = (qr: QrCode, x: number, y: number): boolean => qr.modules[y]![x]!;

function formatCopies(qr: QrCode): [number, number] {
  const { size } = qr;
  const first: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i += 1) first.push([8, i]);
  first.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i += 1) first.push([14 - i, 8]);
  const second: Array<[number, number]> = [];
  for (let i = 0; i < 8; i += 1) second.push([size - 1 - i, 8]);
  for (let i = 8; i < 15; i += 1) second.push([8, size - 15 + i]);
  const read = (cells: Array<[number, number]>): number =>
    cells.reduce((word, [x, y], i) => word | ((at(qr, x, y) ? 1 : 0) << i), 0);
  return [read(first), read(second)];
}

function bchRemainder(value: number, generator: number, generatorBits: number): number {
  let rem = value;
  for (let bit = 31; bit >= generatorBits - 1; bit -= 1) {
    if ((rem >>> bit) & 1) rem ^= generator << (bit - (generatorBits - 1));
  }
  return rem;
}

function expectFinder(qr: QrCode, left: number, top: number): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const x = left + dx;
      const y = top + dy;
      if (x < 0 || y < 0 || x >= qr.size || y >= qr.size) continue;
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      // ring 0-1 core, 2 light, 3 dark border, 4 light separator.
      expect(at(qr, x, y), `finder at ${left},${top} module ${dx},${dy}`).toBe(ring !== 2 && ring !== 4);
    }
  }
}

describe('Tiny Arena QR encoder', () => {
  it('computes the ISO 18004 "01234567" 1-M Reed-Solomon example', () => {
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    expect(rsCheck(data, 10)).toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
    const generator = rsGenerator(7);
    expect(generator).toHaveLength(8);
    expect(generator[0]).toBe(1);
    // x^7 generator: coefficients 1, a^87, a^229, a^146, a^149, a^238, a^102, a^21.
    expect(generator).toEqual([1, 127, 122, 154, 164, 11, 68, 117]);
  });

  it('chooses the smallest version at every byte-mode capacity edge', () => {
    for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
      CAPACITY[ecc].forEach((capacity, index) => {
        const version = index + 1;
        const full = encodeQr('a'.repeat(capacity), { ecc });
        expect(full.version, `${ecc} ${capacity} bytes`).toBe(version);
        expect(full.size).toBe(17 + 4 * version);
        expect(full.modules).toHaveLength(full.size);
        if (version < 10) {
          expect(encodeQr('a'.repeat(capacity + 1), { ecc }).version).toBe(version + 1);
        } else {
          expect(() => encodeQr('a'.repeat(capacity + 1), { ecc })).toThrow(/does not fit/);
        }
      });
    }
  });

  it('draws finders, separators, timing and the dark module', () => {
    for (const text of ['HELLO', 'http://192.168.1.23:54321/?k=0123abcd', 'x'.repeat(200)]) {
      const qr = encodeQr(text);
      expectFinder(qr, 0, 0);
      expectFinder(qr, qr.size - 7, 0);
      expectFinder(qr, 0, qr.size - 7);
      for (let i = 8; i <= qr.size - 9; i += 1) {
        expect(at(qr, i, 6)).toBe(i % 2 === 0);
        expect(at(qr, 6, i)).toBe(i % 2 === 0);
      }
      expect(at(qr, 8, qr.size - 8)).toBe(true);
    }
  });

  it('writes two equal, valid format words for each level', () => {
    for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
      const qr = encodeQr('http://10.0.0.5:61234/?k=deadbeef', { ecc });
      const [first, second] = formatCopies(qr);
      expect(second).toBe(first);
      const word = first ^ 0x5412;
      expect(bchRemainder(word, 0x537, 11)).toBe(0);
      expect(word >>> 13).toBe(ECC_BITS[ecc]);
    }
  });

  it('writes the version 7 information block in both places', () => {
    const qr = encodeQr('a'.repeat(CAPACITY.M[6]!), { ecc: 'M' });
    expect(qr.version).toBe(7);
    let lowerLeft = 0;
    let upperRight = 0;
    for (let i = 0; i < 18; i += 1) {
      const a = qr.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      lowerLeft |= (at(qr, b, a) ? 1 : 0) << i;
      upperRight |= (at(qr, a, b) ? 1 : 0) << i;
    }
    expect(lowerLeft).toBe(0x07c94);
    expect(upperRight).toBe(0x07c94);
  });

  it('places an alignment pattern from version 2 on', () => {
    const qr = encodeQr('a'.repeat(20), { ecc: 'M' });
    expect(qr.version).toBe(2);
    const center = qr.size - 7;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        expect(at(qr, center + dx, center + dy)).toBe(Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  });

  it('is deterministic for the same text', () => {
    const digest = (qr: QrCode): string => createHash('sha256').update(qr.modules.map((row) => row.map((m) => (m ? '1' : '0')).join('')).join('\n')).digest('hex');
    const url = 'http://192.168.1.23:54321/?k=0123abcd';
    expect(digest(encodeQr(url))).toBe(digest(encodeQr(url)));
  });

  it('renders one SVG path with a quiet zone', () => {
    const qr = encodeQr('HELLO');
    const svg = toSvg(qr, { border: 4, scale: 8 });
    const side = (qr.size + 8) * 8;
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${side} ${side}"`);
    expect(svg.match(/<path/g)).toHaveLength(1);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // no external references
  });

  it('rejects an unknown level', () => {
    expect(() => encodeQr('x', { ecc: 'X' as EccLevel })).toThrow(/Unknown ECC level/);
  });
});
