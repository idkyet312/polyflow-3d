import * as THREE from 'three';
import { core } from '../runtime/appCore.js';

// Actor spawn + gameplay-prefab tagging primitives, extracted from
// runtime.js. Reads live engine state (scene/camera/sceneSystem/physicsCore)
// through the appCore keystone; all other engine deps are injected via the
// factory (consistent with createRogueWaves/createLevels — injecting the
// runtime's already-bound refs avoids re-import divergence).
export function createActorSpawn(deps) {
    const {
        JOLT_MOVING_LAYER, JOLT_NON_MOVING_LAYER, PLAYER_SETTINGS,
        VEHICLE_SETTINGS, dynamicBodySpatial, gameplay, importedPropState,
        objectScriptState, physics, tempQuaternionA, tempVectorA, tempVectorD,
        tempVectorE, upVector,
        buildPrimitiveActorMesh, createOwnedShape,
        createVehicleCollisionShapeFromBounds, ensureActorIdentity,
        getActorRenderObject, getDynamicPropSpawn, getGroundHeightAt,
        getGroundHitAt, getVehicleVisualBounds, invalidateDDGI,
        markDDGISkipCapture, updateGameplayUI,
        // injected (originally destructured imports in runtime.js):
        cloneDisposableObject, createDynamicPropActor, ensureScriptHandles,
        getDynamicPropById, setActorColor, setActorComponentFlags,
        syncPropScriptState,
    } = deps;

    function spawnDrivableCar(options = {}) {
        if (!physics.ready || !core.scene || !core.camera) {
            console.warn('Jolt physics is not ready yet.');
            return null;
        }

        const { Jolt, bodyInterface } = physics;
        const spawnPosition = tempVectorD;
        const launchImpulse = tempVectorE;
        getDynamicPropSpawn(spawnPosition, launchImpulse);

        const bodyTemplateId = options.bodyTemplateId || '';
        const wheelTemplateId = options.wheelTemplateId || '';
        const chassis = createDrivableCarVisual({
            bodyTemplateId,
            wheelTemplateId,
            vehicleSettings: VEHICLE_SETTINGS,
            importedPropState,
            cloneDisposableObject,
        });
        // Imported vehicle bodies can be hundreds of thousands of triangles.
        // Keep them rendered/interactive, but out of DDGI capture rebuilds.
        markDDGISkipCapture(chassis);
        const vehicleBounds = getVehicleVisualBounds(chassis);

        const groundHit = getGroundHitAt(spawnPosition.x, spawnPosition.z, true, { cullBackFaces: true });
        if (groundHit?.point) {
            spawnPosition.y = groundHit.point.y + VEHICLE_SETTINGS.spawnLift - vehicleBounds.min.y;
        }

        core.camera.getWorldDirection(tempVectorA);
        tempVectorA.y = 0;
        if (tempVectorA.lengthSq() < 1e-6) {
            tempVectorA.set(0, 0, -1);
        } else {
            tempVectorA.normalize();
        }

        const carRotation = tempQuaternionA.setFromUnitVectors(upVector.clone().set(0, 0, -1), tempVectorA);
        const shape = createVehicleCollisionShapeFromBounds(vehicleBounds);

        const body = createDynamicPrimitiveBody(shape, spawnPosition, launchImpulse, {
            rotation: carRotation,
            friction: 0.8,
            restitution: 0.05,
            linearDamping: 0.12,
            angularDamping: 0.3,
            motionQuality: Jolt.EMotionQuality_LinearCast,
            skipImpulse: true,
            enhancedInternalEdgeRemoval: true,
        });

        if (!body) {
            return null;
        }

        bodyInterface.SetMaxAngularVelocity(body.GetID(), VEHICLE_SETTINGS.maxAngularVelocity);
        chassis.position.copy(spawnPosition);
        chassis.quaternion.copy(carRotation);

        const vehicle = createDynamicPropActor({
            body,
            mesh: chassis,
            kind: 'vehicle',
            userData: options.userData ?? { label: 'Car' },
            includeScripts: options.includeScripts !== false,
        });
        vehicle.vehicleBodyTemplateId = bodyTemplateId || null;
        vehicle.vehicleWheelTemplateId = wheelTemplateId || null;
        setActorComponentFlags(vehicle, {
            collision: true,
            physics: true,
            scripts: options.includeScripts !== false,
        });
        physics.dynamicBodies.push(vehicle);
        dynamicBodySpatial.updateEntry(vehicle);
        core.physicsCore?.registerBackFaceCulledBody?.(body);
        updateGameplayUI();
        return vehicle;
    }

    function createDynamicPrimitiveBody(shape, position, impulse, options = {}) {
        if (!physics.ready) return null;

        const { Jolt, bodyInterface } = physics;
        const simulatePhysics = options.simulatePhysics !== false;
        const kinematic = options.kinematic === true;
        const bodyPosition = new Jolt.RVec3(position.x, position.y, position.z);
        const rotation = options.rotation;
        const bodyRotation = new Jolt.Quat(
            rotation?.x ?? 0,
            rotation?.y ?? 0,
            rotation?.z ?? 0,
            rotation?.w ?? 1
        );
        const creationSettings = new Jolt.BodyCreationSettings(
            shape,
            bodyPosition,
            bodyRotation,
            kinematic ? Jolt.EMotionType_Kinematic : simulatePhysics ? Jolt.EMotionType_Dynamic : Jolt.EMotionType_Static,
            (simulatePhysics || kinematic) ? JOLT_MOVING_LAYER : JOLT_NON_MOVING_LAYER
        );
        creationSettings.mFriction = options.friction ?? 0.68;
        creationSettings.mRestitution = options.restitution ?? 0.16;
        creationSettings.mAllowSleeping = options.allowSleeping ?? true;
        creationSettings.mLinearDamping = options.linearDamping ?? 0.08;
        creationSettings.mAngularDamping = options.angularDamping ?? 0.1;
        creationSettings.mMotionQuality = options.motionQuality
            ?? Jolt.EMotionQuality_Discrete;

        if (options.allowedDOFs !== undefined) {
            creationSettings.mAllowedDOFs = options.allowedDOFs;
        }

        // Enhanced internal edge removal eliminates ghost collisions where a body
        // crosses a seam between coplanar triangles in a static MeshShape and the
        // contact normal flips into the edge — the symptom is a vehicle hitting an
        // invisible wall and flipping at track segment joints.
        if (options.enhancedInternalEdgeRemoval === true) {
            creationSettings.mEnhancedInternalEdgeRemoval = true;
        }

        const body = bodyInterface.CreateBody(creationSettings);
        const mass = Number(options.mass);
        if (simulatePhysics && Number.isFinite(mass) && mass > 0) {
            body.GetMotionProperties?.()?.ScaleToMass?.(mass);
        }
        bodyInterface.AddBody(
            body.GetID(),
            (!simulatePhysics && !kinematic) || options.activate === false ? Jolt.EActivation_DontActivate : Jolt.EActivation_Activate
        );

        if (simulatePhysics && impulse && options.skipImpulse !== true) {
            const launchImpulse = new Jolt.Vec3(impulse.x, impulse.y, impulse.z);
            bodyInterface.AddImpulse(body.GetID(), launchImpulse);
            Jolt.destroy(launchImpulse);
        }

        shape.Release();
        Jolt.destroy(creationSettings);
        Jolt.destroy(bodyPosition);
        Jolt.destroy(bodyRotation);

        return body;
    }

    function spawnDynamicPrimitive(kind, offset, scale, options = {}) {
        if (!physics.ready || !core.scene || !core.camera) {
            console.warn('Jolt physics is not ready yet.');
            return;
        }

        const defaultScale = kind === 'sphere' ? 0.5 : 0.3;
        const normalizedScale = Number.isFinite(scale) && scale > 0 ? scale : defaultScale;

        const { Jolt } = physics;
        const spawnPosition = tempVectorD;
        const launchImpulse = tempVectorE;
        getDynamicPropSpawn(spawnPosition, launchImpulse);
        const impulseScale = Number.isFinite(options.impulseScale) ? options.impulseScale : 1;
        const includeCollisionBody = options.includeCollisionBody !== false;
        const simulatePhysics = includeCollisionBody && options.simulatePhysics !== false;
        const useLocalPosition = options.local !== false;

        if (offset) {
            if (useLocalPosition) {
                spawnPosition.add(tempVectorA.copy(offset).applyQuaternion(core.camera.quaternion));
            } else {
                spawnPosition.copy(offset);
            }
        }

        if (options.skipImpulse === true) {
            launchImpulse.set(0, 0, 0);
        } else if (impulseScale !== 1) {
            launchImpulse.multiplyScalar(impulseScale);
        }

        let mesh;
        let shape;
        let bodyOptions;

        if (kind === 'sphere') {
            const radius = normalizedScale;
            shape = includeCollisionBody ? createOwnedShape(new Jolt.SphereShapeSettings(radius)) : null;
            mesh = buildPrimitiveActorMesh('sphere');
            mesh.scale.set(radius, radius, radius);
            bodyOptions = {
                restitution: 0.48,
                friction: 0.58,
                ...options,
            };
        } else if (kind === 'cube') {
            const halfExtent = normalizedScale;
            if (includeCollisionBody) {
                const halfExtentVector = new Jolt.Vec3(halfExtent, halfExtent, halfExtent);
                shape = createOwnedShape(new Jolt.BoxShapeSettings(halfExtentVector, 0.05));
                Jolt.destroy(halfExtentVector);
            }
            mesh = buildPrimitiveActorMesh('cube');
            mesh.scale.set(halfExtent, halfExtent, halfExtent);
            bodyOptions = {
                restitution: 0.12,
                friction: 0.82,
                ...options,
            };
        } else if (kind === 'cylinder') {
            const radius = normalizedScale;
            const halfHeight = normalizedScale;
            if (includeCollisionBody) {
                const halfExtentVector = new Jolt.Vec3(radius, halfHeight, radius);
                shape = createOwnedShape(new Jolt.BoxShapeSettings(halfExtentVector, 0.05));
                Jolt.destroy(halfExtentVector);
            }
            mesh = buildPrimitiveActorMesh('cylinder');
            mesh.scale.set(radius, halfHeight, radius);
            bodyOptions = {
                restitution: 0.1,
                friction: 0.8,
                ...options,
            };
        } else if (kind === 'capsule') {
            const halfExtent = normalizedScale;
            if (includeCollisionBody) {
                shape = createOwnedShape(new Jolt.CapsuleShapeSettings(halfExtent, halfExtent));
            }
            mesh = buildPrimitiveActorMesh('capsule');
            mesh.scale.set(halfExtent, halfExtent, halfExtent);
            bodyOptions = {
                restitution: 0.0,
                friction: 0.0,
                allowedDOFs: Jolt.EAllowedDOFs_TranslationX | Jolt.EAllowedDOFs_TranslationY | Jolt.EAllowedDOFs_TranslationZ,
                ...options,
            };
        }

        const body = includeCollisionBody
            ? createDynamicPrimitiveBody(shape, spawnPosition, launchImpulse, {
                ...bodyOptions,
                simulatePhysics,
            })
            : null;

        if (includeCollisionBody && !body) {
            mesh.geometry.dispose();
            mesh.material.dispose();
            return null;
        }

        mesh.castShadow = options.castShadow ?? true;
        mesh.receiveShadow = options.receiveShadow ?? true;
        mesh.position.copy(spawnPosition);

        const actor = createDynamicPropActor({
            body,
            mesh,
            kind,
            userData: options.userData,
            includeScripts: options.includeScripts !== false,
        });
        setActorComponentFlags(actor, {
            collision: !!body,
            physics: !!body && simulatePhysics,
            scripts: options.includeScripts !== false,
        });
        if (body) {
            if (simulatePhysics) {
                physics.dynamicBodies.push(actor);
                dynamicBodySpatial.updateEntry(actor);
            } else {
                physics.staticBodies.push(actor);
            }
        }

        invalidateDDGI(`${kind} spawned`);
        return options.returnActor === true ? actor : body;
    }

    function attachDefaultPrefabScript(actor, source) {
        if (!actor || !source) return;
        const existing = actor._componentFlags || { collision: false, physics: false };
        setActorComponentFlags(actor, {
            collision: existing.collision,
            physics: existing.physics,
            scripts: true,
        });
        objectScriptState.drafts[actor.id] = { tick: source, tickEnabled: true, collision: '' };
        syncPropScriptState(actor);
        ensureScriptHandles(actor);
    }

    function ensureGameplayPrefabScript(actor, source) {
        if (!actor || !source) return false;
        ensureActorIdentity(actor);
        const actorId = actor.id;
        const hasDraft = Object.prototype.hasOwnProperty.call(objectScriptState.drafts, actorId);
        if (hasDraft) return false;
        const draft = objectScriptState.drafts[actorId];
        const currentSource = draft?.tick ?? actor?.scripts?.tick?.source ?? '';
        if (typeof currentSource === 'string' && currentSource.trim()) return false;
        attachDefaultPrefabScript(actor, source);
        return true;
    }

    function tagGameplayPrefabActor(actor, gameplayPrefab, options = {}) {
        if (!actor) return null;
        actor.userData = {
            ...(actor.userData || {}),
            gameplayPrefab,
            triggerRadius: options.triggerRadius ?? 1.2,
            scoreValue: options.scoreValue ?? 0,
            collected: false,
        };
        const mesh = getActorRenderObject(actor);
        if (mesh) {
            mesh.userData.gameplayPrefab = gameplayPrefab;
            mesh.userData.triggerRadius = actor.userData.triggerRadius;
            mesh.userData.scoreValue = actor.userData.scoreValue;
            const ignoreGroundActors = [actor];
            if (options.ignoreGroundActor) ignoreGroundActors.push(options.ignoreGroundActor);
            if (Array.isArray(options.ignoreGroundActors)) ignoreGroundActors.push(...options.ignoreGroundActors);
            const groundY = getGroundHeightAt(mesh.position.x, mesh.position.z, true, { ignoreActors: ignoreGroundActors });
            if (groundY !== null) {
                mesh.position.y = groundY + (options.groundOffset ?? 0.05);
            }
            mesh.updateMatrixWorld(true);
        }
        return actor;
    }

    function tintGameplayPrefabActor(actor, color, emissive = null, emissiveIntensity = 0) {
        setActorColor(actor, color);
        const mesh = getActorRenderObject(actor);
        mesh?.traverse?.((node) => {
            // Skip health-bar (and any skipTint-flagged) subtrees.
            for (let p = node; p; p = p.parent) {
                if (p.userData?.skipTint) return;
                if (p === mesh) break;
            }
            const materials = node?.material
                ? (Array.isArray(node.material) ? node.material : [node.material])
                : [];
            materials.forEach((mat) => {
                if (!mat?.emissive || !emissive) return;
                mat.emissive.set(emissive);
                mat.emissiveIntensity = emissiveIntensity;
                mat.toneMapped = false;
                mat.needsUpdate = true;
            });
        });
    }

    function getSoccerGoalieActors() {
        if (!core.sceneSystem?.actors?.size) return [];
        return Array.from(core.sceneSystem.actors).filter((actor) => {
            return !!(actor?.userData?.soccerGoalie || getActorRenderObject(actor)?.userData?.soccerGoalie);
        });
    }

    function applyPlayerSpawnFromActor(actor) {
        const mesh = getActorRenderObject(actor);
        if (!mesh) return false;
        mesh.updateMatrixWorld(true);
        mesh.getWorldPosition(tempVectorA);
        gameplay.spawnPoint.set(tempVectorA.x, tempVectorA.y + PLAYER_SETTINGS.floorOffset, tempVectorA.z);
        gameplay.spawnYaw = 0;
        gameplay.spawnPitch = -0.1;
        return true;
    }

    function getGameplayPrefabActors(type = '', out = null) {
        const result = out || [];
        if (out) result.length = 0;
        if (!core.sceneSystem?.actors?.size) return result;
        for (const actor of core.sceneSystem.actors) {
            const prefabType = actor?.userData?.gameplayPrefab || getActorRenderObject(actor)?.userData?.gameplayPrefab || '';
            if (prefabType && (!type || prefabType === type)) result.push(actor);
        }
        return result;
    }

    // (Shared scratch buffers _scratchPrefab1/2/_emptyArray live in runtime.js
    // — the hot callers that pass them as the `out` arg do too.)
    if (typeof window !== 'undefined') {
        queueMicrotask(() => { window.getGameplayPrefabActors = getGameplayPrefabActors; });
    }

    function getShooterSpawnPointActor(shooter) {
        const spawnPointId = shooter?.spawnedBy;
        return spawnPointId ? getDynamicPropById(spawnPointId) : null;
    }

    function getShooterGroundIgnoreActors(actor = null, shooter = null, extraActors = []) {
        const ignoredActors = new Set(extraActors.filter(Boolean));
        if (actor) ignoredActors.add(actor);
        const spawnPointActor = getShooterSpawnPointActor(shooter);
        if (spawnPointActor) ignoredActors.add(spawnPointActor);
        for (const otherShooter of getGameplayPrefabActors('shooterAi')) {
            if (otherShooter) ignoredActors.add(otherShooter);
        }
        for (const prop of physics.dynamicBodies || []) {
            if (prop?.kind === 'sphere') ignoredActors.add(prop);
        }
        return Array.from(ignoredActors);
    }

    return {
        spawnDrivableCar, createDynamicPrimitiveBody, spawnDynamicPrimitive,
        attachDefaultPrefabScript, ensureGameplayPrefabScript,
        tagGameplayPrefabActor, tintGameplayPrefabActor, getSoccerGoalieActors,
        applyPlayerSpawnFromActor, getGameplayPrefabActors,
        getShooterSpawnPointActor, getShooterGroundIgnoreActors,
    };
}