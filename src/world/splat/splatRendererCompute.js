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
    vec2, vec3, vec4, mat3, float,
    positionLocal, modelViewMatrix, cameraProjectionMatrix,
    dot, exp, max, sqrt,
} from 'three/tsl';

import { allocateSplatStorage, attachGpuSort } from './gpuSortBitonic.js';

/**
 * Build a splat mesh that uses GPU compute sorting.
 *
 * @param {{count:number, positions:Float32Array, scales:Float32Array, colors:Float32Array, rotations:Float32Array}} splatData
 * @returns {THREE.Mesh}
 */
export function buildSplatMeshCompute(splatData) {
    const slot = allocateSplatStorage(splatData);
    const N    = slot.count;

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

    // Wrap StorageInstancedBufferAttribute objects with TSL storage() nodes
    // so they can be indexed inside the vertex shader.
    const positionsNode = storage(slot.positionsStorage, 'vec3');
    const scalesNode    = storage(slot.scalesStorage,    'vec3');
    const colorsNode    = storage(slot.colorsStorage,    'vec4');
    const rotationsNode = storage(slot.rotationsStorage, 'vec4');
    const indicesNode   = storage(slot.sortedIndicesStorage, 'uint');

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
        vQuad.assign(vec2(positionLocal.x, positionLocal.y).mul(3.0));   // 3 → squared Mahalanobis at corner
        vColor.assign(sc);

        return clipCenter.add(vec4(offsetClip.x, offsetClip.y, 0, 0));
    })();

    material.colorNode = Fn(() => {
        // 2D Gaussian: alpha = alpha_splat * exp(-0.5 * ||vQuad||²).
        const r2    = dot(vQuad, vQuad);
        const raw   = exp(r2.mul(-0.5)).mul(vColor.a);
        // Hard cutoff to kill the long faint tail beyond ~2.5 sigma.
        const alpha = raw.sub(0.004).max(0);
        return vec4(vColor.rgb, alpha);
    })();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder   = 100;
    mesh.name          = 'SplatCloud (compute)';
    mesh.userData.splat = slot;       // make storage buffers discoverable for attachGpuSort

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
