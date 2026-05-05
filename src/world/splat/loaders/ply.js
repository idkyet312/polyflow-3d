// src/world/splat/loaders/ply.js
//
// Standard 3D Gaussian Splatting PLY parser (Kerbl et al. 2023 export format).
//
// File layout:
//   ASCII header up to and including `end_header\n`, then a binary little-endian
//   payload of `vertex_count` records, each holding the properties listed in the
//   header (in declared order) — typically:
//
//     x, y, z, nx, ny, nz,
//     f_dc_0, f_dc_1, f_dc_2,           // SH band 0 (DC)  -> raw, evaluated in shader
//     f_rest_0 .. f_rest_44,            // SH bands 1..3 (optional, channel-major)
//     opacity,                          // logit; sigmoid -> alpha
//     scale_0, scale_1, scale_2,        // log-scale; exp -> world scale
//     rot_0, rot_1, rot_2, rot_3        // quaternion (w, x, y, z)  ← w-first!
//
// Conversions to our normalized SplatData (Phase 4 — radiance fields):
//   colors:   when DC is present, stores RAW f_dc + sigmoid(opacity), with
//             colorEncoding='fdc_raw'. The renderer (shader-side) evaluates
//             `clamp01(0.5 + SH_C0 * f_dc + bands_1..3)` once per frame.
//             When DC is absent, falls back to linear-RGB white + alpha=1
//             with colorEncoding='linear_rgb' (no eval needed).
//   scale:    Math.exp(scale_n)
//   rotation: rearrange (w,x,y,z) → (x,y,z,w), then normalize
//   sh:       when f_rest_* are present, packs them as a vertex-major
//             half-float Uint16Array — layout `[r1, g1, b1, r2, g2, b2, ...]`
//             per splat (i.e. 3K halves / splat for K coeffs/channel).
//             Source PLY layout is channel-major (f_rest_0..K-1 = R,
//             K..2K-1 = G, 2K..3K-1 = B); we transpose during parse.
//             Half-float halves memory at imperceptible quality cost
//             (web-splat reference uses the same trick).
//
// Detected SH max degree from f_rest_* property count:
//     0 f_rest → degree 0 (DC only)
//     9 f_rest → degree 1 (3 coeffs/channel)
//    24 f_rest → degree 2 (8 coeffs/channel)
//    45 f_rest → degree 3 (15 coeffs/channel)
//   Other counts → use the highest valid degree fitting; warn.
//
// Reference impls used for cross-checking conventions:
//   - antimatter15/splat (PLY → .splat converter): rot_0 is W
//   - mkkellogg/GaussianSplats3D
//   - playcanvas/splat-transform: src/lib/readers/read-ply.ts
//   - KeKsBoTer/web-splat (TSL/WGSL SH eval reference)

import { floatToHalf } from '../halfFloat.js';

const TEXT_DECODER = new TextDecoder('utf-8');

const PROP_SIZE = {
    char:    1, uchar:  1, int8:   1, uint8:  1,
    short:   2, ushort: 2, int16:  2, uint16: 2,
    int:     4, uint:   4, int32:  4, uint32: 4,
    float:   4, float32: 4,
    double:  8, float64: 8,
};

const PROP_READER = {
    char:    (dv, o, le) => dv.getInt8(o),
    int8:    (dv, o, le) => dv.getInt8(o),
    uchar:   (dv, o, le) => dv.getUint8(o),
    uint8:   (dv, o, le) => dv.getUint8(o),
    short:   (dv, o, le) => dv.getInt16(o, le),
    int16:   (dv, o, le) => dv.getInt16(o, le),
    ushort:  (dv, o, le) => dv.getUint16(o, le),
    uint16:  (dv, o, le) => dv.getUint16(o, le),
    int:     (dv, o, le) => dv.getInt32(o, le),
    int32:   (dv, o, le) => dv.getInt32(o, le),
    uint:    (dv, o, le) => dv.getUint32(o, le),
    uint32:  (dv, o, le) => dv.getUint32(o, le),
    float:   (dv, o, le) => dv.getFloat32(o, le),
    float32: (dv, o, le) => dv.getFloat32(o, le),
    double:  (dv, o, le) => dv.getFloat64(o, le),
    float64: (dv, o, le) => dv.getFloat64(o, le),
};

// SH coefficients per channel for each degree (excluding DC band 0).
//   degree 0: 0    (DC only)
//   degree 1: 3    band 1
//   degree 2: 8    bands 1..2 (3 + 5)
//   degree 3: 15   bands 1..3 (3 + 5 + 7)
const COEFFS_PER_CHANNEL = [0, 3, 8, 15];

/**
 * Map PLY's f_rest_* count → max SH degree we can render. Returns the
 * largest degree D in {0,1,2,3} such that 3 × COEFFS_PER_CHANNEL[D] <= count.
 * Truncated f_rest groups (e.g. 12 = partial deg 2) get rounded DOWN — we
 * use only complete bands.
 */
