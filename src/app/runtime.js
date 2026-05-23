import * as THREE from 'three';
import { WebGPURenderer, RectAreaLightNode } from 'three/webgpu';
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
import { uniform } from 'three/tsl';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import gsap from 'gsap';
import {
    WidgetManager,
    BaseWidget,
    TextWidget,
    ImageWidget,
    ProgressBarWidget,
    ButtonWidget,
} from '../ui/widgets.js';
import {
    sampleTestTone,
    writeWaveAscii,
    createTestSoundBuffer,
    createMediaTestSoundUrl,
    createEngineNoiseBuffer,
    createCombustionPulseBuffer,
    createCombustionDistortionCurve,
} from '../audio/synthesis.js';
import { createDrivableCarVisual } from '../vehicle/visual.js';
import { createVehicleFx } from '../vehicle/fx.js';
import { createCombatFx } from '../gameplay/combatFx.js';
import { createHeldWeapons } from '../gameplay/heldWeapons.js';
import { createSceneBundle } from '../world/sceneBundle.js';
import { createLevels } from '../world/levels.js';
import { createPrefabSystem } from '../runtime/prefabSystem.js';
import { createActorSpawn } from '../actors/actorSpawn.js';
import { createVehiclePhysics } from '../vehicle/vehiclePhysics.js';
import { createInputPanels } from '../ui/inputPanels.js';
import { createDebugOverlays } from '../debug/overlays.js';
import { createSceneActorUi } from '../ui/sceneActorUi.js';
import { createShooterAi } from '../gameplay/shooterAi.js';
import {
    HELICOPTER_USER_SCRIPT,
    COIN_USER_SCRIPT,
    HEALTH_PICKUP_USER_SCRIPT,
    TARGET_USER_SCRIPT,
    TELEPORTER_USER_SCRIPT,
    DOOM_SHOTGUN_USER_SCRIPT,
    SHOOTER_AI_USER_SCRIPT,
    SHOOTER_SPAWNER_USER_SCRIPT,
    ROGUE_GAMEMODE_SCRIPT,
} from '../gameplay/prefabScripts.js';
import {
    cloneDisposableObject,
    formatImportedPropName,
    normalizeObjectToDimension,
    createLoadingManager,
    convertLoadedObjectMaterials,
    loadObjectFromFile,
} from '../io/objectLoader.js';
import { createSocketMultiplayer } from '../network/socketMultiplayer.js';
import { createPhysicsCore } from '../physics/core.js';
import { createPhysicsRuntime } from '../physics/runtime.js';
import { createEnvironmentController } from '../world/environment.js';
import { createLightGridController } from '../world/lightGrid.js';
import { createVolumetricFog } from '../world/volumetricFog.js';
import { createPostProcessVolumeManager } from '../world/postProcessVolume.js';
import { getDDGIManager } from '../world/gi/ddgiManager.js';
import { createDDGIRayDebug } from '../world/gi/ddgiRayDebug.js';
import { DDGIMeshStandardNodeMaterial } from '../world/gi/DDGIMeshStandardNodeMaterial.js';
import { getBrickTextureSet, registerBrickClone } from '../world/materials/brickTextures.js';
import { getProceduralBrickSet } from '../world/materials/proceduralBrickTexture.js';
import {
    createActor,
    createSceneSystem,
    ensureActorScriptComponent,
    AudioComponent,
    getMetadataComponent,
    getPhysicsBodyComponent,
    getRenderComponent,
    getScriptComponent,
    PhysicsComponent,
    TransformComponent,
    DDGIVolumeComponent,
    CircularPatrolComponent,
    ShooterSpawnerComponent,
    HealthPickupComponent,
    WeaponPickupComponent,
    CoinComponent,
    TargetComponent,
} from '../runtime/sceneRuntime.js';
import { assetRegistry } from '../runtime/assets/AssetRegistry.js';
import { prefabRegistry } from '../runtime/assets/PrefabRegistry.js';
import { registerCoreAssets } from '../runtime/assets/assetManifest.js';
import { createDynamicBodySpatialIndex } from '../physics/dynamicBodySpatial.js';
import {
    createDynamicCollisionEventRunner,
    resetActorScriptLifecycleHandles,
} from '../physics/dynamicCollisionEvents.js';
import { createObjectLifecycle } from '../assets/objectLifecycle.js';
import { createPhysgunController } from '../tools/physgun.js';
import {
    TERRAIN_Y_OFFSET,
    applyTerrainTextures,
    createTerrainMesh,
    sampleTerrainHeightAt as sampleTerrainHeightAtWorldFloor,
    setTerrainModeGrid,
    setTerrainModeSolid,
    setTerrainModeGrassPBR,
    setTerrainCustomImage,
    setTerrainTint,
    setTerrainRepeat,
    setTerrainRoughness,
    applyTerrainSculptBrush,
    serializeTerrainState,
    applySerializedTerrainState,
} from '../world/terrain.js';
import { createGrassField } from '../world/grass.js';
import { createWater } from '../world/water.js';
import { createLightmapBaker } from '../world/lightmapBaker.js';
import { createPostProcessUiController } from '../world/postProcessUiController.js';
import { createLitePhysicsPool } from '../physics/litePool.js';
import { createProjectileInstancer } from '../gameplay/projectileInstancer.js';
import { createProjectileSystem } from '../gameplay/projectileSystem.js';
import { createWeaponHud } from '../gameplay/weaponHud.js';
import { createPlayerCombat } from '../gameplay/playerCombat.js';
import { createTeleporterSystem } from '../gameplay/teleporterSystem.js';
import { createGameplayPrefabSystem } from '../gameplay/gameplayPrefabSystem.js';
import { createEffectsSystem } from '../gameplay/effectsSystem.js';
import { createTerrainBrushSystem } from '../world/terrainBrushSystem.js';
import { createObjectScriptStore } from '../scripting/objectScriptStore.js';
import { createInputReset, isEditableElement as _isEditableElement } from '../gameplay/inputReset.js';
import { createWorld } from '../runtime/World.js';
import { Services } from '../runtime/services.js';
import { registerDebug } from '../runtime/debugRegistry.js';
import { registerGameplaySystems } from '../gameplay/registerSystems.js';
import { createImportedPropsSystem } from './importedProps.js';
import { createVehicleSystem } from './vehicleSystem.js';
import { createShooterAiVisuals } from './shooterAiVisuals.js';
import { createActorTransforms } from './actorTransforms.js';
import { createGameplayComponents } from './gameplayComponents.js';
import { createRebuildActorPhysics } from './rebuildActorPhysics.js';
import { createPrimitiveMeshFactory } from './primitiveMeshes.js';
import { createShowcaseCamera } from './showcaseCamera.js';
import { createSpawnGameplayPrefab } from './spawnGameplayPrefab.js';
import { createWeaponFire } from './weaponFire.js';
import { createFrameLoop } from './frameLoop.js';
import { createInputHandlers } from './inputHandlers.js';
import { setupPostProcessing } from './postProcessingSetup.js';
import { wirePanelHandlers } from './wirePanelHandlers.js';
import { createLevelStateSystem } from '../gameplay/levelStateSystem.js';
import { createWorldEnvSystem } from '../world/worldEnvSystem.js';
import { createLightCull } from '../world/lighting/lightCull.js';
import { createAdaptiveQuality } from '../world/adaptiveQuality.js';

// Default World instance — owns the event bus and gameplay system registry.
// Anything that today references `eventBus` / `gameplaySystems` at module
// scope keeps working because we expose those bindings as the world's own.
//
// Event bus topics use namespace:event format:
//   player:damaged    { amount, damageAngle, sourcePos }
//   player:died       { sampleType, autoRespawn }
// Subscribers are wired in this file near the system that owns the response.
//
// System registry runs per-frame in topo-sorted order. Each system is a pure
// (delta, ctx) function. Populated near the bottom of this file (search for
// `gameplaySystems.register`). Frame loop calls gameplaySystems.tick(delta).
const defaultWorld = createWorld({ id: 'main' });
const eventBus = defaultWorld.eventBus;
const gameplaySystems = defaultWorld.systems;

// Recommended DI container for new code (preferred over `appCore`'s Proxy).
// Engine-wide singletons get registered here; subsystem factories can take a
// `services` ref and pull what they need by name. Older modules still read
// from appCore; both coexist intentionally.
const services = new Services();
services.register('world', () => defaultWorld);
services.register('eventBus', () => eventBus);
services.register('gameplaySystems', () => gameplaySystems);

registerDebug('world', defaultWorld);
registerDebug('eventBus', eventBus);
registerDebug('gameplaySystems', gameplaySystems);
registerDebug('services', services);
import { createRogueWaves } from '../gameplay/rogueWaves.js';
import { createDrugTycoon } from '../gameplay/drugTycoon.js';
import { createShootingSim } from '../gameplay/shootingSim.js';
import {
    AHUD,
    installUePrototypeMethods,
    buildUeContext,
    detectsUeLifecycle,
    UButtonWidget,
    UImageWidget,
    UProgressBarWidget,
    UTextWidget,
    UUserWidget,
} from '../scripting/ueApi.js';
import {
    SoundGeneratorAudioListener,
    EngineSoundGenerator as WasmEngineSoundGenerator,
} from '../../vendor/engine-sound/sound_generator_worklet_wasm.js';

// === Extracted modules (root main.js was 436 KB; split to keep <256 KB) ===
import {
    bindAppCore,
} from '../runtime/appCore.js';
import {
    engineApi,
    registerEngineFx,
    registerEngineSound,
    registerEngineHud,
    registerEngineWeapons,
    installLegacyWindowShims,
} from '../runtime/engineApi.js';
import { createShowcaseOptimizer } from '../optim/showcaseOptimizer.js';
import {
    setupVehicleEngineAudio,
    setEngineAudioDebugEl,
    playSpeakerTestTone,
    playMediaElementTestSound,
    resolveSoundLocation,
    cleanupTransientAudio,
    clampVehicleEngineRpm,
    resetVehicleEngineAudioState,
    createVehicleEngineWasmParameters,
    describeVehicleEngineWasmError,
    markVehicleEngineWasmUnavailable,
    shutdownVehicleEngineAudioWasm,
    primeVehicleEngineAudioWasm,
    shutdownLegacyVehicleEngineAudio,
    shutdownVehicleEngineAudio,
    silenceVehicleEngineAudio,
    ensureLegacyVehicleEngineAudio,
    ensureVehicleEngineAudioWasm,
    ensureVehicleEngineAudio,
    updateLegacyVehicleEngineAudio,
    updateVehicleEngineAudioWasm,
    updateVehicleEngineAudio,
    updateEngineAudioDebugOverlay,
    resolveRuntimeSoundBuffer,
    playSoundAtLocation,
    getAudioTestLocation,
    playAudioTestCue,
} from '../audio/vehicleEngineAudio.js';
import {
    setupObjectMaterial,
    setActorColor,
    markActorMaterialDirty,
    getObjectMaterialArray,
    clampMaterialStateValue,
    serializeMaterialSide,
    deserializeMaterialSide,
    serializeSingleMaterialState,
    getObjectMaterialPreviewState,
    serializeObjectMaterialState,
    applyObjectMaterialState,
    serializeObjectMaterialOverrides,
    getObjectByHierarchyPath,
    applyObjectMaterialOverrides,
} from '../world/objectMaterial.js';
import {
    setupMouseActions,
    readMouseActionDrafts,
    saveMouseActionDrafts,
    getMouseActionLabel,
    getMouseActionMessage,
    updateMouseActionStatus,
    syncInputActionsEditor,
    openInputActionsEditor,
    closeInputActionsEditor,
    updateSelectedMouseActionSource,
    compileMouseActionScript,
    buildMouseActionApi,
    applyMouseActionScripts,
    resetMouseActionScripts,
    initializeMouseActionScripts,
    runMouseAction,
} from '../scripting/mouseActions.js';
import {
    setupObjectEvents,
    compileObjectEventScript,
    syncPropScriptState,
    createDynamicPropActor,
    removeObjectScriptDraft,
    findDynamicPropByMesh,
    getObjectScriptEventLabel,
    getDynamicPropDisplayName,
    getDynamicPropById,
    isTransformControlSphereHit,
    getDynamicPropHitFromEvent,
    updateObjectScriptEditorStatus,
    syncObjectScriptEditor,
    closeObjectScriptMenu,
    closeObjectScriptEditor,
    maybeOpenObjectScriptMenuFromMobileTap,
    openObjectScriptMenu,
    openObjectScriptEditor,
    updatePropScriptSource,
    clearPropScriptSource,
    setPropTickEventEnabled,
    buildObjectEventApi,
    handleObjectScriptRuntimeError,
    runObjectEventScript,
    runObjectTickScripts,
    runObjectInputScripts,
    dispatchPossessionEvent,
    dispatchTriggerEvent,
    ensureScriptHandles,
    getActorByBodyId,
} from '../scripting/objectEvents.js';
import {
    setupDebugConsole,
    pushTimingSample,
    getAverageTiming,
    formatTimingMs,
    renderDebugConsoleOutput,
    pushDebugConsoleLine,
    focusDebugConsoleInput,
    setDebugConsoleVisible,
    createDebugStatRow,
    createDebugStatPanel,
    syncDebugStatPanels,
    updateDebugStatPanels,
    setDebugStatPanel,
    runStatCommand,
    applyMobileModeState,
    runMobileCommand,
    runRayDebugCommand,
    runMeshShadowsCommand,
    debugCommandRegistry,
    executeDebugConsoleCommand,
    handleDebugConsoleInputKeydown,
    handleDebugConsoleKeydown,
    recordDebugFrameMetrics,
} from '../debug/console.js';
import {
    setupMobileControls,
    setMobileMenuOpen,
    setTouchThumbPosition,
    clearMobilePad,
    applyMobileMoveVector,
    updateMobileMovePad,
    resetMobileMovePad,
    applyMobileLookDelta,
    updateMobileLookPad,
    resetMobileLookPad,
    syncMobileActionVisibility,
    updateMobileButtons,
    applyMobileHoldButton,
    bindMobilePad,
} from '../ui/mobileControls.js';
import {
    setupMobileStartScreen,
    closeMobileGamePauseMenu,
    handleMobileExitPlay,
    isMobileGamePaused,
} from '../ui/mobileStartScreen.js';
import {
    setupSceneSerialization,
    loadWorldFromSceneFolder,
    getActorComponentFlags,
    setActorComponentFlags,
    normalizeSerializedActorComponentFlags,
    serializeActorData,
    spawnActorFromSerializedData,
    exportActorToFile,
    progressOverlay,
    yieldToPaint,
    loadActorFromFile,
    readFileAsTextWithProgress,
    clearSceneActors,
    loadWorldFromUmap,
} from '../world/sceneSerialization.js';
import {
    setupBlueprintEditor,
    enterBlueprintEditor,
    exitBlueprintEditor,
    formatBlueprintMaterialScalar,
    getBlueprintMaterialEditorRefs,
    getBlueprintComponentDisplayName,
    isBlueprintMaterialTarget,
    getBlueprintMaterialTargets,
    getBlueprintMaterialPreviewTarget,
    setBlueprintMaterialScalarPair,
    setBlueprintDetailsMode,
    syncBlueprintLightScalarInput,
    setBlueprintLightScalarPair,
    readBlueprintLightScalarInput,
    setBlueprintSpotRowsVisible,
    syncBlueprintLightEditor,
    setBlueprintMaterialEditorEnabled,
    syncBlueprintMaterialEditor,
    syncBlueprintMaterialScalarInput,
    readBlueprintMaterialScalarInput,
    readBlueprintMaterialEditorState,
    applyBlueprintMaterialEdits,
    previewBlueprintMaterialEdits,
    readBlueprintLightEditorState,
    applyBlueprintLightEdits,
    refreshBlueprintComponents,
    updateBlueprintTransformUI,
    updateBlueprintDetailsUI,
    applyBlueprintDetailsFromUI,
} from '../editor/blueprintEditor.js';
import {
    setupSceneHistory,
    snapshotSceneState,
    restoreSceneState,
    serializeComponentTree,
    deserializeComponentTree,
    serializeActorToJSON,
    spawnActorFromJSON,
    deleteSelectedActor,
    copySelectedToClipboard,
    pasteFromClipboard,
    duplicateSelected,
    editorHistory,
    exportWorldToJSON,
    loadWorldFromJSON,
} from '../editor/sceneHistory.js';


installUePrototypeMethods();


// Global widget manager instance
let widgetManager;
let runtimeHud;

// Widget API functions (call these from Three.js commands)
window.WidgetAPI = {
    createWidget: (type, config) => {
        if (!widgetManager) return null;
        return widgetManager.createWidget(type, config);
    },

    updateWidget: (id, updates) => {
        if (!widgetManager) return false;
        return widgetManager.updateWidget(id, updates);
    },

    showWidget: (id, visible) => {
        if (!widgetManager) return false;
        return widgetManager.showWidget(id, visible);
    },

    removeWidget: (id) => {
        if (!widgetManager) return false;
        return widgetManager.removeWidget(id);
    },

    setWidgetPosition: (id, position, space) => {
        if (!widgetManager) return false;
        return widgetManager.setWidgetPosition(id, position, space);
    },

    setWidgetScale: (id, scale) => {
        if (!widgetManager) return false;
        return widgetManager.setWidgetScale(id, scale);
    },

    getWidget: (id) => {
        if (!widgetManager) return null;
        return widgetManager.getWidget(id);
    },

    getAllWidgets: () => {
        if (!widgetManager) return [];
        return widgetManager.getAllWidgets();
    }
};

function getRuntimeHud() {
    if (!runtimeHud) {
        runtimeHud = new AHUD({ widgetApi: window.WidgetAPI });
    }
    return runtimeHud;
}
window.UnrealWidgetAPI = {
    AHUD,
    UUserWidget,
    UTextWidget,
    UImageWidget,
    UProgressBarWidget,
    UButtonWidget,
    CreateWidget: (WidgetClass = UUserWidget, config = {}) => getRuntimeHud().CreateWidget(WidgetClass, config),
    GetHUD: () => getRuntimeHud(),
};

// Example widget creation function
function createExampleWidgets() {
    if (!widgetManager) return;

    const hud = getRuntimeHud();
    const visible = !!gameplay.active;

    const scoreWidget = hud.CreateWidget(UTextWidget, {
        Text: 'Score: 0',
        fontSize: 20,
        color: '#ffff00',
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        position: { x: 0.16, y: 0.9 },
        visible,
    });
    scoreWidget.AddToViewport(20);

    const healthBar = hud.CreateWidget(UProgressBarWidget, {
        Percent: gameplay.health,
        width: 200,
        height: 16,
        fillColor: gameplay.health > 0.35 ? '#00ff66' : '#ff3b30',
        backgroundColor: 'rgba(5,10,12,0.88)',
        borderColor: 'rgba(0,0,0,0.75)',
        borderWidth: '1px',
        borderRadius: '3px',
        position: { x: 0.16, y: 0.78 },
        visible,
    });
    healthBar.AddToViewport(20);

    const healthText = hud.CreateWidget(UTextWidget, {
        Text: 'Health: 100%',
        fontSize: 16,
        color: '#ffffff',
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        position: { x: 0.16, y: 0.765 },
        visible,
    });
    healthText.AddToViewport(20);

    const speedWidget = hud.CreateWidget(UTextWidget, {
        Text: 'Speed: 0 km/h',
        fontSize: 16,
        color: '#00ffff',
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        position: { x: 0.16, y: 0.7 },
        visible,
    });
    speedWidget.AddToViewport(20);

    window.exampleWidgets = {
        score: scoreWidget,
        health: healthBar,
        healthText,
        speed: speedWidget,
    };
    window.gameHud = hud;
    window.gameScore = 0;
    setPlayerHealth(window.playerHealth ?? 1);

    if (window.DEBUG_WIDGET_API) {
        console.log('Example widgets created:', window.exampleWidgets);
        console.log('Widget API available at window.WidgetAPI');
        console.log('Unreal widget API available at window.UnrealWidgetAPI');
        console.log('Example usage:');
        console.log('  WidgetAPI.createWidget("text", {text: "Hello!", position: {x: 0.5, y: 0.5}})');
        console.log('  UnrealWidgetAPI.CreateWidget(UTextWidget, { Text: "Hello HUD" }).AddToViewport(25)');
    }
}
const LIGHT_ACTOR_KINDS = new Set(['pointLight', 'spotLight', 'rectLight']);

function isLightActorKind(kind = '') {
    return LIGHT_ACTOR_KINDS.has(kind);
}

function getActorKindLabel(kind = 'sphere') {
    if (kind === 'vehicle') return 'Vehicle Actor';
    if (kind === 'imported') return 'Imported Actor';
    if (kind === 'sphere') return 'Sphere Actor';
    if (kind === 'cube') return 'Cube Actor';
    if (kind === 'cylinder') return 'Cylinder Actor';
    if (kind === 'capsule') return 'Simple AI Actor';
    if (kind === 'ddgiVolume') return 'DDGI Volume';
    if (kind === 'pointLight') return 'Point Light Actor';
    if (kind === 'spotLight') return 'Spot Light Actor';
    return 'Actor';
}

function getActorKindDefaultScale(kind = 'sphere') {
    if (kind === 'cube') return '2.0';
    if (kind === 'cylinder') return '1.0';
    if (kind === 'ddgiVolume') return '16.0';
    if (kind === 'pointLight') return '8.0';
    if (kind === 'spotLight') return '10.0';
    return '0.5';
}

// --- Configuration ---
let scene, camera, renderer, currentMesh, transformControl, postProcessing, mainDirectionalLight;

// Engine keystone: bind the reassigned module-scope refs into the shared
// appCore context EAGERLY (at declaration time, not inside wireExtractedModules)
// so any extracted subsystem sees live values via `core.*` before init runs —
// this is what removes the call-order / stale-getter class of bugs. The
// closures capture the variables, so reassignment in init()/loadSample is
// transparently visible. currentMesh also gets a setter so its reassignment
// flows through one owned place.
bindAppCore(
    {
        scene: () => scene,
        camera: () => camera,
        renderer: () => renderer,
        currentMesh: () => currentMesh,
        transformControl: () => transformControl,
        postProcessing: () => postProcessing,
        mainDirectionalLight: () => mainDirectionalLight,
        physicsCore: () => physicsCore,
        physics: () => physicsCore,
        sceneSystem: () => sceneSystem,
        worldFloor: () => worldFloor,
        grassField: () => grassField,
        sceneUiList: () => sceneUiList,
        sceneUiCount: () => sceneUiCount,
    },
    {
        currentMesh: (value) => { currentMesh = value; },
    },
);
let lightmapBaker = null;
let gpuTimestampResolvePending = null;
let latestGpuRenderMs = 0;
let environmentController, volumetricFogController, postProcessVolumeManager;
const globalPostProcessUniforms = {
    bloomStrength: uniform(0.28),
    bloomRadius: uniform(0.35),
    bloomThreshold: uniform(1.1)
};
let postProcessNodes = null;

// Performance toggle: when on, skips volumetric fog update and post-process
// volume update. (DDGI no longer respects this on fix/ddgi-correctness — see
// runtimeDdgiEnabled below.) The two subsystems own their own state via
// setEnabled, so flipping this saves both render work and CPU update work.
//
// Stays at TRUE on this branch so the post-process / TSL bloom pipeline doesn't
// boot — there's a separate latent bug there (UnrealBloomPass.* label invalid
// uncaught WebGPU errors on boot) that we don't want to surface while we're
// debugging DDGI. Bloom can be re-enabled from the World Environment panel.
const PERF_MODE_DEFAULT_ENABLED = false;
let perfModeEnabled = PERF_MODE_DEFAULT_ENABLED;
let perfModeUiRefs = null;

// World Environment panel state — Godot-style WorldEnvironment node mirror.
// Each section can be toggled on/off independently, and key values are tunable
// via sliders. State persists to localStorage so reloads keep the last config.
// Defaults match the engine's out-of-box look — DDGI off (heavy), everything
// else on. Changing the master "All Off" or "Performance" preset rewrites the
// `enabled` fields but preserves slider values.
// Bumped v2 → v3 on fix/ddgi-correctness so old saves with `ddgi.enabled = false`
// (the previous default) don't override the new boot-on-DDGI default. See doc
// comment on PERF_MODE_DEFAULT_ENABLED above for the broader fix context.
// Bumped v4 -> v5 for RT DDGI live-bake controls.
const WORLD_ENV_STORAGE_KEY = 'polyflow.worldEnvironment.v7';
// World environment state + apply/save/load extracted to
// ../world/worldEnvSystem.js. The module owns the mutable state object;
// the local `worldEnvState` alias below is the SAME ref the module holds
// (resetWorldEnvDefaults mutates it in place), so existing reads
// `worldEnvState.foo` keep working unchanged.
const _worldEnvSystem = createWorldEnvSystem({
    storageKey: WORLD_ENV_STORAGE_KEY,
    getRenderer: () => renderer,
    getAmbientLight: () => ambientLight,
    getHemiLight: () => hemiLight,
    getMainDirectionalLight: () => mainDirectionalLight,
    getEnvironmentController: () => environmentController,
    getVolumetricFogController: () => volumetricFogController,
    getPostProcessVolumeManager: () => postProcessVolumeManager,
    getPostProcessing: () => postProcessing,
    getPostProcessNodes: () => postProcessNodes,
    globalPostProcessUniforms,
    getDDGIManager: () => getDDGIManager(),
    getCornellPanelLight: () => cornellPanelLight,
    isPerfModeEnabled: () => perfModeEnabled,
    applyRenderResolutionSettings: (...a) => applyRenderResolutionSettings(...a),
    getLightCull: () => lightCull,
    getAdaptiveQuality: () => adaptiveQuality,
    applyShadowTuningToScene: (...a) => applyShadowTuningToScene(...a),
    applyPomTuningToScene: (...a) => applyPomTuningToScene(...a),
    applyCornellTestPreset: (...a) => applyCornellTestPreset(...a),
    getWorldEnvUiRefs: () => worldEnvUiRefs,
});
const WORLD_ENV_DEFAULTS = _worldEnvSystem.WORLD_ENV_DEFAULTS;
const worldEnvState = _worldEnvSystem.getWorldEnvState();
// Per-frame dynamic light culler (keeps only the N most important point/spot
// lights lit). Driven from the frame loop; configured from worldEnvState.
const lightCull = createLightCull();
registerDebug('lightCull', lightCull);
// Adaptive quality watchdog — auto-steps effects down/up based on FPS. Reads +
// mutates worldEnvState, then re-applies. Driven from the frame loop.
const adaptiveQuality = createAdaptiveQuality({
    getState: () => worldEnvState,
    applyState: (...a) => applyWorldEnvState(...a),
});
registerDebug('adaptiveQuality', adaptiveQuality);
let worldEnvUiRefs = null;
let ddgiTestVolumeActor = null;
let ddgiTestRigActor = null;
let sampleDDGIVolumeActor = null;
let cornellRayDebug = null;
let cornellPanelLight = null;
const cornellRayDebugOrigin = new THREE.Vector3();
let physicsCore;
let physicsRuntime;
let multiplayerController;
let sceneSystem;
const animationMixers = new Map();
const {
    disposeRenderableObject,
    getObjectAnimationClips,
    playObjectAnimation,
    stopObjectAnimations,
    updateObjectAnimations,
} = createObjectLifecycle({ animationMixers });
const actorCoreSyncState = new Map();
const MODEL_TARGET_MAX_DIMENSION = 12;
const PROP_TARGET_MAX_DIMENSION = 2.35;
const VEHICLE_CUSTOM_IMPORT_VALUE = '__custom_import__';
const IMPORTED_PROP_MAX_HULL_POINTS = 480;
const IMPORTED_PROP_MAX_HULL_PARTS = 18;
const IMPORTED_PROP_COMPLEX_HULL_RADIUS = 0.01;
// Cornell-box camera: positioned in front of the open side of the room
// looking into the back wall. Centred so the red wall is on the left and
// the green wall is on the right, matching the ddgi-cornell-box demo.
const SHOWCASE_CAMERA_POSITION = new THREE.Vector3(0, 1.0, 2.6);
const SHOWCASE_CAMERA_TARGET = new THREE.Vector3(0, 0.9, 0);
const JOLT_NON_MOVING_LAYER = 0;
const JOLT_MOVING_LAYER = 1;
const JOLT_OBJECT_LAYER_COUNT = 2;
const JOLT_BROAD_PHASE_LAYER_COUNT = 2;
const PLAYER_SETTINGS = {
    eyeHeight: 1.7,
    walkSpeed: 8.5,
    sprintSpeed: 15.2,
    jumpSpeed: 6.8,
    gravity: 18,
    collisionRadius: 0.6,
    wallClearance: 0.12,
    probeHeight: 80,
    maxLookPitch: Math.PI / 2 - 0.08,
    floorOffset: 0.04,
};
const VEHICLE_SETTINGS = {
    length: 2.6,
    width: 1.35,
    height: 0.6,
    mass: 1200,
    wheelBase: 1.72,
    trackWidth: 1.18,
    spawnDistance: 4.8,
    spawnLift: 0.02,
    interactionRadius: 4.5,
    seatHeight: 1.15,
    followDistance: 5.6,
    followHeight: 2.4,
    lookAhead: 2.2,
    cameraCollisionPadding: 0.35,
    cameraHorizontalSmoothing: 8.0,
    cameraVerticalSmoothing: 2.2,
    cameraLookSmoothing: 5.0,
    acceleration: 3.0,
    reverseAcceleration: 1.0,
    boostAcceleration: 4.5,
    coastDrag: 0.8,
    rollingDrag: 0.05,
    lowSpeedGrip: 8.0,
    highSpeedGrip: 5.5,
    brakeGrip: 10.0,
    driftGrip: 2.0,
    partialContactGrip: 1.5,
    driftBoostThreshold: 0.4,
    driftSteerBonus: 1.2,
    steeringRate: 2.8,
    steeringReturn: 5.0,
    steeringGrip: 6.0,
    steeringHighSpeedDamping: 0.35,
    uprightTorque: 40,
    rollTorque: 15,
    pitchTorque: 10,
    suspensionRideHeight: 0.43,
    suspensionTravel: 0.25,
    suspensionSpring: 2.8,
    suspensionDamping: 12.0,
    bumpPitchTorque: 0,
    bumpRollTorque: 0,
    bumpLaunchBoost: 0,
    airtimeAngularBlend: 0.03,
    maxDriveSpeed: 28,
    maxReverseSpeed: 32,
    brakeDamping: 0.85,
    maxAngularVelocity: 3.0,
};
const PHYSICS_COLLISION_STEPS = 2;
const DYNAMIC_SPATIAL_CELL_SIZE = 4;
const TEST_SOUND_ID = 'polyflow:test';

// Module-level refs so switchEnvironment can update them
let pedestalMat, ambientLight, hemiLight, pedestal, worldFloor;
let grassField = null;
let water = null;
const samplePresentationState = {
    overridden: false,
    terrainVisible: true,
    grassVisible: true,
    waterVisible: true,
};
const litePools = [];
let playHint, gameplayStatus, resetViewBtn, showcaseModeBtn, playModeBtn, mobilePreviewOnBtn, desktopMobileToggleBtn, browseModelBtn, openActorEditorBtn;
let playTestSoundBtn, playTestSoundStatus;
let multiplayerServerUrlInput, multiplayerRoomInput, multiplayerConnectBtn, multiplayerDisconnectBtn, multiplayerStatusValue, multiplayerPlayerCountValue;
let importPropBtn, propFileInput, importedPropList, importedPropLibrary, propImportDefaultStatus, resetPropImportDefaultBtn;
let postProcessUiRefs;
let shadowDebugUiRefs;
let propCollisionPrompt, propCollisionCopy, propCollisionRemember, propCollisionSimpleBtn, propCollisionComplexBtn, propCollisionCancelBtn;
let inputActionsOpenBtn, inputActionsEditor, inputActionLeftBtn, inputActionRightBtn, inputActionMode, inputActionEditorInput, inputActionsEditorStatus, mouseActionApplyBtn, mouseActionResetBtn, inputActionsCloseBtn, mouseActionStatus;
let objectScriptMenu, objectScriptTickActionBtn, objectScriptCollisionActionBtn;
let objectScriptEditor, objectScriptEditorTitle, objectScriptEditorTarget, objectScriptEditorMode;
let objectScriptEditorInput, objectScriptEditorStatus, objectScriptEditorApplyBtn, objectScriptEditorClearBtn, objectScriptEditorCancelBtn;
let objectScriptTickToggleRow, objectScriptTickToggleInput;
let actorEditor, actorEditorSummary, actorEditorStatus, actorKindSelect, actorLabelInput, actorScaleInput, actorImportedTemplateSelect, actorVehicleBodyTemplateSelect, actorVehicleWheelTemplateSelect, vehicleTemplateImportInput;
// Tracks which vehicle slot ('body'|'wheel') triggered the file picker so the
// import handler knows which select to update.
let pendingVehicleTemplateImportSlot = null;
let actorComponentCollisionInput, actorComponentPhysicsInput, actorComponentScriptsInput, actorEditorCreateBtn, actorEditorOpenScriptBtn, actorEditorCancelBtn;
let debugConsole, debugConsoleOutput, debugConsoleInput, debugConsoleFooter, debugStatsOverlay, engineAudioDebugEl;
let sceneUiPanel, sceneUiCount, sceneUiList;
let mobileMenuToggleBtn, mobileModeToggleBtn;
let mobileMovePad, mobileMoveThumb, mobileLookPad, mobileLookThumb;
let mobileJumpBtn, mobileRightActionBtn, mobileAction2Btn;
let lightGridController;
const IMPORTED_PROP_COLLISION_LABELS = {
    simple: 'simple box collision',
    complex: 'tighter convex collision',
};
const MOBILE_MOVE_THRESHOLD = 0.18;
const MOBILE_MOVE_RADIUS_FACTOR = 0.36;
const MOBILE_LOOK_SENSITIVITY = 0.0045;
const mobileState = {
    enabled: false,
    detected: false,
    forced: false,
    menuOpen: false,
    movePointerId: null,
    lookPointerId: null,
    lastWorldTapTime: 0,
    lastWorldTapX: 0,
    lastWorldTapY: 0,
    launchedFromGames: false,
    currentGameLevelId: null,
    quality: 'low',
};
const importedPropState = {
    nextId: 1,
    templates: [],
    futureCollisionMode: null,
    promptResolver: null,
    // Track the original imported File per template so "Save Scene Folder"
    // can copy the raw asset alongside the .umap rather than inlining the
    // mesh as a giant rootJson blob (which is what makes legacy .umap loads
    // slow). Keyed by template.id.
    sourceFiles: Object.create(null),
};
function listImportedTemplates() {
    return assetRegistry.listImportedTemplates();
}
function getImportedTemplate(templateId) {
    return assetRegistry.getImportedTemplate(templateId);
}
const actorEditorState = {
    open: false,
};
const blueprintState = {
    active: false,
    targetActor: null,
    selectedComponent: null,
    selectedComponents: new Set(),
    materialMultiSelectActive: false,
    floorMesh: null,
    savedCameraPosition: null,
    savedShowcaseAngles: null,
    savedBackground: null
};
const postProcessUiState = {
    target: 'global',
};
const postProcessUi = createPostProcessUiController({
    state: postProcessUiState,
    uniforms: globalPostProcessUniforms,
    getRefs: () => postProcessUiRefs,
    getManager: () => postProcessVolumeManager,
    getRenderer: () => renderer,
    getCamera: () => camera,
});
const applyPostProcessSettingsFromUi = postProcessUi.apply;
const loadPostProcessInputsFromState = postProcessUi.loadInputsFromState;
const syncPostProcessVolumeUi = postProcessUi.sync;
const updatePostProcessSliderLabels = postProcessUi.updateSliderLabels;
const updatePostProcessStatusUi = postProcessUi.updateStatusUi;
const updatePostProcessToggleUi = postProcessUi.updateToggleUi;
const MOUSE_ACTION_STORAGE_KEY = 'polyflow-3d.mouse-actions.v1';
const OBJECT_SCRIPT_STORAGE_KEY = 'polyflow-3d.object-scripts.v1';
const DEBUG_CONSOLE_LOG_LIMIT = 18;
const DEBUG_CONSOLE_HISTORY_LIMIT = 24;
const DEBUG_TIMING_SAMPLE_LIMIT = 30;
const DEFAULT_MOUSE_ACTION_SCRIPTS = {
    left: `const camDir = new THREE.Vector3();
camera.getWorldDirection(camDir);
const direction = new FVector(camDir.x, camDir.y, camDir.z).GetSafeNormal();
const camPos = camera.position;
const spawnLocation = new FVector(
    camPos.x + direction.x * 1.8,
    camPos.y + direction.y * 1.8,
    camPos.z + direction.z * 1.8,
);

const sphere = World.SpawnActor('Sphere', spawnLocation);
const phys = sphere?.GetComponentByClass(UPrimitiveComponent);

if (phys) {
    phys.AddImpulse(direction.Scale(36000));
}`,
    right: `spawnLiteCubeStorm({ count: 100, halfExtent: 0.2, spacing: 0.55 })
`,
};
const MouseActionFunction = Object.getPrototypeOf(async function () {}).constructor;
const ObjectEventFunction = MouseActionFunction;
const mouseActionState = {
    leftSource: DEFAULT_MOUSE_ACTION_SCRIPTS.left,
    rightSource: DEFAULT_MOUSE_ACTION_SCRIPTS.right,
    leftCompiled: null,
    rightCompiled: null,
    leftError: '',
    rightError: '',
    selectedButton: 'left',
};
const objectScriptState = {
    nextPropId: 1,
    drafts: {},
    menuOpen: false,
    editorOpen: false,
    menuScreenX: 0,
    menuScreenY: 0,
    targetPropId: '',
    targetObjectUuid: '',
    targetEvent: 'tick',
};
const debugConsoleState = {
    visible: false,
    lines: [
        { prefix: 'sys', text: 'Console ready. Try `stat unit`, `stat physics`, or `stat gpu`.', tone: 'success' },
    ],
    history: [],
    historyIndex: -1,
    panels: new Set(),
    panelRefs: new Map(),
    latest: {
        frame: 0,
        update: 0,
        physics: 0,
        physicsStep: 0,
        physicsSync: 0,
        physicsCollisions: 0,
        scripts: 0,
        gpu: 0,
        render: 0,
        ddgi: 0,
        systems: null,
        fps: 0,
        delta: 0,
        collisionSteps: 0,
    },
    samples: {
        frame: [],
        update: [],
        physics: [],
        physicsStep: [],
        physicsSync: [],
        physicsCollisions: [],
        scripts: [],
        gpu: [],
        render: [],
        ddgi: [],
    },
    gpuTimingMode: 'approximate',
};
const multiplayerState = {
    defaultRoom: 'sandbox',
};

