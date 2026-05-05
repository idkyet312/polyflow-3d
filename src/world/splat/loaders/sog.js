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
//       shN_centroids.webp     optional: higher-order SH palette (codebook bytes)
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
// Output matches the normalized splat shape used by buildSplatMesh, with two
// additions in Phase 4 (radiance fields):
//   { count, positions, scales, colors, rotations,
//     colorEncoding: 'fdc_raw' | 'linear_rgb',     // 'fdc_raw' when sh0 present
//     sh?: { degree, layout: 'codebook', codebookSize, codebook, labels },
//   }
//
// SH-N format assumptions (FIXME — verify against PlayCanvas read-sog.ts at
// PR time; ship-best-guess for now and validate on a real SuperSplat export):
//   - meta.shN.bands ∈ {1,2,3}            → SH degree (= K-coeffs-per-channel)
//   - meta.shN.count                      → codebook entry count (≤ 65536)
//   - meta.shN.codebook = [min, max]      → byte→float quantization range
//                                            (single global range across all
//                                            entries × all coefs). If two
//                                            different lengths are seen at
//                                            run time, log + bail to DC-only.
//   - shN_centroids.webp pixels (RGBA8888)→ codebook entries laid out
//                                            row-major; each entry's 3K
//                                            coefficients are 8-bit-quantized
//                                            and read sequentially across
//                                            pixels (4 coefficients per pixel
//                                            using all RGBA channels).
//   - shN_labels.webp pixels (RGBA8888)   → per-vertex u16 index packed as
//                                            `R | (G << 8)` (B,A unused).

import { floatToHalf } from '../halfFloat.js';

const SH_C0 = 0.28209479177387814;
const TEXT_DECODER = new TextDecoder('utf-8');

// SH coefficients per channel for each degree (excluding DC band 0).
const COEFFS_PER_CHANNEL = [0, 3, 8, 15];

// =============================================================================
// Public entry points
// =============================================================================

/**
 * Parse a SOG ArrayBuffer into normalized splat data.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{count, positions, scales, colors, rotations, colorEncoding, sh?}>}
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

    // Decode the always-present attributes in parallel.
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
    const colors = decodeRawDcAndOpacity(sh0, count, meta.sh0.codebook);

    const result = {
        count,
        positions,
        scales: out_scales,
        colors,
        rotations,
        // sh0 codebook gave us f_dc per channel (raw, not evaluated). Shader
        // does the `0.5 + SH_C0 * f_dc + bands_1..3` chain.
        colorEncoding: 'fdc_raw',
    };

    // Optional: higher-order SH (bands 1..N).
    if (meta.shN?.files?.length && meta.shN.bands && meta.shN.count) {
        try {
            const sh = await decodeShN(entries, meta.shN, count);
            if (sh) result.sh = sh;
        } catch (err) {
            console.warn('[splat-sog] shN decode failed; falling back to DC-only:', err.message);
        }
    }

    return result;
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

        const lx = mins[0] + rx * (xi * inv65535);
        const ly = mins[1] + ry * (yi * inv65535);
        const lz = mins[2] + rz * (zi * inv65535);

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
// SH band 0 (DC) — raw f_dc lookup + opacity (already sigmoid'd).
// CHANGED in Phase 4: outputs RAW f_dc (not 0.5 + SH_C0 * f_dc), so the
// shader can do the full clamp01(0.5 + SH_C0 * f_dc + bands_1..3) chain in
// one place. colorEncoding='fdc_raw'.
// -----------------------------------------------------------------------------
function decodeRawDcAndOpacity(rgba, count, codebook) {
    if (!codebook || codebook.length === 0) {
        throw new Error('[splat-sog] meta.sh0.codebook is missing or empty');
    }
    const cb = codebook;
    const inv255 = 1 / 255;
    const out = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
        const base = i * 4;
        out[i * 4 + 0] = cb[rgba[base + 0]];                  // raw f_dc R
        out[i * 4 + 1] = cb[rgba[base + 1]];                  // raw f_dc G
        out[i * 4 + 2] = cb[rgba[base + 2]];                  // raw f_dc B
        out[i * 4 + 3] = rgba[base + 3] * inv255;             // alpha already in [0,1]
    }
    return out;
}

// -----------------------------------------------------------------------------
// SH bands 1..N — codebook indexed by 16-bit per-vertex labels.
//
// Returns: { degree, layout: 'codebook', codebookSize, codebook, labels }
//   - codebook  : Uint16Array of half-floats, length codebookSize × 3K.
//                 Layout: codebook[entry * 3K + k * 3 + c] = k-th coef, channel c.
//   - labels    : Uint16Array of length `count`, per-vertex codebook index.
//
// FIXME: Format assumptions for shN_centroids.webp / shN_labels.webp are
// best-guess (see top-of-file note). Verify on a real SuperSplat export
// before merging.
// -----------------------------------------------------------------------------
async function decodeShN(entries, shNMeta, vertexCount) {
    const bands = shNMeta.bands | 0;
    if (bands < 1 || bands > 3) {
        console.warn(`[splat-sog] unsupported shN bands=${bands}; skipping`);
        return null;
    }
    const K = COEFFS_PER_CHANNEL[bands];
    if (K === 0) return null;

    const codebookCount = shNMeta.count | 0;
    if (codebookCount <= 0 || codebookCount > 65536) {
        console.warn(`[splat-sog] shN codebook count out of range: ${codebookCount}`);
        return null;
    }

    if (!shNMeta.files || shNMeta.files.length < 2) {
        console.warn('[splat-sog] meta.shN.files must list two textures (centroids + labels)');
        return null;
    }

    // Find the centroid texture (first non-labels file) and labels texture.
    // Names typically include "centroids" / "labels" but order isn't guaranteed.
    let centroidsName = null;
    let labelsName    = null;
    for (const f of shNMeta.files) {
        if (typeof f !== 'string') continue;
        if (f.includes('label')) labelsName = f;
        else if (f.includes('centroid')) centroidsName = f;
    }
    // Fallback: positional order [centroids, labels] from playcanvas.
    if (!centroidsName) centroidsName = shNMeta.files[0];
    if (!labelsName)    labelsName    = shNMeta.files[1];

    const [centroidsRgba, labelsRgba] = await Promise.all([
        decodeWebpEntry(entries, centroidsName),
        decodeWebpEntry(entries, labelsName),
    ]);

    // Centroids: each codebook entry is 3K bytes, laid out row-major across
    // pixels using all 4 RGBA channels per pixel (so 4 coefficients per pixel).
    // FIXME: verify pixel layout against PlayCanvas — could alternatively be
    // RGB-only (3 coeffs/pixel) or strided (1 coeff/pixel) on different
    // exporter versions.
    const range = shNMeta.codebook;
    let cbMin, cbMax;
    if (Array.isArray(range) && range.length === 2) {
        cbMin = range[0];
        cbMax = range[1];
    } else {
        // Some exporters may emit the full codebook as a flat float array
        // here — in that case, skip WebP decode and use it directly. We
        // detect this by length matching codebookCount * 3K.
        if (Array.isArray(range) && range.length === codebookCount * 3 * K) {
            return packShNFromFloatCodebook(range, codebookCount, K, labelsRgba, vertexCount);
        }
        console.warn('[splat-sog] meta.shN.codebook has unexpected shape; skipping shN');
        return null;
    }

    const codebook = new Uint16Array(codebookCount * 3 * K);
    const cbScale  = (cbMax - cbMin) / 255;
    const totalCoefBytes = codebookCount * 3 * K;
    if (centroidsRgba.length < totalCoefBytes) {
        console.warn(
            `[splat-sog] shN_centroids texture too small: have ${centroidsRgba.length} bytes, ` +
            `need ${totalCoefBytes}. Skipping shN.`,
        );
        return null;
    }

    // Walk pixel buffer linearly; each byte is one coefficient.
    // Output index: codebook[entry * 3K + k * 3 + c]
    //   entry ∈ [0, codebookCount)
    //   k ∈ [0, K)
    //   c ∈ [0, 3)
    // FIXME: this assumes channel-major source (entry's R coefs first,
    // then G, then B) similar to PLY's f_rest layout. Verify.
    for (let entry = 0; entry < codebookCount; entry++) {
        const srcBase = entry * 3 * K;
        const dstBase = entry * 3 * K;
        for (let c = 0; c < 3; c++) {
            for (let k = 0; k < K; k++) {
                const byte = centroidsRgba[srcBase + c * K + k];
                const f = cbMin + byte * cbScale;
                codebook[dstBase + k * 3 + c] = floatToHalf(f);
            }
        }
    }

    // Labels: 16-bit indices, packed `R | (G << 8)` per pixel.
    if (labelsRgba.length < vertexCount * 4) {
        console.warn(
            `[splat-sog] shN_labels texture too small: have ${labelsRgba.length} bytes, ` +
            `need ${vertexCount * 4}. Skipping shN.`,
        );
        return null;
    }
    const labels = new Uint16Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
        const base = i * 4;
        labels[i] = labelsRgba[base + 0] | (labelsRgba[base + 1] << 8);
    }

    return {
        degree: bands,
        layout: 'codebook',
        codebookSize: codebookCount,
        codebook,
        labels,
    };
}

/**
 * When meta.shN.codebook is provided as a full flat float array (some exporter
 * variants), bypass the WebP decode and pack directly.
 */
