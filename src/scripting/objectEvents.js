// src/scripting/objectEvents.js
// Extracted from main.js lines 4261–4923.
// Object event scripting: compile, sync, spawn, manage prop actors, UI handlers,
// and per-tick/collision script dispatch.

import * as THREE from 'three';
import {
    createActor,
    ensureActorScriptComponent,
    AudioComponent,
    getMetadataComponent,
    getPhysicsBodyComponent,
    getRenderComponent,
    getScriptComponent,
    PhysicsComponent,
    TransformComponent,
} from '../runtime/sceneRuntime.js';
import { assetRegistry } from '../runtime/assets/AssetRegistry.js';
import { detectsUeLifecycle, buildUeContext } from '../scripting/ueApi.js';
import { engineApi } from '../runtime/engineApi.js';

// ─── Module-scope deps populated by setupObjectEvents ─────────────────────
let ObjectEventFunction;

// State objects (passed by reference)
let objectScriptState, mobileState, gameplay, showcase, physics, runtimeAudio,
    importedPropState, sceneSystem;

// DOM refs
let objectScriptMenu, objectScriptEditor, objectScriptEditorTitle,
    objectScriptEditorTarget, objectScriptEditorMode, objectScriptEditorInput,
    objectScriptEditorStatus, objectScriptEditorApplyBtn, objectScriptEditorClearBtn,
    objectScriptEditorCancelBtn, objectScriptTickToggleRow, objectScriptTickToggleInput,
    container;

// Three.js core refs
let scene, camera, renderer, currentMesh, transformControl;
let raycaster, pointerNdc, tempVectorA;

// Functions from main.js
let ensureActorIdentity, ensureObjectScriptDraftEntry, createObjectScriptState,
    saveObjectScriptDrafts, ensureActorScriptState, getActorScriptState,
    getActorMetadata, getActorRenderObject, getActorBody,
    hasEnabledDynamicPropEvent, selectShowcaseActor, playSoundAtLocation,
    spawnDynamicPrimitive, spawnImportedProp, spawnDrivableCar,
    destroyDynamicPhysicsProp, raycastWorld, enterGameplay, exitGameplay,
    respawnPlayer, syncCameraToCharacter, applyGameplayCameraRotation,
    getRuntimeHud, TEST_SOUND_ID;

export function setupObjectEvents(deps) {
    ({
        ObjectEventFunction,
        objectScriptState,
        mobileState,
        gameplay,
        showcase,
        physics,
        runtimeAudio,
        importedPropState,
        sceneSystem,
        objectScriptMenu,
        objectScriptEditor,
        objectScriptEditorTitle,
        objectScriptEditorTarget,
        objectScriptEditorMode,
        objectScriptEditorInput,
        objectScriptEditorStatus,
        objectScriptEditorApplyBtn,
        objectScriptEditorClearBtn,
        objectScriptEditorCancelBtn,
        objectScriptTickToggleRow,
        objectScriptTickToggleInput,
        container,
        scene,
        camera,
        renderer,
        currentMesh,
        transformControl,
        raycaster,
        pointerNdc,
        tempVectorA,
        ensureActorIdentity,
        ensureObjectScriptDraftEntry,
        createObjectScriptState,
        saveObjectScriptDrafts,
        ensureActorScriptState,
        getActorScriptState,
        getActorMetadata,
        getActorRenderObject,
        getActorBody,
        hasEnabledDynamicPropEvent,
        selectShowcaseActor,
        playSoundAtLocation,
        spawnDynamicPrimitive,
        spawnImportedProp,
        spawnDrivableCar,
        destroyDynamicPhysicsProp,
        raycastWorld,
        enterGameplay,
        exitGameplay,
        respawnPlayer,
        syncCameraToCharacter,
        applyGameplayCameraRotation,
        getRuntimeHud,
        TEST_SOUND_ID,
    } = deps);
}

// ─── Script compilation ──────────────────────────────────────────────────────

function getActorRuleSourceId(prop) {
    const core = prop?.userData?.actorCore;
    if (core?.inheritsRules === true && typeof core.coreId === 'string' && core.coreId && core.coreId !== prop.id) {
        return core.coreId;
    }
    return prop?.id || '';
}

function getActorRuleSource(prop) {
    const sourceId = getActorRuleSourceId(prop);
    return sourceId && sourceId !== prop?.id ? getDynamicPropById(sourceId) || prop : prop;
}

function syncActorsUsingRuleSource(sourceId) {
    if (!sourceId || !sceneSystem) return;
    for (const actor of sceneSystem.actors) {
        if (getActorRuleSourceId(actor) === sourceId) {
            syncPropScriptState(actor);
        }
    }
}

