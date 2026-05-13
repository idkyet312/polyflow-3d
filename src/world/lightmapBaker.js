import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _bit = new THREE.Vector3();
const _scratchColor = new THREE.Color();

const MAX_RESOLUTION = 512;
const MAX_SAMPLES = 64;
const MAX_BAKE_WORK_UNITS = 64000000;
const YIELD_TEXEL_INTERVAL = 128;
const YIELD_SAMPLE_INTERVAL = 32;

function clampBakeInt(value, fallback, min, max) {
    const numeric = Number.parseInt(value, 10);
    if (!Number.isFinite(numeric)) return fallback;
    return THREE.MathUtils.clamp(numeric, min, max);
}

function nextFrame() {
    if (typeof requestAnimationFrame === 'function') {
        return new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function hasUserDataFlag(obj, flags) {
    let current = obj;
    while (current) {
        const data = current.userData || {};
        for (const flag of flags) {
            if (data[flag]) return true;
        }
        current = current.parent;
    }
    return false;
}

function isEffectivelyVisible(obj) {
    let current = obj;
    while (current) {
        if (current.visible === false) return false;
        current = current.parent;
    }
    return true;
}

function hasNameToken(obj, tokens) {
    const name = String(obj?.name || '').toLowerCase();
    for (const token of tokens) {
        if (name.includes(token)) return true;
    }
    return false;
}

function isLightmapSafeMesh(obj, { requireUv = false } = {}) {
    if (!obj?.isMesh || !isEffectivelyVisible(obj)) return false;
    if (!obj.geometry?.attributes?.position) return false;
    if (requireUv && !obj.geometry.attributes.uv) return false;
    if (obj.isInstancedMesh) return false;
    if (obj.material?.visible === false) return false;
    if (Array.isArray(obj.material) && obj.material.every((mat) => mat?.visible === false)) return false;

    const unsafeFlags = [
        'skipLightmap',
        'ddgiSkipCapture',
        'ddgiSkipReceive',
        'ignoreForcedSceneShadows',
        'isGrassField',
        'isPaintedFoliage',
        'isWater',
        'lightRangeVisual',
        'vehicleVisual',
        'fogPhase',
        'ddgiSampleRig',
        'internalSample',
    ];
    if (hasUserDataFlag(obj, unsafeFlags)) return false;

    const unsafeNameTokens = [
        'helper',
        'debug',
        'gizmo',
        'transformcontrols',
        'raycast',
        'collision',
        'ddgi',
        'volume',
        'water',
        'grass',
        'foliage',
    ];
    if (hasNameToken(obj, unsafeNameTokens)) return false;

    return true;
}

function hemisphereSample(normal, target) {
    const u = Math.random();
    const v = Math.random();
    const r = Math.sqrt(u);
    const phi = 2 * Math.PI * v;
    const x = r * Math.cos(phi);
    const y = r * Math.sin(phi);
    const z = Math.sqrt(Math.max(0, 1 - u));
    if (Math.abs(normal.x) > 0.9) _tan.set(0, 1, 0); else _tan.set(1, 0, 0);
    _tan.crossVectors(_tan, normal).normalize();
    _bit.crossVectors(normal, _tan);
    return target.set(0, 0, 0)
        .addScaledVector(_tan, x)
        .addScaledVector(_bit, y)
        .addScaledVector(normal, z)
        .normalize();
}

function collectBakeMeshes(root) {
    const meshes = [];
    const skipped = {
        invisible: 0,
        noPosition: 0,
        noUv: 0,
        instanced: 0,
        materialHidden: 0,
        unsafeFlag: 0,
        unsafeName: 0,
    };
    root.traverse((obj) => {
        if (!obj?.isMesh || !isEffectivelyVisible(obj)) {
            if (obj?.isMesh) skipped.invisible++;
            return;
        }
        if (!obj.geometry?.attributes?.position) {
            skipped.noPosition++;
            return;
        }
        if (!obj.geometry.attributes.uv) {
            skipped.noUv++;
            return;
        }
        if (obj.isInstancedMesh) {
            skipped.instanced++;
            return;
        }
        if (obj.material?.visible === false || (Array.isArray(obj.material) && obj.material.every((mat) => mat?.visible === false))) {
            skipped.materialHidden++;
            return;
        }
        if (hasUserDataFlag(obj, [
            'skipLightmap',
            'ddgiSkipCapture',
            'ddgiSkipReceive',
            'ignoreForcedSceneShadows',
            'isGrassField',
            'isPaintedFoliage',
            'isWater',
            'lightRangeVisual',
            'vehicleVisual',
            'fogPhase',
            'ddgiSampleRig',
            'internalSample',
        ])) {
            skipped.unsafeFlag++;
            return;
        }
        if (hasNameToken(obj, [
            'helper',
            'debug',
            'gizmo',
            'transformcontrols',
            'raycast',
            'collision',
            'ddgi',
            'volume',
            'water',
            'grass',
            'foliage',
        ])) {
            skipped.unsafeName++;
            return;
        }
        if (!obj.geometry.attributes.normal) obj.geometry.computeVertexNormals();
        meshes.push(obj);
    });
    meshes.skipped = skipped;
    return meshes;
}

function buildOccluders(scene) {
    const occluders = [];
    scene.traverse((obj) => {
        if (!isLightmapSafeMesh(obj)) return;
        if (!obj.geometry.boundsTree) {
            try { obj.geometry.boundsTree = new MeshBVH(obj.geometry); } catch { return; }
        }
        occluders.push(obj);
    });
    return occluders;
}

function estimateUvTexels(mesh, resolution) {
    const geom = mesh.geometry;
    const uvAttr = geom.attributes.uv;
    const posAttr = geom.attributes.position;
    const indexAttr = geom.index;
    const triCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;
    let texels = 0;

    for (let t = 0; t < triCount; t++) {
        const ia = indexAttr ? indexAttr.getX(t * 3) : t * 3;
        const ib = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
        const ic = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;
        const minU = Math.max(0, Math.min(uvAttr.getX(ia), uvAttr.getX(ib), uvAttr.getX(ic)));
        const maxU = Math.min(1, Math.max(uvAttr.getX(ia), uvAttr.getX(ib), uvAttr.getX(ic)));
        const minV = Math.max(0, Math.min(uvAttr.getY(ia), uvAttr.getY(ib), uvAttr.getY(ic)));
        const maxV = Math.min(1, Math.max(uvAttr.getY(ia), uvAttr.getY(ib), uvAttr.getY(ic)));
        const px = Math.max(1, Math.ceil((maxU - minU) * resolution) + 2);
        const py = Math.max(1, Math.ceil((maxV - minV) * resolution) + 2);
        texels += px * py * 0.5;
    }

    return Math.min(resolution * resolution, Math.ceil(texels));
}

function estimateBakeWork(meshes, resolution, samples, maxBounces) {
    let texels = 0;
    for (const mesh of meshes) texels += estimateUvTexels(mesh, resolution);
    const workUnits = texels * Math.max(1, samples) * Math.max(1, maxBounces + 1);
    return { texels, workUnits };
}

function formatWorkUnits(value) {
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${Math.round(value / 1000)}K`;
    return String(Math.round(value));
}

function getMaterialAlbedo(material) {
    if (!material) return _scratchColor.setRGB(0.5, 0.5, 0.5);
    if (material.color) return _scratchColor.copy(material.color);
    return _scratchColor.setRGB(0.5, 0.5, 0.5);
}

function sampleEnv(dir, envColor, sun, ambient, hemi) {
    let r = envColor.r, g = envColor.g, b = envColor.b;
    if (ambient) {
        r += ambient.color.r * ambient.intensity;
        g += ambient.color.g * ambient.intensity;
        b += ambient.color.b * ambient.intensity;
    }
    if (hemi) {
        const t = Math.max(0, dir.y) * 0.5 + 0.5;
        r += (hemi.skyColor.r * t + hemi.groundColor.r * (1 - t)) * hemi.intensity;
        g += (hemi.skyColor.g * t + hemi.groundColor.g * (1 - t)) * hemi.intensity;
        b += (hemi.skyColor.b * t + hemi.groundColor.b * (1 - t)) * hemi.intensity;
    }
    if (sun) {
        const cosA = dir.dot(sun.dir);
        if (cosA > sun.cosAngular) {
            r += sun.color.r * sun.intensity;
            g += sun.color.g * sun.intensity;
            b += sun.color.b * sun.intensity;
        }
    }
    return _scratchColor.setRGB(r, g, b);
}

function getSceneEnvironmentTexture(scene) {
    const texture = scene.environment || scene.background;
    const image = texture?.image;
    if (!image?.data || !image.width || !image.height) return null;
    return {
        data: image.data,
        width: image.width,
        height: image.height,
        channels: image.data.length / (image.width * image.height),
        type: texture.type,
    };
}

function readEnvironmentChannel(env, index) {
    const value = env.data[index] ?? 0;
    if (env.type === THREE.HalfFloatType) return THREE.DataUtils.fromHalfFloat(value);
    if (env.data instanceof Uint8Array || env.data instanceof Uint8ClampedArray) return value / 255;
    return value;
}

function sampleEnvironmentTexture(env, dir, target) {
    if (!env) return target.setRGB(0, 0, 0);
    const u = 0.5 + Math.atan2(dir.z, dir.x) / (Math.PI * 2);
    const v = Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1)) / Math.PI;
    const x = THREE.MathUtils.clamp(Math.floor(u * env.width), 0, env.width - 1);
    const y = THREE.MathUtils.clamp(Math.floor(v * env.height), 0, env.height - 1);
    const base = (y * env.width + x) * env.channels;
    return target.setRGB(
        readEnvironmentChannel(env, base),
        readEnvironmentChannel(env, base + 1),
        readEnvironmentChannel(env, base + 2)
    );
}

function gatherLightContext(scene, directionalLight) {
    let ambient = null, hemi = null;
    scene.traverse((o) => {
        if (o.isAmbientLight && !ambient) ambient = { color: o.color.clone(), intensity: o.intensity };
        if (o.isHemisphereLight && !hemi) hemi = {
            skyColor: o.color.clone(),
            groundColor: o.groundColor.clone(),
            intensity: o.intensity,
        };
    });
    let sun = null;
    if (directionalLight && directionalLight.visible && directionalLight.intensity > 0) {
        const d = new THREE.Vector3().subVectors(directionalLight.position, directionalLight.target.position).normalize();
        sun = {
            dir: d,
            color: directionalLight.color.clone(),
            intensity: directionalLight.intensity,
            cosAngular: Math.cos(0.04),
        };
    }
    const envColor = new THREE.Color(0, 0, 0);
    if (scene.background?.isColor) envColor.copy(scene.background).multiplyScalar(0.5);
    return { ambient, hemi, sun, envColor, envTexture: getSceneEnvironmentTexture(scene) };
}

function barycentric(u, v, ax, ay, bx, by, cx, cy) {
    const denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(denom) < 1e-12) return null;
    const a = ((by - cy) * (u - cx) + (cx - bx) * (v - cy)) / denom;
    const b = ((cy - ay) * (u - cx) + (ax - cx) * (v - cy)) / denom;
    return { a, b, c: 1 - a - b };
}

function dilate(pixels, weight, W, H) {
    const copy = pixels.slice();
    for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
            const i = py * W + px;
            if (weight[i] > 0) continue;
            let r = 0, g = 0, b = 0, n = 0;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    const nx = px + dx, ny = py + dy;
                    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                    const ni = ny * W + nx;
                    if (weight[ni] <= 0) continue;
                    r += copy[ni * 4];
                    g += copy[ni * 4 + 1];
                    b += copy[ni * 4 + 2];
                    n++;
                }
            }
            if (n > 0) {
                pixels[i * 4] = Math.round(r / n);
                pixels[i * 4 + 1] = Math.round(g / n);
                pixels[i * 4 + 2] = Math.round(b / n);
                pixels[i * 4 + 3] = 255;
            }
        }
    }
}

function traceRadiance(origin, dir, ctx, depth) {
    const { raycaster, occluders, lightCtx, maxBounces } = ctx;
    raycaster.set(origin, dir);
    raycaster.far = 500;
    const hits = raycaster.intersectObjects(occluders, false);
    if (hits.length === 0) {
        const envColor = sampleEnv(dir, lightCtx.envColor, lightCtx.sun, null, lightCtx.hemi).clone();
        if (lightCtx.envTexture) {
            envColor.add(sampleEnvironmentTexture(lightCtx.envTexture, dir, new THREE.Color()).multiplyScalar(0.75));
        }
        return envColor;
    }
    const hit = hits[0];
    const mat = Array.isArray(hit.object.material) ? hit.object.material[0] : hit.object.material;
    const albedo = getMaterialAlbedo(mat).clone();
    const hitNormal = hit.face?.normal ? hit.face.normal.clone() : _n.copy(dir).negate();
    hitNormal.transformDirection(hit.object.matrixWorld).normalize();

    const direct = new THREE.Color(0, 0, 0);
    if (lightCtx.sun) {
        const ndotl = Math.max(0, hitNormal.dot(lightCtx.sun.dir));
        if (ndotl > 0) {
            const sunOrigin = hit.point.clone().addScaledVector(hitNormal, 0.001);
            raycaster.set(sunOrigin, lightCtx.sun.dir);
            raycaster.far = 500;
            if (raycaster.intersectObjects(occluders, false).length === 0) {
                direct.r += lightCtx.sun.color.r * lightCtx.sun.intensity * ndotl;
                direct.g += lightCtx.sun.color.g * lightCtx.sun.intensity * ndotl;
                direct.b += lightCtx.sun.color.b * lightCtx.sun.intensity * ndotl;
            }
        }
    }
    if (lightCtx.ambient) {
        direct.r += lightCtx.ambient.color.r * lightCtx.ambient.intensity;
        direct.g += lightCtx.ambient.color.g * lightCtx.ambient.intensity;
        direct.b += lightCtx.ambient.color.b * lightCtx.ambient.intensity;
    }
    if (lightCtx.hemi) {
        const t = Math.max(0, hitNormal.y) * 0.5 + 0.5;
        direct.r += (lightCtx.hemi.skyColor.r * t + lightCtx.hemi.groundColor.r * (1 - t)) * lightCtx.hemi.intensity;
        direct.g += (lightCtx.hemi.skyColor.g * t + lightCtx.hemi.groundColor.g * (1 - t)) * lightCtx.hemi.intensity;
        direct.b += (lightCtx.hemi.skyColor.b * t + lightCtx.hemi.groundColor.b * (1 - t)) * lightCtx.hemi.intensity;
    }

    let bounce = new THREE.Color(0, 0, 0);
    if (depth < maxBounces) {
        const bounceDir = new THREE.Vector3();
        hemisphereSample(hitNormal, bounceDir);
        const bounceOrigin = hit.point.clone().addScaledVector(hitNormal, 0.001);
        bounce = traceRadiance(bounceOrigin, bounceDir, ctx, depth + 1);
    }

    return new THREE.Color(
        albedo.r * (direct.r + bounce.r),
        albedo.g * (direct.g + bounce.g),
        albedo.b * (direct.b + bounce.b),
    );
}

async function bakeMesh(mesh, ctx, onTexelProgress) {
    const { resolution, samples, raycaster, occluders, lightCtx, maxBounces } = ctx;
    const geom = mesh.geometry;
    const posAttr = geom.attributes.position;
    const normAttr = geom.attributes.normal;
    const uvAttr = geom.attributes.uv;
    const indexAttr = geom.index;
    const matrixWorld = mesh.matrixWorld;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrixWorld);

    const W = resolution, H = resolution;
    const accum = new Float32Array(W * H * 3);
    const weight = new Float32Array(W * H);
    const triCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;

    const traceCtx = { raycaster, occluders, lightCtx, maxBounces };

    let yieldAccum = 0;
    let sampleYieldAccum = 0;
    for (let t = 0; t < triCount; t++) {
        if (ctx.isCancelled?.()) return null;
        const ia = indexAttr ? indexAttr.getX(t * 3) : t * 3;
        const ib = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
        const ic = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;
        const uax = uvAttr.getX(ia), uay = uvAttr.getY(ia);
        const ubx = uvAttr.getX(ib), uby = uvAttr.getY(ib);
        const ucx = uvAttr.getX(ic), ucy = uvAttr.getY(ic);

        const minU = Math.max(0, Math.min(uax, ubx, ucx));
        const maxU = Math.min(1, Math.max(uax, ubx, ucx));
        const minV = Math.max(0, Math.min(uay, uby, ucy));
        const maxV = Math.min(1, Math.max(uay, uby, ucy));

        const px0 = Math.max(0, Math.floor(minU * W) - 1);
        const py0 = Math.max(0, Math.floor(minV * H) - 1);
        const px1 = Math.min(W - 1, Math.ceil(maxU * W) + 1);
        const py1 = Math.min(H - 1, Math.ceil(maxV * H) + 1);

        for (let py = py0; py <= py1; py++) {
            for (let px = px0; px <= px1; px++) {
                const u = (px + 0.5) / W;
                const v = (py + 0.5) / H;
                const bary = barycentric(u, v, uax, uay, ubx, uby, ucx, ucy);
                if (!bary) continue;
                if (bary.a < -0.02 || bary.b < -0.02 || bary.c < -0.02) continue;

                _v0.fromBufferAttribute(posAttr, ia);
                _v1.fromBufferAttribute(posAttr, ib);
                _v2.fromBufferAttribute(posAttr, ic);
                _origin.set(0, 0, 0)
                    .addScaledVector(_v0, bary.a)
                    .addScaledVector(_v1, bary.b)
                    .addScaledVector(_v2, bary.c)
                    .applyMatrix4(matrixWorld);

                _v0.fromBufferAttribute(normAttr, ia);
                _v1.fromBufferAttribute(normAttr, ib);
                _v2.fromBufferAttribute(normAttr, ic);
                _n.set(0, 0, 0)
                    .addScaledVector(_v0, bary.a)
                    .addScaledVector(_v1, bary.b)
                    .addScaledVector(_v2, bary.c)
                    .applyMatrix3(normalMatrix)
                    .normalize();

                _origin.addScaledVector(_n, 0.002);

                let r = 0, g = 0, b = 0;

                if (lightCtx.sun) {
                    const ndotl = Math.max(0, _n.dot(lightCtx.sun.dir));
                    if (ndotl > 0) {
                        raycaster.set(_origin, lightCtx.sun.dir);
                        raycaster.far = 500;
                        if (raycaster.intersectObjects(occluders, false).length === 0) {
                            r += lightCtx.sun.color.r * lightCtx.sun.intensity * ndotl;
                            g += lightCtx.sun.color.g * lightCtx.sun.intensity * ndotl;
                            b += lightCtx.sun.color.b * lightCtx.sun.intensity * ndotl;
                        }
                    }
                }
                if (lightCtx.ambient) {
                    r += lightCtx.ambient.color.r * lightCtx.ambient.intensity;
                    g += lightCtx.ambient.color.g * lightCtx.ambient.intensity;
                    b += lightCtx.ambient.color.b * lightCtx.ambient.intensity;
                }
                if (lightCtx.hemi) {
                    const tt = Math.max(0, _n.y) * 0.5 + 0.5;
                    r += (lightCtx.hemi.skyColor.r * tt + lightCtx.hemi.groundColor.r * (1 - tt)) * lightCtx.hemi.intensity;
                    g += (lightCtx.hemi.skyColor.g * tt + lightCtx.hemi.groundColor.g * (1 - tt)) * lightCtx.hemi.intensity;
                    b += (lightCtx.hemi.skyColor.b * tt + lightCtx.hemi.groundColor.b * (1 - tt)) * lightCtx.hemi.intensity;
                }

                let giR = 0, giG = 0, giB = 0;
                for (let s = 0; s < samples; s++) {
                    if (ctx.isCancelled?.()) return null;
                    hemisphereSample(_n, _dir);
                    const radiance = traceRadiance(_origin, _dir, traceCtx, 0);
                    giR += radiance.r;
                    giG += radiance.g;
                    giB += radiance.b;
                    sampleYieldAccum++;
                    if (sampleYieldAccum >= YIELD_SAMPLE_INTERVAL) {
                        sampleYieldAccum = 0;
                        await nextFrame();
                        if (ctx.isCancelled?.()) return null;
                    }
                }
                r += giR / samples;
                g += giG / samples;
                b += giB / samples;

                const idx = (py * W + px) * 3;
                accum[idx] += r;
                accum[idx + 1] += g;
                accum[idx + 2] += b;
                weight[py * W + px] += 1;

                yieldAccum++;
                if (yieldAccum >= YIELD_TEXEL_INTERVAL) {
                    yieldAccum = 0;
                    onTexelProgress?.(t / triCount);
                    await nextFrame();
                    if (ctx.isCancelled?.()) return null;
                }
            }
        }
    }

    const pixels = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
        const w = weight[i] || 1;
        const r = accum[i * 3] / w;
        const g = accum[i * 3 + 1] / w;
        const b = accum[i * 3 + 2] / w;
        pixels[i * 4] = Math.min(255, Math.max(0, Math.round(Math.pow(r, 1 / 2.2) * 255)));
        pixels[i * 4 + 1] = Math.min(255, Math.max(0, Math.round(Math.pow(g, 1 / 2.2) * 255)));
        pixels[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(Math.pow(b, 1 / 2.2) * 255)));
        pixels[i * 4 + 3] = 255;
    }
    dilate(pixels, weight, W, H);

    const tex = new THREE.DataTexture(pixels, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.flipY = false;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

function ensureUV2(geometry) {
    if (geometry.attributes.uv1) return;
    const uv = geometry.attributes.uv;
    if (!uv) return;
    geometry.setAttribute('uv1', new THREE.BufferAttribute(uv.array.slice(), uv.itemSize));
}

function applyLightmap(mesh, texture) {
    ensureUV2(mesh.geometry);
    const previous = mesh.userData?.bakedLightmap;
    if (previous && previous !== texture) previous.dispose?.();
    const apply = (mat) => {
        if (!mat) return;
        mat.lightMap = texture;
        mat.lightMapIntensity = 1.0;
        mat.needsUpdate = true;
    };
    if (Array.isArray(mesh.material)) mesh.material.forEach(apply);
    else apply(mesh.material);
    mesh.userData.bakedLightmap = texture;
}

export function createLightmapBaker({ scene, directionalLight, getDirectionalLight = null }) {
    let cancelled = false;
    let running = false;

    async function start({ resolution = 16, samples = 4, maxBounces = 2, onProgress = null } = {}) {
        if (running) return null;
        running = true;
        cancelled = false;

        try {
            const safeResolution = clampBakeInt(resolution, 16, 16, MAX_RESOLUTION);
            const safeSamples = clampBakeInt(samples, 4, 1, MAX_SAMPLES);
            const safeBounces = clampBakeInt(maxBounces, 1, 0, 2);
            const meshes = collectBakeMeshes(scene);
            const skipped = meshes.skipped || {};
            if (meshes.length === 0) {
                return {
                    meshCount: 0,
                    cancelled: false,
                    refused: true,
                    reason: `No bakeable meshes found. Need visible Mesh with UVs. Skipped: no UV ${skipped.noUv || 0}, hidden ${skipped.invisible || 0}, helper/debug ${skipped.unsafeName || 0}, flagged ${skipped.unsafeFlag || 0}.`,
                    resolution: safeResolution,
                    samples: safeSamples,
                    maxBounces: safeBounces,
                    estimate: { texels: 0, workUnits: 0 },
                    limits: {
                        maxResolution: MAX_RESOLUTION,
                        maxSamples: MAX_SAMPLES,
                        maxWorkUnits: MAX_BAKE_WORK_UNITS,
                    },
                };
            }
            const estimate = estimateBakeWork(meshes, safeResolution, safeSamples, safeBounces);
            const limits = {
                maxResolution: MAX_RESOLUTION,
                maxSamples: MAX_SAMPLES,
                maxWorkUnits: MAX_BAKE_WORK_UNITS,
            };

            if (estimate.workUnits > MAX_BAKE_WORK_UNITS) {
                return {
                    meshCount: meshes.length,
                    cancelled: false,
                    refused: true,
                    reason: `Bake too large: ${formatWorkUnits(estimate.workUnits)} work units exceeds ${formatWorkUnits(MAX_BAKE_WORK_UNITS)} limit.`,
                    resolution: safeResolution,
                    samples: safeSamples,
                    maxBounces: safeBounces,
                    estimate,
                    limits,
                };
            }

            const occluders = buildOccluders(scene);
            const lightCtx = gatherLightContext(scene, getDirectionalLight?.() || directionalLight);
            const raycaster = new THREE.Raycaster();
            raycaster.firstHitOnly = true;

            const ctx = {
                resolution: safeResolution,
                samples: safeSamples,
                raycaster,
                occluders,
                lightCtx,
                maxBounces: safeBounces,
                isCancelled: () => cancelled,
            };

            for (let i = 0; i < meshes.length; i++) {
                if (cancelled) break;
                const mesh = meshes[i];
                onProgress?.({
                    stage: 'mesh',
                    index: i,
                    total: meshes.length,
                    name: mesh.name || 'mesh',
                    texel: 0,
                    resolution: safeResolution,
                    samples: safeSamples,
                    estimate,
                    limits,
                });
                const tex = await bakeMesh(mesh, ctx, (texel) => {
                    onProgress?.({
                        stage: 'mesh',
                        index: i,
                        total: meshes.length,
                        name: mesh.name || 'mesh',
                        texel,
                        resolution: safeResolution,
                        samples: safeSamples,
                        estimate,
                        limits,
                    });
                });
                if (!tex || cancelled) {
                    tex?.dispose?.();
                    break;
                }
                applyLightmap(mesh, tex);
            }

            return {
                meshCount: meshes.length,
                cancelled,
                refused: false,
                resolution: safeResolution,
                samples: safeSamples,
                maxBounces: safeBounces,
                estimate,
                limits,
            };
        } finally {
            running = false;
        }
    }

    function cancel() { cancelled = true; }

    function clear() {
        scene.traverse((obj) => {
            if (!obj.isMesh) return;
            const baked = obj.userData?.bakedLightmap;
            const apply = (mat) => {
                if (!mat) return;
                if (mat.lightMap) {
                    mat.lightMap = null;
                    mat.needsUpdate = true;
                }
            };
            if (Array.isArray(obj.material)) obj.material.forEach(apply);
            else apply(obj.material);
            if (baked) baked.dispose();
            delete obj.userData.bakedLightmap;
        });
    }

    return { start, cancel, clear, isActive: () => running };
}
