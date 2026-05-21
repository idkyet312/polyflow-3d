// Dev-only registry of named engine internals (eventBus, asset registries,
// system registry, scene root, ...). Replaces ad-hoc `window.__eventBus = ...`
// scattered across runtime.js.
//
// Production builds: register() is a no-op, nothing leaks to globalThis.
// Dev builds (or ?debug=1 in URL): a single namespace `__POLYFLOW_DEBUG__` is
// attached to globalThis. Each register() adds a property to it. DevTools can
// reach internals via `__POLYFLOW_DEBUG__.eventBus`, etc.
//
// Why one namespace not seven? Easier to discover, easier to grep, easier to
// nuke. Lint can ban `window.__*` writes outside this file.
//
//   import { registerDebug } from '../runtime/debugRegistry.js';
//   registerDebug('eventBus', eventBus);

const NAMESPACE = '__POLYFLOW_DEBUG__';

function isDebugEnabled() {
    if (typeof globalThis === 'undefined') return false;
    // Vite: import.meta.env.DEV is true in dev server + dev build.
    try {
        if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) return true;
    } catch (_) { /* import.meta not available in some loaders */ }
    // URL override: ?debug=1
    try {
        if (typeof location !== 'undefined' && /[?&]debug=1\b/.test(location.search || '')) {
            return true;
        }
    } catch (_) { /* no location in node */ }
    // Node test harness: process.env.POLYFLOW_DEBUG=1
    try {
        if (typeof process !== 'undefined' && process.env?.POLYFLOW_DEBUG === '1') return true;
    } catch (_) { /* no process */ }
    return false;
}

function getOrCreateBag() {
    if (!isDebugEnabled()) return null;
    if (typeof globalThis === 'undefined') return null;
    if (!globalThis[NAMESPACE]) {
        Object.defineProperty(globalThis, NAMESPACE, {
            value: {},
            configurable: true,
            enumerable: false,
            writable: false,
        });
    }
    return globalThis[NAMESPACE];
}

export function registerDebug(name, ref) {
    const bag = getOrCreateBag();
    if (!bag) return;
    bag[name] = ref;
}

export function getDebug(name) {
    if (typeof globalThis === 'undefined') return undefined;
    return globalThis[NAMESPACE]?.[name];
}

export function clearDebug() {
    if (typeof globalThis === 'undefined') return;
    if (globalThis[NAMESPACE]) {
        for (const key of Object.keys(globalThis[NAMESPACE])) {
            delete globalThis[NAMESPACE][key];
        }
    }
}
