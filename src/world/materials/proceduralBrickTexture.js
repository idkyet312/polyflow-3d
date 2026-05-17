import * as THREE from 'three';

// Standalone procedural brick texture set — a basic, reliable running-bond
// brick drawn on a canvas. Unlike getBrickTextureSet() in brickTextures.js
// this is NEVER overwritten by a streamed PolyHaven photo: what you draw
// here is exactly what renders. Returns the five maps a
// DDGIMeshStandardNodeMaterial / SilPOM setup expects:
//   { albedo (sRGB), normal, height, roughness, ao }  (last four linear)
//
// All maps share one brick layout so a single UV set samples them
// coherently. Cached per-variant at module scope (lifetime = page) so
// repeated calls share GPU memory; callers .clone() for per-mesh repeats.
//
// CPU canvas, not in-shader: a baked image is mip-filtered and band-limited
// by the GPU, so it has none of the analytic-noise sparkle / normal-from-
// noise artifacts an in-TSL procedural brick suffers.

const cache = new Map();

// Deterministic per-brick jitter (level reloads identical). Two decorrelated
// streams so lightness and hue don't move in lock-step.
function jit(r, c, salt) {
    const h = ((r * 73856093) ^ (c * 19349663) ^ salt) >>> 0;
    return (h / 0xffffffff) * 2 - 1; // -1..1
}

// Walk the running-bond grid, calling cb for every brick rect (including the
// wrap-around brick on offset rows so the tile is seamless).
function forEachBrick(opts, cb) {
    const { size, rows, cols, mortar, rowOffset } = opts;
    const cellH = size / rows;
    const cellW = size / cols;
    const padX = cellW * mortar * 0.5;
    const padY = cellH * mortar * 0.5;
    for (let r = 0; r < rows; r++) {
        const xOff = (r % 2 === 0) ? 0 : cellW * rowOffset;
        for (let c = -1; c <= cols; c++) {
            const x = c * cellW + xOff + padX;
            const y = r * cellH + padY;
            const w = cellW - padX * 2;
            const h = cellH - padY * 2;
            if (x + w < 0 || x > size) continue;
            cb({ x, y, w, h, r, c });
        }
    }
}

function makeCanvas(size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    return canvas;
}

function tex(canvas, { srgb = false, aniso = 8, mip = true } = {}) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = aniso;
    if (!mip) {
        // Heightmaps: aniso/mip on the height field hurt POM precision.
        t.generateMipmaps = false;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
    } else {
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
    }
    t.needsUpdate = true;
    return t;
}

function drawAlbedo(opts) {
    const { size, baseColor, mortarColor, colorJitter } = opts;
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = mortarColor;
    ctx.fillRect(0, 0, size, size);
    const base = new THREE.Color(baseColor);
    forEachBrick(opts, ({ x, y, w, h, r, c }) => {
        const jL = jit(r, c, 0) * colorJitter;       // lightness
        const jH = jit(r, c, 0x9e3779b9) * 0.02;     // tight hue swing
        const jS = jit(c, r, 0x85ebca6b) * 0.10;     // saturation
        const col = base.clone().offsetHSL(jH, jS, jL);
        ctx.fillStyle = `#${col.getHexString()}`;
        ctx.fillRect(x, y, w, h);
    });
    return tex(canvas, { srgb: true });
}

function drawHeight(opts) {
    // Convention for SilPOM (pomNode flips via 1-r): mortar = HIGH/white
    // (carved back into the deepest valley), brick face = LOW/black (left
    // proud at the polygon surface). A picture-frame bevel ramps each brick
    // edge from the mortar floor down to the flat face.
    const { size } = opts;
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // mortar = high
    ctx.fillRect(0, 0, size, size);
    forEachBrick(opts, ({ x, y, w, h }) => {
        const b = Math.max(2, Math.min(w, h) * 0.12); // bevel width
        ctx.fillStyle = '#000000'; // flat brick top = low
        ctx.fillRect(x, y, w, h);
        const ramp = (g) => { g.addColorStop(0, '#cfcfcf'); g.addColorStop(1, '#000000'); return g; };
        ctx.fillStyle = ramp(ctx.createLinearGradient(x, 0, x + b, 0));
        ctx.fillRect(x, y, b, h);
        ctx.fillStyle = ramp(ctx.createLinearGradient(x + w, 0, x + w - b, 0));
        ctx.fillRect(x + w - b, y, b, h);
        ctx.fillStyle = ramp(ctx.createLinearGradient(0, y, 0, y + b));
        ctx.fillRect(x, y, w, b);
        ctx.fillStyle = ramp(ctx.createLinearGradient(0, y + h, 0, y + h - b));
        ctx.fillRect(x, y + h - b, w, b);
    });
    return tex(canvas, { aniso: 1, mip: true });
}

