# Engine Architecture Refactor Plan

Target: lift engine from **6.5/10 → 8+/10** by addressing the six issues called out in the rating. No code changes here — review-only document.

Baseline: `src/app/runtime.js` = **9423 lines**, 213 top-level definitions, 100+ imports, 7 `window.__*` globals, single global `gameplaySystems` registry.

Phases are ordered by **risk × payoff**: cheap/safe first, structural last. Each phase ends with `npm test` (smoke harness) green.

---

## Phase 0 — Safety Net (prereq, 30 min)

Before touching anything load-bearing.

- **0.1** Snapshot baseline: `git stash -u` working tree, branch `refactor/architecture-cleanup` off `17May26WithBetterECS`.
- **0.2** Capture runtime startup log + a 30 s gameplay session video as a behavioural reference.
- **0.3** Extend `tests/smoke.test.js` with assertions for the things this plan touches:
  - `createSystemRegistry()` topo ordering still resolves (already covered? verify).
  - `createEventBus()` listener dispatch order + once/off semantics.
  - `appCore` getter+setter contract (already covered — keep, will be rewritten).
  - New `World` container exports a `gameplaySystems` + `eventBus` per instance.
- **Verification gate:** `node --test tests/smoke.test.js` green.

---

## Phase 1 — Kill `window.__*` globals (low risk, ~1 hr)

Seven leaks in `src/app/runtime.js`:

| Line | Global | Replacement |
|---|---|---|
| 141 | `window.__eventBus` | `globalThis.__POLYFLOW_DEBUG__?.eventBus` (gated) |
| 149 | `window.__gameplaySystems` | same gate |
| 6720 | `window.__assets` | same gate |
| 6721 | `window.__prefabs` | same gate |
| 7517 | `window.__ddgi` | same gate |
| 7518 | `window.__lightmapBaker` | same gate |
| 7521 | `window.__scene` | same gate |

**Action:**
- New module `src/runtime/debugRegistry.js`:
  ```js
  // No body in this plan — sketch only.
  // exposes register(name, ref) + a single getter that the devtools console can read.
  // Only attaches to globalThis when import.meta.env.DEV || ?debug=1 in URL.
  ```
- Replace each leak with `debugRegistry.register('eventBus', eventBus)`.
- Document the debug hooks in `CLAUDE.md`.

**Risk:** very low. Nothing in `src/` actually reads `window.__*` (grep confirmed only writes). External devtools/users may; ship behind dev flag is fine.

**Test gate:** smoke tests + boot dev build + confirm `globalThis.__POLYFLOW_DEBUG__.eventBus` resolves in DevTools.

---

## Phase 2 — Document `appCore` (zero risk, 15 min)

`appCore` is **not** the worst pattern in JS engines — live getters via `Object.defineProperty` is a legitimate workaround for ESM hoisting. But it hides deps, so:

- **2.1** Keep `appCore` as-is for Phase 2.
- **2.2** Add header doc enumerating *every* key bound, who owns it, who reads it. Generate this with a one-off script (`scripts/audit-appcore.mjs`) that greps `core.<key>` across `src/`.
- **2.3** Add a runtime sanity check: when a getter is read for an unbound key, log a warning **once** (currently returns `undefined` silently — bites during refactor).

Why not convert to a real DI container now? **Cost is high (every consumer rewrites), payoff is low until runtime.js is split.** Defer to Phase 6.

---

## Phase 3 — World / Scene isolation for registries (medium risk, ~2 hr)

Today: `eventBus` and `gameplaySystems` are module-scope singletons in `runtime.js`. Multiple worlds, hot-reload, and tests that want a clean bus all break.

**Action:**
- New module `src/runtime/World.js`:
  ```js
  // Sketch:
  // export function createWorld({ id }) {
  //   return {
  //     id,
  //     eventBus: createEventBus(),
  //     systems: createSystemRegistry(),
  //     // future: scene, physicsCore, dispose()
  //   };
  // }
  ```
