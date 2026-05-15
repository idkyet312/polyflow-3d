import {
    Fn, Loop, If, vec3, vec4, float,
    uv as uvNode,
    tangentView, bitangentView, normalView, positionView,
} from 'three/tsl';

// Silhouette / Prism Parallax Occlusion Mapping (SilPOM)
// ──────────────────────────────────────────────────────────────────────────
// Crimson Desert / BLACKSPACE-style surface displacement, in-material.
//
//  Stage 1  View vector transformed into tangent space via the engine's
//           tangentView/bitangentView/normalView accessors (which use the
//           real per-vertex tangent attribute, vertex-stage + interpolated,
//           when present).
//  Stage 2  Linear search to bracket the hit, then a fixed binary
//           refinement to sub-texel accuracy (removes "pancake"/slicing
//           banding). Step count adapts to view angle.
//  Stage 3  Bounding-prism clip: the heightfield is confined to the unit
//           cube. If the marched (u,v) leaves [0,1] before a hit, the
//           fragment is on the eroded silhouette → caller discards it.
//  Stage 4  hitDepth (0 at the polygon surface → 1 at the deepest valley)
//           is returned so the material can rewrite fragment depth.
//  Stage 5  Optional secondary march toward the light for internal
//           self-shadowing in the heightfield valleys.
//
// TBN comes from `tangentView`/`normalView` (the geometry should carry a
// `tangent` attribute — call BufferGeometry.computeTangents() — otherwise
// these fall back to a screen-derivative frame).
//
// Quality presets compile to a fixed linear-loop bound (the WGSL loop
// bound must be a compile-time constant); the *effective* step count is
// scaled down at head-on angles via the dynamic layer stride.
//
// Reference: Tatarchuk, "Parallax Occlusion Mapping" (GDC 2006).

export const POM_QUALITY = Object.freeze({
    LOW:    { name: 'low',    steps: 16, minSteps: 4 },
    MEDIUM: { name: 'medium', steps: 32, minSteps: 8 },
    HIGH:   { name: 'high',   steps: 64, minSteps: 12 },
});

const BINARY_STEPS = 5;
const SHADOW_STEPS = 8;

export function resolvePomQuality(input) {
    if (!input) return POM_QUALITY.MEDIUM;
    if (typeof input === 'object' && Number.isFinite(input.steps)) return input;
    const key = String(input).toLowerCase();
    if (key === 'low' || key === 'l') return POM_QUALITY.LOW;
    if (key === 'high' || key === 'h') return POM_QUALITY.HIGH;
    return POM_QUALITY.MEDIUM;
}

