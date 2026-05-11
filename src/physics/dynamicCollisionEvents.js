import * as THREE from 'three';

const COLLISION_SPEED_THRESHOLD = 0.1;

export function resetActorScriptLifecycleHandles(actors, getActorScriptState) {
    for (let index = 0; index < actors.length; index++) {
        const state = getActorScriptState(actors[index]);
        if (!state) continue;
        if (state.tick) state.tick.beganPlay = false;
        if (state.collision) state.collision.beganPlay = false;
    }
}

function registerCollisionForProp(contactMap, prop, getActorScriptState, collisionKey, collision) {
    if (!getActorScriptState(prop)?.collision?.enabled) return;

    let propContacts = contactMap.get(prop.id);
    if (!propContacts) {
        propContacts = new Map();
        contactMap.set(prop.id, propContacts);
    }

    propContacts.set(collisionKey, collision);
}

export function createDynamicCollisionEventRunner({
    physics,
    gameplay,
    spatialIndex,
    hasEnabledDynamicPropEvent,
    getActorScriptState,
    getPhysicsBodyComponent,
    getActorRenderObject,
    getActorBody,
    copyJoltVector,
    runObjectEventScript,
}) {
    const tempVector = new THREE.Vector3();

    function isBodyAwake(prop, body) {
        if (!body) return true;

        const physicsComponent = getPhysicsBodyComponent(prop);
        return physicsComponent?.isAwake?.()
            ?? (typeof physics.bodyInterface?.IsActive === 'function'
                ? physics.bodyInterface.IsActive(body.GetID())
                : true);
    }

    function wakeBody(prop, body) {
        if (!body || isBodyAwake(prop, body)) return;

        const physicsComponent = getPhysicsBodyComponent(prop);
        physicsComponent?.activate?.();
        if (!physicsComponent?.activate && typeof physics.bodyInterface?.ActivateBody === 'function') {
            physics.bodyInterface.ActivateBody(body.GetID());
        }
    }

    function getBodySpeed(body) {
        if (!body) return Number.POSITIVE_INFINITY;
        const velocity = copyJoltVector(tempVector, physics.bodyInterface.GetLinearVelocity(body.GetID()));
        return velocity.length();
    }

    function buildTargetEntries(index) {
        const entries = new Map();
        for (const entry of index.values()) {
            const prop = entry.actor;
            const mesh = getActorRenderObject(prop);
            if (!prop?.id || !mesh) continue;

            entries.set(prop.id, {
                prop,
                mesh,
                body: getActorBody(prop),
                bounds: entry.bounds,
            });
        }
        return entries;
    }

    function buildActiveEntries(targetEntriesById) {
        const entries = [];
        targetEntriesById.forEach((targetEntry) => {
            const { prop, body, bounds } = targetEntry;
            const scriptState = getActorScriptState(prop);
            if (!scriptState?.collision?.enabled) return;
            if (!isBodyAwake(prop, body)) return;

            const speed = getBodySpeed(body);
            if (speed <= COLLISION_SPEED_THRESHOLD) return;

            let wakeBounds = bounds;
            if (prop.kind === 'vehicle') {
                const wakePadding = THREE.MathUtils.clamp(speed * 0.05, 0.18, 0.75);
                wakeBounds = bounds.clone().expandByScalar(wakePadding);
            }

            entries.push({
                ...targetEntry,
                wakeBounds,
            });
        });
        return entries;
    }

    function dispatchNewCollisions(contactMap) {
        physics.dynamicBodies.forEach((prop) => {
            const scriptState = getActorScriptState(prop);
            const eventState = scriptState?.collision;
            if (!eventState?.enabled) return;

            const activeCollisions = scriptState.activeCollisions || new Set();
            const nextCollisions = contactMap.get(prop.id) || new Map();

            nextCollisions.forEach((collision, collisionKey) => {
                if (!activeCollisions.has(collisionKey)) {
                    runObjectEventScript(prop, 'collision', { collision });
                }
            });

            scriptState.activeCollisions = new Set(nextCollisions.keys());
        });
    }

    function update() {
        if (!gameplay.active || !physics.dynamicBodies.length || !hasEnabledDynamicPropEvent('collision')) return;

        const grid = spatialIndex.getIndex();
        const targetEntriesById = buildTargetEntries(grid);
        const entries = buildActiveEntries(targetEntriesById);
        const contactMap = new Map();
        const processedPairs = new Set();

        for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
            const current = entries[entryIndex];
            const nearbyEntries = grid.queryBoxEntries(current.wakeBounds || current.bounds);

            for (let otherIndex = 0; otherIndex < nearbyEntries.length; otherIndex++) {
                const other = targetEntriesById.get(nearbyEntries[otherIndex].actor?.id);
                if (!other || other.prop.id === current.prop.id) continue;

                const directHit = current.bounds.intersectsBox(other.bounds);
                const nearWakeHit = !directHit && current.wakeBounds?.intersectsBox(other.bounds);
                if (!directHit && !nearWakeHit) continue;

                if (nearWakeHit) {
                    wakeBody(other.prop, other.body);
                    continue;
                }

                const collisionKey = [current.prop.id, other.prop.id].sort().join(':');
                if (processedPairs.has(collisionKey)) continue;
                processedPairs.add(collisionKey);

                wakeBody(other.prop, other.body);

                registerCollisionForProp(contactMap, current.prop, getActorScriptState, collisionKey, {
                    type: 'prop',
                    otherProp: other.prop,
                    otherObject: other.mesh,
                    otherBody: other.body,
                });

                if (getActorScriptState(other.prop)?.collision?.enabled) {
                    registerCollisionForProp(contactMap, other.prop, getActorScriptState, collisionKey, {
                        type: 'prop',
                        otherProp: current.prop,
                        otherObject: current.mesh,
                        otherBody: current.body,
                    });
                }
            }
        }

        dispatchNewCollisions(contactMap);
    }

    return { update };
}
