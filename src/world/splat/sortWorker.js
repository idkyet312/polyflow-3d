// src/world/splat/sortWorker.js
//
// Phase 3a — Web Worker depth sorter for splats.
// Replaces the main-thread sort that lived in depthSort.js: keeps the
// per-frame O(N log N) (now O(N) — radix) cost off the render thread so
// 250 K-1 M splats no longer stall the frame.
//
// Wire format (all postMessage, no SharedArrayBuffer — keeps us out of
// COOP/COEP territory and works behind GitHub Pages):
//   main → worker:
//     { type: 'init',  positions: Float32Array, count: number }
//        ↳ positions.buffer transferred. Worker becomes the sole owner.
//     { type: 'sort',  sortId, camLocal: Float32Array(3), mvpLocal: Float32Array(16) | null, cullMargin: number | null }
//        ↳ camLocal/mvpLocal cloned (cheap — 12+64 bytes); not transferred.
//   worker → main:
//     { type: 'inited' }
//     { type: 'sorted', sortId, indices: Uint32Array, visibleCount: number }
//        ↳ indices.buffer transferred back. Main thread reads, then
//          transfers back next request to recycle (zero allocations after warmup).
//
// Sort algorithm:
//   - Compute squared distance from cam → splat center in mesh-local space.
//   - Squared distances are non-negative, so their IEEE 754 bit pattern
//     orders identically to numeric value when interpreted as Uint32. We
//     radix-sort on those bit patterns directly.
//   - 4-pass LSD radix (8 bits / pass), ascending. Reverse-permute on
//     output so indices land far → near (back-to-front for alpha blend).
//
// Frustum cull (optional, when mvpLocal is provided):
//   - Project each center to clip space via mvpLocal.
//   - Drop splats with |ndc.x| > cullMargin OR |ndc.y| > cullMargin OR
//     |ndc.z| > 1 (clipped behind near / past far). The z range [-1, 1]
//     is the OpenGL/WebGL convention; WebGPU uses [0, 1] but [-1, 1] is
//     a strict superset, so accepting both keeps the worker backend-agnostic.
//     A few extra splats slipping through near the WebGPU near-plane is
//     fine — the renderer's depthTest still clips them at the actual draw.
//   - Margin > 1 is intentional — splat ellipses extend past their center.
//     Default 1.5 is conservative; tune later when LOD lands.

let positions = null;     // Float32Array(count*3), mesh-local
let count     = 0;

// Scratch reused across sorts — allocated once on init, never reallocated.
let depthsU32 = null;     // Uint32Array(count) — float bits view of squared distance
let depthsF32 = null;     // Float32Array sharing the same buffer as depthsU32
let idxA      = null;     // Uint32Array(count) — radix ping
let idxB      = null;     // Uint32Array(count) — radix pong
let bucketsU  = null;     // Uint32Array(256)
let visibleU8 = null;     // Uint8Array(count) — cull mask, 1 if visible
let outBuf    = null;     // Uint32Array(count) — sent back to main; recycled when main returns it

