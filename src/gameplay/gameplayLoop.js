// src/gameplay/gameplayLoop.js
// Extracted from main.js (chore/main-js-shrink-2). Holds the play-mode loop,
// the showcase free-fly camera, the gameplay/showcase keyboard+mouse handlers,
// the gameplay UI sync, and the small spawn / camera helpers that pair with them.
//
// External flow surfaces that stay in main.js (called from here via deps):
//   - vehicle: imported from ../vehicle/vehicleController.js (isDrivingVehicle, ...)
//   - mouse actions / object script editor: src/scripting/* (already extracted)
//   - debug console / mobile / blueprint: src/debug + src/ui + src/editor (extracted)
//   - physics: rebuildTerrainPhysicsBody / rebuildModelPhysicsBody / ensurePlayerCharacter
//     / syncCameraToCharacter / spawnDrivableCar still live in main.js — passed as deps.

import * as THREE from 'three';
import gsap from 'gsap';
import {
    isDrivingVehicle, exitVehicle, enterVehicle, clearActiveVehicle,
    updateVehicleGameplay,
} from '../vehicle/vehicleController.js';
import {
    silenceVehicleEngineAudio, updateEngineAudioDebugOverlay, playAudioTestCue,
} from '../audio/vehicleEngineAudio.js';

// Module-scope deps — populated by setupGameplayLoop. Late-init refs (worldFloor,
// mainDirectionalLight, currentMesh, pedestal, resetViewBtn, gameplayStatus, playHint)
// are exposed via getters because they are assigned AFTER wireExtractedModules
// runs (in init() at main.js around L5158).
let THREE_ /* unused, kept for parity */;
let gameplay, physics, showcase, vehicleState, blueprintState, mobileState;
let terrainBrushState, debugConsoleState, collisionDebugState, importedPropState, objectScriptState;
let camera, renderer, container;
let pointerNdc, raycaster, editorHistory, transformControl;
let gameplayLookTarget, gameplayBounds, mainDirectionalLightShadowFocus, mainDirectionalLightOffset;
let upVector, tempVectorA, tempVectorB, tempVectorC, tempVectorD, tempVectorE;
let PLAYER_SETTINGS, VEHICLE_SETTINGS, TERRAIN_Y_OFFSET;
let SHOWCASE_CAMERA_POSITION, SHOWCASE_CAMERA_TARGET;
let runtimeAudio;
let getCurrentMesh, getWorldFloor, getMainDirectionalLight, getPedestal;
let getResetViewBtn, getGameplayStatus, getPlayHint, getSceneUiList;
let setCollisionDebugEnabled;
let isEditableElement;
let runMouseAction, applyMouseActionScripts;
let handleDebugConsoleKeydown;
let closeObjectScriptMenu, closeObjectScriptEditor, maybeOpenObjectScriptMenuFromMobileTap;
let isTransformControlSphereHit, handleLightGridClick, focusShowcaseCameraOnObject;
let selectShowcaseActor, syncTransformControlState;
let snapshotSceneState, restoreSceneState;
let updateMouseActionStatus, updateMobileButtons;
let updateCameraModeButtons, updateBlueprintTransformUI, refreshBlueprintComponents;
let onWindowResize;
let getDynamicPropHitFromEvent, getDynamicPropById, getActorRenderObject;
let applyTerrainBrushFromEvent, updateTerrainBrushPreview;
let rebuildTerrainPhysicsBody, rebuildModelPhysicsBody, ensurePlayerCharacter, syncCameraToCharacter;
let copyJoltVector, updateRaycasterDebugLine, positionLightGrid;
let getGroundHitAt, getGroundHeightAt;
let spawnDrivableCar;
let resetAllScriptLifecycleHandles;
let copySelectedToClipboard, pasteFromClipboard, deleteSelectedActor, duplicateSelected;

export function setupGameplayLoop(deps) {
    ({
        gameplay, physics, showcase, vehicleState, blueprintState, mobileState,
        terrainBrushState, debugConsoleState, collisionDebugState, importedPropState, objectScriptState,
        camera, renderer, container,
        pointerNdc, raycaster, editorHistory, transformControl,
        gameplayLookTarget, gameplayBounds, mainDirectionalLightShadowFocus, mainDirectionalLightOffset,
        upVector, tempVectorA, tempVectorB, tempVectorC, tempVectorD, tempVectorE,
        PLAYER_SETTINGS, VEHICLE_SETTINGS, TERRAIN_Y_OFFSET,
        SHOWCASE_CAMERA_POSITION, SHOWCASE_CAMERA_TARGET,
        runtimeAudio,
        getCurrentMesh, getWorldFloor, getMainDirectionalLight, getPedestal,
        getResetViewBtn, getGameplayStatus, getPlayHint, getSceneUiList,
        setCollisionDebugEnabled,
        isEditableElement,
        runMouseAction, applyMouseActionScripts,
        handleDebugConsoleKeydown,
        closeObjectScriptMenu, closeObjectScriptEditor, maybeOpenObjectScriptMenuFromMobileTap,
        isTransformControlSphereHit, handleLightGridClick, focusShowcaseCameraOnObject,
        selectShowcaseActor, syncTransformControlState,
        snapshotSceneState, restoreSceneState,
        updateMouseActionStatus, updateMobileButtons,
        updateCameraModeButtons, updateBlueprintTransformUI, refreshBlueprintComponents,
        onWindowResize,
        getDynamicPropHitFromEvent, getDynamicPropById, getActorRenderObject,
        applyTerrainBrushFromEvent, updateTerrainBrushPreview,
        rebuildTerrainPhysicsBody, rebuildModelPhysicsBody, ensurePlayerCharacter, syncCameraToCharacter,
        copyJoltVector, updateRaycasterDebugLine, positionLightGrid,
        getGroundHitAt, getGroundHeightAt,
        spawnDrivableCar,
        resetAllScriptLifecycleHandles,
        copySelectedToClipboard, pasteFromClipboard, deleteSelectedActor, duplicateSelected,
    } = deps);
}

