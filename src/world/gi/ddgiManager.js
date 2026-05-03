import * as THREE from 'three';
import { createProbeGrid, DEFAULT_GRID_DIMS, DEFAULT_CELL_SIZE } from './ddgiProbeGrid.js';
import { createDDGIDebug } from './ddgiDebug.js';
import { createCubeRenderer } from './ddgiCubeRenderer.js';
import { createAtlasPair, chooseTilesPerRow, IRRADIANCE_TILE } from './ddgiAtlas.js';
import { createIntegrator } from './ddgiIntegrate.js';
import { createDDGISampler, patchMaterials } from './ddgiShaderInjection.js';

const DDGI_CAPTURE_LAYER = 30; // probes & debug viz live here; excluded from capture
const DDGI_CAPTURE_MASK = (~(1 << DDGI_CAPTURE_LAYER)) >>> 0;

/**
 * DDGI manager singleton. Owns the probe grid, atlases (later phases), and the
 * round-robin update scheduler (later phases). Phase A: scaffolding only —
 * grid math + debug viz + volume registration.
 */
export function createDDGIManager() {
    const state = {
        scene: null,
        renderer: null,
        camera: null,
        getDirectionalLight: null,
        grid: null,
        debug: null,
        volumes: [],
        activeVolume: null,
        enabled: true,
        probesPerFrame: 4,
        hysteresis: 0.97,
        normalBias: 0.4,
        intensity: 1.0,
        roundRobinCursor: 0,
        cubeRenderer: null,
        captureBudgetMs: 4.0,
        debugProbeIndex: 0,
        irradianceAtlas: null,
        integrator: null,
        atlasProbeCount: 0,
        sampler: null,
        // Material-injection is OFF by default until the TSL outputNode path is
        // proven safe across all material types. Captures + atlas still build,
        // so toggling on later picks up live data immediately.
        injectionEnabled: false,
    };

    function init({ scene, renderer, camera, getDirectionalLight }) {
        state.scene = scene;
        state.renderer = renderer;
        state.camera = camera;
        state.getDirectionalLight = getDirectionalLight || null;
        state.grid = createProbeGrid({ dims: DEFAULT_GRID_DIMS, cellSize: DEFAULT_CELL_SIZE });
        state.debug = createDDGIDebug({ scene });
        state.cubeRenderer = createCubeRenderer({ renderer, scene, faceSize: 16 });
        state.integrator = createIntegrator({ renderer });
        // Move debug viz onto excluded layer so probes don't capture themselves.
        state.debug.group.traverse(o => o.layers.set(DDGI_CAPTURE_LAYER));
        ensureAtlasForGrid();
        state.sampler = createDDGISampler({
            getAtlas: () => state.irradianceAtlas,
            getGrid: () => state.grid,
            getIntensity: () => (state.enabled ? state.intensity : 0),
        });
        // Implicit default volume — GI is active without user authoring.
        state._implicitVolume = {
            gridDims: { ...DEFAULT_GRID_DIMS },
            cellSize: DEFAULT_CELL_SIZE,
            intensity: 1.0,
            hysteresis: 0.97,
            normalBias: 0.4,
            probesPerFrame: 4,
            containsPoint: () => false,
        };
        state.activeVolume = state._implicitVolume;

        // Seed debug viz immediately so probes are visible from frame 0.
        state.grid.snapAnchorTo(state.camera?.position || new THREE.Vector3());
        state.debug.update(state.grid);
    }

    function ensureAtlasForGrid() {
        if (!state.grid) return;
        const count = state.grid.probeCount();
        if (count === state.atlasProbeCount && state.irradianceAtlas) return;
        if (state.irradianceAtlas) state.irradianceAtlas.dispose();
        const tilesPerRow = chooseTilesPerRow(count);
        state.irradianceAtlas = createAtlasPair({
            probeCount: count,
            tile: IRRADIANCE_TILE,
            tilesPerRow,
        });
        state.atlasProbeCount = count;
    }

    function registerVolume(volume) {
        if (!volume) return;
        if (!state.volumes.includes(volume)) state.volumes.push(volume);
        chooseActiveVolume();
    }

    function unregisterVolume(volume) {
        const idx = state.volumes.indexOf(volume);
        if (idx >= 0) state.volumes.splice(idx, 1);
        if (state.activeVolume === volume) state.activeVolume = null;
        chooseActiveVolume();
    }

    function chooseActiveVolume() {
        if (state.volumes.length === 0) {
            // No explicit volume — fall through with default settings so GI is
            // active by default, anchored to the camera. Plays nice with the
            // editor flow where users haven't spawned a DDGI Volume yet.
            if (!state.activeVolume) state.activeVolume = state._implicitVolume;
            return;
        }
        const camPos = state.camera?.position;
        if (camPos) {
            for (const v of state.volumes) {
                if (v.containsPoint?.(camPos)) {
                    applyVolume(v);
                    return;
                }
            }
        }
        applyVolume(state.volumes[0]);
    }

    function applyVolume(vol) {
        if (!vol || !state.grid) return;
        state.activeVolume = vol;
        state.grid.setDims(vol.gridDims);
        state.grid.setCellSize(vol.cellSize);
        state.hysteresis = vol.hysteresis;
        state.normalBias = vol.normalBias;
        state.intensity = vol.intensity;
        ensureAtlasForGrid();
    }

    const _tmpPos = new THREE.Vector3();
    let _capturePromise = null;

    function tick(/* delta */) {
        if (!state.grid || !state.camera) return;
        chooseActiveVolume();

        // Snap grid anchor to camera (cell-quanta) regardless of volume so the
        // debug viz always tracks the camera.
        state.grid.snapAnchorTo(state.camera.position);

        if (state.debug?.isVisible()) {
            state.debug.update(state.grid);
        }

        if (!state.enabled || !state.activeVolume) return;

        // Push current grid + atlas state into the sampler uniforms so all
        // patched materials see fresh values this frame.
        state.sampler?.refreshUniforms();

        // Idempotent re-patch: catches materials added since last frame.
        // Patched materials short-circuit via userData._ddgiPatched.
        if (state.injectionEnabled && state.scene && state.sampler) {
            patchMaterials(state.scene, state.sampler.node);
        }

        // Round-robin capture, fire-and-forget per frame.
        if (state.cubeRenderer && !_capturePromise) {
            _capturePromise = captureBatch().finally(() => { _capturePromise = null; });
        }
    }

    async function captureBatch() {
        const total = state.grid.probeCount();
        if (total === 0) return;
        const N = Math.max(1, state.activeVolume?.probesPerFrame || state.probesPerFrame);
        for (let i = 0; i < N; i++) {
            const idx = state.roundRobinCursor % total;
            state.roundRobinCursor = (state.roundRobinCursor + 1) % total;
            state.grid.probePositionByIndex(idx, _tmpPos);
            try {
                const cubeRT = await state.cubeRenderer.captureProbe(idx, _tmpPos, {
                    layersMask: DDGI_CAPTURE_MASK,
                });
                integrateInto(idx, cubeRT);
            } catch (e) {
                if (state.debug?.isVisible()) console.warn('[DDGI] capture failed', idx, e);
                break;
            }
        }
    }

    function integrateInto(probeIndex, cubeRT) {
        if (!state.integrator || !state.irradianceAtlas) return;
        state.integrator.integrateProbe({
            cubeTarget: cubeRT,
            atlas: state.irradianceAtlas,
            probeIndex,
            intensity: state.intensity,
            hysteresis: state.hysteresis,
        });
    }

    function getIrradianceAtlas() {
        return state.irradianceAtlas;
    }

    function getProbeTarget(index) {
        return state.cubeRenderer?.getTarget(index) || null;
    }

    function setDebugVisible(v) {
        state.debug?.setVisible(v);
    }

    function isDebugVisible() {
        return !!state.debug?.isVisible();
    }

    function setEnabled(v) {
        state.enabled = !!v;
    }

    function patchSceneMaterials(root) {
        if (!state.sampler) return;
        patchMaterials(root || state.scene, state.sampler.node);
    }

    function setInjectionEnabled(v) {
        state.injectionEnabled = !!v;
        if (state.injectionEnabled) patchSceneMaterials(state.scene);
    }

    function dispose() {
        state.debug?.dispose();
        state.debug = null;
        state.cubeRenderer?.dispose();
        state.cubeRenderer = null;
        state.integrator?.dispose();
        state.integrator = null;
        state.irradianceAtlas?.dispose();
        state.irradianceAtlas = null;
        state.atlasProbeCount = 0;
        state.grid = null;
        state.volumes.length = 0;
        state.activeVolume = null;
    }

    return {
        state,
        init,
        tick,
        registerVolume,
        unregisterVolume,
        setDebugVisible,
        isDebugVisible,
        setEnabled,
        get enabled() { return state.enabled; },
        patchSceneMaterials,
        dispose,
        getGrid: () => state.grid,
        getActiveVolume: () => state.activeVolume,
        getProbeTarget,
        getCaptureMask: () => DDGI_CAPTURE_MASK,
        getIrradianceAtlas,
        setInjectionEnabled,
        get injectionEnabled() { return state.injectionEnabled; },
    };
}

let singleton = null;

export function getDDGIManager() {
    if (!singleton) singleton = createDDGIManager();
    return singleton;
}