const frameTimer = new THREE.Timer();
if (typeof document !== 'undefined') {
    frameTimer.connect(document);
}
const downVector = new THREE.Vector3(0, -1, 0);
const upVector = new THREE.Vector3(0, 1, 0);
const gameplayBounds = new THREE.Box3();
const gameplayLookTarget = new THREE.Vector3(0, 1, 0);
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const tempVectorA = new THREE.Vector3();
const tempVectorB = new THREE.Vector3();
const tempVectorC = new THREE.Vector3();
const tempVectorD = new THREE.Vector3();
const tempVectorE = new THREE.Vector3();
const tempVectorF = new THREE.Vector3();
// Shared module-scope scratch for per-frame prefab queries. Passed as the
// `out` arg to getGameplayPrefabActors by hot callers to avoid per-frame
// array allocation. Each caller MUST consume the buffer synchronously before
// another caller reuses the same one. (Owned here, not in actorSpawn.js,
// because the callers live across runtime.js.)
const _scratchPrefab1 = [];
const _scratchPrefab2 = [];
const _emptyArray = Object.freeze([]);
const mainDirectionalLightOffset = new THREE.Vector3(5, 10, 5);
const mainDirectionalLightShadowFocus = new THREE.Vector3();
const MAIN_SHADOW_EXTENT = 72;
const MAIN_SHADOW_FAR = 220;
const tempBoxA = new THREE.Box3();
const tempQuaternionA = new THREE.Quaternion();
const tempQuaternionB = new THREE.Quaternion();
const raycastDebugState = {
    enabled: false,
    helper: null,
    hitMarker: null,
    points: [new THREE.Vector3(), new THREE.Vector3()],
    expiresAt: 0,
    lastConsoleHitKey: '',
    timeoutMs: Number.POSITIVE_INFINITY,
};
const collisionDebugState = {
    enabled: false,
    overlays: [],
};
const actorPhysicsEditorState = {
    previewActorId: '',
    previewOverlay: null,
};
const shadowDebugState = {
    forceAllMeshes: false,
    lastAppliedAt: 0,
    lastMeshCount: 0,
    lastUpdatedCount: 0,
    lastLightCount: 0,
    autoApplyIntervalMs: 500,
};
const gameplay = {
    canPlay: true,
    active: false,
    pointerLocked: false,
    grounded: false,
    yaw: 0,
    pitch: -0.1,
    recoilPitch: 0,
    recoilYaw: 0,
    health: 1,
    spawnYaw: 0,
    spawnPitch: -0.1,
    velocity: new THREE.Vector3(),
    spawnPoint: new THREE.Vector3(0, PLAYER_SETTINGS.eyeHeight + 0.2, 6),
    dead: false,
    respawnTimer: null,
    lastDamageAt: 0,
    hitFeedback: {
        overlay: null,
        flash: 0,
        shake: 0,
    },
    weapon: {
        type: '',
        mesh: null,
        nextShotAt: 0,
        sourceActorId: '',
    },
    input: {
        forward: false,
        back: false,
        left: false,
        right: false,
        sprint: false,
        fire: false,
        firePressed: false,
        reloadPressed: false,
        lift: false,
        descend: false,
    },
    activeVehicleId: '',
    inputPressedThisFrame: [],
    inputReleasedThisFrame: [],
};
const gameplayPrefabState = {
    teleporterCooldownUntil: 0,
    shooterProjectiles: [],
    effects: [],
};
const BASIC_NAVMESH_AI_PREFAB = {
    radius: 3.2,
    speed: 0.85,
    agentScale: 0.42,
};
const SHOOTER_AI_PREFAB = {
    range: 28,
    cooldownMs: 1100,
    projectileSpeed: 17,
    projectileLife: 2.2,
    damage: 0.16,
    hitRadius: 1.25,
    playerDamageCooldownMs: 450,
    muzzleHeight: 0.78,
    aimWarningMs: 420,
    scale: 0.52,
    health: 1,
    hitDamage: 0.24,
    hitCooldownMs: 280,
    hitSpeedThreshold: 1.4,
    scoreValue: 50,
    strafeSpeed: 1.6,
    coverHealthThreshold: 0.45,
    projectilePoolSize: 5,
};
const HEALTH_PICKUP_PREFAB = {
    healValue: 0.35,
    respawnMs: 10000,
};
const SHOOTER_SPAWNER_PREFAB = {
    cooldownMs: 6500,
    firstWaveDelayMs: 1200,
    maxAlive: 5,
    spawnRadius: 4.2,
};
const STRAIGHT_GUN_PREFAB = {
    cooldownMs: 130,
    projectileSpeed: 84,
    projectileLife: 1.45,
    damage: 0.08,
    hitRadius: 0.42,
    barrelHeight: 0.58,
    muzzleOffset: 1.18,
    bulletPoolSize: 20,
};
const SNIPER_RIFLE_PREFAB = {
    cooldownMs: 950,
    projectileSpeed: 150,
    projectileLife: 2.2,
    damage: SHOOTER_AI_PREFAB.health,
    hitRadius: 0.28,
    bulletPoolSize: 20,
};
const DOOM_SHOTGUN_PREFAB = {
    cooldownMs: 760,
    projectileSpeed: 82,
    projectileLife: 1.05,
    damage: 0.2,
    hitRadius: 0.5,
    pellets: 7,
    spread: 0.075,
    bulletPoolSize: 40,
    flashMs: 85,
};
// Bouncing throwing star: slower + shorter range than bullets, but ricochets
// off walls (and arcs slightly under gravity) so it can hit around cover.
const THROWING_STAR_PREFAB = {
    cooldownMs: 900,       // slower fire rate
    projectileSpeed: 58,   // fast -> travels far across the arena
    projectileLife: 1.0,   // despawns 2s after the throw
    damage: 0.26,
    hitRadius: 0.6,
    bounces: 1,            // wall ricochets before it dies
    gravity: 0.2,            // no drop -> straight line, bounces flat off walls
    bounceDamping: 0.88,   // keeps almost all speed per bounce
    bulletPoolSize: 32,
};
const DOOM_SHOTGUN_PELLET_PATTERN = [
    [0, 0],
    [-0.65, -0.2],
    [0.65, -0.18],
    [-0.35, 0.42],
    [0.38, 0.38],
    [-0.95, 0.16],
    [0.92, 0.12],
];
const DOOM_ENEMY_PREFAB = {
    health: SHOOTER_AI_PREFAB.health * 0.12,
};
const soccerGoalieState = {
    elapsed: 0,
};
const vehicleState = {
    activePropId: '',
    brakeHeld: false,
    tailWhipLastFrame: false,
};
const vehicleFx = createVehicleFx({
    getScene: () => scene,
    vehicleSettings: VEHICLE_SETTINGS,
});
const emitVehicleParticle = vehicleFx.emitParticle;
const emitVehicleSurfaceEffects = vehicleFx.emitSurfaceEffects;
const updateVehicleSurfaceEffects = vehicleFx.updateSurfaceEffects;
const vehicleEngineAudio = {
    activePropId: '',
    backend: 'none',
    listener: null,
    wasmGenerator: null,
    wasmLoadPromise: null,
    wasmModuleReady: false,
    wasmFailed: false,
    wasmFailureReason: '',
    wasmThrottleParam: null,
    wasmRpmParam: null,
    combustionNode: null,
    harmonic2Node: null,
    harmonic3Node: null,
    bodyNode: null,
    subNode: null,
    whineNode: null,
    noiseNode: null,
    crackleNode: null,
    idleLfo: null,
    combustionGain: null,
    harmonic2Gain: null,
    harmonic3Gain: null,
    bodyGain: null,
    subGain: null,
    whineGain: null,
    intakeGain: null,
    overrunGain: null,
    crackleGain: null,
    crackleEnvelope: null,
    idleLfoGain: null,
    idleLfoOffset: null,
    outputGain: null,
    compressor: null,
    waveShaper: null,
    exhaustFilter: null,
    resonancePeak: null,
    resonanceFilter: null,
    intakeFilter: null,
    hissFilter: null,
    cabinFilter: null,
    masterTone: null,
    panner: null,
    idleRpm: 540,
    minRpm: 480,
    maxRpm: 4200,
    rpm: 540,
    targetRpm: 540,
    gear: 1,
    throttle: 0,
    lastThrottle: 0,
    overrun: 0,
    lastGrounded: false,
    crackleCooldown: 0,
    lastWorldPosition: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
};
const showcase = {
    looking: false,
    yaw: 0,
    pitch: -0.1,
    moveSpeed: 9,
    minMoveSpeed: 2,
    maxMoveSpeed: 48,
    wheelSpeedStep: 1.18,
    boostMultiplier: 2.4,
    velocity: new THREE.Vector3(),
    input: {
        forward: false,
        back: false,
        left: false,
        right: false,
        up: false,
        down: false,
        boost: false,
    },
};
const terrainBrushState = {
    enabled: false,
    active: false,
    tool: 'raise',
    radius: 5,
    strength: 0.18,
    flattenHeight: 0,
    paintColor: '#5f8f35',
    foliageDensity: 80,
    foliageType: 'grass',
    helper: null,
    helperScale: 1,
    dirtyPhysics: false,
    targetObject: null,
};
const physics = {
    ready: false,
    failed: false,
    Jolt: null,
    jolt: null,
    physicsSystem: null,
    bodyInterface: null,
    gravity: null,
    movingBroadPhaseFilter: null,
    movingLayerFilter: null,
    bodyFilter: null,
    shapeFilter: null,
    updateSettings: null,
    characterShape: null,
    character: null,
    characterListener: null,
    terrainBody: null,
    modelBody: null,
    dynamicBodies: [],
    staticBodies: [],
    desiredVelocity: new THREE.Vector3(),
    jumpQueued: false,
    allowSliding: false,
};
const dynamicBodySpatial = createDynamicBodySpatialIndex({
    physics,
    cellSize: DYNAMIC_SPATIAL_CELL_SIZE,
    getActorRenderObject,
});
const dynamicCollisionEvents = createDynamicCollisionEventRunner({
    physics,
    gameplay,
    spatialIndex: dynamicBodySpatial,
    hasEnabledDynamicPropEvent,
    getActorScriptState,
    getPhysicsBodyComponent,
    getActorRenderObject,
    getActorBody,
    copyJoltVector,
    runObjectEventScript,
});
const runtimeAudio = {
    listener: null,
    loader: new THREE.AudioLoader(),
    unlocked: false,
    testBuffer: null,
    mediaTestUrl: null,
    transientAnchors: new Set(),
    resume() {
        const context = this.listener?.context ?? null;
        if (!context || context.state === 'running') {
            this.unlocked = !!context;
            return Promise.resolve();
        }

        return context.resume()
            .then(() => {
                this.unlocked = true;
            })
            .catch((error) => {
                console.warn('Failed to resume audio context.', error);
            });
    },
};


// === extracted: vehicleEngineAudio (functions) (was lines 673-1766 of original main.js) ===

physicsCore = createPhysicsCore({
    physics,
    playerSettings: PLAYER_SETTINGS,
    objectLayerCount: JOLT_OBJECT_LAYER_COUNT,
    broadPhaseLayerCount: JOLT_BROAD_PHASE_LAYER_COUNT,
    nonMovingLayer: JOLT_NON_MOVING_LAYER,
    movingLayer: JOLT_MOVING_LAYER,
    getTerrainRoot: () => worldFloor,
    getModelRoot: () => currentMesh,
    onCharacterRefresh: () => ensurePlayerCharacter(),
});
physicsRuntime = createPhysicsRuntime({
    physics,
    gameplay,
    playerSettings: PLAYER_SETTINGS,
    collisionSteps: PHYSICS_COLLISION_STEPS,
    getCamera: () => camera,
    getWorldFloor: () => worldFloor,
    copyJoltVector,
    copyJoltQuaternion,
    createOwnedShape: (settings) => createOwnedShape(settings),
    onRemoveDynamicProp: (prop, index) => {
        destroyDynamicPhysicsProp(prop);
        physics.dynamicBodies.splice(index, 1);
        dynamicBodySpatial.remove(prop);
    },
    onDynamicBodiesSynced: () => dynamicBodySpatial.refresh(),
    onCollisionScriptsUpdate: () => dynamicCollisionEvents.update(),
    onCollisionStepsChange: (collisionSteps) => {
        debugConsoleState.latest.collisionSteps = collisionSteps;
    },
});

function switchEnvironment(key) {
    return environmentController?.switchEnvironment(key);
}

function setResolution(res) {
    return environmentController?.setResolution(res);
}

function scheduleGpuRenderTimingResolve() {
    // Always drain the timestamp query pool when trackTimestamp is on.
    // Previously this was gated on the GPU debug panel being open, which left
    // queries to accumulate until three.js's pool overflowed and spammed
    // "Maximum number of queries exceeded" every frame. The resolve is cheap
    // (one async copy) and we just ignore the result when the panel is closed.
    if (!renderer?.backend?.trackTimestamp || gpuTimestampResolvePending) return;

    gpuTimestampResolvePending = renderer.resolveTimestampsAsync?.('render')
        ?.then((duration) => {
            if (!Number.isFinite(duration) || duration < 0) return;
            latestGpuRenderMs = duration;
            debugConsoleState.gpuTimingMode = 'gpu';
        })
        .catch(() => {
            debugConsoleState.gpuTimingMode = 'approximate';
        })
        .finally(() => {
            gpuTimestampResolvePending = null;
        }) ?? null;
}

function sampleTerrainHeightAt(worldX, worldZ) {
    return sampleTerrainHeightAtWorldFloor(worldFloor, worldX, worldZ);
}

function buildLightGrid() {
    //lightGridController?.build();
}

function getLightGridAnchorTarget() {
    if (currentMesh) {
        return tempVectorD.copy(gameplayLookTarget);
    }

    return tempVectorD.copy(SHOWCASE_CAMERA_TARGET);
}

function positionLightGrid(anchorTarget) {
    lightGridController?.position(anchorTarget);
}

function handleLightGridClick(event) {
    if (isTransformControlSphereHit(event)) {
        return;
    }

    lightGridController?.handleClick(event);
}

function serializeVector3(vector) {
    return { x: vector.x, y: vector.y, z: vector.z };
}

function serializeQuaternion(quaternion) {
    return { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w };
}

function getDefaultMultiplayerServerUrl() {
    const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    return isLocalHost ? `${window.location.protocol}//${window.location.hostname}:3001` : '';
}

function updateMultiplayerUiState({ statusText, playerCount, connected }) {
    if (multiplayerStatusValue) {
        multiplayerStatusValue.textContent = statusText || 'Offline';
    }

    if (multiplayerPlayerCountValue) {
        multiplayerPlayerCountValue.textContent = `${playerCount || 1} ${playerCount === 1 ? 'player' : 'players'}`;
    }

    if (multiplayerConnectBtn) {
        multiplayerConnectBtn.disabled = !!connected;
    }

    if (multiplayerDisconnectBtn) {
        multiplayerDisconnectBtn.disabled = !connected;
    }
}

// Reused Euler for getLocalMultiplayerSnapshot to avoid per-frame allocation.
const _snapshotEuler = new THREE.Euler(0, 0, 0, 'YXZ');
function getLocalMultiplayerSnapshot() {
    if (!camera) return null;

    let localPosition;
    let yaw;

    if (gameplay.active && physics.character) {
        localPosition = copyJoltVector(tempVectorA, physics.character.GetPosition());
        yaw = gameplay.yaw;
    } else {
        localPosition = tempVectorA.copy(camera.position);
        localPosition.y -= 1.05;
        yaw = showcase.yaw;
    }

    _snapshotEuler.set(0, yaw, 0, 'YXZ');
    const localRotation = tempQuaternionB.setFromEuler(_snapshotEuler);
    // Snapshot fields are read into plain {x,y,z[,w]} objects immediately, so
    // we can overwrite tempVectorA / tempQuaternionA inside the vehicle branch
    // without losing the player's serialized values.
    const positionSerialized = serializeVector3(localPosition);
    const quaternionSerialized = serializeQuaternion(localRotation);
    let vehicleStateSnapshot = { active: false };

    if (gameplay.active && isDrivingVehicle()) {
        const vehicle = getActiveVehicleProp();
        if (vehicle?.body && physics.bodyInterface) {
            const bodyId = vehicle.body.GetID();
            const vehiclePosition = copyJoltVector(tempVectorA, physics.bodyInterface.GetPosition(bodyId));
            const vehicleRotation = copyJoltQuaternion(tempQuaternionA, physics.bodyInterface.GetRotation(bodyId));
            vehicleStateSnapshot = {
                active: true,
                id: vehicle.id || '',
                position: serializeVector3(vehiclePosition),
                quaternion: serializeQuaternion(vehicleRotation),
            };
        }
    }

    return {
        mode: vehicleStateSnapshot.active ? 'vehicle' : gameplay.active ? 'player' : 'showcase',
        position: positionSerialized,
        quaternion: quaternionSerialized,
        vehicle: vehicleStateSnapshot,
    };
}

function copyJoltVector(target, source) {
    target.set(source.GetX(), source.GetY(), source.GetZ());
    return target;
}

function copyJoltQuaternion(target, source) {
    target.set(source.GetX(), source.GetY(), source.GetZ(), source.GetW());
    return target;
}

function createOwnedShape(settings) {
    return physicsCore?.createOwnedShape(settings) ?? null;
}

const _importedProps = createImportedPropsSystem({
    THREE,
    physics: () => physics,
    physicsCore: () => physicsCore,
    scene: () => scene,
    camera: () => camera,
    getDomElements: () => ({
        propCollisionPrompt, propCollisionCopy, propCollisionRemember,
        propImportDefaultStatus, resetPropImportDefaultBtn,
        importedPropList, importedPropLibrary,
    }),
    importedPropState, listImportedTemplates, getImportedTemplate,
    assetRegistry,
    dynamicBodySpatial,
    getDynamicPropSpawn: (...args) => getDynamicPropSpawn(...args),
    openActorEditor: (...args) => openActorEditor(...args),
    syncActorEditorTemplateOptions: (...args) => syncActorEditorTemplateOptions(...args),
    createStaticMeshBody: (...args) => createStaticMeshBody(...args),
    createDynamicPrimitiveBody: (...args) => createDynamicPrimitiveBody(...args),
    createDynamicPropActor, setActorComponentFlags,
    cloneDisposableObject, disposeRenderableObject,
    countTrianglesForObject: (...args) => countTrianglesForObject(...args),
    formatImportedPropName,
    normalizeObjectToDimension, loadObjectFromFile,
    convertLoadedObjectMaterials,
    PROP_TARGET_MAX_DIMENSION,
    IMPORTED_PROP_COLLISION_LABELS,
    IMPORTED_PROP_MAX_HULL_POINTS,
    IMPORTED_PROP_MAX_HULL_PARTS,
    IMPORTED_PROP_COMPLEX_HULL_RADIUS,
    tempVectorA, tempVectorB, tempVectorC, tempVectorD, tempVectorE,
    playObjectAnimation,
    invalidateDDGI: (...args) => invalidateDDGI(...args),
});
const updatePropImportStatus = _importedProps.updatePropImportStatus;
const closePropCollisionPrompt = _importedProps.closePropCollisionPrompt;
const resolvePropCollisionPrompt = _importedProps.resolvePropCollisionPrompt;
const promptImportedPropCollision = _importedProps.promptImportedPropCollision;
const createImportedSimpleShape = _importedProps.createImportedSimpleShape;
const createExactMeshShape = _importedProps.createExactMeshShape;
const createImportedConvexHullShape = _importedProps.createImportedConvexHullShape;
const collectImportedComplexHullParts = _importedProps.collectImportedComplexHullParts;
const createImportedComplexShape = _importedProps.createImportedComplexShape;
const createImportedCollisionShape = _importedProps.createImportedCollisionShape;
const renderImportedPropButtons = _importedProps.renderImportedPropButtons;
const registerImportedPropTemplate = _importedProps.registerImportedPropTemplate;
const registerImportedPropTemplateFromSerializedData = _importedProps.registerImportedPropTemplateFromSerializedData;
const lookupBundleAsset = _importedProps.lookupBundleAsset;
const serializeImportedPropTemplate = _importedProps.serializeImportedPropTemplate;
const spawnImportedProp = _importedProps.spawnImportedProp;
const importPhysicsProp = _importedProps.importPhysicsProp;

async function initPhysics() {
    return physicsCore?.initPhysics();
}

function countTrianglesForObject(root) {
    return physicsCore?.countTrianglesForObject(root) ?? 0;
}

function createStaticMeshBody(root, options = {}) {
    return physicsCore?.createStaticMeshBody(root, options) ?? null;
}

function destroyPhysicsBody(body) {
    physicsCore?.destroyPhysicsBody(body);
}

function destroyDynamicPhysicsProp(prop) {
    if (!prop) return;

    dynamicBodySpatial.remove(prop);

    if (prop.id && vehicleEngineAudio.activePropId === prop.id) {
        shutdownVehicleEngineAudio();
    }

    if (vehicleState.activePropId && vehicleState.activePropId === prop.id) {
        vehicleState.activePropId = '';
        gameplay.activeVehicleId = '';
        vehicleState.brakeHeld = false;
    }

    if (objectScriptState.targetPropId && objectScriptState.targetPropId === prop.id) {
        objectScriptState.targetPropId = '';
        transformControl?.detach();
        objectScriptState.menuOpen = false;
        objectScriptState.editorOpen = false;
    }

    prop.destroyAllComponents?.();

    sceneSystem?.removeActor(prop);

    const mesh = getActorRenderObject(prop);
    if (mesh) {
        mesh.parent?.remove?.(mesh);
        disposeRenderableObject(mesh);

        prop.mesh = null;
    }

    const body = getActorBody(prop);
    if (body) {
        physicsCore?.unregisterBackFaceCulledBody?.(body);
        destroyPhysicsBody(body);
        prop.body = null;
    }

    removeObjectScriptDraft(prop.id);
}

function clearDynamicPhysicsProps() {
    if (!physics.dynamicBodies.length && !physics.staticBodies.length) return;

    physics.dynamicBodies.forEach((prop) => destroyDynamicPhysicsProp(prop));
    physics.staticBodies.forEach((prop) => destroyDynamicPhysicsProp(prop));
    physics.dynamicBodies.length = 0;
    physics.staticBodies.length = 0;
    dynamicBodySpatial.clear();
}

function hasEnabledDynamicPropEvent(eventType) {
    for (let index = 0; index < physics.dynamicBodies.length; index++) {
        const eventState = getActorScriptState(physics.dynamicBodies[index])?.[eventType];
        if (eventState?.enabled) {
            return true;
        }
    }

    return false;
}

function getDynamicPropSpawn(positionTarget, impulseTarget) {
    const spawnOrigin = gameplay.active && physics.character
        ? copyJoltVector(tempVectorC, physics.character.GetPosition()).addScaledVector(upVector, PLAYER_SETTINGS.eyeHeight * 0.55)
        : tempVectorC.copy(camera.position);

    camera.getWorldDirection(tempVectorA);
    if (Math.abs(tempVectorA.y) > 0.72) {
        tempVectorA.y *= 0.35;
    }

    if (tempVectorA.lengthSq() < 1e-6) {
        tempVectorA.set(0, 0, -1);
    } else {
        tempVectorA.normalize();
    }

    positionTarget
        .copy(spawnOrigin)
        .addScaledVector(tempVectorA, gameplay.active ? 2.5 : 4.2)
        .addScaledVector(upVector, gameplay.active ? 1.5 : 2.2);

    impulseTarget
        .copy(tempVectorA)
        .multiplyScalar(18)
        .addScaledVector(upVector, 5.5);
}

const _vehicleSystem = createVehicleSystem({
    THREE,
    camera: () => camera,
    currentMesh: () => currentMesh,
    physics, dynamicBodySpatial,
    gameplay, gameplayLookTarget, vehicleState,
    VEHICLE_SETTINGS, PLAYER_SETTINGS,
    raycaster, upVector,
    tempVectorA, tempVectorB, tempVectorC, tempVectorD, tempVectorE,
    tempQuaternionA,
    copyJoltVector, copyJoltQuaternion,
    getActorBody: (...a) => getActorBody(...a),
    getActorRenderObject: (...a) => getActorRenderObject(...a),
    silenceVehicleEngineAudio,
    updateGameplayUI: (...a) => updateGameplayUI(...a),
    dispatchPossessionEvent,
    getGroundHitAt: (...a) => getGroundHitAt(...a),
    respawnPlayer: (...a) => respawnPlayer(...a),
    syncCameraToCharacter: (...a) => syncCameraToCharacter(...a),
    applyGameplayCameraRotation: (...a) => applyGameplayCameraRotation(...a),
    createOwnedShape,
});
const isDrivingVehicle = _vehicleSystem.isDrivingVehicle;
const getActiveVehicleProp = _vehicleSystem.getActiveVehicleProp;
const clearActiveVehicle = _vehicleSystem.clearActiveVehicle;
const getVehicleForward = _vehicleSystem.getVehicleForward;
const resolveVehicleCameraCollision = _vehicleSystem.resolveVehicleCameraCollision;
const positionVehicleCamera = _vehicleSystem.positionVehicleCamera;
const getNearbyVehicle = _vehicleSystem.getNearbyVehicle;
const enterVehicle = _vehicleSystem.enterVehicle;
const exitVehicle = _vehicleSystem.exitVehicle;
const ensureVehicleVisualState = _vehicleSystem.ensureVehicleVisualState;
const updateVehicleVisuals = _vehicleSystem.updateVehicleVisuals;
const getVehicleVisualBounds = _vehicleSystem.getVehicleVisualBounds;
const createVehicleCollisionShapeFromBounds = _vehicleSystem.createVehicleCollisionShapeFromBounds;

// Actor spawn primitives extracted to ../actors/actorSpawn.js.
// Instantiated eagerly at module scope (heavy cross-module use, called
// from init before wireExtractedModules). Reads scene/camera/sceneSystem/
// physicsCore via the appCore keystone; rest injected here.
const _actorSpawn = createActorSpawn({
    JOLT_MOVING_LAYER, JOLT_NON_MOVING_LAYER, PLAYER_SETTINGS,
    VEHICLE_SETTINGS, dynamicBodySpatial, gameplay, importedPropState,
    objectScriptState, physics, tempQuaternionA, tempVectorA, tempVectorD,
    tempVectorE, upVector,
    // buildPrimitiveActorMesh is `const` defined later (line ~3240); wrap in
    // a lazy thunk so the binding is read at call time, not now.
    buildPrimitiveActorMesh: (...a) => buildPrimitiveActorMesh(...a),
    createOwnedShape,
    createVehicleCollisionShapeFromBounds, ensureActorIdentity,
    getActorRenderObject, getDynamicPropSpawn,
    // getGroundHeightAt/getGroundHitAt are now const aliases bound later in
    // the file (extracted to vehiclePhysics). actorSpawn is instantiated
    // eagerly above their declaration, so pass lazy wrappers to defer the
    // binding lookup to call-time (avoids TDZ).
    getGroundHeightAt: (...a) => getGroundHeightAt(...a),
    getGroundHitAt: (...a) => getGroundHitAt(...a),
    getVehicleVisualBounds, invalidateDDGI,
    markDDGISkipCapture, updateGameplayUI,
    cloneDisposableObject, createDynamicPropActor, ensureScriptHandles,
    getDynamicPropById, setActorColor, setActorComponentFlags,
    syncPropScriptState,
});
const spawnDrivableCar = _actorSpawn.spawnDrivableCar;
const createDynamicPrimitiveBody = _actorSpawn.createDynamicPrimitiveBody;
const spawnDynamicPrimitive = _actorSpawn.spawnDynamicPrimitive;
const attachDefaultPrefabScript = _actorSpawn.attachDefaultPrefabScript;
const ensureGameplayPrefabScript = _actorSpawn.ensureGameplayPrefabScript;
const tagGameplayPrefabActor = _actorSpawn.tagGameplayPrefabActor;
const tintGameplayPrefabActor = _actorSpawn.tintGameplayPrefabActor;
const getSoccerGoalieActors = _actorSpawn.getSoccerGoalieActors;
const applyPlayerSpawnFromActor = _actorSpawn.applyPlayerSpawnFromActor;
const getGameplayPrefabActors = _actorSpawn.getGameplayPrefabActors;
const getShooterSpawnPointActor = _actorSpawn.getShooterSpawnPointActor;
const getShooterGroundIgnoreActors = _actorSpawn.getShooterGroundIgnoreActors;

function syncGameplaySpawnFromPlayerSpawnActor() {
    return applyPlayerSpawnFromActor(getGameplayPrefabActors('playerSpawn')[0]);
}

// Player combat (health, hit feedback, hurt sound, death respawn) extracted
// to ../gameplay/playerCombat.js. Lazy getters for camera/currentMesh/
// showDamageIndicator/respawnPlayer/resetMovementInputState because they are
// declared further down in this file (TDZ avoidance at module load).
const _playerCombat = createPlayerCombat({
    gameplay,
    physics,
    SHOOTER_AI_PREFAB,
    getCamera: () => camera,
    getCurrentMesh: () => currentMesh,
    getWidgetManager: () => widgetManager,
    getRuntimeAudio: () => runtimeAudio,
    showDamageIndicator: (...a) => showDamageIndicator(...a),
    isDrivingVehicle,
    clearActiveVehicle,
    resetMovementInputState: (...a) => resetMovementInputState(...a),
    respawnPlayer: (...a) => respawnPlayer(...a),
    bus: eventBus,
});
const setPlayerHealth = _playerCombat.setPlayerHealth;
const damagePlayer = _playerCombat.damagePlayer;
const ensurePlayerHitOverlay = _playerCombat.ensurePlayerHitOverlay;
const triggerPlayerHitFeedback = _playerCombat.triggerPlayerHitFeedback;
const playPlayerHitSound = _playerCombat.playPlayerHitSound;
const updatePlayerHitFeedback = _playerCombat.updatePlayerHitFeedback;
const queuePlayerDeathRespawn = _playerCombat.queuePlayerDeathRespawn;
if (typeof window !== 'undefined') {
    queueMicrotask(() => { window.setPlayerHealth = setPlayerHealth; });
}

// 'player:damaged' subscribers — each runs independently. Order doesn't
// matter (no inter-handler reads). Hit feedback (flash + shake + sound)
// runs first because the user expects the visceral cue before the
// directional indicator. Direction indicator only when sourcePos known.
// User scripts can install window.onPlayerDamaged to override the engine
// indicator entirely (legacy hook preserved).
eventBus.on('player:damaged', () => {
    triggerPlayerHitFeedback();
});
eventBus.on('player:damaged', ({ amount, damageAngle }) => {
    if (damageAngle == null) return;
    if (typeof window !== 'undefined' && window.onPlayerDamaged) {
        try { window.onPlayerDamaged(damageAngle, amount); } catch (e) { /* script error */ }
    } else {
        showDamageIndicator(damageAngle);
    }
});

function getPointSegmentDistanceSq(point, start, end) {
    tempVectorD.subVectors(end, start);
    const lengthSq = tempVectorD.lengthSq();
    if (lengthSq <= 1e-8) return point.distanceToSquared(start);

    const t = THREE.MathUtils.clamp(tempVectorE.subVectors(point, start).dot(tempVectorD) / lengthSq, 0, 1);
    tempVectorD.copy(start).lerp(end, t);
    return point.distanceToSquared(tempVectorD);
}

function getShooterTargetPosition(target = new THREE.Vector3()) {
    if (isDrivingVehicle()) {
        const subjectPosition = getGameplaySubjectPosition(target);
        if (!subjectPosition) return null;
        subjectPosition.y += 0.9;
        return subjectPosition;
    }

    if (camera) return target.copy(camera.position);

    const subjectPosition = getGameplaySubjectPosition(target);
    if (!subjectPosition) return null;
    subjectPosition.y += PLAYER_SETTINGS.eyeHeight;
    return subjectPosition;
}

// FX pool lifecycle extracted to ../gameplay/effectsSystem.js
const _effectsSystem = createEffectsSystem({ gameplayPrefabState });
const updateGameplayEffects = _effectsSystem.updateGameplayEffects;
const clearGameplayEffects = _effectsSystem.clearGameplayEffects;

// Projectile spawn/clear extracted to ../gameplay/projectileSystem.js.
// Instancer is lazily created on first spawn (scene must exist by then).
const _projectileSystem = createProjectileSystem({
    getScene: () => scene,
    gameplayPrefabState,
    SHOOTER_AI_PREFAB,
});
const getProjectileInstancer = _projectileSystem.getProjectileInstancer;
const acquireProjectileMesh = _projectileSystem.acquireProjectileMesh;
const releaseProjectile = _projectileSystem.releaseProjectile;
const spawnShooterProjectile = _projectileSystem.spawnShooterProjectile;
const clearShooterProjectiles = _projectileSystem.clearShooterProjectiles;