export function compileObjectEventScript(source) {
    const normalizedSource = typeof source === 'string' ? source.trim() : '';

    if (!normalizedSource) {
        const empty = new ObjectEventFunction('api', '"use strict"; return;');
        empty.__ueLifecycle = false;
        return empty;
    }

    // UE lifecycle mode: source defines BeginPlay / Tick / OnHit / EndPlay.
    // Compile a wrapper that runs the source once to register them and returns
    // a handles map. Old flat-body scripts fall through to the legacy path so
    // existing .umap saves continue to work unchanged.
    if (detectsUeLifecycle(normalizedSource)) {
        const wrapped = new ObjectEventFunction('api', `
            "use strict";
            const { THREE, scene, camera, renderer, currentMesh, gameplay, showcase, physics, prop, actor, object, body, physicsBody, localPosition, worldPosition, eventType, deltaTime, collision, renderComponent, physicsComponent, scriptComponent, metadataComponent, PhysicsComponent, TransformComponent, spawnDynamicPrimitive, spawnImportedProp,
                FVector, FRotator, FTransform, FHitResult, ECollisionChannel, AActor, AHUD, UAudioComponent, UUserWidget, UTextWidget, UImageWidget, UProgressBarWidget, UButtonWidget, UPrimitiveComponent, UTransformComponent, UGameInstance, UWorld, AGameModeBase, AGameMode, APlayerController, APawn, ACharacter, Self, HUD, WidgetAPI, UnrealWidgetAPI, World, GameInstance, GameMode, PlayerController, Pawn, Character, CreateWidget, GetHUD, GetWorld, GetGameInstance, GetGameMode, GetPlayerController, GetPlayerPawn, GetPlayerCharacter, DeltaTime, Hit } = api;
            ${normalizedSource}
            return {
                BeginPlay: typeof BeginPlay === 'function' ? BeginPlay : undefined,
                Tick: typeof Tick === 'function' ? Tick : undefined,
                OnHit: typeof OnHit === 'function' ? OnHit : undefined,
                EndPlay: typeof EndPlay === 'function' ? EndPlay : undefined,
                OnInput: typeof OnInput === 'function' ? OnInput : undefined,
                OnInputPressed: typeof OnInputPressed === 'function' ? OnInputPressed : undefined,
                OnInputReleased: typeof OnInputReleased === 'function' ? OnInputReleased : undefined,
                OnPossessed: typeof OnPossessed === 'function' ? OnPossessed : undefined,
                OnUnpossessed: typeof OnUnpossessed === 'function' ? OnUnpossessed : undefined,
                OnTrigger: typeof OnTrigger === 'function' ? OnTrigger : undefined,
                OnTriggerExit: typeof OnTriggerExit === 'function' ? OnTriggerExit : undefined,
            };
        `);
        wrapped.__ueLifecycle = true;
        return wrapped;
    }

    const flat = new ObjectEventFunction('api', `
        "use strict";
        const { THREE, scene, camera, renderer, currentMesh, gameplay, showcase, physics, prop, actor, object, body, physicsBody, localPosition, worldPosition, eventType, deltaTime, collision, renderComponent, physicsComponent, scriptComponent, metadataComponent, PhysicsComponent, TransformComponent, spawnDynamicPrimitive, spawnImportedProp,
            FVector, FRotator, FTransform, FHitResult, ECollisionChannel, AActor, AHUD, UAudioComponent, UUserWidget, UTextWidget, UImageWidget, UProgressBarWidget, UButtonWidget, UPrimitiveComponent, UTransformComponent, UGameInstance, UWorld, AGameModeBase, AGameMode, APlayerController, APawn, ACharacter, Self, HUD, WidgetAPI, UnrealWidgetAPI, World, GameInstance, GameMode, PlayerController, Pawn, Character, CreateWidget, GetHUD, GetWorld, GetGameInstance, GetGameMode, GetPlayerController, GetPlayerPawn, GetPlayerCharacter, DeltaTime, Hit } = api;
        ${normalizedSource}
    `);
    flat.__ueLifecycle = false;
    return flat;
}

