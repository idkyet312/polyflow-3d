import * as THREE from 'three';

// Level-state system. Owns the per-level state machines for the built-in
// sample levels:
//
//   doomTest (mini)   - hall ambush → arena wave → final exit guard, plus
//                        a 3×3 cube barrier that drops when the arena wave
//                        is cleared.
//   doomArena (rogue) - just resets the wave wipe + game-mode actor.
//   soccerTargetField - resets the goalie sin-clock + every actor's stored
//                        transform.
//
// Extracted verbatim from runtime.js. The orchestrator (gameplay loop)
// calls updateDoomMiniLevelState() per frame; the reset entry points fire
// from the Stop button + load paths.
//
// Deps — every function the legacy code reached for, injected explicitly:
//   DOOM_ENEMY_PREFAB
//   getCurrentMesh           - live mesh accessor (reassigned on load)
//   getActorRenderObject
//   spawnDoomEnemyAt
//   spawnDynamicPrimitive
//   tintGameplayPrefabActor
//   setActorWorldPositionExact
//   getGameplayPrefabActors  - (type?) => Actor[]
//   hideShooterAimWarning
//   destroyDynamicPhysicsProp
//   getSceneSystem           - () => SceneSystem | null
//   resetGameplayPrefabs
//   spawnGameplayPrefab
//   applyPlayerSpawnFromActor
//   syncGameplaySpawnFromPlayerSpawnActor
//   resetRogueState
//   clearHeldWeapon
//   resetActorToStoredTransform
//   getSoccerGoalieActors
//   soccerGoalieState        - shared { elapsed } counter
export function createLevelStateSystem({
    DOOM_ENEMY_PREFAB,
    getCurrentMesh,
    getActorRenderObject,
    spawnDoomEnemyAt,
    spawnDynamicPrimitive,
    tintGameplayPrefabActor,
    setActorWorldPositionExact,
    getGameplayPrefabActors,
    hideShooterAimWarning,
    destroyDynamicPhysicsProp,
    getSceneSystem,
    resetGameplayPrefabs,
    spawnGameplayPrefab,
    applyPlayerSpawnFromActor,
    syncGameplaySpawnFromPlayerSpawnActor,
    resetRogueState,
    clearHeldWeapon,
    resetActorToStoredTransform,
    getSoccerGoalieActors,
    soccerGoalieState,
}) {
    // ── Doom mini helpers ────────────────────────────────────────────
    function isDoomMiniWaveCleared(actors = []) {
        if (!Array.isArray(actors) || actors.length === 0) return false;
        return actors.every((actor) => {
            const shooter = actor?.userData?.shooterAi;
            const mesh = getActorRenderObject(actor);
            return !actor || shooter?.defeated || mesh?.visible === false;
        });
    }

    function spawnDoomMiniWave(spots = [], label = 'Doom Enemy') {
        const actors = [];
        for (const spot of spots) {
            if (!Array.isArray(spot) || spot.length < 3) continue;
            const actor = spawnDoomEnemyAt(new THREE.Vector3(spot[0], spot[1], spot[2]), {
                label,
                groundY: spot[1],
                health: DOOM_ENEMY_PREFAB.health,
                maxHealth: DOOM_ENEMY_PREFAB.health,
            });
            if (actor) actors.push(actor);
        }
        return actors;
    }

    function createDoomMiniBarrierEntries(anchor = null) {
        if (!Array.isArray(anchor) || anchor.length < 3) return [];
        const entries = [];
        const spacing = 1.6;
        const cubeScale = 0.8;
        const startX = anchor[0] - spacing;
        for (let row = 0; row < 3; row += 1) {
            for (let col = 0; col < 3; col += 1) {
                const activePosition = [startX + col * spacing, anchor[1] + row * spacing, anchor[2]];
                const inactivePosition = [activePosition[0], -48 - row * 4, activePosition[2]];
                const actor = spawnDynamicPrimitive('cube', new THREE.Vector3(...activePosition), cubeScale, {
                    local: false,
                    simulatePhysics: false,
                    skipImpulse: true,
                    includeScripts: false,
                    castShadow: false,
                    receiveShadow: true,
                    userData: { label: 'Arena Gate' },
                    returnActor: true,
                });
                if (!actor) continue;
                tintGameplayPrefabActor(actor, '#5b0f0f', '#ff3030', 1.6);
                setActorWorldPositionExact(actor, inactivePosition, { visible: false });
                entries.push({ actor, activePosition, inactivePosition });
            }
        }
        return entries;
    }

    function setDoomMiniBarrierActive(entries = [], active = false) {
        for (const entry of entries) {
            if (!entry?.actor) continue;
            setActorWorldPositionExact(
                entry.actor,
                active ? entry.activePosition : entry.inactivePosition,
                { visible: active },
            );
        }
    }

    function updateDoomMiniLevelState(subjectPosition = null) {
        const currentMesh = getCurrentMesh();
        const layout = currentMesh?.userData?.doomMiniLevel;
        const state = currentMesh?.userData?.doomMiniLevelState;
        if (!layout || !state || !subjectPosition) return;

        if (!state.hallTriggered && subjectPosition.z <= layout.hallTriggerZ) {
            state.hallTriggered = true;
            state.hallWaveActors = spawnDoomMiniWave(layout.hallWave, 'Doom Ambush');
        }

        if (!state.arenaTriggered && subjectPosition.z <= layout.arenaTriggerZ) {
            state.arenaTriggered = true;
            setDoomMiniBarrierActive(state.arenaBarrier, true);
            state.arenaWaveActors = spawnDoomMiniWave(layout.arenaWave, 'Doom Arena Enemy');
        }

        if (
            state.hallTriggered
            && state.arenaTriggered
            && !state.finalTriggered
            && isDoomMiniWaveCleared(state.hallWaveActors)
            && isDoomMiniWaveCleared(state.arenaWaveActors)
        ) {
            state.finalTriggered = true;
            setDoomMiniBarrierActive(state.arenaBarrier, false);
            state.finalWaveActors = spawnDoomMiniWave(layout.finalWave, 'Doom Exit Guard');
        }

        if (state.finalTriggered && !state.exitUnlocked && isDoomMiniWaveCleared(state.finalWaveActors)) {
            state.exitUnlocked = true;
            setActorWorldPositionExact(state.exitActor, layout.exitTeleporter, { visible: true });
        }
    }

    // ── Reset paths ─────────────────────────────────────────────────
    /** Shared helper: destroy every actor in `set`, run aim-warning hide
     * and physics body cleanup. Used by both doomMini + doomArena reset. */
    function destroyActorSet(set) {
        const sceneSystem = getSceneSystem();
        for (const actor of set) {
            if (!actor) continue;
            hideShooterAimWarning?.(actor);
            destroyDynamicPhysicsProp(actor);
            sceneSystem?.removeActor?.(actor);
        }
    }

    /** Shared helper: restore the doom prefabs the snapshot may have dropped
     * (gun pickup mesh state, exit teleporter visibility, player spawn). */
    function restoreDoomPrefabs(layout) {
        let exitActor = null;
        let gunActor = null;
        for (const actor of getGameplayPrefabActors()) {
            const type = actor?.userData?.gameplayPrefab;
            const mesh = getActorRenderObject(actor);
            if (type === 'doomShotgunSprite' && mesh && Array.isArray(layout.shotgunPickup)) {
                gunActor = actor;
                actor.userData.collected = false;
                actor.userData._bobBaseY = null;
                actor.userData._mag = null; // forces ammo() to re-init on next pickup
                actor.userData._reloadUntil = 0;
                actor.userData._burstLeft = 0;
                actor.userData._cooldownUntil = 0;
                setActorWorldPositionExact(actor, layout.shotgunPickup, { visible: true });
            } else if (type === 'teleporter') {
                exitActor = actor;
                setActorWorldPositionExact(
                    actor,
                    Array.isArray(layout.exitTeleporterHidden)
                        ? layout.exitTeleporterHidden : layout.exitTeleporter,
                    { visible: false },
                );
            } else if (type === 'playerSpawn' && mesh && Array.isArray(layout.playerSpawn)) {
                mesh.position.set(layout.playerSpawn[0], layout.playerSpawn[1], layout.playerSpawn[2]);
                mesh.updateMatrixWorld(true);
                applyPlayerSpawnFromActor(actor);
            }
        }
        return { exitActor, gunActor };
    }

    function resetDoomMiniLevelState() {
        const currentMesh = getCurrentMesh();
        if (currentMesh?.userData?.sampleType !== 'doomTest') return false;

        const layout = currentMesh.userData.doomMiniLevel || {};
        const prevState = currentMesh.userData.doomMiniLevelState || null;

        // Destroy everything spawned DURING play.
        const toDestroy = new Set();
        if (prevState) {
            for (const key of ['hallWaveActors', 'arenaWaveActors', 'finalWaveActors']) {
                for (const actor of prevState[key] || []) toDestroy.add(actor);
            }
            for (const entry of prevState.arenaBarrier || []) {
                if (entry?.actor) toDestroy.add(entry.actor);
            }
        }
        for (const actor of getGameplayPrefabActors('shooterAi')) toDestroy.add(actor);
        destroyActorSet(toDestroy);

        // Restore the surviving (restored-from-snapshot) prefabs.
        resetGameplayPrefabs();

        const _allPrefabs = getGameplayPrefabActors();
        console.log('[DOOM] reset: prefab actors =', _allPrefabs.length,
            _allPrefabs.map((a) => a?.userData?.gameplayPrefab),
            '| prevState triggers =', prevState
                ? [prevState.hallTriggered, prevState.arenaTriggered, prevState.finalTriggered]
                : 'none',
            '| layout keys =', Object.keys(layout));

        let { exitActor, gunActor } = restoreDoomPrefabs(layout);

        // The shotgun pickup is a THREE.Sprite — serializeActorData serializes it
        // but loadWorldFromJSON has no 'sprite' spawn case, so the snapshot
        // restore on Stop drops it. Re-spawn like afterLoad does.
        if (!gunActor && Array.isArray(layout.shotgunPickup)) {
            gunActor = spawnGameplayPrefab('doomShotgunSprite');
            if (gunActor) {
                gunActor.userData.collected = false;
                setActorWorldPositionExact(gunActor, layout.shotgunPickup, { visible: true });
            }
        }

        // Fresh state machine — identical shape to the doomTest afterLoad init.
        currentMesh.userData.doomMiniLevelState = {
            exitActor,
            arenaBarrier: createDoomMiniBarrierEntries(layout.arenaBarrier),
            hallWaveActors: [],
            arenaWaveActors: [],
            finalWaveActors: [],
            hallTriggered: false,
            arenaTriggered: false,
            finalTriggered: false,
            exitUnlocked: false,
        };

        syncGameplaySpawnFromPlayerSpawnActor();
        return true;
    }

    function resetDoomArenaLevelState() {
        const currentMesh = getCurrentMesh();
        if (currentMesh?.userData?.sampleType !== 'doomArena') return false;

        const layout = currentMesh.userData.doomArenaLevel || {};
        const prevState = currentMesh.userData.doomArenaState || null;

        const toDestroy = new Set();
        if (prevState) {
            for (const actor of prevState.waveActors || []) toDestroy.add(actor);
        }
        for (const actor of getGameplayPrefabActors('shooterAi')) toDestroy.add(actor);
        destroyActorSet(toDestroy);

        resetGameplayPrefabs();
        const { exitActor } = restoreDoomPrefabs(layout);

        // Rogue Waves: weapon comes from the start-of-run card, not a world
        // pickup — don't re-spawn the shotgun sprite on reset.
        resetRogueState();
        clearHeldWeapon();

        // Rebuild the game-mode actor so its script state (phase/wave) restarts
        // cleanly via a fresh BeginPlay.
        const sceneSystem = getSceneSystem();
        for (const actor of getGameplayPrefabActors('rogueGameMode')) {
            destroyDynamicPhysicsProp(actor);
            sceneSystem?.removeActor?.(actor);
        }
        const gm = spawnGameplayPrefab('rogueGameMode');
        if (gm) gm.userData.label = 'Rogue Game Mode';
        currentMesh.userData.rogueGameModeActorId = gm?.id || '';

        currentMesh.userData.doomArenaState = {
            exitActor,
            started: false,
            weaponPromptShown: false,
        };

        syncGameplaySpawnFromPlayerSpawnActor();
        return true;
    }

    function resetSoccerLevelState() {
        const currentMesh = getCurrentMesh();
        if (currentMesh?.userData?.sampleType !== 'soccerTargetField') return false;

        soccerGoalieState.elapsed = 0;
        resetGameplayPrefabs();
        const sceneSystem = getSceneSystem();
        for (const actor of Array.from(sceneSystem?.actors || [])) {
            resetActorToStoredTransform(actor);
        }
        // Soccer goalie clock advance — components do the actual motion.
        updateSoccerGoalies(0);
        syncGameplaySpawnFromPlayerSpawnActor();
        return true;
    }

    function updateSoccerGoalies(delta = 0) {
        const currentMesh = getCurrentMesh();
        if (currentMesh?.userData?.sampleType !== 'soccerTargetField') return;
        const goalies = getSoccerGoalieActors();
        if (!goalies.length) return;
        soccerGoalieState.elapsed = Math.max(0, soccerGoalieState.elapsed + Math.max(0, delta));
    }

    return {
        // Helpers (callable from outside if a custom level needs them)
        isDoomMiniWaveCleared,
        spawnDoomMiniWave,
        createDoomMiniBarrierEntries,
        setDoomMiniBarrierActive,
        // Per-frame
        updateDoomMiniLevelState,
        updateSoccerGoalies,
        // Reset entry points
        resetDoomMiniLevelState,
        resetDoomArenaLevelState,
        resetSoccerLevelState,
    };
}