export function resetMobileInputState() {
    resetMovementInputState();
    resetMobileMovePad();
    resetMobileLookPad();
}

export function resetMovementInputState() {
    showcase.input.forward = false;
    showcase.input.back = false;
    showcase.input.left = false;
    showcase.input.right = false;
    showcase.input.up = false;
    showcase.input.down = false;
    showcase.input.boost = false;
    gameplay.input.forward = false;
    gameplay.input.back = false;
    gameplay.input.left = false;
    gameplay.input.right = false;
    gameplay.input.sprint = false;
    physics.jumpQueued = false;
}

export function refreshGameplayWorld() {
    if (!getCurrentMesh()) {
        gameplay.canPlay = physics.ready;
        updateGameplayUI();
        return;
    }

    getCurrentMesh().updateWorldMatrix(true, true);
    gameplayBounds.setFromObject(getCurrentMesh());
    gameplayLookTarget.copy(gameplayBounds.getCenter(tempVectorA));

    const worldSize = gameplayBounds.getSize(tempVectorB);
    const floorScale = Math.max(1, worldSize.x / 18, worldSize.z / 18);
    getWorldFloor().scale.setScalar(floorScale);
    getWorldFloor().position.set(gameplayLookTarget.x, TERRAIN_Y_OFFSET, gameplayLookTarget.z);
    positionLightGrid(gameplayLookTarget);

    const topHit = getGroundHitAt(gameplayLookTarget.x, gameplayLookTarget.z, false);
    if (topHit && topHit.point.y > getWorldFloor().position.y + 0.15) {
        gameplay.spawnPoint.set(
            gameplayLookTarget.x,
            topHit.point.y + PLAYER_SETTINGS.floorOffset,
            gameplayLookTarget.z
        );
    } else {
        const fallbackZ = gameplayBounds.max.z + Math.max(worldSize.z * 0.25, 2.5);
        const fallbackY = getGroundHeightAt(gameplayLookTarget.x, fallbackZ, true) ?? getWorldFloor().position.y;
        gameplay.spawnPoint.set(
            gameplayLookTarget.x,
            fallbackY + PLAYER_SETTINGS.floorOffset,
            fallbackZ
        );
    }

    gameplay.velocity.set(0, 0, 0);
    gameplay.grounded = false;
    rebuildTerrainPhysicsBody();
    rebuildModelPhysicsBody();
    if (physics.ready) {
        ensurePlayerCharacter();
    }
    gameplay.canPlay = !!physics.character;
    updateWorldPresentation();
    resetShowcaseCamera(false);
    updateGameplayUI();
}