export function syncPropScriptState(prop) {
    if (!prop) return prop;

    ensureActorIdentity(prop);
    const propId = prop.id;
    const sourceId = getActorRuleSourceId(prop) || propId;
    const drafts = ensureObjectScriptDraftEntry(sourceId);
    const scriptState = createObjectScriptState(propId);
    scriptState.ruleSourceId = sourceId;
    scriptState.inheritsRules = sourceId !== propId;

    scriptState.tick.source = drafts.tick;
    scriptState.collision.source = drafts.collision;

    try {
        scriptState.tick.compiled = compileObjectEventScript(scriptState.tick.source);
        scriptState.tick.enabled = !!scriptState.tick.source.trim() && drafts.tickEnabled === true;
    } catch (error) {
        scriptState.tick.error = error?.message || String(error);
        scriptState.tick.compiled = null;
        scriptState.tick.enabled = false;
    }

    try {
        scriptState.collision.compiled = compileObjectEventScript(scriptState.collision.source);
        scriptState.collision.enabled = !!scriptState.collision.source.trim();
    } catch (error) {
        scriptState.collision.error = error?.message || String(error);
        scriptState.collision.compiled = null;
        scriptState.collision.enabled = false;
    }

    prop.scripts = scriptState;
    ensureActorScriptComponent(prop, scriptState);

    const mesh = getActorRenderObject(prop);
    if (mesh?.userData) {
        mesh.userData.dynamicPropId = propId;
    }

    // Pre-warm tick lifecycle handles so prefab actors that have no physics
    // body (and therefore aren't iterated by runObjectTickScripts) still get
    // their OnTrigger / OnInput / etc. handlers populated and ready.
    if (scriptState.tick.enabled && scriptState.tick.compiled?.__ueLifecycle) {
        ensureScriptHandles(prop);
    }

    return prop;
}

export function createDynamicPropActor({
    body,
    mesh,
    kind,
    templateId = '',
    userData = null,
    includeScripts = true,
}) {
    const name = userData?.label || `${kind || 'actor'}-actor`;
    const actor = sceneSystem?.createEntity
        ? sceneSystem.createEntity(name, { register: false, body, kind, templateId, userData })
        : createActor({ body, kind, templateId, userData, name });
    actor.mesh = mesh;
    // Auto-attach UE-style components so GetComponent() works on every actor.
    if (!actor.hasComponent(TransformComponent)) {
        actor.addComponent(new TransformComponent());
    }
    if (!actor.hasComponent(PhysicsComponent)) {
        const phys = new PhysicsComponent();
        phys.setPhysicsContext(physics);
        if (body) phys.setBody(body);
        actor.addComponent(phys);
    }
    if (!actor.hasComponent(AudioComponent)) {
        const audio = new AudioComponent();
        audio.setAudioRuntime(runtimeAudio);
        actor.addComponent(audio);
    }

    if (!sceneSystem?.actors?.has?.(actor)) {
        sceneSystem?.addActor(actor);
    }
    ensureActorIdentity(actor);
    return includeScripts ? syncPropScriptState(actor) : actor;
}

export function removeObjectScriptDraft(propId) {
    if (!propId || !objectScriptState.drafts[propId]) return;

    delete objectScriptState.drafts[propId];
    saveObjectScriptDrafts();
}

export function findDynamicPropByMesh(target) {
    if (!target) return null;

    // Entity bridge (Phase 1): O(1) object3D → Actor via the SceneSystem
    // registry (walks parents to the entityId-tagged root, then a map
    // lookup) instead of the old O(actors × depth) nested scan. Falls
    // through to the physics.dynamicBodies sweep below for any object not
    // owned by a registered actor, preserving exact prior behavior.
    if (sceneSystem?.entityFromObject3D) {
        const actor = sceneSystem.entityFromObject3D(target);
        if (actor) return actor;
    }

    return physics.dynamicBodies.find((prop) => {
        const mesh = getActorRenderObject(prop);
        let current = target;

        while (current) {
            if (current === mesh) {
                return true;
            }

            current = current.parent;
        }

        return false;
    }) || null;
}

export function getObjectScriptEventLabel(eventType) {
    return eventType === 'collision' ? 'Collision' : 'Tick';
}

export function getDynamicPropDisplayName(prop) {
    if (!prop) return 'No prop selected';

    const metadata = getActorMetadata(prop);
    if (metadata?.userData?.label) {
        return metadata.userData.label;
    }

    if (prop.kind === 'imported') {
        const template = assetRegistry.getImportedTemplate(prop.templateId);
        return template?.displayName || 'Imported Prop';
    }

    if (prop.kind === 'vehicle') {
        return prop.userData?.label || 'Vehicle Prop';
    }

    return prop.kind === 'sphere' ? 'Sphere Prop' : 'Cube Prop';
}

export function getDynamicPropById(propId) {
    // Entity bridge (Phase 1): O(1) id → Actor via the SceneSystem registry
    // instead of the old linear scan over every actor. Physics fallback
    // unchanged for ids not in the registry.
    if (sceneSystem?.getEntity) {
        const actor = sceneSystem.getEntity(propId);
        if (actor) return actor;
    }
    return physics.dynamicBodies.find((prop) => prop.id === propId) || null;
}

