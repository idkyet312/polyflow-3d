import * as THREE from 'three';
import { core } from '../runtime/appCore.js';
import { SHOOTER_AI_USER_SCRIPT } from './prefabScripts.js';

// Shooter-AI per-frame logic: projectile sim, hit detection, line-of-sight,
// cover-point seeking, movement, per-actor tick, group tick.
// Live engine refs (physicsCore, currentMesh) via appCore keystone;
// all other deps injected (consts, helpers, FX hooks); 0 span-local state.
export function createShooterAi(deps) {
    const {
        SHOOTER_AI_PREFAB, _scratchPrefab1, _scratchPrefab2,
        gameplay, gameplayPrefabState, physics,
        tempBoxA, tempVectorA, tempVectorB, tempVectorC, tempVectorD, tempVectorE,
        playImpactSound, spawnImpactBurst, spawnImpactDecal,
        copyJoltVector, getPointSegmentDistanceSq, getShooterHitPoints,
        releaseProjectile,
        // call-site deps caught by unresolved-calls cross-check (all hoisted
        // fns or const aliases declared before splice site — safe to inject):
        damagePlayer, damageShooterAi, getActorBody, getActorRenderObject,
        getGameplayPrefabActors, queryDynamicBodies = null,
        // additional call-site deps (caught by simple call-scan against
        // runtime.js — the regex-based audit missed these as call-site
        // identifiers in nested expressions):
        ensureGameplayPrefabScript, ensureShooterHealthBar,
        getGroundHeightAt, getShooterGroundIgnoreActors,
        getShooterTargetPosition, hideShooterAimWarning,
        isDoomRoofSurfaceHit, raycastWorld, runObjectEventScript,
        setShooterHealth, spawnShooterProjectile,
        updateDoomEnemySpriteAnimation, updateShooterAimWarning,
    } = deps;

    function updateShooterProjectiles(delta = 0) {
        if (!gameplayPrefabState.shooterProjectiles.length) return;
        const hitPoints = gameplay.active ? getShooterHitPoints() : null;
        const hitPointsLen = hitPoints ? hitPoints.length : 0;
        // Cache shooter list once per call; only re-fetch when a projectile actually
        // needs it (damagesShooters), since it's the common-case path for player shots.
        let cachedShooters = null;

        for (let i = gameplayPrefabState.shooterProjectiles.length - 1; i >= 0; i--) {
            const projectile = gameplayPrefabState.shooterProjectiles[i];
            if (!projectile?.mesh) continue;
            projectile.ttl -= delta;
            // Lobbed projectiles (throwing star) arc under their own gravity.
            if (projectile.gravity) {
                projectile.velocity.y -= projectile.gravity * delta;
            }
            const previousPosition = tempVectorA.copy(projectile.mesh.position);
            projectile.mesh.position.addScaledVector(projectile.velocity, delta);

            let hitPlayer = false;
            let hitShooter = false;
            let hitWall = false;
            const hitRadius = projectile.hitRadius ?? SHOOTER_AI_PREFAB.hitRadius;
            const hitRadiusSq = hitRadius * hitRadius;

            // Raycast the segment travelled this frame against world geometry so
            // bullets stop on walls/floors instead of passing through. Only the
            // short per-frame span is cast (cheap). Shooter actors are skipped —
            // the proximity test below owns enemy hits (more forgiving radius);
            // anything else (level static, props) blocks the bullet.
            const segVec = tempVectorB.copy(projectile.mesh.position).sub(previousPosition);
            const segLen = segVec.length();
            if (segLen > 1e-5 && core.physicsCore?.castRay) {
                const dir = tempVectorC.copy(segVec).multiplyScalar(1 / segLen);
                const ray = raycastWorld(previousPosition, dir, segLen + (projectile.hitRadius ?? 0.1));
                if (ray?.hit && !ray.actor?.userData?.shooterAi) {
                    const ip = ray.point || projectile.mesh.position;
                    const nrm = ray.normal || { x: 0, y: 1, z: 0 };
                    if ((projectile.bounces || 0) > 0) {
                        // Ricochet: reflect velocity about the surface normal,
                        // damp the speed, nudge off the wall so we don't re-hit
                        // the same face next frame. Star keeps flying.
                        projectile.bounces -= 1;
                        const v = projectile.velocity;
                        const dot = v.x * nrm.x + v.y * nrm.y + v.z * nrm.z;
                        v.x -= 2 * dot * nrm.x;
                        v.y -= 2 * dot * nrm.y;
                        v.z -= 2 * dot * nrm.z;
                        const damp = projectile.bounceDamping ?? 0.86;
                        v.multiplyScalar(damp);
                        projectile.mesh.position.set(
                            ip.x + nrm.x * 0.12,
                            ip.y + nrm.y * 0.12,
                            ip.z + nrm.z * 0.12,
                        );
                        spawnImpactBurst(ip.x, ip.y, ip.z, { color: 0x9be7ff, count: 5 });
                        playImpactSound(0.5, ip.x, ip.y, ip.z);
                    } else {
                        hitWall = true;
                        if (ray.point) projectile.mesh.position.copy(ray.point);
                        // Overridable hook: weapon scripts decide impact FX. Default
                        // (no override) = spark + 3D thud + scorch decal. nx/ny/nz =
                        // surface normal (for orienting decals).
                        if (typeof window !== 'undefined' && window.onBulletImpact) {
                            try { window.onBulletImpact(ip.x, ip.y, ip.z, projectile, nrm.x, nrm.y, nrm.z); } catch (e) { /* script error */ }
                        } else {
                            spawnImpactBurst(ip.x, ip.y, ip.z);
                            playImpactSound(0.8, ip.x, ip.y, ip.z);
                            spawnImpactDecal(ip.x, ip.y, ip.z, nrm.x, nrm.y, nrm.z, {
                                dir: projectile.velocity,
                                hasNormal: ray.hasNormal === true,
                            });
                        }
                    }
                }
            }
            if (!hitWall && projectile.hitsPlayer !== false && hitPoints) {
                for (let p = 0; p < hitPointsLen; p++) {
                    if (getPointSegmentDistanceSq(hitPoints[p], previousPosition, projectile.mesh.position) <= hitRadiusSq) {
                        hitPlayer = true;
                        break;
                    }
                }
            }
            if (!hitWall && !hitPlayer && projectile.damagesShooters) {
                const shooters = cachedShooters || (cachedShooters = getGameplayPrefabActors('shooterAi', _scratchPrefab2));
                if (window.DEBUG_BULLET_HITS) {
                    console.log('[bullet]', projectile.mesh.name, 'pos', projectile.mesh.position.toArray(), 'shooters', shooters.length, 'hitRadius', hitRadius);
                }
                for (let s = 0; s < shooters.length; s++) {
                    const actor = shooters[s];
                    const mesh = getActorRenderObject(actor);
                    const shooter = actor?.userData?.shooterAi;
                    if (!mesh?.visible || !shooter || shooter.defeated) {
                        if (window.DEBUG_BULLET_HITS) console.log('[bullet] skip shooter', { visible: mesh?.visible, hasShooter: !!shooter, defeated: shooter?.defeated });
                        continue;
                    }
                    mesh.getWorldPosition(tempVectorB);
                    tempVectorC.copy(tempVectorB);
                    tempVectorC.y += 0.7;   // head point, lowered from 1.15
                    tempVectorB.y += 0.15;  // body point, lowered from 0.55
                    const dBody = getPointSegmentDistanceSq(tempVectorB, previousPosition, projectile.mesh.position);
                    const dHead = getPointSegmentDistanceSq(tempVectorC, previousPosition, projectile.mesh.position);
                    if (window.DEBUG_BULLET_HITS) {
                        console.log('[bullet] shooter at', tempVectorB.toArray(), 'dBody', Math.sqrt(dBody), 'dHead', Math.sqrt(dHead), 'r', hitRadius);
                    }
                    if (dBody <= hitRadiusSq || dHead <= hitRadiusSq) {
                        damageShooterAi(actor, projectile.damage ?? SHOOTER_AI_PREFAB.hitDamage);
                        hitShooter = true;
                        break;
                    }
                }
            }
            if (projectile.ttl <= 0 || hitPlayer || hitShooter || hitWall) {
                if (hitPlayer) {
                    damagePlayer(projectile.damage, projectile.mesh?.position || null);
                }
                releaseProjectile(projectile);
                gameplayPrefabState.shooterProjectiles.splice(i, 1);
                if (hitPlayer && !gameplayPrefabState.shooterProjectiles.length) break;
            }
        }
    }

    const _physicsHitCandidates = [];
    const _coverCandidates = [];

    function updateShooterAiPhysicsHits() {
        if (!gameplay.active || !physics.ready || !physics.dynamicBodies?.length) return;

        const now = performance.now?.() || Date.now();
        const shooters = getGameplayPrefabActors('shooterAi', _scratchPrefab1);
        const hitScanRadius = Number.isFinite(SHOOTER_AI_PREFAB.hitScanRadius)
            ? SHOOTER_AI_PREFAB.hitScanRadius
            : 4;
        for (let si = 0; si < shooters.length; si++) {
            const actor = shooters[si];
            const mesh = getActorRenderObject(actor);
            const shooter = actor?.userData?.shooterAi;
            if (!mesh || !shooter || shooter.defeated || mesh.visible === false) continue;
            if ((shooter.lastPhysicsHitAt || 0) + SHOOTER_AI_PREFAB.hitCooldownMs > now) continue;

            mesh.getWorldPosition(tempVectorA);
            tempVectorC.copy(tempVectorA);
            tempVectorC.y += 0.6;
            tempVectorA.y += 1.2;

            const candidates = queryDynamicBodies
                ? queryDynamicBodies(tempVectorC, hitScanRadius, _physicsHitCandidates)
                : physics.dynamicBodies;
            for (const prop of candidates) {
                if (!prop || prop.userData?.gameplayPrefab) continue;
                const body = getActorBody(prop);
                const propMesh = getActorRenderObject(prop);
                if (!body || !propMesh?.visible) continue;

                const velocity = copyJoltVector(tempVectorB, physics.bodyInterface.GetLinearVelocity(body.GetID()));
                const speed = velocity.length();
                if (speed < SHOOTER_AI_PREFAB.hitSpeedThreshold) continue;

                // Star uses a wider contact test so fast ricochets reliably
                // register a hit instead of skimming past the enemy.
                const isStar = !!prop.userData?.isThrowingStar;
                const pad = isStar ? 0.7 : 0.35;
                const reach = isStar ? 1.05 : 0.65;
                propMesh.updateMatrixWorld(true);
                tempBoxA.setFromObject(propMesh).expandByScalar(pad);
                const hitBody = tempBoxA.distanceToPoint(tempVectorC) <= reach;
                const hitHead = tempBoxA.distanceToPoint(tempVectorA) <= reach;
                if (!hitBody && !hitHead) continue;

                shooter.lastPhysicsHitAt = now;
                const dmg = THREE.MathUtils.clamp(SHOOTER_AI_PREFAB.hitDamage * (speed / 5), 0.12, 0.45)
                    * (isStar ? 0.75 : 1);
                damageShooterAi(actor, dmg);
                break;
            }
        }
    }

    // A perfectly-elastic sphere can gain speed bouncing off moving bodies
    // (enemies, the player capsule). Re-normalize each star's velocity back to
    // its launch speed every frame so collisions only redirect it, never
    // accelerate it — direction is kept, magnitude is pinned.
    function clampThrowingStarSpeed() {
        if (!physics.ready || !physics.dynamicBodies?.length || !physics.Jolt) return;
        for (const prop of physics.dynamicBodies) {
            if (!prop?.userData?.isThrowingStar) continue;
            // Spin the shuriken blades regardless of the speed-clamp branches.
            const blades = prop.userData.starBlades;
            if (blades) blades.rotation.z -= 0.9;
            const body = getActorBody(prop);
            if (!body) continue;
            const target = prop.userData.starSpeed || 0;
            if (target <= 0) continue;
            const v = copyJoltVector(tempVectorB, physics.bodyInterface.GetLinearVelocity(body.GetID()));
            const speed = v.length();
            if (speed < 1e-3 || Math.abs(speed - target) < 0.5) continue;
            v.multiplyScalar(target / speed);
            const jv = new physics.Jolt.Vec3(v.x, v.y, v.z);
            physics.bodyInterface.SetLinearVelocity(body.GetID(), jv);
            physics.Jolt.destroy(jv);
        }
    }

    function isShooterLineOfSightClear(origin, target) {
        if (!origin || !target) return false;
        const direction = tempVectorD.subVectors(target, origin);
        const distance = direction.length();
        if (distance <= 0.1) return true;
        direction.normalize();
        const result = raycastWorld(origin, direction, distance);
        return !result?.hit || (Number(result.distance) || distance) >= distance - 0.75;
    }

    // Scratch vectors for getShooterCoverPoint; writes the best candidate directly
    // into `target` instead of allocating a clone per better-score branch.
    const _coverAway = new THREE.Vector3();
    function getShooterCoverPoint(mesh, subjectPosition, target = tempVectorC) {
        if (!mesh || !subjectPosition || !physics.dynamicBodies?.length) return null;
        const shooterPosition = mesh.getWorldPosition(tempVectorA);
        let bestScore = Infinity;
        let found = false;

        const bodies = queryDynamicBodies
            ? queryDynamicBodies(shooterPosition, 18, _coverCandidates)
            : physics.dynamicBodies;
        for (let i = 0; i < bodies.length; i++) {
            const prop = bodies[i];
            if (!prop || prop.userData?.gameplayPrefab) continue;
            const propMesh = getActorRenderObject(prop);
            if (!propMesh?.visible) continue;
            const coverPosition = propMesh.getWorldPosition(tempVectorB);
            const shooterDist = shooterPosition.distanceTo(coverPosition);
            if (shooterDist > 18) continue;
            const playerDist = subjectPosition.distanceTo(coverPosition);
            if (playerDist < 2.2) continue;
            const score = shooterDist + playerDist * 0.25;
            if (score < bestScore) {
                bestScore = score;
                _coverAway.copy(coverPosition).sub(subjectPosition);
                _coverAway.y = 0;
                if (_coverAway.lengthSq() < 1e-6) _coverAway.set(1, 0, 0);
                _coverAway.normalize();
                target.copy(coverPosition).addScaledVector(_coverAway, 1.6);
                found = true;
            }
        }

        return found ? target : null;
    }

    function updateShooterMovement(actor, mesh, shooter, subjectPosition, delta, hasLineOfSight) {
        if (!mesh || !shooter || !subjectPosition || delta <= 0) return false;
        const position = mesh.getWorldPosition(tempVectorA);
        const toPlayer = tempVectorB.subVectors(subjectPosition, position);
        toPlayer.y = 0;
        const distance = toPlayer.length();
        if (distance < 0.001) return false;
        toPlayer.normalize();

        const move = tempVectorC.set(0, 0, 0);
        const lowHealth = (shooter.health ?? SHOOTER_AI_PREFAB.health) <= SHOOTER_AI_PREFAB.coverHealthThreshold;
        const coverPoint = lowHealth && hasLineOfSight ? getShooterCoverPoint(mesh, subjectPosition, tempVectorE) : null;
        if (coverPoint) {
            move.subVectors(coverPoint, position);
            move.y = 0;
        } else {
            // Perpendicular strafe direction (no Vector3 alloc).
            const strafeX = -toPlayer.z;
            const strafeZ = toPlayer.x;
            if (!Number.isFinite(shooter.strafeDir)) shooter.strafeDir = Math.random() < 0.5 ? -1 : 1;
            if (!Number.isFinite(shooter.nextStrafeFlipAt) || performance.now() > shooter.nextStrafeFlipAt) {
                shooter.strafeDir *= -1;
                shooter.nextStrafeFlipAt = performance.now() + 1400 + Math.random() * 1400;
            }
            move.set(strafeX * shooter.strafeDir, 0, strafeZ * shooter.strafeDir);
            if (distance < 5.5) move.addScaledVector(toPlayer, -0.8);
            if (distance > 15 && hasLineOfSight) move.addScaledVector(toPlayer, 0.35);
        }

        if (move.lengthSq() < 1e-6) return false;
        // Per-actor speed multiplier lets wave variants move faster/slower
        // (rusher charges in, tank lumbers) without touching the shared prefab.
        // Rogue status effects (slow/freeze) write shooter._slowFactor (1 = none,
        // 0 = frozen); the arena status tick decays it back to 1 over time.
        const speedMul = Number.isFinite(shooter.speedMul) ? shooter.speedMul : 1;
        const slowFactor = Number.isFinite(shooter._slowFactor) ? shooter._slowFactor : 1;
        if (slowFactor <= 0.001) return false; // frozen: no movement this frame
        move.normalize().multiplyScalar(SHOOTER_AI_PREFAB.strafeSpeed * speedMul * slowFactor * delta);
        // Rushers bias hard toward the player instead of strafing around.
        if (speedMul > 1.4 && !coverPoint) {
            move.addScaledVector(toPlayer, SHOOTER_AI_PREFAB.strafeSpeed * speedMul * delta * 0.9);
        }
        // Wall block: these enemies have no physics body, so without this they
        // walk straight through walls. Cast from mid-body along the intended
        // move; if world geometry is within (step + bodyRadius), clamp the move
        // to stop a bodyRadius short of the surface.
        {
            const bodyRadius = 0.85; // generous so they keep clear of walls
            const stepLen = move.length();
            if (stepLen > 1e-5) {
                tempVectorD.copy(move).multiplyScalar(1 / stepLen); // move dir
                tempVectorB.copy(mesh.position); tempVectorB.y += 1.0; // mid-body
                const probe = stepLen + bodyRadius;
                const wallHit = raycastWorld(tempVectorB, tempVectorD, probe);
                // Block on world geometry; ignore other enemies + thrown spheres
                // (horizontal probe at mid-body height rarely hits roofs).
                const blocked = wallHit?.hit
                    && !wallHit.actor?.userData?.shooterAi
                    && wallHit.actor?.kind !== 'sphere';
                if (blocked) {
                    const allowed = Math.max(0, (Number(wallHit.distance) || 0) - bodyRadius);
                    if (allowed < stepLen) move.multiplyScalar(allowed / stepLen);
                }
            }
        }
        mesh.position.add(move);
        const groundOptions = {
            ignoreActors: getShooterGroundIgnoreActors(actor, shooter),
        };
        const _st = core.currentMesh?.userData?.sampleType;
        if (_st === 'doomTest' || _st === 'doomArena') {
            groundOptions.hitFilter = (hit) => !isDoomRoofSurfaceHit(hit);
        }
        const groundY = getGroundHeightAt(mesh.position.x, mesh.position.z, true, {
            ...groundOptions,
        });
        if (groundY !== null) mesh.position.y = groundY + 1.18;
        mesh.updateMatrixWorld(true);
        return true;
    }

    // Per-call scratch vectors for updateShooterAiActor (called per shooter per frame).
    const _shooterActorSubject = new THREE.Vector3();
    const _shooterActorOrigin = new THREE.Vector3();
    const _shooterActorMuzzleDir = new THREE.Vector3();
    function updateShooterAiActor(actor, delta = 0) {
        if (!gameplay.active || !actor) return;
        const subjectPosition = getShooterTargetPosition(_shooterActorSubject);
        if (!subjectPosition) return;

        const now = performance.now?.() || Date.now();
        const mesh = getActorRenderObject(actor);
        const shooter = actor?.userData?.shooterAi;
        if (!mesh || !shooter || shooter.defeated || mesh.visible === false) return;
        if (!Number.isFinite(shooter.health)) {
            setShooterHealth(actor, Number.isFinite(shooter.maxHealth) ? shooter.maxHealth : SHOOTER_AI_PREFAB.health);
        }
        ensureShooterHealthBar(actor);

        const origin = mesh.getWorldPosition(_shooterActorOrigin);
        origin.y += SHOOTER_AI_PREFAB.muzzleHeight;
        const distanceSq = origin.distanceToSquared(subjectPosition);
        const range = Number.isFinite(shooter.range) ? shooter.range : SHOOTER_AI_PREFAB.range;
        if (distanceSq > range * range) {
            hideShooterAimWarning(actor);
            updateDoomEnemySpriteAnimation(actor, delta, false);
            return;
        }

        const hasLineOfSight = isShooterLineOfSightClear(origin, subjectPosition);
        const moved = updateShooterMovement(actor, mesh, shooter, subjectPosition, delta, hasLineOfSight);
        mesh.getWorldPosition(origin);
        origin.y += SHOOTER_AI_PREFAB.muzzleHeight;

        mesh.lookAt(subjectPosition.x, mesh.position.y + SHOOTER_AI_PREFAB.muzzleHeight, subjectPosition.z);
        mesh.rotateY(Math.PI);
        if (!hasLineOfSight) {
            hideShooterAimWarning(actor);
            shooter.windupUntil = 0;
            updateDoomEnemySpriteAnimation(actor, delta, moved);
            return;
        }

        if ((shooter.nextShotAt || 0) > now) {
            hideShooterAimWarning(actor);
            updateDoomEnemySpriteAnimation(actor, delta, moved);
            return;
        }

        if (!shooter.windupUntil) {
            shooter.windupUntil = now + SHOOTER_AI_PREFAB.aimWarningMs;
        }
        const charge = 1 - Math.max(0, shooter.windupUntil - now) / SHOOTER_AI_PREFAB.aimWarningMs;
        updateShooterAimWarning(actor, origin, subjectPosition, charge, true);
        if (now < shooter.windupUntil) {
            updateDoomEnemySpriteAnimation(actor, delta, moved);
            return;
        }

        hideShooterAimWarning(actor);
        shooter.windupUntil = 0;
        _shooterActorMuzzleDir.copy(subjectPosition).sub(origin).normalize().multiplyScalar(0.55);
        origin.add(_shooterActorMuzzleDir);
        spawnShooterProjectile(origin, subjectPosition);
        shooter.nextShotAt = now + (Number.isFinite(shooter.cooldownMs) ? shooter.cooldownMs : SHOOTER_AI_PREFAB.cooldownMs);
        updateDoomEnemySpriteAnimation(actor, delta, moved);
    }

    function updateShooterAis(delta = 0) {
        updateShooterProjectiles(delta);
        updateShooterAiPhysicsHits();
        clampThrowingStarSpeed();
        if (!gameplay.active) return;

        const shooters = getGameplayPrefabActors('shooterAi', _scratchPrefab1);
        for (let i = 0; i < shooters.length; i++) {
            const actor = shooters[i];
            ensureGameplayPrefabScript(actor, SHOOTER_AI_USER_SCRIPT);
            runObjectEventScript(actor, 'tick', { deltaTime: delta });
        }
    }

    return {
        updateShooterProjectiles, updateShooterAiPhysicsHits,
        clampThrowingStarSpeed, isShooterLineOfSightClear,
        getShooterCoverPoint, updateShooterMovement,
        updateShooterAiActor, updateShooterAis,
    };
}
