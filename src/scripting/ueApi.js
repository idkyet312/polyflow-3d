import * as THREE from 'three';
import { Actor } from '../runtime/sceneRuntime.js';
import { AudioComponent } from '../runtime/components/AudioComponent.js';
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

const DEFAULT_WIDGET_POSITION = Object.freeze({ x: 0.5, y: 0.5 });

function normalizeWidgetType(value) {
    switch (String(value ?? 'text').toLowerCase()) {
        case 'text':
        case 'textblock':
        case 'label':
            return 'text';
        case 'image':
        case 'imagewidget':
            return 'image';
        case 'progress':
        case 'progressbar':
            return 'progress';
        case 'button':
            return 'button';
        default:
            return 'text';
    }
}

function normalizeViewportPoint(value, fallback = DEFAULT_WIDGET_POSITION) {
    return {
        x: Number.isFinite(value?.x) ? value.x : fallback.x,
        y: Number.isFinite(value?.y) ? value.y : fallback.y,
    };
}

function normalizeWidgetScale(value, fallback = 1) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (Number.isFinite(value?.x)) {
        return value.x;
    }
    return fallback;
}

function normalizeWidgetVisibility(value, fallback = true) {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value === 'string') {
        const normalized = value.toLowerCase();
        return normalized !== 'hidden' && normalized !== 'collapsed' && normalized !== 'false';
    }
    return !!value;
}

function normalizeWidgetConfig(config = {}) {
    const normalized = { ...config };

    if (normalized.Text !== undefined && normalized.text === undefined) {
        normalized.text = normalized.Text;
    }
    if (normalized.Percent !== undefined && normalized.progress === undefined) {
        normalized.progress = normalized.Percent;
    }
    if (normalized.Image !== undefined && normalized.imageUrl === undefined) {
        normalized.imageUrl = normalized.Image;
    }
    if (normalized.Brush !== undefined && normalized.imageUrl === undefined) {
        normalized.imageUrl = normalized.Brush;
    }
    if (normalized.Texture !== undefined && normalized.imageUrl === undefined) {
        normalized.imageUrl = normalized.Texture;
    }
    if (normalized.Position !== undefined && normalized.position === undefined) {
        normalized.position = normalized.Position;
    }
    if (normalized.RenderScale !== undefined && normalized.scale === undefined) {
        normalized.scale = normalized.RenderScale;
    }
    if (normalized.Visibility !== undefined && normalized.visible === undefined) {
        normalized.visible = normalizeWidgetVisibility(normalized.Visibility, true);
    }
    if (normalized.ZOrder !== undefined && normalized.zOrder === undefined) {
        normalized.zOrder = normalized.ZOrder;
    }
    if (normalized.OnClicked !== undefined && normalized.onClick === undefined) {
        normalized.onClick = normalized.OnClicked;
    }
    if (normalized.DesiredSize) {
        if (normalized.width === undefined && Number.isFinite(normalized.DesiredSize.x)) {
            normalized.width = normalized.DesiredSize.x;
        }
        if (normalized.height === undefined && Number.isFinite(normalized.DesiredSize.y)) {
            normalized.height = normalized.DesiredSize.y;
        }
    }

    if (normalized.position !== undefined) {
        normalized.position = normalizeViewportPoint(normalized.position, DEFAULT_WIDGET_POSITION);
    }
    if (normalized.scale !== undefined) {
        normalized.scale = normalizeWidgetScale(normalized.scale, 1);
    }
    if (normalized.progress !== undefined) {
        normalized.progress = THREE.MathUtils.clamp(normalized.progress, 0, 1);
    }
    if (normalized.visible !== undefined) {
        normalized.visible = normalizeWidgetVisibility(normalized.visible, true);
    }
    if (normalized.zOrder !== undefined) {
        normalized.zOrder = Number.isFinite(normalized.zOrder) ? normalized.zOrder : 0;
    }

    return normalized;
}

export class UUserWidget {
    constructor(WidgetType = 'text', Config = {}, RuntimeContext = null) {
        this._widgetId = null;
        this._widgetType = normalizeWidgetType(WidgetType);
        this._config = normalizeWidgetConfig(Config);
        this._runtimeContext = null;
        this._widgetApi = null;
        this._attachRuntime(RuntimeContext);
    }

