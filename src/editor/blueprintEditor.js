// src/editor/blueprintEditor.js
// Extracted from main.js lines 10136–11114 (blueprint component editor).
// All module-scope dependencies are injected once by setupBlueprintEditor().

import * as THREE from 'three';
import gsap from 'gsap';

// Cross-module imports: serializeComponentTree / deserializeComponentTree are
// defined in sceneHistory.js and used in pasteFromClipboard / spawnActorFromJSON
// which live there. blueprintEditor calls them only via injected deps.
// (No static import needed here — they are passed via setupBlueprintEditor deps.)

// Module-scope deps — populated by setupBlueprintEditor, assigned once.
let scene, camera, transformControl;
let blueprintState, objectScriptState;
let sceneSystem;
let getDynamicPropById, getActorRenderObject, rebuildActorPhysics;
let refreshSceneUI, selectShowcaseActor, openObjectScriptEditor;
let applyShowcaseCameraRotation, buildPrimitiveActorMesh;
let clampMaterialStateValue, getObjectMaterialPreviewState, getObjectMaterialArray;
let applyObjectMaterialState;
let editorHistory;
let showcase, tempVectorA;

export function setupBlueprintEditor(deps) {
    ({
        scene,
        camera,
        transformControl,
        blueprintState,
        objectScriptState,
        sceneSystem,
        getDynamicPropById,
        getActorRenderObject,
        rebuildActorPhysics,
        refreshSceneUI,
        selectShowcaseActor,
        openObjectScriptEditor,
        applyShowcaseCameraRotation,
        buildPrimitiveActorMesh,
        clampMaterialStateValue,
        getObjectMaterialPreviewState,
        getObjectMaterialArray,
        applyObjectMaterialState,
        editorHistory,
        showcase,
        tempVectorA,
    } = deps);
}

// ─── lines 10136–10238 ─────────────────────────────────────────────────────────────

export function enterBlueprintEditor() {
    const actorId = objectScriptState.targetPropId;
    if (!actorId) return;
    const prop = getDynamicPropById(actorId);
    if (!prop || !getActorRenderObject(prop)) return;

    blueprintState.active = true;
    if (typeof transformControl !== 'undefined') {
        transformControl.setSpace('local');
        transformControl.setMode('translate');
    }
    if (typeof updateBlueprintTransformUI === 'function') updateBlueprintTransformUI();
    blueprintState.targetActor = prop;
    blueprintState.selectedComponent = getActorRenderObject(prop);
    blueprintState.selectedComponents.clear();
    blueprintState.materialMultiSelectActive = false;

    blueprintState.savedCameraPosition = camera.position.clone();
    blueprintState.savedShowcaseAngles = { yaw: showcase.yaw, pitch: showcase.pitch };
    blueprintState.savedBackground = scene.background;
    scene.background = new THREE.Color(0x1a1a1a);

    for (const actor of sceneSystem.actors) {
        if (actor !== prop) {
            const mesh = getActorRenderObject(actor);
            if (mesh) mesh.visible = false;
        }
    }

    // Clean up previous blueprint objects
    if (blueprintState.floorMesh) {
        scene.remove(blueprintState.floorMesh);
    }
    if (blueprintState.gridHelper) {
        scene.remove(blueprintState.gridHelper);
    }
    if (blueprintState.editorLights) {
        blueprintState.editorLights.forEach(l => scene.remove(l));
    }

    const targetPos = getActorRenderObject(prop).position.clone();
    const floorY = targetPos.y - 1;

    // Floor plane
    const floorGeo = new THREE.PlaneGeometry(50, 50);
    const floorMat = new THREE.MeshStandardMaterial({
        color: 0x2a2a2a,
        roughness: 0.95,
        metalness: 0.0
    });
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.set(targetPos.x, floorY, targetPos.z);
    floorMesh.receiveShadow = true;
    scene.add(floorMesh);
    blueprintState.floorMesh = floorMesh;

    // Grid helper
    const gridHelper = new THREE.GridHelper(50, 50, 0x555555, 0x333333);
    gridHelper.position.set(targetPos.x, floorY + 0.01, targetPos.z);
    scene.add(gridHelper);
    blueprintState.gridHelper = gridHelper;

    // Blueprint editor lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(targetPos.x + 5, targetPos.y + 8, targetPos.z + 5);
    dirLight.target.position.copy(targetPos);
    scene.add(dirLight.target);
    scene.add(ambientLight);
    scene.add(dirLight);
    blueprintState.editorLights = [ambientLight, dirLight, dirLight.target];

    // Snap camera to look at the actor
    const camTarget = targetPos.clone();
    camera.position.set(camTarget.x + 4, camTarget.y + 3, camTarget.z + 4);

    const forward = new THREE.Vector3().subVectors(camTarget, camera.position).normalize();
    showcase.yaw = Math.atan2(-forward.x, -forward.z);
    showcase.pitch = Math.asin(forward.y);
    applyShowcaseCameraRotation();

    const panel = document.getElementById('blueprint-editor-panel');
    const menuSections = document.querySelector('.viewer-menu-sections-card');
    const actorsMenu = document.querySelector('.viewer-menu-card:nth-child(2)');
    const cameraMenu = document.querySelector('.viewer-menu-card:first-child');
    const sceneUi = document.getElementById('scene-ui-panel');

    if (panel) {
        document.getElementById('blueprint-actor-name').textContent = prop.rootNode.name || actorId;
        panel.style.display = 'block';
        if (menuSections) menuSections.style.display = 'none';
        if (actorsMenu) actorsMenu.style.display = 'none';
        if (cameraMenu) cameraMenu.style.display = 'none';
        if (sceneUi) sceneUi.style.display = 'none';
        refreshBlueprintComponents();
    }

    refreshSceneUI();
}

