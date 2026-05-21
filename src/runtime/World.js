// A World owns one engine instance's mutable runtime singletons: event bus,
// system registry, and (later) scene, physics core, and lifecycle handles.
//
// Today runtime.js holds a single global eventBus + gameplaySystems at module
// scope. That works for one window but breaks:
//   - tests that want a clean bus between cases
//   - hot-reload (old listeners stay subscribed forever)
//   - any future multi-scene / multi-instance use case
//
// createWorld() returns a new container; existing code keeps working because
// runtime.js holds `defaultWorld = createWorld({ id: 'main' })` and exposes
// its bus + systems with the same references it used to publish at module
// scope.
//
//   const world = createWorld({ id: 'main' });
//   world.eventBus.emit('player:died', { ... });
//   world.systems.tick(delta);
//   world.dispose();   // clears listeners + unregisters all systems

import { createEventBus } from './eventBus.js';
import { createSystemRegistry } from './systemRegistry.js';

export function createWorld({ id = 'default' } = {}) {
    const eventBus = createEventBus();
    const systems = createSystemRegistry();

    function dispose() {
        eventBus.clear();
        // Snapshot names because unregister mutates the underlying Map.
        for (const name of systems.getOrder()) {
            systems.unregister(name);
        }
    }

    return { id, eventBus, systems, dispose };
}
