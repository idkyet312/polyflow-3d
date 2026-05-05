import * as THREE from 'three';

export const SPLAT_BLEND_MODES = ['reference', 'polyflow'];

export function normalizeSplatBlendMode(mode) {
    return SPLAT_BLEND_MODES.includes(mode) ? mode : 'reference';
}

export function configureSplatMaterialBlend(material, mode) {
    const blendMode = normalizeSplatBlendMode(mode);
    material.userData.splatBlendMode = blendMode;
    material.toneMapped = false;
    material.premultipliedAlpha = false;

    if (blendMode === 'reference') {
        material.blending = THREE.CustomBlending;
        material.blendEquation = THREE.AddEquation;
        material.blendEquationAlpha = THREE.AddEquation;
        material.blendSrc = THREE.OneFactor;
        material.blendDst = THREE.OneMinusSrcAlphaFactor;
        material.blendSrcAlpha = THREE.OneFactor;
        material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
        return;
    }

    material.blending = THREE.NormalBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendEquationAlpha = null;
    material.blendSrc = THREE.SrcAlphaFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = null;
    material.blendDstAlpha = null;
}