// Teleporter system: shared-state pair-swap + drag-along + cooldown gate.
// Extracted from processGameplayPrefabs. Lazy wrappers for the symbols
// declared further down in this file (hasScriptedTriggerHandler, etc) so
// the factory call happens at module load without TDZ.
const _teleporterSystem = createTeleporterSystem({
    gameplay,
    gameplayPrefabState,
    getGameplayPrefabActors: (...a) => getGameplayPrefabActors(...a),
    getActorRenderObject: (...a) => getActorRenderObject(...a),
    getSceneActors: () => sceneSystem?.actors ?? [],
    hasScriptedTriggerHandler: (...a) => hasScriptedTriggerHandler(...a),
    dispatchTriggerForActor: (...a) => dispatchTriggerForActor(...a),
    isSubjectInsideTrigger: (...a) => isSubjectInsideTrigger(...a),
    teleportActiveGameplaySubject: (...a) => teleportActiveGameplaySubject(...a),
    teleportActorTo: (...a) => teleportActorTo(...a),
    _scratchPrefab1,
});
const processTeleporters = _teleporterSystem.processTeleporters;

// Shooter-AI per-frame logic extracted to ../gameplay/shooterAi.js.
// Eager wiring (deps are hoisted fns or earlier const aliases; pub fns
// called only at runtime by updateShooterAis from frame loop). No appCore
// refs needed — pure logic over injected state.
const _shooterAi = createShooterAi({
    SHOOTER_AI_PREFAB, _scratchPrefab1, _scratchPrefab2,
    gameplay, gameplayPrefabState, physics,
    tempBoxA, tempVectorA, tempVectorB, tempVectorC, tempVectorD, tempVectorE,
    // combatFx aliases are `const` defined further down (line ~3446); pass
    // lazy wrappers to defer the binding lookup to call-time and avoid TDZ
    // at this eager wiring site.
    playImpactSound: (...a) => playImpactSound(...a),
    spawnImpactBurst: (...a) => spawnImpactBurst(...a),
    spawnImpactDecal: (...a) => spawnImpactDecal(...a),
    copyJoltVector, getPointSegmentDistanceSq,
    // shooterAiVisuals aliases are `const` defined further down (line ~2222);
    // wrap in lazy thunks so their bindings are looked up at call time.
    getShooterHitPoints: (...a) => getShooterHitPoints(...a),
    damageShooterAi: (...a) => damageShooterAi(...a),
    setShooterHealth: (...a) => setShooterHealth(...a),
    hideShooterAimWarning: (...a) => hideShooterAimWarning(...a),
    updateShooterAimWarning: (...a) => updateShooterAimWarning(...a),
    ensureShooterHealthBar: (...a) => ensureShooterHealthBar(...a),
    releaseProjectile,
    damagePlayer, getActorBody, getActorRenderObject,
    getGameplayPrefabActors,
    queryDynamicBodies: (...a) => dynamicBodySpatial.querySphere(...a),
    // hoisted-function deps (safe by-ref even though textually after site):
    ensureGameplayPrefabScript,
    getShooterGroundIgnoreActors, getShooterTargetPosition,
    isDoomRoofSurfaceHit, raycastWorld,
    runObjectEventScript, spawnShooterProjectile,
    // lazy wrappers for `const` aliases / `let` placeholders defined later
    // (TDZ avoidance, same pattern as the combatFx aliases above):
    getGroundHeightAt: (...a) => getGroundHeightAt(...a),
    updateDoomEnemySpriteAnimation: (...a) => updateDoomEnemySpriteAnimation(...a),
});
const updateShooterProjectiles = _shooterAi.updateShooterProjectiles;
const updateShooterAiPhysicsHits = _shooterAi.updateShooterAiPhysicsHits;
const clampThrowingStarSpeed = _shooterAi.clampThrowingStarSpeed;
const isShooterLineOfSightClear = _shooterAi.isShooterLineOfSightClear;
const getShooterCoverPoint = _shooterAi.getShooterCoverPoint;
const updateShooterMovement = _shooterAi.updateShooterMovement;
const updateShooterAiActor = _shooterAi.updateShooterAiActor;
const updateShooterAis = _shooterAi.updateShooterAis;

const _shooterAiPoolScratch = [];

function getShooterAiPoolKey(options = {}) {
    if (options.poolKey) return options.poolKey;
    if (options.rogueVariant) return `rogue:${options.rogueVariant}`;
    if (options.doomEnemy) return 'doomEnemy';
    if (options.spawnedBy) return 'spawnedShooterAi';
    return '';
}

function findPooledShooterAi(poolKey) {
    if (!poolKey) return null;
    const actors = getGameplayPrefabActors('shooterAi', _shooterAiPoolScratch);
    for (let i = 0; i < actors.length; i++) {
        const actor = actors[i];
        const shooter = actor?.userData?.shooterAi;
        const mesh = getActorRenderObject(actor);
        if (shooter?.poolable
            && shooter.poolKey === poolKey
            && shooter.defeated
            && mesh
            && mesh.visible === false) {
            return actor;
        }
    }
    return null;
}

function configureShooterAiState(actor, options, health, maxHealth, poolKey) {
    const previous = actor.userData?.shooterAi || {};
    const healthBar = previous.healthBar;
    const aimWarning = previous.aimWarning;
    actor.userData = actor.userData || {};
    actor.userData.label = options.label || 'Shooter AI';
    delete actor.userData.rogueXp;
    actor.userData.shooterAi = {
        healthBar,
        aimWarning,
        range: Number.isFinite(options.range) ? options.range : SHOOTER_AI_PREFAB.range,
        cooldownMs: Number.isFinite(options.cooldownMs) ? options.cooldownMs : SHOOTER_AI_PREFAB.cooldownMs,
        speedMul: Number.isFinite(options.speedMul) ? options.speedMul : 1,
        nextShotAt: 0,
        windupUntil: 0,
        health,
        maxHealth,
        defeated: false,
        spawnedBy: options.spawnedBy || '',
        scoreValue: options.scoreValue ?? SHOOTER_AI_PREFAB.scoreValue,
        rogueVariant: options.rogueVariant || '',
        poolKey,
        poolable: !!poolKey,
    };
}

function spawnShooterAiAt(position, options = {}) {
    if (!position) return null;
    const ignoreGroundActors = [];
    if (options.ignoreGroundActor) ignoreGroundActors.push(options.ignoreGroundActor);
    if (Array.isArray(options.ignoreGroundActors)) ignoreGroundActors.push(...options.ignoreGroundActors);
    const shooterGroundIgnoreActors = getShooterGroundIgnoreActors(null, null, ignoreGroundActors);
    const groundY = Number.isFinite(options.groundY)
        ? options.groundY
        : getGroundHeightAt(position.x, position.z, true, { ignoreActors: shooterGroundIgnoreActors }) ?? position.y;
    const maxHealth = Number.isFinite(options.maxHealth)
        ? options.maxHealth
        : Number.isFinite(options.health)
            ? options.health
            : SHOOTER_AI_PREFAB.health;
    const health = Number.isFinite(options.health) ? options.health : maxHealth;
    const poolKey = getShooterAiPoolKey(options);
    const pooledActor = findPooledShooterAi(poolKey);
    if (pooledActor) {
        configureShooterAiState(pooledActor, options, health, maxHealth, poolKey);
        const mesh = getActorRenderObject(pooledActor);
        mesh.position.set(position.x, groundY + 1.18, position.z);
        mesh.scale.setScalar(SHOOTER_AI_PREFAB.scale);
        mesh.visible = true;
        mesh.updateMatrixWorld(true);
        tagGameplayPrefabActor(pooledActor, 'shooterAi', { triggerRadius: 0.8, groundOffset: 1.18, ignoreGroundActors: shooterGroundIgnoreActors });
        tintGameplayPrefabActor(pooledActor, '#dc2626', '#7f1d1d', 0.9);
        if (!mesh.getObjectByName?.('Shooter Barrel')) addShooterAiVisual(pooledActor);
        resetShooterAiState(pooledActor);
        setShooterHealth(pooledActor, health);
        ensureGameplayPrefabScript(pooledActor, SHOOTER_AI_USER_SCRIPT);
        return pooledActor;
    }
    const actor = spawnDynamicPrimitive('capsule', new THREE.Vector3(position.x, groundY + 1.18, position.z), SHOOTER_AI_PREFAB.scale, {
        local: false,
        includeCollisionBody: false,
        includeScripts: false,
        userData: {
            label: options.label || 'Shooter AI',
            shooterAi: {
                range: Number.isFinite(options.range) ? options.range : SHOOTER_AI_PREFAB.range,
                cooldownMs: Number.isFinite(options.cooldownMs) ? options.cooldownMs : SHOOTER_AI_PREFAB.cooldownMs,
                speedMul: Number.isFinite(options.speedMul) ? options.speedMul : 1,
                nextShotAt: 0,
                health,
                maxHealth,
                defeated: false,
                spawnedBy: options.spawnedBy || '',
                scoreValue: options.scoreValue ?? SHOOTER_AI_PREFAB.scoreValue,
                rogueVariant: options.rogueVariant || '',
                poolKey,
                poolable: !!poolKey,
            },
        },
        returnActor: true,
    });
    tagGameplayPrefabActor(actor, 'shooterAi', { triggerRadius: 0.8, groundOffset: 1.18, ignoreGroundActors: shooterGroundIgnoreActors });
    tintGameplayPrefabActor(actor, '#dc2626', '#7f1d1d', 0.9);
    addShooterAiVisual(actor);
    attachDefaultPrefabScript(actor, SHOOTER_AI_USER_SCRIPT);
    return actor;
}

function spawnDoomEnemyAt(position, options = {}) {
    if (!position) return null;
    const maxHealth = Number.isFinite(options.maxHealth)
        ? options.maxHealth
        : Number.isFinite(options.health)
            ? options.health
            : DOOM_ENEMY_PREFAB.health;
    const actor = spawnShooterAiAt(position, {
        ...options,
        doomEnemy: true,
        label: options.label || 'Doom Enemy',
        health: Number.isFinite(options.health) ? options.health : maxHealth,
        maxHealth,
    });
    if (!actor) return null;
    if (!actor.userData?.doomEnemy?.sprite?.parent) applyDoomEnemySpriteSkin(actor);
    return actor;
}

// Rogue Waves (enemy variants, XP, cards, HUD, death, game mode) was extracted
// to src/gameplay/rogueWaves.js. createRogueWaves() is instantiated in the
// setup block; its API is aliased to the legacy names used by call sites.
let spawnRogueEnemy = () => null;

function isDoomRoofSurfaceHit(hit) {
    let object = hit?.object || null;
    while (object) {
        if (object.userData?.doomMapSurface) {
            return object.userData.doomMapSurface === 'roof';
        }
        object = object.parent || null;
    }
    return false;
}

function setActorWorldPositionExact(actor, position, { visible } = {}) {
    const mesh = getActorRenderObject(actor);
    if (!mesh || !position) return false;
    if (Array.isArray(position)) {
        mesh.position.set(position[0] ?? 0, position[1] ?? 0, position[2] ?? 0);
    } else {
        mesh.position.copy(position);
    }
    if (typeof visible === 'boolean') mesh.visible = visible;
    mesh.updateMatrixWorld(true);
    syncActorBodyToRenderTransform(actor, physics?.Jolt?.EActivation_DontActivate ?? null);
    return true;
}

// Doom mini + soccer level state machines extracted to
// ../gameplay/levelStateSystem.js. Lazy-resolved deps (spawnDoomEnemyAt,
// spawnGameplayPrefab, resetGameplayPrefabs, etc. are hoisted function
// decls later in this file — captured by reference via factory closure).
const _levelStateSystem = createLevelStateSystem({
    DOOM_ENEMY_PREFAB,
    getCurrentMesh: () => currentMesh,
    getActorRenderObject: (a) => getActorRenderObject(a),
    spawnDoomEnemyAt: (...a) => spawnDoomEnemyAt(...a),
    spawnDynamicPrimitive: (...a) => spawnDynamicPrimitive(...a),
    tintGameplayPrefabActor: (...a) => tintGameplayPrefabActor(...a),
    setActorWorldPositionExact: (...a) => setActorWorldPositionExact(...a),
    getGameplayPrefabActors: (...a) => getGameplayPrefabActors(...a),
    hideShooterAimWarning: (...a) => hideShooterAimWarning(...a),
    destroyDynamicPhysicsProp: (...a) => destroyDynamicPhysicsProp(...a),
    getSceneSystem: () => sceneSystem,
    resetGameplayPrefabs: (...a) => resetGameplayPrefabs(...a),
    spawnGameplayPrefab: (...a) => spawnGameplayPrefab(...a),
    applyPlayerSpawnFromActor: (...a) => applyPlayerSpawnFromActor(...a),
    syncGameplaySpawnFromPlayerSpawnActor: (...a) => syncGameplaySpawnFromPlayerSpawnActor(...a),
    resetRogueState: (...a) => resetRogueState(...a),
    clearHeldWeapon: (...a) => clearHeldWeapon(...a),
    resetActorToStoredTransform: (...a) => resetActorToStoredTransform(...a),
    getSoccerGoalieActors: (...a) => getSoccerGoalieActors(...a),
    soccerGoalieState,
});
const isDoomMiniWaveCleared = _levelStateSystem.isDoomMiniWaveCleared;
const spawnDoomMiniWave = _levelStateSystem.spawnDoomMiniWave;
const createDoomMiniBarrierEntries = _levelStateSystem.createDoomMiniBarrierEntries;
const setDoomMiniBarrierActive = _levelStateSystem.setDoomMiniBarrierActive;
const updateDoomMiniLevelState = _levelStateSystem.updateDoomMiniLevelState;

// ===== ROGUE WAVES =====
// Moved to src/gameplay/rogueWaves.js (createRogueWaves factory). The API is
// instantiated in the setup block and aliased to the legacy names below so
// existing call sites + the game-mode script keep working unchanged.
let updateDoomArenaLevelState = () => {};
let updateRogueGameMode = () => {};
let updateRogueXpOrbs = () => {};
let updateDrugTycoonState = () => {};
let updateShootingSimState = () => {};
let resetRogueState = () => {};
let updateRogueXpBar = () => {};
let openRogueWeaponPicker = () => {};
let closeRogueCardPicker = () => {};
let openRogueCardPicker = () => {};
let openRogueDeathScreen = () => {};
let closeRogueDeathScreen = () => {};
let onRogueEnemyKilled = () => {};
let ensureRogueState = () => ({});
let spawnRogueXpOrb = () => {};
let spawnRogueHealthOrb = () => {};
let grantRogueXp = () => {};
let setRogueWaveHud = () => {};
let RogueAPI = null;


// ECS: wave-spawning state for shooter-spawner actors lives on
// ShooterSpawnerComponent. Attach helper handles both fresh-spawn and
// snapshot-restore paths. The legacy `updateShooterSpawnerActor(spawner)`
// surface is kept as a back-compat shim — the prefab user script (see
// SHOOTER_SPAWNER_USER_SCRIPT) calls it via `window.updateShooterSpawnerActor`
// from its own Tick. We delegate to the component's tick() so behavior stays
// identical and the SceneSystem's central pass would also drive it.
const _shooterSpawnerTmp = { v: new THREE.Vector3() };
const _gameplayComponents = createGameplayComponents({
    THREE,
    ShooterSpawnerComponent, WeaponPickupComponent, CoinComponent,
    TargetComponent, HealthPickupComponent,
    SHOOTER_SPAWNER_PREFAB, SHOOTER_AI_PREFAB, HEALTH_PICKUP_PREFAB,
    gameplay, physics, dynamicBodySpatial,
    _scratchPrefab2, _emptyArray,
    // _gameplaySubjectScratch is defined later in the file; pass a getter so
    // the component closures read the bound array at call time, not now.
    _gameplaySubjectScratch: new Proxy({}, {
        get(_, key) { return _gameplaySubjectScratch[key]; },
    }),
    getGameplayPrefabActors,
    getActorRenderObject: (a) => getActorRenderObject(a),
    getActorBody: (a) => getActorBody(a),
    spawnShooterAiAt: (...a) => spawnShooterAiAt(...a),
    // TDZ-late aliases — wrap in arrow thunks.
    equipStraightGun: (...a) => equipStraightGun(...a),
    equipSniperRifle: (...a) => equipSniperRifle(...a),
    equipDoomShotgun: (...a) => equipDoomShotgun(...a),
    playDoomPickupSound: (...a) => playDoomPickupSound?.(...a),
    hasScriptedTriggerHandler: (...a) => hasScriptedTriggerHandler(...a),
    dispatchTriggerForActor: (...a) => dispatchTriggerForActor(...a),
    isSubjectInsideTrigger: (...a) => isSubjectInsideTrigger(...a),
    dispatchTriggerEvent,
    addGameScore: (...a) => addGameScore(...a),
    setPlayerHealth: (...a) => setPlayerHealth(...a),
});
const attachShooterSpawnerComponent = _gameplayComponents.attachShooterSpawnerComponent;
const updateShooterSpawnerActor = _gameplayComponents.updateShooterSpawnerActor;
const attachWeaponPickupComponent = _gameplayComponents.attachWeaponPickupComponent;
const attachCoinComponent = _gameplayComponents.attachCoinComponent;
const attachTargetComponent = _gameplayComponents.attachTargetComponent;
const attachHealthPickupComponent = _gameplayComponents.attachHealthPickupComponent;

function updateShooterSpawners(delta = 0) {
    if (!gameplay.active) return;
    const spawners = getGameplayPrefabActors('shooterSpawner', _scratchPrefab1);
    if (!spawners.length) return;

    for (let i = 0; i < spawners.length; i++) {
        const spawner = spawners[i];
        ensureGameplayPrefabScript(spawner, SHOOTER_SPAWNER_USER_SCRIPT);
        runObjectEventScript(spawner, 'tick', { deltaTime: delta });
    }
}
if (typeof window !== 'undefined') {
    window.updateShooterAiActor = updateShooterAiActor;
    window.updateShooterSpawnerActor = updateShooterSpawnerActor;
    window.spawnShooterAiAt = spawnShooterAiAt;
    window.spawnShooterProjectile = spawnShooterProjectile;
    // damageShooterAi / setShooterHealth assignments moved below the
    // _shooterAiVisuals factory because those bindings are now `const`
    // initialized from that factory and would TDZ here.
}

// Procedural shotgun blast: a short filtered noise burst + a low thump.
// `volume` 0..1 scales loudness. Synthesized so there's no asset to ship.
const combatFx = createCombatFx({
    runtimeAudio,
    getScene: () => scene,
    getCamera: () => camera,
    gameplayPrefabState,
    getActorRenderObject: (actor) => getActorRenderObject(actor),
    tmp: { a: tempVectorA, c: tempVectorC, d: tempVectorD, e: tempVectorE },
});
const makeSpatialSink = combatFx.makeSpatialSink;
const playDoomShotgunSound = combatFx.playDoomShotgunSound;
const playDoomPickupSound = combatFx.playDoomPickupSound;
const playEnemyDeathSound = combatFx.playEnemyDeathSound;
const playImpactSound = combatFx.playImpactSound;
const playEnemyHurtSound = combatFx.playEnemyHurtSound;
const spawnImpactBurst = combatFx.spawnImpactBurst;
const spawnTracer = combatFx.spawnTracer;
const spawnImpactDecal = combatFx.spawnImpactDecal;
const spawnMuzzleSmoke = combatFx.spawnMuzzleSmoke;
const flashActorHit = combatFx.flashActorHit;

const _shooterAiVisuals = createShooterAiVisuals({
    THREE,
    scene: () => scene,
    camera: () => camera,
    currentMesh: () => currentMesh,
    gameplay, gameplayPrefabState,
    SHOOTER_AI_PREFAB, PLAYER_SETTINGS,
    upVector, tempVectorA,
    getActorRenderObject: (a) => getActorRenderObject(a),
    getGameplaySubjectPosition: (t) => getGameplaySubjectPosition(t),
    getGameplayPrefabActors,
    isDrivingVehicle,
    playEnemyDeathSound, playEnemyHurtSound,
    flashActorHit,
    addGameScore: (...a) => addGameScore(...a),
    setPlayerHealth: (...a) => setPlayerHealth(...a),
});
const getShooterHitPoints = _shooterAiVisuals.getShooterHitPoints;
const addCircularNavmeshVisual = _shooterAiVisuals.addCircularNavmeshVisual;
const addShooterAiVisual = _shooterAiVisuals.addShooterAiVisual;
const ensureShooterAimWarning = _shooterAiVisuals.ensureShooterAimWarning;
const updateShooterAimWarning = _shooterAiVisuals.updateShooterAimWarning;
const hideShooterAimWarning = _shooterAiVisuals.hideShooterAimWarning;
const clearShooterAimWarnings = _shooterAiVisuals.clearShooterAimWarnings;
const ensureShooterHealthBar = _shooterAiVisuals.ensureShooterHealthBar;
const setShooterHealth = _shooterAiVisuals.setShooterHealth;
const resetShooterAiState = _shooterAiVisuals.resetShooterAiState;
const damageShooterAi = _shooterAiVisuals.damageShooterAi;
const emitShooterDeathEffect = _shooterAiVisuals.emitShooterDeathEffect;
if (typeof window !== 'undefined') {
    window.damageShooterAi = damageShooterAi;
    window.setShooterHealth = setShooterHealth;
}
// Publish combat FX + 3D sound surface via engineApi (typed) rather
// than window.*. Eval'd prefab scripts read these from their `api`
// parameter (see buildObjectEventApi). installLegacyWindowShims at the
// end of init() keeps any remaining window.* readers alive.
registerEngineFx({
    spawnImpactBurst,
    spawnTracer,
    spawnImpactDecal,
    spawnMuzzleSmoke,
    flashActorHit,
});
registerEngineSound({
    playImpactSound,
    playEnemyHurtSound,
    playEnemyDeathSound,
    playDoomShotgunSound,
    playDoomPickupSound,
});

// Weapon HUD (ammo text + directional damage indicator). Lazy DOM, no globals.
const _weaponHud = createWeaponHud();
const setWeaponHud = _weaponHud.setWeaponHud;
const showDamageIndicator = _weaponHud.showDamageIndicator;

const heldWeapons = createHeldWeapons({
    getCamera: () => camera,
    gameplay,
    getWeaponHudEl: _weaponHud.getWeaponHudEl,
    getActorRenderObject: (actor) => getActorRenderObject(actor),
    spawnShooterProjectile: (origin, target, opts) => spawnShooterProjectile(origin, target, opts),
    spawnTracer: (...args) => combatFx.spawnTracer(...args),
    prefabs: { STRAIGHT_GUN: STRAIGHT_GUN_PREFAB, DOOM_SHOTGUN: DOOM_SHOTGUN_PREFAB },
    tmp: { a: tempVectorA, c: tempVectorC, d: tempVectorD, e: tempVectorE, f: tempVectorF },
});
const addStraightGunVisual = heldWeapons.addStraightGunVisual;
const createHeldThrowingStarMesh = heldWeapons.createHeldThrowingStarMesh;
const createHeldStraightGunMesh = heldWeapons.createHeldStraightGunMesh;
const createHeldSniperRifleMesh = heldWeapons.createHeldSniperRifleMesh;
const createHeldDoomShotgunMesh = heldWeapons.createHeldDoomShotgunMesh;
const clearHeldWeapon = heldWeapons.clearHeldWeapon;
const equipStraightGun = heldWeapons.equipStraightGun;
const equipSniperRifle = heldWeapons.equipSniperRifle;
const equipDoomShotgun = heldWeapons.equipDoomShotgun;
const equipThrowingStar = heldWeapons.equipThrowingStar;
const updateDoomShotgunHud = heldWeapons.updateDoomShotgunHud;
const spawnDoomPellet = heldWeapons.spawnDoomPellet;
const flashDoomShotgun = heldWeapons.flashDoomShotgun;
registerEngineFx({ flashDoomShotgun });
registerEngineWeapons({
    equipDoomShotgun,
    equipStraightGun,
    equipSniperRifle,
    equipThrowingStar,
    spawnDoomPellet,
});
// Weapon HUD + damage indicator extracted to ../gameplay/weaponHud.js
// (instantiated above as _weaponHud, just before createHeldWeapons).
// HUD surface → engineApi.hud. setWeaponHud + showDamageIndicator
// reach prefab scripts via the api parameter.
registerEngineHud({ setWeaponHud, showDamageIndicator });
// (playDoomShotgunSound/playDoomPickupSound were already registered
// above via registerEngineSound; the duplicate window.* block here was
// a leftover. DOOM_SHOTGUN_DEFAULTS stays a plain global for now —
// it's a frozen const, not a function surface.)
if (typeof window !== 'undefined') {
    window.DOOM_SHOTGUN_DEFAULTS = Object.freeze({ ...DOOM_SHOTGUN_PREFAB });
}

// Backwards-compat shims for any window.spawnImpactBurst / playImpactSound
// / setWeaponHud call site we haven't migrated yet (DDGI debug helpers,
// dev console, third-party). All registered FX/sound/HUD functions are
// re-exposed on window. Pass { warn: true } once a session to hunt down
// remaining global call sites.
installLegacyWindowShims();

const updateStraightGuns = createWeaponFire({
    THREE,
    camera: () => camera,
    physics,
    gameplay,
    DOOM_SHOTGUN_PREFAB, DOOM_SHOTGUN_PELLET_PATTERN,
    STRAIGHT_GUN_PREFAB, SNIPER_RIFLE_PREFAB, THROWING_STAR_PREFAB,
    _scratchPrefab1,
    tempVectorA, tempVectorC,
    isDrivingVehicle,
    getGameplayPrefabActors,
    hasScriptedTickHandler: (...a) => hasScriptedTickHandler(...a),
    runObjectEventScript,
    updateDoomShotgunHud,
    spawnDoomPellet, flashDoomShotgun,
    playDoomShotgunSound,
    applyCameraRecoil: (...a) => applyCameraRecoil(...a),
    spawnDynamicPrimitive,
    getActorBody: (a) => getActorBody(a),
    getActorRenderObject: (a) => getActorRenderObject(a),
    destroyDynamicPhysicsProp,
    spawnShooterProjectile,
});


const spawnGameplayPrefab = createSpawnGameplayPrefab({
    THREE,
    camera: () => camera,
    sceneSystem: () => sceneSystem,
    BASIC_NAVMESH_AI_PREFAB, SHOOTER_AI_PREFAB, HEALTH_PICKUP_PREFAB,
    STRAIGHT_GUN_PREFAB, SNIPER_RIFLE_PREFAB, DOOM_SHOTGUN_PREFAB,
    DOOM_ENEMY_PREFAB,
    TELEPORTER_USER_SCRIPT, COIN_USER_SCRIPT, HEALTH_PICKUP_USER_SCRIPT,
    TARGET_USER_SCRIPT, SHOOTER_SPAWNER_USER_SCRIPT,
    DOOM_SHOTGUN_USER_SCRIPT, ROGUE_GAMEMODE_SCRIPT,
    tempVectorA, tempVectorB, tempVectorC,
    spawnDynamicPrimitive,
    spawnDoomEnemyAt: (...a) => spawnDoomEnemyAt(...a),
    spawnShooterAiAt: (...a) => spawnShooterAiAt(...a),
    createActor,
    tagGameplayPrefabActor, tintGameplayPrefabActor,
    applyPlayerSpawnFromActor,
    attachDefaultPrefabScript,
    getActorRenderObject: (a) => getActorRenderObject(a),
    // const aliases bound later in the file — wrap to defer the lookup.
    getGroundHeightAt: (...a) => getGroundHeightAt(...a),
    rebuildActorPhysics: (...a) => rebuildActorPhysics(...a),
    attachCoinComponent, attachHealthPickupComponent, attachTargetComponent,
    attachShooterSpawnerComponent, attachWeaponPickupComponent,
    addCircularNavmeshVisual,
    CircularPatrolComponent,
    addStraightGunVisual,
    makeDoomShotgunSpriteTexture: (...a) => makeDoomShotgunSpriteTexture(...a),
    ensureActorIdentity: (...a) => ensureActorIdentity(...a),
    setActorComponentFlags,
    refreshSceneUI: (...a) => refreshSceneUI(...a),
    selectShowcaseActor: (...a) => selectShowcaseActor(...a),
});


function addGameScore(amount) {
    const value = Number(amount) || 0;
    window.gameScore = (Number(window.gameScore) || 0) + value;
    window.exampleWidgets?.score?.SetText(`Score: ${Math.floor(window.gameScore)}`);
}
if (typeof window !== 'undefined') {
    window.addGameScore = addGameScore;
}

function resetGameplayPrefabs() {
    gameplayPrefabState.teleporterCooldownUntil = 0;
    clearShooterProjectiles();
    clearGameplayEffects();
    clearHeldWeapon();
    setPlayerHealth(1);
    window.gameScore = 0;
    window.exampleWidgets?.score?.SetText('Score: 0');

    for (const actor of getGameplayPrefabActors('shooterAi')) {
        if (actor?.userData?.shooterAi?.spawnedBy) {
            hideShooterAimWarning(actor);
            destroyDynamicPhysicsProp(actor);
        }
    }

    getGameplayPrefabActors().forEach((actor) => {
        actor.userData.collected = false;
        actor.userData.hitCooldownUntil = 0;
        actor.userData._wasInsideTrigger = false;
        const mesh = getActorRenderObject(actor);
        if (mesh) mesh.visible = actor.userData.gameplayPrefab !== 'playerSpawn' || !gameplay.active;
        if (actor.userData.gameplayPrefab === 'shooterAi') {
            resetShooterAiState(actor);
        } else if (actor.userData.gameplayPrefab === 'healthPickup') {
            actor.userData.respawnAt = 0;
            actor.userData.collected = false;
            if (mesh) mesh.visible = true;
            const comp = actor.getComponentByClass?.(HealthPickupComponent)
                || attachHealthPickupComponent(actor);
            comp?.reset();
        } else if (actor.userData.gameplayPrefab === 'shooterSpawner') {
            actor.userData.shooterSpawner = { wave: 0, nextWaveAt: 0 };
            const comp = actor.getComponentByClass?.(ShooterSpawnerComponent)
                || attachShooterSpawnerComponent(actor);
            if (comp) { comp.wave = 0; comp.nextWaveAt = 0; }
        } else if (actor.userData.gameplayPrefab === 'smg') {
            actor.userData.smg = { nextShotAt: 0, cooldownMs: STRAIGHT_GUN_PREFAB.cooldownMs };
            actor.getComponentByClass?.(WeaponPickupComponent)?.reset();
        } else if (actor.userData.gameplayPrefab === 'sniperRifle') {
            actor.userData.sniperRifle = { nextShotAt: 0, cooldownMs: SNIPER_RIFLE_PREFAB.cooldownMs };
            actor.getComponentByClass?.(WeaponPickupComponent)?.reset();
        } else if (actor.userData.gameplayPrefab === 'doomShotgunSprite') {
            actor.userData.doomShotgun = { nextShotAt: 0, cooldownMs: DOOM_SHOTGUN_PREFAB.cooldownMs };
            actor.getComponentByClass?.(WeaponPickupComponent)?.reset();
        }
    });

    syncGameplaySpawnFromPlayerSpawnActor();
}

const _actorTransforms = createActorTransforms({
    physics, dynamicBodySpatial, gameplay,
    PLAYER_SETTINGS,
    tempVectorA, tempVectorB,
    copyJoltVector,
    getActorRenderObject: (a) => getActorRenderObject(a),
    getActorBody: (a) => getActorBody(a),
    isDrivingVehicle,
    getActiveVehicleProp,
    syncCameraToCharacter: (...a) => syncCameraToCharacter(...a),
    dispatchTriggerEvent,
});
const setActorResetTransform = _actorTransforms.setActorResetTransform;
const syncActorBodyToRenderTransform = _actorTransforms.syncActorBodyToRenderTransform;
const resetActorToStoredTransform = _actorTransforms.resetActorToStoredTransform;
const teleportActiveGameplaySubject = _actorTransforms.teleportActiveGameplaySubject;
const teleportActorTo = _actorTransforms.teleportActorTo;
const getGameplaySubjectPosition = _actorTransforms.getGameplaySubjectPosition;
const isSubjectInsideTrigger = _actorTransforms.isSubjectInsideTrigger;
const dispatchTriggerForActor = _actorTransforms.dispatchTriggerForActor;
const hasScriptedTriggerHandler = _actorTransforms.hasScriptedTriggerHandler;
const hasScriptedTickHandler = _actorTransforms.hasScriptedTickHandler;

// Rebuild the Doom mini-level's wave state machine to its pre-Play state.
// restoreSceneState() reloads serialized actors (the gun/exit/spawn prefabs
// and pre-placed geometry) but it does NOT touch currentMesh.userData, so
// doomMiniLevelState keeps its play-time progress (hall/arena/finalTriggered,
// stale *WaveActors, an exitActor pointing at a destroyed actor) — the level
// reads as "already beaten": enemies don't respawn, barriers/exit stay wrong.
// Mirrors resetSoccerLevelState(); called from both Stop paths.
// resetDoomMiniLevelState / resetDoomArenaLevelState / resetSoccerLevelState /
// updateSoccerGoalies all live in levelStateSystem.js (aliased below).
const resetDoomMiniLevelState = _levelStateSystem.resetDoomMiniLevelState;
const resetDoomArenaLevelState = _levelStateSystem.resetDoomArenaLevelState;
const resetSoccerLevelState = _levelStateSystem.resetSoccerLevelState;
const updateSoccerGoalies = _levelStateSystem.updateSoccerGoalies;

function syncGameplayPrefabVisibility() {
    for (const actor of getGameplayPrefabActors('playerSpawn')) {
        const mesh = getActorRenderObject(actor);
        if (mesh) mesh.visible = !gameplay.active;
    }
}

if (typeof window !== 'undefined') {
    queueMicrotask(() => {
        window.teleportActorTo = teleportActorTo;
        window.teleportActiveGameplaySubject = teleportActiveGameplaySubject;
        window.getAllSceneActors = () => Array.from(sceneSystem?.actors || []);
    });
}

// Reused per-frame subject descriptor for the gameplay-prefab system to
// avoid allocating a fresh object + Vector3 every frame.
const _gameplaySubjectScratch = { position: new THREE.Vector3(), health: 0 };
// All per-prefab logic moved into ECS components (CoinComponent,
// HealthPickupComponent, WeaponPickupComponent, TargetComponent) +
// teleporterSystem. The orchestrator lives in gameplay/gameplayPrefabSystem.
const _gameplayPrefabSystem = createGameplayPrefabSystem({
    gameplay,
    getGameplaySubjectPosition: (...a) => getGameplaySubjectPosition(...a),
    processTeleporters: (...a) => processTeleporters(...a),
    subjectScratch: _gameplaySubjectScratch,
    tmp: { subject: tempVectorC },
});
const snapshotGameplaySubject = _gameplayPrefabSystem.snapshotSubject;
const updateGameplayTeleporters = _gameplayPrefabSystem.updateTeleporters;

function syncDynamicPhysicsBodies() {
    physicsRuntime?.syncDynamicPhysicsBodies();
}

function rebuildTerrainPhysicsBody() {
    if (currentMesh?.userData?.hideTerrainPresentation) {
        if (physics.terrainBody) {
            destroyPhysicsBody(physics.terrainBody);
            physics.terrainBody = null;
        }
        return;
    }
    physicsCore?.rebuildTerrainPhysicsBody();
}

function rebuildModelPhysicsBody() {
    physicsCore?.rebuildModelPhysicsBody();
}

function destroyPlayerCharacter() {
    physicsRuntime?.destroyPlayerCharacter();
}

function syncGameplaySpawnToCamera() {
    if (!camera) return;

    gameplay.spawnPoint.set(
        camera.position.x,
        camera.position.y - PLAYER_SETTINGS.eyeHeight,
        camera.position.z
    );

    tempVectorA.setFromEuler(camera.rotation.reorder('YXZ'));
    gameplay.spawnYaw = tempVectorA.y;
    gameplay.spawnPitch = THREE.MathUtils.clamp(
        tempVectorA.x,
        -PLAYER_SETTINGS.maxLookPitch,
        PLAYER_SETTINGS.maxLookPitch
    );
}