export function setupGameplayEvents() {
    const resumeAudio = () => {
        runtimeAudio.resume();
    };

    document.addEventListener('pointerdown', resumeAudio, { passive: true });
    document.addEventListener('touchend', resumeAudio, { passive: true });
    document.addEventListener('keydown', resumeAudio);
    document.addEventListener('pointerlockchange', handlePointerLockChange);
    document.addEventListener('mousemove', handleGameplayMouseMove);
    document.addEventListener('keydown', handleDebugConsoleKeydown, true);
    document.addEventListener('keydown', handleGameplayKeyEvent);
    document.addEventListener('keyup', handleGameplayKeyEvent);
    renderer.domElement.addEventListener('mousedown', handleShowcaseMouseButton);
    window.addEventListener('mouseup', handleShowcaseMouseButton);
    renderer.domElement.addEventListener('wheel', handleShowcaseWheel, { passive: false });
    renderer.domElement.addEventListener('contextmenu', handleShowcaseContextMenu);
    renderer.domElement.addEventListener('click', handleLightGridClick);
    // Blueprint mode: click on 3D viewport to select child components
    renderer.domElement.addEventListener('click', (event) => {
        if (!blueprintState.active) return;
        if (event.button !== 0) return;
        if (typeof transformControl !== 'undefined' && (transformControl.dragging || transformControl.justFinishedDragging || transformControl.axis !== null)) return;
        if (isTransformControlSphereHit(event)) return;
        
        const rect = renderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        
        pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointerNdc, camera);
        
        const rootMesh = getActorRenderObject(blueprintState.targetActor);
        if (!rootMesh) return;
        
        // Collect all meshes and lights in the actor tree
        const allChildren = [];
        rootMesh.traverse((child) => {
            if (child.isMesh || child.isLight) allChildren.push(child);
        });
        
        const hits = raycaster.intersectObjects(allChildren, false);
        if (hits.length > 0) {
            const hitObj = hits[0].object;
            blueprintState.selectedComponent = hitObj;
            blueprintState.selectedComponents.clear();
            blueprintState.materialMultiSelectActive = false;
            if (hitObj.isMesh) blueprintState.selectedComponents.add(hitObj);
            if (typeof transformControl !== 'undefined') transformControl.attach(hitObj);
            refreshBlueprintComponents();
        }
    });
    
    renderer.domElement.addEventListener('dblclick', (event) => {
        // Blueprint mode: double-click to focus camera on a component
        if (blueprintState.active) {
            const rect = renderer.domElement.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(pointerNdc, camera);
            
            const rootMesh = getActorRenderObject(blueprintState.targetActor);
            if (!rootMesh) return;
            const allChildren = [];
            rootMesh.traverse((child) => {
                if (child.isMesh || child.isLight) allChildren.push(child);
            });
            
            const hits = raycaster.intersectObjects(allChildren, false);
            if (hits.length > 0) {
                const hitObj = hits[0].object;
                blueprintState.selectedComponent = hitObj;
                blueprintState.selectedComponents.clear();
                blueprintState.materialMultiSelectActive = false;
                if (hitObj.isMesh) blueprintState.selectedComponents.add(hitObj);
                if (typeof transformControl !== 'undefined') transformControl.attach(hitObj);
                refreshBlueprintComponents();
                
                focusShowcaseCameraOnObject(hitObj, { duration: 0.5 });
            }
            return;
        }
        
        if (gameplay.active) return;
        const propHit = getDynamicPropHitFromEvent(event);
        if (propHit?.prop) {
            selectShowcaseActor(propHit.prop.id, propHit.hit?.object ?? null);
            focusShowcaseCameraOnObject(propHit.hit?.object ?? getActorRenderObject(propHit.prop), { duration: 0.55 });
            
            if (getSceneUiList()) {
                const activeItem = getSceneUiList().querySelector(`[data-id="${propHit.prop.id}"]`);
                if (activeItem) {
                    activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        }
    });
    renderer.domElement.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse') return;
        if (gameplay.active) {
            if (runMouseAction('left', event)) {
                event.preventDefault();
            }
            return;
        }
        if (maybeOpenObjectScriptMenuFromMobileTap(event)) {
            const focusedProp = getDynamicPropById(objectScriptState.targetPropId);
            focusShowcaseCameraOnObject(getActorRenderObject(focusedProp), { duration: 0.55 });
            event.preventDefault();
        }
    }, { passive: false });
}

export function adjustShowcaseSpeed(direction) {
    const factor = direction > 0 ? showcase.wheelSpeedStep : 1 / showcase.wheelSpeedStep;
    showcase.moveSpeed = THREE.MathUtils.clamp(
        showcase.moveSpeed * factor,
        showcase.minMoveSpeed,
        showcase.maxMoveSpeed
    );
    updateGameplayUI();
}

export function updateShowcaseInput(event, isDown) {
    if (!showcase.looking && (event.code === 'KeyE' || event.code === 'KeyQ' || event.code === 'Space' || event.code === 'ControlLeft' || event.code === 'ControlRight')) {
        return false;
    }
    switch (event.code) {
        case 'KeyW':
        case 'ArrowUp':
            showcase.input.forward = isDown;
            return true;
        case 'KeyS':
        case 'ArrowDown':
            showcase.input.back = isDown;
            return true;
        case 'KeyA':
        case 'ArrowLeft':
            showcase.input.left = isDown;
            return true;
        case 'KeyD':
        case 'ArrowRight':
            showcase.input.right = isDown;
            return true;
        case 'KeyE':
        case 'Space':
            showcase.input.up = isDown;
            return true;
        case 'KeyQ':
        case 'ControlLeft':
        case 'ControlRight':
            showcase.input.down = isDown;
            return true;
        case 'ShiftLeft':
        case 'ShiftRight':
            showcase.input.boost = isDown;
            return true;
        default:
            return false;
    }
}

