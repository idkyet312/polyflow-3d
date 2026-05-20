import { ActorComponent } from './ActorComponent.js';

// TargetComponent — score-on-impact for static "target" actors. Iterates the
// physics dynamic-body list each tick, looking for any non-prefab actor
// inside a cylindrical zone (radius in XZ, ±2.6 in Y) around the target.
//
// Two branches mirror the legacy block in processGameplayPrefabs:
//   - User-script handler present → emit OnTrigger enter/exit edge events
//     via dispatchTriggerEvent, with `{ hitter, position }` payload. The
//     engine never scores in this mode.
//   - No script handler → enforce a per-target hit cooldown
//     (default 650ms) and, on the first qualifying body, add score +
//     arm the cooldown.
//
// Performance: heavy candidate list iteration is unavoidable until a real
// broadphase ships, but we early-out on `hitCooldownUntil` and on `!visible`
// before the loop so steady-state cost is one Date.now() + one visibility check.
//
// Deps:
//   isScripted          - (actor) => bool
//   getDynamicBodies    - () => Actor[]   physics.dynamicBodies (live ref)
//   isPhysicsReady      - () => bool      physics.ready gate
//   getActorBody        - (actor) => body | null
//   getRenderObject     - (actor) => Object3D | null
//   addScore            - (amount) => void
//   dispatchTriggerEvent- (actor, payload, inside) => void  (script branch)
//   tmp                 - { a: THREE.Vector3, b: THREE.Vector3 } shared scratch
//   defaultRadius       - 1.55
//   defaultScoreValue   - 25
//   hitCooldownMs       - 650
//   yTolerance          - 2.6
export class TargetComponent extends ActorComponent {
    static componentKey = 'TargetComponent';

    constructor({
        isScripted = () => false,
        getDynamicBodies = () => [],
        isPhysicsReady = () => true,
        getActorBody = () => null,
        getRenderObject = (actor) => actor?.mesh ?? null,
        addScore = () => {},
        dispatchTriggerEvent = () => {},
        tmp = null,
        defaultRadius = 1.55,
        defaultScoreValue = 25,
        hitCooldownMs = 650,
        yTolerance = 2.6,
        THREE,
    } = {}) {
        super();
        this._isScripted = isScripted;
        this._getDynamicBodies = getDynamicBodies;
        this._isPhysicsReady = isPhysicsReady;
        this._getActorBody = getActorBody;
        this._getRenderObject = getRenderObject;
        this._addScore = addScore;
        this._dispatchTriggerEvent = dispatchTriggerEvent;
        this._tmp = tmp ?? { a: null, b: null };
        this.defaultRadius = defaultRadius;
        this.defaultScoreValue = defaultScoreValue;
        this.hitCooldownMs = hitCooldownMs;
        this.yTolerance = yTolerance;
        this._THREE = THREE;
    }

    _scratchA() {
        return this._tmp.a ?? (this._tmp.a = new this._THREE.Vector3());
    }
    _scratchB() {
        return this._tmp.b ?? (this._tmp.b = new this._THREE.Vector3());
    }

    tick(/* deltaTime */) {
        const actor = this.owner;
        if (!actor) return;
        const userData = actor.userData ?? {};

        if (this._isScripted(actor)) {
            this._tickScripted(actor, userData);
            return;
        }

        const now = performance.now?.() || Date.now();
        if ((userData.hitCooldownUntil || 0) > now) return;
        const mesh = this._getRenderObject(actor);
        if (!mesh?.visible) return;

        const tmpA = this._scratchA();
        const tmpB = this._scratchB();
        mesh.getWorldPosition(tmpA);
        const radius = Number(userData.triggerRadius ?? this.defaultRadius);
        const radiusSq = radius * radius;
        const yTol = this.yTolerance;

        const bodies = this._getDynamicBodies();
        const ready = this._isPhysicsReady();
        for (let bi = 0; bi < bodies.length; bi++) {
            const candidate = bodies[bi];
            if (!candidate || candidate.userData?.gameplayPrefab) continue;
            const body = this._getActorBody(candidate);
            const cMesh = this._getRenderObject(candidate);
            if (!body || !cMesh?.visible || !ready) continue;

            cMesh.getWorldPosition(tmpB);
            const dx = tmpB.x - tmpA.x;
            const dz = tmpB.z - tmpA.z;
            const dy = Math.abs(tmpB.y - tmpA.y);
            if (dx * dx + dz * dz <= radiusSq && dy <= yTol) {
                this._addScore(userData.scoreValue ?? this.defaultScoreValue);
                userData.hitCooldownUntil = now + this.hitCooldownMs;
                break;
            }
        }
    }

    _tickScripted(actor, userData) {
        const mesh = this._getRenderObject(actor);
        if (!mesh?.visible) return;

        const tmpA = this._scratchA();
        const tmpB = this._scratchB();
        mesh.getWorldPosition(tmpA);
        const radius = Number(userData.triggerRadius ?? this.defaultRadius);
        const radiusSq = radius * radius;
        const yTol = this.yTolerance;

        let hitter = null;
        const bodies = this._getDynamicBodies();
        for (let bi = 0; bi < bodies.length; bi++) {
            const candidate = bodies[bi];
            if (!candidate || candidate.userData?.gameplayPrefab) continue;
            const cMesh = this._getRenderObject(candidate);
            if (!cMesh?.visible) continue;
            cMesh.getWorldPosition(tmpB);
            const dx = tmpB.x - tmpA.x;
            const dz = tmpB.z - tmpA.z;
            const dy = Math.abs(tmpB.y - tmpA.y);
            if (dx * dx + dz * dz <= radiusSq && dy <= yTol) {
                hitter = candidate;
                break;
            }
        }

        const wasInside = !!userData._wasInsideTrigger;
        const inside = !!hitter;
        if (inside !== wasInside) {
            userData._wasInsideTrigger = inside;
            this._dispatchTriggerEvent(
                actor,
                hitter ? { hitter, position: tmpB.clone() } : null,
                inside,
            );
        }
    }
}
