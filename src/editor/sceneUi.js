// src/editor/sceneUi.js
// Extracted from main.js (chore/main-js-shrink-2). Holds three editor surfaces:
//   1. Post-process volume UI (formatPostProcessValue … applyPostProcessSettingsFromUi)
//   2. Actor / blueprint editor side-panel (syncActorEditor* / openActorEditor / spawnActorFromEditor)
//   3. World environment ("Sky / Sun / Ambient / Bloom / Fog") panel (loadWorldEnvFromStorage … resetWorldEnvDefaults)
//      + the master scene-list refresh (refreshSceneUI / createSceneActorItem).
//
// Late-init refs (ambientLight, hemiLight, mainDirectionalLight, ddgiVolume,
// volumetricFogController) come through as getters because they are assigned in
// init() AFTER wireExtractedModules runs.

import * as THREE from 'three';
import gsap from 'gsap';

// State + DOM refs (snapshot at wire time — these are populated earlier in init)
let gameplay, blueprintState, objectScriptState, importedPropState;
let physics, collisionDebugState, mobileState;
let camera, renderer, scene, sceneSystem;
let transformControl;
let actorEditor, actorEditorSummary, actorEditorStatus;
let actorKindSelect, actorLabelInput, actorScaleInput;
let actorImportedTemplateSelect, actorVehicleBodyTemplateSelect, actorVehicleWheelTemplateSelect;
let actorComponentCollisionInput, actorComponentPhysicsInput, actorComponentScriptsInput;
let actorEditorState;
let setPendingVehicleTemplateImportSlot, vehicleTemplateImportInput;
let postProcessUiRefs, postProcessUiState, postProcessVolumeManager;
let globalPostProcessUniforms;
let worldEnvUiRefs, worldEnvState;
let WORLD_ENV_DEFAULTS, WORLD_ENV_STORAGE_KEY, VEHICLE_CUSTOM_IMPORT_VALUE;
let sceneUiCount, sceneUiList;

// Late-init refs (getters)
let getAmbientLight, getHemiLight, getMainDirectionalLight;
let getDdgiVolume, getVolumetricFogController, getEnvironmentController;

// External functions
let switchEnvironment;
let getDDGIManager;
let actorInheritsCore, getActorCoreSource, getActorRenderObject;
let ensureActorScriptState;
let selectShowcaseActor, focusSceneActor;
let enterBlueprintEditor, openObjectScriptEditor;
let spawnImportedProp, spawnDrivableCar, spawnDynamicPrimitive, spawnDDGIVolumeActor;
let exportActorToFile;
let syncBlueprintPhysicsEditor, syncShowcaseAnglesFromTarget, applyShowcaseCameraRotation;
let refreshCollisionDebugOverlays;

export function installSceneUi(deps) {
    ({
        gameplay, blueprintState, objectScriptState, importedPropState,
        physics, collisionDebugState, mobileState,
        camera, renderer, scene, sceneSystem,
        transformControl,
        actorEditor, actorEditorSummary, actorEditorStatus,
        actorKindSelect, actorLabelInput, actorScaleInput,
        actorImportedTemplateSelect, actorVehicleBodyTemplateSelect, actorVehicleWheelTemplateSelect,
        actorComponentCollisionInput, actorComponentPhysicsInput, actorComponentScriptsInput,
        actorEditorState,
        setPendingVehicleTemplateImportSlot, vehicleTemplateImportInput,
        postProcessUiRefs, postProcessUiState, postProcessVolumeManager,
        globalPostProcessUniforms,
        worldEnvUiRefs, worldEnvState,
        WORLD_ENV_DEFAULTS, WORLD_ENV_STORAGE_KEY, VEHICLE_CUSTOM_IMPORT_VALUE,
        sceneUiCount, sceneUiList,
        getAmbientLight, getHemiLight, getMainDirectionalLight,
        getDdgiVolume, getVolumetricFogController, getEnvironmentController,
        switchEnvironment,
        getDDGIManager,
        actorInheritsCore, getActorCoreSource, getActorRenderObject,
        ensureActorScriptState,
        selectShowcaseActor, focusSceneActor,
        enterBlueprintEditor, openObjectScriptEditor,
        spawnImportedProp, spawnDrivableCar, spawnDynamicPrimitive, spawnDDGIVolumeActor,
        exportActorToFile,
        syncBlueprintPhysicsEditor, syncShowcaseAnglesFromTarget, applyShowcaseCameraRotation,
        refreshCollisionDebugOverlays,
    } = deps);
}

export function formatPostProcessValue(value, digits = 2) {
    return Number.isFinite(value) ? value.toFixed(digits) : '--';
}

export function clampPostProcessInput(value, fallback, min, max) {
    const numericValue = Number.isFinite(value) ? value : fallback;
    return THREE.MathUtils.clamp(numericValue, min, max);
}

