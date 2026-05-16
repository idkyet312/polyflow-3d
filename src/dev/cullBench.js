// ──────────────────────────────────────────────────────────────────────────
// Phase 0 — Proof-on-hardware benchmark gate (see plan:
//   the-nullgraph-engine-data-oriented-groovy-cocoa.md)
//
// THROWAWAY, dev-only. Activated by `?bench=cull` in the URL. Builds an
// isolated WebGPU scene (NO DDGI / post / physics — clean signal) and
// measures three rendering strategies at several instance counts:
//
//   1. baseline   N individual THREE.Mesh                (draw calls = N)
//   2. instanced  one THREE.InstancedMesh, no culling      (draw calls = 1)
//   3. gpucull    InstancedMesh + raw-WGSL compute frustum cull writing a
//                 compacted instance buffer + indirect args, ONE
//                 drawIndexedIndirect                        (draw calls = 1)
//
// Config 3 mirrors the proven raw-WebGPU pattern in
// src/world/gi/ddgiRTCompute.js (renderer.backend.device → createBuffer →
// createComputePipeline → beginComputePass → dispatchWorkgroups → submit),
// plus a renderPass.drawIndexedIndirect(). This file does not touch any
// engine subsystem; if Phase 0's gate passes, the compute pass graduates
// into Phase A and this scaffold is deleted.
//
// Measurement: reuses the renderer's GPU timestamp
// (resolveTimestampsAsync('render')) for GPU ms, performance.now() for CPU
// ms, renderer.info.render.drawCalls for draw count, performance.memory for
// heap delta. 60-frame warmup, 300-frame average per (config, N).
// ──────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';

const N_VALUES = [1000, 10000, 50000, 100000];
const WARMUP_FRAMES = 60;
const MEASURE_FRAMES = 300;

// Scatter volume MUCH larger than the frustum so a large, roughly stable
// fraction of instances is off-screen → culling has real work to skip.
const SCATTER_HALF = 600; // instances in [-600,600]^3
const CAM_RADIUS = 220;   // camera orbits inside the cloud

// One shared low-poly box geometry for every config (matches the
// "duplicated prefab box" case the real engine has).
function makeBoxGeometry() {
    const g = new THREE.BoxGeometry(4, 4, 4);
    // Ensure indexed (BoxGeometry already is) — needed for indexed indirect.
    return g;
}

// Deterministic scatter so every config/N sees the SAME layout.
function scatter(i, n) {
    // cheap hash → 3 decorrelated [0,1) streams
    const h = (s) => {
        let x = Math.sin((i + 1) * 12.9898 + s * 78.233) * 43758.5453;
        return x - Math.floor(x);
    };
    return [
        (h(1) * 2 - 1) * SCATTER_HALF,
        (h(2) * 2 - 1) * SCATTER_HALF,
        (h(3) * 2 - 1) * SCATTER_HALF,
    ];
}

// ── Config 1: N individual meshes ─────────────────────────────────────────
function buildBaseline(scene, geo, mat, n) {
    const meshes = [];
    for (let i = 0; i < n; i++) {
        const m = new THREE.Mesh(geo, mat);
        const [x, y, z] = scatter(i, n);
        m.position.set(x, y, z);
        m.updateMatrix();
        m.matrixAutoUpdate = false;
        scene.add(m);
        meshes.push(m);
    }
    return { dispose: () => meshes.forEach((m) => scene.remove(m)) };
}

// ── Config 2: one InstancedMesh, no culling ───────────────────────────────
function buildInstanced(scene, geo, mat, n) {
    const im = new THREE.InstancedMesh(geo, mat, n);
    im.frustumCulled = false; // we measure raw instanced cost, no CPU cull
    const t = new THREE.Object3D();
    for (let i = 0; i < n; i++) {
        const [x, y, z] = scatter(i, n);
        t.position.set(x, y, z);
        t.updateMatrix();
        im.setMatrixAt(i, t.matrix);
    }
    im.instanceMatrix.needsUpdate = true;
    scene.add(im);
    return { dispose: () => scene.remove(im) };
}

// ── Config 3: instanced + raw-WGSL GPU frustum cull + drawIndexedIndirect ──
//
// We keep Three rendering OFF for this config's draw and instead encode our
// own command buffer each frame: compute pass (cull → compacted instances +
// indirect args) then a render pass doing one drawIndexedIndirect. This is
// the apples-to-apples "GPU-driven" path. It reuses the device Three already
// created (renderer.backend.device), exactly like ddgiRTCompute.js.

