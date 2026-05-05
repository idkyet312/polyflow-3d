// src/world/splat/sortClient.js
//
// Phase 3a — main-thread wrapper for sortWorker.js.
//
// Responsibilities:
//   - Construct the Worker (Vite picks it up via `new URL(...)` + import.meta.url).
//   - Transfer the immutable per-splat positions to the worker once, on init.
//   - Per-frame: post {camLocal, mvpLocal} sort requests with strict
//     coalescing — at most ONE in-flight request and ONE pending request.
//     Newer pending requests overwrite older ones (only the latest camera
//     state matters; a stale request is dead weight).
//   - Recycle the indices buffer: when the worker returns indices and the
//     consumer is done with them, ship the same buffer back on the next
//     sort request so the worker doesn't have to allocate a fresh
//     Uint32Array per frame (zero-alloc steady state after warmup).
//
// Why callbacks not Promises: a consumer that misses a frame's result
// because the next request has already preempted it doesn't want a
// pending Promise rejecting / leaking. Callbacks fire only for the
// request whose result actually came back, others are dropped silently.

export class SortClient {
    constructor() {
        this._worker        = null;
        this._ready         = false;
        this._inflight      = false;
        this._pending       = null;     // { camLocal:[3], mvpLocal:Float32Array(16)|null, cullMargin, callback }
        this._currentCb     = null;     // callback for the in-flight request
        this._nextSortId    = 1;
        this._recycleBuffer = null;     // ArrayBuffer (count * 4) ping-ponging between client and worker
        this._count         = 0;
    }

    /**
     * Construct the worker and send it the immutable per-splat positions.
     * Call once per splat actor. The provided `positions` Float32Array is
     * transferred (ownership moves to the worker — the caller's reference
     * becomes a zero-length array).
     */
    init(positionsToTransfer, count) {
        if (this._worker) {
            console.warn('[SortClient] init called twice; ignoring.');
            return;
        }
        try {
            this._worker = new Worker(
                new URL('./sortWorker.js', import.meta.url),
                { type: 'module' },
            );
        } catch (err) {
            console.warn('[SortClient] Worker construction failed; sort disabled.', err);
            this._worker = null;
            return;
        }
        this._count = count | 0;

        this._worker.onmessage = (e) => this._onMessage(e.data);
        this._worker.onerror   = (err) => {
            console.warn('[SortClient] worker error; sort will stop.', err);
            this._ready = false;
            this._inflight = false;
            this._pending = null;
        };

        this._worker.postMessage(
            { type: 'init', positions: positionsToTransfer, count: this._count },
            [positionsToTransfer.buffer],
        );
    }

    /**
     * Request a sort for the current camera state. May coalesce with a
     * prior pending request — only the latest camLocal is honored.
     *
     * @param {[number,number,number]|Float32Array} camLocal — camera position in mesh-local space.
     * @param {Float32Array|null} mvpLocal — 4x4 column-major MVP (proj*view*model). Pass null to skip cull.
     * @param {number} cullMargin — NDC margin for cull (typical 1.5). 0 disables even if mvp provided.
     * @param {(indices: Uint32Array, visibleCount: number, recycledBuffer: ArrayBuffer) => void} callback
     *        called when this specific request's sort result lands. The callback should:
     *          - read the indices it needs out of `indices`
     *          - call `recycle(recycledBuffer)` afterward so the buffer is
     *            shipped back to the worker on the next request.
     */
    requestSort(camLocal, viewLocal, mvpLocal, cullMargin, callback) {
        if (!this._ready) return;

        const req = { camLocal, viewLocal, mvpLocal, cullMargin, callback };
        if (this._inflight) {
            // Coalesce: latest pending wins. Discard any older pending.
            this._pending = req;
            return;
        }
        this._dispatch(req);
    }

    /**
     * Hand a buffer back to the client so it can be transferred to the
     * worker on the next sort request (zero-alloc steady state). It's safe
     * to call this with any ArrayBuffer of the right byte length; mismatched
     * sizes are silently dropped (worker re-allocates).
     */
    recycle(buffer) {
        if (buffer && buffer.byteLength === this._count * 4) {
            this._recycleBuffer = buffer;
        }
    }

    /** Tear down. After this the client is dead — construct a new one to use again. */
    dispose() {
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
        this._ready = false;
        this._inflight = false;
        this._pending = null;
        this._currentCb = null;
        this._recycleBuffer = null;
    }

    // ---- internals -------------------------------------------------------

    _dispatch(req) {
        const sortId = this._nextSortId++;
        this._currentCb = req.callback;
        this._inflight  = true;

        // Tiny payloads: structured-clone (don't transfer). The frame-to-frame
        // copy of 12 + 64 bytes is below GC noise.
        const payload = {
            type:      'sort',
            sortId,
            camLocal:  Array.isArray(req.camLocal)
                ? req.camLocal
                : [req.camLocal[0], req.camLocal[1], req.camLocal[2]],
            viewLocal: Array.isArray(req.viewLocal)
                ? req.viewLocal
                : [req.viewLocal[0], req.viewLocal[1], req.viewLocal[2]],
            mvpLocal:  req.mvpLocal || null,
            cullMargin: req.cullMargin || 0,
        };

        const transfers = [];
        if (this._recycleBuffer) {
            payload.recycle = this._recycleBuffer;
            transfers.push(this._recycleBuffer);
            this._recycleBuffer = null;
        }

        this._worker.postMessage(payload, transfers);
    }

    _onMessage(msg) {
        if (msg.type === 'inited') {
            this._ready = true;
            return;
        }
        if (msg.type === 'sorted') {
            const cb = this._currentCb;
            this._currentCb = null;
            this._inflight = false;

            if (cb) {
                try {
                    cb(msg.indices, msg.visibleCount, msg.indices.buffer);
                } catch (err) {
                    console.warn('[SortClient] callback threw; recovering.', err);
                }
            }

            // Drain pending if any (latest-wins).
            if (this._pending) {
                const p = this._pending;
                this._pending = null;
                this._dispatch(p);
            }
        }
    }
}
