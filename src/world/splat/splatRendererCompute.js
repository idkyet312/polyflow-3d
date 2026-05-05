// src/world/splat/splatRendererCompute.js
//
// Phase 3b — splat renderer wired to GPU compute sort.
// Phase 4  — adds per-frame view-dependent SH evaluation (radiance fields).
//
// Architecture (per frame, in onBeforeRender, after camera-motion gate):
//
//   1. preprocessCompute (NEW, Phase 4)
//        For each real splat i (i < count):
//          - read raw f_dc + opacity from colorsStorage (or already-evaluated
//            linear RGB when colorEncoding='linear_rgb')
//          - if degree > 0: read SH bands 1..N from shCoeffsStorage
//            (direct: per-vertex coeffs / codebook: indirect via shLabelsStorage)
//          - compute view direction `dir = normalize(splatPos - camPosLocal)`
//          - eval SH polynomial; clamp01; write to frameColorsStorage
//   2. buildKeysCompute (Phase 3b — depth → sort key)
//   3. compareSwapCompute (Phase 3b — bitonic stages, ~231 dispatches at 1.5M)
//   4. Render: vertex shader reads frameColors[src] (already-evaluated RGBA)
//
// The frameColors buffer means SH evaluates ONCE per splat per frame, not
// 4× per quad corner. Camera-motion-gated like the sort, so an idle camera
// gets ZERO compute work.
//
// Pipeline: one preprocess compute kernel per mesh, baked at build time
// against the dataset's (degree, encoding, layout) combo. No in-shader
// branching on those — the JS-level if/else inside Fn() picks the right
// shader form once at material creation.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
    Fn, instanceIndex, uniform, varying, storage,
    vec2, vec3, vec4, mat3, float, uint,
    positionLocal, modelViewMatrix, cameraProjectionMatrix,
    dot, exp, max, sqrt, If,
} from 'three/tsl';

import { allocateSplatStorage, attachGpuSort } from './gpuSortBitonic.js';

// ---------------------------------------------------------------------------
// SH constants — Kerbl 2023 / 3DGS reference convention.
// ---------------------------------------------------------------------------
const SH_C0 = 0.28209479177387814;
const SH_C1 = 0.4886025119029199;
const SH_C2 = [
     1.0925484305920792,
    -1.0925484305920792,
     0.31539156525252005,
    -1.0925484305920792,
     0.5462742152960396,
];
const SH_C3 = [
    -0.5900435899266435,
     2.890611442640554,
    -0.4570457994644658,
     0.3731763325901154,
    -0.4570457994644658,
     1.445305721320277,
    -0.5900435899266435,
];

// SH coefficients per channel for each degree (excluding DC band 0).
const COEFFS_PER_CHANNEL = [0, 3, 8, 15];

const PREPROCESS_WORKGROUP_SIZE = 256;

/**
 * Build a TSL expression for the SH-evaluated linear RGB at a given splat.
 *
 * @param {number} degree    — SH degree (0..3)
 * @param {*}      fdcOrRgb  — vec3 node (either raw f_dc OR final linear RGB)
 * @param {string} encoding  — 'fdc_raw' | 'linear_rgb'
 * @param {*}      dir       — vec3 node (normalized view direction)
 * @param {(k:number)=>*} getCoeff  — factory: returns the vec3 node for the
 *                                    k-th SH coefficient (k ∈ [0, K)) of the
 *                                    current splat. Only invoked for k < K(degree).
 * @returns {*} vec3 expression for unclamped final RGB.
 */
