import * as THREE from 'three';

export function createDDGIDebug({ scene }) {
    const group = new THREE.Group();
    group.name = 'ddgi-debug';
    group.userData.ignoreForcedSceneShadows = true;
    scene.add(group);

    const probeGeo = new THREE.SphereGeometry(0.15, 8, 8);
    const probeMat = new THREE.MeshBasicMaterial({
        color: 0xffd24d,
        toneMapped: false,
        fog: false,
    });

    let probeMesh = null;
    let boxMesh = null;
    const tmp = new THREE.Vector3();
    let visible = true;

    function ensureProbeMesh(count) {
        if (probeMesh && probeMesh.count === count) return probeMesh;
        if (probeMesh) {
            group.remove(probeMesh);
            probeMesh.dispose?.();
        }
        probeMesh = new THREE.InstancedMesh(probeGeo, probeMat, count);
        probeMesh.frustumCulled = false;
        probeMesh.visible = visible;
        group.add(probeMesh);
        return probeMesh;
    }

    function ensureBox() {
        if (boxMesh) return boxMesh;
        const geom = new THREE.BoxGeometry(1, 1, 1);
        const mat = new THREE.MeshBasicMaterial({
            color: 0x4dffd2,
            wireframe: true,
            transparent: true,
            opacity: 0.5,
            depthWrite: false,
            toneMapped: false,
            fog: false,
        });
        boxMesh = new THREE.Mesh(geom, mat);
        boxMesh.renderOrder = 999;
        boxMesh.visible = visible;
        group.add(boxMesh);
        return boxMesh;
    }

    function update(grid) {
        if (!visible) return;
        const total = grid.probeCount();
        const inst = ensureProbeMesh(total);
        const m = new THREE.Matrix4();
        for (let i = 0; i < total; i++) {
            grid.probePositionByIndex(i, tmp);
            m.makeTranslation(tmp.x, tmp.y, tmp.z);
            inst.setMatrixAt(i, m);
        }
        inst.instanceMatrix.needsUpdate = true;

        const box = ensureBox();
        box.position.set(grid.anchor.x, grid.anchor.y, grid.anchor.z);
        box.scale.set(grid.bounds.x, grid.bounds.y, grid.bounds.z);
    }

    function setVisible(v) {
        visible = !!v;
        if (probeMesh) probeMesh.visible = visible;
        if (boxMesh) boxMesh.visible = visible;
    }

    function dispose() {
        if (probeMesh) {
            group.remove(probeMesh);
            probeMesh.dispose?.();
            probeMesh = null;
        }
        if (boxMesh) {
            group.remove(boxMesh);
            boxMesh.geometry?.dispose?.();
            boxMesh.material?.dispose?.();
            boxMesh = null;
        }
        scene.remove(group);
        probeGeo.dispose();
        probeMat.dispose();
    }

    return {
        group,
        update,
        setVisible,
        isVisible: () => visible,
        dispose,
    };
}
