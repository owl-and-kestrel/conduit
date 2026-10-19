// Tiny Arena — QR code encoder, written from scratch against ISO/IEC 18004.
// Byte mode (UTF-8), versions 1..10, all four ECC levels and all 8 masks.
// No dependencies and no vendored code; the tables below are the standard's
// own, small enough to audit by eye. The steps (zigzag placement, format-bit
// layout, BCH remainders) are the textbook ones that every implementation
// shares, for example Project Nayuki's MIT-licensed QR Code generator.
// Checked during authoring by decoding 40 codes (versions 1-10 x L/M/Q/H, each
// filled to capacity) with an independent reader (Apple Core Image), 40/40.
//
//   encodeQr(text, { ecc = 'M' }) -> { version, size, modules }
//   toSvg(qr, { border = 4, scale = 8 }) -> string
//
// Covered from the standard: finder patterns + separators, timing, alignment
// patterns (clause 7); dark module, format info (BCH 15,5), version info
// (BCH 18,6) (7.8/7.9); byte-mode segmentation and 0xEC/0x11 padding (8.4);
// Reed-Solomon over GF(256), primitive polynomial 0x11D (Annex C..E); the
// standard block counts and interleaving (Table E.1); all 8 masks (8.8).

export const MAX_VERSION = 10;

// Error-correction level -> format-info code (ISO Table 25).
const ECL_CODES = { L: 1, M: 0, Q: 3, H: 2 };
const ECL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };

// Total codewords (data + ECC) per version, from the module counts of
// clause 7; equal to the published totals 26, 44, 70, 100, 134, 172, 196,
// 242, 292, 346.
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

// ISO/IEC 18004:2006 Table E.1: Reed-Solomon codewords per block, versions
// 1..10 (rows are levels L, M, Q, H).
const ECC_CODEWORDS_PER_BLOCK = [
  [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  [17, 28, 22, 16, 22, 28, 26, 26, 24, 28]
];

// ISO/IEC 18004:2006 Table E.1: number of blocks, same layout.
const NUM_ERROR_CORRECTION_BLOCKS = [
  [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  [1, 1, 2, 4, 4, 4, 5, 6, 8, 8]
];

// GF(256), primitive polynomial x^8+x^4+x^3+x^2+1 = 0x11D (ISO Annex C).
const EXP = new Array(512);
const LOG = new Array(256);
(function buildGf() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

export function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

// Monic generator polynomial with roots a^0 .. a^(degree-1) (ISO Annex D).
// Exported for tests.
export function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

// `degree` Reed-Solomon check codewords for data codewords (synthetic
// division by the generator polynomial). Exported for tests.
export function rsCheck(data, degree) {
  const gen = rsGenerator(degree);
  const remainder = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let i = 0; i < degree; i += 1) {
        remainder[i] ^= gfMul(gen[i + 1], factor); // gen[0] is the implicit 1
      }
    }
  }
  return remainder;
}

function dataCodewords(version, eclIndex) {
  return TOTAL_CODEWORDS[version]
    - NUM_ERROR_CORRECTION_BLOCKS[eclIndex][version - 1] * ECC_CODEWORDS_PER_BLOCK[eclIndex][version - 1];
}

// Byte-mode header is 4 mode bits + counter (8 bits for versions 1..9, 16
// after) + a terminator that must fit inside the last partial codeword.
function fits(version, eclIndex, byteCount) {
  const counterBits = version <= 9 ? 8 : 16;
  const codewordsNeeded = Math.ceil((4 + counterBits + byteCount * 8) / 8);
  return codewordsNeeded <= dataCodewords(version, eclIndex);
}

