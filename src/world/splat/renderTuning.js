import { configureSplatMaterialBlend, normalizeSplatBlendMode } from './blendMode.js';

export const SPLAT_REFERENCE_TUNING = Object.freeze({
    radius: 2.55,
    alphaCutoff: 1 / 255,
    alphaScale: 0.92,
});

export const SPLAT_POLYFLOW_TUNING = Object.freeze({
    radius: 3.0,
    alphaCutoff: 0.004,
    alphaScale: 1.0,
});

export const SPLAT_RADIUS_RANGE = Object.freeze({ min: 0.5, max: 8.0 });
export const SPLAT_ALPHA_CUTOFF_RANGE = Object.freeze({ min: 0.0, max: 0.2 });

function clampFinite(value, min, max, fallback) {
    return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
}

export function getSplatRenderTuning(blendMode, overrides = null) {
    const normalizedBlendMode = normalizeSplatBlendMode(blendMode);
    const base = normalizedBlendMode === 'reference' ? SPLAT_REFERENCE_TUNING : SPLAT_POLYFLOW_TUNING;
    if (!overrides) {
        return { blendMode: normalizedBlendMode, ...base };
    }

    return {
        blendMode: normalizedBlendMode,
        radius: clampFinite(overrides.radius, SPLAT_RADIUS_RANGE.min, SPLAT_RADIUS_RANGE.max, base.radius),
        alphaCutoff: clampFinite(overrides.alphaCutoff, SPLAT_ALPHA_CUTOFF_RANGE.min, SPLAT_ALPHA_CUTOFF_RANGE.max, base.alphaCutoff),
        alphaScale: base.alphaScale,
    };
}

export function normalizeSplatRenderSettings(settings = {}, fallbackBlendMode = 'reference') {
    const blendMode = normalizeSplatBlendMode(settings?.blendMode || fallbackBlendMode);
    return getSplatRenderTuning(blendMode, settings);
}

export function applySplatRenderSettings(mesh, settings = {}, opts = {}) {
    if (!mesh) return null;

    const current = mesh.userData?.splatRenderSettings || {};
    const requestedBlendMode = settings?.blendMode || current.blendMode || mesh.userData?.splatBlendMode || 'reference';
    const nextInput = opts.resetToPreset
        ? { ...settings, blendMode: requestedBlendMode }
        : { ...current, ...settings, blendMode: requestedBlendMode };
    const next = normalizeSplatRenderSettings(nextInput, requestedBlendMode);

    const uniforms = mesh.userData?.splatRenderUniforms || null;
    if (uniforms?.radius) uniforms.radius.value = next.radius;
    if (uniforms?.alphaCutoff) uniforms.alphaCutoff.value = next.alphaCutoff;
    if (uniforms?.alphaScale) uniforms.alphaScale.value = next.alphaScale;
    if (uniforms?.premultiply) uniforms.premultiply.value = next.blendMode === 'reference' ? 1 : 0;

    configureSplatMaterialBlend(mesh.material, next.blendMode);
    mesh.userData.splatBlendMode = next.blendMode;
    mesh.userData.splatRenderSettings = {
        blendMode: next.blendMode,
        radius: next.radius,
        alphaCutoff: next.alphaCutoff,
    };

    return mesh.userData.splatRenderSettings;
}
