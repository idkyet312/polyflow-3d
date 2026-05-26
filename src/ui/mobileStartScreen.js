// Mobile game launcher + pause menu. Kept outside runtime.js so the entry
// stays under the architecture line cap.

import { getPlaytimeSeconds, formatPlaytime, resetPlaytime } from '../gameplay/playtime.js';
import { getAwards, resetAwards } from '../gameplay/awards.js';

const MOBILE_GAME_LEVEL_IDS = ['doomArena', 'drugTycoon', 'shootingSim', 'doomTest', 'soccerField'];

// localStorage keys to nuke when the per-game "Reset progress" button fires.
// Anything not in this map just gets its playtime + awards wiped.
const GAME_SAVE_KEYS = {
    drugTycoon: ['polyflow.drugTycoon.save.v1'],
    shootingSim: ['polyflow.shootingSim.best.v1'],
};

// Picker-button id → in-game sampleType. They almost always match; soccer is
// the odd one (picker says 'soccerField', the level userData says
// 'soccerTargetField'). Used to look up playtime + awards by the same key the
// trackers were ticked with.
const PICKER_ID_TO_SAMPLE_TYPE = {
    soccerField: 'soccerTargetField',
};
const sampleKeyFor = (pickerId) => PICKER_ID_TO_SAMPLE_TYPE[pickerId] || pickerId;

const FALLBACK_GAME_INFO = {
    doomArena: {
        title: 'Rogue Waves - How To Play',
        lines: [
            'Step off the start pad, pick a weapon, then survive waves.',
            'Fire to shoot. Reload when empty. Collect XP orbs from kills.',
            'Pick upgrade cards on level up. Boss waves hit harder.',
        ],
    },
    drugTycoon: {
        title: 'Drug Tycoon - How To Play',
        lines: [
            'Harvest plants at home, drag buds into bags at the bench, then cook product.',
            'Use phone orders to find matching buyers. Sell to earn cash.',
            'Spend cash on upgrades. Heat brings cops; sleep to skip night.',
        ],
    },
    shootingSim: {
        title: 'Shooting Simulator - How To Play',
        lines: [
            'Aim with look, Fire to shoot the targets downrange.',
            'Bullseyes score by ring; silhouettes drop on hit; movers pay more.',
            'Chain hits for a streak bonus. [R] starts a 60s Time Attack; [M] opens the menu.',
        ],
    },
    doomTest: {
        title: 'Doom Mini - How To Play',
        lines: [
            'Pick up the shotgun and clear each arena wave.',
            'Use movement to dodge shots. Shoot enemies until the exit unlocks.',
            'Reach the teleporter to finish.',
        ],
    },
    soccerField: {
        title: 'Soccer Field - How To Play',
        lines: [
            'Push the ball into the goals.',
            'Use movement to line up shots and avoid goalie blocks.',
            'Reset from the games menu any time.',
        ],
    },
};

const pauseState = {
    open: false,
    wasRoguePaused: false,
};

let mobileState, gameplay, physics, worldEnvState, WORLD_ENV_DEFAULTS;
let setCameraMode, setMobileMenuOpen, loadSample, setPerfModeEnabled,
    applyWorldEnvState, resetMobileInputState, requestGameplayPointerLock;
let highBloomTimer = null;