export function handleGameplayKeyEvent(event) {
    const isDown = event.type === 'keydown';
    const eventTarget = event.target instanceof HTMLElement ? event.target : document.activeElement;

    if (debugConsoleState.visible) {
        if (gameplay.pointerLocked || gameplay.active) {
            event.preventDefault();
        }
        return;
    }

    if (isDown && !event.repeat && event.code === 'F8') {
        setCollisionDebugEnabled(!collisionDebugState.enabled);
        event.preventDefault();
        return;
    }

    if (isDown && !event.repeat && event.code === 'KeyL' && !isEditableElement(eventTarget)) {
        void playAudioTestCue();
        event.preventDefault();
        return;
    }

    if (!gameplay.active && !gameplay.pointerLocked && isDown) {
        if (event.code === 'Delete') {
            if (blueprintState.active) {
                editorHistory.captureState();
                document.getElementById('btn-delete-comp')?.click();
            } else {
                deleteSelectedActor();
            }
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            if (event.code === 'KeyC') {
                copySelectedToClipboard();
                return;
            } else if (event.code === 'KeyV') {
                pasteFromClipboard();
                return;
            } else if (event.code === 'KeyZ') {
                if (event.shiftKey) {
                    editorHistory.redo();
                } else {
                    editorHistory.undo();
                }
                return;
            } else if (event.code === 'KeyY') {
                editorHistory.redo();
                return;
            } else if (event.code === 'KeyD') {
                duplicateSelected();
                event.preventDefault();
                return;
            }
        }
        if (!showcase.looking && event.code === 'KeyW') {
            transformControl?.setMode('translate');
            if (blueprintState.active) updateBlueprintTransformUI();
        } else if (!showcase.looking && event.code === 'KeyE') {
            transformControl?.setMode('rotate');
            if (blueprintState.active) updateBlueprintTransformUI();
        } else if (!showcase.looking && event.code === 'KeyR') {
            transformControl?.setMode('scale');
            if (blueprintState.active) updateBlueprintTransformUI();
        } else if (!showcase.looking && event.code === 'Backquote') { // Tilde key for toggling space
            if (transformControl) {
                transformControl.setSpace(transformControl.space === 'local' ? 'world' : 'local');
                if (blueprintState.active) updateBlueprintTransformUI();
            }
        }
    }

    if (!gameplay.active && !gameplay.pointerLocked) {
        const acceptsShowcaseInput = renderer && (showcase.looking || document.activeElement === renderer.domElement);
        if (acceptsShowcaseInput && updateShowcaseInput(event, isDown)) {
            event.preventDefault();
            return;
        }
    }

    if (!gameplay.canPlay) return;

    switch (event.code) {
        case 'KeyW':
        case 'ArrowUp':
            gameplay.input.forward = isDown;
            break;
        case 'KeyS':
        case 'ArrowDown':
            gameplay.input.back = isDown;
            break;
        case 'KeyA':
        case 'ArrowLeft':
            gameplay.input.left = isDown;
            break;
        case 'KeyD':
        case 'ArrowRight':
            gameplay.input.right = isDown;
            break;
        case 'ShiftLeft':
        case 'ShiftRight':
            gameplay.input.sprint = isDown;
            break;
        case 'Space':
            if (gameplay.pointerLocked) event.preventDefault();
            if (isDown && !event.repeat && gameplay.active) {
                if (isDrivingVehicle()) {
                    vehicleState.brakeHeld = true;
                } else {
                    physics.jumpQueued = true;
                }
            } else if (!isDown) {
                vehicleState.brakeHeld = false;
            }
            break;
        case 'KeyE':
            if (isDown && !event.repeat && gameplay.active) {
                if (isDrivingVehicle()) {
                    exitVehicle();
                } else {
                    enterVehicle();
                }
            }
            break;
        case 'KeyV':
            if (isDown && !event.repeat && gameplay.active) {
                spawnDrivableCar();
            }
            break;
        case 'KeyR':
            if (isDown && gameplay.active) {
                if (isDrivingVehicle()) {
                    exitVehicle();
                }
                respawnPlayer();
            }
            break;
        default:
            return;
    }

    if (gameplay.pointerLocked) {
        event.preventDefault();
    }
}

export function handleGameplayMouseMove(event) {
    if (!gameplay.pointerLocked) {
        if (terrainBrushState.enabled && !showcase.looking && !blueprintState.active && !gameplay.active) {
            if (terrainBrushState.active) {
                applyTerrainBrushFromEvent(event);
            } else {
                updateTerrainBrushPreview(event);
            }
            return;
        }
        if (!showcase.looking || gameplay.active) return;

        showcase.yaw -= event.movementX * 0.0022;
        showcase.pitch -= event.movementY * 0.0018;
        showcase.pitch = THREE.MathUtils.clamp(
            showcase.pitch,
            -PLAYER_SETTINGS.maxLookPitch,
            PLAYER_SETTINGS.maxLookPitch
        );

        applyShowcaseCameraRotation();
        return;
    }

    gameplay.yaw -= event.movementX * 0.0022;
    gameplay.pitch -= event.movementY * 0.0018;
    gameplay.pitch = THREE.MathUtils.clamp(
        gameplay.pitch,
        -PLAYER_SETTINGS.maxLookPitch,
        PLAYER_SETTINGS.maxLookPitch
    );

    applyGameplayCameraRotation();
}

export function handleShowcaseMouseButton(event) {
    // In blueprint mode, don't let the normal actor selection logic
    // intercept clicks — TransformControls needs those events for gizmo drag
    if (blueprintState.active) {
        if (event.type === 'mousedown' && event.button === 2) {
            showcase.looking = true;
            event.preventDefault();
        } else if (event.type === 'mouseup' && event.button === 2) {
            showcase.looking = false;
        }
        return;
    }

    if (gameplay.active) {
        if (event.type === 'mousedown') {
            const buttonName = event.button === 2 ? 'right' : event.button === 0 ? 'left' : null;
            if (buttonName) {
                runMouseAction(buttonName, event);
            }
        }
        return;
    }

    if (gameplay.active || gameplay.pointerLocked || !renderer) return;

    if (event.type === 'mousedown') {
        renderer.domElement.focus();
        if (terrainBrushState.enabled && event.button === 0) {
            terrainBrushState.active = true;
            applyTerrainBrushFromEvent(event);
            event.preventDefault();
            return;
        }
        if (event.button === 0 && objectScriptState.menuOpen) {
            closeObjectScriptMenu();
        }
        // Left-click: select actor and attach gizmo
        if (event.button === 0) {
            if (isTransformControlSphereHit(event)) {
                event.preventDefault();
                return;
            }
            const propHit = getDynamicPropHitFromEvent(event);
            if (propHit?.prop) {
                selectShowcaseActor(propHit.prop.id, propHit.hit?.object ?? null);
            } else {
                // Clicked empty space — deselect
                selectShowcaseActor(null);
            }
            return;
        }
        if (event.button !== 2) return;
        closeObjectScriptMenu();
        showcase.looking = true;
        event.preventDefault();
        return;
    }

    if (event.button === 0 && terrainBrushState.active) {
        terrainBrushState.active = false;
        if (terrainBrushState.dirtyPhysics) {
            rebuildTerrainPhysicsBody();
            terrainBrushState.dirtyPhysics = false;
        }
        event.preventDefault();
        return;
    }

    if (event.button === 2) {
        showcase.looking = false;
    }
}

