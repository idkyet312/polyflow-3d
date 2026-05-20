import { createProjectileInstancer } from './projectileInstancer.js';

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
        const handle = projectile?.mesh;
        if (!handle) return;
        _projectileInstancer?.release(handle);
    }

    function spawnShooterProjectile(origin, target, options = {}) {
        const scene = getScene();
        if (!scene || !origin || (!target && !options.velocity)) return;

        const direction = options.velocity
            ? options.velocity.clone()
            : target.clone().sub(origin);
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

        gameplayPrefabState.shooterProjectiles.push({
            mesh,
            poolKey: options.poolKey ?? 'shooterAiBullets',
            maxPoolSize: options.maxPoolSize ?? SHOOTER_AI_PREFAB.projectilePoolSize,
            velocity: direction.multiplyScalar(options.speed ?? SHOOTER_AI_PREFAB.projectileSpeed),
            ttl: options.life ?? SHOOTER_AI_PREFAB.projectileLife,
            damage: options.damage ?? SHOOTER_AI_PREFAB.damage,
            hitRadius: options.hitRadius ?? SHOOTER_AI_PREFAB.hitRadius,
            hitsPlayer: options.hitsPlayer !== false,
            damagesShooters: options.damagesShooters === true,
            bounces: options.bounces ?? 0,
            bounceDamping: options.bounceDamping ?? 0.86,
            gravity: options.gravity ?? 0,
        });
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
