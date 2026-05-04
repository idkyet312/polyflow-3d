// src/physics/actorPhysics.js
// Extracted from main.js (chore/main-js-shrink-2). Owns rebuildActorPhysics,
// the per-actor physics inputs (mass / friction / restitution preview) and the
// gizmo↔body sync helpers (syncTransformControlState, syncTransformToPhysics,
// applyBlueprintPhysicsEditor). All Jolt construction helpers + the actor
// metadata helpers stay in main.js and come through as deps.

import * as THREE from 'three';

let gameplay, blueprintState, objectScriptState, importedPropState, physics;
let collisionDebugState, transformControl, actorPhysicsEditorState;
let getDynamicPropById, getActorSelectionObject, getActorRenderObject;
let getActorBody, getActorComponentFlags, setActorComponentFlags;
let findDynamicPropByMesh;
let buildActorCollisionOverlay, disposeCollisionOverlayObject, refreshCollisionDebugOverlays;
let createDynamicPrimitiveBody, createStaticMeshBody, createOwnedShape;
let getPhysicsBodyComponent;
let refreshSceneUI, refreshBlueprintComponents;

export function installActorPhysics(deps) {
    ({
        gameplay, blueprintState, objectScriptState, importedPropState, physics,
        collisionDebugState, transformControl, actorPhysicsEditorState,
        getDynamicPropById, getActorSelectionObject, getActorRenderObject,
        getActorBody, getActorComponentFlags, setActorComponentFlags,
        findDynamicPropByMesh,
        buildActorCollisionOverlay, disposeCollisionOverlayObject, refreshCollisionDebugOverlays,
        createDynamicPrimitiveBody, createStaticMeshBody, createOwnedShape,
        getPhysicsBodyComponent,
        refreshSceneUI, refreshBlueprintComponents,
    } = deps);
}

export function syncTransformControlState() {
    if (!transformControl) return;

    const helper = transformControl.getHelper?.() ?? null;
    const shouldEnable = !gameplay.active && !gameplay.pointerLocked;

    transformControl.enabled = shouldEnable;
    if (helper) {
        helper.visible = shouldEnable && !!transformControl.object;
    }

    if (!shouldEnable) {
        transformControl.detach();
        return;
    }

    if (transformControl.object || blueprintState.active) {
        if (helper) helper.visible = !!transformControl.object;
        return;
    }

    const selectedActor = getDynamicPropById(objectScriptState.targetPropId);
    const selectedMesh = getActorSelectionObject(selectedActor);
    if (selectedMesh) {
        transformControl.attach(selectedMesh);
        if (helper) helper.visible = true;
    }
}

export function syncTransformToPhysics() {
    if (!transformControl || !transformControl.object) return;
    
    // In blueprint mode, child components can be moved freely without physics sync
    if (blueprintState.active) return;
    
    const prop = findDynamicPropByMesh(transformControl.object);
    if (!prop) return;

    const body = getActorBody(prop);
    if (!body || !physics.jolt) return;

    const mesh = transformControl.object;
    const rootMesh = getActorRenderObject(prop);
    if (mesh !== rootMesh) {
        rebuildActorPhysics(prop);
        return;
    }

    const pos = mesh.position;
    const rot = mesh.quaternion;

    const { bodyInterface, Jolt } = physics;
    
    // Position and Rotation sync
    const joltPos = new Jolt.Vec3(pos.x, pos.y, pos.z);
    const joltRot = new Jolt.Quat(rot.x, rot.y, rot.z, rot.w);
    bodyInterface.SetPositionAndRotation(body.GetID(), joltPos, joltRot, Jolt.EActivation_Activate);
    Jolt.destroy(joltPos);
    Jolt.destroy(joltRot);
    
    // Scale sync (requires rebuilding the body for primitives)
    if (transformControl.getMode() === 'scale') {
        rebuildActorPhysics(prop);
    }
}