// ─── lines 10240–10315 ─────────────────────────────────────────────────────────────

export function exitBlueprintEditor() {
    blueprintState.active = false;
    blueprintState.targetActor = null;
    blueprintState.selectedComponent = null;
    blueprintState.selectedComponents.clear();
    blueprintState.materialMultiSelectActive = false;

    if (typeof sceneSystem !== 'undefined') {
        for (const actor of sceneSystem.actors) {
            const mesh = getActorRenderObject(actor);
            if (mesh) mesh.visible = true;
        }
    }

    if (blueprintState.floorMesh) {
        scene.remove(blueprintState.floorMesh);
        blueprintState.floorMesh = null;
    }
    if (blueprintState.gridHelper) {
        scene.remove(blueprintState.gridHelper);
        blueprintState.gridHelper = null;
    }
    if (blueprintState.editorLights) {
        blueprintState.editorLights.forEach(l => scene.remove(l));
        blueprintState.editorLights = null;
    }

    if (blueprintState.savedCameraPosition && typeof gsap !== 'undefined') {
        gsap.to(camera.position, {
            x: blueprintState.savedCameraPosition.x,
            y: blueprintState.savedCameraPosition.y,
            z: blueprintState.savedCameraPosition.z,
            duration: 0.5
        });
        showcase.yaw = blueprintState.savedShowcaseAngles.yaw;
        showcase.pitch = blueprintState.savedShowcaseAngles.pitch;
        applyShowcaseCameraRotation();
    }

    if (blueprintState.savedBackground) {
        scene.background = blueprintState.savedBackground;
    }

    const panel = document.getElementById('blueprint-editor-panel');
    const menuSections = document.querySelector('.viewer-menu-sections-card');
    const actorsMenu = document.querySelector('.viewer-menu-card:nth-child(2)');
    const cameraMenu = document.querySelector('.viewer-menu-card:first-child');
    const sceneUi = document.getElementById('scene-ui-panel');

    if (panel) {
        panel.style.display = 'none';
        if (menuSections) menuSections.style.display = 'block';
        if (actorsMenu) actorsMenu.style.display = 'block';
        if (cameraMenu) cameraMenu.style.display = 'block';
        if (sceneUi) sceneUi.style.display = 'flex';
    }

    const propId = objectScriptState.targetPropId;
    if (propId) {
        const prop = getDynamicPropById(propId);
        if (typeof transformControl !== 'undefined' && prop && getActorRenderObject(prop)) {
            transformControl.attach(getActorRenderObject(prop));
        }
        if (prop?.kind === 'imported') {
            rebuildActorPhysics(prop);
        }
    }

    refreshSceneUI();
}

// ─── lines 10317–10319 ─────────────────────────────────────────────────────────────

export function formatBlueprintMaterialScalar(value, fallback = 0, min = 0, max = 1, decimals = 2) {
    return clampMaterialStateValue(value, fallback, min, max).toFixed(decimals);
}

// ─── lines 10321–10362 ─────────────────────────────────────────────────────────────

