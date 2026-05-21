// Pure helpers for the per-object script state + localStorage-backed draft
// store. Extracted from runtime.js. Owns:
//   - Event-state factory (createDefaultObjectEventState)
//   - Per-prop script state factory (createObjectScriptState)
//   - Draft sanitize / load / save / ensure-entry
//   - Runtime prop-id counter sync (used to keep auto-IDs unique after a
//     scene load that brought in actors with existing prop-ids).
//
// UI handlers (menu/editor open/close, keydown/pointerdown) stay in runtime.js
// because they need DOM elements + close callbacks declared there.
//
// Deps:
//   storageKey       - localStorage key (OBJECT_SCRIPT_STORAGE_KEY)
//   getObjectScriptState - () => shared { drafts: Object, nextPropId: number }
export function createObjectScriptStore({
    storageKey,
    getObjectScriptState,
}) {
    function createDefaultObjectEventState(eventName) {
        return {
            source: '',
            compiled: null,
            error: '',
            enabled: false,
            running: false,
            eventName,
            // UE lifecycle bookkeeping — populated lazily on first run.
            handles: null,
            beganPlay: false,
        };
    }

    function createObjectScriptState(propId = '') {
        return {
            propId,
            tick: createDefaultObjectEventState('tick'),
            collision: createDefaultObjectEventState('collision'),
            activeCollisions: new Set(),
        };
    }

    function sanitizeObjectScriptDrafts(rawValue) {
        if (!rawValue || typeof rawValue !== 'object') {
            return {};
        }

        const drafts = {};

        Object.entries(rawValue).forEach(([propId, value]) => {
            if (!value || typeof value !== 'object') return;

            drafts[propId] = {
                tick: typeof value.tick === 'string' ? value.tick : '',
                tickEnabled: value.tickEnabled === true,
                collision: typeof value.collision === 'string' ? value.collision : '',
            };
        });

        return drafts;
    }

    function readObjectScriptDrafts() {
        try {
            const rawValue = window.localStorage.getItem(storageKey);
            if (!rawValue) return {};
            return sanitizeObjectScriptDrafts(JSON.parse(rawValue));
        } catch (error) {
            console.warn('Failed to load object script drafts.', error);
            return {};
        }
    }

    function saveObjectScriptDrafts() {
        try {
            window.localStorage.setItem(
                storageKey,
                JSON.stringify(getObjectScriptState().drafts),
            );
        } catch (error) {
            console.warn('Failed to save object script drafts.', error);
        }
    }

    function ensureObjectScriptDraftEntry(propId) {
        if (!propId) {
            return { tick: '', tickEnabled: false, collision: '' };
        }

        const state = getObjectScriptState();
        if (!state.drafts[propId]) {
            state.drafts[propId] = {
                tick: '',
                tickEnabled: false,
                collision: '',
            };
        }

        return state.drafts[propId];
    }

    function syncRuntimePropIdCounter(propId) {
        if (typeof propId !== 'string') return;

        const match = /^prop-(\d+)$/.exec(propId);
        if (!match) return;

        const nextId = Number.parseInt(match[1], 10) + 1;
        if (Number.isFinite(nextId)) {
            const state = getObjectScriptState();
            state.nextPropId = Math.max(state.nextPropId, nextId);
        }
    }

    return {
        createDefaultObjectEventState,
        createObjectScriptState,
        sanitizeObjectScriptDrafts,
        readObjectScriptDrafts,
        saveObjectScriptDrafts,
        ensureObjectScriptDraftEntry,
        syncRuntimePropIdCounter,
    };
}
