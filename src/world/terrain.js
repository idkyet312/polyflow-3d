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

function getBaseTerrainHeightAtLocalPosition(x, y) {
    const radialFalloff = Math.min(1, Math.hypot(x, y) / (TERRAIN_SIZE * 0.5));
    const basin = TERRAIN_BASIN_DEPTH * Math.pow(radialFalloff, 1.7);
    const rolling = Math.sin(x * TERRAIN_ROLLING_X_FREQUENCY) * TERRAIN_ROLLING_X_AMPLITUDE
        + Math.cos(y * TERRAIN_ROLLING_Z_FREQUENCY) * TERRAIN_ROLLING_Z_AMPLITUDE;
    const detail = Math.sin((x + y) * TERRAIN_DETAIL_FREQUENCY) * TERRAIN_DETAIL_AMPLITUDE;
    return basin + rolling + detail;
}

function ensureTerrainSculptState(terrain) {
    if (!terrain?.geometry?.attributes?.position) return null;
    if (terrain.userData.terrainSculptState) return terrain.userData.terrainSculptState;

    const position = terrain.geometry.getAttribute('position');
    const baseHeights = new Float32Array(position.count);
    for (let index = 0; index < position.count; index++) {
        baseHeights[index] = position.getZ(index);
    }

    if (!terrain.geometry.getAttribute('color')) {
        const colors = new Float32Array(position.count * 3);
        colors.fill(1);
        terrain.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    terrain.material.vertexColors = true;
    terrain.material.needsUpdate = true;

    terrain.userData.terrainSculptState = {
        baseHeights,
        segments: TERRAIN_SEGMENTS,
        size: TERRAIN_SIZE,
    };
    return terrain.userData.terrainSculptState;
}

function getTerrainVertexIndex(ix, iy, segments = TERRAIN_SEGMENTS) {
    return iy * (segments + 1) + ix;
}

function sampleTerrainLocalHeight(terrain, localX, localY) {
    const position = terrain?.geometry?.getAttribute?.('position');
    if (!position) return getBaseTerrainHeightAtLocalPosition(localX, localY);

    const state = ensureTerrainSculptState(terrain);
    const segments = state?.segments ?? TERRAIN_SEGMENTS;
    const size = state?.size ?? TERRAIN_SIZE;
    const half = size * 0.5;
    const u = THREE.MathUtils.clamp((localX + half) / size, 0, 1) * segments;
    const v = THREE.MathUtils.clamp((half - localY) / size, 0, 1) * segments;
    const ix = Math.min(segments - 1, Math.max(0, Math.floor(u)));
    const iy = Math.min(segments - 1, Math.max(0, Math.floor(v)));
    const tx = u - ix;
    const ty = v - iy;

    const h00 = position.getZ(getTerrainVertexIndex(ix, iy, segments));
    const h10 = position.getZ(getTerrainVertexIndex(ix + 1, iy, segments));
    const h01 = position.getZ(getTerrainVertexIndex(ix, iy + 1, segments));
    const h11 = position.getZ(getTerrainVertexIndex(ix + 1, iy + 1, segments));
    const hx0 = THREE.MathUtils.lerp(h00, h10, tx);
    const hx1 = THREE.MathUtils.lerp(h01, h11, tx);
    return THREE.MathUtils.lerp(hx0, hx1, ty);
}

export function sampleTerrainHeightAtLocal(terrain, localX, localY) {
    return sampleTerrainLocalHeight(terrain, localX, localY);
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

const _textureLoader = new THREE.TextureLoader();

function _loadTexture(url, colorSpace = THREE.NoColorSpace) {
    return new Promise((resolve, reject) => {
        _textureLoader.load(url, (tex) => {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.repeat.set(TERRAIN_TEXTURE_REPEAT, TERRAIN_TEXTURE_REPEAT);
            tex.anisotropy = 8;
            tex.colorSpace = colorSpace;
            tex.needsUpdate = true;
            resolve(tex);
        }, undefined, reject);
    });
}

export async function setTerrainModeGrid(terrain) {
    if (!terrain) return;
    const old = terrain.material.map;
    terrain.material.map = createCheckerTexture();
    terrain.material.normalMap = null;
    terrain.material.roughnessMap = null;
    terrain.material.aoMap = null;
    terrain.material.needsUpdate = true;
    if (old && old !== terrain.material.map) old.dispose?.();
}

export function setTerrainModeSolid(terrain) {
    if (!terrain) return;
    const old = terrain.material.map;
    terrain.material.map = null;
    terrain.material.normalMap = null;
    terrain.material.roughnessMap = null;
    terrain.material.aoMap = null;
    terrain.material.needsUpdate = true;
    if (old) old.dispose?.();
}

export async function setTerrainModeGrassPBR(terrain) {
    if (!terrain) return;
    const [color, normal, rough, ao] = await Promise.all([
        _loadTexture(TERRAIN_TEXTURE_PATHS.color, THREE.SRGBColorSpace),
        _loadTexture(TERRAIN_TEXTURE_PATHS.normal),
        _loadTexture(TERRAIN_TEXTURE_PATHS.roughness),
        _loadTexture(TERRAIN_TEXTURE_PATHS.ao),
    ]);
    const old = terrain.material.map;
    terrain.material.map = color;
    terrain.material.normalMap = normal;
    terrain.material.roughnessMap = rough;
    terrain.material.aoMap = ao;
    terrain.material.needsUpdate = true;
    if (old) old.dispose?.();
}

export function setTerrainCustomImage(terrain, dataUrl) {
    if (!terrain || !dataUrl) return;
    _textureLoader.load(dataUrl, (tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(TERRAIN_TEXTURE_REPEAT, TERRAIN_TEXTURE_REPEAT);
        tex.anisotropy = 8;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        const old = terrain.material.map;
        terrain.material.map = tex;
        terrain.material.normalMap = null;
        terrain.material.roughnessMap = null;
        terrain.material.aoMap = null;
        terrain.material.needsUpdate = true;
        if (old) old.dispose?.();
    });
}

export function setTerrainTint(terrain, hexColor) {
    if (!terrain) return;
    terrain.material.color.set(hexColor);
}

export function setTerrainRepeat(terrain, repeat) {
    if (!terrain) return;
    const r = Math.max(1, repeat);
    for (const key of ['map', 'normalMap', 'roughnessMap', 'aoMap']) {
        const tex = terrain.material[key];
        if (tex) tex.repeat.set(r, r);
    }
}

export function setTerrainRoughness(terrain, value) {
    if (!terrain) return;
    terrain.material.roughness = THREE.MathUtils.clamp(value, 0, 1);
}

export function createTerrainMesh() {
    const geometry = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
    const positions = geometry.attributes.position;

    for (let index = 0; index < positions.count; index++) {
        const x = positions.getX(index);
        const y = positions.getY(index);
        positions.setZ(index, getBaseTerrainHeightAtLocalPosition(x, y));
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
    ensureTerrainSculptState(terrain);
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

    const localHeight = sampleTerrainLocalHeight(worldFloor, localX, localY);
    return worldFloor.position.y + localHeight * terrainScaleY;
}

export function applyTerrainSculptBrush(terrain, {
    localX = 0,
    localY = 0,
    radius = 5,
    strength = 0.25,
    mode = 'raise',
    targetHeight = 0,
    paintColor = '#5f8f35',
    invert = false,
} = {}) {
    const state = ensureTerrainSculptState(terrain);
    const position = terrain?.geometry?.getAttribute?.('position');
    if (!state || !position) return false;

    const color = terrain.geometry.getAttribute('color');
    const paint = new THREE.Color(paintColor);
    const radiusSq = radius * radius;
    const affected = [];
    let heightSum = 0;

    for (let index = 0; index < position.count; index++) {
        const dx = position.getX(index) - localX;
        const dy = position.getY(index) - localY;
        const distSq = dx * dx + dy * dy;
        if (distSq > radiusSq) continue;
        const t = 1 - Math.sqrt(distSq) / radius;
        const falloff = t * t * (3 - 2 * t);
        affected.push({ index, falloff });
        heightSum += position.getZ(index);
    }

    if (!affected.length) return false;

    const averageHeight = heightSum / affected.length;
    const signedStrength = strength * (invert ? -1 : 1);

    for (const entry of affected) {
        const current = position.getZ(entry.index);
        if (mode === 'raise') {
            position.setZ(entry.index, current + signedStrength * entry.falloff);
        } else if (mode === 'smooth') {
            position.setZ(entry.index, THREE.MathUtils.lerp(current, averageHeight, Math.abs(strength) * entry.falloff));
        } else if (mode === 'flatten') {
            position.setZ(entry.index, THREE.MathUtils.lerp(current, targetHeight, Math.abs(strength) * entry.falloff));
        } else if (mode === 'paint') {
            color.setXYZ(
                entry.index,
                THREE.MathUtils.lerp(color.getX(entry.index), paint.r, Math.abs(strength) * entry.falloff),
                THREE.MathUtils.lerp(color.getY(entry.index), paint.g, Math.abs(strength) * entry.falloff),
                THREE.MathUtils.lerp(color.getZ(entry.index), paint.b, Math.abs(strength) * entry.falloff)
            );
        }
    }

    position.needsUpdate = true;
    if (mode === 'paint') {
        color.needsUpdate = true;
    } else {
        terrain.geometry.computeVertexNormals();
        terrain.geometry.attributes.normal.needsUpdate = true;
        terrain.geometry.computeBoundingSphere();
        terrain.geometry.computeBoundingBox();
    }
    return true;
}

export function serializeTerrainState(terrain) {
    const state = ensureTerrainSculptState(terrain);
    const position = terrain?.geometry?.getAttribute?.('position');
    if (!state || !position) return null;

    const color = terrain.geometry.getAttribute('color');
    const heights = [];
    const colors = [];

    for (let index = 0; index < position.count; index++) {
        const height = position.getZ(index);
        if (Math.abs(height - state.baseHeights[index]) > 0.0001) {
            heights.push(index, Number(height.toFixed(4)));
        }

        if (color) {
            const r = color.getX(index);
            const g = color.getY(index);
            const b = color.getZ(index);
            if (Math.abs(r - 1) > 0.0001 || Math.abs(g - 1) > 0.0001 || Math.abs(b - 1) > 0.0001) {
                colors.push(
                    index,
                    Number(r.toFixed(4)),
                    Number(g.toFixed(4)),
                    Number(b.toFixed(4))
                );
            }
        }
    }

    return {
        version: 1,
        size: state.size,
        segments: state.segments,
        heights,
        colors,
        material: {
            color: `#${terrain.material.color.getHexString()}`,
            roughness: terrain.material.roughness,
        },
    };
}

export function applySerializedTerrainState(terrain, data) {
    const state = ensureTerrainSculptState(terrain);
    const position = terrain?.geometry?.getAttribute?.('position');
    if (!state || !position) return;
    data ||= {};
    if (data.segments && data.segments !== state.segments) return;

    for (let index = 0; index < position.count; index++) {
        position.setZ(index, state.baseHeights[index]);
    }

    const heights = Array.isArray(data.heights) ? data.heights : [];
    for (let i = 0; i < heights.length - 1; i += 2) {
        const index = heights[i];
        if (index >= 0 && index < position.count) position.setZ(index, heights[i + 1]);
    }

    const color = terrain.geometry.getAttribute('color');
    if (color) {
        for (let index = 0; index < color.count; index++) {
            color.setXYZ(index, 1, 1, 1);
        }
        const colors = Array.isArray(data.colors) ? data.colors : [];
        for (let i = 0; i < colors.length - 3; i += 4) {
            const index = colors[i];
            if (index >= 0 && index < color.count) {
                color.setXYZ(index, colors[i + 1], colors[i + 2], colors[i + 3]);
            }
        }
        color.needsUpdate = true;
    }

    if (data.material?.color) terrain.material.color.set(data.material.color);
    if (typeof data.material?.roughness === 'number') terrain.material.roughness = THREE.MathUtils.clamp(data.material.roughness, 0, 1);
    terrain.material.needsUpdate = true;

    position.needsUpdate = true;
    terrain.geometry.computeVertexNormals();
    terrain.geometry.attributes.normal.needsUpdate = true;
    terrain.geometry.computeBoundingSphere();
    terrain.geometry.computeBoundingBox();
}
