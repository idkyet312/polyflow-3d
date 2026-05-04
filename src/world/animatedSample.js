// src/world/animatedSample.js
// Extracted from main.js (chore/main-js-shrink-2). Owns the procedural sample
// model + its keyframe tracks (used by the "Load sample" button) and the
// example HUD widget set that demos the UMG-style widget API.

import * as THREE from 'three';

let scene;
let getCurrentMesh, setCurrentMesh;
let getWidgetManager, getRuntimeHud;
let UTextWidget, UProgressBarWidget;
let clearCurrentMesh, normalizeCurrentMesh, refreshGameplayWorld;
let updateLoadedAssetStats, enableOptimizationPipeline, playObjectAnimation;

export function installAnimatedSample(deps) {
    ({
        scene,
        getCurrentMesh, setCurrentMesh,
        getWidgetManager, getRuntimeHud,
        UTextWidget, UProgressBarWidget,
        clearCurrentMesh, normalizeCurrentMesh, refreshGameplayWorld,
        updateLoadedAssetStats, enableOptimizationPipeline, playObjectAnimation,
    } = deps);
}

export function createExampleWidgets() {
    if (!getWidgetManager()) return;

    const hud = getRuntimeHud();

    const scoreWidget = hud.CreateWidget(UTextWidget, {
        Text: 'Score: 0',
        fontSize: 20,
        color: '#ffff00',
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        position: { x: 0.05, y: 0.9 }, // Top-left corner
        visible: true,
    });
    scoreWidget.AddToViewport(20);

    const healthBar = hud.CreateWidget(UProgressBarWidget, {
        Percent: 1.0,
        width: 200,
        height: 20,
        fillColor: '#00ff00',
        backgroundColor: '#333333',
        position: { x: 0.05, y: 0.8 }, // Below score
        visible: true,
    });
    healthBar.AddToViewport(19);

    const speedWidget = hud.CreateWidget(UTextWidget, {
        Text: 'Speed: 0 km/h',
        fontSize: 16,
        color: '#00ffff',
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        position: { x: 0.05, y: 0.7 }, // Below health bar
        visible: true,
    });
    speedWidget.AddToViewport(18);

    // Store widget handles globally for easy access
    window.exampleWidgets = {
        score: scoreWidget,
        health: healthBar,
        speed: speedWidget,
    };
    window.gameHud = hud;

    // Initialize score system
    window.gameScore = 0;

    if (window.DEBUG_WIDGET_API) {
        console.log('Example widgets created:', window.exampleWidgets);
        console.log('Widget API available at window.WidgetAPI');
        console.log('Unreal widget API available at window.UnrealWidgetAPI');
        console.log('Example usage:');
        console.log('  WidgetAPI.createWidget("text", {text: "Hello!", position: {x: 0.5, y: 0.5}})');
        console.log('  UnrealWidgetAPI.CreateWidget(UTextWidget, { Text: "Hello HUD" }).AddToViewport(25)');
    }
}

export function makeAnimatedSampleQuatTrack(name, eulers) {
    const values = [];
    const quaternion = new THREE.Quaternion();
    eulers.forEach(([x, y, z]) => {
        quaternion.setFromEuler(new THREE.Euler(x, y, z));
        values.push(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    });
    return new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0, 0.5, 1.0, 1.5, 2.0], values);
}

