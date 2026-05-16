import { assetRegistry } from './AssetRegistry.js';

class PrefabRegistry {
    constructor() {
        this._byId = new Map();
        this._actorFileCache = new Map();
    }

    register(prefab) {
        if (!prefab?.id) return null;
        const entry = {
            assetId: this.getPrefabAssetId(prefab.id),
            category: 'Other',
            ...prefab,
        };
        this._byId.set(entry.id, entry);
        assetRegistry.register(entry.assetId, {
            kind: 'prefab',
            url: entry.file ? `./prefabs/${entry.file}` : '',
            meta: {
                prefabId: entry.id,
                name: entry.name || entry.id,
                category: entry.category || 'Other',
                file: entry.file || '',
                gameplayPrefab: entry.gameplayPrefab || '',
                modelPrefab: entry.modelPrefab || '',
                kind: entry.kind || '',
            },
        });
        return entry;
    }

    registerMany(prefabs = [], defaults = {}) {
        for (const prefab of prefabs) {
            this.register({ ...defaults, ...prefab });
        }
        return this;
    }

    get(id) {
        return this._byId.get(id) ?? null;
    }

    has(id) {
        return this._byId.has(id);
    }

    list() {
        return Array.from(this._byId.values());
    }

    grouped(categoryOrder = []) {
        const grouped = new Map();
        for (const prefab of this._byId.values()) {
            const category = prefab.category || 'Other';
            if (!grouped.has(category)) grouped.set(category, []);
            grouped.get(category).push(prefab);
        }
        const categories = [
            ...categoryOrder.filter((category) => grouped.has(category)),
            ...Array.from(grouped.keys()).filter((category) => !categoryOrder.includes(category)).sort(),
        ];
        return categories.map((category) => ({
            category,
            items: grouped.get(category) || [],
        }));
    }

    getCachedActorFile(key) {
        return this._actorFileCache.get(key) ?? null;
    }

    cacheActorFile(key, file) {
        if (key && file) {
            this._actorFileCache.set(key, file);
        }
        return file ?? null;
    }

    getPrefabAssetId(prefabId) {
        return prefabId ? `prefab:${prefabId}` : '';
    }

    prefabIdFromAssetId(assetId) {
        return typeof assetId === 'string' && assetId.startsWith('prefab:')
            ? assetId.slice('prefab:'.length)
            : '';
    }
}

export const prefabRegistry = new PrefabRegistry();
export { PrefabRegistry };
