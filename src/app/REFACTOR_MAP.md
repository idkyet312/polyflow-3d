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
