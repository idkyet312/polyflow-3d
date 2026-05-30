// Lightweight humanoid + Jolt ragdoll for Drug Tycoon NPCs.
//
// A "person" is a THREE.Group of 7 boxes (head, torso, 2 upper-arm, 2 thigh —
// simplified to readable limbs). While alive it's moved kinematically by the
// game (no physics). On death it's converted to a ragdoll: each body part gets
// its own Jolt dynamic box body, linked by PointConstraints so the skeleton
// hangs together and flops, with an impulse applied. A per-frame sync copies
// each Jolt body transform back onto its mesh part. Ragdolls auto-expire.
//
// Self-contained: manages its own active list and exposes makePerson() /
// ragdollify() / update() / removeAll(). The `physics` object is NOT bound on
// appCore, so runtime injects it via setPhysics(); scene/camera ARE on appCore.
import * as THREE from 'three';
import { core } from '../runtime/appCore.js';

// Injected by runtime.js (the Jolt physics handle isn't on appCore).
let _physics = null;
export function setPhysics(physics) { _physics = physics; }

// Limb layout in local space (group origin at feet, +Y up). [w,h,d] + center y.
const LIMBS = [
    { name: 'torso', size: [0.55, 0.75, 0.30], y: 1.25 },
    { name: 'head',  size: [0.36, 0.36, 0.36], y: 1.82 },
    { name: 'armL',  size: [0.16, 0.62, 0.16], y: 1.30, x: -0.42 },
    { name: 'armR',  size: [0.16, 0.62, 0.16], y: 1.30, x: 0.42 },
    { name: 'legL',  size: [0.20, 0.85, 0.20], y: 0.45, x: -0.16 },
    { name: 'legR',  size: [0.20, 0.85, 0.20], y: 0.45, x: 0.16 },
];

// Joints (indices into LIMBS) anchored at the real seam in GROUP-LOCAL space
// (neck, shoulder, hip). Each is a swing-twist joint with anatomical-ish angle
// limits so limbs bend and flop like a GTA ragdoll instead of spinning freely
// (PointConstraint) — and never hyperextend or pop off.
//   cone  = max swing half-angle (deg) the limb can lift away from rest
//   twist = max twist (deg) around the limb's own axis
const JOINTS = [
    { a: 0, b: 1, anchor: [0, 1.62, 0],     cone: 45, twist: 30 },  // neck
    { a: 0, b: 2, anchor: [-0.30, 1.55, 0], cone: 90, twist: 45 },  // L shoulder
    { a: 0, b: 3, anchor: [0.30, 1.55, 0],  cone: 90, twist: 45 },  // R shoulder
    { a: 0, b: 4, anchor: [-0.16, 0.90, 0], cone: 60, twist: 30 },  // L hip
    { a: 0, b: 5, anchor: [0.16, 0.90, 0],  cone: 60, twist: 30 },  // R hip
];

const RAGDOLL_TTL_MS = 9000;

let _activeRagdolls = []; // { parts:[{mesh,body}], constraints:[], diesAt }
let _ragdollDiagLogged = false; // one-shot console diagnostic

// Build a standing humanoid group. skinColor/shirtColor tint head vs torso/limbs.
export function makePerson({ skinColor = '#e8b893', shirtColor = '#3da6ff', pantsColor = '#1f2933' } = {}) {
    const group = new THREE.Group();
    group.userData.isRagdollPerson = true;
    const matFor = (name) => {
        const c = name === 'head' ? skinColor
            : (name === 'legL' || name === 'legR') ? pantsColor
            : shirtColor;
        return new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, metalness: 0.04 });
    };
    group.userData.parts = LIMBS.map((l) => {
        const geo = new THREE.BoxGeometry(l.size[0], l.size[1], l.size[2]);
        const mesh = new THREE.Mesh(geo, matFor(l.name));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.position.set(l.x ?? 0, l.y, 0);
        mesh.userData.limb = l.name;
        group.add(mesh);
        return mesh;
    });
    return group;
}

