import * as THREE from 'three';
import { Actor } from '../runtime/sceneRuntime.js';
import { PhysicsComponent } from '../runtime/components/PhysicsComponent.js';
import { TransformComponent } from '../runtime/components/TransformComponent.js';

/**
 * UE-style scripting facade for in-engine user code.
 *
 * Provides PascalCase types and globals that mirror Unreal Engine C++ surface
 * area, while delegating to the existing camelCase Actor/Component API. Old
 * scripts using the flat `api` bag continue to work; new scripts can use:
 *
 *   function BeginPlay() { ... }
 *   function Tick(DeltaTime) {
 *     const phys = Self.GetComponentByClass(UPrimitiveComponent);
 *     phys.AddImpulse(new FVector(0, 50, 0));
 *   }
 *   function OnHit(Hit) { ... }
 */

// ───────── Types ─────────

export class FVector extends THREE.Vector3 {
    constructor(x = 0, y = 0, z = 0) {
        super(x, y, z);
    }

    Add(v) { return new FVector(this.x + v.x, this.y + v.y, this.z + v.z); }
    Sub(v) { return new FVector(this.x - v.x, this.y - v.y, this.z - v.z); }
    Scale(s) { return new FVector(this.x * s, this.y * s, this.z * s); }
    Dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
    Cross(v) {
        return new FVector(
            this.y * v.z - this.z * v.y,
            this.z * v.x - this.x * v.z,
            this.x * v.y - this.y * v.x,
        );
    }
    Length() { return this.length(); }
    Size() { return this.length(); }
    Normal() { return new FVector(this.x, this.y, this.z).normalize(); }
    GetSafeNormal() {
        const len = this.length();
        return len > 1e-8 ? new FVector(this.x / len, this.y / len, this.z / len) : new FVector();
    }

    static Zero() { return new FVector(0, 0, 0); }
    static One() { return new FVector(1, 1, 1); }
    static Up() { return new FVector(0, 1, 0); }
    static Forward() { return new FVector(0, 0, -1); }
    static Right() { return new FVector(1, 0, 0); }
}

export class FRotator {
    constructor(Pitch = 0, Yaw = 0, Roll = 0) {
        this.Pitch = Pitch;
        this.Yaw = Yaw;
        this.Roll = Roll;
    }

    toQuaternion() {
        const e = new THREE.Euler(
            THREE.MathUtils.degToRad(this.Pitch),
            THREE.MathUtils.degToRad(this.Yaw),
            THREE.MathUtils.degToRad(this.Roll),
            'YXZ',
        );
        return new THREE.Quaternion().setFromEuler(e);
    }

    static FromQuaternion(q) {
        const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
        return new FRotator(
            THREE.MathUtils.radToDeg(e.x),
            THREE.MathUtils.radToDeg(e.y),
            THREE.MathUtils.radToDeg(e.z),
        );
    }
}

export class FTransform {
    constructor(Location = new FVector(), Rotation = new FRotator(), Scale = new FVector(1, 1, 1)) {
        this.Location = Location;
        this.Rotation = Rotation;
        this.Scale = Scale;
    }
}

export class FHitResult {
    constructor() {
        this.bBlockingHit = false;
        this.Location = new FVector();
        this.ImpactPoint = new FVector();
        this.Normal = new FVector(0, 1, 0);
        this.ImpactNormal = new FVector(0, 1, 0);
        this.Distance = 0;
        this.Time = 0;
        this.HitActor = null;
        this.HitComponent = null;
        this.bStartPenetrating = false;
    }

    GetActor() { return this.HitActor; }
    GetComponent() { return this.HitComponent; }
}

export const ECollisionChannel = Object.freeze({
    Visibility: 1,
    Camera: 2,
    Pawn: 3,
    PhysicsBody: 4,
    Vehicle: 5,
    Destructible: 6,
    WorldStatic: 7,
    WorldDynamic: 8,
});