export function readPostProcessInputValue(element, fallback, min, max) {
    const numericValue = Number.parseFloat(element?.value ?? '');
    return clampPostProcessInput(numericValue, fallback, min, max);
}

export function updatePostProcessSliderLabels() {
    const refs = postProcessUiRefs;
    if (!refs) return;

    if (refs.exposureValue) refs.exposureValue.textContent = formatPostProcessValue(Number.parseFloat(refs.exposureInput?.value ?? '1'), 2);
    if (refs.bloomStrengthValue) refs.bloomStrengthValue.textContent = formatPostProcessValue(Number.parseFloat(refs.bloomStrengthInput?.value ?? '1.25'), 2);
    if (refs.bloomRadiusValue) refs.bloomRadiusValue.textContent = formatPostProcessValue(Number.parseFloat(refs.bloomRadiusInput?.value ?? '0.95'), 2);
    if (refs.bloomThresholdValue) refs.bloomThresholdValue.textContent = formatPostProcessValue(Number.parseFloat(refs.bloomThresholdInput?.value ?? '0.48'), 2);
    if (refs.blendSpeedValue) refs.blendSpeedValue.textContent = formatPostProcessValue(Number.parseFloat(refs.blendSpeedInput?.value ?? '2.5'), 1);
}

export function updatePostProcessToggleUi() {
    const refs = postProcessUiRefs;
    if (!refs) return;

    const editingVolume = postProcessUiState.target === 'volume';
    refs.targetGlobalBtn?.classList.toggle('viewer-toggle-btn-active', !editingVolume);
    refs.targetVolumeBtn?.classList.toggle('viewer-toggle-btn-active', editingVolume);

    refs.priorityInput.disabled = !editingVolume;
    refs.sizeXInput.disabled = !editingVolume;
    refs.sizeYInput.disabled = !editingVolume;
    refs.sizeZInput.disabled = !editingVolume;
}

export function updatePostProcessStatusUi() {
    const refs = postProcessUiRefs;
    if (!refs?.status) return;

    const snapshot = postProcessVolumeManager?.getSnapshot?.();
    if (!snapshot) {
        refs.status.textContent = 'Post processing is not ready yet.';
        return;
    }

    const editorVolume = snapshot.editorVolume;
    const current = snapshot.currentSettings;
    const modeLabel = postProcessUiState.target === 'volume' ? 'Editing volume override.' : 'Editing global defaults.';

    if (!editorVolume) {
        refs.status.textContent = `${modeLabel} No box volume placed yet. Active exposure ${formatPostProcessValue(current.toneMappingExposure, 2)}, bloom ${formatPostProcessValue(current.bloomStrength, 2)} / ${formatPostProcessValue(current.bloomRadius, 2)} / ${formatPostProcessValue(current.bloomThreshold, 2)}.`;
        return;
    }

    const size = editorVolume.size;
    refs.status.textContent = `${modeLabel} 1 volume live. Size ${formatPostProcessValue(size.x, 1)} x ${formatPostProcessValue(size.y, 1)} x ${formatPostProcessValue(size.z, 1)}, priority ${editorVolume.priority}. Active exposure ${formatPostProcessValue(current.toneMappingExposure, 2)}, bloom ${formatPostProcessValue(current.bloomStrength, 2)} / ${formatPostProcessValue(current.bloomRadius, 2)} / ${formatPostProcessValue(current.bloomThreshold, 2)}.`;
}

export function loadPostProcessInputsFromState() {
    const refs = postProcessUiRefs;
    if (!refs) return;

    const snapshot = postProcessVolumeManager?.getSnapshot?.();
    const defaults = snapshot?.defaultSettings ?? {
        bloomStrength: globalPostProcessUniforms.bloomStrength.value,
        bloomRadius: globalPostProcessUniforms.bloomRadius.value,
        bloomThreshold: globalPostProcessUniforms.bloomThreshold.value,
        toneMappingExposure: renderer?.toneMappingExposure ?? 1.0,
        priority: 0,
    };
    const editorVolume = snapshot?.editorVolume;
    const volumeSettings = editorVolume?.settings ?? defaults;
    const selectedSettings = postProcessUiState.target === 'volume' ? volumeSettings : defaults;

    if (refs.exposureInput) refs.exposureInput.value = formatPostProcessValue(selectedSettings.toneMappingExposure, 2);
    if (refs.bloomStrengthInput) refs.bloomStrengthInput.value = formatPostProcessValue(selectedSettings.bloomStrength, 2);
    if (refs.bloomRadiusInput) refs.bloomRadiusInput.value = formatPostProcessValue(selectedSettings.bloomRadius, 2);
    if (refs.bloomThresholdInput) refs.bloomThresholdInput.value = formatPostProcessValue(selectedSettings.bloomThreshold, 2);
    if (refs.blendSpeedInput) refs.blendSpeedInput.value = formatPostProcessValue(snapshot?.transitionSpeed ?? 2.5, 1);
    if (refs.priorityInput) refs.priorityInput.value = String(Math.round(volumeSettings.priority ?? 0));
    if (refs.sizeXInput) refs.sizeXInput.value = formatPostProcessValue(editorVolume?.size.x ?? 12, 1);
    if (refs.sizeYInput) refs.sizeYInput.value = formatPostProcessValue(editorVolume?.size.y ?? 6, 1);
    if (refs.sizeZInput) refs.sizeZInput.value = formatPostProcessValue(editorVolume?.size.z ?? 12, 1);

    if (refs.placeVolumeBtn) refs.placeVolumeBtn.textContent = editorVolume ? 'Move To Camera' : 'Place At Camera';
    if (refs.removeVolumeBtn) refs.removeVolumeBtn.disabled = !editorVolume;
    if (refs.toggleBoundsBtn) {
        refs.toggleBoundsBtn.textContent = snapshot?.debugVisible ? 'Hide Bounds' : 'Show Bounds';
        refs.toggleBoundsBtn.classList.toggle('viewer-toggle-btn-active', !!snapshot?.debugVisible);
    }

    updatePostProcessSliderLabels();
}

