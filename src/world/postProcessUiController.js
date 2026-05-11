import * as THREE from 'three';

function formatValue(value, digits = 2) {
    return Number.isFinite(value) ? value.toFixed(digits) : '--';
}

function clampInput(value, fallback, min, max) {
    const numericValue = Number.isFinite(value) ? value : fallback;
    return THREE.MathUtils.clamp(numericValue, min, max);
}

function readInputValue(element, fallback, min, max) {
    const numericValue = Number.parseFloat(element?.value ?? '');
    return clampInput(numericValue, fallback, min, max);
}

export function createPostProcessUiController({
    state,
    uniforms,
    getRefs,
    getManager,
    getRenderer,
    getCamera,
}) {
    function updateSliderLabels() {
        const refs = getRefs();
        if (!refs) return;

        if (refs.exposureValue) refs.exposureValue.textContent = formatValue(Number.parseFloat(refs.exposureInput?.value ?? '1'), 2);
        if (refs.bloomStrengthValue) refs.bloomStrengthValue.textContent = formatValue(Number.parseFloat(refs.bloomStrengthInput?.value ?? '1.25'), 2);
        if (refs.bloomRadiusValue) refs.bloomRadiusValue.textContent = formatValue(Number.parseFloat(refs.bloomRadiusInput?.value ?? '0.95'), 2);
        if (refs.bloomThresholdValue) refs.bloomThresholdValue.textContent = formatValue(Number.parseFloat(refs.bloomThresholdInput?.value ?? '0.48'), 2);
        if (refs.blendSpeedValue) refs.blendSpeedValue.textContent = formatValue(Number.parseFloat(refs.blendSpeedInput?.value ?? '2.5'), 1);
    }

    function updateToggleUi() {
        const refs = getRefs();
        if (!refs) return;

        const editingVolume = state.target === 'volume';
        refs.targetGlobalBtn?.classList.toggle('viewer-toggle-btn-active', !editingVolume);
        refs.targetVolumeBtn?.classList.toggle('viewer-toggle-btn-active', editingVolume);

        refs.priorityInput.disabled = !editingVolume;
        refs.sizeXInput.disabled = !editingVolume;
        refs.sizeYInput.disabled = !editingVolume;
        refs.sizeZInput.disabled = !editingVolume;
    }

    function updateStatusUi() {
        const refs = getRefs();
        if (!refs?.status) return;

        const snapshot = getManager()?.getSnapshot?.();
        if (!snapshot) {
            refs.status.textContent = 'Post processing is not ready yet.';
            return;
        }

        const editorVolume = snapshot.editorVolume;
        const current = snapshot.currentSettings;
        const modeLabel = state.target === 'volume' ? 'Editing volume override.' : 'Editing global defaults.';

        if (!editorVolume) {
            refs.status.textContent = `${modeLabel} No box volume placed yet. Active exposure ${formatValue(current.toneMappingExposure, 2)}, bloom ${formatValue(current.bloomStrength, 2)} / ${formatValue(current.bloomRadius, 2)} / ${formatValue(current.bloomThreshold, 2)}.`;
            return;
        }

        const size = editorVolume.size;
        refs.status.textContent = `${modeLabel} 1 volume live. Size ${formatValue(size.x, 1)} x ${formatValue(size.y, 1)} x ${formatValue(size.z, 1)}, priority ${editorVolume.priority}. Active exposure ${formatValue(current.toneMappingExposure, 2)}, bloom ${formatValue(current.bloomStrength, 2)} / ${formatValue(current.bloomRadius, 2)} / ${formatValue(current.bloomThreshold, 2)}.`;
    }

    function loadInputsFromState() {
        const refs = getRefs();
        if (!refs) return;

        const snapshot = getManager()?.getSnapshot?.();
        const defaults = snapshot?.defaultSettings ?? {
            bloomStrength: uniforms.bloomStrength.value,
            bloomRadius: uniforms.bloomRadius.value,
            bloomThreshold: uniforms.bloomThreshold.value,
            toneMappingExposure: getRenderer()?.toneMappingExposure ?? 1.0,
            priority: 0,
        };
        const editorVolume = snapshot?.editorVolume;
        const volumeSettings = editorVolume?.settings ?? defaults;
        const selectedSettings = state.target === 'volume' ? volumeSettings : defaults;

        if (refs.exposureInput) refs.exposureInput.value = formatValue(selectedSettings.toneMappingExposure, 2);
        if (refs.bloomStrengthInput) refs.bloomStrengthInput.value = formatValue(selectedSettings.bloomStrength, 2);
        if (refs.bloomRadiusInput) refs.bloomRadiusInput.value = formatValue(selectedSettings.bloomRadius, 2);
        if (refs.bloomThresholdInput) refs.bloomThresholdInput.value = formatValue(selectedSettings.bloomThreshold, 2);
        if (refs.blendSpeedInput) refs.blendSpeedInput.value = formatValue(snapshot?.transitionSpeed ?? 2.5, 1);
        if (refs.priorityInput) refs.priorityInput.value = String(Math.round(volumeSettings.priority ?? 0));
        if (refs.sizeXInput) refs.sizeXInput.value = formatValue(editorVolume?.size.x ?? 12, 1);
        if (refs.sizeYInput) refs.sizeYInput.value = formatValue(editorVolume?.size.y ?? 6, 1);
        if (refs.sizeZInput) refs.sizeZInput.value = formatValue(editorVolume?.size.z ?? 12, 1);

        if (refs.placeVolumeBtn) refs.placeVolumeBtn.textContent = editorVolume ? 'Move To Camera' : 'Place At Camera';
        if (refs.removeVolumeBtn) refs.removeVolumeBtn.disabled = !editorVolume;
        if (refs.toggleBoundsBtn) {
            refs.toggleBoundsBtn.textContent = snapshot?.debugVisible ? 'Hide Bounds' : 'Show Bounds';
            refs.toggleBoundsBtn.classList.toggle('viewer-toggle-btn-active', !!snapshot?.debugVisible);
        }

        updateSliderLabels();
    }

    function sync({ reloadInputs = true } = {}) {
        updateToggleUi();
        if (reloadInputs) {
            loadInputsFromState();
        } else {
            updateSliderLabels();
        }
        updateStatusUi();
    }

    function apply({ createVolumeIfNeeded = false, placeVolumeAtCamera = false, reloadInputs = false } = {}) {
        const refs = getRefs();
        const manager = getManager();
        if (!refs || !manager) return;

        const settings = {
            toneMappingExposure: readInputValue(refs.exposureInput, 1.0, 0.1, 2.5),
            bloomStrength: readInputValue(refs.bloomStrengthInput, 1.25, 0, 3),
            bloomRadius: readInputValue(refs.bloomRadiusInput, 0.95, 0, 2),
            bloomThreshold: readInputValue(refs.bloomThresholdInput, 0.48, 0, 2),
            priority: Math.round(readInputValue(refs.priorityInput, 0, -100, 100)),
        };
        const transitionSpeed = readInputValue(refs.blendSpeedInput, 2.5, 0.1, 10);
        manager.setTransitionSpeed?.(transitionSpeed);

        if (state.target === 'volume') {
            const snapshot = manager.getSnapshot?.();
            const existingVolume = snapshot?.editorVolume ?? null;
            const size = new THREE.Vector3(
                readInputValue(refs.sizeXInput, 12, 0.5, 512),
                readInputValue(refs.sizeYInput, 6, 0.5, 512),
                readInputValue(refs.sizeZInput, 12, 0.5, 512)
            );

            if (existingVolume || createVolumeIfNeeded || placeVolumeAtCamera) {
                const position = placeVolumeAtCamera || !existingVolume
                    ? (getCamera()?.position?.clone?.() ?? new THREE.Vector3())
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
        sync({ reloadInputs });
    }

    return {
        apply,
        loadInputsFromState,
        sync,
        updateSliderLabels,
        updateStatusUi,
        updateToggleUi,
    };
}
