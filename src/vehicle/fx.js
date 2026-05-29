import * as THREE from 'three';
import { MeshBasicNodeMaterial, SpriteNodeMaterial } from 'three/webgpu';

export const VEHICLE_FX_SETTINGS = {
    maxParticles: 520,
    maxSkidMarks: 180,
    dustSpeed: 2.5,
    smokeSpeed: 3.5,
    skidSpeed: 5.5,
    skidRibbonSegments: 2048,
    skidRibbonWidth: 0.22,
    skidRibbonLifeSeconds: 300,
    skidRibbonMinSpacing: 0.04,
};

const _upVector = new THREE.Vector3(0, 1, 0);

function createVehicleFxTexture(kind) {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
    if (kind === 'spark') {
        gradient.addColorStop(0, 'rgba(255,255,220,1)');
        gradient.addColorStop(0.35, 'rgba(255,166,50,0.9)');
        gradient.addColorStop(1, 'rgba(255,80,10,0)');
    } else if (kind === 'dust') {
        gradient.addColorStop(0, 'rgba(205,190,160,0.62)');
        gradient.addColorStop(1, 'rgba(130,110,85,0)');
    } else {
        gradient.addColorStop(0, 'rgba(170,175,180,0.5)');
        gradient.addColorStop(1, 'rgba(85,90,95,0)');
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function createSkidRibbon(maxSegments, baseOpacity) {
    const vertexCount = maxSegments * 2;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 4);
    const indices = [];
    for (let i = 0; i < maxSegments - 1; i++) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    geometry.setIndex(indices);
    geometry.setDrawRange(0, 0);
    // Node material (NOT MeshBasicMaterial): the WebGPU node pipeline doesn't
    // honour 4-component (RGBA) vertex colours + transparency on the legacy
    // basic material, so skid marks rendered as opaque BLACK squares. The node
    // material reads the per-vertex alpha correctly → faint translucent marks.
    const material = new MeshBasicNodeMaterial({
        color: 0xffffff,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.name = 'tire-skid-ribbon';
    return {
        mesh,
        positions,
        colors,
        maxSegments,
        baseOpacity,
        // ring buffer of per-segment ages [maxSegments]
        ages: new Float32Array(maxSegments),
        opacities: new Float32Array(maxSegments),
        count: 0,
        head: 0,
        lastPos: new THREE.Vector3(),
        hasLast: false,
    };
}

function pushRibbonSegment(ribbon, position, right, halfWidth, opacity) {
    const i = ribbon.head * 2;
    ribbon.positions[i * 3 + 0] = position.x - right.x * halfWidth;
    ribbon.positions[i * 3 + 1] = position.y;
    ribbon.positions[i * 3 + 2] = position.z - right.z * halfWidth;
    ribbon.positions[i * 3 + 3] = position.x + right.x * halfWidth;
    ribbon.positions[i * 3 + 4] = position.y;
    ribbon.positions[i * 3 + 5] = position.z + right.z * halfWidth;

    ribbon.ages[ribbon.head] = 0;
    ribbon.opacities[ribbon.head] = opacity;

    ribbon.head = (ribbon.head + 1) % ribbon.maxSegments;
    if (ribbon.count < ribbon.maxSegments) ribbon.count++;
}

function rebuildRibbonGeometry(ribbon, lifeSeconds) {
    const { count, head, maxSegments, positions, colors, ages, opacities } = ribbon;
    if (count < 2) {
        ribbon.mesh.geometry.setDrawRange(0, 0);
        return;
    }
    // Walk from oldest to newest. Oldest index = (head - count) mod max.
    const start = (head - count + maxSegments) % maxSegments;
    const outPos = ribbon.mesh.geometry.attributes.position.array;
    const outCol = ribbon.mesh.geometry.attributes.color.array;
    for (let n = 0; n < count; n++) {
        const ringIdx = (start + n) % maxSegments;
        const srcOffset = ringIdx * 6;
        const dstOffset = n * 6;
        outPos[dstOffset + 0] = positions[srcOffset + 0];
        outPos[dstOffset + 1] = positions[srcOffset + 1];
        outPos[dstOffset + 2] = positions[srcOffset + 2];
        outPos[dstOffset + 3] = positions[srcOffset + 3];
        outPos[dstOffset + 4] = positions[srcOffset + 4];
        outPos[dstOffset + 5] = positions[srcOffset + 5];

        const ageNorm = Math.min(1, ages[ringIdx] / lifeSeconds);
        // Stay solid for first 80% of life, fade out only the last 20% (older end).
        const ageFade = ageNorm < 0.8 ? 1 : 1 - (ageNorm - 0.8) / 0.2;
        const a = opacities[ringIdx] * ageFade;
        const colOffset = n * 8;
        outCol[colOffset + 0] = 0.06; outCol[colOffset + 1] = 0.06; outCol[colOffset + 2] = 0.06; outCol[colOffset + 3] = a;
        outCol[colOffset + 4] = 0.06; outCol[colOffset + 5] = 0.06; outCol[colOffset + 6] = 0.06; outCol[colOffset + 7] = a;
    }
    ribbon.mesh.geometry.attributes.position.needsUpdate = true;
    ribbon.mesh.geometry.attributes.color.needsUpdate = true;
    ribbon.mesh.geometry.setDrawRange(0, (count - 1) * 6);
    ribbon.mesh.geometry.computeBoundingSphere();
}

export function createVehicleFx({ getScene, vehicleSettings }) {
    const state = {
        group: null,
        particles: [],
        ribbons: new Map(),
        textures: {},
    };

    function applyParticleMaterialStyle(material, kind) {
        if (!material) return;

        material.map = state.textures[kind] || state.textures.smoke;
        material.color.setHex(0xffffff);
        material.transparent = true;
        material.depthWrite = false;
        material.fog = false;

        if (kind === 'spark') {
            material.blending = THREE.AdditiveBlending;
            material.opacity = 1;
            material.toneMapped = false;
            return;
        }

        if (kind === 'smoke') {
            material.blending = THREE.AdditiveBlending;
            material.opacity = 0.12;
            material.toneMapped = false;
            return;
        }

        material.blending = THREE.AdditiveBlending;
        material.opacity = 0.14;
        material.toneMapped = false;
    }

    function ensureGroup() {
        const scene = typeof getScene === 'function' ? getScene() : null;
        if (!scene) return null;
        if (!state.group) {
            state.group = new THREE.Group();
            state.group.name = 'vehicle-surface-fx';
            state.group.userData.ignoreForcedSceneShadows = true;
            scene.add(state.group);
        }
        for (const kind of ['smoke', 'dust', 'spark']) {
            if (!state.textures[kind]) {
                state.textures[kind] = createVehicleFxTexture(kind);
            }
        }
        return state.group;
    }

    function getRibbon(key) {
        let r = state.ribbons.get(key);
        if (r) return r;
        const group = ensureGroup();
        if (!group) return null;
        r = createSkidRibbon(VEHICLE_FX_SETTINGS.skidRibbonSegments, 0.55);
        group.add(r.mesh);
        state.ribbons.set(key, r);
        return r;
    }

    function emitParticle(kind, position, velocity, size = 0.35, life = 0.7) {
        const group = ensureGroup();
        if (!group) return;

        let particle = state.particles.find((entry) => entry.life <= 0);
        if (!particle && state.particles.length < VEHICLE_FX_SETTINGS.maxParticles) {
            // SpriteNodeMaterial (NOT the legacy SpriteMaterial): the WebGPU node
            // pipeline doesn't honour the gradient texture's alpha on the legacy
            // sprite material, so dust/smoke rendered as opaque BLACK squares.
            const material = new SpriteNodeMaterial({
                map: state.textures[kind] || state.textures.smoke,
                transparent: true,
                depthWrite: false,
                toneMapped: false,
            });
            applyParticleMaterialStyle(material, kind);
            const sprite = new THREE.Sprite(material);
            sprite.visible = false;
            group.add(sprite);
            particle = { sprite, velocity: new THREE.Vector3(), life: 0, maxLife: 1, baseSize: 1, kind };
            state.particles.push(particle);
        }
        if (!particle) return;

        particle.kind = kind;
        particle.life = life;
        particle.maxLife = life;
        particle.baseSize = size;
        particle.velocity.copy(velocity);
        particle.sprite.position.copy(position);
        particle.sprite.scale.setScalar(size);
        applyParticleMaterialStyle(particle.sprite.material, kind);
        particle.sprite.visible = true;
    }

    function extendSkidRibbon(wheelKey, position, forward, opacity) {
        const ribbon = getRibbon(wheelKey);
        if (!ribbon) return;

        // Right vector perpendicular to forward, lying flat on ground.
        const rightX = -forward.z;
        const rightZ = forward.x;
        const len = Math.hypot(rightX, rightZ) || 1;
        const right = { x: rightX / len, y: 0, z: rightZ / len };
        const halfWidth = VEHICLE_FX_SETTINGS.skidRibbonWidth * 0.5;
        const placed = position.clone();
        placed.y += 0.012;

        if (ribbon.hasLast) {
            const dx = placed.x - ribbon.lastPos.x;
            const dz = placed.z - ribbon.lastPos.z;
            const dist = Math.hypot(dx, dz);
            if (dist < VEHICLE_FX_SETTINGS.skidRibbonMinSpacing) return;
        }

        pushRibbonSegment(ribbon, placed, right, halfWidth, opacity);
        ribbon.lastPos.copy(placed);
        ribbon.hasLast = true;
    }

    function breakSkidRibbon(wheelKey) {
        const ribbon = state.ribbons.get(wheelKey);
        if (ribbon) ribbon.hasLast = false;
    }

    // Master off-switch for all vehicle surface FX (dust/smoke/skid). Disabled
    // for now while the node-material particle look is being sorted out.
    const FX_ENABLED = false;
    function emitSurfaceEffects(delta, data) {
        if (!FX_ENABLED) return;
        if (!data.grounded) return;

        const speed = Math.abs(data.forwardSpeed);
        const lateral = Math.abs(data.lateralSpeed);
        const slip = data.drifting || data.brakeHeld || lateral > 2.6;
        const dustAmount = THREE.MathUtils.clamp((speed - VEHICLE_FX_SETTINGS.dustSpeed) / 13, 0, 1);
        const skidAmount = slip ? THREE.MathUtils.clamp((speed - VEHICLE_FX_SETTINGS.skidSpeed) / 18 + lateral / 10, 0, 1) : 0;
        const rearCorners = data.cornerSamples.slice(2);

        rearCorners.forEach((corner, idx) => {
            const wheelKey = `rear:${idx}`;
            if (corner.rideHeight === null) {
                breakSkidRibbon(wheelKey);
                return;
            }
            const visualWheel = data.rearWheelWorldPositions?.[idx];
            const wheelPos = visualWheel
                ? visualWheel.clone()
                : data.vehiclePosition.clone()
                    .addScaledVector(data.flatForward, corner.forward)
                    .addScaledVector(data.flatRight, corner.sideways);
            if (!visualWheel) {
                wheelPos.y -= Math.min(corner.rideHeight, vehicleSettings.suspensionRideHeight);
            }

            const plumeBasePos = wheelPos.clone()
                .addScaledVector(data.flatForward, -0.42)
                .addScaledVector(_upVector, -0.16);

            if (dustAmount > 0 && Math.random() < dustAmount * 18 * delta) {
                emitParticle(
                    'dust',
                    plumeBasePos.clone().addScaledVector(data.flatRight, (Math.random() - 0.5) * 0.18),
                    data.flatForward.clone().multiplyScalar(-speed * (0.16 + Math.random() * 0.1)).addScaledVector(_upVector, 0.22 + Math.random() * 0.22),
                    0.34 + dustAmount * 0.62 + Math.random() * 0.16,
                    0.55 + Math.random() * 0.55
                );
            }
            if (skidAmount > 0.05 && !data.noTracks) {
                extendSkidRibbon(wheelKey, wheelPos, data.flatForward, 0.35 + skidAmount * 0.5);
            } else {
                breakSkidRibbon(wheelKey);
            }
        });

        const hardLanding = data.averageCompression > vehicleSettings.suspensionTravel * 0.7 && data.verticalSpeed < -2.4;
        if (hardLanding && Math.random() < 18 * delta) {
            const sparkPos = data.vehiclePosition.clone().addScaledVector(data.flatForward, -0.25);
            sparkPos.y -= vehicleSettings.height * 0.4;
            for (let i = 0; i < 3; i++) {
                emitParticle(
                    'spark',
                    sparkPos,
                    data.flatRight.clone().multiplyScalar((Math.random() - 0.5) * 3).addScaledVector(_upVector, 1.1 + Math.random() * 1.2),
                    0.13,
                    0.25 + Math.random() * 0.2
                );
            }
        }
    }

    function updateSurfaceEffects(delta) {
        if (!state.group) return;

        for (const particle of state.particles) {
            if (particle.life <= 0) continue;
            particle.life -= delta;
            if (particle.life <= 0) {
                particle.sprite.visible = false;
                continue;
            }
            const t = 1 - particle.life / particle.maxLife;
            particle.velocity.y += particle.kind === 'spark' ? -9.5 * delta : 0.35 * delta;
            particle.sprite.position.addScaledVector(particle.velocity, delta);
            particle.sprite.scale.setScalar(particle.baseSize * (particle.kind === 'spark' ? 1 - t * 0.55 : 1 + t * 1.35));
            const baseOpacity = particle.kind === 'spark'
                ? 1
                : particle.kind === 'smoke'
                    ? 0.12
                    : 0.14;
            particle.sprite.material.opacity = baseOpacity * (1 - t);
        }

        const lifeSeconds = VEHICLE_FX_SETTINGS.skidRibbonLifeSeconds;
        for (const ribbon of state.ribbons.values()) {
            if (ribbon.count === 0) continue;
            for (let n = 0; n < ribbon.count; n++) {
                const ringIdx = (ribbon.head - ribbon.count + n + ribbon.maxSegments) % ribbon.maxSegments;
                ribbon.ages[ringIdx] += delta;
            }
            // Drop fully-faded oldest segments to free ring slots.
            while (ribbon.count > 0) {
                const oldest = (ribbon.head - ribbon.count + ribbon.maxSegments) % ribbon.maxSegments;
                if (ribbon.ages[oldest] >= lifeSeconds) {
                    ribbon.count--;
                } else break;
            }
            rebuildRibbonGeometry(ribbon, lifeSeconds);
        }
    }

    return {
        state,
        emitParticle,
        extendSkidRibbon,
        breakSkidRibbon,
        emitSurfaceEffects,
        updateSurfaceEffects,
    };
}
