// src/vehicle/vehicleController.js
// Extracted from main.js (chore/main-js-shrink-2):
//   - vehicle helpers around L1886–2153 (isDrivingVehicle … updateVehicleVisuals)
//   - the drive sim L6867–7117 (updateVehicleGameplay)
//
// The visual-template factory (createDrivableCarVisual) lives in src/vehicle/visual.js;
// the chassis FX (emitSurfaceEffects, etc.) live in vehicleFx (src/vehicle/fx.js bound
// in main.js). Engine-audio hooks come from src/audio/vehicleEngineAudio.js.
// Anything physics-construction-shaped (spawnDrivableCar, createDynamicPrimitiveBody)
// stays in main.js because it depends on internal physics layer wiring.

import * as THREE from 'three';
import {
    silenceVehicleEngineAudio,
    updateVehicleEngineAudio,
} from '../audio/vehicleEngineAudio.js';

// Module-scope deps — populated by setupVehicleController.
// `getWorldFloor` is a getter because the worldFloor mesh is created in init()
// AFTER wireExtractedModules() runs (see main.js around L5200), so a snapshot
// would capture `undefined`.
let physics, gameplay, vehicleState, importedPropState;
let camera;
let VEHICLE_SETTINGS, PLAYER_SETTINGS;
let getWorldFloor;
let upVector, gameplayLookTarget;
let tempVectorA, tempVectorB, tempVectorC, tempVectorD, tempVectorE;
let tempQuaternionA;
let copyJoltVector, copyJoltQuaternion;
let getActorBody, getActorRenderObject;
let emitVehicleSurfaceEffects;
let getGroundHitAt, getGroundHeightAt;
let updateGameplayUI, respawnPlayer;

export function setupVehicleController(deps) {
    ({
        physics, gameplay, vehicleState, importedPropState,
        camera,
        VEHICLE_SETTINGS, PLAYER_SETTINGS,
        getWorldFloor,
        upVector, gameplayLookTarget,
        tempVectorA, tempVectorB, tempVectorC, tempVectorD, tempVectorE,
        tempQuaternionA,
        copyJoltVector, copyJoltQuaternion,
        getActorBody, getActorRenderObject,
        emitVehicleSurfaceEffects,
        getGroundHitAt, getGroundHeightAt,
        updateGameplayUI, respawnPlayer,
    } = deps);
}

export function isDrivingVehicle() {
    return gameplay.active && !!vehicleState.activePropId;
}

export function getActiveVehicleProp() {
    if (!vehicleState.activePropId) return null;

    return physics.dynamicBodies.find((prop) => (
        prop?.id === vehicleState.activePropId && prop.kind === 'vehicle'
    )) ?? null;
}

export function clearActiveVehicle({ updateUi = false } = {}) {
    const wasDriving = !!vehicleState.activePropId;
    if (wasDriving) {
        silenceVehicleEngineAudio();
    }
    vehicleState.activePropId = '';
    vehicleState.brakeHeld = false;
    vehicleState.tailWhipLastFrame = false;

    if (!wasDriving) return;

    physics.jumpQueued = false;
    if (updateUi) {
        updateGameplayUI();
    }
}

export function getVehicleForward(target, quaternion, flatten = true) {
    target.set(0, 0, -1).applyQuaternion(quaternion);
    if (flatten) {
        target.y = 0;
        if (target.lengthSq() < 1e-6) {
            target.set(0, 0, -1);
        } else {
            target.normalize();
        }
    }

    return target;
}