export function rebuildActorPhysics(prop) {
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
    if (physicsBodyComponent) {
        physicsBodyComponent.body = null;
    }
    if (dynamicIndex >= 0) physics.dynamicBodies.splice(dynamicIndex, 1);
    if (staticIndex >= 0) physics.staticBodies.splice(staticIndex, 1);

    if (!componentFlags.collision) {
        return;
    }
    
    const importedTemplate = prop.kind === 'imported'
        ? importedPropState.templates.find((entry) => entry.id === prop.templateId)
        : null;
    const useExactMeshCollision = importedTemplate?.collisionMode === 'complex';

    let bodyOptions = {
        rotation: getActorRenderObject(prop).quaternion,
        mass: prop.userData?.physicsMass,
        friction: prop.userData?.physicsFriction ?? prop.userData?.friction ?? 0.5,
        restitution: prop.userData?.physicsRestitution ?? prop.userData?.restitution ?? 0.3,
        allowedDOFs: prop.userData?.allowedDOFs,
        kinematic: prop.userData?.kinematic,
        simulatePhysics: useExactMeshCollision ? false : componentFlags.physics,
        activate: true
    };
    
    const rootMesh = getActorRenderObject(prop);
    rootMesh.updateMatrixWorld(true);

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

    // A helper to traverse and collect collision shapes
    function traverseAndBuildShapes(node, isRoot) {
        const isCollisionShape = !!node.userData?.isCollisionShape;
        if (!node.visible && !isCollisionShape) return; // Skip hidden visual components
        if (hasExplicitCollisionShapes && !isCollisionShape) {
            for (const child of node.children) {
                traverseAndBuildShapes(child, false);
            }
            return;
        }
        
        // Handle only meshes
        if (node.isMesh) {
            let shapeSetting = null;
            const geo = node.geometry;
            const scale = node.scale;
            
            // For primitive meshes created via UI
            if (geo?.type === 'SphereGeometry') {
                shapeSetting = new Jolt.SphereShapeSettings(scale.x);
            } else if (geo?.type === 'BoxGeometry') {
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
            } else if (isRoot && prop.kind === 'capsule') {
                shapeSetting = new Jolt.CapsuleShapeSettings(scale.y, scale.x);
            } else if (!isRoot) {
                // Treat imported nested child geometries as boxes for simplicity if type is unknown
                const bbox = new THREE.Box3().setFromObject(node, true);
                if (!bbox.isEmpty()) {
                    const size = new THREE.Vector3();
                    bbox.getSize(size);
                    const halfExtents = new Jolt.Vec3(Math.max(size.x/2, 0.05), Math.max(size.y/2, 0.05), Math.max(size.z/2, 0.05));
                    shapeSetting = new Jolt.BoxShapeSettings(halfExtents, 0.05);
                    Jolt.destroy(halfExtents);
                }
            }
            
            if (shapeSetting) {
                const subShape = createOwnedShape(shapeSetting);
                subShapes.push(subShape);
                
                // Calculate relative position/rotation to the root
                const pos = new Jolt.Vec3(node.position.x, node.position.y, node.position.z);
                const rot = new Jolt.Quat(node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w);
                
                compoundSettings.AddShapeShape(pos, rot, subShape, 0);
                Jolt.destroy(pos);
                Jolt.destroy(rot);
                hasCompound = true;
            }
        }
        
        for (const child of node.children) {
            traverseAndBuildShapes(child, false);
        }
    }
    
    traverseAndBuildShapes(rootMesh, true);
    
    let finalShape = null;
    
    if (hasCompound) {
        if (subShapes.length === 1 && rootMesh.children.length === 0) {
            // Optimization: if it's just the root shape and no children, use it directly
            finalShape = subShapes[0];
            Jolt.destroy(compoundSettings); // We don't need the compound wrapper
        } else {
            // We have multiple components or child transforms
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
            } else {
                physics.staticBodies.push(prop);
            }
        }
    }
    if (actorPhysicsEditorState.previewActorId === prop.id) refreshActorPhysicsPreview();
}

export function buildCollisionBoxComponent() {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshBasicMaterial({
            color: 0x22d3ee,
            transparent: true,
            opacity: 0.16,
            wireframe: true,
            depthTest: false,
        })
    );
    mesh.name = 'Collision Box';
    mesh.renderOrder = 20;
    mesh.userData.isCollisionShape = true;
    mesh.userData.collisionShapeType = 'box';
    mesh.userData.skipMaterialExport = true;
    return mesh;
}

