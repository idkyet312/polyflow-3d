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

// Articulated 11-body humanoid rig (GTA-style). Limbs are split at the elbows
// and knees and the torso at the waist so the body folds at real joints instead
// of staying board-straight. Layout is in GROUP-LOCAL space (origin at feet,
// +Y up). [w,h,d] = box size, (x,y) = box center. `bone` = skeleton bone the
// limb drives on FBX buyers (matched by name suffix across rig prefixes).
//
// Index order matters: parents come before children so body creation + the
// bone-bind depth sort stay simple.
const LIMBS = [
    // idx  name        size                  y      x       bone
    { name: 'pelvis',   size: [0.50, 0.42, 0.30], y: 1.00,           bone: 'Hips' },        // 0
    { name: 'chest',    size: [0.54, 0.55, 0.30], y: 1.45,           bone: 'Spine2' },      // 1
    { name: 'head',     size: [0.34, 0.34, 0.34], y: 1.86,           bone: 'Head' },        // 2
    { name: 'upArmL',   size: [0.15, 0.32, 0.15], y: 1.52, x: -0.34, bone: 'LeftArm' },     // 3
    { name: 'foreArmL', size: [0.13, 0.32, 0.13], y: 1.18, x: -0.34, bone: 'LeftForeArm' }, // 4
    { name: 'upArmR',   size: [0.15, 0.32, 0.15], y: 1.52, x: 0.34,  bone: 'RightArm' },    // 5
    { name: 'foreArmR', size: [0.13, 0.32, 0.13], y: 1.18, x: 0.34,  bone: 'RightForeArm' },// 6
    { name: 'thighL',   size: [0.19, 0.45, 0.19], y: 0.72, x: -0.14, bone: 'LeftUpLeg' },   // 7
    { name: 'shinL',    size: [0.16, 0.45, 0.16], y: 0.27, x: -0.14, bone: 'LeftLeg' },     // 8
    { name: 'thighR',   size: [0.19, 0.45, 0.19], y: 0.72, x: 0.14,  bone: 'RightUpLeg' },  // 9
    { name: 'shinR',    size: [0.16, 0.45, 0.16], y: 0.27, x: 0.14,  bone: 'RightLeg' },    // 10
];

// Joints connecting child (b) to parent (a), anchored at the real seam in
// GROUP-LOCAL space.
//   type 'swing': SwingTwistConstraint — cone swing + limited twist (ball joints:
//         neck, shoulders, hips, waist).
//   type 'hinge': HingeConstraint — folds one way around a single axis (elbows,
//         knees). `min`/`max` are the hinge angle limits in degrees; `axis` is
//         the local bend axis (X = left-right, so limbs fold forward/back).
const JOINTS = [
    { a: 0, b: 1,  anchor: [0, 1.20, 0],      anchorBone: 'Spine',        type: 'swing', cone: 35, twist: 25 },  // waist
    { a: 1, b: 2,  anchor: [0, 1.70, 0],      anchorBone: 'Neck',         type: 'swing', cone: 40, twist: 20 },  // neck
    // Shoulders: wide cone so arms flop loosely to the sides/down instead of
    // being pulled into a tight cross over the chest (which read as "posed").
    { a: 1, b: 3,  anchor: [-0.30, 1.66, 0],  anchorBone: 'LeftArm',      type: 'swing', cone: 95, twist: 45 },  // L shoulder
    // Elbows: limited fold (≈110°) so forearms don't curl all the way in.
    { a: 3, b: 4,  anchor: [-0.34, 1.35, 0],  anchorBone: 'LeftForeArm',  type: 'hinge', axis: [1, 0, 0], min: -110, max: 0 },  // L elbow
    { a: 1, b: 5,  anchor: [0.30, 1.66, 0],   anchorBone: 'RightArm',     type: 'swing', cone: 95, twist: 45 },  // R shoulder
    { a: 5, b: 6,  anchor: [0.34, 1.35, 0],   anchorBone: 'RightForeArm', type: 'hinge', axis: [1, 0, 0], min: -110, max: 0 },  // R elbow
    { a: 0, b: 7,  anchor: [-0.14, 0.95, 0],  anchorBone: 'LeftUpLeg',    type: 'swing', cone: 55, twist: 25 },  // L hip
    { a: 7, b: 8,  anchor: [-0.14, 0.50, 0],  anchorBone: 'LeftLeg',      type: 'hinge', axis: [1, 0, 0], min: 0, max: 130 },   // L knee
    { a: 0, b: 9,  anchor: [0.14, 0.95, 0],   anchorBone: 'RightUpLeg',   type: 'swing', cone: 55, twist: 25 },  // R hip
    { a: 9, b: 10, anchor: [0.14, 0.50, 0],   anchorBone: 'RightLeg',     type: 'hinge', axis: [1, 0, 0], min: 0, max: 130 },   // R knee
];