export function getBlueprintMaterialEditorRefs() {
    return {
        target: document.getElementById('bp-material-target'),
        status: document.getElementById('bp-material-status'),
        materialGrid: document.getElementById('bp-material-grid'),
        materialHint: document.querySelector('.bp-material-hint'),
        materialActions: document.querySelector('.bp-material-actions'),
        lightGrid: document.getElementById('bp-light-grid'),
        lightColor: document.getElementById('bp-light-color'),
        lightIntensity: document.getElementById('bp-light-intensity'),
        lightIntensityNumber: document.getElementById('bp-light-intensity-number'),
        lightDistance: document.getElementById('bp-light-distance'),
        lightDistanceNumber: document.getElementById('bp-light-distance-number'),
        lightDecay: document.getElementById('bp-light-decay'),
        lightDecayNumber: document.getElementById('bp-light-decay-number'),
        lightAngle: document.getElementById('bp-light-angle'),
        lightAngleNumber: document.getElementById('bp-light-angle-number'),
        lightPenumbra: document.getElementById('bp-light-penumbra'),
        lightPenumbraNumber: document.getElementById('bp-light-penumbra-number'),
        lightTargetX: document.getElementById('bp-light-target-x'),
        lightTargetY: document.getElementById('bp-light-target-y'),
        lightTargetZ: document.getElementById('bp-light-target-z'),
        lightCastShadow: document.getElementById('bp-light-cast-shadow'),
        color: document.getElementById('bp-material-color'),
        emissive: document.getElementById('bp-material-emissive'),
        roughness: document.getElementById('bp-material-roughness'),
        roughnessNumber: document.getElementById('bp-material-roughness-number'),
        metalness: document.getElementById('bp-material-metalness'),
        metalnessNumber: document.getElementById('bp-material-metalness-number'),
        emissiveIntensity: document.getElementById('bp-material-emissive-intensity'),
        emissiveIntensityNumber: document.getElementById('bp-material-emissive-intensity-number'),
        opacity: document.getElementById('bp-material-opacity'),
        opacityNumber: document.getElementById('bp-material-opacity-number'),
        alphaTest: document.getElementById('bp-material-alpha-test'),
        alphaTestNumber: document.getElementById('bp-material-alpha-test-number'),
        envIntensity: document.getElementById('bp-material-env-intensity'),
        envIntensityNumber: document.getElementById('bp-material-env-intensity-number'),
        side: document.getElementById('bp-material-side'),
        applySelected: document.getElementById('btn-bp-apply-material-selected'),
        applyActor: document.getElementById('btn-bp-apply-material-actor'),
    };
}

// ─── lines 10364–10372 ─────────────────────────────────────────────────────────────

export function getBlueprintComponentDisplayName(object3D) {
    if (!object3D) return 'Nothing selected';
    if (object3D.userData?.isCollisionShape) return object3D.name || 'Collision Box';
    if (object3D.name) return object3D.name;
    if (object3D.isSpotLight) return 'Spot Light';
    if (object3D.isPointLight) return 'Point Light';
    if (object3D.isLight) return object3D.type || 'Light';
    if (object3D.isMesh) return object3D.geometry?.type || 'Mesh';
    return object3D.type || 'Object3D';
}

// ─── lines 10374–10376 ─────────────────────────────────────────────────────────────

export function isBlueprintMaterialTarget(object3D) {
    return !!object3D?.isMesh && !object3D.userData?.isCollisionShape;
}

// ─── lines 10378–10387 ─────────────────────────────────────────────────────────────

export function getBlueprintMaterialTargets() {
    const selectedMeshes = Array.from(blueprintState.selectedComponents || [])
        .filter(isBlueprintMaterialTarget);
    if (blueprintState.materialMultiSelectActive || selectedMeshes.length > 0) {
        return selectedMeshes;
    }
    return isBlueprintMaterialTarget(blueprintState.selectedComponent)
        ? [blueprintState.selectedComponent]
        : [];
}

// ─── lines 10389–10394 ─────────────────────────────────────────────────────────────

export function getBlueprintMaterialPreviewTarget() {
    if (isBlueprintMaterialTarget(blueprintState.selectedComponent)) {
        return blueprintState.selectedComponent;
    }
    return getBlueprintMaterialTargets()[0] || null;
}

// ─── lines 10396–10400 ─────────────────────────────────────────────────────────────

export function setBlueprintMaterialScalarPair(rangeInput, numberInput, value, fallback = 0, min = 0, max = 1, decimals = 2) {
    const formatted = formatBlueprintMaterialScalar(value, fallback, min, max, decimals);
    if (rangeInput) rangeInput.value = formatted;
    if (numberInput) numberInput.value = formatted;
}

// ─── lines 10402–10408 ─────────────────────────────────────────────────────────────

