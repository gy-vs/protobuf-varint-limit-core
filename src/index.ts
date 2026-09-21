// ---------------------------------------------------------------------------
// Varint codec (LEB128), parsed incrementally with bigint.
//
// Failure modes are strictly distinguished:
//   - "incomplete": the buffer ends while a continuation bit is still set
//   - "overflow":   more payload bits than the target width allows, or the
//                   last permitted byte still requests another byte
//   - "non-canonical": a valid value encoded with a trailing zero byte
//
// Decoding never advances a reader cursor unless the call succeeds.
// ---------------------------------------------------------------------------

export type VarintWidth = 32 | 64;

const MAX_BYTES: Record<VarintWidth, number> = { 32: 5, 64: 10 };

/** Largest payload (low 7 bits) legal in the final byte of an encoding. */
function maxLastBytePayload(width: VarintWidth): bigint {
  // uint32: final byte carries bits 28..31 (4 bits) -> 0b1111.
  // uint64: final byte carries bit 63 (1 bit)       -> 0b0001.
  return width === 32 ? 0b1111n : 0b0001n;
}

/** Mask keeping exactly `width` bits. */
function widthMask(width: VarintWidth): bigint {
  return width === 32 ? 0xffffffffn : 0xffffffffffffffffn;
}

// ---------------------------------------------------------------------------
// Decode result types
// ---------------------------------------------------------------------------

export interface VarintOk {
  ok: true;
  value: bigint;
  /** Number of bytes consumed. */
  length: number;
  /** True when the encoding was valid but not the shortest one. */
  nonCanonical: boolean;
}

export interface VarintError {
  ok: false;
  reason: 'incomplete' | 'overflow' | 'non-canonical';
  /** Bytes inspected before the failure (0..maxBytes). */
  inspected: number;
}

export type VarintResult = VarintOk | VarintError;

export interface DecodeOptions {
  /** Target bit width; defaults to 64. */
  width?: VarintWidth;
  /**
   * Accept (decode) non-shortest encodings. They still succeed but carry
   * `nonCanonical: true`. When false (the default) such an encoding fails
   * with reason "non-canonical".
   */
  allowNonCanonical?: boolean;
}

/**
 * Incrementally decode a base-128 varint from `data` at `offset` using
 * bigint, with hard per-width byte/bit limits.
 *
 * Pure function: the caller decides what to do with `length`.
 */
export function decodeVarint(
  data: Uint8Array,
  offset = 0,
  options: DecodeOptions = {},
): VarintResult {
  const width = options.width ?? 64;
  const allowNonCanonical = options.allowNonCanonical ?? false;
  const maxBytes = MAX_BYTES[width];
  const lastPayloadMask = maxLastBytePayload(width);

  let value = 0n;
  let shift = 0n;

  for (let i = 0; i < maxBytes; i++) {
    if (offset + i >= data.length) {
      // Ran out of input while still expecting another byte.
      return { ok: false, reason: 'incomplete', inspected: i };
    }

    const byte = data[offset + i];
    const payload = BigInt(byte & 0x7f);

    if (i === maxBytes - 1) {
      // The final permitted byte must fit the width and must terminate.
      if ((payload & ~lastPayloadMask) !== 0n) {
        return { ok: false, reason: 'overflow', inspected: i + 1 };
      }
      if ((byte & 0x80) !== 0) {
        // One more byte would exceed the width — even if the buffer already
        // ends here, the encoding itself is illegal rather than truncated.
        return { ok: false, reason: 'overflow', inspected: i + 1 };
      }
    }

    value |= payload << shift;

    if ((byte & 0x80) === 0) {
      // A zero payload in the terminating byte means the same value had a
      // shorter representation (single-byte 0 itself is fine).
      if (i > 0 && payload === 0n) {
        if (!allowNonCanonical) {
          return { ok: false, reason: 'non-canonical', inspected: i + 1 };
        }
        return {
          ok: true,
          value,
          length: i + 1,
          nonCanonical: true,
        };
      }
      return { ok: true, value, length: i + 1, nonCanonical: false };
    }

    shift += 7n;
  }

  // Unreachable: the final-byte branch handles a set continuation bit,
  // but keep an explicit guard for clarity.
  return { ok: false, reason: 'overflow', inspected: maxBytes };
}

// ---------------------------------------------------------------------------
// Encoder — always emits the shortest canonical representation.
// ---------------------------------------------------------------------------

