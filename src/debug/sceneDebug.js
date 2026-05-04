// src/debug/sceneDebug.js
// Extracted from main.js (chore/main-js-shrink-2). Owns the developer-only
// debug overlays that drape the scene: raycast debug arrow + line, collision
// shape preview meshes, gameplay-debug ray, force-all-shadows toggle, perf-mode
// (DDGI / bloom / fog suspend) toggle, and shadow-debug status pane.

import * as THREE from 'three';

let scene, camera, renderer, sceneSystem, physics, physicsCore;
let gameplay, importedPropState;
let raycastDebugState, collisionDebugState, shadowDebugState;
let shadowDebugUiRefs, perfModeUiRefs;
let postProcessVolumeManager;
let getVolumetricFogController, getDDGIManager;
let VEHICLE_SETTINGS;
let tempVectorC;
let getActorByBodyId, getActorComponentFlags, getActorRenderObject;
let physgunCameraRay, pushDebugConsoleLine;

// Owned state — perf-mode toggle is a module-private variable, mutated by
// setPerfModeEnabled. It was a top-level `let` in main.js; moving it here keeps
// the toggle authoritative without main.js needing to reach across the boundary.
let perfModeEnabled = false;

export function installSceneDebug(deps) {
    ({
        scene, camera, renderer, sceneSystem, physics, physicsCore,
        gameplay, importedPropState,
        raycastDebugState, collisionDebugState, shadowDebugState,
        shadowDebugUiRefs, perfModeUiRefs,
        postProcessVolumeManager,
        getVolumetricFogController, getDDGIManager,
        VEHICLE_SETTINGS,
        tempVectorC,
        getActorByBodyId, getActorComponentFlags, getActorRenderObject,
        physgunCameraRay, pushDebugConsoleLine,
    } = deps);
}

export function ensureRaycastDebugLine() {
    if (raycastDebugState.helper || !scene) return raycastDebugState.helper;

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
    scene.add(helper);

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
    scene.add(hitMarker);

    raycastDebugState.helper = helper;
    raycastDebugState.hitMarker = hitMarker;
    return helper;
}

