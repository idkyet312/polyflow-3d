// src/editor/sceneHistory.js
// Extracted from main.js lines 11115–11468 (PIE snapshots, undo/redo history,
// clipboard, JSON world export/import, and component tree serialization).
// All module-scope dependencies are injected once by setupSceneHistory().

import * as THREE from 'three';

// Cross-module imports — these functions live in sceneSerialization.js.
import {
    serializeActorData,
    spawnActorFromSerializedData,
    clearSceneActors,
} from '../world/sceneSerialization.js';

// Module-scope deps — populated by setupSceneHistory, assigned once.
let sceneSystem, scene, transformControl;
let gameplay, blueprintState, objectScriptState, importedPropState;
let physics;
let getDynamicPropById, getActorRenderObject, getActorBody;
let serializeImportedPropTemplate, registerImportedPropTemplateFromSerializedData;
let saveObjectScriptDrafts, refreshSceneUI, selectShowcaseActor;
let buildPrimitiveActorMesh, applyObjectMaterialState, serializeObjectMaterialState;
let enterBlueprintEditor, exitBlueprintEditor, refreshBlueprintComponents;
let serializeWorldTerrainState, applyWorldTerrainState, refreshGameplayWorld, forceExitGameplayForWorldLoad;
let updateGameplayUI, updateWorldPresentation;

export function setupSceneHistory(deps) {
    ({
        sceneSystem,
        scene,
        transformControl,
        gameplay,
        blueprintState,
        objectScriptState,
        importedPropState,
        physics,
        getDynamicPropById,
        getActorRenderObject,
        getActorBody,
        serializeImportedPropTemplate,
        registerImportedPropTemplateFromSerializedData,
        saveObjectScriptDrafts,
        refreshSceneUI,
        selectShowcaseActor,
        buildPrimitiveActorMesh,
        applyObjectMaterialState,
        serializeObjectMaterialState,
        enterBlueprintEditor,
        exitBlueprintEditor,
        refreshBlueprintComponents,
        serializeWorldTerrainState,
        applyWorldTerrainState,
        refreshGameplayWorld,
        forceExitGameplayForWorldLoad,
        updateGameplayUI,
        updateWorldPresentation,
    } = deps);
}

// ─── lines 11115–11138 ───────────────────────────────────────────────────────────────────

let pieSceneSnapshot = null;

export function snapshotSceneState() {
    if (!sceneSystem) return;

    pieSceneSnapshot = {
        activeActorId: objectScriptState.targetPropId || '',
        scene: exportWorldToJSON(),
    };
}

export function restoreSceneState() {
    if (!pieSceneSnapshot || !sceneSystem) return;

    loadWorldFromJSON(pieSceneSnapshot.scene);

    if (pieSceneSnapshot.activeActorId) {
        selectShowcaseActor(pieSceneSnapshot.activeActorId);
    } else {
        selectShowcaseActor(null);
    }

    pieSceneSnapshot = null;
}

// ─── lines 11142–11258 ───────────────────────────────────────────────────────────────────

export function serializeComponentTree(object3D) {
    if (!object3D) return [];
    const comps = [];
    for (const child of object3D.children) {
        if (child.isMesh || child.isLight) {
            const entry = {
                type: child.isSpotLight ? 'SpotLight' : child.isPointLight ? 'PointLight' : (child.geometry?.type || 'Mesh'),
                name: child.name,
                position: child.position.toArray(),
                quaternion: child.quaternion.toArray(),
                scale: child.scale.toArray(),
                children: serializeComponentTree(child)
            };
            if (child.isMesh && child.material) {
                entry.material = serializeObjectMaterialState(child);
            }
            if (child.userData?.isCollisionShape) {
                entry.userData = {
                    isCollisionShape: true,
                    collisionShapeType: child.userData.collisionShapeType || 'box',
                    skipMaterialExport: true,
                };
            }
            if (child.isPointLight) {
                entry.light = {
                    color: '#' + child.color.getHexString(),
                    intensity: child.intensity,
                    distance: child.distance,
                    decay: child.decay,
                    castShadow: child.castShadow
                };
            }
            if (child.isSpotLight) {
                entry.light = {
                    color: '#' + child.color.getHexString(),
                    intensity: child.intensity,
                    distance: child.distance,
                    angle: child.angle,
                    penumbra: child.penumbra,
                    decay: child.decay,
                    castShadow: child.castShadow,
                    targetPosition: child.target?.position?.toArray?.() || [0, -1.5, 0],
                };
            }
            comps.push(entry);
        }
    }
    return comps;
}