export function getActorPhysicsSettings(actor) {
    const userData = actor?.userData ?? {};
    return {
        mass: Number.isFinite(userData.physicsMass) ? userData.physicsMass : 12,
        friction: Number.isFinite(userData.physicsFriction) ? userData.physicsFriction : (Number.isFinite(userData.friction) ? userData.friction : 0.5),
        restitution: Number.isFinite(userData.physicsRestitution) ? userData.physicsRestitution : (Number.isFinite(userData.restitution) ? userData.restitution : 0.3),
    };
}

export function clearActorPhysicsPreview() {
    const overlay = actorPhysicsEditorState.previewOverlay;
    if (overlay) {
        overlay.parent?.remove(overlay);
        disposeCollisionOverlayObject(overlay);
    }
    actorPhysicsEditorState.previewOverlay = null;
    actorPhysicsEditorState.previewActorId = '';
}

export function refreshActorPhysicsPreview() {
    const actorId = actorPhysicsEditorState.previewActorId;
    if (!actorId) return;

    const actor = getDynamicPropById(actorId);
    const actorMesh = getActorRenderObject(actor);
    const nextOverlay = actor ? buildActorCollisionOverlay(actor) : null;

    if (actorPhysicsEditorState.previewOverlay) {
        actorPhysicsEditorState.previewOverlay.parent?.remove(actorPhysicsEditorState.previewOverlay);
        disposeCollisionOverlayObject(actorPhysicsEditorState.previewOverlay);
        actorPhysicsEditorState.previewOverlay = null;
    }

    if (!actorMesh || !nextOverlay) {
        actorPhysicsEditorState.previewActorId = '';
        return;
    }

    nextOverlay.name = 'actor-physics-preview-overlay';
    actorMesh.add(nextOverlay);
    actorPhysicsEditorState.previewOverlay = nextOverlay;
}

export function setActorPhysicsPreview(actor, enabled) {
    clearActorPhysicsPreview();
    if (!enabled || !actor?.id) return;
    actorPhysicsEditorState.previewActorId = actor.id;
    refreshActorPhysicsPreview();
}

export function applyActorPhysicsSettings(actor, settings) {
    if (!actor) return;

    const next = {
        physicsMass: THREE.MathUtils.clamp(Number(settings.mass) || 12, 0.01, 100000),
        physicsFriction: THREE.MathUtils.clamp(Number(settings.friction) || 0, 0, 2),
        physicsRestitution: THREE.MathUtils.clamp(Number(settings.restitution) || 0, 0, 1),
    };
    Object.assign(actor.userData, next);
    const mesh = getActorRenderObject(actor);
    if (mesh?.userData) Object.assign(mesh.userData, next);

    if (getActorComponentFlags(actor).collision) {
        rebuildActorPhysics(actor);
    }
    refreshActorPhysicsPreview();
    if (collisionDebugState.enabled) refreshCollisionDebugOverlays();
    refreshSceneUI();
}

export function syncBlueprintPhysicsEditor(actor = getDynamicPropById(objectScriptState.targetPropId)) {
    const settings = getActorPhysicsSettings(actor);
    const mass = document.getElementById('bp-physics-mass');
    const friction = document.getElementById('bp-physics-friction');
    const restitution = document.getElementById('bp-physics-restitution');
    if (mass) mass.value = String(settings.mass);
    if (friction) friction.value = String(settings.friction);
    if (restitution) restitution.value = String(settings.restitution);
}

export function applyBlueprintPhysicsEditor() {
    const actor = getDynamicPropById(objectScriptState.targetPropId);
    if (!actor) return;
    applyActorPhysicsSettings(actor, {
        mass: parseFloat(document.getElementById('bp-physics-mass')?.value ?? '12'),
        friction: parseFloat(document.getElementById('bp-physics-friction')?.value ?? '0.5'),
        restitution: parseFloat(document.getElementById('bp-physics-restitution')?.value ?? '0.3'),
    });
    refreshBlueprintComponents();
}
