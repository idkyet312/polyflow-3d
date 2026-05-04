// src/optim/sceneExport.js
// Extracted from main.js (chore/main-js-shrink-2). Owns the optimization +
// scene-export pipeline: GLTFExporter glue, meshopt simplification, OBJ-style
// folder export, and the WebGPU benchmark run that gates the pipeline.

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import gsap from 'gsap';

let importedPropState;
let processingOverlay, processingStep, loaderBar;
let downloadBtn;
let EXPORT_MAX_TEXTURE_SIZE;
let getCurrentMesh, getSourceFiles, getImportedTemplates;
let exportWorldToJSON, runWebGPUBenchmark;
let compressTextures;
let startScanEffect, stopScanEffect;
let registerImportedPropTemplateFromSerializedData;

export function installSceneExport(deps) {
    ({
        importedPropState,
        processingOverlay, processingStep, loaderBar, downloadBtn,
        EXPORT_MAX_TEXTURE_SIZE,
        getCurrentMesh, getSourceFiles, getImportedTemplates,
        exportWorldToJSON, runWebGPUBenchmark,
        compressTextures,
        startScanEffect, stopScanEffect,
        registerImportedPropTemplateFromSerializedData,
    } = deps);
}

export async function runOptimizationPipeline() {
    processingOverlay.style.display = 'flex';
    const isPro = false;

    // --- Analytics Pixel Tracking ---
    // Simple privacy-first ping to track how many users actually run the pipeline.
    // Replace with your actual analytics tracking pixel URL (e.g. Plausible, SimpleAnalytics, or custom).
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
        // Run WebGPU Benchmark for UI "Wow" factor
        const benchmark = await runWebGPUBenchmark(originalTriCount * 3);
        if (benchmark) {
            document.getElementById('webgpu-speedup').textContent = `${benchmark.speedup.toFixed(1)}x`;
        }

        // Actual Simplification
        const ratio = parseFloat(document.getElementById('ratio-slider').value);
        simplifyMesh(ratio);

        // Best current in-browser path: aggressive texture recompression + smaller export textures.
        await compressTextures(getCurrentMesh(), 0.8, EXPORT_MAX_TEXTURE_SIZE, isPro);

        // Export to get real size
        const exporter = new GLTFExporter();
        const gltfData = await new Promise((resolve, reject) => {
            exporter.parse(getCurrentMesh(), resolve, reject, {
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

export function simplifyMesh(ratio = 0.12) {
    if (!getCurrentMesh()) return;

    stopScanEffect();

    let totalReducedTris = 0;

    getCurrentMesh().traverse((child) => {
        if (child.isMesh) {
            const geometry = child.geometry.clone();
            const positions = geometry.attributes.position.array;
            let indices = geometry.index ? geometry.index.array : null;

            if (!indices) {
                // If no index, create one (meshoptimizer needs indices)
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

            // Visual feedback: briefly show wireframe
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
        ease: "power2.out",
        onUpdate: () => {
            document.getElementById('tri-count').textContent = Math.ceil(countObj.val).toLocaleString();
        }
    });
}

export function downloadAsset() {
    if (!optimizedBlobUrl) return;

    const a = document.createElement('a');
    a.href = optimizedBlobUrl;

    let baseName = document.getElementById('asset-name').textContent;
    baseName = baseName.replace(/\.[^/.]+$/, ""); // Remove extension if exists
    a.download = `optimized_${baseName}.glb`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

export function exportWorldToUmap() {
    const umap = exportWorldToJSON();
    const blob = new Blob([JSON.stringify(umap, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scene.umap';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
}

export async function exportWorldToSceneFolder() {
    const umap = exportWorldToJSON({ preferAssetPath: true });
    const vehicleTemplateIds = new Set();
    for (const actor of umap.actors || []) {
        if (actor?.kind !== 'vehicle') continue;
        if (actor.vehicleBodyTemplateId) vehicleTemplateIds.add(actor.vehicleBodyTemplateId);
        if (actor.vehicleWheelTemplateId) vehicleTemplateIds.add(actor.vehicleWheelTemplateId);
    }

    // Build a parallel GLB cache for every imported template referenced by the
    // bundle. GLB parses ~10x faster than text OBJ for huge models (e.g. a
    // 300 MB car), so on next load registerImportedPropTemplateFromSerializedData
    // can skip the OBJ path entirely. Fall back to the raw source file for any
    // template whose GLB export fails.
    const glbAssets = new Map(); // templateId -> { fileName, blob }
    const rawFiles = new Map();  // templateId -> File (fallback only)

    for (const t of umap.importedTemplates || []) {
        const template = importedPropState.templates.find((entry) => entry.id === t.id);
        if (!template?.root) continue;
        const sourceFile = importedPropState.sourceFiles[t.id];

        if (vehicleTemplateIds.has(t.id) && sourceFile) {
            rawFiles.set(t.id, sourceFile);
            t.assetPath = `assets/${sourceFile.name}`;
            t.assetType = 'raw';
            delete t.rootJson;
            continue;
        }

        try {
            const glbBlob = await exportRootToGlb(template.root);
            const glbName = `${t.id}.glb`;
            glbAssets.set(t.id, { fileName: glbName, blob: glbBlob });
            t.assetPath = `assets/${glbName}`;
            t.assetType = 'glb';
        } catch (err) {
            console.warn(`[scene] GLB export failed for template ${t.id}; falling back to raw source.`, err);
            if (sourceFile) {
                rawFiles.set(t.id, sourceFile);
                t.assetPath = `assets/${sourceFile.name}`;
                t.assetType = 'raw';
            } else {
                // No GLB and no raw file — re-inline rootJson so this template
                // still loads (slower but correct).
                delete t.assetPath;
                delete t.assetType;
                t.rootJson = template.root.toJSON();
            }
        }
    }

    const useFsAccess = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
    if (useFsAccess) {
        let dirHandle;
        try {
            dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        } catch (err) {
            if (err?.name === 'AbortError') return;
            console.error('Folder picker failed; falling back to multi-file download.', err);
            return downloadSceneFolderFallback(umap, glbAssets, rawFiles);
        }
        try {
            await writeFileToDirectory(dirHandle, 'scene.umap', JSON.stringify(umap, null, 2));
            if (glbAssets.size > 0 || rawFiles.size > 0) {
                const assetsDir = await dirHandle.getDirectoryHandle('assets', { create: true });
                for (const { fileName, blob } of glbAssets.values()) {
                    await writeFileToDirectory(assetsDir, fileName, blob);
                }
                for (const file of rawFiles.values()) {
                    await writeFileToDirectory(assetsDir, file.name, file);
                }
            }
            console.info('[scene] Saved scene folder to picked directory.');
        } catch (err) {
            console.error('Failed to write scene folder.', err);
            alert('Failed to write scene folder. See console for details.');
        }
        return;
    }

    // Fallback for browsers without File System Access API: drop separate
    // downloads. The user reassembles the folder manually.
    downloadSceneFolderFallback(umap, glbAssets, rawFiles);
}

export function exportRootToGlb(root) {
    return new Promise((resolve, reject) => {
        const exporter = new GLTFExporter();
        exporter.parse(
            root,
            (result) => {
                if (result instanceof ArrayBuffer) {
                    resolve(new Blob([result], { type: 'model/gltf-binary' }));
                } else {
                    // Defensive: caller asked for binary, but if a runtime
                    // returns JSON anyway, ship it as a non-binary GLB blob.
                    resolve(new Blob([JSON.stringify(result)], { type: 'model/gltf+json' }));
                }
            },
            reject,
            { binary: true, onlyVisible: false }
        );
    });
}

export async function writeFileToDirectory(dirHandle, name, contents) {
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(contents);
    await writable.close();
}

export function downloadSceneFolderFallback(umap, glbAssets, rawFiles) {
    const triggerDownload = (blob, name) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 100);
    };

    triggerDownload(
        new Blob([JSON.stringify(umap, null, 2)], { type: 'application/json' }),
        'scene.umap'
    );
    if (glbAssets) {
        for (const { fileName, blob } of glbAssets.values()) {
            triggerDownload(blob, fileName);
        }
    }
    if (rawFiles) {
        for (const file of rawFiles.values()) {
            triggerDownload(file, file.name);
        }
    }
    alert('Saved scene.umap and its assets as separate downloads. Place them in a folder with assets/<file> next to scene.umap before loading.');
}