// Returns { uv, silhouette, hitDepth, shadow }:
//   uv         — TSL vec2, parallax-offset UV for downstream samplers.
//   silhouette — TSL bool, true when the fragment is past the displaced
//                contour (caller discards). False when it hit.
//   hitDepth   — TSL float in [0,1], tangent-space depth of the hit
//                (0 = polygon surface, 1 = deepest valley).
//   shadow     — TSL float in [0,1], 1 = lit, <1 = self-shadowed. Always
//                1 when no lightDirTSUniform is supplied.
// Caller passes a TSL `texture(heightMap)` node and a `uniform()` for
// intensity (live-editable, no recompile). lightDirTSUniform is an
// optional `uniform(vec3)` holding the light direction already expressed
// in this surface's tangent space.
export function createPomUVNode({ heightTextureNode, intensityUniform, quality, lightDirTSUniform = null }) {
    const q = resolvePomQuality(quality);
    const STEPS = q.steps | 0;
    const MIN_STEPS = q.minSteps | 0;

    const packed = Fn(() => {
        const baseUV = uvNode();

        // Stage 1 — tangent-space view direction from a screen-derivative
        // frame. This deliberately does NOT use tangentView/bitangentView:
        // those need a valid per-vertex `tangent` attribute and produce
        // NaN when it's missing/degenerate, which propagates through the
        // march and blanks the whole surface. The derivative frame needs
        // only position + uv + normal and is robust on every mesh.
        const N = normalView.normalize();
        const posV = positionView;
        const dPdx = posV.dFdx();
        const dPdy = posV.dFdy();
        const dUVdx = baseUV.dFdx();
        const dUVdy = baseUV.dFdy();
        const det = dUVdx.x.mul(dUVdy.y).sub(dUVdy.x.mul(dUVdx.y));
        const invDet = float(1.0).div(det.add(float(1e-6)));
        const T = dPdx.mul(dUVdy.y).sub(dPdy.mul(dUVdx.y)).mul(invDet).normalize();
        const B = N.cross(T);
        const Vw = posV.normalize().negate();
        // Guard the basis dots against NaN/degenerate frames: if any
        // component is non-finite, fall back to a straight-down view
        // (z=1) so the march still finds the surface instead of
        // discarding the fragment.
        const rawV = vec3(Vw.dot(T), Vw.dot(B), Vw.dot(N));
        const finite = rawV.x.equal(rawV.x)
            .and(rawV.y.equal(rawV.y))
            .and(rawV.z.equal(rawV.z));
        const V = finite.select(rawV, vec3(0.0, 0.0, 1.0))
            .normalize().toVar('silPomV');

        // Stage 2 — adaptive layer count: fewer steps head-on (|V.z|→1),
        // full steps at grazing angles where slicing artifacts appear.
        const numLayers = float(STEPS).mix(float(MIN_STEPS), V.z.abs())
            .max(float(MIN_STEPS)).toVar('silPomLayers');
        const layerDepth = float(1.0).div(numLayers);

        const heightScale = intensityUniform;
        // Standard POM offset: ΔUV = V.xy / V.z · scale. No separate
        // normalize() of V.xy — head-on views make V.xy≈0 and normalize
        // would divide by ~0 → NaN → every fragment marked off-prism →
        // whole surface discarded (black). Clamp |V.z| away from 0 so
        // grazing angles stay finite.
        const totalOffset = V.xy
            .div(V.z.abs().max(float(0.1)))
            .mul(heightScale);
        // Per-linear-step UV delta. Loop runs the compile-time STEPS bound
        // but advances by the dynamic stride so head-on fragments converge
        // in ~MIN_STEPS effective iterations.
        const uvStep = totalOffset.div(numLayers);

        const currentLayerDepth = float(0.0).toVar('silPomLayerDepth');
        const currentUV = baseUV.toVar('silPomUV');
        const currentHeight = float(1.0).sub(heightTextureNode.sample(baseUV).r).toVar('silPomHeight');
        const found = float(0.0).toVar('silPomFound');

        // Phase 1 — linear search. No Break (documented WGSL-loop
        // constraint in this engine); the `found` flag freezes the result.
        Loop(STEPS, () => {
            If(found.lessThan(float(0.5)), () => {
                If(currentLayerDepth.greaterThanEqual(currentHeight), () => {
                    found.assign(float(1.0));
                }).Else(() => {
                    currentUV.assign(currentUV.add(uvStep));
                    currentLayerDepth.assign(currentLayerDepth.add(layerDepth));
                    currentHeight.assign(float(1.0).sub(heightTextureNode.sample(currentUV).r));
                });
            });
        });

        // Phase 2 — binary refinement. Step back half, then halve the
        // interval BINARY_STEPS times, homing on the exact crossing.
        const dUV = uvStep.mul(0.5).toVar('silPomDUV');
        const dDepth = layerDepth.mul(0.5).toVar('silPomDDepth');
        currentUV.assign(currentUV.sub(dUV));
        currentLayerDepth.assign(currentLayerDepth.sub(dDepth));
        Loop(BINARY_STEPS, () => {
            dUV.assign(dUV.mul(0.5));
            dDepth.assign(dDepth.mul(0.5));
            const h = float(1.0).sub(heightTextureNode.sample(currentUV).r);
            If(h.greaterThan(currentLayerDepth), () => {
                currentUV.assign(currentUV.add(dUV));
                currentLayerDepth.assign(currentLayerDepth.add(dDepth));
            }).Else(() => {
                currentUV.assign(currentUV.sub(dUV));
                currentLayerDepth.assign(currentLayerDepth.sub(dDepth));
            });
        });

        // Stage 3 — prism clip. The silhouette condition is ONLY "the ray
        // traversed the full prism depth without ever crossing the
        // heightfield" (found == 0). It is NOT a UV-bounds test: brick
        // textures tile with RepeatWrapping (repeat 4×1.5 …), so the
        // marched UV is legitimately well outside [0,1] on every fragment —
        // an absolute-bounds discard would erase the entire surface.
        // Encode "missed" as a negative hit depth so it survives the vec4
        // pack without corrupting the (tiled) UV the sampler needs.
        const missed = found.lessThan(float(0.5));
        const packedDepth = missed.select(float(-1.0), currentLayerDepth);

        // Stage 5 — internal self-shadow: from the hit point, march toward
        // the (tangent-space) light. If the heightfield rises above the
        // ray before it exits the slab, the valley is occluded.
        const shadow = float(1.0).toVar('silPomShadow');
        if (lightDirTSUniform) {
            const L = lightDirTSUniform.normalize();
            // Only march when the light faces the surface (L.z > 0).
            If(L.z.greaterThan(float(0.001)), () => {
                // Same NaN-safe form as the primary march: L.xy/L.z·scale,
                // no normalize() (L.xy≈0 head-on would divide by ~0).
                const sStep = L.xy.div(L.z.max(float(0.1)))
                    .mul(heightScale).div(float(SHADOW_STEPS));
                const sDepthStep = currentLayerDepth.div(float(SHADOW_STEPS));
                const sUV = currentUV.add(sStep).toVar('silPomShUV');
                const sDepth = currentLayerDepth.sub(sDepthStep).toVar('silPomShDepth');
                const occluded = float(0.0).toVar('silPomOcc');
                Loop(SHADOW_STEPS, () => {
                    If(occluded.lessThan(float(0.5)).and(sDepth.greaterThan(float(0.0))), () => {
                        const sh = float(1.0).sub(heightTextureNode.sample(sUV).r);
                        If(sh.lessThan(sDepth), () => {
                            occluded.assign(float(1.0));
                        });
                        sUV.assign(sUV.add(sStep));
                        sDepth.assign(sDepth.sub(sDepthStep));
                    });
                });
                shadow.assign(occluded.greaterThan(float(0.5)).select(float(0.35), float(1.0)));
            });
        }

        // Pack into one vec4 — a TSL Fn returns a single node, not a JS
        // object. xy = hit UV (real, possibly tiled — sampler needs it),
        // z = hit depth (<0 ⇒ ray missed the heightfield = silhouette),
        // w = self-shadow factor.
        return vec4(currentUV.x, currentUV.y, packedDepth, shadow);
    })();

    const uv = packed.xy.toVar('silPomOutUV');
    const packedDepth = packed.z;
    const silhouette = packedDepth.lessThan(float(0.0));
    // Clamp the negative sentinel back to 0 for the depth-write path.
    const hitDepth = packedDepth.max(float(0.0));
    const shadow = packed.w;

    return { uv, silhouette, hitDepth, shadow };
}