export function syncPostProcessVolumeUi({ reloadInputs = true } = {}) {
    updatePostProcessToggleUi();
    if (reloadInputs) {
        loadPostProcessInputsFromState();
    } else {
        updatePostProcessSliderLabels();
    }
    updatePostProcessStatusUi();
}

export function applyPostProcessSettingsFromUi({ createVolumeIfNeeded = false, placeVolumeAtCamera = false, reloadInputs = false } = {}) {
    const refs = postProcessUiRefs;
    const manager = postProcessVolumeManager;
    if (!refs || !manager) return;

    const settings = {
        toneMappingExposure: readPostProcessInputValue(refs.exposureInput, 1.0, 0.1, 2.5),
        bloomStrength: readPostProcessInputValue(refs.bloomStrengthInput, 1.25, 0, 3),
        bloomRadius: readPostProcessInputValue(refs.bloomRadiusInput, 0.95, 0, 2),
        bloomThreshold: readPostProcessInputValue(refs.bloomThresholdInput, 0.48, 0, 2),
        priority: Math.round(readPostProcessInputValue(refs.priorityInput, 0, -100, 100)),
    };
    const transitionSpeed = readPostProcessInputValue(refs.blendSpeedInput, 2.5, 0.1, 10);
    manager.setTransitionSpeed?.(transitionSpeed);

    if (postProcessUiState.target === 'volume') {
        const snapshot = manager.getSnapshot?.();
        const existingVolume = snapshot?.editorVolume ?? null;
        const size = new THREE.Vector3(
            readPostProcessInputValue(refs.sizeXInput, 12, 0.5, 512),
            readPostProcessInputValue(refs.sizeYInput, 6, 0.5, 512),
            readPostProcessInputValue(refs.sizeZInput, 12, 0.5, 512)
        );

        if (existingVolume || createVolumeIfNeeded || placeVolumeAtCamera) {
            const position = placeVolumeAtCamera || !existingVolume
                ? (camera?.position?.clone?.() ?? new THREE.Vector3())
                : existingVolume.position;
            manager.ensureEditorVolume?.({ position, size, settings });
            if (placeVolumeAtCamera) {
                manager.setDebugVisible?.(true);
            }
        }
    } else {
        manager.setDefaultSettings?.(settings);
    }

    manager.update?.(1);
    syncPostProcessVolumeUi({ reloadInputs });
}

export function syncActorEditorTemplateOptions(selectedTemplateId = '', selectedVehicleBodyTemplateId = '', selectedVehicleWheelTemplateId = '') {
    if (actorImportedTemplateSelect) {
        actorImportedTemplateSelect.innerHTML = '';

        if (!importedPropState.templates.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No imported source available';
            actorImportedTemplateSelect.appendChild(option);
            actorImportedTemplateSelect.value = '';
        } else {
            importedPropState.templates.forEach((template) => {
                const option = document.createElement('option');
                option.value = template.id;
                option.textContent = `${template.displayName} (${template.collisionMode})`;
                actorImportedTemplateSelect.appendChild(option);
            });

            actorImportedTemplateSelect.value = selectedTemplateId && importedPropState.templates.some((template) => template.id === selectedTemplateId)
                ? selectedTemplateId
                : importedPropState.templates[0].id;
        }
    }

    const populateVehicleSelect = (select, selectedId, defaultLabel) => {
        if (!select) return;
        select.innerHTML = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = defaultLabel;
        select.appendChild(defaultOption);
        importedPropState.templates.forEach((template) => {
            const option = document.createElement('option');
            option.value = template.id;
            option.textContent = template.displayName;
            select.appendChild(option);
        });
        const customOption = document.createElement('option');
        customOption.value = VEHICLE_CUSTOM_IMPORT_VALUE;
        customOption.textContent = 'Custom… (import file)';
        select.appendChild(customOption);
        select.value = selectedId && importedPropState.templates.some((template) => template.id === selectedId)
            ? selectedId
            : '';
    };
    populateVehicleSelect(actorVehicleBodyTemplateSelect, selectedVehicleBodyTemplateId, 'Default Sedan');
    populateVehicleSelect(actorVehicleWheelTemplateSelect, selectedVehicleWheelTemplateId, 'Default Wheel');
}

