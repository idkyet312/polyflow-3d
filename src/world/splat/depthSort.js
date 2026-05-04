// src/world/splat/depthSort.js
//
// CPU back-to-front depth sorter for splat instances. Resolves the
// "splats render as individual streaks" appearance you get when alpha-blended
// translucent Gaussians are drawn in load order: with the wrong draw order,
// overlapping splats blend incorrectly and you see visible boundaries between
// each one. Sorting back-to-front per-frame makes the alpha math correct, which
// makes the result read as a coherent surface (the way SuperSplat / antimatter15
// / mkkellogg viewers render it).
//
// Approach:
//   - Snapshot the unsorted source attribute data on attach. This is the
//     canonical "input"; the mesh's attribute typed arrays are the "output"
//     that we sort INTO.
//   - Each frame, gated by a time + camera-motion threshold:
//       1. Compute splat→camera squared distance in mesh-local space
//          (cheaper than transforming each splat into world space).
//       2. Sort an index array by depth, far → near.
//       3. Repack the attribute typed arrays in sorted order and mark them
//          for re-upload (needsUpdate = true). The GPU buffer is reused.
//   - Wraps the mesh's existing onBeforeRender so the focal/viewport uniform
//     updates set by buildSplatMesh still run.
//
// Cost:
//   - O(N log N) JS sort on the main thread. ~30-50 ms for 250 K splats.
//     Throttled to once per ~150 ms of camera motion.
//   - Repack: O(N) typed-array writes. ~5 ms for 250 K splats.
//   - GPU re-upload: ~14 MB for 250 K splats. Bandwidth-bound, ~1 ms.
//
// When this becomes too slow (≥1 M splats, mobile), move the sort into a
// Web Worker (no main-thread block) or a WebGPU compute pass (Phase 3).

import * as THREE from 'three';

const DEFAULT_OPTS = {
    minIntervalMs:        100,    // min ms between sort runs
    cameraMoveThreshold:  0.25,   // squared world units before re-sort triggers
    cameraRotThreshold:   0.999,  // cos(angle); below this triggers re-sort (~2.5°)
};

/**
 * Attach back-to-front depth sorting to a splat mesh built by buildSplatMesh.
 *
 * @param {THREE.Mesh} mesh — splat mesh; must have splatPos/splatScale/splatColor/splatRot attributes.
 * @param {{count:number, positions:Float32Array, scales:Float32Array, colors:Float32Array, rotations:Float32Array}} splatData
 * @param {object} [opts]
 * @returns {() => void} disable function — restore the previous onBeforeRender.
 */
