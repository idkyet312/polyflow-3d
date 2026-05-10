import * as THREE from 'three';

export const MAX_MATERIAL_SLOTS = 16;
const DDGI_CAPTURE_LAYER_MASK = 1 << 30;
const TRI_FLOATS_PER = 18;
const NODE_STRIDE_U32 = 8;
const MAX_LEAF_TRIS = 4;
const SPLIT_EPSILON = 1e-6;

function isCollectable(obj) {
    if (!obj.isMesh || !obj.visible) return false;
    if (obj.userData?.ddgiSkipCapture) return false;
    if (obj.userData?.isGrassField) return false;
    if ((obj.layers?.mask & DDGI_CAPTURE_LAYER_MASK) !== 0) return false;
    if (obj.isInstancedMesh) return false;
    if (!obj.geometry) return false;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    if (!mats.length) return false;
    const hasVisibleMaterial = mats.some((mat) => mat && (mat.opacity ?? 1) >= 0.05);
    if (!hasVisibleMaterial) return false;
    return true;
}

function materialKey(mat) {
    if (!mat) return 'default';
    const c = mat.color || { r: 1, g: 1, b: 1 };
    const e = mat.emissive || { r: 0, g: 0, b: 0 };
    const ei = mat.emissiveIntensity ?? 1;
    return `${c.r.toFixed(4)},${c.g.toFixed(4)},${c.b.toFixed(4)}|${(e.r * ei).toFixed(4)},${(e.g * ei).toFixed(4)},${(e.b * ei).toFixed(4)}`;
}

function swapUint(arr, a, b) {
    const tmp = arr[a];
    arr[a] = arr[b];
    arr[b] = tmp;
}

function updateNodeBounds(nodeIndex, nodeFloat, nodeUint, triIndices, triBoundsMin, triBoundsMax) {
    const base = nodeIndex * NODE_STRIDE_U32;
    const firstTri = nodeUint[base + 6];
    const triCount = nodeUint[base + 7];

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < triCount; i++) {
        const triIndex = triIndices[firstTri + i] * 3;
        const triMinX = triBoundsMin[triIndex + 0];
        const triMinY = triBoundsMin[triIndex + 1];
        const triMinZ = triBoundsMin[triIndex + 2];
        const triMaxX = triBoundsMax[triIndex + 0];
        const triMaxY = triBoundsMax[triIndex + 1];
        const triMaxZ = triBoundsMax[triIndex + 2];
        if (triMinX < minX) minX = triMinX;
        if (triMinY < minY) minY = triMinY;
        if (triMinZ < minZ) minZ = triMinZ;
        if (triMaxX > maxX) maxX = triMaxX;
        if (triMaxY > maxY) maxY = triMaxY;
        if (triMaxZ > maxZ) maxZ = triMaxZ;
    }

    nodeFloat[base + 0] = minX;
    nodeFloat[base + 1] = minY;
    nodeFloat[base + 2] = minZ;
    nodeFloat[base + 3] = maxX;
    nodeFloat[base + 4] = maxY;
    nodeFloat[base + 5] = maxZ;
}

function sortAxesByScore(scoreX, scoreY, scoreZ) {
    let a0 = 0;
    let a1 = 1;
    let a2 = 2;
    const score = [scoreX, scoreY, scoreZ];
    if (score[a1] > score[a0]) [a0, a1] = [a1, a0];
    if (score[a2] > score[a0]) [a0, a2] = [a2, a0];
    if (score[a2] > score[a1]) [a1, a2] = [a2, a1];
    return [a0, a1, a2];
}

function partitionByAxis(triIndices, triCenters, firstTri, triCount, axis, splitPos) {
    let left = firstTri;
    let right = firstTri + triCount - 1;
    while (left <= right) {
        const triCenter = triCenters[triIndices[left] * 3 + axis];
        if (triCenter < splitPos) {
            left++;
        } else {
            swapUint(triIndices, left, right);
            right--;
        }
    }
    return left - firstTri;
}

function forceMedianSplit(triIndices, triCenters, firstTri, triCount, axis) {
    const sorted = Array.from(triIndices.subarray(firstTri, firstTri + triCount));
    sorted.sort((leftTri, rightTri) => triCenters[leftTri * 3 + axis] - triCenters[rightTri * 3 + axis]);
    triIndices.set(sorted, firstTri);
    return triCount >> 1;
}

