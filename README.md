[PolyFlow 3D is a WebGPU-powered in-browser asset viewer and optimization sandbox.

## Walkable Scene Branch

Branch: `feature/walkable-scene`

This branch keeps the original HDR-lit scene and asset pipeline, but adds a lightweight first-person exploration mode so you can spawn onto the loaded scene and walk around it.

## Controls

- `Enter Play Mode`: spawn into the current scene and lock the cursor.
- `W`, `A`, `S`, `D`: move.
- `Mouse`: look around.
- `Space`: jump.
- `Shift`: sprint.
- `R`: respawn at the current scene spawn point.
- `Esc`: leave play mode.
- `Reset View`: resets the showcase camera outside play mode, respawns while in play mode.

## Notes

- The loaded asset is rescaled to be large enough to explore in first person.
- The scene now includes a terrain layer textured with the seamless CC0 ambientCG Grass004 material stored in public/textures/grass004.
- Spawn placement prefers the top of the loaded mesh and falls back to the surrounding floor when the mesh is not safely walkable.
- Collision is intentionally lightweight for this first pass and is based on raycasts rather than a full physics engine.
- The current play mode is desktop-first and intended for pointer-lock mouse input.

## UE-Style Scripting

- Actor scripts support Unreal-style lifecycle functions: `BeginPlay()`, `Tick()`, `OnHit()`, and `EndPlay()`.
- Input action scripts now run on the same UE-style facade.
- Preferred symbols are `World`, `GameMode`, `PlayerController`, `Pawn`, `Character`, `GameInstance`, `GetWorld()`, `FVector`, `FRotator`, `UPrimitiveComponent`, `UAudioComponent`, `HUD`, and `CreateWidget()`.
- Legacy raw globals such as `THREE`, `scene`, `camera`, `gameplay`, and `physics` still remain available for compatibility.

Example:

```javascript
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
```

## Development

- `npm run dev`: start the Vite dev server.
- `npm run build`: create a production build.
- `npm run preview`: preview the production build locally.
](https://github.com/idkyet312/polyflow-3d/tree/wasmcustomenginesound)