export function isTransformControlSphereHit(event, { mode = null } = {}) {
    if (!transformControl || !transformControl.enabled || !transformControl.object || !renderer || !camera) {
        return false;
    }

    if (mode && transformControl.getMode?.() !== mode) {
        return false;
    }

    const helper = transformControl.getHelper?.() ?? null;
    if (helper && helper.visible === false) {
        return false;
    }

    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return false;
    }

    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);

    const gizmoCenter = tempVectorA;
    transformControl.object.getWorldPosition(gizmoCenter);

    const activeMode = transformControl.getMode?.() ?? 'translate';
    const cameraDistance = camera.position.distanceTo(gizmoCenter);
    const modeScale = activeMode === 'scale'
        ? 1.15
        : activeMode === 'rotate'
            ? 1.35
            : 1.5;
    const sphereRadius = Math.max(0.8, cameraDistance * 0.085 * (transformControl.size || 1) * modeScale);
    const distanceToRay = Math.sqrt(raycaster.ray.distanceSqToPoint(gizmoCenter));

    return distanceToRay <= sphereRadius;
}

export function getDynamicPropHitFromEvent(event) {
    const hasActors = (sceneSystem && sceneSystem.actors.size > 0) || physics.dynamicBodies.length > 0;
    if (!renderer || !camera || !hasActors) return null;

    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);

    const targets = [];
    if (sceneSystem) {
        for (const actor of sceneSystem.actors) {
            const mesh = getActorRenderObject(actor);
            if (mesh) targets.push(mesh);
        }
    }
    physics.dynamicBodies.forEach((prop) => {
        const mesh = getActorRenderObject(prop);
        if (mesh && !targets.includes(mesh)) targets.push(mesh);
    });

    if (targets.length === 0) return null;

    const hits = raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
        const prop = findDynamicPropByMesh(hit.object);
        if (prop) {
            return { prop, hit };
        }
    }

    return null;
}

export function updateObjectScriptEditorStatus(extraMessage = '') {
    if (!objectScriptEditorStatus) return;

    const prop = getDynamicPropById(objectScriptState.targetPropId);
    const eventType = objectScriptState.targetEvent;
    const eventState = getActorScriptState(prop)?.[eventType];
    let baseMessage;

    if (eventState?.error) {
        baseMessage = `${getObjectScriptEventLabel(eventType)} code error: ${eventState.error}`;
    } else if (eventType === 'tick' && eventState?.source?.trim() && !eventState.enabled) {
        baseMessage = 'Tick code is saved but disabled. Turn on the tick toggle to run it in Play mode.';
    } else {
        baseMessage = `${getObjectScriptEventLabel(eventType)} code is ${eventState?.enabled ? 'ready' : 'empty'}.`;
    }

    objectScriptEditorStatus.textContent = extraMessage ? `${baseMessage} ${extraMessage}` : baseMessage;
}

export function syncObjectScriptEditor() {
    const prop = getDynamicPropById(objectScriptState.targetPropId);
    const eventType = objectScriptState.targetEvent;
    const eventState = getActorScriptState(prop)?.[eventType];
    const source = getActorRuleSource(prop);
    const inheritsRules = !!prop && !!source?.id && source.id !== prop.id;

    if (objectScriptEditorTitle) {
        objectScriptEditorTitle.textContent = `Attach ${getObjectScriptEventLabel(eventType)} Script`;
    }

    if (objectScriptEditorTarget) {
        objectScriptEditorTarget.textContent = inheritsRules
            ? `Target: ${getDynamicPropDisplayName(prop)} inherits ${getDynamicPropDisplayName(source)}`
            : `Target: ${getDynamicPropDisplayName(prop)}`;
    }

    if (objectScriptEditorMode) {
        objectScriptEditorMode.value = eventType === 'collision' ? 'collision' : 'tick';
    }

    if (objectScriptTickToggleRow) {
        objectScriptTickToggleRow.hidden = eventType !== 'tick';
    }

    if (objectScriptTickToggleInput) {
        objectScriptTickToggleInput.checked = eventType === 'tick' ? !!eventState?.enabled : false;
    }

    if (objectScriptEditorInput) {
        objectScriptEditorInput.value = eventState?.source || '';
    }

    updateObjectScriptEditorStatus();
}

export function closeObjectScriptMenu() {
    objectScriptState.menuOpen = false;

    if (objectScriptMenu) {
        objectScriptMenu.hidden = true;
    }
}

export function closeObjectScriptEditor() {
    objectScriptState.editorOpen = false;

    if (objectScriptEditor) {
        objectScriptEditor.hidden = true;
    }
}

