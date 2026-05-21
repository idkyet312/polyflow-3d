// src/debug/console.js
// Extracted from main.js lines 5985–6468.
// Debug console + stats overlay: timing samples, stat panels, command registry,
// keyboard handlers, and per-frame metric recording.

import * as THREE from 'three';

// ─── Module-scope deps populated by setupDebugConsole ─────────────────────────
let debugConsole, debugConsoleOutput, debugConsoleInput, debugConsoleFooter,
    debugStatsOverlay;

// State objects passed by reference from main.js
let debugConsoleState, mobileState, shadowDebugState, raycastDebugState, collisionDebugState,
    gameplay, physics;

// Constants passed from main.js
let DEBUG_CONSOLE_LOG_LIMIT, DEBUG_CONSOLE_HISTORY_LIMIT, DEBUG_TIMING_SAMPLE_LIMIT;

// Functions from main.js that the console commands call into
let closeObjectScriptMenu, closeObjectScriptEditor, resetMovementInputState,
    renderer, setRayDebugEnabled, forceAllSceneMeshShadows,
    setCollisionDebugEnabled, setForceAllSceneMeshShadowsEnabled, updateMobileButtons,
    resetMobileInputState, updateWorldPresentation, updateGameplayUI,
    isEditableElement, getDDGIManager;

export function setupDebugConsole(deps) {
    ({
        debugConsole,
        debugConsoleOutput,
        debugConsoleInput,
        debugConsoleFooter,
        debugStatsOverlay,
        debugConsoleState,
        mobileState,
        shadowDebugState,
        raycastDebugState,
        collisionDebugState,
        gameplay,
        physics,
        DEBUG_CONSOLE_LOG_LIMIT,
        DEBUG_CONSOLE_HISTORY_LIMIT,
        DEBUG_TIMING_SAMPLE_LIMIT,
        closeObjectScriptMenu,
        closeObjectScriptEditor,
        resetMovementInputState,
        renderer,
        setRayDebugEnabled,
        setCollisionDebugEnabled,
        forceAllSceneMeshShadows,
        setForceAllSceneMeshShadowsEnabled,
        updateMobileButtons,
        resetMobileInputState,
        updateWorldPresentation,
        updateGameplayUI,
        isEditableElement,
        getDDGIManager,
    } = deps);
}

// ─── Timing samples ───────────────────────────────────────────────────────────────

export function pushTimingSample(metric, value) {
    const series = debugConsoleState.samples[metric];
    if (!series) return;

    series.push(value);
    if (series.length > DEBUG_TIMING_SAMPLE_LIMIT) {
        series.shift();
    }
}

export function getAverageTiming(metric) {
    const series = debugConsoleState.samples[metric];
    if (!series || !series.length) return 0;
    return series.reduce((sum, value) => sum + value, 0) / series.length;
}

export function formatTimingMs(value) {
    return `${value.toFixed(value >= 10 ? 1 : 2)} ms`;
}

// ─── Console output ────────────────────────────────────────────────────────────────

export function renderDebugConsoleOutput() {
    if (!debugConsoleOutput) return;

    const fragment = document.createDocumentFragment();
    debugConsoleState.lines.forEach((line) => {
        const row = document.createElement('div');
        row.className = 'debug-console-line';
        row.dataset.tone = line.tone || 'info';

        const prefix = document.createElement('span');
        prefix.className = 'debug-console-prefix';
        prefix.textContent = line.prefix;

        const text = document.createElement('span');
        text.className = 'debug-console-text';
        text.textContent = line.text;

        row.append(prefix, text);
        fragment.appendChild(row);
    });

    debugConsoleOutput.replaceChildren(fragment);
    debugConsoleOutput.scrollTop = debugConsoleOutput.scrollHeight;
}

export function pushDebugConsoleLine(text, tone = 'info', prefix = 'sys') {
    debugConsoleState.lines.push({ prefix, text, tone });
    if (debugConsoleState.lines.length > DEBUG_CONSOLE_LOG_LIMIT) {
        debugConsoleState.lines.shift();
    }
    renderDebugConsoleOutput();
}

