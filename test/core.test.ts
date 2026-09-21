import { describe, expect, it } from 'vitest';
import {
  decodeVarint,
  encodeVarint,
  VarintCursor,
  type VarintKind,
} from '../src/index.js';

const bytes = (...b: number[]) => Uint8Array.from(b);
const FF = 0xff;

/** 0xffffffff encoded canonically. */
const MAX_U32 = bytes(0xff, 0xff, 0xff, 0xff, 0x0f);
/** 0xffffffffffffffff encoded canonically. */
const MAX_U64 = bytes(FF, FF, FF, FF, FF, FF, FF, FF, FF, 0x01);

describe('basic values', () => {
  it('decodes zero', () => {
    expect(decodeVarint(bytes(0))).toEqual({
      ok: true,
      value: 0n,
      length: 1,
      canonical: true,
    });
  });

  it('decodes 300', () => {
    expect(decodeVarint(bytes(0xac, 0x02))).toMatchObject({
      ok: true,
      value: 300n,
      length: 2,
    });
  });

  it('decodes with an offset without touching preceding bytes', () => {
    expect(decodeVarint(bytes(0x55, 0xac, 0x02), 1)).toMatchObject({
      ok: true,
      value: 300n,
      length: 2,
    });
  });

  it('decodes max uint32', () => {
    expect(decodeVarint(MAX_U32, 0, { kind: 'uint32' })).toMatchObject({
      value: 0xffffffffn,
      length: 5,
      canonical: true,
    });
  });

  it('decodes max uint64 above the 32-bit bitwise boundary', () => {
    const r = decodeVarint(MAX_U64);
    expect(r).toMatchObject({ value: 0xffffffffffffffffn, length: 10, canonical: true });
  });

  it('treats invalid offsets as incomplete', () => {
    expect(decodeVarint(bytes(0), 3)).toEqual({ ok: false, code: 'incomplete' });
    expect(decodeVarint(bytes(0), -1)).toEqual({ ok: false, code: 'incomplete' });
  });
});

describe('int32 sign extension (ten-byte negatives)', () => {
  it('decodes canonical -1 from ten bytes', () => {
    expect(decodeVarint(MAX_U64, 0, { kind: 'int32' })).toMatchObject({
      value: -1n,
      length: 10,
      canonical: true,
    });
  });

  it('decodes canonical -2 and min int32 from ten bytes', () => {
    const minusTwo = bytes(0xfe, FF, FF, FF, FF, FF, FF, FF, FF, 0x01);
    expect(decodeVarint(minusTwo, 0, { kind: 'int32' })).toMatchObject({
      value: -2n,
      canonical: true,
    });

    const minI32 = bytes(0x80, 0x80, 0x80, 0x80, 0xf8, FF, FF, FF, FF, 0x01);
    expect(decodeVarint(minI32, 0, { kind: 'int32' })).toMatchObject({
      value: -2147483648n,
      canonical: true,
    });
  });

  it('rejects shortened negative encodings as non-canonical by default', () => {
    // 0xffffffff in five bytes: valid unsigned value, shortened int32 negative.
    expect(decodeVarint(MAX_U32, 0, { kind: 'int32' })).toEqual({
      ok: false,
      code: 'non-canonical',
    });
  });

  it('accepts but reports shortened negatives when allowed', () => {
    const r = decodeVarint(MAX_U32, 0, { kind: 'int32', allowNonCanonical: true });
    expect(r).toMatchObject({ ok: true, value: -1n, length: 5, canonical: false });

    // Six-byte form of -1 (0xffffffffff) is likewise non-canonical.
    const six = bytes(FF, FF, FF, FF, FF, 0x01);
    expect(decodeVarint(six, 0, { kind: 'int32', allowNonCanonical: true })).toMatchObject({
      value: -1n,
      canonical: false,
    });
  });

  it('decodes ordinary small int32 values', () => {
    expect(decodeVarint(bytes(0x01), 0, { kind: 'int32' })).toMatchObject({ value: 1n });
  });

  it('rejects a 10-byte positive with sign-extension bits set', () => {
    // 0xffffffff00000001 -> low-32 value 1 but the high 32 bits are set.
    const padded = bytes(0x81, 0x80, 0x80, 0x80, 0xf0, FF, FF, FF, FF, 0x01);
    expect(decodeVarint(padded, 0, { kind: 'int32' })).toEqual({
      ok: false,
      code: 'non-canonical',
    });
    expect(
      decodeVarint(padded, 0, { kind: 'int32', allowNonCanonical: true }),
    ).toMatchObject({ value: 1n, canonical: false });
  });

  it('decodes int64 negatives from ten bytes', () => {
    expect(decodeVarint(MAX_U64, 0, { kind: 'int64' })).toMatchObject({
      value: -1n,
      canonical: true,
    });
  });
});

