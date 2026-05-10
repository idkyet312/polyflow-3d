import * as THREE from 'three';
import { MAX_MATERIAL_SLOTS } from './ddgiBVH.js';

export const RAYS_PER_PROBE = 256;
export const OCT_RES = 8;
export const OCT_PAD = 1;
export const OCT_RES_P = OCT_RES + OCT_PAD * 2;
export const OCT_TEXELS = OCT_RES_P * OCT_RES_P;
export const MAX_LIGHTS = 4;
export const DEPTH_RANGE = 50.0;

const RT_WGSL = /* wgsl */`
struct Light {
  posI:    vec4<f32>,
  color:   vec4<f32>,
  dirType: vec4<f32>,
};
struct RTUniforms {
  numLightsF: vec4<f32>,
  panelEmit:  vec4<f32>,
  probeMin:   vec4<f32>,
  probeMax:   vec4<f32>,
  probeDimsR: vec4<f32>,
  rtMeta:     vec4<f32>,
  matAlbedo:  array<vec4<f32>, ${MAX_MATERIAL_SLOTS}>,
  matEmissive:array<vec4<f32>, ${MAX_MATERIAL_SLOTS}>,
  lights:     array<Light, ${MAX_LIGHTS}>,
};
@group(0) @binding(0) var<uniform> U: RTUniforms;
@group(0) @binding(1) var<storage, read> bvhNodes: array<u32>;
@group(0) @binding(2) var<storage, read> bvhTriIdx: array<u32>;
@group(0) @binding(3) var<storage, read> triData:   array<f32>;
@group(0) @binding(4) var<storage, read> triMatId:  array<u32>;
@group(0) @binding(5) var<storage, read> probePos:  array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> probeOctIn: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> rayHits: array<vec4<f32>>;

const PI : f32 = 3.14159265358979;

fn nodeBoundsMin(nodeI: u32) -> vec3<f32> {
  let b = nodeI * 8u;
  return vec3<f32>(bitcast<f32>(bvhNodes[b]), bitcast<f32>(bvhNodes[b+1u]), bitcast<f32>(bvhNodes[b+2u]));
}
fn nodeBoundsMax(nodeI: u32) -> vec3<f32> {
  let b = nodeI * 8u;
  return vec3<f32>(bitcast<f32>(bvhNodes[b+3u]), bitcast<f32>(bvhNodes[b+4u]), bitcast<f32>(bvhNodes[b+5u]));
}
fn nodeIsLeaf(nodeI: u32) -> bool {
  return bvhNodes[nodeI * 8u + 7u] > 0u;
}
fn nodeLeftFirst(nodeI: u32) -> u32 { return bvhNodes[nodeI * 8u + 6u]; }
fn nodeCount(nodeI: u32)  -> u32 { return bvhNodes[nodeI * 8u + 7u]; }
fn nodeRight(nodeI: u32)  -> u32 { return nodeLeftFirst(nodeI) + 1u; }

fn rayAabb(ro: vec3<f32>, invRd: vec3<f32>, bMin: vec3<f32>, bMax: vec3<f32>, tMaxIn: f32) -> vec2<f32> {
  let t1 = (bMin - ro) * invRd;
  let t2 = (bMax - ro) * invRd;
  let tMin = min(t1, t2);
  let tMax = max(t1, t2);
  let tNear = max(max(tMin.x, tMin.y), tMin.z);
  let tFar  = min(min(tMax.x, tMax.y), min(tMax.z, tMaxIn));
  return vec2<f32>(tNear, tFar);
}

struct TriHit { t: f32, u: f32, v: f32 };

fn rayTri(ro: vec3<f32>, rd: vec3<f32>, v0: vec3<f32>, v1: vec3<f32>, v2: vec3<f32>) -> TriHit {
  let e1 = v1 - v0;
  let e2 = v2 - v0;
  let pv = cross(rd, e2);
  let det = dot(e1, pv);
  var hit: TriHit;
  hit.t = -1.0; hit.u = 0.0; hit.v = 0.0;
  if (abs(det) < 1e-8) { return hit; }
  let invDet = 1.0 / det;
  let tv = ro - v0;
  let u = dot(tv, pv) * invDet;
  if (u < 0.0 || u > 1.0) { return hit; }
  let qv = cross(tv, e1);
  let v = dot(rd, qv) * invDet;
  if (v < 0.0 || u + v > 1.0) { return hit; }
  let t = dot(e2, qv) * invDet;
  if (t < 1e-4) { return hit; }
  hit.t = t; hit.u = u; hit.v = v;
  return hit;
}

struct SceneHit {
  hit: bool,
  t: f32,
  pos: vec3<f32>,
  nrm: vec3<f32>,
  matId: u32,
};

fn traceScene(roIn: vec3<f32>, rd: vec3<f32>, tMaxIn: f32) -> SceneHit {
  var result: SceneHit;
  result.hit = false; result.t = tMaxIn;
  result.pos = vec3<f32>(0.0); result.nrm = vec3<f32>(0.0); result.matId = 0u;

  let safeRdX = select(rd.x, 1e-20, abs(rd.x) < 1e-20);
  let safeRdY = select(rd.y, 1e-20, abs(rd.y) < 1e-20);
  let safeRdZ = select(rd.z, 1e-20, abs(rd.z) < 1e-20);
  let invRd = vec3<f32>(1.0 / safeRdX, 1.0 / safeRdY, 1.0 / safeRdZ);
  var stack: array<u32, 64>;
  var sp: i32 = 0;
  stack[0] = 0u;
  sp = 1;

  loop {
    if (sp == 0) { break; }
    sp = sp - 1;
    let nodeI = stack[sp];

    let aabb = rayAabb(roIn, invRd, nodeBoundsMin(nodeI), nodeBoundsMax(nodeI), result.t);
    if (aabb.x > aabb.y || aabb.x > result.t) { continue; }

    if (nodeIsLeaf(nodeI)) {
      let off = nodeLeftFirst(nodeI);
      let cnt = nodeCount(nodeI);
      for (var i: u32 = 0u; i < cnt; i = i + 1u) {
        let triId = bvhTriIdx[off + i];
        let base = triId * 18u;
        let v0 = vec3<f32>(triData[base+0u],  triData[base+1u],  triData[base+2u]);
        let v1 = vec3<f32>(triData[base+6u],  triData[base+7u],  triData[base+8u]);
        let v2 = vec3<f32>(triData[base+12u], triData[base+13u], triData[base+14u]);
        let h = rayTri(roIn, rd, v0, v1, v2);
        if (h.t > 0.0 && h.t < result.t) {
          result.hit = true;
          result.t = h.t;
          result.pos = roIn + rd * h.t;
          let n0 = vec3<f32>(triData[base+3u],  triData[base+4u],  triData[base+5u]);
          let n1 = vec3<f32>(triData[base+9u],  triData[base+10u], triData[base+11u]);
          let n2 = vec3<f32>(triData[base+15u], triData[base+16u], triData[base+17u]);
          let w = 1.0 - h.u - h.v;
          result.nrm = normalize(n0 * w + n1 * h.u + n2 * h.v);
          result.matId = triMatId[triId];
        }
      }
    } else {
      let leftI = nodeLeftFirst(nodeI);
      let rightI = nodeRight(nodeI);
      let leftAabb = rayAabb(roIn, invRd, nodeBoundsMin(leftI), nodeBoundsMax(leftI), result.t);
      let rightAabb = rayAabb(roIn, invRd, nodeBoundsMin(rightI), nodeBoundsMax(rightI), result.t);
      let leftHit = leftAabb.x <= leftAabb.y && leftAabb.x <= result.t;
      let rightHit = rightAabb.x <= rightAabb.y && rightAabb.x <= result.t;
      if (sp < 62) {
        if (leftHit && rightHit) {
          let visitLeftFirst = leftAabb.x <= rightAabb.x;
          stack[sp] = select(leftI, rightI, visitLeftFirst);
          sp = sp + 1;
          stack[sp] = select(rightI, leftI, visitLeftFirst);
          sp = sp + 1;
        } else if (leftHit) {
          stack[sp] = leftI;
          sp = sp + 1;
        } else if (rightHit) {
          stack[sp] = rightI;
          sp = sp + 1;
        }
      }
    }
  }
  return result;
}

fn occluded(ro: vec3<f32>, rd: vec3<f32>, tMax: f32) -> bool {
  let safeRdX = select(rd.x, 1e-20, abs(rd.x) < 1e-20);
  let safeRdY = select(rd.y, 1e-20, abs(rd.y) < 1e-20);
  let safeRdZ = select(rd.z, 1e-20, abs(rd.z) < 1e-20);
  let invRd = vec3<f32>(1.0 / safeRdX, 1.0 / safeRdY, 1.0 / safeRdZ);
  var stack: array<u32, 64>;
  var sp: i32 = 0;
  stack[0] = 0u;
  sp = 1;
  loop {
    if (sp == 0) { break; }
    sp = sp - 1;
    let nodeI = stack[sp];
    let aabb = rayAabb(ro, invRd, nodeBoundsMin(nodeI), nodeBoundsMax(nodeI), tMax);
    if (aabb.x > aabb.y) { continue; }
    if (nodeIsLeaf(nodeI)) {
      let off = nodeLeftFirst(nodeI);
      let cnt = nodeCount(nodeI);
      for (var i: u32 = 0u; i < cnt; i = i + 1u) {
        let triId = bvhTriIdx[off + i];
        let base = triId * 18u;
        let v0 = vec3<f32>(triData[base+0u],  triData[base+1u],  triData[base+2u]);
        let v1 = vec3<f32>(triData[base+6u],  triData[base+7u],  triData[base+8u]);
        let v2 = vec3<f32>(triData[base+12u], triData[base+13u], triData[base+14u]);
        let h = rayTri(ro, rd, v0, v1, v2);
        if (h.t > 0.0 && h.t < tMax) { return true; }
      }
    } else {
      let leftI = nodeLeftFirst(nodeI);
      let rightI = nodeRight(nodeI);
      let leftAabb = rayAabb(ro, invRd, nodeBoundsMin(leftI), nodeBoundsMax(leftI), tMax);
      let rightAabb = rayAabb(ro, invRd, nodeBoundsMin(rightI), nodeBoundsMax(rightI), tMax);
      let leftHit = leftAabb.x <= leftAabb.y;
      let rightHit = rightAabb.x <= rightAabb.y;
      if (sp < 62) {
        if (leftHit && rightHit) {
          let visitLeftFirst = leftAabb.x <= rightAabb.x;
          stack[sp] = select(leftI, rightI, visitLeftFirst); sp = sp + 1;
          stack[sp] = select(rightI, leftI, visitLeftFirst); sp = sp + 1;
        } else if (leftHit) {
          stack[sp] = leftI; sp = sp + 1;
        } else if (rightHit) {
          stack[sp] = rightI; sp = sp + 1;
        }
      }
    }
  }
  return false;
}

fn octEncode(n_in: vec3<f32>) -> vec2<f32> {
  let n = n_in / (abs(n_in.x) + abs(n_in.y) + abs(n_in.z));
  var uv = vec2<f32>(n.x, n.y);
  if (n.z < 0.0) {
    let s = vec2<f32>(select(-1.0, 1.0, uv.x >= 0.0),
                      select(-1.0, 1.0, uv.y >= 0.0));
    uv = (1.0 - abs(vec2<f32>(uv.y, uv.x))) * s;
  }
  return uv * 0.5 + 0.5;
}

const OCT_RES_F: f32 = 8.0;
const OCT_RES_P_U: u32 = ${OCT_RES_P}u;
const OCT_PAD_U: u32 = ${OCT_PAD}u;
const OCT_TEX:   u32 = ${OCT_TEXELS}u;

fn sampleProbeOctInterior(probeIdx: u32, n: vec3<f32>) -> vec3<f32> {
  let uv = octEncode(n) * OCT_RES_F - 0.5;
  let base = probeIdx * OCT_TEX;
  let x0 = clamp(i32(floor(uv.x)), 0, 7);
  let y0 = clamp(i32(floor(uv.y)), 0, 7);
  let x1 = min(x0 + 1, 7);
  let y1 = min(y0 + 1, 7);
  let fx = clamp(uv.x - f32(x0), 0.0, 1.0);
  let fy = clamp(uv.y - f32(y0), 0.0, 1.0);
  let stride = i32(OCT_RES_P_U);
  let pad = i32(OCT_PAD_U);
  let i00 = i32(base) + (y0 + pad) * stride + (x0 + pad);
  let i10 = i32(base) + (y0 + pad) * stride + (x1 + pad);
  let i01 = i32(base) + (y1 + pad) * stride + (x0 + pad);
  let i11 = i32(base) + (y1 + pad) * stride + (x1 + pad);
  let c00 = probeOctIn[u32(i00)].xyz;
  let c10 = probeOctIn[u32(i10)].xyz;
  let c01 = probeOctIn[u32(i01)].xyz;
  let c11 = probeOctIn[u32(i11)].xyz;
  let cx0 = mix(c00, c10, fx);
  let cx1 = mix(c01, c11, fx);
  return mix(cx0, cx1, fy);
}

fn sampleProbeGridOct(p: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
  let dims = U.probeDimsR.xyz;
  let pmin = U.probeMin.xyz;
  let pmax = U.probeMax.xyz;
  let grid = clamp((p - pmin) / (pmax - pmin), vec3<f32>(0.0), vec3<f32>(1.0)) * (dims - vec3<f32>(1.0));
  let baseI = floor(min(grid, dims - vec3<f32>(1.0001)));
  let frac = clamp(grid - baseI, vec3<f32>(0.0), vec3<f32>(1.0));
  let Dx = u32(dims.x);
  let Dy = u32(dims.y);
  var sum = vec3<f32>(0.0);
  var wSum = 0.0;
  for (var cz: i32 = 0; cz < 2; cz = cz + 1) {
    for (var cy: i32 = 0; cy < 2; cy = cy + 1) {
      for (var cx: i32 = 0; cx < 2; cx = cx + 1) {
        let ix = u32(baseI.x) + u32(cx);
        let iy = u32(baseI.y) + u32(cy);
        let iz = u32(baseI.z) + u32(cz);
        let tx = select(1.0 - frac.x, frac.x, cx == 1);
        let ty = select(1.0 - frac.y, frac.y, cy == 1);
        let tz = select(1.0 - frac.z, frac.z, cz == 1);
        let w = max(tx * ty * tz, 1e-5);
        let idx = iz * Dx * Dy + iy * Dx + ix;
        sum = sum + max(sampleProbeOctInterior(idx, n), vec3<f32>(0.0)) * w;
        wSum = wSum + w;
      }
    }
  }
  return sum / max(wSum, 1e-4);
}

fn fibSphere(rayI: u32, total: u32, seed: f32) -> vec3<f32> {
  let golden = 0.5 * (sqrt(5.0) - 1.0);
  let i = f32(rayI) + 0.5;
  let phi = 2.0 * PI * fract(i * golden + seed * golden);
  let cosTheta = 1.0 - 2.0 * (i / f32(total));
  let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
  return vec3<f32>(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let rayId = gid.x;
  let totalRays = u32(U.probeDimsR.w) * u32(U.probeDimsR.x * U.probeDimsR.y * U.probeDimsR.z);
  if (rayId >= totalRays) { return; }
  let raysPer = u32(U.probeDimsR.w);
  let probeIdx = rayId / raysPer;
  let inProbe  = rayId - probeIdx * raysPer;

  let ro = probePos[probeIdx].xyz;
  let rd = fibSphere(inProbe, raysPer, U.rtMeta.z + f32(probeIdx) * 0.61803);

  let h = traceScene(ro, rd, 50.0);
  var radiance = vec3<f32>(0.0);
  var hitDist = 50.0;
  var backface = false;
  if (h.hit) {
    hitDist = h.t;
    backface = dot(rd, h.nrm) > 0.0;
    let albedo = U.matAlbedo[h.matId].xyz;
    let emissive = U.matEmissive[h.matId].xyz;
    let compressedE = emissive / (vec3<f32>(1.0) + emissive * 0.8);
    radiance = compressedE;

    let numLights = u32(U.numLightsF.x);
    for (var li: u32 = 0u; li < numLights; li = li + 1u) {
      let L = U.lights[li];
      let typeF = L.dirType.w;
      var lDir: vec3<f32>;
      var atten: f32;
      var lDist: f32;
      if (typeF < 0.5) {
        // directional: dirType.xyz = direction TO light (already negated from light.target)
        lDir = normalize(L.dirType.xyz);
        atten = 1.0;
        lDist = 1e6;
      } else {
        // point: posI.xyz = world position, posI.w = intensity
        let toLight = L.posI.xyz - h.pos;
        lDist = length(toLight);
        lDir = toLight / max(lDist, 1e-6);
        atten = 1.0 / max(lDist * lDist, 1e-4);
      }
      let nDotL = max(dot(h.nrm, lDir), 0.0);
      if (nDotL > 0.0) {
        let shadowOrigin = h.pos + h.nrm * 1e-3;
        let shadowFar = select(lDist - 1e-3, 1e6, typeF < 0.5);
        if (!occluded(shadowOrigin, lDir, shadowFar)) {
          radiance = radiance + albedo * (L.color.xyz * L.posI.w * nDotL * atten / PI);
        }
      }
    }

    let indirect = max(sampleProbeGridOct(h.pos, h.nrm), vec3<f32>(0.0));
    radiance = radiance + albedo * indirect * U.rtMeta.w / PI;
  }
  radiance = min(radiance, vec3<f32>(3.0));
  let signedDist = select(hitDist, -hitDist, backface);
  rayHits[rayId] = vec4<f32>(radiance, signedDist);
}
`;

