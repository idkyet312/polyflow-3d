# runtime.js refactor — module boundary map

`src/app/runtime.js` is a ~16,840-line monolith. This documents what was
extracted, and a de-risked plan for the rest, based on a dependency audit
done 2026-05-18.

## Done

### Module 1 — Rogue Waves → `src/gameplay/rogueWaves.js`
- **Status:** extracted, syntax-clean, behavior-preserving. ~617 lines moved.
- **Why it was safe:** uniquely self-contained — cohesive, recent, all
  cross-talk already went through `window.*`, only a handful of inbound deps.
- **Pattern:** `createRogueWaves({deps})` factory, instantiated in the setup
  block right after `bindAppCore(...)`. Reassigned engine vars
  (`scene`/`currentMesh`/`renderer`) read live via `core` from
  `src/runtime/appCore.js`; stable functions/objects injected as `deps`.
- **Seam:** runtime.js keeps placeholder `let` aliases
  (`updateDoomArenaLevelState`, `spawnRogueXpOrb`, …) assigned from the
  factory return in the setup block; call sites unchanged. The shooter-AI
  death hook in `setShooterHealth` was decoupled to call
  `window.rogueWaves.*` instead of bare names.

### Module 2 — Shadow / POM tuning → `src/app/shadowTuning.js`
- **Status:** extracted, syntax-clean, behavior-preserving. ~100 lines moved
  (runtime.js 6966 → 6887). `node --test` green (72 pass).
- **Why it was safe:** five cohesive scene-traversal helpers
  (`requestLightShadowRefresh`, `configurePointLightShadow`,
  `requestScenePointLightShadowRefresh`, `applyPomTuningToScene`,
  `applyShadowTuningToScene`). Zero shared scratch globals, no DOM. The
  cross-module seams already went through dep-injection (worldEnvSystem,
  levels, sceneActorUi all receive them as params), so only the definitions
  moved — call sites unchanged.
- **Pattern:** `createShadowTuning({deps})` factory, instantiated right after
  the `worldEnvSystem` setup. `scene`/`renderer` read live via `core`;
  `worldEnvState` + `perfModeEnabled` passed as **getters** (both
  mutate/reassign post-construction); `setMainLightCSM` passed as a forwarder
  (hoisted decl, defined further down).
- **Seam:** destructured `const { ... } = createShadowTuning(...)` replaces the
  five `function` decls. The lazy dep-passthroughs at the worldEnvSystem call
  (`applyShadowTuningToScene: (...a) => ...`) resolve at invoke-time, after the
  factory binding exists — no TDZ hazard (verified: worldEnvSystem only calls
  them inside `applyWorldEnvState`, never at construction).

### Module 3 — Unreal HUD / widget bridge → `src/app/hudBridge.js`
- **Status:** extracted, syntax-clean, behavior-preserving. ~130 lines moved
  (runtime.js 6887 → 6768). `node --test` green (72 pass).
- **Why it was safe:** self-contained widget-API surface — the lazy `AHUD`
  singleton, `getRuntimeHud`, `createExampleWidgets`, and the two global
  installs (`window.WidgetAPI`, `window.UnrealWidgetAPI`). The previously
  in-runtime weapon-HUD/damage helpers (`ensureWeaponHud`, `setWeaponHud`,
  `showDamageIndicator`, `ensurePlayerHitOverlay`) were already extracted to
  `weaponHud.js` / `playerCombat.js`, so this is the last of the HUD cluster.
- **Pattern:** `createHudBridge({deps})` factory, instantiated right after the
  `_playerCombat` block (needs `gameplay` + `setPlayerHealth`, both live by
  then). `widgetManager` is read via getter — it's constructed mid-init, after
  the bridge. The factory body installs both window APIs immediately; nothing
  reads them before init so the slightly-later install is safe.
- **Seam:** the example HUD overlay still publishes on `window.*`
  (`window.exampleWidgets`, `window.gameHud`, `window.gameScore`) — that
  contract is unchanged, so the score/visibility helpers left in runtime.js
  (`addGameScore`, `setExampleWidgetsVisible`) keep reading them untouched.
  Orphaned `AHUD`/`U*Widget` imports removed from runtime.js (now in hudBridge).
