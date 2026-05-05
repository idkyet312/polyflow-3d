// src/world/splat/splatRenderer.js
//
// Phase 1 spike: load a .splat file, render anisotropic 2D Gaussians via EWA
// splatting on instanced quads. No depth sort. No editor integration.
//
// Pipeline:
//   .splat ArrayBuffer
//     -> parseSplat() -> {positions, scales, colors, rotations} typed arrays
//     -> InstancedBufferGeometry (unit quad x N instance attribs)
//     -> MeshBasicNodeMaterial with TSL vertexNode + colorNode
//     -> THREE.Mesh, frustumCulled=false, renderOrder=100, depthWrite=false
//
// Goals:
//   - Drop a .splat URL into the scene -> see anisotropic Gaussians on screen.
//   - Proper EWA splatting math (correctly oriented ellipses, not point sprites).
// Non-goals (deferred to later phases):
//   - Depth sort. Splats render in file order; alpha blending is wrong but
//     the result still reads as the captured object. Phase 3 fixes this.
//   - Spherical harmonics view-dependent color (uses DC component only).
//   - LOD, frustum culling, performance toggles.
//   - Editor integration, persistence, SplatActor wrapper.
//
// References:
//   Kerbl et al. 2023, "3D Gaussian Splatting for Real-Time Radiance Field Rendering"
//   Zwicker 2001,      "Surface Splatting" (the J Jacobian derivation)

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
    Fn, attribute, uniform, varying,
    vec2, vec3, vec4, mat3, float,
    positionLocal, modelViewMatrix, cameraProjectionMatrix,
    dot, exp, max, sqrt, Discard,
} from 'three/tsl';
import { loadSplatAny } from './loaders/index.js';
import { attachDepthSort } from './depthSort.js';
import { configureSplatMaterialBlend, normalizeSplatBlendMode } from './blendMode.js';
import { getSplatRenderTuning } from './renderTuning.js';

// .splat byte layout: 32 bytes per splat, little-endian.
//   0..11   position xyz (3 x f32)
//   12..23  scale xyz    (3 x f32, already exp(log_scale))
//   24..27  color RGBA   (4 x u8, sRGB-encoded — see srgbToLinear below)
//   28..31  rotation xyzw(4 x u8, decode (b - 127.5) / 127.5)
const SPLAT_BYTES = 32;
const SH_C0 = 0.28209479177387814;

// .splat color bytes are sRGB-encoded by the antimatter15 converter (and
// by every other converter that targets antimatter15-viewer compatibility):
// after running the SH DC formula `0.5 + C0 * f_dc` to get a linear value,
// the converter applies the linear→sRGB transfer curve and quantizes to u8.
// We undo that here so the renderer fragment shader operates in linear-light
// space (where Gaussian alpha math is meaningful and where the renderer's
// outputColorSpace = SRGBColorSpace re-applies the sRGB encode at the end of
// the pipeline). Without this step, byte/255 is treated as linear, which
// double-gamma-corrects when paired with SRGBColorSpace output and gives
// desaturated, low-contrast colors with no true black.
//
// PLY and SOG already produce linear values (see loaders/{ply,sog}.js) so
// this lookup is .splat-format-only.
const SRGB_TO_LINEAR_LUT = (() => {
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
        const c = i / 255;
        lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return lut;
})();

