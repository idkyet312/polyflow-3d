// Mobile game launcher + pause menu. Kept outside runtime.js so the entry
// stays under the architecture line cap.

const MOBILE_GAME_LEVEL_IDS = ['doomArena', 'drugTycoon', 'doomTest', 'soccerField'];

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
}

function getMobileGameOptions() {
    const select = document.getElementById('level-select');
    if (!select) {
        return [
            { id: 'doomArena', label: 'Rogue Waves' },
            { id: 'drugTycoon', label: 'Drug Tycoon' },
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
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mobile-game-button';
        button.dataset.levelId = id;
        button.textContent = label;
        fragment.appendChild(button);
    });
    gameList.replaceChildren(fragment);
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
    s.ambient.enabled = true;
    s.ddgi.debugProbes = false;
    s.ddgi.rayDebug = false;
    s.ddgi.contributionView = false;
    s.ddgi.solidTest = false;

    const lowMode = mode === 'low';
    s.sky.enabled = !lowMode;
    s.hemi.enabled = !lowMode;
    s.sun.enabled = !lowMode;
    s.sun.castShadow = !lowMode;
    s.shadows.enabled = !lowMode;

    if (mode === 'low') {
        clearPendingHighBloom();
        setPerfModeEnabled(true);
        s.bloom.enabled = false;
        s.ssgi.enabled = false;
        s.fog.enabled = false;
        s.ddgi.enabled = false;
        s.pom.enabled = false;
        s.tonemap.exposure = 0.95;
        s.shadows.mapSize = 256;
        s.shadows.radius = 5.0;
    } else if (mode === 'medium') {
        clearPendingHighBloom();
        setPerfModeEnabled(false);
        s.bloom.enabled = true;
        s.bloom.strength = 0.4;
        s.bloom.radius = 0.25;
        s.bloom.threshold = 2.2;
        s.ssgi.enabled = false;
        s.fog.enabled = true;
        s.fog.density = 0.009;
        s.fog.opacity = 0.035;
        s.ddgi.enabled = false;
        s.pom.enabled = false;
        s.tonemap.exposure = 1.0;
        s.shadows.mapSize = 512;
        s.shadows.radius = 7.0;
    } else {
        clearPendingHighBloom();
        setPerfModeEnabled(false);
        s.bloom.enabled = true;
        s.bloom.strength = 0.5;
        s.bloom.radius = 0.35;
        s.bloom.threshold = 2.2;
        s.ssgi.enabled = true;
        s.ssgi.giIntensity = 1.8;
        s.ssgi.aoIntensity = 1.0;
        s.ssgi.radius = 8.0;
        s.ssgi.thickness = 0.6;
        s.ssgi.sliceCount = 1;
        s.ssgi.stepCount = 12;
        s.fog.enabled = true;
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
