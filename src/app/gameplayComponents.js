// ECS component attach helpers for gameplay actors.
//
// Each attach* fn idempotently wires a runtime component class to an actor:
// ShooterSpawner, WeaponPickup, Coin, Target, HealthPickup. Component
// classes themselves live under src/runtime/components/; this file is the
// thin "give me these knobs" wiring layer that the spawn paths call.

export function createGameplayComponents(deps) {
    const {
        THREE,
        ShooterSpawnerComponent, WeaponPickupComponent, CoinComponent,
        TargetComponent, HealthPickupComponent,
        SHOOTER_SPAWNER_PREFAB, SHOOTER_AI_PREFAB, HEALTH_PICKUP_PREFAB,
        gameplay, physics, dynamicBodySpatial,
        _scratchPrefab2, _emptyArray, _gameplaySubjectScratch,
        getGameplayPrefabActors, getActorRenderObject, getActorBody,
        spawnShooterAiAt,
        equipStraightGun, equipSniperRifle, equipDoomShotgun,
        playDoomPickupSound,
        hasScriptedTriggerHandler,
        dispatchTriggerForActor, isSubjectInsideTrigger,
        dispatchTriggerEvent,
        addGameScore,
        setPlayerHealth,
    } = deps;

    const _shooterSpawnerTmp = { v: new THREE.Vector3() };
    const _targetTmp = { a: null, b: null };

    function attachShooterSpawnerComponent(actor) {
        if (!actor) return null;
        let comp = actor.getComponentByClass?.(ShooterSpawnerComponent);
        if (comp) {
            comp.syncFromUserData();
            return comp;
        }
        comp = new ShooterSpawnerComponent({
            tuning: SHOOTER_SPAWNER_PREFAB,
            baseScoreValue: SHOOTER_AI_PREFAB.scoreValue,
            isGameplayActive: () => !!gameplay.active,
            getMinions: () => getGameplayPrefabActors('shooterAi', _scratchPrefab2),
            spawnMinion: (pos, opts) => spawnShooterAiAt(pos, opts),
            getRenderObject: (a) => getActorRenderObject(a),
            THREE,
            tmp: _shooterSpawnerTmp,
        });
        actor.addComponent(comp);
        // Driven by the prefab user-script Tick → window.updateShooterSpawnerActor.
        // Deactivate from the SceneSystem auto-tick pass to avoid a double-tick;
        // flip _active=true once the user script is retired in favor of ECS.
        comp.setActive(false);
        comp.syncFromUserData();
        return comp;
    }

    function updateShooterSpawnerActor(spawner) {
        if (!spawner) return;
        const comp = spawner.getComponentByClass?.(ShooterSpawnerComponent)
            || attachShooterSpawnerComponent(spawner);
        comp?.tick(0);
    }

    function attachWeaponPickupComponent(actor, variant) {
        if (!actor) return null;
        let comp = actor.getComponentByClass?.(WeaponPickupComponent);
        if (comp) return comp;
        const isDoom = variant === 'doomShotgun';
        let equip;
        if (variant === 'smg') equip = (a) => equipStraightGun(a);
        else if (variant === 'sniperRifle') equip = (a) => equipSniperRifle(a);
        else if (variant === 'doomShotgun') equip = (a) => equipDoomShotgun(a);
        else return null;

        comp = new WeaponPickupComponent({
            equip,
            bob: isDoom,
            isScripted: isDoom ? (a) => hasScriptedTriggerHandler(a) : () => false,
            dispatchTrigger: (a, pos, subj) => dispatchTriggerForActor(a, pos, subj),
            isSubjectInsideTrigger: (pos, a) => isSubjectInsideTrigger(pos, a),
            getSubjectPosition: () => _gameplaySubjectScratch.position,
            getSubject: () => _gameplaySubjectScratch,
            getRenderObject: (a) => getActorRenderObject(a),
            playPickupSound: isDoom ? () => playDoomPickupSound?.() : null,
            isGameplayActive: () => !!gameplay.active,
        });
        actor.addComponent(comp);
        return comp;
    }

    function attachCoinComponent(actor) {
        if (!actor) return null;
        let comp = actor.getComponentByClass?.(CoinComponent);
        if (comp) return comp;
        comp = new CoinComponent({
            isScripted: (a) => hasScriptedTriggerHandler(a),
            dispatchTrigger: (a, pos, subj) => dispatchTriggerForActor(a, pos, subj),
            isSubjectInsideTrigger: (pos, a) => isSubjectInsideTrigger(pos, a),
            getSubjectPosition: () => _gameplaySubjectScratch.position,
            getSubject: () => _gameplaySubjectScratch,
            addScore: (amount) => addGameScore(amount),
            getRenderObject: (a) => getActorRenderObject(a),
            isGameplayActive: () => !!gameplay.active,
        });
        actor.addComponent(comp);
        return comp;
    }

    function attachTargetComponent(actor) {
        if (!actor) return null;
        let comp = actor.getComponentByClass?.(TargetComponent);
        if (comp) return comp;
        comp = new TargetComponent({
            isScripted: (a) => hasScriptedTriggerHandler(a),
            getDynamicBodies: () => physics.dynamicBodies || _emptyArray,
            getCandidateBodies: (center, radius, out) => dynamicBodySpatial?.querySphere?.(center, radius, out),
            isPhysicsReady: () => !!physics.ready,
            getActorBody: (a) => getActorBody(a),
            getRenderObject: (a) => getActorRenderObject(a),
            addScore: (amount) => addGameScore(amount),
            dispatchTriggerEvent: (a, payload, inside) => dispatchTriggerEvent(a, payload, inside),
            isGameplayActive: () => !!gameplay.active,
            tmp: _targetTmp,
            THREE,
        });
        actor.addComponent(comp);
        return comp;
    }

    function attachHealthPickupComponent(actor) {
        if (!actor) return null;
        let comp = actor.getComponentByClass?.(HealthPickupComponent);
        if (comp) return comp;
        comp = new HealthPickupComponent({
            tuning: HEALTH_PICKUP_PREFAB,
            isScripted: (a) => hasScriptedTriggerHandler(a),
            dispatchTrigger: (a, pos, subj) => dispatchTriggerForActor(a, pos, subj),
            isSubjectInsideTrigger: (pos, a) => isSubjectInsideTrigger(pos, a),
            // snapshotSubject() in gameplayPrefabSystem populates this scratch
            // each frame before sceneSystem.tickComponents runs, so the component
            // reads the live subject position without re-allocating.
            getSubjectPosition: () => _gameplaySubjectScratch.position,
            getSubject: () => _gameplaySubjectScratch,
            getCurrentHealth: () => gameplay.health ?? 1,
            applyHeal: (newHealth) => setPlayerHealth(newHealth),
            getRenderObject: (a) => getActorRenderObject(a),
            isGameplayActive: () => !!gameplay.active,
        });
        actor.addComponent(comp);
        return comp;
    }

    return {
        attachShooterSpawnerComponent,
        updateShooterSpawnerActor,
        attachWeaponPickupComponent,
        attachCoinComponent,
        attachTargetComponent,
        attachHealthPickupComponent,
    };
}
