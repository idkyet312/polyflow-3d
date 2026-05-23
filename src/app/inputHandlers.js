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

import { core } from '../runtime/appCore.js';

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
        handleGameLauncherPause = null,
    } = deps;

    // True when the current level is a self-contained game mode (Drug Tycoon,
    // Rogue Waves arenas, etc) that owns its own input. Used to gate the
    // default left/right-click mouse ACTIONS (e.g. throw-ball) so they don't
    // fire inside a game mode. The gun's own fire flag is NOT gated by this.
    const GAME_MODE_SAMPLE_TYPES = new Set([
        'drugTycoon', 'doomArena', 'doomTest', 'shootingSim',
    ]);
    function inGameMode() {
        // sampleType lives on the loaded level mesh (core.currentMesh).
        const sampleType = core.currentMesh?.userData?.sampleType;
        if (sampleType && GAME_MODE_SAMPLE_TYPES.has(sampleType)) return true;
        // Fallback: a game-mode logic actor (rogue/tycoon) is present.
        const actors = sceneSystem()?.actors;
        if (actors) {
            for (const actor of actors) {
                if (actor?.userData?.gameplayPrefab === 'rogueGameMode') return true;
            }
        }
        return false;
    }

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
            const isMobile = (typeof document !== 'undefined'
                && document.body.classList.contains('is-mobile'))
                || (typeof window !== 'undefined'
                    && window.matchMedia?.('(pointer:coarse)')?.matches);
            // On PC: active but the cursor isn't locked yet (the initial
            // auto-lock can be denied right after a scene swap, esp. Firefox) —
            // treat this click as a gesture to (re)acquire the lock.
            // On mobile there is NO pointer lock; tapping must shoot/bat, not
            // pop the browser's "show cursor" prompt, so skip this entirely.
            if (!isMobile && !gameplay.pointerLocked && event.type === 'mousedown') {
                event.preventDefault();
                renderer()?.domElement?.requestPointerLock?.();
                return;
            }
            if (event.button === 0) {
                gameplay.input.fire = event.type === 'mousedown';
                if (event.type === 'mousedown') gameplay.input.firePressed = true;
                event.preventDefault();
            }
            if (event.type === 'mousedown') {
                const buttonName = event.button === 2 ? 'right' : event.button === 0 ? 'left' : null;
                // Default left/right-click mouse actions only run in a free
                // (non-game-mode) scene. Inside a game mode (Drug Tycoon, Rogue,
                // etc) they're suppressed so they don't interfere — the gun's
                // own `fire` flag above still works.
                const tycoonGun = (typeof window !== 'undefined') && window.drugTycoon?.hasGun;
                const heldWeaponUsesLeftMouse = buttonName === 'left' && (!!gameplay.weapon.type || tycoonGun);
                if (buttonName && !heldWeaponUsesLeftMouse && !inGameMode()) runMouseAction(buttonName, event);
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

        // Entered play but the lock was never actually acquired (e.g. the
        // request came from outside a user-gesture, or the browser denied it
        // — common in Firefox after a scene swap). This unlock event is not the
        // user Stopping; keep gameplay active and let them click to lock. Only a
        // genuine lock-release (pointerLocked was true) should fall through to
        // the Stop/restore path below.
        if (gameplay.active && !gameplay.pointerLocked) return;

        // Rogue card picker released the lock on purpose to show the cursor.
        // This is a PAUSE, not a Stop — don't tear down / restore the scene.
        if (gameplay.roguePaused) {
            gameplay.pointerLocked = false;
            gameplay.velocity.set(0, 0, 0);
            physics.desiredVelocity.set(0, 0, 0);
            resetMovementInputState();
            return;
        }

        if (handleGameLauncherPause?.()) {
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
            // Drug Tycoon restarts on exit so rejoining gives a fresh run.
            try { window.drugTycoonApi?.resetState?.(); } catch (e) {}
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