// Convert a live person group into a free-floating Jolt ragdoll. `impulse` is a
// {x,y,z} world-space shove applied to the torso (e.g. away from the cop).
export function ragdollify(group, impulse = null) {
    const { scene } = core;
    const physics = _physics;
    if (!group || !physics?.ready || !scene) { fallbackBurst(group, impulse); return; }
    const { Jolt, bodyInterface, physicsSystem } = physics;
    if (!Jolt || !bodyInterface || !physicsSystem) { fallbackBurst(group, impulse); return; }

    group.updateWorldMatrix(true, true);
    const groupMatrix = group.matrixWorld.clone(); // capture before detaching parts
    const parts = group.userData.parts || [];
    const movingLayer = 1;

    // One group-filter table per ragdoll: all limbs share a group ID and we
    // disable collision between EVERY limb pair. Without this the overlapping
    // limb boxes (shoulder inside torso, etc.) push against each other and the
    // body explodes apart on the first physics step.
    const filter = new Jolt.GroupFilterTable(LIMBS.length);
    filter.AddRef();
    for (let i = 0; i < LIMBS.length; i++) {
        for (let j = i + 1; j < LIMBS.length; j++) filter.DisableCollision(i, j);
    }
    const RAGDOLL_GROUP_ID = (Math.random() * 0x7fffffff) | 0;

    const made = [];
    const bodyByIdx = {};
    const _q = new THREE.Quaternion();
    const _p = new THREE.Vector3();

    for (let i = 0; i < LIMBS.length; i++) {
        const limb = LIMBS[i];
        const mesh = parts[i];
        if (!mesh) continue;
        mesh.visible = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.getWorldPosition(_p);
        mesh.getWorldQuaternion(_q);
        // Detach part into the scene root so we can drive it from physics.
        scene.attach(mesh);

        const half = new Jolt.Vec3(limb.size[0] * 0.5, limb.size[1] * 0.5, limb.size[2] * 0.5);
        const shapeSettings = new Jolt.BoxShapeSettings(half);
        const shapeResult = shapeSettings.Create();
        const shape = shapeResult.Get();
        shape.AddRef();
        shapeResult.Clear();
        Jolt.destroy(shapeResult);
        Jolt.destroy(shapeSettings);
        Jolt.destroy(half);

        const pos = new Jolt.RVec3(_p.x, _p.y, _p.z);
        const rot = new Jolt.Quat(_q.x, _q.y, _q.z, _q.w);
        const settings = new Jolt.BodyCreationSettings(shape, pos, rot, Jolt.EMotionType_Dynamic, movingLayer);
        settings.mFriction = 0.7;
        settings.mRestitution = 0.0;
        settings.mLinearDamping = 0.4;
        settings.mAngularDamping = 0.6;
        const body = bodyInterface.CreateBody(settings);
        // Share the no-self-collision filter. GetCollisionGroup() on the live
        // body returns a real reference (settings.mCollisionGroup in embind is a
        // copy and may not write back), so set it here after creation.
        const cg = body.GetCollisionGroup();
        cg.SetGroupFilter(filter);
        cg.SetGroupID(RAGDOLL_GROUP_ID);
        cg.SetSubGroupID(i);
        bodyInterface.AddBody(body.GetID(), Jolt.EActivation_Activate);
        Jolt.destroy(settings);
        Jolt.destroy(pos);
        Jolt.destroy(rot);

        made.push({ mesh, body });
        bodyByIdx[i] = { body, mesh };
    }

    // Link limbs to the torso with SWING-TWIST joints at the real seam. Each
    // joint pins both bodies to the seam point AND limits how far the limb can
    // swing (cone) and twist — so the body flops with believable, jointed motion
    // (GTA-style) rather than spinning freely or hyperextending.
    const constraints = [];
    const torsoEntry = bodyByIdx[0];
    const DEG = Math.PI / 180;
    const _anchor = new THREE.Vector3();
    const _twist = new THREE.Vector3();
    const _limbCenter = new THREE.Vector3();
    const _plane = new THREE.Vector3();
    const _up = new THREE.Vector3(0, 1, 0);
    for (const j of JOINTS) {
        const a = bodyByIdx[j.a];
        const b = bodyByIdx[j.b];
        if (!a || !b) continue;
        _anchor.set(j.anchor[0], j.anchor[1], j.anchor[2]).applyMatrix4(groupMatrix);
        // Twist axis = seam → limb-body center (the limb's long axis).
        const bp = b.body.GetPosition();
        _limbCenter.set(bp.GetX(), bp.GetY(), bp.GetZ());
        _twist.copy(_limbCenter).sub(_anchor);
        if (_twist.lengthSq() < 1e-6) _twist.set(0, -1, 0);
        _twist.normalize();
        // Plane axis = any unit vector perpendicular to twist.
        _plane.copy(_up);
        if (Math.abs(_twist.dot(_up)) > 0.95) _plane.set(1, 0, 0);
        _plane.cross(_twist).normalize();

        const cs = new Jolt.SwingTwistConstraintSettings();
        // Anchors + axes are given in world space (must be set explicitly —
        // SwingTwist defaults to body-local, which would garble the joint).
        cs.mSpace = Jolt.EConstraintSpace_WorldSpace;
        cs.mPosition1 = new Jolt.RVec3(_anchor.x, _anchor.y, _anchor.z);
        cs.mPosition2 = new Jolt.RVec3(_anchor.x, _anchor.y, _anchor.z);
        cs.mTwistAxis1 = new Jolt.Vec3(_twist.x, _twist.y, _twist.z);
        cs.mTwistAxis2 = new Jolt.Vec3(_twist.x, _twist.y, _twist.z);
        cs.mPlaneAxis1 = new Jolt.Vec3(_plane.x, _plane.y, _plane.z);
        cs.mPlaneAxis2 = new Jolt.Vec3(_plane.x, _plane.y, _plane.z);
        cs.mNormalHalfConeAngle = j.cone * DEG;
        cs.mPlaneHalfConeAngle = j.cone * DEG;
        cs.mTwistMinAngle = -j.twist * DEG;
        cs.mTwistMaxAngle = j.twist * DEG;
        try {
            const constraint = cs.Create(a.body, b.body);
            physicsSystem.AddConstraint(constraint);
            constraints.push(constraint);
        } catch (e) {
            console.error('[ragdoll] joint create failed', j, e);
        }
        Jolt.destroy(cs);
    }
    if (!_ragdollDiagLogged) {
        _ragdollDiagLogged = true;
        console.log(`[ragdoll] bodies=${made.length} constraints=${constraints.length}`);
    }

    // Push the WHOLE body at one uniform velocity so it flies/topples as a unit.
    // Setting the same linear velocity on every limb (rather than an impulse on
    // one part) means there's no internal velocity differential for the joints
    // to fight — so it never stretches or bursts apart on the first step. The
    // torso gets a little extra spin so the fall reads naturally.
    if (impulse) {
        const vx = impulse.x || 0, vy = (impulse.y || 0), vz = impulse.z || 0;
        const vel = new Jolt.Vec3(vx, vy, vz);
        for (const { body } of made) {
            bodyInterface.SetLinearVelocity(body.GetID(), vel);
        }
        Jolt.destroy(vel);
        if (torsoEntry) {
            const spin = new Jolt.Vec3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3);
            bodyInterface.SetAngularVelocity(torsoEntry.body.GetID(), spin);
            Jolt.destroy(spin);
        }
    }

    // Drop the now-empty group.
    try { group.parent?.remove(group); } catch (e) {}

    _activeRagdolls.push({
        parts: made,
        constraints,
        filter,
        diesAt: (performance.now?.() || Date.now()) + RAGDOLL_TTL_MS,
    });
}

