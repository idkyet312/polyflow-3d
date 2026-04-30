const fs = require('fs');

let content = fs.readFileSync('main.js', 'utf8');

// 1. Add blueprintState
const blueprint_state_code = `const actorEditorState = {
    open: false,
};
const blueprintState = {
    active: false,
    targetActor: null,
    selectedComponent: null,
    floorMesh: null,
    savedCameraPosition: null,
    savedShowcaseAngles: null
};`;
content = content.replace('const actorEditorState = {\r\n    open: false,\r\n};', blueprint_state_code);
content = content.replace('const actorEditorState = {\n    open: false,\n};', blueprint_state_code);

// 2. Add enterBlueprintEditor and exitBlueprintEditor
const blueprint_funcs = `
// === BLUEPRINT COMPONENT EDITOR ===
function enterBlueprintEditor() {
    const actorId = objectScriptState.targetPropId;
    if (!actorId) return;
    const prop = getDynamicPropById(actorId);
    if (!prop || !prop.mesh) return;

    blueprintState.active = true;
    blueprintState.targetActor = prop;
    blueprintState.selectedComponent = prop.mesh;
    
    blueprintState.savedCameraPosition = camera.position.clone();
    blueprintState.savedShowcaseAngles = { theta: showcaseCamera.theta, phi: showcaseCamera.phi };
    
    for (const actor of sceneSystem.actors) {
        if (actor !== prop) {
            const mesh = getActorRenderObject(actor);
            if (mesh) mesh.visible = false;
        }
    }
    
    if (blueprintState.floorMesh) {
        scene.remove(blueprintState.floorMesh);
    }
    
    const floorGeo = new THREE.PlaneGeometry(50, 50);
    const floorMat = new THREE.MeshStandardMaterial({ 
        color: 0x222222, 
        roughness: 0.9,
        metalness: 0.1
    });
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.receiveShadow = true;
    
    const gridHelper = new THREE.GridHelper(50, 50, 0x444444, 0x2a2a2a);
    gridHelper.position.y = 0.02; // Slightly above the plane to avoid z-fighting
    floorMesh.add(gridHelper);
    
    const targetPos = prop.mesh.position;
    const groundHit = getGroundHeightAt(targetPos.x, targetPos.z);
    const floorY = groundHit !== null ? groundHit + 0.05 : targetPos.y - 1;
    
    floorMesh.position.set(targetPos.x, floorY, targetPos.z);
    scene.add(floorMesh);
    blueprintState.floorMesh = floorMesh;
    
    if (typeof gsap !== 'undefined') {
        gsap.to(camera.position, {
            x: targetPos.x + 2,
            y: targetPos.y + 1.5,
            z: targetPos.z + 2,
            duration: 0.5,
            onUpdate: () => {
                syncShowcaseAnglesFromTarget(targetPos);
                applyShowcaseCameraRotation();
            }
        });
    }

    const panel = document.getElementById('blueprint-editor-panel');
    const menuSections = document.querySelector('.viewer-menu-sections-card');
    const actorsMenu = document.querySelector('.viewer-menu-card:nth-child(2)');
    const cameraMenu = document.querySelector('.viewer-menu-card:first-child');
    
    if (panel) {
        document.getElementById('blueprint-actor-name').textContent = prop.rootNode.name || actorId;
        panel.style.display = 'block';
        if (menuSections) menuSections.style.display = 'none';
        if (actorsMenu) actorsMenu.style.display = 'none';
        if (cameraMenu) cameraMenu.style.display = 'none';
        refreshBlueprintComponents();
    }
    
    refreshSceneUI();
}

function exitBlueprintEditor() {
    blueprintState.active = false;
    blueprintState.targetActor = null;
    blueprintState.selectedComponent = null;
    
    if (typeof sceneSystem !== 'undefined') {
        for (const actor of sceneSystem.actors) {
            const mesh = getActorRenderObject(actor);
            if (mesh) mesh.visible = true;
        }
    }
    
    if (blueprintState.floorMesh) {
        scene.remove(blueprintState.floorMesh);
        blueprintState.floorMesh = null;
    }
    
    if (blueprintState.savedCameraPosition && typeof gsap !== 'undefined') {
        gsap.to(camera.position, {
            x: blueprintState.savedCameraPosition.x,
            y: blueprintState.savedCameraPosition.y,
            z: blueprintState.savedCameraPosition.z,
            duration: 0.5
        });
        showcaseCamera.theta = blueprintState.savedShowcaseAngles.theta;
        showcaseCamera.phi = blueprintState.savedShowcaseAngles.phi;
        applyShowcaseCameraRotation();
    }

    const panel = document.getElementById('blueprint-editor-panel');
    const menuSections = document.querySelector('.viewer-menu-sections-card');
    const actorsMenu = document.querySelector('.viewer-menu-card:nth-child(2)');
    const cameraMenu = document.querySelector('.viewer-menu-card:first-child');
    
    if (panel) {
        panel.style.display = 'none';
        if (menuSections) menuSections.style.display = 'block';
        if (actorsMenu) actorsMenu.style.display = 'block';
        if (cameraMenu) cameraMenu.style.display = 'block';
    }
    
    const propId = objectScriptState.targetPropId;
    if (propId) {
        const prop = getDynamicPropById(propId);
        if (typeof transformControl !== 'undefined' && prop?.mesh) {
            transformControl.attach(prop.mesh);
        }
    }
    
    refreshSceneUI();
}

function refreshBlueprintComponents() {
    const container = document.getElementById('selected-actor-components');
    if (!container) return;
    container.innerHTML = '';
    
    const propId = objectScriptState.targetPropId;
    if (!propId) return;
    
    const prop = getDynamicPropById(propId);
    const rootMesh = getActorRenderObject(prop);
    if (!rootMesh) return;
    
    function renderComponentItem(object3D, depth, isRoot) {
        const item = document.createElement('div');
        item.style.padding = \`4px 4px 4px \${4 + depth * 12}px\`;
        item.style.cursor = 'pointer';
        item.style.borderRadius = '4px';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.justifyContent = 'space-between';
        item.style.background = blueprintState.selectedComponent === object3D ? 'rgba(112, 0, 255, 0.4)' : 'rgba(255,255,255,0.05)';
        item.style.border = blueprintState.selectedComponent === object3D ? '1px solid rgba(112, 0, 255, 0.8)' : '1px solid transparent';
        
        const label = document.createElement('span');
        let typeName = 'Mesh';
        if (isRoot) typeName = 'Root Mesh';
        else if (object3D.isPointLight) typeName = 'Point Light';
        else if (object3D.geometry?.type === 'BoxGeometry') typeName = 'Cube Component';
        else if (object3D.geometry?.type === 'SphereGeometry') typeName = 'Sphere Component';
        
        label.textContent = object3D.name || typeName;
        label.style.fontSize = '13px';
        item.appendChild(label);
        
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            blueprintState.selectedComponent = object3D;
            if (typeof transformControl !== 'undefined') transformControl.attach(object3D);
            refreshBlueprintComponents();
        });
        
        container.appendChild(item);
        
        for (const child of object3D.children) {
            if (child.isMesh || child.isLight) {
                renderComponentItem(child, depth + 1, false);
            }
        }
    }
    
    renderComponentItem(rootMesh, 0, true);
}

document.getElementById('btn-exit-blueprint')?.addEventListener('click', () => {
    exitBlueprintEditor();
});

document.getElementById('btn-edit-actor-script')?.addEventListener('click', () => {
    openObjectScriptEditor('tick');
});

document.getElementById('btn-add-comp-cube')?.addEventListener('click', () => {
    const parent = blueprintState.selectedComponent || getActorRenderObject(getDynamicPropById(objectScriptState.targetPropId));
    if (!parent) return;
    
    const mesh = buildPrimitiveActorMesh('cube');
    mesh.scale.set(0.5, 0.5, 0.5);
    mesh.name = 'Cube Component';
    parent.add(mesh);
    refreshBlueprintComponents();
});

document.getElementById('btn-add-comp-sphere')?.addEventListener('click', () => {
    const parent = blueprintState.selectedComponent || getActorRenderObject(getDynamicPropById(objectScriptState.targetPropId));
    if (!parent) return;
    
    const mesh = buildPrimitiveActorMesh('sphere');
    mesh.scale.set(0.5, 0.5, 0.5);
    mesh.name = 'Sphere Component';
    parent.add(mesh);
    refreshBlueprintComponents();
});

document.getElementById('btn-add-comp-light')?.addEventListener('click', () => {
    const parent = blueprintState.selectedComponent || getActorRenderObject(getDynamicPropById(objectScriptState.targetPropId));
    if (!parent) return;
    
    const light = new THREE.PointLight(0xffddaa, 2, 10);
    light.position.set(0, 1, 0);
    light.castShadow = true;
    light.name = 'Point Light';
    parent.add(light);
    refreshBlueprintComponents();
});

document.getElementById('btn-delete-comp')?.addEventListener('click', () => {
    const prop = getDynamicPropById(objectScriptState.targetPropId);
    const rootMesh = getActorRenderObject(prop);
    const selected = blueprintState.selectedComponent;
    
    if (!selected || selected === rootMesh) {
        alert("Cannot delete the root component!");
        return;
    }
    
    if (selected.parent) {
        selected.parent.remove(selected);
        if (selected.geometry) selected.geometry.dispose();
        if (selected.material) selected.material.dispose();
        
        blueprintState.selectedComponent = rootMesh;
        if (typeof transformControl !== 'undefined') transformControl.attach(rootMesh);
        refreshBlueprintComponents();
    }
});

init();
`;
content = content.replace('init();', blueprint_funcs);