export function setupMobileStartScreen(deps) {
    ({
        mobileState,
        gameplay,
        physics,
        worldEnvState,
        WORLD_ENV_DEFAULTS,
        setCameraMode,
        setMobileMenuOpen,
        loadSample,
        setPerfModeEnabled,
        applyWorldEnvState,
        resetMobileInputState,
        requestGameplayPointerLock,
    } = deps);

    const startScreen = document.getElementById('mobile-start-screen');
    const gamesBtn = document.getElementById('mobile-start-games');
    const engineBtn = document.getElementById('mobile-start-engine');
    const backBtn = document.getElementById('mobile-game-back');
    const gameList = document.getElementById('mobile-game-list');
    const pauseContinueBtn = document.getElementById('mobile-pause-continue');
    const pauseExitBtn = document.getElementById('mobile-pause-exit');
    const pauseInfoBtn = document.getElementById('mobile-pause-info-toggle');
    const qualityLowBtn = document.getElementById('mobile-quality-low');
    const qualityMedBtn = document.getElementById('mobile-quality-med');
    const qualityHighBtn = document.getElementById('mobile-quality-high');
    if (!startScreen || startScreen.dataset.ready === 'true') return;
    startScreen.dataset.ready = 'true';

    const dismissStart = () => {
        document.body.classList.add('mobile-start-dismissed');
        document.body.classList.remove('mobile-games-open');
    };

    const openStartGames = () => {
        mobileState.launchedFromGames = false;
        document.body.classList.remove('mobile-start-dismissed');
        document.body.classList.remove('game-session');
        document.body.classList.add('mobile-games-open');
        renderGameList(gameList);
    };

    gamesBtn?.addEventListener('click', () => {
        renderGameList(gameList);
        document.body.classList.add('mobile-games-open');
    });

    engineBtn?.addEventListener('click', () => {
        mobileState.launchedFromGames = false;
        document.body.classList.remove('game-session');
        dismissStart();
        setCameraMode('showcase');
    });

    backBtn?.addEventListener('click', () => {
        document.body.classList.remove('mobile-games-open');
    });

    gameList?.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : event.target?.parentElement;
        // Reset button: confirm, wipe progress for this game, re-render. Do
        // NOT fall through to the launch handler.
        const resetBtn = target?.closest?.('.mobile-game-reset');
        const resetId = resetBtn?.dataset?.resetId;
        if (resetId) {
            event.stopPropagation();
            const label = resetBtn.closest('.mobile-game-row')?.querySelector('.mobile-game-label')?.textContent || resetId;
            const ok = (typeof confirm === 'function')
                ? confirm(`Reset all progress for ${label}? This clears the save, playtime, and awards. This cannot be undone.`)
                : true;
            if (!ok) return;
            resetGameProgress(resetId);
            renderGameList(gameList);
            return;
        }
        const button = target?.closest?.('.mobile-game-button');
        const levelId = button?.dataset?.levelId;
        if (!levelId) return;

        const select = document.getElementById('level-select');
        if (select) select.value = levelId;
        mobileState.launchedFromGames = true;
        mobileState.currentGameLevelId = levelId;
        try {
            applyMobileQualitySetting(mobileState.enabled ? (mobileState.quality || 'low') : 'high');
            dismissStart();
            document.body.classList.remove('mobile-games-open');
            // Game session: hide all engine UI/panels and run the lean loop so no
            // editor/showcase stuff plays behind the game.
            document.body.classList.add('game-session');
            setMobileMenuOpen(false);
            loadSample(levelId);
        } catch (err) {
            console.error('[mobileStart] level load failed:', levelId, err);
            return;
        }
        // Play mode only starts once physics is ready (gameplay.canPlay gates
        // enterGameplay). On a fresh load physics may still be initializing, so
        // poll briefly until ready, then enter — otherwise the level loads but
        // play never starts (was the "selecting a level does nothing" bug on PC).
        const startPlay = () => {
            if (physics?.ready || gameplay.canPlay) {
                try {
                    setCameraMode('play');
                } catch (err) {
                    console.error('[mobileStart] enter play failed:', levelId, err);
                }
            } else {
                window.setTimeout(startPlay, 60);
            }
        };
        startPlay();
    });

    pauseContinueBtn?.addEventListener('click', () => closeMobileGamePauseMenu());
    pauseExitBtn?.addEventListener('click', () => {
        closeMobileGamePauseMenu({ restorePause: false });
        gameplay.roguePaused = false;
        document.body.classList.remove('game-session');
        mobileState.launchedFromGames = false;
        setCameraMode('showcase');
        openStartGames();
    });

    pauseInfoBtn?.addEventListener('click', () => {
        const panel = document.getElementById('mobile-pause-info');
        renderPauseInfo({ open: panel?.hidden !== false });
    });
    qualityLowBtn?.addEventListener('click', () => applyMobileQualitySetting('low'));
    qualityMedBtn?.addEventListener('click', () => applyMobileQualitySetting('medium'));
    qualityHighBtn?.addEventListener('click', () => applyMobileQualitySetting('high'));
    syncMobileQualityButtons();
    wireGraphicsSettings();
}

