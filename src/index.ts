/**
 * Protobuf base-128 varint codec.
 *
 * All arithmetic is done with bigint, so values above 2^31 are never
 * truncated by JavaScript's 32-bit bitwise operators.
 */

export type VarintKind =
  | 'uint32'
  | 'uint64'
  | 'int32'
  | 'int64'
  | 'sint32'
  | 'sint64';

export type VarintErrorCode = 'incomplete' | 'overflow' | 'non-canonical';

export interface VarintOk {
  ok: true;
  value: bigint;
  /** Bytes consumed; only meaningful (and only committed) on success. */
  length: number;
  /** False when the encoding was accepted but is not shortest-form. */
  canonical: boolean;
}

export interface VarintError {
  ok: false;
  code: VarintErrorCode;
}

export type VarintResult = VarintOk | VarintError;

export interface DecodeOptions {
  /** Target width, controls max bytes and valid bits in the last byte. */
  kind?: VarintKind;
  /** Accept (but flag via `canonical: false`) non-shortest encodings. */
  allowNonCanonical?: boolean;
}

interface Width {
  /** Maximum legal number of bytes for this width. */
  maxBytes: number;
  /** Maximum legal 7-bit payload of the terminal byte. */
  maxLast: bigint;
}

const U32_MAX = 0xffffffffn;
const U64_MAX = 0xffffffffffffffffn;
/** Smallest sign-extended negative int32 on the 64-bit wire: -2^31. */
const I32_SIGN_BASE = 0xffffffff80000000n;
const I64_SIGN_BIT = 0x8000000000000000n;

const WIDTHS: Record<VarintKind, Width> = {
  // uint32 / sint32: 5 bytes, last payload holds at most 4 bits.
  uint32: { maxBytes: 5, maxLast: 0x0fn },
  sint32: { maxBytes: 5, maxLast: 0x0fn },
  // 64-bit widths: 10 bytes, last payload holds at most 1 bit.
  uint64: { maxBytes: 10, maxLast: 0x01n },
  int64: { maxBytes: 10, maxLast: 0x01n },
  sint64: { maxBytes: 10, maxLast: 0x01n },
  // Negative int32 is sign-extended to 64 bits on the wire: 10 bytes.
  int32: { maxBytes: 10, maxLast: 0x01n },
};

/**
 * Incrementally parses one varint without mutating any cursor.
 *
 * Failure modes are strictly distinguished:
 *  - 'incomplete'     input ends while a continuation bit is still set
 *  - 'overflow'       byte count or terminal-byte payload exceeds `kind`
 *  - 'non-canonical'  structurally valid value in a non-shortest encoding
 */
