import { vec3, vec4 } from 'three/tsl';

// World Environment system — Godot-style global graphics inspector. Owns:
//   - WORLD_ENV_DEFAULTS preset
//   - worldEnvState (live, mutable; serialized to localStorage)
//   - load/save persistence
//   - applyWorldEnvState() — push every section to its renderer subsystem
//   - updateWorldEnvUi() — paint the panel from current state
//   - setWorldEnvMaster() — All On / All Off / Perf / Cornell preset toggle
//   - resetWorldEnvDefaults() — restore the frozen preset
//
// State lives INSIDE this module. Other code reads via getWorldEnvState() —
// the returned object is the live mutable reference (callers mutate it then
// call applyWorldEnvState()). resetWorldEnvDefaults() replaces the internal
// ref; callers must re-fetch via getWorldEnvState() if they cached it.
//
// Deps (injected — every renderer subsystem the original block reached for):
//   storageKey                  - localStorage key (versioned)
//   getRenderer                 - () => WebGLRenderer | null
//   getAmbientLight / getHemiLight / getMainDirectionalLight - lights
//   getEnvironmentController    - sky + IBL controller
//   getVolumetricFogController
//   getPostProcessVolumeManager
//   getPostProcessing           - the PostProcessing pass instance
//   getPostProcessNodes         - { sceneColor, bloomNode, ssgiOutput, ssgiNode }
//   globalPostProcessUniforms   - bloom uniform refs (live)
//   getDDGIManager              - () => DDGIManager
//   getCornellPanelLight        - () => light | null (cornell-only)
//   isPerfModeEnabled           - () => bool
//   applyShadowTuningToScene    - tuning forwarder
//   applyPomTuningToScene       - tuning forwarder
//   applyCornellTestPreset      - master preset hook
//   getWorldEnvUiRefs           - () => uiRefs | null
export function createWorldEnvSystem({
    storageKey,
    getRenderer,
    getAmbientLight,
    getHemiLight,
    getMainDirectionalLight,
    getEnvironmentController,
    getVolumetricFogController,
    getPostProcessVolumeManager,
    getPostProcessing,
    getPostProcessNodes,
    globalPostProcessUniforms,
    getDDGIManager,
    getCornellPanelLight,
    isPerfModeEnabled,
    applyShadowTuningToScene,
    applyPomTuningToScene,
    applyCornellTestPreset,
    getWorldEnvUiRefs,
}) {
    const WORLD_ENV_DEFAULTS = Object.freeze({
        sky: { enabled: true, preset: 'sunny-sky', blurriness: 0.05 },
        ambient: { enabled: true, intensity: 1.0 },
        hemi: { enabled: true, intensity: 1.5 },
        sun: { enabled: true, castShadow: true, intensity: 2.5 },
        tonemap: { exposure: 1.0 },
        bloom: { enabled: true, strength: 0.6, radius: 0.95, threshold: 0.9 },
        ssgi: { enabled: false, giIntensity: 2.0, aoIntensity: 1.0, radius: 8.0, thickness: 0.6, sliceCount: 1, stepCount: 8 },
        fog: { enabled: true, density: 0.012, opacity: 0.055 },
        ddgi: { enabled: true, liveBake: true, bakeEveryN: 4, probesPerFrame: 4, intensity: 12.0, lightIntensity: 0.35, debugProbes: false, rayDebug: false, contributionView: false, solidTest: false },
        // Shadow tuning is global across point/spot/directional lights so the
        // user has one knob to fight self-shadow seams scene-wide instead of
        // hunting per-light.
        shadows: { enabled: true, bias: 0.0, normalBias: 0.0, radius: 7.9, mapSize: 512 },
        // Parallax Occlusion Mapping defaults.
        pom: { enabled: false, intensity: 0.04, quality: 'medium' },
    });

    // Live mutable state. Held by reference — callers can capture it once
    // and read fields directly; resetWorldEnvDefaults() copies fresh defaults
    // INTO this object rather than replacing the ref so cached aliases stay
    // valid.
    const worldEnvState = JSON.parse(JSON.stringify(WORLD_ENV_DEFAULTS));

    function getWorldEnvState() { return worldEnvState; }
    function getWorldEnvDefaults() { return WORLD_ENV_DEFAULTS; }

    function _replaceWorldEnvStateInPlace(source) {
        // Clear out any keys not in source, then deep-copy each section.
        for (const key of Object.keys(worldEnvState)) {
            if (!(key in source)) delete worldEnvState[key];
        }
        for (const key of Object.keys(source)) {
            const sectionSrc = source[key];
            if (sectionSrc && typeof sectionSrc === 'object') {
                if (!worldEnvState[key] || typeof worldEnvState[key] !== 'object') {
                    worldEnvState[key] = {};
                }
                // Replace section key-by-key.
                for (const k of Object.keys(worldEnvState[key])) {
                    if (!(k in sectionSrc)) delete worldEnvState[key][k];
                }
                for (const k of Object.keys(sectionSrc)) {
                    worldEnvState[key][k] = sectionSrc[k];
                }
            } else {
                worldEnvState[key] = sectionSrc;
            }
        }
    }

    function loadWorldEnvFromStorage() {
        try {
            const raw = localStorage.getItem(storageKey);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            // Shallow-merge each section so newly-added defaults survive a
            // load of an older saved blob.
            for (const key of Object.keys(WORLD_ENV_DEFAULTS)) {
                if (parsed[key] && typeof parsed[key] === 'object') {
                    worldEnvState[key] = { ...WORLD_ENV_DEFAULTS[key], ...parsed[key] };
                }
            }
            // Debug views are session tools. Always boot into lit render.
            worldEnvState.ddgi.debugProbes = false;
            worldEnvState.ddgi.contributionView = false;
            worldEnvState.ddgi.intensity = Math.min(worldEnvState.ddgi.intensity, WORLD_ENV_DEFAULTS.ddgi.intensity);
            worldEnvState.ddgi.liveBake = worldEnvState.ddgi.liveBake !== false;
            worldEnvState.ddgi.bakeEveryN = Math.max(1, Math.min(120,
                worldEnvState.ddgi.bakeEveryN ?? worldEnvState.ddgi.probesPerFrame ?? WORLD_ENV_DEFAULTS.ddgi.bakeEveryN));
            worldEnvState.ddgi.probesPerFrame = worldEnvState.ddgi.bakeEveryN;
        } catch (e) {
            // Corrupt storage — fall back to defaults silently.
        }
    }

    function saveWorldEnvToStorage() {
        try {
            localStorage.setItem(storageKey, JSON.stringify(worldEnvState));
        } catch (e) { /* private mode / quota — ignore */ }
    }

    function shouldUsePostProcessingPipeline() {
        const perf = isPerfModeEnabled();
        return !!((worldEnvState.bloom?.enabled && !perf)
            || (worldEnvState.ssgi?.enabled && !perf));
    }

    function rebuildPostProcessingOutputNode() {
        const postProcessing = getPostProcessing();
        const postProcessNodes = getPostProcessNodes();
        if (!postProcessing || !postProcessNodes) return;
        const { sceneColor, bloomNode, ssgiOutput } = postProcessNodes;
        if (!shouldUsePostProcessingPipeline()) {
            postProcessing.outputNode = sceneColor;
            return;
        }

        const perf = isPerfModeEnabled();
        let outputNode = sceneColor;
        if (worldEnvState.bloom?.enabled && !perf) {
            outputNode = outputNode.add(bloomNode);
        }
        if (worldEnvState.ssgi?.enabled && !perf && ssgiOutput) {
            outputNode = sceneColor
                .mul(vec4(vec3(ssgiOutput.a), 1))
                .add(vec4(ssgiOutput.rgb, 0))
                .add(worldEnvState.bloom?.enabled && !perf ? bloomNode : vec4(0, 0, 0, 0));
        }
        postProcessing.outputNode = outputNode;
    }

    function applySSGISettings() {
        const node = getPostProcessNodes()?.ssgiNode;
        const s = worldEnvState.ssgi || WORLD_ENV_DEFAULTS.ssgi;
        if (!node) return;
        node.giIntensity.value = s.giIntensity;
        node.aoIntensity.value = s.aoIntensity;
        node.radius.value = s.radius;
        node.thickness.value = s.thickness;
        node.sliceCount.value = Math.max(1, Math.min(4, Math.round(s.sliceCount)));
        node.stepCount.value = Math.max(1, Math.min(32, Math.round(s.stepCount)));
    }

    function applyWorldEnvState({ persist = true, switchSky = true } = {}) {
        const s = worldEnvState;
        const perf = isPerfModeEnabled();
        const runtimeBloomEnabled = s.bloom.enabled && !perf;
        const runtimeFogEnabled = s.fog.enabled && !perf;
        // fix/ddgi-correctness: decouple DDGI from perf-mode (see runtime.js
        // comment in PR #22).
        const runtimeDdgiEnabled = s.ddgi.enabled;

        // Sky / Background
        const environmentController = getEnvironmentController();
        if (environmentController) {
            environmentController.setEnabled?.(s.sky.enabled);
            environmentController.setBackgroundBlurriness?.(s.sky.blurriness);
            if (switchSky && environmentController.getCurrentEnvironment?.() !== s.sky.preset) {
                environmentController.switchEnvironment?.(s.sky.preset);
            }
        }

        // Ambient + Hemi + Sun — direct property writes since they're THREE lights.
        const ambientLight = getAmbientLight();
        const hemiLight = getHemiLight();
        const mainDirectionalLight = getMainDirectionalLight();
        if (ambientLight) {
            ambientLight.visible = s.ambient.enabled;
            ambientLight.intensity = s.ambient.intensity;
        }
        if (hemiLight) {
            hemiLight.visible = s.hemi.enabled;
            hemiLight.intensity = s.hemi.intensity;
        }
        if (mainDirectionalLight) {
            mainDirectionalLight.visible = s.sun.enabled;
            mainDirectionalLight.castShadow = s.sun.enabled && s.sun.castShadow;
            mainDirectionalLight.intensity = s.sun.intensity;
        }

        // Tonemap exposure — write to renderer immediately AND record as the
        // post-process volume default so the lerp doesn't drag it back.
        const renderer = getRenderer();
        if (renderer) {
            renderer.toneMappingExposure = s.tonemap.exposure;
        }
        const postProcessVolumeManager = getPostProcessVolumeManager();
        postProcessVolumeManager?.setDefaultSettings?.({ toneMappingExposure: s.tonemap.exposure });

        // Bloom — when off, postProcessVolumeManager.setEnabled clamps uniforms
        // to neutral. When on, push the user's slider values through both the
        // shader uniforms AND the volume defaults so volume-based grading still works.
        if (runtimeBloomEnabled) {
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

        // Screen Space GI
        applySSGISettings();
        rebuildPostProcessingOutputNode();

        // Fog
        const volumetricFogController = getVolumetricFogController();
        if (volumetricFogController) {
            volumetricFogController.setEnabled?.(runtimeFogEnabled);
            volumetricFogController.setDensity?.(s.fog.density);
            volumetricFogController.setOpacity?.(s.fog.opacity);
        }

        // DDGI
        const ddgi = getDDGIManager();
        ddgi?.setEnabled?.(runtimeDdgiEnabled);
        ddgi?.setInjectionEnabled?.(runtimeDdgiEnabled);
        ddgi?.setLiveBake?.(s.ddgi.liveBake);
        ddgi?.setBakeEveryN?.(s.ddgi.bakeEveryN ?? s.ddgi.probesPerFrame);
        ddgi?.setIntensity?.(s.ddgi.intensity);
        ddgi?.setDebugVisible?.(s.ddgi.debugProbes);
        ddgi?.setContributionViewEnabled?.(runtimeDdgiEnabled && s.ddgi.contributionView);
        ddgi?.setSolidTestEnabled?.(runtimeDdgiEnabled && s.ddgi.solidTest);
        const cornellPanelLight = getCornellPanelLight();
        if (cornellPanelLight) cornellPanelLight.intensity = s.ddgi.lightIntensity;

        // Shadows: global toggle + per-light bias/normalBias/PCF radius/map size.
        if (renderer?.shadowMap) {
            renderer.shadowMap.enabled = s.shadows.enabled;
        }
        applyShadowTuningToScene(s.shadows);
        applyPomTuningToScene(s.pom);

        if (persist) saveWorldEnvToStorage();
        updateWorldEnvUi();
    }

    function updateWorldEnvUi() {
        const worldEnvUiRefs = getWorldEnvUiRefs();
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

        setToggle(worldEnvUiRefs.ssgiOff, worldEnvUiRefs.ssgiOn, s.ssgi.enabled);

        setToggle(worldEnvUiRefs.fogOff, worldEnvUiRefs.fogOn, s.fog.enabled);
        setSlider(worldEnvUiRefs.fogDensity, worldEnvUiRefs.fogDensityValue, s.fog.density, 3);
        setSlider(worldEnvUiRefs.fogOpacity, worldEnvUiRefs.fogOpacityValue, s.fog.opacity, 3);

        setToggle(worldEnvUiRefs.ddgiOff, worldEnvUiRefs.ddgiOn, s.ddgi.enabled);
        setToggle(worldEnvUiRefs.ddgiLiveBakeOff, worldEnvUiRefs.ddgiLiveBakeOn, s.ddgi.liveBake);
        if (worldEnvUiRefs.ddgiBakeEveryN) worldEnvUiRefs.ddgiBakeEveryN.value = s.ddgi.bakeEveryN;
        if (worldEnvUiRefs.ddgiBakeEveryNValue) worldEnvUiRefs.ddgiBakeEveryNValue.textContent = String(s.ddgi.bakeEveryN);
        setSlider(worldEnvUiRefs.ddgiIntensity, worldEnvUiRefs.ddgiIntensityValue, s.ddgi.intensity, 16);
        setSlider(worldEnvUiRefs.ddgiLightIntensity, worldEnvUiRefs.ddgiLightIntensityValue, s.ddgi.lightIntensity, 2);
        setToggle(worldEnvUiRefs.ddgiProbeDebugOff, worldEnvUiRefs.ddgiProbeDebugOn, s.ddgi.debugProbes);
        setToggle(worldEnvUiRefs.ddgiRayDebugOff, worldEnvUiRefs.ddgiRayDebugOn, s.ddgi.rayDebug);
        setToggle(worldEnvUiRefs.ddgiSolidTestOff, worldEnvUiRefs.ddgiSolidTestOn, s.ddgi.solidTest);
        setToggle(worldEnvUiRefs.ddgiViewLit, worldEnvUiRefs.ddgiViewContribution, s.ddgi.contributionView);

        setToggle(worldEnvUiRefs.shadowsOff, worldEnvUiRefs.shadowsOn, s.shadows.enabled);
        setSlider(worldEnvUiRefs.shadowsBias, worldEnvUiRefs.shadowsBiasValue, s.shadows.bias, 4);
        setSlider(worldEnvUiRefs.shadowsNormalBias, worldEnvUiRefs.shadowsNormalBiasValue, s.shadows.normalBias, 2);
        setSlider(worldEnvUiRefs.shadowsRadius, worldEnvUiRefs.shadowsRadiusValue, s.shadows.radius, 1);
        setSlider(worldEnvUiRefs.shadowsMapSize, worldEnvUiRefs.shadowsMapSizeValue, s.shadows.mapSize, 0);

        setToggle(worldEnvUiRefs.pomOff, worldEnvUiRefs.pomOn, s.pom.enabled);
        setSlider(worldEnvUiRefs.pomIntensity, worldEnvUiRefs.pomIntensityValue, s.pom.intensity, 3);
        const pomQ = (s.pom.quality || 'medium').toLowerCase();
        worldEnvUiRefs.pomQualityLow?.classList.toggle('viewer-toggle-btn-active', pomQ === 'low');
        worldEnvUiRefs.pomQualityMedium?.classList.toggle('viewer-toggle-btn-active', pomQ === 'medium');
        worldEnvUiRefs.pomQualityHigh?.classList.toggle('viewer-toggle-btn-active', pomQ === 'high');

        if (worldEnvUiRefs.summaryValue) {
            const off = [];
            if (!s.sky.enabled) off.push('Sky');
            if (!s.bloom.enabled) off.push('Bloom');
            if (!s.ssgi.enabled) off.push('SSGI');
            if (!s.fog.enabled) off.push('Fog');
            if (!s.ddgi.enabled) off.push('DDGI');
            if (!s.shadows.enabled) off.push('Shadows');
            worldEnvUiRefs.summaryValue.textContent = off.length ? `Off: ${off.join(' · ')}` : 'All effects active';
        }
        if (worldEnvUiRefs.masterStatus) {
            const perf = isPerfModeEnabled();
            const allCoreOn = s.sky.enabled && s.ambient.enabled && s.hemi.enabled && s.sun.enabled && s.bloom.enabled && s.ssgi.enabled && s.fog.enabled && s.shadows.enabled;
            const perfPreset = !s.bloom.enabled && !s.ssgi.enabled && !s.fog.enabled && !s.ddgi.enabled && s.sky.enabled && s.sun.enabled;
            const cornellPreset = !s.sky.enabled && !s.ambient.enabled && !s.hemi.enabled && !s.sun.enabled
                && !s.bloom.enabled && !s.ssgi.enabled && !s.fog.enabled && s.shadows.enabled
                && s.ddgi.enabled && Math.abs(s.ddgi.intensity - WORLD_ENV_DEFAULTS.ddgi.intensity) < 0.001;
            if (s.ddgi.enabled && s.ddgi.contributionView) {
                worldEnvUiRefs.masterStatus.textContent = 'DDGI contribution view active.';
            } else if (s.ssgi.enabled && !perf) {
                worldEnvUiRefs.masterStatus.textContent = 'Screen Space GI active.';
            } else if (s.ddgi.enabled && s.ddgi.solidTest) {
                worldEnvUiRefs.masterStatus.textContent = 'Solid DDGI test active. Probes bypassed with fixed amber GI.';
            } else if (s.ddgi.debugProbes) {
                worldEnvUiRefs.masterStatus.textContent = 'DDGI probe debug active.';
            } else if (cornellPreset) {
                worldEnvUiRefs.masterStatus.textContent = 'Cornell test preset active. Sky and sun are off; DDGI bleed is emphasized.';
            } else if (allCoreOn && !s.ddgi.enabled) {
                worldEnvUiRefs.masterStatus.textContent = 'Everything on (DDGI off — opt in for prettier indirect lighting).';
            } else if (allCoreOn && s.ddgi.enabled) {
                worldEnvUiRefs.masterStatus.textContent = 'Everything on, including DDGI + SSGI.';
            } else if (perfPreset) {
                worldEnvUiRefs.masterStatus.textContent = 'Performance preset active. Bloom + SSGI + Fog + DDGI paused.';
            } else {
                worldEnvUiRefs.masterStatus.textContent = 'Custom configuration.';
            }
        }
    }

    function setWorldEnvMaster(mode) {
        const s = worldEnvState;
        if (mode === 'on') {
            s.sky.enabled = true;
            s.ambient.enabled = true;
            s.hemi.enabled = true;
            s.sun.enabled = true;
            s.bloom.enabled = true;
            s.ssgi.enabled = true;
            s.fog.enabled = true;
            s.shadows.enabled = true;
            // DDGI is opt-in even with All On — too expensive for a default.
        } else if (mode === 'off') {
            s.sky.enabled = false;
            s.ambient.enabled = false;
            s.hemi.enabled = false;
            s.sun.enabled = false;
            s.bloom.enabled = false;
            s.ssgi.enabled = false;
            s.fog.enabled = false;
            s.ddgi.enabled = false;
            s.shadows.enabled = false;
        } else if (mode === 'perf') {
            s.bloom.enabled = false;
            s.ssgi.enabled = false;
            s.fog.enabled = false;
            s.ddgi.enabled = false;
        } else if (mode === 'cornell') {
            applyCornellTestPreset();
            return;
        }
        applyWorldEnvState();
    }

    function resetWorldEnvDefaults() {
        _replaceWorldEnvStateInPlace(JSON.parse(JSON.stringify(WORLD_ENV_DEFAULTS)));
        applyWorldEnvState();
    }

    return {
        WORLD_ENV_DEFAULTS,
        getWorldEnvState,
        getWorldEnvDefaults,
        loadWorldEnvFromStorage,
        saveWorldEnvToStorage,
        shouldUsePostProcessingPipeline,
        rebuildPostProcessingOutputNode,
        applySSGISettings,
        applyWorldEnvState,
        updateWorldEnvUi,
        setWorldEnvMaster,
        resetWorldEnvDefaults,
    };
}
