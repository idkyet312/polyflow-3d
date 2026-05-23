import * as THREE from 'three';
import { core } from '../runtime/appCore.js';

// Mirrors inGameMode() in inputHandlers.js. Used to suppress the default
// touch "throw ball" (sphere/cube) action while inside a game mode.
const GAME_MODE_SAMPLE_TYPES = new Set(['drugTycoon', 'doomArena', 'doomTest', 'shootingSim']);
function inGameMode() {
    const sampleType = core.currentMesh?.userData?.sampleType;
    if (sampleType && GAME_MODE_SAMPLE_TYPES.has(sampleType)) return true;
    return !!window.drugTycoon?.inRoom;
}

// Terrain UI panel + gameplay event/key handling + showcase input,
// extracted from runtime.js. Zero span-local module state (no leak risk).
// Live engine refs (camera/renderer/transformControl/worldFloor/grassField/
// sceneUiList) via the appCore keystone; rest injected via factory.
export function createInputPanels(deps) {
    const {
        blueprintState, collisionDebugState, debugConsoleState, gameplay,
        objectScriptState, physics, pointerNdc, raycaster, runtimeAudio,
        showcase, terrainBrushState, vehicleState,
        focusCurrentShowcaseSelection, focusShowcaseCameraOnObject,
        handlePointerLockChange, handleShowcaseContextMenu,
        handleShowcaseWheel, isEditableElement,
        copySelectedToClipboard, deleteSelectedActor, duplicateSelected,
        editorHistory, getDynamicPropById, getDynamicPropHitFromEvent,
        handleDebugConsoleKeydown, isTransformControlSphereHit,
        maybeOpenObjectScriptMenuFromMobileTap, pasteFromClipboard,
        playAudioTestCue, refreshBlueprintComponents, runMouseAction,
        setTerrainCustomImage, setTerrainModeGrassPBR, setTerrainModeGrid,
        setTerrainModeSolid, setTerrainRepeat, setTerrainRoughness,
        setTerrainTint, updateBlueprintTransformUI,
        // listener/handler fns the panels register or call (all hoisted
        // functions in runtime.js — injected, not re-imported):
        enterVehicle, exitVehicle, getActiveVehicleProp, getActorRenderObject,
        handleGameplayMouseMove, handleLightGridClick, handleShowcaseMouseButton,
        isDrivingVehicle, respawnPlayer, selectShowcaseActor,
        setCollisionDebugEnabled, updateGameplayUI,
    } = deps;

    function setupTerrainPanel() {
        const modeSel = document.getElementById('terrain-mode');
        const colorIn = document.getElementById('terrain-color');
        const repeatIn = document.getElementById('terrain-repeat');
        const repeatVal = document.getElementById('terrain-repeat-value');
        const roughIn = document.getElementById('terrain-roughness');
        const roughVal = document.getElementById('terrain-roughness-value');
        const summary = document.getElementById('terrain-summary-value');
        const loadBtn = document.getElementById('terrain-load-image');
        const loadInput = document.getElementById('terrain-image-input');
        const sculptOff = document.getElementById('terrain-sculpt-off');
        const sculptOn = document.getElementById('terrain-sculpt-on');
        const sculptTool = document.getElementById('terrain-sculpt-tool');
        const sculptRadius = document.getElementById('terrain-sculpt-radius');
        const sculptRadiusVal = document.getElementById('terrain-sculpt-radius-value');
        const sculptStrength = document.getElementById('terrain-sculpt-strength');
        const sculptStrengthVal = document.getElementById('terrain-sculpt-strength-value');
        const sculptFlatten = document.getElementById('terrain-flatten-height');
        const sculptFlattenVal = document.getElementById('terrain-flatten-height-value');
        const sculptPaintColor = document.getElementById('terrain-paint-color');
        const foliageType = document.getElementById('terrain-foliage-type');
        const foliageDensity = document.getElementById('terrain-foliage-density');
        const foliageDensityVal = document.getElementById('terrain-foliage-density-value');

        const grassOff = document.getElementById('grass-off');
        const grassOn = document.getElementById('grass-on');
        const grassBase = document.getElementById('grass-base-color');
        const grassTip = document.getElementById('grass-tip-color');
        const grassWind = document.getElementById('grass-wind');
        const grassWindVal = document.getElementById('grass-wind-value');

        const updateSummary = () => {
            if (!summary) return;
            const mode = modeSel?.value ?? 'grid';
            summary.textContent = `${mode} · ${terrainBrushState.enabled ? 'sculpt' : colorIn?.value ?? '#fff'}`;
        };

        modeSel?.addEventListener('change', async () => {
            const mode = modeSel.value;
            if (mode === 'grid') await setTerrainModeGrid(core.worldFloor);
            else if (mode === 'solid') setTerrainModeSolid(core.worldFloor);
            else if (mode === 'grass') await setTerrainModeGrassPBR(core.worldFloor);
            else if (mode === 'custom') loadInput?.click();
            setTerrainRepeat(core.worldFloor, parseFloat(repeatIn?.value ?? 28));
            updateSummary();
        });

        colorIn?.addEventListener('input', () => {
            setTerrainTint(core.worldFloor, colorIn.value);
            updateSummary();
        });

        repeatIn?.addEventListener('input', () => {
            const v = parseFloat(repeatIn.value);
            if (repeatVal) repeatVal.textContent = String(v);
            setTerrainRepeat(core.worldFloor, v);
        });

        roughIn?.addEventListener('input', () => {
            const v = parseFloat(roughIn.value);
            if (roughVal) roughVal.textContent = v.toFixed(2);
            setTerrainRoughness(core.worldFloor, v);
        });

        loadBtn?.addEventListener('click', () => loadInput?.click());
        loadInput?.addEventListener('change', () => {
            const file = loadInput.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                setTerrainCustomImage(core.worldFloor, reader.result);
                if (modeSel) modeSel.value = 'custom';
                updateSummary();
            };
            reader.readAsDataURL(file);
        });

        const setSculptEnabled = (enabled) => {
            terrainBrushState.enabled = enabled;
            terrainBrushState.active = false;
            sculptOn?.classList.toggle('viewer-toggle-btn-active', enabled);
            sculptOff?.classList.toggle('viewer-toggle-btn-active', !enabled);
            if (!enabled && terrainBrushState.helper) terrainBrushState.helper.visible = false;
            updateSummary();
        };
        sculptOn?.addEventListener('click', () => setSculptEnabled(true));
        sculptOff?.addEventListener('click', () => setSculptEnabled(false));

        sculptTool?.addEventListener('change', () => {
            terrainBrushState.tool = sculptTool.value;
        });
        sculptRadius?.addEventListener('input', () => {
            const v = parseFloat(sculptRadius.value);
            terrainBrushState.radius = v;
            if (sculptRadiusVal) sculptRadiusVal.textContent = v.toFixed(1);
        });
        sculptStrength?.addEventListener('input', () => {
            const v = parseFloat(sculptStrength.value);
            terrainBrushState.strength = v;
            if (sculptStrengthVal) sculptStrengthVal.textContent = v.toFixed(2);
        });
        sculptFlatten?.addEventListener('input', () => {
            const v = parseFloat(sculptFlatten.value);
            terrainBrushState.flattenHeight = v;
            if (sculptFlattenVal) sculptFlattenVal.textContent = v.toFixed(1);
        });
        sculptPaintColor?.addEventListener('input', () => {
            terrainBrushState.paintColor = sculptPaintColor.value;
        });
        foliageType?.addEventListener('change', () => {
            terrainBrushState.foliageType = foliageType.value;
        });
        foliageDensity?.addEventListener('input', () => {
            const v = parseInt(foliageDensity.value, 10);
            terrainBrushState.foliageDensity = v;
            if (foliageDensityVal) foliageDensityVal.textContent = String(v);
        });

        const setGrassEnabled = (enabled) => {
            if (core.grassField?.setVisible) core.grassField.setVisible(enabled);
            else if (core.grassField?.mesh) core.grassField.mesh.visible = enabled;
            grassOn?.classList.toggle('viewer-toggle-btn-active', enabled);
            grassOff?.classList.toggle('viewer-toggle-btn-active', !enabled);
        };
        grassOn?.addEventListener('click', () => setGrassEnabled(true));
        grassOff?.addEventListener('click', () => setGrassEnabled(false));

        const applyGrassColors = () => {
            if (!core.grassField) return;
            const base = new THREE.Color(grassBase?.value ?? '#2f5a1c');
            const tip = new THREE.Color(grassTip?.value ?? '#a8d96b');
            core.grassField.setColors?.(base, tip);
        };
        grassBase?.addEventListener('input', applyGrassColors);
        grassTip?.addEventListener('input', applyGrassColors);

        grassWind?.addEventListener('input', () => {
            const v = parseFloat(grassWind.value);
            if (grassWindVal) grassWindVal.textContent = v.toFixed(2);
            core.grassField?.setWind?.(1, 0.3, v);
        });

        const spriteLoadBtn = document.getElementById('grass-sprite-load');
        const spriteClearBtn = document.getElementById('grass-sprite-clear');
        const spriteInput = document.getElementById('grass-sprite-input');
        const spriteStatus = document.getElementById('grass-sprite-status');
        const spriteTintIn = document.getElementById('grass-sprite-tint');
        const spriteTintVal = document.getElementById('grass-sprite-tint-value');
        const alphaCutoffIn = document.getElementById('grass-alpha-cutoff');
        const alphaCutoffVal = document.getElementById('grass-alpha-cutoff-value');

        spriteLoadBtn?.addEventListener('click', () => spriteInput?.click());
        spriteInput?.addEventListener('change', () => {
            const file = spriteInput.files?.[0];
            if (!file || !core.grassField) return;
            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    await core.grassField.setSpriteFromUrl?.(reader.result);
                    if (spriteStatus) spriteStatus.textContent = `Loaded: ${file.name}`;
                } catch (err) {
                    console.error('Grass sprite load failed', err);
                    if (spriteStatus) spriteStatus.textContent = `Failed to load ${file.name}`;
                }
            };
            reader.readAsDataURL(file);
        });
        spriteClearBtn?.addEventListener('click', () => {
            core.grassField?.clearSprite?.();
            if (spriteStatus) spriteStatus.textContent = 'Sprite cleared — using procedural blades.';
        });

        spriteTintIn?.addEventListener('input', () => {
            const v = parseFloat(spriteTintIn.value);
            if (spriteTintVal) spriteTintVal.textContent = v.toFixed(2);
            core.grassField?.setSpriteTint?.(v);
        });

        alphaCutoffIn?.addEventListener('input', () => {
            const v = parseFloat(alphaCutoffIn.value);
            if (alphaCutoffVal) alphaCutoffVal.textContent = v.toFixed(2);
            core.grassField?.setAlphaTest?.(v);
        });

        updateSummary();
    }

    function setupGameplayEvents() {
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
        document.addEventListener('keydown', (e) => {
            if (e.code !== 'KeyP' || e.repeat) return;
            const heli = physics.dynamicBodies.find(p => p.userData?.prefabId === 'helicopter');
            console.log('[diag] activeVehicleId:', gameplay.activeVehicleId);
            console.log('[diag] heli found:', !!heli, 'id:', heli?.id);
            console.log('[diag] source has OnInput:', heli?.scripts?.tick?.source?.includes('function OnInput'));
            console.log('[diag] source has Tick:', heli?.scripts?.tick?.source?.includes('function Tick'));
            console.log('[diag] script enabled:', heli?.scripts?.tick?.enabled);
            console.log('[diag] __ueLifecycle:', heli?.scripts?.tick?.compiled?.__ueLifecycle);
            console.log('[diag] handles keys:', Object.keys(heli?.scripts?.tick?.handles || {}));
            console.log('[diag] script error:', heli?.scripts?.tick?.error);
            console.log('[diag] script source:\n', heli?.scripts?.tick?.source);
            console.log('[diag] exampleWidgets:', window.exampleWidgets);
            console.log('[diag] speed widget _widgetId:', window.exampleWidgets?.speed?._widgetId);
            try { window.exampleWidgets?.speed?.SetText('DIAG TEST'); console.log('[diag] SetText called'); }
            catch (err) { console.log('[diag] SetText threw:', err); }
        });
        core.renderer.domElement.addEventListener('mousedown', handleShowcaseMouseButton);
        window.addEventListener('mouseup', handleShowcaseMouseButton);
        core.renderer.domElement.addEventListener('wheel', handleShowcaseWheel, { passive: false });
        core.renderer.domElement.addEventListener('contextmenu', handleShowcaseContextMenu);
        core.renderer.domElement.addEventListener('click', handleLightGridClick);
        // Blueprint mode: click on 3D viewport to select child components
        core.renderer.domElement.addEventListener('click', (event) => {
            if (!blueprintState.active) return;
            if (event.button !== 0) return;
            if (typeof core.transformControl !== 'undefined' && (core.transformControl.dragging || core.transformControl.justFinishedDragging || core.transformControl.axis !== null)) return;
            if (isTransformControlSphereHit(event)) return;
            
            const rect = core.renderer.domElement.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            
            pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(pointerNdc, core.camera);
            
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
                if (typeof core.transformControl !== 'undefined') core.transformControl.attach(hitObj);
                refreshBlueprintComponents();
            }
        });
        
        core.renderer.domElement.addEventListener('dblclick', (event) => {
            // Blueprint mode: double-click to focus camera on a component
            if (blueprintState.active) {
                const rect = core.renderer.domElement.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return;
                pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
                pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
                raycaster.setFromCamera(pointerNdc, core.camera);
                
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
                    if (typeof core.transformControl !== 'undefined') core.transformControl.attach(hitObj);
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
                
                if (core.sceneUiList) {
                    const activeItem = core.sceneUiList.querySelector(`[data-id="${propHit.prop.id}"]`);
                    if (activeItem) {
                        activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }
            }
        });
        core.renderer.domElement.addEventListener('pointerdown', (event) => {
            if (event.pointerType === 'mouse') return;
            if (gameplay.active) {
                // Mobile tap = fire. Set the fire flag for an engine weapon OR a
                // game mode (Drug Tycoon pistol/bat, Rogue weapon) — each mode's
                // own logic decides what "fire" does (shoot or swing the bat).
                if (gameplay.weapon.type || inGameMode()) {
                    gameplay.input.fire = true;
                    gameplay.input.firePressed = true;
                    event.preventDefault();
                    return;
                }
                // Free scene with no weapon: keep the throw-ball action.
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
        const releaseTouchFire = (event) => {
            if (event.pointerType !== 'mouse' && gameplay.active
                && (gameplay.weapon.type || inGameMode())) {
                gameplay.input.fire = false;
            }
        };
        core.renderer.domElement.addEventListener('pointerup', releaseTouchFire, { passive: true });
        core.renderer.domElement.addEventListener('pointercancel', releaseTouchFire, { passive: true });
    }

    function adjustShowcaseSpeed(direction) {
        const factor = direction > 0 ? showcase.wheelSpeedStep : 1 / showcase.wheelSpeedStep;
        showcase.moveSpeed = THREE.MathUtils.clamp(
            showcase.moveSpeed * factor,
            showcase.minMoveSpeed,
            showcase.maxMoveSpeed
        );
        updateGameplayUI();
    }

    function updateShowcaseInput(event, isDown) {
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

    function handleGameplayKeyEvent(event) {
        const isDown = event.type === 'keydown';
        const eventTarget = event.target instanceof HTMLElement ? event.target : document.activeElement;

        if (gameplay.active && gameplay.activeVehicleId && !event.repeat && event.code) {
            (isDown ? gameplay.inputPressedThisFrame : gameplay.inputReleasedThisFrame).push(event.code);
        }

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
            if (!event.repeat && event.code === 'KeyF' && !isEditableElement(eventTarget)) {
                if (focusCurrentShowcaseSelection()) {
                    event.preventDefault();
                }
                return;
            }
            if (!showcase.looking && event.code === 'KeyW') {
                core.transformControl?.setMode('translate');
                if (blueprintState.active) updateBlueprintTransformUI();
            } else if (!showcase.looking && event.code === 'KeyE') {
                core.transformControl?.setMode('rotate');
                if (blueprintState.active) updateBlueprintTransformUI();
            } else if (!showcase.looking && event.code === 'KeyR') {
                core.transformControl?.setMode('scale');
                if (blueprintState.active) updateBlueprintTransformUI();
            } else if (!showcase.looking && event.code === 'Backquote') { // Tilde key for toggling space
                if (core.transformControl) {
                    core.transformControl.setSpace(core.transformControl.space === 'local' ? 'world' : 'local');
                    if (blueprintState.active) updateBlueprintTransformUI();
                }
            }
        }

        if (!gameplay.active && !gameplay.pointerLocked) {
            const acceptsShowcaseInput = core.renderer && (showcase.looking || document.activeElement === core.renderer.domElement);
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
            case 'KeyR':
                // Reload press, consumed by weapon scripts (one-shot per keydown).
                if (isDown && !event.repeat) gameplay.input.reloadPressed = true;
                break;
            case 'ShiftLeft':
            case 'ShiftRight':
                gameplay.input.sprint = isDown;
                gameplay.input.descend = isDown;
                if (isDrivingVehicle() && getActiveVehicleProp()?.userData?.prefabId === 'helicopter') {
                    vehicleState.brakeHeld = isDown;
                }
                break;
            case 'Space':
                if (gameplay.pointerLocked) event.preventDefault();
                gameplay.input.lift = isDown;
                if (isDown && !event.repeat && gameplay.active) {
                    if (isDrivingVehicle()) {
                        if (getActiveVehicleProp()?.userData?.prefabId !== 'helicopter') {
                            vehicleState.brakeHeld = true;
                        }
                    } else {
                        physics.jumpQueued = true;
                    }
                } else if (!isDown) {
                    if (getActiveVehicleProp()?.userData?.prefabId !== 'helicopter') {
                        vehicleState.brakeHeld = false;
                    }
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

    return {
        setupTerrainPanel, setupGameplayEvents, adjustShowcaseSpeed,
        updateShowcaseInput, handleGameplayKeyEvent,
    };
}