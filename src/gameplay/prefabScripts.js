// Prefab user-script source strings, extracted verbatim from runtime.js.
// Template-literal program text injected into prefab script hosts at runtime
// (users edit these freely in the editor). Pure data, NO runtime deps, so
// they live here to slim runtime.js. Do not reflow or escape the contents.

const HELICOPTER_USER_SCRIPT = `const HELI = {
    maxLift: 14, liftAccel: 18, descendAccel: 10, hoverDamping: 1.6,
    maxForwardSpeed: 22, maxStrafeSpeed: 12, pitchAccel: 2.8, rollAccel: 2.8,
    yawRate: 1.8, yawAccel: 5, tiltAngle: 0.45, horizontalDrag: 0.55, levelTorque: 4.5,
};
const UP = new THREE.Vector3(0, 1, 0);
let rotorSpeed = 30;
let liftWidget = null;

function ensureLiftWidget() {
    if (liftWidget) return;
    try {
        liftWidget = CreateWidget(UTextWidget, {
            Text: 'Lift Accel: ' + HELI.liftAccel,
            fontSize: 18,
            color: '#ffd166',
            backgroundColor: 'rgba(0,0,0,0.6)',
            position: { x: 0.5, y: 0.05 },
        });
        liftWidget?.AddToViewport(30);
    } catch (e) { console.warn('[heli] widget create failed', e); }
}

function BeginPlay() {
    rotorSpeed = 30;
    ensureLiftWidget();
}

function Tick(DeltaTime) {
    const root = object || Self?.mesh;
    if (!root) return;
    root.getObjectByName('helicopter-main-rotor')?.rotateY(DeltaTime * rotorSpeed);
    root.getObjectByName('helicopter-tail-rotor')?.rotateZ(DeltaTime * rotorSpeed * 1.5);
}

function OnInput(Input, DeltaTime) {
    if (!physics?.Jolt || !body) return;
    const Jolt = physics.Jolt;
    const bi = physics.bodyInterface;
    const bodyId = body.GetID();

    const throttleFwd = (Input.forward ? 1 : 0) - (Input.back ? 1 : 0);
    const yawInput = (Input.right ? 1 : 0) - (Input.left ? 1 : 0);
    const liftUp = Input.lift ? 1 : 0;
    const liftDown = Input.descend ? 1 : 0;

    rotorSpeed = 30 + (liftUp ? 12 : 0) + Math.abs(throttleFwd) * 6;

    window.exampleWidgets?.speed?.SetText('Lift Accel: ' + HELI.liftAccel.toFixed(2));

    const jp = bi.GetPosition(bodyId);
    const position = new THREE.Vector3(jp.GetX(), jp.GetY(), jp.GetZ());
    const jr = bi.GetRotation(bodyId);
    const rotation = new THREE.Quaternion(jr.GetX(), jr.GetY(), jr.GetZ(), jr.GetW());
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(rotation).normalize();
    const flatForward = forward.clone(); flatForward.y = 0;
    if (flatForward.lengthSq() < 1e-4) flatForward.copy(forward);
    flatForward.normalize();
    const flatRight = new THREE.Vector3().crossVectors(flatForward, UP).normalize();

    const jv = bi.GetLinearVelocity(bodyId);
    const linVel = new THREE.Vector3(jv.GetX(), jv.GetY(), jv.GetZ());
    const ja = bi.GetAngularVelocity(bodyId);
    const angVel = new THREE.Vector3(ja.GetX(), ja.GetY(), ja.GetZ());

    let verticalAccel = 9.81;
    if (liftUp) verticalAccel += HELI.liftAccel;
    if (liftDown) verticalAccel -= HELI.descendAccel;
    if (!liftUp && !liftDown) verticalAccel -= linVel.y * HELI.hoverDamping;
    let newVy = linVel.y + verticalAccel * DeltaTime;
    newVy = THREE.MathUtils.clamp(newVy, -HELI.maxLift, HELI.maxLift);

    const targetFwdSpeed = throttleFwd * HELI.maxForwardSpeed;
    const horizVel = new THREE.Vector3(linVel.x, 0, linVel.z);
    const fwdSpeed = horizVel.dot(flatForward);
    const sideSpeed = horizVel.dot(flatRight);
    const nextFwd = THREE.MathUtils.damp(fwdSpeed, targetFwdSpeed, HELI.horizontalDrag * 4, DeltaTime);
    const nextSide = THREE.MathUtils.damp(sideSpeed, 0, HELI.horizontalDrag * 6, DeltaTime);
    const nextHoriz = flatForward.clone().multiplyScalar(nextFwd).addScaledVector(flatRight, nextSide);

    const nextVel = new Jolt.Vec3(nextHoriz.x, newVy, nextHoriz.z);
    bi.SetLinearVelocity(bodyId, nextVel);
    Jolt.destroy(nextVel);

    const targetYaw = -yawInput * HELI.yawRate;
    const nextYaw = THREE.MathUtils.damp(angVel.y, targetYaw, HELI.yawAccel, DeltaTime);
    const euler = new THREE.Euler().setFromQuaternion(rotation, 'YXZ');
    const targetPitch = -throttleFwd * HELI.tiltAngle;
    const pitchError = targetPitch - euler.x;
    const rollError = -euler.z;
    const pitchTorque = pitchError * HELI.levelTorque - angVel.x * 1.4;
    const rollTorque = rollError * HELI.levelTorque - angVel.z * 1.4;

    const nextAng = new Jolt.Vec3(
        angVel.x + pitchTorque * DeltaTime,
        nextYaw,
        angVel.z + rollTorque * DeltaTime,
    );
    bi.SetAngularVelocity(bodyId, nextAng);
    Jolt.destroy(nextAng);
    bi.ActivateBody(bodyId);
}

function OnPossessed() {
    rotorSpeed = 42;
}

function OnUnpossessed() {
    rotorSpeed = 30;
}`;

