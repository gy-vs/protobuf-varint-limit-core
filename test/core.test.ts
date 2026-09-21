import { describe, expect, it } from 'vitest';
import {
  decodeVarint,
  encodeSignedVarint,
  encodeVarint,
  encodeZigzagVarint,
  VarintReader,
  zigzagDecode,
  zigzagEncode,
  toSigned,
  toUnsigned,
} from '../src/index.js';

const U32_MAX = 0xffffffffn;
const U64_MAX = 0xffffffffffffffffn;

/** Bytes of the canonical 10-byte encoding of uint64 max (all bytes 0xff..0xff, 0x01). */
const U64_MAX_BYTES = [
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
];
/** uint32 max = ff ff ff ff 0f. */
const U32_MAX_BYTES = [0xff, 0xff, 0xff, 0xff, 0x0f];
/** Negative int32 (-1) sign-extended: nine 0xff bytes then 0x01. */
const INT32_NEG_BYTES = [...Array(9).fill(0xff), 0x01];

describe('decodeVarint basics', () => {
  it('decodes the existing 300 example', () => {
    const r = decodeVarint(Uint8Array.from([172, 2]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(300n);
      expect(r.length).toBe(2);
      expect(r.nonCanonical).toBe(false);
    }
  });

  it('decodes zero from a single byte', () => {
    const r = decodeVarint(Uint8Array.from([0x00]));
    expect(r).toMatchObject({ ok: true, value: 0n, length: 1, nonCanonical: false });
  });

  it('leaves trailing bytes untouched via length', () => {
    const r = decodeVarint(Uint8Array.from([0x01, 0x02, 0x03]), 1);
    expect(r).toMatchObject({ ok: true, value: 2n, length: 1 });
  });

  it('decodes max uint32', () => {
    const r = decodeVarint(Uint8Array.from(U32_MAX_BYTES), 0, { width: 32 });
    expect(r).toMatchObject({ ok: true, value: U32_MAX, length: 5 });
  });

  it('decodes max uint64', () => {
    const r = decodeVarint(Uint8Array.from(U64_MAX_BYTES));
    expect(r).toMatchObject({ ok: true, value: U64_MAX, length: 10 });
  });

  it('accepts uint32 max encoding under width 64', () => {
    const r = decodeVarint(Uint8Array.from(U32_MAX_BYTES));
    expect(r).toMatchObject({ ok: true, value: U32_MAX });
  });
});

describe('negative int32: ten-byte sign-extended form', () => {
  it('encodes -1 as ten 0xff bytes', () => {
    expect(Array.from(encodeSignedVarint(-1, 32))).toEqual(INT32_NEG_BYTES);
  });

  it('decodes the ten-byte form back to -1', () => {
    const r = decodeVarint(Uint8Array.from(INT32_NEG_BYTES));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.length).toBe(10);
      expect(toSigned(r.value, 32)).toBe(-1n);
    }
  });

  it('encodes other negative int32 values sign-extended to ten bytes', () => {
    // -12345 -> two's complement u32 = 4294954951, wire bits extend to u64 max - 12344
    expect(toUnsigned(-12345, 32)).toBe(U64_MAX - 12345n + 1n);
    const bytes = encodeSignedVarint(-12345, 32);
    expect(bytes).toHaveLength(10);
    const r = decodeVarint(bytes);
    expect(r.ok).toBe(true);
    if (r.ok) expect(toSigned(r.value, 32)).toBe(-12345n);
  });
});

