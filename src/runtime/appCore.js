// Shared mutable context bound by runtime.js so the modules extracted out of
// the (formerly 436 KB) root main.js can read engine-wide state (scene,
// camera, gameplay, vehicle state, etc.) via live bindings without circular
// imports.
//
// Pattern:
//   - runtime.js calls bindAppCore({ scene: () => scene, camera: () => camera, ... })
//     once after the module-scope variables are declared. Property getters mean
//     `core.scene` always returns the current value of `scene` even after
//     reassignment inside runtime.js.
//   - extracted modules: import { core } from '../runtime/appCore.js'
//     and inside each exported function start with
//       const { scene, camera /* etc */ } = core;
//     This snapshots the current value for that call without circular import
//     hazards.
//
// For mutations, modules should mutate fields on already-bound state objects
// (e.g. `gameplay.active = true`, `vehicleState.activePropId = ''`). For
// whole-variable reassignments owned by runtime.js (e.g. `currentMesh = ...`),
// runtime.js should expose a setter via setAppCore('currentMesh', value).
//
// Known bound keys (audit by greping `core.<name>` across src/):
//   scene, camera, renderer, currentMesh, gameplay, vehicleState, physics,
//   sceneSystem, mainDirectionalLight, ... (see runtime.js bindAppCore call).
//
// Reading an unbound key returns `undefined` and logs a one-shot warning so
// refactors that miss a binding fail loudly instead of silently. Each missing
// key only warns once per process — this keeps the log readable when a
// subsystem polls an unbound key every frame during incremental refactoring.
//
// Will be replaced by an explicit Services container in a later phase once the
// gameplay subsystems have been extracted and their dependency surface is
// known.

const _warned = new Set();
const _bound = new Set();

export const core = new Proxy({}, {
    get(target, key) {
        if (typeof key !== 'string') return target[key];
        if (key in target) return target[key];
        if (!_bound.has(key) && !_warned.has(key)) {
            _warned.add(key);
            // eslint-disable-next-line no-console
            console.warn(`[appCore] read of unbound key "${key}" — returning undefined (only logged once)`);
        }
        return undefined;
    },
    has(target, key) {
        return key in target;
    },
});

const _setters = {};

export function bindAppCore(getters, setters = {}) {
    for (const [key, getter] of Object.entries(getters)) {
        Object.defineProperty(core, key, {
            get: getter,
            configurable: true,
            enumerable: true,
        });
        _bound.add(key);
    }
    for (const [key, setter] of Object.entries(setters)) {
        _setters[key] = setter;
    }
}

export function setAppCore(key, value) {
    const setter = _setters[key];
    if (typeof setter !== 'function') {
        throw new Error(`appCore: no setter registered for "${key}"`);
    }
    setter(value);
}

export function getBoundAppCoreKeys() {
    return Array.from(_bound).sort();
}
