// src/world/splat/gpuSortBitonic.js
//
// Phase 3b — GPU back-to-front depth sort via TSL compute (bitonic).
//
// Replaces the Phase 3a Worker sort path when the renderer is WebGPU-capable.
// Same `attach...` signature as depthSort.js — drop-in.
//
// Why bitonic, not the LSD radix used by web-splat:
//   - Radix needs workgroup-shared atomics + decoupled-lookback prefix scan
//     (web-splat's `radix_sort.wgsl` is 22.6 KB of WGSL). Porting that to TSL
//     is a multi-day exercise and risks subtle TSL-specific atomic bugs.
//   - Bitonic is O(N·log²N) work but ENTIRELY data-parallel: every dispatch
//     is a flat compare-swap, no shared memory, no atomics, no inter-workgroup
//     coordination. ~150 lines of TSL total.
//   - At 1.5M splats: log²N ≈ 441 stages, ~750K compare-swaps each. On a
//     mid-range discrete GPU that's ~1-3 ms total — already 10-30× faster
//     than the JS Worker path's 30-50 ms (and frees the worker, an Origin-
//     trial-only API on some targets).
//   - When we want the last 30% perf, we swap the kernel for radix in a
//     follow-up. The integration surface (sortedIndices storage buffer)
//     stays identical, so it's a one-file replacement.
//
// Pipeline shape:
//   Per frame, in onBeforeRender:
//     1. Update camera-derived uniforms (camLocal, mvpLocal).
//     2. Run buildKeys compute pass (1 dispatch, ⌈N_pad/256⌉ workgroups):
//          - Each thread reads positions[i], computes view-space depth.
//          - Encodes key = bitcast<u32>(depth + bias) — bias keeps depths
//            positive so unsigned radix ordering = float ordering.
//          - For padding indices (i >= N), writes sentinel 0xFFFFFFFFu so
//            phantom slots sort to the tail and never render.
//          - Initializes sortedIndices[i] = i (identity permutation).
//     3. Run bitonic stages (K · J dispatches, each ⌈N_pad/2/256⌉ workgroups):
//          - Standard bitonic stage indexing: for stage K (sorted block size)
//            and substage J (compare distance), each thread t computes
//            (i, j) = bitonic_pair(t, J), then compare-swaps (key, idx) at
//            (i, j) with direction determined by t & K.
//     4. Vertex shader reads splatPos[sortedIndices[instanceIndex]] etc.
//        (See splatRendererCompute.js for the indirection.)
//
// Result: sortedIndices[0] = nearest splat, sortedIndices[N-1] = farthest.
// Render front-to-back with `ONE_MINUS_DST_ALPHA / ONE` blend (web-splat's
// approach), OR back-to-front with NormalBlending (the path the existing
// renderer is already wired for — keep that for compatibility).
//
// API stability:
//   `attachGpuSort(mesh, splatData, opts)` returns a `disable` function.
//   Same signature as `attachDepthSort`. depthSort.js or perfMode.js picks
//   which one to attach based on the runtime mode.

import * as THREE from 'three';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import {
    Fn, instanceIndex, uniform, storage,
    uint, float, vec3, vec4, mat4,
    If, abs, max,
} from 'three/tsl';

const WORKGROUP_SIZE = 256;

// ---------------------------------------------------------------------------
// nextPow2 — bitonic sort works on power-of-2-length arrays. We pad with
// sentinel keys (0xFFFFFFFFu) so phantoms always sort to the end.
// ---------------------------------------------------------------------------
function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

/**
 * Attach a GPU-side back-to-front depth sort to a splat mesh.
 *
 * The mesh MUST have been built with splatRendererCompute.buildSplatMeshCompute
 * (or any builder that exposes positionsStorage + sortedIndicesStorage on
 * mesh.userData.splat). The vertex shader is expected to fetch instance data
 * via `instanceIndex → sortedIndices[instanceIndex] → splat[that_index]`.
 *
 * @param {THREE.Mesh} mesh — splat mesh with userData.splat.{ positionsStorage, sortedIndicesStorage, sortKeysStorage, count }
 * @param {{count:number}} splatData
 * @param {{ resortGate?: { moveSq: number, cosAngle: number } }} [opts]
 * @returns {() => void} disable function
 */
