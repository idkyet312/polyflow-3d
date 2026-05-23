// Rogue Waves game mode — extracted from runtime.js.
//
// Self-contained roguelike layer for the doomArena level: XP orbs, the
// level-up upgrade-card picker, the run-start weapon picker, enemy variants,
// kill combo + health drops, the wave/XP HUD, and the death screen. The wave
// flow itself lives in ROGUE_GAMEMODE_SCRIPT (an attached level-blueprint
// actor) which calls back into the RogueAPI surface exposed here.
//
// Wiring: runtime.js calls createRogueWaves({ ...deps }) once and spreads the
// returned API onto its own scope (and window) so existing call sites and the
// game-mode script keep working unchanged. Reassigned engine vars (scene,
// currentMesh, renderer) are read live via appCore; stable objects/functions
// come through `deps`.
import * as THREE from 'three';
import { core } from '../runtime/appCore.js';

export const ROGUE_ENEMY_VARIANTS = {
    grunt:  { hpMul: 1.0, speedMul: 1.0,  cooldownMul: 1.0, scale: 1.0, tint: '#dc2626', xp: 1, score: 15 },
    rusher: { hpMul: 0.7, speedMul: 2.3,  cooldownMul: 1.3, scale: 0.85, tint: '#f59e0b', xp: 1, score: 18 },
    tank:   { hpMul: 4.5, speedMul: 0.55, cooldownMul: 1.1, scale: 1.55, tint: '#7c3aed', xp: 3, score: 45 },
    sniper: { hpMul: 0.8, speedMul: 0.8,  cooldownMul: 0.55, range: 60, scale: 0.95, tint: '#22d3ee', xp: 2, score: 30 },
    // bomber: fast, fragile, detonates on death dealing AoE damage to other
    // enemies (handled in onRogueEnemyKilled) and a burst of bonus XP orbs.
    bomber: { hpMul: 0.9, speedMul: 1.6,  cooldownMul: 1.0, scale: 1.0, tint: '#84cc16', xp: 2, score: 28, bomber: true },
    boss:   { hpMul: 22,  speedMul: 0.8,  cooldownMul: 0.7, scale: 2.6, tint: '#ef4444', xp: 12, score: 250 },
};

const ROGUE_HELP_TITLE = 'ROGUE WAVES - HOW TO PLAY';
const ROGUE_HELP_LINES = [
    'Step off the start pad and pick a weapon card.',
    'Survive waves, dodge projectiles, and collect XP orbs from kills.',
    'Level up to pick upgrade cards. Boss waves spawn stronger enemies.',
];

// Elite modifier: rolled per non-boss spawn from wave 4+. Beefier, faster,
// gold-tinted, and worth far more XP/score. Adds a build-defining "do I focus
// it?" decision to a wave instead of every enemy being interchangeable.
const ELITE_MOD = { hpMul: 2.6, speedMul: 1.15, scaleMul: 1.25, xpAdd: 3, scoreAdd: 60, tint: '#ffd23f' };
let rogueStatusHookInstalled = false;
function rollEliteChance(wave) {
    if (wave < 4) return 0;
    return Math.min(0.28, 0.05 + (wave - 4) * 0.025);
}

const ROGUE_CARDS_BY_WEAPON = {
    doomShotgun: [
        { t: 'Heavy Slugs',   d: '+25% pellet damage',     a: (b) => b.damage *= 1.25 },
        { t: 'Rapid Pump',    d: '+20% fire rate',         a: (b) => b.fireRate *= 1.2 },
        { t: 'Wide Choke',    d: '+2 pellets per shot',    a: (b) => b.pellets += 2 },
        { t: 'Extended Mag',  d: '+4 shells per magazine', a: (b) => b.magSize += 4 },
        { t: 'Fast Hands',    d: '+30% reload speed',      a: (b) => b.reloadSpeed *= 1.3 },
        { t: 'Double Barrel', d: '+50% dmg, -10% fire rate', a: (b) => { b.damage *= 1.5; b.fireRate *= 0.9; } },
    ],
    smg: [
        { t: 'Hollow Points', d: '+22% bullet damage',     a: (b) => b.damage *= 1.22 },
        { t: 'Hair Trigger',  d: '+30% fire rate',         a: (b) => b.fireRate *= 1.3 },
        { t: 'Overclock',     d: '+45% fire rate, -12% dmg', a: (b) => { b.fireRate *= 1.45; b.damage *= 0.88; } },
        { t: 'Match Barrel',  d: '+35% damage, -10% fire rate', a: (b) => { b.damage *= 1.35; b.fireRate *= 0.9; } },
        { t: 'Steady Aim',    d: '+15% damage',            a: (b) => b.damage *= 1.15 },
        { t: 'Spray & Pray',  d: '+18% fire rate',         a: (b) => b.fireRate *= 1.18 },
        { t: 'Minigun Moment', d: 'Every 5s, fire like a minigun for 2s', a: (b) => { b.smgMinigun = true; b.smgMinigunStartedAt = performance.now?.() || Date.now(); } },
    ],
    throwingStar: [
        { t: 'Honed Edge',    d: '+25% star damage',       a: (b) => b.damage *= 1.25 },
        { t: 'Quick Draw',    d: '+25% throw rate',        a: (b) => b.fireRate *= 1.25 },
        { t: 'Ricochet+',     d: 'Star lasts longer',      a: (b) => b.pellets += 1 },
        { t: 'Triple Star',   d: 'Throw 3 stars at once',  a: (b) => b.starCount = Math.max(b.starCount || 1, 3) },
        { t: 'Bloodletter',   d: '+35% dmg, -10% throw rate', a: (b) => { b.damage *= 1.35; b.fireRate *= 0.9; } },
        { t: 'Twin Fang',     d: '+20% throw rate',        a: (b) => b.fireRate *= 1.2 },
        { t: 'Serrated',      d: '+18% star damage',       a: (b) => b.damage *= 1.18 },
    ],
};