// Per-frame: copy Jolt body transforms onto the meshes, retire expired dolls.
export function update() {
    if (!_activeRagdolls.length) return;
    const now = performance.now?.() || Date.now();
    for (let r = _activeRagdolls.length - 1; r >= 0; r--) {
        const doll = _activeRagdolls[r];
        for (const { mesh, body } of doll.parts) {
            if (!mesh || !body) continue;
            const p = body.GetPosition();
            const q = body.GetRotation();
            mesh.position.set(p.GetX(), p.GetY(), p.GetZ());
            mesh.quaternion.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
        }
        if (now >= doll.diesAt) {
            destroyRagdoll(doll);
            _activeRagdolls.splice(r, 1);
        }
    }
}

function destroyRagdoll(doll) {
    const { scene } = core;
    const physics = _physics;
    const bodyInterface = physics?.bodyInterface;
    const physicsSystem = physics?.physicsSystem;
    for (const c of doll.constraints) {
        try { physicsSystem?.RemoveConstraint(c); } catch (e) {}
    }
    for (const { mesh, body } of doll.parts) {
        if (body && bodyInterface) {
            try {
                const id = body.GetID();
                bodyInterface.RemoveBody(id);
                bodyInterface.DestroyBody(id);
            } catch (e) {}
        }
        if (mesh) {
            try { scene?.remove(mesh); mesh.geometry?.dispose?.(); mesh.material?.dispose?.(); } catch (e) {}
        }
    }
    if (doll.filter) {
        try { doll.filter.Release(); } catch (e) {}
        doll.filter = null;
    }
}

