import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, attribute, uniform, positionLocal, uv, texture as textureNode, vec3, vec4, float, sin, cos, mix, modelViewMatrix, cameraProjectionMatrix } from 'three/tsl';
import { TERRAIN_SIZE, sampleTerrainHeightAtLocal } from './terrain.js';

// Grass parented under worldFloor (PlaneGeometry rotated -PI/2 X). In terrain
// LOCAL space: +X = world +X, +Y = world +Z, +Z = world up. PlaneGeometry's
// height function writes Z, so blade base sits on Z = height(x,y) and the
// blade extends along +Z.

const DEFAULT_BLADE_COUNT = 100000;
const DEFAULT_BLADE_HEIGHT = 0.5;
const DEFAULT_BLADE_WIDTH = 0.07;
const DEFAULT_PATCH_HALF_EXTENT = TERRAIN_SIZE * 0.5 * 0.92;
const DEFAULT_BASE_COLOR = new THREE.Color(0x2f5a1c);
const DEFAULT_TIP_COLOR = new THREE.Color(0xa8d96b);
const FOLIAGE_OBJECT_TYPES = new Set(['tree', 'bush']);

const TERRAIN_BASIN_DEPTH = -0.34;
const TERRAIN_ROLLING_X_FREQUENCY = 0.095;
const TERRAIN_ROLLING_Z_FREQUENCY = 0.082;
const TERRAIN_ROLLING_X_AMPLITUDE = 0.62;
const TERRAIN_ROLLING_Z_AMPLITUDE = 0.48;
const TERRAIN_DETAIL_FREQUENCY = 0.21;
const TERRAIN_DETAIL_AMPLITUDE = 0.12;

function getTerrainHeightLocal(x, y) {
    const radialFalloff = Math.min(1, Math.hypot(x, y) / (TERRAIN_SIZE * 0.5));
    const basin = TERRAIN_BASIN_DEPTH * Math.pow(radialFalloff, 1.7);
    const rolling = Math.sin(x * TERRAIN_ROLLING_X_FREQUENCY) * TERRAIN_ROLLING_X_AMPLITUDE
        + Math.cos(y * TERRAIN_ROLLING_Z_FREQUENCY) * TERRAIN_ROLLING_Z_AMPLITUDE;
    const detail = Math.sin((x + y) * TERRAIN_DETAIL_FREQUENCY) * TERRAIN_DETAIL_AMPLITUDE;
    return basin + rolling + detail;
}

function createBladeGeometry(height, width) {
    // Quad blade so a sprite can be UV-mapped fully. 4 verts, 2 tris.
    // Layout in terrain-local (Z = up):
    //   v0 base-left   (-w, 0, 0)        uv (0, 0)
    //   v1 base-right  ( w, 0, 0)        uv (1, 0)
    //   v2 tip-right   ( w, 0, height)   uv (1, 1)
    //   v3 tip-left    (-w, 0, height)   uv (0, 1)
    const halfWidth = width * 0.5;
    const positions = new Float32Array([
        -halfWidth, 0, 0,
        halfWidth, 0, 0,
        halfWidth, 0, height,
        -halfWidth, 0, height,
    ]);
    const heights = new Float32Array([0, 0, 1, 1]);
    const uvs = new Float32Array([
        0, 0,
        1, 0,
        1, 1,
        0, 1,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aHeight', new THREE.BufferAttribute(heights, 1));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    return geometry;
}

function getGrassHeightLocal(terrain, x, y) {
    return terrain ? sampleTerrainHeightAtLocal(terrain, x, y) : getTerrainHeightLocal(x, y);
}

function randomPointInBrush(localX, localY, radius) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.sqrt(Math.random()) * radius;
    return {
        x: localX + Math.cos(angle) * dist,
        y: localY + Math.sin(angle) * dist,
    };
}

function createFoliageMaterial(color, roughness = 0.82) {
    return new THREE.MeshStandardMaterial({
        color,
        roughness,
        metalness: 0,
    });
}

function createTreeFoliageParts() {
    const trunk = new THREE.CylinderGeometry(0.15, 0.24, 1.55, 10);
    trunk.rotateX(Math.PI / 2);
    trunk.translate(0, 0, 0.78);

    const crown = new THREE.ConeGeometry(0.72, 1.75, 12, 3);
    crown.rotateX(Math.PI / 2);
    crown.translate(0, 0, 2.05);

    return [
        { geometry: trunk, material: createFoliageMaterial(0x6b4a2f, 0.9) },
        { geometry: crown, material: createFoliageMaterial(0x2f7d32, 0.78) },
    ];
}

function createBushFoliageParts() {
    const main = new THREE.SphereGeometry(0.42, 10, 8);
    main.scale(1.25, 0.95, 0.72);
    main.translate(0, 0, 0.36);

    const side = new THREE.SphereGeometry(0.26, 8, 6);
    side.scale(1.4, 0.9, 0.65);
    side.translate(0.22, 0.16, 0.32);

    return [
        { geometry: main, material: createFoliageMaterial(0x3f8f3a, 0.82) },
        { geometry: side, material: createFoliageMaterial(0x2f6f2c, 0.86) },
    ];
}

function createFoliageEntry(type) {
    const parts = type === 'tree' ? createTreeFoliageParts() : createBushFoliageParts();
    return {
        type,
        parts,
        meshes: [],
        positions: [],
        rotations: [],
        scales: [],
        visible: true,
    };
}

function setMatrixFromFoliageInstance(matrix, item, type) {
    const position = new THREE.Vector3(item.x, item.y, item.z);
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, item.rotation));
    const baseScale = type === 'tree'
        ? new THREE.Vector3(item.scale * 1.55, item.scale * 1.55, item.scale * 2.05)
        : new THREE.Vector3(item.scale * 1.15, item.scale * 1.15, item.scale * 0.75);
    matrix.compose(position, rotation, baseScale);
}