export function setBlueprintDetailsMode(refs, mode) {
    const lightMode = mode === 'light';
    if (refs.materialGrid) refs.materialGrid.hidden = lightMode;
    if (refs.materialHint) refs.materialHint.hidden = lightMode;
    if (refs.materialActions) refs.materialActions.hidden = lightMode;
    if (refs.lightGrid) refs.lightGrid.hidden = !lightMode;
}

// ─── lines 10410–10419 ─────────────────────────────────────────────────────────────

export function syncBlueprintLightScalarInput(sourceId, targetId, fallback = 0, min = 0, max = 1, decimals = 2) {
    const source = document.getElementById(sourceId);
    const target = document.getElementById(targetId);
    if (!source || !target) return;

    const parsedValue = Number.parseFloat(source.value);
    const formatted = formatBlueprintMaterialScalar(parsedValue, fallback, min, max, decimals);
    source.value = formatted;
    target.value = formatted;
}

// ─── lines 10421–10425 ─────────────────────────────────────────────────────────────

export function setBlueprintLightScalarPair(rangeInput, numberInput, value, fallback = 0, min = 0, max = 1, decimals = 2) {
    const formatted = formatBlueprintMaterialScalar(value, fallback, min, max, decimals);
    if (rangeInput) rangeInput.value = formatted;
    if (numberInput) numberInput.value = formatted;
}

// ─── lines 10427–10432 ─────────────────────────────────────────────────────────────

export function readBlueprintLightScalarInput(numberId, rangeId, fallback = 0, min = 0, max = 1) {
    const numberInput = document.getElementById(numberId);
    const rangeInput = document.getElementById(rangeId);
    const rawValue = numberInput?.value ?? rangeInput?.value ?? `${fallback}`;
    return clampMaterialStateValue(Number.parseFloat(rawValue), fallback, min, max);
}

// ─── lines 10434–10438 ─────────────────────────────────────────────────────────────

export function setBlueprintSpotRowsVisible(visible) {
    document.querySelectorAll('.bp-light-spot-row').forEach((row) => {
        row.hidden = !visible;
    });
}

// ─── lines 10440–10465 ─────────────────────────────────────────────────────────────

export function syncBlueprintLightEditor(refs, light, statusMessage = '') {
    setBlueprintDetailsMode(refs, 'light');
    if (!light) return;

    const isSpot = !!light.isSpotLight;
    setBlueprintSpotRowsVisible(isSpot);
    if (refs.target) refs.target.textContent = `Target: ${getBlueprintComponentDisplayName(light)}`;
    if (refs.status) {
        refs.status.textContent = statusMessage || (isSpot
            ? 'Spot Light properties update live. Target is local to the light.'
            : 'Point Light properties update live.');
    }

    if (refs.lightColor) refs.lightColor.value = `#${light.color.getHexString()}`;
    setBlueprintLightScalarPair(refs.lightIntensity, refs.lightIntensityNumber, light.intensity, 1, 0, 20, 1);
    setBlueprintLightScalarPair(refs.lightDistance, refs.lightDistanceNumber, light.distance ?? 0, 0, 0, 100, 1);
    setBlueprintLightScalarPair(refs.lightDecay, refs.lightDecayNumber, light.decay ?? 2, 2, 0, 4, 1);
    setBlueprintLightScalarPair(refs.lightAngle, refs.lightAngleNumber, THREE.MathUtils.radToDeg(light.angle ?? Math.PI / 6), 30, 1, 120, 0);
    setBlueprintLightScalarPair(refs.lightPenumbra, refs.lightPenumbraNumber, light.penumbra ?? 0, 0, 0, 1, 2);
    if (refs.lightCastShadow) refs.lightCastShadow.checked = !!light.castShadow;

    const targetPosition = light.target?.position || tempVectorA.set(0, -1.5, 0);
    if (refs.lightTargetX) refs.lightTargetX.value = (targetPosition.x || 0).toFixed(2);
    if (refs.lightTargetY) refs.lightTargetY.value = (targetPosition.y || 0).toFixed(2);
    if (refs.lightTargetZ) refs.lightTargetZ.value = (targetPosition.z || 0).toFixed(2);
}

// ─── lines 10467–10491 ─────────────────────────────────────────────────────────────

export function setBlueprintMaterialEditorEnabled(refs, enabled) {
    [
        refs.color,
        refs.emissive,
        refs.roughness,
        refs.roughnessNumber,
        refs.metalness,
        refs.metalnessNumber,
        refs.emissiveIntensity,
        refs.emissiveIntensityNumber,
        refs.opacity,
        refs.opacityNumber,
        refs.alphaTest,
        refs.alphaTestNumber,
        refs.envIntensity,
        refs.envIntensityNumber,
        refs.side,
        refs.applySelected,
        refs.applyActor,
    ].forEach((element) => {
        if (element) {
            element.disabled = !enabled;
        }
    });
}