- **Not moved:** `updateGameplayUI` — flagged as high-coupling (broad widget +
  mobile + camera-button state). Defer; needs the camera/mobile-button cluster
  split first.

### Module 4 — Shadow-debug tooling → `src/app/shadowDebug.js`
- **Status:** extracted, syntax-clean, behavior-preserving. ~110 lines moved
  (runtime.js 6768 → 6672). `node --test` green (72 pass).
- **Why it was safe:** cohesive "force all scene meshes to shadow" debug
  feature — six helpers (`formatShadowDebugStatus`, `updateShadowDebugUi`,
  `isShadowForceExcludedObject`, `forceAllSceneMeshShadows`,
  `setForceAllSceneMeshShadowsEnabled`, `tickForceAllSceneMeshShadows`). Only
  `scene`/`renderer` (via core) + two state objects. Cross-module consumers
  (debug/console.js, wirePanelHandlers.js) already receive the functions as
  injected deps, so call sites are unchanged.
- **Pattern:** `createShadowDebug({deps})` factory, instantiated right after the
  `shadowDebugState` const. `formatShadowDebugStatus` /
  `isShadowForceExcludedObject` are factory-private (no external callers); the
  other four are aliased to `const`s for the existing dep-pass blocks.
- **Seam — shared state stays in runtime.js:** `shadowDebugState` (a `const`
  object) and `shadowDebugUiRefs` (assigned mid-init) are injected **by
  reference** into setupDebugConsole / wirePanelHandlers, so they must NOT move
  into the factory closure. The helpers read them via getters instead — the
  shared references keep resolving for every consumer.
- **Note:** the *debug-ray* sibling cluster (`raycastWorld`,
  `updateGameplayDebugRay`, `setRayDebugEnabled`, …) was left in place — it
  depends on physgun (`physgunCameraRay`) + `getActorByBodyId` +
  `updateRaycastDebugLine`, a wider surface. Candidate for a later pass.

### Module 5 — Actor core/instance system → `src/app/actorCore.js`
- **Status:** extracted, syntax-clean, behavior-preserving. ~95 lines moved
  (runtime.js 6672 → 6601). `node --test` green (72 pass).
- **Why it was safe:** cohesive prefab visual-inheritance system — seven
  functions (`getActorCoreInfo`, `getActorCoreId`, `actorInheritsCore`,
  `getActorCoreSource`, `serializeCoreVisualRules`,
  `applyCoreVisualRulesToInstance`, `syncActorCoreInstances`) plus their private
  state (`actorCoreSyncState` signature cache + `_coreInstanceBuckets`). All
  inbound deps are serialize/apply helpers + `getDynamicPropById` —
  dep-injected as forwarders.
- **Pattern:** `createActorCore({deps})` factory, instantiated right before
  `_sceneActorUi` (which consumes `actorInheritsCore` + `getActorCoreSource`).
  `actorCoreSyncState` + buckets moved into the closure (nothing outside reads
  them). Only the 3 externally-used functions are aliased; the other 4 are
  factory-private.
- **Seam:** `actorInheritsCore` / `getActorCoreSource` keep flowing into
  sceneActorUi.js via the existing dep block — call sites unchanged.
  `syncActorCoreInstances` still called from the frame loop via its alias.
  Note: sceneHistory.js has its *own* local `getActorCoreInfo` copy — unrelated,
  not shared, left alone.

## Established conventions for any future extraction

1. Factory `createXxx({deps})` returning an API object (mirrors
   `createPhysgunController`, `setupObjectEvents`, etc.).
2. Reassigned module vars (`scene camera renderer currentMesh
   transformControl`) → read live via `import { core } from
   '../runtime/appCore.js'` then `const { scene } = core;` per call.
   `bindAppCore` is already wired at runtime.js:~16676.
3. Stable engine functions/objects → constructor-injected `deps`.
4. Keep legacy module-scope names as placeholder `let`s in runtime.js,
   assigned from the factory return in the setup block, so the ~dozens of
   scattered call sites need no edits.
