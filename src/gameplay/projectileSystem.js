import { createProjectileInstancer } from './projectileInstancer.js';
import * as THREE from 'three';

// Shooter-AI/player projectile spawn + clear. Wraps the instancer so callers
// just say spawnShooterProjectile(origin, target, opts). State lives in
// gameplayPrefabState.shooterProjectiles (shared array consumed by shooterAi
// update loop) — we just push/clear it.
//
// Deps:
//   getScene             - () => THREE.Scene | null
//   gameplayPrefabState  - shared object with .shooterProjectiles[] array
//   SHOOTER_AI_PREFAB    - default tuning (poolSize/speed/life/damage/hitRadius)
export function createProjectileSystem({
    getScene,
    gameplayPrefabState,
    SHOOTER_AI_PREFAB,
}) {
    let _projectileInstancer = null;
    const _directionScratch = new THREE.Vector3();
    const _projectilePool = [];
    const MAX_PROJECTILE_RECORD_POOL = 2048;

    function getProjectileInstancer() {
        const scene = getScene();
        if (!_projectileInstancer && scene) {
            _projectileInstancer = createProjectileInstancer(scene);
        }
        return _projectileInstancer;
    }

    function acquireProjectileMesh(options) {
        return getProjectileInstancer()?.acquire(options) ?? null;
    }

    function releaseProjectile(projectile) {
        if (!projectile || projectile._pooled) return;
        const handle = projectile?.mesh;
        if (handle) _projectileInstancer?.release(handle);
        projectile.mesh = null;
        projectile.ttl = 0;
        projectile._pooled = true;
        if (_projectilePool.length < MAX_PROJECTILE_RECORD_POOL) {
            _projectilePool.push(projectile);
        }
    }

    function spawnShooterProjectile(origin, target, options = {}) {
        const scene = getScene();
        if (!scene || !origin || (!target && !options.velocity)) return;

        const direction = options.velocity
            ? _directionScratch.copy(options.velocity)
            : _directionScratch.subVectors(target, origin);
        if (direction.lengthSq() < 1e-6) return;
        direction.normalize();

        const radius = options.radius ?? 0.12;
        const color = options.color ?? 0xff2d2d;
        const mesh = acquireProjectileMesh({
            poolKey: options.poolKey,
            radius,
            color,
            emissiveIntensity: options.emissiveIntensity ?? 2.6,
            light: options.light,
            lightIntensity: options.lightIntensity ?? 1.2,
            lightDistance: options.lightDistance ?? 2.2,
            name: options.name || 'Shooter AI Projectile',
        });
        if (!mesh) return;
        mesh.name = options.name || 'Shooter AI Projectile';
        mesh.position.copy(origin);

        const projectile = _projectilePool.pop() || { velocity: new THREE.Vector3() };
        projectile._pooled = false;
        projectile.mesh = mesh;
        projectile.poolKey = options.poolKey ?? 'shooterAiBullets';
        projectile.maxPoolSize = options.maxPoolSize ?? SHOOTER_AI_PREFAB.projectilePoolSize;
        projectile.velocity.copy(direction).multiplyScalar(options.speed ?? SHOOTER_AI_PREFAB.projectileSpeed);
        projectile.ttl = options.life ?? SHOOTER_AI_PREFAB.projectileLife;
        projectile.damage = options.damage ?? SHOOTER_AI_PREFAB.damage;
        projectile.hitRadius = options.hitRadius ?? SHOOTER_AI_PREFAB.hitRadius;
        projectile.hitsPlayer = options.hitsPlayer !== false;
        projectile.damagesShooters = options.damagesShooters === true;
        projectile.bounces = options.bounces ?? 0;
        projectile.bounceDamping = options.bounceDamping ?? 0.86;
        projectile.gravity = options.gravity ?? 0;
        gameplayPrefabState.shooterProjectiles.push(projectile);
    }

    function clearShooterProjectiles() {
        for (const projectile of gameplayPrefabState.shooterProjectiles) {
            releaseProjectile(projectile);
        }
        gameplayPrefabState.shooterProjectiles.length = 0;
    }

    return {
        getProjectileInstancer,
        acquireProjectileMesh,
        releaseProjectile,
        spawnShooterProjectile,
        clearShooterProjectiles,
    };
}