- `runtime.js` constructs one `defaultWorld = createWorld({ id: 'main' })` and routes today's `eventBus` / `gameplaySystems` references to it.
- `appCore.bindAppCore` adds a `world` getter so extracted modules can pull `world.eventBus`.
- Add `world.dispose()` that calls `eventBus.clear()` + clears registry — useful for tests and level reload.

**Risk:** medium. Anything that captured `eventBus` at module load (closures) keeps working because `defaultWorld.eventBus` is the same object reference. Just be careful nobody re-imports `createEventBus()` and assumes it's the global one.

**Test gate:** smoke tests + new test that creates two worlds, emits on each bus, asserts no cross-talk.

---

## Phase 4 — Extract gameplay system registrations (low risk, ~1 hr)

The bottom of `runtime.js` (lines 9374–9422) is nine `gameplaySystems.register({...})` calls. Pure data + closures over module-scope functions.

**Action:**
- New file `src/gameplay/registerSystems.js`:
  ```js
  // Sketch:
  // export function registerGameplaySystems(systems, deps) {
  //   const { updateShooterSpawners, updateStraightGuns, ... } = deps;
  //   systems.register({ name: 'shooterSpawners', update: (d)=>updateShooterSpawners(d) });
  //   ...
  // }
  ```
- `runtime.js` end-of-file becomes one call: `registerGameplaySystems(defaultWorld.systems, { updateShooterSpawners, ... });`
- Removes 50 lines from runtime.js + concentrates the system ordering decision in one focused file.

**Risk:** very low — pure code motion of pure-function registrations.

**Test gate:** smoke + new test asserting `registerGameplaySystems(sys, mockDeps); sys.getOrder()` returns expected order.

---

## Phase 5 — Extract three cohesive chunks from `runtime.js` (medium risk, ~3 hr each)

Pick the **largest, most self-contained** clusters first. Identified by grouping the 213 top-level defs by topic.

### 5a — `src/app/importedProps.js` (~250 lines, runtime.js 1482–1949)

All `Imported*` / `prop*` helpers: `updatePropImportStatus`, `closePropCollisionPrompt`, `resolvePropCollisionPrompt`, `promptImportedPropCollision`, `createImported*Shape`, `collectImportedComplexHullParts`, `renderImportedPropButtons`, `registerImportedPropTemplate`, `lookupBundleAsset`, `serializeImportedPropTemplate`, `spawnImportedProp`.

Shared state: `importedPropState`, `IMPORTED_*` constants.

**Why it's safe:** group has one inbound seam (`spawnImportedProp`) and one outbound seam (DOM via `propCollisionPrompt`). Internals don't leak.

### 5b — `src/app/vehicleSystem.js` (~400 lines, runtime.js 2054–2459)

All vehicle helpers: `isDrivingVehicle`, `getActiveVehicleProp`, `clearActiveVehicle`, `getVehicleForward`, `resolveVehicleCameraCollision`, `positionVehicleCamera`, `getNearbyVehicle`, `enterVehicle`, `exitVehicle`, `ensureVehicleVisualState`, `updateVehicleVisuals`, `getVehicleVisualBounds`, `createVehicleCollisionShapeFromBounds`.

Shared state: `vehicleState`, `vehicleFx`, `VEHICLE_SETTINGS`.

**Caveat:** depends on `camera`, `scene`, `physics` from appCore. Must take those as constructor params, not import.

### 5c — `src/app/shooterAiVisuals.js` (~330 lines, runtime.js 2593–2902)

`addCircularNavmeshVisual`, `addShooterAiVisual`, `ensureShooterAimWarning`, `updateShooterAimWarning`, `hideShooterAimWarning`, `clearShooterAimWarnings`, `ensureShooterHealthBar`, `setShooterHealth`, `resetShooterAiState`, `damageShooterAi`, `emitShooterDeathEffect`.

**Why pick these three:** each is ~300-400 LOC of cohesive code with a small dependency footprint, removing ~1000 lines from runtime.js. Larger chunks like the `_inputPanels` / `_sceneActorUi` glue (6676–7854) have huge DOM dependency surfaces and are deferred.

