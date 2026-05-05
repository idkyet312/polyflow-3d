// src/world/splat/perfMode.js
//
// Runtime selector for splat sort backends.

import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { buildSplatMesh as buildSplatMeshWorker } from './splatRenderer.js';
import { buildSplatMeshCompute } from './splatRendererCompute.js';
import { normalizeSplatBlendMode } from './blendMode.js';

const VALID_MODES = ['auto', 'compute', 'worker', 'off'];
const STORAGE_KEY = 'polyflow.splatSortMode';
const SH_STORAGE_KEY = 'polyflow.splatShDegree';
const BLEND_STORAGE_KEY = 'polyflow.splatBlendMode';

let _modeOverride = readInitialModeOverride(); // null = auto
let _shDegree = readInitialShDegree();
let _blendMode = readInitialBlendMode();
let _lastStatus = {
    requestedMode: _modeOverride || 'auto',
    effectiveMode: 'worker',
    computeSupported: false,
    message: 'No splat loaded yet.',
    error: '',
    hasSH: false,
    shDegree: _shDegree,
    shMaxDegree: 0,
    shBytes: 0,
    blendMode: _blendMode,
};

function normalizeMode(mode) {
    if (mode === null || mode === undefined || mode === '') return 'auto';
    return VALID_MODES.includes(mode) ? mode : null;
}

function readInitialModeOverride() {
    if (typeof window === 'undefined') return null;

    const params = new URLSearchParams(window.location.search);
    const fromUrl = normalizeMode(params.get('splatSort'));
    if (fromUrl) return fromUrl === 'auto' ? null : fromUrl;

    try {
        const fromStorage = normalizeMode(window.localStorage?.getItem(STORAGE_KEY));
        return fromStorage && fromStorage !== 'auto' ? fromStorage : null;
    } catch {
        return null;
    }
}

function persistMode(mode) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage?.setItem(STORAGE_KEY, mode || 'auto');
    } catch {
        // Ignore restricted storage contexts.
    }
}

function readInitialShDegree() {
    if (typeof window === 'undefined') return 3;
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('splatSH');
    let raw = fromUrl;
    if (raw === null) {
        try {
            raw = window.localStorage?.getItem(SH_STORAGE_KEY);
        } catch {
            raw = null;
        }
    }
    const degree = Number.parseInt(raw ?? '3', 10);
    return Number.isFinite(degree) ? Math.max(0, Math.min(3, degree)) : 0;
}

function persistShDegree(degree) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage?.setItem(SH_STORAGE_KEY, String(degree));
    } catch {
        // Ignore restricted storage contexts.
    }
}

function readInitialBlendMode() {
    if (typeof window === 'undefined') return 'reference';
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('splatBlend');
    let raw = fromUrl;
    if (raw === null) {
        try {
            raw = window.localStorage?.getItem(BLEND_STORAGE_KEY);
        } catch {
            raw = null;
        }
    }
    return normalizeSplatBlendMode(raw || 'reference');
}

function persistBlendMode(mode) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage?.setItem(BLEND_STORAGE_KEY, mode);
    } catch {
        // Ignore restricted storage contexts.
    }
}

function dispatchStatus() {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('splat-sort-status', { detail: getSplatSortStatus() }));
}

function setLastStatus(patch) {
    _lastStatus = {
        ..._lastStatus,
        requestedMode: _modeOverride || 'auto',
        computeSupported: detectComputeSupport(),
        ...patch,
    };
    dispatchStatus();
}

export function setSplatSortMode(mode, opts = {}) {
    const normalized = normalizeMode(mode);
    if (!normalized) {
        console.warn(`[splat-perfMode] unknown mode "${mode}", ignoring.`);
        return;
    }

    _modeOverride = normalized === 'auto' ? null : normalized;
    if (opts.persist !== false) persistMode(normalized);
    setLastStatus({
        effectiveMode: normalized === 'auto'
            ? (detectComputeSupport() ? 'compute' : 'worker')
            : normalized,
        message: `Splat sort mode set to ${normalized}. New splats use this mode.`,
        error: '',
    });
}

export function getSplatSortMode() {
    return _modeOverride || 'auto';
}

export function getSplatSortStatus() {
    return { ..._lastStatus };
}

