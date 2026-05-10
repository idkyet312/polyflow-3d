import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, attribute, float, texture, uniform, vec2, vec3 } from 'three/tsl';
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
    group.userData.ddgiSkipCapture = true;
    group.layers.set(layer);
    scene.add(group);

    const probeGeo = new THREE.SphereGeometry(0.11, 10, 10);
    const uAtlasSize = uniform(new THREE.Vector2(1, 1));
    const uTilesPerRow = uniform(1);
    const uTile = uniform(8);
    const uGutter = uniform(TILE_GUTTER);
    const uProbeExposure = uniform(1.0);
    const uProbeSaturation = uniform(1.0);
    const atlasTex = texture(createBlackTexture());

    // Each probe sphere reads its tile origin from a per-instance attribute
    // rather than from `instanceIndex`. In three.js 0.184 the TSL
    // `instanceIndex` builtin doesn't flow correctly through every WebGPU
    // material setup path on InstancedMesh — the symptom was every probe
    // sphere displaying probe 0's irradiance ("all same color"). Reading
    // tile origin from a vertex attribute side-steps the issue and is the
    // standard way to feed per-instance data to a TSL graph.
    const irradianceNode = Fn(() => {
        const tileOrigin = attribute('aProbeTileOrigin', 'vec2');
        const tileOriginX = tileOrigin.x;
        const tileOriginY = tileOrigin.y;

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
            .mul(uProbeExposure)
            .clamp(vec3(0), vec3(4));
    });

    const probeMat = new MeshBasicNodeMaterial();
    probeMat.colorNode = irradianceNode();
    probeMat.toneMapped = false;
    probeMat.fog = false;
    // Keep probe debug visible only when not occluded by scene geometry.
    probeMat.depthTest = true;
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
        // Per-instance tile origin so the irradianceNode reads each
        // probe's own atlas tile. See comment in irradianceNode.
        const tileOriginAttr = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2);
        tileOriginAttr.setUsage(THREE.DynamicDrawUsage);
        probeMesh.geometry.setAttribute('aProbeTileOrigin', tileOriginAttr);
        probeMesh.userData._aProbeTileOrigin = tileOriginAttr;
        probeMesh.frustumCulled = false;
        probeMesh.userData.ddgiSkipCapture = true;
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
        boxMesh.userData.ddgiSkipCapture = true;
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
        const tileOriginAttr = inst.userData._aProbeTileOrigin;
        const tilesPerRow = atlas?.tilesPerRow ?? 1;
        const tile = atlas?.tile ?? 8;
        const tilePx = tile + TILE_GUTTER * 2;
        for (let i = 0; i < total; i++) {
            grid.probePositionByIndex(i, tmp);
            m.makeTranslation(tmp.x, tmp.y, tmp.z);
            inst.setMatrixAt(i, m);
            if (tileOriginAttr) {
                const col = i % tilesPerRow;
                const row = (i / tilesPerRow) | 0;
                tileOriginAttr.array[i * 2 + 0] = col * tilePx + TILE_GUTTER;
                tileOriginAttr.array[i * 2 + 1] = row * tilePx + TILE_GUTTER;
            }
        }
        inst.instanceMatrix.needsUpdate = true;
        if (tileOriginAttr) tileOriginAttr.needsUpdate = true;

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