const CULL_WGSL = /* wgsl */`
struct Cam { viewProj: mat4x4<f32>, };
struct DrawArgs {
  indexCount: u32, instanceCount: atomic<u32>,
  firstIndex: u32, baseVertex: u32, firstInstance: u32,
};
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var<storage, read> srcPos: array<vec4<f32>>; // xyz = world pos
@group(0) @binding(2) var<storage, read_write> dstPos: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> args: DrawArgs;
@group(0) @binding(4) var<uniform> params: vec4<u32>; // x = count

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.x) { return; }
  let p = srcPos[i].xyz;
  // clip-space frustum test of the instance center (+ generous radius).
  let clip = cam.viewProj * vec4<f32>(p, 1.0);
  let w = clip.w;
  let r = 6.0; // box half-diagonal-ish guard so edge instances aren't popped
  let inside =
      clip.z >= -w - r && clip.z <= w + r &&
      clip.x >= -w - r && clip.x <= w + r &&
      clip.y >= -w - r && clip.y <= w + r &&
      w > 0.0;
  if (inside) {
    let slot = atomicAdd(&args.instanceCount, 1u);
    dstPos[slot] = vec4<f32>(p, 1.0);
  }
}
`;

// Minimal render shader: instance position from the compacted buffer.
const DRAW_WGSL = /* wgsl */`
struct Cam { viewProj: mat4x4<f32>, };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(0) @binding(1) var<storage, read> inst: array<vec4<f32>>;

struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) n: vec3<f32>, };

@vertex
fn vs(@location(0) p: vec3<f32>, @location(1) nrm: vec3<f32>,
      @builtin(instance_index) ii: u32) -> VSOut {
  var o: VSOut;
  let wp = p + inst[ii].xyz;
  o.pos = cam.viewProj * vec4<f32>(wp, 1.0);
  o.n = nrm;
  return o;
}
@fragment
fn fs(i: VSOut) -> @location(0) vec4<f32> {
  let l = max(dot(normalize(i.n), normalize(vec3<f32>(0.4, 0.8, 0.3))), 0.15);
  return vec4<f32>(vec3<f32>(0.8, 0.5, 0.35) * l, 1.0);
}
`;

