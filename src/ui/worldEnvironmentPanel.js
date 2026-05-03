// World Environment panel — runtime wiring.
//
// This module is self-contained: it loads after main.js, polls for the engine
// state via the already-exposed `window.__ddgi` global, then walks the scene
// graph to find the lights / fog group / sky textures it needs to control.
//
// Why this shape: main.js is a 256 KB monolith and pushing a full re-upload
// through the platform tooling is impractical. By keeping all the wiring in
// this side-loaded module we get the panel working without touching main.js.
//
// What this can control without main.js exposure:
//   ✓ Sky / background  (scene.environment, scene.background, blurriness)
//   ✓ Ambient / Hemi / Sun lights  (found via scene.traverse by light type)
//   ✓ Sun cast shadow  (mainDirectionalLight.castShadow)
//   ✓ Tonemap exposure  (renderer.toneMappingExposure)
//   ✓ Volumetric fog  (scene.fog density + fog group visibility)
//   ✓ DDGI  (window.__ddgi.setEnabled / setInjectionEnabled / setIntensity)
//   ✓ Shadows global  (renderer.shadowMap.enabled)
//
// What still needs main.js wiring (deferred to a future PR):
//   - Bloom strength/radius/threshold — uniforms are module-scoped to main.js.
//     Until that's exposed, the Bloom toggle in the panel only suppresses the
//     local state; the actual uniforms keep their previous values. The
//     existing Post Process Volume panel under Open tools still controls them.

import * as THREE from 'three';

const STORAGE_KEY = 'polyflow.worldEnvironment.v1';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 30_000;

const DEFAULTS = Object.freeze({
    sky: { enabled: true, preset: 'sunny-sky', blurriness: 0.05 },
    ambient: { enabled: true, intensity: 1.0 },
    hemi: { enabled: true, intensity: 1.5 },
    sun: { enabled: true, castShadow: true, intensity: 2.5 },
    tonemap: { exposure: 1.0 },
    bloom: { enabled: true, strength: 1.25, radius: 0.95, threshold: 0.48 },
    fog: { enabled: true, density: 0.012, opacity: 0.055 },
    ddgi: { enabled: false, probesPerFrame: 4, intensity: 0.18 },
    shadows: { enabled: true },
});

let state = JSON.parse(JSON.stringify(DEFAULTS));
let refs = null;
let engine = null; // { scene, renderer, ambient, hemi, sun, fogGroup, ddgi }
let cachedSkyTexture = null;

function loadFromStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        for (const key of Object.keys(DEFAULTS)) {
            if (parsed[key] && typeof parsed[key] === 'object') {
                state[key] = { ...DEFAULTS[key], ...parsed[key] };
            }
        }
    } catch (e) { /* corrupt — fall back */ }
}

function saveToStorage() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* quota — ignore */ }
}

function findEngineState() {
    const ddgi = window.__ddgi;
    if (!ddgi?.state?.scene || !ddgi?.state?.renderer) return null;

    const scene = ddgi.state.scene;
    const renderer = ddgi.state.renderer;

    // Find lights by traversing the scene. AmbientLight + HemisphereLight are
    // singletons in this engine; the directional sun is the one in main.js.
    let ambient = null, hemi = null, sun = null;
    scene.traverse((obj) => {
        if (obj.isAmbientLight && !ambient) ambient = obj;
        else if (obj.isHemisphereLight && !hemi) hemi = obj;
        else if (obj.isDirectionalLight && !sun && obj.castShadow) sun = obj;
    });

    const fogGroup = scene.getObjectByName('volumetric-fog');
    return { scene, renderer, ambient, hemi, sun, fogGroup, ddgi };
}