const INTEGRATE_WGSL = /* wgsl */`
struct IntUniforms {
  raysPerProbe: u32,
  numProbes: u32,
  depthRange: f32,
  frameSeed: f32,
  hysteresis: f32,
  firstBake: f32,
  _pad0: f32,
  _pad1: f32,
};
@group(0) @binding(0) var<uniform> U: IntUniforms;
@group(0) @binding(1) var<storage, read> rayHits: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> probeOct: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> probeDepth: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read>       probeOctPrev: array<vec4<f32>>;

const PI: f32 = 3.14159265358979;
const OCT_RES: u32 = ${OCT_RES}u;
const OCT_RES_P: u32 = ${OCT_RES_P}u;
const OCT_PAD: u32 = ${OCT_PAD}u;
const OCT_TEX: u32 = ${OCT_TEXELS}u;

fn fibSphere(rayI: u32, total: u32, seed: f32) -> vec3<f32> {
  let golden = 0.5 * (sqrt(5.0) - 1.0);
  let i = f32(rayI) + 0.5;
  let phi = 2.0 * PI * fract(i * golden + seed * golden);
  let cosTheta = 1.0 - 2.0 * (i / f32(total));
  let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
  return vec3<f32>(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);
}

fn octDirFromTexel(tx: u32, ty: u32) -> vec3<f32> {
  let uv = (vec2<f32>(f32(tx), f32(ty)) + 0.5) / f32(OCT_RES);
  let p  = uv * 2.0 - 1.0;
  var n = vec3<f32>(p.x, p.y, 1.0 - abs(p.x) - abs(p.y));
  if (n.z < 0.0) {
    let t = vec2<f32>(n.x, n.y);
    n.x = (1.0 - abs(t.y)) * select(-1.0, 1.0, t.x >= 0.0);
    n.y = (1.0 - abs(t.x)) * select(-1.0, 1.0, t.y >= 0.0);
  }
  return normalize(n);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let probeIdx = gid.x;
  if (probeIdx >= U.numProbes) { return; }
  let raysPer = U.raysPerProbe;

  var depthSum = 0.0;
  var depthSumSq = 0.0;
  var backfaceCount: u32 = 0u;
  for (var i: u32 = 0u; i < raysPer; i = i + 1u) {
    let hit = rayHits[probeIdx * raysPer + i];
    let signedDist = hit.w;
    let dist = min(abs(signedDist), U.depthRange);
    if (signedDist < 0.0) { backfaceCount = backfaceCount + 1u; }
    depthSum   = depthSum   + dist;
    depthSumSq = depthSumSq + dist * dist;
  }
  let backfaceRatio = f32(backfaceCount) / f32(raysPer);
  let wasTrapped = probeDepth[probeIdx].w > 0.5;
  let trapped = select(backfaceRatio > 0.05, backfaceRatio > 0.02, wasTrapped);

  let meanD   = clamp(depthSum   / f32(raysPer), 0.0, U.depthRange);
  let meanDSq = max(meanD * meanD, clamp(depthSumSq / f32(raysPer), 0.0, U.depthRange * U.depthRange));
  probeDepth[probeIdx] = vec4<f32>(meanD, meanDSq, 0.0, select(0.0, 1.0, trapped));

  let raySeed = U.frameSeed;
  for (var ty: u32 = 0u; ty < OCT_RES; ty = ty + 1u) {
    for (var tx: u32 = 0u; tx < OCT_RES; tx = tx + 1u) {
      let outIdx = probeIdx * OCT_TEX + (ty + OCT_PAD) * OCT_RES_P + (tx + OCT_PAD);
      let texelDir = octDirFromTexel(tx, ty);
      var num = vec3<f32>(0.0);
      var den = 0.0;
      for (var i: u32 = 0u; i < raysPer; i = i + 1u) {
        let hit = rayHits[probeIdx * raysPer + i];
        if (hit.w < 0.0) { continue; }
        let rd = fibSphere(i, raysPer, raySeed + f32(probeIdx) * 0.61803);
        let w = max(dot(rd, texelDir), 0.0);
        num = num + hit.xyz * w;
        den = den + w;
      }
      let irr = num / max(den, 1e-4);
      let clamped = clamp(irr, vec3<f32>(0.0), vec3<f32>(8.0));
      let prev = probeOctPrev[outIdx].xyz;
      let useHist = U.hysteresis * (1.0 - U.firstBake);
      let blended = mix(clamped, prev, useHist);
      probeOct[outIdx] = vec4<f32>(blended, 0.0);
    }
  }
}
`;