function packShNFromFloatCodebook(floatCodebook, codebookCount, K, labelsRgba, vertexCount) {
    const codebook = new Uint16Array(codebookCount * 3 * K);
    // Source layout assumed channel-major per entry; transpose to vertex-major
    // RGB-interleaved (entry * 3K + k * 3 + c).
    for (let entry = 0; entry < codebookCount; entry++) {
        const srcBase = entry * 3 * K;
        const dstBase = entry * 3 * K;
        for (let c = 0; c < 3; c++) {
            for (let k = 0; k < K; k++) {
                codebook[dstBase + k * 3 + c] = floatToHalf(floatCodebook[srcBase + c * K + k]);
            }
        }
    }
    const labels = new Uint16Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
        const base = i * 4;
        labels[i] = labelsRgba[base + 0] | (labelsRgba[base + 1] << 8);
    }
    return {
        degree: K === 3 ? 1 : K === 8 ? 2 : 3,
        layout: 'codebook',
        codebookSize: codebookCount,
        codebook,
        labels,
    };
}

// =============================================================================
// WebP decoding via createImageBitmap + OffscreenCanvas
// =============================================================================

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
    return imageData.data;
}

// =============================================================================
// Minimal ZIP reader (central-directory based)
// =============================================================================

const SIG_LOCAL = 0x04034b50;
const SIG_CDIR  = 0x02014b50;
const SIG_EOCD  = 0x06054b50;

async function readZip(buffer) {
    const dv = new DataView(buffer);
    const entries = new Map();

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

        if (dv.getUint32(localHeaderAt, true) !== SIG_LOCAL) {
            throw new Error(`[splat-sog] malformed local header for "${name}"`);
        }
        const lfhNameLen  = dv.getUint16(localHeaderAt + 26, true);
        const lfhExtraLen = dv.getUint16(localHeaderAt + 28, true);
        const dataStart   = localHeaderAt + 30 + lfhNameLen + lfhExtraLen;

        if (compMethod === 0) {
            entries.set(name, new Uint8Array(buffer, dataStart, uncompSize));
        } else if (compMethod === 8) {
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
