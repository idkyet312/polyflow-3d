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
    uint, float, vec4,
    If, max,
} from 'three/tsl';

const WORKGROUP_SIZE = 256;
const MAX_SH_STORAGE_BYTES = 240 * 1024 * 1024;

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
    const positionsNode     = storage(slot.positionsStorage,     'vec3', N).toReadOnly();
    const sortKeysNodeBK    = storage(slot.sortKeysStorage,      'uint', N_pad);
    const sortedIndicesBK   = storage(slot.sortedIndicesStorage, 'uint', N_pad);

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
            const normalizedDepth = depth.div(float(100000.0)).clamp(0.0, 1.0);
            const key = uint(0xffffffff).sub(normalizedDepth.mul(float(4294967295.0)).toUint());
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
    const sortKeysNodeCS  = storage(slot.sortKeysStorage,      'uint', N_pad);
    const sortedIndicesCS = storage(slot.sortedIndicesStorage, 'uint', N_pad);

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
            const ki = sortKeysNodeCS.element(i).toVar();
            const kj = sortKeysNodeCS.element(j).toVar();

            // Swap iff (ki > kj) XOR dirAsc — i.e. the wrong order for this dir.
            const shouldSwap = dirAsc.select(ki.greaterThan(kj), ki.lessThan(kj));
            If(shouldSwap, () => {
                const ii  = sortedIndicesCS.element(i).toVar();
                const ij  = sortedIndicesCS.element(j).toVar();
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
    let disabled = false;
    let warnedRuntimeFailure = false;

    function markRuntimeFailure(err) {
        disabled = true;
        slot.sortStatus = 'error';
        slot.sortError = err?.message || String(err);
        mesh.userData.splatSortRuntimeError = slot.sortError;
        if (!warnedRuntimeFailure) {
            warnedRuntimeFailure = true;
            console.warn('[splat-gpuSort] compute dispatch failed; keeping identity order visible:', err);
        }
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('splat-sort-status', {
                detail: {
                    requestedMode: mesh.userData.splatSortRequestedMode || 'auto',
                    effectiveMode: 'compute',
                    computeSupported: true,
                    message: 'Compute sort failed at runtime. Showing unsorted splat.',
                    error: slot.sortError,
                },
            }));
        }
    }

    mesh.onBeforeRender = function (renderer, scene, camera) {
        prevOnBeforeRender.call(this, renderer, scene, camera);
        if (disabled) return;

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
        try {
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
            slot.sortStatus = 'sorted';
            slot.sortError = '';
        } catch (err) {
            markRuntimeFailure(err);
            return;
        }

        if (!lastCamPos) lastCamPos = new THREE.Vector3();
        lastCamPos.copy(_camWorld);
        lastCamDir.copy(_camDirWld);
    };

    return function disableGpuSort() {
        disabled = true;
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
 *   shStorage?:       StorageInstancedBufferAttribute,
 *   sortKeysStorage:  StorageInstancedBufferAttribute,
 *   sortedIndicesStorage: StorageInstancedBufferAttribute,
 * }}
 */