const SEED_WGSL = /* wgsl */`
struct SeedUniforms { dims: vec4<u32> };
@group(0) @binding(0) var<uniform> U: SeedUniforms;
@group(0) @binding(1) var<storage, read_write> probeOct:   array<vec4<f32>>;
@group(0) @binding(2) var<storage, read>       probeDepth: array<vec4<f32>>;

const OCT_RES: u32 = ${OCT_RES}u;
const OCT_RES_P: u32 = ${OCT_RES_P}u;
const OCT_PAD: u32 = ${OCT_PAD}u;
const OCT_TEX: u32 = ${OCT_TEXELS}u;

fn flatIdx(x: i32, y: i32, z: i32) -> i32 {
  let dx = i32(U.dims.x);
  let dy = i32(U.dims.y);
  return z * dx * dy + y * dx + x;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let probeIdx = gid.x;
  if (probeIdx >= U.dims.w) { return; }
  let trapped = probeDepth[probeIdx].w > 0.5;
  if (!trapped) { return; }

  let dx = i32(U.dims.x);
  let dy = i32(U.dims.y);
  let dz = i32(U.dims.z);
  let z = i32(probeIdx) / (dx * dy);
  let y = (i32(probeIdx) - z * dx * dy) / dx;
  let x = i32(probeIdx) - z * dx * dy - y * dx;

  let off = array<vec3<i32>, 6>(
    vec3<i32>(-1, 0, 0), vec3<i32>(1, 0, 0),
    vec3<i32>(0, -1, 0), vec3<i32>(0, 1, 0),
    vec3<i32>(0, 0, -1), vec3<i32>(0, 0, 1)
  );

  for (var ty: u32 = 0u; ty < OCT_RES; ty = ty + 1u) {
    for (var tx: u32 = 0u; tx < OCT_RES; tx = tx + 1u) {
      let texelIdx = (ty + OCT_PAD) * OCT_RES_P + (tx + OCT_PAD);
      var sum = vec3<f32>(0.0);
      var count = 0.0;
      for (var i: u32 = 0u; i < 6u; i = i + 1u) {
        let o = off[i];
        let nx = x + o.x;
        let ny = y + o.y;
        let nz = z + o.z;
        if (nx < 0 || nx >= dx) { continue; }
        if (ny < 0 || ny >= dy) { continue; }
        if (nz < 0 || nz >= dz) { continue; }
        let nIdx = flatIdx(nx, ny, nz);
        if (probeDepth[nIdx].w > 0.5) { continue; }
        sum = sum + probeOct[u32(nIdx) * OCT_TEX + texelIdx].xyz;
        count = count + 1.0;
      }
      if (count > 0.0) {
        probeOct[probeIdx * OCT_TEX + texelIdx] = vec4<f32>(sum / count, 0.0);
      }
    }
  }
}
`;