describe('zigzag', () => {
  const cases32: Array<[number, bigint]> = [
    [0, 0n],
    [-1, 1n],
    [1, 2n],
    [-2, 3n],
    [2, 4n],
    [2147483647, 4294967294n],
    [-2147483648, 4294967295n],
  ];
  const cases64: Array<[bigint, bigint]> = [
    [0n, 0n],
    [-1n, 1n],
    [1n, 2n],
    [9223372036854775807n, U64_MAX - 1n],
    [-9223372036854775808n, U64_MAX],
  ];

  it.each(cases32)('zigzag32 %d <-> %d', (signed, unsigned) => {
    expect(zigzagEncode(signed, 32)).toBe(unsigned);
    expect(zigzagDecode(unsigned, 32)).toBe(BigInt(signed));
    const bytes = encodeZigzagVarint(signed, 32);
    // Shortest form: zigzag of -2^31 fits 5 bytes.
    expect(decodeVarint(bytes, 0, { width: 32 })).toMatchObject({
      ok: true,
      value: unsigned,
    });
  });

  it.each(cases64)('zigzag64 %d <-> %d', (signed, unsigned) => {
    expect(zigzagEncode(signed, 64)).toBe(unsigned);
    expect(zigzagDecode(unsigned, 64)).toBe(signed);
    const bytes = encodeZigzagVarint(signed, 64);
    const r = decodeVarint(bytes);
    expect(r.ok).toBe(true);
    if (r.ok) expect(zigzagDecode(r.value, 64)).toBe(signed);
  });

  it('zigzag of -1 is a single byte', () => {
    expect(Array.from(encodeZigzagVarint(-1, 64))).toEqual([0x01]);
  });
});

describe('eleven-byte and last-byte overflow', () => {
  it('rejects an 11th terminating byte (all 0xff, 0xff, 0x01) as overflow', () => {
    const data = Uint8Array.from([...U64_MAX_BYTES.slice(0, 9), 0xff, 0x01]);
    const r = decodeVarint(data);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('overflow');
      expect(r.inspected).toBe(10);
    }
  });

  it('rejects 11 bytes where byte 10 is within payload but continues', () => {
    const data = Uint8Array.from([...Array(9).fill(0xff), 0x80, 0x01]);
    const r = decodeVarint(data);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('overflow');
  });

  it('rejects last-byte payload overflow for uint64 (byte10 = 0x02)', () => {
    // 2 in the last byte means bit 65 set -> overflow.
    const data = Uint8Array.from([...Array(9).fill(0xff), 0x02]);
    const r = decodeVarint(data);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('overflow');
      expect(r.inspected).toBe(10);
    }
  });

  it('rejects last-byte payload with high junk bits for uint64 (0x7f)', () => {
    const data = Uint8Array.from([...Array(9).fill(0xff), 0x7f]);
    const r = decodeVarint(data);
    expect(r).toMatchObject({ ok: false, reason: 'overflow' });
  });

  it('rejects last-byte overflow for uint32 (byte5 = 0x10)', () => {
    const data = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x10]);
    const r = decodeVarint(data, 0, { width: 32 });
    expect(r).toMatchObject({ ok: false, reason: 'overflow', inspected: 5 });
  });

  it('rejects five bytes continuing into a sixth for uint32', () => {
    const data = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x8f, 0x01]);
    const r = decodeVarint(data, 0, { width: 32 });
    expect(r).toMatchObject({ ok: false, reason: 'overflow', inspected: 5 });
  });

  it('distinguishes overflow from truncation at the width boundary', () => {
    // Exactly 10 bytes, all with continuation bits: the encoding claims an
    // 11th byte exists, which can never fit uint64 -> overflow, not incomplete.
    const data = Uint8Array.from(Array(10).fill(0xff));
    const r = decodeVarint(data);
    expect(r).toMatchObject({ ok: false, reason: 'overflow' });
  });
});