**Per-chunk procedure:**
1. Create new file with factory function `createX(deps) { ... return { publicApi }; }`.
2. Move all named state into the closure or returned object — **no module-scope mutable state**.
3. Replace `runtime.js` definitions with `const { fn1, fn2 } = createX({ scene, camera, ... })`.
4. Run smoke + boot + 60 s manual playtest of the affected subsystem (spawn imported prop / enter+exit vehicle / kill an AI).
5. Commit.

**Risk:** medium. The cure for runtime.js disease is also the most likely source of regressions. Single chunk per commit, manual playtest between commits.

**Test gate after all three:** runtime.js drops from 9423 to ~8400 lines. Smoke + manual scenarios.

---

## Phase 6 — Convert `appCore` to explicit DI (medium-high risk, ~2 hr)

Now that ~1000 lines + 3 modules consume services via params, the pattern is established. Convert appCore.

**Action:**
- New `src/runtime/services.js`:
  ```js
  // Sketch:
  // export class Services {
  //   register(key, factory) { ... }   // factory: () => instance, called once
  //   get(key) { ... }                 // throws on unknown key
  // }
  ```
- `runtime.js` constructs `const services = new Services(); services.register('scene', () => scene); ...`.
- Migrate extracted modules to `import { services } from './services.js'` and call `services.get('scene')` inside functions (preserves live-binding semantics).
- Delete `appCore.js` + `bindAppCore` + `setAppCore` + the test that references them. Add a new test for `Services`.

**Why now and not Phase 2:** appCore's getter trick is *fine* until you want compile-time service contracts. Once 3 modules consume services via factory params, the DI shape is obvious and conversion is mechanical.

**Risk:** medium-high — touches every extracted module. But all consumers are now in factories, so the change is a single-line per consumer.

**Test gate:** smoke + boot + 5 min manual playtest covering every Phase-5 subsystem.

---

## Phase 7 — Lint guard against regression (low risk, ~30 min)

- ESLint rule (`no-restricted-globals`): forbid `window.__` writes outside `debugRegistry.js`.
- ESLint rule (`max-lines`): cap `src/app/runtime.js` at 8000, fail CI if exceeded. Tighten quarterly.
- README note: new gameplay systems register via `registerGameplaySystems`, not by editing `runtime.js`.

---

## Out of scope (call out, don't fix)

These are real issues but **not** in this refactor:

- **`runtime.js` from 8400 → 1500 lines.** Requires extracting UI / input / serialization / debug overlays (5 more chunks, ~3 hr each). Schedule as separate effort once Phase 5 lands.
- **Mixed ECS + imperative paradigm.** Components in `src/runtime/components/` are well-typed; `runtime.js` glue is imperative. Full ECS-ification of gameplay = rewrite, not refactor.
- **Single dispatch loop, no fixed-timestep accumulator.** Independent perf issue.
- **No formal scene graph independent of THREE.Object3D.** `SceneNode` exists but is barely used outside actors.

---

## Estimated impact

| Metric | Before | After Phase 7 |
|---|---|---|
| `runtime.js` LOC | 9423 | ~8350 |
| `window.__*` writes outside debug module | 7 | 0 |
| Service-locator hidden deps | ~30 keys via `core.*` | explicit `services.get(...)` calls, lint-greppable |
| Registries that support multiple instances | 0 | both (`World` container) |
| Top-level defs in `runtime.js` | 213 | ~170 |
| Architecture rating | 6.5/10 | ~7.5/10 |

To reach **8+/10** the deferred "5 more chunks" extraction is needed. This plan is the foundation that makes that follow-up mechanical.

---

## Order of execution & checkpoints

1. Phase 0 — branch + safety net.
2. Phase 1 — globals (commit).
3. Phase 2 — appCore docs (commit).
4. Phase 3 — World container (commit + smoke test).
5. Phase 4 — extract registerSystems (commit).
6. Phase 5a — importedProps (commit + manual test).
7. Phase 5b — vehicleSystem (commit + manual test).
8. Phase 5c — shooterAiVisuals (commit + manual test).
9. Phase 6 — Services DI (commit + full manual playtest).
10. Phase 7 — lint guards (commit).

Total: ~12 hr focused work across ~10 commits. Each commit individually revertible.
