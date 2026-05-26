// Shadow + POM tuning helpers, extracted from src/app/runtime.js.
//
// Five cohesive scene-traversal functions that stamp the World Options
// shadow / parallax-occlusion-mapping tuning onto live scene objects, plus
// per-light shadow refresh helpers. No shared scratch globals, no DOM — only
// THREE traversal + a couple of live engine refs.
//
// Live engine refs (scene, renderer) are read per-call via `core` so they
// track reassignment (renderer is rebuilt, scene swaps on level load).
// Values that live as module-scope state in runtime.js (worldEnvState,
// perfModeEnabled) and the CSM setter are injected as deps:
//
//   const { configurePointLightShadow, applyShadowTuningToScene, ... } =
//       createShadowTuning({
//           getWorldEnvState: () => worldEnvState,
//           isPerfModeEnabled: () => perfModeEnabled,
//           setMainLightCSM,
//       });
//
// perfModeEnabled and worldEnvState are passed as getters because both are
// reassigned/mutated after this factory runs.

import { core } from '../runtime/appCore.js';

export function createShadowTuning({
    getWorldEnvState = () => null,
    isPerfModeEnabled = () => false,
    setMainLightCSM = () => {},
} = {}) {
    function requestLightShadowRefresh(light) {
        if (!light?.castShadow || !light.shadow) return;
        if (light.isPointLight && light.shadow.camera) {
            light.shadow.camera.near = 0.1;
            light.shadow.camera.far = Math.max(light.distance > 0 ? light.distance : 24, 0.5);
            light.shadow.camera.updateProjectionMatrix?.();
        }
        light.shadow.needsUpdate = true;
        const { renderer } = core;
        if (renderer?.shadowMap) {
            renderer.shadowMap.needsUpdate = true;
        }
    }

    function configurePointLightShadow(light, opts = {}) {
        if (!light?.isPointLight || !light.shadow) return light;
        // Inherit any unspecified value from the global shadow tuning in
        // worldEnvState so newly-spawned lights match the World Options panel
        // without an extra apply pass. Callers that pass an explicit value still
        // win — useful for the cornell preset which sets its own defaults.
        const g = getWorldEnvState()?.shadows ?? {};
        const mapSize = Number.isFinite(opts.mapSize) ? opts.mapSize : (g.mapSize ?? 512);
        const bias = Number.isFinite(opts.bias) ? opts.bias : (g.bias ?? 0.0005);
        const normalBias = Number.isFinite(opts.normalBias) ? opts.normalBias : (g.normalBias ?? 0.02);
        const radius = Number.isFinite(opts.radius) ? opts.radius : (g.radius ?? 2.5);
        light.shadow.mapSize.set(mapSize, mapSize);
        light.shadow.bias = bias;
        light.shadow.radius = radius;
        if ('normalBias' in light.shadow) light.shadow.normalBias = normalBias;
        light.shadow.autoUpdate = false;
        requestLightShadowRefresh(light);
        return light;
    }

    function requestScenePointLightShadowRefresh(root = core.scene) {
        root?.traverse?.((obj) => {
            if (!obj?.isPointLight || !obj.castShadow) return;
            requestLightShadowRefresh(obj);
        });
    }

    // Walks the scene and stamps the World Options POM tuning onto every
    // DDGI-converted material. Materials without a heightMap stay inert; ones
    // with a heightMap get the global enabled flag plus live intensity update.
    // Quality changes trigger a TSL recompile via material.syncPomGraphIfStale().
    // Perf mode forces enabled=false regardless of user setting.
    function applyPomTuningToScene(tuning, root = core.scene) {
        if (!tuning || !root?.traverse) return;
        const wantEnabled = !!tuning.enabled && !isPerfModeEnabled();
        const intensity = Math.max(0, Number.isFinite(tuning.intensity) ? tuning.intensity : 0.04);
        const quality = tuning.quality || 'medium';

        root.traverse((obj) => {
            if (!obj.isMesh) return;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) {
                if (!m?.isDDGIMeshStandardNodeMaterial) continue;
                // Don't force pomEnabled=true on materials that don't have a
                // heightMap — the material's own rebuild path treats missing
                // heightMap as "disabled" automatically, but flipping the flag
                // anyway wastes a needsUpdate cycle.
                const hasHeight = !!m.heightMap;
                m.pomEnabled = wantEnabled && hasHeight;
                m.pomQuality = quality;
                m.setPomIntensity?.(intensity);
                m.pomIntensity = intensity;
                m.syncPomGraphIfStale?.();
            }
        });
    }

    // Walks the scene and stamps the World Options shadow tuning onto every
    // shadow-casting light. Point + spot + directional all share the same set of
    // shadow params so a single panel covers all three. bias/normalBias/radius
    // apply immediately. WebGPU shadow render targets cannot be resized safely
    // after allocation because RenderTarget.setSize() disposes textures that may
    // still be referenced by queued GPU work.
    function applyShadowTuningToScene(tuning, root = core.scene) {
        if (!tuning || !root?.traverse) return;
        const bias = Number.isFinite(tuning.bias) ? tuning.bias : 0.0005;
        const normalBias = Number.isFinite(tuning.normalBias) ? tuning.normalBias : 0.02;
        const radius = Math.max(0, Number.isFinite(tuning.radius) ? tuning.radius : 2.5);
        const mapSize = Math.max(64, Math.min(4096, Number.isFinite(tuning.mapSize) ? (tuning.mapSize | 0) : 512));

        root.traverse((obj) => {
            if (!obj?.castShadow || !obj.shadow) return;
            if (!obj.isPointLight && !obj.isSpotLight && !obj.isDirectionalLight) return;
            obj.shadow.bias = bias;
            if ('normalBias' in obj.shadow) obj.shadow.normalBias = normalBias;
            obj.shadow.radius = radius;
            if (!obj.shadow.map && (obj.shadow.mapSize.x !== mapSize || obj.shadow.mapSize.y !== mapSize)) {
                obj.shadow.mapSize.set(mapSize, mapSize);
            }
            obj.shadow.needsUpdate = true;
        });
        const { renderer } = core;
        if (renderer?.shadowMap) renderer.shadowMap.needsUpdate = true;

        // Cascaded Shadow Maps on the sun light. Only when shadows are enabled;
        // tuning.csm (default on) + tuning.cascades drive it.
        const wantCSM = tuning.enabled !== false && tuning.csm !== false;
        setMainLightCSM(wantCSM, Math.max(1, Math.min(4, (tuning.cascades | 0) || 3)));
    }

    return {
        requestLightShadowRefresh,
        configurePointLightShadow,
        requestScenePointLightShadowRefresh,
        applyPomTuningToScene,
        applyShadowTuningToScene,
    };
}
