// src/runtime/colorSpace.js
//
// Apply the correct outputColorSpace to a freshly-constructed WebGPURenderer.
//
// WebGPURenderer defaults outputColorSpace to LinearSRGBColorSpace, which
// skips the linear→sRGB encode at the end of the pipeline. The browser then
// displays linear-light values as if they were already gamma-encoded,
// producing the "grey haze / no true black" look — most visible on splats and
// anything with deep blacks or vivid saturation. SuperSplat / antimatter15-
// viewer / mkkellogg all set SRGBColorSpace explicitly. ACES tone mapping
// (set elsewhere in main.js) produces linear-light HDR output, so the sRGB
// encode here is the correct final step before the framebuffer.
//
// Lives in its own module so the fix can ship without re-uploading the
// full 315 KB main.js. To wire up, add this single line in main.js right
// after the renderer block (after `renderer.shadowMap.type = …`):
//
//   import { applyCorrectColorSpace } from './src/runtime/colorSpace.js';
//   applyCorrectColorSpace(renderer);

import * as THREE from 'three';

/**
 * Set the renderer's outputColorSpace to sRGB. Idempotent — safe to call
 * multiple times. Logs a one-line confirmation to the console so the
 * fix is visible during validation.
 *
 * @param {THREE.WebGPURenderer | THREE.WebGLRenderer} renderer
 */
export function applyCorrectColorSpace(renderer) {
    if (!renderer) {
        console.warn('[colorSpace] no renderer provided; skip.');
        return;
    }
    const before = renderer.outputColorSpace;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    console.log(`[colorSpace] outputColorSpace: ${before} → ${renderer.outputColorSpace}`);
}