export function encodeQr(text, { ecc = 'M' } = {}) {
  if (!(ecc in ECL_CODES)) {
    throw new Error(`Unknown ECC level: ${ecc}`);
  }
  const eclIndex = ECL_INDEX[ecc];
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let candidate = 1; candidate <= MAX_VERSION; candidate += 1) {
    if (fits(candidate, eclIndex, bytes.length)) {
      version = candidate;
      break;
    }
  }
  if (version === 0) {
    throw new Error(`Payload of ${bytes.length} bytes does not fit in a version 10 QR code at ECC ${ecc}.`);
  }
  const size = version * 4 + 17;

  // -- data codewords: mode + counter + UTF-8 bytes, terminator + pads -----
  const counterBits = version <= 9 ? 8 : 16;
  const totalBits = 4 + counterBits + bytes.length * 8;
  const dataTotal = dataCodewords(version, eclIndex);
  const codewords = [];
  const push = (value, bitCount) => {
    for (let shift = bitCount - 1; shift >= 0; shift -= 1) {
      codewords.push((value >>> shift) & 1);
    }
  };
  push(0b0100, 4); // byte mode (ISO 8.4.6)
  push(bytes.length, counterBits);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, dataTotal * 8 - totalBits)); // terminator, up to 4 bits
  while (codewords.length < dataTotal * 8) push(0, 1); // zero-fill to the edge
  // Pad codewords alternate 0xEC / 0x11 (ISO 8.4.9); a partially filled codeword
  // after the data keeps its zero padding.
  const firstPadCodeword = Math.ceil(totalBits / 8);
  for (let cw = firstPadCodeword; cw < dataTotal; cw += 1) {
    const value = (cw - firstPadCodeword) % 2 === 0 ? 0xec : 0x11;
    for (let j = 0; j < 8; j += 1) codewords[cw * 8 + j] = (value >>> (7 - j)) & 1;
  }
  const dataCodewordArray = [];
  for (let i = 0; i < codewords.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | codewords[i + j];
    dataCodewordArray.push(value);
  }

  // -- per-block ECC and interleaving (ISO 8.5) -----------------------------
  const eccPerBlock = ECC_CODEWORDS_PER_BLOCK[eclIndex][version - 1];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[eclIndex][version - 1];
  // Shorter blocks come FIRST (ISO Table E.1 layout, zxing convention).
  const shortLen = Math.floor(dataTotal / numBlocks);
  const numShort = numBlocks - (dataTotal % numBlocks);
  const blockData = [];
  const blockEcc = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i += 1) {
    const len = shortLen + (i < numShort ? 0 : 1);
    const slice = dataCodewordArray.slice(offset, offset + len);
    offset += len;
    blockData.push(slice);
    blockEcc.push(rsCheck(slice, eccPerBlock));
  }
  const stream = [];
  for (let j = 0; j < shortLen + 1; j += 1) {
    for (let i = 0; i < numBlocks; i += 1) {
      if (j < blockData[i].length) stream.push(blockData[i][j]);
    }
  }
  for (let j = 0; j < eccPerBlock; j += 1) {
    for (let i = 0; i < numBlocks; i += 1) stream.push(blockEcc[i][j]);
  }
  // Flatten to bits, MSB first per codeword, for the placement step.
  const bits = [];
  for (const value of stream) {
    for (let j = 7; j >= 0; j -= 1) bits.push((value >>> j) & 1);
  }

  return buildModules(version, size, bits, ECL_CODES[ecc]);
}

// -- function patterns, placement, masking, penalty ------------------------

function buildModules(version, size, bits, eclCode) {
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  // Finder patterns + separators: dark at Chebyshev distance 0,1,3 of each of
  // the three 7x7 corners, light at 2 (ring) and 4 (separator) (ISO 7.3.2/3).
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  // Timing patterns on row 6 and column 6, between the finders (7.3.4).
  for (let i = 8; i <= size - 9; i += 1) {
    const dark = i % 2 === 0;
    if (!reserved[6][i]) set(i, 6, dark);
    if (!reserved[i][6]) set(6, i, dark);
  }

  // Alignment patterns for version >= 2 (7.3.5). Centers: 6, then evenly
  // spaced down to size - 7; the three overlaps with finders are skipped.
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    const step = (size - 13) / (numAlign - 1);
    const centers = [6];
    for (let pos = size - 7; centers.length < numAlign; pos -= step) {
      const rounded = Math.floor(pos);
      if (!centers.includes(rounded)) centers.push(rounded);
    }
    for (const cy of centers) {
      for (const cx of centers) {
        const nearFinder = (cx === 6 && cy === 6)
          || (cx === 6 && cy === size - 7)
          || (cx === size - 7 && cy === 6);
        if (nearFinder) continue;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            set(cx + dx, cy + dy, dist !== 1); // dark core, light ring, dark rim
          }
        }
      }
    }
  }

  // Format info (ISO 7.8): 15 BCH bits (generator 0x537) XOR 0x5412, drawn in
  // two copies with mask 0 first and rewritten for the chosen mask later.
  writeFormat(modules, size, eclCode, 0, reserved);

  // Version information (BCH 18,6) for version >= 7 (ISO 7.9).
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits18 = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const bit = ((bits18 >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit); // block next to the bottom-left finder
      set(b, a, bit); // block next to the top-right finder
    }
  }

  // Place data with each of the 8 masks (ISO 8.8), keep the lowest penalty.
  // Mask formulas below apply to module coordinates (x, y).
  const maskFormulas = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
    (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0
  ];
  let best = null;
  let bestPenalty = Infinity;
  let bitIndex = 0;
  const takeBit = () => {
    const bit = bitIndex < bits.length ? bits[bitIndex] : 0;
    bitIndex += 1;
    return bit === 1;
  };

  for (let maskId = 0; maskId < 8; maskId += 1) {
    const candidate = modules.map((row) => row.slice());
    bitIndex = 0;
    // Zigzag: module pairs right-to-left, alternating up-and-down columns.
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // keep column 6 (timing) free of data
      const upward = ((right + 1) & 2) === 0;
      for (let vert = 0; vert < size; vert += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const y = upward ? size - 1 - vert : vert;
          if (reserved[y][x]) continue;
          let bit = takeBit();
          if (maskFormulas[maskId](x, y)) bit = !bit; // mask flips data modules
          candidate[y][x] = bit;
        }
      }
    }
    writeFormat(candidate, size, eclCode, maskId, null);
    const penalty = computePenalty(candidate, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = candidate;
    }
  }
  return { version, size, modules: best };
}

