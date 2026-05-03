import * as THREE from 'three';
import { Fn, vec2, vec3, vec4, float, texture, uniform, positionWorld, normalWorld, output } from 'three/tsl';

function createBlackTexture() {
    const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
}

/**
 * TSL irradiance sampler.
 *
 * Builds a node graph that:
 *   1. Biases sample position along the surface normal.
 *   2. Looks up the 8 surrounding probes.
 *   3. Samples each probe's octahedral irradiance tile.
 *   4. Trilinear blends the result.
 */

export function createDDGISampler({ getAtlas, getGrid, getIntensity, getNormalBias }) {
    const uAtlasSize = uniform(new THREE.Vector2(1, 1));
    const uTilesPerRow = uniform(1);
    const uTile = uniform(8);
    const uGutter = uniform(1);
    const uGridDims = uniform(new THREE.Vector3(1, 1, 1));
    const uGridAnchor = uniform(new THREE.Vector3());
    const uGridBoundsHalf = uniform(new THREE.Vector3());
    const uCellSize = uniform(1);
    const uIntensity = uniform(1);
    const uNormalBias = uniform(0);
    const atlasTex = texture(createBlackTexture());

    function refreshUniforms() {
        const grid = getGrid?.();
        const atlas = getAtlas?.();
        const intensity = getIntensity?.() ?? 1.0;
        if (!grid || !atlas) {
            uIntensity.value = 0.0;
            return;
        }
        uAtlasSize.value.set(atlas.width, atlas.height);
        uTilesPerRow.value = atlas.tilesPerRow;
        uTile.value = atlas.tile;
        uGridDims.value.set(grid.dims.x, grid.dims.y, grid.dims.z);
        uGridAnchor.value.copy(grid.anchor);
        uGridBoundsHalf.value.set(grid.bounds.x * 0.5, grid.bounds.y * 0.5, grid.bounds.z * 0.5);
        uCellSize.value = grid.cellSize;
        uIntensity.value = intensity;
        uNormalBias.value = getNormalBias?.() ?? 0;
        atlasTex.value = atlas.front.texture;
    }

    const sampleNode = Fn(() => {
        const n = normalWorld;
        const wp = positionWorld.add(n.mul(uNormalBias));

        const local = wp.sub(uGridAnchor).add(uGridBoundsHalf).div(uCellSize).sub(vec3(0.5));
        const lx = local.x.clamp(0, uGridDims.x.sub(1));
        const ly = local.y.clamp(0, uGridDims.y.sub(1));
        const lz = local.z.clamp(0, uGridDims.z.sub(1));
        const ix0 = lx.floor();
        const iy0 = ly.floor();
        const iz0 = lz.floor();
        const ix1 = ix0.add(1).clamp(0, uGridDims.x.sub(1));
        const iy1 = iy0.add(1).clamp(0, uGridDims.y.sub(1));
        const iz1 = iz0.add(1).clamp(0, uGridDims.z.sub(1));
        const fx = lx.sub(ix0);
        const fy = ly.sub(iy0);
        const fz = lz.sub(iz0);
        const wx0 = float(1).sub(fx);
        const wy0 = float(1).sub(fy);
        const wz0 = float(1).sub(fz);

        const an = vec3(n.x.abs(), n.y.abs(), n.z.abs());
        const denom = an.x.add(an.y).add(an.z).max(1e-5);
        const nn = n.div(denom);
        const px = nn.x;
        const py = nn.y;
        const wrapX = float(1).sub(py.abs()).mul(nn.x.sign());
        const wrapY = float(1).sub(px.abs()).mul(nn.y.sign());
        const useWrap = nn.z.lessThan(0);
        const encX = useWrap.select(wrapX, px);
        const encY = useWrap.select(wrapY, py);
        const oct = vec2(encX, encY).mul(0.5).add(0.5);

        const probeIndex = (ix, iy, iz) => iz.mul(uGridDims.y).add(iy).mul(uGridDims.x).add(ix);
        const sampleProbe = (idx) => {
            const col = idx.mod(uTilesPerRow);
            const row = idx.div(uTilesPerRow).floor();
            const tilePx = uTile.add(uGutter.mul(2));
            const tileOriginX = col.mul(tilePx).add(uGutter);
            const tileOriginY = row.mul(tilePx).add(uGutter);
            const texX = tileOriginX.add(float(0.5)).add(oct.x.mul(uTile.sub(1)));
            const texY = tileOriginY.add(float(0.5)).add(oct.y.mul(uTile.sub(1)));
            return atlasTex.sample(vec2(texX, texY).div(uAtlasSize)).rgb;
        };

        const c000 = sampleProbe(probeIndex(ix0, iy0, iz0)).mul(wx0.mul(wy0).mul(wz0));
        const c100 = sampleProbe(probeIndex(ix1, iy0, iz0)).mul(fx.mul(wy0).mul(wz0));
        const c010 = sampleProbe(probeIndex(ix0, iy1, iz0)).mul(wx0.mul(fy).mul(wz0));
        const c110 = sampleProbe(probeIndex(ix1, iy1, iz0)).mul(fx.mul(fy).mul(wz0));
        const c001 = sampleProbe(probeIndex(ix0, iy0, iz1)).mul(wx0.mul(wy0).mul(fz));
        const c101 = sampleProbe(probeIndex(ix1, iy0, iz1)).mul(fx.mul(wy0).mul(fz));
        const c011 = sampleProbe(probeIndex(ix0, iy1, iz1)).mul(wx0.mul(fy).mul(fz));
        const c111 = sampleProbe(probeIndex(ix1, iy1, iz1)).mul(fx.mul(fy).mul(fz));

        return c000.add(c100).add(c010).add(c110).add(c001).add(c101).add(c011).add(c111).mul(uIntensity);
    });

    return {
        node: sampleNode(),
        refreshUniforms,
    };
}

export function patchMaterials(root, ddgiNode) {
    if (!root) return;
    root.traverse((obj) => {
        if (!obj.isMesh) return;
        if (obj.userData?.ddgiSkipReceive) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
            if (!mat || mat.userData?._ddgiPatched) continue;
            if (!(mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial)) continue;
            try {
                if (mat.outputNode) {
                    mat.outputNode = mat.outputNode.add(vec4(ddgiNode, 0));
                } else {
                    // Add after the standard lighting path. This keeps DDGI out
                    // of emissiveNode, so bloom does not treat bounce as glow.
                    mat.outputNode = output.add(vec4(ddgiNode, 0));
                }
                mat.userData._ddgiPatched = true;
                mat.needsUpdate = true;
            } catch (e) {
                console.warn('[DDGI] material patch failed', mat, e);
            }
        }
    });
}
