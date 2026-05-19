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
    boss:   { hpMul: 22,  speedMul: 0.8,  cooldownMul: 0.7, scale: 2.6, tint: '#ef4444', xp: 12, score: 250 },
};

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
    ],
    throwingStar: [
        { t: 'Honed Edge',    d: '+25% star damage',       a: (b) => b.damage *= 1.25 },
        { t: 'Quick Draw',    d: '+25% throw rate',        a: (b) => b.fireRate *= 1.25 },
        { t: 'Ricochet+',     d: 'Star lasts longer',      a: (b) => b.pellets += 1 },
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
        ensureGameplayPrefabScript, runObjectEventScript, scratchPrefab,
        getRogueGameModeScript, getResetDoomArenaLevelState, respawnPlayer,
        equipDoomShotgun, equipStraightGun, equipThrowingStar,
    } = deps;

    // ---- enemy variants -------------------------------------------------
    function spawnRogueEnemy(variant, position, wave = 1) {
        const v = ROGUE_ENEMY_VARIANTS[variant] || ROGUE_ENEMY_VARIANTS.grunt;
        // Global HP scale for Rogue Waves enemies (2/3 = die a bit faster).
        const base = SHOOTER_AI_PREFAB.health * (2 / 3);
        const waveScale = 1 + Math.max(0, wave - 1) * 0.06;
        const hp = base * v.hpMul * waveScale;
        const actor = spawnDoomEnemyAt(position, {
            label: `Arena ${variant} W${wave}`,
            groundY: position.y,
            health: hp,
            maxHealth: hp,
            speedMul: v.speedMul,
            cooldownMs: SHOOTER_AI_PREFAB.cooldownMs * v.cooldownMul,
            range: v.range,
            rogueVariant: variant,
            scoreValue: SHOOTER_AI_PREFAB.scoreValue + v.score + wave * 4,
        });
        if (!actor) return null;
        actor.userData.rogueXp = v.xp;
        const mesh = getActorRenderObject(actor);
        if (mesh && v.scale !== 1) {
            mesh.scale.multiplyScalar(v.scale);
            mesh.updateMatrixWorld(true);
        }
        try { tintGameplayPrefabActor(actor, v.tint, v.tint, variant === 'boss' ? 1.8 : 1.0); } catch (e) {}
        return actor;
    }

    // ---- run state ------------------------------------------------------
    function defaultRogueBuffs() {
        return {
            damage: 1, fireRate: 1, pellets: 0, magSize: 0, reloadSpeed: 1,
            moveSpeed: 1, maxHealth: 1, damageTaken: 1, lifesteal: 0, xpGain: 1,
        };
    }

    function ensureRogueState() {
        if (!window.rogueBuffs) window.rogueBuffs = defaultRogueBuffs();
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
        updateRogueXpBar();
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
        for (let i = r.orbs.length - 1; i >= 0; i--) {
            const o = r.orbs[i];
            const m = o.mesh;
            const age = (now - o.born) / 1000;
            const dx = playerPos.x - m.position.x;
            const dy = (playerPos.y + 1.0) - m.position.y;
            const dz = playerPos.z - m.position.z;
            const dist = Math.hypot(dx, dy, dz);
            if (dist < 1.0 || age > 12) {
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
                const pull = 6 + age * 4;
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
            r.xpToNext = Math.round(r.xpToNext * 1.35 + 2);
            leveled = true;
        }
        updateRogueXpBar();
        if (leveled) openRogueCardPicker();
    }

    // ---- kill combo + drops --------------------------------------------
    const COMBO_WINDOW_MS = 3500;
    function onRogueEnemyKilled(x, y, z, actor) {
        const r = ensureRogueState();
        const now = performance.now?.() || Date.now();
        if (now > (r.comboUntil || 0)) r.combo = 0;
        r.combo += 1;
        r.kills += 1;
        r.comboUntil = now + COMBO_WINDOW_MS;
        if (r.combo > (r._bestCombo || 0)) r._bestCombo = r.combo;
        if (r.combo > 0 && r.combo % 5 === 0) grantRogueXp(2);
        const dropChance = 0.12 + Math.min(0.18, r.combo * 0.01);
        if (Math.random() < dropChance) spawnRogueHealthOrb(x, y + 0.9, z);
        updateRogueXpBar();
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
            for (let i = 0; i < count; i++) {
                const ang = jitter + (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
                const r = radius * (0.82 + Math.random() * 0.18);
                const variant = RogueAPI.pickVariant(wave, i, count);
                const a = spawnRogueEnemy(
                    variant,
                    new THREE.Vector3(Math.cos(ang) * r, y, Math.sin(ang) * r),
                    wave,
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
            return a ? [a] : [];
        },
        pickVariant(wave) {
            const roll = Math.random();
            if (wave <= 2) return roll < 0.85 ? 'grunt' : 'rusher';
            if (wave <= 5) {
                if (roll < 0.55) return 'grunt';
                if (roll < 0.78) return 'rusher';
                if (roll < 0.92) return 'sniper';
                return 'tank';
            }
            if (roll < 0.4) return 'grunt';
            if (roll < 0.65) return 'rusher';
            if (roll < 0.82) return 'sniper';
            return 'tank';
        },
        waveCleared: (actors) => !Array.isArray(actors) || actors.length === 0
            || isDoomMiniWaveCleared(actors),
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
        { t: 'Field Medic',   d: 'Heal to full now',         a: () => setPlayerHealth(1) },
        { t: 'Glass Cannon',  d: '+45% damage, +10% dmg taken', a: (b) => { b.damage *= 1.45; b.damageTaken *= 1.10; } },
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
            // Smaller cards, centered as a tight 3-up row.
            return base + 'flex:1 1 0;min-width:0;width:26vw;max-width:150px;'
                + 'min-height:120px;padding:10px 8px;';
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
        hint.textContent = 'Click a card to continue';
        hint.style.cssText = 'margin-top:24px;font:600 14px/1 inherit;opacity:0.6;';
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
        hint.style.cssText = 'margin-top:24px;font:600 14px/1 inherit;opacity:0.6;';
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

    // expose the window.* surface the game-mode script + legacy callers use
    if (typeof window !== 'undefined') {
        window.rogueWaves = {
            ensureRogueState, resetRogueState,
            spawnRogueXpOrb, updateRogueXpOrbs, grantRogueXp,
            onRogueEnemyKilled, spawnRogueHealthOrb, spawnRogueEnemy,
            openRogueCardPicker, closeRogueCardPicker, openRogueWeaponPicker,
            openRogueDeathScreen, closeRogueDeathScreen,
            updateRogueXpBar, setRogueWaveHud,
            updateDoomArenaLevelState, updateRogueGameMode,
            RogueAPI,
        };
        window.resetRogueState = resetRogueState;
        window.spawnRogueXpOrb = spawnRogueXpOrb;
        window.onRogueEnemyKilled = onRogueEnemyKilled;
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
        openRogueCardPicker, closeRogueCardPicker, openRogueWeaponPicker,
        openRogueDeathScreen, closeRogueDeathScreen,
        updateRogueXpBar, setRogueWaveHud,
        updateDoomArenaLevelState, updateRogueGameMode,
        RogueAPI,
    };
}