export function maybeOpenObjectScriptMenuFromMobileTap(event) {
    if (!mobileState.enabled || gameplay.active || gameplay.pointerLocked || !renderer) {
        return false;
    }

    const now = performance.now();
    const withinTimeWindow = now - mobileState.lastWorldTapTime <= 320;
    const withinDistanceWindow = Math.hypot(
        event.clientX - mobileState.lastWorldTapX,
        event.clientY - mobileState.lastWorldTapY
    ) <= 28;

    mobileState.lastWorldTapTime = now;
    mobileState.lastWorldTapX = event.clientX;
    mobileState.lastWorldTapY = event.clientY;

    if (!withinTimeWindow || !withinDistanceWindow) {
        return false;
    }

    const propHit = getDynamicPropHitFromEvent(event);
    if (!propHit?.prop) {
        return false;
    }

    openObjectScriptMenu(event, propHit.prop);
    return true;
}

export function openObjectScriptMenu(event, prop) {
    if (!objectScriptMenu || !container || !prop) return;

    selectShowcaseActor(prop.id);
    objectScriptState.menuOpen = true;
    objectScriptState.menuScreenX = event.clientX;
    objectScriptState.menuScreenY = event.clientY;

    objectScriptMenu.hidden = false;

    const containerRect = container.getBoundingClientRect();
    const menuWidth = objectScriptMenu.offsetWidth || 220;
    const menuHeight = objectScriptMenu.offsetHeight || 120;
    const left = THREE.MathUtils.clamp(
        event.clientX - containerRect.left,
        12,
        Math.max(12, containerRect.width - menuWidth - 12)
    );
    const top = THREE.MathUtils.clamp(
        event.clientY - containerRect.top,
        12,
        Math.max(12, containerRect.height - menuHeight - 12)
    );

    objectScriptMenu.style.left = `${left}px`;
    objectScriptMenu.style.top = `${top}px`;
}

export function openObjectScriptEditor(eventType) {
    const prop = getDynamicPropById(objectScriptState.targetPropId);
    if (!prop || !objectScriptEditor) return;

    ensureActorScriptState(prop);

    objectScriptState.targetEvent = eventType;
    objectScriptState.editorOpen = true;
    closeObjectScriptMenu();
    syncObjectScriptEditor();
    objectScriptEditor.hidden = false;

    if (objectScriptEditorInput) {
        objectScriptEditorInput.focus();
        objectScriptEditorInput.setSelectionRange(
            objectScriptEditorInput.value.length,
            objectScriptEditorInput.value.length
        );
    }
}

export function updatePropScriptSource(prop, eventType, source, { persist = true, notify = true } = {}) {
    const sourceProp = getActorRuleSource(prop);
    const scriptState = ensureActorScriptState(sourceProp);
    if (!scriptState?.[eventType]) return false;

    const normalizedSource = typeof source === 'string' ? source : '';
    const eventState = scriptState[eventType];
    eventState.source = normalizedSource;
    eventState.error = '';

    try {
        eventState.compiled = compileObjectEventScript(normalizedSource);
        eventState.handles = null;
        eventState.beganPlay = false;
        eventState.enabled = eventType === 'tick'
            ? !!normalizedSource.trim() && !!scriptState.tick.enabled
            : !!normalizedSource.trim();
    } catch (error) {
        eventState.error = error?.message || String(error);
        eventState.compiled = null;
        eventState.handles = null;
        eventState.beganPlay = false;
        eventState.enabled = false;
        if (notify) {
            alert(`error: ${eventState.error}`);
        }
    }

    const drafts = ensureObjectScriptDraftEntry(sourceProp.id);
    drafts[eventType] = normalizedSource;
    if (eventType === 'tick') {
        drafts.tickEnabled = !!scriptState.tick.enabled;
    }

    if (persist) {
        saveObjectScriptDrafts();
    }

    syncActorsUsingRuleSource(sourceProp.id);

    // Pre-warm handles for tick-script changes so gameplay-prefab actors that
    // never get a regular tick pass (no physics body) still pick up the new
    // OnTrigger / OnInput / etc. handlers immediately after Apply.
    if (eventType === 'tick' && eventState.enabled && !eventState.error) {
        ensureScriptHandles(sourceProp);
        // Also reset transient trigger latch so a player still standing in the
        // volume gets re-triggered with the new code.
        if (sourceProp.userData) sourceProp.userData._wasInsideTrigger = false;
    }

    updateObjectScriptEditorStatus(
        eventState.error
            ? `${getObjectScriptEventLabel(eventType)} code failed to compile.`
            : `${getObjectScriptEventLabel(eventType)} code applied.`
    );

    return !eventState.error;
}

export function clearPropScriptSource(prop, eventType) {
    return updatePropScriptSource(prop, eventType, '', { persist: true, notify: false });
}

export function setPropTickEventEnabled(prop, isEnabled, { persist = true } = {}) {
    const sourceProp = getActorRuleSource(prop);
    const scriptState = ensureActorScriptState(sourceProp);
    if (!scriptState?.tick) return;

    const tickState = scriptState.tick;
    tickState.enabled = !!isEnabled && !!tickState.source.trim() && !tickState.error;

    const drafts = ensureObjectScriptDraftEntry(sourceProp.id);
    drafts.tickEnabled = !!isEnabled;

    if (persist) {
        saveObjectScriptDrafts();
    }

    syncActorsUsingRuleSource(sourceProp.id);

    updateObjectScriptEditorStatus(
        tickState.enabled
            ? 'Tick event enabled for Play mode.'
            : 'Tick event disabled.'
    );
}