export function focusDebugConsoleInput() {
    if (!debugConsoleInput) return;
    window.requestAnimationFrame(() => {
        debugConsoleInput.focus();
        debugConsoleInput.select();
    });
}

export function setDebugConsoleVisible(isVisible, { focusInput = true } = {}) {
    debugConsoleState.visible = !!isVisible;

    if (debugConsole) {
        debugConsole.hidden = !debugConsoleState.visible;
    }

    document.body.classList.toggle('console-open', debugConsoleState.visible);

    if (debugConsoleState.visible) {
        closeObjectScriptMenu();
        closeObjectScriptEditor();
        resetMovementInputState();

        if (document.pointerLockElement === renderer?.domElement) {
            document.exitPointerLock?.();
        }

        if (focusInput) {
            focusDebugConsoleInput();
        }
        return;
    }

    debugConsoleInput?.blur();
}

// ─── Stat panels ─────────────────────────────────────────────────────────────────

export function createDebugStatRow(label) {
    const row = document.createElement('div');
    row.className = 'debug-stat-row';

    const title = document.createElement('div');
    title.className = 'debug-stat-label';
    title.textContent = label;

    const value = document.createElement('div');
    value.className = 'debug-stat-value';
    value.textContent = '--';

    row.append(title, value);
    return { row, value };
}

function setTextIfChanged(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
}

export function createDebugStatPanel(name) {
    if (!debugStatsOverlay) return null;

    const panel = document.createElement('section');
    panel.className = 'debug-stat-panel';
    panel.dataset.panel = name;

    const header = document.createElement('div');
    header.className = 'debug-stat-header';

    const titleWrap = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'debug-stat-title';
    title.textContent = name === 'unit'
        ? 'Stat Unit'
        : name === 'physics'
            ? 'Stat Physics'
            : name === 'raytracing'
                ? 'Stat Raytracing'
            : name === 'ddgi'
                ? 'Stat DDGI'
            : name === 'systems'
                ? 'Stat Systems'
                : 'Stat GPU';

    const meta = document.createElement('div');
    meta.className = 'debug-stat-meta';
    meta.textContent = 'Waiting for frame samples...';
    titleWrap.append(title, meta);
    header.appendChild(titleWrap);

    let badge = null;
    if (name === 'gpu') {
        badge = document.createElement('div');
        badge.className = 'debug-stat-badge';
        badge.textContent = 'Approx';
        header.appendChild(badge);
    }

    const grid = document.createElement('div');
    grid.className = 'debug-stat-grid';
    const rows = {};

    const labels = name === 'unit'
        ? ['Frame', 'FPS', 'Update', 'Physics', 'Render', 'Scripts']
        : name === 'physics'
            ? ['Step', 'Sync', 'Collisions', 'Bodies', 'Passes', 'Delta']
            : name === 'raytracing'
                ? ['BVH Build']
            : name === 'ddgi'
                ? ['Enabled', 'Volume', 'Probes', 'Ready', 'Bake N', 'Intensity', 'Invalidate', 'DDGI']
                : name === 'systems'
                    ? ['Total', 'Slow', 'Top', 'Gameplay', 'Count']
                : ['GPU', 'Render', 'Frame', 'FPS'];

    labels.forEach((label) => {
        const key = label.toLowerCase();
        const rowRef = createDebugStatRow(label);
        rows[key] = rowRef.value;
        grid.appendChild(rowRef.row);
    });

    panel.append(header, grid);

    let atlasPreview = null;
    if (name === 'ddgi') {
        const wrap = document.createElement('div');
        wrap.className = 'debug-stat-atlas';

        const label = document.createElement('div');
        label.className = 'debug-stat-atlas-label';
        label.textContent = 'Irradiance Atlas';

        const canvas = document.createElement('canvas');
        canvas.className = 'debug-stat-atlas-canvas';
        canvas.width = 1;
        canvas.height = 1;

        wrap.append(label, canvas);
        panel.appendChild(wrap);
        atlasPreview = {
            canvas,
            ctx: canvas.getContext('2d', { willReadFrequently: true }),
            pending: false,
            lastReadAt: 0,
            lastAtlas: null,
        };
    }
    debugStatsOverlay.appendChild(panel);

    return { panel, meta, badge, rows, atlasPreview };
}

