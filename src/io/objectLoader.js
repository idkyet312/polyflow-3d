import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';

const _tempCenter = new THREE.Vector3();
const _tempSize = new THREE.Vector3();

function applyImportedMeshShadowSettings(mesh) {
    if (!mesh?.isMesh) return;

    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => {
        if (!material) return;
        material.shadowSide = THREE.DoubleSide;
        material.needsUpdate = true;
    });
}

export function cloneDisposableObject(root) {
    const clone = root.clone(true);

    clone.traverse((child) => {
        if (!child.isMesh) return;

        child.geometry = child.geometry.clone();
        child.material = Array.isArray(child.material)
            ? child.material.map((material) => material.clone())
            : child.material.clone();
        applyImportedMeshShadowSettings(child);
    });

    return clone;
}

export function formatImportedPropName(name) {
    const withoutExtension = name.replace(/\.[^.]+$/, '');
    const collapsed = withoutExtension.replace(/[\-_]+/g, ' ').trim();
    return collapsed || 'Imported Prop';
}

export function normalizeObjectToDimension(root, targetDimension, centerOnFloor = true) {
    if (!root) return;

    root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(_tempCenter);
    const size = box.getSize(_tempSize);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const targetScale = targetDimension / maxDim;

    root.scale.setScalar(targetScale);
    root.position.x = -center.x * targetScale;
    root.position.z = -center.z * targetScale;
    root.position.y = centerOnFloor ? -box.min.y * targetScale : -center.y * targetScale;
    root.updateMatrixWorld(true);
}

export function createLoadingManager(fileMap = {}) {
    const manager = new THREE.LoadingManager();
    manager.addHandler(/\.tga$/i, new TGALoader(manager));
    manager.addHandler(/\.dds$/i, new DDSLoader(manager));
    manager.onLoad = () => console.log('[TextureManager] All textures loaded');
    manager.onError = (url) => console.warn('[TextureManager] Failed to load:', url);

    manager.setURLModifier((originalUrl) => {
        if (originalUrl.startsWith('data:') || originalUrl.startsWith('blob:')) {
            return originalUrl;
        }

        const filename = originalUrl.split(/[\\/]/).pop().split('?')[0].split('#')[0].toLowerCase();
        if (fileMap[filename]) {
            console.log(`[TextureResolver] Resolved: ${filename}`);
            return fileMap[filename].url;
        }

        const baseName = filename.replace(/\.[^.]+$/, '');
        const possibleExts = ['.png', '.jpg', '.jpeg', '.tga', '.dds', '.bmp', '.webp'];

        for (const ext of possibleExts) {
            const possibleName = baseName + ext;
            if (fileMap[possibleName]) {
                console.log(`[TextureResolver] Resolved ${filename} -> ${possibleName}`);
                return fileMap[possibleName].url;
            }
        }

        if (Object.keys(fileMap).length > 0) {
            console.warn(`[TextureResolver] Not found: ${filename}`);
        }

        return originalUrl;
    });

    return manager;
}