function buildInstanceAttributes(count, halfExtent, terrain = null) {
    const offsets = new Float32Array(count * 3);
    const rotations = new Float32Array(count);
    const scales = new Float32Array(count);

    for (let i = 0; i < count; i++) {
        const x = (Math.random() * 2 - 1) * halfExtent;
        const y = (Math.random() * 2 - 1) * halfExtent;
        const z = getGrassHeightLocal(terrain, x, y);

        offsets[i * 3 + 0] = x;
        offsets[i * 3 + 1] = y;
        offsets[i * 3 + 2] = z;
        rotations[i] = Math.random() * Math.PI * 2;
        scales[i] = 0.7 + Math.random() * 0.6;
    }

    return { offsets, rotations, scales };
}

export function createGrassField({
    worldFloor = null,
    bladeCount = DEFAULT_BLADE_COUNT,
    bladeHeight = DEFAULT_BLADE_HEIGHT,
    bladeWidth = DEFAULT_BLADE_WIDTH,
    halfExtent = DEFAULT_PATCH_HALF_EXTENT,
    baseColor = DEFAULT_BASE_COLOR,
    tipColor = DEFAULT_TIP_COLOR,
} = {}) {
    const baseGeometry = createBladeGeometry(bladeHeight, bladeWidth);
    const instanced = new THREE.InstancedBufferGeometry();
    instanced.setIndex(baseGeometry.getIndex());
    instanced.setAttribute('position', baseGeometry.getAttribute('position'));
    instanced.setAttribute('aHeight', baseGeometry.getAttribute('aHeight'));
    instanced.setAttribute('uv', baseGeometry.getAttribute('uv'));

    const { offsets, rotations, scales } = buildInstanceAttributes(bladeCount, halfExtent, worldFloor);
    instanced.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
    instanced.setAttribute('aRotation', new THREE.InstancedBufferAttribute(rotations, 1));
    instanced.setAttribute('aScale', new THREE.InstancedBufferAttribute(scales, 1));
    instanced.instanceCount = bladeCount;
    const instanceData = {
        offsets: Array.from(offsets),
        rotations: Array.from(rotations),
        scales: Array.from(scales),
    };
    const baseGrassCount = instanceData.scales.length;

    const rebuildInstanceBuffers = () => {
        const instanceCount = Math.min(
            instanceData.scales.length,
            instanceData.rotations.length,
            Math.floor(instanceData.offsets.length / 3)
        );
        instanceData.offsets.length = instanceCount * 3;
        instanceData.rotations.length = instanceCount;
        instanceData.scales.length = instanceCount;

        const nextOffsets = new Float32Array(instanceData.offsets);
        const nextRotations = new Float32Array(instanceData.rotations);
        const nextScales = new Float32Array(instanceData.scales);
        instanced.setAttribute('aOffset', new THREE.InstancedBufferAttribute(nextOffsets, 3));
        instanced.setAttribute('aRotation', new THREE.InstancedBufferAttribute(nextRotations, 1));
        instanced.setAttribute('aScale', new THREE.InstancedBufferAttribute(nextScales, 1));
        instanced.instanceCount = instanceCount;
        instanced.attributes.aOffset.needsUpdate = true;
        instanced.attributes.aRotation.needsUpdate = true;
        instanced.attributes.aScale.needsUpdate = true;
    };

    instanced.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(0, 0, bladeHeight * 0.5),
        halfExtent * Math.SQRT2 + bladeHeight * 2
    );

    // ── TSL nodes ──────────────────────────────────────────
    const aHeight = attribute('aHeight', 'float');
    const aOffset = attribute('aOffset', 'vec3');
    const aRotation = attribute('aRotation', 'float');
    const aScale = attribute('aScale', 'float');

    const uTime = uniform(0);
    const uWindDirX = uniform(1);
    const uWindDirY = uniform(0.3);
    const uWindStrength = uniform(0.18);
    const uBaseColor = uniform(new THREE.Color().copy(baseColor));
    const uTipColor = uniform(new THREE.Color().copy(tipColor));
    const uUseSprite = uniform(0); // 0 = procedural, 1 = sample sprite
    const uSpriteTint = uniform(1); // 0..1 — how strongly the gradient tints the sprite

    // Default 1×1 white texture so the texture node always has something bound.
    const placeholderTexture = new THREE.DataTexture(
        new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat
    );
    placeholderTexture.colorSpace = THREE.SRGBColorSpace;
    placeholderTexture.needsUpdate = true;
    const spriteTextureRef = { current: placeholderTexture };
    const spriteSampler = textureNode(placeholderTexture, uv());

    const positionNode = Fn(() => {
        const c = cos(aRotation);
        const s = sin(aRotation);
        const p = positionLocal.mul(aScale);

        // Yaw blade around local Z axis (terrain up).
        const rotated = vec3(
            c.mul(p.x).sub(s.mul(p.y)),
            s.mul(p.x).add(c.mul(p.y)),
            p.z
        );

        const localPos = rotated.add(aOffset);

        // Wind sway in local XY plane, strongest at tip.
        const wave = sin(uTime.mul(1.6).add(aOffset.x.mul(0.6)).add(aOffset.y.mul(0.4)));
        const gust = sin(uTime.mul(0.4).add(aOffset.x.mul(0.05))).mul(0.5).add(0.5);
        const sway = wave.mul(uWindStrength).mul(aHeight).mul(gust.mul(0.5).add(0.5));

        return vec3(
            localPos.x.add(uWindDirX.mul(sway)),
            localPos.y.add(uWindDirY.mul(sway)),
            localPos.z
        );
    })();

    const colorNode = Fn(() => {
        const gradient = mix(uBaseColor, uTipColor, aHeight);
        const ao = float(0.8).add(aHeight.mul(0.2));
        const procedural = gradient.mul(ao);
        // When sprite is active, tint by gradient. Else use pure procedural.
        const tinted = spriteSampler.rgb.mul(mix(vec3(1.0, 1.0, 1.0), gradient, uSpriteTint));
        return mix(procedural, tinted, uUseSprite);
    })();

    const opacityNode = Fn(() => {
        return mix(float(1.0), spriteSampler.a, uUseSprite);
    })();

    const material = new MeshBasicNodeMaterial();
    material.side = THREE.DoubleSide;
    material.transparent = true;
    material.alphaTest = 0.5;
    material.positionNode = positionNode;
    material.colorNode = colorNode;
    material.opacityNode = opacityNode;

    const mesh = new THREE.Mesh(instanced, material);
    mesh.name = 'GrassField';
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.isGrassField = true;
    mesh.renderOrder = 1;

    if (worldFloor) {
        worldFloor.add(mesh);
    }

    const objectFoliage = {
        tree: createFoliageEntry('tree'),
        bush: createFoliageEntry('bush'),
    };

    const rebuildObjectFoliage = (type) => {
        const entry = objectFoliage[type];
        if (!entry) return;

        entry.meshes.forEach((entryMesh) => {
            entryMesh.parent?.remove(entryMesh);
            entryMesh.dispose?.();
        });
        entry.meshes = [];

        const count = entry.scales.length;
        const instanceCount = Math.max(1, count);
        const matrix = new THREE.Matrix4();
        const items = [];
        for (let i = 0; i < count; i++) {
            items.push({
                x: entry.positions[i * 3 + 0],
                y: entry.positions[i * 3 + 1],
                z: entry.positions[i * 3 + 2],
                rotation: entry.rotations[i],
                scale: entry.scales[i],
            });
        }

        entry.parts.forEach((part, partIndex) => {
            const instancedMesh = new THREE.InstancedMesh(part.geometry, part.material, instanceCount);
            instancedMesh.name = `${type === 'tree' ? 'Tree' : 'Bush'}Foliage${partIndex}`;
            instancedMesh.count = count;
            instancedMesh.castShadow = true;
            instancedMesh.receiveShadow = true;
            instancedMesh.frustumCulled = false;
            instancedMesh.visible = entry.visible;
            instancedMesh.userData.isPaintedFoliage = true;
            instancedMesh.userData.foliageType = type;

            items.forEach((item, index) => {
                setMatrixFromFoliageInstance(matrix, item, type);
                instancedMesh.setMatrixAt(index, matrix);
            });
            instancedMesh.instanceMatrix.needsUpdate = true;

            entry.meshes.push(instancedMesh);
            worldFloor?.add(instancedMesh);
        });
    };

    const rebuildAllObjectFoliage = () => {
        rebuildObjectFoliage('tree');
        rebuildObjectFoliage('bush');
    };

    const serializeObjectFoliage = (type) => {
        const entry = objectFoliage[type];
        if (!entry) return [];
        const items = [];
        for (let i = 0; i < entry.scales.length; i++) {
            items.push({
                x: Number(entry.positions[i * 3 + 0].toFixed(3)),
                y: Number(entry.positions[i * 3 + 1].toFixed(3)),
                z: Number(entry.positions[i * 3 + 2].toFixed(3)),
                rotation: Number(entry.rotations[i].toFixed(4)),
                scale: Number(entry.scales[i].toFixed(4)),
            });
        }
        return items;
    };

    const applyObjectFoliage = (type, items = []) => {
        const entry = objectFoliage[type];
        if (!entry) return;
        entry.positions = [];
        entry.rotations = [];
        entry.scales = [];
        items.forEach((item) => {
            if (!Number.isFinite(item?.x) || !Number.isFinite(item?.y)) return;
            entry.positions.push(item.x, item.y, Number.isFinite(item.z) ? item.z : getGrassHeightLocal(worldFloor, item.x, item.y));
            entry.rotations.push(Number.isFinite(item.rotation) ? item.rotation : Math.random() * Math.PI * 2);
            entry.scales.push(Number.isFinite(item.scale) ? item.scale : 1);
        });
        rebuildObjectFoliage(type);
    };

    const eraseObjectFoliage = (type, localX, localY, radius) => {
        const entry = objectFoliage[type];
        if (!entry) return;

        const radiusSq = radius * radius;
        const nextPositions = [];
        const nextRotations = [];
        const nextScales = [];
        for (let i = 0; i < entry.scales.length; i++) {
            const ox = entry.positions[i * 3 + 0];
            const oy = entry.positions[i * 3 + 1];
            const oz = entry.positions[i * 3 + 2];
            const dx = ox - localX;
            const dy = oy - localY;
            if (dx * dx + dy * dy <= radiusSq) continue;
            nextPositions.push(ox, oy, oz);
            nextRotations.push(entry.rotations[i]);
            nextScales.push(entry.scales[i]);
        }
        entry.positions = nextPositions;
        entry.rotations = nextRotations;
        entry.scales = nextScales;
        rebuildObjectFoliage(type);
    };

    const paintObjectFoliage = ({ terrain, localX, localY, radius, density, type }) => {
        const entry = objectFoliage[type];
        if (!entry) return;

        const densityScale = type === 'tree' ? 0.08 : 0.22;
        const maxAdd = type === 'tree' ? 36 : 120;
        const addCount = Math.min(maxAdd, Math.max(1, Math.round(density * densityScale)));
        for (let i = 0; i < addCount; i++) {
            const point = randomPointInBrush(localX, localY, radius);
            const z = getGrassHeightLocal(terrain, point.x, point.y);
            entry.positions.push(point.x, point.y, z);
            entry.rotations.push(Math.random() * Math.PI * 2);
            entry.scales.push(type === 'tree' ? 0.75 + Math.random() * 0.65 : 0.65 + Math.random() * 0.75);
        }
        rebuildObjectFoliage(type);
    };

    return {
        mesh,
        material,
        update(deltaTime) {
            uTime.value += deltaTime;
        },
        setWind(dirX, dirY, strength) {
            const len = Math.hypot(dirX, dirY) || 1;
            uWindDirX.value = dirX / len;
            uWindDirY.value = dirY / len;
            if (typeof strength === 'number') uWindStrength.value = strength;
        },
        setColors(base, tip) {
            uBaseColor.value.copy(base);
            uTipColor.value.copy(tip);
        },
        setSpriteTint(value) {
            uSpriteTint.value = THREE.MathUtils.clamp(value, 0, 1);
        },
        setAlphaTest(value) {
            material.alphaTest = THREE.MathUtils.clamp(value, 0, 1);
            material.needsUpdate = true;
        },
        serializeFoliage() {
            const paintedGrass = [];
            const grassCount = Math.min(
                instanceData.scales.length,
                instanceData.rotations.length,
                Math.floor(instanceData.offsets.length / 3)
            );
            const paintedStart = Math.min(baseGrassCount, grassCount);
            for (let i = paintedStart; i < grassCount; i++) {
                paintedGrass.push({
                    x: Number(instanceData.offsets[i * 3 + 0].toFixed(3)),
                    y: Number(instanceData.offsets[i * 3 + 1].toFixed(3)),
                    z: Number(instanceData.offsets[i * 3 + 2].toFixed(3)),
                    rotation: Number(instanceData.rotations[i].toFixed(4)),
                    scale: Number(instanceData.scales[i].toFixed(4)),
                });
            }

            return {
                version: 1,
                grass: paintedGrass,
                trees: serializeObjectFoliage('tree'),
                bushes: serializeObjectFoliage('bush'),
            };
        },
        applySerializedFoliage(data = {}, terrain = worldFloor) {
            instanceData.offsets = instanceData.offsets.slice(0, baseGrassCount);
            instanceData.rotations = instanceData.rotations.slice(0, baseGrassCount);
            instanceData.scales = instanceData.scales.slice(0, baseGrassCount);

            const grassItems = Array.isArray(data.grass) ? data.grass : [];
            grassItems.forEach((item) => {
                if (!Number.isFinite(item?.x) || !Number.isFinite(item?.y)) return;
                const z = Number.isFinite(item.z) ? item.z : getGrassHeightLocal(terrain, item.x, item.y);
                instanceData.offsets.push(item.x, item.y, z);
                instanceData.rotations.push(Number.isFinite(item.rotation) ? item.rotation : Math.random() * Math.PI * 2);
                instanceData.scales.push(Number.isFinite(item.scale) ? item.scale : 1);
            });
            rebuildInstanceBuffers();

            applyObjectFoliage('tree', data.trees);
            applyObjectFoliage('bush', data.bushes);
        },
        clearPaintedFoliage() {
            this.applySerializedFoliage({ grass: [], trees: [], bushes: [] }, worldFloor);
        },
        setVisible(isVisible) {
            mesh.visible = !!isVisible;
            Object.values(objectFoliage).forEach((entry) => {
                entry.visible = !!isVisible;
                entry.meshes.forEach((entryMesh) => {
                    entryMesh.visible = !!isVisible;
                });
            });
        },
        syncToTerrain(terrain = worldFloor, brush = null) {
            if (!terrain) return;
            const radius = brush?.radius ?? Number.POSITIVE_INFINITY;
            const radiusSq = radius * radius;
            const cx = brush?.localX ?? 0;
            const cy = brush?.localY ?? 0;
            let changed = false;
            const grassCount = Math.min(instanceData.scales.length, Math.floor(instanceData.offsets.length / 3));
            for (let i = 0; i < grassCount; i++) {
                const ox = instanceData.offsets[i * 3 + 0];
                const oy = instanceData.offsets[i * 3 + 1];
                if (Number.isFinite(radiusSq)) {
                    const dx = ox - cx;
                    const dy = oy - cy;
                    if (dx * dx + dy * dy > radiusSq) continue;
                }
                instanceData.offsets[i * 3 + 2] = getGrassHeightLocal(terrain, ox, oy);
                changed = true;
            }
            if (changed) rebuildInstanceBuffers();

            for (const type of FOLIAGE_OBJECT_TYPES) {
                const entry = objectFoliage[type];
                let entryChanged = false;
                for (let i = 0; i < entry.scales.length; i++) {
                    const ox = entry.positions[i * 3 + 0];
                    const oy = entry.positions[i * 3 + 1];
                    if (Number.isFinite(radiusSq)) {
                        const dx = ox - cx;
                        const dy = oy - cy;
                        if (dx * dx + dy * dy > radiusSq) continue;
                    }
                    entry.positions[i * 3 + 2] = getGrassHeightLocal(terrain, ox, oy);
                    entryChanged = true;
                }
                if (entryChanged) rebuildObjectFoliage(type);
            }
        },
        paintFoliage({
            terrain = worldFloor,
            localX = 0,
            localY = 0,
            radius = 5,
            density = 80,
            mode = 'add',
            type = 'grass',
        } = {}) {
            if (FOLIAGE_OBJECT_TYPES.has(type)) {
                if (mode === 'erase') {
                    eraseObjectFoliage(type, localX, localY, radius);
                } else {
                    paintObjectFoliage({ terrain, localX, localY, radius, density, type });
                }
                return;
            }

            const radiusSq = radius * radius;
            if (mode === 'erase') {
                const nextOffsets = [];
                const nextRotations = [];
                const nextScales = [];
                const grassCount = Math.min(
                    instanceData.scales.length,
                    instanceData.rotations.length,
                    Math.floor(instanceData.offsets.length / 3)
                );
                for (let i = 0; i < grassCount; i++) {
                    const ox = instanceData.offsets[i * 3 + 0];
                    const oy = instanceData.offsets[i * 3 + 1];
                    const dx = ox - localX;
                    const dy = oy - localY;
                    if (dx * dx + dy * dy <= radiusSq) continue;
                    nextOffsets.push(ox, oy, instanceData.offsets[i * 3 + 2]);
                    nextRotations.push(instanceData.rotations[i]);
                    nextScales.push(instanceData.scales[i]);
                }
                instanceData.offsets = nextOffsets;
                instanceData.rotations = nextRotations;
                instanceData.scales = nextScales;
                rebuildInstanceBuffers();
                return;
            }

            const addCount = Math.min(5000, Math.max(1, Math.round(density)));
            for (let i = 0; i < addCount; i++) {
                const point = randomPointInBrush(localX, localY, radius);
                const x = point.x;
                const y = point.y;
                const z = getGrassHeightLocal(terrain, x, y);
                instanceData.offsets.push(x, y, z);
                instanceData.rotations.push(Math.random() * Math.PI * 2);
                instanceData.scales.push(0.7 + Math.random() * 0.6);
            }
            rebuildInstanceBuffers();
        },
        async setSpriteFromUrl(url) {
            const loader = new THREE.TextureLoader();
            const tex = await new Promise((resolve, reject) => {
                loader.load(url, resolve, undefined, reject);
            });
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.wrapS = THREE.ClampToEdgeWrapping;
            tex.wrapT = THREE.ClampToEdgeWrapping;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.anisotropy = 8;
            tex.needsUpdate = true;
            const old = spriteTextureRef.current;
            spriteTextureRef.current = tex;
            spriteSampler.value = tex;
            uUseSprite.value = 1;
            if (old && old !== placeholderTexture) old.dispose();
        },
        clearSprite() {
            uUseSprite.value = 0;
            const old = spriteTextureRef.current;
            spriteTextureRef.current = placeholderTexture;
            spriteSampler.value = placeholderTexture;
            if (old && old !== placeholderTexture) old.dispose();
        },
        dispose() {
            mesh.parent?.remove(mesh);
            instanced.dispose();
            material.dispose();
            Object.values(objectFoliage).forEach((entry) => {
                entry.meshes.forEach((entryMesh) => {
                    entryMesh.parent?.remove(entryMesh);
                    entryMesh.dispose?.();
                });
                entry.parts.forEach((part) => {
                    part.geometry.dispose();
                    part.material.dispose();
                });
            });
            const t = spriteTextureRef.current;
            if (t && t !== placeholderTexture) t.dispose();
            placeholderTexture.dispose();
        },
    };
}
