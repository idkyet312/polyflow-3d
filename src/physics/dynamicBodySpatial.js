import * as THREE from 'three';
import { createSpatialIndex } from '../runtime/spatialIndex.js';

export function createDynamicBodySpatialIndex({
    physics,
    cellSize = 4,
    getActorRenderObject,
}) {
    const index = createSpatialIndex({ cellSize });
    const bounds = new THREE.Box3();

    function remove(actor) {
        return index.remove(actor);
    }

    function clear() {
        index.clear();
    }

    function updateEntry(actor) {
        const mesh = getActorRenderObject(actor);
        if (!mesh) {
            remove(actor);
            return null;
        }

        mesh.updateWorldMatrix?.(true, true);
        bounds.setFromObject(mesh);
        if (!index.set(actor, bounds)) {
            return null;
        }

        return index.get(actor);
    }

    function refresh() {
        clear();
        for (let bodyIndex = 0; bodyIndex < physics.dynamicBodies.length; bodyIndex++) {
            updateEntry(physics.dynamicBodies[bodyIndex]);
        }
    }

    function getIndex() {
        if (index.getStats().actors !== physics.dynamicBodies.length) {
            refresh();
        }
        return index;
    }

    function querySphere(center, radius) {
        return getIndex().querySphere(center, radius);
    }

    return {
        clear,
        getIndex,
        querySphere,
        refresh,
        remove,
        updateEntry,
    };
}
