// Explicit service container. Preferred over `appCore` for new code.
//
// Why a second container? `appCore` uses a Proxy + Object.defineProperty so
// every read goes through a getter. That works but hides what's available and
// has no per-key validation. `Services` is plain: register a factory once,
// resolve it once (memoized), throw loudly on unknown keys.
//
//   const services = new Services();
//   services.register('scene', () => scene);
//   services.register('camera', () => camera, { singleton: false }); // re-evaluate each get
//   const sceneRef = services.get('scene');
//
// New modules should take `services` (or specific dep refs from it) via
// their factory `deps` argument. Existing modules still read from `appCore`
// — both coexist.
//
// `singleton: true` (default) means the factory is called once and the value
// cached. `singleton: false` means the factory runs on every get(), which
// matches `appCore`'s live-binding behaviour for runtime-reassigned vars
// like `currentMesh`.

export class Services {
    constructor() {
        this._factories = new Map();
        this._cache = new Map();
        this._singleton = new Map();
    }

    register(key, factory, { singleton = true } = {}) {
        if (typeof key !== 'string' || !key) {
            throw new Error('[services] register() requires a non-empty string key');
        }
        if (typeof factory !== 'function') {
            throw new Error(`[services] register("${key}") requires a factory function`);
        }
        if (this._factories.has(key)) {
            throw new Error(`[services] duplicate registration for "${key}"`);
        }
        this._factories.set(key, factory);
        this._singleton.set(key, singleton);
    }

    has(key) {
        return this._factories.has(key);
    }

    get(key) {
        if (!this._factories.has(key)) {
            throw new Error(`[services] unknown service "${key}" — register() before get()`);
        }
        if (this._singleton.get(key)) {
            if (!this._cache.has(key)) {
                this._cache.set(key, this._factories.get(key)());
            }
            return this._cache.get(key);
        }
        return this._factories.get(key)();
    }

    keys() {
        return Array.from(this._factories.keys()).sort();
    }

    /** Drop the memoized value for a singleton key so the next get() re-runs
     * the factory. Useful for tests and hot-reload. */
    invalidate(key) {
        this._cache.delete(key);
    }

    clear() {
        this._factories.clear();
        this._cache.clear();
        this._singleton.clear();
    }
}
