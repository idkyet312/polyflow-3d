import * as THREE from 'three';
import { WebGPURenderer, PostProcessing } from 'three/webgpu';
import { pass, mrt, output, emissive, uniform } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import gsap from 'gsap';
import {
    WidgetManager,
    BaseWidget,
    TextWidget,
    ImageWidget,
    ProgressBarWidget,
    ButtonWidget,
} from './src/ui/widgets.js';
import {
    sampleTestTone,
    writeWaveAscii,
    createTestSoundBuffer,
    createMediaTestSoundUrl,
    createEngineNoiseBuffer,
    createCombustionPulseBuffer,
    createCombustionDistortionCurve,
} from './src/audio/synthesis.js';
import { createDrivableCarVisual } from './src/vehicle/visual.js';
import { createVehicleFx } from './src/vehicle/fx.js';
import {
    setupVehicleController,
    isDrivingVehicle, getActiveVehicleProp, clearActiveVehicle,
    getVehicleForward, positionVehicleCamera, getNearbyVehicle,
    enterVehicle, exitVehicle,
    ensureVehicleVisualState, updateVehicleVisuals, updateVehicleGameplay,
} from './src/vehicle/vehicleController.js';
import {
    installSceneUi,
    formatPostProcessValue, clampPostProcessInput, readPostProcessInputValue,
    updatePostProcessSliderLabels, updatePostProcessToggleUi, updatePostProcessStatusUi,
    loadPostProcessInputsFromState, syncPostProcessVolumeUi, applyPostProcessSettingsFromUi,
    syncActorEditorTemplateOptions, handleVehicleTemplateSelectChange, syncActorEditorUi,
    closeActorEditor, openActorEditor, spawnActorFromEditor,
    loadWorldEnvFromStorage, saveWorldEnvToStorage, applyWorldEnvState,
    updateWorldEnvUi, setWorldEnvMaster, resetWorldEnvDefaults,
    refreshSceneUI, createSceneActorItem,
} from './src/editor/sceneUi.js';
import {
    installImportedProps,
    enableOptimizationPipeline, updateLoadedAssetStats, updatePropImportStatus,
    closePropCollisionPrompt, resolvePropCollisionPrompt, promptImportedPropCollision,
    createImportedSimpleShape, createExactMeshShape, createImportedConvexHullShape,
    collectImportedComplexHullParts, createImportedComplexShape, createImportedCollisionShape,
    renderImportedPropButtons, registerImportedPropTemplate,
    registerImportedPropTemplateFromSerializedData,
    lookupBundleAsset, serializeImportedPropTemplate,
    spawnImportedProp, importPhysicsProp,
} from './src/world/importedProps.js';
import {
    installSceneExport,
    runOptimizationPipeline, simplifyMesh, downloadAsset,
    exportWorldToUmap, exportWorldToSceneFolder, exportRootToGlb,
    writeFileToDirectory, downloadSceneFolderFallback,
} from './src/optim/sceneExport.js';
import {
    installScriptState,
    createDefaultObjectEventState, createObjectScriptState, sanitizeObjectScriptDrafts,
    readObjectScriptDrafts, saveObjectScriptDrafts, ensureObjectScriptDraftEntry,
    syncRuntimePropIdCounter, createRuntimePropId,
    getActorScriptState, getActorMetadata, ensureActorIdentity, ensureActorScriptState,
    resetAllScriptLifecycleHandles, registerCollisionForProp,
    updateDynamicBodyCollisionScripts,
    handleObjectScriptGlobalPointerDown, handleObjectScriptKeydown,
} from './src/scripting/scriptState.js';
import {
    installSceneDebug,
    ensureRaycastDebugLine, updateRaycastDebugLine, updateRaycasterDebugLine,
    tickRaycastDebugLine,
    createCollisionLineSegments, createCollisionOverlayFromObject,
    createImportedSimpleCollisionOverlay, buildActorCollisionOverlay,
    disposeCollisionOverlayObject, clearCollisionDebugOverlays, refreshCollisionDebugOverlays,
    setCollisionDebugEnabled,
    raycastWorld, describeRaycastHit, logGameplayDebugRayHit, updateGameplayDebugRay,
    setRayDebugEnabled,
    formatShadowDebugStatus, updateShadowDebugUi, isShadowForceExcludedObject,
    forceAllSceneMeshShadows, setForceAllSceneMeshShadowsEnabled,
    tickForceAllSceneMeshShadows,
    updatePerfModeUi, setPerfModeEnabled,
} from './src/debug/sceneDebug.js';
import {
    installDropHandlers,
    readDirectoryFiles, setupDropHandlers, loadModel, onWindowResize,
    stopScanEffect, startScanEffect, clearCurrentMesh, normalizeCurrentMesh,
} from './src/io/dropHandlers.js';
import {
    installAnimatedSample,
    makeAnimatedSampleQuatTrack, makeAnimatedSamplePart,
    createAnimatedSampleModel, loadSample, createExampleWidgets,
} from './src/world/animatedSample.js';
import {
    installTerrainPanel,
    ensureTerrainBrushHelper, getTerrainHitFromEvent,
    updateTerrainBrushPreview, applyTerrainBrushFromEvent,
    serializeWorldTerrainState, applyWorldTerrainState, setupTerrainPanel,
} from './src/editor/terrainPanel.js';
import {
    installActorPhysics,
    buildCollisionBoxComponent, getActorPhysicsSettings, clearActorPhysicsPreview,
    refreshActorPhysicsPreview, setActorPhysicsPreview, applyActorPhysicsSettings,
    syncBlueprintPhysicsEditor, applyBlueprintPhysicsEditor, rebuildActorPhysics,
    syncTransformControlState, syncTransformToPhysics,
} from './src/physics/actorPhysics.js';
import {
    setupGameplayLoop,
    resetMobileInputState, resetMovementInputState,
    refreshGameplayWorld,
    setupGameplayEvents, adjustShowcaseSpeed, updateShowcaseInput,
    handleGameplayKeyEvent, handleGameplayMouseMove, handleShowcaseMouseButton,
    handleShowcaseContextMenu, handleShowcaseWheel, handlePointerLockChange,
    enterGameplay, exitGameplay, forceExitGameplayForWorldLoad, updateWorldPresentation,
    updateMainDirectionalLightShadowFocus, updateGameplayUI,
    getShowcaseTarget, resetShowcaseCamera, updateShowcaseCamera, respawnPlayer,
    applyGameplayCameraRotation, resolveHorizontalMovement, updateGameplay,
    syncGameplaySpawnToCamera, syncShowcaseAnglesFromTarget, syncShowcaseAnglesToFaceTarget,
    applyShowcaseCameraRotation,
} from './src/gameplay/gameplayLoop.js';
import {
    cloneDisposableObject,
    formatImportedPropName,
    normalizeObjectToDimension,
    createLoadingManager,
    convertLoadedObjectMaterials,
    loadObjectFromFile,
} from './src/io/objectLoader.js';
import { createSocketMultiplayer } from './src/network/socketMultiplayer.js';
import { runWebGPUBenchmark } from './webgpu_utils.js';
import { createPhysicsCore } from './src/physics/core.js';
import { createPhysicsRuntime } from './src/physics/runtime.js';
import { createEnvironmentController } from './src/world/environment.js';
import { createLightGridController } from './src/world/lightGrid.js';
import { createVolumetricFog } from './src/world/volumetricFog.js';
import { createPostProcessVolumeManager } from './src/world/postProcessVolume.js';
import { getDDGIManager } from './src/world/gi/ddgiManager.js';
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
} from './src/runtime/sceneRuntime.js';
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
} from './src/world/terrain.js';
import { createGrassField } from './src/world/grass.js';
import { createWater } from './src/world/water.js';
import { createLitePhysicsPool } from './src/physics/litePool.js';
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
} from './src/scripting/ueApi.js';
import {
    SoundGeneratorAudioListener,
    EngineSoundGenerator as WasmEngineSoundGenerator,
} from './vendor/engine-sound/sound_generator_worklet_wasm.js';

// === Extracted modules (root main.js was 436 KB; split to keep <256 KB) ===
import {
    bindAppCore,
} from './src/runtime/appCore.js';
import {
    compressTextures,
} from './src/optim/textureCompression.js';
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
} from './src/audio/vehicleEngineAudio.js';
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
} from './src/world/objectMaterial.js';
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
} from './src/scripting/mouseActions.js';
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
    getActorByBodyId,
} from './src/scripting/objectEvents.js';
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
} from './src/debug/console.js';
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
} from './src/ui/mobileControls.js';
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
} from './src/world/sceneSerialization.js';
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
} from './src/editor/blueprintEditor.js';
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
} from './src/editor/sceneHistory.js';


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
// --- Configuration ---
let scene, camera, renderer, currentMesh, transformControl, postProcessing, mainDirectionalLight;
let originalTriCount = 0;
let optimizedTriCount = 0;
let scanPlane;
let originalFileSize = 0;
let optimizedBlobUrl = null;
let environmentController, volumetricFogController, postProcessVolumeManager;
const globalPostProcessUniforms = {
    bloomStrength: uniform(1.25),
    bloomRadius: uniform(0.95),
    bloomThreshold: uniform(0.48)
};

