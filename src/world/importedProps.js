// src/world/importedProps.js
// Extracted from main.js (chore/main-js-shrink-2). Owns all logic for the
// imported-prop sidebar: collision prompts, simple/exact/convex/complex shape
// builders, the prop library DOM rendering, registering/serializing template
// metadata, the spawn flow, and the inline OBJ/UMAP file importer.
//
// Asset-loading helpers (cloneDisposableObject, loadObjectFromFile, …) come
// through the io/objectLoader.js module — passed as deps for now to avoid
// adding direct imports during this mechanical shrink pass.

import * as THREE from 'three';

let physics, importedPropState;
let scene, camera;
let importedPropList, importedPropLibrary;
let propCollisionPrompt, propCollisionCopy, propCollisionRemember;
let propImportDefaultStatus, resetPropImportDefaultBtn;
let IMPORTED_PROP_COLLISION_LABELS, IMPORTED_PROP_COMPLEX_HULL_RADIUS;
let IMPORTED_PROP_MAX_HULL_PARTS, IMPORTED_PROP_MAX_HULL_POINTS, PROP_TARGET_MAX_DIMENSION;
let tempVectorA, tempVectorB, tempVectorC, tempVectorD, tempVectorE;
let cloneDisposableObject, formatImportedPropName, normalizeObjectToDimension;
let createLoadingManager, convertLoadedObjectMaterials, loadObjectFromFile, processTrigger;
let createDynamicPropActor, setActorComponentFlags;
let countTrianglesForObject;
let createDynamicPrimitiveBody, createStaticMeshBody, createOwnedShape;
let getDynamicPropSpawn;
let syncActorEditorTemplateOptions, openActorEditor;
let disposeRenderableObject, playObjectAnimation;
let runOptimizationPipeline;
let getResetPropImportDefault, setResetPropImportDefault;

export function installImportedProps(deps) {
    ({
        physics, importedPropState,
        scene, camera,
        importedPropList, importedPropLibrary,
        propCollisionPrompt, propCollisionCopy, propCollisionRemember,
        propImportDefaultStatus, resetPropImportDefaultBtn,
        IMPORTED_PROP_COLLISION_LABELS, IMPORTED_PROP_COMPLEX_HULL_RADIUS,
        IMPORTED_PROP_MAX_HULL_PARTS, IMPORTED_PROP_MAX_HULL_POINTS, PROP_TARGET_MAX_DIMENSION,
        tempVectorA, tempVectorB, tempVectorC, tempVectorD, tempVectorE,
        cloneDisposableObject, formatImportedPropName, normalizeObjectToDimension,
        createLoadingManager, convertLoadedObjectMaterials, loadObjectFromFile, processTrigger,
        createDynamicPropActor, setActorComponentFlags,
        countTrianglesForObject,
        createDynamicPrimitiveBody, createStaticMeshBody, createOwnedShape,
        getDynamicPropSpawn,
        syncActorEditorTemplateOptions, openActorEditor,
        disposeRenderableObject, playObjectAnimation,
        runOptimizationPipeline,
        getResetPropImportDefault, setResetPropImportDefault,
    } = deps);
}

export function enableOptimizationPipeline() {
    if (!processTrigger) return;
    processTrigger.style.opacity = '1';
    processTrigger.style.cursor = 'pointer';
    processTrigger.onclick = runOptimizationPipeline;
}

export function updateLoadedAssetStats(name, fileSize, root) {
    document.getElementById('asset-name').textContent = name;
    document.getElementById('tri-count').textContent = 'Counting...';

    originalFileSize = fileSize;
    document.getElementById('file-size').textContent = (originalFileSize / (1024 * 1024)).toFixed(1) + ' MB';
    document.getElementById('file-diff').textContent = '';
    document.getElementById('webgpu-speedup').textContent = '--';

    originalTriCount = Math.round(countTrianglesForObject(root));
    console.log('Model loaded. Triangles:', originalTriCount);

    const countObj = { val: 0 };
    gsap.to(countObj, {
        val: originalTriCount,
        duration: 1.5,
        ease: 'power2.out',
        onUpdate: () => {
            document.getElementById('tri-count').textContent = Math.ceil(countObj.val).toLocaleString();
        },
    });

    enableOptimizationPipeline();
}