// 3. selectShowcaseActor
const select_showcase_old = `function selectShowcaseActor(actorId) {
    if (gameplay.active) return; // Only allow selection in Showcase mode
    
    const previousTargetId = objectScriptState.targetPropId;
    objectScriptState.targetPropId = actorId || '';
    
    if (actorId) {
        const prop = getDynamicPropById(actorId);
        if (objectScriptEditorTarget) {
            objectScriptEditorTarget.textContent = prop?.rootNode?.name || actorId || 'Actor';
        }
        if (transformControl && prop?.mesh) {
            transformControl.attach(prop.mesh);
        }
    } else {
        if (objectScriptEditorTarget) {
            objectScriptEditorTarget.textContent = 'None';
        }
        if (transformControl) {
            transformControl.detach();
        }
    }
    
    if (previousTargetId !== objectScriptState.targetPropId) {
        refreshSceneUI();
    }
}`;

const select_showcase_new = `function selectShowcaseActor(actorId) {
    if (gameplay.active) return; // Only allow selection in Showcase mode
    
    const previousTargetId = objectScriptState.targetPropId;
    objectScriptState.targetPropId = actorId || '';
    
    if (blueprintState.active && actorId !== blueprintState.targetActor?.id) {
        exitBlueprintEditor();
    }
    
    if (actorId) {
        const prop = getDynamicPropById(actorId);
        if (objectScriptEditorTarget) {
            objectScriptEditorTarget.textContent = prop?.rootNode?.name || actorId || 'Actor';
        }
        
        if (typeof transformControl !== 'undefined' && prop?.mesh) {
            transformControl.attach(prop.mesh);
        }
    } else {
        if (objectScriptEditorTarget) {
            objectScriptEditorTarget.textContent = 'None';
        }
        if (typeof transformControl !== 'undefined') {
            transformControl.detach();
        }
    }
    
    if (previousTargetId !== objectScriptState.targetPropId) {
        refreshSceneUI();
    }
}`;

