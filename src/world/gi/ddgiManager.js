import * as THREE from 'three';
import { createProbeGrid, DEFAULT_GRID_DIMS, DEFAULT_CELL_SIZE } from './ddgiProbeGrid.js';
import { createDDGIDebug } from './ddgiDebug.js';
import { createDDGIAtlasTexture } from './ddgiAtlasTexture.js';
import { buildDDGIBVH } from './ddgiBVH.js';
import { createDDGIRTCompute } from './ddgiRTCompute.js';
import { createDDGISampler, patchMaterials } from './ddgiShaderInjection.js';

const DDGI_CAPTURE_LAYER = 30;
const DDGI_CAPTURE_MASK = (~(1 << DDGI_CAPTURE_LAYER)) >>> 0;

const _tmpPos = new THREE.Vector3();
const _tmpMin = new THREE.Vector3();
const _tmpMax = new THREE.Vector3();
const _tmpLightPos = new THREE.Vector3();
const _tmpLightTarget = new THREE.Vector3();
const _tmpDir = new THREE.Vector3();

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
        liveBake: true,
        bakeEveryN: 4,
        hysteresis: 0.92,
        normalBias: 0.12,
        intensity: 3.18,
        debugProbeIndex: 0,
        irradianceAtlas: null,
        atlasProbeCount: 0,
        sampler: null,
        probeInitialized: null,
        solidTestEnabled: false,
        solidTestColor: new THREE.Vector3(1.5, 0.9, 0.2),
        atlasNeedsClear: true,
        debugContributionView: false,
        fastWarmupCapturesRemaining: 0,
        lastInvalidateReason: 'initial',
        lastInvalidateAt: 0,
        lastBakeMs: 0,
        lastCaptureMs: 0,
        lastBVHBuildMs: 0,
        bvhStats: null,
        injectionEnabled: true,
        rtCompute: null,
        rtKey: '',
        bvhData: null,
        bvhDirty: true,
        needsBake: true,
        bakeFrameCounter: 0,
        warnedNoCompute: false,
    };

    let _bakePromise = null;
    let _probePositions = [];

    function createSampler() {
        return createDDGISampler({
            getAtlas: () => state.irradianceAtlas,
            getGrid: () => state.grid,
            getIntensity: () => {
                if (!state.enabled) return 0;
                if (state.solidTestEnabled) return state.intensity;
                return state.atlasNeedsClear ? 0 : state.intensity;
            },
            getNormalBias: () => state.normalBias,
            getDebugViewBlend: () => (state.debugContributionView ? 1 : 0),
            getDepthMean: () => state.irradianceAtlas?.depthMean,
            getDepthMeanSq: () => state.irradianceAtlas?.depthMeanSq,
            getProbeTrapped: () => state.irradianceAtlas?.probeTrapped,
            getSolidTestEnabled: () => state.solidTestEnabled,
            getSolidTestColor: () => state.solidTestColor,
        });
    }

    function init({ scene, renderer, camera, getDirectionalLight }) {
        state.scene = scene;
        state.renderer = renderer;
        state.camera = camera;
        state.getDirectionalLight = getDirectionalLight || null;
        state.grid = createProbeGrid({ dims: DEFAULT_GRID_DIMS, cellSize: DEFAULT_CELL_SIZE });
        state.debug = createDDGIDebug({ scene, layer: DDGI_CAPTURE_LAYER });
        ensureAtlasForGrid();
        state.sampler = createSampler();
        state._implicitVolume = {
            gridDims: { ...DEFAULT_GRID_DIMS },
            cellSize: DEFAULT_CELL_SIZE,
            intensity: 0.18,
            hysteresis: 0.92,
            normalBias: 0.12,
            probesPerFrame: 4,
            bakeEveryN: 4,
            containsPoint: () => false,
        };
        state.activeVolume = state._implicitVolume;
        state.grid.snapAnchorTo(state.camera?.position || new THREE.Vector3());
        state.debug.update(state.grid, state.irradianceAtlas);
    }

    function ensureAtlasForGrid() {
        if (!state.grid) return;
        const count = state.grid.probeCount();
        if (count === state.atlasProbeCount && state.irradianceAtlas) return;
        state.irradianceAtlas?.dispose();
        state.irradianceAtlas = createDDGIAtlasTexture({ probeCount: count });
        state.atlasProbeCount = count;
        state.probeInitialized = new Uint8Array(count);
        state.atlasNeedsClear = true;
        _probePositions = Array.from({ length: count }, () => new THREE.Vector3());
        state.sampler = createSampler();
        recreateRTCompute();
    }

    function probeBounds(outMin = _tmpMin, outMax = _tmpMax) {
        const d = state.grid.dims;
        state.grid.probePosition(0, 0, 0, outMin);
        state.grid.probePosition(d.x - 1, d.y - 1, d.z - 1, outMax);
        return { min: outMin, max: outMax };
    }

    function recreateRTCompute() {
        state.rtCompute?.dispose();
        state.rtCompute = null;
        state.rtKey = '';
        if (!state.renderer?.backend?.device || !state.grid) return false;
        const d = state.grid.dims;
        const key = `${d.x}|${d.y}|${d.z}`;
        const { min, max } = probeBounds();
        try {
            state.rtCompute = createDDGIRTCompute({
                renderer: state.renderer,
                probeDims: { x: d.x, y: d.y, z: d.z },
                probeMin: min.clone(),
                probeMax: max.clone(),
            });
            state.rtKey = key;
            if (state.bvhData) state.rtCompute.uploadBVH(state.bvhData);
            updateProbeBuffers();
            return true;
        } catch (e) {
            if (!state.warnedNoCompute) {
                state.warnedNoCompute = true;
                console.warn('[DDGI] RT compute unavailable', e);
            }
            return false;
        }
    }

    function ensureRTComputeForGrid() {
        if (!state.grid) return false;
        const d = state.grid.dims;
        const key = `${d.x}|${d.y}|${d.z}`;
        if (state.rtCompute && state.rtKey === key) return true;
        return recreateRTCompute();
    }

    function updateProbeBuffers() {
        if (!state.rtCompute || !state.grid) return;
        const count = state.grid.probeCount();
        if (_probePositions.length !== count) {
            _probePositions = Array.from({ length: count }, () => new THREE.Vector3());
        }
        for (let i = 0; i < count; i++) state.grid.probePositionByIndex(i, _probePositions[i]);
        const { min, max } = probeBounds();
        state.rtCompute.setProbeBounds(min, max);
        state.rtCompute.setProbePositions(_probePositions);
    }

    function clearAtlas() {
        state.irradianceAtlas?.clear();
        state.probeInitialized?.fill(0);
        state.atlasNeedsClear = true;
        state.rtCompute?.reset?.();
        state.sampler?.refreshUniforms();
    }

    function markGridMoved() {
        state.needsBake = true;
        clearAtlas();
        updateProbeBuffers();
    }

    function invalidate({ reason = 'manual', fastWarmupFrames = 1 } = {}) {
        state.bvhDirty = true;
        state.needsBake = true;
        state.fastWarmupCapturesRemaining = Math.max(0, fastWarmupFrames | 0);
        state.lastInvalidateReason = reason;
        state.lastInvalidateAt = performance.now?.() || Date.now();
        clearAtlas();
    }

    function gridKey() {
        if (!state.grid) return '';
        const a = state.grid.anchor;
        const d = state.grid.dims;
        return `${a.x},${a.y},${a.z}|${d.x},${d.y},${d.z}|${state.grid.cellSize}`;
    }

    function activeVolumeAnchor(out) {
        const mesh = state.activeVolume?.owner?.mesh || state.activeVolume?.owner?.root;
        if (!mesh) return null;
        const box = new THREE.Box3().setFromObject(mesh);
        if (box.isEmpty()) return null;
        return box.getCenter(out);
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
        applyVolume(state._implicitVolume || state.volumes[0]);
    }

    function applyVolume(vol) {
        if (!vol || !state.grid) return;
        const previousKey = gridKey();
        state.activeVolume = vol;
        state.grid.setDims(vol.gridDims);
        state.grid.setCellSize(vol.cellSize);
        state.hysteresis = vol.hysteresis ?? state.hysteresis;
        state.normalBias = vol.normalBias ?? state.normalBias;
        state.intensity = vol.intensity ?? state.intensity;
        state.bakeEveryN = Math.max(1, Math.min(120, vol.bakeEveryN ?? vol.probesPerFrame ?? state.bakeEveryN));
        ensureAtlasForGrid();
        if (previousKey && gridKey() !== previousKey) markGridMoved();
    }

    function collectLights() {
        const lights = [];
        const panel = state.scene?.getObjectByName?.('cornell-panel-light');
        if (panel?.isPointLight && panel.visible && panel.intensity > 0) {
            panel.getWorldPosition(_tmpLightPos);
            lights.push({
                type: 'point',
                posI: new THREE.Vector4(_tmpLightPos.x, _tmpLightPos.y, _tmpLightPos.z, panel.intensity),
                color: panel.color.clone(),
            });
        }

        const sun = state.getDirectionalLight?.();
        if (sun?.isDirectionalLight && sun.visible && sun.intensity > 0) {
            sun.updateWorldMatrix?.(true, false);
            sun.target?.updateWorldMatrix?.(true, false);
            sun.getWorldPosition(_tmpLightPos);
            sun.target?.getWorldPosition(_tmpLightTarget);
            _tmpDir.copy(_tmpLightPos).sub(_tmpLightTarget).normalize();
            lights.push({
                type: 'directional',
                posI: new THREE.Vector4(0, 0, 0, sun.intensity),
                color: sun.color.clone(),
                dir: _tmpDir.clone(),
            });
        }
        return lights;
    }

    function rebuildBVHIfNeeded() {
        if (!state.bvhDirty && state.bvhData) return true;
        const start = performance.now?.() || Date.now();
        const bvhData = buildDDGIBVH(state.scene);
        state.lastBVHBuildMs = (performance.now?.() || Date.now()) - start;
        if (!bvhData) return false;
        state.bvhData = bvhData;
        state.bvhStats = {
            meshCount: bvhData.meshCount,
            triCount: bvhData.triCount,
            nodeCount: bvhData.nodeCount,
            materialSlotCount: bvhData.materialSlotCount,
        };
        state.rtCompute?.uploadBVH(bvhData);
        state.bvhDirty = false;
        return true;
    }

    async function bakeOnce() {
        const start = performance.now?.() || Date.now();
        if (!state.grid || !state.scene || !ensureRTComputeForGrid()) return;
        updateProbeBuffers();
        if (!rebuildBVHIfNeeded() || !state.rtCompute?.hasBVH) return;

        const result = await state.rtCompute.bake({
            lights: collectLights(),
            indirectScale: 1.0,
            hysteresis: state.hysteresis,
            bounces: 1,
        });
        if (result) {
            state.irradianceAtlas?.updateFromReadback(result);
            state.probeInitialized?.fill(1);
            state.atlasNeedsClear = false;
            state.sampler?.refreshUniforms();
            if (state.debug?.isVisible()) state.debug.update(state.grid, state.irradianceAtlas);
        }
        state.lastBakeMs = (performance.now?.() || Date.now()) - start;
        state.lastCaptureMs = state.lastBakeMs;
    }

    function tick() {
        if (!state.grid || !state.camera) return;
        chooseActiveVolume();

        const previousKey = gridKey();
        if (state.activeVolume && state.activeVolume !== state._implicitVolume) {
            const anchor = activeVolumeAnchor(_tmpPos);
            if (anchor) state.grid.anchor.copy(anchor);
        } else {
            state.grid.snapAnchorTo(state.camera.position);
        }
        if (previousKey && gridKey() !== previousKey) markGridMoved();

        if (state.debug?.isVisible()) state.debug.update(state.grid, state.irradianceAtlas);
        state.sampler?.refreshUniforms();

        if (!state.enabled || !state.activeVolume) return;
        if (state.injectionEnabled && state.scene && state.sampler) patchSceneMaterials(state.scene);

        const every = Math.max(1, state.bakeEveryN | 0);
        state.bakeFrameCounter = (state.bakeFrameCounter + 1) % every;
        const due = state.needsBake || (state.liveBake && state.bakeFrameCounter === 0);
        if (!due || _bakePromise) return;

        state.needsBake = false;
        _bakePromise = bakeOnce()
            .catch((e) => {
                state.needsBake = true;
                console.warn('[DDGI] bake failed', e);
            })
            .finally(() => { _bakePromise = null; });
    }

    function getIrradianceAtlas() {
        return state.irradianceAtlas;
    }

    function getProbeTarget() {
        return null;
    }

    function setDebugVisible(v) {
        state.debug?.setVisible(v);
        if (v && state.grid) state.debug?.update(state.grid, state.irradianceAtlas);
    }

    function isDebugVisible() {
        return !!state.debug?.isVisible();
    }

    function setEnabled(v) {
        state.enabled = !!v;
        if (state.enabled) state.needsBake = true;
        state.sampler?.refreshUniforms();
    }

    function patchSceneMaterials(root, options) {
        if (!state.sampler) return;
        patchMaterials(root || state.scene, state.sampler.node, options);
    }

    function setInjectionEnabled(v) {
        state.injectionEnabled = !!v;
        if (state.injectionEnabled) patchSceneMaterials(state.scene);
    }

    function setContributionViewEnabled(v) {
        state.debugContributionView = !!v;
        state.sampler?.refreshUniforms();
        if (state.injectionEnabled) patchSceneMaterials(state.scene);
    }

    function setSolidTestEnabled(v) {
        const changed = state.solidTestEnabled !== !!v;
        state.solidTestEnabled = !!v;
        if (changed) state.sampler = createSampler();
        state.sampler?.refreshUniforms();
        if (state.injectionEnabled) patchSceneMaterials(state.scene, { forceRebuild: changed });
    }

    function setLiveBake(v) {
        state.liveBake = !!v;
    }

    function setBakeEveryN(n) {
        const numeric = Math.max(1, Math.min(120, Math.floor(Number.isFinite(n) ? n : state.bakeEveryN)));
        state.bakeEveryN = numeric;
        if (state._implicitVolume) {
            state._implicitVolume.bakeEveryN = numeric;
            state._implicitVolume.probesPerFrame = numeric;
        }
        if (state.activeVolume) {
            state.activeVolume.bakeEveryN = numeric;
            state.activeVolume.probesPerFrame = numeric;
        }
    }

    function setProbesPerFrame(n) {
        setBakeEveryN(n);
    }

    function setIntensity(v) {
        const numeric = Math.max(0, Math.min(16, Number.isFinite(v) ? v : state.intensity));
        state.intensity = numeric;
        if (state._implicitVolume) state._implicitVolume.intensity = numeric;
        if (state.activeVolume) state.activeVolume.intensity = numeric;
        state.sampler?.refreshUniforms();
    }

    function setHysteresis(v) {
        const numeric = Math.max(0, Math.min(0.999, Number.isFinite(v) ? v : state.hysteresis));
        state.hysteresis = numeric;
        if (state._implicitVolume) state._implicitVolume.hysteresis = numeric;
    }

    function setNormalBias(v) {
        const numeric = Math.max(0, Math.min(2, Number.isFinite(v) ? v : state.normalBias));
        state.normalBias = numeric;
        if (state._implicitVolume) state._implicitVolume.normalBias = numeric;
        state.sampler?.refreshUniforms();
    }

    function getSnapshot() {
        const probeCount = state.grid?.probeCount?.() || 0;
        let initializedProbes = 0;
        if (state.probeInitialized) {
            for (let i = 0; i < state.probeInitialized.length; i++) initializedProbes += state.probeInitialized[i] ? 1 : 0;
        }
        const activeVolumeType = state.activeVolume === state._implicitVolume
            ? 'implicit'
            : (state.activeVolume?.owner?.kind || state.activeVolume?.owner?.name || 'explicit');
        return {
            enabled: state.enabled,
            injectionEnabled: state.injectionEnabled,
            liveBake: state.liveBake,
            bakeEveryN: state.bakeEveryN,
            probesPerFrame: state.bakeEveryN,
            debugProbes: !!state.debug?.isVisible(),
            contributionView: state.debugContributionView,
            solidTestEnabled: state.solidTestEnabled,
            solidTestColor: state.solidTestColor.toArray(),
            intensity: state.intensity,
            hysteresis: state.hysteresis,
            normalBias: state.normalBias,
            probeCount,
            initializedProbes,
            activeVolumeType,
            fastWarmupCapturesRemaining: state.fastWarmupCapturesRemaining,
            lastInvalidateReason: state.lastInvalidateReason,
            lastInvalidateAt: state.lastInvalidateAt,
            lastBakeMs: state.lastBakeMs,
            lastCaptureMs: state.lastCaptureMs,
            lastBVHBuildMs: state.lastBVHBuildMs,
            bvhStats: state.bvhStats,
            bvhDirty: state.bvhDirty,
            bakeInFlight: !!_bakePromise,
        };
    }

    function dispose() {
        state.debug?.dispose();
        state.rtCompute?.dispose();
        state.irradianceAtlas?.dispose();
        state.debug = null;
        state.rtCompute = null;
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
        invalidate,
        setDebugVisible,
        setContributionViewEnabled,
        setSolidTestEnabled,
        isDebugVisible,
        setEnabled,
        get enabled() { return state.enabled; },
        setLiveBake,
        setBakeEveryN,
        setProbesPerFrame,
        setIntensity,
        setHysteresis,
        setNormalBias,
        getSnapshot,
        patchSceneMaterials,
        dispose,
        getGrid: () => state.grid,
        getActiveVolume: () => state.activeVolume,
        getProbeTarget,
        getCaptureMask: () => DDGI_CAPTURE_MASK,
        getDebugLayer: () => DDGI_CAPTURE_LAYER,
        getIrradianceAtlas,
        setInjectionEnabled,
        get contributionViewEnabled() { return state.debugContributionView; },
        get injectionEnabled() { return state.injectionEnabled; },
    };
}

let singleton = null;

export function getDDGIManager() {
    if (!singleton) singleton = createDDGIManager();
    return singleton;
}
