import * as THREE from 'three';

// Procedural brick texture set generated on a canvas. Returns three textures
// — albedo (sRGB), normal (linear), height (linear) — all sharing the same
// tile size so a single set of UVs samples them coherently.
//
// The set is cached at module load so multiple meshes pointing at the same
// brick-style material share GPU memory. Each call returns the same texture
// objects, NOT clones; mutating them mutates the shared set.

const cache = new Map();

function drawBricks({
    size = 512,
    rows = 6,
    cols = 4,
    mortar = 0.06,           // fraction of cell taken by mortar gap
    rowOffset = 0.5,         // shift alternate rows by this fraction of a brick
    baseColor = '#a0584a',
    mortarColor = '#3a3a38',
    colorJitter = 0.18,
} = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Mortar background.
    ctx.fillStyle = mortarColor;
    ctx.fillRect(0, 0, size, size);

    const cellH = size / rows;
    const cellW = size / cols;
    const padX = cellW * mortar * 0.5;
    const padY = cellH * mortar * 0.5;

    const base = new THREE.Color(baseColor);
    // Hash → deterministic per-brick jitter so the level reloads identical.
    const jitter = (r, c) => {
        const h = ((r * 73856093) ^ (c * 19349663)) >>> 0;
        return (h / 0xffffffff) * 2 - 1; // -1..1
    };

    for (let r = 0; r < rows; r++) {
        const xOffset = (r % 2 === 0) ? 0 : cellW * rowOffset;
        // Draw one extra brick to cover the wrap when xOffset > 0.
        for (let c = -1; c <= cols; c++) {
            const x = c * cellW + xOffset + padX;
            const y = r * cellH + padY;
            const w = cellW - padX * 2;
            const h = cellH - padY * 2;
            if (x + w < 0 || x > size) continue;
            const j = jitter(r, c) * colorJitter;
            const col = base.clone().offsetHSL(0, 0, j);
            ctx.fillStyle = `#${col.getHexString()}`;
            ctx.fillRect(x, y, w, h);
        }
    }

    return { canvas, ctx, cellH, cellW, padX, padY, rows, cols, mortar, rowOffset };
}

function makeAlbedo(opts) {
    const { canvas } = drawBricks(opts);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
}

function makeHeight(opts) {
    // Build a height field where bricks = bright (high) and mortar = dark
    // (low). Same brick layout as the albedo so a single UV samples both.
    const size = opts.size || 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000'; // mortar = 0
    ctx.fillRect(0, 0, size, size);

    const rows = opts.rows || 6;
    const cols = opts.cols || 4;
    const mortar = opts.mortar ?? 0.06;
    const rowOffset = opts.rowOffset ?? 0.5;
    const cellH = size / rows;
    const cellW = size / cols;
    const padX = cellW * mortar * 0.5;
    const padY = cellH * mortar * 0.5;

    for (let r = 0; r < rows; r++) {
        const xOffset = (r % 2 === 0) ? 0 : cellW * rowOffset;
        for (let c = -1; c <= cols; c++) {
            const x = c * cellW + xOffset + padX;
            const y = r * cellH + padY;
            const w = cellW - padX * 2;
            const h = cellH - padY * 2;
            if (x + w < 0 || x > size) continue;
            // Soft bevel: bricks aren't square steps — they curve toward the
            // mortar. Gradient from bright center to mid-grey edge so POM
            // produces a believable bulge.
            const grad = ctx.createRadialGradient(
                x + w * 0.5, y + h * 0.5, Math.min(w, h) * 0.08,
                x + w * 0.5, y + h * 0.5, Math.max(w, h) * 0.7,
            );
            grad.addColorStop(0, '#ffffff');
            grad.addColorStop(1, '#404040');
            ctx.fillStyle = grad;
            ctx.fillRect(x, y, w, h);
        }
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 1; // Per POM plan: aniso on heightmaps hurts precision.
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
}

function makeNormal(heightTexture) {
    // Build a normal map from the height canvas via central-difference. Done
    // once on the CPU and uploaded; cheap because the height canvas is small.
    const src = heightTexture.image;
    const size = src.width;
    const srcCtx = src.getContext('2d');
    const srcData = srcCtx.getImageData(0, 0, size, size).data;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const out = ctx.createImageData(size, size);

    const at = (x, y) => {
        const xi = ((x % size) + size) % size;
        const yi = ((y % size) + size) % size;
        // Red channel of the height canvas is fine — we drew greyscale.
        return srcData[(yi * size + xi) * 4] / 255;
    };

    const strength = 4.0;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
            const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
            // Convert gradient to a unit normal in tangent space.
            const len = Math.sqrt(dx * dx + dy * dy + 1);
            const nx = -dx / len;
            const ny = -dy / len;
            const nz = 1 / len;
            const i = (y * size + x) * 4;
            out.data[i + 0] = Math.round((nx * 0.5 + 0.5) * 255);
            out.data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
            out.data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
            out.data[i + 3] = 255;
        }
    }
    ctx.putImageData(out, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
}

/**
 * Returns { albedo, normal, height } — three.js textures suitable for a
 * MeshStandardMaterial / DDGIMeshStandardNodeMaterial. The set is cached
 * per-`variant` key so repeated calls share GPU memory.
 *
 * Variants tune the brick layout for floor vs wall vs accent stripe usage.
 */
export function getBrickTextureSet(variant = 'wall') {
    const cached = cache.get(variant);
    if (cached) return cached;

    let opts;
    if (variant === 'floor') {
        opts = {
            size: 512, rows: 5, cols: 5, mortar: 0.04, rowOffset: 0.25,
            baseColor: '#7d6852', mortarColor: '#2e2a26', colorJitter: 0.12,
        };
    } else if (variant === 'accent') {
        opts = {
            size: 512, rows: 12, cols: 3, mortar: 0.05, rowOffset: 0.5,
            baseColor: '#cc8a4a', mortarColor: '#2a1a15', colorJitter: 0.22,
        };
    } else {
        // wall (default)
        opts = {
            size: 512, rows: 8, cols: 4, mortar: 0.06, rowOffset: 0.5,
            baseColor: '#a45a48', mortarColor: '#352e2a', colorJitter: 0.18,
        };
    }

    const albedo = makeAlbedo(opts);
    const height = makeHeight(opts);
    const normal = makeNormal(height);
    const set = { albedo, normal, height };
    cache.set(variant, set);
    return set;
}
