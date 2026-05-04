// src/scripting/scriptState.js
// Extracted from main.js (chore/main-js-shrink-2). Owns:
//   - script-state primitives (createObjectScriptState, draft sanitize/read/save)
//   - actor identity / metadata helpers (ensureActorIdentity, getActorMetadata,
//     getActorScriptState, ensureActorScriptState)
//   - runtime prop-id counters
//   - per-frame collision-script driver (updateDynamicBodyCollisionScripts)
//   - object-script editor pointerdown/keydown plumbing.

import * as THREE from 'three';

let physics, gameplay, objectScriptState, debugConsoleState;
let importedPropState;
let renderer;
let objectScriptMenu, objectScriptEditor;
let OBJECT_SCRIPT_STORAGE_KEY;
let tempVectorA;
let copyJoltVector;
let getDynamicPropById, getActorBody, getActorRenderObject;
let getMetadataComponent, getScriptComponent, getPhysicsBodyComponent;
let ensureActorScriptComponent;
let runObjectEventScript, hasEnabledDynamicPropEvent;
let closeObjectScriptMenu, closeObjectScriptEditor;

export function installScriptState(deps) {
    ({
        physics, gameplay, objectScriptState, debugConsoleState,
        importedPropState,
        renderer,
        objectScriptMenu, objectScriptEditor,
        OBJECT_SCRIPT_STORAGE_KEY,
        tempVectorA,
        copyJoltVector,
        getDynamicPropById, getActorBody, getActorRenderObject,
        getMetadataComponent, getScriptComponent, getPhysicsBodyComponent,
        ensureActorScriptComponent,
        runObjectEventScript, hasEnabledDynamicPropEvent,
        closeObjectScriptMenu, closeObjectScriptEditor,
    } = deps);
}

export function createDefaultObjectEventState(eventName) {
    return {
        source: '',
        compiled: null,
        error: '',
        enabled: false,
        running: false,
        eventName,
        // UE lifecycle bookkeeping — populated lazily on first run.
        handles: null,
        beganPlay: false,
    };
}

export function createObjectScriptState(propId = '') {
    return {
        propId,
        tick: createDefaultObjectEventState('tick'),
        collision: createDefaultObjectEventState('collision'),
        activeCollisions: new Set(),
    };
}

export function sanitizeObjectScriptDrafts(rawValue) {
    if (!rawValue || typeof rawValue !== 'object') {
        return {};
    }

    const drafts = {};

    Object.entries(rawValue).forEach(([propId, value]) => {
        if (!value || typeof value !== 'object') return;

        drafts[propId] = {
            tick: typeof value.tick === 'string' ? value.tick : '',
            tickEnabled: value.tickEnabled === true,
            collision: typeof value.collision === 'string' ? value.collision : '',
        };
    });

    return drafts;
}

export function readObjectScriptDrafts() {
    try {
        const rawValue = window.localStorage.getItem(OBJECT_SCRIPT_STORAGE_KEY);
        if (!rawValue) return {};

        return sanitizeObjectScriptDrafts(JSON.parse(rawValue));
    } catch (error) {
        console.warn('Failed to load object script drafts.', error);
        return {};
    }
}

export function saveObjectScriptDrafts() {
    try {
        window.localStorage.setItem(OBJECT_SCRIPT_STORAGE_KEY, JSON.stringify(objectScriptState.drafts));
    } catch (error) {
        console.warn('Failed to save object script drafts.', error);
    }
}

export function ensureObjectScriptDraftEntry(propId) {
    if (!propId) {
        return { tick: '', tickEnabled: false, collision: '' };
    }

    if (!objectScriptState.drafts[propId]) {
        objectScriptState.drafts[propId] = {
            tick: '',
            tickEnabled: false,
            collision: '',
        };
    }

    return objectScriptState.drafts[propId];
}

export function syncRuntimePropIdCounter(propId) {
    if (typeof propId !== 'string') return;

    const match = /^prop-(\d+)$/.exec(propId);
    if (!match) return;

    const nextId = Number.parseInt(match[1], 10) + 1;
    if (Number.isFinite(nextId)) {
        objectScriptState.nextPropId = Math.max(objectScriptState.nextPropId, nextId);
    }
}

export function createRuntimePropId() {
    let propId = '';
    do {
        propId = `prop-${objectScriptState.nextPropId++}`;
    } while (getDynamicPropById(propId));

    ensureObjectScriptDraftEntry(propId);
    return propId;
}

export function getActorScriptState(prop) {
    return getScriptComponent(prop)?.state ?? prop?.scripts ?? null;
}

export function getActorMetadata(prop) {
    return getMetadataComponent(prop) ?? null;
}

export function ensureActorIdentity(prop) {
    if (!prop) return prop;

    const propId = prop.id || createRuntimePropId();
    prop.id = propId;
    syncRuntimePropIdCounter(propId);
    const mesh = getActorRenderObject(prop);
    if (mesh?.userData) {
        mesh.userData.dynamicPropId = propId;
    }

    return prop;
}