async function buildGpuCull(renderer, geo, n, getViewProj) {
    const device = renderer.backend?.device;
    if (!device) throw new Error('no WebGPU device on renderer.backend');

    const posData = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
        const [x, y, z] = scatter(i, n);
        posData[i * 4] = x; posData[i * 4 + 1] = y; posData[i * 4 + 2] = z; posData[i * 4 + 3] = 1;
    }

    const srcBuf = device.createBuffer({
        size: posData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(srcBuf, 0, posData);
    const dstBuf = device.createBuffer({
        size: posData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Geometry buffers (interleave pos+normal into two vertex buffers).
    const pos = geo.attributes.position.array;
    const nrm = geo.attributes.normal.array;
    const idx = geo.index.array;
    const vbPos = device.createBuffer({ size: pos.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const vbNrm = device.createBuffer({ size: nrm.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    // index buffer must be u32 for >65535 verts; box is tiny so cast anyway.
    const idx32 = new Uint32Array(idx);
    const ib = device.createBuffer({ size: idx32.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vbPos, 0, pos);
    device.queue.writeBuffer(vbNrm, 0, nrm);
    device.queue.writeBuffer(ib, 0, idx32);

    // Indirect args: [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
    const argsBuf = device.createBuffer({
        size: 5 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });
    const argsTemplate = new Uint32Array([idx32.length, 0, 0, 0, 0]);

    const camBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const paramBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(paramBuf, 0, new Uint32Array([n, 0, 0, 0]));

    const cullMod = device.createShaderModule({ code: CULL_WGSL });
    const drawMod = device.createShaderModule({ code: DRAW_WGSL });
    const cullPipe = device.createComputePipeline({ layout: 'auto', compute: { module: cullMod, entryPoint: 'main' } });

    const presFmt = navigator.gpu.getPreferredCanvasFormat();
    const drawPipe = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
            module: drawMod, entryPoint: 'vs',
            buffers: [
                { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
                { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
            ],
        },
        fragment: { module: drawMod, entryPoint: 'fs', targets: [{ format: presFmt }] },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });

    const cullBG = device.createBindGroup({
        layout: cullPipe.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: camBuf } },
            { binding: 1, resource: { buffer: srcBuf } },
            { binding: 2, resource: { buffer: dstBuf } },
            { binding: 3, resource: { buffer: argsBuf } },
            { binding: 4, resource: { buffer: paramBuf } },
        ],
    });
    const drawBG = device.createBindGroup({
        layout: drawPipe.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: camBuf } },
            { binding: 1, resource: { buffer: dstBuf } },
        ],
    });

    const ctx = renderer.domElement.getContext('webgpu');
    ctx.configure({ device, format: presFmt, alphaMode: 'opaque' });

    let depthTex = null;
    let depthW = 0, depthH = 0; // GPUTexture.width/height are read-only — track separately
    function ensureDepth(w, h) {
        if (depthTex && depthW === w && depthH === h) return;
        depthTex?.destroy?.();
        depthTex = device.createTexture({
            size: [w, h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        depthW = w; depthH = h;
    }

    function frame() {
        const vp = getViewProj(); // Float32Array(16)
        device.queue.writeBuffer(camBuf, 0, vp);
        device.queue.writeBuffer(argsBuf, 0, argsTemplate); // reset instanceCount=0

        const w = renderer.domElement.width, h = renderer.domElement.height;
        ensureDepth(w, h);

        const enc = device.createCommandEncoder();
        const cp = enc.beginComputePass();
        cp.setPipeline(cullPipe);
        cp.setBindGroup(0, cullBG);
        cp.dispatchWorkgroups(Math.ceil(n / 64));
        cp.end();

        const rp = enc.beginRenderPass({
            colorAttachments: [{
                view: ctx.getCurrentTexture().createView(),
                clearValue: { r: 0.02, g: 0.03, b: 0.05, a: 1 },
                loadOp: 'clear', storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: depthTex.createView(),
                depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store',
            },
        });
        rp.setPipeline(drawPipe);
        rp.setBindGroup(0, drawBG);
        rp.setVertexBuffer(0, vbPos);
        rp.setVertexBuffer(1, vbNrm);
        rp.setIndexBuffer(ib, 'uint32');
        rp.drawIndexedIndirect(argsBuf, 0);
        rp.end();

        device.queue.submit([enc.finish()]);
    }

    function dispose() {
        [srcBuf, dstBuf, vbPos, vbNrm, ib, argsBuf, camBuf, paramBuf].forEach((b) => b.destroy());
        depthTex?.destroy?.();
    }
    return { frame, dispose };
}

// ── Measurement loop ──────────────────────────────────────────────────────
function nowMem() {
    return performance.memory ? performance.memory.usedJSHeapSize : NaN;
}

async function measure(label, n, renderFn, opts) {
    const { renderer, drawCallsOf } = opts;
    let cpuSum = 0, gpuSum = 0, gpuSamples = 0, drawCalls = 0;
    const heap0 = nowMem();

    for (let f = 0; f < WARMUP_FRAMES + MEASURE_FRAMES; f++) {
        const measuring = f >= WARMUP_FRAMES;
        const t0 = performance.now();
        renderFn(f);
        const cpu = performance.now() - t0;

        if (measuring) {
            cpuSum += cpu;
            drawCalls = drawCallsOf();
            const g = renderer._benchGpuMs;
            if (Number.isFinite(g) && g > 0) { gpuSum += g; gpuSamples++; }
        }
        // yield to let the GPU + timestamp resolve flow
        await new Promise(requestAnimationFrame);
    }
    const heap1 = nowMem();
    return {
        label, n,
        cpuMs: +(cpuSum / MEASURE_FRAMES).toFixed(3),
        gpuMs: gpuSamples ? +(gpuSum / gpuSamples).toFixed(3) : NaN,
        drawCalls,
        heapPerFrameKB: Number.isFinite(heap0)
            ? +(((heap1 - heap0) / MEASURE_FRAMES) / 1024).toFixed(2) : NaN,
    };
}

function fmtTable(rows) {
    const head = '| Config | N | CPU ms | GPU ms | Draw calls | Heap KB/frame |';
    const sep = '|---|---:|---:|---:|---:|---:|';
    const body = rows.map((r) =>
        `| ${r.label} | ${r.n} | ${r.cpuMs} | ${Number.isFinite(r.gpuMs) ? r.gpuMs : 'n/a'} | ${r.drawCalls} | ${Number.isFinite(r.heapPerFrameKB) ? r.heapPerFrameKB : 'n/a'} |`);
    return [head, sep, ...body].join('\n');
}

export async function runCullBench() {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;background:#0a0d12;color:#cde;font:13px/1.5 monospace;z-index:99999;padding:16px;overflow:auto;white-space:pre-wrap';
    host.textContent = 'Phase 0 cull benchmark — initializing WebGPU…\n';
    document.body.appendChild(host);
    const log = (s) => { host.textContent += s + '\n'; console.log(s); };

    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    const renderer = new WebGPURenderer({ canvas, antialias: false, trackTimestamp: true });
    await renderer.init();
    renderer.setSize(1280, 720, false);

    // Reuse the engine's GPU-timestamp signal pattern: drain
    // resolveTimestampsAsync('render') each frame, stash latest on the
    // renderer so measure() can read it.
    renderer._benchGpuMs = NaN;
    let tsPending = false;
    const drainTs = () => {
        if (!renderer.backend?.trackTimestamp || tsPending) return;
        tsPending = true;
        renderer.resolveTimestampsAsync?.('render')
            ?.then((d) => { if (Number.isFinite(d) && d >= 0) renderer._benchGpuMs = d; })
            .catch(() => {})
            .finally(() => { tsPending = false; });
    };

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1280 / 720, 0.5, 4000);
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const dl = new THREE.DirectionalLight(0xffffff, 1.0);
    dl.position.set(1, 1, 1);
    scene.add(dl);

    const geo = makeBoxGeometry();
    const mat = new THREE.MeshStandardMaterial({ color: 0xcc8055, roughness: 0.8 });

    let camAngle = 0;
    const tmpVP = new THREE.Matrix4();
    function tickCamera() {
        camAngle += 0.01;
        camera.position.set(Math.cos(camAngle) * CAM_RADIUS, 40, Math.sin(camAngle) * CAM_RADIUS);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld();
    }
    function viewProj() {
        camera.updateMatrixWorld();
        tmpVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        return new Float32Array(tmpVP.elements);
    }
    const drawCallsOf = () => renderer.info.render.drawCalls;

    const rows = [];
    const opts = { renderer, drawCallsOf };

    for (const n of N_VALUES) {
        log(`\n=== N = ${n} ===`);

        // 1. baseline
        {
            const built = buildBaseline(scene, geo, mat, n);
            const r = await measure('baseline', n, () => {
                tickCamera();
                renderer.render(scene, camera);
                drainTs();
            }, opts);
            built.dispose();
            rows.push(r); log(`baseline   cpu=${r.cpuMs} gpu=${r.gpuMs} draws=${r.drawCalls}`);
        }
        // 2. instanced
        {
            const built = buildInstanced(scene, geo, mat, n);
            const r = await measure('instanced', n, () => {
                tickCamera();
                renderer.render(scene, camera);
                drainTs();
            }, opts);
            built.dispose();
            rows.push(r); log(`instanced  cpu=${r.cpuMs} gpu=${r.gpuMs} draws=${r.drawCalls}`);
        }
        // 3. gpucull (own command stream, Three not used for the draw)
        {
            let gc;
            try {
                gc = await buildGpuCull(renderer, geo, n, viewProj);
                const r = await measure('gpucull', n, () => {
                    tickCamera();
                    gc.frame();
                    drainTs();
                }, opts);
                gc.dispose();
                // drawCalls from renderer.info is 0 here (we bypass Three);
                // the indirect draw is 1 by construction.
                r.drawCalls = 1;
                rows.push(r); log(`gpucull    cpu=${r.cpuMs} gpu=${r.gpuMs} draws=1 (indirect)`);
            } catch (e) {
                log(`gpucull    FAILED: ${e.message}`);
                rows.push({ label: 'gpucull', n, cpuMs: NaN, gpuMs: NaN, drawCalls: 1, heapPerFrameKB: NaN });
                gc?.dispose?.();
            }
        }
    }

    const table = fmtTable(rows);
    log('\n\n===== PHASE 0 RESULTS =====\n' + table);

    // Gate evaluation
    const byKey = {};
    rows.forEach((r) => { byKey[`${r.label}:${r.n}`] = r; });
    const verdicts = [];
    for (const n of N_VALUES) {
        if (n < 10000) continue;
        const b = byKey[`baseline:${n}`], i = byKey[`instanced:${n}`], g = byKey[`gpucull:${n}`];
        const sum = (r) => (r && Number.isFinite(r.cpuMs) ? r.cpuMs : 0) + (r && Number.isFinite(r.gpuMs) ? r.gpuMs : 0);
        const sb = sum(b), sg = sum(g), si = sum(i);
        if (sg > 0 && sb / sg >= 2) verdicts.push(`N=${n}: gpucull ${(sb / sg).toFixed(2)}× faster than baseline → PASS`);
        else if (si > 0 && sg > 0 && Math.abs(sg - si) / si < 0.15) verdicts.push(`N=${n}: gpucull≈instanced → win is instancing only`);
        else verdicts.push(`N=${n}: gpucull ${(sb / Math.max(sg, 0.001)).toFixed(2)}× vs baseline → below 2× gate`);
    }
    log('\n===== GATE =====\n' + verdicts.join('\n'));
    log('\n(Copy the RESULTS table into the plan file under "Phase 0 Results".)');

    return { rows, table, verdicts };
}