export function updatePropImportStatus() {
    if (!propImportDefaultStatus || !resetPropImportDefaultBtn) return;

    if (importedPropState.futureCollisionMode) {
        propImportDefaultStatus.textContent = `Create actor instances with render, collision, and script components. Future imported actor sources use ${IMPORTED_PROP_COLLISION_LABELS[importedPropState.futureCollisionMode]}.`;
        resetPropImportDefaultBtn.hidden = false;
        return;
    }

    propImportDefaultStatus.textContent = 'Create actor instances with render, collision, and script components. Imported actor sources ask for a collision mode.';
    resetPropImportDefaultBtn.hidden = true;
}

export function closePropCollisionPrompt() {
    if (!propCollisionPrompt) return;

    propCollisionPrompt.hidden = true;
    if (propCollisionRemember) {
        propCollisionRemember.checked = false;
    }
}

export function resolvePropCollisionPrompt(selection) {
    if (!importedPropState.promptResolver) return;

    const resolver = importedPropState.promptResolver;
    importedPropState.promptResolver = null;
    closePropCollisionPrompt();
    resolver(selection);
}

export function promptImportedPropCollision(fileName, triangleCount) {
    if (importedPropState.futureCollisionMode) {
        return Promise.resolve({
            mode: importedPropState.futureCollisionMode,
            remember: true,
        });
    }

    if (!propCollisionPrompt || !propCollisionCopy) {
        return Promise.resolve({ mode: 'complex', remember: false });
    }

    propCollisionCopy.textContent = `${formatImportedPropName(fileName)} has about ${triangleCount.toLocaleString()} triangles. Pick a simple box collision or a tighter convex collision for this imported prop.`;
    propCollisionRemember.checked = false;
    propCollisionPrompt.hidden = false;

    return new Promise((resolve) => {
        importedPropState.promptResolver = resolve;
    });
}

export function createImportedSimpleShape(root) {
    const { Jolt } = physics;
    root.updateWorldMatrix(true, true);

    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(tempVectorA);
    const halfExtentVector = new Jolt.Vec3(
        Math.max(size.x * 0.5, 0.08),
        Math.max(size.y * 0.5, 0.08),
        Math.max(size.z * 0.5, 0.08)
    );
    const shape = createOwnedShape(new Jolt.BoxShapeSettings(halfExtentVector, 0.03));
    Jolt.destroy(halfExtentVector);
    return shape;
}

export function createExactMeshShape(root) {
    if (!physics.ready || !root) return null;

    const { Jolt } = physics;
    root.updateWorldMatrix(true, true);

    const totalTriangles = countTrianglesForObject(root);
    if (!totalTriangles) {
        throw new Error('Imported prop has no usable mesh geometry for exact collision.');
    }

    const triangles = new Jolt.TriangleList();
    const materials = new Jolt.PhysicsMaterialList();
    const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const childToRoot = new THREE.Matrix4();

    triangles.resize(totalTriangles);
    let triangleIndex = 0;

    try {
        root.traverse((child) => {
            if (!child.isMesh || !child.geometry?.attributes?.position) return;

            const position = child.geometry.getAttribute('position');
            const index = child.geometry.getIndex();
            const triangleCount = index ? index.count / 3 : position.count / 3;

            childToRoot.multiplyMatrices(rootInverse, child.matrixWorld);

            for (let triangleOffset = 0; triangleOffset < triangleCount; triangleOffset++) {
                const i0 = index ? index.getX(triangleOffset * 3) : triangleOffset * 3;
                const i1 = index ? index.getX(triangleOffset * 3 + 1) : triangleOffset * 3 + 1;
                const i2 = index ? index.getX(triangleOffset * 3 + 2) : triangleOffset * 3 + 2;

                tempVectorA.fromBufferAttribute(position, i0).applyMatrix4(childToRoot);
                tempVectorB.fromBufferAttribute(position, i1).applyMatrix4(childToRoot);
                tempVectorC.fromBufferAttribute(position, i2).applyMatrix4(childToRoot);

                const triangle = triangles.at(triangleIndex++);
                const v1 = triangle.get_mV(0);
                const v2 = triangle.get_mV(1);
                const v3 = triangle.get_mV(2);
                v1.x = tempVectorA.x;
                v1.y = tempVectorA.y;
                v1.z = tempVectorA.z;
                v2.x = tempVectorB.x;
                v2.y = tempVectorB.y;
                v2.z = tempVectorB.z;
                v3.x = tempVectorC.x;
                v3.y = tempVectorC.y;
                v3.z = tempVectorC.z;
            }
        });

        return createOwnedShape(new Jolt.MeshShapeSettings(triangles, materials));
    } finally {
        Jolt.destroy(triangles);
        Jolt.destroy(materials);
    }
}

