import * as THREE from 'three';
import { DEPTH_RANGE, OCT_PAD, OCT_RES, OCT_RES_P, OCT_TEXELS } from './ddgiRTCompute.js';
import { chooseTilesPerRow } from './ddgiAtlas.js';

export function createDDGIAtlasTexture({ probeCount }) {
    const safeProbeCount = Math.max(1, probeCount | 0);
    const tilesPerRow = chooseTilesPerRow(safeProbeCount);
    const rowCount = Math.max(1, Math.ceil(safeProbeCount / tilesPerRow));
    const width = tilesPerRow * OCT_RES_P;
    const height = rowCount * OCT_RES_P;
    const data = new Float32Array(width * height * 4);
    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.LinearSRGBColorSpace;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;

    const depthMean = new Array(probeCount).fill(DEPTH_RANGE);
    const depthMeanSq = new Array(probeCount).fill(DEPTH_RANGE * DEPTH_RANGE);
    const probeTrapped = new Array(probeCount).fill(0);

    function clear() {
        data.fill(0);
        depthMean.fill(DEPTH_RANGE);
        depthMeanSq.fill(DEPTH_RANGE * DEPTH_RANGE);
        probeTrapped.fill(0);
        texture.needsUpdate = true;
    }

    function updateFromReadback({ oct, depth }) {
        if (!oct || !depth) return;
        for (let p = 0; p < probeCount; p++) {
            const srcProbe = p * OCT_TEXELS * 4;
            const dstProbeCol = p % tilesPerRow;
            const dstProbeRow = (p / tilesPerRow) | 0;
            const dstProbeX = dstProbeCol * OCT_RES_P;
            const dstProbeY = dstProbeRow * OCT_RES_P;
            for (let y = 0; y < OCT_RES_P; y++) {
                const srcOff = srcProbe + y * OCT_RES_P * 4;
                const dstOff = ((dstProbeY + y) * width + dstProbeX) * 4;
                data.set(oct.subarray(srcOff, srcOff + OCT_RES_P * 4), dstOff);
            }
            depthMean[p] = depth[p * 4 + 0] || DEPTH_RANGE;
            depthMeanSq[p] = depth[p * 4 + 1] || DEPTH_RANGE * DEPTH_RANGE;
            const target = depth[p * 4 + 3] > 0.5 ? 1 : 0;
            probeTrapped[p] = probeTrapped[p] * 0.8 + target * 0.2;
        }
        texture.needsUpdate = true;
    }

    return {
        width,
        height,
        tile: OCT_RES,
        gutter: OCT_PAD,
        tilesPerRow,
        probeCount,
        data,
        texture,
        depthMean,
        depthMeanSq,
        probeTrapped,
        front: { texture },
        back: { texture },
        clear,
        updateFromReadback,
        dispose() {
            texture.dispose();
        },
    };
}
