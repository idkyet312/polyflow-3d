// src/world/splat/splatRendererCompute.js
//
// Phase 3b — splat renderer wired to GPU compute sort.
//
// Mirror of splatRenderer.js's buildSplatMesh, but instead of feeding the
// vertex shader 4 InstancedBufferAttributes, we feed it 4 StorageBuffers +
// a sortedIndices buffer (written by gpuSortBitonic.js's compute pass).
//
// The vertex shader fetches per-instance data via:
//   src   = sortedIndices[instanceIndex]    // u32 — sort permutation
//   pos   = positions[src]                  // vec3
//   scale = scales[src]                     // vec3
//   color = colors[src]                     // vec4
//   rot   = rotations[src]                  // vec4
//
// instanceIndex iterates 0..countPadded but the dispatch only renders count
// real instances (padding entries are placed at the tail of sortedIndices by
// the sort kernel and would self-cull via depth, but we cap with
// `geometry.instanceCount = count` to avoid drawing them at all).
//
// EWA math, color space handling, and the AA + alpha-tail fixes from
// splatRenderer.js are reproduced verbatim here. Only the data-fetch
// strategy differs.
//
// All other behavior (depthWrite=false, depthTest=true, NormalBlending,
// renderOrder=100, frustumCulled=false) matches the original to keep the
// integration drop-in.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
    Fn, instanceIndex, uniform, varying, storage,
    vec2, vec3, vec4, mat3, float, uint,
    positionLocal, modelViewMatrix, modelWorldMatrix, cameraProjectionMatrix, cameraPosition,
    dot, exp, max, sqrt, Discard,
    unpackHalf2x16,
} from 'three/tsl';

import { allocateSplatStorage, attachGpuSort } from './gpuSortBitonic.js';
import { configureSplatMaterialBlend, normalizeSplatBlendMode } from './blendMode.js';
import { getSplatRenderTuning } from './renderTuning.js';

const SH_C0 = 0.28209479177387814;
const SH_C1 = 0.4886025119029199;
const SH_C2 = [1.0925484305920792, -1.0925484305920792, 0.31539156525252005, -1.0925484305920792, 0.5462742152960396];
const SH_C3 = [-0.5900435899266435, 2.890611442640554, -0.4570457994644658, 0.3731763325901154, -0.4570457994644658, 1.445305721320277, -0.5900435899266435];

/**
 * Build a splat mesh that uses GPU compute sorting.
 *
 * @param {{count:number, positions:Float32Array, scales:Float32Array, colors:Float32Array, rotations:Float32Array}} splatData
 * @returns {THREE.Mesh}
 */