const _showcaseCamera = createShowcaseCamera({
    THREE, gsap,
    camera: () => camera,
    showcase,
    gameplay, objectScriptState,
    PLAYER_SETTINGS,
    tempVectorA, tempBoxA,
    getActorRenderObject: (a) => getActorRenderObject(a),
    getActorSelectionObject: (a, p) => getActorSelectionObject(a, p),
    getDynamicPropById,
});
const syncShowcaseAnglesFromTarget = _showcaseCamera.syncShowcaseAnglesFromTarget;
const syncShowcaseAnglesToFaceTarget = _showcaseCamera.syncShowcaseAnglesToFaceTarget;
const applyShowcaseCameraRotation = _showcaseCamera.applyShowcaseCameraRotation;
const getObjectFocusFrame = _showcaseCamera.getObjectFocusFrame;
const focusShowcaseCameraOnObject = _showcaseCamera.focusShowcaseCameraOnObject;
const focusSceneActor = _showcaseCamera.focusSceneActor;
const focusCurrentShowcaseSelection = _showcaseCamera.focusCurrentShowcaseSelection;

function ensurePlayerCharacter() {
    physicsRuntime?.ensurePlayerCharacter();
}

function syncCameraToCharacter() {
    physicsRuntime?.syncCameraToCharacter();
}

function stepPhysics(delta) {
    return physicsRuntime?.stepPhysics(delta) ?? {
        total: 0,
        step: 0,
        sync: 0,
        collisions: 0,
    };
}

function updateLitePhysicsPools() {
    for (let i = 0; i < litePools.length; i++) litePools[i].update();
}

/**
 * Lightweight bulk physics path. No actor, no scripts, no scene graph entry —
 * one InstancedMesh, one shared shape, parallel body array. Designed for
 * spawning thousands of small dynamic boxes.
 */
function createLiteBoxPool(options = {}) {
    if (!physics?.ready) {
        console.warn('createLiteBoxPool: physics not ready yet');
        return null;
    }
    const pool = createLitePhysicsPool({
        physics,
        scene,
        ...options,
    });
    litePools.push(pool);
    return pool;
}

function spawnLiteCubeStorm({
    count = 3000,
    halfExtent = 0.2,
    spacing = 0.6,
    origin = null,
    color = 0x99bbff,
    jitter = 0.05,
} = {}) {
    const pool = createLiteBoxPool({
        capacity: count,
        halfExtent,
        color,
    });
    if (!pool) return null;

    const dim = Math.ceil(Math.cbrt(count));
    const baseOrigin = origin ?? {
        x: (camera?.position?.x ?? 0),
        y: (worldFloor?.position?.y ?? 0) + 5,
        z: (camera?.position?.z ?? 0) - 4,
    };
    pool.spawnGrid({
        origin: baseOrigin,
        dimsX: dim,
        dimsY: dim,
        dimsZ: dim,
        spacing,
        jitter,
    });
    return pool;
}

if (typeof window !== 'undefined') {
    window.spawnLiteCubeStorm = spawnLiteCubeStorm;
    window.createLiteBoxPool = createLiteBoxPool;
}

// Pure object-script state helpers extracted to ../scripting/objectScriptStore.js
const _objectScriptStore = createObjectScriptStore({
    storageKey: OBJECT_SCRIPT_STORAGE_KEY,
    getObjectScriptState: () => objectScriptState,
});
const createDefaultObjectEventState = _objectScriptStore.createDefaultObjectEventState;
const createObjectScriptState = _objectScriptStore.createObjectScriptState;
const sanitizeObjectScriptDrafts = _objectScriptStore.sanitizeObjectScriptDrafts;
const readObjectScriptDrafts = _objectScriptStore.readObjectScriptDrafts;
const saveObjectScriptDrafts = _objectScriptStore.saveObjectScriptDrafts;
const ensureObjectScriptDraftEntry = _objectScriptStore.ensureObjectScriptDraftEntry;
const syncRuntimePropIdCounter = _objectScriptStore.syncRuntimePropIdCounter;

function markDDGISkipCapture(object) {
    object?.traverse?.((node) => {
        if (!node.userData) node.userData = {};
        node.userData.ddgiSkipCapture = true;
    });
    return object;
}

function invalidateDDGI(reason, fastWarmupFrames = 2) {
    try {
        getDDGIManager().invalidate({ reason, fastWarmupFrames });
    } catch {
        // DDGI can be unavailable during early boot or teardown.
    }
}


function createRuntimePropId() {
    let propId = '';
    do {
        propId = `prop-${objectScriptState.nextPropId++}`;
    } while (getDynamicPropById(propId));

    ensureObjectScriptDraftEntry(propId);
    return propId;
}

function getActorRenderObject(prop) {
    return getRenderComponent(prop)?.mesh ?? prop?.mesh ?? null;
}
function getActorBody(prop) {
    if (!prop) return null;
    return prop.body || getPhysicsBodyComponent(prop)?.body || null;
}

function isObjectWithinRoot(object, root) {
    let current = object;
    while (current) {
        if (current === root) return true;
        current = current.parent;
    }
    return false;
}

function actorBelongsToCurrentMesh(actor) {
    const root = getActorRenderObject(actor);
    return !!(root && currentMesh && isObjectWithinRoot(root, currentMesh));
}

function reattachRestoredActor(actor, actorData = null) {
    if (!currentMesh) return;

    const shouldAttachToCurrentMesh = !!(
        actorData?.userData?.sampleLevelPart
        || actor?.userData?.sampleLevelPart
    );
    if (!shouldAttachToCurrentMesh) return;

    const actorMesh = getActorRenderObject(actor);
    if (!actorMesh || actorMesh.parent === currentMesh) return;
    currentMesh.add(actorMesh);
}

function getActorSelectionObject(prop, preferredObject = null) {
    const root = getActorRenderObject(prop);
    if (!root) return null;

    if (!blueprintState.active) {
        return root;
    }

    if (preferredObject && isObjectWithinRoot(preferredObject, root)) {
        return preferredObject;
    }

    if (objectScriptState.targetObjectUuid) {
        const selectedObject = root.getObjectByProperty?.('uuid', objectScriptState.targetObjectUuid) ?? null;
        if (selectedObject) {
            return selectedObject;
        }
    }

    return root;
}

function selectShowcaseActor(actorId, selectionObject = null) {
    if (gameplay.active) return; // Only allow selection in Showcase mode
    
    const previousTargetId = objectScriptState.targetPropId;
    objectScriptState.targetPropId = actorId || '';
    objectScriptState.targetObjectUuid = '';
    
    if (blueprintState.active && actorId !== blueprintState.targetActor?.id) {
        exitBlueprintEditor();
    }
    
    if (actorId) {
        const prop = getDynamicPropById(actorId);
        const targetObject = getActorSelectionObject(prop, selectionObject);
        objectScriptState.targetObjectUuid = targetObject?.uuid || '';
        if (objectScriptEditorTarget) {
            objectScriptEditorTarget.textContent = prop?.rootNode?.name || actorId || 'Actor';
        }
        if (transformControl && targetObject) {
            transformControl.attach(targetObject);
        }
    } else {
        if (objectScriptEditorTarget) {
            objectScriptEditorTarget.textContent = 'None';
        }
        if (transformControl) {
            transformControl.detach();
        }
    }
    
    if (previousTargetId !== objectScriptState.targetPropId) {
        if (actorPhysicsEditorState.previewActorId && actorPhysicsEditorState.previewActorId !== objectScriptState.targetPropId) {
            clearActorPhysicsPreview();
        }
        refreshSceneUI();
    }

    updateLightRangeVisualVisibility();
    updateSceneActorDetailsUI();
}

function syncTransformControlState() {
    if (!transformControl) return;

    const helper = transformControl.getHelper?.() ?? null;
    const shouldEnable = !gameplay.active && !gameplay.pointerLocked;

    transformControl.enabled = shouldEnable;
    if (helper) {
        helper.visible = shouldEnable && !!transformControl.object;
    }

    if (!shouldEnable) {
        transformControl.detach();
        return;
    }

    if (transformControl.object || blueprintState.active) {
        if (helper) helper.visible = !!transformControl.object;
        return;
    }

    const selectedActor = getDynamicPropById(objectScriptState.targetPropId);
    const selectedMesh = getActorSelectionObject(selectedActor);
    if (selectedMesh) {
        transformControl.attach(selectedMesh);
        if (helper) helper.visible = true;
    }
}

function syncTransformToPhysics() {
    if (!transformControl || !transformControl.object) return;
    
    // In blueprint mode, child components can be moved freely without physics sync
    if (blueprintState.active) return;
    
    const prop = findDynamicPropByMesh(transformControl.object);
    if (!prop) return;

    const body = getActorBody(prop);
    if (!body || !physics.jolt) return;

    const mesh = transformControl.object;
    const rootMesh = getActorRenderObject(prop);
    if (mesh !== rootMesh) {
        rebuildActorPhysics(prop);
        return;
    }

    const pos = mesh.position;
    const rot = mesh.quaternion;

    const { bodyInterface, Jolt } = physics;
    
    // Position and Rotation sync
    const joltPos = new Jolt.Vec3(pos.x, pos.y, pos.z);
    const joltRot = new Jolt.Quat(rot.x, rot.y, rot.z, rot.w);
    bodyInterface.SetPositionAndRotation(body.GetID(), joltPos, joltRot, Jolt.EActivation_Activate);
    Jolt.destroy(joltPos);
    Jolt.destroy(joltRot);
    dynamicBodySpatial.updateEntry(prop);
    
    // Scale sync (requires rebuilding the body for primitives)
    if (transformControl.getMode() === 'scale') {
        rebuildActorPhysics(prop);
    }
}

const rebuildActorPhysics = createRebuildActorPhysics({
    THREE,
    physics, dynamicBodySpatial,
    actorPhysicsEditorState,
    getActorComponentFlags, setActorComponentFlags,
    getActorRenderObject: (p) => getActorRenderObject(p),
    getActorBody: (p) => getActorBody(p),
    getPhysicsBodyComponent,
    getImportedTemplate,
    createStaticMeshBody: (...a) => createStaticMeshBody(...a),
    createDynamicPrimitiveBody: (...a) => createDynamicPrimitiveBody(...a),
    createOwnedShape,
    refreshActorPhysicsPreview: (...a) => refreshActorPhysicsPreview(...a),
});

function getActorScriptState(prop) {
    return getScriptComponent(prop)?.state ?? prop?.scripts ?? null;
}

function getActorMetadata(prop) {
    return getMetadataComponent(prop) ?? null;
}

function ensureActorIdentity(prop) {
    if (!prop) return prop;

    const propId = prop.id || createRuntimePropId();
    prop.id = propId;
    syncRuntimePropIdCounter(propId);
    const mesh = getActorRenderObject(prop);
    if (mesh?.userData) {
        mesh.userData.dynamicPropId = propId;
    }

    return prop;
}

function ensureActorScriptState(prop) {
    if (!prop) return null;

    const existingState = getActorScriptState(prop);
    if (existingState) {
        return existingState;
    }

    ensureActorIdentity(prop);
    const scriptState = createObjectScriptState(prop.id);
    ensureActorScriptComponent(prop, scriptState);
    prop.scripts = scriptState;
    return scriptState;
}

const buildPrimitiveActorMesh = createPrimitiveMeshFactory(THREE);

function syncActorEditorTemplateOptions(selectedTemplateId = '', selectedVehicleBodyTemplateId = '', selectedVehicleWheelTemplateId = '') {
    const templates = listImportedTemplates();
    if (actorImportedTemplateSelect) {
        actorImportedTemplateSelect.innerHTML = '';

        if (!templates.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No imported source available';
            actorImportedTemplateSelect.appendChild(option);
            actorImportedTemplateSelect.value = '';
        } else {
            templates.forEach((template) => {
                const option = document.createElement('option');
                option.value = template.id;
                option.textContent = `${template.displayName} (${template.collisionMode})`;
                actorImportedTemplateSelect.appendChild(option);
            });

            actorImportedTemplateSelect.value = selectedTemplateId && templates.some((template) => template.id === selectedTemplateId)
                ? selectedTemplateId
                : templates[0].id;
        }
    }

    const populateVehicleSelect = (select, selectedId, defaultLabel) => {
        if (!select) return;
        select.innerHTML = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = defaultLabel;
        select.appendChild(defaultOption);
        templates.forEach((template) => {
            const option = document.createElement('option');
            option.value = template.id;
            option.textContent = template.displayName;
            select.appendChild(option);
        });
        const customOption = document.createElement('option');
        customOption.value = VEHICLE_CUSTOM_IMPORT_VALUE;
        customOption.textContent = 'Custom… (import file)';
        select.appendChild(customOption);
        select.value = selectedId && templates.some((template) => template.id === selectedId)
            ? selectedId
            : '';
    };
    populateVehicleSelect(actorVehicleBodyTemplateSelect, selectedVehicleBodyTemplateId, 'Default Sedan');
    populateVehicleSelect(actorVehicleWheelTemplateSelect, selectedVehicleWheelTemplateId, 'Default Wheel');
}

function handleVehicleTemplateSelectChange(slot) {
    const select = slot === 'body' ? actorVehicleBodyTemplateSelect : actorVehicleWheelTemplateSelect;
    if (!select) return;

    if (select.value === VEHICLE_CUSTOM_IMPORT_VALUE) {
        // Reset visible value back to default so the dropdown doesn't get
        // stuck on "Custom…" if the user cancels the file picker.
        select.value = '';
        if (!vehicleTemplateImportInput) return;
        pendingVehicleTemplateImportSlot = slot;
        vehicleTemplateImportInput.value = '';
        vehicleTemplateImportInput.click();
        return;
    }

    syncActorEditorUi();
}

function syncActorEditorUi() {
    if (!actorKindSelect || !actorEditorSummary || !actorEditorStatus || !actorImportedTemplateSelect || !actorComponentCollisionInput || !actorComponentPhysicsInput || !actorComponentScriptsInput) {
        return;
    }

    const kind = actorKindSelect.value || 'sphere';
    const isImported = kind === 'imported';
    const isVehicle = kind === 'vehicle';
    const isLight = isLightActorKind(kind);
    const hadCollisionDisabled = actorComponentCollisionInput.disabled;

    actorImportedTemplateSelect.disabled = !isImported;
    if (actorVehicleBodyTemplateSelect) {
        actorVehicleBodyTemplateSelect.disabled = !isVehicle;
    }
    if (actorVehicleWheelTemplateSelect) {
        actorVehicleWheelTemplateSelect.disabled = !isVehicle;
    }
    actorComponentCollisionInput.disabled = isVehicle || isLight;
    if (isVehicle) {
        actorComponentCollisionInput.checked = true;
        actorComponentPhysicsInput.checked = true;
    } else if (isLight) {
        actorComponentCollisionInput.checked = false;
        actorComponentPhysicsInput.checked = false;
    } else if (hadCollisionDisabled && !actorComponentCollisionInput.checked) {
        actorComponentCollisionInput.checked = true;
        actorComponentPhysicsInput.checked = true;
    } else if (!actorComponentCollisionInput.checked) {
        actorComponentPhysicsInput.checked = false;
    }
    actorComponentPhysicsInput.disabled = isVehicle || isLight || !actorComponentCollisionInput.checked;

    const typeLabel = getActorKindLabel(kind);

    actorEditorSummary.textContent = `Type: ${typeLabel}`;

    if (isImported && !listImportedTemplates().length) {
        actorEditorStatus.textContent = 'Import a prop source first, then create an imported actor instance from it.';
        return;
    }

    if (isLight) {
        actorEditorStatus.textContent = `${typeLabel} will spawn with a visible helper and a live scene light. DDGI can collect it for indirect bounce when enabled.`;
        return;
    }

    const bodyDescription = !actorComponentCollisionInput.checked
        ? ''
        : actorComponentPhysicsInput.checked
            ? ', simulated collision + physics'
            : ', static collision only';
    actorEditorStatus.textContent = `${typeLabel} will spawn with a render node${bodyDescription}${actorComponentScriptsInput.checked ? ', and a script host' : ''}.`;
}

function closeActorEditor() {
    actorEditorState.open = false;
    if (actorEditor) {
        actorEditor.hidden = true;
    }
}

function openActorEditor({ kind = 'cube', templateId = '', label = '', vehicleBodyTemplateId = '', vehicleWheelTemplateId = '' } = {}) {
    if (!actorEditor) return;

    actorEditorState.open = true;
    if (actorKindSelect) {
        actorKindSelect.value = kind;
    }
    if (actorLabelInput) {
        actorLabelInput.value = label;
    }
    if (actorScaleInput) {
        actorScaleInput.value = getActorKindDefaultScale(kind);
    }
    const actorColorEnabledReset = document.getElementById('actor-color-enabled');
    const actorColorInputReset = document.getElementById('actor-color-input');
    if (actorColorEnabledReset) actorColorEnabledReset.checked = false;
    if (actorColorInputReset) actorColorInputReset.disabled = true;
    if (actorComponentCollisionInput) {
        actorComponentCollisionInput.checked = true;
    }
    if (actorComponentPhysicsInput) {
        actorComponentPhysicsInput.checked = true;
    }
    if (actorComponentScriptsInput) {
        actorComponentScriptsInput.checked = true;
    }

    syncActorEditorTemplateOptions(templateId, vehicleBodyTemplateId, vehicleWheelTemplateId);
    syncActorEditorUi();
    actorEditor.hidden = false;
}

// === extracted: objectMaterial (was lines 3876-4151 of original main.js) ===
function spawnDDGIVolumeActor({ userData = null, position = null, size = null, options = {} } = {}) {
    const camDir = camera ? new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion) : new THREE.Vector3(0, 0, -1);
    const spawnPos = position
        ? position.clone()
        : (camera ? camera.position.clone().addScaledVector(camDir, 8) : new THREE.Vector3());
    const dims = size ? size.clone() : new THREE.Vector3(32, 16, 32);
    const geom = new THREE.BoxGeometry(dims.x, dims.y, dims.z);
    const mat = new THREE.MeshBasicMaterial({
        color: 0x4dffd2,
        wireframe: true,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        toneMapped: false,
        fog: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(spawnPos);
    mesh.userData.ddgiSkipReceive = true;
    // Hide the volume wireframe from DDGI bake/debug paths.
    mesh.userData.ddgiSkipCapture = true;
    mesh.userData.ignoreForcedSceneShadows = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    const actor = sceneSystem?.createEntity
        ? sceneSystem.createEntity(userData?.label || 'ddgi-volume', {
            register: false,
            kind: 'ddgiVolume',
            userData,
        })
        : createActor({
            kind: 'ddgiVolume',
            userData,
            name: userData?.label || 'ddgi-volume',
        });
    actor.mesh = mesh;
    if (!actor.hasComponent(TransformComponent)) {
        actor.addComponent(new TransformComponent());
    }
    const ddgi = new DDGIVolumeComponent(options);
    actor.addComponent(ddgi);

    sceneSystem?.addActor(actor);
    ensureActorIdentity(actor);

    // Trigger BeginPlay manually so the volume registers right now (the engine's
    // gameplay-mode lifecycle would otherwise wait for play).
    try { ddgi.beginPlay(); } catch (e) { console.warn('[DDGI] beginPlay failed', e); }

    return actor;
}

function requestLightShadowRefresh(light) {
    if (!light?.castShadow || !light.shadow) return;
    if (light.isPointLight && light.shadow.camera) {
        light.shadow.camera.near = 0.1;
        light.shadow.camera.far = Math.max(light.distance > 0 ? light.distance : 24, 0.5);
        light.shadow.camera.updateProjectionMatrix?.();
    }
    light.shadow.needsUpdate = true;
    if (renderer?.shadowMap) {
        renderer.shadowMap.needsUpdate = true;
    }
}

function configurePointLightShadow(light, opts = {}) {
    if (!light?.isPointLight || !light.shadow) return light;
    // Inherit any unspecified value from the global shadow tuning in
    // worldEnvState so newly-spawned lights match the World Options panel
    // without an extra apply pass. Callers that pass an explicit value still
    // win — useful for the cornell preset which sets its own defaults.
    const g = worldEnvState?.shadows ?? {};
    const mapSize = Number.isFinite(opts.mapSize) ? opts.mapSize : (g.mapSize ?? 512);
    const bias = Number.isFinite(opts.bias) ? opts.bias : (g.bias ?? 0.0005);
    const normalBias = Number.isFinite(opts.normalBias) ? opts.normalBias : (g.normalBias ?? 0.02);
    const radius = Number.isFinite(opts.radius) ? opts.radius : (g.radius ?? 2.5);
    light.shadow.mapSize.set(mapSize, mapSize);
    light.shadow.bias = bias;
    light.shadow.radius = radius;
    if ('normalBias' in light.shadow) light.shadow.normalBias = normalBias;
    light.shadow.autoUpdate = false;
    requestLightShadowRefresh(light);
    return light;
}

function requestScenePointLightShadowRefresh(root = scene) {
    root?.traverse?.((obj) => {
        if (!obj?.isPointLight || !obj.castShadow) return;
        requestLightShadowRefresh(obj);
    });
}

// Walks the scene and stamps the World Options POM tuning onto every
// DDGI-converted material. Materials without a heightMap stay inert; ones
// with a heightMap get the global enabled flag plus live intensity update.
// Quality changes trigger a TSL recompile via material.syncPomGraphIfStale().
// Perf mode forces enabled=false regardless of user setting.
function applyPomTuningToScene(tuning, root = scene) {
    if (!tuning || !root?.traverse) return;
    const wantEnabled = !!tuning.enabled && !perfModeEnabled;
    const intensity = Math.max(0, Number.isFinite(tuning.intensity) ? tuning.intensity : 0.04);
    const quality = tuning.quality || 'medium';

    root.traverse((obj) => {
        if (!obj.isMesh) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
            if (!m?.isDDGIMeshStandardNodeMaterial) continue;
            // Don't force pomEnabled=true on materials that don't have a
            // heightMap — the material's own rebuild path treats missing
            // heightMap as "disabled" automatically, but flipping the flag
            // anyway wastes a needsUpdate cycle.
            const hasHeight = !!m.heightMap;
            m.pomEnabled = wantEnabled && hasHeight;
            m.pomQuality = quality;
            m.setPomIntensity?.(intensity);
            m.pomIntensity = intensity;
            m.syncPomGraphIfStale?.();
        }
    });
}

// Walks the scene and stamps the World Options shadow tuning onto every
// shadow-casting light. Point + spot + directional all share the same set of
// shadow params so a single panel covers all three. bias/normalBias/radius
// apply immediately. WebGPU shadow render targets cannot be resized safely
// after allocation because RenderTarget.setSize() disposes textures that may
// still be referenced by queued GPU work.
function applyShadowTuningToScene(tuning, root = scene) {
    if (!tuning || !root?.traverse) return;
    const bias = Number.isFinite(tuning.bias) ? tuning.bias : 0.0005;
    const normalBias = Number.isFinite(tuning.normalBias) ? tuning.normalBias : 0.02;
    const radius = Math.max(0, Number.isFinite(tuning.radius) ? tuning.radius : 2.5);
    const mapSize = Math.max(64, Math.min(4096, Number.isFinite(tuning.mapSize) ? (tuning.mapSize | 0) : 512));

    root.traverse((obj) => {
        if (!obj?.castShadow || !obj.shadow) return;
        if (!obj.isPointLight && !obj.isSpotLight && !obj.isDirectionalLight) return;
        obj.shadow.bias = bias;
        if ('normalBias' in obj.shadow) obj.shadow.normalBias = normalBias;
        obj.shadow.radius = radius;
        if (!obj.shadow.map && (obj.shadow.mapSize.x !== mapSize || obj.shadow.mapSize.y !== mapSize)) {
            obj.shadow.mapSize.set(mapSize, mapSize);
        }
        obj.shadow.needsUpdate = true;
    });
    if (renderer?.shadowMap) renderer.shadowMap.needsUpdate = true;

    // Cascaded Shadow Maps on the sun light. Only when shadows are enabled;
    // tuning.csm (default on) + tuning.cascades drive it.
    const wantCSM = tuning.enabled !== false && tuning.csm !== false;
    setMainLightCSM(wantCSM, Math.max(1, Math.min(4, (tuning.cascades | 0) || 3)));
}

function spawnLightActor(kind, { userData = null, position = null, scale = 8, includeScripts = true } = {}) {
    if (!scene || !camera) return null;

    const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const spawnPos = position
        ? position.clone()
        : camera.position.clone().addScaledVector(camDir, 6).add(new THREE.Vector3(0, 0.6, 0));
    const savedLight = userData?.light || {};
    const radius = Number.isFinite(savedLight.radius) && savedLight.radius > 0
        ? savedLight.radius
        : (Number.isFinite(scale) && scale > 0 ? scale : 8);
    const lightColor = new THREE.Color(savedLight.color || 0xfff1c2);
    const intensity = Number.isFinite(savedLight.intensity) && savedLight.intensity > 0
        ? savedLight.intensity
        : 100;
    const distance = Number.isFinite(savedLight.distance) && savedLight.distance > 0
        ? savedLight.distance
        : 500;
    const decay = Number.isFinite(savedLight.decay) && savedLight.decay > 0 ? savedLight.decay : 2.0;
    const angle = Number.isFinite(savedLight.angle) && savedLight.angle > 0 ? savedLight.angle : Math.PI / 6;
    const penumbra = Number.isFinite(savedLight.penumbra) ? savedLight.penumbra : 0.35;
    const castShadow = savedLight.castShadow !== false;

    const group = new THREE.Group();
    group.position.copy(spawnPos);

    const helperMaterial = new THREE.MeshStandardMaterial({
        color: lightColor.clone(),
        emissive: lightColor.clone(),
        emissiveIntensity: 4.5,
        roughness: 0.12,
        metalness: 0.0,
        toneMapped: false,
    });

    const markHelperObject = (object) => {
        if (!object) return object;
        object.traverse((node) => {
            if (!node.userData) node.userData = {};
            node.userData.ddgiSkipCapture = true;
            node.userData.ddgiSkipReceive = true;
            node.userData.ignoreForcedSceneShadows = true;
            if ('castShadow' in node) node.castShadow = false;
            if ('receiveShadow' in node) node.receiveShadow = false;
        });
        return object;
    };

    let light = null;
    if (kind === 'pointLight') {
        const helper = markHelperObject(new THREE.Mesh(
            new THREE.SphereGeometry(Math.max(0.18, radius * 0.08), 20, 16),
            helperMaterial,
        ));
        helper.name = 'point-light-helper';
        group.add(helper);

        const glow = markHelperObject(new THREE.Mesh(
            new THREE.SphereGeometry(Math.max(0.32, radius * 0.14), 28, 20),
            new THREE.MeshBasicMaterial({
                color: lightColor.clone(),
                transparent: true,
                opacity: 0.32,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                toneMapped: false,
            }),
        ));
        glow.name = 'point-light-glow';
        glow.raycast = () => {};
        group.add(glow);

        const rangeViz = markHelperObject(new THREE.Mesh(
            new THREE.SphereGeometry(1, 24, 18),
            new THREE.MeshBasicMaterial({
                color: lightColor.clone(),
                wireframe: true,
                transparent: true,
                opacity: 0.16,
                depthWrite: false,
                toneMapped: false,
            }),
        ));
        rangeViz.name = 'point-light-range';
        rangeViz.userData.lightRangeVisual = true;
        rangeViz.visible = false;
        rangeViz.raycast = () => {};
        group.add(rangeViz);

        light = new THREE.PointLight(lightColor, intensity, distance, decay);
        light.name = 'point-light-source';
        light.castShadow = castShadow;
        configurePointLightShadow(light, {
            mapSize: 512,
            bias: 0.0005,
            normalBias: 0.02,
            radius: 2.5,
        });
        group.add(light);
    } else if (kind === 'spotLight') {
        const housing = markHelperObject(new THREE.Mesh(
            new THREE.CylinderGeometry(0.14, 0.22, 0.38, 18),
            helperMaterial,
        ));
        housing.name = 'spot-light-housing';
        housing.rotation.x = Math.PI * 0.5;
        group.add(housing);

        const cone = markHelperObject(new THREE.Mesh(
            new THREE.ConeGeometry(Math.max(0.18, radius * 0.06), Math.max(0.55, radius * 0.18), 20, 1, true),
            helperMaterial.clone(),
        ));
        cone.name = 'spot-light-helper';
        cone.rotation.x = -Math.PI * 0.5;
        cone.position.z = -Math.max(0.4, radius * 0.12);
        group.add(cone);

        const glow = markHelperObject(new THREE.Mesh(
            new THREE.SphereGeometry(Math.max(0.28, radius * 0.12), 24, 16),
            new THREE.MeshBasicMaterial({
                color: lightColor.clone(),
                transparent: true,
                opacity: 0.28,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                toneMapped: false,
            }),
        ));
        glow.name = 'spot-light-glow';
        glow.raycast = () => {};
        group.add(glow);

        const volumeViz = markHelperObject(new THREE.Mesh(
            new THREE.ConeGeometry(1, 1, 28, 1, true),
            new THREE.MeshBasicMaterial({
                color: lightColor.clone(),
                wireframe: true,
                transparent: true,
                opacity: 0.16,
                depthWrite: false,
                toneMapped: false,
            }),
        ));
        volumeViz.name = 'spot-light-volume';
        volumeViz.userData.lightRangeVisual = true;
        volumeViz.visible = false;
        volumeViz.raycast = () => {};
        volumeViz.rotation.x = -Math.PI * 0.5;
        group.add(volumeViz);

        const aimViz = markHelperObject(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(0, 0, -1),
            ]),
            new THREE.LineBasicMaterial({
                color: lightColor.clone(),
                transparent: true,
                opacity: 0.4,
                depthWrite: false,
                toneMapped: false,
            }),
        ));
        aimViz.name = 'spot-light-aim';
        aimViz.userData.lightRangeVisual = true;
        aimViz.visible = false;
        aimViz.raycast = () => {};
        group.add(aimViz);

        light = new THREE.SpotLight(lightColor, intensity, distance, angle, penumbra, decay);
        light.name = 'spot-light-source';
        light.castShadow = castShadow;
        light.shadow.mapSize.set(1024, 1024);
        light.shadow.bias = 0.0002;
        if ('normalBias' in light.shadow) light.shadow.normalBias = 0.02;
        const target = new THREE.Object3D();
        target.name = 'spot-light-target';
        target.position.set(0, 0, -Math.max(4, radius * 2));
        group.add(target);
        light.target = target;
        group.add(light);
    } else if (kind === 'rectLight') {
        // Rectangular area light — soft panel glow. Width/height taken from
        // saved data (fallback square based on radius). Emits from +Z by
        // default (RectAreaLight faces -Z, so the visible panel sits on +Z).
        const rw = Number.isFinite(savedLight.width) && savedLight.width > 0 ? savedLight.width : Math.max(1.5, radius * 0.5);
        const rh = Number.isFinite(savedLight.height) && savedLight.height > 0 ? savedLight.height : Math.max(0.6, radius * 0.2);

        // Glowing panel so the light source is visible (and blooms).
        const panel = markHelperObject(new THREE.Mesh(
            new THREE.PlaneGeometry(rw, rh),
            new THREE.MeshBasicMaterial({ color: lightColor.clone(), toneMapped: false, side: THREE.DoubleSide }),
        ));
        panel.name = 'rect-light-panel';
        group.add(panel);

        light = new THREE.RectAreaLight(lightColor, intensity, rw, rh);
        light.name = 'rect-light-source';
        // RectAreaLight emits along -Z; rotate so it faces downward by default
        // (ceiling panel). Editors can rotate the actor to re-aim it.
        light.lookAt(0, -1, 0);
        group.add(light);
        // Stash size so it round-trips through userData below.
        savedLight.width = rw;
        savedLight.height = rh;
    }

    if (!light) {
        helperMaterial.dispose();
        return null;
    }

    light.userData.ddgiActorLight = true;
    const mergedUserData = {
        ...(userData || {}),
        light: {
            ...(savedLight || {}),
            kind,
            color: `#${lightColor.getHexString()}`,
            radius,
            intensity,
            distance,
            decay,
            castShadow,
            angle,
            penumbra,
            width: savedLight.width,
            height: savedLight.height,
        },
    };

    const actor = createDynamicPropActor({
        body: null,
        mesh: group,
        kind,
        userData: mergedUserData,
        includeScripts,
    });
    setActorComponentFlags(actor, {
        collision: false,
        physics: false,
        scripts: includeScripts,
    });
    group.traverse((child) => {
        if (!child.isMesh) return;
        child.castShadow = false;
        child.receiveShadow = false;
        child.userData.ddgiSkipCapture = true;
        child.userData.ddgiSkipReceive = true;
        child.userData.ignoreForcedSceneShadows = true;
    });
    syncActorLightHelperVisuals(actor);
    light.target?.updateMatrixWorld?.(true);
    invalidateDDGI(`${kind} spawned`);
    return actor;
}

function destroyDDGIVolumeActor(actor) {
    if (!actor) return;
    const ddgi = getActorDDGIVolumeComponent(actor);
    if (ddgi) {
        try {
            ddgi.endPlay?.();
        } catch (e) {
            console.warn('[DDGI] volume endPlay failed', e);
        }
    }
    sceneSystem?.removeActor?.(actor);
    actor.mesh?.geometry?.dispose?.();
    actor.mesh?.material?.dispose?.();
}

function ensureSampleDDGIVolume(root = currentMesh) {
    if (!scene || !root) return null;
    if (sampleDDGIVolumeActor?.mesh?.parent !== scene) {
        sampleDDGIVolumeActor = null;
    }
    if (sampleDDGIVolumeActor) return sampleDDGIVolumeActor;

    const bounds = new THREE.Box3().setFromObject(root);
    if (bounds.isEmpty()) return null;
    bounds.expandByScalar(1.5);

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const gridDims = {
        x: THREE.MathUtils.clamp(Math.round(size.x / 4), 6, 12),
        y: THREE.MathUtils.clamp(Math.round(size.y / 2), 3, 6),
        z: THREE.MathUtils.clamp(Math.round(size.z / 4), 4, 10),
    };
    const cellSize = Math.max(
        size.x / gridDims.x,
        size.y / gridDims.y,
        size.z / gridDims.z,
        0.4,
    );

    const actor = spawnDDGIVolumeActor({
        userData: { internalSample: true, label: 'Debug Map DDGI Volume' },
        position: center,
        size,
        options: {
            gridDims,
            cellSize,
            intensity: 3.0,
            hysteresis: 0.94,
            normalBias: 0.12,
            probesPerFrame: Math.max(4, WORLD_ENV_DEFAULTS.ddgi.probesPerFrame | 0),
        },
    });
    actor.mesh.name = 'sample-ddgi-volume';
    if (actor.mesh.material) {
        actor.mesh.material.opacity = 0.0;
        actor.mesh.material.transparent = true;
        actor.mesh.material.needsUpdate = true;
    }

    const ddgi = getActorDDGIVolumeComponent(actor);
    if (ddgi) {
        ddgi.containsPoint = (() => {
            const expanded = bounds.clone().expandByScalar(10);
            return (point) => expanded.containsPoint(point);
        })();
        syncDDGIVolumeComponentToActorBounds(ddgi);
    }

    sampleDDGIVolumeActor = actor;
    invalidateDDGI('debug map ddgi volume loaded', 6);
    return actor;
}