// ───────── Prototype augmentation ─────────
// One-time install of PascalCase aliases on existing Actor and PhysicsComponent
// prototypes. Camel-case API stays untouched.

let installed = false;

export function installUePrototypeMethods() {
    if (installed) return;
    installed = true;

    // ────── AActor methods on Actor.prototype ──────

    Actor.prototype.GetActorLocation = function () {
        const mesh = this.mesh;
        if (!mesh) return new FVector();
        const v = mesh.getWorldPosition(new THREE.Vector3());
        return new FVector(v.x, v.y, v.z);
    };

    Actor.prototype.SetActorLocation = function (loc) {
        const phys = this.getComponentByClass(PhysicsComponent);
        if (phys?.body) {
            phys.setWorldPosition(loc);
        } else if (this.mesh) {
            this.mesh.position.set(loc.x, loc.y, loc.z);
        }
        return this;
    };

    Actor.prototype.GetActorRotation = function () {
        const mesh = this.mesh;
        if (!mesh) return new FRotator();
        const q = mesh.getWorldQuaternion(new THREE.Quaternion());
        return FRotator.FromQuaternion(q);
    };

    Actor.prototype.SetActorRotation = function (rot) {
        const q = rot instanceof FRotator
            ? rot.toQuaternion()
            : (rot.isQuaternion ? rot : new THREE.Quaternion().fromArray([rot.x, rot.y, rot.z, rot.w ?? 1]));
        const phys = this.getComponentByClass(PhysicsComponent);
        if (phys?.body) {
            phys.setWorldRotation(q);
        } else if (this.mesh) {
            this.mesh.quaternion.copy(q);
        }
        return this;
    };

    Actor.prototype.GetActorForwardVector = function () {
        const mesh = this.mesh;
        if (!mesh) return FVector.Forward();
        const v = new THREE.Vector3(0, 0, -1).applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()));
        return new FVector(v.x, v.y, v.z);
    };

    Actor.prototype.GetActorRightVector = function () {
        const mesh = this.mesh;
        if (!mesh) return FVector.Right();
        const v = new THREE.Vector3(1, 0, 0).applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()));
        return new FVector(v.x, v.y, v.z);
    };

    Actor.prototype.GetActorUpVector = function () {
        const mesh = this.mesh;
        if (!mesh) return FVector.Up();
        const v = new THREE.Vector3(0, 1, 0).applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()));
        return new FVector(v.x, v.y, v.z);
    };

    // GetComponentByClass / HasComponent are PascalCase aliases of existing methods.
    Actor.prototype.GetComponentByClass = Actor.prototype.getComponentByClass;
    Actor.prototype.HasComponent = Actor.prototype.hasComponent;
    Actor.prototype.AddComponent = Actor.prototype.addComponent;
    Actor.prototype.RemoveComponentByClass = Actor.prototype.removeComponentByClass;

    Actor.prototype.GetName = function () { return this.rootNode?.name ?? this.id ?? ''; };
    Actor.prototype.GetActorLabel = function () { return this.userData?.label ?? this.GetName(); };

    // Destroy is wired by the host on the per-script context (it needs scene/sceneSystem refs).

    // ────── UPrimitiveComponent methods on PhysicsComponent.prototype ──────
    // PhysicsComponent already serves the role of UE's UPrimitiveComponent for
    // physics queries. Add PascalCase aliases that delegate to camelCase.

    const P = PhysicsComponent.prototype;
    P.AddForce = function (v) { return this.addForce(v); };
    P.AddForceAtPosition = function (v, pos) { return this.addForceAtPosition(v, pos); };
    P.AddImpulse = function (v, _bVelChange = false) { return this.addImpulse(v); };
    P.AddImpulseAtPosition = function (v, pos) { return this.addImpulseAtPosition(v, pos); };
    P.AddTorque = function (v) { return this.addTorque(v); };
    P.AddAngularImpulse = function (v) { return this.addAngularImpulse(v); };
    P.SetLinearVelocity = function (v) { return this.setLinearVelocity(v); };
    P.GetLinearVelocity = function () {
        const v = this.getLinearVelocity();
        return new FVector(v.x, v.y, v.z);
    };
    P.SetAngularVelocity = function (v) { return this.setAngularVelocity(v); };
    P.GetAngularVelocity = function () {
        const v = this.getAngularVelocity();
        return new FVector(v.x, v.y, v.z);
    };
    P.SetWorldLocation = function (v) { return this.setWorldPosition(v); };
    P.SetWorldRotation = function (q) { return this.setWorldRotation(q); };
    P.SetSimulatePhysics = function (b) { this.simulatePhysics = !!b; if (b) this.activate(); else this.deactivate(); };
    P.IsSimulatingPhysics = function () { return this.isSimulatingPhysics(); };
    P.WakeAllRigidBodies = function () { this.activate(); };
    P.PutAllRigidBodiesToSleep = function () { this.deactivate(); };

    // ────── UTransformComponent aliases on TransformComponent ──────
    // TransformComponent already exposes get/set world location/rotation in
    // camelCase; add a few PascalCase aliases for completeness.
    const T = TransformComponent.prototype;
    if (T) {
        if (typeof T.getWorldLocation === 'function') {
            T.GetWorldLocation = function () { return T.getWorldLocation.call(this); };
        }
        if (typeof T.getWorldRotation === 'function') {
            T.GetWorldRotation = function () { return T.getWorldRotation.call(this); };
        }
    }
}

