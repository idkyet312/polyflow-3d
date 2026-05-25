// Sphere reflection probe + SSR fallback for the WebGPU forward path.
//
// Goal (perf/quality sweet spot): NO runtime cube/equirect capture. The probe's
// reflection SOURCE is the scene's already-loaded PMREM environment map
// (scene.environment), so HDR prefiltered mips come for free. What the probe
// ADDS over a plain infinite env reflection is *sphere parallax correction*:
// the reflected ray is intersected against a finite reflection sphere (center +
// radius placed around the room), so reflections track local geometry instead of
// sliding like an infinitely-distant skybox.
//
// This runs as a POST pass (full-screen quad), so there are no per-fragment
// surface attributes (positionWorld/normalWorld are undefined on a quad). World
// position + normal are RECONSTRUCTED from the G-buffer that SSR already needs:
//   • scene depth      → view position → world position
//   • view-space normal (RGB of normalMaterial MRT) → world normal
//   • roughness        (A of normalMaterial / materialData) → PMREM mip
// matching how SSRNode reconstructs its own ray origin.
//
// composeSSRWithProbe(ssr, ...) uses SSR where the screen-space ray HIT
// (ssr.a == 1) and the probe where it MISSED (off-screen / sky), so off-screen
// reflections no longer vanish.

import * as THREE from 'three';
import {
    Fn, vec3, vec4, float, uniform, texture,
    getViewPosition, screenCoordinate,
    pmremTexture, reflect, normalize, mix,
} from 'three/tsl';

// Map perceptual roughness → PMREM mip lod. three's PMREM has ~ log2(size) mips;
// we approximate the standard roughness→lod curve (matches PMREMNode intent).
const MAX_MIP = 8.0; // covers 256px PMREM chains; clamped in-shader anyway.