const COIN_USER_SCRIPT = `function OnTrigger(subject) {
    if (Self?.userData?.collected) return;
    Self.userData.collected = true;
    const mesh = object || Self?.mesh;
    if (mesh) mesh.visible = false;
    window.addGameScore?.(Self.userData?.scoreValue ?? 10);
}`;

const HEALTH_PICKUP_USER_SCRIPT = `function Tick() {
    if (!Self?.userData?.collected) return;
    const now = performance.now();
    if ((Self.userData.respawnAt || 0) > now) return;
    Self.userData.collected = false;
    const mesh = object || Self?.mesh;
    if (mesh) mesh.visible = true;
}

function OnTrigger(subject) {
    if (Self?.userData?.collected) return;
    if ((gameplay.health ?? 1) >= 1) return;
    const mesh = object || Self?.mesh;
    if (!mesh?.visible) return;
    Self.userData.collected = true;
    Self.userData.respawnAt = performance.now() + (Self.userData.respawnMs ?? 10000);
    mesh.visible = false;
    const heal = Self.userData?.healValue ?? 0.35;
    window.setPlayerHealth?.((gameplay.health ?? 1) + heal);
}`;

const TARGET_USER_SCRIPT = `function OnTrigger(subject) {
    const now = performance.now();
    if ((Self.userData.hitCooldownUntil || 0) > now) return;
    Self.userData.hitCooldownUntil = now + 650;
    window.addGameScore?.(Self.userData?.scoreValue ?? 25);
}`;

const TELEPORTER_USER_SCRIPT = `function OnTrigger(subject) {
    const now = performance.now();
    if ((Self.userData._tpCooldownUntil || 0) > now) return;

    const peers = (window.getGameplayPrefabActors?.('teleporter') || [])
        .filter((a) => a !== Self && (a.mesh || a.rootNode)?.visible !== false);
    const destinationActor = peers.length ? peers[0] : (window.getGameplayPrefabActors?.('playerSpawn') || [])[0];
    const destMesh = destinationActor && (destinationActor.mesh || destinationActor.rootNode);
    const dest = destMesh ? destMesh.getWorldPosition(new THREE.Vector3()) : null;
    if (!dest) return;

    window.teleportActiveGameplaySubject?.(dest);

    Self.userData._tpCooldownUntil = now + 900;
    if (destinationActor) destinationActor.userData._tpCooldownUntil = now + 900;
}`;

