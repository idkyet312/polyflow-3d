// Actor "core / instance" visual-inheritance system, extracted from
// src/app/runtime.js.
//
// An actor can be a *core* (a template) or an *instance* that inherits the
// core's visual rules (root material, per-submesh material overrides, and
// component tree). syncActorCoreInstances() runs each frame: it partitions the
// live actors into cores + instances, and re-applies a core's serialized
// visual rules to its instances whenever the core's signature changes.
//
//   const actorCore = createActorCore({
//       gameplay,
//       getSceneSystem: () => sceneSystem,
//       getDynamicPropById, getActorRenderObject, rebuildActorPhysics,
//       serializeObjectMaterialState, serializeObjectMaterialOverrides,
//       serializeComponentTree,
//       applyObjectMaterialState, applyObjectMaterialOverrides,
//       deserializeComponentTree,
//   });
//   actorCore.syncActorCoreInstances();   // frame loop
//
// actorCoreSyncState (per-core signature cache) and the per-frame instance
// buckets are owned by the factory closure — nothing outside reads them.
// actorInheritsCore + getActorCoreSource are also consumed by sceneActorUi via
// dep-injection; the runtime aliases them from this factory's return.

export function createActorCore({
    gameplay = { active: false },
    getSceneSystem = () => null,
    getDynamicPropById = () => null,
    getActorRenderObject = () => null,
    rebuildActorPhysics = () => {},
    serializeObjectMaterialState = () => null,
    serializeObjectMaterialOverrides = () => [],
    serializeComponentTree = () => [],
    applyObjectMaterialState = () => {},
    applyObjectMaterialOverrides = () => {},
    deserializeComponentTree = () => {},
} = {}) {
    // Per-core visual-rule signature cache (coreId -> { signature }). Prevents
    // re-applying identical rules every frame.
    const actorCoreSyncState = new Map();
    // Reused per-frame buckets for syncActorCoreInstances; closure-scoped to
    // avoid per-frame allocation. Cleared at the top of each call.
    const _coreInstanceBuckets = new Map(); // coreId -> instance actor[]

    function getActorCoreInfo(actor) {
        return actor?.userData?.actorCore ?? null;
    }

    function getActorCoreId(actor) {
        const core = getActorCoreInfo(actor);
        return core?.coreId || actor?.id || '';
    }

    function actorInheritsCore(actor) {
        const core = getActorCoreInfo(actor);
        return core?.inheritsRules === true && !!core.coreId && core.coreId !== actor?.id;
    }

    function getActorCoreSource(actor) {
        const coreId = getActorCoreId(actor);
        return coreId && coreId !== actor?.id ? getDynamicPropById(coreId) || actor : actor;
    }

    function serializeCoreVisualRules(actor) {
        const mesh = getActorRenderObject(actor);
        if (!mesh) return null;
        return {
            rootMaterial: serializeObjectMaterialState(mesh),
            materialOverrides: serializeObjectMaterialOverrides(mesh),
            components: serializeComponentTree(mesh),
        };
    }

    function applyCoreVisualRulesToInstance(instanceActor, rules) {
        const mesh = getActorRenderObject(instanceActor);
        if (!mesh || !rules) return;
        applyObjectMaterialState(mesh, rules.rootMaterial);
        if (Array.isArray(rules.materialOverrides) && rules.materialOverrides.length > 0) {
            applyObjectMaterialOverrides(mesh, rules.materialOverrides);
        }
        deserializeComponentTree(mesh, JSON.parse(JSON.stringify(rules.components || [])));
        mesh.userData.hasMaterialOverrides = true;
        mesh.updateMatrixWorld(true);
        if (!gameplay.active) {
            rebuildActorPhysics(instanceActor);
        }
    }

    function syncActorCoreInstances() {
        const sceneSystem = getSceneSystem();
        if (!sceneSystem?.actors?.size) return;

        const buckets = _coreInstanceBuckets;
        buckets.clear();

        // Single pass: partition into cores (bucket keys) and instances (bucket values).
        // Core actors get an empty bucket so we can prune stale entries below.
        for (const actor of sceneSystem.actors) {
            if (actorInheritsCore(actor)) {
                const sourceId = getActorCoreSource(actor)?.id;
                if (!sourceId) continue;
                let list = buckets.get(sourceId);
                if (!list) {
                    list = [];
                    buckets.set(sourceId, list);
                }
                list.push(actor);
            } else if (!buckets.has(actor.id)) {
                buckets.set(actor.id, null);
            }
        }

        // Prune sync state for cores that no longer exist.
        for (const coreId of actorCoreSyncState.keys()) {
            if (!buckets.has(coreId)) actorCoreSyncState.delete(coreId);
        }

        // Apply rules per core that actually has instances linked to it.
        for (const [coreId, linked] of buckets) {
            if (!linked || linked.length === 0) continue;
            const coreActor = getDynamicPropById(coreId);
            if (!coreActor) continue;
            const rules = serializeCoreVisualRules(coreActor);
            if (!rules) continue;
            const signature = JSON.stringify(rules);
            const cached = actorCoreSyncState.get(coreId);
            if (cached && cached.signature === signature) continue;
            if (cached) cached.signature = signature;
            else actorCoreSyncState.set(coreId, { signature });
            for (let i = 0; i < linked.length; i++) {
                applyCoreVisualRulesToInstance(linked[i], rules);
            }
        }
    }

    return {
        getActorCoreInfo,
        getActorCoreId,
        actorInheritsCore,
        getActorCoreSource,
        serializeCoreVisualRules,
        applyCoreVisualRulesToInstance,
        syncActorCoreInstances,
    };
}