    _attachRuntime(RuntimeContext = null) {
        this._runtimeContext = RuntimeContext;
        this._widgetApi = RuntimeContext?.widgetApi ?? null;
        return this;
    }

    _applyConfig(updates = {}) {
        this._config = normalizeWidgetConfig({ ...this._config, ...updates });
        if (this._widgetId !== null && this._widgetApi) {
            this._widgetApi.updateWidget(this._widgetId, this._config);
        }
        return this;
    }

    AddToViewport(ZOrder = this._config.zOrder ?? 0) {
        this._config = normalizeWidgetConfig({
            ...this._config,
            visible: this._config.visible ?? true,
            zOrder: ZOrder,
        });
        if (!this._widgetApi) {
            return this;
        }
        if (this._widgetId === null) {
            this._widgetId = this._widgetApi.createWidget(this._widgetType, this._config);
        } else {
            this._widgetApi.updateWidget(this._widgetId, this._config);
        }
        return this;
    }

    RemoveFromParent() {
        if (this._widgetId === null || !this._widgetApi) {
            return false;
        }
        const removed = this._widgetApi.removeWidget(this._widgetId);
        if (removed) {
            this._widgetId = null;
        }
        return removed;
    }

    SetVisibility(Visibility) {
        return this._applyConfig({ visible: normalizeWidgetVisibility(Visibility, true) });
    }

    SetPositionInViewport(Position) {
        return this._applyConfig({
            position: normalizeViewportPoint(Position, this._config.position ?? DEFAULT_WIDGET_POSITION),
        });
    }

    SetRenderScale(Scale) {
        return this._applyConfig({ scale: normalizeWidgetScale(Scale, this._config.scale ?? 1) });
    }

    SetDesiredSizeInViewport(Size) {
        return this._applyConfig({
            width: Number.isFinite(Size?.x) ? Size.x : this._config.width,
            height: Number.isFinite(Size?.y) ? Size.y : this._config.height,
        });
    }

    SetText(Text) {
        return this._applyConfig({ text: Text });
    }

    SetPercent(Percent) {
        return this._applyConfig({ progress: THREE.MathUtils.clamp(Percent ?? 0, 0, 1) });
    }

    SetBrushFromTexture(Texture) {
        return this._applyConfig({ imageUrl: Texture });
    }

    SetColorAndOpacity(Color) {
        return this._applyConfig({ color: Color });
    }

    SetOnClicked(Handler) {
        return this._applyConfig({ onClick: Handler });
    }

    GetWidgetId() { return this._widgetId; }
    GetWidgetType() { return this._widgetType; }
    GetIsInViewport() { return this._widgetId !== null; }
    SynchronizeProperties() { return this._applyConfig(); }
}

export class UTextWidget extends UUserWidget {
    constructor(Config = {}, RuntimeContext = null) {
        super('text', Config, RuntimeContext);
    }
}

export class UImageWidget extends UUserWidget {
    constructor(Config = {}, RuntimeContext = null) {
        super('image', Config, RuntimeContext);
    }
}

export class UProgressBarWidget extends UUserWidget {
    constructor(Config = {}, RuntimeContext = null) {
        super('progress', Config, RuntimeContext);
    }
}

export class UButtonWidget extends UUserWidget {
    constructor(Config = {}, RuntimeContext = null) {
        super('button', Config, RuntimeContext);
    }
}

function createHudWidget(RuntimeContext, WidgetClass = 'text', Config = {}) {
    if (WidgetClass instanceof UUserWidget) {
        return WidgetClass._attachRuntime(RuntimeContext);
    }

    if (typeof WidgetClass === 'function' && (WidgetClass === UUserWidget || WidgetClass.prototype instanceof UUserWidget)) {
        const widget = new WidgetClass(Config, RuntimeContext);
        return widget._attachRuntime(RuntimeContext);
    }

    if (WidgetClass && typeof WidgetClass === 'object') {
        const defaults = WidgetClass.defaults ?? WidgetClass.Defaults ?? {};
        const widgetType = WidgetClass.widgetType ?? WidgetClass.WidgetType ?? WidgetClass.type ?? 'text';
        return new UUserWidget(widgetType, { ...defaults, ...Config }, RuntimeContext);
    }

    return new UUserWidget(WidgetClass, Config, RuntimeContext);
}