function ensureDDGITestVolume(rig) {
    if (!scene || !rig) return null;
    if (ddgiTestVolumeActor?.mesh?.parent !== scene) {
        ddgiTestVolumeActor = null;
    }
    if (!ddgiTestVolumeActor && sceneSystem?.actors?.size) {
        for (const actor of sceneSystem.actors) {
            const mesh = getActorRenderObject(actor);
            if (mesh?.name === 'ddgi-test-volume') {
                ddgiTestVolumeActor = actor;
                break;
            }
        }
    }
    if (ddgiTestVolumeActor) return ddgiTestVolumeActor;

    // Volume mesh is fitted to the Cornell rig — its centre is the room
    // centre, and `activeVolumeAnchor()` uses that to anchor the probe
    // grid inside the box. A custom `containsPoint` override (set after
    // the component is constructed below) widens the activation region
    // so the camera looking *at* the box from outside still selects this
    // volume over the implicit camera-anchored fallback.
    const bounds = new THREE.Box3().setFromObject(rig);
    if (bounds.isEmpty()) return null;
    bounds.expandByScalar(-0.05);

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());

    const gridDims = { x: 6, y: 4, z: 6 };
    // Fit probes *inside* the Cornell room. Using (dims - 1) places the
    // first/last layers directly on the floor, ceiling, and walls, which
    // makes the bottom row read as sunk into the floor slab.
    const cellSize = Math.max(
        size.x / gridDims.x,
        size.y / gridDims.y,
        size.z / gridDims.z,
        0.3,
    );
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(size.x, size.y, size.z),
        new THREE.MeshBasicMaterial({
            color: 0x4dffd2,
            transparent: true,
            opacity: 0.0,
            depthWrite: false,
            toneMapped: false,
            fog: false,
        })
    );
    mesh.name = 'ddgi-test-volume';
    mesh.position.copy(center);
    mesh.userData.ddgiSkipReceive = true;
    mesh.userData.ddgiSkipCapture = true;
    mesh.userData.ignoreForcedSceneShadows = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    const actor = sceneSystem?.createEntity
        ? sceneSystem.createEntity('DDGI Test Volume', {
            register: false,
            kind: 'ddgiVolume',
            userData: { internalSample: true, label: 'DDGI Test Volume' },
        })
        : createActor({
            kind: 'ddgiVolume',
            userData: { internalSample: true, label: 'DDGI Test Volume' },
            name: 'DDGI Test Volume',
        });
    actor.mesh = mesh;
    if (!actor.hasComponent(TransformComponent)) {
        actor.addComponent(new TransformComponent());
    }
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const ddgi = new DDGIVolumeComponent({
        gridDims,
        cellSize,
        // Cranked high enough so coloured bounce visibly fills shadowed
        // regions of the Cornell box. Below this value the patcher's emissiveNode write
        // gets crushed by the bloom HDR mask + ACES tonemap and shadows
        // render pure black even when DDGI is correctly sampling the
        // colour-bled probes above them.
        intensity: 12.0,
        hysteresis: 0.92,
        normalBias: 0.05,
        probesPerFrame: WORLD_ENV_DEFAULTS.ddgi.probesPerFrame,
    });
    // Override containsPoint so the volume is "active" whenever the camera
    // is anywhere reasonable around the Cornell box, not just inside it.
    // The volume mesh stays small (so the grid anchor is the box centre),
    // but the activation footprint is expanded — which keeps the implicit
    // camera-anchored volume from winning when the user looks at the box
    // from outside.
    ddgi.containsPoint = (() => {
        return (point) => {
            const expanded = new THREE.Box3().setFromObject(mesh).expandByScalar(8);
            return expanded.containsPoint(point);
        };
    })();
    actor.addComponent(ddgi);
    ensureActorIdentity(actor);
    ensureActorScriptState(actor);
    sceneSystem?.addActor(actor);
    ddgiTestVolumeActor = actor;
    return actor;
}

function findDDGITestRigActor(rig = null) {
    if (ddgiTestRigActor?.mesh?.parent === scene && (!rig || ddgiTestRigActor.mesh === rig)) {
        return ddgiTestRigActor;
    }
    ddgiTestRigActor = null;
    if (!sceneSystem?.actors?.size) return null;
    for (const actor of sceneSystem.actors) {
        const mesh = getActorRenderObject(actor);
        if (!mesh) continue;
        if (rig ? mesh === rig : mesh.name === 'ddgi-test-rig') {
            ddgiTestRigActor = actor;
            return actor;
        }
    }
    return null;
}

function ensureDDGITestRigActor(rig) {
    if (!scene || !rig) return null;
    const existingActor = findDDGITestRigActor(rig);
    if (existingActor) return existingActor;

    const actor = sceneSystem?.createEntity
        ? sceneSystem.createEntity('Cornell Box', {
            register: false,
            kind: 'cornellBox',
            userData: { internalSample: true, label: 'Cornell Box', ddgiSampleRig: true },
        })
        : createActor({
            kind: 'cornellBox',
            userData: { internalSample: true, label: 'Cornell Box', ddgiSampleRig: true },
            name: 'Cornell Box',
        });
    actor.mesh = rig;
    if (!actor.hasComponent(TransformComponent)) {
        actor.addComponent(new TransformComponent());
    }

    ensureActorIdentity(actor);
    ensureActorScriptState(actor);
    sceneSystem?.addActor(actor);

    const lightPanelMesh = rig.getObjectByName('cornell-light-panel');
    if (lightPanelMesh) lightPanelMesh.castShadow = false;

    ddgiTestRigActor = actor;
    return actor;
}

function ensureDDGITestRig() {
    if (!scene) return null;
    const existing = scene.getObjectByName('ddgi-test-rig');
    if (existing) {
        cornellPanelLight = existing.getObjectByName('cornell-panel-light') || cornellPanelLight;
        ensureDDGITestRigActor(existing);
        ensureDDGITestVolume(existing);
        return existing;
    }

    // Cornell-box test rig matching the ddgi-cornell-box demo geometry:
    // 2.8 m × 2.0 m × 2.8 m room, red left wall, green right wall, white
    // floor / ceiling / back wall, ceiling-mounted emissive panel, one
    // tall white box. Authored at full scale so DDGI bake distances match
    // the standalone reference; rig position lifts the room to sit on the
    // engine's terrain instead of below it.
    const rig = new THREE.Group();
    rig.name = 'ddgi-test-rig';
    rig.userData.ddgiSampleRig = true;
    rig.position.set(0, 0.35, 0);
    rig.scale.setScalar(1.0);

    // Cornell dimensions from the demo: BOX = (1.4, 1.0, 1.4) half-sizes.
    const BX = 1.4, BY = 2.0, BZ = 1.4; // half-widths / full-height
    const T = 0.06; // wall thickness

    const addBox = (name, size, position, materialOptions, { rotationY = 0, castShadow = true, receiveShadow = true } = {}) => {
        // DDGIMeshStandardNodeMaterial subclasses MeshStandardNodeMaterial
        // and overrides setupLightMap to feed our DDGI irradiance node into
        // three.js's indirect-diffuse term. Same pattern as the standalone
        // cornell-box demo. The patcher (in ddgiShaderInjection.js) walks
        // the scene and assigns ddgiIrradianceNode on each instance.
        const mat = new DDGIMeshStandardNodeMaterial(materialOptions);
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(size.x, size.y, size.z),
            mat,
        );
        mesh.name = name;
        mesh.position.copy(position);
        mesh.rotation.y = rotationY;
        mesh.castShadow = castShadow;
        mesh.receiveShadow = receiveShadow;
        rig.add(mesh);
        return mesh;
    };

    // Floor (white)
    addBox('cornell-floor', new THREE.Vector3(BX * 2 + T, T, BZ * 2 + T), new THREE.Vector3(0, T * 0.5, 0), {
        color: 0xeeeeee,
        roughness: 0.95,
        metalness: 0.0,
    });
    // Ceiling (white)
    addBox('cornell-ceiling', new THREE.Vector3(BX * 2 + T, T, BZ * 2 + T), new THREE.Vector3(0, BY - T * 0.5, 0), {
        color: 0xeeeeee,
        roughness: 0.95,
        metalness: 0.0,
    });
    // Back wall (white)
    addBox('cornell-back-wall', new THREE.Vector3(BX * 2 + T, BY, T), new THREE.Vector3(0, BY * 0.5, -BZ - T * 0.5), {
        color: 0xeeeeee,
        roughness: 0.95,
        metalness: 0.0,
    });
    // Left wall (saturated red — strong albedo so colour bleed is visible).
    const leftWall = addBox('cornell-left-wall', new THREE.Vector3(T, BY, BZ * 2 + T), new THREE.Vector3(-BX - T * 0.5, BY * 0.5, 0), {
        color: 0xc81e1e,
        roughness: 0.95,
        metalness: 0.0,
    });
    // Right wall (saturated green).
    const rightWall = addBox('cornell-right-wall', new THREE.Vector3(T, BY, BZ * 2 + T), new THREE.Vector3(BX + T * 0.5, BY * 0.5, 0), {
        color: 0x1ec81e,
        roughness: 0.95,
        metalness: 0.0,
    });
    // (Previously the coloured walls had ddgiSkipReceive=true to dodge the
    // old patcher's colorNode rewrite that desaturated their albedo. The
    // new DDGIMeshStandardNodeMaterial subclass never touches colorNode —
    // GI flows in through setupLightMap → IrradianceNode → indirect-diffuse
    // — so the walls now receive GI normally, which is what a Cornell box
    // colour-bleed test needs.)

    // Tall white box, slightly rotated (matches the Cornell reference).
    addBox('cornell-tall-block', new THREE.Vector3(0.85, 1.30, 0.85), new THREE.Vector3(0.35, 0.65, 0.20), {
        color: 0xeeeeee,
        roughness: 0.85,
        metalness: 0.0,
    }, {
        rotationY: Math.PI * 0.08,
    });

    // Ceiling light panel — modest emission so the engine's bloom and
    // tonemapping don't blow walls out to white. Visible bright shape,
    // not the actual primary light.
    addBox('cornell-light-panel', new THREE.Vector3(0.7, 0.02, 0.7), new THREE.Vector3(0, BY - T - 0.011, 0), {
        color: 0x000000,
        emissive: 0xfff4dd,
        emissiveIntensity: 3.0,
        roughness: 0.5,
        metalness: 0.0,
    }, {
        castShadow: false,
    });

    // Point light at the panel position — primary direct illumination so
    // walls pick up colour-tintable diffuse light that DDGI can then
    // bounce. Intensity sized to give walls a comfortable mid-tone (not
    // pure white) so the colour albedo survives.
    cornellPanelLight = new THREE.PointLight(0xfff4dd, WORLD_ENV_DEFAULTS.ddgi.lightIntensity, 8.0, 1.5);
    cornellPanelLight.name = 'cornell-panel-light';
    cornellPanelLight.position.set(0, BY - 0.15, 0);
    cornellPanelLight.castShadow = true;
    configurePointLightShadow(cornellPanelLight, {
        mapSize: 512,
        bias: 0.002,
        normalBias: 0.02,
        radius: 2.5,
    });
    rig.add(cornellPanelLight);

    ensureDDGITestRigActor(rig);
    ensureDDGITestVolume(rig);
    return rig;
}

function clearGrassAroundDDGITestRig() {
    if (!grassField || !worldFloor) return;
    const rig = scene?.getObjectByName('ddgi-test-rig');
    if (!rig) return;
    const bounds = new THREE.Box3().setFromObject(rig);
    if (bounds.isEmpty()) return;
    bounds.expandByScalar(0.8);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const localCenter = worldFloor.worldToLocal(center.clone());
    grassField.paintFoliage?.({
        terrain: worldFloor,
        localX: localCenter.x,
        localY: localCenter.y,
        radius: Math.max(size.x, size.z) * 0.62,
        mode: 'erase',
        type: 'grass',
    });
}

/**
 * Cast & draw debug rays from a single probe near the Cornell green wall.
 * Lines coloured by the surface their ray hits (red wall = red lines,
 * green wall = green lines, etc). Hit-point spheres at each intersection.
 * The probe origin is positioned just inside the green-wall boundary so
 * the rays hitting the green wall are clearly visible up close.
 */
function updateCornellRayDebug() {
    if (!worldEnvState?.ddgi?.rayDebug) {
        if (cornellRayDebug) {
            cornellRayDebug.setVisible(false);
            cornellRayDebug.clear();
        }
        return;
    }
    if (!scene) return;
    const rig = scene.getObjectByName('ddgi-test-rig');
    if (!rig) {
        if (cornellRayDebug) cornellRayDebug.clear();
        return;
    }

    if (!cornellRayDebug) {
        const ddgiManager = getDDGIManager();
        const debugLayer = ddgiManager?.getDebugLayer?.() ?? 30;
        cornellRayDebug = createDDGIRayDebug({ scene, layer: debugLayer });
        cornellRayDebug.setVisible(true);
    }

    // Probe origin: 0.4m inboard of the green (right) wall, mid-height,
    // centred along z. Pinned in *rig-local* space so it follows the rig.
    cornellRayDebugOrigin.set(1.0, 1.0, 0.0);
    rig.localToWorld(cornellRayDebugOrigin);

    // Collect cornell rig meshes as raycast targets; exclude the panel
    // light's own mesh so rays hitting the panel show its bright albedo.
    const targets = [];
    rig.traverse((obj) => {
        if (obj.isMesh && obj.userData?.ddgiSampleRig !== true) {
            // ddgiSampleRig is set on the rig group; mesh children
            // don't have it. We *do* want them.
        }
        if (obj.isMesh) targets.push(obj);
    });

    cornellRayDebug.update(cornellRayDebugOrigin, targets);
}

function applyCornellTestPreset() {
    setPerfModeEnabled(false);
    worldEnvState.sky.enabled = false;
    worldEnvState.ambient.enabled = false;
    worldEnvState.hemi.enabled = false;
    worldEnvState.sun.enabled = false;
    worldEnvState.bloom.enabled = false;
    worldEnvState.ssgi.enabled = false;
    worldEnvState.fog.enabled = false;
    worldEnvState.shadows.enabled = true;
    worldEnvState.tonemap.exposure = 1.0;
    worldEnvState.ddgi.enabled = true;
    worldEnvState.ddgi.liveBake = true;
    worldEnvState.ddgi.bakeEveryN = 1;
    worldEnvState.ddgi.probesPerFrame = 1;
    worldEnvState.ddgi.intensity = WORLD_ENV_DEFAULTS.ddgi.intensity;
    worldEnvState.ddgi.debugProbes = false;
    worldEnvState.ddgi.contributionView = false;
    applyWorldEnvState();
    if (!gameplay.active) {
        resetShowcaseCamera(false);
    }
}

function spawnActorFromEditor({ openScriptEditor = false } = {}) {
    const kind = actorKindSelect?.value || 'sphere';
    const includeCollisionBody = kind === 'vehicle' ? true : !!actorComponentCollisionInput?.checked;
    const simulatePhysics = kind === 'vehicle' ? true : !!actorComponentPhysicsInput?.checked;
    const includeScripts = !!actorComponentScriptsInput?.checked;
    const parsedScale = Number.parseFloat(actorScaleInput?.value ?? '0.5');
    const scaleDefault = Number.parseFloat(getActorKindDefaultScale(kind));
    const scale = Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : scaleDefault;
    const displayName = actorLabelInput?.value?.trim() || '';
    const userData = displayName ? { label: displayName } : undefined;
    let actor = null;

    if (kind === 'vehicle') {
        const bodyTemplateId = actorVehicleBodyTemplateSelect?.value || '';
        const wheelTemplateId = actorVehicleWheelTemplateSelect?.value || '';
        actor = spawnDrivableCar({ includeScripts, userData, bodyTemplateId, wheelTemplateId });
    } else if (kind === 'ddgiVolume') {
        actor = spawnDDGIVolumeActor({ userData });
    } else if (isLightActorKind(kind)) {
        actor = spawnLightActor(kind, { userData, scale, includeScripts });
    } else if (kind === 'imported') {
        const templateId = actorImportedTemplateSelect?.value || '';
        if (!templateId) {
            syncActorEditorUi();
            return null;
        }

        actor = spawnImportedProp(templateId, {
            includeCollisionBody,
            simulatePhysics,
            includeScripts,
            userData,
        });
    } else {
        actor = spawnDynamicPrimitive(kind, undefined, scale, {
            includeCollisionBody,
            simulatePhysics,
            includeScripts,
            userData,
            returnActor: true,
        });
    }

    if (!actor) {
        if (actorEditorStatus) {
            actorEditorStatus.textContent = 'Actor creation failed.';
        }
        return null;
    }

    const actorColorInput = document.getElementById('actor-color-input');
    const actorColorEnabled = document.getElementById('actor-color-enabled');
    if (actorColorInput && actorColorEnabled?.checked) {
        setActorColor(actor, actorColorInput.value);
    }

    closeActorEditor();

    if (openScriptEditor) {
        ensureActorScriptState(actor);
        selectShowcaseActor(actor.id);
        openObjectScriptEditor('tick');
    }

    return actor;
}

// === extracted: objectEvents (was lines 4261-4923 of original main.js) ===

// Debug visualization (raycast line + collision overlays) extracted to
// ../debug/overlays.js. Eager wiring: setCollisionDebugEnabled is needed
// as a dep by inputPanels (wired earlier). scene/sceneSystem via appCore.
const _debugOverlays = createDebugOverlays({
    collisionDebugState, raycastDebugState, tempVectorC,
    getActorComponentFlags, pushDebugConsoleLine,
    getActorRenderObject, getImportedTemplate, getVehicleVisualBounds,
    isObjectWithinRoot, markDDGISkipCapture,
});
const ensureRaycastDebugLine = _debugOverlays.ensureRaycastDebugLine;
const updateRaycastDebugLine = _debugOverlays.updateRaycastDebugLine;
const updateRaycasterDebugLine = _debugOverlays.updateRaycasterDebugLine;
const tickRaycastDebugLine = _debugOverlays.tickRaycastDebugLine;
const createCollisionLineSegments = _debugOverlays.createCollisionLineSegments;
const createCollisionOverlayFromObject = _debugOverlays.createCollisionOverlayFromObject;
const buildWorldCollisionOverlay = _debugOverlays.buildWorldCollisionOverlay;
const createImportedSimpleCollisionOverlay = _debugOverlays.createImportedSimpleCollisionOverlay;
const buildActorCollisionOverlay = _debugOverlays.buildActorCollisionOverlay;
const disposeCollisionOverlayObject = _debugOverlays.disposeCollisionOverlayObject;
const clearCollisionDebugOverlays = _debugOverlays.clearCollisionDebugOverlays;
const refreshCollisionDebugOverlays = _debugOverlays.refreshCollisionDebugOverlays;
const setCollisionDebugEnabled = _debugOverlays.setCollisionDebugEnabled;

/**
 * World-space raycast exposed to scripts and tools (e.g., the Physgun).
 * Wraps physicsCore.castRay and attaches the owning actor for the hit body.
 *
 * @param {{x,y,z}} origin     World-space ray start.
 * @param {{x,y,z}} direction  Unit direction vector.
 * @param {number} [maxDist=1000]
 * @returns {{hit:boolean, point?:{x,y,z}, normal?:{x,y,z}, distance?:number, actor?:object|null, bodyId?:number}}
 */
function raycastWorld(origin, direction, maxDist = 1000) {
    if (!physicsCore?.castRay) return { hit: false };
    const distance = Number(maxDist);
    const safeDistance = Number.isFinite(distance) && distance > 0 ? distance : 1000;
    const result = physicsCore.castRay(origin, direction, safeDistance);
    updateRaycastDebugLine(origin, direction, safeDistance, result?.point ?? null, !!result?.hit);
    if (!result?.hit) return { hit: false };
    return { ...result, actor: getActorByBodyId(result.bodyId) };
}

function describeRaycastHit(result) {
    if (!result?.hit) {
        return {
            key: 'miss',
            message: 'Debug ray hit nothing.',
        };
    }

    const actor = result.actor ?? null;
    const actorLabel = actor?.userData?.label || actor?.rootNode?.name || actor?.name || actor?.id || '';
    const kind = actor?.kind || 'world-static';
    const distance = Number.isFinite(result.distance) ? result.distance.toFixed(2) : 'unknown';
    const targetLabel = actorLabel || `body ${result.bodyId ?? 'unknown'}`;

    return {
        key: `${actor?.id || 'world-static'}:${distance}`,
        message: `Debug ray hit ${targetLabel} (${kind}) at ${distance}m.`,
    };
}

function logGameplayDebugRayHit(result) {
    if (!raycastDebugState.enabled) {
        return;
    }

    const description = describeRaycastHit(result);
    if (description.key === raycastDebugState.lastConsoleHitKey) {
        return;
    }

    raycastDebugState.lastConsoleHitKey = description.key;
    console.log(description.message, result);
}

function updateGameplayDebugRay() {
    if (!raycastDebugState.enabled || !gameplay.active || !camera) {
        if (raycastDebugState.helper) {
            raycastDebugState.helper.visible = false;
        }
        if (raycastDebugState.hitMarker) {
            raycastDebugState.hitMarker.visible = false;
        }
        raycastDebugState.lastConsoleHitKey = '';
        return;
    }

    const { origin, direction } = physgunCameraRay();
    const result = raycastWorld(origin, direction, 50);
    logGameplayDebugRayHit(result);
}

function setRayDebugEnabled(isEnabled) {
    raycastDebugState.enabled = !!isEnabled;
    raycastDebugState.lastConsoleHitKey = '';

    if (!raycastDebugState.enabled) {
        if (raycastDebugState.helper) {
            raycastDebugState.helper.visible = false;
        }
        if (raycastDebugState.hitMarker) {
            raycastDebugState.hitMarker.visible = false;
        }
    }
}

function formatShadowDebugStatus() {
    const lastPassSuffix = shadowDebugState.lastAppliedAt > 0
        ? ` Last pass hit ${shadowDebugState.lastMeshCount} mesh${shadowDebugState.lastMeshCount === 1 ? '' : 'es'}, changed ${shadowDebugState.lastUpdatedCount}, armed ${shadowDebugState.lastLightCount} shadow light${shadowDebugState.lastLightCount === 1 ? '' : 's'}.`
        : '';

    if (shadowDebugState.forceAllMeshes) {
        return `Auto force is on. New scene meshes get swept every ${Math.round(shadowDebugState.autoApplyIntervalMs)} ms.${lastPassSuffix}`;
    }

    if (shadowDebugState.lastAppliedAt > 0) {
        return `Auto force is off.${lastPassSuffix}`;
    }

    return 'Auto force is off. Apply Now runs one scene-wide shadow pass without keeping it enabled.';
}

function updateShadowDebugUi() {
    if (!shadowDebugUiRefs) return;

    shadowDebugUiRefs.forceOffBtn?.classList.toggle('viewer-toggle-btn-active', !shadowDebugState.forceAllMeshes);
    shadowDebugUiRefs.forceOnBtn?.classList.toggle('viewer-toggle-btn-active', shadowDebugState.forceAllMeshes);

    if (shadowDebugUiRefs.status) {
        shadowDebugUiRefs.status.textContent = formatShadowDebugStatus();
    }
}

function isShadowForceExcludedObject(object) {
    let current = object;
    while (current) {
        if (current.userData?.ignoreForcedSceneShadows) {
            return true;
        }
        current = current.parent ?? null;
    }

    return object?.name === 'tire-skid-ribbon';
}

function forceAllSceneMeshShadows() {
    if (!scene?.traverse) {
        shadowDebugState.lastAppliedAt = performance.now();
        shadowDebugState.lastMeshCount = 0;
        shadowDebugState.lastUpdatedCount = 0;
        shadowDebugState.lastLightCount = 0;
        updateShadowDebugUi();
        return {
            meshCount: 0,
            updatedCount: 0,
            shadowLightCount: 0,
        };
    }

    let meshCount = 0;
    let updatedCount = 0;
    let shadowLightCount = 0;

    scene.traverse((object) => {
        if (!object) return;

        if (object.isMesh) {
            if (isShadowForceExcludedObject(object)) {
                return;
            }

            meshCount += 1;

            if (!object.castShadow || !object.receiveShadow) {
                updatedCount += 1;
            }

            object.castShadow = true;
            object.receiveShadow = true;
            return;
        }

        if (object.isDirectionalLight || object.isSpotLight || object.isPointLight) {
            if (!object.castShadow) {
                shadowLightCount += 1;
            }
            object.castShadow = true;
        }
    });

    if (renderer?.shadowMap) {
        renderer.shadowMap.enabled = true;
    }

    shadowDebugState.lastAppliedAt = performance.now();
    shadowDebugState.lastMeshCount = meshCount;
    shadowDebugState.lastUpdatedCount = updatedCount;
    shadowDebugState.lastLightCount = shadowLightCount;
    updateShadowDebugUi();

    return {
        meshCount,
        updatedCount,
        shadowLightCount,
    };
}

function setForceAllSceneMeshShadowsEnabled(isEnabled) {
    shadowDebugState.forceAllMeshes = !!isEnabled;
    const result = shadowDebugState.forceAllMeshes ? forceAllSceneMeshShadows() : null;
    updateShadowDebugUi();
    return result;
}

function updatePerfModeUi() {
    if (!perfModeUiRefs) return;
    perfModeUiRefs.offBtn?.classList.toggle('viewer-toggle-btn-active', !perfModeEnabled);
    perfModeUiRefs.onBtn?.classList.toggle('viewer-toggle-btn-active', perfModeEnabled);
    if (perfModeUiRefs.status) {
        perfModeUiRefs.status.textContent = perfModeEnabled
            ? 'Performance mode on. SSGI, volumetric fog, and post-process bloom are paused.'
            : 'Performance mode off. Full SSGI + fog + post-process active.';
    }
}

function setExampleWidgetsVisible(visible) {
    if (!window.exampleWidgets) return;
    Object.values(window.exampleWidgets).forEach((widget) => {
        widget?.SetVisibility?.(visible);
    });
}

// Performance toggle: turn DDGI, volumetric fog, and post-process bloom off
// (or on) at runtime without changing engine defaults. Each subsystem owns its
// own enabled flag — we flip those here AND also gate the per-frame update
// calls in the main render loop, so flipping this saves both render work and
// CPU update work.
function setPerfModeEnabled(isEnabled) {
    perfModeEnabled = !!isEnabled;
    // Perf mode pauses the per-frame light cull (frame loop guards on it); make
    // sure any lights it dimmed are restored so they don't stay dark while paused.
    if (perfModeEnabled) { try { lightCull.restoreAll(); } catch (e) {} }
    applyWorldEnvState({ persist: false, switchSky: false });
    updatePerfModeUi();
}

function getDefaultRendererPixelRatioCap() {
    return mobileState.enabled ? 1.25 : 2;
}

function applyRenderResolutionSettings(settings = worldEnvState?.renderResolution) {
    if (!renderer || !container) return;
    const devicePixelRatio = Math.max(1, Number(window.devicePixelRatio) || 1);
    const baseCap = getDefaultRendererPixelRatioCap();
    const enabled = !!settings?.enabled;
    const scale = enabled
        ? THREE.MathUtils.clamp(Number(settings?.scale) || 1, 1, 1.75)
        : 1;
    const maxDpr = enabled
        ? THREE.MathUtils.clamp(Number(settings?.maxDpr) || baseCap, baseCap, 3)
        : baseCap;
    renderer.setPixelRatio(Math.min(devicePixelRatio * scale, maxDpr));
    renderer.setSize(container.clientWidth, container.clientHeight);
}

// ──────────────────────────────────────────────────────────
//  World Environment panel — Godot-style global graphics inspector
// ──────────────────────────────────────────────────────────

// World env load/save/apply/UI all live in _worldEnvSystem (aliased below).
const loadWorldEnvFromStorage = _worldEnvSystem.loadWorldEnvFromStorage;
const saveWorldEnvToStorage = _worldEnvSystem.saveWorldEnvToStorage;
const shouldUsePostProcessingPipeline = _worldEnvSystem.shouldUsePostProcessingPipeline;
const rebuildPostProcessingOutputNode = _worldEnvSystem.rebuildPostProcessingOutputNode;
const applySSGISettings = _worldEnvSystem.applySSGISettings;
const applySSAOSettings = _worldEnvSystem.applySSAOSettings;
const applyWorldEnvState = _worldEnvSystem.applyWorldEnvState;
const updateWorldEnvUi = _worldEnvSystem.updateWorldEnvUi;
const setWorldEnvMaster = _worldEnvSystem.setWorldEnvMaster;
const resetWorldEnvDefaults = _worldEnvSystem.resetWorldEnvDefaults;


function tickForceAllSceneMeshShadows() {
    if (!shadowDebugState.forceAllMeshes) return;
    if ((performance.now() - shadowDebugState.lastAppliedAt) < shadowDebugState.autoApplyIntervalMs) return;
    forceAllSceneMeshShadows();
}

// ──────────────────────────────────────────────────────────
//  Physgun (GMod-style grab/push/pull/fling tool)
// ──────────────────────────────────────────────────────────

const physgun = createPhysgunController({
    getCamera: () => camera,
    getGameplay: () => gameplay,
    raycastWorld,
    getActorBody,
    getActorRenderObject,
    PhysicsComponent,
});
const physgunState = physgun.state;
const physgunAdjustDistance = physgun.adjustDistance;
const physgunCameraRay = physgun.cameraRay;
const physgunFlingHeld = physgun.flingHeld;
const physgunGrabFromCamera = physgun.grabFromCamera;
const physgunPunt = physgun.punt;
const physgunReleaseHeld = physgun.releaseHeld;
const physgunSetEquipped = physgun.setEquipped;
const tickPhysgun = physgun.tick;

/**
 * Reset BeginPlay bookkeeping on every actor's lifecycle scripts so that
 * BeginPlay re-fires on each Edit→Play transition. Called from gameplay entry.
 */
function resetAllScriptLifecycleHandles() {
    resetActorScriptLifecycleHandles(physics.dynamicBodies, getActorScriptState);
}

function handleObjectScriptGlobalPointerDown(event) {
    const clickedInsideMenu = objectScriptMenu && !objectScriptMenu.hidden && objectScriptMenu.contains(event.target);
    const clickedInsideEditor = objectScriptEditor && !objectScriptEditor.hidden && objectScriptEditor.contains(event.target);

    if (!clickedInsideMenu && objectScriptState.menuOpen) {
        closeObjectScriptMenu();
    }

    if (!clickedInsideEditor && objectScriptState.editorOpen && event.target !== renderer?.domElement) {
        closeObjectScriptEditor();
    }
}

function handleObjectScriptKeydown(event) {
    if (event.key !== 'Escape') return;

    if (debugConsoleState.visible) {
        return;
    }

    if (objectScriptState.menuOpen) {
        closeObjectScriptMenu();
    }

    if (objectScriptState.editorOpen) {
        closeObjectScriptEditor();
    }
}

// === extracted: mouseActions (was lines 5698-5923 of original main.js) ===
const container = document.getElementById('canvas-container');
const processingOverlay = document.getElementById('processing-overlay');
const loaderBar = document.getElementById('loader-bar');
const processingStep = document.getElementById('processing-step');
const processTrigger = document.getElementById('process-trigger');
const downloadBtn = document.getElementById('download-asset');

// Showcase asset pipeline: drag-drop to load a model, optimize/export GLB.
// Extracted to ../optim/showcaseOptimizer.js. Factory deps captured by
// closure so the hoisted runtime helpers (clearCurrentMesh, etc.) resolve
// live at call time. Three placeholder aliases keep call sites elsewhere
// unchanged.
const _showcaseOptimizer = createShowcaseOptimizer({
    container,
    clearCurrentMesh: (...args) => clearCurrentMesh(...args),
    normalizeCurrentMesh: (...args) => normalizeCurrentMesh(...args),
    refreshGameplayWorld: (...args) => refreshGameplayWorld(...args),
    playObjectAnimation: (...args) => playObjectAnimation(...args),
    countTrianglesForObject: (...args) => countTrianglesForObject(...args),
});
const enableOptimizationPipeline = _showcaseOptimizer.enableOptimizationPipeline;
const updateLoadedAssetStats = _showcaseOptimizer.updateLoadedAssetStats;
const setupDropHandlers = _showcaseOptimizer.setupDropHandlers;

function setCameraMode(mode) {
    if (mode === 'play') {
        closeObjectScriptMenu();
        closeObjectScriptEditor();
        if (!gameplay.canPlay && physics.ready) {
            gameplay.canPlay = true;
            ensurePlayerCharacter();
            updateGameplayUI();
        }
        if (!gameplay.active && !gameplay.pointerLocked) {
            enterGameplay();
        }
        return;
    }

    exitGameplay();
    resetShowcaseCamera(true);
}

function updateCameraModeButtons() {
    if (showcaseModeBtn) {
        showcaseModeBtn.classList.toggle('viewer-toggle-btn-active', !gameplay.active);
    }

    if (playModeBtn) {
        playModeBtn.disabled = !gameplay.canPlay;
        playModeBtn.classList.toggle('btn-disabled', !gameplay.canPlay);
        playModeBtn.classList.toggle('viewer-toggle-btn-active', gameplay.active);
    }
}

// Input-reset helpers extracted to ../gameplay/inputReset.js
const _inputReset = createInputReset({
    showcase, gameplay, physics,
    resetMobileMovePad: (...a) => resetMobileMovePad?.(...a),
    resetMobileLookPad: (...a) => resetMobileLookPad?.(...a),
});
const resetMovementInputState = _inputReset.resetMovementInputState;
const resetMobileInputState = _inputReset.resetMobileInputState;
const isEditableElement = _isEditableElement;

// === extracted: debugConsole (was lines 5985-6468 of original main.js) ===
// === extracted: mobileControls (was lines 6469-6741 of original main.js) ===

function getActorCoreInfo(actor) {
    return actor?.userData?.actorCore ?? null;
}

function getActorCoreId(actor) {
    const core = getActorCoreInfo(actor);
    return core?.coreId || actor?.id || '';
}

function actorInheritsCore(actor) {
    const core = getActorCoreInfo(actor);
    return core?.inheritsRules === true && !!core.coreId && core.coreId !== actor?.id;
}

function getActorCoreSource(actor) {
    const coreId = getActorCoreId(actor);
    return coreId && coreId !== actor?.id ? getDynamicPropById(coreId) || actor : actor;
}

function serializeCoreVisualRules(actor) {
    const mesh = getActorRenderObject(actor);
    if (!mesh) return null;
    return {
        rootMaterial: serializeObjectMaterialState(mesh),
        materialOverrides: serializeObjectMaterialOverrides(mesh),
        components: serializeComponentTree(mesh),
    };
}

function applyCoreVisualRulesToInstance(instanceActor, rules) {
    const mesh = getActorRenderObject(instanceActor);
    if (!mesh || !rules) return;
    applyObjectMaterialState(mesh, rules.rootMaterial);
    if (Array.isArray(rules.materialOverrides) && rules.materialOverrides.length > 0) {
        applyObjectMaterialOverrides(mesh, rules.materialOverrides);
    }
    deserializeComponentTree(mesh, JSON.parse(JSON.stringify(rules.components || [])));
    mesh.userData.hasMaterialOverrides = true;
    mesh.updateMatrixWorld(true);
    if (!gameplay.active) {
        rebuildActorPhysics(instanceActor);
    }
}

// Reused per-frame buckets for syncActorCoreInstances; module-scoped to avoid
// per-frame allocation. Cleared at the top of each call.
const _coreInstanceBuckets = new Map(); // coreId -> instance actor[]
function syncActorCoreInstances() {
    if (!sceneSystem?.actors?.size) return;

    const buckets = _coreInstanceBuckets;
    buckets.clear();

    // Single pass: partition into cores (bucket keys) and instances (bucket values).
    // Core actors get an empty bucket so we can prune stale entries below.
    for (const actor of sceneSystem.actors) {
        if (actorInheritsCore(actor)) {
            const sourceId = getActorCoreSource(actor)?.id;
            if (!sourceId) continue;
            let list = buckets.get(sourceId);
            if (!list) {
                list = [];
                buckets.set(sourceId, list);
            }
            list.push(actor);
        } else if (!buckets.has(actor.id)) {
            buckets.set(actor.id, null);
        }
    }

    // Prune sync state for cores that no longer exist.
    for (const coreId of actorCoreSyncState.keys()) {
        if (!buckets.has(coreId)) actorCoreSyncState.delete(coreId);
    }

    // Apply rules per core that actually has instances linked to it.
    for (const [coreId, linked] of buckets) {
        if (!linked || linked.length === 0) continue;
        const coreActor = getDynamicPropById(coreId);
        if (!coreActor) continue;
        const rules = serializeCoreVisualRules(coreActor);
        if (!rules) continue;
        const signature = JSON.stringify(rules);
        const cached = actorCoreSyncState.get(coreId);
        if (cached && cached.signature === signature) continue;
        if (cached) cached.signature = signature;
        else actorCoreSyncState.set(coreId, { signature });
        for (let i = 0; i < linked.length; i++) {
            applyCoreVisualRulesToInstance(linked[i], rules);
        }
    }
}