export interface EncodeOptions {
  /** 32 limits the value to uint32; defaults to 64. */
  width?: VarintWidth;
}

/** Encode a non-negative integer as a shortest-form canonical varint. */
export function encodeVarint(value: bigint | number, options: EncodeOptions = {}): Uint8Array {
  const width = options.width ?? 64;
  let v = typeof value === 'number' ? BigInt(value) : value;

  if (v < 0n) {
    throw new RangeError(`varint: value must be non-negative, got ${value}`);
  }
  const mask = widthMask(width);
  if (v > mask) {
    throw new RangeError(`varint: value ${value} exceeds uint${width}`);
  }

  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
  } while (v !== 0n);

  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Signed (int32 / int64) and zigzag (sint32 / sint64) helpers.
// ---------------------------------------------------------------------------

export type SignedWidth = 32 | 64;

/** Signed two's-complement value -> unsigned bits that occupy the varint. */
export function toUnsigned(value: bigint | number, width: SignedWidth): bigint {
  const v = typeof value === 'number' ? BigInt(value) : value;
  if (width === 32) {
    // On the wire int32 is sign-extended to 64 bits, so a negative value
    // always occupies ten bytes (e.g. -1 -> 0xFFFFFFFFFFFFFFFF).
    return BigInt.asIntN(32, v) & widthMask(64);
  }
  return v & widthMask(64);
}

/** Unsigned varint payload -> signed two's-complement value. */
export function toSigned(unsigned: bigint, width: SignedWidth): bigint {
  const v = unsigned & widthMask(width);
  if (width === 32) {
    return v >= 0x80000000n ? v - 0x100000000n : v;
  }
  return v >= 0x8000000000000000n ? v - 0x10000000000000000n : v;
}

export function zigzagEncode(value: bigint | number, width: SignedWidth): bigint {
  const v = typeof value === 'number' ? BigInt(value) : value;
  // (n << 1) ^ (n >> (width - 1)); arithmetic shift replicates the sign bit
  // in bigint, which is exactly what we want.
  return ((v << 1n) ^ (v >> BigInt(width - 1))) & widthMask(width);
}

export function zigzagDecode(unsigned: bigint, width: SignedWidth): bigint {
  const u = unsigned & widthMask(width);
  return (u >> 1n) ^ -(u & 1n);
}

/** Encode a signed int32/int64 value (10 bytes for negatives under int32). */
export function encodeSignedVarint(value: bigint | number, width: SignedWidth): Uint8Array {
  return encodeVarint(toUnsigned(value, width), { width: 64 });
}

/** Encode a sint32/sint64 value in zigzag varint form. */
export function encodeZigzagVarint(value: bigint | number, width: SignedWidth): Uint8Array {
  const u = zigzagEncode(value, width);
  return encodeVarint(u, { width: width === 32 ? 32 : 64 });
}

// ---------------------------------------------------------------------------
// Cursor-based reader: failed decodes do not move the position.
// ---------------------------------------------------------------------------

export class VarintReader {
  offset = 0;

  constructor(readonly data: Uint8Array, offset = 0) {
    this.offset = offset;
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  /** Decode at the current position; commit `length` only on success. */
  read(options: DecodeOptions = {}): VarintResult {
    const result = decodeVarint(this.data, this.offset, options);
    if (result.ok) this.offset += result.length;
    return result;
  }

  /** Read a signed int32/int64; on success returns the signed value. */
  readSigned(width: SignedWidth, options: DecodeOptions = {}): VarintResult {
    const result = decodeVarint(this.data, this.offset, { ...options, width: 64 });
    if (!result.ok) return result;
    this.offset += result.length;
    return { ...result, value: toSigned(result.value, width) };
  }

  /** Read a zigzag-encoded sint32/sint64. */
  readZigzag(width: SignedWidth, options: DecodeOptions = {}): VarintResult {
    const result = decodeVarint(this.data, this.offset, {
      ...options,
      width: width === 32 ? 32 : 64,
    });
    if (!result.ok) return result;
    this.offset += result.length;
    return { ...result, value: zigzagDecode(result.value, width) };
  }

  /**
   * Skip a varint. Non-canonical encodings must be opted into just like
   * `read`; the cursor moves only when the encoding is accepted.
   */
  skip(options: DecodeOptions = {}): VarintResult {
    return this.read(options);
  }
}

// ---------------------------------------------------------------------------
// Minimal wire-model kept from the original public surface.
// ---------------------------------------------------------------------------

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
