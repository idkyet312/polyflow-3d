import * as THREE from 'three';
import { Fn, vec2, vec3, float, int, texture, uniform, uniformArray, positionWorld, normalWorld, mix } from 'three/tsl';
import { DDGIMeshStandardNodeMaterial } from './DDGIMeshStandardNodeMaterial.js';

const DDGI_PATCH_VERSION = 14;
const FORCE_RED_GI_TEST = false;
const FORCE_RED_MATERIAL_OVERRIDE_TEST = false;
const OCT_RES = 8;
const OCT_PAD = 1;
const OCT_RES_P = 10;
const DEPTH_RANGE = 50;

function createBlackTexture() {
    const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
}

export function createDDGISampler({
    getAtlas,
    getGrid,
    getIntensity,
    getNormalBias,
    getDebugViewBlend,
    getDepthMean,
    getDepthMeanSq,
    getProbeTrapped,
    getSolidTestEnabled,
    getSolidTestColor,
}) {
    const uAtlasSize = uniform(new THREE.Vector2(1, 1));
    const uTilesPerRow = uniform(1);
    const uProbeMin = uniform(new THREE.Vector3());
    const uProbeMax = uniform(new THREE.Vector3(1, 1, 1));
    const uGridDims = uniform(new THREE.Vector3(1, 1, 1));
    const uIntensity = uniform(1);
    const uNormalBias = uniform(0);
    const uDebugViewBlend = uniform(0);
    const uDepthMean = uniformArray(getDepthMean?.() || [DEPTH_RANGE], 'float');
    const uDepthMeanSq = uniformArray(getDepthMeanSq?.() || [DEPTH_RANGE * DEPTH_RANGE], 'float');
    const uProbeTrapped = uniformArray(getProbeTrapped?.() || [0], 'float');
    const uChebyshevEnabled = uniform(1.0);
    const uChebyshevFloor = uniform(0.0);
    const uSolidTestEnabled = uniform(0.0);
    const uSolidTestColor = uniform(new THREE.Vector3(1.5, 0.9, 0.2));
    const atlasTex = texture(createBlackTexture());
    const tmpMin = new THREE.Vector3();
    const tmpMax = new THREE.Vector3();
    let captureBypass = false;

    function refreshUniforms() {
        const grid = getGrid?.();
        const atlas = getAtlas?.();
        const intensity = captureBypass ? 0 : (getIntensity?.() ?? 1.0);
        if (!grid || !atlas) {
            uAtlasSize.value.set(1, 1);
            uTilesPerRow.value = 1;
            uIntensity.value = 0.0;
            return;
        }
        uAtlasSize.value.set(atlas.width, atlas.height);
        uTilesPerRow.value = Math.max(1, atlas.tilesPerRow || 1);
        uGridDims.value.set(grid.dims.x, grid.dims.y, grid.dims.z);
        grid.probePosition(0, 0, 0, tmpMin);
        grid.probePosition(grid.dims.x - 1, grid.dims.y - 1, grid.dims.z - 1, tmpMax);
        uProbeMin.value.copy(tmpMin);
        uProbeMax.value.copy(tmpMax);
        uIntensity.value = intensity;
        uNormalBias.value = getNormalBias?.() ?? 0;
        uDebugViewBlend.value = captureBypass
            ? 0
            : THREE.MathUtils.clamp(Number(getDebugViewBlend?.() ?? 0), 0, 1);
        uSolidTestEnabled.value = captureBypass ? 0.0 : (getSolidTestEnabled?.() ? 1.0 : 0.0);
        const solidTestColor = getSolidTestColor?.();
        if (solidTestColor) uSolidTestColor.value.copy(solidTestColor);
        atlasTex.value = atlas.texture || atlas.front?.texture;
    }

    function setCaptureBypass(v) {
        captureBypass = !!v;
        refreshUniforms();
    }

    const octEncode = (dir) => {
        const an = vec3(dir.x.abs(), dir.y.abs(), dir.z.abs());
        const denom = an.x.add(an.y).add(an.z).max(float(1e-6));
        const n = dir.div(denom);
        const px = n.x;
        const py = n.y;
        const wrapX = float(1).sub(py.abs()).mul(n.x.sign());
        const wrapY = float(1).sub(px.abs()).mul(n.y.sign());
        const useWrap = n.z.lessThan(float(0));
        return vec2(
            useWrap.select(wrapX, px),
            useWrap.select(wrapY, py),
        ).mul(0.5).add(0.5);
    };

    const sampleProbeOct = (probeIndex, n) => {
        const uv01 = octEncode(n).clamp(vec2(0), vec2(1));
        const probeIndexF = float(probeIndex);
        const tilesPerRow = float(uTilesPerRow).max(float(1));
        const tileRow = probeIndexF.div(tilesPerRow).floor();
        const tileCol = probeIndexF.sub(tileRow.mul(tilesPerRow));
        const px = tileCol.mul(float(OCT_RES_P)).add(float(OCT_PAD)).add(uv01.x.mul(float(OCT_RES)));
        const py = tileRow.mul(float(OCT_RES_P)).add(float(OCT_PAD)).add(uv01.y.mul(float(OCT_RES)));
        return atlasTex.sample(vec2(px.div(uAtlasSize.x), py.div(uAtlasSize.y))).rgb;
    };

    const giSampleFn = Fn(([wp, n]) => {
        const wpBiased = wp.add(n.mul(uNormalBias));
        const grid = wpBiased.sub(uProbeMin).div(uProbeMax.sub(uProbeMin))
            .clamp(vec3(0), vec3(1))
            .mul(uGridDims.sub(vec3(1)));
        const baseIdxX = int(grid.x.min(uGridDims.x.sub(float(1.0001))).floor());
        const baseIdxY = int(grid.y.min(uGridDims.y.sub(float(1.0001))).floor());
        const baseIdxZ = int(grid.z.min(uGridDims.z.sub(float(1.0001))).floor());
        const baseIdx = vec3(float(baseIdxX), float(baseIdxY), float(baseIdxZ));
        const fracIdx = grid.sub(baseIdx).clamp(vec3(0), vec3(1));
        const probeSpacing = uProbeMax.sub(uProbeMin).div(uGridDims.sub(vec3(1)));
        const dxI = int(uGridDims.x);
        const dxDyI = int(uGridDims.x.mul(uGridDims.y));
        let sum = vec3(0).toVar();
        let wSum = float(0).toVar();

        for (let cz = 0; cz < 2; cz++) for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 2; cx++) {
            const ixI = baseIdxX.add(int(cx));
            const iyI = baseIdxY.add(int(cy));
            const izI = baseIdxZ.add(int(cz));
            const tx = cx === 0 ? float(1).sub(fracIdx.x) : fracIdx.x;
            const ty = cy === 0 ? float(1).sub(fracIdx.y) : fracIdx.y;
            const tz = cz === 0 ? float(1).sub(fracIdx.z) : fracIdx.z;
            const sx = tx.mul(tx).mul(float(3).sub(tx.mul(2)));
            const sy = ty.mul(ty).mul(float(3).sub(ty.mul(2)));
            const sz = tz.mul(tz).mul(float(3).sub(tz.mul(2)));
            const triWeight = sx.mul(sy).mul(sz);
            const piInt = izI.mul(dxDyI).add(iyI.mul(dxI)).add(ixI);
            const idxV = vec3(float(ixI), float(iyI), float(izI));
            const probeWorld = uProbeMin.add(idxV.mul(probeSpacing));
            const pointToProbe = probeWorld.sub(wpBiased);
            const dist = pointToProbe.length();
            const pointToProbeDir = pointToProbe.div(dist.max(float(1e-4)));
            const dMean = uDepthMean.element(piInt);
            const dMeanSq = uDepthMeanSq.element(piInt);
            const probeSpacingLen = probeSpacing.length();
            const varianceFloor = probeSpacingLen.mul(float(0.2));
            const variance = dMeanSq.sub(dMean.mul(dMean)).max(varianceFloor.mul(varianceFloor));
            const visibilityBias = probeSpacingLen.mul(float(0.35)).add(uNormalBias.mul(float(0.5)));
            const distExcess = dist.sub(dMean).sub(visibilityBias).max(float(0));
            const chebyshevRaw = variance.div(variance.add(distExcess.mul(distExcess))).clamp(0, 1);
            const chebyshev = chebyshevRaw.mul(chebyshevRaw).mul(chebyshevRaw);
            const visWeight = uChebyshevFloor.mix(chebyshev, uChebyshevEnabled).max(uChebyshevFloor);
            const trappedFlag = uProbeTrapped.element(piInt);
            const aliveMask = float(1).sub(trappedFlag.mul(0.82));
            const probeFacing = pointToProbeDir.dot(n).max(float(0.0)).pow(float(2.5)).add(float(0.03));
            const weight = triWeight.mul(visWeight).mul(aliveMask).mul(probeFacing);
            const irr = sampleProbeOct(piInt, n).max(vec3(0));
            sum = sum.add(irr.mul(weight));
            wSum = wSum.add(weight);
        }

        return sum.div(wSum.max(float(1e-4)));
    });

    const sampleNode = Fn(() => {
        const n = normalWorld.normalize();
        const atlasResult = FORCE_RED_GI_TEST
            ? vec3(4.0, 0, 0)
            : giSampleFn(positionWorld, n).max(vec3(0));

        const solidResult = atlasResult.mul(float(1).sub(uSolidTestEnabled))
            .add(uSolidTestColor.mul(uSolidTestEnabled));
        const debugColor = solidResult.mul(1.5).clamp(vec3(0), vec3(2));
        const blended = mix(solidResult, debugColor, uDebugViewBlend);

        return blended.mul(uIntensity).clamp(vec3(0), vec3(8.0));
    });

    return {
        node: sampleNode(),
        refreshUniforms,
        setCaptureBypass,
        debugViewMixNode: uDebugViewBlend,
    };
}