export function removeAll() {
    for (const doll of _activeRagdolls) destroyRagdoll(doll);
    _activeRagdolls = [];
}

// No-physics fallback: just scatter the limb meshes with a quick fade so a
// "death" still reads even if Jolt isn't ready.
function fallbackBurst(group, impulse) {
    const { scene } = core;
    if (!group) return;
    const parts = group.userData?.parts || [];
    group.updateWorldMatrix(true, true);
    for (const mesh of parts) {
        if (!mesh) continue;
        mesh.visible = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene?.attach?.(mesh);
        mesh.userData._vy = 3 + Math.random() * 2;
        mesh.userData._vx = (impulse?.x || 0) * 0.3 + (Math.random() - 0.5) * 3;
        mesh.userData._vz = (impulse?.z || 0) * 0.3 + (Math.random() - 0.5) * 3;
        mesh.userData._fallStart = performance.now?.() || Date.now();
        _fallParts.push(mesh);
    }
    try { group.parent?.remove(group); } catch (e) {}
}

let _fallParts = [];
// Drives the fallback (non-Jolt) scatter. Called from update() too.
export function updateFallback(delta = 0.016) {
    if (!_fallParts.length) return;
    const { scene } = core;
    const now = performance.now?.() || Date.now();
    const dt = Math.min(0.05, delta);
    for (let i = _fallParts.length - 1; i >= 0; i--) {
        const m = _fallParts[i];
        m.userData._vy -= 9.8 * dt;
        m.position.x += m.userData._vx * dt;
        m.position.y += m.userData._vy * dt;
        m.position.z += m.userData._vz * dt;
        m.rotation.x += dt * 4; m.rotation.z += dt * 3;
        if (m.position.y < 0.1) { m.position.y = 0.1; m.userData._vy = 0; m.userData._vx *= 0.6; m.userData._vz *= 0.6; }
        if (now - m.userData._fallStart > RAGDOLL_TTL_MS) {
            try { scene?.remove(m); m.geometry?.dispose?.(); m.material?.dispose?.(); } catch (e) {}
            _fallParts.splice(i, 1);
        }
    }
}