function evaluateSh(degree, fdcOrRgb, encoding, dir, getCoeff) {
    if (encoding === 'linear_rgb') {
        // Already-evaluated colour. Bypass DC formula AND SH bands.
        return fdcOrRgb;
    }

    // DC band: standard formula `0.5 + SH_C0 * f_dc`.
    let rgb = vec3(0.5).add(fdcOrRgb.mul(float(SH_C0)));
    if (degree <= 0) return rgb;

    // Cache direction components; reuse across bands.
    const x = dir.x;
    const y = dir.y;
    const z = dir.z;

    // Band 1.
    rgb = rgb.add(getCoeff(0).mul(float(-SH_C1)).mul(y));
    rgb = rgb.add(getCoeff(1).mul(float( SH_C1)).mul(z));
    rgb = rgb.add(getCoeff(2).mul(float(-SH_C1)).mul(x));
    if (degree <= 1) return rgb;

    // Band 2.
    const xx = x.mul(x);
    const yy = y.mul(y);
    const zz = z.mul(z);
    const xy = x.mul(y);
    const yz = y.mul(z);
    const xz = x.mul(z);
    rgb = rgb.add(getCoeff(3).mul(float(SH_C2[0])).mul(xy));
    rgb = rgb.add(getCoeff(4).mul(float(SH_C2[1])).mul(yz));
    rgb = rgb.add(getCoeff(5).mul(float(SH_C2[2])).mul(zz.mul(2).sub(xx).sub(yy)));
    rgb = rgb.add(getCoeff(6).mul(float(SH_C2[3])).mul(xz));
    rgb = rgb.add(getCoeff(7).mul(float(SH_C2[4])).mul(xx.sub(yy)));
    if (degree <= 2) return rgb;

    // Band 3.
    rgb = rgb.add(getCoeff( 8).mul(float(SH_C3[0])).mul(y).mul(xx.mul(3).sub(yy)));
    rgb = rgb.add(getCoeff( 9).mul(float(SH_C3[1])).mul(xy).mul(z));
    rgb = rgb.add(getCoeff(10).mul(float(SH_C3[2])).mul(y).mul(zz.mul(4).sub(xx).sub(yy)));
    rgb = rgb.add(getCoeff(11).mul(float(SH_C3[3])).mul(z).mul(zz.mul(2).sub(xx.mul(3)).sub(yy.mul(3))));
    rgb = rgb.add(getCoeff(12).mul(float(SH_C3[4])).mul(x).mul(zz.mul(4).sub(xx).sub(yy)));
    rgb = rgb.add(getCoeff(13).mul(float(SH_C3[5])).mul(z).mul(xx.sub(yy)));
    rgb = rgb.add(getCoeff(14).mul(float(SH_C3[6])).mul(x).mul(xx.sub(yy.mul(3))));
    return rgb;
}

/**
 * Compile + return the preprocess compute kernel for the dataset's
 * (encoding, degree, layout) combo. The kernel reads positions/colors/sh-coefs
 * and writes per-frame RGBA to frameColorsStorage.
 *
 * Out-of-range threads (i >= N) early-exit; only real splats get a write.
 */
function buildPreprocessKernel(slot, uCameraPosLocal) {
    const N        = slot.count;
    const encoding = slot.colorEncoding;
    const degree   = slot.shDegree | 0;
    const layout   = slot.shLayout;
    const K        = COEFFS_PER_CHANNEL[degree] | 0;

    // Storage bindings (one set per kernel — three.js allocates per-pipeline bind groups).
    const positionsNode  = storage(slot.positionsStorage,    'vec3');
    const colorsNode     = storage(slot.colorsStorage,       'vec4');
    const frameColorsOut = storage(slot.frameColorsStorage,  'vec4');
    const shCoeffsNode   = (degree > 0 && slot.shCoeffsStorage)
        ? storage(slot.shCoeffsStorage, 'vec3') : null;
    const shLabelsNode   = (degree > 0 && layout === 'codebook' && slot.shLabelsStorage)
        ? storage(slot.shLabelsStorage, 'uint') : null;

    return Fn(() => {
        const i = instanceIndex;

        // Bounds: skip padded threads (we over-dispatch ⌈N/256⌉ workgroups).
        If(i.lessThan(uint(N)), () => {
            const sc = colorsNode.element(i);                    // vec4 — RGB + alpha
            let rgb;

            if (degree > 0 && shCoeffsNode !== null) {
                // View direction in mesh-local space (positions are local).
                const splatPos = positionsNode.element(i);
                const dir      = splatPos.sub(uCameraPosLocal).normalize();

                // Per-coefficient lookup, baked at kernel-creation time.
                let getCoeff;
                if (layout === 'direct') {
                    // coeffs[i*K + k] (vec3 element addressing)
                    const baseIdx = i.mul(uint(K));
                    getCoeff = (k) => shCoeffsNode.element(baseIdx.add(uint(k)));
                } else {
                    // codebook layout: coeffs[labels[i] * K + k]
                    const cbIdx   = shLabelsNode.element(i);
                    const baseIdx = cbIdx.mul(uint(K));
                    getCoeff = (k) => shCoeffsNode.element(baseIdx.add(uint(k)));
                }

                rgb = evaluateSh(degree, sc.rgb, encoding, dir, getCoeff);
            } else if (encoding === 'fdc_raw') {
                // DC-only, no SH bands. Same as deg-0 of the SH eval.
                rgb = vec3(0.5).add(sc.rgb.mul(float(SH_C0)));
            } else {
                // linear_rgb pass-through.
                rgb = sc.rgb;
            }

            rgb = rgb.clamp(0.0, 1.0);
            frameColorsOut.element(i).assign(vec4(rgb, sc.a));
        });
    })().compute(N, [PREPROCESS_WORKGROUP_SIZE]);
}