function halfFloatToLinear(value) {
    return THREE.DataUtils?.fromHalfFloat
        ? THREE.DataUtils.fromHalfFloat(value)
        : value / 65535;
}

function toneMapAtlasChannel(value) {
    const mapped = 1 - Math.exp(-Math.max(0, value) * 1.4);
    return Math.round(Math.pow(THREE.MathUtils.clamp(mapped, 0, 1), 1 / 2.2) * 255);
}

function paintDDGIAtlasPreview(ref, atlas, pixels) {
    const preview = ref.atlasPreview;
    if (!preview?.ctx || !atlas || !pixels) return;

    const width = atlas.width | 0;
    const height = atlas.height | 0;
    if (width <= 0 || height <= 0) return;

    if (preview.canvas.width !== width || preview.canvas.height !== height) {
        preview.canvas.width = width;
        preview.canvas.height = height;
    }

    const image = preview.ctx.createImageData(width, height);
    const textureType = atlas.front?.texture?.type;
    const isHalfFloat = textureType === THREE.HalfFloatType || pixels instanceof Uint16Array;
    const isFloat = pixels instanceof Float32Array;
    const bytesPerTexel = isFloat ? 16 : isHalfFloat ? 8 : 4;
    const bytesPerElement = pixels.BYTES_PER_ELEMENT || 1;
    const sourceStride = pixels === atlas.data
        ? width * 4
        : Math.ceil((width * bytesPerTexel) / 256) * (256 / bytesPerElement);

    for (let y = 0; y < height; y++) {
        const srcY = height - 1 - y;
        for (let x = 0; x < width; x++) {
            const src = srcY * sourceStride + x * 4;
            const dst = (y * width + x) * 4;
            const r = isHalfFloat ? halfFloatToLinear(pixels[src]) : pixels[src];
            const g = isHalfFloat ? halfFloatToLinear(pixels[src + 1]) : pixels[src + 1];
            const b = isHalfFloat ? halfFloatToLinear(pixels[src + 2]) : pixels[src + 2];
            image.data[dst] = isFloat || isHalfFloat ? toneMapAtlasChannel(r) : r;
            image.data[dst + 1] = isFloat || isHalfFloat ? toneMapAtlasChannel(g) : g;
            image.data[dst + 2] = isFloat || isHalfFloat ? toneMapAtlasChannel(b) : b;
            image.data[dst + 3] = 255;
        }
    }

    preview.ctx.putImageData(image, 0, 0);
}

function updateDDGIAtlasPreview(ref, atlas) {
    const preview = ref.atlasPreview;
    if (!preview || !atlas) return;

    const now = performance.now();
    if (preview.pending || (now - preview.lastReadAt) < 250) return;

    if (atlas.data) {
        preview.lastReadAt = now;
        paintDDGIAtlasPreview(ref, atlas, atlas.data);
        return;
    }

    if (!renderer?.readRenderTargetPixelsAsync || !atlas?.front) return;

    preview.pending = true;
    preview.lastReadAt = now;
    preview.lastAtlas = atlas.front;

    renderer.readRenderTargetPixelsAsync(atlas.front, 0, 0, atlas.width, atlas.height, 0, 0)
        .then((pixels) => {
            if (preview.lastAtlas === atlas.front) paintDDGIAtlasPreview(ref, atlas, pixels);
        })
        .catch(() => {
            const ctx = preview.ctx;
            if (!ctx) return;
            ctx.clearRect(0, 0, preview.canvas.width, preview.canvas.height);
        })
        .finally(() => {
            preview.pending = false;
        });
}

export function syncDebugStatPanels() {
    if (!debugStatsOverlay) return;

    debugConsoleState.panelRefs.forEach((ref, name) => {
        if (!debugConsoleState.panels.has(name)) {
            ref.panel.remove();
            debugConsoleState.panelRefs.delete(name);
        }
    });

    Array.from(debugConsoleState.panels).forEach((name) => {
        if (debugConsoleState.panelRefs.has(name)) return;
        const ref = createDebugStatPanel(name);
        if (ref) {
            debugConsoleState.panelRefs.set(name, ref);
        }
    });
}

