// src/world/splat/loaders/sog.js
//
// PlayCanvas SuperSplat SOG (Self-Organizing Gaussian) loader.
//
// Format reference (verified against playcanvas/splat-transform `read-sog.ts`
// and `write-sog.ts`):
//
//   - Container: ZIP archive with `PK\x03\x04` magic. Entries (flat, no subdirs):
//       meta.json
//       means_l.webp           position low byte    (RGBA8888 lossless WebP)
//       means_u.webp           position high byte   (RGBA8888 lossless WebP)
//       quats.webp             quaternion (largest-component-omitted)
//       scales.webp            per-channel codebook indices
//       sh0.webp               color codebook indices (RGB) + sigmoid opacity (A)
//       shN_centroids.webp     optional: higher-order SH palette
//       shN_labels.webp        optional: per-Gaussian palette index (16-bit)
//
//   - meta.json:
//       {
//         version: 2,
//         asset: { generator },
//         count,
//         means:    { mins:[x,y,z], maxs:[x,y,z], files:[...] },
//         scales:   { codebook:[float...],          files:[...] },
//         quats:    {                                files:[...] },
//         sh0:      { codebook:[float...],          files:[...] },
//         shN?:     { count, bands, codebook,       files:[...] }
//       }
//
//   - Texture dimensions: width = ceil(sqrt(count)/4)*4, height = ceil(count/width/4)*4.
//     Both are multiples of 4 (texture is padded; Gaussians fill in Morton order).
//
// Output matches the normalized splat shape used by buildSplatMesh:
//   { count, positions: F32[N*3], scales: F32[N*3], colors: F32[N*4], rotations: F32[N*4] }
//
// Phase 2.5 limitations (deferred):
//   - shN higher SH bands are ignored (no view-dependent SH rendering yet).

const SH_C0 = 0.28209479177387814;
const TEXT_DECODER = new TextDecoder('utf-8');

// =============================================================================
// Public entry points
// =============================================================================

/**
 * Parse a SOG ArrayBuffer into normalized splat data.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{count, positions, scales, colors, rotations}>}
 */
export async function parseSog(buffer) {
    const entries = await readZip(buffer);
    const metaEntry = entries.get('meta.json');
    if (!metaEntry) {
        throw new Error('[splat-sog] meta.json not found in SOG archive');
    }
    const meta = JSON.parse(TEXT_DECODER.decode(metaEntry));
    return decodeSog(meta, entries);
}

/**
 * Convenience: fetch + parse.
 */
export async function loadSog(url) {
    const buf = await (await fetch(url)).arrayBuffer();
    return parseSog(buf);
}

// =============================================================================
// Decode pipeline
// =============================================================================

async function decodeSog(meta, entries) {
    const { count } = meta;
    if (!count || count <= 0) {
        throw new Error(`[splat-sog] meta.count is invalid: ${count}`);
    }
    if (!meta.means?.files?.length || meta.means.files.length < 2) {
        throw new Error('[splat-sog] meta.means.files must list two textures (low + high)');
    }
    if (!meta.quats?.files?.length || !meta.scales?.files?.length || !meta.sh0?.files?.length) {
        throw new Error('[splat-sog] meta is missing one of: quats / scales / sh0');
    }

    // Decode all required image attributes in parallel.
    const [meansLo, meansHi, quats, scales, sh0] = await Promise.all([
        decodeWebpEntry(entries, meta.means.files[0]),
        decodeWebpEntry(entries, meta.means.files[1]),
        decodeWebpEntry(entries, meta.quats.files[0]),
        decodeWebpEntry(entries, meta.scales.files[0]),
        decodeWebpEntry(entries, meta.sh0.files[0]),
    ]);

    const positions = decodePositions(meansLo, meansHi, count, meta.means);
    const rotations = decodeQuats(quats, count);
    const out_scales = decodeScales(scales, count, meta.scales.codebook);
    const colors = decodeColorsAndOpacity(sh0, count, meta.sh0.codebook);

    return { count, positions, scales: out_scales, colors, rotations };
}

// -----------------------------------------------------------------------------
// Positions: 16-bit split precision (low + high bytes), with log-space mapping.
// -----------------------------------------------------------------------------
function decodePositions(lo, hi, count, meansMeta) {
    const mins = meansMeta.mins;
    const maxs = meansMeta.maxs;
    const rx = maxs[0] - mins[0];
    const ry = maxs[1] - mins[1];
    const rz = maxs[2] - mins[2];

    const positions = new Float32Array(count * 3);
    const inv65535 = 1 / 65535;

    for (let i = 0; i < count; i++) {
        const base = i * 4;
        const xi = lo[base + 0] | (hi[base + 0] << 8);
        const yi = lo[base + 1] | (hi[base + 1] << 8);
        const zi = lo[base + 2] | (hi[base + 2] << 8);

        // Unnormalize from log-space range stored in meta.means.{mins,maxs}.
        const lx = mins[0] + rx * (xi * inv65535);
        const ly = mins[1] + ry * (yi * inv65535);
        const lz = mins[2] + rz * (zi * inv65535);

        // Inverse log transform: sign(v) * (exp(|v|) - 1).
        positions[i * 3 + 0] = Math.sign(lx) * (Math.exp(Math.abs(lx)) - 1);
        positions[i * 3 + 1] = Math.sign(ly) * (Math.exp(Math.abs(ly)) - 1);
        positions[i * 3 + 2] = Math.sign(lz) * (Math.exp(Math.abs(lz)) - 1);
    }
    return positions;
}

