// Chunk streaming for the Drug Tycoon level.
//
// The hand-built level (createDrugTycoonLevel) is an 80×80 "core" block that is
// always loaded — chunk (0,0). This module grows the world OUTWARD from that
// core by generating decorative-but-collidable neighbourhood chunks on the fly
// as the player approaches an edge, and tearing them down once the player walks
// away. Nothing here is persisted: streamed chunks are pure world dressing
// (ground, roads, sidewalks, houses) rebuilt deterministically from their grid
// coordinate, so a reload simply regenerates whatever is near the player.
//
// Wiring mirrors the other self-contained gameplay systems: runtime.js calls
// createMapStreaming({...deps}) once and the drug-tycoon per-frame update calls
// the returned update(playerPos) every frame while on the street.
//
// Collision uses the SAME runtime actor path the level builder uses for its
// static meshes — createDynamicPropActor → setActorComponentFlags(collision) →
// rebuildActorPhysics — so streamed houses block the player exactly like the
// core ones. Teardown uses destroyDynamicPhysicsProp + sceneSystem.removeActor.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DDGIMeshStandardNodeMaterial } from '../world/gi/DDGIMeshStandardNodeMaterial.js';
import { convertLoadedObjectMaterials } from '../io/objectLoader.js';
import { getTycoonGrassTexture, getTycoonRoadTexture, getTycoonSidewalkTexture, makeTycoonTree } from '../world/levels.js';

// ---- car.glb model (models/car/car.glb) ----------------------------------
// The traffic + player cars use this GLB. Loaded once, normalized (scaled to a
// target length, base at y=0, facing +Z), then cloned per car. Replaces the
// procedural box car (kept as buildBoxCarMesh for the load-failed fallback).
const CAR_GLB_URL = (import.meta.env?.BASE_URL || '/') + 'models/car/car.glb';
const CAR_TARGET_LENGTH = 4.4;   // in-game car length (metres, along its long axis)
let _carPrototype = null;        // { root } once ready
let _carPromise = null;
function loadCarPrototype() {
    if (_carPrototype) return Promise.resolve(_carPrototype);
    if (_carPromise) return _carPromise;
    _carPromise = new Promise((resolve) => {
        new GLTFLoader().load(CAR_GLB_URL, (gltf) => {
            const src = gltf.scene;
            convertLoadedObjectMaterials(src);
            src.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
            // Normalize: scale so the longest horizontal axis == CAR_TARGET_LENGTH,
            // sit the base at y=0, centre on x/z. Orientation assumed +Z forward;
            // if the model faces a different way we yaw it to its long axis = Z.
            let box = new THREE.Box3().setFromObject(src);
            let size = box.getSize(new THREE.Vector3());
            if (size.x > size.z) src.rotation.y = Math.PI * 0.5; // make long axis = Z
            src.updateMatrixWorld(true);
            box = new THREE.Box3().setFromObject(src);
            size = box.getSize(new THREE.Vector3());
            const longest = Math.max(size.x, size.z) || 1;
            const s = CAR_TARGET_LENGTH / longest;
            src.scale.setScalar(s);
            src.updateMatrixWorld(true);
            box = new THREE.Box3().setFromObject(src);
            const center = box.getCenter(new THREE.Vector3());
            src.position.x -= center.x; src.position.z -= center.z;
            src.position.y -= box.min.y;     // base flush to ground
            const wrap = new THREE.Group();
            wrap.add(src);
            _carPrototype = { root: wrap };
            console.log('[mapStreaming] car.glb loaded', { scale: +s.toFixed(3), size: size.toArray().map((n) => +n.toFixed(2)) });
            resolve(_carPrototype);
        }, undefined, (err) => {
            console.warn('[mapStreaming] models/car/car.glb load failed', err);
            _carPrototype = { root: null };
            resolve(_carPrototype);
        });
    });
    return _carPromise;
}
loadCarPrototype();

// Standalone builder for the box-car mesh used by ambient traffic — exported so
// the drivable player car (spawned via the engine) can be re-skinned to match.
// Built facing +Z (front at +Z). `colorHex` tints the body. Uses DDGI node
// materials (NOT plain MeshStandardMaterial) so the car shades correctly in the
// WebGPU node-material pipeline — plain materials render BLACK in this scene.
// Traffic + player car mesh. Returns a Group populated with a clone of the
// car.glb model (deferred until the GLB loads; box-car fallback if it fails).
// `colorHex` is kept for the fallback's body tint.
export function buildTrafficCarMesh(colorHex = '#c43b3b') {
    const group = new THREE.Group();
    const fill = (proto) => {
        if (group.userData._carFilled) return;
        group.userData._carFilled = true;
        if (proto?.root) {
            const clone = proto.root.clone(true);
            // GLB as authored, except the tyres are forced black. Deep-clone
            // geometry per car so chunk teardown (which disposes mesh geometry)
            // can't corrupt the shared prototype's buffers.
            const tyreMat = new DDGIMeshStandardNodeMaterial({ color: new THREE.Color('#0e0f11'), roughness: 0.9, metalness: 0.0 });
            clone.traverse((o) => {
                if (!o.isMesh) return;
                if (o.geometry) o.geometry = o.geometry.clone();
                // Tyre meshes are named "Car tyre.*" in the GLB; match self+ancestors.
                let name = '';
                for (let p = o; p; p = p.parent) name += (p.name || '') + ' ';
                name = name.toLowerCase();
                if (name.includes('tyre') || name.includes('tire')) o.material = tyreMat;
            });
            group.add(clone);
        } else {
            group.add(buildBoxCarMesh(colorHex));
        }
    };
    if (_carPrototype) fill(_carPrototype);
    else loadCarPrototype().then(fill);
    return group;
}

