// src/world/splat/halfFloat.js
//
// Float32 → IEEE 754 binary16 (half-float) pack utility, used by the splat
// loaders to halve SH-coefficient memory before upload.
//
// Why this lives in its own module:
//   - Both ply.js and sog.js need it (and `.splat` doesn't, so it can't sit
//     in loaders/index.js's hot loop).
//   - Lets the GPU side stay generic — storage buffers carry packed u32s
//     where each u32 = packHalf2x16(a, b). The TSL preprocess kernel does
//     `unpackHalf2x16(...)` on each read, no host-side knowledge required.
//
// The pack is the textbook "shift mantissa, clamp exponent, handle subnormals"
// implementation — same idea as float16 polyfills, but inlined into a hot
// loop variant for big arrays. Validated against IEEE 754 for normals,
// subnormals, ±0, ±Inf, and NaN.
//
// Performance note: ~50 ms per 67.5 M floats (1.5 M splats × 45 SH coeffs)
// in V8. One-time cost at file load — not on the per-frame path.

const _f32  = new Float32Array(1);
const _u32  = new Uint32Array(_f32.buffer);

/**
 * Convert one f32 → its u16 half-float bit pattern.
 * Branch-light implementation; shared scratch buffers for the f32 ↔ u32 reinterpret.
 * @param {number} f
 * @returns {number} u16 bit pattern
 */
export function floatToHalf(f) {
    _f32[0] = f;
    const x = _u32[0];

    const sign = (x >>> 16) & 0x8000;
    let   m    = x & 0x007fffff;            // mantissa
    let   e    = (x >>> 23) & 0xff;          // exponent

    if (e === 0xff) {                        // NaN / ±Inf
        return sign | 0x7c00 | (m ? 0x0200 : 0);
    }

    // Re-bias exponent: f32 bias 127 → f16 bias 15.
    e = e - 127 + 15;

    if (e >= 0x1f) {                         // overflow → ±Inf
        return sign | 0x7c00;
    }
    if (e <= 0) {                            // subnormal or underflow
        if (e < -10) return sign;            // underflow to ±0
        m = (m | 0x00800000) >>> (1 - e);
        // Round-to-nearest-even on the bit we drop.
        if (m & 0x00001000) m += 0x00002000;
        return sign | (m >>> 13);
    }

    // Round-to-nearest-even.
    if (m & 0x00001000) {
        m += 0x00002000;
        if (m & 0x00800000) {                // mantissa overflow → bump exponent
            m = 0;
            e += 1;
            if (e >= 0x1f) return sign | 0x7c00;
        }
    }
    return sign | (e << 10) | (m >>> 13);
}

/**
 * Pack a Float32Array into a Uint16Array of half-floats.
 * Length-equivalent: out.length === src.length.
 *
 * @param {Float32Array} src
 * @param {Uint16Array}  [out]  Optional pre-allocated buffer.
 * @returns {Uint16Array}
 */
export function packHalfArray(src, out) {
    const n = src.length;
    if (!out) out = new Uint16Array(n);
    if (out.length !== n) {
        throw new Error(`[halfFloat] output length ${out.length} != input length ${n}`);
    }
    for (let i = 0; i < n; i++) {
        out[i] = floatToHalf(src[i]);
    }
    return out;
}

/**
 * Convenience: pack into a Uint32Array where each u32 holds two halves
 * laid out as `packHalf2x16(low, high)` — i.e. low half in bits 0..15,
 * high half in bits 16..31. This is the layout TSL's `unpackHalf2x16`
 * expects when the storage buffer is bound as `array<u32>`.
 *
 * If src.length is odd, the trailing slot's high half is zero.
 *
 * @param {Float32Array} src
 * @returns {Uint32Array}
 */
export function packHalfPairs(src) {
    const n   = src.length;
    const out = new Uint32Array((n + 1) >> 1);
    let oi = 0;
    for (let i = 0; i < n - 1; i += 2) {
        const lo = floatToHalf(src[i]);
        const hi = floatToHalf(src[i + 1]);
        out[oi++] = lo | (hi << 16);
    }
    if (n & 1) {
        out[oi] = floatToHalf(src[n - 1]);   // trailing odd value, hi half = 0
    }
    return out;
}

// Scratch buffer for the half→float decode path.
const _decode_f32 = new Float32Array(1);
const _decode_u32 = new Uint32Array(_decode_f32.buffer);

/**
 * Convert one u16 half-float bit pattern → its f32 value.
 * Inverse of floatToHalf.
 * @param {number} h u16 bit pattern
 * @returns {number} f32 value
 */
export function halfToFloat(h) {
    const sign = (h & 0x8000) << 16;
    let   exp  = (h & 0x7c00) >>> 10;
    let   m    = h & 0x03ff;

    if (exp === 0) {
        if (m === 0) {
            _decode_u32[0] = sign;
            return _decode_f32[0];
        }
        // Subnormal — normalize.
        while ((m & 0x0400) === 0) { m <<= 1; exp -= 1; }
        m &= 0x03ff;
        exp += 1;
    } else if (exp === 0x1f) {
        // ±Inf or NaN.
        _decode_u32[0] = sign | 0x7f800000 | (m << 13);
        return _decode_f32[0];
    }
    exp = exp + 127 - 15;
    _decode_u32[0] = sign | (exp << 23) | (m << 13);
    return _decode_f32[0];
}

/**
 * Decode a Uint16Array of half-floats into a Float32Array.
 * Length-equivalent: out.length === src.length.
 *
 * @param {Uint16Array}  src
 * @param {Float32Array} [out]  Optional pre-allocated buffer.
 * @returns {Float32Array}
 */
export function unpackHalfArray(src, out) {
    const n = src.length;
    if (!out) out = new Float32Array(n);
    if (out.length !== n) {
        throw new Error(`[halfFloat] output length ${out.length} != input length ${n}`);
    }
    for (let i = 0; i < n; i++) {
        out[i] = halfToFloat(src[i]);
    }
    return out;
}