export function positionVehicleCamera(vehiclePosition, vehicleRotation, delta) {
    const flatForward = getVehicleForward(tempVectorB, vehicleRotation, true);
    const chasePosition = tempVectorC
        .copy(vehiclePosition)
        .addScaledVector(upVector, VEHICLE_SETTINGS.followHeight)
        .addScaledVector(flatForward, -VEHICLE_SETTINGS.followDistance);

    const lookTarget = tempVectorD
        .copy(vehiclePosition)
        .addScaledVector(upVector, VEHICLE_SETTINGS.seatHeight)
        .addScaledVector(flatForward, VEHICLE_SETTINGS.lookAhead);
    const cameraLerp = 1 - Math.exp(-delta * VEHICLE_SETTINGS.cameraHorizontalSmoothing);
    const cameraVerticalLerp = 1 - Math.exp(-delta * VEHICLE_SETTINGS.cameraVerticalSmoothing);
    const lookLerp = 1 - Math.exp(-delta * VEHICLE_SETTINGS.cameraLookSmoothing);

    camera.position.x = THREE.MathUtils.lerp(camera.position.x, chasePosition.x, cameraLerp);
    camera.position.z = THREE.MathUtils.lerp(camera.position.z, chasePosition.z, cameraLerp);
    camera.position.y = THREE.MathUtils.lerp(camera.position.y, chasePosition.y, cameraVerticalLerp);

    gameplayLookTarget.lerp(lookTarget, lookLerp);
    camera.lookAt(gameplayLookTarget);

    tempVectorE.copy(gameplayLookTarget).sub(camera.position);
    const flatDistance = Math.max(0.001, Math.hypot(tempVectorE.x, tempVectorE.z));
    gameplay.yaw = Math.atan2(tempVectorE.x, tempVectorE.z);
    gameplay.pitch = THREE.MathUtils.clamp(
        Math.atan2(-tempVectorE.y, flatDistance),
        -PLAYER_SETTINGS.maxLookPitch,
        PLAYER_SETTINGS.maxLookPitch
    );
}

export function getNearbyVehicle() {
    const origin = gameplay.active && physics.character
        ? copyJoltVector(tempVectorA, physics.character.GetPosition())
        : tempVectorA.copy(camera.position);
    let closestVehicle = null;
    let closestDistanceSq = VEHICLE_SETTINGS.interactionRadius * VEHICLE_SETTINGS.interactionRadius;

    for (const prop of physics.dynamicBodies) {
        const body = getActorBody(prop);
        if (!body || prop.kind !== 'vehicle') continue;

        const bodyPosition = copyJoltVector(tempVectorB, physics.bodyInterface.GetPosition(body.GetID()));
        const distanceSq = origin.distanceToSquared(bodyPosition);
        if (distanceSq < closestDistanceSq) {
            closestDistanceSq = distanceSq;
            closestVehicle = prop;
        }
    }

    return closestVehicle;
}

export function enterVehicle(prop = getNearbyVehicle()) {
    const propBody = getActorBody(prop);
    if (!gameplay.active || !propBody || prop.kind !== 'vehicle') return false;

    vehicleState.activePropId = prop.id;
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
    return true;
}

export function exitVehicle() {
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
    if (exitRight.lengthSq() < 1e-6) {
        exitRight.set(1, 0, 0);
    } else {
        exitRight.normalize();
    }

    gameplay.spawnPoint.copy(vehiclePosition)
        .addScaledVector(exitRight, VEHICLE_SETTINGS.width * 0.95)
        .addScaledVector(flatForward, -0.45);

    const groundHit = getGroundHitAt(gameplay.spawnPoint.x, gameplay.spawnPoint.z, true);
    if (groundHit?.point) {
        gameplay.spawnPoint.y = groundHit.point.y + PLAYER_SETTINGS.floorOffset;
    }

    gameplay.spawnYaw = Math.atan2(flatForward.x, flatForward.z);
    gameplay.spawnPitch = -0.08;
    clearActiveVehicle();
    respawnPlayer(true);
    return true;
}


