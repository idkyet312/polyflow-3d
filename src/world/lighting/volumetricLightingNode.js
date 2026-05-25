// Analytic volumetric lighting + height fog (post pass) for the forward path.
//
// What this adds over the legacy billboard-sheet fog (volumetricFog.js): real
// DIRECTIONAL in-scattering. Per pixel we reconstruct the world-space view ray
// from the G-buffer depth and analytically integrate two things along it:
//
//   1. Exponential HEIGHT FOG — denser low, thinner high (atmospheric haze),
//      integrated in closed form along the ray so there's no marching cost.
//   2. SUN IN-SCATTER — fog lit by the sun, modulated by a Henyey-Greenstein
//      phase function of the angle between the view ray and the sun direction.
//      Looking toward the sun → bright glow/haze; away → dim. This is the
//      "volumetric sunlight" look (god-ray glow) without a shadow march.
//
// MVP scope: NO shadow occlusion of the shafts (no froxel/CSM sampling in the
// post pass), so it's smooth scattering rather than hard light shafts. It still
// reads as volumetric directional lighting and composites before tonemap/bloom,
// so bright in-scatter blooms naturally.
//
// Inputs (G-buffer the post stack already produces):
//   sceneColor : lit beauty (vec4) — we blend fog over it
//   sceneDepth : depth texture node — ray length / sky detection
//   camera     : for matrices (pushed via uniforms each frame)

import * as THREE from 'three';
import {
    Fn, vec4, float, uniform,
    getViewPosition, screenUV,
} from 'three/tsl';

