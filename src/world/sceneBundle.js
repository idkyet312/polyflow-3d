import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// Scene export: legacy single-file .umap and the faster "scene folder" bundle
// (slim scene.umap + assets/ with per-template GLB or raw source). Extracted
// from runtime.js — pure browser IO + serialization glue, no scene-graph or
// physics coupling.
//
// Deps injected (same factory pattern as combatFx/heldWeapons):
//   exportWorldToJSON    - (opts?) => umap object   (from editor/sceneHistory)
//   getImportedTemplate  - (id) => { root, ... } | undefined
//   importedPropState    - { sourceFiles: { [id]: File } }
export function createSceneBundle({
    exportWorldToJSON,
    getImportedTemplate,
    importedPropState,
}) {
    function exportWorldToUmap() {
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

    function exportRootToGlb(root) {
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

    async function writeFileToDirectory(dirHandle, name, contents) {
        const fileHandle = await dirHandle.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(contents);
        await writable.close();
    }

    function downloadSceneFolderFallback(umap, glbAssets, rawFiles) {
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

    // Folder layout:
    //   <picked-folder>/
    //     scene.umap          (slim — actor records + assetPath references)
    //     assets/
    //       <fileName>.obj    (raw imported source files)
    //
    // Loading any folder bundle is far faster than a legacy .umap because
    // importedTemplates no longer carry rootJson; the OBJ/GLB importer runs
    // against the raw bytes the same way a fresh import does.
    async function exportWorldToSceneFolder() {
        const umap = exportWorldToJSON({ preferAssetPath: true });
        const vehicleTemplateIds = new Set();
        for (const actor of umap.actors || []) {
            if (actor?.kind !== 'vehicle') continue;
            if (actor.vehicleBodyTemplateId) vehicleTemplateIds.add(actor.vehicleBodyTemplateId);
            if (actor.vehicleWheelTemplateId) vehicleTemplateIds.add(actor.vehicleWheelTemplateId);
        }

        // Build a parallel GLB cache for every imported template referenced by
        // the bundle. GLB parses ~10x faster than text OBJ for huge models
        // (e.g. a 300 MB car), so on next load
        // registerImportedPropTemplateFromSerializedData can skip the OBJ path
        // entirely. Fall back to the raw source file for any template whose GLB
        // export fails.
        const glbAssets = new Map(); // templateId -> { fileName, blob }
        const rawFiles = new Map();  // templateId -> File (fallback only)

        for (const t of umap.importedTemplates || []) {
            const template = getImportedTemplate(t.id);
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
                    // No GLB and no raw file — re-inline rootJson so this
                    // template still loads (slower but correct).
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

    return {
        exportWorldToUmap,
        exportWorldToSceneFolder,
        exportRootToGlb,
        writeFileToDirectory,
        downloadSceneFolderFallback,
    };
}
