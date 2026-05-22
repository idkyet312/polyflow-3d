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
const GUN_FIRE_COOLDOWN_MS = 280;  // pistol cadence
const GUN_RANGE = 60;              // max shoot distance
const GUN_AIM_DOT = 0.985;        // aim cone tightness (cos angle)
const GUN_IMPULSE = 9;            // ragdoll shove strength

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
            hasGun: false,        // player picked up the pistol
            gunPickupMesh: null,  // floating pickup on the pedestal
            nextShotAt: 0,        // shoot cooldown
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
        }
        if (s?.gunPickupMesh) { try { scene?.remove(s.gunPickupMesh); } catch (e) {} }
        detachHeldGun();
        for (const t of _tracers) { try { scene?.remove(t.line); } catch (e) {} }
        _tracers.length = 0;
        window.drugTycoon = defaultState();
        try { ragdoll.removeAll(); } catch (e) {}
        closeCook();
        closeShop();
        document.querySelectorAll('.tycoon-overlay').forEach((n) => n.remove());
        _hudEl = null;
        _shopEl = null;
        _cookEl = null;
        _promptEl = null;
        _floatLayer = null;
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

    // ---- interact key (on-foot E edge) ----------------------------------
    let _interactQueued = false;
    let _keyHandler = null;
    function installInteractKey() {
        if (_keyHandler || typeof window === 'undefined') return;
        _keyHandler = (e) => {
            if (e.repeat) return;
            if (e.code === 'KeyE') _interactQueued = true;
            if (e.code === 'Escape' && window.drugTycoon?.shopOpen) closeShop();
            if (e.code === 'Escape' && window.drugTycoon?.cooking) closeCook();
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
        if (!inLevel) { if (_hudEl) _hudEl.style.display = 'none'; return; }
        const s = ensureState();
        const el = ensureHud();
        el.style.display = 'block';
        const heatPct = Math.min(100, Math.round(s.heat));
        const heatColor = s.heat >= HEAT_BUST_THRESHOLD ? '#ff4d4d' : s.heat > 60 ? '#ffae00' : '#7fe0ff';
        el.innerHTML =
            `<div style="font-size:22px;color:#9dffa0;">$${Math.floor(s.cash).toLocaleString()}</div>`
            + `<div>Product: ${s.stash} / ${stashCap(s)}${s.stash > 0 ? ` · ${Math.round(s.stashQ * 100)}% pure` : ''}</div>`
            + `<div style="color:${heatColor};">Heat: ${heatPct}%${s.heat >= HEAT_BUST_THRESHOLD ? '  ⚠ POLICE' : ''}</div>`
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
        const group = ragdoll.makePerson({
            skinColor: randomFrom(SKIN_TONES),
            shirtColor: randomFrom(SHIRT_TONES),
            pantsColor: '#22303c',
        });
        const radius = layout.streetRadius ?? 16;
        const ang = Math.random() * Math.PI * 2;
        placePerson(group, Math.cos(ang) * radius, layout.spawnY ?? 0, Math.sin(ang) * radius);
        const npc = { mesh: group, target: randomStreetPoint(layout), wantsBuy: true };
        s.npcs.push(npc);
        return npc;
    }
    function spawnPolice(s, layout) {
        const group = ragdoll.makePerson({
            skinColor: randomFrom(SKIN_TONES),
            shirtColor: '#1d4ed8',   // police blue
            pantsColor: '#0b1b3a',
        });
        const radius = (layout.streetRadius ?? 16) + 4;
        const ang = Math.random() * Math.PI * 2;
        placePerson(group, Math.cos(ang) * radius, layout.spawnY ?? 0, Math.sin(ang) * radius);
        const cop = { mesh: group };
        s.police.push(cop);
        return cop;
    }
    function randomStreetPoint(layout) {
        const r = (layout.streetRadius ?? 16) * (0.3 + Math.random() * 0.7);
        const ang = Math.random() * Math.PI * 2;
        return new THREE.Vector3(Math.cos(ang) * r, layout.spawnY ?? 0, Math.sin(ang) * r);
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

        // Aim-cone hit test against living people (buyers + police). Pick the
        // closest target inside the cone and within range.
        const targets = s.npcs.concat(s.police);
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

        // Tiny camera kick.
        if (gameplay.hitFeedback) gameplay.hitFeedback.shake = Math.max(gameplay.hitFeedback.shake || 0, 0.35);

        if (best) {
            // Ragdoll it, shoved along the shot direction.
            const dir = _camDir.clone();
            ragdoll.ragdollify(best.mesh, { x: dir.x * GUN_IMPULSE, y: 3.5, z: dir.z * GUN_IMPULSE });
            floatText('DOWN', end.clone().setY(end.y + 0.4), '#ff7070');
            // Remove from the live list it belonged to.
            let idx = s.npcs.indexOf(best);
            if (idx >= 0) { s.npcs.splice(idx, 1); }
            else { idx = s.police.indexOf(best); if (idx >= 0) s.police.splice(idx, 1); }
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
            if (Array.isArray(layout.gunPickup)) s.gunPos.set(...layout.gunPickup);
            spawnGunPickup(s, layout);
            const target = maxBuyers(s);
            for (let i = 0; i < target; i++) spawnBuyer(s, layout);
        }

        updateTracers();
        if (s.gunPickupMesh) s.gunPickupMesh.rotation.y += dt * 1.5; // spin the pickup

        if (s.shopOpen || s.cooking) { updateHud(); return; } // sim frozen in a menu
        if (!playerPos) return;

        // Shooting: hold left mouse / Fire while armed. Uses its own cooldown.
        if (s.hasGun && gameplay.input?.fire) {
            tryShoot(s, layout);
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

        // Police: spawn + hunt when heat is high.
        if (s.heat >= HEAT_BUST_THRESHOLD) {
            const wantCops = 1 + Math.floor((s.heat - HEAT_BUST_THRESHOLD) / 40);
            while (s.police.length < Math.min(4, wantCops)) spawnPolice(s, layout);
            const playerVec = _tmpProj.set(playerPos.x, layout.spawnY ?? 0, playerPos.z);
            for (const cop of s.police) {
                if (!cop.mesh) continue;
                moveToward(cop.mesh, playerVec, POLICE_SPEED, dt, layout);
                const cd = Math.hypot(cop.mesh.position.x - playerPos.x, cop.mesh.position.z - playerPos.z);
                if (cd < BUST_RADIUS) { bustPlayer(s, cop); }
            }
        } else {
            // Calmed down: police give up + leave.
            for (const cop of s.police) { try { core.scene?.remove(cop.mesh); } catch (e) {} }
            s.police.length = 0;
        }

        // Proximity-driven interactions: nearest of cook/upgrade/buyer.
        const interact = consumeInteract();
        let prompt = '';

        // Cook station.
        const dCook = s.cookPos.distanceTo(_tmpProj.set(playerPos.x, s.cookPos.y, playerPos.z));
        const dUpg = s.upgradePos.distanceTo(_tmpProj.set(playerPos.x, s.upgradePos.y, playerPos.z));
        const dGun = s.gunPos.distanceTo(_tmpProj.set(playerPos.x, s.gunPos.y, playerPos.z));

        // Gun pickup takes priority when standing on the pedestal.
        if (!s.hasGun && s.gunPickupMesh && dGun < STATION_RADIUS) {
            prompt = '[E] Pick up pistol';
            if (interact) {
                s.hasGun = true;
                try { core.scene?.remove(s.gunPickupMesh); } catch (e) {}
                s.gunPickupMesh = null;
                attachHeldGun();
                floatText('PISTOL', s.gunPos.clone().setY(s.gunPos.y + 0.6), '#fff3a0');
            }
            showPrompt(prompt);
            updateHud();
            return;
        }

        if (dCook < STATION_RADIUS) {
            if (s.stash >= stashCap(s)) {
                prompt = 'Stash full — go sell';
            } else {
                prompt = '[E] Cook a batch';
                if (interact) openCook();
            }
        } else if (dUpg < STATION_RADIUS) {
            prompt = '[E] Open upgrades';
            if (interact) openShop();
        } else {
            // Find nearest buyer in range.
            let best = null, bestD = SELL_RADIUS;
            for (const n of s.npcs) {
                if (!n.mesh || !n.wantsBuy) continue;
                const d = Math.hypot(n.mesh.position.x - playerPos.x, n.mesh.position.z - playerPos.z);
                if (d < bestD) { bestD = d; best = n; }
            }
            if (best) {
                if (s.stash <= 0) {
                    prompt = 'No product — go cook';
                } else {
                    prompt = '[E] Sell to customer';
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
        if (npc.mesh) floatText(`+$${gross}`, npc.mesh.getWorldPosition(new THREE.Vector3()), '#9dffa0');
        // Buyer leaves, a fresh one wanders in.
        try { core.scene?.remove(npc.mesh); } catch (e) {}
        const idx = s.npcs.indexOf(npc);
        if (idx >= 0) s.npcs.splice(idx, 1);
    }

    function bustPlayer(s, cop) {
        const fine = Math.min(s.cash, BUST_FINE);
        s.cash -= fine;
        s.stash = 0;          // lose the stash
        s.heat = 0;           // heat resets after a bust
        s.busted += 1;
        if (cop?.mesh) {
            const cp = cop.mesh.getWorldPosition(new THREE.Vector3());
            floatText(`BUSTED -$${fine}`, cp.clone().setY(cp.y + 1.9), '#ff5555');
        }
        // Light health knock so it stings; never lethal.
        try { setPlayerHealth(Math.max(0.35, (gameplay.health ?? 1) - 0.25)); } catch (e) {}
        // Ragdoll every cop on the scene — you barge through them. Shove each
        // away from the player so they tumble outward.
        for (const c of s.police) {
            if (!c.mesh) continue;
            // Shove outward from arena center so cops tumble away.
            const px = c.mesh.position.x, pz = c.mesh.position.z;
            const len = Math.hypot(px, pz) || 1;
            ragdoll.ragdollify(c.mesh, { x: (px / len) * 6, y: 3, z: (pz / len) * 6 });
        }
        s.police.length = 0;
    }

    // ---- window surface -------------------------------------------------
    if (typeof window !== 'undefined') {
        window.drugTycoonApi = {
            ensureState, resetState, updateDrugTycoonState, openCook, closeCook, openShop, closeShop, queueInteract,
        };
        window.resetDrugTycoonState = resetState;
    }

    return {
        ensureState, resetState, updateDrugTycoonState, openCook, closeCook, openShop, closeShop, queueInteract,
    };
}
