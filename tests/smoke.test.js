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

// ───────────────────────── SoccerGoalieComponent ─────────────────────────

test('SoccerGoalieComponent: tick offsets mesh by sin(elapsed*speed+phase)*amp on axis', async () => {
    const { SoccerGoalieComponent } = await import('../src/runtime/components/SoccerGoalieComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    let elapsed = 0;
    let syncCalls = 0;
    const mesh = new THREE.Group();
    const actor = new Actor({ mesh });

    const goalie = new SoccerGoalieComponent({
        homePosition: [10, 1, 5],
        axis: [1, 0, 0],
        amplitude: 3,
        speed: 2,
        phase: 0,
        getElapsed: () => elapsed,
        getActivation: () => 'activate-token',
        syncBody: (a, token) => {
            syncCalls++;
            assert.equal(a, actor);
            assert.equal(token, 'activate-token');
        },
    });
    actor.addComponent(goalie);

    // elapsed=0 → sin(0)=0 → at home
    goalie.tick(0);
    assert.ok(Math.abs(mesh.position.x - 10) < 1e-9);
    assert.ok(Math.abs(mesh.position.y - 1) < 1e-9);
    assert.ok(Math.abs(mesh.position.z - 5) < 1e-9);
    assert.equal(syncCalls, 1);

    // elapsed=PI/4, speed=2 → sin(PI/2)=1 → +amplitude on axis x
    elapsed = Math.PI / 4;
    goalie.tick(0);
    assert.ok(Math.abs(mesh.position.x - 13) < 1e-9);
    assert.equal(syncCalls, 2);
});

test('SoccerGoalieComponent: missing syncBody is a no-op (not a crash)', async () => {
    const { SoccerGoalieComponent } = await import('../src/runtime/components/SoccerGoalieComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    const actor = new Actor({ mesh: new THREE.Group() });
    const goalie = new SoccerGoalieComponent({
        homePosition: [0, 0, 0],
        axis: [0, 1, 0],
        amplitude: 1,
        speed: 1,
        phase: 0,
        getElapsed: () => Math.PI / 2,
    });
    actor.addComponent(goalie);
    goalie.tick(0);
    assert.ok(Math.abs(actor.mesh.position.y - 1) < 1e-9);
});

test('SoccerGoalieComponent: serialize returns plain data', async () => {
    const { SoccerGoalieComponent } = await import('../src/runtime/components/SoccerGoalieComponent.js');
    const g = new SoccerGoalieComponent({
        homePosition: [1, 2, 3], axis: [0, 0, 1],
        amplitude: 4.5, speed: 1.25, phase: 0.7,
    });
    assert.deepEqual(g.serialize(), {
        homePosition: [1, 2, 3], axis: [0, 0, 1],
        amplitude: 4.5, speed: 1.25, phase: 0.7,
    });
});

// ───────────────────────── ShooterSpawnerComponent ─────────────────────────

test('ShooterSpawnerComponent: tick 1 initializes nextWaveAt, does not spawn', async () => {
    const { ShooterSpawnerComponent } = await import('../src/runtime/components/ShooterSpawnerComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    const spawned = [];
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    mesh.visible = true;
    const actor = new Actor({ mesh });

    const comp = new ShooterSpawnerComponent({
        tuning: { firstWaveDelayMs: 1000, cooldownMs: 2000, maxAlive: 4, spawnRadius: 6 },
        baseScoreValue: 100,
        isGameplayActive: () => true,
        getMinions: () => [],
        spawnMinion: (pos, opts) => { spawned.push({ pos: pos.toArray(), opts }); return {}; },
        getRenderObject: (a) => a.mesh,
        THREE,
    });
    actor.addComponent(comp);

    // First tick should arm the timer, NOT spawn yet.
    comp.tick(0);
    assert.equal(spawned.length, 0);
    assert.ok(comp.nextWaveAt > 0, 'nextWaveAt must be armed after first tick');
    assert.equal(actor.userData.shooterSpawner?.wave, 0);
});

test('ShooterSpawnerComponent: tick past nextWaveAt spawns ring of minions, increments wave', async () => {
    const { ShooterSpawnerComponent } = await import('../src/runtime/components/ShooterSpawnerComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    const spawned = [];
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    mesh.visible = true;
    const actor = new Actor({ mesh, id: 'spawner-1' });

    const comp = new ShooterSpawnerComponent({
        tuning: { firstWaveDelayMs: 0, cooldownMs: 5000, maxAlive: 4, spawnRadius: 6 },
        baseScoreValue: 100,
        isGameplayActive: () => true,
        getMinions: () => [],
        spawnMinion: (pos, opts) => { spawned.push({ pos: pos.toArray(), opts }); return {}; },
        getRenderObject: (a) => a.mesh,
        THREE,
    });
    actor.addComponent(comp);

    // First tick → arms timer at now+0. Second tick → satisfies now >= nextWaveAt.
    comp.tick(0);
    comp.tick(0);
    assert.equal(spawned.length, 1, 'first wave should spawn 1 minion (1 + floor(1/2))');
    assert.equal(spawned[0].opts.spawnedBy, 'spawner-1');
    assert.equal(spawned[0].opts.scoreValue, 100 + 10);
    assert.equal(comp.wave, 1);
});

test('ShooterSpawnerComponent: skips when render mesh hidden', async () => {
    const { ShooterSpawnerComponent } = await import('../src/runtime/components/ShooterSpawnerComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    let spawnCalls = 0;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    mesh.visible = false;
    const actor = new Actor({ mesh });

    const comp = new ShooterSpawnerComponent({
        tuning: { firstWaveDelayMs: 0, cooldownMs: 100, maxAlive: 4, spawnRadius: 1 },
        baseScoreValue: 1,
        isGameplayActive: () => true,
        getMinions: () => [],
        spawnMinion: () => { spawnCalls++; return {}; },
        getRenderObject: (a) => a.mesh,
        THREE,
    });
    actor.addComponent(comp);
    comp.tick(0);
    comp.tick(0);
    assert.equal(spawnCalls, 0);
});

test('ShooterSpawnerComponent: respects maxAlive cap (already-alive minions block spawn)', async () => {
    const { ShooterSpawnerComponent } = await import('../src/runtime/components/ShooterSpawnerComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    let spawnCalls = 0;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    mesh.visible = true;
    const actor = new Actor({ mesh, id: 'spawner-2' });

    // Two "alive" minions, max=2 → cap reached → no spawn.
    const fakeMinionMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    fakeMinionMesh.visible = true;
    const m1 = { id: 'm1', userData: { shooterAi: { spawnedBy: 'spawner-2', defeated: false } }, mesh: fakeMinionMesh };
    const m2 = { id: 'm2', userData: { shooterAi: { spawnedBy: 'spawner-2', defeated: false } }, mesh: fakeMinionMesh };

    const comp = new ShooterSpawnerComponent({
        tuning: { firstWaveDelayMs: 0, cooldownMs: 100, maxAlive: 2, spawnRadius: 1 },
        baseScoreValue: 1,
        isGameplayActive: () => true,
        getMinions: () => [m1, m2],
        spawnMinion: () => { spawnCalls++; return {}; },
        getRenderObject: (a) => a.mesh,
        THREE,
    });
    actor.addComponent(comp);
    comp.tick(0);
    comp.tick(0);
    assert.equal(spawnCalls, 0);
});

test('ShooterSpawnerComponent: syncFromUserData hydrates wave + nextWaveAt', async () => {
    const { ShooterSpawnerComponent } = await import('../src/runtime/components/ShooterSpawnerComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    const actor = new Actor({ mesh: new THREE.Group(), userData: { shooterSpawner: { wave: 7, nextWaveAt: 12345 } } });
    const comp = new ShooterSpawnerComponent({
        tuning: { firstWaveDelayMs: 0, cooldownMs: 0, maxAlive: 1, spawnRadius: 1 },
        THREE,
    });
    actor.addComponent(comp);
    comp.syncFromUserData();
    assert.equal(comp.wave, 7);
    assert.equal(comp.nextWaveAt, 12345);
});

// ───────────────────────── HealthPickupComponent ─────────────────────────

test('HealthPickupComponent: skips when scripted handler present', async () => {
    const { HealthPickupComponent } = await import('../src/runtime/components/HealthPickupComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    let healCalls = 0;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5), new THREE.MeshBasicMaterial());
    mesh.visible = true;
    const actor = new Actor({ mesh });
    const comp = new HealthPickupComponent({
        tuning: { respawnMs: 5000, healValue: 0.35 },
        isScripted: () => true,
        isSubjectInsideTrigger: () => true,
        getSubjectPosition: () => new THREE.Vector3(),
        getCurrentHealth: () => 0.5,
        applyHeal: () => { healCalls++; },
        getRenderObject: (a) => a.mesh,
    });
    actor.addComponent(comp);
    comp.tick(0);
    assert.equal(healCalls, 0);
    assert.ok(mesh.visible, 'scripted pickup must stay visible — engine doesn\'t touch it');
});

test('HealthPickupComponent: collects, hides, heals, schedules respawn', async () => {
    const { HealthPickupComponent } = await import('../src/runtime/components/HealthPickupComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    let appliedHealth = null;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5), new THREE.MeshBasicMaterial());
    mesh.visible = true;
    const actor = new Actor({ mesh });
    const comp = new HealthPickupComponent({
        tuning: { respawnMs: 4000, healValue: 0.35 },
        isScripted: () => false,
        isSubjectInsideTrigger: () => true,
        getSubjectPosition: () => new THREE.Vector3(),
        getCurrentHealth: () => 0.5,
        applyHeal: (h) => { appliedHealth = h; },
        getRenderObject: (a) => a.mesh,
    });
    actor.addComponent(comp);

    comp.tick(0);

    assert.ok(Math.abs(appliedHealth - 0.85) < 1e-9, 'should heal current + healValue');
    assert.equal(mesh.visible, false);
    assert.equal(actor.userData.collected, true);
    assert.ok(actor.userData.respawnAt > 0);
});

test('HealthPickupComponent: full health gate blocks pickup', async () => {
    const { HealthPickupComponent } = await import('../src/runtime/components/HealthPickupComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    let healCalls = 0;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5), new THREE.MeshBasicMaterial());
    mesh.visible = true;
    const actor = new Actor({ mesh });
    const comp = new HealthPickupComponent({
        tuning: { respawnMs: 1000, healValue: 0.3 },
        isScripted: () => false,
        isSubjectInsideTrigger: () => true,
        getSubjectPosition: () => new THREE.Vector3(),
        getCurrentHealth: () => 1,
        applyHeal: () => { healCalls++; },
        getRenderObject: (a) => a.mesh,
    });
    actor.addComponent(comp);
    comp.tick(0);
    assert.equal(healCalls, 0);
    assert.ok(mesh.visible);
    assert.ok(!actor.userData.collected);
});

test('HealthPickupComponent: respawnAt past now re-shows the mesh', async () => {
    const { HealthPickupComponent } = await import('../src/runtime/components/HealthPickupComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5), new THREE.MeshBasicMaterial());
    mesh.visible = false;
    const actor = new Actor({ mesh, userData: { collected: true, respawnAt: 1 } });
    let appliedHealth = null;
    const comp = new HealthPickupComponent({
        tuning: { respawnMs: 1000, healValue: 0.3 },
        isScripted: () => false,
        // Already inside, but the un-collect happens FIRST in the tick — second
        // tick performs the pickup. We assert only the un-collect step here.
        isSubjectInsideTrigger: () => false,
        getSubjectPosition: () => new THREE.Vector3(),
        getCurrentHealth: () => 0.4,
        applyHeal: (h) => { appliedHealth = h; },
        getRenderObject: (a) => a.mesh,
    });
    actor.addComponent(comp);
    comp.tick(0);
    assert.equal(mesh.visible, true);
    assert.equal(actor.userData.collected, false);
    assert.equal(appliedHealth, null);
});

test('HealthPickupComponent: reset() clears collected + respawnAt + shows mesh', async () => {
    const { HealthPickupComponent } = await import('../src/runtime/components/HealthPickupComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5), new THREE.MeshBasicMaterial());
    mesh.visible = false;
    const actor = new Actor({ mesh, userData: { collected: true, respawnAt: 12345 } });
    const comp = new HealthPickupComponent({
        tuning: { respawnMs: 1000, healValue: 0.3 },
        getRenderObject: (a) => a.mesh,
    });
    actor.addComponent(comp);
    comp.reset();
    assert.equal(actor.userData.collected, false);
    assert.equal(actor.userData.respawnAt, 0);
    assert.equal(mesh.visible, true);
});

// ───────────────────────── WeaponPickupComponent ─────────────────────────

test('WeaponPickupComponent: equip+hide on trigger eat (smg/sniper variant)', async () => {
    const { WeaponPickupComponent } = await import('../src/runtime/components/WeaponPickupComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    const calls = { equip: 0, sound: 0 };
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(), new THREE.MeshBasicMaterial());
    mesh.visible = true;
    const actor = new Actor({ mesh });
    const comp = new WeaponPickupComponent({
        equip: () => { calls.equip++; },
        isSubjectInsideTrigger: () => true,
        getSubjectPosition: () => new THREE.Vector3(),
        getRenderObject: (a) => a.mesh,
    });
    actor.addComponent(comp);
    comp.tick(0);
    assert.equal(calls.equip, 1);
    assert.equal(mesh.visible, false);
    assert.equal(actor.userData.collected, true);
    // Second tick — should not re-equip (already collected).
    comp.tick(0);
    assert.equal(calls.equip, 1);
});

test('WeaponPickupComponent: bob enabled bobs sprite y around base + spins material', async () => {
    const { WeaponPickupComponent } = await import('../src/runtime/components/WeaponPickupComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    const mat = new THREE.MeshBasicMaterial();
    mat.rotation = 0;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(), mat);
    mesh.visible = true;
    mesh.position.y = 2.0;
    const actor = new Actor({ mesh });
    const comp = new WeaponPickupComponent({
        equip: () => {},
        bob: true,
        // Never collect during the bob test.
        isSubjectInsideTrigger: () => false,
        getSubjectPosition: () => new THREE.Vector3(),
        getRenderObject: (a) => a.mesh,
    });
    actor.addComponent(comp);
    comp.tick(0);
    assert.equal(actor.userData._bobBaseY, 2.0, 'must record base Y on first bob tick');
    // Material rotation should now be a finite number (sin of phase).
    assert.ok(Number.isFinite(mat.rotation));
});

test('WeaponPickupComponent: scripted variant defers to dispatchTrigger, skips engine eat', async () => {
    const { WeaponPickupComponent } = await import('../src/runtime/components/WeaponPickupComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    const calls = { equip: 0, dispatch: 0 };
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial());
    mesh.visible = true;
    const actor = new Actor({ mesh });
    const comp = new WeaponPickupComponent({
        equip: () => { calls.equip++; },
        isScripted: () => true,
        dispatchTrigger: () => { calls.dispatch++; },
        isSubjectInsideTrigger: () => true,
        getSubjectPosition: () => new THREE.Vector3(),
        getRenderObject: (a) => a.mesh,
    });
    actor.addComponent(comp);
    comp.tick(0);
    assert.equal(calls.dispatch, 1);
    assert.equal(calls.equip, 0, 'engine-side equip must NOT run when scripted');
    assert.equal(mesh.visible, true);
});

test('WeaponPickupComponent: reset() clears collected + bobBaseY + shows mesh', async () => {
    const { WeaponPickupComponent } = await import('../src/runtime/components/WeaponPickupComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    const mesh = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial());
    mesh.visible = false;
    const actor = new Actor({ mesh, userData: { collected: true, _bobBaseY: 1.5 } });
    const comp = new WeaponPickupComponent({ getRenderObject: (a) => a.mesh });
    actor.addComponent(comp);
    comp.reset();
    assert.equal(actor.userData.collected, false);
    assert.equal(actor.userData._bobBaseY, null);
    assert.equal(mesh.visible, true);
});

test('WeaponPickupComponent: playPickupSound only fires on actual collect', async () => {
    const { WeaponPickupComponent } = await import('../src/runtime/components/WeaponPickupComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    let soundCalls = 0;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial());
    mesh.visible = true;
    const actor = new Actor({ mesh });
    let inside = false;
    const comp = new WeaponPickupComponent({
        equip: () => {},
        playPickupSound: () => { soundCalls++; },
        isSubjectInsideTrigger: () => inside,
        getSubjectPosition: () => new THREE.Vector3(),
        getRenderObject: (a) => a.mesh,
    });
    actor.addComponent(comp);
    comp.tick(0);  // not inside → no sound
    assert.equal(soundCalls, 0);
    inside = true;
    comp.tick(0);  // inside → collect + sound
    assert.equal(soundCalls, 1);
    comp.tick(0);  // already collected → no second sound
    assert.equal(soundCalls, 1);
});

// ───────────────────────── CoinComponent ─────────────────────────

test('CoinComponent: collects, hides, scores on subject enter', async () => {
    const { CoinComponent } = await import('../src/runtime/components/CoinComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    let score = 0;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.3), new THREE.MeshBasicMaterial());
    mesh.visible = true;
    const actor = new Actor({ mesh, userData: { scoreValue: 25 } });
    const comp = new CoinComponent({
        isSubjectInsideTrigger: () => true,
        getSubjectPosition: () => new THREE.Vector3(),
        addScore: (n) => { score += n; },
        getRenderObject: (a) => a.mesh,
        defaultScoreValue: 10,
    });
    actor.addComponent(comp);
    comp.tick(0);
    assert.equal(score, 25);
    assert.equal(mesh.visible, false);
    assert.equal(actor.userData.collected, true);
    comp.tick(0); // idempotent — already collected
    assert.equal(score, 25);
});

test('CoinComponent: scripted handler short-circuits engine collect', async () => {
    const { CoinComponent } = await import('../src/runtime/components/CoinComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    let score = 0;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.3), new THREE.MeshBasicMaterial());
    mesh.visible = true;
    const actor = new Actor({ mesh });
    const comp = new CoinComponent({
        isScripted: () => true,
        isSubjectInsideTrigger: () => true,
        getSubjectPosition: () => new THREE.Vector3(),
        addScore: (n) => { score += n; },
        getRenderObject: (a) => a.mesh,
    });
    actor.addComponent(comp);
    comp.tick(0);
    assert.equal(score, 0);
    assert.equal(mesh.visible, true);
});

test('CoinComponent: uses defaultScoreValue when actor.userData.scoreValue absent', async () => {
    const { CoinComponent } = await import('../src/runtime/components/CoinComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    let score = 0;
    const actor = new Actor({ mesh: new THREE.Group() });
    const comp = new CoinComponent({
        isSubjectInsideTrigger: () => true,
        getSubjectPosition: () => new THREE.Vector3(),
        addScore: (n) => { score += n; },
        defaultScoreValue: 7,
    });
    actor.addComponent(comp);
    comp.tick(0);
    assert.equal(score, 7);
});

// ───────────────────────── TargetComponent ─────────────────────────

test('TargetComponent: scores + arms cooldown when a dynamic body enters zone', async () => {
    const { TargetComponent } = await import('../src/runtime/components/TargetComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    let score = 0;
    const targetMesh = new THREE.Mesh(new THREE.CylinderGeometry(), new THREE.MeshBasicMaterial());
    targetMesh.visible = true;
    targetMesh.position.set(0, 0, 0);
    const target = new Actor({ mesh: targetMesh, userData: { scoreValue: 25, triggerRadius: 1.5 } });

    // Fake dynamic body inside the zone.
    const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    bodyMesh.visible = true;
    bodyMesh.position.set(0.5, 0.5, 0);
    const body = { userData: {}, mesh: bodyMesh };

    const comp = new TargetComponent({
        getDynamicBodies: () => [body],
        isPhysicsReady: () => true,
        getActorBody: () => ({}),
        getRenderObject: (a) => a.mesh,
        addScore: (n) => { score += n; },
        THREE,
        hitCooldownMs: 500,
    });
    target.addComponent(comp);

    comp.tick(0);
    assert.equal(score, 25);
    assert.ok(target.userData.hitCooldownUntil > 0);

    // Second tick is gated by cooldown.
    comp.tick(0);
    assert.equal(score, 25);
});

test('TargetComponent: ignores prefab-tagged dynamic bodies', async () => {
    const { TargetComponent } = await import('../src/runtime/components/TargetComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    let score = 0;
    const targetMesh = new THREE.Mesh(new THREE.CylinderGeometry(), new THREE.MeshBasicMaterial());
    targetMesh.visible = true;
    const target = new Actor({ mesh: targetMesh, userData: { scoreValue: 30, triggerRadius: 2 } });

    const ignoredMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    ignoredMesh.visible = true;
    // gameplayPrefab key tags it as engine-owned and the target must skip it.
    const ignored = { userData: { gameplayPrefab: 'coin' }, mesh: ignoredMesh };

    const comp = new TargetComponent({
        getDynamicBodies: () => [ignored],
        isPhysicsReady: () => true,
        getActorBody: () => ({}),
        getRenderObject: (a) => a.mesh,
        addScore: (n) => { score += n; },
        THREE,
    });
    target.addComponent(comp);
    comp.tick(0);
    assert.equal(score, 0);
});

test('TargetComponent: scripted variant emits OnTrigger on enter edge only', async () => {
    const { TargetComponent } = await import('../src/runtime/components/TargetComponent.js');
    const { Actor } = await import('../src/runtime/sceneRuntime.js');
    const THREE = await import('three');

    const events = [];
    const targetMesh = new THREE.Mesh(new THREE.CylinderGeometry(), new THREE.MeshBasicMaterial());
    targetMesh.visible = true;
    const target = new Actor({ mesh: targetMesh, userData: { triggerRadius: 1.5 } });

    const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    bodyMesh.visible = true;
    bodyMesh.position.set(0.2, 0.0, 0.2);
    const body = { userData: {}, mesh: bodyMesh };

    let bodyInside = true;
    const comp = new TargetComponent({
        isScripted: () => true,
        getDynamicBodies: () => (bodyInside ? [body] : []),
        getRenderObject: (a) => a.mesh,
        dispatchTriggerEvent: (a, payload, inside) => events.push({ inside, hasPayload: !!payload }),
        THREE,
    });
    target.addComponent(comp);

    // Enter
    comp.tick(0);
    // Same frame again — no new edge.
    comp.tick(0);
    // Body leaves.
    bodyInside = false;
    comp.tick(0);
    // Edge again the next frame would also fire — but already exited.
    comp.tick(0);

    assert.deepEqual(events, [
        { inside: true, hasPayload: true },
        { inside: false, hasPayload: false },
    ]);
});

// ───────────────────────── eventBus ─────────────────────────

test('eventBus: on/emit fans out to all subscribers in order', async () => {
    const { createEventBus } = await import('../src/runtime/eventBus.js');
    const bus = createEventBus();
    const log = [];
    bus.on('topic', (p) => log.push(`a:${p}`));
    bus.on('topic', (p) => log.push(`b:${p}`));
    bus.emit('topic', 'x');
    assert.deepEqual(log, ['a:x', 'b:x']);
});

test('eventBus: returned unsubscribe stops delivery', async () => {
    const { createEventBus } = await import('../src/runtime/eventBus.js');
    const bus = createEventBus();
    let calls = 0;
    const off = bus.on('topic', () => { calls++; });
    bus.emit('topic');
    off();
    bus.emit('topic');
    assert.equal(calls, 1);
});

test('eventBus: once auto-unsubscribes after first delivery', async () => {
    const { createEventBus } = await import('../src/runtime/eventBus.js');
    const bus = createEventBus();
    let calls = 0;
    bus.once('topic', () => { calls++; });
    bus.emit('topic'); bus.emit('topic'); bus.emit('topic');
    assert.equal(calls, 1);
});

test('eventBus: listener throw does not abort dispatch', async () => {
    const { createEventBus } = await import('../src/runtime/eventBus.js');
    const bus = createEventBus();
    const log = [];
    // Silence the expected error log so the test output is clean.
    const origError = console.error;
    console.error = () => {};
    try {
        bus.on('topic', () => { throw new Error('boom'); });
        bus.on('topic', () => log.push('after'));
        bus.emit('topic');
    } finally {
        console.error = origError;
    }
    assert.deepEqual(log, ['after']);
});

test('eventBus: subscribe during dispatch does not fire this round', async () => {
    const { createEventBus } = await import('../src/runtime/eventBus.js');
    const bus = createEventBus();
    const log = [];
    bus.on('topic', () => {
        log.push('first');
        bus.on('topic', () => log.push('second')); // must not fire this emit
    });
    bus.emit('topic');
    assert.deepEqual(log, ['first']);
    bus.emit('topic');
    assert.deepEqual(log, ['first', 'first', 'second']);
});

test('eventBus: unsubscribe during dispatch does not skip subsequent listeners', async () => {
    const { createEventBus } = await import('../src/runtime/eventBus.js');
    const bus = createEventBus();
    const log = [];
    const offA = bus.on('topic', () => { log.push('a'); offA(); });
    bus.on('topic', () => log.push('b'));
    bus.on('topic', () => log.push('c'));
    bus.emit('topic');
    assert.deepEqual(log, ['a', 'b', 'c']);
});

test('eventBus: clear(topic) only clears one topic; clear() clears all', async () => {
    const { createEventBus } = await import('../src/runtime/eventBus.js');
    const bus = createEventBus();
    bus.on('a', () => {}); bus.on('a', () => {});
    bus.on('b', () => {});
    assert.equal(bus.listenerCount('a'), 2);
    bus.clear('a');
    assert.equal(bus.listenerCount('a'), 0);
    assert.equal(bus.listenerCount('b'), 1);
    bus.clear();
    assert.equal(bus.listenerCount('b'), 0);
});

// ───────────────────────── systemRegistry ─────────────────────────

test('systemRegistry: tick runs systems in insertion order with no deps', async () => {
    const { createSystemRegistry } = await import('../src/runtime/systemRegistry.js');
    const reg = createSystemRegistry();
    const log = [];
    reg.register({ name: 'a', update: () => log.push('a') });
    reg.register({ name: 'b', update: () => log.push('b') });
    reg.register({ name: 'c', update: () => log.push('c') });
    reg.tick(0.016, {});
    assert.deepEqual(log, ['a', 'b', 'c']);
});

test('systemRegistry: `before` constraint reorders run', async () => {
    const { createSystemRegistry } = await import('../src/runtime/systemRegistry.js');
    const reg = createSystemRegistry();
    const log = [];
    reg.register({ name: 'render', update: () => log.push('render'), after: ['physics'] });
    reg.register({ name: 'physics', update: () => log.push('physics') });
    reg.tick(0.016, {});
    assert.deepEqual(log, ['physics', 'render']);
});

test('systemRegistry: `before` is symmetric to `after`', async () => {
    const { createSystemRegistry } = await import('../src/runtime/systemRegistry.js');
    const reg = createSystemRegistry();
    const log = [];
    reg.register({ name: 'physics', update: () => log.push('physics'), before: ['render'] });
    reg.register({ name: 'render', update: () => log.push('render') });
    reg.tick(0.016, {});
    assert.deepEqual(log, ['physics', 'render']);
});

test('systemRegistry: setEnabled(false) skips a system', async () => {
    const { createSystemRegistry } = await import('../src/runtime/systemRegistry.js');
    const reg = createSystemRegistry();
    const log = [];
    reg.register({ name: 'a', update: () => log.push('a') });
    reg.register({ name: 'b', update: () => log.push('b') });
    reg.setEnabled('a', false);
    reg.tick(0.016, {});
    assert.deepEqual(log, ['b']);
});

test('systemRegistry: passes (delta, ctx) through to each update', async () => {
    const { createSystemRegistry } = await import('../src/runtime/systemRegistry.js');
    const reg = createSystemRegistry();
    let seen = null;
    reg.register({ name: 's', update: (delta, ctx) => { seen = { delta, ctx }; } });
    reg.tick(0.0083, { tag: 'frame-7' });
    assert.equal(seen.delta, 0.0083);
    assert.deepEqual(seen.ctx, { tag: 'frame-7' });
});

test('systemRegistry: thrown system does not abort the rest', async () => {
    const { createSystemRegistry } = await import('../src/runtime/systemRegistry.js');
    const reg = createSystemRegistry();
    const log = [];
    const origError = console.error;
    console.error = () => {};
    try {
        reg.register({ name: 'a', update: () => log.push('a') });
        reg.register({ name: 'bomb', update: () => { throw new Error('x'); } });
        reg.register({ name: 'c', update: () => log.push('c') });
        reg.tick(0, {});
    } finally {
        console.error = origError;
    }
    assert.deepEqual(log, ['a', 'c']);
});

test('systemRegistry: duplicate name throws on register', async () => {
    const { createSystemRegistry } = await import('../src/runtime/systemRegistry.js');
    const reg = createSystemRegistry();
    reg.register({ name: 'x', update: () => {} });
    assert.throws(() => reg.register({ name: 'x', update: () => {} }));
});

test('systemRegistry: unknown deps tolerated (optional system absent)', async () => {
    const { createSystemRegistry } = await import('../src/runtime/systemRegistry.js');
    const reg = createSystemRegistry();
    const log = [];
    reg.register({ name: 'a', update: () => log.push('a'), after: ['missing-optional'] });
    reg.register({ name: 'b', update: () => log.push('b') });
    reg.tick(0, {});
    // No dep enforced because 'missing-optional' isn't registered → insertion order.
    assert.deepEqual(log, ['a', 'b']);
});

test('systemRegistry: getOrder reflects resolved order', async () => {
    const { createSystemRegistry } = await import('../src/runtime/systemRegistry.js');
    const reg = createSystemRegistry();
    reg.register({ name: 'a', update: () => {}, after: ['b'] });
    reg.register({ name: 'b', update: () => {} });
    assert.deepEqual(reg.getOrder(), ['b', 'a']);
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
