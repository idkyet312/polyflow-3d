import { ActorComponent } from './ActorComponent.js';

// WeaponPickupComponent — generic pickup that hides itself + invokes an
// equip(actor) strategy when the gameplay subject enters the trigger.
// Replaces three near-identical inline blocks in processGameplayPrefabs
// (smg / sniperRifle / doomShotgunSprite). Each variant differs only in:
//   - what equip() does
//   - whether the sprite should idle-bob+spin while uncollected (doom)
//   - whether to play a pickup sound + defer to user OnTrigger script (doom)
//
// Behavior parity with the legacy loops:
//   1. If `isScripted(actor)` returns true, dispatch the trigger event and
//      stop — the user script owns the pickup. We only delegate when the
//      caller wires it; the simple variants (smg/sniper) pass a no-op.
//   2. Optional bob: while uncollected and visible, oscillate mesh.position.y
//      around the recorded base, and rotate sprite material if present.
//   3. Trigger eat: subject inside + visible + not collected →
//      collected = true; mesh.visible = false; sound?(); equip(actor).
//
// Deps:
//   equip               - (actor) => void   weapon-specific equip side-effect
//   isScripted          - (actor) => bool   (default: () => false)
//   dispatchTrigger     - (actor, subjectPos, subject) => void
//                         (only invoked when isScripted returns true)
//   isSubjectInsideTrigger - (subjectPos, actor) => bool
//   getSubjectPosition  - () => THREE.Vector3 | null
//   getSubject          - () => any   payload passed to dispatchTrigger
//   getRenderObject     - (actor) => Object3D | null
//   playPickupSound     - () => void   (optional; doom shotgun only)
//   bob                 - bool         enable idle-bob (default false)
export class WeaponPickupComponent extends ActorComponent {
    static componentKey = 'WeaponPickupComponent';

    constructor({
        equip = () => {},
        isScripted = () => false,
        dispatchTrigger = () => {},
        isSubjectInsideTrigger = () => false,
        getSubjectPosition = () => null,
        getSubject = () => null,
        getRenderObject = (actor) => actor?.mesh ?? null,
        playPickupSound = null,
        bob = false,
        isGameplayActive = () => true,
    } = {}) {
        super();
        this._equip = equip;
        this._isScripted = isScripted;
        this._dispatchTrigger = dispatchTrigger;
        this._isSubjectInsideTrigger = isSubjectInsideTrigger;
        this._getSubjectPosition = getSubjectPosition;
        this._getSubject = getSubject;
        this._getRenderObject = getRenderObject;
        this._playPickupSound = typeof playPickupSound === 'function' ? playPickupSound : null;
        this.bob = !!bob;
        this._isGameplayActive = isGameplayActive;
    }

    reset() {
        const userData = this.owner?.userData;
        if (!userData) return;
        userData.collected = false;
        userData._bobBaseY = null;
        const mesh = this._getRenderObject(this.owner);
        if (mesh) mesh.visible = true;
    }

    tick(/* deltaTime */) {
        const actor = this.owner;
        if (!actor) return;
        const mesh = this._getRenderObject(actor);
        if (!mesh) return;

        const userData = actor.userData ?? {};

        // Idle bob+spin works while paused too (visual polish).
        if (this.bob && mesh.visible && !userData.collected) {
            if (userData._bobBaseY == null) userData._bobBaseY = mesh.position.y;
            const tphase = (performance.now?.() || Date.now()) * 0.004;
            mesh.position.y = userData._bobBaseY + Math.sin(tphase) * 0.12;
            if (mesh.material) mesh.material.rotation = Math.sin(tphase * 0.5) * 0.18;
        }

        if (!this._isGameplayActive()) return;

        // Script-owned variants (doom shotgun): dispatch trigger event and bail.
        if (this._isScripted(actor)) {
            const subjectPosition = this._getSubjectPosition();
            const subject = this._getSubject();
            this._dispatchTrigger(actor, subjectPosition, subject);
            return;
        }

        if (!mesh.visible || userData.collected) return;
        const subjectPosition = this._getSubjectPosition();
        if (!subjectPosition) return;
        if (!this._isSubjectInsideTrigger(subjectPosition, actor)) return;

        userData.collected = true;
        mesh.visible = false;
        this._playPickupSound?.();
        this._equip(actor);
    }
}