export function buildObjectEventApi(prop, eventType, { deltaTime = 0, collision = null } = {}) {
    const renderComponent = getRenderComponent(prop);
    const physicsComponent = getPhysicsBodyComponent(prop);
    const scriptComponent = getScriptComponent(prop);
    const metadataComponent = getMetadataComponent(prop);
    const audioComponent = prop?.getComponentByClass?.(AudioComponent) ?? null;
    const object = renderComponent?.mesh || null;
    const body = physicsComponent?.body || null;
    const localPosition = object?.position?.clone?.() ?? null;
    const worldPosition = object ? object.getWorldPosition(new THREE.Vector3()) : null;

    const legacyApi = {
        THREE,
        scene,
        camera,
        renderer,
        currentMesh,
        gameplay,
        showcase,
        physics,
        prop,
        object,
        body,
        physicsBody: body,
        localPosition,
        worldPosition,
        eventType,
        deltaTime,
        collision,
        renderComponent,
        physicsComponent,
        scriptComponent,
        metadataComponent,
        audioComponent,
        audio: runtimeAudio,
        playSoundAtLocation,
        AudioComponent,
        PhysicsComponent,
        TransformComponent,
        TEST_SOUND_ID,
        actor: prop,
        spawnDynamicPrimitive,
        spawnImportedProp,
        // engineApi surface for prefab user-scripts. Replaces window.*
        // FX/sound/HUD calls; the api object is what scripts receive as
        // their `api` parameter (see compileObjectEventScript), so
        // `api.spawnImpactBurst(...)` resolves directly.
        ...engineApi.fx,
        ...engineApi.sound,
        ...engineApi.hud,
        ...engineApi.weapons,
    };

    return buildUeContext(
        legacyApi,
        {
            scene,
            camera,
            renderer,
            sceneSystem,
            physics,
            gameplay,
            audio: runtimeAudio,
            hud: getRuntimeHud(),
            getHUD: getRuntimeHud,
            widgetApi: window.WidgetAPI,
            unrealWidgetApi: window.UnrealWidgetAPI,
            playSoundAtLocation,
            raycastWorld: typeof raycastWorld === 'function' ? raycastWorld : null,
            spawnDynamicPrimitive,
            spawnImportedProp,
            spawnDrivableCar: typeof spawnDrivableCar === 'function' ? spawnDrivableCar : null,
            destroyActor: typeof destroyDynamicPhysicsProp === 'function' ? destroyDynamicPhysicsProp : null,
            enterGameplay: typeof enterGameplay === 'function' ? enterGameplay : null,
            exitGameplay: typeof exitGameplay === 'function' ? exitGameplay : null,
            respawnPlayer: typeof respawnPlayer === 'function' ? respawnPlayer : null,
            syncCameraToCharacter: typeof syncCameraToCharacter === 'function' ? syncCameraToCharacter : null,
            applyGameplayCameraRotation: typeof applyGameplayCameraRotation === 'function' ? applyGameplayCameraRotation : null,
            deltaTime,
        },
        prop,
        collision,
    );
}

export function handleObjectScriptRuntimeError(prop, eventType, error) {
    const eventState = getActorScriptState(prop)?.[eventType];
    if (!eventState) return;

    const errorMessage = error?.message || String(error);
    eventState.error = errorMessage;
    eventState.enabled = false;
    eventState.running = false;
    alert(`error: ${errorMessage}`);

    if (objectScriptState.targetPropId === prop.id && objectScriptState.targetEvent === eventType) {
        updateObjectScriptEditorStatus(`${getObjectScriptEventLabel(eventType)} code failed at runtime.`);
    }
}

/**
 * Force compile and resolve the tick script's lifecycle handles for an actor.
 * Useful for prefab actors that aren't part of physics.dynamicBodies and
 * therefore never get a regular runObjectTickScripts pass.
 */
export function ensureScriptHandles(prop) {
    const eventState = getActorScriptState(prop)?.tick;
    const compiled = eventState?.compiled;
    if (!eventState?.enabled || !compiled?.__ueLifecycle) return;
    if (eventState.handles) return;
    try {
        const result = compiled(buildObjectEventApi(prop, 'tick', {}));
        if (result && typeof result.then === 'function') {
            eventState.handles = {};
            result
                .then((resolved) => { eventState.handles = resolved || {}; })
                .catch((error) => {
                    eventState.handles = null;
                    handleObjectScriptRuntimeError(prop, 'tick', error);
                });
        } else {
            eventState.handles = result || {};
        }
    } catch (error) {
        handleObjectScriptRuntimeError(prop, 'tick', error);
    }
}

