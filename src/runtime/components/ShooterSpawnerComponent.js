import { ActorComponent } from './ActorComponent.js';

// ShooterSpawnerComponent — drives a shooter-spawner actor's wave timer +
// spawn ring. Replaces the imperative `updateShooterSpawnerActor(spawner)`
// loop in runtime.js (which read/wrote `userData.shooterSpawner`).
//
// Each spawner owns its own (wave, nextWaveAt) state directly on the
// component. Tick:
//   1. Skip if gameplay inactive or render mesh invisible.
//   2. Count its still-alive minions (spawnedBy === spawner.id).
//   3. If under cap AND past nextWaveAt, spawn next wave on a ring at
//      `spawnRadius` around the spawner's world position.
//   4. Score-value scales with wave count.
//
// Deps (injected via the factory closure or directly via constructor opts):
//   tuning           - SHOOTER_SPAWNER_PREFAB { firstWaveDelayMs, cooldownMs,
//                      maxAlive, spawnRadius }
//   baseScoreValue   - SHOOTER_AI_PREFAB.scoreValue (per-wave bonus is +10/wave)
//   isGameplayActive - () => bool   (gates ticking entirely)
//   getMinions       - () => Actor[] (all live shooterAi actors to filter)
//   spawnMinion      - (THREE.Vector3, { spawnedBy, scoreValue,
//                                        ignoreGroundActor }) => Actor | null
//   getRenderObject  - (actor) => Object3D | null
//   THREE            - the THREE namespace (needed for Vector3 in spawn calls)
//   tmp              - { v: THREE.Vector3 } shared scratch (avoid per-tick alloc)
//
// Owner-only mirror: the legacy reads from `actor.userData.shooterSpawner`
// keep working — the component writes `{ wave, nextWaveAt }` back to the
// owner's userData each frame so the user-script API (and serialization) is
// unchanged.
export class ShooterSpawnerComponent extends ActorComponent {
    static componentKey = 'ShooterSpawnerComponent';

    constructor({
        tuning,
        baseScoreValue = 0,
        isGameplayActive = () => true,
        getMinions = () => [],
        spawnMinion = null,
        getRenderObject = (actor) => actor?.mesh ?? null,
        THREE,
        tmp = null,
    } = {}) {
        super();
        this.tuning = tuning;
        this.baseScoreValue = baseScoreValue;
        this._isGameplayActive = isGameplayActive;
        this._getMinions = getMinions;
        this._spawnMinion = spawnMinion;
        this._getRenderObject = getRenderObject;
        this._THREE = THREE;
        this._tmp = tmp;

        this.wave = 0;
        this.nextWaveAt = 0;
    }

    /** Mirror userData state ←→ component state (call after restore from a
     * snapshot/save where the old `userData.shooterSpawner` blob exists). */
    syncFromUserData() {
        const blob = this.owner?.userData?.shooterSpawner;
        if (!blob) return;
        if (Number.isFinite(blob.wave)) this.wave = blob.wave;
        if (Number.isFinite(blob.nextWaveAt)) this.nextWaveAt = blob.nextWaveAt;
    }

    _writeBack() {
        const userData = this.owner?.userData;
        if (!userData) return;
        if (!userData.shooterSpawner) userData.shooterSpawner = {};
        userData.shooterSpawner.wave = this.wave;
        userData.shooterSpawner.nextWaveAt = this.nextWaveAt;
    }

    tick(/* deltaTime */) {
        const actor = this.owner;
        if (!actor) return;
        if (!this._isGameplayActive()) return;
        const mesh = this._getRenderObject(actor);
        if (!mesh?.visible) return;

        const now = performance.now?.() || Date.now();
        if (!Number.isFinite(this.nextWaveAt) || this.nextWaveAt === 0) {
            this.nextWaveAt = now + this.tuning.firstWaveDelayMs;
            this._writeBack();
            return;
        }

        // Count alive minions spawned by this actor.
        const minions = this._getMinions();
        let alive = 0;
        for (let i = 0; i < minions.length; i++) {
            const m = minions[i];
            const shooter = m?.userData?.shooterAi;
            if (shooter?.spawnedBy === actor.id
                && !shooter.defeated
                && this._getRenderObject(m)?.visible !== false) {
                alive++;
            }
        }
        if (alive >= this.tuning.maxAlive || now < this.nextWaveAt) return;

        this.wave += 1;
        const spawnCount = Math.min(
            this.tuning.maxAlive - alive,
            1 + Math.floor(this.wave / 2),
        );

        const center = this._tmp?.v ?? new this._THREE.Vector3();
        mesh.getWorldPosition(center);

        for (let i = 0; i < spawnCount; i++) {
            const angle = (i / Math.max(1, spawnCount)) * Math.PI * 2 + Math.random() * 0.7;
            const radius = this.tuning.spawnRadius * (0.65 + Math.random() * 0.5);
            this._spawnMinion?.(
                new this._THREE.Vector3(
                    center.x + Math.cos(angle) * radius,
                    center.y,
                    center.z + Math.sin(angle) * radius,
                ),
                {
                    spawnedBy: actor.id,
                    scoreValue: this.baseScoreValue + this.wave * 10,
                    ignoreGroundActor: actor,
                },
            );
        }

        this.nextWaveAt = now + this.tuning.cooldownMs;
        this._writeBack();
    }

    serialize() {
        return { wave: this.wave, nextWaveAt: this.nextWaveAt };
    }
}
