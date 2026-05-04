// src/world/splat/dropZone.js
//
// Drag-and-drop UI for loading splat files (.splat, .ply, .sog) directly into
// the scene without needing the ?splat= URL parameter. Drops are routed through
// the same loadSplat path as the URL hook, so all three formats are supported
// with no code duplication.
//
// Self-contained: injects its own CSS via a <style> element and creates its own
// overlay + toast DOM. No external dependencies. Suppresses the browser's
// default "navigate to file" behavior on file drops.
//
// Visual states:
//   - Drag in progress  -> full-screen dashed-border overlay with "Drop to load splat"
//   - Loading           -> persistent info toast: "Loading <file> (<size> MB)…"
//   - Success           -> green toast: "Loaded <file>", auto-dismisses
//   - Error             -> red toast with the error message, auto-dismisses
//   - Unsupported file  -> red toast explaining accepted extensions
//
// Limitations:
//   - Dropped files are loaded via blob: URLs, which don't survive a page
//     reload. If a scene save/load round-trip needs to preserve the splat,
//     re-drop the file after reload (or upload it somewhere and load via
//     ?splat=https://… instead). Persistence via IndexedDB is future work.

import { addSplatActorToSceneSystem } from './splatActor.js';
import { addSplatToScene } from './splatRenderer.js';

const ACCEPTED_EXTENSIONS = ['.splat', '.ply', '.sog'];
const STYLE_ID = 'splat-dropzone-style';

// =============================================================================
// Public API
// =============================================================================

/**
 * Wire drag-and-drop file loading for splat files onto the page.
 *
 * @param {object}   opts
 * @param {THREE.Scene} opts.scene             — fallback for the bare-mesh path.
 * @param {object|null} [opts.sceneSystem]     — preferred actor path when present.
 * @returns {() => void} cleanup function that removes listeners + overlay + toasts.
 */
export function wireSplatDropZone({ scene, sceneSystem = null } = {}) {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return () => {};
    }
    if (!scene) {
        console.warn('[splat-dropzone] called without a scene; skipping.');
        return () => {};
    }

    ensureStyles();
    const overlay = buildOverlay();
    const toastContainer = buildToastContainer();
    document.body.appendChild(overlay);
    document.body.appendChild(toastContainer);

    let dragDepth = 0;        // counts dragenter/leave to handle child crossings
    let busy = false;
    const queue = [];

    const showOverlay = () => overlay.classList.add('visible');
    const hideOverlay = () => overlay.classList.remove('visible');

    const onDragEnter = (e) => {
        if (!hasFiles(e)) return;
        dragDepth++;
        if (dragDepth === 1) showOverlay();
    };
    const onDragOver = (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();      // required to allow `drop` to fire
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e) => {
        if (!hasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) hideOverlay();
    };
    const onDrop = async (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        hideOverlay();

        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length === 0) return;

        const supported = files.filter(isSupportedFile);
        if (supported.length === 0) {
            showToast(
                toastContainer,
                'Unsupported file. Drop a .splat, .ply, or .sog file.',
                'error',
            );
            return;
        }
        const skipped = files.length - supported.length;
        if (skipped > 0) {
            showToast(
                toastContainer,
                `Skipped ${skipped} unsupported file${skipped > 1 ? 's' : ''}.`,
                'info',
            );
        }

        // Process sequentially. Loading two 84 MB SOGs in parallel can OOM
        // mobile devices; sequential is forgiving and has predictable memory.
        queue.push(...supported);
        if (busy) return;
        busy = true;
        try {
            while (queue.length > 0) {
                const file = queue.shift();
                await loadOneFile(file, { scene, sceneSystem, toastContainer });
            }
        } finally {
            busy = false;
        }
    };

    // Listen on window so users can drop anywhere on the page (the canvas
    // typically takes up most of it; sidebars are smaller targets).
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    return () => {
        window.removeEventListener('dragenter', onDragEnter);
        window.removeEventListener('dragover', onDragOver);
        window.removeEventListener('dragleave', onDragLeave);
        window.removeEventListener('drop', onDrop);
        overlay.remove();
        toastContainer.remove();
    };
}

// =============================================================================
// Loading
// =============================================================================

async function loadOneFile(file, { scene, sceneSystem, toastContainer }) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    const handle = showToast(
        toastContainer,
        `Loading ${file.name} (${sizeMb} MB)…`,
        'info',
        { persist: true },
    );

    let url = '';
    try {
        // The same loadSplat path used for ?splat=<url> works for blob URLs;
        // the dispatcher detects format from the file extension we passed via
        // the blob's name. To be safe we encode the name in the blob URL
        // fragment so detectFormatFromUrl finds the right extension.
        url = URL.createObjectURL(file) + '#' + encodeURIComponent(file.name);

        const cleanName = file.name.replace(/\.[^.]+$/, '') || 'Splat';

        if (sceneSystem) {
            await addSplatActorToSceneSystem(sceneSystem, { url, name: cleanName });
        } else {
            await addSplatToScene(scene, url);
        }
        replaceToast(handle, `Loaded ${file.name}`, 'success');
        // NOTE: Don't URL.revokeObjectURL(url) here. The SplatComponent stores
        // the URL; if it ever re-loads (e.g. through editor undo/redo), the
        // blob needs to still be reachable. The browser frees blob URLs on
        // page unload, so leaking here is bounded.
    } catch (err) {
        console.error('[splat-dropzone] load failed:', err);
        if (url) URL.revokeObjectURL(url);
        replaceToast(handle, `Failed to load ${file.name}: ${err.message}`, 'error');
    }
}

