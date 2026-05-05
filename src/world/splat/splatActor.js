// src/world/splat/splatActor.js
//
// Phase 2: SplatActor — wraps a Gaussian Splat as a first-class scene actor.

import * as THREE from 'three';
import { ActorComponent } from '../../runtime/components/ActorComponent.js';
import { TransformComponent } from '../../runtime/components/TransformComponent.js';
import { Actor } from '../../runtime/sceneRuntime.js';
import { loadSplat } from './splatRenderer.js';
import { buildSplatMeshAuto, getSplatRenderSettings } from './perfMode.js';
import { applySplatRenderSettings, normalizeSplatRenderSettings } from './renderTuning.js';

export class SplatComponent extends ActorComponent {
    static componentKey = 'SplatComponent';

    constructor({ url = '', count = 0, renderSettings = null } = {}) {
        super();
        this.url = url;
        this.count = count;
        this.shDegree = 0;
        this.shData = null;
        this.mesh = null;
        this.loadPromise = null;
        this.bounds = new THREE.Box3();
        this.renderSettings = renderSettings
            ? normalizeSplatRenderSettings(renderSettings, renderSettings?.blendMode)
            : null;
    }

    beginPlay() {
        if (!this.url || !this.owner) return;
        if (this.loadPromise) return;

        this.loadPromise = (async () => {
            try {
                const data = await loadSplat(this.url);
                this.mesh = buildSplatMeshAuto(data);
                this.count = data.count;
                this.shDegree = data.sh?.degree || 0;
                this.shData = data.sh || null;
                this._computeBounds(data.positions);

                if (this.renderSettings) {
                    applySplatRenderSettings(this.mesh, this.renderSettings, { resetToPreset: true });
                    this.renderSettings = { ...(this.mesh.userData?.splatRenderSettings || this.renderSettings) };
                }
                this._syncOwnerUserData();

                const root = this.owner?.mesh;
                if (root && this.mesh) root.add(this.mesh);
            } catch (err) {
                console.error('[SplatComponent] load failed:', err);
                this.loadPromise = null;
            }
        })();
    }

    endPlay() {
        if (this.mesh) {
            this.mesh.parent?.remove(this.mesh);
            this.mesh.geometry?.dispose?.();
            this.mesh.material?.dispose?.();
            this.mesh = null;
        }
        this.loadPromise = null;
    }

    _computeBounds(positions) {
        this.bounds.makeEmpty();
        const point = new THREE.Vector3();
        for (let i = 0; i < positions.length; i += 3) {
            point.set(positions[i], positions[i + 1], positions[i + 2]);
            this.bounds.expandByPoint(point);
        }
    }

    _syncOwnerUserData() {
        if (!this.owner) return;

        const nextUserData = {
            ...(this.owner.userData || {}),
            splatUrl: this.url,
        };

        if (this.renderSettings) {
            nextUserData.splatRenderSettings = { ...this.renderSettings };
        }

        this.owner.userData = nextUserData;
    }

    setRenderSettings(settings = {}, opts = {}) {
        const fallback = this.renderSettings || getSplatRenderSettings();
        const requestedBlendMode = settings?.blendMode || fallback.blendMode;
        const nextInput = opts.resetToPreset
            ? { ...settings, blendMode: requestedBlendMode }
            : { ...(this.renderSettings || fallback), ...settings, blendMode: requestedBlendMode };
        const next = normalizeSplatRenderSettings(nextInput, requestedBlendMode);

        this.renderSettings = {
            blendMode: next.blendMode,
            radius: next.radius,
            alphaCutoff: next.alphaCutoff,
        };

        if (this.mesh) {
            applySplatRenderSettings(this.mesh, this.renderSettings, { resetToPreset: true });
        }

        this._syncOwnerUserData();
        return this.renderSettings;
    }

    toJSON() {
        return {
            type: 'SplatComponent',
            url: this.url,
            count: this.count,
        };
    }
}

