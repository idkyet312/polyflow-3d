import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
//  Lite physics pool
//
//  Spawns thousands of dynamic boxes (or a custom shape) without going through
//  the Actor / Entity / SceneSystem / script pipeline. No tick, no metadata,
//  no per-body shadow flags, no collision callbacks. The pool owns:
//   - one shared Jolt shape (BoxShape by default)
//   - one parallel array of Jolt bodies
//   - one THREE.InstancedMesh that mirrors the bodies' position+rotation each frame
//
//  The trade-off vs. the actor path:
//   - no scripts, no UE-style components, no scene-graph node
//   - no per-instance collision callbacks
//   - one draw call for the entire batch
//   - sync is a tight loop writing into an InstancedMesh.matrix array
//
//  Usage:
//      const pool = createLitePhysicsPool({
//          physics, scene,
//          capacity: 3000,
//          color: 0x88aaff,
//          halfExtent: 0.25,
//      });
//      pool.spawn({ x, y, z });               // returns an integer slot id, or -1 if full
//      pool.spawn({ x, y, z }, { vx, vy, vz }); // with initial velocity
//      pool.update();                            // call after physics step
//      pool.clear();
//      pool.dispose();
// ─────────────────────────────────────────────────────────────────────────────

const _tempMatrix = new THREE.Matrix4();
const _tempPosition = new THREE.Vector3();
const _tempQuaternion = new THREE.Quaternion();
const _tempScale = new THREE.Vector3(1, 1, 1);

function defaultBoxGeometry(halfExtent) {
    return new THREE.BoxGeometry(halfExtent * 2, halfExtent * 2, halfExtent * 2);
}