// -----------------------------------------------------------------------------
// Quaternions: largest-component-omitted, recovery from sqrt(1 - sum(others^2)).
// Output order: (x, y, z, w) per the renderer's expectations.
// -----------------------------------------------------------------------------
//
// Tag (alpha channel) encodes which component was omitted:
//   tag = 252 -> q[0] (x) is the largest, omitted; a/b/c go to q[1],q[2],q[3]
//   tag = 253 -> q[1] (y) omitted; a/b/c -> q[0],q[2],q[3]
//   tag = 254 -> q[2] (z) omitted; a/b/c -> q[0],q[1],q[3]
//   tag = 255 -> q[3] (w) omitted; a/b/c -> q[0],q[1],q[2]
const QUAT_SLOTS = [
    [1, 2, 3, 0],
    [0, 2, 3, 1],
    [0, 1, 3, 2],
    [0, 1, 2, 3],
];
const SQRT2_INV = 1 / Math.sqrt(2);

function decodeQuats(rgba, count) {
    const out = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
        const base = i * 4;
        const tagByte = rgba[base + 3];
        const tag = tagByte - 252;
        const slot = (tag >= 0 && tag < 4) ? QUAT_SLOTS[tag] : QUAT_SLOTS[3];

        const a = (rgba[base + 0] / 255 * 2 - 1) * SQRT2_INV;
        const b = (rgba[base + 1] / 255 * 2 - 1) * SQRT2_INV;
        const c = (rgba[base + 2] / 255 * 2 - 1) * SQRT2_INV;

        const q = [0, 0, 0, 0];
        q[slot[0]] = a;
        q[slot[1]] = b;
        q[slot[2]] = c;
        const recoverIdx = slot[3];
        const t = 1 - (a * a + b * b + c * c);
        q[recoverIdx] = Math.sqrt(Math.max(0, t));

        // Normalize defensively (encoder makes it unit, FP rounding drifts).
        const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
        out[i * 4 + 0] = q[0] / len;
        out[i * 4 + 1] = q[1] / len;
        out[i * 4 + 2] = q[2] / len;
        out[i * 4 + 3] = q[3] / len;
    }
    return out;
}

// -----------------------------------------------------------------------------
// Scales: codebook lookup of log-scale, then exp() to world scale.
// -----------------------------------------------------------------------------
function decodeScales(rgba, count, codebook) {
    if (!codebook || codebook.length === 0) {
        throw new Error('[splat-sog] meta.scales.codebook is missing or empty');
    }
    const cb = codebook;
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const base = i * 4;
        out[i * 3 + 0] = Math.exp(cb[rgba[base + 0]]);
        out[i * 3 + 1] = Math.exp(cb[rgba[base + 1]]);
        out[i * 3 + 2] = Math.exp(cb[rgba[base + 2]]);
    }
    return out;
}

// -----------------------------------------------------------------------------
// Color (SH DC band) + opacity (already sigmoid'd).
// -----------------------------------------------------------------------------
function decodeColorsAndOpacity(rgba, count, codebook) {
    if (!codebook || codebook.length === 0) {
        throw new Error('[splat-sog] meta.sh0.codebook is missing or empty');
    }
    const cb = codebook;
    const inv255 = 1 / 255;
    const out = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
        const base = i * 4;
        const fdc0 = cb[rgba[base + 0]];
        const fdc1 = cb[rgba[base + 1]];
        const fdc2 = cb[rgba[base + 2]];

        const r = 0.5 + SH_C0 * fdc0;
        const g = 0.5 + SH_C0 * fdc1;
        const b = 0.5 + SH_C0 * fdc2;

        out[i * 4 + 0] = Math.max(0, Math.min(1, r));
        out[i * 4 + 1] = Math.max(0, Math.min(1, g));
        out[i * 4 + 2] = Math.max(0, Math.min(1, b));
        out[i * 4 + 3] = rgba[base + 3] * inv255;        // alpha already in [0,1]
    }
    return out;
}

// =============================================================================
// WebP decoding via createImageBitmap + OffscreenCanvas
// =============================================================================

/**
 * Decode a WebP entry from the ZIP map into a raw RGBA pixel buffer.
 * Returns the underlying Uint8ClampedArray (length = width * height * 4).
 */
