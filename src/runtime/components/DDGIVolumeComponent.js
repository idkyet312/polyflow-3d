import * as THREE from 'three';
import { ActorComponent } from './ActorComponent.js';
import { getDDGIManager } from '../../world/gi/ddgiManager.js';

const DEFAULT_DIMS = { x: 8, y: 4, z: 8 };
const _tmpSize = new THREE.Vector3();
const _tmpWorldScale = new THREE.Vector3();
const _tmpBox = new THREE.Box3();

export class DDGIVolumeComponent extends ActorComponent {
    static componentKey = 'DDGIVolumeComponent';

    constructor({
        gridDims = DEFAULT_DIMS,
        cellSize = 4.0,
        intensity = 0.58,
        hysteresis = 0.97,
        normalBias = 0.4,
        probesPerFrame = 4,
    } = {}) {
        super();
        this.gridDims = { x: gridDims.x | 0, y: gridDims.y | 0, z: gridDims.z | 0 };
        this.cellSize = +cellSize;
        this.intensity = +intensity;
        this.hysteresis = +hysteresis;
        this.normalBias = +normalBias;
        this.probesPerFrame = probesPerFrame | 0;
        this._registered = false;
    }

    beginPlay() {
        const mgr = getDDGIManager();
        mgr.registerVolume(this);
        this._registered = true;
    }

    endPlay() {
        if (this._registered) {
            getDDGIManager().unregisterVolume(this);
            this._registered = false;
        }
    }

    /** Volume bounds in world space, sourced from the owning actor's mesh box. */
    containsPoint(point) {
        const mesh = this.owner?.mesh || this.owner?.root;
        if (!mesh) return false;
        const box = new THREE.Box3().setFromObject(mesh);
        return box.containsPoint(point);
    }

    getOwnerVolumeSize(out = new THREE.Vector3()) {
        const mesh = this.owner?.mesh || this.owner?.root;
        if (!mesh) return out.set(0, 0, 0);

        const geometry = mesh.geometry;
        geometry?.computeBoundingBox?.();
        if (geometry?.boundingBox) {
            out.copy(geometry.boundingBox.getSize(_tmpSize));
            mesh.getWorldScale(_tmpWorldScale);
            out.x *= Math.abs(_tmpWorldScale.x);
            out.y *= Math.abs(_tmpWorldScale.y);
            out.z *= Math.abs(_tmpWorldScale.z);
            return out;
        }

        _tmpBox.setFromObject(mesh);
        if (_tmpBox.isEmpty()) return out.set(0, 0, 0);
        return _tmpBox.getSize(out);
    }

    syncCellSizeToOwnerBounds() {
        const size = this.getOwnerVolumeSize(_tmpSize);
        this.cellSize = Math.max(
            size.x / Math.max(2, this.gridDims.x),
            size.y / Math.max(2, this.gridDims.y),
            size.z / Math.max(2, this.gridDims.z),
            0.05,
        );
        return this.cellSize;
    }

    getProbeCount() {
        return this.gridDims.x * this.gridDims.y * this.gridDims.z;
    }

    setGridDims(x, y, z) {
        this.gridDims.x = Math.max(2, x | 0);
        this.gridDims.y = Math.max(2, y | 0);
        this.gridDims.z = Math.max(2, z | 0);
        if (this.owner) this.syncCellSizeToOwnerBounds();
        return this.gridDims;
    }

    setCellSize(v) {
        this.cellSize = Math.max(0.05, +v);
        return this.cellSize;
    }

    serialize() {
        return {
            gridDims: { ...this.gridDims },
            cellSize: this.cellSize,
            intensity: this.intensity,
            hysteresis: this.hysteresis,
            normalBias: this.normalBias,
            probesPerFrame: this.probesPerFrame,
        };
    }

    static deserialize(data = {}) {
        return new DDGIVolumeComponent(data);
    }
}
