/**
 * ActorComponent — Base class for all actor components.
 *
 * Mirrors Unreal Engine's UActorComponent:
 *   - Owned by an Actor via `this.owner`
 *   - Lifecycle: beginPlay() → tick(delta) → endPlay()
 *   - Each subclass registers a static `componentKey` for lookup.
 */
export class ActorComponent {
    /** Override in subclasses. Used by GetComponent / HasComponent lookups. */
    static componentKey = 'ActorComponent';

    constructor() {
        /** @type {import('../sceneRuntime.js').Actor | null} */
        this.owner = null;
        this._active = true;
    }

    // ───────── Lifecycle ─────────

    /** Called once when the component is first registered on a playing actor. */
    beginPlay() {}

    /** Called every frame while the component is active. */
    tick(deltaTime) {} // eslint-disable-line no-unused-vars

    /** Called when the component is removed or the actor is destroyed. */
    endPlay() {}

    // ───────── State helpers ─────────

    /** Enable / disable per-frame ticking. */
    setActive(active) {
        this._active = !!active;
    }

    isActive() {
        return this._active;
    }

    /** Shorthand: get the owning actor. */
    getOwner() {
        return this.owner;
    }

    /** Shorthand: get another component on the same actor. */
    getComponent(ComponentClass) {
        return this.owner?.getComponentByClass?.(ComponentClass) ?? null;
    }
}