export function createReflectionProbe({ getEnvironment } = {}) {
    // Sphere bounds in world space. Default: a roomy sphere at origin; the
    // runtime/UI overrides center+radius to wrap the playable area.
    const uCenter = uniform(new THREE.Vector3(0, 2, 0));
    const uRadius = uniform(40.0);
    const uIntensity = uniform(1.0);
    // Camera matrices for screen-space → world reconstruction. Filled by refresh().
    const uInvView = uniform(new THREE.Matrix4());   // view → world
    const uInvProj = uniform(new THREE.Matrix4());   // clip → view
    const uCamPos = uniform(new THREE.Vector3());
    const uResolution = uniform(new THREE.Vector2(1, 1));

    // Env map handle. We DON'T own it — the world env system sets scene.environment;
    // we read the same texture so probe reflections match IBL. Resolved live so
    // env-preset switches are picked up without re-wiring the node graph.
    const envTextureRef = { value: null };
    const resolveEnv = () => (getEnvironment?.() ?? envTextureRef.value) || _blackEnv();

    function setBounds(center, radius) {
        if (center && Number.isFinite(center.x)) uCenter.value.set(center.x, center.y, center.z);
        if (Number.isFinite(radius) && radius > 0) uRadius.value = radius;
    }
    function setIntensity(v) {
        if (Number.isFinite(v)) uIntensity.value = v;
    }
    function setEnvironment(tex) {
        envTextureRef.value = tex || null;
    }

    // Stable PMREM source texture node. Its value is swapped live via refresh()
    // so env-preset changes are picked up without rebuilding the node graph (TSL
    // captures the node, not the texture value, at build time). The PMREM node
    // itself is built per-fragment with the reflection direction + LOD:
    //   pmremTexture(sourceTexture, dirNode, levelNode)  → prefiltered radiance.
    // (PMREMNode is the sampler — you call it with a direction, not `.sample()`.)
    const _pmremSource = texture(_blackEnv());
    let _lastEnv = null;

    // Call once per frame before render: point the PMREM at the live env map and
    // push the camera matrices used for screen-space reconstruction.
    function refresh(camera) {
        const tex = resolveEnv();
        if (tex !== _lastEnv) {
            _pmremSource.value = tex;
            _lastEnv = tex;
        }
        if (camera) {
            uInvView.value.copy(camera.matrixWorld);                  // view→world
            uInvProj.value.copy(camera.projectionMatrixInverse);     // clip→view
            camera.getWorldPosition(uCamPos.value);
        }
    }
    function setResolution(w, h) {
        if (w > 0 && h > 0) uResolution.value.set(w, h);
    }

    // Convenience: pull camera matrices, env map, and the renderer's drawing-
    // buffer size in one call from the render loop.
    const _size = new THREE.Vector2();
    function refreshFromCamera(camera, renderer) {
        if (!camera) return;
        camera.updateMatrixWorld();
        camera.updateProjectionMatrix();
        if (renderer) {
            renderer.getDrawingBufferSize(_size);
            setResolution(_size.x, _size.y);
        }
        refresh(camera);
    }

    // Parallax-correct a reflection ray against the bounding sphere.
    // Given world pos P, reflection dir R (unit), sphere (C, r):
    //   solve |P + t*R - C|^2 = r^2 for t>0, return direction (hit - C) so the
    //   env map is sampled as if centered at the sphere. Standard sphere parallax.
    const parallaxDir = Fn(([P, R]) => {
        const oc = P.sub(uCenter).toVar();           // ray origin relative to center
        const b = oc.dot(R).toVar();                  // R is unit → a = 1
        const c = oc.dot(oc).sub(uRadius.mul(uRadius)).toVar();
        const disc = b.mul(b).sub(c).max(float(0)).toVar();
        const t = disc.sqrt().sub(b).max(float(0.0001)).toVar(); // far intersection, t>0
        const hit = P.add(R.mul(t)).toVar();
        return hit.sub(uCenter); // direction from sphere center → sampled by env
    });

    // The probe's parallax-corrected reflection color for the fragment under the
    // current screen pixel, reconstructed from the G-buffer.
    //   depthNode:  scene depth (screen-space, the SSR depth texture node)
    //   viewNormalNode: view-space normal (RGB of the normalMaterial MRT)
    //   roughnessNode:  perceptual roughness (A channel) — drives PMREM mip
    function buildProbeSample({ depthNode, viewNormalNode, roughnessNode }) {
        return Fn(() => {
            const uvN = screenCoordinate.xy.div(uResolution);
            const d = depthNode.sample(uvN).r.toVar();
            // Reconstruct view-space position from depth (same path SSR uses).
            const viewPos = getViewPosition(uvN, d, uInvProj).toVar();
            // View → world for the surface point.
            const worldPos = uInvView.mul(vec4(viewPos, 1.0)).xyz.toVar();
            // View-space normal → world (rotate by view→world, drop translation).
            const nView = normalize(viewNormalNode.sample(uvN).xyz).toVar();
            const nWorld = normalize(uInvView.mul(vec4(nView, 0.0)).xyz).toVar();
            // Reflection of the view vector about the surface normal, in world.
            const V = normalize(worldPos.sub(uCamPos)).toVar();
            const R = reflect(V, nWorld).toVar();
            const dir = parallaxDir(worldPos, R).toVar();
            const lod = (roughnessNode ?? float(0.0)).clamp(0, 1).mul(MAX_MIP);
            return pmremTexture(_pmremSource, dir, lod).rgb.mul(uIntensity);
        })();
    }

    // SSR-with-fallback composite. ssrNode is the SSRNode (vec4; a==1 on hit).
    // gbuffer = { depthNode, viewNormalNode, roughnessNode }. Returns the vec4
    // reflection contribution to ADD to the lit scene color (same as plain SSR).
    function composeSSRWithProbe(ssrNode, gbuffer) {
        return Fn(() => {
            const s = vec4(ssrNode).toVar();
            const probe = buildProbeSample(gbuffer).toVar();
            // s.a == 1 → SSR hit; 0 → miss. Lerp probe→ssr by hit confidence so
            // partial/edge hits blend smoothly instead of popping.
            const rgb = mix(probe, s.rgb, s.a);
            return vec4(rgb, float(1.0));
        })();
    }

    return {
        uniforms: { uCenter, uRadius, uIntensity },
        setBounds, setIntensity, setEnvironment, setResolution, refresh, refreshFromCamera,
        buildProbeSample, composeSSRWithProbe,
        config: { MAX_MIP },
    };
}

// Lazy 1x1 black cube so pmremTexture has a valid input before env loads.
let _black = null;
function _blackEnv() {
    if (_black) return _black;
    const data = new Uint8Array([0, 0, 0, 255]);
    const faces = Array.from({ length: 6 }, () => {
        const t = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
        t.needsUpdate = true;
        return t.image;
    });
    _black = new THREE.CubeTexture(faces);
    _black.needsUpdate = true;
    return _black;
}
