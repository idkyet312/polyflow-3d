import { Fn, vec2, vec4, float, floor, fract, sin, dot, mix, hash } from 'three/tsl';

// ── Inigo Quilez "texture repetition" untiling ─────────────────────────────
// https://iquilezles.org/articles/texturerepetition/  (technique #3, the
// two-sample variant). Plain RepeatWrapping on a busy brick/cobble texture
// shows an obvious grid because every tile is byte-identical. MirroredRepeat
// removes the seam but adds a kaleidoscope symmetry that looks worse.
//
// This instead breaks the *content* repetition without a seam: the UV plane
// is diced into virtual cells; each cell gets a hash-driven random offset so
// the texture content differs cell-to-cell, and neighbouring cells are
// cross-faded so the offset change is never visible as an edge. The texture
// still tiles perfectly (it IS the same texture), the eye just can't lock
// onto a period.
//
// Cost: two texture samples + one tiny noise/hash instead of one sample.
// Derivatives stay correct because the per-cell offset is locally constant
// (constant within a cell ⇒ d(offset)/dscreen ≈ 0), so the implicit-gradient
// .sample() picks the right mip; no explicit textureGrad needed.

// Cheap 2D value hash → vec2 in [0,1). Deterministic, no texture lookup.
const hash2 = Fn(([p]) => {
    const h = vec2(
        dot(p, vec2(127.1, 311.7)),
        dot(p, vec2(269.5, 183.3)),
    );
    return fract(sin(h).mul(43758.5453)).toVar();
});

/**
 * Wrap a texture sampler so repeated tiling is visually broken up.
 *
 * @param {Node}  textureNode  a TSL `texture(map)` node (NOT pre-sampled).
 * @param {Node}  uv           the vec2 UV to sample at (already includes
 *                              any .repeat scaling / parallax offset).
 * @param {object} opts
 *   blendScale  - size of the cross-fade band relative to a cell (0..0.5).
 *                 Larger ⇒ smoother but more ghosting. 0.2 is a good start.
 *   strength    - 0 disables (returns the plain sample), 1 full untiling.
 * @returns {Node} vec4 sampled colour with repetition hidden.
 */
export function untileTextureSample(textureNode, uv, { blendScale = 0.2, strength = 1.0 } = {}) {
    return Fn(() => {
        // Virtual cell index + local fraction. The cell grid is in UV space
        // *after* .repeat, i.e. one cell ≈ one logical tile of the texture.
        const cell = floor(uv).toVar();
        const f = fract(uv).toVar();

        // Two decorrelated per-cell random offsets. Sampling the texture at
        // uv + offset (offset constant per cell) yields different content
        // per cell while still being a valid sample of the same tileable
        // texture (RepeatWrapping handles the wrap of the shifted coord).
        const offA = hash2(cell).toVar();
        const offB = hash2(cell.add(vec2(1.0, 1.0))).toVar();

        // Smooth cross-fade weight from the local fraction so the offset
        // swap between neighbouring cells is never a visible edge. Hermite
        // on both axes, combined into a single 0..1 blend.
        const b = float(blendScale).clamp(0.001, 0.5);
        const wx = f.x.smoothstep(float(0.5).sub(b), float(0.5).add(b));
        const wy = f.y.smoothstep(float(0.5).sub(b), float(0.5).add(b));
        const w = wx.mul(wy).toVar();

        const sA = textureNode.sample(uv.add(offA)).toVar();
        const sB = textureNode.sample(uv.add(offB)).toVar();
        const untiled = mix(sA, sB, w);

        // strength=0 ⇒ plain sample (lets callers A/B or disable per map).
        const plain = textureNode.sample(uv);
        return mix(plain, untiled, float(strength).clamp(0.0, 1.0));
    })();
}
