// src/world/splat/loaders/index.js
//
// Format dispatcher for Gaussian Splat loaders.
//
// Detects the file format by extension first, falls back to magic-byte sniffing
// for extensionless URLs, and delegates to the matching parser. All parsers
// return the same normalized shape consumed by `buildSplatMesh`:
//
//   {
//     count:     number,
//     positions: Float32Array(count * 3),  // raw xyz
//     scales:    Float32Array(count * 3),  // already exp(log_scale)
//     colors:    Float32Array(count * 4),  // RGBA in [0,1]
//     rotations: Float32Array(count * 4),  // quaternion (x,y,z,w), normalized
//     shCoefficients?: Float32Array(count * 48), // coeff-major SH, raw linear coeffs
//     shDegree?: 1 | 2 | 3,
//   }
//
// Supported formats:
//   - .splat  Antimatter15-style raw 32-byte records (no header).
//   - .ply    Standard 3D Gaussian Splatting PLY (binary little-endian).
//   - .sog    PlayCanvas SuperSplat Self-Organizing Gaussian (ZIP + WebP grids).

import { parsePly } from './ply.js';
import { parseSog } from './sog.js';

const PK_MAGIC      = 0x504B0304;    // "PK\x03\x04"  (ZIP local file header)
const PK_MAGIC_EOCD = 0x504B0506;    // "PK\x05\x06"  (ZIP end-of-central-dir)
const SPLAT_BYTES   = 32;
const SRGB_TO_LINEAR_LUT = (() => {
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
        const c = i / 255;
        lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return lut;
})();

/**
 * Detect splat format from URL extension. Returns one of:
 *   'splat' | 'ply' | 'sog' | null
 *
 * Checks the path before any query/fragment first, then falls back to the full
 * URL — so callers can stash a filename hint in the fragment of a `blob:` URL
 * (e.g. `blob:abc#scene.ply`), since blob URLs themselves have no extension.
 */
export function detectFormatFromUrl(url) {
    if (typeof url !== 'string') return null;
    const lower = url.toLowerCase();
    const path = lower.split('?')[0].split('#')[0];
    if (path.endsWith('.splat') || lower.endsWith('.splat')) return 'splat';
    if (path.endsWith('.ply')   || lower.endsWith('.ply'))   return 'ply';
    if (path.endsWith('.sog')   || lower.endsWith('.sog'))   return 'sog';
    return null;
}

/**
 * Detect splat format by sniffing the first few bytes of an ArrayBuffer.
 * Useful when the URL has no extension (e.g. content-disposition redirects).
 */
export function detectFormatFromBuffer(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) return null;
    const view = new DataView(buffer);
    const magic = view.getUint32(0, false);     // big-endian read of first 4 bytes
    if (magic === PK_MAGIC || magic === PK_MAGIC_EOCD) return 'sog';
    // PLY ASCII header always starts with "ply\n" (or "ply\r\n").
    if (view.getUint8(0) === 0x70 &&
        view.getUint8(1) === 0x6C &&
        view.getUint8(2) === 0x79) return 'ply';
    // .splat has no magic header; caller treats this as a fallback case.
    return null;
}

// -----------------------------------------------------------------------------
// .splat (Antimatter15) binary parser. Inlined here to avoid a circular import
// with splatRenderer.js (which re-exports its own copy for backward compat).
// -----------------------------------------------------------------------------
//
// 32 bytes per splat, little-endian:
//   0..11   position xyz (3 x f32)
//   12..23  scale xyz    (3 x f32, already exp(log_scale))
//   24..27  color RGBA   (4 x u8, divide by 255)
//   28..31  rotation xyzw(4 x u8, decode (b - 127.5) / 127.5)
export function parseSplatBinary(arrayBuffer) {
    if (arrayBuffer.byteLength % SPLAT_BYTES !== 0) {
        throw new Error(
            `[splat-loader] .splat buffer length ${arrayBuffer.byteLength} is not a multiple of ${SPLAT_BYTES}`,
        );
    }
    const view = new DataView(arrayBuffer);
    const count = (arrayBuffer.byteLength / SPLAT_BYTES) | 0;
    const positions = new Float32Array(count * 3);
    const scales    = new Float32Array(count * 3);
    const colors    = new Float32Array(count * 4);
    const rotations = new Float32Array(count * 4);

    for (let i = 0; i < count; i++) {
        const o = i * SPLAT_BYTES;
        positions[i * 3 + 0] = view.getFloat32(o,      true);
        positions[i * 3 + 1] = view.getFloat32(o + 4,  true);
        positions[i * 3 + 2] = view.getFloat32(o + 8,  true);
        scales[i * 3 + 0]    = view.getFloat32(o + 12, true);
        scales[i * 3 + 1]    = view.getFloat32(o + 16, true);
        scales[i * 3 + 2]    = view.getFloat32(o + 20, true);
        colors[i * 4 + 0]    = SRGB_TO_LINEAR_LUT[view.getUint8(o + 24)];
        colors[i * 4 + 1]    = SRGB_TO_LINEAR_LUT[view.getUint8(o + 25)];
        colors[i * 4 + 2]    = SRGB_TO_LINEAR_LUT[view.getUint8(o + 26)];
        colors[i * 4 + 3]    = view.getUint8(o + 27) / 255;
        rotations[i * 4 + 0] = (view.getUint8(o + 28) - 127.5) / 127.5;
        rotations[i * 4 + 1] = (view.getUint8(o + 29) - 127.5) / 127.5;
        rotations[i * 4 + 2] = (view.getUint8(o + 30) - 127.5) / 127.5;
        rotations[i * 4 + 3] = (view.getUint8(o + 31) - 127.5) / 127.5;
    }
    return { count, positions, scales, colors, rotations };
}

/**
 * Parse a splat ArrayBuffer of any supported format. Useful when you've
 * already fetched the bytes (e.g. from a drag-and-drop file input).
 *
 * @param {ArrayBuffer} buffer
 * @param {string} [hint]  Optional URL or filename for extension-based detection.
 * @returns {Promise<{count, positions, scales, colors, rotations}>}
 */
export async function parseSplatAny(buffer, hint = '') {
    const format =
        detectFormatFromUrl(hint) ||
        detectFormatFromBuffer(buffer) ||
        (buffer.byteLength > 0 && buffer.byteLength % SPLAT_BYTES === 0 ? 'splat' : null);

    if (!format) {
        throw new Error(
            `[splat-loader] cannot detect splat format` +
            (hint ? ` for ${hint}` : '') +
            ` (got ${buffer.byteLength} bytes, no recognizable magic).`,
        );
    }

    switch (format) {
        case 'splat': return parseSplatBinary(buffer);
        case 'ply':   return parsePly(buffer);
        case 'sog':   return await parseSog(buffer);
        default:
            throw new Error(`[splat-loader] unsupported format: ${format}`);
    }
}

/**
 * Load a splat file by URL, returning the normalized data shape.
 *
 *   const data = await loadSplatAny('https://example.com/scene.ply');
 *   const mesh = buildSplatMesh(data);
 */
export async function loadSplatAny(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`[splat-loader] fetch failed: ${response.status} ${response.statusText} for ${url}`);
    }
    const buffer = await response.arrayBuffer();
    return parseSplatAny(buffer, url);
}

// Re-export sub-loaders for callers who want to bypass detection.
export { parsePly, parseSog };