// -- format info -----------------------------------------------------------

// 15 format bits for an ECL code and mask id (ISO 7.8): level + mask, extended
// with 10 BCH bits from generator 0x537, then XOR 0x5412.
function formatBits15(eclCode, maskId) {
  const data = (eclCode << 3) | maskId;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

// Format cell layout (ISO 7.8.2): both copies plus the dark module.
function writeFormat(grid, size, eclCode, maskId, reserved) {
  const bits15 = formatBits15(eclCode, maskId);
  const bitAt = (i) => ((bits15 >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) mark(grid, reserved, 8, i, bitAt(i));
  mark(grid, reserved, 8, 7, bitAt(6));
  mark(grid, reserved, 8, 8, bitAt(7));
  mark(grid, reserved, 7, 8, bitAt(8));
  for (let i = 9; i < 15; i += 1) mark(grid, reserved, 14 - i, 8, bitAt(i));
  for (let i = 0; i < 8; i += 1) mark(grid, reserved, size - 1 - i, 8, bitAt(i));
  for (let i = 8; i < 15; i += 1) mark(grid, reserved, 8, size - 15 + i, bitAt(i));
  mark(grid, reserved, 8, size - 8, true); // dark module (ISO 7.3.7)
}

function mark(grid, reserved, x, y, dark) {
  grid[y][x] = dark;
  if (reserved) reserved[y][x] = true;
}

// -- penalty (ISO 8.8.2) ---------------------------------------------------

function computePenalty(modules, size) {
  let penalty = 0;
  // Rule 1: every run of >= 5 same-colored modules in a row or column counts
  // 3 + (run - 5).
  for (const row of modules) penalty += runPenalty(row);
  for (let x = 0; x < size; x += 1) {
    const column = [];
    for (let y = 0; y < size; y += 1) column.push(modules[y][x]);
    penalty += runPenalty(column);
  }
  // Rule 2: every 2x2 block of one color costs 3.
  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      const value = modules[y][x];
      if (value === modules[y][x + 1] && value === modules[y + 1][x] && value === modules[y + 1][x + 1]) {
        penalty += 3;
      }
    }
  }
  // Rule 3: the finder-like sequence 1011101 with 4 light modules on a side
  // costs 40 per occurrence, in rows and columns.
  const patternBefore = '00001011101';
  const patternAfter = '10111010000';
  for (let y = 0; y < size; y += 1) {
    const row = toBitString(modules[y]);
    penalty += 40 * (countSubstring(row, patternBefore) + countSubstring(row, patternAfter));
  }
  for (let x = 0; x < size; x += 1) {
    let column = '';
    for (let y = 0; y < size; y += 1) column += modules[y][x] ? '1' : '0';
    penalty += 40 * (countSubstring(column, patternBefore) + countSubstring(column, patternAfter));
  }
  // Rule 4: dark fraction far from 50%, in steps of 5%, costs 10 per step.
  let dark = 0;
  for (const row of modules) {
    for (const module of row) {
      if (module) dark += 1;
    }
  }
  const total = size * size;
  penalty += 10 * Math.floor(Math.abs(dark * 20 - total * 10) / total);
  return penalty;
}

function runPenalty(cells) {
  let penalty = 0;
  let run = 1;
  for (let i = 1; i < cells.length; i += 1) {
    if (cells[i] === cells[i - 1]) {
      run += 1;
    } else {
      if (run >= 5) penalty += 3 + run - 5;
      run = 1;
    }
  }
  if (run >= 5) penalty += 3 + run - 5;
  return penalty;
}

function toBitString(cells) {
  let out = '';
  for (const cell of cells) out += cell ? '1' : '0';
  return out;
}

function countSubstring(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    count += 1;
    at = haystack.indexOf(needle, at + 1);
  }
  return count;
}

// -- SVG output ------------------------------------------------------------

// One path of dark squares on a white background; crispEdges keeps squares
// square at any zoom.
export function toSvg(qr, { border = 4, scale = 8 } = {}) {
  const dimension = (qr.size + border * 2) * scale;
  const rects = [];
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (qr.modules[y][x]) {
        const left = (x + border) * scale;
        const top = (y + border) * scale;
        rects.push(`M${left} ${top}h${scale}v${scale}h${-scale}z`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}"`
    + ` viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges">`
    + `<rect width="${dimension}" height="${dimension}" fill="#ffffff"/>`
    + `<path d="${rects.join('')}" fill="#000000"/></svg>`;
}

