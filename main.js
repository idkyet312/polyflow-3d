import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import gsap from 'gsap';
import { runWebGPUBenchmark } from './webgpu_utils.js';

// --- Configuration ---
let scene, camera, renderer, controls, currentMesh;
let originalTriCount = 0;
let optimizedTriCount = 0;
let scanPlane;
let originalFileSize = 0;
let optimizedBlobUrl = null;
const EXPORT_MAX_TEXTURE_SIZE = 1024;

// Module-level refs so switchEnvironment can update them
let pedestalMat, ambientLight, hemiLight;

// HDRI texture cache keyed by full URL (1k/2k/4k cached separately)
const hdriCache = {};

// Track current state for resolution switching
let currentEnvironment = 'sunny-sky';
let currentResolution = '1k';

// Environment presets — slugs map to Poly Haven CDN
const ENVIRONMENTS = {
    'sunny-sky': {
        label: '\u2600\ufe0f Sunny Sky',
        slug: 'kloofendal_48d_partly_cloudy_puresky',
        blurriness: 0.05,
        pedestal: { color: 0xFFFFFF, roughness: 0.00, metalness: 1.0 },
        ambient: { color: 0xffffff, intensity: 1.0 },
        hemi: { sky: 0xffffff, ground: 0x444444, intensity: 1.2 },
    },
    'studio': {
        label: '\ud83c\udfac Studio',
        slug: 'studio_small_03',
        blurriness: 0.3,
        pedestal: { color: 0x1a1a1a, roughness: 0.05, metalness: 0.95 },
        ambient: { color: 0xffffff, intensity: 1.3 },
        hemi: { sky: 0xffffff, ground: 0x888888, intensity: 0.8 },
    },
    'urban-street': {
        label: '\ud83c\udfd9\ufe0f Urban Street',
        slug: 'potsdamer_platz',
        blurriness: 0.0,
        pedestal: { color: 0x1c1c1c, roughness: 0.05, metalness: 0.95 },
        ambient: { color: 0x8899bb, intensity: 0.7 },
        hemi: { sky: 0x9aaad0, ground: 0x222233, intensity: 1.0 },
    },
    'forest-trail': {
        label: '\ud83c\udf32 Forest Trail',
        slug: 'forest_slope',
        blurriness: 0.08,
        pedestal: { color: 0x2b3d1f, roughness: 0.05, metalness: 0.95 },
        ambient: { color: 0x88aa66, intensity: 0.9 },
        hemi: { sky: 0x99cc77, ground: 0x334422, intensity: 1.2 },
    },
    'golden-sunset': {
        label: '\ud83c\udf05 Golden Sunset',
        slug: 'golden_bay',
        blurriness: 0.04,
        pedestal: { color: 0x2a1f0f, roughness: 0.05, metalness: 0.95 },
        ambient: { color: 0xffbb55, intensity: 1.0 },
        hemi: { sky: 0xffaa33, ground: 0x441100, intensity: 1.0 },
    },
};

// Build the Poly Haven CDN URL or local URL for a given slug + resolution
function getHdriUrl(slug, res) {
    if (slug === 'kloofendal_48d_partly_cloudy_puresky' && res === '4k') {
        return (import.meta.env.BASE_URL || '/') + 'kloofendal_48d_partly_cloudy_puresky_4k.hdr';
    }
    return `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/${res}/${slug}_${res}.hdr`;
}

function loadHdriIntoScene(url, blurriness) {
    console.log(`Loading HDRI: ${url}`);
    if (hdriCache[url]) {
        scene.environment = hdriCache[url];
        scene.background = hdriCache[url];
        scene.backgroundBlurriness = blurriness;
        return;
    }
    const loader = new RGBELoader();
    loader.load(url, (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        hdriCache[url] = texture;
        scene.environment = texture;
        scene.background = texture;
        scene.backgroundBlurriness = blurriness;
        console.log(`Successfully loaded HDRI: ${url}`);
    }, undefined, (err) => {
        console.error('Failed to load HDRI:', url, err);
    });
}