export function buildSplatMeshCompute(splatData, opts = {}) {
    const blendMode = normalizeSplatBlendMode(opts.blendMode);
    const tuning = getSplatRenderTuning(blendMode, opts.renderSettings);
    const requestedShDegree = Number.isFinite(opts.shDegree) ? opts.shDegree : 0;
    const slot = allocateSplatStorage(splatData, { shDegree: requestedShDegree });
    const N    = slot.count;
    const shDegree = slot.shDegree || 0;
    const shPackedU32PerSplat = slot.shPackedU32PerSplat || 0;
    const shPackedU32PerChannelSplat = slot.shPackedU32PerChannelSplat || 0;
    const shPackedU32PerEntry = slot.shPackedU32PerEntry || 0;
    const shLayout = slot.shLayout || '';
    const colorEncoding = splatData.colorEncoding || 'linear_rgb';
    const evaluateRawDc = colorEncoding === 'fdc_raw';

    // Geometry: unit quad in [-1,1]² — same as the attribute-based renderer.
    // We don't actually need ANY per-instance attribute on the geometry in
    // the storage path, but Three.js still wants an InstancedBufferGeometry
    // to know the instance count, so we build one with no instance attribs.
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -1, -1, 0,   1, -1, 0,   1, 1, 0,   -1, 1, 0,
    ]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.instanceCount = N;            // cap rendering at real splats; padding never drawn

    // Camera-derived uniforms (refreshed each frame in onBeforeRender).
    const uFocal    = uniform(new THREE.Vector2(1, 1));
    const uViewport = uniform(new THREE.Vector2(1, 1));
    const uSplatRadius = uniform(tuning.radius);
    const uAlphaCutoff = uniform(tuning.alphaCutoff);
    const uAlphaScale = uniform(tuning.alphaScale);
    const uPremultiply = uniform(blendMode === 'reference' ? 1 : 0);

    const material = new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite:  false,
        depthTest:   true,
        side:        THREE.DoubleSide,
    });
    configureSplatMaterialBlend(material, blendMode);

    // Cross-stage varyings.
    const vQuad  = varying(vec2(0, 0), 'vQuad');
    const vColor = varying(vec4(0, 0, 0, 0), 'vColor');

    // Wrap StorageInstancedBufferAttribute objects with TSL storage() nodes
    // so they can be indexed inside the vertex shader.
    const positionsNode = storage(slot.positionsStorage, 'vec3', N).toReadOnly();
    const scalesNode    = storage(slot.scalesStorage,    'vec3', N).toReadOnly();
    const colorsNode    = storage(slot.colorsStorage,    'vec4', N).toReadOnly();
    const rotationsNode = storage(slot.rotationsStorage, 'vec4', N).toReadOnly();
    const indicesNode   = storage(slot.sortedIndicesStorage, 'uint', slot.countPadded).toReadOnly();
    const shNode = slot.shStorage
        ? storage(slot.shStorage, 'uint', N * shPackedU32PerSplat).toReadOnly()
        : null;
    const shNodeR = slot.shStorageR
        ? storage(slot.shStorageR, 'uint', N * shPackedU32PerChannelSplat).toReadOnly()
        : null;
    const shNodeG = slot.shStorageG
        ? storage(slot.shStorageG, 'uint', N * shPackedU32PerChannelSplat).toReadOnly()
        : null;
    const shNodeB = slot.shStorageB
        ? storage(slot.shStorageB, 'uint', N * shPackedU32PerChannelSplat).toReadOnly()
        : null;
    const shCodebookNode = slot.shCodebookStorage
        ? storage(slot.shCodebookStorage, 'uint', Math.max(1, slot.shCodebookSize * shPackedU32PerEntry)).toReadOnly()
        : null;
    const shLabelsNode = slot.shLabelsStorage
        ? storage(slot.shLabelsStorage, 'uint', N).toReadOnly()
        : null;

    function readShCoeff(src, coeffIndex) {
        if (shLayout === 'planar') {
            return vec3(
                readShChannelCoeff(shNodeR, src, coeffIndex),
                readShChannelCoeff(shNodeG, src, coeffIndex),
                readShChannelCoeff(shNodeB, src, coeffIndex),
            );
        }
        if (shLayout === 'codebook') {
            const label = shLabelsNode.element(src);
            const packedBase = label.mul(uint(shPackedU32PerEntry));
            const halfIndex = coeffIndex * 3;
            const pair0 = Math.floor(halfIndex / 2);
            const lanes0 = unpackHalf2x16(shCodebookNode.element(packedBase.add(uint(pair0))));
            const lanes1 = unpackHalf2x16(shCodebookNode.element(packedBase.add(uint(pair0 + 1))));
            return (halfIndex & 1) === 0
                ? vec3(lanes0.x, lanes0.y, lanes1.x)
                : vec3(lanes0.y, lanes1.x, lanes1.y);
        }
        const packedBase = src.mul(uint(shPackedU32PerSplat));
        const halfIndex = coeffIndex * 3;
        const pair0 = Math.floor(halfIndex / 2);
        const lanes0 = unpackHalf2x16(shNode.element(packedBase.add(uint(pair0))));
        const lanes1 = unpackHalf2x16(shNode.element(packedBase.add(uint(pair0 + 1))));
        return (halfIndex & 1) === 0
            ? vec3(lanes0.x, lanes0.y, lanes1.x)
            : vec3(lanes0.y, lanes1.x, lanes1.y);
    }

    function readShChannelCoeff(node, src, coeffIndex) {
        const packedBase = src.mul(uint(shPackedU32PerChannelSplat));
        const lanes = unpackHalf2x16(node.element(packedBase.add(uint(Math.floor(coeffIndex / 2)))));
        return (coeffIndex & 1) === 0 ? lanes.x : lanes.y;
    }

    material.vertexNode = Fn(() => {
        // Indirection: instanceIndex → src splat index via sortedIndices.
        const src = indicesNode.element(instanceIndex);

        const sp  = positionsNode.element(src);
        const ssc = scalesNode.element(src);
        const sc  = colorsNode.element(src);
        const sr  = rotationsNode.element(src);

        // Same quaternion-normalize pattern as the attribute path. .splat
        // byte-quantized rotations aren't unit; PLY/SOG drift via FP rounding.
        const qn = sr.div(max(sqrt(dot(sr, sr)), float(0.0001)));

        // Quaternion (x,y,z,w) → 3x3 rotation matrix.
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

        // Sigma_3D = R * S² * Rᵀ
        const S2 = mat3(
            vec3(ssc.x.mul(ssc.x), 0, 0),
            vec3(0, ssc.y.mul(ssc.y), 0),
            vec3(0, 0, ssc.z.mul(ssc.z)),
        );
        const cov3D = R.mul(S2).mul(R.transpose());

        // Splat center: world → view → clip.
        const viewPos = modelViewMatrix.mul(vec4(sp, 1.0));
        const tz      = max(viewPos.z.negate(), 0.001);

        // Jacobian J of perspective projection (Zwicker 2001).
        const J02 = uFocal.x.mul(viewPos.x).div(tz.mul(tz)).negate();
        const J12 = uFocal.y.mul(viewPos.y).div(tz.mul(tz)).negate();
        const J = mat3(
            vec3(uFocal.x.div(tz), 0, 0),
            vec3(0, uFocal.y.div(tz), 0),
            vec3(J02, J12, 0),
        );

        // 2D screen-space covariance: T * Sigma_3D * Tᵀ, T = J * W.
        const W = mat3(
            modelViewMatrix.element(0).xyz,
            modelViewMatrix.element(1).xyz,
            modelViewMatrix.element(2).xyz,
        );
        const T = J.mul(W);
        const C = T.mul(cov3D).mul(T.transpose());
        const a = C.element(0).x.add(0.3);                  // 0.3 = AA low-pass regularization
        const b = C.element(0).y;
        const c = C.element(1).y.add(0.3);

        // Eigendecomposition of [[a,b],[b,c]].
        const det  = a.mul(c).sub(b.mul(b));
        const mid  = a.add(c).mul(0.5);
        const disc = sqrt(max(mid.mul(mid).sub(det), 0.0));
        const lam1 = mid.add(disc);
        const lam2 = max(mid.sub(disc), 0.0);

        // Major / minor axes in screen pixels, sized to 3 sigmas.
        const v1     = vec2(b, lam1.sub(a));
        const v1Len  = max(v1.length(), 1e-6);
        const major  = v1.div(v1Len).mul(sqrt(lam1).mul(3.0));
        const minor  = vec2(major.y.negate(), major.x).mul(sqrt(lam2).div(max(sqrt(lam1), 1e-6)));

        // Project center to clip, expand quad along (major, minor).
        const clipCenter = cameraProjectionMatrix.mul(viewPos);
        const px2clip    = vec2(2.0).div(uViewport).mul(clipCenter.w);
        const offsetClip = major.mul(positionLocal.x).add(minor.mul(positionLocal.y)).mul(px2clip);

        // Pass to fragment.
        let outColor = sc;
        if (evaluateRawDc) {
            const rgb = sc.rgb.mul(SH_C0).toVar();
            if (shDegree > 0 && (shNode || shNodeR || shCodebookNode)) {
            const worldPos = modelWorldMatrix.mul(vec4(sp, 1.0)).xyz;
            const dir = worldPos.sub(cameraPosition).normalize();
            const x = dir.x;
            const y = dir.y;
            const z = dir.z;
            const xx = x.mul(x);
            const yy = y.mul(y);
            const zz = z.mul(z);
            if (shDegree >= 1) {
                rgb.addAssign(readShCoeff(src, 0).mul(y.mul(-SH_C1)));
                rgb.addAssign(readShCoeff(src, 1).mul(z.mul(SH_C1)));
                rgb.addAssign(readShCoeff(src, 2).mul(x.mul(-SH_C1)));
            }
            if (shDegree >= 2) {
                rgb.addAssign(readShCoeff(src, 3).mul(x.mul(y).mul(SH_C2[0])));
                rgb.addAssign(readShCoeff(src, 4).mul(y.mul(z).mul(SH_C2[1])));
                rgb.addAssign(readShCoeff(src, 5).mul(zz.mul(2.0).sub(xx).sub(yy).mul(SH_C2[2])));
                rgb.addAssign(readShCoeff(src, 6).mul(x.mul(z).mul(SH_C2[3])));
                rgb.addAssign(readShCoeff(src, 7).mul(xx.sub(yy).mul(SH_C2[4])));
            }
            if (shDegree >= 3) {
                rgb.addAssign(readShCoeff(src, 8).mul(y.mul(xx.mul(3.0).sub(yy)).mul(SH_C3[0])));
                rgb.addAssign(readShCoeff(src, 9).mul(x.mul(y).mul(z).mul(SH_C3[1])));
                rgb.addAssign(readShCoeff(src, 10).mul(y.mul(zz.mul(4.0).sub(xx).sub(yy)).mul(SH_C3[2])));
                rgb.addAssign(readShCoeff(src, 11).mul(z.mul(zz.mul(2.0).sub(xx.mul(3.0)).sub(yy.mul(3.0))).mul(SH_C3[3])));
                rgb.addAssign(readShCoeff(src, 12).mul(x.mul(zz.mul(4.0).sub(xx).sub(yy)).mul(SH_C3[4])));
                rgb.addAssign(readShCoeff(src, 13).mul(z.mul(xx.sub(yy)).mul(SH_C3[5])));
                rgb.addAssign(readShCoeff(src, 14).mul(x.mul(xx.sub(yy.mul(3.0))).mul(SH_C3[6])));
            }
            }
            outColor = vec4(rgb.add(0.5).max(0.0), sc.a);
        }

        vQuad.assign(vec2(positionLocal.x, positionLocal.y).mul(uSplatRadius));
        vColor.assign(outColor);

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
    mesh.renderOrder   = 100;
    mesh.name          = 'SplatCloud (compute)';
    mesh.userData.splat = slot;       // make storage buffers discoverable for attachGpuSort
    mesh.userData.splatSortMode = 'compute';
    mesh.userData.splatSortStatus = 'identity';
    mesh.userData.splatSortError = '';
    mesh.userData.splatShDegree = shDegree;
    mesh.userData.splatShMaxDegree = splatData.sh?.degree || 0;
    mesh.userData.splatShBytes = slot.shBytes || 0;
    mesh.userData.splatShFallbackReason = slot.shFallbackReason || '';
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

    // Keep camera-derived uniforms fresh.
    mesh.onBeforeRender = (renderer, _scene, camera) => {
        const size = renderer.getSize(new THREE.Vector2());
        uFocal.value.set(
            camera.projectionMatrix.elements[0] * size.x * 0.5,
            camera.projectionMatrix.elements[5] * size.y * 0.5,
        );
        uViewport.value.copy(size);
    };

    // Attach GPU sort. attachGpuSort wraps onBeforeRender and adds the sort
    // dispatch BEFORE the frame's draw call.
    attachGpuSort(mesh, splatData);

    return mesh;
}
