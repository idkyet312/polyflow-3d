import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, attribute, uniform, positionLocal, uv, texture as textureNode, vec3, vec4, float, sin, cos, mix, modelViewMatrix, cameraProjectionMatrix } from 'three/tsl';
import { TERRAIN_SIZE } from './terrain.js';

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

function buildInstanceAttributes(count, halfExtent) {
    const offsets = new Float32Array(count * 3);
    const rotations = new Float32Array(count);
    const scales = new Float32Array(count);

    for (let i = 0; i < count; i++) {
        const x = (Math.random() * 2 - 1) * halfExtent;
        const y = (Math.random() * 2 - 1) * halfExtent;
        const z = getTerrainHeightLocal(x, y);

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

    const { offsets, rotations, scales } = buildInstanceAttributes(bladeCount, halfExtent);
    instanced.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
    instanced.setAttribute('aRotation', new THREE.InstancedBufferAttribute(rotations, 1));
    instanced.setAttribute('aScale', new THREE.InstancedBufferAttribute(scales, 1));
    instanced.instanceCount = bladeCount;

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
            const t = spriteTextureRef.current;
            if (t && t !== placeholderTexture) t.dispose();
            placeholderTexture.dispose();
        },
    };
}
