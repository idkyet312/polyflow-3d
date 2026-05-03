import * as THREE from 'three';
import { OCT_GLSL } from './shaders/octEncode.tsl.js';
import { probeTileRect, IRRADIANCE_TILE, VISIBILITY_TILE, TILE_GUTTER } from './ddgiAtlas.js';

const VS = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COPY_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTileOrigin;
uniform vec2 uTileScale;
void main() {
    vec2 uv = uTileOrigin + vUv * uTileScale;
    gl_FragColor = texture2D(uSrc, uv);
}
`;

const IRRADIANCE_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform samplerCube uCube;
uniform float uIntensity;
uniform float uHysteresis;
uniform sampler2D uPrevAtlas;
uniform vec2 uPrevTileOrigin;     // [0,1]
uniform vec2 uPrevTileScale;      // [0,1]
${OCT_GLSL}

const int CUBE_SAMPLES = 64;

// Hammersley low-discrepancy sequence for cube sampling.
float radicalInverse(uint bits) {
    bits = (bits << 16u) | (bits >> 16u);
    bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
    bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
    bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
    bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
    return float(bits) * 2.3283064365386963e-10;
}

vec2 hammersley(int i, int N) {
    return vec2(float(i) / float(N), radicalInverse(uint(i)));
}

vec3 sphericalDir(vec2 xi) {
    float phi = 6.2831853 * xi.x;
    float cosTheta = 1.0 - 2.0 * xi.y;
    float sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
    return vec3(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
}

void main() {
    vec3 nOut = octDecode(vUv);

    vec3 sum = vec3(0.0);
    float weightSum = 0.0;
    for (int i = 0; i < CUBE_SAMPLES; i++) {
        vec3 dir = sphericalDir(hammersley(i, CUBE_SAMPLES));
        float w = max(0.0, dot(dir, nOut));
        if (w <= 0.0) continue;
        vec3 rad = textureCube(uCube, dir).rgb;
        sum += rad * w;
        weightSum += w;
    }
    vec3 irr = (weightSum > 0.0 ? sum / weightSum : vec3(0.0)) * uIntensity;
    vec2 prevUv = uPrevTileOrigin + vUv * uPrevTileScale;
    vec3 prev = texture2D(uPrevAtlas, prevUv).rgb;
    vec3 mixed = mix(irr, prev, uHysteresis);
    gl_FragColor = vec4(mixed, 1.0);
}
`;

export function createIntegrator({ renderer }) {
    const quadGeom = new THREE.BufferGeometry();
    quadGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -1, -1, 0,  3, -1, 0,  -1, 3, 0,
    ]), 3));
    quadGeom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
        0, 0,  2, 0,  0, 2,
    ]), 2));

    const irrMat = new THREE.ShaderMaterial({
        vertexShader: VS,
        fragmentShader: IRRADIANCE_FS,
        depthTest: false,
        depthWrite: false,
        uniforms: {
            uCube: { value: null },
            uIntensity: { value: 1.0 },
            uHysteresis: { value: 0.97 },
            uPrevAtlas: { value: null },
            uPrevTileOrigin: { value: new THREE.Vector2() },
            uPrevTileScale: { value: new THREE.Vector2() },
        },
    });

    const copyMat = new THREE.ShaderMaterial({
        vertexShader: VS,
        fragmentShader: COPY_FS,
        depthTest: false,
        depthWrite: false,
        uniforms: {
            uSrc: { value: null },
            uTileOrigin: { value: new THREE.Vector2() },
            uTileScale: { value: new THREE.Vector2() },
        },
    });

    const quad = new THREE.Mesh(quadGeom, irrMat);
    quad.frustumCulled = false;

    const copyQuad = new THREE.Mesh(quadGeom, copyMat);
    copyQuad.frustumCulled = false;

    const passScene = new THREE.Scene();
    passScene.add(quad);

    const copyScene = new THREE.Scene();
    copyScene.add(copyQuad);

    const passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    /**
     * Integrate cube `cubeTarget.texture` into atlas tile for probe `probeIndex`,
     * blending against prev atlas (`prevTex`) using hysteresis.
     */
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

        irrMat.uniforms.uCube.value = cubeTarget.texture;
        irrMat.uniforms.uIntensity.value = intensity;
        irrMat.uniforms.uHysteresis.value = hysteresis;
        irrMat.uniforms.uPrevAtlas.value = atlas.back.texture;
        irrMat.uniforms.uPrevTileOrigin.value.set(rect.x / atlas.width, rect.y / atlas.height);
        irrMat.uniforms.uPrevTileScale.value.set(rect.w / atlas.width, rect.h / atlas.height);

        const prevTarget = renderer.getRenderTarget();
        const prevScissor = renderer.getScissor(new THREE.Vector4());
        const prevScissorTest = renderer.getScissorTest();
        const prevViewport = renderer.getViewport(new THREE.Vector4());

        renderer.setRenderTarget(atlas.front);
        renderer.setViewport(0, 0, atlas.width, atlas.height);
        renderer.setScissor(rect.x, rect.y, rect.w, rect.h);
        renderer.setScissorTest(true);
        renderer.render(passScene, passCamera);

        // Mirror just-written tile from front into back so the next integrate
        // sees a valid prev.
        copyMat.uniforms.uSrc.value = atlas.front.texture;
        copyMat.uniforms.uTileOrigin.value.set(rect.x / atlas.width, rect.y / atlas.height);
        copyMat.uniforms.uTileScale.value.set(rect.w / atlas.width, rect.h / atlas.height);
        renderer.setRenderTarget(atlas.back);
        renderer.setScissor(rect.x, rect.y, rect.w, rect.h);
        renderer.render(copyScene, passCamera);

        renderer.setScissorTest(prevScissorTest);
        renderer.setScissor(prevScissor);
        renderer.setViewport(prevViewport);
        renderer.setRenderTarget(prevTarget);
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
