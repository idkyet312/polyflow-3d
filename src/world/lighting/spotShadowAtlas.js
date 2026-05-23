// Spot-light shadow atlas for the clustered-forward renderer.
//
// All shadow-casting spot lights share ONE depth atlas render target: the
// texture is split into a grid of square tiles, and each shadowed spot renders
// the scene's linear depth (distance from the spot, normalised 0..1) into its
// tile from the spot's point of view. The cluster shading loop then samples the
// atlas with the spot's stored view-projection matrix to test occlusion.
//
// We store LINEAR DISTANCE into a float color attachment (an "ESM/distance"
// shadow map) instead of sampling a hardware depth texture — simpler + portable
// in the TSL node path, and gives soft, bias-friendly comparisons.
//
// Per shadowed spot we store, in storage buffers read by the cluster loop:
//   • viewProj matrix (16 floats)
//   • atlas tile rect in UV space (vec4: u0,v0, uSize,vSize)
//   • near/far used for the linear normalisation (vec2)

import * as THREE from 'three';
import { RenderTarget, NodeMaterial } from 'three/webgpu';
import { Fn, positionView, vec4, uniform } from 'three/tsl';

const DEFAULT_ATLAS_SIZE = 2048;
const DEFAULT_TILE = 512;            // → 4×4 = 16 shadowed spots max at 2048

export function createSpotShadowAtlas({ atlasSize = DEFAULT_ATLAS_SIZE, tile = DEFAULT_TILE } = {}) {
    const tilesPerRow = Math.floor(atlasSize / tile);
    const maxTiles = tilesPerRow * tilesPerRow;

    // Float color atlas holding normalised linear distance (R channel). Its own
    // depth buffer is used for correct per-tile occlusion during the render.
    const atlas = new RenderTarget(atlasSize, atlasSize, {
        type: THREE.HalfFloatType,
        format: THREE.RedFormat,
        magFilter: THREE.LinearFilter,
        minFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: false,
    });
    atlas.texture.name = 'SpotShadowAtlas';

    // Override material: writes normalised linear distance (view-space depth /
    // far) into the red channel for whatever is being rendered into a tile.
    const uFar = uniform(1);
    const depthMaterial = new NodeMaterial();
    depthMaterial.colorNode = Fn(() => {
        const d = positionView.z.negate().div(uFar).clamp(0, 1);  // 0 near → 1 far
        return vec4(d, d, d, 1);
    })();
    depthMaterial.fragmentNode = null;
    // Make it depth-correct + cheap.
    depthMaterial.depthTest = true;
    depthMaterial.depthWrite = true;

    // Per-spot shadow camera (reused).
    const shadowCam = new THREE.PerspectiveCamera();

    // Storage for matrices/rects (plain arrays uploaded into the cluster system).
    const _vp = new THREE.Matrix4();
    const _lookTmp = new THREE.Vector3();

    function tileRect(slot) {
        const col = slot % tilesPerRow;
        const row = (slot / tilesPerRow) | 0;
        return { x: col * tile, y: row * tile, w: tile, h: tile,
            u0: (col * tile) / atlasSize, v0: (row * tile) / atlasSize,
            uSize: tile / atlasSize, vSize: tile / atlasSize };
    }

    // Render each shadowed spot's depth into its tile.
    //   spots: array of { light, slot }  (slot = atlas tile index)
    //   onMatrix(slot, viewProjArray16, rect, near, far): store for the loop
    function render(renderer, scene, spots, onMatrix) {
        if (!spots.length) return;
        const prevTarget = renderer.getRenderTarget();
        const prevOverride = scene.overrideMaterial;
        const prevAutoClear = renderer.autoClear;
        const prevScissorTest = renderer.getScissorTest?.();

        renderer.setRenderTarget(atlas);
        renderer.autoClear = false;
        // Clear the whole atlas to far (1.0) once.
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, atlasSize, atlasSize);
        renderer.setClearColor(0xffffff, 1);
        renderer.clear(true, true, false);

        scene.overrideMaterial = depthMaterial;
        renderer.setScissorTest(true);

        for (const { light, slot } of spots) {
            if (slot < 0 || slot >= maxTiles) continue;
            const r = tileRect(slot);

            // Configure the shadow camera from the spot cone.
            const far = (light.distance > 0 ? light.distance : 200);
            const near = Math.max(0.1, far * 0.01);
            shadowCam.fov = THREE.MathUtils.radToDeg(Math.min(Math.PI - 0.01, light.angle * 2));
            shadowCam.aspect = 1;
            shadowCam.near = near;
            shadowCam.far = far;
            light.getWorldPosition(shadowCam.position);
            light.target.getWorldPosition(_lookTmp);
            shadowCam.lookAt(_lookTmp);
            shadowCam.updateMatrixWorld(true);
            shadowCam.updateProjectionMatrix();

            uFar.value = far;

            // Render this spot's view into its tile.
            renderer.setViewport(r.x, r.y, r.w, r.h);
            renderer.setScissor(r.x, r.y, r.w, r.h);
            renderer.clear(true, true, false);   // clear this tile's color+depth to far
            renderer.render(scene, shadowCam);

            // Store viewProj + rect for the cluster loop.
            _vp.multiplyMatrices(shadowCam.projectionMatrix, shadowCam.matrixWorldInverse);
            onMatrix(slot, _vp.elements, r, near, far);
        }

        // Restore renderer state.
        scene.overrideMaterial = prevOverride;
        renderer.setScissorTest(!!prevScissorTest);
        renderer.autoClear = prevAutoClear;
        renderer.setRenderTarget(prevTarget);
    }

    return {
        atlas,
        texture: atlas.texture,
        tilesPerRow,
        maxTiles,
        tile,
        atlasSize,
        render,
        dispose() { atlas.dispose(); depthMaterial.dispose(); },
    };
}
