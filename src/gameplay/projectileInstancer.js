// ──────────────────────────────────────────────────────────────────────────
// Phase A — instanced projectile renderer.
//
// Before: every bullet was its own THREE.Mesh with its OWN SphereGeometry +
// MeshStandardMaterial (createProjectileMesh). Under SMG spam that's 250+
// meshes / 250+ geometries / 250+ materials → 250+ draw calls and heavy GC.
// Phase 0 proved instancing alone collapses that to ~1 draw call and ~30×
// less CPU at scale, with no GPU-cull/indirect needed at these counts.
//
// This module renders all same-looking bullets through ONE THREE.InstancedMesh
// per visual key, reusing the exact pattern already proven in
// src/physics/litePool.js (preallocated instance matrix, count-capped, hidden
// via zero-scale matrix). It deliberately keeps a per-projectile *handle* that
// exposes `.position` / `.name` / `.visible` so the existing hit-detection and
// update code in runtime.js (which reads `projectile.mesh.position`) works
// unchanged — the handle IS the `mesh` from the caller's point of view.
//
// Geometry/material are created ONCE per visual key and shared. No DDGI on
// bullets (they used plain MeshStandardMaterial before — preserved).
// ──────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';

const CAPACITY_PER_KEY = 512;          // hard cap of simultaneous bullets/type
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);

// One InstancedMesh + free-list per visual key. Lazily created.
class ProjectileBatch {
    constructor(scene, { radius, color, emissiveIntensity }) {
        this.scene = scene;
        this.geometry = new THREE.SphereGeometry(radius, 16, 10);
        this.material = new THREE.MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity,
            roughness: 0.18,
            metalness: 0.15,
        });
        const im = new THREE.InstancedMesh(this.geometry, this.material, CAPACITY_PER_KEY);
        im.frustumCulled = false; // bullets are small & fast; CPU-cull churn not worth it
        im.castShadow = false;
        im.receiveShadow = false;
        im.count = CAPACITY_PER_KEY; // keep range stable; hidden slots are zero-scaled
        im.name = 'ProjectileBatch';
        im.userData.isProjectileBatch = true;
        for (let i = 0; i < CAPACITY_PER_KEY; i++) im.setMatrixAt(i, HIDDEN);
        im.instanceMatrix.needsUpdate = true;
        scene.add(im);
        this.mesh = im;

        // Slot bookkeeping. handles[slot] is the live handle or null.
        this.handles = new Array(CAPACITY_PER_KEY).fill(null);
        this.handlePool = new Array(CAPACITY_PER_KEY);
        this.free = [];
        for (let i = CAPACITY_PER_KEY - 1; i >= 0; i--) {
            this.handlePool[i] = {
                position: new THREE.Vector3(),
                name: 'Projectile',
                visible: false,
                _batch: this,
                _slot: undefined,
                _light: null,
            };
            this.free.push(i);
        }
        this.dirty = false;
    }

    acquire(name) {
        const slot = this.free.pop();
        if (slot === undefined) return null; // batch full → caller drops the shot
        const handle = this.handlePool[slot];
        handle.position.set(0, 0, 0);
        handle.name = name || 'Projectile';
        handle.visible = true;
        handle._slot = slot;
        this.handles[slot] = handle;
        return handle;
    }

    release(handle) {
        const slot = handle._slot;
        if (slot === undefined || this.handles[slot] !== handle) return;
        if (handle._light) {
            handle._light.parent?.remove(handle._light);
            handle._light = null;
        }
        this.mesh.setMatrixAt(slot, HIDDEN);
        this.handles[slot] = null;
        this.free.push(slot);
        handle._slot = undefined;
        handle.visible = false;
        handle.name = 'Projectile';
        handle.position.set(0, 0, 0);
        this.dirty = true;
    }

    // Pack every live handle's position into the instance matrix. Called once
    // per frame AFTER runtime.js has advanced projectile positions.
    flush() {
        const im = this.mesh;
        const handles = this.handles;
        let any = this.dirty;
        for (let i = 0; i < handles.length; i++) {
            const h = handles[i];
            if (!h) continue;
            _m.compose(h.position, _q, _s);
            im.setMatrixAt(i, _m);
            if (h._light) h._light.position.copy(h.position);
            any = true;
        }
        if (any) {
            im.instanceMatrix.needsUpdate = true;
            this.dirty = false;
        }
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.geometry.dispose();
        this.material.dispose();
    }
}

export function createProjectileInstancer(scene) {
    /** key string → ProjectileBatch */
    const batches = new Map();

    const keyOf = (o) =>
        `${o.poolKey || 'p'}|${(o.radius ?? 0.12).toFixed(3)}|${o.color ?? 0xffffff}|${o.emissiveIntensity ?? 2.6}`;

    function getBatch(options) {
        const k = keyOf(options);
        let b = batches.get(k);
        if (!b) {
            b = new ProjectileBatch(scene, {
                radius: options.radius ?? 0.12,
                color: options.color ?? 0xffffff,
                emissiveIntensity: options.emissiveIntensity ?? 2.6,
            });
            batches.set(k, b);
        }
        return b;
    }

    return {
        // Drop-in for acquireProjectileMesh(): returns a handle that behaves
        // like the old `mesh` for the fields the gameplay code touches.
        // Returns null if that batch is at capacity (caller skips the shot).
        acquire(options) {
            const batch = getBatch(options);
            const handle = batch.acquire(options.name);
            if (!handle) return null;
            // Rare muzzle-light path: instancing can't do per-instance point
            // lights, so attach a real (pooled-by-lifetime) light to the
            // batch mesh and move it with the handle in flush().
            if (options.light === true) {
                const light = new THREE.PointLight(
                    options.color ?? 0xffffff,
                    options.lightIntensity ?? 1.2,
                    options.lightDistance ?? 2.2,
                );
                handle._light = light;
                scene.add(light);
            }
            return handle;
        },

        // Drop-in for releaseProjectile()'s mesh teardown.
        release(handle) {
            handle?._batch?.release(handle);
        },

        // Call once per frame after projectile positions are advanced.
        flush() {
            for (const b of batches.values()) b.flush();
        },

        dispose() {
            for (const b of batches.values()) b.dispose();
            batches.clear();
        },
    };
}
