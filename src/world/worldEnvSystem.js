import { vec3, vec4, mix, float } from 'three/tsl';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { core } from '../runtime/appCore.js';

// Game-mode levels skip DDGI: its live probe bake is noisy (random-seeded,
// low-sample) and speckles every GI-lit surface as grain. These scenes use
// plain direct lighting instead.
const GAME_MODE_SAMPLE_TYPES = new Set(['drugTycoon', 'doomArena', 'doomTest', 'shootingSim']);
function inGameModeLevel() {
    const t = core.currentMesh?.userData?.sampleType;
    return !!(t && GAME_MODE_SAMPLE_TYPES.has(t));
}

// Firefox's WebGPU is still experimental and chokes on the post-process node
// graph (bloom MRT + SSGI compute) — it renders black instead of the scene.
// Detect it once and skip the post-FX pipeline there so the plain scene draws.
// Chrome/Edge (stable WebGPU) keep the full pipeline.
const POST_FX_SUPPORTED = (() => {
    if (typeof navigator === 'undefined') return true;
    const ua = navigator.userAgent || '';
    const isFirefox = /firefox/i.test(ua);
    if (isFirefox) {
        console.warn('[postFX] Firefox detected — disabling bloom/SSGI post-processing (experimental WebGPU renders them black). Use Chrome/Edge for full effects.');
        return false;
    }
    return true;
})();

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
//   getPostProcessRenderData    - aux pass/history state for TAA/SSR
//   globalPostProcessUniforms   - bloom uniform refs (live)
//   getDDGIManager              - () => DDGIManager
//   getCornellPanelLight        - () => light | null (cornell-only)
//   isPerfModeEnabled           - () => bool
//   applyRenderResolutionSettings - renderer pixel-ratio/size forwarder
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
    getPostProcessRenderData,
    globalPostProcessUniforms,
    getDDGIManager,
    getCornellPanelLight,
    isPerfModeEnabled,
    applyRenderResolutionSettings,
    getLightCull,
    getAdaptiveQuality,
    applyShadowTuningToScene,
    applyPomTuningToScene,
    applyCornellTestPreset,
    getWorldEnvUiRefs,
}) {
    const WORLD_ENV_DEFAULTS = Object.freeze({
        sky: { enabled: true, preset: 'sunny-sky', blurriness: 0.05 },
        ambient: { enabled: false, intensity: 1.0 },
        hemi: { enabled: true, intensity: 1.5 },
        sun: { enabled: true, castShadow: true, intensity: 2.5 },
        tonemap: { exposure: 1.0 },
        aa: { enabled: false },   // Temporal AA on the post path; FXAA fallback
        // Forward-friendly image-quality uplift: raise internal render
        // resolution above the default DPR cap when explicitly enabled.
        renderResolution: { enabled: false, scale: 1.15, maxDpr: 2.5 },
        // Adaptive quality — FPS watchdog that steps effects down/up. Off by
        // default; opt-in (mainly for weaker GPUs / mobile).
        adaptive: { enabled: true },
        bloom: { enabled: true, strength: 0.5, radius: 0.35, threshold: 2.2 },
        // GTAO contact-shadow ambient occlusion. Cheap, big grounding payoff;
        // on by default. intensity 0..1 = how strongly AO darkens (1 = full).
        ssao: { enabled: true, intensity: 0.85, radius: 0.5, samples: 16, thickness: 1.0, scale: 1.0 },
        ssr: { enabled: false, intensity: 0.95, maxDistance: 16.0, thickness: 0.65, quality: 0.85, resolutionScale: 1.0, blurQuality: 2 },
        // Sphere reflection probe. Source = scene.environment PMREM, sphere-
        // parallax corrected so reflections track local geometry. Doubles as
        // the SSR fallback: where the screen-space ray misses (off-screen/sky),
        // the probe fills in instead of reflections vanishing. center/radius
        // wrap the playable area; intensity scales the contribution.
        reflectionProbe: { enabled: false, intensity: 1.0, radius: 40.0, centerX: 0, centerY: 2, centerZ: 0 },
        ssgi: { enabled: false, giIntensity: 2.0, aoIntensity: 1.0, radius: 8.0, thickness: 0.6, sliceCount: 1, stepCount: 8 },
        fog: { enabled: true, density: 0.012, opacity: 0.055 },
        // Analytic volumetric lighting (post pass). Directional sun in-scatter +
        // exponential height fog. Distinct from `fog` (legacy billboard sheets).
        // Off by default; opt-in. anisotropy = forward-scatter (god-ray glow).
        volumetric: {
            enabled: false, density: 0.02, heightFalloff: 0.08, baseHeight: 0.0,
            sunIntensity: 1.2, anisotropy: 0.72, maxOpacity: 0.85, intensity: 1.0,
            fogColor: 0x9fb2c8, sunColor: 0xfff0d8,
        },
        ddgi: { enabled: true, liveBake: true, bakeEveryN: 4, probesPerFrame: 4, intensity: 12.0, specularIntensity: 0.0, lightIntensity: 0.35, debugProbes: false, rayDebug: false, contributionView: false, solidTest: false },
        // Shadow tuning is global across point/spot/directional lights so the
        // user has one knob to fight self-shadow seams scene-wide instead of
        // hunting per-light.
        // `csm` enables Cascaded Shadow Maps on the main sun/directional light:
        // splits the view frustum into `cascades` slices, each with a tight
        // shadow camera → sharp near shadows + cheap far ones (vs one stretched
        // 2048 map). cascades 2–3 is the sweet spot.
        shadows: { enabled: true, bias: 0.0, normalBias: 0.0, radius: 7.9, mapSize: 512, csm: true, cascades: 3 },
        // Dynamic light culling: keep only the N most important point/spot lights
        // lit per frame (by intensity/distance²). Real FPS win in light-heavy
        // scenes; the sun/ambient/hemi are never culled. On by default.
        lightCull: { enabled: true, maxActive: 16 },
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
        if (!POST_FX_SUPPORTED) return false;
        const perf = isPerfModeEnabled();
        return !!((worldEnvState.aa?.enabled && !perf)
            || (worldEnvState.bloom?.enabled && !perf)
            || (worldEnvState.ssao?.enabled && !perf)
            || (worldEnvState.ssr?.enabled && !perf)
            || (worldEnvState.ssgi?.enabled && !perf));
    }

    function resetTaaHistory() {
        const data = getPostProcessRenderData?.();
        data?.taa?.resetHistory?.();
    }

    function rebuildPostProcessingOutputNode() {
        const postProcessing = getPostProcessing();
        const postProcessNodes = getPostProcessNodes();
        if (!postProcessing || !postProcessNodes) return;
        const { sceneColor, sceneDepth, bloomNode, aoOutput, ssgiOutput, traaNode, traaSsrNode, traaSsrProbeNode, ssrNode, ssrProbeNode, volumetric } = postProcessNodes;
        const renderData = getPostProcessRenderData?.();
        const perf = isPerfModeEnabled();
        const aaEnabled = !!(worldEnvState.aa?.enabled && !perf);
        const taaEnabled = !!(aaEnabled && traaNode);
        const ssrEnabled = !!(worldEnvState.ssr?.enabled && !perf && ssrNode);
        // Reflection probe = SSR's off-screen fallback. Only meaningful when SSR
        // is active (it reuses SSR's G-buffer + hit mask). probeEnabled gates
        // swapping the plain SSR add for the probe-composited add.
        const probeEnabled = !!(worldEnvState.reflectionProbe?.enabled && ssrEnabled && ssrProbeNode);
        if (renderData?.taa) {
            if (renderData.taa.enabled !== taaEnabled) renderData.taa.resetHistory?.();
            renderData.taa.enabled = taaEnabled;
        }
        if (renderData?.ssr) renderData.ssr.enabled = ssrEnabled;
        if (renderData?.reflectionProbe) renderData.reflectionProbe.enabled = probeEnabled;
        applySSRSettings();
        applyReflectionProbeSettings();
        if (!shouldUsePostProcessingPipeline()) {
            postProcessing.outputNode = sceneColor;
            return;
        }
        // AO multiplies the lit color FIRST (darkens creases/contacts), then
        // bloom is added on top so emissive highlights aren't dimmed by AO.
        // intensity 0..1 lerps between "no AO" (1.0) and the raw AO factor.
        let litColor = taaEnabled
            ? (ssrEnabled
                ? (probeEnabled && traaSsrProbeNode ? traaSsrProbeNode : traaSsrNode)
                : traaNode)
            : sceneColor;
        if (worldEnvState.ssao?.enabled && !perf && aoOutput) {
            const k = float(worldEnvState.ssao.intensity ?? 1.0);
            const aoFactor = mix(float(1.0), aoOutput.r, k);
            litColor = litColor.mul(vec4(vec3(aoFactor), 1.0));
        }
        let outputNode = litColor;
        if (worldEnvState.ssgi?.enabled && !perf && ssgiOutput) {
            outputNode = outputNode
                .mul(vec4(vec3(ssgiOutput.a), 1))
                .add(vec4(ssgiOutput.rgb, 0));
        }
        if (ssrEnabled && !taaEnabled) {
            outputNode = outputNode.add(probeEnabled && ssrProbeNode ? ssrProbeNode : ssrNode);
        }
        // Volumetric lighting / height fog wraps the lit color BEFORE bloom so
        // bright sun in-scatter blooms. Uses the new analytic node (directional
        // scattering), distinct from the legacy billboard-sheet fog controller.
        const volEnabled = !!(worldEnvState.volumetric?.enabled && !perf && volumetric && sceneDepth);
        const renderDataVol = getPostProcessRenderData?.();
        if (renderDataVol?.volumetric) renderDataVol.volumetric.enabled = volEnabled;
        if (volEnabled) {
            applyVolumetricSettings();
            outputNode = volumetric.build(outputNode, sceneDepth);
        }
        if (aaEnabled && !taaEnabled) {
            outputNode = fxaa(outputNode);
        }
        if (worldEnvState.bloom?.enabled && !perf) {
            outputNode = outputNode.add(bloomNode);
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

    function applySSAOSettings() {
        const node = getPostProcessNodes()?.aoNode;
        const s = worldEnvState.ssao || WORLD_ENV_DEFAULTS.ssao;
        if (!node) return;
        node.radius.value = s.radius;
        node.thickness.value = s.thickness;
        node.scale.value = s.scale;
        node.samples.value = Math.max(4, Math.min(32, Math.round(s.samples)));
    }

    function applySSRSettings() {
        const node = getPostProcessNodes()?.ssrNode;
        const s = worldEnvState.ssr || WORLD_ENV_DEFAULTS.ssr;
        if (!node || !s) return;
        node.opacity.value = s.intensity;
        node.maxDistance.value = s.maxDistance;
        node.thickness.value = s.thickness;
        node.quality.value = Math.max(0, Math.min(1, s.quality ?? 0.5));
        node.resolutionScale = Math.max(0.25, Math.min(1, s.resolutionScale ?? 0.75));
        node.blurQuality.value = Math.max(1, Math.min(3, Math.round(s.blurQuality ?? 2)));
    }

    function applyReflectionProbeSettings() {
        const probe = getPostProcessNodes()?.reflectionProbe;
        const s = worldEnvState.reflectionProbe || WORLD_ENV_DEFAULTS.reflectionProbe;
        if (!probe || !s) return;
        probe.setBounds({ x: s.centerX ?? 0, y: s.centerY ?? 2, z: s.centerZ ?? 0 }, s.radius ?? 40);
        probe.setIntensity(s.intensity ?? 1.0);
    }

    function applyVolumetricSettings() {
        const vol = getPostProcessNodes()?.volumetric;
        const s = worldEnvState.volumetric || WORLD_ENV_DEFAULTS.volumetric;
        if (!vol || !s) return;
        vol.setParams({
            density: s.density,
            heightFalloff: s.heightFalloff,
            baseHeight: s.baseHeight,
            sunIntensity: s.sunIntensity,
            anisotropy: s.anisotropy,
            maxOpacity: s.maxOpacity,
            intensity: s.intensity,
        });
        if (Number.isFinite(s.fogColor)) vol.setColors({ fog: s.fogColor });
        if (Number.isFinite(s.sunColor)) vol.setColors({ sun: s.sunColor });
        // Sun direction = toward the sun = (light world pos − target). The fog
        // node normalizes; clone to avoid mutating the light's vectors.
        const sun = getMainDirectionalLight?.();
        if (sun?.position?.clone) {
            sun.updateMatrixWorld?.();
            const dir = sun.position.clone();
            if (sun.target?.position) dir.sub(sun.target.position);
            vol.setSunDirection(dir);
        }
    }

    function applyWorldEnvState({ persist = true, switchSky = true } = {}) {
        const s = worldEnvState;
        // SSGI is force-disabled: its low-sample screen-space pass speckles
        // surfaces as grain. Hard off here so saved state / presets can't
        // re-enable it.
        s.ssgi.enabled = false;
        const perf = isPerfModeEnabled();
        // Post-FX (bloom/SSGI) are skipped entirely where unsupported (Firefox).
        const runtimeBloomEnabled = s.bloom.enabled && !perf && POST_FX_SUPPORTED;
        const runtimeFogEnabled = s.fog.enabled && !perf;
        // fix/ddgi-correctness: decouple DDGI from perf-mode (see runtime.js
        // comment in PR #22). Game modes force DDGI off — its live bake grain
        // showed up as speckle across all surfaces (Drug Tycoon grow room etc).
        const runtimeDdgiEnabled = s.ddgi.enabled && !inGameModeLevel();

        // Sky / Background
        const environmentController = getEnvironmentController();
        const useLevelManagedLighting = core.currentMesh?.userData?.sampleType === 'drugTycoon';
        if (environmentController) {
            environmentController.setEnabled?.(s.sky.enabled && !useLevelManagedLighting);
            environmentController.setBackgroundBlurriness?.(s.sky.blurriness);
            if (!useLevelManagedLighting && switchSky && environmentController.getCurrentEnvironment?.() !== s.sky.preset) {
                environmentController.switchEnvironment?.(s.sky.preset);
            }
        }

        // Ambient + Hemi + Sun — direct property writes since they're THREE lights.
        const ambientLight = getAmbientLight();
        const hemiLight = getHemiLight();
        const mainDirectionalLight = getMainDirectionalLight();
        if (ambientLight) {
            ambientLight.visible = s.ambient.enabled && !useLevelManagedLighting;
            ambientLight.intensity = useLevelManagedLighting ? 0 : s.ambient.intensity;
        }
        if (hemiLight) {
            hemiLight.visible = s.hemi.enabled && !useLevelManagedLighting;
            hemiLight.intensity = useLevelManagedLighting ? 0 : s.hemi.intensity;
        }
        if (mainDirectionalLight) {
            mainDirectionalLight.visible = s.sun.enabled && !useLevelManagedLighting;
            mainDirectionalLight.castShadow = s.sun.enabled && s.sun.castShadow && !useLevelManagedLighting;
            mainDirectionalLight.intensity = useLevelManagedLighting ? 0 : s.sun.intensity;
        }

        // Tonemap exposure — write to renderer immediately AND record as the
        // post-process volume default so the lerp doesn't drag it back.
        const renderer = getRenderer();
        if (renderer) {
            renderer.toneMappingExposure = s.tonemap.exposure;
        }
        applyRenderResolutionSettings?.(s.renderResolution);
        const postProcessVolumeManager = getPostProcessVolumeManager();
        postProcessVolumeManager?.setDefaultSettings?.({ toneMappingExposure: s.tonemap.exposure });

        // Bloom — when off, postProcessVolumeManager.setEnabled clamps uniforms
        // to neutral. When on, push the user's slider values through both the
        // shader uniforms AND the volume defaults so volume-based grading still works.
        if (runtimeBloomEnabled) {
            postProcessVolumeManager?.setDefaultSettings?.({
                bloomStrength: s.bloom.strength,
                bloomRadius: s.bloom.radius,
                bloomThreshold: s.bloom.threshold,
                toneMappingExposure: s.tonemap.exposure,
            }, { immediate: true });
            postProcessVolumeManager?.setEnabled?.(true);
            if (globalPostProcessUniforms.bloomStrength) globalPostProcessUniforms.bloomStrength.value = s.bloom.strength;
            if (globalPostProcessUniforms.bloomRadius) globalPostProcessUniforms.bloomRadius.value = s.bloom.radius;
            if (globalPostProcessUniforms.bloomThreshold) globalPostProcessUniforms.bloomThreshold.value = s.bloom.threshold;
        } else {
            postProcessVolumeManager?.setEnabled?.(false);
        }

        // Screen Space GI + Ambient Occlusion
        applySSGISettings();
        applySSAOSettings();
        applySSRSettings();
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
        // Specular GI off in game-mode levels (DDGI itself is disabled there).
        ddgi?.setSpecularIntensity?.(runtimeDdgiEnabled ? (s.ddgi.specularIntensity ?? 0) : 0);
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

        // Dynamic light culling config (the per-frame cull runs in the frame loop).
        const lc = getLightCull?.();
        if (lc && s.lightCull) {
            lc.setMaxActive(s.lightCull.maxActive);
            lc.setEnabled(s.lightCull.enabled);
        }

        // Adaptive quality watchdog enable/disable (its per-frame update runs in
        // the frame loop). setEnabled is a no-op when unchanged, so the re-apply
        // it triggers internally doesn't recurse.
        const aq = getAdaptiveQuality?.();
        if (aq && s.adaptive) aq.setEnabled(s.adaptive.enabled);

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

        setToggle(worldEnvUiRefs.aaOff, worldEnvUiRefs.aaOn, !!s.aa?.enabled);
        if (s.renderResolution) {
            setToggle(worldEnvUiRefs.renderResolutionOff, worldEnvUiRefs.renderResolutionOn, s.renderResolution.enabled);
            setSlider(worldEnvUiRefs.renderResolutionScale, worldEnvUiRefs.renderResolutionScaleValue, s.renderResolution.scale, 2);
            setSlider(worldEnvUiRefs.renderResolutionMaxDpr, worldEnvUiRefs.renderResolutionMaxDprValue, s.renderResolution.maxDpr, 2);
        }
        if (s.adaptive) setToggle(worldEnvUiRefs.adaptiveOff, worldEnvUiRefs.adaptiveOn, s.adaptive.enabled);

        setToggle(worldEnvUiRefs.bloomOff, worldEnvUiRefs.bloomOn, s.bloom.enabled);
        setSlider(worldEnvUiRefs.bloomStrength, worldEnvUiRefs.bloomStrengthValue, s.bloom.strength, 2);
        setSlider(worldEnvUiRefs.bloomRadius, worldEnvUiRefs.bloomRadiusValue, s.bloom.radius, 2);
        setSlider(worldEnvUiRefs.bloomThreshold, worldEnvUiRefs.bloomThresholdValue, s.bloom.threshold, 2);

        if (s.ssao) {
            setToggle(worldEnvUiRefs.ssaoOff, worldEnvUiRefs.ssaoOn, s.ssao.enabled);
            setSlider(worldEnvUiRefs.ssaoIntensity, worldEnvUiRefs.ssaoIntensityValue, s.ssao.intensity, 2);
            setSlider(worldEnvUiRefs.ssaoRadius, worldEnvUiRefs.ssaoRadiusValue, s.ssao.radius, 2);
        }
        if (s.ssr) {
            setToggle(worldEnvUiRefs.ssrOff, worldEnvUiRefs.ssrOn, s.ssr.enabled);
            setSlider(worldEnvUiRefs.ssrIntensity, worldEnvUiRefs.ssrIntensityValue, s.ssr.intensity, 2);
            setSlider(worldEnvUiRefs.ssrMaxDistance, worldEnvUiRefs.ssrMaxDistanceValue, s.ssr.maxDistance, 1);
            setSlider(worldEnvUiRefs.ssrThickness, worldEnvUiRefs.ssrThicknessValue, s.ssr.thickness, 2);
            setSlider(worldEnvUiRefs.ssrQuality, worldEnvUiRefs.ssrQualityValue, s.ssr.quality, 2);
        }
        if (s.reflectionProbe) {
            setToggle(worldEnvUiRefs.probeOff, worldEnvUiRefs.probeOn, s.reflectionProbe.enabled);
            setSlider(worldEnvUiRefs.probeIntensity, worldEnvUiRefs.probeIntensityValue, s.reflectionProbe.intensity, 2);
            setSlider(worldEnvUiRefs.probeRadius, worldEnvUiRefs.probeRadiusValue, s.reflectionProbe.radius, 0);
        }
        if (s.volumetric) {
            setToggle(worldEnvUiRefs.volOff, worldEnvUiRefs.volOn, s.volumetric.enabled);
            setSlider(worldEnvUiRefs.volDensity, worldEnvUiRefs.volDensityValue, s.volumetric.density, 3);
            setSlider(worldEnvUiRefs.volHeight, worldEnvUiRefs.volHeightValue, s.volumetric.heightFalloff, 3);
            setSlider(worldEnvUiRefs.volSun, worldEnvUiRefs.volSunValue, s.volumetric.sunIntensity, 2);
            setSlider(worldEnvUiRefs.volAniso, worldEnvUiRefs.volAnisoValue, s.volumetric.anisotropy, 2);
        }

        setToggle(worldEnvUiRefs.ssgiOff, worldEnvUiRefs.ssgiOn, s.ssgi.enabled);

        setToggle(worldEnvUiRefs.fogOff, worldEnvUiRefs.fogOn, s.fog.enabled);
        setSlider(worldEnvUiRefs.fogDensity, worldEnvUiRefs.fogDensityValue, s.fog.density, 3);
        setSlider(worldEnvUiRefs.fogOpacity, worldEnvUiRefs.fogOpacityValue, s.fog.opacity, 3);

        setToggle(worldEnvUiRefs.ddgiOff, worldEnvUiRefs.ddgiOn, s.ddgi.enabled);
        setToggle(worldEnvUiRefs.ddgiLiveBakeOff, worldEnvUiRefs.ddgiLiveBakeOn, s.ddgi.liveBake);
        if (worldEnvUiRefs.ddgiBakeEveryN) worldEnvUiRefs.ddgiBakeEveryN.value = s.ddgi.bakeEveryN;
        if (worldEnvUiRefs.ddgiBakeEveryNValue) worldEnvUiRefs.ddgiBakeEveryNValue.textContent = String(s.ddgi.bakeEveryN);
        setSlider(worldEnvUiRefs.ddgiIntensity, worldEnvUiRefs.ddgiIntensityValue, s.ddgi.intensity, 16);
        setSlider(worldEnvUiRefs.ddgiSpecular, worldEnvUiRefs.ddgiSpecularValue, s.ddgi.specularIntensity ?? 0, 2);
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

        if (s.lightCull) {
            setToggle(worldEnvUiRefs.lightCullOff, worldEnvUiRefs.lightCullOn, s.lightCull.enabled);
            setSlider(worldEnvUiRefs.lightCullMax, worldEnvUiRefs.lightCullMaxValue, s.lightCull.maxActive, 0);
        }

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
            if (s.ssr && !s.ssr.enabled) off.push('SSR');
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
            if (s.ssr) s.ssr.enabled = false;
            s.ssgi.enabled = false;
            s.fog.enabled = false;
            s.ddgi.enabled = false;
            s.shadows.enabled = false;
            if (s.renderResolution) s.renderResolution.enabled = false;
        } else if (mode === 'perf') {
            s.aa.enabled = false;
            s.bloom.enabled = false;
            if (s.ssr) s.ssr.enabled = false;
            s.ssgi.enabled = false;
            s.fog.enabled = false;
            s.ddgi.enabled = false;
            if (s.renderResolution) s.renderResolution.enabled = false;
        } else if (mode === 'debug-off') {
            // Basic rendering only: kill EVERY post-FX / GI / shadow effect so the
            // pipeline bypasses to a plain renderer.render (no offscreen passes).
            // Base lighting (sky/ambient/hemi/sun) stays on so the scene is lit.
            s.aa.enabled = false;
            s.bloom.enabled = false;
            if (s.ssao) s.ssao.enabled = false;
            if (s.ssr) s.ssr.enabled = false;
            if (s.reflectionProbe) s.reflectionProbe.enabled = false;
            s.ssgi.enabled = false;
            if (s.volumetric) s.volumetric.enabled = false;
            s.fog.enabled = false;
            s.ddgi.enabled = false;
            s.shadows.enabled = false;
            if (s.renderResolution) s.renderResolution.enabled = false;
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
        applySSAOSettings,
        applySSRSettings,
        resetTaaHistory,
        applyWorldEnvState,
        updateWorldEnvUi,
        setWorldEnvMaster,
        resetWorldEnvDefaults,
    };
}
