import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export const MAX_MATERIAL_SLOTS = 16;
const DDGI_CAPTURE_LAYER_MASK = 1 << 30;

function isCollectable(obj) {
    if (!obj.isMesh || !obj.visible) return false;
    if (obj.userData?.ddgiSkipCapture) return false;
    if (obj.userData?.isGrassField) return false;
    if ((obj.layers?.mask & DDGI_CAPTURE_LAYER_MASK) !== 0) return false;
    if (obj.isInstancedMesh) return false;
    if (!obj.geometry) return false;
    const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    if (!mat) return false;
    if ((mat.opacity ?? 1) < 0.05) return false;
    return true;
}

function materialKey(mat) {
    const c = mat.color || { r: 1, g: 1, b: 1 };
    const e = mat.emissive || { r: 0, g: 0, b: 0 };
    const ei = mat.emissiveIntensity ?? 1;
    return `${c.r.toFixed(4)},${c.g.toFixed(4)},${c.b.toFixed(4)}|${(e.r * ei).toFixed(4)},${(e.g * ei).toFixed(4)},${(e.b * ei).toFixed(4)}`;
}

export function buildDDGIBVH(scene) {
    const meshes = [];
    scene.traverse((obj) => { if (isCollectable(obj)) meshes.push(obj); });

    if (meshes.length === 0) return null;

    let totalTriangles = 0;
    for (const m of meshes) {
        const g = m.geometry;
        if (g.index) totalTriangles += (g.index.count / 3) | 0;
        else totalTriangles += (g.attributes.position.count / 3) | 0;
    }
    if (totalTriangles === 0) return null;

    const mergedPositions = new Float32Array(totalTriangles * 9);
    const mergedNormals = new Float32Array(totalTriangles * 9);
    const mergedMatIds = new Uint32Array(totalTriangles);

    const slotByKey = new Map();
    const matAlbedo = new Float32Array(MAX_MATERIAL_SLOTS * 4);
    const matEmissive = new Float32Array(MAX_MATERIAL_SLOTS * 4);
    let nextSlot = 0;
    const allocSlot = (mat) => {
        const key = materialKey(mat);
        let slot = slotByKey.get(key);
        if (slot !== undefined) return slot;
        if (nextSlot >= MAX_MATERIAL_SLOTS) return 0;
        slot = nextSlot++;
        slotByKey.set(key, slot);
        const c = mat.color || { r: 1, g: 1, b: 1 };
        const e = mat.emissive || { r: 0, g: 0, b: 0 };
        const ei = mat.emissiveIntensity ?? 1;
        const a = slot * 4;
        matAlbedo[a + 0] = c.r;
        matAlbedo[a + 1] = c.g;
        matAlbedo[a + 2] = c.b;
        matAlbedo[a + 3] = 0;
        matEmissive[a + 0] = e.r * ei;
        matEmissive[a + 1] = e.g * ei;
        matEmissive[a + 2] = e.b * ei;
        matEmissive[a + 3] = 0;
        return slot;
    };

    let triCursor = 0;
    const tmpV = new THREE.Vector3();
    const tmpN = new THREE.Vector3();
    const normalMat = new THREE.Matrix3();

    for (const m of meshes) {
        const mat = Array.isArray(m.material) ? m.material[0] : m.material;
        const slot = allocSlot(mat);
        let geom = m.geometry;
        let needsDispose = false;
        if (geom.index || !geom.attributes.normal) {
            geom = geom.toNonIndexed();
            if (!geom.attributes.normal) geom.computeVertexNormals();
            needsDispose = true;
        }
        m.updateWorldMatrix(true, false);
        normalMat.getNormalMatrix(m.matrixWorld);
        const pos = geom.attributes.position;
        const nrm = geom.attributes.normal;
        const triCount = (pos.count / 3) | 0;
        for (let t = 0; t < triCount; t++) {
            for (let v = 0; v < 3; v++) {
                const srcIdx = t * 3 + v;
                const dstIdx = (triCursor + t) * 9 + v * 3;
                tmpV.fromBufferAttribute(pos, srcIdx).applyMatrix4(m.matrixWorld);
                mergedPositions[dstIdx + 0] = tmpV.x;
                mergedPositions[dstIdx + 1] = tmpV.y;
                mergedPositions[dstIdx + 2] = tmpV.z;
                tmpN.fromBufferAttribute(nrm, srcIdx).applyMatrix3(normalMat).normalize();
                mergedNormals[dstIdx + 0] = tmpN.x;
                mergedNormals[dstIdx + 1] = tmpN.y;
                mergedNormals[dstIdx + 2] = tmpN.z;
            }
            mergedMatIds[triCursor + t] = slot;
        }
        triCursor += triCount;
        if (needsDispose) geom.dispose?.();
    }

    const TRI_COUNT = triCursor;
    const bvhGeom = new THREE.BufferGeometry();
    bvhGeom.setAttribute('position', new THREE.BufferAttribute(mergedPositions, 3));
    bvhGeom.setAttribute('normal', new THREE.BufferAttribute(mergedNormals, 3));
    const seqIndex = new Uint32Array(TRI_COUNT * 3);
    for (let i = 0; i < seqIndex.length; i++) seqIndex[i] = i;
    bvhGeom.setIndex(new THREE.BufferAttribute(seqIndex, 1));

    const bvh = new MeshBVH(bvhGeom);
    const serialized = MeshBVH.serialize(bvh, bvhGeom, { copyIndexBuffer: true });
    const rootBuffer = serialized.roots[0];
    const idxBuffer = serialized.index;
    const nodeCount = (rootBuffer.byteLength / 32) | 0;

    const TRI_FLOATS_PER = 18;
    const triFloatBuf = new Float32Array(TRI_COUNT * TRI_FLOATS_PER);
    for (let t = 0; t < TRI_COUNT; t++) {
        const dstBase = t * TRI_FLOATS_PER;
        const srcBase = t * 9;
        for (let v = 0; v < 3; v++) {
            triFloatBuf[dstBase + v * 6 + 0] = mergedPositions[srcBase + v * 3 + 0];
            triFloatBuf[dstBase + v * 6 + 1] = mergedPositions[srcBase + v * 3 + 1];
            triFloatBuf[dstBase + v * 6 + 2] = mergedPositions[srcBase + v * 3 + 2];
            triFloatBuf[dstBase + v * 6 + 3] = mergedNormals[srcBase + v * 3 + 0];
            triFloatBuf[dstBase + v * 6 + 4] = mergedNormals[srcBase + v * 3 + 1];
            triFloatBuf[dstBase + v * 6 + 5] = mergedNormals[srcBase + v * 3 + 2];
        }
    }

    bvhGeom.dispose?.();

    return {
        rootBuffer,
        idxBuffer,
        triFloatBuf,
        triMatIds: mergedMatIds,
        triCount: TRI_COUNT,
        nodeCount,
        matAlbedo,
        matEmissive,
        materialSlotCount: nextSlot,
        meshCount: meshes.length,
    };
}