const convertedMaterials = new WeakMap();
let _ddgiPatchLogCount = 0;

function isDDGIConvertibleMaterial(mat) {
    if (!mat) return false;
    if (mat.isDDGIMeshStandardNodeMaterial) return true;
    return !!(mat.isMeshStandardMaterial || mat.isMeshStandardNodeMaterial);
}

function convertToDDGIMaterial(mat) {
    if (!mat || mat.isDDGIMeshStandardNodeMaterial) return mat;
    const cached = convertedMaterials.get(mat);
    if (cached) return cached;

    const converted = new DDGIMeshStandardNodeMaterial({
        color: mat.color?.clone?.() || 0xffffff,
        roughness: mat.roughness ?? 1,
        metalness: mat.metalness ?? 0,
        opacity: mat.opacity ?? 1,
        transparent: !!mat.transparent,
        alphaTest: mat.alphaTest ?? 0,
        side: mat.side ?? THREE.FrontSide,
        vertexColors: !!mat.vertexColors,
        flatShading: !!mat.flatShading,
        wireframe: !!mat.wireframe,
        fog: mat.fog ?? true,
        toneMapped: mat.toneMapped ?? true,
        depthTest: mat.depthTest ?? true,
        depthWrite: mat.depthWrite ?? true,
        colorWrite: mat.colorWrite ?? true,
    });

    const textureSlots = [
        'map', 'lightMap', 'aoMap', 'emissiveMap', 'bumpMap', 'normalMap',
        'displacementMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'envMap',
        // heightMap drives Parallax Occlusion Mapping. Carried through here
        // so a user-assigned heightMap survives the DDGI conversion.
        'heightMap',
    ];
    for (const key of textureSlots) {
        if (mat[key]) converted[key] = mat[key];
    }

    // POM state lives outside the standard PBR slot list; copy explicitly so
    // a serialized material round-trips through the converter intact.
    if (mat.pomEnabled !== undefined) converted.pomEnabled = !!mat.pomEnabled;
    if (mat.pomIntensity !== undefined) converted.setPomIntensity?.(mat.pomIntensity);
    if (mat.pomQuality !== undefined) converted.pomQuality = mat.pomQuality;
    converted.rebuildPomGraph?.();

    if (mat.emissive) converted.emissive.copy(mat.emissive);
    converted.emissiveIntensity = mat.emissiveIntensity ?? 1;
    converted.normalScale?.copy?.(mat.normalScale || new THREE.Vector2(1, 1));
    converted.bumpScale = mat.bumpScale ?? converted.bumpScale;
    converted.displacementScale = mat.displacementScale ?? converted.displacementScale;
    converted.displacementBias = mat.displacementBias ?? converted.displacementBias;
    converted.envMapIntensity = mat.envMapIntensity ?? converted.envMapIntensity;
    converted.blending = mat.blending;
    converted.blendSrc = mat.blendSrc;
    converted.blendDst = mat.blendDst;
    converted.blendEquation = mat.blendEquation;
    converted.premultipliedAlpha = mat.premultipliedAlpha;
    converted.dithering = mat.dithering;
    converted.polygonOffset = mat.polygonOffset;
    converted.polygonOffsetFactor = mat.polygonOffsetFactor;
    converted.polygonOffsetUnits = mat.polygonOffsetUnits;
    converted.name = mat.name;
    converted.userData = { ...(mat.userData || {}) };
    converted.userData._ddgiSourceMaterialType = mat.type || mat.constructor?.name || 'Material';

    convertedMaterials.set(mat, converted);
    mat.dispose?.();
    return converted;
}

