// Drug Tycoon game mode — a self-contained "Schedule I"-style loop bolted onto
// its own level (sampleType 'drugTycoon'). Fully isolated like rogueWaves:
// runtime.js calls createDrugTycoon({...deps}) once and the frame loop calls
// the returned updateDrugTycoonState(playerPos, delta) every frame.
//
// Core loop (full tycoon vertical slice):
//   1. COOK   — stand on the cook station, hold E to brew a batch of product
//               (takes time; yield + speed scale with upgrades).
//   2. SELL   — carry product, walk up to a wandering NPC buyer, press E to
//               sell. Cash in, but each sale adds HEAT.
//   3. HEAT   — rises with sales, decays slowly. Over a threshold the police
//               start hunting; getting caught fines you and dumps your stash.
//   4. UPGRADE— stand on the upgrade pad, press E to open the shop and spend
//               cash on bigger batches, faster cooks, more buyers, less heat.
//
// All UI is plain DOM overlays (.tycoon-overlay) layered over the canvas, same
// approach as the rogue HUD. State lives on window.drugTycoon so it survives
// hot edits and can be inspected from the console.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { core } from '../runtime/appCore.js';
import { tickPlaytime } from './playtime.js';
import { unlockAward, AWARD_CATALOG } from './awards.js';
import * as ragdoll from './ragdoll.js';
import { DDGIMeshStandardNodeMaterial } from '../world/gi/DDGIMeshStandardNodeMaterial.js';
import { convertLoadedObjectMaterials } from '../io/objectLoader.js';
import { createMapStreaming, buildTrafficCarMesh } from './mapStreaming.js';

const WEED_GLB_URL = (import.meta.env?.BASE_URL || '/') + 'Weed.glb';
const WALKING_FBX_URL = (import.meta.env?.BASE_URL || '/') + 'models/Emmy/Walking.fbx';
const MAN_FBX_URL = (import.meta.env?.BASE_URL || '/') + 'models/Man/Man.fbx';
const WALKING_TEXTURE_BASE_URL = (import.meta.env?.BASE_URL || '/') + 'models/Emmy/';
const WEED_GLB_HEIGHT = 0.47;       // raw GLB plant height in metres
const WEED_TARGET_MAX_HEIGHT = 1.2; // mature in-game plant height in metres
const WEED_BASE_SCALE = WEED_TARGET_MAX_HEIGHT / WEED_GLB_HEIGHT;
const WALKING_BUYER_HEIGHT = 1.82;
const WALKING_BUYER_Y_OFFSET = -0.9;
const WALKING_BUYER_BASE_TINT = new THREE.Color('#000000');
let _weedPrototype = null;          // first instance, cloned for every plant
let _weedPromise = null;
let _walkingBuyerPrototype = null;
let _walkingBuyerPromise = null;
let _manBuyerPrototype = null;
let _manBuyerPromise = null;
let _walkingTextureSets = null;
const WALKING_BUYER_FBX_WARNING_PREFIXES = [
    'THREE.FBXLoader: SpecularFactor map is not supported in three.js, skipping texture.',
    'THREE.FBXLoader: ShininessExponent map is not supported in three.js, skipping texture.',
    'THREE.FBXLoader: Vertex has more than 4 skinning weights assigned to vertex. Deleting additional weights.',
];

function suppressWalkingBuyerFbxWarnings() {
    const originalWarn = console.warn;
    const filteredWarn = (...args) => {
        const message = typeof args?.[0] === 'string' ? args[0] : '';
        if (WALKING_BUYER_FBX_WARNING_PREFIXES.some((prefix) => message.startsWith(prefix))) return;
        originalWarn.apply(console, args);
    };
    console.warn = filteredWarn;
    let restored = false;
    return () => {
        if (restored) return;
        restored = true;
        if (console.warn === filteredWarn) console.warn = originalWarn;
    };
}

function loadWeedPrototype() {
    if (_weedPrototype) return Promise.resolve(_weedPrototype);
    if (_weedPromise) return _weedPromise;
    _weedPromise = new Promise((resolve) => {
        new GLTFLoader().load(
            WEED_GLB_URL,
            (gltf) => {
                // Use the GLB scene graph directly as the prototype. Convert
                // every mesh's GLTF MeshStandardMaterial → DDGI node material
                // (one ddgi-mat per source-mat, shared) so the plant joins the
                // WebGPU node-material pipeline (SSR + DDGI) the rest of the
                // level uses.
                const matCache = new Map();
                const proto = gltf.scene;
                proto.traverse((o) => {
                    if (!o.isMesh) return;
                    o.castShadow = true;
                    o.receiveShadow = true;
                    const src = o.material;
                    let ddgi = matCache.get(src);
                    if (!ddgi) {
                        ddgi = new DDGIMeshStandardNodeMaterial({
                            color: src.color ? src.color.clone() : new THREE.Color('#3aa852'),
                            roughness: src.roughness ?? 0.5,
                            metalness: src.metalness ?? 0.0,
                        });
                        if (src.map) ddgi.map = src.map;
                        if (src.normalMap) ddgi.normalMap = src.normalMap;
                        if (src.emissive) ddgi.emissive = src.emissive.clone();
                        ddgi.emissiveIntensity = src.emissiveIntensity ?? 0;
                        ddgi.side = THREE.DoubleSide;
                        matCache.set(src, ddgi);
                    }
                    o.material = ddgi;
                });
                _weedPrototype = proto;
                resolve(proto);
            },
            undefined,
            (err) => {
                console.warn('[drugTycoon] Weed.glb load failed', err);
                _weedPrototype = new THREE.Group();
                resolve(_weedPrototype);
            },
        );
    });
    return _weedPromise;
}
// Kick off load at module init so the first plant has it ready.
loadWeedPrototype();

function loadWalkingTextureSets() {
    if (_walkingTextureSets) return _walkingTextureSets;
    const loader = new THREE.TextureLoader();
    const loadTex = (name, { color = false } = {}) => {
        const tex = loader.load(WALKING_TEXTURE_BASE_URL + name);
        tex.name = name;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        return tex;
    };
    _walkingTextureSets = [0, 1].map((idx) => ({
        map: loadTex(`diffuse_packed${idx}.png`, { color: true }),
        normalMap: loadTex(`normal_packed${idx}.png`),
    }));
    return _walkingTextureSets;
}

function applyWalkingTextureSet(material, textureIndex = 0) {
    if (!material) return material;
    const textureSets = loadWalkingTextureSets();
    const textureSet = textureSets[Math.min(textureSets.length - 1, Math.max(0, textureIndex))] || null;
    if (material.color) material.color.set(0xffffff);
    if (textureSet?.map) {
        material.map = textureSet.map;
        material.map.colorSpace = THREE.SRGBColorSpace;
    }
    if (textureSet?.normalMap) {
        material.normalMap = textureSet.normalMap;
        material.normalMap.colorSpace = THREE.NoColorSpace;
    }
    material.roughness = 1.0;
    material.metalness = 0.0;
    // Neutralize any emissive carried in from the source FBX (Man.fbx ships
    // bright emissive maps that otherwise blow out bloom across the frame).
    if ('emissiveMap' in material) material.emissiveMap = null;
    if (material.emissive) material.emissive.set(0x000000);
    material.emissiveIntensity = 0;
    if ('envMapIntensity' in material) material.envMapIntensity = 0;
    material.needsUpdate = true;
    return material;
}

// Load an FBX humanoid as a buyer prototype and apply Emmy's texture/material
// sets (diffuse + normal packed maps) to every mesh so it joins the same
// node-material pipeline as the Walking (Emmy) buyer. Used for both Emmy's
// Walking.fbx and Man.fbx.
function neutralizeFbxEmissive(material) {
    // Keep the FBX's own diffuse/normal maps but kill any emissive it shipped
    // (Man.fbx carries bright emissive maps that otherwise blow out bloom).
    if (!material) return material;
    if ('emissiveMap' in material) material.emissiveMap = null;
    if (material.emissive) material.emissive.set(0x000000);
    material.emissiveIntensity = 0;
    if ('envMapIntensity' in material) material.envMapIntensity = 0;
    material.needsUpdate = true;
    return material;
}

function loadFbxBuyerPrototype(url, label, { applyEmmyTextures = true } = {}) {
    return new Promise((resolve) => {
        const restoreWarn = suppressWalkingBuyerFbxWarnings();
        new FBXLoader().load(
            url,
            (fbx) => {
                restoreWarn();
                // FBX files (Man.fbx in particular) can ship embedded lights and
                // cameras in the node tree. Cloned into the scene they flood the
                // frame — strip everything that isn't a mesh/bone/group.
                const toRemove = [];
                fbx.traverse((o) => {
                    if (o.isLight || o.isCamera) toRemove.push(o);
                });
                for (const o of toRemove) o.parent?.remove(o);
                convertLoadedObjectMaterials(fbx);
                const processMat = applyEmmyTextures
                    ? (m, index) => applyWalkingTextureSet(m, index)
                    : (m) => neutralizeFbxEmissive(m);
                fbx.traverse((o) => {
                    if (!o.isMesh) return;
                    o.castShadow = true;
                    o.receiveShadow = true;
                    o.material = Array.isArray(o.material)
                        ? o.material.map((m, index) => processMat(m, index))
                        : processMat(o.material, 0);
                });
                const box = new THREE.Box3().setFromObject(fbx);
                const size = box.getSize(new THREE.Vector3());
                const center = box.getCenter(new THREE.Vector3());
                resolve({
                    root: fbx,
                    clips: fbx.animations || [],
                    box: box.clone(),
                    size: size.clone(),
                    center,
                });
            },
            undefined,
            (err) => {
                restoreWarn();
                console.warn(`[drugTycoon] ${label} load failed`, err);
                resolve({ root: null, clips: [], box: new THREE.Box3(), size: new THREE.Vector3(), center: new THREE.Vector3() });
            },
        );
    });
}

function loadWalkingBuyerPrototype() {
    if (_walkingBuyerPrototype) return Promise.resolve(_walkingBuyerPrototype);
    if (_walkingBuyerPromise) return _walkingBuyerPromise;
    _walkingBuyerPromise = loadFbxBuyerPrototype(WALKING_FBX_URL, 'models/Emmy/Walking.fbx')
        .then((proto) => { _walkingBuyerPrototype = proto; return proto; });
    return _walkingBuyerPromise;
}
loadWalkingBuyerPrototype();

function loadManBuyerPrototype() {
    if (_manBuyerPrototype) return Promise.resolve(_manBuyerPrototype);
    if (_manBuyerPromise) return _manBuyerPromise;
    _manBuyerPromise = loadFbxBuyerPrototype(MAN_FBX_URL, 'models/Man/Man.fbx', { applyEmmyTextures: false })
        .then((proto) => { _manBuyerPrototype = proto; return proto; });
    return _manBuyerPromise;
}
loadManBuyerPrototype();
// Pre-build the FBX buyer pool at module load so spawning is instant.
prewarmFbxBuyerPool();

function setProxyPersonVisible(group, visible) {
    const parts = group?.userData?.parts;
    if (!parts?.length) return;
    for (const part of parts) {
        if (!part) continue;
        part.visible = visible;
        part.castShadow = visible;
        part.receiveShadow = visible;
    }
}

function makeWalkingBuyerBlackMaterial(side = THREE.FrontSide, color = WALKING_BUYER_BASE_TINT) {
    const mat = new DDGIMeshStandardNodeMaterial({
        color: new THREE.Color(color),
        roughness: 1.0,
        metalness: 0.0,
    });
    if (mat.emissive) mat.emissive.set(0x000000);
    mat.emissiveIntensity = 0;
    if ('envMapIntensity' in mat) mat.envMapIntensity = 0;
    mat.side = side;
    return mat;
}

function cloneWalkingBuyerMaterials(model, {
    bodyTint = null,
} = {}) {
    const tint = bodyTint ? new THREE.Color(bodyTint) : null;
    model.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const cloneMat = (src) => {
            const mat = src?.clone?.() || makeWalkingBuyerBlackMaterial(src?.side ?? THREE.FrontSide);
            if (tint && mat.color) mat.color.copy(tint);
            mat.roughness = 1.0;
            mat.metalness = 0.0;
            if (mat.emissiveMap) mat.emissiveMap = null;
            if (mat.emissive) mat.emissive.set(0x000000);
            mat.emissiveIntensity = 0;
            if ('envMapIntensity' in mat) mat.envMapIntensity = 0;
            mat.side = src?.side ?? THREE.FrontSide;
            return mat;
        };
        o.material = Array.isArray(o.material)
            ? o.material.map((src) => cloneMat(src))
            : cloneMat(o.material);
    });
}

function addBuyerColorBadge(group, badgeColor) {
    const mat = makeWalkingBuyerBlackMaterial();
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), mat);
    marker.name = 'buyer-shirt-color-marker';
    marker.position.set(0, 2.1, 1);
    marker.castShadow = true;
    marker.receiveShadow = true;
    group.add(marker);
}

function makeWalkingBuyerMesh({ skinColor = '#e8b893', shirtColor = '#3da6ff', pantsColor = '#22303c', bodyTint = null, showColorBadge = true, badgeColor = shirtColor, proto = _walkingBuyerPrototype, extraYOffset = 0 } = {}) {
    if (!proto?.root || proto.size.y <= 0) return null;

    const group = new THREE.Group();
    group.userData.isWalkingFbxBuyer = true;
    const model = cloneSkeleton(proto.root);
    model.name = 'walking-fbx-buyer-model';
    model.position.set(-proto.center.x, -proto.box.min.y, -proto.center.z);
    cloneWalkingBuyerMaterials(model, { skinColor, shirtColor, pantsColor, bodyTint });
    model.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        // Let three.js skip off-screen buyers on the CPU. Skinned meshes cull
        // against their bind-pose bounds, so pad the bounding sphere a little
        // so a walking buyer isn't popped at the frustum edge mid-stride.
        o.frustumCulled = true;
        if (o.isSkinnedMesh && o.geometry) {
            if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
            if (o.geometry.boundingSphere) o.geometry.boundingSphere.radius *= 1.5;
        }
    });

    const fit = new THREE.Group();
    fit.name = 'walking-fbx-buyer-fit';
    fit.scale.setScalar(WALKING_BUYER_HEIGHT / proto.size.y);
    fit.position.y = WALKING_BUYER_Y_OFFSET + extraYOffset;
    fit.add(model);
    group.add(fit);
    if (showColorBadge) addBuyerColorBadge(group, badgeColor);

    if (proto.clips.length) {
        const mixer = new THREE.AnimationMixer(model);
        const action = mixer.clipAction(proto.clips[0]);
        action.play();
        group.userData.walkingMixer = mixer;
        group.userData.walkingAction = action;
    }
    return group;
}

// ---- FBX buyer visual pool ------------------------------------------------
// Cloning a rigged FBX (skeleton + materials + animation mixer) is expensive,
// so we pre-build a fixed pool of ready visual groups per variant at startup
// and lend them out to buyers. Borrowed visuals return to the pool on despawn
// instead of being discarded, so no FBX cloning happens during gameplay.
// Mobile GPUs choke on many rigged/skinned draws and the big FBX VRAM
// footprint, so we run a smaller buyer pool and a tighter distance LOD there.
const IS_MOBILE_BUYER = (() => {
    try {
        if (typeof navigator !== 'undefined'
            && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '')) return true;
        if (typeof window !== 'undefined' && window.matchMedia?.('(pointer:coarse)')?.matches) return true;
    } catch (e) {}
    return false;
})();
// Beyond this distance from the camera the expensive FBX visual is hidden and
// the cheap box-ragdoll rig underneath shows instead. Tighter on mobile.
const FBX_BUYER_LOD_DISTANCE = IS_MOBILE_BUYER ? 22 : 45;
const FBX_BUYER_POOL_SIZE = IS_MOBILE_BUYER ? { emmy: 2, man: 2 } : { emmy: 4, man: 4 };
const _fbxBuyerPool = { emmy: [], man: [] };
let _fbxBuyerPoolReady = false;

function buildOneFbxBuyerVisual(variant) {
    const isMan = variant === 'man';
    const proto = isMan ? _manBuyerPrototype : _walkingBuyerPrototype;
    const extraYOffset = isMan ? WALKING_BUYER_HEIGHT / 2 : 0;
    const visual = makeWalkingBuyerMesh({ showColorBadge: false, proto, extraYOffset });
    if (visual) visual.userData.fbxBuyerVariant = variant;
    return visual;
}

function prewarmFbxBuyerPool() {
    if (_fbxBuyerPoolReady) return Promise.resolve();
    return Promise.all([loadWalkingBuyerPrototype(), loadManBuyerPrototype()]).then(() => {
        for (const variant of ['emmy', 'man']) {
            const count = FBX_BUYER_POOL_SIZE[variant] || 0;
            for (let i = _fbxBuyerPool[variant].length; i < count; i++) {
                const visual = buildOneFbxBuyerVisual(variant);
                if (visual) _fbxBuyerPool[variant].push(visual);
            }
        }
        _fbxBuyerPoolReady = true;
    });
}

function acquireFbxBuyerVisual(variant) {
    const pool = _fbxBuyerPool[variant];
    if (pool && pool.length) return pool.pop();
    // Pool exhausted (more concurrent FBX buyers than pre-warmed) — build one
    // on demand so gameplay still works; it returns to the pool when freed.
    return buildOneFbxBuyerVisual(variant);
}

function releaseFbxBuyerVisual(group) {
    const visual = group?.userData?.walkingVisual;
    const variant = visual?.userData?.fbxBuyerVariant;
    if (!visual || !variant || !_fbxBuyerPool[variant]) return;
    if (visual.parent) visual.parent.remove(visual);
    const action = visual.userData.walkingAction;
    if (action) { action.paused = false; action.stop?.(); }
    visual.visible = true;
    group.userData.walkingVisualAttached = false;
    group.userData.walkingVisual = null;
    group.userData.walkingMixer = null;
    group.userData.walkingAction = null;
    group.userData.walkingLodFar = undefined;
    _fbxBuyerPool[variant].push(visual);
}

// Distance LOD: near the camera show the hi-detail FBX visual; far away hide
// it and reveal the cheap box-ragdoll rig underneath. Far buyers then cost
// almost nothing (and their walk mixer can stop) — the big mobile win.
function setBuyerLodFar(group, far) {
    if (!group?.userData?.walkingVisualAttached) return;
    const wantFbx = !far;
    if (group.userData.walkingLodFar === far) return;
    group.userData.walkingLodFar = far;
    const visual = group.userData.walkingVisual;
    if (visual) visual.visible = wantFbx;
    setProxyPersonVisible(group, far);
    // Pause the animation mixer for far buyers so we don't pay skinning cost
    // for something that's only a box.
    const action = group.userData.walkingAction;
    if (action) { if (wantFbx) action.paused = false; else action.paused = true; }
}

function attachWalkingBuyerVisual(group, variant = 'emmy') {
    if (!group || group.userData?.walkingVisualAttached) return !!group?.userData?.walkingVisualAttached;
    const visual = acquireFbxBuyerVisual(variant);
    if (!visual) return false;
    // Restart the looping walk so a recycled visual isn't frozen mid-pose.
    visual.userData.walkingAction?.reset?.().play?.();
    group.add(visual);
    group.userData.isWalkingFbxBuyer = true;
    group.userData.walkingVisualAttached = true;
    group.userData.walkingVisual = visual;
    group.userData.walkingMixer = visual.userData?.walkingMixer || null;
    group.userData.walkingAction = visual.userData?.walkingAction || null;
    group.userData.walkingLodFar = false; // start near; tick re-evaluates by distance
    setProxyPersonVisible(group, false);
    return true;
}

function makeTycoonPersonMesh({
    skinColor = '#e8b893',
    shirtColor = '#3da6ff',
    pantsColor = '#22303c',
    bodyTint = null,
    showColorBadge = false,
    badgeColor = shirtColor,
    useWalkingVisual = false,
    visualVariant = 'emmy',
} = {}) {
    const group = ragdoll.makePerson({ skinColor, shirtColor, pantsColor });
    if (!useWalkingVisual) return group;
    const variant = visualVariant === 'man' ? 'man' : 'emmy';
    if (!attachWalkingBuyerVisual(group, variant)) {
        // Pool not warm yet — build it, then attach from the pool.
        prewarmFbxBuyerPool().then(() => {
            if (group.userData?.walkingVisualAttached) return;
            attachWalkingBuyerVisual(group, variant);
        });
    }
    return group;
}

const SELL_RADIUS = 2.6;
const STATION_RADIUS = 2.4;
const COOK_TIME_MS = 4000;        // base brew time per batch
const COOK_YIELD = 5;             // base units per batch
const STASH_CAP = 40;             // base carry capacity
const SELL_PRICE = 35;            // base cash per unit
const SELL_HEAT = 6;              // heat added per sale
const HEAT_DECAY_PER_SEC = 1.2;   // passive heat cooldown
const HEAT_BUST_THRESHOLD = 100;  // police actively hunt at/above this
const BUST_RADIUS = 2.2;          // police catch distance
const BUST_FINE = 250;            // cash lost when busted
const NPC_WANDER_SPEED = 1.6;
const POLICE_SPEED = 3.2;
const PATROL_SPEED = 2.0;          // night cops on patrol (slower than a chase)
// ---- armed cops ----------------------------------------------------------
// At higher wanted levels cops draw weapons and fire at the player from a
// distance (non-lethal — health is floored like a bust). A tazer comes out at
// 3 stars (short range, low damage, briefly slows you); a sidearm at 4+ stars
// (longer range, more damage). Cops only fire when roughly facing the player
// within range, on a per-cop cooldown.
const COP_TAZER_STAR = 3;          // cops start carrying tazers at this star level
const COP_GUN_STAR = 4;            // cops upgrade to sidearms at this star level
const COP_TAZER_RANGE = 9;         // tazer firing distance
const COP_TAZER_DAMAGE = 0.12;     // player health lost per tazer hit
const COP_TAZER_COOLDOWN_MS = 2200;
const COP_GUN_RANGE = 22;          // sidearm firing distance
const COP_GUN_DAMAGE = 0.2;        // player health lost per bullet
const COP_GUN_COOLDOWN_MS = 1500;
const COP_FIRE_MIN_RANGE = 2.6;    // don't shoot point-blank — bust instead
const COP_HEALTH_FLOOR = 0.2;      // cop fire never drops player below this
// Day/night cycle. timeOfDay runs 0..1 over DAY_LENGTH_SEC. Night is the
// window [NIGHT_START, NIGHT_END) (wrapping past 1.0 back to 0).
const DAY_LENGTH_SEC = 180;        // one full day-night cycle
const NIGHT_START = 0.625;         // 21:00 — patrols out + darkness
const NIGHT_END = 0.04;            // dawn (wraps: 0.625..1.0 and 0.0..0.04)
const PATROL_COP_COUNT = 3;        // night patrol size
const PATROL_SPOT_RADIUS = 7;      // a patrol cop spots the player within this
const SIREN_RANGE = 26;            // cops audible within this distance
const SIREN_MAX_GAIN = 0.07;       // loudest siren volume (point-blank)
// Buyer one-liners on a sale.
const SELL_THANKS = [
    'Thanks!', 'Pleasure doin\' business', 'Good lookin\' out', 'Right on',
    'You\'re a lifesaver', 'See you next time', 'Appreciate it', 'Solid',
];
const GUN_FIRE_COOLDOWN_MS = 280;  // pistol cadence
const GUN_RANGE = 60;              // max shoot distance
const GUN_AIM_DOT = 0.985;        // aim cone tightness (cos angle)
const GUN_IMPULSE = 9;            // ragdoll shove strength
const BAT_RANGE = 3.0;            // melee reach
const BAT_COOLDOWN_MS = 480;      // swing cadence
const BAT_IMPULSE = 11;           // bat knockback (heftier than a bullet)
// Weapon shop prices.
const GUN_PRICE = 400;
const AMMO_PRICE = 60;            // per pack
const AMMO_PER_PACK = 12;
const BAT_PRICE = 180;
const DOOR_RADIUS = 2.6;          // enter/exit door interaction distance
const STARTING_CASH = 300;
const STARTING_CASH_GRANT = STARTING_CASH;
// Cannabis lifecycle is modelled as one CONTINUOUS progress 0..1 over
// PLANT_GROW_TOTAL_MS, split into realistic phases (germination → seedling →
// vegetative → flowering → ripe). PLANT_STAGES is kept for save-compat and the
// HUD ("stage N/3") but growth itself is smooth, not stepped.
const PLANT_GROW_TOTAL_MS = 90000;  // seed→ripe (was 3×22s ≈ 66s; a touch longer)
const PLANT_STAGES = 3;             // legacy stage count (HUD only)
// Phase boundaries along progress 0..1.
const PH_GERM = 0.10;   // dirt → first sprout breaks soil
const PH_SEED = 0.22;   // cotyledons + first true leaves
const SPROUT_HIDE_PROGRESS = 0.20; // cotyledon sprout disappears here
const PH_VEG = 0.58;    // bushes out, full green canopy, pre-flower
const PH_FLOWER = 0.92;  // buds form + swell
// (PH_FLOWER..1.0 = ripening: amber, resin glint, ready to harvest)
const BUDS_PER_PLANT = 4;         // loose buds yielded per ripe plant
const DRY_OUT_MS = 45000;          // an un-watered seed dies (wilts) after this
// ---- seed shop (outside) -------------------------------------------------
// Seeds are bought at the outdoor seed shop, NOT free. Three tiers, each
// strictly better than the last: faster grow, more buds, higher base quality.
// You plant from your current stock of the selected tier; an empty pot needs a
// seed in inventory. plant.tier (0..2) is stamped at plant time and drives the
// grow rate + harvest yield/quality.
// Each tier also carries a `palette` — leaf/bud/bud-ripe base colours used by
// applyPlantGrowth so Reggie grows green, Kush grows icy-teal, Exotic grows
// purple. Existing ripening + sick/droop tints layer on top of these bases.
// Note: bonus portions ABOVE the 1.0 baseline are doubled vs the original
// rollout — Kush speed went from +0.25 → +0.50, Exotic +0.55 → +1.10, etc.
// Reggie stays at the 1.0 baseline (it IS the baseline). qBonus is a pure
// bonus so it doubles directly.
const SEED_TIERS = [
    {
        key: 'reggie',  t: 'Reggie Seeds',  d: 'Cheap bag seed. Slow, scrappy yield.',
        cost: 40,  speed: 1.00, yieldMult: 1.00, qBonus: 0.00, color: '#9bdc7a',
        palette: { leaf: '#245f2d', leafRipe: '#4e7f35', bud: '#2f6d32', budRipe: '#6f7a32', stem: '#2d5d24' },
    },
    {
        key: 'kush',    t: 'Kush Seeds',    d: 'Solid genetics. 1.5× speed, fatter buds.',
        cost: 120, speed: 1.50, yieldMult: 1.60, qBonus: 0.24, color: '#7fd0ff',
        palette: { leaf: '#1f5a4a', leafRipe: '#3aa67a', bud: '#2f8a5a', budRipe: '#6fc890', stem: '#22513f' },
    },
    {
        key: 'exotic',  t: 'Exotic Seeds',  d: 'Top-shelf strain. 2.1× speed, huge yield.',
        cost: 300, speed: 2.10, yieldMult: 2.30, qBonus: 0.50, color: '#e6a8ff',
        palette: { leaf: '#3a2050', leafRipe: '#7a3aa6', bud: '#8a3ac8', budRipe: '#c870ff', stem: '#3a1f4a' },
    },
    {
        // Coca: NOT weed. Harvest gives COCA LEAVES (s.cocaLeaves), not buds —
        // the raw input for the coke cauldron. Notoriously slow + low yield.
        key: 'coca',    t: 'Coca Seeds',    d: 'Coca shrub. Slow grow, few leaves — feeds the coke cauldron.',
        cost: 200, speed: 0.70, yieldMult: 1.00, qBonus: 0.10, color: '#bfe9ff', crop: 'coca',
        palette: { leaf: '#2f5a3a', leafRipe: '#5f8a4a', bud: '#3a6a44', budRipe: '#7faa5a', stem: '#2a4a30' },
    },
];
const COCA_LEAVES_PER_PLANT = 8;   // base leaves a ripe coca shrub yields
const COCA_LEAVES_PER_BATCH = 4;   // base leaves consumed by one coke cook
const SEED_PAD_RADIUS = 2.8;       // interaction distance for the outdoor seed shop
// ---- grow juice (pour-on speed boost, second outdoor shop) --------------
// Buy a bottle at the juice shop, walk up to a planted plant, [E] to pour it
// on — that one plant gets a grow-speed multiplier for the rest of its cycle.
// One pour per plant; the boost clears at harvest. Tiered like seeds: stronger
// juice = bigger boost = bigger price.
// Bonus portion above 1.0 doubled vs original — Compost +0.6 → +1.2 etc.
const JUICE_TIERS = [
    { key: 'compost', t: 'Compost Tea',  d: 'Cheap brew. +120% grow speed.',          cost: 80,  speed: 2.20, color: '#8aa86a' },
    { key: 'bloom',   t: 'Liquid Bloom', d: 'Lab-grade. +220% grow speed.',           cost: 220, speed: 3.20, color: '#7fd0ff' },
    { key: 'elixir',  t: 'Hydro Elixir', d: 'Top-shelf nutes. +360% grow speed.',     cost: 500, speed: 4.60, color: '#e6a8ff' },
];
const JUICE_PAD_RADIUS = 2.8;      // interaction distance for the outdoor juice shop
// ---- grow care challenge (thirst + pests) --------------------------------
// A watered plant slowly dries (moisture 1→0). Below DRY_STRESS it stops
// growing and loses health; re-water (E) to top it up. Plants also randomly get
// pests — spray them (Fire near the plant, costs $) before health tanks.
const MOISTURE_DRAIN_PER_SEC = 1 / 55;   // full→empty in ~55s of growth
const DRY_STRESS = 0.2;            // below this moisture, growth stalls + wilts
const HEALTH_DRAIN_PER_SEC = 0.045;      // health lost while stressed (dry or pests)
const HEALTH_RECOVER_PER_SEC = 0.02;     // health regained when happy
const PEST_CHANCE_PER_SEC = 1 / 70;      // ~once every 70s a healthy plant can get pests
const PEST_GROWTH_MULT = 0.35;     // growth speed while infested
const SPRAY_COST = 25;             // $ per pest treatment
const SPRAY_COOLDOWN_MS = 600;     // anti-spam on the spray action
const FLOOR_OFFSET = 0.1;         // matches PLAYER_SETTINGS.floorOffset-ish
const BUD_SIZE = 0.16;            // physics bud half-extent-ish
const BUD_GRAB_RANGE = 6.0;       // how far the cursor can grab a bud
const BUD_HOLD_DIST = 1.6;        // distance in front of camera while held
const BUD_TOUCH_PICK_RADIUS = 54; // px fallback so touch can grab without aiming at crosshair
const BUD_RETURN_MS = 30000;      // fallen bench buds return to inventory after 30s
const BAG_HALF = [0.55, 0.5, 0.55]; // bag trigger zone half-extents
const PLANT_SIM_STEP_MS = 1000;   // plants grow and refresh visuals at 1Hz
// ---- dynamic market ------------------------------------------------------
// Demand drifts each day (a random walk, 0.6x..1.6x). One shirt colour is the
// day's "hot" demand and pays a bonus; selling to it also nudges demand down.
const MARKET_MIN = 0.6, MARKET_MAX = 1.6;
const HOT_BONUS = 0.45;            // +45% price selling to the day's hot colour
const HOT_SELL_DROP = 0.06;       // each hot sale cools that demand a touch
// ---- sale combo streak ---------------------------------------------------
// Back-to-back deals inside COMBO_WINDOW build a cash multiplier (capped).
const COMBO_WINDOW_MS = 9000;     // time to land the next deal before reset
const COMBO_STEP = 0.25;          // +25% per chained deal
const COMBO_MAX = 2.5;            // 2.5x ceiling
// ---- narc buyers ---------------------------------------------------------
// A fraction of buyers are undercover. Dealing to one spikes heat hard. They
// "tell" within NARC_TELL_RADIUS (the prompt warns you) so it's a read, not RNG.
const NARC_CHANCE = 0.16;         // ~1 in 6 buyers is a narc
const NARC_HEAT = 42;             // heat slammed on if you sell to a narc
const NARC_TELL_RADIUS = 5.0;     // they get twitchy this close
// ---- customer loyalty / regulars -----------------------------------------
// Buyers are anonymous but their SHIRT COLOUR is their identity. Repeat good
// deals to a colour build that colour's loyalty tier; loyal customers pay a
// price premium and build rep faster. Selling them TRASH (q < trash grade)
// betrays them — their tier collapses and word spreads (rep hit + heat).
// loyalty[color] = { deals, tier }. Tiers index LOYALTY_TIERS.
const LOYALTY_TIERS = [
    { name: 'New',     mult: 1.00, repBonus: 0.0, deals: 0,  badge: '',   color: '#cdd6e3' },
    { name: 'Regular', mult: 1.10, repBonus: 0.4, deals: 3,  badge: '◆',  color: '#9dffa0' },
    { name: 'Loyal',   mult: 1.22, repBonus: 0.8, deals: 8,  badge: '◆◆', color: '#7fd0ff' },
    { name: 'VIP',     mult: 1.40, repBonus: 1.4, deals: 16, badge: '★',  color: '#ffe066' },
];
const LOYALTY_TRASH_DROP = 2;     // tiers lost when you sell a loyal customer trash
const LOYALTY_TRASH_HEAT = 8;     // heat from an angry regular badmouthing you
// ---- crew: VIP regulars can be hired as auto-dealers --------------------
// A maxed-loyalty (VIP) customer trusts you enough to push product for you.
// Hire one and they roam the streets, auto-selling your stash for cash minus
// a wage cut, adding a little heat. They can get busted and vanish.
const CREW_HIRE_LOYALTY = LOYALTY_TIERS.length - 1; // VIP tier index required
const CREW_HIRE_COST = 1500;       // up-front hire fee
const CREW_MAX = 4;                // how many dealers you can run at once
const CREW_SELL_INTERVAL_MS = 9000; // a dealer moves a bundle this often
const CREW_WAGE_CUT = 0.30;        // fraction of each sale the dealer keeps
const CREW_SELL_QTY = 2;           // units a dealer moves per sale
const CREW_HEAT_PER_SALE = 2.5;    // heat each dealer sale adds
const CREW_BUST_CHANCE = 0.04;     // per-sale chance a dealer gets busted + lost
const CREW_SPEED = 1.7;            // dealer wander speed
// ---- crew leveling ------------------------------------------------------
// Dealers earn 1 XP per sale and rank up through these tiers. Each rank sells
// faster + bigger, keeps a smaller wage cut, and is harder to bust. The cap
// (hat) recolours by rank so you can read a crew's level at a glance.
const CREW_RANKS = [
    { name: 'Runner',  xp: 0,  qty: 1, intervalMult: 1.00, wageCut: 0.30, bustMult: 1.00, cap: 0x2ec27a },
    { name: 'Dealer',  xp: 8,  qty: 2, intervalMult: 0.90, wageCut: 0.27, bustMult: 0.85, cap: 0x4fd0ff },
    { name: 'Pusher',  xp: 22, qty: 3, intervalMult: 0.78, wageCut: 0.23, bustMult: 0.65, cap: 0xffe066 },
    { name: 'Slinger', xp: 45, qty: 4, intervalMult: 0.66, wageCut: 0.19, bustMult: 0.45, cap: 0xff9a3c },
    { name: 'Kingpin',  xp: 80, qty: 6, intervalMult: 0.55, wageCut: 0.15, bustMult: 0.28, cap: 0xff5a8a },
];
function crewRankIndex(xp) {
    let r = 0;
    for (let i = 0; i < CREW_RANKS.length; i++) if ((xp || 0) >= CREW_RANKS[i].xp) r = i;
    return r;
}
// ---- bribe ---------------------------------------------------------------
const BRIBE_COST_PER_HEAT = 3;    // $ per heat point cleared at the upgrade desk
// ---- rivals / random events / base upgrades -----------------------------
// ---- reputation ---------------------------------------------------------
// Street rep 0..100. Drives how many customers come to your shop:
//   <20  PARIAH   only 1 buyer wanders in
//   <40  SHADY    2
//   <60  KNOWN    3-4 (baseline)
//   <80  RESPECTED 5-6
//   >=80 LEGEND    7-8
// Each sale builds rep (quality + hot sales build it faster); narcs, busts,
// and trash product chip it away. Persisted in the save.
const REP_START = 0;
const REP_MAX = 100;
const REP_MIN = 0;
const REP_GAIN_BASE = 0.6;        // per unit sold of average product
const REP_GAIN_QUALITY = 2.2;     // additive multiplier for quality 0..1
const REP_GAIN_HOT = 1.6;         // extra rep for hitting the hot buyer
const REP_GAIN_COMBO = 0.8;       // bonus when chain >= 3
const REP_LOSS_NARC = 18;         // sold to undercover cop
const REP_LOSS_BUST = 12;         // got pinched
const REP_LOSS_TRASH = 4;         // sold trash-grade product (q<0.35)

const RIVAL_SPEED = 1.85;
const RIVAL_POACH_RADIUS = 2.2;
const RIVAL_MUG_RADIUS = 2.0;
const RIVAL_EVENT_COOLDOWN_MS = 14000;
// ---- armed rivals --------------------------------------------------------
// Once you're notorious (high heat) rivals start packing. Armed rivals stop
// poaching and instead hunt the player: close to firing range and shoot
// (non-lethal, floored like cop fire). Drop them for a cash bounty.
const RIVAL_ARM_HEAT = 60;          // heat at/above which new rivals may be armed
const RIVAL_ARM_CHANCE = 0.5;       // chance an eligible rival spawns armed
const RIVAL_GUN_RANGE = 18;         // how far an armed rival will shoot
const RIVAL_GUN_MIN_RANGE = 2.4;    // closer than this they mug instead of shoot
const RIVAL_GUN_DAMAGE = 0.16;      // player health per rival bullet
const RIVAL_GUN_COOLDOWN_MS = 1700; // per-rival fire cadence
const RIVAL_CHASE_SPEED = 2.6;      // armed rivals move faster when hunting
const RIVAL_KILL_BOUNTY = 250;      // cash for dropping an armed rival
const RANDOM_EVENT_MIN_MS = 30000;
const RANDOM_EVENT_MAX_MS = 52000;
const EVENT_DURATION_MS = 45000;

// ---- product lines -------------------------------------------------------
// 'weed' is grown only — plant→bud→bag→stash pipeline (s.stash). It is NOT
// cookable at the bench (cook:false). 'pills' and 'coke' are unlocked by
// purchasing equipment at the upgrade desk, then COOKED at the bench (their
// own reagent puzzles) into their own side-stashes (s.prod[key]). Each line
// has its own price multiplier and heat profile so higher-tier product pays
// more but burns hotter.
const PRODUCTS = {
    // grown: true  → produced via the plant/pot grow system (weed, shrooms).
    // labGame      → which indoor minigame makes it (lab key in LAB_THEME).
    // unlock       → state flag (s[unlock]) gating the line; null = always on.
    // labPrice     → one-time unlock cost shown in the shop.
    weed:    { name: 'Weed',    emoji: '🌿', color: '#9dffa0', priceMult: 1.0, heatMult: 1.0,  unlock: null,          grown: true },
    shrooms: { name: 'Shrooms', emoji: '🍄', color: '#d8a0ff', priceMult: 1.5, heatMult: 1.1,  unlock: 'hasShrooms',  labGame: 'shrooms', labPrice: 900 },
    pills:   { name: 'Pills',   emoji: '💊', color: '#ff7fd0', priceMult: 1.9, heatMult: 1.35, unlock: 'hasPillPress', labGame: 'pills', labPrice: 1200 },
    coke:    { name: 'Coke',    emoji: '❄️', color: '#cfe8ff', priceMult: 3.4, heatMult: 1.8,  unlock: 'hasCokeLab',  labGame: 'coke',  labPrice: 3000 },
    meth:    { name: 'Meth',    emoji: '💎', color: '#bfe9ff', priceMult: 4.2, heatMult: 2.1,  unlock: 'hasMethLab',  labGame: 'meth',  labPrice: 6000 },
    lsd:     { name: 'LSD',     emoji: '🌈', color: '#ffd24a', priceMult: 5.0, heatMult: 1.5,  unlock: 'hasLsdLab',   labGame: 'lsd',   labPrice: 9000 },
};
const PRODUCT_KEYS = ['weed', 'shrooms', 'pills', 'coke', 'meth', 'lsd'];
// Side-stash lines (everything that isn't legacy weed s.stash).
const SIDE_PRODUCT_KEYS = PRODUCT_KEYS.filter((k) => k !== 'weed');
const PROD_STASH_CAP = 30;         // per side-stash carry cap
const SHROOM_SUBSTRATE_PRICE = 120;
const SHROOM_SPAWN_PRICE = 90;
const SHROOM_SPRAY_BOTTLE_PRICE = 80;
const SHROOM_AC_PRICE = 350;
const SHROOM_RACK_PRICE = 260;
const SHROOM_GROW_MS = 70000;
const SHROOM_DRY_MS = 60000;
const SHROOM_MISTS_REQUIRED = 3;
// ---- big-order bounties --------------------------------------------------
// Occasionally the phone surfaces a fat one-shot order: move N units of a
// specific product to a specific shirt colour before the in-game day ends.
// Fill it for a flat cash bonus + a rep kick. One active at a time.
const BOUNTY_MIN_DELAY_MS = 60000;   // earliest a new bounty can appear after the last
const BOUNTY_MAX_DELAY_MS = 130000;
const BOUNTY_PAY_PER_UNIT = 90;      // bonus cash per required unit (on top of the sale)
const BOUNTY_REP_REWARD = 9;         // rep granted on completion

// ---- long-distance car deliveries ---------------------------------------
// A drop-off out in the streamed world: drive N units of a product to a fixed
// world location (far away). Pay scales with the DISTANCE you have to drive
// (plus the product's value), so far runs are worth the trip. Drive within
// DELIVERY_RADIUS of the marked beacon while holding the product and press [E]
// (or Fire) to deliver. One active at a time; accepted from the phone.
const DELIVERY_CHUNK = 80;           // matches the map-streaming grid
const DELIVERY_MIN_CHUNKS = 2;       // nearest drop is this many chunks out
const DELIVERY_MAX_CHUNKS = 5;       // farthest drop
const DELIVERY_PAY_PER_UNIT = 120;   // base bonus per unit (before distance/product mult)
const DELIVERY_PAY_PER_METRE = 2.2;  // extra cash per metre of straight-line distance
const DELIVERY_REP_REWARD = 14;      // rep on completion (more than a shirt bounty)
const DELIVERY_RADIUS = 7;           // how close the car must get to the beacon
const DELIVERY_MIN_DELAY_MS = 25000; // earliest a fresh delivery can be offered
// The car is bought (not free): owning it parks a drivable car behind the
// house AND unlocks the long-distance delivery contracts.
const CAR_PRICE = 2500;

export function createDrugTycoon(deps) {
    const {
        gameplay,
        physics,
        setPlayerHealth,
        createDynamicPropActor,
        setActorComponentFlags,
        rebuildActorPhysics,
        getActorRenderObject,
        destroyDynamicPhysicsProp,
        getSceneSystem,
        spawnDrivableCar,
        setActorWorldPositionExact,
        getActorBody,
    } = deps;

    // The Jolt physics handle isn't on appCore — hand it to the ragdoll module.
    if (physics) ragdoll.setPhysics(physics);

    // ---- map chunk streaming -------------------------------------------
    // Grows the world outward from the hand-built 80×80 core, loading/unloading
    // decorative-but-collidable neighbourhood chunks as the player nears an
    // edge. Only created if the runtime handed us the actor helpers.
    let _mapStreaming = null;
    if (createDynamicPropActor && setActorComponentFlags && rebuildActorPhysics) {
        _mapStreaming = createMapStreaming({
            core,
            createDynamicPropActor,
            setActorComponentFlags,
            rebuildActorPhysics,
            getActorRenderObject,
            destroyDynamicPhysicsProp,
            getSceneSystem,
            DDGIMeshStandardNodeMaterial,
            makePerson: (opts) => makeTycoonPersonMesh(opts || {}),
        });
    }

    // ---- run state ------------------------------------------------------
    function defaultState() {
        return {
            cash: STARTING_CASH,
            startingCashGranted: true,
            startingCashGrantAmount: STARTING_CASH_GRANT,
            rep: REP_START,       // street reputation 0..100, drives buyer count
            loyalty: {},          // per-shirt-colour regulars: { [color]: { deals, tier } }
            stash: 0,             // unsold WEED on hand (legacy field == weed line)
            stashQ: 1,            // running quality of WEED on hand (0..1)
            // ---- extra product lines (side-stashes) -----------------------
            prod: { shrooms: { qty: 0, q: 1 }, pills: { qty: 0, q: 1 }, coke: { qty: 0, q: 1 }, meth: { qty: 0, q: 1 }, lsd: { qty: 0, q: 1 } },
            hasPillPress: false,  // bought the pill press (unlocks pill line)
            hasCokeLab: false,    // bought the coke lab (unlocks coke line)
            hasMethLab: false,    // bought the meth lab (unlocks meth line)
            hasLsdLab: false,     // bought the LSD lab (unlocks LSD line)
            hasShrooms: false,    // bought shroom spores (unlocks growing shrooms)
            shroomQuestStarted: true,
            mushroomSubstrate: 0,
            shroomSpawn: 0,
            sprayBottle: false,
            sprayBottleFilled: false,
            shroomAcUnits: 0,
            shroomAcMode: 'cool',
            dryingRacks: 0,
            wetShrooms: 0,
            wetShroomsQ: 1,
            shroomRun: null,
            shroomDrying: null,
            sellProduct: 'weed',  // which line the player deals right now
            cookProduct: 'weed',  // which line the cook bench is brewing
            // ---- big-order bounty -----------------------------------------
            bounty: null,         // { product, color, need, got, payout, expiresDay }
            nextBountyAt: 0,
            // ---- long-distance car delivery -------------------------------
            delivery: null,       // { product, need, payout, pos:[x,y,z], distance, expiresDay }
            nextDeliveryAt: 0,
            budsQ: 1,             // running quality of loose harvested buds
            lastQ: 0,             // quality of the most recent batch (HUD)
            heat: 0,
            cooking: false,       // recipe panel open
            recipe: [],           // reagent keys added so far this cook
            busted: 0,            // times caught
            sales: 0,
            // ---- end-of-day summary accumulators --------------------------
            // Reset each dawn; the day-flip snapshots these into the summary
            // panel. dayNum is the 1-based day the player is currently living.
            dayNum: 1,
            summaryOpen: false,
            today: { earned: 0, spent: 0, units: 0, sales: 0, busts: 0, narcs: 0, repStart: REP_START, bestCombo: 1, bounties: 0 },
            // Lifetime running totals (summed from each day at rollover). The
            // summary's "show total" button reads these. days = days completed.
            life: { earned: 0, spent: 0, units: 0, sales: 0, busts: 0, narcs: 0, bounties: 0, bestCombo: 1, days: 0 },
            // upgrade levels
            up: { batch: 0, speed: 0, buyers: 0, stealth: 0, cap: 0 },
            baseUp: { lights: 0, security: 0, storage: 0, autoWater: 0 },
            // world refs (positions cached from the level layout)
            cookPos: new THREE.Vector3(),
            upgradePos: new THREE.Vector3(),
            pillLabPos: new THREE.Vector3(),
            cokeLabPos: new THREE.Vector3(),
            methLabPos: new THREE.Vector3(),
            lsdLabPos: new THREE.Vector3(),
            shroomLabPos: new THREE.Vector3(),
            gunPos: new THREE.Vector3(),
            pillGame: null,       // active pill/coke minigame state (see openPillLab)
            npcs: [],             // { actor, mesh, target, wantsBuy }
            rivals: [],           // rival dealers competing for buyers / stash
            crew: [],             // hired VIP dealers { color, mesh, target, nextSaleAt }
            police: [],           // { actor, mesh }
            started: false,
            shopOpen: false,
            // ---- day/night cycle ------------------------------------------
            timeOfDay: 0.25,      // start mid-morning
            patrol: [],           // night patrol cops { mesh, target, alerted }
            // ---- phone order: the one buyer (by shirt colour) you must sell to
            phoneOpen: false,     // phone HUD popped out
            helpOpen: false,      // how-to-play panel open
            orderColor: '',       // shirt colour of the current valid customer
            ordersFilled: 0,      // delivered orders
            // ---- dynamic market -------------------------------------------
            demand: 1.0,          // global price multiplier (random-walks daily)
            hotColor: '',         // day's high-demand shirt colour (price bonus)
            marketDay: -1,        // which day index demand was last rolled
            // ---- combo streak ---------------------------------------------
            combo: 0,             // consecutive-deal counter
            comboUntil: 0,        // timestamp the streak expires
            events: {},           // timed random event flags
            nextEventAt: 0,
            hasCar: false,        // bought the car (parks a drivable car + unlocks deliveries)
            hasGun: false,        // player owns the pistol
            gunPickupMesh: null,  // floating pickup on the pedestal
            nextShotAt: 0,        // shoot cooldown
            ammo: 0,              // pistol rounds
            hasBat: false,        // owns the baseball bat (melee, no ammo)
            nextSwingAt: 0,       // bat swing cooldown
            // ---- seeds (bought outside, consumed when planting) ------------
            seeds: [2, 0, 0, 0],  // start with 2 cheap Reggie seeds; buy more/better at the shop
            startingSeedsGranted: true,
            seedTier: 0,          // tier planted next (highest owned auto-selects)
            seedShopOpen: false,  // outdoor seed-shop overlay up
            seedPos: new THREE.Vector3(),  // cached outdoor seed-shop pad position
            // ---- grow juice (pour-on speed boost) --------------------------
            juices: [0, 0, 0],    // owned bottles per JUICE_TIERS index
            juiceTier: 0,         // tier poured next (highest owned auto-selects)
            juiceShopOpen: false, // outdoor juice-shop overlay up
            juicePos: new THREE.Vector3(),
            // ---- grow room -------------------------------------------------
            inRoom: false,        // player currently inside the grow room
            buds: 0,              // harvested loose buds (pre-bagging)
            cocaLeaves: 0,         // raw coca leaves harvested from coca plants
            cocaLeavesQ: 1,        // running quality of raw coca leaves
            plants: [],           // { mesh, planted, watered, stage, grownAt, pos } per pot
            plantsBuilt: false,   // pots populated once
            baggingOpen: false,   // (legacy) drag-and-drop panel up
            // ---- physics bagging ------------------------------------------
            physBuds: [],         // { mesh, body, returnAt? } loose physics buds on the bench
            bagMesh: null,        // visual bag at the bench
            bagPos: null,         // [x,y,z] centre of the bag trigger zone
            grabbed: null,        // the physBud currently held by the cursor
            touchGrabbed: null,   // physBud currently held by a direct touch drag
        };
    }

    // Cache + tick yaw-only billboards on the active drug-tycoon level. The
    // list is built once per level mesh (stamped on userData) by walking the
    // graph for any object flagged userData.billboardY === true. Per-frame
    // cost is just N * (atan2 + 1 rotation set) for tiny N (~5 signs).
    const _bbVec = new THREE.Vector3();
    function tickLevelBillboards(levelMesh) {
        if (!levelMesh) return;
        const { camera } = core;
        if (!camera) return;
        let list = levelMesh.userData._billboards;
        if (!list) {
            list = [];
            levelMesh.traverse((obj) => {
                if (obj?.userData?.billboardY) list.push(obj);
            });
            levelMesh.userData._billboards = list;
        }
        for (let i = 0; i < list.length; i++) {
            const obj = list[i];
            obj.getWorldPosition(_bbVec);
            // Yaw so the sign's local +Z points at the camera, XZ-plane only.
            const yaw = Math.atan2(camera.position.x - _bbVec.x, camera.position.z - _bbVec.z);
            obj.rotation.set(0, yaw, 0);
        }
    }

    function ensureState() {
        if (!window.drugTycoon) window.drugTycoon = defaultState();
        const s = window.drugTycoon;
        s.baseUp ||= { lights: 0, security: 0, storage: 0, autoWater: 0 };
        s.baseUp = { lights: 0, security: 0, storage: 0, autoWater: 0, ...s.baseUp };
        s.rivals ||= [];
        s.crew ||= [];
        s.events ||= {};
        if (typeof s.budsQ !== 'number') s.budsQ = 1;
        if (typeof s.cocaLeaves !== 'number') s.cocaLeaves = 0;
        if (typeof s.cocaLeavesQ !== 'number') s.cocaLeavesQ = 1;
        if (typeof s.nextEventAt !== 'number') s.nextEventAt = 0;
        if (typeof s.rep !== 'number') s.rep = REP_START;
        // Seed inventory (older saves predate the seed shop).
        if (!Array.isArray(s.seeds) || s.seeds.length !== SEED_TIERS.length) {
            s.seeds = SEED_TIERS.map((_, i) => (Array.isArray(s.seeds) ? (s.seeds[i] | 0) : 0));
        }
        if (typeof s.seedTier !== 'number') s.seedTier = 0;
        if (!s.seedPos) s.seedPos = new THREE.Vector3();
        // Grow-juice inventory (older saves predate the juice shop).
        if (!Array.isArray(s.juices) || s.juices.length !== JUICE_TIERS.length) {
            s.juices = JUICE_TIERS.map((_, i) => (Array.isArray(s.juices) ? (s.juices[i] | 0) : 0));
        }
        if (typeof s.juiceTier !== 'number') s.juiceTier = 0;
        if (!s.juicePos) s.juicePos = new THREE.Vector3();
        if (!s.pillLabPos) s.pillLabPos = new THREE.Vector3();
        if (!s.cokeLabPos) s.cokeLabPos = new THREE.Vector3();
        // One-time grant: pre-seed-shop saves never got the 2 starter Reggie
        // seeds (and were stuck unable to plant). Hand them out once, then mark
        // the save so a player who legitimately spent their seeds doesn't get
        // refilled on every reload.
        if (!s.startingSeedsGranted) {
            const total = s.seeds.reduce((a, b) => a + (b | 0), 0);
            if (total === 0) s.seeds[0] = 2;
            s.startingSeedsGranted = true;
        }
        // Extra product lines (older saves predate pills/coke).
        if (!s.prod || typeof s.prod !== 'object') s.prod = {};
        for (const k of SIDE_PRODUCT_KEYS) {
            if (!s.prod[k]) s.prod[k] = { qty: 0, q: 1 };
        }
        if (typeof s.hasPillPress !== 'boolean') s.hasPillPress = false;
        if (typeof s.hasCokeLab !== 'boolean') s.hasCokeLab = false;
        if (typeof s.hasMethLab !== 'boolean') s.hasMethLab = false;
        if (typeof s.hasLsdLab !== 'boolean') s.hasLsdLab = false;
        if (typeof s.hasShrooms !== 'boolean') s.hasShrooms = false;
        s.shroomQuestStarted = true;
        if (typeof s.mushroomSubstrate !== 'number') s.mushroomSubstrate = 0;
        if (typeof s.shroomSpawn !== 'number') s.shroomSpawn = 0;
        if (typeof s.sprayBottle !== 'boolean') s.sprayBottle = false;
        if (typeof s.sprayBottleFilled !== 'boolean') s.sprayBottleFilled = false;
        if (typeof s.shroomAcUnits !== 'number') s.shroomAcUnits = 0;
        if (s.shroomAcMode !== 'heat') s.shroomAcMode = 'cool';
        if (typeof s.dryingRacks !== 'number') s.dryingRacks = 0;
        if (typeof s.wetShrooms !== 'number') s.wetShrooms = 0;
        if (typeof s.wetShroomsQ !== 'number') s.wetShroomsQ = 1;
        if (s.shroomRun && typeof s.shroomRun !== 'object') s.shroomRun = null;
        if (s.shroomDrying && typeof s.shroomDrying !== 'object') s.shroomDrying = null;
        if (typeof s.hasCar !== 'boolean') s.hasCar = false;
        if (!s.methLabPos) s.methLabPos = new THREE.Vector3();
        if (!s.lsdLabPos) s.lsdLabPos = new THREE.Vector3();
        if (!s.shroomLabPos) s.shroomLabPos = new THREE.Vector3();
        // Selected lines must always point at an unlocked product.
        if (!PRODUCT_KEYS.includes(s.sellProduct) || !productUnlocked(s, s.sellProduct)) s.sellProduct = 'weed';
        // Bench only brews cookable lines; default to the first unlocked one (or
        // 'pills' as a placeholder if none yet — the bench prompt gates entry).
        if (!PRODUCTS[s.cookProduct]?.cook || !productUnlocked(s, s.cookProduct)) {
            s.cookProduct = cookableProducts(s)[0] || 'pills';
        }
        if (typeof s.nextBountyAt !== 'number') s.nextBountyAt = 0;
        if (s.bounty && typeof s.bounty !== 'object') s.bounty = null;
        // Long-distance delivery (older saves predate it).
        if (typeof s.nextDeliveryAt !== 'number') s.nextDeliveryAt = 0;
        if (s.delivery && typeof s.delivery !== 'object') s.delivery = null;
        // End-of-day summary (older saves predate it).
        if (typeof s.dayNum !== 'number') s.dayNum = Math.floor(s._daysElapsed ?? 0) + 1;
        if (!s.today || typeof s.today !== 'object') s.today = newDayStats(s);
        if (!s.life || typeof s.life !== 'object') s.life = { earned: 0, spent: 0, units: 0, sales: 0, busts: 0, narcs: 0, bounties: 0, bestCombo: 1, days: 0 };
        if (!s.loyalty || typeof s.loyalty !== 'object') s.loyalty = {};
        return window.drugTycoon;
    }

    // Is a product line available to the player? Weed always; pills/coke gate
    // on the one-time equipment purchase.
    function productUnlocked(s, key) {
        const u = PRODUCTS[key]?.unlock;
        if (!u) return true;       // null unlock = always available (weed)
        return !!s[u];             // data-driven: the flag name IS the state key
    }
    // Cached world position of a product's indoor lab bench (for float text).
    function labPosFor(s, product) {
        return { pills: s.pillLabPos, coke: s.cokeLabPos, meth: s.methLabPos, lsd: s.lsdLabPos, shrooms: s.shroomLabPos }[product] || null;
    }
    function unlockedProducts(s) { return PRODUCT_KEYS.filter((k) => productUnlocked(s, k)); }
    // Lines you can brew at the bench: unlocked AND flagged cookable (weed is
    // grown, not cooked, so it's excluded).
    function cookableProducts(s) { return unlockedProducts(s).filter((k) => PRODUCTS[k]?.cook); }
    // Unified accessor over weed (legacy s.stash) + side-stashes (s.prod[key]).
    function prodQty(s, key) { return key === 'weed' ? s.stash : (s.prod?.[key]?.qty || 0); }
    function prodQual(s, key) { return key === 'weed' ? (s.stashQ || 1) : (s.prod?.[key]?.q || 1); }
    function prodCap(s, key) { return key === 'weed' ? stashCap(s) : PROD_STASH_CAP; }
    // Lazily ensure a side-stash exists (saves from before a drug was added
    // won't have its s.prod entry until this runs).
    function prodRec(s, key) {
        s.prod ||= {};
        if (!s.prod[key]) s.prod[key] = { qty: 0, q: 1 };
        return s.prod[key];
    }
    function addProduct(s, key, qty, q) {
        if (qty <= 0) return;
        if (key === 'weed') { blendStashQuality(s, qty, q); s.stash += qty; return; }
        const p = prodRec(s, key);
        const total = p.qty + qty;
        p.q = total > 0 ? (p.qty * p.q + qty * q) / total : q;
        p.qty = total;
    }
    function takeProduct(s, key, qty) {
        if (key === 'weed') { s.stash = Math.max(0, s.stash - qty); if (s.stash <= 0) s.stashQ = 1; return; }
        const p = prodRec(s, key);
        p.qty = Math.max(0, p.qty - qty);
        if (p.qty <= 0) p.q = 1;
    }

    // ---- progress persistence (localStorage) ----------------------------
    // Only the economy/progression fields persist — world refs, meshes, npcs,
    // plants and other transient runtime state are always rebuilt fresh.
    const SAVE_KEY = 'polyflow.drugTycoon.save.v1';
    const PERSIST_FIELDS = [
        'cash', 'stash', 'stashQ', 'heat', 'busted', 'sales',
        'hasGun', 'ammo', 'hasBat', 'ordersFilled', 'buds', 'budsQ', 'cocaLeaves', 'cocaLeavesQ',
        'demand', 'hotColor', 'marketDay', 'startingCashGranted', 'startingCashGrantAmount',
        'seedTier', '_budsHarvested', 'startingSeedsGranted',
        'juiceTier', 'rep', 'dayNum',
        'prod', 'hasPillPress', 'hasCokeLab', 'hasMethLab', 'hasLsdLab', 'hasShrooms',
        'shroomQuestStarted', 'mushroomSubstrate', 'shroomSpawn', 'sprayBottle', 'sprayBottleFilled',
        'shroomAcUnits', 'shroomAcMode', 'dryingRacks', 'wetShrooms', 'wetShroomsQ', 'shroomRun', 'shroomDrying',
        'hasCar', 'sellProduct', 'cookProduct',
    ];
    let _lastSaveAt = 0;
    // Plant snapshots strip the THREE mesh (rebuilt on load) and the
    // performance.now()-relative timers (re-based on load so growth doesn't
    // fast-forward or instantly wilt across a reload). Only the scalar
    // lifecycle state is stored, in pot order.
    function serializePlants(s) {
        // Before the pots are built (e.g. a save fired right after resetState,
        // when s.plants is still empty but a crop was loaded), keep the last
        // known snapshot instead of clobbering it with an empty array.
        if (!Array.isArray(s.plants) || s.plants.length === 0) {
            return Array.isArray(s.plantsData) ? s.plantsData : [];
        }
        return s.plants.map((p) => ({
            planted: !!p.planted, watered: !!p.watered,
            progress: p.progress ?? 0, stage: p.stage ?? 0,
            health: p.health ?? 1, moisture: p.moisture ?? 0,
            pest: !!p.pest, tier: p.tier ?? 0, crop: p.crop || null, juiceMult: p.juiceMult ?? 1,
            // Remaining dry-out time (ms) for an un-watered seed; re-based on load.
            dryRemain: (p.planted && !p.watered && p.driedAt)
                ? Math.max(0, p.driedAt - (performance.now?.() || Date.now())) : 0,
        }));
    }
    function saveProgress() {
        const s = window.drugTycoon;
        if (!s) return;
        try {
            const blob = {};
            for (const k of PERSIST_FIELDS) blob[k] = s[k];
            blob.up = { ...s.up };           // upgrade levels
            blob.baseUp = { ...s.baseUp };
            blob.life = { ...s.life };       // lifetime totals
            blob.loyalty = { ...s.loyalty }; // customer regulars by shirt colour
            // Hired dealers persist with their rank progress; the meshes are
            // re-spawned on load (see ensureCrewMeshes).
            blob.crewColors = (s.crew || []).map((c) => ({ color: c.color, xp: c.xp || 0, earned: c.earned || 0 }));
            blob.seeds = Array.isArray(s.seeds) ? s.seeds.slice() : SEED_TIERS.map(() => 0);
            blob.juices = Array.isArray(s.juices) ? s.juices.slice() : [0, 0, 0];
            // Growing plants persist so a half-grown crop survives a reload.
            blob.plantsData = serializePlants(s);
            localStorage.setItem(SAVE_KEY, JSON.stringify(blob));
        } catch (e) { /* private mode / quota — ignore */ }
        _lastSaveAt = performance.now?.() || Date.now();
    }
    function loadProgressInto(s) {
        try {
            const raw = localStorage.getItem(SAVE_KEY);
            if (!raw) return;
            const blob = JSON.parse(raw);
            for (const k of PERSIST_FIELDS) {
                if (typeof blob[k] === typeof s[k] && blob[k] !== undefined) s[k] = blob[k];
            }
            if (blob.startingCashGranted !== true || blob.startingCashGrantAmount !== STARTING_CASH_GRANT) {
                s.cash = Math.max(s.cash, STARTING_CASH);
                s.startingCashGranted = true;
                s.startingCashGrantAmount = STARTING_CASH_GRANT;
            }
            if (blob.up && typeof blob.up === 'object') s.up = { ...s.up, ...blob.up };
            if (blob.baseUp && typeof blob.baseUp === 'object') s.baseUp = { ...s.baseUp, ...blob.baseUp };
            if (blob.life && typeof blob.life === 'object') s.life = { ...s.life, ...blob.life };
            if (blob.loyalty && typeof blob.loyalty === 'object') s.loyalty = { ...blob.loyalty };
            // Stash the saved crew colours; meshes are built once the level
            // exists (ensureCrewMeshes, called from the per-frame update).
            if (Array.isArray(blob.crewColors)) s.pendingCrew = blob.crewColors.slice();
            if (Array.isArray(blob.seeds)) s.seeds = SEED_TIERS.map((_, i) => (blob.seeds[i] | 0));
            if (Array.isArray(blob.juices)) s.juices = JUICE_TIERS.map((_, i) => (blob.juices[i] | 0));
            // Saved plant lifecycle — ensurePlants() restores it onto the rebuilt pots.
            if (Array.isArray(blob.plantsData)) s.plantsData = blob.plantsData;
        } catch (e) { /* corrupt save — keep defaults */ }
    }
    // Throttled autosave, called from the per-frame update.
    function maybeAutosave() {
        const now = performance.now?.() || Date.now();
        if (now - _lastSaveAt >= 3000) saveProgress();
    }
    // Wipe the save (full restart).
    function clearProgress() {
        try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
    }
    if (typeof window !== 'undefined') {
        window.drugTycoonClearSave = clearProgress;
    }

    function resetState() {
        const { scene } = core;
        // Persist current progress before tearing down (exit play / reload),
        // then the fresh state below reloads it — so progress survives.
        if (window.drugTycoon) saveProgress();
        const s = window.drugTycoon;
        if (s) {
            for (const n of s.npcs) { try { scene?.remove(n.mesh); } catch (e) {} }
            for (const r of s.rivals || []) { try { scene?.remove(r.mesh); } catch (e) {} }
            for (const c of s.crew || []) { try { scene?.remove(c.mesh); } catch (e) {} }
            for (const p of s.police) { try { scene?.remove(p.mesh); } catch (e) {} }
            for (const c of s.patrol || []) { try { scene?.remove(c.mesh); } catch (e) {} }
        }
        if (s?.gunPickupMesh) { try { scene?.remove(s.gunPickupMesh); } catch (e) {} }
        // Tear down every car spawned this run (starter + any scripted ones).
        for (const car of _carRegistry) { try { destroyDynamicPhysicsProp?.(car); } catch (e) {} }
        _carRegistry.length = 0;
        if (s) s._carActor = null;
        try { clearDeliveryBeacon(); } catch (e) {}
        if (s?.plants) { for (const p of s.plants) { try { scene?.remove(p.mesh); } catch (e) {} } }
        if (s) { try { clearPhysBuds(s); } catch (e) {} }
        try { destroyAudio(); } catch (e) {}
        detachHeldGun();
        for (const t of _tracers) { try { scene?.remove(t.line); } catch (e) {} }
        _tracers.length = 0;
        for (const f of _copFlashes) { try { scene?.remove(f.spr); } catch (e) {} }
        _copFlashes.length = 0;
        window.drugTycoon = defaultState();
        // Restore saved economy/progression so a level (re)load keeps progress.
        loadProgressInto(window.drugTycoon);
        try { ragdoll.removeAll(); } catch (e) {}
        closeCook();
        closePillLab();
        closeShroomPanel();
        closeShop();
        closeBagging();
        if (_summaryEl?.parentNode) _summaryEl.remove();
        _summaryEl = null;
        if (_toastLayer?.parentNode) _toastLayer.remove();
        _toastLayer = null;
        try { _mapStreaming?.clear(); } catch (e) {}
        document.querySelectorAll('.tycoon-overlay').forEach((n) => n.remove());
        _hudEl = null;
        _shopEl = null;
        _cookEl = null;
        _shroomEl = null;
        _bagEl = null;
        _phoneEl = null;
        _helpBtnEl = null;
        _helpPanelEl = null;
        _promptEl = null;
        _compassEl = null;
        _floatLayer = null;
        _sunLight = null;   // re-resolve the sun on the next (rebuilt) level
        _roomNightState = null;  // re-apply room lighting on the next level
        installInteractKey();
    }

    // ---- upgrade economics ---------------------------------------------
    function batchYield(s) { return COOK_YIELD + s.up.batch * 4; }
    function cokeLeavesNeeded(s) { return Math.max(1, Math.ceil(COCA_LEAVES_PER_BATCH * (batchYield(s) / COOK_YIELD))); }
    // Each 'speed' (Clean Lab) level raises the minimum purity floor by 15%,
    // so a botched recipe still yields decent product once you've invested.
    function purityFloor(s) { return Math.min(0.6, s.up.speed * 0.15); }
    function stashCap(s) { return STASH_CAP + s.up.cap * 25 + (s.baseUp?.storage || 0) * 40; }
    // ---- reputation tier + mutation helpers ----------------------------
    function repTier(s) {
        const r = clamp01((s.rep ?? REP_START) / 100) * 100;
        if (r < 20) return { name: 'Pariah',    color: '#ff5555', target: 1 };
        if (r < 40) return { name: 'Shady',     color: '#ff8a3a', target: 2 };
        if (r < 60) return { name: 'Known',     color: '#cdd6e3', target: 4 };
        if (r < 80) return { name: 'Respected', color: '#7fd0ff', target: 6 };
        return        { name: 'Legend',    color: '#9dffa0', target: 8 };
    }
    function changeRep(s, delta, worldPos = null) {
        const before = s.rep ?? REP_START;
        s.rep = Math.max(REP_MIN, Math.min(REP_MAX, before + delta));
        const diff = s.rep - before;
        if (worldPos && Math.abs(diff) >= 1) {
            const sign = diff > 0 ? '+' : '';
            floatText(`${sign}${diff.toFixed(1)} rep`, worldPos.clone().setY(worldPos.y + 2.8), diff > 0 ? '#9dffa0' : '#ff7070');
        }
    }

    // ---- customer loyalty (per shirt colour) ---------------------------
    // A colour's record: how many good deals it's done and its current tier.
    function loyaltyRec(s, color) {
        s.loyalty ||= {};
        if (!s.loyalty[color]) s.loyalty[color] = { deals: 0, tier: 0 };
        return s.loyalty[color];
    }
    function loyaltyTierOf(s, color) {
        return LOYALTY_TIERS[s.loyalty?.[color]?.tier || 0] || LOYALTY_TIERS[0];
    }
    // Recompute a colour's tier from its deal count (climbs only via good sales).
    function recomputeLoyaltyTier(rec) {
        let t = 0;
        for (let i = 0; i < LOYALTY_TIERS.length; i++) {
            if (rec.deals >= LOYALTY_TIERS[i].deals) t = i;
        }
        rec.tier = t;
    }
    // A good deal nudges loyalty up; trash betrays it. Returns the tier object
    // AFTER the change plus whether the customer was angered, for sale feedback.
    function bumpLoyalty(s, color, qty, isTrash) {
        const rec = loyaltyRec(s, color);
        const beforeTier = rec.tier;
        if (isTrash) {
            // Betrayal: lose deal progress + drop tiers.
            rec.deals = Math.max(0, rec.deals - 4);
            rec.tier = Math.max(0, rec.tier - LOYALTY_TRASH_DROP);
            recomputeLoyaltyTier(rec);                 // floor against new deal count
        } else {
            rec.deals += qty;
            recomputeLoyaltyTier(rec);
        }
        return { tier: LOYALTY_TIERS[rec.tier], promoted: rec.tier > beforeTier, angered: isTrash && beforeTier > 0 };
    }

    function qualityGrade(q) {
        q = clamp01(q);
        if (q >= 0.92) return { name: 'Designer', color: '#f6d365' };
        if (q >= 0.75) return { name: 'Fire', color: '#9dffa0' };
        if (q >= 0.55) return { name: 'Street', color: '#7fd0ff' };
        if (q >= 0.35) return { name: 'Shake', color: '#ffae00' };
        return { name: 'Trash', color: '#ff7070' };
    }
    // Price scales with the quality of the product being sold (0..1 → 0.5x..2x)
    // AND the live market demand (0.6x..1.6x). The optional `hot` flag adds the
    // hot-colour bonus when dealing to the day's high-demand customer.
    function unitPrice(s, q = s.stashQ, hot = false, product = 'weed', loyaltyMult = 1) {
        const dem = s.demand || 1;
        const bonus = hot ? (1 + HOT_BONUS) : 1;
        const rush = eventActive(s, 'buyerRush') ? 1.15 : 1;
        const rep = eventActive(s, 'repBoost') && q >= 0.75 ? 1.18 : 1;
        const pmult = PRODUCTS[product]?.priceMult || 1;
        return Math.round(SELL_PRICE * pmult * (0.5 + 1.5 * clamp01(q)) * dem * bonus * rush * rep * loyaltyMult);
    }

    // ---- dynamic market: demand random-walks once per in-game day -------
    function rollMarket(s, force = false) {
        // Day index = whole days elapsed; advanceDayNight tracks fractional days.
        const day = Math.floor(s._daysElapsed ?? 0);
        if (!force && day === s.marketDay && s.demand) return;
        s.marketDay = day;
        // Random walk, clamped — yesterday's price informs today's.
        const drift = (Math.random() - 0.5) * 0.7;
        s.demand = Math.max(MARKET_MIN, Math.min(MARKET_MAX, (s.demand || 1) + drift));
        s.hotColor = SHIRT_TONES[(Math.random() * SHIRT_TONES.length) | 0];
    }
    function marketLabel(s) {
        const d = s.demand || 1;
        if (d >= 1.35) return { t: 'BOOM', c: '#9dffa0' };
        if (d >= 1.1) return { t: 'High', c: '#bfe66a' };
        if (d >= 0.9) return { t: 'Steady', c: '#cdd6e3' };
        if (d >= 0.72) return { t: 'Slow', c: '#ffae00' };
        return { t: 'BUST', c: '#ff7070' };
    }

    // ---- sale combo streak ---------------------------------------------
    function comboActive(s) {
        return s.combo > 0 && (performance.now?.() || Date.now()) < s.comboUntil;
    }
    function comboMult(s) {
        if (!comboActive(s)) return 1;
        return Math.min(COMBO_MAX, 1 + s.combo * COMBO_STEP);
    }
    function heatPerSale(s, q = s.stashQ, product = 'weed') {
        const qualityHeat = 1.18 - clamp01(q) * 0.35;
        const security = Math.pow(0.92, s.baseUp?.security || 0);
        const pheat = PRODUCTS[product]?.heatMult || 1;
        return Math.max(1, SELL_HEAT * Math.pow(0.8, s.up.stealth) * qualityHeat * security * pheat);
    }
    // Live buyer cap = rep tier target + upgrade kicker + event bonus.
    // Reputation is the dominant lever (1 buyer at Pariah, 8 at Legend).
    function maxBuyers(s) {
        const base = repTier(s).target;
        return base + s.up.buyers * 2 + (eventActive(s, 'buyerRush') ? 2 : 0);
    }
    function maxRivals(s) {
        const base = s.sales >= 4 ? 1 : 0;
        const pressure = Math.floor(Math.max(0, s.sales - 10) / 12);
        const truce = eventActive(s, 'rivalTruce') ? -1 : 0;
        return Math.max(0, Math.min(3, base + pressure + truce));
    }

    // ---- wanted level (GTA-style stars from heat) ----------------------
    // Heat (0..160) maps to 0–5 stars. Cops only hunt at >= 1 star, and the
    // count + chase speed scale up with stars.
    const STAR_HEAT = [25, 55, 90, 125, 150];   // heat needed for 1..5 stars
    function wantedStars(s) {
        let stars = 0;
        for (const th of STAR_HEAT) { if (s.heat >= th) stars++; else break; }
        return stars;
    }
    function copsForStars(stars) { return stars <= 0 ? 0 : Math.min(6, stars + 1); }   // 2..6
    function chaseSpeedForStars(stars) { return POLICE_SPEED + (stars - 1) * 0.35; }   // faster at higher stars
    function starString(stars) { return '★★★★★'.slice(0, stars) + '☆☆☆☆☆'.slice(0, 5 - stars); }

    // ---- cook recipe (tactile multi-step mixing) -----------------------
    // The ideal batch is BASE then the three ADDITIVES in order. Adding the
    // right reagent at the right step builds quality; wrong/duplicate reagents
    // dock it. Quality (0..1) then scales both batch yield and sell price.
    // Each product line has its own reagent order. The ideal batch adds the
    // listed reagents in sequence; the cook UI offers that line's full palette
    // every step and the order is the skill.
    const COOK_RECIPES = {
        weed: [
            { key: 'base',    t: 'Trim',     color: '#7fd0ff' },
            { key: 'cure',    t: 'Cure',     color: '#ffe066' },
            { key: 'flush',   t: 'Flush',    color: '#c0c4cc' },
            { key: 'press',   t: 'Press',    color: '#9dff8a' },
        ],
        pills: [
            { key: 'binder',  t: 'Binder',   color: '#ff7fd0' },
            { key: 'active',  t: 'Active',   color: '#ffe066' },
            { key: 'dye',     t: 'Dye',      color: '#7fd0ff' },
            { key: 'stamp',   t: 'Stamp',    color: '#c0c4cc' },
        ],
        coke: [
            { key: 'paste',   t: 'Paste',    color: '#cfe8ff' },
            { key: 'solvent', t: 'Solvent',  color: '#ffe066' },
            { key: 'wash',    t: 'Acid wash', color: '#9dff8a' },
            { key: 'crystal', t: 'Crystallise', color: '#c0c4cc' },
        ],
    };
    // Active step set for whatever the bench is brewing.
    function cookSteps(s) { return COOK_RECIPES[s.cookProduct] || COOK_RECIPES.weed; }
    function recipeLen(s) { return cookSteps(s).length; }

    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

    // Score a finished recipe: each reagent placed in its correct slot is worth
    // 1/N quality; a wrong reagent in a slot contributes nothing and the final
    // quality is the fraction of correct placements.
    function scoreRecipe(recipe, steps) {
        const len = steps.length;
        let correct = 0;
        for (let i = 0; i < len; i++) {
            if (recipe[i] === steps[i].key) correct++;
        }
        return correct / len;
    }

    // Quality blends into the on-hand stash weighted by quantities, so a great
    // batch on top of mediocre product averages out (like Schedule I purity).
    function blendStashQuality(s, addQty, addQ) {
        const total = s.stash + addQty;
        if (total <= 0) { s.stashQ = addQ; return; }
        s.stashQ = (s.stash * s.stashQ + addQty * addQ) / total;
    }
    function blendBudQuality(s, addQty, addQ) {
        const total = s.buds + addQty;
        if (total <= 0) { s.budsQ = addQ; return; }
        s.budsQ = (s.buds * (s.budsQ || 1) + addQty * addQ) / total;
    }
    function blendCocaQuality(s, addQty, addQ) {
        const total = (s.cocaLeaves || 0) + addQty;
        if (total <= 0) { s.cocaLeavesQ = addQ; return; }
        s.cocaLeavesQ = ((s.cocaLeaves || 0) * (s.cocaLeavesQ || 1) + addQty * addQ) / total;
    }
    function consumeBudQuality(s, qty = 1) {
        const q = s.budsQ || 1;
        s.buds = Math.max(0, s.buds - qty);
        if (s.buds <= 0) s.budsQ = 1;
        return q;
    }
    function consumeCocaLeaves(s, qty = 1) {
        const q = s.cocaLeavesQ || 1;
        s.cocaLeaves = Math.max(0, (s.cocaLeaves || 0) - qty);
        if (s.cocaLeaves <= 0) s.cocaLeavesQ = 1;
        return q;
    }

    const UPGRADES = [
        { key: 'batch',   t: 'Bigger Batch',   d: '+4 product per cook',      cost: (l) => 150 + l * 200 },
        { key: 'speed',   t: 'Clean Lab',      d: '+15% min purity',          cost: (l) => 200 + l * 250 },
        { key: 'buyers',  t: 'More Customers',  d: '+2 buyers on the street',  cost: (l) => 250 + l * 300 },
        { key: 'stealth', t: 'Low Profile',    d: '-20% heat per sale',       cost: (l) => 300 + l * 350 },
        { key: 'cap',     t: 'Bigger Stash',   d: '+25 carry capacity',       cost: (l) => 120 + l * 160 },
    ];
    const BASE_UPGRADES = [
        { key: 'lights',    t: 'Grow Lights',   d: '+20% plant speed, better buds', cost: (l) => 220 + l * 260 },
        { key: 'security',  t: 'Security Door', d: 'Less heat, raids, robberies',   cost: (l) => 260 + l * 320 },
        { key: 'storage',   t: 'Hidden Safe',   d: '+40 stash capacity',            cost: (l) => 180 + l * 230 },
        { key: 'autoWater', t: 'Auto Waterer',  d: 'Soil dries slower',             cost: (l) => 240 + l * 280 },
    ];

    function eventActive(s, key) {
        return !!(s?.events?.[key] && (performance.now?.() || Date.now()) < s.events[key]);
    }
    function startEvent(s, key, ms = EVENT_DURATION_MS) {
        s.events ||= {};
        s.events[key] = (performance.now?.() || Date.now()) + ms;
    }
    function scheduleNextEvent(s) {
        s.nextEventAt = (performance.now?.() || Date.now()) + RANDOM_EVENT_MIN_MS + Math.random() * (RANDOM_EVENT_MAX_MS - RANDOM_EVENT_MIN_MS);
    }
    function processRandomEvents(s, layout) {
        const now = performance.now?.() || Date.now();
        if (!s.nextEventAt) scheduleNextEvent(s);
        if (now < s.nextEventAt) return;
        scheduleNextEvent(s);

        const security = s.baseUp?.security || 0;
        const pool = [
            () => {
                startEvent(s, 'buyerRush');
                s.demand = Math.min(MARKET_MAX, (s.demand || 1) + 0.18);
                showPrompt('Random event: buyer rush. Prices up.');
            },
            () => {
                startEvent(s, 'repBoost');
                showPrompt('Random event: word got out. Fire product pays more.');
            },
            () => {
                startEvent(s, 'pestBloom');
                showPrompt('Random event: pest bloom. Watch grow room.');
            },
            () => {
                if (s.rivals.length < Math.max(1, maxRivals(s) + 1)) spawnRivalDealer(s, layout);
                s.demand = Math.max(MARKET_MIN, (s.demand || 1) - 0.06);
                showPrompt('Random event: rivals pushing product.');
            },
            () => {
                const heat = Math.max(4, 18 - security * 4);
                s.heat = Math.min(160, s.heat + heat);
                showPrompt(security > 0 ? 'Random event: raid tip. Security softened heat.' : 'Random event: raid tip. Heat up.');
            },
            () => {
                startEvent(s, 'rivalTruce');
                s.demand = Math.min(MARKET_MAX, (s.demand || 1) + 0.08);
                showPrompt('Random event: rivals laying low.');
            },
        ];
        pool[(Math.random() * pool.length) | 0]();
        updateHud();
    }

    // ---- big-order bounties --------------------------------------------
    // A fat one-shot contract on the phone: move N units of a specific product
    // to a specific shirt colour before the in-game day rolls over. One active
    // at a time. Pays a flat cash bonus (on top of the normal sale) + rep.
    function bountyActive(s) {
        return !!(s.bounty && Math.floor(s._daysElapsed ?? 0) <= s.bounty.expiresDay);
    }
    function scheduleNextBounty(s) {
        const now = performance.now?.() || Date.now();
        s.nextBountyAt = now + BOUNTY_MIN_DELAY_MS + Math.random() * (BOUNTY_MAX_DELAY_MS - BOUNTY_MIN_DELAY_MS);
    }
    function rollBounty(s) {
        // Only offer products the player can actually make.
        const avail = unlockedProducts(s);
        const product = avail[(Math.random() * avail.length) | 0];
        const color = SHIRT_TONES[(Math.random() * SHIRT_TONES.length) | 0];
        // Need scales with batch size so it's a few good deals, not a grind.
        const need = (3 + ((Math.random() * 4) | 0)) * (1 + s.up.batch);
        const payout = need * BOUNTY_PAY_PER_UNIT * (PRODUCTS[product]?.priceMult || 1);
        s.bounty = {
            product, color, need, got: 0,
            payout: Math.round(payout),
            expiresDay: Math.floor(s._daysElapsed ?? 0),  // due end of the current day
        };
        showPrompt(`📋 New contract: ${need}× ${PRODUCTS[product].name} to ${colorName(color)} today — $${s.bounty.payout.toLocaleString()}`);
    }
    function processBounties(s) {
        const now = performance.now?.() || Date.now();
        // Expire a missed contract when the day flips past its due day.
        if (s.bounty && Math.floor(s._daysElapsed ?? 0) > s.bounty.expiresDay) {
            showPrompt('📋 Contract expired.');
            s.bounty = null;
            scheduleNextBounty(s);
        }
        if (!s.nextBountyAt) { scheduleNextBounty(s); return; }
        if (!s.bounty && now >= s.nextBountyAt) rollBounty(s);
    }
    function progressBounty(s, product, shirtColor, qty, wp) {
        if (!bountyActive(s)) return;
        const b = s.bounty;
        if (b.product !== product || b.color !== shirtColor) return;
        b.got += qty;
        if (b.got >= b.need) {
            s.cash += b.payout;
            if (s.today) { s.today.earned += b.payout; s.today.bounties += 1; }
            award('contract');
            changeRep(s, BOUNTY_REP_REWARD, wp);
            bigPopup(`📋 CONTRACT DONE +$${b.payout.toLocaleString()}`, '#ffe066', 1.3);
            if (wp) { cashBurst(wp.clone().setY(wp.y + 1.5), 16, '#ffe066'); try { playSfx('win', wp.clone()); } catch (e) {} }
            if (wp) floatText(`📋 CONTRACT DONE +$${b.payout.toLocaleString()}`, wp.clone().setY(wp.y + 3.4), '#ffe066');
            s.bounty = null;
            scheduleNextBounty(s);
        } else if (wp) {
            floatText(`📋 ${b.got}/${b.need}`, wp.clone().setY(wp.y + 3.4), '#cfe8ff');
        }
    }

    // ---- long-distance car deliveries ----------------------------------
    function deliveryActive(s) { return !!(s.delivery); }
    // A tall glowing beacon marking the drop-off, so it reads from far away.
    let _deliveryBeacon = null;
    function showDeliveryBeacon(pos, color = '#ffe066') {
        const { scene } = core;
        clearDeliveryBeacon();
        const g = new THREE.Group();
        const pillarMat = new DDGIMeshStandardNodeMaterial({ color: new THREE.Color(color), roughness: 0.4 });
        pillarMat.emissive = new THREE.Color(color);
        pillarMat.emissiveIntensity = 1.6;
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 18, 12), pillarMat);
        pillar.position.y = 9;
        g.add(pillar);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(DELIVERY_RADIUS, 0.25, 8, 32), pillarMat);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.1;
        g.add(ring);
        g.position.set(pos[0], pos[1] || 0, pos[2]);
        g.name = 'tycoon-delivery-beacon';
        scene?.add(g);
        _deliveryBeacon = g;
    }
    function clearDeliveryBeacon() {
        if (_deliveryBeacon) {
            try { core.scene?.remove(_deliveryBeacon); } catch (e) {}
            try { _deliveryBeacon.traverse((o) => o.geometry?.dispose?.()); } catch (e) {}
            _deliveryBeacon = null;
        }
    }
    function scheduleNextDelivery(s) {
        s.nextDeliveryAt = (performance.now?.() || Date.now()) + DELIVERY_MIN_DELAY_MS;
    }
    // Offer (accept) a delivery: pick a far chunk-centre drop, scale pay by the
    // straight-line distance from the player's house (chunk 0) + product value.
    function offerDelivery(s) {
        if (s.delivery) return;
        const avail = unlockedProducts(s);
        if (!avail.length) return;
        const product = avail[(Math.random() * avail.length) | 0];
        // Pick a far chunk: random direction, DELIVERY_MIN..MAX chunks out.
        const ang = Math.random() * Math.PI * 2;
        const chunks = DELIVERY_MIN_CHUNKS + Math.floor(Math.random() * (DELIVERY_MAX_CHUNKS - DELIVERY_MIN_CHUNKS + 1));
        const cx = Math.round(Math.cos(ang) * chunks);
        const cz = Math.round(Math.sin(ang) * chunks);
        const pos = [cx * DELIVERY_CHUNK, 0, cz * DELIVERY_CHUNK];
        const distance = Math.hypot(pos[0], pos[2]);
        const need = 2 + ((Math.random() * 4) | 0) * (1 + s.up.batch);
        const pmult = PRODUCTS[product]?.priceMult || 1;
        const payout = Math.round((need * DELIVERY_PAY_PER_UNIT + distance * DELIVERY_PAY_PER_METRE) * pmult);
        s.delivery = { product, need, payout, pos, distance: Math.round(distance), expiresDay: Math.floor(s._daysElapsed ?? 0) + 1 };
        showDeliveryBeacon(pos, PRODUCTS[product]?.color || '#ffe066');
        showPrompt(`🚚 Delivery accepted: ${need}× ${PRODUCTS[product].name}, ${Math.round(distance)}m out — $${payout.toLocaleString()}. Drive it there.`);
        updateHud();
    }
    function cancelDelivery(s, reason) {
        s.delivery = null;
        clearDeliveryBeacon();
        scheduleNextDelivery(s);
        if (reason) showPrompt(reason);
        updateHud();
    }
    // Per-frame: expire stale deliveries; once one exists, check arrival.
    function processDelivery(s, subjectPos) {
        if (!s.delivery) return;
        if (Math.floor(s._daysElapsed ?? 0) > s.delivery.expiresDay) {
            cancelDelivery(s, '🚚 Delivery expired.');
            return;
        }
        if (!subjectPos) return;
        const d = s.delivery;
        const dist = Math.hypot(subjectPos.x - d.pos[0], subjectPos.z - d.pos[2]);
        if (dist > DELIVERY_RADIUS) return;
        // In range — need the product on hand to complete.
        if (prodQty(s, d.product) < d.need) {
            showPrompt(`🚚 At drop-off — need ${d.need}× ${PRODUCTS[d.product].name} (have ${prodQty(s, d.product)})`);
            return;
        }
        // Deliver: consume product, pay out big.
        takeProduct(s, d.product, d.need);
        s.cash += d.payout;
        if (s.today) { s.today.earned += d.payout; s.today.bounties += 1; }
        changeRep(s, DELIVERY_REP_REWARD);
        award('contract');
        const wp = new THREE.Vector3(d.pos[0], (d.pos[1] || 0) + 2, d.pos[2]);
        floatText(`🚚 DELIVERED +$${d.payout.toLocaleString()}`, wp, '#ffe066');
        bigPopup(`🚚 DELIVERED +$${d.payout.toLocaleString()}`, '#ffe066', 1.3);
        try { cashBurst(wp.clone(), 16, '#ffe066'); playSfx('win', wp.clone()); } catch (e) {}
        cancelDelivery(s, null);
    }

    // ---- phone order: the buyer (by shirt colour) you must deliver to ----
    // Human-readable names for the shirt palette, shown on the phone.
    const COLOR_NAMES = {
        '#3da6ff': 'Blue', '#2dd4bf': 'Teal', '#f97316': 'Orange',
        '#a855f7': 'Purple', '#eab308': 'Yellow', '#ef4444': 'Red',
    };
    function colorName(hex) { return COLOR_NAMES[hex] || hex; }

    // Pick a fresh order from a currently-living buyer's shirt colour. Falls
    // back to a random palette colour if no buyers exist yet.
    function pickOrder(s) {
        // Prefer a non-narc buyer for the order so the marked customer is a safe
        // deal; only fall back to the full pool if every live buyer is a narc.
        const all = s.npcs.filter((n) => n.mesh && n.wantsBuy);
        const live = all.filter((n) => !n.isNarc).length ? all.filter((n) => !n.isNarc) : all;
        if (live.length) {
            s.orderColor = live[(Math.random() * live.length) | 0].shirtColor;
        } else {
            s.orderColor = SHIRT_TONES[(Math.random() * SHIRT_TONES.length) | 0];
        }
        return s.orderColor;
    }
    // Ensure there's always a valid order pointing at a living buyer.
    function ensureOrder(s) {
        const stillHere = s.orderColor && s.npcs.some((n) => n.mesh && n.wantsBuy && n.shirtColor === s.orderColor);
        if (!stillHere) pickOrder(s);
    }

    let _phoneEl = null;
    function setPhone(open) {
        const s = ensureState();
        s.phoneOpen = !!open;
        if (s.phoneOpen) renderPhone(); else hidePhone();
    }
    function togglePhone() {
        const s = window.drugTycoon;
        if (!s) return;
        // Only usable on the street (not in menus / grow room).
        if (s.shopOpen || s.seedShopOpen || s.juiceShopOpen || s.cooking || s.inRoom) return;
        setPhone(!s.phoneOpen);
    }
    // [Q] cycles which unlocked product line you deal next.
    function cycleSellProduct() {
        const s = window.drugTycoon;
        if (!s) return;
        if (s.shopOpen || s.seedShopOpen || s.juiceShopOpen || s.cooking || s.inRoom) return;
        const avail = unlockedProducts(s);
        if (avail.length < 2) return;
        const i = avail.indexOf(s.sellProduct);
        s.sellProduct = avail[(i + 1) % avail.length];
        const d = PRODUCTS[s.sellProduct];
        showPrompt(`Dealing ${d.emoji} ${d.name}`);
        updateHud();
    }
    function ensurePhoneEl() {
        if (_phoneEl?.parentNode) return _phoneEl;
        const el = document.createElement('div');
        el.className = 'tycoon-overlay';
        el.style.cssText = 'position:absolute;right:22px;bottom:90px;z-index:1100;'
            + 'width:190px;pointer-events:none;font-family:"Trebuchet MS",system-ui,sans-serif;'
            + 'border-radius:22px;padding:14px 14px 18px;'
            + 'background:linear-gradient(170deg,#0d0f14,#171b22);'
            + 'box-shadow:0 12px 40px rgba(0,0,0,0.6);border:2px solid #2b313c;';
        (document.getElementById('canvas-container') || document.body)?.appendChild(el);
        _phoneEl = el;
        return el;
    }
    function renderPhone() {
        const s = ensureState();
        ensureOrder(s);
        const el = ensurePhoneEl();
        el.style.display = 'block';
        const c = s.orderColor || '#888';
        const night = isNight(s);
        const grade = qualityGrade(s.stashQ || 1);
        el.innerHTML =
            // Status bar: live clock + day/night.
            `<div style="display:flex;justify-content:space-between;align-items:center;font:700 12px/1 inherit;color:#cdd6e3;margin-bottom:8px;">`
            + `<span>${dayClock(s)}</span><span>${night ? '🌙 Night' : '☀️ Day'}</span></div>`
            + '<div style="height:5px;width:46px;background:#2b313c;border-radius:3px;margin:0 auto 12px;"></div>'
            + '<div style="font:800 13px/1.2 inherit;color:#7fd0ff;letter-spacing:.5px;margin-bottom:4px;">📱 DEAL APP</div>'
            + '<div style="font:600 12px/1.3 inherit;color:#9aa3b2;margin-bottom:12px;">Deliver to the customer wearing:</div>'
            + `<div style="width:100%;height:84px;border-radius:14px;background:${c};box-shadow:inset 0 0 0 3px rgba(255,255,255,0.15);"></div>`
            + `<div style="text-align:center;font:900 20px/1.2 inherit;color:#eef3ff;margin-top:10px;">${colorName(c)}</div>`
            + `<div style="text-align:center;font:600 11px/1.3 inherit;color:#7c8696;margin-top:6px;">Orders filled: ${s.ordersFilled}</div>`
            + (s.stash > 0 ? `<div style="text-align:center;font:700 11px/1.3 inherit;color:${grade.color};margin-top:6px;">Product: ${grade.name} ${Math.round(s.stashQ * 100)}%</div>` : '')
            // ---- live market ticker -------------------------------------
            + (() => {
                const mk = marketLabel(s);
                const hc = s.hotColor || '#888';
                return '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #2b313c;">'
                    + '<div style="font:800 11px/1 inherit;color:#7fd0ff;letter-spacing:.5px;margin-bottom:6px;">📈 MARKET</div>'
                    + `<div style="display:flex;justify-content:space-between;align-items:center;font:700 12px/1 inherit;color:#cdd6e3;">`
                    + `<span>Demand</span><span style="color:${mk.c};">${mk.t} · x${(s.demand || 1).toFixed(2)}</span></div>`
                    + `<div style="display:flex;justify-content:space-between;align-items:center;font:700 12px/1 inherit;color:#cdd6e3;margin-top:6px;">`
                    + `<span>Hot buyer +${Math.round(HOT_BONUS * 100)}%</span>`
                    + `<span style="display:inline-flex;align-items:center;gap:5px;">🔥 <span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:${hc};"></span> ${colorName(hc)}</span></div>`
                    + '</div>';
            })()
            // ---- reputation block ---------------------------------------
            + (() => {
                const rt = repTier(s);
                const r = Math.round(s.rep ?? REP_START);
                const pct = Math.max(0, Math.min(100, r));
                return '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #2b313c;">'
                    + '<div style="font:800 11px/1 inherit;color:#7fd0ff;letter-spacing:.5px;margin-bottom:6px;">⭐ REPUTATION</div>'
                    + `<div style="display:flex;justify-content:space-between;align-items:center;font:700 12px/1 inherit;color:#cdd6e3;">`
                    + `<span>Status</span><span style="color:${rt.color};">${rt.name}</span></div>`
                    + `<div style="height:8px;border-radius:4px;background:#2b313c;margin-top:7px;overflow:hidden;">`
                    + `<div style="width:${pct}%;height:100%;background:${rt.color};"></div></div>`
                    + `<div style="display:flex;justify-content:space-between;align-items:center;font:600 11px/1 inherit;color:#7c8696;margin-top:5px;">`
                    + `<span>Customers waiting: ${rt.target}</span><span>${r}/100</span></div>`
                    + '</div>';
            })()
            // ---- active big-order contract ------------------------------
            + (() => {
                if (!bountyActive(s)) return '';
                const b = s.bounty;
                const pd = PRODUCTS[b.product];
                const pct = Math.max(0, Math.min(100, (b.got / b.need) * 100));
                return '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #2b313c;">'
                    + '<div style="font:800 11px/1 inherit;color:#ffe066;letter-spacing:.5px;margin-bottom:6px;">📋 CONTRACT</div>'
                    + `<div style="font:700 12px/1.3 inherit;color:#eef3ff;">${b.need}× ${pd.emoji} ${pd.name} → `
                    + `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${b.color};vertical-align:middle;"></span> ${colorName(b.color)}</div>`
                    + `<div style="height:8px;border-radius:4px;background:#2b313c;margin-top:7px;overflow:hidden;">`
                    + `<div style="width:${pct}%;height:100%;background:#ffe066;"></div></div>`
                    + `<div style="display:flex;justify-content:space-between;align-items:center;font:600 11px/1 inherit;color:#7c8696;margin-top:5px;">`
                    + `<span>${b.got}/${b.need} delivered</span><span style="color:#9dffa0;">+$${b.payout.toLocaleString()}</span></div>`
                    + '<div style="font:600 10px/1.3 inherit;color:#ff9a9a;margin-top:4px;">Due by end of day</div>'
                    + '</div>';
            })()
            + '<div style="text-align:center;font:600 11px/1.3 inherit;color:#566;margin-top:10px;">[P] to close</div>';
    }
    function hidePhone() { if (_phoneEl) _phoneEl.style.display = 'none'; }

    // ---- how-to-play help ("?" button + panel) -------------------------
    // A small "?" FAB (works on PC click + mobile tap) that pops a panel
    // explaining how to play this game mode. Lives entirely in this module.
    const HELP_TITLE = 'DRUG TYCOON — HOW TO PLAY';
    const HELP_LINES = [
        '🌱 SEEDS: Plants need seeds! Buy them at the outdoor SEED SHOP [E] (the green kiosk on the street). Weed seeds make buds; Coca Seeds grow slow shrubs that harvest into coca leaves for the coke lab. The tier you last bought is the one you plant.',
        '🧪 GROW JUICE: A second outdoor kiosk on the other side of the street. Three tiers of grow juice (Compost Tea / Liquid Bloom / Hydro Elixir). Buy a bottle, then hold Fire near a growing plant to pour it on — that plant grows 2.2×–4.6× faster for the rest of its cycle. One pour per plant; the boost clears at harvest.',
        '🌿 GROW: At home — [E] plant a seed (consumes one from stock), [E] water it. Soil dries out: keep re-watering [E] or growth stalls. 🐛 Pests strike randomly — hold Fire near the plant to spray ($25). Healthy plants yield more buds. [E] harvest when ripe, then drag buds into the bag (hold Fire) to package.',
        '❄️ COKE LAB: Buy a Coke Lab at the upgrade desk, grow Coca Seeds for raw coca leaves, then use the glassware bench INSIDE your house [E] (NW corner). Coke is cooked in a 4-step craft: ⚗️ measure the base → 🧪 dissolve & wash → 🔥 cook the rock → 🔪 cut & bag.',
        '💊 PILL LAB: Buy a Pill Press at the upgrade desk, then use the stainless lab bench INSIDE your house [E] (NE corner). Pills are pressed in a 4-step craft: ⚖️ weigh the dose → 🌀 blend → 🛠️ press the tablets → 🔖 stamp. Nail each timing/precision check for high purity.',
        '💎 METH LAB: Buy a Meth Lab, then cook at the heated bench INSIDE (east wall) [E]. Unique craft: ⚗️ measure precursor → 🔥 HOLD the cook temperature riding the moving green window (mash to add heat; too cold stalls, too hot scorches) → 🧊 crystallise. Pays ~4.2×, runs very hot.',
        '🌈 LSD LAB: Buy an LSD Lab, then work the blotter station INSIDE (west wall) [E]. Unique craft: ⚗️ dose the solution → 💧 DROP tabs onto the sweeping target (precision taps). Pays ~5×, lower heat.',
        '🍄 SHROOMS: Buy a Mushroom Bed, substrate, spawn, Spray Bottle, AC Unit(s), and Drying Rack. Keep the bed under 15C (2 cool AC units = 0C), mist blue spray targets, harvest wet shrooms, then dry them on racks. 2 heat AC units = 40C and halves drying time.',
        '💊❄️💎🌈🍄 PRODUCT LINES: Six lines — 🌿 weed (grown), 🍄 shrooms (~1.5×), 💊 pills (~1.9×), ❄️ coke (~3.4×), 💎 meth (~4.2×), 🌈 LSD (~5×). Higher tiers pay far more but most burn more heat. Press [Q] to choose which line you deal.',
        '📋 CONTRACTS: Your phone occasionally lists a fat one-shot contract — deliver N units of a specific product to a specific shirt colour before the day ends for a big cash bonus + rep. Normal sales to that customer count toward it.',
        '🧪 QUALITY: Plant health, grow lights, and recipe accuracy set grade. Better grade pays more and draws less heat.',
        '📱 ORDERS: Press [P] for your phone. Sell only to the customer whose shirt matches the order colour [E].',
        '💰 SELL: Each deal pays out but raises your Wanted level (stars). Heat cools over time.',
        '⭐ REPUTATION: Your street rep (Pariah → Shady → Known → Respected → Legend) decides how many customers come to your shop. Selling quality product builds rep fast; trash product, narc deals, and busts tank it. Check your phone for the live status.',
        '📈 MARKET: Prices swing daily (check the phone). The 🔥 hot buyer pays a bonus. Chain deals fast for a COMBO cash multiplier.',
        '🎲 EVENTS: Buyer rushes, pest blooms, raid tips, rival moves, and reputation buzz can hit anytime.',
        '🧍 RIVALS: Rival dealers poach buyers and can rob stash. Scare them off, or invest in security. 🔫 Get notorious (high heat) and armed rivals start hunting you — they chase and shoot. Gun them down (or bat them) for a $250 bounty each.',
        '🚨 NARCS: Some buyers are undercover — they glance around nervously up close. Sell to one and your heat spikes hard. Read the tell.',
        '⭐ HEAT: More stars = more cops. Busted = lose all product + a fine, wake up home next morning. Bribe the cops at the desk to clear heat fast.',
        '🌙 NIGHT: After 21:00 patrols roam the streets. Sleep in bed [E] to skip to morning.',
        '🔫 WEAPONS: Buy a pistol, ammo, or a bat at the upgrade desk in the room. Fire to shoot/swing.',
        '🏠 BASE: Buy grow lights, security, hidden storage, and auto-water at the desk.',
        '🚗 CAR: Buy the car at the upgrade desk ($2,500). It parks behind the house (drive with [E] to get in) and unlocks 🚚 long-distance DELIVERY contracts — drive N units of a product to a far drop-off marker for a big distance-scaled payout + rep.',
        '🤝 CREW: Build a customer up to ★ VIP loyalty (16+ clean deals to the same shirt colour), then walk up and [E] hire them as a dealer ($1,500). Hired dealers (green cap) roam the streets and auto-sell your stash for cash — minus their 30% wage cut — adding a little heat. They can get busted on a hot block. Run up to 4 at once for passive income while you grow and cook. ⬆ Dealers RANK UP as they sell (Runner → Dealer → Pusher → Slinger → Kingpin) — higher ranks sell faster + in bigger bundles, keep a smaller wage cut, and are much harder to bust. Their cap colour shows their rank.',
    ];

    let _helpBtnEl = null;
    let _helpPanelEl = null;
    // The green "?" help FAB is removed on both PC and mobile. The how-to-play
    // panel is still reachable via toggleHelp() (e.g. a keybind), just no FAB.
    function ensureHelpButton() {
        if (_helpBtnEl?.parentNode) { _helpBtnEl.remove(); _helpBtnEl = null; }
        return null;
    }
    function toggleHelp() {
        const s = ensureState();
        s.helpOpen = !s.helpOpen;
        if (s.helpOpen) renderHelp(); else hideHelp();
    }
    function renderHelp() {
        if (_helpPanelEl?.parentNode) _helpPanelEl.remove();
        const overlay = document.createElement('div');
        overlay.className = 'tycoon-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:1300;pointer-events:auto;'
            + 'background:rgba(4,10,8,0.86);backdrop-filter:blur(3px);display:flex;'
            + 'flex-direction:column;align-items:center;justify-content:center;'
            + 'font-family:"Trebuchet MS",system-ui,sans-serif;color:#eaffea;padding:20px;box-sizing:border-box;';
        const card = document.createElement('div');
        card.style.cssText = 'max-width:560px;width:100%;background:linear-gradient(160deg,rgba(18,40,26,0.96),rgba(8,20,12,0.96));'
            + 'border:2px solid rgba(120,255,160,0.5);border-radius:16px;padding:24px 26px;'
            + 'box-shadow:0 12px 40px rgba(0,0,0,0.6);';
        card.innerHTML = `<div style="font:900 24px/1.1 inherit;color:#9dffa0;margin-bottom:16px;text-align:center;">${HELP_TITLE}</div>`
            + HELP_LINES.map((l) => `<div style="font:600 15px/1.5 inherit;margin-bottom:10px;opacity:.95;">${l}</div>`).join('');
        overlay.appendChild(card);
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'GOT IT';
        close.style.cssText = 'margin-top:18px;padding:12px 34px;cursor:pointer;font:800 18px/1 inherit;color:#0a140e;'
            + 'border-radius:12px;background:linear-gradient(160deg,#9dffa0,#3fbf5f);border:2px solid rgba(0,0,0,0.25);';
        close.addEventListener('click', (e) => { e.preventDefault(); toggleHelp(); });
        overlay.appendChild(close);
        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        _helpPanelEl = overlay;
        // Pause the sim + free the cursor while reading, like the other menus.
        gameplay.roguePaused = true;
        try { document.exitPointerLock?.(); } catch (e) {}
    }
    function hideHelp() {
        if (_helpPanelEl?.parentNode) _helpPanelEl.remove();
        _helpPanelEl = null;
        const s = window.drugTycoon;
        if (s) s.helpOpen = false;
        gameplay.roguePaused = false;
    }
    function getHowToPlay() {
        return { title: HELP_TITLE, lines: HELP_LINES.slice() };
    }

    // ---- interact key (on-foot E edge) ----------------------------------
    let _interactQueued = false;
    let _keyHandler = null;
    function installInteractKey() {
        if (_keyHandler || typeof window === 'undefined') return;
        _keyHandler = (e) => {
            // The pill lab takes over E/Space + Esc while it's open. Every stage
            // is a tap (mashing in the press stage benefits from key-repeat).
            if (window.drugTycoon?.pillGame) {
                if (e.code === 'Escape') { closePillLab(); return; }
                if (e.code === 'KeyE' || e.code === 'Space') { pillAction(); return; }
                return;
            }
            // Day-summary modal eats input: any of E / Space / Esc / Enter
            // dismisses it and nothing leaks through to the world.
            if (window.drugTycoon?.summaryOpen) {
                if (['KeyE', 'Space', 'Escape', 'Enter'].includes(e.code)) closeDaySummary();
                return;
            }
            if (e.repeat) return;
            if (e.code === 'KeyE') _interactQueued = true;
            if (e.code === 'KeyP') togglePhone();
            if (e.code === 'KeyH') toggleHelp();
            if (e.code === 'KeyQ') cycleSellProduct();
            if (e.code === 'Escape' && window.drugTycoon?.helpOpen) hideHelp();
            if (e.code === 'Escape' && window.drugTycoon?.phoneOpen) setPhone(false);
            if (e.code === 'Escape' && window.drugTycoon?.shopOpen) closeShop();
            if (e.code === 'Escape' && window.drugTycoon?.seedShopOpen) closeSeedShop();
            if (e.code === 'Escape' && window.drugTycoon?.juiceShopOpen) closeJuiceShop();
            if (e.code === 'Escape' && window.drugTycoon?.shroomPanelOpen) closeShroomPanel();
            if (e.code === 'Escape' && window.drugTycoon?.cooking) closeCook();
            if (e.code === 'Escape' && window.drugTycoon?.baggingOpen) closeBagging();
        };
        window.addEventListener('keydown', _keyHandler);
    }
    function consumeInteract() {
        const v = _interactQueued;
        _interactQueued = false;
        return v;
    }
    // Mobile (no keyboard): the Action 2 button calls this to fire one interact.
    function queueInteract() {
        const s = window.drugTycoon;
        if (s?.shopOpen) { closeShop(); return; }
        if (s?.seedShopOpen) { closeSeedShop(); return; }
        if (s?.juiceShopOpen) { closeJuiceShop(); return; }
        if (s?.shroomPanelOpen) { closeShroomPanel(); return; }
        if (s?.cooking) { closeCook(); return; }
        if (s?.baggingOpen) { closeBagging(); return; }
        _interactQueued = true;
    }

    // ---- HUD ------------------------------------------------------------
    let _hudEl = null;
    function ensureHud() {
        if (_hudEl?.parentNode) return _hudEl;
        const el = document.createElement('div');
        el.className = 'tycoon-overlay';
        el.style.cssText = 'position:absolute;left:18px;top:16px;pointer-events:none;'
            + 'z-index:996;font:700 16px/1.5 "Trebuchet MS",system-ui,sans-serif;'
            + 'color:#e8ffe8;text-shadow:0 2px 6px rgba(0,0,0,0.85);';
        (document.getElementById('canvas-container') || document.body)?.appendChild(el);
        _hudEl = el;
        return el;
    }
    function updateHud() {
        const { currentMesh } = core;
        const inLevel = currentMesh?.userData?.sampleType === 'drugTycoon' && gameplay.active;
        if (!inLevel) {
            if (_hudEl) _hudEl.style.display = 'none';
            if (_helpBtnEl) _helpBtnEl.style.display = 'none';
            return;
        }
        const s = ensureState();
        const el = ensureHud();
        el.style.display = 'block';
        const helpBtn = ensureHelpButton();           // "?" help FAB (PC only)
        if (helpBtn) helpBtn.style.display = 'block';
        const stars = wantedStars(s);
        const starColor = stars >= 4 ? '#ff4d4d' : stars >= 2 ? '#ffae00' : '#ffd24a';
        const mk = marketLabel(s);
        const combo = comboActive(s) ? comboMult(s) : 1;
        const grade = qualityGrade(s.stashQ || 1);
        const activeEventNames = [
            eventActive(s, 'buyerRush') ? 'Buyer rush' : '',
            eventActive(s, 'repBoost') ? 'Quality buzz' : '',
            eventActive(s, 'pestBloom') ? 'Pest bloom' : '',
            eventActive(s, 'rivalTruce') ? 'Rival truce' : '',
        ].filter(Boolean).join(' · ');
        el.innerHTML =
            `<div style="font-size:22px;color:#9dffa0;">$${Math.floor(s.cash).toLocaleString()}</div>`
            + (() => {
                // One line per unlocked product line; the selected line is marked
                // and shows its grade. Weed always shown (carry cap is its own).
                const lines = unlockedProducts(s).map((k) => {
                    const d = PRODUCTS[k];
                    const qty = prodQty(s, k);
                    const sel = k === s.sellProduct;
                    const g = qualityGrade(prodQual(s, k));
                    const arrow = sel ? '▶ ' : '   ';
                    const gradeStr = qty > 0 ? ` · <span style="color:${g.color};">${g.name}</span> ${Math.round(prodQual(s, k) * 100)}%` : '';
                    return `<div style="color:${sel ? d.color : '#cdd6e3'};${sel ? 'font-weight:700;' : 'opacity:.8;'}">${arrow}${d.emoji} ${d.name}: ${qty} / ${prodCap(s, k)}${gradeStr}</div>`;
                }).join('');
                const hint = unlockedProducts(s).length > 1 ? '<div style="opacity:.5;font-size:11px;">[Q] switch deal line</div>' : '';
                return lines + hint;
            })()
            + (s.buds > 0 ? `<div style="color:#b6ff6a;">Buds: ${s.buds} · ${Math.round((s.budsQ || 1) * 100)}%</div>` : '')
            + ((s.cocaLeaves || 0) > 0 ? `<div style="color:#bfe9ff;">Coca leaves: ${s.cocaLeaves} · ${Math.round((s.cocaLeavesQ || 1) * 100)}%</div>` : '')
            + ((s.inRoom && s.hasShrooms) ? `<div style="color:#d8a0ff;">Shroom bed: ${shroomBedTemp(s)}C · AC ${s.shroomAcMode}${s.shroomRun?.phase === 'growing' ? ` · ${Math.round((s.shroomRun.progress || 0) * 100)}%` : ''}</div>` : '')
            + ((s.wetShrooms || 0) > 0 ? `<div style="color:#d8a0ff;">Wet shrooms: ${s.wetShrooms} · ${Math.round((s.wetShroomsQ || 1) * 100)}%</div>` : '')
            + (s.shroomDrying?.qty ? `<div style="color:#d8a0ff;">Drying: ${Math.round((s.shroomDrying.progress || 0) * 100)}% · rack ${shroomRackTemp(s)}C</div>` : '')
            + ((s.inRoom || totalSeeds(s) > 0) ? `<div style="color:${SEED_TIERS[pickPlantTier(s)]?.color || '#8aa0aa'};">🌱 Seeds: ${totalSeeds(s)}${pickPlantTier(s) >= 0 ? ` · ${SEED_TIERS[pickPlantTier(s)].t.replace(' Seeds', '')}` : ' — buy outside'}</div>` : '')
            + ((s.inRoom || totalJuices(s) > 0) ? `<div style="color:${JUICE_TIERS[pickJuiceTier(s)]?.color || '#8aa0aa'};">🧪 Juice: ${totalJuices(s)}${pickJuiceTier(s) >= 0 ? ` · ${JUICE_TIERS[pickJuiceTier(s)].t}` : ''}</div>` : '')
            + (!s.inRoom ? `<div style="opacity:.92;">Market: <b style="color:${mk.c}">${mk.t}</b> <span style="opacity:.6;font-size:12px;">x${(s.demand || 1).toFixed(2)}</span></div>` : '')
            + ((s.rivals?.length || 0) > 0 && !s.inRoom ? (() => {
                const armed = s.rivals.filter((r) => r.armed).length;
                return armed > 0
                    ? `<div style="color:#ff5a5a;font-weight:700;">🔫 Armed rivals: ${armed}${s.rivals.length > armed ? ` (+${s.rivals.length - armed})` : ''}</div>`
                    : `<div style="color:#ff8a8a;">Rivals nearby: ${s.rivals.length}</div>`;
            })() : '')
            + ((s.crew?.length || 0) > 0 ? (() => {
                const top = s.crew.reduce((a, c) => Math.max(a, c.rank || 0), 0);
                return `<div style="color:#2ec27a;font-weight:700;">🤝 Crew: ${s.crew.length}/${CREW_MAX} · top ${CREW_RANKS[top].name}</div>`;
            })() : '')
            + (activeEventNames ? `<div style="color:#ffd24a;">Event: ${activeEventNames}</div>` : '')
            + (combo > 1 ? `<div style="color:#7fd0ff;">🔥 Combo x${combo.toFixed(2).replace(/0$/, '')}</div>` : '')
            + (() => {
                const rt = repTier(s);
                const r = Math.round(s.rep ?? REP_START);
                const blocks = Math.round((r / 100) * 10);
                const bar = '█'.repeat(blocks) + '░'.repeat(10 - blocks);
                return `<div style="color:${rt.c || rt.color};">Rep: <b>${rt.name}</b> <span style="opacity:.7;font-family:monospace;font-size:12px;">${bar}</span> <span style="opacity:.6;font-size:12px;">${r}</span></div>`;
            })()
            + (() => {
                // Regulars: count colours that have climbed above New, with the
                // best tier's badge. Hidden until you actually have a regular.
                const recs = Object.values(s.loyalty || {});
                const regs = recs.filter((rr) => (rr.tier || 0) > 0);
                if (!regs.length || s.inRoom) return '';
                const best = LOYALTY_TIERS[Math.max(...regs.map((rr) => rr.tier || 0))];
                return `<div style="color:${best.color};">Regulars: <b>${regs.length}</b> <span style="opacity:.7;font-size:12px;">top ${best.badge} ${best.name}</span></div>`;
            })()
            + `<div style="color:${starColor};letter-spacing:1px;">Wanted: ${starString(stars)}${stars >= 1 ? '  ⚠ POLICE' : ''}</div>`
            + `<div style="opacity:.9;">${isNight(s) ? '🌙' : '☀️'} ${dayClock(s)}${isNight(s) ? ' <span style="color:#ff9a9a;font-size:12px;">· patrols out</span>' : ''}</div>`
            + (s.orderColor && !s.inRoom ? `<div style="opacity:.85;">Order: <span style="display:inline-block;width:11px;height:11px;border-radius:2px;background:${s.orderColor};vertical-align:middle;"></span> ${colorName(s.orderColor)} <span style="opacity:.6;font-size:12px;">[P] phone</span></div>` : '')
            + (s.delivery && !s.inRoom ? `<div style="color:${PRODUCTS[s.delivery.product]?.color || '#ffe066'};">🚚 Delivery: ${s.delivery.need}× ${PRODUCTS[s.delivery.product].name} · ${s.delivery.distance}m · $${s.delivery.payout.toLocaleString()}</div>` : '')
            + ((s.hasGun || s.hasBat) ? `<div style="opacity:.9;">${s.hasGun ? `🔫 ${s.ammo}` : ''}${s.hasGun && s.hasBat ? ' · ' : ''}${s.hasBat ? '🏏 Bat' : ''}</div>` : '')
            + `<div style="opacity:.7;font-size:13px;">Sales ${s.sales} · Busts ${s.busted}</div>`;
    }

    // ---- interaction prompt --------------------------------------------
    let _promptEl = null;
    function showPrompt(text) {
        if (!_promptEl?.parentNode) {
            const el = document.createElement('div');
            el.className = 'tycoon-overlay';
            el.style.cssText = 'position:absolute;left:50%;bottom:96px;transform:translateX(-50%);'
                + 'pointer-events:none;z-index:997;text-align:center;'
                + 'font:800 18px/1.3 "Trebuchet MS",system-ui,sans-serif;color:#fff;'
                + 'background:rgba(8,16,12,0.7);padding:8px 16px;border-radius:10px;'
                + 'border:1px solid rgba(120,255,160,0.4);text-shadow:0 2px 4px rgba(0,0,0,0.8);';
            (document.getElementById('canvas-container') || document.body)?.appendChild(el);
            _promptEl = el;
        }
        _promptEl.style.display = 'block';
        _promptEl.innerHTML = text;
    }
    function hidePrompt() { if (_promptEl) _promptEl.style.display = 'none'; }

    // ---- floating cash text --------------------------------------------
    let _floatLayer = null;
    const _tmpProj = new THREE.Vector3();
    const _tmpFloat = new THREE.Vector3();
    function floatText(text, worldPos, color = '#9dffa0') {
        const { camera, renderer } = core;
        if (!camera || !renderer || !worldPos) return;
        if (!_floatLayer?.parentNode) {
            const el = document.createElement('div');
            el.className = 'tycoon-overlay';
            el.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:997;overflow:hidden;';
            (document.getElementById('canvas-container') || document.body)?.appendChild(el);
            _floatLayer = el;
        }
        const v = _tmpFloat.copy(worldPos).project(camera);
        if (v.z > 1) return;
        const rect = renderer.domElement.getBoundingClientRect();
        const host = (document.getElementById('canvas-container') || document.body).getBoundingClientRect();
        const x = rect.left - host.left + (v.x * 0.5 + 0.5) * rect.width;
        const y = rect.top - host.top + (-v.y * 0.5 + 0.5) * rect.height;
        const node = document.createElement('div');
        node.textContent = text;
        node.style.cssText = `position:absolute;left:${x}px;top:${y}px;transform:translate(-50%,-50%);`
            + `color:${color};font:900 20px/1 "Trebuchet MS",system-ui,sans-serif;`
            + `text-shadow:0 2px 6px rgba(0,0,0,0.9);transition:transform .8s ease,opacity .8s ease;opacity:1;`;
        _floatLayer.appendChild(node);
        requestAnimationFrame(() => {
            node.style.transform = 'translate(-50%,-50%) translateY(-52px)';
            node.style.opacity = '0';
        });
        setTimeout(() => node.remove(), 820);
    }

    // ---- juice: center-screen popup + cash particle burst --------------
    // A big screen-center callout that punches in then fades — for combos and
    // milestones. Bigger `scale` = beefier hit. Reuses the float layer.
    function bigPopup(text, color = '#7fd0ff', scale = 1) {
        if (!_floatLayer?.parentNode) { floatText('', null); }     // ensure layer
        const layer = _floatLayer;
        if (!layer) return;
        const node = document.createElement('div');
        node.textContent = text;
        node.style.cssText = 'position:absolute;left:50%;top:38%;transform:translate(-50%,-50%) scale(0.4);'
            + `color:${color};font:900 ${Math.round(40 * scale)}px/1 "Trebuchet MS",system-ui,sans-serif;`
            + 'text-shadow:0 3px 14px rgba(0,0,0,0.95),0 0 24px currentColor;'
            + 'transition:transform .18s cubic-bezier(.2,1.6,.4,1),opacity .5s ease .4s;opacity:1;white-space:nowrap;';
        layer.appendChild(node);
        requestAnimationFrame(() => {
            node.style.transform = 'translate(-50%,-50%) scale(1)';
            node.style.opacity = '0';
        });
        setTimeout(() => node.remove(), 950);
    }
    // A burst of little "$" glyphs that pop off a world point and float up — the
    // cash-money confetti on a sale.
    function cashBurst(worldPos, count = 6, color = '#9dffa0') {
        const { camera, renderer } = core;
        if (!camera || !renderer || !worldPos) return;
        if (!_floatLayer?.parentNode) { floatText('', null); }
        const layer = _floatLayer;
        if (!layer) return;
        const v = _tmpFloat.copy(worldPos).project(camera);
        if (v.z > 1) return;
        const rect = renderer.domElement.getBoundingClientRect();
        const host = (document.getElementById('canvas-container') || document.body).getBoundingClientRect();
        const x = rect.left - host.left + (v.x * 0.5 + 0.5) * rect.width;
        const y = rect.top - host.top + (-v.y * 0.5 + 0.5) * rect.height;
        for (let i = 0; i < count; i++) {
            const node = document.createElement('div');
            node.textContent = '$';
            const dx = (Math.random() - 0.5) * 90;
            const dy = -40 - Math.random() * 70;
            node.style.cssText = `position:absolute;left:${x}px;top:${y}px;transform:translate(-50%,-50%);`
                + `color:${color};font:900 ${14 + (Math.random() * 10) | 0}px/1 "Trebuchet MS",system-ui,sans-serif;`
                + 'text-shadow:0 2px 5px rgba(0,0,0,0.9);transition:transform .7s ease,opacity .7s ease;opacity:1;';
            layer.appendChild(node);
            requestAnimationFrame(() => {
                node.style.transform = `translate(-50%,-50%) translate(${dx}px,${dy}px) rotate(${(Math.random() - 0.5) * 60}deg)`;
                node.style.opacity = '0';
            });
            setTimeout(() => node.remove(), 720);
        }
    }

    // ---- achievement toasts --------------------------------------------
    // award(key) unlocks once (idempotent via awards.js) and, on the FIRST
    // unlock, pops a slide-in toast + plays a little chime. Toasts stack down
    // the right edge and auto-dismiss; all 15 drugTycoon milestones route
    // through here so the feedback is uniform.
    const _awardMeta = Object.fromEntries((AWARD_CATALOG.drugTycoon || []).map((a) => [a.key, a]));
    let _toastLayer = null;
    function ensureToastLayer() {
        if (_toastLayer?.parentNode) return _toastLayer;
        const el = document.createElement('div');
        el.className = 'tycoon-overlay';
        el.style.cssText = 'position:absolute;right:16px;top:84px;z-index:1300;pointer-events:none;'
            + 'display:flex;flex-direction:column;gap:10px;align-items:flex-end;';
        (document.getElementById('canvas-container') || document.body)?.appendChild(el);
        _toastLayer = el;
        return el;
    }
    function showAwardToast(key) {
        const meta = _awardMeta[key] || { icon: '🏆', label: key };
        const layer = ensureToastLayer();
        const m = isMobileUi();
        const t = document.createElement('div');
        t.style.cssText = `display:flex;align-items:center;gap:${m ? 8 : 12}px;`
            + `padding:${m ? '8px 12px' : '12px 18px'};border-radius:12px;max-width:${m ? '74vw' : '340px'};`
            + 'background:linear-gradient(160deg,rgba(24,58,34,0.97),rgba(10,28,16,0.97));'
            + 'border:2px solid rgba(120,255,160,0.6);box-shadow:0 8px 30px rgba(0,0,0,0.55);'
            + 'font-family:"Trebuchet MS",system-ui,sans-serif;color:#eaffea;'
            + 'transform:translateX(120%);transition:transform .35s cubic-bezier(.2,.8,.2,1),opacity .35s ease;opacity:0;';
        t.innerHTML = `<span style="font-size:${m ? 26 : 34}px;line-height:1;">${meta.icon}</span>`
            + `<span><span style="display:block;font:800 ${m ? 10 : 12}px/1 inherit;color:#9dffa0;letter-spacing:.5px;opacity:.85;">ACHIEVEMENT UNLOCKED</span>`
            + `<span style="display:block;font:800 ${m ? 13 : 16}px/1.2 inherit;margin-top:3px;">${meta.label}</span></span>`;
        layer.appendChild(t);
        requestAnimationFrame(() => { t.style.transform = 'translateX(0)'; t.style.opacity = '1'; });
        setTimeout(() => { t.style.transform = 'translateX(120%)'; t.style.opacity = '0'; }, 3600);
        setTimeout(() => t.remove(), 4000);
    }
    function award(key) {
        if (unlockAward('drugTycoon', key)) {
            try { playSfx('ding'); } catch (e) {}
            showAwardToast(key);
            return true;
        }
        return false;
    }

    // ---- objective compass ---------------------------------------------
    // A small floating chevron near screen-bottom that points toward the
    // current goal (the order buyer if one is alive, else the cook station when
    // out of product, else home). Purely a navigation aid on the street.
    let _compassEl = null;
    const _compassTmp = new THREE.Vector3();
    function ensureCompass() {
        if (_compassEl?.parentNode) return _compassEl;
        const el = document.createElement('div');
        el.className = 'tycoon-overlay';
        el.style.cssText = 'position:absolute;left:50%;bottom:140px;transform:translateX(-50%);'
            + 'pointer-events:none;z-index:996;text-align:center;'
            + 'font:800 13px/1.2 "Trebuchet MS",system-ui,sans-serif;color:#eef3ff;'
            + 'text-shadow:0 2px 5px rgba(0,0,0,0.85);display:none;';
        (document.getElementById('canvas-container') || document.body)?.appendChild(el);
        _compassEl = el;
        return el;
    }
    function pickObjective(s, playerPos) {
        const holding = unlockedProducts(s).some((k) => prodQty(s, k) > 0);
        // Active long-distance delivery takes top priority — point at the drop.
        if (s.delivery && prodQty(s, s.delivery.product) >= s.delivery.need) {
            const d = s.delivery;
            return { pos: new THREE.Vector3(d.pos[0], 0, d.pos[2]), label: `🚚 Drop-off (${PRODUCTS[d.product].name})`, color: PRODUCTS[d.product]?.color || '#ffe066' };
        }
        // Order buyer (matching shirt) takes priority if you have product.
        if (holding && s.orderColor) {
            let best = null, bestD = Infinity;
            for (const n of s.npcs) {
                if (!n.mesh || !n.wantsBuy || n.shirtColor !== s.orderColor) continue;
                const d = Math.hypot(n.mesh.position.x - playerPos.x, n.mesh.position.z - playerPos.z);
                if (d < bestD) { bestD = d; best = n; }
            }
            if (best) return { pos: best.mesh.position, label: `${colorName(s.orderColor)} buyer`, color: s.orderColor };
        }
        // Out of product: point at the cook bench only if a cookable line
        // (pills/coke) has room. Weed has no street objective — it's grown.
        const canCook = cookableProducts(s).some((k) => prodQty(s, k) < prodCap(s, k));
        if (!holding && canCook && s.cookPos) return { pos: s.cookPos, label: 'Cook lab', color: '#ff7fd0' };
        return null;
    }
    function updateCompass(s, playerPos) {
        const { camera } = core;
        const el = ensureCompass();
        const obj = camera && playerPos ? pickObjective(s, playerPos) : null;
        if (!obj) { el.style.display = 'none'; return; }
        // Angle from camera-forward to the target, on the ground plane.
        camera.getWorldDirection(_camDir);
        const fwd = Math.atan2(_camDir.x, _camDir.z);
        _compassTmp.copy(obj.pos);
        const toT = Math.atan2(_compassTmp.x - playerPos.x, _compassTmp.z - playerPos.z);
        let rel = toT - fwd;
        while (rel > Math.PI) rel -= Math.PI * 2;
        while (rel < -Math.PI) rel += Math.PI * 2;
        const dist = Math.hypot(_compassTmp.x - playerPos.x, _compassTmp.z - playerPos.z);
        // Chevron rotates to point left/right/ahead; ▲ when roughly ahead.
        const deg = (rel * 180 / Math.PI);
        const arrow = Math.abs(deg) < 18 ? '▲' : (deg > 0 ? '▶' : '◀');
        el.style.display = 'block';
        el.innerHTML = `<span style="display:inline-block;font-size:20px;color:${obj.color};">${arrow}</span>`
            + ` ${obj.label} <span style="opacity:.6;">${Math.round(dist)}m</span>`;
    }

    // ---- cook station: tactile recipe panel ----------------------------
    let _cookEl = null;
    function openCook() {
        const s = ensureState();
        if (s.cooking || s.shopOpen) return;
        const cookable = cookableProducts(s);
        // Outdoor bench brews COKE (weed is grown; pills are pressed indoors).
        // With the coke lab not unlocked, point the player at the upgrade desk.
        if (cookable.length === 0) {
            showPrompt('Bench cooks coke — buy a Coke Lab at the desk. Weed is grown, pills pressed indoors.');
            return;
        }
        // Lock the bench onto a cookable line with room; bail if all are full.
        if (!PRODUCTS[s.cookProduct]?.cook || !cookable.includes(s.cookProduct)) s.cookProduct = cookable[0];
        if (prodQty(s, s.cookProduct) >= prodCap(s, s.cookProduct)) {
            const open = cookable.find((k) => prodQty(s, k) < prodCap(s, k));
            if (!open) { showPrompt('Stash full — go sell'); return; }
            s.cookProduct = open;
        }
        s.cooking = true;
        s.recipe = [];
        gameplay.roguePaused = true;           // reuse the sim-pause flag
        try { document.exitPointerLock?.(); } catch (e) {}
        renderCook();
    }
    function renderCook() {
        const s = ensureState();
        if (_cookEl?.parentNode) _cookEl.remove();
        const steps = cookSteps(s);
        const len = steps.length;
        const pdef = PRODUCTS[s.cookProduct];
        const step = s.recipe.length;          // 0..len
        const done = step >= len;
        const liveQ = Math.max(scoreRecipe(s.recipe, steps), purityFloor(s)); // quality if mixed now

        const overlay = document.createElement('div');
        overlay.className = 'tycoon-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:1200;pointer-events:auto;'
            + 'background:rgba(4,10,8,0.82);backdrop-filter:blur(3px);display:flex;'
            + 'flex-direction:column;align-items:center;justify-content:center;'
            + 'font-family:"Trebuchet MS",system-ui,sans-serif;color:#eaffea;';

        // ---- product picker: switch which line the bench brews -----------
        const cookable = cookableProducts(s);
        if (cookable.length > 1) {
            const picker = document.createElement('div');
            picker.style.cssText = 'display:flex;gap:10px;margin-bottom:18px;';
            cookable.forEach((k) => {
                const d = PRODUCTS[k];
                const sel = k === s.cookProduct;
                const full = prodQty(s, k) >= prodCap(s, k);
                const b = document.createElement('button');
                b.style.cssText = 'cursor:pointer;padding:8px 16px;border-radius:10px;font:800 15px/1 inherit;'
                    + `color:${sel ? '#0a140e' : d.color};`
                    + (sel ? `background:linear-gradient(160deg,${d.color},${d.color}cc);border:2px solid rgba(0,0,0,0.25);`
                           : `background:rgba(255,255,255,0.05);border:2px solid ${d.color}66;`)
                    + (full && !sel ? 'opacity:.45;' : '');
                b.textContent = `${d.emoji} ${d.name}${full ? ' (full)' : ''}`;
                b.onclick = () => { if (full && !sel) return; s.cookProduct = k; s.recipe = []; renderCook(); };
                picker.appendChild(b);
            });
            overlay.appendChild(picker);
        }

        const title = document.createElement('div');
        title.textContent = done ? `${pdef.emoji} READY TO MIX` : `${pdef.emoji} ${pdef.name.toUpperCase()} — step ${step + 1} of ${len}`;
        title.style.cssText = `font:900 30px/1.1 inherit;margin-bottom:6px;color:${pdef.color};`
            + 'text-shadow:0 0 18px rgba(60,255,120,0.5);';
        overlay.appendChild(title);

        const hint = document.createElement('div');
        hint.textContent = done
            ? 'Add the reagents in the right order for max purity.'
            : 'Pick the next reagent. Wrong order lowers purity.';
        hint.style.cssText = 'font:600 15px/1.3 inherit;opacity:.8;margin-bottom:18px;';
        overlay.appendChild(hint);

        // Slots: show what's been added and the upcoming empty slot.
        const slots = document.createElement('div');
        slots.style.cssText = 'display:flex;gap:10px;margin-bottom:22px;';
        for (let i = 0; i < len; i++) {
            const added = s.recipe[i];
            const def = steps.find((c) => c.key === added);
            const ok = added === steps[i].key;
            const cell = document.createElement('div');
            cell.style.cssText = 'width:120px;height:54px;border-radius:10px;display:flex;'
                + 'align-items:center;justify-content:center;font:800 14px/1.1 inherit;'
                + 'box-sizing:border-box;text-align:center;padding:4px;'
                + (added
                    ? `background:${def?.color || '#888'}22;border:2px solid ${ok ? '#9dffa0' : '#ff7070'};color:${ok ? '#eaffea' : '#ffb3b3'};`
                    : `background:rgba(255,255,255,0.05);border:2px dashed rgba(160,255,190,${i === step ? 0.7 : 0.25});color:rgba(200,255,210,0.5);`);
            cell.textContent = added ? (def?.t || added) : (i === step ? '?' : '·');
            slots.appendChild(cell);
        }
        overlay.appendChild(slots);

        // Reagent buttons (full palette every step — the order is the skill).
        if (!done) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;justify-content:center;max-width:90vw;';
            steps.forEach((r) => {
                const b = document.createElement('button');
                b.style.cssText = 'cursor:pointer;width:150px;padding:16px 12px;border-radius:12px;'
                    + 'font:800 17px/1.2 inherit;color:#0a140e;box-sizing:border-box;'
                    + `background:linear-gradient(160deg,${r.color},${r.color}cc);`
                    + 'border:2px solid rgba(0,0,0,0.25);box-shadow:0 6px 22px rgba(0,0,0,0.45);'
                    + 'transition:transform .12s;';
                b.textContent = r.t;
                b.onmouseenter = () => { b.style.transform = 'translateY(-5px)'; };
                b.onmouseleave = () => { b.style.transform = 'none'; };
                b.onclick = () => { s.recipe.push(r.key); renderCook(); };
                row.appendChild(b);
            });
            overlay.appendChild(row);
        }

        // Live purity preview.
        const pure = document.createElement('div');
        const pct = Math.round(liveQ * 100);
        pure.innerHTML = `Purity so far: <b style="color:${pct >= 75 ? '#9dffa0' : pct >= 40 ? '#ffae00' : '#ff7070'}">${pct}%</b>`;
        pure.style.cssText = 'margin-top:22px;font:700 17px/1 inherit;opacity:.95;';
        overlay.appendChild(pure);

        // Action row: Mix (when full) + Cancel.
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:14px;margin-top:18px;';
        if (done) {
            const mix = document.createElement('button');
            mix.textContent = 'MIX BATCH';
            mix.style.cssText = 'padding:12px 30px;cursor:pointer;font:900 18px/1 inherit;color:#0a140e;'
                + 'border-radius:12px;background:linear-gradient(160deg,#9dffa0,#3fbf5f);'
                + 'border:2px solid rgba(0,0,0,0.25);box-shadow:0 6px 22px rgba(0,0,0,0.45);';
            mix.onclick = () => finishCook();
            actions.appendChild(mix);
        }
        const cancel = document.createElement('button');
        cancel.textContent = done ? 'DISCARD' : 'CANCEL (Esc)';
        cancel.style.cssText = 'padding:12px 30px;cursor:pointer;font:800 18px/1 inherit;color:#fff;'
            + 'border-radius:12px;background:linear-gradient(160deg,#5a2424,#2a0e0e);'
            + 'border:2px solid rgba(255,140,140,0.5);';
        cancel.onclick = () => closeCook();
        actions.appendChild(cancel);
        overlay.appendChild(actions);

        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        _cookEl = overlay;
    }
    function finishCook() {
        const s = ensureState();
        const key = s.cookProduct;
        const q = Math.max(scoreRecipe(s.recipe, cookSteps(s)), purityFloor(s));
        // Yield scales 50%..100% of the upgrade-driven batch by quality.
        const room = prodCap(s, key) - prodQty(s, key);
        const made = Math.max(0, Math.min(room, Math.round(batchYield(s) * (0.5 + 0.5 * q))));
        addProduct(s, key, made, q);
        if (made > 0) award('firstCook');
        s.lastQ = q;
        // Auto-arm the freshly cooked line for dealing if you weren't holding any.
        if (prodQty(s, s.sellProduct) <= 0 && made > 0) s.sellProduct = key;
        closeCook();
        const pe = PRODUCTS[key].emoji;
        floatText(`${pe} +${made} @ ${Math.round(q * 100)}%`, s.cookPos, q >= 0.75 ? '#9dffa0' : '#ffae00');
        updateHud();
    }
    function closeCook() {
        const s = window.drugTycoon;
        if (_cookEl?.parentNode) _cookEl.remove();
        _cookEl = null;
        if (s) { s.cooking = false; s.recipe = []; }
        gameplay.roguePaused = false;
        const { renderer } = core;
        if (renderer?.domElement && !window.matchMedia?.('(pointer:coarse)')?.matches) {
            const resume = () => {
                renderer.domElement.removeEventListener('click', resume);
                try { renderer.domElement.requestPointerLock?.(); } catch (e) {}
            };
            renderer.domElement.addEventListener('click', resume);
        }
    }

    // ---- shrooms: substrate, climate, misting, drying ------------------
    let _shroomEl = null;
    function shroomBedTemp(s) {
        return s.shroomAcMode === 'cool' ? 20 - Math.min(2, s.shroomAcUnits || 0) * 10 : 20 + Math.min(2, s.shroomAcUnits || 0) * 10;
    }
    function shroomRackTemp(s) {
        return s.shroomAcMode === 'heat' ? 20 + Math.min(2, s.shroomAcUnits || 0) * 10 : 20 - Math.min(2, s.shroomAcUnits || 0) * 10;
    }
    function shroomClimateQuality(s) {
        const t = shroomBedTemp(s);
        if (t <= 1 && t >= -1) return 1;
        if (t < 15) return clamp01(0.65 + (15 - Math.abs(t)) * 0.02);
        return 0.25;
    }
    function ensureShroomRun(s) {
        if (!s.shroomRun) s.shroomRun = { phase: 'empty', progress: 0, q: 0.5, mists: 0, lastTick: performance.now?.() || Date.now() };
        return s.shroomRun;
    }
    function processShrooms(s, dt) {
        const g = s.shroomRun;
        if (g?.phase === 'growing') {
            const temp = shroomBedTemp(s);
            g.lastTick ||= performance.now?.() || Date.now();
            if (temp < 15) {
                const speed = temp <= 1 ? 1.35 : 1.0;
                g.progress = Math.min(1, (g.progress || 0) + dt * speed / (SHROOM_GROW_MS / 1000));
                if (g.progress >= 1 && (g.mists || 0) >= SHROOM_MISTS_REQUIRED) {
                    g.phase = 'ready';
                    showPrompt('Mushroom flush ready. Harvest at the bed.');
                }
            }
        }
        const d = s.shroomDrying;
        if (d?.qty > 0) {
            const hot = shroomRackTemp(s) >= 40;
            d.progress = Math.min(1, (d.progress || 0) + dt * (hot ? 2 : 1) / (SHROOM_DRY_MS / 1000));
            if (d.progress >= 1) {
                addProduct(s, 'shrooms', d.qty, d.q || 1);
                if (prodQty(s, s.sellProduct) <= 0) s.sellProduct = 'shrooms';
                floatText(`🍄 dried +${d.qty}`, labPosFor(s, 'shrooms'), PRODUCTS.shrooms.color);
                s.shroomDrying = null;
                saveProgress();
            }
        }
    }
    function addWetShrooms(s, qty, q) {
        const total = (s.wetShrooms || 0) + qty;
        s.wetShroomsQ = total > 0 ? ((s.wetShrooms || 0) * (s.wetShroomsQ || 1) + qty * q) / total : q;
        s.wetShrooms = total;
    }
    function closeShroomPanel() {
        const s = window.drugTycoon;
        const wasOpen = !!_shroomEl?.parentNode || !!s?.shroomPanelOpen;
        if (_shroomEl?.parentNode) _shroomEl.remove();
        _shroomEl = null;
        if (s) s.shroomPanelOpen = false;
        gameplay.roguePaused = false;
        const { renderer } = core;
        if (wasOpen && renderer?.domElement && !window.matchMedia?.('(pointer:coarse)')?.matches) {
            const resume = () => {
                renderer.domElement.removeEventListener('click', resume);
                try { renderer.domElement.requestPointerLock?.(); } catch (e) {}
            };
            renderer.domElement.addEventListener('click', resume);
        }
    }
    function openShroomOverlay(titleText, bodyBuilder) {
        const s = ensureState();
        closeShroomPanel();
        s.shroomPanelOpen = true;
        gameplay.roguePaused = true;
        try { document.exitPointerLock?.(); } catch (e) {}
        const overlay = document.createElement('div');
        overlay.className = 'tycoon-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:1200;pointer-events:auto;'
            + 'background:rgba(8,6,12,0.88);backdrop-filter:blur(3px);display:flex;'
            + 'flex-direction:column;align-items:center;justify-content:center;'
            + 'font-family:"Trebuchet MS",system-ui,sans-serif;color:#f2eaff;';
        const title = document.createElement('div');
        title.textContent = titleText;
        title.style.cssText = 'font:900 28px/1.1 inherit;margin-bottom:14px;color:#d8a0ff;text-shadow:0 0 18px #9a5ad0;';
        overlay.appendChild(title);
        bodyBuilder(overlay);
        const close = document.createElement('button');
        close.textContent = 'CANCEL (Esc)';
        close.style.cssText = 'margin-top:16px;padding:9px 22px;cursor:pointer;font:800 14px/1 inherit;color:#fff;'
            + 'border-radius:10px;background:rgba(80,30,70,0.8);border:2px solid rgba(220,160,255,0.35);';
        close.onclick = closeShroomPanel;
        overlay.appendChild(close);
        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        _shroomEl = overlay;
    }
    function openShroomSpawnGame() {
        const s = ensureState();
        if (!s.hasShrooms || (s.shroomSpawn || 0) <= 0) return;
        openShroomOverlay('🍄 BREAK + STIR SPAWN', (overlay) => {
            const info = document.createElement('div');
            info.textContent = 'Break every spawn clump. Keep chunks on the bed.';
            info.style.cssText = 'font:700 14px/1.3 inherit;opacity:.82;margin-bottom:14px;';
            overlay.appendChild(info);
            const bed = document.createElement('div');
            bed.style.cssText = 'position:relative;width:560px;max-width:88vw;height:260px;border-radius:12px;'
                + 'background:#3b2a20;border:3px solid #9a7048;box-shadow:0 10px 30px rgba(0,0,0,0.55);overflow:hidden;';
            overlay.appendChild(bed);
            let done = 0, fail = false;
            const chunks = 8;
            for (let i = 0; i < chunks; i++) {
                const c = document.createElement('button');
                c.type = 'button';
                c.textContent = '●';
                c.style.cssText = `position:absolute;left:${12 + Math.random() * 76}%;top:${16 + Math.random() * 66}%;`
                    + 'width:36px;height:36px;border-radius:18px;border:0;cursor:pointer;color:#d8a0ff;'
                    + 'background:#4a2d5e;font:900 22px/1 inherit;box-shadow:0 2px 8px rgba(0,0,0,0.5);';
                c.onclick = () => {
                    if (fail || c.dataset.done) return;
                    const x = parseFloat(c.style.left) + (Math.random() - 0.5) * 18;
                    const y = parseFloat(c.style.top) + (Math.random() - 0.5) * 18;
                    c.style.left = `${x}%`; c.style.top = `${y}%`;
                    if (x < 4 || x > 92 || y < 5 || y > 86) {
                        fail = true;
                        c.style.background = '#7a1f2a';
                        info.textContent = 'Chunk fell off. Spawn wasted.';
                        s.shroomSpawn = Math.max(0, (s.shroomSpawn || 0) - 1);
                        setTimeout(() => { closeShroomPanel(); saveProgress(); updateHud(); }, 800);
                        return;
                    }
                    c.dataset.done = '1';
                    c.style.transform = 'scale(.55)';
                    c.style.opacity = '.65';
                    done++;
                    if (done >= chunks) {
                        s.shroomSpawn = Math.max(0, (s.shroomSpawn || 0) - 1);
                        s.shroomRun = { phase: 'growing', progress: 0, q: 0.68 + shroomClimateQuality(s) * 0.12, mists: 0, lastTick: performance.now?.() || Date.now() };
                        info.textContent = 'Spawn mixed. Keep bed under 15C and mist targets.';
                        setTimeout(() => { closeShroomPanel(); saveProgress(); updateHud(); }, 900);
                    }
                };
                bed.appendChild(c);
            }
        });
    }
    function openShroomMistGame() {
        const s = ensureState();
        const g = ensureShroomRun(s);
        if (!s.sprayBottle || !s.sprayBottleFilled || g.phase !== 'growing') return;
        openShroomOverlay('💧 SPRAY BOTTLE', (overlay) => {
            const info = document.createElement('div');
            info.textContent = 'Mist every blue target icon.';
            info.style.cssText = 'font:700 14px/1.3 inherit;opacity:.82;margin-bottom:14px;';
            overlay.appendChild(info);
            const tray = document.createElement('div');
            tray.style.cssText = 'position:relative;width:560px;max-width:88vw;height:260px;border-radius:12px;'
                + 'background:#10202c;border:3px solid #7fd0ff;box-shadow:0 10px 30px rgba(0,0,0,0.55);overflow:hidden;';
            overlay.appendChild(tray);
            let hits = 0;
            for (let i = 0; i < 5; i++) {
                const t = document.createElement('button');
                t.type = 'button';
                t.textContent = '✦';
                t.style.cssText = `position:absolute;left:${10 + Math.random() * 78}%;top:${12 + Math.random() * 70}%;`
                    + 'width:44px;height:44px;border-radius:22px;border:2px solid #bfe9ff;cursor:pointer;'
                    + 'color:#e8fbff;background:#1b6ea0;font:900 22px/1 inherit;box-shadow:0 0 16px #7fd0ff;';
                t.onclick = () => {
                    if (t.dataset.hit) return;
                    t.dataset.hit = '1';
                    t.style.opacity = '.25';
                    hits++;
                    if (hits >= 5) {
                        s.sprayBottleFilled = false;
                        g.mists = (g.mists || 0) + 1;
                        g.q = clamp01((g.q || 0.6) + 0.08);
                        info.textContent = `Mist locked (${g.mists}/${SHROOM_MISTS_REQUIRED}). Fill bottle at tap.`;
                        setTimeout(() => { closeShroomPanel(); saveProgress(); updateHud(); }, 800);
                    }
                };
                tray.appendChild(t);
            }
        });
    }
    function handleShroomBed(s, interact) {
        if (!s.hasShrooms) return '🍄 Buy Mushroom Bed at upgrade desk';
        const g = ensureShroomRun(s);
        if (g.phase === 'empty') {
            if ((s.mushroomSubstrate || 0) <= 0) return 'Need Mushroom Substrate';
            if (interact) { s.mushroomSubstrate--; g.phase = 'substrate'; saveProgress(); }
            return '[E] Pour Mushroom Substrate';
        }
        if (g.phase === 'substrate') {
            if ((s.shroomSpawn || 0) <= 0) return 'Need Shroom Spawn';
            if (interact) openShroomSpawnGame();
            return '[E] Add Shroom Spawn';
        }
        if (g.phase === 'growing') {
            const temp = shroomBedTemp(s);
            if (temp >= 15) return `Too warm (${temp}C). Set AC to cool.`;
            if ((g.mists || 0) < SHROOM_MISTS_REQUIRED) {
                if (!s.sprayBottle) return 'Need Spray Bottle';
                if (!s.sprayBottleFilled) return 'Fill Spray Bottle at tap';
                if (interact) openShroomMistGame();
                return `[E] Mist blue targets (${g.mists || 0}/${SHROOM_MISTS_REQUIRED})`;
            }
            return `Growing ${Math.round((g.progress || 0) * 100)}% · ${temp}C`;
        }
        if (g.phase === 'ready') {
            if (interact) {
                const q = clamp01((g.q || 0.65) + shroomClimateQuality(s) * 0.15);
                const qty = Math.max(4, Math.round((6 + s.up.batch * 2) * (0.75 + q * 0.35)));
                addWetShrooms(s, qty, q);
                s.shroomRun = { phase: 'empty', progress: 0, q: 0.5, mists: 0, lastTick: performance.now?.() || Date.now() };
                floatText(`🍄 wet flush +${qty}`, labPosFor(s, 'shrooms'), PRODUCTS.shrooms.color);
                saveProgress(); updateHud();
            }
            return '[E] Harvest wet shrooms';
        }
        return 'Mushroom bed';
    }
    function handleSprayTap(s, interact) {
        if (!s.sprayBottle) return 'Tap: buy Spray Bottle first';
        if (s.sprayBottleFilled) return 'Spray Bottle full';
        if (interact) { s.sprayBottleFilled = true; saveProgress(); updateHud(); }
        return '[E] Fill Spray Bottle';
    }
    function handleShroomAc(s, interact) {
        if ((s.shroomAcUnits || 0) <= 0) return 'Buy AC Unit at upgrade desk';
        if (interact) { s.shroomAcMode = s.shroomAcMode === 'cool' ? 'heat' : 'cool'; saveProgress(); updateHud(); }
        return `[E] AC ${s.shroomAcMode.toUpperCase()} · bed ${shroomBedTemp(s)}C · rack ${shroomRackTemp(s)}C`;
    }
    function handleShroomRack(s, interact) {
        const d = s.shroomDrying;
        if ((s.dryingRacks || 0) <= 0) return 'Need Drying Rack';
        if (d?.qty > 0) return `Drying ${Math.round((d.progress || 0) * 100)}% · rack ${shroomRackTemp(s)}C${shroomRackTemp(s) >= 40 ? ' · fast' : ''}`;
        if ((s.wetShrooms || 0) <= 0) return 'No wet shrooms';
        if (interact) {
            s.shroomDrying = { qty: s.wetShrooms, q: s.wetShroomsQ || 1, progress: 0 };
            s.wetShrooms = 0; s.wetShroomsQ = 1;
            saveProgress(); updateHud();
        }
        return `[E] Load Drying Rack (${s.wetShrooms} wet)`;
    }

    // ---- pill lab: realistic multi-stage pill press --------------------
    // A four-stage craft that mirrors real tablet manufacture:
    //   1) WEIGH   — dose the active ingredient: stop a sweeping needle in the
    //                target band (too little = weak, too much = hot/dirty).
    //   2) BLEND   — granulate with binder + filler: hold to fill the blend
    //                bar, release inside the green band (overshoot = clumpy).
    //   3) PRESS   — compress in the die: mash to build tonnage to the target
    //                window before the timer runs out (too soft = crumbly).
    //   4) STAMP   — score + imprint: hit a moving marker in the sweet spot.
    // Each stage returns 0..1; their average is the batch purity. Skill, not
    // memorisation — every stage is a live timing/precision check.
    const PILL_STAGES = ['weigh', 'blend', 'press', 'stamp'];
    // Per-product stage sequences. pills/coke share the classic 4-step craft;
    // meth + lsd get distinct mechanics (temphold / drop). Falls back to
    // PILL_STAGES for anything unlisted.
    const LAB_STAGES = {
        pills: ['weigh', 'blend', 'press', 'stamp'],
        coke:  ['weigh', 'blend', 'press', 'stamp'],
        meth:    ['weigh', 'temphold', 'stamp'],   // measure → hold the cook temp → cut
        lsd:     ['weigh', 'drop', 'drop'],        // measure → drop tabs twice
        shrooms: ['weigh', 'mist', 'stamp'],       // inoculate → mist humidity → harvest
    };
    function labStages(product) { return LAB_STAGES[product] || PILL_STAGES; }
    // Per-product theming for the shared timing minigame. 'pills' presses
    // tablets; 'coke' cooks/cuts/whips/cuts the rock — same four mechanics,
    // different flavour text + colour so the indoor coke lab feels distinct.
    const LAB_THEME = {
        pills: {
            emoji: '💊', name: 'PILL LAB', accent: '#ff7fd0', accent2: '#ff4fb8', bg: 'rgba(10,4,12,0.86)',
            titles: { weigh: '⚖️ WEIGH THE DOSE', blend: '🌀 BLEND & GRANULATE', press: '🛠️ PRESS THE TABLETS', stamp: '🔖 SCORE & STAMP' },
            hints: {
                weigh: 'Stop the needle inside the green band. Too little is weak — too much runs hot.',
                blend: 'The mix rises and falls — tap to lock it inside the green band.',
                press: 'Mash [E]/Space/click to build tonnage into the target window before time runs out.',
                stamp: 'Hit the moving marker in the sweet spot for a clean imprint.',
            },
            btns: { weigh: 'LOCK DOSE', blend: 'LOCK BLEND', press: 'PRESS! (mash)', stamp: 'STAMP' },
        },
        coke: {
            emoji: '❄️', name: 'COKE LAB', accent: '#7fd0ff', accent2: '#4fb8ff', bg: 'rgba(4,8,14,0.86)',
            titles: { weigh: '⚗️ MEASURE THE BASE', blend: '🧪 DISSOLVE & WASH', press: '🔥 COOK THE ROCK', stamp: '🔪 CUT & BAG' },
            hints: {
                weigh: 'Stop the needle inside the green band — measure the coca base just right.',
                blend: 'The wash rises and falls — tap to lock it inside the green band.',
                press: 'Mash [E]/Space/click to hold the cook temperature in the window before it scorches.',
                stamp: 'Hit the moving blade in the sweet spot for a clean cut.',
            },
            btns: { weigh: 'LOCK BASE', blend: 'LOCK WASH', press: 'COOK! (mash)', stamp: 'CUT' },
        },
        meth: {
            emoji: '💎', name: 'METH LAB', accent: '#bfe9ff', accent2: '#ff5a3c', bg: 'rgba(6,10,14,0.88)',
            titles: { weigh: '⚗️ MEASURE THE PRECURSOR', temphold: '🔥 HOLD THE COOK TEMP', stamp: '🧊 CRYSTALLISE & SHARD' },
            hints: {
                weigh: 'Stop the needle inside the green band — measure the precursor exactly.',
                temphold: 'Mash [E]/Space/click to keep the temperature riding the moving green window. Too cold stalls, too hot scorches.',
                stamp: 'Hit the moving marker in the sweet spot to break clean shards.',
            },
            btns: { weigh: 'LOCK DOSE', temphold: 'HEAT! (mash)', stamp: 'SHARD' },
        },
        lsd: {
            emoji: '🌈', name: 'LSD LAB', accent: '#ffd24a', accent2: '#ff7fd0', bg: 'rgba(12,6,16,0.88)',
            titles: { weigh: '⚗️ DOSE THE SOLUTION', drop: '💧 DROP THE TABS' },
            hints: {
                weigh: 'Stop the needle inside the green band — dose the solution just right.',
                drop: 'The dropper sweeps across the blotter — tap to drop a tab right on the target.',
            },
            btns: { weigh: 'LOCK DOSE', drop: 'DROP!' },
        },
        shrooms: {
            emoji: '🍄', name: 'SHROOM LAB', accent: '#d8a0ff', accent2: '#9a5ad0', bg: 'rgba(10,6,14,0.88)',
            titles: { weigh: '⚗️ INOCULATE THE SUBSTRATE', mist: '💨 MIST THE HUMIDITY', stamp: '🍄 HARVEST THE FLUSH' },
            hints: {
                weigh: 'Stop the needle inside the green band — inoculate the substrate evenly.',
                mist: 'Humidity rises and falls — tap to lock it inside the green band.',
                stamp: 'Hit the moving marker in the sweet spot to harvest a clean flush.',
            },
            btns: { weigh: 'INOCULATE', mist: 'LOCK MIST', stamp: 'HARVEST' },
        },
    };
    let _pillEl = null;
    let _pillRaf = 0;

    // Open the indoor timing minigame for an unlocked side product.
    function openPillLab(product = 'pills') {
        const s = ensureState();
        if (s.pillGame || s.cooking || s.shopOpen || s.baggingOpen) return;
        const theme = LAB_THEME[product] || LAB_THEME.pills;
        if (!productUnlocked(s, product)) {
            showPrompt(`${theme.emoji} Unlock ${PRODUCTS[product]?.name || 'this lab'} at the upgrade desk first`);
            return;
        }
        if (product === 'coke') {
            const need = cokeLeavesNeeded(s);
            if ((s.cocaLeaves || 0) < need) {
                showPrompt(`Need ${need} coca leaves for a coke cook — grow Coca Seeds first`);
                return;
            }
        }
        if (prodQty(s, product) >= prodCap(s, product)) {
            showPrompt(`${theme.emoji} ${PRODUCTS[product].name} stash full — go sell`);
            return;
        }
        const stages = labStages(product);
        s.pillGame = {
            product,
            stages,                // this product's stage sequence
            stage: 0,
            scores: [],            // per-stage 0..1
            // meth temphold: temperature drifts; hold it in a moving window.
            temp: 0.5, tempVel: 0, tempWindow: 0.5, tempWindowDir: 1, tempHeld: 0, tempDeadline: 0, tempStarted: false,
            // lsd drop: a target sweeps; tap to drop a tab, scored on accuracy.
            dropX: 0, dropDir: 1, dropSpeed: 1.1 + Math.random() * 0.4, dropTarget: 0.5, dropBand: 0.12,
            // weigh: needle sweeps 0..1; target band centred randomly.
            needle: 0, needleDir: 1, needleSpeed: 0.95 + Math.random() * 0.25,
            weighTarget: 0.45 + Math.random() * 0.25, weighBand: 0.12,
            // blend: bar rises/falls on its own; tap to lock it in the band.
            blend: 0, blendDir: 1, blendTarget: 0.55 + Math.random() * 0.25, blendBand: 0.11,
            // press: tonnage built by mashing, decays; window timer.
            press: 0, pressTarget: 0.8, pressDeadline: 0, pressStarted: false,
            // stamp: marker sweeps; sweet spot centred randomly.
            stamp: 0, stampDir: 1, stampSpeed: 1.15 + Math.random() * 0.3,
            stampTarget: 0.4 + Math.random() * 0.3, stampBand: 0.14,
            lastT: performance.now?.() || Date.now(),
            done: false,
        };
        gameplay.roguePaused = true;
        try { document.exitPointerLock?.(); } catch (e) {}
        renderPillLab();
        _pillRaf = requestAnimationFrame(tickPillLab);
    }

    // The single action button: advances/commits the current stage.
    function pillAction() {
        const s = window.drugTycoon;
        const g = s?.pillGame;
        if (!g || g.done) return;
        const stage = g.stages[g.stage];
        const now = performance.now?.() || Date.now();
        if (stage === 'weigh') {
            // Score by closeness of the needle to target (within band = high).
            const off = Math.abs(g.needle - g.weighTarget);
            const sc = clamp01(1 - off / g.weighBand);
            commitPillStage(g, sc);
            playSfx('hit', null, 0.4);
        } else if (stage === 'blend') {
            // Bar auto-rises then falls (a saw wave); tap to lock it in-band.
            const off = Math.abs(g.blend - g.blendTarget);
            const sc = clamp01(1 - off / g.blendBand);
            commitPillStage(g, sc);
            playSfx('hit', null, 0.4);
        } else if (stage === 'press') {
            // Each tap adds tonnage; the stage auto-commits when the timer ends.
            if (!g.pressStarted) { g.pressStarted = true; g.pressDeadline = now + 3000; }
            g.press = Math.min(1.15, g.press + 0.11);
            playSfx('hit', null, 0.3);
        } else if (stage === 'stamp') {
            const off = Math.abs(g.stamp - g.stampTarget);
            const sc = clamp01(1 - off / g.stampBand);
            commitPillStage(g, sc);
            playSfx('shot', null, 0.35);
        } else if (stage === 'temphold') {
            // METH: tap injects a heat pulse to ride the moving safe window.
            if (!g.tempStarted) { g.tempStarted = true; g.tempDeadline = now + 5000; }
            g.tempVel += 0.9;
            playSfx('hit', null, 0.3);
        } else if (stage === 'drop') {
            // LSD: tap drops a tab when the dropper sits over the target.
            const off = Math.abs(g.dropX - g.dropTarget);
            const sc = clamp01(1 - off / g.dropBand);
            commitPillStage(g, sc);
            playSfx('shot', null, 0.3);
        } else if (stage === 'mist') {
            // SHROOMS: humidity bar rises/falls (reuses blend mechanic) — tap to
            // lock it inside the green band for the right grow humidity.
            const off = Math.abs(g.blend - g.blendTarget);
            commitPillStage(g, clamp01(1 - off / g.blendBand));
            playSfx('hit', null, 0.4);
        }
    }
    function commitPillStage(g, score) {
        g.scores.push(clamp01(score));
        g.stage += 1;
        // Reset per-stage transient timers + re-randomise the next target.
        const now = performance.now?.() || Date.now();
        g.lastT = now;
        g.pressStarted = false;
        g.tempStarted = false; g.temp = 0.5; g.tempVel = 0; g.tempHeld = 0;
        g.dropTarget = 0.2 + Math.random() * 0.6; g.dropX = 0; g.dropDir = 1;
        if (g.stage >= g.stages.length) finishPillLab();
        else renderPillLab();
    }

    function tickPillLab(t) {
        const s = window.drugTycoon;
        const g = s?.pillGame;
        if (!g || g.done) { _pillRaf = 0; return; }
        const now = performance.now?.() || Date.now();
        const dt = Math.min(0.05, Math.max(0.001, (now - g.lastT) / 1000));
        g.lastT = now;
        const stage = g.stages[g.stage];
        if (stage === 'weigh') {
            g.needle += g.needleDir * g.needleSpeed * dt;
            if (g.needle >= 1) { g.needle = 1; g.needleDir = -1; }
            else if (g.needle <= 0) { g.needle = 0; g.needleDir = 1; }
        } else if (stage === 'blend') {
            // Bar rises and falls on its own (saw); tap to lock it in the band.
            // Keyboard-friendly: no hold required.
            g.blend += g.blendDir * 0.85 * dt;
            if (g.blend >= 1.05) { g.blend = 1.05; g.blendDir = -1; }
            else if (g.blend <= 0) { g.blend = 0; g.blendDir = 1; }
        } else if (stage === 'press') {
            // Tonnage bleeds off between taps; commit when the window closes.
            g.press = Math.max(0, g.press - 0.42 * dt);
            if (g.pressStarted && now >= g.pressDeadline) {
                const off = Math.abs(g.press - g.pressTarget);
                commitPillStage(g, clamp01(1 - off / 0.35));
                playSfx('hit', null, 0.5);
            }
        } else if (stage === 'stamp') {
            g.stamp += g.stampDir * g.stampSpeed * dt;
            if (g.stamp >= 1) { g.stamp = 1; g.stampDir = -1; }
            else if (g.stamp <= 0) { g.stamp = 0; g.stampDir = 1; }
        } else if (stage === 'temphold') {
            // METH: temp falls under cooling; taps push it up. Keep it inside
            // the drifting safe window to bank "in-window" time = the score.
            g.tempVel -= 1.6 * dt;
            g.temp = clamp01(g.temp + g.tempVel * dt);
            if (g.temp <= 0) { g.temp = 0; g.tempVel = Math.max(0, g.tempVel); }
            if (g.temp >= 1) { g.temp = 1; g.tempVel = Math.min(0, g.tempVel); }
            g.tempWindow += g.tempWindowDir * 0.18 * dt;
            if (g.tempWindow >= 0.78) { g.tempWindow = 0.78; g.tempWindowDir = -1; }
            else if (g.tempWindow <= 0.22) { g.tempWindow = 0.22; g.tempWindowDir = 1; }
            if (g.tempStarted && Math.abs(g.temp - g.tempWindow) <= 0.12) g.tempHeld += dt;
            if (g.tempStarted && now >= g.tempDeadline) {
                commitPillStage(g, clamp01(g.tempHeld / 3.2));
                playSfx('hit', null, 0.5);
            }
        } else if (stage === 'drop') {
            // LSD: dropper sweeps left↔right over the blotter sheet.
            g.dropX += g.dropDir * g.dropSpeed * dt;
            if (g.dropX >= 1) { g.dropX = 1; g.dropDir = -1; }
            else if (g.dropX <= 0) { g.dropX = 0; g.dropDir = 1; }
        } else if (stage === 'mist') {
            // SHROOMS humidity bar rises/falls on its own (reuses blend var).
            g.blend += g.blendDir * 0.8 * dt;
            if (g.blend >= 1.05) { g.blend = 1.05; g.blendDir = -1; }
            else if (g.blend <= 0) { g.blend = 0; g.blendDir = 1; }
        }
        renderPillLab(true);
        _pillRaf = requestAnimationFrame(tickPillLab);
    }

    function bandStyle(center, band) {
        const lo = Math.max(0, center - band) * 100;
        const w = Math.min(100, band * 2 * 100);
        return `left:${lo}%;width:${w}%;`;
    }
    function renderPillLab(liveUpdate = false) {
        const s = ensureState();
        const g = s.pillGame;
        if (!g) return;
        const stage = g.stages[g.stage];
        // Live-update path: only refresh the moving indicators, not the whole
        // DOM, so the loop stays cheap.
        if (liveUpdate && _pillEl) {
            const mk = _pillEl.querySelector('#pill-marker');
            const fill = _pillEl.querySelector('#pill-fill');
            const win = _pillEl.querySelector('#pill-window');
            if (stage === 'weigh' && mk) mk.style.left = `calc(${g.needle * 100}% - 2px)`;
            else if ((stage === 'blend' || stage === 'mist') && fill) fill.style.width = `${Math.min(100, g.blend * 100)}%`;
            else if (stage === 'press' && fill) fill.style.width = `${Math.min(100, g.press * 100)}%`;
            else if (stage === 'stamp' && mk) mk.style.left = `calc(${g.stamp * 100}% - 2px)`;
            else if (stage === 'drop' && mk) mk.style.left = `calc(${g.dropX * 100}% - 2px)`;
            else if (stage === 'temphold') {
                if (fill) fill.style.width = `${Math.min(100, g.temp * 100)}%`;
                if (win) win.style.left = `calc(${(g.tempWindow - 0.12) * 100}%)`;
            }
            const timer = _pillEl.querySelector('#pill-timer');
            const now = performance.now?.() || Date.now();
            if (stage === 'press' && timer) {
                const rem = g.pressStarted ? Math.max(0, (g.pressDeadline - now) / 1000) : 3.0;
                timer.textContent = `${rem.toFixed(1)}s`;
            } else if (stage === 'temphold' && timer) {
                const rem = g.tempStarted ? Math.max(0, (g.tempDeadline - now) / 1000) : 5.0;
                const inWin = Math.abs(g.temp - g.tempWindow) <= 0.12;
                timer.textContent = `${rem.toFixed(1)}s · ${inWin ? '✅ in range' : '⚠ off-temp'}`;
                timer.style.color = inWin ? '#9dffa0' : '#ff8a8a';
            }
            return;
        }

        const theme = LAB_THEME[g.product] || LAB_THEME.pills;
        if (_pillEl?.parentNode) _pillEl.remove();
        const overlay = document.createElement('div');
        overlay.className = 'tycoon-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:1200;pointer-events:auto;'
            + `background:${theme.bg};backdrop-filter:blur(3px);display:flex;`
            + 'flex-direction:column;align-items:center;justify-content:center;'
            + 'font-family:"Trebuchet MS",system-ui,sans-serif;color:#eef6ff;';

        const titles = theme.titles;
        const hints = theme.hints;

        const title = document.createElement('div');
        title.textContent = `${theme.emoji} ${theme.name} — ${titles[stage]}`;
        title.style.cssText = `font:900 28px/1.1 inherit;margin-bottom:4px;color:${theme.accent};text-shadow:0 0 18px ${theme.accent}88;`;
        overlay.appendChild(title);

        const step = document.createElement('div');
        step.textContent = `Step ${g.stage + 1} of ${g.stages.length}`;
        step.style.cssText = 'font:700 13px/1 inherit;opacity:.7;margin-bottom:6px;';
        overlay.appendChild(step);

        const hint = document.createElement('div');
        hint.textContent = hints[stage];
        hint.style.cssText = 'font:600 14px/1.3 inherit;opacity:.85;margin-bottom:20px;max-width:520px;text-align:center;';
        overlay.appendChild(hint);

        // The play area: a 520px track with a green target band + a marker
        // (weigh/stamp) or a fill bar (blend/press).
        const track = document.createElement('div');
        track.style.cssText = 'position:relative;width:520px;max-width:86vw;height:46px;border-radius:10px;'
            + `background:rgba(255,255,255,0.07);border:2px solid ${theme.accent}59;overflow:hidden;`;

        if (stage === 'weigh' || stage === 'stamp' || stage === 'drop') {
            const center = stage === 'weigh' ? g.weighTarget : stage === 'stamp' ? g.stampTarget : g.dropTarget;
            const band = stage === 'weigh' ? g.weighBand : stage === 'stamp' ? g.stampBand : g.dropBand;
            const green = document.createElement('div');
            green.style.cssText = `position:absolute;top:0;bottom:0;${bandStyle(center, band)}`
                + 'background:rgba(120,255,150,0.35);border-left:2px solid #9dffa0;border-right:2px solid #9dffa0;';
            track.appendChild(green);
            const marker = document.createElement('div');
            marker.id = 'pill-marker';
            const pos = stage === 'weigh' ? g.needle : stage === 'stamp' ? g.stamp : g.dropX;
            marker.style.cssText = `position:absolute;top:-3px;bottom:-3px;width:4px;left:calc(${pos * 100}% - 2px);`
                + 'background:#fff;box-shadow:0 0 10px #fff;';
            track.appendChild(marker);
        } else if (stage === 'temphold') {
            // METH: a temperature fill bar + a MOVING green safe window. Keep
            // the fill's leading edge inside the window as it drifts.
            const win = document.createElement('div');
            win.id = 'pill-window';
            win.style.cssText = `position:absolute;top:0;bottom:0;left:calc(${(g.tempWindow - 0.12) * 100}%);width:24%;`
                + 'background:rgba(120,255,150,0.30);border-left:2px solid #9dffa0;border-right:2px solid #9dffa0;';
            track.appendChild(win);
            const fill = document.createElement('div');
            fill.id = 'pill-fill';
            fill.style.cssText = `position:absolute;top:0;bottom:0;left:0;width:${Math.min(100, g.temp * 100)}%;`
                + `background:linear-gradient(90deg,${theme.accent},#ff5a3c);opacity:.75;`;
            track.appendChild(fill);
        } else {
            // blend / mist / press: a fill bar + a target window overlay.
            const isBlendLike = stage === 'blend' || stage === 'mist';
            const center = isBlendLike ? g.blendTarget : g.pressTarget;
            const band = isBlendLike ? g.blendBand : 0.18;
            const green = document.createElement('div');
            green.style.cssText = `position:absolute;top:0;bottom:0;${bandStyle(center, band)}`
                + 'background:rgba(120,255,150,0.30);border-left:2px solid #9dffa0;border-right:2px solid #9dffa0;';
            track.appendChild(green);
            const fill = document.createElement('div');
            fill.id = 'pill-fill';
            const v = isBlendLike ? g.blend : g.press;
            fill.style.cssText = `position:absolute;top:0;bottom:0;left:0;width:${Math.min(100, v * 100)}%;`
                + `background:linear-gradient(90deg,${theme.accent},${theme.accent2});opacity:.7;`;
            track.appendChild(fill);
        }
        overlay.appendChild(track);

        if (stage === 'press' || stage === 'temphold') {
            const timer = document.createElement('div');
            timer.id = 'pill-timer';
            timer.textContent = stage === 'temphold' ? '5.0s' : '3.0s';
            timer.style.cssText = 'font:800 16px/1 inherit;color:#ffd24a;margin-top:10px;';
            overlay.appendChild(timer);
        }

        // Completed-stage pips.
        const pips = document.createElement('div');
        pips.style.cssText = 'display:flex;gap:8px;margin-top:18px;';
        g.stages.forEach((st, i) => {
            const done = i < g.scores.length;
            const sc = done ? g.scores[i] : 0;
            const c = done ? (sc >= 0.75 ? '#9dffa0' : sc >= 0.4 ? '#ffae00' : '#ff7070') : 'rgba(255,255,255,0.18)';
            const pip = document.createElement('div');
            pip.style.cssText = `width:54px;height:8px;border-radius:4px;background:${c};`;
            pips.appendChild(pip);
        });
        overlay.appendChild(pips);

        // Big action button (mouse + touch). For blend it's press-and-hold
        // mirrored to gameplay.input.fire; for the rest it's a tap.
        const btn = document.createElement('button');
        btn.textContent = theme.btns[stage];
        btn.style.cssText = 'margin-top:22px;cursor:pointer;padding:14px 34px;border-radius:12px;'
            + 'font:900 18px/1 inherit;color:#0a141a;border:2px solid rgba(0,0,0,0.25);'
            + `background:linear-gradient(160deg,${theme.accent},${theme.accent2});box-shadow:0 6px 22px rgba(0,0,0,0.45);`;
        btn.onclick = () => pillAction();
        overlay.appendChild(btn);

        const keyHint = document.createElement('div');
        keyHint.textContent = '[E] / [Space] / click';
        keyHint.style.cssText = 'margin-top:8px;font:600 11px/1 inherit;opacity:.5;';
        overlay.appendChild(keyHint);

        const cancel = document.createElement('button');
        cancel.textContent = 'CANCEL (Esc)';
        cancel.style.cssText = 'margin-top:12px;padding:8px 22px;cursor:pointer;font:700 14px/1 inherit;color:#fff;'
            + 'border-radius:10px;background:rgba(90,30,30,0.8);border:2px solid rgba(255,140,140,0.4);';
        cancel.onclick = () => closePillLab();
        overlay.appendChild(cancel);

        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        _pillEl = overlay;
    }

    function finishPillLab() {
        const s = ensureState();
        const g = s.pillGame;
        if (!g) return;
        g.done = true;
        const product = g.product || 'pills';
        const theme = LAB_THEME[product] || LAB_THEME.pills;
        const avg = g.scores.length ? g.scores.reduce((a, b) => a + b, 0) / g.scores.length : 0;
        let q = Math.max(avg, purityFloor(s));
        if (product === 'coke') {
            const need = cokeLeavesNeeded(s);
            if ((s.cocaLeaves || 0) < need) {
                showPrompt(`Need ${need} coca leaves for a coke cook`);
                closePillLab();
                updateHud();
                return;
            }
            const leafQ = consumeCocaLeaves(s, need);
            q = clamp01(q * 0.75 + leafQ * 0.25);
        }
        const room = prodCap(s, product) - prodQty(s, product);
        const made = Math.max(0, Math.min(room, Math.round(batchYield(s) * (0.5 + 0.5 * q))));
        addProduct(s, product, made, q);
        if (made > 0) award('firstCook');
        s.lastQ = q;
        if (prodQty(s, s.sellProduct) <= 0 && made > 0) s.sellProduct = product;
        const where = labPosFor(s, product) || s.cookPos;
        floatText(`${theme.emoji} +${made} @ ${Math.round(q * 100)}%`, where, q >= 0.75 ? '#9dffa0' : '#ffae00');
        playSfx('cash', null, 0.5);
        closePillLab();
        saveProgress();
        updateHud();
    }

    function closePillLab() {
        const s = window.drugTycoon;
        if (_pillRaf) { cancelAnimationFrame(_pillRaf); _pillRaf = 0; }
        if (_pillEl?.parentNode) _pillEl.remove();
        _pillEl = null;
        if (s) {
            s.pillGame = null;
            if (gameplay.input) gameplay.input.fire = false;   // clear any held blend
        }
        gameplay.roguePaused = false;
        const { renderer } = core;
        if (renderer?.domElement && !window.matchMedia?.('(pointer:coarse)')?.matches) {
            const resume = () => {
                renderer.domElement.removeEventListener('click', resume);
                try { renderer.domElement.requestPointerLock?.(); } catch (e) {}
            };
            renderer.domElement.addEventListener('click', resume);
        }
    }

    // ---- upgrade shop ---------------------------------------------------
    let _shopEl = null;
    function isMobileUi() {
        if (typeof window === 'undefined') return false;
        return !!(
            window.matchMedia?.('(pointer:coarse)')?.matches
            || window.innerWidth < 760
            || document.body?.classList?.contains('mobile-ui-active')
            || document.body?.classList?.contains('mobile-menu-open')
        );
    }
    function openShop() {
        const s = ensureState();
        if (s.shopOpen) return;
        s.shopOpen = true;
        gameplay.roguePaused = true;          // reuse the sim-pause flag
        try { document.exitPointerLock?.(); } catch (e) {}
        renderShop();
    }
    function renderShop() {
        const s = ensureState();
        if (_shopEl?.parentNode) _shopEl.remove();
        const m = isMobileUi();
        // Compact sizing on mobile so the whole shop fits a small screen.
        const cw = m ? 104 : 200, ch = m ? 96 : 210, wch = m ? 92 : 200;
        const pad = m ? '8px 6px' : '20px 14px';
        const gap = m ? 8 : 18;
        const tTitle = m ? 16 : 20, tDesc = m ? 10 : 15, tSub = m ? 9 : 14, tCost = m ? 12 : 18;
        const overlay = document.createElement('div');
        overlay.className = 'tycoon-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:1200;pointer-events:auto;'
            + 'background:rgba(4,10,8,0.82);backdrop-filter:blur(3px);display:flex;'
            + 'flex-direction:column;align-items:center;justify-content:center;'
            + `padding:${m ? '8px' : '0'};box-sizing:border-box;overflow:auto;`
            + 'font-family:"Trebuchet MS",system-ui,sans-serif;color:#eaffea;';
        const title = document.createElement('div');
        title.textContent = `UPGRADES — $${Math.floor(s.cash).toLocaleString()}`;
        title.style.cssText = `font:900 ${m ? 18 : 30}px/1.1 inherit;margin-bottom:${m ? 10 : 22}px;color:#9dffa0;`
            + 'text-shadow:0 0 18px rgba(60,255,120,0.5);';
        overlay.appendChild(title);

        const row = document.createElement('div');
        row.style.cssText = `display:flex;gap:${gap}px;flex-wrap:wrap;justify-content:center;max-width:96vw;`;
        UPGRADES.forEach((u) => {
            const lvl = s.up[u.key];
            const cost = u.cost(lvl);
            const afford = s.cash >= cost;
            const c = document.createElement('button');
            c.style.cssText = `cursor:pointer;color:#eaffea;text-align:center;width:${cw}px;height:${ch}px;`
                + `padding:${pad};border-radius:${m ? 10 : 14}px;box-sizing:border-box;`
                + `background:linear-gradient(160deg,rgba(18,48,28,0.95),rgba(8,24,14,0.95));`
                + `border:2px solid ${afford ? 'rgba(120,255,160,0.55)' : 'rgba(120,120,120,0.4)'};`
                + 'box-shadow:0 8px 30px rgba(0,0,0,0.5);transition:transform .12s;'
                + (afford ? '' : 'opacity:.55;');
            c.innerHTML = `<div style="font:800 ${tTitle}px/1.2 inherit;color:#9dffa0;margin-bottom:${m ? 4 : 10}px;">${u.t}</div>`
                + `<div style="font:600 ${tDesc}px/1.3 inherit;opacity:.92;margin-bottom:${m ? 6 : 14}px;">${u.d}</div>`
                + `<div style="font:700 ${tSub}px/1 inherit;opacity:.8;">Lv ${lvl}</div>`
                + `<div style="margin-top:${m ? 6 : 14}px;font:800 ${tCost}px/1 inherit;color:${afford ? '#9dffa0' : '#ff8a8a'};">$${cost.toLocaleString()}</div>`;
            c.onmouseenter = () => { c.style.transform = 'translateY(-6px)'; };
            c.onmouseleave = () => { c.style.transform = 'none'; };
            c.onclick = () => {
                if (s.cash < cost) return;
                s.cash -= cost;
                s.up[u.key] += 1;
                renderShop();
                updateHud();
                saveProgress();   // persist after buying an upgrade
            };
            row.appendChild(c);
        });
        overlay.appendChild(row);

        const bTitle = document.createElement('div');
        bTitle.textContent = 'BASE';
        bTitle.style.cssText = `font:900 ${m ? 14 : 20}px/1 inherit;margin:${m ? 12 : 26}px 0 ${m ? 6 : 12}px;color:#7fd0ff;`
            + 'text-shadow:0 0 14px rgba(80,180,255,0.4);';
        overlay.appendChild(bTitle);

        const bRow = document.createElement('div');
        bRow.style.cssText = `display:flex;gap:${gap}px;flex-wrap:wrap;justify-content:center;max-width:96vw;`;
        BASE_UPGRADES.forEach((u) => {
            const lvl = s.baseUp?.[u.key] || 0;
            const cost = u.cost(lvl);
            const afford = s.cash >= cost;
            const c = document.createElement('button');
            c.style.cssText = `cursor:pointer;color:#eaf7ff;text-align:center;width:${cw}px;height:${ch}px;`
                + `padding:${pad};border-radius:${m ? 10 : 14}px;box-sizing:border-box;`
                + 'background:linear-gradient(160deg,rgba(12,34,48,0.95),rgba(6,18,26,0.95));'
                + `border:2px solid ${afford ? 'rgba(120,210,255,0.62)' : 'rgba(120,120,120,0.4)'};`
                + 'box-shadow:0 8px 30px rgba(0,0,0,0.5);transition:transform .12s;'
                + (afford ? '' : 'opacity:.55;');
            c.innerHTML = `<div style="font:800 ${tTitle}px/1.2 inherit;color:#7fd0ff;margin-bottom:${m ? 4 : 10}px;">${u.t}</div>`
                + `<div style="font:600 ${tDesc}px/1.3 inherit;opacity:.92;margin-bottom:${m ? 6 : 14}px;">${u.d}</div>`
                + `<div style="font:700 ${tSub}px/1 inherit;opacity:.8;">Lv ${lvl}</div>`
                + `<div style="margin-top:${m ? 6 : 14}px;font:800 ${tCost}px/1 inherit;color:${afford ? '#7fd0ff' : '#ff8a8a'};">$${cost.toLocaleString()}</div>`;
            c.onmouseenter = () => { c.style.transform = 'translateY(-6px)'; };
            c.onmouseleave = () => { c.style.transform = 'none'; };
            c.onclick = () => {
                if (s.cash < cost) return;
                s.cash -= cost;
                s.baseUp ||= { lights: 0, security: 0, storage: 0, autoWater: 0 };
                s.baseUp[u.key] = lvl + 1;
                renderShop();
                updateHud();
                saveProgress();
            };
            bRow.appendChild(c);
        });
        overlay.appendChild(bRow);

        // ---- weapons section ------------------------------------------
        const wTitle = document.createElement('div');
        wTitle.textContent = 'WEAPONS';
        wTitle.style.cssText = `font:900 ${m ? 14 : 20}px/1 inherit;margin:${m ? 12 : 26}px 0 ${m ? 6 : 12}px;color:#ffd24a;`
            + 'text-shadow:0 0 14px rgba(255,180,60,0.4);';
        overlay.appendChild(wTitle);

        const wRow = document.createElement('div');
        wRow.style.cssText = `display:flex;gap:${gap}px;flex-wrap:wrap;justify-content:center;max-width:96vw;`;
        const weapons = [
            {
                t: 'Pistol', d: 'Ranged. Needs ammo.', cost: GUN_PRICE,
                owned: () => s.hasGun, sub: () => s.hasGun ? 'OWNED' : '',
                buy: () => { s.hasGun = true; attachHeldGun(); },
            },
            {
                t: 'Ammo', d: `+${AMMO_PER_PACK} pistol rounds`, cost: AMMO_PRICE,
                owned: () => false, sub: () => `Have: ${s.ammo}`,
                buy: () => { s.ammo += AMMO_PER_PACK; },
            },
            {
                t: 'Baseball Bat', d: 'Melee knockdown. No ammo.', cost: BAT_PRICE,
                owned: () => s.hasBat, sub: () => s.hasBat ? 'OWNED' : '',
                buy: () => { s.hasBat = true; },
            },
        ];
        weapons.forEach((w) => {
            const isOwned = w.owned();
            const afford = !isOwned && s.cash >= w.cost;
            const c = document.createElement('button');
            c.style.cssText = `cursor:pointer;color:#fff7e0;text-align:center;width:${wch}px;height:${ch}px;`
                + `padding:${pad};border-radius:${m ? 10 : 14}px;box-sizing:border-box;`
                + 'background:linear-gradient(160deg,rgba(48,38,12,0.95),rgba(24,18,6,0.95));'
                + `border:2px solid ${(afford || isOwned) ? 'rgba(255,210,90,0.6)' : 'rgba(120,120,120,0.4)'};`
                + 'box-shadow:0 8px 30px rgba(0,0,0,0.5);transition:transform .12s;'
                + ((afford || isOwned) ? '' : 'opacity:.55;');
            c.innerHTML = `<div style="font:800 ${tTitle}px/1.2 inherit;color:#ffd24a;margin-bottom:${m ? 4 : 10}px;">${w.t}</div>`
                + `<div style="font:600 ${tDesc}px/1.3 inherit;opacity:.92;margin-bottom:${m ? 6 : 12}px;">${w.d}</div>`
                + `<div style="font:700 ${tSub}px/1 inherit;opacity:.8;">${w.sub()}</div>`
                + `<div style="margin-top:${m ? 6 : 14}px;font:800 ${tCost}px/1 inherit;color:${isOwned ? '#9dffa0' : (afford ? '#ffd24a' : '#ff8a8a')};">${isOwned ? '✓ Owned' : '$' + w.cost.toLocaleString()}</div>`;
            c.onmouseenter = () => { c.style.transform = 'translateY(-6px)'; };
            c.onmouseleave = () => { c.style.transform = 'none'; };
            c.onclick = () => {
                if (w.owned() || s.cash < w.cost) return;
                s.cash -= w.cost;
                w.buy();
                renderShop();
                updateHud();
                saveProgress();   // persist after buying a weapon
            };
            wRow.appendChild(c);
        });
        overlay.appendChild(wRow);

        // ---- production: unlock new product lines (pills / coke) ----------
        const pTitle = document.createElement('div');
        pTitle.textContent = 'PRODUCTION';
        pTitle.style.cssText = `font:900 ${m ? 14 : 20}px/1 inherit;margin:${m ? 12 : 26}px 0 ${m ? 6 : 12}px;color:#ff7fd0;`
            + 'text-shadow:0 0 14px rgba(255,130,210,0.4);';
        overlay.appendChild(pTitle);

        const pRow = document.createElement('div');
        pRow.style.cssText = `display:flex;gap:${gap}px;flex-wrap:wrap;justify-content:center;max-width:96vw;`;
        // Data-driven from PRODUCTS: every locked, labPrice'd line is buyable.
        const PROD_SHOP = {
            shrooms: { t: '🍄 Mushroom Bed', d: `Grow ${PRODUCTS.shrooms.name} — pays ${PRODUCTS.shrooms.priceMult}×`, award: null },
            pills:   { t: '💊 Pill Press',    d: `Press ${PRODUCTS.pills.name} at the indoor lab — pays ${PRODUCTS.pills.priceMult}×, hotter`, award: 'pillPress' },
            coke:    { t: '❄️ Coke Lab',       d: `Cook ${PRODUCTS.coke.name} indoors — pays ${PRODUCTS.coke.priceMult}×, very hot`, award: 'cokeLab' },
            meth:    { t: '💎 Meth Lab',       d: `Cook ${PRODUCTS.meth.name} indoors — pays ${PRODUCTS.meth.priceMult}×, runs very hot`, award: null },
            lsd:     { t: '🌈 LSD Lab',        d: `Make ${PRODUCTS.lsd.name} indoors — pays ${PRODUCTS.lsd.priceMult}×, low heat`, award: null },
        };
        const production = Object.keys(PROD_SHOP).map((key) => {
            const def = PRODUCTS[key], meta = PROD_SHOP[key];
            return {
                t: meta.t, d: meta.d, cost: def.labPrice, color: def.color,
                owned: () => !!s[def.unlock],
                buy: () => { s[def.unlock] = true; if (meta.award) award(meta.award); },
            };
        });
        production.forEach((w) => {
            const isOwned = w.owned();
            const afford = !isOwned && s.cash >= w.cost;
            const c = document.createElement('button');
            c.style.cssText = `cursor:pointer;color:#ffe6f6;text-align:center;width:${wch}px;height:${ch}px;`
                + `padding:${pad};border-radius:${m ? 10 : 14}px;box-sizing:border-box;`
                + 'background:linear-gradient(160deg,rgba(48,12,40,0.95),rgba(24,6,20,0.95));'
                + `border:2px solid ${(afford || isOwned) ? 'rgba(255,130,210,0.6)' : 'rgba(120,120,120,0.4)'};`
                + 'box-shadow:0 8px 30px rgba(0,0,0,0.5);transition:transform .12s;'
                + ((afford || isOwned) ? '' : 'opacity:.55;');
            c.innerHTML = `<div style="font:800 ${tTitle}px/1.2 inherit;color:${w.color};margin-bottom:${m ? 4 : 10}px;">${w.t}</div>`
                + `<div style="font:600 ${tDesc}px/1.3 inherit;opacity:.92;margin-bottom:${m ? 6 : 12}px;">${w.d}</div>`
                + `<div style="font:700 ${tSub}px/1 inherit;opacity:.8;">${isOwned ? 'UNLOCKED' : 'one-time'}</div>`
                + `<div style="margin-top:${m ? 6 : 14}px;font:800 ${tCost}px/1 inherit;color:${isOwned ? '#9dffa0' : (afford ? w.color : '#ff8a8a')};">${isOwned ? '✓ Owned' : '$' + w.cost.toLocaleString()}</div>`;
            c.onmouseenter = () => { c.style.transform = 'translateY(-6px)'; };
            c.onmouseleave = () => { c.style.transform = 'none'; };
            c.onclick = () => {
                if (w.owned() || s.cash < w.cost) return;
                s.cash -= w.cost;
                w.buy();
                renderShop();
                updateHud();
                saveProgress();   // persist after unlocking a product line
            };
            pRow.appendChild(c);
        });
        overlay.appendChild(pRow);

        if (s.shroomQuestStarted || s.hasShrooms) {
            const sTitle = document.createElement('div');
            sTitle.textContent = 'SHROOM SUPPLIES';
            sTitle.style.cssText = `font:900 ${m ? 14 : 20}px/1 inherit;margin:${m ? 12 : 26}px 0 ${m ? 6 : 12}px;color:#d8a0ff;`
                + 'text-shadow:0 0 14px rgba(216,160,255,0.4);';
            overlay.appendChild(sTitle);
            const sRow = document.createElement('div');
            sRow.style.cssText = `display:flex;gap:${gap}px;flex-wrap:wrap;justify-content:center;max-width:96vw;`;
            const supply = [
                { t: 'Substrate', d: 'Pour into bed.', cost: SHROOM_SUBSTRATE_PRICE, sub: () => `Have: ${s.mushroomSubstrate || 0}`, buy: () => { s.mushroomSubstrate = (s.mushroomSubstrate || 0) + 1; } },
                { t: 'Shroom Spawn', d: 'Break + stir minigame.', cost: SHROOM_SPAWN_PRICE, sub: () => `Have: ${s.shroomSpawn || 0}`, buy: () => { s.shroomSpawn = (s.shroomSpawn || 0) + 1; } },
                { t: 'Spray Bottle', d: 'Fill at tap; mist blue targets.', cost: SHROOM_SPRAY_BOTTLE_PRICE, owned: () => s.sprayBottle, sub: () => s.sprayBottle ? (s.sprayBottleFilled ? 'FULL' : 'EMPTY') : 'one-time', buy: () => { s.sprayBottle = true; } },
                { t: 'AC Unit', d: 'Cool bed or heat racks.', cost: SHROOM_AC_PRICE, sub: () => `${s.shroomAcUnits || 0}/2`, buy: () => { s.shroomAcUnits = Math.min(2, (s.shroomAcUnits || 0) + 1); }, maxed: () => (s.shroomAcUnits || 0) >= 2 },
                { t: 'Drying Rack', d: 'Dry wet shrooms.', cost: SHROOM_RACK_PRICE, sub: () => `${s.dryingRacks || 0}/1`, buy: () => { s.dryingRacks = Math.min(1, (s.dryingRacks || 0) + 1); }, maxed: () => (s.dryingRacks || 0) >= 1 },
            ];
            supply.forEach((w) => {
                const isOwned = w.owned?.() || w.maxed?.();
                const afford = !isOwned && s.cash >= w.cost && s.hasShrooms;
                const c = document.createElement('button');
                c.style.cssText = `cursor:pointer;color:#f7eaff;text-align:center;width:${wch}px;height:${ch}px;`
                    + `padding:${pad};border-radius:${m ? 10 : 14}px;box-sizing:border-box;`
                    + 'background:linear-gradient(160deg,rgba(38,18,52,0.95),rgba(16,8,24,0.95));'
                    + `border:2px solid ${(afford || isOwned) ? 'rgba(216,160,255,0.65)' : 'rgba(120,120,120,0.4)'};`
                    + 'box-shadow:0 8px 30px rgba(0,0,0,0.5);transition:transform .12s;'
                    + ((afford || isOwned) ? '' : 'opacity:.55;');
                c.innerHTML = `<div style="font:800 ${tTitle}px/1.2 inherit;color:#d8a0ff;margin-bottom:${m ? 4 : 10}px;">${w.t}</div>`
                    + `<div style="font:600 ${tDesc}px/1.3 inherit;opacity:.92;margin-bottom:${m ? 6 : 12}px;">${w.d}</div>`
                    + `<div style="font:700 ${tSub}px/1 inherit;opacity:.8;">${w.sub()}</div>`
                    + `<div style="margin-top:${m ? 6 : 14}px;font:800 ${tCost}px/1 inherit;color:${isOwned ? '#9dffa0' : (afford ? '#d8a0ff' : '#ff8a8a')};">${isOwned ? '✓ Owned' : '$' + w.cost.toLocaleString()}</div>`;
                c.onmouseenter = () => { c.style.transform = 'translateY(-6px)'; };
                c.onmouseleave = () => { c.style.transform = 'none'; };
                c.onclick = () => {
                    if (isOwned || !s.hasShrooms || s.cash < w.cost) return;
                    s.cash -= w.cost;
                    w.buy();
                    renderShop(); updateHud(); saveProgress();
                };
                sRow.appendChild(c);
            });
            overlay.appendChild(sRow);
        }

        // ---- vehicle: buy the car (parks it home + unlocks deliveries) ----
        const vTitle = document.createElement('div');
        vTitle.textContent = 'VEHICLE';
        vTitle.style.cssText = `font:900 ${m ? 14 : 20}px/1 inherit;margin:${m ? 12 : 26}px 0 ${m ? 6 : 12}px;color:#9dffa0;`
            + 'text-shadow:0 0 14px rgba(60,255,120,0.4);';
        overlay.appendChild(vTitle);

        const vRow = document.createElement('div');
        vRow.style.cssText = `display:flex;gap:${gap}px;flex-wrap:wrap;justify-content:center;max-width:96vw;`;
        {
            const isOwned = s.hasCar;
            const afford = !isOwned && s.cash >= CAR_PRICE;
            const c = document.createElement('button');
            c.style.cssText = `cursor:pointer;color:#eaffea;text-align:center;width:${wch}px;height:${ch}px;`
                + `padding:${pad};border-radius:${m ? 10 : 14}px;box-sizing:border-box;`
                + 'background:linear-gradient(160deg,rgba(18,48,28,0.95),rgba(8,24,14,0.95));'
                + `border:2px solid ${(afford || isOwned) ? 'rgba(120,255,160,0.6)' : 'rgba(120,120,120,0.4)'};`
                + 'box-shadow:0 8px 30px rgba(0,0,0,0.5);transition:transform .12s;'
                + ((afford || isOwned) ? '' : 'opacity:.55;');
            c.innerHTML = `<div style="font:800 ${tTitle}px/1.2 inherit;color:#9dffa0;margin-bottom:${m ? 4 : 10}px;">🚗 Car</div>`
                + `<div style="font:600 ${tDesc}px/1.3 inherit;opacity:.92;margin-bottom:${m ? 6 : 12}px;">Parks behind the house. Unlocks long-distance delivery contracts.</div>`
                + `<div style="font:700 ${tSub}px/1 inherit;opacity:.8;">${isOwned ? 'OWNED' : 'one-time'}</div>`
                + `<div style="margin-top:${m ? 6 : 14}px;font:800 ${tCost}px/1 inherit;color:${isOwned ? '#9dffa0' : (afford ? '#9dffa0' : '#ff8a8a')};">${isOwned ? '✓ Owned' : '$' + CAR_PRICE.toLocaleString()}</div>`;
            c.onmouseenter = () => { c.style.transform = 'translateY(-6px)'; };
            c.onmouseleave = () => { c.style.transform = 'none'; };
            c.onclick = () => {
                if (s.hasCar || s.cash < CAR_PRICE) return;
                buyCar(s);
                renderShop();
                updateHud();
            };
            vRow.appendChild(c);
        }
        overlay.appendChild(vRow);

        // ---- bribe: pay cash to clear heat / drop the wanted level --------
        if (s.heat > 1) {
            const bribeCost = Math.ceil(s.heat * BRIBE_COST_PER_HEAT);
            const canBribe = s.cash >= bribeCost;
            const bribe = document.createElement('button');
            bribe.style.cssText = `margin-top:${m ? 10 : 20}px;cursor:pointer;color:#ffe6c0;`
                + `padding:${m ? '8px 18px' : '12px 26px'};border-radius:12px;`
                + 'background:linear-gradient(160deg,rgba(60,40,12,0.95),rgba(30,18,6,0.95));'
                + `border:2px solid ${canBribe ? 'rgba(255,180,80,0.7)' : 'rgba(120,120,120,0.4)'};`
                + (canBribe ? '' : 'opacity:.55;');
            bribe.innerHTML = `<span style="font:800 ${m ? 13 : 16}px/1 inherit;color:#ffd24a;">💵 Bribe the cops</span>`
                + `<span style="display:block;font:600 ${m ? 10 : 12}px/1.3 inherit;opacity:.85;margin-top:4px;">Clear all heat · $${bribeCost.toLocaleString()}</span>`;
            bribe.onclick = () => {
                if (s.cash < bribeCost) return;
                s.cash -= bribeCost;
                if (s.today) s.today.spent += bribeCost;
                s.heat = 0;
                for (const cop of s.police) { try { core.scene?.remove(cop.mesh); } catch (e) {} }
                s.police.length = 0;
                renderShop();
                updateHud();
                saveProgress();
            };
            overlay.appendChild(bribe);
        }

        const close = document.createElement('button');
        close.textContent = m ? 'CLOSE' : 'CLOSE (Esc)';
        close.style.cssText = `margin-top:${m ? 10 : 26}px;padding:${m ? '8px 22px' : '12px 30px'};cursor:pointer;`
            + `font:800 ${m ? 13 : 18}px/1 inherit;color:#fff;border-radius:12px;`
            + 'background:linear-gradient(160deg,#1f7a3a,#0e3a1d);'
            + 'border:2px solid rgba(120,255,160,0.5);';
        close.onclick = () => closeShop();
        overlay.appendChild(close);

        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        _shopEl = overlay;
    }
    function closeShop() {
        const s = window.drugTycoon;
        if (_shopEl?.parentNode) _shopEl.remove();
        _shopEl = null;
        if (s) s.shopOpen = false;
        gameplay.roguePaused = false;
        const { renderer } = core;
        if (renderer?.domElement && !window.matchMedia?.('(pointer:coarse)')?.matches) {
            const resume = () => {
                renderer.domElement.removeEventListener('click', resume);
                try { renderer.domElement.requestPointerLock?.(); } catch (e) {}
            };
            renderer.domElement.addEventListener('click', resume);
        }
    }

    // ---- outdoor seed shop ----------------------------------------------
    // A separate storefront on the street: buy weed seeds in three tiers before
    // you can plant. Each tier strictly beats the last (grow speed + yield +
    // potency). Buying also selects that tier as the one you'll plant next.
    let _seedShopEl = null;
    function openSeedShop() {
        const s = ensureState();
        if (s.seedShopOpen) return;
        s.seedShopOpen = true;
        gameplay.roguePaused = true;
        try { document.exitPointerLock?.(); } catch (e) {}
        renderSeedShop();
    }
    function buySeed(s, tier, qty = 1) {
        const seed = SEED_TIERS[tier];
        if (!seed) return;
        const cost = seed.cost * qty;
        if (s.cash < cost) return;
        s.cash -= cost;
        s.seeds[tier] = (s.seeds[tier] | 0) + qty;
        s.seedTier = tier;          // plant the tier you just bought
        if (tier === SEED_TIERS.length - 1) award('exoticSeed');
        renderSeedShop();
        updateHud();
        saveProgress();
    }
    function renderSeedShop() {
        const s = ensureState();
        if (_seedShopEl?.parentNode) _seedShopEl.remove();
        const m = isMobileUi();
        const cw = m ? 120 : 230, ch = m ? 150 : 280;
        const pad = m ? '10px 8px' : '20px 16px';
        const gap = m ? 10 : 20;
        const tTitle = m ? 15 : 22, tDesc = m ? 10 : 14, tSub = m ? 9 : 13, tCost = m ? 13 : 18;

        const overlay = document.createElement('div');
        overlay.className = 'tycoon-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:1200;pointer-events:auto;'
            + 'background:rgba(6,12,6,0.84);backdrop-filter:blur(3px);display:flex;'
            + 'flex-direction:column;align-items:center;justify-content:center;'
            + `padding:${m ? '8px' : '0'};box-sizing:border-box;overflow:auto;`
            + 'font-family:"Trebuchet MS",system-ui,sans-serif;color:#eaffea;';

        const title = document.createElement('div');
        title.textContent = `🌱 SEED SHOP — $${Math.floor(s.cash).toLocaleString()}`;
        title.style.cssText = `font:900 ${m ? 18 : 32}px/1.1 inherit;margin-bottom:${m ? 4 : 10}px;color:#b6ff6a;`
            + 'text-shadow:0 0 18px rgba(120,255,80,0.5);';
        overlay.appendChild(title);

        const sub = document.createElement('div');
        sub.textContent = 'Better seeds → faster grow, bigger yield, higher grade.';
        sub.style.cssText = `font:600 ${m ? 10 : 14}px/1.3 inherit;opacity:.8;margin-bottom:${m ? 12 : 24}px;`;
        overlay.appendChild(sub);

        const row = document.createElement('div');
        row.style.cssText = `display:flex;gap:${gap}px;flex-wrap:wrap;justify-content:center;max-width:96vw;`;
        SEED_TIERS.forEach((seed, tier) => {
            const owned = s.seeds[tier] | 0;
            const afford = s.cash >= seed.cost;
            const selected = (s.seedTier | 0) === tier;
            const c = document.createElement('button');
            c.style.cssText = `cursor:pointer;color:#eaffea;text-align:center;width:${cw}px;height:${ch}px;`
                + `padding:${pad};border-radius:${m ? 12 : 16}px;box-sizing:border-box;`
                + 'background:linear-gradient(160deg,rgba(16,44,22,0.96),rgba(6,20,10,0.96));'
                + `border:3px solid ${selected ? seed.color : (afford ? 'rgba(150,255,120,0.5)' : 'rgba(120,120,120,0.4)')};`
                + 'box-shadow:0 8px 30px rgba(0,0,0,0.5);transition:transform .12s;'
                + (afford ? '' : 'opacity:.6;');
            c.innerHTML = `<div style="font:900 ${tTitle}px/1.2 inherit;color:${seed.color};margin-bottom:${m ? 4 : 10}px;">${seed.t}</div>`
                + `<div style="font:600 ${tDesc}px/1.3 inherit;opacity:.92;margin-bottom:${m ? 6 : 12}px;">${seed.d}</div>`
                + `<div style="font:700 ${tSub}px/1.5 inherit;opacity:.85;">`
                + `⚡ Grow ×${seed.speed.toFixed(2)}<br>🌿 Yield ×${seed.yieldMult.toFixed(2)}<br>⭐ Grade +${Math.round(seed.qBonus * 100)}%</div>`
                + `<div style="margin-top:${m ? 6 : 12}px;font:800 ${tSub}px/1 inherit;color:#cdd6e3;">Owned: ${owned}${selected ? ' · ✓ planting' : ''}</div>`
                + `<div style="margin-top:${m ? 4 : 8}px;font:900 ${tCost}px/1 inherit;color:${afford ? seed.color : '#ff8a8a'};">$${seed.cost.toLocaleString()}</div>`;
            c.onmouseenter = () => { c.style.transform = 'translateY(-6px)'; };
            c.onmouseleave = () => { c.style.transform = 'none'; };
            c.onclick = (ev) => buySeed(s, tier, ev.shiftKey ? 5 : 1);
            row.appendChild(c);
        });
        overlay.appendChild(row);

        const hint = document.createElement('div');
        hint.textContent = 'Click a seed to buy one (Shift+click = ×5). Selected tier is planted next.';
        hint.style.cssText = `font:600 ${m ? 9 : 12}px/1.3 inherit;opacity:.7;margin-top:${m ? 10 : 18}px;`;
        overlay.appendChild(hint);

        const close = document.createElement('button');
        close.textContent = m ? 'CLOSE' : 'CLOSE (Esc)';
        close.style.cssText = `margin-top:${m ? 12 : 26}px;padding:${m ? '8px 22px' : '12px 30px'};cursor:pointer;`
            + `font:800 ${m ? 13 : 18}px/1 inherit;color:#fff;border-radius:12px;`
            + 'background:linear-gradient(160deg,#2f8a2a,#103a12);'
            + 'border:2px solid rgba(150,255,120,0.5);';
        close.onclick = () => closeSeedShop();
        overlay.appendChild(close);

        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        _seedShopEl = overlay;
    }
    function closeSeedShop() {
        const s = window.drugTycoon;
        if (_seedShopEl?.parentNode) _seedShopEl.remove();
        _seedShopEl = null;
        if (s) s.seedShopOpen = false;
        gameplay.roguePaused = false;
        const { renderer } = core;
        if (renderer?.domElement && !window.matchMedia?.('(pointer:coarse)')?.matches) {
            const resume = () => {
                renderer.domElement.removeEventListener('click', resume);
                try { renderer.domElement.requestPointerLock?.(); } catch (e) {}
            };
            renderer.domElement.addEventListener('click', resume);
        }
    }

    // ---- outdoor grow-juice shop ----------------------------------------
    // Second outdoor storefront (across the street from the seed shop). Buy
    // bottles of grow juice; pour one on a growing plant (hold Fire near it)
    // to multiply its grow rate for the rest of the cycle.
    let _juiceShopEl = null;
    function openJuiceShop() {
        const s = ensureState();
        if (s.juiceShopOpen) return;
        s.juiceShopOpen = true;
        gameplay.roguePaused = true;
        try { document.exitPointerLock?.(); } catch (e) {}
        renderJuiceShop();
    }
    function buyJuice(s, tier, qty = 1) {
        const juice = JUICE_TIERS[tier];
        if (!juice) return;
        const cost = juice.cost * qty;
        if (s.cash < cost) return;
        s.cash -= cost;
        s.juices[tier] = (s.juices[tier] | 0) + qty;
        s.juiceTier = tier;          // pour the tier you just bought
        renderJuiceShop();
        updateHud();
        saveProgress();
    }
    function renderJuiceShop() {
        const s = ensureState();
        if (_juiceShopEl?.parentNode) _juiceShopEl.remove();
        const m = isMobileUi();
        const cw = m ? 120 : 230, ch = m ? 150 : 280;
        const pad = m ? '10px 8px' : '20px 16px';
        const gap = m ? 10 : 20;
        const tTitle = m ? 15 : 22, tDesc = m ? 10 : 14, tSub = m ? 9 : 13, tCost = m ? 13 : 18;

        const overlay = document.createElement('div');
        overlay.className = 'tycoon-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:1200;pointer-events:auto;'
            + 'background:rgba(6,10,14,0.84);backdrop-filter:blur(3px);display:flex;'
            + 'flex-direction:column;align-items:center;justify-content:center;'
            + `padding:${m ? '8px' : '0'};box-sizing:border-box;overflow:auto;`
            + 'font-family:"Trebuchet MS",system-ui,sans-serif;color:#eaffff;';

        const title = document.createElement('div');
        title.textContent = `🧪 GROW JUICE — $${Math.floor(s.cash).toLocaleString()}`;
        title.style.cssText = `font:900 ${m ? 18 : 32}px/1.1 inherit;margin-bottom:${m ? 4 : 10}px;color:#7fd0ff;`
            + 'text-shadow:0 0 18px rgba(80,180,255,0.5);';
        overlay.appendChild(title);

        const sub = document.createElement('div');
        sub.textContent = 'Pour on a growing plant (hold Fire near it). Boost lasts till harvest.';
        sub.style.cssText = `font:600 ${m ? 10 : 14}px/1.3 inherit;opacity:.8;margin-bottom:${m ? 12 : 24}px;`;
        overlay.appendChild(sub);

        const row = document.createElement('div');
        row.style.cssText = `display:flex;gap:${gap}px;flex-wrap:wrap;justify-content:center;max-width:96vw;`;
        JUICE_TIERS.forEach((juice, tier) => {
            const owned = s.juices[tier] | 0;
            const afford = s.cash >= juice.cost;
            const selected = (s.juiceTier | 0) === tier;
            const c = document.createElement('button');
            c.style.cssText = `cursor:pointer;color:#eaffff;text-align:center;width:${cw}px;height:${ch}px;`
                + `padding:${pad};border-radius:${m ? 12 : 16}px;box-sizing:border-box;`
                + 'background:linear-gradient(160deg,rgba(14,32,46,0.96),rgba(6,16,24,0.96));'
                + `border:3px solid ${selected ? juice.color : (afford ? 'rgba(140,210,255,0.5)' : 'rgba(120,120,120,0.4)')};`
                + 'box-shadow:0 8px 30px rgba(0,0,0,0.5);transition:transform .12s;'
                + (afford ? '' : 'opacity:.6;');
            c.innerHTML = `<div style="font:900 ${tTitle}px/1.2 inherit;color:${juice.color};margin-bottom:${m ? 4 : 10}px;">${juice.t}</div>`
                + `<div style="font:600 ${tDesc}px/1.3 inherit;opacity:.92;margin-bottom:${m ? 6 : 12}px;">${juice.d}</div>`
                + `<div style="font:700 ${tSub}px/1.5 inherit;opacity:.85;">⚡ Grow ×${juice.speed.toFixed(2)}</div>`
                + `<div style="margin-top:${m ? 6 : 12}px;font:800 ${tSub}px/1 inherit;color:#cdd6e3;">Owned: ${owned}${selected ? ' · ✓ pouring' : ''}</div>`
                + `<div style="margin-top:${m ? 4 : 8}px;font:900 ${tCost}px/1 inherit;color:${afford ? juice.color : '#ff8a8a'};">$${juice.cost.toLocaleString()}</div>`;
            c.onmouseenter = () => { c.style.transform = 'translateY(-6px)'; };
            c.onmouseleave = () => { c.style.transform = 'none'; };
            c.onclick = (ev) => buyJuice(s, tier, ev.shiftKey ? 5 : 1);
            row.appendChild(c);
        });
        overlay.appendChild(row);

        const hint = document.createElement('div');
        hint.textContent = 'Click a juice to buy one (Shift+click = ×5). Selected tier is poured next.';
        hint.style.cssText = `font:600 ${m ? 9 : 12}px/1.3 inherit;opacity:.7;margin-top:${m ? 10 : 18}px;`;
        overlay.appendChild(hint);

        const close = document.createElement('button');
        close.textContent = m ? 'CLOSE' : 'CLOSE (Esc)';
        close.style.cssText = `margin-top:${m ? 12 : 26}px;padding:${m ? '8px 22px' : '12px 30px'};cursor:pointer;`
            + `font:800 ${m ? 13 : 18}px/1 inherit;color:#fff;border-radius:12px;`
            + 'background:linear-gradient(160deg,#1f5a8a,#0c2840);'
            + 'border:2px solid rgba(140,210,255,0.5);';
        close.onclick = () => closeJuiceShop();
        overlay.appendChild(close);

        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        _juiceShopEl = overlay;
    }
    function closeJuiceShop() {
        const s = window.drugTycoon;
        if (_juiceShopEl?.parentNode) _juiceShopEl.remove();
        _juiceShopEl = null;
        if (s) s.juiceShopOpen = false;
        gameplay.roguePaused = false;
        const { renderer } = core;
        if (renderer?.domElement && !window.matchMedia?.('(pointer:coarse)')?.matches) {
            const resume = () => {
                renderer.domElement.removeEventListener('click', resume);
                try { renderer.domElement.requestPointerLock?.(); } catch (e) {}
            };
            renderer.domElement.addEventListener('click', resume);
        }
    }

    // ---- NPC buyers + police -------------------------------------------
    // Humanoid people use a hidden ragdoll box rig with a visible Man.fbx
    // shell. They still move kinematically here; on death the hidden rig is
    // revealed and converted to a Jolt ragdoll.
    const SKIN_TONES = ['#e8b893', '#c68642', '#8d5524', '#f1c27d', '#ffdbac'];
    const SHIRT_TONES = ['#3da6ff', '#2dd4bf', '#f97316', '#a855f7', '#eab308', '#ef4444'];
    let buyerSpawnSerial = 0;
    function randomFrom(arr) { return arr[(Math.random() * arr.length) | 0]; }

    function placePerson(group, x, y, z, faceY = 0) {
        const { scene } = core;
        group.position.set(x, y, z);
        group.rotation.y = faceY;
        group.updateMatrixWorld(true);
        scene?.add(group);
    }
    function makeBuyerMesh(shirtColor) {
        // Per 10 buyers: 2 are Man (Man.fbx), 1 is Emmy (Walking.fbx), rest are
        // box-rig people. Both FBX visuals wear Emmy's packed diffuse/normal material.
        const slot = buyerSpawnSerial++ % 10;
        const useFbxVisual = slot < 3;
        const visualVariant = slot < 2 ? 'man' : 'emmy';
        return makeTycoonPersonMesh({
            skinColor: randomFrom(SKIN_TONES),
            shirtColor,
            pantsColor: '#22303c',
            showColorBadge: false,
            badgeColor: shirtColor,
            useWalkingVisual: useFbxVisual,
            visualVariant,
        });
    }
    function spawnBuyer(s, layout) {
        const shirtColor = randomFrom(SHIRT_TONES);
        const group = makeBuyerMesh(shirtColor);
        const radius = layout.streetRadius ?? 16;
        const ang = Math.random() * Math.PI * 2;
        const sp = pushOffRoad(new THREE.Vector3(Math.cos(ang) * radius, 0, Math.sin(ang) * radius));
        placePerson(group, sp.x, layout.spawnY ?? 0, sp.z);
        const isNarc = Math.random() < NARC_CHANCE;
        // The higher your rep, the more likely this buyer walks straight to
        // your shop instead of just wandering the street. Narcs never head
        // for the shop (they're "patrolling").
        const repFrac = (s.rep ?? REP_START) / 100;
        const wantsShop = !isNarc && Array.isArray(layout.homeDoor) && Math.random() < repFrac;
        const target = wantsShop
            ? shopQueuePoint(layout)
            : randomStreetPoint(layout);
        const npc = { mesh: group, target, wantsBuy: true, shirtColor, isNarc, wantsShop, queueing: false };
        s.npcs.push(npc);
        return npc;
    }
    // Per-frame buyer simulation: top up to rep-driven cap, despawn extras,
    // and tick movement. Runs whether the player is outside on the street or
    // inside the shop so buyers keep flowing to/from the counter either way.
    function tickBuyers(s, layout, playerPos, dt) {
        const cap = maxBuyers(s);
        while (s.npcs.length < cap) spawnBuyer(s, layout);
        while (s.npcs.length > cap) {
            // Drop street wanderers first; never the active order buyer or
            // someone already queueing (kicking customers looks bad).
            let worstIdx = -1, worstD = -1;
            for (let i = 0; i < s.npcs.length; i++) {
                const n = s.npcs[i];
                if (!n.mesh || n.shirtColor === s.orderColor || n.queueing) continue;
                const d = Math.hypot(n.mesh.position.x - playerPos.x, n.mesh.position.z - playerPos.z);
                if (d > worstD) { worstD = d; worstIdx = i; }
            }
            if (worstIdx < 0) break;
            const dropped = s.npcs.splice(worstIdx, 1)[0];
            // Return any FBX visual to the pool before discarding the rig so
            // the pre-warmed pool stays full instead of draining over time.
            if (dropped?.mesh?.userData?.walkingVisualAttached) releaseFbxBuyerVisual(dropped.mesh);
            try { core.scene?.remove(dropped.mesh); } catch (e) {}
        }

        const repFrac = (s.rep ?? REP_START) / 100;
        for (const n of s.npcs) {
            if (!n.mesh) continue;
            const insideShop = n.where === 'inside';
            // Visibility follows the player — only render the buyers that
            // share the player's current location (street vs. shop interior).
            n.mesh.visible = insideShop ? !!s.inRoom : !s.inRoom;
            // Distance LOD for FBX buyers: swap to the cheap box rig when far.
            if (n.mesh.userData?.walkingVisualAttached) {
                const cp = core.camera?.position || playerPos;
                const dx = n.mesh.position.x - cp.x, dz = n.mesh.position.z - cp.z;
                const far = (dx * dx + dz * dz) > (FBX_BUYER_LOD_DISTANCE * FBX_BUYER_LOD_DISTANCE);
                setBuyerLodFar(n.mesh, far);
            }
            if (n.queueing) {
                // Outside queue + a roll → step into the shop. Chance scales
                // with rep (0% at Pariah, 60%/sec at Legend) so only the
                // popular shops fill up with actual indoor customers.
                if (!insideShop && Array.isArray(layout.shopCounterCustomerSide)
                    && !n.isNarc && Math.random() < repFrac * 0.6 * dt) {
                    const inside = layout.shopInsideAnchor || layout.growRoomSpawn;
                    n.mesh.position.set(inside[0], inside[1] - 0.85, inside[2]);
                    // Queue slot: stand SLOT_GAP behind whoever's already inside
                    // so customers form a line at the register instead of all
                    // piling onto the same counter spot ("2 people in 1").
                    const slot = s.npcs.filter((o) => o !== n && o.where === 'inside').length;
                    n.queueSlot = slot;
                    n.target = counterQueuePoint(layout, slot);
                    n.where = 'inside';
                    n.queueing = false;
                }
                continue;
            }
            const arrived = moveToward(n.mesh, n.target, NPC_WANDER_SPEED, dt, layout);
            // Free street wanderers turn around when they hit a road (those
            // heading to/at the shop are exempt — the storefront is off-road).
            // bounceOffRoad clamps them to the kerb and re-aims away, so they
            // visibly flip direction instead of sliding along the edge.
            if (!insideShop && !n.wantsShop && bounceOffRoad(n.mesh.position, n)) {
                if (n.mesh.rotation) {
                    const dx = n.target.x - n.mesh.position.x, dz = n.target.z - n.mesh.position.z;
                    n.mesh.rotation.y = Math.atan2(dx, dz);
                }
                continue;   // skip the arrival re-roll this frame
            }
            if (arrived) {
                if (insideShop) {
                    // Arrived at the counter — face the register and wait.
                    n.queueing = true;
                    if (n.mesh.rotation) n.mesh.rotation.y = Math.PI;
                } else if (n.wantsShop) {
                    n.queueing = true;
                    if (n.mesh.rotation) n.mesh.rotation.y = Math.PI * 0.5;
                } else if (!n.isNarc && Array.isArray(layout.homeDoor) && Math.random() < repFrac * 0.5) {
                    // Street wanderer with rep tailwind: head to the shop.
                    n.wantsShop = true;
                    n.target = shopQueuePoint(layout);
                } else {
                    n.target = randomStreetPoint(layout);
                }
            }
        }

        // Re-pack the indoor queue: order inside buyers by distance to the
        // register (slot 0 = nearest) and re-assign each its slot point so
        // when the front customer is served, the rest shuffle forward.
        if (Array.isArray(layout.shopCounterCustomerSide)) {
            const c = layout.shopCounterCustomerSide;
            const inside = s.npcs.filter((n) => n.where === 'inside' && n.mesh);
            inside.sort((a, b) =>
                ((a.mesh.position.z - c[2]) ** 2 + (a.mesh.position.x - c[0]) ** 2)
                - ((b.mesh.position.z - c[2]) ** 2 + (b.mesh.position.x - c[0]) ** 2));
            inside.forEach((n, slot) => {
                if (n.queueSlot === slot) return;   // already in the right place
                n.queueSlot = slot;
                n.target = counterQueuePoint(layout, slot);
                n.queueing = false;   // walk to the new (forward) slot
            });
        }
    }

    // Pick a point right in front of the WEED SHOP door, with a small lateral
    // jitter so multiple shoppers don't stack on the same spot. Buyers
    // targeting this point line up as a small queue at the storefront.
    function shopQueuePoint(layout) {
        const d = layout.homeDoor;            // [doorX, y, doorZ], outward = +X
        const y = layout.spawnY ?? 0;
        const stepOut = 1.5 + Math.random() * 1.8;   // 1.5..3.3m off the door
        const lateral = (Math.random() - 0.5) * 2.6; // ±1.3m sideways
        return new THREE.Vector3(d[0] + stepOut, y, d[2] + lateral);
    }
    // Slot 0 stands at the register; each higher slot lines up SLOT_GAP behind
    // it (toward the room's south wall, -Z), so inside buyers form a queue.
    const QUEUE_SLOT_GAP = 1.1;
    function counterQueuePoint(layout, slot) {
        const c = layout.shopCounterCustomerSide;   // [x, y, z], register front
        const y = layout.spawnY ?? 0;
        // Tiny stable lateral stagger so the line isn't a perfect single file.
        const lateral = (slot % 2 === 0 ? 1 : -1) * 0.25 * (slot > 0 ? 1 : 0);
        return new THREE.Vector3(c[0] + lateral, y, c[2] - slot * QUEUE_SLOT_GAP);
    }
    function spawnRivalDealer(s, layout) {
        // Notorious players draw armed rivals: a dark jacket marks the shooters.
        const armed = (s.heat || 0) >= RIVAL_ARM_HEAT && Math.random() < RIVAL_ARM_CHANCE;
        const group = makeTycoonPersonMesh({
            skinColor: randomFrom(SKIN_TONES),
            shirtColor: armed ? '#3a0d0d' : '#7f1d1d',
            pantsColor: '#151515',
            showColorBadge: true,
            badgeColor: armed ? '#ff5a5a' : '#ff8a8a',
        });
        const radius = (layout.streetRadius ?? 16) * 1.05;
        const ang = Math.random() * Math.PI * 2;
        placePerson(group, Math.cos(ang) * radius, layout.spawnY ?? 0, Math.sin(ang) * radius);
        const rival = {
            mesh: group,
            target: randomStreetPoint(layout),
            wantsBuy: false,
            isRival: true,
            armed,                // armed rivals hunt + shoot instead of poaching
            nextPoachAt: 0,
            nextMugAt: 0,
            nextFireAt: 0,
        };
        if (armed) group.scale.multiplyScalar(1.04);   // slightly bigger silhouette
        s.rivals.push(rival);
        floatText(armed ? '🔫 Armed rival hit the block' : 'Rival dealer hit the block',
            group.position.clone().setY(2), armed ? '#ff5a5a' : '#ff8a8a');
        return rival;
    }
    function spawnPolice(s, layout) {
        const group = makeTycoonPersonMesh({
            skinColor: randomFrom(SKIN_TONES),
            shirtColor: '#1d4ed8',   // police blue
            pantsColor: '#0b1b3a',
            showColorBadge: true,
            badgeColor: '#4f8cff',
        });
        // Cops spawn ONLY at the map edges (perimeter), then walk inward — a
        // random point on the square boundary just inside the wall.
        const edge = (layout.mapHalf ?? 40) - 1.5;
        let x, z;
        if (Math.random() < 0.5) {                 // N or S edge
            x = (Math.random() * 2 - 1) * edge;
            z = (Math.random() < 0.5 ? -1 : 1) * edge;
        } else {                                   // E or W edge
            x = (Math.random() < 0.5 ? -1 : 1) * edge;
            z = (Math.random() * 2 - 1) * edge;
        }
        placePerson(group, x, layout.spawnY ?? 0, z);
        const cop = { mesh: group };
        s.police.push(cop);
        return cop;
    }
    // The core block's roads run along x=0 (N-S) and z=0 (E-W), 9 wide. Keep
    // wandering pedestrians off the asphalt: shove a point within ROAD_CLEAR of
    // either centreline out past the kerb onto the grass.
    const ROAD_CLEAR = 6.0;   // road half (4.5) + a margin so they walk the verge
    function pushOffRoad(v) {
        if (Math.abs(v.x) < ROAD_CLEAR) v.x = (v.x >= 0 ? 1 : -1) * ROAD_CLEAR;
        if (Math.abs(v.z) < ROAD_CLEAR) v.z = (v.z >= 0 ? 1 : -1) * ROAD_CLEAR;
        return v;
    }
    // If `pos` is on (or in) a road, clamp it back to the kerb and aim the
    // wanderer's target AWAY from that road so it flips around. Returns true if
    // a road was hit this frame.
    function bounceOffRoad(pos, n) {
        let hit = false;
        if (Math.abs(pos.x) < ROAD_CLEAR) {
            const side = pos.x >= 0 ? 1 : -1;
            pos.x = side * ROAD_CLEAR;
            n.target.x = side * (ROAD_CLEAR + 6 + Math.random() * 14);   // walk deeper into the grass
            hit = true;
        }
        if (Math.abs(pos.z) < ROAD_CLEAR) {
            const side = pos.z >= 0 ? 1 : -1;
            pos.z = side * ROAD_CLEAR;
            n.target.z = side * (ROAD_CLEAR + 6 + Math.random() * 14);
            hit = true;
        }
        return hit;
    }
    function randomStreetPoint(layout) {
        const r = (layout.streetRadius ?? 16) * (0.3 + Math.random() * 0.7);
        const ang = Math.random() * Math.PI * 2;
        return pushOffRoad(new THREE.Vector3(Math.cos(ang) * r, layout.spawnY ?? 0, Math.sin(ang) * r));
    }

    function removeLivePerson(s, person) {
        let idx = s.npcs.indexOf(person);
        if (idx >= 0) { s.npcs.splice(idx, 1); return 'buyer'; }
        idx = s.rivals.indexOf(person);
        if (idx >= 0) { s.rivals.splice(idx, 1); return 'rival'; }
        idx = s.police.indexOf(person);
        if (idx >= 0) { s.police.splice(idx, 1); return 'police'; }
        idx = s.patrol.indexOf(person);
        if (idx >= 0) { s.patrol.splice(idx, 1); return 'police'; }
        return '';
    }

    // ---- crew: hired VIP dealers ---------------------------------------
    // Spawn the visible body for one hired dealer (shirt = their old buyer
    // colour, with a green armband cue) and register it in s.crew.
    function spawnCrewMember(s, layout, color, xp = 0, earned = 0) {
        const group = makeTycoonPersonMesh({
            skinColor: randomFrom(SKIN_TONES),
            shirtColor: color,
            pantsColor: '#22331f',
            showColorBadge: true,
            badgeColor: color,
        });
        const p = randomStreetPoint(layout);
        placePerson(group, p.x, layout.spawnY ?? 0, p.z);
        const rank = crewRankIndex(xp);
        // Cap recolours by rank so a crew's level reads at a glance.
        let cap = null;
        try {
            const capColor = CREW_RANKS[rank].cap;
            const capMat = group.userData?.isWalkingFbxBuyer
                ? makeWalkingBuyerBlackMaterial()
                : new THREE.MeshStandardMaterial({ color: capColor, emissive: capColor, emissiveIntensity: 0.5 });
            cap = new THREE.Mesh(
                new THREE.BoxGeometry(0.4, 0.16, 0.4),
                capMat,
            );
            cap.position.set(0, 2.02, 0);
            group.add(cap);
        } catch (e) {}
        const now = performance.now?.() || Date.now();
        const member = {
            color, mesh: group, cap, isCrew: true,
            xp, rank,
            target: randomStreetPoint(layout),
            nextSaleAt: now + CREW_SELL_INTERVAL_MS * (0.5 + Math.random()),
            earned,
        };
        s.crew.push(member);
        return member;
    }
    // Repaint a crew member's cap to match their current rank colour.
    function recolorCrewCap(m) {
        if (!m.cap?.material) return;
        const c = CREW_RANKS[m.rank].cap;
        try {
            if (m.mesh?.userData?.isWalkingFbxBuyer) {
                m.cap.material.color.copy(WALKING_BUYER_BASE_TINT);
            } else {
                m.cap.material.color.setHex(c);
                m.cap.material.emissive.setHex(c);
            }
        } catch (e) {}
    }
    // Rebuild crew bodies from a save. Newer saves store {color,xp,earned};
    // older ones stored bare colour strings — handle both.
    function ensureCrewMeshes(s, layout) {
        if (!Array.isArray(s.pendingCrew) || !s.pendingCrew.length) return;
        const list = s.pendingCrew.slice(0, CREW_MAX);
        s.pendingCrew = null;
        for (const c of list) {
            if (typeof c === 'string') spawnCrewMember(s, layout, c);
            else spawnCrewMember(s, layout, c.color, c.xp || 0, c.earned || 0);
        }
    }
    // Can the player hire the buyer they're standing next to?
    function canHireBuyer(s, npc) {
        if (!npc || npc.isNarc) return false;
        if ((s.crew?.length || 0) >= CREW_MAX) return false;
        const tier = s.loyalty?.[npc.shirtColor]?.tier || 0;
        return tier >= CREW_HIRE_LOYALTY;
    }
    function hireBuyer(s, layout, npc) {
        if (s.cash < CREW_HIRE_COST || !canHireBuyer(s, npc)) return;
        s.cash -= CREW_HIRE_COST;
        const color = npc.shirtColor;
        // Remove the buyer from the live list (they join the payroll).
        try { core.scene?.remove(npc.mesh); } catch (e) {}
        const ix = s.npcs.indexOf(npc);
        if (ix >= 0) s.npcs.splice(ix, 1);
        if (s.orderColor === color) pickOrder(s);
        spawnCrewMember(s, layout, color);
        const wp = new THREE.Vector3(npc.mesh?.position.x || 0, 2.2, npc.mesh?.position.z || 0);
        floatText(`🤝 Hired ${colorName(color)} dealer`, wp, '#2ec27a');
        playSfx('cash', null, 0.5);
        updateHud();
        saveProgress();
    }
    // Crew roam + auto-sell your stash for cash (minus their wage cut). They
    // can occasionally get busted and vanish.
    function updateCrew(s, layout, dt) {
        if (!s.crew?.length) return;
        const now = performance.now?.() || Date.now();
        for (const m of [...s.crew]) {
            if (!m.mesh) continue;
            m.mesh.visible = true;   // visible on the street (hidden while indoors)
            if (moveToward(m.mesh, m.target, CREW_SPEED, dt, layout)) {
                m.target = randomStreetPoint(layout);
            }
            const rank = CREW_RANKS[m.rank || 0];
            if (now < m.nextSaleAt) continue;
            m.nextSaleAt = now + CREW_SELL_INTERVAL_MS * rank.intervalMult * (0.7 + Math.random() * 0.6);
            // Pick a product the player actually has in stock.
            const pk = unlockedProducts(s).find((k) => prodQty(s, k) > 0);
            if (!pk) continue;   // nothing to push
            const qty = Math.min(prodQty(s, pk), rank.qty);
            const q = prodQual(s, pk);
            takeProduct(s, pk, qty);
            const gross = Math.round(qty * unitPrice(s, q, false, pk));
            const cut = Math.round(gross * rank.wageCut);
            const net = gross - cut;
            s.cash += net;
            m.earned += net;
            s.heat = Math.min(160, s.heat + CREW_HEAT_PER_SALE);
            s.today.earned += net;
            s.today.units += qty;
            s.today.sales += 1;
            const wp = m.mesh.getWorldPosition(new THREE.Vector3()).setY(2.1);
            floatText(`+$${net}`, wp, '#9dffa0');
            playSfx('cash', wp.clone(), 0.3);
            // XP + rank-up: each sale earns 1 XP; promotion repaints the cap.
            m.xp = (m.xp || 0) + 1;
            const newRank = crewRankIndex(m.xp);
            if (newRank > (m.rank || 0)) {
                m.rank = newRank;
                recolorCrewCap(m);
                floatText(`⬆ ${colorName(m.color)} → ${CREW_RANKS[newRank].name}`, wp.clone().setY(2.6), CREW_RANKS[newRank].cap ? '#ffe066' : '#9dffa0');
                playSfx('cash', wp.clone(), 0.6);
            }
            // Heat-scaled bust risk, reduced by rank.
            const bustRisk = CREW_BUST_CHANCE * rank.bustMult * (1 + s.heat / 120);
            if (Math.random() < bustRisk) {
                try { core.scene?.remove(m.mesh); } catch (e) {}
                const ci = s.crew.indexOf(m);
                if (ci >= 0) s.crew.splice(ci, 1);
                s.today.busts += 1;
                floatText(`🚓 ${colorName(m.color)} dealer busted`, wp.clone().setY(2.4), '#ff7070');
                playSfx('hit', wp.clone());
            }
        }
        maybeAutosave();
    }

    function updateRivals(s, layout, playerPos, dt) {
        while (s.rivals.length < maxRivals(s)) spawnRivalDealer(s, layout);
        const now = performance.now?.() || Date.now();
        const security = s.baseUp?.security || 0;
        for (const rival of [...s.rivals]) {
            if (!rival.mesh) continue;

            // ---- armed rival: hunt the player and shoot ------------------
            if (rival.armed && playerPos) {
                const rm = rival.mesh;
                const pd = Math.hypot(rm.position.x - playerPos.x, rm.position.z - playerPos.z);
                // Close to firing range, then hold and shoot.
                if (pd > RIVAL_GUN_RANGE * 0.85) {
                    rival.target = { x: playerPos.x, y: rm.position.y, z: playerPos.z };
                    moveToward(rm, rival.target, RIVAL_CHASE_SPEED, dt, layout);
                } else {
                    rm.rotation.y = Math.atan2(playerPos.x - rm.position.x, playerPos.z - rm.position.z);
                    if (pd <= RIVAL_GUN_RANGE && pd > RIVAL_GUN_MIN_RANGE) {
                        rivalFireAt(s, rival, playerPos);
                    }
                }
                continue;   // armed rivals don't poach buyers
            }

            if (moveToward(rival.mesh, rival.target, RIVAL_SPEED, dt, layout)) {
                rival.target = randomStreetPoint(layout);
            }

            let buyer = null, buyerD = RIVAL_POACH_RADIUS;
            for (const n of s.npcs) {
                if (!n.mesh || !n.wantsBuy || n.isNarc) continue;
                const d = Math.hypot(n.mesh.position.x - rival.mesh.position.x, n.mesh.position.z - rival.mesh.position.z);
                if (d < buyerD) { buyerD = d; buyer = n; }
            }
            if (buyer && now >= (rival.nextPoachAt || 0)) {
                rival.nextPoachAt = now + RIVAL_EVENT_COOLDOWN_MS;
                try { core.scene?.remove(buyer.mesh); } catch (e) {}
                const idx = s.npcs.indexOf(buyer);
                if (idx >= 0) s.npcs.splice(idx, 1);
                s.demand = Math.max(MARKET_MIN, (s.demand || 1) - 0.04);
                floatText('Buyer poached', rival.mesh.position.clone().setY(2), '#ff8a8a');
                if (s.orderColor === buyer.shirtColor) pickOrder(s);
            }

            if (s.stash > 0 && playerPos && now >= (rival.nextMugAt || 0)) {
                const pd = Math.hypot(rival.mesh.position.x - playerPos.x, rival.mesh.position.z - playerPos.z);
                const risk = Math.max(0.15, 1 - security * 0.22);
                if (pd < RIVAL_MUG_RADIUS && Math.random() < risk) {
                    rival.nextMugAt = now + RIVAL_EVENT_COOLDOWN_MS;
                    const stolen = Math.min(s.stash, 1 + Math.floor(Math.random() * 2));
                    s.stash -= stolen;
                    if (s.stash <= 0) s.stashQ = 1;
                    s.heat = Math.min(160, s.heat + 4);
                    floatText(`Rival stole ${stolen}`, rival.mesh.position.clone().setY(2.2), '#ff7070');
                    saveProgress();
                }
            }
        }
    }

    // ---- day / night cycle ---------------------------------------------
    function isNight(s) {
        const t = s.timeOfDay;
        return t >= NIGHT_START || t < NIGHT_END;
    }
    // 0 = full day, 1 = full night, with smooth dusk/dawn ramps.
    function nightFactor(s) {
        const t = s.timeOfDay;
        // Short dusk ramp so it's clearly dark right after 21:00.
        const DUSK = 0.02, DAWN = 0.04;
        if (t >= NIGHT_START) {                 // dusk → midnight
            return Math.min(1, (t - NIGHT_START) / DUSK);
        }
        if (t < NIGHT_END) {                    // midnight → dawn
            return Math.min(1, 1 - (t / Math.max(DAWN, 1e-3)));
        }
        // Daytime, but ease the approach to dusk a touch before NIGHT_START.
        if (t > NIGHT_START - DUSK) return Math.max(0, (t - (NIGHT_START - DUSK)) / DUSK) * 0.0;
        return 0;
    }
    let _sunLight = null;
    let _dayAmbientLight = null;
    let _dayHemiLight = null;
    let _skyDome = null;
    let _outdoorPracticalLights = [];
    const _dayColor = new THREE.Color(0xfff0d0);
    const _nightColor = new THREE.Color(0x2a3a66);
    const _daySky = new THREE.Color(0x9ec4ff);
    const _nightSky = new THREE.Color(0x070b18);
    const _tmpColor = new THREE.Color();
    function findTycoonOutdoorLighting() {
        const { scene } = core;
        if (!scene) return null;
        const cacheWarm = (!_sunLight || _sunLight.parent)
            && (!_dayAmbientLight || _dayAmbientLight.parent)
            && (!_dayHemiLight || _dayHemiLight.parent)
            && (!_skyDome || _skyDome.parent)
            && _outdoorPracticalLights.every((light) => light?.parent);
        if (cacheWarm && (_sunLight || _dayAmbientLight || _dayHemiLight || _skyDome || _outdoorPracticalLights.length)) {
            return {
                sun: _sunLight,
                dayAmbient: _dayAmbientLight,
                dayHemi: _dayHemiLight,
                skyDome: _skyDome,
                practicalLights: _outdoorPracticalLights,
            };
        }
        _sunLight = null;
        _dayAmbientLight = null;
        _dayHemiLight = null;
        _skyDome = null;
        _outdoorPracticalLights = [];
        scene.traverse((o) => {
            if (!_sunLight && o.name === 'tycoon-sun') {
                _sunLight = o;
                return;
            }
            if (!_dayAmbientLight && o.name === 'tycoon-day-ambient') {
                _dayAmbientLight = o;
                return;
            }
            if (!_dayHemiLight && o.name === 'tycoon-day-hemi') {
                _dayHemiLight = o;
                return;
            }
            if (!_skyDome && o.name === 'tycoon-skybox') {
                _skyDome = o;
                return;
            }
            if (!o.isPointLight || typeof o.name !== 'string') return;
            const isPractical = o.name === 'weedshop-interior'
                || o.name === 'weedshop-spill'
                || o.name.startsWith('weedshop-sign-light-')
                || o.name.startsWith('tycoon-lamp-');
            if (!isPractical) return;
            if (!Number.isFinite(o.userData.tycoonBaseIntensity)) o.userData.tycoonBaseIntensity = o.intensity;
            _outdoorPracticalLights.push(o);
        });
        return {
            sun: _sunLight,
            dayAmbient: _dayAmbientLight,
            dayHemi: _dayHemiLight,
            skyDome: _skyDome,
            practicalLights: _outdoorPracticalLights,
        };
    }
    // Fresh per-day accumulator. repStart anchors the day's net rep change.
    function newDayStats(s) {
        return { earned: 0, spent: 0, units: 0, sales: 0, busts: 0, narcs: 0, repStart: s?.rep ?? REP_START, bestCombo: 1, bounties: 0 };
    }
    function advanceDayNight(s, dt) {
        const prev = s.timeOfDay;
        s.timeOfDay = (s.timeOfDay + dt / DAY_LENGTH_SEC) % 1;
        const wasNight = prev >= NIGHT_START || prev < NIGHT_END;
        const nowNight = isNight(s);
        // Count whole days for the market roll (clock wrapped past 1.0 → new day).
        s._daysElapsed = (s._daysElapsed ?? 0) + dt / DAY_LENGTH_SEC;
        if (s.timeOfDay < prev) {
            rollMarket(s, true);   // crossed midnight → new prices
            showDaySummary(s);     // recap the day that just ended, then reset
        }
        else if (s.marketDay < 0) rollMarket(s);       // first frame
        if (wasNight && !nowNight && s.heat > 0) {
            s.heat = 0;
            for (const cop of s.police) { try { core.scene?.remove(cop.mesh); } catch (e) {} }
            s.police.length = 0;
            for (const cop of s.patrol) { try { core.scene?.remove(cop.mesh); } catch (e) {} }
            s.patrol.length = 0;
            stopSiren();
            showPrompt('Morning reset: wanted cleared');
            saveProgress();
        }
        const n = nightFactor(s);
        const outdoorLighting = findTycoonOutdoorLighting();
        const sun = outdoorLighting?.sun || null;
        if (sun) {
            sun.intensity = 0.22 * (1 - n) + 0.04 * n;
            _tmpColor.copy(_dayColor).lerp(_nightColor, n);
            sun.color.copy(_tmpColor);
        }
        const { scene } = core;
        if (outdoorLighting?.dayAmbient) {
            outdoorLighting.dayAmbient.intensity = 0.12 * (1 - n) + 0.035 * n;
        }
        if (outdoorLighting?.dayHemi) {
            outdoorLighting.dayHemi.intensity = 0.08 * (1 - n) + 0.025 * n;
        }
        const practicalNight = THREE.MathUtils.smoothstep(n, 0.35, 1.0);
        for (const light of outdoorLighting?.practicalLights || []) {
            const baseIntensity = Number.isFinite(light?.userData?.tycoonBaseIntensity)
                ? light.userData.tycoonBaseIntensity
                : light.intensity;
            let dayScale = 0;
            if (light.name === 'weedshop-interior') dayScale = 0.05;
            else if (light.name.startsWith('weedshop-sign-light-')) dayScale = 0.03;
            else if (light.name === 'weedshop-spill') dayScale = 0.0;
            light.intensity = baseIntensity * THREE.MathUtils.lerp(dayScale, 1.0, practicalNight);
        }
        // If the level placed a procedural sky dome ("tycoon-skybox"), tint it
        // by the day→night factor and leave scene.background alone. Otherwise
        // fall back to the legacy solid-color background swap.
        const skyDome = outdoorLighting?.skyDome || null;
        if (skyDome?.material) {
            _tmpColor.copy(_daySky).lerp(_nightSky, n);
            skyDome.material.color.copy(_tmpColor);
            // Boost dome brightness slightly in daytime, dim at night.
            skyDome.material.opacity = 1.0;
        } else if (scene) {
            if (!scene.background || !scene.background.isColor) {
                scene.background = _daySky.clone();
            }
            _tmpColor.copy(_daySky).lerp(_nightSky, n);
            scene.background.copy(_tmpColor);
        }
        // Interior lights: cheap TWO-state day/night. Only walk the scene when
        // the night flag actually flips, not every frame.
        const night = isNight(s);
        if (night !== _roomNightState) {
            _roomNightState = night;
            applyRoomLighting(night);
        }
    }
    // Day = brighter/cooler grow-room fill; night = dimmer/warmer. Toggled only
    // on a day↔night transition (one traversal), so it's effectively free.
    let _roomNightState = null;
    function applyRoomLighting(night) {
        const { scene } = core;
        if (!scene) return;
        const intensity = night ? 3.0 : 6.0;
        scene.traverse((o) => {
            if (o.isPointLight && typeof o.name === 'string' && o.name.startsWith('grow-light')) {
                o.intensity = intensity;
                o.color.set(night ? 0xffcaa0 : 0xffe6b0);
            }
        });
    }
    function sleepInBed(s) {
        // Skip to morning: just after dawn so it's daytime + safe.
        s.timeOfDay = 0.04;
        s.heat = 0;
        for (const cop of s.police) { try { core.scene?.remove(cop.mesh); } catch (e) {} }
        s.police.length = 0;
        for (const cop of s.patrol) { try { core.scene?.remove(cop.mesh); } catch (e) {} }
        s.patrol.length = 0;
        stopSiren();
        floatText('💤 Slept until morning · wanted cleared', new THREE.Vector3(...(core.currentMesh?.userData?.drugTycoonLevel?.bed || [0, 1.5, 300])).setY(1.8), '#bfe6ff');
        // Force the room lights back to day immediately.
        _roomNightState = false;
        applyRoomLighting(false);
        // Sleeping skips the clock past midnight, so end the current day like a
        // natural rollover: advance the day counter, reroll the market, and pop
        // the end-of-day recap. (advanceDayNight's wrap check is bypassed by the
        // direct timeOfDay set above, so do it explicitly here.)
        s._daysElapsed = Math.floor(s._daysElapsed ?? 0) + 1 + s.timeOfDay;
        rollMarket(s, true);

        // ---- fresh-day situation reset --------------------------------
        // A new day = a new crowd and a new setup. Clear yesterday's street
        // buyers + rivals (the per-frame spawners refill them under the new
        // market/rep), wipe active random events, drop the sale combo, and roll
        // a fresh order + a new big-order contract.
        const { scene } = core;
        for (const n of s.npcs || []) { try { scene?.remove(n.mesh); } catch (e) {} }
        s.npcs.length = 0;
        for (const r of s.rivals || []) { try { scene?.remove(r.mesh); } catch (e) {} }
        s.rivals.length = 0;
        s.events = {};
        scheduleNextEvent(s);
        s.combo = 0; s.comboUntil = 0;
        s.orderColor = '';            // ensureOrder() repicks against the new crowd
        s.bounty = null;
        scheduleNextBounty(s);
        rollBounty(s);                // surface a new contract for the day

        showDaySummary(s);
        saveProgress();
    }
    function dayClock(s) {
        // Map timeOfDay (0..1) to a 24h clock starting at ~06:00 sunrise.
        const hours = (s.timeOfDay * 24 + 6) % 24;
        const h = Math.floor(hours);
        const m = Math.floor((hours - h) * 60);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    // ---- end-of-day summary --------------------------------------------
    // Fired from advanceDayNight when the clock wraps past midnight. Snapshots
    // the day's accumulators into a modal recap, then rolls the counters over
    // for the new day. Pauses the sim like the shop while it's up.
    let _summaryEl = null;
    function showDaySummary(s) {
        const { currentMesh } = core;
        const inLevel = currentMesh?.userData?.sampleType === 'drugTycoon' && gameplay.active;
        // Always roll the day counter + reset accumulators; only show the panel
        // when actually playing the level (skip on first-frame / menus).
        const stats = s.today || newDayStats(s);
        const closedDay = s.dayNum || 1;
        const repNet = Math.round((s.rep ?? REP_START) - (stats.repStart ?? REP_START));
        // Fold the finished day into the lifetime running totals BEFORE rolling
        // over, so the "show total" view includes the day you just played.
        s.life ||= { earned: 0, spent: 0, units: 0, sales: 0, busts: 0, narcs: 0, bounties: 0, bestCombo: 1, days: 0 };
        const L = s.life;
        L.earned += stats.earned; L.spent += stats.spent; L.units += stats.units;
        L.sales += stats.sales; L.busts += stats.busts; L.narcs += stats.narcs;
        L.bounties += stats.bounties; L.days += 1;
        if (stats.bestCombo > L.bestCombo) L.bestCombo = stats.bestCombo;
        // Roll over to the new day + reset the daily accumulators.
        s.dayNum = closedDay + 1;
        s.today = newDayStats(s);
        if (!inLevel) return;

        s.summaryOpen = true;
        gameplay.roguePaused = true;
        try { document.exitPointerLock?.(); } catch (e) {}
        try { playSfx('win'); } catch (e) {}

        if (_summaryEl?.parentNode) _summaryEl.remove();
        const m = isMobileUi();
        const overlay = document.createElement('div');
        overlay.className = 'tycoon-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:1250;pointer-events:auto;'
            + 'background:rgba(4,10,8,0.86);backdrop-filter:blur(3px);display:flex;'
            + 'flex-direction:column;align-items:center;justify-content:center;'
            + `padding:${m ? '10px' : '0'};box-sizing:border-box;`
            + 'font-family:"Trebuchet MS",system-ui,sans-serif;color:#eaffea;';

        const title = document.createElement('div');
        title.style.cssText = `font:900 ${m ? 22 : 36}px/1.1 inherit;margin-bottom:${m ? 4 : 8}px;color:#9dffa0;`
            + 'text-shadow:0 0 20px rgba(60,255,120,0.55);';
        overlay.appendChild(title);

        const sub = document.createElement('div');
        sub.textContent = `Cash on hand: $${Math.floor(s.cash).toLocaleString()}`;
        sub.style.cssText = `font:700 ${m ? 14 : 18}px/1 inherit;opacity:.85;margin-bottom:${m ? 12 : 22}px;`;
        overlay.appendChild(sub);

        // Net profit, big and color-coded.
        const netEl = document.createElement('div');
        netEl.style.cssText = `font:900 ${m ? 28 : 46}px/1 inherit;margin-bottom:${m ? 14 : 24}px;`;
        overlay.appendChild(netEl);

        const card = document.createElement('div');
        card.style.cssText = `display:flex;flex-direction:column;gap:${m ? 5 : 9}px;`
            + `background:linear-gradient(160deg,rgba(18,48,28,0.95),rgba(8,24,14,0.95));`
            + `border:2px solid rgba(120,255,160,0.4);border-radius:14px;`
            + `padding:${m ? '12px 16px' : '20px 30px'};min-width:${m ? '78vw' : '380px'};`
            + 'box-shadow:0 10px 40px rgba(0,0,0,0.6);';
        overlay.appendChild(card);

        // Build the row set for either the day or the lifetime totals. The
        // lifetime view drops the rep-delta row (rep is a level, not a sum) and
        // adds a days-played row instead.
        function rowsFor(mode) {
            const d = mode === 'life' ? L : stats;
            const r = [
                ['💵 Earned', `$${Math.round(d.earned).toLocaleString()}`, '#9dffa0'],
                ['🔻 Lost to busts/bribes', `$${Math.round(d.spent).toLocaleString()}`, d.spent > 0 ? '#ff8a8a' : '#cdd6e3'],
                ['🤝 Deals', `${d.sales}`, '#cfe8ff'],
                ['📦 Units moved', `${Math.round(d.units)}`, '#cfe8ff'],
                ['🔥 Best combo', `x${d.bestCombo.toFixed(2).replace(/0$/, '')}`, d.bestCombo > 1 ? '#7fd0ff' : '#cdd6e3'],
                ['📋 Contracts filled', `${d.bounties}`, d.bounties > 0 ? '#ffe066' : '#cdd6e3'],
                ['🚔 Busted', `${d.busts}`, d.busts > 0 ? '#ff7070' : '#cdd6e3'],
                ['🚨 Narc stings', `${d.narcs}`, d.narcs > 0 ? '#ff7070' : '#cdd6e3'],
            ];
            if (mode === 'life') {
                r.push(['📅 Days in business', `${d.days}`, '#cfe8ff']);
            } else {
                r.push(['⭐ Reputation', `${repNet >= 0 ? '+' : ''}${repNet} (${Math.round(s.rep ?? REP_START)})`, repNet >= 0 ? '#9dffa0' : '#ff8a8a']);
            }
            return r;
        }

        // Toggle button flips the panel between this day and all-time totals.
        const toggle = document.createElement('button');
        toggle.style.cssText = `margin-top:${m ? 12 : 18}px;padding:${m ? '8px 18px' : '10px 24px'};cursor:pointer;`
            + `font:800 ${m ? 12 : 15}px/1 inherit;color:#dff7e6;border-radius:10px;`
            + 'background:linear-gradient(160deg,rgba(28,64,40,0.95),rgba(12,32,20,0.95));'
            + 'border:2px solid rgba(120,255,160,0.45);';
        overlay.appendChild(toggle);

        let mode = 'day';
        function render() {
            const d = mode === 'life' ? L : stats;
            const net = Math.round(d.earned - d.spent);
            title.textContent = mode === 'life' ? '📊 ALL-TIME TOTALS' : `☀️ DAY ${closedDay} REPORT`;
            netEl.textContent = `${net >= 0 ? '+' : '−'}$${Math.abs(net).toLocaleString()} net`;
            netEl.style.color = net >= 0 ? '#9dffa0' : '#ff7070';
            netEl.style.textShadow = `0 0 18px ${net >= 0 ? 'rgba(60,255,120,0.5)' : 'rgba(255,80,80,0.5)'}`;
            card.innerHTML = '';
            rowsFor(mode).forEach(([label, val, color]) => {
                const r = document.createElement('div');
                r.style.cssText = `display:flex;justify-content:space-between;gap:24px;font:700 ${m ? 13 : 17}px/1.4 inherit;`;
                r.innerHTML = `<span style="opacity:.9;">${label}</span><span style="color:${color};font-weight:800;">${val}</span>`;
                card.appendChild(r);
            });
            toggle.textContent = mode === 'life' ? '◀ TODAY' : '📊 SHOW ALL-TIME TOTAL';
        }
        toggle.onclick = () => { mode = mode === 'life' ? 'day' : 'life'; render(); };
        render();

        const cont = document.createElement('button');
        cont.textContent = m ? 'NEXT DAY ▶' : 'START DAY ' + (closedDay + 1) + ' ▶';
        cont.style.cssText = `margin-top:${m ? 12 : 18}px;padding:${m ? '10px 26px' : '14px 38px'};cursor:pointer;`
            + `font:800 ${m ? 14 : 20}px/1 inherit;color:#fff;border-radius:12px;`
            + 'background:linear-gradient(160deg,#1f7a3a,#0e3a1d);'
            + 'border:2px solid rgba(120,255,160,0.55);box-shadow:0 8px 30px rgba(0,0,0,0.5);';
        cont.onclick = () => closeDaySummary();
        overlay.appendChild(cont);

        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        _summaryEl = overlay;
        saveProgress();
    }
    function closeDaySummary() {
        const s = window.drugTycoon;
        if (_summaryEl?.parentNode) _summaryEl.remove();
        _summaryEl = null;
        if (s) s.summaryOpen = false;
        gameplay.roguePaused = false;
        const { renderer } = core;
        if (renderer?.domElement && !window.matchMedia?.('(pointer:coarse)')?.matches) {
            const resume = () => {
                renderer.domElement.removeEventListener('click', resume);
                try { renderer.domElement.requestPointerLock?.(); } catch (e) {}
            };
            renderer.domElement.addEventListener('click', resume);
        }
    }

    // ---- shared WebAudio context ---------------------------------------
    // One AudioContext for the siren + all SFX. Lazily created (needs a user
    // gesture — the pointer-lock click satisfies it).
    let _audioCtx = null;
    function audioCtx() {
        if (_audioCtx) return _audioCtx;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        try { _audioCtx = new Ctx(); } catch (e) { _audioCtx = null; }
        return _audioCtx;
    }

    // One-shot synthesized SFX, optionally positional (panned from worldPos).
    //   'shot'    — short percussive gunshot (noise burst + low thump)
    //   'hit'     — quick body-hit thud
    //   'cash'    — two-note "cha-ching" sale chime
    function playSfx(type, worldPos = null, vol = 1) {
        const ctx = audioCtx();
        if (!ctx) return;
        if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
        const now = ctx.currentTime;

        // Output node: a panner if positional, else straight to destination.
        let out = ctx.destination;
        let panner = null;
        if (worldPos) {
            panner = ctx.createPanner();
            panner.panningModel = 'HRTF';
            panner.distanceModel = 'inverse';
            panner.refDistance = 3;
            panner.maxDistance = 40;
            panner.rolloffFactor = 1.2;
            setPannerPos(panner, ctx, worldPos.x, (worldPos.y || 0), worldPos.z);
            panner.connect(ctx.destination);
            out = panner;
            syncListener(ctx);
        }

        if (type === 'cash') {
            // Two bright notes (C6 → E6) = "cha-ching".
            [[1047, 0], [1319, 0.09]].forEach(([f, t0]) => {
                const o = ctx.createOscillator();
                o.type = 'triangle';
                o.frequency.value = f;
                const g = ctx.createGain();
                const t = now + t0;
                g.gain.setValueAtTime(0, t);
                g.gain.linearRampToValueAtTime(0.22 * vol, t + 0.01);
                g.gain.exponentialRampToValueAtTime(0.0008, t + 0.22);
                o.connect(g).connect(out);
                o.start(t); o.stop(t + 0.24);
            });
            return;
        }

        if (type === 'win' || type === 'ding') {
            // Short rising arpeggio fanfare. 'win' is a fuller 4-note flourish
            // (end-of-day); 'ding' is a quick 2-note chime (achievement pop).
            const notes = type === 'win'
                ? [[784, 0], [988, 0.10], [1175, 0.20], [1568, 0.32]]   // G5 B5 D6 G6
                : [[1319, 0], [1976, 0.08]];                            // E6 B6
            notes.forEach(([f, t0]) => {
                const o = ctx.createOscillator();
                o.type = 'triangle';
                o.frequency.value = f;
                const g = ctx.createGain();
                const t = now + t0;
                g.gain.setValueAtTime(0, t);
                g.gain.linearRampToValueAtTime(0.2 * vol, t + 0.012);
                g.gain.exponentialRampToValueAtTime(0.0008, t + 0.26);
                o.connect(g).connect(out);
                o.start(t); o.stop(t + 0.28);
            });
            return;
        }

        if (type === 'tazer') {
            // Electric crackle: a buzzy square tone gated by a fast tremolo.
            const o = ctx.createOscillator();
            o.type = 'square';
            o.frequency.setValueAtTime(90, now);
            o.frequency.linearRampToValueAtTime(140, now + 0.18);
            const trem = ctx.createOscillator();
            trem.type = 'square';
            trem.frequency.value = 55;            // fast on/off = crackle
            const tremGain = ctx.createGain();
            tremGain.gain.value = 0.5;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0, now);
            g.gain.linearRampToValueAtTime(0.18 * vol, now + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0008, now + 0.2);
            trem.connect(tremGain).connect(g.gain);
            o.connect(g).connect(out);
            o.start(now); o.stop(now + 0.22);
            trem.start(now); trem.stop(now + 0.22);
            return;
        }

        // Noise burst (shared by 'shot' and 'hit').
        const dur = type === 'shot' ? 0.16 : 0.10;
        const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            data[i] = (Math.random() * 2 - 1) * (1 - i / data.length); // decaying noise
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = type === 'shot' ? 2200 : 1400;
        const g = ctx.createGain();
        const peak = (type === 'shot' ? 0.5 : 0.3) * vol;
        g.gain.setValueAtTime(peak, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + dur);
        src.connect(lp).connect(g).connect(out);
        src.start(now);

        if (type === 'shot') {
            // Low thump under the crack for body.
            const o = ctx.createOscillator();
            o.type = 'sine';
            o.frequency.setValueAtTime(160, now);
            o.frequency.exponentialRampToValueAtTime(50, now + 0.12);
            const og = ctx.createGain();
            og.gain.setValueAtTime(0.4 * vol, now);
            og.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
            o.connect(og).connect(out);
            o.start(now); o.stop(now + 0.14);
        }
    }

    // ---- police siren (synthesized, 3D positional) ---------------------
    // A two-tone wail (oscillator pitch swung by a slow LFO) routed through a
    // PannerNode so it's spatialised: the sound comes from the nearest cop's
    // position relative to the camera, with WebAudio doing the distance falloff
    // and left/right panning. The AudioListener tracks the camera each frame.
    // Lazily created (AudioContext needs a user gesture — pointer-lock click).
    let _siren = null;
    function ensureSiren() {
        if (_siren) return _siren;
        const ctx = audioCtx();
        if (!ctx) return null;
        try {
            const osc = ctx.createOscillator();
            osc.type = 'sine';               // smooth tone — no sawtooth buzz
            osc.frequency.value = 520;       // lower, softer base pitch
            // LFO swings the pitch — slow + narrow for a gentle wail.
            const lfo = ctx.createOscillator();
            lfo.type = 'sine';
            lfo.frequency.value = 0.3;       // slower swing
            const lfoGain = ctx.createGain();
            lfoGain.gain.value = 120;        // ± Hz swing (narrower)
            lfo.connect(lfoGain).connect(osc.frequency);
            // Low-pass to take any edge off the top end.
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = 900;
            const gain = ctx.createGain();
            gain.gain.value = 0;             // master on/off (smooth ramp)
            // Spatial panner: inverse distance falloff out to SIREN_RANGE.
            const panner = ctx.createPanner();
            panner.panningModel = 'HRTF';
            panner.distanceModel = 'inverse';
            panner.refDistance = 2;
            panner.maxDistance = SIREN_RANGE;
            panner.rolloffFactor = 1.4;
            osc.connect(lp).connect(gain).connect(panner).connect(ctx.destination);
            osc.start();
            lfo.start();
            _siren = { ctx, osc, gain, lfo, panner };
        } catch (e) { _siren = null; }
        return _siren;
    }
    function setPannerPos(panner, ctx, x, y, z) {
        if (panner.positionX) {              // modern AudioParam API
            const t = ctx.currentTime;
            panner.positionX.setTargetAtTime(x, t, 0.02);
            panner.positionY.setTargetAtTime(y, t, 0.02);
            panner.positionZ.setTargetAtTime(z, t, 0.02);
        } else if (panner.setPosition) {     // legacy
            panner.setPosition(x, y, z);
        }
    }
    function syncListener(ctx) {
        const { camera } = core;
        if (!camera) return;
        const l = ctx.listener;
        camera.getWorldPosition(_camPos);
        camera.getWorldDirection(_camDir);
        if (l.positionX) {
            const t = ctx.currentTime;
            l.positionX.setTargetAtTime(_camPos.x, t, 0.02);
            l.positionY.setTargetAtTime(_camPos.y, t, 0.02);
            l.positionZ.setTargetAtTime(_camPos.z, t, 0.02);
            if (l.forwardX) {
                l.forwardX.setTargetAtTime(_camDir.x, t, 0.02);
                l.forwardY.setTargetAtTime(_camDir.y, t, 0.02);
                l.forwardZ.setTargetAtTime(_camDir.z, t, 0.02);
                l.upX.setTargetAtTime(0, t, 0.02);
                l.upY.setTargetAtTime(1, t, 0.02);
                l.upZ.setTargetAtTime(0, t, 0.02);
            }
        } else if (l.setPosition) {          // legacy
            l.setPosition(_camPos.x, _camPos.y, _camPos.z);
            l.setOrientation(_camDir.x, _camDir.y, _camDir.z, 0, 1, 0);
        }
    }
    function updateSiren(s, playerPos) {
        if (!playerPos) return;
        // Find the nearest cop (heat police + night patrol) — it carries the siren.
        let nearest = Infinity, nearestCop = null;
        for (const c of [...s.police, ...s.patrol]) {
            if (!c.mesh) continue;
            const d = Math.hypot(c.mesh.position.x - playerPos.x, c.mesh.position.z - playerPos.z);
            if (d < nearest) { nearest = d; nearestCop = c; }
        }
        const audible = nearestCop && nearest < SIREN_RANGE;
        if (!audible && !_siren) return;     // don't spin up audio for silence
        const siren = ensureSiren();
        if (!siren) return;
        if (siren.ctx.state === 'suspended') { try { siren.ctx.resume(); } catch (e) {} }
        syncListener(siren.ctx);
        if (audible) {
            const m = nearestCop.mesh.position;
            setPannerPos(siren.panner, siren.ctx, m.x, (m.y || 0) + 1.4, m.z);
        }
        // Master gain just gates on/off; the panner handles distance loudness.
        const now = siren.ctx.currentTime;
        siren.gain.gain.cancelScheduledValues(now);
        siren.gain.gain.linearRampToValueAtTime(audible ? SIREN_MAX_GAIN : 0, now + 0.12);
    }
    function stopSiren() {
        if (_siren) { try { _siren.gain.gain.value = 0; } catch (e) {} }
    }
    function destroySiren() {
        // Stop the siren oscillators but DON'T close the shared AudioContext —
        // SFX still use it. Closing happens in destroyAudio().
        if (_siren) {
            try { _siren.osc.stop(); _siren.lfo.stop(); } catch (e) {}
            _siren = null;
        }
    }
    function destroyAudio() {
        destroySiren();
        if (_audioCtx) { try { _audioCtx.close(); } catch (e) {} _audioCtx = null; }
    }

    // ---- night patrol cops ---------------------------------------------
    function spawnPatrolCop(s, layout) {
        const cop = spawnPolice(s, layout);   // reuse police look + placement
        // Pull it OUT of the heat-police list; patrol is managed separately.
        const i = s.police.indexOf(cop);
        if (i >= 0) s.police.splice(i, 1);
        cop.target = randomStreetPoint(layout);
        cop.alerted = false;
        s.patrol.push(cop);
        return cop;
    }
    function clearPatrol(s) {
        const { scene } = core;
        for (const c of s.patrol) { try { scene?.remove(c.mesh); } catch (e) {} }
        s.patrol.length = 0;
    }
    function updatePatrol(s, layout, playerPos, dt) {
        const night = isNight(s);
        if (night) {
            while (s.patrol.length < PATROL_COP_COUNT) spawnPatrolCop(s, layout);
        } else if (s.patrol.length) {
            clearPatrol(s);                    // dawn: patrol goes off shift
            return;
        }
        if (!playerPos) return;
        const playerVec = _tmpProj.set(playerPos.x, layout.spawnY ?? 0, playerPos.z);
        for (const cop of s.patrol) {
            if (!cop.mesh) continue;
            const cd = Math.hypot(cop.mesh.position.x - playerPos.x, cop.mesh.position.z - playerPos.z);
            // Spot the player nearby (or any time heat is already high) → chase.
            if (cd < PATROL_SPOT_RADIUS || wantedStars(s) >= 1) cop.alerted = true;
            if (cop.alerted) {
                const weapon = copWeaponForStars(wantedStars(s));
                const wpnRange = weapon === 'gun' ? COP_GUN_RANGE : weapon === 'tazer' ? COP_TAZER_RANGE : 0;
                if (weapon && cd <= wpnRange && cd > COP_FIRE_MIN_RANGE) {
                    cop.mesh.rotation.y = Math.atan2(playerPos.x - cop.mesh.position.x, playerPos.z - cop.mesh.position.z);
                    animateWalk(cop.mesh, 0, dt);
                    copFireAt(s, cop, weapon, playerPos);
                } else {
                    moveToward(cop.mesh, playerVec, POLICE_SPEED, dt, layout);
                }
                if (cd < BUST_RADIUS) bustPlayer(s, cop);
            } else {
                if (moveToward(cop.mesh, cop.target, PATROL_SPEED, dt, layout)) {
                    cop.target = randomStreetPoint(layout);
                }
            }
        }
    }

    // ---- gun: pickup mesh, held mesh, shooting --------------------------
    function makeGunMesh(scale = 1) {
        // Simple low-poly pistol from two boxes (slide + grip).
        const g = new THREE.Group();
        const bodyMat = new THREE.MeshStandardMaterial({ color: '#2b2b30', roughness: 0.5, metalness: 0.7 });
        const slide = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.12, 0.42), bodyMat);
        slide.position.set(0, 0.04, -0.05);
        const grip = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.26, 0.14), bodyMat.clone());
        grip.position.set(0, -0.14, 0.12);
        grip.rotation.x = 0.28;
        g.add(slide); g.add(grip);
        g.scale.setScalar(scale);
        g.traverse((m) => { if (m.isMesh) { m.castShadow = true; } });
        return g;
    }

    function spawnGunPickup(s, layout) {
        const { scene } = core;
        if (s.gunPickupMesh || !Array.isArray(layout.gunPickup)) return;
        const m = makeGunMesh(1.4);
        m.position.set(...layout.gunPickup);
        scene?.add(m);
        s.gunPickupMesh = m;
    }

    // ---- car spawning ---------------------------------------------------
    // Reusable: spawn a drivable car at ANY world position. Uses the engine's
    // vehicle system (real physics, standard enter/exit controls), then
    // teleports it to `pos`, zeroes the launch velocity the engine applies, and
    // tints the body to an ambient-traffic colour so it matches the street cars.
    // Returns the spawned vehicle actor (or null).
    //   spawnCarAt([x, y, z])
    //   spawnCarAt(new THREE.Vector3(...), { tone: '#c43b3b' })
    const CAR_BODY_TONES = ['#c43b3b', '#3b6fc4', '#d6c24a', '#e8e8e8', '#2e2e34', '#3b9e6a'];
    const _carRegistry = [];   // every car spawned this run, for cleanup
    function spawnCarAt(pos, opts = {}) {
        if (!spawnDrivableCar) { console.warn('[drugTycoon] no spawnDrivableCar dep'); return null; }
        const p = Array.isArray(pos)
            ? { x: pos[0] || 0, y: pos[1] || 0, z: pos[2] || 0 }
            : { x: pos?.x || 0, y: pos?.y || 0, z: pos?.z || 0 };
        const car = spawnDrivableCar({ userData: { label: opts.label || 'Car' } });
        if (!car) { console.warn('[drugTycoon] spawnDrivableCar returned null'); return null; }
        if (car.userData) car.userData.noTracks = true;   // no skid marks for tycoon cars
        // Teleport to the requested spot (mesh + Jolt body), then KILL the
        // forward launch impulse the engine applies to fresh props, or the car
        // shoots off the instant it appears.
        try { setActorWorldPositionExact?.(car, [p.x, p.y, p.z]); } catch (e) { console.warn('[drugTycoon] car teleport threw', e); }
        try {
            const body = getActorBody?.(car);
            if (body && physics?.Jolt && physics?.bodyInterface) {
                const { Jolt, bodyInterface } = physics;
                const zero = new Jolt.Vec3(0, 0, 0);
                bodyInterface.SetLinearVelocity(body.GetID(), zero);
                bodyInterface.SetAngularVelocity(body.GetID(), zero);
                Jolt.destroy(zero);
            }
        } catch (e) { console.warn('[drugTycoon] car zero-velocity threw', e); }
        // Re-skin to match the ambient street cars (the black-square artefact
        // was the skid-mark FX material, not this overlay — now fixed). Hide the
        // engine's default car visual and parent in the shared traffic-car mesh.
        // The engine chassis' visualGroup faces -Z, so the +Z traffic mesh gets
        // a PI yaw to drive the right way; dropped so its wheels meet the ground.
        try {
            const chassis = getActorRenderObject?.(car);
            const tone = opts.tone || CAR_BODY_TONES[(Math.random() * CAR_BODY_TONES.length) | 0];
            if (chassis) {
                chassis.traverse((o) => { if (o.isMesh) o.visible = false; });
                const skin = buildTrafficCarMesh(tone);
                skin.rotation.y = Math.PI;
                skin.position.y = -0.35;
                skin.userData._trafficSkin = true;
                chassis.add(skin);
            }
        } catch (e) {}
        _carRegistry.push(car);
        return car;
    }

    // Spawn a car in the MIDDLE of the chunk the given point sits in, dropped in
    // from above the ground so it falls and settles onto the road. CHUNK matches
    // the map-streaming grid (80). Defaults to the player's current chunk.
    const CHUNK_SIZE = 80;
    function spawnCarInChunkCenter(atPos, opts = {}) {
        const base = atPos || core.camera?.position || { x: 0, z: 0 };
        const cx = Math.round((base.x || 0) / CHUNK_SIZE) * CHUNK_SIZE;
        const cz = Math.round((base.z || 0) / CHUNK_SIZE) * CHUNK_SIZE;
        const dropY = opts.dropHeight ?? 4;   // metres above ground, lets it fall in
        return spawnCarAt([cx, dropY, cz], opts);
    }
    // Expose the spawn API for scripting / debugging.
    if (typeof window !== 'undefined') {
        window.drugTycoonSpawnCar = spawnCarAt;
        window.drugTycoonSpawnCarInChunk = spawnCarInChunkCenter;
    }

    // The player's car: parked behind the home house once BOUGHT. Spawned once.
    // Owning it also unlocks the long-distance delivery contracts.
    function ensurePlayerCar(s, layout) {
        if (!s.hasCar || s._carActor) return;
        const pos = Array.isArray(layout.carSpawn) ? layout.carSpawn : [0, 1.5, 0];
        const car = spawnCarAt(pos, { label: 'Car' });
        if (car) { s._carActor = car; window._tycoonCar = car; }
    }
    // Buy + park the car (called from the upgrade shop). Idempotent.
    function buyCar(s, layout) {
        if (s.hasCar || s.cash < CAR_PRICE) return;
        s.cash -= CAR_PRICE;
        s.hasCar = true;
        ensurePlayerCar(s, layout || core.currentMesh?.userData?.drugTycoonLevel || {});
        floatText('🚗 Car bought — deliveries unlocked', s.upgradePos || new THREE.Vector3(), '#9dffa0');
        playSfx('cash', null, 0.6);
        saveProgress();
    }

    let _heldGun = null;
    function attachHeldGun() {
        const { camera } = core;
        if (!camera || _heldGun) return;
        _heldGun = makeGunMesh(1.0);
        // Bottom-right of the view, pointing forward.
        _heldGun.position.set(0.28, -0.26, -0.6);
        _heldGun.rotation.set(0, Math.PI, 0);
        camera.add(_heldGun);
    }
    function detachHeldGun() {
        if (_heldGun?.parent) _heldGun.parent.remove(_heldGun);
        _heldGun = null;
        if (_muzzleFlash) { try { _muzzleFlash.parent?.remove(_muzzleFlash); } catch (e) {} _muzzleFlash = null; }
    }

    // Muzzle tracer: a quick fading line from the gun to the hit point.
    const _tracers = [];
    function spawnTracer(from, to, color = 0xfff3a0) {
        const { scene } = core;
        if (!scene) return;
        const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
        const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
        const line = new THREE.Line(geo, mat);
        line.renderOrder = 9;
        scene.add(line);
        _tracers.push({ line, born: performance.now?.() || Date.now() });
    }
    function updateTracers() {
        const { scene } = core;
        const now = performance.now?.() || Date.now();
        for (let i = _tracers.length - 1; i >= 0; i--) {
            const t = _tracers[i];
            const age = now - t.born;
            if (age > 90) {
                try { scene?.remove(t.line); t.line.geometry.dispose(); t.line.material.dispose(); } catch (e) {}
                _tracers.splice(i, 1);
            } else {
                t.line.material.opacity = 0.9 * (1 - age / 90);
            }
        }
    }

    // Brief muzzle flash: a glowing sprite + point light at the gun muzzle,
    // parented to the camera so it sits at the barrel. Auto-removed after ~70ms.
    let _muzzleFlash = null;
    function makeFlashTexture() {
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const g = c.getContext('2d');
        const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, 'rgba(255,250,210,1)');
        grad.addColorStop(0.4, 'rgba(255,200,90,0.8)');
        grad.addColorStop(1, 'rgba(255,140,30,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 64, 64);
        const tex = new THREE.CanvasTexture(c);
        return tex;
    }
    let _flashTex = null;
    function muzzleFlash() {
        const { camera } = core;
        if (!camera) return;
        if (!_flashTex) _flashTex = makeFlashTexture();
        // Remove any lingering flash first.
        if (_muzzleFlash) { try { _muzzleFlash.parent?.remove(_muzzleFlash); } catch (e) {} _muzzleFlash = null; }
        const grp = new THREE.Group();
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({
            map: _flashTex, transparent: true, depthTest: false, depthWrite: false,
            blending: THREE.AdditiveBlending, toneMapped: false,
        }));
        spr.scale.setScalar(0.5 + Math.random() * 0.2);
        spr.material.rotation = Math.random() * Math.PI;
        grp.add(spr);
        const light = new THREE.PointLight(0xffd27a, 6, 7, 2);
        grp.add(light);
        // At the held gun's muzzle (bottom-right, slightly forward).
        grp.position.set(0.3, -0.24, -0.95);
        grp.renderOrder = 11;
        camera.add(grp);
        _muzzleFlash = grp;
        const born = performance.now?.() || Date.now();
        grp.userData.born = born;
    }
    function updateMuzzleFlash() {
        if (!_muzzleFlash) return;
        const now = performance.now?.() || Date.now();
        const age = now - (_muzzleFlash.userData.born || 0);
        if (age > 70) {
            try { _muzzleFlash.parent?.remove(_muzzleFlash); } catch (e) {}
            _muzzleFlash = null;
        }
    }

    const _camPos = new THREE.Vector3();
    const _camDir = new THREE.Vector3();
    const _toNpc = new THREE.Vector3();
    function tryShoot(s, layout) {
        const { camera } = core;
        if (!camera) return;
        const now = performance.now?.() || Date.now();
        if (now < s.nextShotAt) return;
        s.nextShotAt = now + GUN_FIRE_COOLDOWN_MS;
        camera.getWorldPosition(_camPos);
        camera.getWorldDirection(_camDir).normalize();
        // Out of ammo: dry click, no shot.
        if (s.ammo <= 0) {
            playSfx('hit', null, 0.3);   // soft click
            floatText('*click* — out of ammo', _camPos.clone().addScaledVector(_camDir, 1.5), '#ff9a9a');
            return;
        }
        s.ammo -= 1;

        // Aim-cone hit test against living people (buyers + police + night
        // patrol). Pick the closest target inside the cone and within range.
        const targets = s.npcs.concat(s.rivals, s.police, s.patrol);
        let best = null, bestDist = GUN_RANGE;
        for (const t of targets) {
            if (!t.mesh) continue;
            // Aim at chest height (group origin is at feet).
            _toNpc.copy(t.mesh.position); _toNpc.y += 1.25; _toNpc.sub(_camPos);
            const dist = _toNpc.length();
            if (dist < 0.001 || dist > GUN_RANGE) continue;
            _toNpc.multiplyScalar(1 / dist);
            const dot = _toNpc.dot(_camDir);
            if (dot < GUN_AIM_DOT) continue;
            if (dist < bestDist) { bestDist = dist; best = t; }
        }

        // Tracer to target (or into the distance on a miss).
        const end = best
            ? _camPos.clone().add(_camDir.clone().multiplyScalar(bestDist))
            : _camPos.clone().add(_camDir.clone().multiplyScalar(GUN_RANGE));
        const muzzle = _camPos.clone().add(_camDir.clone().multiplyScalar(0.6)).add(new THREE.Vector3(0, -0.2, 0));
        spawnTracer(muzzle, end);
        muzzleFlash();
        playSfx('shot', muzzle);

        // Tiny camera kick.
        if (gameplay.hitFeedback) gameplay.hitFeedback.shake = Math.max(gameplay.hitFeedback.shake || 0, 0.35);

        if (best) {
            // Ragdoll it, shoved along the shot direction.
            const dir = _camDir.clone();
            ragdoll.ragdollify(best.mesh, { x: dir.x * GUN_IMPULSE, y: 3.5, z: dir.z * GUN_IMPULSE });
            playSfx('hit', end);
            floatText('DOWN', end.clone().setY(end.y + 0.4), '#ff7070');
            // Remove from the live list it belonged to.
            const wasArmed = !!best.armed;
            const kind = removeLivePerson(s, best);
            if (kind === 'rival') {
                s.heat = Math.min(160, s.heat + 12);
                if (wasArmed) {
                    s.cash += RIVAL_KILL_BOUNTY;
                    floatText(`Armed rival dropped +$${RIVAL_KILL_BOUNTY}`, end.clone().setY(end.y + 0.8), '#9dffa0');
                } else {
                    floatText('Rival dropped', end.clone().setY(end.y + 0.8), '#ffd24a');
                }
            }
        }
    }

    // Baseball bat: short-range melee swing. Knocks down the nearest person in
    // a wide cone within BAT_RANGE. No ammo, slower cadence than the pistol.
    function trySwingBat(s, layout) {
        const { camera } = core;
        if (!camera) return;
        const now = performance.now?.() || Date.now();
        if (now < s.nextSwingAt) return;
        s.nextSwingAt = now + BAT_COOLDOWN_MS;
        camera.getWorldPosition(_camPos);
        camera.getWorldDirection(_camDir).normalize();
        playSfx('shot', _camPos.clone().addScaledVector(_camDir, 1.0), 0.5);  // whoosh-ish
        if (gameplay.hitFeedback) gameplay.hitFeedback.shake = Math.max(gameplay.hitFeedback.shake || 0, 0.3);

        const targets = s.npcs.concat(s.rivals, s.police, s.patrol);
        let best = null, bestDist = BAT_RANGE;
        for (const t of targets) {
            if (!t.mesh) continue;
            _toNpc.copy(t.mesh.position); _toNpc.y += 1.0; _toNpc.sub(_camPos);
            const dist = _toNpc.length();
            if (dist < 0.001 || dist > BAT_RANGE) continue;
            _toNpc.multiplyScalar(1 / dist);
            if (_toNpc.dot(_camDir) < 0.6) continue;   // wide melee cone
            if (dist < bestDist) { bestDist = dist; best = t; }
        }
        if (best) {
            const dir = _camDir.clone();
            ragdoll.ragdollify(best.mesh, { x: dir.x * BAT_IMPULSE, y: 4.0, z: dir.z * BAT_IMPULSE });
            playSfx('hit', best.mesh.getWorldPosition(new THREE.Vector3()));
            floatText('WHACK', best.mesh.getWorldPosition(new THREE.Vector3()).setY(2.0), '#ffd24a');
            const wasArmed = !!best.armed;
            const kind = removeLivePerson(s, best);
            if (kind === 'rival') {
                s.demand = Math.min(MARKET_MAX, (s.demand || 1) + 0.05);
                startEvent(s, 'rivalTruce', 30000);
                if (wasArmed) {
                    s.cash += RIVAL_KILL_BOUNTY;
                    floatText(`Armed rival dropped +$${RIVAL_KILL_BOUNTY}`, best.mesh.position.clone().setY(2.4), '#9dffa0');
                } else {
                    floatText('Rivals back off', best.mesh.position.clone().setY(2.4), '#ffd24a');
                }
            }
        }
    }

    // ---- armed cops: which weapon (if any) a cop carries at this star level.
    function copWeaponForStars(stars) {
        if (stars >= COP_GUN_STAR) return 'gun';
        if (stars >= COP_TAZER_STAR) return 'tazer';
        return null;
    }
    // Non-lethal damage to the player — floored so cop fire stings but never
    // kills (mirrors the bust health knock). Adds hit feedback + a hurt tint.
    function hurtPlayer(amount) {
        const cur = (gameplay.health ?? 1);
        const next = Math.max(COP_HEALTH_FLOOR, cur - amount);
        try { setPlayerHealth(next); } catch (e) {}
        if (gameplay.hitFeedback) gameplay.hitFeedback.shake = Math.max(gameplay.hitFeedback.shake || 0, 0.4);
    }
    // A cop takes a shot at the player. Tracer + flash sprite at the cop's
    // muzzle + SFX; tazers zap (short range, low damage), sidearms crack
    // (longer range, more damage). Cooldown is per-cop.
    const _copMuzzle = new THREE.Vector3();
    const _copToPlayer = new THREE.Vector3();
    function copFireAt(s, cop, weapon, playerPos) {
        const now = performance.now?.() || Date.now();
        if (now < (cop.nextFireAt || 0)) return;
        const isTaz = weapon === 'tazer';
        const range = isTaz ? COP_TAZER_RANGE : COP_GUN_RANGE;
        const cm = cop.mesh;
        const d = Math.hypot(cm.position.x - playerPos.x, cm.position.z - playerPos.z);
        if (d > range || d < COP_FIRE_MIN_RANGE) return;

        // Face the player and fire.
        cop.nextFireAt = now + (isTaz ? COP_TAZER_COOLDOWN_MS : COP_GUN_COOLDOWN_MS);
        cm.rotation.y = Math.atan2(playerPos.x - cm.position.x, playerPos.z - cm.position.z);

        _copMuzzle.set(cm.position.x, (cm.position.y || 0) + 1.2, cm.position.z);
        const { camera } = core;
        // Aim at the player's head (camera) if available, else chest height.
        if (camera) camera.getWorldPosition(_copToPlayer);
        else _copToPlayer.set(playerPos.x, _copMuzzle.y, playerPos.z);
        const end = _copToPlayer.clone();
        spawnTracer(_copMuzzle, end, isTaz ? 0x66e0ff : 0xfff3a0);
        copMuzzleFlash(_copMuzzle, isTaz);
        playSfx(isTaz ? 'tazer' : 'shot', _copMuzzle.clone(), isTaz ? 0.7 : 0.85);

        hurtPlayer(isTaz ? COP_TAZER_DAMAGE : COP_GUN_DAMAGE);
        floatText(isTaz ? '⚡ ZAPPED' : '🔫 SHOT', end.clone().setY(end.y + 0.3), isTaz ? '#66e0ff' : '#ff7070');
    }
    // Armed rival fires at the player — same non-lethal model as cop sidearms
    // (red tracer), floored damage. Per-rival cooldown lives on rival.nextFireAt.
    const _rivMuzzle = new THREE.Vector3();
    const _rivToPlayer = new THREE.Vector3();
    function rivalFireAt(s, rival, playerPos) {
        const now = performance.now?.() || Date.now();
        if (now < (rival.nextFireAt || 0)) return;
        const rm = rival.mesh;
        const d = Math.hypot(rm.position.x - playerPos.x, rm.position.z - playerPos.z);
        if (d > RIVAL_GUN_RANGE || d < RIVAL_GUN_MIN_RANGE) return;
        rival.nextFireAt = now + RIVAL_GUN_COOLDOWN_MS;

        _rivMuzzle.set(rm.position.x, (rm.position.y || 0) + 1.2, rm.position.z);
        const { camera } = core;
        if (camera) camera.getWorldPosition(_rivToPlayer);
        else _rivToPlayer.set(playerPos.x, _rivMuzzle.y, playerPos.z);
        spawnTracer(_rivMuzzle, _rivToPlayer.clone(), 0xff5a5a);
        copMuzzleFlash(_rivMuzzle, false);
        playSfx('shot', _rivMuzzle.clone(), 0.8);
        hurtPlayer(RIVAL_GUN_DAMAGE);
        floatText('🔫 Rival fire', _rivToPlayer.clone().setY(_rivToPlayer.y + 0.3), '#ff5a5a');
    }
    // A small one-shot flash sprite at a world position (for cop fire). Reuses
    // the player muzzle texture; fades via the tracer cleanup timer.
    function copMuzzleFlash(pos, isTaz) {
        const { scene } = core;
        if (!scene) return;
        if (!_flashTex) _flashTex = makeFlashTexture();
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({
            map: _flashTex, transparent: true, depthTest: false, depthWrite: false,
            blending: THREE.AdditiveBlending, toneMapped: false,
            color: isTaz ? 0x66e0ff : 0xffd27a,
        }));
        spr.scale.setScalar(0.5 + Math.random() * 0.2);
        spr.position.copy(pos);
        spr.renderOrder = 11;
        scene.add(spr);
        _copFlashes.push({ spr, born: performance.now?.() || Date.now() });
    }
    const _copFlashes = [];
    function updateCopFlashes() {
        const { scene } = core;
        const now = performance.now?.() || Date.now();
        for (let i = _copFlashes.length - 1; i >= 0; i--) {
            const f = _copFlashes[i];
            const age = now - f.born;
            if (age > 80) {
                try { scene?.remove(f.spr); f.spr.material.dispose(); } catch (e) {}
                _copFlashes.splice(i, 1);
            } else {
                f.spr.material.opacity = 1 - age / 80;
            }
        }
    }

    function moveToward(mesh, target, speed, dt, layout) {
        if (!mesh || !target) return false;
        const dx = target.x - mesh.position.x;
        const dz = target.z - mesh.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.4) { animateWalk(mesh, 0, dt); return true; }
        const step = Math.min(dist, speed * dt);
        mesh.position.x += (dx / dist) * step;
        mesh.position.z += (dz / dist) * step;
        mesh.position.y = layout.spawnY ?? 0; // person group origin = feet
        mesh.rotation.y = Math.atan2(dx, dz); // face travel direction
        animateWalk(mesh, speed, dt);
        mesh.updateMatrixWorld(true);
        return false;
    }

    // Drive a simple 4-limb walk cycle on a person group (made by ragdoll.makePerson).
    // Phase advances proportional to walk speed; legs swing front/back on X axis,
    // arms swing opposite. When stopped (movingSpeed=0) limbs ease back to rest.
    function animateWalk(mesh, movingSpeed, dt) {
        const ud = mesh.userData || {};
        if (ud.walkingMixer) {
            // LOD-far buyers render as the box rig, not the FBX — skip the
            // skinning update entirely (the big mobile cost saver).
            if (ud.walkingLodFar) { if (ud.walkingAction) ud.walkingAction.paused = true; return; }
            const moving = movingSpeed > 0.05;
            if (ud.walkingAction) {
                ud.walkingAction.paused = !moving;
                ud.walkingAction.timeScale = moving
                    ? THREE.MathUtils.clamp(movingSpeed / NPC_WANDER_SPEED, 0.65, 1.35)
                    : 0;
            }
            if (moving) ud.walkingMixer.update(dt);
            return;
        }
        const parts = mesh.userData?.parts;
        if (!parts || parts.length < 6) return;
        ud.walkPhase = (ud.walkPhase || 0) + (movingSpeed > 0 ? movingSpeed * 4.2 * dt : 0);
        const phase = ud.walkPhase;
        const amp = movingSpeed > 0 ? 0.6 : 0;
        // Ease current amp toward target so stopping isn't a snap.
        ud.walkAmp = (ud.walkAmp ?? 0) + (amp - (ud.walkAmp ?? 0)) * Math.min(1, dt * 8);
        const a = ud.walkAmp;
        const s = Math.sin(phase);
        // parts: [torso, head, armL, armR, legL, legR]
        const armL = parts[2], armR = parts[3], legL = parts[4], legR = parts[5];
        // Rotate legs from the HIP (top of leg box), not the geometric centre.
        // BoxGeometry rotates about its center, so offset position by the rotation
        // around a virtual top-pivot at +halfH. Rest pose: leg center y = 0.45,
        // legHalf = 0.425, top = 0.875. Same trick for arms (shoulder pivot).
        const applyTopPivot = (limb, restY, halfH, angle) => {
            if (!limb) return;
            limb.rotation.x = angle;
            const c = Math.cos(angle), si = Math.sin(angle);
            // Move center so the TOP of the box stays at restY + halfH.
            limb.position.y = restY + halfH - c * halfH;
            limb.position.z = -si * halfH;
        };
        applyTopPivot(legL, 0.45, 0.425,  s * a);
        applyTopPivot(legR, 0.45, 0.425, -s * a);
        applyTopPivot(armL, 1.30, 0.31, -s * a * 0.8);
        applyTopPivot(armR, 1.30, 0.31,  s * a * 0.8);
        // Subtle bob on torso/head.
        const bob = Math.abs(Math.sin(phase * 2)) * a * 0.015;
        const torso = parts[0], head = parts[1];
        if (torso) torso.position.y = 1.25 + bob;
        if (head) head.position.y = 1.82 + bob;
    }

    // ---- grow room: teleport, plants, harvest --------------------------
    function teleportPlayer(pos) {
        if (!physics?.character || !physics.Jolt) return;
        const { Jolt, character } = physics;
        const p = new Jolt.RVec3(pos[0], pos[1] + FLOOR_OFFSET, pos[2]);
        character.SetPosition(p);
        try { character.SetLinearVelocity(Jolt.Vec3.prototype.sZero()); } catch (e) {}
        Jolt.destroy(p);
    }

    // One fan leaf: the iconic cannabis palmate leaflet — a fanned cluster of
    // 7 thin tapered blades sharing a base, angled outward. Returned as a small
    // group that can be tilted/rotated as a whole.
    function makeFanLeaf(mat) {
        const leaf = new THREE.Group();
        const fingers = 7;
        for (let i = 0; i < fingers; i++) {
            // Centre finger longest, outer fingers progressively shorter.
            const k = Math.abs(i - (fingers - 1) / 2);
            const len = 0.42 - k * 0.07;
            const blade = new THREE.Mesh(
                new THREE.CylinderGeometry(0.004, 0.05, len, 4),
                mat,
            );
            blade.geometry.scale(1, 1, 0.32);          // flatten into a blade
            blade.position.y = len * 0.5;
            const fan = (i - (fingers - 1) / 2) * 0.34; // spread the fingers
            const f = new THREE.Group();
            f.add(blade);
            f.rotation.z = fan;
            leaf.add(f);
        }
        return leaf;
    }

    // Plant = fabric grow-bag pot + soil + a foliage wrapper that holds a
    // clone of the shared Weed.glb prototype. Growth scales the foliage group;
    // the pot stays a fixed size so the plant looks like it's growing out of it.
    function makePlantMesh() {
        const g = new THREE.Group();

        // Fabric grow bag + soil — match the rest of the room's DDGI shading.
        const potMat  = new DDGIMeshStandardNodeMaterial({ color: new THREE.Color('#1a1a1c'), roughness: 1.0, metalness: 0.0 });
        const rimMat  = new DDGIMeshStandardNodeMaterial({ color: new THREE.Color('#2a2a2d'), roughness: 1.0, metalness: 0.0 });
        const soilMat = new DDGIMeshStandardNodeMaterial({ color: new THREE.Color('#241a12'), roughness: 1.0, metalness: 0.0 });
        const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.26, 0.5, 24), potMat);
        pot.position.y = 0.25;
        pot.castShadow = true; pot.receiveShadow = true;
        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.035, 8, 24), rimMat);
        rim.rotation.x = Math.PI / 2;
        rim.position.y = 0.5;
        const soil = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.06, 24), soilMat);
        soil.position.y = 0.5;
        g.add(pot); g.add(rim); g.add(soil);

        // Foliage = scaled wrapper around the GLB clone. Sits on the soil line.
        // (GLB pivot offset is corrected on the clone itself, inside attach()
        // below, so the offset scales together with growth.)
        const foliage = new THREE.Group();
        foliage.position.y = 0.52;
        foliage.visible = false;
        foliage.userData.glbAttached = false;
        // Pest swarm (kept — bugs jitter around the canopy when infested).
        const pests = new THREE.Group();
        pests.visible = false;
        const bugMat = new THREE.MeshStandardMaterial({ color: '#3a2a18', roughness: 0.8 });
        for (let i = 0; i < 7; i++) {
            const bug = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 5), bugMat);
            const a = Math.random() * Math.PI * 2;
            const r = 0.35 + Math.random() * 0.45;
            bug.position.set(Math.cos(a) * r, 0.4 + Math.random() * 1.0, Math.sin(a) * r);
            bug.userData.seed = Math.random() * 100;
            bug.userData.base = bug.position.clone();
            pests.add(bug);
        }
        foliage.add(pests);
        foliage.userData.pests = pests;

        // Attach the GLB clone as soon as the prototype is ready. Until then
        // the foliage group is empty + invisible (applyPlantGrowth flips that
        // once content is present and the plant has progress > 0).
        const attach = () => {
            if (foliage.userData.glbAttached) return;
            if (!_weedPrototype) return;
            const clone = _weedPrototype.clone(true);
            clone.traverse((o) => {
                if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
            });
            // Bake the world-scale-up multiplier so the GLB matches the old
            // procedural plant's mature height. growth still drives the parent
            // foliage scale, which composes with this constant.
            // GLB's pivot sits ~0.15m above its lowest point — drop the clone
            // so the plant root meets the soil (scales correctly with growth
            // because it's inside the foliage wrapper).
            clone.position.y = -0.15;
            clone.scale.setScalar(WEED_BASE_SCALE);
            foliage.add(clone);
            foliage.userData.glbAttached = true;
        };
        if (_weedPrototype) attach();
        else loadWeedPrototype().then(attach);

        g.add(foliage);
        g.userData.foliage = foliage;
        return g;
    }

    // Sprinkle thin pistil hairs over a bud (cone spikes pointing outward), so
    // flowering buds get the fuzzy hair look. They share `mat` (faded in later).
    function addPistils(bud, mat, n, spread) {
        for (let i = 0; i < n; i++) {
            const hair = new THREE.Mesh(new THREE.ConeGeometry(0.006, 0.05, 4), mat);
            const u = Math.random(), v = Math.random();
            const theta = u * Math.PI * 2, phi = Math.acos(2 * v - 1);
            const dir = new THREE.Vector3(
                Math.sin(phi) * Math.cos(theta),
                Math.abs(Math.cos(phi)) * 0.8 + 0.2,
                Math.sin(phi) * Math.sin(theta),
            );
            hair.position.copy(dir.clone().multiplyScalar(spread));
            hair.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
            bud.add(hair);
        }
    }
    // ---- continuous cannabis growth ------------------------------------
    // Drives the whole plant off `plant.progress` (0..1) plus `plant.health`.
    // Phases (see PH_* constants): germination → seedling → vegetative →
    // flowering → ripening. Branches emerge bottom-up, leaves unfurl, buds
    // swell + grow pistils, then everything ambers as it ripens. Called every
    // frame for the watered, growing plant so the change is smooth (no popping).
    const _lerpA = new THREE.Color();
    const _lerpB = new THREE.Color();
    // out = lerp(a, b, t). `a`/`b` may be hex strings or THREE.Color instances.
    function asColor(c, dst) { return (c && c.isColor) ? dst.copy(c) : dst.set(c); }
    function colMix(out, a, b, t) {
        asColor(a, _lerpA);
        asColor(b, _lerpB);
        return out.copy(_lerpA).lerp(_lerpB, t);
    }
    function smooth(t) { t = clamp01(t); return t * t * (3 - 2 * t); }      // smoothstep
    function ramp(p, a, b) { return clamp01((p - a) / Math.max(1e-4, b - a)); } // 0..1 over [a,b]

    function applyPlantGrowth(plant) {
        const foliage = plant.mesh?.userData?.foliage;
        if (!foliage) return;
        plant.mesh.visible = true;

        if (!plant.planted) { foliage.visible = false; return; }
        foliage.visible = true;

        const p = clamp01(plant.progress);
        const health = clamp01(plant.health ?? 1);

        // Single growth curve: tiny sprout → mature canopy. Health shrinks the
        // mature size a little so sick plants look stunted.
        const growth = smooth(p);
        const scale = (0.05 + growth * 0.95) * (0.6 + 0.4 * health);
        foliage.scale.setScalar(scale);

        // Thirst → droop (foliage tilts to one side when parched).
        const moist = clamp01(plant.moisture ?? 1);
        const droop = (plant.watered && moist < DRY_STRESS) ? (1 - moist / DRY_STRESS) : 0;
        foliage.rotation.z = droop * 0.18;

        // Pest swarm visibility.
        if (foliage.userData.pests) foliage.userData.pests.visible = !!plant.pest;
    }
    // Back-compat shim — older callers used applyPlantStage(plant).
    function applyPlantStage(plant) { applyPlantGrowth(plant); }

    function setPlantsVisible(s, visible) {
        visible = !!visible;
        if (s._plantsVisible === visible) return;
        s._plantsVisible = visible;
        for (const p of s.plants || []) {
            if (!p.mesh) continue;
            p.mesh.visible = visible;
            if (visible) applyPlantGrowth(p);
        }
    }

    // Cheap per-frame jitter of the pest swarm on infested plants (called from
    // the room update so the bugs visibly crawl/hover).
    function animatePests(s) {
        const t = (performance.now?.() || Date.now()) * 0.004;
        for (const p of s.plants) {
            const pests = p.mesh?.userData?.foliage?.userData?.pests;
            if (!pests || !pests.visible) continue;
            for (const bug of pests.children) {
                const b = bug.userData.base; const sd = bug.userData.seed || 0;
                bug.position.set(
                    b.x + Math.sin(t + sd) * 0.06,
                    b.y + Math.sin(t * 1.7 + sd) * 0.05,
                    b.z + Math.cos(t * 1.3 + sd) * 0.06,
                );
            }
        }
    }
    function ensurePlants(s, layout) {
        if (s.plantsBuilt) return;
        const { scene } = core;
        const now = performance.now?.() || Date.now();
        const pots = Array.isArray(layout.growPots) ? layout.growPots : [];
        const saved = Array.isArray(s.plantsData) ? s.plantsData : null;
        pots.forEach((pot, i) => {
            const mesh = makePlantMesh();
            mesh.position.set(pot[0], pot[1], pot[2]); // group origin = pot base
            scene?.add(mesh);
            // Start EMPTY — the player must plant a seed, then water it.
            const plant = {
                mesh, planted: false, watered: false, stage: 0, grownAt: 0, pos: pot,
                progress: 0,        // continuous 0..1 lifecycle
                lastTick: 0,        // ms timestamp of last growth tick
                health: 1,          // 0..1 — drops if left dry, recovers when watered
                driedAt: 0,         // when an un-watered seed will wilt
                moisture: 0,        // 0..1 soil water; drains over time, refill by watering
                pest: false,        // active infestation (slows growth, drains health)
                nextSprayAt: 0,     // spray-action cooldown
            };
            // Restore a saved crop into this pot (re-basing the time-relative
            // fields to "now" so a reload neither fast-forwards nor wilts it).
            const d = saved?.[i];
            if (d && d.planted) {
                plant.planted = true;
                plant.watered = !!d.watered;
                plant.progress = Math.min(1, Math.max(0, d.progress || 0));
                plant.stage = d.stage | 0;
                plant.health = typeof d.health === 'number' ? d.health : 1;
                plant.moisture = typeof d.moisture === 'number' ? d.moisture : (plant.watered ? 1 : 0);
                plant.pest = !!d.pest;
                plant.tier = d.tier | 0;
                plant.crop = d.crop || SEED_TIERS[plant.tier]?.crop || 'weed';
                plant.juiceMult = d.juiceMult || 1;
                plant.lastTick = now;   // resume growth clock from load time
                plant.driedAt = (!plant.watered && d.dryRemain > 0) ? now + d.dryRemain : 0;
            }
            applyPlantGrowth(plant);
            s.plants.push(plant);
        });
        s.plantsBuilt = true;
    }
    // Tier the next plant will use: the player's selected tier if they own one,
    // else the highest tier they have stock of. Returns -1 if no seeds at all.
    function pickPlantTier(s) {
        if (!Array.isArray(s.seeds)) return -1;
        const sel = s.seedTier | 0;
        if (sel >= 0 && sel < SEED_TIERS.length && s.seeds[sel] > 0) return sel;
        for (let i = SEED_TIERS.length - 1; i >= 0; i--) {
            if (s.seeds[i] > 0) return i;
        }
        return -1;
    }
    function totalSeeds(s) {
        return Array.isArray(s.seeds) ? s.seeds.reduce((a, b) => a + (b | 0), 0) : 0;
    }
    // Same pattern as seeds, for grow juice.
    function pickJuiceTier(s) {
        if (!Array.isArray(s.juices)) return -1;
        const sel = s.juiceTier | 0;
        if (sel >= 0 && sel < JUICE_TIERS.length && s.juices[sel] > 0) return sel;
        for (let i = JUICE_TIERS.length - 1; i >= 0; i--) {
            if (s.juices[i] > 0) return i;
        }
        return -1;
    }
    function totalJuices(s) {
        return Array.isArray(s.juices) ? s.juices.reduce((a, b) => a + (b | 0), 0) : 0;
    }
    function pourJuice(s, plant) {
        if (!plant?.planted) return false;
        if ((plant.juiceMult || 1) > 1) return false;     // already boosted
        const tier = pickJuiceTier(s);
        if (tier < 0) {
            showPrompt('No grow juice — buy a bottle at the juice shop');
            return false;
        }
        s.juices[tier] = Math.max(0, (s.juices[tier] | 0) - 1);
        const juice = JUICE_TIERS[tier];
        plant.juiceMult = juice.speed;
        floatText(`+${juice.t} · ×${juice.speed.toFixed(1)} grow`, plant.mesh.position.clone().setY(plant.mesh.position.y + 1.4), juice.color);
        updateHud();
        saveProgress();
        return true;
    }
    function plantSeed(s, plant) {
        if (plant.planted) return false;
        const tier = pickPlantTier(s);
        if (tier < 0) {
            showPrompt('No seeds — buy some at the seed shop outside');
            return false;
        }
        s.seeds[tier] = Math.max(0, (s.seeds[tier] | 0) - 1);
        const seed = SEED_TIERS[tier];
        const now = performance.now?.() || Date.now();
        plant.planted = true;
        plant.watered = false;
        plant.stage = 0;
        plant.progress = 0;
        plant.health = 1;
        plant.tier = tier;                  // drives grow speed + harvest yield/quality
        plant.crop = seed.crop || 'weed';   // coke line uses coca leaves, not buds
        plant.juiceMult = 1;                // grow-juice boost (1 = none); pour at the shop
        plant.lastTick = now;
        plant.driedAt = now + DRY_OUT_MS;   // un-watered seeds wilt eventually
        applyPlantGrowth(plant);
        floatText(`${seed.t.replace(' Seeds', '')} planted — needs water`, plant.mesh.position.clone().setY(plant.mesh.position.y + 1.2), seed.color);
        award('firstSeed');
        updateHud();
        saveProgress();
        return true;
    }
    function waterPlant(s, plant) {
        if (!plant.planted) return;
        const now = performance.now?.() || Date.now();
        const wasDry = !plant.watered;
        plant.watered = true;
        plant.driedAt = 0;                  // watered → no longer drying out
        plant.lastTick = now;               // resume growth clock from now
        plant.moisture = 1;                 // soil topped right up
        // Re-watering a stressed plant nurses some health back.
        if (!wasDry) plant.health = Math.min(1, (plant.health ?? 1) + 0.15);
        applyPlantGrowth(plant);
        if (wasDry) floatText('💧 Watered — growing', plant.mesh.position.clone().setY(plant.mesh.position.y + 1.2), '#7fd0ff');
        else floatText('💧 Topped up', plant.mesh.position.clone().setY(plant.mesh.position.y + 1.2), '#7fd0ff');
    }
    function updatePlants(s, visual = true) {
        const now = performance.now?.() || Date.now();
        const stepMs = PLANT_SIM_STEP_MS;
        for (const p of s.plants) {
            if (!p.planted) continue;
            if (!p.watered) {
                // Un-watered seed slowly wilts; if it dries out fully it dies and
                // the pot empties (lost seed) so water promptly.
                if (p.driedAt && now >= p.driedAt) {
                    p.planted = false; p.progress = 0; p.stage = 0; p.health = 1;
                    p.crop = null;
                    p._visualDirty = true;
                    if (visual) {
                        applyPlantGrowth(p);
                        floatText('🥀 Seed dried out', p.mesh.position.clone().setY(p.mesh.position.y + 1.2), '#c08a3a');
                    }
                }
                continue;
            }
            if (now - (p.lastTick || now) < stepMs) {
                if (visual && p._visualDirty) {
                    applyPlantGrowth(p);
                    p._visualDirty = false;
                }
                continue;
            }
            // Watered + growing: advance by real elapsed time, but care matters.
            const dtMs = Math.min(2000, now - (p.lastTick || now));   // clamp big gaps (tab away)
            p.lastTick = now;
            const dt = dtMs / 1000;
            const lights = s.baseUp?.lights || 0;
            const autoWater = s.baseUp?.autoWater || 0;

            // Soil dries out over time → must re-water.
            p.moisture = Math.max(0, (p.moisture ?? 1) - MOISTURE_DRAIN_PER_SEC * Math.pow(0.72, autoWater) * dt);
            if (autoWater > 0 && p.moisture < 0.28) p.moisture = Math.min(0.72, p.moisture + 0.18 * autoWater);
            const thirsty = p.moisture < DRY_STRESS;

            // Pest rolls: a healthy, growing plant can catch an infestation.
            const pestRate = PEST_CHANCE_PER_SEC * (eventActive(s, 'pestBloom') ? 2.4 : 1) * Math.pow(0.9, lights);
            if (!p.pest && p.progress < 1 && Math.random() < pestRate * dt) {
                p.pest = true;
                p._visualDirty = true;
                if (visual) floatText('🐛 Pests! Spray it', p.mesh.position.clone().setY(p.mesh.position.y + 1.3), '#ff9a4a');
            }

            // Stress (thirst or pests) drains health + stalls growth; otherwise
            // health slowly recovers.
            const stressed = thirsty || p.pest;
            if (stressed) p.health = Math.max(0, (p.health ?? 1) - HEALTH_DRAIN_PER_SEC * dt);
            else p.health = Math.min(1, (p.health ?? 1) + HEALTH_RECOVER_PER_SEC * dt);

            if (p.progress < 1) {
                // Growth halts when bone dry; pests merely slow it.
                let rate = thirsty ? 0 : 1;
                if (p.pest) rate *= PEST_GROWTH_MULT;
                rate *= 1 + lights * 0.4;                      // grow lights — doubled per-level bonus
                rate *= SEED_TIERS[p.tier ?? 0]?.speed ?? 1;   // better seeds grow faster
                rate *= p.juiceMult || 1;                       // grow-juice pour-on boost
                p.progress = Math.min(1, p.progress + (dt * 1000 / PLANT_GROW_TOTAL_MS) * rate);
                p.stage = Math.min(PLANT_STAGES, Math.floor(p.progress * PLANT_STAGES));
            }
            p._visualDirty = true;
            if (visual) {
                applyPlantGrowth(p);
                p._visualDirty = false;
            }
        }
    }
    // Spray a pest-infested plant (Fire near it). Costs cash; cooldowned.
    function sprayPlant(s, plant) {
        const now = performance.now?.() || Date.now();
        if (now < (plant.nextSprayAt || 0)) return false;
        if (!plant.pest) return false;
        if (s.cash < SPRAY_COST) {
            floatText(`Need $${SPRAY_COST} for spray`, plant.mesh.position.clone().setY(plant.mesh.position.y + 1.3), '#ff7070');
            return false;
        }
        s.cash -= SPRAY_COST;
        plant.pest = false;
        plant.nextSprayAt = now + SPRAY_COOLDOWN_MS;
        applyPlantGrowth(plant);
        playSfx('hit', plant.mesh.getWorldPosition(new THREE.Vector3()), 0.4);  // pssst
        floatText(`🧴 Sprayed -$${SPRAY_COST}`, plant.mesh.position.clone().setY(plant.mesh.position.y + 1.3), '#9dffa0');
        saveProgress();
        return true;
    }
    // Build the context prompt + run the E-interaction for the nearest plant.
    function plantPrompt(s, plant, interactR) {
        if (!plant.planted) {
            const tier = pickPlantTier(s);
            if (tier < 0) {
                return '🌱 No seeds — buy them at the seed shop outside';
            }
            if (interactR) plantSeed(s, plant);
            const seed = SEED_TIERS[tier];
            return `[E] Plant ${seed.t.replace(' Seeds', '')} seed (have ${s.seeds[tier]})`;
        }
        if (!plant.watered) {
            if (interactR) waterPlant(s, plant);
            return '[E] Water the seed';
        }
        const ripe = (plant.progress ?? 0) >= 1;
        // Pests are urgent → flagged first (treat with Fire = spray).
        if (plant.pest) {
            return '🐛 Infested! Hold Fire to spray ($' + SPRAY_COST + ')';
        }
        if ((plant.moisture ?? 1) < DRY_STRESS) {
            if (interactR) waterPlant(s, plant);
            return '🥵 Thirsty — [E] water';
        }
        if (ripe) {
            if (interactR) harvestPlant(s, plant);
            return (plant.crop || SEED_TIERS[plant.tier ?? 0]?.crop) === 'coca' ? '[E] Harvest coca leaves' : '[E] Harvest plant';
        }
        // Growing: show progress %, moisture and health as a quick status line.
        const pct = Math.round((plant.progress ?? 0) * 100);
        const moist = Math.round((plant.moisture ?? 0) * 100);
        const phase = (plant.progress < PH_SEED) ? 'Seedling'
            : (plant.progress < PH_VEG) ? 'Vegetating'
            : (plant.progress < PH_FLOWER) ? 'Flowering' : 'Ripening';
        const lowWater = moist < 45 ? ' · [E] water' : '';
        if (interactR && moist < 100) waterPlant(s, plant);   // E always tops up
        // Juice hint: ×N tag if already boosted, else "hold Fire to pour" if owned.
        const boost = plant.juiceMult || 1;
        const juiceTag = boost > 1
            ? ` · 🧪 ×${boost.toFixed(1)}`
            : (pickJuiceTier(s) >= 0 ? ' · 🧪 hold Fire to pour' : '');
        return `${phase} ${pct}% · 💧${moist}%${lowWater}${juiceTag}`;
    }
    function harvestPlant(s, plant) {
        if (!plant.planted || (plant.progress ?? 0) < 1) return;
        const seed = SEED_TIERS[plant.tier ?? 0] ?? SEED_TIERS[0];
        // Yield scales with grow health AND the seed tier's yield multiplier.
        const health = clamp01(plant.health ?? 1);
        const isCoca = (plant.crop || seed.crop) === 'coca';
        const baseYield = isCoca ? COCA_LEAVES_PER_PLANT : BUDS_PER_PLANT;
        const yield_ = Math.max(2, Math.round(baseYield * (0.6 + 0.6 * health) * seed.yieldMult));
        // Quality: base + health + grow-lights + the seed tier's potency bonus.
        const q = clamp01(0.45 + health * 0.45 + (s.baseUp?.lights || 0) * 0.08 + seed.qBonus);
        if (isCoca) {
            blendCocaQuality(s, yield_, q);
            s.cocaLeaves = (s.cocaLeaves || 0) + yield_;
        } else {
            blendBudQuality(s, yield_, q);
            s.buds += yield_;
            s._budsHarvested = (s._budsHarvested | 0) + yield_;   // award counter
        }
        // Back to an empty pot — replant + rewater for the next crop.
        plant.planted = false;
        plant.watered = false;
        plant.stage = 0;
        plant.progress = 0;
        plant.health = 1;
        plant.crop = null;
        plant.driedAt = 0;
        plant.juiceMult = 1;       // pour-on boost is one-shot per plant
        applyPlantGrowth(plant);
        floatText(isCoca ? `+${yield_} coca leaves ${Math.round(q * 100)}%` : `+${yield_} buds ${Math.round(q * 100)}%`, plant.mesh.position.clone().setY(plant.mesh.position.y + 1.4), isCoca ? '#bfe9ff' : '#b6ff6a');
        updateHud();
        saveProgress();
    }

    // ---- physics bagging: drag buds across the bench into the bag -------
    // Buds are real Jolt dynamic boxes resting on the bench. The cursor grabs
    // the nearest one (velocity-driven so a release throws it). Any bud that
    // overlaps the bag's trigger zone is packaged into the sellable stash.
    // A single seven-finger cannabis leaf as a thin extruded shape, centred at
    // the petiole (base) so it can be fanned out around a stem. Each finger is a
    // long serrated lobe; the centre finger is longest, the outer ones shrink —
    // the classic fan-leaf silhouette.
    function makeCannabisLeafGeometry() {
        const shape = new THREE.Shape();
        const FINGERS = 7;
        const lens = [1.0, 0.82, 0.6, 0.38];   // length per finger by distance from centre
        const halfAngle = 0.95;                  // total fan spread (radians, each side)
        shape.moveTo(0, 0);
        // Walk fingers from the leftmost, up to the centre, back down to rightmost,
        // tracing the outline tip→base→tip with a couple of serrations per side.
        for (let i = 0; i < FINGERS; i++) {
            const idx = i - (FINGERS - 1) / 2;          // -3..+3
            const ang = (idx / ((FINGERS - 1) / 2)) * halfAngle;
            const len = lens[Math.abs(Math.round(idx))] ?? 0.3;
            const tipX = Math.sin(ang) * len;
            const tipY = Math.cos(ang) * len;
            // mid serration point (notch between fingers)
            const midX = Math.sin(ang) * len * 0.45;
            const midY = Math.cos(ang) * len * 0.42;
            shape.lineTo(midX - Math.cos(ang) * 0.04, midY + Math.sin(ang) * 0.04);
            shape.lineTo(tipX, tipY);                    // out to the finger tip
            shape.lineTo(midX + Math.cos(ang) * 0.04, midY - Math.sin(ang) * 0.04);
        }
        shape.lineTo(0, 0);
        const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: false });
        geo.center();
        return geo;
    }
    // Cluster a few leaves at varied yaw/pitch into one merged "bud" geometry,
    // scaled so the whole thing roughly fills the BUD_SIZE physics box. Built
    // once and shared across every bud (cheap to clone the Mesh around it).
    let _budGeoCache = null;
    function getBudGeometry() {
        if (_budGeoCache) return _budGeoCache;
        const leaf = makeCannabisLeafGeometry();
        const parts = [];
        const N = 5;
        for (let i = 0; i < N; i++) {
            const g = leaf.clone();
            const m = new THREE.Matrix4();
            const yaw = (i / N) * Math.PI * 2;
            const pitch = -0.5 - Math.random() * 0.4;     // splay outward/down
            const sc = (0.9 + Math.random() * 0.3) * BUD_SIZE * 1.8;
            m.makeRotationY(yaw);
            m.multiply(new THREE.Matrix4().makeRotationX(pitch));
            m.multiply(new THREE.Matrix4().makeTranslation(0, 0.06, 0));
            m.scale(new THREE.Vector3(sc, sc, sc));
            g.applyMatrix4(m);
            parts.push(g);
        }
        leaf.dispose();
        const merged = BufferGeometryUtils.mergeGeometries(parts, false);
        for (const p of parts) p.dispose();
        merged.computeVertexNormals();
        _budGeoCache = merged;
        return merged;
    }
    function makeBudMesh() {
        const mat = new THREE.MeshStandardMaterial({
            color: '#4f9e2f', roughness: 0.75, side: THREE.DoubleSide,
            emissive: '#1c4010', emissiveIntensity: 0.2,
        });
        const m = new THREE.Mesh(getBudGeometry(), mat);
        m.castShadow = true;
        return m;
    }
    function ensureBag(s, layout) {
        if (s.bagMesh || !Array.isArray(layout.packagingBench)) return;
        const { scene } = core;
        const b = layout.packagingBench;
        // Backpack sits on the bench top, offset to one side so there's room to
        // drag buds into its open top.
        s.bagPos = [b[0] - 1.3, b[1] + 0.5, b[2]];
        const g = new THREE.Group();

        const W = BAG_HALF[0] * 2, Hh = BAG_HALF[1] * 2, Dd = BAG_HALF[2] * 2;
        const canvas = new DDGIMeshStandardNodeMaterial({ color: new THREE.Color('#1c1f24'), roughness: 0.9, metalness: 0.0 });     // black pack fabric
        const accent = new DDGIMeshStandardNodeMaterial({ color: new THREE.Color('#33383f'), roughness: 0.85, metalness: 0.0 });    // grey trim/pockets
        const buckle = new DDGIMeshStandardNodeMaterial({ color: new THREE.Color('#0a0a0a'), roughness: 0.5, metalness: 0.4 });

        // Main body — rounded-ish slab, taller than wide like a real pack.
        const body = new THREE.Mesh(new THREE.BoxGeometry(W * 0.92, Hh, Dd * 0.7), canvas);
        body.position.y = Hh * 0.5 - BAG_HALF[1];
        body.castShadow = true;
        g.add(body);

        // Front pocket.
        const pocket = new THREE.Mesh(new THREE.BoxGeometry(W * 0.7, Hh * 0.45, Dd * 0.18), accent);
        pocket.position.set(0, body.position.y - Hh * 0.18, Dd * 0.42);
        pocket.castShadow = true;
        g.add(pocket);
        // Pocket flap.
        const flap = new THREE.Mesh(new THREE.BoxGeometry(W * 0.72, Hh * 0.12, Dd * 0.2), accent);
        flap.position.set(0, body.position.y + Hh * 0.06, Dd * 0.43);
        g.add(flap);
        // Buckle on the flap.
        const clip = new THREE.Mesh(new THREE.BoxGeometry(W * 0.12, Hh * 0.06, Dd * 0.06), buckle);
        clip.position.set(0, body.position.y - Hh * 0.02, Dd * 0.5);
        g.add(clip);

        // Two shoulder straps arcing down the back.
        for (const sx of [-W * 0.22, W * 0.22]) {
            const strap = new THREE.Mesh(new THREE.BoxGeometry(W * 0.12, Hh * 0.9, Dd * 0.1), accent);
            strap.position.set(sx, body.position.y, -Dd * 0.36);
            strap.rotation.x = 0.12;
            g.add(strap);
        }
        // Top grab handle.
        const handle = new THREE.Mesh(
            new THREE.TorusGeometry(W * 0.16, 0.03, 8, 16, Math.PI),
            accent,
        );
        handle.position.set(0, body.position.y + Hh * 0.5, -Dd * 0.1);
        g.add(handle);

        // Glowing green rim = the open top, the drop target (kept from the bag).
        const rimMat = new DDGIMeshStandardNodeMaterial({
            color: new THREE.Color('#9dffa0'),
            emissive: new THREE.Color('#9dffa0'),
            roughness: 0.4,
            metalness: 0.0,
        });
        rimMat.emissiveIntensity = 1.4;
        const rim = new THREE.Mesh(
            new THREE.TorusGeometry(BAG_HALF[0] * 0.7, 0.05, 8, 20),
            rimMat,
        );
        rim.rotation.x = Math.PI / 2;
        rim.position.y = BAG_HALF[1];
        g.add(rim);

        g.position.set(s.bagPos[0], s.bagPos[1], s.bagPos[2]);
        scene?.add(g);
        s.bagMesh = g;
    }
    function spawnPhysBud(s, layout) {
        if (!physics?.ready || !physics.Jolt) return false;
        if (s.buds <= 0) return false;
        const { Jolt, bodyInterface } = physics;
        const { scene } = core;
        const b = layout.packagingBench;
        if (!Array.isArray(b)) return false;
        // Spawn on the far side of the bench so you have to drag it across.
        const x = b[0] + 1.1 + (Math.random() - 0.5) * 0.4;
        const y = b[1] + 0.7;
        const z = b[2] + (Math.random() - 0.5) * 0.6;

        const mesh = makeBudMesh();
        mesh.position.set(x, y, z);
        scene?.add(mesh);

        const half = new Jolt.Vec3(BUD_SIZE, BUD_SIZE, BUD_SIZE);
        const shapeSettings = new Jolt.BoxShapeSettings(half);
        const shapeResult = shapeSettings.Create();
        const shape = shapeResult.Get();
        shape.AddRef();
        shapeResult.Clear();
        Jolt.destroy(shapeResult);
        Jolt.destroy(shapeSettings);
        Jolt.destroy(half);

        const pos = new Jolt.RVec3(x, y, z);
        const rot = new Jolt.Quat(0, 0, 0, 1);
        const settings = new Jolt.BodyCreationSettings(shape, pos, rot, Jolt.EMotionType_Dynamic, 1 /* movingLayer */);
        settings.mFriction = 0.6;
        settings.mRestitution = 0.15;
        settings.mLinearDamping = 0.5;
        settings.mAngularDamping = 0.7;
        const body = bodyInterface.CreateBody(settings);
        bodyInterface.AddBody(body.GetID(), Jolt.EActivation_Activate);
        Jolt.destroy(settings);
        Jolt.destroy(pos);
        Jolt.destroy(rot);

        const q = consumeBudQuality(s, 1);
        s.physBuds.push({ mesh, body, q });
        return true;
    }
    function destroyPhysBud(s, bud) {
        const { scene } = core;
        try { scene?.remove(bud.mesh); } catch (e) {}
        if (physics?.Jolt && bud.body) {
            try {
                physics.bodyInterface.RemoveBody(bud.body.GetID());
                physics.bodyInterface.DestroyBody(bud.body.GetID());
            } catch (e) {}
        }
        const i = s.physBuds.indexOf(bud);
        if (i >= 0) s.physBuds.splice(i, 1);
        if (s.grabbed === bud) s.grabbed = null;
        if (s.touchGrabbed === bud) s.touchGrabbed = null;
        if (_mobileBudDrag.bud === bud) releaseMobileBudDrag();
    }
    function queuePhysBudReturn(s, bud) {
        // Don't destroy the bud — let it keep falling and stay visible. Mark a
        // reset time; processPendingBudReturns removes it + credits inventory
        // once BUD_RETURN_MS elapses.
        if (!bud || bud.returnAt) return;
        bud.returnAt = (performance.now?.() || Date.now()) + BUD_RETURN_MS;
        const pos = bud.mesh?.position?.clone?.() || new THREE.Vector3(...(s.bagPos || [0, 1, 0]));
        floatText('bud returns in 30s', pos.setY(pos.y + 0.45), '#b6ff6a');
    }
    function processPendingBudReturns(s) {
        if (!Array.isArray(s.physBuds) || s.physBuds.length === 0) return;
        const now = performance.now?.() || Date.now();
        let returned = 0;
        let returnedQ = 0;
        for (const bud of [...s.physBuds]) {
            if (bud.returnAt && now >= bud.returnAt) {
                returnedQ += bud.q || 1;
                destroyPhysBud(s, bud);
                returned += 1;
            }
        }
        if (returned > 0) {
            blendBudQuality(s, returned, returnedQ / returned);
            s.buds += returned;
            floatText(`+${returned} bud${returned === 1 ? '' : 's'}`, new THREE.Vector3(...(s.bagPos || [0, 1, 0])), '#b6ff6a');
        }
    }
    function clearPhysBuds(s) {
        for (const bud of [...(s.physBuds || [])]) destroyPhysBud(s, bud);
        const { scene } = core;
        if (s.bagMesh) { try { scene?.remove(s.bagMesh); } catch (e) {} s.bagMesh = null; }
        s.bagPos = null;
        s.grabbed = null;
        s.touchGrabbed = null;
        releaseMobileBudDrag();
    }

    const _grabCamPos = new THREE.Vector3();
    const _grabCamDir = new THREE.Vector3();
    const _grabTarget = new THREE.Vector3();
    const _budPos = new THREE.Vector3();
    const _touchNdc = new THREE.Vector2();
    const _touchRaycaster = new THREE.Raycaster();
    const _touchPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const _touchDragTarget = new THREE.Vector3();
    const _touchScreenPos = new THREE.Vector3();
    const _mobileBudDrag = {
        pointerId: null,
        bud: null,
        hasTarget: false,
    };
    let _mobileBudDragEventsInstalled = false;

    function isMobileBudDragContext() {
        const s = window.drugTycoon;
        return !!(
            gameplay.active
            && core.currentMesh?.userData?.sampleType === 'drugTycoon'
            && s?.inRoom
            && !s.shopOpen
            && !s.cooking
            && !s.baggingOpen
            && !s.helpOpen
            && Array.isArray(s.physBuds)
            && s.physBuds.length > 0
        );
    }

    function setTouchRayFromEvent(event) {
        const renderer = core.renderer;
        const camera = core.camera;
        const rect = renderer?.domElement?.getBoundingClientRect?.();
        if (!rect || rect.width <= 0 || rect.height <= 0 || !camera) return false;
        _touchNdc.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        _touchRaycaster.setFromCamera(_touchNdc, camera);
        return true;
    }

    function pickTouchBud(event, s) {
        if (!setTouchRayFromEvent(event)) return null;
        const meshes = s.physBuds.map((bud) => bud.mesh).filter(Boolean);
        const hits = _touchRaycaster.intersectObjects(meshes, false);
        if (hits.length > 0) {
            return s.physBuds.find((bud) => bud.mesh === hits[0].object) || null;
        }

        const renderer = core.renderer;
        const camera = core.camera;
        const rect = renderer?.domElement?.getBoundingClientRect?.();
        if (!rect || !camera) return null;

        let best = null;
        let bestDistSq = BUD_TOUCH_PICK_RADIUS * BUD_TOUCH_PICK_RADIUS;
        for (const bud of s.physBuds) {
            _touchScreenPos.copy(bud.mesh.position).project(camera);
            if (_touchScreenPos.z < -1 || _touchScreenPos.z > 1) continue;
            const sx = rect.left + (_touchScreenPos.x * 0.5 + 0.5) * rect.width;
            const sy = rect.top + (-_touchScreenPos.y * 0.5 + 0.5) * rect.height;
            const dx = event.clientX - sx;
            const dy = event.clientY - sy;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestDistSq) {
                bestDistSq = d2;
                best = bud;
            }
        }
        return best;
    }

    function updateMobileBudDragTarget(event) {
        const bud = _mobileBudDrag.bud;
        if (!bud || !setTouchRayFromEvent(event)) return false;
        const s = window.drugTycoon;
        const baseY = s?.bagPos?.[1] ?? bud.mesh?.position?.y ?? 1.2;
        const ray = _touchRaycaster.ray;
        const layout = core.currentMesh?.userData?.drugTycoonLevel || {};
        const bench = Array.isArray(layout.packagingBench) ? layout.packagingBench : null;

        // Horizontal axis = bench->bag direction (falls back to bag X axis).
        let nx = 1, nz = 0, ox = 0, oz = 0;
        if (s?.bagPos) {
            ox = s.bagPos[0];
            oz = s.bagPos[2];
            if (bench) {
                const ax = s.bagPos[0] - bench[0];
                const az = s.bagPos[2] - bench[2];
                const len = Math.hypot(ax, az) || 1;
                nx = ax / len;
                nz = az / len;
            }
        }

        // Vertical drag plane: contains the axis line, faces the camera so an
        // up-swipe lifts the bud (Y) while along-swipe slides it on the axis.
        const px = -nz, pz = nx;            // plane normal (perp to axis, horizontal)
        _touchPlane.normal.set(px, 0, pz);
        _touchPlane.constant = -(px * ox + pz * oz);
        if (!ray.intersectPlane(_touchPlane, _touchDragTarget)) {
            _touchDragTarget.copy(ray.origin).addScaledVector(ray.direction, BUD_HOLD_DIST);
        }

        // Project onto axis for horizontal, take Y from the plane hit for lift.
        const dx = _touchDragTarget.x - ox;
        const dz = _touchDragTarget.z - oz;
        const t = Math.max(-3.0, Math.min(0.8, dx * nx + dz * nz));
        const y = Math.max(baseY, Math.min(baseY + 2.5, _touchDragTarget.y));
        _touchDragTarget.set(ox + nx * t, y, oz + nz * t);

        _mobileBudDrag.hasTarget = true;
        return true;
    }

    function releaseMobileBudDrag(event = null) {
        if (event && _mobileBudDrag.pointerId !== event.pointerId) return false;
        const s = window.drugTycoon;
        if (s?.grabbed === _mobileBudDrag.bud) s.grabbed = null;
        if (s?.touchGrabbed === _mobileBudDrag.bud) s.touchGrabbed = null;
        _mobileBudDrag.pointerId = null;
        _mobileBudDrag.bud = null;
        _mobileBudDrag.hasTarget = false;
        return true;
    }

    function installMobileBudDragEvents() {
        if (_mobileBudDragEventsInstalled) return;
        const canvas = core.renderer?.domElement;
        if (!canvas) return;
        _mobileBudDragEventsInstalled = true;

        canvas.addEventListener('pointerdown', (event) => {
            if (event.pointerType === 'mouse' || !isMobileBudDragContext()) return;
            const s = ensureState();
            const bud = pickTouchBud(event, s);
            if (!bud) return;
            event.preventDefault();
            event.stopPropagation();
            canvas.setPointerCapture?.(event.pointerId);
            _mobileBudDrag.pointerId = event.pointerId;
            _mobileBudDrag.bud = bud;
            s.grabbed = bud;
            s.touchGrabbed = bud;
            updateMobileBudDragTarget(event);
        }, { capture: true, passive: false });

        canvas.addEventListener('pointermove', (event) => {
            if (_mobileBudDrag.pointerId !== event.pointerId) return;
            event.preventDefault();
            event.stopPropagation();
            updateMobileBudDragTarget(event);
        }, { capture: true, passive: false });

        const end = (event) => {
            if (_mobileBudDrag.pointerId !== event.pointerId) return;
            event.preventDefault();
            event.stopPropagation();
            releaseMobileBudDrag(event);
        };
        canvas.addEventListener('pointerup', end, { capture: true, passive: false });
        canvas.addEventListener('pointercancel', end, { capture: true, passive: false });
        canvas.addEventListener('lostpointercapture', () => releaseMobileBudDrag(), { capture: true });
    }

    function updatePhysBagging(s, dt) {
        if (!physics?.ready || !physics.Jolt) return;
        const { Jolt, bodyInterface } = physics;
        const { camera } = core;
        processPendingBudReturns(s);

        // 1) Sync every bud mesh to its body.
        for (const bud of s.physBuds) {
            const p = bud.body.GetPosition();
            const q = bud.body.GetRotation();
            bud.mesh.position.set(p.GetX(), p.GetY(), p.GetZ());
            bud.mesh.quaternion.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
        }

        // 2) Grab handling. Hold Fire to grab the bud under the cursor; release
        //    to let go (velocity persists, so you can fling it).
        const touchDragging = _mobileBudDrag.pointerId !== null && s.grabbed === _mobileBudDrag.bud;
        const holding = touchDragging || !!gameplay.input?.fire;
        if (camera) {
            camera.getWorldPosition(_grabCamPos);
            camera.getWorldDirection(_grabCamDir).normalize();
        }
        if (holding && !s.grabbed && camera && !touchDragging) {
            // Pick nearest bud within range of the aim ray.
            let best = null, bestScore = -Infinity;
            for (const bud of s.physBuds) {
                _budPos.copy(bud.mesh.position).sub(_grabCamPos);
                const dist = _budPos.length();
                if (dist > BUD_GRAB_RANGE || dist < 0.001) continue;
                _budPos.multiplyScalar(1 / dist);
                const dot = _budPos.dot(_grabCamDir);
                if (dot < 0.9) continue;          // must be roughly under the cursor
                if (dot > bestScore) { bestScore = dot; best = bud; }
            }
            s.grabbed = best;
        } else if (!holding && s.grabbed) {
            s.grabbed = null;                     // released — keep current velocity
        }

        // 3) Drive the grabbed bud toward a point in front of the camera using
        //    velocity (so the throw carries momentum on release).
        if (s.grabbed && camera) {
            if (touchDragging && _mobileBudDrag.hasTarget) {
                _grabTarget.copy(_touchDragTarget);
            } else {
                _grabTarget.copy(_grabCamPos).addScaledVector(_grabCamDir, BUD_HOLD_DIST);
            }
            const p = s.grabbed.body.GetPosition();
            const inv = 1 / Math.max(dt, 1 / 120);
            const vx = (_grabTarget.x - p.GetX()) * inv;
            const vy = (_grabTarget.y - p.GetY()) * inv;
            const vz = (_grabTarget.z - p.GetZ()) * inv;
            const v = new Jolt.Vec3(
                Math.max(-12, Math.min(12, vx)),
                Math.max(-12, Math.min(12, vy)),
                Math.max(-12, Math.min(12, vz)),
            );
            bodyInterface.SetLinearVelocity(s.grabbed.body.GetID(), v);
            Jolt.destroy(v);
            bodyInterface.ActivateBody(s.grabbed.body.GetID());
        }

        // 4) Bag overlap: any bud whose centre is inside the bag zone is
        //    packaged into the sellable stash at full purity, then despawned.
        if (s.bagPos) {
            for (const bud of [...s.physBuds]) {
                const dx = Math.abs(bud.mesh.position.x - s.bagPos[0]);
                const dy = Math.abs(bud.mesh.position.y - s.bagPos[1]);
                const dz = Math.abs(bud.mesh.position.z - s.bagPos[2]);
                if (dx < BAG_HALF[0] && dy < BAG_HALF[1] && dz < BAG_HALF[2]) {
                    const room = stashCap(s) - s.stash;
                    const q = bud.q || 1;
                    if (room > 0) { blendStashQuality(s, 1, q); s.stash += 1; }
                    floatText(`+1 bagged ${Math.round(q * 100)}%`, new THREE.Vector3(...s.bagPos).setY(s.bagPos[1] + 0.6), '#9dffa0');
                    destroyPhysBud(s, bud);
                }
            }
        }

        // 5) Any bud that falls below the bench top returns to loose inventory after 30s.
        const layout = core.currentMesh?.userData?.drugTycoonLevel || {};
        const benchY = Array.isArray(layout.packagingBench) ? layout.packagingBench[1] : (s.bagPos?.[1] ?? 1.5) - 0.5;
        for (const bud of [...s.physBuds]) {
            if (bud.mesh.position.y < benchY - 0.35) {
                queuePhysBudReturn(s, bud);
            }
        }
    }

    // ---- packaging bench: drag buds into a bag -------------------------
    let _bagEl = null;
    function openBagging() {
        const s = ensureState();
        if (s.baggingOpen) return;
        if (s.buds <= 0) { showPrompt('No buds — harvest first'); return; }
        s.baggingOpen = true;
        gameplay.roguePaused = true;
        try { document.exitPointerLock?.(); } catch (e) {}
        renderBagging();
    }
    // Each bag holds BUDS_PER_BAG buds; a filled bag becomes 1 stash unit.
    const BUDS_PER_BAG = 4;
    function renderBagging() {
        const s = ensureState();
        if (_bagEl?.parentNode) _bagEl.remove();
        // bagFill = buds already dropped into the open bag this session.
        if (typeof s._bagFill !== 'number') s._bagFill = 0;
        if (typeof s._bagged !== 'number') s._bagged = 0;

        const overlay = document.createElement('div');
        overlay.className = 'tycoon-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:1200;pointer-events:auto;'
            + 'background:rgba(4,10,8,0.85);backdrop-filter:blur(3px);display:flex;'
            + 'flex-direction:column;align-items:center;justify-content:center;'
            + 'font-family:"Trebuchet MS",system-ui,sans-serif;color:#eaffea;';
        // Stop the panel's drag events from bubbling up to the canvas
        // file-drop handler (which would pop the "drop a .glb/.fbx" model-loader
        // alert). Bubble phase (no capture) so the bag's own drop handler still
        // runs first; we just halt propagation to the container afterwards.
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((ev) => {
            overlay.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); });
        });

        const title = document.createElement('div');
        title.textContent = 'PACKAGING';
        title.style.cssText = 'font:900 30px/1.1 inherit;margin-bottom:6px;color:#9dffa0;'
            + 'text-shadow:0 0 18px rgba(60,255,120,0.5);';
        overlay.appendChild(title);
        const hint = document.createElement('div');
        hint.textContent = `Drag buds into the bag — ${BUDS_PER_BAG} buds = 1 sellable unit.`;
        hint.style.cssText = 'font:600 15px/1.3 inherit;opacity:.8;margin-bottom:22px;';
        overlay.appendChild(hint);

        const cols = document.createElement('div');
        cols.style.cssText = 'display:flex;gap:60px;align-items:flex-start;';

        // Left: loose buds tray (draggable items).
        const tray = document.createElement('div');
        tray.style.cssText = 'width:300px;';
        const trayTitle = document.createElement('div');
        trayTitle.textContent = `Buds: ${s.buds}`;
        trayTitle.style.cssText = 'font:800 18px/1 inherit;margin-bottom:10px;color:#cffac0;';
        tray.appendChild(trayTitle);
        const grid = document.createElement('div');
        grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;max-width:300px;';
        const showBuds = Math.min(s.buds, 24);
        for (let i = 0; i < showBuds; i++) {
            const bud = document.createElement('div');
            bud.draggable = true;
            bud.textContent = '🌿';
            bud.style.cssText = 'width:42px;height:42px;display:flex;align-items:center;justify-content:center;'
                + 'font-size:24px;cursor:grab;border-radius:10px;background:rgba(60,120,50,0.35);'
                + 'border:2px solid rgba(150,255,140,0.4);user-select:none;';
            bud.addEventListener('dragstart', (e) => {
                e.dataTransfer?.setData('text/plain', 'bud');
                bud.style.opacity = '0.4';
            });
            bud.addEventListener('dragend', () => { bud.style.opacity = '1'; });
            // Touch / click fallback: tap a bud to drop it in the bag.
            bud.addEventListener('click', () => dropBudInBag());
            grid.appendChild(bud);
        }
        tray.appendChild(grid);
        cols.appendChild(tray);

        // Right: the bag (drop target) + fill meter.
        const bagWrap = document.createElement('div');
        bagWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:12px;';
        const bag = document.createElement('div');
        bag.textContent = '🛍️';
        bag.style.cssText = 'width:160px;height:160px;display:flex;align-items:center;justify-content:center;'
            + 'font-size:84px;border-radius:18px;background:rgba(20,40,28,0.7);'
            + 'border:3px dashed rgba(150,255,160,0.6);transition:transform .12s,border-color .12s;';
        bag.addEventListener('dragover', (e) => { e.preventDefault(); bag.style.borderColor = '#9dffa0'; bag.style.transform = 'scale(1.05)'; });
        bag.addEventListener('dragleave', () => { bag.style.borderColor = 'rgba(150,255,160,0.6)'; bag.style.transform = 'none'; });
        bag.addEventListener('drop', (e) => {
            e.preventDefault();
            bag.style.borderColor = 'rgba(150,255,160,0.6)'; bag.style.transform = 'none';
            dropBudInBag();
        });
        bagWrap.appendChild(bag);
        const meter = document.createElement('div');
        meter.style.cssText = 'width:200px;height:18px;border-radius:9px;overflow:hidden;'
            + 'background:rgba(255,255,255,0.12);border:1px solid rgba(150,255,160,0.4);';
        const fill = document.createElement('div');
        fill.style.cssText = `height:100%;width:${(s._bagFill / BUDS_PER_BAG) * 100}%;`
            + 'background:linear-gradient(90deg,#3fbf5f,#9dffa0);transition:width .15s;';
        meter.appendChild(fill);
        bagWrap.appendChild(meter);
        const bagLbl = document.createElement('div');
        bagLbl.textContent = `Bag ${s._bagFill}/${BUDS_PER_BAG} · packaged ${s._bagged}`;
        bagLbl.style.cssText = 'font:700 14px/1 inherit;opacity:.85;';
        bagWrap.appendChild(bagLbl);
        cols.appendChild(bagWrap);
        overlay.appendChild(cols);

        // Done button: commit packaged bags into stash + close.
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:14px;margin-top:28px;';
        const done = document.createElement('button');
        done.textContent = 'DONE';
        done.style.cssText = 'padding:12px 30px;cursor:pointer;font:900 18px/1 inherit;color:#0a140e;'
            + 'border-radius:12px;background:linear-gradient(160deg,#9dffa0,#3fbf5f);'
            + 'border:2px solid rgba(0,0,0,0.25);';
        done.onclick = () => closeBagging();
        actions.appendChild(done);
        overlay.appendChild(actions);

        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        _bagEl = overlay;
    }
    function dropBudInBag() {
        const s = ensureState();
        if (s.buds <= 0) return;
        const q = consumeBudQuality(s, 1);
        s._bagFill = (s._bagFill || 0) + 1;
        s._bagFillQ = (s._bagFillQ || 0) + q;
        if (s._bagFill >= BUDS_PER_BAG) {
            const bagQ = (s._bagFillQ || BUDS_PER_BAG) / BUDS_PER_BAG;
            const prev = s._bagged || 0;
            s._bagFill = 0;
            s._bagFillQ = 0;
            s._bagged = prev + 1;
            s._baggedQ = ((prev * (s._baggedQ || 1)) + bagQ) / s._bagged;
        }
        renderBagging();
    }
    function closeBagging() {
        const s = window.drugTycoon;
        if (_bagEl?.parentNode) _bagEl.remove();
        _bagEl = null;
        if (s) {
            if ((s._bagFill || 0) > 0) {
                blendBudQuality(s, s._bagFill, (s._bagFillQ || s._bagFill) / s._bagFill);
                s.buds += s._bagFill;
            }
            // Commit fully-packaged bags into the sellable stash.
            const room = stashCap(s) - s.stash;
            const added = Math.min(room, s._bagged || 0);
            if (added > 0) { blendStashQuality(s, added, s._baggedQ || 1); s.stash += added; }
            s._bagFill = 0;
            s._bagFillQ = 0;
            s._bagged = 0;
            s._baggedQ = 1;
            s.baggingOpen = false;
        }
        gameplay.roguePaused = false;
        const { renderer } = core;
        if (renderer?.domElement && !window.matchMedia?.('(pointer:coarse)')?.matches) {
            const resume = () => {
                renderer.domElement.removeEventListener('click', resume);
                try { renderer.domElement.requestPointerLock?.(); } catch (e) {}
            };
            renderer.domElement.addEventListener('click', resume);
        }
    }

    // ---- per-frame driver ----------------------------------------------
    function updateDrugTycoonState(playerPos, delta = 0.016) {
        const { currentMesh } = core;
        if (currentMesh?.userData?.sampleType !== 'drugTycoon') return;
        if (gameplay.active) tickPlaytime('drugTycoon', delta);
        installMobileBudDragEvents();
        installInteractKey();
        const s = ensureState();
        // Yaw-only billboards (shop signs / cook label). Cached on the level
        // mesh on first run, then a cheap loop each frame. Rotation is pure
        // atan2 of camera→object on the XZ plane — no pitch, signs stay level.
        tickLevelBillboards(currentMesh);
        // Cumulative milestone awards — cheap polled checks.
        if (s.cash >= 1000) award('cash1k');
        if (s.cash >= 10000) award('cash10k');
        if (s.cash >= 100000) award('cash100k');
        if ((s._budsHarvested | 0) >= 50) award('buds50');
        if (repTier(s).name === 'Legend') award('legend');
        if ((s.dayNum || 1) >= 8) award('survive7');   // started day 8 = survived 7
        processPendingBudReturns(s);
        maybeAutosave();   // throttled progress save (cash/upgrades/etc → localStorage)
        const layout = currentMesh.userData.drugTycoonLevel || {};
        const dt = Math.min(0.05, Math.max(0.001, delta));

        // Drive any active ragdolls (Jolt-synced + the non-physics fallback)
        // every frame regardless of pause so they finish their fall + expire.
        ragdoll.update();
        ragdoll.updateFallback(dt);

        // First-time setup once the player exists.
        if (!s.started && playerPos) {
            s.started = true;
            if (Array.isArray(layout.cookStation)) s.cookPos.set(...layout.cookStation);
            if (Array.isArray(layout.upgradePad)) s.upgradePos.set(...layout.upgradePad);
            if (Array.isArray(layout.pillLab)) { s.pillLabPos ||= new THREE.Vector3(); s.pillLabPos.set(...layout.pillLab); }
            if (Array.isArray(layout.cokeLab)) { s.cokeLabPos ||= new THREE.Vector3(); s.cokeLabPos.set(...layout.cokeLab); }
            if (Array.isArray(layout.methLab)) { s.methLabPos ||= new THREE.Vector3(); s.methLabPos.set(...layout.methLab); }
            if (Array.isArray(layout.lsdLab)) { s.lsdLabPos ||= new THREE.Vector3(); s.lsdLabPos.set(...layout.lsdLab); }
            if (Array.isArray(layout.shroomLab)) { s.shroomLabPos ||= new THREE.Vector3(); s.shroomLabPos.set(...layout.shroomLab); }
            if (Array.isArray(layout.seedShop)) s.seedPos.set(...layout.seedShop);
            if (Array.isArray(layout.juiceShop)) s.juicePos.set(...layout.juiceShop);
            // The pistol is bought at the upgrade desk now — no free yard pickup.
            ensurePlants(s, layout);
            ensurePlayerCar(s, layout);   // drivable car parked behind the house
            const target = maxBuyers(s);
            for (let i = 0; i < target; i++) spawnBuyer(s, layout);
            pickOrder(s);   // first phone order, from a live buyer
            sendPlayerHome(s);   // start the run inside the house
        }

        updateTracers();
        updateMuzzleFlash();
        updateCopFlashes();
        setPlantsVisible(s, s.inRoom);
        updatePlants(s, s.inRoom);
        advanceDayNight(s, dt);   // sun/sky animate even in menus / grow room
        processShrooms(s, dt);

        if (s.summaryOpen || s.shopOpen || s.seedShopOpen || s.juiceShopOpen || s.shroomPanelOpen || s.cooking || s.pillGame || s.baggingOpen || s.helpOpen) { stopSiren(); if (s.phoneOpen) setPhone(false); if (_compassEl) _compassEl.style.display = 'none'; updateHud(); return; } // sim frozen in a menu
        if (!playerPos) return;
        processRandomEvents(s, layout);
        processBounties(s);
        processDelivery(s, playerPos);   // long-distance car drop-off (uses car pos while driving)
        // Auto-offer a delivery when none is active and the cooldown has passed
        // (only once you have a car + some product worth driving out).
        if (!s.delivery && s._carActor) {
            const now = performance.now?.() || Date.now();
            if (!s.nextDeliveryAt) scheduleNextDelivery(s);
            else if (now >= s.nextDeliveryAt && unlockedProducts(s).some((k) => prodQty(s, k) > 0)) offerDelivery(s);
        }

        // Buyers tick regardless of where the player is — shop visitors keep
        // walking to the counter while you're inside, and street wanderers
        // keep moving when you're outside.
        tickBuyers(s, layout, playerPos, dt);

        // Stream neighbourhood chunks in/out as the player roams the street.
        // The grow room is off-map, so drop all streamed chunks while indoors.
        if (_mapStreaming) {
            if (s.inRoom) _mapStreaming.clear();
            else _mapStreaming.update(playerPos, dt);
        }

        // ---- inside the grow room: separate interaction set ------------
        if (s.inRoom) {
            stopSiren();                        // no sirens audible indoors
            if (s.phoneOpen) setPhone(false);   // pocket the phone indoors
            if (_compassEl) _compassEl.style.display = 'none';
            // Crew work the streets — hide them (and pause their sale timers)
            // while the player is in the off-map grow room.
            for (const c of s.crew || []) {
                if (!c.mesh) continue;
                c.mesh.visible = false;
                c.nextSaleAt = Math.max(c.nextSaleAt, (performance.now?.() || Date.now()) + 1000);
            }
            const interactR = consumeInteract();
            let promptR = '';
            // Bag + physics buds live + tick every frame so thrown buds keep
            // flying and grabbed ones follow the cursor even mid-room.
            ensureBag(s, layout);
            updatePhysBagging(s, dt);
            animatePests(s);
            // Harvest the nearest ripe plant.
            let bestPlant = null, bestPd = 2.4;
            for (const p of s.plants) {
                if (!p.mesh) continue;
                const d = Math.hypot(p.mesh.position.x - playerPos.x, p.mesh.position.z - playerPos.z);
                if (d < bestPd) { bestPd = d; bestPlant = p; }
            }
            // Hold Fire next to an infested plant to spray the pests off it.
            if (gameplay.input?.fire && bestPlant?.pest) sprayPlant(s, bestPlant);
            // Otherwise — hold Fire near a growing, non-pest, non-boosted plant
            // to pour the currently-selected grow juice on it.
            else if (gameplay.input?.fire
                && bestPlant?.planted && bestPlant?.watered
                && (bestPlant.progress ?? 0) < 1
                && (bestPlant.juiceMult || 1) <= 1
                && pickJuiceTier(s) >= 0) {
                const now = performance.now?.() || Date.now();
                if (now >= (bestPlant.nextPourAt || 0)) {
                    bestPlant.nextPourAt = now + 700;
                    pourJuice(s, bestPlant);
                }
            }
            const bench = layout.packagingBench;
            const dBench = Array.isArray(bench)
                ? Math.hypot(bench[0] - playerPos.x, bench[2] - playerPos.z) : Infinity;
            const exit = layout.growExitDoor;
            const dExit = Array.isArray(exit)
                ? Math.hypot(exit[0] - playerPos.x, exit[2] - playerPos.z) : Infinity;
            const bed = layout.bed;
            const dBed = Array.isArray(bed)
                ? Math.hypot(bed[0] - playerPos.x, bed[2] - playerPos.z) : Infinity;
            const upg = layout.upgradePad;
            const dUpgR = Array.isArray(upg)
                ? Math.hypot(upg[0] - playerPos.x, upg[2] - playerPos.z) : Infinity;
            const pill = layout.pillLab;
            const dPill = Array.isArray(pill)
                ? Math.hypot(pill[0] - playerPos.x, pill[2] - playerPos.z) : Infinity;
            const coke = layout.cokeLab;
            const dCoke = Array.isArray(coke)
                ? Math.hypot(coke[0] - playerPos.x, coke[2] - playerPos.z) : Infinity;
            const methL = layout.methLab;
            const dMeth = Array.isArray(methL)
                ? Math.hypot(methL[0] - playerPos.x, methL[2] - playerPos.z) : Infinity;
            const lsdL = layout.lsdLab;
            const dLsd = Array.isArray(lsdL)
                ? Math.hypot(lsdL[0] - playerPos.x, lsdL[2] - playerPos.z) : Infinity;
            const shroomL = layout.shroomLab;
            const dShroom = Array.isArray(shroomL)
                ? Math.hypot(shroomL[0] - playerPos.x, shroomL[2] - playerPos.z) : Infinity;
            const shroomTap = layout.shroomTap;
            const dShroomTap = Array.isArray(shroomTap)
                ? Math.hypot(shroomTap[0] - playerPos.x, shroomTap[2] - playerPos.z) : Infinity;
            const shroomAc = layout.shroomAc;
            const dShroomAc = Array.isArray(shroomAc)
                ? Math.hypot(shroomAc[0] - playerPos.x, shroomAc[2] - playerPos.z) : Infinity;
            const shroomRack = layout.shroomRack;
            const dShroomRack = Array.isArray(shroomRack)
                ? Math.hypot(shroomRack[0] - playerPos.x, shroomRack[2] - playerPos.z) : Infinity;

            // Sell to a customer who walked into the shop and queued at the
            // counter. Same rules as the street sell — must match the phone
            // order's shirt colour. Reads from the live npc list, only those
            // whose `where === 'inside'` are physically here.
            let bestInsideBuyer = null, bestInsideD = SELL_RADIUS;
            for (const n of s.npcs) {
                if (!n.mesh || !n.wantsBuy || n.where !== 'inside') continue;
                const d = Math.hypot(n.mesh.position.x - playerPos.x, n.mesh.position.z - playerPos.z);
                if (d < bestInsideD) { bestInsideD = d; bestInsideBuyer = n; }
            }
            if (dExit < DOOR_RADIUS) {
                promptR = '[E] Leave house';
                if (interactR && Array.isArray(layout.homeDoor)) {
                    s.inRoom = false;
                    teleportPlayer([layout.homeDoor[0], layout.homeDoor[1], layout.homeDoor[2]]);
                }
            } else if (bestInsideBuyer) {
                ensureOrder(s);
                let pk = s.sellProduct;
                if (prodQty(s, pk) <= 0) { pk = unlockedProducts(s).find((k) => prodQty(s, k) > 0) || pk; s.sellProduct = pk; }
                const pdef = PRODUCTS[pk];
                const isOrder = bestInsideBuyer.shirtColor === s.orderColor;
                const narcTell = bestInsideBuyer.isNarc && bestInsideD < NARC_TELL_RADIUS;
                const hot = !!s.hotColor && bestInsideBuyer.shirtColor === s.hotColor;
                if (prodQty(s, pk) <= 0) {
                    promptR = 'No product — go cook';
                } else if (narcTell) {
                    promptR = '⚠ Twitchy customer… looks like a setup. [E] risk it';
                    if (interactR) sellTo(s, bestInsideBuyer);
                } else if (!isOrder) {
                    promptR = `Wrong customer — check phone [P] (want ${colorName(s.orderColor)})`;
                } else {
                    const cm = comboMult(s);
                    const tag = `${hot ? '🔥 ' : ''}~$${(unitPrice(s, prodQual(s, pk), hot, pk) * (1 + s.up.batch) * cm) | 0}`;
                    const swap = unlockedProducts(s).length > 1 ? ' [Q] switch' : '';
                    promptR = `[E] Serve ${pdef.emoji}${pdef.name} to ${colorName(bestInsideBuyer.shirtColor)} · ${tag}${cm > 1 ? ` (x${cm.toFixed(2).replace(/0$/, '')})` : ''}${swap}`;
                    if (interactR) sellTo(s, bestInsideBuyer);
                }
            } else if (dPill < 2.8) {
                if (!productUnlocked(s, 'pills')) {
                    promptR = '💊 Pill lab — buy a Pill Press at the desk to use';
                } else if (prodQty(s, 'pills') >= prodCap(s, 'pills')) {
                    promptR = 'Pill stash full — go sell';
                } else {
                    promptR = '💊 [E] Press pills';
                    if (interactR) openPillLab('pills');
                }
            } else if (dCoke < 2.8) {
                if (!productUnlocked(s, 'coke')) {
                    promptR = '❄️ Coke lab — buy a Coke Lab at the desk to use';
                } else if ((s.cocaLeaves || 0) < cokeLeavesNeeded(s)) {
                    promptR = `❄️ Need ${cokeLeavesNeeded(s)} coca leaves — grow Coca Seeds`;
                } else if (prodQty(s, 'coke') >= prodCap(s, 'coke')) {
                    promptR = 'Coke stash full — go sell';
                } else {
                    promptR = '❄️ [E] Cook coke';
                    if (interactR) openPillLab('coke');
                }
            } else if (dMeth < 2.8) {
                if (!productUnlocked(s, 'meth')) {
                    promptR = '💎 Meth lab — buy a Meth Lab at the desk to use';
                } else if (prodQty(s, 'meth') >= prodCap(s, 'meth')) {
                    promptR = 'Meth stash full — go sell';
                } else {
                    promptR = '💎 [E] Cook meth';
                    if (interactR) openPillLab('meth');
                }
            } else if (dLsd < 2.8) {
                if (!productUnlocked(s, 'lsd')) {
                    promptR = '🌈 LSD lab — buy an LSD Lab at the desk to use';
                } else if (prodQty(s, 'lsd') >= prodCap(s, 'lsd')) {
                    promptR = 'LSD stash full — go sell';
                } else {
                    promptR = '🌈 [E] Make LSD';
                    if (interactR) openPillLab('lsd');
                }
            } else if (dShroomTap < 2.3) {
                promptR = handleSprayTap(s, interactR);
            } else if (dShroomAc < 2.3) {
                promptR = handleShroomAc(s, interactR);
            } else if (dShroomRack < 2.8) {
                promptR = handleShroomRack(s, interactR);
            } else if (dShroom < 2.8) {
                if (prodQty(s, 'shrooms') >= prodCap(s, 'shrooms')) {
                    promptR = 'Shroom stash full — go sell';
                } else {
                    promptR = handleShroomBed(s, interactR);
                }
            } else if (dBed < 2.4) {
                promptR = '[E] Sleep until morning';
                if (interactR) sleepInBed(s);
            } else if (dUpgR < 2.6) {
                promptR = '[E] Open upgrades';
                if (interactR) openShop();
            } else if (dBench < 5.0) {
                // Drop a physics bud on the bench; hold Fire to drag it across
                // into the bag. Any bud reaching the bag is packaged.
                if (s.buds > 0) {
                    promptR = `[E] Drop a bud (${s.buds}) · touch/drag into bag`;
                    if (interactR) spawnPhysBud(s, layout);
                } else if (s.physBuds.length > 0) {
                    promptR = 'Drag buds into the bag';
                } else {
                    promptR = 'Harvest buds first';
                }
            } else if (bestPlant) {
                promptR = plantPrompt(s, bestPlant, interactR);
            }
            if (promptR) showPrompt(promptR); else hidePrompt();
            updateHud();
            return;
        }

        // Attack on Fire (left mouse): pistol if owned + loaded, else swing the
        // bat if owned. Each has its own cooldown.
        if (gameplay.input?.fire) {
            if (s.hasGun && s.ammo > 0) tryShoot(s, layout);
            else if (s.hasBat) trySwingBat(s, layout);
            else if (s.hasGun) tryShoot(s, layout);   // dry-click feedback
        }

        // Heat decays passively.
        if (s.heat > 0) s.heat = Math.max(0, s.heat - HEAT_DECAY_PER_SEC * dt);

        // (buyer spawn/move logic moved into tickBuyers, called earlier)
        updateRivals(s, layout, playerPos, dt);
        ensureCrewMeshes(s, layout);   // rebuild hired dealers from a save
        updateCrew(s, layout, dt);     // crew roam + auto-sell your stash

        // Night patrol cops: spawn + wander the streets after dark, chase on
        // sight (or when heat is already high).
        updatePatrol(s, layout, playerPos, dt);

        // Police: count + chase speed scale with the wanted-star level.
        const stars = wantedStars(s);
        if (stars >= 1) {
            const wantCops = copsForStars(stars);
            while (s.police.length < wantCops) spawnPolice(s, layout);
            const chaseSpeed = chaseSpeedForStars(stars);
            const weapon = copWeaponForStars(stars);   // null / 'tazer' / 'gun'
            const playerVec = _tmpProj.set(playerPos.x, layout.spawnY ?? 0, playerPos.z);
            for (const cop of s.police) {
                if (!cop.mesh) continue;
                const cd = Math.hypot(cop.mesh.position.x - playerPos.x, cop.mesh.position.z - playerPos.z);
                // Armed cops hold their ground at firing range and shoot; once
                // in firing range they stop closing so they keep peppering you.
                const wpnRange = weapon === 'gun' ? COP_GUN_RANGE : weapon === 'tazer' ? COP_TAZER_RANGE : 0;
                const inFiringRange = weapon && cd <= wpnRange && cd > COP_FIRE_MIN_RANGE;
                if (inFiringRange) {
                    // Face the player but hold position; take shots on cooldown.
                    cop.mesh.rotation.y = Math.atan2(playerPos.x - cop.mesh.position.x, playerPos.z - cop.mesh.position.z);
                    animateWalk(cop.mesh, 0, dt);
                    copFireAt(s, cop, weapon, playerPos);
                } else {
                    moveToward(cop.mesh, playerVec, chaseSpeed, dt, layout);
                }
                if (cd < BUST_RADIUS) { bustPlayer(s, cop); }
            }
        } else {
            // Calmed down (0 stars): police give up + leave.
            for (const cop of s.police) { try { core.scene?.remove(cop.mesh); } catch (e) {} }
            s.police.length = 0;
        }

        // Police siren swells as the nearest cop closes in.
        updateSiren(s, playerPos);

        // Keep the open phone's order in sync with the live buyers.
        if (s.phoneOpen) { ensureOrder(s); renderPhone(); }

        // Proximity-driven interactions: nearest of cook/upgrade/buyer.
        const interact = consumeInteract();
        let prompt = '';

        // Cook station.
        const dCook = s.cookPos.distanceTo(_tmpProj.set(playerPos.x, s.cookPos.y, playerPos.z));

        // Home door: enter the grow room.
        const home = layout.homeDoor;
        const dHome = Array.isArray(home)
            ? Math.hypot(home[0] - playerPos.x, home[2] - playerPos.z) : Infinity;

        // Outdoor seed shop.
        const dSeed = layout.seedShop
            ? Math.hypot(s.seedPos.x - playerPos.x, s.seedPos.z - playerPos.z) : Infinity;
        // Outdoor grow-juice shop.
        const dJuice = layout.juiceShop
            ? Math.hypot(s.juicePos.x - playerPos.x, s.juicePos.z - playerPos.z) : Infinity;

        if (dHome < DOOR_RADIUS) {
            prompt = '[E] Enter house (grow room)';
            if (interact && Array.isArray(layout.growRoomSpawn)) {
                s.inRoom = true;
                teleportPlayer([...layout.growRoomSpawn]);
                hidePrompt();
                updateHud();
                return;
            }
        } else if (dSeed < SEED_PAD_RADIUS) {
            const owned = totalSeeds(s);
            prompt = `🌱 [E] Seed shop${owned > 0 ? ` (${owned} seeds)` : ' — buy seeds to grow'}`;
            if (interact) openSeedShop();
        } else if (dJuice < JUICE_PAD_RADIUS) {
            const owned = totalJuices(s);
            prompt = `🧪 [E] Grow juice${owned > 0 ? ` (${owned} bottles)` : ' — boost plant grow speed'}`;
            if (interact) openJuiceShop();
        } else if (dCook < STATION_RADIUS) {
            const cookable = cookableProducts(s);
            if (cookable.length === 0) {
                // Weed is grown; pills + coke are now made indoors at their own
                // lab benches. Nothing to do at the outdoor bench anymore.
                prompt = 'Product is made indoors — 💊 pills + ❄️ coke at the home labs';
            } else if (!cookable.some((k) => prodQty(s, k) < prodCap(s, k))) {
                prompt = 'Stash full — go sell';
            } else {
                const names = cookable.map((k) => PRODUCTS[k].emoji + PRODUCTS[k].name).join('/');
                prompt = `[E] Cook ${names}`;
                if (interact) openCook();
            }
        } else {
            // Find nearest buyer in range.
            let best = null, bestD = SELL_RADIUS;
            for (const n of s.npcs) {
                if (!n.mesh || !n.wantsBuy) continue;
                const d = Math.hypot(n.mesh.position.x - playerPos.x, n.mesh.position.z - playerPos.z);
                if (d < bestD) { bestD = d; best = n; }
            }
            if (best) {
                ensureOrder(s);
                // Deal the currently-selected line; auto-fall-back to any line
                // you're actually holding so [Q] isn't mandatory.
                let pk = s.sellProduct;
                if (prodQty(s, pk) <= 0) { pk = unlockedProducts(s).find((k) => prodQty(s, k) > 0) || pk; s.sellProduct = pk; }
                const pdef = PRODUCTS[pk];
                const qHold = prodQual(s, pk);
                const isOrder = best.shirtColor === s.orderColor;
                // Narc tell: within range they act shifty — warn the player.
                const narcTell = best.isNarc && bestD < NARC_TELL_RADIUS;
                const hot = !!s.hotColor && best.shirtColor === s.hotColor;
                const hireable = canHireBuyer(s, best);
                if (narcTell) {
                    prompt = '⚠ This one keeps glancing around… looks like a setup. [E] risk it';
                    if (interact) sellTo(s, best);
                } else if (isOrder && prodQty(s, pk) > 0) {
                    const cm = comboMult(s);
                    const tag = `${hot ? '🔥 ' : ''}~$${(unitPrice(s, qHold, hot, pk) * (1 + s.up.batch) * cm) | 0}`;
                    const swap = unlockedProducts(s).length > 1 ? ' [Q] switch' : '';
                    prompt = `[E] Deal ${pdef.emoji}${pdef.name} to ${colorName(best.shirtColor)} · ${tag}${cm > 1 ? ` (x${cm.toFixed(2).replace(/0$/, '')})` : ''}${swap}`;
                    if (interact) sellTo(s, best);
                } else if (hireable) {
                    // A maxed-loyalty VIP you can put on payroll. (Only offered
                    // when you're not mid-deal with them on an order.)
                    prompt = `★ VIP ${colorName(best.shirtColor)} — [E] hire as dealer ($${CREW_HIRE_COST.toLocaleString()}) · ${s.crew.length}/${CREW_MAX}`;
                    if (interact) hireBuyer(s, layout, best);
                } else if (prodQty(s, pk) <= 0) {
                    prompt = 'No product — go cook';
                } else if (!isOrder) {
                    prompt = `Wrong customer — check phone [P] (want ${colorName(s.orderColor)})`;
                }
            }
        }

        if (prompt) showPrompt(prompt); else hidePrompt();
        updateCompass(s, playerPos);
        updateHud();
    }

    function sellTo(s, npc) {
        const wp = npc.mesh ? npc.mesh.getWorldPosition(new THREE.Vector3()) : null;

        // ---- narc: it's a sting. No cash, heat slammed, combo broken. -----
        if (npc.isNarc) {
            s.heat = Math.min(160, s.heat + NARC_HEAT);
            s.combo = 0; s.comboUntil = 0;
            s.today.narcs += 1;
            changeRep(s, -REP_LOSS_NARC, wp);
            if (wp) {
                floatText('🚨 SETUP! Undercover cop', wp.clone().setY(wp.y + 2.1), '#ff5555');
                floatText('+heat', wp.clone(), '#ff7070');
                playSfx('hit', wp.clone());
            }
            try { core.scene?.remove(npc.mesh); } catch (e) {}
            const ix = s.npcs.indexOf(npc);
            if (ix >= 0) s.npcs.splice(ix, 1);
            pickOrder(s);
            if (s.phoneOpen) renderPhone();
            saveProgress();
            return;
        }

        // Deal the selected line; fall back to anything in stock.
        let pk = s.sellProduct;
        if (prodQty(s, pk) <= 0) pk = unlockedProducts(s).find((k) => prodQty(s, k) > 0) || pk;
        s.sellProduct = pk;
        const pdef = PRODUCTS[pk];
        const sellQty = Math.min(prodQty(s, pk), 1 + s.up.batch); // sell a small bundle
        if (sellQty <= 0) return;
        const soldQ = prodQual(s, pk);
        const soldGrade = qualityGrade(soldQ);
        takeProduct(s, pk, sellQty);

        // ---- combo: chained quick deals stack a cash multiplier ----------
        const now = performance.now?.() || Date.now();
        s.combo = comboActive(s) ? s.combo + 1 : 1;
        s.comboUntil = now + COMBO_WINDOW_MS;
        const cm = comboMult(s);

        // ---- customer loyalty: this colour's regular relationship --------
        const isTrash = soldQ < 0.35;
        const loyTierBefore = loyaltyTierOf(s, npc.shirtColor);
        const loyResult = bumpLoyalty(s, npc.shirtColor, sellQty, isTrash);
        if ((s.loyalty?.[npc.shirtColor]?.tier || 0) >= LOYALTY_TIERS.length - 1) award('vipCustomer');
        // Use the higher of before/after multiplier so a fresh promotion still
        // rewards this sale, but a betrayal doesn't retroactively overpay.
        const loyMult = isTrash ? 1 : Math.max(loyTierBefore.mult, loyResult.tier.mult);

        // ---- market + hot-colour pricing ---------------------------------
        const hot = !!s.hotColor && npc.shirtColor === s.hotColor;
        const gross = Math.round(sellQty * unitPrice(s, soldQ, hot, pk, loyMult) * cm);
        s.cash += gross;
        s.sales += 1;
        s.heat = Math.min(160, s.heat + heatPerSale(s, soldQ, pk));
        // day summary tallies
        s.today.earned += gross;
        s.today.units += sellQty;
        s.today.sales += 1;
        if (cm > s.today.bestCombo) s.today.bestCombo = cm;
        award('firstSale');
        if (cm >= COMBO_MAX) award('combo5');
        // Selling to the hot customer cools that demand slightly (you flooded it).
        if (hot) {
            s.demand = Math.max(MARKET_MIN, s.demand - HOT_SELL_DROP);
            award('hotSale');
        }

        // ---- reputation: quality-weighted rep change ---------------------
        // Trash product gives a small loss (you sold garbage, people remember).
        // Everything from Shake up gives a positive bump scaled by quality and
        // by quantity sold. Hot-buyer and ≥3 combo deals each add a flat bonus.
        let repDelta;
        if (isTrash) {
            repDelta = -REP_LOSS_TRASH;
            // Betraying a regular hurts more — they badmouth you (extra rep hit
            // + heat as word spreads). Anonymous nobodies just shrug.
            if (loyResult.angered) {
                repDelta -= REP_LOSS_TRASH;
                s.heat = Math.min(160, s.heat + LOYALTY_TRASH_HEAT);
            }
        } else {
            repDelta = sellQty * (REP_GAIN_BASE + soldQ * REP_GAIN_QUALITY);
            if (hot) repDelta += REP_GAIN_HOT;
            if (s.combo >= 3) repDelta += REP_GAIN_COMBO;
            repDelta += loyResult.tier.repBonus;       // loyal customers build rep faster
        }
        changeRep(s, repDelta, wp);

        if (wp) {
            floatText(`${pdef.emoji} +$${gross.toLocaleString()}`, wp.clone(), hot ? '#ffe066' : pdef.color);
            floatText(`${pdef.name} · ${soldGrade.name}`, wp.clone().setY(wp.y + 1.2), soldGrade.color);
            if (cm > 1) floatText(`COMBO x${cm.toFixed(2).replace(/0$/, '')}`, wp.clone().setY(wp.y + 2.5), '#7fd0ff');
            if (hot) floatText('🔥 HOT BUYER', wp.clone().setY(wp.y + 1.6), '#ffe066');
            else {
                const line = SELL_THANKS[(Math.random() * SELL_THANKS.length) | 0];
                floatText(line, wp.clone().setY(wp.y + 2.0), '#cfe8ff');
            }
            // Loyalty feedback: promotion, betrayal, or a standing-regular nod.
            if (loyResult.angered) {
                floatText('😠 REGULAR BURNED', wp.clone().setY(wp.y + 3.0), '#ff5555');
            } else if (loyResult.promoted) {
                floatText(`${loyResult.tier.badge} ${loyResult.tier.name.toUpperCase()} CUSTOMER`, wp.clone().setY(wp.y + 3.0), loyResult.tier.color);
            } else if (loyResult.tier.mult > 1) {
                floatText(`${loyResult.tier.badge} ${loyResult.tier.name} +${Math.round((loyResult.tier.mult - 1) * 100)}%`, wp.clone().setY(wp.y + 3.0), loyResult.tier.color);
            }
            playSfx('cash', wp.clone());     // cha-ching
            cashBurst(wp.clone().setY(wp.y + 1.0), Math.min(14, 4 + sellQty * 2 + Math.round(cm * 2)), hot ? '#ffe066' : '#9dffa0');
        }
        // Combo callout + a satisfying camera kick that grows with the streak.
        if (cm > 1) {
            const tier = cm >= COMBO_MAX ? 'MAX COMBO!' : s.combo >= 4 ? 'BIG COMBO!' : 'COMBO!';
            bigPopup(`${tier} x${cm.toFixed(2).replace(/0$/, '')}`, cm >= COMBO_MAX ? '#ffe066' : '#7fd0ff', Math.min(1.6, 0.9 + cm * 0.18));
            playSfx('ding', null, Math.min(0.9, 0.4 + cm * 0.15));
            if (gameplay.hitFeedback) gameplay.hitFeedback.shake = Math.max(gameplay.hitFeedback.shake || 0, 0.12 + cm * 0.05);
        }

        // ---- big-order bounty progress -----------------------------------
        progressBounty(s, pk, npc.shirtColor, sellQty, wp);

        // Buyer leaves, a fresh one wanders in.
        try { core.scene?.remove(npc.mesh); } catch (e) {}
        const idx = s.npcs.indexOf(npc);
        if (idx >= 0) s.npcs.splice(idx, 1);
        // Order fulfilled — line up the next one and refresh the phone.
        s.ordersFilled += 1;
        pickOrder(s);
        if (s.phoneOpen) renderPhone();
        saveProgress();   // persist after a sale
    }

    function bustPlayer(s, cop) {
        const fine = Math.min(s.cash, BUST_FINE);
        s.cash -= fine;
        // Lose ALL product you're holding: every product line, loose buds, and
        // any physics buds out on the bench.
        s.stash = 0;
        s.stashQ = 1;
        if (s.prod) { for (const k of SIDE_PRODUCT_KEYS) s.prod[k] = { qty: 0, q: 1 }; }
        s.buds = 0;
        s.budsQ = 1;
        s.cocaLeaves = 0;
        s.cocaLeavesQ = 1;
        s.wetShrooms = 0;
        s.wetShroomsQ = 1;
        s.shroomDrying = null;
        try { clearPhysBuds(s); } catch (e) {}
        s.heat = 0;           // heat resets after a bust
        s.busted += 1;
        s.today.busts += 1;
        s.today.spent += fine;
        const cp = cop?.mesh ? cop.mesh.getWorldPosition(new THREE.Vector3()) : null;
        changeRep(s, -REP_LOSS_BUST, cp);
        if (cp) {
            floatText(`BUSTED -$${fine} · lost stash`, cp.clone().setY(cp.y + 1.9), '#ff5555');
        }
        bigPopup('🚨 BUSTED', '#ff4444', 1.5);
        playSfx('hit', cp ? cp.clone() : null, 0.8);
        if (gameplay.hitFeedback) gameplay.hitFeedback.shake = Math.max(gameplay.hitFeedback.shake || 0, 0.6);
        // Light health knock so it stings; never lethal.
        try { setPlayerHealth(Math.max(0.35, (gameplay.health ?? 1) - 0.25)); } catch (e) {}
        // Ragdoll every cop on the scene (heat cops + night patrol) — you barge
        // through them. Shove each away from the player so they tumble outward.
        for (const c of [...s.police, ...s.patrol]) {
            if (!c.mesh) continue;
            // Shove outward from arena center so cops tumble away.
            const px = c.mesh.position.x, pz = c.mesh.position.z;
            const len = Math.hypot(px, pz) || 1;
            ragdoll.ragdollify(c.mesh, { x: (px / len) * 6, y: 3, z: (pz / len) * 6 });
        }
        s.police.length = 0;
        s.patrol.length = 0;

        // Released the next morning, back home (inside the house). Skip time to
        // just after dawn so it's daytime + safe.
        s.timeOfDay = 0.02;
        if (s.phoneOpen) setPhone(false);
        sendPlayerHome(s);
        showPrompt('Busted. Released the next morning — home, stash gone.');
        saveProgress();   // persist after a bust
    }

    // Put the player inside their house (the grow room) and reset room lighting
    // to day. Used on bust and at the start of a run.
    function sendPlayerHome(s) {
        const layout = core.currentMesh?.userData?.drugTycoonLevel || {};
        const spawn = Array.isArray(layout.growRoomSpawn) ? layout.growRoomSpawn
            : (Array.isArray(layout.playerSpawn) ? layout.playerSpawn : null);
        if (!spawn) return;
        s.inRoom = true;
        teleportPlayer([spawn[0], spawn[1] ?? 0.85, spawn[2]]);
        _roomNightState = false;
        try { applyRoomLighting(false); } catch (e) {}
    }

    // ---- window surface -------------------------------------------------
    if (typeof window !== 'undefined') {
        window.drugTycoonApi = {
            ensureState, resetState, updateDrugTycoonState, openCook, closeCook, openShop, closeShop, openBagging, closeBagging, togglePhone, toggleHelp, queueInteract, cycleSellProduct, getHowToPlay,
            saveProgress, clearProgress,
        };
        window.resetDrugTycoonState = resetState;
        // Persist on tab close / refresh so the last few seconds aren't lost.
        window.addEventListener('beforeunload', () => {
            if (window.drugTycoon) { try { saveProgress(); } catch (e) {} }
        });
    }

    return {
        ensureState, resetState, updateDrugTycoonState, openCook, closeCook, openShop, closeShop, openBagging, closeBagging, togglePhone, toggleHelp, queueInteract, getHowToPlay,
    };
}
