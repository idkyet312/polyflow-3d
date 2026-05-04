// src/world/splat/splatActor.js
//
// Phase 2: SplatActor — wraps a Gaussian Splat as a first-class scene actor.
//
// Integrates with:
//   - Actor / SceneSystem  (registers like any other actor; mesh added to scene root)
//   - TransformComponent   (transform gizmo edits propagate through modelMatrix)
//   - sceneSerialization   (toJSON / deserializeSplatActor hooks for round-trip)
//
// What this ADDS over the bare splatRenderer mesh:
//   - Lifecycle: loads on beginPlay, disposes on endPlay
//   - URL-aware serialization: saves the splat URL + transform; reloads on import
//   - PCA-fit bounding box from splat centers (selection outline + scene UI)
//   - Splats show up under runtime/components like other actors
//
// What this does NOT do yet (deferred):
//   - WebGPU compute depth sort (Phase 3)
//   - Frustum cull / LOD (Phase 3)
//   - Physics collision proxy (Phase 4)
//   - DDGI lighting integration (Phase 5)

import * as THREE from 'three';
import { ActorComponent } from '../../runtime/components/ActorComponent.js';
import { TransformComponent } from '../../runtime/components/TransformComponent.js';
import { Actor } from '../../runtime/sceneRuntime.js';
import { buildSplatMesh, loadSplat } from './splatRenderer.js';

// ---------------------------------------------------------------------
// SplatComponent — UE-style component holding the splat renderer mesh
// ---------------------------------------------------------------------
export class SplatComponent extends ActorComponent {
    static componentKey = 'SplatComponent';

    constructor({ url = '', count = 0 } = {}) {
        super();
        /** @type {string} URL to the .splat file. Required for beginPlay to do anything. */
        this.url = url;
        /** @type {number} Splat count (populated after load). */
        this.count = count;
        /** @type {THREE.Mesh|null} The actual renderer mesh (set after load). */
        this.mesh = null;
        /** @type {Promise<void>|null} Resolves when the splat is loaded and attached. */
        this.loadPromise = null;
        /** @type {THREE.Box3} PCA-fit bounds from splat centers. Empty until load completes. */
        this.bounds = new THREE.Box3();
    }

    /** Called by Actor.addComponent. Kicks off async load. */
    beginPlay() {
        if (!this.url || !this.owner) return;
        if (this.loadPromise) return;

        this.loadPromise = (async () => {
            try {
                const data = await loadSplat(this.url);
                this.mesh = buildSplatMesh(data);
                this.count = data.count;
                this._computeBounds(data.positions);

                // Attach to the actor's root mesh so transform-gizmo edits on the actor
                // propagate to the splat via Three.js's parent matrix chain.
                const root = this.owner?.mesh;
                if (root && this.mesh) root.add(this.mesh);
            } catch (err) {
                console.error('[SplatComponent] load failed:', err);
                this.loadPromise = null;
            }
        })();
    }

    /** Called when the actor is destroyed or the component is removed. */
    endPlay() {
        if (this.mesh) {
            this.mesh.parent?.remove(this.mesh);
            this.mesh.geometry?.dispose?.();
            this.mesh.material?.dispose?.();
            this.mesh = null;
        }
        this.loadPromise = null;
    }

    /** Tight box from splat centers. Doesn't account for splat anisotropy — fine for selection. */
    _computeBounds(positions) {
        this.bounds.makeEmpty();
        const v = new THREE.Vector3();
        for (let i = 0; i < positions.length; i += 3) {
            v.set(positions[i], positions[i + 1], positions[i + 2]);
            this.bounds.expandByPoint(v);
        }
    }

    /** Serialization hook: called by the scene serializer. */
    toJSON() {
        return {
            type: 'SplatComponent',
            url: this.url,
            count: this.count,
        };
    }
}