export function handleVehicleTemplateSelectChange(slot) {
    const select = slot === 'body' ? actorVehicleBodyTemplateSelect : actorVehicleWheelTemplateSelect;
    if (!select) return;

    if (select.value === VEHICLE_CUSTOM_IMPORT_VALUE) {
        // Reset visible value back to default so the dropdown doesn't get
        // stuck on "Custom…" if the user cancels the file picker.
        select.value = '';
        if (!vehicleTemplateImportInput) return;
        setPendingVehicleTemplateImportSlot(slot);
        vehicleTemplateImportInput.value = '';
        vehicleTemplateImportInput.click();
        return;
    }

    syncActorEditorUi();
}

export function syncActorEditorUi() {
    if (!actorKindSelect || !actorEditorSummary || !actorEditorStatus || !actorImportedTemplateSelect || !actorComponentCollisionInput || !actorComponentPhysicsInput || !actorComponentScriptsInput) {
        return;
    }

    const kind = actorKindSelect.value || 'sphere';
    const isImported = kind === 'imported';
    const isVehicle = kind === 'vehicle';

    actorImportedTemplateSelect.disabled = !isImported;
    if (actorVehicleBodyTemplateSelect) {
        actorVehicleBodyTemplateSelect.disabled = !isVehicle;
    }
    if (actorVehicleWheelTemplateSelect) {
        actorVehicleWheelTemplateSelect.disabled = !isVehicle;
    }
    actorComponentCollisionInput.disabled = isVehicle;
    actorComponentPhysicsInput.disabled = isVehicle || !actorComponentCollisionInput.checked;
    if (isVehicle) {
        actorComponentCollisionInput.checked = true;
        actorComponentPhysicsInput.checked = true;
    } else if (!actorComponentCollisionInput.checked) {
        actorComponentPhysicsInput.checked = false;
    }

    const typeLabel = kind === 'vehicle'
        ? 'Vehicle Actor'
        : kind === 'imported'
            ? 'Imported Actor'
            : kind === 'sphere'
                ? 'Sphere Actor'
                : 'Cube Actor';

    actorEditorSummary.textContent = `Type: ${typeLabel}`;

    if (isImported && !importedPropState.templates.length) {
        actorEditorStatus.textContent = 'Import a prop source first, then create an imported actor instance from it.';
        return;
    }

    const bodyDescription = !actorComponentCollisionInput.checked
        ? ''
        : actorComponentPhysicsInput.checked
            ? ', simulated collision + physics'
            : ', static collision only';
    actorEditorStatus.textContent = `${typeLabel} will spawn with a render node${bodyDescription}${actorComponentScriptsInput.checked ? ', and a script host' : ''}.`;
}

export function closeActorEditor() {
    actorEditorState.open = false;
    if (actorEditor) {
        actorEditor.hidden = true;
    }
}

export function openActorEditor({ kind = 'cube', templateId = '', label = '', vehicleBodyTemplateId = '', vehicleWheelTemplateId = '' } = {}) {
    if (!actorEditor) return;

    actorEditorState.open = true;
    if (actorKindSelect) {
        actorKindSelect.value = kind;
    }
    if (actorLabelInput) {
        actorLabelInput.value = label;
    }
    if (actorScaleInput) {
        actorScaleInput.value = kind === 'cube' ? '2.0' : '0.5';
    }
    const actorColorEnabledReset = document.getElementById('actor-color-enabled');
    const actorColorInputReset = document.getElementById('actor-color-input');
    if (actorColorEnabledReset) actorColorEnabledReset.checked = false;
    if (actorColorInputReset) actorColorInputReset.disabled = true;
    if (actorComponentCollisionInput) {
        actorComponentCollisionInput.checked = true;
    }
    if (actorComponentPhysicsInput) {
        actorComponentPhysicsInput.checked = true;
    }
    if (actorComponentScriptsInput) {
        actorComponentScriptsInput.checked = true;
    }

    syncActorEditorTemplateOptions(templateId, vehicleBodyTemplateId, vehicleWheelTemplateId);
    syncActorEditorUi();
    actorEditor.hidden = false;
}