function switchEnvironment(key) {
    const env = ENVIRONMENTS[key];
    if (!env) return;
    currentEnvironment = key;

    // Update pedestal material - REMOVED so glass stays consistent
    // Update lights
    if (ambientLight) {
        ambientLight.color.setHex(env.ambient.color);
        ambientLight.intensity = env.ambient.intensity;
    }
    if (hemiLight) {
        hemiLight.color.setHex(env.hemi.sky);
        hemiLight.groundColor.setHex(env.hemi.ground);
        hemiLight.intensity = env.hemi.intensity;
    }
    loadHdriIntoScene(getHdriUrl(env.slug, currentResolution), env.blurriness);
}

function setResolution(res) {
    currentResolution = res;
    document.querySelectorAll('.res-btn').forEach(btn => {
        btn.classList.toggle('res-btn-active', btn.dataset.res === res);
    });
    switchEnvironment(currentEnvironment);
}

const container = document.getElementById('canvas-container');
const dropZone = document.getElementById('drop-zone');
const processingOverlay = document.getElementById('processing-overlay');
const loaderBar = document.getElementById('loader-bar');
const processingStep = document.getElementById('processing-step');
const processTrigger = document.getElementById('process-trigger');
const downloadBtn = document.getElementById('download-asset');

// --- Initialization ---
async function init() {
    // Add listeners immediately so UI is responsive even if WASM is loading
    document.getElementById('load-sample').addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent file dialog from opening
        loadSample();
    });
    setupDropHandlers();

    // Slider listener
    const slider = document.getElementById('ratio-slider');
    const ratioValue = document.getElementById('ratio-value');
    if (slider) {
        slider.addEventListener('input', (e) => {
            const val = Math.round(e.target.value * 100);
            ratioValue.textContent = `${val}%`;
        });
    }

    if (!navigator.gpu) {
        const errorMsg = "WebGPU is not supported in this browser. Please use Chrome/Edge (v113+) or enable it in your flags.";
        console.error(errorMsg);
        alert(errorMsg);
        // We can't continue initialization with WebGPURenderer if it's missing
        return;
    }

    await MeshoptSimplifier.ready;
    console.log("MeshoptSimplifier ready");

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(3, 2, 5);

    renderer = new WebGPURenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(renderer.domElement);

    // Load initial HDR Environment
    switchEnvironment('sunny-sky');

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;
    controls.minDistance = 1;
    controls.maxDistance = 10;
    controls.target.set(0, 1, 0);

    // Pedestal.
    const pedestalGeo = new THREE.CylinderGeometry(2.5, 2.5, 0.1, 128);
    pedestalMat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        metalness: 0.1,
        roughness: 0.05,
        transmission: 1.0,
        thickness: 0,
        ior: 1.0, // IOR 1.0 eliminates double-refraction ghosting from the bottom cap
        transparent: true,
        opacity: 1
    });
    const pedestal = new THREE.Mesh(pedestalGeo, pedestalMat);
    pedestal.position.y = -0.1;
    pedestal.receiveShadow = true;
    scene.add(pedestal);

    // Subtle rim
    const rimGeo = new THREE.TorusGeometry(2.5, 0.02, 16, 100);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xEEEEEE, emissive: 0xEEEEEE });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0;
    //scene.add(rim);

    ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
    scene.add(ambientLight);

    hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5);
    scene.add(hemiLight);

    const mainLight = new THREE.DirectionalLight(0xffffff, 2.5);
    mainLight.position.set(5, 10, 5);
    mainLight.castShadow = true;
    mainLight.shadow.mapSize.width = 2048;
    mainLight.shadow.mapSize.height = 2048;
    mainLight.shadow.camera.near = 0.5;
    mainLight.shadow.camera.far = 15;
    mainLight.shadow.camera.left = -3;
    mainLight.shadow.camera.right = 3;
    mainLight.shadow.camera.top = 3;
    mainLight.shadow.camera.bottom = -3;
    mainLight.shadow.bias = -0.001;
    scene.add(mainLight);

    // Rim lights for extra shine
    const rimLightLeft = new THREE.DirectionalLight(0xaaccff, 2.5);
    rimLightLeft.position.set(-3, 3, -5);
    scene.add(rimLightLeft);

    const rimLightRight = new THREE.DirectionalLight(0xffccaa, 2.0);
    rimLightRight.position.set(3, 2, -5);
    scene.add(rimLightRight);

    window.addEventListener('resize', onWindowResize);

    // Environment selector
    const envSelector = document.getElementById('env-selector');
    if (envSelector) {
        envSelector.addEventListener('change', (e) => switchEnvironment(e.target.value));
    }

    // Resolution buttons
    document.querySelectorAll('.res-btn').forEach(btn => {
        btn.addEventListener('click', () => setResolution(btn.dataset.res));
    });

    renderer.setAnimationLoop(() => {
        controls.update();
        renderer.renderAsync(scene, camera);
    });
}

