// Rebuild an actor's Jolt body from its current render hierarchy + component
// flags. Lifted out of runtime.js because the body-construction logic is
// 200 lines of mostly self-contained Jolt-shape decisions.
//
// Recreates: dynamic/static lookup tables, the body itself, the compound
// shape from child meshes (or explicit `isCollisionShape` markers), and the
// physicsBody component on the actor entity.

export function createRebuildActorPhysics(deps) {
    const {
        THREE,
        physics, dynamicBodySpatial,
        actorPhysicsEditorState,
        getActorComponentFlags, setActorComponentFlags,
        getActorRenderObject, getActorBody, getPhysicsBodyComponent,
        getImportedTemplate,
        createStaticMeshBody, createDynamicPrimitiveBody,
        createOwnedShape,
        refreshActorPhysicsPreview,
    } = deps;

    return function rebuildActorPhysics(prop) {
        if (!prop || !getActorRenderObject(prop) || !physics.ready) return;

        const { Jolt, bodyInterface } = physics;
        const componentFlags = getActorComponentFlags(prop);
        const currentBody = getActorBody(prop);
        const bodyID = currentBody?.GetID();
        const dynamicIndex = physics.dynamicBodies.indexOf(prop);
        const staticIndex = physics.staticBodies.indexOf(prop);

        if (bodyID) {
            bodyInterface.RemoveBody(bodyID);
            bodyInterface.DestroyBody(bodyID);
        }
        prop.body = null;
        const physicsBodyComponent = getPhysicsBodyComponent(prop);
        if (physicsBodyComponent) physicsBodyComponent.body = null;
        if (dynamicIndex >= 0) {
            physics.dynamicBodies.splice(dynamicIndex, 1);
            dynamicBodySpatial.remove(prop);
        }
        if (staticIndex >= 0) physics.staticBodies.splice(staticIndex, 1);

        if (!componentFlags.collision) return;

        const importedTemplate = prop.kind === 'imported'
            ? getImportedTemplate(prop.templateId)
            : null;
        const useExactMeshCollision = importedTemplate?.collisionMode === 'complex';

        const bodyOptions = {
            rotation: getActorRenderObject(prop).quaternion,
            mass: prop.userData?.physicsMass,
            friction: prop.userData?.physicsFriction ?? prop.userData?.friction ?? 0.5,
            restitution: prop.userData?.physicsRestitution ?? prop.userData?.restitution ?? 0.3,
            allowedDOFs: prop.userData?.allowedDOFs,
            kinematic: prop.userData?.kinematic,
            simulatePhysics: useExactMeshCollision ? false : componentFlags.physics,
            activate: true,
        };

        const rootMesh = getActorRenderObject(prop);
        rootMesh.updateMatrixWorld(true);

        if (prop.userData?.staticMeshActorCollision) {
            const previousSkipPhysicsCollision = !!rootMesh.userData?.skipPhysicsCollision;
            let newBody = null;
            try {
                rootMesh.userData.skipPhysicsCollision = false;
                newBody = createStaticMeshBody(rootMesh, bodyOptions);
            } finally {
                rootMesh.userData.skipPhysicsCollision = previousSkipPhysicsCollision;
            }
            prop.body = newBody;
            if (physicsBodyComponent) physicsBodyComponent.body = newBody;
            setActorComponentFlags(prop, {
                ...componentFlags,
                collision: !!newBody,
                physics: false,
            });
            if (newBody) physics.staticBodies.push(prop);
            if (actorPhysicsEditorState.previewActorId === prop.id) refreshActorPhysicsPreview();
            return;
        }

        if (useExactMeshCollision) {
            const newBody = createStaticMeshBody(rootMesh, bodyOptions);
            prop.body = newBody;
            if (physicsBodyComponent) physicsBodyComponent.body = newBody;
            setActorComponentFlags(prop, {
                ...componentFlags,
                collision: !!newBody,
                physics: false,
            });
            if (newBody) physics.staticBodies.push(prop);
            if (actorPhysicsEditorState.previewActorId === prop.id) refreshActorPhysicsPreview();
            return;
        }

        const subShapes = [];
        const compoundSettings = new Jolt.MutableCompoundShapeSettings();
        let hasCompound = false;
        let hasExplicitCollisionShapes = false;
        rootMesh.traverse((node) => {
            if (node.userData?.isCollisionShape) hasExplicitCollisionShapes = true;
        });

        function traverseAndBuildShapes(node, isRoot) {
            const isCollisionShape = !!node.userData?.isCollisionShape;
            if (!node.visible && !isCollisionShape) return; // Skip hidden visual components
            if (hasExplicitCollisionShapes && !isCollisionShape) {
                for (const child of node.children) traverseAndBuildShapes(child, false);
                return;
            }

            if (node.isMesh) {
                let shapeSetting = null;
                const geo = node.geometry;
                const scale = node.scale;

                if (geo?.type === 'SphereGeometry') {
                    shapeSetting = new Jolt.SphereShapeSettings(scale.x);
                } else if (geo?.type === 'BoxGeometry') {
                    const halfExtents = new Jolt.Vec3(scale.x, scale.y, scale.z);
                    shapeSetting = new Jolt.BoxShapeSettings(halfExtents, 0.05);
                    Jolt.destroy(halfExtents);
                } else if (geo?.type === 'CylinderGeometry') {
                    const halfExtents = new Jolt.Vec3(scale.x, scale.y, scale.z);
                    shapeSetting = new Jolt.BoxShapeSettings(halfExtents, 0.05);
                    Jolt.destroy(halfExtents);
                } else if (geo?.type === 'CapsuleGeometry') {
                    shapeSetting = new Jolt.CapsuleShapeSettings(scale.y, scale.x);
                } else if (isRoot && prop.kind === 'sphere') {
                    shapeSetting = new Jolt.SphereShapeSettings(scale.x);
                } else if (isRoot && prop.kind === 'cube') {
                    const halfExtents = new Jolt.Vec3(scale.x, scale.y, scale.z);
                    shapeSetting = new Jolt.BoxShapeSettings(halfExtents, 0.05);
                    Jolt.destroy(halfExtents);
                } else if (isRoot && prop.kind === 'cylinder') {
                    const halfExtents = new Jolt.Vec3(scale.x, scale.y, scale.z);
                    shapeSetting = new Jolt.BoxShapeSettings(halfExtents, 0.05);
                    Jolt.destroy(halfExtents);
                } else if (isRoot && prop.kind === 'capsule') {
                    shapeSetting = new Jolt.CapsuleShapeSettings(scale.y, scale.x);
                } else if (!isRoot) {
                    // Treat imported nested child geometries as boxes for simplicity if type is unknown
                    const bbox = new THREE.Box3().setFromObject(node, true);
                    if (!bbox.isEmpty()) {
                        const size = new THREE.Vector3();
                        bbox.getSize(size);
                        const halfExtents = new Jolt.Vec3(
                            Math.max(size.x / 2, 0.05),
                            Math.max(size.y / 2, 0.05),
                            Math.max(size.z / 2, 0.05),
                        );
                        shapeSetting = new Jolt.BoxShapeSettings(halfExtents, 0.05);
                        Jolt.destroy(halfExtents);
                    }
                }

                if (shapeSetting) {
                    const subShape = createOwnedShape(shapeSetting);
                    subShapes.push(subShape);
                    const pos = isRoot
                        ? new Jolt.Vec3(0, 0, 0)
                        : new Jolt.Vec3(node.position.x, node.position.y, node.position.z);
                    const rot = isRoot
                        ? new Jolt.Quat(0, 0, 0, 1)
                        : new Jolt.Quat(node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w);
                    compoundSettings.AddShapeShape(pos, rot, subShape, 0);
                    Jolt.destroy(pos);
                    Jolt.destroy(rot);
                    hasCompound = true;
                }
            }

            for (const child of node.children) traverseAndBuildShapes(child, false);
        }

        traverseAndBuildShapes(rootMesh, true);

        let finalShape = null;

        if (hasCompound) {
            if (subShapes.length === 1 && rootMesh.children.length === 0) {
                // Optimization: just the root shape, no children — use directly.
                finalShape = subShapes[0];
                Jolt.destroy(compoundSettings);
            } else {
                finalShape = createOwnedShape(compoundSettings);
            }
        } else {
            Jolt.destroy(compoundSettings);
        }

        if (finalShape) {
            const newBody = createDynamicPrimitiveBody(finalShape, rootMesh.position, null, bodyOptions);
            prop.body = newBody;
            if (physicsBodyComponent) physicsBodyComponent.body = newBody;
            setActorComponentFlags(prop, {
                ...componentFlags,
                collision: !!newBody,
                physics: !!newBody && componentFlags.physics,
            });
            if (newBody) {
                if (componentFlags.physics) {
                    physics.dynamicBodies.push(prop);
                    dynamicBodySpatial.updateEntry(prop);
                } else {
                    physics.staticBodies.push(prop);
                }
            }
        }
        if (actorPhysicsEditorState.previewActorId === prop.id) refreshActorPhysicsPreview();
    };
}