export function allocateSplatStorage(splatData, opts = {}) {
    const N      = splatData.count | 0;
    const N_pad  = nextPow2(N);
    const requestedShDegree = Math.max(0, Math.min(3, opts.shDegree ?? splatData.sh?.degree ?? 0));

    // Source-data storage (read-only in shaders, written once on upload).
    const positionsStorage = new StorageInstancedBufferAttribute(splatData.positions, 3);
    const scalesStorage    = new StorageInstancedBufferAttribute(splatData.scales,    3);
    const colorsStorage    = new StorageInstancedBufferAttribute(splatData.colors,    4);
    const rotationsStorage = new StorageInstancedBufferAttribute(splatData.rotations, 4);
    const shPacking = splatData.sh
        ? chooseShPacking(splatData.sh, N, Math.min(requestedShDegree, splatData.sh.degree || requestedShDegree))
        : null;
    const packedSh = shPacking?.packed || null;
    const shStorage = shPacking?.layout === 'interleaved' && packedSh
        ? new StorageInstancedBufferAttribute(packedSh, 1)
        : null;
    const shStorageR = shPacking?.layout === 'planar'
        ? new StorageInstancedBufferAttribute(shPacking.packedR, 1)
        : null;
    const shStorageG = shPacking?.layout === 'planar'
        ? new StorageInstancedBufferAttribute(shPacking.packedG, 1)
        : null;
    const shStorageB = shPacking?.layout === 'planar'
        ? new StorageInstancedBufferAttribute(shPacking.packedB, 1)
        : null;
    const shCodebookStorage = shPacking?.layout === 'codebook'
        ? new StorageInstancedBufferAttribute(shPacking.codebook, 1)
        : null;
    const shLabelsStorage = shPacking?.layout === 'codebook'
        ? new StorageInstancedBufferAttribute(shPacking.labels, 1)
        : null;

    // Sort working buffers (written every frame; allocated to padded size).
    const sortKeys = new Uint32Array(N_pad);
    const sortedIndices = new Uint32Array(N_pad);
    for (let i = 0; i < N_pad; i++) {
        sortKeys[i] = 0xffffffff;
        sortedIndices[i] = i;
    }

    const sortKeysStorage      = new StorageInstancedBufferAttribute(sortKeys, 1);
    const sortedIndicesStorage = new StorageInstancedBufferAttribute(sortedIndices, 1);

    return {
        count:                N,
        countPadded:          N_pad,
        sortStatus:           'identity',
        sortError:            '',
        positionsStorage,
        scalesStorage,
        colorsStorage,
        rotationsStorage,
        shStorage,
        shStorageR,
        shStorageG,
        shStorageB,
        shCodebookStorage,
        shLabelsStorage,
        shLayout: shPacking?.layout || '',
        shDegree: shPacking?.degree || 0,
        shPackedU32PerSplat: shPacking?.packedU32PerSplat || 0,
        shPackedU32PerChannelSplat: shPacking?.packedU32PerChannelSplat || 0,
        shPackedU32PerEntry: shPacking?.packedU32PerEntry || 0,
        shCodebookSize: shPacking?.codebookSize || 0,
        shFallbackReason: shPacking?.fallbackReason || '',
        shBytes: shPacking?.byteLength || 0,
        sortKeysStorage,
        sortedIndicesStorage,
    };
}

function chooseShPacking(sh, count, requestedDegree) {
    if (sh.layout === 'codebook') {
        return chooseCodebookShPacking(sh, requestedDegree);
    }
    if (sh.layout !== 'direct' || !sh.coeffs) {
        return {
            degree: 0,
            packedU32PerSplat: 0,
            packedU32PerChannelSplat: 0,
            packed: null,
            fallbackReason: 'Unsupported SH layout; using DC color.',
        };
    }
    const sourceAcCoeffCount = (((sh.degree || requestedDegree) + 1) * ((sh.degree || requestedDegree) + 1)) - 1;
    const sourceStrideHalves = sourceAcCoeffCount * 3;
    for (let degree = requestedDegree; degree > 0; degree--) {
        const coeffCount = (degree + 1) * (degree + 1);
        const acCoeffCount = coeffCount - 1;
        const packedU32PerSplat = Math.ceil((acCoeffCount * 3) / 2);
        const byteLength = count * packedU32PerSplat * 4;
        if (byteLength <= MAX_SH_STORAGE_BYTES) {
            return {
                layout: 'interleaved',
                degree,
                packedU32PerSplat,
                packed: packDirectShPairs(sh.coeffs, count, degree, packedU32PerSplat, sourceStrideHalves),
                byteLength,
                fallbackReason: degree < requestedDegree
                    ? `SH deg ${requestedDegree} exceeds ${(MAX_SH_STORAGE_BYTES / (1024 * 1024)).toFixed(0)} MB buffer cap; using deg ${degree}.`
                    : '',
            };
        }
        const packedU32PerChannelSplat = Math.ceil(acCoeffCount / 2);
        const channelByteLength = count * packedU32PerChannelSplat * 4;
        if (channelByteLength <= MAX_SH_STORAGE_BYTES) {
            const planar = packDirectShPlanar(sh.coeffs, count, degree, packedU32PerChannelSplat, sourceStrideHalves);
            return {
                layout: 'planar',
                degree,
                packedU32PerChannelSplat,
                ...planar,
                byteLength: planar.packedR.byteLength + planar.packedG.byteLength + planar.packedB.byteLength,
                fallbackReason: '',
            };
        }
    }
    return {
        degree: 0,
        packedU32PerSplat: 0,
        packedU32PerChannelSplat: 0,
        packed: null,
        fallbackReason: `SH storage exceeds ${(MAX_SH_STORAGE_BYTES / (1024 * 1024)).toFixed(0)} MB buffer cap; using DC color.`,
    };
}