export function createImportedConvexHullShape(points) {
    const { Jolt } = physics;
    const settings = new Jolt.ConvexHullShapeSettings();
    settings.mPoints = points;
    settings.mMaxConvexRadius = IMPORTED_PROP_COMPLEX_HULL_RADIUS;
    settings.mMaxErrorConvexRadius = IMPORTED_PROP_COMPLEX_HULL_RADIUS;
    return createOwnedShape(settings);
}

export function collectImportedComplexHullParts(root) {
    const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const childToRoot = new THREE.Matrix4();
    const hullParts = [];

    root.traverse((child) => {
        if (!child.isMesh || !child.geometry?.attributes?.position) return;

        const position = child.geometry.getAttribute('position');
        if (!position || position.count < 4) return;

        const sampleStep = Math.max(1, Math.ceil(position.count / IMPORTED_PROP_MAX_HULL_POINTS));
        const points = [];
        childToRoot.multiplyMatrices(rootInverse, child.matrixWorld);

        for (let i = 0; i < position.count; i += sampleStep) {
            tempVectorA.fromBufferAttribute(position, i).applyMatrix4(childToRoot);
            points.push({
                x: tempVectorA.x,
                y: tempVectorA.y,
                z: tempVectorA.z,
            });
        }

        if (points.length < 4) return;

        hullParts.push({
            points,
            weight: points.length,
        });
    });

    if (hullParts.length <= IMPORTED_PROP_MAX_HULL_PARTS) {
        return hullParts;
    }

    return hullParts
        .sort((left, right) => right.weight - left.weight)
        .slice(0, IMPORTED_PROP_MAX_HULL_PARTS);
}

export function createImportedComplexShape(root) {
    return createExactMeshShape(root);
}

export function createImportedCollisionShape(root, mode) {
    if (mode === 'simple') {
        return { shape: createImportedSimpleShape(root), mode: 'simple' };
    }

    try {
        return { shape: createImportedComplexShape(root), mode: 'complex' };
    } catch (error) {
        console.warn('Falling back to simple imported collision shape.', error);
        alert('Complex collision was not valid for this prop. Falling back to simple collision for this import.');
        return { shape: createImportedSimpleShape(root), mode: 'simple' };
    }
}

export function renderImportedPropButtons() {
    if (!importedPropList || !importedPropLibrary) return;

    importedPropList.innerHTML = '';
    importedPropLibrary.hidden = importedPropState.templates.length === 0;

    importedPropState.templates.forEach((template) => {
        const button = document.createElement('button');
        button.className = 'btn viewer-menu-btn';
        button.textContent = `${template.displayName} · ${template.collisionMode === 'simple' ? 'Simple' : 'Complex'}`;
        button.title = `Open the actor editor for ${template.displayName} with ${IMPORTED_PROP_COLLISION_LABELS[template.collisionMode]}.`;
        button.addEventListener('click', () => openActorEditor({ kind: 'imported', templateId: template.id, label: template.displayName }));
        importedPropList.appendChild(button);
    });

    syncActorEditorTemplateOptions();
}

