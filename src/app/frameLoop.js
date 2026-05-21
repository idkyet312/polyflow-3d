// Per-frame gameplay loop pieces lifted from runtime.js. All hot — called
// from the main animation tick. Pure: every dep injected, no module-scope
// state.
//
// Owns:
//   - updateShowcaseCamera: editor free-fly camera advance
//   - applyGameplayCameraRotation: player camera + recoil offset
//   - applyCameraRecoil: kick accumulator
//   - respawnPlayer: kill + respawn flow
//   - updateGameplay: per-tick character-controller drive + post-physics
//                     housekeeping (level state, prefabs, fall-through resp)

export function createFrameLoop(deps) {
    const {
        THREE,
        camera, currentMesh, worldFloor,
        physics,
        gameplay, gameplayLookTarget, showcase,
        PLAYER_SETTINGS,
        upVector,
        tempVectorA, tempVectorB, tempVectorC, tempVectorD, tempVectorE, tempVectorF,
        copyJoltVector,
        isDrivingVehicle,
        updateVehicleGameplay,
        silenceVehicleEngineAudio, updateEngineAudioDebugOverlay,
        syncCameraToCharacter,
        ensurePlayerCharacter,
        resetGameplayPrefabs,
        clearActiveVehicle,
        updateDoomMiniLevelState, updateDoomArenaLevelState,
        updateRogueXpOrbs,
        processGameplayPrefabs,
        updateGameplayUI,
        resetDoomMiniLevelState, resetDoomArenaLevelState,
    } = deps;

    function updateShowcaseCamera(delta) {
        const cam = camera();
        const moveRight = (showcase.input.right ? 1 : 0) - (showcase.input.left ? 1 : 0);
        const moveForward = (showcase.input.forward ? 1 : 0) - (showcase.input.back ? 1 : 0);
        const moveVertical = (showcase.input.up ? 1 : 0) - (showcase.input.down ? 1 : 0);

        tempVectorA.set(0, 0, 0);
        cam.getWorldDirection(tempVectorB);
        if (tempVectorB.lengthSq() < 1e-6) tempVectorB.set(0, 0, -1);
        else tempVectorB.normalize();

        tempVectorC.crossVectors(tempVectorB, upVector).normalize();

        tempVectorA
            .addScaledVector(tempVectorC, moveRight)
            .addScaledVector(tempVectorB, moveForward)
            .addScaledVector(upVector, moveVertical);

        if (tempVectorA.lengthSq() > 0) tempVectorA.normalize();

        const moveSpeed = showcase.moveSpeed * (showcase.input.boost ? showcase.boostMultiplier : 1);
        showcase.velocity.lerp(
            tempVectorA.multiplyScalar(moveSpeed),
            tempVectorA.lengthSq() > 0 ? 0.35 : 0.18,
        );

        if (showcase.velocity.lengthSq() < 1e-5) {
            showcase.velocity.set(0, 0, 0);
            return;
        }
        cam.position.addScaledVector(showcase.velocity, delta);
    }

    function applyGameplayCameraRotation() {
        const cam = camera();
        cam.rotation.order = 'YXZ';
        // recoilPitch/recoilYaw are transient kick offsets (set by weapon scripts
        // via api.applyCameraRecoil, decayed each frame in updatePlayerHitFeedback).
        cam.rotation.x = gameplay.pitch + (gameplay.recoilPitch || 0);
        cam.rotation.y = gameplay.yaw + (gameplay.recoilYaw || 0);
        cam.rotation.z = 0;
    }

    // Kick the camera by `pitch`/`yaw` radians (recoil). Additive, decays back to
    // zero. Exposed for weapon user scripts. Positive pitch = muzzle climbs up.
    function applyCameraRecoil(pitch = 0, yaw = 0) {
        gameplay.recoilPitch += Number(pitch) || 0;
        gameplay.recoilYaw += Number(yaw) || 0;
    }

    function respawnPlayer(useStoredView = false) {
        if (!gameplay.canPlay && physics.ready) gameplay.canPlay = true;
        if (!gameplay.canPlay) return;

        if (gameplay.respawnTimer) {
            clearTimeout(gameplay.respawnTimer);
            gameplay.respawnTimer = null;
        }
        gameplay.dead = false;
        gameplay.lastDamageAt = 0;
        resetGameplayPrefabs();
        // Re-arm the Doom wave state machine so killed enemies return on
        // respawn (no-op on every non-doomTest level via its own guard).
        resetDoomMiniLevelState();
        resetDoomArenaLevelState();

        if (isDrivingVehicle()) clearActiveVehicle();

        if (!physics.character) ensurePlayerCharacter();
        if (!physics.character) return;

        const spawnPosition = new physics.Jolt.RVec3(
            gameplay.spawnPoint.x,
            gameplay.spawnPoint.y,
            gameplay.spawnPoint.z,
        );
        physics.character.SetPosition(spawnPosition);
        physics.Jolt.destroy(spawnPosition);
        physics.character.SetLinearVelocity(physics.Jolt.Vec3.prototype.sZero());
        gameplay.velocity.set(0, 0, 0);
        gameplay.grounded = true;

        if (useStoredView) {
            gameplay.yaw = gameplay.spawnYaw;
            gameplay.pitch = gameplay.spawnPitch;
        }

        syncCameraToCharacter();

        if (!useStoredView) {
            const cam = camera();
            tempVectorA.copy(gameplayLookTarget).sub(cam.position);
            const flatDistance = Math.max(0.001, Math.hypot(tempVectorA.x, tempVectorA.z));
            gameplay.yaw = Math.atan2(tempVectorA.x, tempVectorA.z);
            gameplay.pitch = THREE.MathUtils.clamp(
                Math.atan2(-tempVectorA.y, flatDistance),
                -PLAYER_SETTINGS.maxLookPitch,
                PLAYER_SETTINGS.maxLookPitch,
            );
            gameplay.spawnYaw = gameplay.yaw;
            gameplay.spawnPitch = gameplay.pitch;
        }

        applyGameplayCameraRotation();
        updateGameplayUI();
    }

    function updateGameplay(delta) {
        if (isDrivingVehicle()) {
            updateVehicleGameplay(delta);
            return;
        }

        silenceVehicleEngineAudio();
        updateEngineAudioDebugOverlay('idle', null, null);

        if (!physics.character) return;

        const cam = camera();
        const moveRight = (gameplay.input.right ? 1 : 0) - (gameplay.input.left ? 1 : 0);
        const moveForward = (gameplay.input.forward ? 1 : 0) - (gameplay.input.back ? 1 : 0);
        const moveSpeed = (gameplay.input.sprint ? PLAYER_SETTINGS.sprintSpeed : PLAYER_SETTINGS.walkSpeed)
            * ((typeof window !== 'undefined' && window.rogueBuffs?.moveSpeed) || 1);
        const wasGrounded = gameplay.grounded;

        tempVectorA.set(0, 0, 0);
        if (moveRight !== 0 || moveForward !== 0) {
            cam.getWorldDirection(tempVectorB);
            tempVectorB.y = 0;
            if (tempVectorB.lengthSq() < 1e-6) tempVectorB.set(0, 0, -1);
            else tempVectorB.normalize();

            tempVectorC.crossVectors(tempVectorB, upVector).normalize();

            tempVectorA
                .addScaledVector(tempVectorC, moveRight)
                .addScaledVector(tempVectorB, moveForward);

            if (tempVectorA.lengthSq() > 0) tempVectorA.normalize().multiplyScalar(moveSpeed);
        }

        const desiredMovement = tempVectorE.copy(tempVectorA);

        physics.character.UpdateGroundVelocity();

        const linearVelocity = copyJoltVector(tempVectorB, physics.character.GetLinearVelocity());
        const currentVerticalVelocity = tempVectorC.copy(upVector).multiplyScalar(linearVelocity.dot(upVector));
        const currentHorizontalVelocity = tempVectorD.copy(linearVelocity).sub(currentVerticalVelocity);
        const groundVelocity = copyJoltVector(tempVectorA, physics.character.GetGroundVelocity());

        const onGround = physics.character.IsSupported();
        const movingTowardsGround = currentVerticalVelocity.y - groundVelocity.y <= 0.1;
        physics.allowSliding = desiredMovement.lengthSq() > 1e-8;

        const nextVelocity = tempVectorF;
        if (onGround && movingTowardsGround) {
            nextVelocity.copy(groundVelocity);
            if (physics.jumpQueued) nextVelocity.y += PLAYER_SETTINGS.jumpSpeed;
        } else {
            nextVelocity.copy(currentVerticalVelocity);
        }

        nextVelocity.addScaledVector(copyJoltVector(tempVectorC, physics.gravity), delta);

        if (physics.allowSliding) {
            physics.desiredVelocity.lerp(desiredMovement, onGround ? 0.32 : 0.12);
            nextVelocity.add(physics.desiredVelocity);
        } else if (!onGround) {
            nextVelocity.add(currentHorizontalVelocity);
            physics.desiredVelocity.multiplyScalar(0.92);
        } else {
            physics.desiredVelocity.multiplyScalar(0.2);
        }

        const nextVelocityJolt = new physics.Jolt.Vec3(nextVelocity.x, nextVelocity.y, nextVelocity.z);
        physics.character.SetLinearVelocity(nextVelocityJolt);
        physics.Jolt.destroy(nextVelocityJolt);
        physics.character.ExtendedUpdate(
            delta,
            physics.gravity,
            physics.updateSettings,
            physics.movingBroadPhaseFilter,
            physics.movingLayerFilter,
            physics.bodyFilter,
            physics.shapeFilter,
            physics.jolt.GetTempAllocator(),
        );

        syncCameraToCharacter();
        applyGameplayCameraRotation();
        gameplay.grounded = physics.character.IsSupported();
        physics.jumpQueued = false;

        const characterPosition = copyJoltVector(tempVectorA, physics.character.GetPosition());
        const floor = worldFloor();
        if (floor && characterPosition.y < floor.position.y - 24) respawnPlayer();

        updateDoomMiniLevelState(characterPosition);
        updateDoomArenaLevelState(characterPosition);
        const mesh = currentMesh();
        if (mesh?.userData?.sampleType === 'doomArena') {
            updateRogueXpOrbs(characterPosition, delta);
        }
        processGameplayPrefabs();

        if (wasGrounded !== gameplay.grounded) updateGameplayUI();
    }

    return {
        updateShowcaseCamera,
        applyGameplayCameraRotation,
        applyCameraRecoil,
        respawnPlayer,
        updateGameplay,
    };
}
