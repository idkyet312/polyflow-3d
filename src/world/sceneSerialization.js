// src/world/sceneSerialization.js
// Extracted from main.js lines 9531–10135 (scene serialization / actor I/O).
// All module-scope dependencies are injected once by setupSceneSerialization().

import * as THREE from 'three';
import { DDGIVolumeComponent, createActor } from '../runtime/sceneRuntime.js';
import { createTerrainMesh, applySerializedTerrainState, setTerrainModeGrid, serializeTerrainState } from './terrain.js';

// Module-scope deps — populated by setupSceneSerialization, assigned once.
let scene, camera, sceneSystem, physics, importedPropState, objectScriptState, VEHICLE_SETTINGS;
let getActorBody, getActorRenderObject, getActorScriptState;
let serializeObjectMaterialState, serializeObjectMaterialOverrides;
let applyObjectMaterialState, applyObjectMaterialOverrides;
let serializeImportedPropTemplate, registerImportedPropTemplateFromSerializedData;
let spawnDrivableCar, spawnImportedProp, spawnDDGIVolumeActor, spawnDynamicPrimitive, spawnLightActor;
let syncRuntimePropIdCounter, rebuildActorPhysics, syncPropScriptState;
let destroyDynamicPhysicsProp, getDynamicPropDisplayName;
let saveObjectScriptDrafts, refreshSceneUI, selectShowcaseActor;
let ensureVehicleVisualState, serializeComponentTree, deserializeComponentTree;
let reattachRestoredActor;
// editorHistory and loadWorldFromJSON are injected to avoid a circular import
// cycle (sceneHistory.js imports serializeActorData / clearSceneActors from
// this module, so a static import back would be circular).
let editorHistory, loadWorldFromJSON;

export function setupSceneSerialization(deps) {
    ({
        scene,
        camera,
        sceneSystem,
        physics,
        importedPropState,
        objectScriptState,
        VEHICLE_SETTINGS,
        getActorBody,
        getActorRenderObject,
        getActorScriptState,
        serializeObjectMaterialState,
        serializeObjectMaterialOverrides,
        applyObjectMaterialState,
        applyObjectMaterialOverrides,
        serializeImportedPropTemplate,
        registerImportedPropTemplateFromSerializedData,
        spawnDrivableCar,
        spawnImportedProp,
        spawnDDGIVolumeActor,
        spawnDynamicPrimitive,
        spawnLightActor,
        syncRuntimePropIdCounter,
        rebuildActorPhysics,
        syncPropScriptState,
        destroyDynamicPhysicsProp,
        getDynamicPropDisplayName,
        saveObjectScriptDrafts,
        refreshSceneUI,
        selectShowcaseActor,
        ensureVehicleVisualState,
        serializeComponentTree,
        deserializeComponentTree,
        reattachRestoredActor,
        editorHistory,
        loadWorldFromJSON,
    } = deps);
}

function getEmbeddedMaterialFallbackType(type = '') {
    switch (type) {
    case 'DDGIMeshStandardNodeMaterial':
    case 'MeshStandardNodeMaterial':
        return 'MeshStandardMaterial';
    case 'MeshPhysicalNodeMaterial':
        return 'MeshPhysicalMaterial';
    case 'MeshPhongNodeMaterial':
        return 'MeshPhongMaterial';
    case 'MeshLambertNodeMaterial':
        return 'MeshLambertMaterial';
    case 'MeshBasicNodeMaterial':
        return 'MeshBasicMaterial';
    case 'MeshNormalNodeMaterial':
        return 'MeshNormalMaterial';
    case 'SpriteNodeMaterial':
        return 'SpriteMaterial';
    case 'PointsNodeMaterial':
        return 'PointsMaterial';
    case 'LineBasicNodeMaterial':
        return 'LineBasicMaterial';
    default:
        return type;
    }
}

