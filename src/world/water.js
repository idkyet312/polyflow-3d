import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { Fn, attribute, uniform, positionLocal, positionWorld, normalWorld, cameraPosition, vec3, vec4, float, sin, cos, mix, dot, normalize, abs, smoothstep, length, pow } from 'three/tsl';
import { TERRAIN_SIZE } from './terrain.js';

// Water = ring plane around the island. Inner radius hugs the terrain edge,
// outer radius extends to a far horizon. Animated gerstner-ish ripples in TSL.

const DEFAULT_INNER_RADIUS = TERRAIN_SIZE * 0.5 * 0.92; // matches grass extent
const DEFAULT_OUTER_RADIUS = TERRAIN_SIZE * 4.0;
const DEFAULT_RING_SEGMENTS = 256;
const DEFAULT_RADIAL_SEGMENTS = 64;
const DEFAULT_LEVEL = -0.55;
const DEFAULT_DEEP_COLOR = new THREE.Color(0x0a2a3a);
const DEFAULT_SHALLOW_COLOR = new THREE.Color(0x3da6c7);
const DEFAULT_FOAM_COLOR = new THREE.Color(0xeaf6ff);

function createRingGeometry(innerRadius, outerRadius, ringSegments, radialSegments) {
    const geo = new THREE.RingGeometry(innerRadius, outerRadius, ringSegments, radialSegments);
    // RingGeometry sits in XY plane (Z up). Rotate to XZ plane (Y up).
    geo.rotateX(-Math.PI / 2);
    return geo;
}

export function createWater({
    innerRadius = DEFAULT_INNER_RADIUS,
    outerRadius = DEFAULT_OUTER_RADIUS,
    ringSegments = DEFAULT_RING_SEGMENTS,
    radialSegments = DEFAULT_RADIAL_SEGMENTS,
    level = DEFAULT_LEVEL,
    deepColor = DEFAULT_DEEP_COLOR,
    shallowColor = DEFAULT_SHALLOW_COLOR,
    foamColor = DEFAULT_FOAM_COLOR,
} = {}) {
    const geometry = createRingGeometry(innerRadius, outerRadius, ringSegments, radialSegments);

    const uTime = uniform(0);
    const uWaveAmp = uniform(0.06);
    // Lower freq = larger, smoother waves. Big ring (radius up to 720) needs
    // very low spatial frequency so we don't get a high-contrast tile pattern.
    const uWaveFreq = uniform(0.18);
    const uWaveSpeed = uniform(0.6);
    const uDeepColor = uniform(new THREE.Color().copy(deepColor));
    const uShallowColor = uniform(new THREE.Color().copy(shallowColor));
    const uFoamColor = uniform(new THREE.Color().copy(foamColor));
    const uOpacity = uniform(0.82);
    const uShoreFadeStart = uniform(innerRadius);
    const uShoreFadeEnd = uniform(innerRadius + 8);

    const positionNode = Fn(() => {
        const p = positionLocal;
        const w1 = sin(p.x.mul(uWaveFreq).add(uTime.mul(uWaveSpeed)));
        const w2 = cos(p.z.mul(uWaveFreq.mul(0.83)).add(uTime.mul(uWaveSpeed.mul(1.21))));
        const w3 = sin(p.x.add(p.z).mul(uWaveFreq.mul(0.4)).add(uTime.mul(uWaveSpeed.mul(0.6))));
        const h = w1.add(w2).mul(0.5).add(w3.mul(0.35)).mul(uWaveAmp);
        return vec3(p.x, p.y.add(h), p.z);
    })();

    const colorNode = Fn(() => {
        // Fresnel-like view factor: lighter at glancing angles.
        const viewDir = normalize(cameraPosition.sub(positionWorld));
        const fres = float(1.0).sub(abs(dot(viewDir, normalWorld))).clamp(0, 1);
        const fresnel = pow(fres, 3.0);

        // Color mixes deep->shallow by view fresnel (top-down = deep, glancing = shallow/sky).
        const baseCol = mix(uDeepColor, uShallowColor, fresnel);

        // Subtle foam ring near the shore only (no all-over polka dots).
        const distFromCenter = length(positionWorld.xz);
        const shoreFoam = float(1.0).sub(smoothstep(uShoreFadeStart, uShoreFadeEnd, distFromCenter));
        return mix(baseCol, uFoamColor, shoreFoam.mul(0.35));
    })();

    const material = new MeshStandardNodeMaterial();
    material.transparent = true;
    material.opacity = 0.82;
    material.metalness = 0.0;
    material.roughness = 0.08;
    material.side = THREE.FrontSide;
    material.positionNode = positionNode;
    material.colorNode = colorNode;
    material.opacityNode = uOpacity;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'WaterRing';
    mesh.position.y = level;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.userData.isWater = true;

    return {
        mesh,
        material,
        update(deltaTime) {
            uTime.value += deltaTime;
        },
        setLevel(y) {
            mesh.position.y = y;
        },
        setOpacity(value) {
            uOpacity.value = THREE.MathUtils.clamp(value, 0, 1);
            material.opacity = uOpacity.value;
        },
        setWaveAmp(value) { uWaveAmp.value = value; },
        setWaveFreq(value) { uWaveFreq.value = value; },
        setWaveSpeed(value) { uWaveSpeed.value = value; },
        setColors({ deep, shallow, foam } = {}) {
            if (deep) uDeepColor.value.copy(deep);
            if (shallow) uShallowColor.value.copy(shallow);
            if (foam) uFoamColor.value.copy(foam);
        },
        dispose() {
            mesh.parent?.remove(mesh);
            geometry.dispose();
            material.dispose();
        },
    };
}
