import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import gsap from 'gsap';
import initJolt from 'jolt-physics/wasm-compat';
import { runWebGPUBenchmark } from './webgpu_utils.js';

// --- Configuration ---
let scene, camera, renderer, currentMesh;
let originalTriCount = 0;
let optimizedTriCount = 0;
let scanPlane;
let originalFileSize = 0;
let optimizedBlobUrl = null;
const EXPORT_MAX_TEXTURE_SIZE = 1024;
const MODEL_TARGET_MAX_DIMENSION = 12;
const PROP_TARGET_MAX_DIMENSION = 2.35;
const IMPORTED_PROP_MAX_HULL_POINTS = 480;
const IMPORTED_PROP_MAX_HULL_PARTS = 18;
const IMPORTED_PROP_COMPLEX_HULL_RADIUS = 0.01;
const TERRAIN_SIZE = 180;
const TERRAIN_SEGMENTS = 180;
const TERRAIN_Y_OFFSET = -0.28;
const TERRAIN_TEXTURE_REPEAT = 28;
const TERRAIN_TEXTURE_PATHS = {
    color: 'textures/grass004/Grass004_1K-JPG_Color.jpg',
    normal: 'textures/grass004/Grass004_1K-JPG_NormalGL.jpg',
    roughness: 'textures/grass004/Grass004_1K-JPG_Roughness.jpg',
    ao: 'textures/grass004/Grass004_1K-JPG_AmbientOcclusion.jpg',
};
const SHOWCASE_CAMERA_POSITION = new THREE.Vector3(6.5, 4.2, 8.5);
const SHOWCASE_CAMERA_TARGET = new THREE.Vector3(0, 1.4, 0);
const LIGHT_GRID_DIMENSION = 3;
const LIGHT_TILE_SIZE = 0.82;
const LIGHT_TILE_HEIGHT = 0.34;
const LIGHT_TILE_GAP = 0.26;
const LIGHT_GRID_OFFSET = new THREE.Vector3(-4.5, 0, 3.5);
const JOLT_NON_MOVING_LAYER = 0;
const JOLT_MOVING_LAYER = 1;
const JOLT_OBJECT_LAYER_COUNT = 2;
const JOLT_BROAD_PHASE_LAYER_COUNT = 2;
const PLAYER_SETTINGS = {
    eyeHeight: 1.7,
    walkSpeed: 4.5,
    sprintSpeed: 7.2,
    jumpSpeed: 6.8,
    gravity: 18,
    collisionRadius: 0.6,
    wallClearance: 0.12,
    probeHeight: 80,
    maxLookPitch: Math.PI / 2 - 0.08,
    floorOffset: 0.04,
};

// Module-level refs so switchEnvironment can update them
let pedestalMat, ambientLight, hemiLight, pedestal, worldFloor;
let playHint, gameplayStatus, resetViewBtn, showcaseModeBtn, playModeBtn, browseModelBtn, spawnRigidSphereBtn, spawnRigidCubeBtn;
let importPropBtn, propFileInput, importedPropList, importedPropLibrary, propImportDefaultStatus, resetPropImportDefaultBtn;
let propCollisionPrompt, propCollisionCopy, propCollisionRemember, propCollisionSimpleBtn, propCollisionComplexBtn, propCollisionCancelBtn;
let leftMouseActionInput, rightMouseActionInput, mouseActionApplyBtn, mouseActionResetBtn, mouseActionStatus;
let objectScriptMenu, objectScriptTickActionBtn, objectScriptCollisionActionBtn;
let objectScriptEditor, objectScriptEditorTitle, objectScriptEditorTarget, objectScriptEditorMode;
let objectScriptEditorInput, objectScriptEditorStatus, objectScriptEditorApplyBtn, objectScriptEditorClearBtn, objectScriptEditorCancelBtn;
let objectScriptTickToggleRow, objectScriptTickToggleInput;
let debugConsole, debugConsoleOutput, debugConsoleInput, debugConsoleFooter, debugStatsOverlay;
let mobileMenuToggleBtn, mobileModeToggleBtn;
let mobileMovePad, mobileMoveThumb, mobileLookPad, mobileLookThumb;
let mobileJumpBtn, mobileRightActionBtn;
let lightGridGroup;
const lightGridTiles = [];
const IMPORTED_PROP_COLLISION_LABELS = {
    simple: 'simple box collision',
    complex: 'tighter convex collision',
};
const MOBILE_MOVE_THRESHOLD = 0.18;
const MOBILE_MOVE_RADIUS_FACTOR = 0.36;
const MOBILE_LOOK_SENSITIVITY = 0.0045;
const mobileState = {
    enabled: false,
    menuOpen: false,
    movePointerId: null,
    lookPointerId: null,
    lastWorldTapTime: 0,
    lastWorldTapX: 0,
    lastWorldTapY: 0,
};
const importedPropState = {
    nextId: 1,
    templates: [],
    futureCollisionMode: null,
    promptResolver: null,
};
const MOUSE_ACTION_STORAGE_KEY = 'polyflow-3d.mouse-actions.v1';
const OBJECT_SCRIPT_STORAGE_KEY = 'polyflow-3d.object-scripts.v1';
const DEBUG_CONSOLE_LOG_LIMIT = 18;
const DEBUG_CONSOLE_HISTORY_LIMIT = 24;
const DEBUG_TIMING_SAMPLE_LIMIT = 30;
const DEFAULT_MOUSE_ACTION_SCRIPTS = {
    left: `const sphere = spawnDynamicPrimitive('sphere', new THREE.Vector3(0, -1, 0), 0.5);
if (sphere) {
    physics.bodyInterface.SetMotionQuality(
        sphere.GetID(),
        physics.Jolt.EMotionQuality_LinearCast
    );

    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    direction.normalize();

    const velocity = new physics.Jolt.Vec3(
        direction.x * 36000,
        direction.y * 36000,
        direction.z * 36000
    );

    physics.bodyInterface.AddImpulse(sphere.GetID(), velocity);
    physics.Jolt.destroy(velocity);
}`,
    right: `const cubesPerSide = 5;
const totalCubes = 500;
const cubeHalfExtent = 0.16;
const spacing = cubeHalfExtent * 2;
const baseYOffset = -0.8;
let spawned = 0;

for (let layer = 0; spawned < totalCubes; layer++) {
    for (let row = 0; row < cubesPerSide && spawned < totalCubes; row++) {
        for (let col = 0; col < cubesPerSide && spawned < totalCubes; col++) {
            const xOffset = (col - (cubesPerSide - 1) * 0.5) * spacing;
            const yOffset = baseYOffset + layer * spacing;
            const zOffset = (row - (cubesPerSide - 1) * 0.5) * spacing;
            const cube = spawnDynamicPrimitive(
                'cube',
                new THREE.Vector3(xOffset, yOffset, zOffset),
                cubeHalfExtent,
                {
                    skipImpulse: true,
                    activate: false,
                    castShadow: false,
                    receiveShadow: false,
                    allowSleeping: true,
                    linearDamping: 0.18,
                    angularDamping: 0.22,
                    motionQuality: physics.Jolt.EMotionQuality_Discrete,
                }
            );

            if (cube) {
                physics.bodyInterface.SetMotionQuality(
                    cube.GetID(),
                    physics.Jolt.EMotionQuality_Discrete
                );
            }

            spawned += 1;
        }
    }
}`,
};
const MouseActionFunction = Object.getPrototypeOf(async function () {}).constructor;
const ObjectEventFunction = MouseActionFunction;
const mouseActionState = {
    leftSource: DEFAULT_MOUSE_ACTION_SCRIPTS.left,
    rightSource: DEFAULT_MOUSE_ACTION_SCRIPTS.right,
    leftCompiled: null,
    rightCompiled: null,
    leftError: '',
    rightError: '',
};
const objectScriptState = {
    nextPropId: 1,
    drafts: {},
    menuOpen: false,
    editorOpen: false,
    menuScreenX: 0,
    menuScreenY: 0,
    targetPropId: '',
    targetEvent: 'tick',
};
const debugConsoleState = {
    visible: false,
    lines: [
        { prefix: 'sys', text: 'Console ready. Try `stat unit`, `stat physics`, or `stat gpu`.', tone: 'success' },
    ],
    history: [],
    historyIndex: -1,
    panels: new Set(),
    panelRefs: new Map(),
    latest: {
        frame: 0,
        update: 0,
        physics: 0,
        physicsStep: 0,
        physicsSync: 0,
        physicsCollisions: 0,
        scripts: 0,
        render: 0,
        fps: 0,
        delta: 0,
        collisionSteps: 0,
    },
    samples: {
        frame: [],
        update: [],
        physics: [],
        physicsStep: [],
        physicsSync: [],
        physicsCollisions: [],
        scripts: [],
        render: [],
    },
    gpuTimingMode: 'approximate',
};

const clock = new THREE.Clock();
const downVector = new THREE.Vector3(0, -1, 0);
const upVector = new THREE.Vector3(0, 1, 0);
const gameplayBounds = new THREE.Box3();
const gameplayLookTarget = new THREE.Vector3(0, 1, 0);
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const tempVectorA = new THREE.Vector3();
const tempVectorB = new THREE.Vector3();
const tempVectorC = new THREE.Vector3();
const tempVectorD = new THREE.Vector3();
const tempVectorE = new THREE.Vector3();
const tempBoxA = new THREE.Box3();
const tempQuaternionA = new THREE.Quaternion();
const gameplay = {
    canPlay: true,
    active: false,
    pointerLocked: false,
    grounded: false,
    yaw: 0,
    pitch: -0.1,
    spawnYaw: 0,
    spawnPitch: -0.1,
    velocity: new THREE.Vector3(),
    spawnPoint: new THREE.Vector3(0, PLAYER_SETTINGS.eyeHeight + 0.2, 6),
    input: {
        forward: false,
        back: false,
        left: false,
        right: false,
        sprint: false,
    },
};
const showcase = {
    looking: false,
    yaw: 0,
    pitch: -0.1,
    moveSpeed: 9,
    minMoveSpeed: 2,
    maxMoveSpeed: 48,
    wheelSpeedStep: 1.18,
    boostMultiplier: 2.4,
    velocity: new THREE.Vector3(),
    input: {
        forward: false,
        back: false,
        left: false,
        right: false,
        up: false,
        down: false,
        boost: false,
    },
};
const physics = {
    ready: false,
    failed: false,
    Jolt: null,
    jolt: null,
    physicsSystem: null,
    bodyInterface: null,
    gravity: null,
    movingBroadPhaseFilter: null,
    movingLayerFilter: null,
    bodyFilter: null,
    shapeFilter: null,
    updateSettings: null,
    characterShape: null,
    character: null,
    characterListener: null,
    terrainBody: null,
    modelBody: null,
    dynamicBodies: [],
    desiredVelocity: new THREE.Vector3(),
    jumpQueued: false,
    allowSliding: false,
};

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

function createGrassTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, '#4f8e34');
    gradient.addColorStop(0.45, '#3e7429');
    gradient.addColorStop(1, '#2f5a1f');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < 1800; i++) {
        const x = Math.random() * canvas.width;
        const y = Math.random() * canvas.height;
        const width = 2 + Math.random() * 5;
        const height = 4 + Math.random() * 10;
        ctx.fillStyle = `hsla(${95 + Math.random() * 35}, ${40 + Math.random() * 30}%, ${28 + Math.random() * 28}%, ${0.08 + Math.random() * 0.18})`;
        ctx.fillRect(x, y, width, height);
    }

    for (let i = 0; i < 650; i++) {
        ctx.beginPath();
        ctx.fillStyle = `hsla(${70 + Math.random() * 24}, ${25 + Math.random() * 35}%, ${42 + Math.random() * 18}%, ${0.08 + Math.random() * 0.16})`;
        ctx.arc(Math.random() * canvas.width, Math.random() * canvas.height, Math.random() * 1.8, 0, Math.PI * 2);
        ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(TERRAIN_TEXTURE_REPEAT, TERRAIN_TEXTURE_REPEAT);
    texture.anisotropy = 8;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
}

function configureTerrainTexture(texture, colorSpace = THREE.NoColorSpace) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(TERRAIN_TEXTURE_REPEAT, TERRAIN_TEXTURE_REPEAT);
    texture.anisotropy = 8;
    texture.colorSpace = colorSpace;
    texture.needsUpdate = true;
    return texture;
}

async function applyTerrainTextures(terrain) {
    if (!terrain?.material) return;

    const loader = new THREE.TextureLoader();
    const basePath = import.meta.env.BASE_URL || '/';
    const material = terrain.material;

    try {
        const [colorMap, normalMap, roughnessMap, aoMap] = await Promise.all([
            loader.loadAsync(`${basePath}${TERRAIN_TEXTURE_PATHS.color}`),
            loader.loadAsync(`${basePath}${TERRAIN_TEXTURE_PATHS.normal}`),
            loader.loadAsync(`${basePath}${TERRAIN_TEXTURE_PATHS.roughness}`),
            loader.loadAsync(`${basePath}${TERRAIN_TEXTURE_PATHS.ao}`),
        ]);

        material.map = configureTerrainTexture(colorMap, THREE.SRGBColorSpace);
        material.normalMap = configureTerrainTexture(normalMap);
        material.roughnessMap = configureTerrainTexture(roughnessMap);
        material.aoMap = configureTerrainTexture(aoMap);
        material.aoMapIntensity = 0.65;
        material.normalScale.set(0.7, 0.7);
        material.needsUpdate = true;
    } catch (error) {
        console.warn('Falling back to procedural terrain texture.', error);
    }
}

function createTerrainMesh() {
    const geometry = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
    const positions = geometry.attributes.position;

    for (let index = 0; index < positions.count; index++) {
        const x = positions.getX(index);
        const y = positions.getY(index);
        const radialFalloff = Math.min(1, Math.hypot(x, y) / (TERRAIN_SIZE * 0.5));
        const basin = -0.22 * Math.pow(radialFalloff, 1.7);
        const rolling = Math.sin(x * 0.16) * 0.28 + Math.cos(y * 0.14) * 0.22;
        const detail = Math.sin((x + y) * 0.45) * 0.08;
        positions.setZ(index, basin + rolling + detail);
    }

    geometry.computeVertexNormals();
    geometry.setAttribute('uv2', new THREE.Float32BufferAttribute(geometry.attributes.uv.array, 2));

    const material = new THREE.MeshStandardMaterial({
        color: 0x8abc63,
        map: createGrassTexture(),
        roughness: 0.97,
        metalness: 0.02,
    });

    const terrain = new THREE.Mesh(geometry, material);
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.y = TERRAIN_Y_OFFSET;
    terrain.receiveShadow = true;
    return terrain;
}

function sampleTerrainHeightAt(worldX, worldZ) {
    if (!worldFloor) return null;

    const terrainScaleX = worldFloor.scale.x || 1;
    const terrainScaleY = worldFloor.scale.y || 1;
    const terrainScaleZ = worldFloor.scale.z || 1;
    const localX = (worldX - worldFloor.position.x) / terrainScaleX;
    const localY = -(worldZ - worldFloor.position.z) / terrainScaleZ;
    const halfExtent = TERRAIN_SIZE * 0.5;

    if (Math.abs(localX) > halfExtent || Math.abs(localY) > halfExtent) {
        return null;
    }

    const radialFalloff = Math.min(1, Math.hypot(localX, localY) / halfExtent);
    const basin = -0.22 * Math.pow(radialFalloff, 1.7);
    const rolling = Math.sin(localX * 0.16) * 0.28 + Math.cos(localY * 0.14) * 0.22;
    const detail = Math.sin((localX + localY) * 0.45) * 0.08;
    const localHeight = basin + rolling + detail;

    return worldFloor.position.y + localHeight * terrainScaleY;
}