export function convertLoadedObjectMaterials(root) {
    root.traverse((child) => {
        if (!child.isMesh) return;

        applyImportedMeshShadowSettings(child);

        if (!child.geometry.attributes.normal) {
            child.geometry.computeVertexNormals();
        }

        const materials = Array.isArray(child.material) ? child.material : [child.material];
        child.material = materials.map((material) => {
            if (!material) return material;

            const hasAlphaMap = !!material.alphaMap;
            const isActuallyTransparent = (material.transparent || false) && ((material.opacity ?? 1.0) < 1.0 || hasAlphaMap);
            const hasEmissiveColor = !!material.emissive
                && (material.emissive.r > 0 || material.emissive.g > 0 || material.emissive.b > 0);
            const hasEmissiveContent = (material.emissiveIntensity ?? 1) > 0
                && (!!material.emissiveMap || hasEmissiveColor);

            if (material.isMeshStandardMaterial || material.isMeshPhysicalMaterial) {
                material.side = THREE.FrontSide;
                material.envMapIntensity = Math.min(material.envMapIntensity ?? 0.6, 0.75);
                material.metalness = Math.min(material.metalness ?? 0.0, 0.25);
                material.roughness = Math.max(material.roughness ?? 0.5, 0.35);
                material.fog = !hasEmissiveContent;
                material.transparent = isActuallyTransparent;
                material.alphaTest = hasAlphaMap ? Math.max(material.alphaTest || 0, 0.5) : (material.alphaTest || 0);
                material.depthWrite = !isActuallyTransparent || hasAlphaMap;
                material.needsUpdate = true;
                return material;
            }

            const shininess = material.shininess ?? 30;
            const computedRoughness = Math.max(0.04, 1.0 - Math.sqrt(Math.min(shininess, 1000) / 1000));
            const specularIntensity = material.specular ? (material.specular.r + material.specular.g + material.specular.b) / 3 : 0;
            const computedMetalness = Math.min(0.5, specularIntensity * 0.5);

            const standardMaterial = new THREE.MeshStandardMaterial({
                name: material.name,
                color: material.color ? material.color.clone() : new THREE.Color(0x888888),
                map: material.map || null,
                normalMap: material.normalMap || material.bumpMap || null,
                emissive: material.emissive ? material.emissive.clone() : new THREE.Color(0x000000),
                emissiveMap: material.emissiveMap || null,
                emissiveIntensity: material.emissiveIntensity || 1.0,
                alphaMap: material.alphaMap || null,
                aoMap: material.aoMap || material.lightMap || null,
                aoMapIntensity: 1.0,
                roughness: material.specularMap ? 0.5 : computedRoughness,
                roughnessMap: null,
                metalness: computedMetalness,
                metalnessMap: null,
                transparent: isActuallyTransparent,
                opacity: material.opacity !== undefined ? material.opacity : 1.0,
                alphaTest: hasAlphaMap ? 0.5 : (material.alphaTest || 0),
                depthWrite: !isActuallyTransparent || hasAlphaMap,
                fog: !hasEmissiveContent,
                vertexColors: !!child.geometry.attributes.color,
                side: THREE.FrontSide,
                envMapIntensity: 0.6,
            });

            if (material.bumpMap && !material.normalMap) {
                standardMaterial.bumpMap = null;
                standardMaterial.bumpScale = 1.0;
            }

            if (standardMaterial.map) {
                standardMaterial.map.colorSpace = THREE.SRGBColorSpace;
                standardMaterial.map.needsUpdate = true;
            }

            if (standardMaterial.emissiveMap) {
                standardMaterial.emissiveMap.colorSpace = THREE.SRGBColorSpace;
                standardMaterial.emissiveMap.needsUpdate = true;
            }

            ['normalMap', 'alphaMap', 'roughnessMap', 'aoMap'].forEach((mapName) => {
                if (standardMaterial[mapName]) {
                    standardMaterial[mapName].colorSpace = THREE.NoColorSpace || '';
                    standardMaterial[mapName].needsUpdate = true;
                }
            });

            if (standardMaterial.color.getHex() === 0x000000 && !standardMaterial.map && !child.geometry.attributes.color) {
                standardMaterial.color.setHex(0x888888);
            }

            return standardMaterial;
        });

        if (child.material.length === 1) {
            child.material = child.material[0];
        }
    });
}

export function loadObjectFromFile(file, fileMap = {}) {
    const extension = file.name.split('.').pop().toLowerCase();
    const url = URL.createObjectURL(file);
    const manager = createLoadingManager(fileMap);

    return new Promise((resolve, reject) => {
        const cleanup = () => URL.revokeObjectURL(url);
        const finishLoad = (object) => {
            cleanup();
            const root = object.scene || object;
            convertLoadedObjectMaterials(root);
            resolve(root);
        };

        const failLoad = (error) => {
            cleanup();
            reject(error);
        };

        try {
            if (extension === 'glb' || extension === 'gltf') {
                const loader = new GLTFLoader(manager);
                loader.load(url, finishLoad, undefined, failLoad);
            } else if (extension === 'obj') {
                const loader = new OBJLoader(manager);
                loader.load(url, finishLoad, undefined, failLoad);
            } else if (extension === 'fbx') {
                const loader = new FBXLoader(manager);
                loader.load(url, finishLoad, undefined, failLoad);
            } else {
                cleanup();
                reject(new Error('Unsupported file format'));
            }
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}