export function updateDebugStatPanels() {
    if (!debugConsoleState.panels.size) return;

    const averageFrame = getAverageTiming('frame');
    const averageUpdate = getAverageTiming('update');
    const averagePhysics = getAverageTiming('physics');
    const averagePhysicsStep = getAverageTiming('physicsStep');
    const averagePhysicsSync = getAverageTiming('physicsSync');
    const averagePhysicsCollisions = getAverageTiming('physicsCollisions');
    const averageScripts = getAverageTiming('scripts');
    const averageGpu = getAverageTiming('gpu');
    const averageRender = getAverageTiming('render');
    const averageDDGI = getAverageTiming('ddgi');
    const averageFps = averageFrame > 0 ? 1000 / averageFrame : 0;

    debugConsoleState.panelRefs.forEach((ref, name) => {
        if (name === 'unit') {
            setTextIfChanged(ref.meta, gameplay.active ? 'Play mode frame timings' : 'Showcase frame timings');
            setTextIfChanged(ref.rows.frame, formatTimingMs(averageFrame));
            setTextIfChanged(ref.rows.fps, `${averageFps.toFixed(1)} fps`);
            setTextIfChanged(ref.rows.update, formatTimingMs(averageUpdate));
            setTextIfChanged(ref.rows.physics, formatTimingMs(averagePhysics));
            setTextIfChanged(ref.rows.render, formatTimingMs(averageRender));
            setTextIfChanged(ref.rows.scripts, formatTimingMs(averageScripts));
            return;
        }

        if (name === 'physics') {
            setTextIfChanged(ref.meta, physics.ready ? 'Jolt step vs. post-step overhead' : 'Physics still initializing');
            setTextIfChanged(ref.rows.step, formatTimingMs(averagePhysicsStep));
            setTextIfChanged(ref.rows.sync, formatTimingMs(averagePhysicsSync));
            setTextIfChanged(ref.rows.collisions, formatTimingMs(averagePhysicsCollisions));
            setTextIfChanged(ref.rows.bodies, `${physics.dynamicBodies.length}`);
            setTextIfChanged(ref.rows.passes, `${debugConsoleState.latest.collisionSteps}`);
            setTextIfChanged(ref.rows.delta, `${(debugConsoleState.latest.delta * 1000).toFixed(1)} ms`);
            return;
        }

        if (name === 'ddgi') {
            const ddgi = getDDGIManager?.();
            const snap = ddgi?.getSnapshot?.() || {};
            setTextIfChanged(ref.meta, snap.contributionView ? 'Contribution view active' : 'Probe atlas status');
            setTextIfChanged(ref.rows.enabled, snap.enabled ? 'On' : 'Off');
            setTextIfChanged(ref.rows.volume, snap.activeVolumeType || '--');
            setTextIfChanged(ref.rows.probes, `${snap.probeCount ?? 0}`);
            setTextIfChanged(ref.rows.ready, `${snap.initializedProbes ?? 0}/${snap.probeCount ?? 0}`);
            setTextIfChanged(ref.rows['bake n'], `${snap.bakeEveryN ?? snap.probesPerFrame ?? 0}`);
            setTextIfChanged(ref.rows.intensity, Number(snap.intensity ?? 0).toFixed(2));
            setTextIfChanged(ref.rows.invalidate, snap.lastInvalidateReason || '--');
            setTextIfChanged(ref.rows.ddgi, formatTimingMs(averageDDGI || snap.lastCaptureMs || 0));
            updateDDGIAtlasPreview(ref, ddgi?.getIrradianceAtlas?.());
            return;
        }

        if (name === 'systems') {
            const sys = debugConsoleState.latest.systems || {};
            const sorted = (sys.systems || []).slice().sort((a, b) => b.duration - a.duration);
            const top = sorted[0];
            const slow = sys.slow || [];
            const gameplayTotal = sys.phases?.gameplay?.total || 0;
            setTextIfChanged(ref.meta, slow.length
                ? `Slow: ${slow.map((entry) => `${entry.name} ${entry.duration.toFixed(1)}ms`).join(', ')}`
                : 'No slow systems in latest frame');
            setTextIfChanged(ref.rows.total, formatTimingMs(sys.total || 0));
            setTextIfChanged(ref.rows.slow, `${slow.length}`);
            setTextIfChanged(ref.rows.top, top ? `${top.name} ${top.duration.toFixed(2)}ms` : '--');
            setTextIfChanged(ref.rows.gameplay, formatTimingMs(gameplayTotal));
            setTextIfChanged(ref.rows.count, `${(sys.systems || []).length}`);
            return;
        }

        if (name === 'raytracing') {
            const ddgi = getDDGIManager?.();
            const snap = ddgi?.getSnapshot?.() || {};
            setTextIfChanged(ref.meta, snap.bvhDirty
                ? `BVH dirty${snap.lastInvalidateReason ? `: ${snap.lastInvalidateReason}` : ''}`
                : 'DDGI BVH build timing');
            setTextIfChanged(ref.rows['bvh build'], formatTimingMs(snap.lastBVHBuildMs || 0));
            return;
        }

        setTextIfChanged(ref.meta, debugConsoleState.gpuTimingMode === 'gpu'
            ? 'CPU render submit vs. GPU timestamp'
            : 'GPU timestamp unsupported; showing CPU approximation');
        if (ref.badge) {
            setTextIfChanged(ref.badge, debugConsoleState.gpuTimingMode === 'approximate' ? 'Approx' : 'GPU');
        }
        setTextIfChanged(ref.rows.gpu, debugConsoleState.gpuTimingMode === 'gpu'
            ? (averageGpu > 0 ? formatTimingMs(averageGpu) : '--')
            : formatTimingMs(averageRender));
        setTextIfChanged(ref.rows.render, formatTimingMs(averageRender));
        setTextIfChanged(ref.rows.frame, formatTimingMs(averageFrame));
        setTextIfChanged(ref.rows.fps, `${averageFps.toFixed(1)} fps`);
    });
}