function buildLightGrid() {
    lightGridGroup = new THREE.Group();
    lightGridGroup.name = 'light-grid';

    const tileGeometry = new THREE.BoxGeometry(LIGHT_TILE_SIZE, LIGHT_TILE_HEIGHT, LIGHT_TILE_SIZE);
    const totalSpan = (LIGHT_GRID_DIMENSION - 1) * (LIGHT_TILE_SIZE + LIGHT_TILE_GAP);

    for (let row = 0; row < LIGHT_GRID_DIMENSION; row++) {
        for (let col = 0; col < LIGHT_GRID_DIMENSION; col++) {
            const tileMaterial = new THREE.MeshStandardMaterial({
                color: 0x16202c,
                emissive: 0x000000,
                roughness: 0.24,
                metalness: 0.18,
            });
            const tile = new THREE.Mesh(tileGeometry, tileMaterial);
            tile.castShadow = true;
            tile.receiveShadow = true;
            tile.userData.gridIndex = row * LIGHT_GRID_DIMENSION + col;
            tile.userData.gridLit = false;
            tile.userData.baseY = LIGHT_TILE_HEIGHT * 0.5;
            tile.position.set(
                col * (LIGHT_TILE_SIZE + LIGHT_TILE_GAP) - totalSpan * 0.5,
                tile.userData.baseY,
                row * (LIGHT_TILE_SIZE + LIGHT_TILE_GAP) - totalSpan * 0.5
            );
            updateLightTileVisual(tile, false, true);
            lightGridTiles.push(tile);
            lightGridGroup.add(tile);
        }
    }

    positionLightGrid(getLightGridAnchorTarget());
    scene.add(lightGridGroup);
}

function getLightGridAnchorTarget() {
    if (currentMesh) {
        return tempVectorD.copy(gameplayLookTarget);
    }

    return tempVectorD.copy(SHOWCASE_CAMERA_TARGET);
}

function positionLightGrid(anchorTarget) {
    if (!lightGridGroup) return;

    const anchorX = anchorTarget.x + LIGHT_GRID_OFFSET.x;
    const anchorZ = anchorTarget.z + LIGHT_GRID_OFFSET.z;
    const anchorY = getGroundHeightAt(anchorX, anchorZ, true) ?? TERRAIN_Y_OFFSET;

    lightGridGroup.position.set(anchorX, anchorY, anchorZ);
}

function updateLightTileVisual(tile, isLit, immediate = false) {
    const material = tile.material;
    const nextColor = isLit ? 0xf4d35e : 0x16202c;
    const nextEmissive = isLit ? 0xffc247 : 0x000000;
    const nextEmissiveIntensity = isLit ? 1.65 : 0;
    const nextY = tile.userData.baseY + (isLit ? 0.07 : 0);
    const nextScale = isLit ? 1.08 : 1;

    tile.userData.gridLit = isLit;

    if (immediate) {
        material.color.setHex(nextColor);
        material.emissive.setHex(nextEmissive);
        material.emissiveIntensity = nextEmissiveIntensity;
        tile.position.y = nextY;
        tile.scale.setScalar(nextScale);
        return;
    }

    gsap.to(material.color, {
        r: new THREE.Color(nextColor).r,
        g: new THREE.Color(nextColor).g,
        b: new THREE.Color(nextColor).b,
        duration: 0.18,
        overwrite: true,
    });
    gsap.to(material.emissive, {
        r: new THREE.Color(nextEmissive).r,
        g: new THREE.Color(nextEmissive).g,
        b: new THREE.Color(nextEmissive).b,
        duration: 0.18,
        overwrite: true,
    });
    gsap.to(material, {
        emissiveIntensity: nextEmissiveIntensity,
        duration: 0.18,
        overwrite: true,
    });
    gsap.to(tile.position, {
        y: nextY,
        duration: 0.18,
        overwrite: true,
    });
    gsap.to(tile.scale, {
        x: nextScale,
        y: nextScale,
        z: nextScale,
        duration: 0.18,
        overwrite: true,
    });
}

function toggleLightTile(tile) {
    updateLightTileVisual(tile, !tile.userData.gridLit);
}

function handleLightGridClick(event) {
    if (!renderer || !lightGridTiles.length || gameplay.active || gameplay.pointerLocked) return;

    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointerNdc, camera);
    const hit = raycaster.intersectObjects(lightGridTiles, false)[0];
    if (!hit?.object) return;

    toggleLightTile(hit.object);
}

function copyJoltVector(target, source) {
    target.set(source.GetX(), source.GetY(), source.GetZ());
    return target;
}

function copyJoltQuaternion(target, source) {
    target.set(source.GetX(), source.GetY(), source.GetZ(), source.GetW());
    return target;
}

function createOwnedShape(settings) {
    const { Jolt } = physics;
    const shapeResult = settings.Create();

    if (!shapeResult.IsValid()) {
        const error = shapeResult.HasError() ? shapeResult.GetError() : 'Unknown Jolt shape creation error';
        Jolt.destroy(shapeResult);
        Jolt.destroy(settings);
        throw new Error(error);
    }

    const shape = shapeResult.Get();
    shape.AddRef();
    shapeResult.Clear();
    Jolt.destroy(shapeResult);
    Jolt.destroy(settings);
    return shape;
}

function disposeRenderableObject(root) {
    if (!root) return;

    root.traverse((child) => {
        if (!child.isMesh) return;

        child.geometry?.dispose();

        if (Array.isArray(child.material)) {
            child.material.forEach((material) => material?.dispose());
        } else {
            child.material?.dispose();
        }
    });
}

function cloneDisposableObject(root) {
    const clone = root.clone(true);

    clone.traverse((child) => {
        if (!child.isMesh) return;

        child.geometry = child.geometry.clone();
        child.material = Array.isArray(child.material)
            ? child.material.map((material) => material.clone())
            : child.material.clone();
        child.castShadow = true;
        child.receiveShadow = true;
    });

    return clone;
}

function formatImportedPropName(name) {
    const withoutExtension = name.replace(/\.[^.]+$/, '');
    const collapsed = withoutExtension.replace(/[\-_]+/g, ' ').trim();
    return collapsed || 'Imported Prop';
}

function normalizeObjectToDimension(root, targetDimension, centerOnFloor = true) {
    if (!root) return;

    root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(tempVectorA);
    const size = box.getSize(tempVectorB);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const targetScale = targetDimension / maxDim;

    root.scale.setScalar(targetScale);
    root.position.x = -center.x * targetScale;
    root.position.z = -center.z * targetScale;
    root.position.y = centerOnFloor ? -box.min.y * targetScale : -center.y * targetScale;
    root.updateMatrixWorld(true);
}

