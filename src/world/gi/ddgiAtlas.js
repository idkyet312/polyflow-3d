import * as THREE from 'three';
import { RenderTarget } from 'three/webgpu';

export const IRRADIANCE_TILE = 8;     // octahedral resolution per probe (irradiance)
export const VISIBILITY_TILE = 16;    // octahedral resolution per probe (visibility)
export const TILE_GUTTER = 1;

/**
 * Allocate a 2D RGBA16F atlas large enough for `count` probes at the given tile
 * size + 1 px gutter on each side. Probes are laid out left-to-right, top-down
 * with `tilesPerRow` per row.
 */
function tileWithGutter(tile) {
    return tile + TILE_GUTTER * 2;
}

export function atlasTexelDims(count, tile, tilesPerRow) {
    const t = tileWithGutter(tile);
    const rows = Math.ceil(count / tilesPerRow);
    return { w: tilesPerRow * t, h: rows * t, tile: t };
}

export function probeTileRect(index, tile, tilesPerRow) {
    const t = tileWithGutter(tile);
    const col = index % tilesPerRow;
    const row = (index / tilesPerRow) | 0;
    return {
        x: col * t + TILE_GUTTER,
        y: row * t + TILE_GUTTER,
        w: tile,
        h: tile,
    };
}

export function createAtlasPair({ probeCount, tile, tilesPerRow, format = THREE.RGBAFormat }) {
    const { w, h } = atlasTexelDims(probeCount, tile, tilesPerRow);
    const opts = {
        type: THREE.HalfFloatType,
        format,
        magFilter: THREE.LinearFilter,
        minFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
    };
    const a = new RenderTarget(w, h, opts);
    const b = new RenderTarget(w, h, opts);
    a.texture.colorSpace = THREE.LinearSRGBColorSpace;
    b.texture.colorSpace = THREE.LinearSRGBColorSpace;
    return {
        get width() { return w; },
        get height() { return h; },
        tilesPerRow,
        tile,
        front: a,
        back: b,
        swap() {
            const tmp = this.front;
            this.front = this.back;
            this.back = tmp;
        },
        dispose() {
            a.dispose();
            b.dispose();
        },
    };
}

/**
 * Pick a tilesPerRow that keeps the atlas roughly square.
 */
export function chooseTilesPerRow(count) {
    return Math.max(1, Math.ceil(Math.sqrt(count)));
}