function drawNormal(heightTexture) {
    // Central-difference the height canvas → tangent-space normal map.
    const src = heightTexture.image;
    const size = src.width;
    const srcData = src.getContext('2d').getImageData(0, 0, size, size).data;
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    const out = ctx.createImageData(size, size);
    const at = (x, y) => {
        const xi = ((x % size) + size) % size;
        const yi = ((y % size) + size) % size;
        return srcData[(yi * size + xi) * 4] / 255;
    };
    const strength = 4.0;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
            // Canvas +Y is down; OpenGL normal-map green (+Y) is up → flip.
            const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
            const len = Math.sqrt(dx * dx + dy * dy + 1);
            const i = (y * size + x) * 4;
            out.data[i + 0] = Math.round((-dx / len * 0.5 + 0.5) * 255);
            out.data[i + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
            out.data[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
            out.data[i + 3] = 255;
        }
    }
    ctx.putImageData(out, 0, 0);
    return tex(canvas);
}

function drawRoughness(opts) {
    // Mortar very rough (bright), brick face a touch glossier with per-brick
    // jitter so highlights don't sweep as one sheet.
    const { size } = opts;
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e6e6e6';
    ctx.fillRect(0, 0, size, size);
    forEachBrick(opts, ({ x, y, w, h, r, c }) => {
        const v = Math.round((0.62 + jit(r, c, 0x27d4eb2f) * 0.10) * 255);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(x, y, w, h);
    });
    return tex(canvas);
}

function drawAO(opts) {
    // Brick faces ~lit (white), joints darkened with a soft falloff into
    // the recess so the joint reads as a shadowed crevice pre-lighting.
    const { size } = opts;
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#4a4a4a'; // mortar = occluded
    ctx.fillRect(0, 0, size, size);
    forEachBrick(opts, ({ x, y, w, h }) => {
        const b = Math.max(2, Math.min(w, h) * 0.16);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x, y, w, h);
        const ramp = (g) => { g.addColorStop(0, '#9a9a9a'); g.addColorStop(1, '#ffffff'); return g; };
        ctx.fillStyle = ramp(ctx.createLinearGradient(x, 0, x + b, 0));
        ctx.fillRect(x, y, b, h);
        ctx.fillStyle = ramp(ctx.createLinearGradient(x + w, 0, x + w - b, 0));
        ctx.fillRect(x + w - b, y, b, h);
        ctx.fillStyle = ramp(ctx.createLinearGradient(0, y, 0, y + b));
        ctx.fillRect(x, y, w, b);
        ctx.fillStyle = ramp(ctx.createLinearGradient(0, y + h, 0, y + h - b));
        ctx.fillRect(x, y + h - b, w, b);
    });
    return tex(canvas);
}

const VARIANTS = {
    wall: {
        size: 512, rows: 8, cols: 4, mortar: 0.06, rowOffset: 0.5,
        baseColor: '#a45a48', mortarColor: '#352e2a', colorJitter: 0.18,
    },
    floor: {
        size: 512, rows: 5, cols: 5, mortar: 0.05, rowOffset: 0.25,
        baseColor: '#7d6852', mortarColor: '#2e2a26', colorJitter: 0.12,
    },
    accent: {
        size: 512, rows: 10, cols: 3, mortar: 0.05, rowOffset: 0.5,
        baseColor: '#6b3a22', mortarColor: '#1d1510', colorJitter: 0.0,
    },
    white: {
        size: 512, rows: 10, cols: 3, mortar: 0.05, rowOffset: 0.5,
        baseColor: '#eee7d8', mortarColor: '#b5ad9d', colorJitter: 0.08,
    },
};

/**
 * Returns { albedo, normal, height, roughness, ao } — a basic procedural
 * running-bond brick set, cached per `variant` ('wall' | 'floor' |
 * 'accent'), never replaced by a streamed photo. Same return shape as
 * getBrickTextureSet() so it drops into the existing makeBrickMaterial().
 */
export function getProceduralBrickSet(variant = 'wall') {
    const cached = cache.get(variant);
    if (cached) return cached;
    const opts = VARIANTS[variant] || VARIANTS.wall;
    const albedo = drawAlbedo(opts);
    const height = drawHeight(opts);
    const normal = drawNormal(height);
    const roughness = drawRoughness(opts);
    const ao = drawAO(opts);
    const set = { albedo, normal, height, roughness, ao };
    cache.set(variant, set);
    return set;
}