export function createVolumetricLighting() {
    // Tunables (live).
    const uFogColor = uniform(new THREE.Color(0x9fb2c8));   // ambient fog tint
    const uSunColor = uniform(new THREE.Color(0xfff0d8));   // in-scatter tint
    const uSunDir = uniform(new THREE.Vector3(0, 1, 0));    // world, toward sun
    const uDensity = uniform(0.02);                         // height-fog density
    const uHeightFalloff = uniform(0.08);                   // how fast fog thins w/ height
    const uBaseHeight = uniform(0.0);                       // world Y where density = uDensity
    const uSunIntensity = uniform(1.2);                     // in-scatter strength
    const uAnisotropy = uniform(0.72);                      // HG g (0..0.95): forward scatter
    const uMaxOpacity = uniform(0.85);                      // clamp so scene never fully fogged
    const uIntensity = uniform(1.0);                        // master multiplier
    const uMaxDistance = uniform(500.0);                    // ray-length cap (≈ camera.far)

    // Camera reconstruction.
    const uInvView = uniform(new THREE.Matrix4());          // view → world
    const uInvProj = uniform(new THREE.Matrix4());          // clip → view
    const uCamPos = uniform(new THREE.Vector3());

    function refreshFromCamera(camera) {
        if (!camera) return;
        camera.updateMatrixWorld();
        camera.updateProjectionMatrix();
        uInvView.value.copy(camera.matrixWorld);
        uInvProj.value.copy(camera.projectionMatrixInverse);
        camera.getWorldPosition(uCamPos.value);
        if (Number.isFinite(camera.far)) uMaxDistance.value = camera.far;
    }
    function setSunDirection(worldDir) {
        if (worldDir) uSunDir.value.copy(worldDir).normalize();
    }
    function setColors({ fog, sun } = {}) {
        if (fog !== undefined) uFogColor.value.set(fog);
        if (sun !== undefined) uSunColor.value.set(sun);
    }
    function setParams(p = {}) {
        if (Number.isFinite(p.density)) uDensity.value = p.density;
        if (Number.isFinite(p.heightFalloff)) uHeightFalloff.value = p.heightFalloff;
        if (Number.isFinite(p.baseHeight)) uBaseHeight.value = p.baseHeight;
        if (Number.isFinite(p.sunIntensity)) uSunIntensity.value = p.sunIntensity;
        if (Number.isFinite(p.anisotropy)) uAnisotropy.value = THREE.MathUtils.clamp(p.anisotropy, -0.95, 0.95);
        if (Number.isFinite(p.maxOpacity)) uMaxOpacity.value = THREE.MathUtils.clamp(p.maxOpacity, 0, 1);
        if (Number.isFinite(p.intensity)) uIntensity.value = p.intensity;
    }

    // Henyey-Greenstein phase: forward/back scatter lobe controlled by g.
    //   p(θ) = (1-g²) / (4π (1 + g² - 2g·cosθ)^1.5)
    const hgPhase = Fn(([cosTheta, g]) => {
        const g2 = g.mul(g);
        const denom = float(1).add(g2).sub(g.mul(2).mul(cosTheta)).max(float(1e-4)).pow(1.5);
        return float(1).sub(g2).div(denom.mul(float(4.0 * Math.PI)));
    });

    // Builds the composite node: fog applied over sceneColor.
    //   depthNode: scene depth texture node (raw 0..1 depth).
    function build(sceneColor, depthNode) {
        return Fn(() => {
            const uv = screenUV;
            const d = depthNode.sample(uv).r.toVar();
            // Reconstruct world position of the surface (or far plane for sky).
            const viewPos = getViewPosition(uv, d, uInvProj).toVar();
            const worldPos = uInvView.mul(vec4(viewPos, 1.0)).xyz.toVar();

            // View ray from camera → surface. At the far plane (sky / no geometry,
            // depth≈1) the reconstructed position explodes toward infinity, which
            // overflows the optical-depth integral → NaN → black holes around
            // overlays/sky. Clamp the ray length to uMaxDistance so far pixels get
            // a finite, fully-fogged result instead of NaN.
            const rawVec = worldPos.sub(uCamPos).toVar();
            const rawLen = rawVec.length().max(float(1e-4)).toVar();
            const rayDir = rawVec.div(rawLen).toVar();
            const rayLen = rawLen.min(uMaxDistance).toVar();

            // --- Exponential height-fog optical depth, integrated in closed form
            // along the ray. Density(y) = uDensity * exp(-falloff * (y - base)).
            // ∫ along ray of D0 e^{-k (y0 + t·dy - base)} dt  =
            //   (D0 e^{-k(y0-base)} / (k·dy)) (1 - e^{-k·dy·L})   for dy ≠ 0.
            const k = uHeightFalloff.toVar();
            const y0 = uCamPos.y.sub(uBaseHeight).toVar();
            const dy = rayDir.y.toVar();
            const D0 = uDensity.toVar();
            // Guard the dy≈0 case (horizontal ray): fall back to constant density.
            const kdy = k.mul(dy).toVar();
            const baseTerm = D0.mul(y0.mul(k).negate().exp()).toVar();
            const flat = baseTerm.mul(rayLen);                       // dy≈0 path
            const sloped = baseTerm.div(kdy).mul(float(1).sub(kdy.mul(rayLen).negate().exp()));
            // Clamp optical depth to a finite range: NaN/Inf from any residual
            // edge case (degenerate dy, overflow) collapses to a benign value
            // instead of propagating black. clamp(0, 32) → transmittance e^-32≈0.
            const opticalRaw = kdy.abs().lessThan(float(1e-3)).select(flat, sloped);
            const optical = opticalRaw.max(float(0)).min(float(32.0)).toVar();

            // Beer-Lambert transmittance → fog opacity.
            const transmittance = optical.negate().exp().toVar();
            const fogAmount = float(1).sub(transmittance).mul(uMaxOpacity).toVar();

            // --- Sun in-scatter: phase(view·sun) × sun color, scaled by how much
            // fog the ray traversed (fogAmount). uSunDir points toward the sun.
            const cosTheta = rayDir.dot(uSunDir).toVar();
            const phase = hgPhase(cosTheta, uAnisotropy).toVar();
            const inScatter = uSunColor.mul(phase).mul(uSunIntensity).mul(fogAmount).mul(uIntensity).toVar();

            // Composite: attenuate scene toward the ambient fog tint by fogAmount
            // (master-scaled), then ADD the directional sun in-scatter on top so
            // bright haze blooms in the later bloom pass.
            const base = vec4(sceneColor).toVar();
            const coverage = fogAmount.mul(uIntensity).clamp(0, 1).toVar();
            const lit = base.rgb.mul(float(1).sub(coverage))
                .add(uFogColor.mul(coverage))
                .add(inScatter);
            return vec4(lit, base.a);
        })();
    }

    return {
        build,
        refreshFromCamera, setSunDirection, setColors, setParams,
        uniforms: {
            uFogColor, uSunColor, uSunDir, uDensity, uHeightFalloff, uBaseHeight,
            uSunIntensity, uAnisotropy, uMaxOpacity, uIntensity, uMaxDistance,
        },
    };
}
