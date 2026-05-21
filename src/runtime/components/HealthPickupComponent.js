import { ActorComponent } from './ActorComponent.js';

// HealthPickupComponent — owns the collected/respawnAt state for a health
// pickup actor and runs the per-frame trigger+respawn logic the imperative
// processGameplayPrefabs() health-pickup block used to.
//
// Behavior parity with the legacy loop:
//   - If a user OnTrigger script handler exists, do nothing (the engine
//     dispatches the trigger event elsewhere; component stays out of the way).
//   - If currently collected and respawnAt has elapsed: un-collect, re-show.
//   - If visible, player not full health, subject inside trigger:
//     mark collected, hide mesh, schedule respawn, apply heal side-effect.
//
// State is mirrored back to `actor.userData.collected/respawnAt/_bobBaseY` so
// snapshot save/restore + the existing reset paths keep working.
//
// Deps:
//   tuning              - HEALTH_PICKUP_PREFAB { respawnMs, healValue }
//   isScripted          - (actor) => bool   (script-owned escape hatch)
//   isSubjectInsideTrigger - (subjectPos, actor) => bool
//   getSubjectPosition  - () => THREE.Vector3 | null
//   getCurrentHealth    - () => number (0..1; pickups don't fire at full HP)
//   applyHeal           - (newHealthValue) => void
//   getRenderObject     - (actor) => Object3D | null
export class HealthPickupComponent extends ActorComponent {
    static componentKey = 'HealthPickupComponent';

    constructor({
        tuning,
        isScripted = () => false,
        dispatchTrigger = () => {},
        isSubjectInsideTrigger = () => false,
        getSubjectPosition = () => null,
        getSubject = () => null,
        getCurrentHealth = () => 1,
        applyHeal = () => {},
        getRenderObject = (actor) => actor?.mesh ?? null,
        isGameplayActive = () => true,
    } = {}) {
        super();
        this.tuning = tuning;
        this._isScripted = isScripted;
        this._dispatchTrigger = dispatchTrigger;
        this._isSubjectInsideTrigger = isSubjectInsideTrigger;
        this._getSubjectPosition = getSubjectPosition;
        this._getSubject = getSubject;
        this._getCurrentHealth = getCurrentHealth;
        this._applyHeal = applyHeal;
        this._getRenderObject = getRenderObject;
        this._isGameplayActive = isGameplayActive;
    }

    /** Hydrate from snapshot/reset blob. */
    reset() {
        const userData = this.owner?.userData;
        if (!userData) return;
        userData.collected = false;
        userData.respawnAt = 0;
        const mesh = this._getRenderObject(this.owner);
        if (mesh) mesh.visible = true;
    }

    tick(/* deltaTime */) {
        const actor = this.owner;
        if (!actor) return;
        if (!this._isGameplayActive()) return;

        const subjectPosition = this._getSubjectPosition();
        if (!subjectPosition) return;

        if (this._isScripted(actor)) {
            this._dispatchTrigger(actor, subjectPosition, this._getSubject());
            return;
        }

        const mesh = this._getRenderObject(actor);
        if (!mesh) return;

        const now = performance.now?.() || Date.now();
        const userData = actor.userData ?? {};

        if (userData.collected) {
            if ((userData.respawnAt || 0) > now) return;
            userData.collected = false;
            mesh.visible = true;
        }

        if (!mesh.visible) return;
        const currentHealth = this._getCurrentHealth();
        if (currentHealth >= 1) return;

        if (!this._isSubjectInsideTrigger(subjectPosition, actor)) return;

        userData.collected = true;
        userData.respawnAt = now + (userData.respawnMs ?? this.tuning.respawnMs);
        mesh.visible = false;

        const heal = userData.healValue ?? this.tuning.healValue;
        this._applyHeal((currentHealth ?? 1) + heal);
    }
}
