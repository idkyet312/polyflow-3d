// src/world/splat/depthSort.js
//
// Phase 3a — back-to-front depth sort, off-thread (Web Worker).
//
// Replaces the v0 main-thread Timsort + repack (~30-50 ms / 250 K splats)
// with a Worker that runs an LSD radix sort + optional NDC frustum cull.
// Main-thread cost per frame is now just the O(N) repack of typed arrays
// after the worker returns indices (~5 ms for 250 K) — the expensive
// O(N log N) sort step is gone.
//
// Why we still repack on main thread (and not switch the renderer to an
// instanceIndex-driven indirect read):
//   - Keeps splatRenderer.js and its TSL shaders untouched. The renderer's
//     existing splatPos/splatScale/splatColor/splatRot InstancedBufferAttributes
//     stay the source of truth; the worker's job is just deciding the
//     order they should appear in.
//   - The "right" answer for very-large scenes is GPU compute writing
//     directly to a storage buffer + an instanceIndex indirection in the
//     vertex shader. That's Phase 3b, where it pairs naturally with the
//     compute pipeline.
//   - The repack is bandwidth-bound (~14 MB / 250 K splats) and gets
//     coalesced into the same GPU upload that the depth-sorted result
//     already requires, so removing it in 3a wouldn't actually save much.
//
// Coalescing & latency:
//   - Worker has at most ONE in-flight request and ONE pending. Newer
//     pending overwrites older — only the latest camera state matters.
//   - End-to-end latency for sort result is 1-2 frames at 60 fps. This is
//     visually invisible: the user can't see a 16-32 ms ordering lag, but
//     they CAN see the wispy alpha streaks an unsorted frame produces.
//
// Camera-motion gate:
//   - We only fire sort requests when the camera has actually moved/rotated.
//     For a static camera, no postMessage at all (zero cost when idle).
//   - No time throttle: the gate already serializes through the in-flight
//     slot, so an aggressive consumer can't flood the worker.

import * as THREE from 'three';
import { SortClient } from './sortClient.js';

const DEFAULT_OPTS = {
    cameraMoveThreshold: 0.0001,   // squared world units; tiny — Worker is cheap so resort eagerly
    cameraRotThreshold:  0.99995,  // cos(angle); below this triggers re-sort (~0.5°)
    cullMargin:          1.5,      // NDC margin for frustum cull. 0 disables. >1 keeps off-screen-center splats.
    enableCull:          false,    // off by default in 3a — validate sort first, enable in a follow-up.
};

/**
 * Attach off-thread back-to-front depth sorting (and optional frustum cull)
 * to a splat mesh built by buildSplatMesh.
 *
 * @param {THREE.Mesh} mesh — splat mesh; must have splatPos/splatScale/splatColor/splatRot attributes.
 * @param {{count:number, positions:Float32Array, scales:Float32Array, colors:Float32Array, rotations:Float32Array}} splatData
 * @param {object} [opts]
 * @returns {() => void} disable function — restore the previous onBeforeRender and tear down the worker.
 */