5. Cross-module calls → route through the `window.<module>` surface, never
   bare names (decouples the dependency graph; see the death-hook fix).

## Why the rest is NOT easy (audited)

`node --check` only catches syntax. None of the runtime can be exercised
here (WebGPU game). So the bar is: an extraction must be *provably*
behavior-identical by inspection. These slices are not:

### Shooter AI (lines ~2787–4080, ~1300 lines) — HIGH RISK
- Dependency hub: ~40 external calls in/out; Rogue (done), weapons, and FX
  all call into it (`spawnDoomEnemyAt`, `spawnShooterProjectile`,
  `damageShooterAi`, `setShooterHealth`).
- Shares 8 mutable scratch globals with the *rest of the file*:
  `tempVectorA–E`, `tempBoxA`, `_scratchPrefab1/2`, `upVector`. Other
  functions reuse the same `tempVectorA` between calls — splitting risks
  two modules aliasing the same scratch (a correctness hazard invisible to
  syntax check).
- Range is interleaved with **core player/util** code that is NOT shooter
  AI but is called from everywhere: `setPlayerHealth`, `damagePlayer`,
  `queuePlayerDeathRespawn`, `triggerPlayerHitFeedback`,
  `getPointSegmentDistanceSq`. Moving the range as-is would relocate these.

### Level definitions (10956–11788 + 12089–12793, ~1500 lines) — MEDIUM RISK
- Good: **zero shared scratch globals**, single inbound edge
  (`loadSample` → `getBuiltinLevelDefinition`).
- Bad: ~40 injected builder deps (`createMaterial`, `spawnGameplayPrefab`,
  `tagGameplayPrefabActor`, `applyBrickWorldScale`, soccer spawners, …).
- **Straddle:** the doom sprite-sheet system sits *inside* the range at
  11790–12088 (`DOOM_ENEMY_SPRITE_*` consts, `makeDoomEnemySpriteSheet`,
  `updateDoomEnemySpriteAnimation`, `applyDoomEnemySpriteSkin`,
  `makeDoomShotgunSpriteTexture`) but is **shared infra** used by
  shooter-AI code at 3764–3878. A correct cut extracts two non-contiguous
  ranges (10956–11788 and 12089–12793) and leaves the sprite block in
  runtime.js, injecting `makeDoomEnemySpriteSheet` /
  `makeDoomShotgunSpriteTexture` as deps. `afterLoad` closures in the
  level defs capture many builders and must keep resolving post-move.

### Impact FX / decals (3295, 3325, 3352, 4665–4900) — MEDIUM RISK
- `spawnImpactBurst/Tracer/Decal/MuzzleSmoke`, `playImpactSound`,
  `emitShooterDeathEffect`, `updateGameplayEffects`, `clearGameplayEffects`.
- Non-contiguous; shares scratch vectors; tied to the projectile/effect
  pool and the eval'd weapon scripts (`window.spawnImpactDecal` is called
  from `DOOM_SHOTGUN_USER_SCRIPT`).

### HUD/DOM helpers (2865, 4917–4990, 14027) — LOW–MEDIUM RISK
- `ensureWeaponHud`, `setWeaponHud`, `showDamageIndicator`,
  `ensurePlayerHitOverlay`, `updateGameplayUI`. Mostly DOM, few deps —
  the next-best candidate, but `updateGameplayUI` touches widget state
  broadly. Verify widget-binding order before moving.

## Recommended sequence (if/when resumed, with in-game testing each step)

1. **Level definitions** first (no scratch hazard; the two-range +
   sprite-stays carve is documented above). Highest line-count win,
   lowest correctness risk *if the sprite straddle is respected*.
2. **HUD/DOM helpers** (small, low-coupling).
3. **Impact FX** (after weapons, since they co-depend).
4. **Shooter AI** last and only with a scratch-vector audit + the
   player/util functions split out first into a `playerCore` module.
   Highest risk; do not attempt blind.

Each step: extract → `node --check` both files → **user loads the affected
level and plays** → only then proceed. Do not batch.
