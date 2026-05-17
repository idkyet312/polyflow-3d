import { MeshStandardNodeMaterial, IrradianceNode } from 'three/webgpu';
import {
    texture, uniform, normalMap, vec2, vec4,
    uv as uvNode,
    cameraProjectionMatrix, modelViewMatrix, positionLocal, normalLocal,
} from 'three/tsl';
import { Vector3, Matrix3, Color } from 'three';
import { createPomUVNode, resolvePomQuality, POM_QUALITY } from '../materials/pomNode.js';
import { untileTextureSample } from '../materials/untileUVNode.js';

/**
 * MeshStandardNodeMaterial subclass that
 *   1. Injects DDGI irradiance through the `setupLightMap` hook (original
 *      reason this subclass exists).
 *   2. Optionally runs a Parallax Occlusion Mapping (POM) pass before
 *      sampling texture maps, fed by a per-material `heightMap`.
 *
 * POM is opt-in per material: assign `mat.heightMap = tex` plus set
 * `mat.pomEnabled = true`. Toggling those properties calls
 * `rebuildPomGraph()` to wire (or unwire) the override nodes. Quality
 * changes also call `rebuildPomGraph()` because the Loop bound bakes into
 * the compiled shader.
 *
 * Live-editable knobs (no recompile): `pomIntensity` (height scale).
 * Recompile knobs: `pomEnabled`, `pomQuality`, `pomClipMode`, the heightMap
 * texture identity.
 */
export class DDGIMeshStandardNodeMaterial extends MeshStandardNodeMaterial {
    constructor(parameters) {
        super(parameters);
        this.ddgiIrradianceNode = null;
        this.isDDGIMeshStandardNodeMaterial = true;

        // POM state. heightMap is a regular three.js texture property; the
        // others are plain bag-of-state. rebuildPomGraph() reads them to
        // decide whether to install override nodes.
        this.heightMap = null;
        // Optional AO map sampled at the parallax-offset UV (so joints stay
        // occluded under POM). When POM is off, three's built-in aoMap +
        // uv2 path handles it instead — set both to the same texture.
        this.pomAOMap = null;
        this.pomEnabled = false;
        this.pomIntensity = 0.04;
        this.pomQuality = POM_QUALITY.MEDIUM;
        // 'silhouette' clips displaced contours; 'solid' keeps tiled POM
        // surfaces opaque while retaining parallax UV/normal/AO sampling.
        this.pomClipMode = 'silhouette';
        // Stage 4: rewrite fragment depth so the displaced surface clips
        // against real geometry. Off by default (disables Early-Z); only
        // showcase brick materials opt in.
        this.pomDepthWrite = false;
        this._pomIntensityUniform = uniform(this.pomIntensity);
        // Base color WITHOUT the map factor. three's `materialColor`
        // resolves to color×map@defaultUV; multiplying THAT by the
        // parallax-sampled map would sample the albedo twice (darkening
        // ≈ map²). The POM colorNode needs color × map@pomUV, so we carry
        // the tint as a plain uniform and refresh it before each rebuild.
        this._silPomColorUniform = uniform(new Color(0xffffff));
        // Stage 5: light direction in this surface's tangent space. Fed by
        // setSilPomLightDirection(); zero ⇒ self-shadow march is skipped.
        this._silPomLightTSUniform = uniform(new Vector3(0, 0, 0));
        this._silPomNormalMatrix = new Matrix3();
        this._silPomTmpDir = new Vector3();
        // Snapshot of which graph is currently compiled so we know when a
        // recompile is required.
        this._pomCompiled = { enabled: false, quality: null, heightMap: null, depthWrite: false, clipMode: null };
    }

    setupLightMap(builder) {
        if (!this._ddgiSetupLightMapLogged) {
            this._ddgiSetupLightMapLogged = true;
            console.log(`[DDGI] setupLightMap called name=${this.name} hasNode=${!!this.ddgiIrradianceNode}`);
        }
        if (this.ddgiIrradianceNode) {
            return new IrradianceNode(this.ddgiIrradianceNode);
        }
        return super.setupLightMap(builder);
    }