// ---------------------------------------------------------------------
// Loader / parser
// ---------------------------------------------------------------------
export function parseSplat(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const count = (arrayBuffer.byteLength / SPLAT_BYTES) | 0;
    const positions = new Float32Array(count * 3);
    const scales    = new Float32Array(count * 3);
    const colors    = new Float32Array(count * 4);
    const rotations = new Float32Array(count * 4);

    for (let i = 0; i < count; i++) {
        const o = i * SPLAT_BYTES;
        positions[i * 3 + 0] = view.getFloat32(o,      true);
        positions[i * 3 + 1] = view.getFloat32(o + 4,  true);
        positions[i * 3 + 2] = view.getFloat32(o + 8,  true);
        scales[i * 3 + 0]    = view.getFloat32(o + 12, true);
        scales[i * 3 + 1]    = view.getFloat32(o + 16, true);
        scales[i * 3 + 2]    = view.getFloat32(o + 20, true);
        // RGB: sRGB→linear via LUT (see SRGB_TO_LINEAR_LUT above).
        // Alpha: keep linear — alpha is opacity, not perceptual.
        colors[i * 4 + 0]    = SRGB_TO_LINEAR_LUT[view.getUint8(o + 24)];
        colors[i * 4 + 1]    = SRGB_TO_LINEAR_LUT[view.getUint8(o + 25)];
        colors[i * 4 + 2]    = SRGB_TO_LINEAR_LUT[view.getUint8(o + 26)];
        colors[i * 4 + 3]    = view.getUint8(o + 27) / 255;
        rotations[i * 4 + 0] = (view.getUint8(o + 28) - 127.5) / 127.5;
        rotations[i * 4 + 1] = (view.getUint8(o + 29) - 127.5) / 127.5;
        rotations[i * 4 + 2] = (view.getUint8(o + 30) - 127.5) / 127.5;
        rotations[i * 4 + 3] = (view.getUint8(o + 31) - 127.5) / 127.5;
    }
    return { count, positions, scales, colors, rotations };
}

// Format-aware loader. Detects .splat, .ply, and .sog from extension/magic bytes
// and delegates to the matching parser; all return the same normalized shape.
// See `./loaders/index.js` for detection logic and `./loaders/{ply,sog}.js`
// for the per-format implementations.
export async function loadSplat(url) {
    return loadSplatAny(url);
}

