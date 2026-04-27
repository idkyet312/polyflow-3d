import * as THREE from 'three';
import { ActorComponent } from './ActorComponent.js';

/**
 * PhysicsComponent — Wraps a Jolt physics body with an Unreal-style API.
 *
 * Usage (from a script):
 *   const phys = actor.getComponent(PhysicsComponent);   // or actor.GetComponent(PhysicsComponent)
 *   phys.addForce(new THREE.Vector3(0, 1000, 0));
 *   phys.addImpulse(new THREE.Vector3(500, 0, 0));
 *   phys.setLinearVelocity(new THREE.Vector3(0, 10, 0));
 *
 * Requires the `physics` context object (the shared Jolt state bag) to be
 * passed in via `setPhysicsContext()` — the Actor helper does this automatically.
 */
export class PhysicsComponent extends ActorComponent {
    static componentKey = 'PhysicsComponent';

    constructor() {
        super();

        /** @type {object|null} Raw Jolt Body reference. */
        this.body = null;

        /**
         * Reference to the shared physics context so we can call
         * bodyInterface methods and create Jolt temp vectors.
         * @type {{ Jolt: any, bodyInterface: any, ready: boolean } | null}
         */
        this._physicsCtx = null;

        /** If true, the component will sync the mesh transform from the body every tick. */
        this.simulatePhysics = true;

        /** Gravity override (null = use world gravity). */
        this.gravityScale = 1.0;
    }

    // ───────── Setup ─────────

    /**
     * Provide the shared physics context. Called automatically by Actor helpers.
     * @param {{ Jolt: any, bodyInterface: any, ready: boolean, physicsSystem: any }} ctx
     */
    setPhysicsContext(ctx) {
        this._physicsCtx = ctx;
        return this;
    }

    /**
     * Assign (or replace) the underlying Jolt body.
     * @param {object} body  A Jolt Body reference.
     */
    setBody(body) {
        this.body = body;
        return this;
    }

    // ───────── Queries ─────────

    /** @returns {boolean} */
    isSimulatingPhysics() {
        return this.simulatePhysics && !!this.body;
    }

    /** @returns {boolean} */
    isReady() {
        return !!(this._physicsCtx?.ready && this.body);
    }

    /** Get the body ID. Returns null if no body. */
    getBodyID() {
        return this.body?.GetID?.() ?? null;
    }

    // ───────── Forces & Impulses (UE-style) ─────────

    /**
     * Add a continuous force (in Newtons) to the body's center of mass.
     * The force is applied during the next physics step and then cleared.
     * @param {THREE.Vector3} force  World-space force vector.
     */
    addForce(force) {
        if (!this._guard()) return;
        const { Jolt, bodyInterface } = this._physicsCtx;
        const jForce = new Jolt.Vec3(force.x, force.y, force.z);
        bodyInterface.AddForce(this.body.GetID(), jForce);
        Jolt.destroy(jForce);
    }

    /**
     * Add a continuous force at a specific world position (creates torque).
     * @param {THREE.Vector3} force     World-space force.
     * @param {THREE.Vector3} position  World-space application point.
     */
    addForceAtPosition(force, position) {
        if (!this._guard()) return;
        const { Jolt, bodyInterface } = this._physicsCtx;
        const jForce = new Jolt.Vec3(force.x, force.y, force.z);
        const jPos = new Jolt.RVec3(position.x, position.y, position.z);
        bodyInterface.AddForceAndTorque(this.body.GetID(), jForce, jPos); // approximation
        Jolt.destroy(jForce);
        Jolt.destroy(jPos);
    }

    /**
     * Add an instantaneous impulse to the body's center of mass.
     * @param {THREE.Vector3} impulse  World-space impulse (kg·m/s).
     */
    addImpulse(impulse) {
        if (!this._guard()) return;
        const { Jolt, bodyInterface } = this._physicsCtx;
        const jImpulse = new Jolt.Vec3(impulse.x, impulse.y, impulse.z);
        bodyInterface.AddImpulse(this.body.GetID(), jImpulse);
        Jolt.destroy(jImpulse);
    }

    /**
     * Add an impulse at a world position (creates angular impulse too).
     * @param {THREE.Vector3} impulse   World-space impulse.
     * @param {THREE.Vector3} position  World-space point.
     */
    addImpulseAtPosition(impulse, position) {
        if (!this._guard()) return;
        const { Jolt, bodyInterface } = this._physicsCtx;
        const jImpulse = new Jolt.Vec3(impulse.x, impulse.y, impulse.z);
        const jPos = new Jolt.RVec3(position.x, position.y, position.z);
        bodyInterface.AddImpulse(this.body.GetID(), jImpulse, jPos);
        Jolt.destroy(jImpulse);
        Jolt.destroy(jPos);
    }

    /**
     * Add a continuous torque to the body.
     * @param {THREE.Vector3} torque  World-space torque vector.
     */
    addTorque(torque) {
        if (!this._guard()) return;
        const { Jolt, bodyInterface } = this._physicsCtx;
        const jTorque = new Jolt.Vec3(torque.x, torque.y, torque.z);
        bodyInterface.AddTorque(this.body.GetID(), jTorque);
        Jolt.destroy(jTorque);
    }