const RAGDOLL_TTL_MS = 9000;

// Find the bone whose name ends with `suffix` (after the optional "prefix:"
// namespace). Searches the skeleton's bone list — FBX armatures are usually
// SIBLINGS of the SkinnedMesh, not children, so traversing the mesh subtree
// misses them; skeleton.bones is the reliable source.
function matchesSuffix(name, suffix) {
    return name === suffix || name.endsWith(':' + suffix) || name.endsWith(suffix);
}
function findBoneBySuffix(skinnedMesh, suffix) {
    const bones = skinnedMesh?.skeleton?.bones || [];
    for (const b of bones) if (matchesSuffix(b.name || '', suffix)) return b;
    return null;
}

const FBX_DRIVER_SEGMENTS = [
    { from: 'Hips', to: 'Spine' },
    { from: 'Spine', to: 'Neck' },
    { from: 'Head', to: 'HeadTop_End' },
    { from: 'LeftArm', to: 'LeftForeArm' },
    { from: 'LeftForeArm', to: 'LeftHand' },
    { from: 'RightArm', to: 'RightForeArm' },
    { from: 'RightForeArm', to: 'RightHand' },
    { from: 'LeftUpLeg', to: 'LeftLeg' },
    { from: 'LeftLeg', to: 'LeftFoot' },
    { from: 'RightUpLeg', to: 'RightLeg' },
    { from: 'RightLeg', to: 'RightFoot' },
];
const FBX_ANCHOR_BONES = [...new Set(JOINTS.map((j) => j.anchorBone).filter(Boolean))];
const _driverUp = new THREE.Vector3(0, 1, 0);

function buildFbxDriverRig(skinnedMesh) {
    skinnedMesh?.skeleton?.update?.();
    const anchors = {};
    const points = {};
    const addPoint = (suffix) => {
        if (!suffix) return null;
        if (points[suffix]) return points[suffix];
        const bone = findBoneBySuffix(skinnedMesh, suffix);
        if (!bone) return null;
        bone.updateWorldMatrix(true, false);
        points[suffix] = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
        return points[suffix];
    };

    for (const jointBone of FBX_ANCHOR_BONES) {
        const point = addPoint(jointBone);
        if (point) anchors[jointBone] = point.clone();
    }

    const fallbackQuat = new THREE.Quaternion();
    skinnedMesh?.getWorldQuaternion?.(fallbackQuat);
    const drivers = FBX_DRIVER_SEGMENTS.map((segment) => {
        const from = addPoint(segment.from);
        const to = addPoint(segment.to);
        if (!from) return null;
        const position = from.clone();
        const quaternion = fallbackQuat.clone();
        if (to) {
            const dir = new THREE.Vector3().subVectors(to, from);
            if (dir.lengthSq() > 1e-8) {
                position.add(to).multiplyScalar(0.5);
                quaternion.setFromUnitVectors(_driverUp, dir.normalize());
            }
        }
        return { position, quaternion };
    });
    return { drivers, anchors };
}

let _activeRagdolls = []; // { parts:[{mesh,body}], constraints:[], diesAt }
let _ragdollDiagLogged = false; // one-shot console diagnostic