function sanitizeEmbeddedMaterialJson(materialJson) {
    if (!materialJson || typeof materialJson !== 'object') return materialJson;

    const nextType = getEmbeddedMaterialFallbackType(materialJson.type);
    if (!nextType || nextType === materialJson.type) {
        return materialJson;
    }

    materialJson.type = nextType;

    delete materialJson.inputNodes;
    delete materialJson.nodes;
    delete materialJson.outputNode;
    delete materialJson.vertexNode;
    delete materialJson.fragmentNode;
    delete materialJson.colorNode;
    delete materialJson.normalNode;
    delete materialJson.opacityNode;
    delete materialJson.backdropNode;
    delete materialJson.backdropAlphaNode;
    delete materialJson.alphaTestNode;
    delete materialJson.positionNode;
    delete materialJson.depthNode;
    delete materialJson.shadowNode;
    delete materialJson.receivedShadowNode;
    delete materialJson.castShadowNode;
    delete materialJson.lightsNode;
    delete materialJson.envNode;
    delete materialJson.aoNode;

    return materialJson;
}

function sanitizeEmbeddedRootJson(rootJson) {
    if (!rootJson || typeof rootJson !== 'object') return rootJson;

    if (Array.isArray(rootJson.materials)) {
        rootJson.materials.forEach((materialJson) => sanitizeEmbeddedMaterialJson(materialJson));
    }

    return rootJson;
}

// ─── lines 9531–9577 ─────────────────────────────────────────────────────────────────────

export async function loadWorldFromSceneFolder(fileList) {
    if (!fileList || fileList.length === 0) return;

    const fileMap = Object.create(null);
    let umapFile = null;

    for (const file of fileList) {
        const relPath = file.webkitRelativePath || file.name;
        const idx = relPath.indexOf('/');
        const inFolderPath = idx >= 0 ? relPath.slice(idx + 1) : relPath;
        fileMap[inFolderPath] = { file, url: URL.createObjectURL(file) };
        if (!fileMap[file.name]) {
            fileMap[file.name] = { file, url: URL.createObjectURL(file) };
        }
        if (!fileMap[file.name.toLowerCase()]) {
            fileMap[file.name.toLowerCase()] = fileMap[file.name];
        }
        if (inFolderPath === 'scene.umap' || file.name === 'scene.umap') {
            umapFile = file;
        }
    }

    if (!umapFile) {
        alert('Pick a folder that contains scene.umap.');
        return;
    }

    let umap;
    try {
        umap = JSON.parse(await umapFile.text());
    } catch (err) {
        console.error('Failed to parse scene.umap.', err);
        alert('scene.umap is not valid JSON.');
        return;
    }

    editorHistory.captureState();
    try {
        await loadWorldFromJSON(umap, { fileMap });
    } catch (err) {
        console.error('Failed to load scene folder.', err);
        alert('Failed to load scene folder. See console for details.');
    }
}

// ─── lines 9580–9612 ─────────────────────────────────────────────────────────────────────

export function getActorComponentFlags(actor) {
    if (!actor) {
        return { collision: false, physics: false, scripts: false };
    }

    const storedFlags = actor._componentFlags || null;
    const hasBody = !!getActorBody(actor);
    const includeCollisionBody = typeof storedFlags?.collision === 'boolean'
        ? storedFlags.collision
        : hasBody;
    const includeScripts = typeof storedFlags?.scripts === 'boolean'
        ? storedFlags.scripts
        : !!getActorScriptState(actor);

    let simulatePhysics = false;
    if (includeCollisionBody) {
        if (typeof storedFlags?.physics === 'boolean') {
            simulatePhysics = storedFlags.physics;
        } else if (physics.dynamicBodies.includes(actor)) {
            simulatePhysics = true;
        } else if (physics.staticBodies.includes(actor)) {
            simulatePhysics = false;
        } else {
            simulatePhysics = true;
        }
    }

    return {
        collision: !!includeCollisionBody,
        physics: !!includeCollisionBody && !!simulatePhysics,
        scripts: !!includeScripts,
    };
}

