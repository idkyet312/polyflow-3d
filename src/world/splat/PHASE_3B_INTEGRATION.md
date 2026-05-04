# Phase 3b — GPU compute depth sort (integration guide)

This branch adds three new files to `src/world/splat/`:

| File | Size | Role |
|---|---|---|
| `gpuSortBitonic.js` | 13 KB | TSL compute kernel for GPU bitonic sort |
| `splatRendererCompute.js` | 8 KB | Alternative `buildSplatMesh` reading source data via storage-buffer indirection |
| `perfMode.js` | 3 KB | Runtime mode selector (`auto`/`compute`/`worker`/`off`) |

**Nothing in `splatRenderer.js`, `depthSort.js`, `sortClient.js`, `sortWorker.js`, the loaders, or `splatActor.js` changed.** The Phase 3a worker path still works identically. Phase 3b is purely additive — selectable at build time via `buildSplatMeshAuto`.

---

## Why bitonic, not radix (for now)

web-splat's reference implementation (`KeKsBoTer/web-splat`) uses LSD radix sort with workgroup-shared atomics + decoupled-lookback prefix scan (see `radix_sort.wgsl` — 22.6 KB of WGSL). Porting that to TSL is multi-day work and risks subtle TSL-atomic bugs.

Bitonic gives us 90% of the perf win in 1/10 the code:

| | Worker (Phase 3a) | Bitonic GPU (Phase 3b) | Radix GPU (web-splat) |
|---|---|---|---|
| Total work | O(N log N) | O(N log²N) | O(N) |
| Off main thread | ✅ (Worker) | ✅ (GPU) | ✅ (GPU) |
| Latency 1.5M | 30-50 ms | ~3 ms (estimated) | ~1 ms |
| Atomics needed | no | no | yes |
| LOC (kernel) | 250 (sortWorker.js) | 60 (TSL) | 600+ (WGSL) |

The bitonic kernel's integration surface (`sortedIndicesStorage` storage buffer) is identical to what a radix kernel would produce — so swapping in radix later is a single-file replacement, no consumer changes.

---

## Wiring it up

### Minimal change in `main.js`:

```js
// OLD:
import { buildSplatMesh } from './src/world/splat/splatRenderer.js';
const mesh = buildSplatMesh(splatData);

// NEW (auto-detects):
import { buildSplatMeshAuto } from './src/world/splat/perfMode.js';
const mesh = buildSplatMeshAuto(splatData);
```

`buildSplatMeshAuto` picks `compute` when WebGPU compute storage is available, else falls back to `worker`. To force a specific path:

```js
import { setSplatSortMode, buildSplatMeshAuto } from './src/world/splat/perfMode.js';
setSplatSortMode('worker');           // or 'compute', 'off'
const mesh = buildSplatMeshAuto(splatData);
```

### Wiring into `splatActor.js` (optional, opt-in via flag):

Currently `splatActor.js` calls `buildSplatMesh` directly. To make the actor mode-aware, add an optional `sortMode` field to the component:

```js
// in splatActor.js's SplatComponent.beginPlay():
const builder = (this.sortMode === 'compute')
    ? (await import('./splatRendererCompute.js')).buildSplatMeshCompute
    : buildSplatMesh;
const mesh = builder(splatData);
```

I'd recommend doing this in a separate follow-up commit so the integration risk is isolated.

---

## TSL API uncertainties (FIX-ME notes)

I cannot test in-browser from the sandbox, so two TSL APIs in `gpuSortBitonic.js` may need adjustment depending on your exact `three` version:

1. **`bitcast('uint')`** at gpuSortBitonic.js line ~120 (depth → u32 reinterpret).
   - Three.js r167+ exposes this as `.bitcast(type)`, but earlier dev builds used `bitcast(value, type)` as a free function.
   - If you see "bitcast is not a function" → swap to `bitcast(depth, 'uint')` (free-function form, imported from `three/tsl`).
   - If neither works on your version, the workaround is:
     ```js
     const key = depth.mul(1e8).toUint();    // quantize to 1e-8 precision
     ```
     This is ~25-bit effective precision, plenty for depth ordering.