function chooseCodebookShPacking(sh, requestedDegree) {
    const degree = Math.max(0, Math.min(requestedDegree, sh.degree || 0));
    if (degree <= 0 || !sh.coeffs || !sh.labels) {
        return {
            degree: 0,
            packed: null,
            fallbackReason: 'Missing SH codebook data; using DC color.',
        };
    }
    const acCoeffCount = ((degree + 1) * (degree + 1)) - 1;
    const packedU32PerEntry = Math.ceil((acCoeffCount * 3) / 2);
    const sourceAcCoeffCount = (((sh.degree || degree) + 1) * ((sh.degree || degree) + 1)) - 1;
    const sourceStrideHalves = sourceAcCoeffCount * 3;
    const codebookSize = sh.codebookSize || Math.floor(sh.coeffs.length / Math.max(1, sourceStrideHalves));
    const codebook = packCodebookShPairs(sh.coeffs, codebookSize, degree, packedU32PerEntry, sourceStrideHalves);
    const labels = new Uint32Array(sh.labels.length);
    for (let i = 0; i < sh.labels.length; i++) labels[i] = sh.labels[i];
    return {
        layout: 'codebook',
        degree,
        packedU32PerEntry,
        codebookSize,
        codebook,
        labels,
        byteLength: codebook.byteLength + labels.byteLength,
        fallbackReason: degree < requestedDegree
            ? `SH deg ${requestedDegree} unavailable; using deg ${degree}.`
            : '',
    };
}

function packDirectShPairs(coefficients, count, degree, packedU32PerSplat, srcStrideHalves) {
    const coeffHalves = (((degree + 1) * (degree + 1)) - 1) * 3;
    const packed = new Uint32Array(count * packedU32PerSplat);
    for (let i = 0; i < count; i++) {
        const srcBase = i * srcStrideHalves;
        const dstBase = i * packedU32PerSplat;
        for (let p = 0; p < packedU32PerSplat; p++) {
            const lo = coefficients[srcBase + p * 2 + 0] || 0;
            const hi = p * 2 + 1 < coeffHalves
                ? coefficients[srcBase + p * 2 + 1]
                : 0;
            packed[dstBase + p] = lo | (hi << 16);
        }
    }
    return packed;
}

function packDirectShPlanar(coefficients, count, degree, packedU32PerChannelSplat, srcStrideHalves) {
    const acCoeffCount = ((degree + 1) * (degree + 1)) - 1;
    const packedR = new Uint32Array(count * packedU32PerChannelSplat);
    const packedG = new Uint32Array(count * packedU32PerChannelSplat);
    const packedB = new Uint32Array(count * packedU32PerChannelSplat);

    for (let i = 0; i < count; i++) {
        const srcBase = i * srcStrideHalves;
        const dstBase = i * packedU32PerChannelSplat;
        for (let p = 0; p < packedU32PerChannelSplat; p++) {
            const c0 = p * 2;
            const c1 = c0 + 1;
            const r0 = coefficients[srcBase + c0 * 3 + 0] || 0;
            const g0 = coefficients[srcBase + c0 * 3 + 1] || 0;
            const b0 = coefficients[srcBase + c0 * 3 + 2] || 0;
            const r1 = c1 < acCoeffCount ? coefficients[srcBase + c1 * 3 + 0] : 0;
            const g1 = c1 < acCoeffCount ? coefficients[srcBase + c1 * 3 + 1] : 0;
            const b1 = c1 < acCoeffCount ? coefficients[srcBase + c1 * 3 + 2] : 0;
            packedR[dstBase + p] = r0 | (r1 << 16);
            packedG[dstBase + p] = g0 | (g1 << 16);
            packedB[dstBase + p] = b0 | (b1 << 16);
        }
    }

    return { packedR, packedG, packedB };
}

function packCodebookShPairs(coefficients, codebookSize, degree, packedU32PerEntry, srcStrideHalves) {
    const coeffHalves = (((degree + 1) * (degree + 1)) - 1) * 3;
    const packed = new Uint32Array(codebookSize * packedU32PerEntry);
    for (let entry = 0; entry < codebookSize; entry++) {
        const srcBase = entry * srcStrideHalves;
        const dstBase = entry * packedU32PerEntry;
        for (let p = 0; p < packedU32PerEntry; p++) {
            const lo = coefficients[srcBase + p * 2 + 0] || 0;
            const hi = p * 2 + 1 < coeffHalves
                ? coefficients[srcBase + p * 2 + 1]
                : 0;
            packed[dstBase + p] = lo | (hi << 16);
        }
    }
    return packed;
}