const DOOM_SHOTGUN_USER_SCRIPT = `// ===== DOOM SHOTGUN — all weapon logic lives here. Edit freely. =====
// OnTrigger: walk over the pickup -> equip (+ pickup chime).
// Tick: runs every frame while equipped -> firing, ammo, reload, HUD, recoil.
// Engine primitives (passed in as 'api' to every script; window.* still
// works via legacy shims, but prefer api.* in new scripts):
//   api.spawnImpactBurst(x,y,z,opts)    -> spark/puff at point
//   api.spawnTracer(ox,oy,oz,dx,dy,dz,len,color) -> bullet streak
//   api.spawnImpactDecal(x,y,z,nx,ny,nz,opts)    -> scorch on surface
//   api.spawnMuzzleSmoke()              -> smoke puff + ejected shell
//   api.flashActorHit(actor,color)      -> brief emissive flash
//   api.flashDoomShotgun(ms)            -> muzzle flash
//   api.playImpactSound(v,x,y,z)        -> bullet-on-wall thud (3D if xyz)
//   api.playEnemyHurtSound(v,x,y,z)     -> enemy grunt (3D if xyz)
//   api.playDoomShotgunSound(volume)    -> blast sfx
//   api.playDoomPickupSound(volume)     -> pickup chime
//   api.setWeaponHud(text)              -> bottom-right text ('' hides)
//   api.showDamageIndicator(angleRad)   -> directional red arc
//   api.spawnDoomPellet({ spreadX, spreadY, speed, damage, ... }) -> 1 pellet
//   api.applyCameraRecoil(pitch, yaw)      -> camera kick (radians)
//   api.equipDoomShotgun(Self)             -> equip
//   api.equipStraightGun / api.equipSniperRifle / api.equipThrowingStar
// Overridable engine hooks (set on window; defaults used if unset):
//   window.onBulletImpact(x,y,z,proj,nx,ny,nz)   -> a bullet hit a wall
//   window.onEnemyDamaged(actor,dmg,fatal,x,y,z) -> an enemy took damage
//   window.onPlayerDamaged(angleRad,dmg)         -> the player was hit
// Input: gameplay.input.firePressed / .reloadPressed (press 'R').

// ---- TUNABLES: change anything here ----
const MAG_SIZE        = 8;     // shells per magazine
const RESERVE_AMMO    = 24;    // spare shells carried
const RELOAD_MS       = 1300;  // reload duration
const SHOTS_PER_BURST = 1;     // bullets per fire press (1 = no burst)
const BURST_GAP_MS    = 90;    // delay between burst shots
const COOLDOWN_MS     = 760;   // lockout after a burst finishes
const PELLETS         = 7;     // pellets per shot
const SPREAD          = 0.075; // pellet cone size
const VOLUME          = 1.0;   // blast sound loudness, 0..1
const RECOIL_PITCH    = 0.05;  // upward camera kick per shot (radians)
const RECOIL_YAW      = 0.014; // random sideways kick per shot
const MUZZLE_SMOKE    = true;  // smoke puff + shell eject per shot
const IMPACT_FX       = true;  // spark + thud when bullets hit walls
const IMPACT_DECAL    = true;  // scorch mark left on walls
const TRACERS         = true;  // glowing streak per pellet
const ENEMY_HURT_FX   = true;  // flash + grunt on non-fatal enemy hits
const DMG_INDICATOR   = true;  // directional red arc when player is hit
const PELLET_PATTERN  = [      // per-pellet [x, y] offsets, scaled by SPREAD
    [0, 0], [-0.65, -0.2], [0.65, -0.18], [-0.35, 0.42],
    [0.38, 0.38], [-0.95, 0.16], [0.92, 0.12],
];

// Rogue upgrades live in window.rogueBuffs (set by the arena progression).
// Read them per use so picking a card takes effect immediately.
function rb() { return window.rogueBuffs || {}; }
function magSize() { return MAG_SIZE + (rb().magSize || 0); }

function ammo(ud) {
    if (ud._mag == null) { ud._mag = magSize(); ud._reserve = RESERVE_AMMO; }
    return ud;
}

// Install combat-feedback hooks. Engine calls these on impact/hurt/player-hit
// (defaults used if a hook is null). Edit these bodies to change the feel.
function installHooks() {
    window.onBulletImpact = IMPACT_FX ? function (x, y, z, proj, nx, ny, nz) {
        api.spawnImpactBurst?.(x, y, z, { color: 0xffd27a, count: 7 });
        api.playImpactSound?.(0.8, x, y, z); // 3D positional
        if (IMPACT_DECAL) api.spawnImpactDecal?.(x, y, z, nx, ny, nz, { dir: proj?.velocity });
    } : null;

    window.onEnemyDamaged = ENEMY_HURT_FX ? function (actor, dmg, fatal, x, y, z) {
        if (fatal) return; // engine already played the death sound/effect
        api.flashActorHit?.(actor, 0xff5555);
        api.playEnemyHurtSound?.(0.7, x, y, z); // 3D positional
    } : null;

    window.onPlayerDamaged = DMG_INDICATOR ? function (angleRad) {
        api.showDamageIndicator?.(angleRad);
    } : null;
}

function OnTrigger(subject) {
    if (Self?.userData?.collected) return;
    const mesh = object || Self?.mesh;
    if (!mesh?.visible) return;
    Self.userData.collected = true;
    const px = mesh.position.x, py = mesh.position.y, pz = mesh.position.z;
    mesh.visible = false;
    ammo(Self.userData);
    installHooks();
    api.equipDoomShotgun?.(Self);
    api.playDoomPickupSound?.(1, px, py, pz); // 3D positional
}

function fireOneShot() {
    const b = rb();
    const pelletCount = PELLETS + (b.pellets || 0);
    const dmgMul = b.damage || 1;
    for (let i = 0; i < pelletCount; i++) {
        const p = PELLET_PATTERN[i % PELLET_PATTERN.length];
        api.spawnDoomPellet?.({
            spreadX: p[0] * SPREAD, spreadY: p[1] * SPREAD, tracer: TRACERS,
            damage: (window.DOOM_SHOTGUN_DEFAULTS?.damage ?? 0.2) * dmgMul,
        });
    }
    api.flashDoomShotgun?.(85);
    api.playDoomShotgunSound?.(VOLUME);
    api.applyCameraRecoil?.(RECOIL_PITCH, (Math.random() - 0.5) * 2 * RECOIL_YAW);
    if (MUZZLE_SMOKE) api.spawnMuzzleSmoke?.();
}

function startReload(ud, now) {
    if (ud._reloadUntil) return;
    if (ud._reserve <= 0 || ud._mag >= magSize()) return;
    ud._reloadUntil = now + RELOAD_MS / (rb().reloadSpeed || 1);
    ud._burstLeft = 0;
}

function Tick(DeltaTime) {
    if (gameplay?.weapon?.type !== 'doomShotgun') return;

    const now = performance.now();
    const ud = ammo(Self.userData);

    // Reload: by key, or auto when the mag runs dry.
    if (gameplay.input.reloadPressed) {
        gameplay.input.reloadPressed = false;
        startReload(ud, now);
    }
    if (ud._reloadUntil) {
        if (now >= ud._reloadUntil) {
            const need = magSize() - ud._mag;
            const take = Math.min(need, ud._reserve);
            ud._mag += take;
            ud._reserve -= take;
            ud._reloadUntil = 0;
        } else {
            api.setWeaponHud?.('RELOADING');
            return; // can't fire mid-reload
        }
    }

    // Queue a burst on fire press (needs ammo + off cooldown).
    if (gameplay.input.firePressed) {
        gameplay.input.firePressed = false;
        if ((ud._cooldownUntil || 0) <= now && (ud._burstLeft || 0) <= 0) {
            if (ud._mag > 0) {
                ud._burstLeft = Math.min(SHOTS_PER_BURST, ud._mag);
                ud._nextShotAt = now;
            } else {
                startReload(ud, now); // dry-fire -> auto reload
            }
        }
    }

    // Drive the queued burst.
    if ((ud._burstLeft || 0) > 0 && now >= (ud._nextShotAt || 0) && ud._mag > 0) {
        fireOneShot();
        ud._mag -= 1;
        ud._burstLeft -= 1;
        const fr = rb().fireRate || 1;
        ud._nextShotAt = now + BURST_GAP_MS / fr;
        if (ud._burstLeft <= 0 || ud._mag <= 0) ud._cooldownUntil = now + COOLDOWN_MS / fr;
        if (ud._mag <= 0) startReload(ud, now);
    }

    api.setWeaponHud?.(ud._mag + ' / ' + ud._reserve);
}`;