export function handleShowcaseContextMenu(event) {
    if (gameplay.active || gameplay.pointerLocked || !renderer) {
        event.preventDefault();
        return;
    }

    if (isTransformControlSphereHit(event)) {
        event.preventDefault();
        return;
    }

    event.preventDefault();
    closeObjectScriptMenu();
}

export function handleShowcaseWheel(event) {
    if (gameplay.active || gameplay.pointerLocked) return;

    event.preventDefault();
    adjustShowcaseSpeed(event.deltaY < 0 ? 1 : -1);
}

export function handlePointerLockChange() {
    const isLocked = document.pointerLockElement === renderer.domElement;

    if (isLocked) {
        gameplay.pointerLocked = true;
        gameplay.active = true;
        showcase.looking = false;
        syncTransformControlState();
        closeObjectScriptMenu();
        closeObjectScriptEditor();
        updateWorldPresentation();
        updateGameplayUI();
        renderer.domElement.focus();
        return;
    }

    if (!gameplay.pointerLocked && !gameplay.active) return;

    gameplay.pointerLocked = false;
    gameplay.active = false;
    gameplay.velocity.set(0, 0, 0);
    physics.desiredVelocity.set(0, 0, 0);
    resetMovementInputState();
    restoreSceneState();
    syncTransformControlState();

    updateWorldPresentation();
    resetShowcaseCamera(false);
    updateGameplayUI();
}

export function enterGameplay() {
    if (!gameplay.canPlay && physics.ready) {
        gameplay.canPlay = true;
        ensurePlayerCharacter();
    }
    if (!gameplay.canPlay) return;

    snapshotSceneState();
    syncGameplaySpawnToCamera();
    respawnPlayer(true);
    gameplay.pointerLocked = false;
    gameplay.active = true;
    syncTransformControlState();
    resetAllScriptLifecycleHandles();
    applyMouseActionScripts({ persist: true });
    showcase.looking = false;
    resetMobileInputState();
    updateWorldPresentation();
    updateGameplayUI();

    if (!mobileState.enabled) {
        renderer.domElement.requestPointerLock?.();
    }
}

export function exitGameplay() {
    if (!mobileState.enabled && document.pointerLockElement === renderer.domElement) {
        document.exitPointerLock();
        return;
    }

    if (!gameplay.active && !gameplay.pointerLocked) return;

    gameplay.pointerLocked = false;
    gameplay.active = false;
    clearActiveVehicle();
    restoreSceneState();
    gameplay.velocity.set(0, 0, 0);
    physics.jumpQueued = false;
    physics.desiredVelocity.set(0, 0, 0);
    showcase.looking = false;
    showcase.velocity.set(0, 0, 0);
    showcase.input.forward = false;
    showcase.input.back = false;
    showcase.input.left = false;
    showcase.input.right = false;
    showcase.input.up = false;
    showcase.input.down = false;
    showcase.input.boost = false;
    resetMobileInputState();
    syncTransformControlState();

    updateWorldPresentation();
    resetShowcaseCamera(false);
    updateGameplayUI();
}

export function forceExitGameplayForWorldLoad() {
    if (!mobileState.enabled && document.pointerLockElement === renderer?.domElement) {
        document.exitPointerLock?.();
    }

    gameplay.pointerLocked = false;
    gameplay.active = false;
    clearActiveVehicle();
    gameplay.velocity.set(0, 0, 0);
    physics.jumpQueued = false;
    physics.desiredVelocity.set(0, 0, 0);
    showcase.looking = false;
    showcase.velocity.set(0, 0, 0);
    resetMobileInputState();
    syncTransformControlState();
    updateWorldPresentation();
    updateGameplayUI();
}

export function updateWorldPresentation() {
    if (getPedestal()) getPedestal().visible = !gameplay.active;
    document.body.classList.toggle('play-ready', gameplay.canPlay);
    const wasActive = document.body.classList.contains('play-active');
    document.body.classList.toggle('play-active', gameplay.active);
    if (wasActive !== gameplay.active && renderer && camera && container) {
        // Layout shifts when scene panel hides; resync canvas/aspect.
        requestAnimationFrame(onWindowResize);
    }
}

export function updateMainDirectionalLightShadowFocus() {
    if (!getMainDirectionalLight() || !camera) return;

    mainDirectionalLightShadowFocus.copy(camera.position);
    mainDirectionalLightShadowFocus.y = getWorldFloor()?.position?.y ?? 0;

    getMainDirectionalLight().position.copy(mainDirectionalLightShadowFocus).add(mainDirectionalLightOffset);
    getMainDirectionalLight().target.position.copy(mainDirectionalLightShadowFocus);
    getMainDirectionalLight().target.updateMatrixWorld();
}

