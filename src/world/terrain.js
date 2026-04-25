import * as THREE from 'three';

export const TERRAIN_SIZE = 180;
export const TERRAIN_SEGMENTS = 180;
export const TERRAIN_Y_OFFSET = -0.28;
const TERRAIN_TEXTURE_REPEAT = 28;
const TERRAIN_TEXTURE_PATHS = {
    color: 'textures/grass004/Grass004_1K-JPG_Color.jpg',
    normal: 'textures/grass004/Grass004_1K-JPG_NormalGL.jpg',
    roughness: 'textures/grass004/Grass004_1K-JPG_Roughness.jpg',
    ao: 'textures/grass004/Grass004_1K-JPG_AmbientOcclusion.jpg',
};

function getTerrainHeightAtLocalPosition(x, y) {
    const radialFalloff = Math.min(1, Math.hypot(x, y) / (TERRAIN_SIZE * 0.5));
    const basin = -0.22 * Math.pow(radialFalloff, 1.7);
    const rolling = Math.sin(x * 0.16) * 0.28 + Math.cos(y * 0.14) * 0.22;
    const detail = Math.sin((x + y) * 0.45) * 0.08;
    return basin + rolling + detail;
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

    for (let index = 0; index < 1800; index++) {
        const x = Math.random() * canvas.width;
        const y = Math.random() * canvas.height;
        const width = 2 + Math.random() * 5;
        const height = 4 + Math.random() * 10;
        ctx.fillStyle = `hsla(${95 + Math.random() * 35}, ${40 + Math.random() * 30}%, ${28 + Math.random() * 28}%, ${0.08 + Math.random() * 0.18})`;
        ctx.fillRect(x, y, width, height);
    }

    for (let index = 0; index < 650; index++) {
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

export async function applyTerrainTextures(terrain) {
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