export function createLitePhysicsPool({
    physics,
    scene,
    capacity = 3000,
    halfExtent = 0.25,
    color = 0x99bbff,
    geometry = null,
    material = null,
    layer = null,
    friction = 0.5,
    restitution = 0.1,
    linearDamping = 0.05,
    angularDamping = 0.05,
    allowSleeping = true,
    castShadow = false,
    receiveShadow = false,
} = {}) {
    if (!physics?.ready) {
        throw new Error('createLitePhysicsPool: physics is not ready');
    }

    const { Jolt, bodyInterface } = physics;

    // ─── Shared Jolt shape ──────────────────────────────────────────────────
    const halfExtentVec = new Jolt.Vec3(halfExtent, halfExtent, halfExtent);
    const shapeSettings = new Jolt.BoxShapeSettings(halfExtentVec, 0.05);
    const shapeResult = shapeSettings.Create();
    if (!shapeResult.IsValid()) {
        const err = shapeResult.HasError() ? shapeResult.GetError() : 'shape creation failed';
        Jolt.destroy(shapeResult);
        Jolt.destroy(shapeSettings);
        Jolt.destroy(halfExtentVec);
        throw new Error(err);
    }
    const sharedShape = shapeResult.Get();
    sharedShape.AddRef();
    shapeResult.Clear();
    Jolt.destroy(shapeResult);
    Jolt.destroy(shapeSettings);
    Jolt.destroy(halfExtentVec);

    // ─── InstancedMesh ──────────────────────────────────────────────────────
    const ownsGeometry = !geometry;
    const ownsMaterial = !material;
    const geo = geometry ?? defaultBoxGeometry(halfExtent);
    const mat = material ?? new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.05 });
    const instancedMesh = new THREE.InstancedMesh(geo, mat, capacity);
    instancedMesh.frustumCulled = true;
    instancedMesh.castShadow = castShadow;
    instancedMesh.receiveShadow = receiveShadow;
    instancedMesh.count = 0;
    instancedMesh.userData.isLitePhysicsPool = true;
    instancedMesh.name = 'LitePhysicsPool';
    if (scene) scene.add(instancedMesh);

    // Hide all instances initially by collapsing their transform.
    const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) {
        instancedMesh.setMatrixAt(i, zeroMatrix);
    }
    instancedMesh.instanceMatrix.needsUpdate = true;

    // ─── Parallel body array ────────────────────────────────────────────────
    const bodies = new Array(capacity).fill(null);
    let count = 0;

    // Default to the moving layer if not provided. Engine convention in this
    // project: moving layer index = 1.
    const objectLayer = layer ?? 1;

    // Reusable scratch Jolt primitives for spawn() — allocating a fresh
    // RVec3/Quat/Vec3 per body adds up fast at 3000 spawns.
    const _scratchPos = new Jolt.RVec3(0, 0, 0);
    const _scratchRot = new Jolt.Quat(0, 0, 0, 1);
    const _scratchVel = new Jolt.Vec3(0, 0, 0);
    const _scratchSettings = new Jolt.BodyCreationSettings(
        sharedShape,
        _scratchPos,
        _scratchRot,
        Jolt.EMotionType_Dynamic,
        objectLayer
    );
    _scratchSettings.mFriction = friction;
    _scratchSettings.mRestitution = restitution;
    _scratchSettings.mLinearDamping = linearDamping;
    _scratchSettings.mAngularDamping = angularDamping;
    _scratchSettings.mAllowSleeping = allowSleeping;

    function spawn(position, velocity = null) {
        if (count >= capacity) return -1;

        const slot = count;
        _scratchPos.Set(position.x, position.y, position.z);
        _scratchSettings.mPosition = _scratchPos;
        _scratchSettings.mRotation = _scratchRot;

        const body = bodyInterface.CreateBody(_scratchSettings);
        bodyInterface.AddBody(body.GetID(), Jolt.EActivation_Activate);

        if (velocity) {
            _scratchVel.Set(velocity.vx ?? 0, velocity.vy ?? 0, velocity.vz ?? 0);
            bodyInterface.SetLinearVelocity(body.GetID(), _scratchVel);
        }

        bodies[slot] = body;
        count++;
        instancedMesh.count = count;
        return slot;
    }

    function spawnGrid({ origin, dimsX = 10, dimsY = 10, dimsZ = 10, spacing = 1.1, jitter = 0 }) {
        const startX = origin.x - ((dimsX - 1) * spacing) * 0.5;
        const startZ = origin.z - ((dimsZ - 1) * spacing) * 0.5;
        let spawned = 0;
        for (let yi = 0; yi < dimsY; yi++) {
            for (let zi = 0; zi < dimsZ; zi++) {
                for (let xi = 0; xi < dimsX; xi++) {
                    if (count >= capacity) return spawned;
                    const px = startX + xi * spacing + (jitter ? (Math.random() - 0.5) * jitter : 0);
                    const py = origin.y + yi * spacing + (jitter ? (Math.random() - 0.5) * jitter : 0);
                    const pz = startZ + zi * spacing + (jitter ? (Math.random() - 0.5) * jitter : 0);
                    spawn({ x: px, y: py, z: pz });
                    spawned++;
                }
            }
        }
        return spawned;
    }

    // Tracks which slots changed this frame. We use it for `setUpdateRange` so
    // Three.js only re-uploads the dirty span of the matrix buffer to the GPU.
    let dirtyMin = -1;
    let dirtyMax = -1;

    function update() {
        if (count === 0) return;
        const matrixArray = instancedMesh.instanceMatrix.array;
        dirtyMin = -1;
        dirtyMax = -1;

        for (let i = 0; i < count; i++) {
            const body = bodies[i];
            if (!body) continue;

            // Sleeping bodies don't move — leave their last-written matrix.
            // After a few seconds of physics most cubes settle and this branch
            // skips ~all of them.
            if (!body.IsActive()) continue;

            // Single embind hop for translation + rotation. GetX/Y/Z/W are
            // cheap-ish but still cross the JS↔WASM boundary; pulling the
            // values into locals once is meaningfully faster than reading them
            // inside the matrix-construction expressions.
            const p = body.GetPosition();
            const tx = p.GetX(); const ty = p.GetY(); const tz = p.GetZ();
            const q = body.GetRotation();
            const qx = q.GetX(); const qy = q.GetY(); const qz = q.GetZ(); const qw = q.GetW();

            // Inline quat→mat4 (column-major). Same math as Three's
            // Matrix4.compose but without the Vector3+Quaternion temporaries.
            const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
            const xx = qx * x2, xy = qx * y2, xz = qx * z2;
            const yy = qy * y2, yz = qy * z2, zz = qz * z2;
            const wx = qw * x2, wy = qw * y2, wz = qw * z2;

            const o = i * 16;
            matrixArray[o + 0]  = 1 - (yy + zz);
            matrixArray[o + 1]  = xy + wz;
            matrixArray[o + 2]  = xz - wy;
            matrixArray[o + 3]  = 0;
            matrixArray[o + 4]  = xy - wz;
            matrixArray[o + 5]  = 1 - (xx + zz);
            matrixArray[o + 6]  = yz + wx;
            matrixArray[o + 7]  = 0;
            matrixArray[o + 8]  = xz + wy;
            matrixArray[o + 9]  = yz - wx;
            matrixArray[o + 10] = 1 - (xx + yy);
            matrixArray[o + 11] = 0;
            matrixArray[o + 12] = tx;
            matrixArray[o + 13] = ty;
            matrixArray[o + 14] = tz;
            matrixArray[o + 15] = 1;

            if (dirtyMin === -1) { dirtyMin = i; dirtyMax = i; }
            else if (i > dirtyMax) { dirtyMax = i; }
        }

        if (dirtyMin === -1) return; // nothing moved — skip GPU upload entirely

        // Upload only the dirty span. `setUpdateRange` units are floats, so a
        // single instance matrix = 16 floats.
        const attribute = instancedMesh.instanceMatrix;
        const offset = dirtyMin * 16;
        const length = (dirtyMax - dirtyMin + 1) * 16;
        if (attribute.addUpdateRange) {
            // Three r166+: clears the previous frame's range first.
            attribute.clearUpdateRanges?.();
            attribute.addUpdateRange(offset, length);
        } else if (attribute.updateRange) {
            attribute.updateRange.offset = offset;
            attribute.updateRange.count = length;
        }
        attribute.needsUpdate = true;
    }

    function destroyBody(slot) {
        const body = bodies[slot];
        if (!body) return;
        const id = body.GetID();
        bodyInterface.RemoveBody(id);
        bodyInterface.DestroyBody(id);
        bodies[slot] = null;
    }

    function clear() {
        for (let i = 0; i < count; i++) destroyBody(i);
        count = 0;
        instancedMesh.count = 0;
        const z = new THREE.Matrix4().makeScale(0, 0, 0);
        for (let i = 0; i < capacity; i++) instancedMesh.setMatrixAt(i, z);
        instancedMesh.instanceMatrix.needsUpdate = true;
    }

    function dispose() {
        clear();
        if (instancedMesh.parent) instancedMesh.parent.remove(instancedMesh);
        if (ownsGeometry) geo.dispose();
        if (ownsMaterial) mat.dispose();
        sharedShape.Release();
    }

    return {
        instancedMesh,
        get count() { return count; },
        get capacity() { return capacity; },
        spawn,
        spawnGrid,
        update,
        clear,
        dispose,
    };
}
