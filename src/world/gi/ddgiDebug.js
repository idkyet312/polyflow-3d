import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, float, instanceIndex, texture, uniform, vec2, vec3 } from 'three/tsl';
import { TILE_GUTTER } from './ddgiAtlas.js';

function createBlackTexture() {
    const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
}

export function createDDGIDebug({ scene, layer = 30 }) {
    const group = new THREE.Group();
    group.name = 'ddgi-debug';
    group.userData.ignoreForcedSceneShadows = true;
    group.layers.set(layer);
    scene.add(group);

    const probeGeo = new THREE.SphereGeometry(0.11, 10, 10);
    const uAtlasSize = uniform(new THREE.Vector2(1, 1));
    const uTilesPerRow = uniform(1);
    const uTile = uniform(8);
    const uGutter = uniform(TILE_GUTTER);
    const uProbeExposure = uniform(3.8);
    const uProbeSaturation = uniform(3.4);
    const atlasTex = texture(createBlackTexture());

    const irradianceNode = Fn(() => {
        const idx = float(instanceIndex);
        const col = idx.mod(uTilesPerRow);
        const row = idx.div(uTilesPerRow).floor();
        const tilePx = uTile.add(uGutter.mul(2));
        const tileOriginX = col.mul(tilePx).add(uGutter);
        const tileOriginY = row.mul(tilePx).add(uGutter);

        const sampleTile = (x, y) => {
            const texX = tileOriginX.add(float(0.5)).add(float(x).mul(uTile.sub(1)));
            const texY = tileOriginY.add(float(0.5)).add(float(y).mul(uTile.sub(1)));
            return atlasTex.sample(vec2(texX, texY).div(uAtlasSize)).rgb;
        };

        const avg = sampleTile(0.2, 0.2)
            .add(sampleTile(0.5, 0.2))
            .add(sampleTile(0.8, 0.2))
            .add(sampleTile(0.2, 0.5))
            .add(sampleTile(0.5, 0.5))
            .add(sampleTile(0.8, 0.5))
            .add(sampleTile(0.2, 0.8))
            .add(sampleTile(0.5, 0.8))
            .add(sampleTile(0.8, 0.8))
            .div(float(9));

        const luminance = avg.x.mul(0.2126)
            .add(avg.y.mul(0.7152))
            .add(avg.z.mul(0.0722));
        const saturated = vec3(luminance)
            .add(avg.sub(vec3(luminance)).mul(uProbeSaturation));

        return saturated
            .max(vec3(0.035))
            .mul(uProbeExposure)
            .clamp(vec3(0), vec3(4));
    });

    const probeMat = new MeshBasicNodeMaterial();
    probeMat.colorNode = irradianceNode();
    probeMat.toneMapped = false;
    probeMat.fog = false;
    probeMat.depthTest = false;
    probeMat.depthWrite = false;

    let probeMesh = null;
    let boxMesh = null;
    const tmp = new THREE.Vector3();
    let visible = false;

    function refreshAtlasUniforms(atlas) {
        if (!atlas) {
            uAtlasSize.value.set(1, 1);
            uTilesPerRow.value = 1;
            uTile.value = 8;
            atlasTex.value = createBlackTexture();
            return;
        }
        uAtlasSize.value.set(atlas.width, atlas.height);
        uTilesPerRow.value = atlas.tilesPerRow;
        uTile.value = atlas.tile;
        atlasTex.value = atlas.front.texture;
    }

    function ensureProbeMesh(count) {
        if (probeMesh && probeMesh.count === count) return probeMesh;
        if (probeMesh) {
            group.remove(probeMesh);
            probeMesh.dispose?.();
        }
        probeMesh = new THREE.InstancedMesh(probeGeo, probeMat, count);
        probeMesh.frustumCulled = false;
        probeMesh.visible = visible;
        probeMesh.renderOrder = 1000;
        probeMesh.layers.set(layer);
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
        boxMesh.layers.set(layer);
        group.add(boxMesh);
        return boxMesh;
    }

    function update(grid, atlas) {
        if (!visible) return;
        refreshAtlasUniforms(atlas);
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
