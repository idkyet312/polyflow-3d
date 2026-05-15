import { MeshStandardNodeMaterial, IrradianceNode } from 'three/webgpu';
import {
    texture, uniform, normalMap, vec2, vec4,
    cameraProjectionMatrix, modelViewMatrix, positionLocal, normalLocal,
} from 'three/tsl';
import { Vector3, Matrix3, Color } from 'three';
import { createPomUVNode, resolvePomQuality, POM_QUALITY } from '../materials/pomNode.js';

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
 * Recompile knobs: `pomEnabled`, `pomQuality`, the heightMap texture
 * identity.
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
        this.pomEnabled = false;
        this.pomIntensity = 0.04;
        this.pomQuality = POM_QUALITY.MEDIUM;
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
        this._pomCompiled = { enabled: false, quality: null, heightMap: null, depthWrite: false };
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

        if (!wantPom) {
            // Tear down: clear the override nodes so three.js falls back to
            // its built-in sampling via material maps.
            this.colorNode = null;
            this.normalNode = null;
            this.roughnessNode = null;
            this.metalnessNode = null;
            this.maskNode = null;
            this.maskShadowNode = null;
            this.depthNode = null;
            this.aoNode = null;
            this._pomCompiled = { enabled: false, quality: null, heightMap: null, depthWrite: false };
            this.needsUpdate = true;
            return;
        }

        // Build the parallax-offset UV (+ silhouette mask) from the heightmap
        // march, then route every surface sampler through the offset UV so
        // the textures fake depth.
        const heightTextureNode = texture(this.heightMap);
        const { uv: pomUV, silhouette, hitDepth, shadow } = createPomUVNode({
            heightTextureNode,
            intensityUniform: this._pomIntensityUniform,
            quality,
            lightDirTSUniform: this._silPomLightTSUniform,
        });

        // Dynamic/computed UV must go through .sample() — the constructor-arg
        // form (texture(map, uv)) mis-binds a derived UV node in this build
        // and renders black. Use color-uniform × map@pomUV (NOT
        // materialColor, which already bakes in map@defaultUV → double map).
        if (this.map) {
            if (this.color && this._silPomColorUniform?.value?.copy) {
                this._silPomColorUniform.value.copy(this.color);
            }
            this.colorNode = this._silPomColorUniform.mul(texture(this.map).sample(pomUV));
        } else {
            this.colorNode = null;
        }

        if (this.normalMap) {
            const scale = this.normalScale
                ? vec2(this.normalScale.x, this.normalScale.y)
                : vec2(1, 1);
            this.normalNode = normalMap(texture(this.normalMap).sample(pomUV), scale);
        } else {
            this.normalNode = null;
        }

        this.roughnessNode = this.roughnessMap
            ? texture(this.roughnessMap).sample(pomUV).g
            : null;
        this.metalnessNode = this.metalnessMap
            ? texture(this.metalnessMap).sample(pomUV).b
            : null;

        // Silhouette discard: maskNode keeps the fragment where the node is
        // true (three discards on `mask.not()`). silhouette is true past the
        // displaced contour, so keep = NOT silhouette. Same node for the
        // shadow pass so cast shadows clip to the same contour.
        const keepMask = silhouette.not();
        this.maskNode = keepMask;
        this.maskShadowNode = keepMask;

        // Stage 5: internal self-shadow → ambient occlusion term.
        this.aoNode = shadow;

        // Stage 4: rewrite fragment depth from the marched hit so the
        // displaced surface z-fights/clips correctly against real
        // geometry. localHit = surface pushed inward along the geometric
        // normal by the tangent-space hit depth × height scale, then
        // local→view→clip→NDC→[0,1]. Gated: Early-Z loss is opt-in.
        if (this.pomDepthWrite) {
            const localHit = positionLocal.sub(
                normalLocal.mul(hitDepth.mul(this._pomIntensityUniform)),
            );
            const clip = cameraProjectionMatrix.mul(
                modelViewMatrix.mul(vec4(localHit, 1.0)),
            );
            // WebGPU clip-space z is already in [0,1] after the perspective
            // divide (unlike GL's [-1,1]). The classic *0.5+0.5 remap from
            // GLSL POM tutorials pushes every fragment to [0.5,1] here and
            // makes the surface fail the depth test → invisible. Use z/w
            // directly, clamped to the valid range.
            this.depthNode = clip.z.div(clip.w).clamp(0.0, 1.0);
        } else {
            this.depthNode = null;
        }

        this._pomCompiled = {
            enabled: true,
            quality: quality.name,
            heightMap: this.heightMap,
            depthWrite: !!this.pomDepthWrite,
        };
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
            snap.enabled !== wantEnabled
            || snap.quality !== (wantEnabled ? wantQuality : null)
            || snap.heightMap !== (wantEnabled ? this.heightMap : null)
            || snap.depthWrite !== (wantEnabled ? !!this.pomDepthWrite : false)
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
        this.pomDepthWrite = !!source.pomDepthWrite;
        this.setPomIntensity(this.pomIntensity);
        this.rebuildPomGraph();
        return this;
    }
}
