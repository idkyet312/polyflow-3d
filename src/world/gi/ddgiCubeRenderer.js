import * as THREE from 'three';

/**
 * Round-robin CubeCamera capture.
 *
 * - Maintains a pool of low-res cube render targets (one per probe).
 * - Each tick captures `probesPerFrame` probes, advancing a round-robin cursor.
 * - WebGPU spike: r184 CubeCamera.update() calls renderer.render(). Under
 *   WebGPURenderer that path internally uses the async pipeline. We additionally
 *   guard with a manual six-face render fallback if needed.
 */

const FACE_DIRS = [
    { eye: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, -1, 0) },   // +X
    { eye: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, -1, 0) },  // -X
    { eye: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1) },    // +Y
    { eye: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, -1) },  // -Y
    { eye: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, -1, 0) },   // +Z
    { eye: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, -1, 0) },  // -Z
];

export function createCubeRenderer({ renderer, scene, faceSize = 16 }) {
    const targets = []; // index by probe index
    const cubeCamera = new THREE.CubeCamera(0.1, 200, null); // rt swapped per probe

    // Reusable per-face perspective camera for manual fallback.
    const faceCamera = new THREE.PerspectiveCamera(90, 1, 0.1, 200);

    const tmpPos = new THREE.Vector3();

    function ensureTarget(index) {
        let rt = targets[index];
        if (rt) return rt;
        rt = new THREE.WebGLCubeRenderTarget(faceSize, {
            type: THREE.HalfFloatType,
            format: THREE.RGBAFormat,
            generateMipmaps: false,
            magFilter: THREE.LinearFilter,
            minFilter: THREE.LinearFilter,
        });
        rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
        targets[index] = rt;
        return rt;
    }

    function getTarget(index) {
        return targets[index] || null;
    }

    function setFaceSize(size) {
        size = Math.max(4, size | 0);
        if (size === faceSize) return;
        faceSize = size;
        // Drop existing targets; they'll be recreated lazily.
        for (const rt of targets) rt?.dispose?.();
        targets.length = 0;
    }

    /**
     * Capture a single probe. Best-effort: try cubeCamera.update first, fall
     * back to manual six-face render via renderer.renderAsync.
     */
    async function captureProbe(index, worldPos, opts = {}) {
        const rt = ensureTarget(index);
        const layersMask = opts.layersMask;
        const overrideMaterial = opts.overrideMaterial || null;
        const prevOverride = scene.overrideMaterial;
        const prevBackground = opts.hideBackground ? scene.background : undefined;

        if (overrideMaterial) scene.overrideMaterial = overrideMaterial;
        if (opts.hideBackground) scene.background = null;

        try {
            // Path 1: CubeCamera.update — works under WebGL, attempt under WebGPU.
            cubeCamera.position.copy(worldPos);
            cubeCamera.renderTarget = rt;
            // Three's CubeCamera uses internal ortho-cube cameras tagged via .children.
            if (layersMask !== undefined) {
                for (const child of cubeCamera.children) child.layers.mask = layersMask;
            }
            // Sync cubeCamera children world matrix.
            cubeCamera.updateMatrixWorld(true);
            try {
                cubeCamera.update(renderer, scene);
            } catch (e) {
                // Path 2: manual six-face fallback.
                await captureManual(rt, worldPos, layersMask);
            }
        } finally {
            if (overrideMaterial) scene.overrideMaterial = prevOverride;
            if (opts.hideBackground) scene.background = prevBackground;
        }
        return rt;
    }

    async function captureManual(rt, worldPos, layersMask) {
        const prevTarget = renderer.getRenderTarget();
        const prevActiveCubeFace = renderer.getActiveCubeFace?.() ?? 0;

        faceCamera.position.copy(worldPos);
        if (layersMask !== undefined) faceCamera.layers.mask = layersMask;

        for (let f = 0; f < 6; f++) {
            const dir = FACE_DIRS[f];
            tmpPos.copy(worldPos).add(dir.eye);
            faceCamera.up.copy(dir.up);
            faceCamera.lookAt(tmpPos);
            faceCamera.updateMatrixWorld(true);

            renderer.setRenderTarget(rt, f);
            if (renderer.renderAsync) {
                await renderer.renderAsync(scene, faceCamera);
            } else {
                renderer.render(scene, faceCamera);
            }
        }

        renderer.setRenderTarget(prevTarget, prevActiveCubeFace);
    }

    function dispose() {
        for (const rt of targets) rt?.dispose?.();
        targets.length = 0;
    }

    return {
        captureProbe,
        getTarget,
        setFaceSize,
        get faceSize() { return faceSize; },
        dispose,
    };
}
