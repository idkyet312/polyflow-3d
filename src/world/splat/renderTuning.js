export const SPLAT_REFERENCE_TUNING = {
    radius: 2.55,
    alphaCutoff: 0.018,
    alphaScale: 0.92,
};

export const SPLAT_POLYFLOW_TUNING = {
    radius: 3.0,
    alphaCutoff: 0.004,
    alphaScale: 1.0,
};

export function getSplatRenderTuning(blendMode) {
    return blendMode === 'reference' ? SPLAT_REFERENCE_TUNING : SPLAT_POLYFLOW_TUNING;
}
