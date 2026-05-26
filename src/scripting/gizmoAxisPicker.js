// Unreal-style gizmo center region.
//
// TransformControls only starts a drag if `axis` is set by its picker raycast on
// pointer-hover. The native picker still catches DIRECT hits on the axis arrows /
// rings (its picker meshes raycast regardless of the hidden helper). We wrap
// `pointerHover` so that when the cursor lands inside the gizmo's center "sphere"
// but NOT on a handle, we set the mode-appropriate combined axis:
//   translate → 'XYZ'  (screen-plane move, like Unreal's center square)
//   rotate    → 'XYZE' (free trackball: rotation axis = drag × eye)
//   scale     → 'XYZ'  (uniform scale)
// onPointerDown runs pointerHover then pointerDown on the SAME event, so setting
// `axis` here is enough to begin the drag. (TransformControls.js:1007-1008)
import * as THREE from 'three';

// Center-region radius as a fraction of the gizmo's screen size. Matches the
// translate-mode feel of isTransformControlSphereHit.
const SPHERE_RADIUS_SCALE = 1.5;

const CENTER_AXIS_FOR_MODE = {
    translate: 'XYZ',
    rotate: 'XYZE',
    scale: 'XYZ',
};

/**
 * Patch `transformControl.pointerHover` so the gizmo's center sphere drives
 * screen-plane translate / trackball rotate / uniform scale.
 * @param {Object} deps - { transformControl, camera, raycaster }
 */
export function installGizmoAxisPicker({ transformControl, camera, raycaster }) {
    const centerWorld = new THREE.Vector3();

    const withinSphere = (pointer) => {
        const object = transformControl.object;
        if (!object) return false;
        object.getWorldPosition(centerWorld);
        raycaster.setFromCamera(pointer, camera);
        const cameraDistance = camera.position.distanceTo(centerWorld);
        const radius = Math.max(0.8, cameraDistance * 0.085 * (transformControl.size || 1) * SPHERE_RADIUS_SCALE);
        return raycaster.ray.distanceSqToPoint(centerWorld) <= radius * radius;
    };

    const orig = transformControl.pointerHover.bind(transformControl);
    transformControl.pointerHover = (pointer) => {
        orig(pointer);
        // Native picker already grabbed a handle/ring → leave it.
        if (transformControl.axis != null || !transformControl.object || !pointer) return;
        const centerAxis = CENTER_AXIS_FOR_MODE[transformControl.mode];
        if (centerAxis && withinSphere(pointer)) {
            transformControl.axis = centerAxis;
        }
    };
}