// Scene-actor UI extracted to ../ui/sceneActorUi.js. Eager wiring (called
// indirectly by many functions; const aliases at this site must exist
// before those functions execute at runtime). camera/sceneSystem/
// sceneUiList/sceneUiCount/transformControl via appCore.
const _sceneActorUi = createSceneActorUi({
    actorPhysicsEditorState, blueprintState, collisionDebugState,
    gameplay, objectScriptState,
    actorInheritsCore, focusSceneActor, getActorCoreSource,
    DDGIVolumeComponent, enterBlueprintEditor, exportActorToFile,
    getActorComponentFlags, getDynamicPropById, refreshBlueprintComponents,
    setActorColor,
    applyShowcaseCameraRotation, buildActorCollisionOverlay,
    disposeCollisionOverlayObject, getActorRenderObject, getDDGIManager,
    invalidateDDGI, rebuildActorPhysics, refreshCollisionDebugOverlays,
    refreshGameplayWorld, requestLightShadowRefresh, selectShowcaseActor,
    syncShowcaseAnglesFromTarget, syncTransformToPhysics,
});
const buildCollisionBoxComponent = _sceneActorUi.buildCollisionBoxComponent;
const getActorPhysicsSettings = _sceneActorUi.getActorPhysicsSettings;
const clearActorPhysicsPreview = _sceneActorUi.clearActorPhysicsPreview;
const refreshActorPhysicsPreview = _sceneActorUi.refreshActorPhysicsPreview;
const setActorPhysicsPreview = _sceneActorUi.setActorPhysicsPreview;
const applyActorPhysicsSettings = _sceneActorUi.applyActorPhysicsSettings;
const syncBlueprintPhysicsEditor = _sceneActorUi.syncBlueprintPhysicsEditor;
const applyBlueprintPhysicsEditor = _sceneActorUi.applyBlueprintPhysicsEditor;
const getSceneActorDetailsRefs = _sceneActorUi.getSceneActorDetailsRefs;
const getSelectedSceneActor = _sceneActorUi.getSelectedSceneActor;
const getActorDDGIVolumeComponent = _sceneActorUi.getActorDDGIVolumeComponent;
const getActorLightObject = _sceneActorUi.getActorLightObject;
const syncActorLightStateFromObject = _sceneActorUi.syncActorLightStateFromObject;
const syncActorLightHelperVisuals = _sceneActorUi.syncActorLightHelperVisuals;
const updateLightRangeVisualVisibility = _sceneActorUi.updateLightRangeVisualVisibility;
const syncDDGIVolumeComponentToActorBounds = _sceneActorUi.syncDDGIVolumeComponentToActorBounds;
const updateSceneActorDetailsTransformButtons = _sceneActorUi.updateSceneActorDetailsTransformButtons;
const updateSceneActorDetailsUI = _sceneActorUi.updateSceneActorDetailsUI;
const applySceneActorTransformDetailsFromUI = _sceneActorUi.applySceneActorTransformDetailsFromUI;
const applySceneActorDDGIDetailsFromUI = _sceneActorUi.applySceneActorDDGIDetailsFromUI;
const applySceneActorLightDetailsFromUI = _sceneActorUi.applySceneActorLightDetailsFromUI;
const createSceneActorItem = _sceneActorUi.createSceneActorItem;
const refreshSceneUI = _sceneActorUi.refreshSceneUI;

// --- Initialization ---
async function init() {
    const assets = registerCoreAssets();
    assets.setImportedTemplatesProvider(() => importedPropState.templates);
    registerBuiltinPrefabs();
    await loadPrefabManifest();
    registerDebug('assets', assets);
    registerDebug('prefabs', prefabRegistry);

    // Phase 0 dev gate: `?bench=cull` runs the throwaway cull benchmark in
    // full isolation (its own renderer/scene/camera) and skips the entire
    // game boot. See plan the-nullgraph-engine-data-oriented-*.md. Removed
    // when Phase 0 concludes.
    if (new URLSearchParams(location.search).get('bench') === 'cull') {
        const { runCullBench } = await import('../dev/cullBench.js');
        await runCullBench();
        return;
    }

    // Mobile Detection (full applyMobileModeState runs after wireExtractedModules
    // because it depends on injected refs in src/debug/console.js)
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.matchMedia('(pointer: coarse)').matches;
    mobileState.detected = isMobile;
    mobileState.forced = false;
    mobileState.enabled = isMobile;
    document.body.classList.toggle('is-mobile', isMobile);

    // Hard guard: on a touch device, neuter requestPointerLock so NO code path
    // (engine, Drug Tycoon, Rogue, resume overlays) can trigger the OS "switch
    // apps / show your cursor" prompt that breaks touch gameplay. Touch has no
    // cursor to lock. Wrapped in try/catch + writability check because the
    // prototype property can be non-writable in some engines (assigning would
    // throw under ESM strict mode and abort init — which broke the start screen).
    if (isMobile && typeof Element !== 'undefined' && Element.prototype.requestPointerLock) {
        try {
            Object.defineProperty(Element.prototype, 'requestPointerLock', {
                value: function noopPointerLock() { /* disabled on touch */ },
                writable: true,
                configurable: true,
            });
        } catch (e) {
            console.warn('[mobile] could not disable requestPointerLock; relying on per-call guards', e);
        }
    }

    // Add listeners immediately so UI is responsive even if WASM is loading
    document.getElementById('load-level')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const levelId = document.getElementById('level-select')?.value || 'soccerField';
        mobileState.launchedFromGames = false;
        loadSample(levelId);
    });

    browseModelBtn = document.getElementById('open-model-menu');
    sceneUiPanel = document.getElementById('scene-ui-panel');
    sceneUiCount = document.getElementById('scene-ui-count');
    sceneUiList = document.getElementById('scene-ui-list');
    showcaseModeBtn = document.getElementById('camera-showcase');
    playModeBtn = document.getElementById('camera-play');
    mobilePreviewOnBtn = document.getElementById('mobile-preview-on');
    desktopMobileToggleBtn = document.getElementById('desktop-mobile-toggle');
    openActorEditorBtn = document.getElementById('open-actor-editor');
    playTestSoundBtn = document.getElementById('play-test-sound-btn');
    playTestSoundStatus = document.getElementById('play-test-sound-status');
    multiplayerServerUrlInput = document.getElementById('multiplayer-server-url');
    multiplayerRoomInput = document.getElementById('multiplayer-room');
    multiplayerConnectBtn = document.getElementById('multiplayer-connect');
    multiplayerDisconnectBtn = document.getElementById('multiplayer-disconnect');
    multiplayerStatusValue = document.getElementById('multiplayer-status');
    multiplayerPlayerCountValue = document.getElementById('multiplayer-player-count');
    importPropBtn = document.getElementById('import-prop-menu');
    propFileInput = document.getElementById('prop-file-input');
    importedPropList = document.getElementById('imported-prop-list');
    importedPropLibrary = document.getElementById('imported-prop-library');
    propImportDefaultStatus = document.getElementById('prop-import-default-status');
    resetPropImportDefaultBtn = document.getElementById('reset-prop-import-default');
    actorEditor = document.getElementById('actor-editor');
    actorEditorSummary = document.getElementById('actor-editor-summary');
    actorEditorStatus = document.getElementById('actor-editor-status');
    actorKindSelect = document.getElementById('actor-kind-select');
    actorLabelInput = document.getElementById('actor-label-input');
    actorScaleInput = document.getElementById('actor-scale-input');
    actorImportedTemplateSelect = document.getElementById('actor-imported-template-select');
    actorVehicleBodyTemplateSelect = document.getElementById('actor-vehicle-body-template-select');
    actorVehicleWheelTemplateSelect = document.getElementById('actor-vehicle-wheel-template-select');
    vehicleTemplateImportInput = document.getElementById('vehicle-template-import-input');
    actorComponentCollisionInput = document.getElementById('actor-component-collision');
    actorComponentPhysicsInput = document.getElementById('actor-component-physics');
    ['scene-actor-loc-x', 'scene-actor-loc-y', 'scene-actor-loc-z', 'scene-actor-rot-x', 'scene-actor-rot-y', 'scene-actor-rot-z', 'scene-actor-scl-x', 'scene-actor-scl-y', 'scene-actor-scl-z'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', () => {
            editorHistory.captureState();
            applySceneActorTransformDetailsFromUI();
        });
    });
    ['scene-actor-ddgi-dim-x', 'scene-actor-ddgi-dim-y', 'scene-actor-ddgi-dim-z', 'scene-actor-ddgi-intensity', 'scene-actor-ddgi-hysteresis', 'scene-actor-ddgi-normal-bias', 'scene-actor-ddgi-probes-per-frame'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', () => {
            editorHistory.captureState();
            applySceneActorDDGIDetailsFromUI();
        });
    });
    ['scene-actor-light-color', 'scene-actor-light-intensity', 'scene-actor-light-distance', 'scene-actor-light-decay', 'scene-actor-light-angle', 'scene-actor-light-penumbra', 'scene-actor-light-shadow'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', () => {
            editorHistory.captureState();
            applySceneActorLightDetailsFromUI();
        });
    });
    document.getElementById('scene-actor-mode-translate')?.addEventListener('click', () => {
        const actor = getSelectedSceneActor();
        const mesh = getActorRenderObject(actor);
        if (mesh && transformControl) transformControl.attach(mesh);
        transformControl?.setMode('translate');
        updateSceneActorDetailsUI();
    });
    document.getElementById('scene-actor-mode-rotate')?.addEventListener('click', () => {
        const actor = getSelectedSceneActor();
        const mesh = getActorRenderObject(actor);
        if (mesh && transformControl) transformControl.attach(mesh);
        transformControl?.setMode('rotate');
        updateSceneActorDetailsUI();
    });
    document.getElementById('scene-actor-mode-scale')?.addEventListener('click', () => {
        const actor = getSelectedSceneActor();
        const mesh = getActorRenderObject(actor);
        if (mesh && transformControl) transformControl.attach(mesh);
        transformControl?.setMode('scale');
        updateSceneActorDetailsUI();
    });
    document.getElementById('scene-actor-space-local')?.addEventListener('click', () => {
        transformControl?.setSpace('local');
        updateSceneActorDetailsUI();
    });
    document.getElementById('scene-actor-space-world')?.addEventListener('click', () => {
        transformControl?.setSpace('world');
        updateSceneActorDetailsUI();
    });
    actorComponentScriptsInput = document.getElementById('actor-component-scripts');
    actorEditorCreateBtn = document.getElementById('actor-editor-create');
    actorEditorOpenScriptBtn = document.getElementById('actor-editor-open-script');
    actorEditorCancelBtn = document.getElementById('actor-editor-cancel');
    propCollisionPrompt = document.getElementById('prop-collision-prompt');
    propCollisionCopy = document.getElementById('prop-collision-copy');
    propCollisionRemember = document.getElementById('prop-collision-remember');
    propCollisionSimpleBtn = document.getElementById('prop-collision-simple');
    propCollisionComplexBtn = document.getElementById('prop-collision-complex');
    propCollisionCancelBtn = document.getElementById('prop-collision-cancel');
    inputActionsOpenBtn = document.getElementById('open-input-actions');
    inputActionsEditor = document.getElementById('input-actions-editor');
    inputActionLeftBtn = document.getElementById('input-action-left');
    inputActionRightBtn = document.getElementById('input-action-right');
    inputActionMode = document.getElementById('input-actions-mode');
    inputActionEditorInput = document.getElementById('input-action-editor-input');
    inputActionsEditorStatus = document.getElementById('input-actions-editor-status');
    mouseActionApplyBtn = document.getElementById('apply-mouse-actions');
    mouseActionResetBtn = document.getElementById('reset-mouse-actions');
    inputActionsCloseBtn = document.getElementById('input-actions-close');
    mouseActionStatus = document.getElementById('mouse-action-status');
    objectScriptMenu = document.getElementById('object-script-menu');
    objectScriptTickActionBtn = document.getElementById('object-script-action-tick');
    objectScriptCollisionActionBtn = document.getElementById('object-script-action-collision');
    objectScriptEditor = document.getElementById('object-script-editor');
    objectScriptEditorTitle = document.getElementById('object-script-editor-title');
    objectScriptEditorTarget = document.getElementById('object-script-editor-target');
    objectScriptEditorMode = document.getElementById('object-script-editor-mode');
    objectScriptTickToggleRow = document.getElementById('object-script-tick-toggle-row');
    objectScriptTickToggleInput = document.getElementById('object-script-tick-toggle');
    objectScriptEditorInput = document.getElementById('object-script-editor-input');
    objectScriptEditorStatus = document.getElementById('object-script-editor-status');
    objectScriptEditorApplyBtn = document.getElementById('object-script-editor-apply');
    objectScriptEditorClearBtn = document.getElementById('object-script-editor-clear');
    objectScriptEditorCancelBtn = document.getElementById('object-script-editor-cancel');
    debugConsole = document.getElementById('debug-console');
    debugConsoleOutput = document.getElementById('debug-console-output');
    debugConsoleInput = document.getElementById('debug-console-input');
    debugConsoleFooter = document.getElementById('debug-console-footer');
    debugStatsOverlay = document.getElementById('debug-stats-overlay');
    engineAudioDebugEl = document.getElementById('engine-audio-debug');
    postProcessUiRefs = {
        targetGlobalBtn: document.getElementById('post-process-target-global'),
        targetVolumeBtn: document.getElementById('post-process-target-volume'),
        exposureInput: document.getElementById('post-process-exposure'),
        exposureValue: document.getElementById('post-process-exposure-value'),
        bloomStrengthInput: document.getElementById('post-process-bloom-strength'),
        bloomStrengthValue: document.getElementById('post-process-bloom-strength-value'),
        bloomRadiusInput: document.getElementById('post-process-bloom-radius'),
        bloomRadiusValue: document.getElementById('post-process-bloom-radius-value'),
        bloomThresholdInput: document.getElementById('post-process-bloom-threshold'),
        bloomThresholdValue: document.getElementById('post-process-bloom-threshold-value'),
        blendSpeedInput: document.getElementById('post-process-blend-speed'),
        blendSpeedValue: document.getElementById('post-process-blend-speed-value'),
        priorityInput: document.getElementById('post-process-priority'),
        sizeXInput: document.getElementById('post-process-size-x'),
        sizeYInput: document.getElementById('post-process-size-y'),
        sizeZInput: document.getElementById('post-process-size-z'),
        placeVolumeBtn: document.getElementById('post-process-place-volume'),
        removeVolumeBtn: document.getElementById('post-process-remove-volume'),
        toggleBoundsBtn: document.getElementById('post-process-toggle-bounds'),
        applyBtn: document.getElementById('post-process-apply-settings'),
        status: document.getElementById('post-process-status'),
    };
    shadowDebugUiRefs = {
        forceOffBtn: document.getElementById('debug-force-mesh-shadows-off'),
        forceOnBtn: document.getElementById('debug-force-mesh-shadows-on'),
        applyBtn: document.getElementById('debug-apply-mesh-shadows'),
        status: document.getElementById('debug-shadow-status'),
    };
    perfModeUiRefs = {
        offBtn: document.getElementById('perf-mode-off'),
        onBtn: document.getElementById('perf-mode-on'),
        status: document.getElementById('perf-mode-status'),
    };

    // World Environment panel refs — every toggle button, slider input, and
    // value-display span. Lookups are tolerant: the panel may be absent in
    // older index.html copies; null refs short-circuit gracefully in the
    // updateWorldEnvUi / handler bodies.
    worldEnvUiRefs = {
        summaryValue: document.getElementById('we-summary-value'),
        masterOnBtn: document.getElementById('we-master-on'),
        masterOffBtn: document.getElementById('we-master-off'),
        masterPerfBtn: document.getElementById('we-master-perf'),
        masterCornellBtn: document.getElementById('we-master-cornell'),
        masterStatus: document.getElementById('we-master-status'),
        skyOff: document.getElementById('we-sky-off'),
        skyOn: document.getElementById('we-sky-on'),
        skyPreset: document.getElementById('we-sky-preset'),
        skyBlurriness: document.getElementById('we-sky-blurriness'),
        skyBlurrinessValue: document.getElementById('we-sky-blurriness-value'),
        ambientOff: document.getElementById('we-ambient-off'),
        ambientOn: document.getElementById('we-ambient-on'),
        ambientIntensity: document.getElementById('we-ambient-intensity'),
        ambientIntensityValue: document.getElementById('we-ambient-intensity-value'),
        hemiOff: document.getElementById('we-hemi-off'),
        hemiOn: document.getElementById('we-hemi-on'),
        hemiIntensity: document.getElementById('we-hemi-intensity'),
        hemiIntensityValue: document.getElementById('we-hemi-intensity-value'),
        sunOff: document.getElementById('we-sun-off'),
        sunOn: document.getElementById('we-sun-on'),
        sunShadow: document.getElementById('we-sun-shadow'),
        sunIntensity: document.getElementById('we-sun-intensity'),
        sunIntensityValue: document.getElementById('we-sun-intensity-value'),
        exposure: document.getElementById('we-tonemap-exposure'),
        exposureValue: document.getElementById('we-tonemap-exposure-value'),
        aaOff: document.getElementById('we-aa-off'),
        aaOn: document.getElementById('we-aa-on'),
        renderResolutionOff: document.getElementById('we-render-resolution-off'),
        renderResolutionOn: document.getElementById('we-render-resolution-on'),
        renderResolutionScale: document.getElementById('we-render-resolution-scale'),
        renderResolutionScaleValue: document.getElementById('we-render-resolution-scale-value'),
        renderResolutionMaxDpr: document.getElementById('we-render-resolution-max-dpr'),
        renderResolutionMaxDprValue: document.getElementById('we-render-resolution-max-dpr-value'),
        adaptiveOff: document.getElementById('we-adaptive-off'),
        adaptiveOn: document.getElementById('we-adaptive-on'),
        bloomOff: document.getElementById('we-bloom-off'),
        bloomOn: document.getElementById('we-bloom-on'),
        bloomStrength: document.getElementById('we-bloom-strength'),
        bloomStrengthValue: document.getElementById('we-bloom-strength-value'),
        bloomRadius: document.getElementById('we-bloom-radius'),
        bloomRadiusValue: document.getElementById('we-bloom-radius-value'),
        bloomThreshold: document.getElementById('we-bloom-threshold'),
        bloomThresholdValue: document.getElementById('we-bloom-threshold-value'),
        ssaoOff: document.getElementById('we-ssao-off'),
        ssaoOn: document.getElementById('we-ssao-on'),
        ssaoIntensity: document.getElementById('we-ssao-intensity'),
        ssaoIntensityValue: document.getElementById('we-ssao-intensity-value'),
        ssaoRadius: document.getElementById('we-ssao-radius'),
        ssaoRadiusValue: document.getElementById('we-ssao-radius-value'),
        ssgiOff: document.getElementById('we-ssgi-off'),
        ssgiOn: document.getElementById('we-ssgi-on'),
        fogOff: document.getElementById('we-fog-off'),
        fogOn: document.getElementById('we-fog-on'),
        fogDensity: document.getElementById('we-fog-density'),
        fogDensityValue: document.getElementById('we-fog-density-value'),
        fogOpacity: document.getElementById('we-fog-opacity'),
        fogOpacityValue: document.getElementById('we-fog-opacity-value'),
        ddgiOff: document.getElementById('we-ddgi-off'),
        ddgiOn: document.getElementById('we-ddgi-on'),
        ddgiLiveBakeOff: document.getElementById('we-ddgi-live-bake-off'),
        ddgiLiveBakeOn: document.getElementById('we-ddgi-live-bake-on'),
        ddgiBakeEveryN: document.getElementById('we-ddgi-bake-every-n'),
        ddgiBakeEveryNValue: document.getElementById('we-ddgi-bake-every-n-value'),
        ddgiIntensity: document.getElementById('we-ddgi-intensity'),
        ddgiIntensityValue: document.getElementById('we-ddgi-intensity-value'),
        ddgiLightIntensity: document.getElementById('we-ddgi-light-intensity'),
        ddgiLightIntensityValue: document.getElementById('we-ddgi-light-intensity-value'),
        ddgiProbeDebugOff: document.getElementById('we-ddgi-probe-debug-off'),
        ddgiProbeDebugOn: document.getElementById('we-ddgi-probe-debug-on'),
        ddgiRayDebugOff: document.getElementById('we-ddgi-ray-debug-off'),
        ddgiRayDebugOn: document.getElementById('we-ddgi-ray-debug-on'),
        ddgiSolidTestOff: document.getElementById('we-ddgi-solid-test-off'),
        ddgiSolidTestOn: document.getElementById('we-ddgi-solid-test-on'),
        ddgiViewLit: document.getElementById('we-ddgi-view-lit'),
        ddgiViewContribution: document.getElementById('we-ddgi-view-contribution'),
        shadowsOff: document.getElementById('we-shadows-off'),
        shadowsOn: document.getElementById('we-shadows-on'),
        shadowsBias: document.getElementById('we-shadows-bias'),
        shadowsBiasValue: document.getElementById('we-shadows-bias-value'),
        shadowsNormalBias: document.getElementById('we-shadows-normal-bias'),
        shadowsNormalBiasValue: document.getElementById('we-shadows-normal-bias-value'),
        shadowsRadius: document.getElementById('we-shadows-radius'),
        shadowsRadiusValue: document.getElementById('we-shadows-radius-value'),
        shadowsMapSize: document.getElementById('we-shadows-map-size'),
        shadowsMapSizeValue: document.getElementById('we-shadows-map-size-value'),
        lightCullOff: document.getElementById('we-lightcull-off'),
        lightCullOn: document.getElementById('we-lightcull-on'),
        lightCullMax: document.getElementById('we-lightcull-max'),
        lightCullMaxValue: document.getElementById('we-lightcull-max-value'),
        pomOff: document.getElementById('we-pom-off'),
        pomOn: document.getElementById('we-pom-on'),
        pomIntensity: document.getElementById('we-pom-intensity'),
        pomIntensityValue: document.getElementById('we-pom-intensity-value'),
        pomQualityLow: document.getElementById('we-pom-quality-low'),
        pomQualityMedium: document.getElementById('we-pom-quality-medium'),
        pomQualityHigh: document.getElementById('we-pom-quality-high'),
        resetBtn: document.getElementById('we-reset-defaults'),
        bakeRes: document.getElementById('we-bake-res'),
        bakeResValue: document.getElementById('we-bake-res-value'),
        bakeSamples: document.getElementById('we-bake-samples'),
        bakeSamplesValue: document.getElementById('we-bake-samples-value'),
        bakeRun: document.getElementById('we-bake-run'),
        bakeClear: document.getElementById('we-bake-clear'),
        bakeStatus: document.getElementById('we-bake-status'),
    };

    wirePanelHandlers({
        THREE,
        worldEnvUiRefs, worldEnvState,
        postProcessUiRefs, postProcessUiState, shadowDebugUiRefs, perfModeUiRefs,
        debugConsoleInput,
        getLightmapBaker: () => lightmapBaker,
        getPostProcessVolumeManager: () => postProcessVolumeManager,
        loadWorldEnvFromStorage, applyWorldEnvState,
        resetWorldEnvDefaults, setWorldEnvMaster,
        syncPostProcessVolumeUi,
        updatePostProcessSliderLabels, applyPostProcessSettingsFromUi,
        setForceAllSceneMeshShadowsEnabled, forceAllSceneMeshShadows,
        updateShadowDebugUi,
        setPerfModeEnabled, updatePerfModeUi,
        renderDebugConsoleOutput, handleDebugConsoleInputKeydown,
    });

    if (browseModelBtn) {
        browseModelBtn.addEventListener('click', () => {
            document.getElementById('file-input').click();
        });
    }

    if (importPropBtn) {
        importPropBtn.addEventListener('click', () => {
            propFileInput.value = '';
            propFileInput.click();
        });
    }

    propFileInput?.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        event.target.value = '';
        if (!file) return;
        await importPhysicsProp(file, {});
    });

    resetPropImportDefaultBtn?.addEventListener('click', () => {
        importedPropState.futureCollisionMode = null;
        updatePropImportStatus();
    });

    propCollisionSimpleBtn?.addEventListener('click', () => {
        resolvePropCollisionPrompt({
            mode: 'simple',
            remember: !!propCollisionRemember?.checked,
        });
    });

    propCollisionComplexBtn?.addEventListener('click', () => {
        resolvePropCollisionPrompt({
            mode: 'complex',
            remember: !!propCollisionRemember?.checked,
        });
    });

    propCollisionCancelBtn?.addEventListener('click', () => resolvePropCollisionPrompt(null));

    openActorEditorBtn?.addEventListener('click', () => openActorEditor());
    playTestSoundBtn?.addEventListener('click', () => {
        void playAudioTestCue();
    });
    const actorColorEnabledEl = document.getElementById('actor-color-enabled');
    const actorColorInputEl = document.getElementById('actor-color-input');
    actorColorEnabledEl?.addEventListener('change', () => {
        if (actorColorInputEl) actorColorInputEl.disabled = !actorColorEnabledEl.checked;
    });
    actorKindSelect?.addEventListener('change', () => syncActorEditorUi());
    actorImportedTemplateSelect?.addEventListener('change', () => syncActorEditorUi());
    actorVehicleBodyTemplateSelect?.addEventListener('change', () => handleVehicleTemplateSelectChange('body'));
    actorVehicleWheelTemplateSelect?.addEventListener('change', () => handleVehicleTemplateSelectChange('wheel'));
    vehicleTemplateImportInput?.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        const slot = pendingVehicleTemplateImportSlot;
        pendingVehicleTemplateImportSlot = null;
        event.target.value = '';
        if (!file || !slot) return;

        const template = await importPhysicsProp(file, {});
        const select = slot === 'body' ? actorVehicleBodyTemplateSelect : actorVehicleWheelTemplateSelect;
        if (template?.id && select) {
            // populateVehicleSelect already re-ran via registerImportedPropTemplate;
            // just select the freshly imported template.
            select.value = template.id;
        } else if (select) {
            select.value = '';
        }
        syncActorEditorUi();
    });
    actorComponentCollisionInput?.addEventListener('change', () => syncActorEditorUi());
    actorComponentPhysicsInput?.addEventListener('change', () => syncActorEditorUi());
    actorComponentScriptsInput?.addEventListener('change', () => syncActorEditorUi());
    actorEditorCreateBtn?.addEventListener('click', () => {
        spawnActorFromEditor({ openScriptEditor: false });
    });
    actorEditorOpenScriptBtn?.addEventListener('click', () => {
        spawnActorFromEditor({ openScriptEditor: true });
    });
    actorEditorCancelBtn?.addEventListener('click', () => closeActorEditor());

    inputActionsOpenBtn?.addEventListener('click', () => openInputActionsEditor());
    inputActionLeftBtn?.addEventListener('click', () => openInputActionsEditor('left'));
    inputActionRightBtn?.addEventListener('click', () => openInputActionsEditor('right'));
    inputActionEditorInput?.addEventListener('input', () => {
        updateSelectedMouseActionSource();
        syncInputActionsEditor();
        saveMouseActionDrafts();
    });

    mouseActionApplyBtn?.addEventListener('click', () => applyMouseActionScripts({ persist: true }));
    mouseActionResetBtn?.addEventListener('click', () => resetMouseActionScripts());
    inputActionsCloseBtn?.addEventListener('click', () => closeInputActionsEditor());
    objectScriptTickActionBtn?.addEventListener('click', () => openObjectScriptEditor('tick'));
    objectScriptCollisionActionBtn?.addEventListener('click', () => openObjectScriptEditor('collision'));
    objectScriptEditorMode?.addEventListener('change', () => {
        objectScriptState.targetEvent = objectScriptEditorMode.value === 'collision' ? 'collision' : 'tick';
        syncObjectScriptEditor();
    });
    objectScriptEditorApplyBtn?.addEventListener('click', () => {
        const prop = getDynamicPropById(objectScriptState.targetPropId);
        if (!prop || !objectScriptEditorInput) return;
        updatePropScriptSource(prop, objectScriptState.targetEvent, objectScriptEditorInput.value, { persist: true, notify: true });
    });
    objectScriptTickToggleInput?.addEventListener('change', () => {
        const prop = getDynamicPropById(objectScriptState.targetPropId);
        if (!prop) return;
        setPropTickEventEnabled(prop, !!objectScriptTickToggleInput.checked, { persist: true });
    });
    objectScriptEditorClearBtn?.addEventListener('click', () => {
        const prop = getDynamicPropById(objectScriptState.targetPropId);
        if (!prop) return;
        clearPropScriptSource(prop, objectScriptState.targetEvent);
        syncObjectScriptEditor();
    });
    objectScriptEditorCancelBtn?.addEventListener('click', () => closeObjectScriptEditor());
    document.addEventListener('pointerdown', handleObjectScriptGlobalPointerDown, true);
    document.addEventListener('keydown', handleObjectScriptKeydown);

    showcaseModeBtn?.addEventListener('click', () => setCameraMode('showcase'));
    playModeBtn?.addEventListener('click', () => setCameraMode('play'));
    mobilePreviewOnBtn?.addEventListener('click', () => runMobileCommand(['on']));
    desktopMobileToggleBtn?.addEventListener('click', () => runMobileCommand(['toggle']));

    setupDropHandlers();

    // Slider listener
    const slider = document.getElementById('ratio-slider');
    const ratioValue = document.getElementById('ratio-value');
    if (slider) {
        slider.addEventListener('input', (e) => {
            const val = Math.round(e.target.value * 100);
            if (ratioValue) {
                ratioValue.textContent = `${val}%`;
            }
        });
    }

    if (!navigator.gpu) {
        const errorMsg = "WebGPU is not supported in this browser. Please use Chrome/Edge (v113+) or enable it in your flags.";
        console.error(errorMsg);
        alert(errorMsg);
        // We can't continue initialization with WebGPURenderer if it's missing
        return;
    }

    await MeshoptSimplifier.ready;
    console.log("MeshoptSimplifier ready");
    await initPhysics();

    scene = new THREE.Scene();
    sceneSystem = createSceneSystem(scene);
    sceneSystem.onActorsChanged = refreshSceneUI;
    
    environmentController = createEnvironmentController({
        scene,
        getAmbientLight: () => ambientLight,
        getHemiLight: () => hemiLight,
    });

    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.copy(SHOWCASE_CAMERA_POSITION);
    camera.rotation.order = 'YXZ';
    camera.layers.enable(getDDGIManager().getDebugLayer?.() ?? 30);
    syncShowcaseAnglesFromTarget(SHOWCASE_CAMERA_TARGET);
    applyShowcaseCameraRotation();
    scene.add(camera);
    volumetricFogController = createVolumetricFog({
        scene,
        camera,
    });
    runtimeAudio.listener = new SoundGeneratorAudioListener();
    camera.add(runtimeAudio.listener);

    // PERF: pixel ratio capped at 2 — HiDPI 3x/4x devices were drawing 9-16x
    // 1080p for no perceptible win.
    // AA off by default (no MSAA). Edge AA is opt-in via the Anti-Aliasing
    // toggle in the menu, which enables the FXAA node on the post path
    // (see worldEnvSystem.rebuildPostProcessingOutputNode / worldEnvState.aa).
    // requiredLimits: the post stack's G-buffer MRT (color+normal+metalness+
    // roughness+velocity = 5 RGBA16F targets = 40 bytes/sample) exceeds the
    // default 32-byte maxColorAttachmentBytesPerSample. Bump it — but three
    // forwards requiredLimits straight to adapter.requestDevice(), which REJECTS
    // if the adapter can't meet them, so clamp to what the adapter actually
    // supports (querying it ourselves first). Weaker adapters that can't fit 5
    // targets won't run SSR+TAA together, but they still boot.
    const requiredLimits = {};
    try {
        const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
        const maxBytes = adapter?.limits?.maxColorAttachmentBytesPerSample;
        if (maxBytes && maxBytes > 32) {
            requiredLimits.maxColorAttachmentBytesPerSample = Math.min(128, maxBytes);
        }
    } catch (e) { /* no WebGPU / adapter query failed — fall back to defaults */ }
    renderer = new WebGPURenderer({
        antialias: false, samples: 0, alpha: true, trackTimestamp: true,
        requiredLimits,
    });
    // PERF: base render resolution cap. Mobile GPUs choke at native 2-3x DPR
    // (4-9x the pixels) — cap to 1.25x there. Desktop stays at 2x max unless
    // the World Environment Resolution Boost explicitly overrides it.
    applyRenderResolutionSettings();
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // RectAreaLight needs its BRDF approximation (LTC) textures loaded once
    // before any rect-area light renders. Required by the WebGPU node path.
    try { RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init()); } catch (e) { console.warn('[light] RectAreaLight LTC init failed', e); }
    renderer.localClippingEnabled = true; // Essential for the reflection
    renderer.domElement.tabIndex = 0;
    container.appendChild(renderer.domElement);
    await renderer.init();
    debugConsoleState.gpuTimingMode = renderer.backend?.trackTimestamp ? 'gpu' : 'approximate';

    ({
        postProcessing,
        postProcessNodes,
        postProcessVolumeManager,
        lightmapBaker,
    } = setupPostProcessing({
        scene, camera, renderer, sceneSystem, mainDirectionalLight,
        globalPostProcessUniforms,
        applySSGISettings, applySSAOSettings, rebuildPostProcessingOutputNode,
        createPostProcessVolumeManager, syncPostProcessVolumeUi,
        getDDGIManager, createLightmapBaker,
        registerDebug,
    }));

    // Initialize TransformControls for gizmo manipulation
    transformControl = new TransformControls(camera, renderer.domElement);
    transformControl.setSize(1.5); // Make gizmo hit area larger
    markDDGISkipCapture(transformControl.getHelper());
    transformControl.addEventListener('change', () => {
        if (blueprintState.active) {
            updateBlueprintDetailsUI();
        }
        updateSceneActorDetailsUI();
    });
    transformControl.addEventListener('dragging-changed', (event) => {
        showcase.looking = false;
        if (!event.value) {
            if (blueprintState.active) {
                const prop = getDynamicPropById(objectScriptState.targetPropId);
                if (prop) rebuildActorPhysics(prop);
            } else {
                syncTransformToPhysics();
                const actor = getSelectedSceneActor();
                const rootMesh = getActorRenderObject(actor);
                const ddgi = getActorDDGIVolumeComponent(actor);
                if (actorBelongsToCurrentMesh(actor) && transformControl.object === rootMesh) {
                    refreshGameplayWorld({ resetCamera: false });
                }
                if (ddgi && transformControl.object === rootMesh) {
                    syncDDGIVolumeComponentToActorBounds(ddgi);
                }
            }
            requestScenePointLightShadowRefresh();
            invalidateDDGI('scene object transformed');
            transformControl.justFinishedDragging = true;
            editorHistory.captureState();
            setTimeout(() => transformControl.justFinishedDragging = false, 100);
            updateSceneActorDetailsUI();
        }
    });
    scene.add(transformControl.getHelper());

    // Wire extracted modules now that scene/camera/renderer/transformControl/sceneSystem
    // and DOM refs all exist. Must happen before any module-bound helper is called.
    wireExtractedModules();

    syncTransformControlState();

    // Initialize widget system AFTER renderer is set up
    widgetManager = new WidgetManager(container);
    lightGridController = createLightGridController({
        scene,
        gsap,
        getRenderer: () => renderer,
        getCamera: () => camera,
        gameplay,
        raycaster,
        pointerNdc,
        getGroundHeightAt,
        getAnchorTarget: getLightGridAnchorTarget,
        terrainYOffset: TERRAIN_Y_OFFSET,
    });
    multiplayerController = createSocketMultiplayer({
        scene,
        onStateChange: updateMultiplayerUiState,
    });

    // Pedestal
    const pedestalGeo = new THREE.CylinderGeometry(2.5, 2.5, 0.02, 64);
    pedestalMat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        metalness: 0.1,
        roughness: 0.05,
        transmission: 1.0,
        thickness: 0,
        ior: 1.0, // IOR 1.0 eliminates double-refraction ghosting from the bottom cap
        transparent: true,
        opacity: 0.9 // Slightly more opaque for better grounding
    });
    pedestal = new THREE.Mesh(pedestalGeo, pedestalMat);
    pedestal.position.y = -0.05;
    scene.add(pedestal);

    worldFloor = createTerrainMesh();
    scene.add(worldFloor);
    await applyTerrainTextures(worldFloor);
    buildLightGrid();
    rebuildTerrainPhysicsBody();

    grassField = createGrassField({ worldFloor });

    water = createWater({ level: TERRAIN_Y_OFFSET - 0.25 });
    scene.add(water.mesh);

    // Removed shadow plane to eliminate 'double blur' artifacts

    // Subtle rim
    const rimGeo = new THREE.TorusGeometry(2.5, 0.02, 16, 100);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xEEEEEE, emissive: 0xEEEEEE });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0;
    //scene.add(rim);

    ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
    scene.add(ambientLight);

    hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5);
    scene.add(hemiLight);

    mainDirectionalLight = new THREE.DirectionalLight(0xffffff, 2.5);
    mainDirectionalLight.castShadow = true;
    // PERF: 4096² shadow map → 2048². 4x less shadow fragment work; PCF radius
    // 2.0 still hides the resolution drop on a single cascade-less dir light.
    mainDirectionalLight.shadow.mapSize.width = 2048;
    mainDirectionalLight.shadow.mapSize.height = 2048;
    mainDirectionalLight.shadow.camera.near = 0.5;
    mainDirectionalLight.shadow.camera.far = MAIN_SHADOW_FAR;
    mainDirectionalLight.shadow.camera.left = -MAIN_SHADOW_EXTENT;
    mainDirectionalLight.shadow.camera.right = MAIN_SHADOW_EXTENT;
    mainDirectionalLight.shadow.camera.top = MAIN_SHADOW_EXTENT;
    mainDirectionalLight.shadow.camera.bottom = -MAIN_SHADOW_EXTENT;
    mainDirectionalLight.shadow.bias = -0.00004;
    mainDirectionalLight.shadow.normalBias = 0.0;
    mainDirectionalLight.shadow.radius = 2.0;
    scene.add(mainDirectionalLight);
    scene.add(mainDirectionalLight.target);
    updateMainDirectionalLightShadowFocus();
    // Patch any existing scene materials immediately so DDGI-enabled
    // materials are ready before the first WebGPU material build.
    try {
        getDDGIManager().patchSceneMaterials?.(scene);
    } catch (e) {
        console.warn('[DDGI] initial patch failed', e);
    }
    loadWorldEnvFromStorage();
    try {
        await switchEnvironment(worldEnvState?.sky?.preset || 'sunny-sky');
    } catch (e) {
        console.warn('[Env] initial HDRI warmup failed', e);
    }
    applyWorldEnvState({ persist: false, switchSky: false });
    setPerfModeEnabled(PERF_MODE_DEFAULT_ENABLED);

    // Diagnostic on the fix/ddgi-correctness branch — surfaces the resolved DDGI
    // state at boot so anyone testing knows whether the path is actually live.
    // Remove before merging to a regular branch.
    try {
        const ddgi = getDDGIManager();
        const snap = ddgi.getSnapshot?.() || {};
        // eslint-disable-next-line no-console
        console.info('[DDGI] boot state', {
            perfModeEnabled,
            'worldEnvState.ddgi.enabled': worldEnvState.ddgi.enabled,
            'worldEnvState.ddgi.intensity': worldEnvState.ddgi.intensity,
            managerEnabled: snap.enabled,
            managerInjectionEnabled: snap.injectionEnabled,
            activeVolumeType: snap.activeVolumeType,
            probeCount: snap.probeCount,
        });
    } catch (e) { /* boot order — DDGI may not be live yet */ }

    if (window.DEBUG_WIDGET_API) {
        createExampleWidgets();
    }

    window.addEventListener('resize', onWindowResize);

    // Environment selector
    const envSelector = document.getElementById('env-selector');
    if (envSelector) {
        envSelector.addEventListener('change', (e) => switchEnvironment(e.target.value));
    }

    // Resolution buttons
    document.querySelectorAll('.res-btn').forEach(btn => {
        btn.addEventListener('click', () => setResolution(btn.dataset.res));
    });

    playHint = document.getElementById('play-hint');
    gameplayStatus = document.getElementById('gameplay-status');
    resetViewBtn = document.getElementById('reset-view');
    if (multiplayerServerUrlInput && !multiplayerServerUrlInput.value.trim()) {
        multiplayerServerUrlInput.value = getDefaultMultiplayerServerUrl();
    }
    if (multiplayerRoomInput && !multiplayerRoomInput.value.trim()) {
        multiplayerRoomInput.value = multiplayerState.defaultRoom;
    }
    multiplayerConnectBtn?.addEventListener('click', () => {
        multiplayerController?.connect({
            serverUrl: multiplayerServerUrlInput?.value ?? '',
            room: multiplayerRoomInput?.value ?? multiplayerState.defaultRoom,
        });
    });
    multiplayerDisconnectBtn?.addEventListener('click', () => {
        multiplayerController?.disconnect('Disconnected');
    });
    updateMultiplayerUiState({
        statusText: 'Offline',
        playerCount: 1,
        connected: false,
    });
    updatePropImportStatus();
    renderImportedPropButtons();
    initializeMouseActionScripts();
    setupGameplayEvents();
    setupTerrainPanel();
    if (!currentMesh) {
        loadSample('doomArena');
    }
    updateGameplayUI();
    try {
        await renderer.compileAsync?.(scene, camera);
    } catch (e) {
        console.warn('[Renderer] initial compile warmup failed', e);
    }

    // Reused per-frame context object passed to every registered system.
    // Properties are overwritten each tick so the object identity stays
    // stable and we don't allocate per frame.
    const frameCtx = { now: 0, timestamp: 0 };
    renderer.setAnimationLoop((timestamp) => {
        frameTimer.update(timestamp);
        const delta = Math.min(frameTimer.getDelta(), 0.05);
        frameCtx.timestamp = timestamp;
        frameCtx.now = performance.now?.() || Date.now();

        const updateStart = performance.now();
        if (gameplay.active && !gameplay.roguePaused) {
            updateGameplay(delta);
        } else if (gameplay.roguePaused) {
            // Card picker open: hold the sim frozen, keep rendering the frame.
        } else {
            silenceVehicleEngineAudio();
            updateEngineAudioDebugOverlay('idle', null, null);
            updateShowcaseCamera(delta);
        }
        updateMainDirectionalLightShadowFocus();
        updateGameplayDebugRay();
        const updateDuration = performance.now() - updateStart;

        const gameplaySimPaused = gameplay.roguePaused || isMobileGamePaused();
        // Gameplay-phase systems are registered with explicit `before`/`after`
        // deps; the registry runs them in topological order and records timing.
        const gameplaySystemMetrics = gameplaySimPaused
            ? gameplaySystems.getLastMetrics()
            : gameplaySystems.tickPhase('gameplay', delta, frameCtx);

        let physicsMetrics = { total: 0, step: 0, sync: 0, collisions: 0 };
        if (gameplay.active && !gameplaySimPaused) {
            physicsMetrics = stepPhysics(delta);
            updateLitePhysicsPools();
        }
        // Split the frame: a game mode (Drug Tycoon, Rogue, Doom) runs only the
        // systems it needs and skips engine/editor-only per-frame work (vehicle
        // visuals, grass/water, object animations, widgets, debug rays). The
        // mode's own logic runs via updateGameplay → gameplaySystems + the
        // per-mode updaters; this just trims the showcase/editor overhead.
        const frameInGameMode = gameplay.active
            && GAME_MODE_TYPES.includes(currentMesh?.userData?.sampleType);

        // Vehicles only exist in free/engine scenes (or if one is actively
        // driven). Skip the visual/surface sync otherwise.
        if (!frameInGameMode || gameplay.activeVehicleId) {
            updateVehicleVisuals(delta);
            updateVehicleSurfaceEffects(delta);
        }
        syncActorCoreInstances();
        if (!frameInGameMode) {
            grassField?.update(delta);
            water?.update(delta);
        }
        // Performance toggle: skip the per-frame work entirely when on.
        // setPerfModeEnabled has already called setEnabled(false) on each subsystem
        // so visuals stay flat; we just skip the update/tick CPU cost here.
        if (!perfModeEnabled) {
            volumetricFogController?.update(delta);
            postProcessVolumeManager?.update(delta);
        }
        const _ddgiStart = performance.now();
        const ddgiManager = getDDGIManager();
        // fix/ddgi-correctness: tick DDGI regardless of perf mode. The runtime
        // enabled flag (set by applyWorldEnvState) is the single source of truth.
        ddgiManager.tick(delta);
        const _ddgiMs = performance.now() - _ddgiStart;
        if (debugConsoleState?.latest) debugConsoleState.latest.ddgi = _ddgiMs;
        // Cornell ray debug: redraw the rays cast from the chosen probe
        // every frame so a moving / rebaking world stays in sync. Editor-only.
        if (!frameInGameMode) {
            updateCornellRayDebug();
            updateObjectAnimations(delta);
            tickForceAllSceneMeshShadows();
        }

        multiplayerController?.syncLocalSnapshot(getLocalMultiplayerSnapshot());        multiplayerController?.update(delta);

        try {
            // Update widget system — engine UI widgets, not used by game modes.
            if (widgetManager && !frameInGameMode) {
                widgetManager.update(delta);
            }

            // Object tick scripts: Rogue Waves drives its game-mode actor through
            // this, so keep it in game modes; Drug Tycoon has no script actors so
            // the pass is a cheap empty loop there.
            const scriptStart = performance.now();
            runObjectTickScripts(delta);
            if (gameplay.activeVehicleId) {
                runObjectInputScripts(
                    delta,
                    gameplay.input,
                    gameplay.inputPressedThisFrame,
                    gameplay.inputReleasedThisFrame,
                );
            }
            gameplay.inputPressedThisFrame.length = 0;
            gameplay.inputReleasedThisFrame.length = 0;
            const scriptDuration = performance.now() - scriptStart;

            if (!frameInGameMode) tickRaycastDebugLine();
            // Dynamic light culling: dim all but the N most important point/spot
            // lights before rendering (skipped in perf mode — it disables lights
            // wholesale anyway). Cheap CPU pass; big shader win in light-heavy scenes.
            if (!perfModeEnabled && lightCull.isEnabled()) {
                try { lightCull.update(scene, camera); } catch (e) {}
            }
            // Adaptive quality FPS watchdog: may toggle effects on/off this frame.
            if (!perfModeEnabled && adaptiveQuality.isEnabled()) {
                try { adaptiveQuality.update(delta); } catch (e) {}
            }
            const renderStart = performance.now();
            if (postProcessing && shouldUsePostProcessingPipeline()) {
                postProcessing.render();
            } else {
                renderer.render(scene, camera);
            }
            const renderDuration = performance.now() - renderStart;
            scheduleGpuRenderTimingResolve();

            recordDebugFrameMetrics({
                frame: delta * 1000,
                update: updateDuration,
                physics: physicsMetrics.total,
                physicsStep: physicsMetrics.step,
                physicsSync: physicsMetrics.sync,
                physicsCollisions: physicsMetrics.collisions,
                scripts: scriptDuration,
                gpu: latestGpuRenderMs,
                render: renderDuration,
                ddgi: _ddgiMs,
                systems: gameplaySystemMetrics,
                delta,
            });
        } catch (e) {
            console.error('Crash in animation loop:', e);
            throw e;
        }
        updateDebugStatPanels();
    });
}