export function setSplatShDegree(degree, opts = {}) {
    const next = Math.max(0, Math.min(3, Number.parseInt(degree, 10) || 0));
    _shDegree = next;
    if (opts.persist !== false) persistShDegree(next);
    setLastStatus({
        shDegree: next,
        message: `Splat SH degree set to ${next}. New compute splats use this degree.`,
        error: '',
    });
}

export function getSplatShDegree() {
    return _shDegree;
}

export function setSplatBlendMode(mode, opts = {}) {
    _blendMode = normalizeSplatBlendMode(mode);
    if (opts.persist !== false) persistBlendMode(_blendMode);
    setLastStatus({
        blendMode: _blendMode,
        message: `Splat blend mode set to ${_blendMode}. New splats use this mode.`,
        error: '',
    });
}

export function getSplatBlendMode() {
    return _blendMode;
}

export function detectComputeSupport() {
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;
    return typeof StorageInstancedBufferAttribute === 'function';
}

export function buildSplatMeshAuto(splatData) {
    const requestedMode = _modeOverride || 'auto';
    const computeSupported = detectComputeSupport();
    const mode = requestedMode === 'auto'
        ? (computeSupported ? 'compute' : 'worker')
        : requestedMode;

    if (mode === 'compute') {
        if (!computeSupported) {
            const mesh = buildSplatMeshWorker(splatData, { blendMode: _blendMode });
            mesh.userData.splatSortMode = 'worker';
            mesh.userData.splatSortRequestedMode = requestedMode;
            mesh.userData.splatSortFallbackReason = 'WebGPU storage buffers are unavailable.';
            setLastStatus({
                effectiveMode: 'worker',
                hasSH: !!splatData.sh,
                shDegree: 0,
                shMaxDegree: splatData.sh?.degree || 0,
                shBytes: 0,
                blendMode: _blendMode,
                message: 'Compute unavailable. Using worker sort.',
                error: mesh.userData.splatSortFallbackReason,
            });
            return mesh;
        }

        try {
            const mesh = buildSplatMeshCompute(splatData, { shDegree: _shDegree, blendMode: _blendMode });
            mesh.userData.splatSortMode = 'compute';
            mesh.userData.splatSortRequestedMode = requestedMode;
            const actualShDegree = mesh.userData.splatShDegree || 0;
            const shFallback = mesh.userData.splatShFallbackReason || '';
            setLastStatus({
                effectiveMode: 'compute',
                hasSH: !!splatData.sh,
                shDegree: actualShDegree,
                shMaxDegree: splatData.sh?.degree || 0,
                shBytes: mesh.userData.splatShBytes || 0,
                blendMode: _blendMode,
                message: `Compute sort active for ${splatData.count.toLocaleString()} splats. SH deg ${actualShDegree}.${shFallback ? ` ${shFallback}` : ''}`,
                error: '',
            });
            return mesh;
        } catch (err) {
            console.warn('[splat-perfMode] compute path threw at build time, falling back to worker:', err);
            const mesh = buildSplatMeshWorker(splatData, { blendMode: _blendMode });
            mesh.userData.splatSortMode = 'worker';
            mesh.userData.splatSortRequestedMode = requestedMode;
            mesh.userData.splatSortFallbackReason = err?.message || String(err);
            setLastStatus({
                effectiveMode: 'worker',
                hasSH: !!splatData.sh,
                shDegree: 0,
                shMaxDegree: splatData.sh?.degree || 0,
                shBytes: 0,
                blendMode: _blendMode,
                message: 'Compute build failed. Using worker sort.',
                error: mesh.userData.splatSortFallbackReason,
            });
            return mesh;
        }
    }

    const mesh = buildSplatMeshWorker(splatData, { attachSort: mode !== 'off', blendMode: _blendMode });
    mesh.userData.splatSortMode = mode === 'off' ? 'off' : 'worker';
    mesh.userData.splatSortRequestedMode = requestedMode;
    setLastStatus({
        effectiveMode: mesh.userData.splatSortMode,
        hasSH: !!splatData.sh,
        shDegree: 0,
        shMaxDegree: splatData.sh?.degree || 0,
        shBytes: 0,
        blendMode: _blendMode,
        message: mode === 'off'
            ? `Splat sort disabled for ${splatData.count.toLocaleString()} splats.`
            : `Worker sort active for ${splatData.count.toLocaleString()} splats.`,
        error: '',
    });
    return mesh;
}