// Factory: runtime.js injects engine functions/objects. Reassigned vars
// (scene/currentMesh/renderer) are read live from appCore inside each fn.
export function createRogueWaves(deps) {
    const {
        gameplay, mobileState, SHOOTER_AI_PREFAB,
        spawnDoomEnemyAt, getActorRenderObject, tintGameplayPrefabActor,
        setPlayerHealth, isDoomMiniWaveCleared, getGameplayPrefabActors,
        ensureGameplayPrefabScript, runObjectEventScript, scratchPrefab, flashActorHit,
        getRogueGameModeScript, getResetDoomArenaLevelState, respawnPlayer,
        equipDoomShotgun, equipStraightGun, equipThrowingStar,
    } = deps;

    let _spawnFlareGeo = null;
    function spawnRogueSpawnFlare(position, color = 0xff3030, scale = 1) {
        const { scene } = core;
        if (!scene || !position) return;
        if (!_spawnFlareGeo) _spawnFlareGeo = new THREE.TorusGeometry(0.9, 0.035, 8, 32);
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, toneMapped: false });
        const ring = new THREE.Mesh(_spawnFlareGeo, mat);
        ring.position.set(position.x, position.y + 0.05, position.z);
        ring.rotation.x = Math.PI / 2;
        ring.scale.setScalar(scale);
        ring.renderOrder = 9;
        scene.add(ring);
        const born = performance.now?.() || Date.now();
        const tick = () => {
            if (!ring.parent) return;
            const t = Math.min(1, ((performance.now?.() || Date.now()) - born) / 650);
            ring.scale.setScalar(scale * (1 + t * 1.6));
            mat.opacity = 0.85 * (1 - t);
            if (t < 1) requestAnimationFrame(tick);
            else {
                scene.remove(ring);
                mat.dispose();
            }
        };
        requestAnimationFrame(tick);
    }

    // ---- enemy variants -------------------------------------------------
    function spawnRogueEnemy(variant, position, wave = 1, { elite = false } = {}) {
        const v = ROGUE_ENEMY_VARIANTS[variant] || ROGUE_ENEMY_VARIANTS.grunt;
        // Global HP scale for Rogue Waves enemies (2/3 = die a bit faster).
        const base = SHOOTER_AI_PREFAB.health * (2 / 3);
        const waveScale = 1 + Math.max(0, wave - 1) * 0.06;
        const eliteHp = elite ? ELITE_MOD.hpMul : 1;
        const eliteSpeed = elite ? ELITE_MOD.speedMul : 1;
        const eliteScale = elite ? ELITE_MOD.scaleMul : 1;
        const hp = base * v.hpMul * waveScale * eliteHp;
        spawnRogueSpawnFlare(position, elite ? 0xffd23f : new THREE.Color(v.tint).getHex(), v.scale * eliteScale);
        const actor = spawnDoomEnemyAt(position, {
            label: `Arena ${elite ? 'ELITE ' : ''}${variant} W${wave}`,
            groundY: position.y,
            health: hp,
            maxHealth: hp,
            speedMul: v.speedMul * eliteSpeed,
            cooldownMs: SHOOTER_AI_PREFAB.cooldownMs * v.cooldownMul,
            range: v.range,
            rogueVariant: variant,
            scoreValue: SHOOTER_AI_PREFAB.scoreValue + v.score + wave * 4 + (elite ? ELITE_MOD.scoreAdd : 0),
        });
        if (!actor) return null;
        actor.userData.rogueXp = v.xp + (elite ? ELITE_MOD.xpAdd : 0);
        actor.userData.rogueBomber = !!v.bomber;
        actor.userData.rogueElite = !!elite;
        actor.userData.rogueWave = wave;
        // Clear any status carried over from a pooled/reused actor.
        actor.userData.rogueStatus = null;
        if (actor.userData.shooterAi) actor.userData.shooterAi._slowFactor = 1;
        const mesh = getActorRenderObject(actor);
        const finalScale = v.scale * eliteScale;
        if (mesh && finalScale !== 1) {
            mesh.scale.multiplyScalar(finalScale);
            mesh.updateMatrixWorld(true);
        }
        const tint = elite ? ELITE_MOD.tint : v.tint;
        const glow = variant === 'boss' ? 1.8 : (elite ? 1.5 : 1.0);
        try { tintGameplayPrefabActor(actor, tint, tint, glow); } catch (e) {}
        return actor;
    }

    // ---- run state ------------------------------------------------------
    function defaultRogueBuffs() {
        return {
            damage: 1, fireRate: 1, pellets: 0, magSize: 0, reloadSpeed: 1, starCount: 1,
            smgMinigun: false, smgMinigunStartedAt: 0,
            moveSpeed: 1, maxHealth: 1, damageTaken: 1, lifesteal: 0, xpGain: 1,
            orbRadius: 0, orbMagnet: 1, healthDrop: 0, waveHeal: 0, comboWindow: 0,
            // Status-effect upgrades (0 = inactive):
            //   burn        - total capped burn damage applied over BURN_DURATION
            //   slow        - 0..1 movement slow fraction applied on hit
            //   freezeChance- 0..1 chance per hit to fully freeze for FREEZE_DURATION
            burn: 0, slow: 0, freezeChance: 0,
        };
    }

    function ensureRogueState() {
        window.rogueBuffs = { ...defaultRogueBuffs(), ...(window.rogueBuffs || {}) };
        if (!window.rogue) {
            window.rogue = {
                xp: 0, level: 1, xpToNext: 5, orbs: [], picking: false,
                weapon: '', wave: 0, kills: 0, combo: 0, comboUntil: 0, dead: false,
            };
        }
        return window.rogue;
    }

    function resetRogueState() {
        const { scene } = core;
        window.rogueBuffs = defaultRogueBuffs();
        const r = window.rogue;
        if (r) {
            for (const o of r.orbs) { try { scene?.remove(o.mesh); } catch (e) {} }
            r.orbs.length = 0;
        }
        window.rogue = {
            xp: 0, level: 1, xpToNext: 5, orbs: [], picking: false, weapon: '',
            wave: 0, kills: 0, combo: 0, comboUntil: 0, dead: false,
        };
        gameplay.roguePaused = false;
        closeRogueDeathScreen();
        closeRogueCardPicker();
        document.querySelectorAll('.rogue-overlay').forEach((n) => n.remove());
        // Float-text layer + combo banner are .rogue-overlay nodes removed
        // above; drop stale refs so they're rebuilt fresh next run.
        _rogueFloatLayer = null;
        _rogueBannerEl = null;
        if (_rogueBannerTimer) { clearTimeout(_rogueBannerTimer); _rogueBannerTimer = null; }
        updateRogueXpBar();
    }

    // ---- juice: camera shake + floating combat text ---------------------
    // Reuses the existing per-frame camera-shake driver in playerCombat
    // (gameplay.hitFeedback.shake is decayed + applied to the camera every
    // frame) so kills/explosions kick the view without new wiring.
    function addRogueShake(amount) {
        const fb = gameplay.hitFeedback;
        if (!fb) return;
        fb.shake = Math.min(2.2, Math.max(fb.shake || 0, amount));
    }

    let _rogueFloatLayer = null;
    function rogueFloatLayer() {
        if (_rogueFloatLayer?.parentNode) return _rogueFloatLayer;
        const el = document.createElement('div');
        el.className = 'rogue-overlay';
        el.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:997;overflow:hidden;';
        (document.getElementById('canvas-container') || document.body)?.appendChild(el);
        _rogueFloatLayer = el;
        return el;
    }

    // Project a world position to screen and pop a short-lived rising label.
    function floatWorldText(text, worldPos, { color = '#ffd166', size = 18, big = false } = {}) {
        const { camera, renderer } = core;
        if (!camera || !renderer || !worldPos) return;
        const v = _tmpProj.copy(worldPos).project(camera);
        if (v.z > 1) return; // behind camera
        const rect = renderer.domElement.getBoundingClientRect();
        const host = (document.getElementById('canvas-container') || document.body).getBoundingClientRect();
        const x = rect.left - host.left + (v.x * 0.5 + 0.5) * rect.width;
        const y = rect.top - host.top + (-v.y * 0.5 + 0.5) * rect.height;
        const node = document.createElement('div');
        node.textContent = text;
        node.style.cssText = `position:absolute;left:${x}px;top:${y}px;`
            + `transform:translate(-50%,-50%);color:${color};`
            + `font:${big ? 900 : 800} ${size}px/1 "Trebuchet MS",system-ui,sans-serif;`
            + `text-shadow:0 2px 6px rgba(0,0,0,0.9);will-change:transform,opacity;`
            + `transition:transform .7s cubic-bezier(.2,.7,.3,1),opacity .7s ease;opacity:1;`;
        rogueFloatLayer().appendChild(node);
        requestAnimationFrame(() => {
            node.style.transform = `translate(-50%,-50%) translateY(${big ? -70 : -46}px) scale(${big ? 1.25 : 1})`;
            node.style.opacity = '0';
        });
        setTimeout(() => node.remove(), 760);
    }

    // Center banner for combo milestones / boss alerts.
    let _rogueBannerEl = null;
    let _rogueBannerTimer = null;
    function rogueBanner(text, color = '#ffd166') {
        if (!_rogueBannerEl?.parentNode) {
            const el = document.createElement('div');
            el.className = 'rogue-overlay';
            el.style.cssText = 'position:absolute;left:50%;top:34%;transform:translate(-50%,-50%);'
                + 'pointer-events:none;z-index:998;text-align:center;'
                + 'font:900 34px/1 "Trebuchet MS",system-ui,sans-serif;'
                + 'text-shadow:0 0 22px rgba(0,0,0,0.8);transition:opacity .25s,transform .25s;opacity:0;';
            (document.getElementById('canvas-container') || document.body)?.appendChild(el);
            _rogueBannerEl = el;
        }
        const el = _rogueBannerEl;
        el.style.color = color;
        el.innerHTML = text;
        el.style.opacity = '1';
        el.style.transform = 'translate(-50%,-50%) scale(1.08)';
        if (_rogueBannerTimer) clearTimeout(_rogueBannerTimer);
        requestAnimationFrame(() => { el.style.transform = 'translate(-50%,-50%) scale(1)'; });
        _rogueBannerTimer = setTimeout(() => { if (el) el.style.opacity = '0'; }, 900);
    }

    const _tmpProj = new THREE.Vector3();
    const _tmpExplode = new THREE.Vector3();
    const _tmpStatus = new THREE.Vector3();

    // ---- status effects (burn / slow / freeze) --------------------------
    // Status lives on actor.userData.rogueStatus and is driven by the arena's
    // per-frame tick (tickRogueStatuses). Effects are stamped on hit via the
    // window.onRogueEnemyHit engine hook installed in installRogueStatusHook().
    const BURN_DURATION_MS = 3000;   // total burn lifetime per refresh
    const BURN_TICK_MS = 500;        // DoT cadence
    const BURN_MAX_DAMAGE = 0.55;    // cap total burn damage per ignite
    const SLOW_DURATION_MS = 1800;   // slow lingers then decays
    const FREEZE_DURATION_MS = 1100; // hard stop
    const STATUS_FLOAT_COOLDOWN_MS = 600; // throttle floating "Frozen!" text

    function ensureRogueStatus(actor) {
        if (!actor.userData.rogueStatus) {
            actor.userData.rogueStatus = {
                burnUntil: 0, burnDps: 0, burnTickAt: 0, burnRemaining: 0,
                slowUntil: 0, slowMul: 1,
                freezeUntil: 0, lastFloatAt: 0,
            };
        }
        return actor.userData.rogueStatus;
    }

    function applyRogueStatusOnHit(actor) {
        const buffs = window.rogueBuffs || {};
        if (!actor?.userData?.shooterAi || actor.userData.shooterAi.defeated) return;
        const hasAny = (buffs.burn || 0) > 0 || (buffs.slow || 0) > 0 || (buffs.freezeChance || 0) > 0;
        if (!hasAny) return;
        const st = ensureRogueStatus(actor);
        const now = performance.now?.() || Date.now();

        if ((buffs.burn || 0) > 0) {
            const burnTotal = Math.min(BURN_MAX_DAMAGE, buffs.burn);
            st.burnDps = burnTotal / (BURN_DURATION_MS / 1000);
            st.burnRemaining = Math.max(st.burnRemaining || 0, burnTotal);
            st.burnUntil = now + BURN_DURATION_MS;
            if (!st.burnTickAt) st.burnTickAt = now + BURN_TICK_MS;
        }
        if ((buffs.slow || 0) > 0) {
            st.slowMul = Math.max(0.15, 1 - buffs.slow);
            st.slowUntil = now + SLOW_DURATION_MS;
        }
        if ((buffs.freezeChance || 0) > 0 && Math.random() < buffs.freezeChance) {
            st.freezeUntil = now + FREEZE_DURATION_MS;
            if (now - (st.lastFloatAt || 0) > STATUS_FLOAT_COOLDOWN_MS) {
                st.lastFloatAt = now;
                const m = getActorRenderObject(actor);
                if (m) floatWorldText('FROZEN', m.getWorldPosition(_tmpStatus).clone(), { color: '#7dd3fc', size: 16 });
            }
        }
    }

    function installRogueStatusHook() {
        if (typeof window === 'undefined' || rogueStatusHookInstalled) return;
        rogueStatusHookInstalled = true;
        window.onRogueEnemyHit = (actor, _dmg, fatal) => {
            if (fatal) return;
            applyRogueStatusOnHit(actor);
        };
    }

    // Per-frame status driver: burn DoT, slow/freeze decay → shooter._slowFactor.
    function tickRogueStatuses(delta = 0.016) {
        const now = performance.now?.() || Date.now();
        const damageFn = (typeof window !== 'undefined') ? window.damageShooterAi : null;
        const actors = getGameplayPrefabActors('shooterAi', scratchPrefab());
        for (const a of actors) {
            const ai = a?.userData?.shooterAi;
            if (!ai || ai.defeated) continue;
            const st = a.userData.rogueStatus;
            if (!st) { ai._slowFactor = 1; continue; }

            // Burn DoT.
            if (st.burnUntil > now && st.burnDps > 0 && (st.burnRemaining || 0) > 0) {
                if (now >= st.burnTickAt) {
                    st.burnTickAt = now + BURN_TICK_MS;
                    const damage = Math.min(st.burnRemaining, st.burnDps * (BURN_TICK_MS / 1000));
                    st.burnRemaining -= damage;
                    if (damageFn && damage > 0) damageFn(a, damage);
                    try { flashActorHit(a, 0xff8a3d); } catch (e) {}
                }
            } else {
                st.burnDps = 0; st.burnTickAt = 0; st.burnRemaining = 0;
            }

            // Freeze takes priority, then slow, then full speed.
            if (st.freezeUntil > now) {
                ai._slowFactor = 0;
            } else if (st.slowUntil > now) {
                ai._slowFactor = st.slowMul;
            } else {
                ai._slowFactor = 1;
            }
        }
    }

    // ---- XP orbs --------------------------------------------------------
    let _rogueOrbGeo = null;
    function spawnRogueXpOrb(x, y, z) {
        const { scene } = core;
        ensureRogueState();
        if (!scene || typeof THREE === 'undefined') return;
        if (!_rogueOrbGeo) _rogueOrbGeo = new THREE.SphereGeometry(0.16, 8, 8);
        const mesh = new THREE.Mesh(
            _rogueOrbGeo,
            new THREE.MeshBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.95 }),
        );
        mesh.position.set(x, y, z);
        mesh.renderOrder = 8;
        scene.add(mesh);
        const ang = Math.random() * Math.PI * 2;
        window.rogue.orbs.push({
            mesh,
            vx: Math.cos(ang) * 2.2,
            vy: 3.0 + Math.random() * 1.5,
            vz: Math.sin(ang) * 2.2,
            born: performance.now?.() || Date.now(),
        });
    }

    function updateRogueXpOrbs(playerPos, delta = 0.016) {
        const { scene } = core;
        const r = window.rogue;
        if (!r || !r.orbs.length || !playerPos) return;
        const dt = Math.min(0.05, Math.max(0.001, delta || 0.016));
        const now = performance.now?.() || Date.now();
        const buffs = window.rogueBuffs || {};
        const pickupRadius = 1.0 + (buffs.orbRadius || 0);
        const magnet = Math.max(0.1, buffs.orbMagnet || 1);
        for (let i = r.orbs.length - 1; i >= 0; i--) {
            const o = r.orbs[i];
            const m = o.mesh;
            const age = (now - o.born) / 1000;
            const dx = playerPos.x - m.position.x;
            const dy = (playerPos.y + 1.0) - m.position.y;
            const dz = playerPos.z - m.position.z;
            const dist = Math.hypot(dx, dy, dz);
            if (dist < pickupRadius || age > 12) {
                scene?.remove(m);
                r.orbs.splice(i, 1);
                if (age <= 12) {
                    if (o.heal) setPlayerHealth((gameplay.health ?? 1) + 0.25);
                    else {
                        const mult = 1 + Math.min(2, Math.floor((r.combo || 0) / 5) * 0.5);
                        grantRogueXp(1 * mult);
                    }
                }
                continue;
            }
            if (age < 0.35) {
                o.vy -= 9 * dt;
                m.position.x += o.vx * dt;
                m.position.y += o.vy * dt;
                m.position.z += o.vz * dt;
            } else {
                const pull = (6 + age * 4) * magnet;
                m.position.x += (dx / dist) * pull * dt;
                m.position.y += (dy / dist) * pull * dt;
                m.position.z += (dz / dist) * pull * dt;
            }
            m.scale.setScalar(1 + 0.2 * Math.sin(now * 0.012 + i));
        }
    }

    function grantRogueXp(amount) {
        const r = ensureRogueState();
        r.xp += (Number(amount) || 0) * (window.rogueBuffs.xpGain || 1);
        let leveled = false;
        while (r.xp >= r.xpToNext) {
            r.xp -= r.xpToNext;
            r.level += 1;
            // Gentler curve (1.28 vs 1.35): keeps cards flowing into the
            // mid-game so builds keep evolving instead of stalling out.
            r.xpToNext = Math.round(r.xpToNext * 1.28 + 2);
            leveled = true;
        }
        updateRogueXpBar();
        if (leveled) openRogueCardPicker();
    }

    // ---- kill combo + drops --------------------------------------------
    // Longer window at higher combos so streaks are sustainable but still
    // require pressure — rewards aggressive play without being free.
    const COMBO_BASE_WINDOW_MS = 3200;
    function comboWindowMs(combo) {
        return COMBO_BASE_WINDOW_MS + (window.rogueBuffs?.comboWindow || 0) + Math.min(2000, combo * 60);
    }
    function onRogueEnemyKilled(x, y, z, actor) {
        const r = ensureRogueState();
        const now = performance.now?.() || Date.now();
        if (now > (r.comboUntil || 0)) r.combo = 0;
        r.combo += 1;
        r.kills += 1;
        r.comboUntil = now + comboWindowMs(r.combo);
        if (r.combo > (r._bestCombo || 0)) r._bestCombo = r.combo;

        const isBomber = !!actor?.userData?.rogueBomber;
        const isElite = !!actor?.userData?.rogueElite;

        // Kill juice: small shake, scaled up for elites; floating score pop.
        addRogueShake(isElite ? 0.75 : 0.32);
        const killPos = _tmpProj.set(x, y + 1.0, z).clone();
        if (isElite) {
            floatWorldText('ELITE DOWN', killPos, { color: '#ffd23f', size: 22, big: true });
        }

        // Combo milestone rewards + banner flair.
        if (r.combo > 0 && r.combo % 5 === 0) {
            grantRogueXp(2);
            addRogueShake(0.5);
            const tier = r.combo >= 20 ? '#ff4d6d' : r.combo >= 10 ? '#ffae00' : '#ffd166';
            rogueBanner(`COMBO x${r.combo}`, tier);
        }

        // Health drop scales gently with combo; elites guarantee a drop.
        const dropChance = (isElite ? 1 : 0) + 0.10 + (window.rogueBuffs?.healthDrop || 0) + Math.min(0.20, r.combo * 0.012);
        if (Math.random() < dropChance) spawnRogueHealthOrb(x, y + 0.9, z);

        // Bomber detonation: damage nearby living enemies + spray bonus XP orbs.
        if (isBomber) detonateBomber(x, y, z, actor);

        updateRogueXpBar();
    }

    // Bomber AoE: find other rogue enemies within radius, deal a chunk of
    // damage, and shower the blast site with extra XP orbs. Self-contained —
    // reads the live prefab-actor list and pokes shooterAi health directly.
    function detonateBomber(x, y, z, selfActor) {
        addRogueShake(0.9);
        floatWorldText('BOOM', _tmpProj.set(x, y + 1.2, z).clone(), { color: '#84cc16', size: 24, big: true });
        for (let i = 0; i < 4; i++) {
            spawnRogueXpOrb(x + (Math.random() - 0.5) * 1.2, y + 0.9, z + (Math.random() - 0.5) * 1.2);
        }
        const RADIUS = 4.5;
        const DAMAGE = 40;
        const damageFn = (typeof window !== 'undefined') ? window.damageShooterAi : null;
        // Snapshot first: damageShooterAi can defeat actors and mutate the
        // shared prefab list mid-iteration.
        const actors = getGameplayPrefabActors('shooterAi', scratchPrefab()).slice();
        for (const a of actors) {
            if (!a || a === selfActor) continue;
            const ai = a.userData?.shooterAi;
            if (!ai || ai.defeated) continue;
            const m = getActorRenderObject(a);
            if (!m) continue;
            _tmpExplode.copy(m.position);
            const dist = Math.hypot(_tmpExplode.x - x, _tmpExplode.y - y, _tmpExplode.z - z);
            if (dist > RADIUS) continue;
            const falloff = 1 - dist / RADIUS;
            // Route through the real damage path so deaths trigger XP orbs,
            // score, and death FX (chain reactions if a bomber is caught).
            if (damageFn) damageFn(a, DAMAGE * falloff);
        }
    }

    let _rogueHealthGeo = null;
    function spawnRogueHealthOrb(x, y, z) {
        const { scene } = core;
        ensureRogueState();
        if (!scene || typeof THREE === 'undefined') return;
        if (!_rogueHealthGeo) _rogueHealthGeo = new THREE.SphereGeometry(0.2, 8, 8);
        const mesh = new THREE.Mesh(
            _rogueHealthGeo,
            new THREE.MeshBasicMaterial({ color: 0x22ff66, transparent: true, opacity: 0.95 }),
        );
        mesh.position.set(x, y, z);
        mesh.renderOrder = 8;
        scene.add(mesh);
        const ang = Math.random() * Math.PI * 2;
        window.rogue.orbs.push({
            mesh, heal: true,
            vx: Math.cos(ang) * 1.6,
            vy: 2.6 + Math.random(),
            vz: Math.sin(ang) * 1.6,
            born: performance.now?.() || Date.now(),
        });
    }

    // ---- death screen ---------------------------------------------------
    let rogueDeathEl = null;
    function openRogueDeathScreen() {
        const r = ensureRogueState();
        if (r.dead) return;
        r.dead = true;
        gameplay.roguePaused = true;
        try { document.exitPointerLock?.(); } catch (e) {}

        const overlay = document.createElement('div');
        overlay.className = 'rogue-overlay';
        overlay.style.cssText = `
            position:absolute; inset:0; z-index:1300; pointer-events:auto;
            background:rgba(20,2,2,0.86); backdrop-filter:blur(4px);
            display:flex; flex-direction:column; align-items:center; justify-content:center;
            font-family:"Trebuchet MS",system-ui,sans-serif; color:#ffe5e5;`;
        overlay.innerHTML = `
            <div style="font:800 44px/1 inherit;letter-spacing:3px;color:#ff5b5b;
                 text-shadow:0 0 22px rgba(255,60,60,0.6);margin-bottom:18px;">YOU DIED</div>
            <div style="font:700 20px/1.6 inherit;opacity:0.92;text-align:center;">
                Reached <b>Wave ${r.wave}</b> · Level <b>${r.level}</b><br>
                ${r.kills} kills · Best combo x${r._bestCombo || r.combo}
            </div>`;
        const btn = document.createElement('button');
        btn.textContent = 'RESTART RUN';
        btn.style.cssText = `
            margin-top:30px;padding:16px 38px;cursor:pointer;
            font:800 20px/1 inherit;letter-spacing:2px;color:#fff;
            background:linear-gradient(160deg,#b91c1c,#7f1d1d);
            border:2px solid rgba(255,120,120,0.6);border-radius:14px;
            box-shadow:0 8px 30px rgba(0,0,0,0.5);`;
        btn.onmouseenter = () => { btn.style.transform = 'translateY(-3px)'; };
        btn.onmouseleave = () => { btn.style.transform = 'none'; };
        btn.onclick = () => {
            closeRogueDeathScreen();
            restartRogueRun();
        };
        overlay.appendChild(btn);
        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        rogueDeathEl = overlay;
    }
    function closeRogueDeathScreen() {
        if (rogueDeathEl?.parentNode) rogueDeathEl.parentNode.removeChild(rogueDeathEl);
        rogueDeathEl = null;
    }
    function restartRogueRun() {
        const { renderer } = core;
        getResetDoomArenaLevelState()?.();
        respawnPlayer?.(true);
        if (renderer?.domElement && !mobileState.enabled) {
            const resume = () => {
                renderer.domElement.removeEventListener('click', resume);
                try { renderer.domElement.requestPointerLock?.(); } catch (e) {}
            };
            renderer.domElement.addEventListener('click', resume);
        } else {
            gameplay.roguePaused = false;
        }
    }

    function onRogueWaveCleared(wave = 0) {
        const r = ensureRogueState();
        const n = Math.max(0, wave | 0);
        if (!n || r._lastClearedWaveReward === n) return;
        r._lastClearedWaveReward = n;
        const buffs = window.rogueBuffs || {};
        const heal = 0.04 + (buffs.waveHeal || 0);
        if (heal > 0) setPlayerHealth((gameplay.health ?? 1) + heal);
        const bonusXp = Math.max(1, Math.floor(n / 2));
        grantRogueXp(bonusXp);
        rogueBanner(`WAVE ${n} CLEARED<br><span style="font-size:16px;color:#cdeaff">+${bonusXp} XP</span>`, '#7fe0ff');
        if (n % 3 === 0) spawnRogueHealthOrb(0, 1.0, 0);
    }

    // ---- game-mode API surface (used by ROGUE_GAMEMODE_SCRIPT) ----------
    const RogueAPI = {
        state: () => ensureRogueState(),
        spawnWave(wave, count, opts = {}) {
            const { currentMesh } = core;
            const layout = currentMesh?.userData?.doomArenaLevel || {};
            const radius = opts.radius ?? layout.spawnRingRadius ?? 18;
            const y = opts.y ?? layout.spawnY ?? 0;
            const actors = [];
            const jitter = Math.random() * Math.PI * 2;
            const eliteChance = rollEliteChance(wave);
            for (let i = 0; i < count; i++) {
                const ang = jitter + (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
                const r = radius * (0.82 + Math.random() * 0.18);
                const variant = RogueAPI.pickVariant(wave, i, count);
                // Don't roll elites onto bombers (an elite suicide bomber is a
                // free-XP feel-bad); keep elites on the bruiser archetypes.
                const elite = variant !== 'bomber' && Math.random() < eliteChance;
                const a = spawnRogueEnemy(
                    variant,
                    new THREE.Vector3(Math.cos(ang) * r, y, Math.sin(ang) * r),
                    wave,
                    { elite },
                );
                if (a) actors.push(a);
            }
            return actors;
        },
        spawnBoss(wave) {
            const { currentMesh } = core;
            const layout = currentMesh?.userData?.doomArenaLevel || {};
            const y = layout.spawnY ?? 0;
            const a = spawnRogueEnemy('boss', new THREE.Vector3(0, y, -(layout.spawnRingRadius ?? 18) * 0.6), wave);
            rogueBanner('⚠ BOSS WAVE ⚠', '#ff4d4d');
            addRogueShake(1.4);
            return a ? [a] : [];
        },
        pickVariant(wave) {
            const roll = Math.random();
            if (wave <= 2) return roll < 0.85 ? 'grunt' : 'rusher';
            if (wave <= 5) {
                if (roll < 0.50) return 'grunt';
                if (roll < 0.70) return 'rusher';
                if (roll < 0.82) return 'sniper';
                if (roll < 0.92) return 'bomber';
                return 'tank';
            }
            if (roll < 0.34) return 'grunt';
            if (roll < 0.56) return 'rusher';
            if (roll < 0.72) return 'sniper';
            if (roll < 0.86) return 'bomber';
            return 'tank';
        },
        waveCleared: (actors) => !Array.isArray(actors) || actors.length === 0
            || isDoomMiniWaveCleared(actors),
        onWaveCleared: onRogueWaveCleared,
        setHud: (text) => setRogueWaveHud(text),
        now: () => performance.now?.() || Date.now(),
        isDead: () => !!ensureRogueState().dead,
        triggerDeath: () => openRogueDeathScreen(),
        playerAlive: () => !gameplay.dead && (gameplay.health ?? 1) > 0,
    };

    // ---- wave HUD -------------------------------------------------------
    let rogueWaveHudEl = null;
    function setRogueWaveHud(text) {
        const { currentMesh } = core;
        const inArena = currentMesh?.userData?.sampleType === 'doomArena' && gameplay.active;
        if (!inArena || text == null || text === '') {
            if (rogueWaveHudEl) rogueWaveHudEl.style.display = 'none';
            return;
        }
        if (!rogueWaveHudEl?.parentNode) {
            const el = document.createElement('div');
            el.style.cssText = `
                position:absolute; left:50%; top:18px; transform:translateX(-50%);
                pointer-events:none; z-index:996; text-align:center;
                font:800 22px/1.25 "Trebuchet MS",system-ui,sans-serif; color:#ffd9d9;
                text-shadow:0 2px 8px rgba(0,0,0,0.85); letter-spacing:1px;`;
            (document.getElementById('canvas-container') || document.body)?.appendChild(el);
            rogueWaveHudEl = el;
        }
        rogueWaveHudEl.style.display = 'block';
        rogueWaveHudEl.innerHTML = String(text);
    }

    // ---- XP bar ---------------------------------------------------------
    let rogueXpBarEl = null;
    function ensureRogueXpBar() {
        if (rogueXpBarEl?.parentNode) return rogueXpBarEl;
        const wrap = document.createElement('div');
        wrap.style.cssText = `
            position:absolute; left:50%; bottom:18px; transform:translateX(-50%);
            width:min(620px,70vw); pointer-events:none; z-index:996;
            font:700 14px/1 "Trebuchet MS",system-ui,sans-serif; color:#cdeaff;
            text-shadow:0 2px 4px rgba(0,0,0,0.8);`;
        wrap.innerHTML = `
            <div style="display:flex;justify-content:space-between;margin:0 2px 4px;">
              <span id="rogue-lvl">LVL 1</span><span id="rogue-xp-txt">0 / 5 XP</span>
            </div>
            <div style="height:14px;border:2px solid rgba(120,210,255,0.55);
                 border-radius:8px;background:rgba(8,18,30,0.7);overflow:hidden;
                 box-shadow:0 0 14px rgba(40,170,255,0.4);">
              <div id="rogue-xp-fill" style="height:100%;width:0%;
                   background:linear-gradient(90deg,#1f8bff,#48e6ff);
                   transition:width 0.18s ease;"></div>
            </div>`;
        (document.getElementById('canvas-container') || document.body)?.appendChild(wrap);
        rogueXpBarEl = wrap;
        return wrap;
    }
    function updateRogueXpBar() {
        const { currentMesh } = core;
        const inArena = currentMesh?.userData?.sampleType === 'doomArena' && gameplay.active;
        if (!inArena) { if (rogueXpBarEl) rogueXpBarEl.style.display = 'none'; return; }
        const r = ensureRogueState();
        const el = ensureRogueXpBar();
        el.style.display = 'block';
        const pct = Math.max(0, Math.min(100, (r.xp / r.xpToNext) * 100));
        el.querySelector('#rogue-xp-fill').style.width = pct + '%';
        el.querySelector('#rogue-lvl').textContent = 'LVL ' + r.level;
        el.querySelector('#rogue-xp-txt').textContent =
            Math.floor(r.xp) + ' / ' + r.xpToNext + ' XP';
    }

    // ---- upgrade cards --------------------------------------------------
    function getRogueCardPool() {
        const w = window.rogue?.weapon;
        const weaponCards = ROGUE_CARDS_BY_WEAPON[w] || [];
        return weaponCards.concat(ROGUE_SHARED_CARDS);
    }

    const ROGUE_SHARED_CARDS = [
        { t: 'Adrenaline',    d: '+12% move speed',          a: (b) => b.moveSpeed *= 1.12 },
        { t: 'Plating',       d: '-18% damage taken',        a: (b) => b.damageTaken *= 0.82 },
        { t: 'Vampirism',     d: '+4% HP per kill',          a: (b) => b.lifesteal += 0.04 },
        { t: 'Battle Trance', d: '+25% XP gain',             a: (b) => b.xpGain *= 1.25 },
        { t: 'Magnet Core',   d: 'XP and health orbs pull harder from farther away', a: (b) => { b.orbRadius += 0.7; b.orbMagnet *= 1.35; } },
        { t: 'Scavenger',     d: '+12% health drop chance',  a: (b) => b.healthDrop += 0.12 },
        { t: 'Second Wind',   d: 'Heal after every cleared wave', a: (b) => b.waveHeal += 0.06 },
        { t: 'Momentum',      d: 'Combo timer lasts longer', a: (b) => b.comboWindow += 1000 },
        { t: 'Field Medic',   d: 'Heal to full now',         a: () => setPlayerHealth(1) },
        { t: 'Glass Cannon',  d: '+45% damage, +10% dmg taken', a: (b) => { b.damage *= 1.45; b.damageTaken *= 1.10; } },
        // Status-effect line. Stacks add up so investing in one element scales.
        { t: 'Incendiary',    d: 'Hits burn for 0.25 total damage', a: (b) => b.burn = Math.max(b.burn || 0, 0.25) },
        { t: 'Wildfire',      d: '+0.12 total burn damage, capped', a: (b) => b.burn = Math.min(BURN_MAX_DAMAGE, (b.burn || 0) + 0.12) },
        { t: 'Cryo Rounds',   d: 'Hits slow enemies by 35%', a: (b) => b.slow = Math.min(0.8, (b.slow || 0) + 0.35) },
        { t: 'Permafrost',    d: '+18% chance to freeze on hit', a: (b) => b.freezeChance = Math.min(0.6, (b.freezeChance || 0) + 0.18) },
    ];

    // Shared card styling. On mobile the cards stay in ONE horizontal row
    // (no wrap) sized to fit the viewport width, so 3 cards read as a clean
    // line instead of stacking. Desktop keeps the larger fixed-size cards.
    function makeCardRowCss() {
        if (mobileState.enabled) {
            return 'display:flex;flex-direction:row;flex-wrap:nowrap;'
                + 'gap:8px;justify-content:center;align-items:stretch;'
                + 'width:auto;max-width:96vw;margin:0 auto;'
                + 'padding:0 8px;box-sizing:border-box;';
        }
        return 'display:flex;gap:22px;flex-wrap:wrap;justify-content:center;';
    }
    function makeCardCss() {
        const base = 'cursor:pointer;color:#eaf6ff;text-align:center;'
            + 'background:linear-gradient(160deg,rgba(20,40,64,0.95),rgba(10,22,38,0.95));'
            + 'border:2px solid rgba(110,200,255,0.45);border-radius:14px;'
            + 'transition:transform .12s,border-color .12s,box-shadow .12s;'
            + 'box-shadow:0 8px 30px rgba(0,0,0,0.5);box-sizing:border-box;';
        if (mobileState.enabled) {
            // Smaller cards, centered as a tight 3-up row that fits any
            // viewport. Height bounded in vh so all 3 + title + hint stay
            // on screen in both portrait and landscape.
            return base + 'flex:1 1 0;min-width:0;width:30vw;max-width:150px;'
                + 'min-height:0;height:auto;max-height:62vh;overflow:auto;'
                + 'padding:8px 6px;display:flex;flex-direction:column;justify-content:center;';
        }
        return base + 'width:220px;height:280px;padding:26px 18px;';
    }

    let rogueCardEl = null;
    function openRogueCardPicker() {
        const r = ensureRogueState();
        if (r.picking) return;
        r.picking = true;
        const pool = getRogueCardPool();
        const picks = [];
        for (let i = 0; i < 3 && pool.length; i++) {
            picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
        }
        gameplay.roguePaused = true;
        try { document.exitPointerLock?.(); } catch (e) {}

        const overlay = document.createElement('div');
        overlay.className = 'rogue-overlay';
        overlay.style.cssText = `
            position:absolute; inset:0; z-index:1200; pointer-events:auto;
            background:rgba(4,10,18,0.78); backdrop-filter:blur(3px);
            display:flex; flex-direction:column; align-items:center; justify-content:center;
            padding:${mobileState.enabled ? '8px' : '0'}; box-sizing:border-box; overflow:auto;
            font-family:"Trebuchet MS",system-ui,sans-serif; color:#eaf6ff;`;
        const title = document.createElement('div');
        title.textContent = 'LEVEL ' + r.level + ' — CHOOSE AN UPGRADE';
        title.style.cssText = `font:800 ${mobileState.enabled ? 20 : 30}px/1.1 inherit;letter-spacing:2px;`
            + `margin-bottom:${mobileState.enabled ? 14 : 26}px;text-align:center;`
            + 'text-shadow:0 0 18px rgba(60,180,255,0.6);';
        overlay.appendChild(title);

        const row = document.createElement('div');
        row.style.cssText = makeCardRowCss();
        picks.forEach((card) => {
            const c = document.createElement('button');
            c.style.cssText = makeCardCss();
            c.innerHTML = `
                <div style="font:800 ${mobileState.enabled ? 16 : 22}px/1.2 inherit;margin-bottom:${mobileState.enabled ? 8 : 18}px;color:#7fe0ff;">${card.t}</div>
                <div style="font:600 ${mobileState.enabled ? 12 : 16}px/1.35 inherit;opacity:0.92;">${card.d}</div>`;
            c.onmouseenter = () => { c.style.transform = 'translateY(-8px)'; c.style.borderColor = '#48e6ff'; c.style.boxShadow = '0 0 26px rgba(60,200,255,0.6)'; };
            c.onmouseleave = () => { c.style.transform = 'none'; c.style.borderColor = 'rgba(110,200,255,0.45)'; c.style.boxShadow = '0 8px 30px rgba(0,0,0,0.5)'; };
            c.onclick = () => {
                try { card.a(window.rogueBuffs); } catch (e) { console.error('rogue card', e); }
                closeRogueCardPicker();
            };
            row.appendChild(c);
        });
        overlay.appendChild(row);
        const hint = document.createElement('div');
        hint.textContent = mobileState.enabled ? 'Tap a card to continue' : 'Click a card to continue';
        hint.style.cssText = `margin-top:${mobileState.enabled ? 10 : 24}px;font:600 ${mobileState.enabled ? 11 : 14}px/1 inherit;opacity:0.6;`;
        overlay.appendChild(hint);

        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        rogueCardEl = overlay;
    }

    function closeRogueCardPicker() {
        const { currentMesh, renderer } = core;
        const wasPicking = !!(window.rogue && window.rogue.picking);
        if (rogueCardEl?.parentNode) rogueCardEl.parentNode.removeChild(rogueCardEl);
        rogueCardEl = null;
        if (window.rogue) window.rogue.picking = false;
        updateRogueXpBar();

        if (!wasPicking || !gameplay.roguePaused) {
            gameplay.roguePaused = false;
            return;
        }
        if (currentMesh?.userData?.sampleType !== 'doomArena' || !renderer?.domElement) {
            gameplay.roguePaused = false;
            return;
        }
        if (mobileState.enabled) {
            gameplay.roguePaused = false;
            return;
        }
        const resumeEl = document.createElement('div');
        resumeEl.className = 'rogue-overlay';
        resumeEl.textContent = 'CLICK TO RESUME';
        resumeEl.style.cssText = `
            position:absolute; inset:0; z-index:1199; cursor:pointer;
            display:flex; align-items:center; justify-content:center;
            background:rgba(4,10,18,0.55);
            font:800 26px/1 "Trebuchet MS",system-ui,sans-serif; color:#7fe0ff;
            letter-spacing:3px; text-shadow:0 0 18px rgba(60,180,255,0.6);`;
        const doResume = () => {
            resumeEl.removeEventListener('click', doResume);
            if (resumeEl.parentNode) resumeEl.parentNode.removeChild(resumeEl);
            gameplay.roguePaused = false;
            try { core.renderer?.domElement?.requestPointerLock?.(); } catch (e) {}
        };
        resumeEl.addEventListener('click', doResume);
        (document.getElementById('canvas-container') || document.body)?.appendChild(resumeEl);
    }

    // ---- run-start weapon picker ---------------------------------------
    const ROGUE_WEAPON_CARDS = [
        { id: 'doomShotgun', t: 'Shotgun',
          d: '7-pellet close-range blast. High burst, slow cooldown.',
          equip: () => equipDoomShotgun() },
        { id: 'smg', t: 'SMG',
          d: 'Fast full-auto. Low per-hit, high rate of fire.',
          equip: () => equipStraightGun() },
        { id: 'throwingStar', t: 'Bouncing Star',
          d: 'Short-range lobbed blade. Ricochets off walls to hit around cover.',
          equip: () => equipThrowingStar() },
    ];

    function openRogueWeaponPicker() {
        const r = ensureRogueState();
        if (r.picking || r.weapon) return;
        r.picking = true;
        gameplay.roguePaused = true;
        try { document.exitPointerLock?.(); } catch (e) {}

        const overlay = document.createElement('div');
        overlay.className = 'rogue-overlay';
        overlay.style.cssText = `
            position:absolute; inset:0; z-index:1200; pointer-events:auto;
            background:rgba(4,10,18,0.82); backdrop-filter:blur(3px);
            display:flex; flex-direction:column; align-items:center; justify-content:center;
            padding:${mobileState.enabled ? '8px' : '0'}; box-sizing:border-box; overflow:auto;
            font-family:"Trebuchet MS",system-ui,sans-serif; color:#eaf6ff;`;
        const title = document.createElement('div');
        title.textContent = 'ROGUE WAVES — CHOOSE YOUR WEAPON';
        title.style.cssText = `font:800 ${mobileState.enabled ? 20 : 30}px/1.1 inherit;letter-spacing:2px;`
            + `margin-bottom:${mobileState.enabled ? 14 : 26}px;text-align:center;`
            + 'text-shadow:0 0 18px rgba(60,180,255,0.6);';
        overlay.appendChild(title);

        const row = document.createElement('div');
        row.style.cssText = makeCardRowCss();
        ROGUE_WEAPON_CARDS.forEach((w) => {
            const c = document.createElement('button');
            c.style.cssText = makeCardCss();
            c.innerHTML = `
                <div style="font:800 ${mobileState.enabled ? 16 : 24}px/1.2 inherit;margin-bottom:${mobileState.enabled ? 8 : 20}px;color:#7fe0ff;">${w.t}</div>
                <div style="font:600 ${mobileState.enabled ? 12 : 16}px/1.4 inherit;opacity:0.92;">${w.d}</div>`;
            c.onmouseenter = () => { c.style.transform = 'translateY(-8px)'; c.style.borderColor = '#48e6ff'; c.style.boxShadow = '0 0 26px rgba(60,200,255,0.6)'; };
            c.onmouseleave = () => { c.style.transform = 'none'; c.style.borderColor = 'rgba(110,200,255,0.45)'; c.style.boxShadow = '0 8px 30px rgba(0,0,0,0.5)'; };
            c.onclick = () => {
                window.rogue.weapon = w.id;
                try { w.equip(); } catch (e) { console.error('rogue weapon', e); }
                if (rogueCardEl?.parentNode) rogueCardEl.parentNode.removeChild(rogueCardEl);
                rogueCardEl = overlay;
                closeRogueCardPicker();
            };
            row.appendChild(c);
        });
        overlay.appendChild(row);
        const hint = document.createElement('div');
        hint.textContent = 'Pick a weapon to start the run';
        hint.style.cssText = `margin-top:${mobileState.enabled ? 10 : 24}px;font:600 ${mobileState.enabled ? 11 : 14}px/1 inherit;opacity:0.6;`;
        overlay.appendChild(hint);

        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        rogueCardEl = overlay;
    }

    // ---- per-frame engine driver ---------------------------------------
    function updateDoomArenaLevelState(subjectPosition = null) {
        const { currentMesh } = core;
        const state = currentMesh?.userData?.doomArenaState;
        if (!state || !subjectPosition) return;

        if (!state.started) {
            const dx = subjectPosition.x - 0;
            const dz = subjectPosition.z - 4.0;
            if (dx * dx + dz * dz > 3.2 * 3.2) {
                state.started = true;
            } else {
                return;
            }
        }

        const rogue = ensureRogueState();
        if (!rogue.weapon && !rogue.picking && !state.weaponPromptShown) {
            state.weaponPromptShown = true;
            openRogueWeaponPicker();
        }

        installRogueStatusHook();
        if (!gameplay.roguePaused) tickRogueStatuses();
        updateRogueGameMode();
    }

    function updateRogueGameMode() {
        if (!gameplay.active) return;
        const actors = getGameplayPrefabActors('rogueGameMode', scratchPrefab());
        if (!actors.length) return;
        const script = getRogueGameModeScript();
        for (let i = 0; i < actors.length; i++) {
            const gm = actors[i];
            ensureGameplayPrefabScript(gm, script);
            runObjectEventScript(gm, 'tick', { deltaTime: 0 });
        }
    }

    function getHowToPlay() {
        return { title: ROGUE_HELP_TITLE, lines: ROGUE_HELP_LINES.slice() };
    }

    // expose the window.* surface the game-mode script + legacy callers use
    if (typeof window !== 'undefined') {
        window.rogueWaves = {
            ensureRogueState, resetRogueState,
            spawnRogueXpOrb, updateRogueXpOrbs, grantRogueXp,
            onRogueEnemyKilled, spawnRogueHealthOrb, spawnRogueEnemy,
            onRogueWaveCleared,
            openRogueCardPicker, closeRogueCardPicker, openRogueWeaponPicker,
            openRogueDeathScreen, closeRogueDeathScreen,
            updateRogueXpBar, setRogueWaveHud,
            updateDoomArenaLevelState, updateRogueGameMode,
            RogueAPI, getHowToPlay,
        };
        window.resetRogueState = resetRogueState;
        window.spawnRogueXpOrb = spawnRogueXpOrb;
        window.onRogueEnemyKilled = onRogueEnemyKilled;
        window.onRogueWaveCleared = onRogueWaveCleared;
        window.spawnRogueEnemy = spawnRogueEnemy;
        window.updateRogueXpBar = updateRogueXpBar;
        window.openRogueCardPicker = openRogueCardPicker;
        window.closeRogueCardPicker = closeRogueCardPicker;
        window.openRogueWeaponPicker = openRogueWeaponPicker;
        window.openRogueDeathScreen = openRogueDeathScreen;
        window.closeRogueDeathScreen = closeRogueDeathScreen;
        window.RogueAPI = RogueAPI;
    }

    return {
        ensureRogueState, resetRogueState,
        spawnRogueXpOrb, updateRogueXpOrbs, grantRogueXp,
        onRogueEnemyKilled, spawnRogueHealthOrb, spawnRogueEnemy,
        onRogueWaveCleared,
        openRogueCardPicker, closeRogueCardPicker, openRogueWeaponPicker,
        openRogueDeathScreen, closeRogueDeathScreen,
        updateRogueXpBar, setRogueWaveHud,
        updateDoomArenaLevelState, updateRogueGameMode,
        RogueAPI, getHowToPlay,
    };
}
