// Actor transform + subject/trigger helpers lifted from runtime.js.
//
// Owns: stored-transform store on actor userData, body↔mesh sync, teleport
// helpers for active player/vehicle subject and arbitrary actors, subject
// position lookup, trigger-volume hit test + dispatch.
//
// Pure logic. All engine refs injected via the deps argument so the module
// has zero module-scope state and can be smoke-tested.

export function createActorTransforms(deps) {
    const {
        physics, dynamicBodySpatial,
        gameplay,
        PLAYER_SETTINGS,
        tempVectorA, tempVectorB,
        copyJoltVector,
        getActorRenderObject, getActorBody,
        isDrivingVehicle, getActiveVehicleProp,
        syncCameraToCharacter,
        dispatchTriggerEvent,
        resetTaaHistory,
    } = deps;

    function setActorResetTransform(actor, position, quaternion = null) {
        if (!actor || !Array.isArray(position)) return actor;
        actor.userData = {
            ...(actor.userData || {}),
            resetTransform: {
                position: [...position],
                quaternion: quaternion
                    ? [quaternion.x, quaternion.y, quaternion.z, quaternion.w]
                    : null,
            },
        };
        return actor;
    }

    function syncActorBodyToRenderTransform(actor, activation = null) {
        const mesh = getActorRenderObject(actor);
        const body = getActorBody(actor);
        if (!mesh || !body || !physics.ready) return false;

        const pos = new physics.Jolt.RVec3(mesh.position.x, mesh.position.y, mesh.position.z);
        const rot = new physics.Jolt.Quat(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w);
        physics.bodyInterface.SetPositionAndRotation(
            body.GetID(), pos, rot,
            activation ?? physics.Jolt.EActivation_DontActivate,
        );
        physics.Jolt.destroy(pos);
        physics.Jolt.destroy(rot);
        return true;
    }

    function resetActorToStoredTransform(actor) {
        const reset = actor?.userData?.resetTransform;
        const mesh = getActorRenderObject(actor);
        if (!reset || !mesh) return false;

        mesh.position.fromArray(reset.position);
        if (Array.isArray(reset.quaternion)) mesh.quaternion.fromArray(reset.quaternion);
        mesh.visible = actor.userData?.gameplayPrefab !== 'playerSpawn' || !gameplay.active;
        mesh.updateMatrixWorld(true);

        const body = getActorBody(actor);
        if (body && physics.ready) {
            syncActorBodyToRenderTransform(actor, physics.Jolt.EActivation_Activate);
            if (physics.dynamicBodies.includes(actor)) {
                physics.bodyInterface.SetLinearVelocity(body.GetID(), physics.Jolt.Vec3.prototype.sZero());
                physics.bodyInterface.SetAngularVelocity(body.GetID(), physics.Jolt.Vec3.prototype.sZero());
                dynamicBodySpatial.updateEntry(actor);
            }
        }
        return true;
    }

    function teleportActiveGameplaySubject(destination) {
        if (!destination) return false;
        if (isDrivingVehicle()) {
            const vehicle = getActiveVehicleProp();
            const body = getActorBody(vehicle);
            if (!vehicle || !body || !physics.ready) return false;
            const pos = new physics.Jolt.RVec3(destination.x, destination.y + 0.75, destination.z);
            const rot = physics.bodyInterface.GetRotation(body.GetID());
            physics.bodyInterface.SetPositionAndRotation(body.GetID(), pos, rot, physics.Jolt.EActivation_Activate);
            physics.bodyInterface.SetLinearVelocity(body.GetID(), physics.Jolt.Vec3.prototype.sZero());
            physics.bodyInterface.SetAngularVelocity(body.GetID(), physics.Jolt.Vec3.prototype.sZero());
            physics.Jolt.destroy(pos);
            const mesh = getActorRenderObject(vehicle);
            if (mesh) mesh.position.set(destination.x, destination.y + 0.75, destination.z);
            resetTaaHistory?.();
            return true;
        }

        if (!physics.character) return false;
        const pos = new physics.Jolt.RVec3(destination.x, destination.y + PLAYER_SETTINGS.floorOffset, destination.z);
        physics.character.SetPosition(pos);
        physics.character.SetLinearVelocity(physics.Jolt.Vec3.prototype.sZero());
        physics.Jolt.destroy(pos);
        syncCameraToCharacter();
        resetTaaHistory?.();
        return true;
    }

    function teleportActorTo(actor, destination) {
        if (!actor || !destination || actor.userData?.gameplayPrefab) return false;
        const mesh = getActorRenderObject(actor);
        if (!mesh) return false;

        mesh.position.set(destination.x, destination.y + 0.75, destination.z);
        mesh.updateMatrixWorld(true);

        const body = getActorBody(actor);
        if (body && physics.ready) {
            const pos = new physics.Jolt.RVec3(mesh.position.x, mesh.position.y, mesh.position.z);
            const rot = new physics.Jolt.Quat(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w);
            physics.bodyInterface.SetPositionAndRotation(body.GetID(), pos, rot, physics.Jolt.EActivation_Activate);
            physics.bodyInterface.SetLinearVelocity(body.GetID(), physics.Jolt.Vec3.prototype.sZero());
            physics.bodyInterface.SetAngularVelocity(body.GetID(), physics.Jolt.Vec3.prototype.sZero());
            physics.Jolt.destroy(pos);
            physics.Jolt.destroy(rot);
            dynamicBodySpatial.updateEntry(actor);
        }
        return true;
    }

    function getGameplaySubjectPosition(target = tempVectorA) {
        if (isDrivingVehicle()) {
            const vehicle = getActiveVehicleProp();
            const body = getActorBody(vehicle);
            if (!body || !physics.ready) return null;
            return copyJoltVector(target, physics.bodyInterface.GetPosition(body.GetID()));
        }
        if (!physics.character) return null;
        return copyJoltVector(target, physics.character.GetPosition());
    }

    function isSubjectInsideTrigger(subjectPosition, actor) {
        const mesh = getActorRenderObject(actor);
        if (!mesh || actor?.userData?.collected) return false;
        mesh.updateMatrixWorld(true);
        mesh.getWorldPosition(tempVectorB);
        const radius = Number(actor.userData?.triggerRadius ?? mesh.userData?.triggerRadius ?? 1.2);
        const dx = subjectPosition.x - tempVectorB.x;
        const dz = subjectPosition.z - tempVectorB.z;
        const dy = Math.abs(subjectPosition.y - tempVectorB.y);
        return dx * dx + dz * dz <= radius * radius && dy <= 2.25;
    }

    function dispatchTriggerForActor(prop, subjectPosition, subject) {
        if (!prop) return false;
        const mesh = getActorRenderObject(prop);
        if (!mesh) return false;
        const inside = isSubjectInsideTrigger(subjectPosition, prop);
        const wasInside = !!prop.userData?._wasInsideTrigger;
        if (inside !== wasInside) {
            console.log('[trig]', prop.id, prop.userData?.gameplayPrefab,
                'in=', inside, 'was=', wasInside,
                'visible=', mesh.visible,
                'handles=', Object.keys(prop.scripts?.tick?.handles || {}).length);
        }
        if (inside === wasInside) return inside;
        const handles = prop.scripts?.tick?.handles;
        const fnReady = typeof handles?.OnTrigger === 'function' || typeof handles?.OnTriggerExit === 'function';
        if (inside && !fnReady) {
            console.log('[trig]   defer', prop.userData?.gameplayPrefab);
            return inside;
        }
        prop.userData._wasInsideTrigger = inside;
        dispatchTriggerEvent(prop, subject, inside);
        return inside;
    }

    function hasScriptedTriggerHandler(prop) {
        const tick = prop?.scripts?.tick;
        if (!tick?.enabled) return false;
        const handles = tick.handles;
        if (typeof handles?.OnTrigger === 'function' || typeof handles?.OnTriggerExit === 'function') return true;
        // Handles populate asynchronously after first run — fall back to source check
        // so the engine doesn't run its default behavior before the script is ready.
        const source = tick.source || '';
        return /\bfunction\s+OnTrigger(Exit)?\s*\(/.test(source);
    }

    function hasScriptedTickHandler(prop) {
        const tick = prop?.scripts?.tick;
        if (!tick?.enabled) return false;
        if (typeof tick.handles?.Tick === 'function') return true;
        // Handles populate asynchronously — fall back to a source check so the
        // engine doesn't run its default fire before the script is ready.
        return /\bfunction\s+Tick\s*\(/.test(tick.source || '');
    }

    return {
        setActorResetTransform,
        syncActorBodyToRenderTransform,
        resetActorToStoredTransform,
        teleportActiveGameplaySubject,
        teleportActorTo,
        getGameplaySubjectPosition,
        isSubjectInsideTrigger,
        dispatchTriggerForActor,
        hasScriptedTriggerHandler,
        hasScriptedTickHandler,
    };
}