// ─── lines 9614–9627 ─────────────────────────────────────────────────────────────────────

export function setActorComponentFlags(actor, flags = {}) {
    if (!actor) {
        return { collision: false, physics: false, scripts: false };
    }

    const normalizedFlags = {
        collision: flags.collision !== false,
        physics: flags.collision === false ? false : flags.physics !== false,
        scripts: !!flags.scripts,
    };

    actor._componentFlags = normalizedFlags;
    return normalizedFlags;
}

// ─── lines 9629–9656 ─────────────────────────────────────────────────────────────────────

export function normalizeSerializedActorComponentFlags(actorData = {}) {
    const rawFlags = actorData.componentFlags || actorData.componentState || null;
    const includeCollisionBody = actorData.kind === 'vehicle'
        ? true
        : typeof rawFlags?.collision === 'boolean'
            ? rawFlags.collision
            : typeof rawFlags?.includeCollisionBody === 'boolean'
                ? rawFlags.includeCollisionBody
                : true;
    const simulatePhysics = includeCollisionBody && (actorData.kind === 'vehicle'
        ? true
        : typeof rawFlags?.physics === 'boolean'
            ? rawFlags.physics
            : typeof rawFlags?.simulatePhysics === 'boolean'
                ? rawFlags.simulatePhysics
                : true);
    const includeScripts = typeof rawFlags?.scripts === 'boolean'
        ? rawFlags.scripts
        : typeof rawFlags?.includeScripts === 'boolean'
            ? rawFlags.includeScripts
            : !!actorData.scripts;

    return {
        collision: !!includeCollisionBody,
        physics: !!includeCollisionBody && !!simulatePhysics,
        scripts: !!includeScripts,
    };
}

// ─── lines 9658–9699 ─────────────────────────────────────────────────────────────────────

export function serializeActorData(actor) {
    if (!actor) return null;

    const mesh = getActorRenderObject(actor);
    if (!mesh) return null;

    const dirtyMaterials = mesh.userData.hasMaterialOverrides === true;

    let userDataForSerialization = actor.entity.getComponent('metadata')?.userData || null;
    if (actor.kind === 'ddgiVolume') {
        const ddgi = actor.getComponentByClass?.(DDGIVolumeComponent)
            || actor.GetComponent?.(DDGIVolumeComponent);
        if (ddgi?.serialize) {
            userDataForSerialization = { ...(userDataForSerialization || {}), ddgi: ddgi.serialize() };
        }
    }

    const actorCore = userDataForSerialization?.actorCore;
    const inheritsRules = actorCore?.inheritsRules === true
        && typeof actorCore.coreId === 'string'
        && actorCore.coreId
        && actorCore.coreId !== actor.id;
    const isFlatTerrainActor = userDataForSerialization?.flatTerrainActor === true;
    const embeddedRootJson = actor.kind === 'imported' && !actor.templateId && !isFlatTerrainActor
        ? sanitizeEmbeddedRootJson(mesh.toJSON())
        : null;
    const terrainState = isFlatTerrainActor
        ? serializeTerrainState(mesh)
        : null;

    return {
        id: actor.id,
        kind: actor.kind,
        name: actor.rootNode?.name || 'Actor',
        templateId: actor.templateId,
        vehicleBodyTemplateId: actor.vehicleBodyTemplateId || null,
        vehicleWheelTemplateId: actor.vehicleWheelTemplateId || null,
        userData: userDataForSerialization,
        transform: {
            position: mesh.position.toArray(),
            quaternion: mesh.quaternion.toArray(),
            scale: mesh.scale.toArray(),
        },
        material: dirtyMaterials ? serializeObjectMaterialState(mesh) : null,
        materialOverrides: dirtyMaterials ? serializeObjectMaterialOverrides(mesh) : [],
        scripts: inheritsRules ? null : objectScriptState.drafts[actor.id] || null,
        componentFlags: getActorComponentFlags(actor),
        components: serializeComponentTree(mesh),
        terrainState,
        rootJson: embeddedRootJson,
    };
}