export function decodeVarint(
  data: Uint8Array,
  offset = 0,
  options: DecodeOptions = {},
): VarintResult {
  const kind = options.kind ?? 'uint64';
  const allowNonCanonical = options.allowNonCanonical ?? false;
  const { maxBytes, maxLast } = WIDTHS[kind];

  if (!Number.isInteger(offset) || offset < 0 || offset > data.length) {
    return { ok: false, code: 'incomplete' };
  }

  let raw = 0n;
  let length = 0;

  for (let i = 0; ; i++) {
    // Buffer ends before the terminal byte was seen. Checked before the
    // byte-count limit so truncation at every position reports incomplete,
    // including a final continuation bit at the width's max byte.
    if (offset + i >= data.length) return { ok: false, code: 'incomplete' };

    // An 11th byte (6th for 32-bit widths) can never be part of a valid
    // value, even if its own payload would fit.
    if (i >= maxBytes) return { ok: false, code: 'overflow' };

    const byte = data[offset + i];
    raw |= BigInt(byte & 0x7f) << (7n * BigInt(i));

    if ((byte & 0x80) === 0) {
      length = i + 1;
      // Only the byte at the width limit is constrained to the residual
      // high bits (1 for 64-bit widths, 4 for 32-bit). A varint that ends
      // early may fill all 7 payload bits of its terminal byte.
      if (length === maxBytes && BigInt(byte & 0x7f) > maxLast) {
        return { ok: false, code: 'overflow' };
      }
      break;
    }
  }

  // A zero payload in the terminal byte means that group could be removed.
  let canonical = true;
  if (length > 1 && (data[offset + length - 1] & 0x7f) === 0) {
    canonical = false;
  }

  let value = raw;

  if (kind === 'int32') {
    // Canonical int32 wire form is either:
    //  - a non-negative low-32 value in at most 5 bytes, or
    //  - a negative value fully sign-extended (raw >= 2^64 - 2^31),
    //    which necessarily occupies 10 bytes.
    // Shortened negatives (e.g. 0xffffffff in 5 bytes) and padded
    // positives are both non-canonical.
    const lo = raw & U32_MAX;
    const negative = lo >= 0x80000000n;
    if (negative ? raw < I32_SIGN_BASE : length > 5) canonical = false;
    value = BigInt(Number(lo) | 0);
  } else if (kind === 'int64') {
    if (raw >= I64_SIGN_BIT) value = raw - U64_MAX - 1n;
  } else if (kind === 'sint32' || kind === 'sint64') {
    const zigzag = (raw >> 1n) ^ -(raw & 1n);
    if (kind === 'sint32') {
      value = BigInt(Number(zigzag & U32_MAX) | 0);
    } else {
      value = zigzag;
    }
  }

  if (!canonical && !allowNonCanonical) {
    return { ok: false, code: 'non-canonical' };
  }

  return { ok: true, value, length, canonical };
}

/** Cursor over a byte buffer; the position is committed only on success. */
export class VarintCursor {
  offset: number;
  constructor(
    readonly data: Uint8Array,
    offset = 0,
  ) {
    this.offset = offset;
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  read(options: DecodeOptions = {}): VarintResult {
    const result = decodeVarint(this.data, this.offset, options);
    if (result.ok) this.offset += result.length;
    return result;
  }
}

function toBigInt(value: number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  throw new RangeError(`varint value must be a safe integer or bigint: ${value}`);
}

function checkRange(value: bigint, min: bigint, max: bigint, kind: VarintKind): void {
  if (value < min || value > max) {
    throw new RangeError(`${kind} value out of range: ${value}`);
  }
}

/** Encodes the value as its shortest canonical varint for the target width. */
export function encodeVarint(value: number | bigint, kind: VarintKind = 'uint64'): Uint8Array {
  let v = toBigInt(value);
  let unsigned: bigint;

  switch (kind) {
    case 'uint32':
      checkRange(v, 0n, U32_MAX, kind);
      unsigned = v;
      break;
    case 'uint64':
      checkRange(v, 0n, U64_MAX, kind);
      unsigned = v;
      break;
    case 'int32':
      checkRange(v, -0x80000000n, 0x7fffffffn, kind);
      // Negative int32 is sign-extended to a full 64-bit varint.
      unsigned = v < 0n ? v + U64_MAX + 1n : v;
      break;
    case 'int64':
      checkRange(v, -0x8000000000000000n, 0x7fffffffffffffffn, kind);
      unsigned = v < 0n ? v + U64_MAX + 1n : v;
      break;
    case 'sint32':
      checkRange(v, -0x80000000n, 0x7fffffffn, kind);
      unsigned = v < 0n ? -v * 2n - 1n : v * 2n;
      break;
    case 'sint64':
      checkRange(v, -0x8000000000000000n, 0x7fffffffffffffffn, kind);
      unsigned = v < 0n ? -v * 2n - 1n : v * 2n;
      break;
  }

  const out: number[] = [];
  while (unsigned > 0n) {
    const payload = Number(unsigned & 0x7fn);
    unsigned >>= 7n;
    out.push(unsigned > 0n ? payload | 0x80 : payload);
  }
  if (out.length === 0) out.push(0);
  return Uint8Array.from(out);
}

export type Field = { number: number; wireType: number; raw: Uint8Array };
export class DynamicMessage {
  fields: Field[] = [];
  add(field: Field) {
    this.fields.push(field);
  }
  unknown() {
    return this.fields.slice();
  }
}