const SMOOTH_WGSL = /* wgsl */`
struct SmoothUniforms { radius: i32, _p0: i32, _p1: i32, _p2: i32 };
@group(0) @binding(0) var<uniform> U: SmoothUniforms;
@group(0) @binding(1) var<storage, read>       probeOctPrev: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> probeOct:     array<vec4<f32>>;

const OCT_RES: u32 = ${OCT_RES}u;
const OCT_RES_P: u32 = ${OCT_RES_P}u;
const OCT_PAD: u32 = ${OCT_PAD}u;
const OCT_TEX: u32 = ${OCT_TEXELS}u;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let probeIdx = gid.x;
  let base = probeIdx * OCT_TEX;
  let r = U.radius;
  for (var ty: u32 = 0u; ty < OCT_RES; ty = ty + 1u) {
    for (var tx: u32 = 0u; tx < OCT_RES; tx = tx + 1u) {
      var sum = vec3<f32>(0.0);
      var count = 0.0;
      for (var dy: i32 = -r; dy <= r; dy = dy + 1) {
        for (var dx: i32 = -r; dx <= r; dx = dx + 1) {
          let nx = i32(tx) + dx;
          let ny = i32(ty) + dy;
          if (nx < 0 || nx >= i32(OCT_RES)) { continue; }
          if (ny < 0 || ny >= i32(OCT_RES)) { continue; }
          let srcIdx = (u32(ny) + OCT_PAD) * OCT_RES_P + (u32(nx) + OCT_PAD);
          sum = sum + probeOctPrev[base + srcIdx].xyz;
          count = count + 1.0;
        }
      }
      let dstIdx = (ty + OCT_PAD) * OCT_RES_P + (tx + OCT_PAD);
      probeOct[base + dstIdx] = vec4<f32>(sum / count, 0.0);
    }
  }
}
`;