function loadSample() {
    dropZone.classList.add('hidden');
    if (currentMesh) scene.remove(currentMesh);

    // Create a very dense Torus Knot to simulate a "heavy" file
    const geometry = new THREE.TorusKnotGeometry(1, 0.3, 300, 100);
    const material = new THREE.MeshStandardMaterial({
        color: 0x7000ff,
        metalness: 0.8,
        roughness: 0.2,
        emissive: 0x200040
    });

    currentMesh = new THREE.Mesh(geometry, material);
    currentMesh.castShadow = true;
    currentMesh.receiveShadow = true;
    scene.add(currentMesh);

    // Sit on table
    currentMesh.geometry.computeBoundingBox();
    const box = currentMesh.geometry.boundingBox;
    const center = box.getCenter(new THREE.Vector3());

    // For the sample, we'll keep the scale as is but center it
    currentMesh.position.x = -center.x;
    currentMesh.position.z = -center.z;
    currentMesh.position.y = -box.min.y;

    document.getElementById('asset-name').textContent = 'Heavy_Industrial_Part_RAW.glb';
    document.getElementById('tri-count').textContent = 'Counting...';

    // Calculate Triangles correctly
    let totalTris = 0;
    if (geometry.index) {
        totalTris = geometry.index.count / 3;
    } else {
        totalTris = geometry.attributes.position.count / 3;
    }

    originalTriCount = Math.round(totalTris);
    console.log("Sample loaded. Triangles:", originalTriCount);

    // Animate the count-up safely using a proxy object
    const countObj = { val: 0 };
    gsap.to(countObj, {
        val: originalTriCount,
        duration: 1.5,
        ease: "power2.out",
        onUpdate: () => {
            document.getElementById('tri-count').textContent = Math.ceil(countObj.val).toLocaleString();
        }
    });

    originalFileSize = 5400000; // ~5.4 MB for the sample
    document.getElementById('file-size').textContent = (originalFileSize / (1024 * 1024)).toFixed(1) + ' MB';
    document.getElementById('file-diff').textContent = '';
    document.getElementById('webgpu-speedup').textContent = '--';

    processTrigger.style.opacity = '1';
    processTrigger.style.cursor = 'pointer';
    processTrigger.onclick = runOptimizationPipeline;
}

// Render loop now handled by setAnimationLoop in init

function onWindowResize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}

// --- File Handling ---

// Reads all files from a dropped directory entry recursively, returns filename→{file,url} map
async function readDirectoryFiles(dirEntry) {
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

function setupDropHandlers() {
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#7000ff';
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.style.borderColor = 'rgba(255, 255, 255, 0.1)';
    });

    dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropZone.style.borderColor = 'rgba(255, 255, 255, 0.1)';

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

        // --- Single file drop ---
        const file = e.dataTransfer.files[0];
        if (file && /\.(glb|gltf|obj|fbx)$/i.test(file.name)) {
            loadModel(file, {});
        } else {
            alert('Please drop a .glb, .gltf, .obj, or .fbx file — or drag a whole folder to load FBX textures.');
        }
    });

    const fileInput = document.getElementById('file-input');
    dropZone.addEventListener('click', () => { fileInput.click(); });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) loadModel(file, {});
    });
}

