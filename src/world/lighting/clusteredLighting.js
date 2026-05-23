// Clustered Forward lighting for the three.js WebGPURenderer.
//
// three's stock LightsNode unrolls one shader node PER light → every fragment
// loops over EVERY point/spot light in the scene. This module replaces that
// loop for point + spot lights with a clustered-forward path:
//
//   1. The view frustum is divided into a froxel grid (TILES_X × TILES_Y screen
//      tiles × Z_SLICES depth slices in view space).
//   2. Each frame (CPU), every point/spot light is packed into a storage buffer
//      and binned into the froxels its sphere of influence overlaps. A flat
//      "light index list" + per-cluster (offset,count) table go into storage
//      buffers too.
//   3. A custom ClusteredLightsNode emits a TSL Loop in the fragment shader that
//      reads only the lights in the fragment's froxel and shades them with the
//      standard punctual BRDF (matching three's getDistanceAttenuation + spot
//      cone), then feeds them to the active LightingModel.
//
// Directional / ambient / hemisphere lights are LEFT on three's normal path
// (few of them; the sun keeps its CSM shadow). Only point/spot move to clusters.
//
// Shadows: spot lights can be shadowed via a shared depth atlas (see
// spotShadowAtlas.js); point lights are unshadowed in this first cut.
//
// Integration seam: override `renderer.lighting.createNode` so every material's
// LightsNode becomes a ClusteredLightsNode (three rebuilds these per material,
// always through that factory — see WebGPU MaterialNode.setupLights).

import * as THREE from 'three';
import {
    Fn, Loop, If, uint, vec3,
    instancedArray, uniform, positionView, screenCoordinate,
} from 'three/tsl';
import { LightsNode } from 'three/webgpu';

// ---- grid configuration --------------------------------------------------
const TILES_X = 16;
const TILES_Y = 9;
const Z_SLICES = 24;
const CLUSTER_COUNT = TILES_X * TILES_Y * Z_SLICES;
const MAX_LIGHTS = 256;              // hard cap on clustered point/spot lights
const MAX_LIGHTS_PER_CLUSTER = 64;   // index-list slots per cluster
const INDEX_LIST_LEN = CLUSTER_COUNT * MAX_LIGHTS_PER_CLUSTER;

// Light record layout in the float buffer (stride = 12 floats):
//   0..2  position (view space)
//   3     radius (cutoff distance; 0 = infinite → treated as far)
//   4..6  color * intensity
//   7     decay exponent
//   8..10 spot direction (view space), unused for point
//   11    packed: type in integer part (0 point, 1 spot), cone in fractional —
//         to avoid packing tricks we instead use two more lanes below.
// To keep it simple + aligned we use a 16-float stride:
//   11    type (0 point, 1 spot)
//   12    cosInner (spot)
//   13    cosOuter (spot)
//   14    shadowSlot (-1 = none) — index into the spot shadow atlas
//   15    pad
const LIGHT_STRIDE = 16;

// View-space near/far for the depth-slice distribution (exponential, like
// Doom-2016 clustered). Updated each frame from the camera.
function sliceNearFar(camera) {
    return { near: camera.near, far: Math.min(camera.far, 500) };
}