// ---- in-game graphics settings (pause menu "Graphics Settings") -----------
// Per-effect toggles + a max-lights slider, layered on top of the Low/Med/High
// presets. Each flips a worldEnvState flag and re-applies live.
function setGfxToggle(btn, on) {
    if (!btn) return;
    btn.dataset.on = on ? '1' : '0';
    btn.textContent = on ? 'On' : 'Off';
    btn.classList.toggle('is-on', !!on);
}
function syncGraphicsSettings() {
    const s = worldEnvState;
    setGfxToggle(document.getElementById('gfx-bloom'), s.bloom?.enabled);
    setGfxToggle(document.getElementById('gfx-ambient'), s.ambient?.enabled);
    setGfxToggle(document.getElementById('gfx-ssao'), s.ssao?.enabled);
    setGfxToggle(document.getElementById('gfx-ssr'), s.ssr?.enabled);
    setGfxToggle(document.getElementById('gfx-taa'), s.aa?.enabled);
    setGfxToggle(document.getElementById('gfx-shadows'), s.shadows?.enabled);
    setGfxToggle(document.getElementById('gfx-fog'), s.fog?.enabled);
    setGfxToggle(document.getElementById('gfx-adaptive'), s.adaptive?.enabled);
    setGfxToggle(document.getElementById('gfx-lightcull'), s.lightCull?.enabled);
    const ml = document.getElementById('gfx-maxlights');
    const mlv = document.getElementById('gfx-maxlights-val');
    if (ml && s.lightCull) { ml.value = String(s.lightCull.maxActive); }
    if (mlv && s.lightCull) { mlv.textContent = String(s.lightCull.maxActive); }
}
function wireGraphicsSettings() {
    const gfxToggleBtn = document.getElementById('mobile-pause-gfx-toggle');
    const gfxPanel = document.getElementById('mobile-pause-gfx');
    gfxToggleBtn?.addEventListener('click', () => {
        const show = gfxPanel?.hidden !== false;
        if (gfxPanel) gfxPanel.hidden = !show;
        gfxToggleBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
        if (show) syncGraphicsSettings();
    });
    const bind = (id, getSec, { needsPostFx = false } = {}) => {
        const btn = document.getElementById(id);
        btn?.addEventListener('click', () => {
            const sec = getSec();
            if (!sec) return;
            sec.enabled = !sec.enabled;
            if (sec.enabled && needsPostFx) setPerfModeEnabled(false);
            setGfxToggle(btn, sec.enabled);
            applyWorldEnvState({ persist: true, switchSky: false });
        });
    };
    bind('gfx-bloom', () => worldEnvState.bloom);
    bind('gfx-ambient', () => worldEnvState.ambient);
    bind('gfx-ssao', () => worldEnvState.ssao);
    bind('gfx-ssr', () => worldEnvState.ssr, { needsPostFx: true });
    bind('gfx-taa', () => worldEnvState.aa, { needsPostFx: true });
    bind('gfx-shadows', () => worldEnvState.shadows);
    bind('gfx-fog', () => worldEnvState.fog);
    bind('gfx-adaptive', () => worldEnvState.adaptive);
    bind('gfx-lightcull', () => worldEnvState.lightCull);
    const ml = document.getElementById('gfx-maxlights');
    ml?.addEventListener('input', () => {
        const v = parseInt(ml.value, 10);
        if (Number.isFinite(v) && worldEnvState.lightCull) {
            worldEnvState.lightCull.maxActive = v;
            const mlv = document.getElementById('gfx-maxlights-val');
            if (mlv) mlv.textContent = String(v);
            applyWorldEnvState({ persist: true, switchSky: false });
        }
    });
}

function getMobileGameOptions() {
    const select = document.getElementById('level-select');
    if (!select) {
        return [
            { id: 'doomArena', label: 'Rogue Waves' },
            { id: 'drugTycoon', label: 'Drug Tycoon' },
            { id: 'shootingSim', label: 'Shooting Simulator' },
            { id: 'doomTest', label: 'Doom Test Arena' },
            { id: 'soccerField', label: 'Soccer Field' },
        ];
    }

    return Array.from(select.options)
        .filter((option) => MOBILE_GAME_LEVEL_IDS.includes(option.value))
        .map((option) => ({ id: option.value, label: option.textContent.trim() || option.value }));
}