const BORDER_WGSL = /* wgsl */`
@group(0) @binding(0) var<storage, read_write> probeOct: array<vec4<f32>>;

const OCT_RES: u32 = ${OCT_RES}u;
const OCT_RES_P: u32 = ${OCT_RES_P}u;
const OCT_PAD: u32 = ${OCT_PAD}u;
const OCT_TEX: u32 = ${OCT_TEXELS}u;

fn interiorIdx(ix: u32, iy: u32) -> u32 {
  return (iy + OCT_PAD) * OCT_RES_P + (ix + OCT_PAD);
}
fn paddedIdx(px: u32, py: u32) -> u32 {
  return py * OCT_RES_P + px;
}

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let probeIdx = gid.x;
  let base = probeIdx * OCT_TEX;
  for (var i: u32 = 0u; i < OCT_RES; i = i + 1u) {
    let mi = OCT_RES - 1u - i;
    probeOct[base + paddedIdx(i + OCT_PAD, 0u)] = probeOct[base + interiorIdx(mi, 0u)];
    probeOct[base + paddedIdx(i + OCT_PAD, OCT_RES_P - 1u)] = probeOct[base + interiorIdx(mi, OCT_RES - 1u)];
    probeOct[base + paddedIdx(0u, i + OCT_PAD)] = probeOct[base + interiorIdx(0u, mi)];
    probeOct[base + paddedIdx(OCT_RES_P - 1u, i + OCT_PAD)] = probeOct[base + interiorIdx(OCT_RES - 1u, mi)];
  }
  probeOct[base + paddedIdx(0u, 0u)] = probeOct[base + interiorIdx(OCT_RES - 1u, OCT_RES - 1u)];
  probeOct[base + paddedIdx(OCT_RES_P - 1u, 0u)] = probeOct[base + interiorIdx(0u, OCT_RES - 1u)];
  probeOct[base + paddedIdx(0u, OCT_RES_P - 1u)] = probeOct[base + interiorIdx(OCT_RES - 1u, 0u)];
  probeOct[base + paddedIdx(OCT_RES_P - 1u, OCT_RES_P - 1u)] = probeOct[base + interiorIdx(0u, 0u)];
}
`;

