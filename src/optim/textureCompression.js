// Extracted from root main.js to keep the entry below the 256 KB push cap.
// Pure utilities — depend only on THREE plus standard browser APIs (fetch,
// OffscreenCanvas, document, URL). No engine-state coupling.

import * as THREE from 'three';

export function getTextureCompressionProfile(name, quality, maxSize) {
    const profiles = {
        map: { quality, maxSize, allowJpeg: true, detectAlpha: true },
        normalMap: { quality: Math.min(quality, 0.72), maxSize: Math.min(maxSize, 1024), allowJpeg: false, detectAlpha: false },
        roughnessMap: { quality: Math.min(quality, 0.68), maxSize: Math.min(maxSize, 1024), allowJpeg: true, detectAlpha: false },
        metalnessMap: { quality: Math.min(quality, 0.68), maxSize: Math.min(maxSize, 1024), allowJpeg: true, detectAlpha: false },
        emissiveMap: { quality: Math.min(quality, 0.78), maxSize: Math.min(maxSize, 1024), allowJpeg: true, detectAlpha: true },
        aoMap: { quality: Math.min(quality, 0.68), maxSize: Math.min(maxSize, 1024), allowJpeg: true, detectAlpha: false },
        alphaMap: { quality: Math.min(quality, 0.72), maxSize: Math.min(maxSize, 1024), allowJpeg: false, detectAlpha: false },
    };

    return profiles[name] || { quality, maxSize, allowJpeg: true, detectAlpha: true };
}

export async function getImageSourceSize(image) {
    const sourceUrl = image?.currentSrc || image?.src;
    if (!sourceUrl) return null;

    try {
        const response = await fetch(sourceUrl);
        const blob = await response.blob();
        return blob.size;
    } catch {
        return null;
    }
}

export function createTextureCanvas(width, height) {
    if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(width, height);
        return {
            canvas,
            ctx: canvas.getContext('2d', { alpha: true }),
            useOffscreen: true,
        };
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return {
        canvas,
        ctx: canvas.getContext('2d', { alpha: true }),
        useOffscreen: false,
    };
}

export async function canvasToBlob(canvas, mimeType, quality, useOffscreen) {
    if (useOffscreen) {
        return canvas.convertToBlob({ type: mimeType, quality });
    }

    return new Promise(resolve => {
        canvas.toBlob(resolve, mimeType, quality);
    });
}

export function hasTransparency(ctx, width, height) {
    const step = Math.max(1, Math.floor(Math.max(width, height) / 128));
    const { data } = ctx.getImageData(0, 0, width, height);

    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            const alphaIndex = ((y * width) + x) * 4 + 3;
            if (data[alphaIndex] < 255) {
                return true;
            }
        }
    }

    return false;
}

export function cloneTextureSettings(source, target, mimeType, colorSpace) {
    target.name = source.name;
    target.wrapS = source.wrapS;
    target.wrapT = source.wrapT;
    target.magFilter = THREE.LinearFilter;
    target.minFilter = THREE.LinearMipmapLinearFilter;
    target.generateMipmaps = true;
    target.flipY = source.flipY;
    target.colorSpace = colorSpace;
    target.repeat.copy(source.repeat);
    target.offset.copy(source.offset);
    target.center.copy(source.center);
    target.rotation = source.rotation;
    target.anisotropy = source.anisotropy;
    target.channel = source.channel;
    target.userData = { ...source.userData, mimeType };
    target.needsUpdate = true;
}

// === TEXTURE OPTIMIZATION (Best-in-class 2026 pipeline) ===
export async function compressTextures(object, quality = 0.85, maxSize = 2048, useKTX2 = false) {
    const textureMap = new Map();
    const texturePromises = [];

    object.traverse(child => {
        if (!child.isMesh) return;

        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(mat => {
            if (!mat) return;

            const mapNames = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap'];
            mapNames.forEach(name => {
                const tex = mat[name];
                if (tex && tex.isTexture && tex.image && !textureMap.has(tex.uuid)) {
                    const isNormal = name === 'normalMap' || (tex.name && tex.name.toLowerCase().includes('normal'));
                    const profile = getTextureCompressionProfile(name, quality, maxSize);
                    const promise = (useKTX2
                        ? compressTextureToKTX2(tex, profile.quality, profile.maxSize, isNormal)
                        : compressTextureToWebP(tex, profile, isNormal)
                    ).then(newTex => {
                        textureMap.set(tex.uuid, newTex);
                        mat[name] = newTex;
                    });
                    texturePromises.push(promise);
                } else if (tex && tex.isTexture) {
                    mat[name] = textureMap.get(tex.uuid) || tex;
                }
            });
        });
    });

    await Promise.all(texturePromises);
    console.log(`Texture optimization complete (${useKTX2 ? 'KTX2/BasisU' : 'WebP'})`);
}

export async function compressTextureToWebP(texture, profile, isNormal) {
    const img = texture.image;
    let width = img.width || img.videoWidth || 512;
    let height = img.height || img.videoHeight || 512;

    if (width > profile.maxSize || height > profile.maxSize) {
        const ratio = Math.min(profile.maxSize / width, profile.maxSize / height);
        width = Math.floor(width * ratio);
        height = Math.floor(height * ratio);
    }

    const { canvas, ctx, useOffscreen } = createTextureCanvas(width, height);

    if (!ctx) return texture;

    ctx.drawImage(img, 0, 0, width, height);

    const hasAlpha = profile.detectAlpha ? hasTransparency(ctx, width, height) : false;
    const candidates = [{ mimeType: 'image/webp', quality: profile.quality }];

    if (!isNormal && profile.allowJpeg && !hasAlpha) {
        candidates.push({ mimeType: 'image/jpeg', quality: Math.max(0.55, profile.quality - 0.08) });
    }

    const blobs = await Promise.all(candidates.map(async candidate => {
        const blob = await canvasToBlob(canvas, candidate.mimeType, candidate.quality, useOffscreen);
        return blob ? { ...candidate, blob } : null;
    }));

    const validCandidates = blobs.filter(Boolean);
    if (validCandidates.length === 0) return texture;

    let bestCandidate = validCandidates[0];
    for (const candidate of validCandidates) {
        if (candidate.blob.size < bestCandidate.blob.size) {
            bestCandidate = candidate;
        }
    }

    const originalSize = await getImageSourceSize(img);
    if (originalSize && bestCandidate.blob.size >= originalSize) {
        return texture;
    }

    return new Promise(resolve => {
        const url = URL.createObjectURL(bestCandidate.blob);
        const loader = new THREE.TextureLoader();
        loader.load(url, newTexture => {
            cloneTextureSettings(
                texture,
                newTexture,
                bestCandidate.mimeType,
                isNormal ? THREE.NoColorSpace : THREE.SRGBColorSpace
            );
            resolve(newTexture);
            URL.revokeObjectURL(url);
        }, undefined, () => {
            URL.revokeObjectURL(url);
            resolve(texture);
        });
    });
}

// === KTX2 + Basis Universal (Pro tier – 70-95% reduction + GPU-native) ===
// Uncomment and implement when you add the Basis encoder WASM.
export async function compressTextureToKTX2(texture, quality, maxSize, isNormal) {
    console.warn('KTX2 Pro feature – using WebP fallback for now');
    return compressTextureToWebP(texture, {
        quality,
        maxSize,
        allowJpeg: !isNormal,
        detectAlpha: !isNormal,
    }, isNormal);
}