// ─── lines 9701–9866 ─────────────────────────────────────────────────────────────────────

function computeCameraFrontSpawn(distance = 4.5, up = 1.2) {
    if (!camera) return new THREE.Vector3();
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    if (Math.abs(dir.y) > 0.72) dir.y *= 0.35;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    else dir.normalize();
    return camera.position.clone().addScaledVector(dir, distance).addScaledVector(new THREE.Vector3(0, 1, 0), up);
}

function serializedActorInheritsRules(actorData = {}) {
    const core = actorData.userData?.actorCore;
    return core?.inheritsRules === true && typeof core.coreId === 'string' && core.coreId && core.coreId !== actorData.id;
}

function spawnSerializedFlatTerrainActor(actorData) {
    const mesh = createTerrainMesh();
    mesh.name = actorData.name || 'Flat_Terrain_Surface';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    setTerrainModeGrid(mesh);
    applySerializedTerrainState(mesh, actorData.terrainState);

    const actor = createActor({
        name: actorData.name || 'Actor',
        kind: actorData.kind,
        mesh,
        body: null,
        templateId: actorData.templateId || '',
        userData: actorData.userData,
    });
    sceneSystem?.addActor?.(actor);
    return actor;
}

export function spawnActorFromSerializedData(actorData, { preserveId = false, spawnInFrontOfPlayer = false } = {}) {
    if (!actorData) return null;

    const componentFlags = normalizeSerializedActorComponentFlags(actorData);
    const savedScripts = !serializedActorInheritsRules(actorData) && actorData.scripts
        ? JSON.parse(JSON.stringify(actorData.scripts))
        : null;
    let tempScriptId = '';

    if (savedScripts) {
        tempScriptId = `loaded-actor-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        objectScriptState.drafts[tempScriptId] = savedScripts;
    }

    let scale = 1;
    if (actorData.kind === 'sphere' || actorData.kind === 'cube' || actorData.kind === 'capsule') {
        scale = actorData.transform.scale[0];
    }

    const hasEmbeddedRoot = !!actorData.rootJson;
    const isFlatTerrainActor = actorData.userData?.flatTerrainActor === true;

    let actor = null;
    if (actorData.kind === 'vehicle') {
        const savedBodyTemplateId = actorData.vehicleBodyTemplateId
            && importedPropState.templates.some((template) => template.id === actorData.vehicleBodyTemplateId)
            ? actorData.vehicleBodyTemplateId
            : '';
        const savedWheelTemplateId = actorData.vehicleWheelTemplateId
            && importedPropState.templates.some((template) => template.id === actorData.vehicleWheelTemplateId)
            ? actorData.vehicleWheelTemplateId
            : '';
        actor = spawnDrivableCar({
            includeScripts: componentFlags.scripts,
            userData: actorData.userData,
            bodyTemplateId: savedBodyTemplateId,
            wheelTemplateId: savedWheelTemplateId,
        });
    } else if (actorData.kind === 'imported') {
        if (isFlatTerrainActor && actorData.terrainState) {
            actor = spawnSerializedFlatTerrainActor(actorData);
        } else if (hasEmbeddedRoot) {
            const mesh = new THREE.ObjectLoader().parse(sanitizeEmbeddedRootJson(actorData.rootJson));
            actor = createActor({
                name: actorData.name || 'Actor',
                kind: actorData.kind,
                mesh,
                body: null,
                templateId: actorData.templateId || '',
                userData: actorData.userData,
            });
            sceneSystem?.addActor?.(actor);
        } else if (!actorData.templateId || !importedPropState.templates.some((template) => template.id === actorData.templateId)) {
            if (tempScriptId) {
                delete objectScriptState.drafts[tempScriptId];
            }
            alert('This actor requires an imported prop source (template) that is not currently loaded. Import the matching prop file first, then try loading this actor again.');
            return null;
        } else {
            actor = spawnImportedProp(actorData.templateId, {
                includeScripts: componentFlags.scripts,
                userData: actorData.userData,
                includeCollisionBody: componentFlags.collision,
                simulatePhysics: componentFlags.physics,
            });
        }
    } else if (actorData.kind === 'pointLight' || actorData.kind === 'spotLight') {
        const savedPos = spawnInFrontOfPlayer
            ? computeCameraFrontSpawn(6, 0.6)
            : new THREE.Vector3().fromArray(actorData.transform.position);
        actor = spawnLightActor(actorData.kind, {
            includeScripts: componentFlags.scripts,
            userData: actorData.userData || null,
            position: savedPos,
            scale: actorData.userData?.light?.radius ?? 8,
        });
    } else if (actorData.kind === 'ddgiVolume') {
        const savedPos = spawnInFrontOfPlayer
            ? computeCameraFrontSpawn(8, 0)
            : new THREE.Vector3().fromArray(actorData.transform.position);
        const savedScale = new THREE.Vector3().fromArray(actorData.transform.scale || [1, 1, 1]);
        const size = new THREE.Vector3(32, 16, 32).multiply(savedScale);
        const ddgiOptions = actorData.userData?.ddgi || {};
        actor = spawnDDGIVolumeActor({
            userData: actorData.userData || null,
            position: savedPos,
            size,
            options: ddgiOptions,
        });
    } else {
        const savedPos = spawnInFrontOfPlayer
            ? computeCameraFrontSpawn()
            : new THREE.Vector3().fromArray(actorData.transform.position);
        actor = spawnDynamicPrimitive(actorData.kind, savedPos, scale, {
            includeScripts: componentFlags.scripts,
            userData: actorData.userData,
            returnActor: true,
            includeCollisionBody: componentFlags.collision,
            simulatePhysics: componentFlags.physics,
            local: false,
            skipImpulse: true,
        });
    }

    if (!actor) {
        if (tempScriptId) {
            delete objectScriptState.drafts[tempScriptId];
        }
        return null;
    }

    const previousId = actor.id;
    if (preserveId && actorData.id) {
        actor.id = actorData.id;
        syncRuntimePropIdCounter(actor.id);
    }

    setActorComponentFlags(actor, componentFlags);

    if (tempScriptId) {
        const restoredScripts = objectScriptState.drafts[tempScriptId];
        delete objectScriptState.drafts[tempScriptId];
        if (restoredScripts) {
            objectScriptState.drafts[actor.id] = restoredScripts;
        }
    }

    if (previousId !== actor.id && objectScriptState.drafts[previousId]) {
        delete objectScriptState.drafts[previousId];
    }

    if (actorData.name) {
        actor.rootNode.name = actorData.name;
    }

    const mesh = getActorRenderObject(actor);
    if (mesh) {
        reattachRestoredActor?.(actor, actorData);
        mesh.userData.dynamicPropId = actor.id;
        if (spawnInFrontOfPlayer) {
            mesh.position.copy(computeCameraFrontSpawn());
        } else {
            mesh.position.fromArray(actorData.transform.position);
        }
        mesh.quaternion.fromArray(actorData.transform.quaternion);
        mesh.scale.fromArray(actorData.transform.scale);
        deserializeComponentTree(mesh, actorData.components);
        if (Array.isArray(actorData.materialOverrides) && actorData.materialOverrides.length > 0) {
            applyObjectMaterialOverrides(mesh, actorData.materialOverrides);
            mesh.userData.hasMaterialOverrides = true;
        } else if (actorData.material) {
            applyObjectMaterialState(mesh, actorData.material);
            mesh.userData.hasMaterialOverrides = true;
        }
        mesh.updateMatrixWorld(true);
        if (actorData.kind === 'vehicle') {
            const body = getActorBody(actor);
            if (body && physics.ready) {
                const { Jolt, bodyInterface } = physics;
                const joltPos = new Jolt.Vec3(mesh.position.x, mesh.position.y, mesh.position.z);
                const joltRot = new Jolt.Quat(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w);
                bodyInterface.SetPositionAndRotation(body.GetID(), joltPos, joltRot, Jolt.EActivation_Activate);
                bodyInterface.SetLinearVelocity(body.GetID(), Jolt.Vec3.prototype.sZero());
                bodyInterface.SetAngularVelocity(body.GetID(), Jolt.Vec3.prototype.sZero());
                bodyInterface.SetMaxAngularVelocity(body.GetID(), VEHICLE_SETTINGS.maxAngularVelocity);
                Jolt.destroy(joltPos);
                Jolt.destroy(joltRot);
            }

            const visualState = ensureVehicleVisualState(mesh);
            if (visualState?.lastWorldPosition instanceof THREE.Vector3) {
                mesh.getWorldPosition(visualState.lastWorldPosition);
                visualState.lastPositionInitialized = true;
            }
        }
        if (actorData.kind === 'imported') {
            rebuildActorPhysics(actor);
        }
    }

    if (componentFlags.scripts) {
        syncPropScriptState(actor);
    }

    return actor;
}

// ─── lines 9868–9921 ─────────────────────────────────────────────────────────────────────

export function exportActorToFile(actor) {
    if (!actor) return;

    const serializedActor = serializeActorData(actor);
    if (!serializedActor) return;

    const usedTemplateIds = new Set();
    if (serializedActor.kind === 'imported' && serializedActor.templateId) {
        usedTemplateIds.add(serializedActor.templateId);
    }
    if (serializedActor.kind === 'vehicle' && serializedActor.vehicleBodyTemplateId) {
        usedTemplateIds.add(serializedActor.vehicleBodyTemplateId);
    }
    if (serializedActor.kind === 'vehicle' && serializedActor.vehicleWheelTemplateId) {
        usedTemplateIds.add(serializedActor.vehicleWheelTemplateId);
    }

    const importedTemplates = [];
    usedTemplateIds.forEach((templateId) => {
        const template = importedPropState.templates.find((entry) => entry.id === templateId);
        const serializedTemplate = serializeImportedPropTemplate(template, { preferAssetPath: false });
        if (serializedTemplate) {
            importedTemplates.push(serializedTemplate);
        }
    });

    const actorData = {
        version: 1,
        type: 'polyflow-actor',
        actor: serializedActor
    };

    if (importedTemplates.length > 0) {
        actorData.importedTemplates = importedTemplates;
    }

    const displayName = getDynamicPropDisplayName(actor)
        .replace(/[^a-zA-Z0-9_\- ]/g, '')
        .replace(/\s+/g, '_')
        .toLowerCase() || 'actor';
    const blob = new Blob([JSON.stringify(actorData)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${displayName}.actor`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
}

// ─── lines 9926–9965 ─────────────────────────────────────────────────────────────────────

// Reuses the existing #processing-overlay panel for any long-running task.
export const progressOverlay = {
    el: null,
    titleEl: null,
    barEl: null,
    stepEl: null,
    show(title, step = '') {
        this.el ||= document.getElementById('processing-overlay');
        this.titleEl ||= document.getElementById('processing-title');
        this.barEl ||= document.getElementById('loader-bar');
        this.stepEl ||= document.getElementById('processing-step');
        if (!this.el) return;
        if (this.titleEl) this.titleEl.textContent = title;
        if (this.stepEl) this.stepEl.textContent = step;
        if (this.barEl) this.barEl.style.width = '0%';
        this.el.style.display = 'flex';
    },
    update(percent, step) {
        if (this.barEl && Number.isFinite(percent)) {
            this.barEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        }
        if (this.stepEl && step !== undefined) {
            this.stepEl.textContent = step;
        }
    },
    hide() {
        if (this.el) {
            this.el.style.display = 'none';
            this.el.style.pointerEvents = 'none';
        }
    },
};

export function yieldToPaint() {
    return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
}

// ─── lines 9967–10034 ────────────────────────────────────────────────────────────────────

export async function loadActorFromFile(file, options = {}) {
    if (!file) return;
    const {
        askSpawnLocation = true,
        spawnInFrontOfPlayer = false,
    } = options;

    const fileSizeMb = (file.size / (1024 * 1024)).toFixed(1);
    progressOverlay.show('Loading Actor', `Reading ${file.name} (${fileSizeMb} MB)...`);
    await yieldToPaint();

    try {
        const text = await readFileAsTextWithProgress(file, (loaded, total) => {
            if (total > 0) {
                progressOverlay.update((loaded / total) * 60, `Reading ${(loaded / (1024 * 1024)).toFixed(1)} / ${fileSizeMb} MB`);
            }
        });

        progressOverlay.update(65, 'Parsing JSON...');
        await yieldToPaint();

        const data = JSON.parse(text);
        if (data.type !== 'polyflow-actor' || !data.actor) {
            alert('This file is not a valid PolyFlow actor file.');
            return;
        }

        if (data.importedTemplates && Array.isArray(data.importedTemplates)) {
            progressOverlay.update(70, 'Loading templates...');
            await yieldToPaint();
            for (const templateData of data.importedTemplates) {
                try {
                    await registerImportedPropTemplateFromSerializedData(templateData);
                } catch (e) {
                    console.error('Failed to load template for actor:', e);
                }
            }
        }

        progressOverlay.update(75, 'Spawning actor...');
        await yieldToPaint();

        const actorData = data.actor;
        let shouldSpawnInFront = spawnInFrontOfPlayer;
        if (askSpawnLocation) {
            // OK = saved location, Cancel = in front of camera.
            const useSavedLocation = window.confirm(
                'Spawn actor at its saved location?\n\nOK  = Saved location\nCancel = In front of camera'
            );
            shouldSpawnInFront = !useSavedLocation;
        }
        const actor = spawnActorFromSerializedData(actorData, {
            spawnInFrontOfPlayer: shouldSpawnInFront,
        });

        if (!actor) {
            alert('Failed to spawn the loaded actor. Physics may not be ready yet.');
            return;
        }

        progressOverlay.update(92, 'Restoring scripts...');
        await yieldToPaint();
        saveObjectScriptDrafts();

        progressOverlay.update(98, 'Refreshing scene UI...');
        await yieldToPaint();
        refreshSceneUI();
        selectShowcaseActor(actor.id);

        progressOverlay.update(100, 'Done.');
    } catch (err) {
        console.error('Error loading actor file', err);
        alert('Failed to load actor file. It may be corrupt or in an unsupported format.');
    } finally {
        progressOverlay.hide();
    }
}

// ─── lines 10036–10048 ───────────────────────────────────────────────────────────────────

export function readFileAsTextWithProgress(file, onProgress) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onprogress = (e) => {
            if (e.lengthComputable && typeof onProgress === 'function') {
                onProgress(e.loaded, e.total);
            }
        };
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
        reader.readAsText(file);
    });
}

// ─── lines 10050–10068 ───────────────────────────────────────────────────────────────────

export function clearSceneActors() {
    if (!sceneSystem) return;
    const actorsToDestroy = Array.from(sceneSystem.actors);
    for (const actor of actorsToDestroy) {
        destroyDynamicPhysicsProp(actor);
        sceneSystem.removeActor(actor);
    }

    physics.dynamicBodies.length = 0;
    physics.staticBodies.length = 0;
    selectShowcaseActor(null);
}

// ─── lines 10070–10083 ───────────────────────────────────────────────────────────────────

export function loadWorldFromUmap(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const umap = JSON.parse(e.target.result);
            editorHistory.captureState();
            await loadWorldFromJSON(umap);
        } catch (err) {
            console.error('Error loading scene file', err);
            alert('Failed to load scene file.');
        }
    };
    reader.readAsText(file);
}
