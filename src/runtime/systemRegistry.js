// Typed system registry with declared ordering. Systems are pure functions
// of (deltaTime, ctx) — they don't return values, side effects via shared
// state / event bus. The registry sorts systems by their declared
// `before`/`after` dependencies (topological sort) so the run order is
// explicit and stable across registrations.
//
//   const sys = createSystemRegistry();
//   sys.register({
//       name: 'shooterAi',
//       update: (delta, ctx) => updateShooterAis(delta),
//       after: ['physics'],
//       before: ['projectiles'],
//   });
//   sys.tick(delta, ctx);
//
// Each system can be temporarily disabled with `setEnabled(name, false)`.
// `getOrder()` returns the resolved run order for diagnostics.
//
// Cycle detection: if A wants to run before B AND after B (directly or
// transitively), registration order falls through and a warning prints.
// Unknown deps are tolerated (a system referencing 'foo' when 'foo' is
// never registered is treated as "no constraint" — useful for optional
// systems that may not be installed in every build).
export function createSystemRegistry() {
    /** @type {Map<string, { name, update, before, after, enabled }>} */
    const systems = new Map();
    let orderCache = null;

    function register(spec) {
        if (!spec || typeof spec.name !== 'string' || typeof spec.update !== 'function') {
            throw new Error('[systemRegistry] register() requires { name: string, update: fn }');
        }
        if (systems.has(spec.name)) {
            throw new Error(`[systemRegistry] duplicate system name "${spec.name}"`);
        }
        systems.set(spec.name, {
            name: spec.name,
            update: spec.update,
            before: Array.isArray(spec.before) ? spec.before.slice() : [],
            after: Array.isArray(spec.after) ? spec.after.slice() : [],
            enabled: spec.enabled !== false,
        });
        orderCache = null;
    }

    function unregister(name) {
        if (systems.delete(name)) orderCache = null;
    }

    function setEnabled(name, enabled) {
        const sys = systems.get(name);
        if (sys) sys.enabled = !!enabled;
    }

    function has(name) {
        return systems.has(name);
    }

    /** Topologically sort systems into a stable run order.
     * Builds a "must run before" DAG: A's `before: ['B']` adds edge A→B,
     * B's `after: ['A']` adds the same edge. Then Kahn's algorithm with
     * insertion order as tie-breaker so registration order is preserved
     * when there's no constraint. */
    function computeOrder() {
        // Insertion order from Map iteration.
        const allNames = Array.from(systems.keys());
        const indexOf = new Map(allNames.map((n, i) => [n, i]));
        // edges[a] = set of names that must run AFTER a.
        const edges = new Map(allNames.map((n) => [n, new Set()]));
        const inDegree = new Map(allNames.map((n) => [n, 0]));

        function addEdge(from, to) {
            if (!systems.has(from) || !systems.has(to)) return; // tolerate unknown
            if (from === to) return;
            if (!edges.get(from).has(to)) {
                edges.get(from).add(to);
                inDegree.set(to, inDegree.get(to) + 1);
            }
        }

        for (const sys of systems.values()) {
            for (const target of sys.before) addEdge(sys.name, target);
            for (const source of sys.after) addEdge(source, sys.name);
        }

        // Kahn's algorithm with stable tie-break (lowest insertion index first).
        const ready = allNames
            .filter((n) => inDegree.get(n) === 0)
            .sort((a, b) => indexOf.get(a) - indexOf.get(b));
        const order = [];
        while (ready.length) {
            const n = ready.shift();
            order.push(n);
            // Sort newly-ready by insertion order for stability.
            const newlyReady = [];
            for (const next of edges.get(n)) {
                const d = inDegree.get(next) - 1;
                inDegree.set(next, d);
                if (d === 0) newlyReady.push(next);
            }
            newlyReady.sort((a, b) => indexOf.get(a) - indexOf.get(b));
            // Merge into ready preserving order; simple push works because we
            // re-sort ready when needed (here, we just append since the merge
            // happens at the end of each iter).
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

    function getOrder() {
        if (!orderCache) orderCache = computeOrder();
        return orderCache.slice();
    }

    function tick(delta, ctx) {
        if (!orderCache) orderCache = computeOrder();
        for (const name of orderCache) {
            const sys = systems.get(name);
            if (!sys || !sys.enabled) continue;
            try {
                sys.update(delta, ctx);
            } catch (err) {
                console.error(`[systemRegistry] system "${name}" threw:`, err);
            }
        }
    }

    return { register, unregister, setEnabled, has, getOrder, tick };
}