export function ensureActorScriptState(prop) {
    if (!prop) return null;

    const existingState = getActorScriptState(prop);
    if (existingState) {
        return existingState;
    }

    ensureActorIdentity(prop);
    const scriptState = createObjectScriptState(prop.id);
    ensureActorScriptComponent(prop, scriptState);
    prop.scripts = scriptState;
    return scriptState;
}

export function resetAllScriptLifecycleHandles() {
    for (let i = 0; i < physics.dynamicBodies.length; i++) {
        const prop = physics.dynamicBodies[i];
        const state = getActorScriptState(prop);
        if (!state) continue;
        if (state.tick) { state.tick.beganPlay = false; }
        if (state.collision) { state.collision.beganPlay = false; }
    }
}

export function registerCollisionForProp(contactMap, prop, collisionKey, collision) {
    if (!getActorScriptState(prop)?.collision?.enabled) return;

    let propContacts = contactMap.get(prop.id);
    if (!propContacts) {
        propContacts = new Map();
        contactMap.set(prop.id, propContacts);
    }

    propContacts.set(collisionKey, collision);
}

export function updateDynamicBodyCollisionScripts() {
    if (!gameplay.active || !physics.dynamicBodies.length || !hasEnabledDynamicPropEvent('collision')) return;
    const COLLISION_SPEED_THRESHOLD = 0.1;

    const isBodyAwake = (prop, body) => {
        if (!body) return true;

        const physicsComponent = getPhysicsBodyComponent(prop);
        return physicsComponent?.isAwake?.()
            ?? (typeof physics.bodyInterface?.IsActive === 'function'
                ? physics.bodyInterface.IsActive(body.GetID())
                : true);
    };

    const wakeBody = (prop, body) => {
        if (!body || isBodyAwake(prop, body)) return;

        const physicsComponent = getPhysicsBodyComponent(prop);
        physicsComponent?.activate?.();
        if (!physicsComponent?.activate && typeof physics.bodyInterface?.ActivateBody === 'function') {
            physics.bodyInterface.ActivateBody(body.GetID());
        }
    };

    const getBodySpeed = (body) => {
        if (!body) return Number.POSITIVE_INFINITY;
        const velocity = copyJoltVector(tempVectorA, physics.bodyInterface.GetLinearVelocity(body.GetID()));
        return velocity.length();
    };

    const targetEntries = physics.dynamicBodies
        .flatMap((prop) => {
            const mesh = getActorRenderObject(prop);
            if (!mesh) return [];

            return [{
                prop,
                mesh,
                body: getActorBody(prop),
                bounds: new THREE.Box3().setFromObject(mesh),
            }];
        });

    const entries = physics.dynamicBodies
        .flatMap((prop) => {
            const scriptState = getActorScriptState(prop);
            if (!scriptState?.collision?.enabled) return [];

            const mesh = getActorRenderObject(prop);
            if (!mesh) return [];

            const body = getActorBody(prop);
            if (!isBodyAwake(prop, body)) return [];

            const speed = getBodySpeed(body);
            if (speed <= COLLISION_SPEED_THRESHOLD) return [];

            const bounds = new THREE.Box3().setFromObject(mesh);
            const wakeBounds = bounds.clone();
            if (prop.kind === 'vehicle') {
                const wakePadding = THREE.MathUtils.clamp(speed * 0.05, 0.18, 0.75);
                wakeBounds.expandByScalar(wakePadding);
            }

            return [{
                prop,
                mesh,
                body,
                bounds,
                wakeBounds,
            }];
        });

    const contactMap = new Map();
    const processedPairs = new Set();

    for (let index = 0; index < entries.length; index++) {
        const current = entries[index];

        for (let otherIndex = 0; otherIndex < targetEntries.length; otherIndex++) {
            const other = targetEntries[otherIndex];
            if (other.prop.id === current.prop.id) continue;

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

            registerCollisionForProp(contactMap, current.prop, collisionKey, {
                type: 'prop',
                otherProp: other.prop,
                otherObject: other.mesh,
                otherBody: other.body,
            });

            if (getActorScriptState(other.prop)?.collision?.enabled) {
                registerCollisionForProp(contactMap, other.prop, collisionKey, {
                    type: 'prop',
                    otherProp: current.prop,
                    otherObject: current.mesh,
                    otherBody: current.body,
                });
            }
        }
    }

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

export function handleObjectScriptGlobalPointerDown(event) {
    const clickedInsideMenu = objectScriptMenu && !objectScriptMenu.hidden && objectScriptMenu.contains(event.target);
    const clickedInsideEditor = objectScriptEditor && !objectScriptEditor.hidden && objectScriptEditor.contains(event.target);

    if (!clickedInsideMenu && objectScriptState.menuOpen) {
        closeObjectScriptMenu();
    }

    if (!clickedInsideEditor && objectScriptState.editorOpen && event.target !== renderer?.domElement) {
        closeObjectScriptEditor();
    }
}

export function handleObjectScriptKeydown(event) {
    if (event.key !== 'Escape') return;

    if (debugConsoleState.visible) {
        return;
    }

    if (objectScriptState.menuOpen) {
        closeObjectScriptMenu();
    }

    if (objectScriptState.editorOpen) {
        closeObjectScriptEditor();
    }
}
