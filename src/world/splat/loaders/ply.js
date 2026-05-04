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
//     f_dc_0, f_dc_1, f_dc_2,           // SH band 0 (DC)  -> RGB
//     f_rest_0 .. f_rest_44,            // SH bands 1..3 (optional)
//     opacity,                          // logit; sigmoid -> alpha
//     scale_0, scale_1, scale_2,        // log-scale; exp -> world scale
//     rot_0, rot_1, rot_2, rot_3        // quaternion (w, x, y, z)  ← w-first!
//
// Conversions to our normalized SplatData:
//   color:    RGB = clamp01(0.5 + 0.28209479177 * f_dc_n);  alpha = sigmoid(opacity)
//   scale:    Math.exp(scale_n)
//   rotation: rearrange (w,x,y,z) → (x,y,z,w), then normalize
//
// We currently discard f_rest_* (no view-dependent SH yet — Phase 1.5 work).
//
// Reference impls used for cross-checking conventions:
//   - antimatter15/splat (PLY → .splat converter): rot_0 is W
//   - mkkellogg/GaussianSplats3D
//   - playcanvas/splat-transform: src/lib/readers/read-ply.ts

const SH_C0 = 0.28209479177387814;    // 0th-order SH basis constant
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

// -----------------------------------------------------------------------------
// Header parsing
// -----------------------------------------------------------------------------

/**
 * Locate the byte offset just past `end_header\n` in the buffer.
 * Decodes only the leading slice (PLY headers are small ASCII).
 *
 * @param {ArrayBuffer} buffer
 * @returns {{ headerText: string, dataOffset: number }}
 */
function readHeader(buffer) {
    const slice  = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 65536));
    const ascii  = TEXT_DECODER.decode(slice);
    const marker = ascii.indexOf('end_header');
    if (marker < 0) {
        throw new Error('[splat-ply] end_header not found in first 64 KB of file');
    }
    // Header may end with "end_header\n" or "end_header\r\n".
    const after = ascii.indexOf('\n', marker);
    if (after < 0) throw new Error('[splat-ply] malformed header (no newline after end_header)');

    // Re-encode the header substring to get its true byte length, since the
    // 64 KB ASCII slice may contain non-ASCII bytes that don't correspond 1:1.
    const headerBytes = new TextEncoder().encode(ascii.slice(0, after + 1));
    return { headerText: ascii.slice(0, after + 1), dataOffset: headerBytes.byteLength };
}

/**
 * Parse the header text into a structured form.
 *
 * @param {string} headerText
 * @returns {{ format: string, vertexCount: number, properties: Array<{name:string,type:string,size:number}> }}
 */
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
            if (!inVertexElement) continue;     // skip e.g. face properties
            // "property <type> <name>"  or  "property list <count_type> <type> <name>"
            const tokens = line.split(/\s+/);
            if (tokens[1] === 'list') continue; // we don't need list properties for splats
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
 * @returns {{count, positions, scales, colors, rotations}}
 */
export function parsePly(buffer) {
    const { headerText, dataOffset } = readHeader(buffer);
    const { vertexCount, properties } = parseHeader(headerText);

    // Compute byte stride and per-property offset within the stride.
    const stride = properties.reduce((sum, p) => sum + p.size, 0);
    const offsets = {};
    let cursor = 0;
    for (const p of properties) {
        offsets[p.name] = { offset: cursor, type: p.type };
        cursor += p.size;
    }

    // Sanity-check: file must be long enough to hold all records.
    const bodyBytes = buffer.byteLength - dataOffset;
    if (bodyBytes < stride * vertexCount) {
        throw new Error(
            `[splat-ply] truncated body: expected ${stride * vertexCount} bytes, ` +
            `got ${bodyBytes} (header offset=${dataOffset}, file=${buffer.byteLength})`,
        );
    }

    // Verify required properties are present. f_dc_0..2 are also expected for
    // color but we degrade gracefully (white) if missing.
    for (const name of REQUIRED) {
        if (!(name in offsets)) {
            throw new Error(`[splat-ply] required property "${name}" missing from header`);
        }
    }
    const hasDC = offsets.f_dc_0 && offsets.f_dc_1 && offsets.f_dc_2;

    const dv = new DataView(buffer, dataOffset, bodyBytes);
    const positions = new Float32Array(vertexCount * 3);
    const scales    = new Float32Array(vertexCount * 3);
    const colors    = new Float32Array(vertexCount * 4);
    const rotations = new Float32Array(vertexCount * 4);

    // Hoist readers into locals so the hot loop avoids object indirection.
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

        // Color: SH DC band → linear RGB; opacity → sigmoid alpha.
        if (hasDC) {
            const r = 0.5 + SH_C0 * read('f_dc_0', base);
            const g = 0.5 + SH_C0 * read('f_dc_1', base);
            const b = 0.5 + SH_C0 * read('f_dc_2', base);
            colors[i * 4 + 0] = Math.max(0, Math.min(1, r));
            colors[i * 4 + 1] = Math.max(0, Math.min(1, g));
            colors[i * 4 + 2] = Math.max(0, Math.min(1, b));
        } else {
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
    }

    return { count: vertexCount, positions, scales, colors, rotations };
}

/**
 * Convenience: fetch + parse. Mirrors the renderer's `loadSplat(url)` API.
 */
export async function loadPly(url) {
    const buf = await (await fetch(url)).arrayBuffer();
    return parsePly(buf);
}