// ---------------------------------------------------------------------
// Factory: createSplatActor
// ---------------------------------------------------------------------
/**
 * Build an Actor wrapping a Gaussian Splat.
 *
 *   const actor = createSplatActor({
 *       url: '/path/to/file.splat',
 *       name: 'PhotoScan',
 *       position: new THREE.Vector3(0, 0, 0),
 *   });
 *   sceneSystem.addActor(actor);   // shows up in the scene + scene UI
 *
 * @param {object}   options
 * @param {string}   options.url       REQUIRED. URL to the .splat file.
 * @param {string}  [options.name]     Display name (default 'Splat').
 * @param {string}  [options.id]       Stable id; auto-generated if omitted.
 * @param {THREE.Vector3} [options.position]  Initial world position.
 * @returns {Actor}
 */
export function createSplatActor({ url, name = 'Splat', id = '', position = null } = {}) {
    if (!url) throw new Error('[splatActor] createSplatActor requires { url }');

    // Empty Group acts as the actor root; the splat renderer mesh attaches as a child
    // once SplatComponent.beginPlay's async load resolves.
    const root = new THREE.Group();
    root.name = name;
    root.userData.splatUrl = url;
    if (position) root.position.copy(position);

    const actor = new Actor({
        id: id || `splat-${Math.random().toString(36).slice(2, 10)}`,
        name,
        kind: 'splat',
        mesh: root,
        userData: { splatUrl: url },
    });

    actor.addComponent(new TransformComponent());
    actor.addComponent(new SplatComponent({ url }));

    return actor;
}

// ---------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------
/**
 * Serialize a SplatActor to a plain JSON shape.
 * Companion to deserializeSplatActor; intended to plug into the project's
 * existing scene serializer (src/world/sceneSerialization.js) at the actor level.
 *
 *   {
 *     kind: 'splat',
 *     id, name,
 *     transform: { position: [x,y,z], quaternion: [x,y,z,w], scale: [x,y,z] },
 *     userData:  { splatUrl: '...' },
 *     components: [ SplatComponent.toJSON() ]
 *   }
 */
export function serializeSplatActor(actor) {
    if (!actor || actor.kind !== 'splat') return null;
    const root = actor.mesh;
    const splat = actor.getComponentByClass(SplatComponent);

    return {
        kind: 'splat',
        id:   actor.id,
        name: actor.rootNode?.name ?? root?.name ?? 'Splat',
        transform: {
            position:   root ? root.position.toArray()   : [0, 0, 0],
            quaternion: root ? root.quaternion.toArray() : [0, 0, 0, 1],
            scale:      root ? root.scale.toArray()      : [1, 1, 1],
        },
        userData: { splatUrl: splat?.url ?? actor.userData?.splatUrl ?? '' },
        components: splat ? [splat.toJSON()] : [],
    };
}

/**
 * Deserialize a JSON payload (from serializeSplatActor) back into a live SplatActor.
 * The caller is responsible for adding it to a SceneSystem.
 */
export function deserializeSplatActor(json) {
    const url = json?.userData?.splatUrl
        ?? json?.splatUrl
        ?? json?.components?.find?.((c) => c?.type === 'SplatComponent')?.url
        ?? '';
    if (!url) throw new Error('[splatActor] deserializeSplatActor: missing splatUrl');

    const actor = createSplatActor({
        id:   json.id ?? '',
        name: json.name ?? 'Splat',
        url,
    });

    const t = json.transform ?? {};
    const root = actor.mesh;
    if (root) {
        if (Array.isArray(t.position))   root.position.fromArray(t.position);
        if (Array.isArray(t.quaternion)) root.quaternion.fromArray(t.quaternion);
        if (Array.isArray(t.scale))      root.scale.fromArray(t.scale);
        root.updateMatrixWorld(true);
    }
    return actor;
}

// ---------------------------------------------------------------------
// Convenience: register with SceneSystem and wait for load
// ---------------------------------------------------------------------
export async function addSplatActorToSceneSystem(sceneSystem, options) {
    const actor = createSplatActor(options);
    sceneSystem.addActor(actor);
    const splat = actor.getComponentByClass(SplatComponent);
    if (splat?.loadPromise) await splat.loadPromise;
    return actor;
}
