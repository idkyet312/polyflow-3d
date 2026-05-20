import { ActorComponent } from './ActorComponent.js';

// CoinComponent — collect on subject-trigger-enter; hide mesh; emit score.
// Replaces the inline coin block in processGameplayPrefabs. Trivial state:
// `userData.collected` (boolean). No respawn (coins are one-shot).
//
// Deps:
//   isScripted             - (actor) => bool   skip when user script owns it
//   isSubjectInsideTrigger - (subjectPos, actor) => bool
//   getSubjectPosition     - () => THREE.Vector3 | null
//   addScore               - (amount) => void
//   getRenderObject        - (actor) => Object3D | null
//   defaultScoreValue      - number  used when actor.userData.scoreValue absent
export class CoinComponent extends ActorComponent {
    static componentKey = 'CoinComponent';

    constructor({
        isScripted = () => false,
        isSubjectInsideTrigger = () => false,
        getSubjectPosition = () => null,
        addScore = () => {},
        getRenderObject = (actor) => actor?.mesh ?? null,
        defaultScoreValue = 10,
    } = {}) {
        super();
        this._isScripted = isScripted;
        this._isSubjectInsideTrigger = isSubjectInsideTrigger;
        this._getSubjectPosition = getSubjectPosition;
        this._addScore = addScore;
        this._getRenderObject = getRenderObject;
        this.defaultScoreValue = defaultScoreValue;
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
        if (this._isScripted(actor)) return;
        const userData = actor.userData ?? {};
        if (userData.collected) return;
        const pos = this._getSubjectPosition();
        if (!pos) return;
        if (!this._isSubjectInsideTrigger(pos, actor)) return;

        userData.collected = true;
        const mesh = this._getRenderObject(actor);
        if (mesh) mesh.visible = false;
        this._addScore(userData.scoreValue ?? this.defaultScoreValue);
    }
}