export function spawnActorFromEditor({ openScriptEditor = false } = {}) {
    const kind = actorKindSelect?.value || 'sphere';
    const includeCollisionBody = kind === 'vehicle' ? true : !!actorComponentCollisionInput?.checked;
    const simulatePhysics = kind === 'vehicle' ? true : !!actorComponentPhysicsInput?.checked;
    const includeScripts = !!actorComponentScriptsInput?.checked;
    const parsedScale = Number.parseFloat(actorScaleInput?.value ?? '0.5');
    const scale = Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : (kind === 'cube' ? 0.3 : 0.5);
    const displayName = actorLabelInput?.value?.trim() || '';
    const userData = displayName ? { label: displayName } : undefined;
    let actor = null;

    if (kind === 'vehicle') {
        const bodyTemplateId = actorVehicleBodyTemplateSelect?.value || '';
        const wheelTemplateId = actorVehicleWheelTemplateSelect?.value || '';
        actor = spawnDrivableCar({ includeScripts, userData, bodyTemplateId, wheelTemplateId });
    } else if (kind === 'ddgiVolume') {
        actor = spawnDDGIVolumeActor({ userData });
    } else if (kind === 'imported') {
        const templateId = actorImportedTemplateSelect?.value || '';
        if (!templateId) {
            syncActorEditorUi();
            return null;
        }

        actor = spawnImportedProp(templateId, {
            includeCollisionBody,
            simulatePhysics,
            includeScripts,
            userData,
        });
    } else {
        actor = spawnDynamicPrimitive(kind, undefined, scale, {
            includeCollisionBody,
            simulatePhysics,
            includeScripts,
            userData,
            returnActor: true,
        });
    }

    if (!actor) {
        if (actorEditorStatus) {
            actorEditorStatus.textContent = 'Actor creation failed.';
        }
        return null;
    }

    const actorColorInput = document.getElementById('actor-color-input');
    const actorColorEnabled = document.getElementById('actor-color-enabled');
    if (actorColorInput && actorColorEnabled?.checked) {
        setActorColor(actor, actorColorInput.value);
    }

    closeActorEditor();

    if (openScriptEditor) {
        ensureActorScriptState(actor);
        selectShowcaseActor(actor.id);
        openObjectScriptEditor('tick');
    }

    return actor;
}