// Procedural low-poly box car — fallback when car.glb can't load.
function buildBoxCarMesh(colorHex = '#c43b3b') {
    const g = new THREE.Group();
    const L = 4.2, W = 1.9;
    const ddgi = (color, roughness, metalness = 0.0, emissive = null, ei = 0) => {
        const mat = new DDGIMeshStandardNodeMaterial({ color: new THREE.Color(color), roughness, metalness });
        if (emissive) { mat.emissive = new THREE.Color(emissive); mat.emissiveIntensity = ei; }
        return mat;
    };
    const body = ddgi(colorHex, 0.32, 0.15);     // slightly glossy painted body
    const trim = ddgi('#15171a', 0.6);            // black trim / bumpers / sills
    const glass = ddgi('#10141c', 0.12, 0.2);     // dark glass
    const tire = ddgi('#0e0f11', 0.92);
    const rim = ddgi('#c9ced4', 0.35, 0.6);       // metallic hub cap
    const head = ddgi('#fff4c0', 0.3, 0.0, '#fff4c0', 1.2);
    const tail = ddgi('#ff4030', 0.3, 0.0, '#ff4030', 1.0);
    const add = (geo, mat, x, y, z, rotY = 0) => {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, y, z);
        if (rotY) mesh.rotation.y = rotY;
        mesh.castShadow = true; mesh.receiveShadow = true;
        g.add(mesh);
        return mesh;
    };

    const WHEEL_R = 0.34;
    const RIDE = WHEEL_R + 0.06;            // chassis sits just above wheel centre
    // Lower main body (sill) — sits low and wide so the car reads as grounded.
    add(new THREE.BoxGeometry(W, 0.34, L), trim, 0, RIDE - 0.02, 0);
    // Painted body above the sill, tapered slightly via a second narrower slab.
    add(new THREE.BoxGeometry(W * 0.98, 0.34, L * 0.98), body, 0, RIDE + 0.28, 0);
    add(new THREE.BoxGeometry(W * 0.9, 0.18, L * 0.9), body, 0, RIDE + 0.5, 0);
    // Cabin: a tapered greenhouse (roof narrower + shorter than its base) so the
    // pillars/windshield rake inward instead of forming a hard cube. Built from
    // a custom 8-vertex prism whose top face is shrunk and pushed back slightly.
    const cabY = RIDE + 0.74;
    const taperedCabin = (bw, bl, h, topScaleW, topScaleL, topZShift) => {
        const hw = bw * 0.5, hl = bl * 0.5;
        const tw = hw * topScaleW, tl = hl * topScaleL;
        // 8 corners: bottom (0-3) then top (4-7), top shifted back by topZShift.
        const v = new Float32Array([
            -hw, 0, -hl,  hw, 0, -hl,  hw, 0, hl,  -hw, 0, hl,            // bottom
            -tw, h, -tl + topZShift,  tw, h, -tl + topZShift,
             tw, h,  tl + topZShift, -tw, h,  tl + topZShift,            // top
        ]);
        const idx = [
            0,1,2, 0,2,3,        // bottom
            4,6,5, 4,7,6,        // top
            0,4,5, 0,5,1,        // front (-Z)
            1,5,6, 1,6,2,        // right (+X)
            2,6,7, 2,7,3,        // back (+Z)
            3,7,4, 3,4,0,        // left (-X)
        ];
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        return geo;
    };
    // Glass cabin body (tapered) — roof 70% width, 55% length, nudged rearward.
    // Double-sided so the custom prism shows regardless of face winding.
    const glassDS = ddgi('#10141c', 0.12, 0.2); glassDS.side = THREE.DoubleSide;
    add(taperedCabin(W * 0.84, L * 0.46, 0.46, 0.7, 0.55, 0.08), glassDS, 0, cabY - 0.23, -0.15);
    // Painted roof cap sitting on the tapered top so it doesn't read as glass.
    add(new THREE.BoxGeometry(W * 0.6, 0.07, L * 0.27), body, 0, cabY + 0.2, -0.19);
    // Slim painted A/C pillars framing the glass front + rear edges.
    add(new THREE.BoxGeometry(W * 0.84, 0.06, 0.06), body, 0, cabY - 0.23, -0.15 + L * 0.23);
    add(new THREE.BoxGeometry(W * 0.7, 0.06, 0.06), body, 0, cabY + 0.18, -0.15 - L * 0.135);

    // Wheels: higher-poly tyre + a metallic hub so they read as wheels, not pegs.
    const tireGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.26, 20);
    const rimGeo = new THREE.CylinderGeometry(WHEEL_R * 0.55, WHEEL_R * 0.55, 0.28, 16);
    for (const wx of [-W * 0.5, W * 0.5]) {
        for (const wz of [L * 0.3, -L * 0.3]) {
            const t = add(tireGeo, tire, wx, WHEEL_R, wz); t.rotation.z = Math.PI * 0.5;
            const r = add(rimGeo, rim, wx + Math.sign(wx) * 0.01, WHEEL_R, wz); r.rotation.z = Math.PI * 0.5;
        }
    }
    // Bumpers front + rear.
    add(new THREE.BoxGeometry(W * 0.96, 0.18, 0.18), trim, 0, RIDE - 0.02, L * 0.5);
    add(new THREE.BoxGeometry(W * 0.96, 0.18, 0.18), trim, 0, RIDE - 0.02, -L * 0.5);
    // Lights.
    add(new THREE.BoxGeometry(0.3, 0.16, 0.06), head, -W * 0.3, RIDE + 0.2, L * 0.5 + 0.02);
    add(new THREE.BoxGeometry(0.3, 0.16, 0.06), head,  W * 0.3, RIDE + 0.2, L * 0.5 + 0.02);
    add(new THREE.BoxGeometry(0.3, 0.16, 0.06), tail, -W * 0.3, RIDE + 0.2, -L * 0.5 - 0.02);
    add(new THREE.BoxGeometry(0.3, 0.16, 0.06), tail,  W * 0.3, RIDE + 0.2, -L * 0.5 - 0.02);
    return g;
}

