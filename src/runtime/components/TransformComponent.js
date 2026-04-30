import * as THREE from 'three';
import { ActorComponent } from './ActorComponent.js';

/**
 * TransformComponent — Caches and exposes the actor's world transform
 * through a clean, UE-style API.
 *
 * Usage:
 *   const t = actor.GetComponent(TransformComponent);
 *   t.setWorldLocation(new THREE.Vector3(0, 5, 0));
 *   const pos = t.getWorldLocation();
 */
export class TransformComponent extends ActorComponent {
    static componentKey = 'TransformComponent';

    constructor() {
        super();
    }

    // ───────── Location ─────────

    /** @returns {THREE.Vector3} copy of world position. */
    getWorldLocation() {
        const mesh = this.owner?.mesh;
        if (!mesh) return new THREE.Vector3();
        mesh.updateWorldMatrix(true, false);
        return new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
    }

    /** Teleport to world position. */
    setWorldLocation(position) {
        const mesh = this.owner?.mesh;
        if (!mesh) return;
        mesh.position.copy(position);
        mesh.updateMatrixWorld(true);
    }

    /** @returns {THREE.Vector3} local position relative to parent. */
    getRelativeLocation() {
        return this.owner?.mesh?.position?.clone() ?? new THREE.Vector3();
    }

    setRelativeLocation(position) {
        const mesh = this.owner?.mesh;
        if (mesh) mesh.position.copy(position);
    }

    // ───────── Rotation ─────────

    /** @returns {THREE.Euler} copy of world rotation. */
    getWorldRotation() {
        const mesh = this.owner?.mesh;
        if (!mesh) return new THREE.Euler();
        return mesh.rotation.clone();
    }

    setWorldRotation(euler) {
        const mesh = this.owner?.mesh;
        if (mesh) mesh.rotation.copy(euler);
    }

    /** @returns {THREE.Quaternion} */
    getWorldQuaternion() {
        const mesh = this.owner?.mesh;
        if (!mesh) return new THREE.Quaternion();
        return mesh.quaternion.clone();
    }

    setWorldQuaternion(quaternion) {
        const mesh = this.owner?.mesh;
        if (mesh) mesh.quaternion.copy(quaternion);
    }

    // ───────── Scale ─────────

    /** @returns {THREE.Vector3} */
    getWorldScale() {
        const mesh = this.owner?.mesh;
        if (!mesh) return new THREE.Vector3(1, 1, 1);
        return mesh.scale.clone();
    }

    setWorldScale(scale) {
        const mesh = this.owner?.mesh;
        if (mesh) {
            if (typeof scale === 'number') {
                mesh.scale.set(scale, scale, scale);
            } else {
                mesh.scale.copy(scale);
            }
        }
    }

    // ───────── Direction helpers ─────────

    /** @returns {THREE.Vector3} world-space forward (-Z in local). */
    getForwardVector() {
        const mesh = this.owner?.mesh;
        if (!mesh) return new THREE.Vector3(0, 0, -1);
        const forward = new THREE.Vector3(0, 0, -1);
        forward.applyQuaternion(mesh.quaternion);
        return forward;
    }

    /** @returns {THREE.Vector3} world-space right (+X in local). */
    getRightVector() {
        const mesh = this.owner?.mesh;
        if (!mesh) return new THREE.Vector3(1, 0, 0);
        const right = new THREE.Vector3(1, 0, 0);
        right.applyQuaternion(mesh.quaternion);
        return right;
    }

    /** @returns {THREE.Vector3} world-space up (+Y in local). */
    getUpVector() {
        const mesh = this.owner?.mesh;
        if (!mesh) return new THREE.Vector3(0, 1, 0);
        const up = new THREE.Vector3(0, 1, 0);
        up.applyQuaternion(mesh.quaternion);
        return up;
    }

    // ───────── Convenience ─────────

    /** Move by a delta in world space. */
    addWorldOffset(delta) {
        const mesh = this.owner?.mesh;
        if (mesh) mesh.position.add(delta);
    }

    /** Rotate by an euler delta. */
    addWorldRotation(eulerDelta) {
        const mesh = this.owner?.mesh;
        if (!mesh) return;
        const q = new THREE.Quaternion().setFromEuler(eulerDelta);
        mesh.quaternion.premultiply(q);
    }

    /** Look at a world position. */
    lookAt(target) {
        const mesh = this.owner?.mesh;
        if (mesh) mesh.lookAt(target);
    }
}
