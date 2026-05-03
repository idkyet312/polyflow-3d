/**
 * Octahedral encoding helpers as GLSL chunks.
 *
 * We use plain GLSL chunks injected into TSL via `wgslFn` / `glslFn` style
 * helpers (or as raw onBeforeCompile chunks if a fallback path is needed).
 * For Phase C we operate in raw GLSL inside ShaderMaterial — TSL fragment
 * passes can wrap these as `glslFn` later if we promote to NodeMaterial.
 */

export const OCT_GLSL = /* glsl */`
// Cigolle et al. 2014 octahedral mapping. Input dir need not be normalized
// for octEncode, but we normalize for safety.
vec2 octWrap(vec2 v) {
    return (1.0 - abs(v.yx)) * vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0);
}

vec2 octEncode(vec3 n) {
    n = normalize(n);
    n /= (abs(n.x) + abs(n.y) + abs(n.z));
    vec2 enc = (n.z >= 0.0) ? n.xy : octWrap(n.xy);
    return enc * 0.5 + 0.5; // [0,1]
}

vec3 octDecode(vec2 f) {
    f = f * 2.0 - 1.0;
    vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
    float t = max(-n.z, 0.0);
    n.x += n.x >= 0.0 ? -t : t;
    n.y += n.y >= 0.0 ? -t : t;
    return normalize(n);
}
`;
