// CircularPatrolComponent — drives an actor in a circular path on the
// ground around a fixed center. Each tick advances the patrol angle
// by `speed * dt`, recomputes XZ from radius+angle, then resamples
// ground height for Y.
//
// Replaces the imperative `updateCircularNavmeshAis(delta)` loop in
// runtime.js (and the `actor.userData.aiPatrol` blob it read). The
// loop iterated over `getGameplayPrefabActors('navmeshCircleAi')`; the
// component owns its lifecycle directly so the iteration disappears.
//
// Usage:
//   import { CircularPatrolComponent } from '../runtime/components/CircularPatrolComponent.js';
//
//   const patrol = new CircularPatrolComponent({
//       center:  [x, y, z],
//       radius:  4,
//       speed:   2,           // rad/sec
//       yOffset: 2.55 * 0.55, // mesh-pivot offset above ground sample
//   });
//   patrol.setGroundSampler((x, z, ignoreActor) =>
//       getGroundHeightAt(x, z, true, { ignoreActor }));
//   actor.addComponent(patrol);
//
// Or pass `{ center, radius, speed, yOffset, groundSampler }` in one shot.

import { ActorComponent } from './ActorComponent.js';

export class CircularPatrolComponent extends ActorComponent {
    static componentKey = 'CircularPatrolComponent';

    constructor({
        center = [0, 0, 0],
        radius = 4,
        speed = 2,
        angle = 0,
        yOffset = 0,
        groundSampler = null,
    } = {}) {
        super();

        this.center = [center[0] || 0, center[1] || 0, center[2] || 0];
        this.radius = Number.isFinite(radius) ? radius : 4;
        this.speed = Number.isFinite(speed) ? speed : 2;
        this.angle = Number.isFinite(angle) ? angle : 0;
        this.yOffset = Number.isFinite(yOffset) ? yOffset : 0;

        this._groundSampler = typeof groundSampler === 'function' ? groundSampler : null;
    }

    /**
     * Provide the ground-height sampler. Signature:
     *   (x, z, ignoreActor) => number | null
     */
    setGroundSampler(fn) {
        this._groundSampler = typeof fn === 'function' ? fn : null;
        return this;
    }

    /** Reset the patrol so it starts again at angle 0 from `nextCenter`. */
    setCenter(nextCenter) {
        if (!Array.isArray(nextCenter)) return this;
        this.center = [nextCenter[0] || 0, nextCenter[1] || 0, nextCenter[2] || 0];
        return this;
    }

    tick(deltaTime) {
        if (!this.owner) return;
        const mesh = this.owner.mesh;
        if (!mesh) return;

        this.angle += Math.max(0, deltaTime) * this.speed;

        const cx = this.center[0];
        const cy = this.center[1];
        const cz = this.center[2];
        const x = cx + Math.cos(this.angle) * this.radius;
        const z = cz + Math.sin(this.angle) * this.radius;

        let groundY = null;
        if (this._groundSampler) {
            groundY = this._groundSampler(x, z, this.owner);
        }

        mesh.position.set(x, (groundY ?? cy) + this.yOffset, z);
        mesh.rotation.y = -this.angle;
        mesh.updateMatrixWorld(true);
    }

    /** Snapshot serializable patrol state (for save/load round-trip). */
    serialize() {
        return {
            center: [...this.center],
            radius: this.radius,
            speed: this.speed,
            angle: this.angle,
            yOffset: this.yOffset,
        };
    }
}