export function loadWorldEnvFromStorage() {
    try {
        const raw = localStorage.getItem(WORLD_ENV_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        // Shallow-merge each section so we don't lose newly-added defaults
        // when an older saved blob is read.
        for (const key of Object.keys(WORLD_ENV_DEFAULTS)) {
            if (parsed[key] && typeof parsed[key] === 'object') {
                worldEnvState[key] = { ...WORLD_ENV_DEFAULTS[key], ...parsed[key] };
            }
        }
    } catch (e) {
        // Corrupt storage — fall back to defaults silently.
    }
}

export function saveWorldEnvToStorage() {
    try {
        localStorage.setItem(WORLD_ENV_STORAGE_KEY, JSON.stringify(worldEnvState));
    } catch (e) { /* private mode / quota — ignore */ }
}

export function applyWorldEnvState({ persist = true, switchSky = true } = {}) {
    const s = worldEnvState;

    // Sky / Background
    if (getEnvironmentController()) {
        getEnvironmentController().setEnabled?.(s.sky.enabled);
        getEnvironmentController().setBackgroundBlurriness?.(s.sky.blurriness);
        if (switchSky && getEnvironmentController().getCurrentEnvironment?.() !== s.sky.preset) {
            getEnvironmentController().switchEnvironment?.(s.sky.preset);
        }
    }

    // Ambient + Hemi + Sun — direct property writes since they're THREE lights.
    if (getAmbientLight()) {
        getAmbientLight().visible = s.ambient.enabled;
        getAmbientLight().intensity = s.ambient.intensity;
    }
    if (getHemiLight()) {
        getHemiLight().visible = s.hemi.enabled;
        getHemiLight().intensity = s.hemi.intensity;
    }
    if (getMainDirectionalLight()) {
        getMainDirectionalLight().visible = s.sun.enabled;
        getMainDirectionalLight().castShadow = s.sun.enabled && s.sun.castShadow;
        getMainDirectionalLight().intensity = s.sun.intensity;
    }

    // Tonemap exposure — write to renderer immediately AND record as the
    // post-process volume default so the lerp doesn't drag it back.
    if (renderer) {
        renderer.toneMappingExposure = s.tonemap.exposure;
    }
    postProcessVolumeManager?.setDefaultSettings?.({ toneMappingExposure: s.tonemap.exposure });

    // Bloom — when off, postProcessVolumeManager.setEnabled clamps uniforms
    // to neutral. When on, push the user's slider values through both the
    // shader uniforms AND the volume defaults so volume-based grading still works.
    if (s.bloom.enabled) {
        postProcessVolumeManager?.setEnabled?.(true);
        if (globalPostProcessUniforms.bloomStrength) globalPostProcessUniforms.bloomStrength.value = s.bloom.strength;
        if (globalPostProcessUniforms.bloomRadius) globalPostProcessUniforms.bloomRadius.value = s.bloom.radius;
        if (globalPostProcessUniforms.bloomThreshold) globalPostProcessUniforms.bloomThreshold.value = s.bloom.threshold;
        postProcessVolumeManager?.setDefaultSettings?.({
            bloomStrength: s.bloom.strength,
            bloomRadius: s.bloom.radius,
            bloomThreshold: s.bloom.threshold,
        });
    } else {
        postProcessVolumeManager?.setEnabled?.(false);
    }

    // Fog
    if (getVolumetricFogController()) {
        getVolumetricFogController().setEnabled?.(s.fog.enabled);
        getVolumetricFogController().setDensity?.(s.fog.density);
        getVolumetricFogController().setOpacity?.(s.fog.opacity);
    }

    // DDGI
    const ddgi = getDDGIManager();
    ddgi?.setEnabled?.(s.ddgi.enabled);
    ddgi?.setInjectionEnabled?.(s.ddgi.enabled);
    ddgi?.setProbesPerFrame?.(s.ddgi.probesPerFrame);
    ddgi?.setIntensity?.(s.ddgi.intensity);

    // Shadows
    if (renderer?.shadowMap) {
        renderer.shadowMap.enabled = s.shadows.enabled;
    }

    if (persist) saveWorldEnvToStorage();
    updateWorldEnvUi();
}

export function updateWorldEnvUi() {
    if (!worldEnvUiRefs) return;
    const s = worldEnvState;
    const setToggle = (offBtn, onBtn, on) => {
        offBtn?.classList.toggle('viewer-toggle-btn-active', !on);
        onBtn?.classList.toggle('viewer-toggle-btn-active', on);
    };
    const setSlider = (input, valueEl, value, decimals) => {
        if (input) input.value = value;
        if (valueEl) valueEl.textContent = Number(value).toFixed(decimals);
    };

    setToggle(worldEnvUiRefs.skyOff, worldEnvUiRefs.skyOn, s.sky.enabled);
    if (worldEnvUiRefs.skyPreset) worldEnvUiRefs.skyPreset.value = s.sky.preset;
    setSlider(worldEnvUiRefs.skyBlurriness, worldEnvUiRefs.skyBlurrinessValue, s.sky.blurriness, 2);

    setToggle(worldEnvUiRefs.ambientOff, worldEnvUiRefs.ambientOn, s.ambient.enabled);
    setSlider(worldEnvUiRefs.ambientIntensity, worldEnvUiRefs.ambientIntensityValue, s.ambient.intensity, 2);

    setToggle(worldEnvUiRefs.hemiOff, worldEnvUiRefs.hemiOn, s.hemi.enabled);
    setSlider(worldEnvUiRefs.hemiIntensity, worldEnvUiRefs.hemiIntensityValue, s.hemi.intensity, 2);

    setToggle(worldEnvUiRefs.sunOff, worldEnvUiRefs.sunOn, s.sun.enabled);
    if (worldEnvUiRefs.sunShadow) worldEnvUiRefs.sunShadow.checked = s.sun.castShadow;
    setSlider(worldEnvUiRefs.sunIntensity, worldEnvUiRefs.sunIntensityValue, s.sun.intensity, 2);

    setSlider(worldEnvUiRefs.exposure, worldEnvUiRefs.exposureValue, s.tonemap.exposure, 2);

    setToggle(worldEnvUiRefs.bloomOff, worldEnvUiRefs.bloomOn, s.bloom.enabled);
    setSlider(worldEnvUiRefs.bloomStrength, worldEnvUiRefs.bloomStrengthValue, s.bloom.strength, 2);
    setSlider(worldEnvUiRefs.bloomRadius, worldEnvUiRefs.bloomRadiusValue, s.bloom.radius, 2);
    setSlider(worldEnvUiRefs.bloomThreshold, worldEnvUiRefs.bloomThresholdValue, s.bloom.threshold, 2);

    setToggle(worldEnvUiRefs.fogOff, worldEnvUiRefs.fogOn, s.fog.enabled);
    setSlider(worldEnvUiRefs.fogDensity, worldEnvUiRefs.fogDensityValue, s.fog.density, 3);
    setSlider(worldEnvUiRefs.fogOpacity, worldEnvUiRefs.fogOpacityValue, s.fog.opacity, 3);

    setToggle(worldEnvUiRefs.ddgiOff, worldEnvUiRefs.ddgiOn, s.ddgi.enabled);
    if (worldEnvUiRefs.ddgiProbes) worldEnvUiRefs.ddgiProbes.value = s.ddgi.probesPerFrame;
    if (worldEnvUiRefs.ddgiProbesValue) worldEnvUiRefs.ddgiProbesValue.textContent = String(s.ddgi.probesPerFrame);
    setSlider(worldEnvUiRefs.ddgiIntensity, worldEnvUiRefs.ddgiIntensityValue, s.ddgi.intensity, 2);

    setToggle(worldEnvUiRefs.shadowsOff, worldEnvUiRefs.shadowsOn, s.shadows.enabled);

    // Summary chip + status text
    if (worldEnvUiRefs.summaryValue) {
        const off = [];
        if (!s.sky.enabled) off.push('Sky');
        if (!s.bloom.enabled) off.push('Bloom');
        if (!s.fog.enabled) off.push('Fog');
        if (!s.ddgi.enabled) off.push('DDGI');
        if (!s.shadows.enabled) off.push('Shadows');
        worldEnvUiRefs.summaryValue.textContent = off.length ? `Off: ${off.join(' · ')}` : 'All effects active';
    }
    if (worldEnvUiRefs.masterStatus) {
        const allCoreOn = s.sky.enabled && s.ambient.enabled && s.hemi.enabled && s.sun.enabled && s.bloom.enabled && s.fog.enabled && s.shadows.enabled;
        const perfPreset = !s.bloom.enabled && !s.fog.enabled && !s.ddgi.enabled && s.sky.enabled && s.sun.enabled;
        if (allCoreOn && !s.ddgi.enabled) {
            worldEnvUiRefs.masterStatus.textContent = 'Everything on (DDGI off — opt in for prettier indirect lighting).';
        } else if (allCoreOn && s.ddgi.enabled) {
            worldEnvUiRefs.masterStatus.textContent = 'Everything on, including DDGI.';
        } else if (perfPreset) {
            worldEnvUiRefs.masterStatus.textContent = 'Performance preset active. Bloom + Fog + DDGI paused.';
        } else {
            worldEnvUiRefs.masterStatus.textContent = 'Custom configuration.';
        }
    }
}

export function setWorldEnvMaster(mode) {
    const s = worldEnvState;
    if (mode === 'on') {
        s.sky.enabled = true;
        s.ambient.enabled = true;
        s.hemi.enabled = true;
        s.sun.enabled = true;
        s.bloom.enabled = true;
        s.fog.enabled = true;
        s.shadows.enabled = true;
        // DDGI is opt-in even with All On — too expensive for a default.
    } else if (mode === 'off') {
        s.sky.enabled = false;
        s.ambient.enabled = false;
        s.hemi.enabled = false;
        s.sun.enabled = false;
        s.bloom.enabled = false;
        s.fog.enabled = false;
        s.ddgi.enabled = false;
        s.shadows.enabled = false;
    } else if (mode === 'perf') {
        // Performance preset: only the heavy effects go off.
        s.bloom.enabled = false;
        s.fog.enabled = false;
        s.ddgi.enabled = false;
    }
    applyWorldEnvState();
}

export function resetWorldEnvDefaults() {
    worldEnvState = JSON.parse(JSON.stringify(WORLD_ENV_DEFAULTS));
    applyWorldEnvState();
}

export function createSceneActorItem(actor, { isChild = false } = {}) {
    const item = document.createElement('div');
    item.className = isChild ? 'scene-ui-item scene-ui-child-item' : 'scene-ui-item';
    item.dataset.id = actor.id;

    if (objectScriptState.targetPropId === actor.id) {
        item.style.background = 'rgba(255, 255, 255, 0.12)';
        item.style.borderColor = 'rgba(112, 0, 255, 0.45)';
        if (!blueprintState.active) {
            const actorBtnRow = document.createElement('div');
            actorBtnRow.className = 'scene-ui-item-actions';

            const blueprintBtn = document.createElement('button');
            blueprintBtn.className = 'btn btn-primary scene-ui-action-btn';
            blueprintBtn.textContent = 'Edit Blueprint';
            blueprintBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                enterBlueprintEditor();
                syncBlueprintPhysicsEditor(actor);
            });
            actorBtnRow.appendChild(blueprintBtn);

            const saveActorBtn = document.createElement('button');
            saveActorBtn.className = 'btn scene-ui-action-btn scene-ui-save-btn';
            saveActorBtn.textContent = 'Save';
            saveActorBtn.title = 'Download this actor as a .actor file';
            saveActorBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                exportActorToFile(actor);
            });
            actorBtnRow.appendChild(saveActorBtn);
            item.appendChild(actorBtnRow);
        }
    }

    const nameEl = document.createElement('div');
    nameEl.className = 'scene-ui-item-name';
    nameEl.textContent = actor.rootNode.name || actor.id || 'Actor';

    const typeEl = document.createElement('div');
    typeEl.className = 'scene-ui-item-type';
    typeEl.textContent = actorInheritsCore(actor) ? 'instance' : (actor.kind || 'Actor');

    item.appendChild(nameEl);
    item.appendChild(typeEl);
    item.addEventListener('click', () => selectShowcaseActor(actor.id));
    item.addEventListener('dblclick', () => focusSceneActor(actor));
    return item;
}

