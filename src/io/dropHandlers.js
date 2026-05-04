// src/io/dropHandlers.js
// Extracted from main.js (chore/main-js-shrink-2). Owns the file-drop / dropdown
// loader, the OBJ/GLB/UMAP/FBX dispatcher, the loader scan effect, and the
// per-frame onWindowResize hook. `currentMesh` and `modelBody` are owned by
// main.js and come through as get/set callbacks because they get reassigned
// inside loadModel + clearCurrentMesh.

import * as THREE from 'three';
import gsap from 'gsap';

let scene, camera, renderer, container;
let physics, gameplay;
let processingOverlay, processingStep, loaderBar;
let MODEL_TARGET_MAX_DIMENSION;
let getCurrentMesh, setCurrentMesh, getModelBody, setModelBody;
let getScanPlane, setScanPlane;
let loadObjectFromFile, normalizeObjectToDimension;
let clearDynamicPhysicsProps, destroyPhysicsBody, destroyPlayerCharacter;
let disposeRenderableObject, playObjectAnimation;
let updateLoadedAssetStats, refreshGameplayWorld, updateGameplayUI, exitGameplay;

export function installDropHandlers(deps) {
    ({
        scene, camera, renderer, container,
        physics, gameplay,
        processingOverlay, processingStep, loaderBar,
        MODEL_TARGET_MAX_DIMENSION,
        getCurrentMesh, setCurrentMesh, getModelBody, setModelBody,
        getScanPlane, setScanPlane,
        loadObjectFromFile, normalizeObjectToDimension,
        clearDynamicPhysicsProps, destroyPhysicsBody, destroyPlayerCharacter,
        disposeRenderableObject, playObjectAnimation,
        updateLoadedAssetStats, refreshGameplayWorld, updateGameplayUI, exitGameplay,
    } = deps);
}

export function onWindowResize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}

export function clearCurrentMesh() {
    exitGameplay();
    clearDynamicPhysicsProps();

    if (physics.modelBody) {
        destroyPhysicsBody(physics.modelBody);
        physics.modelBody = null;
    }
    destroyPlayerCharacter();

    if (!getCurrentMesh()) {
        gameplay.canPlay = physics.ready;
        updateGameplayUI();
        return;
    }

    scene.remove(getCurrentMesh());
    disposeRenderableObject(getCurrentMesh());

    setCurrentMesh(null);
    gameplay.canPlay = physics.ready;
    updateGameplayUI();
}

export function normalizeCurrentMesh(targetDimension = MODEL_TARGET_MAX_DIMENSION) {
    if (!getCurrentMesh()) return;
    normalizeObjectToDimension(getCurrentMesh(), targetDimension, true);
}

export async function readDirectoryFiles(dirEntry) {
    const fileMap = {};
    const readEntries = (entry) => new Promise((resolve) => {
        if (entry.isFile) {
            entry.file(file => {
                const url = URL.createObjectURL(file);
                // Store by lowercase filename so we can match case-insensitively
                fileMap[file.name.toLowerCase()] = { file, url };
                resolve();
            });
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const readBatch = () => {
                reader.readEntries(async (entries) => {
                    if (entries.length === 0) return resolve();
                    await Promise.all(entries.map(readEntries));
                    readBatch(); // keep reading until empty batch
                });
            };
            readBatch();
        } else {
            resolve();
        }
    });
    await readEntries(dirEntry);
    return fileMap;
}

export function setupDropHandlers() {
    container.addEventListener('dragover', (e) => {
        e.preventDefault();
        container.classList.add('drag-active');
    });

    container.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && container.contains(e.relatedTarget)) return;
        container.classList.remove('drag-active');
    });

    container.addEventListener('drop', async (e) => {
        e.preventDefault();
        container.classList.remove('drag-active');

        const items = [...e.dataTransfer.items];
        const firstEntry = items[0]?.webkitGetAsEntry?.();

        // --- Folder drop ---
        if (firstEntry?.isDirectory) {
            processingStep.textContent = 'Reading folder...';
            processingOverlay.style.display = 'flex';
            loaderBar.style.width = '10%';

            const fileMap = await readDirectoryFiles(firstEntry);
            const modelEntry = Object.values(fileMap).find(({ file }) =>
                /\.(fbx|glb|gltf|obj)$/i.test(file.name)
            );
            processingOverlay.style.display = 'none';

            if (!modelEntry) {
                alert('No supported 3D file found in folder (.glb, .gltf, .obj, .fbx)');
                return;
            }
            loadModel(modelEntry.file, fileMap);
            return;
        }

        // --- Multi-file drop (files dropped directly, no folder) ---
        if (items.length > 1) {
            processingStep.textContent = 'Reading files...';
            processingOverlay.style.display = 'flex';
            loaderBar.style.width = '10%';

            const fileMap = {};
            let mainFile = null;

            for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const file = e.dataTransfer.files[i];
                const url = URL.createObjectURL(file);
                fileMap[file.name.toLowerCase()] = { file, url };
                
                if (/\.(fbx|glb|gltf|obj)$/i.test(file.name)) {
                    mainFile = file;
                }
            }

            processingOverlay.style.display = 'none';

            if (!mainFile) {
                alert('No supported 3D file found in dropped files (.glb, .gltf, .obj, .fbx)');
                return;
            }
            loadModel(mainFile, fileMap);
            return;
        }

        // --- Single file drop ---
        const file = e.dataTransfer.files[0];
        if (file && /\.(glb|gltf|obj|fbx)$/i.test(file.name)) {
            loadModel(file, {});
        } else {
            alert('Please drop a .glb, .gltf, .obj, or .fbx file — or drag a whole folder to load FBX textures.');
        }
    });

    const fileInput = document.getElementById('file-input');

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) loadModel(file, {});
    });
}

export async function loadModel(file, fileMap = {}) {
    try {
        const root = await loadObjectFromFile(file, fileMap);
        clearCurrentMesh();
        setCurrentMesh(root);
        scene.add(getCurrentMesh());
        normalizeCurrentMesh();
        playObjectAnimation(getCurrentMesh());
        refreshGameplayWorld();
        updateLoadedAssetStats(file.name, file.size, getCurrentMesh());
    } catch (error) {
        console.error('Failed to load model.', error);
        alert(error?.message === 'Unsupported file format'
            ? 'Unsupported file format'
            : 'Failed to load the selected model. Check the console for details.');
    }
}

export function stopScanEffect() {
    if (getScanPlane()) {
        scene.remove(getScanPlane());
        setScanPlane(null);
    }
}

export function startScanEffect() {
    const geometry = new THREE.PlaneGeometry(5, 5);
    const material = new THREE.MeshBasicMaterial({
        color: 0x00ffaa,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending
    });
    setScanPlane(new THREE.Mesh(geometry, material));
    getScanPlane().rotation.x = Math.PI / 2;
    getScanPlane().position.y = -2;
    scene.add(getScanPlane());

    gsap.to(getScanPlane().position, {
        y: 2,
        duration: 2,
        repeat: -1,
        yoyo: true,
        ease: "power1.inOut"
    });
}