// Build a standing humanoid group. skinColor/shirtColor tint head vs torso/limbs.
export function makePerson({ skinColor = '#e8b893', shirtColor = '#3da6ff', pantsColor = '#1f2933' } = {}) {
    const group = new THREE.Group();
    group.userData.isRagdollPerson = true;
    const matFor = (name) => {
        const isLeg = name === 'thighL' || name === 'thighR' || name === 'shinL' || name === 'shinR';
        const c = name === 'head' ? skinColor
            : isLeg ? pantsColor
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

    // FBX buyer? The skinned Man/Emmy mesh becomes the ragdoll: the box limbs
    // stay as invisible physics drivers and we pose the skeleton from them.
    const fbxVisual = group.userData.walkingVisualAttached ? group.userData.walkingVisual : null;
    let skinnedMesh = null;
    if (fbxVisual) {
        // Freeze the walk animation on its current pose so the mixer does not
        // fight the physics-driven bones.
        try {
            const action = group.userData.walkingAction;
            if (action) { action.paused = true; action.enabled = false; }
        } catch (e) {}
        // The buyer may have been in LOD-far state (FBX hidden, box rig shown) —
        // force the skinned mesh visible so it becomes the ragdoll, not the box.
        fbxVisual.visible = true;
        fbxVisual.traverse((o) => {
            if (o.isSkinnedMesh) {
                o.visible = true;
                // A SkinnedMesh culls against its STATIC bind-pose bounding
                // volume. Once the ragdoll flops, bones move outside that box and
                // three.js wrongly culls the whole mesh → the body pops out of
                // existence near the screen edge. Disable culling for the doll
                // (its extent is now physics-driven, not the bind pose).
                o.frustumCulled = false;
                if (!skinnedMesh) skinnedMesh = o;
            }
        });
    }
    const driveBones = !!(fbxVisual && skinnedMesh);
    const fbxRig = driveBones ? buildFbxDriverRig(skinnedMesh) : null;

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
        // When the skinned mesh is the ragdoll, the boxes are invisible drivers.
        mesh.visible = !driveBones;
        mesh.castShadow = !driveBones;
        mesh.receiveShadow = !driveBones;
        const driver = fbxRig?.drivers?.[i] || null;
        if (driver) {
            _p.copy(driver.position);
            _q.copy(driver.quaternion);
        } else {
            mesh.getWorldPosition(_p);
            mesh.getWorldQuaternion(_q);
        }
        // Detach part into the scene root so we can drive it from physics.
        scene.attach(mesh);
        if (driver) {
            mesh.position.copy(_p);
            mesh.quaternion.copy(_q);
            mesh.updateMatrixWorld(true);
        }

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
        settings.mFriction = 0.8;          // grippy so it doesn't slide on landing
        settings.mRestitution = 0.0;       // no bounce
        settings.mLinearDamping = 0.5;
        settings.mAngularDamping = 0.8;    // higher → limbs settle/limp instead of flailing
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

    // Link each limb to its parent at the real seam. Ball joints (neck, waist,
    // shoulders, hips) use a SwingTwistConstraint (cone swing + limited twist);
    // elbows and knees use a HingeConstraint so they fold one way only — that
    // single-axis fold is what makes the collapse read as a body and not a
    // mannequin. Anchors/axes are world-space (transformed from group-local).
    const constraints = [];
    const torsoEntry = bodyByIdx[0];
    const DEG = Math.PI / 180;
    const _anchor = new THREE.Vector3();
    const _twist = new THREE.Vector3();
    const _limbCenter = new THREE.Vector3();
    const _plane = new THREE.Vector3();
    const _hingeAxis = new THREE.Vector3();
    const _normal = new THREE.Vector3();
    const _up = new THREE.Vector3(0, 1, 0);
    const _rotOnly = new THREE.Matrix4().extractRotation(groupMatrix);
    for (const j of JOINTS) {
        const a = bodyByIdx[j.a];
        const b = bodyByIdx[j.b];
        if (!a || !b) continue;
        const boneAnchor = j.anchorBone ? fbxRig?.anchors?.[j.anchorBone] : null;
        if (boneAnchor) {
            _anchor.copy(boneAnchor);
        } else {
            _anchor.set(j.anchor[0], j.anchor[1], j.anchor[2]).applyMatrix4(groupMatrix);
        }

        let cs;
        if (j.type === 'hinge') {
            // Hinge axis is given in group-local space; rotate (not translate)
            // into world. The reference normal is the limb's long axis projected
            // perpendicular to the hinge so the angle limits are oriented right.
            _hingeAxis.set(j.axis[0], j.axis[1], j.axis[2]).applyMatrix4(_rotOnly).normalize();
            const bp = b.body.GetPosition();
            _limbCenter.set(bp.GetX(), bp.GetY(), bp.GetZ());
            _normal.copy(_limbCenter).sub(_anchor);
            _normal.addScaledVector(_hingeAxis, -_normal.dot(_hingeAxis)); // perp to axis
            if (_normal.lengthSq() < 1e-6) _normal.set(0, -1, 0);
            _normal.normalize();

            cs = new Jolt.HingeConstraintSettings();
            cs.mSpace = Jolt.EConstraintSpace_WorldSpace;
            cs.mPoint1 = new Jolt.RVec3(_anchor.x, _anchor.y, _anchor.z);
            cs.mPoint2 = new Jolt.RVec3(_anchor.x, _anchor.y, _anchor.z);
            cs.mHingeAxis1 = new Jolt.Vec3(_hingeAxis.x, _hingeAxis.y, _hingeAxis.z);
            cs.mHingeAxis2 = new Jolt.Vec3(_hingeAxis.x, _hingeAxis.y, _hingeAxis.z);
            cs.mNormalAxis1 = new Jolt.Vec3(_normal.x, _normal.y, _normal.z);
            cs.mNormalAxis2 = new Jolt.Vec3(_normal.x, _normal.y, _normal.z);
            cs.mLimitsMin = (j.min ?? -150) * DEG;
            cs.mLimitsMax = (j.max ?? 0) * DEG;
        } else {
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

            cs = new Jolt.SwingTwistConstraintSettings();
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
        }
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

    // Bind the skinned skeleton to the physics bodies. For each driven bone we
    // capture a constant offset matrix M = bodyWorld₀⁻¹ · boneWorld₀ at the
    // moment of death, so each frame boneWorld = bodyWorld · M reproduces the
    // exact rest relationship (the bone keeps its length/orientation relative to
    // its driving box). update() then converts that to the bone's local matrix.
    let boneBindings = null;
    if (driveBones) {
        skinnedMesh.skeleton?.update?.();
        const bindings = [];
        const _bodyWorld = new THREE.Matrix4();
        const _bp = new THREE.Vector3();
        const _bq = new THREE.Quaternion();
        const _one = new THREE.Vector3(1, 1, 1);
        for (let i = 0; i < LIMBS.length; i++) {
            const suffix = LIMBS[i].bone;
            const entry = bodyByIdx[i];
            if (!suffix || !entry) continue;
            const bone = findBoneBySuffix(skinnedMesh, suffix);
            if (!bone) continue;
            bone.updateWorldMatrix(true, false);
            const bp = entry.body.GetPosition();
            const bq = entry.body.GetRotation();
            _bp.set(bp.GetX(), bp.GetY(), bp.GetZ());
            _bq.set(bq.GetX(), bq.GetY(), bq.GetZ(), bq.GetW());
            _bodyWorld.compose(_bp, _bq, _one);
            // M = bodyWorld⁻¹ · boneWorld
            const offset = new THREE.Matrix4().copy(_bodyWorld).invert().multiply(bone.matrixWorld);
            let depth = 0; for (let p = bone.parent; p; p = p.parent) depth++;
            bindings.push({ bone, body: entry.body, offset, depth });
        }
        // Drive parents (Hips) before children so each child's local matrix is
        // computed against an already-updated parent world matrix.
        bindings.sort((a, b) => a.depth - b.depth);
        if (bindings.length) boneBindings = bindings;
        // Re-parent the visual to the scene root so it survives the group removal
        // below, preserving its current world transform.
        try { scene.attach(fbxVisual); } catch (e) {}
    }

    // Push the WHOLE body at one uniform velocity so it flies/topples as a unit.
    // Setting the same linear velocity on every limb (rather than an impulse on
    // one part) means there's no internal velocity differential for the joints
    // to fight — so it never stretches or bursts apart on the first step. The
    // torso gets a little extra spin so the fall reads naturally.
    if (impulse) {
        const vx = impulse.x || 0, vy = (impulse.y || 0), vz = impulse.z || 0;
        const hit = impulse.point;
        if (hit && Number.isFinite(hit.x) && Number.isFinite(hit.y) && Number.isFinite(hit.z)) {
            const drift = new Jolt.Vec3(vx * 0.18, vy * 0.12, vz * 0.18);
            for (const { body } of made) bodyInterface.SetLinearVelocity(body.GetID(), drift);
            Jolt.destroy(drift);

            let target = torsoEntry?.body || made[0]?.body || null;
            let bestD2 = Infinity;
            for (const { body } of made) {
                const p = body.GetPosition();
                const dx = p.GetX() - hit.x, dy = p.GetY() - hit.y, dz = p.GetZ() - hit.z;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < bestD2) { bestD2 = d2; target = body; }
            }
            if (target) {
                const push = new Jolt.Vec3(vx, vy, vz);
                const point = new Jolt.RVec3(hit.x, hit.y, hit.z);
                bodyInterface.AddImpulse(target.GetID(), push, point);
                bodyInterface.ActivateBody?.(target.GetID());
                Jolt.destroy(push);
                Jolt.destroy(point);
            }
        } else {
            const vel = new Jolt.Vec3(vx, vy, vz);
            for (const { body } of made) {
                bodyInterface.SetLinearVelocity(body.GetID(), vel);
            }
            Jolt.destroy(vel);
            const spin = new Jolt.Vec3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3);
            if (torsoEntry) bodyInterface.SetAngularVelocity(torsoEntry.body.GetID(), spin);
            Jolt.destroy(spin);
        }
    }

    // Drop the now-empty group.
    try { group.parent?.remove(group); } catch (e) {}

    _activeRagdolls.push({
        parts: made,
        constraints,
        filter,
        boneBindings,                 // null for box ragdolls; [{bone,body,offset}] for FBX
        visual: driveBones ? fbxVisual : null,
        diesAt: (performance.now?.() || Date.now()) + RAGDOLL_TTL_MS,
    });
}

