// Gameplay-prefab spawn dispatcher: one-shot switch over prefab `type`,
// each branch builds + tags + tints + attaches scripts/components on a
// primitive actor. Lifted out of runtime.js where it was the single
// largest function in the file (316 LOC).
//
// Pure: every dependency is injected, no module-scope state. Returns the
// spawned actor (or null) so callers can select/focus it.

export function createSpawnGameplayPrefab(deps) {
    const {
        THREE,
        camera, sceneSystem,
        BASIC_NAVMESH_AI_PREFAB, SHOOTER_AI_PREFAB, HEALTH_PICKUP_PREFAB,
        STRAIGHT_GUN_PREFAB, SNIPER_RIFLE_PREFAB, DOOM_SHOTGUN_PREFAB,
        DOOM_ENEMY_PREFAB,
        TELEPORTER_USER_SCRIPT, COIN_USER_SCRIPT, HEALTH_PICKUP_USER_SCRIPT,
        TARGET_USER_SCRIPT, SHOOTER_SPAWNER_USER_SCRIPT,
        DOOM_SHOTGUN_USER_SCRIPT, ROGUE_GAMEMODE_SCRIPT,
        tempVectorA, tempVectorB, tempVectorC,
        spawnDynamicPrimitive, spawnDoomEnemyAt, spawnShooterAiAt,
        createActor,
        tagGameplayPrefabActor, tintGameplayPrefabActor,
        applyPlayerSpawnFromActor,
        attachDefaultPrefabScript,
        getActorRenderObject,
        getGroundHeightAt,
        rebuildActorPhysics,
        attachCoinComponent, attachHealthPickupComponent, attachTargetComponent,
        attachShooterSpawnerComponent, attachWeaponPickupComponent,
        addCircularNavmeshVisual,
        CircularPatrolComponent,
        addStraightGunVisual,
        makeDoomShotgunSpriteTexture,
        ensureActorIdentity, setActorComponentFlags,
        refreshSceneUI, selectShowcaseActor,
    } = deps;

    function _spawnDir() {
        const cam = camera();
        const dir = tempVectorB;
        cam.getWorldDirection(dir);
        dir.y = 0;
        if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
        else dir.normalize();
        return dir;
    }

    function _spawnAhead(distance) {
        const cam = camera();
        const dir = _spawnDir();
        return tempVectorA.copy(cam.position).addScaledVector(dir, distance);
    }

    return function spawnGameplayPrefab(type) {
        let actor = null;
        if (type === 'playerSpawn') {
            actor = spawnDynamicPrimitive('capsule', undefined, 0.45, {
                includeCollisionBody: false,
                includeScripts: false,
                userData: { label: 'Player Spawn' },
                returnActor: true,
            });
            tagGameplayPrefabActor(actor, type, { triggerRadius: 0.8, groundOffset: 0.45 });
            tintGameplayPrefabActor(actor, '#22c55e', '#22c55e', 1.8);
            applyPlayerSpawnFromActor(actor);
        } else if (type === 'teleporter') {
            actor = spawnDynamicPrimitive('cylinder', undefined, 1, {
                includeCollisionBody: true,
                simulatePhysics: false,
                includeScripts: false,
                userData: { label: 'Teleporter' },
                returnActor: true,
            });
            const mesh = getActorRenderObject(actor);
            if (mesh) mesh.scale.set(1.4, 0.45, 1.4);
            tagGameplayPrefabActor(actor, type, { triggerRadius: 1.45, groundOffset: 0.42 });
            tintGameplayPrefabActor(actor, '#22d3ee', '#22d3ee', 2.6);
            rebuildActorPhysics(actor);
            attachDefaultPrefabScript(actor, TELEPORTER_USER_SCRIPT);
        } else if (type === 'coin') {
            actor = spawnDynamicPrimitive('sphere', undefined, 0.35, {
                includeCollisionBody: false,
                includeScripts: false,
                userData: { label: 'Coin +10' },
                returnActor: true,
            });
            tagGameplayPrefabActor(actor, type, { triggerRadius: 0.95, groundOffset: 1.0, scoreValue: 10 });
            tintGameplayPrefabActor(actor, '#facc15', '#facc15', 2.8);
            attachDefaultPrefabScript(actor, COIN_USER_SCRIPT);
            attachCoinComponent(actor);
        } else if (type === 'healthPickup') {
            actor = spawnDynamicPrimitive('sphere', undefined, 0.38, {
                includeCollisionBody: false,
                includeScripts: false,
                userData: {
                    label: 'Health +35%',
                    healValue: HEALTH_PICKUP_PREFAB.healValue,
                    respawnMs: HEALTH_PICKUP_PREFAB.respawnMs,
                },
                returnActor: true,
            });
            const mesh = getActorRenderObject(actor);
            if (mesh) {
                const ring = new THREE.Mesh(
                    new THREE.TorusGeometry(0.52, 0.045, 8, 28),
                    new THREE.MeshBasicMaterial({ color: 0x22ff88, transparent: true, opacity: 0.82 }),
                );
                ring.rotation.x = Math.PI / 2;
                ring.name = 'Health Pickup Ring';
                mesh.add(ring);
            }
            tagGameplayPrefabActor(actor, type, { triggerRadius: 0.95, groundOffset: 0.85 });
            actor.userData.healValue = HEALTH_PICKUP_PREFAB.healValue;
            actor.userData.respawnMs = HEALTH_PICKUP_PREFAB.respawnMs;
            tintGameplayPrefabActor(actor, '#22c55e', '#22ff88', 2.2);
            attachDefaultPrefabScript(actor, HEALTH_PICKUP_USER_SCRIPT);
            attachHealthPickupComponent(actor);
        } else if (type === 'target') {
            actor = spawnDynamicPrimitive('cylinder', undefined, 0.6, {
                includeCollisionBody: true,
                simulatePhysics: false,
                includeScripts: false,
                userData: { label: 'Target +25' },
                returnActor: true,
            });
            const mesh = getActorRenderObject(actor);
            if (mesh) mesh.scale.set(0.6, 0.12, 0.6);
            tagGameplayPrefabActor(actor, type, { triggerRadius: 0.75, groundOffset: 1.1, scoreValue: 25 });
            tintGameplayPrefabActor(actor, '#ef4444', '#ef4444', 1.2);
            rebuildActorPhysics(actor);
            attachDefaultPrefabScript(actor, TARGET_USER_SCRIPT);
            attachTargetComponent(actor);
        } else if (type === 'navmeshCircleAi') {
            const spawnPosition = _spawnAhead(7);
            const groundY = getGroundHeightAt(spawnPosition.x, spawnPosition.z, true) ?? spawnPosition.y;
            const center = new THREE.Vector3(spawnPosition.x, groundY + 0.03, spawnPosition.z);
            const radius = BASIC_NAVMESH_AI_PREFAB.radius;

            const navmeshActor = spawnDynamicPrimitive('cylinder', center, 1, {
                local: false,
                includeCollisionBody: false,
                includeScripts: false,
                userData: { label: 'Basic Navmesh' },
                returnActor: true,
            });
            const navmeshMesh = getActorRenderObject(navmeshActor);
            if (navmeshMesh) navmeshMesh.scale.set(radius, 0.015, radius);
            tagGameplayPrefabActor(navmeshActor, 'navmeshCircle', { triggerRadius: radius, groundOffset: 0.03 });
            tintGameplayPrefabActor(navmeshActor, '#0891b2', '#083344', 0.2);
            addCircularNavmeshVisual(navmeshActor);

            actor = spawnDynamicPrimitive(
                'capsule',
                new THREE.Vector3(center.x + radius, center.y + 1.05, center.z),
                BASIC_NAVMESH_AI_PREFAB.agentScale,
                {
                    local: false,
                    includeCollisionBody: false,
                    includeScripts: false,
                    userData: {
                        label: 'Circle Patrol AI',
                        // navmeshActorId retained on userData for the (separate)
                        // navmesh-circle visual lookup; patrol state itself now
                        // lives on the CircularPatrolComponent below.
                        navmeshActorId: navmeshActor?.id || '',
                    },
                    returnActor: true,
                },
            );
            tagGameplayPrefabActor(actor, type, { triggerRadius: 0.65, groundOffset: 1.05 });
            tintGameplayPrefabActor(actor, '#a3e635', '#4d7c0f', 0.72);

            // ECS: drive patrol motion via a CircularPatrolComponent instead of
            // the legacy updateCircularNavmeshAis(delta) loop. The component is
            // ticked by sceneSystem.tickComponents(delta) once per frame.
            const patrolComp = new CircularPatrolComponent({
                center: [center.x, center.y, center.z],
                radius,
                speed: BASIC_NAVMESH_AI_PREFAB.speed,
                angle: 0,
                yOffset: BASIC_NAVMESH_AI_PREFAB.agentScale * 2.55,
            });
            patrolComp.setGroundSampler((x, z, ignoreActor) =>
                getGroundHeightAt(x, z, true, { ignoreActor }));
            actor.addComponent(patrolComp);
        } else if (type === 'shooterSpawner') {
            const spawnPosition = _spawnAhead(10);
            const groundY = getGroundHeightAt(spawnPosition.x, spawnPosition.z, true) ?? spawnPosition.y;
            actor = spawnDynamicPrimitive(
                'cylinder',
                new THREE.Vector3(spawnPosition.x, groundY + 0.25, spawnPosition.z),
                1,
                {
                    local: false,
                    includeCollisionBody: false,
                    includeScripts: false,
                    userData: {
                        label: 'Shooter Spawner',
                        shooterSpawner: { wave: 0, nextWaveAt: 0 },
                    },
                    returnActor: true,
                },
            );
            const mesh = getActorRenderObject(actor);
            if (mesh) mesh.scale.set(1.45, 0.18, 1.45);
            tagGameplayPrefabActor(actor, type, { triggerRadius: 1.4, groundOffset: 0.25 });
            tintGameplayPrefabActor(actor, '#7c3aed', '#a855f7', 1.9);
            attachDefaultPrefabScript(actor, SHOOTER_SPAWNER_USER_SCRIPT);
            attachShooterSpawnerComponent(actor);
        } else if (type === 'smg') {
            const spawnDirection = _spawnDir();
            const spawnPosition = _spawnAhead(8);
            const groundY = getGroundHeightAt(spawnPosition.x, spawnPosition.z, true) ?? spawnPosition.y;
            actor = spawnDynamicPrimitive(
                'cylinder',
                new THREE.Vector3(spawnPosition.x, groundY + 0.22, spawnPosition.z),
                1,
                {
                    local: false,
                    includeCollisionBody: false,
                    includeScripts: false,
                    userData: {
                        label: 'SMG',
                        smg: { nextShotAt: 0, cooldownMs: STRAIGHT_GUN_PREFAB.cooldownMs },
                    },
                    returnActor: true,
                },
            );
            const mesh = getActorRenderObject(actor);
            if (mesh) {
                mesh.scale.set(0.52, 0.18, 0.52);
                tagGameplayPrefabActor(actor, type, { triggerRadius: 0.65, groundOffset: 0.22 });
                mesh.lookAt(tempVectorC.copy(mesh.position).add(spawnDirection));
            }
            tintGameplayPrefabActor(actor, '#334155', '#f59e0b', 0.8);
            addStraightGunVisual(actor);
            attachWeaponPickupComponent(actor, 'smg');
        } else if (type === 'sniperRifle') {
            const spawnDirection = _spawnDir();
            const spawnPosition = _spawnAhead(8);
            const groundY = getGroundHeightAt(spawnPosition.x, spawnPosition.z, true) ?? spawnPosition.y;
            actor = spawnDynamicPrimitive(
                'cylinder',
                new THREE.Vector3(spawnPosition.x, groundY + 0.24, spawnPosition.z),
                1,
                {
                    local: false,
                    includeCollisionBody: false,
                    includeScripts: false,
                    userData: {
                        label: 'Bolt Action Sniper Rifle',
                        sniperRifle: { nextShotAt: 0, cooldownMs: SNIPER_RIFLE_PREFAB.cooldownMs },
                    },
                    returnActor: true,
                },
            );
            const mesh = getActorRenderObject(actor);
            if (mesh) {
                mesh.scale.set(0.42, 0.14, 1.15);
                tagGameplayPrefabActor(actor, type, { triggerRadius: 0.75, groundOffset: 0.24 });
                mesh.lookAt(tempVectorC.copy(mesh.position).add(spawnDirection));
            }
            tintGameplayPrefabActor(actor, '#475569', '#38bdf8', 0.5);
            addStraightGunVisual(actor);
            attachWeaponPickupComponent(actor, 'sniperRifle');
        } else if (type === 'doomShotgunSprite') {
            const spawnPosition = _spawnAhead(6);
            const groundY = getGroundHeightAt(spawnPosition.x, spawnPosition.z, true) ?? spawnPosition.y;
            const tex = makeDoomShotgunSpriteTexture();
            const mat = new THREE.SpriteMaterial({
                map: tex,
                transparent: true,
                alphaTest: 0.5,
                depthWrite: true,
                sizeAttenuation: true,
            });
            mat.toneMapped = false;
            const sprite = new THREE.Sprite(mat);
            sprite.name = 'doom-shotgun-sprite';
            sprite.position.set(spawnPosition.x, groundY + 0.7, spawnPosition.z);
            sprite.scale.set(2.0, 1.0, 1);
            sprite.userData = {
                label: 'Doom Shotgun Sprite',
                ownedTextures: [tex],
            };
            actor = createActor({
                name: 'Doom Shotgun Sprite',
                kind: 'sprite',
                mesh: sprite,
                userData: {
                    label: 'Doom Shotgun Sprite',
                    doomShotgun: { nextShotAt: 0, cooldownMs: DOOM_SHOTGUN_PREFAB.cooldownMs },
                },
            });
            sceneSystem()?.addActor(actor);
            ensureActorIdentity(actor);
            setActorComponentFlags(actor, { collision: false, physics: false, scripts: false });
            tagGameplayPrefabActor(actor, type, { triggerRadius: 0.7, groundOffset: 0.7 });
            attachDefaultPrefabScript(actor, DOOM_SHOTGUN_USER_SCRIPT);
            attachWeaponPickupComponent(actor, 'doomShotgun');
        } else if (type === 'doomEnemy') {
            const spawnPosition = _spawnAhead(9);
            actor = spawnDoomEnemyAt(spawnPosition, {
                label: 'Doom Enemy',
                health: DOOM_ENEMY_PREFAB.health,
                maxHealth: DOOM_ENEMY_PREFAB.health,
            });
        } else if (type === 'shooterAi') {
            const spawnPosition = _spawnAhead(9);
            actor = spawnShooterAiAt(spawnPosition);
        } else if (type === 'rogueGameMode') {
            // Invisible logic actor that carries the level-blueprint / game-mode
            // script. No collision, no physics, hidden mesh — pure script host.
            actor = spawnDynamicPrimitive('sphere', new THREE.Vector3(0, -50, 0), 0.2, {
                local: false,
                includeCollisionBody: false,
                includeScripts: false,
                userData: { label: 'Rogue Game Mode' },
                returnActor: true,
            });
            const mesh = getActorRenderObject(actor);
            if (mesh) mesh.visible = false;
            tagGameplayPrefabActor(actor, type, { triggerRadius: 0, groundOffset: 0 });
            attachDefaultPrefabScript(actor, ROGUE_GAMEMODE_SCRIPT);
        }

        if (actor) {
            refreshSceneUI();
            selectShowcaseActor(actor.id);
        }
        return actor;
    };
}
