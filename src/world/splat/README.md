# Gaussian Splatting

WebGPU-native Gaussian Splatting renderer for PolyFlow. Loads `.splat`, `.ply`,
and `.sog` files; renders anisotropic 2D Gaussians as instanced quads via EWA
splatting.

## Status

**Phase 2.5 in progress.** Phase 1 (renderer + EWA math) and Phase 2 (actor
wrapper + transform fix) are complete. Phase 2.5 adds multi-format loaders so
the viewer can ingest the formats SuperSplat hosting exposes.

- ✅ `splatRenderer.js` — `.splat` parser + EWA Gaussian renderer (Phase 1)
- ✅ `splatRenderer.js` — `W = mat3(view·model)` transform fix (Phase 2)
- ✅ `splatActor.js` — `SplatComponent` + `createSplatActor` + serialization (Phase 2)
- ✅ `init.js` — one-call wire-up for `main.js` (Phase 1 finalization)
- ✅ `loaders/` — format dispatcher + PLY loader + SOG loader (Phase 2.5)
- ✅ Wire splat actor into `src/world/sceneSerialization.js` (Phase 2 follow-up + 2.5)
- ⏳ WebGPU compute depth sort (Phase 3)

See [issue #16](https://github.com/idkyet312/polyflow-3d/issues/16) for the full multi-phase plan.

## Architecture

```
splatRenderer.js   — pure rendering (no scene-system awareness)
├── parseSplat(arrayBuffer)      → typed arrays for the 4 per-splat fields (.splat path)
├── loadSplat(url)               → format-aware fetch + parse (delegates to loaders/)
├── buildSplatMesh(data)         → InstancedBufferGeometry + NodeMaterial
└── addSplatToScene(scene, url)  → load + build + add (bare mesh, no actor)

loaders/           — multi-format ingest
├── index.js
│   ├── detectFormatFromUrl(url)        → 'splat' | 'ply' | 'sog' | null
│   ├── detectFormatFromBuffer(buffer)  → magic-byte sniff (PK / "ply\n")
│   ├── parseSplatBinary(buffer)        → 32-byte .splat (Antimatter15 format)
│   ├── parseSplatAny(buffer, hint?)    → dispatch on detection
│   └── loadSplatAny(url)               → fetch + parseSplatAny(url)
├── ply.js
│   ├── parsePly(arrayBuffer)           → standard 3DGS binary little-endian PLY
│   └── loadPly(url)                    → fetch + parsePly
└── sog.js
    ├── parseSog(arrayBuffer)           → PlayCanvas SuperSplat ZIP+WebP archive
    └── loadSog(url)                    → fetch + parseSog

splatActor.js      — actor / runtime integration
├── SplatComponent extends ActorComponent
│   ├── beginPlay()              → async loadSplat → buildSplatMesh → attach to actor root
│   ├── endPlay()                → dispose mesh + GPU resources
│   ├── _computeBounds(positions)→ PCA-fit Box3 from splat centers
│   └── toJSON()                 → serialization hook
├── createSplatActor({url, name, position})
│   → Actor with kind='splat' + TransformComponent + SplatComponent
├── serializeSplatActor(actor)   / deserializeSplatActor(json)
└── addSplatActorToSceneSystem(sys, opts)  → factory + register + await load

init.js            — one-call wire-up
└── wireSplatDevHooks(scene, sceneSystem?)
    → exposes window.splatRenderer / window.splatActor
    → if ?splat=<url> in URL, auto-loads at origin (uses actor path when SceneSystem given)
```

All loaders return the same normalized shape:
```js
{
  count:     number,
  positions: Float32Array(count * 3),  // raw xyz
  scales:    Float32Array(count * 3),  // already exp(log_scale)
  colors:    Float32Array(count * 4),  // RGBA in [0,1]
  rotations: Float32Array(count * 4),  // quaternion (x,y,z,w), normalized
}
```
This is exactly what `buildSplatMesh` consumes, so swapping in any format
is transparent to the renderer.

The renderer is a single `THREE.Mesh` carrying:

- `InstancedBufferGeometry` — unit quad with 4 per-instance attributes
  (`splatPos`, `splatScale`, `splatColor`, `splatRot`).
- `MeshBasicNodeMaterial` with TSL `vertexNode` + `colorNode`.
  - **Vertex** projects each splat to view space, computes the 3D and 2D
    covariance matrices, eigendecomposes the 2x2 screen-space covariance,
    and expands the unit quad along the eigenaxes with 3-sigma extent.
  - **Fragment** computes the 2D Gaussian alpha from the squared Mahalanobis
    distance (which is `dot(vQuad, vQuad)` thanks to the eigenbasis quad
    expansion) and outputs `(rgb, alpha · exp(-r²/2))`.

Two camera-derived uniforms are refreshed each frame in `onBeforeRender`:
focal length (in pixels) and viewport size.

## Supported formats

### `.splat` — Antimatter15 raw binary

Each splat is exactly **32 bytes, little-endian**:

| Offset | Size | Field          | Encoding                              |
|--------|------|----------------|----------------------------------------|
| 0      | 12   | position xyz   | 3 × float32                           |
| 12     | 12   | scale xyz      | 3 × float32 (already exp(log_scale))  |
| 24     | 4    | color RGBA     | 4 × uint8 → divide by 255             |
| 28     | 4    | rotation xyzw  | 4 × uint8 → `(b - 127.5) / 127.5`     |

File size must be a multiple of 32. No header.

### `.ply` — Standard 3D Gaussian Splatting PLY

The original Kerbl et al. 2023 export format. Binary little-endian PLY with an
ASCII header listing per-vertex properties (`x, y, z, nx, ny, nz, f_dc_0..2,
f_rest_0..44, opacity, scale_0..2, rot_0..3`).

Decoder (`loaders/ply.js`) applies these conversions:
- color: `rgb = clamp(0.5 + 0.282 * f_dc_n, 0, 1)`  (SH C0 band → linear RGB)
- opacity: `alpha = sigmoid(opacity)`
- scale: `Math.exp(scale_n)`
- rotation: PLY stores `(w,x,y,z)` (rot_0 is W); we reorder to `(x,y,z,w)` and renormalize.

`f_rest_*` (higher-order SH bands) is parsed but discarded for now — view-dependent
SH rendering is Phase 1.5.

### `.sog` — PlayCanvas SuperSplat compressed (Self-Organizing Gaussian)

ZIP archive (`PK\x03\x04` magic) containing a `meta.json` plus several
RGBA8888 lossless WebP textures encoding a 2D Morton-sorted grid of Gaussians:

| File                        | Encodes                                              |
|-----------------------------|------------------------------------------------------|
| `meta.json`                 | count, version, per-attribute mins/maxs + codebooks  |
| `means_l.webp` `means_u.webp` | position xyz as 16-bit split (low + high), log-space remapped |
| `quats.webp`                | quaternion: 3 components stored, w reconstructed; alpha tags the omitted slot |
| `scales.webp`               | RGB = codebook indices into `meta.scales.codebook` (log-scale)         |
| `sh0.webp`                  | RGB = codebook indices into `meta.sh0.codebook` (DC SH); A = sigmoid'd opacity |
| `shN_*.webp` (optional)     | higher-order SH bands (palette-compressed, ignored for now)            |

Spec verified against [`playcanvas/splat-transform`'s `read-sog.ts` / `write-sog.ts`](https://github.com/playcanvas/splat-transform).
The loader uses native `DecompressionStream` for any deflated entries (WebPs are
typically stored uncompressed inside the ZIP) and `createImageBitmap` for WebP
decode — no external dependencies.

## How to test

Two-line wire-up into `main.js` — add to the existing `init().then(...)` chain:

```js
import { wireSplatDevHooks } from './src/world/splat/init.js';

init().then(() => wireSplatDevHooks(scene, sceneSystem));   // sceneSystem optional
```

Then visit `http://localhost:5173/?splat=https://huggingface.co/cakewalk/splat-data/resolve/main/nike.splat`
to see a Nike sneaker rendered with anisotropic Gaussians.

When a `SceneSystem` is passed, the splat is registered as a proper Actor
(transform-gizmo editable, serializable). When omitted, falls back to a bare mesh.

In DevTools you can also do:

```js
> await window.splatActor.addSplatActorToSceneSystem(sceneSystem, {
    url: '/path/to/file.splat', name: 'Living Room',
  });
```

**Sample files:**
- Nike sneaker `.splat` (~12 MB, ~250K splats): `https://huggingface.co/cakewalk/splat-data/resolve/main/nike.splat`
- mkkellogg's demo `.splat` files: https://github.com/mkkellogg/GaussianSplats3D/tree/main/demo/assets/data
- "Perseverance rover - Synthetic scene" by @tmate (CC BY 4.0) — exposes both
  `.sog` (84 MB) and `.ply` downloads; great regression test for both new loaders.

**Capture your own:** Polycam (free iOS/Android app) → Splat mode → ~90s
walk-around → export `.splat`. Or use SuperSplat at https://superspl.at to
edit and export `.sog` / `.ply`.

## What's right and what's wrong (intentional limitations)

**Right.** Anisotropic ellipses oriented correctly per splat. The object is
recognizable from any angle. Alpha falls off smoothly. EWA Jacobian + 2x2
eigendecomposition produce the correct screen-space covariance.

**Wrong (deferred).**

- **Sort order** — splats render in file order, so background splats
  sometimes render over foreground ones. Fixed in Phase 3 by adding a
  WebGPU compute depth sort (bitonic or radix).
- **No SH** — splat color doesn't change with view angle. Specular surfaces
  look flat / matte. Add when supporting `.ply` (Phase 1.5).
- **No frustum cull / LOD** — fine for ≤1M splat scenes; will tank with 5M.
  Phase 3.

**Fixed in Phase 2.**

- ~~Splat mesh transform is approximate~~ — `W` now uses `mat3(view·model)`,
  so transformed `SplatActor`s produce correctly-shaped ellipses. ✅

## Phased roadmap

1. ✅ **Phase 1** — MVP loader + renderer.
2. ✅ **Phase 2** — `SplatActor` + transform support.
3. ✅ **Phase 2.5 (this)** — `.ply` and `.sog` loaders, scene serialization wiring.
4. **Phase 3** — WebGPU compute depth sort, frustum cull, LOD.
5. **Phase 4** — Physics collision proxy (voxelize → marching cubes → Jolt static body).
6. **Phase 5 (research)** — DDGI lighting integration (probe sampling or SH bake-down).
7. **Phase 6** — Capture-to-walk loop (Polycam handoff doc, drag-drop ingest).
8. **Future** — view-dependent SH (process `f_rest_*` from PLY and `shN_*` from SOG).