function applyState({ persist = true, switchSky = true } = {}) {
    if (!engine) return;
    const s = state;

    // Sky / background
    if (switchSky && s.sky.enabled) {
        // Cache whatever's currently set so disable can restore it later.
        if (engine.scene.environment) cachedSkyTexture = engine.scene.environment;
    }
    if (s.sky.enabled) {
        if (cachedSkyTexture && !engine.scene.environment) {
            engine.scene.environment = cachedSkyTexture;
            engine.scene.background = cachedSkyTexture;
        }
        engine.scene.backgroundBlurriness = s.sky.blurriness;
    } else {
        if (engine.scene.environment) cachedSkyTexture = engine.scene.environment;
        engine.scene.environment = null;
        engine.scene.background = null;
    }

    // Ambient / Hemi / Sun
    if (engine.ambient) {
        engine.ambient.visible = s.ambient.enabled;
        engine.ambient.intensity = s.ambient.intensity;
    }
    if (engine.hemi) {
        engine.hemi.visible = s.hemi.enabled;
        engine.hemi.intensity = s.hemi.intensity;
    }
    if (engine.sun) {
        engine.sun.visible = s.sun.enabled;
        engine.sun.castShadow = s.sun.enabled && s.sun.castShadow;
        engine.sun.intensity = s.sun.intensity;
    }

    // Tonemap
    engine.renderer.toneMappingExposure = s.tonemap.exposure;

    // Fog — toggle the volumetric layer group and the scene FogExp2 directly.
    if (engine.fogGroup) engine.fogGroup.visible = s.fog.enabled;
    if (s.fog.enabled) {
        if (!engine.scene.fog) {
            engine.scene.fog = new THREE.FogExp2(0x58616c, s.fog.density);
        } else {
            engine.scene.fog.density = s.fog.density;
        }
        // Layer opacity: walk the fog group's child meshes and update their
        // material opacity. Layer count is unknown here so we just scale.
        if (engine.fogGroup) {
            engine.fogGroup.traverse((obj) => {
                if (obj.isMesh && obj.material && 'opacity' in obj.material) {
                    obj.material.opacity = s.fog.opacity;
                }
            });
        }
    } else {
        engine.scene.fog = null;
    }

    // DDGI
    engine.ddgi.setEnabled?.(s.ddgi.enabled);
    engine.ddgi.setInjectionEnabled?.(s.ddgi.enabled);
    if (engine.ddgi.setProbesPerFrame) engine.ddgi.setProbesPerFrame(s.ddgi.probesPerFrame);
    else if (engine.ddgi.state) engine.ddgi.state.probesPerFrame = s.ddgi.probesPerFrame;
    if (engine.ddgi.setIntensity) engine.ddgi.setIntensity(s.ddgi.intensity);
    else if (engine.ddgi.state) engine.ddgi.state.intensity = s.ddgi.intensity;

    // Shadows
    if (engine.renderer.shadowMap) {
        engine.renderer.shadowMap.enabled = s.shadows.enabled;
    }

    // Bloom — without main.js exposure of globalPostProcessUniforms, the
    // strength/radius/threshold sliders update the local state only.
    // TODO(world-env): wire bloom uniforms once main.js exposes them.

    if (persist) saveToStorage();
    updateUi();
}

function updateUi() {
    if (!refs) return;
    const s = state;

    const setToggle = (off, on, isOn) => {
        off?.classList.toggle('viewer-toggle-btn-active', !isOn);
        on?.classList.toggle('viewer-toggle-btn-active', isOn);
    };
    const setSlider = (input, valueEl, value, decimals) => {
        if (input) input.value = value;
        if (valueEl) valueEl.textContent = Number(value).toFixed(decimals);
    };

    setToggle(refs.skyOff, refs.skyOn, s.sky.enabled);
    if (refs.skyPreset) refs.skyPreset.value = s.sky.preset;
    setSlider(refs.skyBlurriness, refs.skyBlurrinessValue, s.sky.blurriness, 2);

    setToggle(refs.ambientOff, refs.ambientOn, s.ambient.enabled);
    setSlider(refs.ambientIntensity, refs.ambientIntensityValue, s.ambient.intensity, 2);

    setToggle(refs.hemiOff, refs.hemiOn, s.hemi.enabled);
    setSlider(refs.hemiIntensity, refs.hemiIntensityValue, s.hemi.intensity, 2);

    setToggle(refs.sunOff, refs.sunOn, s.sun.enabled);
    if (refs.sunShadow) refs.sunShadow.checked = s.sun.castShadow;
    setSlider(refs.sunIntensity, refs.sunIntensityValue, s.sun.intensity, 2);

    setSlider(refs.exposure, refs.exposureValue, s.tonemap.exposure, 2);

    setToggle(refs.bloomOff, refs.bloomOn, s.bloom.enabled);
    setSlider(refs.bloomStrength, refs.bloomStrengthValue, s.bloom.strength, 2);
    setSlider(refs.bloomRadius, refs.bloomRadiusValue, s.bloom.radius, 2);
    setSlider(refs.bloomThreshold, refs.bloomThresholdValue, s.bloom.threshold, 2);

    setToggle(refs.fogOff, refs.fogOn, s.fog.enabled);
    setSlider(refs.fogDensity, refs.fogDensityValue, s.fog.density, 3);
    setSlider(refs.fogOpacity, refs.fogOpacityValue, s.fog.opacity, 3);

    setToggle(refs.ddgiOff, refs.ddgiOn, s.ddgi.enabled);
    if (refs.ddgiProbes) refs.ddgiProbes.value = s.ddgi.probesPerFrame;
    if (refs.ddgiProbesValue) refs.ddgiProbesValue.textContent = String(s.ddgi.probesPerFrame);
    setSlider(refs.ddgiIntensity, refs.ddgiIntensityValue, s.ddgi.intensity, 2);

    setToggle(refs.shadowsOff, refs.shadowsOn, s.shadows.enabled);

    if (refs.summaryValue) {
        const off = [];
        if (!s.sky.enabled) off.push('Sky');
        if (!s.bloom.enabled) off.push('Bloom');
        if (!s.fog.enabled) off.push('Fog');
        if (!s.ddgi.enabled) off.push('DDGI');
        if (!s.shadows.enabled) off.push('Shadows');
        refs.summaryValue.textContent = off.length ? `Off: ${off.join(' · ')}` : 'All effects active';
    }
    if (refs.masterStatus) {
        const allOn = s.sky.enabled && s.ambient.enabled && s.hemi.enabled && s.sun.enabled && s.bloom.enabled && s.fog.enabled && s.shadows.enabled;
        const perfPreset = !s.bloom.enabled && !s.fog.enabled && !s.ddgi.enabled && s.sky.enabled && s.sun.enabled;
        if (allOn && !s.ddgi.enabled) {
            refs.masterStatus.textContent = 'Everything on (DDGI off — opt in for prettier indirect lighting).';
        } else if (allOn && s.ddgi.enabled) {
            refs.masterStatus.textContent = 'Everything on, including DDGI.';
        } else if (perfPreset) {
            refs.masterStatus.textContent = 'Performance preset active. Bloom + Fog + DDGI paused.';
        } else {
            refs.masterStatus.textContent = 'Custom configuration.';
        }
    }
}

