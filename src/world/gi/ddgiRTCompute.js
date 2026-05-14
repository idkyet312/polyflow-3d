import * as THREE from 'three';
import { MAX_MATERIAL_SLOTS } from './ddgiBVH.js';

export const RAYS_PER_PROBE = 256;
export const OCT_RES = 8;
export const OCT_PAD = 1;
export const OCT_RES_P = OCT_RES + OCT_PAD * 2;
export const OCT_TEXELS = OCT_RES_P * OCT_RES_P;
export const MAX_LIGHTS = 4;
export const DEPTH_RANGE = 50.0;

// SafeRace / Tint bounds-check notes (audited 2026-05-14):
//
// 1. probeOct / probeOctPrev are swapped across passes by JS-side
//    copyBufferToBuffer between dispatches — never read+written by the same
//    dispatch. WebGPU's implicit pass-boundary barrier covers this.
// 2. All dynamic array indices below are explicit clamp/min'd against the
//    same compile-time const used as the array bound. Do NOT replace any
//    clamp() with a logical "if" — the SafeRace failure mode is exactly
//    "compiler proves the branch unreachable then races elide the clamp."
// 3. The 64-entry traversal stack is bounded by `sp < 62` push guards.
//    Both `64` and `62` are kept as WGSL consts (STACK_SIZE / STACK_MAX_SP)
//    so Tint's range analysis can prove `sp < STACK_SIZE` at every access.

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
  // matCount.x = number of valid material slots in matAlbedo/matEmissive.
  // Replaces the old fixed 16-slot cap; the actual data lives in storage
  // buffers below so the count is bounded by GPU memory, not by uniform size.
  matCount:   vec4<f32>,
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
// Bindless-style: one unbounded storage buffer holds both albedo and
// emissive per material, interleaved as [albedo_0, emissive_0, albedo_1,
// emissive_1, ...]. Packing into a single binding keeps the compute stage at
// 7 storage buffers total — baseline WebGPU caps the per-stage count at 8,
// and a separate per-channel binding would push us over on stock devices.
// Indices are clamped against matCount before access so a corrupt triMatId
// can't read past the buffer.
@group(0) @binding(8) var<storage, read> matData: array<vec4<f32>>;

const PI : f32 = 3.14159265358979;