export class AHUD {
    constructor(RuntimeContext = null) {
        this._runtimeContext = RuntimeContext;
        this._widgets = new Set();
    }

    _attachRuntime(RuntimeContext = null) {
        this._runtimeContext = RuntimeContext;
        return this;
    }

    CreateWidget(WidgetClass = UUserWidget, Config = {}) {
        const widget = createHudWidget(this._runtimeContext, WidgetClass, Config);
        this._widgets.add(widget);
        return widget;
    }

    AddWidget(Widget, ZOrder = 0) {
        const widget = Widget instanceof UUserWidget
            ? Widget._attachRuntime(this._runtimeContext)
            : this.CreateWidget(Widget);
        widget.AddToViewport(ZOrder);
        this._widgets.add(widget);
        return widget;
    }

    RemoveWidget(Widget) {
        if (!(Widget instanceof UUserWidget)) {
            return false;
        }
        const removed = Widget.RemoveFromParent();
        this._widgets.delete(Widget);
        return removed;
    }

    ClearWidgets() {
        for (const widget of Array.from(this._widgets)) {
            widget.RemoveFromParent();
        }
        this._widgets.clear();
    }

    GetWidgets() {
        return Array.from(this._widgets);
    }
}

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

    const A = AudioComponent.prototype;
    A.Play = function (delay = 0) { return this.play(delay); };
    A.Stop = function () { return this.stop(); };
    A.IsPlaying = function () { return this.isPlaying(); };
    A.SetSound = function (sound) { return this.setSound(sound); };
    A.SetLooping = function (loop) { return this.setLoop(loop); };
    A.SetVolumeMultiplier = function (volume) { return this.setVolume(volume); };
    A.SetPitchMultiplier = function (rate) { return this.setPlaybackRate(rate); };
    A.SetUISound = function () { return this.setPositional(false); };
    A.SetWorldSound = function () { return this.setPositional(true); };
    A.PlayTone = function (frequency = 440, duration = 0.2, type = 'sine') {
        return this.playTone(frequency, duration, type);
    };

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

    GetHUD() {
        if (!this._ctx) return null;
        const sharedHud = typeof this._ctx.getHUD === 'function'
            ? this._ctx.getHUD()
            : this._ctx.hud;
        if (sharedHud) {
            if (typeof sharedHud._attachRuntime === 'function') {
                sharedHud._attachRuntime(this._ctx);
            }
            this._ctx._hud = sharedHud;
            return sharedHud;
        }
        if (!this._ctx._hud) {
            this._ctx._hud = new AHUD(this._ctx);
        } else {
            this._ctx._hud._attachRuntime(this._ctx);
        }
        return this._ctx._hud;
    }

    CreateWidget(WidgetClass = UUserWidget, Config = {}) {
        return this.GetHUD()?.CreateWidget(WidgetClass, Config) ?? null;
    }

    GetAllActors() { return Array.from(this._ctx?.sceneSystem?.actors ?? []); }

    GetGameInstance() {
        return getRuntimeGameInstance(this._ctx);
    }

    GetFirstPlayerController() {
        return getRuntimePlayerController(this._ctx);
    }

    GetPlayerController(PlayerIndex = 0) {
        return PlayerIndex === 0 ? getRuntimePlayerController(this._ctx) : null;
    }

    GetPlayerPawn(PlayerIndex = 0) {
        return PlayerIndex === 0 ? getRuntimePlayerPawn(this._ctx) : null;
    }

    GetPlayerCharacter(PlayerIndex = 0) {
        return PlayerIndex === 0 ? getRuntimePlayerCharacter(this._ctx) : null;
    }

    GetAuthGameMode() {
        return getRuntimeGameMode(this._ctx);
    }

    PlaySoundAtLocation(Sound = 'test', Location = new FVector(), Options = {}) {
        return this._ctx?.playSoundAtLocation?.(Sound, Location, Options) ?? false;
    }

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

function getRuntimeWorld(ctx) {
    if (!ctx) return null;
    if (!ctx._world || ctx._world._ctx !== ctx) {
        ctx._world = new UWorld(ctx);
    }
    return ctx._world;
}

