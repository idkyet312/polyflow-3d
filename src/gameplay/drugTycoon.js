// Drug Tycoon game mode — a self-contained "Schedule I"-style loop bolted onto
// its own level (sampleType 'drugTycoon'). Fully isolated like rogueWaves:
// runtime.js calls createDrugTycoon({...deps}) once and the frame loop calls
// the returned updateDrugTycoonState(playerPos, delta) every frame.
//
// Core loop (full tycoon vertical slice):
//   1. COOK   — stand on the cook station, hold E to brew a batch of product
//               (takes time; yield + speed scale with upgrades).
//   2. SELL   — carry product, walk up to a wandering NPC buyer, press E to
//               sell. Cash in, but each sale adds HEAT.
//   3. HEAT   — rises with sales, decays slowly. Over a threshold the police
//               start hunting; getting caught fines you and dumps your stash.
//   4. UPGRADE— stand on the upgrade pad, press E to open the shop and spend
//               cash on bigger batches, faster cooks, more buyers, less heat.
//
// All UI is plain DOM overlays (.tycoon-overlay) layered over the canvas, same
// approach as the rogue HUD. State lives on window.drugTycoon so it survives
// hot edits and can be inspected from the console.
import * as THREE from 'three';
import { core } from '../runtime/appCore.js';
import * as ragdoll from './ragdoll.js';

const SELL_RADIUS = 2.6;
const STATION_RADIUS = 2.4;
const COOK_TIME_MS = 4000;        // base brew time per batch
const COOK_YIELD = 5;             // base units per batch
const STASH_CAP = 40;             // base carry capacity
const SELL_PRICE = 35;            // base cash per unit
const SELL_HEAT = 6;              // heat added per sale
const HEAT_DECAY_PER_SEC = 1.2;   // passive heat cooldown
const HEAT_BUST_THRESHOLD = 100;  // police actively hunt at/above this
const BUST_RADIUS = 2.2;          // police catch distance
const BUST_FINE = 250;            // cash lost when busted
const NPC_WANDER_SPEED = 1.6;
const POLICE_SPEED = 3.2;
const PATROL_SPEED = 2.0;          // night cops on patrol (slower than a chase)
// Day/night cycle. timeOfDay runs 0..1 over DAY_LENGTH_SEC. Night is the
// window [NIGHT_START, NIGHT_END) (wrapping past 1.0 back to 0).
const DAY_LENGTH_SEC = 180;        // one full day-night cycle
const NIGHT_START = 0.625;         // 21:00 — patrols out + darkness
const NIGHT_END = 0.04;            // dawn (wraps: 0.625..1.0 and 0.0..0.04)
const PATROL_COP_COUNT = 3;        // night patrol size
const PATROL_SPOT_RADIUS = 7;      // a patrol cop spots the player within this
const SIREN_RANGE = 26;            // cops audible within this distance
const SIREN_MAX_GAIN = 0.07;       // loudest siren volume (point-blank)
// Buyer one-liners on a sale.
const SELL_THANKS = [
    'Thanks!', 'Pleasure doin\' business', 'Good lookin\' out', 'Right on',
    'You\'re a lifesaver', 'See you next time', 'Appreciate it', 'Solid',
];
const GUN_FIRE_COOLDOWN_MS = 280;  // pistol cadence
const GUN_RANGE = 60;              // max shoot distance
const GUN_AIM_DOT = 0.985;        // aim cone tightness (cos angle)
const GUN_IMPULSE = 9;            // ragdoll shove strength
const BAT_RANGE = 3.0;            // melee reach
const BAT_COOLDOWN_MS = 480;      // swing cadence
const BAT_IMPULSE = 11;           // bat knockback (heftier than a bullet)
// Weapon shop prices.
const GUN_PRICE = 400;
const AMMO_PRICE = 60;            // per pack
const AMMO_PER_PACK = 12;
const BAT_PRICE = 180;
const DOOR_RADIUS = 2.6;          // enter/exit door interaction distance
const PLANT_GROW_MS = 22000;      // time per growth stage (seed→veg→flower)
const PLANT_STAGES = 3;           // stages until harvestable
const BUDS_PER_PLANT = 4;         // loose buds yielded per ripe plant
const FLOOR_OFFSET = 0.1;         // matches PLAYER_SETTINGS.floorOffset-ish
const BUD_SIZE = 0.16;            // physics bud half-extent-ish
const BUD_GRAB_RANGE = 3.2;       // how far the cursor can grab a bud
const BUD_HOLD_DIST = 1.6;        // distance in front of camera while held
const BAG_HALF = [0.55, 0.5, 0.55]; // bag trigger zone half-extents