export function attachGpuSort(mesh, splatData, opts = {}) {
    const N = splatData.count | 0;
    if (!N) return () => {};

    const slot = mesh.userData?.splat;
    if (!slot || !slot.positionsStorage || !slot.sortedIndicesStorage || !slot.sortKeysStorage) {
        console.warn('[splat-gpuSort] mesh.userData.splat missing required storage buffers; sort disabled.');
        return () => {};
    }

    const N_pad = nextPow2(N);
    const moveSq  = opts.resortGate?.moveSq  ?? 0.0001;
    const cosAng  = opts.resortGate?.cosAngle ?? 0.99995;

    // -----------------------------------------------------------------------
    // Uniforms refreshed each frame in onBeforeRender.
    // -----------------------------------------------------------------------
    const uModelView = uniform(new THREE.Matrix4());     // mat4 (view * model)
    const uStageK    = uniform(0);                       // uint  bitonic outer K
    const uStageJ    = uniform(0);                       // uint  bitonic inner J

    // -----------------------------------------------------------------------
    // Pass 1: buildKeys compute kernel.
    // For each i in [0, N_pad):
    //   - if i < N: read pos, compute view-space depth, encode key.
    //   - else: key = sentinel (0xFFFFFFFFu).
    //   - sortedIndices[i] = i.
    // -----------------------------------------------------------------------
    // Wrap the StorageInstancedBufferAttribute objects with TSL storage()
    // nodes so they can be indexed/assigned inside a kernel. The wrapping
    // is per-kernel (Three.js may bind them to different bind groups for
    // each compute pipeline).
    const positionsNode     = storage(slot.positionsStorage,     'vec3');
    const sortKeysNodeBK    = storage(slot.sortKeysStorage,      'uint');
    const sortedIndicesBK   = storage(slot.sortedIndicesStorage, 'uint');

    const buildKeys = Fn(() => {
        const i = instanceIndex;

        // Default: phantom padding entries get the sentinel.
        const SENTINEL = uint(0xffffffff);
        sortKeysNodeBK.element(i).assign(SENTINEL);
        sortedIndicesBK.element(i).assign(i);

        // Real splats overwrite their slot with the depth-derived key.
        If(i.lessThan(uint(N)), () => {
            const pos = positionsNode.element(i);
            // viewPos.z in three.js / GL conventions is NEGATIVE in front of
            // the camera. We flip sign so smaller key = nearer = drawn first
            // when sorted ascending. Bias by +1e-6 to defensively keep > 0.
            const viewPos = uModelView.mul(vec4(pos, 1.0));
            const depth   = max(viewPos.z.negate(), float(1e-6));
            // bitcast<u32>(positive_float) preserves ordering: smaller float
            // → smaller u32. Standard radix-on-float trick (web-splat does
            // the same with bitcast<u32>(clip.z) at preprocess.wgsl:248).
            const key = depth.bitcast('uint');                // f32 → u32 reinterpret
            sortKeysNodeBK.element(i).assign(key);
        });
    });
    const buildKeysCompute = buildKeys().compute(N_pad, [WORKGROUP_SIZE]);

    // -----------------------------------------------------------------------
    // Pass 2: bitonic compare-swap kernel.
    // For each thread t in [0, N_pad/2):
    //   - i = ((t / J) * 2 * J) + (t % J)
    //   - j = i ^ J            (== i + J when t%J < J, which it always is)
    //   - dir_asc = ((t / K) % 2 == 0)   // alternate direction per K-block
    //   - if (key[i] > key[j]) == dir_asc: swap (key, idx) at (i, j)
    //
    // Equivalently using bitwise ops (preferred for GPU):
    //   i = ((t & ~(J-1)) << 1) | (t & (J-1))      // expand t to skip J-1 bits
    //   j = i | J
    //   dir_asc = (i & K) == 0
    // -----------------------------------------------------------------------
    // Separate storage() wrappers for the compare-swap kernel. Same
    // underlying buffers, but Three.js may bind them differently per
    // compute pipeline.
    const sortKeysNodeCS  = storage(slot.sortKeysStorage,      'uint');
    const sortedIndicesCS = storage(slot.sortedIndicesStorage, 'uint');

    const compareSwap = Fn(() => {
        const t = instanceIndex;
        const J = uStageJ.toUint();
        const K = uStageK.toUint();

        // Bit-expand: i = ((t & ~(J-1)) << 1) | (t & (J-1))
        const Jminus1 = J.sub(uint(1));
        const lo  = t.bitAnd(Jminus1);
        const hi  = t.bitAnd(Jminus1.bitNot()).shiftLeft(uint(1));
        const i   = hi.bitOr(lo);
        const j   = i.bitOr(J);

        // Only do work if i and j are within the padded range. Since the
        // dispatch is N_pad/2 wide and i < N_pad always for valid t, this
        // is a safety guard against over-dispatch rounding.
        If(j.lessThan(uint(N_pad)), () => {
            const dirAsc = i.bitAnd(K).equal(uint(0));      // ascending vs descending sub-sequence
            const ki = sortKeysNodeCS.element(i);
            const kj = sortKeysNodeCS.element(j);

            // Swap iff (ki > kj) XOR dirAsc — i.e. the wrong order for this dir.
            const shouldSwap = ki.greaterThan(kj).equal(dirAsc);
            If(shouldSwap, () => {
                const ii  = sortedIndicesCS.element(i);
                const ij  = sortedIndicesCS.element(j);
                sortKeysNodeCS.element(i).assign(kj);
                sortKeysNodeCS.element(j).assign(ki);
                sortedIndicesCS.element(i).assign(ij);
                sortedIndicesCS.element(j).assign(ii);
            });
        });
    });
    const compareSwapCompute = compareSwap().compute(N_pad >> 1, [WORKGROUP_SIZE]);

    // -----------------------------------------------------------------------
    // Camera-motion gate (same shape as depthSort.js).
    // -----------------------------------------------------------------------
    let lastCamPos = null;
    const lastCamDir = new THREE.Vector3();
    const _camWorld  = new THREE.Vector3();
    const _camDirWld = new THREE.Vector3();
    const _viewModel = new THREE.Matrix4();

    const prevOnBeforeRender = mesh.onBeforeRender || function () {};
    mesh.onBeforeRender = function (renderer, scene, camera) {
        prevOnBeforeRender.call(this, renderer, scene, camera);

        // Skip if camera hasn't moved since the last sort.
        camera.getWorldPosition(_camWorld);
        camera.getWorldDirection(_camDirWld);
        if (lastCamPos !== null) {
            const moved   = _camWorld.distanceToSquared(lastCamPos) > moveSq;
            const rotated = _camDirWld.dot(lastCamDir) < cosAng;
            if (!moved && !rotated) return;
        }

        // Update view-model uniform (mat4(view * model)).
        _viewModel.multiplyMatrices(camera.matrixWorldInverse, this.matrixWorld);
        uModelView.value.copy(_viewModel);

        // Pass 1: build keys.
        renderer.compute(buildKeysCompute);

        // Pass 2: bitonic stages. K = 2,4,...,N_pad; J = K/2,K/4,...,1.
        // For 1.5M splats N_pad=2M → 21 outer × 21 inner = 441 dispatches.
        for (let K = 2; K <= N_pad; K <<= 1) {
            for (let J = K >> 1; J > 0; J >>= 1) {
                uStageK.value = K;
                uStageJ.value = J;
                renderer.compute(compareSwapCompute);
            }
        }

        if (!lastCamPos) lastCamPos = new THREE.Vector3();
        lastCamPos.copy(_camWorld);
        lastCamDir.copy(_camDirWld);
    };

    return function disableGpuSort() {
        mesh.onBeforeRender = prevOnBeforeRender;
        // Storage buffers are owned by the mesh.userData; don't dispose here.
    };
}