const CHUNK = 80;            // must match BLOCK in createDrugTycoonLevel
const EDGE_MARGIN = 18;      // start loading a neighbour when within this of an edge
const MAX_OPS_PER_FRAME = 1; // one chunk built/destroyed per frame (no hitches)
const UNLOAD_DELAY_MS = 60000; // keep an out-of-range chunk this long before tearing it down

// Deterministic per-chunk PRNG so a chunk regenerates identically every time
// (mulberry32 seeded from its grid coords).
function chunkRng(cx, cz) {
    let seed = ((cx * 73856093) ^ (cz * 19349663)) >>> 0;
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function createMapStreaming(deps) {
    const {
        core,                       // appCore: live scene / camera / currentMesh
        createDynamicPropActor,
        setActorComponentFlags,
        rebuildActorPhysics,
        getActorRenderObject,
        destroyDynamicPhysicsProp,
        getSceneSystem,
        DDGIMeshStandardNodeMaterial, // node material so streamed meshes match SSR/DDGI
        makePerson,                   // ragdoll.makePerson — decorative pedestrians
        skinTones = ['#e8b893', '#c68642', '#8d5524', '#f1c27d', '#ffdbac'],
        shirtTones = ['#3da6ff', '#2dd4bf', '#f97316', '#a855f7', '#eab308', '#ef4444'],
    } = deps;

    // Live chunks keyed "cx,cz" → { actors: Actor[], meshes: Object3D[] }.
    const loaded = new Map();
    // Build/destroy queues processed at MAX_OPS_PER_FRAME so a burst of newly
    // required chunks spreads over several frames instead of one long stall.
    const buildQueue = [];
    const destroyQueue = [];
    let enabled = true;

    function key(cx, cz) { return `${cx},${cz}`; }

    // True if the chunk containing world (x,z) is currently loaded, or is the
    // hand-built main chunk (0,0) which always has its roads present.
    function chunkLoadedAt(x, z) {
        const cx = Math.round(x / CHUNK), cz = Math.round(z / CHUNK);
        if (cx === 0 && cz === 0) return true;
        return loaded.has(key(cx, cz));
    }

    // ---- shared materials (built once, reused across every chunk) --------
    let _mats = null;
    function mats() {
        if (_mats) return _mats;
        const flat = (color, rough = 0.92) => new DDGIMeshStandardNodeMaterial({
            color: new THREE.Color(color), roughness: rough, metalness: 0.0,
        });
        const emissive = (color, rough, ei) => {
            const mat = flat(color, rough);
            mat.emissive = new THREE.Color(color);
            mat.emissiveIntensity = ei;
            return mat;
        };
        // Same palettes + detail materials the core level (createDrugTycoonLevel)
        // uses for its houses, road markings and curbs, so streamed blocks read
        // identically to the hand-built one.
        // Textured ground surfaces — same procedural grass/asphalt/concrete the
        // core block uses, cloned so each gets its own repeat (CHUNK == BLOCK so
        // the tiling scale matches the hand-built block seamlessly).
        const grassMat = flat('#ffffff', 0.97);
        { const t = getTycoonGrassTexture().clone(); t.needsUpdate = true; t.repeat.set(20, 20); grassMat.map = t; grassMat.color = new THREE.Color('#9fbf86'); grassMat.needsUpdate = true; }
        const roadMat = flat('#ffffff', 0.95);
        { const t = getTycoonRoadTexture().clone(); t.needsUpdate = true; t.repeat.set(10, 10); roadMat.map = t; roadMat.needsUpdate = true; }
        const sidewalkMat = flat('#ffffff', 0.9);
        { const t = getTycoonSidewalkTexture().clone(); t.needsUpdate = true; t.repeat.set(8, 8); sidewalkMat.map = t; sidewalkMat.needsUpdate = true; }
        _mats = {
            grass: grassMat,
            road: roadMat,
            line: emissive('#d8c45a', 0.7, 0.15),
            curb: flat('#9aa0a6', 0.85),
            sidewalk: sidewalkMat,
            house: ['#b5654d', '#c9a26b', '#7d96a8', '#a8728c', '#6f9e6a', '#c2bba0'].map((c) => flat(c, 0.92)),
            roof: ['#3b2a24', '#4a3b2e', '#2e3a44', '#402a36'].map((c) => flat(c, 0.85)),
            window: emissive('#bfe6ff', 0.2, 0.25),
            door: flat('#2a1d14', 0.7),
            // Trees: identical materials to the core block's trees.
            trunk: flat('#5b3a21', 0.95),
            foliage: flat('#2f6d2c', 0.95),
            // Street lamps (match the core block's warm poles).
            lampPole: flat('#2a2a2e', 0.6),
            lampHead: emissive('#ffe0a0', 0.4, 1.2),
        };
        // Window/door are emissive-tinted; window keeps a light blue base so it
        // reads as glass. (emissive() set its emissive == base; nudge the look.)
        _mats.window.color = new THREE.Color('#bfe6ff');
        _mats.window.emissive = new THREE.Color('#9fd0ff');
        return _mats;
    }

    // A tree — the same models/tree/tree.fbx model the core block uses, so
    // streamed blocks match. Decorative, no collision.
    function makeTree(rng) {
        return makeTycoonTree(rng() * Math.PI * 2);
    }

    // Ambient traffic car body palette.
    const CAR_TONES = ['#c43b3b', '#3b6fc4', '#d6c24a', '#e8e8e8', '#2e2e34', '#3b9e6a'];
    // Delegates to the shared traffic-car builder so ambient + the drivable
    // player car share one mesh definition.
    function makeCar() {
        return buildTrafficCarMesh(CAR_TONES[(Math.random() * CAR_TONES.length) | 0]);
    }

    // ---- chunk generation ------------------------------------------------
    // Returns the meshes + the collidable subset for a given grid coordinate.
    // World centre of chunk (cx,cz) is (cx*CHUNK, _, cz*CHUNK).
    function buildChunkContent(cx, cz) {
        const m = mats();
        const ox = cx * CHUNK, oz = cz * CHUNK;
        const T = 0.4, DECAL_T = 0.04, ROAD_W = 9, SW = 2.0;
        const rng = chunkRng(cx, cz);
        const meshes = [];
        const collidables = [];

        const box = (name, size, pos, mat, { solid = false } = {}) => {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
            mesh.name = name;
            mesh.position.set(pos[0], pos[1], pos[2]);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            meshes.push(mesh);
            if (solid) collidables.push(mesh);
            return mesh;
        };
        const decal = (name, size, x, z, mat, lift = 0) =>
            box(name, [size[0], DECAL_T, size[1]], [x, -DECAL_T * 0.5 + 0.005 + lift, z], mat);

        // Chunk (0,0) is the hand-built core level — it already has ground,
        // roads and houses, so for it we ONLY add ambient traffic (the cars
        // block at the end). Skip all world geometry for the core.
        const isCore = cx === 0 && cz === 0;
        const people = [];
        if (!isCore) {

        // Ground: one collidable floor slab. Made slightly OVERSIZE so adjacent
        // chunk floors overlap instead of meeting edge-to-edge — a box-box seam
        // at exactly the chunk boundary creates a tiny lip the car catches on
        // ("stuck on bumps"). The overlap buries the seam under a continuous
        // surface. Top sits flush at y=0 like the core.
        const FLOOR_OVERLAP = 2;
        box(`cs-${cx}-${cz}-floor`, [CHUNK + FLOOR_OVERLAP, T, CHUNK + FLOOR_OVERLAP], [ox, -T * 0.5, oz], m.grass, { solid: true });

        // Continue the road grid through the chunk so streets line up across the
        // whole world (the core lays a cross through its own centre too).
        decal(`cs-${cx}-${cz}-road-ns`, [ROAD_W, CHUNK], ox, oz, m.road, 0.001);
        decal(`cs-${cx}-${cz}-road-ew`, [CHUNK, ROAD_W], ox, oz, m.road, 0.001);
        // Dashed centre lines along both road axes (skipping the junction box),
        // matching the core block's markings.
        const HALFC = CHUNK * 0.5;
        const CLEAR = ROAD_W * 0.5 + 1.2;
        for (let i = -HALFC + 4; i < HALFC; i += 6) {
            if (Math.abs(i) > CLEAR) decal(`cs-${cx}-${cz}-line-ns-${i | 0}`, [0.35, 2.4], ox, oz + i, m.line, 0.004);
            if (Math.abs(i) > CLEAR) decal(`cs-${cx}-${cz}-line-ew-${i | 0}`, [2.4, 0.35], ox + i, oz, m.line, 0.004);
        }
        const half = ROAD_W * 0.5;
        [-1, 1].forEach((s) => {
            decal(`cs-${cx}-${cz}-sw-ns-${s}`, [SW, CHUNK], ox + s * (half + SW * 0.5), oz, m.sidewalk, 0.002);
            decal(`cs-${cx}-${cz}-sw-ew-${s}`, [CHUNK, SW], ox, oz + s * (half + SW * 0.5), m.sidewalk, 0.002);
            // Flat ground-level curb strips (decals, top at ~0.001) so there's
            // no raised lip for the player/car to catch on — just a visual seam.
            decal(`cs-${cx}-${cz}-curb-ns-${s}`, [0.2, CHUNK], ox + s * (half + SW), oz, m.curb, 0.003);
            decal(`cs-${cx}-${cz}-curb-ew-${s}`, [CHUNK, 0.2], ox, oz + s * (half + SW), m.curb, 0.003);
        });

        // Street lamps along the N-S road's sidewalks, like the core block — a
        // dark pole + a glowing warm head. (Emissive only, no PointLight, to
        // keep the scene light count sane across many streamed chunks; the
        // emissive heads still read as lit under DDGI.)
        const lampX = half + SW + 0.4;
        for (const lz of [-26, -12, 12, 26]) {      // skip 0 (the E-W cross road)
            for (const sx of [-1, 1]) {
                const px = ox + sx * lampX, pz = oz + lz;
                const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 4.0, 8), m.lampPole);
                pole.name = `cs-${cx}-${cz}-lamp-pole-${sx}-${lz}`;
                pole.position.set(px, 2.0, pz);
                pole.castShadow = true;
                meshes.push(pole);
                box(`cs-${cx}-${cz}-lamp-head-${sx}-${lz}`, [0.5, 0.25, 0.5], [px, 4.05, pz], m.lampHead);
            }
        }

        // Detailed house in a lot, matching the core's addHouse: solid wall body
        // (the only collidable), a 4-sided pitched cone roof, a front door and
        // two windows. faceY rotates the whole thing so the front faces the road.
        const addHouse = (hx, hz, w, d, h, faceY, idx) => {
            const cos = Math.cos(faceY), sin = Math.sin(faceY);
            const place = (mesh, lx, ly, lz) => {
                mesh.position.set(hx + lx * cos + lz * sin, ly, hz - lx * sin + lz * cos);
                mesh.rotation.y = faceY;
                mesh.castShadow = true; mesh.receiveShadow = true;
                meshes.push(mesh);
                return mesh;
            };
            const wall = m.house[idx % m.house.length];
            const roof = m.roof[idx % m.roof.length];
            const body = place(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wall), 0, h * 0.5, 0);
            body.name = `cs-${cx}-${cz}-house-${idx}`;
            collidables.push(body);
            const roofMesh = place(new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.78, h * 0.55, 4), roof), 0, h + h * 0.27, 0);
            roofMesh.rotation.set(0, faceY + Math.PI * 0.25, 0);
            const frontZ = d * 0.5 + 0.02;
            place(new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.9, 0.12), m.door), 0, 0.95, frontZ);
            place(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.1), m.window), -w * 0.28, h * 0.6, frontZ);
            place(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.1), m.window),  w * 0.28, h * 0.6, frontZ);
        };

        // One house per corner lot, facing inward toward the road cross. Some
        // lots stay empty for variety (deterministic per chunk).
        const QUAD = CHUNK * 0.25;
        const lots = [
            [-1, -1, Math.PI * 0.75], [1, -1, Math.PI * 1.25],
            [-1, 1, Math.PI * 0.25], [1, 1, Math.PI * 1.75],
        ];
        let hi = 0;
        for (const [sx, sz, faceY] of lots) {
            if (rng() < 0.22) { hi++; continue; }   // some lots empty
            const w = 8 + rng() * 4, d = 7 + rng() * 4, h = 5 + rng() * 3;
            const x = ox + sx * QUAD + (rng() - 0.5) * 5;
            const z = oz + sz * QUAD + (rng() - 0.5) * 5;
            addHouse(x, z, w, d, h, faceY + (rng() - 0.5) * 0.3, hi++);
        }

        // Scatter a handful of trees across the block's grass (pushed off the
        // road so they never block the street). Static, no collision.
        const treeCount = 3 + ((rng() * 4) | 0);     // 3..6 per chunk
        for (let i = 0; i < treeCount; i++) {
            const tp = pushOffRoad(new THREE.Vector3(ox + (rng() - 0.5) * (CHUNK - 6), 0, oz + (rng() - 0.5) * (CHUNK - 6)));
            const tree = makeTree(rng);
            tree.position.set(tp.x, 0, tp.z);
            tree.rotation.y = rng() * Math.PI * 2;
            meshes.push(tree);                        // disposed/removed with the chunk
        }

        // Decorative pedestrians removed from streamed chunks — the only people
        // on the street now are the gameplay buyers/cops spawned by drugTycoon.

        } // end if (!isCore) — core skips ground/roads/houses

        // NOTE: ambient traffic is NOT built per-chunk — it's a world-level
        // system (see the traffic pool below) so cars drive in continuous lines
        // across chunk boundaries instead of looping inside one block.

        return { meshes, collidables, people };
    }

    // Roads run along every chunk-local centreline (x≡0 and z≡0 mod CHUNK),
    // 9 wide. Keep pedestrians off the asphalt: if a coordinate lands within
    // ROAD_CLEAR of a centreline, push it just past the kerb onto the grass.
    const ROAD_CLEAR = 6.0;   // road half (4.5) + a margin so they walk the verge
    function pushOffRoad(v) {
        const lx = v.x - Math.round(v.x / CHUNK) * CHUNK;
        if (Math.abs(lx) < ROAD_CLEAR) v.x += (lx >= 0 ? 1 : -1) * (ROAD_CLEAR - Math.abs(lx));
        const lz = v.z - Math.round(v.z / CHUNK) * CHUNK;
        if (Math.abs(lz) < ROAD_CLEAR) v.z += (lz >= 0 ? 1 : -1) * (ROAD_CLEAR - Math.abs(lz));
        return v;
    }
    // If `pos` is on a road (chunk-local centreline), clamp it to the kerb and
    // aim `p.target` back AWAY from that road so the pedestrian flips around
    // instead of sliding along the edge. Returns true if a road was hit.
    function bounceOffRoad(pos, p) {
        let hit = false;
        const lx = pos.x - Math.round(pos.x / CHUNK) * CHUNK;
        if (Math.abs(lx) < ROAD_CLEAR) {
            const side = lx >= 0 ? 1 : -1;
            pos.x += side * (ROAD_CLEAR - Math.abs(lx));
            p.target.x = pos.x + side * (6 + Math.random() * 14);   // head deeper into the block
            hit = true;
        }
        const lz = pos.z - Math.round(pos.z / CHUNK) * CHUNK;
        if (Math.abs(lz) < ROAD_CLEAR) {
            const side = lz >= 0 ? 1 : -1;
            pos.z += side * (ROAD_CLEAR - Math.abs(lz));
            p.target.z = pos.z + side * (6 + Math.random() * 14);
            hit = true;
        }
        return hit;
    }
    // Pick a random walkable (off-road) point inside a chunk to amble toward.
    function rollWanderTarget(ox, oz, rng) {
        const v = new THREE.Vector3(ox + (rng() - 0.5) * (CHUNK - 10), 0, oz + (rng() - 0.5) * (CHUNK - 10));
        return pushOffRoad(v);
    }

    // Materialize a queued chunk: add meshes to the scene + give collidables a
    // static physics body via the runtime actor path.
    function realizeChunk(cx, cz) {
        const k = key(cx, cz);
        if (loaded.has(k)) return;
        const { scene } = core;
        if (!scene) return;
        const { meshes, collidables, people } = buildChunkContent(cx, cz);
        const entry = { actors: [], meshes, people: people || [] };
        for (const mesh of meshes) scene.add(mesh);
        for (const mesh of collidables) {
            mesh.userData.skipPhysicsCollision = true;
            const actor = createDynamicPropActor({
                body: null, mesh, kind: 'imported',
                userData: { label: mesh.name, sampleLevelPart: true, streamedChunk: k },
                includeScripts: false,
            });
            if (actor) {
                actor.userData.staticMeshActorCollision = true;
                actor.userData.physicsFriction = 0.9;
                actor.userData.physicsRestitution = 0.08;
                setActorComponentFlags(actor, { collision: true, physics: false, scripts: false });
                rebuildActorPhysics(actor);
                entry.actors.push(actor);
            }
        }
        loaded.set(k, entry);
    }

    function unrealizeChunk(k) {
        const entry = loaded.get(k);
        if (!entry) return;
        const { scene } = core;
        const sceneSystem = getSceneSystem?.();
        for (const actor of entry.actors) {
            try { destroyDynamicPhysicsProp?.(actor); } catch (e) {}
            try { sceneSystem?.removeActor?.(actor); } catch (e) {}
        }
        for (const mesh of entry.meshes) {
            try { scene?.remove(mesh); } catch (e) {}
            // Dispose own geometry + any child geometries (pedestrian groups).
            // Materials are shared across chunks — do NOT dispose them.
            try {
                mesh.geometry?.dispose?.();
                mesh.traverse?.((o) => { if (o !== mesh) o.geometry?.dispose?.(); });
            } catch (e) {}
        }
        loaded.delete(k);
    }

    // ---- per-frame driver ------------------------------------------------
    function update(playerPos, dt = 0.016) {
        if (!enabled || !playerPos) return;
        const px = playerPos.x, pz = playerPos.z;
        const pcx = Math.round(px / CHUNK);
        const pcz = Math.round(pz / CHUNK);

        // Which chunks SHOULD be live: the player's chunk + only the neighbours
        // the player is actually near the edge toward (so we don't eagerly fill
        // all 8 ring cells while standing in a chunk centre).
        const localX = px - pcx * CHUNK;     // -CHUNK/2..+CHUNK/2 within current chunk
        const localZ = pz - pcz * CHUNK;
        const nearPosX = localX > CHUNK * 0.5 - EDGE_MARGIN;
        const nearNegX = localX < -CHUNK * 0.5 + EDGE_MARGIN;
        const nearPosZ = localZ > CHUNK * 0.5 - EDGE_MARGIN;
        const nearNegZ = localZ < -CHUNK * 0.5 + EDGE_MARGIN;

        const want = new Set();
        want.add(key(pcx, pcz));             // current chunk always live
        const addWant = (dx, dz) => want.add(key(pcx + dx, pcz + dz));
        if (nearPosX) addWant(1, 0);
        if (nearNegX) addWant(-1, 0);
        if (nearPosZ) addWant(0, 1);
        if (nearNegZ) addWant(0, -1);
        if (nearPosX && nearPosZ) addWant(1, 1);
        if (nearPosX && nearNegZ) addWant(1, -1);
        if (nearNegX && nearPosZ) addWant(-1, 1);
        if (nearNegX && nearNegZ) addWant(-1, -1);

        // Chunk (0,0) IS the hand-built core level, so we don't stream its
        // ground/buildings — but we DO want ambient traffic driving its roads,
        // so it stays in `want` and realizes as a traffic-only chunk (see
        // buildChunkContent's coreTraffic branch).

        // Queue builds for wanted-but-missing chunks.
        for (const k of want) {
            if (!loaded.has(k) && !buildQueue.includes(k)) buildQueue.push(k);
        }
        // A chunk is "in range" while it's in the current want-set (the chunks
        // the player is standing in or near the edge toward). One that drops out
        // of want isn't torn down immediately — it lingers for UNLOAD_DELAY_MS so
        // brief back-and-forth doesn't thrash rebuilds. Re-entering range clears
        // its timer; passing the delay queues the teardown.
        const now = performance.now?.() || Date.now();
        for (const [k, entry] of loaded) {
            if (!want.has(k)) {
                if (!entry.outOfRangeAt) entry.outOfRangeAt = now;        // start the clock
                if (now - entry.outOfRangeAt >= UNLOAD_DELAY_MS && !destroyQueue.includes(k)) {
                    destroyQueue.push(k);
                }
            } else if (entry.outOfRangeAt) {
                entry.outOfRangeAt = 0;                                   // back in range — cancel
                const di = destroyQueue.indexOf(k);
                if (di >= 0) destroyQueue.splice(di, 1);
            }
        }

        // Process a bounded number of ops this frame.
        let ops = 0;
        while (ops < MAX_OPS_PER_FRAME && destroyQueue.length) {
            unrealizeChunk(destroyQueue.shift());
            ops++;
        }
        while (ops < MAX_OPS_PER_FRAME && buildQueue.length) {
            const k = buildQueue.shift();
            if (!loaded.has(k)) {
                const [cx, cz] = k.split(',').map(Number);
                realizeChunk(cx, cz);
            }
            ops++;
        }

        // Amble the decorative pedestrians + drive the world-level traffic.
        tickPeople(dt);
        tickTraffic(playerPos, dt);
    }

    // ---- world-level ambient traffic -----------------------------------
    // Cars drive continuous straight lines along the road grid (N-S at world
    // x=n*CHUNK, E-W at z=n*CHUNK) so traffic flows across many chunks. Cars
    // live within TRAFFIC_RANGE of the player; one past the far edge recycles
    // to the back of its line so the stream keeps moving.
    const LANE = 2.2;                 // lane offset from a road's centreline
    const TRAFFIC_RANGE = CHUNK * 1.8; // cars live within this of the player
    const TARGET_CARS = 2;            // total ambient cars kept alive near player
    const CONVOY_GAP = 14;            // spacing between cars in a line (metres)
    const traffic = [];               // live car records
    const _carHalf = TRAFFIC_RANGE;

    // Spawn a CONVOY: 2–4 cars sharing one road line + direction + speed,
    // staggered by CONVOY_GAP so they read as a continuous line of traffic
    // flowing across multiple chunks (the whole point of world-level traffic).
    function spawnConvoy(playerPos) {
        const m = mats();
        const axis = Math.random() < 0.5 ? 'z' : 'x';   // 'z': N-S road, 'x': E-W road
        const dir = Math.random() < 0.5 ? 1 : -1;
        const lane = dir > 0 ? LANE : -LANE;
        // Road line (multiple of CHUNK) near the player, on the cross-axis.
        const crossCentre = axis === 'z' ? playerPos.x : playerPos.z;
        const off = Math.random() < 0.6 ? 0 : (Math.random() < 0.5 ? 1 : -1);
        const line = (Math.round(crossCentre / CHUNK) + off) * CHUNK;
        const alongCentre = axis === 'z' ? playerPos.z : playerPos.x;
        const speed = 7 + Math.random() * 6;            // whole convoy moves together
        // Start the lead car behind the player along the travel direction; the
        // rest trail it by CONVOY_GAP.
        const lead = alongCentre - dir * _carHalf + (Math.random() - 0.5) * CHUNK;
        const n = Math.min(2 + ((Math.random() * 3) | 0), TARGET_CARS - traffic.length);
        for (let i = 0; i < n; i++) {
            const grp = makeCar();
            const rec = { grp, axis, dir, lane, line, speed };
            placeCar(rec, lead - dir * i * CONVOY_GAP);
            core.scene?.add(grp);
            traffic.push(rec);
        }
    }

    // Position a car at a given along-axis coordinate on its road line.
    function placeCar(rec, along) {
        const { grp, axis, dir, lane, line } = rec;
        if (axis === 'z') {
            grp.position.set(line + lane, 0, along);
            grp.rotation.y = dir > 0 ? 0 : Math.PI;
        } else {
            grp.position.set(along, 0, line - lane);
            grp.rotation.y = dir > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
        }
    }

    function removeCar(rec) {
        try { core.scene?.remove(rec.grp); } catch (e) {}
        try { rec.grp.traverse?.((o) => o.geometry?.dispose?.()); } catch (e) {}
        const i = traffic.indexOf(rec);
        if (i >= 0) traffic.splice(i, 1);
    }

    function tickTraffic(playerPos, dt) {
        if (!(dt > 0)) return;
        // Top up toward the target by spawning whole convoys (rarely, so traffic
        // stays sparse but forms lines when it appears).
        if (traffic.length < TARGET_CARS && Math.random() < 0.02) spawnConvoy(playerPos);

        for (let i = traffic.length - 1; i >= 0; i--) {
            const rec = traffic[i];
            const { grp, axis, dir, line } = rec;
            // Advance along the road.
            if (axis === 'z') grp.position.z += rec.speed * dir * dt;
            else grp.position.x += rec.speed * dir * dt;

            // A car is only DRAWN while it's over a loaded chunk (or the main
            // chunk). Outside that it's just a moving transform — its position
            // keeps advancing so it pops back in, in the right spot, once the
            // chunk it's driving into has streamed in.
            grp.visible = chunkLoadedAt(grp.position.x, grp.position.z);

            const along = axis === 'z' ? grp.position.z : grp.position.x;
            const alongCentre = axis === 'z' ? playerPos.z : playerPos.x;
            const crossCentre = axis === 'z' ? playerPos.x : playerPos.z;

            // If the player wandered far from this road line, retire the car.
            if (Math.abs(crossCentre - line) > TRAFFIC_RANGE) {
                removeCar(rec);
                continue;
            }
            // Drove past the far edge of the live window → recycle to the back of
            // the line so the stream keeps flowing across chunks.
            if (dir > 0 && along > alongCentre + _carHalf) {
                placeCar(rec, alongCentre - _carHalf);
            } else if (dir < 0 && along < alongCentre - _carHalf) {
                placeCar(rec, alongCentre + _carHalf);
            }
        }
    }

    function clearTraffic() {
        for (let i = traffic.length - 1; i >= 0; i--) removeCar(traffic[i]);
    }

    const _toTarget = new THREE.Vector3();
    function tickPeople(dt) {
        if (!makePerson || !(dt > 0)) return;
        for (const entry of loaded.values()) {
            for (const p of entry.people) {
                const g = p.grp;
                _toTarget.copy(p.target).sub(g.position);
                _toTarget.y = 0;
                const dist = _toTarget.length();
                if (dist < 0.6) {
                    // Arrived — re-roll a new nearby off-road target.
                    p.target.set(
                        g.position.x + (Math.random() - 0.5) * 24,
                        0,
                        g.position.z + (Math.random() - 0.5) * 24,
                    );
                    pushOffRoad(p.target);
                    continue;
                }
                _toTarget.multiplyScalar(p.speed * dt / dist);
                g.position.add(_toTarget);
                // Hit a road → flip: clamp to the kerb and re-aim into the block.
                if (bounceOffRoad(g.position, p)) {
                    g.rotation.y = Math.atan2(p.target.x - g.position.x, p.target.z - g.position.z);
                } else {
                    g.rotation.y = Math.atan2(_toTarget.x, _toTarget.z);
                }
            }
        }
    }

    // Drop every streamed chunk + all ambient traffic (level exit / reset, or
    // entering the off-map grow room). The core level itself stays.
    function clear() {
        buildQueue.length = 0;
        destroyQueue.length = 0;
        for (const k of [...loaded.keys()]) unrealizeChunk(k);
        clearTraffic();
    }

    function setEnabled(v) { enabled = !!v; if (!v) clear(); }

    return { update, clear, setEnabled, CHUNK };
}