export function updateRaycastDebugLine(origin, direction, maxDist, hitPoint = null, hit = false) {
    if (!raycastDebugState.enabled) {
        return;
    }

    const helper = ensureRaycastDebugLine();
    const distance = Number.isFinite(maxDist) && maxDist > 0 ? maxDist : 0;
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

export function updateRaycasterDebugLine(ray, maxDist, hitPoint = null, hit = false) {
    if (!ray) return;
    updateRaycastDebugLine(ray.origin, ray.direction, maxDist, hitPoint, hit);
}

export function tickRaycastDebugLine() {
    if (!raycastDebugState.helper?.visible) return;
    if (performance.now() < raycastDebugState.expiresAt) return;
    raycastDebugState.helper.visible = false;
    if (raycastDebugState.hitMarker) {
        raycastDebugState.hitMarker.visible = false;
    }
}

export function createCollisionLineSegments(geometry, color) {
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

export function createCollisionOverlayFromObject(sourceRoot, color) {
    if (!sourceRoot) return null;

    const overlayRoot = sourceRoot.isMesh && sourceRoot.geometry
        ? createCollisionLineSegments(sourceRoot.geometry, color)
        : new THREE.Group();
    const sourceMap = new Map([[sourceRoot, overlayRoot]]);

    sourceRoot.traverse((source) => {
        const overlayParent = sourceMap.get(source);
        if (!overlayParent) return;

        source.children.forEach((child) => {
            let overlayChild;
            if (child.isMesh && child.geometry) {
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

export function createImportedSimpleCollisionOverlay(template, color) {
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

export function buildActorCollisionOverlay(actor) {
    const flags = getActorComponentFlags(actor);
    if (!flags.collision) return null;

    const actorMesh = getActorRenderObject(actor);
    if (!actorMesh) return null;

    const color = flags.physics ? 0x22c55e : 0xf59e0b;

    if (actor.kind === 'vehicle') {
        return createCollisionLineSegments(
            new THREE.BoxGeometry(VEHICLE_SETTINGS.width, VEHICLE_SETTINGS.height, VEHICLE_SETTINGS.length),
            color,
        );
    }

    if (actor.kind === 'imported') {
        const template = importedPropState.templates.find((entry) => entry.id === actor.templateId);
        if (template?.collisionMode === 'simple') {
            return createImportedSimpleCollisionOverlay(template, color);
        }
        return createCollisionOverlayFromObject(actorMesh, color);
    }

    return createCollisionOverlayFromObject(actorMesh, color);
}

export function disposeCollisionOverlayObject(object) {
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

export function clearCollisionDebugOverlays() {
    collisionDebugState.overlays.forEach((overlay) => {
        overlay.parent?.remove(overlay);
        disposeCollisionOverlayObject(overlay);
    });
    collisionDebugState.overlays = [];
}

export function refreshCollisionDebugOverlays() {
    if (!collisionDebugState.enabled || !scene) {
        clearCollisionDebugOverlays();
        return;
    }

    clearCollisionDebugOverlays();

    for (const actor of sceneSystem?.actors || []) {
        const actorMesh = getActorRenderObject(actor);
        const overlay = buildActorCollisionOverlay(actor);
        if (!overlay || !actorMesh) continue;

        overlay.name = 'collision-debug-overlay';
        actorMesh.add(overlay);
        collisionDebugState.overlays.push(overlay);
    }
}

export function setCollisionDebugEnabled(isEnabled) {
    collisionDebugState.enabled = !!isEnabled;
    refreshCollisionDebugOverlays();
    pushDebugConsoleLine(`Collision overlay ${collisionDebugState.enabled ? 'enabled' : 'disabled'} (F8).`, 'success');
}

export function raycastWorld(origin, direction, maxDist = 1000) {
    if (!physicsCore?.castRay) return { hit: false };
    const distance = Number(maxDist);
    const safeDistance = Number.isFinite(distance) && distance > 0 ? distance : 1000;
    const result = physicsCore.castRay(origin, direction, safeDistance);
    updateRaycastDebugLine(origin, direction, safeDistance, result?.point ?? null, !!result?.hit);
    if (!result?.hit) return { hit: false };
    return { ...result, actor: getActorByBodyId(result.bodyId) };
}

export function describeRaycastHit(result) {
    if (!result?.hit) {
        return {
            key: 'miss',
            message: 'Debug ray hit nothing.',
        };
    }

    const actor = result.actor ?? null;
    const actorLabel = actor?.userData?.label || actor?.rootNode?.name || actor?.name || actor?.id || '';
    const kind = actor?.kind || 'world-static';
    const distance = Number.isFinite(result.distance) ? result.distance.toFixed(2) : 'unknown';
    const targetLabel = actorLabel || `body ${result.bodyId ?? 'unknown'}`;

    return {
        key: `${actor?.id || 'world-static'}:${distance}`,
        message: `Debug ray hit ${targetLabel} (${kind}) at ${distance}m.`,
    };
}

export function logGameplayDebugRayHit(result) {
    if (!raycastDebugState.enabled) {
        return;
    }

    const description = describeRaycastHit(result);
    if (description.key === raycastDebugState.lastConsoleHitKey) {
        return;
    }

    raycastDebugState.lastConsoleHitKey = description.key;
    console.log(description.message, result);
}

export function updateGameplayDebugRay() {
    if (!raycastDebugState.enabled || !gameplay.active || !camera) {
        if (raycastDebugState.helper) {
            raycastDebugState.helper.visible = false;
        }
        if (raycastDebugState.hitMarker) {
            raycastDebugState.hitMarker.visible = false;
        }
        raycastDebugState.lastConsoleHitKey = '';
        return;
    }

    const { origin, direction } = physgunCameraRay();
    const result = raycastWorld(origin, direction, 50);
    logGameplayDebugRayHit(result);
}

export function setRayDebugEnabled(isEnabled) {
    raycastDebugState.enabled = !!isEnabled;
    raycastDebugState.lastConsoleHitKey = '';

    if (!raycastDebugState.enabled) {
        if (raycastDebugState.helper) {
            raycastDebugState.helper.visible = false;
        }
        if (raycastDebugState.hitMarker) {
            raycastDebugState.hitMarker.visible = false;
        }
    }
}

export function formatShadowDebugStatus() {
    const lastPassSuffix = shadowDebugState.lastAppliedAt > 0
        ? ` Last pass hit ${shadowDebugState.lastMeshCount} mesh${shadowDebugState.lastMeshCount === 1 ? '' : 'es'}, changed ${shadowDebugState.lastUpdatedCount}, armed ${shadowDebugState.lastLightCount} shadow light${shadowDebugState.lastLightCount === 1 ? '' : 's'}.`
        : '';

    if (shadowDebugState.forceAllMeshes) {
        return `Auto force is on. New scene meshes get swept every ${Math.round(shadowDebugState.autoApplyIntervalMs)} ms.${lastPassSuffix}`;
    }

    if (shadowDebugState.lastAppliedAt > 0) {
        return `Auto force is off.${lastPassSuffix}`;
    }

    return 'Auto force is off. Apply Now runs one scene-wide shadow pass without keeping it enabled.';
}

export function updateShadowDebugUi() {
    if (!shadowDebugUiRefs) return;

    shadowDebugUiRefs.forceOffBtn?.classList.toggle('viewer-toggle-btn-active', !shadowDebugState.forceAllMeshes);
    shadowDebugUiRefs.forceOnBtn?.classList.toggle('viewer-toggle-btn-active', shadowDebugState.forceAllMeshes);

    if (shadowDebugUiRefs.status) {
        shadowDebugUiRefs.status.textContent = formatShadowDebugStatus();
    }
}

export function isShadowForceExcludedObject(object) {
    let current = object;
    while (current) {
        if (current.userData?.ignoreForcedSceneShadows) {
            return true;
        }
        current = current.parent ?? null;
    }

    return object?.name === 'tire-skid-ribbon';
}

export function forceAllSceneMeshShadows() {
    if (!scene?.traverse) {
        shadowDebugState.lastAppliedAt = performance.now();
        shadowDebugState.lastMeshCount = 0;
        shadowDebugState.lastUpdatedCount = 0;
        shadowDebugState.lastLightCount = 0;
        updateShadowDebugUi();
        return {
            meshCount: 0,
            updatedCount: 0,
            shadowLightCount: 0,
        };
    }

    let meshCount = 0;
    let updatedCount = 0;
    let shadowLightCount = 0;

    scene.traverse((object) => {
        if (!object) return;

        if (object.isMesh) {
            if (isShadowForceExcludedObject(object)) {
                return;
            }

            meshCount += 1;

            if (!object.castShadow || !object.receiveShadow) {
                updatedCount += 1;
            }

            object.castShadow = true;
            object.receiveShadow = true;
            return;
        }

        if (object.isDirectionalLight || object.isSpotLight || object.isPointLight) {
            if (!object.castShadow) {
                shadowLightCount += 1;
            }
            object.castShadow = true;
        }
    });

    if (renderer?.shadowMap) {
        renderer.shadowMap.enabled = true;
    }

    shadowDebugState.lastAppliedAt = performance.now();
    shadowDebugState.lastMeshCount = meshCount;
    shadowDebugState.lastUpdatedCount = updatedCount;
    shadowDebugState.lastLightCount = shadowLightCount;
    updateShadowDebugUi();

    return {
        meshCount,
        updatedCount,
        shadowLightCount,
    };
}

export function setForceAllSceneMeshShadowsEnabled(isEnabled) {
    shadowDebugState.forceAllMeshes = !!isEnabled;
    const result = shadowDebugState.forceAllMeshes ? forceAllSceneMeshShadows() : null;
    updateShadowDebugUi();
    return result;
}

export function updatePerfModeUi() {
    if (!perfModeUiRefs) return;
    perfModeUiRefs.offBtn?.classList.toggle('viewer-toggle-btn-active', !perfModeEnabled);
    perfModeUiRefs.onBtn?.classList.toggle('viewer-toggle-btn-active', perfModeEnabled);
    if (perfModeUiRefs.status) {
        perfModeUiRefs.status.textContent = perfModeEnabled
            ? 'Performance mode on. DDGI, volumetric fog, and post-process bloom are paused.'
            : 'Performance mode off. Full DDGI + fog + post-process active.';
    }
}

export function setPerfModeEnabled(isEnabled) {
    const next = !!isEnabled;
    if (perfModeEnabled === next) {
        updatePerfModeUi();
        return;
    }
    perfModeEnabled = next;

    // Volumetric fog: hides the layer group AND clears scene.fog when off.
    getVolumetricFogController()?.setEnabled(!perfModeEnabled);

    // DDGI: tick() short-circuits when state.enabled is false; injectionEnabled
    // controls the shader-injection patching loop, which we also pause so
    // newly-added materials don't get patched while perf mode is on.
    const ddgi = getDDGIManager();
    ddgi?.setEnabled(!perfModeEnabled);
    ddgi?.setInjectionEnabled(!perfModeEnabled);

    // Post-process: clamps bloom uniforms to neutral so the MRT bloom pass
    // becomes a no-op while still running (cheap once strength is 0).
    postProcessVolumeManager?.setEnabled(!perfModeEnabled);

    updatePerfModeUi();
}

export function tickForceAllSceneMeshShadows() {
    if (!shadowDebugState.forceAllMeshes) return;
    if ((performance.now() - shadowDebugState.lastAppliedAt) < shadowDebugState.autoApplyIntervalMs) return;
    forceAllSceneMeshShadows();
}
