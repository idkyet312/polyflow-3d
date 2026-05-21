// Shooter-AI visual layer extracted from runtime.js.
//
// Owns: aim-warning line, health bar above shooters, death FX particles,
// hit-points scratch buffer used by ray queries, navmesh ring visual.
// State (line/particle objects) lives on `actor.userData.shooterAi.*`,
// never module-scope.

export function createShooterAiVisuals(deps) {
    const {
        THREE,
        scene, camera, currentMesh,
        gameplay, gameplayPrefabState,
        SHOOTER_AI_PREFAB, PLAYER_SETTINGS,
        upVector, tempVectorA,
        getActorRenderObject,
        getGameplaySubjectPosition,
        getGameplayPrefabActors,
        isDrivingVehicle,
        playEnemyDeathSound, playEnemyHurtSound,
        flashActorHit,
        addGameScore,
        setPlayerHealth,
    } = deps;

    // Persistent scratch points reused by getShooterHitPoints — callers must
    // consume the returned array synchronously before calling again.
    const _shooterHitPointBuf = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const _shooterHitPointsOut = [];

    function getShooterHitPoints() {
        const out = _shooterHitPointsOut;
        out.length = 0;
        const cam = camera();
        if (cam) out.push(cam.position);

        const subjectPosition = getGameplaySubjectPosition(_shooterHitPointBuf[0]);
        if (subjectPosition) {
            if (!isDrivingVehicle()) {
                out.push(_shooterHitPointBuf[1].copy(subjectPosition).addScaledVector(upVector, PLAYER_SETTINGS.eyeHeight * 0.35));
                out.push(_shooterHitPointBuf[2].copy(subjectPosition).addScaledVector(upVector, PLAYER_SETTINGS.eyeHeight * 0.85));
            } else {
                out.push(_shooterHitPointBuf[1].copy(subjectPosition).addScaledVector(upVector, 0.9));
            }
        }
        return out;
    }

    function addCircularNavmeshVisual(navmeshActor) {
        const mesh = getActorRenderObject(navmeshActor);
        if (!mesh) return;

        const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.94, 1, 96),
            new THREE.MeshBasicMaterial({
                color: 0x22d3ee, transparent: true, opacity: 0.36,
                side: THREE.DoubleSide, depthWrite: false,
            }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.09;
        ring.renderOrder = 3;
        ring.name = 'Circular Navmesh Path';
        mesh.add(ring);

        const center = new THREE.Mesh(
            new THREE.CircleGeometry(0.9, 64),
            new THREE.MeshBasicMaterial({
                color: 0x0891b2, transparent: true, opacity: 0.12,
                side: THREE.DoubleSide, depthWrite: false,
            }),
        );
        center.rotation.x = -Math.PI / 2;
        center.position.y = 0.085;
        center.renderOrder = 2;
        center.name = 'Circular Navmesh Area';
        mesh.add(center);
    }

    function addShooterAiVisual(actor) {
        const mesh = getActorRenderObject(actor);
        if (!mesh) return;

        const barrel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.12, 0.12, 1.15, 16),
            new THREE.MeshStandardMaterial({
                color: 0x111827, metalness: 0.35, roughness: 0.3,
                emissive: 0x450a0a, emissiveIntensity: 0.45,
            }),
        );
        barrel.name = 'Shooter Barrel';
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, SHOOTER_AI_PREFAB.muzzleHeight, -0.5);
        mesh.add(barrel);

        ensureShooterHealthBar(actor);
        ensureShooterAimWarning(actor);
        setShooterHealth(actor, actor.userData?.shooterAi?.health ?? SHOOTER_AI_PREFAB.health);
    }

    function ensureShooterAimWarning(actor) {
        const shooter = actor?.userData?.shooterAi;
        const sceneRoot = scene();
        if (!sceneRoot || !shooter) return null;
        if (shooter.aimWarning?.line?.parent) return shooter.aimWarning;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
        const material = new THREE.LineBasicMaterial({
            color: 0xff3333, transparent: true, opacity: 0.0,
            depthWrite: false, depthTest: false,
        });
        const line = new THREE.Line(geometry, material);
        line.name = 'Shooter Aim Warning';
        line.frustumCulled = false;
        line.renderOrder = 20;
        line.visible = false;
        sceneRoot.add(line);
        shooter.aimWarning = { line, geometry, material };
        return shooter.aimWarning;
    }

    function updateShooterAimWarning(actor, origin, target, charge = 0, visible = true) {
        const warning = ensureShooterAimWarning(actor);
        if (!warning?.line || !origin || !target) return;

        const positions = warning.geometry.attributes.position.array;
        positions[0] = origin.x; positions[1] = origin.y; positions[2] = origin.z;
        positions[3] = target.x; positions[4] = target.y; positions[5] = target.z;
        warning.geometry.attributes.position.needsUpdate = true;
        warning.material.opacity = THREE.MathUtils.clamp(charge, 0, 1) * 0.72;
        warning.line.visible = !!visible && warning.material.opacity > 0.02;
    }

    function hideShooterAimWarning(actor) {
        const warning = actor?.userData?.shooterAi?.aimWarning;
        if (warning?.line) warning.line.visible = false;
    }

    function clearShooterAimWarnings() {
        for (const actor of getGameplayPrefabActors('shooterAi')) {
            const shooter = actor?.userData?.shooterAi;
            const warning = shooter?.aimWarning;
            if (!warning) continue;
            warning.line?.parent?.remove(warning.line);
            warning.geometry?.dispose?.();
            warning.material?.dispose?.();
            delete shooter.aimWarning;
        }
    }

    function ensureShooterHealthBar(actor) {
        const mesh = getActorRenderObject(actor);
        if (!mesh) return null;

        const shooter = actor.userData?.shooterAi;
        if (!shooter) return null;
        if (shooter.healthBar?.group?.parent) return shooter.healthBar;

        const width = 1.28;
        const height = 0.13;
        const group = new THREE.Group();
        group.name = 'Shooter AI Health';
        group.position.set(0, 2.15, 0);
        group.renderOrder = 8;
        // Exclude the bar from actor recolor/tint traversals so the variant
        // tint can't override its green fill.
        group.userData.skipTint = true;

        const background = new THREE.Mesh(
            new THREE.PlaneGeometry(width, height),
            new THREE.MeshBasicMaterial({
                color: 0x1f2937, transparent: true, opacity: 0.9,
                side: THREE.DoubleSide, depthTest: false, depthWrite: false,
            }),
        );
        background.name = 'Shooter AI Health Back';
        background.renderOrder = 8;
        group.add(background);

        const fill = new THREE.Mesh(
            new THREE.PlaneGeometry(width, height * 0.72),
            new THREE.MeshBasicMaterial({
                color: 0x22c55e, transparent: true, opacity: 0.96,
                side: THREE.DoubleSide, depthTest: false, depthWrite: false,
            }),
        );
        fill.name = 'Shooter AI Health Fill';
        fill.position.z = 0.002;
        fill.renderOrder = 9;
        group.add(fill);

        mesh.add(group);
        shooter.healthBar = { group, fill, width };
        return shooter.healthBar;
    }

    function setShooterHealth(actor, value = SHOOTER_AI_PREFAB.health) {
        const shooter = actor?.userData?.shooterAi;
        if (!shooter) return;

        const maxHealth = Number.isFinite(shooter.maxHealth) ? shooter.maxHealth : SHOOTER_AI_PREFAB.health;
        const wasDefeated = !!shooter.defeated;
        shooter.health = THREE.MathUtils.clamp(Number(value) || 0, 0, maxHealth);
        const percent = maxHealth > 0 ? shooter.health / maxHealth : 0;
        const healthBar = ensureShooterHealthBar(actor);
        if (healthBar?.fill) {
            // Bar length is normalised to maxHealth (percent = health / maxHealth).
            healthBar.fill.scale.x = Math.max(0.001, percent);
            healthBar.fill.position.x = -healthBar.width * 0.5 + (healthBar.width * percent * 0.5);
            healthBar.fill.material.color.set(0x22c55e); // always green
            healthBar.group.visible = percent > 0;
        }

        if (percent <= 0) {
            shooter.defeated = true;
            hideShooterAimWarning(actor);
            const mesh = getActorRenderObject(actor);
            if (!wasDefeated) {
                emitShooterDeathEffect(actor);
                if (mesh) {
                    mesh.getWorldPosition(tempVectorA);
                    playEnemyDeathSound(1, tempVectorA.x, tempVectorA.y + 0.9, tempVectorA.z);
                } else {
                    playEnemyDeathSound(1);
                }
                addGameScore(shooter.scoreValue ?? SHOOTER_AI_PREFAB.scoreValue);
                const mesh0 = currentMesh();
                if (mesh0?.userData?.sampleType === 'doomArena') {
                    let ex = 0, ey = 0, ez = 0;
                    if (mesh) { mesh.getWorldPosition(tempVectorA); ex = tempVectorA.x; ey = tempVectorA.y; ez = tempVectorA.z; }
                    // Decoupled from the rogueWaves module via its window surface so
                    // the shooter-AI code carries no direct dependency on it.
                    const rw = (typeof window !== 'undefined') ? window.rogueWaves : null;
                    if (rw) {
                        // Variant XP weight: tanks/bosses drop more orbs.
                        const orbCount = Math.max(1, Math.round(actor?.userData?.rogueXp || 1));
                        for (let o = 0; o < orbCount; o++) {
                            rw.spawnRogueXpOrb(ex + (Math.random() - 0.5) * 0.6, ey + 0.9, ez + (Math.random() - 0.5) * 0.6);
                        }
                        rw.onRogueEnemyKilled?.(ex, ey, ez, actor);
                    }
                    const buffs = (typeof window !== 'undefined') ? window.rogueBuffs : null;
                    if (buffs && (buffs.lifesteal || 0) > 0) {
                        setPlayerHealth((gameplay.health ?? 1) + buffs.lifesteal);
                    }
                }
                if (mesh) {
                    mesh.traverse?.((node) => {
                        const mats = node?.material ? (Array.isArray(node.material) ? node.material : [node.material]) : [];
                        mats.forEach((mat) => {
                            if (mat?.emissive) {
                                mat.emissive.set(0xff0000);
                                mat.emissiveIntensity = 2.8;
                            }
                        });
                    });
                }
            }
            if (mesh) mesh.visible = false;
        }
    }

    function resetShooterAiState(actor) {
        const shooter = actor?.userData?.shooterAi;
        const mesh = getActorRenderObject(actor);
        if (!shooter || !mesh) return;

        shooter.defeated = false;
        shooter.nextShotAt = 0;
        shooter.windupUntil = 0;
        hideShooterAimWarning(actor);
        mesh.visible = true;
        ensureShooterHealthBar(actor);
        ensureShooterAimWarning(actor);
        setShooterHealth(actor, Number.isFinite(shooter.maxHealth) ? shooter.maxHealth : SHOOTER_AI_PREFAB.health);
    }

    function damageShooterAi(actor, amount = SHOOTER_AI_PREFAB.hitDamage) {
        const shooter = actor?.userData?.shooterAi;
        if (!shooter || shooter.defeated) return;

        const health = shooter.health ?? shooter.maxHealth ?? SHOOTER_AI_PREFAB.health;
        const dmg = Math.max(0, Number(amount) || 0);
        const fatal = health - dmg <= 0;
        setShooterHealth(actor, health - dmg);
        // Rogue Waves status-effect hook: lets the arena stamp burn/slow/freeze
        // on the actor it just hit. Separate from window.onEnemyDamaged (which
        // the weapon script owns for hurt FX) so neither clobbers the other.
        if (typeof window !== 'undefined' && window.onRogueEnemyHit) {
            try { window.onRogueEnemyHit(actor, dmg, fatal); } catch (e) { /* script error */ }
        }
        // Overridable hook: weapon scripts decide hurt FX. setShooterHealth already
        // plays the death sound on a fatal hit, so default only handles non-fatal.
        // x,y,z = enemy world position (for spatial audio in the hook).
        if (typeof window !== 'undefined' && window.onEnemyDamaged) {
            const hm = getActorRenderObject(actor);
            let hx, hy, hz;
            if (hm) { hm.getWorldPosition(tempVectorA); hx = tempVectorA.x; hy = tempVectorA.y + 0.9; hz = tempVectorA.z; }
            try { window.onEnemyDamaged(actor, dmg, fatal, hx, hy, hz); } catch (e) { /* script error */ }
        } else if (!fatal) {
            flashActorHit(actor, 0xff5555);
            const m = getActorRenderObject(actor);
            if (m) {
                m.getWorldPosition(tempVectorA);
                playEnemyHurtSound(0.7, tempVectorA.x, tempVectorA.y + 0.9, tempVectorA.z);
            } else {
                playEnemyHurtSound(0.7);
            }
        }
    }

    function emitShooterDeathEffect(actor) {
        const mesh = getActorRenderObject(actor);
        const sceneRoot = scene();
        if (!sceneRoot || !mesh) return;

        const origin = mesh.getWorldPosition(new THREE.Vector3());
        origin.y += 0.9;
        const particles = [];
        for (let i = 0; i < 14; i++) {
            const particle = new THREE.Mesh(
                new THREE.SphereGeometry(0.055, 8, 6),
                new THREE.MeshBasicMaterial({
                    color: i % 2 ? 0xff3333 : 0xffcc66,
                    transparent: true, opacity: 1,
                }),
            );
            particle.position.copy(origin);
            sceneRoot.add(particle);
            particles.push({
                mesh: particle,
                velocity: new THREE.Vector3(
                    (Math.random() - 0.5) * 4.2,
                    Math.random() * 3.4 + 1.0,
                    (Math.random() - 0.5) * 4.2,
                ),
            });
        }
        gameplayPrefabState.effects.push({ type: 'shooterDeath', particles, ttl: 0.72, maxTtl: 0.72 });
    }

    return {
        getShooterHitPoints,
        addCircularNavmeshVisual,
        addShooterAiVisual,
        ensureShooterAimWarning,
        updateShooterAimWarning,
        hideShooterAimWarning,
        clearShooterAimWarnings,
        ensureShooterHealthBar,
        setShooterHealth,
        resetShooterAiState,
        damageShooterAi,
        emitShooterDeathEffect,
    };
}
