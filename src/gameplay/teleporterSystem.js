import * as THREE from 'three';

// Teleporter system. Extracted from processGameplayPrefabs.
//
// Behavior parity with the legacy block:
//   1. Scripted teleporters: dispatch OnTrigger via dispatchTriggerForActor;
//      engine never moves them itself.
//   2. Engine path: if global cooldown elapsed, find first non-scripted
//      visible teleporter the subject is inside. Pick its destination
//      (next teleporter in the list, wrapping; or playerSpawn fallback when
//      only one teleporter exists). Teleport the gameplay subject there.
//   3. Drag-along: also teleport every other visible actor inside the
//      source's trigger zone (XZ radius²-test, ±2.5 Y) EXCEPT the source
//      and destination teleporter themselves.
//   4. Arm the shared cooldown so the next frame doesn't re-trigger.
//
// Note: teleporter is shared-state (cooldown lives in gameplayPrefabState),
// so this is one system function rather than per-actor ECS components.
//
// Deps:
//   gameplay                 - shared { spawnPoint } state (fallback dest)
//   gameplayPrefabState      - shared { teleporterCooldownUntil } counter
//   getGameplayPrefabActors  - (type?) => Actor[]
//   getActorRenderObject     - (actor) => Object3D | null
//   getSceneActors           - () => Iterable<Actor>   (sceneSystem.actors)
//   hasScriptedTriggerHandler- (actor) => bool
//   dispatchTriggerForActor  - (actor, subjectPos, subject) => void
//   isSubjectInsideTrigger   - (subjectPos, actor) => bool
//   teleportActiveGameplaySubject - (dest) => void  player teleport
//   teleportActorTo          - (actor, dest) => void
//   tmp                      - { v: THREE.Vector3 } shared scratch
//   cooldownMs               - 900 (matches legacy 900ms gate)
//   yTolerance               - 2.5 (drag-along Y window)
//   _scratchPrefab1          - shared array reuse for actor iteration
export function createTeleporterSystem({
    gameplay,
    gameplayPrefabState,
    getGameplayPrefabActors,
    getActorRenderObject,
    getSceneActors = () => [],
    hasScriptedTriggerHandler,
    dispatchTriggerForActor,
    isSubjectInsideTrigger,
    teleportActiveGameplaySubject,
    teleportActorTo,
    tmp = null,
    cooldownMs = 900,
    yTolerance = 2.5,
    _scratchPrefab1,
}) {
    const _tmp = tmp ?? { v: new THREE.Vector3() };

    function processTeleporters({ subjectPosition, subject, now }) {
        // 1) Script-owned teleporters: just fire OnTrigger.
        let actors = getGameplayPrefabActors('teleporter', _scratchPrefab1);
        for (let i = 0; i < actors.length; i++) {
            const tp = actors[i];
            if (!hasScriptedTriggerHandler(tp)) continue;
            dispatchTriggerForActor(tp, subjectPosition, subject);
        }

        // 2) Global cooldown gate.
        if (now < gameplayPrefabState.teleporterCooldownUntil) return;

        const teleporters = getGameplayPrefabActors('teleporter')
            .filter((tp) => !hasScriptedTriggerHandler(tp))
            .filter((actor) => getActorRenderObject(actor)?.visible !== false);
        const sourceIndex = teleporters.findIndex(
            (actor) => isSubjectInsideTrigger(subjectPosition, actor),
        );
        if (sourceIndex < 0) return;

        const destinationActor = teleporters.length > 1
            ? teleporters[(sourceIndex + 1) % teleporters.length]
            : getGameplayPrefabActors('playerSpawn')[0];
        const destinationMesh = getActorRenderObject(destinationActor);
        const destination = destinationMesh
            ? destinationMesh.getWorldPosition(new THREE.Vector3())
            : gameplay.spawnPoint.clone();

        // 3) Player first, then drag-along everything else inside the source.
        teleportActiveGameplaySubject(destination);

        const sourceActor = teleporters[sourceIndex];
        const sourceMesh = getActorRenderObject(sourceActor);
        const sourcePosition = sourceMesh?.getWorldPosition(new THREE.Vector3());
        const sourceRadius = Number(sourceActor?.userData?.triggerRadius ?? 1.45);
        if (sourcePosition) {
            const sourceRadiusSq = sourceRadius * sourceRadius;
            for (const actor of Array.from(getSceneActors())) {
                if (!actor || actor === sourceActor || actor === destinationActor) continue;
                const mesh = getActorRenderObject(actor);
                if (!mesh?.visible) continue;
                mesh.getWorldPosition(_tmp.v);
                const dx = _tmp.v.x - sourcePosition.x;
                const dz = _tmp.v.z - sourcePosition.z;
                const dy = Math.abs(_tmp.v.y - sourcePosition.y);
                if (dx * dx + dz * dz <= sourceRadiusSq && dy <= yTolerance) {
                    teleportActorTo(actor, destination);
                }
            }
        }

        // 4) Arm shared cooldown.
        gameplayPrefabState.teleporterCooldownUntil = now + cooldownMs;
    }

    return { processTeleporters };
}