export function makeAnimatedSamplePart(name, geometry, material, position, rotation = [0, 0, 0]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.fromArray(position);
    mesh.rotation.set(...rotation);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

export function createAnimatedSampleModel() {
    const root = new THREE.Group();
    root.name = 'PolyFlow_Animated_Test_Rig';

    const chrome = new THREE.MeshStandardMaterial({ color: 0xd9f0ff, metalness: 0.45, roughness: 0.22 });
    const teal = new THREE.MeshStandardMaterial({ color: 0x00d8ff, emissive: 0x006b80, emissiveIntensity: 0.8, metalness: 0.12, roughness: 0.3 });
    const coral = new THREE.MeshStandardMaterial({ color: 0xff5e7a, emissive: 0x6b1022, emissiveIntensity: 0.55, metalness: 0.08, roughness: 0.36 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x182033, metalness: 0.2, roughness: 0.48 });
    const gold = new THREE.MeshStandardMaterial({ color: 0xffd36a, emissive: 0x8a4b00, emissiveIntensity: 0.35, metalness: 0.2, roughness: 0.28 });

    root.add(
        makeAnimatedSamplePart('Rig_Base', new THREE.CylinderGeometry(0.8, 0.95, 0.08, 64), dark, [0, 0, 0]),
        makeAnimatedSamplePart('Rig_Body', new THREE.CapsuleGeometry(0.34, 0.78, 8, 18), chrome, [0, 1.42, 0]),
        makeAnimatedSamplePart('Rig_Chest_Core', new THREE.TorusGeometry(0.28, 0.025, 12, 48), teal, [0, 1.54, -0.31]),
        makeAnimatedSamplePart('Rig_Head', new THREE.SphereGeometry(0.27, 32, 20), chrome, [0, 2.1, 0]),
        makeAnimatedSamplePart('Rig_Visor', new THREE.BoxGeometry(0.38, 0.08, 0.035), teal, [0, 2.13, -0.24]),
        makeAnimatedSamplePart('Rig_LeftArm', new THREE.CapsuleGeometry(0.08, 0.72, 6, 12), coral, [-0.5, 1.5, 0], [0, 0.2, -0.22]),
        makeAnimatedSamplePart('Rig_RightArm', new THREE.CapsuleGeometry(0.08, 0.72, 6, 12), coral, [0.5, 1.5, 0], [0, -0.2, 0.22]),
        makeAnimatedSamplePart('Rig_LeftLeg', new THREE.CapsuleGeometry(0.1, 0.82, 6, 12), dark, [-0.18, 0.62, 0], [0.08, 0, 0.06]),
        makeAnimatedSamplePart('Rig_RightLeg', new THREE.CapsuleGeometry(0.1, 0.82, 6, 12), dark, [0.18, 0.62, 0], [-0.08, 0, -0.06]),
        makeAnimatedSamplePart('Rig_Halo', new THREE.TorusGeometry(0.62, 0.018, 12, 96), gold, [0, 2.12, 0], [Math.PI / 2, 0, 0]),
        makeAnimatedSamplePart('Rig_Energy_Ring', new THREE.TorusGeometry(0.9, 0.02, 12, 128), teal, [0, 0.06, 0], [Math.PI / 2, 0, 0])
    );

    const times = [0, 0.5, 1.0, 1.5, 2.0];
    root.animations = [new THREE.AnimationClip('Neon_Run_Loop', 2, [
        new THREE.VectorKeyframeTrack('Rig_Body.position', times, [0, 1.42, 0, 0, 1.56, -0.04, 0, 1.42, 0, 0, 1.56, 0.04, 0, 1.42, 0]),
        new THREE.VectorKeyframeTrack('Rig_Head.position', times, [0, 2.1, 0, 0, 2.22, -0.03, 0, 2.1, 0, 0, 2.22, 0.03, 0, 2.1, 0]),
        new THREE.VectorKeyframeTrack('Rig_Energy_Ring.scale', times, [1, 1, 1, 1.12, 1.12, 1.12, 1, 1, 1, 1.12, 1.12, 1.12, 1, 1, 1]),
        makeAnimatedSampleQuatTrack('Rig_LeftArm', [[0.9, 0, -0.35], [-0.95, 0, -0.22], [0.9, 0, -0.35], [-0.95, 0, -0.22], [0.9, 0, -0.35]]),
        makeAnimatedSampleQuatTrack('Rig_RightArm', [[-0.9, 0, 0.35], [0.95, 0, 0.22], [-0.9, 0, 0.35], [0.95, 0, 0.22], [-0.9, 0, 0.35]]),
        makeAnimatedSampleQuatTrack('Rig_LeftLeg', [[-0.55, 0, 0.08], [0.62, 0, 0.02], [-0.55, 0, 0.08], [0.62, 0, 0.02], [-0.55, 0, 0.08]]),
        makeAnimatedSampleQuatTrack('Rig_RightLeg', [[0.62, 0, -0.02], [-0.55, 0, -0.08], [0.62, 0, -0.02], [-0.55, 0, -0.08], [0.62, 0, -0.02]]),
        makeAnimatedSampleQuatTrack('Rig_Halo', [[Math.PI / 2, 0, 0], [Math.PI / 2, 0, Math.PI], [Math.PI / 2, 0, Math.PI * 2], [Math.PI / 2, 0, Math.PI * 3], [Math.PI / 2, 0, Math.PI * 4]]),
        makeAnimatedSampleQuatTrack('Rig_Energy_Ring', [[Math.PI / 2, 0, 0], [Math.PI / 2, 0, -Math.PI], [Math.PI / 2, 0, -Math.PI * 2], [Math.PI / 2, 0, -Math.PI * 3], [Math.PI / 2, 0, -Math.PI * 4]]),
    ])];

    return root;
}

export function loadSample() {
    clearCurrentMesh();

    setCurrentMesh(createAnimatedSampleModel());
    scene.add(getCurrentMesh());
    normalizeCurrentMesh();
    playObjectAnimation(getCurrentMesh());
    refreshGameplayWorld();
    updateLoadedAssetStats('PolyFlow_Animated_Test_Rig.glb', 5400000, getCurrentMesh());
    enableOptimizationPipeline();
}