function subdivideBVH(nodeFloat, nodeUint, triIndices, triBoundsMin, triBoundsMax, triCenters, triCount) {
    let nodesUsed = 1;
    nodeUint[6] = 0;
    nodeUint[7] = triCount;
    updateNodeBounds(0, nodeFloat, nodeUint, triIndices, triBoundsMin, triBoundsMax);

    const pending = [0];
    while (pending.length) {
        const nodeIndex = pending.pop();
        const base = nodeIndex * NODE_STRIDE_U32;
        const firstTri = nodeUint[base + 6];
        const count = nodeUint[base + 7];
        if (count <= MAX_LEAF_TRIS) continue;

        let meanX = 0;
        let meanY = 0;
        let meanZ = 0;
        let meanSqX = 0;
        let meanSqY = 0;
        let meanSqZ = 0;
        for (let i = 0; i < count; i++) {
            const triBase = triIndices[firstTri + i] * 3;
            const cx = triCenters[triBase + 0];
            const cy = triCenters[triBase + 1];
            const cz = triCenters[triBase + 2];
            meanX += cx;
            meanY += cy;
            meanZ += cz;
            meanSqX += cx * cx;
            meanSqY += cy * cy;
            meanSqZ += cz * cz;
        }
        const invCount = 1 / count;
        meanX *= invCount;
        meanY *= invCount;
        meanZ *= invCount;
        const varX = meanSqX * invCount - meanX * meanX;
        const varY = meanSqY * invCount - meanY * meanY;
        const varZ = meanSqZ * invCount - meanZ * meanZ;
        const extentX = nodeFloat[base + 3] - nodeFloat[base + 0];
        const extentY = nodeFloat[base + 4] - nodeFloat[base + 1];
        const extentZ = nodeFloat[base + 5] - nodeFloat[base + 2];
        const useExtentOrder = Math.max(varX, varY, varZ) < SPLIT_EPSILON;
        const axisOrder = useExtentOrder
            ? sortAxesByScore(extentX, extentY, extentZ)
            : sortAxesByScore(varX, varY, varZ);
        const splitPos = [meanX, meanY, meanZ];

        let leftCount = 0;
        let chosenAxis = axisOrder[0];
        for (let axisIndex = 0; axisIndex < 3 && leftCount === 0; axisIndex++) {
            const axis = axisOrder[axisIndex];
            chosenAxis = axis;
            leftCount = partitionByAxis(triIndices, triCenters, firstTri, count, axis, splitPos[axis]);
            if (leftCount === 0 || leftCount === count) {
                const midpoint = (nodeFloat[base + axis] + nodeFloat[base + 3 + axis]) * 0.5;
                leftCount = partitionByAxis(triIndices, triCenters, firstTri, count, axis, midpoint);
            }
            if (leftCount === 0 || leftCount === count) leftCount = 0;
        }

        if (leftCount === 0) {
            if (Math.max(extentX, extentY, extentZ) < SPLIT_EPSILON || count <= MAX_LEAF_TRIS * 2) continue;
            leftCount = forceMedianSplit(triIndices, triCenters, firstTri, count, chosenAxis);
            if (leftCount <= 0 || leftCount >= count) continue;
        }

        const leftChild = nodesUsed;
        const rightChild = leftChild + 1;
        nodesUsed += 2;

        nodeUint[base + 6] = leftChild;
        nodeUint[base + 7] = 0;

        const leftBase = leftChild * NODE_STRIDE_U32;
        nodeUint[leftBase + 6] = firstTri;
        nodeUint[leftBase + 7] = leftCount;
        updateNodeBounds(leftChild, nodeFloat, nodeUint, triIndices, triBoundsMin, triBoundsMax);

        const rightBase = rightChild * NODE_STRIDE_U32;
        nodeUint[rightBase + 6] = firstTri + leftCount;
        nodeUint[rightBase + 7] = count - leftCount;
        updateNodeBounds(rightChild, nodeFloat, nodeUint, triIndices, triBoundsMin, triBoundsMax);

        pending.push(rightChild, leftChild);
    }

    return nodesUsed;
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

    const triFloatBuf = new Float32Array(totalTriangles * TRI_FLOATS_PER);
    const mergedMatIds = new Uint32Array(totalTriangles);
    const triBoundsMin = new Float32Array(totalTriangles * 3);
    const triBoundsMax = new Float32Array(totalTriangles * 3);
    const triCenters = new Float32Array(totalTriangles * 3);

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
    const tmpP0 = new THREE.Vector3();
    const tmpP1 = new THREE.Vector3();
    const tmpP2 = new THREE.Vector3();
    const tmpN0 = new THREE.Vector3();
    const tmpN1 = new THREE.Vector3();
    const tmpN2 = new THREE.Vector3();
    const tmpFaceNormal = new THREE.Vector3();
    const tmpEdge1 = new THREE.Vector3();
    const tmpEdge2 = new THREE.Vector3();
    const normalMat = new THREE.Matrix3();

    for (const m of meshes) {
        const materials = Array.isArray(m.material) ? m.material : [m.material];
        const geom = m.geometry;
        const groups = Array.isArray(geom.groups) && geom.groups.length
            ? [...geom.groups].sort((left, right) => left.start - right.start)
            : null;
        let groupCursor = 0;

        const getTriangleMaterialSlot = (triIndex) => {
            if (!groups) {
                return allocSlot(materials[0]);
            }

            const triStart = triIndex * 3;
            while (
                groupCursor + 1 < groups.length
                && triStart >= (groups[groupCursor].start + groups[groupCursor].count)
            ) {
                groupCursor++;
            }

            const group = groups[groupCursor];
            const rawMaterialIndex = group && triStart >= group.start && triStart < (group.start + group.count)
                ? (group.materialIndex ?? 0)
                : 0;
            const materialIndex = Math.max(0, Math.min(materials.length - 1, rawMaterialIndex | 0));
            return allocSlot(materials[materialIndex] || materials[0]);
        };

        m.updateWorldMatrix(true, false);
        normalMat.getNormalMatrix(m.matrixWorld);
        const pos = geom.attributes.position;
        const nrm = geom.attributes.normal;
        const idx = geom.index?.array || null;
        const triCount = idx ? ((geom.index.count / 3) | 0) : ((pos.count / 3) | 0);
        for (let t = 0; t < triCount; t++) {
            const src0 = idx ? idx[t * 3 + 0] : (t * 3 + 0);
            const src1 = idx ? idx[t * 3 + 1] : (t * 3 + 1);
            const src2 = idx ? idx[t * 3 + 2] : (t * 3 + 2);
            const triBase = triCursor * TRI_FLOATS_PER;
            const boundsBase = triCursor * 3;

            tmpP0.fromBufferAttribute(pos, src0).applyMatrix4(m.matrixWorld);
            tmpP1.fromBufferAttribute(pos, src1).applyMatrix4(m.matrixWorld);
            tmpP2.fromBufferAttribute(pos, src2).applyMatrix4(m.matrixWorld);

            triFloatBuf[triBase + 0] = tmpP0.x;
            triFloatBuf[triBase + 1] = tmpP0.y;
            triFloatBuf[triBase + 2] = tmpP0.z;
            triFloatBuf[triBase + 6] = tmpP1.x;
            triFloatBuf[triBase + 7] = tmpP1.y;
            triFloatBuf[triBase + 8] = tmpP1.z;
            triFloatBuf[triBase + 12] = tmpP2.x;
            triFloatBuf[triBase + 13] = tmpP2.y;
            triFloatBuf[triBase + 14] = tmpP2.z;

            if (nrm) {
                tmpN0.fromBufferAttribute(nrm, src0).applyMatrix3(normalMat).normalize();
                tmpN1.fromBufferAttribute(nrm, src1).applyMatrix3(normalMat).normalize();
                tmpN2.fromBufferAttribute(nrm, src2).applyMatrix3(normalMat).normalize();
            } else {
                tmpFaceNormal.copy(tmpP1).sub(tmpP0);
                tmpEdge2.copy(tmpP2).sub(tmpP0);
                tmpFaceNormal.cross(tmpEdge2).normalize();
                tmpN0.copy(tmpFaceNormal);
                tmpN1.copy(tmpFaceNormal);
                tmpN2.copy(tmpFaceNormal);
            }

            triFloatBuf[triBase + 3] = tmpN0.x;
            triFloatBuf[triBase + 4] = tmpN0.y;
            triFloatBuf[triBase + 5] = tmpN0.z;
            triFloatBuf[triBase + 9] = tmpN1.x;
            triFloatBuf[triBase + 10] = tmpN1.y;
            triFloatBuf[triBase + 11] = tmpN1.z;
            triFloatBuf[triBase + 15] = tmpN2.x;
            triFloatBuf[triBase + 16] = tmpN2.y;
            triFloatBuf[triBase + 17] = tmpN2.z;

            const minX = Math.min(tmpP0.x, tmpP1.x, tmpP2.x);
            const minY = Math.min(tmpP0.y, tmpP1.y, tmpP2.y);
            const minZ = Math.min(tmpP0.z, tmpP1.z, tmpP2.z);
            const maxX = Math.max(tmpP0.x, tmpP1.x, tmpP2.x);
            const maxY = Math.max(tmpP0.y, tmpP1.y, tmpP2.y);
            const maxZ = Math.max(tmpP0.z, tmpP1.z, tmpP2.z);
            triBoundsMin[boundsBase + 0] = minX;
            triBoundsMin[boundsBase + 1] = minY;
            triBoundsMin[boundsBase + 2] = minZ;
            triBoundsMax[boundsBase + 0] = maxX;
            triBoundsMax[boundsBase + 1] = maxY;
            triBoundsMax[boundsBase + 2] = maxZ;
            triCenters[boundsBase + 0] = (minX + maxX) * 0.5;
            triCenters[boundsBase + 1] = (minY + maxY) * 0.5;
            triCenters[boundsBase + 2] = (minZ + maxZ) * 0.5;

            mergedMatIds[triCursor] = getTriangleMaterialSlot(t);
            triCursor++;
        }
    }

    const TRI_COUNT = triCursor;
    const triIndices = new Uint32Array(TRI_COUNT);
    for (let i = 0; i < TRI_COUNT; i++) triIndices[i] = i;

    const nodeBuffer = new ArrayBuffer(Math.max(1, TRI_COUNT * 2 - 1) * NODE_STRIDE_U32 * 4);
    const nodeFloat = new Float32Array(nodeBuffer);
    const nodeUint = new Uint32Array(nodeBuffer);
    const nodeCount = subdivideBVH(nodeFloat, nodeUint, triIndices, triBoundsMin, triBoundsMax, triCenters, TRI_COUNT);
    const rootBuffer = new Uint32Array(nodeBuffer.slice(0, nodeCount * NODE_STRIDE_U32 * 4));

    return {
        rootBuffer,
        idxBuffer: triIndices,
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