export function createDDGIRTCompute({ renderer, probeDims, probeMin, probeMax }) {
    const device = renderer.backend?.device;
    if (!device) throw new Error('[DDGI RT] WebGPU device unavailable');

    const PROBE_COUNT = probeDims.x * probeDims.y * probeDims.z;
    const TOTAL_RAYS = PROBE_COUNT * RAYS_PER_PROBE;
    const currentProbeMin = probeMin.clone();
    const currentProbeMax = probeMax.clone();

    let bvhNodeBuf = null;
    let bvhIdxBuf = null;
    let triBuf = null;
    let triMatBuf = null;
    let nodeCount = 0;
    let triCount = 0;
    const matAlbedo = new Float32Array(MAX_MATERIAL_SLOTS * 4);
    const matEmissive = new Float32Array(MAX_MATERIAL_SLOTS * 4);
    let materialSlotCount = 0;

    const probePosBuf32 = new Float32Array(PROBE_COUNT * 4);
    const probePosBuf = device.createBuffer({
        label: 'ddgi-probe-positions',
        size: probePosBuf32.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const rayHitsBuf = device.createBuffer({
        label: 'ddgi-ray-hits',
        size: TOTAL_RAYS * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const probeOctBufBytes = PROBE_COUNT * OCT_TEXELS * 16;
    const probeOctBuf = device.createBuffer({
        label: 'ddgi-probe-oct',
        size: probeOctBufBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(probeOctBuf, 0, new Float32Array(probeOctBufBytes / 4));

    const probeOctPrevBuf = device.createBuffer({
        label: 'ddgi-probe-oct-prev',
        size: probeOctBufBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(probeOctPrevBuf, 0, new Float32Array(probeOctBufBytes / 4));

    const probeDepthBuf = device.createBuffer({
        label: 'ddgi-probe-depth',
        size: PROBE_COUNT * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    const probeOctReadBuf = device.createBuffer({
        label: 'ddgi-oct-readback',
        size: probeOctBufBytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const probeDepthReadBuf = device.createBuffer({
        label: 'ddgi-depth-readback',
        size: PROBE_COUNT * 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    // RT uniforms layout (vec4 lanes):
    //   numLightsF.x | panelEmit | probeMin | probeMax | probeDimsR | rtMeta
    //   matAlbedo[16] | matEmissive[16] | lights[4]*3
    const RT_UNIFORM_VEC4S = 6 + MAX_MATERIAL_SLOTS * 2 + MAX_LIGHTS * 3;
    const rtUniBuf32 = new Float32Array(RT_UNIFORM_VEC4S * 4);
    const rtUniBuf = device.createBuffer({
        label: 'ddgi-rt-uniforms',
        size: rtUniBuf32.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const seedUniBuf = device.createBuffer({
        label: 'ddgi-seed-uniforms',
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    {
        const dv = new DataView(new ArrayBuffer(16));
        dv.setUint32(0, probeDims.x, true);
        dv.setUint32(4, probeDims.y, true);
        dv.setUint32(8, probeDims.z, true);
        dv.setUint32(12, PROBE_COUNT, true);
        device.queue.writeBuffer(seedUniBuf, 0, dv.buffer);
    }

    const intUniBuf = device.createBuffer({
        label: 'ddgi-int-uniforms',
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const smoothUniBuf = device.createBuffer({
        label: 'ddgi-smooth-uniforms',
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    {
        const arr = new Int32Array(4);
        arr[0] = 2;
        device.queue.writeBuffer(smoothUniBuf, 0, arr);
    }

    const rtModule = device.createShaderModule({ label: 'ddgi-rt', code: RT_WGSL });
    const intModule = device.createShaderModule({ label: 'ddgi-int', code: INTEGRATE_WGSL });
    const seedModule = device.createShaderModule({ label: 'ddgi-seed', code: SEED_WGSL });
    const smoothModule = device.createShaderModule({ label: 'ddgi-smooth', code: SMOOTH_WGSL });
    const borderModule = device.createShaderModule({ label: 'ddgi-border', code: BORDER_WGSL });

    for (const [label, mod, src] of [['ddgi-rt', rtModule, RT_WGSL], ['ddgi-int', intModule, INTEGRATE_WGSL], ['ddgi-seed', seedModule, SEED_WGSL], ['ddgi-smooth', smoothModule, SMOOTH_WGSL], ['ddgi-border', borderModule, BORDER_WGSL]]) {
        mod.getCompilationInfo?.().then((info) => {
            if (!info?.messages?.length) return;
            const lines = src.split('\n');
            for (const msg of info.messages) {
                const ln = msg.lineNum;
                const ctx = lines.slice(Math.max(0, ln - 2), ln + 1).map((l, i) => `${ln - 1 + i}: ${l}`).join('\n');
                console[msg.type === 'error' ? 'error' : 'warn'](`[${label}] ${msg.type} L${ln}:${msg.linePos}: ${msg.message}\n${ctx}`);
            }
        });
    }

    const rtPipeline = device.createComputePipeline({ layout: 'auto', compute: { module: rtModule, entryPoint: 'main' } });
    const intPipeline = device.createComputePipeline({ layout: 'auto', compute: { module: intModule, entryPoint: 'main' } });
    const seedPipeline = device.createComputePipeline({ layout: 'auto', compute: { module: seedModule, entryPoint: 'main' } });
    const smoothPipeline = device.createComputePipeline({ layout: 'auto', compute: { module: smoothModule, entryPoint: 'main' } });
    const borderPipeline = device.createComputePipeline({ layout: 'auto', compute: { module: borderModule, entryPoint: 'main' } });

    let rtBindGroup = null;
    let intBindGroup = null;
    let seedBindGroup = null;
    let smoothBindGroup = null;
    let borderBindGroup = null;

    function rebuildBindGroups() {
        if (!bvhNodeBuf || !bvhIdxBuf || !triBuf || !triMatBuf) return;
        rtBindGroup = device.createBindGroup({
            layout: rtPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: rtUniBuf } },
                { binding: 1, resource: { buffer: bvhNodeBuf } },
                { binding: 2, resource: { buffer: bvhIdxBuf } },
                { binding: 3, resource: { buffer: triBuf } },
                { binding: 4, resource: { buffer: triMatBuf } },
                { binding: 5, resource: { buffer: probePosBuf } },
                { binding: 6, resource: { buffer: probeOctBuf } },
                { binding: 7, resource: { buffer: rayHitsBuf } },
            ],
        });
        intBindGroup = device.createBindGroup({
            layout: intPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: intUniBuf } },
                { binding: 1, resource: { buffer: rayHitsBuf } },
                { binding: 2, resource: { buffer: probeOctBuf } },
                { binding: 3, resource: { buffer: probeDepthBuf } },
                { binding: 4, resource: { buffer: probeOctPrevBuf } },
            ],
        });
        seedBindGroup = device.createBindGroup({
            layout: seedPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: seedUniBuf } },
                { binding: 1, resource: { buffer: probeOctBuf } },
                { binding: 2, resource: { buffer: probeDepthBuf } },
            ],
        });
        smoothBindGroup = device.createBindGroup({
            layout: smoothPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: smoothUniBuf } },
                { binding: 1, resource: { buffer: probeOctPrevBuf } },
                { binding: 2, resource: { buffer: probeOctBuf } },
            ],
        });
        borderBindGroup = device.createBindGroup({
            layout: borderPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: probeOctBuf } },
            ],
        });
    }

    function uploadBVH(bvhData) {
        if (bvhNodeBuf) bvhNodeBuf.destroy();
        if (bvhIdxBuf) bvhIdxBuf.destroy();
        if (triBuf) triBuf.destroy();
        if (triMatBuf) triMatBuf.destroy();

        bvhNodeBuf = device.createBuffer({
            label: 'ddgi-bvh-nodes',
            size: bvhData.rootBuffer.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(bvhNodeBuf, 0, bvhData.rootBuffer);

        bvhIdxBuf = device.createBuffer({
            label: 'ddgi-bvh-idx',
            size: bvhData.idxBuffer.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(bvhIdxBuf, 0, bvhData.idxBuffer);

        triBuf = device.createBuffer({
            label: 'ddgi-tri-data',
            size: bvhData.triFloatBuf.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(triBuf, 0, bvhData.triFloatBuf);

        triMatBuf = device.createBuffer({
            label: 'ddgi-tri-matid',
            size: bvhData.triMatIds.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(triMatBuf, 0, bvhData.triMatIds);

        nodeCount = bvhData.nodeCount;
        triCount = bvhData.triCount;
        materialSlotCount = bvhData.materialSlotCount;
        matAlbedo.set(bvhData.matAlbedo);
        matEmissive.set(bvhData.matEmissive);

        rebuildBindGroups();
    }

    function setProbeBounds(min, max) {
        currentProbeMin.copy(min);
        currentProbeMax.copy(max);
    }

    function setProbePositions(positions) {
        for (let i = 0; i < positions.length && i < PROBE_COUNT; i++) {
            const p = positions[i];
            probePosBuf32[i * 4 + 0] = p.x;
            probePosBuf32[i * 4 + 1] = p.y;
            probePosBuf32[i * 4 + 2] = p.z;
            probePosBuf32[i * 4 + 3] = 0;
        }
        device.queue.writeBuffer(probePosBuf, 0, probePosBuf32);
    }

    function packRTUniforms({ lights, panelEmission, frameSeed, indirectScale, probeMin: pMin, probeMax: pMax }) {
        const u = rtUniBuf32;
        const numLights = Math.min(lights.length, MAX_LIGHTS);
        u[0] = numLights; u[1] = 0; u[2] = 0; u[3] = 0;
        u[4] = panelEmission?.x || 0; u[5] = panelEmission?.y || 0; u[6] = panelEmission?.z || 0; u[7] = 0;
        u[8] = pMin.x; u[9] = pMin.y; u[10] = pMin.z; u[11] = 0;
        u[12] = pMax.x; u[13] = pMax.y; u[14] = pMax.z; u[15] = 0;
        u[16] = probeDims.x; u[17] = probeDims.y; u[18] = probeDims.z; u[19] = RAYS_PER_PROBE;
        u[20] = nodeCount; u[21] = triCount; u[22] = frameSeed; u[23] = indirectScale;

        const albedoBase = 24;
        for (let i = 0; i < MAX_MATERIAL_SLOTS * 4; i++) u[albedoBase + i] = matAlbedo[i];
        const emBase = albedoBase + MAX_MATERIAL_SLOTS * 4;
        for (let i = 0; i < MAX_MATERIAL_SLOTS * 4; i++) u[emBase + i] = matEmissive[i];

        const lightsBase = emBase + MAX_MATERIAL_SLOTS * 4;
        for (let li = 0; li < MAX_LIGHTS; li++) {
            const off = lightsBase + li * 12;
            u[off + 0] = 0; u[off + 1] = 0; u[off + 2] = 0; u[off + 3] = 0;
            u[off + 4] = 0; u[off + 5] = 0; u[off + 6] = 0; u[off + 7] = 0;
            u[off + 8] = 0; u[off + 9] = 0; u[off + 10] = 0; u[off + 11] = 0;
            if (li >= numLights) continue;
            const L = lights[li];
            u[off + 0] = L.posI?.x || 0;
            u[off + 1] = L.posI?.y || 0;
            u[off + 2] = L.posI?.z || 0;
            u[off + 3] = L.posI?.w || 0; // intensity
            u[off + 4] = L.color?.r || 0;
            u[off + 5] = L.color?.g || 0;
            u[off + 6] = L.color?.b || 0;
            u[off + 7] = 0;
            u[off + 8] = L.dir?.x || 0;
            u[off + 9] = L.dir?.y || 0;
            u[off + 10] = L.dir?.z || 0;
            u[off + 11] = L.type === 'directional' ? 0 : 1;
        }
        device.queue.writeBuffer(rtUniBuf, 0, u);
    }

    function writeIntegrateUniforms({ frameSeed, hysteresis, firstBake }) {
        const arr = new ArrayBuffer(32);
        const dv = new DataView(arr);
        dv.setUint32(0, RAYS_PER_PROBE, true);
        dv.setUint32(4, PROBE_COUNT, true);
        dv.setFloat32(8, DEPTH_RANGE, true);
        dv.setFloat32(12, frameSeed, true);
        dv.setFloat32(16, hysteresis, true);
        dv.setFloat32(20, firstBake ? 1.0 : 0.0, true);
        device.queue.writeBuffer(intUniBuf, 0, arr);
    }

    let _readbackBusy = false;
    let _hasBaked = false;

    async function bake({ lights, indirectScale = 1.0, hysteresis = 0.92, bounces = 1 }) {
        if (!rtBindGroup) return null;

        for (let b = 0; b < bounces; b++) {
            const enc = device.createCommandEncoder({ label: 'ddgi-bake' });
            // snapshot prev at the very start of bake
            if (b === 0) enc.copyBufferToBuffer(probeOctBuf, 0, probeOctPrevBuf, 0, probeOctBufBytes);
            const seed = Math.random();
            packRTUniforms({ lights, panelEmission: { x: 0, y: 0, z: 0 }, frameSeed: seed, indirectScale, probeMin: currentProbeMin, probeMax: currentProbeMax });
            const isLastBounce = b === bounces - 1;
            writeIntegrateUniforms({
                frameSeed: seed,
                hysteresis: isLastBounce ? hysteresis : 0.0,
                firstBake: !_hasBaked,
            });

            // RT
            {
                const pass = enc.beginComputePass({ label: 'ddgi-rt-pass' });
                pass.setPipeline(rtPipeline);
                pass.setBindGroup(0, rtBindGroup);
                pass.dispatchWorkgroups(Math.ceil(TOTAL_RAYS / 64));
                pass.end();
            }
            // Integrate
            {
                const pass = enc.beginComputePass({ label: 'ddgi-int-pass' });
                pass.setPipeline(intPipeline);
                pass.setBindGroup(0, intBindGroup);
                pass.dispatchWorkgroups(Math.ceil(PROBE_COUNT / 64));
                pass.end();
            }
            // Seed (trapped)
            {
                const pass = enc.beginComputePass({ label: 'ddgi-seed-pass' });
                pass.setPipeline(seedPipeline);
                pass.setBindGroup(0, seedBindGroup);
                pass.dispatchWorkgroups(Math.ceil(PROBE_COUNT / 64));
                pass.end();
            }
            // Smooth (read prev → write current)
            enc.copyBufferToBuffer(probeOctBuf, 0, probeOctPrevBuf, 0, probeOctBufBytes);
            {
                const pass = enc.beginComputePass({ label: 'ddgi-smooth-pass' });
                pass.setPipeline(smoothPipeline);
                pass.setBindGroup(0, smoothBindGroup);
                pass.dispatchWorkgroups(PROBE_COUNT);
                pass.end();
            }
            // Border mirror
            {
                const pass = enc.beginComputePass({ label: 'ddgi-border-pass' });
                pass.setPipeline(borderPipeline);
                pass.setBindGroup(0, borderBindGroup);
                pass.dispatchWorkgroups(PROBE_COUNT);
                pass.end();
            }
            device.queue.submit([enc.finish()]);
        }
        _hasBaked = true;

        if (_readbackBusy) return null;
        _readbackBusy = true;
        const readEnc = device.createCommandEncoder({ label: 'ddgi-readback' });
        readEnc.copyBufferToBuffer(probeOctBuf, 0, probeOctReadBuf, 0, probeOctBufBytes);
        readEnc.copyBufferToBuffer(probeDepthBuf, 0, probeDepthReadBuf, 0, PROBE_COUNT * 16);
        device.queue.submit([readEnc.finish()]);

        try {
            await Promise.all([
                probeOctReadBuf.mapAsync(GPUMapMode.READ),
                probeDepthReadBuf.mapAsync(GPUMapMode.READ),
            ]);
            const oct = new Float32Array(probeOctReadBuf.getMappedRange().slice(0));
            const depth = new Float32Array(probeDepthReadBuf.getMappedRange().slice(0));
            probeOctReadBuf.unmap();
            probeDepthReadBuf.unmap();
            return { oct, depth };
        } finally {
            _readbackBusy = false;
        }
    }

    function dispose() {
        for (const b of [bvhNodeBuf, bvhIdxBuf, triBuf, triMatBuf, probePosBuf, rayHitsBuf, probeOctBuf, probeOctPrevBuf, probeDepthBuf, probeOctReadBuf, probeDepthReadBuf, rtUniBuf, seedUniBuf, intUniBuf, smoothUniBuf]) {
            try { b?.destroy?.(); } catch (e) { /* */ }
        }
    }

    function reset() {
        device.queue.writeBuffer(probeOctBuf, 0, new Float32Array(probeOctBufBytes / 4));
        device.queue.writeBuffer(probeOctPrevBuf, 0, new Float32Array(probeOctBufBytes / 4));
        device.queue.writeBuffer(probeDepthBuf, 0, new Float32Array(PROBE_COUNT * 4));
        _hasBaked = false;
    }

    return {
        uploadBVH,
        setProbeBounds,
        setProbePositions,
        bake,
        reset,
        dispose,
        get probeCount() { return PROBE_COUNT; },
        get raysPerProbe() { return RAYS_PER_PROBE; },
        get materialSlotCount() { return materialSlotCount; },
        get hasBVH() { return !!bvhNodeBuf; },
    };
}
