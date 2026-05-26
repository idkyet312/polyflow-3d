// Tiny per-game-mode playtime tracker. Backed by localStorage so totals
// survive reloads. Each game mode's update loop calls
//   tickPlaytime(sampleType, deltaSeconds)
// while gameplay is active; we accumulate seconds per key and throttle writes.
//
// Reads:
//   getPlaytimeSeconds(sampleType) -> number
//   formatPlaytime(seconds)        -> "1h 23m" / "12m 04s" / "47s"
//   resetPlaytime(sampleType)      -> wipes that key

const STORAGE_KEY = 'polyflow.playtime.v1';
const FLUSH_INTERVAL_MS = 5000;   // write at most every 5s to keep IO cheap

let _cache = null;
let _lastFlush = 0;
let _dirty = false;

function readAll() {
    if (_cache) return _cache;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const blob = raw ? JSON.parse(raw) : {};
        _cache = (blob && typeof blob === 'object') ? blob : {};
    } catch (e) {
        _cache = {};
    }
    return _cache;
}

function flush(force = false) {
    if (!_dirty && !force) return;
    const now = performance.now?.() || Date.now();
    if (!force && (now - _lastFlush) < FLUSH_INTERVAL_MS) return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(_cache || {}));
    } catch (e) { /* private mode / quota — ignore */ }
    _lastFlush = now;
    _dirty = false;
}

export function tickPlaytime(sampleType, deltaSeconds) {
    if (!sampleType || typeof sampleType !== 'string') return;
    const dt = Number(deltaSeconds);
    if (!Number.isFinite(dt) || dt <= 0) return;
    // Frame spikes (tab switch, pause unfreeze) can hand us huge deltas; cap.
    const clamped = Math.min(dt, 1.0);
    const all = readAll();
    all[sampleType] = (all[sampleType] || 0) + clamped;
    _dirty = true;
    flush(false);
}

export function getPlaytimeSeconds(sampleType) {
    return readAll()[sampleType] || 0;
}

export function getAllPlaytimes() {
    return { ...readAll() };
}

export function resetPlaytime(sampleType) {
    const all = readAll();
    if (sampleType in all) {
        delete all[sampleType];
        _dirty = true;
        flush(true);
    }
}

// "5h 12m" / "12m 04s" / "47s" — picks the largest meaningful unit pair.
export function formatPlaytime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m ${String(rs).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h ${String(rm).padStart(2, '0')}m`;
}

// Best-effort flush on tab close.
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => flush(true));
    window.addEventListener('pagehide', () => flush(true));
}
