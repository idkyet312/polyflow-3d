// Gameplay prefab orchestrator. After the ECS auto-tick takeover:
//
//   snapshotSubject() — populates subjectScratch.position/.health for the
//     frame. Called BEFORE sceneSystem.tickComponents so every active
//     component can read the live subject via the shared scratch ref.
//
//   processGameplayPrefabs() — runs the cross-cutting teleporter system
//     (which is shared-state, not per-actor). Per-actor logic (Coin,
//     HealthPickup, WeaponPickup, Target) is driven by the SceneSystem
//     component tick pass, so this function is now a one-liner.
//
// Deps:
//   gameplay                   - { active, health }
//   getGameplaySubjectPosition - (target) => Vector3 | null
//   processTeleporters         - ({subjectPosition, subject, now}) => void
//   subjectScratch             - { position: Vector3, health: number }
//   tmp                        - { subject: Vector3 } scratch
export function createGameplayPrefabSystem({
    gameplay,
    getGameplaySubjectPosition,
    processTeleporters,
    subjectScratch,
    tmp,
}) {
    /** Capture the gameplay subject's world position + health into the
     * shared scratch object. Returns the scratch or null if no subject. */
    function snapshotSubject() {
        if (!gameplay.active) return null;
        const subjectPosition = getGameplaySubjectPosition(tmp.subject);
        if (!subjectPosition) return null;
        subjectScratch.position.copy(subjectPosition);
        subjectScratch.health = gameplay.health;
        return subjectScratch;
    }

    function processGameplayPrefabs() {
        const subject = snapshotSubject();
        if (!subject) return;
        const now = performance.now?.() || Date.now();
        processTeleporters({ subjectPosition: subject.position, subject, now });
    }

    return { snapshotSubject, processGameplayPrefabs };
}