export function deserializeComponentTree(parent, comps) {
    if (!comps || !comps.length) return;
    comps.forEach((compData, index) => {
        const existing = parent.children[index];
        const existingMatches = existing && (existing.isMesh || existing.isLight);
        let comp = existingMatches ? existing : null;

        if (!comp) {
            if (compData.type === 'SpotLight') {
                const lightColor = compData.light?.color ? new THREE.Color(compData.light.color) : 0xfff2cc;
                const lightIntensity = compData.light?.intensity ?? 6;
                const lightDistance = compData.light?.distance ?? 18;
                const lightAngle = compData.light?.angle ?? Math.PI / 6;
                const lightPenumbra = compData.light?.penumbra ?? 0.35;
                const lightDecay = compData.light?.decay ?? 2;
                comp = new THREE.SpotLight(lightColor, lightIntensity, lightDistance, lightAngle, lightPenumbra, lightDecay);
                comp.castShadow = true;
                comp.shadow.mapSize.set(1024, 1024);
                comp.target.position.fromArray(compData.light?.targetPosition || [0, -1.5, 0]);
                comp.add(comp.target);
            } else if (compData.type === 'PointLight') {
                const lightColor = compData.light?.color ? new THREE.Color(compData.light.color) : 0xffddaa;
                const lightIntensity = compData.light?.intensity ?? 2;
                const lightDistance = compData.light?.distance ?? 10;
                comp = new THREE.PointLight(lightColor, lightIntensity, lightDistance);
                comp.castShadow = true;
            } else if (compData.type === 'BoxGeometry') {
                comp = buildPrimitiveActorMesh('cube');
            } else if (compData.type === 'SphereGeometry') {
                comp = buildPrimitiveActorMesh('sphere');
            }

            if (comp) {
                parent.add(comp);
            }
        }

        if (!comp) return;

        if (compData.userData?.isCollisionShape) {
            comp.userData.isCollisionShape = true;
            comp.userData.collisionShapeType = compData.userData.collisionShapeType || 'box';
            comp.userData.skipMaterialExport = true;
            comp.name ||= 'Collision Box';
            comp.material = new THREE.MeshBasicMaterial({
                color: 0x22d3ee,
                transparent: true,
                opacity: 0.16,
                wireframe: true,
                depthTest: false,
            });
            comp.renderOrder = 20;
        }

        if (compData.name) comp.name = compData.name;
        if (Array.isArray(compData.position)) comp.position.fromArray(compData.position);
        if (Array.isArray(compData.quaternion)) comp.quaternion.fromArray(compData.quaternion);
        if (Array.isArray(compData.scale)) comp.scale.fromArray(compData.scale);

        if (comp.isMesh && compData.material) {
            applyObjectMaterialState(comp, compData.material);
        }
        if (comp.isPointLight && compData.light) {
            if (compData.light.color) comp.color = new THREE.Color(compData.light.color);
            if (Number.isFinite(compData.light.intensity)) comp.intensity = compData.light.intensity;
            if (Number.isFinite(compData.light.distance)) comp.distance = compData.light.distance;
            if (Number.isFinite(compData.light.decay)) comp.decay = compData.light.decay;
            if (typeof compData.light.castShadow === 'boolean') comp.castShadow = compData.light.castShadow;
        }
        if (comp.isSpotLight && compData.light) {
            if (compData.light.color) comp.color = new THREE.Color(compData.light.color);
            if (Number.isFinite(compData.light.intensity)) comp.intensity = compData.light.intensity;
            if (Number.isFinite(compData.light.distance)) comp.distance = compData.light.distance;
            if (Number.isFinite(compData.light.angle)) comp.angle = compData.light.angle;
            if (Number.isFinite(compData.light.penumbra)) comp.penumbra = compData.light.penumbra;
            if (Number.isFinite(compData.light.decay)) comp.decay = compData.light.decay;
            if (typeof compData.light.castShadow === 'boolean') comp.castShadow = compData.light.castShadow;
            if (Array.isArray(compData.light.targetPosition)) {
                comp.target.position.fromArray(compData.light.targetPosition);
            }
            if (comp.target.parent !== comp) {
                comp.add(comp.target);
            }
        }

        deserializeComponentTree(comp, compData.children);
    });
}

