// Vehicle subsystem extracted from runtime.js: enter/exit, follow-camera
// solver, nearest-vehicle lookup, wheel visual animation, vehicle bounds and
// collision shape helpers.
//
// Stateless module — every dep is injected. Mutates `vehicleState`,
// `gameplay`, `gameplayLookTarget`, `physics`, and `camera` via the provided
// references. `getX: () => X` getters are used for runtime-reassigned
// bindings (scene, camera, currentMesh).

export function createVehicleSystem(deps) {
    const {
        THREE,
        camera, currentMesh,
        physics, dynamicBodySpatial,
        gameplay, gameplayLookTarget, vehicleState,
        VEHICLE_SETTINGS, PLAYER_SETTINGS,
        raycaster, upVector,
        tempVectorA, tempVectorB, tempVectorC, tempVectorD, tempVectorE,
        tempQuaternionA,
        copyJoltVector, copyJoltQuaternion,
        getActorBody, getActorRenderObject,
        silenceVehicleEngineAudio,
        updateGameplayUI,
        dispatchPossessionEvent,
        getGroundHitAt,
        respawnPlayer, syncCameraToCharacter, applyGameplayCameraRotation,
        createOwnedShape,
    } = deps;

    function isDrivingVehicle() {
        return gameplay.active && !!vehicleState.activePropId;
    }

    function getActiveVehicleProp() {
        if (!vehicleState.activePropId) return null;
        return physics.dynamicBodies.find((prop) => (
            prop?.id === vehicleState.activePropId
            && (prop.kind === 'vehicle' || prop.userData?.prefabId === 'helicopter')
        )) ?? null;
    }

    function clearActiveVehicle({ updateUi = false } = {}) {
        const wasDriving = !!vehicleState.activePropId;
        const priorProp = wasDriving ? getActiveVehicleProp() : null;
        if (wasDriving) silenceVehicleEngineAudio();
        vehicleState.activePropId = '';
        gameplay.activeVehicleId = '';
        vehicleState.brakeHeld = false;
        vehicleState.tailWhipLastFrame = false;

        if (!wasDriving) return;

        if (priorProp) {
            try { dispatchPossessionEvent(priorProp, false); } catch (_) {}
        }
        physics.jumpQueued = false;
        if (updateUi) updateGameplayUI();
    }

    function getVehicleForward(target, quaternion, flatten = true) {
        target.set(0, 0, -1).applyQuaternion(quaternion);
        if (flatten) {
            target.y = 0;
            if (target.lengthSq() < 1e-6) target.set(0, 0, -1);
            else target.normalize();
        }
        return target;
    }

    function resolveVehicleCameraCollision(lookTarget, desiredPosition) {
        const mesh = currentMesh();
        if (!mesh) return desiredPosition;

        const direction = tempVectorE.copy(desiredPosition).sub(lookTarget);
        const distance = direction.length();
        if (distance <= 0.001) return desiredPosition;

        direction.multiplyScalar(1 / distance);
        raycaster.set(lookTarget, direction);
        raycaster.near = 0.08;
        raycaster.far = distance;

        const hit = raycaster.intersectObject(mesh, true)
            .find((entry) => entry.distance > raycaster.near && entry.distance < distance);

        raycaster.near = 0;
        raycaster.far = Infinity;

        if (!hit?.point) return desiredPosition;
        return desiredPosition.copy(hit.point)
            .addScaledVector(direction, -VEHICLE_SETTINGS.cameraCollisionPadding);
    }

    function positionVehicleCamera(vehiclePosition, vehicleRotation, delta) {
        const cam = camera();
        const flatForward = getVehicleForward(tempVectorB, vehicleRotation, true);
        const chasePosition = tempVectorC
            .copy(vehiclePosition)
            .addScaledVector(upVector, VEHICLE_SETTINGS.followHeight)
            .addScaledVector(flatForward, -VEHICLE_SETTINGS.followDistance);

        const lookTarget = tempVectorD
            .copy(vehiclePosition)
            .addScaledVector(upVector, VEHICLE_SETTINGS.seatHeight)
            .addScaledVector(flatForward, VEHICLE_SETTINGS.lookAhead);
        resolveVehicleCameraCollision(lookTarget, chasePosition);
        const cameraLerp = 1 - Math.exp(-delta * VEHICLE_SETTINGS.cameraHorizontalSmoothing);
        const cameraVerticalLerp = 1 - Math.exp(-delta * VEHICLE_SETTINGS.cameraVerticalSmoothing);
        const lookLerp = 1 - Math.exp(-delta * VEHICLE_SETTINGS.cameraLookSmoothing);

        cam.position.x = THREE.MathUtils.lerp(cam.position.x, chasePosition.x, cameraLerp);
        cam.position.z = THREE.MathUtils.lerp(cam.position.z, chasePosition.z, cameraLerp);
        cam.position.y = THREE.MathUtils.lerp(cam.position.y, chasePosition.y, cameraVerticalLerp);

        gameplayLookTarget.lerp(lookTarget, lookLerp);
        cam.lookAt(gameplayLookTarget);

        tempVectorE.copy(gameplayLookTarget).sub(cam.position);
        const flatDistance = Math.max(0.001, Math.hypot(tempVectorE.x, tempVectorE.z));
        gameplay.yaw = Math.atan2(tempVectorE.x, tempVectorE.z);
        gameplay.pitch = THREE.MathUtils.clamp(
            Math.atan2(-tempVectorE.y, flatDistance),
            -PLAYER_SETTINGS.maxLookPitch,
            PLAYER_SETTINGS.maxLookPitch,
        );
    }

    function getNearbyVehicle() {
        const cam = camera();
        const origin = gameplay.active && physics.character
            ? copyJoltVector(tempVectorA, physics.character.GetPosition())
            : tempVectorA.copy(cam.position);
        let closestVehicle = null;
        let closestDistanceSq = VEHICLE_SETTINGS.interactionRadius * VEHICLE_SETTINGS.interactionRadius;

        const nearbyActors = dynamicBodySpatial.querySphere(origin, VEHICLE_SETTINGS.interactionRadius);
        for (const prop of nearbyActors) {
            const body = getActorBody(prop);
            if (!body) continue;
            const isFlyable = prop.userData?.prefabId === 'helicopter';
            if (prop.kind !== 'vehicle' && !isFlyable) continue;

            const bodyPosition = copyJoltVector(tempVectorB, physics.bodyInterface.GetPosition(body.GetID()));
            const distanceSq = origin.distanceToSquared(bodyPosition);
            if (distanceSq < closestDistanceSq) {
                closestDistanceSq = distanceSq;
                closestVehicle = prop;
            }
        }
        return closestVehicle;
    }

    function enterVehicle(prop = getNearbyVehicle()) {
        const propBody = getActorBody(prop);
        if (!gameplay.active || !propBody) return false;
        const isFlyableProp = prop.userData?.prefabId === 'helicopter';
        if (prop.kind !== 'vehicle' && !isFlyableProp) return false;

        vehicleState.activePropId = prop.id;
        gameplay.activeVehicleId = prop.id;
        vehicleState.brakeHeld = false;
        physics.jumpQueued = false;
        gameplay.grounded = true;

        const vehiclePosition = copyJoltVector(tempVectorA, physics.bodyInterface.GetPosition(propBody.GetID())).clone();
        const vehicleRotation = copyJoltQuaternion(tempQuaternionA, physics.bodyInterface.GetRotation(propBody.GetID())).clone();
        const flatForward = getVehicleForward(tempVectorB, vehicleRotation, true);
        gameplayLookTarget
            .copy(vehiclePosition)
            .addScaledVector(upVector, VEHICLE_SETTINGS.seatHeight)
            .addScaledVector(flatForward, VEHICLE_SETTINGS.lookAhead);
        positionVehicleCamera(vehiclePosition, vehicleRotation, 1 / 60);

        updateGameplayUI();
        try { dispatchPossessionEvent(prop, true); } catch (_) {}
        return true;
    }

    function exitVehicle() {
        const vehicle = getActiveVehicleProp();
        const vehicleBody = getActorBody(vehicle);
        if (!vehicleBody) {
            clearActiveVehicle({ updateUi: true });
            return false;
        }

        const vehiclePosition = copyJoltVector(tempVectorA, physics.bodyInterface.GetPosition(vehicleBody.GetID()));
        const vehicleRotation = copyJoltQuaternion(tempQuaternionA, physics.bodyInterface.GetRotation(vehicleBody.GetID()));
        const flatForward = getVehicleForward(tempVectorB, vehicleRotation, true);
        const exitRight = tempVectorC.set(1, 0, 0).applyQuaternion(vehicleRotation);
        exitRight.y = 0;
        if (exitRight.lengthSq() < 1e-6) exitRight.set(1, 0, 0);
        else exitRight.normalize();

        const isHeli = vehicle?.userData?.prefabId === 'helicopter';
        gameplay.spawnPoint.copy(vehiclePosition)
            .addScaledVector(exitRight, VEHICLE_SETTINGS.width * 0.95)
            .addScaledVector(flatForward, -0.45);

        if (isHeli) {
            gameplay.spawnPoint.y = vehiclePosition.y + 0.2;
        } else {
            const groundHit = getGroundHitAt(gameplay.spawnPoint.x, gameplay.spawnPoint.z, true);
            if (groundHit?.point) {
                gameplay.spawnPoint.y = groundHit.point.y + PLAYER_SETTINGS.floorOffset;
            }
        }

        const cam = camera();
        if (isHeli && cam) {
            const camEuler = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ');
            gameplay.spawnYaw = camEuler.y;
            gameplay.spawnPitch = camEuler.x;
        } else {
            gameplay.spawnYaw = Math.atan2(flatForward.x, flatForward.z);
            gameplay.spawnPitch = -0.08;
        }
        const exitSpawn = gameplay.spawnPoint.clone();
        const exitYaw = gameplay.spawnYaw;
        const exitPitch = gameplay.spawnPitch;
        clearActiveVehicle();
        respawnPlayer(true);
        // respawnPlayer -> resetGameplayPrefabs -> syncGameplaySpawnFromPlayerSpawnActor
        // can stomp spawnPoint with a placed playerSpawn actor. Re-apply and teleport.
        gameplay.spawnPoint.copy(exitSpawn);
        gameplay.spawnYaw = exitYaw;
        gameplay.spawnPitch = exitPitch;
        if (physics.character && physics.Jolt) {
            const pos = new physics.Jolt.RVec3(exitSpawn.x, exitSpawn.y, exitSpawn.z);
            physics.character.SetPosition(pos);
            physics.Jolt.destroy(pos);
            physics.character.SetLinearVelocity(physics.Jolt.Vec3.prototype.sZero());
            gameplay.velocity.set(0, 0, 0);
            gameplay.yaw = exitYaw;
            gameplay.pitch = exitPitch;
            syncCameraToCharacter();
            applyGameplayCameraRotation();
        }
        return true;
    }

    function ensureVehicleVisualState(root) {
        if (!root) return null;

        const state = root.userData?.vehicleVisual ?? null;
        const refsValid =
            state?.lastWorldPosition instanceof THREE.Vector3
            && Array.isArray(state.steeringPivots)
            && state.steeringPivots.every((p) => p?.isObject3D)
            && Array.isArray(state.spinGroups)
            && state.spinGroups.every((g) => g?.isObject3D);
        if (refsValid) return state;

        const steeringPivots = [];
        const spinGroups = [];
        root.traverse((object) => {
            const isSteeringPivot = object.userData?.vehicleSteeringPivot === true
                || typeof object.userData?.steerable === 'boolean';
            if (!isSteeringPivot) return;

            const spinGroup = object.children.find((child) => child.userData?.vehicleSpinGroup === true)
                ?? object.children.find((child) => child.isGroup || child.type === 'Group');
            if (!spinGroup) return;

            steeringPivots.push(object);
            spinGroups.push(spinGroup);
        });

        if (!steeringPivots.length || steeringPivots.length !== spinGroups.length) return null;

        const nextState = {
            steeringPivots,
            spinGroups,
            wheelRadius: Number.isFinite(state?.wheelRadius) ? state.wheelRadius : VEHICLE_SETTINGS.height * 0.36,
            maxSteerAngle: Number.isFinite(state?.maxSteerAngle) ? state.maxSteerAngle : 1.0,
            steerAngle: Number.isFinite(state?.steerAngle) ? state.steerAngle : 0,
            spinAngle: Number.isFinite(state?.spinAngle) ? state.spinAngle : 0,
            lastWorldPosition: new THREE.Vector3(),
            lastPositionInitialized: false,
        };
        root.userData.vehicleVisual = nextState;
        return nextState;
    }

    function updateVehicleVisuals(delta) {
        if (!physics.dynamicBodies?.length) return;

        const { bodyInterface } = physics;
        for (const prop of physics.dynamicBodies) {
            const renderObject = getActorRenderObject(prop);
            if (prop?.kind !== 'vehicle' || !renderObject) continue;

            const visualState = ensureVehicleVisualState(renderObject);
            if (!visualState) continue;

            // If userData was JSON-roundtripped (e.g. via three.js Object3D.clone
            // on a serialized template), every live reference inside vehicleVisual
            // is now a plain object: Vector3 has no .copy, steeringPivots / spinGroups
            // entries have no .rotation/.userData. Rather than crash every frame,
            // skip the broken state — the wheels won't animate but the editor stays
            // usable.
            const refsValid =
                visualState.lastWorldPosition instanceof THREE.Vector3
                && Array.isArray(visualState.steeringPivots)
                && visualState.steeringPivots.every((p) => p?.isObject3D)
                && Array.isArray(visualState.spinGroups)
                && visualState.spinGroups.every((g) => g?.isObject3D);
            if (!refsValid) continue;

            const flatForward = tempVectorA.set(0, 0, -1).applyQuaternion(renderObject.quaternion);
            flatForward.y = 0;
            if (flatForward.lengthSq() < 1e-6) flatForward.set(0, 0, -1);
            else flatForward.normalize();

            // Prefer Jolt's authoritative velocity while physics is stepping; in
            // edit/showcase mode physics is paused, so fall back to a frame-to-frame
            // world-position delta so the wheels still spin when the user drags
            // or scripts move the chassis.
            const body = bodyInterface ? getActorBody(prop) : null;
            let forwardSpeed = 0;
            if (body && physics.ready && gameplay.active) {
                const linearVelocity = copyJoltVector(tempVectorB, bodyInterface.GetLinearVelocity(body.GetID()));
                forwardSpeed = linearVelocity.dot(flatForward);
            } else {
                const currentPos = renderObject.getWorldPosition(tempVectorB);
                if (visualState.lastPositionInitialized && delta > 1e-5) {
                    const move = tempVectorC.subVectors(currentPos, visualState.lastWorldPosition);
                    forwardSpeed = move.dot(flatForward) / delta;
                }
                visualState.lastWorldPosition.copy(currentPos);
                visualState.lastPositionInitialized = true;
            }

            visualState.spinAngle += (forwardSpeed / visualState.wheelRadius) * delta;
            const isActiveVehicle = gameplay.active && vehicleState.activePropId === prop.id;
            const inputSteer = isActiveVehicle
                ? ((gameplay.input.left ? 1 : 0) - (gameplay.input.right ? 1 : 0))
                : 0;
            const speedRatio = THREE.MathUtils.clamp(Math.abs(forwardSpeed) / VEHICLE_SETTINGS.maxDriveSpeed, 0, 1);
            const targetSteerAngle = inputSteer * visualState.maxSteerAngle * THREE.MathUtils.lerp(1, 0.58, speedRatio);
            visualState.steerAngle = THREE.MathUtils.damp(visualState.steerAngle, targetSteerAngle, 10, delta);

            visualState.steeringPivots.forEach((pivot) => {
                pivot.rotation.y = pivot.userData.steerable ? visualState.steerAngle : 0;
            });
            visualState.spinGroups.forEach((group) => {
                group.rotation.x = visualState.spinAngle;
            });
        }
    }

    function getVehicleVisualBounds(chassis) {
        const bounds = new THREE.Box3();
        const rootInverse = new THREE.Matrix4();
        const localMatrix = new THREE.Matrix4();
        const meshBounds = new THREE.Box3();

        chassis.updateWorldMatrix(true, true);
        rootInverse.copy(chassis.matrixWorld).invert();
        chassis.traverse((node) => {
            if (!node.isMesh || !node.geometry) return;
            node.geometry.computeBoundingBox?.();
            if (!node.geometry.boundingBox) return;
            localMatrix.multiplyMatrices(rootInverse, node.matrixWorld);
            meshBounds.copy(node.geometry.boundingBox).applyMatrix4(localMatrix);
            bounds.union(meshBounds);
        });

        if (bounds.isEmpty()) {
            const halfSize = new THREE.Vector3(
                VEHICLE_SETTINGS.width * 0.5,
                VEHICLE_SETTINGS.height * 0.5,
                VEHICLE_SETTINGS.length * 0.5,
            );
            return {
                min: halfSize.clone().multiplyScalar(-1),
                max: halfSize.clone(),
                center: new THREE.Vector3(),
                size: halfSize.multiplyScalar(2),
            };
        }

        return {
            min: bounds.min.clone(),
            max: bounds.max.clone(),
            center: bounds.getCenter(new THREE.Vector3()),
            size: bounds.getSize(new THREE.Vector3()),
        };
    }

    function createVehicleCollisionShapeFromBounds(bounds) {
        const { Jolt } = physics;
        const size = bounds?.size || new THREE.Vector3(
            VEHICLE_SETTINGS.width,
            VEHICLE_SETTINGS.height,
            VEHICLE_SETTINGS.length,
        );
        const center = bounds?.center || new THREE.Vector3();
        // Rounded chassis box: a larger convex radius rounds the lower edges so
        // the body skates over curbs/bumps instead of catching. We DON'T lift the
        // box (that made the car float) — only round it; the raycast suspension
        // still sets the ride height.
        const halfExtent = new Jolt.Vec3(
            Math.max(size.x * 0.5, 0.05),
            Math.max(size.y * 0.5, 0.05),
            Math.max(size.z * 0.5, 0.05),
        );
        const boxShape = createOwnedShape(new Jolt.BoxShapeSettings(halfExtent, 0.15));
        Jolt.destroy(halfExtent);

        const compound = new Jolt.MutableCompoundShapeSettings();
        const offset = new Jolt.Vec3(center.x, center.y, center.z);
        const rotation = new Jolt.Quat(0, 0, 0, 1);
        compound.AddShapeShape(offset, rotation, boxShape, 0);
        Jolt.destroy(offset);
        Jolt.destroy(rotation);
        return createOwnedShape(compound);
    }

    return {
        isDrivingVehicle,
        getActiveVehicleProp,
        clearActiveVehicle,
        getVehicleForward,
        resolveVehicleCameraCollision,
        positionVehicleCamera,
        getNearbyVehicle,
        enterVehicle,
        exitVehicle,
        ensureVehicleVisualState,
        updateVehicleVisuals,
        getVehicleVisualBounds,
        createVehicleCollisionShapeFromBounds,
    };
}