export function attachDepthSort(mesh, splatData, opts = {}) {
    const { minIntervalMs, cameraMoveThreshold, cameraRotThreshold } = { ...DEFAULT_OPTS, ...opts };
    const N = splatData.count;
    if (!N) return () => {};

    // Snapshot the unsorted source data. We sort INTO the mesh's attribute
    // typed arrays, so the GPU buffers never need re-allocation.
    const srcPos = splatData.positions.slice();
    const srcSc  = splatData.scales.slice();
    const srcCol = splatData.colors.slice();
    const srcRot = splatData.rotations.slice();

    const attrPos = mesh.geometry.getAttribute('splatPos');
    const attrSc  = mesh.geometry.getAttribute('splatScale');
    const attrCol = mesh.geometry.getAttribute('splatColor');
    const attrRot = mesh.geometry.getAttribute('splatRot');
    if (!attrPos || !attrSc || !attrCol || !attrRot) {
        console.warn('[splat-depthSort] mesh missing splat instance attributes; sort disabled.');
        return () => {};
    }

    // Scratch reused across sorts.
    const indices = new Array(N);
    const depths  = new Float32Array(N);

    // Camera tracking
    let lastSortMs = 0;
    let lastCamPos = null;
    const lastCamDir = new THREE.Vector3();

    const _camWorld  = new THREE.Vector3();
    const _camLocal  = new THREE.Vector3();
    const _camDirWld = new THREE.Vector3();
    const _invMatrix = new THREE.Matrix4();

    // Wrap any existing onBeforeRender (buildSplatMesh sets one for camera uniforms).
    const prevOnBeforeRender = mesh.onBeforeRender || function () {};

    mesh.onBeforeRender = function (renderer, scene, camera) {
        // Always run camera-uniform updates first.
        prevOnBeforeRender.call(this, renderer, scene, camera);

        const now = performance.now();
        camera.getWorldPosition(_camWorld);
        camera.getWorldDirection(_camDirWld);

        // Throttle: skip if it's been less than minIntervalMs AND the camera
        // hasn't moved/rotated meaningfully.
        if (lastCamPos !== null) {
            const moved   = _camWorld.distanceToSquared(lastCamPos) > cameraMoveThreshold;
            const rotated = _camDirWld.dot(lastCamDir) < cameraRotThreshold;
            if (now - lastSortMs < minIntervalMs && !moved && !rotated) return;
        }

        // Camera in mesh-local space (so we can compare directly against srcPos).
        // This implicitly accounts for the actor's transform — moving / rotating
        // the splat actor with a transform gizmo still produces correct sort.
        _invMatrix.copy(this.matrixWorld).invert();
        _camLocal.copy(_camWorld).applyMatrix4(_invMatrix);
        const cx = _camLocal.x, cy = _camLocal.y, cz = _camLocal.z;

        // Compute squared distances and reset indices.
        for (let i = 0; i < N; i++) {
            const dx = srcPos[i * 3]     - cx;
            const dy = srcPos[i * 3 + 1] - cy;
            const dz = srcPos[i * 3 + 2] - cz;
            depths[i]  = dx * dx + dy * dy + dz * dz;
            indices[i] = i;
        }

        // Sort: far → near. Alpha blending requires back-to-front for
        // standard `src*srcAlpha + dst*(1-srcAlpha)` to be correct.
        indices.sort(compareByDepthDesc);

        // Repack the destination attribute typed arrays in sorted order.
        const dstPos = attrPos.array;
        const dstSc  = attrSc.array;
        const dstCol = attrCol.array;
        const dstRot = attrRot.array;
        for (let i = 0; i < N; i++) {
            const src = indices[i];
            const di3 = i * 3,  si3 = src * 3;
            const di4 = i * 4,  si4 = src * 4;
            dstPos[di3]     = srcPos[si3];
            dstPos[di3 + 1] = srcPos[si3 + 1];
            dstPos[di3 + 2] = srcPos[si3 + 2];
            dstSc[di3]      = srcSc[si3];
            dstSc[di3 + 1]  = srcSc[si3 + 1];
            dstSc[di3 + 2]  = srcSc[si3 + 2];
            dstCol[di4]     = srcCol[si4];
            dstCol[di4 + 1] = srcCol[si4 + 1];
            dstCol[di4 + 2] = srcCol[si4 + 2];
            dstCol[di4 + 3] = srcCol[si4 + 3];
            dstRot[di4]     = srcRot[si4];
            dstRot[di4 + 1] = srcRot[si4 + 1];
            dstRot[di4 + 2] = srcRot[si4 + 2];
            dstRot[di4 + 3] = srcRot[si4 + 3];
        }

        attrPos.needsUpdate = true;
        attrSc.needsUpdate  = true;
        attrCol.needsUpdate = true;
        attrRot.needsUpdate = true;

        lastSortMs = now;
        if (!lastCamPos) lastCamPos = new THREE.Vector3();
        lastCamPos.copy(_camWorld);
        lastCamDir.copy(_camDirWld);
    };

    // Comparator factored out so V8 can inline / monomorphize it.
    function compareByDepthDesc(a, b) {
        return depths[b] - depths[a];
    }

    // Return a disable function so callers can detach the sort if they want
    // (e.g. while cycling through render-debug modes).
    return function disableDepthSort() {
        mesh.onBeforeRender = prevOnBeforeRender;
    };
}
