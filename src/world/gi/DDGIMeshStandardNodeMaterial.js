import { MeshStandardNodeMaterial, IrradianceNode } from 'three/webgpu';

/**
 * MeshStandardNodeMaterial subclass that injects DDGI irradiance through the
 * three.js standard `setupLightMap` hook. Mirrors the subclass used by the
 * standalone cornell-box demo (e:\JOBS\ddgi-cornell-box\ddgi.html).
 *
 * Why a subclass and not an instance patch:
 * - three.js's NodeMaterial calls `this.setupLightMap(builder)` from inside
 *   `setupLights()` whenever `lights === true` (the default). The default
 *   body bails out unless `mat.lightMap` is set — so a per-instance
 *   override needs the override installed BEFORE the material is first
 *   built, otherwise the compiled-shader cache locks in the original
 *   prototype lookup.
 * - Subclassing at the class level guarantees every instance has the
 *   override from construction onward, no timing / cache hazards.
 *
 * Usage: construct walls/floor/etc. with this class instead of
 * `MeshStandardMaterial`/`MeshStandardNodeMaterial`. The DDGI patcher
 * walks the scene and assigns `mat.ddgiIrradianceNode = giNode`. Once
 * set, `setupLightMap` returns `new IrradianceNode(giNode)` which feeds
 * three.js's `builder.context.irradiance.addAssign(...)` — that gets
 * multiplied by the BRDF-correct albedo in the indirect-diffuse term.
 */
export class DDGIMeshStandardNodeMaterial extends MeshStandardNodeMaterial {
    constructor(parameters) {
        super(parameters);
        this.ddgiIrradianceNode = null;
        this.isDDGIMeshStandardNodeMaterial = true;
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

    copy(source) {
        super.copy(source);
        this.ddgiIrradianceNode = source.ddgiIrradianceNode ?? null;
        return this;
    }
}