function renderGameList(gameList) {
    if (!gameList) return;
    const fragment = document.createDocumentFragment();
    getMobileGameOptions().forEach(({ id, label }) => {
        // Row wrapper — keeps the launcher button and the smaller reset button
        // visually distinct but on the same line.
        const row = document.createElement('div');
        row.className = 'mobile-game-row';
        row.style.cssText = 'display:flex;align-items:stretch;gap:8px;width:100%;';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mobile-game-button';
        button.dataset.levelId = id;
        button.style.cssText = 'flex:1 1 auto;display:flex;flex-direction:column;align-items:flex-start;gap:4px;text-align:left;';

        const sampleKey = sampleKeyFor(id);
        const playtime = getPlaytimeSeconds(sampleKey);
        const { unlocked, total } = getAwards(sampleKey);
        const meta = [];
        if (playtime > 0) meta.push(`⏱ ${formatPlaytime(playtime)}`);
        if (total > 0) meta.push(`🏅 ${unlocked} / ${total}`);
        else meta.push('🏅 —');

        button.innerHTML = `<span class="mobile-game-label">${label}</span>`
            + `<span class="mobile-game-meta" style="font-size:12px;opacity:.7;font-weight:600;">${meta.join('  ·  ')}</span>`;
        row.appendChild(button);

        // Reset button — wipes that game's save + playtime + awards. Only
        // shown if there's any progress to wipe (cleaner empty state).
        if (playtime > 0 || unlocked > 0 || (GAME_SAVE_KEYS[id]?.length)) {
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.className = 'mobile-game-reset';
            reset.dataset.resetId = id;
            reset.title = 'Reset all progress for this game';
            reset.textContent = '↺ Reset';
            reset.style.cssText = 'flex:0 0 auto;padding:0 14px;font-size:13px;font-weight:700;'
                + 'background:rgba(60,20,20,0.85);color:#ffd6d6;border:1px solid rgba(255,120,120,0.35);'
                + 'border-radius:8px;cursor:pointer;';
            row.appendChild(reset);
        }

        fragment.appendChild(row);
    });
    gameList.replaceChildren(fragment);
}

// Wipe a single game's progress (localStorage saves + playtime + awards).
function resetGameProgress(levelId) {
    if (!levelId) return;
    const keys = GAME_SAVE_KEYS[levelId] || [];
    for (const k of keys) {
        try { localStorage.removeItem(k); } catch (e) {}
    }
    const sampleKey = sampleKeyFor(levelId);
    resetPlaytime(sampleKey);
    resetAwards(sampleKey);
    // Drug Tycoon owns a live `window.drugTycoon` state object; null it so a
    // re-entry rebuilds from defaults instead of resurrecting the cleared save.
    if (levelId === 'drugTycoon' && typeof window !== 'undefined') {
        try { delete window.drugTycoon; } catch (e) { window.drugTycoon = undefined; }
    }
}

function syncMobileQualityButtons() {
    document.getElementById('mobile-quality-low')?.classList.toggle('is-active', mobileState.quality === 'low');
    document.getElementById('mobile-quality-med')?.classList.toggle('is-active', mobileState.quality === 'medium');
    document.getElementById('mobile-quality-high')?.classList.toggle('is-active', mobileState.quality === 'high');
}

export function applyMobileQualitySetting(quality = 'medium') {
    const mode = ['low', 'medium', 'high'].includes(quality) ? quality : 'medium';
    const s = worldEnvState;

    mobileState.quality = mode;
    const lowMode = mode === 'low';
    const medMode = mode === 'medium';
    const highMode = mode === 'high';

    // Only touch rows exposed in the pause-menu Graphics Settings panel.
    if (s.sky) s.sky.enabled = !lowMode;
    if (s.bloom) {
        s.bloom.enabled = !lowMode;
        if (medMode) {
            s.bloom.strength = 0.4;
            s.bloom.radius = 0.25;
            s.bloom.threshold = 2.2;
        } else if (highMode) {
            s.bloom.strength = 0.5;
            s.bloom.radius = 0.35;
            s.bloom.threshold = 2.2;
        }
    }
    if (s.ssao) s.ssao.enabled = !lowMode;
    if (s.ssr) s.ssr.enabled = highMode;
    if (s.aa) s.aa.enabled = highMode;
    if (s.shadows) s.shadows.enabled = !lowMode;
    if (s.fog) s.fog.enabled = medMode;
    if (s.adaptive) s.adaptive.enabled = !highMode;
    if (s.lightCull) {
        s.lightCull.enabled = true;
        s.lightCull.maxActive = lowMode ? 6 : medMode ? 12 : 16;
    }

    clearPendingHighBloom();
    applyWorldEnvState({ persist: true, switchSky: false });
    syncMobileQualityButtons();
    syncGraphicsSettings();
    return;
    if (mode !== 'low' && mode !== 'medium') {
        clearPendingHighBloom();
        setPerfModeEnabled(false);
        s.bloom.enabled = true;
        s.bloom.strength = 0.5;
        s.bloom.radius = 0.35;
        s.bloom.threshold = 2.2;
        s.ssgi.enabled = false;   // SSGI off — it speckled surfaces as grain
        s.fog.enabled = false;
        s.fog.density = 0.012;
        s.fog.opacity = 0.055;
        s.ddgi.enabled = true;
        s.ddgi.liveBake = true;
        s.ddgi.bakeEveryN = 4;
        s.ddgi.probesPerFrame = 4;
        s.ddgi.intensity = WORLD_ENV_DEFAULTS.ddgi.intensity;
        s.pom.enabled = true;
        s.pom.quality = 'medium';
        s.tonemap.exposure = 1.05;
        s.shadows.mapSize = 1024;
        s.shadows.radius = 8.0;
    }

    applyWorldEnvState({ persist: true, switchSky: false });
    syncMobileQualityButtons();
}

