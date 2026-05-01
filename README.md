PolyFlow 3D is a WebGPU game engine that runs in the browser. It combines an HDR-lit 3D editor, physics props, first-person play mode, vehicle driving, UE-style scripting, runtime widgets, multiplayer hooks, and a WebAssembly engine-audio worklet.
Engine Branch

Branch: wasmcustomenginesound

This branch expands PolyFlow from an asset viewer into a small browser-native game engine. You can load or spawn actors, enter play mode, walk or drive through the scene, attach scripts, test collision, and hear vehicle audio through the custom WASM engine-sound pipeline.
Core Features

    WebGPU-ready in-browser 3D runtime built on Three.js and Vite.
    HDR environment lighting and terrain presentation.
    First-person play mode with pointer-lock mouse input.
    Physics-backed dynamic props and imported collision options.
    Drivable summoned vehicle with WASM engine sound and JS fallback indicator.
    UE-style actor scripting with BeginPlay(), Tick(), OnHit(), and EndPlay().
    Runtime HUD/widget API with Unreal-style helpers.
    Multiplayer client/server scaffolding.
    Production deployment through GitHub Pages.

Controls

    Enter Play Mode: spawn into the scene and lock cursor.
    W, A, S, D: move or drive.
    Mouse: look.
    Space: jump or brake in vehicle.
    Shift: sprint or boost.
    E: enter or exit nearby vehicle.
    V: summon vehicle.
    R: respawn.
    Esc: leave play mode.
    Reset View: reset showcase camera outside play mode, respawn during play.

Scene Notes

    Loaded assets are scaled for first-person exploration.
    Terrain uses the CC0 ambientCG Grass004 material in public/textures/grass004.
    Spawn placement prefers safe walkable mesh tops, then falls back to floor placement.
    Physics uses Jolt for runtime bodies, with lighter raycast helpers where appropriate.
    Play mode is desktop-first and pointer-lock focused.

UE-Style Scripting

Actor and input scripts can use Unreal-style symbols:

    World, GameMode, PlayerController, Pawn, Character, GameInstance
    GetWorld(), FVector, FRotator, FTransform, FHitResult
    UPrimitiveComponent, UAudioComponent, HUD, CreateWidget()

Legacy globals such as THREE, scene, camera, gameplay, and physics remain available.

function BeginPlay() {
	const widget = CreateWidget(UTextWidget, {
		Text: 'Ready',
		Position: { x: 0.08, y: 0.1 },
	});
	widget.AddToViewport();
}

function Tick() {
	const phys = Self.GetComponentByClass(UPrimitiveComponent);
	if (phys) {
		phys.AddForce(new FVector(0, 15, 0));
	}
}

Development

    npm run dev: start Vite dev server.
    npm run build: create production build.
    npm run preview: preview production build locally.
    npm run deploy: publish dist to GitHub Pages.