/**
 * Allocate and return the storage buffers a GPU-sorted splat mesh needs.
 * Call this from buildSplatMeshCompute and stash on mesh.userData.splat
 * so attachGpuSort can find them.
 *
 * @param {{count:number, positions:Float32Array, scales:Float32Array, colors:Float32Array, rotations:Float32Array}} splatData
 * @returns {{
 *   count: number,
 *   countPadded: number,
 *   positionsStorage: StorageInstancedBufferAttribute,
 *   scalesStorage:    StorageInstancedBufferAttribute,
 *   colorsStorage:    StorageInstancedBufferAttribute,
 *   rotationsStorage: StorageInstancedBufferAttribute,
 *   sortKeysStorage:  StorageInstancedBufferAttribute,
 *   sortedIndicesStorage: StorageInstancedBufferAttribute,
 * }}
 */
export function allocateSplatStorage(splatData) {
    const N      = splatData.count | 0;
    const N_pad  = nextPow2(N);

    // Source-data storage (read-only in shaders, written once on upload).
    const positionsStorage = new StorageInstancedBufferAttribute(splatData.positions, 3);
    const scalesStorage    = new StorageInstancedBufferAttribute(splatData.scales,    3);
    const colorsStorage    = new StorageInstancedBufferAttribute(splatData.colors,    4);
    const rotationsStorage = new StorageInstancedBufferAttribute(splatData.rotations, 4);

    // Sort working buffers (written every frame; allocated to padded size).
    const sortKeysStorage      = new StorageInstancedBufferAttribute(new Uint32Array(N_pad), 1);
    const sortedIndicesStorage = new StorageInstancedBufferAttribute(new Uint32Array(N_pad), 1);

    return {
        count:                N,
        countPadded:          N_pad,
        positionsStorage,
        scalesStorage,
        colorsStorage,
        rotationsStorage,
        sortKeysStorage,
        sortedIndicesStorage,
    };
}