describe('zigzag (sint32/sint64)', () => {
  it('decodes basic sint64 zigzag payloads', () => {
    const cases: Array<[number[], bigint]> = [
      [[0], 0n],
      [[1], -1n],
      [[2], 1n],
      [[3], -2n],
      [[4], 2n],
      [[254, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01], 0x7fffffffffffffffn],
      [MAX_U64, -0x8000000000000000n],
    ];
    for (const [wire, value] of cases) {
      expect(decodeVarint(Uint8Array.from(wire), 0, { kind: 'sint64' })).toMatchObject({
        value,
        canonical: true,
      });
    }
  });

  it('decodes sint32 zigzag with 32-bit folding', () => {
    // 4294967295 (max u32 zigzag) = -2147483648
    expect(decodeVarint(MAX_U32, 0, { kind: 'sint32' })).toMatchObject({
      value: -2147483648n,
      canonical: true,
    });
    expect(decodeVarint(bytes(1), 0, { kind: 'sint32' })).toMatchObject({ value: -1n });
    expect(decodeVarint(bytes(2), 0, { kind: 'sint32' })).toMatchObject({ value: 1n });
  });

  it('rejects five-byte-overflow sint32 payloads', () => {
    // Sixth byte present.
    const six = bytes(0x80, 0x80, 0x80, 0x80, 0x80, 0x00);
    expect(decodeVarint(six, 0, { kind: 'sint32' })).toEqual({
      ok: false,
      code: 'overflow',
    });
  });
});

describe('overflow: eleven bytes and terminal payload', () => {
  it('rejects an eleventh uint64 byte rather than truncating', () => {
    const eleven = bytes(FF, FF, FF, FF, FF, FF, FF, FF, FF, FF, 0x01);
    expect(decodeVarint(eleven)).toEqual({ ok: false, code: 'overflow' });
  });

  it('rejects illegal high bits in the tenth (terminal) byte', () => {
    const badLast = bytes(FF, FF, FF, FF, FF, FF, FF, FF, FF, 0x02);
    expect(decodeVarint(badLast)).toEqual({ ok: false, code: 'overflow' });
    expect(decodeVarint(badLast, 0, { allowNonCanonical: true })).toEqual({
      ok: false,
      code: 'overflow',
    });
  });

  it('rejects illegal high bits in the fifth uint32 byte', () => {
    const badLast = bytes(FF, FF, FF, FF, 0x10);
    expect(decodeVarint(badLast, 0, { kind: 'uint32' })).toEqual({
      ok: false,
      code: 'overflow',
    });
  });

  it('rejects a sixth uint32 byte as overflow, not non-canonical', () => {
    const six = bytes(0x80, 0x80, 0x80, 0x80, 0x80, 0x00);
    expect(decodeVarint(six, 0, { kind: 'uint32' })).toEqual({
      ok: false,
      code: 'overflow',
    });
  });

  it('distinguishes truncated input from overflow (no shared null)', () => {
    const tenContinuations = bytes(FF, FF, FF, FF, FF, FF, FF, FF, FF, FF);
    // Buffer ends on a continuation bit even at the width limit: incomplete.
    expect(decodeVarint(tenContinuations)).toEqual({ ok: false, code: 'incomplete' });
    // Same ten continuations plus an eleventh terminator: overflow.
    expect(decodeVarint(bytes(...tenContinuations, 0x01))).toEqual({
      ok: false,
      code: 'overflow',
    });
  });
});