export function updateGameplayUI() {
    const hasAsset = !!getCurrentMesh();
    const mobileActive = mobileState.enabled;
    const drivingVehicle = isDrivingVehicle();

    if (getResetViewBtn()) {
        getResetViewBtn().textContent = gameplay.active ? 'Respawn' : 'Reset View';
    }

    updateCameraModeButtons();

    if (getGameplayStatus()) {
        if (mobileActive && drivingVehicle) {
            getGameplayStatus().textContent = 'Mobile driving active';
        } else if (mobileActive && gameplay.active) {
            getGameplayStatus().textContent = 'Mobile play active';
        } else if (mobileActive) {
            getGameplayStatus().textContent = 'Mobile showcase ready';
        } else if (drivingVehicle) {
            getGameplayStatus().textContent = 'Driving summoned car';
        } else if (!hasAsset && gameplay.active) {
            getGameplayStatus().textContent = gameplay.grounded ? 'Exploring terrain' : 'Airborne';
        } else if (!hasAsset) {
            getGameplayStatus().textContent = `Showcase free-fly ready. Camera speed ${showcase.moveSpeed.toFixed(1)}x.`;
        } else if (gameplay.active) {
            getGameplayStatus().textContent = gameplay.grounded ? 'Exploring scene' : 'Airborne';
        } else {
            getGameplayStatus().textContent = `Scene ready. Showcase speed ${showcase.moveSpeed.toFixed(1)}x.`;
        }
    }

    if (getPlayHint()) {
        if (mobileActive && drivingVehicle) {
            getPlayHint().textContent = 'Touch left pad to drive, right pad to look, hold Brake to slow down, tap the scene for play scripts, and tap E on keyboard to hop out.';
        } else if (mobileActive && gameplay.active) {
            getPlayHint().textContent = 'Touch left pad to move, right pad to look, tap the scene to run play scripts, and use Jump to hop.';
        } else if (mobileActive) {
            getPlayHint().textContent = 'Touch left pad to move, right pad to look, double-tap a prop to open its script menu, and use Menu for assets.';
        } else if (drivingVehicle) {
            getPlayHint().textContent = 'W/S drive, A/D steer, Shift boost, Space brake, E exit car, R respawn, Esc exit play mode.';
        } else if (!hasAsset && gameplay.active) {
            getPlayHint().textContent = 'WASD move, mouse look, Space jump, Shift sprint, E enter nearby car, V summon car, R respawn, Esc exit.';
        } else if (!hasAsset) {
            getPlayHint().textContent = 'Showcase: hold right mouse to look, use WASD to move, Q/E for down/up, Shift to boost, and mouse wheel to change camera speed.';
        } else if (gameplay.active) {
            getPlayHint().textContent = 'WASD move, mouse look, Space jump, Shift sprint, E enter nearby car, V summon car, R respawn, Esc exit.';
        } else {
            getPlayHint().textContent = 'Showcase: hold right mouse to look, use WASD to move, Q/E for down/up, Shift to boost, and mouse wheel to change camera speed. Play mode still uses pointer lock.';
        }
    }

    updateMobileButtons();
    updateMouseActionStatus();
    updateWorldPresentation();
}

export function getShowcaseTarget() {
    if (!getCurrentMesh()) {
        return SHOWCASE_CAMERA_TARGET;
    }

    return tempVectorA.set(
        gameplayLookTarget.x,
        Math.max(1.25, gameplayBounds.max.y * 0.35),
        gameplayLookTarget.z
    );
}

export function resetShowcaseCamera(animate = true) {
    if (gameplay.active) return;

    const target = getShowcaseTarget();
    const animatedLookTarget = {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
    };

    if (!animate) {
        camera.position.copy(SHOWCASE_CAMERA_POSITION);
        syncShowcaseAnglesFromTarget(target);
        applyShowcaseCameraRotation();
        showcase.velocity.set(0, 0, 0);
        return;
    }

    gsap.killTweensOf(camera.position);
    gsap.killTweensOf(animatedLookTarget);

    gsap.to(camera.position, {
        x: SHOWCASE_CAMERA_POSITION.x,
        y: SHOWCASE_CAMERA_POSITION.y,
        z: SHOWCASE_CAMERA_POSITION.z,
        duration: 0.9,
        overwrite: true,
        onUpdate: () => {
            syncShowcaseAnglesFromTarget(tempVectorB.set(animatedLookTarget.x, animatedLookTarget.y, animatedLookTarget.z));
            applyShowcaseCameraRotation();
        },
    });

    gsap.to(animatedLookTarget, {
        x: target.x,
        y: target.y,
        z: target.z,
        duration: 0.9,
        overwrite: true,
        onUpdate: () => {
            syncShowcaseAnglesFromTarget(tempVectorB.set(animatedLookTarget.x, animatedLookTarget.y, animatedLookTarget.z));
            applyShowcaseCameraRotation();
        },
    });
}

