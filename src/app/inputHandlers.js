// Pointer / mouse input handlers extracted from runtime.js. Wired by the
// runtime once during init() via `addEventListener('mousemove', handler)`
// etc; pure logic over injected state.
//
// Owns:
//   - handleGameplayMouseMove: yaw/pitch from movementX/Y, terrain brush
//   - handleShowcaseMouseButton: gizmo + click-select + terrain brush dispatch
//   - handleShowcaseContextMenu: suppress browser menu in showcase mode
//   - handleShowcaseWheel: free-fly camera speed adjust
//   - handlePointerLockChange: gameplay enter/exit on lock state

export function createInputHandlers(deps) {
    const {
        THREE,
        renderer, camera,
        physics, sceneSystem,
        gameplay, showcase, blueprintState, terrainBrushState, objectScriptState,
        PLAYER_SETTINGS,
        applyTerrainBrushFromEvent, updateTerrainBrushPreview,
        applyShowcaseCameraRotation, applyGameplayCameraRotation,
        runMouseAction,
        isTransformControlSphereHit, getDynamicPropHitFromEvent,
        selectShowcaseActor, closeObjectScriptMenu, closeObjectScriptEditor,
        rebuildModelPhysicsBody, rebuildTerrainPhysicsBody,
        worldFloor,
        syncTransformControlState,
        updateWorldPresentation, updateGameplayUI,
        resetMovementInputState,
        clearShooterProjectiles, clearShooterAimWarnings,
        clearGameplayEffects, clearHeldWeapon,
        restoreSceneState,
        repairSampleCollisionHierarchyAfterRestore,
        resetDoomMiniLevelState, resetDoomArenaLevelState,
        resetShowcaseCamera,
        adjustShowcaseSpeed,
    } = deps;

    function handleGameplayMouseMove(event) {
        if (!gameplay.pointerLocked) {
            if (terrainBrushState.enabled && !showcase.looking && !blueprintState.active && !gameplay.active) {
                if (terrainBrushState.active) applyTerrainBrushFromEvent(event);
                else updateTerrainBrushPreview(event);
                return;
            }
            if (!showcase.looking || gameplay.active) return;

            showcase.yaw -= event.movementX * 0.0022;
            showcase.pitch -= event.movementY * 0.0018;
            showcase.pitch = THREE.MathUtils.clamp(
                showcase.pitch,
                -PLAYER_SETTINGS.maxLookPitch,
                PLAYER_SETTINGS.maxLookPitch,
            );

            applyShowcaseCameraRotation();
            return;
        }

        gameplay.yaw -= event.movementX * 0.0022;
        gameplay.pitch -= event.movementY * 0.0018;
        gameplay.pitch = THREE.MathUtils.clamp(
            gameplay.pitch,
            -PLAYER_SETTINGS.maxLookPitch,
            PLAYER_SETTINGS.maxLookPitch,
        );

        applyGameplayCameraRotation();
    }

    function handleShowcaseMouseButton(event) {
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
            if (event.button === 0) {
                gameplay.input.fire = event.type === 'mousedown';
                if (event.type === 'mousedown') gameplay.input.firePressed = true;
                event.preventDefault();
            }
            if (event.type === 'mousedown') {
                const buttonName = event.button === 2 ? 'right' : event.button === 0 ? 'left' : null;
                // Left mouse is consumed by a held weapon — the engine weapon
                // (gameplay.weapon.type) OR the Drug Tycoon pistol — so the
                // default left-click mouse action (e.g. throwing a ball) doesn't
                // also fire while armed.
                const tycoonGun = (typeof window !== 'undefined') && window.drugTycoon?.hasGun;
                const heldWeaponUsesLeftMouse = buttonName === 'left' && (!!gameplay.weapon.type || tycoonGun);
                if (buttonName && !heldWeaponUsesLeftMouse) runMouseAction(buttonName, event);
            }
            return;
        }

        const rd = renderer();
        if (gameplay.active || gameplay.pointerLocked || !rd) return;

        if (event.type === 'mousedown') {
            rd.domElement.focus();
            if (terrainBrushState.enabled && event.button === 0) {
                terrainBrushState.active = true;
                applyTerrainBrushFromEvent(event);
                event.preventDefault();
                return;
            }
            if (event.button === 0 && objectScriptState.menuOpen) closeObjectScriptMenu();
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
                const floor = worldFloor();
                if (terrainBrushState.targetObject && terrainBrushState.targetObject !== floor) {
                    rebuildModelPhysicsBody();
                } else {
                    rebuildTerrainPhysicsBody();
                }
                terrainBrushState.dirtyPhysics = false;
            }
            event.preventDefault();
            return;
        }

        if (event.button === 2) showcase.looking = false;
    }

    function handleShowcaseContextMenu(event) {
        const rd = renderer();
        if (gameplay.active || gameplay.pointerLocked || !rd) {
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

    function handleShowcaseWheel(event) {
        if (gameplay.active || gameplay.pointerLocked) return;
        event.preventDefault();
        adjustShowcaseSpeed(event.deltaY < 0 ? 1 : -1);
    }

    function handlePointerLockChange() {
        const rd = renderer();
        const isLocked = document.pointerLockElement === rd?.domElement;

        if (isLocked) {
            gameplay.pointerLocked = true;
            gameplay.active = true;
            showcase.looking = false;
            syncTransformControlState();
            closeObjectScriptMenu();
            closeObjectScriptEditor();
            updateWorldPresentation();
            updateGameplayUI();
            rd?.domElement.focus();
            return;
        }

        if (!gameplay.pointerLocked && !gameplay.active) return;

        // Rogue card picker released the lock on purpose to show the cursor.
        // This is a PAUSE, not a Stop — don't tear down / restore the scene.
        if (gameplay.roguePaused) {
            gameplay.pointerLocked = false;
            gameplay.velocity.set(0, 0, 0);
            physics.desiredVelocity.set(0, 0, 0);
            resetMovementInputState();
            return;
        }

        gameplay.pointerLocked = false;
        gameplay.active = false;
        gameplay.velocity.set(0, 0, 0);
        physics.desiredVelocity.set(0, 0, 0);
        resetMovementInputState();
        clearShooterProjectiles();
        clearShooterAimWarnings();
        clearGameplayEffects();
        clearHeldWeapon();
        // restoreSceneState() reloads the world ASYNchronously; actor-dependent
        // cleanup must run AFTER it resolves or it operates on the old actors
        // that the reload then wipes (→ doom waves never re-arm on Stop).
        const cm = sceneSystem();
        console.log('[STOP] handlePointerLockChange → restore; sampleType=',
            cm?.userData?.sampleType);
        Promise.resolve(restoreSceneState()).then((restored) => {
            console.log('[STOP] restore resolved =', restored,
                'actors=', cm?.actors?.size);
            repairSampleCollisionHierarchyAfterRestore();
            const did = resetDoomMiniLevelState();
            resetDoomArenaLevelState();
            console.log('[STOP] resetDoomMiniLevelState ran =', did);
            syncTransformControlState();
        });

        updateWorldPresentation();
        resetShowcaseCamera(false);
        updateGameplayUI();
    }

    return {
        handleGameplayMouseMove,
        handleShowcaseMouseButton,
        handleShowcaseContextMenu,
        handleShowcaseWheel,
        handlePointerLockChange,
    };
}
