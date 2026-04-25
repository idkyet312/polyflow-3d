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
            if (!child.isMesh || !child.geometry?.attributes?.position) return;

            const index = child.geometry.getIndex();
            totalTriangles += index ? index.count / 3 : child.geometry.attributes.position.count / 3;
        });

        return totalTriangles;
    }

    function createStaticMeshBody(root) {
        if (!physics.ready || !root) return null;

        const { Jolt, bodyInterface } = physics;
        root.updateWorldMatrix(true, true);

        const totalTriangles = countTrianglesForObject(root);
        if (!totalTriangles) return null;

        const triangles = new Jolt.TriangleList();
        triangles.resize(totalTriangles);
        let triangleIndex = 0;

        root.traverse((child) => {
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
        const shape = createOwnedShape(new Jolt.MeshShapeSettings(triangles, materials));
        const bodyPosition = new Jolt.RVec3(0, 0, 0);
        const bodyRotation = new Jolt.Quat(0, 0, 0, 1);
        const creationSettings = new Jolt.BodyCreationSettings(
            shape,
            bodyPosition,
            bodyRotation,
            Jolt.EMotionType_Static,
            nonMovingLayer
        );
        creationSettings.mFriction = 0.9;
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

    return {
        initPhysics,
        createOwnedShape,
        countTrianglesForObject,
        createStaticMeshBody,
        destroyPhysicsBody,
        rebuildTerrainPhysicsBody,
        rebuildModelPhysicsBody,
    };
}
