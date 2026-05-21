// Primitive THREE mesh factory for spawned actors. Pure: takes a kind
// string ('sphere'|'cube'|'cylinder'|'capsule'), returns a Mesh with a
// preset material. No engine refs needed beyond THREE itself.

export function createPrimitiveMeshFactory(THREE) {
    return function buildPrimitiveActorMesh(kind) {
        if (kind === 'sphere') {
            return new THREE.Mesh(
                new THREE.SphereGeometry(1, 28, 20),
                new THREE.MeshStandardMaterial({
                    color: 0xf97316, metalness: 0.14, roughness: 0.34,
                    emissive: 0x331100, emissiveIntensity: 0.28,
                }),
            );
        }
        if (kind === 'cube') {
            return new THREE.Mesh(
                new THREE.BoxGeometry(2, 2, 2),
                new THREE.MeshStandardMaterial({
                    color: 0x60a5fa, metalness: 0.12, roughness: 0.38,
                    emissive: 0x0b1220, emissiveIntensity: 0.2,
                }),
            );
        }
        if (kind === 'cylinder') {
            return new THREE.Mesh(
                new THREE.CylinderGeometry(1, 1, 2, 32, 1, false),
                new THREE.MeshStandardMaterial({
                    color: 0x94a3b8, metalness: 0.1, roughness: 0.46,
                    emissive: 0x0f172a, emissiveIntensity: 0.16,
                }),
            );
        }
        if (kind === 'capsule') {
            return new THREE.Mesh(
                new THREE.CapsuleGeometry(1, 2, 8, 16),
                new THREE.MeshStandardMaterial({
                    color: 0x16a34a, metalness: 0.1, roughness: 0.4,
                    emissive: 0x052d12, emissiveIntensity: 0.22,
                }),
            );
        }
        return undefined;
    };
}