// ─── lines 10493–10549 ─────────────────────────────────────────────────────────────

export function syncBlueprintMaterialEditor(statusMessage = '') {
    const refs = getBlueprintMaterialEditorRefs();
    if (!refs.target || !refs.status) return;

    const comp = getBlueprintMaterialPreviewTarget() || blueprintState.selectedComponent;
    if (comp?.isLight) {
        syncBlueprintLightEditor(refs, comp, statusMessage);
        return;
    }

    setBlueprintDetailsMode(refs, 'material');
    setBlueprintSpotRowsVisible(false);
    const targets = getBlueprintMaterialTargets();
    refs.target.textContent = targets.length > 1
        ? `Targets: ${targets.length} meshes`
        : `Target: ${getBlueprintComponentDisplayName(comp)}`;

    const materialState = getObjectMaterialPreviewState(comp);
    const isEditable = targets.length > 0 && !!materialState;
    setBlueprintMaterialEditorEnabled(refs, isEditable);

    if (!isEditable) {
        if (refs.color) refs.color.value = '#888888';
        if (refs.emissive) refs.emissive.value = '#000000';
        setBlueprintMaterialScalarPair(refs.roughness, refs.roughnessNumber, 0.5, 0.5);
        setBlueprintMaterialScalarPair(refs.metalness, refs.metalnessNumber, 0, 0);
        setBlueprintMaterialScalarPair(refs.emissiveIntensity, refs.emissiveIntensityNumber, 1, 1, 0, 8);
        setBlueprintMaterialScalarPair(refs.opacity, refs.opacityNumber, 1, 1);
        setBlueprintMaterialScalarPair(refs.alphaTest, refs.alphaTestNumber, 0, 0);
        setBlueprintMaterialScalarPair(refs.envIntensity, refs.envIntensityNumber, 1, 1, 0, 4);
        if (refs.side) refs.side.value = 'front';
        refs.status.textContent = blueprintState.materialMultiSelectActive && targets.length === 0
            ? 'No mesh material targets selected. Ctrl/Shift-click mesh components to add them.'
            : comp?.isLight
            ? 'Selected component is a light. Material editor only applies to mesh components.'
            : 'Select a mesh component to edit base color, emissive glow, reflectivity, opacity, and surface response.';
        return;
    }

    if (refs.color) refs.color.value = materialState.color || '#888888';
    if (refs.emissive) refs.emissive.value = materialState.emissive || '#000000';
    setBlueprintMaterialScalarPair(refs.roughness, refs.roughnessNumber, materialState.roughness, 0.5);
    setBlueprintMaterialScalarPair(refs.metalness, refs.metalnessNumber, materialState.metalness, 0);
    setBlueprintMaterialScalarPair(refs.emissiveIntensity, refs.emissiveIntensityNumber, materialState.emissiveIntensity, 1, 0, 8);
    setBlueprintMaterialScalarPair(refs.opacity, refs.opacityNumber, materialState.opacity, 1);
    setBlueprintMaterialScalarPair(refs.alphaTest, refs.alphaTestNumber, materialState.alphaTest, 0);
    setBlueprintMaterialScalarPair(refs.envIntensity, refs.envIntensityNumber, materialState.envMapIntensity, 1, 0, 4);
    if (refs.side) refs.side.value = materialState.side || 'front';

    const materialCount = getObjectMaterialArray(comp).length;
    const defaultStatus = targets.length > 1
        ? `Editing ${targets.length} selected meshes. Values preview from ${getBlueprintComponentDisplayName(comp)}.`
        : materialCount > 1
        ? `This mesh has ${materialCount} material slots. The editor previews slot 1, Apply stamps all slots, and save/load preserves per-slot data.`
        : 'Selected mesh updates live and now persists richer material data with actor save/load.';
    refs.status.textContent = statusMessage || defaultStatus;
}

// ─── lines 10551–10560 ─────────────────────────────────────────────────────────────

export function syncBlueprintMaterialScalarInput(sourceId, targetId, fallback = 0, min = 0, max = 1, decimals = 2) {
    const source = document.getElementById(sourceId);
    const target = document.getElementById(targetId);
    if (!source || !target) return;

    const parsedValue = Number.parseFloat(source.value);
    const formatted = formatBlueprintMaterialScalar(parsedValue, fallback, min, max, decimals);
    source.value = formatted;
    target.value = formatted;
}

