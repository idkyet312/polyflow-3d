import * as THREE from 'three';
import { core } from '../runtime/appCore.js';

// Scene-actor UI: actor-details panel, light/DDGI controls, physics-preview
// helpers, scene-list rendering. Extracted from runtime.js. Live engine
// refs (camera/sceneSystem/sceneUiList/sceneUiCount/transformControl) via
// appCore. Pure UI mutation surface; no shared scratch state.
export function createSceneActorUi(deps) {
    const {
        actorPhysicsEditorState, blueprintState, collisionDebugState,
        gameplay, objectScriptState,
        actorInheritsCore, focusSceneActor, getActorCoreSource,
        DDGIVolumeComponent, enterBlueprintEditor, exportActorToFile,
        getActorComponentFlags, getDynamicPropById, refreshBlueprintComponents,
        setActorColor,
        // call-site deps the audit caught via unresolved-calls cross-check
        // (hoisted fns, debug-overlay aliases @6883+, imports — all safe):
        applyShowcaseCameraRotation, buildActorCollisionOverlay,
        disposeCollisionOverlayObject, getActorRenderObject, getDDGIManager,
        invalidateDDGI, rebuildActorPhysics, refreshCollisionDebugOverlays,
        refreshGameplayWorld, requestLightShadowRefresh, selectShowcaseActor,
        syncShowcaseAnglesFromTarget, syncTransformToPhysics,
    } = deps;

    function buildCollisionBoxComponent() {
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(2, 2, 2),
            new THREE.MeshBasicMaterial({
                color: 0x22d3ee,
                transparent: true,
                opacity: 0.16,
                wireframe: true,
                depthTest: false,
            })
        );
        mesh.name = 'Collision Box';
        mesh.renderOrder = 20;
        mesh.userData.isCollisionShape = true;
        mesh.userData.collisionShapeType = 'box';
        mesh.userData.skipMaterialExport = true;
        return mesh;
    }

    function getActorPhysicsSettings(actor) {
        const userData = actor?.userData ?? {};
        return {
            mass: Number.isFinite(userData.physicsMass) ? userData.physicsMass : 12,
            friction: Number.isFinite(userData.physicsFriction) ? userData.physicsFriction : (Number.isFinite(userData.friction) ? userData.friction : 0.5),
            restitution: Number.isFinite(userData.physicsRestitution) ? userData.physicsRestitution : (Number.isFinite(userData.restitution) ? userData.restitution : 0.3),
        };
    }

    function clearActorPhysicsPreview() {
        const overlay = actorPhysicsEditorState.previewOverlay;
        if (overlay) {
            overlay.parent?.remove(overlay);
            disposeCollisionOverlayObject(overlay);
        }
        actorPhysicsEditorState.previewOverlay = null;
        actorPhysicsEditorState.previewActorId = '';
    }

    function refreshActorPhysicsPreview() {
        const actorId = actorPhysicsEditorState.previewActorId;
        if (!actorId) return;

        const actor = getDynamicPropById(actorId);
        const actorMesh = getActorRenderObject(actor);
        const nextOverlay = actor ? buildActorCollisionOverlay(actor) : null;

        if (actorPhysicsEditorState.previewOverlay) {
            actorPhysicsEditorState.previewOverlay.parent?.remove(actorPhysicsEditorState.previewOverlay);
            disposeCollisionOverlayObject(actorPhysicsEditorState.previewOverlay);
            actorPhysicsEditorState.previewOverlay = null;
        }

        if (!actorMesh || !nextOverlay) {
            actorPhysicsEditorState.previewActorId = '';
            return;
        }

        nextOverlay.name = 'actor-physics-preview-overlay';
        actorMesh.add(nextOverlay);
        actorPhysicsEditorState.previewOverlay = nextOverlay;
    }

    function setActorPhysicsPreview(actor, enabled) {
        clearActorPhysicsPreview();
        if (!enabled || !actor?.id) return;
        actorPhysicsEditorState.previewActorId = actor.id;
        refreshActorPhysicsPreview();
    }

    function applyActorPhysicsSettings(actor, settings) {
        if (!actor) return;

        const next = {
            physicsMass: THREE.MathUtils.clamp(Number(settings.mass) || 12, 0.01, 100000),
            physicsFriction: THREE.MathUtils.clamp(Number(settings.friction) || 0, 0, 2),
            physicsRestitution: THREE.MathUtils.clamp(Number(settings.restitution) || 0, 0, 1),
        };
        Object.assign(actor.userData, next);
        const mesh = getActorRenderObject(actor);
        if (mesh?.userData) Object.assign(mesh.userData, next);

        if (getActorComponentFlags(actor).collision) {
            rebuildActorPhysics(actor);
        }
        refreshActorPhysicsPreview();
        if (collisionDebugState.enabled) refreshCollisionDebugOverlays();
        refreshSceneUI();
    }

    function syncBlueprintPhysicsEditor(actor = getDynamicPropById(objectScriptState.targetPropId)) {
        const settings = getActorPhysicsSettings(actor);
        const mass = document.getElementById('bp-physics-mass');
        const friction = document.getElementById('bp-physics-friction');
        const restitution = document.getElementById('bp-physics-restitution');
        if (mass) mass.value = String(settings.mass);
        if (friction) friction.value = String(settings.friction);
        if (restitution) restitution.value = String(settings.restitution);
    }

    function applyBlueprintPhysicsEditor() {
        const actor = getDynamicPropById(objectScriptState.targetPropId);
        if (!actor) return;
        applyActorPhysicsSettings(actor, {
            mass: parseFloat(document.getElementById('bp-physics-mass')?.value ?? '12'),
            friction: parseFloat(document.getElementById('bp-physics-friction')?.value ?? '0.5'),
            restitution: parseFloat(document.getElementById('bp-physics-restitution')?.value ?? '0.3'),
        });
        refreshBlueprintComponents();
    }

    function getSceneActorDetailsRefs() {
        return {
            empty: document.getElementById('scene-actor-details-empty'),
            body: document.getElementById('scene-actor-details-body'),
            name: document.getElementById('scene-actor-details-name'),
            type: document.getElementById('scene-actor-details-type'),
            modeTranslate: document.getElementById('scene-actor-mode-translate'),
            modeRotate: document.getElementById('scene-actor-mode-rotate'),
            modeScale: document.getElementById('scene-actor-mode-scale'),
            spaceLocal: document.getElementById('scene-actor-space-local'),
            spaceWorld: document.getElementById('scene-actor-space-world'),
            locX: document.getElementById('scene-actor-loc-x'),
            locY: document.getElementById('scene-actor-loc-y'),
            locZ: document.getElementById('scene-actor-loc-z'),
            rotX: document.getElementById('scene-actor-rot-x'),
            rotY: document.getElementById('scene-actor-rot-y'),
            rotZ: document.getElementById('scene-actor-rot-z'),
            sclX: document.getElementById('scene-actor-scl-x'),
            sclY: document.getElementById('scene-actor-scl-y'),
            sclZ: document.getElementById('scene-actor-scl-z'),
            lightSection: document.getElementById('scene-actor-light-section'),
            lightColor: document.getElementById('scene-actor-light-color'),
            lightIntensity: document.getElementById('scene-actor-light-intensity'),
            lightDistance: document.getElementById('scene-actor-light-distance'),
            lightDecay: document.getElementById('scene-actor-light-decay'),
            lightSpotRow: document.getElementById('scene-actor-light-spot-row'),
            lightAngle: document.getElementById('scene-actor-light-angle'),
            lightPenumbra: document.getElementById('scene-actor-light-penumbra'),
            lightShadow: document.getElementById('scene-actor-light-shadow'),
            lightKind: document.getElementById('scene-actor-light-kind'),
            ddgiSection: document.getElementById('scene-actor-ddgi-section'),
            ddgiDimX: document.getElementById('scene-actor-ddgi-dim-x'),
            ddgiDimY: document.getElementById('scene-actor-ddgi-dim-y'),
            ddgiDimZ: document.getElementById('scene-actor-ddgi-dim-z'),
            ddgiSizeX: document.getElementById('scene-actor-ddgi-size-x'),
            ddgiSizeY: document.getElementById('scene-actor-ddgi-size-y'),
            ddgiSizeZ: document.getElementById('scene-actor-ddgi-size-z'),
            ddgiTotal: document.getElementById('scene-actor-ddgi-total'),
            ddgiCell: document.getElementById('scene-actor-ddgi-cell'),
            ddgiIntensity: document.getElementById('scene-actor-ddgi-intensity'),
            ddgiHysteresis: document.getElementById('scene-actor-ddgi-hysteresis'),
            ddgiNormalBias: document.getElementById('scene-actor-ddgi-normal-bias'),
            ddgiProbesPerFrame: document.getElementById('scene-actor-ddgi-probes-per-frame'),
        };
    }

    function getSelectedSceneActor() {
        const actorId = objectScriptState.targetPropId;
        return actorId ? getDynamicPropById(actorId) : null;
    }

    function getActorDDGIVolumeComponent(actor) {
        if (!actor) return null;
        return actor.getComponentByClass?.(DDGIVolumeComponent)
            || actor.GetComponent?.(DDGIVolumeComponent)
            || null;
    }

    function getActorLightObject(actor) {
        const root = getActorRenderObject(actor);
        if (!root) return null;

        let light = null;
        root.traverse((node) => {
            if (light || (!node?.isPointLight && !node?.isSpotLight)) return;
            light = node;
        });
        return light;
    }

    function syncActorLightStateFromObject(actor, light) {
        if (!actor || !light) return;

        const previousLightState = actor.userData?.light || {};
        actor.userData = {
            ...(actor.userData || {}),
            light: {
                ...previousLightState,
                kind: actor.kind || previousLightState.kind,
                color: `#${light.color.getHexString()}`,
                intensity: light.intensity,
                distance: light.distance,
                decay: light.decay,
                castShadow: light.castShadow === true,
                ...(light.isSpotLight ? {
                    angle: light.angle,
                    penumbra: light.penumbra,
                } : {}),
            },
        };
    }

    function syncActorLightHelperVisuals(actor) {
        const root = getActorRenderObject(actor);
        const light = getActorLightObject(actor);
        if (!root || !light) return;

        const lightState = actor?.userData?.light || {};
        const helperColor = light.color.clone();
        const range = Math.max(light.distance >undefined? light.distance : ((Number.isFinite(lightState.radius) && lightState.radius > 0) ? lightState.radius *undefined: 12), 0.25);

        root.traverse((node) => {
            if (!node?.material) return;
            const mats = Array.isArray(node.material) ? node.material : [node.material];
            mats.forEach((mat) => {
                if (mat.color) mat.color.copy(helperColor);
                if (mat.emissive) {
                    mat.emissive.copy(helperColor);
                    mat.emissiveIntensity = Math.max(mat.emissiveIntensity ?? 1, 4.5);
                    mat.toneMapped = false;
                }
            });
        });

        const pointRange = root.getObjectByName('point-light-range');
        if (pointRange) {
            pointRange.userData.lightRangeVisual = true;
            pointRange.scale.setScalar(range);
        }

        const spotTarget = root.getObjectByName('spot-light-target');
        const spotVolume = root.getObjectByName('spot-light-volume');
        const spotAim = root.getObjectByName('spot-light-aim');
        if (spotTarget) {
            spotTarget.position.set(0, 0, -Math.max(1.5, range));
            spotTarget.updateMatrixWorld(true);
        }
        if (spotVolume && light.isSpotLight) {
            spotVolume.userData.lightRangeVisual = true;
            const coneRadius = Math.max(0.08, Math.tan(light.angle ?? (Math.PI / 6)) * range);
            spotVolume.scale.set(coneRadius, range, coneRadius);
            spotVolume.position.set(0, 0, -range * 0.5);
        }
        if (spotAim?.geometry?.attributes?.position) {
            spotAim.userData.lightRangeVisual = true;
            const positions = spotAim.geometry.attributes.position.array;
            positions[0] = 0;
            positions[1] = 0;
            positions[2] = 0;
            positions[3] = 0;
            positions[4] = 0;
            positions[5] = -Math.max(1.5, range);
            spotAim.geometry.attributes.position.needsUpdate = true;
            spotAim.geometry.computeBoundingSphere?.();
        }

        root.traverse((node) => {
            if (node?.userData?.lightRangeVisual) {
                node.visible = actor?.id === objectScriptState.targetPropId;
            }
        });

        light.target?.updateMatrixWorld?.(true);
    }

    function updateLightRangeVisualVisibility() {
        if (!core.sceneSystem?.actors) return;
        for (const actor of core.sceneSystem.actors) {
            const root = getActorRenderObject(actor);
            if (!root) continue;
            const visible = actor.id === objectScriptState.targetPropId;
            root.traverse((node) => {
                if (node?.userData?.lightRangeVisual) {
                    node.visible = visible;
                }
            });
        }
    }

    function syncDDGIVolumeComponentToActorBounds(ddgi) {
        if (!ddgi) return;
        ddgi.syncCellSizeToOwnerBounds?.();
        ddgi.probesPerFrame = Math.max(1, Math.min(120, ddgi.probesPerFrame | 0));
        ddgi.bakeEveryN = ddgi.probesPerFrame;
        try {
            getDDGIManager().registerVolume(ddgi);
        } catch {
            // DDGI manager can be unavailable during early init or teardown.
        }
    }

    function updateSceneActorDetailsTransformButtons(refs = getSceneActorDetailsRefs()) {
        const mode = core.transformControl?.getMode?.() || 'translate';
        const space = core.transformControl?.space || 'local';
        if (refs.modeTranslate) refs.modeTranslate.style.background = mode === 'translate' ? 'linear-gradient(180deg, rgba(242, 163, 58, 0.94) 0%, rgba(199, 122, 30, 0.94) 100%)' : '';
        if (refs.modeRotate) refs.modeRotate.style.background = mode === 'rotate' ? 'linear-gradient(180deg, rgba(242, 163, 58, 0.94) 0%, rgba(199, 122, 30, 0.94) 100%)' : '';
        if (refs.modeScale) refs.modeScale.style.background = mode === 'scale' ? 'linear-gradient(180deg, rgba(242, 163, 58, 0.94) 0%, rgba(199, 122, 30, 0.94) 100%)' : '';
        if (refs.spaceLocal) refs.spaceLocal.style.background = space === 'local' ? 'linear-gradient(180deg, rgba(242, 163, 58, 0.94) 0%, rgba(199, 122, 30, 0.94) 100%)' : '';
        if (refs.spaceWorld) refs.spaceWorld.style.background = space === 'world' ? 'linear-gradient(180deg, rgba(242, 163, 58, 0.94) 0%, rgba(199, 122, 30, 0.94) 100%)' : '';
    }

    function updateSceneActorDetailsUI() {
        const refs = getSceneActorDetailsRefs();
        if (!refs.empty || !refs.body || !refs.type) return;

        const actor = getSelectedSceneActor();
        const mesh = getActorRenderObject(actor);
        updateSceneActorDetailsTransformButtons(refs);

        if (blueprintState.active || !actor || !mesh) {
            refs.empty.hidden = false;
            refs.body.hidden = true;
            refs.type.textContent = 'Select actor';
            if (refs.name) refs.name.textContent = 'No Actor Selected';
            if (refs.lightSection) refs.lightSection.hidden = true;
            if (refs.ddgiSection) refs.ddgiSection.hidden = true;
            return;
        }

        refs.empty.hidden = true;
        refs.body.hidden = false;
        if (refs.name) refs.name.textContent = actor.rootNode?.name || actor.id || 'Actor';
        refs.type.textContent = actorInheritsCore(actor) ? 'instance' : (actor.kind || 'actor');

        if (refs.locX) refs.locX.value = mesh.position.x.toFixed(3);
        if (refs.locY) refs.locY.value = mesh.position.y.toFixed(3);
        if (refs.locZ) refs.locZ.value = mesh.position.z.toFixed(3);
        if (refs.rotX) refs.rotX.value = THREE.MathUtils.radToDeg(mesh.rotation.x).toFixed(1);
        if (refs.rotY) refs.rotY.value = THREE.MathUtils.radToDeg(mesh.rotation.y).toFixed(1);
        if (refs.rotZ) refs.rotZ.value = THREE.MathUtils.radToDeg(mesh.rotation.z).toFixed(1);
        if (refs.sclX) refs.sclX.value = mesh.scale.x.toFixed(3);
        if (refs.sclY) refs.sclY.value = mesh.scale.y.toFixed(3);
        if (refs.sclZ) refs.sclZ.value = mesh.scale.z.toFixed(3);

        const light = getActorLightObject(actor);
        if (refs.lightSection) {
            refs.lightSection.hidden = !light;
        }
        if (refs.lightSpotRow) {
            refs.lightSpotRow.hidden = !light?.isSpotLight;
        }
        if (light) {
            syncActorLightStateFromObject(actor, light);
            syncActorLightHelperVisuals(actor);
            const lightState = actor.userData?.light || {};
            if (refs.lightColor) refs.lightColor.value = lightState.color || `#${light.color.getHexString()}`;
            if (refs.lightIntensity) refs.lightIntensity.value = Number(light.intensity ?? 0).toFixed(3);
            if (refs.lightDistance) refs.lightDistance.value = Number(light.distance ?? 0).toFixed(3);
            if (refs.lightDecay) refs.lightDecay.value = Number(light.decay ?? 0).toFixed(3);
            if (refs.lightShadow) refs.lightShadow.value = light.castShadow ? 'on' : 'off';
            if (refs.lightKind) refs.lightKind.value = light.isSpotLight ? 'Spot Light' : 'Point Light';
            if (refs.lightAngle) refs.lightAngle.value = THREE.MathUtils.radToDeg(light.angle ?? (Math.PI / 6)).toFixed(1);
            if (refs.lightPenumbra) refs.lightPenumbra.value = Number(light.penumbra ?? 0).toFixed(3);
        }

        const ddgi = getActorDDGIVolumeComponent(actor);
        if (refs.ddgiSection) {
            refs.ddgiSection.hidden = !ddgi;
        }
        if (!ddgi) return;

        const size = ddgi.getOwnerVolumeSize?.(new THREE.Vector3()) || new THREE.Vector3();
        const totalProbes = ddgi.getProbeCount?.() || (ddgi.gridDims.x * ddgi.gridDims.y * ddgi.gridDims.z);
        const derivedCellSize = Math.max(
            size.x / Math.max(2, ddgi.gridDims.x),
            size.y / Math.max(2, ddgi.gridDims.y),
            size.z / Math.max(2, ddgi.gridDims.z),
            0.05,
        );

        if (refs.ddgiDimX) refs.ddgiDimX.value = String(ddgi.gridDims.x);
        if (refs.ddgiDimY) refs.ddgiDimY.value = String(ddgi.gridDims.y);
        if (refs.ddgiDimZ) refs.ddgiDimZ.value = String(ddgi.gridDims.z);
        if (refs.ddgiSizeX) refs.ddgiSizeX.value = size.x.toFixed(2);
        if (refs.ddgiSizeY) refs.ddgiSizeY.value = size.y.toFixed(2);
        if (refs.ddgiSizeZ) refs.ddgiSizeZ.value = size.z.toFixed(2);
        if (refs.ddgiTotal) refs.ddgiTotal.value = String(totalProbes);
        if (refs.ddgiCell) refs.ddgiCell.value = derivedCellSize.toFixed(3);
        if (refs.ddgiIntensity) refs.ddgiIntensity.value = Number(ddgi.intensity ?? 0).toFixed(3);
        if (refs.ddgiHysteresis) refs.ddgiHysteresis.value = Number(ddgi.hysteresis ?? 0).toFixed(3);
        if (refs.ddgiNormalBias) refs.ddgiNormalBias.value = Number(ddgi.normalBias ?? 0).toFixed(3);
        if (refs.ddgiProbesPerFrame) refs.ddgiProbesPerFrame.value = String(ddgi.probesPerFrame | 0);
    }

    function applySceneActorTransformDetailsFromUI() {
        const actor = getSelectedSceneActor();
        const mesh = getActorRenderObject(actor);
        const refs = getSceneActorDetailsRefs();
        if (!actor || !mesh || !refs.locX) return;

        mesh.position.set(
            Number.parseFloat(refs.locX.value) || 0,
            Number.parseFloat(refs.locY.value) || 0,
            Number.parseFloat(refs.locZ.value) || 0,
        );
        mesh.rotation.set(
            THREE.MathUtils.degToRad(Number.parseFloat(refs.rotX?.value) || 0),
            THREE.MathUtils.degToRad(Number.parseFloat(refs.rotY?.value) || 0),
            THREE.MathUtils.degToRad(Number.parseFloat(refs.rotZ?.value) || 0),
        );
        mesh.scale.set(
            Math.max(0.01, Number.parseFloat(refs.sclX?.value) || 1),
            Math.max(0.01, Number.parseFloat(refs.sclY?.value) || 1),
            Math.max(0.01, Number.parseFloat(refs.sclZ?.value) || 1),
        );
        mesh.updateMatrixWorld(true);

        if (core.transformControl && core.transformControl.object !== mesh) {
            core.transformControl.attach(mesh);
        }

        syncTransformToPhysics();

        if (actorBelongsToCurrentMesh(actor)) {
            refreshGameplayWorld({ resetCamera: false });
        }

        const ddgi = getActorDDGIVolumeComponent(actor);
        if (ddgi) {
            syncDDGIVolumeComponentToActorBounds(ddgi);
            invalidateDDGI('ddgi volume transformed from details');
        } else {
            invalidateDDGI('scene actor transformed from details');
        }

        refreshSceneUI();
        updateSceneActorDetailsUI();
    }

    function applySceneActorDDGIDetailsFromUI() {
        const actor = getSelectedSceneActor();
        const ddgi = getActorDDGIVolumeComponent(actor);
        const refs = getSceneActorDetailsRefs();
        if (!actor || !ddgi || !refs.ddgiDimX) return;

        const dimsX = Math.max(2, Math.floor(Number.parseFloat(refs.ddgiDimX.value) || ddgi.gridDims.x));
        const dimsY = Math.max(2, Math.floor(Number.parseFloat(refs.ddgiDimY.value) || ddgi.gridDims.y));
        const dimsZ = Math.max(2, Math.floor(Number.parseFloat(refs.ddgiDimZ.value) || ddgi.gridDims.z));
        ddgi.setGridDims(dimsX, dimsY, dimsZ);
        ddgi.intensity = Math.max(0, Math.min(16, Number.parseFloat(refs.ddgiIntensity?.value) || ddgi.intensity));
        ddgi.hysteresis = Math.max(0, Math.min(0.999, Number.parseFloat(refs.ddgiHysteresis?.value) || ddgi.hysteresis));
        ddgi.normalBias = Math.max(0, Math.min(2, Number.parseFloat(refs.ddgiNormalBias?.value) || ddgi.normalBias));
        ddgi.probesPerFrame = Math.max(1, Math.min(120, Math.floor(Number.parseFloat(refs.ddgiProbesPerFrame?.value) || ddgi.probesPerFrame)));
        syncDDGIVolumeComponentToActorBounds(ddgi);
        invalidateDDGI('ddgi volume settings changed');
        updateSceneActorDetailsUI();
    }

    function applySceneActorLightDetailsFromUI() {
        const actor = getSelectedSceneActor();
        const light = getActorLightObject(actor);
        const refs = getSceneActorDetailsRefs();
        if (!actor || !light || !refs.lightIntensity) return;

        const colorValue = typeof refs.lightColor?.value === 'string' && refs.lightColor.value.length
            ? refs.lightColor.value
            : `#${light.color.getHexString()}`;
        if (colorValue !== `#${light.color.getHexString()}`) {
            setActorColor(actor, colorValue);
        }

        const intensity = Number.parseFloat(refs.lightIntensity.value);
        if (Number.isFinite(intensity)) {
            light.intensity = Math.max(0, intensity);
        }

        const distance = Number.parseFloat(refs.lightDistance?.value);
        if (Number.isFinite(distance)) {
            light.distance = Math.max(0, distance);
        }

        const decay = Number.parseFloat(refs.lightDecay?.value);
        if (Number.isFinite(decay)) {
            light.decay = Math.max(0, decay);
        }

        light.castShadow = refs.lightShadow?.value !== 'off';
        requestLightShadowRefresh(light);

        if (light.isSpotLight) {
            const angleDegrees = Number.parseFloat(refs.lightAngle?.value);
            if (Number.isFinite(angleDegrees)) {
                light.angle = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(angleDegrees, 1, 89));
            }

            const penumbra = Number.parseFloat(refs.lightPenumbra?.value);
            if (Number.isFinite(penumbra)) {
                light.penumbra = THREE.MathUtils.clamp(penumbra, 0, 1);
            }

            light.target?.updateMatrixWorld?.(true);
        }

        syncActorLightStateFromObject(actor, light);
        syncActorLightHelperVisuals(actor);
        invalidateDDGI('light actor settings changed');
        updateSceneActorDetailsUI();
    }

    function createSceneActorItem(actor, { isChild = false } = {}) {
        const item = document.createElement('div');
        item.className = isChild ? 'scene-ui-item scene-ui-child-item' : 'scene-ui-item';
        item.dataset.id = actor.id;

        if (objectScriptState.targetPropId === actor.id) {
            item.style.background = 'linear-gradient(180deg, rgba(58, 43, 22, 0.98) 0%, rgba(42, 30, 15, 0.98) 100%)';
            item.style.borderColor = 'rgba(242, 163, 58, 0.58)';
            if (!blueprintState.active) {
                const actorBtnRow = document.createElement('div');
                actorBtnRow.className = 'scene-ui-item-actions';

                const blueprintBtn = document.createElement('button');
                blueprintBtn.className = 'btn btn-primary scene-ui-action-btn';
                blueprintBtn.textContent = 'Edit Blueprint';
                blueprintBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    enterBlueprintEditor();
                    syncBlueprintPhysicsEditor(actor);
                });
                actorBtnRow.appendChild(blueprintBtn);

                const saveActorBtn = document.createElement('button');
                saveActorBtn.className = 'btn scene-ui-action-btn scene-ui-save-btn';
                saveActorBtn.textContent = 'Save';
                saveActorBtn.title = 'Download this actor as a .actor file';
                saveActorBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    exportActorToFile(actor);
                });
                actorBtnRow.appendChild(saveActorBtn);
                item.appendChild(actorBtnRow);
            }
        }

        const nameEl = document.createElement('div');
        nameEl.className = 'scene-ui-item-name';
        nameEl.textContent = actor.rootNode.name || actor.id || 'Actor';

        const typeEl = document.createElement('div');
        typeEl.className = 'scene-ui-item-type';
        typeEl.textContent = actorInheritsCore(actor) ? 'instance' : (actor.kind || 'Actor');

        item.appendChild(nameEl);
        item.appendChild(typeEl);
        item.addEventListener('click', () => selectShowcaseActor(actor.id));
        item.addEventListener('dblclick', () => focusSceneActor(actor));
        return item;
    }

    function refreshSceneUI() {
        if (collisionDebugState.enabled) {
            refreshCollisionDebugOverlays();
        }

        if (!core.sceneUiList || !core.sceneUiCount) return;

        core.sceneUiList.innerHTML = '';

        if (!core.sceneSystem || core.sceneSystem.actors.size === 0) {
            core.sceneUiCount.textContent = '0 Actors';
            updateSceneActorDetailsUI();
            return;
        }

        const actors = Array.from(core.sceneSystem.actors);
        core.sceneUiCount.textContent = `${actors.length} Actor${actors.length !== 1 ? 's' : ''}`;

        actors.forEach((actor) => core.sceneUiList.appendChild(createSceneActorItem(actor)));

        const cores = actors.filter((actor) => !actorInheritsCore(actor)
            && actors.some((entry) => actorInheritsCore(entry) && getActorCoreSource(entry)?.id === actor.id));
        if (cores.length) {
            const folder = document.createElement('div');
            folder.className = 'scene-ui-folder scene-ui-core-bin';
            if (refreshSceneUI.coreBinCollapsed) {
                folder.classList.add('scene-ui-folder-collapsed');
            }

            const header = document.createElement('button');
            header.className = 'scene-ui-folder-header';
            header.type = 'button';
            header.textContent = 'Core Actors';

            const count = document.createElement('span');
            count.textContent = `${cores.length} parent${cores.length !== 1 ? 's' : ''}`;
            header.appendChild(count);
            header.addEventListener('click', () => {
                refreshSceneUI.coreBinCollapsed = !refreshSceneUI.coreBinCollapsed;
                refreshSceneUI();
            });
            folder.appendChild(header);

            if (!refreshSceneUI.coreBinCollapsed) {
                cores.forEach((actor) => {
                    const linked = actors.filter((entry) => actorInheritsCore(entry) && getActorCoreSource(entry)?.id === actor.id);
                    const row = createSceneActorItem(actor);
                    const type = row.querySelector('.scene-ui-item-type');
                    if (type) type.textContent = `parent core · ${linked.length} linked`;
                    folder.appendChild(row);
                });
            }

            core.sceneUiList.appendChild(folder);
        }
        updateSceneActorDetailsUI();
        return;

        /*
        actors.forEach(actor => {
            const item = document.createElement('div');
            item.className = 'scene-ui-item';
            item.dataset.id = actor.id;

            if (objectScriptState.targetPropId === actor.id) {
                item.style.background = 'linear-gradient(180deg, rgba(58, 43, 22, 0.98) 0%, rgba(42, 30, 15, 0.98) 100%)';
                item.style.borderColor = 'rgba(242, 163, 58, 0.58)';
                
                if (!blueprintState.active) {
                    const actorBtnRow = document.createElement('div');
                    actorBtnRow.className = 'scene-ui-item-actions';

                    const blueprintBtn = document.createElement('button');
                    blueprintBtn.className = 'btn btn-primary scene-ui-action-btn';
                    blueprintBtn.textContent = 'Edit Blueprint';
                    blueprintBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        enterBlueprintEditor();
                        syncBlueprintPhysicsEditor(actor);
                    });
                    actorBtnRow.appendChild(blueprintBtn);

                    const saveActorBtn = document.createElement('button');
                    saveActorBtn.className = 'btn scene-ui-action-btn scene-ui-save-btn';
                    saveActorBtn.textContent = '⬇ Save';
                    saveActorBtn.title = 'Download this actor as a .actor file';
                    saveActorBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        exportActorToFile(actor);
                    });
                    actorBtnRow.appendChild(saveActorBtn);

                    item.appendChild(actorBtnRow);
                }
            }

            const nameEl = document.createElement('div');
            nameEl.className = 'scene-ui-item-name';
            nameEl.textContent = actor.rootNode.name || actor.id || 'Actor';

            const typeEl = document.createElement('div');
            typeEl.className = 'scene-ui-item-type';
            typeEl.textContent = actor.kind || 'Actor';

            item.appendChild(nameEl);
            item.appendChild(typeEl);

            item.addEventListener('click', () => {
                selectShowcaseActor(actor.id);
            });

            item.addEventListener('dblclick', () => {
                const actorMesh = getActorRenderObject(actor);
                if (!gameplay.active && actorMesh) {
                    const targetPos = new THREE.Vector3();
                    actorMesh.getWorldPosition(targetPos);
                    
                    if (gsap) {
                        gsap.to(core.camera.position, {
                            x: targetPos.x + 2.5,
                            y: targetPos.y + 2.5,
                            z: targetPos.z + 2.5,
                            duration: 0.6,
                            ease: 'power2.out',
                            onUpdate: () => {
                                syncShowcaseAnglesFromTarget(targetPos);
                                applyShowcaseCameraRotation();
                            }
                        });
                    } else {
                        core.camera.position.set(targetPos.x + 2.5, targetPos.y + 2.5, targetPos.z + 2.5);
                        syncShowcaseAnglesFromTarget(targetPos);
                        applyShowcaseCameraRotation();
                    }
                }
            });

            core.sceneUiList.appendChild(item);
        });
        */
    }

    return {
        buildCollisionBoxComponent, getActorPhysicsSettings,
        clearActorPhysicsPreview, refreshActorPhysicsPreview,
        setActorPhysicsPreview, applyActorPhysicsSettings,
        syncBlueprintPhysicsEditor, applyBlueprintPhysicsEditor,
        getSceneActorDetailsRefs, getSelectedSceneActor,
        getActorDDGIVolumeComponent, getActorLightObject,
        syncActorLightStateFromObject, syncActorLightHelperVisuals,
        updateLightRangeVisualVisibility, syncDDGIVolumeComponentToActorBounds,
        updateSceneActorDetailsTransformButtons, updateSceneActorDetailsUI,
        applySceneActorTransformDetailsFromUI,
        applySceneActorDDGIDetailsFromUI, applySceneActorLightDetailsFromUI,
        createSceneActorItem, refreshSceneUI,
    };
}