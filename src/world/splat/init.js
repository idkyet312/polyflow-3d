// src/world/splat/init.js
//
// One-call wire-up for the splat module. Drop into main.js with two lines:
//
//   import { wireSplatDevHooks } from './src/world/splat/init.js';
//   init().then(() => wireSplatDevHooks(scene, sceneSystem));

import * as splatRenderer from './splatRenderer.js';
import * as splatActor from './splatActor.js';
import * as splatPerf from './perfMode.js';
import { wireSplatDropZone } from './dropZone.js';

export async function wireSplatDevHooks(scene, sceneSystem = null, opts = {}) {
    const { enableDropZone = true } = opts;

    if (typeof window !== 'undefined') {
        window.splatRenderer = splatRenderer;
        window.splatActor = splatActor;
        window.splatPerf = {
            setMode: splatPerf.setSplatSortMode,
            getMode: splatPerf.getSplatSortMode,
            getStatus: splatPerf.getSplatSortStatus,
            setShDegree: splatPerf.setSplatShDegree,
            getShDegree: splatPerf.getSplatShDegree,
            setBlendMode: splatPerf.setSplatBlendMode,
            getBlendMode: splatPerf.getSplatBlendMode,
            setRenderSettings: splatPerf.setSplatRenderSettings,
            getRenderSettings: splatPerf.getSplatRenderSettings,
            detectComputeSupport: splatPerf.detectComputeSupport,
        };
    }

    if (enableDropZone && scene && typeof window !== 'undefined') {
        wireSplatDropZone({ scene, sceneSystem });
    }

    if (typeof window === 'undefined') return null;
    const urlParams = new URLSearchParams(window.location.search);
    const splatUrl = urlParams.get('splat');
    if (!splatUrl) return null;

    console.log('[splat] Auto-loading from URL param:', splatUrl);
    try {
        if (sceneSystem) {
            return await splatActor.addSplatActorToSceneSystem(sceneSystem, {
                url: splatUrl,
                name: 'PhotoScan',
            });
        }

        return await splatRenderer.addSplatToScene(scene, splatUrl);
    } catch (err) {
        console.error('[splat] failed to load:', err);
        return null;
    }
}
