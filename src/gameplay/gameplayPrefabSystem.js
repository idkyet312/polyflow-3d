// Gameplay prefab orchestration after the ECS takeover:
// - snapshotSubject() writes the live player/vehicle subject into shared
//   scratch before component ticks.
// - updateTeleporters() runs the one remaining cross-actor prefab system.
// Per-actor prefabs (coins, pickups, weapons, targets) are owned by components.

export function createGameplayPrefabSystem({
    gameplay,
    getGameplaySubjectPosition,
    processTeleporters,
    subjectScratch,
    tmp,
}) {
    function snapshotSubject() {
        subjectScratch.valid = false;
        if (!gameplay.active) return null;

        const subjectPosition = getGameplaySubjectPosition(tmp.subject);
        if (!subjectPosition) return null;

        subjectScratch.position.copy(subjectPosition);
        subjectScratch.health = gameplay.health;
        subjectScratch.valid = true;
        return subjectScratch;
    }

    function updateTeleporters(ctx = null) {
        if (!gameplay.active || !subjectScratch.valid) return;
        const now = ctx?.now ?? performance.now?.() ?? Date.now();
        processTeleporters({
            subjectPosition: subjectScratch.position,
            subject: subjectScratch,
            now,
        });
    }

    return { snapshotSubject, updateTeleporters };
}
