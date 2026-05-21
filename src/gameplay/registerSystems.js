// Registers the per-frame gameplay systems in topological order. Lifted out
// of runtime.js so the dependency graph (shooterSpawners → straightGuns →
// shooterAis → effects → playerHitFeedback → projectileFlush →
// subjectSnapshot → componentTick → soccerGoalies) lives in one focused file.
//
//   registerGameplaySystems(world.systems, {
//       updateShooterSpawners, updateStraightGuns, updateShooterAis,
//       updateGameplayEffects, updatePlayerHitFeedback,
//       getProjectileInstancer, snapshotGameplaySubject,
//       sceneSystem, updateSoccerGoalies,
//   });
//
// Each dep is provided by name so this module is unit-testable with stubs.

export function registerGameplaySystems(systems, deps) {
    const {
        updateShooterSpawners,
        updateStraightGuns,
        updateShooterAis,
        updateGameplayEffects,
        updatePlayerHitFeedback,
        getProjectileInstancer,
        snapshotGameplaySubject,
        sceneSystem,
        updateSoccerGoalies,
    } = deps;

    systems.register({
        name: 'shooterSpawners',
        update: (delta) => updateShooterSpawners(delta),
    });
    systems.register({
        name: 'straightGuns',
        update: () => updateStraightGuns(),
        after: ['shooterSpawners'],
    });
    systems.register({
        name: 'shooterAis',
        update: (delta) => updateShooterAis(delta),
        after: ['straightGuns'],
    });
    systems.register({
        name: 'effects',
        update: (delta) => updateGameplayEffects(delta),
        after: ['shooterAis'],
    });
    systems.register({
        name: 'playerHitFeedback',
        update: (delta) => updatePlayerHitFeedback(delta),
        after: ['effects'],
    });
    systems.register({
        name: 'projectileFlush',
        update: () => getProjectileInstancer()?.flush(),
        after: ['shooterAis'],
    });
    systems.register({
        name: 'subjectSnapshot',
        update: () => snapshotGameplaySubject(),
        after: ['playerHitFeedback'],
    });
    systems.register({
        name: 'componentTick',
        update: (delta) => sceneSystem?.tickComponents?.(delta),
        after: ['subjectSnapshot'],
    });
    systems.register({
        name: 'soccerGoalies',
        update: (delta) => updateSoccerGoalies(delta),
        after: ['componentTick'],
    });
}
