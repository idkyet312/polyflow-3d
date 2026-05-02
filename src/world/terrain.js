import * as THREE from 'three';

export const TERRAIN_SIZE = 180;
export const TERRAIN_SEGMENTS = 180;
export const TERRAIN_Y_OFFSET = -0.28;
const TERRAIN_TEXTURE_REPEAT = 28;
const TERRAIN_BASIN_DEPTH = -0.34;
const TERRAIN_ROLLING_X_FREQUENCY = 0.095;
const TERRAIN_ROLLING_Z_FREQUENCY = 0.082;
const TERRAIN_ROLLING_X_AMPLITUDE = 0.62;
const TERRAIN_ROLLING_Z_AMPLITUDE = 0.48;
const TERRAIN_DETAIL_FREQUENCY = 0.21;
const TERRAIN_DETAIL_AMPLITUDE = 0.12;
const TERRAIN_TEXTURE_PATHS = {
    color: 'textures/grass004/Grass004_1K-JPG_Color.jpg',
    normal: 'textures/grass004/Grass004_1K-JPG_NormalGL.jpg',
    roughness: 'textures/grass004/Grass004_1K-JPG_Roughness.jpg',
    ao: 'textures/grass004/Grass004_1K-JPG_AmbientOcclusion.jpg',
};

function getTerrainHeightAtLocalPosition(x, y) {
    const radialFalloff = Math.min(1, Math.hypot(x, y) / (TERRAIN_SIZE * 0.5));
    const basin = TERRAIN_BASIN_DEPTH * Math.pow(radialFalloff, 1.7);
    const rolling = Math.sin(x * TERRAIN_ROLLING_X_FREQUENCY) * TERRAIN_ROLLING_X_AMPLITUDE
        + Math.cos(y * TERRAIN_ROLLING_Z_FREQUENCY) * TERRAIN_ROLLING_Z_AMPLITUDE;
    const detail = Math.sin((x + y) * TERRAIN_DETAIL_FREQUENCY) * TERRAIN_DETAIL_AMPLITUDE;
    return basin + rolling + detail;
}

function createCheckerTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');

    // Flat neutral grey base — Unreal world-grid look is one tone, not a checker.
    ctx.fillStyle = '#52555a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const minor = 64;          // 16 minor cells per repeat
    const majorEvery = 4;      // every 4th line is bold (UE major-grid spacing)

    // Minor grid lines — thin, low contrast.
    ctx.strokeStyle = 'rgba(20, 22, 26, 0.32)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= canvas.width / minor; i++) {
        const p = i * minor + 0.5;
        ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, canvas.height); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(canvas.width, p); ctx.stroke();
    }

    // Major grid lines — thicker, higher contrast.
    ctx.strokeStyle = 'rgba(20, 22, 26, 0.55)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= canvas.width / minor; i += majorEvery) {
        const p = i * minor + 0.5;
        ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, canvas.height); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(canvas.width, p); ctx.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(TERRAIN_TEXTURE_REPEAT * 0.5, TERRAIN_TEXTURE_REPEAT * 0.5);
    texture.anisotropy = 16;
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

export async function applyTerrainTextures(terrain) {
    // Floor is intentionally a flat dark grey — no grass textures applied.
    return;
}

export function createTerrainMesh() {
    const geometry = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
    const positions = geometry.attributes.position;

    for (let index = 0; index < positions.count; index++) {
        const x = positions.getX(index);
        const y = positions.getY(index);
        positions.setZ(index, getTerrainHeightAtLocalPosition(x, y));
    }

    geometry.computeVertexNormals();
    geometry.setAttribute('uv2', new THREE.Float32BufferAttribute(geometry.attributes.uv.array, 2));

    const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: createCheckerTexture(),
        roughness: 0.85,
        metalness: 0.05,
    });

    const terrain = new THREE.Mesh(geometry, material);
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.y = TERRAIN_Y_OFFSET;
    terrain.receiveShadow = true;
    return terrain;
}

export function sampleTerrainHeightAt(worldFloor, worldX, worldZ) {
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

    const localHeight = getTerrainHeightAtLocalPosition(localX, localY);
    return worldFloor.position.y + localHeight * terrainScaleY;
}