export function createClusteredLighting() {
    // ---- storage buffers (CPU-written each frame) ----------------------
    // Light params.
    const lightBuffer = instancedArray(MAX_LIGHTS * LIGHT_STRIDE, 'float');
    const lightArray = lightBuffer.value.array;          // Float32Array view
    // Per-cluster (offset, count) into the flat index list.
    const clusterBuffer = instancedArray(CLUSTER_COUNT * 2, 'uint');
    const clusterArray = clusterBuffer.value.array;      // Uint32Array
    // Flat light-index list (concatenated per-cluster index runs).
    const indexBuffer = instancedArray(INDEX_LIST_LEN, 'uint');
    const indexArray = indexBuffer.value.array;          // Uint32Array

    // Grid uniforms used by the fragment shader to find its cluster.
    const uGrid = uniform(new THREE.Vector3(TILES_X, TILES_Y, Z_SLICES));
    const uViewport = uniform(new THREE.Vector2(1, 1));
    const uNearFar = uniform(new THREE.Vector2(0.1, 500));
    const uLightCount = uniform(0);

    // Scratch for binning.
    const _vp = new THREE.Vector3();
    const _center = new THREE.Vector3();
    const _dir = new THREE.Vector3();

    // ---- per-frame update: pack lights + bin into clusters -------------
    // Called once per frame BEFORE render with the live scene + camera.
    function update(scene, camera, renderer) {
        const { near, far } = sliceNearFar(camera);
        uNearFar.value.set(near, far);
        const size = renderer.getSize(new THREE.Vector2());
        uViewport.value.set(size.x, size.y);

        // Collect point + spot lights.
        const lights = [];
        scene.traverse((o) => {
            if (!o.visible) return;
            if ((o.isPointLight || o.isSpotLight) && o.intensity > 0) lights.push(o);
        });
        const count = Math.min(lights.length, MAX_LIGHTS);
        uLightCount.value = count;

        camera.updateMatrixWorld();
        const viewMatrix = camera.matrixWorldInverse;

        // Pack each light into view space.
        const lightViewData = [];   // {cx,cy,cz,radius} in view space for binning
        for (let i = 0; i < count; i++) {
            const L = lights[i];
            L.getWorldPosition(_center);
            _vp.copy(_center).applyMatrix4(viewMatrix);    // → view space
            const base = i * LIGHT_STRIDE;
            // Effective radius: distance cutoff, else estimate from intensity.
            let radius = L.distance;
            if (!(radius > 0)) radius = Math.sqrt(L.intensity) * 6 + 4;  // heuristic for infinite lights
            lightArray[base + 0] = _vp.x;
            lightArray[base + 1] = _vp.y;
            lightArray[base + 2] = _vp.z;
            lightArray[base + 3] = radius;
            lightArray[base + 4] = L.color.r * L.intensity;
            lightArray[base + 5] = L.color.g * L.intensity;
            lightArray[base + 6] = L.color.b * L.intensity;
            lightArray[base + 7] = L.decay ?? 2;
            if (L.isSpotLight) {
                // Spot direction in view space: normalize(target − position) in
                // world, then rotate into view space (direction transform).
                const wTarget = L.target.getWorldPosition(_dir);
                const wPos = L.getWorldPosition(_center);   // _center reused as light world pos
                wTarget.sub(wPos).normalize().transformDirection(viewMatrix);
                lightArray[base + 8] = wTarget.x;
                lightArray[base + 9] = wTarget.y;
                lightArray[base + 10] = wTarget.z;
                lightArray[base + 11] = 1;                 // type = spot
                lightArray[base + 12] = Math.cos(L.angle * (1 - (L.penumbra ?? 0)));  // cosInner
                lightArray[base + 13] = Math.cos(L.angle); // cosOuter
            } else {
                lightArray[base + 11] = 0;                 // type = point
                lightArray[base + 12] = 0;
                lightArray[base + 13] = 0;
            }
            lightArray[base + 14] = -1;                    // shadowSlot (set by atlas later)
            lightArray[base + 15] = 0;
            lightViewData.push({ x: _vp.x, y: _vp.y, z: _vp.z, r: radius });
        }
        lightBuffer.value.needsUpdate = true;

        binLightsToClusters(lightViewData, camera, near, far);
    }

    // CPU binning: for each cluster (froxel) compute its view-space AABB and
    // test every light sphere against it; write the index runs.
    const _tmpBuckets = Array.from({ length: CLUSTER_COUNT }, () => []);
    function binLightsToClusters(lightViewData, camera, near, far) {
        for (let c = 0; c < CLUSTER_COUNT; c++) _tmpBuckets[c].length = 0;

        // Precompute screen→view scale via the projection matrix.
        const proj = camera.projectionMatrix.elements;
        const sx = proj[0];   // = 1/(tan(fov/2)*aspect) * ... (m00)
        const sy = proj[5];   // m11
        const logFN = Math.log(far / near);

        // For each light, find the froxel range it covers and add it.
        for (let li = 0; li < lightViewData.length; li++) {
            const Lp = lightViewData[li];
            const zc = -Lp.z;                  // view space looks down -Z; depth positive
            const rmin = zc - Lp.r, rmax = zc + Lp.r;
            if (rmax <= near) continue;        // entirely behind near
            // Z-slice range (exponential distribution).
            const zSliceOf = (d) => {
                const dd = Math.max(near, Math.min(far, d));
                return Math.floor((Math.log(dd / near) / logFN) * Z_SLICES);
            };
            const z0 = Math.max(0, zSliceOf(rmin));
            const z1 = Math.min(Z_SLICES - 1, zSliceOf(rmax));

            // Project the light sphere to screen-tile extents at its center depth.
            // ndc radius ≈ r * proj_scale / depth.
            const invZ = 1 / Math.max(near, zc);
            const ndcX = (Lp.x * sx) * invZ;
            const ndcY = (Lp.y * sy) * invZ;
            const ndcR_x = Math.abs(Lp.r * sx) * invZ;
            const ndcR_y = Math.abs(Lp.r * sy) * invZ;
            // ndc [-1,1] → tile [0,TILES]
            const tileMinX = Math.max(0, Math.floor((ndcX - ndcR_x + 1) * 0.5 * TILES_X));
            const tileMaxX = Math.min(TILES_X - 1, Math.floor((ndcX + ndcR_x + 1) * 0.5 * TILES_X));
            const tileMinY = Math.max(0, Math.floor((ndcY - ndcR_y + 1) * 0.5 * TILES_Y));
            const tileMaxY = Math.min(TILES_Y - 1, Math.floor((ndcY + ndcR_y + 1) * 0.5 * TILES_Y));
            if (tileMinX > tileMaxX || tileMinY > tileMaxY) continue;

            for (let z = z0; z <= z1; z++) {
                for (let ty = tileMinY; ty <= tileMaxY; ty++) {
                    for (let tx = tileMinX; tx <= tileMaxX; tx++) {
                        const ci = (z * TILES_Y + ty) * TILES_X + tx;
                        const bucket = _tmpBuckets[ci];
                        if (bucket.length < MAX_LIGHTS_PER_CLUSTER) bucket.push(li);
                    }
                }
            }
        }

        // Flatten buckets → index list + (offset,count) table.
        let cursor = 0;
        for (let c = 0; c < CLUSTER_COUNT; c++) {
            const bucket = _tmpBuckets[c];
            clusterArray[c * 2 + 0] = cursor;
            clusterArray[c * 2 + 1] = bucket.length;
            for (let k = 0; k < bucket.length && cursor < INDEX_LIST_LEN; k++) {
                indexArray[cursor++] = bucket[k];
            }
        }
        clusterBuffer.value.needsUpdate = true;
        indexBuffer.value.needsUpdate = true;
    }

    // ---- the shading loop (TSL) ---------------------------------------
    // Returns a Fn that, given the fragment context, accumulates clustered
    // point/spot light into the lighting model via `model.direct(...)`.
    function buildClusterShade(lightingModel, builder) {
        return Fn(() => {
            const fragView = positionView;                  // view-space frag pos
            const depth = fragView.z.negate();              // positive view depth

            // Find this fragment's cluster.
            const sc = screenCoordinate;                    // pixel coords
            const tileX = sc.x.div(uViewport.x).mul(uGrid.x).floor().clamp(0, uGrid.x.sub(1)).toVar();
            // screenCoordinate.y is top-left origin in WebGPU; tiles use same.
            const tileY = sc.y.div(uViewport.y).mul(uGrid.y).floor().clamp(0, uGrid.y.sub(1)).toVar();
            const near = uNearFar.x, far = uNearFar.y;
            const slice = depth.div(near).log().div(far.div(near).log()).mul(uGrid.z)
                .floor().clamp(0, uGrid.z.sub(1)).toVar();
            const clusterIdx = slice.mul(uGrid.y).add(tileY).mul(uGrid.x).add(tileX).toVar();

            const offset = clusterBuffer.element(clusterIdx.mul(2)).toVar();
            const lcount = clusterBuffer.element(clusterIdx.mul(2).add(1)).toVar();

            Loop({ start: uint(0), end: lcount, type: 'uint', condition: '<' }, ({ i }) => {
                const li = indexBuffer.element(offset.add(i)).toVar();
                const b = li.mul(LIGHT_STRIDE).toVar();
                const lpos = vec3(
                    lightBuffer.element(b),
                    lightBuffer.element(b.add(1)),
                    lightBuffer.element(b.add(2)),
                ).toVar();
                const radius = lightBuffer.element(b.add(3)).toVar();
                const lcolor = vec3(
                    lightBuffer.element(b.add(4)),
                    lightBuffer.element(b.add(5)),
                    lightBuffer.element(b.add(6)),
                ).toVar();
                const decayExp = lightBuffer.element(b.add(7)).toVar();
                const ltype = lightBuffer.element(b.add(11)).toVar();

                const lightVector = lpos.sub(fragView).toVar();
                const lightDist = lightVector.length().toVar();
                const lightDir = lightVector.div(lightDist.max(0.0001)).toVar();

                // Distance attenuation (Frostbite windowed, matching three).
                const distFalloff = lightDist.pow(decayExp).max(0.01).reciprocal().toVar();
                const windowed = radius.greaterThan(0).select(
                    distFalloff.mul(lightDist.div(radius.max(0.0001)).pow(4).oneMinus().clamp().pow(2)),
                    distFalloff,
                ).toVar();
                const atten = windowed.toVar();

                // Spot cone falloff.
                If(ltype.greaterThan(0.5), () => {
                    const spotDir = vec3(
                        lightBuffer.element(b.add(8)),
                        lightBuffer.element(b.add(9)),
                        lightBuffer.element(b.add(10)),
                    );
                    const cosInner = lightBuffer.element(b.add(12));
                    const cosOuter = lightBuffer.element(b.add(13));
                    // angle between -lightDir and spot direction.
                    const cosAngle = spotDir.dot(lightDir.negate());
                    const spotFall = cosAngle.smoothstep(cosOuter, cosInner);
                    atten.mulAssign(spotFall);
                });

                const finalColor = lcolor.mul(atten);

                lightingModel.direct({
                    lightDirection: lightDir,
                    lightColor: finalColor,
                    reflectedLight: builder.context.reflectedLight,
                }, builder);
            });
        });
    }

    // ---- custom LightsNode -----------------------------------------------
    // Subclass three's LightsNode (closes over this factory's buffers/shade fn):
    //   • setLights() filters point/spot OUT of the per-material light list, so
    //     three only builds directional/ambient/hemi nodes (+ env/AO injected by
    //     the material) — the sun keeps its CSM shadow and IBL stays intact.
    //   • setupLights() ALSO emits the clustered point/spot loop into the same
    //     lighting stack (it calls lightingModel.direct, exactly like three's
    //     own analytic light nodes do).
    class ClusteredLightsNode extends LightsNode {
        setLights(lights) {
            const kept = lights.filter((l) => !(l.isPointLight || l.isSpotLight));
            return super.setLights(kept);
        }
        setupLights(builder, lightNodes) {
            super.setupLights(builder, lightNodes);          // dir/ambient/hemi/env/AO
            const lightingModel = builder.context.lightingModel;
            if (lightingModel && builder.context.reflectedLight) {
                buildClusterShade(lightingModel, builder)();  // clustered point/spot
            }
        }
    }

    return {
        update,
        buildClusterShade,
        buffers: { lightBuffer, clusterBuffer, indexBuffer },
        uniforms: { uGrid, uViewport, uNearFar, uLightCount },
        config: { TILES_X, TILES_Y, Z_SLICES, MAX_LIGHTS, LIGHT_STRIDE, MAX_LIGHTS_PER_CLUSTER },
        lightArray,
        ClusteredLightsNode,
        createNode: (lights = []) => new ClusteredLightsNode().setLights(lights),
    };
}
