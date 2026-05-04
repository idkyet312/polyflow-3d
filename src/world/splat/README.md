# Gaussian Splatting

WebGPU-native Gaussian Splatting renderer for PolyFlow. Loads `.splat` files,
renders anisotropic 2D Gaussians as instanced quads via EWA splatting.

## Status

**Phase 2 in progress.** Phase 1 spike (renderer + EWA math) is complete; Phase 2
adds the actor wrapper, transform support, and serialization hooks.

- ✅ `splatRenderer.js` — `.splat` parser + EWA Gaussian renderer (Phase 1)
- ✅ `splatRenderer.js` — `W = mat3(view·model)` transform fix (Phase 2)
- ✅ `splatActor.js` — `SplatComponent` + `createSplatActor` + serialization (Phase 2)
- ✅ `init.js` — one-call wire-up for `main.js` (Phase 1 finalization)
- ⏳ Wire `serializeSplatActor` into `src/world/sceneSerialization.js` (Phase 2 follow-up)
- ⏳ WebGPU compute depth sort (Phase 3)

See [issue #16](https://github.com/idkyet312/polyflow-3d/issues/16) for the full multi-phase plan.

## Architecture

```
splatRenderer.js   — pure rendering (no scene-system awareness)
├── parseSplat(arrayBuffer)      → typed arrays for the 4 per-splat fields
├── loadSplat(url)               → fetch + parse
├── buildSplatMesh(data)         → InstancedBufferGeometry + NodeMaterial
└── addSplatToScene(scene, url)  → load + build + add (bare mesh, no actor)

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

## `.splat` byte layout

Each splat is exactly **32 bytes, little-endian**:

| Offset | Size | Field          | Encoding                              |
|--------|------|----------------|---------------------------------------|
| 0      | 12   | position xyz   | 3 × float32                           |
| 12     | 12   | scale xyz      | 3 × float32 (already exp(log_scale))  |
| 24     | 4    | color RGBA     | 4 × uint8 → divide by 255             |
| 28     | 4    | rotation xyzw  | 4 × uint8 → `(b - 127.5) / 127.5`     |

File size must be a multiple of 32. No header.

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
- Nike sneaker (~12 MB, ~250K splats): `https://huggingface.co/cakewalk/splat-data/resolve/main/nike.splat`
- mkkellogg's demo files: https://github.com/mkkellogg/GaussianSplats3D/tree/main/demo/assets/data

**Capture your own:** Polycam (free iOS/Android app) → Splat mode → ~90s
walk-around → export `.splat`.

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
2. 🟡 **Phase 2 (this)** — `SplatActor` + transform support landed.
   Still to do: wire `serializeSplatActor` into `world/sceneSerialization.js`.
3. **Phase 3** — WebGPU compute depth sort, frustum cull, LOD.
4. **Phase 4** — Physics collision proxy (voxelize → marching cubes → Jolt static body).
5. **Phase 5 (research)** — DDGI lighting integration (probe sampling or SH bake-down).
6. **Phase 6** — Capture-to-walk loop (Polycam handoff doc, drag-drop ingest).