async function loadModel(file, fileMap = {}) {
    dropZone.classList.add('hidden');
    const url = URL.createObjectURL(file);

    document.getElementById('asset-name').textContent = file.name;
    document.getElementById('tri-count').textContent = 'Counting...';

    originalFileSize = file.size;
    document.getElementById('file-size').textContent = (originalFileSize / (1024 * 1024)).toFixed(1) + ' MB';
    document.getElementById('file-diff').textContent = '';
    document.getElementById('webgpu-speedup').textContent = '--';

    const extension = file.name.split('.').pop().toLowerCase();

    // Build a LoadingManager that resolves texture filenames from the uploaded file map
    const manager = new THREE.LoadingManager();
    manager.addHandler(/\.tga$/i, new TGALoader(manager));
    if (Object.keys(fileMap).length > 0) {
        manager.setURLModifier(originalUrl => {
            // Extract just the filename (strip path separators, handle both / and \\)
            const filename = originalUrl.split(/[\/\\]/).pop().toLowerCase();
            if (fileMap[filename]) {
                console.log(`[TextureResolver] Resolved: ${filename}`);
                return fileMap[filename].url;
            }
            return originalUrl;
        });
    }

    const onLoad = (object) => {
        if (currentMesh) scene.remove(currentMesh);
        currentMesh = object.scene || object; // GLTF uses object.scene, OBJ uses object directly
        scene.add(currentMesh);

        // Convert materials to MeshStandardMaterial (required for WebGPU renderer)
        currentMesh.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;

                if (!child.geometry.attributes.normal) {
                    child.geometry.computeVertexNormals();
                }

                const mats = Array.isArray(child.material) ? child.material : [child.material];
                child.material = mats.map(mat => {
                    if (!mat) return mat;

                    const hasAlphaMap = !!mat.alphaMap;
                    const isActuallyTransparent = (mat.transparent || false) && ((mat.opacity ?? 1.0) < 1.0 || hasAlphaMap);

                    // If it's already a StandardMaterial (GLB/GLTF), just patch it
                    if (mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial) {
                        mat.side = THREE.FrontSide;
                        // Reduce environment/specular contribution to avoid doubled highlights
                        mat.envMapIntensity = Math.min(mat.envMapIntensity ?? 0.6, 0.75);
                        // Clamp metalness and increase base roughness for safety
                        mat.metalness = Math.min(mat.metalness ?? 0.0, 0.25);
                        mat.roughness = Math.max(mat.roughness ?? 0.5, 0.35);
                        mat.transparent = isActuallyTransparent;
                        mat.alphaTest = hasAlphaMap ? Math.max(mat.alphaTest || 0, 0.5) : (mat.alphaTest || 0);
                        mat.depthWrite = !isActuallyTransparent || hasAlphaMap;
                        mat.needsUpdate = true;
                        return mat;
                    }

                    // Convert FBX/OBJ legacy Phong/Lambert → Standard (WebGPU requires this)
                    const stdMat = new THREE.MeshStandardMaterial({
                        name: mat.name,
                        // Preserve exact color — DO NOT override
                        color: mat.color ? mat.color.clone() : new THREE.Color(0x888888),
                        // All texture maps
                        map: mat.map || null,
                        normalMap: mat.normalMap || null,
                        emissive: mat.emissive ? mat.emissive.clone() : new THREE.Color(0x000000),
                        emissiveMap: mat.emissiveMap || null,
                        emissiveIntensity: mat.emissiveIntensity || 1.0,
                        alphaMap: mat.alphaMap || null,
                        bumpMap: mat.bumpMap || null,
                        bumpScale: mat.bumpScale || 1.0,
                        roughnessMap: mat.specularMap || null, // specular ≈ inverse roughness
                        roughness: 0.6,
                        metalness: 0.1,
                        // Transparency
                        transparent: isActuallyTransparent,
                        opacity: mat.opacity !== undefined ? mat.opacity : 1.0,
                        alphaTest: hasAlphaMap ? 0.5 : (mat.alphaTest || 0),
                        depthWrite: !isActuallyTransparent || hasAlphaMap,
                        // Vertex colors
                        vertexColors: !!child.geometry.attributes.color,
                        side: THREE.FrontSide,
                        envMapIntensity: 0.6,
                    });

                    // Fix color space on every texture
                    [stdMat.map, stdMat.emissiveMap, stdMat.alphaMap, stdMat.roughnessMap].forEach(tex => {
                        if (tex) { tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true; }
                    });

                    // Only brighten if pitch black AND no texture at all (invisible geometry)
                    if (stdMat.color.getHex() === 0x000000 && !stdMat.map && !child.geometry.attributes.color) {
                        stdMat.color.setHex(0x888888);
                    }

                    return stdMat;
                });
                // Unwrap single-material arrays
                if (child.material.length === 1) child.material = child.material[0];
            }
        });

        // Center and scale model properly
        const box = new THREE.Box3().setFromObject(currentMesh);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());

        // Scale the model so its largest dimension is 4.0
        const maxDim = Math.max(size.x, size.y, size.z);
        const targetScale = 4.0 / maxDim;
        currentMesh.scale.setScalar(targetScale);

        // Position: Center horizontally and place bottom at Y=0
        currentMesh.position.x = -center.x * targetScale;
        currentMesh.position.z = -center.z * targetScale;
        currentMesh.position.y = -box.min.y * targetScale;

        // Calculate Triangles
        let totalTris = 0;
        currentMesh.traverse((child) => {
            if (child.isMesh) {
                const geo = child.geometry;
                if (geo.index) {
                    totalTris += geo.index.count / 3;
                } else {
                    totalTris += geo.attributes.position.count / 3;
                }
            }
        });
        originalTriCount = Math.round(totalTris);
        console.log("Model loaded. Triangles:", originalTriCount);

        // Animate the count-up safely using a proxy object
        const countObj = { val: 0 };
        gsap.to(countObj, {
            val: originalTriCount,
            duration: 1.5,
            ease: "power2.out",
            onUpdate: () => {
                document.getElementById('tri-count').textContent = Math.ceil(countObj.val).toLocaleString();
            }
        });

        // Enable Process Button
        processTrigger.style.opacity = '1';
        processTrigger.style.cursor = 'pointer';
        processTrigger.addEventListener('click', runOptimizationPipeline);
    };

    if (extension === 'glb' || extension === 'gltf') {
        const loader = new GLTFLoader(manager);
        loader.load(url, onLoad);
    } else if (extension === 'obj') {
        const loader = new OBJLoader(manager);
        loader.load(url, onLoad);
    } else if (extension === 'fbx') {
        const loader = new FBXLoader(manager);
        loader.load(url, onLoad);
    } else {
        alert('Unsupported file format');
    }
}