export function attachDepthSort(mesh, splatData, opts = {}) {
    const { cameraMoveThreshold, cameraRotThreshold, cullMargin, enableCull } = { ...DEFAULT_OPTS, ...opts };
    const N = splatData.count;
    if (!N) return () => {};

    // Snapshot the unsorted source data on the MAIN thread. The renderer's
    // attribute typed arrays are the destination we repack into. We can't
    // share with the worker because we transferred a slice of positions
    // there — but the per-instance attribute arrays still live here.
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

    // Spin up the worker. Ship a fresh slice of positions to it (the
    // worker becomes the sole owner of that buffer).
    const sortClient = new SortClient();
    const positionsForWorker = srcPos.slice();   // separate buffer; main thread keeps srcPos
    sortClient.init(positionsForWorker, N);

    // Camera tracking
    let lastCamPos = null;
    const lastCamDir = new THREE.Vector3();

    const _camWorld   = new THREE.Vector3();
    const _camLocal   = new THREE.Vector3();
    const _camDirWld  = new THREE.Vector3();
    const _camDirLocal = new THREE.Vector3();
    const _invMatrix  = new THREE.Matrix4();
    const _modelMat   = new THREE.Matrix4();
    const _mvpLocal   = new THREE.Matrix4();
    const _camLocalA  = [0, 0, 0];
    const _camDirLocalA = [0, 0, 1];

    // Buffer for the latest unapplied sort result (set by the worker
    // callback, drained at the start of the next onBeforeRender so we
    // mutate buffer attributes only between frames).
    let pendingResult = null;     // { indices: Uint32Array, visibleCount: number, recycledBuffer: ArrayBuffer }

    const onSorted = (indices, visibleCount, recycledBuffer) => {
        // Stash; apply on the next frame's onBeforeRender.
        pendingResult = { indices, visibleCount, recycledBuffer };
    };

    const prevOnBeforeRender = mesh.onBeforeRender || function () {};

    mesh.onBeforeRender = function (renderer, scene, camera) {
        // 1. Always run the renderer's existing pre-render uniform updates.
        prevOnBeforeRender.call(this, renderer, scene, camera);

        // 2. Apply any sort result the worker has handed back since the
        //    previous frame. We do this BEFORE issuing a new request so
        //    the next request reflects the current camera, not a stale one.
        if (pendingResult) {
            const { indices, visibleCount, recycledBuffer } = pendingResult;
            pendingResult = null;

            const dstPos = attrPos.array;
            const dstSc  = attrSc.array;
            const dstCol = attrCol.array;
            const dstRot = attrRot.array;
            for (let i = 0; i < visibleCount; i++) {
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

            // If cull is on, instanceCount drops to the visible subset.
            // If cull is off, visibleCount === N and this is a no-op.
            mesh.geometry.instanceCount = visibleCount;

            // Ship the buffer back to the worker on the next request so it
            // doesn't have to allocate a fresh Uint32Array per frame.
            sortClient.recycle(recycledBuffer);
        }

        // 3. Camera-motion gate. If the camera hasn't moved meaningfully
        //    since the last request, don't fire one — the existing sort
        //    is still good and queueing redundant work just burns CPU.
        camera.getWorldPosition(_camWorld);
        camera.getWorldDirection(_camDirWld);

        if (lastCamPos !== null) {
            const moved   = _camWorld.distanceToSquared(lastCamPos) > cameraMoveThreshold;
            const rotated = _camDirWld.dot(lastCamDir) < cameraRotThreshold;
            if (!moved && !rotated) return;
        }

        // 4. Compute camera position in mesh-local space (so the worker
        //    can sort directly against the local-space positions it owns).
        _invMatrix.copy(this.matrixWorld).invert();
        _camLocal.copy(_camWorld).applyMatrix4(_invMatrix);
        _camDirLocal.copy(_camDirWld).transformDirection(_invMatrix).normalize();
        _camLocalA[0] = _camLocal.x;
        _camLocalA[1] = _camLocal.y;
        _camLocalA[2] = _camLocal.z;
        _camDirLocalA[0] = _camDirLocal.x;
        _camDirLocalA[1] = _camDirLocal.y;
        _camDirLocalA[2] = _camDirLocal.z;

        // 5. If cull is on, build local-space MVP: P * V * M.
        let mvpForWorker = null;
        if (enableCull && cullMargin > 0) {
            _modelMat.copy(this.matrixWorld);
            _mvpLocal.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(_modelMat);
            // Float32Array(16) — column-major copy of the 4x4.
            mvpForWorker = new Float32Array(_mvpLocal.elements);
        }

        sortClient.requestSort(_camLocalA, _camDirLocalA, mvpForWorker, enableCull ? cullMargin : 0, onSorted);

        if (!lastCamPos) lastCamPos = new THREE.Vector3();
        lastCamPos.copy(_camWorld);
        lastCamDir.copy(_camDirWld);
    };

    return function disableDepthSort() {
        mesh.onBeforeRender = prevOnBeforeRender;
        sortClient.dispose();
    };
}