    /**
     * Installs (or removes) the POM override nodes based on the current
     * pomEnabled / pomQuality / heightMap state. Call after changing any of
     * those properties. Live changes to `pomIntensity` need no rebuild —
     * the uniform value is read directly by the running shader.
     */
    rebuildPomGraph() {
        const wantPom = !!(this.pomEnabled && this.heightMap);
        const quality = resolvePomQuality(this.pomQuality);
        const clipMode = this.pomClipMode === 'solid' ? 'solid' : 'silhouette';

        // Sampling UV: parallax-marched when POM is on, the plain mesh UV
        // when off. EITHER way every surface map is routed through the IQ
        // untiler so brick/cobble repetition is hidden (the visible grid
        // was there with POM off too). Opt out per material via
        // `untileMaps = false` (set on non-tiling finite props).
        let sampleUV;
        let silhouette = null;
        let hitDepth = null;
        let shadow = null;
        let coverage = null;
        if (wantPom) {
            const heightTextureNode = texture(this.heightMap);
            ({ uv: sampleUV, silhouette, hitDepth, shadow, coverage } = createPomUVNode({
                heightTextureNode,
                intensityUniform: this._pomIntensityUniform,
                quality,
                lightDirTSUniform: this._silPomLightTSUniform,
            }));
        } else {
            sampleUV = uvNode();
        }

        const untileOn = this.untileMaps !== false;
        const opts = { blendScale: 0.22, strength: untileOn ? 1.0 : 0.0 };
        // Dynamic/computed UV must go through .sample() — the constructor-arg
        // form (texture(map, uv)) mis-binds a derived UV node in this build
        // and renders black. Use color-uniform × map@sampleUV (NOT
        // materialColor, which already bakes in map@defaultUV → double map).
        if (this.map) {
            if (this.color && this._silPomColorUniform?.value?.copy) {
                this._silPomColorUniform.value.copy(this.color);
            }
            this.colorNode = this._silPomColorUniform.mul(
                untileTextureSample(texture(this.map), sampleUV, opts),
            );
        } else {
            this.colorNode = null;
        }

        if (this.normalMap) {
            const scale = this.normalScale
                ? vec2(this.normalScale.x, this.normalScale.y)
                : vec2(1, 1);
            this.normalNode = normalMap(
                untileTextureSample(texture(this.normalMap), sampleUV, opts),
                scale,
            );
        } else {
            this.normalNode = null;
        }

        this.roughnessNode = this.roughnessMap
            ? untileTextureSample(texture(this.roughnessMap), sampleUV, opts).g
            : null;
        this.metalnessNode = this.metalnessMap
            ? untileTextureSample(texture(this.metalnessMap), sampleUV, opts).b
            : null;

        if (wantPom) {
            const solidClip = clipMode === 'solid';
            // Silhouette discard: maskNode keeps the fragment where the
            // node is true (three discards on `mask.not()`). silhouette is
            // true past the displaced contour, so keep = NOT silhouette.
            // Same node for the shadow pass so cast shadows clip alike.
            if (solidClip) {
                this.maskNode = null;
                this.maskShadowNode = null;
            } else {
                const keepMask = silhouette.not();
                this.maskNode = keepMask;
                this.maskShadowNode = keepMask;
            }

            // Stage 5: self-shadow → AO term, combined with the baked AO
            // map (untiled at the parallax UV so mortar joints stay
            // occluded as the surface displaces). coverage feathers the
            // silhouette so the eroded contour reads as a soft contact
            // line, not a 1-bit stair-step.
            const edgeShade = solidClip ? shadow : shadow.mul(coverage);
            this.aoNode = this.pomAOMap
                ? edgeShade.mul(
                    untileTextureSample(texture(this.pomAOMap), sampleUV, opts).r,
                )
                : edgeShade;

            // Stage 4: rewrite fragment depth from the marched hit so the
            // displaced surface z-fights/clips correctly against real
            // geometry. Gated: Early-Z loss is opt-in.
            if (!solidClip && this.pomDepthWrite) {
                const localHit = positionLocal.sub(
                    normalLocal.mul(hitDepth.mul(this._pomIntensityUniform)),
                );
                const clip = cameraProjectionMatrix.mul(
                    modelViewMatrix.mul(vec4(localHit, 1.0)),
                );
                // WebGPU clip-space z is already [0,1] post perspective
                // divide; use z/w directly, clamped.
                this.depthNode = clip.z.div(clip.w).clamp(0.0, 1.0);
            } else {
                this.depthNode = null;
            }
        } else {
            // POM off: no silhouette/depth rewrite. Maps above are still
            // untiled — that's the whole point of this branch existing.
            this.maskNode = null;
            this.maskShadowNode = null;
            this.depthNode = null;
            this.aoNode = null;
        }

        this._pomCompiled = {
            enabled: wantPom,
            quality: wantPom ? quality.name : null,
            heightMap: wantPom ? this.heightMap : null,
            depthWrite: wantPom ? !!this.pomDepthWrite : false,
            clipMode: wantPom ? clipMode : null,
        };
        this._graphBuilt = true;
        this.needsUpdate = true;
    }