describe('truncation at every position', () => {
  it('reports incomplete for every proper prefix of a 10-byte uint64', () => {
    for (let n = 0; n < MAX_U64.length; n++) {
      const prefix = MAX_U64.subarray(0, n);
      expect(decodeVarint(prefix), `prefix length ${n}`).toEqual({
        ok: false,
        code: 'incomplete',
      });
    }
  });

  it('reports incomplete for every proper prefix of a 5-byte uint32', () => {
    for (let n = 0; n < MAX_U32.length; n++) {
      const prefix = MAX_U32.subarray(0, n);
      expect(decodeVarint(prefix, 0, { kind: 'uint32' }), `prefix length ${n}`).toEqual({
        ok: false,
        code: 'incomplete',
      });
    }
  });

  it('reports incomplete on an empty buffer', () => {
    expect(decodeVarint(new Uint8Array(0))).toEqual({ ok: false, code: 'incomplete' });
  });
});

describe('non-canonical (non-shortest) encodings', () => {
  it('rejects two-byte zero', () => {
    expect(decodeVarint(bytes(0x80, 0x00))).toEqual({
      ok: false,
      code: 'non-canonical',
    });
  });

  it('rejects three-byte 300 with a trailing zero group', () => {
    expect(decodeVarint(bytes(0xac, 0x82, 0x00))).toEqual({
      ok: false,
      code: 'non-canonical',
    });
  });

  it('accepts but reports non-canonical encodings when allowed', () => {
    const zero = decodeVarint(bytes(0x80, 0x00), 0, { allowNonCanonical: true });
    expect(zero).toMatchObject({ ok: true, value: 0n, length: 2, canonical: false });

    const v300 = decodeVarint(bytes(0xac, 0x82, 0x00), 0, { allowNonCanonical: true });
    expect(v300).toMatchObject({ value: 300n, length: 3, canonical: false });
  });

  it('never confuses structural overflow with non-canonicity', () => {
    expect(decodeVarint(MAX_U64, 0, { kind: 'uint32' })).toEqual({
      ok: false,
      code: 'overflow',
    });
  });
});

describe('VarintCursor', () => {
  it('commits consumed length only after success', () => {
    const cur = new VarintCursor(bytes(0x00, 0xac, 0x02, 0x03));
    expect(cur.read()).toMatchObject({ value: 0n });
    expect(cur.offset).toBe(1);
    expect(cur.read()).toMatchObject({ value: 300n });
    expect(cur.offset).toBe(3);
    expect(cur.read()).toMatchObject({ value: 3n });
    expect(cur.offset).toBe(4);
  });

  it('does not advance on incomplete / overflow / non-canonical', () => {
    for (const bad of [
      bytes(0x80), // incomplete
      bytes(FF, FF, FF, FF, FF, FF, FF, FF, FF, FF, 0x01), // overflow
      bytes(0x80, 0x00), // non-canonical
    ]) {
      const cur = new VarintCursor(bad);
      const r = cur.read();
      expect(r.ok).toBe(false);
      expect(cur.offset).toBe(0);
    }
  });

  it('skips a non-canonical value only when permitted, reporting it', () => {
    const cur = new VarintCursor(bytes(0x80, 0x00, 0x01));
    const r = cur.read({ allowNonCanonical: true });
    expect(r).toMatchObject({ value: 0n, canonical: false, length: 2 });
    expect(cur.offset).toBe(2);
  });

  it('reports incomplete at end of buffer', () => {
    const cur = new VarintCursor(bytes(1));
    expect(cur.read()).toMatchObject({ value: 1n });
    expect(cur.read()).toEqual({ ok: false, code: 'incomplete' });
    expect(cur.offset).toBe(1);
  });
});

