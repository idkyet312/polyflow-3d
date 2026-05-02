import * as THREE from 'three';

export const VEHICLE_FX_SETTINGS = {
    maxParticles: 520,
    maxSkidMarks: 180,
    dustSpeed: 2.5,
    smokeSpeed: 3.5,
    skidSpeed: 5.5,
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

export function createVehicleFx({ getScene, vehicleSettings }) {
    const state = {
        group: null,
        particles: [],
        skidMarks: [],
        textures: {},
        skidMaterial: null,
    };

    function ensureGroup() {
        const scene = typeof getScene === 'function' ? getScene() : null;
        if (!scene) return null;
        if (!state.group) {
            state.group = new THREE.Group();
            state.group.name = 'vehicle-surface-fx';
            scene.add(state.group);
        }
        for (const kind of ['smoke', 'dust', 'spark']) {
            if (!state.textures[kind]) {
                state.textures[kind] = createVehicleFxTexture(kind);
            }
        }
        if (!state.skidMaterial) {
            state.skidMaterial = new THREE.MeshBasicMaterial({
                color: 0x101010,
                transparent: true,
                opacity: 0.42,
                depthWrite: false,
                side: THREE.DoubleSide,
            });
        }
        return state.group;
    }

    function emitParticle(kind, position, velocity, size = 0.35, life = 0.7) {
        const group = ensureGroup();
        if (!group) return;

        let particle = state.particles.find((entry) => entry.life <= 0);
        if (!particle && state.particles.length < VEHICLE_FX_SETTINGS.maxParticles) {
            const material = new THREE.SpriteMaterial({
                map: state.textures[kind] || state.textures.smoke,
                transparent: true,
                depthWrite: false,
                blending: kind === 'spark' ? THREE.AdditiveBlending : THREE.NormalBlending,
            });
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
        particle.sprite.material.map = state.textures[kind] || state.textures.smoke;
        particle.sprite.material.blending = kind === 'spark' ? THREE.AdditiveBlending : THREE.NormalBlending;
        particle.sprite.material.opacity = kind === 'spark' ? 1 : 0.65;
        particle.sprite.visible = true;
    }

    function emitSkidMark(position, forward, width, length, opacity) {
        const group = ensureGroup();
        if (!group) return;

        let mark = state.skidMarks.find((entry) => entry.life <= 0);
        if (!mark) {
            if (state.skidMarks.length >= VEHICLE_FX_SETTINGS.maxSkidMarks) {
                mark = state.skidMarks.shift();
                if (mark?.mesh?.parent) mark.mesh.parent.remove(mark.mesh);
            }
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), state.skidMaterial.clone());
            mesh.name = 'tire-skid-mark';
            group.add(mesh);
            mark = { mesh, life: 0, maxLife: 1 };
            state.skidMarks.push(mark);
        }

        mark.life = 9;
        mark.maxLife = 9;
        mark.mesh.visible = true;
        mark.mesh.position.copy(position);
        mark.mesh.position.y += 0.012;
        mark.mesh.scale.set(width, length, 1);
        mark.mesh.rotation.set(-Math.PI * 0.5, 0, Math.atan2(forward.x, forward.z));
        mark.mesh.material.opacity = opacity;
    }

    function emitSurfaceEffects(delta, data) {
        if (!data.grounded) return;

        const speed = Math.abs(data.forwardSpeed);
        const lateral = Math.abs(data.lateralSpeed);
        const slip = data.drifting || data.brakeHeld || lateral > 2.6;
        const dustAmount = THREE.MathUtils.clamp((speed - VEHICLE_FX_SETTINGS.dustSpeed) / 13, 0, 1);
        const smokeAmount = THREE.MathUtils.clamp((speed - VEHICLE_FX_SETTINGS.smokeSpeed) / 12 + lateral / 8, 0, 1);
        const skidAmount = slip ? THREE.MathUtils.clamp((speed - VEHICLE_FX_SETTINGS.skidSpeed) / 18 + lateral / 10, 0, 1) : 0;
        const rearCorners = data.cornerSamples.slice(2);

        rearCorners.forEach((corner) => {
            if (corner.rideHeight === null) return;
            const wheelPos = data.vehiclePosition.clone()
                .addScaledVector(data.flatForward, corner.forward)
                .addScaledVector(data.flatRight, corner.sideways);
            wheelPos.y -= Math.min(corner.rideHeight, vehicleSettings.suspensionRideHeight);

            if (dustAmount > 0 && Math.random() < dustAmount * 18 * delta) {
                emitParticle(
                    'dust',
                    wheelPos.clone().addScaledVector(data.flatRight, (Math.random() - 0.5) * 0.18),
                    data.flatForward.clone().multiplyScalar(-speed * (0.12 + Math.random() * 0.08)).addScaledVector(_upVector, 0.45 + Math.random() * 0.55),
                    0.34 + dustAmount * 0.62 + Math.random() * 0.16,
                    0.55 + Math.random() * 0.55
                );
            }
            if (smokeAmount > 0.08 && slip && Math.random() < smokeAmount * 26 * delta) {
                emitParticle(
                    'smoke',
                    wheelPos.clone().addScaledVector(data.flatRight, (Math.random() - 0.5) * 0.24),
                    data.flatForward.clone().multiplyScalar(-0.8 - Math.random() * 1.1)
                        .addScaledVector(data.flatRight, (Math.random() - 0.5) * 0.65)
                        .addScaledVector(_upVector, 0.85 + Math.random() * 0.75),
                    0.62 + smokeAmount * 1.05 + Math.random() * 0.28,
                    1.05 + Math.random() * 0.95
                );
            }
            if (skidAmount > 0.05 && Math.random() < skidAmount * 18 * delta) {
                emitSkidMark(wheelPos, data.flatForward, 0.18, 0.7 + speed * 0.025, 0.18 + skidAmount * 0.28);
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
            particle.sprite.material.opacity = (particle.kind === 'spark' ? 1 : 0.65) * (1 - t);
        }

        for (const mark of state.skidMarks) {
            if (mark.life <= 0) continue;
            mark.life -= delta;
            if (mark.life <= 0) {
                mark.mesh.visible = false;
                continue;
            }
            mark.mesh.material.opacity *= Math.pow(0.86, delta);
        }
    }

    return {
        state,
        emitParticle,
        emitSkidMark,
        emitSurfaceEffects,
        updateSurfaceEffects,
    };
}