export function updateShowcaseCamera(delta) {
    const moveRight = (showcase.input.right ? 1 : 0) - (showcase.input.left ? 1 : 0);
    const moveForward = (showcase.input.forward ? 1 : 0) - (showcase.input.back ? 1 : 0);
    const moveVertical = (showcase.input.up ? 1 : 0) - (showcase.input.down ? 1 : 0);

    tempVectorA.set(0, 0, 0);
    camera.getWorldDirection(tempVectorB);

    if (tempVectorB.lengthSq() < 1e-6) {
        tempVectorB.set(0, 0, -1);
    } else {
        tempVectorB.normalize();
    }

    tempVectorC.crossVectors(tempVectorB, upVector).normalize();

    tempVectorA
        .addScaledVector(tempVectorC, moveRight)
        .addScaledVector(tempVectorB, moveForward)
        .addScaledVector(upVector, moveVertical);

    if (tempVectorA.lengthSq() > 0) {
        tempVectorA.normalize();
    }

    const moveSpeed = showcase.moveSpeed * (showcase.input.boost ? showcase.boostMultiplier : 1);
    showcase.velocity.lerp(tempVectorA.multiplyScalar(moveSpeed), tempVectorA.lengthSq() > 0 ? 0.35 : 0.18);

    if (showcase.velocity.lengthSq() < 1e-5) {
        showcase.velocity.set(0, 0, 0);
        return;
    }

    camera.position.addScaledVector(showcase.velocity, delta);
}

export function respawnPlayer(useStoredView = false) {
    if (!gameplay.canPlay && physics.ready) {
        gameplay.canPlay = true;
    }
    if (!gameplay.canPlay) return;

    if (isDrivingVehicle()) {
        clearActiveVehicle();
    }

    if (!physics.character) {
        ensurePlayerCharacter();
    }

    if (!physics.character) return;

    const spawnPosition = new physics.Jolt.RVec3(
        gameplay.spawnPoint.x,
        gameplay.spawnPoint.y,
        gameplay.spawnPoint.z
    );
    physics.character.SetPosition(spawnPosition);
    physics.Jolt.destroy(spawnPosition);
    physics.character.SetLinearVelocity(physics.Jolt.Vec3.prototype.sZero());
    gameplay.velocity.set(0, 0, 0);
    gameplay.grounded = true;

    if (useStoredView) {
        gameplay.yaw = gameplay.spawnYaw;
        gameplay.pitch = gameplay.spawnPitch;
    }

    syncCameraToCharacter();

    if (!useStoredView) {
        tempVectorA.copy(gameplayLookTarget).sub(camera.position);
        const flatDistance = Math.max(0.001, Math.hypot(tempVectorA.x, tempVectorA.z));
        gameplay.yaw = Math.atan2(tempVectorA.x, tempVectorA.z);
        gameplay.pitch = THREE.MathUtils.clamp(
            Math.atan2(-tempVectorA.y, flatDistance),
            -PLAYER_SETTINGS.maxLookPitch,
            PLAYER_SETTINGS.maxLookPitch
        );
        gameplay.spawnYaw = gameplay.yaw;
        gameplay.spawnPitch = gameplay.pitch;
    }

    applyGameplayCameraRotation();
    updateGameplayUI();
}

export function applyGameplayCameraRotation() {
    camera.rotation.order = 'YXZ';
    camera.rotation.x = gameplay.pitch;
    camera.rotation.y = gameplay.yaw;
    camera.rotation.z = 0;
}

export function resolveHorizontalMovement(origin, movementDelta) {
    if (!getCurrentMesh() || movementDelta.lengthSq() === 0) {
        return movementDelta;
    }

    const adjustedMovement = movementDelta.clone();
    const direction = tempVectorA.copy(movementDelta).normalize();
    const probeHeights = [PLAYER_SETTINGS.eyeHeight * 0.35, PLAYER_SETTINGS.eyeHeight * 0.75];

    for (const probeHeight of probeHeights) {
        const rayOrigin = tempVectorB.copy(origin);
        rayOrigin.y += probeHeight - PLAYER_SETTINGS.eyeHeight;

        raycaster.set(rayOrigin, direction);

        const hit = raycaster.intersectObject(getCurrentMesh(), true).find(entry => (
            entry.distance <= movementDelta.length() + PLAYER_SETTINGS.collisionRadius
        ));
        updateRaycasterDebugLine(
            raycaster.ray,
            movementDelta.length() + PLAYER_SETTINGS.collisionRadius,
            hit?.point ?? null,
            !!hit,
        );

        if (!hit || !hit.face) continue;

        const wallNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        if (wallNormal.y > 0.6) continue;

        adjustedMovement.projectOnPlane(wallNormal);
        adjustedMovement.addScaledVector(wallNormal, PLAYER_SETTINGS.wallClearance);
    }

    return adjustedMovement;
}