export function setDebugStatPanel(name, isEnabled) {
    if (isEnabled) {
        debugConsoleState.panels.add(name);
    } else {
        debugConsoleState.panels.delete(name);
    }

    syncDebugStatPanels();
}

// ─── Commands ───────────────────────────────────────────────────────────────────

export function runStatCommand(args) {
    if (!args.length) {
        pushDebugConsoleLine('Available stat commands: gpu, physics, unit, systems, ddgi, raytracing, none.', 'warn');
        return;
    }

    const panel = args[0].toLowerCase();
    const mode = args[1]?.toLowerCase() || 'on';
    const disableTokens = new Set(['0', 'false', 'hide', 'none', 'off']);

    if (disableTokens.has(panel) || panel === 'clear') {
        debugConsoleState.panels.clear();
        syncDebugStatPanels();
        pushDebugConsoleLine('All stat panels hidden.', 'success');
        return;
    }

    if (!['gpu', 'physics', 'unit', 'systems', 'ddgi', 'raytracing'].includes(panel)) {
        pushDebugConsoleLine(`Unknown stat target: ${panel}.`, 'error');
        return;
    }

    const isEnabled = !disableTokens.has(mode);
    setDebugStatPanel(panel, isEnabled);

    if (panel === 'gpu' && isEnabled) {
        pushDebugConsoleLine('Stat GPU enabled. This currently reports approximate WebGPU render submission time.', 'warn');
        return;
    }

    pushDebugConsoleLine(`Stat ${panel} ${isEnabled ? 'enabled' : 'hidden'}.`, 'success');
}

export function applyMobileModeState() {
    const nextEnabled = mobileState.detected || mobileState.forced;
    const changed = mobileState.enabled !== nextEnabled;

    mobileState.enabled = nextEnabled;
    document.body.classList.toggle('is-mobile', nextEnabled);
    document.body.classList.toggle('mobile-ui-preview', mobileState.forced && !mobileState.detected);

    if (changed && nextEnabled && document.pointerLockElement === renderer?.domElement) {
        document.exitPointerLock?.();
    }

    resetMobileInputState();
    updateWorldPresentation();
    updateGameplayUI();
    updateMobileButtons();
}

