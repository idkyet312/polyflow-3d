// Tiny event bus for cross-system decoupling. Pub/sub by string topic; no
// allocations on emit (uses a single shared listener array per topic with a
// length-snapshot at the start of dispatch so subscribers added mid-emit
// don't fire this round, and unsubscribers don't cause skipped slots).
//
// Use for: 1→many fan-out where caller does not need a return value AND
// listeners are independent (audio doesn't care about HUD, etc).
// Do NOT use for: request/response, ordered pipelines, or anything where
// a missing listener would be a bug — use direct injection there.
//
//   const bus = createEventBus();
//   const off = bus.on('player:damaged', ({ amount, source }) => { ... });
//   bus.emit('player:damaged', { amount: 0.1, source: enemy });
//   off();
//
// `once(topic, fn)` auto-unsubscribes after the first delivery.
// `clear(topic?)` removes all listeners for one topic or every topic.
// `listenerCount(topic)` is for tests/diagnostics.
export function createEventBus() {
    /** @type {Map<string, Array<Function>>} */
    const listeners = new Map();

    function on(topic, fn) {
        if (typeof topic !== 'string' || typeof fn !== 'function') {
            return () => {};
        }
        let arr = listeners.get(topic);
        if (!arr) {
            arr = [];
            listeners.set(topic, arr);
        }
        arr.push(fn);
        return () => off(topic, fn);
    }

    /** Depth of in-flight emit() calls. Non-zero means an unsubscribe must
     * null the slot instead of splicing, so subsequent indices in the
     * dispatch loop don't shift out from under us. */
    let dispatching = 0;

    function compact(arr, topic) {
        let w = 0;
        for (let r = 0; r < arr.length; r++) {
            if (arr[r] != null) {
                if (w !== r) arr[w] = arr[r];
                w++;
            }
        }
        arr.length = w;
        if (arr.length === 0) listeners.delete(topic);
    }

    function off(topic, fn) {
        const arr = listeners.get(topic);
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx < 0) return;
        if (dispatching > 0) {
            // Tombstone — emit() skips nulls; compact happens after dispatch.
            arr[idx] = null;
        } else {
            arr.splice(idx, 1);
            if (arr.length === 0) listeners.delete(topic);
        }
    }

    function once(topic, fn) {
        const wrapped = (payload) => {
            off(topic, wrapped);
            fn(payload);
        };
        return on(topic, wrapped);
    }

    function emit(topic, payload) {
        const arr = listeners.get(topic);
        if (!arr || arr.length === 0) return;
        // Snapshot length so handlers that subscribe during dispatch don't
        // fire this round. Tombstoned (null) slots are skipped.
        const n = arr.length;
        dispatching++;
        try {
            for (let i = 0; i < n; i++) {
                const fn = arr[i];
                if (!fn) continue;
                try {
                    fn(payload);
                } catch (err) {
                    // One bad subscriber should not break the rest of the bus.
                    console.error(`[eventBus] listener for "${topic}" threw:`, err);
                }
            }
        } finally {
            dispatching--;
            if (dispatching === 0) compact(arr, topic);
        }
    }

    function clear(topic) {
        if (topic == null) {
            listeners.clear();
        } else {
            listeners.delete(topic);
        }
    }

    function listenerCount(topic) {
        return listeners.get(topic)?.length ?? 0;
    }

    return { on, off, once, emit, clear, listenerCount };
}