export function runObjectEventScript(prop, eventType, options = {}) {
    const eventState = getActorScriptState(prop)?.[eventType];
    if (!eventState?.enabled || !eventState.compiled || eventState.running) {
        return false;
    }

    const compiled = eventState.compiled;
    const api = buildObjectEventApi(prop, eventType, options);

    // UE lifecycle path: invoke the compiled wrapper once to harvest handles,
    // then dispatch the appropriate lifecycle method for this event type.
    if (compiled.__ueLifecycle) {
        try {
            if (!eventState.handles) {
                const result = compiled(api);
                if (result && typeof result.then === 'function') {
                    // Compiled wrapper is async (AsyncFunction). Mark pending so we
                    // don't kick off another invocation, then store the resolved
                    // handles once the promise settles.
                    eventState.handles = {};
                    result
                        .then((resolved) => { eventState.handles = resolved || {}; })
                        .catch((error) => {
                            eventState.handles = null;
                            handleObjectScriptRuntimeError(prop, eventType, error);
                        });
                    return false;
                }
                eventState.handles = result || {};
            }
            const handles = eventState.handles;

            // BeginPlay fires once when the tick event slot first runs in play mode.
            if (eventType === 'tick' && !eventState.beganPlay) {
                eventState.beganPlay = true;
                if (typeof handles.BeginPlay === 'function') {
                    eventState.running = true;
                    Promise.resolve(handles.BeginPlay.call(api.Self ?? null))
                        .catch((error) => handleObjectScriptRuntimeError(prop, eventType, error))
                        .finally(() => { eventState.running = false; });
                }
            }

            const target = eventType === 'collision' ? handles.OnHit : handles.Tick;
            if (typeof target !== 'function') return false;

            eventState.running = true;
            Promise.resolve(target.call(api.Self ?? null, eventType === 'collision' ? api.Hit : api.DeltaTime))
                .then(() => {
                    eventState.running = false;
                    if (objectScriptState.targetPropId === prop.id && objectScriptState.targetEvent === eventType) {
                        updateObjectScriptEditorStatus(`${getObjectScriptEventLabel(eventType)} code ran.`);
                    }
                })
                .catch((error) => {
                    handleObjectScriptRuntimeError(prop, eventType, error);
                });
            return true;
        } catch (error) {
            handleObjectScriptRuntimeError(prop, eventType, error);
            return false;
        }
    }

    // Legacy flat-body path: execute the whole script every event.
    eventState.running = true;
    Promise.resolve(compiled(api))
        .then(() => {
            eventState.running = false;
            if (objectScriptState.targetPropId === prop.id && objectScriptState.targetEvent === eventType) {
                updateObjectScriptEditorStatus(`${getObjectScriptEventLabel(eventType)} code ran.`);
            }
        })
        .catch((error) => {
            handleObjectScriptRuntimeError(prop, eventType, error);
        });

    return true;
}

export function runObjectTickScripts(delta) {
    if (!gameplay.active || !hasEnabledDynamicPropEvent('tick')) {
        return;
    }

    for (let index = 0; index < physics.dynamicBodies.length; index++) {
        const prop = physics.dynamicBodies[index];
        if (!getActorRenderObject(prop)) continue;
        runObjectEventScript(prop, 'tick', { deltaTime: delta });
    }
}

/**
 * Dispatch OnInput / OnInputPressed / OnInputReleased to the *possessed* actor
 * only (the prop the player is currently driving). Reuses the actor's `tick`
 * script slot — same compiled module — so authors keep one file per actor.
 *
 * @param {number} delta
 * @param {object} inputState  Snapshot of gameplay.input.
 * @param {string[]} pressed   Keys that went down this frame.
 * @param {string[]} released  Keys that went up this frame.
 */
