export const SYSTEM_PHASES = Object.freeze(['input', 'gameplay', 'physics', 'render', 'editor']);

function defaultNow() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function emptyPhaseMetrics() {
    const phases = {};
    for (const phase of SYSTEM_PHASES) {
        phases[phase] = { total: 0, systems: [] };
    }
    return phases;
}

function cloneMetrics(metrics) {
    return {
        total: metrics.total,
        phases: Object.fromEntries(
            Object.entries(metrics.phases).map(([phase, value]) => [
                phase,
                {
                    total: value.total,
                    systems: value.systems.map((entry) => ({ ...entry })),
                },
            ]),
        ),
        systems: metrics.systems.map((entry) => ({ ...entry })),
        slow: metrics.slow.map((entry) => ({ ...entry })),
    };
}

// Phased, timed system registry with declared ordering. Systems are pure
// functions of (deltaTime, ctx). `before`/`after` dependencies are topologically
// sorted inside the active phase; unknown deps are tolerated for optional
// systems. `tick()` runs all systems, `tickPhase()` runs one of:
// input/gameplay/physics/render/editor.
export function createSystemRegistry({
    phases = SYSTEM_PHASES,
    slowThresholdMs = 2,
    now = defaultNow,
    timing = true,
} = {}) {
    const phaseSet = new Set(phases);
    const systems = new Map();
    const orderCache = new Map();
    let metrics = {
        total: 0,
        phases: emptyPhaseMetrics(),
        systems: [],
        slow: [],
    };

    function invalidateOrder() {
        orderCache.clear();
    }

    function normalizePhase(phase) {
        return phaseSet.has(phase) ? phase : 'gameplay';
    }

    function register(spec) {
        if (!spec || typeof spec.name !== 'string' || typeof spec.update !== 'function') {
            throw new Error('[systemRegistry] register() requires { name: string, update: fn }');
        }
        if (systems.has(spec.name)) {
            throw new Error(`[systemRegistry] duplicate system name "${spec.name}"`);
        }
        systems.set(spec.name, {
            name: spec.name,
            phase: normalizePhase(spec.phase),
            update: spec.update,
            before: Array.isArray(spec.before) ? spec.before.slice() : [],
            after: Array.isArray(spec.after) ? spec.after.slice() : [],
            enabled: spec.enabled !== false,
        });
        invalidateOrder();
    }

    function unregister(name) {
        if (systems.delete(name)) invalidateOrder();
    }

    function setEnabled(name, enabled) {
        const sys = systems.get(name);
        if (sys) sys.enabled = !!enabled;
    }

    function has(name) {
        return systems.has(name);
    }

    function computeOrder(phase = null) {
        const allNames = Array.from(systems.keys()).filter((name) => {
            const sys = systems.get(name);
            return !phase || sys.phase === phase;
        });
        const selected = new Set(allNames);
        const indexOf = new Map(allNames.map((n, i) => [n, i]));
        const edges = new Map(allNames.map((n) => [n, new Set()]));
        const inDegree = new Map(allNames.map((n) => [n, 0]));

        function addEdge(from, to) {
            if (!selected.has(from) || !selected.has(to)) return;
            if (from === to) return;
            if (!edges.get(from).has(to)) {
                edges.get(from).add(to);
                inDegree.set(to, inDegree.get(to) + 1);
            }
        }

        for (const sys of systems.values()) {
            if (phase && sys.phase !== phase) continue;
            for (const target of sys.before) addEdge(sys.name, target);
            for (const source of sys.after) addEdge(source, sys.name);
        }

        const ready = allNames
            .filter((n) => inDegree.get(n) === 0)
            .sort((a, b) => indexOf.get(a) - indexOf.get(b));
        const order = [];
        while (ready.length) {
            const n = ready.shift();
            order.push(n);
            const newlyReady = [];
            for (const next of edges.get(n)) {
                const d = inDegree.get(next) - 1;
                inDegree.set(next, d);
                if (d === 0) newlyReady.push(next);
            }
            newlyReady.sort((a, b) => indexOf.get(a) - indexOf.get(b));
            for (const r of newlyReady) ready.push(r);
            ready.sort((a, b) => indexOf.get(a) - indexOf.get(b));
        }

        if (order.length < allNames.length) {
            const unresolved = allNames.filter((n) => !order.includes(n));
            console.warn('[systemRegistry] cycle detected, falling back to insertion order for:', unresolved);
            for (const n of unresolved) order.push(n);
        }

        return order;
    }

    function getOrder(phase = null) {
        const cacheKey = phase || '*';
        if (!orderCache.has(cacheKey)) {
            orderCache.set(cacheKey, computeOrder(phase));
        }
        return orderCache.get(cacheKey).slice();
    }

    function resetMetrics() {
        metrics = {
            total: 0,
            phases: emptyPhaseMetrics(),
            systems: [],
            slow: [],
        };
    }

    function runOrder(order, delta, ctx) {
        for (const name of order) {
            const sys = systems.get(name);
            if (!sys || !sys.enabled) continue;

            const t0 = timing ? now() : 0;
            try {
                sys.update(delta, ctx);
            } catch (err) {
                console.error(`[systemRegistry] system "${name}" threw:`, err);
            } finally {
                if (timing) {
                    const duration = Math.max(0, now() - t0);
                    const entry = { name, phase: sys.phase, duration };
                    metrics.total += duration;
                    metrics.systems.push(entry);
                    if (!metrics.phases[sys.phase]) {
                        metrics.phases[sys.phase] = { total: 0, systems: [] };
                    }
                    metrics.phases[sys.phase].total += duration;
                    metrics.phases[sys.phase].systems.push(entry);
                    if (duration >= slowThresholdMs) metrics.slow.push(entry);
                }
            }
        }
    }

    function tick(delta, ctx) {
        resetMetrics();
        runOrder(getOrder(null), delta, ctx);
        return getLastMetrics();
    }

    function tickPhase(phase, delta, ctx) {
        resetMetrics();
        runOrder(getOrder(normalizePhase(phase)), delta, ctx);
        return getLastMetrics();
    }

    function getLastMetrics() {
        return cloneMetrics(metrics);
    }

    function getSlowSystems(limit = 5) {
        return metrics.slow
            .slice()
            .sort((a, b) => b.duration - a.duration)
            .slice(0, limit)
            .map((entry) => ({ ...entry }));
    }

    return {
        register,
        unregister,
        setEnabled,
        has,
        getOrder,
        tick,
        tickPhase,
        getLastMetrics,
        getSlowSystems,
    };
}