describe('encodeVarint canonical output', () => {
  it('encodes zero as a single zero byte', () => {
    expect([...encodeVarint(0)]).toEqual([0]);
  });

  it('encodes 300 shortest-form', () => {
    expect([...encodeVarint(300)]).toEqual([0xac, 0x02]);
  });

  it('encodes max uint32 and max uint64', () => {
    expect([...encodeVarint(0xffffffffn, 'uint32')]).toEqual([...MAX_U32]);
    expect([...encodeVarint(0xffffffffffffffffn, 'uint64')]).toEqual([...MAX_U64]);
  });

  it('encodes negative int32 as the canonical ten-byte sign extension', () => {
    expect([...encodeVarint(-1, 'int32')]).toEqual([...MAX_U64]);
    expect(encodeVarint(-1, 'int32')).toHaveLength(10);
    expect([...encodeVarint(-2147483648, 'int32')]).toEqual([
      0x80, 0x80, 0x80, 0x80, 0xf8, FF, FF, FF, FF, 0x01,
    ]);
  });

  it('encodes zigzag shortest-form', () => {
    expect([...encodeVarint(0, 'sint32')]).toEqual([0]);
    expect([...encodeVarint(-1, 'sint32')]).toEqual([1]);
    expect([...encodeVarint(1, 'sint32')]).toEqual([2]);
    expect([...encodeVarint(-2147483648, 'sint32')]).toEqual([...MAX_U32]);
    expect([...encodeVarint(-1, 'sint64')]).toEqual([1]);
    expect([...encodeVarint(-9223372036854775808n, 'sint64')]).toEqual([...MAX_U64]);
  });

  it('throws on values outside the declared width', () => {
    expect(() => encodeVarint(-1, 'uint64')).toThrow(RangeError);
    expect(() => encodeVarint(0x100000000n, 'uint32')).toThrow(RangeError);
    expect(() => encodeVarint(0x10000000000000000n, 'uint64')).toThrow(RangeError);
    expect(() => encodeVarint(-2147483649, 'int32')).toThrow(RangeError);
  });
});

describe('round trips and canonical guarantee', () => {
  const values = [
    0n,
    1n,
    2n,
    127n,
    128n,
    300n,
    16383n,
    16384n,
    0xffff_ffffn,
    0x1_0000_0000n,
    0xdead_beef_cafen,
    0x7fff_ffff_ffff_ffffn,
    0xffff_ffff_ffff_ffffn,
  ];

  const unsigned: Array<[VarintKind, bigint, bigint]> = [
    ['uint32', 0n, 0xffff_ffffn],
    ['uint64', 0n, 0xffff_ffff_ffff_ffffn],
  ];

  it('every encoded varint decodes canonically to the same value', () => {
    for (const [kind] of unsigned) {
      for (const v of values) {
        if (kind === 'uint32' && v > 0xffff_ffffn) continue;
        const wire = encodeVarint(v, kind);
        const r = decodeVarint(wire, 0, { kind });
        expect(r, `${kind} ${v}`).toMatchObject({
          ok: true,
          value: v,
          length: wire.length,
          canonical: true,
        });
      }
    }
  });

  it('encoded output has no redundant zero group and obeys terminal bit limits', () => {
    for (const v of values) {
      const wire = encodeVarint(v);
      if (wire.length > 1) {
        expect(wire[wire.length - 1] & 0x7f, `last byte of ${v}`).not.toBe(0);
      }
      for (let i = 0; i < wire.length - 1; i++) expect(wire[i] & 0x80).not.toBe(0);
      expect(wire[wire.length - 1] & 0x80).toBe(0);
    }
  });

  it('round trips signed and zigzag kinds', () => {
    const signedCases: Array<[VarintKind, bigint[]]> = [
      ['int32', [0n, 1n, -1n, 127n, -128n, 2147483647n, -2147483648n]],
      ['int64', [0n, 1n, -1n, 9223372036854775807n, -9223372036854775808n]],
      ['sint32', [0n, 1n, -1n, 63n, -64n, 2147483647n, -2147483648n]],
      ['sint64', [0n, 1n, -1n, 9223372036854775807n, -9223372036854775808n]],
    ];
    for (const [kind, vs] of signedCases) {
      for (const v of vs) {
        const wire = encodeVarint(v, kind);
        const r = decodeVarint(wire, 0, { kind });
        expect(r, `${kind} ${v}`).toMatchObject({
          ok: true,
          value: v,
          length: wire.length,
          canonical: true,
        });
      }
    }
  });
});
