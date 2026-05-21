// Showcase (editor) camera helpers: orbit-angle sync, GSAP-animated focus
// onto an actor / scene object, focus-frame solver. Used by the scene UI
// double-click handler and the actor-selection focus shortcut.

export function createShowcaseCamera(deps) {
    const {
        THREE, gsap,
        camera,
        showcase,
        gameplay, objectScriptState,
        PLAYER_SETTINGS,
        tempVectorA, tempBoxA,
        getActorRenderObject, getActorSelectionObject,
        getDynamicPropById,
    } = deps;

    function syncShowcaseAnglesToFaceTarget(target) {
        const cam = camera();
        tempVectorA.copy(target).sub(cam.position);
        const flatDistance = Math.max(0.001, Math.hypot(tempVectorA.x, tempVectorA.z));
        showcase.yaw = Math.atan2(-tempVectorA.x, -tempVectorA.z);
        showcase.pitch = THREE.MathUtils.clamp(
            Math.atan2(tempVectorA.y, flatDistance),
            -PLAYER_SETTINGS.maxLookPitch,
            PLAYER_SETTINGS.maxLookPitch,
        );
    }

    function syncShowcaseAnglesFromTarget(target) {
        syncShowcaseAnglesToFaceTarget(target);
    }

    function applyShowcaseCameraRotation() {
        const cam = camera();
        cam.rotation.order = 'YXZ';
        cam.rotation.x = showcase.pitch;
        cam.rotation.y = showcase.yaw;
        cam.rotation.z = 0;
    }

    function getObjectFocusFrame(object) {
        if (!object) return null;
        const cam = camera();

        tempBoxA.makeEmpty();
        tempBoxA.setFromObject(object, true);

        const targetPos = new THREE.Vector3();
        const size = new THREE.Vector3();

        if (tempBoxA.isEmpty()) {
            object.getWorldPosition(targetPos);
            size.setScalar(0.7);
        } else {
            tempBoxA.getCenter(targetPos);
            tempBoxA.getSize(size);
        }

        const radius = Math.max(size.length() * 0.5, 0.35);
        const vFov = THREE.MathUtils.degToRad(cam.fov || 45);
        const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * Math.max(cam.aspect || 1, 0.1));
        const fitFov = Math.max(0.1, Math.min(vFov, hFov));
        const distance = THREE.MathUtils.clamp(
            (radius / Math.sin(fitFov * 0.5)) * 1.65,
            Math.max(2.1, radius * 2.9),
            90,
        );

        const viewDir = new THREE.Vector3().subVectors(cam.position, targetPos);
        if (viewDir.lengthSq() < 0.0001) viewDir.set(1, 0.45, 1);
        viewDir.normalize();
        if (viewDir.y < 0.24) {
            viewDir.y = 0.34;
            viewDir.normalize();
        }

        return {
            target: targetPos,
            cameraPosition: targetPos.clone().addScaledVector(viewDir, distance),
        };
    }

    function focusShowcaseCameraOnObject(object, { duration = 0.6 } = {}) {
        const cam = camera();
        if (gameplay.active || !cam || !object) return;

        const frame = getObjectFocusFrame(object);
        if (!frame) return;

        showcase.velocity.set(0, 0, 0);
        gsap?.killTweensOf(cam.position);

        if (gsap) {
            gsap.to(cam.position, {
                x: frame.cameraPosition.x,
                y: frame.cameraPosition.y,
                z: frame.cameraPosition.z,
                duration,
                overwrite: true,
                ease: 'power2.out',
                onUpdate: () => {
                    syncShowcaseAnglesToFaceTarget(frame.target);
                    applyShowcaseCameraRotation();
                },
            });
        } else {
            cam.position.copy(frame.cameraPosition);
            syncShowcaseAnglesToFaceTarget(frame.target);
            applyShowcaseCameraRotation();
        }
    }

    function focusSceneActor(actor) {
        const actorMesh = getActorRenderObject(actor);
        if (gameplay.active || !actorMesh) return;
        focusShowcaseCameraOnObject(actorMesh);
    }

    function focusCurrentShowcaseSelection() {
        if (gameplay.active) return false;

        const actor = getDynamicPropById(objectScriptState.targetPropId);
        if (!actor) return false;

        const focusObject = getActorSelectionObject(actor);
        if (!focusObject) return false;

        focusShowcaseCameraOnObject(focusObject, { duration: 0.55 });
        return true;
    }

    return {
        syncShowcaseAnglesFromTarget,
        syncShowcaseAnglesToFaceTarget,
        applyShowcaseCameraRotation,
        getObjectFocusFrame,
        focusShowcaseCameraOnObject,
        focusSceneActor,
        focusCurrentShowcaseSelection,
    };
}
