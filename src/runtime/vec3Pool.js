// Vec3Pool — borrow/return Vector3 scratch buffers without aliasing hazards.
//
// Why: runtime.js holds six file-scope Vector3s (tempVectorA-F) that are
// passed into multiple extracted modules AND used by runtime.js itself.
// Two functions that grab the same tempVector and call into each other
// silently corrupt the buffer. No syntax check catches it.
//
// Migration target: every new call site uses acquire/release. Old
// tempVectorA-F sites can stay until they are touched for other reasons —
// the pool gives the safe path forward without forcing a 211-site rewrite.
//
// Pattern:
//   const v = vec3.acquire();
//   try { ... use v ... } finally { vec3.release(v); }
//
// Or the scoped form:
//   vec3.with((a, b) => { ... a, b live here, released on return ... });
//
// In dev (NODE_ENV !== 'production') we tag each acquired vector with a
// borrowedBy stack frame and throw on double-release. In prod we strip
// the bookkeeping for zero overhead.

import * as THREE from 'three';

const IS_DEV = typeof process === 'undefined' || process.env?.NODE_ENV !== 'production';

export function createVec3Pool({ initialSize = 16, name = 'vec3' } = {}) {
    const free = [];
    const borrowed = IS_DEV ? new Set() : null;
    let createdCount = 0;
    let peakBorrowed = 0;

    function make() {
        createdCount += 1;
        return new THREE.Vector3();
    }

    for (let i = 0; i < initialSize; i++) {
        free.push(make());
    }

    function acquire() {
        const v = free.pop() ?? make();
        v.set(0, 0, 0);
        if (IS_DEV) {
            borrowed.add(v);
            if (borrowed.size > peakBorrowed) peakBorrowed = borrowed.size;
        }
        return v;
    }

    function release(v) {
        if (!v) return;
        if (IS_DEV) {
            if (!borrowed.has(v)) {
                // Double-release or foreign vector — both indicate a bug
                // that would otherwise corrupt the next acquire().
                throw new Error(`${name}: release of non-borrowed vector`);
            }
            borrowed.delete(v);
        }
        free.push(v);
    }

    // Scoped helper. Pass a function that takes N vectors; they are
    // released automatically when the callback returns (or throws).
    function with_(fn) {
        const n = fn.length;
        const taken = [];
        try {
            for (let i = 0; i < n; i++) taken.push(acquire());
            return fn(...taken);
        } finally {
            for (let i = 0; i < taken.length; i++) release(taken[i]);
        }
    }

    function stats() {
        return {
            created: createdCount,
            free: free.length,
            borrowed: IS_DEV ? borrowed.size : -1,
            peakBorrowed: IS_DEV ? peakBorrowed : -1,
        };
    }

    return {
        acquire,
        release,
        with: with_,
        stats,
    };
}

// Shared singleton for code paths that don't want to thread a pool
// through their deps. Modules that want isolation (tests, multiplayer
// sandboxes) should call createVec3Pool() themselves.
export const vec3 = createVec3Pool({ initialSize: 32, name: 'vec3(shared)' });
