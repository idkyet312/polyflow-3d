import * as THREE from 'three';
import initJolt from 'jolt-physics/wasm-compat';

export function createPhysicsCore({
    physics,
    playerSettings,
    objectLayerCount,
    broadPhaseLayerCount,
    nonMovingLayer,
    movingLayer,
    getTerrainRoot,
    getModelRoot,
    onCharacterRefresh,
}) {
    const tempVectorA = new THREE.Vector3();
    const tempVectorB = new THREE.Vector3();
    const tempVectorC = new THREE.Vector3();
    let backFaceCulledBodyIds = null;

    function registerBackFaceCulledBody(body) {
        if (!body || !backFaceCulledBodyIds) return;
        const id = body.GetID().GetIndexAndSequenceNumber();
        backFaceCulledBodyIds.add(id);
    }

    function unregisterBackFaceCulledBody(body) {
        if (!body || !backFaceCulledBodyIds) return;
        const id = body.GetID().GetIndexAndSequenceNumber();
        backFaceCulledBodyIds.delete(id);
    }

    function createOwnedShape(settings) {
        const { Jolt } = physics;
        const shapeResult = settings.Create();

        if (!shapeResult.IsValid()) {
            const error = shapeResult.HasError() ? shapeResult.GetError() : 'Unknown Jolt shape creation error';
            Jolt.destroy(shapeResult);
            Jolt.destroy(settings);
            throw new Error(error);
        }

        const shape = shapeResult.Get();
        shape.AddRef();
        shapeResult.Clear();
        Jolt.destroy(shapeResult);
        Jolt.destroy(settings);
        return shape;
    }

    function countTrianglesForObject(root) {
        let totalTriangles = 0;

        root?.traverse((child) => {
            if (child.userData?.skipPhysicsCollision) return;
            if (!child.isMesh || !child.geometry?.attributes?.position) return;

            const index = child.geometry.getIndex();
            totalTriangles += index ? index.count / 3 : child.geometry.attributes.position.count / 3;
        });

        return totalTriangles;
    }

    function createStaticMeshBody(root, options = {}) {
        if (!physics.ready || !root) return null;

        const { Jolt, bodyInterface } = physics;
        root.updateWorldMatrix(true, true);

        const totalTriangles = countTrianglesForObject(root);
        if (!totalTriangles) return null;

        const triangles = new Jolt.TriangleList();
        triangles.resize(totalTriangles);
        let triangleIndex = 0;

        root.traverse((child) => {
            if (child.userData?.skipPhysicsCollision) return;
            if (!child.isMesh || !child.geometry?.attributes?.position) return;

            const position = child.geometry.getAttribute('position');
            const index = child.geometry.getIndex();
            const triangleCount = index ? index.count / 3 : position.count / 3;

            for (let triangleOffset = 0; triangleOffset < triangleCount; triangleOffset++) {
                const i0 = index ? index.getX(triangleOffset * 3) : triangleOffset * 3;
                const i1 = index ? index.getX(triangleOffset * 3 + 1) : triangleOffset * 3 + 1;
                const i2 = index ? index.getX(triangleOffset * 3 + 2) : triangleOffset * 3 + 2;

                tempVectorA.fromBufferAttribute(position, i0).applyMatrix4(child.matrixWorld);
                tempVectorB.fromBufferAttribute(position, i1).applyMatrix4(child.matrixWorld);
                tempVectorC.fromBufferAttribute(position, i2).applyMatrix4(child.matrixWorld);

                const triangle = triangles.at(triangleIndex++);
                const v1 = triangle.get_mV(0);
                const v2 = triangle.get_mV(1);
                const v3 = triangle.get_mV(2);
                v1.x = tempVectorA.x;
                v1.y = tempVectorA.y;
                v1.z = tempVectorA.z;
                v2.x = tempVectorB.x;
                v2.y = tempVectorB.y;
                v2.z = tempVectorB.z;
                v3.x = tempVectorC.x;
                v3.y = tempVectorC.y;
                v3.z = tempVectorC.z;
            }
        });

        const materials = new Jolt.PhysicsMaterialList();
        const meshSettings = new Jolt.MeshShapeSettings(triangles, materials);
        // Aggressive internal-edge suppression: edges between triangles whose
        // normals differ by less than ~50° are marked inactive at build time,
        // so dynamic bodies sliding across track seams don't get a contact
        // normal kicked into the seam. Default is cos(5°) ≈ 0.9962, far too
        // tight for stitched road segments that include slight bevels and
        // joints between near-coplanar triangles.
        if ('set_mActiveEdgeCosThresholdAngle' in meshSettings
            || 'mActiveEdgeCosThresholdAngle' in meshSettings) {
            meshSettings.mActiveEdgeCosThresholdAngle = Math.cos(50 * Math.PI / 180);
        }
        const shape = createOwnedShape(meshSettings);
        const bodyPosition = new Jolt.RVec3(0, 0, 0);
        const bodyRotation = new Jolt.Quat(0, 0, 0, 1);
        const creationSettings = new Jolt.BodyCreationSettings(
            shape,
            bodyPosition,
            bodyRotation,
            Jolt.EMotionType_Static,
            nonMovingLayer
        );
        creationSettings.mFriction = options.friction ?? 0.9;
        creationSettings.mRestitution = options.restitution ?? 0.08;
        const body = bodyInterface.CreateBody(creationSettings);
        bodyInterface.AddBody(body.GetID(), Jolt.EActivation_DontActivate);

        shape.Release();
        Jolt.destroy(creationSettings);
        Jolt.destroy(bodyPosition);
        Jolt.destroy(bodyRotation);
        Jolt.destroy(triangles);
        Jolt.destroy(materials);

        return body;
    }

    function destroyPhysicsBody(body) {
        if (!physics.ready || !body) return;

        const bodyId = body.GetID();
        physics.bodyInterface.RemoveBody(bodyId);
        physics.bodyInterface.DestroyBody(bodyId);
    }

    function rebuildTerrainPhysicsBody() {
        const terrainRoot = getTerrainRoot?.();
        if (!physics.ready || !terrainRoot) return;

        if (physics.terrainBody) {
            destroyPhysicsBody(physics.terrainBody);
            physics.terrainBody = null;
        }

        physics.terrainBody = createStaticMeshBody(terrainRoot);
    }

    function rebuildModelPhysicsBody() {
        if (!physics.ready) return;

        if (physics.modelBody) {
            destroyPhysicsBody(physics.modelBody);
            physics.modelBody = null;
        }

        const modelRoot = getModelRoot?.();
        if (!modelRoot) return;

        physics.modelBody = createStaticMeshBody(modelRoot);
    }

    async function initPhysics() {
        try {
            const Jolt = await initJolt();
            const objectLayerPairFilter = new Jolt.ObjectLayerPairFilterTable(objectLayerCount);
            objectLayerPairFilter.EnableCollision(nonMovingLayer, movingLayer);
            objectLayerPairFilter.EnableCollision(movingLayer, movingLayer);

            const nonMovingBroadPhaseLayer = new Jolt.BroadPhaseLayer(0);
            const movingBroadPhaseLayer = new Jolt.BroadPhaseLayer(1);
            const broadPhaseInterface = new Jolt.BroadPhaseLayerInterfaceTable(
                objectLayerCount,
                broadPhaseLayerCount
            );
            broadPhaseInterface.MapObjectToBroadPhaseLayer(nonMovingLayer, nonMovingBroadPhaseLayer);
            broadPhaseInterface.MapObjectToBroadPhaseLayer(movingLayer, movingBroadPhaseLayer);
            Jolt.destroy(nonMovingBroadPhaseLayer);
            Jolt.destroy(movingBroadPhaseLayer);

            const objectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(
                broadPhaseInterface,
                broadPhaseLayerCount,
                objectLayerPairFilter,
                objectLayerCount
            );

            const settings = new Jolt.JoltSettings();
            settings.mMaxWorkerThreads = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));
            settings.mObjectLayerPairFilter = objectLayerPairFilter;
            settings.mBroadPhaseLayerInterface = broadPhaseInterface;
            settings.mObjectVsBroadPhaseLayerFilter = objectVsBroadPhaseLayerFilter;

            const jolt = new Jolt.JoltInterface(settings);
            Jolt.destroy(settings);

            const physicsSystem = jolt.GetPhysicsSystem();
            const bodyInterface = physicsSystem.GetBodyInterface();
            const gravity = new Jolt.Vec3(0, -playerSettings.gravity, 0);
            physicsSystem.SetGravity(gravity);

            physics.Jolt = Jolt;
            physics.jolt = jolt;
            physics.physicsSystem = physicsSystem;
            physics.bodyInterface = bodyInterface;
            physics.gravity = gravity;
            physics.movingBroadPhaseFilter = new Jolt.DefaultBroadPhaseLayerFilter(
                jolt.GetObjectVsBroadPhaseLayerFilter(),
                movingLayer
            );
            physics.movingLayerFilter = new Jolt.DefaultObjectLayerFilter(
                jolt.GetObjectLayerPairFilter(),
                movingLayer
            );
            physics.bodyFilter = new Jolt.BodyFilter();
            physics.shapeFilter = new Jolt.ShapeFilter();

            // Back-face culling for the car's collisions with the static track.
            // Jolt's MeshShape is two-sided by default — a car that ends up in
            // a slight overlap between two stitched track segments can register
            // a contact against the *underside* of a road triangle and get
            // launched. The OnContactValidate hook below rejects those contacts
            // by looking at the penetration axis (Jolt convention: "direction
            // to move shape 2 to escape body 1"). The filter is scoped to a
            // registered set of body IDs so it only affects the car — other
            // dynamic props keep their natural two-sided behavior, and ceilings
            // / overhangs still register for the player and stacked objects.
            backFaceCulledBodyIds = new Set();
            const BACKFACE_Y_THRESHOLD = 0.25;
            const contactListener = new Jolt.ContactListenerJS();

            contactListener.OnContactValidate = (body1Ptr, body2Ptr, _baseOffsetPtr, collideShapeResultPtr) => {
                const body1 = Jolt.wrapPointer(body1Ptr, Jolt.Body);
                const body2 = Jolt.wrapPointer(body2Ptr, Jolt.Body);
                const id1 = body1.GetID().GetIndexAndSequenceNumber();
                const id2 = body2.GetID().GetIndexAndSequenceNumber();
                const culled1 = backFaceCulledBodyIds.has(id1);
                const culled2 = backFaceCulledBodyIds.has(id2);
                if (!culled1 && !culled2) return Jolt.ValidateResult_AcceptAllContactsForThisBodyPair;

                const body1Static = body1.IsStatic();
                const body2Static = body2.IsStatic();
                if (body1Static === body2Static) return Jolt.ValidateResult_AcceptAllContactsForThisBodyPair;

                const result = Jolt.wrapPointer(collideShapeResultPtr, Jolt.CollideShapeResult);
                const axis = result.mPenetrationAxis;
                const ax = axis.GetX();
                const ay = axis.GetY();
                const az = axis.GetZ();
                const lengthSquared = ax * ax + ay * ay + az * az;
                if (lengthSquared < 1e-10) return Jolt.ValidateResult_AcceptAllContactsForThisBodyPair;

                const normalizedY = ay / Math.sqrt(lengthSquared);

                if (culled1 && body2Static && normalizedY > BACKFACE_Y_THRESHOLD) {
                    return Jolt.ValidateResult_RejectContact;
                }

                if (culled2 && body1Static && normalizedY < -BACKFACE_Y_THRESHOLD) {
                    return Jolt.ValidateResult_RejectContact;
                }

                return Jolt.ValidateResult_AcceptAllContactsForThisBodyPair;
            };
            contactListener.OnContactAdded = () => {};
            contactListener.OnContactPersisted = () => {};
            contactListener.OnContactRemoved = () => {};
            physicsSystem.SetContactListener(contactListener);
            physics.contactListener = contactListener;

            physics.updateSettings = new Jolt.ExtendedUpdateSettings();
            physics.updateSettings.mStickToFloorStepDown = new Jolt.Vec3(0, -0.6, 0);
            physics.updateSettings.mWalkStairsStepUp = new Jolt.Vec3(0, 0.45, 0);
            physics.updateSettings.mWalkStairsMinStepForward = 0.02;
            physics.updateSettings.mWalkStairsStepForwardTest = 0.2;
            physics.updateSettings.mWalkStairsCosAngleForwardContact = Math.cos(THREE.MathUtils.degToRad(65));
            physics.updateSettings.mWalkStairsStepDownExtra = new Jolt.Vec3(0, -0.2, 0);
            physics.ready = true;

            rebuildTerrainPhysicsBody();

            if (getModelRoot?.()) {
                rebuildModelPhysicsBody();
                onCharacterRefresh?.();
            }
        } catch (error) {
            physics.failed = true;
            console.error('Failed to initialize Jolt physics.', error);
        }
    }

    /**
     * Single closest-hit ray cast against the Jolt world.
     *
     * @param {{x:number,y:number,z:number}} origin     World-space ray start.
     * @param {{x:number,y:number,z:number}} direction  Unit direction vector.
     * @param {number|object} [maxDistanceOrOptions=1000]
     * @returns {{hit:boolean, point:{x,y,z}, normal:{x,y,z}, distance:number, fraction:number, bodyId:number}|{hit:false}}
     */
    function castRay(origin, direction, maxDistanceOrOptions = 1000) {
        if (!physics.ready) return { hit: false };

        const rayOptions = typeof maxDistanceOrOptions === 'object' && maxDistanceOrOptions !== null
            ? maxDistanceOrOptions
            : { maxDistance: maxDistanceOrOptions };

        const ox = Number(origin?.x);
        const oy = Number(origin?.y);
        const oz = Number(origin?.z);
        const dx = Number(direction?.x);
        const dy = Number(direction?.y);
        const dz = Number(direction?.z);
        const distanceLimit = Number(rayOptions.maxDistance);
        const ignoreBackFaces = rayOptions.ignoreBackFaces !== false;

        if (![ox, oy, oz, dx, dy, dz, distanceLimit].every(Number.isFinite)) {
            return { hit: false };
        }

        const directionLengthSq = dx * dx + dy * dy + dz * dz;
        if (directionLengthSq <= 1e-12 || distanceLimit <= 0) {
            return { hit: false };
        }

        const { Jolt, physicsSystem } = physics;
        const ray = new Jolt.RRayCast();
        const o = new Jolt.RVec3(ox, oy, oz);
        const d = new Jolt.Vec3(dx * distanceLimit, dy * distanceLimit, dz * distanceLimit);
        ray.mOrigin = o;
        ray.mDirection = d;

        const settings = new Jolt.RayCastSettings();
        if (typeof Jolt.EBackFaceMode_IgnoreBackFaces !== 'undefined' && ignoreBackFaces) {
            settings.mBackFaceModeTriangles = Jolt.EBackFaceMode_IgnoreBackFaces;
        }
        const collector = new Jolt.CastRayClosestHitCollisionCollector();

        try {
            physicsSystem.GetNarrowPhaseQuery().CastRay(
                ray,
                settings,
                collector,
                physics.movingBroadPhaseFilter,
                physics.movingLayerFilter,
                physics.bodyFilter,
                physics.shapeFilter,
            );
        } catch (err) {
            // Fallback: try the simpler 3-arg form.
            try {
                physicsSystem.GetNarrowPhaseQuery().CastRay(ray, settings, collector);
            } catch (_) {
                Jolt.destroy(o); Jolt.destroy(d); Jolt.destroy(settings); Jolt.destroy(collector);
                return { hit: false };
            }
        }

        if (!collector.HadHit?.()) {
            Jolt.destroy(o); Jolt.destroy(d); Jolt.destroy(settings); Jolt.destroy(collector);
            return { hit: false };
        }

        const hit = typeof collector.get_mHit === 'function' ? collector.get_mHit() : collector.mHit;
        const fraction = typeof hit?.get_mFraction === 'function' ? hit.get_mFraction() : hit?.mFraction;
        if (!Number.isFinite(fraction)) {
            Jolt.destroy(o); Jolt.destroy(d); Jolt.destroy(settings); Jolt.destroy(collector);
            return { hit: false };
        }

        const distance = fraction * distanceLimit;
        const point = {
            x: ox + dx * distance,
            y: oy + dy * distance,
            z: oz + dz * distance,
        };

        // Surface-normal extraction. RayCastResult itself carries no normal —
        // it must be resolved from the hit body's shape. The previous code
        // used Jolt.BodyLockRead and BodyInterface.TryGetBody, neither of
        // which exist in this jolt-physics/wasm-compat binding, so it always
        // threw and every wall reported the (0,1,0) fallback. The correct
        // APIs here: BodyInterface.GetTransformedShape(bodyID) and, as a
        // backup, GetBodyLockInterfaceNoLock().TryGetBody(bodyID). hasNormal
        // tells the caller whether `normal` is real so it can derive one
        // geometrically when this genuinely can't resolve.
        let normal = { x: 0, y: 1, z: 0 };
        let hasNormal = false;
        let bodyId = -1;
        try {
            const id = typeof hit?.get_mBodyID === 'function' ? hit.get_mBodyID() : hit?.mBodyID;
            bodyId = id?.GetIndexAndSequenceNumber?.() ?? -1;

            const subShapeId = typeof hit?.get_mSubShapeID2 === 'function'
                ? hit.get_mSubShapeID2()
                : hit?.mSubShapeID2;

            if (id && bodyId >= 0 && subShapeId) {
                const jPoint = new Jolt.RVec3(point.x, point.y, point.z);
                try {
                    // Primary: TransformedShape from the BodyID (no lock).
                    try {
                        const ts = physics.bodyInterface?.GetTransformedShape?.(id);
                        if (ts) {
                            const n = ts.GetWorldSpaceSurfaceNormal(subShapeId, jPoint);
                            if (n) {
                                normal = { x: n.GetX(), y: n.GetY(), z: n.GetZ() };
                                hasNormal = true;
                            }
                        }
                    } catch (_) { /* fall through to the body-lock path */ }

                    // Backup: the no-lock body-lock interface actually carries
                    // TryGetBody (BodyInterface does not), then query the body.
                    if (!hasNormal) {
                        try {
                            const blic = physicsSystem.GetBodyLockInterfaceNoLock?.();
                            const body = blic ? blic.TryGetBody(id) : null;
                            if (body) {
                                const n = body.GetWorldSpaceSurfaceNormal(subShapeId, jPoint);
                                if (n) {
                                    normal = { x: n.GetX(), y: n.GetY(), z: n.GetZ() };
                                    hasNormal = true;
                                }
                            }
                        } catch (_) { /* hasNormal stays false */ }
                    }
                } finally {
                    Jolt.destroy(jPoint);
                }
            }
        } catch (_) { /* hasNormal stays false; caller derives one */ }

        // Reject degenerate / non-finite normals so a bad read can't masquerade
        // as a valid surface normal.
        if (hasNormal) {
            const ln = normal.x * normal.x + normal.y * normal.y + normal.z * normal.z;
            if (!Number.isFinite(ln) || ln < 1e-6) hasNormal = false;
            else {
                const inv = 1 / Math.sqrt(ln);
                normal = { x: normal.x * inv, y: normal.y * inv, z: normal.z * inv };
            }
        }

        Jolt.destroy(o);
        Jolt.destroy(d);
        Jolt.destroy(settings);
        Jolt.destroy(collector);

        return { hit: true, point, normal, hasNormal, distance, fraction, bodyId };
    }

    return {
        initPhysics,
        createOwnedShape,
        countTrianglesForObject,
        createStaticMeshBody,
        destroyPhysicsBody,
        rebuildTerrainPhysicsBody,
        rebuildModelPhysicsBody,
        castRay,
        registerBackFaceCulledBody,
        unregisterBackFaceCulledBody,
    };
}
