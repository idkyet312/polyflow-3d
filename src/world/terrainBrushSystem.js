import * as THREE from 'three';

// Terrain brush + foliage paint system. Extracted from runtime.js.
// Owns the brush helper ring mesh, raycast → terrain hit, preview update,
// sculpt/paint/foliage apply, and serialization of terrain + foliage state.
//
// Stays in runtime.js (shared utility / reassigned binding):
//   - terrainBrushState (mutable shared config)
//   - worldFloor (let binding, reassigned on level load)
//   - blueprintState, gameplay (shared scene state)
//
// Deps (injected; live arrows where reassigned):
//   THREE namespace not needed externally — only internal.
//   getWorldFloor          - () => Mesh | null  (live)
//   getRenderer            - () => WebGLRenderer | null
//   getCamera              - () => THREE.Camera | null
//   getCurrentMesh         - () => Object3D | null
//   pointerNdc             - shared THREE.Vector2 scratch
//   raycaster              - shared THREE.Raycaster
//   terrainBrushState      - shared mutable config blob
//   gameplay               - shared { active }
//   blueprintState         - shared { active }
//   physics                - shared { ready }
//   grassField             - foliage manager (.paintFoliage/.syncToTerrain/.serialize/.applySerialized)
//   getSelectedSceneActor  - () => Actor | null
//   getActorRenderObject   - (actor) => Object3D | null
//   sceneSystem            - { actors: Set } (live via accessor)
//   actorBelongsToCurrentMesh - (actor) => bool
//   applyTerrainSculptBrush - sculpt API
//   serializeTerrainState   - serialize API
//   applySerializedTerrainState - restore API
//   rebuildTerrainPhysicsBody - rebuild Jolt body
//   ensurePlayerCharacter   - char-controller init
//   updateWorldPresentation - presentation refresh
//   updateGameplayUI        - HUD refresh
export function createTerrainBrushSystem({
    getWorldFloor,
    getRenderer,
    getCamera,
    getCurrentMesh,
    pointerNdc,
    raycaster,
    terrainBrushState,
    gameplay,
    blueprintState,
    physics,
    grassField,
    getSelectedSceneActor,
    getActorRenderObject,
    getSceneSystem,
    actorBelongsToCurrentMesh,
    applyTerrainSculptBrush,
    serializeTerrainState,
    applySerializedTerrainState,
    rebuildTerrainPhysicsBody,
    ensurePlayerCharacter,
    updateWorldPresentation,
    updateGameplayUI,
}) {
    function ensureTerrainBrushHelper() {
        if (terrainBrushState.helper) return terrainBrushState.helper;
        const geometry = new THREE.RingGeometry(0.96, 1, 96);
        const material = new THREE.MeshBasicMaterial({
            color: 0x00ffaa,
            transparent: true,
            opacity: 0.85,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        const helper = new THREE.Mesh(geometry, material);
        helper.name = 'TerrainBrushPreview';
        helper.renderOrder = 999;
        helper.visible = false;
        terrainBrushState.helper = helper;
        getWorldFloor()?.add(helper);
        return helper;
    }

    function isTerrainBrushTargetActor(actor) {
        const mesh = getActorRenderObject(actor);
        return !!(actor && (actor.userData?.terrainBrushTarget || mesh?.userData?.terrainBrushTarget));
    }

    function getSelectedTerrainBrushActor() {
        const actor = getSelectedSceneActor();
        return isTerrainBrushTargetActor(actor) ? actor : null;
    }

    function sceneHasActorTerrainBrushTarget() {
        const sceneSystem = getSceneSystem();
        if (!sceneSystem?.actors?.size || !getCurrentMesh()) return false;
        for (const actor of sceneSystem.actors) {
            if (!actorBelongsToCurrentMesh(actor)) continue;
            if (isTerrainBrushTargetActor(actor)) return true;
        }
        return false;
    }

    function getTerrainBrushTargetObject() {
        const selectedActor = getSelectedTerrainBrushActor();
        if (selectedActor) {
            return getActorRenderObject(selectedActor);
        }
        if (sceneHasActorTerrainBrushTarget()) {
            return null;
        }
        return getWorldFloor() || null;
    }

    function getTerrainHitFromEvent(event) {
        const target = getTerrainBrushTargetObject();
        const renderer = getRenderer();
        const camera = getCamera();
        if (!renderer || !target || !camera) return null;
        const rect = renderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointerNdc, camera);
        const hit = raycaster.intersectObject(target, true)[0];
        if (!hit) return null;
        const local = target.worldToLocal(hit.point.clone());
        return { hit, local, target };
    }

    function updateTerrainBrushPreview(event) {
        const helper = ensureTerrainBrushHelper();
        if (!terrainBrushState.enabled || gameplay.active || blueprintState.active) {
            helper.visible = false;
            return null;
        }
        const terrainHit = getTerrainHitFromEvent(event);
        if (!terrainHit) {
            helper.visible = false;
            return null;
        }
        if (helper.parent !== terrainHit.target) {
            terrainHit.target.add(helper);
        }
        terrainBrushState.targetObject = terrainHit.target;
        helper.visible = true;
        helper.position.set(terrainHit.local.x, terrainHit.local.y, terrainHit.local.z + 0.035);
        helper.scale.setScalar(terrainBrushState.radius);
        const foliagePreviewColor = terrainBrushState.foliageType === 'tree'
            ? 0x2f7d32
            : terrainBrushState.foliageType === 'bush'
                ? 0x55a545
                : 0xa8d96b;
        helper.material.color.set(
            terrainBrushState.tool.includes('foliage')
                ? foliagePreviewColor
                : terrainBrushState.tool === 'paint'
                    ? terrainBrushState.paintColor
                    : 0x00ffaa
        );
        return terrainHit;
    }

    function applyTerrainBrushFromEvent(event) {
        const terrainHit = updateTerrainBrushPreview(event);
        if (!terrainHit) return false;

        const worldFloor = getWorldFloor();
        const { local, target } = terrainHit;
        const tool = terrainBrushState.tool;
        if (tool === 'foliage' || tool === 'erase-foliage') {
            if (target !== worldFloor) return false;
            grassField?.paintFoliage?.({
                terrain: worldFloor,
                localX: local.x,
                localY: local.y,
                radius: terrainBrushState.radius,
                density: terrainBrushState.foliageDensity,
                mode: event.shiftKey || tool === 'erase-foliage' ? 'erase' : 'add',
                type: terrainBrushState.foliageType,
            });
            return true;
        }

        const changed = applyTerrainSculptBrush(target, {
            localX: local.x,
            localY: local.y,
            radius: terrainBrushState.radius,
            strength: terrainBrushState.strength,
            mode: tool,
            targetHeight: terrainBrushState.flattenHeight,
            paintColor: terrainBrushState.paintColor,
            invert: event.shiftKey,
        });
        if (changed) {
            if (target === worldFloor) {
                grassField?.syncToTerrain?.(worldFloor, {
                    localX: local.x,
                    localY: local.y,
                    radius: terrainBrushState.radius + 2,
                });
            }
            terrainBrushState.dirtyPhysics = true;
            terrainBrushState.targetObject = target;
        }
        return changed;
    }

    function serializeWorldTerrainState() {
        const worldFloor = getWorldFloor();
        return {
            terrain: serializeTerrainState(worldFloor),
            foliage: grassField?.serializeFoliage?.() ?? null,
        };
    }

    function applyWorldTerrainState(data = {}) {
        const worldFloor = getWorldFloor();
        applySerializedTerrainState(worldFloor, data.terrain);
        rebuildTerrainPhysicsBody();
        grassField?.applySerializedFoliage?.(data.foliage ?? {}, worldFloor);
        grassField?.syncToTerrain?.(worldFloor);
        if (physics.ready) {
            ensurePlayerCharacter();
            gameplay.canPlay = true;
            updateWorldPresentation();
            updateGameplayUI();
        }
    }

    return {
        ensureTerrainBrushHelper,
        isTerrainBrushTargetActor,
        getSelectedTerrainBrushActor,
        sceneHasActorTerrainBrushTarget,
        getTerrainBrushTargetObject,
        getTerrainHitFromEvent,
        updateTerrainBrushPreview,
        applyTerrainBrushFromEvent,
        serializeWorldTerrainState,
        applyWorldTerrainState,
    };
}