function getPlayerRuntimeLocation(ctx) {
    const character = ctx?.physics?.character ?? null;
    if (character?.GetPosition) {
        const position = character.GetPosition();
        return new FVector(position.GetX(), position.GetY(), position.GetZ());
    }

    const camera = ctx?.camera ?? null;
    if (camera?.position) {
        return new FVector(camera.position.x, camera.position.y, camera.position.z);
    }

    return new FVector();
}

function getPlayerRuntimeVelocity(ctx) {
    const character = ctx?.physics?.character ?? null;
    if (character?.GetLinearVelocity) {
        const velocity = character.GetLinearVelocity();
        return new FVector(velocity.GetX(), velocity.GetY(), velocity.GetZ());
    }

    if (ctx?.gameplay?.velocity) {
        return new FVector(ctx.gameplay.velocity.x, ctx.gameplay.velocity.y, ctx.gameplay.velocity.z);
    }

    return new FVector();
}

function setPlayerRuntimeLocation(ctx, location) {
    if (!ctx || !location) return null;

    if (ctx.gameplay?.spawnPoint) {
        ctx.gameplay.spawnPoint.set(location.x, location.y, location.z);
    }

    const physics = ctx.physics ?? null;
    const character = physics?.character ?? null;
    const Jolt = physics?.Jolt ?? null;
    if (character && Jolt) {
        const spawnPosition = new Jolt.RVec3(location.x, location.y, location.z);
        character.SetPosition(spawnPosition);
        Jolt.destroy?.(spawnPosition);
        character.SetLinearVelocity(Jolt.Vec3.prototype.sZero());
    }

    ctx.syncCameraToCharacter?.();
    return location;
}

function getPlayerRuntimeRotation(ctx) {
    if (ctx?.gameplay) {
        return new FRotator(
            THREE.MathUtils.radToDeg(ctx.gameplay.pitch ?? 0),
            THREE.MathUtils.radToDeg(ctx.gameplay.yaw ?? 0),
            0,
        );
    }

    const camera = ctx?.camera ?? null;
    if (camera?.quaternion) {
        return FRotator.FromQuaternion(camera.quaternion);
    }

    return new FRotator();
}

function setPlayerRuntimeRotation(ctx, rotation) {
    if (!ctx || !rotation) return null;

    const nextRotation = rotation instanceof FRotator
        ? rotation
        : new FRotator(rotation.Pitch ?? rotation.pitch ?? 0, rotation.Yaw ?? rotation.yaw ?? 0, rotation.Roll ?? rotation.roll ?? 0);

    if (ctx.gameplay) {
        ctx.gameplay.pitch = THREE.MathUtils.degToRad(nextRotation.Pitch);
        ctx.gameplay.yaw = THREE.MathUtils.degToRad(nextRotation.Yaw);
        ctx.applyGameplayCameraRotation?.();
    } else if (ctx.camera) {
        ctx.camera.quaternion.copy(nextRotation.toQuaternion());
    }

    return nextRotation;
}

function getRuntimeGameInstance(ctx) {
    if (!ctx) return null;
    if (!ctx._gameInstance) {
        ctx._gameInstance = new UGameInstance(ctx);
    }
    return ctx._gameInstance;
}

function getRuntimePlayerController(ctx) {
    if (!ctx) return null;
    if (!ctx._playerController) {
        ctx._playerController = new APlayerController(ctx);
    }
    return ctx._playerController;
}

function getRuntimePlayerCharacter(ctx) {
    if (!ctx) return null;
    if (!ctx._playerCharacter) {
        ctx._playerCharacter = new ACharacter(ctx);
    }
    return ctx._playerCharacter;
}

function getRuntimePlayerPawn(ctx) {
    return getRuntimePlayerCharacter(ctx);
}

function getRuntimeGameMode(ctx) {
    if (!ctx) return null;
    if (!ctx._gameMode) {
        ctx._gameMode = new AGameMode(ctx);
    }
    return ctx._gameMode;
}

export class UGameInstance {
    constructor(ctx) {
        this._ctx = ctx;
    }

    GetWorld() {
        return getRuntimeWorld(this._ctx);
    }