// Performance toggle: when on, skips DDGI tick, volumetric fog update, and the
// post-process volume update. The three subsystems own their own state via
// setEnabled, so flipping this back to false restores the default render path
// without a reload. Defaults to off — engine ships unchanged.
let perfModeEnabled = false;
let perfModeUiRefs = null;

// World Environment panel state — Godot-style WorldEnvironment node mirror.
// Each section can be toggled on/off independently, and key values are tunable
// via sliders. State persists to localStorage so reloads keep the last config.
// Defaults match the engine's out-of-box look — DDGI off (heavy), everything
// else on. Changing the master "All Off" or "Performance" preset rewrites the
// `enabled` fields but preserves slider values.
const WORLD_ENV_STORAGE_KEY = 'polyflow.worldEnvironment.v1';
const WORLD_ENV_DEFAULTS = Object.freeze({
    sky: { enabled: true, preset: 'sunny-sky', blurriness: 0.05 },
    ambient: { enabled: true, intensity: 1.0 },
    hemi: { enabled: true, intensity: 1.5 },
    sun: { enabled: true, castShadow: true, intensity: 2.5 },
    tonemap: { exposure: 1.0 },
    bloom: { enabled: true, strength: 1.25, radius: 0.95, threshold: 0.48 },
    fog: { enabled: true, density: 0.012, opacity: 0.055 },
    ddgi: { enabled: false, probesPerFrame: 4, intensity: 0.18 },
    shadows: { enabled: true },
});
let worldEnvState = JSON.parse(JSON.stringify(WORLD_ENV_DEFAULTS));
let worldEnvUiRefs = null;
let physicsCore;
let physicsRuntime;
let multiplayerController;
let sceneSystem;
const animationMixers = new Map();
const actorCoreSyncState = new Map();
const EXPORT_MAX_TEXTURE_SIZE = 1024;
const MODEL_TARGET_MAX_DIMENSION = 12;
const PROP_TARGET_MAX_DIMENSION = 2.35;
const VEHICLE_CUSTOM_IMPORT_VALUE = '__custom_import__';
const IMPORTED_PROP_MAX_HULL_POINTS = 480;
const IMPORTED_PROP_MAX_HULL_PARTS = 18;
const IMPORTED_PROP_COMPLEX_HULL_RADIUS = 0.01;
const SHOWCASE_CAMERA_POSITION = new THREE.Vector3(6.5, 4.2, 8.5);
const SHOWCASE_CAMERA_TARGET = new THREE.Vector3(0, 1.4, 0);
const JOLT_NON_MOVING_LAYER = 0;
const JOLT_MOVING_LAYER = 1;
const JOLT_OBJECT_LAYER_COUNT = 2;
const JOLT_BROAD_PHASE_LAYER_COUNT = 2;
const PLAYER_SETTINGS = {
    eyeHeight: 1.7,
    walkSpeed: 4.5,
    sprintSpeed: 7.2,
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
    cameraHorizontalSmoothing: 8.0,
    cameraVerticalSmoothing: 2.2,
    cameraLookSmoothing: 5.0,
    acceleration: 3.0,
    reverseAcceleration: 2.0,
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
    maxReverseSpeed: 8,
    brakeDamping: 0.85,
    maxAngularVelocity: 3.0,
};
const PHYSICS_COLLISION_STEPS = 2;
const TEST_SOUND_ID = 'polyflow:test';