// ---------------------------------------------------------------------
// Mesh builder
// ---------------------------------------------------------------------
export function buildSplatMesh({ count, positions, scales, colors, rotations, colorEncoding = 'linear_rgb' }, opts = {}) {
    const blendMode = normalizeSplatBlendMode(opts.blendMode);
    const tuning = getSplatRenderTuning(blendMode, opts.renderSettings);
    const evaluateRawDc = colorEncoding === 'fdc_raw';

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -1, -1, 0,   1, -1, 0,   1, 1, 0,   -1, 1, 0,
    ]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.instanceCount = count;
    geometry.setAttribute('splatPos', new THREE.InstancedBufferAttribute(positions, 3));
    geometry.setAttribute('splatScale', new THREE.InstancedBufferAttribute(scales, 3));
    geometry.setAttribute('splatColor', new THREE.InstancedBufferAttribute(colors, 4));
    geometry.setAttribute('splatRot', new THREE.InstancedBufferAttribute(rotations, 4));

    const uFocal = uniform(new THREE.Vector2(1, 1));
    const uViewport = uniform(new THREE.Vector2(1, 1));
    const uSplatRadius = uniform(tuning.radius);
    const uAlphaCutoff = uniform(tuning.alphaCutoff);
    const uAlphaScale = uniform(tuning.alphaScale);
    const uPremultiply = uniform(blendMode === 'reference' ? 1 : 0);

    const material = new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
    });
    configureSplatMaterialBlend(material, blendMode);

    const vQuad = varying(vec2(0, 0), 'vQuad');
    const vColor = varying(vec4(0, 0, 0, 0), 'vColor');

    material.vertexNode = Fn(() => {
        const sp = attribute('splatPos');
        const ssc = attribute('splatScale');
        const sc = attribute('splatColor');
        const sr = attribute('splatRot');

        const qn = sr.div(max(sqrt(dot(sr, sr)), float(0.0001)));

        const x = qn.x, y = qn.y, z = qn.z, w = qn.w;
        const R = mat3(
            vec3(float(1).sub(float(2).mul(y.mul(y).add(z.mul(z)))),
                float(2).mul(x.mul(y).add(w.mul(z))),
                float(2).mul(x.mul(z).sub(w.mul(y)))),
            vec3(float(2).mul(x.mul(y).sub(w.mul(z))),
                float(1).sub(float(2).mul(x.mul(x).add(z.mul(z)))),
                float(2).mul(y.mul(z).add(w.mul(x)))),
            vec3(float(2).mul(x.mul(z).add(w.mul(y))),
                float(2).mul(y.mul(z).sub(w.mul(x))),
                float(1).sub(float(2).mul(x.mul(x).add(y.mul(y))))),
        );

        const S2 = mat3(
            vec3(ssc.x.mul(ssc.x), 0, 0),
            vec3(0, ssc.y.mul(ssc.y), 0),
            vec3(0, 0, ssc.z.mul(ssc.z)),
        );
        const cov3D = R.mul(S2).mul(R.transpose());

        const viewPos = modelViewMatrix.mul(vec4(sp, 1.0));
        const tz = max(viewPos.z.negate(), 0.001);

        const J02 = uFocal.x.mul(viewPos.x).div(tz.mul(tz)).negate();
        const J12 = uFocal.y.mul(viewPos.y).div(tz.mul(tz)).negate();
        const J = mat3(
            vec3(uFocal.x.div(tz), 0, 0),
            vec3(0, uFocal.y.div(tz), 0),
            vec3(J02, J12, 0),
        );

        const W = mat3(modelViewMatrix.element(0).xyz, modelViewMatrix.element(1).xyz, modelViewMatrix.element(2).xyz);
        const T = J.mul(W);
        const C = T.mul(cov3D).mul(T.transpose());
        const a = C.element(0).x.add(0.3);
        const b = C.element(0).y;
        const c = C.element(1).y.add(0.3);

        const det = a.mul(c).sub(b.mul(b));
        const mid = a.add(c).mul(0.5);
        const disc = sqrt(max(mid.mul(mid).sub(det), 0.0));
        const lam1 = mid.add(disc);
        const lam2 = max(mid.sub(disc), 0.0);

        const v1 = vec2(b, lam1.sub(a));
        const v1Len = max(v1.length(), 1e-6);
        const major = v1.div(v1Len).mul(sqrt(lam1).mul(3.0));
        const minor = vec2(major.y.negate(), major.x).mul(sqrt(lam2).div(max(sqrt(lam1), 1e-6)));

        const clipCenter = cameraProjectionMatrix.mul(viewPos);
        const px2clip = vec2(2.0).div(uViewport).mul(clipCenter.w);
        const offsetClip = major.mul(positionLocal.x).add(minor.mul(positionLocal.y)).mul(px2clip);

        vQuad.assign(vec2(positionLocal.x, positionLocal.y).mul(uSplatRadius));
        if (evaluateRawDc) {
            vColor.assign(vec4(sc.rgb.mul(SH_C0).add(0.5).max(0.0), sc.a));
        } else {
            vColor.assign(sc);
        }

        return clipCenter.add(vec4(offsetClip.x, offsetClip.y, 0, 0));
    })();

    material.colorNode = Fn(() => {
        const r2 = dot(vQuad, vQuad);
        const raw = exp(r2.mul(-0.5)).mul(vColor.a).mul(uAlphaScale);
        Discard(raw.lessThan(uAlphaCutoff));
        const alpha = raw;
        return uPremultiply.greaterThan(0.5).select(
            vec4(vColor.rgb.mul(alpha), alpha),
            vec4(vColor.rgb, alpha),
        );
    })();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 100;
    mesh.name = 'SplatCloud';
    mesh.userData.splatBlendMode = blendMode;
    mesh.userData.splatRenderUniforms = {
        radius: uSplatRadius,
        alphaCutoff: uAlphaCutoff,
        alphaScale: uAlphaScale,
        premultiply: uPremultiply,
    };
    mesh.userData.splatRenderSettings = {
        blendMode,
        radius: tuning.radius,
        alphaCutoff: tuning.alphaCutoff,
    };

    mesh.onBeforeRender = (renderer, _scene, camera) => {
        const size = renderer.getSize(new THREE.Vector2());
        uFocal.value.set(
            camera.projectionMatrix.elements[0] * size.x * 0.5,
            camera.projectionMatrix.elements[5] * size.y * 0.5,
        );
        uViewport.value.copy(size);
    };

    if (opts.attachSort !== false) {
        attachDepthSort(mesh, { count, positions, scales, colors, rotations });
    }

    return mesh;
}

// ---------------------------------------------------------------------
// Convenience entry point
// ---------------------------------------------------------------------
export async function addSplatToScene(scene, url) {
    const data = await loadSplat(url);
    const mesh = buildSplatMesh(data);
    scene.add(mesh);
    console.log(`[splat] Added ${data.count.toLocaleString()} splats from ${url}`);
    return mesh;
}