// Built-in level builders extracted to ../world/levels.js (createLevels
// factory, wired in wireExtractedModules). These module-scope bindings are
// reassigned there; only the engine-facing entry points are aliased back.
let getBuiltinLevelDefinition = () => { throw new Error('levels not wired'); };
let updateDoomEnemySpriteAnimation = () => {};
let applyDoomEnemySpriteSkin = () => {};
let makeDoomShotgunSpriteTexture = () => null;

function loadSample(levelId = 'soccerField') {
    clearCurrentMesh();
    // Drop stale light-cull bookkeeping so the new level recaptures fresh
    // intensities (and we don't restore a dimmed value onto a recycled uuid).
    try { lightCull.reset(); } catch (e) {}

    const level = getBuiltinLevelDefinition(levelId);
    currentMesh = level.create();
    scene.add(currentMesh);
    if (!currentMesh.userData?.skipNormalization) {
        normalizeCurrentMesh();
    }
    refreshGameplayWorld();
    const preferredSpawn = currentMesh.userData?.preferredSpawn;
    if (preferredSpawn?.position?.length === 3) {
        tempVectorA.set(preferredSpawn.position[0], preferredSpawn.position[1], preferredSpawn.position[2]);
        currentMesh.localToWorld(tempVectorA);
        gameplay.spawnPoint.copy(tempVectorA);
        if (Number.isFinite(preferredSpawn.yaw)) gameplay.spawnYaw = preferredSpawn.yaw;
        if (Number.isFinite(preferredSpawn.pitch)) gameplay.spawnPitch = preferredSpawn.pitch;
    }
    const preferredShowcase = currentMesh.userData?.preferredShowcase;
    if (!gameplay.active && preferredShowcase?.position?.length === 3 && preferredShowcase?.target?.length === 3) {
        tempVectorA.set(preferredShowcase.position[0], preferredShowcase.position[1], preferredShowcase.position[2]);
        tempVectorB.set(preferredShowcase.target[0], preferredShowcase.target[1], preferredShowcase.target[2]);
        currentMesh.localToWorld(tempVectorA);
        currentMesh.localToWorld(tempVectorB);
        camera.position.copy(tempVectorA);
        syncShowcaseAnglesFromTarget(tempVectorB);
        applyShowcaseCameraRotation();
        showcase.velocity.set(0, 0, 0);
    }
    const selectedActor = level.afterLoad?.() || null;
    if (selectedActor) {
        selectShowcaseActor(selectedActor.id);
    }
    refreshSceneUI();
    updateLoadedAssetStats(level.assetName, level.fileSize, currentMesh);
    enableOptimizationPipeline();
}

// Render loop now handled by setAnimationLoop in init

function onWindowResize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    applyRenderResolutionSettings();
}

function clearCurrentMesh() {
    exitGameplay();
    soccerGoalieState.elapsed = 0;
    clearSceneActors();

    if (sampleDDGIVolumeActor) {
        destroyDDGIVolumeActor(sampleDDGIVolumeActor);
        sampleDDGIVolumeActor = null;
    }

    if (physics.modelBody) {
        destroyPhysicsBody(physics.modelBody);
        physics.modelBody = null;
    }
    destroyPlayerCharacter();

    if (!currentMesh) {
        gameplay.canPlay = physics.ready;
        updateGameplayUI();
        return;
    }

    scene.remove(currentMesh);
    disposeRenderableObject(currentMesh);

    currentMesh = null;
    gameplay.canPlay = physics.ready;
    updateGameplayUI();
}

function normalizeCurrentMesh(targetDimension = MODEL_TARGET_MAX_DIMENSION) {
    if (!currentMesh) return;
    normalizeObjectToDimension(currentMesh, targetDimension, true);
}

function syncSampleWorldPresentation() {
    const hideTerrain = !!currentMesh?.userData?.hideTerrainPresentation;

    if (hideTerrain) {
        if (!samplePresentationState.overridden) {
            samplePresentationState.overridden = true;
            samplePresentationState.terrainVisible = worldFloor?.visible ?? true;
            samplePresentationState.grassVisible = grassField?.mesh?.visible ?? true;
            samplePresentationState.waterVisible = water?.mesh?.visible ?? true;
        }

        if (worldFloor) {
            worldFloor.visible = false;
            worldFloor.userData.skipLightmap = true;
        }
        if (water?.mesh) water.mesh.visible = false;
        if (grassField?.setVisible) grassField.setVisible(false);
        else if (grassField?.mesh) grassField.mesh.visible = false;
        return;
    }

    if (!samplePresentationState.overridden) return;

    if (worldFloor) {
        worldFloor.visible = samplePresentationState.terrainVisible;
        delete worldFloor.userData.skipLightmap;
    }
    if (water?.mesh) water.mesh.visible = samplePresentationState.waterVisible;
    if (grassField?.setVisible) grassField.setVisible(samplePresentationState.grassVisible);
    else if (grassField?.mesh) grassField.mesh.visible = samplePresentationState.grassVisible;

    samplePresentationState.overridden = false;
}

function refreshGameplayWorld({ resetCamera = true } = {}) {
    if (!currentMesh) {
        gameplay.canPlay = physics.ready;
        updateGameplayUI();
        return;
    }

    currentMesh.updateWorldMatrix(true, true);
    gameplayBounds.setFromObject(currentMesh);
    gameplayLookTarget.copy(gameplayBounds.getCenter(tempVectorA));

    const worldSize = gameplayBounds.getSize(tempVectorB);
    const floorScale = Math.max(1, worldSize.x / 18, worldSize.z / 18);
    worldFloor.scale.setScalar(floorScale);
    worldFloor.position.set(gameplayLookTarget.x, TERRAIN_Y_OFFSET, gameplayLookTarget.z);
    positionLightGrid(gameplayLookTarget);

    const topHit = getGroundHitAt(gameplayLookTarget.x, gameplayLookTarget.z, false);
    if (topHit && topHit.point.y > worldFloor.position.y + 0.15) {
        gameplay.spawnPoint.set(
            gameplayLookTarget.x,
            topHit.point.y + PLAYER_SETTINGS.floorOffset,
            gameplayLookTarget.z
        );
    } else {
        const fallbackZ = gameplayBounds.max.z + Math.max(worldSize.z * 0.25, 2.5);
        const fallbackY = getGroundHeightAt(gameplayLookTarget.x, fallbackZ, true) ?? worldFloor.position.y;
        gameplay.spawnPoint.set(
            gameplayLookTarget.x,
            fallbackY + PLAYER_SETTINGS.floorOffset,
            fallbackZ
        );
    }

    gameplay.velocity.set(0, 0, 0);
    gameplay.grounded = false;
    rebuildTerrainPhysicsBody();
    rebuildModelPhysicsBody();
    if (physics.ready) {
        ensurePlayerCharacter();
    }
    gameplay.canPlay = !!physics.character;
    updateWorldPresentation();
    if (resetCamera) {
        resetShowcaseCamera(false);
    }
    updateGameplayUI();
}

// Terrain brush + foliage paint extracted to ../world/terrainBrushSystem.js
const _terrainBrushSystem = createTerrainBrushSystem({
    getWorldFloor: () => worldFloor,
    getRenderer: () => renderer,
    getCamera: () => camera,
    getCurrentMesh: () => currentMesh,
    pointerNdc, raycaster,
    terrainBrushState, gameplay, blueprintState, physics, grassField,
    getSelectedSceneActor,
    getActorRenderObject: (...a) => getActorRenderObject(...a),
    getSceneSystem: () => sceneSystem,
    actorBelongsToCurrentMesh,
    applyTerrainSculptBrush,
    serializeTerrainState,
    applySerializedTerrainState,
    rebuildTerrainPhysicsBody: (...a) => rebuildTerrainPhysicsBody(...a),
    ensurePlayerCharacter: (...a) => ensurePlayerCharacter(...a),
    updateWorldPresentation: (...a) => updateWorldPresentation(...a),
    updateGameplayUI: (...a) => updateGameplayUI(...a),
});
const ensureTerrainBrushHelper = _terrainBrushSystem.ensureTerrainBrushHelper;
const isTerrainBrushTargetActor = _terrainBrushSystem.isTerrainBrushTargetActor;
const getSelectedTerrainBrushActor = _terrainBrushSystem.getSelectedTerrainBrushActor;
const sceneHasActorTerrainBrushTarget = _terrainBrushSystem.sceneHasActorTerrainBrushTarget;
const getTerrainBrushTargetObject = _terrainBrushSystem.getTerrainBrushTargetObject;
const getTerrainHitFromEvent = _terrainBrushSystem.getTerrainHitFromEvent;
const updateTerrainBrushPreview = _terrainBrushSystem.updateTerrainBrushPreview;
const applyTerrainBrushFromEvent = _terrainBrushSystem.applyTerrainBrushFromEvent;
const serializeWorldTerrainState = _terrainBrushSystem.serializeWorldTerrainState;
const applyWorldTerrainState = _terrainBrushSystem.applyWorldTerrainState;

// Terrain panel + gameplay events + showcase input extracted to
// ../ui/inputPanels.js. Eager wiring: init() calls setupTerrainPanel/
// setupGameplayEvents before wireExtractedModules. Live refs via appCore.
const _inputPanels = createInputPanels({
    blueprintState, collisionDebugState, debugConsoleState, gameplay,
    objectScriptState, physics, pointerNdc, raycaster, runtimeAudio,
    showcase, terrainBrushState, vehicleState,
    focusCurrentShowcaseSelection, focusShowcaseCameraOnObject,
    // Handlers come from createInputHandlers (wired below). inputPanels
    // stores these refs in its closure and binds them inside setupGameplayEvents
    // (run from init()). Lazy thunks defer binding lookup to addEventListener
    // invocation time, by which point the const is initialized.
    handlePointerLockChange: (...a) => handlePointerLockChange(...a),
    handleShowcaseContextMenu: (...a) => handleShowcaseContextMenu(...a),
    handleShowcaseWheel: (...a) => handleShowcaseWheel(...a),
    isEditableElement,
    copySelectedToClipboard, deleteSelectedActor, duplicateSelected,
    editorHistory, getDynamicPropById, getDynamicPropHitFromEvent,
    handleDebugConsoleKeydown, isTransformControlSphereHit,
    maybeOpenObjectScriptMenuFromMobileTap, pasteFromClipboard,
    playAudioTestCue, refreshBlueprintComponents, runMouseAction,
    setTerrainCustomImage, setTerrainModeGrassPBR, setTerrainModeGrid,
    setTerrainModeSolid, setTerrainRepeat, setTerrainRoughness,
    setTerrainTint, updateBlueprintTransformUI,
    enterVehicle, exitVehicle, getActiveVehicleProp, getActorRenderObject,
    handleGameplayMouseMove: (...a) => handleGameplayMouseMove(...a),
    handleLightGridClick,
    handleShowcaseMouseButton: (...a) => handleShowcaseMouseButton(...a),
    isDrivingVehicle,
    respawnPlayer: (...a) => respawnPlayer(...a),
    selectShowcaseActor,
    setCollisionDebugEnabled, updateGameplayUI,
});
const setupTerrainPanel = _inputPanels.setupTerrainPanel;
const setupGameplayEvents = _inputPanels.setupGameplayEvents;
const adjustShowcaseSpeed = _inputPanels.adjustShowcaseSpeed;
const updateShowcaseInput = _inputPanels.updateShowcaseInput;
const handleGameplayKeyEvent = _inputPanels.handleGameplayKeyEvent;

const _inputHandlers = createInputHandlers({
    THREE,
    renderer: () => renderer,
    camera: () => camera,
    physics,
    sceneSystem: () => sceneSystem,
    gameplay, showcase, blueprintState, terrainBrushState, objectScriptState,
    PLAYER_SETTINGS,
    applyTerrainBrushFromEvent, updateTerrainBrushPreview,
    applyShowcaseCameraRotation,
    applyGameplayCameraRotation: (...a) => applyGameplayCameraRotation(...a),
    runMouseAction,
    isTransformControlSphereHit, getDynamicPropHitFromEvent,
    selectShowcaseActor: (...a) => selectShowcaseActor(...a),
    closeObjectScriptMenu, closeObjectScriptEditor,
    rebuildModelPhysicsBody, rebuildTerrainPhysicsBody,
    worldFloor: () => worldFloor,
    syncTransformControlState,
    updateWorldPresentation: (...a) => updateWorldPresentation(...a),
    updateGameplayUI: (...a) => updateGameplayUI(...a),
    resetMovementInputState,
    clearShooterProjectiles, clearShooterAimWarnings,
    clearGameplayEffects, clearHeldWeapon,
    restoreSceneState,
    repairSampleCollisionHierarchyAfterRestore: (...a) => repairSampleCollisionHierarchyAfterRestore(...a),
    resetDoomMiniLevelState, resetDoomArenaLevelState,
    resetShowcaseCamera: (...a) => resetShowcaseCamera(...a),
    adjustShowcaseSpeed,
    handleGameLauncherPause: handleMobileExitPlay,
});
const handleGameplayMouseMove = _inputHandlers.handleGameplayMouseMove;
const handleShowcaseMouseButton = _inputHandlers.handleShowcaseMouseButton;
const handleShowcaseContextMenu = _inputHandlers.handleShowcaseContextMenu;
const handleShowcaseWheel = _inputHandlers.handleShowcaseWheel;
const handlePointerLockChange = _inputHandlers.handlePointerLockChange;


function enterGameplay() {
    if (!gameplay.canPlay && physics.ready) {
        gameplay.canPlay = true;
        ensurePlayerCharacter();
    }
    if (!gameplay.canPlay) return;

    snapshotSceneState();
    if (!syncGameplaySpawnFromPlayerSpawnActor()) {
        syncGameplaySpawnToCamera();
    }
    respawnPlayer(true);
    gameplay.pointerLocked = false;
    gameplay.active = true;
    syncGameplayPrefabVisibility();
    syncTransformControlState();
    resetAllScriptLifecycleHandles();
    applyMouseActionScripts({ persist: true });
    showcase.looking = false;
    resetMobileInputState();
    updateWorldPresentation();
    updateGameplayUI();

    // Never request pointer lock on touch devices — it triggers the OS
    // "switch apps / show cursor" prompt and breaks touch gameplay. Guard on
    // both the mobile flag AND a coarse-pointer check in case the flag is stale.
    const isTouch = mobileState.enabled
        || (typeof window !== 'undefined' && window.matchMedia?.('(pointer:coarse)')?.matches)
        || document.body.classList.contains('is-mobile');
    if (!isTouch) {
        renderer.domElement.requestPointerLock?.();
    }
}

function repairSampleCollisionHierarchyAfterRestore() {
    if (!currentMesh || !currentMesh.userData?.sampleType || !sceneSystem?.actors?.size) return;

    let reparented = 0;
    for (const actor of sceneSystem.actors) {
        if (!actor?.userData?.sampleLevelPart) continue;
        const actorMesh = getActorRenderObject(actor);
        if (!actorMesh || actorMesh.parent === currentMesh) continue;
        currentMesh.add(actorMesh);
        reparented++;
    }

    if (reparented > 0) {
        rebuildModelPhysicsBody();
        if (collisionDebugState.enabled) refreshCollisionDebugOverlays();
    }
}

function exitGameplay() {
    if (isMobileGamePaused()) {
        closeMobileGamePauseMenu({ restorePause: false });
        gameplay.roguePaused = false;
    }

    if (!mobileState.enabled && document.pointerLockElement === renderer.domElement) {
        document.exitPointerLock();
        return;
    }

    if (!gameplay.active && !gameplay.pointerLocked) return;

    gameplay.pointerLocked = false;
    gameplay.active = false;
    gameplay.dead = false;
    if (gameplay.respawnTimer) {
        clearTimeout(gameplay.respawnTimer);
        gameplay.respawnTimer = null;
    }
    clearActiveVehicle();
    clearShooterProjectiles();
    clearShooterAimWarnings();
    clearGameplayEffects();
    clearHeldWeapon();
    // Async restore: run actor-dependent cleanup AFTER the world reload
    // resolves (see handlePointerLockChange for the same fix).
    console.log('[STOP] exitGameplay → restore; sampleType=',
        currentMesh?.userData?.sampleType);
    Promise.resolve(restoreSceneState()).then((restored) => {
        console.log('[STOP] exitGameplay restore resolved =', restored,
            'actors=', sceneSystem?.actors?.size);
        repairSampleCollisionHierarchyAfterRestore();
        resetSoccerLevelState();
        const did = resetDoomMiniLevelState();
        resetDoomArenaLevelState();
        // Drug Tycoon restarts on exit so rejoining gives a fresh economy/grow.
        try { window.drugTycoonApi?.resetState?.(); } catch (e) {}
        console.log('[STOP] exitGameplay resetDoomMiniLevelState ran =', did);
    });
    gameplay.velocity.set(0, 0, 0);
    physics.jumpQueued = false;
    physics.desiredVelocity.set(0, 0, 0);
    showcase.looking = false;
    showcase.velocity.set(0, 0, 0);
    showcase.input.forward = false;
    showcase.input.back = false;
    showcase.input.left = false;
    showcase.input.right = false;
    showcase.input.up = false;
    showcase.input.down = false;
    showcase.input.boost = false;
    resetMobileInputState();
    syncTransformControlState();

    updateWorldPresentation();
    syncGameplayPrefabVisibility();
    resetShowcaseCamera(false);
    updateGameplayUI();
}

function forceExitGameplayForWorldLoad() {
    if (isMobileGamePaused()) {
        closeMobileGamePauseMenu({ restorePause: false });
        gameplay.roguePaused = false;
    }

    if (!mobileState.enabled && document.pointerLockElement === renderer?.domElement) {
        document.exitPointerLock?.();
    }

    gameplay.pointerLocked = false;
    gameplay.active = false;
    gameplay.dead = false;
    if (gameplay.respawnTimer) {
        clearTimeout(gameplay.respawnTimer);
        gameplay.respawnTimer = null;
    }
    clearActiveVehicle();
    clearShooterProjectiles();
    clearShooterAimWarnings();
    clearGameplayEffects();
    clearHeldWeapon();
    gameplay.velocity.set(0, 0, 0);
    physics.jumpQueued = false;
    physics.desiredVelocity.set(0, 0, 0);
    showcase.looking = false;
    showcase.velocity.set(0, 0, 0);
    resetMobileInputState();
    syncTransformControlState();
    updateWorldPresentation();
    updateGameplayUI();
}

function updateWorldPresentation() {
    syncSampleWorldPresentation();
    if (pedestal) pedestal.visible = !gameplay.active && !currentMesh?.userData?.hideTerrainPresentation;
    document.body.classList.toggle('play-ready', gameplay.canPlay);
    const wasActive = document.body.classList.contains('play-active');
    document.body.classList.toggle('play-active', gameplay.active);
    if (wasActive !== gameplay.active && renderer && camera && container) {
        // Layout shifts when scene panel hides; resync canvas/aspect.
        requestAnimationFrame(onWindowResize);
    }
}

function updateMainDirectionalLightShadowFocus() {
    if (!mainDirectionalLight || !camera) return;

    mainDirectionalLightShadowFocus.copy(camera.position);
    mainDirectionalLightShadowFocus.y = worldFloor?.position?.y ?? 0;
    const shadowTexelSize = (MAIN_SHADOW_EXTENT * 2) / (mainDirectionalLight.shadow.mapSize.width || 4096);
    mainDirectionalLightShadowFocus.x = Math.round(mainDirectionalLightShadowFocus.x / shadowTexelSize) * shadowTexelSize;
    mainDirectionalLightShadowFocus.z = Math.round(mainDirectionalLightShadowFocus.z / shadowTexelSize) * shadowTexelSize;

    mainDirectionalLight.position.copy(mainDirectionalLightShadowFocus).add(mainDirectionalLightOffset);
    mainDirectionalLight.target.position.copy(mainDirectionalLightShadowFocus);
    mainDirectionalLight.target.updateMatrixWorld();
}

// Toggle Cascaded Shadow Maps on the main sun/directional light. CSM splits the
// view frustum into `cascades` slices, each rendered into its own tight shadow
// camera, then blends them — sharp contact shadows up close, cheap coverage far
// out (vs one stretched ortho map). The CSMShadowNode self-updates its cascade
// frustums each frame from the active camera; we just attach/detach it.
let _mainCSM = null;
function setMainLightCSM(enabled, cascades = 3) {
    const light = mainDirectionalLight;
    if (!light?.shadow) return;
    const want = !!enabled;
    const haveSame = _mainCSM && want && _mainCSM.cascades === cascades;
    if (haveSame) return;
    // Tear down any existing CSM node first.
    if (_mainCSM) {
        try { _mainCSM.dispose?.(); } catch (e) {}
        _mainCSM = null;
    }
    if (!want) {
        light.shadow.shadowNode = null;          // back to the default single-cascade PCF shadow
        return;
    }
    try {
        _mainCSM = new CSMShadowNode(light, {
            cascades: Math.max(1, Math.min(4, cascades | 0)),
            maxFar: MAIN_SHADOW_FAR,
            mode: 'practical',
            lightMargin: 200,
        });
        // ShadowBaseNode reads .camera from the node builder on first setup; the
        // attach is all we need for the WebGPU shadow pass to pick it up.
        light.shadow.shadowNode = _mainCSM;
    } catch (e) {
        console.warn('[CSM] failed to enable cascaded shadows', e);
        _mainCSM = null;
        light.shadow.shadowNode = null;
    }
}

// Avoid clobbering DOM textContent every call: writing the same string still
// triggers layout invalidation in some browsers and shows up as churn under
// heavy frame loads.
function setTextIfChanged(element, value) {
    if (!element) return;
    if (element.textContent !== value) element.textContent = value;
}

const GAME_MODE_TYPES = ['drugTycoon', 'doomArena', 'doomTest', 'shootingSim'];

function updateGameplayUI() {
    const hasAsset = !!currentMesh;
    const mobileActive = mobileState.enabled;
    const drivingVehicle = isDrivingVehicle();
    // Game modes (Drug Tycoon, Rogue, etc) have their own HUD/prompts, so hide
    // the generic status + controls hint while playing one — they just clutter
    // behind the mode's overlay.
    const inGameMode = gameplay.active
        && GAME_MODE_TYPES.includes(currentMesh?.userData?.sampleType);

    setTextIfChanged(resetViewBtn, gameplay.active ? 'Respawn' : 'Reset View');

    updateCameraModeButtons();

    if (gameplayStatus) gameplayStatus.style.display = inGameMode ? 'none' : '';
    if (gameplayStatus && !inGameMode) {
        let statusText;
        if (mobileActive && drivingVehicle) statusText = 'Mobile driving active';
        else if (mobileActive && gameplay.active) statusText = 'Mobile play active';
        else if (mobileActive) statusText = 'Mobile showcase ready';
        else if (drivingVehicle) statusText = 'Driving summoned car';
        else if (!hasAsset && gameplay.active) statusText = gameplay.grounded ? 'Exploring terrain' : 'Airborne';
        else if (!hasAsset) statusText = `Showcase free-fly ready. Camera speed ${showcase.moveSpeed.toFixed(1)}x.`;
        else if (gameplay.active) statusText = gameplay.grounded ? 'Exploring scene' : 'Airborne';
        else statusText = `Scene ready. Showcase speed ${showcase.moveSpeed.toFixed(1)}x.`;
        setTextIfChanged(gameplayStatus, statusText);
    }

    if (playHint) playHint.style.display = inGameMode ? 'none' : '';
    if (playHint && !inGameMode) {
        let hintText;
        if (mobileActive && drivingVehicle) hintText = 'Touch left pad to drive, right pad to look, hold Brake to slow down, tap the scene for play scripts, and tap E on keyboard to hop out.';
        else if (mobileActive && gameplay.active) hintText = 'Touch left pad to move, right pad to look, tap the scene to run play scripts, and use Jump to hop.';
        else if (mobileActive) hintText = 'Touch left pad to move, right pad to look, double-tap a prop to open its script menu, and use Menu for assets.';
        else if (drivingVehicle) hintText = 'W/S drive, A/D steer, Shift boost, Space brake, E exit car, R respawn, Esc exit play mode.';
        else if (!hasAsset && gameplay.active) hintText = 'WASD move, mouse look, Space jump, Shift sprint, E enter nearby car, V summon car, R respawn, Esc exit.';
        else if (!hasAsset) hintText = 'Showcase: hold right mouse to look, use WASD to move, Q/E for down/up, Shift to boost, and mouse wheel to change camera speed.';
        else if (gameplay.active) hintText = 'WASD move, mouse look, Space jump, Shift sprint, E enter nearby car, V summon car, R respawn, Esc exit.';
        else hintText = 'Showcase: hold right mouse to look, use WASD to move, Q/E for down/up, Shift to boost, and mouse wheel to change camera speed. Play mode still uses pointer lock.';
        setTextIfChanged(playHint, hintText);
    }

    updateMobileButtons();
    setExampleWidgetsVisible(gameplay.active);
    updateMouseActionStatus();
    updateWorldPresentation();
}