// BVH traversal stack bounds. Pushing requires sp < STACK_MAX_SP so a leaf
// that pushes two children still fits. Keep both as compile-time consts so
// Tint's range analysis can prove all stack[sp] accesses are in-bounds.
const STACK_SIZE: u32 = 64u;
const STACK_MAX_SP: i32 = 62;
// Upper bound for the fixed-size lights array (still in the uniform struct).
// Materials moved to unbounded storage and are clamped against U.matCount.x
// at the access site instead.
const MAX_LIGHTS_U: u32 = ${MAX_LIGHTS}u;

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
  var stack: array<u32, STACK_SIZE>;
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
      if (sp < STACK_MAX_SP) {
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
  var stack: array<u32, STACK_SIZE>;
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
      if (sp < STACK_MAX_SP) {
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

const OCT_RES_U:   u32 = ${OCT_RES}u;
const OCT_RES_F:   f32 = ${OCT_RES}.0;
const OCT_RES_M1:  u32 = ${OCT_RES - 1}u;   // OCT_RES - 1, kept as const for Tint range analysis
const OCT_RES_P_U: u32 = ${OCT_RES_P}u;
const OCT_PAD_U:   u32 = ${OCT_PAD}u;
const OCT_TEX:     u32 = ${OCT_TEXELS}u;

fn sampleProbeOctInterior(probeIdx: u32, n: vec3<f32>) -> vec3<f32> {
  // octEncode returns [0,1], so uv lives in [-0.5, OCT_RES - 0.5].
  // Clamp pre-cast so the i32→u32 cast never sees a negative value.
  let uv = octEncode(n) * OCT_RES_F - 0.5;
  let uvc = clamp(uv, vec2<f32>(0.0), vec2<f32>(f32(OCT_RES_M1)));
  let base = probeIdx * OCT_TEX;
  let x0u = u32(uvc.x);
  let y0u = u32(uvc.y);
  let x1u = min(x0u + 1u, OCT_RES_M1);
  let y1u = min(y0u + 1u, OCT_RES_M1);
  let fx = clamp(uv.x - f32(x0u), 0.0, 1.0);
  let fy = clamp(uv.y - f32(y0u), 0.0, 1.0);
  let i00 = base + (y0u + OCT_PAD_U) * OCT_RES_P_U + (x0u + OCT_PAD_U);
  let i10 = base + (y0u + OCT_PAD_U) * OCT_RES_P_U + (x1u + OCT_PAD_U);
  let i01 = base + (y1u + OCT_PAD_U) * OCT_RES_P_U + (x0u + OCT_PAD_U);
  let i11 = base + (y1u + OCT_PAD_U) * OCT_RES_P_U + (x1u + OCT_PAD_U);
  let c00 = probeOctIn[i00].xyz;
  let c10 = probeOctIn[i10].xyz;
  let c01 = probeOctIn[i01].xyz;
  let c11 = probeOctIn[i11].xyz;
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
    // Clamp against the actual uploaded material count (matCount.x). matData
    // is sized in JS to hold at least 2 * matCount.x vec4s, so the strided
    // reads below are in-bounds even if triMatId is corrupt or stale.
    let matMaxIdx = max(u32(U.matCount.x), 1u) - 1u;
    let matId = min(h.matId, matMaxIdx);
    let albedo = matData[matId * 2u].xyz;
    let emissive = matData[matId * 2u + 1u].xyz;
    // Let emissive materials inject directly into probe radiance and boost
    // their DDGI contribution so emissive bounce reads clearly in-scene.
    radiance = max(emissive * vec3<f32>(3.0), vec3<f32>(0.0));

    let numLights = min(u32(U.numLightsF.x), MAX_LIGHTS_U);
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
  radiance = min(radiance, vec3<f32>(12.0));
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
    // CPU mirror; sized to whatever the BVH built upstream produced. The GPU
    // storage buffer grows in power-of-two steps to amortise reallocation.
    // Interleaved layout: [albedo_0, emissive_0, albedo_1, emissive_1, ...]
    // so a single storage binding holds both channels (per-stage storage
    // buffer count is the limiting resource on baseline WebGPU).
    let materialSlotCount = 0;
    let materialBufferCapacity = 0; // slots the GPU buffer can hold
    let matDataBuf = null;

    function ensureMaterialBuffers(slotsNeeded) {
        // WebGPU storage buffers must be > 0 bytes. Always allocate room for
        // at least one slot so the bind group is valid before any BVH upload.
        const wanted = Math.max(1, slotsNeeded);
        if (matDataBuf && wanted <= materialBufferCapacity) return false;
        let cap = Math.max(MAX_MATERIAL_SLOTS, materialBufferCapacity || MAX_MATERIAL_SLOTS);
        while (cap < wanted) cap *= 2;
        if (matDataBuf) matDataBuf.destroy();
        // 2 vec4s per slot (albedo + emissive), 4 floats each.
        const byteSize = cap * 2 * 4 * 4;
        matDataBuf = device.createBuffer({
            label: 'ddgi-mat-data',
            size: byteSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        materialBufferCapacity = cap;
        return true; // buffer changed -> caller must rebuild bind groups
    }
    ensureMaterialBuffers(MAX_MATERIAL_SLOTS);
    // Zero-fill so the very first bake (before uploadBVH) reads valid data
    // even though no real materials are in yet. Matches the existing probeOct
    // zero-init below.
    device.queue.writeBuffer(matDataBuf, 0, new Float32Array(materialBufferCapacity * 2 * 4));

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
    //   0: numLightsF | 1: panelEmit | 2: probeMin | 3: probeMax
    //   4: probeDimsR | 5: rtMeta    | 6: matCount | 7..: lights[4]*3
    // Materials are no longer packed in the uniform — they live in two
    // storage buffers (bindings 8 and 9). matCount.x is the active slot count.
    const RT_UNIFORM_VEC4S = 7 + MAX_LIGHTS * 3;
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
                { binding: 8, resource: { buffer: matDataBuf } },
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

        // The BVH builder hands back trimmed arrays whose length matches
        // materialSlotCount; ensureMaterialBuffers grows the GPU storage to
        // fit. No 16-slot cap applies on either side anymore.
        const incomingSlots = (bvhData.matAlbedo.length / 4) | 0;
        // Interleave on the fly into a single upload buffer:
        // [albedo_0, emissive_0, albedo_1, emissive_1, ...]
        const packed = new Float32Array(incomingSlots * 2 * 4);
        for (let s = 0; s < incomingSlots; s++) {
            const dstBase = s * 8;
            const srcBase = s * 4;
            packed[dstBase + 0] = bvhData.matAlbedo[srcBase + 0];
            packed[dstBase + 1] = bvhData.matAlbedo[srcBase + 1];
            packed[dstBase + 2] = bvhData.matAlbedo[srcBase + 2];
            packed[dstBase + 3] = bvhData.matAlbedo[srcBase + 3];
            packed[dstBase + 4] = bvhData.matEmissive[srcBase + 0];
            packed[dstBase + 5] = bvhData.matEmissive[srcBase + 1];
            packed[dstBase + 6] = bvhData.matEmissive[srcBase + 2];
            packed[dstBase + 7] = bvhData.matEmissive[srcBase + 3];
        }
        ensureMaterialBuffers(incomingSlots);
        device.queue.writeBuffer(matDataBuf, 0, packed);

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
        // matCount vec4: x = active material slot count (drives the in-shader
        // clamp), y/z/w reserved.
        u[24] = materialSlotCount; u[25] = 0; u[26] = 0; u[27] = 0;

        const lightsBase = 28;
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
    let _activeBakePromise = null;
    let _disposePending = false;
    let _destroyed = false;

    function destroyBuffers() {
      if (_destroyed) return;
      _destroyed = true;
      for (const b of [bvhNodeBuf, bvhIdxBuf, triBuf, triMatBuf, matDataBuf, probePosBuf, rayHitsBuf, probeOctBuf, probeOctPrevBuf, probeDepthBuf, probeOctReadBuf, probeDepthReadBuf, rtUniBuf, seedUniBuf, intUniBuf, smoothUniBuf]) {
        try { b?.unmap?.(); } catch (e) { /* */ }
        try { b?.destroy?.(); } catch (e) { /* */ }
      }
    }

    // Rolling window of recent bake timings. Index 0 is the most recent.
    const _bakeTimings = [];
    const _BAKE_TIMING_CAP = 60;
    function _recordBakeTiming(sample) {
      _bakeTimings.unshift(sample);
      if (_bakeTimings.length > _BAKE_TIMING_CAP) _bakeTimings.length = _BAKE_TIMING_CAP;
    }

    async function bake({ lights, indirectScale = 1.0, hysteresis = 0.92, bounces = 1 }) {
      if (!rtBindGroup || _disposePending || _destroyed) return null;

      const t0 = performance.now();
      let tSubmit = 0;

      const runBake = (async () => {
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
        tSubmit = performance.now();

        if (_readbackBusy || _disposePending || _destroyed) return null;
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
          if (_disposePending || _destroyed) return null;
          return { oct, depth };
        } finally {
          _readbackBusy = false;
          // tSubmit = "CPU work + command submit done". t_end = "GPU work + readback complete".
          // gpu = t_end - tSubmit roughly tracks GPU-bound time; cpu = tSubmit - t0 is JS+encoder build.
          const tEnd = performance.now();
          _recordBakeTiming({
            total: tEnd - t0,
            cpu: tSubmit - t0,
            gpu: tEnd - tSubmit,
            matSlots: materialSlotCount,
            triCount,
            bounces,
            at: tEnd,
          });
        }
      })();

      _activeBakePromise = runBake;
      try {
        return await runBake;
      } finally {
        if (_activeBakePromise === runBake) {
          _activeBakePromise = null;
        }
        if (_disposePending) {
          destroyBuffers();
        }
      }
    }

    function dispose() {
      _disposePending = true;
      if (_activeBakePromise) return;
      destroyBuffers();
    }

    function reset() {
        device.queue.writeBuffer(probeOctBuf, 0, new Float32Array(probeOctBufBytes / 4));
        device.queue.writeBuffer(probeOctPrevBuf, 0, new Float32Array(probeOctBufBytes / 4));
        device.queue.writeBuffer(probeDepthBuf, 0, new Float32Array(PROBE_COUNT * 4));
        _hasBaked = false;
    }

    function getBakeStats({ window = 30 } = {}) {
        // Returns mean / median / p95 of the last `window` successful bakes.
        // Used by the perf-comparison harness; cheap enough to call any time.
        const n = Math.min(window, _bakeTimings.length);
        if (n === 0) return { count: 0 };
        const slice = _bakeTimings.slice(0, n);
        const stats = (key) => {
            const sorted = slice.map((s) => s[key]).sort((a, b) => a - b);
            const sum = sorted.reduce((a, b) => a + b, 0);
            return {
                mean: sum / sorted.length,
                median: sorted[sorted.length >> 1],
                p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
                min: sorted[0],
                max: sorted[sorted.length - 1],
            };
        };
        return {
            count: n,
            total: stats('total'),
            cpu: stats('cpu'),
            gpu: stats('gpu'),
            matSlots: _bakeTimings[0].matSlots,
            triCount: _bakeTimings[0].triCount,
        };
    }

    return {
        uploadBVH,
        setProbeBounds,
        setProbePositions,
        bake,
        reset,
        dispose,
        getBakeStats,
        get probeCount() { return PROBE_COUNT; },
        get raysPerProbe() { return RAYS_PER_PROBE; },
        get materialSlotCount() { return materialSlotCount; },
        get hasBVH() { return !!bvhNodeBuf; },
    };
}
