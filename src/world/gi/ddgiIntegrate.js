import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
    Fn,
    Loop,
    cubeTexture,
    dot,
    float,
    normalize,
    texture,
    uniform,
    uniformArray,
    uv,
    vec2,
    vec3,
    vec4,
} from 'three/tsl';
import { probeTileRect } from './ddgiAtlas.js';

const CUBE_SAMPLES = 32;

function createBlackTexture() {
    const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
}

function radicalInverse32(bits) {
    bits = ((bits << 16) | (bits >>> 16)) >>> 0;
    bits = (((bits & 0x55555555) << 1) | ((bits & 0xAAAAAAAA) >>> 1)) >>> 0;
    bits = (((bits & 0x33333333) << 2) | ((bits & 0xCCCCCCCC) >>> 2)) >>> 0;
    bits = (((bits & 0x0F0F0F0F) << 4) | ((bits & 0xF0F0F0F0) >>> 4)) >>> 0;
    bits = (((bits & 0x00FF00FF) << 8) | ((bits & 0xFF00FF00) >>> 8)) >>> 0;
    return bits * 2.3283064365386963e-10;
}

function makeSampleDirs() {
    const dirs = [];
    for (let i = 0; i < CUBE_SAMPLES; i++) {
        const x = i / CUBE_SAMPLES;
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

export function createIntegrator({ renderer }) {
    const quadGeom = new THREE.BufferGeometry();
    quadGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -1, -1, 0, 3, -1, 0, -1, 3, 0,
    ]), 3));
    quadGeom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
        0, 0, 2, 0, 0, 2,
    ]), 2));

    const cubeTex = cubeTexture(null);
    const prevAtlasTex = texture(createBlackTexture());
    const copySrcTex = texture(createBlackTexture());
    const uIntensity = uniform(1.0);
    const uHysteresis = uniform(0.97);
    const uPrevTileOrigin = uniform(new THREE.Vector2());
    const uPrevTileScale = uniform(new THREE.Vector2());
    const sampleDirs = uniformArray(makeSampleDirs(), 'vec3');

    const integrateNode = Fn(() => {
        const tileUv = uv();
        const f = tileUv.mul(2).sub(1);
        const nOut = vec3(f.x, f.y, float(1).sub(f.x.abs()).sub(f.y.abs())).toVar();
        const t = nOut.z.negate().max(0);
        nOut.x.addAssign(nOut.x.greaterThanEqual(0).select(t.negate(), t));
        nOut.y.addAssign(nOut.y.greaterThanEqual(0).select(t.negate(), t));
        nOut.assign(normalize(nOut));

        const sum = vec3(0).toVar();
        const weightSum = float(0).toVar();
        Loop(CUBE_SAMPLES, ({ i }) => {
            const dir = sampleDirs.element(i);
            const w = dot(dir, nOut).max(0);
            sum.addAssign(cubeTex.sample(dir).rgb.mul(w));
            weightSum.addAssign(w);
        });

        const irr = sum.div(weightSum.max(1e-5)).mul(uIntensity);
        const prevUv = uPrevTileOrigin.add(tileUv.mul(uPrevTileScale));
        const prev = prevAtlasTex.sample(prevUv).rgb;
        const mixed = irr.mul(float(1).sub(uHysteresis)).add(prev.mul(uHysteresis));
        return vec4(mixed, 1);
    });

    const copyNode = Fn(() => {
        const srcUv = uPrevTileOrigin.add(uv().mul(uPrevTileScale));
        return copySrcTex.sample(srcUv);
    });

    const irrMat = new MeshBasicNodeMaterial();
    irrMat.depthTest = false;
    irrMat.depthWrite = false;
    irrMat.fragmentNode = integrateNode();

    const copyMat = new MeshBasicNodeMaterial();
    copyMat.depthTest = false;
    copyMat.depthWrite = false;
    copyMat.fragmentNode = copyNode();

    const quad = new THREE.Mesh(quadGeom, irrMat);
    quad.frustumCulled = false;

    const copyQuad = new THREE.Mesh(quadGeom, copyMat);
    copyQuad.frustumCulled = false;

    const passScene = new THREE.Scene();
    passScene.add(quad);

    const copyScene = new THREE.Scene();
    copyScene.add(copyQuad);

    const passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    function integrateProbe({
        cubeTarget,
        atlas,
        probeIndex,
        intensity = 1.0,
        hysteresis = 0.97,
    }) {
        if (!cubeTarget || !atlas) return;
        const tile = atlas.tile;
        const rect = probeTileRect(probeIndex, tile, atlas.tilesPerRow);

        cubeTex.value = cubeTarget.texture;
        prevAtlasTex.value = atlas.back.texture;
        uIntensity.value = intensity;
        uHysteresis.value = hysteresis;
        uPrevTileOrigin.value.set(rect.x / atlas.width, rect.y / atlas.height);
        uPrevTileScale.value.set(rect.w / atlas.width, rect.h / atlas.height);
        irrMat.needsUpdate = true;

        const prevTarget = renderer.getRenderTarget();
        const prevScissor = renderer.getScissor(new THREE.Vector4());
        const prevScissorTest = renderer.getScissorTest();
        const prevViewport = renderer.getViewport(new THREE.Vector4());

        try {
            renderer.setRenderTarget(atlas.front);
            renderer.setViewport(rect.x, rect.y, rect.w, rect.h);
            renderer.setScissor(rect.x, rect.y, rect.w, rect.h);
            renderer.setScissorTest(true);
            renderer.render(passScene, passCamera);

            copySrcTex.value = atlas.front.texture;
            copyMat.needsUpdate = true;
            renderer.setRenderTarget(atlas.back);
            renderer.setViewport(rect.x, rect.y, rect.w, rect.h);
            renderer.setScissor(rect.x, rect.y, rect.w, rect.h);
            renderer.render(copyScene, passCamera);
        } finally {
            renderer.setScissorTest(prevScissorTest);
            renderer.setScissor(prevScissor);
            renderer.setViewport(prevViewport);
            renderer.setRenderTarget(prevTarget);
        }
    }

    function dispose() {
        quadGeom.dispose();
        irrMat.dispose();
        copyMat.dispose();
    }

    return {
        integrateProbe,
        dispose,
    };
}
