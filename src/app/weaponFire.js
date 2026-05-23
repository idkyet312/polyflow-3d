// Per-frame weapon-fire logic for the player. One function dispatches over
// the currently equipped weapon type (doomShotgun / throwingStar / sniperRifle
// / smg), applies cooldown gates, spawns the projectile or pellets, plays
// FX, applies camera recoil.
//
// Lifted out of runtime.js as a single 160-LOC update fn. Pure: all engine
// refs injected via deps; no module-scope state.

export function createWeaponFire(deps) {
    const {
        THREE,
        camera, physics,
        gameplay,
        DOOM_SHOTGUN_PREFAB, DOOM_SHOTGUN_PELLET_PATTERN,
        STRAIGHT_GUN_PREFAB, SNIPER_RIFLE_PREFAB, THROWING_STAR_PREFAB,
        _scratchPrefab1,
        tempVectorA, tempVectorC,
        isDrivingVehicle,
        getGameplayPrefabActors,
        hasScriptedTickHandler,
        runObjectEventScript,
        updateDoomShotgunHud,
        spawnDoomPellet, flashDoomShotgun,
        playDoomShotgunSound,
        applyCameraRecoil,
        spawnDynamicPrimitive,
        getActorBody, getActorRenderObject,
        destroyDynamicPhysicsProp,
        spawnShooterProjectile,
    } = deps;

    function setThrowingStarGlow(target, ignited) {
        if (!target || target.userData?.throwingStarIgnited === ignited) return;
        target.userData.throwingStarIgnited = ignited;
        target.traverse?.((node) => {
            const mats = node?.material
                ? (Array.isArray(node.material) ? node.material : [node.material])
                : [];
            for (const mat of mats) {
                if (!mat?.emissive) continue;
                const state = mat.userData || (mat.userData = {});
                if (state.throwingStarBaseEmissive == null) {
                    state.throwingStarBaseEmissive = mat.emissive.getHex();
                    state.throwingStarBaseEmissiveIntensity = mat.emissiveIntensity ?? 1;
                }
                mat.emissive.setHex(ignited ? 0xff0000 : state.throwingStarBaseEmissive);
                mat.emissiveIntensity = ignited
                    ? Math.max(2.2, state.throwingStarBaseEmissiveIntensity ?? 1)
                    : state.throwingStarBaseEmissiveIntensity;
            }
        });
    }

    return function updateStraightGuns() {
        if (!gameplay.active) return;
        if (!gameplay.weapon.type || isDrivingVehicle()) return;

        const cam = camera();
        const now = performance.now?.() || Date.now();

        if (gameplay.weapon.type === 'doomShotgun') {
            updateDoomShotgunHud(now);
            // ALL weapon behavior (pellet count, spread, burst, cooldown) lives in
            // the pickup prefab's user script. Drive that actor's Tick every frame
            // while equipped. Only if the user cleared the script do we run a
            // minimal built-in blast so the gun still works.
            const srcId = gameplay.weapon.sourceActorId;
            let srcActor = null;
            if (srcId) {
                const guns = getGameplayPrefabActors('doomShotgunSprite', _scratchPrefab1);
                for (let i = 0; i < guns.length; i++) {
                    if (guns[i]?.id === srcId) { srcActor = guns[i]; break; }
                }
            }
            if (srcActor && hasScriptedTickHandler(srcActor)) {
                runObjectEventScript(srcActor, 'tick', { deltaTime: 0 });
            } else if (gameplay.input.firePressed && (gameplay.weapon.nextShotAt || 0) <= now) {
                gameplay.input.firePressed = false;
                const d = DOOM_SHOTGUN_PREFAB;
                for (let i = 0; i < d.pellets; i++) {
                    const [sx, sy] = DOOM_SHOTGUN_PELLET_PATTERN[i % DOOM_SHOTGUN_PELLET_PATTERN.length];
                    spawnDoomPellet({ spreadX: sx * d.spread, spreadY: sy * d.spread });
                }
                gameplay.weapon.nextShotAt = now + d.cooldownMs;
                flashDoomShotgun(d.flashMs, now);
                playDoomShotgunSound(1);
                applyCameraRecoil(0.045, (Math.random() - 0.5) * 0.012);
            } else if (gameplay.input.firePressed) {
                gameplay.input.firePressed = false;
            }
            return;
        }

        const b = (typeof window !== 'undefined' && window.rogueBuffs) || {};

        if (gameplay.weapon.type === 'throwingStar') {
            // Held blade always spins; throw on hold/press, cooldown-gated.
            const igniteActive = (b.burn || 0) > 0;
            const spinner = gameplay.weapon.mesh?.userData?.spinner;
            if (spinner) {
                spinner.rotation.z -= 0.45;
                setThrowingStarGlow(spinner, igniteActive);
            }
            if (!gameplay.input.fire && !gameplay.input.firePressed) return;
            if ((gameplay.weapon.nextShotAt || 0) > now) {
                if (!gameplay.input.fire) gameplay.input.firePressed = false;
                return;
            }
            const s = THROWING_STAR_PREFAB;
            // Real physics body: spawn a small bouncy sphere at the muzzle and
            // launch it flat along the look direction. Jolt handles the wall
            // ricochets (high restitution). updateShooterAiPhysicsHits already
            // damages enemies hit by fast non-prefab dynamic props.
            const count = Math.max(1, Math.min(3, b.starCount || 1));
            for (let i = 0; i < count; i++) {
                const lane = i - (count - 1) / 2;
                const starOrigin = cam.localToWorld(new THREE.Vector3(0.16 + lane * 0.38, -0.16, -0.7));
                const dir = cam.localToWorld(new THREE.Vector3(0.16 + lane * 0.82, -0.16, -7.4))
                    .sub(starOrigin)
                    .normalize();
                const star = spawnDynamicPrimitive('sphere', starOrigin, 0.16, {
                    local: false,
                    skipImpulse: true,
                    restitution: 1.0,    // perfectly elastic — bounce never decays
                    friction: 0.0,
                    linearDamping: 0.0,  // no speed bleed between bounces
                    angularDamping: 0.0,
                    // Continuous collision (swept) so the fast sphere can't tunnel
                    // through walls or enemies at speed — tests collision every step.
                    motionQuality: physics.Jolt.EMotionQuality_LinearCast,
                    returnActor: true,
                    userData: {
                        label: 'Throwing Star',
                        isThrowingStar: true,
                        starSpeed: s.projectileSpeed,
                        ignited: igniteActive,
                    },
                });
                const body = star ? getActorBody(star) : null;
                if (body && physics.Jolt) {
                    const speed = s.projectileSpeed;
                    const vel = new physics.Jolt.Vec3(dir.x * speed, dir.y * speed, dir.z * speed);
                    physics.bodyInterface.SetLinearVelocity(body.GetID(), vel);
                    physics.Jolt.destroy(vel);
                    // Zero gravity so it keeps a flat path and the bounce energy
                    // never resets/decays — ricochets at full speed until it dies.
                    try { physics.bodyInterface.SetGravityFactor?.(body.GetID(), 0.0); } catch (e) {}
                    // Swap the plain sphere look for a spinning 4-point shuriken:
                    // make the collision sphere invisible and hang a blade group off
                    // it. clampThrowingStarSpeed() spins this group every frame.
                    const mr = getActorRenderObject(star);
                    if (mr) {
                        if (mr.material) {
                            mr.material.transparent = true;
                            mr.material.opacity = 0;
                            mr.material.depthWrite = false;
                        }
                        const blades = new THREE.Group();
                        blades.name = 'Throwing Star Blades';
                        const bmat = new THREE.MeshStandardMaterial({
                            color: 0xcfe8ff, metalness: 0.85, roughness: 0.2,
                            emissive: 0x2bd4ff, emissiveIntensity: 2.0,
                        });
                        // Geometry is in the sphere's LOCAL space (mesh is scaled to
                        // the 0.16 radius), so local 3 ≈ 0.5m blade across in world.
                        for (let i = 0; i < 2; i++) {
                            const blade = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.18, 0.7), bmat);
                            blade.rotation.y = i * Math.PI / 2;
                            blades.add(blade);
                        }
                        const hub = new THREE.Mesh(
                            new THREE.CylinderGeometry(0.5, 0.5, 0.28, 12),
                            new THREE.MeshStandardMaterial({ color: 0x7fd0ff, metalness: 0.7, roughness: 0.3 }),
                        );
                        hub.rotation.x = Math.PI / 2;
                        blades.add(hub);
                        setThrowingStarGlow(blades, igniteActive);
                        mr.add(blades);
                        star.userData.starBlades = blades;
                    }
                    // Auto-despawn so spheres don't pile up. "Ricochet+" cards
                    // (b.pellets) extend how long the star stays alive bouncing.
                    const lifeS = s.projectileLife + (b.pellets || 0) * 0.5;
                    setTimeout(() => { try { destroyDynamicPhysicsProp(star); } catch (e) {} },
                        Math.round(lifeS * 1000));
                }
            }
            playDoomShotgunSound?.(0.35);
            applyCameraRecoil?.(0.02, (Math.random() - 0.5) * 0.01);
            gameplay.weapon.nextShotAt = now + s.cooldownMs / (b.fireRate || 1);
            gameplay.input.firePressed = false;
            return;
        }

        const isSniper = gameplay.weapon.type === 'sniperRifle';
        if (isSniper) {
            if (!gameplay.input.firePressed) return;
            gameplay.input.firePressed = false;
        } else if (gameplay.weapon.type !== 'smg' || (!gameplay.input.fire && !gameplay.input.firePressed)) {
            return;
        }

        if ((gameplay.weapon.nextShotAt || 0) > now) {
            if (!gameplay.input.fire) gameplay.input.firePressed = false;
            return;
        }

        const config = isSniper ? SNIPER_RIFLE_PREFAB : STRAIGHT_GUN_PREFAB;
        const smgMinigunActive = !isSniper
            && b.smgMinigun
            && (((now - (b.smgMinigunStartedAt || 0)) % 5000) < 2000);
        const fireRate = isSniper ? 1 : (b.fireRate || 1) * (smgMinigunActive ? 4 : 1);
        cam.getWorldDirection(tempVectorC).normalize();
        const origin = cam.localToWorld(tempVectorA.set(
            isSniper ? 0.1 : 0.18,
            isSniper ? -0.1 : -0.14,
            isSniper ? -1.12 : -0.75,
        ));
        spawnShooterProjectile(origin, null, {
            velocity: tempVectorC,
            name: isSniper ? 'Sniper Bullet' : 'SMG Bullet',
            poolKey: isSniper ? 'sniperRifleBullets' : 'smgBullets',
            maxPoolSize: config.bulletPoolSize,
            radius: isSniper ? 0.04 : 0.055,
            color: isSniper ? 0xbde7ff : (smgMinigunActive ? 0xfff1a8 : 0xffd166),
            speed: config.projectileSpeed,
            life: config.projectileLife,
            damage: config.damage * (isSniper ? 1 : (b.damage || 1)),
            hitRadius: config.hitRadius,
            hitsPlayer: false,
            damagesShooters: true,
            emissiveIntensity: isSniper ? 5.5 : 4.2,
            light: false,
        });
        gameplay.weapon.nextShotAt = now + config.cooldownMs / fireRate;
        if (!isSniper) gameplay.input.firePressed = false;
    };
}