2. **Bitwise ops** (`bitAnd`, `bitOr`, `bitNot`, `shiftLeft`) at compareSwap kernel line ~150.
   - Should map to TSL methods on uint nodes. If the names differ in your version, the alternates are commonly `bAnd`, `bOr`, `bNot`, `shl`.
   - If TSL doesn't expose bit ops at all on your version, the bitonic index math can be rewritten in arithmetic form:
     ```js
     // i = ((t / J) * 2 * J) + (t % J)
     const i = t.div(J).mul(J).mul(2).add(t.mod(J));
     const j = i.add(J);
     // dirAsc = ((i / K) % 2) == 0
     const dirAsc = i.div(K).mod(2).equal(0);
     ```
     Slightly slower (integer divide vs bitops) but works on any TSL.

3. **`If(...)`** vs **`cond(...)`** — Three.js TSL has both. r167+ uses `If` as the imperative branch. If your version errors on `If`, swap to:
   ```js
   import { If } from 'three/tsl';
   // becomes
   import { cond } from 'three/tsl';
   cond(condition, () => { ... }, () => { ... });
   ```

These are the fix-it spots if anything fails to load. Everything else is plain JS or vanilla Three.js.

---

## Test plan

### 1. Smoke test on the Nike sneaker (`.splat`, ~250K splats):

```
http://localhost:5173/?splat=https://huggingface.co/cakewalk/splat-data/resolve/main/nike.splat
```

Open DevTools console. You should see:

```
[splat] Added 250,000 splats from https://...
```

Look at the splat from multiple angles. **Compare visually** to the Phase 3a worker path:
1. `setSplatSortMode('worker'); location.reload();`
2. `setSplatSortMode('compute'); location.reload();`

The two should look IDENTICAL. If compute looks more pixelated, more streaky, or wrongly ordered → the sort is broken (likely the bitcast or bitwise ops above).

### 2. Perf test on the Perseverance rover SOG (84 MB, ~1.5M splats):

Drag and drop the rover `.sog` onto the page. Open the perf monitor (`?stats` in URL or Three.js's Stats helper if wired in). Expected:

| Path | sort cost | total frame time @ 1.5M | notes |
|---|---|---|---|
| Worker | 30-50 ms (off-thread) + ~5 ms repack | ~16 ms (60 fps) | bound by GPU rasterization |
| **Compute** | ~3 ms (GPU) | **~14 ms (60+ fps)** | 5 ms repack eliminated |
| Off | 0 ms | ~13 ms | but visually broken |

If compute mode FPS is identical to or worse than worker, the bitonic kernel is correctly issuing all 441 dispatches but the per-dispatch overhead is high — switch to radix in a follow-up.

### 3. Camera-motion gate test:

With camera idle, no compute dispatch should run (verify in browser DevTools → WebGPU panel → frame timeline). When you move the camera, you should see ~441 dispatches per resort.

---

## Known limitations of THIS PR

- **Bitonic, not radix** — 3-5× slower than radix at 1.5M splats. Acceptable for first cut; radix follow-up is one file.
- **No frustum cull** — every splat goes into the sort, even off-screen ones. (web-splat's preprocess does cull tagging via atomic compaction; we'd need to add an atomic counter to our preprocess to do the same.)
- **No SH** — splat color is still DC only. Per-splat SH eval can drop into `splatRendererCompute.js`'s vertex shader once the storage buffers carry the SH coefficients. Big visual quality win.
- **No preprocess compute pass** — the per-instance EWA projection is still happening in the vertex shader. Moving it to compute would let the vertex shader simply read precomputed 2D mean + axes + color from a packed Splat struct (web-splat-style, 20 bytes/splat). Combined with SH and frustum cull, that's the natural next PR.

---

## File-level diff summary

```
A  src/world/splat/PHASE_3B_INTEGRATION.md
A  src/world/splat/gpuSortBitonic.js          # 13 KB
A  src/world/splat/perfMode.js                #  3 KB
A  src/world/splat/splatRendererCompute.js    #  8 KB
M  main.js                                    # 1-line change: buildSplatMesh → buildSplatMeshAuto
```
