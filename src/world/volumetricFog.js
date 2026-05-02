import * as THREE from 'three';

const DEFAULT_SETTINGS = {
    enabled: true,
    color: 0xd8dee6,
    sceneFogColor: 0x58616c,
    density: 0.012,
    layerCount: 34,
    radius: 92,
    height: 18,
    opacity: 0.055,
    driftSpeed: 0.018,
};

function createFogNoiseTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(canvas.width, canvas.height);

    for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
            const i = (y * canvas.width + x) * 4;
            const nx = x / canvas.width - 0.5;
            const ny = y / canvas.height - 0.5;
            const edge = THREE.MathUtils.clamp(1 - Math.hypot(nx, ny) * 2.0, 0, 1);
            const wave = Math.sin(x * 0.085) * 0.16 + Math.sin((x + y) * 0.045) * 0.14;
            const grain = Math.random() * 0.55;
            const alpha = Math.pow(edge, 1.8) * THREE.MathUtils.clamp(0.2 + wave + grain, 0, 1);
            image.data[i + 0] = 255;
            image.data[i + 1] = 255;
            image.data[i + 2] = 255;
            image.data[i + 3] = Math.floor(alpha * 255);
        }
    }

    ctx.putImageData(image, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

export function createVolumetricFog({ scene, camera, settings = {} }) {
    const config = { ...DEFAULT_SETTINGS, ...settings };
    const state = {
        group: new THREE.Group(),
        layers: [],
        texture: createFogNoiseTexture(),
        time: 0,
    };

    state.group.name = 'volumetric-fog';
    state.group.renderOrder = -10;
    state.group.userData.ignoreForcedSceneShadows = true;

    const fogSheetColor = new THREE.Color(config.color).multiplyScalar(0.42);
    const material = new THREE.MeshBasicMaterial({
        color: fogSheetColor,
        map: state.texture,
        transparent: true,
        opacity: config.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
        toneMapped: false,
    });

    const geometry = new THREE.PlaneGeometry(config.radius * 2, config.radius * 2);
    for (let i = 0; i < config.layerCount; i++) {
        const mesh = new THREE.Mesh(geometry, material.clone());
        const t = config.layerCount === 1 ? 0 : i / (config.layerCount - 1);
        mesh.rotation.x = -Math.PI * 0.5;
        mesh.position.y = THREE.MathUtils.lerp(0.2, config.height, t);
        mesh.rotation.z = Math.random() * Math.PI * 2;
        mesh.material.opacity = config.opacity * THREE.MathUtils.lerp(0.35, 1.0, 1 - Math.abs(t - 0.45));
        mesh.userData.fogPhase = Math.random() * Math.PI * 2;
        mesh.userData.fogDrift = new THREE.Vector2(Math.random() - 0.5, Math.random() - 0.5).normalize();
        mesh.frustumCulled = false;
        state.group.add(mesh);
        state.layers.push(mesh);
    }

    function applyEnabled() {
        state.group.visible = config.enabled;
        scene.fog = config.enabled ? new THREE.FogExp2(config.sceneFogColor, config.density) : null;
    }

    function update(delta) {
        if (!config.enabled || !camera) return;

        state.time += delta;
        state.group.position.x = camera.position.x;
        state.group.position.z = camera.position.z;
        state.group.position.y = Math.max(-0.25, camera.position.y - config.height * 0.48);

        for (let i = 0; i < state.layers.length; i++) {
            const layer = state.layers[i];
            const drift = layer.userData.fogDrift;
            const phase = layer.userData.fogPhase;
            const speed = config.driftSpeed * (0.6 + i / state.layers.length);
            layer.position.x = Math.sin(state.time * speed + phase) * config.radius * 0.18 + drift.x * state.time * 0.12;
            layer.position.z = Math.cos(state.time * speed + phase) * config.radius * 0.18 + drift.y * state.time * 0.12;
            layer.rotation.z += delta * speed * 0.08;
        }
    }

    function setEnabled(enabled) {
        config.enabled = !!enabled;
        applyEnabled();
    }

    scene.add(state.group);
    applyEnabled();

    return {
        state,
        update,
        setEnabled,
        isEnabled: () => config.enabled,
    };
}