const SHOOTER_AI_USER_SCRIPT = `function Tick(DeltaTime) {
    window.updateShooterAiActor?.(Self, DeltaTime);
}`;

const SHOOTER_SPAWNER_USER_SCRIPT = `function Tick(DeltaTime) {
    window.updateShooterSpawnerActor?.(Self, DeltaTime);
}`;

// ===== ROGUE WAVES — LEVEL BLUEPRINT / GAME MODE ==========================
// This script is attached to an invisible 'rogueGameMode' actor spawned in
// the arena. It owns the ENTIRE run: weapon pick gate, endless escalating
// waves, boss every 5th wave, the wave HUD, and the death check. Editable
// like any object script — it only calls window.RogueAPI primitives, no
// hardcoded engine internals. Think of it as the level's GameMode blueprint.
const ROGUE_GAMEMODE_SCRIPT = `// === ROGUE WAVES game mode (level blueprint) ===
// Phases: 'await-weapon' -> 'breather' -> 'fighting' -> (loop) / 'dead'
let phase = 'await-weapon';
let wave = 0;
let actors = [];
let nextWaveAt = 0;
const BREATHER_MS = 2600;

function BeginPlay() {
    phase = 'await-weapon';
    wave = 0;
    actors = [];
    window.RogueAPI?.setHud('ROGUE WAVES<br><span style="font:600 15px/1.4 inherit;opacity:.8">Pick a weapon, then leave the pad</span>');
}

function startWave(api, n) {
    wave = n;
    api.state().wave = n;
    const isBoss = (n % 5 === 0);
    if (isBoss) {
        actors = api.spawnBoss(n);
        const extra = Math.floor(n / 5) + 1;       // adds support adds
        actors = actors.concat(api.spawnWave(n, extra));
        api.setHud('WAVE ' + n + ' — <span style="color:#ff6b6b">BOSS</span>');
    } else {
        const count = 3 + (n - 1) * 2;             // endless escalation
        actors = api.spawnWave(n, count);
        api.setHud('WAVE ' + n);
    }
    phase = 'fighting';
}

function Tick(DeltaTime) {
    const api = window.RogueAPI;
    if (!api) return;
    const r = api.state();

    // Player died -> end the run once.
    if (!api.playerAlive() && phase !== 'dead') {
        phase = 'dead';
        api.triggerDeath();
        return;
    }
    if (phase === 'dead') return;

    // Hold until the run-start weapon card is resolved.
    if (phase === 'await-weapon') {
        if (!r.weapon) return;
        phase = 'breather';
        nextWaveAt = api.now() + 800;
        return;
    }

    if (phase === 'breather') {
        const left = Math.max(0, Math.ceil((nextWaveAt - api.now()) / 1000));
        api.setHud('NEXT WAVE IN ' + left + '…  <span style="opacity:.7">Combo x' + (r.combo || 0) + '</span>');
        if (api.now() >= nextWaveAt) startWave(api, wave + 1);
        return;
    }

    if (phase === 'fighting') {
        // Live HUD: wave + enemies left + combo streak.
        let alive = 0;
        for (const a of actors) {
            const m = a && a.userData;
            const s = m && m.shooterAi;
            if (s && !s.defeated) alive++;
        }
        const boss = (wave % 5 === 0) ? ' <span style="color:#ff6b6b">BOSS</span>' : '';
        api.setHud('WAVE ' + wave + boss + ' · ' + alive + ' left' +
            (r.combo > 1 ? '  <span style="color:#ffd166">Combo x' + r.combo + '</span>' : ''));
        if (api.waveCleared(actors)) {
            phase = 'breather';
            nextWaveAt = api.now() + BREATHER_MS;
        }
    }
}`;

export {
    HELICOPTER_USER_SCRIPT,
    COIN_USER_SCRIPT,
    HEALTH_PICKUP_USER_SCRIPT,
    TARGET_USER_SCRIPT,
    TELEPORTER_USER_SCRIPT,
    DOOM_SHOTGUN_USER_SCRIPT,
    SHOOTER_AI_USER_SCRIPT,
    SHOOTER_SPAWNER_USER_SCRIPT,
    ROGUE_GAMEMODE_SCRIPT,
};
