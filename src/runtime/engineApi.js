// engineApi — typed surface for cross-module + eval'd-script calls.
//
// Replaces the ad-hoc `window.spawnImpactBurst`, `window.playImpactSound`,
// etc. pattern that previously coupled extracted modules (and user
// scripts) to the global namespace.
//
// Shape:
//   engineApi.fx.spawnImpactBurst(x, y, z, opts)
//   engineApi.fx.spawnTracer(ox, oy, oz, dx, dy, dz, len, color)
//   engineApi.sound.playImpactSound(volume, x?, y?, z?)
//   engineApi.hud.setWeaponHud(text)
//
// Lifecycle:
//   - runtime.js calls registerEngineFx({...}) once during init, passing
//     the concrete implementations.
//   - Consumers (modules + eval'd scripts via the `api` parameter) call
//     engineApi.fx.spawnImpactBurst() — short-circuits to no-op until
//     registered.
//
// Why namespaces (.fx/.sound/.hud) rather than a flat list:
//   - Documents intent of each call (this is HUD, that is audio).
//   - Lets future code grep for a category, not 13 distinct names.
//   - Permits future replacement of a whole category (e.g. swap sound
//     backend) without touching call sites' import shape.
//
// Why this is not an EventBus: these calls have synchronous side-effects
// (spawn a tracer mesh, play an audio buffer, set HUD text). A
// fire-and-forget bus would lose return values and obscure who handles
// what. Use a bus when there are multiple subscribers or none; use an
// API when there is exactly one implementer.

function noop() {}

const fx = {
    spawnImpactBurst: noop,
    spawnTracer: noop,
    spawnImpactDecal: noop,
    spawnMuzzleSmoke: noop,
    flashActorHit: noop,
    flashDoomShotgun: noop,
};

const sound = {
    playImpactSound: noop,
    playEnemyHurtSound: noop,
    playEnemyDeathSound: noop,
    playDoomShotgunSound: noop,
    playDoomPickupSound: noop,
};

const hud = {
    setWeaponHud: noop,
    showDamageIndicator: noop,
};

const weapons = {
    equipDoomShotgun: noop,
    equipStraightGun: noop,
    equipSniperRifle: noop,
    equipThrowingStar: noop,
    spawnDoomPellet: noop,
    applyCameraRecoil: noop,
};

export const engineApi = { fx, sound, hud, weapons };

export function registerEngineFx(impl) {
    for (const key of Object.keys(fx)) {
        if (typeof impl[key] === 'function') fx[key] = impl[key];
    }
}

export function registerEngineSound(impl) {
    for (const key of Object.keys(sound)) {
        if (typeof impl[key] === 'function') sound[key] = impl[key];
    }
}

export function registerEngineHud(impl) {
    for (const key of Object.keys(hud)) {
        if (typeof impl[key] === 'function') hud[key] = impl[key];
    }
}

export function registerEngineWeapons(impl) {
    for (const key of Object.keys(weapons)) {
        if (typeof impl[key] === 'function') weapons[key] = impl[key];
    }
}

// Convenience: install legacy window.* shims that delegate to engineApi.
// Lets any straggler global call site keep working while we migrate.
// Pass { warn: true } to console.warn on each access — useful when
// hunting remaining call sites.
export function installLegacyWindowShims({ warn = false } = {}) {
    if (typeof window === 'undefined') return;
    const groups = { fx, sound, hud, weapons };
    for (const group of Object.values(groups)) {
        for (const key of Object.keys(group)) {
            if (warn) {
                Object.defineProperty(window, key, {
                    configurable: true,
                    get() {
                        console.warn(`[engineApi] window.${key} is deprecated; use engineApi.* instead`);
                        return group[key];
                    },
                });
            } else {
                window[key] = (...args) => group[key](...args);
            }
        }
    }
}
