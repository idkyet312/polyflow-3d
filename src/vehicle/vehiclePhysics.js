import * as THREE from 'three';
import { core } from '../runtime/appCore.js';

// Vehicle + helicopter gameplay physics and ground/wall raycast queries,
// extracted from runtime.js. All 28 scratch buffers are span-local (no
// shared-decl leak). Live engine refs (camera/currentMesh/sceneSystem/
// worldFloor) come through the appCore keystone; rest injected via factory.
export function createVehiclePhysics(deps) {
    const {
        HELI_SETTINGS, PLAYER_SETTINGS, VEHICLE_SETTINGS,
        downVector, emitVehicleSurfaceEffects, gameplay, gameplayBounds,
        physics, raycaster, tempVectorA, tempVectorB, tempVectorE, upVector,
        vehicleState,
        clearActiveVehicle, copyJoltQuaternion, copyJoltVector,
        ensureVehicleVisualState, exitVehicle, getActiveVehicleProp,
        getActorRenderObject, getVehicleForward, positionVehicleCamera,
        respawnPlayer, sampleTerrainHeightAt,
        updateRaycasterDebugLine, updateVehicleEngineAudio,
    } = deps;

    const _hPos = new THREE.Vector3();
    const _hRot = new THREE.Quaternion();
    const _hForward = new THREE.Vector3();
    const _hRight = new THREE.Vector3();
    const _hUp = new THREE.Vector3();
    const _hFlatForward = new THREE.Vector3();
    const _hFlatRight = new THREE.Vector3();
    const _hLinVel = new THREE.Vector3();
    const _hAngVel = new THREE.Vector3();
    const _hEuler = new THREE.Euler();
    function updateHelicopterGameplay(vehicle, delta) {
        const { Jolt, bodyInterface } = physics;
        const bodyId = vehicle.body.GetID();

        // If the helicopter actor's user script provides OnInput, it owns flight.
        // Runtime only handles camera follow + visual mirror.
        const scriptHandles = vehicle.scripts?.tick?.handles;
        if (typeof scriptHandles?.OnInput === 'function') {
            const position = copyJoltVector(_hPos, bodyInterface.GetPosition(bodyId));
            const rotation = copyJoltQuaternion(_hRot, bodyInterface.GetRotation(bodyId));
            vehicle.mesh.position.copy(position);
            vehicle.mesh.quaternion.copy(rotation);
            positionVehicleCamera(position, rotation, delta);
            return;
        }

        const throttleFwd = (gameplay.input.forward ? 1 : 0) - (gameplay.input.back ? 1 : 0);
        const strafe = (gameplay.input.right ? 1 : 0) - (gameplay.input.left ? 1 : 0);
        const yawInput = strafe;
        const liftUp = gameplay.input.lift ? 1 : 0;
        const liftDown = gameplay.input.descend ? 1 : 0;

        const position = copyJoltVector(_hPos, bodyInterface.GetPosition(bodyId));
        const rotation = copyJoltQuaternion(_hRot, bodyInterface.GetRotation(bodyId));
        const forward = _hForward.set(0, 0, -1).applyQuaternion(rotation).normalize();
        const right = _hRight.set(1, 0, 0).applyQuaternion(rotation).normalize();
        const up = _hUp.set(0, 1, 0).applyQuaternion(rotation).normalize();
        const flatForward = _hFlatForward.copy(forward); flatForward.y = 0;
        if (flatForward.lengthSq() < 1e-4) flatForward.copy(forward);
        flatForward.normalize();
        const flatRight = _hFlatRight.crossVectors(flatForward, upVector).normalize();

        const linVel = copyJoltVector(_hLinVel, bodyInterface.GetLinearVelocity(bodyId));
        const angVel = copyJoltVector(_hAngVel, bodyInterface.GetAngularVelocity(bodyId));

        // Lift: counter gravity + active up/down. Tilt reduces vertical thrust.
        const gravityAssist = 9.81;
        let verticalAccel = gravityAssist;
        if (liftUp) verticalAccel += HELI_SETTINGS.liftAccel;
        if (liftDown) verticalAccel -= HELI_SETTINGS.descendAccel;
        if (!liftUp && !liftDown) {
            verticalAccel -= linVel.y * HELI_SETTINGS.hoverDamping;
        }
        let newVy = linVel.y + verticalAccel * delta;
        newVy = THREE.MathUtils.clamp(newVy, -HELI_SETTINGS.maxLift, HELI_SETTINGS.maxLift);

        // Horizontal: forward thrust along flat-forward when pitched.
        const targetFwdSpeed = throttleFwd * HELI_SETTINGS.maxForwardSpeed;
        const targetStrafeSpeed = 0;
        // dot(horizVel, flatForward) where horizVel = (linVel.x, 0, linVel.z).
        const fwdSpeed = linVel.x * flatForward.x + linVel.z * flatForward.z;
        const sideSpeed = linVel.x * flatRight.x + linVel.z * flatRight.z;
        const nextFwd = THREE.MathUtils.damp(fwdSpeed, targetFwdSpeed, HELI_SETTINGS.horizontalDrag * 4, delta);
        const nextSide = THREE.MathUtils.damp(sideSpeed, targetStrafeSpeed, HELI_SETTINGS.horizontalDrag * 6, delta);
        const nextHorizX = flatForward.x * nextFwd + flatRight.x * nextSide;
        const nextHorizZ = flatForward.z * nextFwd + flatRight.z * nextSide;

        const nextVel = new Jolt.Vec3(nextHorizX, newVy, nextHorizZ);
        bodyInterface.SetLinearVelocity(bodyId, nextVel);
        Jolt.destroy(nextVel);

        // Yaw + tilt for visual lean
        const targetYaw = -yawInput * HELI_SETTINGS.yawRate;
        const nextYaw = THREE.MathUtils.damp(angVel.y, targetYaw, HELI_SETTINGS.yawAccel, delta);

        // Pitch & roll auto-level toward tilt angles based on input
        const euler = _hEuler.setFromQuaternion(rotation, 'YXZ');
        const targetPitch = -throttleFwd * HELI_SETTINGS.tiltAngle;
        const targetRoll = 0;
        const pitchError = targetPitch - euler.x;
        const rollError = targetRoll - euler.z;
        const pitchTorque = pitchError * HELI_SETTINGS.levelTorque - angVel.x * 1.4;
        const rollTorque = rollError * HELI_SETTINGS.levelTorque - angVel.z * 1.4;

        const nextAng = new Jolt.Vec3(
            angVel.x + pitchTorque * delta,
            nextYaw,
            angVel.z + rollTorque * delta,
        );
        bodyInterface.SetAngularVelocity(bodyId, nextAng);
        Jolt.destroy(nextAng);

        bodyInterface.ActivateBody(bodyId);

        vehicle.mesh.position.copy(position);
        vehicle.mesh.quaternion.copy(rotation);

        const rotorSpeed = 30 + (liftUp ? 12 : 0) + Math.abs(throttleFwd) * 6;
        vehicle.mesh.getObjectByName?.('helicopter-main-rotor')?.rotateY(delta * rotorSpeed);
        vehicle.mesh.getObjectByName?.('helicopter-tail-rotor')?.rotateZ(delta * rotorSpeed * 1.5);

        positionVehicleCamera(position, rotation, delta);
    }

    // Dedicated per-frame scratch vectors for updateVehicleGameplay. The original
    // code allocated 7+ clones every frame because the global tempVector pool was
    // being overwritten mid-function.
    const _vPos = new THREE.Vector3();
    const _vRot = new THREE.Quaternion();
    const _vFlatForward = new THREE.Vector3();
    const _vUp = new THREE.Vector3();
    const _vForward = new THREE.Vector3();
    const _vRight = new THREE.Vector3();
    const _vLinVel = new THREE.Vector3();
    const _vAngVel = new THREE.Vector3();
    const _vFlatRight = new THREE.Vector3();
    const _vHorizVel = new THREE.Vector3();
    // Pre-allocated corner sample objects; fields are overwritten each frame so
    // the downstream consumer reads fresh values without allocating new objects.
    const _cornerSamplesScratch = [
        { forward: 0, sideways: 0, rideHeight: null, compression: 0 },
        { forward: 0, sideways: 0, rideHeight: null, compression: 0 },
        { forward: 0, sideways: 0, rideHeight: null, compression: 0 },
        { forward: 0, sideways: 0, rideHeight: null, compression: 0 },
    ];
    const _rearWheelScratch = [new THREE.Vector3(), new THREE.Vector3()];
    const _rearWheelScratchOut = [];
    function updateVehicleGameplay(delta) {
        const vehicle = getActiveVehicleProp();
        if (!vehicle?.body) {
            clearActiveVehicle({ updateUi: true });
            return;
        }

        if (vehicle.userData?.prefabId === 'helicopter') {
            updateHelicopterGameplay(vehicle, delta);
            return;
        }

        const { Jolt, bodyInterface } = physics;
        const bodyId = vehicle.body.GetID();
        const throttle = (gameplay.input.forward ? 1 : 0) - (gameplay.input.back ? 1 : 0);
        const steer = (gameplay.input.left ? 1 : 0) - (gameplay.input.right ? 1 : 0);
        const boostMultiplier = gameplay.input.sprint ? 1.35 : 1;
        const vehiclePosition = copyJoltVector(_vPos, bodyInterface.GetPosition(bodyId));
        const vehicleRotation = copyJoltQuaternion(_vRot, bodyInterface.GetRotation(bodyId));
        const flatForward = getVehicleForward(_vFlatForward, vehicleRotation, true);
        const vehicleUp = _vUp.set(0, 1, 0).applyQuaternion(vehicleRotation).normalize();
        const vehicleForward = _vForward.set(0, 0, -1).applyQuaternion(vehicleRotation).normalize();
        const vehicleRight = _vRight.set(1, 0, 0).applyQuaternion(vehicleRotation).normalize();
        const linearVelocity = copyJoltVector(_vLinVel, bodyInterface.GetLinearVelocity(bodyId));
        const angularVelocity = copyJoltVector(_vAngVel, bodyInterface.GetAngularVelocity(bodyId));
        const flatRight = _vFlatRight.crossVectors(flatForward, upVector).normalize();
        const horizontalVelocity = _vHorizVel.copy(linearVelocity).setY(0);
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
        // Sample the four wheel corners. Updates _cornerSamplesScratch[] in place
        // instead of allocating fresh objects + .map/.filter chains every frame.
        // Layout: [FL, FR, RL, RR] matches the original code.
        const cornerSamples = _cornerSamplesScratch;
        cornerSamples[0].forward = halfWheelBase;  cornerSamples[0].sideways = -halfTrackWidth;
        cornerSamples[1].forward = halfWheelBase;  cornerSamples[1].sideways =  halfTrackWidth;
        cornerSamples[2].forward = -halfWheelBase; cornerSamples[2].sideways = -halfTrackWidth;
        cornerSamples[3].forward = -halfWheelBase; cornerSamples[3].sideways =  halfTrackWidth;
        let _contactCount = 0;
        let _maxContactCompression = 0;
        let _maxContactGroundHeight = Number.NEGATIVE_INFINITY;
        let _anyContact = false;
        const contactMaxRide = VEHICLE_SETTINGS.suspensionRideHeight + VEHICLE_SETTINGS.suspensionTravel;
        for (let ci = 0; ci < 4; ci++) {
            const corner = cornerSamples[ci];
            const cf = corner.forward;
            const cs = corner.sideways;
            const sampleX = vehiclePosition.x + flatForward.x * cf + flatRight.x * cs;
            const sampleZ = vehiclePosition.z + flatForward.z * cf + flatRight.z * cs;
            const sampleAnchorY = vehiclePosition.y + vehicleForward.y * cf + vehicleRight.y * cs;
            const groundHeight = getGroundHeightAt(sampleX, sampleZ, true, {
                ignoreActor: vehicle,
                minSurfaceUpDot: 0.35,
                surfaceStepTolerance: 0,
                cullBackFaces: true,
                maxHitY: sampleAnchorY + 0.05,
            });
            const rideHeight = groundHeight === null ? null : vehiclePosition.y - groundHeight;
            rideState.sampleRideHeights[ci] = rideHeight;
            corner.rideHeight = rideHeight;
            const compression = rideHeight === null
                ? 0
                : THREE.MathUtils.clamp(VEHICLE_SETTINGS.suspensionRideHeight - rideHeight, 0, VEHICLE_SETTINGS.suspensionTravel);
            corner.compression = compression;
            if (rideHeight !== null && rideHeight <= contactMaxRide) {
                _contactCount++;
                _anyContact = true;
                if (compression > _maxContactCompression) _maxContactCompression = compression;
                const gh = vehiclePosition.y - rideHeight;
                if (gh > _maxContactGroundHeight) _maxContactGroundHeight = gh;
            }
        }
        const grounded = _contactCount > 0;
        const contactRatio = _contactCount / 4;
        const averageCompression = _contactCount ? _maxContactCompression : 0;
        const averageGroundHeight = _anyContact ? _maxContactGroundHeight : null;
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
        const rearWheelWorldPositions = _rearWheelScratchOut;
        rearWheelWorldPositions.length = 0;
        if (vehicleVisualState?.steeringPivots?.length >= 4) {
            const forwardOffset = VEHICLE_SETTINGS.wheelBase * 0.18;
            for (let i = 2; i < 4; i++) {
                const pivot = vehicleVisualState.steeringPivots[i];
                if (!pivot?.isObject3D) { rearWheelWorldPositions.push(null); continue; }
                const wheelPos = _rearWheelScratch[i - 2];
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
            noTracks: !!vehicle.userData?.noTracks,   // cars flagged to leave no skid marks
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

            // Update score
            if (window.gameScore !== undefined) {
                // Add points for driving

                // Bonus points for high speed
                if (forwardSpeed > 15) {
                }

                window.exampleWidgets.score?.SetText(`Score: ${Math.floor(window.gameScore)}`);
            }
        }

        if (vehiclePosition.y < core.worldFloor.position.y - 24) {
            exitVehicle();
            respawnPlayer(true);
            return;
        }
    }

    // Reused per-call hits buffer for getGroundHitAt; cleared on entry. Caller
    // must consume the result synchronously.
    const _groundHits = [];
    const _groundHitNormal = new THREE.Vector3();
    function getGroundHitAt(x, z, includeFloor = true, options = {}) {
        const {
            ignoreActor = null,
            ignoreActors = null,
            targetObjects = null,
            minSurfaceUpDot = Number.NEGATIVE_INFINITY,
            surfaceStepTolerance = 0,
            cullBackFaces = false,
            maxHitY = Number.POSITIVE_INFINITY,
            hitFilter = null,
        } = options;
        const ignoredActors = Array.isArray(ignoreActors) ? new Set(ignoreActors.filter(Boolean)) : null;
        const originY = Math.max(PLAYER_SETTINGS.probeHeight, gameplayBounds.max.y + PLAYER_SETTINGS.probeHeight);
        const hits = _groundHits;
        hits.length = 0;
        const previousRaycasterCamera = raycaster.camera;

        raycaster.set(tempVectorA.set(x, originY, z), downVector);
        if (core.camera) raycaster.camera = core.camera;

        if (Array.isArray(targetObjects)) {
            if (targetObjects.length > 0) {
                raycaster.intersectObjects(targetObjects, true, hits);
            }
        } else {
            if (core.currentMesh) {
                raycaster.intersectObject(core.currentMesh, true, hits);
            }

            if (core.sceneSystem?.actors?.size) {
                for (const actor of core.sceneSystem.actors) {
                    if (!actor || actor === ignoreActor || ignoredActors?.has(actor)) continue;

                    const actorMesh = getActorRenderObject(actor);
                    if (!actorMesh) continue;

                    raycaster.intersectObject(actorMesh, true, hits);
                }
            }
        }

        if (includeFloor && core.worldFloor && !core.currentMesh?.userData?.hideTerrainPresentation) {
            const terrainHeight = sampleTerrainHeightAt(x, z);
            if (terrainHeight !== null && originY >= terrainHeight) {
                hits.push({
                    distance: originY - terrainHeight,
                    point: new THREE.Vector3(x, terrainHeight, z),
                    object: core.worldFloor,
                });
            }
        }

        const solidHits = hits.filter((hit) => !hit?.object?.isSprite);

        // Optional strict back-face cull: drop hits whose triangle faces away
        // from the ray direction (i.e. faces below the trace look down). Used by
        // car-related ground tracing so a slight overlap between two stitched
        // road segments can't surface a back-face hit and put the car at the
        // wrong Y.
        const backFaceCulledHits = cullBackFaces
            ? solidHits.filter((hit) => {
                if (!hit?.face || !hit.object?.matrixWorld) {
                    return true;
                }
                _groundHitNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
                return _groundHitNormal.y > 1e-4;
            })
            : solidHits;

        const heightFilteredHits = Number.isFinite(maxHitY)
            ? backFaceCulledHits.filter((hit) => (hit?.point?.y ?? Number.NEGATIVE_INFINITY) <= maxHitY)
            : backFaceCulledHits;

        const filteredHits = minSurfaceUpDot > Number.NEGATIVE_INFINITY
            ? heightFilteredHits.filter((hit) => {
                if (!hit?.face || !hit.object?.matrixWorld) {
                    return true;
                }

                _groundHitNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
                return _groundHitNormal.y >= minSurfaceUpDot;
            })
            : heightFilteredHits;

        const resolvedHits = filteredHits.length > 0
            ? filteredHits
            : (cullBackFaces ? heightFilteredHits : solidHits);

        const candidateHits = typeof hitFilter === 'function'
            ? resolvedHits.filter((hit) => hitFilter(hit))
            : resolvedHits;

        candidateHits.sort((a, b) => a.distance - b.distance);
        let resolvedHit = candidateHits[0] || null;
        if (resolvedHit && surfaceStepTolerance > 0) {
            for (let index = 1; index < candidateHits.length; index += 1) {
                const candidateHit = candidateHits[index];
                if (!candidateHit?.point || !resolvedHit?.point) continue;

                const verticalGap = resolvedHit.point.y - candidateHit.point.y;
                if (verticalGap > 0 && verticalGap <= surfaceStepTolerance) {
                    resolvedHit = candidateHit;
                    continue;
                }

                break;
            }
        }

        updateRaycasterDebugLine(
            raycaster.ray,
            resolvedHit?.distance ?? originY,
            resolvedHit?.point ?? null,
            !!resolvedHit,
        );
        raycaster.camera = previousRaycasterCamera;
        return resolvedHit;
    }

    function getGroundHeightAt(x, z, includeFloor = true, options = {}) {
        const hit = getGroundHitAt(x, z, includeFloor, options);
        return hit ? hit.point.y : null;
    }

    const _resolveHorizontalProbeHeights = [0.35, 0.75]; // multipliers of eyeHeight
    const _resolveHorizontalHits = [];
    const _wallNormalScratch = new THREE.Vector3();
    function resolveHorizontalMovement(origin, movementDelta) {
        if (!core.currentMesh || movementDelta.lengthSq() === 0) {
            return movementDelta;
        }

        const adjustedMovement = movementDelta.clone();
        const direction = tempVectorA.copy(movementDelta).normalize();
        const eyeHeight = PLAYER_SETTINGS.eyeHeight;
        const maxDistance = movementDelta.length() + PLAYER_SETTINGS.collisionRadius;

        for (let i = 0; i < _resolveHorizontalProbeHeights.length; i++) {
            const rayOrigin = tempVectorB.copy(origin);
            rayOrigin.y += _resolveHorizontalProbeHeights[i] * eyeHeight - eyeHeight;

            raycaster.set(rayOrigin, direction);
            raycaster.far = maxDistance;

            const hits = _resolveHorizontalHits;
            hits.length = 0;
            raycaster.intersectObject(core.currentMesh, true, hits);
            // raycaster.far filters distance already; first hit is the nearest in-range one.
            const hit = hits.length > 0 ? hits[0] : null;
            updateRaycasterDebugLine(
                raycaster.ray,
                maxDistance,
                hit?.point ?? null,
                !!hit,
            );
            hits.length = 0;

            if (!hit || !hit.face) continue;

            const wallNormal = _wallNormalScratch.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
            if (wallNormal.y > 0.6) continue;

            adjustedMovement.projectOnPlane(wallNormal);
            adjustedMovement.addScaledVector(wallNormal, PLAYER_SETTINGS.wallClearance);
        }

        raycaster.far = Infinity;
        return adjustedMovement;
    }

    return {
        updateHelicopterGameplay, updateVehicleGameplay, getGroundHitAt,
        getGroundHeightAt, resolveHorizontalMovement,
    };
}
