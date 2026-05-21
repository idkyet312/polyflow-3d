// Registers per-frame gameplay systems. Runtime owns the concrete state; this
// module owns the dependency graph.

export function registerGameplaySystems(systems, deps) {
    const {
        updateShooterSpawners,
        updateStraightGuns,
        updateShooterAis,
        updateGameplayEffects,
        updatePlayerHitFeedback,
        getProjectileInstancer,
        snapshotGameplaySubject,
        updateGameplayTeleporters,
        sceneSystem,
        updateSoccerGoalies,
    } = deps;

    systems.register({
        name: 'shooterSpawners',
        phase: 'gameplay',
        update: (delta) => updateShooterSpawners(delta),
    });
    systems.register({
        name: 'straightGuns',
        phase: 'gameplay',
        update: () => updateStraightGuns(),
        after: ['shooterSpawners'],
    });
    systems.register({
        name: 'shooterAis',
        phase: 'gameplay',
        update: (delta) => updateShooterAis(delta),
        after: ['straightGuns'],
    });
    systems.register({
        name: 'effects',
        phase: 'gameplay',
        update: (delta) => updateGameplayEffects(delta),
        after: ['shooterAis'],
    });
    systems.register({
        name: 'playerHitFeedback',
        phase: 'gameplay',
        update: (delta) => updatePlayerHitFeedback(delta),
        after: ['effects'],
    });
    systems.register({
        name: 'projectileFlush',
        phase: 'gameplay',
        update: () => getProjectileInstancer()?.flush(),
        after: ['shooterAis'],
    });
    systems.register({
        name: 'subjectSnapshot',
        phase: 'gameplay',
        update: () => snapshotGameplaySubject(),
        after: ['playerHitFeedback'],
    });
    systems.register({
        name: 'teleporters',
        phase: 'gameplay',
        update: (_delta, ctx) => updateGameplayTeleporters?.(ctx),
        after: ['subjectSnapshot'],
    });
    systems.register({
        name: 'componentTick',
        phase: 'gameplay',
        update: (delta) => sceneSystem?.tickComponents?.(delta),
        after: ['teleporters'],
    });
    systems.register({
        name: 'soccerGoalies',
        phase: 'gameplay',
        update: (delta) => updateSoccerGoalies(delta),
        after: ['componentTick'],
    });
}