// ───────── UWorld ─────────
// One UWorld instance per active world. `_ctx` is a reference back to the
// engine globals (scene, camera, sceneSystem, physics, raycast helper, etc.)
// supplied by the host.

export class UWorld {
    constructor(ctx) {
        this._ctx = ctx;
        this._t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    }

    GetTimeSeconds() {
        const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        return (now - this._t0) / 1000;
    }

    GetDeltaSeconds() { return this._ctx?.deltaTime ?? 0; }

    GetAllActors() { return Array.from(this._ctx?.sceneSystem?.actors ?? []); }

    /**
     * Spawn an actor by class name (mirrors AGameModeBase::SpawnActor).
     * Class names accepted (case-insensitive):
     *   "Cube" | "Sphere" | "Cylinder" | "Vehicle" | "<importedTemplateId>"
     */
    SpawnActor(ClassName, Location = new FVector(), Rotation = new FRotator()) {
        const ctx = this._ctx;
        if (!ctx) return null;
        const key = String(ClassName || '').toLowerCase();
        let actor = null;
        if (key === 'cube' || key === 'sphere' || key === 'cylinder' || key === 'capsule') {
            actor = ctx.spawnDynamicPrimitive?.(key, undefined, 0.5, { returnActor: true }) ?? null;
        } else if (key === 'vehicle' || key === 'car') {
            actor = ctx.spawnDrivableCar?.() ?? null;
        } else if (ctx.spawnImportedProp) {
            actor = ctx.spawnImportedProp(ClassName, { includeCollisionBody: true }) ?? null;
        }
        if (actor) {
            try { actor.SetActorLocation(Location); } catch (_) {}
            try { actor.SetActorRotation(Rotation); } catch (_) {}
        }
        return actor;
    }

