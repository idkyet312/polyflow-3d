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
import {
    Fn, attribute, uniform, varying,
    vec2, vec3, vec4, mat3, float,
    positionLocal, modelViewMatrix, cameraProjectionMatrix,
    dot, exp, max, sqrt,
} from 'three/tsl';

// .splat byte layout: 32 bytes per splat, little-endian.
//   0..11   position xyz (3 x f32)
//   12..23  scale xyz    (3 x f32, already exp(log_scale))
//   24..27  color RGBA   (4 x u8, divide by 255)
//   28..31  rotation xyzw(4 x u8, decode (b - 127.5) / 127.5)
const SPLAT_BYTES = 32;

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
        colors[i * 4 + 0]    = view.getUint8(o + 24) / 255;
        colors[i * 4 + 1]    = view.getUint8(o + 25) / 255;
        colors[i * 4 + 2]    = view.getUint8(o + 26) / 255;
        colors[i * 4 + 3]    = view.getUint8(o + 27) / 255;
        rotations[i * 4 + 0] = (view.getUint8(o + 28) - 127.5) / 127.5;
        rotations[i * 4 + 1] = (view.getUint8(o + 29) - 127.5) / 127.5;
        rotations[i * 4 + 2] = (view.getUint8(o + 30) - 127.5) / 127.5;
        rotations[i * 4 + 3] = (view.getUint8(o + 31) - 127.5) / 127.5;
    }
    return { count, positions, scales, colors, rotations };
}

export async function loadSplat(url) {
    const buf = await (await fetch(url)).arrayBuffer();
    if (buf.byteLength % SPLAT_BYTES !== 0) {
        throw new Error(
            `[splat] ${url} is not a multiple of ${SPLAT_BYTES} bytes (size=${buf.byteLength})`
        );
    }
    return parseSplat(buf);
}

