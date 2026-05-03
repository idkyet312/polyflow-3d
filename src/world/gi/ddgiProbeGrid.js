import * as THREE from 'three';

export const DEFAULT_GRID_DIMS = { x: 8, y: 4, z: 8 };
export const DEFAULT_CELL_SIZE = 4.0;

export function createProbeGrid({
    dims = DEFAULT_GRID_DIMS,
    cellSize = DEFAULT_CELL_SIZE,
} = {}) {
    const state = {
        dims: { x: dims.x | 0, y: dims.y | 0, z: dims.z | 0 },
        cellSize,
        anchor: new THREE.Vector3(),
        bounds: new THREE.Vector3(),
    };

    function recomputeBounds() {
        state.bounds.set(
            state.dims.x * state.cellSize,
            state.dims.y * state.cellSize,
            state.dims.z * state.cellSize,
        );
    }

    recomputeBounds();

    const probeCount = () => state.dims.x * state.dims.y * state.dims.z;

    function probeIndex(ix, iy, iz) {
        return (iz * state.dims.y + iy) * state.dims.x + ix;
    }

    function probePosition(ix, iy, iz, out = new THREE.Vector3()) {
        return out.set(
            state.anchor.x + (ix + 0.5) * state.cellSize - state.bounds.x * 0.5,
            state.anchor.y + (iy + 0.5) * state.cellSize - state.bounds.y * 0.5,
            state.anchor.z + (iz + 0.5) * state.cellSize - state.bounds.z * 0.5,
        );
    }

    function probePositionByIndex(idx, out = new THREE.Vector3()) {
        const ix = idx % state.dims.x;
        const iy = ((idx / state.dims.x) | 0) % state.dims.y;
        const iz = (idx / (state.dims.x * state.dims.y)) | 0;
        return probePosition(ix, iy, iz, out);
    }

    /**
     * Snap anchor to camera position floored to cellSize. Returns true if anchor moved.
     */
    function snapAnchorTo(target) {
        const cs = state.cellSize;
        const nx = Math.floor(target.x / cs) * cs;
        const ny = Math.floor(target.y / cs) * cs;
        const nz = Math.floor(target.z / cs) * cs;
        if (nx !== state.anchor.x || ny !== state.anchor.y || nz !== state.anchor.z) {
            state.anchor.set(nx, ny, nz);
            return true;
        }
        return false;
    }

    /**
     * Returns 8 probe indices and trilinear weights for a world point.
     * Out object: { indices: Int32Array(8), weights: Float32Array(8) }
     * Indices clamped to grid; out-of-bounds points still get nearest probe sampling.
     */
    function lookup8(worldPoint, out) {
        out = out || { indices: new Int32Array(8), weights: new Float32Array(8) };
        const cs = state.cellSize;
        const halfX = state.bounds.x * 0.5;
        const halfY = state.bounds.y * 0.5;
        const halfZ = state.bounds.z * 0.5;
        const lx = (worldPoint.x - state.anchor.x + halfX) / cs - 0.5;
        const ly = (worldPoint.y - state.anchor.y + halfY) / cs - 0.5;
        const lz = (worldPoint.z - state.anchor.z + halfZ) / cs - 0.5;
        const ix = Math.floor(lx);
        const iy = Math.floor(ly);
        const iz = Math.floor(lz);
        const fx = lx - ix;
        const fy = ly - iy;
        const fz = lz - iz;
        const dx = state.dims.x - 1;
        const dy = state.dims.y - 1;
        const dz = state.dims.z - 1;
        let n = 0;
        for (let cz = 0; cz < 2; cz++) {
            for (let cy = 0; cy < 2; cy++) {
                for (let cx = 0; cx < 2; cx++) {
                    const px = THREE.MathUtils.clamp(ix + cx, 0, dx);
                    const py = THREE.MathUtils.clamp(iy + cy, 0, dy);
                    const pz = THREE.MathUtils.clamp(iz + cz, 0, dz);
                    out.indices[n] = probeIndex(px, py, pz);
                    const wx = cx ? fx : 1 - fx;
                    const wy = cy ? fy : 1 - fy;
                    const wz = cz ? fz : 1 - fz;
                    out.weights[n] = wx * wy * wz;
                    n++;
                }
            }
        }
        return out;
    }

    function setDims(dims) {
        state.dims.x = Math.max(2, dims.x | 0);
        state.dims.y = Math.max(2, dims.y | 0);
        state.dims.z = Math.max(2, dims.z | 0);
        recomputeBounds();
    }

    function setCellSize(cellSize) {
        state.cellSize = Math.max(0.05, +cellSize);
        recomputeBounds();
    }

    return {
        state,
        get dims() { return state.dims; },
        get cellSize() { return state.cellSize; },
        get anchor() { return state.anchor; },
        get bounds() { return state.bounds; },
        probeCount,
        probeIndex,
        probePosition,
        probePositionByIndex,
        snapAnchorTo,
        lookup8,
        setDims,
        setCellSize,
    };
}