// ─── lines 10562–10567 ─────────────────────────────────────────────────────────────

export function readBlueprintMaterialScalarInput(numberId, rangeId, fallback = 0, min = 0, max = 1) {
    const numberInput = document.getElementById(numberId);
    const rangeInput = document.getElementById(rangeId);
    const rawValue = numberInput?.value ?? rangeInput?.value ?? `${fallback}`;
    return clampMaterialStateValue(Number.parseFloat(rawValue), fallback, min, max);
}

// ─── lines 10569–10585 ─────────────────────────────────────────────────────────────

export function readBlueprintMaterialEditorState() {
    const refs = getBlueprintMaterialEditorRefs();
    if (!getBlueprintMaterialTargets().length || !refs.color) return null;

    return {
        color: refs.color.value || '#888888',
        emissive: refs.emissive?.value || '#000000',
        roughness: readBlueprintMaterialScalarInput('bp-material-roughness-number', 'bp-material-roughness', 0.5, 0, 1),
        metalness: readBlueprintMaterialScalarInput('bp-material-metalness-number', 'bp-material-metalness', 0, 0, 1),
        emissiveIntensity: readBlueprintMaterialScalarInput('bp-material-emissive-intensity-number', 'bp-material-emissive-intensity', 1, 0, 8),
        opacity: readBlueprintMaterialScalarInput('bp-material-opacity-number', 'bp-material-opacity', 1, 0, 1),
        alphaTest: readBlueprintMaterialScalarInput('bp-material-alpha-test-number', 'bp-material-alpha-test', 0, 0, 1),
        envMapIntensity: readBlueprintMaterialScalarInput('bp-material-env-intensity-number', 'bp-material-env-intensity', 1, 0, 4),
        transparent: readBlueprintMaterialScalarInput('bp-material-opacity-number', 'bp-material-opacity', 1, 0, 1) < 0.999,
        side: refs.side?.value || 'front',
    };
}

// ─── lines 10587–10618 ─────────────────────────────────────────────────────────────

export function applyBlueprintMaterialEdits({ applyToActor = false, captureHistory = true, refresh = true, statusMessage = '' } = {}) {
    const prop = blueprintState.targetActor;
    const rootMesh = getActorRenderObject(prop);
    const targets = getBlueprintMaterialTargets();
    const materialState = readBlueprintMaterialEditorState();
    if (!rootMesh || (!applyToActor && !targets.length) || !materialState) return;

    if (captureHistory) {
        editorHistory.captureState();
    }

    let nextStatus = statusMessage;
    if (applyToActor) {
        rootMesh.traverse((child) => {
            if (child?.isMesh) {
                applyObjectMaterialState(child, materialState);
            }
        });
        nextStatus ||= 'Applied the current material settings to every mesh under the actor.';
    } else {
        targets.forEach((target) => applyObjectMaterialState(target, materialState));
        nextStatus ||= targets.length > 1
            ? `Applied material to ${targets.length} selected meshes.`
            : `Applied material to ${getBlueprintComponentDisplayName(targets[0])}.`;
    }
    rootMesh.userData.hasMaterialOverrides = true;

    if (refresh) {
        refreshBlueprintComponents();
    }
    syncBlueprintMaterialEditor(nextStatus);
}

// ─── lines 10620–10629 ─────────────────────────────────────────────────────────────

export function previewBlueprintMaterialEdits() {
    applyBlueprintMaterialEdits({
        applyToActor: false,
        captureHistory: false,
        refresh: false,
        statusMessage: getBlueprintMaterialTargets().length > 1
            ? `Live preview active on ${getBlueprintMaterialTargets().length} selected meshes.`
            : 'Live preview active. Save Actor now captures the currently shown selected-mesh material values.',
    });
}

// ─── lines 10631–10649 ─────────────────────────────────────────────────────────────

