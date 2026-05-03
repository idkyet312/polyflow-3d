// src/scripting/mouseActions.js
// Extracted from main.js (readMouseActionDrafts through runMouseAction).
// Mouse action scripting: draft persistence, editor UI sync,
// script compilation, API construction, and runtime execution.

import * as THREE from 'three';
import { buildUeContext } from './ueApi.js';

// ─── Module-scope deps populated by setupMouseActions ──────────────────────
let mouseActionState, MouseActionFunction, MOUSE_ACTION_STORAGE_KEY, DEFAULT_MOUSE_ACTION_SCRIPTS;
let objectScriptState;

// Engine state
let scene, camera, renderer, currentMesh, gameplay, showcase, physics, sceneSystem;
let runtimeAudio, getRuntimeHud;

// Functions
let playSoundAtLocation, raycastWorld, spawnDynamicPrimitive, spawnImportedProp;
let spawnDrivableCar, destroyDynamicPhysicsProp;
let enterGameplay, exitGameplay, respawnPlayer, syncCameraToCharacter, applyGameplayCameraRotation;
let readObjectScriptDrafts;

// DOM refs
let inputActionsEditor, inputActionLeftBtn, inputActionRightBtn, inputActionMode;
let inputActionEditorInput, inputActionsEditorStatus, mouseActionStatus;

export function setupMouseActions(deps) {
    ({
        mouseActionState,
        MouseActionFunction,
        MOUSE_ACTION_STORAGE_KEY,
        DEFAULT_MOUSE_ACTION_SCRIPTS,
        objectScriptState,
        scene,
        camera,
        renderer,
        currentMesh,
        gameplay,
        showcase,
        physics,
        sceneSystem,
        runtimeAudio,
        getRuntimeHud,
        playSoundAtLocation,
        raycastWorld,
        spawnDynamicPrimitive,
        spawnImportedProp,
        spawnDrivableCar,
        destroyDynamicPhysicsProp,
        enterGameplay,
        exitGameplay,
        respawnPlayer,
        syncCameraToCharacter,
        applyGameplayCameraRotation,
        readObjectScriptDrafts,
    } = deps);

    // DOM refs resolved at setup time (IDs match index.html)
    inputActionsEditor = document.getElementById('input-actions-editor');
    inputActionLeftBtn = document.getElementById('input-action-left');
    inputActionRightBtn = document.getElementById('input-action-right');
    inputActionMode = document.getElementById('input-actions-mode');
    inputActionEditorInput = document.getElementById('input-action-editor-input');
    inputActionsEditorStatus = document.getElementById('input-actions-editor-status');
    mouseActionStatus = document.getElementById('mouse-action-status');
}

export function readMouseActionDrafts() {
    try {
        const rawValue = window.localStorage.getItem(MOUSE_ACTION_STORAGE_KEY);
        if (!rawValue) return null;
        const parsedValue = JSON.parse(rawValue);
        return parsedValue && typeof parsedValue === 'object' ? parsedValue : null;
    } catch (error) {
        console.warn('Failed to load mouse action drafts.', error);
        return null;
    }
}

export function saveMouseActionDrafts() {
    try {
        window.localStorage.setItem(MOUSE_ACTION_STORAGE_KEY, JSON.stringify({
            leftSource: mouseActionState.leftSource,
            rightSource: mouseActionState.rightSource,
        }));
    } catch (error) {
        console.warn('Failed to save mouse action drafts.', error);
    }
}

export function getMouseActionLabel(button) {
    return button === 'right' ? 'Right' : 'Left';
}

export function getMouseActionMessage() {
    const leftState = mouseActionState.leftError ? `Left error: ${mouseActionState.leftError}` : 'Left ready';
    const rightState = mouseActionState.rightError ? `Right error: ${mouseActionState.rightError}` : 'Right ready';
    const modeState = gameplay.active ? 'Play mode: mouse actions are armed.' : 'Showcase mode: mouse actions are disabled.';
    return `${modeState} ${leftState}. ${rightState}.`;
}

export function updateMouseActionStatus(extraMessage = '') {
    if (!mouseActionStatus) return;
    mouseActionStatus.textContent = extraMessage ? `${getMouseActionMessage()} ${extraMessage}` : getMouseActionMessage();
}

export function syncInputActionsEditor() {
    if (inputActionLeftBtn) {
        inputActionLeftBtn.classList.toggle('viewer-toggle-btn-active', mouseActionState.selectedButton === 'left');
    }

    if (inputActionRightBtn) {
        inputActionRightBtn.classList.toggle('viewer-toggle-btn-active', mouseActionState.selectedButton === 'right');
    }

    if (inputActionMode) {
        inputActionMode.textContent = `Trigger: ${mouseActionState.selectedButton === 'right' ? 'Right' : 'Left'} Mouse Button`;
    }

    if (inputActionEditorInput) {
        inputActionEditorInput.value = mouseActionState.selectedButton === 'right'
            ? mouseActionState.rightSource
            : mouseActionState.leftSource;
    }

    if (inputActionsEditorStatus) {
        const error = mouseActionState.selectedButton === 'right' ? mouseActionState.rightError : mouseActionState.leftError;
        inputActionsEditorStatus.textContent = error
            ? `${getMouseActionLabel(mouseActionState.selectedButton)} mouse action error: ${error}`
            : `${getMouseActionLabel(mouseActionState.selectedButton)} mouse action ready.`;
    }
}

