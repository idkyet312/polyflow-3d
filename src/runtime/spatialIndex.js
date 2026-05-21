import * as THREE from 'three';

function isValidBox(bounds) {
    return !!bounds
        && Number.isFinite(bounds.min?.x)
        && Number.isFinite(bounds.min?.y)
        && Number.isFinite(bounds.min?.z)
        && Number.isFinite(bounds.max?.x)
        && Number.isFinite(bounds.max?.y)
        && Number.isFinite(bounds.max?.z)
        && !bounds.isEmpty?.();
}

export function createSpatialIndex({ cellSize = 4 } = {}) {
    const resolvedCellSize = Math.max(0.001, Number(cellSize) || 4);
    const cells = new Map();
    const entries = new Map();
    const queryBounds = new THREE.Box3();
    const querySeen = new Set();

    function cellCoord(value) {
        return Math.floor(value / resolvedCellSize);
    }

    function cellKey(x, y, z) {
        return `${x},${y},${z}`;
    }

    function forEachCellKey(bounds, callback) {
        const minX = cellCoord(bounds.min.x);
        const minY = cellCoord(bounds.min.y);
        const minZ = cellCoord(bounds.min.z);
        const maxX = cellCoord(bounds.max.x);
        const maxY = cellCoord(bounds.max.y);
        const maxZ = cellCoord(bounds.max.z);

        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                for (let z = minZ; z <= maxZ; z++) {
                    callback(cellKey(x, y, z));
                }
            }
        }
    }

    function remove(actor) {
        const entry = entries.get(actor);
        if (!entry) return false;

        for (const key of entry.keys) {
            const cell = cells.get(key);
            if (!cell) continue;
            cell.delete(actor);
            if (cell.size === 0) {
                cells.delete(key);
            }
        }

        entries.delete(actor);
        return true;
    }

    function clear() {
        cells.clear();
        entries.clear();
    }

    function set(actor, bounds) {
        remove(actor);
        if (!actor || !isValidBox(bounds)) return false;

        const box = bounds.clone();
        const keys = [];

        forEachCellKey(box, (key) => {
            let cell = cells.get(key);
            if (!cell) {
                cell = new Set();
                cells.set(key, cell);
            }
            cell.add(actor);
            keys.push(key);
        });

        entries.set(actor, { actor, bounds: box, keys });
        return true;
    }

    function get(actor) {
        return entries.get(actor) ?? null;
    }

    function queryBox(bounds, out = null) {
        if (!isValidBox(bounds)) {
            if (out) out.length = 0;
            return out || [];
        }

        const result = out || [];
        if (out) result.length = 0;
        const seen = out ? querySeen : new Set();
        seen.clear();
        forEachCellKey(bounds, (key) => {
            const cell = cells.get(key);
            if (!cell) return;

            for (const actor of cell) {
                if (seen.has(actor)) continue;
                const entry = entries.get(actor);
                if (entry?.bounds?.intersectsBox(bounds)) {
                    seen.add(actor);
                    result.push(actor);
                }
            }
        });

        return result;
    }

    function queryBoxEntries(bounds) {
        return queryBox(bounds)
            .map((actor) => entries.get(actor))
            .filter(Boolean);
    }

    function querySphere(center, radius, out = null) {
        const safeRadius = Math.max(0, Number(radius) || 0);
        queryBounds.set(
            { x: center.x - safeRadius, y: center.y - safeRadius, z: center.z - safeRadius },
            { x: center.x + safeRadius, y: center.y + safeRadius, z: center.z + safeRadius }
        );

        const result = queryBox(queryBounds, out);
        let write = 0;
        for (let read = 0; read < result.length; read++) {
            const actor = result[read];
            if (entries.get(actor)?.bounds.distanceToPoint(center) <= safeRadius) {
                result[write++] = actor;
            }
        }
        result.length = write;
        return result;
    }

    function values() {
        return [...entries.values()];
    }

    function getStats() {
        return {
            cellSize: resolvedCellSize,
            cells: cells.size,
            actors: entries.size,
        };
    }

    return {
        clear,
        get,
        getStats,
        queryBox,
        queryBoxEntries,
        querySphere,
        remove,
        set,
        values,
    };
}