// ─── lines 11261–11337 ───────────────────────────────────────────────────────────────────

let editorClipboard = null;

function getActorCoreInfo(actor) {
    return actor?.userData?.actorCore ?? null;
}

function markActorAsCore(actor) {
    if (!actor) return '';

    const userData = { ...(actor.userData || {}) };
    const current = userData.actorCore || {};
    const coreId = current.coreId || actor.id;
    userData.actorCore = {
        coreId,
        inheritsRules: false,
    };
    actor.userData = userData;
    return coreId;
}

function prepareActorDuplicateData(sourceActor, actorData) {
    if (!sourceActor || !actorData) return actorData;

    const sourceCore = getActorCoreInfo(sourceActor);
    const coreId = sourceCore?.coreId || markActorAsCore(sourceActor);
    const userData = { ...(actorData.userData || {}) };
    userData.actorCore = {
        coreId,
        inheritsRules: true,
    };

    actorData.userData = userData;
    actorData.scripts = null;
    return actorData;
}

export function serializeActorToJSON(actor) {
    return serializeActorData(actor);
}

export function spawnActorFromJSON(actorData) {
    const actor = spawnActorFromSerializedData(actorData);
    if (actor) {
        saveObjectScriptDrafts();
        refreshSceneUI();
        selectShowcaseActor(actor.id);
    }
    return actor;
}

export function deleteSelectedActor() {
    editorHistory.captureState();
    const propId = objectScriptState.targetPropId;
    if (!propId) return;
    const prop = getDynamicPropById(propId);
    if (!prop) return;
    const body = getActorBody(prop);
    if (body && physics.bodyInterface) {
        physics.bodyInterface.RemoveBody(body.GetID());
        physics.bodyInterface.DestroyBody(body.GetID());
    }
    const mesh = getActorRenderObject(prop);
    if (mesh) scene.remove(mesh);
    sceneSystem.actors.delete(prop);
    if (transformControl) transformControl.detach();
    selectShowcaseActor(null);
    refreshSceneUI();
}

export function copySelectedToClipboard() {
    if (blueprintState.active) {
        const comp = blueprintState.selectedComponent;
        const rootMesh = getActorRenderObject(getDynamicPropById(objectScriptState.targetPropId));
        if (!comp || comp === rootMesh) return;
        const mockParent = { children: [comp] };
        editorClipboard = { type: 'component', data: serializeComponentTree(mockParent)[0] };
    } else {
        const propId = objectScriptState.targetPropId;
        if (!propId) return;
        const actor = getDynamicPropById(propId);
        if (!actor) return;
        editorClipboard = {
            type: 'actor',
            sourceActorId: actor.id,
            data: serializeActorToJSON(actor),
        };
    }
}

export function pasteFromClipboard() {
    editorHistory.captureState();
    if (!editorClipboard) return;
    if (blueprintState.active && editorClipboard.type === 'component') {
        const parent = blueprintState.selectedComponent || getActorRenderObject(getDynamicPropById(objectScriptState.targetPropId));
        if (!parent) return;
        const compData = JSON.parse(JSON.stringify(editorClipboard.data));
        compData.position[1] += 0.5;
        deserializeComponentTree(parent, [compData]);
        refreshBlueprintComponents();
    } else if (!blueprintState.active && editorClipboard.type === 'actor') {
        const actorData = JSON.parse(JSON.stringify(editorClipboard.data));
        const sourceActor = getDynamicPropById(editorClipboard.sourceActorId);
        prepareActorDuplicateData(sourceActor, actorData);
        actorData.transform.position[1] += 1;
        actorData.transform.position[0] += 1;
        actorData.name += ' (Copy)';
        spawnActorFromJSON(actorData);
    }
}

export function duplicateSelected() {
    copySelectedToClipboard();
    editorHistory.captureState();
    pasteFromClipboard();
}

// ─── lines 11340–11411 ───────────────────────────────────────────────────────────────────

