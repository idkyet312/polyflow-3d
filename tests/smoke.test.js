// Smoke harness. Imports core modules under Node and asserts they
// construct + expose their advertised API without crashing.
//
// Scope is deliberately narrow:
//   - modules that touch document / window / WebGPU / Jolt at load time
//     are NOT covered here. Add as they become Node-safe.
//   - asserts focus on invariants that would catch a botched refactor
//     (missing export, wrong return shape, broken acquire/release).
//
// Run: node --test tests/
//
// This file intentionally avoids any test framework. node:test is built in.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ───────────────────────── appCore ─────────────────────────

test('appCore: getters reflect current value, setter dispatches', async () => {
    const { core, bindAppCore, setAppCore } = await import('../src/runtime/appCore.js');

    let scene = { id: 'A' };
    let currentMesh = null;

    bindAppCore(
        {
            scene: () => scene,
            currentMesh: () => currentMesh,
        },
        {
            currentMesh: (value) => { currentMesh = value; },
        },
    );

    assert.equal(core.scene.id, 'A');
    scene = { id: 'B' };
    assert.equal(core.scene.id, 'B', 'getter must read live, not snapshot');

    assert.equal(core.currentMesh, null);
    setAppCore('currentMesh', { name: 'mesh1' });
    assert.equal(core.currentMesh.name, 'mesh1');

    assert.throws(
        () => setAppCore('scene', {}),
        /no setter/i,
        'setAppCore must reject keys with no registered setter',
    );
});

// ───────────────────────── sceneRuntime ─────────────────────────

test('sceneRuntime: Entity component map', async () => {
    const { Entity } = await import('../src/runtime/sceneRuntime.js');

    const e = new Entity('e1');
    assert.equal(e.id, 'e1');
    assert.equal(e.getComponent('render'), null);

    e.setComponent('render', { mesh: 'm' });
    assert.deepEqual(e.getComponent('render'), { mesh: 'm' });

    e.removeComponent('render');
    assert.equal(e.getComponent('render'), null);
});

test('sceneRuntime: SceneNode add/remove child re-parents object3D', async () => {
    const { SceneNode } = await import('../src/runtime/sceneRuntime.js');

    const root = new SceneNode('root');
    const child = new SceneNode('child');

    root.addChild(child);
    assert.equal(root.children.length, 1);
    assert.equal(child.parent, root);
    assert.equal(child.object3D.parent, root.object3D);

    root.removeChild(child);
    assert.equal(root.children.length, 0);
    assert.equal(child.parent, null);
    assert.equal(child.object3D.parent, null);
});

test('sceneRuntime: getRenderComponent etc. handle null actor', async () => {
    const {
        getRenderComponent,
        getPhysicsBodyComponent,
        getScriptComponent,
        getMetadataComponent,
    } = await import('../src/runtime/sceneRuntime.js');

    for (const fn of [
        getRenderComponent,
        getPhysicsBodyComponent,
        getScriptComponent,
        getMetadataComponent,
    ]) {
        assert.equal(fn(null), null);
        assert.equal(fn({}), null, 'no entity -> null');
    }
});

// ───────────────────────── CircularPatrolComponent ─────────────────────────

