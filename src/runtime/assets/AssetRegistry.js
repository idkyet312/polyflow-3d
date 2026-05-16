/** @typedef {'model'|'hdri'|'texture'|'prefab'|'other'} AssetKind */

class AssetRegistry {
    constructor() {
        /** @type {Map<string, {id:string, kind:AssetKind, url?:string, meta?:object}>} */
        this._byId = new Map();
        this._importedTemplatesProvider = null;
        this._importedTemplatesById = new Map();
    }

    register(id, descriptor = {}) {
        if (!id) return null;
        const entry = { id, kind: descriptor.kind || 'other', ...descriptor };
        this._byId.set(id, entry);
        return entry;
    }

    has(id) {
        return this._byId.has(id);
    }

    get(id) {
        return this._byId.get(id) ?? null;
    }

    resolve(id) {
        return this._byId.get(id)?.url ?? null;
    }

    list(kind = null) {
        const assets = Array.from(this._byId.values());
        return kind ? assets.filter((asset) => asset.kind === kind) : assets;
    }

    resolveHdri(slug, resolution) {
        if (slug === 'kloofendal_48d_partly_cloudy_puresky' && resolution === '4k') {
            return (import.meta.env.BASE_URL || '/') + 'kloofendal_48d_partly_cloudy_puresky_4k.hdr';
        }

        return `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/${resolution}/${slug}_${resolution}.hdr`;
    }

    resolvePolyHaven(slug, map, ext, res = '2k') {
        return `https://dl.polyhaven.org/file/ph-assets/Textures/${ext}/${res}/${slug}/${slug}_${map}_${res}.${ext}`;
    }

    resolvePrefabManifest() {
        return './prefabs/manifest.json';
    }

    setImportedTemplatesProvider(provider) {
        this._importedTemplatesProvider = typeof provider === 'function' ? provider : null;
        this.refreshImportedTemplates();
    }

    refreshImportedTemplates() {
        this._importedTemplatesById.clear();
        const templates = this._importedTemplatesProvider?.();
        if (!Array.isArray(templates)) return;
        for (const template of templates) {
            if (template?.id) {
                this._importedTemplatesById.set(template.id, template);
            }
        }
    }

    registerImportedTemplate(template) {
        if (!template?.id) return null;
        this._importedTemplatesById.set(template.id, template);
        this.register(this.getImportedTemplateAssetId(template.id), {
            kind: 'model',
            meta: {
                role: 'imported-template',
                templateId: template.id,
                fileName: template.fileName || '',
                displayName: template.displayName || '',
            },
        });
        return template;
    }

    getImportedTemplateAssetId(templateId) {
        return templateId ? `imported-template:${templateId}` : '';
    }

    importedTemplateIdFromAssetId(assetId) {
        return typeof assetId === 'string' && assetId.startsWith('imported-template:')
            ? assetId.slice('imported-template:'.length)
            : '';
    }

    listImportedTemplates() {
        const templates = this._importedTemplatesProvider?.();
        return Array.isArray(templates) ? templates.slice() : [];
    }

    getImportedTemplate(id) {
        return this._importedTemplatesById.get(id) ?? null;
    }

    hasImportedTemplate(id) {
        return this._importedTemplatesById.has(id);
    }
}

export const assetRegistry = new AssetRegistry();
export { AssetRegistry };
