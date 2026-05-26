// Per-game-mode award tracker. Each game declares an ordered list of award
// keys; unlocking is idempotent. Picker reads `unlockedCount / totalCount`.
// Backed by localStorage so badges survive reloads.
//
//   unlockAward('drugTycoon', 'firstSeed');
//   const { unlocked, total, items } = getAwards('drugTycoon');
//   resetAwards('drugTycoon');

const STORAGE_KEY = 'polyflow.awards.v1';

// Per-game award catalog. Each entry: { key, label, icon }.
// Keep stable keys (used in saves); change labels freely.
export const AWARD_CATALOG = {
    drugTycoon: [
        { key: 'firstSeed',   icon: '🌱', label: 'Plant your first seed' },
        { key: 'cash1k',      icon: '💰', label: 'Bank $1,000 in cash' },
        { key: 'buds50',      icon: '🌿', label: 'Harvest 50 buds total' },
        { key: 'hotSale',     icon: '🔥', label: 'Sell to the day\'s hot buyer' },
        { key: 'exoticSeed',  icon: '🏆', label: 'Buy an Exotic seed' },
    ],
    doomArena: [
        { key: 'firstKill', icon: '🔫', label: 'First kill' },
        { key: 'wave5',     icon: '🌊', label: 'Clear wave 5' },
        { key: 'wave10',    icon: '🌊', label: 'Clear wave 10' },
        { key: 'kills100',  icon: '💀', label: '100 enemies killed' },
        { key: 'wave20',    icon: '🏆', label: 'Clear wave 20' },
    ],
    shootingSim: [
        { key: 'firstHit',  icon: '🎯', label: 'Land your first hit' },
        { key: 'score100',  icon: '💯', label: 'Score 100' },
        { key: 'score500',  icon: '💯', label: 'Score 500' },
        { key: 'score1k',   icon: '💯', label: 'Score 1,000' },
        { key: 'score2_5k', icon: '🏆', label: 'Score 2,500' },
    ],
    soccerTargetField: [
        { key: 'goal1',  icon: '⚽', label: 'Score your first goal' },
        { key: 'goal5',  icon: '⚽', label: '5 goals scored' },
        { key: 'goal10', icon: '⚽', label: '10 goals scored' },
        { key: 'goal25', icon: '🏆', label: '25 goals scored' },
        { key: 'goal50', icon: '🥅', label: '50 goals scored' },
    ],
    // Test sandbox — no awards.
    doomTest: [],
};

let _cache = null;

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

function writeAll() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(_cache || {}));
    } catch (e) { /* ignore */ }
}

export function unlockAward(sampleType, key) {
    if (!sampleType || !key) return false;
    const catalog = AWARD_CATALOG[sampleType];
    if (!catalog || !catalog.some((a) => a.key === key)) return false;
    const all = readAll();
    all[sampleType] ||= {};
    if (all[sampleType][key]) return false;   // already unlocked
    all[sampleType][key] = Date.now();
    writeAll();
    return true;
}

export function isAwardUnlocked(sampleType, key) {
    return !!readAll()[sampleType]?.[key];
}

export function getAwards(sampleType) {
    const catalog = AWARD_CATALOG[sampleType] || [];
    const got = readAll()[sampleType] || {};
    const items = catalog.map((entry) => ({
        ...entry,
        unlocked: !!got[entry.key],
    }));
    return {
        total: catalog.length,
        unlocked: items.filter((i) => i.unlocked).length,
        items,
    };
}

export function resetAwards(sampleType) {
    const all = readAll();
    if (sampleType in all) {
        delete all[sampleType];
        writeAll();
    }
}
