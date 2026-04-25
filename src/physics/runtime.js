import * as THREE from 'three';

export function createPhysicsRuntime({
    physics,
    gameplay,
    playerSettings,
    getCamera,
    getWorldFloor,
    copyJoltVector,
    copyJoltQuaternion,
    createOwnedShape,
    onRemoveDynamicProp,
    onCollisionScriptsUpdate,
    onCollisionStepsChange,
}) {
    const tempVectorA = new THREE.Vector3();

    function destroyPlayerCharacter() {
        if (!physics.character) return;

        physics.Jolt.destroy(physics.character);
        physics.character = null;

        if (physics.characterListener) {
            physics.Jolt.destroy(physics.characterListener);
            physics.characterListener = null;
        }

        if (physics.characterShape) {
            physics.characterShape.Release();
            physics.characterShape = null;
        }
    }

    function ensurePlayerCharacter() {
        if (!physics.ready) return;

        destroyPlayerCharacter();

        const { Jolt, physicsSystem } = physics;
        const characterRadius = Math.max(0.3, playerSettings.collisionRadius * 0.55);
        const characterHeight = Math.max(0.6, playerSettings.eyeHeight - characterRadius * 1.2);
        const shapeOffset = new Jolt.Vec3(0, 0.5 * characterHeight + characterRadius, 0);
        const shapeRotation = Jolt.Quat.prototype.sIdentity();
        const shapeSettings = new Jolt.RotatedTranslatedShapeSettings(
            shapeOffset,
            shapeRotation,
            new Jolt.CapsuleShapeSettings(0.5 * characterHeight, characterRadius)
        );
        physics.characterShape = createOwnedShape(shapeSettings);
        Jolt.destroy(shapeOffset);

        const characterSettings = new Jolt.CharacterVirtualSettings();
        characterSettings.mMass = 80;
        characterSettings.mMaxStrength = 100;
        characterSettings.mShape = physics.characterShape;
        characterSettings.mBackFaceMode = Jolt.EBackFaceMode_CollideWithBackFaces;
        characterSettings.mPredictiveContactDistance = 0.1;
        characterSettings.mCharacterPadding = 0.02;
        characterSettings.mPenetrationRecoverySpeed = 1.0;

        const spawnPosition = new Jolt.RVec3(
            gameplay.spawnPoint.x,
            gameplay.spawnPoint.y,
            gameplay.spawnPoint.z
        );
        physics.character = new Jolt.CharacterVirtual(
            characterSettings,
            spawnPosition,
            shapeRotation,
            physicsSystem
        );
        Jolt.destroy(characterSettings);
        Jolt.destroy(spawnPosition);

        physics.characterListener = new Jolt.CharacterContactListenerJS();
        physics.characterListener.OnAdjustBodyVelocity = () => {};
        physics.characterListener.OnContactValidate = () => true;
        physics.characterListener.OnCharacterContactValidate = () => true;
        physics.characterListener.OnContactAdded = () => {};
        physics.characterListener.OnContactPersisted = () => {};
        physics.characterListener.OnContactRemoved = () => {};
        physics.characterListener.OnCharacterContactAdded = () => {};
        physics.characterListener.OnCharacterContactPersisted = () => {};
        physics.characterListener.OnCharacterContactRemoved = () => {};
        physics.characterListener.OnCharacterContactSolve = () => {};
        physics.characterListener.OnContactSolve = (_character, _bodyID2, _subShapeID2, _contactPosition, contactNormal, contactVelocity, _contactMaterial, _characterVelocity, newCharacterVelocity) => {
            const normal = Jolt.wrapPointer(contactNormal, Jolt.Vec3);
            const velocity = Jolt.wrapPointer(contactVelocity, Jolt.Vec3);
            const nextVelocity = Jolt.wrapPointer(newCharacterVelocity, Jolt.Vec3);

            if (!physics.allowSliding && velocity.IsNearZero() && !physics.character.IsSlopeTooSteep(normal)) {
                nextVelocity.SetX(0);
                nextVelocity.SetY(0);
                nextVelocity.SetZ(0);
            }
        };
        physics.character.SetListener(physics.characterListener);
    }

    function syncDynamicPhysicsBodies() {
        const worldFloor = getWorldFloor?.();
        if (!physics.dynamicBodies.length || !worldFloor) return;

        for (let index = physics.dynamicBodies.length - 1; index >= 0; index--) {
            const prop = physics.dynamicBodies[index];
            if (!prop?.body || !prop.mesh) continue;

            copyJoltVector(prop.mesh.position, prop.body.GetPosition());
            copyJoltQuaternion(prop.mesh.quaternion, prop.body.GetRotation());

            if (prop.mesh.position.y < worldFloor.position.y - 40) {
                onRemoveDynamicProp?.(prop, index);
            }
        }
    }

    function syncCameraToCharacter() {
        if (!physics.character) return;

        const camera = getCamera?.();
        if (!camera) return;

        const position = copyJoltVector(tempVectorA, physics.character.GetPosition());
        camera.position.set(position.x, position.y + playerSettings.eyeHeight, position.z);
    }

    function stepPhysics(delta) {
        if (!physics.ready || !physics.jolt) {
            return {
                total: 0,
                step: 0,
                sync: 0,
                collisions: 0,
            };
        }

        const collisionSteps = delta > 1 / 55 ? 2 : 1;
        onCollisionStepsChange?.(collisionSteps);

        const stepStart = performance.now();
        physics.jolt.Step(delta, collisionSteps);
        const stepDuration = performance.now() - stepStart;

        const syncStart = performance.now();
        syncDynamicPhysicsBodies();
        const syncDuration = performance.now() - syncStart;

        const collisionsStart = performance.now();
        onCollisionScriptsUpdate?.();
        const collisionsDuration = performance.now() - collisionsStart;

        return {
            total: stepDuration + syncDuration + collisionsDuration,
            step: stepDuration,
            sync: syncDuration,
            collisions: collisionsDuration,
        };
    }

    return {
        destroyPlayerCharacter,
        ensurePlayerCharacter,
        syncDynamicPhysicsBodies,
        syncCameraToCharacter,
        stepPhysics,
    };
}
