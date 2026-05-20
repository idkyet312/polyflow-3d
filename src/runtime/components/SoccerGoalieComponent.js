import { ActorComponent } from './ActorComponent.js';

// SoccerGoalieComponent — moves a soccer-goalie actor back and forth along a
// world axis using a shared sin clock. Replaces the imperative
// updateSoccerGoalies(delta) loop in runtime.js that iterated
// getSoccerGoalieActors() and read userData.soccerGoalieMotion.
//
// Each goalie owns its motion params (homePosition/axis/amplitude/speed/
// phase) directly on the component. A shared `getElapsed()` accessor reads
// the scene-level soccerGoalieState.elapsed so all goalies stay phase-locked
// across resets — runtime.js still owns that clock and advances it before
// the component tick pass.
//
// Body sync is delegated back through `syncBody(actor, activation)` so the
// kinematic Jolt body keeps following the render transform.
//
// Usage (level builder):
//   const goalie = new SoccerGoalieComponent({
//       homePosition: spec.position,
//       axis: spec.axis,
//       amplitude: spec.amplitude,
//       speed: spec.speed,
//       phase: spec.phase,
//       getElapsed,   // () => soccerGoalieState.elapsed
//       getActivation,// () => physics.Jolt.EActivation_* (gated by gameplay.active)
//       syncBody,     // (actor, activation) => syncActorBodyToRenderTransform
//   });
//   actor.addComponent(goalie);
export class SoccerGoalieComponent extends ActorComponent {
    static componentKey = 'SoccerGoalieComponent';

    constructor({
        homePosition = [0, 0, 0],
        axis = [1, 0, 0],
        amplitude = 0,
        speed = 1,
        phase = 0,
        getElapsed = null,
        getActivation = null,
        syncBody = null,
    } = {}) {
        super();

        this.homePosition = [
            Number(homePosition[0]) || 0,
            Number(homePosition[1]) || 0,
            Number(homePosition[2]) || 0,
        ];
        this.axis = [
            Number(axis[0]) || 0,
            Number(axis[1]) || 0,
            Number(axis[2]) || 0,
        ];
        this.amplitude = Number.isFinite(amplitude) ? amplitude : 0;
        this.speed = Number.isFinite(speed) ? speed : 1;
        this.phase = Number.isFinite(phase) ? phase : 0;

        this._getElapsed = typeof getElapsed === 'function' ? getElapsed : () => 0;
        this._getActivation = typeof getActivation === 'function' ? getActivation : () => null;
        this._syncBody = typeof syncBody === 'function' ? syncBody : null;
    }

    tick(/* deltaTime */) {
        const actor = this.owner;
        if (!actor) return;
        const mesh = actor.mesh;
        if (!mesh) return;

        const elapsed = this._getElapsed();
        const offset = Math.sin(elapsed * this.speed + this.phase) * this.amplitude;

        mesh.position.set(
            this.homePosition[0] + this.axis[0] * offset,
            this.homePosition[1] + this.axis[1] * offset,
            this.homePosition[2] + this.axis[2] * offset,
        );
        mesh.updateMatrixWorld(true);

        if (this._syncBody) this._syncBody(actor, this._getActivation());
    }

    serialize() {
        return {
            homePosition: [...this.homePosition],
            axis: [...this.axis],
            amplitude: this.amplitude,
            speed: this.speed,
            phase: this.phase,
        };
    }
}