export function updateGameplay(delta) {
    if (isDrivingVehicle()) {
        updateVehicleGameplay(delta);
        return;
    }

    silenceVehicleEngineAudio();
    updateEngineAudioDebugOverlay('idle', null, null);

    if (!physics.character) return;

    const moveRight = (gameplay.input.right ? 1 : 0) - (gameplay.input.left ? 1 : 0);
    const moveForward = (gameplay.input.forward ? 1 : 0) - (gameplay.input.back ? 1 : 0);
    const moveSpeed = gameplay.input.sprint ? PLAYER_SETTINGS.sprintSpeed : PLAYER_SETTINGS.walkSpeed;
    const wasGrounded = gameplay.grounded;

    tempVectorA.set(0, 0, 0);
    if (moveRight !== 0 || moveForward !== 0) {
        camera.getWorldDirection(tempVectorB);
        tempVectorB.y = 0;

        if (tempVectorB.lengthSq() < 1e-6) {
            tempVectorB.set(0, 0, -1);
        } else {
            tempVectorB.normalize();
        }

        tempVectorC.crossVectors(tempVectorB, upVector).normalize();

        tempVectorA
            .addScaledVector(tempVectorC, moveRight)
            .addScaledVector(tempVectorB, moveForward);

        if (tempVectorA.lengthSq() > 0) {
            tempVectorA.normalize().multiplyScalar(moveSpeed);
        }
    }

    const desiredMovement = tempVectorE.copy(tempVectorA);

    physics.character.UpdateGroundVelocity();

    const linearVelocity = copyJoltVector(tempVectorB, physics.character.GetLinearVelocity());
    const currentVerticalVelocity = tempVectorC.copy(upVector).multiplyScalar(linearVelocity.dot(upVector));
    const currentHorizontalVelocity = tempVectorD.copy(linearVelocity).sub(currentVerticalVelocity);
    const groundVelocity = copyJoltVector(tempVectorA, physics.character.GetGroundVelocity());

    const onGround = physics.character.IsSupported();
    const movingTowardsGround = currentVerticalVelocity.y - groundVelocity.y <= 0.1;
    physics.allowSliding = desiredMovement.lengthSq() > 1e-8;

    let nextVelocity;
    if (onGround && movingTowardsGround) {
        nextVelocity = groundVelocity.clone();
        if (physics.jumpQueued) {
            nextVelocity.y += PLAYER_SETTINGS.jumpSpeed;
        }
    } else {
        nextVelocity = currentVerticalVelocity.clone();
    }

    nextVelocity.addScaledVector(copyJoltVector(tempVectorC, physics.gravity), delta);

    if (physics.allowSliding) {
        physics.desiredVelocity.lerp(desiredMovement, onGround ? 0.32 : 0.12);
        nextVelocity.add(physics.desiredVelocity);
    } else if (!onGround) {
        nextVelocity.add(currentHorizontalVelocity);
        physics.desiredVelocity.multiplyScalar(0.92);
    } else {
        physics.desiredVelocity.multiplyScalar(0.2);
    }

    const nextVelocityJolt = new physics.Jolt.Vec3(nextVelocity.x, nextVelocity.y, nextVelocity.z);
    physics.character.SetLinearVelocity(nextVelocityJolt);
    physics.Jolt.destroy(nextVelocityJolt);
    physics.character.ExtendedUpdate(
        delta,
        physics.gravity,
        physics.updateSettings,
        physics.movingBroadPhaseFilter,
        physics.movingLayerFilter,
        physics.bodyFilter,
        physics.shapeFilter,
        physics.jolt.GetTempAllocator()
    );

    syncCameraToCharacter();
    applyGameplayCameraRotation();
    gameplay.grounded = physics.character.IsSupported();
    physics.jumpQueued = false;

    const characterPosition = copyJoltVector(tempVectorA, physics.character.GetPosition());
    if (characterPosition.y < getWorldFloor().position.y - 24) {
        respawnPlayer();
    }

    if (wasGrounded !== gameplay.grounded) {
        updateGameplayUI();
    }
}

export function syncGameplaySpawnToCamera() {
    if (!camera) return;

    gameplay.spawnPoint.set(
        camera.position.x,
        camera.position.y - PLAYER_SETTINGS.eyeHeight,
        camera.position.z
    );

    tempVectorA.setFromEuler(camera.rotation.reorder('YXZ'));
    gameplay.spawnYaw = tempVectorA.y;
    gameplay.spawnPitch = THREE.MathUtils.clamp(
        tempVectorA.x,
        -PLAYER_SETTINGS.maxLookPitch,
        PLAYER_SETTINGS.maxLookPitch
    );
}

export function syncShowcaseAnglesFromTarget(target) {
    tempVectorA.copy(target).sub(camera.position);
    const flatDistance = Math.max(0.001, Math.hypot(tempVectorA.x, tempVectorA.z));
    showcase.yaw = Math.atan2(tempVectorA.x, tempVectorA.z);
    showcase.pitch = THREE.MathUtils.clamp(
        Math.atan2(-tempVectorA.y, flatDistance),
        -PLAYER_SETTINGS.maxLookPitch,
        PLAYER_SETTINGS.maxLookPitch
    );
}

export function syncShowcaseAnglesToFaceTarget(target) {
    tempVectorA.copy(target).sub(camera.position);
    const flatDistance = Math.max(0.001, Math.hypot(tempVectorA.x, tempVectorA.z));
    showcase.yaw = Math.atan2(-tempVectorA.x, -tempVectorA.z);
    showcase.pitch = THREE.MathUtils.clamp(
        Math.atan2(tempVectorA.y, flatDistance),
        -PLAYER_SETTINGS.maxLookPitch,
        PLAYER_SETTINGS.maxLookPitch
    );
}

export function applyShowcaseCameraRotation() {
    camera.rotation.order = 'YXZ';
    camera.rotation.x = showcase.pitch;
    camera.rotation.y = showcase.yaw;
    camera.rotation.z = 0;
}