import { ActorComponent } from './ActorComponent.js';

/**
 * MeshRendererComponent — the typed, entity-first home for an actor's render
 * description.
 *
 * Bridge-phase role (see plan the-nullgraph-engine-data-oriented-*.md):
 * this WRAPS, it does not replace, the legacy loose `entity.render` component.
 * `actor.mesh` still works exactly as before (it reads the legacy render
 * component). New entity-first spawns additionally attach this so that future
 * systems can query a real typed component instead of poking `entity.render`
 * or assuming a THREE.Mesh.
 *
 * It deliberately does NOT own the transform — transform stays THREE.Object3D
 * (TransformComponent is the façade). Inverting that is the explicitly
 * deferred full-migration work, not this bridge.
 *
 * Holds either a live mesh ref (today's reality) and/or asset/material IDs
 * (forward-looking, for the future AssetRegistry + RendererBackend). Either
 * may be null; this is a description, not a renderer.
 */
export class MeshRendererComponent extends ActorComponent {
    static componentKey = 'MeshRendererComponent';

    /**
     * @param {object}  desc
     * @param {import('three').Object3D|null} [desc.mesh]   live render object
     *        (the current backend's instance — Three for now).
     * @param {string}  [desc.assetId]     forward-looking geometry/model id.
     * @param {string}  [desc.materialId]  forward-looking material id.
     * @param {boolean} [desc.castShadow]
     * @param {boolean} [desc.receiveShadow]
     */
    constructor({ mesh = null, assetId = '', materialId = '', castShadow = true, receiveShadow = true } = {}) {
        super();
        this.mesh = mesh;
        this.assetId = assetId;
        this.materialId = materialId;
        this.castShadow = castShadow;
        this.receiveShadow = receiveShadow;
    }

    /**
     * Resolve the current render object. Prefers the owning actor's canonical
     * mesh (legacy render component / accessor) so this component never drifts
     * from the actual scene object after a mesh swap; falls back to the ref
     * captured at construction.
     */
    getRenderObject() {
        return this.owner?.mesh ?? this.mesh ?? null;
    }

    /** Serializable snapshot (ids only — live mesh is serialized elsewhere
     *  via the existing rootJson path; this stays renderer-agnostic). */
    toJSON() {
        return {
            assetId: this.assetId,
            materialId: this.materialId,
            castShadow: this.castShadow,
            receiveShadow: this.receiveShadow,
        };
    }
}