function getShowcaseTarget() {
    if (!currentMesh) {
        return SHOWCASE_CAMERA_TARGET;
    }

    return tempVectorA.set(
        gameplayLookTarget.x,
        Math.max(1.25, gameplayBounds.max.y * 0.35),
        gameplayLookTarget.z
    );
}

function resetShowcaseCamera(animate = true) {
    if (gameplay.active) return;

    const target = getShowcaseTarget();
    const animatedLookTarget = {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
    };

    if (!animate) {
        camera.position.copy(SHOWCASE_CAMERA_POSITION);
        syncShowcaseAnglesFromTarget(target);
        applyShowcaseCameraRotation();
        showcase.velocity.set(0, 0, 0);
        return;
    }

    gsap.killTweensOf(camera.position);
    gsap.killTweensOf(animatedLookTarget);

    gsap.to(camera.position, {
        x: SHOWCASE_CAMERA_POSITION.x,
        y: SHOWCASE_CAMERA_POSITION.y,
        z: SHOWCASE_CAMERA_POSITION.z,
        duration: 0.9,
        overwrite: true,
        onUpdate: () => {
            syncShowcaseAnglesFromTarget(tempVectorB.set(animatedLookTarget.x, animatedLookTarget.y, animatedLookTarget.z));
            applyShowcaseCameraRotation();
        },
    });

    gsap.to(animatedLookTarget, {
        x: target.x,
        y: target.y,
        z: target.z,
        duration: 0.9,
        overwrite: true,
        onUpdate: () => {
            syncShowcaseAnglesFromTarget(tempVectorB.set(animatedLookTarget.x, animatedLookTarget.y, animatedLookTarget.z));
            applyShowcaseCameraRotation();
        },
    });
}

const _frameLoop = createFrameLoop({
    THREE,
    camera: () => camera,
    currentMesh: () => currentMesh,
    worldFloor: () => worldFloor,
    physics,
    gameplay, gameplayLookTarget, showcase,
    PLAYER_SETTINGS,
    upVector,
    tempVectorA, tempVectorB, tempVectorC, tempVectorD, tempVectorE, tempVectorF,
    copyJoltVector,
    isDrivingVehicle,
    updateVehicleGameplay: (...a) => updateVehicleGameplay(...a),
    silenceVehicleEngineAudio,
    updateEngineAudioDebugOverlay,
    syncCameraToCharacter: (...a) => syncCameraToCharacter(...a),
    ensurePlayerCharacter: (...a) => ensurePlayerCharacter(...a),
    resetGameplayPrefabs,
    clearActiveVehicle,
    updateDoomMiniLevelState: (...a) => updateDoomMiniLevelState(...a),
    updateDoomArenaLevelState: (...a) => updateDoomArenaLevelState(...a),
    updateRogueXpOrbs: (...a) => updateRogueXpOrbs(...a),
    updateDrugTycoonState: (...a) => updateDrugTycoonState(...a),
    updateShootingSimState: (...a) => updateShootingSimState(...a),
    updateGameplayUI: (...a) => updateGameplayUI(...a),
    resetDoomMiniLevelState,
    resetDoomArenaLevelState,
});
const updateShowcaseCamera = _frameLoop.updateShowcaseCamera;
const applyGameplayCameraRotation = _frameLoop.applyGameplayCameraRotation;
const applyCameraRecoil = _frameLoop.applyCameraRecoil;
const respawnPlayer = _frameLoop.respawnPlayer;
const updateGameplay = _frameLoop.updateGameplay;
registerEngineWeapons({ applyCameraRecoil });


const HELI_SETTINGS = {
    maxLift: 14,
    liftAccel: 18,
    descendAccel: 10,
    hoverDamping: 1.6,
    maxForwardSpeed: 22,
    maxStrafeSpeed: 12,
    pitchAccel: 2.8,
    rollAccel: 2.8,
    yawRate: 1.8,
    yawAccel: 5,
    tiltAngle: 0.45,
    horizontalDrag: 0.55,
    levelTorque: 4.5,
};

// Prefab user-script source strings moved to ../gameplay/prefabScripts.js
// (imported at top of file). 421 lines of template-literal program text.

// Dedicated scratch for updateHelicopterGameplay; same rationale as the car
// scratch above (global tempVectors get overwritten mid-function).
// Vehicle/helicopter physics + ground/wall raycast extracted to
// ../vehicle/vehiclePhysics.js. Eager module-scope wiring: the 3 public
// fns are only called from updateGameplay (runtime), declared here before
// that runs. camera/currentMesh/sceneSystem/worldFloor via appCore.
const _vehiclePhysics = createVehiclePhysics({
    HELI_SETTINGS, PLAYER_SETTINGS, VEHICLE_SETTINGS,
    downVector, emitVehicleSurfaceEffects, gameplay, gameplayBounds,
    physics, raycaster, tempVectorA, tempVectorB, tempVectorE, upVector,
    vehicleState,
    clearActiveVehicle, copyJoltQuaternion, copyJoltVector,
    ensureVehicleVisualState, exitVehicle, getActiveVehicleProp,
    getActorRenderObject, getVehicleForward, positionVehicleCamera,
    respawnPlayer, sampleTerrainHeightAt,
    updateRaycasterDebugLine, updateVehicleEngineAudio,
});
const updateHelicopterGameplay = _vehiclePhysics.updateHelicopterGameplay;
const updateVehicleGameplay = _vehiclePhysics.updateVehicleGameplay;
const getGroundHitAt = _vehiclePhysics.getGroundHitAt;
const getGroundHeightAt = _vehiclePhysics.getGroundHeightAt;
const resolveHorizontalMovement = _vehiclePhysics.resolveHorizontalMovement;


// File handling (drag-drop) + showcase asset optimization pipeline
// extracted to ../optim/showcaseOptimizer.js. Factory instantiated below.

// --- Controls ---
document.getElementById('toggle-wireframe')?.addEventListener('click', () => {
    if (!currentMesh) return;
    currentMesh.traverse(child => {
        if (child.isMesh) child.material.wireframe = !child.material.wireframe;
    });
});

document.getElementById('reset-view')?.addEventListener('click', () => {
    resetShowcaseCamera();
});

// === UMAP SCENE EXPORT / IMPORT ===
const sceneBundle = createSceneBundle({
    exportWorldToJSON: (opts) => exportWorldToJSON(opts),
    getImportedTemplate: (id) => getImportedTemplate(id),
    importedPropState,
});
const exportWorldToUmap = sceneBundle.exportWorldToUmap;
const exportWorldToSceneFolder = sceneBundle.exportWorldToSceneFolder;

// === extracted: sceneSerialization (functions) (was lines 9531-10083 of original main.js) ===

document.getElementById('save-scene-btn')?.addEventListener('click', exportWorldToUmap);
document.getElementById('load-scene-btn')?.addEventListener('click', () => {
    document.getElementById('scene-file-input')?.click();
});
document.getElementById('scene-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        loadWorldFromUmap(file);
        e.target.value = '';
    }
});

document.getElementById('save-scene-folder-btn')?.addEventListener('click', () => {
    exportWorldToSceneFolder().catch((err) => {
        console.error('Save Scene Folder failed.', err);
    });
});
document.getElementById('load-scene-folder-btn')?.addEventListener('click', () => {
    document.getElementById('scene-folder-input')?.click();
});
document.getElementById('scene-folder-input')?.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length > 0) {
        loadWorldFromSceneFolder(files).catch((err) => {
            console.error('Load Scene Folder failed.', err);
        });
        e.target.value = '';
    }
});

// Prefab system extracted to ../runtime/prefabSystem.js. Instantiated
// eagerly here (module-eval order) so init() can call
// registerBuiltinPrefabs/loadPrefabManifest before wireExtractedModules.
const _prefabSystem = createPrefabSystem({
    dynamicBodySpatial, gameplay, objectScriptState, physics,
    tempVectorD, tempVectorE,
    createDynamicPrimitiveBody, createOwnedShape, getActorKindDefaultScale,
    getActorKindLabel, getActorRenderObject, getDynamicPropSpawn,
    invalidateDDGI, isLightActorKind, refreshSceneUI, saveObjectScriptDrafts,
    selectShowcaseActor, spawnDynamicPrimitive, spawnGameplayPrefab,
    spawnLightActor, createDynamicPropActor, loadActorFromFile,
    setActorComponentFlags, syncPropScriptState,
    spawnDDGIVolumeActor,
});
const registerBuiltinPrefabs = _prefabSystem.registerBuiltinPrefabs;
const loadPrefabManifest = _prefabSystem.loadPrefabManifest;

document.getElementById('reset-view')?.addEventListener('click', () => {
    if (gameplay.active) {
        respawnPlayer();
        return;
    }

    if (resetSoccerLevelState()) {
        refreshSceneUI();
    }
    syncGameplayPrefabVisibility();
    resetShowcaseCamera(true);
});

// === BLUEPRINT COMPONENT EDITOR ===
// === extracted: blueprintEditor (block 1) (was lines 10136-10773 of original main.js) ===

document.getElementById('btn-exit-blueprint')?.addEventListener('click', () => {
    exitBlueprintEditor();
});

document.getElementById('btn-edit-actor-script')?.addEventListener('click', () => {
    openObjectScriptEditor('tick');
});

document.getElementById('btn-bp-apply-physics')?.addEventListener('click', () => {
    editorHistory.captureState();
    applyBlueprintPhysicsEditor();
});

document.getElementById('btn-add-comp-cube')?.addEventListener('click', () => {
    editorHistory.captureState();
    const parent = blueprintState.selectedComponent || getActorRenderObject(getDynamicPropById(objectScriptState.targetPropId));
    if (!parent) return;
    
    const mesh = buildPrimitiveActorMesh('cube');
    mesh.scale.set(0.3, 0.3, 0.3);
    mesh.position.set(2, 0.5, 0);
    mesh.material = new THREE.MeshStandardMaterial({ color: 0xff6600, roughness: 0.4, metalness: 0.2 });
    mesh.name = 'Cube Component';
    parent.add(mesh);
    blueprintState.selectedComponent = mesh;
    blueprintState.selectedComponents.clear();
    blueprintState.materialMultiSelectActive = false;
    blueprintState.selectedComponents.add(mesh);
    if (typeof transformControl !== 'undefined') transformControl.attach(mesh);
    refreshBlueprintComponents();
});

document.getElementById('btn-add-comp-sphere')?.addEventListener('click', () => {
    editorHistory.captureState();
    const parent = blueprintState.selectedComponent || getActorRenderObject(getDynamicPropById(objectScriptState.targetPropId));
    if (!parent) return;
    
    const mesh = buildPrimitiveActorMesh('sphere');
    mesh.scale.set(0.3, 0.3, 0.3);
    mesh.position.set(0, 0.5, 2);
    mesh.material = new THREE.MeshStandardMaterial({ color: 0x00cc66, roughness: 0.4, metalness: 0.2 });
    mesh.name = 'Sphere Component';
    parent.add(mesh);
    blueprintState.selectedComponent = mesh;
    blueprintState.selectedComponents.clear();
    blueprintState.materialMultiSelectActive = false;
    blueprintState.selectedComponents.add(mesh);
    if (typeof transformControl !== 'undefined') transformControl.attach(mesh);
    refreshBlueprintComponents();
});

document.getElementById('btn-add-comp-collision-box')?.addEventListener('click', () => {
    editorHistory.captureState();
    const prop = getDynamicPropById(objectScriptState.targetPropId);
    const parent = blueprintState.selectedComponent || getActorRenderObject(prop);
    if (!parent) return;

    const mesh = buildCollisionBoxComponent();
    mesh.scale.set(0.55, 0.55, 0.55);
    mesh.position.set(0, 0.75, 0);
    parent.add(mesh);
    blueprintState.selectedComponent = mesh;
    blueprintState.selectedComponents.clear();
    blueprintState.materialMultiSelectActive = false;
    if (typeof transformControl !== 'undefined') {
        transformControl.attach(mesh);
        transformControl.setMode?.('translate');
    }
    if (prop) rebuildActorPhysics(prop);
    refreshBlueprintComponents();
});

document.getElementById('btn-add-comp-light')?.addEventListener('click', () => {
    editorHistory.captureState();
    const parent = blueprintState.selectedComponent || getActorRenderObject(getDynamicPropById(objectScriptState.targetPropId));
    if (!parent) return;
    
    const light = new THREE.PointLight(0xffddaa, 2, 10);
    light.position.set(0, 2, 0);
    light.castShadow = true;
    configurePointLightShadow(light, {
        mapSize: 512,
        bias: 0.0005,
        normalBias: 0.02,
        radius: 2.5,
    });
    light.name = 'Point Light';
    parent.add(light);
    blueprintState.selectedComponent = light;
    blueprintState.selectedComponents.clear();
    blueprintState.materialMultiSelectActive = false;
    if (typeof transformControl !== 'undefined') transformControl.attach(light);
    refreshBlueprintComponents();
});

document.getElementById('btn-add-comp-spot-light')?.addEventListener('click', () => {
    editorHistory.captureState();
    const parent = blueprintState.selectedComponent || getActorRenderObject(getDynamicPropById(objectScriptState.targetPropId));
    if (!parent) return;

    const light = new THREE.SpotLight(0xfff2cc, 6, 18, Math.PI / 6, 0.35, 2);
    light.position.set(0, 2, 0);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.name = 'Spot Light';
    light.target.position.set(0, -1.5, 0);
    light.add(light.target);
    parent.add(light);
    blueprintState.selectedComponent = light;
    blueprintState.selectedComponents.clear();
    blueprintState.materialMultiSelectActive = false;
    if (typeof transformControl !== 'undefined') transformControl.attach(light);
    refreshBlueprintComponents();
});

document.getElementById('btn-delete-comp')?.addEventListener('click', () => {
    editorHistory.captureState();
    const prop = getDynamicPropById(objectScriptState.targetPropId);
    const rootMesh = getActorRenderObject(prop);
    const selected = blueprintState.selectedComponent;
    
    if (!selected || selected === rootMesh) {
        alert("Cannot delete the root component!");
        return;
    }
    
    if (selected.parent) {
        selected.parent.remove(selected);
        if (selected.geometry) selected.geometry.dispose();
        if (selected.material) selected.material.dispose();
        
        blueprintState.selectedComponent = rootMesh;
        blueprintState.selectedComponents.delete(selected);
        blueprintState.selectedComponents.clear();
        blueprintState.materialMultiSelectActive = false;
        if (typeof transformControl !== 'undefined') transformControl.attach(rootMesh);
        rebuildActorPhysics(prop);
        refreshBlueprintComponents();
    }
});

init().then(() => {
    applyMobileModeState();
}).catch((err) => console.error('init failed', err));

// Blueprint Transform Controls
// === extracted: blueprintEditor (block 2) (was lines 10886-10972 of original main.js) ===

['bp-loc-x', 'bp-loc-y', 'bp-loc-z', 'bp-rot-x', 'bp-rot-y', 'bp-rot-z', 'bp-scl-x', 'bp-scl-y', 'bp-scl-z'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
        applyBlueprintDetailsFromUI();
        if (blueprintState.active) {
            const prop = getDynamicPropById(objectScriptState.targetPropId);
            if (prop) rebuildActorPhysics(prop);
        }
    });
});

// Blueprint panel: Save/Load Actor buttons
document.getElementById('bp-material-color')?.addEventListener('input', () => {
    previewBlueprintMaterialEdits();
});
document.getElementById('bp-material-emissive')?.addEventListener('input', () => {
    previewBlueprintMaterialEdits();
});
document.getElementById('bp-material-roughness')?.addEventListener('input', () => {
    syncBlueprintMaterialScalarInput('bp-material-roughness', 'bp-material-roughness-number', 0.5, 0, 1);
    previewBlueprintMaterialEdits();
});
document.getElementById('bp-material-roughness-number')?.addEventListener('change', () => {
    syncBlueprintMaterialScalarInput('bp-material-roughness-number', 'bp-material-roughness', 0.5, 0, 1);
    previewBlueprintMaterialEdits();
});
document.getElementById('bp-material-metalness')?.addEventListener('input', () => {
    syncBlueprintMaterialScalarInput('bp-material-metalness', 'bp-material-metalness-number', 0, 0, 1);
    previewBlueprintMaterialEdits();
});
document.getElementById('bp-material-metalness-number')?.addEventListener('change', () => {
    syncBlueprintMaterialScalarInput('bp-material-metalness-number', 'bp-material-metalness', 0, 0, 1);
    previewBlueprintMaterialEdits();
});
document.getElementById('bp-material-emissive-intensity')?.addEventListener('input', () => {
    syncBlueprintMaterialScalarInput('bp-material-emissive-intensity', 'bp-material-emissive-intensity-number', 1, 0, 8);
    previewBlueprintMaterialEdits();
});
document.getElementById('bp-material-emissive-intensity-number')?.addEventListener('change', () => {
    syncBlueprintMaterialScalarInput('bp-material-emissive-intensity-number', 'bp-material-emissive-intensity', 1, 0, 8);
    previewBlueprintMaterialEdits();
});
document.getElementById('bp-material-opacity')?.addEventListener('input', () => {
    syncBlueprintMaterialScalarInput('bp-material-opacity', 'bp-material-opacity-number', 1, 0, 1);
    previewBlueprintMaterialEdits();
});
document.getElementById('bp-material-opacity-number')?.addEventListener('change', () => {
    syncBlueprintMaterialScalarInput('bp-material-opacity-number', 'bp-material-opacity', 1, 0, 1);
    previewBlueprintMaterialEdits();
});
document.getElementById('bp-material-alpha-test')?.addEventListener('input', () => {
    syncBlueprintMaterialScalarInput('bp-material-alpha-test', 'bp-material-alpha-test-number', 0, 0, 1);
    previewBlueprintMaterialEdits();
});
document.getElementById('bp-material-alpha-test-number')?.addEventListener('change', () => {
    syncBlueprintMaterialScalarInput('bp-material-alpha-test-number', 'bp-material-alpha-test', 0, 0, 1);
    previewBlueprintMaterialEdits();
});
document.getElementById('bp-material-env-intensity')?.addEventListener('input', () => {
    syncBlueprintMaterialScalarInput('bp-material-env-intensity', 'bp-material-env-intensity-number', 1, 0, 4);
    previewBlueprintMaterialEdits();
});
document.getElementById('bp-material-env-intensity-number')?.addEventListener('change', () => {
    syncBlueprintMaterialScalarInput('bp-material-env-intensity-number', 'bp-material-env-intensity', 1, 0, 4);
    previewBlueprintMaterialEdits();
});
document.getElementById('bp-material-side')?.addEventListener('change', () => {
    previewBlueprintMaterialEdits();
});

document.getElementById('bp-light-color')?.addEventListener('input', () => {
    applyBlueprintLightEdits({ statusMessage: 'Light color updated.' });
});
document.getElementById('bp-light-intensity')?.addEventListener('input', () => {
    syncBlueprintLightScalarInput('bp-light-intensity', 'bp-light-intensity-number', 1, 0, 20, 1);
    applyBlueprintLightEdits();
});
document.getElementById('bp-light-intensity-number')?.addEventListener('change', () => {
    syncBlueprintLightScalarInput('bp-light-intensity-number', 'bp-light-intensity', 1, 0, 20, 1);
    applyBlueprintLightEdits();
});
document.getElementById('bp-light-distance')?.addEventListener('input', () => {
    syncBlueprintLightScalarInput('bp-light-distance', 'bp-light-distance-number', 0, 0, 100, 1);
    applyBlueprintLightEdits();
});
document.getElementById('bp-light-distance-number')?.addEventListener('change', () => {
    syncBlueprintLightScalarInput('bp-light-distance-number', 'bp-light-distance', 0, 0, 100, 1);
    applyBlueprintLightEdits();
});
document.getElementById('bp-light-decay')?.addEventListener('input', () => {
    syncBlueprintLightScalarInput('bp-light-decay', 'bp-light-decay-number', 2, 0, 4, 1);
    applyBlueprintLightEdits();
});
document.getElementById('bp-light-decay-number')?.addEventListener('change', () => {
    syncBlueprintLightScalarInput('bp-light-decay-number', 'bp-light-decay', 2, 0, 4, 1);
    applyBlueprintLightEdits();
});
document.getElementById('bp-light-angle')?.addEventListener('input', () => {
    syncBlueprintLightScalarInput('bp-light-angle', 'bp-light-angle-number', 30, 1, 120, 0);
    applyBlueprintLightEdits();
});
document.getElementById('bp-light-angle-number')?.addEventListener('change', () => {
    syncBlueprintLightScalarInput('bp-light-angle-number', 'bp-light-angle', 30, 1, 120, 0);
    applyBlueprintLightEdits();
});
document.getElementById('bp-light-penumbra')?.addEventListener('input', () => {
    syncBlueprintLightScalarInput('bp-light-penumbra', 'bp-light-penumbra-number', 0, 0, 1, 2);
    applyBlueprintLightEdits();
});
document.getElementById('bp-light-penumbra-number')?.addEventListener('change', () => {
    syncBlueprintLightScalarInput('bp-light-penumbra-number', 'bp-light-penumbra', 0, 0, 1, 2);
    applyBlueprintLightEdits();
});
['bp-light-target-x', 'bp-light-target-y', 'bp-light-target-z'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => {
        applyBlueprintLightEdits({ statusMessage: 'Spot Light target updated.' });
    });
});
document.getElementById('bp-light-cast-shadow')?.addEventListener('change', () => {
    applyBlueprintLightEdits({ statusMessage: 'Light shadow setting updated.' });
});
document.getElementById('btn-bp-apply-material-selected')?.addEventListener('click', () => {
    applyBlueprintMaterialEdits({ applyToActor: false });
});
document.getElementById('btn-bp-apply-material-actor')?.addEventListener('click', () => {
    applyBlueprintMaterialEdits({ applyToActor: true });
});

document.getElementById('btn-bp-save-actor')?.addEventListener('click', () => {
    if (blueprintState.targetActor) {
        previewBlueprintMaterialEdits();
        exportActorToFile(blueprintState.targetActor);
    }
});
document.getElementById('btn-bp-load-actor')?.addEventListener('click', () => {
    document.getElementById('bp-actor-file-input')?.click();
});
document.getElementById('bp-actor-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        // Exit blueprint mode first, then load
        exitBlueprintEditor();
        loadActorFromFile(file);
        e.target.value = '';
    }
});

// === PIE (Play In Editor) Scene State Snapshot ===
// === extracted: sceneHistory (was lines 11115-11468 of original main.js) ===


// =============================================================================
// Wire extracted modules to engine state (called from init() once globals exist)
// =============================================================================
function wireExtractedModules() {
    // appCore is now bound eagerly at module load (see top of file); no
    // late re-bind here.

    // Rogue Waves game mode (extracted to src/gameplay/rogueWaves.js). Inject
    // engine deps; reassigned vars (scene/currentMesh/renderer) are read live
    // via appCore inside the module. Alias the returned API to the legacy
    // module-scope names existing call sites + the game-mode script use.
    {
        const rw = createRogueWaves({
            gameplay, mobileState, SHOOTER_AI_PREFAB,
            spawnDoomEnemyAt, getActorRenderObject, tintGameplayPrefabActor,
            setPlayerHealth, isDoomMiniWaveCleared, getGameplayPrefabActors,
            ensureGameplayPrefabScript, runObjectEventScript, flashActorHit,
            scratchPrefab: () => _scratchPrefab1,
            getRogueGameModeScript: () => ROGUE_GAMEMODE_SCRIPT,
            getResetDoomArenaLevelState: () => resetDoomArenaLevelState,
            respawnPlayer,
            equipDoomShotgun, equipStraightGun, equipThrowingStar,
        });
        ensureRogueState = rw.ensureRogueState;
        resetRogueState = rw.resetRogueState;
        spawnRogueXpOrb = rw.spawnRogueXpOrb;
        updateRogueXpOrbs = rw.updateRogueXpOrbs;
        grantRogueXp = rw.grantRogueXp;
        onRogueEnemyKilled = rw.onRogueEnemyKilled;
        spawnRogueHealthOrb = rw.spawnRogueHealthOrb;
        spawnRogueEnemy = rw.spawnRogueEnemy;
        openRogueCardPicker = rw.openRogueCardPicker;
        closeRogueCardPicker = rw.closeRogueCardPicker;
        openRogueWeaponPicker = rw.openRogueWeaponPicker;
        openRogueDeathScreen = rw.openRogueDeathScreen;
        closeRogueDeathScreen = rw.closeRogueDeathScreen;
        updateRogueXpBar = rw.updateRogueXpBar;
        setRogueWaveHud = rw.setRogueWaveHud;
        updateDoomArenaLevelState = rw.updateDoomArenaLevelState;
        updateRogueGameMode = rw.updateRogueGameMode;
        RogueAPI = rw.RogueAPI;
    }

    // Drug Tycoon (self-contained tycoon mode, own level). Same factory pattern
    // as rogueWaves; only the per-frame driver is wired into the frame loop.
    {
        const dt = createDrugTycoon({
            gameplay,
            physics,
            setPlayerHealth,
        });
        updateDrugTycoonState = dt.updateDrugTycoonState;
    }

    // Shooting Simulator (self-contained range mode, own level). Same factory
    // pattern; only the per-frame driver is wired into the frame loop.
    {
        const ss = createShootingSim({ gameplay });
        updateShootingSimState = ss.updateShootingSimState;
    }

    // Built-in level builders (extracted to ../world/levels.js). Inject engine
    // deps; resetRogueState is a reassigned `let` (set by the rogue wiring
    // above) so pass it through a live wrapper, not by value.
    {
        const lv = createLevels({
            PLAYER_SETTINGS, physics, soccerGoalieState, gameplay,
            actorBelongsToCurrentMesh, applyPlayerSpawnFromActor, buildPrimitiveActorMesh,
            configurePointLightShadow, createDoomMiniBarrierEntries, createDynamicPropActor,
            createTerrainMesh, getActorBody, getActorRenderObject, markDDGISkipCapture,
            rebuildActorPhysics,
            resetRogueState: (...a) => resetRogueState(...a),
            setActorColor, setActorComponentFlags,
            setActorResetTransform, setActorWorldPositionExact, setTerrainModeGrid,
            spawnDynamicPrimitive, spawnGameplayPrefab,
            syncActorBodyToRenderTransform,
            tagGameplayPrefabActor,
            tintGameplayPrefabActor,
            updateSoccerGoalies: (...a) => updateSoccerGoalies(...a),
            // Showcase preset for graphics-demo levels (e.g. the shooting range):
            // turn on the post stack so it looks its best. Not persisted, so it
            // never overwrites the user's saved global graphics prefs.
            applyShowcaseGraphics: () => {
                try {
                    const s = worldEnvState;
                    if (s.ssao) s.ssao.enabled = true;
                    if (s.bloom) s.bloom.enabled = true;
                    applyWorldEnvState({ persist: false, switchSky: false });
                } catch (e) {}
            },
        });
        getBuiltinLevelDefinition = lv.getBuiltinLevelDefinition;
        updateDoomEnemySpriteAnimation = lv.updateDoomEnemySpriteAnimation;
        applyDoomEnemySpriteSkin = lv.applyDoomEnemySpriteSkin;
        makeDoomShotgunSpriteTexture = lv.makeDoomShotgunSpriteTexture;
    }

    setupVehicleEngineAudio({
        scene, camera,
        vehicleState, vehicleEngineAudio, runtimeAudio, runtimeHud, vehicleFx,
        engineAudioDebugEl,
        VEHICLE_SETTINGS, TEST_SOUND_ID,
        getRuntimeHud, isDrivingVehicle, getActiveVehicleProp,
        gameplay, objectScriptState, playTestSoundStatus,
        getDynamicPropById, getActorRenderObject, getActorBody,
    });

    setupObjectMaterial({
        getRenderComponent,
    });

    setupMouseActions({
        mouseActionState, MouseActionFunction, MOUSE_ACTION_STORAGE_KEY,
        DEFAULT_MOUSE_ACTION_SCRIPTS, objectScriptState,
        scene, camera, renderer, currentMesh, gameplay, showcase, physics,
        sceneSystem, runtimeAudio, getRuntimeHud,
        playSoundAtLocation, raycastWorld, spawnDynamicPrimitive, spawnImportedProp,
        spawnDrivableCar, destroyDynamicPhysicsProp,
        enterGameplay, exitGameplay, respawnPlayer,
        syncCameraToCharacter, applyGameplayCameraRotation,
        readObjectScriptDrafts,
    });

    setupObjectEvents({
        ObjectEventFunction,
        objectScriptState, mobileState, gameplay, showcase, physics, runtimeAudio,
        importedPropState, sceneSystem,
        objectScriptMenu, objectScriptEditor, objectScriptEditorTitle,
        objectScriptEditorTarget, objectScriptEditorMode, objectScriptEditorInput,
        objectScriptEditorStatus, objectScriptEditorApplyBtn,
        objectScriptEditorClearBtn, objectScriptEditorCancelBtn,
        objectScriptTickToggleRow, objectScriptTickToggleInput,
        container,
        scene, camera, renderer, currentMesh, transformControl,
        raycaster, pointerNdc, tempVectorA,
        ensureActorIdentity, ensureObjectScriptDraftEntry, createObjectScriptState,
        saveObjectScriptDrafts, ensureActorScriptState, getActorScriptState,
        getActorMetadata, getActorRenderObject, getActorBody, getActorSelectionObject,
        selectShowcaseActor, syncTransformControlState, rebuildActorPhysics,
        markActorMaterialDirty, refreshSceneUI, isObjectWithinRoot,
        disposeRenderableObject, destroyDynamicPhysicsProp, clearDynamicPhysicsProps,
        runMouseAction, isEditableElement, hasEnabledDynamicPropEvent,
        playSoundAtLocation, syncRuntimePropIdCounter,
        spawnDynamicPrimitive, spawnImportedProp, spawnDrivableCar,
        raycastWorld, enterGameplay, exitGameplay, respawnPlayer,
        syncCameraToCharacter, applyGameplayCameraRotation,
        getRuntimeHud, TEST_SOUND_ID,
    });

    setupDebugConsole({
        debugConsole, debugConsoleOutput, debugConsoleInput, debugConsoleFooter,
        debugStatsOverlay,
        debugConsoleState, mobileState, shadowDebugState, raycastDebugState, collisionDebugState,
        gameplay, physics,
        DEBUG_CONSOLE_LOG_LIMIT, DEBUG_CONSOLE_HISTORY_LIMIT,
        DEBUG_TIMING_SAMPLE_LIMIT,
        closeObjectScriptMenu, closeObjectScriptEditor, resetMovementInputState,
        renderer, setRayDebugEnabled, forceAllSceneMeshShadows,
        setCollisionDebugEnabled, setForceAllSceneMeshShadowsEnabled, updateMobileButtons,
        resetMobileInputState, updateWorldPresentation, updateGameplayUI,
        isEditableElement,
        getDDGIManager,
    });

    setupMobileControls({
        mobileState, gameplay, showcase, vehicleState, physics,
        MOBILE_MOVE_THRESHOLD, MOBILE_MOVE_RADIUS_FACTOR, MOBILE_LOOK_SENSITIVITY,
        PLAYER_SETTINGS,
        isDrivingVehicle, setCameraMode, runMouseAction, exitVehicle, enterVehicle,
        applyGameplayCameraRotation, applyShowcaseCameraRotation,
        getActiveVehicleProp,
        handleMobileExitPlay,
    });
    setupMobileStartScreen({
        mobileState, gameplay, physics, worldEnvState, WORLD_ENV_DEFAULTS,
        setCameraMode, setMobileMenuOpen, loadSample, setPerfModeEnabled,
        applyWorldEnvState, resetMobileInputState,
        requestGameplayPointerLock: () => renderer?.domElement?.requestPointerLock?.(),
    });

    setupSceneSerialization({
        scene, camera, sceneSystem, physics, importedPropState, objectScriptState,
        VEHICLE_SETTINGS,
        getActorBody, getActorRenderObject, getActorScriptState,
        serializeObjectMaterialState, serializeObjectMaterialOverrides,
        applyObjectMaterialState, applyObjectMaterialOverrides,
        serializeImportedPropTemplate, registerImportedPropTemplateFromSerializedData,
        spawnDrivableCar, spawnImportedProp, spawnDDGIVolumeActor, spawnDynamicPrimitive, spawnLightActor,
        syncRuntimePropIdCounter, rebuildActorPhysics, syncPropScriptState,
        destroyDynamicPhysicsProp, getDynamicPropDisplayName, saveObjectScriptDrafts,
        refreshSceneUI, selectShowcaseActor, ensureVehicleVisualState,
        serializeComponentTree, deserializeComponentTree, reattachRestoredActor, editorHistory,
        loadWorldFromJSON,
    });

    setupBlueprintEditor({
        scene, camera, transformControl,
        blueprintState, objectScriptState, sceneSystem,
        getDynamicPropById, getActorRenderObject, rebuildActorPhysics,
        refreshSceneUI, selectShowcaseActor, openObjectScriptEditor,
        applyShowcaseCameraRotation, buildPrimitiveActorMesh,
        clampMaterialStateValue, getObjectMaterialPreviewState,
        getObjectMaterialArray, applyObjectMaterialState, editorHistory,
        showcase, tempVectorA,
    });

    setupSceneHistory({
        sceneSystem, scene, transformControl, gameplay, blueprintState,
        objectScriptState, importedPropState, physics,
        getDynamicPropById, getActorRenderObject, getActorBody,
        destroyDynamicPhysicsProp,
        serializeImportedPropTemplate, registerImportedPropTemplateFromSerializedData,
        saveObjectScriptDrafts, refreshSceneUI, selectShowcaseActor,
        buildPrimitiveActorMesh, applyObjectMaterialState, serializeObjectMaterialState,
        enterBlueprintEditor, exitBlueprintEditor, refreshBlueprintComponents,
        serializeWorldTerrainState, applyWorldTerrainState, refreshGameplayWorld,
        forceExitGameplayForWorldLoad, updateGameplayUI, updateWorldPresentation,
    });

    registerGameplaySystems(gameplaySystems, {
        updateShooterSpawners,
        updateStraightGuns,
        updateShooterAis,
        updateGameplayEffects,
        updatePlayerHitFeedback,
        getProjectileInstancer,
        snapshotGameplaySubject,
        updateGameplayTeleporters,
        sceneSystem,
        updateSoccerGoalies,
    });
}