function createLoadingManager(fileMap = {}) {
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

function convertLoadedObjectMaterials(root) {
    root.traverse((child) => {
        if (!child.isMesh) return;

        child.castShadow = true;
        child.receiveShadow = true;

        if (!child.geometry.attributes.normal) {
            child.geometry.computeVertexNormals();
        }

        const materials = Array.isArray(child.material) ? child.material : [child.material];
        child.material = materials.map((material) => {
            if (!material) return material;

            const hasAlphaMap = !!material.alphaMap;
            const isActuallyTransparent = (material.transparent || false) && ((material.opacity ?? 1.0) < 1.0 || hasAlphaMap);

            if (material.isMeshStandardMaterial || material.isMeshPhysicalMaterial) {
                material.side = THREE.FrontSide;
                material.envMapIntensity = Math.min(material.envMapIntensity ?? 0.6, 0.75);
                material.metalness = Math.min(material.metalness ?? 0.0, 0.25);
                material.roughness = Math.max(material.roughness ?? 0.5, 0.35);
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

function loadObjectFromFile(file, fileMap = {}) {
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

function updatePropImportStatus() {
    if (!propImportDefaultStatus || !resetPropImportDefaultBtn) return;

    if (importedPropState.futureCollisionMode) {
        propImportDefaultStatus.textContent = `Future prop imports use ${IMPORTED_PROP_COLLISION_LABELS[importedPropState.futureCollisionMode]}.`;
        resetPropImportDefaultBtn.hidden = false;
        return;
    }

    propImportDefaultStatus.textContent = 'New prop imports ask for a collision mode.';
    resetPropImportDefaultBtn.hidden = true;
}

function closePropCollisionPrompt() {
    if (!propCollisionPrompt) return;

    propCollisionPrompt.hidden = true;
    if (propCollisionRemember) {
        propCollisionRemember.checked = false;
    }
}

function resolvePropCollisionPrompt(selection) {
    if (!importedPropState.promptResolver) return;

    const resolver = importedPropState.promptResolver;
    importedPropState.promptResolver = null;
    closePropCollisionPrompt();
    resolver(selection);
}

function promptImportedPropCollision(fileName, triangleCount) {
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

function createImportedSimpleShape(root) {
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

function createImportedConvexHullShape(points) {
    const { Jolt } = physics;
    const settings = new Jolt.ConvexHullShapeSettings();
    settings.mPoints = points;
    settings.mMaxConvexRadius = IMPORTED_PROP_COMPLEX_HULL_RADIUS;
    settings.mMaxErrorConvexRadius = IMPORTED_PROP_COMPLEX_HULL_RADIUS;
    return createOwnedShape(settings);
}

function collectImportedComplexHullParts(root) {
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

function createImportedComplexShape(root) {
    const { Jolt } = physics;
    root.updateWorldMatrix(true, true);
    const hullParts = collectImportedComplexHullParts(root);

    if (!hullParts.length) {
        throw new Error('Not enough sampled points for a complex collision shape.');
    }

    const buildHullShape = (part) => {
        const points = new Jolt.ArrayVec3();

        try {
            part.points.forEach((pointData) => {
                const point = new Jolt.Vec3(pointData.x, pointData.y, pointData.z);
                points.push_back(point);
                Jolt.destroy(point);
            });

            if (points.size() < 4) {
                throw new Error('Not enough sampled points for a complex collision shape.');
            }

            return createImportedConvexHullShape(points);
        } finally {
            Jolt.destroy(points);
        }
    };

    if (hullParts.length === 1) {
        return buildHullShape(hullParts[0]);
    }

    const compoundSettings = new Jolt.MutableCompoundShapeSettings();
    const identityPosition = new Jolt.Vec3(0, 0, 0);
    const identityRotation = new Jolt.Quat(0, 0, 0, 1);
    const subShapes = [];
    let compoundSubmitted = false;

    try {
        hullParts.forEach((part) => {
            const subShape = buildHullShape(part);
            subShapes.push(subShape);
            compoundSettings.AddShapeShape(identityPosition, identityRotation, subShape, 0);
        });

        compoundSubmitted = true;
        return createOwnedShape(compoundSettings);
    } catch (error) {
        if (!compoundSubmitted) {
            Jolt.destroy(compoundSettings);
        }
        throw error;
    } finally {
        subShapes.forEach((shape) => shape.Release());
        Jolt.destroy(identityPosition);
        Jolt.destroy(identityRotation);
    }
}

function createImportedCollisionShape(root, mode) {
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

function renderImportedPropButtons() {
    if (!importedPropList || !importedPropLibrary) return;

    importedPropList.innerHTML = '';
    importedPropLibrary.hidden = importedPropState.templates.length === 0;

    importedPropState.templates.forEach((template) => {
        const button = document.createElement('button');
        button.className = 'btn viewer-menu-btn';
        button.textContent = `${template.displayName} · ${template.collisionMode === 'simple' ? 'Simple' : 'Complex'}`;
        button.title = `Spawn ${template.displayName} with ${IMPORTED_PROP_COLLISION_LABELS[template.collisionMode]}.`;
        button.addEventListener('click', () => spawnImportedProp(template.id));
        importedPropList.appendChild(button);
    });
}

function registerImportedPropTemplate(fileName, root, collisionMode, shape, triangleCount) {
    const template = {
        id: `imported-prop-${importedPropState.nextId++}`,
        fileName,
        displayName: formatImportedPropName(fileName),
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

function spawnImportedProp(templateId) {
    if (!physics.ready || !scene || !camera) {
        console.warn('Jolt physics is not ready yet.');
        return;
    }

    const template = importedPropState.templates.find((entry) => entry.id === templateId);
    if (!template?.shape || !template.root) return;

    const spawnPosition = tempVectorD;
    const launchImpulse = tempVectorE;
    getDynamicPropSpawn(spawnPosition, launchImpulse);

    const visual = cloneDisposableObject(template.root);
    template.shape.AddRef();

    const body = createDynamicPrimitiveBody(
        template.shape,
        spawnPosition,
        launchImpulse,
        template.collisionMode === 'simple'
            ? { restitution: 0.12, friction: 0.84 }
            : { restitution: 0.08, friction: 0.76 }
    );

    if (!body) {
        disposeRenderableObject(visual);
        return;
    }

    visual.position.copy(spawnPosition);
    scene.add(visual);
    physics.dynamicBodies.push(syncPropScriptState({
        body,
        mesh: visual,
        kind: 'imported',
        templateId,
    }));
}

async function importPhysicsProp(file, fileMap = {}) {
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
        registerImportedPropTemplate(file.name, root, collision.mode, collision.shape, triangleCount);
        updatePropImportStatus();
    } catch (error) {
        console.error('Failed to import physics prop.', error);
        alert(error?.message === 'Unsupported file format'
            ? 'Unsupported file format for physics prop import.'
            : 'Failed to import the selected prop. Check the console for details.');
    }
}

async function initPhysics() {
    try {
        const Jolt = await initJolt();
        const objectLayerPairFilter = new Jolt.ObjectLayerPairFilterTable(JOLT_OBJECT_LAYER_COUNT);
        objectLayerPairFilter.EnableCollision(JOLT_NON_MOVING_LAYER, JOLT_MOVING_LAYER);
        objectLayerPairFilter.EnableCollision(JOLT_MOVING_LAYER, JOLT_MOVING_LAYER);

        const nonMovingBroadPhaseLayer = new Jolt.BroadPhaseLayer(0);
        const movingBroadPhaseLayer = new Jolt.BroadPhaseLayer(1);
        const broadPhaseInterface = new Jolt.BroadPhaseLayerInterfaceTable(
            JOLT_OBJECT_LAYER_COUNT,
            JOLT_BROAD_PHASE_LAYER_COUNT
        );
        broadPhaseInterface.MapObjectToBroadPhaseLayer(JOLT_NON_MOVING_LAYER, nonMovingBroadPhaseLayer);
        broadPhaseInterface.MapObjectToBroadPhaseLayer(JOLT_MOVING_LAYER, movingBroadPhaseLayer);
        Jolt.destroy(nonMovingBroadPhaseLayer);
        Jolt.destroy(movingBroadPhaseLayer);

        const objectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(
            broadPhaseInterface,
            JOLT_BROAD_PHASE_LAYER_COUNT,
            objectLayerPairFilter,
            JOLT_OBJECT_LAYER_COUNT
        );

        const settings = new Jolt.JoltSettings();
        settings.mMaxWorkerThreads = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));
        settings.mObjectLayerPairFilter = objectLayerPairFilter;
        settings.mBroadPhaseLayerInterface = broadPhaseInterface;
        settings.mObjectVsBroadPhaseLayerFilter = objectVsBroadPhaseLayerFilter;

        const jolt = new Jolt.JoltInterface(settings);
        Jolt.destroy(settings);

        const physicsSystem = jolt.GetPhysicsSystem();
        const bodyInterface = physicsSystem.GetBodyInterface();
        const gravity = new Jolt.Vec3(0, -PLAYER_SETTINGS.gravity, 0);
        physicsSystem.SetGravity(gravity);

        physics.Jolt = Jolt;
        physics.jolt = jolt;
        physics.physicsSystem = physicsSystem;
        physics.bodyInterface = bodyInterface;
        physics.gravity = gravity;
        physics.movingBroadPhaseFilter = new Jolt.DefaultBroadPhaseLayerFilter(
            jolt.GetObjectVsBroadPhaseLayerFilter(),
            JOLT_MOVING_LAYER
        );
        physics.movingLayerFilter = new Jolt.DefaultObjectLayerFilter(
            jolt.GetObjectLayerPairFilter(),
            JOLT_MOVING_LAYER
        );
        physics.bodyFilter = new Jolt.BodyFilter();
        physics.shapeFilter = new Jolt.ShapeFilter();
        physics.updateSettings = new Jolt.ExtendedUpdateSettings();
        physics.updateSettings.mStickToFloorStepDown = new Jolt.Vec3(0, -0.6, 0);
        physics.updateSettings.mWalkStairsStepUp = new Jolt.Vec3(0, 0.45, 0);
        physics.updateSettings.mWalkStairsMinStepForward = 0.02;
        physics.updateSettings.mWalkStairsStepForwardTest = 0.2;
        physics.updateSettings.mWalkStairsCosAngleForwardContact = Math.cos(THREE.MathUtils.degToRad(65));
        physics.updateSettings.mWalkStairsStepDownExtra = new Jolt.Vec3(0, -0.2, 0);
        physics.ready = true;

        rebuildTerrainPhysicsBody();
        if (currentMesh) {
            rebuildModelPhysicsBody();
            ensurePlayerCharacter();
        }
    } catch (error) {
        physics.failed = true;
        console.error('Failed to initialize Jolt physics.', error);
    }
}

function countTrianglesForObject(root) {
    let totalTriangles = 0;

    root?.traverse((child) => {
        if (!child.isMesh || !child.geometry?.attributes?.position) return;

        const index = child.geometry.getIndex();
        totalTriangles += index ? index.count / 3 : child.geometry.attributes.position.count / 3;
    });

    return totalTriangles;
}

function createStaticMeshBody(root) {
    if (!physics.ready || !root) return null;

    const { Jolt, bodyInterface } = physics;
    root.updateWorldMatrix(true, true);

    const totalTriangles = countTrianglesForObject(root);
    if (!totalTriangles) return null;

    const triangles = new Jolt.TriangleList();
    triangles.resize(totalTriangles);
    let triangleIndex = 0;

    root.traverse((child) => {
        if (!child.isMesh || !child.geometry?.attributes?.position) return;

        const position = child.geometry.getAttribute('position');
        const index = child.geometry.getIndex();
        const triangleCount = index ? index.count / 3 : position.count / 3;

        for (let i = 0; i < triangleCount; i++) {
            const i0 = index ? index.getX(i * 3) : i * 3;
            const i1 = index ? index.getX(i * 3 + 1) : i * 3 + 1;
            const i2 = index ? index.getX(i * 3 + 2) : i * 3 + 2;

            tempVectorA.fromBufferAttribute(position, i0).applyMatrix4(child.matrixWorld);
            tempVectorB.fromBufferAttribute(position, i1).applyMatrix4(child.matrixWorld);
            tempVectorC.fromBufferAttribute(position, i2).applyMatrix4(child.matrixWorld);

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

    const materials = new Jolt.PhysicsMaterialList();
    const shape = createOwnedShape(new Jolt.MeshShapeSettings(triangles, materials));
    const bodyPosition = new Jolt.RVec3(0, 0, 0);
    const bodyRotation = new Jolt.Quat(0, 0, 0, 1);
    const creationSettings = new Jolt.BodyCreationSettings(
        shape,
        bodyPosition,
        bodyRotation,
        Jolt.EMotionType_Static,
        JOLT_NON_MOVING_LAYER
    );
    creationSettings.mFriction = 0.9;
    const body = bodyInterface.CreateBody(creationSettings);
    bodyInterface.AddBody(body.GetID(), Jolt.EActivation_DontActivate);

    shape.Release();
    Jolt.destroy(creationSettings);
    Jolt.destroy(bodyPosition);
    Jolt.destroy(bodyRotation);
    Jolt.destroy(triangles);
    Jolt.destroy(materials);

    return body;
}

function destroyPhysicsBody(body) {
    if (!physics.ready || !body) return;

    const { bodyInterface } = physics;
    const bodyId = body.GetID();
    bodyInterface.RemoveBody(bodyId);
    bodyInterface.DestroyBody(bodyId);
}

function destroyDynamicPhysicsProp(prop) {
    if (!prop) return;

    if (objectScriptState.targetPropId && objectScriptState.targetPropId === prop.id) {
        objectScriptState.targetPropId = '';
        objectScriptState.menuOpen = false;
        objectScriptState.editorOpen = false;
    }

    if (prop.mesh) {
        scene?.remove(prop.mesh);
        disposeRenderableObject(prop.mesh);

        prop.mesh = null;
    }

    if (prop.body) {
        destroyPhysicsBody(prop.body);
        prop.body = null;
    }

    removeObjectScriptDraft(prop.id);
}

function clearDynamicPhysicsProps() {
    if (!physics.dynamicBodies.length) return;

    physics.dynamicBodies.forEach((prop) => destroyDynamicPhysicsProp(prop));
    physics.dynamicBodies.length = 0;
}

function hasEnabledDynamicPropEvent(eventType) {
    for (let index = 0; index < physics.dynamicBodies.length; index++) {
        const eventState = physics.dynamicBodies[index]?.scripts?.[eventType];
        if (eventState?.enabled) {
            return true;
        }
    }

    return false;
}

function getDynamicPropSpawn(positionTarget, impulseTarget) {
    const spawnOrigin = gameplay.active && physics.character
        ? copyJoltVector(tempVectorC, physics.character.GetPosition()).addScaledVector(upVector, PLAYER_SETTINGS.eyeHeight * 0.55)
        : tempVectorC.copy(camera.position);

    camera.getWorldDirection(tempVectorA);
    if (Math.abs(tempVectorA.y) > 0.72) {
        tempVectorA.y *= 0.35;
    }

    if (tempVectorA.lengthSq() < 1e-6) {
        tempVectorA.set(0, 0, -1);
    } else {
        tempVectorA.normalize();
    }

    positionTarget
        .copy(spawnOrigin)
        .addScaledVector(tempVectorA, gameplay.active ? 2.5 : 4.2)
        .addScaledVector(upVector, gameplay.active ? 1.5 : 2.2);

    impulseTarget
        .copy(tempVectorA)
        .multiplyScalar(18)
        .addScaledVector(upVector, 5.5);
}

function createDynamicPrimitiveBody(shape, position, impulse, options = {}) {
    if (!physics.ready) return null;

    const { Jolt, bodyInterface } = physics;
    const bodyPosition = new Jolt.RVec3(position.x, position.y, position.z);
    const bodyRotation = new Jolt.Quat(0, 0, 0, 1);
    const creationSettings = new Jolt.BodyCreationSettings(
        shape,
        bodyPosition,
        bodyRotation,
        Jolt.EMotionType_Dynamic,
        JOLT_MOVING_LAYER
    );
    creationSettings.mFriction = options.friction ?? 0.68;
    creationSettings.mRestitution = options.restitution ?? 0.16;
    creationSettings.mAllowSleeping = options.allowSleeping ?? true;
    creationSettings.mLinearDamping = options.linearDamping ?? 0.08;
    creationSettings.mAngularDamping = options.angularDamping ?? 0.1;
    creationSettings.mMotionQuality = options.motionQuality
        ?? Jolt.EMotionQuality_Discrete;

    const body = bodyInterface.CreateBody(creationSettings);
    bodyInterface.AddBody(
        body.GetID(),
        options.activate === false ? Jolt.EActivation_DontActivate : Jolt.EActivation_Activate
    );

    if (impulse && options.skipImpulse !== true) {
        const launchImpulse = new Jolt.Vec3(impulse.x, impulse.y, impulse.z);
        bodyInterface.AddImpulse(body.GetID(), launchImpulse);
        Jolt.destroy(launchImpulse);
    }

    shape.Release();
    Jolt.destroy(creationSettings);
    Jolt.destroy(bodyPosition);
    Jolt.destroy(bodyRotation);

    return body;
}

function spawnDynamicPrimitive(kind, offset, scale, options = {}) {
    if (!physics.ready || !scene || !camera) {
        console.warn('Jolt physics is not ready yet.');
        return;
    }

    const defaultScale = kind === 'sphere' ? 0.5 : 0.3;
    const normalizedScale = Number.isFinite(scale) && scale > 0 ? scale : defaultScale;

    const { Jolt } = physics;
    const spawnPosition = tempVectorD;
    const launchImpulse = tempVectorE;
    getDynamicPropSpawn(spawnPosition, launchImpulse);
    const impulseScale = Number.isFinite(options.impulseScale) ? options.impulseScale : 1;

    if (offset) {
        spawnPosition.add(offset);
    }

    if (options.skipImpulse === true) {
        launchImpulse.set(0, 0, 0);
    } else if (impulseScale !== 1) {
        launchImpulse.multiplyScalar(impulseScale);
    }

    let mesh;
    let shape;
    let bodyOptions;

    if (kind === 'sphere') {
        const radius = normalizedScale;
        shape = createOwnedShape(new Jolt.SphereShapeSettings(radius));
        mesh = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 28, 20),
            new THREE.MeshStandardMaterial({
                color: 0xf97316,
                metalness: 0.14,
                roughness: 0.34,
                emissive: 0x331100,
                emissiveIntensity: 0.28,
            })
        );
        bodyOptions = {
            restitution: 0.48,
            friction: 0.58,
            ...options,
        };
    } else {
        const halfExtent = normalizedScale;
        const halfExtentVector = new Jolt.Vec3(halfExtent, halfExtent, halfExtent);
        shape = createOwnedShape(new Jolt.BoxShapeSettings(halfExtentVector, 0.05));
        Jolt.destroy(halfExtentVector);
        mesh = new THREE.Mesh(
            new THREE.BoxGeometry(halfExtent * 2, halfExtent * 2, halfExtent * 2),
            new THREE.MeshStandardMaterial({
                color: 0x60a5fa,
                metalness: 0.12,
                roughness: 0.38,
                emissive: 0x0b1220,
                emissiveIntensity: 0.2,
            })
        );
        bodyOptions = {
            restitution: 0.12,
            friction: 0.82,
            ...options,
        };
    }

    const body = createDynamicPrimitiveBody(shape, spawnPosition, launchImpulse, bodyOptions);

    if (!body) {
        mesh.geometry.dispose();
        mesh.material.dispose();
        return;
    }

    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? true;
    mesh.position.copy(spawnPosition);
    scene.add(mesh);

    physics.dynamicBodies.push(syncPropScriptState({ body, mesh, kind }));

    return body;
}

function syncDynamicPhysicsBodies() {
    if (!physics.dynamicBodies.length) return;

    for (let index = physics.dynamicBodies.length - 1; index >= 0; index--) {
        const prop = physics.dynamicBodies[index];
        if (!prop?.body || !prop.mesh) continue;

        copyJoltVector(prop.mesh.position, prop.body.GetPosition());
        copyJoltQuaternion(prop.mesh.quaternion, prop.body.GetRotation());

        if (prop.mesh.position.y < worldFloor.position.y - 40) {
            destroyDynamicPhysicsProp(prop);
            physics.dynamicBodies.splice(index, 1);
        }
    }
}

function rebuildTerrainPhysicsBody() {
    if (!physics.ready || !worldFloor) return;

    if (physics.terrainBody) {
        destroyPhysicsBody(physics.terrainBody);
        physics.terrainBody = null;
    }

    physics.terrainBody = createStaticMeshBody(worldFloor);
}

function rebuildModelPhysicsBody() {
    if (!physics.ready) return;

    if (physics.modelBody) {
        destroyPhysicsBody(physics.modelBody);
        physics.modelBody = null;
    }

    if (!currentMesh) return;
    physics.modelBody = createStaticMeshBody(currentMesh);
}

function destroyPlayerCharacter() {
    if (!physics.character) return;

    physics.Jolt.destroy(physics.character);
    physics.character = null;

    if (physics.characterListener) {
        physics.Jolt.destroy(physics.characterListener);
        physics.characterListener = null;
    }

    if (physics.characterShape) {
        physics.characterShape.Release();
        physics.characterShape = null;
    }
}

function syncGameplaySpawnToCamera() {
    if (!camera) return;

    gameplay.spawnPoint.set(
        camera.position.x,
        camera.position.y - PLAYER_SETTINGS.eyeHeight,
        camera.position.z
    );

    tempVectorA.setFromEuler(camera.rotation.reorder('YXZ'));
    gameplay.spawnYaw = tempVectorA.y;
    gameplay.spawnPitch = THREE.MathUtils.clamp(
        tempVectorA.x,
        -PLAYER_SETTINGS.maxLookPitch,
        PLAYER_SETTINGS.maxLookPitch
    );
}

function syncShowcaseAnglesFromTarget(target) {
    tempVectorA.copy(target).sub(camera.position);
    const flatDistance = Math.max(0.001, Math.hypot(tempVectorA.x, tempVectorA.z));
    showcase.yaw = Math.atan2(tempVectorA.x, tempVectorA.z);
    showcase.pitch = THREE.MathUtils.clamp(
        Math.atan2(-tempVectorA.y, flatDistance),
        -PLAYER_SETTINGS.maxLookPitch,
        PLAYER_SETTINGS.maxLookPitch
    );
}

function applyShowcaseCameraRotation() {
    camera.rotation.order = 'YXZ';
    camera.rotation.x = showcase.pitch;
    camera.rotation.y = showcase.yaw;
    camera.rotation.z = 0;
}

function ensurePlayerCharacter() {
    if (!physics.ready) return;

    destroyPlayerCharacter();

    const { Jolt, physicsSystem } = physics;
    const characterRadius = Math.max(0.3, PLAYER_SETTINGS.collisionRadius * 0.55);
    const characterHeight = Math.max(0.6, PLAYER_SETTINGS.eyeHeight - characterRadius * 1.2);
    const shapeOffset = new Jolt.Vec3(0, 0.5 * characterHeight + characterRadius, 0);
    const shapeRotation = Jolt.Quat.prototype.sIdentity();
    const shapeSettings = new Jolt.RotatedTranslatedShapeSettings(
        shapeOffset,
        shapeRotation,
        new Jolt.CapsuleShapeSettings(0.5 * characterHeight, characterRadius)
    );
    physics.characterShape = createOwnedShape(shapeSettings);
    Jolt.destroy(shapeOffset);

    const characterSettings = new Jolt.CharacterVirtualSettings();
    characterSettings.mMass = 80;
    characterSettings.mMaxStrength = 100;
    characterSettings.mShape = physics.characterShape;
    characterSettings.mBackFaceMode = Jolt.EBackFaceMode_CollideWithBackFaces;
    characterSettings.mPredictiveContactDistance = 0.1;
    characterSettings.mCharacterPadding = 0.02;
    characterSettings.mPenetrationRecoverySpeed = 1.0;

    const spawnPosition = new Jolt.RVec3(
        gameplay.spawnPoint.x,
        gameplay.spawnPoint.y,
        gameplay.spawnPoint.z
    );
    physics.character = new Jolt.CharacterVirtual(
        characterSettings,
        spawnPosition,
        shapeRotation,
        physicsSystem
    );
    Jolt.destroy(characterSettings);
    Jolt.destroy(spawnPosition);

    physics.characterListener = new Jolt.CharacterContactListenerJS();
    physics.characterListener.OnAdjustBodyVelocity = () => {};
    physics.characterListener.OnContactValidate = () => true;
    physics.characterListener.OnCharacterContactValidate = () => true;
    physics.characterListener.OnContactAdded = () => {};
    physics.characterListener.OnContactPersisted = () => {};
    physics.characterListener.OnContactRemoved = () => {};
    physics.characterListener.OnCharacterContactAdded = () => {};
    physics.characterListener.OnCharacterContactPersisted = () => {};
    physics.characterListener.OnCharacterContactRemoved = () => {};
    physics.characterListener.OnCharacterContactSolve = () => {};
    physics.characterListener.OnContactSolve = (_character, _bodyID2, _subShapeID2, _contactPosition, contactNormal, contactVelocity, _contactMaterial, _characterVelocity, newCharacterVelocity) => {
        const normal = Jolt.wrapPointer(contactNormal, Jolt.Vec3);
        const velocity = Jolt.wrapPointer(contactVelocity, Jolt.Vec3);
        const nextVelocity = Jolt.wrapPointer(newCharacterVelocity, Jolt.Vec3);

        if (!physics.allowSliding && velocity.IsNearZero() && !physics.character.IsSlopeTooSteep(normal)) {
            nextVelocity.SetX(0);
            nextVelocity.SetY(0);
            nextVelocity.SetZ(0);
        }
    };
    physics.character.SetListener(physics.characterListener);
}

function syncCameraToCharacter() {
    if (!physics.character) return;

    const position = copyJoltVector(tempVectorA, physics.character.GetPosition());
    camera.position.set(position.x, position.y + PLAYER_SETTINGS.eyeHeight, position.z);
}

function stepPhysics(delta) {
    if (!physics.ready || !physics.jolt) {
        return {
            total: 0,
            step: 0,
            sync: 0,
            collisions: 0,
        };
    }

    const collisionSteps = delta > 1 / 55 ? 2 : 1;
    debugConsoleState.latest.collisionSteps = collisionSteps;

    const stepStart = performance.now();
    physics.jolt.Step(delta, collisionSteps);
    const stepDuration = performance.now() - stepStart;

    const syncStart = performance.now();
    syncDynamicPhysicsBodies();
    const syncDuration = performance.now() - syncStart;

    const collisionsStart = performance.now();
    updateDynamicBodyCollisionScripts();
    const collisionsDuration = performance.now() - collisionsStart;

    return {
        total: stepDuration + syncDuration + collisionsDuration,
        step: stepDuration,
        sync: syncDuration,
        collisions: collisionsDuration,
    };
}

function createDefaultObjectEventState(eventName) {
    return {
        source: '',
        compiled: null,
        error: '',
        enabled: false,
        running: false,
        eventName,
    };
}

function createObjectScriptState(propId = '') {
    return {
        propId,
        tick: createDefaultObjectEventState('tick'),
        collision: createDefaultObjectEventState('collision'),
        activeCollisions: new Set(),
    };
}

function sanitizeObjectScriptDrafts(rawValue) {
    if (!rawValue || typeof rawValue !== 'object') {
        return {};
    }

    const drafts = {};

    Object.entries(rawValue).forEach(([propId, value]) => {
        if (!value || typeof value !== 'object') return;

        drafts[propId] = {
            tick: typeof value.tick === 'string' ? value.tick : '',
            tickEnabled: value.tickEnabled === true,
            collision: typeof value.collision === 'string' ? value.collision : '',
        };
    });

    return drafts;
}

function readObjectScriptDrafts() {
    try {
        const rawValue = window.localStorage.getItem(OBJECT_SCRIPT_STORAGE_KEY);
        if (!rawValue) return {};

        return sanitizeObjectScriptDrafts(JSON.parse(rawValue));
    } catch (error) {
        console.warn('Failed to load object script drafts.', error);
        return {};
    }
}

function saveObjectScriptDrafts() {
    try {
        window.localStorage.setItem(OBJECT_SCRIPT_STORAGE_KEY, JSON.stringify(objectScriptState.drafts));
    } catch (error) {
        console.warn('Failed to save object script drafts.', error);
    }
}

function ensureObjectScriptDraftEntry(propId) {
    if (!propId) {
        return { tick: '', tickEnabled: false, collision: '' };
    }

    if (!objectScriptState.drafts[propId]) {
        objectScriptState.drafts[propId] = {
            tick: '',
            tickEnabled: false,
            collision: '',
        };
    }

    return objectScriptState.drafts[propId];
}

function createRuntimePropId() {
    const propId = `prop-${objectScriptState.nextPropId++}`;
    ensureObjectScriptDraftEntry(propId);
    return propId;
}

function compileObjectEventScript(source) {
    const normalizedSource = typeof source === 'string' ? source.trim() : '';

    if (!normalizedSource) {
        return new ObjectEventFunction('api', '"use strict"; return;');
    }

    return new ObjectEventFunction('api', `
        "use strict";
        const { THREE, scene, camera, renderer, currentMesh, gameplay, showcase, physics, prop, object, body, eventType, deltaTime, collision, spawnDynamicPrimitive, spawnImportedProp } = api;
        ${normalizedSource}
    `);
}

function syncPropScriptState(prop) {
    if (!prop) return prop;

    const propId = prop.id || createRuntimePropId();
    prop.id = propId;
    const drafts = ensureObjectScriptDraftEntry(propId);
    const scriptState = createObjectScriptState(propId);

    scriptState.tick.source = drafts.tick;
    scriptState.collision.source = drafts.collision;

    try {
        scriptState.tick.compiled = compileObjectEventScript(scriptState.tick.source);
        scriptState.tick.enabled = !!scriptState.tick.source.trim() && drafts.tickEnabled === true;
    } catch (error) {
        scriptState.tick.error = error?.message || String(error);
        scriptState.tick.compiled = null;
        scriptState.tick.enabled = false;
    }

    try {
        scriptState.collision.compiled = compileObjectEventScript(scriptState.collision.source);
        scriptState.collision.enabled = !!scriptState.collision.source.trim();
    } catch (error) {
        scriptState.collision.error = error?.message || String(error);
        scriptState.collision.compiled = null;
        scriptState.collision.enabled = false;
    }

    prop.scripts = scriptState;

    if (prop.mesh?.userData) {
        prop.mesh.userData.dynamicPropId = propId;
    }

    return prop;
}

function removeObjectScriptDraft(propId) {
    if (!propId || !objectScriptState.drafts[propId]) return;

    delete objectScriptState.drafts[propId];
    saveObjectScriptDrafts();
}

function findDynamicPropByMesh(target) {
    if (!target) return null;

    return physics.dynamicBodies.find((prop) => {
        let current = target;

        while (current) {
            if (current === prop.mesh) {
                return true;
            }

            current = current.parent;
        }

        return false;
    }) || null;
}

function getObjectScriptEventLabel(eventType) {
    return eventType === 'collision' ? 'Collision' : 'Tick';
}

function getDynamicPropDisplayName(prop) {
    if (!prop) return 'No prop selected';

    if (prop.kind === 'imported') {
        const template = importedPropState.templates.find((entry) => entry.id === prop.templateId);
        return template?.displayName || 'Imported Prop';
    }

    return prop.kind === 'sphere' ? 'Sphere Prop' : 'Cube Prop';
}

function getDynamicPropById(propId) {
    return physics.dynamicBodies.find((prop) => prop.id === propId) || null;
}

function getDynamicPropHitFromEvent(event) {
    if (!renderer || !camera || !physics.dynamicBodies.length) return null;

    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);

    const targets = physics.dynamicBodies
        .map((prop) => prop.mesh)
        .filter(Boolean);

    const hits = raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
        const prop = findDynamicPropByMesh(hit.object);
        if (prop) {
            return { prop, hit };
        }
    }

    return null;
}

function updateObjectScriptEditorStatus(extraMessage = '') {
    if (!objectScriptEditorStatus) return;

    const prop = getDynamicPropById(objectScriptState.targetPropId);
    const eventType = objectScriptState.targetEvent;
    const eventState = prop?.scripts?.[eventType];
    let baseMessage;

    if (eventState?.error) {
        baseMessage = `${getObjectScriptEventLabel(eventType)} code error: ${eventState.error}`;
    } else if (eventType === 'tick' && eventState?.source?.trim() && !eventState.enabled) {
        baseMessage = 'Tick code is saved but disabled. Turn on the tick toggle to run it in Play mode.';
    } else {
        baseMessage = `${getObjectScriptEventLabel(eventType)} code is ${eventState?.enabled ? 'ready' : 'empty'}.`;
    }

    objectScriptEditorStatus.textContent = extraMessage ? `${baseMessage} ${extraMessage}` : baseMessage;
}

function syncObjectScriptEditor() {
    const prop = getDynamicPropById(objectScriptState.targetPropId);
    const eventType = objectScriptState.targetEvent;
    const eventState = prop?.scripts?.[eventType];

    if (objectScriptEditorTitle) {
        objectScriptEditorTitle.textContent = `Attach ${getObjectScriptEventLabel(eventType)} Script`;
    }

    if (objectScriptEditorTarget) {
        objectScriptEditorTarget.textContent = `Target: ${getDynamicPropDisplayName(prop)}`;
    }

    if (objectScriptEditorMode) {
        objectScriptEditorMode.textContent = `Event: ${getObjectScriptEventLabel(eventType)}`;
    }

    if (objectScriptTickToggleRow) {
        objectScriptTickToggleRow.hidden = eventType !== 'tick';
    }

    if (objectScriptTickToggleInput) {
        objectScriptTickToggleInput.checked = eventType === 'tick' ? !!eventState?.enabled : false;
    }

    if (objectScriptEditorInput) {
        objectScriptEditorInput.value = eventState?.source || '';
    }

    updateObjectScriptEditorStatus();
}

function closeObjectScriptMenu() {
    objectScriptState.menuOpen = false;

    if (objectScriptMenu) {
        objectScriptMenu.hidden = true;
    }
}

function closeObjectScriptEditor() {
    objectScriptState.editorOpen = false;

    if (objectScriptEditor) {
        objectScriptEditor.hidden = true;
    }
}

function maybeOpenObjectScriptMenuFromMobileTap(event) {
    if (!mobileState.enabled || gameplay.active || gameplay.pointerLocked || !renderer) {
        return false;
    }

    const now = performance.now();
    const withinTimeWindow = now - mobileState.lastWorldTapTime <= 320;
    const withinDistanceWindow = Math.hypot(
        event.clientX - mobileState.lastWorldTapX,
        event.clientY - mobileState.lastWorldTapY
    ) <= 28;

    mobileState.lastWorldTapTime = now;
    mobileState.lastWorldTapX = event.clientX;
    mobileState.lastWorldTapY = event.clientY;

    if (!withinTimeWindow || !withinDistanceWindow) {
        return false;
    }

    const propHit = getDynamicPropHitFromEvent(event);
    if (!propHit?.prop) {
        return false;
    }

    openObjectScriptMenu(event, propHit.prop);
    return true;
}

function openObjectScriptMenu(event, prop) {
    if (!objectScriptMenu || !container || !prop) return;

    objectScriptState.targetPropId = prop.id;
    objectScriptState.menuOpen = true;
    objectScriptState.menuScreenX = event.clientX;
    objectScriptState.menuScreenY = event.clientY;

    objectScriptMenu.hidden = false;

    const containerRect = container.getBoundingClientRect();
    const menuWidth = objectScriptMenu.offsetWidth || 220;
    const menuHeight = objectScriptMenu.offsetHeight || 120;
    const left = THREE.MathUtils.clamp(
        event.clientX - containerRect.left,
        12,
        Math.max(12, containerRect.width - menuWidth - 12)
    );
    const top = THREE.MathUtils.clamp(
        event.clientY - containerRect.top,
        12,
        Math.max(12, containerRect.height - menuHeight - 12)
    );

    objectScriptMenu.style.left = `${left}px`;
    objectScriptMenu.style.top = `${top}px`;
}

function openObjectScriptEditor(eventType) {
    const prop = getDynamicPropById(objectScriptState.targetPropId);
    if (!prop || !objectScriptEditor) return;

    objectScriptState.targetEvent = eventType;
    objectScriptState.editorOpen = true;
    closeObjectScriptMenu();
    syncObjectScriptEditor();
    objectScriptEditor.hidden = false;

    if (objectScriptEditorInput) {
        objectScriptEditorInput.focus();
        objectScriptEditorInput.setSelectionRange(
            objectScriptEditorInput.value.length,
            objectScriptEditorInput.value.length
        );
    }
}

function updatePropScriptSource(prop, eventType, source, { persist = true, notify = true } = {}) {
    if (!prop?.scripts?.[eventType]) return false;

    const normalizedSource = typeof source === 'string' ? source : '';
    const eventState = prop.scripts[eventType];
    eventState.source = normalizedSource;
    eventState.error = '';

    try {
        eventState.compiled = compileObjectEventScript(normalizedSource);
        eventState.enabled = eventType === 'tick'
            ? !!normalizedSource.trim() && !!prop.scripts.tick.enabled
            : !!normalizedSource.trim();
    } catch (error) {
        eventState.error = error?.message || String(error);
        eventState.compiled = null;
        eventState.enabled = false;
        if (notify) {
            alert(`error: ${eventState.error}`);
        }
    }

    const drafts = ensureObjectScriptDraftEntry(prop.id);
    drafts[eventType] = normalizedSource;
    if (eventType === 'tick') {
        drafts.tickEnabled = !!prop.scripts.tick.enabled;
    }

    if (persist) {
        saveObjectScriptDrafts();
    }

    updateObjectScriptEditorStatus(
        eventState.error
            ? `${getObjectScriptEventLabel(eventType)} code failed to compile.`
            : `${getObjectScriptEventLabel(eventType)} code applied.`
    );

    return !eventState.error;
}

function clearPropScriptSource(prop, eventType) {
    return updatePropScriptSource(prop, eventType, '', { persist: true, notify: false });
}

function setPropTickEventEnabled(prop, isEnabled, { persist = true } = {}) {
    if (!prop?.scripts?.tick) return;

    const tickState = prop.scripts.tick;
    tickState.enabled = !!isEnabled && !!tickState.source.trim() && !tickState.error;

    const drafts = ensureObjectScriptDraftEntry(prop.id);
    drafts.tickEnabled = !!isEnabled;

    if (persist) {
        saveObjectScriptDrafts();
    }

    updateObjectScriptEditorStatus(
        tickState.enabled
            ? 'Tick event enabled for Play mode.'
            : 'Tick event disabled.'
    );
}

function buildObjectEventApi(prop, eventType, { deltaTime = 0, collision = null } = {}) {
    return {
        THREE,
        scene,
        camera,
        renderer,
        currentMesh,
        gameplay,
        showcase,
        physics,
        prop,
        object: prop?.mesh || null,
        body: prop?.body || null,
        eventType,
        deltaTime,
        collision,
        spawnDynamicPrimitive,
        spawnImportedProp,
    };
}

function handleObjectScriptRuntimeError(prop, eventType, error) {
    const eventState = prop?.scripts?.[eventType];
    if (!eventState) return;

    const errorMessage = error?.message || String(error);
    eventState.error = errorMessage;
    eventState.enabled = false;
    eventState.running = false;
    alert(`error: ${errorMessage}`);

    if (objectScriptState.targetPropId === prop.id && objectScriptState.targetEvent === eventType) {
        updateObjectScriptEditorStatus(`${getObjectScriptEventLabel(eventType)} code failed at runtime.`);
    }
}

function runObjectEventScript(prop, eventType, options = {}) {
    const eventState = prop?.scripts?.[eventType];
    if (!eventState?.enabled || !eventState.compiled || eventState.running) {
        return false;
    }

    eventState.running = true;
    Promise.resolve(eventState.compiled(buildObjectEventApi(prop, eventType, options)))
        .then(() => {
            eventState.running = false;
            if (objectScriptState.targetPropId === prop.id && objectScriptState.targetEvent === eventType) {
                updateObjectScriptEditorStatus(`${getObjectScriptEventLabel(eventType)} code ran.`);
            }
        })
        .catch((error) => {
            handleObjectScriptRuntimeError(prop, eventType, error);
        });

    return true;
}

function runObjectTickScripts(delta) {
    if (!gameplay.active || !hasEnabledDynamicPropEvent('tick')) {
        return;
    }

    for (let index = 0; index < physics.dynamicBodies.length; index++) {
        const prop = physics.dynamicBodies[index];
        if (!prop?.mesh || !prop.body) continue;
        runObjectEventScript(prop, 'tick', { deltaTime: delta });
    }
}

function registerCollisionForProp(contactMap, prop, collisionKey, collision) {
    if (!prop?.scripts?.collision?.enabled) return;

    let propContacts = contactMap.get(prop.id);
    if (!propContacts) {
        propContacts = new Map();
        contactMap.set(prop.id, propContacts);
    }

    propContacts.set(collisionKey, collision);
}

function updateDynamicBodyCollisionScripts() {
    if (!physics.dynamicBodies.length || !hasEnabledDynamicPropEvent('collision')) return;

    const entries = physics.dynamicBodies
        .filter((prop) => prop?.mesh && prop.body)
        .map((prop) => ({
            prop,
            bounds: new THREE.Box3().setFromObject(prop.mesh),
        }));

    const contactMap = new Map();

    for (let index = 0; index < entries.length; index++) {
        const current = entries[index];
        const groundHeight = getGroundHeightAt(current.prop.mesh.position.x, current.prop.mesh.position.z, true);

        if (groundHeight !== null && current.bounds.min.y <= groundHeight + 0.08) {
            registerCollisionForProp(contactMap, current.prop, `ground:${current.prop.id}`, {
                type: 'ground',
                groundHeight,
                point: current.prop.mesh.position.clone(),
            });
        }

        for (let otherIndex = index + 1; otherIndex < entries.length; otherIndex++) {
            const other = entries[otherIndex];
            if (!current.bounds.intersectsBox(other.bounds)) continue;

            const collisionKey = [current.prop.id, other.prop.id].sort().join(':');
            registerCollisionForProp(contactMap, current.prop, collisionKey, {
                type: 'prop',
                otherProp: other.prop,
                otherObject: other.prop.mesh,
                otherBody: other.prop.body,
            });
            registerCollisionForProp(contactMap, other.prop, collisionKey, {
                type: 'prop',
                otherProp: current.prop,
                otherObject: current.prop.mesh,
                otherBody: current.prop.body,
            });
        }
    }

    physics.dynamicBodies.forEach((prop) => {
        const eventState = prop?.scripts?.collision;
        if (!eventState?.enabled) return;

        const activeCollisions = prop.scripts.activeCollisions || new Set();
        const nextCollisions = contactMap.get(prop.id) || new Map();

        nextCollisions.forEach((collision, collisionKey) => {
            if (!activeCollisions.has(collisionKey)) {
                runObjectEventScript(prop, 'collision', { collision });
            }
        });

        prop.scripts.activeCollisions = new Set(nextCollisions.keys());
    });
}

function handleObjectScriptGlobalPointerDown(event) {
    const clickedInsideMenu = objectScriptMenu && !objectScriptMenu.hidden && objectScriptMenu.contains(event.target);
    const clickedInsideEditor = objectScriptEditor && !objectScriptEditor.hidden && objectScriptEditor.contains(event.target);

    if (!clickedInsideMenu && objectScriptState.menuOpen) {
        closeObjectScriptMenu();
    }

    if (!clickedInsideEditor && objectScriptState.editorOpen && event.target !== renderer?.domElement) {
        closeObjectScriptEditor();
    }
}

function handleObjectScriptKeydown(event) {
    if (event.key !== 'Escape') return;

    if (debugConsoleState.visible) {
        return;
    }

    if (objectScriptState.menuOpen) {
        closeObjectScriptMenu();
    }

    if (objectScriptState.editorOpen) {
        closeObjectScriptEditor();
    }
}

function readMouseActionDrafts() {
    try {
        const rawValue = window.localStorage.getItem(MOUSE_ACTION_STORAGE_KEY);
        if (!rawValue) return null;
        const parsedValue = JSON.parse(rawValue);
        return parsedValue && typeof parsedValue === 'object' ? parsedValue : null;
    } catch (error) {
        console.warn('Failed to load mouse action drafts.', error);
        return null;
    }
}

function saveMouseActionDrafts() {
    try {
        window.localStorage.setItem(MOUSE_ACTION_STORAGE_KEY, JSON.stringify({
            leftSource: mouseActionState.leftSource,
            rightSource: mouseActionState.rightSource,
        }));
    } catch (error) {
        console.warn('Failed to save mouse action drafts.', error);
    }
}

function getMouseActionLabel(button) {
    return button === 'right' ? 'Right' : 'Left';
}

function getMouseActionMessage() {
    const leftState = mouseActionState.leftError ? `Left error: ${mouseActionState.leftError}` : 'Left ready';
    const rightState = mouseActionState.rightError ? `Right error: ${mouseActionState.rightError}` : 'Right ready';
    const modeState = gameplay.active ? 'Play mode: mouse actions are armed.' : 'Showcase mode: mouse actions are disabled.';
    return `${modeState} ${leftState}. ${rightState}.`;
}

function updateMouseActionStatus(extraMessage = '') {
    if (!mouseActionStatus) return;
    mouseActionStatus.textContent = extraMessage ? `${getMouseActionMessage()} ${extraMessage}` : getMouseActionMessage();
}

function syncMouseActionInputs() {
    if (leftMouseActionInput) {
        leftMouseActionInput.value = mouseActionState.leftSource;
    }

    if (rightMouseActionInput) {
        rightMouseActionInput.value = mouseActionState.rightSource;
    }
}

function compileMouseActionScript(source) {
    const normalizedSource = typeof source === 'string' ? source.trim() : '';

    if (!normalizedSource) {
        return new MouseActionFunction('api', '"use strict"; return;');
    }

    return new MouseActionFunction('api', `
        "use strict";
        const { THREE, scene, camera, renderer, currentMesh, gameplay, showcase, physics, event, button, mode, spawnDynamicPrimitive, spawnImportedProp } = api;
        ${normalizedSource}
    `);
}

function buildMouseActionApi(event, button) {
    return {
        THREE,
        scene,
        camera,
        renderer,
        currentMesh,
        gameplay,
        showcase,
        physics,
        event,
        button,
        mode: gameplay.active ? 'play' : 'showcase',
        spawnDynamicPrimitive,
        spawnImportedProp,
    };
}

function applyMouseActionScripts({ persist = true } = {}) {
    if (leftMouseActionInput) {
        mouseActionState.leftSource = leftMouseActionInput.value;
    }

    if (rightMouseActionInput) {
        mouseActionState.rightSource = rightMouseActionInput.value;
    }

    mouseActionState.leftError = '';
    mouseActionState.rightError = '';

    try {
        mouseActionState.leftCompiled = compileMouseActionScript(mouseActionState.leftSource);
    } catch (error) {
        mouseActionState.leftError = error?.message || String(error);
        mouseActionState.leftCompiled = null;
        alert(`error: ${mouseActionState.leftError}`);
    }

    try {
        mouseActionState.rightCompiled = compileMouseActionScript(mouseActionState.rightSource);
    } catch (error) {
        mouseActionState.rightError = error?.message || String(error);
        mouseActionState.rightCompiled = null;
        alert(`error: ${mouseActionState.rightError}`);
    }

    if (persist) {
        saveMouseActionDrafts();
    }

    updateMouseActionStatus(persist ? 'Snippets applied.' : '');
}

function resetMouseActionScripts() {
    mouseActionState.leftSource = DEFAULT_MOUSE_ACTION_SCRIPTS.left;
    mouseActionState.rightSource = DEFAULT_MOUSE_ACTION_SCRIPTS.right;
    syncMouseActionInputs();
    applyMouseActionScripts({ persist: true });
    updateMouseActionStatus('Defaults restored.');
}

function initializeMouseActionScripts() {
    objectScriptState.drafts = readObjectScriptDrafts();
    mouseActionState.leftSource = DEFAULT_MOUSE_ACTION_SCRIPTS.left;
    mouseActionState.rightSource = DEFAULT_MOUSE_ACTION_SCRIPTS.right;
    syncMouseActionInputs();
    applyMouseActionScripts({ persist: true });
    updateMouseActionStatus();
}

function runMouseAction(button, event) {
    if (!gameplay.active || !renderer) return false;

    const compiledAction = button === 'right' ? mouseActionState.rightCompiled : mouseActionState.leftCompiled;
    if (!compiledAction) return false;

    event.preventDefault();
    event.stopPropagation();

    Promise.resolve(compiledAction(buildMouseActionApi(event, button)))
        .then(() => {
            updateMouseActionStatus(`${getMouseActionLabel(button)} mouse action ran in Play mode.`);
        })
        .catch((error) => {
            const errorMessage = error?.message || String(error);
            if (button === 'right') {
                mouseActionState.rightError = errorMessage;
            } else {
                mouseActionState.leftError = errorMessage;
            }
            alert(`error: ${errorMessage}`);
            updateMouseActionStatus(`${getMouseActionLabel(button)} mouse action failed: ${errorMessage}`);
        });

    return true;
}

const container = document.getElementById('canvas-container');
const processingOverlay = document.getElementById('processing-overlay');
const loaderBar = document.getElementById('loader-bar');
const processingStep = document.getElementById('processing-step');
const processTrigger = document.getElementById('process-trigger');
const downloadBtn = document.getElementById('download-asset');

function setCameraMode(mode) {
    if (mode === 'play') {
        closeObjectScriptMenu();
        closeObjectScriptEditor();
        if (!gameplay.active && !gameplay.pointerLocked) {
            enterGameplay();
        }
        return;
    }

    exitGameplay();
    resetShowcaseCamera(true);
}

function updateCameraModeButtons() {
    if (showcaseModeBtn) {
        showcaseModeBtn.classList.toggle('viewer-toggle-btn-active', !gameplay.active);
    }

    if (playModeBtn) {
        playModeBtn.disabled = !gameplay.canPlay;
        playModeBtn.classList.toggle('btn-disabled', !gameplay.canPlay);
        playModeBtn.classList.toggle('viewer-toggle-btn-active', gameplay.active);
    }
}

function resetMobileInputState() {
    resetMovementInputState();
    resetMobileMovePad();
    resetMobileLookPad();
}

function resetMovementInputState() {
    showcase.input.forward = false;
    showcase.input.back = false;
    showcase.input.left = false;
    showcase.input.right = false;
    showcase.input.up = false;
    showcase.input.down = false;
    showcase.input.boost = false;
    gameplay.input.forward = false;
    gameplay.input.back = false;
    gameplay.input.left = false;
    gameplay.input.right = false;
    gameplay.input.sprint = false;
    physics.jumpQueued = false;
}

function isEditableElement(target) {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function pushTimingSample(metric, value) {
    const series = debugConsoleState.samples[metric];
    if (!series) return;

    series.push(value);
    if (series.length > DEBUG_TIMING_SAMPLE_LIMIT) {
        series.shift();
    }
}

function getAverageTiming(metric) {
    const series = debugConsoleState.samples[metric];
    if (!series || !series.length) return 0;
    return series.reduce((sum, value) => sum + value, 0) / series.length;
}

function formatTimingMs(value) {
    return `${value.toFixed(value >= 10 ? 1 : 2)} ms`;
}

function renderDebugConsoleOutput() {
    if (!debugConsoleOutput) return;

    const fragment = document.createDocumentFragment();
    debugConsoleState.lines.forEach((line) => {
        const row = document.createElement('div');
        row.className = 'debug-console-line';
        row.dataset.tone = line.tone || 'info';

        const prefix = document.createElement('span');
        prefix.className = 'debug-console-prefix';
        prefix.textContent = line.prefix;

        const text = document.createElement('span');
        text.className = 'debug-console-text';
        text.textContent = line.text;

        row.append(prefix, text);
        fragment.appendChild(row);
    });

    debugConsoleOutput.replaceChildren(fragment);
    debugConsoleOutput.scrollTop = debugConsoleOutput.scrollHeight;
}

function pushDebugConsoleLine(text, tone = 'info', prefix = 'sys') {
    debugConsoleState.lines.push({ prefix, text, tone });
    if (debugConsoleState.lines.length > DEBUG_CONSOLE_LOG_LIMIT) {
        debugConsoleState.lines.shift();
    }
    renderDebugConsoleOutput();
}

function focusDebugConsoleInput() {
    if (!debugConsoleInput) return;
    window.requestAnimationFrame(() => {
        debugConsoleInput.focus();
        debugConsoleInput.select();
    });
}

function setDebugConsoleVisible(isVisible, { focusInput = true } = {}) {
    debugConsoleState.visible = !!isVisible;

    if (debugConsole) {
        debugConsole.hidden = !debugConsoleState.visible;
    }

    document.body.classList.toggle('console-open', debugConsoleState.visible);

    if (debugConsoleState.visible) {
        closeObjectScriptMenu();
        closeObjectScriptEditor();
        resetMovementInputState();

        if (document.pointerLockElement === renderer?.domElement) {
            document.exitPointerLock?.();
        }

        if (focusInput) {
            focusDebugConsoleInput();
        }
        return;
    }

    debugConsoleInput?.blur();
}

function createDebugStatRow(label) {
    const row = document.createElement('div');
    row.className = 'debug-stat-row';

    const title = document.createElement('div');
    title.className = 'debug-stat-label';
    title.textContent = label;

    const value = document.createElement('div');
    value.className = 'debug-stat-value';
    value.textContent = '--';

    row.append(title, value);
    return { row, value };
}

function createDebugStatPanel(name) {
    if (!debugStatsOverlay) return null;

    const panel = document.createElement('section');
    panel.className = 'debug-stat-panel';
    panel.dataset.panel = name;

    const header = document.createElement('div');
    header.className = 'debug-stat-header';

    const titleWrap = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'debug-stat-title';
    title.textContent = name === 'unit' ? 'Stat Unit' : name === 'physics' ? 'Stat Physics' : 'Stat GPU';

    const meta = document.createElement('div');
    meta.className = 'debug-stat-meta';
    meta.textContent = 'Waiting for frame samples...';
    titleWrap.append(title, meta);
    header.appendChild(titleWrap);

    let badge = null;
    if (name === 'gpu') {
        badge = document.createElement('div');
        badge.className = 'debug-stat-badge';
        badge.textContent = 'Approx';
        header.appendChild(badge);
    }

    const grid = document.createElement('div');
    grid.className = 'debug-stat-grid';
    const rows = {};

    const labels = name === 'unit'
        ? ['Frame', 'FPS', 'Update', 'Physics', 'Render', 'Scripts']
        : name === 'physics'
            ? ['Step', 'Sync', 'Collisions', 'Bodies', 'Passes', 'Delta']
            : ['GPU', 'Render', 'Frame', 'FPS'];

    labels.forEach((label) => {
        const key = label.toLowerCase();
        const rowRef = createDebugStatRow(label);
        rows[key] = rowRef.value;
        grid.appendChild(rowRef.row);
    });

    panel.append(header, grid);
    debugStatsOverlay.appendChild(panel);

    return { panel, meta, badge, rows };
}

function syncDebugStatPanels() {
    if (!debugStatsOverlay) return;

    debugConsoleState.panelRefs.forEach((ref, name) => {
        if (!debugConsoleState.panels.has(name)) {
            ref.panel.remove();
            debugConsoleState.panelRefs.delete(name);
        }
    });

    Array.from(debugConsoleState.panels).forEach((name) => {
        if (debugConsoleState.panelRefs.has(name)) return;
        const ref = createDebugStatPanel(name);
        if (ref) {
            debugConsoleState.panelRefs.set(name, ref);
        }
    });
}

function updateDebugStatPanels() {
    if (!debugConsoleState.panels.size) return;

    const averageFrame = getAverageTiming('frame');
    const averageUpdate = getAverageTiming('update');
    const averagePhysics = getAverageTiming('physics');
    const averagePhysicsStep = getAverageTiming('physicsStep');
    const averagePhysicsSync = getAverageTiming('physicsSync');
    const averagePhysicsCollisions = getAverageTiming('physicsCollisions');
    const averageScripts = getAverageTiming('scripts');
    const averageRender = getAverageTiming('render');
    const averageFps = averageFrame > 0 ? 1000 / averageFrame : 0;

    debugConsoleState.panelRefs.forEach((ref, name) => {
        if (name === 'unit') {
            ref.meta.textContent = gameplay.active ? 'Play mode frame timings' : 'Showcase frame timings';
            ref.rows.frame.textContent = formatTimingMs(averageFrame);
            ref.rows.fps.textContent = `${averageFps.toFixed(1)} fps`;
            ref.rows.update.textContent = formatTimingMs(averageUpdate);
            ref.rows.physics.textContent = formatTimingMs(averagePhysics);
            ref.rows.render.textContent = formatTimingMs(averageRender);
            ref.rows.scripts.textContent = formatTimingMs(averageScripts);
            return;
        }

        if (name === 'physics') {
            ref.meta.textContent = physics.ready ? 'Jolt step vs. post-step overhead' : 'Physics still initializing';
            ref.rows.step.textContent = formatTimingMs(averagePhysicsStep);
            ref.rows.sync.textContent = formatTimingMs(averagePhysicsSync);
            ref.rows.collisions.textContent = formatTimingMs(averagePhysicsCollisions);
            ref.rows.bodies.textContent = `${physics.dynamicBodies.length}`;
            ref.rows.passes.textContent = `${debugConsoleState.latest.collisionSteps}`;
            ref.rows.delta.textContent = `${(debugConsoleState.latest.delta * 1000).toFixed(1)} ms`;
            return;
        }

        ref.meta.textContent = 'WebGPU render submission timing';
        if (ref.badge) {
            ref.badge.textContent = debugConsoleState.gpuTimingMode === 'approximate' ? 'Approx' : 'GPU';
        }
        ref.rows.gpu.textContent = formatTimingMs(averageRender);
        ref.rows.render.textContent = formatTimingMs(averageRender);
        ref.rows.frame.textContent = formatTimingMs(averageFrame);
        ref.rows.fps.textContent = `${averageFps.toFixed(1)} fps`;
    });
}

function setDebugStatPanel(name, isEnabled) {
    if (isEnabled) {
        debugConsoleState.panels.add(name);
    } else {
        debugConsoleState.panels.delete(name);
    }

    syncDebugStatPanels();
}

function runStatCommand(args) {
    if (!args.length) {
        pushDebugConsoleLine('Available stat commands: gpu, physics, unit, none.', 'warn');
        return;
    }

    const panel = args[0].toLowerCase();
    const mode = args[1]?.toLowerCase() || 'on';
    const disableTokens = new Set(['0', 'false', 'hide', 'none', 'off']);

    if (disableTokens.has(panel) || panel === 'clear') {
        debugConsoleState.panels.clear();
        syncDebugStatPanels();
        pushDebugConsoleLine('All stat panels hidden.', 'success');
        return;
    }

    if (!['gpu', 'physics', 'unit'].includes(panel)) {
        pushDebugConsoleLine(`Unknown stat target: ${panel}.`, 'error');
        return;
    }

    const isEnabled = !disableTokens.has(mode);
    setDebugStatPanel(panel, isEnabled);

    if (panel === 'gpu' && isEnabled) {
        pushDebugConsoleLine('Stat GPU enabled. This currently reports approximate WebGPU render submission time.', 'warn');
        return;
    }

    pushDebugConsoleLine(`Stat ${panel} ${isEnabled ? 'enabled' : 'hidden'}.`, 'success');
}

const debugCommandRegistry = {
    stat: runStatCommand,
};

function executeDebugConsoleCommand(rawCommand) {
    const commandText = rawCommand.trim();
    if (!commandText) return;

    debugConsoleState.history.push(commandText);
    if (debugConsoleState.history.length > DEBUG_CONSOLE_HISTORY_LIMIT) {
        debugConsoleState.history.shift();
    }
    debugConsoleState.historyIndex = debugConsoleState.history.length;

    pushDebugConsoleLine(commandText, 'command', '>');

    const [commandName, ...args] = commandText.split(/\s+/);
    const handler = debugCommandRegistry[commandName.toLowerCase()];

    if (!handler) {
        pushDebugConsoleLine(`Unknown command: ${commandName}.`, 'error');
        return;
    }

    handler(args);
}

function handleDebugConsoleInputKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        executeDebugConsoleCommand(debugConsoleInput.value);
        debugConsoleInput.value = '';
        return;
    }

    if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (!debugConsoleState.history.length) return;
        debugConsoleState.historyIndex = Math.max(0, debugConsoleState.historyIndex - 1);
        debugConsoleInput.value = debugConsoleState.history[debugConsoleState.historyIndex] || '';
        return;
    }

    if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (!debugConsoleState.history.length) return;
        debugConsoleState.historyIndex = Math.min(debugConsoleState.history.length, debugConsoleState.historyIndex + 1);
        debugConsoleInput.value = debugConsoleState.history[debugConsoleState.historyIndex] || '';
        return;
    }

    if (event.key === 'Escape') {
        event.preventDefault();
        setDebugConsoleVisible(false, { focusInput: false });
    }
}

function handleDebugConsoleKeydown(event) {
    if (event.code === 'Backquote' && !event.repeat) {
        if (!debugConsoleState.visible && isEditableElement(event.target) && event.target !== debugConsoleInput) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        setDebugConsoleVisible(!debugConsoleState.visible);
        return;
    }

    if (!debugConsoleState.visible) return;

    if (event.code === 'Escape') {
        event.preventDefault();
        setDebugConsoleVisible(false, { focusInput: false });
        return;
    }

    if (event.target !== debugConsoleInput) {
        event.preventDefault();
        focusDebugConsoleInput();
    }
}

function recordDebugFrameMetrics(metrics) {
    debugConsoleState.latest.frame = metrics.frame;
    debugConsoleState.latest.update = metrics.update;
    debugConsoleState.latest.physics = metrics.physics;
    debugConsoleState.latest.physicsStep = metrics.physicsStep;
    debugConsoleState.latest.physicsSync = metrics.physicsSync;
    debugConsoleState.latest.physicsCollisions = metrics.physicsCollisions;
    debugConsoleState.latest.scripts = metrics.scripts;
    debugConsoleState.latest.render = metrics.render;
    debugConsoleState.latest.fps = metrics.frame > 0 ? 1000 / metrics.frame : 0;
    debugConsoleState.latest.delta = metrics.delta;

    pushTimingSample('frame', metrics.frame);
    pushTimingSample('update', metrics.update);
    pushTimingSample('physics', metrics.physics);
    pushTimingSample('physicsStep', metrics.physicsStep);
    pushTimingSample('physicsSync', metrics.physicsSync);
    pushTimingSample('physicsCollisions', metrics.physicsCollisions);
    pushTimingSample('scripts', metrics.scripts);
    pushTimingSample('render', metrics.render);
}

function setMobileMenuOpen(isOpen) {
    mobileState.menuOpen = !!isOpen;
    document.body.classList.toggle('mobile-menu-open', mobileState.menuOpen);

    if (mobileMenuToggleBtn) {
        mobileMenuToggleBtn.textContent = mobileState.menuOpen ? 'Close' : 'Menu';
        mobileMenuToggleBtn.classList.toggle('viewer-toggle-btn-active', mobileState.menuOpen);
    }
}

function setTouchThumbPosition(thumbElement, offsetX, offsetY) {
    if (!thumbElement) return;
    thumbElement.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px))`;
}

function clearMobilePad(thumbElement) {
    setTouchThumbPosition(thumbElement, 0, 0);
}

function applyMobileMoveVector(x, y) {
    const forward = y < -MOBILE_MOVE_THRESHOLD;
    const back = y > MOBILE_MOVE_THRESHOLD;
    const left = x < -MOBILE_MOVE_THRESHOLD;
    const right = x > MOBILE_MOVE_THRESHOLD;

    if (gameplay.active) {
        gameplay.input.forward = forward;
        gameplay.input.back = back;
        gameplay.input.left = left;
        gameplay.input.right = right;
        return;
    }

    showcase.input.forward = forward;
    showcase.input.back = back;
    showcase.input.left = left;
    showcase.input.right = right;
}

function updateMobileMovePad(clientX, clientY) {
    if (!mobileMovePad) return;

    const rect = mobileMovePad.getBoundingClientRect();
    const radius = Math.max(1, Math.min(rect.width, rect.height) * MOBILE_MOVE_RADIUS_FACTOR);
    const centerX = rect.left + rect.width * 0.5;
    const centerY = rect.top + rect.height * 0.5;
    const offsetX = clientX - centerX;
    const offsetY = clientY - centerY;
    const length = Math.hypot(offsetX, offsetY);
    const scale = length > radius ? radius / length : 1;
    const clampedX = offsetX * scale;
    const clampedY = offsetY * scale;

    setTouchThumbPosition(mobileMoveThumb, clampedX, clampedY);
    applyMobileMoveVector(clampedX / radius, clampedY / radius);
}

function resetMobileMovePad() {
    mobileState.movePointerId = null;
    clearMobilePad(mobileMoveThumb);
    applyMobileMoveVector(0, 0);
}

function applyMobileLookDelta(deltaX, deltaY) {
    const lookTarget = gameplay.active ? gameplay : showcase;

    lookTarget.yaw -= deltaX * MOBILE_LOOK_SENSITIVITY;
    lookTarget.pitch -= deltaY * MOBILE_LOOK_SENSITIVITY;
    lookTarget.pitch = THREE.MathUtils.clamp(
        lookTarget.pitch,
        -PLAYER_SETTINGS.maxLookPitch,
        PLAYER_SETTINGS.maxLookPitch
    );

    if (gameplay.active) {
        applyGameplayCameraRotation();
    } else {
        applyShowcaseCameraRotation();
    }
}

function updateMobileLookPad(clientX, clientY, deltaX = 0, deltaY = 0) {
    if (!mobileLookPad) return;

    const rect = mobileLookPad.getBoundingClientRect();
    const radius = Math.max(1, Math.min(rect.width, rect.height) * MOBILE_MOVE_RADIUS_FACTOR);
    const centerX = rect.left + rect.width * 0.5;
    const centerY = rect.top + rect.height * 0.5;
    const offsetX = clientX - centerX;
    const offsetY = clientY - centerY;
    const length = Math.hypot(offsetX, offsetY);
    const scale = length > radius ? radius / length : 1;

    setTouchThumbPosition(mobileLookThumb, offsetX * scale, offsetY * scale);

    if (deltaX || deltaY) {
        applyMobileLookDelta(deltaX, deltaY);
    }
}

function resetMobileLookPad() {
    mobileState.lookPointerId = null;
    if (mobileLookPad?.dataset) {
        delete mobileLookPad.dataset.lastX;
        delete mobileLookPad.dataset.lastY;
    }
    clearMobilePad(mobileLookThumb);
}

function syncMobileActionVisibility() {
    if (mobileJumpBtn) {
        mobileJumpBtn.hidden = !gameplay.active;
    }

    if (mobileRightActionBtn) {
        mobileRightActionBtn.hidden = !gameplay.active;
    }

    if (mobileModeToggleBtn) {
        mobileModeToggleBtn.textContent = gameplay.active ? 'Showcase' : 'Play';
        mobileModeToggleBtn.classList.toggle('viewer-toggle-btn-active', gameplay.active);
    }

}

function updateMobileButtons() {
    if (mobileMenuToggleBtn) {
        mobileMenuToggleBtn.classList.toggle('viewer-toggle-btn-active', mobileState.menuOpen);
    }

    syncMobileActionVisibility();
}

function applyMobileHoldButton(button, onDown, onUp) {
    if (!button) return;

    let isPressed = false;

    const release = () => {
        if (!isPressed) return;
        isPressed = false;
        onUp?.();
    };

    button.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        event.preventDefault();
        isPressed = true;
        button.setPointerCapture?.(event.pointerId);
        onDown?.(event);
    });

    button.addEventListener('pointerup', () => release());
    button.addEventListener('pointercancel', () => release());
    button.addEventListener('lostpointercapture', () => release());
    button.addEventListener('contextmenu', (event) => event.preventDefault());
}

function bindMobilePad(padElement, thumbElement, onMove, onRelease) {
    if (!padElement) return;

    const handleMove = (event) => {
        if (event.pointerId !== mobileState[padElement === mobileMovePad ? 'movePointerId' : 'lookPointerId']) return;
        event.preventDefault();
        onMove(event);
    };

    padElement.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        event.preventDefault();
        padElement.setPointerCapture?.(event.pointerId);
        if (padElement === mobileMovePad) {
            mobileState.movePointerId = event.pointerId;
        } else {
            mobileState.lookPointerId = event.pointerId;
        }
        onMove(event);
    });

    padElement.addEventListener('pointermove', handleMove);
    padElement.addEventListener('pointerup', (event) => {
        if (padElement === mobileMovePad && event.pointerId !== mobileState.movePointerId) return;
        if (padElement === mobileLookPad && event.pointerId !== mobileState.lookPointerId) return;
        event.preventDefault();
        onRelease?.();
    });
    padElement.addEventListener('pointercancel', () => onRelease?.());
    padElement.addEventListener('lostpointercapture', () => onRelease?.());
    padElement.addEventListener('contextmenu', (event) => event.preventDefault());
}

function setupMobileControls() {
    mobileMenuToggleBtn = document.getElementById('mobile-menu-toggle');
    mobileModeToggleBtn = document.getElementById('mobile-mode-toggle');
    mobileMovePad = document.getElementById('mobile-move-pad');
    mobileMoveThumb = document.getElementById('mobile-move-thumb');
    mobileLookPad = document.getElementById('mobile-look-pad');
    mobileLookThumb = document.getElementById('mobile-look-thumb');
    mobileRightActionBtn = document.getElementById('mobile-right-action');
    mobileJumpBtn = document.getElementById('mobile-jump');

    mobileMenuToggleBtn?.addEventListener('click', () => setMobileMenuOpen(!mobileState.menuOpen));
    mobileModeToggleBtn?.addEventListener('click', () => setCameraMode(gameplay.active ? 'showcase' : 'play'));

    mobileJumpBtn?.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        event.preventDefault();
        if (gameplay.active) {
            physics.jumpQueued = true;
        }
    });

    mobileRightActionBtn?.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        runMouseAction('right', event);
    });

    bindMobilePad(mobileMovePad, mobileMoveThumb, (event) => {
        updateMobileMovePad(event.clientX, event.clientY);
    }, () => {
        resetMobileMovePad();
    });

    bindMobilePad(mobileLookPad, mobileLookThumb, (event) => {
        const lastX = mobileLookPad.dataset.lastX ? Number(mobileLookPad.dataset.lastX) : event.clientX;
        const lastY = mobileLookPad.dataset.lastY ? Number(mobileLookPad.dataset.lastY) : event.clientY;
        const deltaX = event.clientX - lastX;
        const deltaY = event.clientY - lastY;
        mobileLookPad.dataset.lastX = String(event.clientX);
        mobileLookPad.dataset.lastY = String(event.clientY);
        updateMobileLookPad(event.clientX, event.clientY, deltaX, deltaY);
    }, () => {
        if (mobileLookPad?.dataset) {
            delete mobileLookPad.dataset.lastX;
            delete mobileLookPad.dataset.lastY;
        }
        resetMobileLookPad();
    });

    updateMobileButtons();
}

// --- Initialization ---
async function init() {
    // Mobile Detection
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.matchMedia('(pointer: coarse)').matches;
    mobileState.enabled = isMobile;
    document.body.classList.toggle('is-mobile', isMobile);

    // Add listeners immediately so UI is responsive even if WASM is loading
    document.getElementById('load-sample').addEventListener('click', (e) => {
        e.stopPropagation();
        loadSample();
    });

    browseModelBtn = document.getElementById('open-model-menu');
    showcaseModeBtn = document.getElementById('camera-showcase');
    playModeBtn = document.getElementById('camera-play');
    spawnRigidSphereBtn = document.getElementById('spawn-rigid-sphere');
    spawnRigidCubeBtn = document.getElementById('spawn-rigid-cube');
    importPropBtn = document.getElementById('import-prop-menu');
    propFileInput = document.getElementById('prop-file-input');
    importedPropList = document.getElementById('imported-prop-list');
    importedPropLibrary = document.getElementById('imported-prop-library');
    propImportDefaultStatus = document.getElementById('prop-import-default-status');
    resetPropImportDefaultBtn = document.getElementById('reset-prop-import-default');
    propCollisionPrompt = document.getElementById('prop-collision-prompt');
    propCollisionCopy = document.getElementById('prop-collision-copy');
    propCollisionRemember = document.getElementById('prop-collision-remember');
    propCollisionSimpleBtn = document.getElementById('prop-collision-simple');
    propCollisionComplexBtn = document.getElementById('prop-collision-complex');
    propCollisionCancelBtn = document.getElementById('prop-collision-cancel');
    leftMouseActionInput = document.getElementById('left-mouse-action');
    rightMouseActionInput = document.getElementById('right-mouse-action');
    mouseActionApplyBtn = document.getElementById('apply-mouse-actions');
    mouseActionResetBtn = document.getElementById('reset-mouse-actions');
    mouseActionStatus = document.getElementById('mouse-action-status');
    objectScriptMenu = document.getElementById('object-script-menu');
    objectScriptTickActionBtn = document.getElementById('object-script-action-tick');
    objectScriptCollisionActionBtn = document.getElementById('object-script-action-collision');
    objectScriptEditor = document.getElementById('object-script-editor');
    objectScriptEditorTitle = document.getElementById('object-script-editor-title');
    objectScriptEditorTarget = document.getElementById('object-script-editor-target');
    objectScriptEditorMode = document.getElementById('object-script-editor-mode');
    objectScriptTickToggleRow = document.getElementById('object-script-tick-toggle-row');
    objectScriptTickToggleInput = document.getElementById('object-script-tick-toggle');
    objectScriptEditorInput = document.getElementById('object-script-editor-input');
    objectScriptEditorStatus = document.getElementById('object-script-editor-status');
    objectScriptEditorApplyBtn = document.getElementById('object-script-editor-apply');
    objectScriptEditorClearBtn = document.getElementById('object-script-editor-clear');
    objectScriptEditorCancelBtn = document.getElementById('object-script-editor-cancel');
    debugConsole = document.getElementById('debug-console');
    debugConsoleOutput = document.getElementById('debug-console-output');
    debugConsoleInput = document.getElementById('debug-console-input');
    debugConsoleFooter = document.getElementById('debug-console-footer');
    debugStatsOverlay = document.getElementById('debug-stats-overlay');

    renderDebugConsoleOutput();
    debugConsoleInput?.addEventListener('keydown', handleDebugConsoleInputKeydown);

    if (browseModelBtn) {
        browseModelBtn.addEventListener('click', () => {
            document.getElementById('file-input').click();
        });
    }

    if (importPropBtn) {
        importPropBtn.addEventListener('click', () => {
            propFileInput.value = '';
            propFileInput.click();
        });
    }

    propFileInput?.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        event.target.value = '';
        if (!file) return;
        await importPhysicsProp(file, {});
    });

    resetPropImportDefaultBtn?.addEventListener('click', () => {
        importedPropState.futureCollisionMode = null;
        updatePropImportStatus();
    });

    propCollisionSimpleBtn?.addEventListener('click', () => {
        resolvePropCollisionPrompt({
            mode: 'simple',
            remember: !!propCollisionRemember?.checked,
        });
    });

    propCollisionComplexBtn?.addEventListener('click', () => {
        resolvePropCollisionPrompt({
            mode: 'complex',
            remember: !!propCollisionRemember?.checked,
        });
    });

    propCollisionCancelBtn?.addEventListener('click', () => resolvePropCollisionPrompt(null));

    spawnRigidSphereBtn?.addEventListener('click', () => spawnDynamicPrimitive('sphere'));
    spawnRigidCubeBtn?.addEventListener('click', () => spawnDynamicPrimitive('cube'));

    leftMouseActionInput?.addEventListener('input', () => {
        mouseActionState.leftSource = leftMouseActionInput.value;
        saveMouseActionDrafts();
    });

    rightMouseActionInput?.addEventListener('input', () => {
        mouseActionState.rightSource = rightMouseActionInput.value;
        saveMouseActionDrafts();
    });

    mouseActionApplyBtn?.addEventListener('click', () => applyMouseActionScripts({ persist: true }));
    mouseActionResetBtn?.addEventListener('click', () => resetMouseActionScripts());
    objectScriptTickActionBtn?.addEventListener('click', () => openObjectScriptEditor('tick'));
    objectScriptCollisionActionBtn?.addEventListener('click', () => openObjectScriptEditor('collision'));
    objectScriptEditorApplyBtn?.addEventListener('click', () => {
        const prop = getDynamicPropById(objectScriptState.targetPropId);
        if (!prop || !objectScriptEditorInput) return;
        updatePropScriptSource(prop, objectScriptState.targetEvent, objectScriptEditorInput.value, { persist: true, notify: true });
    });
    objectScriptTickToggleInput?.addEventListener('change', () => {
        const prop = getDynamicPropById(objectScriptState.targetPropId);
        if (!prop) return;
        setPropTickEventEnabled(prop, !!objectScriptTickToggleInput.checked, { persist: true });
    });
    objectScriptEditorClearBtn?.addEventListener('click', () => {
        const prop = getDynamicPropById(objectScriptState.targetPropId);
        if (!prop) return;
        clearPropScriptSource(prop, objectScriptState.targetEvent);
        syncObjectScriptEditor();
    });
    objectScriptEditorCancelBtn?.addEventListener('click', () => closeObjectScriptEditor());
    document.addEventListener('pointerdown', handleObjectScriptGlobalPointerDown, true);
    document.addEventListener('keydown', handleObjectScriptKeydown);

    showcaseModeBtn?.addEventListener('click', () => setCameraMode('showcase'));
    playModeBtn?.addEventListener('click', () => setCameraMode('play'));

    setupDropHandlers();
    setupMobileControls();

    // Slider listener
    const slider = document.getElementById('ratio-slider');
    const ratioValue = document.getElementById('ratio-value');
    if (slider) {
        slider.addEventListener('input', (e) => {
            const val = Math.round(e.target.value * 100);
            if (ratioValue) {
                ratioValue.textContent = `${val}%`;
            }
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
    await initPhysics();

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.copy(SHOWCASE_CAMERA_POSITION);
    camera.rotation.order = 'YXZ';
    syncShowcaseAnglesFromTarget(SHOWCASE_CAMERA_TARGET);
    applyShowcaseCameraRotation();

    renderer = new WebGPURenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.localClippingEnabled = true; // Essential for the reflection
    renderer.domElement.tabIndex = 0;
    container.appendChild(renderer.domElement);

    // Load initial HDR Environment
    switchEnvironment('sunny-sky');

    // Pedestal
    const pedestalGeo = new THREE.CylinderGeometry(2.5, 2.5, 0.02, 64);
    pedestalMat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        metalness: 0.1,
        roughness: 0.05,
        transmission: 1.0,
        thickness: 0,
        ior: 1.0, // IOR 1.0 eliminates double-refraction ghosting from the bottom cap
        transparent: true,
        opacity: 0.9 // Slightly more opaque for better grounding
    });
    pedestal = new THREE.Mesh(pedestalGeo, pedestalMat);
    pedestal.position.y = -0.05;
    scene.add(pedestal);

    worldFloor = createTerrainMesh();
    scene.add(worldFloor);
    await applyTerrainTextures(worldFloor);
    buildLightGrid();
    rebuildTerrainPhysicsBody();

    // Removed shadow plane to eliminate 'double blur' artifacts

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

    playHint = document.getElementById('play-hint');
    gameplayStatus = document.getElementById('gameplay-status');
    resetViewBtn = document.getElementById('reset-view');
    updatePropImportStatus();
    renderImportedPropButtons();
    initializeMouseActionScripts();
    setupGameplayEvents();
    updateGameplayUI();

    renderer.setAnimationLoop(() => {
        const delta = Math.min(clock.getDelta(), 0.05);

        const updateStart = performance.now();
        if (gameplay.active) {
            updateGameplay(delta);
        } else {
            updateShowcaseCamera(delta);
        }
        const updateDuration = performance.now() - updateStart;

        const physicsMetrics = stepPhysics(delta);

        const scriptStart = performance.now();
        runObjectTickScripts(delta);
        const scriptDuration = performance.now() - scriptStart;

        const renderStart = performance.now();
        renderer.renderAsync(scene, camera);

        recordDebugFrameMetrics({
            frame: delta * 1000,
            update: updateDuration,
            physics: physicsMetrics.total,
            physicsStep: physicsMetrics.step,
            physicsSync: physicsMetrics.sync,
            physicsCollisions: physicsMetrics.collisions,
            scripts: scriptDuration,
            render: performance.now() - renderStart,
            delta,
        });
        updateDebugStatPanels();
    });
}

function loadSample() {
    clearCurrentMesh();

    // Create a very dense Torus Knot to simulate a "heavy" file
    const geometry = new THREE.TorusKnotGeometry(1, 0.3, 300, 100);
    const material = new THREE.MeshStandardMaterial({
        color: 0x7000ff,
        metalness: 0.8,
        roughness: 0.2,
        emissive: 0x200040
    });

    const object = new THREE.Mesh(geometry, material);
    object.castShadow = true;
    object.receiveShadow = true;

    currentMesh = object;
    scene.add(currentMesh);
    normalizeCurrentMesh();
    refreshGameplayWorld();

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

    enableOptimizationPipeline();
}

// Render loop now handled by setAnimationLoop in init

function onWindowResize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}

function clearCurrentMesh() {
    exitGameplay();
    clearDynamicPhysicsProps();

    if (physics.modelBody) {
        destroyPhysicsBody(physics.modelBody);
        physics.modelBody = null;
    }
    destroyPlayerCharacter();

    if (!currentMesh) {
        gameplay.canPlay = physics.ready;
        updateGameplayUI();
        return;
    }

    scene.remove(currentMesh);
    disposeRenderableObject(currentMesh);

    currentMesh = null;
    gameplay.canPlay = physics.ready;
    updateGameplayUI();
}

function normalizeCurrentMesh(targetDimension = MODEL_TARGET_MAX_DIMENSION) {
    if (!currentMesh) return;
    normalizeObjectToDimension(currentMesh, targetDimension, true);
}

function refreshGameplayWorld() {
    if (!currentMesh) {
        gameplay.canPlay = physics.ready;
        updateGameplayUI();
        return;
    }

    currentMesh.updateWorldMatrix(true, true);
    gameplayBounds.setFromObject(currentMesh);
    gameplayLookTarget.copy(gameplayBounds.getCenter(tempVectorA));

    const worldSize = gameplayBounds.getSize(tempVectorB);
    const floorScale = Math.max(1, worldSize.x / 18, worldSize.z / 18);
    worldFloor.scale.setScalar(floorScale);
    worldFloor.position.set(gameplayLookTarget.x, TERRAIN_Y_OFFSET, gameplayLookTarget.z);
    positionLightGrid(gameplayLookTarget);

    const topHit = getGroundHitAt(gameplayLookTarget.x, gameplayLookTarget.z, false);
    if (topHit && topHit.point.y > worldFloor.position.y + 0.15) {
        gameplay.spawnPoint.set(
            gameplayLookTarget.x,
            topHit.point.y + PLAYER_SETTINGS.floorOffset,
            gameplayLookTarget.z
        );
    } else {
        const fallbackZ = gameplayBounds.max.z + Math.max(worldSize.z * 0.25, 2.5);
        const fallbackY = getGroundHeightAt(gameplayLookTarget.x, fallbackZ, true) ?? worldFloor.position.y;
        gameplay.spawnPoint.set(
            gameplayLookTarget.x,
            fallbackY + PLAYER_SETTINGS.floorOffset,
            fallbackZ
        );
    }

    gameplay.velocity.set(0, 0, 0);
    gameplay.grounded = false;
    rebuildTerrainPhysicsBody();
    rebuildModelPhysicsBody();
    if (physics.ready) {
        ensurePlayerCharacter();
    }
    gameplay.canPlay = !!physics.character;
    updateWorldPresentation();
    resetShowcaseCamera(false);
    updateGameplayUI();
}

function setupGameplayEvents() {
    document.addEventListener('pointerlockchange', handlePointerLockChange);
    document.addEventListener('mousemove', handleGameplayMouseMove);
    document.addEventListener('keydown', handleDebugConsoleKeydown, true);
    document.addEventListener('keydown', handleGameplayKeyEvent);
    document.addEventListener('keyup', handleGameplayKeyEvent);
    renderer.domElement.addEventListener('mousedown', handleShowcaseMouseButton);
    window.addEventListener('mouseup', handleShowcaseMouseButton);
    renderer.domElement.addEventListener('wheel', handleShowcaseWheel, { passive: false });
    renderer.domElement.addEventListener('contextmenu', handleShowcaseContextMenu);
    renderer.domElement.addEventListener('click', handleLightGridClick);
    renderer.domElement.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse') return;
        if (gameplay.active) {
            if (runMouseAction('left', event)) {
                event.preventDefault();
            }
            return;
        }
        if (maybeOpenObjectScriptMenuFromMobileTap(event)) {
            event.preventDefault();
        }
    }, { passive: false });
}

function adjustShowcaseSpeed(direction) {
    const factor = direction > 0 ? showcase.wheelSpeedStep : 1 / showcase.wheelSpeedStep;
    showcase.moveSpeed = THREE.MathUtils.clamp(
        showcase.moveSpeed * factor,
        showcase.minMoveSpeed,
        showcase.maxMoveSpeed
    );
    updateGameplayUI();
}

function updateShowcaseInput(event, isDown) {
    switch (event.code) {
        case 'KeyW':
        case 'ArrowUp':
            showcase.input.forward = isDown;
            return true;
        case 'KeyS':
        case 'ArrowDown':
            showcase.input.back = isDown;
            return true;
        case 'KeyA':
        case 'ArrowLeft':
            showcase.input.left = isDown;
            return true;
        case 'KeyD':
        case 'ArrowRight':
            showcase.input.right = isDown;
            return true;
        case 'KeyE':
        case 'Space':
            showcase.input.up = isDown;
            return true;
        case 'KeyQ':
        case 'ControlLeft':
        case 'ControlRight':
            showcase.input.down = isDown;
            return true;
        case 'ShiftLeft':
        case 'ShiftRight':
            showcase.input.boost = isDown;
            return true;
        default:
            return false;
    }
}

function handleGameplayKeyEvent(event) {
    const isDown = event.type === 'keydown';

    if (debugConsoleState.visible) {
        if (gameplay.pointerLocked || gameplay.active) {
            event.preventDefault();
        }
        return;
    }

    if (!gameplay.active && !gameplay.pointerLocked) {
        const acceptsShowcaseInput = renderer && (showcase.looking || document.activeElement === renderer.domElement);
        if (acceptsShowcaseInput && updateShowcaseInput(event, isDown)) {
            event.preventDefault();
            return;
        }
    }

    if (!gameplay.canPlay) return;

    switch (event.code) {
        case 'KeyW':
        case 'ArrowUp':
            gameplay.input.forward = isDown;
            break;
        case 'KeyS':
        case 'ArrowDown':
            gameplay.input.back = isDown;
            break;
        case 'KeyA':
        case 'ArrowLeft':
            gameplay.input.left = isDown;
            break;
        case 'KeyD':
        case 'ArrowRight':
            gameplay.input.right = isDown;
            break;
        case 'ShiftLeft':
        case 'ShiftRight':
            gameplay.input.sprint = isDown;
            break;
        case 'Space':
            if (gameplay.pointerLocked) event.preventDefault();
            if (isDown && !event.repeat && gameplay.active) {
                physics.jumpQueued = true;
            }
            break;
        case 'KeyR':
            if (isDown && gameplay.active) {
                respawnPlayer();
            }
            break;
        default:
            return;
    }

    if (gameplay.pointerLocked) {
        event.preventDefault();
    }
}

function handleGameplayMouseMove(event) {
    if (!gameplay.pointerLocked) {
        if (!showcase.looking || gameplay.active) return;

        showcase.yaw -= event.movementX * 0.0022;
        showcase.pitch -= event.movementY * 0.0018;
        showcase.pitch = THREE.MathUtils.clamp(
            showcase.pitch,
            -PLAYER_SETTINGS.maxLookPitch,
            PLAYER_SETTINGS.maxLookPitch
        );

        applyShowcaseCameraRotation();
        return;
    }

    gameplay.yaw -= event.movementX * 0.0022;
    gameplay.pitch -= event.movementY * 0.0018;
    gameplay.pitch = THREE.MathUtils.clamp(
        gameplay.pitch,
        -PLAYER_SETTINGS.maxLookPitch,
        PLAYER_SETTINGS.maxLookPitch
    );

    applyGameplayCameraRotation();
}

function handleShowcaseMouseButton(event) {
    if (gameplay.active) {
        if (event.type === 'mousedown') {
            const buttonName = event.button === 2 ? 'right' : event.button === 0 ? 'left' : null;
            if (buttonName) {
                runMouseAction(buttonName, event);
            }
        }
        return;
    }

    if (gameplay.active || gameplay.pointerLocked || !renderer) return;

    if (event.type === 'mousedown') {
        renderer.domElement.focus();
        if (event.button === 0 && objectScriptState.menuOpen) {
            closeObjectScriptMenu();
        }
        if (event.button !== 2) return;

        const propHit = getDynamicPropHitFromEvent(event);
        if (propHit?.prop) {
            showcase.looking = false;
            event.preventDefault();
            return;
        }

        showcase.looking = true;
        event.preventDefault();
        return;
    }

    if (event.button === 2) {
        showcase.looking = false;
    }
}

function handleShowcaseContextMenu(event) {
    if (gameplay.active || gameplay.pointerLocked || !renderer) {
        event.preventDefault();
        return;
    }

    const propHit = getDynamicPropHitFromEvent(event);
    if (propHit?.prop) {
        event.preventDefault();
        openObjectScriptMenu(event, propHit.prop);
        return;
    }

    event.preventDefault();
    closeObjectScriptMenu();
}

function handleShowcaseWheel(event) {
    if (gameplay.active || gameplay.pointerLocked) return;

    event.preventDefault();
    adjustShowcaseSpeed(event.deltaY < 0 ? 1 : -1);
}

function handlePointerLockChange() {
    const isLocked = document.pointerLockElement === renderer.domElement;

    if (isLocked) {
        gameplay.pointerLocked = true;
        gameplay.active = true;
        showcase.looking = false;
        closeObjectScriptMenu();
        closeObjectScriptEditor();
        updateWorldPresentation();
        updateGameplayUI();
        renderer.domElement.focus();
        return;
    }

    if (!gameplay.pointerLocked && !gameplay.active) return;

    gameplay.pointerLocked = false;
    gameplay.active = false;
    gameplay.velocity.set(0, 0, 0);
    physics.desiredVelocity.set(0, 0, 0);
    resetMovementInputState();

    updateWorldPresentation();
    resetShowcaseCamera(false);
    updateGameplayUI();
}

function enterGameplay() {
    if (!gameplay.canPlay) return;

    syncGameplaySpawnToCamera();
    respawnPlayer(true);
    gameplay.pointerLocked = false;
    gameplay.active = true;
    applyMouseActionScripts({ persist: true });
    showcase.looking = false;
    resetMobileInputState();
    updateWorldPresentation();
    updateGameplayUI();

    if (!mobileState.enabled) {
        renderer.domElement.requestPointerLock?.();
    }
}

function exitGameplay() {
    if (!mobileState.enabled && document.pointerLockElement === renderer.domElement) {
        document.exitPointerLock();
        return;
    }

    if (!gameplay.active && !gameplay.pointerLocked) return;

    gameplay.pointerLocked = false;
    gameplay.active = false;
    gameplay.velocity.set(0, 0, 0);
    physics.jumpQueued = false;
    physics.desiredVelocity.set(0, 0, 0);
    showcase.looking = false;
    showcase.velocity.set(0, 0, 0);
    showcase.input.forward = false;
    showcase.input.back = false;
    showcase.input.left = false;
    showcase.input.right = false;
    showcase.input.up = false;
    showcase.input.down = false;
    showcase.input.boost = false;
    resetMobileInputState();

    updateWorldPresentation();
    resetShowcaseCamera(false);
    updateGameplayUI();
}

function updateWorldPresentation() {
    if (pedestal) pedestal.visible = !gameplay.active;
    document.body.classList.toggle('play-ready', gameplay.canPlay);
    document.body.classList.toggle('play-active', gameplay.active);
}

function updateGameplayUI() {
    const hasAsset = !!currentMesh;
    const mobileActive = mobileState.enabled;

    if (resetViewBtn) {
        resetViewBtn.textContent = gameplay.active ? 'Respawn' : 'Reset View';
    }

    updateCameraModeButtons();

    if (gameplayStatus) {
        if (mobileActive && gameplay.active) {
            gameplayStatus.textContent = 'Mobile play active';
        } else if (mobileActive) {
            gameplayStatus.textContent = 'Mobile showcase ready';
        } else if (!hasAsset && gameplay.active) {
            gameplayStatus.textContent = gameplay.grounded ? 'Exploring terrain' : 'Airborne';
        } else if (!hasAsset) {
            gameplayStatus.textContent = `Showcase free-fly ready. Camera speed ${showcase.moveSpeed.toFixed(1)}x.`;
        } else if (gameplay.active) {
            gameplayStatus.textContent = gameplay.grounded ? 'Exploring scene' : 'Airborne';
        } else {
            gameplayStatus.textContent = `Scene ready. Showcase speed ${showcase.moveSpeed.toFixed(1)}x.`;
        }
    }

    if (playHint) {
        if (mobileActive && gameplay.active) {
            playHint.textContent = 'Touch left pad to move, right pad to look, tap the scene to run play scripts, and use Jump to hop.';
        } else if (mobileActive) {
            playHint.textContent = 'Touch left pad to move, right pad to look, double-tap a prop to open its script menu, and use Menu for assets.';
        } else if (!hasAsset && gameplay.active) {
            playHint.textContent = 'WASD move, mouse look, Space jump, Shift sprint, R respawn, Esc exit.';
        } else if (!hasAsset) {
            playHint.textContent = 'Showcase: hold right mouse to look, use WASD to move, Q/E for down/up, Shift to boost, and mouse wheel to change camera speed.';
        } else if (gameplay.active) {
            playHint.textContent = 'WASD move, mouse look, Space jump, Shift sprint, R respawn, Esc exit.';
        } else {
            playHint.textContent = 'Showcase: hold right mouse to look, use WASD to move, Q/E for down/up, Shift to boost, and mouse wheel to change camera speed. Play mode still uses pointer lock.';
        }
    }

    updateMobileButtons();
    updateMouseActionStatus();
    updateWorldPresentation();
}

function getShowcaseTarget() {
    if (!currentMesh) {
        return SHOWCASE_CAMERA_TARGET;
    }

    return tempVectorA.set(
        gameplayLookTarget.x,
        Math.max(1.25, gameplayBounds.max.y * 0.35),
        gameplayLookTarget.z
    );
}

function resetShowcaseCamera(animate = true) {
    if (gameplay.active) return;

    const target = getShowcaseTarget();
    const animatedLookTarget = {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
    };

    if (!animate) {
        camera.position.copy(SHOWCASE_CAMERA_POSITION);
        syncShowcaseAnglesFromTarget(target);
        applyShowcaseCameraRotation();
        showcase.velocity.set(0, 0, 0);
        return;
    }

    gsap.killTweensOf(camera.position);
    gsap.killTweensOf(animatedLookTarget);

    gsap.to(camera.position, {
        x: SHOWCASE_CAMERA_POSITION.x,
        y: SHOWCASE_CAMERA_POSITION.y,
        z: SHOWCASE_CAMERA_POSITION.z,
        duration: 0.9,
        overwrite: true,
        onUpdate: () => {
            syncShowcaseAnglesFromTarget(tempVectorB.set(animatedLookTarget.x, animatedLookTarget.y, animatedLookTarget.z));
            applyShowcaseCameraRotation();
        },
    });

    gsap.to(animatedLookTarget, {
        x: target.x,
        y: target.y,
        z: target.z,
        duration: 0.9,
        overwrite: true,
        onUpdate: () => {
            syncShowcaseAnglesFromTarget(tempVectorB.set(animatedLookTarget.x, animatedLookTarget.y, animatedLookTarget.z));
            applyShowcaseCameraRotation();
        },
    });
}

function updateShowcaseCamera(delta) {
    const moveRight = (showcase.input.right ? 1 : 0) - (showcase.input.left ? 1 : 0);
    const moveForward = (showcase.input.forward ? 1 : 0) - (showcase.input.back ? 1 : 0);
    const moveVertical = (showcase.input.up ? 1 : 0) - (showcase.input.down ? 1 : 0);

    tempVectorA.set(0, 0, 0);
    camera.getWorldDirection(tempVectorB);

    if (tempVectorB.lengthSq() < 1e-6) {
        tempVectorB.set(0, 0, -1);
    } else {
        tempVectorB.normalize();
    }

    tempVectorC.crossVectors(tempVectorB, upVector).normalize();

    tempVectorA
        .addScaledVector(tempVectorC, moveRight)
        .addScaledVector(tempVectorB, moveForward)
        .addScaledVector(upVector, moveVertical);

    if (tempVectorA.lengthSq() > 0) {
        tempVectorA.normalize();
    }

    const moveSpeed = showcase.moveSpeed * (showcase.input.boost ? showcase.boostMultiplier : 1);
    showcase.velocity.lerp(tempVectorA.multiplyScalar(moveSpeed), tempVectorA.lengthSq() > 0 ? 0.35 : 0.18);

    if (showcase.velocity.lengthSq() < 1e-5) {
        showcase.velocity.set(0, 0, 0);
        return;
    }

    camera.position.addScaledVector(showcase.velocity, delta);
}

function respawnPlayer(useStoredView = false) {
    if (!gameplay.canPlay) return;

    if (!physics.character) {
        ensurePlayerCharacter();
    }

    if (!physics.character) return;

    const spawnPosition = new physics.Jolt.RVec3(
        gameplay.spawnPoint.x,
        gameplay.spawnPoint.y,
        gameplay.spawnPoint.z
    );
    physics.character.SetPosition(spawnPosition);
    physics.Jolt.destroy(spawnPosition);
    physics.character.SetLinearVelocity(physics.Jolt.Vec3.prototype.sZero());
    gameplay.velocity.set(0, 0, 0);
    gameplay.grounded = true;

    if (useStoredView) {
        gameplay.yaw = gameplay.spawnYaw;
        gameplay.pitch = gameplay.spawnPitch;
    }

    syncCameraToCharacter();

    if (!useStoredView) {
        tempVectorA.copy(gameplayLookTarget).sub(camera.position);
        const flatDistance = Math.max(0.001, Math.hypot(tempVectorA.x, tempVectorA.z));
        gameplay.yaw = Math.atan2(tempVectorA.x, tempVectorA.z);
        gameplay.pitch = THREE.MathUtils.clamp(
            Math.atan2(-tempVectorA.y, flatDistance),
            -PLAYER_SETTINGS.maxLookPitch,
            PLAYER_SETTINGS.maxLookPitch
        );
        gameplay.spawnYaw = gameplay.yaw;
        gameplay.spawnPitch = gameplay.pitch;
    }

    applyGameplayCameraRotation();
    updateGameplayUI();
}

function applyGameplayCameraRotation() {
    camera.rotation.order = 'YXZ';
    camera.rotation.x = gameplay.pitch;
    camera.rotation.y = gameplay.yaw;
    camera.rotation.z = 0;
}

function getGroundHitAt(x, z, includeFloor = true) {
    const originY = Math.max(PLAYER_SETTINGS.probeHeight, gameplayBounds.max.y + PLAYER_SETTINGS.probeHeight);
    const hits = [];

    raycaster.set(tempVectorA.set(x, originY, z), downVector);

    if (currentMesh) {
        hits.push(...raycaster.intersectObject(currentMesh, true));
    }

    if (includeFloor && worldFloor) {
        const terrainHeight = sampleTerrainHeightAt(x, z);
        if (terrainHeight !== null && originY >= terrainHeight) {
            hits.push({
                distance: originY - terrainHeight,
                point: tempVectorB.set(x, terrainHeight, z).clone(),
                object: worldFloor,
            });
        }
    }

    hits.sort((a, b) => a.distance - b.distance);
    return hits[0] || null;
}

function getGroundHeightAt(x, z, includeFloor = true) {
    const hit = getGroundHitAt(x, z, includeFloor);
    return hit ? hit.point.y : null;
}

function resolveHorizontalMovement(origin, movementDelta) {
    if (!currentMesh || movementDelta.lengthSq() === 0) {
        return movementDelta;
    }

    const adjustedMovement = movementDelta.clone();
    const direction = tempVectorA.copy(movementDelta).normalize();
    const probeHeights = [PLAYER_SETTINGS.eyeHeight * 0.35, PLAYER_SETTINGS.eyeHeight * 0.75];

    for (const probeHeight of probeHeights) {
        const rayOrigin = tempVectorB.copy(origin);
        rayOrigin.y += probeHeight - PLAYER_SETTINGS.eyeHeight;

        raycaster.set(rayOrigin, direction);

        const hit = raycaster.intersectObject(currentMesh, true).find(entry => (
            entry.distance <= movementDelta.length() + PLAYER_SETTINGS.collisionRadius
        ));

        if (!hit || !hit.face) continue;

        const wallNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        if (wallNormal.y > 0.6) continue;

        adjustedMovement.projectOnPlane(wallNormal);
        adjustedMovement.addScaledVector(wallNormal, PLAYER_SETTINGS.wallClearance);
    }

    return adjustedMovement;
}

function updateGameplay(delta) {
    if (!physics.character) return;

    const moveRight = (gameplay.input.right ? 1 : 0) - (gameplay.input.left ? 1 : 0);
    const moveForward = (gameplay.input.forward ? 1 : 0) - (gameplay.input.back ? 1 : 0);
    const moveSpeed = gameplay.input.sprint ? PLAYER_SETTINGS.sprintSpeed : PLAYER_SETTINGS.walkSpeed;
    const wasGrounded = gameplay.grounded;

    tempVectorA.set(0, 0, 0);
    if (moveRight !== 0 || moveForward !== 0) {
        camera.getWorldDirection(tempVectorB);
        tempVectorB.y = 0;

        if (tempVectorB.lengthSq() < 1e-6) {
            tempVectorB.set(0, 0, -1);
        } else {
            tempVectorB.normalize();
        }

        tempVectorC.crossVectors(tempVectorB, upVector).normalize();

        tempVectorA
            .addScaledVector(tempVectorC, moveRight)
            .addScaledVector(tempVectorB, moveForward);

        if (tempVectorA.lengthSq() > 0) {
            tempVectorA.normalize().multiplyScalar(moveSpeed);
        }
    }

    const desiredMovement = tempVectorE.copy(tempVectorA);

    physics.character.UpdateGroundVelocity();

    const linearVelocity = copyJoltVector(tempVectorB, physics.character.GetLinearVelocity());
    const currentVerticalVelocity = tempVectorC.copy(upVector).multiplyScalar(linearVelocity.dot(upVector));
    const currentHorizontalVelocity = tempVectorD.copy(linearVelocity).sub(currentVerticalVelocity);
    const groundVelocity = copyJoltVector(tempVectorA, physics.character.GetGroundVelocity());

    const onGround = physics.character.IsSupported();
    const movingTowardsGround = currentVerticalVelocity.y - groundVelocity.y <= 0.1;
    physics.allowSliding = desiredMovement.lengthSq() > 1e-8;

    let nextVelocity;
    if (onGround && movingTowardsGround) {
        nextVelocity = groundVelocity.clone();
        if (physics.jumpQueued) {
            nextVelocity.y += PLAYER_SETTINGS.jumpSpeed;
        }
    } else {
        nextVelocity = currentVerticalVelocity.clone();
    }

    nextVelocity.addScaledVector(copyJoltVector(tempVectorC, physics.gravity), delta);

    if (physics.allowSliding) {
        physics.desiredVelocity.lerp(desiredMovement, onGround ? 0.32 : 0.12);
        nextVelocity.add(physics.desiredVelocity);
    } else if (!onGround) {
        nextVelocity.add(currentHorizontalVelocity);
        physics.desiredVelocity.multiplyScalar(0.92);
    } else {
        physics.desiredVelocity.multiplyScalar(0.2);
    }

    const nextVelocityJolt = new physics.Jolt.Vec3(nextVelocity.x, nextVelocity.y, nextVelocity.z);
    physics.character.SetLinearVelocity(nextVelocityJolt);
    physics.Jolt.destroy(nextVelocityJolt);
    physics.character.ExtendedUpdate(
        delta,
        physics.gravity,
        physics.updateSettings,
        physics.movingBroadPhaseFilter,
        physics.movingLayerFilter,
        physics.bodyFilter,
        physics.shapeFilter,
        physics.jolt.GetTempAllocator()
    );

    syncCameraToCharacter();
    applyGameplayCameraRotation();
    gameplay.grounded = physics.character.IsSupported();
    physics.jumpQueued = false;

    const characterPosition = copyJoltVector(tempVectorA, physics.character.GetPosition());
    if (characterPosition.y < worldFloor.position.y - 24) {
        respawnPlayer();
    }

    if (wasGrounded !== gameplay.grounded) {
        updateGameplayUI();
    }
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

async function loadModel(file, fileMap = {}) {
    try {
        const root = await loadObjectFromFile(file, fileMap);
        clearCurrentMesh();
        currentMesh = root;
        scene.add(currentMesh);
        normalizeCurrentMesh();
        refreshGameplayWorld();
        updateLoadedAssetStats(file.name, file.size, currentMesh);
    } catch (error) {
        console.error('Failed to load model.', error);
        alert(error?.message === 'Unsupported file format'
            ? 'Unsupported file format'
            : 'Failed to load the selected model. Check the console for details.');
    }
}

// --- Optimization Pipeline ---
async function runOptimizationPipeline() {
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
    if (!currentMesh) return;
    currentMesh.traverse(child => {
        if (child.isMesh) child.material.wireframe = !child.material.wireframe;
    });
});

document.getElementById('reset-view').addEventListener('click', () => {
    if (gameplay.active) {
        respawnPlayer();
        return;
    }

    resetShowcaseCamera(true);
});

init();