// --- Optimization Pipeline ---
async function runOptimizationPipeline() {
    processingOverlay.style.display = 'flex';
    const isPro = false;

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
        await compressTextures(currentMesh, 0.8, EXPORT_MAX_TEXTURE_SIZE, isPro);

        // Export to get real size
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
    if (!currentMesh) return;

    stopScanEffect();

    let totalReducedTris = 0;

    currentMesh.traverse((child) => {
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

function getTextureCompressionProfile(name, quality, maxSize) {
    const profiles = {
        map: { quality, maxSize, allowJpeg: true, detectAlpha: true },
        normalMap: { quality: Math.min(quality, 0.72), maxSize: Math.min(maxSize, 1024), allowJpeg: false, detectAlpha: false },
        roughnessMap: { quality: Math.min(quality, 0.68), maxSize: Math.min(maxSize, 1024), allowJpeg: true, detectAlpha: false },
        metalnessMap: { quality: Math.min(quality, 0.68), maxSize: Math.min(maxSize, 1024), allowJpeg: true, detectAlpha: false },
        emissiveMap: { quality: Math.min(quality, 0.78), maxSize: Math.min(maxSize, 1024), allowJpeg: true, detectAlpha: true },
        aoMap: { quality: Math.min(quality, 0.68), maxSize: Math.min(maxSize, 1024), allowJpeg: true, detectAlpha: false },
        alphaMap: { quality: Math.min(quality, 0.72), maxSize: Math.min(maxSize, 1024), allowJpeg: false, detectAlpha: false },
    };

    return profiles[name] || { quality, maxSize, allowJpeg: true, detectAlpha: true };
}

async function getImageSourceSize(image) {
    const sourceUrl = image?.currentSrc || image?.src;
    if (!sourceUrl) return null;

    try {
        const response = await fetch(sourceUrl);
        const blob = await response.blob();
        return blob.size;
    } catch {
        return null;
    }
}

function createTextureCanvas(width, height) {
    if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(width, height);
        return {
            canvas,
            ctx: canvas.getContext('2d', { alpha: true }),
            useOffscreen: true,
        };
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return {
        canvas,
        ctx: canvas.getContext('2d', { alpha: true }),
        useOffscreen: false,
    };
}

async function canvasToBlob(canvas, mimeType, quality, useOffscreen) {
    if (useOffscreen) {
        return canvas.convertToBlob({ type: mimeType, quality });
    }

    return new Promise(resolve => {
        canvas.toBlob(resolve, mimeType, quality);
    });
}

function hasTransparency(ctx, width, height) {
    const step = Math.max(1, Math.floor(Math.max(width, height) / 128));
    const { data } = ctx.getImageData(0, 0, width, height);

    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            const alphaIndex = ((y * width) + x) * 4 + 3;
            if (data[alphaIndex] < 255) {
                return true;
            }
        }
    }

    return false;
}

function cloneTextureSettings(source, target, mimeType, colorSpace) {
    target.name = source.name;
    target.wrapS = source.wrapS;
    target.wrapT = source.wrapT;
    target.magFilter = THREE.LinearFilter;
    target.minFilter = THREE.LinearMipmapLinearFilter;
    target.generateMipmaps = true;
    target.flipY = source.flipY;
    target.colorSpace = colorSpace;
    target.repeat.copy(source.repeat);
    target.offset.copy(source.offset);
    target.center.copy(source.center);
    target.rotation = source.rotation;
    target.anisotropy = source.anisotropy;
    target.channel = source.channel;
    target.userData = { ...source.userData, mimeType };
    target.needsUpdate = true;
}

// === TEXTURE OPTIMIZATION (Best-in-class 2026 pipeline) ===
async function compressTextures(object, quality = 0.85, maxSize = 2048, useKTX2 = false) {
    const textureMap = new Map();
    const texturePromises = [];

    object.traverse(child => {
        if (!child.isMesh) return;

        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(mat => {
            if (!mat) return;

            const mapNames = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap'];
            mapNames.forEach(name => {
                const tex = mat[name];
                if (tex && tex.isTexture && tex.image && !textureMap.has(tex.uuid)) {
                    const isNormal = name === 'normalMap' || (tex.name && tex.name.toLowerCase().includes('normal'));
                    const profile = getTextureCompressionProfile(name, quality, maxSize);
                    const promise = (useKTX2
                        ? compressTextureToKTX2(tex, profile.quality, profile.maxSize, isNormal)
                        : compressTextureToWebP(tex, profile, isNormal)
                    ).then(newTex => {
                        textureMap.set(tex.uuid, newTex);
                        mat[name] = newTex;
                    });
                    texturePromises.push(promise);
                } else if (tex && tex.isTexture) {
                    mat[name] = textureMap.get(tex.uuid) || tex;
                }
            });
        });
    });

    await Promise.all(texturePromises);
    console.log(`Texture optimization complete (${useKTX2 ? 'KTX2/BasisU' : 'WebP'})`);
}

async function compressTextureToWebP(texture, profile, isNormal) {
    const img = texture.image;
    let width = img.width || img.videoWidth || 512;
    let height = img.height || img.videoHeight || 512;

    if (width > profile.maxSize || height > profile.maxSize) {
        const ratio = Math.min(profile.maxSize / width, profile.maxSize / height);
        width = Math.floor(width * ratio);
        height = Math.floor(height * ratio);
    }

    const { canvas, ctx, useOffscreen } = createTextureCanvas(width, height);

    if (!ctx) return texture;

    ctx.drawImage(img, 0, 0, width, height);

    const hasAlpha = profile.detectAlpha ? hasTransparency(ctx, width, height) : false;
    const candidates = [{ mimeType: 'image/webp', quality: profile.quality }];

    if (!isNormal && profile.allowJpeg && !hasAlpha) {
        candidates.push({ mimeType: 'image/jpeg', quality: Math.max(0.55, profile.quality - 0.08) });
    }

    const blobs = await Promise.all(candidates.map(async candidate => {
        const blob = await canvasToBlob(canvas, candidate.mimeType, candidate.quality, useOffscreen);
        return blob ? { ...candidate, blob } : null;
    }));

    const validCandidates = blobs.filter(Boolean);
    if (validCandidates.length === 0) return texture;

    let bestCandidate = validCandidates[0];
    for (const candidate of validCandidates) {
        if (candidate.blob.size < bestCandidate.blob.size) {
            bestCandidate = candidate;
        }
    }

    const originalSize = await getImageSourceSize(img);
    if (originalSize && bestCandidate.blob.size >= originalSize) {
        return texture;
    }

    return new Promise(resolve => {
        const url = URL.createObjectURL(bestCandidate.blob);
        const loader = new THREE.TextureLoader();
        loader.load(url, newTexture => {
            cloneTextureSettings(
                texture,
                newTexture,
                bestCandidate.mimeType,
                isNormal ? THREE.NoColorSpace : THREE.SRGBColorSpace
            );
            resolve(newTexture);
            URL.revokeObjectURL(url);
        }, undefined, () => {
            URL.revokeObjectURL(url);
            resolve(texture);
        });
    });
}

// === KTX2 + Basis Universal (Pro tier – 70-95% reduction + GPU-native) ===
// Uncomment and implement when you add the Basis encoder WASM.
async function compressTextureToKTX2(texture, quality, maxSize, isNormal) {
    console.warn('KTX2 Pro feature – using WebP fallback for now');
    return compressTextureToWebP(texture, {
        quality,
        maxSize,
        allowJpeg: !isNormal,
        detectAlpha: !isNormal,
    }, isNormal);
}

function downloadAsset() {
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

// Add download listener (using onclick to prevent duplicate listeners on HMR)
downloadBtn.onclick = downloadAsset;

function stopScanEffect() {
    if (scanPlane) {
        scene.remove(scanPlane);
        scanPlane = null;
    }
}

function startScanEffect() {
    const geometry = new THREE.PlaneGeometry(5, 5);
    const material = new THREE.MeshBasicMaterial({
        color: 0x00ffaa,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending
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
        ease: "power1.inOut"
    });
}

// --- Controls ---
document.getElementById('toggle-wireframe').addEventListener('click', () => {
    currentMesh.traverse(child => {
        if (child.isMesh) child.material.wireframe = !child.material.wireframe;
    });
});

document.getElementById('reset-view').addEventListener('click', () => {
    gsap.to(camera.position, { x: 3, y: 2, z: 5, duration: 1 });
    gsap.to(controls.target, { x: 0, y: 1, z: 0, duration: 1 });
    // controls.reset();
});

init();