export function createSplatActor({ url, name = 'Splat', id = '', position = null, renderSettings = null } = {}) {
    if (!url) throw new Error('[splatActor] createSplatActor requires { url }');

    const defaults = getSplatRenderSettings();
    const initialRenderSettings = normalizeSplatRenderSettings(
        renderSettings || defaults,
        renderSettings?.blendMode || defaults.blendMode,
    );

    const root = new THREE.Group();
    root.name = name;
    root.userData.splatUrl = url;
    root.userData.splatRenderSettings = { ...initialRenderSettings };
    if (position) root.position.copy(position);

    const actor = new Actor({
        id: id || `splat-${Math.random().toString(36).slice(2, 10)}`,
        name,
        kind: 'splat',
        mesh: root,
        userData: {
            splatUrl: url,
            splatRenderSettings: { ...initialRenderSettings },
        },
    });

    actor.addComponent(new TransformComponent());
    actor.addComponent(new SplatComponent({ url, renderSettings: initialRenderSettings }));

    return actor;
}

export function serializeSplatActor(actor) {
    if (!actor || actor.kind !== 'splat') return null;
    const root = actor.mesh;
    const splat = actor.getComponentByClass(SplatComponent);
    const renderSettings = splat?.renderSettings || actor.userData?.splatRenderSettings || null;

    return {
        kind: 'splat',
        id: actor.id,
        name: actor.rootNode?.name ?? root?.name ?? 'Splat',
        transform: {
            position: root ? root.position.toArray() : [0, 0, 0],
            quaternion: root ? root.quaternion.toArray() : [0, 0, 0, 1],
            scale: root ? root.scale.toArray() : [1, 1, 1],
        },
        userData: {
            splatUrl: splat?.url ?? actor.userData?.splatUrl ?? '',
            ...(renderSettings ? { splatRenderSettings: { ...renderSettings } } : {}),
        },
        components: splat ? [splat.toJSON()] : [],
    };
}

export function deserializeSplatActor(json) {
    const url = json?.userData?.splatUrl
        ?? json?.splatUrl
        ?? json?.components?.find?.((c) => c?.type === 'SplatComponent')?.url
        ?? '';
    if (!url) throw new Error('[splatActor] deserializeSplatActor: missing splatUrl');

    const actor = createSplatActor({
        id: json.id ?? '',
        name: json.name ?? 'Splat',
        url,
        renderSettings: json?.userData?.splatRenderSettings ?? null,
    });

    const transform = json.transform ?? {};
    const root = actor.mesh;
    if (root) {
        if (Array.isArray(transform.position)) root.position.fromArray(transform.position);
        if (Array.isArray(transform.quaternion)) root.quaternion.fromArray(transform.quaternion);
        if (Array.isArray(transform.scale)) root.scale.fromArray(transform.scale);
        root.updateMatrixWorld(true);
    }

    return actor;
}

export function getSplatActorRenderSettings(actor) {
    if (!actor || actor.kind !== 'splat') return null;
    const splat = actor.getComponentByClass?.(SplatComponent) || null;
    const fallback = getSplatRenderSettings();
    const settings = splat?.renderSettings
        || actor.userData?.splatRenderSettings
        || actor.mesh?.userData?.splatRenderSettings
        || fallback;
    return normalizeSplatRenderSettings(settings, settings?.blendMode || fallback.blendMode);
}

export function setSplatActorRenderSettings(actor, settings = {}, opts = {}) {
    if (!actor || actor.kind !== 'splat') return null;
    const splat = actor.getComponentByClass?.(SplatComponent) || null;
    return splat?.setRenderSettings(settings, opts) || null;
}

export async function addSplatActorToSceneSystem(sceneSystem, options) {
    const actor = createSplatActor(options);
    sceneSystem.addActor(actor);
    const splat = actor.getComponentByClass(SplatComponent);
    if (splat?.loadPromise) await splat.loadPromise;
    return actor;
}
