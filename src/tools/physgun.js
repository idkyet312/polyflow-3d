import * as THREE from 'three';

export function createPhysgunController({
    getCamera,
    getGameplay,
    raycastWorld,
    getActorBody,
    getActorRenderObject,
    PhysicsComponent,
}) {
    const state = {
        equipped: false,
        heldActor: null,
        grabDistance: 5,
        minDistance: 1.5,
        maxDistance: 25,
        springK: 60,
        damping: 6,
        maxSpeed: 30,
        flingImpulse: 18,
    };

    function releaseHeld() {
        state.heldActor = null;
    }

    function setEquipped(equipped) {
        state.equipped = !!equipped;
        if (!state.equipped) releaseHeld();
        const ui = document.getElementById('physgun-crosshair');
        if (ui) ui.classList.toggle('physgun-active', state.equipped);
    }

    function cameraRay() {
        const camera = getCamera();
        const origin = new THREE.Vector3();
        camera.getWorldPosition(origin);
        const direction = new THREE.Vector3();
        camera.getWorldDirection(direction);
        return { origin, direction: direction.normalize() };
    }

    function grabFromCamera() {
        const { origin, direction } = cameraRay();
        const r = raycastWorld(origin, direction, 30);
        if (!r.hit || !r.actor) return false;

        const body = getActorBody(r.actor);
        if (!body) return false;
        state.heldActor = r.actor;
        state.grabDistance = Math.max(state.minDistance, Math.min(state.maxDistance, r.distance));

        const phys = r.actor.getComponentByClass?.(PhysicsComponent);
        phys?.activate?.();
        return true;
    }

    function flingHeld() {
        const actor = state.heldActor;
        if (!actor) return false;
        const phys = actor.getComponentByClass?.(PhysicsComponent);
        if (!phys) {
            releaseHeld();
            return false;
        }

        const { direction } = cameraRay();
        phys.addImpulse(new THREE.Vector3(
            direction.x * state.flingImpulse,
            direction.y * state.flingImpulse + 2.5,
            direction.z * state.flingImpulse,
        ));
        releaseHeld();
        return true;
    }

    function punt() {
        const { origin, direction } = cameraRay();
        const r = raycastWorld(origin, direction, 50);
        if (!r.hit || !r.actor) return false;
        const phys = r.actor.getComponentByClass?.(PhysicsComponent);
        if (!phys) return false;
        phys.activate?.();
        phys.addImpulse(new THREE.Vector3(
            direction.x * state.flingImpulse * 1.6,
            direction.y * state.flingImpulse * 1.6 + 1.5,
            direction.z * state.flingImpulse * 1.6,
        ));
        return true;
    }

    function adjustDistance(delta) {
        state.grabDistance = Math.max(
            state.minDistance,
            Math.min(state.maxDistance, state.grabDistance + delta),
        );
    }

    function tick(delta) {
        if (!state.equipped || !state.heldActor || !getGameplay().active) return;
        const actor = state.heldActor;
        const phys = actor.getComponentByClass?.(PhysicsComponent);
        const mesh = getActorRenderObject(actor);
        if (!phys || !mesh || !phys.isReady()) {
            releaseHeld();
            return;
        }

        const { origin, direction } = cameraRay();
        const target = origin.clone().addScaledVector(direction, state.grabDistance);
        const pos = mesh.getWorldPosition(new THREE.Vector3());
        const vel = phys.getLinearVelocity();
        const ax = state.springK * (target.x - pos.x) - state.damping * vel.x;
        const ay = state.springK * (target.y - pos.y) - state.damping * vel.y;
        const az = state.springK * (target.z - pos.z) - state.damping * vel.z;

        let vx = vel.x + ax * delta;
        let vy = vel.y + ay * delta;
        let vz = vel.z + az * delta;
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (speed > state.maxSpeed) {
            const k = state.maxSpeed / speed;
            vx *= k; vy *= k; vz *= k;
        }
        phys.setLinearVelocity(new THREE.Vector3(vx, vy, vz));

        const av = phys.getAngularVelocity();
        phys.setAngularVelocity(new THREE.Vector3(av.x * 0.85, av.y * 0.85, av.z * 0.85));
    }

    return {
        adjustDistance,
        cameraRay,
        flingHeld,
        grabFromCamera,
        punt,
        releaseHeld,
        setEquipped,
        state,
        tick,
    };
}
