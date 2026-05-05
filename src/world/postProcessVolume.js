import * as THREE from 'three';

const DEFAULT_POST_PROCESS_SETTINGS = {
    bloomStrength: 1.25,
    bloomRadius: 0.95,
    bloomThreshold: 0.48,
    toneMappingExposure: 1.0,
    priority: 0,
};

// Settings used when the manager is force-disabled (Performance toggle).
// Bloom strength of 0 effectively bypasses the bloom MRT pass; tone mapping
// exposure stays neutral so the scene doesn't crush to black.
const DISABLED_POST_PROCESS_SETTINGS = {
    bloomStrength: 0.0,
    bloomRadius: 0.0,
    bloomThreshold: 1.0,
    toneMappingExposure: 1.0,
    priority: 0,
};

function clonePostProcessSettings(settings = {}) {
    return {
        bloomStrength: settings.bloomStrength ?? DEFAULT_POST_PROCESS_SETTINGS.bloomStrength,
        bloomRadius: settings.bloomRadius ?? DEFAULT_POST_PROCESS_SETTINGS.bloomRadius,
        bloomThreshold: settings.bloomThreshold ?? DEFAULT_POST_PROCESS_SETTINGS.bloomThreshold,
        toneMappingExposure: settings.toneMappingExposure ?? DEFAULT_POST_PROCESS_SETTINGS.toneMappingExposure,
        priority: settings.priority ?? DEFAULT_POST_PROCESS_SETTINGS.priority,
    };
}