export const editorHistory = {
    undoStack: [],
    redoStack: [],
    maxStates: 50,
    isRestoring: false,

    captureState() {
        if (this.isRestoring || (typeof gameplay !== 'undefined' && gameplay.active)) return;
        const state = {
            activeActorId: objectScriptState.targetPropId,
            blueprintActive: blueprintState.active,
            blueprintComponentUuid: blueprintState.selectedComponent?.uuid,
            scene: exportWorldToJSON()
        };
        this.undoStack.push(state);
        if (this.undoStack.length > this.maxStates) {
            this.undoStack.shift();
        }
        this.redoStack = [];
    },

    undo() {
        if (this.undoStack.length === 0 || (typeof gameplay !== 'undefined' && gameplay.active)) return;
        this.isRestoring = true;

        const currentState = {
            activeActorId: objectScriptState.targetPropId,
            blueprintActive: blueprintState.active,
            blueprintComponentUuid: blueprintState.selectedComponent?.uuid,
            scene: exportWorldToJSON()
        };
        this.redoStack.push(currentState);

        const state = this.undoStack.pop();
        this.restoreState(state);
        this.isRestoring = false;
    },

    redo() {
        if (this.redoStack.length === 0 || (typeof gameplay !== 'undefined' && gameplay.active)) return;
        this.isRestoring = true;

        const currentState = {
            activeActorId: objectScriptState.targetPropId,
            blueprintActive: blueprintState.active,
            blueprintComponentUuid: blueprintState.selectedComponent?.uuid,
            scene: exportWorldToJSON()
        };
        this.undoStack.push(currentState);

        const state = this.redoStack.pop();
        this.restoreState(state);
        this.isRestoring = false;
    },

    restoreState(state) {
        if (typeof transformControl !== 'undefined' && transformControl) transformControl.detach();
        loadWorldFromJSON(state.scene);

        if (state.activeActorId) {
            selectShowcaseActor(state.activeActorId);
            if (state.blueprintActive) {
                enterBlueprintEditor();
            } else {
                exitBlueprintEditor();
            }
        } else {
            selectShowcaseActor(null);
            exitBlueprintEditor();
        }
    }
};

// ─── lines 11413–11444 ───────────────────────────────────────────────────────────────────

export function exportWorldToJSON({ preferAssetPath = false } = {}) {
    const umap = { version: 3, actors: [], importedTemplates: [] };
    const usedTemplateIds = new Set();
    for (const actor of (sceneSystem?.actors || [])) {
        const serializedActor = serializeActorData(actor);
        if (!serializedActor) continue;
        umap.actors.push(serializedActor);
        if (serializedActor.kind === 'imported' && serializedActor.templateId) {
            usedTemplateIds.add(serializedActor.templateId);
        }
        if (serializedActor.kind === 'vehicle' && serializedActor.vehicleBodyTemplateId) {
            usedTemplateIds.add(serializedActor.vehicleBodyTemplateId);
        }
        if (serializedActor.kind === 'vehicle' && serializedActor.vehicleWheelTemplateId) {
            usedTemplateIds.add(serializedActor.vehicleWheelTemplateId);
        }
    }

    usedTemplateIds.forEach((templateId) => {
        const template = importedPropState.templates.find((entry) => entry.id === templateId);
        const serializedTemplate = serializeImportedPropTemplate(template, { preferAssetPath });
        if (serializedTemplate) {
            umap.importedTemplates.push(serializedTemplate);
        }
    });

    if (umap.importedTemplates.length === 0) {
        delete umap.importedTemplates;
    }

    const worldTerrain = serializeWorldTerrainState?.();
    if (worldTerrain?.terrain || worldTerrain?.foliage) {
        umap.worldTerrain = worldTerrain;
    }

    return umap;
}

// ─── lines 11446–11468 ───────────────────────────────────────────────────────────────────

export async function loadWorldFromJSON(umap, { fileMap = null } = {}) {
    if (umap.version !== 1 && umap.version !== 2 && umap.version !== 3) console.warn('Unknown umap version', umap.version);
    forceExitGameplayForWorldLoad?.();
    clearSceneActors();
    applyWorldTerrainState?.(umap.worldTerrain ?? {});

    if (Array.isArray(umap.importedTemplates)) {
        for (const templateData of umap.importedTemplates) {
            try {
                await registerImportedPropTemplateFromSerializedData(templateData, { fileMap });
            } catch (error) {
                console.error('Failed to restore imported template from .umap.', error, templateData);
            }
        }
    }

    for (const actorData of umap.actors) {
        spawnActorFromSerializedData(actorData, { preserveId: true });
    }
    refreshGameplayWorld?.();
    if (physics?.ready) {
        gameplay.canPlay = true;
        updateWorldPresentation?.();
        updateGameplayUI?.();
    }
    saveObjectScriptDrafts();
    refreshSceneUI();
}