export function openInputActionsEditor(button = mouseActionState.selectedButton) {
    mouseActionState.selectedButton = button === 'right' ? 'right' : 'left';
    syncInputActionsEditor();
    if (inputActionsEditor) {
        inputActionsEditor.hidden = false;
    }
}

export function closeInputActionsEditor() {
    if (inputActionsEditor) {
        inputActionsEditor.hidden = true;
    }
}

export function updateSelectedMouseActionSource() {
    if (!inputActionEditorInput) return;

    if (mouseActionState.selectedButton === 'right') {
        mouseActionState.rightSource = inputActionEditorInput.value;
    } else {
        mouseActionState.leftSource = inputActionEditorInput.value;
    }
}

export function compileMouseActionScript(source) {
    const normalizedSource = typeof source === 'string' ? source.trim() : '';

    if (!normalizedSource) {
        return new MouseActionFunction('api', '"use strict"; return;');
    }

    return new MouseActionFunction('api', `
        "use strict";
        const { THREE, scene, camera, renderer, currentMesh, gameplay, showcase, physics, event, button, mode, spawnDynamicPrimitive, spawnImportedProp,
            FVector, FRotator, FTransform, FHitResult, ECollisionChannel, AActor, AHUD, UAudioComponent, UUserWidget, UTextWidget, UImageWidget, UProgressBarWidget, UButtonWidget, UPrimitiveComponent, UTransformComponent, UGameInstance, UWorld, AGameModeBase, AGameMode, APlayerController, APawn, ACharacter, Self, HUD, WidgetAPI, UnrealWidgetAPI, World, GameInstance, GameMode, PlayerController, Pawn, Character, CreateWidget, GetHUD, GetWorld, GetGameInstance, GetGameMode, GetPlayerController, GetPlayerPawn, GetPlayerCharacter, DeltaTime, Hit } = api;
        ${normalizedSource}
    `);
}

export function buildMouseActionApi(event, button) {
    const legacyApi = {
        THREE,
        scene,
        camera,
        renderer,
        currentMesh,
        gameplay,
        showcase,
        physics,
        event,
        button,
        mode: gameplay.active ? 'play' : 'showcase',
        spawnDynamicPrimitive,
        spawnImportedProp,
    };

    return buildUeContext(
        legacyApi,
        {
            scene,
            camera,
            sceneSystem,
            physics,
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
            deltaTime: 0,
        },
        null,
        null,
    );
}

export function applyMouseActionScripts({ persist = true } = {}) {
    updateSelectedMouseActionSource();

    mouseActionState.leftError = '';
    mouseActionState.rightError = '';

    try {
        mouseActionState.leftCompiled = compileMouseActionScript(mouseActionState.leftSource);
    } catch (error) {
        mouseActionState.leftError = error?.message || String(error);
        mouseActionState.leftCompiled = null;
        alert(`error: ${mouseActionState.leftError}`);
    }

    try {
        mouseActionState.rightCompiled = compileMouseActionScript(mouseActionState.rightSource);
    } catch (error) {
        mouseActionState.rightError = error?.message || String(error);
        mouseActionState.rightCompiled = null;
        alert(`error: ${mouseActionState.rightError}`);
    }

    if (persist) {
        saveMouseActionDrafts();
    }

    syncInputActionsEditor();
    updateMouseActionStatus(persist ? 'Snippets applied.' : '');
}

export function resetMouseActionScripts() {
    mouseActionState.leftSource = DEFAULT_MOUSE_ACTION_SCRIPTS.left;
    mouseActionState.rightSource = DEFAULT_MOUSE_ACTION_SCRIPTS.right;
    syncInputActionsEditor();
    applyMouseActionScripts({ persist: true });
    updateMouseActionStatus('Defaults restored.');
}

export function initializeMouseActionScripts() {
    objectScriptState.drafts = readObjectScriptDrafts();
    mouseActionState.leftSource = DEFAULT_MOUSE_ACTION_SCRIPTS.left;
    mouseActionState.rightSource = DEFAULT_MOUSE_ACTION_SCRIPTS.right;
    syncInputActionsEditor();
    applyMouseActionScripts({ persist: true });
    updateMouseActionStatus();
}

export function runMouseAction(button, event) {
    if (!gameplay.active || !renderer) return false;

    const compiledAction = button === 'right' ? mouseActionState.rightCompiled : mouseActionState.leftCompiled;
    if (!compiledAction) return false;

    event.preventDefault();
    event.stopPropagation();

    Promise.resolve(compiledAction(buildMouseActionApi(event, button)))
        .then(() => {
            updateMouseActionStatus(`${getMouseActionLabel(button)} mouse action ran in Play mode.`);
        })
        .catch((error) => {
            const errorMessage = error?.message || String(error);
            if (button === 'right') {
                mouseActionState.rightError = errorMessage;
            } else {
                mouseActionState.leftError = errorMessage;
            }
            alert(`error: ${errorMessage}`);
            updateMouseActionStatus(`${getMouseActionLabel(button)} mouse action failed: ${errorMessage}`);
        });

    return true;
}
