import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { assetRegistry } from '../runtime/assets/AssetRegistry.js';

const ENVIRONMENTS = {
    'sunny-sky': {
        label: '\u2600\ufe0f Sunny Sky',
        slug: 'kloofendal_48d_partly_cloudy_puresky',
        blurriness: 0.05,
        pedestal: { color: 0xFFFFFF, roughness: 0.00, metalness: 1.0 },
        ambient: { color: 0xffffff, intensity: 1.0 },
        hemi: { sky: 0xffffff, ground: 0x444444, intensity: 1.2 },
    },
    'studio': {
        label: '\ud83c\udfac Studio',
        slug: 'studio_small_03',
        blurriness: 0.3,
        pedestal: { color: 0x1a1a1a, roughness: 0.05, metalness: 0.95 },
        ambient: { color: 0xffffff, intensity: 1.3 },
        hemi: { sky: 0xffffff, ground: 0x888888, intensity: 0.8 },
    },
    'urban-street': {
        label: '\ud83c\udfd9\ufe0f Urban Street',
        slug: 'potsdamer_platz',
        blurriness: 0.0,
        pedestal: { color: 0x1c1c1c, roughness: 0.05, metalness: 0.95 },
        ambient: { color: 0x8899bb, intensity: 0.7 },
        hemi: { sky: 0x9aaad0, ground: 0x222233, intensity: 1.0 },
    },
    'forest-trail': {
        label: '\ud83c\udf32 Forest Trail',
        slug: 'forest_slope',
        blurriness: 0.08,
        pedestal: { color: 0x2b3d1f, roughness: 0.05, metalness: 0.95 },
        ambient: { color: 0x88aa66, intensity: 0.9 },
        hemi: { sky: 0x99cc77, ground: 0x334422, intensity: 1.2 },
    },
    'golden-sunset': {
        label: '\ud83c\udf05 Golden Sunset',
        slug: 'golden_bay',
        blurriness: 0.04,
        pedestal: { color: 0x2a1f0f, roughness: 0.05, metalness: 0.95 },
        ambient: { color: 0xffbb55, intensity: 1.0 },
        hemi: { sky: 0xffaa33, ground: 0x441100, intensity: 1.0 },
    },
};

function getHdriUrl(slug, resolution) {
    return assetRegistry.resolveHdri(slug, resolution);
}

export function createEnvironmentController({ scene, getAmbientLight, getHemiLight }) {
    const hdriCache = {};
    const hdriPendingLoads = {};
    let currentEnvironment = 'sunny-sky';
    let currentResolution = '1k';

    // World Environment toggle state. When disabled, the HDR sky + IBL are
    // cleared from the scene but the cached texture is preserved so re-enable
    // restores the exact prior look without re-fetching.
    let enabled = true;
    let pendingTexture = null;
    let pendingBlurriness = 0;

    function applyTextureToScene(texture, blurriness) {
        if (enabled) {
            scene.environment = texture;
            scene.background = texture;
            scene.backgroundBlurriness = blurriness;
        }
        // Always remember what we'd apply, so re-enabling picks up the latest.
        pendingTexture = texture;
        pendingBlurriness = blurriness;
    }

    async function loadHdriTexture(url) {
        if (hdriCache[url]) {
            return hdriCache[url];
        }

        if (!hdriPendingLoads[url]) {
            console.log(`Loading HDRI: ${url}`);
            const loader = new HDRLoader();
            hdriPendingLoads[url] = loader.loadAsync(url)
                .then((texture) => {
                    texture.mapping = THREE.EquirectangularReflectionMapping;
                    hdriCache[url] = texture;
                    console.log(`Successfully loaded HDRI: ${url}`);
                    return texture;
                })
                .catch((error) => {
                    console.error('Failed to load HDRI:', url, error);
                    throw error;
                })
                .finally(() => {
                    delete hdriPendingLoads[url];
                });
        }

        return hdriPendingLoads[url];
    }

    async function loadHdriIntoScene(url, blurriness) {
        const texture = await loadHdriTexture(url);
        applyTextureToScene(texture, blurriness);
        return texture;
    }

    async function switchEnvironment(key) {
        const environment = ENVIRONMENTS[key];
        if (!environment) return;

        currentEnvironment = key;

        const ambientLight = getAmbientLight?.();
        if (ambientLight) {
            ambientLight.color.setHex(environment.ambient.color);
            ambientLight.intensity = environment.ambient.intensity;
        }

        const hemiLight = getHemiLight?.();
        if (hemiLight) {
            hemiLight.color.setHex(environment.hemi.sky);
            hemiLight.groundColor.setHex(environment.hemi.ground);
            hemiLight.intensity = environment.hemi.intensity;
        }

        return loadHdriIntoScene(getHdriUrl(environment.slug, currentResolution), environment.blurriness);
    }

    async function setResolution(resolution) {
        currentResolution = resolution;

        document.querySelectorAll('.res-btn').forEach((button) => {
            button.classList.toggle('res-btn-active', button.dataset.res === resolution);
        });

        return switchEnvironment(currentEnvironment);
    }

    // World Environment control: toggle the IBL/sky on/off without losing the
    // active preset. When off, scene.environment + scene.background are cleared
    // (so reflections go matte and the sky drops to the renderer clear color).
    function setEnabled(next) {
        const v = !!next;
        if (enabled === v) return;
        enabled = v;
        if (enabled) {
            if (pendingTexture) {
                scene.environment = pendingTexture;
                scene.background = pendingTexture;
                scene.backgroundBlurriness = pendingBlurriness;
            }
        } else {
            scene.environment = null;
            scene.background = null;
        }
    }

    function setBackgroundBlurriness(value) {
        const numeric = Number.isFinite(value) ? value : pendingBlurriness;
        pendingBlurriness = THREE.MathUtils.clamp(numeric, 0, 1);
        if (enabled) {
            scene.backgroundBlurriness = pendingBlurriness;
        }
    }

    return {
        switchEnvironment,
        setResolution,
        setEnabled,
        isEnabled: () => enabled,
        setBackgroundBlurriness,
        getBackgroundBlurriness: () => pendingBlurriness,
        getEnvironmentList: () => Object.entries(ENVIRONMENTS).map(([key, env]) => ({ key, label: env.label })),
        getCurrentEnvironment: () => currentEnvironment,
        getCurrentResolution: () => currentResolution,
    };
}
