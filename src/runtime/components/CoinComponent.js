import { ActorComponent } from './ActorComponent.js';

// CoinComponent — collect on subject-trigger-enter; hide mesh; emit score.
// Replaces the inline coin block in processGameplayPrefabs. Trivial state:
// `userData.collected` (boolean). No respawn (coins are one-shot).
//
// Scripted-handler precedence: when isScripted(actor) returns true, defer
// to the user OnTrigger script via dispatchTrigger(actor, pos, subject) and
// skip engine-side collect.
//
// Deps:
//   isScripted             - (actor) => bool
//   dispatchTrigger        - (actor, subjectPos, subject) => void
//   isSubjectInsideTrigger - (subjectPos, actor) => bool
//   getSubjectPosition     - () => THREE.Vector3 | null
//   getSubject             - () => any  payload for dispatchTrigger
//   addScore               - (amount) => void
//   getRenderObject        - (actor) => Object3D | null
//   defaultScoreValue      - number  used when actor.userData.scoreValue absent
//   isGameplayActive       - () => bool  (default: always true; runtime gates)
export class CoinComponent extends ActorComponent {
    static componentKey = 'CoinComponent';

    constructor({
        isScripted = () => false,
        dispatchTrigger = () => {},
        isSubjectInsideTrigger = () => false,
        getSubjectPosition = () => null,
        getSubject = () => null,
        addScore = () => {},
        getRenderObject = (actor) => actor?.mesh ?? null,
        defaultScoreValue = 10,
        isGameplayActive = () => true,
    } = {}) {
        super();
        this._isScripted = isScripted;
        this._dispatchTrigger = dispatchTrigger;
        this._isSubjectInsideTrigger = isSubjectInsideTrigger;
        this._getSubjectPosition = getSubjectPosition;
        this._getSubject = getSubject;
        this._addScore = addScore;
        this._getRenderObject = getRenderObject;
        this.defaultScoreValue = defaultScoreValue;
        this._isGameplayActive = isGameplayActive;
    }

    reset() {
        const userData = this.owner?.userData;
        if (!userData) return;
        userData.collected = false;
        const mesh = this._getRenderObject(this.owner);
        if (mesh) mesh.visible = true;
    }

    tick(/* deltaTime */) {
        const actor = this.owner;
        if (!actor) return;
        if (!this._isGameplayActive()) return;
        const pos = this._getSubjectPosition();
        if (!pos) return;

        if (this._isScripted(actor)) {
            this._dispatchTrigger(actor, pos, this._getSubject());
            return;
        }

        const userData = actor.userData ?? {};
        if (userData.collected) return;
        if (!this._isSubjectInsideTrigger(pos, actor)) return;

        userData.collected = true;
        const mesh = this._getRenderObject(actor);
        if (mesh) mesh.visible = false;
        this._addScore(userData.scoreValue ?? this.defaultScoreValue);
    }
}