function detectShDegreeFromFRestCount(count) {
    if (count >= 45) return 3;
    if (count >= 24) return 2;
    if (count >= 9)  return 1;
    return 0;
}

// -----------------------------------------------------------------------------
// Header parsing
// -----------------------------------------------------------------------------

function readHeader(buffer) {
    const slice  = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 65536));
    const ascii  = TEXT_DECODER.decode(slice);
    const marker = ascii.indexOf('end_header');
    if (marker < 0) {
        throw new Error('[splat-ply] end_header not found in first 64 KB of file');
    }
    const after = ascii.indexOf('\n', marker);
    if (after < 0) throw new Error('[splat-ply] malformed header (no newline after end_header)');

    const headerBytes = new TextEncoder().encode(ascii.slice(0, after + 1));
    return { headerText: ascii.slice(0, after + 1), dataOffset: headerBytes.byteLength };
}

function parseHeader(headerText) {
    const lines = headerText.split(/\r?\n/);
    let format       = '';
    let vertexCount  = 0;
    const properties = [];
    let inVertexElement = false;

    for (const raw of lines) {
        const line = raw.trim();
        if (line === '' || line === 'ply' || line === 'end_header' || line.startsWith('comment')) continue;

        if (line.startsWith('format ')) {
            format = line.slice('format '.length).split(' ')[0];
            continue;
        }
        if (line.startsWith('element ')) {
            const [, name, count] = line.split(/\s+/);
            inVertexElement = (name === 'vertex');
            if (inVertexElement) vertexCount = parseInt(count, 10);
            continue;
        }
        if (line.startsWith('property ')) {
            if (!inVertexElement) continue;
            const tokens = line.split(/\s+/);
            if (tokens[1] === 'list') continue;
            const type = tokens[1];
            const name = tokens[2];
            const size = PROP_SIZE[type];
            if (size === undefined) {
                throw new Error(`[splat-ply] unsupported property type "${type}" for "${name}"`);
            }
            properties.push({ name, type, size });
        }
    }

    if (format !== 'binary_little_endian') {
        throw new Error(
            `[splat-ply] unsupported format "${format}". ` +
            `Only binary_little_endian PLY is supported (export from 3DGS / SuperSplat / etc.).`,
        );
    }
    if (!vertexCount) throw new Error('[splat-ply] header declares zero or missing vertex count');
    if (!properties.length) throw new Error('[splat-ply] header declares no vertex properties');

    return { format, vertexCount, properties };
}

// -----------------------------------------------------------------------------
// Body parsing
// -----------------------------------------------------------------------------

const REQUIRED = ['x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2',
                  'rot_0', 'rot_1', 'rot_2', 'rot_3'];

/**
 * Parse a Gaussian-flavored PLY ArrayBuffer into the normalized splat shape.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{
 *   count: number,
 *   positions: Float32Array,
 *   scales: Float32Array,
 *   colors: Float32Array,
 *   rotations: Float32Array,
 *   colorEncoding: 'fdc_raw' | 'linear_rgb',
 *   sh?: { degree: number, layout: 'direct', coeffs: Uint16Array },
 * }}
 */
