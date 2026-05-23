// Shooting Simulator — a self-contained firing-range game mode on its own level
// (sampleType 'shootingSim'). Same isolation pattern as drugTycoon/rogueWaves:
// runtime.js calls createShootingSim({...deps}) once and the frame loop calls
// the returned updateShootingSimState(playerPos, delta) every frame.
//
// The range builds a row of lanes downrange. Targets are hit-tested here with a
// camera raycast on Fire (independent of the engine's enemy/projectile system),
// so the mode is fully self-driving:
//   • Bullseye plates  — score by ring (10 / 8 / 5 / 2), they spin + flash.
//   • Pop-up silhouettes — knock down on hit, auto-reset after a delay.
//   • Movers           — slide side-to-side; harder, worth more.
// Modes: PRACTICE (free, infinite) and TIME ATTACK (60s, chase a high score).
// Tracks score, shots, hits, accuracy, streak, and best score (localStorage).
import * as THREE from 'three';
import { core } from '../runtime/appCore.js';

const FIRE_COOLDOWN_MS = 110;     // semi-auto cadence cap
const HIT_RANGE = 200;            // max ray distance
const TIME_ATTACK_SEC = 60;       // round length
const POPUP_RESET_MS = 1400;      // knocked-down silhouette stands back up
const PLATE_HIT_FLASH_MS = 180;   // ring flash duration
const SAVE_KEY = 'polyflow.shootingSim.best.v1';

// Bullseye ring scoring: [worldRadius, points, color]. Inner = more points.
const RINGS = [
    [0.18, 10, '#ffd24a'],
    [0.38, 8, '#ff7a3a'],
    [0.62, 5, '#7fd0ff'],
    [0.90, 2, '#9aa3b2'],
];