export function runObjectInputScripts(delta, inputState, pressed = [], released = []) {
    if (!gameplay.active) return;
    const activeId = gameplay.activeVehicleId;
    if (!activeId) return;

    let prop = null;
    for (let i = 0; i < physics.dynamicBodies.length; i++) {
        if (physics.dynamicBodies[i]?.id === activeId) { prop = physics.dynamicBodies[i]; break; }
    }
    if (!prop) return;

    const eventState = getActorScriptState(prop)?.tick;
    const compiled = eventState?.compiled;
    if (!eventState?.enabled || !compiled?.__ueLifecycle) return;

    if (!eventState.handles) {
        try {
            const result = compiled(buildObjectEventApi(prop, 'tick', { deltaTime: delta }));
            if (result && typeof result.then === 'function') {
                eventState.handles = {};
                result
                    .then((resolved) => { eventState.handles = resolved || {}; })
                    .catch((error) => {
                        eventState.handles = null;
                        handleObjectScriptRuntimeError(prop, 'tick', error);
                    });
                return;
            }
            eventState.handles = result || {};
        } catch (error) { handleObjectScriptRuntimeError(prop, 'tick', error); return; }
    }
    const handles = eventState.handles;

    const api = buildObjectEventApi(prop, 'tick', { deltaTime: delta });
    const self = api.Self ?? null;

    if (typeof handles.OnInput === 'function') {
        try { handles.OnInput.call(self, inputState, delta); }
        catch (error) { handleObjectScriptRuntimeError(prop, 'tick', error); }
    }
    if (pressed.length && typeof handles.OnInputPressed === 'function') {
        for (const key of pressed) {
            try { handles.OnInputPressed.call(self, key); }
            catch (error) { handleObjectScriptRuntimeError(prop, 'tick', error); break; }
        }
    }
    if (released.length && typeof handles.OnInputReleased === 'function') {
        for (const key of released) {
            try { handles.OnInputReleased.call(self, key); }
            catch (error) { handleObjectScriptRuntimeError(prop, 'tick', error); break; }
        }
    }
}

/**
 * Fire OnPossessed / OnUnpossessed once when the player enters/leaves a vehicle.
 * @param {object} prop  The actor being possessed/unpossessed.
 * @param {boolean} possessed  true = enter, false = exit.
 */
export function dispatchPossessionEvent(prop, possessed) {
    if (!prop) return;
    const eventState = getActorScriptState(prop)?.tick;
    const compiled = eventState?.compiled;
    if (!eventState?.enabled || !compiled?.__ueLifecycle) return;

    if (!eventState.handles) {
        try {
            const result = compiled(buildObjectEventApi(prop, 'tick', {}));
            if (result && typeof result.then === 'function') {
                eventState.handles = {};
                result
                    .then((resolved) => { eventState.handles = resolved || {}; })
                    .catch((error) => {
                        eventState.handles = null;
                        handleObjectScriptRuntimeError(prop, 'tick', error);
                    });
                return;
            }
            eventState.handles = result || {};
        } catch (error) { handleObjectScriptRuntimeError(prop, 'tick', error); return; }
    }
    const handles = eventState.handles;
    const fn = possessed ? handles.OnPossessed : handles.OnUnpossessed;
    if (typeof fn !== 'function') return;
    const api = buildObjectEventApi(prop, 'tick', {});
    try { fn.call(api.Self ?? null); }
    catch (error) { handleObjectScriptRuntimeError(prop, 'tick', error); }
}

/**
 * Fire OnTrigger / OnTriggerExit on an actor's tick script.
 * @param {object} prop  Actor whose trigger volume the subject entered/exited.
 * @param {object|null} subject  Optional info about who entered (player/vehicle).
 * @param {boolean} entering  true = OnTrigger, false = OnTriggerExit.
 */
export function dispatchTriggerEvent(prop, subject, entering) {
    if (!prop) return;
    const eventState = getActorScriptState(prop)?.tick;
    const compiled = eventState?.compiled;
    if (!eventState?.enabled || !compiled?.__ueLifecycle) return;

    if (!eventState.handles) {
        try {
            const result = compiled(buildObjectEventApi(prop, 'tick', {}));
            if (result && typeof result.then === 'function') {
                eventState.handles = {};
                result
                    .then((resolved) => { eventState.handles = resolved || {}; })
                    .catch((error) => {
                        eventState.handles = null;
                        handleObjectScriptRuntimeError(prop, 'tick', error);
                    });
                return;
            }
            eventState.handles = result || {};
        } catch (error) { handleObjectScriptRuntimeError(prop, 'tick', error); return; }
    }
    const handles = eventState.handles;
    const fn = entering ? handles.OnTrigger : handles.OnTriggerExit;
    if (typeof fn !== 'function') return;
    const api = buildObjectEventApi(prop, 'tick', {});
    try { fn.call(api.Self ?? null, subject); }
    catch (error) { handleObjectScriptRuntimeError(prop, 'tick', error); }
}

/**
 * Look up the dynamic-body actor whose Jolt body matches the given bodyId.
 * Returns null for terrain/world-static hits.
 */
export function getActorByBodyId(bodyId) {
    if (bodyId == null || bodyId < 0) return null;
    const actors = [...physics.dynamicBodies, ...physics.staticBodies];
    for (let i = 0; i < actors.length; i++) {
        const actor = actors[i];
        const body = getActorBody(actor);
        const id = body?.GetID?.();
        if (id?.GetIndexAndSequenceNumber?.() === bodyId) return actor;
    }
    return null;
}
