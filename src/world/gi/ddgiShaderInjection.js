import * as THREE from 'three';
import { Fn, vec2, vec3, vec4, float, texture, uniform, positionWorld, normalWorld, mix } from 'three/tsl';

/**
 * TSL irradiance sampler.
 *
 * Builds a node graph that:
 *   1. Looks up 8 surrounding probes via CPU-precomputed grid uniforms.
 *   2. Samples the irradiance atlas at octEncode(N) per probe.
 *   3. Trilinear-blends with backface weight cull.
 *
 * Phase D: minimal viable — single nearest probe + octEncode. Trilinear lands in Phase E.
 *
 * Returns a node that you add to material.emissiveNode (or whatever the chosen
 * injection slot is). Adding to emissive is the safest cross-material slot in
 * r184 WebGPU — bypasses indirect-lighting node graph quirks. Phase E switches
 * to a proper indirect-diffuse hook once we've validated the math.
 */

const OCT_TSL = `
fn octWrap(v: vec2<f32>) -> vec2<f32> {
    let s = vec2<f32>(select(-1.0, 1.0, v.x >= 0.0), select(-1.0, 1.0, v.y >= 0.0));
    return (vec2<f32>(1.0) - abs(v.yx)) * s;
}
fn octEncode(n_in: vec3<f32>) -> vec2<f32> {
    var n = normalize(n_in);
    n = n / (abs(n.x) + abs(n.y) + abs(n.z));
    var enc: vec2<f32>;
    if (n.z >= 0.0) {
        enc = n.xy;
    } else {
        enc = octWrap(n.xy);
    }
    return enc * 0.5 + vec2<f32>(0.5);
}
`;

/**
 * Build the DDGI sampler as a TSL function. Falls back to a no-op if any
 * required input is missing.
 */
export function createDDGISampler({ getAtlas, getGrid, getIntensity }) {
    // Uniforms refreshed each frame from manager state.
    const uAtlasSize = uniform(new THREE.Vector2(1, 1));
    const uTilesPerRow = uniform(1);
    const uTile = uniform(8);
    const uGutter = uniform(1);
    const uGridDims = uniform(new THREE.Vector3(1, 1, 1));
    const uGridAnchor = uniform(new THREE.Vector3());
    const uGridBoundsHalf = uniform(new THREE.Vector3());
    const uCellSize = uniform(1);
    const uIntensity = uniform(1);
    const uAtlasTex = uniform(null); // assigned each frame

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
        uAtlasTex.value = atlas.front.texture;
    }

    // The sampler node: simple nearest-probe lookup. Trilinear in Phase E.
    const sampleNode = Fn(() => {
        const wp = positionWorld;
        const n = normalWorld;

        // Compute fractional probe coord.
        const local = wp.sub(uGridAnchor).add(uGridBoundsHalf).div(uCellSize).sub(vec3(0.5));
        const ix = local.x.floor().clamp(0, uGridDims.x.sub(1));
        const iy = local.y.floor().clamp(0, uGridDims.y.sub(1));
        const iz = local.z.floor().clamp(0, uGridDims.z.sub(1));
        const idx = iz.mul(uGridDims.y).add(iy).mul(uGridDims.x).add(ix);

        // Atlas tile coord.
        const col = idx.mod(uTilesPerRow);
        const row = idx.div(uTilesPerRow).floor();
        const tilePx = uTile.add(uGutter.mul(2));
        const tileOriginX = col.mul(tilePx).add(uGutter);
        const tileOriginY = row.mul(tilePx).add(uGutter);

        // octEncode normal → tile uv → atlas uv.
        // Inline octEncode:
        const an = vec3(n.x.abs(), n.y.abs(), n.z.abs());
        const denom = an.x.add(an.y).add(an.z).max(1e-5);
        const nn = n.div(denom);
        const px = nn.x;
        const py = nn.y;
        // n.z >= 0 branch: enc = nn.xy
        // else: enc = octWrap(nn.xy)
        const wrapX = float(1).sub(py.abs()).mul(nn.x.sign());
        const wrapY = float(1).sub(px.abs()).mul(nn.y.sign());
        const useWrap = nn.z.lessThan(0);
        const encX = mix(px, wrapX, useWrap.float());
        const encY = mix(py, wrapY, useWrap.float());
        const oct = vec2(encX, encY).mul(0.5).add(0.5); // [0,1]

        const texX = tileOriginX.add(oct.x.mul(uTile));
        const texY = tileOriginY.add(oct.y.mul(uTile));
        const uvAtlas = vec2(texX, texY).div(uAtlasSize);

        const sampled = texture(uAtlasTex, uvAtlas).rgb;
        return sampled.mul(uIntensity);
    });

    return {
        node: sampleNode(),
        refreshUniforms,
    };
}

/**
 * Walks a root and patches MeshStandardMaterial / MeshPhysicalMaterial instances
 * to add DDGI irradiance to emissive. Materials are mutated in-place — under
 * WebGPURenderer they auto-promote to NodeMaterial variants and the emissiveNode
 * slot becomes active.
 */
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
                // Use `outputNode` add so the standard PBR pipeline computes
                // direct lighting + emissive + IBL normally, then we add the
                // DDGI bounce on top of the final fragment color. Crucially,
                // does NOT override the emissive uniform path.
                if (mat.outputNode) {
                    mat.outputNode = mat.outputNode.add(vec4(ddgiNode, 0));
                } else {
                    // colorNode runs before lighting in r184 — wrong slot for
                    // additive bounce. Skip if no outputNode available.
                    mat.userData._ddgiPatched = true;
                    continue;
                }
                mat.userData._ddgiPatched = true;
                mat.needsUpdate = true;
            } catch (e) {
                console.warn('[DDGI] material patch failed', mat, e);
            }
        }
    });
}