export function registerImportedPropTemplate(fileName, root, collisionMode, shape, triangleCount) {
    const displayName = formatImportedPropName(fileName);
    const template = {
        id: `imported-prop-${importedPropState.nextId++}`,
        fileName,
        displayName,
        root,
        shape,
        collisionMode,
        triangleCount,
    };

    importedPropState.templates.push(template);
    renderImportedPropButtons();
    updatePropImportStatus();
    return template;
}

export async function registerImportedPropTemplateFromSerializedData(templateData, { fileMap = null } = {}) {
    if (!templateData) return null;

    const existingTemplate = importedPropState.templates.find((entry) => entry.id === templateData.id);
    if (existingTemplate) {
        return existingTemplate;
    }

    let root = null;

    // Folder-bundle path: the .umap stores assetPath instead of rootJson and
    // the raw OBJ/GLB lives next to it. Resolve via the loaded fileMap and
    // run the same importer the fresh-import flow uses — much faster than
    // re-hydrating a THREE.ObjectLoader JSON blob.
    if (templateData.assetPath && fileMap) {
        const entry = lookupBundleAsset(fileMap, templateData.assetPath, templateData.fileName);
        if (entry?.file) {
            root = await loadObjectFromFile(entry.file, fileMap);
            if (templateData.assetType !== 'glb') {
                normalizeObjectToDimension(root, PROP_TARGET_MAX_DIMENSION, false);
            }
        } else {
            console.warn(`[scene] Asset "${templateData.assetPath}" missing from bundle; template will be skipped.`);
            return null;
        }
    } else if (templateData.rootJson) {
        const objectLoader = new THREE.ObjectLoader();
        root = objectLoader.parse(templateData.rootJson);
        convertLoadedObjectMaterials(root);
        // Legacy serialized templates already carried the normalized transform
        // applied at import time. Re-normalizing here mutates the source asset
        // before any actor transform is restored.
        if (templateData.normalized === false) {
            normalizeObjectToDimension(root, PROP_TARGET_MAX_DIMENSION, false);
        }
    } else {
        return null;
    }

    const triangleCount = Number.isFinite(templateData.triangleCount)
        ? templateData.triangleCount
        : Math.round(countTrianglesForObject(root));
    const collision = createImportedCollisionShape(root, templateData.collisionMode || 'simple');
    const template = {
        id: templateData.id || `imported-prop-${importedPropState.nextId++}`,
        fileName: templateData.fileName || 'Imported Prop',
        displayName: templateData.displayName || formatImportedPropName(templateData.fileName || 'Imported Prop'),
        root,
        shape: collision.shape,
        collisionMode: collision.mode,
        triangleCount,
    };

    importedPropState.templates.push(template);

    // If we loaded from a folder bundle, retain the original File so the user
    // can re-save the scene as a folder without re-inlining the geometry.
    if (templateData.assetPath && fileMap) {
        const entry = lookupBundleAsset(fileMap, templateData.assetPath, templateData.fileName);
        if (entry?.file) {
            importedPropState.sourceFiles[template.id] = entry.file;
        }
    }

    const matchedId = /imported-prop-(\d+)$/.exec(template.id || '');
    if (matchedId) {
        importedPropState.nextId = Math.max(importedPropState.nextId, Number(matchedId[1]) + 1);
    }

    renderImportedPropButtons();
    updatePropImportStatus();
    return template;
}

export function lookupBundleAsset(fileMap, assetPath, fileName) {
    if (!fileMap) return null;
    // fileMap is the same shape used by setupDropHandlers / createLoadingManager:
    // { 'relative/path.ext': { file, url } } and/or { 'basename.ext': { file, url } }.
    return fileMap[assetPath]
        || (fileName ? fileMap[fileName] : null)
        || (fileName ? fileMap[fileName.toLowerCase()] : null)
        || null;
}

