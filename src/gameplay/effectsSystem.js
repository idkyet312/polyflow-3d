// Gameplay FX pool (death bursts, tracers, decals). Each effect is
// { type, particles[], ttl, maxTtl, staticFx? } where each particle owns
// its own THREE mesh + velocity. Per-frame: advance TTL, gravity-pull
// non-static particles, fade material opacity, dispose when TTL ≤ 0.
//
// Effect spawning still happens in callers (combatFx + shooterAi push to
// gameplayPrefabState.effects). This module owns the lifecycle: update +
// clear + dispose.
//
// Deps:
//   gameplayPrefabState - shared state container with .effects[]
export function createEffectsSystem({ gameplayPrefabState }) {
    function disposeEffectParticles(effect) {
        for (const particle of effect.particles || []) {
            particle.mesh?.parent?.remove(particle.mesh);
            particle.mesh?.geometry?.dispose?.();
            particle.mesh?.material?.dispose?.();
        }
    }

    function updateGameplayEffects(delta = 0) {
        const effects = gameplayPrefabState.effects;
        if (!effects.length) return;
        for (let i = effects.length - 1; i >= 0; i--) {
            const effect = effects[i];
            effect.ttl -= delta;
            const alpha = Math.max(0, effect.ttl / (effect.maxTtl || 1));
            for (const particle of effect.particles || []) {
                // staticFx effects (tracers, decals) don't move or fall — just fade.
                if (!effect.staticFx) {
                    particle.velocity.y -= 7.5 * delta;
                    particle.mesh.position.addScaledVector(particle.velocity, delta);
                }
                if (particle.mesh.material) {
                    particle.mesh.material.opacity = (particle.baseOpacity ?? 1) * alpha;
                }
            }
            if (effect.ttl <= 0) {
                disposeEffectParticles(effect);
                effects.splice(i, 1);
            }
        }
    }

    function clearGameplayEffects() {
        for (const effect of gameplayPrefabState.effects) {
            disposeEffectParticles(effect);
        }
        gameplayPrefabState.effects.length = 0;
    }

    return { updateGameplayEffects, clearGameplayEffects };
}