describe('truncation at every position', () => {
  // Prefixes of a well-formed multi-byte varint, all with the final byte
  // removed and every retained byte still showing continuation.
  const full = Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x01]);

  for (let n = 1; n < full.length; n++) {
    it(`reports incomplete after ${n} continuation byte(s) (uint32 encoding)`, () => {
      const prefix = full.slice(0, n);
      const r = decodeVarint(prefix, 0, { width: 32 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('incomplete');
        expect(r.inspected).toBe(n);
      }
    });
  }

  it('reports incomplete on an empty tail', () => {
    const r = decodeVarint(Uint8Array.of(0x80));
    expect(r).toMatchObject({ ok: false, reason: 'incomplete', inspected: 1 });
  });

  it('reports incomplete at offset past end', () => {
    const r = decodeVarint(Uint8Array.of(0x01), 5);
    expect(r).toMatchObject({ ok: false, reason: 'incomplete', inspected: 0 });
  });

  const full64 = Uint8Array.from(U64_MAX_BYTES);
  for (let n = 1; n <= 9; n++) {
    it(`reports incomplete for ${n}-byte prefix of max uint64`, () => {
      const r = decodeVarint(full64.slice(0, n));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('incomplete');
        expect(r.inspected).toBe(n);
      }
    });
  }

  it('ten continuation bytes are overflow, not incomplete', () => {
    const r = decodeVarint(Uint8Array.from(Array(10).fill(0x80)));
    expect(r).toMatchObject({ ok: false, reason: 'overflow', inspected: 10 });
  });
});

describe('non-canonical encodings', () => {
  it('rejects 0x80 0x00 (two-byte zero) by default', () => {
    const r = decodeVarint(Uint8Array.of(0x80, 0x00));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('non-canonical');
      expect(r.inspected).toBe(2);
    }
  });

  it('accepts but flags 0x80 0x00 when allowNonCanonical is set', () => {
    const r = decodeVarint(Uint8Array.of(0x80, 0x00), 0, { allowNonCanonical: true });
    expect(r).toMatchObject({
      ok: true,
      value: 0n,
      length: 2,
      nonCanonical: true,
    });
  });

  it('flags a longer redundant zero (80 80 00)', () => {
    const strict = decodeVarint(Uint8Array.of(0x80, 0x80, 0x00));
    expect(strict).toMatchObject({ ok: false, reason: 'non-canonical' });
    const loose = decodeVarint(Uint8Array.of(0x80, 0x80, 0x00), 0, {
      allowNonCanonical: true,
    });
    expect(loose).toMatchObject({ ok: true, value: 0n, nonCanonical: true, length: 3 });
  });

  it('flags redundant trailing zero on a non-zero value (01 -> 81 00)', () => {
    // 300 = ac 02 canonically; 300 as ac 80 00? build value with trailing zero group
    // Easier: value 1 padded: 0x81 0x00.
    const strict = decodeVarint(Uint8Array.of(0x81, 0x00));
    expect(strict).toMatchObject({ ok: false, reason: 'non-canonical' });
    const loose = decodeVarint(Uint8Array.of(0x81, 0x00), 0, {
      allowNonCanonical: true,
    });
    expect(loose).toMatchObject({ ok: true, value: 1n, nonCanonical: true });
  });

  it('still rejects incomplete input even in lenient mode', () => {
    const r = decodeVarint(Uint8Array.of(0x80, 0x80), 0, { allowNonCanonical: true });
    expect(r).toMatchObject({ ok: false, reason: 'incomplete' });
  });

  it('still rejects overflow even in lenient mode', () => {
    const data = Uint8Array.from([...Array(9).fill(0xff), 0x02]);
    const r = decodeVarint(data, 0, { allowNonCanonical: true });
    expect(r).toMatchObject({ ok: false, reason: 'overflow' });
  });
});

