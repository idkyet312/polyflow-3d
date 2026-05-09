import * as THREE from 'three';

/**
 * Debug visualization: cast actual rays from a chosen probe and draw them as
 * coloured line segments. Each ray's length is its hit distance (or a fixed
 * miss length if it misses everything). Intended for sanity-checking that
 * DDGI captures see the colored walls â€” if rays from a right-wall probe
 * mostly hit the green wall up close, the integrate pass should produce
 * green-tinted irradiance for that probe.
 *
 * CPU-side helper only; real DDGI bake traces the BVH in WGSL compute.
 */

const RAY_COUNT = 64;
const MISS_LENGTH = 8.0;

function radicalInverse32(bits) {
    bits = ((bits << 16) | (bits >>> 16)) >>> 0;
    bits = (((bits & 0x55555555) << 1) | ((bits & 0xAAAAAAAA) >>> 1)) >>> 0;
    bits = (((bits & 0x33333333) << 2) | ((bits & 0xCCCCCCCC) >>> 2)) >>> 0;
    bits = (((bits & 0x0F0F0F0F) << 4) | ((bits & 0xF0F0F0F0) >>> 4)) >>> 0;
    bits = (((bits & 0x00FF00FF) << 8) | ((bits & 0xFF00FF00) >>> 8)) >>> 0;
    return bits * 2.3283064365386963e-10;
}

function makeSampleDirs(count) {
    const dirs = [];
    for (let i = 0; i < count; i++) {
        const x = i / count;
        const y = radicalInverse32(i);
        const phi = Math.PI * 2 * x;
        const cosTheta = 1 - 2 * y;
        const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
        dirs.push(new THREE.Vector3(
            sinTheta * Math.cos(phi),
            sinTheta * Math.sin(phi),
            cosTheta,
        ));
    }
    return dirs;
}

export function createDDGIRayDebug({ scene, layer = 30 }) {
    const group = new THREE.Group();
    group.name = 'ddgi-ray-debug';
    group.layers.set(layer);
    group.userData.ignoreForcedSceneShadows = true;
    scene.add(group);

    const lineGeom = new THREE.BufferGeometry();
    const positions = new Float32Array(RAY_COUNT * 2 * 3);   // 2 vertices per ray
    const colors    = new Float32Array(RAY_COUNT * 2 * 3);
    lineGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    lineGeom.setAttribute('color',    new THREE.BufferAttribute(colors,    3));

    const lineMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        transparent: true,
        opacity: 0.85,
    });

    const lines = new THREE.LineSegments(lineGeom, lineMat);
    lines.name = 'ddgi-ray-debug-lines';
    lines.frustumCulled = false;
    lines.layers.set(layer);
    lines.renderOrder = 1001;
    group.add(lines);

    // Hit-point markers â€” small spheres at each ray's hit position. Coloured
    // by the hit material's albedo so visually you can see which probe rays
    // landed on red vs green vs white surfaces.
    const hitGeom = new THREE.SphereGeometry(0.04, 8, 6);
    const hitMat = new THREE.MeshBasicMaterial({
        toneMapped: false,
        depthTest: false,
        depthWrite: false,
    });
    const hitMesh = new THREE.InstancedMesh(hitGeom, hitMat, RAY_COUNT);
    hitMesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(RAY_COUNT * 3),
        3,
    );
    hitMesh.frustumCulled = false;
    hitMesh.layers.set(layer);
    hitMesh.renderOrder = 1002;
    group.add(hitMesh);

    const sampleDirs = makeSampleDirs(RAY_COUNT);
    const raycaster = new THREE.Raycaster();
    const tmpVec = new THREE.Vector3();
    const tmpColor = new THREE.Color();
    const tmpMatrix = new THREE.Matrix4();
    let visible = false;

    function setVisible(v) {
        visible = !!v;
        group.visible = visible;
    }

    function isVisible() {
        return visible;
    }

    function clear() {
        positions.fill(0);
        colors.fill(0);
        lineGeom.attributes.position.needsUpdate = true;
        lineGeom.attributes.color.needsUpdate = true;
        const empty = new THREE.Matrix4().makeScale(0, 0, 0);
        for (let i = 0; i < RAY_COUNT; i++) {
            hitMesh.setMatrixAt(i, empty);
        }
        hitMesh.instanceMatrix.needsUpdate = true;
    }

    /**
     * Cast `RAY_COUNT` rays from `origin` against the scene; rebuild the
     * line segments and hit markers. `targets` is an array of meshes to
     * raycast against (so we can exclude the debug overlays themselves).
     */
    function update(origin, targets) {
        if (!visible) return;
        const targetList = Array.isArray(targets) ? targets : [];
        const empty = new THREE.Matrix4().makeScale(0, 0, 0);
        for (let i = 0; i < RAY_COUNT; i++) {
            const dir = sampleDirs[i];
            raycaster.set(origin, dir);
            raycaster.far = MISS_LENGTH;

            const hits = raycaster.intersectObjects(targetList, false);
            const hit = hits.length ? hits[0] : null;
            const dist = hit ? hit.distance : MISS_LENGTH;
            tmpVec.copy(dir).multiplyScalar(dist).add(origin);

            const off = i * 2 * 3;
            positions[off + 0] = origin.x;
            positions[off + 1] = origin.y;
            positions[off + 2] = origin.z;
            positions[off + 3] = tmpVec.x;
            positions[off + 4] = tmpVec.y;
            positions[off + 5] = tmpVec.z;

            // Line colour: pull the surface albedo of the hit material so
            // hits on the red wall draw red lines, on the green wall green,
            // etc. Misses (rays escaping the scene) draw dim grey.
            if (hit) {
                const mat = hit.object?.material;
                if (mat?.color) {
                    tmpColor.copy(mat.color);
                } else {
                    tmpColor.setRGB(0.7, 0.7, 0.7);
                }
            } else {
                tmpColor.setRGB(0.25, 0.25, 0.25);
            }
            colors[off + 0] = tmpColor.r;
            colors[off + 1] = tmpColor.g;
            colors[off + 2] = tmpColor.b;
            colors[off + 3] = tmpColor.r;
            colors[off + 4] = tmpColor.g;
            colors[off + 5] = tmpColor.b;

            // Hit marker
            if (hit) {
                tmpMatrix.makeTranslation(tmpVec.x, tmpVec.y, tmpVec.z);
                hitMesh.setMatrixAt(i, tmpMatrix);
                hitMesh.instanceColor.array[i * 3 + 0] = tmpColor.r;
                hitMesh.instanceColor.array[i * 3 + 1] = tmpColor.g;
                hitMesh.instanceColor.array[i * 3 + 2] = tmpColor.b;
            } else {
                hitMesh.setMatrixAt(i, empty);
            }
        }
        lineGeom.attributes.position.needsUpdate = true;
        lineGeom.attributes.color.needsUpdate = true;
        hitMesh.instanceMatrix.needsUpdate = true;
        hitMesh.instanceColor.needsUpdate = true;
    }

    function dispose() {
        scene.remove(group);
        lineGeom.dispose();
        lineMat.dispose();
        hitGeom.dispose();
        hitMat.dispose();
    }

    return {
        group,
        update,
        clear,
        setVisible,
        isVisible,
        dispose,
    };
}
