import { createDDGIRTCompute } from './ddgiRTCompute.js';

// Feature-detect for the WebGPU `ray-query` extension. As of late 2025 the
// extension lives behind `chrome://flags/#enable-unsafe-webgpu` in Chromium
// and is not in any baseline WebGPU implementation. The names "ray-query"
// (Dawn / current Chromium) and "ray-tracing-acceleration-structure" (W3C
// proposal draft) both appear in flight; check both so the detect survives
// the eventual rename.
const RAY_QUERY_FEATURE_NAMES = ['ray-query', 'ray-tracing-acceleration-structure'];

function deviceHasRayQuery(device) {
    if (!device?.features) return false;
    for (const name of RAY_QUERY_FEATURE_NAMES) {
        if (device.features.has(name)) return true;
    }
    return false;
}

// Public: pass a WebGPURenderer (or just its backend.device) and get back a
// flat capability descriptor. Safe to call before any DDGI work starts; the
// caller can log the result and branch UI on it.
export function detectRayQuerySupport(rendererOrDevice) {
    const device = rendererOrDevice?.backend?.device
        ?? rendererOrDevice?.device
        ?? rendererOrDevice;
    const supported = deviceHasRayQuery(device);
    const featureName = supported
        ? RAY_QUERY_FEATURE_NAMES.find((n) => device.features.has(n)) ?? null
        : null;
    return {
        supported,
        featureName,
        // Useful for the debug overlay; reflects what the device actually
        // advertised, not what we asked for.
        advertisedFeatures: device?.features
            ? Array.from(device.features)
            : [],
    };
}

// Public factory: same call surface as createDDGIRTCompute today. When
// ray-query lands and a parallel implementation exists, swap the branch
// below to dispatch to it; every consumer keeps using this entry point.
export function createDDGIRayTracer(options) {
    const support = detectRayQuerySupport(options?.renderer);
    if (support.supported) {
        // Future: return createDDGIRTComputeRayQuery(options) once the
        // ray_query WGSL path is written. Today we still fall back to the
        // manual BVH so behaviour is identical until that work lands.
        if (!createDDGIRayTracer._loggedFallback) {
            createDDGIRayTracer._loggedFallback = true;
            console.info(
                `[DDGI] ray-query available (feature: ${support.featureName}) — ` +
                'using manual-BVH path until ray_query kernel ships'
            );
        }
    }
    const impl = createDDGIRTCompute(options);
    impl.rayTracerKind = support.supported ? 'manual-bvh-pending-ray-query' : 'manual-bvh';
    impl.rayQuerySupport = support;
    return impl;
}