function setMaster(mode) {
    const s = state;
    if (mode === 'on') {
        s.sky.enabled = true;
        s.ambient.enabled = true;
        s.hemi.enabled = true;
        s.sun.enabled = true;
        s.bloom.enabled = true;
        s.fog.enabled = true;
        s.shadows.enabled = true;
        // DDGI stays opt-in.
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
        s.bloom.enabled = false;
        s.fog.enabled = false;
        s.ddgi.enabled = false;
    }
    applyState();
}

function resetDefaults() {
    state = JSON.parse(JSON.stringify(DEFAULTS));
    applyState();
}

function captureRefs() {
    refs = {
        summaryValue: document.getElementById('we-summary-value'),
        masterOnBtn: document.getElementById('we-master-on'),
        masterOffBtn: document.getElementById('we-master-off'),
        masterPerfBtn: document.getElementById('we-master-perf'),
        masterStatus: document.getElementById('we-master-status'),
        skyOff: document.getElementById('we-sky-off'),
        skyOn: document.getElementById('we-sky-on'),
        skyPreset: document.getElementById('we-sky-preset'),
        skyBlurriness: document.getElementById('we-sky-blurriness'),
        skyBlurrinessValue: document.getElementById('we-sky-blurriness-value'),
        ambientOff: document.getElementById('we-ambient-off'),
        ambientOn: document.getElementById('we-ambient-on'),
        ambientIntensity: document.getElementById('we-ambient-intensity'),
        ambientIntensityValue: document.getElementById('we-ambient-intensity-value'),
        hemiOff: document.getElementById('we-hemi-off'),
        hemiOn: document.getElementById('we-hemi-on'),
        hemiIntensity: document.getElementById('we-hemi-intensity'),
        hemiIntensityValue: document.getElementById('we-hemi-intensity-value'),
        sunOff: document.getElementById('we-sun-off'),
        sunOn: document.getElementById('we-sun-on'),
        sunShadow: document.getElementById('we-sun-shadow'),
        sunIntensity: document.getElementById('we-sun-intensity'),
        sunIntensityValue: document.getElementById('we-sun-intensity-value'),
        exposure: document.getElementById('we-tonemap-exposure'),
        exposureValue: document.getElementById('we-tonemap-exposure-value'),
        bloomOff: document.getElementById('we-bloom-off'),
        bloomOn: document.getElementById('we-bloom-on'),
        bloomStrength: document.getElementById('we-bloom-strength'),
        bloomStrengthValue: document.getElementById('we-bloom-strength-value'),
        bloomRadius: document.getElementById('we-bloom-radius'),
        bloomRadiusValue: document.getElementById('we-bloom-radius-value'),
        bloomThreshold: document.getElementById('we-bloom-threshold'),
        bloomThresholdValue: document.getElementById('we-bloom-threshold-value'),
        fogOff: document.getElementById('we-fog-off'),
        fogOn: document.getElementById('we-fog-on'),
        fogDensity: document.getElementById('we-fog-density'),
        fogDensityValue: document.getElementById('we-fog-density-value'),
        fogOpacity: document.getElementById('we-fog-opacity'),
        fogOpacityValue: document.getElementById('we-fog-opacity-value'),
        ddgiOff: document.getElementById('we-ddgi-off'),
        ddgiOn: document.getElementById('we-ddgi-on'),
        ddgiProbes: document.getElementById('we-ddgi-probes'),
        ddgiProbesValue: document.getElementById('we-ddgi-probes-value'),
        ddgiIntensity: document.getElementById('we-ddgi-intensity'),
        ddgiIntensityValue: document.getElementById('we-ddgi-intensity-value'),
        shadowsOff: document.getElementById('we-shadows-off'),
        shadowsOn: document.getElementById('we-shadows-on'),
        resetBtn: document.getElementById('we-reset-defaults'),
    };
}