export function readBlueprintLightEditorState() {
    const refs = getBlueprintMaterialEditorRefs();
    if (!blueprintState.selectedComponent?.isLight || !refs.lightColor) return null;

    return {
        color: refs.lightColor.value || '#fff2cc',
        intensity: readBlueprintLightScalarInput('bp-light-intensity-number', 'bp-light-intensity', 1, 0, 20),
        distance: readBlueprintLightScalarInput('bp-light-distance-number', 'bp-light-distance', 0, 0, 100),
        decay: readBlueprintLightScalarInput('bp-light-decay-number', 'bp-light-decay', 2, 0, 4),
        angle: THREE.MathUtils.degToRad(readBlueprintLightScalarInput('bp-light-angle-number', 'bp-light-angle', 30, 1, 120)),
        penumbra: readBlueprintLightScalarInput('bp-light-penumbra-number', 'bp-light-penumbra', 0, 0, 1),
        castShadow: !!refs.lightCastShadow?.checked,
        target: new THREE.Vector3(
            Number.parseFloat(refs.lightTargetX?.value) || 0,
            Number.parseFloat(refs.lightTargetY?.value) || 0,
            Number.parseFloat(refs.lightTargetZ?.value) || 0
        ),
    };
}

// ─── lines 10651–10678 ─────────────────────────────────────────────────────────────

export function applyBlueprintLightEdits({ captureHistory = false, statusMessage = '' } = {}) {
    const light = blueprintState.selectedComponent;
    const state = readBlueprintLightEditorState();
    if (!light?.isLight || !state) return;

    if (captureHistory) {
        editorHistory.captureState();
    }

    light.color.set(state.color);
    light.intensity = state.intensity;
    if ('distance' in light) light.distance = state.distance;
    if ('decay' in light) light.decay = state.decay;
    light.castShadow = state.castShadow;

    if (light.isSpotLight) {
        light.angle = state.angle;
        light.penumbra = state.penumbra;
        light.target.position.copy(state.target);
        if (light.target.parent !== light) {
            light.add(light.target);
        }
        light.target.updateMatrixWorld(true);
    }

    light.updateMatrixWorld(true);
    syncBlueprintLightEditor(getBlueprintMaterialEditorRefs(), light, statusMessage || 'Light properties updated.');
}

// ─── lines 10680–10773 ─────────────────────────────────────────────────────────────

export function refreshBlueprintComponents() {
    updateBlueprintDetailsUI();
    syncBlueprintMaterialEditor();
    const container = document.getElementById('selected-actor-components');
    if (!container) return;
    container.innerHTML = '';

    const propId = objectScriptState.targetPropId;
    if (!propId) return;

    const prop = getDynamicPropById(propId);
    const rootMesh = getActorRenderObject(prop);
    if (!rootMesh) return;

    function renderComponentItem(object3D, depth, isRoot) {
        const isInternal = !!(object3D.userData?.vehicleVisual)
            || object3D.name === 'vehicle-engine-wasm-audio'
            || object3D.isAudio === true
            || object3D.isPositionalAudio === true;
        const showItem = isRoot || object3D.isMesh || object3D.isLight;

        if (showItem && !isInternal) {
            const item = document.createElement('div');
            const isPrimarySelected = blueprintState.selectedComponent === object3D;
            const isMultiSelected = blueprintState.selectedComponents?.has(object3D);
            item.style.padding = `4px 4px 4px ${4 + depth * 12}px`;
            item.style.cursor = 'pointer';
            item.style.borderRadius = '4px';
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.justifyContent = 'space-between';
            item.style.background = isPrimarySelected
                ? 'rgba(112, 0, 255, 0.4)'
                : isMultiSelected
                    ? 'rgba(112, 0, 255, 0.22)'
                    : 'rgba(255,255,255,0.05)';
            item.style.border = isPrimarySelected
                ? '1px solid rgba(112, 0, 255, 0.8)'
                : isMultiSelected
                    ? '1px solid rgba(112, 0, 255, 0.55)'
                    : '1px solid transparent';

            const label = document.createElement('span');
            let typeName = 'Group';
            if (isRoot) typeName = 'Root';
            else if (object3D.userData?.isCollisionShape) typeName = 'Collision Box';
            else if (object3D.isSpotLight) typeName = 'Spot Light';
            else if (object3D.isPointLight) typeName = 'Point Light';
            else if (object3D.isLight) typeName = 'Light';
            else if (object3D.geometry?.type === 'BoxGeometry') typeName = 'Cube Mesh';
            else if (object3D.geometry?.type === 'SphereGeometry') typeName = 'Sphere Mesh';
            else if (object3D.geometry?.type === 'CylinderGeometry') typeName = 'Cylinder Mesh';
            else if (object3D.geometry?.type === 'PlaneGeometry') typeName = 'Plane Mesh';
            else if (object3D.geometry?.type) typeName = object3D.geometry.type.replace('Geometry', ' Mesh');
            else if (object3D.isMesh) typeName = 'Mesh';

            label.textContent = object3D.name || typeName;
            label.style.fontSize = '13px';
            item.appendChild(label);

            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const additiveSelection = (e.ctrlKey || e.metaKey || e.shiftKey) && isBlueprintMaterialTarget(object3D);
                if (additiveSelection) {
                    blueprintState.materialMultiSelectActive = true;
                    if (blueprintState.selectedComponents.has(object3D)) {
                        blueprintState.selectedComponents.delete(object3D);
                    } else {
                        blueprintState.selectedComponents.add(object3D);
                    }
                } else {
                    blueprintState.selectedComponents.clear();
                    blueprintState.materialMultiSelectActive = false;
                    if (isBlueprintMaterialTarget(object3D)) {
                        blueprintState.selectedComponents.add(object3D);
                    }
                }
                blueprintState.selectedComponent = object3D;
                if (typeof transformControl !== 'undefined') transformControl.attach(object3D);
                refreshBlueprintComponents();
            });

            container.appendChild(item);
        }

        for (const child of object3D.children) {
            renderComponentItem(child, depth + 1, false);
        }
    }

    renderComponentItem(rootMesh, 0, true);
}