// Bloom now enables directly per quality preset (no deferred timer). Kept as a
// no-op so existing call sites stay valid.
function clearPendingHighBloom() {
    if (!highBloomTimer) return;
    window.clearTimeout(highBloomTimer);
    highBloomTimer = null;
}

export function closeMobileGamePauseMenu({ restorePause = true } = {}) {
    if (!pauseState.open) return;
    document.body.classList.remove('mobile-game-paused');
    pauseState.open = false;
    renderPauseInfo({ open: false });
    if (restorePause) {
        gameplay.roguePaused = pauseState.wasRoguePaused;
        if (!mobileState.enabled && gameplay.active && !gameplay.roguePaused) {
            requestGameplayPointerLock?.();
        }
    }
    pauseState.wasRoguePaused = false;
}

export function handleMobileExitPlay() {
    if (!mobileState.launchedFromGames || !gameplay.active) return false;
    if (pauseState.open) return true;

    pauseState.open = true;
    pauseState.wasRoguePaused = !!gameplay.roguePaused;
    gameplay.roguePaused = true;
    gameplay.velocity.set(0, 0, 0);
    physics.jumpQueued = false;
    physics.desiredVelocity.set(0, 0, 0);
    if (physics.character && physics.Jolt) {
        physics.character.SetLinearVelocity(physics.Jolt.Vec3.prototype.sZero());
    }
    resetMobileInputState();
    renderPauseInfo({ open: false });
    syncGraphicsSettings();   // reflect live graphics state in the settings panel
    document.body.classList.add('mobile-game-paused');
    return true;
}

export function isMobileGamePaused() {
    return pauseState.open;
}

function renderPauseInfo({ open = false } = {}) {
    const panel = document.getElementById('mobile-pause-info');
    const toggle = document.getElementById('mobile-pause-info-toggle');
    const titleEl = document.getElementById('mobile-pause-info-title');
    const linesEl = document.getElementById('mobile-pause-info-lines');
    if (!panel || !toggle || !titleEl || !linesEl) return;

    const info = getCurrentGameInfo();
    titleEl.textContent = info.title;
    linesEl.replaceChildren(...info.lines.map((line) => {
        const row = document.createElement('div');
        row.textContent = line;
        return row;
    }));
    panel.hidden = !open;
    toggle.classList.toggle('is-active', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function getCurrentGameInfo() {
    const levelId = mobileState.currentGameLevelId
        || document.getElementById('level-select')?.value
        || 'doomArena';
    const modeInfo = getGameModeInfo(levelId);
    return normalizeGameInfo(modeInfo) || FALLBACK_GAME_INFO[levelId] || FALLBACK_GAME_INFO.doomArena;
}

function getGameModeInfo(levelId) {
    if (levelId === 'drugTycoon') {
        return window.drugTycoonApi?.getHowToPlay?.();
    }
    if (levelId === 'doomArena') {
        return window.rogueWaves?.getHowToPlay?.();
    }
    if (levelId === 'shootingSim') {
        return window.shootingSimApi?.getHowToPlay?.();
    }
    return null;
}

function normalizeGameInfo(info) {
    if (!info || typeof info !== 'object') return null;
    const title = String(info.title || '').trim();
    const lines = Array.isArray(info.lines)
        ? info.lines.map((line) => String(line || '').trim()).filter(Boolean)
        : [];
    if (!title || !lines.length) return null;
    return { title, lines };
}
