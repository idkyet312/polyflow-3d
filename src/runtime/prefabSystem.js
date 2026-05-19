import * as THREE from 'three';
import { prefabRegistry } from '../runtime/assets/PrefabRegistry.js';
import { assetRegistry } from '../runtime/assets/AssetRegistry.js';
import { HELICOPTER_USER_SCRIPT } from '../gameplay/prefabScripts.js';
import { core } from '../runtime/appCore.js';

// Prefab system: manifest loading, builtin prefab registry, helicopter
// prefab mesh + spawn, prefab-browser UI, and load-actor-file wiring.
// Extracted from runtime.js. scene/camera come through live getters (they
// are reassigned module refs in runtime.js). Instantiated eagerly at module
// scope in runtime.js (NOT wireExtractedModules) because init() calls
// registerBuiltinPrefabs/loadPrefabManifest before that wiring runs.
export function createPrefabSystem(deps) {
    const {
        dynamicBodySpatial, gameplay, objectScriptState, physics,
        tempVectorD, tempVectorE,
        createDynamicPrimitiveBody, createOwnedShape, getActorKindDefaultScale,
        getActorKindLabel, getActorRenderObject, getDynamicPropSpawn,
        invalidateDDGI, isLightActorKind, refreshSceneUI, saveObjectScriptDrafts,
        selectShowcaseActor, spawnDynamicPrimitive, spawnGameplayPrefab,
        spawnLightActor, createDynamicPropActor, loadActorFromFile,
        setActorComponentFlags, syncPropScriptState,
    } = deps;

    const PREFAB_MANIFEST_URL = assetRegistry.resolvePrefabManifest();
    const PREFAB_CATEGORY_ORDER = ['Vehicles', 'Lights', 'Shapes', 'Gameplay', 'Weapons', 'AI'];
    const BUILTIN_PREFAB_ITEMS = [
        { id: 'helicopter', name: 'Helicopter', category: 'Vehicles', modelPrefab: 'helicopter', image: 'helicopter.svg' },
        { id: 'point-light', name: 'Point Light', category: 'Lights', kind: 'pointLight', image: 'light-point.svg' },
        { id: 'spot-light', name: 'Spot Light', category: 'Lights', kind: 'spotLight', image: 'light-spot.svg' },
        { id: 'sphere', name: 'Sphere', category: 'Shapes', kind: 'sphere', image: 'shape-sphere.svg' },
        { id: 'cube', name: 'Cube', category: 'Shapes', kind: 'cube', image: 'shape-cube.svg' },
        { id: 'cylinder', name: 'Cylinder', category: 'Shapes', kind: 'cylinder', image: 'shape-cylinder.svg' },
        { id: 'capsule', name: 'Capsule', category: 'Shapes', kind: 'capsule', image: 'shape-capsule.svg' },
        { id: 'player-spawn', name: 'Player Spawn', category: 'Gameplay', gameplayPrefab: 'playerSpawn', image: 'gameplay-spawn.svg' },
        { id: 'teleporter', name: 'Teleporter', category: 'Gameplay', gameplayPrefab: 'teleporter', image: 'gameplay-teleporter.svg' },
        { id: 'coin', name: 'Coin +10', category: 'Gameplay', gameplayPrefab: 'coin', image: 'gameplay-coin.svg' },
        { id: 'health-pickup', name: 'Health +35%', category: 'Gameplay', gameplayPrefab: 'healthPickup', image: 'gameplay-coin.svg' },
        { id: 'target', name: 'Target +25', category: 'Gameplay', gameplayPrefab: 'target', image: 'gameplay-target.svg' },
        { id: 'doom-shotgun-sprite', name: 'Doom Shotgun Sprite', category: 'Weapons', gameplayPrefab: 'doomShotgunSprite', image: 'doom-shotgun.svg' },
        { id: 'navmesh-circle-ai', name: 'Circle Patrol AI', category: 'AI', gameplayPrefab: 'navmeshCircleAi', image: 'ai-navmesh-circle.svg' },
        { id: 'shooter-ai', name: 'Shooter AI', category: 'AI', gameplayPrefab: 'shooterAi', image: 'ai-shooter.svg' },
        { id: 'doom-enemy', name: 'Doom Enemy', category: 'AI', gameplayPrefab: 'doomEnemy', image: 'doom-enemy.svg' },
        { id: 'shooter-spawner', name: 'Shooter Spawner', category: 'AI', gameplayPrefab: 'shooterSpawner', image: 'ai-shooter.svg' },
        { id: 'smg', name: 'SMG', category: 'AI', gameplayPrefab: 'smg', image: 'ai-shooter.svg' },
        { id: 'sniper-rifle', name: 'Bolt Action Sniper Rifle', category: 'AI', gameplayPrefab: 'sniperRifle', image: 'ai-shooter.svg' },
    ];
    let prefabManifestCache = null;
    let builtinPrefabsRegistered = false;

    function registerBuiltinPrefabs() {
        if (builtinPrefabsRegistered) return;
        builtinPrefabsRegistered = true;
        prefabRegistry.registerMany(BUILTIN_PREFAB_ITEMS);
    }

    async function loadPrefabManifest() {
        if (prefabManifestCache) return prefabManifestCache;
        try {
            const manifestResponse = await fetch(PREFAB_MANIFEST_URL);
            if (!manifestResponse.ok) {
                throw new Error(`Prefab manifest failed: ${manifestResponse.status}`);
            }
            prefabManifestCache = await manifestResponse.json();
            prefabRegistry.registerMany(prefabManifestCache.prefabs || [], { category: 'Vehicles' });
        } catch (err) {
            console.warn('Prefab manifest unavailable. Using built-in prefabs only.', err);
            prefabManifestCache = { prefabs: [] };
        }
        return prefabManifestCache;
    }

    async function loadPrefab(prefab) {
        const button = document.getElementById('load-prefab-btn');
        const previousText = button?.textContent;
        const status = document.getElementById('prefab-browser-status');
        if (button) {
            button.disabled = true;
            button.textContent = 'Loading...';
        }
        if (status) status.textContent = `Loading ${prefab?.name || 'prefab'}...`;

        try {
            if (!prefab?.file) {
                throw new Error('Prefab has no file.');
            }

            const prefabUrl = new URL(prefab.file, new URL(PREFAB_MANIFEST_URL, window.location.href));
            const prefabCacheKey = prefabUrl.href;
            let file = prefabRegistry.getCachedActorFile(prefabCacheKey);
            if (!file) {
                const prefabResponse = await fetch(prefabUrl);
                if (!prefabResponse.ok) {
                    throw new Error(`Prefab failed: ${prefabResponse.status}`);
                }
                const blob = await prefabResponse.blob();
                file = new File([blob], prefab.file, { type: 'application/json' });
                prefabRegistry.cacheActorFile(prefabCacheKey, file);
            }
            await loadActorFromFile(file, {
                askSpawnLocation: false,
                spawnInFrontOfPlayer: true,
                prefab,
            });
            closePrefabBrowser();
        } catch (err) {
            console.error('Failed to load prefab.', err);
            if (status) status.textContent = 'Failed to load prefab.';
            alert('Failed to load prefab.');
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = previousText || 'Load Prefab';
            }
        }
    }

    function prefabAssetUrl(path = 'car.svg') {
        return new URL(path, new URL(PREFAB_MANIFEST_URL, window.location.href));
    }

    function makeHelicopterMeshPart(geometry, material, name, position, rotation = null, scale = null) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = name;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.position.set(position[0], position[1], position[2]);
        if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
        if (scale) mesh.scale.set(scale[0], scale[1], scale[2]);
        return mesh;
    }

    function createHelicopterPrefabMesh() {
        const root = new THREE.Group();
        root.name = 'Helicopter';

        const paint = new THREE.MeshStandardMaterial({
            color: 0x2563eb,
            metalness: 0.28,
            roughness: 0.34,
            emissive: 0x061a3f,
            emissiveIntensity: 0.14,
        });
        const glass = new THREE.MeshStandardMaterial({
            color: 0x9be7ff,
            metalness: 0.08,
            roughness: 0.12,
            transparent: true,
            opacity: 0.62,
            emissive: 0x12384d,
            emissiveIntensity: 0.18,
        });
        const dark = new THREE.MeshStandardMaterial({
            color: 0x111827,
            metalness: 0.35,
            roughness: 0.42,
        });
        const metal = new THREE.MeshStandardMaterial({
            color: 0xa7b0bf,
            metalness: 0.58,
            roughness: 0.26,
        });

        const fuselage = makeHelicopterMeshPart(
            new THREE.CapsuleGeometry(0.48, 1.85, 8, 18),
            paint,
            'helicopter-fuselage',
            [0, 0, -0.18],
            [Math.PI / 2, 0, 0],
            [1.08, 0.82, 0.82]
        );
        const cockpit = makeHelicopterMeshPart(
            new THREE.SphereGeometry(0.42, 24, 16),
            glass,
            'helicopter-cockpit',
            [0, 0.1, -1.12],
            null,
            [1.05, 0.7, 0.86]
        );
        const tailBoom = makeHelicopterMeshPart(
            new THREE.CylinderGeometry(0.08, 0.13, 2.35, 14),
            paint,
            'helicopter-tail-boom',
            [0, 0.06, 1.62],
            [Math.PI / 2, 0, 0]
        );
        const tailFin = makeHelicopterMeshPart(
            new THREE.BoxGeometry(0.12, 0.72, 0.48),
            paint,
            'helicopter-tail-fin',
            [0, 0.42, 2.72],
            [0.25, 0, 0]
        );
        const mast = makeHelicopterMeshPart(
            new THREE.CylinderGeometry(0.07, 0.07, 0.52, 16),
            metal,
            'helicopter-rotor-mast',
            [0, 0.68, -0.12]
        );
        const skidLeft = makeHelicopterMeshPart(
            new THREE.CylinderGeometry(0.035, 0.035, 2.45, 10),
            metal,
            'helicopter-left-skid',
            [-0.48, -0.58, -0.1],
            [Math.PI / 2, 0, 0]
        );
        const skidRight = makeHelicopterMeshPart(
            new THREE.CylinderGeometry(0.035, 0.035, 2.45, 10),
            metal,
            'helicopter-right-skid',
            [0.48, -0.58, -0.1],
            [Math.PI / 2, 0, 0]
        );
        const skidBarFront = makeHelicopterMeshPart(
            new THREE.CylinderGeometry(0.025, 0.025, 1.08, 8),
            metal,
            'helicopter-front-skid-bar',
            [0, -0.38, -0.82],
            [0, 0, Math.PI / 2]
        );
        const skidBarRear = makeHelicopterMeshPart(
            new THREE.CylinderGeometry(0.025, 0.025, 1.08, 8),
            metal,
            'helicopter-rear-skid-bar',
            [0, -0.38, 0.82],
            [0, 0, Math.PI / 2]
        );

        const mainRotor = new THREE.Group();
        mainRotor.name = 'helicopter-main-rotor';
        mainRotor.position.set(0, 0.98, -0.12);
        mainRotor.add(
            makeHelicopterMeshPart(new THREE.BoxGeometry(3.35, 0.035, 0.16), dark, 'helicopter-main-blade-a', [0, 0, 0]),
            makeHelicopterMeshPart(new THREE.BoxGeometry(0.16, 0.035, 3.35), dark, 'helicopter-main-blade-b', [0, 0, 0]),
            makeHelicopterMeshPart(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 18), metal, 'helicopter-main-hub', [0, 0, 0])
        );

        const tailRotor = new THREE.Group();
        tailRotor.name = 'helicopter-tail-rotor';
        tailRotor.position.set(0, 0.37, 2.92);
        tailRotor.add(
            makeHelicopterMeshPart(new THREE.BoxGeometry(0.72, 0.035, 0.08), dark, 'helicopter-tail-blade-a', [0, 0, 0]),
            makeHelicopterMeshPart(new THREE.BoxGeometry(0.08, 0.72, 0.035), dark, 'helicopter-tail-blade-b', [0, 0, 0]),
            makeHelicopterMeshPart(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 12), metal, 'helicopter-tail-hub', [0, 0, 0], [Math.PI / 2, 0, 0])
        );

        root.add(
            fuselage,
            cockpit,
            tailBoom,
            tailFin,
            mast,
            skidLeft,
            skidRight,
            skidBarFront,
            skidBarRear,
            mainRotor,
            tailRotor
        );
        return root;
    }

    function findExistingHelicopterProp() {
        return physics.dynamicBodies.find((prop) => prop?.userData?.prefabId === 'helicopter') ?? null;
    }

    function spawnHelicopterPrefab() {
        if (!physics.ready || !core.scene || !core.camera) {
            console.warn('Jolt physics is not ready yet.');
            return null;
        }

        const existing = findExistingHelicopterProp();
        if (existing) {
            const status = document.getElementById('prefab-browser-status');
            if (status) status.textContent = 'Helicopter already in scene.';
            return existing;
        }

        const { Jolt } = physics;
        const spawnPosition = tempVectorD;
        const launchImpulse = tempVectorE;
        getDynamicPropSpawn(spawnPosition, launchImpulse);

        const halfExtentVector = new Jolt.Vec3(0.82, 0.62, 1.72);
        const shape = createOwnedShape(new Jolt.BoxShapeSettings(halfExtentVector, 0.05));
        Jolt.destroy(halfExtentVector);

        const body = createDynamicPrimitiveBody(shape, spawnPosition, launchImpulse, {
            restitution: 0.08,
            friction: 0.72,
            mass: 220,
            linearDamping: 0.36,
            angularDamping: 0.54,
        });
        if (!body) return null;

        const mesh = createHelicopterPrefabMesh();
        mesh.position.copy(spawnPosition);
        mesh.userData.prefabId = 'helicopter';

        const actor = createDynamicPropActor({
            body,
            mesh,
            kind: 'imported',
            userData: {
                label: 'Helicopter',
                prefabId: 'helicopter',
            },
            includeScripts: true,
        });
        setActorComponentFlags(actor, {
            collision: true,
            physics: true,
            scripts: true,
        });

        objectScriptState.drafts[actor.id] = {
            tick: HELICOPTER_USER_SCRIPT,
            tickEnabled: true,
            collision: '',
        };
        syncPropScriptState(actor);
        saveObjectScriptDrafts();

        physics.dynamicBodies.push(actor);
        dynamicBodySpatial.updateEntry(actor);
        invalidateDDGI('helicopter spawned');
        return actor;
    }

    function spawnBuiltinPrefab(prefab) {
        if (prefab?.gameplayPrefab) {
            const actor = spawnGameplayPrefab(prefab.gameplayPrefab);
            if (actor) {
                tagPrefabInstance(actor, prefab);
            }
            closePrefabBrowser();
            return;
        }

        if (prefab?.modelPrefab === 'helicopter') {
            const actor = spawnHelicopterPrefab();
            if (!actor) {
                const status = document.getElementById('prefab-browser-status');
                if (status) status.textContent = 'Failed to spawn Helicopter.';
                return;
            }

            refreshSceneUI();
            tagPrefabInstance(actor, prefab);
            selectShowcaseActor(actor.id);
            closePrefabBrowser();
            return;
        }

        const kind = prefab?.kind || 'sphere';
        const label = prefab?.name || getActorKindLabel(kind);
        let actor = null;

        if (isLightActorKind(kind)) {
            actor = spawnLightActor(kind, {
                userData: { label },
                includeScripts: true,
                scale: Number.parseFloat(getActorKindDefaultScale(kind)),
            });
        } else {
            const scale = Number.parseFloat(getActorKindDefaultScale(kind));
            actor = spawnDynamicPrimitive(kind, undefined, scale, {
                includeCollisionBody: true,
                simulatePhysics: true,
                includeScripts: true,
                userData: { label },
                returnActor: true,
            });
        }

        if (!actor) {
            const status = document.getElementById('prefab-browser-status');
            if (status) status.textContent = `Failed to spawn ${label}.`;
            return;
        }

        refreshSceneUI();
        tagPrefabInstance(actor, prefab);
        selectShowcaseActor(actor.id);
        closePrefabBrowser();
    }

    function tagPrefabInstance(actor, prefab) {
        if (!actor || !prefab?.id) return actor;
        const assetId = prefab.assetId || prefabRegistry.getPrefabAssetId(prefab.id);
        actor.userData = {
            ...(actor.userData || {}),
            prefabId: actor.userData?.prefabId || prefab.id,
            prefabAssetId: assetId,
        };
        const mesh = getActorRenderObject(actor);
        if (mesh?.userData) {
            mesh.userData.prefabId = mesh.userData.prefabId || prefab.id;
            mesh.userData.prefabAssetId = assetId;
        }
        return actor;
    }

    function closePrefabBrowser() {
        const browser = document.getElementById('prefab-browser');
        if (browser) browser.hidden = true;
    }

    function createPrefabBrowserTile(prefab) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'prefab-browser-item';

        const img = document.createElement('img');
        img.className = 'prefab-browser-thumb';
        img.alt = prefab.name || 'Prefab';
        img.src = prefabAssetUrl(prefab.image || 'car.svg');

        const name = document.createElement('div');
        name.className = 'prefab-browser-name';
        name.textContent = prefab.name || prefab.file || 'Prefab';

        item.append(img, name);
        item.addEventListener('click', () => {
            if (prefab.file) {
                loadPrefab(prefab);
            } else {
                spawnBuiltinPrefab(prefab);
            }
        });
        return item;
    }

    async function openPrefabBrowser() {
        const browser = document.getElementById('prefab-browser');
        const grid = document.getElementById('prefab-browser-grid');
        const status = document.getElementById('prefab-browser-status');
        if (!browser || !grid) return;

        browser.hidden = false;
        grid.textContent = '';
        if (status) status.textContent = 'Loading prefabs...';

        try {
            await loadPrefabManifest();
            registerBuiltinPrefabs();
            const prefabs = prefabRegistry.list();
            if (!prefabs.length) {
                if (status) status.textContent = 'No prefabs found.';
                return;
            }

            prefabRegistry.grouped(PREFAB_CATEGORY_ORDER).forEach(({ category, items }) => {
                const heading = document.createElement('div');
                heading.className = 'prefab-category-heading';

                const title = document.createElement('div');
                title.className = 'prefab-category-title';
                title.textContent = category;

                const count = document.createElement('div');
                count.className = 'prefab-category-count';
                count.textContent = `${items.length}`;

                heading.append(title, count);
                grid.appendChild(heading);
                items.forEach((prefab) => grid.appendChild(createPrefabBrowserTile(prefab)));
            });

            if (status) status.textContent = `${prefabs.length} prefab${prefabs.length === 1 ? '' : 's'}`;
        } catch (err) {
            console.error('Failed to open prefab browser.', err);
            if (status) status.textContent = 'Failed to load prefabs.';
        }
    }

    document.getElementById('load-prefab-btn')?.addEventListener('click', () => {
        openPrefabBrowser();
    });
    document.getElementById('prefab-browser-close')?.addEventListener('click', () => {
        closePrefabBrowser();
    });
    document.getElementById('prefab-browser')?.addEventListener('click', (event) => {
        if (event.target?.id === 'prefab-browser') closePrefabBrowser();
    });

    document.getElementById('load-actor-btn')?.addEventListener('click', () => {
        document.getElementById('actor-file-input')?.click();
    });
    document.getElementById('actor-file-input')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            loadActorFromFile(file);
            e.target.value = '';
        }
    });

    return {
        registerBuiltinPrefabs, loadPrefabManifest, loadPrefab, prefabAssetUrl,
        createHelicopterPrefabMesh, findExistingHelicopterProp,
        spawnHelicopterPrefab, spawnBuiltinPrefab, tagPrefabInstance,
        closePrefabBrowser, createPrefabBrowserTile, openPrefabBrowser,
    };
}