function hasFiles(e) {
    if (!e.dataTransfer) return false;
    const types = e.dataTransfer.types;
    if (!types) return false;
    // types is a DOMStringList in some browsers; normalize via Array.from.
    return Array.from(types).includes('Files');
}

function isSupportedFile(file) {
    const name = (file?.name || '').toLowerCase();
    return ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

// =============================================================================
// UI
// =============================================================================

function ensureStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.splat-dropzone-overlay {
    position: fixed; inset: 0;
    display: flex; align-items: center; justify-content: center;
    background: rgba(8, 8, 12, 0.78);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    opacity: 0; pointer-events: none;
    transition: opacity 140ms ease;
    z-index: 99998;
}
.splat-dropzone-overlay.visible { opacity: 1; }
.splat-dropzone-card {
    border: 2px dashed #ff7a1a;
    border-radius: 18px;
    padding: 56px 88px;
    background: rgba(20, 20, 26, 0.6);
    text-align: center;
    color: #f5f5f5;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    min-width: 360px;
    animation: splat-dropzone-pop 200ms ease;
}
@keyframes splat-dropzone-pop {
    from { transform: scale(0.95); opacity: 0; }
    to   { transform: scale(1.0);  opacity: 1; }
}
.splat-dropzone-icon {
    font-size: 56px; line-height: 1; margin-bottom: 14px;
    color: #ff7a1a;
}
.splat-dropzone-title {
    font-size: 22px; font-weight: 600; margin-bottom: 8px;
    letter-spacing: 0.01em;
}
.splat-dropzone-sub {
    font-size: 12px; color: #aaa;
    letter-spacing: 0.14em; text-transform: uppercase;
}
.splat-toast-container {
    position: fixed; bottom: 16px; right: 16px;
    display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
    z-index: 99999;
    pointer-events: none;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
.splat-toast {
    min-width: 240px; max-width: 460px;
    padding: 11px 14px;
    border-radius: 8px;
    background: #1a1a1f; color: #f5f5f5;
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.55);
    border-left: 3px solid #555;
    font-size: 13px; line-height: 1.45;
    opacity: 0; transform: translateX(24px);
    transition: opacity 180ms ease, transform 180ms ease;
    pointer-events: auto;
    word-break: break-word;
}
.splat-toast.visible {
    opacity: 1; transform: translateX(0);
}
.splat-toast.info    { border-left-color: #4a9eff; }
.splat-toast.success { border-left-color: #2ecc71; }
.splat-toast.error   { border-left-color: #ff5959; }
`;
    document.head.appendChild(style);
}

function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'splat-dropzone-overlay';
    overlay.innerHTML = `
        <div class="splat-dropzone-card">
            <div class="splat-dropzone-icon">⬇</div>
            <div class="splat-dropzone-title">Drop to load splat</div>
            <div class="splat-dropzone-sub">.splat &nbsp;·&nbsp; .ply &nbsp;·&nbsp; .sog</div>
        </div>
    `;
    return overlay;
}

function buildToastContainer() {
    const c = document.createElement('div');
    c.className = 'splat-toast-container';
    return c;
}

/**
 * Show a toast. Returns a handle the caller can later mutate via replaceToast.
 *
 * @returns {{ toast: HTMLElement, dismissed: boolean }}
 */
function showToast(container, message, kind = 'info', { persist = false, durationMs = null } = {}) {
    const toast = document.createElement('div');
    toast.className = `splat-toast ${kind}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));

    const handle = { toast, dismissed: false };

    if (!persist) {
        const ms = durationMs ?? (kind === 'error' ? 6000 : 4000);
        setTimeout(() => dismissToast(handle), ms);
    }
    return handle;
}

/**
 * Mutate an existing toast in place — change its kind and message — and start
 * its auto-dismiss timer. Used to flip a "Loading…" toast into a "Loaded" or
 * "Failed" toast without flicker.
 */
function replaceToast(handle, message, kind, { durationMs = null } = {}) {
    if (!handle?.toast || handle.dismissed) return;
    handle.toast.classList.remove('info', 'success', 'error');
    handle.toast.classList.add(kind);
    handle.toast.textContent = message;
    const ms = durationMs ?? (kind === 'error' ? 6000 : 4000);
    setTimeout(() => dismissToast(handle), ms);
}

function dismissToast(handle) {
    if (!handle?.toast || handle.dismissed) return;
    handle.dismissed = true;
    handle.toast.classList.remove('visible');
    setTimeout(() => handle.toast.remove(), 220);
}
