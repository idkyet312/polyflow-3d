// Player settings menu — graphics quality + controls/sensitivity — persisted to
// localStorage. Self-contained: owns the live `settings` object, load/save, the
// panel UI, and the apply hooks that push values into the engine.
//
// Reuses existing systems:
//   - applyMobileQualitySetting() (mobileStartScreen) for graphics presets
//   - the live `look` object below is read by inputHandlers (mouse) and
//     mobileControls (touch) so sensitivity changes take effect immediately
//   - camera FOV is applied to the live THREE.PerspectiveCamera

const STORAGE_KEY = 'polyflow.settings.v1';

const DEFAULTS = {
    quality: 'high',        // 'low' | 'medium' | 'high' — graphics preset
    mouseSensitivity: 1.0,  // multiplier on the base mouse look speed
    touchSensitivity: 1.0,  // multiplier on the base touch look speed
    invertY: false,         // invert vertical look
    fov: 45,                // camera field of view (degrees)
};

// Base look speeds (the historical hardcoded constants). The live multipliers
// below scale these. inputHandlers/mobileControls read `look.*` every frame.
export const LOOK_BASE = { mouseYaw: 0.0022, mousePitch: 0.0018, touch: 0.0045 };

// Live, mutable look config read by the input handlers. Updated by applySettings.
export const look = {
    mouseYaw: LOOK_BASE.mouseYaw,
    mousePitch: LOOK_BASE.mousePitch,
    touch: LOOK_BASE.touch,
    invertY: false,
};

export const settings = { ...DEFAULTS };

// Injected by setupSettingsMenu()
let _deps = null;

function loadFromStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        for (const k of Object.keys(DEFAULTS)) {
            if (parsed[k] !== undefined) settings[k] = parsed[k];
        }
    } catch (e) { /* private mode / quota — keep defaults */ }
}

function saveToStorage() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
    catch (e) { /* ignore */ }
}

// Push the current settings into the engine. Safe to call any time.
export function applySettings({ persist = true } = {}) {
    // Look sensitivity → live look config.
    look.mouseYaw = LOOK_BASE.mouseYaw * settings.mouseSensitivity;
    look.mousePitch = LOOK_BASE.mousePitch * settings.mouseSensitivity;
    look.touch = LOOK_BASE.touch * settings.touchSensitivity;
    look.invertY = !!settings.invertY;

    // FOV → live camera.
    const camera = _deps?.getCamera?.();
    if (camera && Number.isFinite(settings.fov)) {
        camera.fov = settings.fov;
        camera.updateProjectionMatrix();
    }

    // Graphics preset → reuse the existing quality applier.
    _deps?.applyMobileQualitySetting?.(settings.quality);

    if (persist) saveToStorage();
}

function syncUi() {
    const setActive = (ids, activeId) => {
        ids.forEach((id) => {
            const el = document.getElementById(id);
            el?.classList.toggle('viewer-toggle-btn-active', id === activeId);
        });
    };
    setActive(['set-quality-low', 'set-quality-med', 'set-quality-high'],
        `set-quality-${settings.quality === 'medium' ? 'med' : settings.quality}`);

    const ms = document.getElementById('set-mouse-sens');
    const msv = document.getElementById('set-mouse-sens-value');
    if (ms) ms.value = String(settings.mouseSensitivity);
    if (msv) msv.textContent = settings.mouseSensitivity.toFixed(2);

    const ts = document.getElementById('set-touch-sens');
    const tsv = document.getElementById('set-touch-sens-value');
    if (ts) ts.value = String(settings.touchSensitivity);
    if (tsv) tsv.textContent = settings.touchSensitivity.toFixed(2);

    const fov = document.getElementById('set-fov');
    const fovv = document.getElementById('set-fov-value');
    if (fov) fov.value = String(settings.fov);
    if (fovv) fovv.textContent = String(Math.round(settings.fov));

    setActive(['set-invy-off', 'set-invy-on'], settings.invertY ? 'set-invy-on' : 'set-invy-off');
}

export function openSettings() {
    document.body.classList.add('settings-open');
    syncUi();
}
export function closeSettings() {
    document.body.classList.remove('settings-open');
}
export function isSettingsOpen() {
    return document.body.classList.contains('settings-open');
}

export function setupSettingsMenu(deps) {
    _deps = deps;
    loadFromStorage();
    applySettings({ persist: false });

    const openBtn = document.getElementById('settings-open-btn');
    const closeBtn = document.getElementById('settings-close-btn');
    openBtn?.addEventListener('click', openSettings);
    closeBtn?.addEventListener('click', closeSettings);

    // Graphics quality preset buttons.
    const setQuality = (q) => { settings.quality = q; applySettings(); syncUi(); };
    document.getElementById('set-quality-low')?.addEventListener('click', () => setQuality('low'));
    document.getElementById('set-quality-med')?.addEventListener('click', () => setQuality('medium'));
    document.getElementById('set-quality-high')?.addEventListener('click', () => setQuality('high'));

    // Sensitivity + FOV sliders.
    const wireSlider = (id, key, parse = parseFloat) => {
        const el = document.getElementById(id);
        el?.addEventListener('input', () => {
            const v = parse(el.value);
            if (Number.isFinite(v)) { settings[key] = v; applySettings(); syncUi(); }
        });
    };
    wireSlider('set-mouse-sens', 'mouseSensitivity');
    wireSlider('set-touch-sens', 'touchSensitivity');
    wireSlider('set-fov', 'fov');

    // Invert-Y toggle.
    document.getElementById('set-invy-off')?.addEventListener('click', () => { settings.invertY = false; applySettings(); syncUi(); });
    document.getElementById('set-invy-on')?.addEventListener('click', () => { settings.invertY = true; applySettings(); syncUi(); });

    syncUi();
}