describe('encoder always emits shortest canonical form', () => {
  it('round-trips boundary values', () => {
    const values = [0n, 1n, 127n, 128n, U32_MAX, U64_MAX, U64_MAX - 1n];
    for (const v of values) {
      const bytes = encodeVarint(v);
      // Re-decoding under strict canonical rules must succeed.
      const r = decodeVarint(bytes);
      expect(r.ok, `canonical decode failed for ${v}`).toBe(true);
      if (r.ok) {
        expect(r.value).toBe(v);
        expect(r.nonCanonical).toBe(false);
        expect(r.length).toBe(bytes.length);
      }
    }
  });

  it('encodes zero as exactly one byte', () => {
    expect(Array.from(encodeVarint(0n))).toEqual([0x00]);
    expect(Array.from(encodeVarint(0))).toEqual([0x00]);
  });

  it('encodes max uint32 in five bytes and max uint64 in ten', () => {
    expect(Array.from(encodeVarint(U32_MAX, { width: 32 }))).toEqual(U32_MAX_BYTES);
    expect(Array.from(encodeVarint(U64_MAX))).toEqual(U64_MAX_BYTES);
  });

  it('rejects negative or out-of-range values', () => {
    expect(() => encodeVarint(-1n)).toThrow(RangeError);
    expect(() => encodeVarint(U64_MAX + 1n)).toThrow(RangeError);
    expect(() => encodeVarint(U32_MAX + 1n, { width: 32 })).toThrow(RangeError);
  });

  it('emitted encoding is strictly shorter than any padded variant', () => {
    const bytes = encodeVarint(300n);
    expect(Array.from(bytes)).toEqual([0xac, 0x02]);
    expect(bytes.length).toBe(2);
  });
});

describe('VarintReader cursor semantics', () => {
  it('commits consumed length only on success', () => {
    const reader = new VarintReader(Uint8Array.of(0xac, 0x02, 0x01));
    const first = reader.read();
    expect(first).toMatchObject({ ok: true, value: 300n });
    expect(reader.offset).toBe(2);
    const second = reader.read();
    expect(second).toMatchObject({ ok: true, value: 1n });
    expect(reader.offset).toBe(3);
  });

  it('does not move the cursor on incomplete input', () => {
    const reader = new VarintReader(Uint8Array.of(0x80, 0x80));
    const result = reader.read();
    expect(result).toMatchObject({ ok: false, reason: 'incomplete' });
    expect(reader.offset).toBe(0);
    // A second attempt starts at the same place.
    expect(reader.read()).toMatchObject({ ok: false, reason: 'incomplete' });
    expect(reader.offset).toBe(0);
  });

  it('does not move the cursor on overflow', () => {
    const reader = new VarintReader(
      Uint8Array.from([...Array(9).fill(0xff), 0x02, 0x55]),
    );
    expect(reader.read()).toMatchObject({ ok: false, reason: 'overflow' });
    expect(reader.offset).toBe(0);
  });

  it('does not move the cursor on rejected non-canonical input', () => {
    const reader = new VarintReader(Uint8Array.of(0x80, 0x00, 0x05));
    expect(reader.read()).toMatchObject({ ok: false, reason: 'non-canonical' });
    expect(reader.offset).toBe(0);
    // After the same bytes are replaced conceptually, lenient read commits 2.
    const again = reader.read({ allowNonCanonical: true });
    expect(again).toMatchObject({ ok: true, value: 0n, nonCanonical: true });
    expect(reader.offset).toBe(2);
    expect(reader.read()).toMatchObject({ ok: true, value: 5n });
  });

  it('reads signed and zigzag values', () => {
    const signed = new VarintReader(encodeSignedVarint(-1, 32));
    expect(signed.readSigned(32)).toMatchObject({ ok: true, value: -1n });
    expect(signed.remaining).toBe(0);

    const zz = new VarintReader(encodeZigzagVarint(-42, 64));
    expect(zz.readZigzag(64)).toMatchObject({ ok: true, value: -42n });
  });

  it('width mismatch is reported without consuming bytes', () => {
    // Full uint64 max cannot decode as uint32: byte 5 (0xff) overflows width.
    const reader = new VarintReader(Uint8Array.from(U64_MAX_BYTES));
    const result = reader.read({ width: 32 });
    expect(result).toMatchObject({ ok: false, reason: 'overflow' });
    expect(reader.offset).toBe(0);
  });
});