export function createDrugTycoon(deps) {
    const {
        gameplay,
        physics,
        setPlayerHealth,
    } = deps;

    // The Jolt physics handle isn't on appCore — hand it to the ragdoll module.
    if (physics) ragdoll.setPhysics(physics);

    // ---- run state ------------------------------------------------------
    function defaultState() {
        return {
            cash: 0,
            stash: 0,             // unsold product on hand
            stashQ: 1,            // running quality of product on hand (0..1)
            lastQ: 0,             // quality of the most recent batch (HUD)
            heat: 0,
            cooking: false,       // recipe panel open
            recipe: [],           // reagent keys added so far this cook
            busted: 0,            // times caught
            sales: 0,
            // upgrade levels
            up: { batch: 0, speed: 0, buyers: 0, stealth: 0, cap: 0 },
            // world refs (positions cached from the level layout)
            cookPos: new THREE.Vector3(),
            upgradePos: new THREE.Vector3(),
            gunPos: new THREE.Vector3(),
            npcs: [],             // { actor, mesh, target, wantsBuy }
            police: [],           // { actor, mesh }
            started: false,
            shopOpen: false,
            // ---- day/night cycle ------------------------------------------
            timeOfDay: 0.25,      // start mid-morning
            patrol: [],           // night patrol cops { mesh, target, alerted }
            // ---- phone order: the one buyer (by shirt colour) you must sell to
            phoneOpen: false,     // phone HUD popped out
            helpOpen: false,      // how-to-play panel open
            orderColor: '',       // shirt colour of the current valid customer
            ordersFilled: 0,      // delivered orders
            hasGun: false,        // player owns the pistol
            gunPickupMesh: null,  // floating pickup on the pedestal
            nextShotAt: 0,        // shoot cooldown
            ammo: 0,              // pistol rounds
            hasBat: false,        // owns the baseball bat (melee, no ammo)
            nextSwingAt: 0,       // bat swing cooldown
            // ---- grow room -------------------------------------------------
            inRoom: false,        // player currently inside the grow room
            buds: 0,              // harvested loose buds (pre-bagging)
            plants: [],           // { mesh, stage, grownAt, pos } per pot
            plantsBuilt: false,   // pots populated once
            baggingOpen: false,   // (legacy) drag-and-drop panel up
            // ---- physics bagging ------------------------------------------
            physBuds: [],         // { mesh, body } loose physics buds on the bench
            bagMesh: null,        // visual bag at the bench
            bagPos: null,         // [x,y,z] centre of the bag trigger zone
            grabbed: null,        // the physBud currently held by the cursor
        };
    }

    function ensureState() {
        if (!window.drugTycoon) window.drugTycoon = defaultState();
        return window.drugTycoon;
    }

    function resetState() {
        const { scene } = core;
        const s = window.drugTycoon;
        if (s) {
            for (const n of s.npcs) { try { scene?.remove(n.mesh); } catch (e) {} }
            for (const p of s.police) { try { scene?.remove(p.mesh); } catch (e) {} }
            for (const c of s.patrol || []) { try { scene?.remove(c.mesh); } catch (e) {} }
        }
        if (s?.gunPickupMesh) { try { scene?.remove(s.gunPickupMesh); } catch (e) {} }
        if (s?.plants) { for (const p of s.plants) { try { scene?.remove(p.mesh); } catch (e) {} } }
        if (s) { try { clearPhysBuds(s); } catch (e) {} }
        try { destroyAudio(); } catch (e) {}
        detachHeldGun();
        for (const t of _tracers) { try { scene?.remove(t.line); } catch (e) {} }
        _tracers.length = 0;
        window.drugTycoon = defaultState();
        try { ragdoll.removeAll(); } catch (e) {}
        closeCook();
        closeShop();
        closeBagging();
        document.querySelectorAll('.tycoon-overlay').forEach((n) => n.remove());
        _hudEl = null;
        _shopEl = null;
        _cookEl = null;
        _bagEl = null;
        _phoneEl = null;
        _helpBtnEl = null;
        _helpPanelEl = null;
        _promptEl = null;
        _floatLayer = null;
        _sunLight = null;   // re-resolve the sun on the next (rebuilt) level
        _roomNightState = null;  // re-apply room lighting on the next level
        installInteractKey();
    }

    // ---- upgrade economics ---------------------------------------------
    function batchYield(s) { return COOK_YIELD + s.up.batch * 4; }
    // Each 'speed' (Clean Lab) level raises the minimum purity floor by 15%,
    // so a botched recipe still yields decent product once you've invested.
    function purityFloor(s) { return Math.min(0.6, s.up.speed * 0.15); }
    function stashCap(s) { return STASH_CAP + s.up.cap * 25; }
    // Price scales with the quality of the product being sold (0..1 → 0.5x..2x).
    function unitPrice(s, q = s.stashQ) { return Math.round(SELL_PRICE * (0.5 + 1.5 * clamp01(q))); }
    function heatPerSale(s) { return Math.max(1, SELL_HEAT * Math.pow(0.8, s.up.stealth)); }
    function maxBuyers(s) { return 3 + s.up.buyers * 2; }

    // ---- wanted level (GTA-style stars from heat) ----------------------
    // Heat (0..160) maps to 0–5 stars. Cops only hunt at >= 1 star, and the
    // count + chase speed scale up with stars.
    const STAR_HEAT = [25, 55, 90, 125, 150];   // heat needed for 1..5 stars
    function wantedStars(s) {
        let stars = 0;
        for (const th of STAR_HEAT) { if (s.heat >= th) stars++; else break; }
        return stars;
    }
    function copsForStars(stars) { return stars <= 0 ? 0 : Math.min(6, stars + 1); }   // 2..6
    function chaseSpeedForStars(stars) { return POLICE_SPEED + (stars - 1) * 0.35; }   // faster at higher stars
    function starString(stars) { return '★★★★★'.slice(0, stars) + '☆☆☆☆☆'.slice(0, 5 - stars); }

    // ---- cook recipe (tactile multi-step mixing) -----------------------
    // The ideal batch is BASE then the three ADDITIVES in order. Adding the
    // right reagent at the right step builds quality; wrong/duplicate reagents
    // dock it. Quality (0..1) then scales both batch yield and sell price.
    const COOK_STEPS = [
        { key: 'base',    t: 'Pseudo (base)',  color: '#7fd0ff' },
        { key: 'acetone', t: 'Acetone',        color: '#ffe066' },
        { key: 'lithium', t: 'Lithium',        color: '#c0c4cc' },
        { key: 'ammonia', t: 'Ammonia',        color: '#9dff8a' },
    ];
    const RECIPE_LEN = COOK_STEPS.length;

    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

    // Score a finished recipe: each reagent placed in its correct slot is worth
    // 1/N quality; a wrong reagent in a slot contributes nothing and the final
    // quality is the fraction of correct placements.
    function scoreRecipe(recipe) {
        let correct = 0;
        for (let i = 0; i < RECIPE_LEN; i++) {
            if (recipe[i] === COOK_STEPS[i].key) correct++;
        }
        return correct / RECIPE_LEN;
    }

    // Quality blends into the on-hand stash weighted by quantities, so a great
    // batch on top of mediocre product averages out (like Schedule I purity).
    function blendStashQuality(s, addQty, addQ) {
        const total = s.stash + addQty;
        if (total <= 0) { s.stashQ = addQ; return; }
        s.stashQ = (s.stash * s.stashQ + addQty * addQ) / total;
    }

    const UPGRADES = [
        { key: 'batch',   t: 'Bigger Batch',   d: '+4 product per cook',      cost: (l) => 150 + l * 200 },
        { key: 'speed',   t: 'Clean Lab',      d: '+15% min purity',          cost: (l) => 200 + l * 250 },
        { key: 'buyers',  t: 'More Customers',  d: '+2 buyers on the street',  cost: (l) => 250 + l * 300 },
        { key: 'stealth', t: 'Low Profile',    d: '-20% heat per sale',       cost: (l) => 300 + l * 350 },
        { key: 'cap',     t: 'Bigger Stash',   d: '+25 carry capacity',       cost: (l) => 120 + l * 160 },
    ];

    // ---- phone order: the buyer (by shirt colour) you must deliver to ----
    // Human-readable names for the shirt palette, shown on the phone.
    const COLOR_NAMES = {
        '#3da6ff': 'Blue', '#2dd4bf': 'Teal', '#f97316': 'Orange',
        '#a855f7': 'Purple', '#eab308': 'Yellow', '#ef4444': 'Red',
    };
    function colorName(hex) { return COLOR_NAMES[hex] || hex; }

    // Pick a fresh order from a currently-living buyer's shirt colour. Falls
    // back to a random palette colour if no buyers exist yet.
    function pickOrder(s) {
        const live = s.npcs.filter((n) => n.mesh && n.wantsBuy);
        if (live.length) {
            s.orderColor = live[(Math.random() * live.length) | 0].shirtColor;
        } else {
            s.orderColor = SHIRT_TONES[(Math.random() * SHIRT_TONES.length) | 0];
        }
        return s.orderColor;
    }
    // Ensure there's always a valid order pointing at a living buyer.
    function ensureOrder(s) {
        const stillHere = s.orderColor && s.npcs.some((n) => n.mesh && n.wantsBuy && n.shirtColor === s.orderColor);
        if (!stillHere) pickOrder(s);
    }

    let _phoneEl = null;
    function setPhone(open) {
        const s = ensureState();
        s.phoneOpen = !!open;
        if (s.phoneOpen) renderPhone(); else hidePhone();
    }
    function togglePhone() {
        const s = window.drugTycoon;
        if (!s) return;
        // Only usable on the street (not in menus / grow room).
        if (s.shopOpen || s.cooking || s.inRoom) return;
        setPhone(!s.phoneOpen);
    }
    function ensurePhoneEl() {
        if (_phoneEl?.parentNode) return _phoneEl;
        const el = document.createElement('div');
        el.className = 'tycoon-overlay';
        el.style.cssText = 'position:absolute;right:22px;bottom:90px;z-index:1100;'
            + 'width:190px;pointer-events:none;font-family:"Trebuchet MS",system-ui,sans-serif;'
            + 'border-radius:22px;padding:14px 14px 18px;'
            + 'background:linear-gradient(170deg,#0d0f14,#171b22);'
            + 'box-shadow:0 12px 40px rgba(0,0,0,0.6);border:2px solid #2b313c;';
        (document.getElementById('canvas-container') || document.body)?.appendChild(el);
        _phoneEl = el;
        return el;
    }
    function renderPhone() {
        const s = ensureState();
        ensureOrder(s);
        const el = ensurePhoneEl();
        el.style.display = 'block';
        const c = s.orderColor || '#888';
        const night = isNight(s);
        el.innerHTML =
            // Status bar: live clock + day/night.
            `<div style="display:flex;justify-content:space-between;align-items:center;font:700 12px/1 inherit;color:#cdd6e3;margin-bottom:8px;">`
            + `<span>${dayClock(s)}</span><span>${night ? '🌙 Night' : '☀️ Day'}</span></div>`
            + '<div style="height:5px;width:46px;background:#2b313c;border-radius:3px;margin:0 auto 12px;"></div>'
            + '<div style="font:800 13px/1.2 inherit;color:#7fd0ff;letter-spacing:.5px;margin-bottom:4px;">📱 DEAL APP</div>'
            + '<div style="font:600 12px/1.3 inherit;color:#9aa3b2;margin-bottom:12px;">Deliver to the customer wearing:</div>'
            + `<div style="width:100%;height:84px;border-radius:14px;background:${c};box-shadow:inset 0 0 0 3px rgba(255,255,255,0.15);"></div>`
            + `<div style="text-align:center;font:900 20px/1.2 inherit;color:#eef3ff;margin-top:10px;">${colorName(c)}</div>`
            + `<div style="text-align:center;font:600 11px/1.3 inherit;color:#7c8696;margin-top:6px;">Orders filled: ${s.ordersFilled}</div>`
            + '<div style="text-align:center;font:600 11px/1.3 inherit;color:#566;margin-top:8px;">[P] to close</div>';
    }
    function hidePhone() { if (_phoneEl) _phoneEl.style.display = 'none'; }

    // ---- how-to-play help ("?" button + panel) -------------------------
    // A small "?" FAB (works on PC click + mobile tap) that pops a panel
    // explaining how to play this game mode. Lives entirely in this module.
    const HELP_TITLE = 'DRUG TYCOON — HOW TO PLAY';
    const HELP_LINES = [
        '🌿 GROW: Start at home. Harvest ripe plants [E], then drag buds into the bag at the bench (hold Fire) to package product.',
        '🍳 COOK: Outside at the green bench [E] — add reagents in the right order, then MIX. Higher purity = more cash.',
        '📱 ORDERS: Press [P] for your phone. Sell only to the customer whose shirt matches the order colour [E].',
        '💰 SELL: Each deal pays out but raises your Wanted level (stars). Heat cools over time.',
        '⭐ HEAT: More stars = more cops. Busted = lose all product + a fine, wake up home next morning.',
        '🌙 NIGHT: After 21:00 patrols roam the streets. Sleep in bed [E] to skip to morning.',
        '🔫 WEAPONS: Buy a pistol, ammo, or a bat at the upgrade desk in the room. Fire to shoot/swing.',
        '🏠 UPGRADES: Use the desk in your room to spend cash on bigger batches, more buyers, stealth, etc.',
    ];

    let _helpBtnEl = null;
    let _helpPanelEl = null;
    function ensureHelpButton() {
        if (_helpBtnEl?.parentNode) return _helpBtnEl;
        const b = document.createElement('button');
        b.className = 'tycoon-overlay';
        b.type = 'button';
        b.textContent = '?';
        b.style.cssText = 'position:absolute;right:18px;top:16px;z-index:1101;pointer-events:auto;'
            + 'width:42px;height:42px;border-radius:50%;cursor:pointer;'
            + 'font:900 22px/1 "Trebuchet MS",system-ui,sans-serif;color:#0a140e;'
            + 'background:linear-gradient(160deg,#9dffa0,#3fbf5f);border:2px solid rgba(0,0,0,0.25);'
            + 'box-shadow:0 4px 14px rgba(0,0,0,0.5);';
        b.addEventListener('click', (e) => { e.preventDefault(); toggleHelp(); });
        (document.getElementById('canvas-container') || document.body)?.appendChild(b);
        _helpBtnEl = b;
        return b;
    }
    function toggleHelp() {
        const s = ensureState();
        s.helpOpen = !s.helpOpen;
        if (s.helpOpen) renderHelp(); else hideHelp();
    }
    function renderHelp() {
        if (_helpPanelEl?.parentNode) _helpPanelEl.remove();
        const overlay = document.createElement('div');
        overlay.className = 'tycoon-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:1300;pointer-events:auto;'
            + 'background:rgba(4,10,8,0.86);backdrop-filter:blur(3px);display:flex;'
            + 'flex-direction:column;align-items:center;justify-content:center;'
            + 'font-family:"Trebuchet MS",system-ui,sans-serif;color:#eaffea;padding:20px;box-sizing:border-box;';
        const card = document.createElement('div');
        card.style.cssText = 'max-width:560px;width:100%;background:linear-gradient(160deg,rgba(18,40,26,0.96),rgba(8,20,12,0.96));'
            + 'border:2px solid rgba(120,255,160,0.5);border-radius:16px;padding:24px 26px;'
            + 'box-shadow:0 12px 40px rgba(0,0,0,0.6);';
        card.innerHTML = `<div style="font:900 24px/1.1 inherit;color:#9dffa0;margin-bottom:16px;text-align:center;">${HELP_TITLE}</div>`
            + HELP_LINES.map((l) => `<div style="font:600 15px/1.5 inherit;margin-bottom:10px;opacity:.95;">${l}</div>`).join('');
        overlay.appendChild(card);
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'GOT IT';
        close.style.cssText = 'margin-top:18px;padding:12px 34px;cursor:pointer;font:800 18px/1 inherit;color:#0a140e;'
            + 'border-radius:12px;background:linear-gradient(160deg,#9dffa0,#3fbf5f);border:2px solid rgba(0,0,0,0.25);';
        close.addEventListener('click', (e) => { e.preventDefault(); toggleHelp(); });
        overlay.appendChild(close);
        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        _helpPanelEl = overlay;
        // Pause the sim + free the cursor while reading, like the other menus.
        gameplay.roguePaused = true;
        try { document.exitPointerLock?.(); } catch (e) {}
    }
    function hideHelp() {
        if (_helpPanelEl?.parentNode) _helpPanelEl.remove();
        _helpPanelEl = null;
        const s = window.drugTycoon;
        if (s) s.helpOpen = false;
        gameplay.roguePaused = false;
    }

    // ---- interact key (on-foot E edge) ----------------------------------
    let _interactQueued = false;
    let _keyHandler = null;
    function installInteractKey() {
        if (_keyHandler || typeof window === 'undefined') return;
        _keyHandler = (e) => {
            if (e.repeat) return;
            if (e.code === 'KeyE') _interactQueued = true;
            if (e.code === 'KeyP') togglePhone();
            if (e.code === 'KeyH') toggleHelp();
            if (e.code === 'Escape' && window.drugTycoon?.helpOpen) hideHelp();
            if (e.code === 'Escape' && window.drugTycoon?.phoneOpen) setPhone(false);
            if (e.code === 'Escape' && window.drugTycoon?.shopOpen) closeShop();
            if (e.code === 'Escape' && window.drugTycoon?.cooking) closeCook();
            if (e.code === 'Escape' && window.drugTycoon?.baggingOpen) closeBagging();
        };
        window.addEventListener('keydown', _keyHandler);
    }
    function consumeInteract() {
        const v = _interactQueued;
        _interactQueued = false;
        return v;
    }
    // Mobile (no keyboard): the Action 2 button calls this to fire one interact.
    function queueInteract() {
        const s = window.drugTycoon;
        if (s?.shopOpen) { closeShop(); return; }
        if (s?.cooking) { closeCook(); return; }
        if (s?.baggingOpen) { closeBagging(); return; }
        _interactQueued = true;
    }

    // ---- HUD ------------------------------------------------------------
    let _hudEl = null;
    function ensureHud() {
        if (_hudEl?.parentNode) return _hudEl;
        const el = document.createElement('div');
        el.className = 'tycoon-overlay';
        el.style.cssText = 'position:absolute;left:18px;top:16px;pointer-events:none;'
            + 'z-index:996;font:700 16px/1.5 "Trebuchet MS",system-ui,sans-serif;'
            + 'color:#e8ffe8;text-shadow:0 2px 6px rgba(0,0,0,0.85);';
        (document.getElementById('canvas-container') || document.body)?.appendChild(el);
        _hudEl = el;
        return el;
    }
    function updateHud() {
        const { currentMesh } = core;
        const inLevel = currentMesh?.userData?.sampleType === 'drugTycoon' && gameplay.active;
        if (!inLevel) {
            if (_hudEl) _hudEl.style.display = 'none';
            if (_helpBtnEl) _helpBtnEl.style.display = 'none';
            return;
        }
        const s = ensureState();
        const el = ensureHud();
        el.style.display = 'block';
        ensureHelpButton().style.display = 'block';   // "?" help FAB (PC + mobile)
        const stars = wantedStars(s);
        const starColor = stars >= 4 ? '#ff4d4d' : stars >= 2 ? '#ffae00' : '#ffd24a';
        el.innerHTML =
            `<div style="font-size:22px;color:#9dffa0;">$${Math.floor(s.cash).toLocaleString()}</div>`
            + `<div>Product: ${s.stash} / ${stashCap(s)}${s.stash > 0 ? ` · ${Math.round(s.stashQ * 100)}% pure` : ''}</div>`
            + (s.buds > 0 ? `<div style="color:#b6ff6a;">Buds: ${s.buds}</div>` : '')
            + `<div style="color:${starColor};letter-spacing:1px;">Wanted: ${starString(stars)}${stars >= 1 ? '  ⚠ POLICE' : ''}</div>`
            + `<div style="opacity:.9;">${isNight(s) ? '🌙' : '☀️'} ${dayClock(s)}${isNight(s) ? ' <span style="color:#ff9a9a;font-size:12px;">· patrols out</span>' : ''}</div>`
            + (s.orderColor && !s.inRoom ? `<div style="opacity:.85;">Order: <span style="display:inline-block;width:11px;height:11px;border-radius:2px;background:${s.orderColor};vertical-align:middle;"></span> ${colorName(s.orderColor)} <span style="opacity:.6;font-size:12px;">[P] phone</span></div>` : '')
            + ((s.hasGun || s.hasBat) ? `<div style="opacity:.9;">${s.hasGun ? `🔫 ${s.ammo}` : ''}${s.hasGun && s.hasBat ? ' · ' : ''}${s.hasBat ? '🏏 Bat' : ''}</div>` : '')
            + `<div style="opacity:.7;font-size:13px;">Sales ${s.sales} · Busts ${s.busted}</div>`;
    }

    // ---- interaction prompt --------------------------------------------
    let _promptEl = null;
    function showPrompt(text) {
        if (!_promptEl?.parentNode) {
            const el = document.createElement('div');
            el.className = 'tycoon-overlay';
            el.style.cssText = 'position:absolute;left:50%;bottom:96px;transform:translateX(-50%);'
                + 'pointer-events:none;z-index:997;text-align:center;'
                + 'font:800 18px/1.3 "Trebuchet MS",system-ui,sans-serif;color:#fff;'
                + 'background:rgba(8,16,12,0.7);padding:8px 16px;border-radius:10px;'
                + 'border:1px solid rgba(120,255,160,0.4);text-shadow:0 2px 4px rgba(0,0,0,0.8);';
            (document.getElementById('canvas-container') || document.body)?.appendChild(el);
            _promptEl = el;
        }
        _promptEl.style.display = 'block';
        _promptEl.innerHTML = text;
    }
    function hidePrompt() { if (_promptEl) _promptEl.style.display = 'none'; }

    // ---- floating cash text --------------------------------------------
    let _floatLayer = null;
    const _tmpProj = new THREE.Vector3();
    const _tmpFloat = new THREE.Vector3();
    function floatText(text, worldPos, color = '#9dffa0') {
        const { camera, renderer } = core;
        if (!camera || !renderer || !worldPos) return;
        if (!_floatLayer?.parentNode) {
            const el = document.createElement('div');
            el.className = 'tycoon-overlay';
            el.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:997;overflow:hidden;';
            (document.getElementById('canvas-container') || document.body)?.appendChild(el);
            _floatLayer = el;
        }
        const v = _tmpFloat.copy(worldPos).project(camera);
        if (v.z > 1) return;
        const rect = renderer.domElement.getBoundingClientRect();
        const host = (document.getElementById('canvas-container') || document.body).getBoundingClientRect();
        const x = rect.left - host.left + (v.x * 0.5 + 0.5) * rect.width;
        const y = rect.top - host.top + (-v.y * 0.5 + 0.5) * rect.height;
        const node = document.createElement('div');
        node.textContent = text;
        node.style.cssText = `position:absolute;left:${x}px;top:${y}px;transform:translate(-50%,-50%);`
            + `color:${color};font:900 20px/1 "Trebuchet MS",system-ui,sans-serif;`
            + `text-shadow:0 2px 6px rgba(0,0,0,0.9);transition:transform .8s ease,opacity .8s ease;opacity:1;`;
        _floatLayer.appendChild(node);
        requestAnimationFrame(() => {
            node.style.transform = 'translate(-50%,-50%) translateY(-52px)';
            node.style.opacity = '0';
        });
        setTimeout(() => node.remove(), 820);
    }

    // ---- cook station: tactile recipe panel ----------------------------
    let _cookEl = null;
    function openCook() {
        const s = ensureState();
        if (s.cooking || s.shopOpen) return;
        if (s.stash >= stashCap(s)) { showPrompt('Stash full — go sell'); return; }
        s.cooking = true;
        s.recipe = [];
        gameplay.roguePaused = true;           // reuse the sim-pause flag
        try { document.exitPointerLock?.(); } catch (e) {}
        renderCook();
    }
    function renderCook() {
        const s = ensureState();
        if (_cookEl?.parentNode) _cookEl.remove();
        const step = s.recipe.length;          // 0..RECIPE_LEN
        const done = step >= RECIPE_LEN;
        const liveQ = Math.max(scoreRecipe(s.recipe), purityFloor(s)); // quality if mixed now

        const overlay = document.createElement('div');
        overlay.className = 'tycoon-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:1200;pointer-events:auto;'
            + 'background:rgba(4,10,8,0.82);backdrop-filter:blur(3px);display:flex;'
            + 'flex-direction:column;align-items:center;justify-content:center;'
            + 'font-family:"Trebuchet MS",system-ui,sans-serif;color:#eaffea;';

        const title = document.createElement('div');
        title.textContent = done ? 'READY TO MIX' : `COOK — step ${step + 1} of ${RECIPE_LEN}`;
        title.style.cssText = 'font:900 30px/1.1 inherit;margin-bottom:6px;color:#9dffa0;'
            + 'text-shadow:0 0 18px rgba(60,255,120,0.5);';
        overlay.appendChild(title);

        const hint = document.createElement('div');
        hint.textContent = done
            ? 'Add the reagents in the right order for max purity.'
            : 'Pick the next reagent. Wrong order lowers purity.';
        hint.style.cssText = 'font:600 15px/1.3 inherit;opacity:.8;margin-bottom:18px;';
        overlay.appendChild(hint);

        // Slots: show what's been added and the upcoming empty slot.
        const slots = document.createElement('div');
        slots.style.cssText = 'display:flex;gap:10px;margin-bottom:22px;';
        for (let i = 0; i < RECIPE_LEN; i++) {
            const added = s.recipe[i];
            const def = COOK_STEPS.find((c) => c.key === added);
            const ok = added === COOK_STEPS[i].key;
            const cell = document.createElement('div');
            cell.style.cssText = 'width:120px;height:54px;border-radius:10px;display:flex;'
                + 'align-items:center;justify-content:center;font:800 14px/1.1 inherit;'
                + 'box-sizing:border-box;text-align:center;padding:4px;'
                + (added
                    ? `background:${def?.color || '#888'}22;border:2px solid ${ok ? '#9dffa0' : '#ff7070'};color:${ok ? '#eaffea' : '#ffb3b3'};`
                    : `background:rgba(255,255,255,0.05);border:2px dashed rgba(160,255,190,${i === step ? 0.7 : 0.25});color:rgba(200,255,210,0.5);`);
            cell.textContent = added ? (def?.t || added) : (i === step ? '?' : '·');
            slots.appendChild(cell);
        }
        overlay.appendChild(slots);

        // Reagent buttons (full palette every step — the order is the skill).
        if (!done) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;justify-content:center;max-width:90vw;';
            COOK_STEPS.forEach((r) => {
                const b = document.createElement('button');
                b.style.cssText = 'cursor:pointer;width:150px;padding:16px 12px;border-radius:12px;'
                    + 'font:800 17px/1.2 inherit;color:#0a140e;box-sizing:border-box;'
                    + `background:linear-gradient(160deg,${r.color},${r.color}cc);`
                    + 'border:2px solid rgba(0,0,0,0.25);box-shadow:0 6px 22px rgba(0,0,0,0.45);'
                    + 'transition:transform .12s;';
                b.textContent = r.t;
                b.onmouseenter = () => { b.style.transform = 'translateY(-5px)'; };
                b.onmouseleave = () => { b.style.transform = 'none'; };
                b.onclick = () => { s.recipe.push(r.key); renderCook(); };
                row.appendChild(b);
            });
            overlay.appendChild(row);
        }

        // Live purity preview.
        const pure = document.createElement('div');
        const pct = Math.round(liveQ * 100);
        pure.innerHTML = `Purity so far: <b style="color:${pct >= 75 ? '#9dffa0' : pct >= 40 ? '#ffae00' : '#ff7070'}">${pct}%</b>`;
        pure.style.cssText = 'margin-top:22px;font:700 17px/1 inherit;opacity:.95;';
        overlay.appendChild(pure);

        // Action row: Mix (when full) + Cancel.
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:14px;margin-top:18px;';
        if (done) {
            const mix = document.createElement('button');
            mix.textContent = 'MIX BATCH';
            mix.style.cssText = 'padding:12px 30px;cursor:pointer;font:900 18px/1 inherit;color:#0a140e;'
                + 'border-radius:12px;background:linear-gradient(160deg,#9dffa0,#3fbf5f);'
                + 'border:2px solid rgba(0,0,0,0.25);box-shadow:0 6px 22px rgba(0,0,0,0.45);';
            mix.onclick = () => finishCook();
            actions.appendChild(mix);
        }
        const cancel = document.createElement('button');
        cancel.textContent = done ? 'DISCARD' : 'CANCEL (Esc)';
        cancel.style.cssText = 'padding:12px 30px;cursor:pointer;font:800 18px/1 inherit;color:#fff;'
            + 'border-radius:12px;background:linear-gradient(160deg,#5a2424,#2a0e0e);'
            + 'border:2px solid rgba(255,140,140,0.5);';
        cancel.onclick = () => closeCook();
        actions.appendChild(cancel);
        overlay.appendChild(actions);

        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        _cookEl = overlay;
    }
    function finishCook() {
        const s = ensureState();
        const q = Math.max(scoreRecipe(s.recipe), purityFloor(s));
        // Yield scales 50%..100% of the upgrade-driven batch by quality.
        const room = stashCap(s) - s.stash;
        const made = Math.max(0, Math.min(room, Math.round(batchYield(s) * (0.5 + 0.5 * q))));
        blendStashQuality(s, made, q);
        s.stash += made;
        s.lastQ = q;
        closeCook();
        floatText(`+${made} @ ${Math.round(q * 100)}%`, s.cookPos, q >= 0.75 ? '#9dffa0' : '#ffae00');
        updateHud();
    }
    function closeCook() {
        const s = window.drugTycoon;
        if (_cookEl?.parentNode) _cookEl.remove();
        _cookEl = null;
        if (s) { s.cooking = false; s.recipe = []; }
        gameplay.roguePaused = false;
        const { renderer } = core;
        if (renderer?.domElement && !window.matchMedia?.('(pointer:coarse)')?.matches) {
            const resume = () => {
                renderer.domElement.removeEventListener('click', resume);
                try { renderer.domElement.requestPointerLock?.(); } catch (e) {}
            };
            renderer.domElement.addEventListener('click', resume);
        }
    }

    // ---- upgrade shop ---------------------------------------------------
    let _shopEl = null;
    function openShop() {
        const s = ensureState();
        if (s.shopOpen) return;
        s.shopOpen = true;
        gameplay.roguePaused = true;          // reuse the sim-pause flag
        try { document.exitPointerLock?.(); } catch (e) {}
        renderShop();
    }
    function renderShop() {
        const s = ensureState();
        if (_shopEl?.parentNode) _shopEl.remove();
        const overlay = document.createElement('div');
        overlay.className = 'tycoon-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:1200;pointer-events:auto;'
            + 'background:rgba(4,10,8,0.82);backdrop-filter:blur(3px);display:flex;'
            + 'flex-direction:column;align-items:center;justify-content:center;'
            + 'font-family:"Trebuchet MS",system-ui,sans-serif;color:#eaffea;';
        const title = document.createElement('div');
        title.textContent = `UPGRADES — $${Math.floor(s.cash).toLocaleString()}`;
        title.style.cssText = 'font:900 30px/1.1 inherit;margin-bottom:22px;color:#9dffa0;'
            + 'text-shadow:0 0 18px rgba(60,255,120,0.5);';
        overlay.appendChild(title);

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:18px;flex-wrap:wrap;justify-content:center;max-width:90vw;';
        UPGRADES.forEach((u) => {
            const lvl = s.up[u.key];
            const cost = u.cost(lvl);
            const afford = s.cash >= cost;
            const c = document.createElement('button');
            c.style.cssText = 'cursor:pointer;color:#eaffea;text-align:center;width:200px;height:210px;'
                + 'padding:20px 14px;border-radius:14px;box-sizing:border-box;'
                + `background:linear-gradient(160deg,rgba(18,48,28,0.95),rgba(8,24,14,0.95));`
                + `border:2px solid ${afford ? 'rgba(120,255,160,0.55)' : 'rgba(120,120,120,0.4)'};`
                + 'box-shadow:0 8px 30px rgba(0,0,0,0.5);transition:transform .12s;'
                + (afford ? '' : 'opacity:.55;');
            c.innerHTML = `<div style="font:800 20px/1.2 inherit;color:#9dffa0;margin-bottom:10px;">${u.t}</div>`
                + `<div style="font:600 15px/1.4 inherit;opacity:.92;margin-bottom:14px;">${u.d}</div>`
                + `<div style="font:700 14px/1 inherit;opacity:.8;">Lv ${lvl}</div>`
                + `<div style="margin-top:14px;font:800 18px/1 inherit;color:${afford ? '#9dffa0' : '#ff8a8a'};">$${cost.toLocaleString()}</div>`;
            c.onmouseenter = () => { c.style.transform = 'translateY(-6px)'; };
            c.onmouseleave = () => { c.style.transform = 'none'; };
            c.onclick = () => {
                if (s.cash < cost) return;
                s.cash -= cost;
                s.up[u.key] += 1;
                renderShop();
                updateHud();
            };
            row.appendChild(c);
        });
        overlay.appendChild(row);

        // ---- weapons section ------------------------------------------
        const wTitle = document.createElement('div');
        wTitle.textContent = 'WEAPONS';
        wTitle.style.cssText = 'font:900 20px/1 inherit;margin:26px 0 12px;color:#ffd24a;'
            + 'text-shadow:0 0 14px rgba(255,180,60,0.4);';
        overlay.appendChild(wTitle);

        const wRow = document.createElement('div');
        wRow.style.cssText = 'display:flex;gap:18px;flex-wrap:wrap;justify-content:center;max-width:90vw;';
        const weapons = [
            {
                t: 'Pistol', d: 'Ranged. Needs ammo.', cost: GUN_PRICE,
                owned: () => s.hasGun, sub: () => s.hasGun ? 'OWNED' : '',
                buy: () => { s.hasGun = true; attachHeldGun(); },
            },
            {
                t: 'Ammo', d: `+${AMMO_PER_PACK} pistol rounds`, cost: AMMO_PRICE,
                owned: () => false, sub: () => `Have: ${s.ammo}`,
                buy: () => { s.ammo += AMMO_PER_PACK; },
            },
            {
                t: 'Baseball Bat', d: 'Melee knockdown. No ammo.', cost: BAT_PRICE,
                owned: () => s.hasBat, sub: () => s.hasBat ? 'OWNED' : '',
                buy: () => { s.hasBat = true; },
            },
        ];
        weapons.forEach((w) => {
            const isOwned = w.owned();
            const afford = !isOwned && s.cash >= w.cost;
            const c = document.createElement('button');
            c.style.cssText = 'cursor:pointer;color:#fff7e0;text-align:center;width:200px;height:200px;'
                + 'padding:20px 14px;border-radius:14px;box-sizing:border-box;'
                + 'background:linear-gradient(160deg,rgba(48,38,12,0.95),rgba(24,18,6,0.95));'
                + `border:2px solid ${(afford || isOwned) ? 'rgba(255,210,90,0.6)' : 'rgba(120,120,120,0.4)'};`
                + 'box-shadow:0 8px 30px rgba(0,0,0,0.5);transition:transform .12s;'
                + ((afford || isOwned) ? '' : 'opacity:.55;');
            c.innerHTML = `<div style="font:800 20px/1.2 inherit;color:#ffd24a;margin-bottom:10px;">${w.t}</div>`
                + `<div style="font:600 15px/1.4 inherit;opacity:.92;margin-bottom:12px;">${w.d}</div>`
                + `<div style="font:700 13px/1 inherit;opacity:.8;">${w.sub()}</div>`
                + `<div style="margin-top:14px;font:800 18px/1 inherit;color:${isOwned ? '#9dffa0' : (afford ? '#ffd24a' : '#ff8a8a')};">${isOwned ? '✓ Owned' : '$' + w.cost.toLocaleString()}</div>`;
            c.onmouseenter = () => { c.style.transform = 'translateY(-6px)'; };
            c.onmouseleave = () => { c.style.transform = 'none'; };
            c.onclick = () => {
                if (w.owned() || s.cash < w.cost) return;
                s.cash -= w.cost;
                w.buy();
                renderShop();
                updateHud();
            };
            wRow.appendChild(c);
        });
        overlay.appendChild(wRow);

        const close = document.createElement('button');
        close.textContent = 'CLOSE (Esc)';
        close.style.cssText = 'margin-top:26px;padding:12px 30px;cursor:pointer;'
            + 'font:800 18px/1 inherit;color:#fff;border-radius:12px;'
            + 'background:linear-gradient(160deg,#1f7a3a,#0e3a1d);'
            + 'border:2px solid rgba(120,255,160,0.5);';
        close.onclick = () => closeShop();
        overlay.appendChild(close);

        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        _shopEl = overlay;
    }
    function closeShop() {
        const s = window.drugTycoon;
        if (_shopEl?.parentNode) _shopEl.remove();
        _shopEl = null;
        if (s) s.shopOpen = false;
        gameplay.roguePaused = false;
        const { renderer } = core;
        if (renderer?.domElement && !window.matchMedia?.('(pointer:coarse)')?.matches) {
            const resume = () => {
                renderer.domElement.removeEventListener('click', resume);
                try { renderer.domElement.requestPointerLock?.(); } catch (e) {}
            };
            renderer.domElement.addEventListener('click', resume);
        }
    }

    // ---- NPC buyers + police -------------------------------------------
    // Humanoid people (box-limb groups from the ragdoll module), walked
    // kinematically here. On death they convert to a Jolt ragdoll.
    const SKIN_TONES = ['#e8b893', '#c68642', '#8d5524', '#f1c27d', '#ffdbac'];
    const SHIRT_TONES = ['#3da6ff', '#2dd4bf', '#f97316', '#a855f7', '#eab308', '#ef4444'];
    function randomFrom(arr) { return arr[(Math.random() * arr.length) | 0]; }

    function placePerson(group, x, y, z, faceY = 0) {
        const { scene } = core;
        group.position.set(x, y, z);
        group.rotation.y = faceY;
        group.updateMatrixWorld(true);
        scene?.add(group);
    }
    function spawnBuyer(s, layout) {
        const shirtColor = randomFrom(SHIRT_TONES);
        const group = ragdoll.makePerson({
            skinColor: randomFrom(SKIN_TONES),
            shirtColor,
            pantsColor: '#22303c',
        });
        const radius = layout.streetRadius ?? 16;
        const ang = Math.random() * Math.PI * 2;
        placePerson(group, Math.cos(ang) * radius, layout.spawnY ?? 0, Math.sin(ang) * radius);
        const npc = { mesh: group, target: randomStreetPoint(layout), wantsBuy: true, shirtColor };
        s.npcs.push(npc);
        return npc;
    }
    function spawnPolice(s, layout) {
        const group = ragdoll.makePerson({
            skinColor: randomFrom(SKIN_TONES),
            shirtColor: '#1d4ed8',   // police blue
            pantsColor: '#0b1b3a',
        });
        // Cops spawn ONLY at the map edges (perimeter), then walk inward — a
        // random point on the square boundary just inside the wall.
        const edge = (layout.mapHalf ?? 40) - 1.5;
        let x, z;
        if (Math.random() < 0.5) {                 // N or S edge
            x = (Math.random() * 2 - 1) * edge;
            z = (Math.random() < 0.5 ? -1 : 1) * edge;
        } else {                                   // E or W edge
            x = (Math.random() < 0.5 ? -1 : 1) * edge;
            z = (Math.random() * 2 - 1) * edge;
        }
        placePerson(group, x, layout.spawnY ?? 0, z);
        const cop = { mesh: group };
        s.police.push(cop);
        return cop;
    }
    function randomStreetPoint(layout) {
        const r = (layout.streetRadius ?? 16) * (0.3 + Math.random() * 0.7);
        const ang = Math.random() * Math.PI * 2;
        return new THREE.Vector3(Math.cos(ang) * r, layout.spawnY ?? 0, Math.sin(ang) * r);
    }

    // ---- day / night cycle ---------------------------------------------
    function isNight(s) {
        const t = s.timeOfDay;
        return t >= NIGHT_START || t < NIGHT_END;
    }
    // 0 = full day, 1 = full night, with smooth dusk/dawn ramps.
    function nightFactor(s) {
        const t = s.timeOfDay;
        // Short dusk ramp so it's clearly dark right after 21:00.
        const DUSK = 0.02, DAWN = 0.04;
        if (t >= NIGHT_START) {                 // dusk → midnight
            return Math.min(1, (t - NIGHT_START) / DUSK);
        }
        if (t < NIGHT_END) {                    // midnight → dawn
            return Math.min(1, 1 - (t / Math.max(DAWN, 1e-3)));
        }
        // Daytime, but ease the approach to dusk a touch before NIGHT_START.
        if (t > NIGHT_START - DUSK) return Math.max(0, (t - (NIGHT_START - DUSK)) / DUSK) * 0.0;
        return 0;
    }
    let _sunLight = null;
    const _dayColor = new THREE.Color(0xfff0d0);
    const _nightColor = new THREE.Color(0x2a3a66);
    const _daySky = new THREE.Color(0x9ec4ff);
    const _nightSky = new THREE.Color(0x070b18);
    const _tmpColor = new THREE.Color();
    function findSun() {
        if (_sunLight && _sunLight.parent) return _sunLight;
        const { scene } = core;
        if (!scene) return null;
        scene.traverse((o) => { if (!_sunLight && o.name === 'tycoon-sun') _sunLight = o; });
        return _sunLight;
    }
    function advanceDayNight(s, dt) {
        s.timeOfDay = (s.timeOfDay + dt / DAY_LENGTH_SEC) % 1;
        const n = nightFactor(s);
        const sun = findSun();
        if (sun) {
            sun.intensity = 14 * (1 - n) + 1.5 * n;       // bright day → dim night
            _tmpColor.copy(_dayColor).lerp(_nightColor, n);
            sun.color.copy(_tmpColor);
        }
        const { scene } = core;
        if (scene) {
            if (!scene.background || !scene.background.isColor) {
                scene.background = _daySky.clone();
            }
            _tmpColor.copy(_daySky).lerp(_nightSky, n);
            scene.background.copy(_tmpColor);
        }
        // Interior lights: cheap TWO-state day/night. Only walk the scene when
        // the night flag actually flips, not every frame.
        const night = isNight(s);
        if (night !== _roomNightState) {
            _roomNightState = night;
            applyRoomLighting(night);
        }
    }
    // Day = brighter/cooler grow-room fill; night = dimmer/warmer. Toggled only
    // on a day↔night transition (one traversal), so it's effectively free.
    let _roomNightState = null;
    function applyRoomLighting(night) {
        const { scene } = core;
        if (!scene) return;
        const intensity = night ? 3.0 : 6.0;
        scene.traverse((o) => {
            if (o.isPointLight && typeof o.name === 'string' && o.name.startsWith('grow-light')) {
                o.intensity = intensity;
                o.color.set(night ? 0xffcaa0 : 0xffe6b0);
            }
        });
    }
    function sleepInBed(s) {
        // Skip to morning: just after dawn so it's daytime + safe.
        s.timeOfDay = 0.04;
        floatText('💤 Slept until morning', new THREE.Vector3(...(core.currentMesh?.userData?.drugTycoonLevel?.bed || [0, 1.5, 300])).setY(1.8), '#bfe6ff');
        // Force the room lights back to day immediately.
        _roomNightState = false;
        applyRoomLighting(false);
    }
    function dayClock(s) {
        // Map timeOfDay (0..1) to a 24h clock starting at ~06:00 sunrise.
        const hours = (s.timeOfDay * 24 + 6) % 24;
        const h = Math.floor(hours);
        const m = Math.floor((hours - h) * 60);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    // ---- shared WebAudio context ---------------------------------------
    // One AudioContext for the siren + all SFX. Lazily created (needs a user
    // gesture — the pointer-lock click satisfies it).
    let _audioCtx = null;
    function audioCtx() {
        if (_audioCtx) return _audioCtx;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        try { _audioCtx = new Ctx(); } catch (e) { _audioCtx = null; }
        return _audioCtx;
    }

    // One-shot synthesized SFX, optionally positional (panned from worldPos).
    //   'shot'    — short percussive gunshot (noise burst + low thump)
    //   'hit'     — quick body-hit thud
    //   'cash'    — two-note "cha-ching" sale chime
    function playSfx(type, worldPos = null, vol = 1) {
        const ctx = audioCtx();
        if (!ctx) return;
        if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
        const now = ctx.currentTime;

        // Output node: a panner if positional, else straight to destination.
        let out = ctx.destination;
        let panner = null;
        if (worldPos) {
            panner = ctx.createPanner();
            panner.panningModel = 'HRTF';
            panner.distanceModel = 'inverse';
            panner.refDistance = 3;
            panner.maxDistance = 40;
            panner.rolloffFactor = 1.2;
            setPannerPos(panner, ctx, worldPos.x, (worldPos.y || 0), worldPos.z);
            panner.connect(ctx.destination);
            out = panner;
            syncListener(ctx);
        }

        if (type === 'cash') {
            // Two bright notes (C6 → E6) = "cha-ching".
            [[1047, 0], [1319, 0.09]].forEach(([f, t0]) => {
                const o = ctx.createOscillator();
                o.type = 'triangle';
                o.frequency.value = f;
                const g = ctx.createGain();
                const t = now + t0;
                g.gain.setValueAtTime(0, t);
                g.gain.linearRampToValueAtTime(0.22 * vol, t + 0.01);
                g.gain.exponentialRampToValueAtTime(0.0008, t + 0.22);
                o.connect(g).connect(out);
                o.start(t); o.stop(t + 0.24);
            });
            return;
        }

        // Noise burst (shared by 'shot' and 'hit').
        const dur = type === 'shot' ? 0.16 : 0.10;
        const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            data[i] = (Math.random() * 2 - 1) * (1 - i / data.length); // decaying noise
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = type === 'shot' ? 2200 : 1400;
        const g = ctx.createGain();
        const peak = (type === 'shot' ? 0.5 : 0.3) * vol;
        g.gain.setValueAtTime(peak, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + dur);
        src.connect(lp).connect(g).connect(out);
        src.start(now);

        if (type === 'shot') {
            // Low thump under the crack for body.
            const o = ctx.createOscillator();
            o.type = 'sine';
            o.frequency.setValueAtTime(160, now);
            o.frequency.exponentialRampToValueAtTime(50, now + 0.12);
            const og = ctx.createGain();
            og.gain.setValueAtTime(0.4 * vol, now);
            og.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
            o.connect(og).connect(out);
            o.start(now); o.stop(now + 0.14);
        }
    }

    // ---- police siren (synthesized, 3D positional) ---------------------
    // A two-tone wail (oscillator pitch swung by a slow LFO) routed through a
    // PannerNode so it's spatialised: the sound comes from the nearest cop's
    // position relative to the camera, with WebAudio doing the distance falloff
    // and left/right panning. The AudioListener tracks the camera each frame.
    // Lazily created (AudioContext needs a user gesture — pointer-lock click).
    let _siren = null;
    function ensureSiren() {
        if (_siren) return _siren;
        const ctx = audioCtx();
        if (!ctx) return null;
        try {
            const osc = ctx.createOscillator();
            osc.type = 'sine';               // smooth tone — no sawtooth buzz
            osc.frequency.value = 520;       // lower, softer base pitch
            // LFO swings the pitch — slow + narrow for a gentle wail.
            const lfo = ctx.createOscillator();
            lfo.type = 'sine';
            lfo.frequency.value = 0.3;       // slower swing
            const lfoGain = ctx.createGain();
            lfoGain.gain.value = 120;        // ± Hz swing (narrower)
            lfo.connect(lfoGain).connect(osc.frequency);
            // Low-pass to take any edge off the top end.
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = 900;
            const gain = ctx.createGain();
            gain.gain.value = 0;             // master on/off (smooth ramp)
            // Spatial panner: inverse distance falloff out to SIREN_RANGE.
            const panner = ctx.createPanner();
            panner.panningModel = 'HRTF';
            panner.distanceModel = 'inverse';
            panner.refDistance = 2;
            panner.maxDistance = SIREN_RANGE;
            panner.rolloffFactor = 1.4;
            osc.connect(lp).connect(gain).connect(panner).connect(ctx.destination);
            osc.start();
            lfo.start();
            _siren = { ctx, osc, gain, lfo, panner };
        } catch (e) { _siren = null; }
        return _siren;
    }
    function setPannerPos(panner, ctx, x, y, z) {
        if (panner.positionX) {              // modern AudioParam API
            const t = ctx.currentTime;
            panner.positionX.setTargetAtTime(x, t, 0.02);
            panner.positionY.setTargetAtTime(y, t, 0.02);
            panner.positionZ.setTargetAtTime(z, t, 0.02);
        } else if (panner.setPosition) {     // legacy
            panner.setPosition(x, y, z);
        }
    }
    function syncListener(ctx) {
        const { camera } = core;
        if (!camera) return;
        const l = ctx.listener;
        camera.getWorldPosition(_camPos);
        camera.getWorldDirection(_camDir);
        if (l.positionX) {
            const t = ctx.currentTime;
            l.positionX.setTargetAtTime(_camPos.x, t, 0.02);
            l.positionY.setTargetAtTime(_camPos.y, t, 0.02);
            l.positionZ.setTargetAtTime(_camPos.z, t, 0.02);
            if (l.forwardX) {
                l.forwardX.setTargetAtTime(_camDir.x, t, 0.02);
                l.forwardY.setTargetAtTime(_camDir.y, t, 0.02);
                l.forwardZ.setTargetAtTime(_camDir.z, t, 0.02);
                l.upX.setTargetAtTime(0, t, 0.02);
                l.upY.setTargetAtTime(1, t, 0.02);
                l.upZ.setTargetAtTime(0, t, 0.02);
            }
        } else if (l.setPosition) {          // legacy
            l.setPosition(_camPos.x, _camPos.y, _camPos.z);
            l.setOrientation(_camDir.x, _camDir.y, _camDir.z, 0, 1, 0);
        }
    }
    function updateSiren(s, playerPos) {
        if (!playerPos) return;
        // Find the nearest cop (heat police + night patrol) — it carries the siren.
        let nearest = Infinity, nearestCop = null;
        for (const c of [...s.police, ...s.patrol]) {
            if (!c.mesh) continue;
            const d = Math.hypot(c.mesh.position.x - playerPos.x, c.mesh.position.z - playerPos.z);
            if (d < nearest) { nearest = d; nearestCop = c; }
        }
        const audible = nearestCop && nearest < SIREN_RANGE;
        if (!audible && !_siren) return;     // don't spin up audio for silence
        const siren = ensureSiren();
        if (!siren) return;
        if (siren.ctx.state === 'suspended') { try { siren.ctx.resume(); } catch (e) {} }
        syncListener(siren.ctx);
        if (audible) {
            const m = nearestCop.mesh.position;
            setPannerPos(siren.panner, siren.ctx, m.x, (m.y || 0) + 1.4, m.z);
        }
        // Master gain just gates on/off; the panner handles distance loudness.
        const now = siren.ctx.currentTime;
        siren.gain.gain.cancelScheduledValues(now);
        siren.gain.gain.linearRampToValueAtTime(audible ? SIREN_MAX_GAIN : 0, now + 0.12);
    }
    function stopSiren() {
        if (_siren) { try { _siren.gain.gain.value = 0; } catch (e) {} }
    }
    function destroySiren() {
        // Stop the siren oscillators but DON'T close the shared AudioContext —
        // SFX still use it. Closing happens in destroyAudio().
        if (_siren) {
            try { _siren.osc.stop(); _siren.lfo.stop(); } catch (e) {}
            _siren = null;
        }
    }
    function destroyAudio() {
        destroySiren();
        if (_audioCtx) { try { _audioCtx.close(); } catch (e) {} _audioCtx = null; }
    }

    // ---- night patrol cops ---------------------------------------------
    function spawnPatrolCop(s, layout) {
        const cop = spawnPolice(s, layout);   // reuse police look + placement
        // Pull it OUT of the heat-police list; patrol is managed separately.
        const i = s.police.indexOf(cop);
        if (i >= 0) s.police.splice(i, 1);
        cop.target = randomStreetPoint(layout);
        cop.alerted = false;
        s.patrol.push(cop);
        return cop;
    }
    function clearPatrol(s) {
        const { scene } = core;
        for (const c of s.patrol) { try { scene?.remove(c.mesh); } catch (e) {} }
        s.patrol.length = 0;
    }
    function updatePatrol(s, layout, playerPos, dt) {
        const night = isNight(s);
        if (night) {
            while (s.patrol.length < PATROL_COP_COUNT) spawnPatrolCop(s, layout);
        } else if (s.patrol.length) {
            clearPatrol(s);                    // dawn: patrol goes off shift
            return;
        }
        if (!playerPos) return;
        const playerVec = _tmpProj.set(playerPos.x, layout.spawnY ?? 0, playerPos.z);
        for (const cop of s.patrol) {
            if (!cop.mesh) continue;
            const cd = Math.hypot(cop.mesh.position.x - playerPos.x, cop.mesh.position.z - playerPos.z);
            // Spot the player nearby (or any time heat is already high) → chase.
            if (cd < PATROL_SPOT_RADIUS || wantedStars(s) >= 1) cop.alerted = true;
            if (cop.alerted) {
                moveToward(cop.mesh, playerVec, POLICE_SPEED, dt, layout);
                if (cd < BUST_RADIUS) bustPlayer(s, cop);
            } else {
                if (moveToward(cop.mesh, cop.target, PATROL_SPEED, dt, layout)) {
                    cop.target = randomStreetPoint(layout);
                }
            }
        }
    }

    // ---- gun: pickup mesh, held mesh, shooting --------------------------
    function makeGunMesh(scale = 1) {
        // Simple low-poly pistol from two boxes (slide + grip).
        const g = new THREE.Group();
        const bodyMat = new THREE.MeshStandardMaterial({ color: '#2b2b30', roughness: 0.5, metalness: 0.7 });
        const slide = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.12, 0.42), bodyMat);
        slide.position.set(0, 0.04, -0.05);
        const grip = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.26, 0.14), bodyMat.clone());
        grip.position.set(0, -0.14, 0.12);
        grip.rotation.x = 0.28;
        g.add(slide); g.add(grip);
        g.scale.setScalar(scale);
        g.traverse((m) => { if (m.isMesh) { m.castShadow = true; } });
        return g;
    }

    function spawnGunPickup(s, layout) {
        const { scene } = core;
        if (s.gunPickupMesh || !Array.isArray(layout.gunPickup)) return;
        const m = makeGunMesh(1.4);
        m.position.set(...layout.gunPickup);
        scene?.add(m);
        s.gunPickupMesh = m;
    }

    let _heldGun = null;
    function attachHeldGun() {
        const { camera } = core;
        if (!camera || _heldGun) return;
        _heldGun = makeGunMesh(1.0);
        // Bottom-right of the view, pointing forward.
        _heldGun.position.set(0.28, -0.26, -0.6);
        _heldGun.rotation.set(0, Math.PI, 0);
        camera.add(_heldGun);
    }
    function detachHeldGun() {
        if (_heldGun?.parent) _heldGun.parent.remove(_heldGun);
        _heldGun = null;
        if (_muzzleFlash) { try { _muzzleFlash.parent?.remove(_muzzleFlash); } catch (e) {} _muzzleFlash = null; }
    }

    // Muzzle tracer: a quick fading line from the gun to the hit point.
    const _tracers = [];
    function spawnTracer(from, to) {
        const { scene } = core;
        if (!scene) return;
        const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
        const mat = new THREE.LineBasicMaterial({ color: 0xfff3a0, transparent: true, opacity: 0.9 });
        const line = new THREE.Line(geo, mat);
        line.renderOrder = 9;
        scene.add(line);
        _tracers.push({ line, born: performance.now?.() || Date.now() });
    }
    function updateTracers() {
        const { scene } = core;
        const now = performance.now?.() || Date.now();
        for (let i = _tracers.length - 1; i >= 0; i--) {
            const t = _tracers[i];
            const age = now - t.born;
            if (age > 90) {
                try { scene?.remove(t.line); t.line.geometry.dispose(); t.line.material.dispose(); } catch (e) {}
                _tracers.splice(i, 1);
            } else {
                t.line.material.opacity = 0.9 * (1 - age / 90);
            }
        }
    }

    // Brief muzzle flash: a glowing sprite + point light at the gun muzzle,
    // parented to the camera so it sits at the barrel. Auto-removed after ~70ms.
    let _muzzleFlash = null;
    function makeFlashTexture() {
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const g = c.getContext('2d');
        const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, 'rgba(255,250,210,1)');
        grad.addColorStop(0.4, 'rgba(255,200,90,0.8)');
        grad.addColorStop(1, 'rgba(255,140,30,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 64, 64);
        const tex = new THREE.CanvasTexture(c);
        return tex;
    }
    let _flashTex = null;
    function muzzleFlash() {
        const { camera } = core;
        if (!camera) return;
        if (!_flashTex) _flashTex = makeFlashTexture();
        // Remove any lingering flash first.
        if (_muzzleFlash) { try { _muzzleFlash.parent?.remove(_muzzleFlash); } catch (e) {} _muzzleFlash = null; }
        const grp = new THREE.Group();
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({
            map: _flashTex, transparent: true, depthTest: false, depthWrite: false,
            blending: THREE.AdditiveBlending, toneMapped: false,
        }));
        spr.scale.setScalar(0.5 + Math.random() * 0.2);
        spr.material.rotation = Math.random() * Math.PI;
        grp.add(spr);
        const light = new THREE.PointLight(0xffd27a, 6, 7, 2);
        grp.add(light);
        // At the held gun's muzzle (bottom-right, slightly forward).
        grp.position.set(0.3, -0.24, -0.95);
        grp.renderOrder = 11;
        camera.add(grp);
        _muzzleFlash = grp;
        const born = performance.now?.() || Date.now();
        grp.userData.born = born;
    }
    function updateMuzzleFlash() {
        if (!_muzzleFlash) return;
        const now = performance.now?.() || Date.now();
        const age = now - (_muzzleFlash.userData.born || 0);
        if (age > 70) {
            try { _muzzleFlash.parent?.remove(_muzzleFlash); } catch (e) {}
            _muzzleFlash = null;
        }
    }

    const _camPos = new THREE.Vector3();
    const _camDir = new THREE.Vector3();
    const _toNpc = new THREE.Vector3();
    function tryShoot(s, layout) {
        const { camera } = core;
        if (!camera) return;
        const now = performance.now?.() || Date.now();
        if (now < s.nextShotAt) return;
        s.nextShotAt = now + GUN_FIRE_COOLDOWN_MS;
        camera.getWorldPosition(_camPos);
        camera.getWorldDirection(_camDir).normalize();
        // Out of ammo: dry click, no shot.
        if (s.ammo <= 0) {
            playSfx('hit', null, 0.3);   // soft click
            floatText('*click* — out of ammo', _camPos.clone().addScaledVector(_camDir, 1.5), '#ff9a9a');
            return;
        }
        s.ammo -= 1;

        // Aim-cone hit test against living people (buyers + police + night
        // patrol). Pick the closest target inside the cone and within range.
        const targets = s.npcs.concat(s.police, s.patrol);
        let best = null, bestDist = GUN_RANGE;
        for (const t of targets) {
            if (!t.mesh) continue;
            // Aim at chest height (group origin is at feet).
            _toNpc.copy(t.mesh.position); _toNpc.y += 1.25; _toNpc.sub(_camPos);
            const dist = _toNpc.length();
            if (dist < 0.001 || dist > GUN_RANGE) continue;
            _toNpc.multiplyScalar(1 / dist);
            const dot = _toNpc.dot(_camDir);
            if (dot < GUN_AIM_DOT) continue;
            if (dist < bestDist) { bestDist = dist; best = t; }
        }

        // Tracer to target (or into the distance on a miss).
        const end = best
            ? _camPos.clone().add(_camDir.clone().multiplyScalar(bestDist))
            : _camPos.clone().add(_camDir.clone().multiplyScalar(GUN_RANGE));
        const muzzle = _camPos.clone().add(_camDir.clone().multiplyScalar(0.6)).add(new THREE.Vector3(0, -0.2, 0));
        spawnTracer(muzzle, end);
        muzzleFlash();
        playSfx('shot', muzzle);

        // Tiny camera kick.
        if (gameplay.hitFeedback) gameplay.hitFeedback.shake = Math.max(gameplay.hitFeedback.shake || 0, 0.35);

        if (best) {
            // Ragdoll it, shoved along the shot direction.
            const dir = _camDir.clone();
            ragdoll.ragdollify(best.mesh, { x: dir.x * GUN_IMPULSE, y: 3.5, z: dir.z * GUN_IMPULSE });
            playSfx('hit', end);
            floatText('DOWN', end.clone().setY(end.y + 0.4), '#ff7070');
            // Remove from the live list it belonged to.
            let idx = s.npcs.indexOf(best);
            if (idx >= 0) { s.npcs.splice(idx, 1); }
            else if ((idx = s.police.indexOf(best)) >= 0) { s.police.splice(idx, 1); }
            else if ((idx = s.patrol.indexOf(best)) >= 0) { s.patrol.splice(idx, 1); }
        }
    }

    // Baseball bat: short-range melee swing. Knocks down the nearest person in
    // a wide cone within BAT_RANGE. No ammo, slower cadence than the pistol.
    function trySwingBat(s, layout) {
        const { camera } = core;
        if (!camera) return;
        const now = performance.now?.() || Date.now();
        if (now < s.nextSwingAt) return;
        s.nextSwingAt = now + BAT_COOLDOWN_MS;
        camera.getWorldPosition(_camPos);
        camera.getWorldDirection(_camDir).normalize();
        playSfx('shot', _camPos.clone().addScaledVector(_camDir, 1.0), 0.5);  // whoosh-ish
        if (gameplay.hitFeedback) gameplay.hitFeedback.shake = Math.max(gameplay.hitFeedback.shake || 0, 0.3);

        const targets = s.npcs.concat(s.police, s.patrol);
        let best = null, bestDist = BAT_RANGE;
        for (const t of targets) {
            if (!t.mesh) continue;
            _toNpc.copy(t.mesh.position); _toNpc.y += 1.0; _toNpc.sub(_camPos);
            const dist = _toNpc.length();
            if (dist < 0.001 || dist > BAT_RANGE) continue;
            _toNpc.multiplyScalar(1 / dist);
            if (_toNpc.dot(_camDir) < 0.6) continue;   // wide melee cone
            if (dist < bestDist) { bestDist = dist; best = t; }
        }
        if (best) {
            const dir = _camDir.clone();
            ragdoll.ragdollify(best.mesh, { x: dir.x * BAT_IMPULSE, y: 4.0, z: dir.z * BAT_IMPULSE });
            playSfx('hit', best.mesh.getWorldPosition(new THREE.Vector3()));
            floatText('WHACK', best.mesh.getWorldPosition(new THREE.Vector3()).setY(2.0), '#ffd24a');
            let idx = s.npcs.indexOf(best);
            if (idx >= 0) { s.npcs.splice(idx, 1); }
            else if ((idx = s.police.indexOf(best)) >= 0) { s.police.splice(idx, 1); }
            else if ((idx = s.patrol.indexOf(best)) >= 0) { s.patrol.splice(idx, 1); }
        }
    }

    function moveToward(mesh, target, speed, dt, layout) {
        if (!mesh || !target) return false;
        const dx = target.x - mesh.position.x;
        const dz = target.z - mesh.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.4) return true;
        const step = Math.min(dist, speed * dt);
        mesh.position.x += (dx / dist) * step;
        mesh.position.z += (dz / dist) * step;
        mesh.position.y = layout.spawnY ?? 0; // person group origin = feet
        mesh.rotation.y = Math.atan2(dx, dz); // face travel direction
        mesh.updateMatrixWorld(true);
        return false;
    }

    // ---- grow room: teleport, plants, harvest --------------------------
    function teleportPlayer(pos) {
        if (!physics?.character || !physics.Jolt) return;
        const { Jolt, character } = physics;
        const p = new Jolt.RVec3(pos[0], pos[1] + FLOOR_OFFSET, pos[2]);
        character.SetPosition(p);
        try { character.SetLinearVelocity(Jolt.Vec3.prototype.sZero()); } catch (e) {}
        Jolt.destroy(p);
    }

    // A weed plant mesh that swaps look by growth stage: a pot-top stem plus
    // foliage that scales up, turning amber + budding when ripe.
    function makePlantMesh() {
        const g = new THREE.Group();
        const stem = new THREE.Mesh(
            new THREE.CylinderGeometry(0.05, 0.07, 0.6, 5),
            new THREE.MeshStandardMaterial({ color: '#3f6d2a', roughness: 0.9 }),
        );
        stem.position.y = 0.3;   // stem bottom sits at the group origin (pot rim)
        const leaves = new THREE.Mesh(
            new THREE.IcosahedronGeometry(0.5, 0),
            new THREE.MeshStandardMaterial({ color: '#2f7d34', roughness: 0.85 }),
        );
        leaves.position.y = 0.75;
        leaves.name = 'leaves';
        g.add(stem); g.add(leaves);
        g.userData.leaves = leaves;
        return g;
    }
    function applyPlantStage(plant) {
        const leaves = plant.mesh?.userData?.leaves;
        if (!leaves) return;
        const ripe = plant.stage >= PLANT_STAGES;
        const t = Math.min(1, plant.stage / PLANT_STAGES);
        leaves.scale.setScalar(0.4 + t * 0.9);
        leaves.material.color.set(ripe ? '#b6d957' : '#2f7d34');
        leaves.material.emissive = new THREE.Color(ripe ? '#5a7a18' : '#000000');
        leaves.material.emissiveIntensity = ripe ? 0.4 : 0;
    }
    function ensurePlants(s, layout) {
        if (s.plantsBuilt) return;
        const { scene } = core;
        const pots = Array.isArray(layout.growPots) ? layout.growPots : [];
        const now = performance.now?.() || Date.now();
        for (const pot of pots) {
            const mesh = makePlantMesh();
            mesh.position.set(pot[0], pot[1] + 0.5, pot[2]); // sit on the pot rim
            scene?.add(mesh);
            // Start fully grown / ripe so the player can harvest immediately.
            const plant = { mesh, stage: PLANT_STAGES, grownAt: now + PLANT_GROW_MS, pos: pot };
            applyPlantStage(plant);
            s.plants.push(plant);
        }
        s.plantsBuilt = true;
    }
    function updatePlants(s) {
        const now = performance.now?.() || Date.now();
        for (const p of s.plants) {
            if (p.stage < PLANT_STAGES && now >= p.grownAt) {
                p.stage += 1;
                p.grownAt = now + PLANT_GROW_MS;
                applyPlantStage(p);
            }
        }
    }
    function harvestPlant(s, plant) {
        if (plant.stage < PLANT_STAGES) return;
        s.buds += BUDS_PER_PLANT;
        plant.stage = 0;
        plant.grownAt = (performance.now?.() || Date.now()) + PLANT_GROW_MS;
        applyPlantStage(plant);
        floatText(`+${BUDS_PER_PLANT} buds`, plant.mesh.position.clone().setY(plant.mesh.position.y + 1.4), '#b6ff6a');
    }

    // ---- physics bagging: drag buds across the bench into the bag -------
    // Buds are real Jolt dynamic boxes resting on the bench. The cursor grabs
    // the nearest one (velocity-driven so a release throws it). Any bud that
    // overlaps the bag's trigger zone is packaged into the sellable stash.
    function makeBudMesh() {
        const geo = new THREE.IcosahedronGeometry(BUD_SIZE, 0);
        const mat = new THREE.MeshStandardMaterial({ color: '#5fae3a', roughness: 0.7, emissive: '#234d12', emissiveIntensity: 0.25 });
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = true;
        return m;
    }
    function ensureBag(s, layout) {
        if (s.bagMesh || !Array.isArray(layout.packagingBench)) return;
        const { scene } = core;
        const b = layout.packagingBench;
        // Bag sits on the bench top, offset to one side so there's room to drag.
        s.bagPos = [b[0] - 1.3, b[1] + 0.5, b[2]];
        const g = new THREE.Group();
        const bagMat = new THREE.MeshStandardMaterial({ color: '#caa15a', roughness: 0.6, emissive: '#7a5a20', emissiveIntensity: 0.3 });
        const body = new THREE.Mesh(new THREE.BoxGeometry(BAG_HALF[0] * 2, BAG_HALF[1] * 2, BAG_HALF[2] * 2), bagMat);
        body.castShadow = true;
        g.add(body);
        // Glowing rim so the open mouth reads as the target.
        const rim = new THREE.Mesh(
            new THREE.TorusGeometry(BAG_HALF[0] * 0.8, 0.05, 8, 20),
            new THREE.MeshBasicMaterial({ color: 0x9dffa0, transparent: true, opacity: 0.85, toneMapped: false }),
        );
        rim.rotation.x = Math.PI / 2;
        rim.position.y = BAG_HALF[1];
        g.add(rim);
        g.position.set(s.bagPos[0], s.bagPos[1], s.bagPos[2]);
        scene?.add(g);
        s.bagMesh = g;
    }
    function spawnPhysBud(s, layout) {
        if (!physics?.ready || !physics.Jolt) return false;
        if (s.buds <= 0) return false;
        const { Jolt, bodyInterface } = physics;
        const { scene } = core;
        const b = layout.packagingBench;
        if (!Array.isArray(b)) return false;
        // Spawn on the far side of the bench so you have to drag it across.
        const x = b[0] + 1.1 + (Math.random() - 0.5) * 0.4;
        const y = b[1] + 0.7;
        const z = b[2] + (Math.random() - 0.5) * 0.6;

        const mesh = makeBudMesh();
        mesh.position.set(x, y, z);
        scene?.add(mesh);

        const half = new Jolt.Vec3(BUD_SIZE, BUD_SIZE, BUD_SIZE);
        const shapeSettings = new Jolt.BoxShapeSettings(half);
        const shapeResult = shapeSettings.Create();
        const shape = shapeResult.Get();
        shape.AddRef();
        shapeResult.Clear();
        Jolt.destroy(shapeResult);
        Jolt.destroy(shapeSettings);
        Jolt.destroy(half);

        const pos = new Jolt.RVec3(x, y, z);
        const rot = new Jolt.Quat(0, 0, 0, 1);
        const settings = new Jolt.BodyCreationSettings(shape, pos, rot, Jolt.EMotionType_Dynamic, 1 /* movingLayer */);
        settings.mFriction = 0.6;
        settings.mRestitution = 0.15;
        settings.mLinearDamping = 0.5;
        settings.mAngularDamping = 0.7;
        const body = bodyInterface.CreateBody(settings);
        bodyInterface.AddBody(body.GetID(), Jolt.EActivation_Activate);
        Jolt.destroy(settings);
        Jolt.destroy(pos);
        Jolt.destroy(rot);

        s.physBuds.push({ mesh, body });
        s.buds -= 1;
        return true;
    }
    function destroyPhysBud(s, bud) {
        const { scene } = core;
        try { scene?.remove(bud.mesh); } catch (e) {}
        if (physics?.Jolt && bud.body) {
            try {
                physics.bodyInterface.RemoveBody(bud.body.GetID());
                physics.bodyInterface.DestroyBody(bud.body.GetID());
            } catch (e) {}
        }
        const i = s.physBuds.indexOf(bud);
        if (i >= 0) s.physBuds.splice(i, 1);
        if (s.grabbed === bud) s.grabbed = null;
    }
    function clearPhysBuds(s) {
        for (const bud of [...(s.physBuds || [])]) destroyPhysBud(s, bud);
        const { scene } = core;
        if (s.bagMesh) { try { scene?.remove(s.bagMesh); } catch (e) {} s.bagMesh = null; }
        s.bagPos = null;
        s.grabbed = null;
    }

    const _grabCamPos = new THREE.Vector3();
    const _grabCamDir = new THREE.Vector3();
    const _grabTarget = new THREE.Vector3();
    const _budPos = new THREE.Vector3();
    function updatePhysBagging(s, dt) {
        if (!physics?.ready || !physics.Jolt) return;
        const { Jolt, bodyInterface } = physics;
        const { camera } = core;

        // 1) Sync every bud mesh to its body.
        for (const bud of s.physBuds) {
            const p = bud.body.GetPosition();
            const q = bud.body.GetRotation();
            bud.mesh.position.set(p.GetX(), p.GetY(), p.GetZ());
            bud.mesh.quaternion.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
        }

        // 2) Grab handling. Hold Fire to grab the bud under the cursor; release
        //    to let go (velocity persists, so you can fling it).
        const holding = !!gameplay.input?.fire;
        if (camera) {
            camera.getWorldPosition(_grabCamPos);
            camera.getWorldDirection(_grabCamDir).normalize();
        }
        if (holding && !s.grabbed && camera) {
            // Pick nearest bud within range of the aim ray.
            let best = null, bestScore = -Infinity;
            for (const bud of s.physBuds) {
                _budPos.copy(bud.mesh.position).sub(_grabCamPos);
                const dist = _budPos.length();
                if (dist > BUD_GRAB_RANGE || dist < 0.001) continue;
                _budPos.multiplyScalar(1 / dist);
                const dot = _budPos.dot(_grabCamDir);
                if (dot < 0.9) continue;          // must be roughly under the cursor
                if (dot > bestScore) { bestScore = dot; best = bud; }
            }
            s.grabbed = best;
        } else if (!holding && s.grabbed) {
            s.grabbed = null;                     // released — keep current velocity
        }

        // 3) Drive the grabbed bud toward a point in front of the camera using
        //    velocity (so the throw carries momentum on release).
        if (s.grabbed && camera) {
            _grabTarget.copy(_grabCamPos).addScaledVector(_grabCamDir, BUD_HOLD_DIST);
            const p = s.grabbed.body.GetPosition();
            const inv = 1 / Math.max(dt, 1 / 120);
            const vx = (_grabTarget.x - p.GetX()) * inv;
            const vy = (_grabTarget.y - p.GetY()) * inv;
            const vz = (_grabTarget.z - p.GetZ()) * inv;
            const v = new Jolt.Vec3(
                Math.max(-12, Math.min(12, vx)),
                Math.max(-12, Math.min(12, vy)),
                Math.max(-12, Math.min(12, vz)),
            );
            bodyInterface.SetLinearVelocity(s.grabbed.body.GetID(), v);
            Jolt.destroy(v);
            bodyInterface.ActivateBody(s.grabbed.body.GetID());
        }

        // 4) Bag overlap: any bud whose centre is inside the bag zone is
        //    packaged into the sellable stash at full purity, then despawned.
        if (s.bagPos) {
            for (const bud of [...s.physBuds]) {
                const dx = Math.abs(bud.mesh.position.x - s.bagPos[0]);
                const dy = Math.abs(bud.mesh.position.y - s.bagPos[1]);
                const dz = Math.abs(bud.mesh.position.z - s.bagPos[2]);
                if (dx < BAG_HALF[0] && dy < BAG_HALF[1] && dz < BAG_HALF[2]) {
                    const room = stashCap(s) - s.stash;
                    if (room > 0) { blendStashQuality(s, 1, 1); s.stash += 1; }
                    floatText('+1 bagged', new THREE.Vector3(...s.bagPos).setY(s.bagPos[1] + 0.6), '#9dffa0');
                    destroyPhysBud(s, bud);
                }
            }
        }
    }

    // ---- packaging bench: drag buds into a bag -------------------------
    let _bagEl = null;
    function openBagging() {
        const s = ensureState();
        if (s.baggingOpen) return;
        if (s.buds <= 0) { showPrompt('No buds — harvest first'); return; }
        s.baggingOpen = true;
        gameplay.roguePaused = true;
        try { document.exitPointerLock?.(); } catch (e) {}
        renderBagging();
    }
    // Each bag holds BUDS_PER_BAG buds; a filled bag becomes 1 stash unit.
    const BUDS_PER_BAG = 4;
    function renderBagging() {
        const s = ensureState();
        if (_bagEl?.parentNode) _bagEl.remove();
        // bagFill = buds already dropped into the open bag this session.
        if (typeof s._bagFill !== 'number') s._bagFill = 0;
        if (typeof s._bagged !== 'number') s._bagged = 0;

        const overlay = document.createElement('div');
        overlay.className = 'tycoon-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:1200;pointer-events:auto;'
            + 'background:rgba(4,10,8,0.85);backdrop-filter:blur(3px);display:flex;'
            + 'flex-direction:column;align-items:center;justify-content:center;'
            + 'font-family:"Trebuchet MS",system-ui,sans-serif;color:#eaffea;';
        // Stop the panel's drag events from bubbling up to the canvas
        // file-drop handler (which would pop the "drop a .glb/.fbx" model-loader
        // alert). Bubble phase (no capture) so the bag's own drop handler still
        // runs first; we just halt propagation to the container afterwards.
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((ev) => {
            overlay.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); });
        });

        const title = document.createElement('div');
        title.textContent = 'PACKAGING';
        title.style.cssText = 'font:900 30px/1.1 inherit;margin-bottom:6px;color:#9dffa0;'
            + 'text-shadow:0 0 18px rgba(60,255,120,0.5);';
        overlay.appendChild(title);
        const hint = document.createElement('div');
        hint.textContent = `Drag buds into the bag — ${BUDS_PER_BAG} buds = 1 sellable unit.`;
        hint.style.cssText = 'font:600 15px/1.3 inherit;opacity:.8;margin-bottom:22px;';
        overlay.appendChild(hint);

        const cols = document.createElement('div');
        cols.style.cssText = 'display:flex;gap:60px;align-items:flex-start;';

        // Left: loose buds tray (draggable items).
        const tray = document.createElement('div');
        tray.style.cssText = 'width:300px;';
        const trayTitle = document.createElement('div');
        trayTitle.textContent = `Buds: ${s.buds}`;
        trayTitle.style.cssText = 'font:800 18px/1 inherit;margin-bottom:10px;color:#cffac0;';
        tray.appendChild(trayTitle);
        const grid = document.createElement('div');
        grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;max-width:300px;';
        const showBuds = Math.min(s.buds, 24);
        for (let i = 0; i < showBuds; i++) {
            const bud = document.createElement('div');
            bud.draggable = true;
            bud.textContent = '🌿';
            bud.style.cssText = 'width:42px;height:42px;display:flex;align-items:center;justify-content:center;'
                + 'font-size:24px;cursor:grab;border-radius:10px;background:rgba(60,120,50,0.35);'
                + 'border:2px solid rgba(150,255,140,0.4);user-select:none;';
            bud.addEventListener('dragstart', (e) => {
                e.dataTransfer?.setData('text/plain', 'bud');
                bud.style.opacity = '0.4';
            });
            bud.addEventListener('dragend', () => { bud.style.opacity = '1'; });
            // Touch / click fallback: tap a bud to drop it in the bag.
            bud.addEventListener('click', () => dropBudInBag());
            grid.appendChild(bud);
        }
        tray.appendChild(grid);
        cols.appendChild(tray);

        // Right: the bag (drop target) + fill meter.
        const bagWrap = document.createElement('div');
        bagWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:12px;';
        const bag = document.createElement('div');
        bag.textContent = '🛍️';
        bag.style.cssText = 'width:160px;height:160px;display:flex;align-items:center;justify-content:center;'
            + 'font-size:84px;border-radius:18px;background:rgba(20,40,28,0.7);'
            + 'border:3px dashed rgba(150,255,160,0.6);transition:transform .12s,border-color .12s;';
        bag.addEventListener('dragover', (e) => { e.preventDefault(); bag.style.borderColor = '#9dffa0'; bag.style.transform = 'scale(1.05)'; });
        bag.addEventListener('dragleave', () => { bag.style.borderColor = 'rgba(150,255,160,0.6)'; bag.style.transform = 'none'; });
        bag.addEventListener('drop', (e) => {
            e.preventDefault();
            bag.style.borderColor = 'rgba(150,255,160,0.6)'; bag.style.transform = 'none';
            dropBudInBag();
        });
        bagWrap.appendChild(bag);
        const meter = document.createElement('div');
        meter.style.cssText = 'width:200px;height:18px;border-radius:9px;overflow:hidden;'
            + 'background:rgba(255,255,255,0.12);border:1px solid rgba(150,255,160,0.4);';
        const fill = document.createElement('div');
        fill.style.cssText = `height:100%;width:${(s._bagFill / BUDS_PER_BAG) * 100}%;`
            + 'background:linear-gradient(90deg,#3fbf5f,#9dffa0);transition:width .15s;';
        meter.appendChild(fill);
        bagWrap.appendChild(meter);
        const bagLbl = document.createElement('div');
        bagLbl.textContent = `Bag ${s._bagFill}/${BUDS_PER_BAG} · packaged ${s._bagged}`;
        bagLbl.style.cssText = 'font:700 14px/1 inherit;opacity:.85;';
        bagWrap.appendChild(bagLbl);
        cols.appendChild(bagWrap);
        overlay.appendChild(cols);

        // Done button: commit packaged bags into stash + close.
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:14px;margin-top:28px;';
        const done = document.createElement('button');
        done.textContent = 'DONE';
        done.style.cssText = 'padding:12px 30px;cursor:pointer;font:900 18px/1 inherit;color:#0a140e;'
            + 'border-radius:12px;background:linear-gradient(160deg,#9dffa0,#3fbf5f);'
            + 'border:2px solid rgba(0,0,0,0.25);';
        done.onclick = () => closeBagging();
        actions.appendChild(done);
        overlay.appendChild(actions);

        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        _bagEl = overlay;
    }
    function dropBudInBag() {
        const s = ensureState();
        if (s.buds <= 0) return;
        s.buds -= 1;
        s._bagFill = (s._bagFill || 0) + 1;
        if (s._bagFill >= BUDS_PER_BAG) {
            s._bagFill = 0;
            s._bagged = (s._bagged || 0) + 1;
        }
        renderBagging();
    }
    function closeBagging() {
        const s = window.drugTycoon;
        if (_bagEl?.parentNode) _bagEl.remove();
        _bagEl = null;
        if (s) {
            // Commit fully-packaged bags into the sellable stash at full purity
            // (fresh, hand-trimmed flower).
            const room = stashCap(s) - s.stash;
            const added = Math.min(room, s._bagged || 0);
            if (added > 0) { blendStashQuality(s, added, 1); s.stash += added; }
            s._bagged = 0;
            s.baggingOpen = false;
        }
        gameplay.roguePaused = false;
        const { renderer } = core;
        if (renderer?.domElement && !window.matchMedia?.('(pointer:coarse)')?.matches) {
            const resume = () => {
                renderer.domElement.removeEventListener('click', resume);
                try { renderer.domElement.requestPointerLock?.(); } catch (e) {}
            };
            renderer.domElement.addEventListener('click', resume);
        }
    }

    // ---- per-frame driver ----------------------------------------------
    function updateDrugTycoonState(playerPos, delta = 0.016) {
        const { currentMesh } = core;
        if (currentMesh?.userData?.sampleType !== 'drugTycoon') return;
        installInteractKey();
        const s = ensureState();
        const layout = currentMesh.userData.drugTycoonLevel || {};
        const dt = Math.min(0.05, Math.max(0.001, delta));

        // Drive any active ragdolls (Jolt-synced + the non-physics fallback)
        // every frame regardless of pause so they finish their fall + expire.
        ragdoll.update();
        ragdoll.updateFallback(dt);

        // First-time setup once the player exists.
        if (!s.started && playerPos) {
            s.started = true;
            if (Array.isArray(layout.cookStation)) s.cookPos.set(...layout.cookStation);
            if (Array.isArray(layout.upgradePad)) s.upgradePos.set(...layout.upgradePad);
            // The pistol is bought at the upgrade desk now — no free yard pickup.
            ensurePlants(s, layout);
            const target = maxBuyers(s);
            for (let i = 0; i < target; i++) spawnBuyer(s, layout);
            pickOrder(s);   // first phone order, from a live buyer
            sendPlayerHome(s);   // start the run inside the house
        }

        updateTracers();
        updateMuzzleFlash();
        updatePlants(s);
        advanceDayNight(s, dt);   // sun/sky animate even in menus / grow room

        if (s.shopOpen || s.cooking || s.baggingOpen || s.helpOpen) { stopSiren(); if (s.phoneOpen) setPhone(false); updateHud(); return; } // sim frozen in a menu
        if (!playerPos) return;

        // ---- inside the grow room: separate interaction set ------------
        if (s.inRoom) {
            stopSiren();                        // no sirens audible indoors
            if (s.phoneOpen) setPhone(false);   // pocket the phone indoors
            const interactR = consumeInteract();
            let promptR = '';
            // Bag + physics buds live + tick every frame so thrown buds keep
            // flying and grabbed ones follow the cursor even mid-room.
            ensureBag(s, layout);
            updatePhysBagging(s, dt);
            // Harvest the nearest ripe plant.
            let bestPlant = null, bestPd = 2.4;
            for (const p of s.plants) {
                if (!p.mesh) continue;
                const d = Math.hypot(p.mesh.position.x - playerPos.x, p.mesh.position.z - playerPos.z);
                if (d < bestPd) { bestPd = d; bestPlant = p; }
            }
            const bench = layout.packagingBench;
            const dBench = Array.isArray(bench)
                ? Math.hypot(bench[0] - playerPos.x, bench[2] - playerPos.z) : Infinity;
            const exit = layout.growExitDoor;
            const dExit = Array.isArray(exit)
                ? Math.hypot(exit[0] - playerPos.x, exit[2] - playerPos.z) : Infinity;
            const bed = layout.bed;
            const dBed = Array.isArray(bed)
                ? Math.hypot(bed[0] - playerPos.x, bed[2] - playerPos.z) : Infinity;
            const upg = layout.upgradePad;
            const dUpgR = Array.isArray(upg)
                ? Math.hypot(upg[0] - playerPos.x, upg[2] - playerPos.z) : Infinity;

            if (dExit < DOOR_RADIUS) {
                promptR = '[E] Leave house';
                if (interactR && Array.isArray(layout.homeDoor)) {
                    s.inRoom = false;
                    teleportPlayer([layout.homeDoor[0], layout.homeDoor[1], layout.homeDoor[2]]);
                }
            } else if (dBed < 2.4) {
                promptR = '[E] Sleep until morning';
                if (interactR) sleepInBed(s);
            } else if (dUpgR < 2.6) {
                promptR = '[E] Open upgrades';
                if (interactR) openShop();
            } else if (dBench < 2.6) {
                // Drop a physics bud on the bench; hold Fire to drag it across
                // into the bag. Any bud reaching the bag is packaged.
                if (s.buds > 0) {
                    promptR = `[E] Drop a bud (${s.buds}) · hold Fire to drag into bag`;
                    if (interactR) spawnPhysBud(s, layout);
                } else if (s.physBuds.length > 0) {
                    promptR = 'Drag buds into the bag (hold Fire)';
                } else {
                    promptR = 'Harvest buds first';
                }
            } else if (bestPlant) {
                if (bestPlant.stage >= PLANT_STAGES) {
                    promptR = '[E] Harvest plant';
                    if (interactR) harvestPlant(s, bestPlant);
                } else {
                    const left = Math.ceil((bestPlant.grownAt - (performance.now?.() || Date.now())) / 1000);
                    promptR = `Growing… stage ${bestPlant.stage + 1}/${PLANT_STAGES} (${left}s)`;
                }
            }
            if (promptR) showPrompt(promptR); else hidePrompt();
            updateHud();
            return;
        }

        // Attack on Fire (left mouse): pistol if owned + loaded, else swing the
        // bat if owned. Each has its own cooldown.
        if (gameplay.input?.fire) {
            if (s.hasGun && s.ammo > 0) tryShoot(s, layout);
            else if (s.hasBat) trySwingBat(s, layout);
            else if (s.hasGun) tryShoot(s, layout);   // dry-click feedback
        }

        // Heat decays passively.
        if (s.heat > 0) s.heat = Math.max(0, s.heat - HEAT_DECAY_PER_SEC * dt);

        // Top up buyers to the upgrade-driven cap.
        while (s.npcs.length < maxBuyers(s)) spawnBuyer(s, layout);

        // Wander buyers.
        for (const n of s.npcs) {
            if (!n.mesh) continue;
            if (moveToward(n.mesh, n.target, NPC_WANDER_SPEED, dt, layout)) {
                n.target = randomStreetPoint(layout);
            }
        }

        // Night patrol cops: spawn + wander the streets after dark, chase on
        // sight (or when heat is already high).
        updatePatrol(s, layout, playerPos, dt);

        // Police: count + chase speed scale with the wanted-star level.
        const stars = wantedStars(s);
        if (stars >= 1) {
            const wantCops = copsForStars(stars);
            while (s.police.length < wantCops) spawnPolice(s, layout);
            const chaseSpeed = chaseSpeedForStars(stars);
            const playerVec = _tmpProj.set(playerPos.x, layout.spawnY ?? 0, playerPos.z);
            for (const cop of s.police) {
                if (!cop.mesh) continue;
                moveToward(cop.mesh, playerVec, chaseSpeed, dt, layout);
                const cd = Math.hypot(cop.mesh.position.x - playerPos.x, cop.mesh.position.z - playerPos.z);
                if (cd < BUST_RADIUS) { bustPlayer(s, cop); }
            }
        } else {
            // Calmed down (0 stars): police give up + leave.
            for (const cop of s.police) { try { core.scene?.remove(cop.mesh); } catch (e) {} }
            s.police.length = 0;
        }

        // Police siren swells as the nearest cop closes in.
        updateSiren(s, playerPos);

        // Keep the open phone's order in sync with the live buyers.
        if (s.phoneOpen) { ensureOrder(s); renderPhone(); }

        // Proximity-driven interactions: nearest of cook/upgrade/buyer.
        const interact = consumeInteract();
        let prompt = '';

        // Cook station.
        const dCook = s.cookPos.distanceTo(_tmpProj.set(playerPos.x, s.cookPos.y, playerPos.z));

        // Home door: enter the grow room.
        const home = layout.homeDoor;
        const dHome = Array.isArray(home)
            ? Math.hypot(home[0] - playerPos.x, home[2] - playerPos.z) : Infinity;

        if (dHome < DOOR_RADIUS) {
            prompt = '[E] Enter house (grow room)';
            if (interact && Array.isArray(layout.growRoomSpawn)) {
                s.inRoom = true;
                teleportPlayer([...layout.growRoomSpawn]);
                hidePrompt();
                updateHud();
                return;
            }
        } else if (dCook < STATION_RADIUS) {
            if (s.stash >= stashCap(s)) {
                prompt = 'Stash full — go sell';
            } else {
                prompt = '[E] Cook a batch';
                if (interact) openCook();
            }
        } else {
            // Find nearest buyer in range.
            let best = null, bestD = SELL_RADIUS;
            for (const n of s.npcs) {
                if (!n.mesh || !n.wantsBuy) continue;
                const d = Math.hypot(n.mesh.position.x - playerPos.x, n.mesh.position.z - playerPos.z);
                if (d < bestD) { bestD = d; best = n; }
            }
            if (best) {
                ensureOrder(s);
                const isOrder = best.shirtColor === s.orderColor;
                if (s.stash <= 0) {
                    prompt = 'No product — go cook';
                } else if (!isOrder) {
                    prompt = `Wrong customer — check phone [P] (want ${colorName(s.orderColor)})`;
                } else {
                    prompt = `[E] Deal to ${colorName(best.shirtColor)} customer`;
                    if (interact) sellTo(s, best);
                }
            }
        }

        if (prompt) showPrompt(prompt); else hidePrompt();
        updateHud();
    }

    function sellTo(s, npc) {
        const sellQty = Math.min(s.stash, 1 + s.up.batch); // sell a small bundle
        if (sellQty <= 0) return;
        s.stash -= sellQty;
        const gross = sellQty * unitPrice(s);
        s.cash += gross;
        s.sales += 1;
        s.heat = Math.min(160, s.heat + heatPerSale(s));
        if (npc.mesh) {
            const wp = npc.mesh.getWorldPosition(new THREE.Vector3());
            floatText(`+$${gross}`, wp.clone(), '#9dffa0');
            // Buyer says thanks (a beat above the cash so both read).
            const line = SELL_THANKS[(Math.random() * SELL_THANKS.length) | 0];
            floatText(line, wp.clone().setY(wp.y + 2.0), '#cfe8ff');
            playSfx('cash', wp.clone());     // cha-ching
        }
        // Buyer leaves, a fresh one wanders in.
        try { core.scene?.remove(npc.mesh); } catch (e) {}
        const idx = s.npcs.indexOf(npc);
        if (idx >= 0) s.npcs.splice(idx, 1);
        // Order fulfilled — line up the next one and refresh the phone.
        s.ordersFilled += 1;
        pickOrder(s);
        if (s.phoneOpen) renderPhone();
    }

    function bustPlayer(s, cop) {
        const fine = Math.min(s.cash, BUST_FINE);
        s.cash -= fine;
        // Lose ALL product you're holding: sellable stash, loose buds, and any
        // physics buds out on the bench.
        s.stash = 0;
        s.buds = 0;
        try { clearPhysBuds(s); } catch (e) {}
        s.heat = 0;           // heat resets after a bust
        s.busted += 1;
        if (cop?.mesh) {
            const cp = cop.mesh.getWorldPosition(new THREE.Vector3());
            floatText(`BUSTED -$${fine} · lost stash`, cp.clone().setY(cp.y + 1.9), '#ff5555');
        }
        // Light health knock so it stings; never lethal.
        try { setPlayerHealth(Math.max(0.35, (gameplay.health ?? 1) - 0.25)); } catch (e) {}
        // Ragdoll every cop on the scene (heat cops + night patrol) — you barge
        // through them. Shove each away from the player so they tumble outward.
        for (const c of [...s.police, ...s.patrol]) {
            if (!c.mesh) continue;
            // Shove outward from arena center so cops tumble away.
            const px = c.mesh.position.x, pz = c.mesh.position.z;
            const len = Math.hypot(px, pz) || 1;
            ragdoll.ragdollify(c.mesh, { x: (px / len) * 6, y: 3, z: (pz / len) * 6 });
        }
        s.police.length = 0;
        s.patrol.length = 0;

        // Released the next morning, back home (inside the house). Skip time to
        // just after dawn so it's daytime + safe.
        s.timeOfDay = 0.02;
        if (s.phoneOpen) setPhone(false);
        sendPlayerHome(s);
        showPrompt('Busted. Released the next morning — home, stash gone.');
    }

    // Put the player inside their house (the grow room) and reset room lighting
    // to day. Used on bust and at the start of a run.
    function sendPlayerHome(s) {
        const layout = core.currentMesh?.userData?.drugTycoonLevel || {};
        const spawn = Array.isArray(layout.growRoomSpawn) ? layout.growRoomSpawn
            : (Array.isArray(layout.playerSpawn) ? layout.playerSpawn : null);
        if (!spawn) return;
        s.inRoom = true;
        teleportPlayer([spawn[0], spawn[1] ?? 0.85, spawn[2]]);
        _roomNightState = false;
        try { applyRoomLighting(false); } catch (e) {}
    }

    // ---- window surface -------------------------------------------------
    if (typeof window !== 'undefined') {
        window.drugTycoonApi = {
            ensureState, resetState, updateDrugTycoonState, openCook, closeCook, openShop, closeShop, openBagging, closeBagging, togglePhone, toggleHelp, queueInteract,
        };
        window.resetDrugTycoonState = resetState;
    }

    return {
        ensureState, resetState, updateDrugTycoonState, openCook, closeCook, openShop, closeShop, openBagging, closeBagging, togglePhone, toggleHelp, queueInteract,
    };
}
