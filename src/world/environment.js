import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

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
    if (slug === 'kloofendal_48d_partly_cloudy_puresky' && resolution === '4k') {
        return (import.meta.env.BASE_URL || '/') + 'kloofendal_48d_partly_cloudy_puresky_4k.hdr';
    }

    return `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/${resolution}/${slug}_${resolution}.hdr`;
}

export function createEnvironmentController({ scene, getAmbientLight, getHemiLight }) {
    const hdriCache = {};
    let currentEnvironment = 'sunny-sky';
    let currentResolution = '1k';

    function loadHdriIntoScene(url, blurriness) {
        console.log(`Loading HDRI: ${url}`);

        if (hdriCache[url]) {
            scene.environment = hdriCache[url];
            scene.background = hdriCache[url];
            scene.backgroundBlurriness = blurriness;
            return;
        }

        const loader = new RGBELoader();
        loader.load(url, (texture) => {
            texture.mapping = THREE.EquirectangularReflectionMapping;
            hdriCache[url] = texture;
            scene.environment = texture;
            scene.background = texture;
            scene.backgroundBlurriness = blurriness;
            console.log(`Successfully loaded HDRI: ${url}`);
        }, undefined, (error) => {
            console.error('Failed to load HDRI:', url, error);
        });
    }

    function switchEnvironment(key) {
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

        loadHdriIntoScene(getHdriUrl(environment.slug, currentResolution), environment.blurriness);
    }

    function setResolution(resolution) {
        currentResolution = resolution;

        document.querySelectorAll('.res-btn').forEach((button) => {
            button.classList.toggle('res-btn-active', button.dataset.res === resolution);
        });

        switchEnvironment(currentEnvironment);
    }

    return {
        switchEnvironment,
        setResolution,
        getCurrentEnvironment: () => currentEnvironment,
        getCurrentResolution: () => currentResolution,
    };
}