export function ensureVehicleVisualState(root) {
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


export function updateVehicleVisuals(delta) {
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
        if (flatForward.lengthSq() < 1e-6) {
            flatForward.set(0, 0, -1);
        } else {
            flatForward.normalize();
        }

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

export function updateVehicleGameplay(delta) {
    const vehicle = getActiveVehicleProp();
    if (!vehicle?.body) {
        clearActiveVehicle({ updateUi: true });
        return;
    }

    const { Jolt, bodyInterface } = physics;
    const bodyId = vehicle.body.GetID();
    const throttle = (gameplay.input.forward ? 1 : 0) - (gameplay.input.back ? 1 : 0);
    const steer = (gameplay.input.left ? 1 : 0) - (gameplay.input.right ? 1 : 0);
    const boostMultiplier = gameplay.input.sprint ? 1.35 : 1;
    const vehiclePosition = copyJoltVector(tempVectorA, bodyInterface.GetPosition(bodyId)).clone();
    const vehicleRotation = copyJoltQuaternion(tempQuaternionA, bodyInterface.GetRotation(bodyId)).clone();
    const flatForward = getVehicleForward(tempVectorB, vehicleRotation, true).clone();
    const vehicleUp = tempVectorC.set(0, 1, 0).applyQuaternion(vehicleRotation).normalize().clone();
    const vehicleForward = tempVectorA.set(0, 0, -1).applyQuaternion(vehicleRotation).normalize().clone();
    const vehicleRight = tempVectorB.set(1, 0, 0).applyQuaternion(vehicleRotation).normalize().clone();
    const linearVelocity = copyJoltVector(tempVectorD, bodyInterface.GetLinearVelocity(bodyId)).clone();
    const angularVelocity = copyJoltVector(tempVectorE, bodyInterface.GetAngularVelocity(bodyId)).clone();
    const flatRight = tempVectorC.crossVectors(flatForward, upVector).normalize().clone();
    const horizontalVelocity = tempVectorD.copy(linearVelocity).setY(0);
    const forwardSpeed = horizontalVelocity.dot(flatForward);
    const lateralSpeed = horizontalVelocity.dot(flatRight);
    const throttleInput = throttle;
    const speedRatio = THREE.MathUtils.clamp(Math.abs(forwardSpeed) / VEHICLE_SETTINGS.maxDriveSpeed, 0, 1);
    const driftInput = Math.abs(steer) > 0.1 && speedRatio > VEHICLE_SETTINGS.driftBoostThreshold;
    const drifting = driftInput && (throttle !== 0 || Math.abs(lateralSpeed) > 1.2);
    const halfWheelBase = VEHICLE_SETTINGS.wheelBase * 1.0;
    const halfTrackWidth = VEHICLE_SETTINGS.trackWidth * 0.5;
    const rideState = vehicle.mesh.userData.vehicleRideState || {
        sampleRideHeights: [null, null, null, null],
        compression: 0,
        contactRatio: 0,
        frontCompression: 0,
        rearCompression: 0,
        leftCompression: 0,
        rightCompression: 0,
        filteredGroundHeight: null,
    };
    vehicle.mesh.userData.vehicleRideState = rideState;
    const cornerSamples = [
        { forward: halfWheelBase, sideways: -halfTrackWidth },
        { forward: halfWheelBase, sideways: halfTrackWidth },
        { forward: -halfWheelBase, sideways: -halfTrackWidth },
        { forward: -halfWheelBase, sideways: halfTrackWidth },
    ].map((corner, index) => {
        const sampleX = vehiclePosition.x + flatForward.x * corner.forward + flatRight.x * corner.sideways;
        const sampleZ = vehiclePosition.z + flatForward.z * corner.forward + flatRight.z * corner.sideways;
        const sampleAnchorY = vehiclePosition.y
            + vehicleForward.y * corner.forward
            + vehicleRight.y * corner.sideways;
        const groundHeight = getGroundHeightAt(sampleX, sampleZ, true, {
            ignoreActor: vehicle,
            minSurfaceUpDot: 0.35,
            surfaceStepTolerance: 0,
            cullBackFaces: true,
            maxHitY: sampleAnchorY + 0.05,
        });
        const rideHeight = groundHeight === null ? null : vehiclePosition.y - groundHeight;
        rideState.sampleRideHeights[index] = rideHeight;
        const compression = rideHeight === null
            ? 0
            : THREE.MathUtils.clamp(VEHICLE_SETTINGS.suspensionRideHeight - rideHeight, 0, VEHICLE_SETTINGS.suspensionTravel);

        return {
            ...corner,
            rideHeight,
            compression,
        };
    });
    const contactSamples = cornerSamples.filter((corner) => corner.rideHeight !== null && corner.rideHeight <= VEHICLE_SETTINGS.suspensionRideHeight + VEHICLE_SETTINGS.suspensionTravel);
    const grounded = contactSamples.length > 0;
    const contactRatio = contactSamples.length / cornerSamples.length;
    const averageCompression = contactSamples.length
        ? Math.max(...contactSamples.map((corner) => corner.compression))
        : 0;
    const averageGroundHeight = contactSamples.length
        ? Math.max(...contactSamples.map((corner) => vehiclePosition.y - corner.rideHeight))
        : null;
    const frontCompression = Math.max(cornerSamples[0].compression, cornerSamples[1].compression);
    const rearCompression = Math.max(cornerSamples[2].compression, cornerSamples[3].compression);
    const leftCompression = Math.max(cornerSamples[0].compression, cornerSamples[2].compression);
    const rightCompression = Math.max(cornerSamples[1].compression, cornerSamples[3].compression);
    rideState.compression = averageCompression;
    rideState.contactRatio = contactRatio;
    rideState.frontCompression = frontCompression;
    rideState.rearCompression = rearCompression;
    rideState.leftCompression = leftCompression;
    rideState.rightCompression = rightCompression;
    const smoothedAverageCompression = averageCompression;
    const smoothedContactRatio = contactRatio;
    const smoothedFrontCompression = frontCompression;
    const smoothedRearCompression = rearCompression;
    const smoothedLeftCompression = leftCompression;
    const smoothedRightCompression = rightCompression;
    let filteredGroundHeight = averageGroundHeight;
    rideState.filteredGroundHeight = filteredGroundHeight;
    const targetForwardSpeed = grounded && throttle > 0
        ? VEHICLE_SETTINGS.maxDriveSpeed * boostMultiplier
        : grounded && throttle < 0
            ? -VEHICLE_SETTINGS.maxReverseSpeed
            : 0;
    const forwardLambda = grounded && throttle > 0
        ? (gameplay.input.sprint ? VEHICLE_SETTINGS.boostAcceleration : VEHICLE_SETTINGS.acceleration)
        : grounded && throttle < 0
            ? VEHICLE_SETTINGS.reverseAcceleration
            : grounded
                ? VEHICLE_SETTINGS.coastDrag
                : 0;
    let nextForwardSpeed = THREE.MathUtils.damp(forwardSpeed, targetForwardSpeed, forwardLambda, delta);
    nextForwardSpeed *= 1 - (VEHICLE_SETTINGS.rollingDrag * delta);
    const gripBase = speedRatio >= 0.5
        ? VEHICLE_SETTINGS.highSpeedGrip
        : VEHICLE_SETTINGS.lowSpeedGrip;

    const gripLambda = vehicleState.brakeHeld
        ? VEHICLE_SETTINGS.brakeGrip
        : drifting
            ? VEHICLE_SETTINGS.driftGrip
            : gripBase;

    const contactGrip = grounded
        ? gripLambda
        : VEHICLE_SETTINGS.partialContactGrip;
    const nextLateralSpeed = THREE.MathUtils.damp(lateralSpeed, 0, contactGrip, delta);
    const nextHorizontalVelocity = tempVectorE
        .copy(flatForward)
        .multiplyScalar(nextForwardSpeed)
        .addScaledVector(flatRight, nextLateralSpeed);

    if (vehicleState.brakeHeld) {
        nextHorizontalVelocity.multiplyScalar(VEHICLE_SETTINGS.brakeDamping);
    }

    let nextVerticalVelocity = linearVelocity.y;
    if (grounded && filteredGroundHeight !== null) {
        const targetBodyHeight = filteredGroundHeight + VEHICLE_SETTINGS.suspensionRideHeight - VEHICLE_SETTINGS.suspensionTravel * 0.5;
        const heightError = targetBodyHeight - vehiclePosition.y;
        const springForce = heightError * VEHICLE_SETTINGS.suspensionSpring * 9.81;
        const damperForce = -linearVelocity.y * VEHICLE_SETTINGS.suspensionDamping;
        nextVerticalVelocity = linearVelocity.y + (springForce + damperForce) * delta;
    }

    const nextVelocity = new Jolt.Vec3(nextHorizontalVelocity.x, nextVerticalVelocity, nextHorizontalVelocity.z);
    bodyInterface.SetLinearVelocity(bodyId, nextVelocity);
    Jolt.destroy(nextVelocity);

    const steerSpeedFactor = THREE.MathUtils.clamp(Math.abs(nextForwardSpeed) / VEHICLE_SETTINGS.maxDriveSpeed, 0, 1);
    const steeringDirection = nextForwardSpeed >= 0 ? 1 : -0.7;
    const steeringStrength = steerSpeedFactor >= 0.5
        ? VEHICLE_SETTINGS.steeringHighSpeedDamping
        : 1;
    const driftSteerBonus = drifting ? VEHICLE_SETTINGS.driftSteerBonus : 1;

    const targetYawRate = steer === 0
        ? 0
        : steer * steeringDirection * VEHICLE_SETTINGS.steeringRate * steeringStrength * driftSteerBonus;

    const yawLambda = steer === 0 ? VEHICLE_SETTINGS.steeringReturn : VEHICLE_SETTINGS.steeringGrip;

    const nextYawRate = THREE.MathUtils.damp(angularVelocity.y, targetYawRate, yawLambda, delta);
    const rollTilt = -steer * Math.max(0.08, Math.abs(nextForwardSpeed) / VEHICLE_SETTINGS.maxDriveSpeed) * 0.5;
    const pitchTilt = throttle === 0 ? 0 : -throttle * 0.08;
    const nextAngular = new Jolt.Vec3(
        THREE.MathUtils.damp(angularVelocity.x, pitchTilt, grounded ? VEHICLE_SETTINGS.pitchTorque * 0.01 : VEHICLE_SETTINGS.airtimeAngularBlend, delta),
        nextYawRate,
        THREE.MathUtils.damp(angularVelocity.z, rollTilt, grounded ? VEHICLE_SETTINGS.rollTorque * 0.01 : VEHICLE_SETTINGS.airtimeAngularBlend, delta)
    );
    bodyInterface.SetAngularVelocity(bodyId, nextAngular);
    Jolt.destroy(nextAngular);

    if (throttle !== 0 || steer !== 0 || vehicleState.brakeHeld || horizontalVelocity.lengthSq() > 0.01) {
        bodyInterface.ActivateBody(bodyId);
    }

    const vehicleRenderObject = getActorRenderObject(vehicle);
    const vehicleVisualState = vehicleRenderObject ? ensureVehicleVisualState(vehicleRenderObject) : null;
    const rearWheelWorldPositions = [];
    if (vehicleVisualState?.steeringPivots?.length >= 4) {
        const forwardOffset = VEHICLE_SETTINGS.wheelBase * 0.18;
        for (let i = 2; i < 4; i++) {
            const pivot = vehicleVisualState.steeringPivots[i];
            if (!pivot?.isObject3D) { rearWheelWorldPositions.push(null); continue; }
            const wheelPos = new THREE.Vector3();
            pivot.getWorldPosition(wheelPos);
            wheelPos.y -= vehicleVisualState.wheelRadius || 0;
            wheelPos.addScaledVector(flatForward, forwardOffset);
            rearWheelWorldPositions.push(wheelPos);
        }
    }

    emitVehicleSurfaceEffects(delta, {
        vehiclePosition,
        flatForward,
        flatRight,
        cornerSamples,
        grounded,
        drifting,
        brakeHeld: vehicleState.brakeHeld,
        forwardSpeed: nextForwardSpeed,
        lateralSpeed,
        averageCompression,
        verticalSpeed: linearVelocity.y,
        rearWheelWorldPositions,
    });

    const uprightCorrection = tempVectorA.copy(vehicleUp).cross(upVector).multiplyScalar(-VEHICLE_SETTINGS.uprightTorque * (grounded ? 1 : 0.05));
    if (uprightCorrection.lengthSq() > 1e-6) {
        const uprightTorque = new Jolt.Vec3(uprightCorrection.x, uprightCorrection.y, uprightCorrection.z);
        bodyInterface.AddTorque(bodyId, uprightTorque, Jolt.EActivation_Activate);
        Jolt.destroy(uprightTorque);
    }

    vehicle.mesh.position.copy(vehiclePosition);
    vehicle.mesh.quaternion.copy(vehicleRotation);
    updateVehicleEngineAudio(delta, vehicle, {
        throttleInput,
        brakeHeld: vehicleState.brakeHeld,
        grounded,
        forwardSpeed: nextForwardSpeed,
    });
    positionVehicleCamera(vehiclePosition, vehicleRotation, delta);
    gameplay.grounded = grounded;
    physics.jumpQueued = false;

    // Update example widgets with vehicle data
    if (window.exampleWidgets) {
        const speedKmh = Math.round(forwardSpeed * 3.6); // Convert m/s to km/h
        window.exampleWidgets.speed?.SetText(`Speed: ${speedKmh} km/h`);

        // Update health bar based on vehicle "health" (using contact ratio as proxy)
        window.exampleWidgets.health?.SetPercent(Math.max(0.1, smoothedContactRatio));

        // Update score
        if (window.gameScore !== undefined) {
            // Add points for driving

            // Bonus points for high speed
            if (forwardSpeed > 15) {
            }

            window.exampleWidgets.score?.SetText(`Score: ${Math.floor(window.gameScore)}`);
        }
    }

    const worldFloor = getWorldFloor();
    if (worldFloor && vehiclePosition.y < worldFloor.position.y - 24) {
        exitVehicle();
        respawnPlayer(true);
    }
}
