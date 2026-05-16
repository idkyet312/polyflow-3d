import { assetRegistry } from './AssetRegistry.js';

const HDRI_PRESETS = [
    { id: 'hdri:sunny-sky', slug: 'kloofendal_48d_partly_cloudy_puresky' },
    { id: 'hdri:studio', slug: 'studio_small_03' },
    { id: 'hdri:urban-street', slug: 'potsdamer_platz' },
    { id: 'hdri:forest-trail', slug: 'forest_slope' },
    { id: 'hdri:golden-sunset', slug: 'golden_bay' },
];

const POLYHAVEN_BRICK_TEXTURES = [
    { id: 'tex:brick-wall', slug: 'brick_wall_006' },
    { id: 'tex:brick-floor', slug: 'cobblestone_floor_08' },
    { id: 'tex:brick-accent', slug: 'red_brick' },
];

let registered = false;

export function registerCoreAssets() {
    if (registered) return assetRegistry;
    registered = true;

    for (const { id, slug } of HDRI_PRESETS) {
        assetRegistry.register(id, { kind: 'hdri', meta: { slug } });
    }

    for (const { id, slug } of POLYHAVEN_BRICK_TEXTURES) {
        assetRegistry.register(id, {
            kind: 'texture',
            meta: { slug, source: 'polyhaven' },
        });
    }

    assetRegistry.register('prefab:manifest', {
        kind: 'prefab',
        url: assetRegistry.resolvePrefabManifest(),
        meta: { role: 'manifest' },
    });

    return assetRegistry;
}