function createVolumeMesh(size, visible = false) {
    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const material = new THREE.MeshBasicMaterial({
        color: 0xff4df3,
        wireframe: true,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        toneMapped: false,
        fog: false,
        visible,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 1000;
    return mesh;
}

export function createPostProcessVolumeManager({ scene, camera, renderer, globalUniforms }) {
    const state = {
        group: new THREE.Group(),
        volumes: [], // { box, settings, priority }
        currentSettings: clonePostProcessSettings(DEFAULT_POST_PROCESS_SETTINGS),
        targetSettings: clonePostProcessSettings(DEFAULT_POST_PROCESS_SETTINGS),
        transitionSpeed: 2.5,
        defaultSettings: clonePostProcessSettings(DEFAULT_POST_PROCESS_SETTINGS),
        debugVisible: false,
        editorVolume: null,
        enabled: true,
    };

    state.group.name = 'post-process-volumes';
    state.group.userData.ignoreForcedSceneShadows = true;
    scene.add(state.group);

    // Temp box for intersection
    const tempBox = new THREE.Box3();

    function applyResolvedSettings(settings) {
        if (globalUniforms) {
            if (globalUniforms.bloomStrength) globalUniforms.bloomStrength.value = settings.bloomStrength;
            if (globalUniforms.bloomRadius) globalUniforms.bloomRadius.value = settings.bloomRadius;
            if (globalUniforms.bloomThreshold) globalUniforms.bloomThreshold.value = settings.bloomThreshold;
        }
        if (renderer) {
            renderer.toneMappingExposure = settings.toneMappingExposure;
        }
    }

    function syncDebugVisibility() {
        for (const vol of state.volumes) {
            if (vol.mesh?.material) {
                vol.mesh.material.visible = state.debugVisible;
            }
        }
    }

    function resolveTargetSettings() {
        let highestPriority = -Infinity;
        let activeVolumeSettings = null;

        for (const vol of state.volumes) {
            tempBox.setFromObject(vol.mesh);
            if (tempBox.containsPoint(camera.position)) {
                if (vol.priority > highestPriority) {
                    highestPriority = vol.priority;
                    activeVolumeSettings = vol.settings;
                }
            }
        }

        return activeVolumeSettings || state.defaultSettings;
    }

    function addVolume(position, size, settings = {}) {
        const mesh = createVolumeMesh(size, state.debugVisible);
        mesh.position.copy(position);
        state.group.add(mesh);

        const volumeData = {
            mesh,
            size: size.clone(),
            settings: clonePostProcessSettings(settings),
            priority: settings.priority || 0,
        };
        state.volumes.push(volumeData);
        return volumeData;
    }

    function updateVolume(volumeData, { position = null, size = null, settings = null } = {}) {
        if (!volumeData) return null;

        if (position) {
            volumeData.mesh.position.copy(position);
        }
        if (size) {
            volumeData.size.copy(size);
            volumeData.mesh.geometry.dispose();
            volumeData.mesh.geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
        }
        if (settings) {
            volumeData.settings = clonePostProcessSettings({ ...volumeData.settings, ...settings });
            volumeData.priority = volumeData.settings.priority || 0;
        }

        return volumeData;
    }

    function removeVolume(volumeData) {
        const index = state.volumes.indexOf(volumeData);
        if (index !== -1) {
            volumeData.mesh.geometry?.dispose?.();
            volumeData.mesh.material?.dispose?.();
            state.group.remove(volumeData.mesh);
            state.volumes.splice(index, 1);
        }
        if (state.editorVolume === volumeData) {
            state.editorVolume = null;
        }
    }

    function ensureEditorVolume({ position = new THREE.Vector3(), size = new THREE.Vector3(12, 6, 12), settings = {} } = {}) {
        if (!state.editorVolume) {
            state.editorVolume = addVolume(position, size, settings);
        } else {
            updateVolume(state.editorVolume, { position, size, settings });
        }
        return state.editorVolume;
    }

    function removeEditorVolume() {
        if (state.editorVolume) {
            removeVolume(state.editorVolume);
        }
    }

    function setTransitionSpeed(value) {
        const numericValue = Number.isFinite(value) ? value : state.transitionSpeed;
        state.transitionSpeed = THREE.MathUtils.clamp(numericValue, 0.1, 12);
    }

    function setDebugVisible(visible) {
        state.debugVisible = !!visible;
        syncDebugVisibility();
    }

    function getSnapshot() {
        return {
            currentSettings: clonePostProcessSettings(state.currentSettings),
            targetSettings: clonePostProcessSettings(state.targetSettings),
            defaultSettings: clonePostProcessSettings(state.defaultSettings),
            transitionSpeed: state.transitionSpeed,
            volumeCount: state.volumes.length,
            debugVisible: state.debugVisible,
            editorVolume: state.editorVolume
                ? {
                    position: state.editorVolume.mesh.position.clone(),
                    size: state.editorVolume.size.clone(),
                    settings: clonePostProcessSettings(state.editorVolume.settings),
                    priority: state.editorVolume.priority,
                }
                : null,
        };
    }

    function update(delta) {
        if (!camera) return;

        // Performance toggle short-circuit: skip volume intersection + lerp work
        // and clamp bloom uniforms to neutral so the post-process pass does no work.
        if (!state.enabled) {
            applyResolvedSettings(DISABLED_POST_PROCESS_SETTINGS);
            return;
        }

        const target = resolveTargetSettings();
        state.targetSettings = clonePostProcessSettings(target);

        // Interpolate
        const t = Math.min(1.0, delta * state.transitionSpeed);
        state.currentSettings.bloomStrength = THREE.MathUtils.lerp(state.currentSettings.bloomStrength, target.bloomStrength, t);
        state.currentSettings.bloomRadius = THREE.MathUtils.lerp(state.currentSettings.bloomRadius, target.bloomRadius, t);
        state.currentSettings.bloomThreshold = THREE.MathUtils.lerp(state.currentSettings.bloomThreshold, target.bloomThreshold, t);
        state.currentSettings.toneMappingExposure = THREE.MathUtils.lerp(state.currentSettings.toneMappingExposure, target.toneMappingExposure, t);

        applyResolvedSettings(state.currentSettings);
    }

    function setEnabled(enabled) {
        const next = !!enabled;
        if (state.enabled === next) {
            if (!next) applyResolvedSettings(DISABLED_POST_PROCESS_SETTINGS);
            return;
        }
        state.enabled = next;
        if (!next) {
            // Apply neutral settings immediately so the disable is visible this frame
            // without waiting for the lerp.
            applyResolvedSettings(DISABLED_POST_PROCESS_SETTINGS);
        }
    }

    return {
        state,
        addVolume,
        updateVolume,
        removeVolume,
        ensureEditorVolume,
        removeEditorVolume,
        update,
        setDefaultSettings: (settings) => {
            state.defaultSettings = clonePostProcessSettings({ ...state.defaultSettings, ...settings });
        },
        setTransitionSpeed,
        setDebugVisible,
        setEnabled,
        isEnabled: () => state.enabled,
        getSnapshot,
    };
}
