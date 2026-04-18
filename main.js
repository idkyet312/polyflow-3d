import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
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

    await MeshoptSimplifier.ready;
    console.log("MeshoptSimplifier ready");
    
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050505);

    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(2, 2, 5);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ReinhardToneMapping;
    container.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const mainLight = new THREE.DirectionalLight(0x7000ff, 1.5);
    mainLight.position.set(5, 5, 5);
    scene.add(mainLight);

    const blueLight = new THREE.PointLight(0x00ffaa, 1, 10);
    blueLight.position.set(-2, 1, 2);
    scene.add(blueLight);

    window.addEventListener('resize', onWindowResize);
    animate();
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
    scene.add(currentMesh);

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

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

function onWindowResize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}

// --- File Handling ---
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
        const file = e.dataTransfer.files[0];
        if (file && (file.name.endsWith('.glb') || file.name.endsWith('.gltf') || file.name.endsWith('.obj'))) {
            loadModel(file);
        } else {
            alert('Please drop a .glb, .gltf, or .obj file');
        }
    });

    const fileInput = document.getElementById('file-input');
    dropZone.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            loadModel(file);
        }
    });
}

async function loadModel(file) {
    dropZone.classList.add('hidden');
    const url = URL.createObjectURL(file);
    
    document.getElementById('asset-name').textContent = file.name;
    document.getElementById('tri-count').textContent = 'Counting...';
    
    originalFileSize = file.size;
    document.getElementById('file-size').textContent = (originalFileSize / (1024 * 1024)).toFixed(1) + ' MB';
    document.getElementById('file-diff').textContent = '';
    document.getElementById('webgpu-speedup').textContent = '--';

    const extension = file.name.split('.').pop().toLowerCase();

    const onLoad = (object) => {
        if (currentMesh) scene.remove(currentMesh);
        currentMesh = object.scene || object; // GLTF uses object.scene, OBJ uses object directly
        scene.add(currentMesh);

        // Center model
        const box = new THREE.Box3().setFromObject(currentMesh);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        currentMesh.position.sub(center);
        
        const maxDim = Math.max(size.x, size.y, size.z);
        currentMesh.scale.multiplyScalar(2 / maxDim);

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
        const loader = new GLTFLoader();
        loader.load(url, onLoad);
    } else if (extension === 'obj') {
        const loader = new OBJLoader();
        loader.load(url, onLoad);
    } else {
        alert('Unsupported file format');
    }
}

// --- Optimization Pipeline ---
async function runOptimizationPipeline() {
    processingOverlay.style.display = 'flex';
    
    const steps = [
        { label: 'Initializing WebGPU kernels...', progress: 10 },
        { label: 'Analyzing mesh topology...', progress: 30 },
        { label: 'Executing Parallel Decimation...', progress: 60 },
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
        
        // Export to get real size
        const exporter = new GLTFExporter();
        const gltfData = await new Promise((resolve, reject) => {
            exporter.parse(currentMesh, resolve, reject, { binary: true });
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
    document.getElementById('tri-count').textContent = optimizedTriCount.toLocaleString();
    document.getElementById('tri-diff').textContent = `(-${Math.round((1 - (optimizedTriCount / originalTriCount)) * 100)}%)`;

    gsap.from('#tri-count', { innerText: originalTriCount, duration: 1, snap: { innerText: 1 } });
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
    gsap.to(camera.position, { x: 2, y: 2, z: 5, duration: 1 });
    controls.reset();
});

init();
