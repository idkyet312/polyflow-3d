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
import { probeTileRect, TILE_GUTTER } from './ddgiAtlas.js';

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

    // Hardcoded constants matching IRRADIANCE_TILE / TILE_GUTTER in ddgiAtlas.js.
    // Baked into the shader so we don't need uniforms for them.
    const TILE_F = 8;          // IRRADIANCE_TILE
    const GUTTER_F = 1;        // TILE_GUTTER
    const TILE_PX = TILE_F + GUTTER_F * 2;  // 10
    const MAX_LUMINANCE = 4;  // M2: per-channel clamp for energy explosion guard

    const integrateNode = Fn(() => {
        // We render to the FULL tile (10×10 inc. 1px gutter on each side). For
        // pixels in the inner 8×8 the math is unchanged. For pixels in the 1-px
        // gutter we clamp to the nearest inner-pixel center, producing edge
        // replication — bilinear taps near octahedral seams now read defined
        // values instead of uninitialized memory. (C2)
        const pixPos = uv().mul(float(TILE_PX));                              // [0, 10]
        const innerPx = pixPos.sub(float(GUTTER_F))                          // [-1, 9]
            .clamp(float(0.5), float(TILE_F).sub(0.5));                      // [0.5, 7.5]
        const tileUv = innerPx.div(float(TILE_F));                           // [0.0625, 0.9375]

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

        // (M2) Per-channel clamp before EMA mix so a bright direct light or a
        // brief misintegration cannot explode through the infinite-bounce loop.
        const irr = sum.div(weightSum.max(1e-5)).mul(uIntensity)
            .clamp(vec3(0), vec3(MAX_LUMINANCE));
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

        // Full tile = inner 8×8 + 1px gutter on each side (10×10). Integrate
        // pass writes to the full region with edge-replicated borders so the
        // sampler's bilinear taps near octahedral seams have valid data. (C2)
        const fullRect = {
            x: rect.x - TILE_GUTTER,
            y: rect.y - TILE_GUTTER,
            w: rect.w + TILE_GUTTER * 2,
            h: rect.h + TILE_GUTTER * 2,
        };

        cubeTex.value = cubeTarget.texture;
        prevAtlasTex.value = atlas.back.texture;
        uIntensity.value = intensity;
        uHysteresis.value = hysteresis;
        // The prev-atlas read uses tileUv (clamped to [0,1] inner range inside
        // the shader), so origin/scale still target the inner 8×8 region.
        uPrevTileOrigin.value.set(rect.x / atlas.width, rect.y / atlas.height);
        uPrevTileScale.value.set(rect.w / atlas.width, rect.h / atlas.height);
        irrMat.needsUpdate = true;

        const prevTarget = renderer.getRenderTarget();
        const prevScissor = renderer.getScissor(new THREE.Vector4());
        const prevScissorTest = renderer.getScissorTest();
        const prevViewport = renderer.getViewport(new THREE.Vector4());

        try {
            renderer.setRenderTarget(atlas.front);
            renderer.setViewport(fullRect.x, fullRect.y, fullRect.w, fullRect.h);
            renderer.setScissor(fullRect.x, fullRect.y, fullRect.w, fullRect.h);
            renderer.setScissorTest(true);
            renderer.render(passScene, passCamera);

            // Copy pass: inner 8×8 only — atlas.back is read by next frame's
            // EMA which only touches inner UVs (the integrate shader clamps),
            // so the gutter on atlas.back can stay stale.
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
