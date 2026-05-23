// Adaptive quality — an FPS watchdog that automatically steps graphics effects
// down when the frame rate drops and back up when it recovers. Mirrors the
// "dynamic performance degradation" in the Sponza demo.
//
// It works on a tier ladder: tier 0 = the user's full settings, each higher
// tier disables one more expensive effect (in cost order). When the rolling FPS
// stays below LOW_FPS for HOLD_DOWN_MS, it raises the tier (degrades). When FPS
// stays above HIGH_FPS for HOLD_UP_MS, it lowers the tier (restores).
//
// Crucially it never turns ON something the user had OFF: when adaptive turns
// on it snapshots the user's "baseline" enabled flags, and each tier only
// disables effects that were on in the baseline. Disabling adaptive restores
// the baseline exactly.
//
// Effects are degraded most-expensive-first:
//   tier 1: SSR off
//   tier 2: TAA off
//   tier 3: SSGI off
//   tier 4: SSAO off
//   tier 5: bloom off
//   tier 6: light cull maxActive halved (min 4)
// Tier 0 restores everything in the baseline.

const LOW_FPS = 50;
const HIGH_FPS = 58;
const HOLD_DOWN_MS = 1500;   // sustained low before degrading
const HOLD_UP_MS = 4000;     // sustained high before restoring (slower, anti-oscillation)
const SAMPLE_SMOOTHING = 0.1; // EMA factor for fps

export function createAdaptiveQuality({ getState, applyState }) {
    let _enabled = false;
    let _tier = 0;
    let _fps = 60;
    let _belowSince = 0;
    let _aboveSince = 0;
    let _baseline = null;       // snapshot of user flags when adaptive turned on

    const MAX_TIER = 6;

    function snapshot() {
        const s = getState();
        return {
            ssr: !!s.ssr?.enabled,
            aa: !!s.aa?.enabled,
            ssgi: !!s.ssgi?.enabled,
            ssao: !!s.ssao?.enabled,
            bloom: !!s.bloom?.enabled,
            maxActive: s.lightCull?.maxActive ?? 16,
        };
    }

    // Apply tier T against the captured baseline: effects above the tier's
    // threshold are forced off; everything else returns to the baseline value.
    function applyTier(t) {
        if (!_baseline) return;
        const s = getState();
        if (s.ssr) s.ssr.enabled = _baseline.ssr && t < 1;
        if (s.aa) s.aa.enabled = _baseline.aa && t < 2;
        if (s.ssgi) s.ssgi.enabled = _baseline.ssgi && t < 3;
        if (s.ssao) s.ssao.enabled = _baseline.ssao && t < 4;
        if (s.bloom) s.bloom.enabled = _baseline.bloom && t < 5;
        if (s.lightCull) {
            s.lightCull.maxActive = t < 6 ? _baseline.maxActive : Math.max(4, _baseline.maxActive >> 1);
        }
        applyState({ persist: false, switchSky: false });
    }

    function setEnabled(on) {
        on = !!on;
        if (on === _enabled) return;
        _enabled = on;
        if (on) {
            _baseline = snapshot();
            _tier = 0;
            _belowSince = _aboveSince = 0;
        } else if (_baseline) {
            // Restore the user's baseline exactly.
            const s = getState();
            if (s.ssr) s.ssr.enabled = _baseline.ssr;
            if (s.aa) s.aa.enabled = _baseline.aa;
            if (s.ssgi) s.ssgi.enabled = _baseline.ssgi;
            if (s.ssao) s.ssao.enabled = _baseline.ssao;
            if (s.bloom) s.bloom.enabled = _baseline.bloom;
            if (s.lightCull) s.lightCull.maxActive = _baseline.maxActive;
            applyState({ persist: false, switchSky: false });
            _baseline = null;
            _tier = 0;
        }
    }
    function isEnabled() { return _enabled; }
    function getTier() { return _tier; }
    function getFps() { return _fps; }

    // Re-snapshot the baseline (e.g. after the user manually changes settings
    // while adaptive is on). Call when settings are applied externally.
    function rebaseline() {
        if (_enabled && _tier === 0) _baseline = snapshot();
    }

    // Called every frame with the frame delta (seconds). Timers accumulate from
    // dt (not wall-clock) so behaviour is deterministic regardless of how the
    // host schedules frames.
    function update(dt) {
        if (!_enabled || !(dt > 0)) return;
        const instant = 1 / dt;
        _fps += (instant - _fps) * SAMPLE_SMOOTHING;
        const ms = dt * 1000;

        if (_fps < LOW_FPS) {
            _aboveSince = 0;
            _belowSince += ms;
            if (_belowSince >= HOLD_DOWN_MS && _tier < MAX_TIER) {
                _tier++;
                applyTier(_tier);
                _belowSince = 0;   // wait the full hold again before the next step down
            }
        } else if (_fps > HIGH_FPS) {
            _belowSince = 0;
            _aboveSince += ms;
            if (_aboveSince >= HOLD_UP_MS && _tier > 0) {
                _tier--;
                applyTier(_tier);
                _aboveSince = 0;
            }
        } else {
            // In the dead band — hold steady.
            _belowSince = _aboveSince = 0;
        }
    }

    return { update, setEnabled, isEnabled, getTier, getFps, rebaseline };
}