// ─── lines 10886–10904 ─────────────────────────────────────────────────────────────

export function updateBlueprintTransformUI() {
    if (!transformControl) return;

    const mode = transformControl.getMode();
    const space = transformControl.space;

    const btnTranslate = document.getElementById('btn-bp-translate');
    const btnRotate = document.getElementById('btn-bp-rotate');
    const btnScale = document.getElementById('btn-bp-scale');
    const btnLocal = document.getElementById('btn-bp-space-local');
    const btnWorld = document.getElementById('btn-bp-space-world');

    if (btnTranslate) btnTranslate.style.background = mode === 'translate' ? 'rgba(112,0,255,0.4)' : '';
    if (btnRotate) btnRotate.style.background = mode === 'rotate' ? 'rgba(112,0,255,0.4)' : '';
    if (btnScale) btnScale.style.background = mode === 'scale' ? 'rgba(112,0,255,0.4)' : '';

    if (btnLocal) btnLocal.style.background = space === 'local' ? 'rgba(112,0,255,0.4)' : '';
    if (btnWorld) btnWorld.style.background = space === 'world' ? 'rgba(112,0,255,0.4)' : '';
}

// ─── lines 10940–10955 ─────────────────────────────────────────────────────────────

export function updateBlueprintDetailsUI() {
    if (!blueprintState.active || !blueprintState.selectedComponent) return;
    const comp = blueprintState.selectedComponent;

    document.getElementById('bp-loc-x').value = comp.position.x.toFixed(3);
    document.getElementById('bp-loc-y').value = comp.position.y.toFixed(3);
    document.getElementById('bp-loc-z').value = comp.position.z.toFixed(3);

    document.getElementById('bp-rot-x').value = THREE.MathUtils.radToDeg(comp.rotation.x).toFixed(1);
    document.getElementById('bp-rot-y').value = THREE.MathUtils.radToDeg(comp.rotation.y).toFixed(1);
    document.getElementById('bp-rot-z').value = THREE.MathUtils.radToDeg(comp.rotation.z).toFixed(1);

    document.getElementById('bp-scl-x').value = comp.scale.x.toFixed(3);
    document.getElementById('bp-scl-y').value = comp.scale.y.toFixed(3);
    document.getElementById('bp-scl-z').value = comp.scale.z.toFixed(3);
}

// ─── lines 10957–10972 ─────────────────────────────────────────────────────────────

export function applyBlueprintDetailsFromUI() {
    if (!blueprintState.active || !blueprintState.selectedComponent) return;
    const comp = blueprintState.selectedComponent;

    comp.position.x = parseFloat(document.getElementById('bp-loc-x').value) || 0;
    comp.position.y = parseFloat(document.getElementById('bp-loc-y').value) || 0;
    comp.position.z = parseFloat(document.getElementById('bp-loc-z').value) || 0;

    comp.rotation.x = THREE.MathUtils.degToRad(parseFloat(document.getElementById('bp-rot-x').value) || 0);
    comp.rotation.y = THREE.MathUtils.degToRad(parseFloat(document.getElementById('bp-rot-y').value) || 0);
    comp.rotation.z = THREE.MathUtils.degToRad(parseFloat(document.getElementById('bp-rot-z').value) || 0);

    comp.scale.x = parseFloat(document.getElementById('bp-scl-x').value) || 1;
    comp.scale.y = parseFloat(document.getElementById('bp-scl-y').value) || 1;
    comp.scale.z = parseFloat(document.getElementById('bp-scl-z').value) || 1;
}