export function serializeImportedPropTemplate(template, { preferAssetPath = false } = {}) {
    if (!template?.root) return null;

    const base = {
        id: template.id,
        fileName: template.fileName,
        displayName: template.displayName,
        normalized: true,
        collisionMode: template.collisionMode,
        triangleCount: template.triangleCount,
    };

    // When a scene is being saved as a folder bundle and we still have the
    // original imported File, point at it via assetPath. Bundle loading then
    // re-runs the OBJ/GLB importer on the raw file (fast) instead of parsing
    // a serialized THREE.ObjectLoader blob (slow). Inline rootJson stays as
    // the fallback for templates whose source file isn't available.
    const sourceFile = importedPropState.sourceFiles?.[template.id];
    if (preferAssetPath && sourceFile) {
        return { ...base, assetPath: `assets/${template.fileName}` };
    }

    return { ...base, rootJson: template.root.toJSON() };
}

export function spawnImportedProp(templateId, options = {}) {
    if (!physics.ready || !scene || !camera) {
        console.warn('Jolt physics is not ready yet.');
        return null;
    }

    const template = importedPropState.templates.find((entry) => entry.id === templateId);
    if (!template?.root) return null;

    const spawnPosition = tempVectorD;
    const launchImpulse = tempVectorE;
    getDynamicPropSpawn(spawnPosition, launchImpulse);

    const visual = cloneDisposableObject(template.root);
    let body = null;
    const includeCollisionBody = options.includeCollisionBody !== false;
    const requestedSimulatePhysics = includeCollisionBody && options.simulatePhysics !== false;
    const useExactMeshCollision = template.collisionMode === 'complex';
    const simulatePhysics = requestedSimulatePhysics && !useExactMeshCollision;

    if (includeCollisionBody && useExactMeshCollision && requestedSimulatePhysics) {
        console.warn('Exact triangle mesh collision is static-only; spawning imported prop without simulated physics.');
    }

    visual.position.copy(spawnPosition);

    if (includeCollisionBody) {
        if (useExactMeshCollision) {
            body = createStaticMeshBody(visual);
        } else {
            template.shape.AddRef();

            body = createDynamicPrimitiveBody(
                template.shape,
                spawnPosition,
                launchImpulse,
                {
                    ...(template.collisionMode === 'simple'
                        ? { restitution: 0.12, friction: 0.84 }
                        : { restitution: 0.08, friction: 0.76 }),
                    simulatePhysics,
                }
            );
        }

        if (!body) {
            disposeRenderableObject(visual);
            return null;
        }
    }

    const actor = createDynamicPropActor({
        body,
        mesh: visual,
        kind: 'imported',
        templateId,
        userData: options.userData,
        includeScripts: options.includeScripts !== false,
    });
    setActorComponentFlags(actor, {
        collision: !!body,
        physics: !!body && simulatePhysics,
        scripts: options.includeScripts !== false,
    });
    if (body) {
        if (simulatePhysics) {
            physics.dynamicBodies.push(actor);
        } else {
            physics.staticBodies.push(actor);
        }
    }
    playObjectAnimation(visual);
    return actor;
}

export async function importPhysicsProp(file, fileMap = {}) {
    if (!file) return;

    try {
        const root = await loadObjectFromFile(file, fileMap);
        normalizeObjectToDimension(root, PROP_TARGET_MAX_DIMENSION, false);
        const triangleCount = Math.round(countTrianglesForObject(root));

        if (!triangleCount) {
            disposeRenderableObject(root);
            alert('Imported prop has no usable mesh geometry.');
            return;
        }

        const collisionPreference = await promptImportedPropCollision(file.name, triangleCount);
        if (!collisionPreference) {
            disposeRenderableObject(root);
            return;
        }

        if (collisionPreference.remember) {
            importedPropState.futureCollisionMode = collisionPreference.mode;
        }

        const collision = createImportedCollisionShape(root, collisionPreference.mode);
        const template = registerImportedPropTemplate(file.name, root, collision.mode, collision.shape, triangleCount);
        if (template?.id && file instanceof File) {
            importedPropState.sourceFiles[template.id] = file;
        }
        updatePropImportStatus();
        return template;
    } catch (error) {
        console.error('Failed to import physics prop.', error);
        alert(error?.message === 'Unsupported file format'
            ? 'Unsupported file format for physics prop import.'
            : 'Failed to import the selected prop. Check the console for details.');
    }
}
