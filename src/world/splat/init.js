// src/world/splat/init.js
//
// One-call wire-up for the splat module. Drop into main.js with two lines:
//
//   import { wireSplatDevHooks } from './src/world/splat/init.js';
//   init().then(() => wireSplatDevHooks(scene, sceneSystem));   // sceneSystem optional
//
// Behavior:
//   - Exposes window.splatRenderer and window.splatActor for console testing.
//   - Wires drag-and-drop file loading for .splat / .ply / .sog onto the page.
//     Drop a file anywhere on the window to add it as a splat actor (or bare
//     mesh, when no SceneSystem is provided). Pass `enableDropZone: false` in
//     opts to opt out.
//   - If the page URL has ?splat=<url>, auto-loads that splat at world origin.
//   - When a SceneSystem is provided, splats are registered as proper actors
//     (gizmo-editable, serializable). When omitted, falls back to a bare mesh.

import * as splatRenderer from './splatRenderer.js';
import * as splatActor from './splatActor.js';
import { wireSplatDropZone } from './dropZone.js';

export async function wireSplatDevHooks(scene, sceneSystem = null, opts = {}) {
    const { enableDropZone = true } = opts;

    // Console hooks for ad-hoc testing in DevTools.
    if (typeof window !== 'undefined') {
        window.splatRenderer = splatRenderer;
        window.splatActor    = splatActor;
    }

    // Drag-and-drop file loading. Wired before the URL auto-loader so it's
    // available even on pages without a ?splat= query param.
    if (enableDropZone && scene && typeof window !== 'undefined') {
        wireSplatDropZone({ scene, sceneSystem });
    }

    // ?splat=<url> auto-loader.
    if (typeof window === 'undefined') return null;
    const urlParams = new URLSearchParams(window.location.search);
    const splatUrl  = urlParams.get('splat');
    if (!splatUrl) return null;

    console.log('[splat] Auto-loading from URL param:', splatUrl);
    try {
        if (sceneSystem) {
            // Preferred path: register as a proper actor.
            return await splatActor.addSplatActorToSceneSystem(sceneSystem, {
                url:  splatUrl,
                name: 'PhotoScan',
            });
        }
        // Fallback: bare mesh, no actor wrapper.
        return await splatRenderer.addSplatToScene(scene, splatUrl);
    } catch (err) {
        console.error('[splat] failed to load:', err);
        return null;
    }
}
