// Showcase asset pipeline: drag/drop a model, normalize/load it,
// optionally run the mesh-simplification + texture-compression pipeline,
// and download an optimized GLB.
//
// Extracted from src/app/runtime.js. Reads live engine refs (scene,
// currentMesh) via the shared appCore; reassigns currentMesh through
// setAppCore('currentMesh', ...) so the runtime's `let currentMesh`
// stays in sync.
//
// Lives under src/optim/ alongside textureCompression.js (its sibling
// dependency) rather than src/editor/ — it's an asset pipeline, not
// editor UI.

import * as THREE from 'three';
import gsap from 'gsap';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { MeshoptSimplifier } from 'meshoptimizer';

import { core, setAppCore } from '../runtime/appCore.js';
import { compressTextures } from '../optim/textureCompression.js';
import { loadObjectFromFile } from '../io/objectLoader.js';
import { runWebGPUBenchmark } from '../../webgpu_utils.js';

const EXPORT_MAX_TEXTURE_SIZE = 1024;

export function createShowcaseOptimizer({
    container,
    clearCurrentMesh,
    normalizeCurrentMesh,
    refreshGameplayWorld,
    playObjectAnimation,
    countTrianglesForObject,
}) {
    const processingOverlay = document.getElementById('processing-overlay');
    const loaderBar = document.getElementById('loader-bar');
    const processingStep = document.getElementById('processing-step');
    const processTrigger = document.getElementById('process-trigger');
    const downloadBtn = document.getElementById('download-asset');

    let originalTriCount = 0;
    let optimizedTriCount = 0;
    let originalFileSize = 0;
    let optimizedBlobUrl = null;
    let scanPlane = null;

    function enableOptimizationPipeline() {
        if (!processTrigger) return;
        processTrigger.style.opacity = '1';
        processTrigger.style.cursor = 'pointer';
        processTrigger.onclick = runOptimizationPipeline;
    }

    function updateLoadedAssetStats(name, fileSize, root) {
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

    // Reads all files from a dropped directory entry recursively,
    // returns filename→{file,url} map.
    async function readDirectoryFiles(dirEntry) {
        const fileMap = {};
        const readEntries = (entry) => new Promise((resolve) => {
            if (entry.isFile) {
                entry.file(file => {
                    const url = URL.createObjectURL(file);
                    fileMap[file.name.toLowerCase()] = { file, url };
                    resolve();
                });
            } else if (entry.isDirectory) {
                const reader = entry.createReader();
                const readBatch = () => {
                    reader.readEntries(async (entries) => {
                        if (entries.length === 0) return resolve();
                        await Promise.all(entries.map(readEntries));
                        readBatch();
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

    async function loadModel(file, fileMap = {}) {
        try {
            const root = await loadObjectFromFile(file, fileMap);
            clearCurrentMesh();
            setAppCore('currentMesh', root);
            const { scene } = core;
            scene.add(root);
            normalizeCurrentMesh();
            playObjectAnimation(root);
            refreshGameplayWorld();
            updateLoadedAssetStats(file.name, file.size, root);
        } catch (error) {
            console.error('Failed to load model.', error);
            alert(error?.message === 'Unsupported file format'
                ? 'Unsupported file format'
                : 'Failed to load the selected model. Check the console for details.');
        }
    }

    function setupDropHandlers() {
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

            // Ignore in-app drags (e.g. the grow-room bagging panel) that carry
            // no files — only react to real file/folder drops from the OS.
            const hasFiles = [...(e.dataTransfer?.types || [])].includes('Files');
            if (!hasFiles) return;

            const items = [...e.dataTransfer.items];
            const firstEntry = items[0]?.webkitGetAsEntry?.();

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

    async function runOptimizationPipeline() {
        processingOverlay.style.display = 'flex';
        const isPro = false;

        // Privacy-first ping to track how many users actually run the pipeline.
        try {
            new Image().src = `https://your-analytics-domain.com/pixel.gif?event=run_pipeline&isPro=${isPro}&ts=${Date.now()}`;
            console.log('Analytics ping sent: run_pipeline');
        } catch (e) {
            /* Ignore analytics errors so it doesn't block the UI */
        }

        const steps = [
            { label: 'Initializing WebGPU kernels...', progress: 10 },
            { label: 'Analyzing mesh topology...', progress: 20 },
            { label: 'Executing Parallel Decimation...', progress: 45 },
            { label: isPro ? 'Optimizing PBR textures (KTX2 + BasisU)...' : 'Optimizing PBR textures (WebP)...', progress: 75 },
            { label: 'Baking PBR texture maps...', progress: 85 },
            { label: 'Exporting optimized GLB...', progress: 100 }
        ];

        for (const step of steps) {
            processingStep.textContent = step.label;
            if (step.label.includes('Decimation')) {
                startScanEffect();
            }
            await gsap.to(loaderBar, { width: `${step.progress}%`, duration: 0.8 });
            await new Promise(r => setTimeout(r, 400));
        }

        try {
            const benchmark = await runWebGPUBenchmark(originalTriCount * 3);
            if (benchmark) {
                document.getElementById('webgpu-speedup').textContent = `${benchmark.speedup.toFixed(1)}x`;
            }

            const ratio = parseFloat(document.getElementById('ratio-slider').value);
            simplifyMesh(ratio);

            const { currentMesh } = core;
            await compressTextures(currentMesh, 0.8, EXPORT_MAX_TEXTURE_SIZE, isPro);

            const exporter = new GLTFExporter();
            const gltfData = await new Promise((resolve, reject) => {
                exporter.parse(currentMesh, resolve, reject, {
                    binary: true,
                    maxTextureSize: EXPORT_MAX_TEXTURE_SIZE,
                    onlyVisible: true,
                });
            });

            const blob = new Blob([gltfData], { type: 'application/octet-stream' });
            if (optimizedBlobUrl) URL.revokeObjectURL(optimizedBlobUrl);
            optimizedBlobUrl = URL.createObjectURL(blob);

            const optimizedSize = blob.size;
            document.getElementById('file-size').textContent = (optimizedSize / (1024 * 1024)).toFixed(1) + ' MB';
            document.getElementById('file-diff').textContent = `(-${Math.round((1 - (optimizedSize / originalFileSize)) * 100)}%)`;

            processingOverlay.style.display = 'none';
            downloadBtn.style.display = 'flex';
        } catch (err) {
            console.error('Optimization failed:', err);
            alert('Optimization failed. Check console for details.');
            processingOverlay.style.display = 'none';
            stopScanEffect();
        }
    }

    function simplifyMesh(ratio = 0.12) {
        const { currentMesh } = core;
        if (!currentMesh) return;

        stopScanEffect();

        let totalReducedTris = 0;

        currentMesh.traverse((child) => {
            if (child.isMesh) {
                const geometry = child.geometry.clone();
                const positions = geometry.attributes.position.array;
                let indices = geometry.index ? geometry.index.array : null;

                if (!indices) {
                    const count = positions.length / 3;
                    indices = new Uint32Array(count);
                    for (let i = 0; i < count; i++) indices[i] = i;
                } else if (!(indices instanceof Uint32Array)) {
                    indices = new Uint32Array(indices);
                }

                const targetCount = Math.floor((indices.length / 3) * ratio) * 3;
                const targetError = 0.01;

                const [simplifiedIndices, error] = MeshoptSimplifier.simplify(
                    indices,
                    positions,
                    3,
                    targetCount,
                    targetError
                );

                geometry.setIndex(new THREE.BufferAttribute(simplifiedIndices, 1));
                child.geometry = geometry;

                totalReducedTris += simplifiedIndices.length / 3;

                child.material.wireframe = true;
                setTimeout(() => { child.material.wireframe = false; }, 1000);
            }
        });

        optimizedTriCount = Math.round(totalReducedTris);
        document.getElementById('tri-diff').textContent = `(-${Math.round((1 - (optimizedTriCount / originalTriCount)) * 100)}%)`;

        const countObj = { val: originalTriCount };
        gsap.to(countObj, {
            val: optimizedTriCount,
            duration: 1.5,
            ease: 'power2.out',
            onUpdate: () => {
                document.getElementById('tri-count').textContent = Math.ceil(countObj.val).toLocaleString();
            }
        });
    }

    function downloadAsset() {
        if (!optimizedBlobUrl) return;

        const a = document.createElement('a');
        a.href = optimizedBlobUrl;

        let baseName = document.getElementById('asset-name').textContent;
        baseName = baseName.replace(/\.[^/.]+$/, '');
        a.download = `optimized_${baseName}.glb`;

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    function stopScanEffect() {
        if (scanPlane) {
            const { scene } = core;
            scene.remove(scanPlane);
            scanPlane = null;
        }
    }

    function startScanEffect() {
        const { scene } = core;
        const geometry = new THREE.PlaneGeometry(5, 5);
        const material = new THREE.MeshBasicMaterial({
            color: 0x00ffaa,
            transparent: true,
            opacity: 0.5,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
        });
        scanPlane = new THREE.Mesh(geometry, material);
        scanPlane.rotation.x = Math.PI / 2;
        scanPlane.position.y = -2;
        scene.add(scanPlane);

        gsap.to(scanPlane.position, {
            y: 2,
            duration: 2,
            repeat: -1,
            yoyo: true,
            ease: 'power1.inOut',
        });
    }

    if (downloadBtn) {
        downloadBtn.onclick = downloadAsset;
    }

    return {
        enableOptimizationPipeline,
        updateLoadedAssetStats,
        setupDropHandlers,
    };
}