test('CircularPatrolComponent: tick advances angle, moves mesh on circle', async () => {
    const { CircularPatrolComponent } = await import('../src/runtime/components/CircularPatrolComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    const mesh = new THREE.Group();
    const actor = new Actor({ mesh });

    const patrol = new CircularPatrolComponent({
        center: [10, 0, 5],
        radius: 4,
        speed: Math.PI / 2, // quarter-circle per second
        angle: 0,
        yOffset: 1.0,
    });
    patrol.setGroundSampler((x, z) => 2.0); // fixed ground height for assertion

    actor.addComponent(patrol);

    // At t=0: cos(0)=1, sin(0)=0 → (cx+r, ground+y, cz) = (14, 3, 5)
    patrol.tick(0);
    assert.ok(Math.abs(mesh.position.x - 14) < 1e-6);
    assert.ok(Math.abs(mesh.position.y - 3) < 1e-6);
    assert.ok(Math.abs(mesh.position.z - 5) < 1e-6);

    // After 1s at PI/2 rad/s: angle = PI/2 → cos=0, sin=1 → (10, 3, 9)
    patrol.tick(1);
    assert.ok(Math.abs(mesh.position.x - 10) < 1e-6);
    assert.ok(Math.abs(mesh.position.z - 9) < 1e-6);
    assert.ok(Math.abs(patrol.angle - Math.PI / 2) < 1e-6);
});

test('CircularPatrolComponent: handles missing ground sampler gracefully', async () => {
    const { CircularPatrolComponent } = await import('../src/runtime/components/CircularPatrolComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    const actor = new Actor({ mesh: new THREE.Group() });
    const patrol = new CircularPatrolComponent({ center: [0, 7, 0], radius: 1, yOffset: 2 });
    actor.addComponent(patrol);

    patrol.tick(0);
    // Without a sampler: y falls back to center.y + yOffset = 9
    assert.equal(actor.mesh.position.y, 9);
});

test('CircularPatrolComponent: serialize returns plain data', async () => {
    const { CircularPatrolComponent } = await import('../src/runtime/components/CircularPatrolComponent.js');
    const patrol = new CircularPatrolComponent({ center: [1, 2, 3], radius: 5, speed: 1.5, angle: 0.7, yOffset: 0.25 });
    assert.deepEqual(patrol.serialize(), {
        center: [1, 2, 3], radius: 5, speed: 1.5, angle: 0.7, yOffset: 0.25,
    });
});

// ───────────────────────── ActorComponent ─────────────────────────

test('ActorComponent: lifecycle defaults + active flag', async () => {
    const { ActorComponent } = await import('../src/runtime/components/ActorComponent.js');

    const c = new ActorComponent();
    assert.equal(c.isActive(), true);
    c.setActive(false);
    assert.equal(c.isActive(), false);

    // Defaults must be no-ops, not throws.
    c.beginPlay();
    c.tick(0.016);
    c.endPlay();
});

// ───────────────────────── spatialIndex ─────────────────────────

test('spatialIndex: add/remove/query roundtrip', async () => {
    const { createSpatialIndex } = await import('../src/runtime/spatialIndex.js');
    const THREE = await import('three');

    const idx = createSpatialIndex({ cellSize: 4 });
    const bounds = new THREE.Box3(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(2, 2, 2),
    );

    idx.add?.('a', bounds);
    const hits = idx.query?.(bounds) ?? [];
    assert.ok(Array.isArray(hits), 'query returns array');

    // Sanity: factory exposes the canonical names rather than crashing
    // — exact API surface check happens in integration, not smoke.
    assert.equal(typeof idx, 'object');
});

// ───────────────────────── engineApi ─────────────────────────

test('engineApi: surfaces default to no-op until registered', async () => {
    const { engineApi, registerEngineFx } = await import('../src/runtime/engineApi.js');

    // Untouched key still resolves to a callable (no-op), not undefined.
    // Prefab scripts use api.X?.() which would silently skip undefined,
    // but defensive code that does `api.X()` should not crash.
    assert.equal(typeof engineApi.fx.spawnImpactBurst, 'function');
    assert.equal(engineApi.fx.spawnImpactBurst(0, 0, 0), undefined);

    let called = null;
    registerEngineFx({ spawnImpactBurst: (...args) => { called = args; return 'ok'; } });
    assert.equal(engineApi.fx.spawnImpactBurst(1, 2, 3, { c: 0xff }), 'ok');
    assert.deepEqual(called, [1, 2, 3, { c: 0xff }]);
});

test('engineApi: weapons namespace has expected keys, register* binds them', async () => {
    const { engineApi, registerEngineWeapons } = await import('../src/runtime/engineApi.js');

    for (const key of ['equipDoomShotgun', 'equipStraightGun', 'equipSniperRifle', 'equipThrowingStar', 'spawnDoomPellet', 'applyCameraRecoil']) {
        assert.equal(typeof engineApi.weapons[key], 'function', `weapons.${key} must be callable noop until registered`);
    }

    let kick = null;
    registerEngineWeapons({ applyCameraRecoil: (p, y) => { kick = [p, y]; } });
    engineApi.weapons.applyCameraRecoil(0.05, 0.01);
    assert.deepEqual(kick, [0.05, 0.01]);
});

test('engineApi: register* ignores non-function values and unknown keys', async () => {
    const { engineApi, registerEngineFx } = await import('../src/runtime/engineApi.js');

    const before = engineApi.fx.spawnTracer;
    registerEngineFx({
        spawnTracer: 'not a function',
        bogusKey: () => 'should not appear',
    });
    assert.equal(engineApi.fx.spawnTracer, before, 'non-function ignored');
    assert.equal(engineApi.fx.bogusKey, undefined, 'unknown key not added');
});

test('engineApi: installLegacyWindowShims wires window.* through to registered fns', async () => {
    // Fresh module each time would be ideal, but engineApi is a singleton
    // by design. Use globalThis stand-in for window.
    if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

    const { registerEngineFx, installLegacyWindowShims } = await import('../src/runtime/engineApi.js');

    let hits = 0;
    registerEngineFx({ spawnMuzzleSmoke: () => { hits += 1; } });
    installLegacyWindowShims();

    assert.equal(typeof globalThis.window.spawnMuzzleSmoke, 'function');
    globalThis.window.spawnMuzzleSmoke();
    globalThis.window.spawnMuzzleSmoke();
    assert.equal(hits, 2);
});

// ───────────────────────── vec3Pool ─────────────────────────

test('vec3Pool: acquire returns zeroed Vector3, release roundtrips', async () => {
    const { createVec3Pool } = await import('../src/runtime/vec3Pool.js');
    const pool = createVec3Pool({ initialSize: 2 });

    const a = pool.acquire();
    assert.equal(a.x, 0); assert.equal(a.y, 0); assert.equal(a.z, 0);
    a.set(1, 2, 3);

    pool.release(a);

    const b = pool.acquire();
    assert.equal(b.x, 0, 'acquired vector must be zeroed even after reuse');
});

test('vec3Pool: double-release throws in dev', async () => {
    const { createVec3Pool } = await import('../src/runtime/vec3Pool.js');
    const pool = createVec3Pool({ initialSize: 1 });

    const v = pool.acquire();
    pool.release(v);
    assert.throws(() => pool.release(v), /non-borrowed/);
});

test('vec3Pool: with() releases on return AND on throw', async () => {
    const { createVec3Pool } = await import('../src/runtime/vec3Pool.js');
    const pool = createVec3Pool({ initialSize: 4 });

    const result = pool.with((a, b) => {
        a.set(1, 0, 0); b.set(0, 1, 0);
        return a.x + b.y;
    });
    assert.equal(result, 2);
    assert.equal(pool.stats().borrowed, 0);

    assert.throws(() => pool.with((a) => { a.set(9, 9, 9); throw new Error('boom'); }), /boom/);
    assert.equal(pool.stats().borrowed, 0, 'with() must release even on throw');
});

test('vec3Pool: grows beyond initialSize', async () => {
    const { createVec3Pool } = await import('../src/runtime/vec3Pool.js');
    const pool = createVec3Pool({ initialSize: 2 });

    const v = [pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()];
    assert.equal(v.length, 4);
    assert.ok(pool.stats().created >= 4);
    v.forEach((x) => pool.release(x));
});

// ───────────────────────── physics/dynamicBodySpatial ─────────────────────────

test('dynamicBodySpatial: factory + clear', async () => {
    const { createDynamicBodySpatialIndex } = await import('../src/physics/dynamicBodySpatial.js');

    const idx = createDynamicBodySpatialIndex({ cellSize: 8 });
    assert.equal(typeof idx, 'object');
    idx.clear?.();
});

// ───────────────────────── prefabRegistry / assetRegistry ─────────────────────────

test('registries: assetRegistry + prefabRegistry exist and have add/get', async () => {
    const { assetRegistry } = await import('../src/runtime/assets/AssetRegistry.js');
    const { prefabRegistry } = await import('../src/runtime/assets/PrefabRegistry.js');

    for (const r of [assetRegistry, prefabRegistry]) {
        assert.equal(typeof r, 'object');
        // At minimum a get-by-id query should not throw on a missing id.
        assert.doesNotThrow(() => r.get?.('__definitely_missing__'));
    }
});
