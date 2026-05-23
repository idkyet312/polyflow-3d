// Per-frame dynamic light culling.
//
// three's WebGPU light loop shades EVERY enabled point/spot light on every lit
// fragment. When a scene has many of them, most contribute nothing to what the
// camera sees (too far, or out of range). This system keeps only the N most
// important point/spot lights enabled each frame and disables the rest by
// zeroing their intensity — three skips zero-intensity lights, so disabled
// lights cost nothing in the shader. Directional / ambient / hemisphere lights
// are never touched (few of them; the sun keeps its shadow).
//
// Importance = intensity / (distance² + ε), gated by the light's own range
// (distance cutoff): a light whose sphere of influence doesn't reach the camera
// scores ~0. Active lights get a small hysteresis bonus so the set near the N
// boundary doesn't flicker frame-to-frame.
//
// Cost: one scene cull pass over the point/spot lights per frame (cheap — a few
// dozen entries). No render-target or shader changes; reversible by restoring
// every light's original intensity.

import * as THREE from 'three';

const EPS = 0.01;
const HYSTERESIS = 1.25;       // active lights get +25% score to resist flicker

export function createLightCull() {
    // Per-light bookkeeping: original intensity + whether we currently dimmed it.
    // Keyed by light.uuid so it survives scene rebuilds (stale entries are GC'd
    // lazily when a light is no longer found).
    const _orig = new Map();    // uuid -> original intensity
    const _active = new Set();  // uuid currently enabled by the culler
    const _camPos = new THREE.Vector3();
    const _lightPos = new THREE.Vector3();

    let _enabled = true;
    let _maxActive = 16;        // how many point/spot lights stay lit at once

    function setEnabled(on) {
        _enabled = !!on;
        if (!_enabled) restoreAll();
    }
    function setMaxActive(n) { _maxActive = Math.max(1, Math.min(256, n | 0)); }
    function isEnabled() { return _enabled; }
    function getMaxActive() { return _maxActive; }

    // Restore every light we ever dimmed back to its captured intensity.
    function restoreAll() {
        // Walk known lights via the scene on the next update; but also eagerly
        // restore from our captured originals if the light objects are reachable.
        for (const [, entry] of _orig) {
            if (entry.light && entry.dimmed) {
                entry.light.intensity = entry.intensity;
                entry.dimmed = false;
            }
        }
        _active.clear();
    }

    function captureOriginal(light) {
        let e = _orig.get(light.uuid);
        if (!e) {
            e = { light, intensity: light.intensity, dimmed: false };
            _orig.set(light.uuid, e);
        } else {
            e.light = light;
            // Refresh the stored "true" intensity only when the light is NOT
            // currently dimmed by us (so we capture user/game changes, not our 0).
            if (!e.dimmed) e.intensity = light.intensity;
        }
        return e;
    }

    // Called once per frame with the live scene + camera. Returns the count of
    // lights kept active (for HUD/debug).
    const _candidates = [];
    function update(scene, camera) {
        if (!_enabled || !scene || !camera) return 0;
        camera.getWorldPosition(_camPos);
        _candidates.length = 0;

        scene.traverse((o) => {
            if (!o.visible) return;
            if (!o.isPointLight && !o.isSpotLight) return;
            const e = captureOriginal(o);
            // Score by importance from the camera.
            o.getWorldPosition(_lightPos);
            const d2 = _camPos.distanceToSquared(_lightPos);
            const range = o.distance > 0 ? o.distance : Math.sqrt(e.intensity) * 6 + 4;
            // Out of range → near-zero importance (still sortable).
            const inRange = d2 <= (range * range) * 1.2;
            let score = inRange ? e.intensity / (d2 + EPS) : e.intensity / ((d2 + EPS) * 8);
            if (_active.has(o.uuid)) score *= HYSTERESIS;
            _candidates.push({ light: o, entry: e, score });
        });

        const total = _candidates.length;
        if (total <= _maxActive) {
            // Everything fits — make sure all are at full intensity.
            for (const c of _candidates) enable(c.entry);
            _active.clear();
            for (const c of _candidates) _active.add(c.light.uuid);
            return total;
        }

        // Keep the top _maxActive by score; dim the rest.
        _candidates.sort((a, b) => b.score - a.score);
        _active.clear();
        for (let i = 0; i < total; i++) {
            const c = _candidates[i];
            if (i < _maxActive) { enable(c.entry); _active.add(c.light.uuid); }
            else dim(c.entry);
        }
        return _maxActive;
    }

    function enable(entry) {
        if (entry.dimmed) {
            entry.light.intensity = entry.intensity;
            entry.dimmed = false;
        }
    }
    function dim(entry) {
        if (!entry.dimmed) {
            entry.intensity = entry.light.intensity;   // capture latest true value
            entry.light.intensity = 0;
            entry.dimmed = true;
        }
    }

    // Drop bookkeeping for lights no longer in the scene (call on level unload).
    function reset() {
        restoreAll();
        _orig.clear();
        _active.clear();
    }

    return {
        update, setEnabled, setMaxActive, isEnabled, getMaxActive,
        restoreAll, reset,
        get activeCount() { return _active.size; },
    };
}