content = content.replace(select_showcase_old, select_showcase_new);
content = content.replace(select_showcase_old.replace(/\n/g, '\r\n'), select_showcase_new);

// 4. update syncTransformToPhysics to prevent detaching from child mesh
const sync_old = `    const mesh = transformControl.object;
    const pos = mesh.position;
    const rot = mesh.quaternion;`;
const sync_new = `    const mesh = transformControl.object;
    if (mesh !== getActorRenderObject(prop)) return;
    const pos = mesh.position;
    const rot = mesh.quaternion;`;
content = content.replace(sync_old, sync_new);
content = content.replace(sync_old.replace(/\n/g, '\r\n'), sync_new);

// 5. Add edit blueprint button to refreshSceneUI
const refresh_ui_old = `        if (objectScriptState.targetPropId === actor.id) {
            item.style.background = 'rgba(255, 255, 255, 0.12)';
            item.style.borderColor = 'rgba(112, 0, 255, 0.45)';
        }`;
const refresh_ui_new = `        if (objectScriptState.targetPropId === actor.id) {
            item.style.background = 'rgba(255, 255, 255, 0.12)';
            item.style.borderColor = 'rgba(112, 0, 255, 0.45)';
            
            if (!blueprintState.active) {
                const btn = document.createElement('button');
                btn.className = 'btn btn-primary';
                btn.style.marginTop = '8px';
                btn.style.fontSize = '12px';
                btn.style.padding = '4px 8px';
                btn.textContent = 'Edit Blueprint';
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    enterBlueprintEditor();
                });
                item.appendChild(btn);
            }
        }`;