/**
 * Build a splat mesh that uses GPU compute for both sort AND per-frame
 * view-dependent SH evaluation.
 *
 * @param {{count, positions, scales, colors, rotations,
 *          colorEncoding?, sh?:{degree, layout, coeffs, codebookSize?, labels?}}} splatData
 * @returns {THREE.Mesh}
 */
export function buildSplatMeshCompute(splatData) {
    const slot = allocateSplatStorage(splatData);
    const N    = slot.count;

    // Geometry: unit quad in [-1,1]² — same as the attribute-based renderer.
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -1, -1, 0,   1, -1, 0,   1, 1, 0,   -1, 1, 0,
    ]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.instanceCount = N;            // cap rendering at real splats

    // Camera-derived uniforms (refreshed each frame in onBeforeRender).
    const uFocal           = uniform(new THREE.Vector2(1, 1));
    const uViewport        = uniform(new THREE.Vector2(1, 1));
    const uCameraPosLocal  = uniform(new THREE.Vector3(0, 0, 0));     // for SH dir

    const material = new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite:  false,
        depthTest:   true,
        side:        THREE.DoubleSide,
        blending:    THREE.NormalBlending,
    });

    // Cross-stage varyings.
    const vQuad  = varying(vec2(0, 0), 'vQuad');
    const vColor = varying(vec4(0, 0, 0, 0), 'vColor');

    // Vertex shader storage bindings: positions/scales/rotations + the new
    // per-frame frameColors (already SH-evaluated by the preprocess pass).
    const positionsNode   = storage(slot.positionsStorage,     'vec3');
    const scalesNode      = storage(slot.scalesStorage,        'vec3');
    const rotationsNode   = storage(slot.rotationsStorage,     'vec4');
    const indicesNode     = storage(slot.sortedIndicesStorage, 'uint');
    const frameColorsNode = storage(slot.frameColorsStorage,   'vec4');

    material.vertexNode = Fn(() => {
        // Indirection: instanceIndex → sorted source index → splat data.
        const src = indicesNode.element(instanceIndex);

        const sp  = positionsNode.element(src);
        const ssc = scalesNode.element(src);
        const sr  = rotationsNode.element(src);
        const sc  = frameColorsNode.element(src);   // already SH-evaluated RGBA

        // Quaternion-normalize.
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
        const tz      = max(viewPos.z.negate(), 0.001);

        const J02 = uFocal.x.mul(viewPos.x).div(tz.mul(tz)).negate();
        const J12 = uFocal.y.mul(viewPos.y).div(tz.mul(tz)).negate();
        const J = mat3(
            vec3(uFocal.x.div(tz), 0, 0),
            vec3(0, uFocal.y.div(tz), 0),
            vec3(J02, J12, 0),
        );

        const W = mat3(
            modelViewMatrix.element(0).xyz,
            modelViewMatrix.element(1).xyz,
            modelViewMatrix.element(2).xyz,
        );
        const T = J.mul(W);
        const C = T.mul(cov3D).mul(T.transpose());
        const a = C.element(0).x.add(0.3);
        const b = C.element(0).y;
        const c = C.element(1).y.add(0.3);

        const det  = a.mul(c).sub(b.mul(b));
        const mid  = a.add(c).mul(0.5);
        const disc = sqrt(max(mid.mul(mid).sub(det), 0.0));
        const lam1 = mid.add(disc);
        const lam2 = max(mid.sub(disc), 0.0);

        const v1     = vec2(b, lam1.sub(a));
        const v1Len  = max(v1.length(), 1e-6);
        const major  = v1.div(v1Len).mul(sqrt(lam1).mul(3.0));
        const minor  = vec2(major.y.negate(), major.x).mul(sqrt(lam2).div(max(sqrt(lam1), 1e-6)));

        const clipCenter = cameraProjectionMatrix.mul(viewPos);
        const px2clip    = vec2(2.0).div(uViewport).mul(clipCenter.w);
        const offsetClip = major.mul(positionLocal.x).add(minor.mul(positionLocal.y)).mul(px2clip);

        vQuad.assign(vec2(positionLocal.x, positionLocal.y).mul(3.0));
        vColor.assign(sc);    // frameColors is already linear RGB + alpha

        return clipCenter.add(vec4(offsetClip.x, offsetClip.y, 0, 0));
    })();

    material.colorNode = Fn(() => {
        // 2D Gaussian: alpha = alpha_splat * exp(-0.5 * ||vQuad||²).
        const r2    = dot(vQuad, vQuad);
        const raw   = exp(r2.mul(-0.5)).mul(vColor.a);
        const alpha = raw.sub(0.004).max(0);
        return vec4(vColor.rgb, alpha);
    })();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder   = 100;
    mesh.name          = `SplatCloud (compute, ${slot.colorEncoding}, sh${slot.shDegree})`;
    mesh.userData.splat = slot;       // expose storage buffers for attachGpuSort

    // Build the preprocess compute kernel — one per mesh, baked against the
    // dataset's (degree, encoding, layout). For datasets where SH eval is
    // camera-INDEPENDENT (degree 0, or linear_rgb), we still build a kernel
    // but only run it ONCE at init.
    const preprocessCompute = buildPreprocessKernel(slot, uCameraPosLocal);
    const isViewDependent   = slot.shDegree > 0 && slot.colorEncoding === 'fdc_raw';

    let lastCamLocal = null;
    let preprocessRanOnce = false;
    const _camWorld   = new THREE.Vector3();
    const _camLocal   = new THREE.Vector3();
    const _invMatrix  = new THREE.Matrix4();

    mesh.onBeforeRender = (renderer, _scene, camera) => {
        // Camera-derived uniforms.
        const size = renderer.getSize(new THREE.Vector2());
        uFocal.value.set(
            camera.projectionMatrix.elements[0] * size.x * 0.5,
            camera.projectionMatrix.elements[5] * size.y * 0.5,
        );
        uViewport.value.copy(size);

        // Camera position in MESH-LOCAL space (so the SH eval direction is in
        // the local frame, matching how the splat data was trained / exported).
        camera.getWorldPosition(_camWorld);
        _invMatrix.copy(mesh.matrixWorld).invert();
        _camLocal.copy(_camWorld).applyMatrix4(_invMatrix);
        uCameraPosLocal.value.copy(_camLocal);

        // Preprocess gate: every frame for view-dependent SH; just once at
        // init for camera-independent paths (linear_rgb or deg 0).
        let shouldRun = false;
        if (!preprocessRanOnce) {
            shouldRun = true;
            preprocessRanOnce = true;
        } else if (isViewDependent) {
            const moveSq = (lastCamLocal === null)
                ? Infinity
                : _camLocal.distanceToSquared(lastCamLocal);
            shouldRun = moveSq > 0.0001;     // same threshold as bitonic sort
        }

        if (shouldRun) {
            renderer.compute(preprocessCompute);
            if (!lastCamLocal) lastCamLocal = new THREE.Vector3();
            lastCamLocal.copy(_camLocal);
        }
    };

    // Attach GPU sort. attachGpuSort wraps onBeforeRender so the sort
    // dispatches run AFTER the preprocess (sort doesn't depend on color).
    attachGpuSort(mesh, splatData);

    return mesh;
}
