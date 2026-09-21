# Protocol Buffers core

TypeScript library for wire format processing.

Run `npm install`, then `npm test` and `npm run build`.

## Varints

All parsing is done incrementally with `bigint`, so 64-bit values are never
truncated by JavaScript's 32-bit bitwise operators.

```ts
import { decodeVarint, encodeVarint, VarintCursor } from './src/index.js';

// { ok: true, value: 18446744073709551615n, length: 10, canonical: true }
decodeVarint(maxUint64Bytes, 0, { kind: 'uint64' });

// Failures are discriminated — never a shared null:
//   'incomplete'     input ends while a continuation bit is set
//   'overflow'       byte count or terminal-byte payload exceeds the width
//   'non-canonical'  value is encoded in a non-shortest form
decodeVarint(new Uint8Array(10).fill(0xff));   // { ok:false, code:'incomplete' }
decodeVarint(elevenBytes);                     // { ok:false, code:'overflow' }
decodeVarint(Uint8Array.of(0x80, 0));          // { ok:false, code:'non-canonical' }

// Opt in to non-shortest encodings; they are still reported:
decodeVarint(data, 0, { allowNonCanonical: true }); // canonical: false
```

Supported widths: `uint32`/`sint32` (5 bytes max, 4 residual bits) and
`uint64`/`int64`/`sint64`/`int32` (10 bytes max, 1 residual bit; negative
`int32` uses the canonical ten-byte sign-extended form).

`VarintCursor.read()` commits consumed bytes only on success; failed reads
leave the cursor position untouched. `encodeVarint` always emits the shortest
canonical representation for the declared width and throws `RangeError` for
out-of-range values.