export function createShootingSim(deps) {
    const { gameplay } = deps;

    // ---- run state ------------------------------------------------------
    function defaultState() {
        return {
            started: false,
            mode: 'practice',     // 'practice' | 'timeAttack'
            score: 0,
            shots: 0,
            hits: 0,
            streak: 0,
            bestStreak: 0,
            best: 0,              // best time-attack score (persisted)
            roundActive: false,   // a time-attack round is running
            roundEndsAt: 0,
            targets: [],          // { mesh, type, ... }
            nextShotAt: 0,
            lastHitText: '',
        };
    }
    function ensureState() {
        if (!window.shootingSim) window.shootingSim = defaultState();
        return window.shootingSim;
    }
    function loadBest() {
        try { return parseInt(localStorage.getItem(SAVE_KEY) || '0', 10) || 0; } catch (e) { return 0; }
    }
    function saveBest(v) { try { localStorage.setItem(SAVE_KEY, String(v)); } catch (e) {} }

    function resetState() {
        const { scene } = core;
        const s = window.shootingSim;
        if (s) {
            for (const t of s.targets) { try { scene?.remove(t.group); } catch (e) {} }
        }
        for (const tr of _tracers) { try { scene?.remove(tr.line); } catch (e) {} }
        _tracers.length = 0;
        destroyAudio();
        window.shootingSim = defaultState();
        window.shootingSim.best = loadBest();
        document.querySelectorAll('.shootsim-overlay').forEach((n) => n.remove());
        _hudEl = null; _promptEl = null; _floatLayer = null; _menuEl = null;
        installKeys();
    }

    // ---- input: Esc / mode keys -----------------------------------------
    let _keyHandler = null;
    function installKeys() {
        if (_keyHandler || typeof window === 'undefined') return;
        _keyHandler = (e) => {
            if (e.repeat) return;
            const s = window.shootingSim;
            if (!s) return;
            if (e.code === 'KeyR') startTimeAttack(s);          // R = start/restart round
            if (e.code === 'KeyM') openMenu();                  // M = mode menu
            if (e.code === 'Escape' && s.menuOpen) closeMenu();
        };
        window.addEventListener('keydown', _keyHandler);
    }

    // ---- target factory -------------------------------------------------
    // Reflective chrome stand (SSR-friendly: low roughness + high metalness).
    const _standMat = () => new THREE.MeshStandardMaterial({ color: '#cdd6e3', roughness: 0.18, metalness: 0.9 });
    // A small reflective base disc grounds each stand (catches floor reflections).
    function addStand(group, height) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, height, 12), _standMat());
        post.position.y = height * 0.5;
        post.castShadow = true;
        group.add(post);
        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.06, 16), _standMat());
        base.position.y = 0.03;
        base.castShadow = true; base.receiveShadow = true;
        group.add(base);
    }

    // A bullseye plate: concentric ring discs on a chrome stand. The rings have a
    // slight emissive so they pop under bloom; a glossy backing plate reflects.
    function makeBullseye() {
        const group = new THREE.Group();
        addStand(group, 1.5);
        const faceGrp = new THREE.Group();
        faceGrp.position.y = 1.5;
        // Glossy dark backing plate behind the rings → SSR catcher + AO contact.
        const backing = new THREE.Mesh(
            new THREE.CylinderGeometry(1.0, 1.0, 0.06, 40),
            new THREE.MeshStandardMaterial({ color: '#0c0e12', roughness: 0.25, metalness: 0.5 }),
        );
        backing.rotation.x = Math.PI / 2;
        backing.position.z = -0.04;
        backing.castShadow = true; backing.receiveShadow = true;
        faceGrp.add(backing);
        // Draw rings outer→inner so inner sits on top.
        for (let i = RINGS.length - 1; i >= 0; i--) {
            const [r, , col] = RINGS[i];
            const disc = new THREE.Mesh(
                new THREE.CircleGeometry(r, 40),
                new THREE.MeshStandardMaterial({
                    color: col, roughness: 0.35, metalness: 0.1,
                    side: THREE.DoubleSide, emissive: new THREE.Color(col),
                    emissiveIntensity: i === 0 ? 0.6 : 0.18,   // bullseye glows most
                }),
            );
            disc.position.z = 0.01 * (RINGS.length - i);
            faceGrp.add(disc);
        }
        group.add(faceGrp);
        group.userData.faceGrp = faceGrp;
        return { group, faceGrp, type: 'plate' };
    }

    // A human-ish silhouette plate (matte composite) on a chrome stand, glowing
    // center scoring zone. Falls back on hit then stands up.
    function makeSilhouette() {
        const group = new THREE.Group();
        addStand(group, 0.6);
        const mat = new THREE.MeshStandardMaterial({ color: '#c2502f', roughness: 0.55, metalness: 0.15 });
        const board = new THREE.Group();
        board.position.y = 0.6;
        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.0, 0.07), mat);
        torso.position.y = 0.5;
        torso.castShadow = true; torso.receiveShadow = true;
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.07), mat);
        head.position.y = 1.18;
        head.castShadow = true;
        board.add(torso); board.add(head);
        // Glowing center scoring zone (bloom + clear aim point).
        const zone = new THREE.Mesh(
            new THREE.CircleGeometry(0.22, 28),
            new THREE.MeshStandardMaterial({ color: '#f6f9ff', roughness: 0.4, emissive: '#aee4ff', emissiveIntensity: 0.7 }),
        );
        zone.position.set(0, 0.55, 0.06);
        board.add(zone);
        board.userData.zone = zone;
        group.add(board);
        group.userData.board = board;
        return { group, board, type: 'popup', down: false, resetAt: 0 };
    }

    // A glowing teal mover plate on a chrome stand that slides along X.
    function makeMover() {
        const group = new THREE.Group();
        addStand(group, 1.4);
        const plate = new THREE.Mesh(
            new THREE.CylinderGeometry(0.32, 0.32, 0.05, 32),
            new THREE.MeshStandardMaterial({
                color: '#2dd4bf', roughness: 0.3, metalness: 0.2,
                emissive: '#15b8a6', emissiveIntensity: 0.85,
            }),
        );
        plate.rotation.x = Math.PI / 2;
        plate.position.y = 1.4;
        plate.castShadow = true;
        group.add(plate);
        return { group, plate, type: 'mover', t: Math.random() * Math.PI * 2, span: 3.0, speed: 1.0 + Math.random() };
    }

    // Build the lane layout from the level contract.
    function buildTargets(s, layout) {
        const { scene } = core;
        const lanes = Array.isArray(layout.lanes) ? layout.lanes : [];
        lanes.forEach((lane, i) => {
            // Cycle target type per lane for variety.
            const kind = i % 3;
            const t = kind === 0 ? makeBullseye() : kind === 1 ? makeSilhouette() : makeMover();
            t.group.position.set(lane[0], lane[1] ?? 0, lane[2]);
            t.group.rotation.y = Math.PI;          // face back toward the shooter (-Z)
            t.homeX = lane[0];
            scene?.add(t.group);
            s.targets.push(t);
        });
    }

    // ---- HUD ------------------------------------------------------------
    let _hudEl = null;
    function ensureHud() {
        if (_hudEl?.parentNode) return _hudEl;
        const el = document.createElement('div');
        el.className = 'shootsim-overlay';
        el.style.cssText = 'position:absolute;left:18px;top:16px;pointer-events:none;'
            + 'z-index:996;font:700 16px/1.5 "Trebuchet MS",system-ui,sans-serif;'
            + 'color:#eaf2ff;text-shadow:0 2px 6px rgba(0,0,0,0.85);';
        (document.getElementById('canvas-container') || document.body)?.appendChild(el);
        _hudEl = el;
        return el;
    }
    function updateHud(s) {
        const el = ensureHud();
        el.style.display = 'block';
        const acc = s.shots > 0 ? Math.round((s.hits / s.shots) * 100) : 0;
        const timeLeft = s.roundActive ? Math.max(0, Math.ceil((s.roundEndsAt - now()) / 1000)) : 0;
        el.innerHTML =
            `<div style="font-size:24px;color:#ffd24a;">${s.score.toLocaleString()} <span style="font-size:13px;color:#9aa3b2;">pts</span></div>`
            + (s.roundActive
                ? `<div style="color:${timeLeft <= 10 ? '#ff6b6b' : '#7fd0ff'};font-size:20px;">⏱ ${timeLeft}s</div>`
                : `<div style="opacity:.85;">PRACTICE · <span style="color:#7fd0ff;">[R]</span> Time Attack</div>`)
            + `<div style="opacity:.9;">Accuracy: ${acc}% <span style="opacity:.6;font-size:13px;">(${s.hits}/${s.shots})</span></div>`
            + (s.streak > 1 ? `<div style="color:#9dffa0;">🔥 Streak x${s.streak}</div>` : '')
            + `<div style="opacity:.7;font-size:13px;">Best: ${s.best.toLocaleString()} · [M] menu</div>`;
    }

    // ---- prompt + floating score text -----------------------------------
    let _promptEl = null;
    function showPrompt(text) {
        if (!_promptEl?.parentNode) {
            const el = document.createElement('div');
            el.className = 'shootsim-overlay';
            el.style.cssText = 'position:absolute;left:50%;bottom:96px;transform:translateX(-50%);'
                + 'pointer-events:none;z-index:997;text-align:center;'
                + 'font:800 18px/1.3 "Trebuchet MS",system-ui,sans-serif;color:#fff;'
                + 'background:rgba(8,14,22,0.7);padding:8px 16px;border-radius:10px;'
                + 'border:1px solid rgba(120,200,255,0.4);text-shadow:0 2px 4px rgba(0,0,0,0.8);';
            (document.getElementById('canvas-container') || document.body)?.appendChild(el);
            _promptEl = el;
        }
        _promptEl.style.display = 'block';
        _promptEl.innerHTML = text;
    }
    function hidePrompt() { if (_promptEl) _promptEl.style.display = 'none'; }

    let _floatLayer = null;
    const _tmpFloat = new THREE.Vector3();
    function floatText(text, worldPos, color = '#ffd24a') {
        const { camera, renderer } = core;
        if (!camera || !renderer || !worldPos) return;
        if (!_floatLayer?.parentNode) {
            const el = document.createElement('div');
            el.className = 'shootsim-overlay';
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
            + `color:${color};font:900 22px/1 "Trebuchet MS",system-ui,sans-serif;`
            + `text-shadow:0 2px 6px rgba(0,0,0,0.9);transition:transform .8s ease,opacity .8s ease;opacity:1;`;
        _floatLayer.appendChild(node);
        requestAnimationFrame(() => {
            node.style.transform = 'translate(-50%,-50%) translateY(-54px)';
            node.style.opacity = '0';
        });
        setTimeout(() => node.remove(), 820);
    }

    // ---- mode menu ------------------------------------------------------
    let _menuEl = null;
    function openMenu() {
        const s = ensureState();
        if (s.menuOpen) return;
        s.menuOpen = true;
        gameplay.roguePaused = true;
        try { document.exitPointerLock?.(); } catch (e) {}
        renderMenu(s);
    }
    function renderMenu(s) {
        if (_menuEl?.parentNode) _menuEl.remove();
        const overlay = document.createElement('div');
        overlay.className = 'shootsim-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:1200;pointer-events:auto;'
            + 'background:rgba(4,8,14,0.85);backdrop-filter:blur(3px);display:flex;'
            + 'flex-direction:column;align-items:center;justify-content:center;'
            + 'font-family:"Trebuchet MS",system-ui,sans-serif;color:#eaf2ff;';
        overlay.innerHTML = '<div style="font:900 30px/1.1 inherit;margin-bottom:8px;color:#ffd24a;text-shadow:0 0 18px rgba(255,180,60,0.5);">SHOOTING RANGE</div>'
            + `<div style="opacity:.85;margin-bottom:24px;">Best Time Attack: <b style="color:#9dffa0;">${s.best.toLocaleString()}</b></div>`;
        const mkBtn = (label, sub, onClick, accent) => {
            const b = document.createElement('button');
            b.style.cssText = 'cursor:pointer;width:280px;padding:16px;margin:8px;border-radius:14px;'
                + `font:800 19px/1.2 inherit;color:#0a140e;text-align:center;`
                + `background:linear-gradient(160deg,${accent},${accent}cc);`
                + 'border:2px solid rgba(0,0,0,0.25);box-shadow:0 6px 22px rgba(0,0,0,0.45);';
            b.innerHTML = `${label}<div style="font:600 12px/1.3 inherit;opacity:.8;margin-top:4px;">${sub}</div>`;
            b.onclick = onClick;
            overlay.appendChild(b);
        };
        mkBtn('PRACTICE', 'Free shooting, no timer', () => { s.mode = 'practice'; s.roundActive = false; closeMenu(); }, '#7fd0ff');
        mkBtn('TIME ATTACK', `${TIME_ATTACK_SEC}s — chase a high score`, () => { closeMenu(); startTimeAttack(s); }, '#9dffa0');
        const close = document.createElement('button');
        close.textContent = 'BACK (Esc)';
        close.style.cssText = 'margin-top:18px;padding:10px 28px;cursor:pointer;font:800 16px/1 inherit;color:#fff;'
            + 'border-radius:12px;background:linear-gradient(160deg,#2a3340,#141a22);border:2px solid rgba(120,200,255,0.4);';
        close.onclick = () => closeMenu();
        overlay.appendChild(close);
        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        _menuEl = overlay;
    }
    function closeMenu() {
        const s = window.shootingSim;
        if (_menuEl?.parentNode) _menuEl.remove();
        _menuEl = null;
        if (s) s.menuOpen = false;
        gameplay.roguePaused = false;
        const { renderer } = core;
        if (renderer?.domElement && !window.matchMedia?.('(pointer:coarse)')?.matches) {
            const resume = () => { renderer.domElement.removeEventListener('click', resume); try { renderer.domElement.requestPointerLock?.(); } catch (e) {} };
            renderer.domElement.addEventListener('click', resume);
        }
    }

    function startTimeAttack(s) {
        s.mode = 'timeAttack';
        s.score = 0; s.shots = 0; s.hits = 0; s.streak = 0; s.bestStreak = 0;
        s.roundActive = true;
        s.roundEndsAt = now() + TIME_ATTACK_SEC * 1000;
        // Stand any downed silhouettes back up for a clean start.
        for (const t of s.targets) { if (t.type === 'popup') standUp(t); }
        floatText('GO!', frontOfPlayer(2.0), '#9dffa0');
    }
    function endTimeAttack(s) {
        s.roundActive = false;
        if (s.score > s.best) { s.best = s.score; saveBest(s.best); }
        floatText(`TIME! ${s.score} pts`, frontOfPlayer(2.5), '#ffd24a');
        showPrompt(`Round over — <b>${s.score}</b> pts (best ${s.best}). [R] again · [M] menu`);
    }

    // ---- tracers + sfx --------------------------------------------------
    const _tracers = [];
    function spawnTracer(from, to) {
        const { scene } = core;
        if (!scene) return;
        const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
        const mat = new THREE.LineBasicMaterial({ color: 0xfff3a0, transparent: true, opacity: 0.9 });
        const line = new THREE.Line(geo, mat);
        line.renderOrder = 9;
        scene.add(line);
        _tracers.push({ line, born: now() });
    }
    function updateTracers() {
        const { scene } = core;
        for (let i = _tracers.length - 1; i >= 0; i--) {
            const t = _tracers[i];
            const age = now() - t.born;
            if (age > 80) {
                try { scene?.remove(t.line); t.line.geometry.dispose(); t.line.material.dispose(); } catch (e) {}
                _tracers.splice(i, 1);
            } else { t.line.material.opacity = 0.9 * (1 - age / 80); }
        }
    }

    let _audioCtx = null;
    function audioCtx() {
        if (_audioCtx) return _audioCtx;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        try { _audioCtx = new Ctx(); } catch (e) { _audioCtx = null; }
        return _audioCtx;
    }
    function destroyAudio() { if (_audioCtx) { try { _audioCtx.close(); } catch (e) {} _audioCtx = null; } }
    function playShot(vol = 1) {
        const ctx = audioCtx();
        if (!ctx) return;
        if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
        const t = ctx.currentTime;
        const dur = 0.14;
        const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
        const src = ctx.createBufferSource(); src.buffer = buf;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
        const g = ctx.createGain(); g.gain.setValueAtTime(0.5 * vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        src.connect(lp).connect(g).connect(ctx.destination); src.start(t);
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.1);
        const og = ctx.createGain(); og.gain.setValueAtTime(0.4 * vol, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        o.connect(og).connect(ctx.destination); o.start(t); o.stop(t + 0.13);
    }
    function playDing(vol = 1) {
        const ctx = audioCtx();
        if (!ctx) return;
        if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
        const t = ctx.currentTime;
        const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(1400, t); o.frequency.exponentialRampToValueAtTime(1900, t + 0.04);
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.25 * vol, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.25);
        o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.26);
    }

    // ---- shooting -------------------------------------------------------
    const _camPos = new THREE.Vector3();
    const _camDir = new THREE.Vector3();
    const _ray = new THREE.Raycaster();
    function frontOfPlayer(d) {
        const { camera } = core;
        if (!camera) return new THREE.Vector3();
        camera.getWorldPosition(_camPos);
        camera.getWorldDirection(_camDir).normalize();
        return _camPos.clone().addScaledVector(_camDir, d);
    }
    function now() { return performance.now?.() || Date.now(); }

    function standUp(t) {
        t.down = false; t.resetAt = 0;
        if (t.board) t.board.rotation.x = 0;
    }
    function knockDown(t) {
        t.down = true; t.resetAt = now() + POPUP_RESET_MS;
        if (t.board) t.board.rotation.x = -Math.PI / 2 + 0.1;   // fall backward
    }
    function flashMat(mat, color) {
        if (!mat) return;
        mat.emissive?.set(color);
        mat.emissiveIntensity = 1.0;
        mat.userData._flashUntil = now() + PLATE_HIT_FLASH_MS;
    }
    function updateFlashes(s) {
        const tNow = now();
        for (const t of s.targets) {
            t.group.traverse((o) => {
                const m = o.material;
                if (m && m.userData && m.userData._flashUntil && tNow > m.userData._flashUntil) {
                    m.emissiveIntensity = 0; m.userData._flashUntil = 0;
                }
            });
        }
    }

    function tryShoot(s) {
        const { camera } = core;
        if (!camera) return;
        const tNow = now();
        if (tNow < s.nextShotAt) return;
        s.nextShotAt = tNow + FIRE_COOLDOWN_MS;
        s.shots += 1;

        camera.getWorldPosition(_camPos);
        camera.getWorldDirection(_camDir).normalize();
        _ray.set(_camPos, _camDir);
        _ray.far = HIT_RANGE;

        // Raycast against all live target groups; nearest wins.
        const meshes = [];
        for (const t of s.targets) {
            if (t.type === 'popup' && t.down) continue;       // can't hit a downed plate
            t.group.traverse((o) => { if (o.isMesh) { o.userData._target = t; meshes.push(o); } });
        }
        const hits = _ray.intersectObjects(meshes, false);
        const muzzle = _camPos.clone().addScaledVector(_camDir, 0.5).add(new THREE.Vector3(0, -0.12, 0));

        playShot(0.9);
        if (gameplay.hitFeedback) gameplay.hitFeedback.shake = Math.max(gameplay.hitFeedback.shake || 0, 0.18);

        if (!hits.length) {
            spawnTracer(muzzle, _camPos.clone().addScaledVector(_camDir, HIT_RANGE));
            s.streak = 0;
            return;
        }
        const hit = hits[0];
        spawnTracer(muzzle, hit.point);
        const t = hit.object.userData._target;
        const pts = scoreHit(t, hit);
        if (pts > 0) {
            s.hits += 1;
            s.streak += 1;
            s.bestStreak = Math.max(s.bestStreak, s.streak);
            // Streak bonus: +10% per consecutive hit, capped at +100%.
            const mult = 1 + Math.min(1.0, (s.streak - 1) * 0.1);
            const total = Math.round(pts * mult);
            s.score += total;
            playDing(0.9);
            const col = pts >= 10 ? '#ffd24a' : pts >= 8 ? '#ff9a4a' : pts >= 5 ? '#7fd0ff' : '#9aa3b2';
            floatText(`+${total}${mult > 1 ? ` (x${mult.toFixed(1)})` : ''}`, hit.point.clone(), col);
        } else {
            s.streak = 0;
        }
    }

    // Score a hit on a target. Returns points (0 = no score).
    function scoreHit(t, hit) {
        if (!t) return 0;
        if (t.type === 'plate') {
            // Ring by distance from the plate center on the face plane.
            const center = t.faceGrp.getWorldPosition(new THREE.Vector3());
            const r = hit.point.distanceTo(center);
            for (const [radius, points, col] of RINGS) {
                if (r <= radius) {
                    flashMat(t.faceGrp.children[t.faceGrp.children.length - 1]?.material, '#ffffff');
                    // Spin the plate as feedback.
                    t.spinUntil = now() + 350;
                    return points;
                }
            }
            return 2; // edge hit still counts a little
        }
        if (t.type === 'popup') {
            // Center zone = headshot-ish bonus; body = base.
            const zone = t.board?.userData?.zone;
            let pts = 5;
            if (zone) {
                const zc = zone.getWorldPosition(new THREE.Vector3());
                if (hit.point.distanceTo(zc) <= 0.24) pts = 10;
            }
            knockDown(t);
            playDing(1.0);
            return pts;
        }
        if (t.type === 'mover') {
            flashMat(t.plate.material, '#ffffff');
            return 8;   // movers are worth more (harder)
        }
        return 0;
    }

    // ---- per-frame ------------------------------------------------------
    function updateMovers(s, dt) {
        for (const t of s.targets) {
            if (t.type === 'mover') {
                t.t += dt * t.speed;
                t.group.position.x = (t.homeX ?? 0) + Math.sin(t.t) * t.span;
            }
            if (t.type === 'plate' && t.spinUntil && now() < t.spinUntil) {
                t.faceGrp.rotation.z += dt * 12;
            }
            if (t.type === 'popup' && t.down && now() >= t.resetAt) standUp(t);
        }
    }

    function updateShootingSimState(playerPos, delta = 0.016) {
        const { currentMesh } = core;
        if (currentMesh?.userData?.sampleType !== 'shootingSim') return;
        installKeys();
        const s = ensureState();
        const layout = currentMesh.userData.shootingSimLevel || {};
        const dt = Math.min(0.05, Math.max(0.001, delta));

        if (!s.started && playerPos) {
            s.started = true;
            s.best = loadBest();
            buildTargets(s, layout);
        }

        updateTracers();
        updateFlashes(s);

        if (s.menuOpen) { updateHud(s); return; }
        if (!playerPos) return;

        updateMovers(s, dt);

        // Fire on Fire (mouse / touch). Semi-auto: edge-triggered for crisp aim.
        if (gameplay.input?.firePressed) { gameplay.input.firePressed = false; tryShoot(s); }
        else if (gameplay.input?.fire && s.mode === 'timeAttack' && s.roundActive) { tryShoot(s); } // hold-to-fire only in the timed rush

        // Time-attack countdown.
        if (s.roundActive && now() >= s.roundEndsAt) endTimeAttack(s);

        // Idle prompt.
        if (!s.roundActive) showPrompt('Aim &amp; Fire to shoot · <b>[R]</b> Time Attack · <b>[M]</b> Menu'); else hidePrompt();
        updateHud(s);
    }

    // ---- how-to-play ----------------------------------------------------
    const HELP = {
        title: 'SHOOTING SIMULATOR — HOW TO PLAY',
        lines: [
            'Aim with the mouse, Fire to shoot. Hit the targets downrange.',
            'Bullseyes score by ring (10/8/5/2). Silhouettes drop on hit — center = 10.',
            'Moving plates are worth more. Chain hits for a streak multiplier.',
            'Press [R] for a 60s Time Attack and chase a high score. [M] for the menu.',
        ],
    };
    function getHowToPlay() { return { title: HELP.title, lines: HELP.lines.slice() }; }

    // Dev/verification hook: aim the camera at a target by index and fire one
    // shot. Lets automated tests confirm the hit/score path without pointer-lock.
    function _debugFireAt(idx = 0) {
        const { camera } = core;
        const s = ensureState();
        const t = s.targets[idx];
        if (!camera || !t) return null;
        const aim = (t.faceGrp || t.board || t.plate || t.group).getWorldPosition(new THREE.Vector3());
        camera.lookAt(aim);
        camera.updateMatrixWorld(true);
        s.nextShotAt = 0;
        const before = s.hits;
        tryShoot(s);
        return { idx, hit: s.hits > before, score: s.score, shots: s.shots, hits: s.hits };
    }

    // ---- window surface -------------------------------------------------
    if (typeof window !== 'undefined') {
        window.shootingSimApi = { ensureState, resetState, updateShootingSimState, openMenu, closeMenu, startTimeAttack: () => startTimeAttack(ensureState()), getHowToPlay, _debugFireAt };
        window.resetShootingSimState = resetState;
    }

    return { ensureState, resetState, updateShootingSimState, openMenu, closeMenu, getHowToPlay };
}
