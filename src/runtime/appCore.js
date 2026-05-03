// Shared mutable context bound by main.js so the modules extracted out of the
// (formerly 436 KB) root main.js can read engine-wide state (scene, camera,
// gameplay, vehicle state, etc.) via live bindings without circular imports.
//
// Pattern:
//   - main.js calls bindAppCore({ scene: () => scene, camera: () => camera, ... })
//     once after the module-scope variables are declared. Property getters mean
//     `core.scene` always returns the current value of `scene` even after
//     reassignment inside main.js.
//   - extracted modules: import { core } from '../runtime/appCore.js'
//     and inside each exported function start with
//       const { scene, camera /* etc */ } = core;
//     This snapshots the current value for that call without circular import
//     hazards.
//
// For mutations, modules should mutate fields on already-bound state objects
// (e.g. `gameplay.active = true`, `vehicleState.activePropId = ''`). For
// whole-variable reassignments owned by main.js (e.g. `currentMesh = ...`),
// main.js should expose a setter via setAppCore('currentMesh', value).

export const core = {};

const _setters = {};

export function bindAppCore(getters, setters = {}) {
    for (const [key, getter] of Object.entries(getters)) {
        Object.defineProperty(core, key, {
            get: getter,
            configurable: true,
            enumerable: true,
        });
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