    GetFirstLocalPlayerController() {
        return getRuntimePlayerController(this._ctx);
    }
}

export class APawn {
    constructor(ctx) {
        this._ctx = ctx;
    }

    GetWorld() {
        return getRuntimeWorld(this._ctx);
    }

    GetController() {
        return getRuntimePlayerController(this._ctx);
    }

    GetActorLocation() {
        return getPlayerRuntimeLocation(this._ctx);
    }

    SetActorLocation(location) {
        setPlayerRuntimeLocation(this._ctx, location instanceof FVector ? location : new FVector(location?.x ?? 0, location?.y ?? 0, location?.z ?? 0));
        return this;
    }

    GetActorRotation() {
        return getPlayerRuntimeRotation(this._ctx);
    }

    SetActorRotation(rotation) {
        setPlayerRuntimeRotation(this._ctx, rotation);
        return this;
    }

    GetActorForwardVector() {
        const camera = this._ctx?.camera ?? null;
        if (camera?.getWorldDirection) {
            const direction = new THREE.Vector3();
            camera.getWorldDirection(direction);
            return new FVector(direction.x, direction.y, direction.z);
        }
        return FVector.Forward();
    }

    GetActorRightVector() {
        const forward = this.GetActorForwardVector();
        return forward.Cross(FVector.Up()).GetSafeNormal();
    }

    GetActorUpVector() {
        return FVector.Up();
    }

    GetVelocity() {
        return getPlayerRuntimeVelocity(this._ctx);
    }
}

export class ACharacter extends APawn {
    Jump() {
        if (this._ctx?.physics) {
            this._ctx.physics.jumpQueued = true;
        }
        return this;
    }

    StopJumping() {
        if (this._ctx?.physics) {
            this._ctx.physics.jumpQueued = false;
        }
        return this;
    }

    IsFalling() {
        return this._ctx?.gameplay ? !this._ctx.gameplay.grounded : false;
    }

    LaunchCharacter(LaunchVelocity = new FVector(), _bXYOverride = false, bZOverride = true) {
        const physics = this._ctx?.physics ?? null;
        const character = physics?.character ?? null;
        const Jolt = physics?.Jolt ?? null;
        if (!character || !Jolt) {
            return this;
        }

        const currentVelocity = character.GetLinearVelocity();
        const nextVelocity = new Jolt.Vec3(
            LaunchVelocity.x,
            bZOverride ? LaunchVelocity.z ?? LaunchVelocity.y : currentVelocity.GetY() + (LaunchVelocity.z ?? LaunchVelocity.y),
            LaunchVelocity.z ?? currentVelocity.GetZ(),
        );
        character.SetLinearVelocity(nextVelocity);
        Jolt.destroy?.(nextVelocity);
        return this;
    }
}

export class APlayerController {
    constructor(ctx) {
        this._ctx = ctx;
        this.bShowMouseCursor = false;
    }

    GetWorld() {
        return getRuntimeWorld(this._ctx);
    }

    GetHUD() {
        return this.GetWorld()?.GetHUD() ?? null;
    }

    GetPawn() {
        return getRuntimePlayerPawn(this._ctx);
    }

    GetCharacter() {
        return getRuntimePlayerCharacter(this._ctx);
    }

    GetGameInstance() {
        return getRuntimeGameInstance(this._ctx);
    }

    GetControlRotation() {
        return getPlayerRuntimeRotation(this._ctx);
    }

    SetControlRotation(rotation) {
        setPlayerRuntimeRotation(this._ctx, rotation);
        return this;
    }

    SetShowMouseCursor(showMouseCursor) {
        this.bShowMouseCursor = !!showMouseCursor;
        return this;
    }

    SetInputModeGameOnly() {
        this._ctx?.enterGameplay?.();
        return this;
    }

    SetInputModeUIOnly() {
        this._ctx?.exitGameplay?.();
        return this;
    }

