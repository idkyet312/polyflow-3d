import * as THREE from 'three';

const LIGHT_GRID_DIMENSION = 3;
const LIGHT_TILE_SIZE = 0.82;
const LIGHT_TILE_HEIGHT = 0.34;
const LIGHT_TILE_GAP = 0.26;
const LIGHT_GRID_OFFSET = new THREE.Vector3(-4.5, 0, 3.5);

export function createLightGridController({
    scene,
    gsap,
    getRenderer,
    getCamera,
    gameplay,
    raycaster,
    pointerNdc,
    getGroundHeightAt,
    getAnchorTarget,
    terrainYOffset,
}) {
    let lightGridGroup = null;
    const lightGridTiles = [];

    function updateLightTileVisual(tile, isLit, immediate = false) {
        const material = tile.material;
        const nextColor = isLit ? 0xf4d35e : 0x16202c;
        const nextEmissive = isLit ? 0xffc247 : 0x000000;
        const nextEmissiveIntensity = isLit ? 1.65 : 0;
        const nextY = tile.userData.baseY + (isLit ? 0.07 : 0);
        const nextScale = isLit ? 1.08 : 1;

        tile.userData.gridLit = isLit;

        if (immediate) {
            material.color.setHex(nextColor);
            material.emissive.setHex(nextEmissive);
            material.emissiveIntensity = nextEmissiveIntensity;
            tile.position.y = nextY;
            tile.scale.setScalar(nextScale);
            return;
        }

        gsap.to(material.color, {
            r: new THREE.Color(nextColor).r,
            g: new THREE.Color(nextColor).g,
            b: new THREE.Color(nextColor).b,
            duration: 0.18,
            overwrite: true,
        });
        gsap.to(material.emissive, {
            r: new THREE.Color(nextEmissive).r,
            g: new THREE.Color(nextEmissive).g,
            b: new THREE.Color(nextEmissive).b,
            duration: 0.18,
            overwrite: true,
        });
        gsap.to(material, {
            emissiveIntensity: nextEmissiveIntensity,
            duration: 0.18,
            overwrite: true,
        });
        gsap.to(tile.position, {
            y: nextY,
            duration: 0.18,
            overwrite: true,
        });
        gsap.to(tile.scale, {
            x: nextScale,
            y: nextScale,
            z: nextScale,
            duration: 0.18,
            overwrite: true,
        });
    }

    function toggleLightTile(tile) {
        updateLightTileVisual(tile, !tile.userData.gridLit);
    }

    function build() {
        if (lightGridGroup) return;

        lightGridGroup = new THREE.Group();
        lightGridGroup.name = 'light-grid';

        const tileGeometry = new THREE.BoxGeometry(LIGHT_TILE_SIZE, LIGHT_TILE_HEIGHT, LIGHT_TILE_SIZE);
        const totalSpan = (LIGHT_GRID_DIMENSION - 1) * (LIGHT_TILE_SIZE + LIGHT_TILE_GAP);

        for (let row = 0; row < LIGHT_GRID_DIMENSION; row++) {
            for (let col = 0; col < LIGHT_GRID_DIMENSION; col++) {
                const tileMaterial = new THREE.MeshStandardMaterial({
                    color: 0x16202c,
                    emissive: 0x000000,
                    roughness: 0.24,
                    metalness: 0.18,
                });
                const tile = new THREE.Mesh(tileGeometry, tileMaterial);
                tile.castShadow = true;
                tile.receiveShadow = true;
                tile.userData.gridIndex = row * LIGHT_GRID_DIMENSION + col;
                tile.userData.gridLit = false;
                tile.userData.baseY = LIGHT_TILE_HEIGHT * 0.5;
                tile.position.set(
                    col * (LIGHT_TILE_SIZE + LIGHT_TILE_GAP) - totalSpan * 0.5,
                    tile.userData.baseY,
                    row * (LIGHT_TILE_SIZE + LIGHT_TILE_GAP) - totalSpan * 0.5
                );
                updateLightTileVisual(tile, false, true);
                lightGridTiles.push(tile);
                lightGridGroup.add(tile);
            }
        }

        position(getAnchorTarget());
        scene.add(lightGridGroup);
    }

    function position(anchorTarget) {
        if (!lightGridGroup) return;

        const anchorX = anchorTarget.x + LIGHT_GRID_OFFSET.x;
        const anchorZ = anchorTarget.z + LIGHT_GRID_OFFSET.z;
        const anchorY = getGroundHeightAt(anchorX, anchorZ, true) ?? terrainYOffset;

        lightGridGroup.position.set(anchorX, anchorY, anchorZ);
    }

    function handleClick(event) {
        const renderer = getRenderer?.();
        const camera = getCamera?.();

        if (!renderer || !camera || !lightGridTiles.length || gameplay.active || gameplay.pointerLocked) return;

        const rect = renderer.domElement.getBoundingClientRect();
        pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(pointerNdc, camera);
        const hit = raycaster.intersectObjects(lightGridTiles, false)[0];
        if (!hit?.object) return;

        toggleLightTile(hit.object);
    }

    return {
        build,
        position,
        handleClick,
    };
}