// Pose an FBX skeleton from its physics bodies. For each driven bone:
//   boneWorld = bodyWorld · offset           (offset captured at death)
//   boneLocal = parentWorld⁻¹ · boneWorld
// Bindings are pre-sorted parent-first so each parent's world matrix is current
// before its children are solved. Bones with no driver follow their parent.
const _sbBodyWorld = new THREE.Matrix4();
const _sbBoneWorld = new THREE.Matrix4();
const _sbParentInv = new THREE.Matrix4();
const _sbPos = new THREE.Vector3();
const _sbQuat = new THREE.Quaternion();
const _sbScale = new THREE.Vector3();
function syncBoneRagdoll(doll) {
    for (const { bone, body, offset } of doll.boneBindings) {
        const p = body.GetPosition();
        const q = body.GetRotation();
        _sbPos.set(p.GetX(), p.GetY(), p.GetZ());
        _sbQuat.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
        _sbBodyWorld.compose(_sbPos, _sbQuat, _sbScale.set(1, 1, 1));
        _sbBoneWorld.multiplyMatrices(_sbBodyWorld, offset);
        const parent = bone.parent;
        if (parent) {
            parent.updateWorldMatrix(true, false);
            _sbParentInv.copy(parent.matrixWorld).invert();
            bone.matrix.multiplyMatrices(_sbParentInv, _sbBoneWorld);
        } else {
            bone.matrix.copy(_sbBoneWorld);
        }
        bone.matrix.decompose(bone.position, bone.quaternion, bone.scale);
        bone.updateWorldMatrix(false, false);
    }
    // Refresh the rest of the skeleton + skinning from the new bone poses.
    doll.visual?.updateMatrixWorld?.(true);
}

// Per-frame: copy Jolt body transforms onto the meshes, retire expired dolls.
export function update() {
    if (!_activeRagdolls.length) return;
    const now = performance.now?.() || Date.now();
    for (let r = _activeRagdolls.length - 1; r >= 0; r--) {
        const doll = _activeRagdolls[r];
        if (doll.boneBindings) {
            syncBoneRagdoll(doll);
        } else {
            for (const { mesh, body } of doll.parts) {
                if (!mesh || !body) continue;
                const p = body.GetPosition();
                const q = body.GetRotation();
                mesh.position.set(p.GetX(), p.GetY(), p.GetZ());
                mesh.quaternion.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
            }
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
    // FBX ragdoll: remove the posed skinned visual from the scene. Don't dispose
    // its geometry/materials — pooled clones may share those buffers. The buyer
    // pool simply rebuilds a fresh visual on demand (acquire has a build path).
    if (doll.visual) {
        try { doll.visual.parent?.remove(doll.visual); } catch (e) {}
        doll.visual = null;
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
