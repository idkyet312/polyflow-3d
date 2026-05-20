import * as THREE from 'three';
import { core } from '../runtime/appCore.js';

// Debug visualization: raycast debug line + collision-overlay builders.
// Pure THREE construction over actor meshes; minimal coupling. Live engine
// refs (scene/sceneSystem) via appCore; rest injected via factory. All 10
// deps are hoisted functions or imports — safe for eager wiring at any site.
export function createDebugOverlays(deps) {
    const {
        collisionDebugState, raycastDebugState, tempVectorC,
        getActorComponentFlags, pushDebugConsoleLine,
        // hoisted-function deps the calls inside the span need:
        getActorRenderObject, getImportedTemplate, getVehicleVisualBounds,
        isObjectWithinRoot, markDDGISkipCapture,
    } = deps;

    function ensureRaycastDebugLine() {
        if (raycastDebugState.helper || !core.scene) return raycastDebugState.helper;

        const helper = new THREE.ArrowHelper(
            new THREE.Vector3(0, 0, -1),
            new THREE.Vector3(),
            1,
            0xef4444,
            0.35,
            0.18,
        );
        helper.name = 'raycast-debug-line';
        helper.renderOrder = 999;
        helper.line.renderOrder = 999;
        helper.cone.renderOrder = 999;
        helper.line.material.depthTest = false;
        helper.line.material.transparent = true;
        helper.line.material.opacity = 0.95;
        helper.line.material.toneMapped = false;
        helper.cone.material.depthTest = false;
        helper.cone.material.transparent = true;
        helper.cone.material.opacity = 0.95;
        helper.cone.material.toneMapped = false;
        helper.visible = false;
        markDDGISkipCapture(helper);
        core.scene.add(helper);

        const hitMarker = new THREE.Mesh(
            new THREE.SphereGeometry(0.08, 14, 10),
            new THREE.MeshBasicMaterial({
                color: 0xef4444,
                transparent: true,
                opacity: 0.95,
                depthTest: false,
                toneMapped: false,
            })
        );
        hitMarker.name = 'raycast-debug-hit';
        hitMarker.renderOrder = 1000;
        hitMarker.visible = false;
        markDDGISkipCapture(hitMarker);
        core.scene.add(hitMarker);

        raycastDebugState.helper = helper;
        raycastDebugState.hitMarker = hitMarker;
        return helper;
    }

    function updateRaycastDebugLine(origin, direction, maxDist, hitPoint = null, hit = false) {
        if (!raycastDebugState.enabled) {
            return;
        }

        const helper = ensureRaycastDebugLine();
        const distance = Number.isFinite(maxDist) && maxDist >undefined? maxDist : 0;
        const dx = Number(direction?.x);
        const dy = Number(direction?.y);
        const dz = Number(direction?.z);

        if (!helper || !Number.isFinite(distance) || ![dx, dy, dz].every(Number.isFinite)) {
            return;
        }

        raycastDebugState.points[0].set(
            Number(origin?.x) || 0,
            Number(origin?.y) || 0,
            Number(origin?.z) || 0,
        );

        if (hitPoint && Number.isFinite(hitPoint.x) && Number.isFinite(hitPoint.y) && Number.isFinite(hitPoint.z)) {
            raycastDebugState.points[1].set(hitPoint.x, hitPoint.y, hitPoint.z);
        } else {
            raycastDebugState.points[1].set(
                raycastDebugState.points[0].x + dx * distance,
                raycastDebugState.points[0].y + dy * distance,
                raycastDebugState.points[0].z + dz * distance,
            );
        }

        tempVectorC.subVectors(raycastDebugState.points[1], raycastDebugState.points[0]);
        const length = tempVectorC.length();
        if (length <= 1e-5) {
            helper.visible = false;
            if (raycastDebugState.hitMarker) {
                raycastDebugState.hitMarker.visible = false;
            }
            return;
        }

        const visibleLength = Math.max(length, 1.25);
        helper.position.copy(raycastDebugState.points[0]);
        helper.setDirection(tempVectorC.normalize());
        helper.setLength(
            visibleLength,
            Math.min(Math.max(visibleLength * 0.14, 0.25), 0.9),
            Math.min(Math.max(visibleLength * 0.07, 0.12), 0.38),
        );
        helper.setColor(hit ? 0x22c55e : 0xef4444);
        helper.visible = true;

        if (raycastDebugState.hitMarker) {
            raycastDebugState.hitMarker.position.copy(raycastDebugState.points[1]);
            raycastDebugState.hitMarker.material.color.set(hit ? 0x22c55e : 0xef4444);
            raycastDebugState.hitMarker.visible = true;
        }
        raycastDebugState.expiresAt = performance.now() + raycastDebugState.timeoutMs;
    }

    function updateRaycasterDebugLine(ray, maxDist, hitPoint = null, hit = false) {
        if (!ray) return;
        updateRaycastDebugLine(ray.origin, ray.direction, maxDist, hitPoint, hit);
    }

    function tickRaycastDebugLine() {
        if (!raycastDebugState.helper?.visible) return;
        if (performance.now() < raycastDebugState.expiresAt) return;
        raycastDebugState.helper.visible = false;
        if (raycastDebugState.hitMarker) {
            raycastDebugState.hitMarker.visible = false;
        }
    }

    function createCollisionLineSegments(geometry, color) {
        const edges = new THREE.EdgesGeometry(geometry, 30);
        const lines = new THREE.LineSegments(
            edges,
            new THREE.LineBasicMaterial({
                color,
                depthTest: false,
                transparent: true,
                opacity: 0.9,
                toneMapped: false,
            })
        );
        lines.renderOrder = 995;
        return lines;
    }

    function createCollisionOverlayFromObject(sourceRoot, color, { includeMesh = () => true } = {}) {
        if (!sourceRoot) return null;

        const overlayRoot = sourceRoot.isMesh && sourceRoot.geometry && includeMesh(sourceRoot)
            ? createCollisionLineSegments(sourceRoot.geometry, color)
            : new THREE.Group();
        const sourceMap = new Map([[sourceRoot, overlayRoot]]);

        sourceRoot.traverse((source) => {
            const overlayParent = sourceMap.get(source);
            if (!overlayParent) return;

            source.children.forEach((child) => {
                let overlayChild;
                if (child.isMesh && child.geometry && includeMesh(child)) {
                    overlayChild = createCollisionLineSegments(child.geometry, color);
                } else {
                    overlayChild = new THREE.Group();
                }

                overlayChild.position.copy(child.position);
                overlayChild.quaternion.copy(child.quaternion);
                overlayChild.scale.copy(child.scale);
                overlayParent.add(overlayChild);
                sourceMap.set(child, overlayChild);
            });
        });

        return overlayRoot;
    }

    function buildWorldCollisionOverlay() {
        if (!currentMesh) return null;

        let colliderCount = 0;
        const overlay = createCollisionOverlayFromObject(currentMesh, 0x38bdf8, {
            includeMesh: (mesh) => {
                const include = !mesh.userData?.skipPhysicsCollision;
                if (include) colliderCount++;
                return include;
            },
        });

        if (!overlay || colliderCount === 0) return null;
        overlay.name = 'world-collision-debug-overlay';
        return overlay;
    }

    function createImportedSimpleCollisionOverlay(template, color) {
        if (!template?.root) return null;

        template.root.updateWorldMatrix(true, true);
        const bounds = new THREE.Box3().setFromObject(template.root);
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        const lines = createCollisionLineSegments(
            new THREE.BoxGeometry(
                Math.max(size.x, 0.16),
                Math.max(size.y, 0.16),
                Math.max(size.z, 0.16),
            ),
            color,
        );
        lines.position.copy(center);
        return lines;
    }

    function buildActorCollisionOverlay(actor) {
        const flags = getActorComponentFlags(actor);
        if (!flags.collision) return null;

        const actorMesh = getActorRenderObject(actor);
        if (!actorMesh) return null;

        const color = flags.physics ? 0x22c55e : 0xf59e0b;

        if (actor.kind === 'vehicle') {
            const bounds = getVehicleVisualBounds(actorMesh);
            const lines = createCollisionLineSegments(
                new THREE.BoxGeometry(
                    Math.max(bounds.size.x, 0.16),
                    Math.max(bounds.size.y, 0.16),
                    Math.max(bounds.size.z, 0.16),
                ),
                color
            );
            lines.position.copy(bounds.center);
            return lines;
        }

        if (actor.kind === 'imported') {
            const template = getImportedTemplate(actor.templateId);
            if (template?.collisionMode === 'simple') {
                return createImportedSimpleCollisionOverlay(template, color);
            }
            return createCollisionOverlayFromObject(actorMesh, color);
        }

        return createCollisionOverlayFromObject(actorMesh, color);
    }

    function disposeCollisionOverlayObject(object) {
        if (!object) return;
        object.traverse((child) => {
            if (child.geometry) {
                child.geometry.dispose?.();
            }
            const material = child.material;
            if (Array.isArray(material)) {
                material.forEach((entry) => entry?.dispose?.());
            } else {
                material?.dispose?.();
            }
        });
    }

    function clearCollisionDebugOverlays() {
        collisionDebugState.overlays.forEach((overlay) => {
            overlay.parent?.remove(overlay);
            disposeCollisionOverlayObject(overlay);
        });
        collisionDebugState.overlays = [];
    }

    function refreshCollisionDebugOverlays() {
        if (!collisionDebugState.enabled || !core.scene) {
            clearCollisionDebugOverlays();
            return;
        }

        clearCollisionDebugOverlays();

        const worldOverlay = buildWorldCollisionOverlay();
        if (worldOverlay && currentMesh) {
            currentMesh.add(worldOverlay);
            collisionDebugState.overlays.push(worldOverlay);
        }

        for (const actor of core.sceneSystem?.actors || []) {
            const actorMesh = getActorRenderObject(actor);
            if (actorMesh && currentMesh && isObjectWithinRoot(actorMesh, currentMesh) && !actor.userData?.staticMeshActorCollision) continue;
            const overlay = buildActorCollisionOverlay(actor);
            if (!overlay || !actorMesh) continue;

            overlay.name = 'collision-debug-overlay';
            actorMesh.add(overlay);
            collisionDebugState.overlays.push(overlay);
        }
    }

    function setCollisionDebugEnabled(isEnabled) {
        collisionDebugState.enabled = !!isEnabled;
        refreshCollisionDebugOverlays();
        pushDebugConsoleLine(`Collision overlay ${collisionDebugState.enabled ? 'enabled' : 'disabled'} (F8).`, 'success');
    }

    return {
        ensureRaycastDebugLine, updateRaycastDebugLine, updateRaycasterDebugLine,
        tickRaycastDebugLine, createCollisionLineSegments,
        createCollisionOverlayFromObject, buildWorldCollisionOverlay,
        createImportedSimpleCollisionOverlay, buildActorCollisionOverlay,
        disposeCollisionOverlayObject, clearCollisionDebugOverlays,
        refreshCollisionDebugOverlays, setCollisionDebugEnabled,
    };
}