async function decodeWebpEntry(entries, name) {
    const bytes = entries.get(name);
    if (!bytes) {
        throw new Error(`[splat-sog] missing entry "${name}" in archive`);
    }
    if (typeof createImageBitmap !== 'function') {
        throw new Error(
            '[splat-sog] createImageBitmap is unavailable. ' +
            'SOG decoding requires a browser or worker context.',
        );
    }

    const blob = new Blob([bytes], { type: 'image/webp' });
    const bitmap = await createImageBitmap(blob);

    const w = bitmap.width;
    const h = bitmap.height;

    // Prefer OffscreenCanvas (works in workers); fall back to a detached
    // <canvas> on the main thread.
    let canvas;
    if (typeof OffscreenCanvas === 'function') {
        canvas = new OffscreenCanvas(w, h);
    } else if (typeof document !== 'undefined') {
        canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
    } else {
        throw new Error('[splat-sog] no OffscreenCanvas or document available for WebP decode');
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const imageData = ctx.getImageData(0, 0, w, h);
    return imageData.data;       // Uint8ClampedArray, RGBA row-major
}

// =============================================================================
// Minimal ZIP reader (central-directory based)
// =============================================================================
//
// Handles:
//   - Method 0 (stored / no compression) — the default for already-compressed
//     WebP entries inside SOG archives.
//   - Method 8 (deflate) via the native DecompressionStream API.
//
// Does NOT handle:
//   - Encryption
//   - ZIP64 (files > 4 GB) — SOG archives are small, this is fine.
//   - Multi-volume archives.
//
// Returns a Map<filename, Uint8Array>.

const SIG_LOCAL = 0x04034b50;
const SIG_CDIR  = 0x02014b50;
const SIG_EOCD  = 0x06054b50;

async function readZip(buffer) {
    const dv = new DataView(buffer);
    const entries = new Map();

    // 1. Locate End-of-Central-Directory by scanning backward for the EOCD signature.
    //    EOCD is 22 bytes minimum, optionally followed by a comment up to 64 KB.
    const fileLen = buffer.byteLength;
    const minEocdOffset = Math.max(0, fileLen - 22 - 0xFFFF);
    let eocdOffset = -1;
    for (let i = fileLen - 22; i >= minEocdOffset; i--) {
        if (dv.getUint32(i, true) === SIG_EOCD) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset < 0) {
        throw new Error('[splat-sog] not a ZIP archive (no EOCD signature found)');
    }

    const cdirEntries = dv.getUint16(eocdOffset + 10, true);
    const cdirOffset  = dv.getUint32(eocdOffset + 16, true);

    // 2. Walk central directory; collect inflate jobs to run in parallel.
    const inflateJobs = [];
    let p = cdirOffset;
    for (let i = 0; i < cdirEntries; i++) {
        if (dv.getUint32(p, true) !== SIG_CDIR) {
            throw new Error(`[splat-sog] malformed central directory at offset ${p}`);
        }
        const compMethod    = dv.getUint16(p + 10, true);
        const compSize      = dv.getUint32(p + 20, true);
        const uncompSize    = dv.getUint32(p + 24, true);
        const nameLen       = dv.getUint16(p + 28, true);
        const extraLen      = dv.getUint16(p + 30, true);
        const commentLen    = dv.getUint16(p + 32, true);
        const localHeaderAt = dv.getUint32(p + 42, true);
        const name = TEXT_DECODER.decode(new Uint8Array(buffer, p + 46, nameLen));

        // 3. Read the local file header to find where the actual data begins.
        if (dv.getUint32(localHeaderAt, true) !== SIG_LOCAL) {
            throw new Error(`[splat-sog] malformed local header for "${name}"`);
        }
        const lfhNameLen  = dv.getUint16(localHeaderAt + 26, true);
        const lfhExtraLen = dv.getUint16(localHeaderAt + 28, true);
        const dataStart   = localHeaderAt + 30 + lfhNameLen + lfhExtraLen;

        if (compMethod === 0) {
            // Stored: data is verbatim.
            entries.set(name, new Uint8Array(buffer, dataStart, uncompSize));
        } else if (compMethod === 8) {
            // Deflate: defer to inflate pass below.
            const compressed = new Uint8Array(buffer, dataStart, compSize);
            inflateJobs.push({ name, compressed });
        } else {
            throw new Error(
                `[splat-sog] unsupported compression method ${compMethod} for "${name}". ` +
                `Only stored (0) and deflate (8) are supported.`,
            );
        }

        p += 46 + nameLen + extraLen + commentLen;
    }

    // 4. Inflate any deflated entries in parallel.
    if (inflateJobs.length) {
        if (typeof DecompressionStream !== 'function') {
            throw new Error(
                '[splat-sog] archive contains deflated entries but DecompressionStream is unavailable',
            );
        }
        await Promise.all(inflateJobs.map(async ({ name, compressed }) => {
            const stream = new Blob([compressed]).stream()
                .pipeThrough(new DecompressionStream('deflate-raw'));
            const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
            entries.set(name, inflated);
        }));
    }

    return entries;
}
