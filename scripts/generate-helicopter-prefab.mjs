import fs from 'node:fs';
import * as THREE from 'three';

function part(geometry, material, name, position, rotation = null, scale = null) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(...position);
    if (rotation) mesh.rotation.set(...rotation);
    if (scale) mesh.scale.set(...scale);
    return mesh;
}

const root = new THREE.Group();
root.name = 'Helicopter';

const paint = new THREE.MeshStandardMaterial({ color: 0x2563eb, metalness: 0.28, roughness: 0.34, emissive: 0x061a3f, emissiveIntensity: 0.14 });
const glass = new THREE.MeshStandardMaterial({ color: 0x9be7ff, metalness: 0.08, roughness: 0.12, transparent: true, opacity: 0.62, emissive: 0x12384d, emissiveIntensity: 0.18 });
const dark = new THREE.MeshStandardMaterial({ color: 0x111827, metalness: 0.35, roughness: 0.42 });
const metal = new THREE.MeshStandardMaterial({ color: 0xa7b0bf, metalness: 0.58, roughness: 0.26 });

root.add(
    part(new THREE.CapsuleGeometry(0.48, 1.85, 8, 18), paint, 'helicopter-fuselage', [0, 0, -0.18], [Math.PI / 2, 0, 0], [1.08, 0.82, 0.82]),
    part(new THREE.SphereGeometry(0.42, 24, 16), glass, 'helicopter-cockpit', [0, 0.1, -1.12], null, [1.05, 0.7, 0.86]),
    part(new THREE.CylinderGeometry(0.08, 0.13, 2.35, 14), paint, 'helicopter-tail-boom', [0, 0.06, 1.62], [Math.PI / 2, 0, 0]),
    part(new THREE.BoxGeometry(0.12, 0.72, 0.48), paint, 'helicopter-tail-fin', [0, 0.42, 2.72], [0.25, 0, 0]),
    part(new THREE.CylinderGeometry(0.07, 0.07, 0.52, 16), metal, 'helicopter-rotor-mast', [0, 0.68, -0.12]),
    part(new THREE.CylinderGeometry(0.035, 0.035, 2.45, 10), metal, 'helicopter-left-skid', [-0.48, -0.58, -0.1], [Math.PI / 2, 0, 0]),
    part(new THREE.CylinderGeometry(0.035, 0.035, 2.45, 10), metal, 'helicopter-right-skid', [0.48, -0.58, -0.1], [Math.PI / 2, 0, 0]),
    part(new THREE.CylinderGeometry(0.025, 0.025, 1.08, 8), metal, 'helicopter-front-skid-bar', [0, -0.38, -0.82], [0, 0, Math.PI / 2]),
    part(new THREE.CylinderGeometry(0.025, 0.025, 1.08, 8), metal, 'helicopter-rear-skid-bar', [0, -0.38, 0.82], [0, 0, Math.PI / 2])
);

const mainRotor = new THREE.Group();
mainRotor.name = 'helicopter-main-rotor';
mainRotor.position.set(0, 0.98, -0.12);
mainRotor.add(
    part(new THREE.BoxGeometry(3.35, 0.035, 0.16), dark, 'helicopter-main-blade-a', [0, 0, 0]),
    part(new THREE.BoxGeometry(0.16, 0.035, 3.35), dark, 'helicopter-main-blade-b', [0, 0, 0]),
    part(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 18), metal, 'helicopter-main-hub', [0, 0, 0])
);
root.add(mainRotor);

const tailRotor = new THREE.Group();
tailRotor.name = 'helicopter-tail-rotor';
tailRotor.position.set(0, 0.37, 2.92);
tailRotor.add(
    part(new THREE.BoxGeometry(0.72, 0.035, 0.08), dark, 'helicopter-tail-blade-a', [0, 0, 0]),
    part(new THREE.BoxGeometry(0.08, 0.72, 0.035), dark, 'helicopter-tail-blade-b', [0, 0, 0]),
    part(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 12), metal, 'helicopter-tail-hub', [0, 0, 0], [Math.PI / 2, 0, 0])
);
root.add(tailRotor);

const actor = {
    version: 1,
    type: 'polyflow-actor',
    actor: {
        id: 'prefab-helicopter',
        kind: 'imported',
        name: 'Helicopter',
        templateId: '',
        vehicleBodyTemplateId: null,
        vehicleWheelTemplateId: null,
        userData: { label: 'Helicopter', prefabId: 'helicopter' },
        transform: {
            position: [0, 2, 0],
            quaternion: [0, 0, 0, 1],
            scale: [1, 1, 1],
        },
        material: null,
        materialOverrides: [],
        scripts: {
            tick: `function Tick(DeltaTime) {
    const root = object || Self?.mesh;
    root?.getObjectByName('helicopter-main-rotor')?.rotateY(DeltaTime * 24);
    root?.getObjectByName('helicopter-tail-rotor')?.rotateZ(DeltaTime * 36);
}`,
            tickEnabled: true,
            collision: '',
        },
        componentFlags: { collision: true, physics: true, scripts: true },
        components: [],
        terrainState: null,
        rootJson: root.toJSON(),
    },
};

fs.writeFileSync('public/prefabs/helicopter.actor', JSON.stringify(actor));