    /**
     * Live setter for the height scale. No recompile; the uniform is updated
     * in place and read by the running shader on the next frame.
     */
    setPomIntensity(v) {
        const value = Math.max(0, Number(v) || 0);
        this.pomIntensity = value;
        if (this._pomIntensityUniform?.value !== undefined) {
            this._pomIntensityUniform.value = value;
        }
    }

    /**
     * Detects whether the host changed pomEnabled / pomQuality / heightMap
     * since the last compile and rebuilds the graph if so. Cheap enough to
     * call every frame; only does work when something actually changed.
     */
    syncPomGraphIfStale() {
        const snap = this._pomCompiled;
        const wantEnabled = !!(this.pomEnabled && this.heightMap);
        const wantQuality = resolvePomQuality(this.pomQuality).name;
        if (
            // Build at least once IF this material opts into untiling:
            // even with POM off the graph then does the IQ map untiling,
            // so the default (null nodes) is wrong and must be replaced.
            // Non-untiling materials keep three.js's built-in sampling
            // (no override, no behaviour change for props/ceiling).
            (this.untileMaps === true && !this._graphBuilt)
            || snap.enabled !== wantEnabled
            || snap.quality !== (wantEnabled ? wantQuality : null)
            || snap.heightMap !== (wantEnabled ? this.heightMap : null)
            || snap.depthWrite !== (wantEnabled ? !!this.pomDepthWrite : false)
            || snap.clipMode !== (wantEnabled ? (this.pomClipMode === 'solid' ? 'solid' : 'silhouette') : null)
        ) {
            this.rebuildPomGraph();
        }
    }

    /**
     * Stage 5 feed: convert a world-space light direction into this
     * surface's tangent space and push it to the uniform. `object` is the
     * mesh using this material (supplies the world/normal matrix). Call
     * per frame for moving lights, or once for static ones. Safe no-op if
     * POM is off — the uniform is just ignored by the compiled graph.
     */
    setSilPomLightDirection(worldDir, object) {
        if (!worldDir || !object) return;
        // Tangent space here is built from object-LOCAL T/B/N (see
        // pomNode.js Stage 1), so transform the light dir world→local via
        // the inverse of the object's world rotation. normalMatrix is the
        // inverse-transpose of the upper 3×3 (world→local for directions
        // up to scale); good enough for the unit-scaled level meshes.
        object.updateWorldMatrix?.(true, false);
        this._silPomNormalMatrix.getNormalMatrix(object.matrixWorld);
        const d = this._silPomTmpDir.copy(worldDir)
            .applyMatrix3(this._silPomNormalMatrix)
            .normalize();
        const u = this._silPomLightTSUniform;
        if (u?.value?.set) u.value.set(d.x, d.y, d.z);
    }

    copy(source) {
        super.copy(source);
        this.ddgiIrradianceNode = source.ddgiIrradianceNode ?? null;
        this.heightMap = source.heightMap ?? null;
        this.pomEnabled = !!source.pomEnabled;
        this.pomIntensity = source.pomIntensity ?? 0.04;
        this.pomQuality = source.pomQuality ?? POM_QUALITY.MEDIUM;
        this.pomClipMode = source.pomClipMode === 'solid' ? 'solid' : 'silhouette';
        this.pomDepthWrite = !!source.pomDepthWrite;
        this.setPomIntensity(this.pomIntensity);
        this.rebuildPomGraph();
        return this;
    }
}