export function parsePly(buffer) {
    const { headerText, dataOffset } = readHeader(buffer);
    const { vertexCount, properties } = parseHeader(headerText);

    const stride = properties.reduce((sum, p) => sum + p.size, 0);
    const offsets = {};
    let cursor = 0;
    for (const p of properties) {
        offsets[p.name] = { offset: cursor, type: p.type };
        cursor += p.size;
    }

    const bodyBytes = buffer.byteLength - dataOffset;
    if (bodyBytes < stride * vertexCount) {
        throw new Error(
            `[splat-ply] truncated body: expected ${stride * vertexCount} bytes, ` +
            `got ${bodyBytes} (header offset=${dataOffset}, file=${buffer.byteLength})`,
        );
    }

    for (const name of REQUIRED) {
        if (!(name in offsets)) {
            throw new Error(`[splat-ply] required property "${name}" missing from header`);
        }
    }
    const hasDC = !!(offsets.f_dc_0 && offsets.f_dc_1 && offsets.f_dc_2);

    // Detect SH max degree from f_rest_* property count. The exporter
    // emits f_rest_0 .. f_rest_(3K-1) where K = coeffs/channel for the
    // chosen degree. We don't read names with regex in the hot loop —
    // just count and map.
    let fRestCount = 0;
    for (const name in offsets) if (name.startsWith('f_rest_')) fRestCount++;
    const shDegree = hasDC ? detectShDegreeFromFRestCount(fRestCount) : 0;
    const K        = COEFFS_PER_CHANNEL[shDegree];

    // Verify every f_rest_<n> for n < 3K is present and float-typed.
    // (PLYs often have stray f_rest_* slots beyond what the chosen degree
    // uses; we just ignore those — but the ones we DO use must be there.)
    if (K > 0) {
        for (let i = 0; i < 3 * K; i++) {
            const propName = `f_rest_${i}`;
            const p = offsets[propName];
            if (!p) {
                throw new Error(`[splat-ply] expected SH property "${propName}" missing (degree=${shDegree})`);
            }
            if (p.type !== 'float' && p.type !== 'float32') {
                throw new Error(`[splat-ply] SH property "${propName}" must be float, got ${p.type}`);
            }
        }
    }

    const dv = new DataView(buffer, dataOffset, bodyBytes);
    const positions = new Float32Array(vertexCount * 3);
    const scales    = new Float32Array(vertexCount * 3);
    const colors    = new Float32Array(vertexCount * 4);
    const rotations = new Float32Array(vertexCount * 4);

    // Pre-compute f_rest property offsets for the hot loop. Order is
    // [c=0,k=0], [c=0,k=1], ... [c=0,k=K-1], [c=1,k=0], ... — matching the
    // PLY's channel-major layout. We index this by (c * K + k).
    let restOffsets = null;
    if (K > 0) {
        restOffsets = new Int32Array(3 * K);
        for (let c = 0; c < 3; c++) {
            for (let k = 0; k < K; k++) {
                restOffsets[c * K + k] = offsets[`f_rest_${c * K + k}`].offset;
            }
        }
    }

    // SH output buffer: vertex-major, RGB-interleaved, half-float packed.
    //   coeffs[i * 3K + k * 3 + c] = half-float of the k-th SH coeff for
    //   channel c (0=R, 1=G, 2=B) of vertex i.
    // This layout maximizes cache locality in the shader's per-vertex SH loop.
    let shCoeffs = null;
    if (K > 0) {
        shCoeffs = new Uint16Array(vertexCount * 3 * K);
    }

    const read = (name, base) => {
        const { offset, type } = offsets[name];
        return PROP_READER[type](dv, base + offset, true);
    };

    for (let i = 0; i < vertexCount; i++) {
        const base = i * stride;

        // Position
        positions[i * 3 + 0] = read('x', base);
        positions[i * 3 + 1] = read('y', base);
        positions[i * 3 + 2] = read('z', base);

        // Scales (raw is log-scale; renderer expects already-exp'd values)
        scales[i * 3 + 0] = Math.exp(read('scale_0', base));
        scales[i * 3 + 1] = Math.exp(read('scale_1', base));
        scales[i * 3 + 2] = Math.exp(read('scale_2', base));

        // Color: SH DC band stored RAW; opacity → sigmoid alpha.
        // Shader will evaluate `0.5 + SH_C0 * f_dc + bands_1..3` once per frame.
        if (hasDC) {
            colors[i * 4 + 0] = read('f_dc_0', base);
            colors[i * 4 + 1] = read('f_dc_1', base);
            colors[i * 4 + 2] = read('f_dc_2', base);
        } else {
            // No DC → fall back to opaque white. We'll surface this via
            // colorEncoding='linear_rgb' so the shader uses these directly.
            colors[i * 4 + 0] = 1;
            colors[i * 4 + 1] = 1;
            colors[i * 4 + 2] = 1;
        }
        const opacityRaw = read('opacity', base);
        colors[i * 4 + 3] = 1 / (1 + Math.exp(-opacityRaw));     // sigmoid

        // Rotation: PLY stores (w, x, y, z); renderer wants (x, y, z, w).
        const qw = read('rot_0', base);
        const qx = read('rot_1', base);
        const qy = read('rot_2', base);
        const qz = read('rot_3', base);
        const len = Math.hypot(qx, qy, qz, qw) || 1;
        rotations[i * 4 + 0] = qx / len;
        rotations[i * 4 + 1] = qy / len;
        rotations[i * 4 + 2] = qz / len;
        rotations[i * 4 + 3] = qw / len;

        // SH bands 1..3: read in PLY's channel-major order, transpose into
        // vertex-major RGB-interleaved on write, half-float pack inline.
        if (shCoeffs !== null) {
            const outBase = i * 3 * K;
            for (let k = 0; k < K; k++) {
                for (let c = 0; c < 3; c++) {
                    const f = dv.getFloat32(base + restOffsets[c * K + k], true);
                    shCoeffs[outBase + k * 3 + c] = floatToHalf(f);
                }
            }
        }
    }

    const result = {
        count: vertexCount,
        positions,
        scales,
        colors,
        rotations,
        colorEncoding: hasDC ? 'fdc_raw' : 'linear_rgb',
    };
    if (shDegree > 0) {
        result.sh = {
            degree: shDegree,
            layout: 'direct',
            coeffs: shCoeffs,
        };
    }
    return result;
}

/**
 * Convenience: fetch + parse. Mirrors the renderer's `loadSplat(url)` API.
 */
export async function loadPly(url) {
    const buf = await (await fetch(url)).arrayBuffer();
    return parsePly(buf);
}