    /**
     * Add an instantaneous angular impulse.
     * @param {THREE.Vector3} angularImpulse  World-space angular impulse.
     */
    addAngularImpulse(angularImpulse) {
        if (!this._guard()) return;
        const { Jolt, bodyInterface } = this._physicsCtx;
        const jAngImpulse = new Jolt.Vec3(angularImpulse.x, angularImpulse.y, angularImpulse.z);
        bodyInterface.AddAngularImpulse(this.body.GetID(), jAngImpulse);
        Jolt.destroy(jAngImpulse);
    }

    // ───────── Velocity ─────────

    /**
     * Directly set the linear velocity.
     * @param {THREE.Vector3} velocity
     */
    setLinearVelocity(velocity) {
        if (!this._guard()) return;
        const { Jolt, bodyInterface } = this._physicsCtx;
        const jVel = new Jolt.Vec3(velocity.x, velocity.y, velocity.z);
        bodyInterface.SetLinearVelocity(this.body.GetID(), jVel);
        Jolt.destroy(jVel);
    }

    /**
     * Get the current linear velocity.
     * @param {THREE.Vector3} [out]  Optional output vector.
     * @returns {THREE.Vector3}
     */
    getLinearVelocity(out) {
        const result = out ?? new THREE.Vector3();
        if (!this._guard()) return result.set(0, 0, 0);
        const { bodyInterface } = this._physicsCtx;
        const jVel = bodyInterface.GetLinearVelocity(this.body.GetID());
        result.set(jVel.GetX(), jVel.GetY(), jVel.GetZ());
        return result;
    }

    /**
     * Directly set the angular velocity.
     * @param {THREE.Vector3} angularVelocity
     */
    setAngularVelocity(angularVelocity) {
        if (!this._guard()) return;
        const { Jolt, bodyInterface } = this._physicsCtx;
        const jAngVel = new Jolt.Vec3(angularVelocity.x, angularVelocity.y, angularVelocity.z);
        bodyInterface.SetAngularVelocity(this.body.GetID(), jAngVel);
        Jolt.destroy(jAngVel);
    }

    /**
     * Get the current angular velocity.
     * @param {THREE.Vector3} [out]
     * @returns {THREE.Vector3}
     */
    getAngularVelocity(out) {
        const result = out ?? new THREE.Vector3();
        if (!this._guard()) return result.set(0, 0, 0);
        const { bodyInterface } = this._physicsCtx;
        const jAngVel = bodyInterface.GetAngularVelocity(this.body.GetID());
        result.set(jAngVel.GetX(), jAngVel.GetY(), jAngVel.GetZ());
        return result;
    }

    // ───────── Transform overrides ─────────

    /**
     * Teleport — set world position without applying forces.
     * @param {THREE.Vector3} position
     */
    setWorldPosition(position) {
        if (!this._guard()) return;
        const { Jolt, bodyInterface } = this._physicsCtx;
        const jPos = new Jolt.RVec3(position.x, position.y, position.z);
        bodyInterface.SetPosition(this.body.GetID(), jPos, Jolt.EActivation_Activate);
        Jolt.destroy(jPos);
    }

    /**
     * Teleport — set world rotation without applying torques.
     * @param {THREE.Quaternion} quaternion
     */
    setWorldRotation(quaternion) {
        if (!this._guard()) return;
        const { Jolt, bodyInterface } = this._physicsCtx;
        const jRot = new Jolt.Quat(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
        bodyInterface.SetRotation(this.body.GetID(), jRot, Jolt.EActivation_Activate);
        Jolt.destroy(jRot);
    }

    // ───────── Activation / Sleep ─────────

    /** Wake the body up if it's sleeping. */
    activate() {
        if (!this._guard()) return;
        this._physicsCtx.bodyInterface.ActivateBody(this.body.GetID());
    }

    /** Put the body to sleep. */
    deactivate() {
        if (!this._guard()) return;
        this._physicsCtx.bodyInterface.DeactivateBody(this.body.GetID());
    }

    /** @returns {boolean} */
    isAwake() {
        if (!this._guard()) return false;
        return this._physicsCtx.bodyInterface.IsActive(this.body.GetID());
    }

    // ───────── Locking axes (UE-like constraints) ─────────

    /**
     * Lock or unlock individual linear axes.
     * This is a simplified wrapper — pass `true` to lock the axis.
     */
    setConstrainedLinearAxes(lockX = false, lockY = false, lockZ = false) {
        if (!this._guard()) return;
        // Jolt doesn't have direct axis-lock on body; we'd need a constraint.
        // For now, zero out velocity on locked axes each tick.
        this._lockedLinear = { x: lockX, y: lockY, z: lockZ };
    }

    // ───────── Internal ─────────

    /** @private */
    _guard() {
        if (!this._physicsCtx?.ready || !this.body) {
            return false;
        }
        return true;
    }

    // ───────── Lifecycle ─────────

    tick(deltaTime) {
        if (!this._active || !this.simulatePhysics || !this._guard()) return;

        // Enforce axis locks (cheap workaround without real constraints).
        if (this._lockedLinear) {
            const vel = this.getLinearVelocity();
            let dirty = false;
            if (this._lockedLinear.x && vel.x !== 0) { vel.x = 0; dirty = true; }
            if (this._lockedLinear.y && vel.y !== 0) { vel.y = 0; dirty = true; }
            if (this._lockedLinear.z && vel.z !== 0) { vel.z = 0; dirty = true; }
            if (dirty) this.setLinearVelocity(vel);
        }
    }

    endPlay() {
        this.body = null;
        this._physicsCtx = null;
    }
}
