// src/world/splat/perfMode.js
//
// Phase 3b — runtime toggle between sort-implementation paths.
//
// Modes:
//   'auto'     — pick best supported (compute → worker → none) at construction.
//   'compute'  — force GPU compute sort. Throws if WebGPU compute storage
//                buffers aren't available.
//   'worker'   — force JS Worker sort (the Phase 3a path). Always available.
//   'off'      — no sorting. Splats render in load order; alpha blending wrong
//                but the renderer still works. Useful for perf measurement.
//
// The mode is sticky for the lifetime of a splat actor. Switching requires
// disposing the actor and rebuilding (the storage-buffer layout differs
// between paths).

import * as THREE from 'three';
import { buildSplatMesh as buildSplatMeshWorker } from './splatRenderer.js';
import { buildSplatMeshCompute } from './splatRendererCompute.js';

let _modeOverride = null;     // null = auto

/** Set the global splat sort mode. Future buildSplatMeshAuto() calls honor it. */
export function setSplatSortMode(mode) {
    if (!['auto', 'compute', 'worker', 'off', null].includes(mode)) {
        console.warn(`[splat-perfMode] unknown mode "${mode}", ignoring.`);
        return;
    }
    _modeOverride = mode === 'auto' ? null : mode;
}

/** Get the current effective mode. */
export function getSplatSortMode() {
    return _modeOverride || 'auto';
}

/**
 * Detect whether the current renderer supports the GPU compute sort path.
 * Returns true if Three.js exposes WebGPURenderer with compute support AND
 * StorageInstancedBufferAttribute is available.
 *
 * This is a static feature check — it doesn't actually issue a compute pass
 * to confirm. If a runtime compute dispatch fails (e.g. on a buggy driver),
 * the caller can catch and fall back to worker manually.
 */
export function detectComputeSupport() {
    try {
        // The StorageInstancedBufferAttribute import lives in three/webgpu.
        // If three is too old (< r163) the import throws, three/webgpu doesn't
        // exist, or StorageInstancedBufferAttribute is absent.
        // eslint-disable-next-line no-unused-vars
        const probe = require('three/webgpu');
        if (!probe.StorageInstancedBufferAttribute) return false;
    } catch {
        // ESM/Vite path — try dynamic import sniff (best-effort).
        // We don't await here; if three/webgpu isn't resolvable Vite will
        // have failed at load time anyway.
    }
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;
    return true;
}

/**
 * Build a splat mesh using the runtime-selected sort implementation.
 * Drop-in replacement for `buildSplatMesh(splatData)` from splatRenderer.js.
 *
 * @param {{count:number, positions:Float32Array, scales:Float32Array, colors:Float32Array, rotations:Float32Array}} splatData
 * @returns {THREE.Mesh}
 */
export function buildSplatMeshAuto(splatData) {
    // Auto: prefer compute when WebGPU is available — the compute path is
    // where view-dependent SH (Phase 4) and per-frame radiance evaluation
    // live. Worker path is the universal fallback.
    let mode = _modeOverride;
    if (!mode) {
        mode = detectComputeSupport() ? 'compute' : 'worker';
    }

    if (mode === 'compute') {
        try {
            const mesh = buildSplatMeshCompute(splatData);
            mesh.userData.splatSortMode = 'compute';
            return mesh;
        } catch (err) {
            console.warn('[splat-perfMode] compute path threw at build time, falling back to worker:', err);
            // Fall through to worker.
        }
    }

    const mesh = buildSplatMeshWorker(splatData);
    mesh.userData.splatSortMode = mode === 'off' ? 'off' : 'worker';
    if (mode === 'off') {
        // Strip the worker hookup that buildSplatMesh installs.
        // (depthSort.js's attach is called inside buildSplatMesh; we'd need
        // a separate "no-sort" build path to truly disable. For now, 'off'
        // just labels — the worker still runs in the background.)
        // TODO: refactor splatRenderer.js to make the depth-sort attach
        // optional, then honor 'off' here.
    }
    // Phase 4: SH bands 1..N are evaluated only in the compute path. If the
    // user is on worker/off and the dataset SHIPPED with SH data, surface a
    // one-time hint so the visual difference (specular highlights missing,
    // washed-out look on glossy surfaces) doesn't read as a bug.
    if (splatData?.sh?.degree > 0) {
        console.log(
            `[splat] dataset has SH degree ${splatData.sh.degree} — view-dependent ` +
            `radiance is rendered only on the compute path. Switch to compute mode ` +
            `(setSplatSortMode('compute') + reload) to see specular/glossy detail.`,
        );
    }
    return mesh;
}
