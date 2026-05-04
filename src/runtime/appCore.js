// Shared mutable context bound by main.js so extracted modules can read
// engine-wide state through live getters without circular imports.

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