    /**
     * Single-line raycast against the physics world.
     * Returns true if blocking hit; populates OutHit either way.
     */
    LineTraceSingleByChannel(OutHit, Start, End, _Channel = ECollisionChannel.Visibility) {
        if (!OutHit) OutHit = new FHitResult();
        const ctx = this._ctx;
        const raycastWorld = ctx?.raycastWorld;
        if (!raycastWorld) {
            OutHit.bBlockingHit = false;
            return false;
        }
        const sx = Start?.x ?? 0, sy = Start?.y ?? 0, sz = Start?.z ?? 0;
        const ex = End?.x ?? 0,   ey = End?.y ?? 0,   ez = End?.z ?? 0;
        const dx = ex - sx, dy = ey - sy, dz = ez - sz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const inv = dist > 1e-8 ? 1 / dist : 0;
        const r = raycastWorld(
            { x: sx, y: sy, z: sz },
            { x: dx * inv, y: dy * inv, z: dz * inv },
            dist || 1000,
        );
        OutHit.bBlockingHit = !!r?.hit;
        OutHit.Distance = r?.distance ?? 0;
        OutHit.Time = dist > 0 ? (r?.distance ?? 0) / dist : 0;
        if (r?.point) {
            OutHit.Location.set(r.point.x, r.point.y, r.point.z);
            OutHit.ImpactPoint.set(r.point.x, r.point.y, r.point.z);
        }
        if (r?.normal) {
            OutHit.Normal.set(r.normal.x, r.normal.y, r.normal.z);
            OutHit.ImpactNormal.set(r.normal.x, r.normal.y, r.normal.z);
        }
        OutHit.HitActor = r?.actor ?? null;
        OutHit.HitComponent = OutHit.HitActor?.getComponentByClass?.(PhysicsComponent) ?? null;
        return OutHit.bBlockingHit;
    }
}

// ───────── Lifecycle detection ─────────

const LIFECYCLE_PROBE = /\bfunction\s+(BeginPlay|Tick|OnHit|EndPlay)\s*\(/;

/**
 * @param {string} source  Raw user script source.
 * @returns {boolean}  True if the source defines any of BeginPlay/Tick/OnHit/EndPlay.
 */
export function detectsUeLifecycle(source) {
    return typeof source === 'string' && LIFECYCLE_PROBE.test(source);
}

// ───────── Context builder ─────────

/**
 * Build the per-script context bag injected as `api`.
 *
 * @param {object} legacyApi   The existing flat camelCase api built by
 *                              buildObjectEventApi() — kept verbatim for
 *                              backward compatibility.
 * @param {object} ctx         Engine context: { scene, camera, sceneSystem,
 *                              physics, raycastWorld, spawnDynamicPrimitive,
 *                              spawnImportedProp, spawnDrivableCar, deltaTime,
 *                              destroyActor }
 * @param {object} actor        The actor running the script.
 * @param {object|null} collision  Optional collision payload for OnHit.
 * @returns {object}            Combined api bag.
 */
export function buildUeContext(legacyApi, ctx, actor, collision = null) {
    const world = new UWorld({ ...ctx, deltaTime: legacyApi?.deltaTime ?? 0 });

    // Pre-build a Hit from the engine's collision payload so OnHit gets it.
    let hit = null;
    if (collision) {
        hit = new FHitResult();
        hit.bBlockingHit = true;
        hit.HitActor = collision.otherProp ?? null;
        hit.HitComponent = hit.HitActor?.getComponentByClass?.(PhysicsComponent) ?? null;
        if (collision.point) hit.ImpactPoint.set(collision.point.x, collision.point.y, collision.point.z);
        if (collision.normal) hit.ImpactNormal.set(collision.normal.x, collision.normal.y, collision.normal.z);
    }

    // Patch a Destroy() on Self that knows about the destroy helper.
    const destroyActor = ctx?.destroyActor;
    if (actor && destroyActor && typeof actor.Destroy !== 'function') {
        actor.Destroy = function () { destroyActor(this); };
    }

    return {
        ...legacyApi,
        // Types
        FVector,
        FRotator,
        FTransform,
        FHitResult,
        ECollisionChannel,
        // Class symbols (for GetComponentByClass et al.)
        AActor: Actor,
        UPrimitiveComponent: PhysicsComponent,
        UTransformComponent: TransformComponent,
        UWorld,
        // Globals
        Self: actor,
        World: world,
        GetWorld: () => world,
        DeltaTime: legacyApi?.deltaTime ?? 0,
        Hit: hit,
    };
}