self.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'init') {
        positions = m.positions;
        count = m.count | 0;

        depthsU32 = new Uint32Array(count);
        depthsF32 = new Float32Array(depthsU32.buffer);
        idxA      = new Uint32Array(count);
        idxB      = new Uint32Array(count);
        bucketsU  = new Uint32Array(256);
        visibleU8 = new Uint8Array(count);
        outBuf    = new Uint32Array(count);

        self.postMessage({ type: 'inited' });
        return;
    }

    if (m.type === 'sort') {
        if (!positions) return;   // arrived before init somehow

        // Recycle a buffer the main thread shipped back, if any. Skip if
        // it's the wrong size (count changed mid-session — shouldn't happen
        // in normal use, but be defensive).
        if (m.recycle && m.recycle.byteLength === count * 4) {
            outBuf = new Uint32Array(m.recycle);
        } else if (!outBuf || outBuf.length !== count) {
            outBuf = new Uint32Array(count);
        }

        const cx = m.camLocal[0];
        const cy = m.camLocal[1];
        const cz = m.camLocal[2];
        const vx = m.viewLocal?.[0] ?? 0;
        const vy = m.viewLocal?.[1] ?? 0;
        const vz = m.viewLocal?.[2] ?? 1;

        const mvp        = m.mvpLocal || null;
        const cullMargin = (typeof m.cullMargin === 'number') ? m.cullMargin : 0;
        const doCull     = !!mvp && cullMargin > 0;

        const N = count;
        const pos = positions;
        let visibleCount = 0;

        // ----- 1. depth + (optional) cull -----
        if (doCull) {
            // Inline a 4x4 * vec4 multiply per splat. Avoids per-iteration object alloc.
            const m00 = mvp[0],  m01 = mvp[4],  m02 = mvp[8],  m03 = mvp[12];
            const m10 = mvp[1],  m11 = mvp[5],  m12 = mvp[9],  m13 = mvp[13];
            const m20 = mvp[2],  m21 = mvp[6],  m22 = mvp[10], m23 = mvp[14];
            const m30 = mvp[3],  m31 = mvp[7],  m32 = mvp[11], m33 = mvp[15];

            for (let i = 0; i < N; i++) {
                const i3 = i * 3;
                const px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];

                const dx = px - cx, dy = py - cy, dz = pz - cz;
                depthsF32[i] = dx * vx + dy * vy + dz * vz;
                const bits = depthsU32[i];
                depthsU32[i] = (bits & 0x80000000) ? (~bits >>> 0) : (bits ^ 0x80000000);

                const cw = m30 * px + m31 * py + m32 * pz + m33;
                if (cw <= 0.0001) {
                    visibleU8[i] = 0;
                    continue;
                }
                const cxC = (m00 * px + m01 * py + m02 * pz + m03) / cw;
                const cyC = (m10 * px + m11 * py + m12 * pz + m13) / cw;
                const czC = (m20 * px + m21 * py + m22 * pz + m23) / cw;
                const vis =
                    (cxC > -cullMargin) & (cxC < cullMargin) &
                    (cyC > -cullMargin) & (cyC < cullMargin) &
                    (czC > -1)          & (czC < 1);
                visibleU8[i] = vis;
                if (vis) visibleCount++;
            }
        } else {
            for (let i = 0; i < N; i++) {
                const i3 = i * 3;
                const dx = pos[i3]     - cx;
                const dy = pos[i3 + 1] - cy;
                const dz = pos[i3 + 2] - cz;
                depthsF32[i] = dx * vx + dy * vy + dz * vz;
                const bits = depthsU32[i];
                depthsU32[i] = (bits & 0x80000000) ? (~bits >>> 0) : (bits ^ 0x80000000);
            }
            visibleCount = N;
        }

        // ----- 2. seed indices (only the visible ones if culling) -----
        if (doCull) {
            let w = 0;
            for (let i = 0; i < N; i++) {
                if (visibleU8[i]) idxA[w++] = i;
            }
            // Tail of idxA past visibleCount is stale; the radix only walks 0..visibleCount.
        } else {
            for (let i = 0; i < N; i++) idxA[i] = i;
        }

        // ----- 3. 4-pass LSD radix sort, ascending by depthsU32 -----
        // After 4 passes "src" holds indices ascending by squared depth (near first).
        // We reverse-permute on output to get far → near.
        const M = visibleCount;
        let src = idxA, dst = idxB;
        for (let pass = 0; pass < 4; pass++) {
            const shift = pass * 8;
            bucketsU.fill(0);
            for (let i = 0; i < M; i++) {
                bucketsU[(depthsU32[src[i]] >>> shift) & 0xff]++;
            }
            // Exclusive prefix sum.
            let sum = 0;
            for (let k = 0; k < 256; k++) {
                const c = bucketsU[k];
                bucketsU[k] = sum;
                sum += c;
            }
            // Scatter.
            for (let i = 0; i < M; i++) {
                const k = (depthsU32[src[i]] >>> shift) & 0xff;
                dst[bucketsU[k]++] = src[i];
            }
            // Ping-pong.
            const tmp = src; src = dst; dst = tmp;
        }

        // ----- 4. write out far → near (reverse of ascending) -----
        const out = outBuf;
        for (let i = 0; i < M; i++) {
            out[i] = src[M - 1 - i];
        }
        // Tail past M is left as stale; main thread reads only 0..visibleCount.

        const send = out;
        outBuf = null;   // we just transferred ownership; main will ship a buffer back next call
        self.postMessage(
            { type: 'sorted', sortId: m.sortId, indices: send, visibleCount: M },
            [send.buffer],
        );
        return;
    }
};