export function patchMaterials(root, ddgiNode, { forceRebuild = false } = {}) {
    if (!root || !ddgiNode) return;
    let assigned = 0;
    let converted = 0;
    let scanned = 0;
    let skippedUnsupported = 0;
    root.traverse((obj) => {
        if (!obj.isMesh) return;
        if (obj.userData?.ddgiSkipReceive) return;
        const hadArrayMaterial = Array.isArray(obj.material);
        const mats = hadArrayMaterial ? obj.material : [obj.material];
        let materialChanged = false;
        for (let i = 0; i < mats.length; i++) {
            let mat = mats[i];
            if (!mat) continue;
            scanned++;

            if (!isDDGIConvertibleMaterial(mat)) {
                skippedUnsupported++;
                continue;
            }

            if (!mat.isDDGIMeshStandardNodeMaterial) {
                mat = convertToDDGIMaterial(mat);
                mats[i] = mat;
                materialChanged = true;
                converted++;
            }

            const alreadyPatched = mat.userData?._ddgiPatchVersion === DDGI_PATCH_VERSION
                && mat.ddgiIrradianceNode === ddgiNode;
            if (alreadyPatched && !forceRebuild) continue;
            if (alreadyPatched && forceRebuild) {
                mat.dispose?.();
                mat.needsUpdate = true;
                continue;
            }

            try {
                if (forceRebuild) mat.dispose?.();
                mat.ddgiIrradianceNode = ddgiNode;
                if (FORCE_RED_MATERIAL_OVERRIDE_TEST) {
                    mat.colorNode = vec3(1, 0, 0);
                    mat.emissiveNode = vec3(4, 0, 0);
                    mat.lights = false;
                    mat.toneMapped = false;
                }
                mat.userData._ddgiPatchVersion = DDGI_PATCH_VERSION;
                mat.userData._ddgiPatched = true;
                mat.needsUpdate = true;
                assigned++;
            } catch (e) {
                console.warn('[DDGI] material patch failed', mat, e);
                mat.userData._ddgiPatchVersion = DDGI_PATCH_VERSION;
            }
        }
        if (materialChanged) obj.material = hadArrayMaterial ? mats : mats[0];
    });
    if (assigned > 0 || _ddgiPatchLogCount < 3) {
        _ddgiPatchLogCount++;
        console.log(`[DDGI] patchMaterials assigned=${assigned} converted=${converted} scanned=${scanned} skipped=${skippedUnsupported}`);
    }
}