export function runMobileCommand(args) {
    const action = args[0]?.toLowerCase() || 'toggle';

    if (mobileState.detected) {
        pushDebugConsoleLine('Mobile UI is already active on this device.', 'warn');
        return;
    }

    if (['on', '1', 'true', 'show', 'enable'].includes(action)) {
        mobileState.forced = true;
        applyMobileModeState();
        pushDebugConsoleLine('Mobile UI preview enabled. Use `mobile off` to restore desktop mode.', 'success');
        return;
    }

    if (['off', '0', 'false', 'hide', 'disable'].includes(action)) {
        mobileState.forced = false;
        applyMobileModeState();
        pushDebugConsoleLine('Mobile UI preview disabled. Click the scene again if you want desktop pointer lock back.', 'success');
        return;
    }

    if (['toggle', 'switch'].includes(action)) {
        mobileState.forced = !mobileState.forced;
        applyMobileModeState();
        pushDebugConsoleLine(
            `Mobile UI preview ${mobileState.forced ? 'enabled' : 'disabled'}.`,
            'success'
        );
        return;
    }

    pushDebugConsoleLine('Usage: mobile on, mobile off, or mobile toggle.', 'warn');
}

export function runRayDebugCommand(args) {
    const action = args[0]?.toLowerCase() || 'toggle';

    if (['on', '1', 'true', 'show', 'enable'].includes(action)) {
        setRayDebugEnabled(true);
        pushDebugConsoleLine('Ray debug enabled.', 'success');
        return;
    }

    if (['off', '0', 'false', 'hide', 'disable'].includes(action)) {
        setRayDebugEnabled(false);
        pushDebugConsoleLine('Ray debug disabled.', 'success');
        return;
    }

    if (['toggle', 'switch'].includes(action)) {
        setRayDebugEnabled(!raycastDebugState.enabled);
        pushDebugConsoleLine(`Ray debug ${raycastDebugState.enabled ? 'enabled' : 'disabled'}.`, 'success');
        return;
    }

    pushDebugConsoleLine('Usage: raydebug on, raydebug off, or raydebug toggle.', 'warn');
}

export function runCollisionDebugCommand(args) {
    const action = args[0]?.toLowerCase() || 'toggle';

    if (['on', '1', 'true', 'show', 'enable'].includes(action)) {
        setCollisionDebugEnabled(true);
        return;
    }

    if (['off', '0', 'false', 'hide', 'disable'].includes(action)) {
        setCollisionDebugEnabled(false);
        return;
    }

    if (['toggle', 'switch'].includes(action)) {
        setCollisionDebugEnabled(!collisionDebugState.enabled);
        return;
    }

    pushDebugConsoleLine('Usage: collision on, collision off, or collision toggle.', 'warn');
}

export function runMeshShadowsCommand(args) {
    const action = args[0]?.toLowerCase() || 'apply';

    if (['apply', 'now', 'once'].includes(action)) {
        const result = forceAllSceneMeshShadows();
        pushDebugConsoleLine(`Forced shadows on ${result.updatedCount}/${result.meshCount} meshes.`, 'success');
        return;
    }

    if (['on', '1', 'true', 'show', 'enable'].includes(action)) {
        const result = setForceAllSceneMeshShadowsEnabled(true) ?? { meshCount: 0 };
        pushDebugConsoleLine(`Mesh shadow auto-force enabled. Watching ${result.meshCount} meshes.`, 'success');
        return;
    }

    if (['off', '0', 'false', 'hide', 'disable'].includes(action)) {
        setForceAllSceneMeshShadowsEnabled(false);
        pushDebugConsoleLine('Mesh shadow auto-force disabled.', 'success');
        return;
    }

    if (['toggle', 'switch'].includes(action)) {
        const result = setForceAllSceneMeshShadowsEnabled(!shadowDebugState.forceAllMeshes) ?? { meshCount: shadowDebugState.lastMeshCount };
        if (shadowDebugState.forceAllMeshes) {
            pushDebugConsoleLine(`Mesh shadow auto-force enabled. Watching ${result.meshCount} meshes.`, 'success');
        } else {
            pushDebugConsoleLine('Mesh shadow auto-force disabled.', 'success');
        }
        return;
    }

    pushDebugConsoleLine('Usage: meshshadows apply, meshshadows on, meshshadows off, or meshshadows toggle.', 'warn');
}