// ---------------------------------------------------------------------
// Mesh builder
// ---------------------------------------------------------------------
export function buildSplatMesh({ count, positions, scales, colors, rotations }) {

    // Geometry: unit quad spanning [-1, 1] in xy, instanced `count` times.
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -1, -1, 0,   1, -1, 0,   1, 1, 0,   -1, 1, 0,
    ]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.instanceCount = count;
    geometry.setAttribute('splatPos',   new THREE.InstancedBufferAttribute(positions, 3));
    geometry.setAttribute('splatScale', new THREE.InstancedBufferAttribute(scales,    3));
    geometry.setAttribute('splatColor', new THREE.InstancedBufferAttribute(colors,    4));
    geometry.setAttribute('splatRot',   new THREE.InstancedBufferAttribute(rotations, 4));

    // Camera-derived uniforms; refreshed each frame in onBeforeRender below.
    const uFocal    = uniform(new THREE.Vector2(1, 1));
    const uViewport = uniform(new THREE.Vector2(1, 1));

    const material = new THREE.MeshBasicNodeMaterial({
        transparent: true,
        depthWrite:  false,   // splats are translucent; don't occlude each other in depth buffer
        depthTest:   true,    // but DO read depth so opaque scene geometry occludes splats
        side:        THREE.DoubleSide,
        blending:    THREE.NormalBlending,
    });

    // Cross-stage varyings.
    const vQuad  = varying(vec2(0, 0), 'vQuad');   // quad-local position scaled to sigma units
    const vColor = varying(vec4(0, 0, 0, 0), 'vColor');

    material.vertexNode = Fn(() => {
        const sp  = attribute('splatPos');
        const ssc = attribute('splatScale');
        const sc  = attribute('splatColor');
        const sr  = attribute('splatRot');

        // Quaternion (x,y,z,w) -> 3x3 rotation matrix.
        const x = sr.x, y = sr.y, z = sr.z, w = sr.w;
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

        // Sigma_3D = R * S^2 * R^T  (S = diag(scale))
        const S2 = mat3(
            vec3(ssc.x.mul(ssc.x), 0, 0),
            vec3(0, ssc.y.mul(ssc.y), 0),
            vec3(0, 0, ssc.z.mul(ssc.z)),
        );
        const cov3D = R.mul(S2).mul(R.transpose());

        // Splat center: world -> view -> clip. modelViewMatrix is (view * model),
        // i.e. exactly the model-to-view-space transform we want.
        const viewPos = modelViewMatrix.mul(vec4(sp, 1.0));
        const tz      = max(viewPos.z.negate(), 0.001);   // positive depth in front of camera

        // Jacobian J of perspective projection at viewPos (Zwicker 2001).
        const J02 = uFocal.x.mul(viewPos.x).div(tz.mul(tz)).negate();
        const J12 = uFocal.y.mul(viewPos.y).div(tz.mul(tz)).negate();
        const J = mat3(
            vec3(uFocal.x.div(tz), 0,                0),
            vec3(0,                uFocal.y.div(tz), 0),
            vec3(J02,              J12,              0),
        );

        // 2D screen-space covariance: T * Sigma_3D * T^T, where T = J * W.
        // W = upper-left 3x3 of modelViewMatrix (view * model). This respects the splat
        // actor's transform, so a moved/rotated/scaled SplatActor still produces
        // correctly-shaped ellipses.
        const W = mat3(modelViewMatrix.element(0).xyz, modelViewMatrix.element(1).xyz, modelViewMatrix.element(2).xyz);
        const T = J.mul(W);
        const C = T.mul(cov3D).mul(T.transpose());
        const a = C.element(0).x.add(0.3);   // 0.3 = anti-aliasing low-pass regularization
        const b = C.element(0).y;
        const c = C.element(1).y.add(0.3);

        // Eigendecomposition of the 2x2 symmetric matrix [[a,b],[b,c]].
        const det  = a.mul(c).sub(b.mul(b));
        const mid  = a.add(c).mul(0.5);
        const disc = sqrt(max(mid.mul(mid).sub(det), 0.0));
        const lam1 = mid.add(disc);
        const lam2 = max(mid.sub(disc), 0.0);

        // Major / minor axes in screen pixels, sized to 3 sigmas (~99.7%).
        const v1     = vec2(b, lam1.sub(a));
        const v1Len  = max(v1.length(), 1e-6);
        const major  = v1.div(v1Len).mul(sqrt(lam1).mul(3.0));
        const minor  = vec2(major.y.negate(), major.x).mul(sqrt(lam2).div(max(sqrt(lam1), 1e-6)));

        // Project center to clip space, then expand the quad along (major, minor).
        const clipCenter = cameraProjectionMatrix.mul(viewPos);
        const px2clip    = vec2(2.0).div(uViewport).mul(clipCenter.w);
        const offsetClip = major.mul(positionLocal.x).add(minor.mul(positionLocal.y)).mul(px2clip);

        // Pass to fragment: positionLocal * 3 -> quad-local coords in units of sigma.
        vQuad.assign(vec2(positionLocal.x, positionLocal.y).mul(3.0));
        vColor.assign(sc);

        return clipCenter.add(vec4(offsetClip.x, offsetClip.y, 0, 0));
    })();

    material.colorNode = Fn(() => {
        // 2D Gaussian: alpha = alpha_splat * exp(-0.5 * ||vQuad||^2).
        // Because we expanded the quad in the eigenbasis with 3*sqrt(lambda) units,
        // ||vQuad||^2 is exactly the squared Mahalanobis distance.
        const r2    = dot(vQuad, vQuad);
        const alpha = exp(r2.mul(-0.5)).mul(vColor.a);
        return vec4(vColor.rgb, alpha);
    })();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;   // no per-instance bbox yet; cull at scene level only
    mesh.renderOrder   = 100;     // render after all opaques
    mesh.name          = 'SplatCloud';

    // Update camera-derived uniforms each frame.
    mesh.onBeforeRender = (renderer, _scene, camera) => {
        const size = renderer.getSize(new THREE.Vector2());
        uFocal.value.set(
            camera.projectionMatrix.elements[0] * size.x * 0.5,
            camera.projectionMatrix.elements[5] * size.y * 0.5,
        );
        uViewport.value.copy(size);
    };

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