    ProjectWorldLocationToScreen(worldLocation) {
        const camera = this._ctx?.camera ?? null;
        const renderer = this._ctx?.renderer ?? null;
        if (!camera || !renderer || !worldLocation) {
            return { X: 0, Y: 0, bPlayerViewportRelative: true };
        }

        const projected = new THREE.Vector3(worldLocation.x, worldLocation.y, worldLocation.z).project(camera);
        const viewport = renderer.getSize(new THREE.Vector2());
        return {
            X: (projected.x * 0.5 + 0.5) * viewport.x,
            Y: (-projected.y * 0.5 + 0.5) * viewport.y,
            bPlayerViewportRelative: true,
        };
    }
}

export class AGameModeBase {
    constructor(ctx) {
        this._ctx = ctx;
    }

    GetWorld() {
        return getRuntimeWorld(this._ctx);
    }

    GetGameInstance() {
        return getRuntimeGameInstance(this._ctx);
    }

    GetDefaultPawnClassForController() {
        return ACharacter;
    }

    GetNumPlayers() {
        return 1;
    }

    GetPlayerController(PlayerIndex = 0) {
        return PlayerIndex === 0 ? getRuntimePlayerController(this._ctx) : null;
    }

    RestartPlayer(_PlayerController = this.GetPlayerController(0)) {
        this._ctx?.respawnPlayer?.(true);
        return getRuntimePlayerCharacter(this._ctx);
    }

    StartPlay() {
        this._ctx?.enterGameplay?.();
        return true;
    }

    EndPlay() {
        this._ctx?.exitGameplay?.();
        return true;
    }
}

export class AGameMode extends AGameModeBase {}

// ───────── Lifecycle detection ─────────

const LIFECYCLE_PROBE = /\bfunction\s+(BeginPlay|Tick|OnHit|EndPlay|OnInput|OnInputPressed|OnInputReleased|OnPossessed|OnUnpossessed|OnTrigger|OnTriggerExit)\s*\(/;

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
 *                              playSoundAtLocation,
 *                              destroyActor }
 * @param {object} actor        The actor running the script.
 * @param {object|null} collision  Optional collision payload for OnHit.
 * @returns {object}            Combined api bag.
 */
export function buildUeContext(legacyApi, ctx, actor, collision = null) {
    const runtimeCtx = {
        ...ctx,
        renderer: ctx?.renderer ?? legacyApi?.renderer ?? null,
        gameplay: ctx?.gameplay ?? legacyApi?.gameplay ?? null,
        currentMesh: ctx?.currentMesh ?? legacyApi?.currentMesh ?? null,
        deltaTime: legacyApi?.deltaTime ?? ctx?.deltaTime ?? 0,
    };
    const world = getRuntimeWorld(runtimeCtx);

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
    const destroyActor = runtimeCtx?.destroyActor;
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
        AHUD,
        UAudioComponent: AudioComponent,
        UButtonWidget,
        UImageWidget,
        UPrimitiveComponent: PhysicsComponent,
        UProgressBarWidget,
        UTextWidget,
        UTransformComponent: TransformComponent,
        UUserWidget,
        UGameInstance,
        UWorld,
        AGameModeBase,
        AGameMode,
        APlayerController,
        APawn,
        ACharacter,
        // Globals
        Self: actor,
        HUD: world.GetHUD(),
        WidgetAPI: runtimeCtx?.widgetApi ?? null,
        UnrealWidgetAPI: runtimeCtx?.unrealWidgetApi ?? null,
        World: world,
        GameInstance: world.GetGameInstance(),
        GameMode: world.GetAuthGameMode(),
        PlayerController: world.GetFirstPlayerController(),
        Pawn: world.GetPlayerPawn(),
        Character: world.GetPlayerCharacter(),
        CreateWidget: (WidgetClass = UUserWidget, Config = {}) => world.CreateWidget(WidgetClass, Config),
        GetHUD: () => world.GetHUD(),
        GetWorld: () => world,
        GetGameInstance: () => world.GetGameInstance(),
        GetGameMode: () => world.GetAuthGameMode(),
        GetPlayerController: (PlayerIndex = 0) => world.GetPlayerController(PlayerIndex),
        GetPlayerPawn: (PlayerIndex = 0) => world.GetPlayerPawn(PlayerIndex),
        GetPlayerCharacter: (PlayerIndex = 0) => world.GetPlayerCharacter(PlayerIndex),
        DeltaTime: legacyApi?.deltaTime ?? 0,
        Hit: hit,
    };
}