export const debugCommandRegistry = {
    stat: runStatCommand,
    mobile: runMobileCommand,
    raydebug: runRayDebugCommand,
    collision: runCollisionDebugCommand,
    meshshadows: runMeshShadowsCommand,
};

export function executeDebugConsoleCommand(rawCommand) {
    const commandText = rawCommand.trim();
    if (!commandText) return;

    debugConsoleState.history.push(commandText);
    if (debugConsoleState.history.length > DEBUG_CONSOLE_HISTORY_LIMIT) {
        debugConsoleState.history.shift();
    }
    debugConsoleState.historyIndex = debugConsoleState.history.length;

    pushDebugConsoleLine(commandText, 'command', '>');

    const [commandName, ...args] = commandText.split(/\s+/);
    const handler = debugCommandRegistry[commandName.toLowerCase()];

    if (!handler) {
        pushDebugConsoleLine(`Unknown command: ${commandName}.`, 'error');
        return;
    }

    handler(args);
}

export function handleDebugConsoleInputKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        executeDebugConsoleCommand(debugConsoleInput.value);
        debugConsoleInput.value = '';
        return;
    }

    if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (!debugConsoleState.history.length) return;
        debugConsoleState.historyIndex = Math.max(0, debugConsoleState.historyIndex - 1);
        debugConsoleInput.value = debugConsoleState.history[debugConsoleState.historyIndex] || '';
        return;
    }

    if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (!debugConsoleState.history.length) return;
        debugConsoleState.historyIndex = Math.min(debugConsoleState.history.length, debugConsoleState.historyIndex + 1);
        debugConsoleInput.value = debugConsoleState.history[debugConsoleState.historyIndex] || '';
        return;
    }

    if (event.key === 'Escape') {
        event.preventDefault();
        setDebugConsoleVisible(false, { focusInput: false });
    }
}

export function handleDebugConsoleKeydown(event) {
    if (event.code === 'Backquote' && !event.repeat) {
        if (!debugConsoleState.visible && isEditableElement(event.target) && event.target !== debugConsoleInput) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        setDebugConsoleVisible(!debugConsoleState.visible);
        return;
    }

    if (!debugConsoleState.visible) return;

    if (event.code === 'Escape') {
        event.preventDefault();
        setDebugConsoleVisible(false, { focusInput: false });
        return;
    }

    if (event.target !== debugConsoleInput) {
        event.preventDefault();
        focusDebugConsoleInput();
    }
}

export function recordDebugFrameMetrics(metrics) {
    debugConsoleState.latest.frame = metrics.frame;
    debugConsoleState.latest.update = metrics.update;
    debugConsoleState.latest.physics = metrics.physics;
    debugConsoleState.latest.physicsStep = metrics.physicsStep;
    debugConsoleState.latest.physicsSync = metrics.physicsSync;
    debugConsoleState.latest.physicsCollisions = metrics.physicsCollisions;
    debugConsoleState.latest.scripts = metrics.scripts;
    debugConsoleState.latest.gpu = metrics.gpu ?? 0;
    debugConsoleState.latest.render = metrics.render;
    debugConsoleState.latest.ddgi = metrics.ddgi ?? 0;
    debugConsoleState.latest.systems = metrics.systems ?? null;
    debugConsoleState.latest.fps = metrics.frame > 0 ? 1000 / metrics.frame : 0;
    debugConsoleState.latest.delta = metrics.delta;

    pushTimingSample('frame', metrics.frame);
    pushTimingSample('update', metrics.update);
    pushTimingSample('physics', metrics.physics);
    pushTimingSample('physicsStep', metrics.physicsStep);
    pushTimingSample('physicsSync', metrics.physicsSync);
    pushTimingSample('physicsCollisions', metrics.physicsCollisions);
    pushTimingSample('scripts', metrics.scripts);
    pushTimingSample('gpu', metrics.gpu ?? 0);
    pushTimingSample('render', metrics.render);
    pushTimingSample('ddgi', metrics.ddgi ?? 0);
}