function wireHandlers() {
    if (!refs) return;
    const wireToggle = (offBtn, onBtn, setOff, setOn) => {
        offBtn?.addEventListener('click', () => { setOff(); applyState(); });
        onBtn?.addEventListener('click', () => { setOn(); applyState(); });
    };
    const wireSlider = (input, setter, parser = parseFloat) => {
        input?.addEventListener('input', () => {
            const v = parser(input.value);
            if (Number.isFinite(v)) {
                setter(v);
                applyState({ switchSky: false });
            }
        });
    };

    refs.masterOnBtn?.addEventListener('click', () => setMaster('on'));
    refs.masterOffBtn?.addEventListener('click', () => setMaster('off'));
    refs.masterPerfBtn?.addEventListener('click', () => setMaster('perf'));
    refs.resetBtn?.addEventListener('click', () => resetDefaults());

    wireToggle(refs.skyOff, refs.skyOn,
        () => { state.sky.enabled = false; },
        () => { state.sky.enabled = true; });
    refs.skyPreset?.addEventListener('change', () => {
        state.sky.preset = refs.skyPreset.value;
        // Sky preset switch needs the engine controller (not exposed via ddgi
        // state). Instruct the user to use the existing flow for now.
        applyState();
    });
    wireSlider(refs.skyBlurriness, (v) => { state.sky.blurriness = v; });

    wireToggle(refs.ambientOff, refs.ambientOn,
        () => { state.ambient.enabled = false; },
        () => { state.ambient.enabled = true; });
    wireSlider(refs.ambientIntensity, (v) => { state.ambient.intensity = v; });

    wireToggle(refs.hemiOff, refs.hemiOn,
        () => { state.hemi.enabled = false; },
        () => { state.hemi.enabled = true; });
    wireSlider(refs.hemiIntensity, (v) => { state.hemi.intensity = v; });

    wireToggle(refs.sunOff, refs.sunOn,
        () => { state.sun.enabled = false; },
        () => { state.sun.enabled = true; });
    refs.sunShadow?.addEventListener('change', () => {
        state.sun.castShadow = !!refs.sunShadow.checked;
        applyState({ switchSky: false });
    });
    wireSlider(refs.sunIntensity, (v) => { state.sun.intensity = v; });

    wireSlider(refs.exposure, (v) => { state.tonemap.exposure = v; });

    wireToggle(refs.bloomOff, refs.bloomOn,
        () => { state.bloom.enabled = false; },
        () => { state.bloom.enabled = true; });
    wireSlider(refs.bloomStrength, (v) => { state.bloom.strength = v; });
    wireSlider(refs.bloomRadius, (v) => { state.bloom.radius = v; });
    wireSlider(refs.bloomThreshold, (v) => { state.bloom.threshold = v; });

    wireToggle(refs.fogOff, refs.fogOn,
        () => { state.fog.enabled = false; },
        () => { state.fog.enabled = true; });
    wireSlider(refs.fogDensity, (v) => { state.fog.density = v; });
    wireSlider(refs.fogOpacity, (v) => { state.fog.opacity = v; });

    wireToggle(refs.ddgiOff, refs.ddgiOn,
        () => { state.ddgi.enabled = false; },
        () => { state.ddgi.enabled = true; });
    wireSlider(refs.ddgiProbes,
        (v) => { state.ddgi.probesPerFrame = Math.round(v); }, (s) => parseInt(s, 10));
    wireSlider(refs.ddgiIntensity, (v) => { state.ddgi.intensity = v; });

    wireToggle(refs.shadowsOff, refs.shadowsOn,
        () => { state.shadows.enabled = false; },
        () => { state.shadows.enabled = true; });
}

function init() {
    captureRefs();
    if (!refs.masterOnBtn) {
        // Panel UI not in the DOM — fail quiet (older index.html).
        return;
    }
    wireHandlers();
    loadFromStorage();

    // Poll for the engine state until main.js has set up window.__ddgi.
    const startedAt = Date.now();
    const tick = () => {
        engine = findEngineState();
        if (engine) {
            applyState({ persist: false });
            console.log('[WorldEnvironment] Connected to engine.');
            return;
        }
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
            console.warn('[WorldEnvironment] Timed out waiting for window.__ddgi. Panel UI is wired but no engine state to apply.');
            updateUi();
            return;
        }
        setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