// Module-level refs so switchEnvironment can update them
let pedestalMat, ambientLight, hemiLight, pedestal, worldFloor;
let grassField = null;
let water = null;
const litePools = [];
let playHint, gameplayStatus, resetViewBtn, showcaseModeBtn, playModeBtn, browseModelBtn, openActorEditorBtn;
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
const MOUSE_ACTION_STORAGE_KEY = 'polyflow-3d.mouse-actions.v1';
const OBJECT_SCRIPT_STORAGE_KEY = 'polyflow-3d.object-scripts.v1';
const DEBUG_CONSOLE_LOG_LIMIT = 18;
const DEBUG_CONSOLE_HISTORY_LIMIT = 24;
const DEBUG_TIMING_SAMPLE_LIMIT = 30;
const DEFAULT_MOUSE_ACTION_SCRIPTS = {
    left: `const direction = Character?.GetActorForwardVector?.()?.GetSafeNormal?.() ?? FVector.Forward();
const playerLocation = Character?.GetActorLocation?.() ?? FVector.Zero();
const spawnLocation = playerLocation
    .Add(direction.Scale(1.8))
    .Add(new FVector(0, 1.35, 0));

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
        render: 0,
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
        render: [],
    },
    gpuTimingMode: 'approximate',
};
const multiplayerState = {
    defaultRoom: 'sandbox',
};

const clock = new THREE.Clock();
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
const mainDirectionalLightOffset = new THREE.Vector3(5, 10, 5);
const mainDirectionalLightShadowFocus = new THREE.Vector3();
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
    spawnYaw: 0,
    spawnPitch: -0.1,
    velocity: new THREE.Vector3(),
    spawnPoint: new THREE.Vector3(0, PLAYER_SETTINGS.eyeHeight + 0.2, 6),
    input: {
        forward: false,
        back: false,
        left: false,
        right: false,
        sprint: false,
    },
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
    },
    onCollisionScriptsUpdate: () => updateDynamicBodyCollisionScripts(),
    onCollisionStepsChange: (collisionSteps) => {
        debugConsoleState.latest.collisionSteps = collisionSteps;
    },
});

function switchEnvironment(key) {
    environmentController?.switchEnvironment(key);
}

function setResolution(res) {
    environmentController?.setResolution(res);
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

function getLocalMultiplayerSnapshot() {
    if (!camera) return null;

    let localPosition;
    let yaw;

    if (gameplay.active && physics.character) {
        localPosition = copyJoltVector(tempVectorA, physics.character.GetPosition()).clone();
        yaw = gameplay.yaw;
    } else {
        localPosition = tempVectorA.copy(camera.position).clone();
        localPosition.y -= 1.05;
        yaw = showcase.yaw;
    }

    const localRotation = tempQuaternionB.setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ')).clone();
    let vehicleStateSnapshot = { active: false };

    if (gameplay.active && isDrivingVehicle()) {
        const vehicle = getActiveVehicleProp();
        if (vehicle?.body && physics.bodyInterface) {
            const bodyId = vehicle.body.GetID();
            const vehiclePosition = copyJoltVector(tempVectorA, physics.bodyInterface.GetPosition(bodyId)).clone();
            const vehicleRotation = copyJoltQuaternion(tempQuaternionA, physics.bodyInterface.GetRotation(bodyId)).clone();
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
        position: serializeVector3(localPosition),
        quaternion: serializeQuaternion(localRotation),
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

function getObjectAnimationClips(root) {
    if (!root) return [];

    const clips = [];
    const seen = new Set();
    const addClip = (clip) => {
        if (!clip || seen.has(clip.uuid || clip.name)) return;
        seen.add(clip.uuid || clip.name);
        clips.push(clip);
    };

    root.animations?.forEach(addClip);
    root.traverse?.((child) => child.animations?.forEach(addClip));
    return clips;
}

function stopObjectAnimations(root) {
    const entry = animationMixers.get(root);
    if (!entry) return;

    entry.mixer.stopAllAction();
    entry.mixer.uncacheRoot(root);
    animationMixers.delete(root);
}

function playObjectAnimation(root, clipName = '') {
    const clips = getObjectAnimationClips(root);
    if (!clips.length) return null;

    stopObjectAnimations(root);

    const clip = clipName
        ? THREE.AnimationClip.findByName(clips, clipName) || clips[0]
        : clips[0];
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.enabled = true;
    action.play();

    root.userData.animation = {
        ...(root.userData.animation || {}),
        activeClip: clip.name || '',
        clipNames: clips.map((entry) => entry.name || 'Animation'),
        playing: true,
    };
    animationMixers.set(root, { mixer, action, clips });
    return action;
}

function updateObjectAnimations(delta) {
    animationMixers.forEach((entry) => entry.mixer.update(delta));
}

function disposeRenderableObject(root) {
    if (!root) return;

    stopObjectAnimations(root);

    root.traverse((child) => {
        if (!child.isMesh) return;

        child.geometry?.dispose();

        if (Array.isArray(child.material)) {
            child.material.forEach((material) => material?.dispose());
        } else {
            child.material?.dispose();
        }
    });
}


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

    if (prop.id && vehicleEngineAudio.activePropId === prop.id) {
        shutdownVehicleEngineAudio();
    }

    if (vehicleState.activePropId && vehicleState.activePropId === prop.id) {
        vehicleState.activePropId = '';
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

function spawnDrivableCar(options = {}) {
    if (!physics.ready || !scene || !camera) {
        console.warn('Jolt physics is not ready yet.');
        return null;
    }

    const { Jolt, bodyInterface } = physics;
    const spawnPosition = tempVectorD;
    const launchImpulse = tempVectorE;
    getDynamicPropSpawn(spawnPosition, launchImpulse);

    const groundHit = getGroundHitAt(spawnPosition.x, spawnPosition.z, true, { cullBackFaces: true });
    if (groundHit?.point) {
        spawnPosition.y = groundHit.point.y + VEHICLE_SETTINGS.height * 0.1 + VEHICLE_SETTINGS.spawnLift;
    }

    camera.getWorldDirection(tempVectorA);
    tempVectorA.y = 0;
    if (tempVectorA.lengthSq() < 1e-6) {
        tempVectorA.set(0, 0, -1);
    } else {
        tempVectorA.normalize();
    }

    const carRotation = tempQuaternionA.setFromUnitVectors(upVector.clone().set(0, 0, -1), tempVectorA);
    const halfExtent = new Jolt.Vec3(
        VEHICLE_SETTINGS.width * 0.5,
        VEHICLE_SETTINGS.height * 0.5,
        VEHICLE_SETTINGS.length * 0.5
    );
    const shape = createOwnedShape(new Jolt.BoxShapeSettings(halfExtent, 0.05));
    Jolt.destroy(halfExtent);

    const body = createDynamicPrimitiveBody(shape, spawnPosition, launchImpulse, {
        rotation: carRotation,
        friction: 0.8,
        restitution: 0.05,
        linearDamping: 0.12,
        angularDamping: 0.3,
        motionQuality: Jolt.EMotionQuality_LinearCast,
        skipImpulse: true,
        enhancedInternalEdgeRemoval: true,
    });

    if (!body) {
        return null;
    }

    bodyInterface.SetMaxAngularVelocity(body.GetID(), VEHICLE_SETTINGS.maxAngularVelocity);
    const bodyTemplateId = options.bodyTemplateId || '';
    const wheelTemplateId = options.wheelTemplateId || '';
    const chassis = createDrivableCarVisual({
        bodyTemplateId,
        wheelTemplateId,
        vehicleSettings: VEHICLE_SETTINGS,
        importedPropState,
        cloneDisposableObject,
    });
    chassis.position.copy(spawnPosition);
    chassis.quaternion.copy(carRotation);

    const vehicle = createDynamicPropActor({
        body,
        mesh: chassis,
        kind: 'vehicle',
        userData: options.userData ?? { label: 'Car' },
        includeScripts: options.includeScripts !== false,
    });
    vehicle.vehicleBodyTemplateId = bodyTemplateId || null;
    vehicle.vehicleWheelTemplateId = wheelTemplateId || null;
    setActorComponentFlags(vehicle, {
        collision: true,
        physics: true,
        scripts: options.includeScripts !== false,
    });
    physics.dynamicBodies.push(vehicle);
    physicsCore?.registerBackFaceCulledBody?.(body);
    updateGameplayUI();
    return vehicle;
}

function createDynamicPrimitiveBody(shape, position, impulse, options = {}) {
    if (!physics.ready) return null;

    const { Jolt, bodyInterface } = physics;
    const simulatePhysics = options.simulatePhysics !== false;
    const bodyPosition = new Jolt.RVec3(position.x, position.y, position.z);
    const rotation = options.rotation;
    const bodyRotation = new Jolt.Quat(
        rotation?.x ?? 0,
        rotation?.y ?? 0,
        rotation?.z ?? 0,
        rotation?.w ?? 1
    );
    const creationSettings = new Jolt.BodyCreationSettings(
        shape,
        bodyPosition,
        bodyRotation,
        simulatePhysics ? Jolt.EMotionType_Dynamic : Jolt.EMotionType_Static,
        simulatePhysics ? JOLT_MOVING_LAYER : JOLT_NON_MOVING_LAYER
    );
    creationSettings.mFriction = options.friction ?? 0.68;
    creationSettings.mRestitution = options.restitution ?? 0.16;
    creationSettings.mAllowSleeping = options.allowSleeping ?? true;
    creationSettings.mLinearDamping = options.linearDamping ?? 0.08;
    creationSettings.mAngularDamping = options.angularDamping ?? 0.1;
    creationSettings.mMotionQuality = options.motionQuality
        ?? Jolt.EMotionQuality_Discrete;

    if (options.allowedDOFs !== undefined) {
        creationSettings.mAllowedDOFs = options.allowedDOFs;
    }

    // Enhanced internal edge removal eliminates ghost collisions where a body
    // crosses a seam between coplanar triangles in a static MeshShape and the
    // contact normal flips into the edge — the symptom is a vehicle hitting an
    // invisible wall and flipping at track segment joints.
    if (options.enhancedInternalEdgeRemoval === true) {
        creationSettings.mEnhancedInternalEdgeRemoval = true;
    }

    const body = bodyInterface.CreateBody(creationSettings);
    const mass = Number(options.mass);
    if (simulatePhysics && Number.isFinite(mass) && mass > 0) {
        body.GetMotionProperties?.()?.ScaleToMass?.(mass);
    }
    bodyInterface.AddBody(
        body.GetID(),
        !simulatePhysics || options.activate === false ? Jolt.EActivation_DontActivate : Jolt.EActivation_Activate
    );

    if (simulatePhysics && impulse && options.skipImpulse !== true) {
        const launchImpulse = new Jolt.Vec3(impulse.x, impulse.y, impulse.z);
        bodyInterface.AddImpulse(body.GetID(), launchImpulse);
        Jolt.destroy(launchImpulse);
    }

    shape.Release();
    Jolt.destroy(creationSettings);
    Jolt.destroy(bodyPosition);
    Jolt.destroy(bodyRotation);

    return body;
}

function spawnDynamicPrimitive(kind, offset, scale, options = {}) {
    if (!physics.ready || !scene || !camera) {
        console.warn('Jolt physics is not ready yet.');
        return;
    }

    const defaultScale = kind === 'sphere' ? 0.5 : 0.3;
    const normalizedScale = Number.isFinite(scale) && scale > 0 ? scale : defaultScale;

    const { Jolt } = physics;
    const spawnPosition = tempVectorD;
    const launchImpulse = tempVectorE;
    getDynamicPropSpawn(spawnPosition, launchImpulse);
    const impulseScale = Number.isFinite(options.impulseScale) ? options.impulseScale : 1;
    const includeCollisionBody = options.includeCollisionBody !== false;
    const simulatePhysics = includeCollisionBody && options.simulatePhysics !== false;
    const useLocalPosition = options.local !== false;

    if (offset) {
        if (useLocalPosition) {
            spawnPosition.add(tempVectorA.copy(offset).applyQuaternion(camera.quaternion));
        } else {
            spawnPosition.copy(offset);
        }
    }

    if (options.skipImpulse === true) {
        launchImpulse.set(0, 0, 0);
    } else if (impulseScale !== 1) {
        launchImpulse.multiplyScalar(impulseScale);
    }

    let mesh;
    let shape;
    let bodyOptions;

    if (kind === 'sphere') {
        const radius = normalizedScale;
        shape = includeCollisionBody ? createOwnedShape(new Jolt.SphereShapeSettings(radius)) : null;
        mesh = buildPrimitiveActorMesh('sphere');
        mesh.scale.set(radius, radius, radius);
        bodyOptions = {
            restitution: 0.48,
            friction: 0.58,
            ...options,
        };
    } else if (kind === 'cube') {
        const halfExtent = normalizedScale;
        if (includeCollisionBody) {
            const halfExtentVector = new Jolt.Vec3(halfExtent, halfExtent, halfExtent);
            shape = createOwnedShape(new Jolt.BoxShapeSettings(halfExtentVector, 0.05));
            Jolt.destroy(halfExtentVector);
        }
        mesh = buildPrimitiveActorMesh('cube');
        mesh.scale.set(halfExtent, halfExtent, halfExtent);
        bodyOptions = {
            restitution: 0.12,
            friction: 0.82,
            ...options,
        };
    } else if (kind === 'capsule') {
        const halfExtent = normalizedScale;
        if (includeCollisionBody) {
            shape = createOwnedShape(new Jolt.CapsuleShapeSettings(halfExtent, halfExtent));
        }
        mesh = buildPrimitiveActorMesh('capsule');
        mesh.scale.set(halfExtent, halfExtent, halfExtent);
        bodyOptions = {
            restitution: 0.0,
            friction: 0.0,
            allowedDOFs: Jolt.EAllowedDOFs_TranslationX | Jolt.EAllowedDOFs_TranslationY | Jolt.EAllowedDOFs_TranslationZ,
            ...options,
        };
    }

    const body = includeCollisionBody
        ? createDynamicPrimitiveBody(shape, spawnPosition, launchImpulse, {
            ...bodyOptions,
            simulatePhysics,
        })
        : null;

    if (includeCollisionBody && !body) {
        mesh.geometry.dispose();
        mesh.material.dispose();
        return null;
    }

    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? true;
    mesh.position.copy(spawnPosition);

    const actor = createDynamicPropActor({
        body,
        mesh,
        kind,
        userData: options.userData,
        includeScripts: options.includeScripts !== false,
    });
    setActorComponentFlags(actor, {
        collision: !!body,
        physics: !!body && simulatePhysics,
        scripts: options.includeScripts !== false,
    });
    if (body) {
        if (simulatePhysics) {
            physics.dynamicBodies.push(actor);
        } else {
            physics.staticBodies.push(actor);
        }
    }

    return options.returnActor === true ? actor : body;
}

function syncDynamicPhysicsBodies() {
    physicsRuntime?.syncDynamicPhysicsBodies();
}

function rebuildTerrainPhysicsBody() {
    physicsCore?.rebuildTerrainPhysicsBody();
}

function rebuildModelPhysicsBody() {
    physicsCore?.rebuildModelPhysicsBody();
}

function destroyPlayerCharacter() {
    physicsRuntime?.destroyPlayerCharacter();
}

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

function getActorSelectionObject(prop, preferredObject = null) {
    const root = getActorRenderObject(prop);
    if (!root) return null;

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
}

function buildPrimitiveActorMesh(kind) {
    if (kind === 'sphere') {
        return new THREE.Mesh(
            new THREE.SphereGeometry(1, 28, 20),
            new THREE.MeshStandardMaterial({
                color: 0xf97316,
                metalness: 0.14,
                roughness: 0.34,
                emissive: 0x331100,
                emissiveIntensity: 0.28,
            })
        );
    }
    if (kind === 'cube') {
    return new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshStandardMaterial({
            color: 0x60a5fa,
            metalness: 0.12,
            roughness: 0.38,
            emissive: 0x0b1220,
            emissiveIntensity: 0.2,
        })
    );
}
    if (kind === 'capsule') {
        return new THREE.Mesh(
            new THREE.CapsuleGeometry(1, 2, 8, 16),
            new THREE.MeshStandardMaterial({
                color: 0x16a34a,
                metalness: 0.1,
                roughness: 0.4,
                emissive: 0x052d12,
                emissiveIntensity: 0.22,
            })
        );
    }
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
    mesh.userData.ignoreForcedSceneShadows = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    const actor = createActor({
        mesh,
        kind: 'ddgiVolume',
        userData,
        name: userData?.label || 'ddgi-volume',
    });
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

// === extracted: objectEvents (was lines 4261-4923 of original main.js) ===

/**
 * World-space raycast exposed to scripts and tools (e.g., the Physgun).
 * Wraps physicsCore.castRay and attaches the owning actor for the hit body.
 *
 * @param {{x,y,z}} origin     World-space ray start.
 * @param {{x,y,z}} direction  Unit direction vector.
 * @param {number} [maxDist=1000]
 * @returns {{hit:boolean, point?:{x,y,z}, normal?:{x,y,z}, distance?:number, actor?:object|null, bodyId?:number}}
 */
// Performance toggle: turn DDGI, volumetric fog, and post-process bloom off
// (or on) at runtime without changing engine defaults. Each subsystem owns its
// own enabled flag — we flip those here AND also gate the per-frame update
// calls in the main render loop, so flipping this saves both render work and
// CPU update work.
// ──────────────────────────────────────────────────────────
//  World Environment panel — Godot-style global graphics inspector
// ──────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────
//  Physgun (GMod-style grab/push/pull/fling tool)
// ──────────────────────────────────────────────────────────

const physgunState = {
    equipped: false,
    heldActor: null,
    grabDistance: 5,
    minDistance: 1.5,
    maxDistance: 25,
    // PD controller gains for the grab spring.
    springK: 60,
    damping: 6,
    maxSpeed: 30,
    flingImpulse: 18,
};

function physgunSetEquipped(equipped) {
    physgunState.equipped = !!equipped;
    if (!physgunState.equipped) physgunReleaseHeld();
    const ui = document.getElementById('physgun-crosshair');
    if (ui) ui.classList.toggle('physgun-active', physgunState.equipped);
}

function physgunReleaseHeld() {
    physgunState.heldActor = null;
}

function physgunCameraRay() {
    const origin = new THREE.Vector3();
    camera.getWorldPosition(origin);
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    return { origin, direction: direction.normalize() };
}

function physgunGrabFromCamera() {
    const { origin, direction } = physgunCameraRay();
    const r = raycastWorld(origin, direction, 30);
    if (!r.hit || !r.actor) return false;
    // Only grab dynamic actors (must have a physics body that simulates).
    const body = getActorBody(r.actor);
    if (!body) return false;
    physgunState.heldActor = r.actor;
    physgunState.grabDistance = Math.max(physgunState.minDistance, Math.min(physgunState.maxDistance, r.distance));
    // Wake the body so the spring can move it.
    const phys = r.actor.getComponentByClass(PhysicsComponent);
    phys?.activate?.();
    return true;
}

function physgunFlingHeld() {
    const actor = physgunState.heldActor;
    if (!actor) return false;
    const phys = actor.getComponentByClass(PhysicsComponent);
    if (!phys) { physgunReleaseHeld(); return false; }
    const { direction } = physgunCameraRay();
    const v = new THREE.Vector3(
        direction.x * physgunState.flingImpulse,
        direction.y * physgunState.flingImpulse + 2.5,
        direction.z * physgunState.flingImpulse,
    );
    phys.addImpulse(v);
    physgunReleaseHeld();
    return true;
}

function physgunPunt() {
    const { origin, direction } = physgunCameraRay();
    const r = raycastWorld(origin, direction, 50);
    if (!r.hit || !r.actor) return false;
    const phys = r.actor.getComponentByClass(PhysicsComponent);
    if (!phys) return false;
    phys.activate?.();
    phys.addImpulse(new THREE.Vector3(
        direction.x * physgunState.flingImpulse * 1.6,
        direction.y * physgunState.flingImpulse * 1.6 + 1.5,
        direction.z * physgunState.flingImpulse * 1.6,
    ));
    return true;
}

function physgunAdjustDistance(delta) {
    physgunState.grabDistance = Math.max(
        physgunState.minDistance,
        Math.min(physgunState.maxDistance, physgunState.grabDistance + delta),
    );
}

function tickPhysgun(delta) {
    if (!physgunState.equipped || !physgunState.heldActor || !gameplay.active) return;
    const actor = physgunState.heldActor;
    const phys = actor.getComponentByClass(PhysicsComponent);
    const mesh = getActorRenderObject(actor);
    if (!phys || !mesh || !phys.isReady()) {
        physgunReleaseHeld();
        return;
    }

    const { origin, direction } = physgunCameraRay();
    const target = origin.clone().addScaledVector(direction, physgunState.grabDistance);

    const pos = mesh.getWorldPosition(new THREE.Vector3());
    const vel = phys.getLinearVelocity();
    // PD controller: a = K*(target - pos) - D*vel
    const ax = physgunState.springK * (target.x - pos.x) - physgunState.damping * vel.x;
    const ay = physgunState.springK * (target.y - pos.y) - physgunState.damping * vel.y;
    const az = physgunState.springK * (target.z - pos.z) - physgunState.damping * vel.z;

    // Integrate to a velocity directly (treat the spring as a velocity drive),
    // clamped so we don't fling the body across the world.
    let vx = vel.x + ax * delta;
    let vy = vel.y + ay * delta;
    let vz = vel.z + az * delta;
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (speed > physgunState.maxSpeed) {
        const k = physgunState.maxSpeed / speed;
        vx *= k; vy *= k; vz *= k;
    }
    phys.setLinearVelocity(new THREE.Vector3(vx, vy, vz));
    // Tame angular velocity so held objects don't spin chaotically.
    const av = phys.getAngularVelocity();
    phys.setAngularVelocity(new THREE.Vector3(av.x * 0.85, av.y * 0.85, av.z * 0.85));
}

/**
 * Reset BeginPlay bookkeeping on every actor's lifecycle scripts so that
 * BeginPlay re-fires on each Edit→Play transition. Called from gameplay entry.
 */
// === extracted: mouseActions (was lines 5698-5923 of original main.js) ===
const container = document.getElementById('canvas-container');
const processingOverlay = document.getElementById('processing-overlay');
const loaderBar = document.getElementById('loader-bar');
const processingStep = document.getElementById('processing-step');
const processTrigger = document.getElementById('process-trigger');
const downloadBtn = document.getElementById('download-asset');

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

function isEditableElement(target) {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

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

function syncActorCoreInstances() {
    if (!sceneSystem?.actors?.size) return;
    const actors = Array.from(sceneSystem.actors);
    const cores = actors.filter((actor) => !actorInheritsCore(actor));
    const liveCoreIds = new Set(cores.map((actor) => actor.id));

    actorCoreSyncState.forEach((_entry, coreId) => {
        if (!liveCoreIds.has(coreId)) actorCoreSyncState.delete(coreId);
    });

    cores.forEach((coreActor) => {
        const linked = actors.filter((actor) => actorInheritsCore(actor) && getActorCoreSource(actor)?.id === coreActor.id);
        if (!linked.length) return;
        const rules = serializeCoreVisualRules(coreActor);
        if (!rules) return;
        const signature = JSON.stringify(rules);
        if (actorCoreSyncState.get(coreActor.id)?.signature === signature) return;
        actorCoreSyncState.set(coreActor.id, { signature });
        linked.forEach((instanceActor) => applyCoreVisualRulesToInstance(instanceActor, rules));
    });
}

function focusSceneActor(actor) {
    const actorMesh = getActorRenderObject(actor);
    if (gameplay.active || !actorMesh) return;

    focusShowcaseCameraOnObject(actorMesh);
}

function getObjectFocusFrame(object) {
    if (!object) return null;

    tempBoxA.makeEmpty();
    tempBoxA.setFromObject(object, true);

    const targetPos = new THREE.Vector3();
    const size = new THREE.Vector3();

    if (tempBoxA.isEmpty()) {
        object.getWorldPosition(targetPos);
        size.setScalar(0.7);
    } else {
        tempBoxA.getCenter(targetPos);
        tempBoxA.getSize(size);
    }

    const radius = Math.max(size.length() * 0.5, 0.35);
    const vFov = THREE.MathUtils.degToRad(camera.fov || 45);
    const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * Math.max(camera.aspect || 1, 0.1));
    const fitFov = Math.max(0.1, Math.min(vFov, hFov));
    const distance = THREE.MathUtils.clamp(
        (radius / Math.sin(fitFov * 0.5)) * 1.65,
        Math.max(2.1, radius * 2.9),
        90
    );

    const viewDir = new THREE.Vector3().subVectors(camera.position, targetPos);
    if (viewDir.lengthSq() < 0.0001) {
        viewDir.set(1, 0.45, 1);
    }
    viewDir.normalize();

    if (viewDir.y < 0.24) {
        viewDir.y = 0.34;
        viewDir.normalize();
    }

    return {
        target: targetPos,
        cameraPosition: targetPos.clone().addScaledVector(viewDir, distance),
    };
}

function focusShowcaseCameraOnObject(object, { duration = 0.6 } = {}) {
    if (gameplay.active || !camera || !object) return;

    const frame = getObjectFocusFrame(object);
    if (!frame) return;

    showcase.velocity.set(0, 0, 0);
    gsap?.killTweensOf(camera.position);

    if (gsap) {
        gsap.to(camera.position, {
            x: frame.cameraPosition.x,
            y: frame.cameraPosition.y,
            z: frame.cameraPosition.z,
            duration,
            overwrite: true,
            ease: 'power2.out',
            onUpdate: () => {
                syncShowcaseAnglesToFaceTarget(frame.target);
                applyShowcaseCameraRotation();
            }
        });
    } else {
        camera.position.copy(frame.cameraPosition);
        syncShowcaseAnglesToFaceTarget(frame.target);
        applyShowcaseCameraRotation();
    }
}

// --- Initialization ---
async function init() {
    // Mobile Detection (full applyMobileModeState runs after wireExtractedModules
    // because it depends on injected refs in src/debug/console.js)
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.matchMedia('(pointer: coarse)').matches;
    mobileState.detected = isMobile;
    mobileState.forced = false;
    mobileState.enabled = isMobile;
    document.body.classList.toggle('is-mobile', isMobile);

    // Add listeners immediately so UI is responsive even if WASM is loading
    document.getElementById('load-sample').addEventListener('click', (e) => {
        e.stopPropagation();
        loadSample();
    });

    browseModelBtn = document.getElementById('open-model-menu');
    sceneUiPanel = document.getElementById('scene-ui-panel');
    sceneUiCount = document.getElementById('scene-ui-count');
    sceneUiList = document.getElementById('scene-ui-list');
    showcaseModeBtn = document.getElementById('camera-showcase');
    playModeBtn = document.getElementById('camera-play');
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
        bloomOff: document.getElementById('we-bloom-off'),
        bloomOn: document.getElementById('we-bloom-on'),
        bloomStrength: document.getElementById('we-bloom-strength'),
        bloomStrengthValue: document.getElementById('we-bloom-strength-value'),
        bloomRadius: document.getElementById('we-bloom-radius'),
        bloomRadiusValue: document.getElementById('we-bloom-radius-value'),
        bloomThreshold: document.getElementById('we-bloom-threshold'),
        bloomThresholdValue: document.getElementById('we-bloom-threshold-value'),
        fogOff: document.getElementById('we-fog-off'),
        fogOn: document.getElementById('we-fog-on'),
        fogDensity: document.getElementById('we-fog-density'),
        fogDensityValue: document.getElementById('we-fog-density-value'),
        fogOpacity: document.getElementById('we-fog-opacity'),
        fogOpacityValue: document.getElementById('we-fog-opacity-value'),
        ddgiOff: document.getElementById('we-ddgi-off'),
        ddgiOn: document.getElementById('we-ddgi-on'),
        ddgiProbes: document.getElementById('we-ddgi-probes'),
        ddgiProbesValue: document.getElementById('we-ddgi-probes-value'),
        ddgiIntensity: document.getElementById('we-ddgi-intensity'),
        ddgiIntensityValue: document.getElementById('we-ddgi-intensity-value'),
        shadowsOff: document.getElementById('we-shadows-off'),
        shadowsOn: document.getElementById('we-shadows-on'),
        resetBtn: document.getElementById('we-reset-defaults'),
    };

    renderDebugConsoleOutput();
    debugConsoleInput?.addEventListener('keydown', handleDebugConsoleInputKeydown);

    postProcessUiRefs?.targetGlobalBtn?.addEventListener('click', () => {
        postProcessUiState.target = 'global';
        syncPostProcessVolumeUi();
    });
    postProcessUiRefs?.targetVolumeBtn?.addEventListener('click', () => {
        postProcessUiState.target = 'volume';
        syncPostProcessVolumeUi();
    });

    [
        postProcessUiRefs?.exposureInput,
        postProcessUiRefs?.bloomStrengthInput,
        postProcessUiRefs?.bloomRadiusInput,
        postProcessUiRefs?.bloomThresholdInput,
        postProcessUiRefs?.blendSpeedInput,
    ].forEach((input) => {
        input?.addEventListener('input', () => {
            updatePostProcessSliderLabels();
            applyPostProcessSettingsFromUi({ reloadInputs: false });
        });
    });

    [
        postProcessUiRefs?.priorityInput,
        postProcessUiRefs?.sizeXInput,
        postProcessUiRefs?.sizeYInput,
        postProcessUiRefs?.sizeZInput,
    ].forEach((input) => {
        input?.addEventListener('change', () => {
            applyPostProcessSettingsFromUi({ reloadInputs: false });
        });
    });

    postProcessUiRefs?.placeVolumeBtn?.addEventListener('click', () => {
        postProcessUiState.target = 'volume';
        applyPostProcessSettingsFromUi({ createVolumeIfNeeded: true, placeVolumeAtCamera: true, reloadInputs: true });
    });
    postProcessUiRefs?.removeVolumeBtn?.addEventListener('click', () => {
        postProcessVolumeManager?.removeEditorVolume?.();
        postProcessVolumeManager?.update?.(1);
        syncPostProcessVolumeUi();
    });
    postProcessUiRefs?.toggleBoundsBtn?.addEventListener('click', () => {
        const snapshot = postProcessVolumeManager?.getSnapshot?.();
        postProcessVolumeManager?.setDebugVisible?.(!snapshot?.debugVisible);
        syncPostProcessVolumeUi({ reloadInputs: false });
    });
    postProcessUiRefs?.applyBtn?.addEventListener('click', () => {
        applyPostProcessSettingsFromUi({ createVolumeIfNeeded: postProcessUiState.target === 'volume', reloadInputs: true });
    });
    shadowDebugUiRefs?.forceOffBtn?.addEventListener('click', () => {
        setForceAllSceneMeshShadowsEnabled(false);
    });
    shadowDebugUiRefs?.forceOnBtn?.addEventListener('click', () => {
        setForceAllSceneMeshShadowsEnabled(true);
    });
    shadowDebugUiRefs?.applyBtn?.addEventListener('click', () => {
        forceAllSceneMeshShadows();
    });
    updateShadowDebugUi();

    perfModeUiRefs?.offBtn?.addEventListener('click', () => {
        setPerfModeEnabled(false);
    });
    perfModeUiRefs?.onBtn?.addEventListener('click', () => {
        setPerfModeEnabled(true);
    });
    updatePerfModeUi();

    // World Environment panel: load saved state, wire all togglers + sliders,
    // then call applyWorldEnvState once so the engine boots into the user's
    // last-saved configuration. Each handler mutates the relevant slice of
    // worldEnvState then re-applies — keeps the UI and runtime in sync without
    // duplicating logic.
    loadWorldEnvFromStorage();

    const wireToggle = (offBtn, onBtn, getStateOff, getStateOn) => {
        offBtn?.addEventListener('click', () => { getStateOff(); applyWorldEnvState(); });
        onBtn?.addEventListener('click', () => { getStateOn(); applyWorldEnvState(); });
    };
    const wireSlider = (input, key, setter, parser = parseFloat) => {
        input?.addEventListener('input', () => {
            const v = parser(input.value);
            if (Number.isFinite(v)) {
                setter(v);
                applyWorldEnvState({ switchSky: false });
            }
        });
    };

    worldEnvUiRefs?.masterOnBtn?.addEventListener('click', () => setWorldEnvMaster('on'));
    worldEnvUiRefs?.masterOffBtn?.addEventListener('click', () => setWorldEnvMaster('off'));
    worldEnvUiRefs?.masterPerfBtn?.addEventListener('click', () => setWorldEnvMaster('perf'));
    worldEnvUiRefs?.resetBtn?.addEventListener('click', () => resetWorldEnvDefaults());

    wireToggle(worldEnvUiRefs?.skyOff, worldEnvUiRefs?.skyOn,
        () => { worldEnvState.sky.enabled = false; },
        () => { worldEnvState.sky.enabled = true; });
    worldEnvUiRefs?.skyPreset?.addEventListener('change', () => {
        worldEnvState.sky.preset = worldEnvUiRefs.skyPreset.value;
        applyWorldEnvState();
    });
    wireSlider(worldEnvUiRefs?.skyBlurriness, 'sky.blurriness', (v) => { worldEnvState.sky.blurriness = v; });

    wireToggle(worldEnvUiRefs?.ambientOff, worldEnvUiRefs?.ambientOn,
        () => { worldEnvState.ambient.enabled = false; },
        () => { worldEnvState.ambient.enabled = true; });
    wireSlider(worldEnvUiRefs?.ambientIntensity, 'ambient.intensity', (v) => { worldEnvState.ambient.intensity = v; });

    wireToggle(worldEnvUiRefs?.hemiOff, worldEnvUiRefs?.hemiOn,
        () => { worldEnvState.hemi.enabled = false; },
        () => { worldEnvState.hemi.enabled = true; });
    wireSlider(worldEnvUiRefs?.hemiIntensity, 'hemi.intensity', (v) => { worldEnvState.hemi.intensity = v; });

    wireToggle(worldEnvUiRefs?.sunOff, worldEnvUiRefs?.sunOn,
        () => { worldEnvState.sun.enabled = false; },
        () => { worldEnvState.sun.enabled = true; });
    worldEnvUiRefs?.sunShadow?.addEventListener('change', () => {
        worldEnvState.sun.castShadow = !!worldEnvUiRefs.sunShadow.checked;
        applyWorldEnvState({ switchSky: false });
    });
    wireSlider(worldEnvUiRefs?.sunIntensity, 'sun.intensity', (v) => { worldEnvState.sun.intensity = v; });

    wireSlider(worldEnvUiRefs?.exposure, 'tonemap.exposure', (v) => { worldEnvState.tonemap.exposure = v; });

    wireToggle(worldEnvUiRefs?.bloomOff, worldEnvUiRefs?.bloomOn,
        () => { worldEnvState.bloom.enabled = false; },
        () => { worldEnvState.bloom.enabled = true; });
    wireSlider(worldEnvUiRefs?.bloomStrength, 'bloom.strength', (v) => { worldEnvState.bloom.strength = v; });
    wireSlider(worldEnvUiRefs?.bloomRadius, 'bloom.radius', (v) => { worldEnvState.bloom.radius = v; });
    wireSlider(worldEnvUiRefs?.bloomThreshold, 'bloom.threshold', (v) => { worldEnvState.bloom.threshold = v; });

    wireToggle(worldEnvUiRefs?.fogOff, worldEnvUiRefs?.fogOn,
        () => { worldEnvState.fog.enabled = false; },
        () => { worldEnvState.fog.enabled = true; });
    wireSlider(worldEnvUiRefs?.fogDensity, 'fog.density', (v) => { worldEnvState.fog.density = v; });
    wireSlider(worldEnvUiRefs?.fogOpacity, 'fog.opacity', (v) => { worldEnvState.fog.opacity = v; });

    wireToggle(worldEnvUiRefs?.ddgiOff, worldEnvUiRefs?.ddgiOn,
        () => { worldEnvState.ddgi.enabled = false; },
        () => { worldEnvState.ddgi.enabled = true; });
    wireSlider(worldEnvUiRefs?.ddgiProbes, 'ddgi.probesPerFrame',
        (v) => { worldEnvState.ddgi.probesPerFrame = Math.round(v); }, (s) => parseInt(s, 10));
    wireSlider(worldEnvUiRefs?.ddgiIntensity, 'ddgi.intensity', (v) => { worldEnvState.ddgi.intensity = v; });

    wireToggle(worldEnvUiRefs?.shadowsOff, worldEnvUiRefs?.shadowsOn,
        () => { worldEnvState.shadows.enabled = false; },
        () => { worldEnvState.shadows.enabled = true; });

    // Apply once now that all controllers + UI are wired. This pushes the
    // (possibly-restored-from-localStorage) state through every subsystem and
    // syncs the panel display. Any controllers not yet ready are no-ops thanks
    // to the optional-chaining inside applyWorldEnvState.
    applyWorldEnvState({ persist: false });

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
    syncShowcaseAnglesFromTarget(SHOWCASE_CAMERA_TARGET);
    applyShowcaseCameraRotation();
    scene.add(camera);
    volumetricFogController = createVolumetricFog({
        scene,
        camera,
    });
    runtimeAudio.listener = new SoundGeneratorAudioListener();
    camera.add(runtimeAudio.listener);

    renderer = new WebGPURenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.localClippingEnabled = true; // Essential for the reflection
    renderer.domElement.tabIndex = 0;
    container.appendChild(renderer.domElement);
    await renderer.init();

    // ── Post-processing: bloom over the scene's emissive output ─────────────
    // Uses an MRT pass so bloom only picks up materials with non-zero emissive
    // (lights, headlights/taillights, accent stripes) instead of every bright
    // pixel — keeps the world from looking hazy.
    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({
        output: output,
        emissive: emissive,
    }));
    const sceneColor = scenePass.getTextureNode('output');
    const sceneEmissive = scenePass.getTextureNode('emissive');
    const bloomNode = bloom(sceneEmissive, globalPostProcessUniforms.bloomStrength, globalPostProcessUniforms.bloomRadius, globalPostProcessUniforms.bloomThreshold);
    postProcessing = new PostProcessing(renderer);
    postProcessing.outputNode = sceneColor.add(bloomNode);

    postProcessVolumeManager = createPostProcessVolumeManager({
        scene,
        camera,
        renderer,
        globalUniforms: globalPostProcessUniforms
    });
    syncPostProcessVolumeUi();

    getDDGIManager().init({
        scene,
        renderer,
        camera,
        getDirectionalLight: () => mainDirectionalLight,
    });
    if (typeof window !== 'undefined') {
        window.__ddgi = getDDGIManager();
    }

    // Initialize TransformControls for gizmo manipulation
    transformControl = new TransformControls(camera, renderer.domElement);
    transformControl.setSize(1.5); // Make gizmo hit area larger
    transformControl.addEventListener('change', () => {
        if (blueprintState.active) {
            updateBlueprintDetailsUI();
        }
    });
    transformControl.addEventListener('dragging-changed', (event) => {
        showcase.looking = false;
        if (!event.value) {
            if (blueprintState.active) {
                const prop = getDynamicPropById(objectScriptState.targetPropId);
                if (prop) rebuildActorPhysics(prop);
            } else {
                syncTransformToPhysics();
            }
            transformControl.justFinishedDragging = true;
            editorHistory.captureState();
            setTimeout(() => transformControl.justFinishedDragging = false, 100);
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

    // Load initial HDR Environment
    switchEnvironment('sunny-sky');

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
    mainDirectionalLight.shadow.mapSize.width = 4096;
    mainDirectionalLight.shadow.mapSize.height = 4096;
    mainDirectionalLight.shadow.camera.near = 0.5;
    mainDirectionalLight.shadow.camera.far = 60;
    mainDirectionalLight.shadow.camera.left = -24;
    mainDirectionalLight.shadow.camera.right = 24;
    mainDirectionalLight.shadow.camera.top = 24;
    mainDirectionalLight.shadow.camera.bottom = -24;
    mainDirectionalLight.shadow.bias = -0.001;
    mainDirectionalLight.shadow.normalBias = 0.02;
    scene.add(mainDirectionalLight);
    scene.add(mainDirectionalLight.target);
    updateMainDirectionalLightShadowFocus();

    // Create example widgets
    createExampleWidgets();

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
    updateGameplayUI();

    renderer.setAnimationLoop(() => {
        const delta = Math.min(clock.getDelta(), 0.05);

        const updateStart = performance.now();
        if (gameplay.active) {
            updateGameplay(delta);
        } else {
            silenceVehicleEngineAudio();
            updateEngineAudioDebugOverlay('idle', null, null);
            updateShowcaseCamera(delta);
        }
        updateMainDirectionalLightShadowFocus();
        updateGameplayDebugRay();
        const updateDuration = performance.now() - updateStart;

        let physicsMetrics = { total: 0, step: 0, sync: 0, collisions: 0 };
        if (gameplay.active) {
            physicsMetrics = stepPhysics(delta);
            updateLitePhysicsPools();
        }
        updateVehicleVisuals(delta);
        updateVehicleSurfaceEffects(delta);
        syncActorCoreInstances();
        grassField?.update(delta);
        water?.update(delta);
        // Performance toggle: skip the per-frame work entirely when on.
        // setPerfModeEnabled has already called setEnabled(false) on each subsystem
        // so visuals stay flat; we just skip the update/tick CPU cost here.
        if (!perfModeEnabled) {
            volumetricFogController?.update(delta);
            postProcessVolumeManager?.update(delta);
        }
        const _ddgiStart = performance.now();
        if (!perfModeEnabled) {
            getDDGIManager().tick(delta);
        }
        const _ddgiMs = performance.now() - _ddgiStart;
        if (debugConsoleState?.latest) debugConsoleState.latest.ddgi = _ddgiMs;
        updateObjectAnimations(delta);
        tickForceAllSceneMeshShadows();

        multiplayerController?.syncLocalSnapshot(getLocalMultiplayerSnapshot());        multiplayerController?.update(delta);

        try {
            // Update widget system
            if (widgetManager) {
                widgetManager.update(delta);
            }

            const scriptStart = performance.now();
            runObjectTickScripts(delta);
            const scriptDuration = performance.now() - scriptStart;

            const renderStart = performance.now();
            tickRaycastDebugLine();
            if (postProcessing) {
                postProcessing.render();
            } else {
                renderer.render(scene, camera);
            }

            recordDebugFrameMetrics({
                frame: delta * 1000,
                update: updateDuration,
                physics: physicsMetrics.total,
                physicsStep: physicsMetrics.step,
                physicsSync: physicsMetrics.sync,
                physicsCollisions: physicsMetrics.collisions,
                scripts: scriptDuration,
                render: performance.now() - renderStart,
                delta,
            });
        } catch (e) {
            console.error('Crash in animation loop:', e);
            throw e;
        }
        updateDebugStatPanels();
    });
}

// Render loop now handled by setAnimationLoop in init

function getGroundHitAt(x, z, includeFloor = true, options = {}) {
    const {
        ignoreActor = null,
        targetObjects = null,
        minSurfaceUpDot = Number.NEGATIVE_INFINITY,
        surfaceStepTolerance = 0,
        cullBackFaces = false,
        maxHitY = Number.POSITIVE_INFINITY,
    } = options;
    const originY = Math.max(PLAYER_SETTINGS.probeHeight, gameplayBounds.max.y + PLAYER_SETTINGS.probeHeight);
    const hits = [];

    raycaster.set(tempVectorA.set(x, originY, z), downVector);

    if (Array.isArray(targetObjects)) {
        if (targetObjects.length > 0) {
            hits.push(...raycaster.intersectObjects(targetObjects, true));
        }
    } else {
        if (currentMesh) {
            hits.push(...raycaster.intersectObject(currentMesh, true));
        }

        if (sceneSystem?.actors?.size) {
            for (const actor of sceneSystem.actors) {
                if (!actor || actor === ignoreActor) continue;

                const actorMesh = getActorRenderObject(actor);
                if (!actorMesh) continue;

                const actorHits = raycaster.intersectObject(actorMesh, true);
                if (actorHits.length > 0) {
                    hits.push(...actorHits);
                }
            }
        }
    }

    if (includeFloor && worldFloor) {
        const terrainHeight = sampleTerrainHeightAt(x, z);
        if (terrainHeight !== null && originY >= terrainHeight) {
            hits.push({
                distance: originY - terrainHeight,
                point: tempVectorB.set(x, terrainHeight, z).clone(),
                object: worldFloor,
            });
        }
    }

    // Optional strict back-face cull: drop hits whose triangle faces away
    // from the ray direction (i.e. faces below the trace look down). Used by
    // car-related ground tracing so a slight overlap between two stitched
    // road segments can't surface a back-face hit and put the car at the
    // wrong Y.
    const backFaceCulledHits = cullBackFaces
        ? hits.filter((hit) => {
            if (!hit?.face || !hit.object?.matrixWorld) {
                return true;
            }
            const hitNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
            return hitNormal.y > 1e-4;
        })
        : hits;

    const heightFilteredHits = Number.isFinite(maxHitY)
        ? backFaceCulledHits.filter((hit) => (hit?.point?.y ?? Number.NEGATIVE_INFINITY) <= maxHitY)
        : backFaceCulledHits;

    const filteredHits = minSurfaceUpDot > Number.NEGATIVE_INFINITY
        ? heightFilteredHits.filter((hit) => {
            if (!hit?.face || !hit.object?.matrixWorld) {
                return true;
            }

            const hitNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
            return hitNormal.y >= minSurfaceUpDot;
        })
        : heightFilteredHits;

    const resolvedHits = filteredHits.length > 0
        ? filteredHits
        : (cullBackFaces ? heightFilteredHits : hits);

    resolvedHits.sort((a, b) => a.distance - b.distance);
    let resolvedHit = resolvedHits[0] || null;
    if (resolvedHit && surfaceStepTolerance > 0) {
        for (let index = 1; index < resolvedHits.length; index += 1) {
            const candidateHit = resolvedHits[index];
            if (!candidateHit?.point || !resolvedHit?.point) continue;

            const verticalGap = resolvedHit.point.y - candidateHit.point.y;
            if (verticalGap > 0 && verticalGap <= surfaceStepTolerance) {
                resolvedHit = candidateHit;
                continue;
            }

            break;
        }
    }

    updateRaycasterDebugLine(
        raycaster.ray,
        resolvedHit?.distance ?? originY,
        resolvedHit?.point ?? null,
        !!resolvedHit,
    );
    return resolvedHit;
}

function getGroundHeightAt(x, z, includeFloor = true, options = {}) {
    const hit = getGroundHitAt(x, z, includeFloor, options);
    return hit ? hit.point.y : null;
}

// --- File Handling ---

// Reads all files from a dropped directory entry recursively, returns filename→{file,url} map
// --- Optimization Pipeline ---
// === extracted: textureCompression (was lines 9098-9301 of original main.js) ===
// Add download listener (using onclick to prevent duplicate listeners on HMR)
if (downloadBtn) {
    downloadBtn.onclick = downloadAsset;
}

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
// === SCENE FOLDER BUNDLE ============================================
// Folder layout:
//   <picked-folder>/
//     scene.umap          (slim — actor records + assetPath references)
//     assets/
//       <fileName>.obj    (raw imported source files)
//
// Loading any folder bundle is far faster than a legacy .umap because
// importedTemplates no longer carry rootJson; the OBJ/GLB importer runs
// against the raw bytes the same way a fresh import does.

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

document.getElementById('load-actor-btn')?.addEventListener('click', () => {
    document.getElementById('actor-file-input')?.click();
});
document.getElementById('actor-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        loadActorFromFile(file);
        e.target.value = '';
    }
});

document.getElementById('reset-view')?.addEventListener('click', () => {
    if (gameplay.active) {
        respawnPlayer();
        return;
    }

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
    bindAppCore({
        scene: () => scene,
        camera: () => camera,
        renderer: () => renderer,
        currentMesh: () => currentMesh,
        transformControl: () => transformControl,
    });

    installAnimatedSample({
        scene,
        getCurrentMesh: () => currentMesh,
        setCurrentMesh: (v) => { currentMesh = v; },
        getWidgetManager: () => widgetManager,
        getRuntimeHud,
        UTextWidget, UProgressBarWidget,
        clearCurrentMesh, normalizeCurrentMesh, refreshGameplayWorld,
        updateLoadedAssetStats, enableOptimizationPipeline, playObjectAnimation,
    });

    installDropHandlers({
        scene, camera, renderer, container,
        physics, gameplay,
        processingOverlay, processingStep, loaderBar,
        MODEL_TARGET_MAX_DIMENSION,
        getCurrentMesh: () => currentMesh,
        setCurrentMesh: (v) => { currentMesh = v; },
        getModelBody: () => physics.modelBody,
        setModelBody: (v) => { physics.modelBody = v; },
        getScanPlane: () => scanPlane,
        setScanPlane: (v) => { scanPlane = v; },
        loadObjectFromFile, normalizeObjectToDimension,
        clearDynamicPhysicsProps, destroyPhysicsBody, destroyPlayerCharacter,
        disposeRenderableObject, playObjectAnimation,
        updateLoadedAssetStats, refreshGameplayWorld, updateGameplayUI, exitGameplay,
    });

    installSceneDebug({
        scene, camera, renderer, sceneSystem, physics, physicsCore,
        gameplay, importedPropState,
        raycastDebugState, collisionDebugState, shadowDebugState,
        shadowDebugUiRefs, perfModeUiRefs,
        postProcessVolumeManager,
        getVolumetricFogController: () => volumetricFogController,
        getDDGIManager,
        VEHICLE_SETTINGS,
        tempVectorC,
        getActorByBodyId, getActorComponentFlags, getActorRenderObject,
        physgunCameraRay, pushDebugConsoleLine,
    });

    installScriptState({
        physics, gameplay, objectScriptState, debugConsoleState,
        importedPropState,
        renderer,
        objectScriptMenu, objectScriptEditor,
        OBJECT_SCRIPT_STORAGE_KEY,
        tempVectorA,
        copyJoltVector,
        getDynamicPropById, getActorBody, getActorRenderObject,
        getMetadataComponent, getScriptComponent, getPhysicsBodyComponent,
        ensureActorScriptComponent,
        runObjectEventScript, hasEnabledDynamicPropEvent,
        closeObjectScriptMenu, closeObjectScriptEditor,
    });

    installSceneExport({
        importedPropState,
        processingOverlay, processingStep, loaderBar, downloadBtn,
        EXPORT_MAX_TEXTURE_SIZE,
        getCurrentMesh: () => currentMesh,
        getSourceFiles: () => sourceFiles,
        getImportedTemplates: () => importedTemplates,
        exportWorldToJSON, runWebGPUBenchmark,
        compressTextures,
        startScanEffect, stopScanEffect,
        registerImportedPropTemplateFromSerializedData,
    });

    installImportedProps({
        physics, importedPropState,
        scene, camera,
        importedPropList, importedPropLibrary,
        propCollisionPrompt, propCollisionCopy, propCollisionRemember,
        propImportDefaultStatus, resetPropImportDefaultBtn,
        IMPORTED_PROP_COLLISION_LABELS, IMPORTED_PROP_COMPLEX_HULL_RADIUS,
        IMPORTED_PROP_MAX_HULL_PARTS, IMPORTED_PROP_MAX_HULL_POINTS, PROP_TARGET_MAX_DIMENSION,
        tempVectorA, tempVectorB, tempVectorC, tempVectorD, tempVectorE,
        cloneDisposableObject, formatImportedPropName, normalizeObjectToDimension,
        createLoadingManager, convertLoadedObjectMaterials, loadObjectFromFile, processTrigger,
        createDynamicPropActor, setActorComponentFlags,
        countTrianglesForObject,
        createDynamicPrimitiveBody, createStaticMeshBody, createOwnedShape,
        getDynamicPropSpawn,
        syncActorEditorTemplateOptions, openActorEditor,
        disposeRenderableObject, playObjectAnimation,
        runOptimizationPipeline,
    });

    installSceneUi({
        gameplay, blueprintState, objectScriptState, importedPropState,
        physics, collisionDebugState, mobileState,
        camera, renderer, scene, sceneSystem,
        transformControl,
        actorEditor, actorEditorSummary, actorEditorStatus,
        actorKindSelect, actorLabelInput, actorScaleInput,
        actorImportedTemplateSelect, actorVehicleBodyTemplateSelect, actorVehicleWheelTemplateSelect,
        actorComponentCollisionInput, actorComponentPhysicsInput, actorComponentScriptsInput,
        actorEditorState,
        setPendingVehicleTemplateImportSlot: (v) => { pendingVehicleTemplateImportSlot = v; },
        vehicleTemplateImportInput,
        postProcessUiRefs, postProcessUiState, postProcessVolumeManager,
        globalPostProcessUniforms,
        worldEnvUiRefs, worldEnvState,
        WORLD_ENV_DEFAULTS, WORLD_ENV_STORAGE_KEY, VEHICLE_CUSTOM_IMPORT_VALUE,
        sceneUiCount, sceneUiList,
        getAmbientLight: () => ambientLight,
        getHemiLight: () => hemiLight,
        getMainDirectionalLight: () => mainDirectionalLight,
        getDdgiVolume: () => ddgiVolume,
        getVolumetricFogController: () => volumetricFogController,
        getEnvironmentController: () => environmentController,
        switchEnvironment,
        getDDGIManager,
        actorInheritsCore, getActorCoreSource, getActorRenderObject,
        ensureActorScriptState,
        selectShowcaseActor, focusSceneActor,
        enterBlueprintEditor, openObjectScriptEditor,
        spawnImportedProp, spawnDrivableCar, spawnDynamicPrimitive, spawnDDGIVolumeActor,
        exportActorToFile,
        syncBlueprintPhysicsEditor, syncShowcaseAnglesFromTarget, applyShowcaseCameraRotation,
        refreshCollisionDebugOverlays,
    });

    installActorPhysics({
        gameplay, blueprintState, objectScriptState, importedPropState, physics,
        collisionDebugState, transformControl, actorPhysicsEditorState,
        getDynamicPropById, getActorSelectionObject, getActorRenderObject,
        getActorBody, getActorComponentFlags, setActorComponentFlags,
        findDynamicPropByMesh,
        buildActorCollisionOverlay, disposeCollisionOverlayObject, refreshCollisionDebugOverlays,
        createDynamicPrimitiveBody, createStaticMeshBody, createOwnedShape,
        getPhysicsBodyComponent,
        refreshSceneUI, refreshBlueprintComponents,
    });

    installTerrainPanel({
        terrainBrushState, gameplay, blueprintState,
        camera, renderer, pointerNdc, raycaster,
        getWorldFloor: () => worldFloor,
        getGrassField: () => grassField,
        applySerializedTerrainState, serializeTerrainState,
        rebuildTerrainPhysicsBody,
        applyTerrainSculptBrush,
        setTerrainCustomImage, setTerrainModeGrassPBR, setTerrainModeGrid, setTerrainModeSolid,
        setTerrainRepeat, setTerrainRoughness, setTerrainTint,
        ensurePlayerCharacter, updateWorldPresentation, updateGameplayUI,
    });

    setupVehicleController({
        physics, gameplay, vehicleState, importedPropState,
        camera,
        VEHICLE_SETTINGS, PLAYER_SETTINGS,
        getWorldFloor: () => worldFloor,
        upVector, gameplayLookTarget,
        tempVectorA, tempVectorB, tempVectorC, tempVectorD, tempVectorE,
        tempQuaternionA,
        copyJoltVector, copyJoltQuaternion,
        getActorBody, getActorRenderObject,
        emitVehicleSurfaceEffects,
        getGroundHitAt, getGroundHeightAt,
        updateGameplayUI, respawnPlayer,
    });

    setupGameplayLoop({
        gameplay, physics, showcase, vehicleState, blueprintState, mobileState,
        terrainBrushState, debugConsoleState, collisionDebugState, importedPropState, objectScriptState,
        camera, renderer, container,
        pointerNdc, raycaster, editorHistory, transformControl,
        gameplayLookTarget, gameplayBounds, mainDirectionalLightShadowFocus, mainDirectionalLightOffset,
        upVector, tempVectorA, tempVectorB, tempVectorC, tempVectorD, tempVectorE,
        PLAYER_SETTINGS, VEHICLE_SETTINGS, TERRAIN_Y_OFFSET,
        SHOWCASE_CAMERA_POSITION, SHOWCASE_CAMERA_TARGET,
        runtimeAudio,
        getCurrentMesh: () => currentMesh,
        getWorldFloor: () => worldFloor,
        getMainDirectionalLight: () => mainDirectionalLight,
        getPedestal: () => pedestal,
        getResetViewBtn: () => resetViewBtn,
        getGameplayStatus: () => gameplayStatus,
        getPlayHint: () => playHint,
        getSceneUiList: () => sceneUiList,
        setCollisionDebugEnabled,
        isEditableElement,
        runMouseAction, applyMouseActionScripts,
        handleDebugConsoleKeydown,
        closeObjectScriptMenu, closeObjectScriptEditor, maybeOpenObjectScriptMenuFromMobileTap,
        isTransformControlSphereHit, handleLightGridClick, focusShowcaseCameraOnObject,
        selectShowcaseActor, syncTransformControlState,
        snapshotSceneState, restoreSceneState,
        updateMouseActionStatus, updateMobileButtons,
        updateCameraModeButtons, updateBlueprintTransformUI, refreshBlueprintComponents,
        onWindowResize,
        getDynamicPropHitFromEvent, getDynamicPropById, getActorRenderObject,
        applyTerrainBrushFromEvent, updateTerrainBrushPreview,
        rebuildTerrainPhysicsBody, rebuildModelPhysicsBody, ensurePlayerCharacter, syncCameraToCharacter,
        copyJoltVector, updateRaycasterDebugLine, positionLightGrid,
        getGroundHitAt, getGroundHeightAt,
        spawnDrivableCar,
        resetAllScriptLifecycleHandles,
        copySelectedToClipboard, pasteFromClipboard, deleteSelectedActor, duplicateSelected,
    });

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
    });

    setupDebugConsole({
        debugConsole, debugConsoleOutput, debugConsoleInput, debugConsoleFooter,
        debugStatsOverlay,
        debugConsoleState, mobileState, shadowDebugState, raycastDebugState,
        gameplay, physics,
        DEBUG_CONSOLE_LOG_LIMIT, DEBUG_CONSOLE_HISTORY_LIMIT,
        DEBUG_TIMING_SAMPLE_LIMIT,
        closeObjectScriptMenu, closeObjectScriptEditor, resetMovementInputState,
        renderer, setRayDebugEnabled, forceAllSceneMeshShadows,
        setForceAllSceneMeshShadowsEnabled, updateMobileButtons,
        resetMobileInputState, updateWorldPresentation, updateGameplayUI,
        isEditableElement,
    });

    setupMobileControls({
        mobileState, gameplay, showcase, vehicleState, physics,
        MOBILE_MOVE_THRESHOLD, MOBILE_MOVE_RADIUS_FACTOR, MOBILE_LOOK_SENSITIVITY,
        PLAYER_SETTINGS,
        isDrivingVehicle, setCameraMode, runMouseAction, exitVehicle, enterVehicle,
        applyGameplayCameraRotation, applyShowcaseCameraRotation,
    });

    setupSceneSerialization({
        scene, camera, sceneSystem, physics, importedPropState, objectScriptState,
        VEHICLE_SETTINGS,
        getActorBody, getActorRenderObject, getActorScriptState,
        serializeObjectMaterialState, serializeObjectMaterialOverrides,
        applyObjectMaterialState, applyObjectMaterialOverrides,
        serializeImportedPropTemplate, registerImportedPropTemplateFromSerializedData,
        spawnDrivableCar, spawnImportedProp, spawnDDGIVolumeActor, spawnDynamicPrimitive,
        syncRuntimePropIdCounter, rebuildActorPhysics, syncPropScriptState,
        destroyDynamicPhysicsProp, getDynamicPropDisplayName, saveObjectScriptDrafts,
        refreshSceneUI, selectShowcaseActor, ensureVehicleVisualState,
        serializeComponentTree, deserializeComponentTree, editorHistory,
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
        serializeImportedPropTemplate, registerImportedPropTemplateFromSerializedData,
        saveObjectScriptDrafts, refreshSceneUI, selectShowcaseActor,
        buildPrimitiveActorMesh, applyObjectMaterialState, serializeObjectMaterialState,
        enterBlueprintEditor, exitBlueprintEditor, refreshBlueprintComponents,
        serializeWorldTerrainState, applyWorldTerrainState, refreshGameplayWorld,
        forceExitGameplayForWorldLoad, updateGameplayUI, updateWorldPresentation,
    });
}