export function refreshSceneUI() {
    if (collisionDebugState.enabled) {
        refreshCollisionDebugOverlays();
    }

    if (!sceneUiList || !sceneUiCount) return;

    sceneUiList.innerHTML = '';

    if (!sceneSystem || sceneSystem.actors.size === 0) {
        sceneUiCount.textContent = '0 Actors';
        return;
    }

    const actors = Array.from(sceneSystem.actors);
    sceneUiCount.textContent = `${actors.length} Actor${actors.length !== 1 ? 's' : ''}`;

    actors.forEach((actor) => sceneUiList.appendChild(createSceneActorItem(actor)));

    const cores = actors.filter((actor) => !actorInheritsCore(actor)
        && actors.some((entry) => actorInheritsCore(entry) && getActorCoreSource(entry)?.id === actor.id));
    if (cores.length) {
        const folder = document.createElement('div');
        folder.className = 'scene-ui-folder scene-ui-core-bin';
        if (refreshSceneUI.coreBinCollapsed) {
            folder.classList.add('scene-ui-folder-collapsed');
        }

        const header = document.createElement('button');
        header.className = 'scene-ui-folder-header';
        header.type = 'button';
        header.textContent = 'Core Actors';

        const count = document.createElement('span');
        count.textContent = `${cores.length} parent${cores.length !== 1 ? 's' : ''}`;
        header.appendChild(count);
        header.addEventListener('click', () => {
            refreshSceneUI.coreBinCollapsed = !refreshSceneUI.coreBinCollapsed;
            refreshSceneUI();
        });
        folder.appendChild(header);

        if (!refreshSceneUI.coreBinCollapsed) {
            cores.forEach((actor) => {
                const linked = actors.filter((entry) => actorInheritsCore(entry) && getActorCoreSource(entry)?.id === actor.id);
                const row = createSceneActorItem(actor);
                const type = row.querySelector('.scene-ui-item-type');
                if (type) type.textContent = `parent core · ${linked.length} linked`;
                folder.appendChild(row);
            });
        }

        sceneUiList.appendChild(folder);
    }
    return;

    actors.forEach(actor => {
        const item = document.createElement('div');
        item.className = 'scene-ui-item';
        item.dataset.id = actor.id;

        if (objectScriptState.targetPropId === actor.id) {
            item.style.background = 'rgba(255, 255, 255, 0.12)';
            item.style.borderColor = 'rgba(112, 0, 255, 0.45)';
            
            if (!blueprintState.active) {
                const actorBtnRow = document.createElement('div');
                actorBtnRow.className = 'scene-ui-item-actions';

                const blueprintBtn = document.createElement('button');
                blueprintBtn.className = 'btn btn-primary scene-ui-action-btn';
                blueprintBtn.textContent = 'Edit Blueprint';
                blueprintBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    enterBlueprintEditor();
                    syncBlueprintPhysicsEditor(actor);
                });
                actorBtnRow.appendChild(blueprintBtn);

                const saveActorBtn = document.createElement('button');
                saveActorBtn.className = 'btn scene-ui-action-btn scene-ui-save-btn';
                saveActorBtn.textContent = '⬇ Save';
                saveActorBtn.title = 'Download this actor as a .actor file';
                saveActorBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    exportActorToFile(actor);
                });
                actorBtnRow.appendChild(saveActorBtn);

                item.appendChild(actorBtnRow);
            }
        }

        const nameEl = document.createElement('div');
        nameEl.className = 'scene-ui-item-name';
        nameEl.textContent = actor.rootNode.name || actor.id || 'Actor';

        const typeEl = document.createElement('div');
        typeEl.className = 'scene-ui-item-type';
        typeEl.textContent = actor.kind || 'Actor';

        item.appendChild(nameEl);
        item.appendChild(typeEl);

        item.addEventListener('click', () => {
            selectShowcaseActor(actor.id);
        });

        item.addEventListener('dblclick', () => {
            const actorMesh = getActorRenderObject(actor);
            if (!gameplay.active && actorMesh) {
                const targetPos = new THREE.Vector3();
                actorMesh.getWorldPosition(targetPos);
                
                if (gsap) {
                    gsap.to(camera.position, {
                        x: targetPos.x + 2.5,
                        y: targetPos.y + 2.5,
                        z: targetPos.z + 2.5,
                        duration: 0.6,
                        ease: 'power2.out',
                        onUpdate: () => {
                            syncShowcaseAnglesFromTarget(targetPos);
                            applyShowcaseCameraRotation();
                        }
                    });
                } else {
                    camera.position.set(targetPos.x + 2.5, targetPos.y + 2.5, targetPos.z + 2.5);
                    syncShowcaseAnglesFromTarget(targetPos);
                    applyShowcaseCameraRotation();
                }
            }
        });

        sceneUiList.appendChild(item);
    });
}