content = content.replace(refresh_ui_old, refresh_ui_new);
content = content.replace(refresh_ui_old.replace(/\n/g, '\r\n'), refresh_ui_new);

// 6. UMAP update
const umap_old = `function exportWorldToUmap() {
    const umap = {
        version: 1,
        actors: []
    };
    
    for (const actor of (sceneSystem?.actors || [])) {
        const mesh = getActorRenderObject(actor);
        if (!mesh) continue;
        
        const scripts = objectScriptState.drafts[actor.id] || null;
        
        umap.actors.push({
            id: actor.id,
            kind: actor.kind,
            name: actor.rootNode?.name || 'Actor',
            templateId: actor.templateId,
            userData: actor.entity.getComponent('metadata')?.userData || null,
            transform: {
                position: mesh.position.toArray(),
                quaternion: mesh.quaternion.toArray(),
                scale: mesh.scale.toArray()
            },
            scripts: scripts
        });
    }`;

const umap_new = `function exportWorldToUmap() {
    const umap = {
        version: 1,
        actors: []
    };
    
    function serializeComponentTree(object3D) {
        if (!object3D) return [];
        const comps = [];
        for (const child of object3D.children) {
            if (child.isMesh || child.isLight) {
                comps.push({
                    type: child.isPointLight ? 'PointLight' : (child.geometry?.type || 'Mesh'),
                    name: child.name,
                    position: child.position.toArray(),
                    quaternion: child.quaternion.toArray(),
                    scale: child.scale.toArray(),
                    children: serializeComponentTree(child)
                });
            }
        }
        return comps;
    }
    
    for (const actor of (sceneSystem?.actors || [])) {
        const mesh = getActorRenderObject(actor);
        if (!mesh) continue;
        
        const scripts = objectScriptState.drafts[actor.id] || null;
        
        umap.actors.push({
            id: actor.id,
            kind: actor.kind,
            name: actor.rootNode?.name || 'Actor',
            templateId: actor.templateId,
            userData: actor.entity.getComponent('metadata')?.userData || null,
            transform: {
                position: mesh.position.toArray(),
                quaternion: mesh.quaternion.toArray(),
                scale: mesh.scale.toArray()
            },
            scripts: scripts,
            components: serializeComponentTree(mesh)
        });
    }`;
content = content.replace(umap_old, umap_new);
content = content.replace(umap_old.replace(/\n/g, '\r\n'), umap_new);


const load_old = `                    const mesh = getActorRenderObject(actor);
                    if (mesh) {
                        mesh.userData.dynamicPropId = actor.id;
                        mesh.position.fromArray(actorData.transform.position);
                        mesh.quaternion.fromArray(actorData.transform.quaternion);
                        mesh.scale.fromArray(actorData.transform.scale);
                        
                        rebuildActorPhysics(actor);
                    }`;

const load_new = `                    const mesh = getActorRenderObject(actor);
                    if (mesh) {
                        mesh.userData.dynamicPropId = actor.id;
                        mesh.position.fromArray(actorData.transform.position);
                        mesh.quaternion.fromArray(actorData.transform.quaternion);
                        mesh.scale.fromArray(actorData.transform.scale);
                        
                        function deserializeComponentTree(parent, comps) {
                            if (!comps || !comps.length) return;
                            for (const compData of comps) {
                                let comp = null;
                                if (compData.type === 'PointLight') {
                                    comp = new THREE.PointLight(0xffddaa, 2, 10);
                                    comp.castShadow = true;
                                } else if (compData.type === 'BoxGeometry') {
                                    comp = buildPrimitiveActorMesh('cube');
                                } else if (compData.type === 'SphereGeometry') {
                                    comp = buildPrimitiveActorMesh('sphere');
                                }
                                
                                if (comp) {
                                    comp.name = compData.name;
                                    comp.position.fromArray(compData.position);
                                    comp.quaternion.fromArray(compData.quaternion);
                                    comp.scale.fromArray(compData.scale);
                                    parent.add(comp);
                                    deserializeComponentTree(comp, compData.children);
                                }
                            }
                        }
                        deserializeComponentTree(mesh, actorData.components);
                        
                        rebuildActorPhysics(actor);
                    }`;
content = content.replace(load_old, load_new);
content = content.replace(load_old.replace(/\n/g, '\r\n'), load_new);

fs.writeFileSync('main.js', content, 'utf8');
