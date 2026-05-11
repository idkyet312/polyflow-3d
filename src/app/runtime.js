import * as THREE from 'three';
import { WebGPURenderer, RenderPipeline } from 'three/webgpu';
import { pass, mrt, output, emissive, normalView, uniform, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
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
import {
    cloneDisposableObject,
    formatImportedPropName,
    normalizeObjectToDimension,
    createLoadingManager,
    convertLoadedObjectMaterials,
    loadObjectFromFile,
} from '../io/objectLoader.js';
import { createSocketMultiplayer } from '../network/socketMultiplayer.js';
import { runWebGPUBenchmark } from '../../webgpu_utils.js';
import { createPhysicsCore } from '../physics/core.js';
import { createPhysicsRuntime } from '../physics/runtime.js';
import { createEnvironmentController } from '../world/environment.js';
import { createLightGridController } from '../world/lightGrid.js';
import { createVolumetricFog } from '../world/volumetricFog.js';
import { createPostProcessVolumeManager } from '../world/postProcessVolume.js';
import { getDDGIManager } from '../world/gi/ddgiManager.js';
import { createDDGIRayDebug } from '../world/gi/ddgiRayDebug.js';
import { DDGIMeshStandardNodeMaterial } from '../world/gi/DDGIMeshStandardNodeMaterial.js';
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
} from '../runtime/sceneRuntime.js';
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
import { createPostProcessUiController } from '../world/postProcessUiController.js';
import { createLitePhysicsPool } from '../physics/litePool.js';
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
    compressTextures,
} from '../optim/textureCompression.js';
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
        position: { x: 0.05, y: 0.9 },
        visible,
    });
    scoreWidget.AddToViewport(20);

    const healthBar = hud.CreateWidget(UProgressBarWidget, {
        Percent: 1.0,
        width: 200,
        height: 20,
        fillColor: '#00ff00',
        backgroundColor: '#333333',
        position: { x: 0.05, y: 0.8 },
        visible,
    });
    healthBar.AddToViewport(20);

    const speedWidget = hud.CreateWidget(UTextWidget, {
        Text: 'Speed: 0 km/h',
        fontSize: 16,
        color: '#00ffff',
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        position: { x: 0.05, y: 0.7 },
        visible,
    });
    speedWidget.AddToViewport(20);

    window.exampleWidgets = {
        score: scoreWidget,
        health: healthBar,
        speed: speedWidget,
    };
    window.gameHud = hud;
    window.gameScore = 0;

    if (window.DEBUG_WIDGET_API) {
        console.log('Example widgets created:', window.exampleWidgets);
        console.log('Widget API available at window.WidgetAPI');
        console.log('Unreal widget API available at window.UnrealWidgetAPI');
        console.log('Example usage:');
        console.log('  WidgetAPI.createWidget("text", {text: "Hello!", position: {x: 0.5, y: 0.5}})');
        console.log('  UnrealWidgetAPI.CreateWidget(UTextWidget, { Text: "Hello HUD" }).AddToViewport(25)');
    }
}

const LIGHT_ACTOR_KINDS = new Set(['pointLight', 'spotLight']);

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
let gpuTimestampResolvePending = null;
let latestGpuRenderMs = 0;
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
const WORLD_ENV_STORAGE_KEY = 'polyflow.worldEnvironment.v5';
const WORLD_ENV_DEFAULTS = Object.freeze({
    sky: { enabled: true, preset: 'sunny-sky', blurriness: 0.05 },
    ambient: { enabled: true, intensity: 1.0 },
    hemi: { enabled: true, intensity: 1.5 },
    sun: { enabled: true, castShadow: true, intensity: 2.5 },
    tonemap: { exposure: 1.0 },
    bloom: { enabled: true, strength: 0.6, radius: 0.95, threshold: 0.9 },
    ssgi: { enabled: false, giIntensity: 2.0, aoIntensity: 1.0, radius: 8.0, thickness: 0.6, sliceCount: 1, stepCount: 8 },
    fog: { enabled: true, density: 0.012, opacity: 0.055 },
    ddgi: { enabled: true, liveBake: true, bakeEveryN: 4, probesPerFrame: 4, intensity: 12.0, lightIntensity: 0.35, debugProbes: false, rayDebug: false, contributionView: false, solidTest: false },
    shadows: { enabled: true },
});
let worldEnvState = JSON.parse(JSON.stringify(WORLD_ENV_DEFAULTS));
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
const EXPORT_MAX_TEXTURE_SIZE = 1024;
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
        gpu: 0,
        render: 0,
        ddgi: 0,
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
const gameplayPrefabState = {
    teleporterCooldownUntil: 0,
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
    if (!debugConsoleState.panels.has('gpu')) return;
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

function enableOptimizationPipeline() {
    if (!processTrigger) return;
    processTrigger.style.opacity = '1';
    processTrigger.style.cursor = 'pointer';
    processTrigger.onclick = runOptimizationPipeline;
}

function updateLoadedAssetStats(name, fileSize, root) {
    document.getElementById('asset-name').textContent = name;
    document.getElementById('tri-count').textContent = 'Counting...';

    originalFileSize = fileSize;
    document.getElementById('file-size').textContent = (originalFileSize / (1024 * 1024)).toFixed(1) + ' MB';
    document.getElementById('file-diff').textContent = '';
    document.getElementById('webgpu-speedup').textContent = '--';

    originalTriCount = Math.round(countTrianglesForObject(root));
    console.log('Model loaded. Triangles:', originalTriCount);

    const countObj = { val: 0 };
    gsap.to(countObj, {
        val: originalTriCount,
        duration: 1.5,
        ease: 'power2.out',
        onUpdate: () => {
            document.getElementById('tri-count').textContent = Math.ceil(countObj.val).toLocaleString();
        },
    });

    enableOptimizationPipeline();
}

function updatePropImportStatus() {
    if (!propImportDefaultStatus || !resetPropImportDefaultBtn) return;

    if (importedPropState.futureCollisionMode) {
        propImportDefaultStatus.textContent = `Create actor instances with render, collision, and script components. Future imported actor sources use ${IMPORTED_PROP_COLLISION_LABELS[importedPropState.futureCollisionMode]}.`;
        resetPropImportDefaultBtn.hidden = false;
        return;
    }

    propImportDefaultStatus.textContent = 'Create actor instances with render, collision, and script components. Imported actor sources ask for a collision mode.';
    resetPropImportDefaultBtn.hidden = true;
}

function closePropCollisionPrompt() {
    if (!propCollisionPrompt) return;

    propCollisionPrompt.hidden = true;
    if (propCollisionRemember) {
        propCollisionRemember.checked = false;
    }
}

function resolvePropCollisionPrompt(selection) {
    if (!importedPropState.promptResolver) return;

    const resolver = importedPropState.promptResolver;
    importedPropState.promptResolver = null;
    closePropCollisionPrompt();
    resolver(selection);
}

function promptImportedPropCollision(fileName, triangleCount) {
    if (importedPropState.futureCollisionMode) {
        return Promise.resolve({
            mode: importedPropState.futureCollisionMode,
            remember: true,
        });
    }

    if (!propCollisionPrompt || !propCollisionCopy) {
        return Promise.resolve({ mode: 'complex', remember: false });
    }

    propCollisionCopy.textContent = `${formatImportedPropName(fileName)} has about ${triangleCount.toLocaleString()} triangles. Pick a simple box collision or a tighter convex collision for this imported prop.`;
    propCollisionRemember.checked = false;
    propCollisionPrompt.hidden = false;

    return new Promise((resolve) => {
        importedPropState.promptResolver = resolve;
    });
}

function createImportedSimpleShape(root) {
    const { Jolt } = physics;
    root.updateWorldMatrix(true, true);

    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(tempVectorA);
    const halfExtentVector = new Jolt.Vec3(
        Math.max(size.x * 0.5, 0.08),
        Math.max(size.y * 0.5, 0.08),
        Math.max(size.z * 0.5, 0.08)
    );
    const shape = createOwnedShape(new Jolt.BoxShapeSettings(halfExtentVector, 0.03));
    Jolt.destroy(halfExtentVector);
    return shape;
}

function createExactMeshShape(root) {
    if (!physics.ready || !root) return null;

    const { Jolt } = physics;
    root.updateWorldMatrix(true, true);

    const totalTriangles = countTrianglesForObject(root);
    if (!totalTriangles) {
        throw new Error('Imported prop has no usable mesh geometry for exact collision.');
    }

    const triangles = new Jolt.TriangleList();
    const materials = new Jolt.PhysicsMaterialList();
    const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const childToRoot = new THREE.Matrix4();

    triangles.resize(totalTriangles);
    let triangleIndex = 0;

    try {
        root.traverse((child) => {
            if (!child.isMesh || !child.geometry?.attributes?.position) return;

            const position = child.geometry.getAttribute('position');
            const index = child.geometry.getIndex();
            const triangleCount = index ? index.count / 3 : position.count / 3;

            childToRoot.multiplyMatrices(rootInverse, child.matrixWorld);

            for (let triangleOffset = 0; triangleOffset < triangleCount; triangleOffset++) {
                const i0 = index ? index.getX(triangleOffset * 3) : triangleOffset * 3;
                const i1 = index ? index.getX(triangleOffset * 3 + 1) : triangleOffset * 3 + 1;
                const i2 = index ? index.getX(triangleOffset * 3 + 2) : triangleOffset * 3 + 2;

                tempVectorA.fromBufferAttribute(position, i0).applyMatrix4(childToRoot);
                tempVectorB.fromBufferAttribute(position, i1).applyMatrix4(childToRoot);
                tempVectorC.fromBufferAttribute(position, i2).applyMatrix4(childToRoot);

                const triangle = triangles.at(triangleIndex++);
                const v1 = triangle.get_mV(0);
                const v2 = triangle.get_mV(1);
                const v3 = triangle.get_mV(2);
                v1.x = tempVectorA.x;
                v1.y = tempVectorA.y;
                v1.z = tempVectorA.z;
                v2.x = tempVectorB.x;
                v2.y = tempVectorB.y;
                v2.z = tempVectorB.z;
                v3.x = tempVectorC.x;
                v3.y = tempVectorC.y;
                v3.z = tempVectorC.z;
            }
        });

        return createOwnedShape(new Jolt.MeshShapeSettings(triangles, materials));
    } finally {
        Jolt.destroy(triangles);
        Jolt.destroy(materials);
    }
}

function createImportedConvexHullShape(points) {
    const { Jolt } = physics;
    const settings = new Jolt.ConvexHullShapeSettings();
    settings.mPoints = points;
    settings.mMaxConvexRadius = IMPORTED_PROP_COMPLEX_HULL_RADIUS;
    settings.mMaxErrorConvexRadius = IMPORTED_PROP_COMPLEX_HULL_RADIUS;
    return createOwnedShape(settings);
}

function collectImportedComplexHullParts(root) {
    const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const childToRoot = new THREE.Matrix4();
    const hullParts = [];

    root.traverse((child) => {
        if (!child.isMesh || !child.geometry?.attributes?.position) return;

        const position = child.geometry.getAttribute('position');
        if (!position || position.count < 4) return;

        const sampleStep = Math.max(1, Math.ceil(position.count / IMPORTED_PROP_MAX_HULL_POINTS));
        const points = [];
        childToRoot.multiplyMatrices(rootInverse, child.matrixWorld);

        for (let i = 0; i < position.count; i += sampleStep) {
            tempVectorA.fromBufferAttribute(position, i).applyMatrix4(childToRoot);
            points.push({
                x: tempVectorA.x,
                y: tempVectorA.y,
                z: tempVectorA.z,
            });
        }

        if (points.length < 4) return;

        hullParts.push({
            points,
            weight: points.length,
        });
    });

    if (hullParts.length <= IMPORTED_PROP_MAX_HULL_PARTS) {
        return hullParts;
    }

    return hullParts
        .sort((left, right) => right.weight - left.weight)
        .slice(0, IMPORTED_PROP_MAX_HULL_PARTS);
}

function createImportedComplexShape(root) {
    return createExactMeshShape(root);
}

function createImportedCollisionShape(root, mode) {
    if (mode === 'simple') {
        return { shape: createImportedSimpleShape(root), mode: 'simple' };
    }

    try {
        return { shape: createImportedComplexShape(root), mode: 'complex' };
    } catch (error) {
        console.warn('Falling back to simple imported collision shape.', error);
        alert('Complex collision was not valid for this prop. Falling back to simple collision for this import.');
        return { shape: createImportedSimpleShape(root), mode: 'simple' };
    }
}

function renderImportedPropButtons() {
    if (!importedPropList || !importedPropLibrary) return;

    importedPropList.innerHTML = '';
    importedPropLibrary.hidden = importedPropState.templates.length === 0;

    importedPropState.templates.forEach((template) => {
        const button = document.createElement('button');
        button.className = 'btn viewer-menu-btn';
        button.textContent = `${template.displayName} · ${template.collisionMode === 'simple' ? 'Simple' : 'Complex'}`;
        button.title = `Open the actor editor for ${template.displayName} with ${IMPORTED_PROP_COLLISION_LABELS[template.collisionMode]}.`;
        button.addEventListener('click', () => openActorEditor({ kind: 'imported', templateId: template.id, label: template.displayName }));
        importedPropList.appendChild(button);
    });

    syncActorEditorTemplateOptions();
}

function registerImportedPropTemplate(fileName, root, collisionMode, shape, triangleCount) {
    const displayName = formatImportedPropName(fileName);
    const template = {
        id: `imported-prop-${importedPropState.nextId++}`,
        fileName,
        displayName,
        root,
        shape,
        collisionMode,
        triangleCount,
    };

    importedPropState.templates.push(template);
    renderImportedPropButtons();
    updatePropImportStatus();
    return template;
}

async function registerImportedPropTemplateFromSerializedData(templateData, { fileMap = null } = {}) {
    if (!templateData) return null;

    const existingTemplate = importedPropState.templates.find((entry) => entry.id === templateData.id);
    if (existingTemplate) {
        return existingTemplate;
    }

    let root = null;

    // Folder-bundle path: the .umap stores assetPath instead of rootJson and
    // the raw OBJ/GLB lives next to it. Resolve via the loaded fileMap and
    // run the same importer the fresh-import flow uses — much faster than
    // re-hydrating a THREE.ObjectLoader JSON blob.
    if (templateData.assetPath && fileMap) {
        const entry = lookupBundleAsset(fileMap, templateData.assetPath, templateData.fileName);
        if (entry?.file) {
            root = await loadObjectFromFile(entry.file, fileMap);
            if (templateData.assetType !== 'glb') {
                normalizeObjectToDimension(root, PROP_TARGET_MAX_DIMENSION, false);
            }
        } else {
            console.warn(`[scene] Asset "${templateData.assetPath}" missing from bundle; template will be skipped.`);
            return null;
        }
    } else if (templateData.rootJson) {
        const objectLoader = new THREE.ObjectLoader();
        root = objectLoader.parse(templateData.rootJson);
        convertLoadedObjectMaterials(root);
        // Legacy serialized templates already carried the normalized transform
        // applied at import time. Re-normalizing here mutates the source asset
        // before any actor transform is restored.
        if (templateData.normalized === false) {
            normalizeObjectToDimension(root, PROP_TARGET_MAX_DIMENSION, false);
        }
    } else {
        return null;
    }

    const triangleCount = Number.isFinite(templateData.triangleCount)
        ? templateData.triangleCount
        : Math.round(countTrianglesForObject(root));
    const collision = createImportedCollisionShape(root, templateData.collisionMode || 'simple');
    const template = {
        id: templateData.id || `imported-prop-${importedPropState.nextId++}`,
        fileName: templateData.fileName || 'Imported Prop',
        displayName: templateData.displayName || formatImportedPropName(templateData.fileName || 'Imported Prop'),
        root,
        shape: collision.shape,
        collisionMode: collision.mode,
        triangleCount,
    };

    importedPropState.templates.push(template);

    // If we loaded from a folder bundle, retain the original File so the user
    // can re-save the scene as a folder without re-inlining the geometry.
    if (templateData.assetPath && fileMap) {
        const entry = lookupBundleAsset(fileMap, templateData.assetPath, templateData.fileName);
        if (entry?.file) {
            importedPropState.sourceFiles[template.id] = entry.file;
        }
    }

    const matchedId = /imported-prop-(\d+)$/.exec(template.id || '');
    if (matchedId) {
        importedPropState.nextId = Math.max(importedPropState.nextId, Number(matchedId[1]) + 1);
    }

    renderImportedPropButtons();
    updatePropImportStatus();
    return template;
}

function lookupBundleAsset(fileMap, assetPath, fileName) {
    if (!fileMap) return null;
    // fileMap is the same shape used by setupDropHandlers / createLoadingManager:
    // { 'relative/path.ext': { file, url } } and/or { 'basename.ext': { file, url } }.
    return fileMap[assetPath]
        || (fileName ? fileMap[fileName] : null)
        || (fileName ? fileMap[fileName.toLowerCase()] : null)
        || null;
}

function serializeImportedPropTemplate(template, { preferAssetPath = false } = {}) {
    if (!template?.root) return null;

    const base = {
        id: template.id,
        fileName: template.fileName,
        displayName: template.displayName,
        normalized: true,
        collisionMode: template.collisionMode,
        triangleCount: template.triangleCount,
    };

    // When a scene is being saved as a folder bundle and we still have the
    // original imported File, point at it via assetPath. Bundle loading then
    // re-runs the OBJ/GLB importer on the raw file (fast) instead of parsing
    // a serialized THREE.ObjectLoader blob (slow). Inline rootJson stays as
    // the fallback for templates whose source file isn't available.
    const sourceFile = importedPropState.sourceFiles?.[template.id];
    if (preferAssetPath && sourceFile) {
        return { ...base, assetPath: `assets/${template.fileName}` };
    }

    return { ...base, rootJson: template.root.toJSON() };
}

function spawnImportedProp(templateId, options = {}) {
    if (!physics.ready || !scene || !camera) {
        console.warn('Jolt physics is not ready yet.');
        return null;
    }

    const template = importedPropState.templates.find((entry) => entry.id === templateId);
    if (!template?.root) return null;

    const spawnPosition = tempVectorD;
    const launchImpulse = tempVectorE;
    getDynamicPropSpawn(spawnPosition, launchImpulse);

    const visual = cloneDisposableObject(template.root);
    let body = null;
    const includeCollisionBody = options.includeCollisionBody !== false;
    const requestedSimulatePhysics = includeCollisionBody && options.simulatePhysics !== false;
    const useExactMeshCollision = template.collisionMode === 'complex';
    const simulatePhysics = requestedSimulatePhysics && !useExactMeshCollision;

    if (includeCollisionBody && useExactMeshCollision && requestedSimulatePhysics) {
        console.warn('Exact triangle mesh collision is static-only; spawning imported prop without simulated physics.');
    }

    visual.position.copy(spawnPosition);

    if (includeCollisionBody) {
        if (useExactMeshCollision) {
            body = createStaticMeshBody(visual);
        } else {
            template.shape.AddRef();

            body = createDynamicPrimitiveBody(
                template.shape,
                spawnPosition,
                launchImpulse,
                {
                    ...(template.collisionMode === 'simple'
                        ? { restitution: 0.12, friction: 0.84 }
                        : { restitution: 0.08, friction: 0.76 }),
                    simulatePhysics,
                }
            );
        }

        if (!body) {
            disposeRenderableObject(visual);
            return null;
        }
    }

    const actor = createDynamicPropActor({
        body,
        mesh: visual,
        kind: 'imported',
        templateId,
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
            dynamicBodySpatial.updateEntry(actor);
        } else {
            physics.staticBodies.push(actor);
        }
    }
    playObjectAnimation(visual);
    invalidateDDGI('imported prop spawned');
    return actor;
}

async function importPhysicsProp(file, fileMap = {}) {
    if (!file) return;

    try {
        const root = await loadObjectFromFile(file, fileMap);
        normalizeObjectToDimension(root, PROP_TARGET_MAX_DIMENSION, false);
        const triangleCount = Math.round(countTrianglesForObject(root));

        if (!triangleCount) {
            disposeRenderableObject(root);
            alert('Imported prop has no usable mesh geometry.');
            return;
        }

        const collisionPreference = await promptImportedPropCollision(file.name, triangleCount);
        if (!collisionPreference) {
            disposeRenderableObject(root);
            return;
        }

        if (collisionPreference.remember) {
            importedPropState.futureCollisionMode = collisionPreference.mode;
        }

        const collision = createImportedCollisionShape(root, collisionPreference.mode);
        const template = registerImportedPropTemplate(file.name, root, collision.mode, collision.shape, triangleCount);
        if (template?.id && file instanceof File) {
            importedPropState.sourceFiles[template.id] = file;
        }
        updatePropImportStatus();
        return template;
    } catch (error) {
        console.error('Failed to import physics prop.', error);
        alert(error?.message === 'Unsupported file format'
            ? 'Unsupported file format for physics prop import.'
            : 'Failed to import the selected prop. Check the console for details.');
    }
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

    dynamicBodySpatial.remove(prop);

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

function isDrivingVehicle() {
    return gameplay.active && !!vehicleState.activePropId;
}

function getActiveVehicleProp() {
    if (!vehicleState.activePropId) return null;

    return physics.dynamicBodies.find((prop) => (
        prop?.id === vehicleState.activePropId && prop.kind === 'vehicle'
    )) ?? null;
}

function clearActiveVehicle({ updateUi = false } = {}) {
    const wasDriving = !!vehicleState.activePropId;
    if (wasDriving) {
        silenceVehicleEngineAudio();
    }
    vehicleState.activePropId = '';
    vehicleState.brakeHeld = false;
    vehicleState.tailWhipLastFrame = false;

    if (!wasDriving) return;

    physics.jumpQueued = false;
    if (updateUi) {
        updateGameplayUI();
    }
}

function getVehicleForward(target, quaternion, flatten = true) {
    target.set(0, 0, -1).applyQuaternion(quaternion);
    if (flatten) {
        target.y = 0;
        if (target.lengthSq() < 1e-6) {
            target.set(0, 0, -1);
        } else {
            target.normalize();
        }
    }

    return target;
}

function resolveVehicleCameraCollision(lookTarget, desiredPosition) {
    if (!currentMesh) return desiredPosition;

    const direction = tempVectorE.copy(desiredPosition).sub(lookTarget);
    const distance = direction.length();
    if (distance <= 0.001) return desiredPosition;

    direction.multiplyScalar(1 / distance);
    raycaster.set(lookTarget, direction);
    raycaster.near = 0.08;
    raycaster.far = distance;

    const hit = raycaster.intersectObject(currentMesh, true)
        .find((entry) => entry.distance > raycaster.near && entry.distance < distance);

    raycaster.near = 0;
    raycaster.far = Infinity;

    if (!hit?.point) return desiredPosition;

    return desiredPosition.copy(hit.point)
        .addScaledVector(direction, -VEHICLE_SETTINGS.cameraCollisionPadding);
}

function positionVehicleCamera(vehiclePosition, vehicleRotation, delta) {
    const flatForward = getVehicleForward(tempVectorB, vehicleRotation, true);
    const chasePosition = tempVectorC
        .copy(vehiclePosition)
        .addScaledVector(upVector, VEHICLE_SETTINGS.followHeight)
        .addScaledVector(flatForward, -VEHICLE_SETTINGS.followDistance);

    const lookTarget = tempVectorD
        .copy(vehiclePosition)
        .addScaledVector(upVector, VEHICLE_SETTINGS.seatHeight)
        .addScaledVector(flatForward, VEHICLE_SETTINGS.lookAhead);
    resolveVehicleCameraCollision(lookTarget, chasePosition);
    const cameraLerp = 1 - Math.exp(-delta * VEHICLE_SETTINGS.cameraHorizontalSmoothing);
    const cameraVerticalLerp = 1 - Math.exp(-delta * VEHICLE_SETTINGS.cameraVerticalSmoothing);
    const lookLerp = 1 - Math.exp(-delta * VEHICLE_SETTINGS.cameraLookSmoothing);

    camera.position.x = THREE.MathUtils.lerp(camera.position.x, chasePosition.x, cameraLerp);
    camera.position.z = THREE.MathUtils.lerp(camera.position.z, chasePosition.z, cameraLerp);
    camera.position.y = THREE.MathUtils.lerp(camera.position.y, chasePosition.y, cameraVerticalLerp);

    gameplayLookTarget.lerp(lookTarget, lookLerp);
    camera.lookAt(gameplayLookTarget);

    tempVectorE.copy(gameplayLookTarget).sub(camera.position);
    const flatDistance = Math.max(0.001, Math.hypot(tempVectorE.x, tempVectorE.z));
    gameplay.yaw = Math.atan2(tempVectorE.x, tempVectorE.z);
    gameplay.pitch = THREE.MathUtils.clamp(
        Math.atan2(-tempVectorE.y, flatDistance),
        -PLAYER_SETTINGS.maxLookPitch,
        PLAYER_SETTINGS.maxLookPitch
    );
}

function getNearbyVehicle() {
    const origin = gameplay.active && physics.character
        ? copyJoltVector(tempVectorA, physics.character.GetPosition())
        : tempVectorA.copy(camera.position);
    let closestVehicle = null;
    let closestDistanceSq = VEHICLE_SETTINGS.interactionRadius * VEHICLE_SETTINGS.interactionRadius;

    const nearbyActors = dynamicBodySpatial.querySphere(origin, VEHICLE_SETTINGS.interactionRadius);
    for (const prop of nearbyActors) {
        const body = getActorBody(prop);
        if (!body || prop.kind !== 'vehicle') continue;

        const bodyPosition = copyJoltVector(tempVectorB, physics.bodyInterface.GetPosition(body.GetID()));
        const distanceSq = origin.distanceToSquared(bodyPosition);
        if (distanceSq < closestDistanceSq) {
            closestDistanceSq = distanceSq;
            closestVehicle = prop;
        }
    }

    return closestVehicle;
}

function enterVehicle(prop = getNearbyVehicle()) {
    const propBody = getActorBody(prop);
    if (!gameplay.active || !propBody || prop.kind !== 'vehicle') return false;

    vehicleState.activePropId = prop.id;
    vehicleState.brakeHeld = false;
    physics.jumpQueued = false;
    gameplay.grounded = true;

    const vehiclePosition = copyJoltVector(tempVectorA, physics.bodyInterface.GetPosition(propBody.GetID())).clone();
    const vehicleRotation = copyJoltQuaternion(tempQuaternionA, physics.bodyInterface.GetRotation(propBody.GetID())).clone();
    const flatForward = getVehicleForward(tempVectorB, vehicleRotation, true);
    gameplayLookTarget
        .copy(vehiclePosition)
        .addScaledVector(upVector, VEHICLE_SETTINGS.seatHeight)
        .addScaledVector(flatForward, VEHICLE_SETTINGS.lookAhead);
    positionVehicleCamera(vehiclePosition, vehicleRotation, 1 / 60);

    updateGameplayUI();
    return true;
}

function exitVehicle() {
    const vehicle = getActiveVehicleProp();
    const vehicleBody = getActorBody(vehicle);
    if (!vehicleBody) {
        clearActiveVehicle({ updateUi: true });
        return false;
    }

    const vehiclePosition = copyJoltVector(tempVectorA, physics.bodyInterface.GetPosition(vehicleBody.GetID()));
    const vehicleRotation = copyJoltQuaternion(tempQuaternionA, physics.bodyInterface.GetRotation(vehicleBody.GetID()));
    const flatForward = getVehicleForward(tempVectorB, vehicleRotation, true);
    const exitRight = tempVectorC.set(1, 0, 0).applyQuaternion(vehicleRotation);
    exitRight.y = 0;
    if (exitRight.lengthSq() < 1e-6) {
        exitRight.set(1, 0, 0);
    } else {
        exitRight.normalize();
    }

    gameplay.spawnPoint.copy(vehiclePosition)
        .addScaledVector(exitRight, VEHICLE_SETTINGS.width * 0.95)
        .addScaledVector(flatForward, -0.45);

    const groundHit = getGroundHitAt(gameplay.spawnPoint.x, gameplay.spawnPoint.z, true);
    if (groundHit?.point) {
        gameplay.spawnPoint.y = groundHit.point.y + PLAYER_SETTINGS.floorOffset;
    }

    gameplay.spawnYaw = Math.atan2(flatForward.x, flatForward.z);
    gameplay.spawnPitch = -0.08;
    clearActiveVehicle();
    respawnPlayer(true);
    return true;
}


function ensureVehicleVisualState(root) {
    if (!root) return null;

    const state = root.userData?.vehicleVisual ?? null;
    const refsValid =
        state?.lastWorldPosition instanceof THREE.Vector3
        && Array.isArray(state.steeringPivots)
        && state.steeringPivots.every((p) => p?.isObject3D)
        && Array.isArray(state.spinGroups)
        && state.spinGroups.every((g) => g?.isObject3D);
    if (refsValid) return state;

    const steeringPivots = [];
    const spinGroups = [];
    root.traverse((object) => {
        const isSteeringPivot = object.userData?.vehicleSteeringPivot === true
            || typeof object.userData?.steerable === 'boolean';
        if (!isSteeringPivot) return;

        const spinGroup = object.children.find((child) => child.userData?.vehicleSpinGroup === true)
            ?? object.children.find((child) => child.isGroup || child.type === 'Group');
        if (!spinGroup) return;

        steeringPivots.push(object);
        spinGroups.push(spinGroup);
    });

    if (!steeringPivots.length || steeringPivots.length !== spinGroups.length) return null;

    const nextState = {
        steeringPivots,
        spinGroups,
        wheelRadius: Number.isFinite(state?.wheelRadius) ? state.wheelRadius : VEHICLE_SETTINGS.height * 0.36,
        maxSteerAngle: Number.isFinite(state?.maxSteerAngle) ? state.maxSteerAngle : 1.0,
        steerAngle: Number.isFinite(state?.steerAngle) ? state.steerAngle : 0,
        spinAngle: Number.isFinite(state?.spinAngle) ? state.spinAngle : 0,
        lastWorldPosition: new THREE.Vector3(),
        lastPositionInitialized: false,
    };
    root.userData.vehicleVisual = nextState;
    return nextState;
}


function updateVehicleVisuals(delta) {
    if (!physics.dynamicBodies?.length) return;

    const { bodyInterface } = physics;
    for (const prop of physics.dynamicBodies) {
        const renderObject = getActorRenderObject(prop);
        if (prop?.kind !== 'vehicle' || !renderObject) continue;

        const visualState = ensureVehicleVisualState(renderObject);
        if (!visualState) continue;

        // If userData was JSON-roundtripped (e.g. via three.js Object3D.clone
        // on a serialized template), every live reference inside vehicleVisual
        // is now a plain object: Vector3 has no .copy, steeringPivots / spinGroups
        // entries have no .rotation/.userData. Rather than crash every frame,
        // skip the broken state — the wheels won't animate but the editor stays
        // usable.
        const refsValid =
            visualState.lastWorldPosition instanceof THREE.Vector3
            && Array.isArray(visualState.steeringPivots)
            && visualState.steeringPivots.every((p) => p?.isObject3D)
            && Array.isArray(visualState.spinGroups)
            && visualState.spinGroups.every((g) => g?.isObject3D);
        if (!refsValid) continue;

        const flatForward = tempVectorA.set(0, 0, -1).applyQuaternion(renderObject.quaternion);
        flatForward.y = 0;
        if (flatForward.lengthSq() < 1e-6) {
            flatForward.set(0, 0, -1);
        } else {
            flatForward.normalize();
        }

        // Prefer Jolt's authoritative velocity while physics is stepping; in
        // edit/showcase mode physics is paused, so fall back to a frame-to-frame
        // world-position delta so the wheels still spin when the user drags
        // or scripts move the chassis.
        const body = bodyInterface ? getActorBody(prop) : null;
        let forwardSpeed = 0;
        if (body && physics.ready && gameplay.active) {
            const linearVelocity = copyJoltVector(tempVectorB, bodyInterface.GetLinearVelocity(body.GetID()));
            forwardSpeed = linearVelocity.dot(flatForward);
        } else {
            const currentPos = renderObject.getWorldPosition(tempVectorB);
            if (visualState.lastPositionInitialized && delta > 1e-5) {
                const move = tempVectorC.subVectors(currentPos, visualState.lastWorldPosition);
                forwardSpeed = move.dot(flatForward) / delta;
            }
            visualState.lastWorldPosition.copy(currentPos);
            visualState.lastPositionInitialized = true;
        }

        visualState.spinAngle += (forwardSpeed / visualState.wheelRadius) * delta;
        const isActiveVehicle = gameplay.active && vehicleState.activePropId === prop.id;
        const inputSteer = isActiveVehicle
            ? ((gameplay.input.left ? 1 : 0) - (gameplay.input.right ? 1 : 0))
            : 0;
        const speedRatio = THREE.MathUtils.clamp(Math.abs(forwardSpeed) / VEHICLE_SETTINGS.maxDriveSpeed, 0, 1);
        const targetSteerAngle = inputSteer * visualState.maxSteerAngle * THREE.MathUtils.lerp(1, 0.58, speedRatio);
        visualState.steerAngle = THREE.MathUtils.damp(visualState.steerAngle, targetSteerAngle, 10, delta);

        visualState.steeringPivots.forEach((pivot) => {
            pivot.rotation.y = pivot.userData.steerable ? visualState.steerAngle : 0;
        });
        visualState.spinGroups.forEach((group) => {
            group.rotation.x = visualState.spinAngle;
        });
    }
}

function getVehicleVisualBounds(chassis) {
    const bounds = new THREE.Box3();
    const rootInverse = new THREE.Matrix4();
    const localMatrix = new THREE.Matrix4();
    const meshBounds = new THREE.Box3();

    chassis.updateWorldMatrix(true, true);
    rootInverse.copy(chassis.matrixWorld).invert();
    chassis.traverse((node) => {
        if (!node.isMesh || !node.geometry) return;
        node.geometry.computeBoundingBox?.();
        if (!node.geometry.boundingBox) return;
        localMatrix.multiplyMatrices(rootInverse, node.matrixWorld);
        meshBounds.copy(node.geometry.boundingBox).applyMatrix4(localMatrix);
        bounds.union(meshBounds);
    });

    if (bounds.isEmpty()) {
        const halfSize = new THREE.Vector3(
            VEHICLE_SETTINGS.width * 0.5,
            VEHICLE_SETTINGS.height * 0.5,
            VEHICLE_SETTINGS.length * 0.5
        );
        return {
            min: halfSize.clone().multiplyScalar(-1),
            max: halfSize.clone(),
            center: new THREE.Vector3(),
            size: halfSize.multiplyScalar(2),
        };
    }

    return {
        min: bounds.min.clone(),
        max: bounds.max.clone(),
        center: bounds.getCenter(new THREE.Vector3()),
        size: bounds.getSize(new THREE.Vector3()),
    };
}

function createVehicleCollisionShapeFromBounds(bounds) {
    const { Jolt } = physics;
    const size = bounds?.size || new THREE.Vector3(
        VEHICLE_SETTINGS.width,
        VEHICLE_SETTINGS.height,
        VEHICLE_SETTINGS.length
    );
    const center = bounds?.center || new THREE.Vector3();
    const halfExtent = new Jolt.Vec3(
        Math.max(size.x * 0.5, 0.05),
        Math.max(size.y * 0.5, 0.05),
        Math.max(size.z * 0.5, 0.05)
    );
    const boxShape = createOwnedShape(new Jolt.BoxShapeSettings(halfExtent, 0.05));
    Jolt.destroy(halfExtent);

    const compound = new Jolt.MutableCompoundShapeSettings();
    const offset = new Jolt.Vec3(center.x, center.y, center.z);
    const rotation = new Jolt.Quat(0, 0, 0, 1);
    compound.AddShapeShape(offset, rotation, boxShape, 0);
    Jolt.destroy(offset);
    Jolt.destroy(rotation);
    return createOwnedShape(compound);
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

    const bodyTemplateId = options.bodyTemplateId || '';
    const wheelTemplateId = options.wheelTemplateId || '';
    const chassis = createDrivableCarVisual({
        bodyTemplateId,
        wheelTemplateId,
        vehicleSettings: VEHICLE_SETTINGS,
        importedPropState,
        cloneDisposableObject,
    });
    // Imported vehicle bodies can be hundreds of thousands of triangles.
    // Keep them rendered/interactive, but out of DDGI capture rebuilds.
    markDDGISkipCapture(chassis);
    const vehicleBounds = getVehicleVisualBounds(chassis);

    const groundHit = getGroundHitAt(spawnPosition.x, spawnPosition.z, true, { cullBackFaces: true });
    if (groundHit?.point) {
        spawnPosition.y = groundHit.point.y + VEHICLE_SETTINGS.spawnLift - vehicleBounds.min.y;
    }

    camera.getWorldDirection(tempVectorA);
    tempVectorA.y = 0;
    if (tempVectorA.lengthSq() < 1e-6) {
        tempVectorA.set(0, 0, -1);
    } else {
        tempVectorA.normalize();
    }

    const carRotation = tempQuaternionA.setFromUnitVectors(upVector.clone().set(0, 0, -1), tempVectorA);
    const shape = createVehicleCollisionShapeFromBounds(vehicleBounds);

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
    dynamicBodySpatial.updateEntry(vehicle);
    physicsCore?.registerBackFaceCulledBody?.(body);
    updateGameplayUI();
    return vehicle;
}

function createDynamicPrimitiveBody(shape, position, impulse, options = {}) {
    if (!physics.ready) return null;

    const { Jolt, bodyInterface } = physics;
    const simulatePhysics = options.simulatePhysics !== false;
    const kinematic = options.kinematic === true;
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
        kinematic ? Jolt.EMotionType_Kinematic : simulatePhysics ? Jolt.EMotionType_Dynamic : Jolt.EMotionType_Static,
        (simulatePhysics || kinematic) ? JOLT_MOVING_LAYER : JOLT_NON_MOVING_LAYER
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
        (!simulatePhysics && !kinematic) || options.activate === false ? Jolt.EActivation_DontActivate : Jolt.EActivation_Activate
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
    } else if (kind === 'cylinder') {
        const radius = normalizedScale;
        const halfHeight = normalizedScale;
        if (includeCollisionBody) {
            const halfExtentVector = new Jolt.Vec3(radius, halfHeight, radius);
            shape = createOwnedShape(new Jolt.BoxShapeSettings(halfExtentVector, 0.05));
            Jolt.destroy(halfExtentVector);
        }
        mesh = buildPrimitiveActorMesh('cylinder');
        mesh.scale.set(radius, halfHeight, radius);
        bodyOptions = {
            restitution: 0.1,
            friction: 0.8,
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
            dynamicBodySpatial.updateEntry(actor);
        } else {
            physics.staticBodies.push(actor);
        }
    }

    invalidateDDGI(`${kind} spawned`);
    return options.returnActor === true ? actor : body;
}

function tagGameplayPrefabActor(actor, gameplayPrefab, options = {}) {
    if (!actor) return null;
    actor.userData = {
        ...(actor.userData || {}),
        gameplayPrefab,
        triggerRadius: options.triggerRadius ?? 1.2,
        scoreValue: options.scoreValue ?? 0,
        collected: false,
    };
    const mesh = getActorRenderObject(actor);
    if (mesh) {
        mesh.userData.gameplayPrefab = gameplayPrefab;
        mesh.userData.triggerRadius = actor.userData.triggerRadius;
        mesh.userData.scoreValue = actor.userData.scoreValue;
        const groundY = getGroundHeightAt(mesh.position.x, mesh.position.z, true, { ignoreActor: actor });
        if (groundY !== null) {
            mesh.position.y = groundY + (options.groundOffset ?? 0.05);
        }
        mesh.updateMatrixWorld(true);
    }
    return actor;
}

function tintGameplayPrefabActor(actor, color, emissive = null, emissiveIntensity = 0) {
    setActorColor(actor, color);
    const mesh = getActorRenderObject(actor);
    mesh?.traverse?.((node) => {
        const materials = node?.material
            ? (Array.isArray(node.material) ? node.material : [node.material])
            : [];
        materials.forEach((mat) => {
            if (!mat?.emissive || !emissive) return;
            mat.emissive.set(emissive);
            mat.emissiveIntensity = emissiveIntensity;
            mat.toneMapped = false;
            mat.needsUpdate = true;
        });
    });
}

function getSoccerGoalieActors() {
    if (!sceneSystem?.actors?.size) return [];
    return Array.from(sceneSystem.actors).filter((actor) => {
        return !!(actor?.userData?.soccerGoalie || getActorRenderObject(actor)?.userData?.soccerGoalie);
    });
}

function applyPlayerSpawnFromActor(actor) {
    const mesh = getActorRenderObject(actor);
    if (!mesh) return false;
    mesh.updateMatrixWorld(true);
    mesh.getWorldPosition(tempVectorA);
    gameplay.spawnPoint.set(tempVectorA.x, tempVectorA.y + PLAYER_SETTINGS.floorOffset, tempVectorA.z);
    gameplay.spawnYaw = 0;
    gameplay.spawnPitch = -0.1;
    return true;
}

function getGameplayPrefabActors(type = '') {
    if (!sceneSystem?.actors?.size) return [];
    return Array.from(sceneSystem.actors).filter((actor) => {
        const prefabType = actor?.userData?.gameplayPrefab || getActorRenderObject(actor)?.userData?.gameplayPrefab || '';
        return prefabType && (!type || prefabType === type);
    });
}

function syncGameplaySpawnFromPlayerSpawnActor() {
    return applyPlayerSpawnFromActor(getGameplayPrefabActors('playerSpawn')[0]);
}

function spawnGameplayPrefab(type) {
    let actor = null;
    if (type === 'playerSpawn') {
        actor = spawnDynamicPrimitive('capsule', undefined, 0.45, {
            includeCollisionBody: false,
            includeScripts: false,
            userData: { label: 'Player Spawn' },
            returnActor: true,
        });
        tagGameplayPrefabActor(actor, type, { triggerRadius: 0.8, groundOffset: 0.45 });
        tintGameplayPrefabActor(actor, '#22c55e', '#22c55e', 1.8);
        applyPlayerSpawnFromActor(actor);
    } else if (type === 'teleporter') {
        actor = spawnDynamicPrimitive('cylinder', undefined, 1, {
            includeCollisionBody: false,
            includeScripts: false,
            userData: { label: 'Teleporter' },
            returnActor: true,
        });
        const mesh = getActorRenderObject(actor);
        if (mesh) mesh.scale.set(1.4, 0.08, 1.4);
        tagGameplayPrefabActor(actor, type, { triggerRadius: 1.45, groundOffset: 0.06 });
        tintGameplayPrefabActor(actor, '#22d3ee', '#22d3ee', 2.6);
    } else if (type === 'coin') {
        actor = spawnDynamicPrimitive('sphere', undefined, 0.35, {
            includeCollisionBody: false,
            includeScripts: false,
            userData: { label: 'Coin +10' },
            returnActor: true,
        });
        tagGameplayPrefabActor(actor, type, { triggerRadius: 0.95, groundOffset: 1.0, scoreValue: 10 });
        tintGameplayPrefabActor(actor, '#facc15', '#facc15', 2.8);
    } else if (type === 'target') {
        actor = spawnDynamicPrimitive('cylinder', undefined, 0.6, {
            includeCollisionBody: true,
            simulatePhysics: false,
            includeScripts: false,
            userData: { label: 'Target +25' },
            returnActor: true,
        });
        const mesh = getActorRenderObject(actor);
        if (mesh) mesh.scale.set(0.6, 0.12, 0.6);
        tagGameplayPrefabActor(actor, type, { triggerRadius: 0.75, groundOffset: 1.1, scoreValue: 25 });
        tintGameplayPrefabActor(actor, '#ef4444', '#ef4444', 1.2);
        rebuildActorPhysics(actor);
    }

    if (actor) {
        refreshSceneUI();
        selectShowcaseActor(actor.id);
    }
    return actor;
}

function addGameScore(amount) {
    const value = Number(amount) || 0;
    window.gameScore = (Number(window.gameScore) || 0) + value;
    window.exampleWidgets?.score?.SetText(`Score: ${Math.floor(window.gameScore)}`);
}

function resetGameplayPrefabs() {
    gameplayPrefabState.teleporterCooldownUntil = 0;
    window.gameScore = 0;
    window.exampleWidgets?.score?.SetText('Score: 0');

    getGameplayPrefabActors().forEach((actor) => {
        actor.userData.collected = false;
        actor.userData.hitCooldownUntil = 0;
        const mesh = getActorRenderObject(actor);
        if (mesh) mesh.visible = actor.userData.gameplayPrefab !== 'playerSpawn' || !gameplay.active;
    });

    syncGameplaySpawnFromPlayerSpawnActor();
}

function setActorResetTransform(actor, position, quaternion = null) {
    if (!actor || !Array.isArray(position)) return actor;
    actor.userData = {
        ...(actor.userData || {}),
        resetTransform: {
            position: [...position],
            quaternion: quaternion
                ? [quaternion.x, quaternion.y, quaternion.z, quaternion.w]
                : null,
        },
    };
    return actor;
}

function syncActorBodyToRenderTransform(actor, activation = null) {
    const mesh = getActorRenderObject(actor);
    const body = getActorBody(actor);
    if (!mesh || !body || !physics.ready) return false;

    const pos = new physics.Jolt.RVec3(mesh.position.x, mesh.position.y, mesh.position.z);
    const rot = new physics.Jolt.Quat(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w);
    physics.bodyInterface.SetPositionAndRotation(
        body.GetID(),
        pos,
        rot,
        activation ?? physics.Jolt.EActivation_DontActivate
    );
    physics.Jolt.destroy(pos);
    physics.Jolt.destroy(rot);
    return true;
}

function resetActorToStoredTransform(actor) {
    const reset = actor?.userData?.resetTransform;
    const mesh = getActorRenderObject(actor);
    if (!reset || !mesh) return false;

    mesh.position.fromArray(reset.position);
    if (Array.isArray(reset.quaternion)) {
        mesh.quaternion.fromArray(reset.quaternion);
    }
    mesh.visible = actor.userData?.gameplayPrefab !== 'playerSpawn' || !gameplay.active;
    mesh.updateMatrixWorld(true);

    const body = getActorBody(actor);
    if (body && physics.ready) {
        syncActorBodyToRenderTransform(actor, physics.Jolt.EActivation_Activate);
        if (physics.dynamicBodies.includes(actor)) {
            physics.bodyInterface.SetLinearVelocity(body.GetID(), physics.Jolt.Vec3.prototype.sZero());
            physics.bodyInterface.SetAngularVelocity(body.GetID(), physics.Jolt.Vec3.prototype.sZero());
            dynamicBodySpatial.updateEntry(actor);
        }
    }
    return true;
}

function resetSoccerLevelState() {
    if (currentMesh?.userData?.sampleType !== 'soccerTargetField') return false;

    soccerGoalieState.elapsed = 0;
    resetGameplayPrefabs();
    for (const actor of Array.from(sceneSystem?.actors || [])) {
        resetActorToStoredTransform(actor);
    }
    updateSoccerGoalies(0);
    syncGameplaySpawnFromPlayerSpawnActor();
    return true;
}

function updateSoccerGoalies(delta = 0) {
    if (currentMesh?.userData?.sampleType !== 'soccerTargetField') return;

    const goalies = getSoccerGoalieActors();
    if (!goalies.length) return;

    soccerGoalieState.elapsed = Math.max(0, soccerGoalieState.elapsed + Math.max(0, delta));
    const activation = gameplay.active && physics.ready
        ? physics.Jolt.EActivation_Activate
        : physics?.Jolt?.EActivation_DontActivate;

    for (const actor of goalies) {
        const mesh = getActorRenderObject(actor);
        const motion = actor?.userData?.soccerGoalieMotion;
        if (!mesh || !Array.isArray(motion?.homePosition) || motion.homePosition.length !== 3) continue;

        const axis = Array.isArray(motion.axis) && motion.axis.length === 3 ? motion.axis : [1, 0, 0];
        const amplitude = Number.isFinite(motion.amplitude) ? motion.amplitude : 0;
        const speed = Number.isFinite(motion.speed) ? motion.speed : 1;
        const phase = Number.isFinite(motion.phase) ? motion.phase : 0;
        const offset = Math.sin(soccerGoalieState.elapsed * speed + phase) * amplitude;

        mesh.position.set(
            motion.homePosition[0] + axis[0] * offset,
            motion.homePosition[1] + axis[1] * offset,
            motion.homePosition[2] + axis[2] * offset
        );
        mesh.updateMatrixWorld(true);
        syncActorBodyToRenderTransform(actor, activation);
    }
}

function syncGameplayPrefabVisibility() {
    for (const actor of getGameplayPrefabActors('playerSpawn')) {
        const mesh = getActorRenderObject(actor);
        if (mesh) mesh.visible = !gameplay.active;
    }
}

function teleportActiveGameplaySubject(destination) {
    if (!destination) return false;
    if (isDrivingVehicle()) {
        const vehicle = getActiveVehicleProp();
        const body = getActorBody(vehicle);
        if (!vehicle || !body || !physics.ready) return false;
        const pos = new physics.Jolt.RVec3(destination.x, destination.y + 0.75, destination.z);
        const rot = physics.bodyInterface.GetRotation(body.GetID());
        physics.bodyInterface.SetPositionAndRotation(body.GetID(), pos, rot, physics.Jolt.EActivation_Activate);
        physics.bodyInterface.SetLinearVelocity(body.GetID(), physics.Jolt.Vec3.prototype.sZero());
        physics.bodyInterface.SetAngularVelocity(body.GetID(), physics.Jolt.Vec3.prototype.sZero());
        physics.Jolt.destroy(pos);
        const mesh = getActorRenderObject(vehicle);
        if (mesh) mesh.position.set(destination.x, destination.y + 0.75, destination.z);
        return true;
    }

    if (!physics.character) return false;
    const pos = new physics.Jolt.RVec3(destination.x, destination.y + PLAYER_SETTINGS.floorOffset, destination.z);
    physics.character.SetPosition(pos);
    physics.character.SetLinearVelocity(physics.Jolt.Vec3.prototype.sZero());
    physics.Jolt.destroy(pos);
    syncCameraToCharacter();
    return true;
}

function teleportActorTo(actor, destination) {
    if (!actor || !destination || actor.userData?.gameplayPrefab) return false;
    const mesh = getActorRenderObject(actor);
    if (!mesh) return false;

    mesh.position.set(destination.x, destination.y + 0.75, destination.z);
    mesh.updateMatrixWorld(true);

    const body = getActorBody(actor);
    if (body && physics.ready) {
        const pos = new physics.Jolt.RVec3(mesh.position.x, mesh.position.y, mesh.position.z);
        const rot = new physics.Jolt.Quat(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w);
        physics.bodyInterface.SetPositionAndRotation(body.GetID(), pos, rot, physics.Jolt.EActivation_Activate);
        physics.bodyInterface.SetLinearVelocity(body.GetID(), physics.Jolt.Vec3.prototype.sZero());
        physics.bodyInterface.SetAngularVelocity(body.GetID(), physics.Jolt.Vec3.prototype.sZero());
        physics.Jolt.destroy(pos);
        physics.Jolt.destroy(rot);
        dynamicBodySpatial.updateEntry(actor);
    }

    return true;
}

function getGameplaySubjectPosition(target = tempVectorA) {
    if (isDrivingVehicle()) {
        const vehicle = getActiveVehicleProp();
        const body = getActorBody(vehicle);
        if (!body || !physics.ready) return null;
        return copyJoltVector(target, physics.bodyInterface.GetPosition(body.GetID()));
    }
    if (!physics.character) return null;
    return copyJoltVector(target, physics.character.GetPosition());
}

function isSubjectInsideTrigger(subjectPosition, actor) {
    const mesh = getActorRenderObject(actor);
    if (!mesh || actor?.userData?.collected) return false;
    mesh.updateMatrixWorld(true);
    mesh.getWorldPosition(tempVectorB);
    const radius = Number(actor.userData?.triggerRadius ?? mesh.userData?.triggerRadius ?? 1.2);
    const dx = subjectPosition.x - tempVectorB.x;
    const dz = subjectPosition.z - tempVectorB.z;
    const dy = Math.abs(subjectPosition.y - tempVectorB.y);
    return dx * dx + dz * dz <= radius * radius && dy <= 2.25;
}

function processGameplayPrefabs() {
    if (!gameplay.active) return;
    const subjectPosition = getGameplaySubjectPosition(tempVectorC);
    if (!subjectPosition) return;

    for (const coin of getGameplayPrefabActors('coin')) {
        if (!isSubjectInsideTrigger(subjectPosition, coin)) continue;
        coin.userData.collected = true;
        const mesh = getActorRenderObject(coin);
        if (mesh) mesh.visible = false;
        addGameScore(coin.userData.scoreValue ?? 10);
    }

    const now = performance.now?.() || Date.now();
    for (const target of getGameplayPrefabActors('target')) {
        if ((target.userData.hitCooldownUntil || 0) > now) continue;
        const targetMesh = getActorRenderObject(target);
        if (!targetMesh?.visible) continue;
        targetMesh.getWorldPosition(tempVectorA);
        const radius = Number(target.userData?.triggerRadius ?? 1.55);

        for (const actor of Array.from(physics.dynamicBodies || [])) {
            if (!actor || actor.userData?.gameplayPrefab) continue;
            const body = getActorBody(actor);
            const mesh = getActorRenderObject(actor);
            if (!body || !mesh?.visible || !physics.ready) continue;

            mesh.getWorldPosition(tempVectorC);
            const dx = tempVectorC.x - tempVectorA.x;
            const dz = tempVectorC.z - tempVectorA.z;
            const dy = Math.abs(tempVectorC.y - tempVectorA.y);
            if (dx * dx + dz * dz <= radius * radius && dy <= 2.6) {
                addGameScore(target.userData.scoreValue ?? 25);
                target.userData.hitCooldownUntil = now + 650;
                break;
            }
        }
    }

    if (now < gameplayPrefabState.teleporterCooldownUntil) return;

    const teleporters = getGameplayPrefabActors('teleporter')
        .filter((actor) => getActorRenderObject(actor)?.visible !== false);
    const sourceIndex = teleporters.findIndex((actor) => isSubjectInsideTrigger(subjectPosition, actor));
    if (sourceIndex < 0) return;

    const destinationActor = teleporters.length > 1
        ? teleporters[(sourceIndex + 1) % teleporters.length]
        : getGameplayPrefabActors('playerSpawn')[0];
    const destinationMesh = getActorRenderObject(destinationActor);
    const destination = destinationMesh
        ? destinationMesh.getWorldPosition(new THREE.Vector3())
        : gameplay.spawnPoint.clone();
    teleportActiveGameplaySubject(destination);

    const sourceMesh = getActorRenderObject(teleporters[sourceIndex]);
    const sourcePosition = sourceMesh?.getWorldPosition(new THREE.Vector3());
    const sourceRadius = Number(teleporters[sourceIndex]?.userData?.triggerRadius ?? 1.45);
    if (sourcePosition) {
        for (const actor of Array.from(sceneSystem?.actors || [])) {
            if (!actor || actor === teleporters[sourceIndex] || actor === destinationActor) continue;
            const mesh = getActorRenderObject(actor);
            if (!mesh?.visible) continue;
            mesh.getWorldPosition(tempVectorA);
            const dx = tempVectorA.x - sourcePosition.x;
            const dz = tempVectorA.z - sourcePosition.z;
            const dy = Math.abs(tempVectorA.y - sourcePosition.y);
            if (dx * dx + dz * dz <= sourceRadius * sourceRadius && dy <= 2.5) {
                teleportActorTo(actor, destination);
            }
        }
    }
    gameplayPrefabState.teleporterCooldownUntil = now + 900;
}

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

function syncShowcaseAnglesFromTarget(target) {
    syncShowcaseAnglesToFaceTarget(target);
}

function syncShowcaseAnglesToFaceTarget(target) {
    tempVectorA.copy(target).sub(camera.position);
    const flatDistance = Math.max(0.001, Math.hypot(tempVectorA.x, tempVectorA.z));
    showcase.yaw = Math.atan2(-tempVectorA.x, -tempVectorA.z);
    showcase.pitch = THREE.MathUtils.clamp(
        Math.atan2(tempVectorA.y, flatDistance),
        -PLAYER_SETTINGS.maxLookPitch,
        PLAYER_SETTINGS.maxLookPitch
    );
}

function applyShowcaseCameraRotation() {
    camera.rotation.order = 'YXZ';
    camera.rotation.x = showcase.pitch;
    camera.rotation.y = showcase.yaw;
    camera.rotation.z = 0;
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

function createDefaultObjectEventState(eventName) {
    return {
        source: '',
        compiled: null,
        error: '',
        enabled: false,
        running: false,
        eventName,
        // UE lifecycle bookkeeping — populated lazily on first run.
        handles: null,
        beganPlay: false,
    };
}

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

function createObjectScriptState(propId = '') {
    return {
        propId,
        tick: createDefaultObjectEventState('tick'),
        collision: createDefaultObjectEventState('collision'),
        activeCollisions: new Set(),
    };
}

function sanitizeObjectScriptDrafts(rawValue) {
    if (!rawValue || typeof rawValue !== 'object') {
        return {};
    }

    const drafts = {};

    Object.entries(rawValue).forEach(([propId, value]) => {
        if (!value || typeof value !== 'object') return;

        drafts[propId] = {
            tick: typeof value.tick === 'string' ? value.tick : '',
            tickEnabled: value.tickEnabled === true,
            collision: typeof value.collision === 'string' ? value.collision : '',
        };
    });

    return drafts;
}

function readObjectScriptDrafts() {
    try {
        const rawValue = window.localStorage.getItem(OBJECT_SCRIPT_STORAGE_KEY);
        if (!rawValue) return {};

        return sanitizeObjectScriptDrafts(JSON.parse(rawValue));
    } catch (error) {
        console.warn('Failed to load object script drafts.', error);
        return {};
    }
}

function saveObjectScriptDrafts() {
    try {
        window.localStorage.setItem(OBJECT_SCRIPT_STORAGE_KEY, JSON.stringify(objectScriptState.drafts));
    } catch (error) {
        console.warn('Failed to save object script drafts.', error);
    }
}

function ensureObjectScriptDraftEntry(propId) {
    if (!propId) {
        return { tick: '', tickEnabled: false, collision: '' };
    }

    if (!objectScriptState.drafts[propId]) {
        objectScriptState.drafts[propId] = {
            tick: '',
            tickEnabled: false,
            collision: '',
        };
    }

    return objectScriptState.drafts[propId];
}

function syncRuntimePropIdCounter(propId) {
    if (typeof propId !== 'string') return;

    const match = /^prop-(\d+)$/.exec(propId);
    if (!match) return;

    const nextId = Number.parseInt(match[1], 10) + 1;
    if (Number.isFinite(nextId)) {
        objectScriptState.nextPropId = Math.max(objectScriptState.nextPropId, nextId);
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

function rebuildActorPhysics(prop) {
    if (!prop || !getActorRenderObject(prop) || !physics.ready) return;
    
    const { Jolt, bodyInterface } = physics;
    const componentFlags = getActorComponentFlags(prop);
    const currentBody = getActorBody(prop);
    const bodyID = currentBody?.GetID();
    const dynamicIndex = physics.dynamicBodies.indexOf(prop);
    const staticIndex = physics.staticBodies.indexOf(prop);
    
    if (bodyID) {
        bodyInterface.RemoveBody(bodyID);
        bodyInterface.DestroyBody(bodyID);
    }
    prop.body = null;
    const physicsBodyComponent = getPhysicsBodyComponent(prop);
    if (physicsBodyComponent) {
        physicsBodyComponent.body = null;
    }
    if (dynamicIndex >= 0) {
        physics.dynamicBodies.splice(dynamicIndex, 1);
        dynamicBodySpatial.remove(prop);
    }
    if (staticIndex >= 0) physics.staticBodies.splice(staticIndex, 1);

    if (!componentFlags.collision) {
        return;
    }
    
    const importedTemplate = prop.kind === 'imported'
        ? importedPropState.templates.find((entry) => entry.id === prop.templateId)
        : null;
    const useExactMeshCollision = importedTemplate?.collisionMode === 'complex';

    let bodyOptions = {
        rotation: getActorRenderObject(prop).quaternion,
        mass: prop.userData?.physicsMass,
        friction: prop.userData?.physicsFriction ?? prop.userData?.friction ?? 0.5,
        restitution: prop.userData?.physicsRestitution ?? prop.userData?.restitution ?? 0.3,
        allowedDOFs: prop.userData?.allowedDOFs,
        kinematic: prop.userData?.kinematic,
        simulatePhysics: useExactMeshCollision ? false : componentFlags.physics,
        activate: true
    };
    
    const rootMesh = getActorRenderObject(prop);
    rootMesh.updateMatrixWorld(true);

    if (useExactMeshCollision) {
        const newBody = createStaticMeshBody(rootMesh, bodyOptions);
        prop.body = newBody;
        if (physicsBodyComponent) physicsBodyComponent.body = newBody;
        setActorComponentFlags(prop, {
            ...componentFlags,
            collision: !!newBody,
            physics: false,
        });
        if (newBody) physics.staticBodies.push(prop);
        if (actorPhysicsEditorState.previewActorId === prop.id) refreshActorPhysicsPreview();
        return;
    }

    const subShapes = [];
    const compoundSettings = new Jolt.MutableCompoundShapeSettings();
    let hasCompound = false;
    let hasExplicitCollisionShapes = false;
    rootMesh.traverse((node) => {
        if (node.userData?.isCollisionShape) hasExplicitCollisionShapes = true;
    });

    // A helper to traverse and collect collision shapes
    function traverseAndBuildShapes(node, isRoot) {
        const isCollisionShape = !!node.userData?.isCollisionShape;
        if (!node.visible && !isCollisionShape) return; // Skip hidden visual components
        if (hasExplicitCollisionShapes && !isCollisionShape) {
            for (const child of node.children) {
                traverseAndBuildShapes(child, false);
            }
            return;
        }
        
        // Handle only meshes
        if (node.isMesh) {
            let shapeSetting = null;
            const geo = node.geometry;
            const scale = node.scale;
            
            // For primitive meshes created via UI
            if (geo?.type === 'SphereGeometry') {
                shapeSetting = new Jolt.SphereShapeSettings(scale.x);
            } else if (geo?.type === 'BoxGeometry') {
                const halfExtents = new Jolt.Vec3(scale.x, scale.y, scale.z);
                shapeSetting = new Jolt.BoxShapeSettings(halfExtents, 0.05);
                Jolt.destroy(halfExtents);
            } else if (geo?.type === 'CylinderGeometry') {
                const halfExtents = new Jolt.Vec3(scale.x, scale.y, scale.z);
                shapeSetting = new Jolt.BoxShapeSettings(halfExtents, 0.05);
                Jolt.destroy(halfExtents);
            } else if (geo?.type === 'CapsuleGeometry') {
                shapeSetting = new Jolt.CapsuleShapeSettings(scale.y, scale.x);
            } else if (isRoot && prop.kind === 'sphere') {
                shapeSetting = new Jolt.SphereShapeSettings(scale.x);
            } else if (isRoot && prop.kind === 'cube') {
                const halfExtents = new Jolt.Vec3(scale.x, scale.y, scale.z);
                shapeSetting = new Jolt.BoxShapeSettings(halfExtents, 0.05);
                Jolt.destroy(halfExtents);
            } else if (isRoot && prop.kind === 'cylinder') {
                const halfExtents = new Jolt.Vec3(scale.x, scale.y, scale.z);
                shapeSetting = new Jolt.BoxShapeSettings(halfExtents, 0.05);
                Jolt.destroy(halfExtents);
            } else if (isRoot && prop.kind === 'capsule') {
                shapeSetting = new Jolt.CapsuleShapeSettings(scale.y, scale.x);
            } else if (!isRoot) {
                // Treat imported nested child geometries as boxes for simplicity if type is unknown
                const bbox = new THREE.Box3().setFromObject(node, true);
                if (!bbox.isEmpty()) {
                    const size = new THREE.Vector3();
                    bbox.getSize(size);
                    const halfExtents = new Jolt.Vec3(Math.max(size.x/2, 0.05), Math.max(size.y/2, 0.05), Math.max(size.z/2, 0.05));
                    shapeSetting = new Jolt.BoxShapeSettings(halfExtents, 0.05);
                    Jolt.destroy(halfExtents);
                }
            }
            
            if (shapeSetting) {
                const subShape = createOwnedShape(shapeSetting);
                subShapes.push(subShape);
                
                // Calculate relative position/rotation to the root
                const pos = isRoot
                    ? new Jolt.Vec3(0, 0, 0)
                    : new Jolt.Vec3(node.position.x, node.position.y, node.position.z);
                const rot = isRoot
                    ? new Jolt.Quat(0, 0, 0, 1)
                    : new Jolt.Quat(node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w);
                
                compoundSettings.AddShapeShape(pos, rot, subShape, 0);
                Jolt.destroy(pos);
                Jolt.destroy(rot);
                hasCompound = true;
            }
        }
        
        for (const child of node.children) {
            traverseAndBuildShapes(child, false);
        }
    }
    
    traverseAndBuildShapes(rootMesh, true);
    
    let finalShape = null;
    
    if (hasCompound) {
        if (subShapes.length === 1 && rootMesh.children.length === 0) {
            // Optimization: if it's just the root shape and no children, use it directly
            finalShape = subShapes[0];
            Jolt.destroy(compoundSettings); // We don't need the compound wrapper
        } else {
            // We have multiple components or child transforms
            finalShape = createOwnedShape(compoundSettings);
        }
    } else {
        Jolt.destroy(compoundSettings);
    }
    
    if (finalShape) {
        const newBody = createDynamicPrimitiveBody(finalShape, rootMesh.position, null, bodyOptions);
        prop.body = newBody;
        if (physicsBodyComponent) physicsBodyComponent.body = newBody;
        setActorComponentFlags(prop, {
            ...componentFlags,
            collision: !!newBody,
            physics: !!newBody && componentFlags.physics,
        });
        if (newBody) {
            if (componentFlags.physics) {
                physics.dynamicBodies.push(prop);
                dynamicBodySpatial.updateEntry(prop);
            } else {
                physics.staticBodies.push(prop);
            }
        }
    }
    if (actorPhysicsEditorState.previewActorId === prop.id) refreshActorPhysicsPreview();
}

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
    if (kind === 'cylinder') {
        return new THREE.Mesh(
            new THREE.CylinderGeometry(1, 1, 2, 32, 1, false),
            new THREE.MeshStandardMaterial({
                color: 0x94a3b8,
                metalness: 0.1,
                roughness: 0.46,
                emissive: 0x0f172a,
                emissiveIntensity: 0.16,
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

function syncActorEditorTemplateOptions(selectedTemplateId = '', selectedVehicleBodyTemplateId = '', selectedVehicleWheelTemplateId = '') {
    if (actorImportedTemplateSelect) {
        actorImportedTemplateSelect.innerHTML = '';

        if (!importedPropState.templates.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No imported source available';
            actorImportedTemplateSelect.appendChild(option);
            actorImportedTemplateSelect.value = '';
        } else {
            importedPropState.templates.forEach((template) => {
                const option = document.createElement('option');
                option.value = template.id;
                option.textContent = `${template.displayName} (${template.collisionMode})`;
                actorImportedTemplateSelect.appendChild(option);
            });

            actorImportedTemplateSelect.value = selectedTemplateId && importedPropState.templates.some((template) => template.id === selectedTemplateId)
                ? selectedTemplateId
                : importedPropState.templates[0].id;
        }
    }

    const populateVehicleSelect = (select, selectedId, defaultLabel) => {
        if (!select) return;
        select.innerHTML = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = defaultLabel;
        select.appendChild(defaultOption);
        importedPropState.templates.forEach((template) => {
            const option = document.createElement('option');
            option.value = template.id;
            option.textContent = template.displayName;
            select.appendChild(option);
        });
        const customOption = document.createElement('option');
        customOption.value = VEHICLE_CUSTOM_IMPORT_VALUE;
        customOption.textContent = 'Custom… (import file)';
        select.appendChild(customOption);
        select.value = selectedId && importedPropState.templates.some((template) => template.id === selectedId)
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

    if (isImported && !importedPropState.templates.length) {
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

function configurePointLightShadow(light, {
    mapSize = 512,
    bias = 0.0005,
    normalBias = 0.02,
    radius = 2.5,
} = {}) {
    if (!light?.isPointLight || !light.shadow) return light;
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

    const actor = createActor({
        mesh,
        kind: 'ddgiVolume',
        userData: { internalSample: true, label: 'DDGI Test Volume' },
        name: 'DDGI Test Volume',
    });
    if (!actor.hasComponent(TransformComponent)) {
        actor.addComponent(new TransformComponent());
    }
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const ddgi = new DDGIVolumeComponent({
        gridDims,
        cellSize,
        // Cranked high enough to push GI past the engine's bloom threshold
        // (0.48) so coloured bounce visibly fills shadowed regions of the
        // Cornell box. Below this value the patcher's emissiveNode write
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

    const actor = createActor({
        mesh: rig,
        kind: 'cornellBox',
        userData: { internalSample: true, label: 'Cornell Box', ddgiSampleRig: true },
        name: 'Cornell Box',
    });
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

function ensureRaycastDebugLine() {
    if (raycastDebugState.helper || !scene) return raycastDebugState.helper;

    const helper = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, -1),
        new THREE.Vector3(),
        1,
        0xef4444,
        0.35,
        0.18,
    );
    helper.name = 'raycast-debug-line';
    helper.renderOrder = 999;
    helper.line.renderOrder = 999;
    helper.cone.renderOrder = 999;
    helper.line.material.depthTest = false;
    helper.line.material.transparent = true;
    helper.line.material.opacity = 0.95;
    helper.line.material.toneMapped = false;
    helper.cone.material.depthTest = false;
    helper.cone.material.transparent = true;
    helper.cone.material.opacity = 0.95;
    helper.cone.material.toneMapped = false;
    helper.visible = false;
    markDDGISkipCapture(helper);
    scene.add(helper);

    const hitMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 14, 10),
        new THREE.MeshBasicMaterial({
            color: 0xef4444,
            transparent: true,
            opacity: 0.95,
            depthTest: false,
            toneMapped: false,
        })
    );
    hitMarker.name = 'raycast-debug-hit';
    hitMarker.renderOrder = 1000;
    hitMarker.visible = false;
    markDDGISkipCapture(hitMarker);
    scene.add(hitMarker);

    raycastDebugState.helper = helper;
    raycastDebugState.hitMarker = hitMarker;
    return helper;
}

function updateRaycastDebugLine(origin, direction, maxDist, hitPoint = null, hit = false) {
    if (!raycastDebugState.enabled) {
        return;
    }

    const helper = ensureRaycastDebugLine();
    const distance = Number.isFinite(maxDist) && maxDist > 0 ? maxDist : 0;
    const dx = Number(direction?.x);
    const dy = Number(direction?.y);
    const dz = Number(direction?.z);

    if (!helper || !Number.isFinite(distance) || ![dx, dy, dz].every(Number.isFinite)) {
        return;
    }

    raycastDebugState.points[0].set(
        Number(origin?.x) || 0,
        Number(origin?.y) || 0,
        Number(origin?.z) || 0,
    );

    if (hitPoint && Number.isFinite(hitPoint.x) && Number.isFinite(hitPoint.y) && Number.isFinite(hitPoint.z)) {
        raycastDebugState.points[1].set(hitPoint.x, hitPoint.y, hitPoint.z);
    } else {
        raycastDebugState.points[1].set(
            raycastDebugState.points[0].x + dx * distance,
            raycastDebugState.points[0].y + dy * distance,
            raycastDebugState.points[0].z + dz * distance,
        );
    }

    tempVectorC.subVectors(raycastDebugState.points[1], raycastDebugState.points[0]);
    const length = tempVectorC.length();
    if (length <= 1e-5) {
        helper.visible = false;
        if (raycastDebugState.hitMarker) {
            raycastDebugState.hitMarker.visible = false;
        }
        return;
    }

    const visibleLength = Math.max(length, 1.25);
    helper.position.copy(raycastDebugState.points[0]);
    helper.setDirection(tempVectorC.normalize());
    helper.setLength(
        visibleLength,
        Math.min(Math.max(visibleLength * 0.14, 0.25), 0.9),
        Math.min(Math.max(visibleLength * 0.07, 0.12), 0.38),
    );
    helper.setColor(hit ? 0x22c55e : 0xef4444);
    helper.visible = true;

    if (raycastDebugState.hitMarker) {
        raycastDebugState.hitMarker.position.copy(raycastDebugState.points[1]);
        raycastDebugState.hitMarker.material.color.set(hit ? 0x22c55e : 0xef4444);
        raycastDebugState.hitMarker.visible = true;
    }
    raycastDebugState.expiresAt = performance.now() + raycastDebugState.timeoutMs;
}

function updateRaycasterDebugLine(ray, maxDist, hitPoint = null, hit = false) {
    if (!ray) return;
    updateRaycastDebugLine(ray.origin, ray.direction, maxDist, hitPoint, hit);
}

function tickRaycastDebugLine() {
    if (!raycastDebugState.helper?.visible) return;
    if (performance.now() < raycastDebugState.expiresAt) return;
    raycastDebugState.helper.visible = false;
    if (raycastDebugState.hitMarker) {
        raycastDebugState.hitMarker.visible = false;
    }
}

function createCollisionLineSegments(geometry, color) {
    const edges = new THREE.EdgesGeometry(geometry, 30);
    const lines = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({
            color,
            depthTest: false,
            transparent: true,
            opacity: 0.9,
            toneMapped: false,
        })
    );
    lines.renderOrder = 995;
    return lines;
}

function createCollisionOverlayFromObject(sourceRoot, color, { includeMesh = () => true } = {}) {
    if (!sourceRoot) return null;

    const overlayRoot = sourceRoot.isMesh && sourceRoot.geometry && includeMesh(sourceRoot)
        ? createCollisionLineSegments(sourceRoot.geometry, color)
        : new THREE.Group();
    const sourceMap = new Map([[sourceRoot, overlayRoot]]);

    sourceRoot.traverse((source) => {
        const overlayParent = sourceMap.get(source);
        if (!overlayParent) return;

        source.children.forEach((child) => {
            let overlayChild;
            if (child.isMesh && child.geometry && includeMesh(child)) {
                overlayChild = createCollisionLineSegments(child.geometry, color);
            } else {
                overlayChild = new THREE.Group();
            }

            overlayChild.position.copy(child.position);
            overlayChild.quaternion.copy(child.quaternion);
            overlayChild.scale.copy(child.scale);
            overlayParent.add(overlayChild);
            sourceMap.set(child, overlayChild);
        });
    });

    return overlayRoot;
}

function buildWorldCollisionOverlay() {
    if (!currentMesh) return null;

    let colliderCount = 0;
    const overlay = createCollisionOverlayFromObject(currentMesh, 0x38bdf8, {
        includeMesh: (mesh) => {
            const include = !mesh.userData?.skipPhysicsCollision;
            if (include) colliderCount++;
            return include;
        },
    });

    if (!overlay || colliderCount === 0) return null;
    overlay.name = 'world-collision-debug-overlay';
    return overlay;
}

function createImportedSimpleCollisionOverlay(template, color) {
    if (!template?.root) return null;

    template.root.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(template.root);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const lines = createCollisionLineSegments(
        new THREE.BoxGeometry(
            Math.max(size.x, 0.16),
            Math.max(size.y, 0.16),
            Math.max(size.z, 0.16),
        ),
        color,
    );
    lines.position.copy(center);
    return lines;
}

function buildActorCollisionOverlay(actor) {
    const flags = getActorComponentFlags(actor);
    if (!flags.collision) return null;

    const actorMesh = getActorRenderObject(actor);
    if (!actorMesh) return null;

    const color = flags.physics ? 0x22c55e : 0xf59e0b;

    if (actor.kind === 'vehicle') {
        const bounds = getVehicleVisualBounds(actorMesh);
        const lines = createCollisionLineSegments(
            new THREE.BoxGeometry(
                Math.max(bounds.size.x, 0.16),
                Math.max(bounds.size.y, 0.16),
                Math.max(bounds.size.z, 0.16),
            ),
            color
        );
        lines.position.copy(bounds.center);
        return lines;
    }

    if (actor.kind === 'imported') {
        const template = importedPropState.templates.find((entry) => entry.id === actor.templateId);
        if (template?.collisionMode === 'simple') {
            return createImportedSimpleCollisionOverlay(template, color);
        }
        return createCollisionOverlayFromObject(actorMesh, color);
    }

    return createCollisionOverlayFromObject(actorMesh, color);
}

function disposeCollisionOverlayObject(object) {
    if (!object) return;
    object.traverse((child) => {
        if (child.geometry) {
            child.geometry.dispose?.();
        }
        const material = child.material;
        if (Array.isArray(material)) {
            material.forEach((entry) => entry?.dispose?.());
        } else {
            material?.dispose?.();
        }
    });
}

function clearCollisionDebugOverlays() {
    collisionDebugState.overlays.forEach((overlay) => {
        overlay.parent?.remove(overlay);
        disposeCollisionOverlayObject(overlay);
    });
    collisionDebugState.overlays = [];
}

function refreshCollisionDebugOverlays() {
    if (!collisionDebugState.enabled || !scene) {
        clearCollisionDebugOverlays();
        return;
    }

    clearCollisionDebugOverlays();

    const worldOverlay = buildWorldCollisionOverlay();
    if (worldOverlay && currentMesh) {
        currentMesh.add(worldOverlay);
        collisionDebugState.overlays.push(worldOverlay);
    }

    for (const actor of sceneSystem?.actors || []) {
        const actorMesh = getActorRenderObject(actor);
        if (actorMesh && currentMesh && isObjectWithinRoot(actorMesh, currentMesh)) continue;
        const overlay = buildActorCollisionOverlay(actor);
        if (!overlay || !actorMesh) continue;

        overlay.name = 'collision-debug-overlay';
        actorMesh.add(overlay);
        collisionDebugState.overlays.push(overlay);
    }
}

function setCollisionDebugEnabled(isEnabled) {
    collisionDebugState.enabled = !!isEnabled;
    refreshCollisionDebugOverlays();
    pushDebugConsoleLine(`Collision overlay ${collisionDebugState.enabled ? 'enabled' : 'disabled'} (F8).`, 'success');
}

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
    applyWorldEnvState({ persist: false, switchSky: false });
    updatePerfModeUi();
}

// ──────────────────────────────────────────────────────────
//  World Environment panel — Godot-style global graphics inspector
// ──────────────────────────────────────────────────────────

function loadWorldEnvFromStorage() {
    try {
        const raw = localStorage.getItem(WORLD_ENV_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        // Shallow-merge each section so we don't lose newly-added defaults
        // when an older saved blob is read.
        for (const key of Object.keys(WORLD_ENV_DEFAULTS)) {
            if (parsed[key] && typeof parsed[key] === 'object') {
                worldEnvState[key] = { ...WORLD_ENV_DEFAULTS[key], ...parsed[key] };
            }
        }
        // Debug views are session tools. Always boot into lit render.
        worldEnvState.ddgi.debugProbes = false;
        worldEnvState.ddgi.contributionView = false;
        worldEnvState.ddgi.intensity = Math.min(worldEnvState.ddgi.intensity, WORLD_ENV_DEFAULTS.ddgi.intensity);
        worldEnvState.ddgi.liveBake = worldEnvState.ddgi.liveBake !== false;
        worldEnvState.ddgi.bakeEveryN = Math.max(1, Math.min(120,
            worldEnvState.ddgi.bakeEveryN ?? worldEnvState.ddgi.probesPerFrame ?? WORLD_ENV_DEFAULTS.ddgi.bakeEveryN));
        worldEnvState.ddgi.probesPerFrame = worldEnvState.ddgi.bakeEveryN;
    } catch (e) {
        // Corrupt storage — fall back to defaults silently.
    }
}

function saveWorldEnvToStorage() {
    try {
        localStorage.setItem(WORLD_ENV_STORAGE_KEY, JSON.stringify(worldEnvState));
    } catch (e) { /* private mode / quota — ignore */ }
}

function shouldUsePostProcessingPipeline() {
    return !!((worldEnvState.bloom?.enabled && !perfModeEnabled)
        || (worldEnvState.ssgi?.enabled && !perfModeEnabled));
}

function rebuildPostProcessingOutputNode() {
    if (!postProcessing || !postProcessNodes) return;
    const { sceneColor, bloomNode, ssgiOutput } = postProcessNodes;
    if (!shouldUsePostProcessingPipeline()) {
        postProcessing.outputNode = sceneColor;
        return;
    }

    let outputNode = sceneColor;
    if (worldEnvState.bloom?.enabled && !perfModeEnabled) {
        outputNode = outputNode.add(bloomNode);
    }
    if (worldEnvState.ssgi?.enabled && !perfModeEnabled && ssgiOutput) {
        outputNode = sceneColor
            .mul(vec4(vec3(ssgiOutput.a), 1))
            .add(vec4(ssgiOutput.rgb, 0))
            .add(worldEnvState.bloom?.enabled && !perfModeEnabled ? bloomNode : vec4(0, 0, 0, 0));
    }
    postProcessing.outputNode = outputNode;
}

function applySSGISettings() {
    const node = postProcessNodes?.ssgiNode;
    const s = worldEnvState.ssgi || WORLD_ENV_DEFAULTS.ssgi;
    if (!node) return;
    node.giIntensity.value = s.giIntensity;
    node.aoIntensity.value = s.aoIntensity;
    node.radius.value = s.radius;
    node.thickness.value = s.thickness;
    node.sliceCount.value = Math.max(1, Math.min(4, Math.round(s.sliceCount)));
    node.stepCount.value = Math.max(1, Math.min(32, Math.round(s.stepCount)));
}

function applyWorldEnvState({ persist = true, switchSky = true } = {}) {
    const s = worldEnvState;
    const runtimeBloomEnabled = s.bloom.enabled && !perfModeEnabled;
    const runtimeFogEnabled = s.fog.enabled && !perfModeEnabled;
    // fix/ddgi-correctness: decouple DDGI from perf-mode. The original gate
    // (`s.ddgi.enabled && !perfModeEnabled`) meant perfMode forced setEnabled(false)
    // on the DDGI manager via applyWorldEnvState below, which made the bake never
    // run and masked PR #22's correctness fixes. Now DDGI's runtime enabled state
    // tracks ONLY the explicit worldEnvState.ddgi.enabled toggle.
    const runtimeDdgiEnabled = s.ddgi.enabled;

    // Sky / Background
    if (environmentController) {
        environmentController.setEnabled?.(s.sky.enabled);
        environmentController.setBackgroundBlurriness?.(s.sky.blurriness);
        if (switchSky && environmentController.getCurrentEnvironment?.() !== s.sky.preset) {
            environmentController.switchEnvironment?.(s.sky.preset);
        }
    }

    // Ambient + Hemi + Sun — direct property writes since they're THREE lights.
    if (ambientLight) {
        ambientLight.visible = s.ambient.enabled;
        ambientLight.intensity = s.ambient.intensity;
    }
    if (hemiLight) {
        hemiLight.visible = s.hemi.enabled;
        hemiLight.intensity = s.hemi.intensity;
    }
    if (mainDirectionalLight) {
        mainDirectionalLight.visible = s.sun.enabled;
        mainDirectionalLight.castShadow = s.sun.enabled && s.sun.castShadow;
        mainDirectionalLight.intensity = s.sun.intensity;
    }

    // Tonemap exposure — write to renderer immediately AND record as the
    // post-process volume default so the lerp doesn't drag it back.
    if (renderer) {
        renderer.toneMappingExposure = s.tonemap.exposure;
    }
    postProcessVolumeManager?.setDefaultSettings?.({ toneMappingExposure: s.tonemap.exposure });

    // Bloom — when off, postProcessVolumeManager.setEnabled clamps uniforms
    // to neutral. When on, push the user's slider values through both the
    // shader uniforms AND the volume defaults so volume-based grading still works.
    if (runtimeBloomEnabled) {
        postProcessVolumeManager?.setEnabled?.(true);
        if (globalPostProcessUniforms.bloomStrength) globalPostProcessUniforms.bloomStrength.value = s.bloom.strength;
        if (globalPostProcessUniforms.bloomRadius) globalPostProcessUniforms.bloomRadius.value = s.bloom.radius;
        if (globalPostProcessUniforms.bloomThreshold) globalPostProcessUniforms.bloomThreshold.value = s.bloom.threshold;
        postProcessVolumeManager?.setDefaultSettings?.({
            bloomStrength: s.bloom.strength,
            bloomRadius: s.bloom.radius,
            bloomThreshold: s.bloom.threshold,
        });
    } else {
        postProcessVolumeManager?.setEnabled?.(false);
    }

    // Screen Space GI
    applySSGISettings();
    rebuildPostProcessingOutputNode();

    // Fog
    if (volumetricFogController) {
        volumetricFogController.setEnabled?.(runtimeFogEnabled);
        volumetricFogController.setDensity?.(s.fog.density);
        volumetricFogController.setOpacity?.(s.fog.opacity);
    }

    // DDGI
    const ddgi = getDDGIManager();
    ddgi?.setEnabled?.(runtimeDdgiEnabled);
    ddgi?.setInjectionEnabled?.(runtimeDdgiEnabled);
    ddgi?.setLiveBake?.(s.ddgi.liveBake);
    ddgi?.setBakeEveryN?.(s.ddgi.bakeEveryN ?? s.ddgi.probesPerFrame);
    ddgi?.setIntensity?.(s.ddgi.intensity);
    ddgi?.setDebugVisible?.(s.ddgi.debugProbes);
    ddgi?.setContributionViewEnabled?.(runtimeDdgiEnabled && s.ddgi.contributionView);
    ddgi?.setSolidTestEnabled?.(runtimeDdgiEnabled && s.ddgi.solidTest);
    if (cornellPanelLight) cornellPanelLight.intensity = s.ddgi.lightIntensity;

    // Shadows
    if (renderer?.shadowMap) {
        renderer.shadowMap.enabled = s.shadows.enabled;
    }

    if (persist) saveWorldEnvToStorage();
    updateWorldEnvUi();
}

function updateWorldEnvUi() {
    if (!worldEnvUiRefs) return;
    const s = worldEnvState;
    const setToggle = (offBtn, onBtn, on) => {
        offBtn?.classList.toggle('viewer-toggle-btn-active', !on);
        onBtn?.classList.toggle('viewer-toggle-btn-active', on);
    };
    const setSlider = (input, valueEl, value, decimals) => {
        if (input) input.value = value;
        if (valueEl) valueEl.textContent = Number(value).toFixed(decimals);
    };

    setToggle(worldEnvUiRefs.skyOff, worldEnvUiRefs.skyOn, s.sky.enabled);
    if (worldEnvUiRefs.skyPreset) worldEnvUiRefs.skyPreset.value = s.sky.preset;
    setSlider(worldEnvUiRefs.skyBlurriness, worldEnvUiRefs.skyBlurrinessValue, s.sky.blurriness, 2);

    setToggle(worldEnvUiRefs.ambientOff, worldEnvUiRefs.ambientOn, s.ambient.enabled);
    setSlider(worldEnvUiRefs.ambientIntensity, worldEnvUiRefs.ambientIntensityValue, s.ambient.intensity, 2);

    setToggle(worldEnvUiRefs.hemiOff, worldEnvUiRefs.hemiOn, s.hemi.enabled);
    setSlider(worldEnvUiRefs.hemiIntensity, worldEnvUiRefs.hemiIntensityValue, s.hemi.intensity, 2);

    setToggle(worldEnvUiRefs.sunOff, worldEnvUiRefs.sunOn, s.sun.enabled);
    if (worldEnvUiRefs.sunShadow) worldEnvUiRefs.sunShadow.checked = s.sun.castShadow;
    setSlider(worldEnvUiRefs.sunIntensity, worldEnvUiRefs.sunIntensityValue, s.sun.intensity, 2);

    setSlider(worldEnvUiRefs.exposure, worldEnvUiRefs.exposureValue, s.tonemap.exposure, 2);

    setToggle(worldEnvUiRefs.bloomOff, worldEnvUiRefs.bloomOn, s.bloom.enabled);
    setSlider(worldEnvUiRefs.bloomStrength, worldEnvUiRefs.bloomStrengthValue, s.bloom.strength, 2);
    setSlider(worldEnvUiRefs.bloomRadius, worldEnvUiRefs.bloomRadiusValue, s.bloom.radius, 2);
    setSlider(worldEnvUiRefs.bloomThreshold, worldEnvUiRefs.bloomThresholdValue, s.bloom.threshold, 2);

    setToggle(worldEnvUiRefs.ssgiOff, worldEnvUiRefs.ssgiOn, s.ssgi.enabled);

    setToggle(worldEnvUiRefs.fogOff, worldEnvUiRefs.fogOn, s.fog.enabled);
    setSlider(worldEnvUiRefs.fogDensity, worldEnvUiRefs.fogDensityValue, s.fog.density, 3);
    setSlider(worldEnvUiRefs.fogOpacity, worldEnvUiRefs.fogOpacityValue, s.fog.opacity, 3);

    setToggle(worldEnvUiRefs.ddgiOff, worldEnvUiRefs.ddgiOn, s.ddgi.enabled);
    setToggle(worldEnvUiRefs.ddgiLiveBakeOff, worldEnvUiRefs.ddgiLiveBakeOn, s.ddgi.liveBake);
    if (worldEnvUiRefs.ddgiBakeEveryN) worldEnvUiRefs.ddgiBakeEveryN.value = s.ddgi.bakeEveryN;
    if (worldEnvUiRefs.ddgiBakeEveryNValue) worldEnvUiRefs.ddgiBakeEveryNValue.textContent = String(s.ddgi.bakeEveryN);
    setSlider(worldEnvUiRefs.ddgiIntensity, worldEnvUiRefs.ddgiIntensityValue, s.ddgi.intensity, 16);
    setSlider(worldEnvUiRefs.ddgiLightIntensity, worldEnvUiRefs.ddgiLightIntensityValue, s.ddgi.lightIntensity, 2);
    setToggle(worldEnvUiRefs.ddgiProbeDebugOff, worldEnvUiRefs.ddgiProbeDebugOn, s.ddgi.debugProbes);
    setToggle(worldEnvUiRefs.ddgiRayDebugOff, worldEnvUiRefs.ddgiRayDebugOn, s.ddgi.rayDebug);
    setToggle(worldEnvUiRefs.ddgiSolidTestOff, worldEnvUiRefs.ddgiSolidTestOn, s.ddgi.solidTest);
    setToggle(worldEnvUiRefs.ddgiViewLit, worldEnvUiRefs.ddgiViewContribution, s.ddgi.contributionView);

    setToggle(worldEnvUiRefs.shadowsOff, worldEnvUiRefs.shadowsOn, s.shadows.enabled);

    // Summary chip + status text
    if (worldEnvUiRefs.summaryValue) {
        const off = [];
        if (!s.sky.enabled) off.push('Sky');
        if (!s.bloom.enabled) off.push('Bloom');
        if (!s.ssgi.enabled) off.push('SSGI');
        if (!s.fog.enabled) off.push('Fog');
        if (!s.ddgi.enabled) off.push('DDGI');
        if (!s.shadows.enabled) off.push('Shadows');
        worldEnvUiRefs.summaryValue.textContent = off.length ? `Off: ${off.join(' · ')}` : 'All effects active';
    }
    if (worldEnvUiRefs.masterStatus) {
        const allCoreOn = s.sky.enabled && s.ambient.enabled && s.hemi.enabled && s.sun.enabled && s.bloom.enabled && s.ssgi.enabled && s.fog.enabled && s.shadows.enabled;
        const perfPreset = !s.bloom.enabled && !s.ssgi.enabled && !s.fog.enabled && !s.ddgi.enabled && s.sky.enabled && s.sun.enabled;
        const cornellPreset = !s.sky.enabled && !s.ambient.enabled && !s.hemi.enabled && !s.sun.enabled
            && !s.bloom.enabled && !s.ssgi.enabled && !s.fog.enabled && s.shadows.enabled
            && s.ddgi.enabled && Math.abs(s.ddgi.intensity - WORLD_ENV_DEFAULTS.ddgi.intensity) < 0.001;
        if (s.ddgi.enabled && s.ddgi.contributionView) {
            worldEnvUiRefs.masterStatus.textContent = 'DDGI contribution view active.';
        } else if (s.ssgi.enabled && !perfModeEnabled) {
            worldEnvUiRefs.masterStatus.textContent = 'Screen Space GI active.';
        } else if (s.ddgi.enabled && s.ddgi.solidTest) {
            worldEnvUiRefs.masterStatus.textContent = 'Solid DDGI test active. Probes bypassed with fixed amber GI.';
        } else if (s.ddgi.debugProbes) {
            worldEnvUiRefs.masterStatus.textContent = 'DDGI probe debug active.';
        } else if (cornellPreset) {
            worldEnvUiRefs.masterStatus.textContent = 'Cornell test preset active. Sky and sun are off; DDGI bleed is emphasized.';
        } else if (allCoreOn && !s.ddgi.enabled) {
            worldEnvUiRefs.masterStatus.textContent = 'Everything on (DDGI off — opt in for prettier indirect lighting).';
        } else if (allCoreOn && s.ddgi.enabled) {
            worldEnvUiRefs.masterStatus.textContent = 'Everything on, including DDGI + SSGI.';
        } else if (perfPreset) {
            worldEnvUiRefs.masterStatus.textContent = 'Performance preset active. Bloom + SSGI + Fog + DDGI paused.';
        } else {
            worldEnvUiRefs.masterStatus.textContent = 'Custom configuration.';
        }
    }
}

function setWorldEnvMaster(mode) {
    const s = worldEnvState;
    if (mode === 'on') {
        s.sky.enabled = true;
        s.ambient.enabled = true;
        s.hemi.enabled = true;
        s.sun.enabled = true;
        s.bloom.enabled = true;
        s.ssgi.enabled = true;
        s.fog.enabled = true;
        s.shadows.enabled = true;
        // DDGI is opt-in even with All On — too expensive for a default.
    } else if (mode === 'off') {
        s.sky.enabled = false;
        s.ambient.enabled = false;
        s.hemi.enabled = false;
        s.sun.enabled = false;
        s.bloom.enabled = false;
        s.ssgi.enabled = false;
        s.fog.enabled = false;
        s.ddgi.enabled = false;
        s.shadows.enabled = false;
    } else if (mode === 'perf') {
        // Performance preset: only the heavy effects go off.
        s.bloom.enabled = false;
        s.ssgi.enabled = false;
        s.fog.enabled = false;
        s.ddgi.enabled = false;
    } else if (mode === 'cornell') {
        applyCornellTestPreset();
        return;
    }
    applyWorldEnvState();
}

function resetWorldEnvDefaults() {
    worldEnvState = JSON.parse(JSON.stringify(WORLD_ENV_DEFAULTS));
    applyWorldEnvState();
}

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

function resetMobileInputState() {
    resetMovementInputState();
    resetMobileMovePad();
    resetMobileLookPad();
}

function resetMovementInputState() {
    showcase.input.forward = false;
    showcase.input.back = false;
    showcase.input.left = false;
    showcase.input.right = false;
    showcase.input.up = false;
    showcase.input.down = false;
    showcase.input.boost = false;
    gameplay.input.forward = false;
    gameplay.input.back = false;
    gameplay.input.left = false;
    gameplay.input.right = false;
    gameplay.input.sprint = false;
    physics.jumpQueued = false;
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

function focusCurrentShowcaseSelection() {
    if (gameplay.active) return false;

    const actor = getDynamicPropById(objectScriptState.targetPropId);
    if (!actor) return false;

    const focusObject = getActorSelectionObject(actor);
    if (!focusObject) return false;

    focusShowcaseCameraOnObject(focusObject, { duration: 0.55 });
    return true;
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

function buildCollisionBoxComponent() {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshBasicMaterial({
            color: 0x22d3ee,
            transparent: true,
            opacity: 0.16,
            wireframe: true,
            depthTest: false,
        })
    );
    mesh.name = 'Collision Box';
    mesh.renderOrder = 20;
    mesh.userData.isCollisionShape = true;
    mesh.userData.collisionShapeType = 'box';
    mesh.userData.skipMaterialExport = true;
    return mesh;
}

function getActorPhysicsSettings(actor) {
    const userData = actor?.userData ?? {};
    return {
        mass: Number.isFinite(userData.physicsMass) ? userData.physicsMass : 12,
        friction: Number.isFinite(userData.physicsFriction) ? userData.physicsFriction : (Number.isFinite(userData.friction) ? userData.friction : 0.5),
        restitution: Number.isFinite(userData.physicsRestitution) ? userData.physicsRestitution : (Number.isFinite(userData.restitution) ? userData.restitution : 0.3),
    };
}

function clearActorPhysicsPreview() {
    const overlay = actorPhysicsEditorState.previewOverlay;
    if (overlay) {
        overlay.parent?.remove(overlay);
        disposeCollisionOverlayObject(overlay);
    }
    actorPhysicsEditorState.previewOverlay = null;
    actorPhysicsEditorState.previewActorId = '';
}

function refreshActorPhysicsPreview() {
    const actorId = actorPhysicsEditorState.previewActorId;
    if (!actorId) return;

    const actor = getDynamicPropById(actorId);
    const actorMesh = getActorRenderObject(actor);
    const nextOverlay = actor ? buildActorCollisionOverlay(actor) : null;

    if (actorPhysicsEditorState.previewOverlay) {
        actorPhysicsEditorState.previewOverlay.parent?.remove(actorPhysicsEditorState.previewOverlay);
        disposeCollisionOverlayObject(actorPhysicsEditorState.previewOverlay);
        actorPhysicsEditorState.previewOverlay = null;
    }

    if (!actorMesh || !nextOverlay) {
        actorPhysicsEditorState.previewActorId = '';
        return;
    }

    nextOverlay.name = 'actor-physics-preview-overlay';
    actorMesh.add(nextOverlay);
    actorPhysicsEditorState.previewOverlay = nextOverlay;
}

function setActorPhysicsPreview(actor, enabled) {
    clearActorPhysicsPreview();
    if (!enabled || !actor?.id) return;
    actorPhysicsEditorState.previewActorId = actor.id;
    refreshActorPhysicsPreview();
}

function applyActorPhysicsSettings(actor, settings) {
    if (!actor) return;

    const next = {
        physicsMass: THREE.MathUtils.clamp(Number(settings.mass) || 12, 0.01, 100000),
        physicsFriction: THREE.MathUtils.clamp(Number(settings.friction) || 0, 0, 2),
        physicsRestitution: THREE.MathUtils.clamp(Number(settings.restitution) || 0, 0, 1),
    };
    Object.assign(actor.userData, next);
    const mesh = getActorRenderObject(actor);
    if (mesh?.userData) Object.assign(mesh.userData, next);

    if (getActorComponentFlags(actor).collision) {
        rebuildActorPhysics(actor);
    }
    refreshActorPhysicsPreview();
    if (collisionDebugState.enabled) refreshCollisionDebugOverlays();
    refreshSceneUI();
}

function syncBlueprintPhysicsEditor(actor = getDynamicPropById(objectScriptState.targetPropId)) {
    const settings = getActorPhysicsSettings(actor);
    const mass = document.getElementById('bp-physics-mass');
    const friction = document.getElementById('bp-physics-friction');
    const restitution = document.getElementById('bp-physics-restitution');
    if (mass) mass.value = String(settings.mass);
    if (friction) friction.value = String(settings.friction);
    if (restitution) restitution.value = String(settings.restitution);
}

function applyBlueprintPhysicsEditor() {
    const actor = getDynamicPropById(objectScriptState.targetPropId);
    if (!actor) return;
    applyActorPhysicsSettings(actor, {
        mass: parseFloat(document.getElementById('bp-physics-mass')?.value ?? '12'),
        friction: parseFloat(document.getElementById('bp-physics-friction')?.value ?? '0.5'),
        restitution: parseFloat(document.getElementById('bp-physics-restitution')?.value ?? '0.3'),
    });
    refreshBlueprintComponents();
}

function getSceneActorDetailsRefs() {
    return {
        empty: document.getElementById('scene-actor-details-empty'),
        body: document.getElementById('scene-actor-details-body'),
        name: document.getElementById('scene-actor-details-name'),
        type: document.getElementById('scene-actor-details-type'),
        modeTranslate: document.getElementById('scene-actor-mode-translate'),
        modeRotate: document.getElementById('scene-actor-mode-rotate'),
        modeScale: document.getElementById('scene-actor-mode-scale'),
        spaceLocal: document.getElementById('scene-actor-space-local'),
        spaceWorld: document.getElementById('scene-actor-space-world'),
        locX: document.getElementById('scene-actor-loc-x'),
        locY: document.getElementById('scene-actor-loc-y'),
        locZ: document.getElementById('scene-actor-loc-z'),
        rotX: document.getElementById('scene-actor-rot-x'),
        rotY: document.getElementById('scene-actor-rot-y'),
        rotZ: document.getElementById('scene-actor-rot-z'),
        sclX: document.getElementById('scene-actor-scl-x'),
        sclY: document.getElementById('scene-actor-scl-y'),
        sclZ: document.getElementById('scene-actor-scl-z'),
        lightSection: document.getElementById('scene-actor-light-section'),
        lightColor: document.getElementById('scene-actor-light-color'),
        lightIntensity: document.getElementById('scene-actor-light-intensity'),
        lightDistance: document.getElementById('scene-actor-light-distance'),
        lightDecay: document.getElementById('scene-actor-light-decay'),
        lightSpotRow: document.getElementById('scene-actor-light-spot-row'),
        lightAngle: document.getElementById('scene-actor-light-angle'),
        lightPenumbra: document.getElementById('scene-actor-light-penumbra'),
        lightShadow: document.getElementById('scene-actor-light-shadow'),
        lightKind: document.getElementById('scene-actor-light-kind'),
        ddgiSection: document.getElementById('scene-actor-ddgi-section'),
        ddgiDimX: document.getElementById('scene-actor-ddgi-dim-x'),
        ddgiDimY: document.getElementById('scene-actor-ddgi-dim-y'),
        ddgiDimZ: document.getElementById('scene-actor-ddgi-dim-z'),
        ddgiSizeX: document.getElementById('scene-actor-ddgi-size-x'),
        ddgiSizeY: document.getElementById('scene-actor-ddgi-size-y'),
        ddgiSizeZ: document.getElementById('scene-actor-ddgi-size-z'),
        ddgiTotal: document.getElementById('scene-actor-ddgi-total'),
        ddgiCell: document.getElementById('scene-actor-ddgi-cell'),
        ddgiIntensity: document.getElementById('scene-actor-ddgi-intensity'),
        ddgiHysteresis: document.getElementById('scene-actor-ddgi-hysteresis'),
        ddgiNormalBias: document.getElementById('scene-actor-ddgi-normal-bias'),
        ddgiProbesPerFrame: document.getElementById('scene-actor-ddgi-probes-per-frame'),
    };
}

function getSelectedSceneActor() {
    const actorId = objectScriptState.targetPropId;
    return actorId ? getDynamicPropById(actorId) : null;
}

function getActorDDGIVolumeComponent(actor) {
    if (!actor) return null;
    return actor.getComponentByClass?.(DDGIVolumeComponent)
        || actor.GetComponent?.(DDGIVolumeComponent)
        || null;
}

function getActorLightObject(actor) {
    const root = getActorRenderObject(actor);
    if (!root) return null;

    let light = null;
    root.traverse((node) => {
        if (light || (!node?.isPointLight && !node?.isSpotLight)) return;
        light = node;
    });
    return light;
}

function syncActorLightStateFromObject(actor, light) {
    if (!actor || !light) return;

    const previousLightState = actor.userData?.light || {};
    actor.userData = {
        ...(actor.userData || {}),
        light: {
            ...previousLightState,
            kind: actor.kind || previousLightState.kind,
            color: `#${light.color.getHexString()}`,
            intensity: light.intensity,
            distance: light.distance,
            decay: light.decay,
            castShadow: light.castShadow === true,
            ...(light.isSpotLight ? {
                angle: light.angle,
                penumbra: light.penumbra,
            } : {}),
        },
    };
}

function syncActorLightHelperVisuals(actor) {
    const root = getActorRenderObject(actor);
    const light = getActorLightObject(actor);
    if (!root || !light) return;

    const lightState = actor?.userData?.light || {};
    const helperColor = light.color.clone();
    const range = Math.max(light.distance > 0 ? light.distance : ((Number.isFinite(lightState.radius) && lightState.radius > 0) ? lightState.radius * 4 : 12), 0.25);

    root.traverse((node) => {
        if (!node?.material) return;
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        mats.forEach((mat) => {
            if (mat.color) mat.color.copy(helperColor);
            if (mat.emissive) {
                mat.emissive.copy(helperColor);
                mat.emissiveIntensity = Math.max(mat.emissiveIntensity ?? 1, 4.5);
                mat.toneMapped = false;
            }
        });
    });

    const pointRange = root.getObjectByName('point-light-range');
    if (pointRange) {
        pointRange.userData.lightRangeVisual = true;
        pointRange.scale.setScalar(range);
    }

    const spotTarget = root.getObjectByName('spot-light-target');
    const spotVolume = root.getObjectByName('spot-light-volume');
    const spotAim = root.getObjectByName('spot-light-aim');
    if (spotTarget) {
        spotTarget.position.set(0, 0, -Math.max(1.5, range));
        spotTarget.updateMatrixWorld(true);
    }
    if (spotVolume && light.isSpotLight) {
        spotVolume.userData.lightRangeVisual = true;
        const coneRadius = Math.max(0.08, Math.tan(light.angle ?? (Math.PI / 6)) * range);
        spotVolume.scale.set(coneRadius, range, coneRadius);
        spotVolume.position.set(0, 0, -range * 0.5);
    }
    if (spotAim?.geometry?.attributes?.position) {
        spotAim.userData.lightRangeVisual = true;
        const positions = spotAim.geometry.attributes.position.array;
        positions[0] = 0;
        positions[1] = 0;
        positions[2] = 0;
        positions[3] = 0;
        positions[4] = 0;
        positions[5] = -Math.max(1.5, range);
        spotAim.geometry.attributes.position.needsUpdate = true;
        spotAim.geometry.computeBoundingSphere?.();
    }

    root.traverse((node) => {
        if (node?.userData?.lightRangeVisual) {
            node.visible = actor?.id === objectScriptState.targetPropId;
        }
    });

    light.target?.updateMatrixWorld?.(true);
}

function updateLightRangeVisualVisibility() {
    if (!sceneSystem?.actors) return;
    for (const actor of sceneSystem.actors) {
        const root = getActorRenderObject(actor);
        if (!root) continue;
        const visible = actor.id === objectScriptState.targetPropId;
        root.traverse((node) => {
            if (node?.userData?.lightRangeVisual) {
                node.visible = visible;
            }
        });
    }
}

function syncDDGIVolumeComponentToActorBounds(ddgi) {
    if (!ddgi) return;
    ddgi.syncCellSizeToOwnerBounds?.();
    ddgi.probesPerFrame = Math.max(1, Math.min(120, ddgi.probesPerFrame | 0));
    ddgi.bakeEveryN = ddgi.probesPerFrame;
    try {
        getDDGIManager().registerVolume(ddgi);
    } catch {
        // DDGI manager can be unavailable during early init or teardown.
    }
}

function updateSceneActorDetailsTransformButtons(refs = getSceneActorDetailsRefs()) {
    const mode = transformControl?.getMode?.() || 'translate';
    const space = transformControl?.space || 'local';
    if (refs.modeTranslate) refs.modeTranslate.style.background = mode === 'translate' ? 'linear-gradient(180deg, rgba(242, 163, 58, 0.94) 0%, rgba(199, 122, 30, 0.94) 100%)' : '';
    if (refs.modeRotate) refs.modeRotate.style.background = mode === 'rotate' ? 'linear-gradient(180deg, rgba(242, 163, 58, 0.94) 0%, rgba(199, 122, 30, 0.94) 100%)' : '';
    if (refs.modeScale) refs.modeScale.style.background = mode === 'scale' ? 'linear-gradient(180deg, rgba(242, 163, 58, 0.94) 0%, rgba(199, 122, 30, 0.94) 100%)' : '';
    if (refs.spaceLocal) refs.spaceLocal.style.background = space === 'local' ? 'linear-gradient(180deg, rgba(242, 163, 58, 0.94) 0%, rgba(199, 122, 30, 0.94) 100%)' : '';
    if (refs.spaceWorld) refs.spaceWorld.style.background = space === 'world' ? 'linear-gradient(180deg, rgba(242, 163, 58, 0.94) 0%, rgba(199, 122, 30, 0.94) 100%)' : '';
}

function updateSceneActorDetailsUI() {
    const refs = getSceneActorDetailsRefs();
    if (!refs.empty || !refs.body || !refs.type) return;

    const actor = getSelectedSceneActor();
    const mesh = getActorRenderObject(actor);
    updateSceneActorDetailsTransformButtons(refs);

    if (blueprintState.active || !actor || !mesh) {
        refs.empty.hidden = false;
        refs.body.hidden = true;
        refs.type.textContent = 'Select actor';
        if (refs.name) refs.name.textContent = 'No Actor Selected';
        if (refs.lightSection) refs.lightSection.hidden = true;
        if (refs.ddgiSection) refs.ddgiSection.hidden = true;
        return;
    }

    refs.empty.hidden = true;
    refs.body.hidden = false;
    if (refs.name) refs.name.textContent = actor.rootNode?.name || actor.id || 'Actor';
    refs.type.textContent = actorInheritsCore(actor) ? 'instance' : (actor.kind || 'actor');

    if (refs.locX) refs.locX.value = mesh.position.x.toFixed(3);
    if (refs.locY) refs.locY.value = mesh.position.y.toFixed(3);
    if (refs.locZ) refs.locZ.value = mesh.position.z.toFixed(3);
    if (refs.rotX) refs.rotX.value = THREE.MathUtils.radToDeg(mesh.rotation.x).toFixed(1);
    if (refs.rotY) refs.rotY.value = THREE.MathUtils.radToDeg(mesh.rotation.y).toFixed(1);
    if (refs.rotZ) refs.rotZ.value = THREE.MathUtils.radToDeg(mesh.rotation.z).toFixed(1);
    if (refs.sclX) refs.sclX.value = mesh.scale.x.toFixed(3);
    if (refs.sclY) refs.sclY.value = mesh.scale.y.toFixed(3);
    if (refs.sclZ) refs.sclZ.value = mesh.scale.z.toFixed(3);

    const light = getActorLightObject(actor);
    if (refs.lightSection) {
        refs.lightSection.hidden = !light;
    }
    if (refs.lightSpotRow) {
        refs.lightSpotRow.hidden = !light?.isSpotLight;
    }
    if (light) {
        syncActorLightStateFromObject(actor, light);
        syncActorLightHelperVisuals(actor);
        const lightState = actor.userData?.light || {};
        if (refs.lightColor) refs.lightColor.value = lightState.color || `#${light.color.getHexString()}`;
        if (refs.lightIntensity) refs.lightIntensity.value = Number(light.intensity ?? 0).toFixed(3);
        if (refs.lightDistance) refs.lightDistance.value = Number(light.distance ?? 0).toFixed(3);
        if (refs.lightDecay) refs.lightDecay.value = Number(light.decay ?? 0).toFixed(3);
        if (refs.lightShadow) refs.lightShadow.value = light.castShadow ? 'on' : 'off';
        if (refs.lightKind) refs.lightKind.value = light.isSpotLight ? 'Spot Light' : 'Point Light';
        if (refs.lightAngle) refs.lightAngle.value = THREE.MathUtils.radToDeg(light.angle ?? (Math.PI / 6)).toFixed(1);
        if (refs.lightPenumbra) refs.lightPenumbra.value = Number(light.penumbra ?? 0).toFixed(3);
    }

    const ddgi = getActorDDGIVolumeComponent(actor);
    if (refs.ddgiSection) {
        refs.ddgiSection.hidden = !ddgi;
    }
    if (!ddgi) return;

    const size = ddgi.getOwnerVolumeSize?.(new THREE.Vector3()) || new THREE.Vector3();
    const totalProbes = ddgi.getProbeCount?.() || (ddgi.gridDims.x * ddgi.gridDims.y * ddgi.gridDims.z);
    const derivedCellSize = Math.max(
        size.x / Math.max(2, ddgi.gridDims.x),
        size.y / Math.max(2, ddgi.gridDims.y),
        size.z / Math.max(2, ddgi.gridDims.z),
        0.05,
    );

    if (refs.ddgiDimX) refs.ddgiDimX.value = String(ddgi.gridDims.x);
    if (refs.ddgiDimY) refs.ddgiDimY.value = String(ddgi.gridDims.y);
    if (refs.ddgiDimZ) refs.ddgiDimZ.value = String(ddgi.gridDims.z);
    if (refs.ddgiSizeX) refs.ddgiSizeX.value = size.x.toFixed(2);
    if (refs.ddgiSizeY) refs.ddgiSizeY.value = size.y.toFixed(2);
    if (refs.ddgiSizeZ) refs.ddgiSizeZ.value = size.z.toFixed(2);
    if (refs.ddgiTotal) refs.ddgiTotal.value = String(totalProbes);
    if (refs.ddgiCell) refs.ddgiCell.value = derivedCellSize.toFixed(3);
    if (refs.ddgiIntensity) refs.ddgiIntensity.value = Number(ddgi.intensity ?? 0).toFixed(3);
    if (refs.ddgiHysteresis) refs.ddgiHysteresis.value = Number(ddgi.hysteresis ?? 0).toFixed(3);
    if (refs.ddgiNormalBias) refs.ddgiNormalBias.value = Number(ddgi.normalBias ?? 0).toFixed(3);
    if (refs.ddgiProbesPerFrame) refs.ddgiProbesPerFrame.value = String(ddgi.probesPerFrame | 0);
}

function applySceneActorTransformDetailsFromUI() {
    const actor = getSelectedSceneActor();
    const mesh = getActorRenderObject(actor);
    const refs = getSceneActorDetailsRefs();
    if (!actor || !mesh || !refs.locX) return;

    mesh.position.set(
        Number.parseFloat(refs.locX.value) || 0,
        Number.parseFloat(refs.locY.value) || 0,
        Number.parseFloat(refs.locZ.value) || 0,
    );
    mesh.rotation.set(
        THREE.MathUtils.degToRad(Number.parseFloat(refs.rotX?.value) || 0),
        THREE.MathUtils.degToRad(Number.parseFloat(refs.rotY?.value) || 0),
        THREE.MathUtils.degToRad(Number.parseFloat(refs.rotZ?.value) || 0),
    );
    mesh.scale.set(
        Math.max(0.01, Number.parseFloat(refs.sclX?.value) || 1),
        Math.max(0.01, Number.parseFloat(refs.sclY?.value) || 1),
        Math.max(0.01, Number.parseFloat(refs.sclZ?.value) || 1),
    );
    mesh.updateMatrixWorld(true);

    if (transformControl && transformControl.object !== mesh) {
        transformControl.attach(mesh);
    }

    syncTransformToPhysics();

    if (actorBelongsToCurrentMesh(actor)) {
        refreshGameplayWorld({ resetCamera: false });
    }

    const ddgi = getActorDDGIVolumeComponent(actor);
    if (ddgi) {
        syncDDGIVolumeComponentToActorBounds(ddgi);
        invalidateDDGI('ddgi volume transformed from details');
    } else {
        invalidateDDGI('scene actor transformed from details');
    }

    refreshSceneUI();
    updateSceneActorDetailsUI();
}

function applySceneActorDDGIDetailsFromUI() {
    const actor = getSelectedSceneActor();
    const ddgi = getActorDDGIVolumeComponent(actor);
    const refs = getSceneActorDetailsRefs();
    if (!actor || !ddgi || !refs.ddgiDimX) return;

    const dimsX = Math.max(2, Math.floor(Number.parseFloat(refs.ddgiDimX.value) || ddgi.gridDims.x));
    const dimsY = Math.max(2, Math.floor(Number.parseFloat(refs.ddgiDimY.value) || ddgi.gridDims.y));
    const dimsZ = Math.max(2, Math.floor(Number.parseFloat(refs.ddgiDimZ.value) || ddgi.gridDims.z));
    ddgi.setGridDims(dimsX, dimsY, dimsZ);
    ddgi.intensity = Math.max(0, Math.min(16, Number.parseFloat(refs.ddgiIntensity?.value) || ddgi.intensity));
    ddgi.hysteresis = Math.max(0, Math.min(0.999, Number.parseFloat(refs.ddgiHysteresis?.value) || ddgi.hysteresis));
    ddgi.normalBias = Math.max(0, Math.min(2, Number.parseFloat(refs.ddgiNormalBias?.value) || ddgi.normalBias));
    ddgi.probesPerFrame = Math.max(1, Math.min(120, Math.floor(Number.parseFloat(refs.ddgiProbesPerFrame?.value) || ddgi.probesPerFrame)));
    syncDDGIVolumeComponentToActorBounds(ddgi);
    invalidateDDGI('ddgi volume settings changed');
    updateSceneActorDetailsUI();
}

function applySceneActorLightDetailsFromUI() {
    const actor = getSelectedSceneActor();
    const light = getActorLightObject(actor);
    const refs = getSceneActorDetailsRefs();
    if (!actor || !light || !refs.lightIntensity) return;

    const colorValue = typeof refs.lightColor?.value === 'string' && refs.lightColor.value.length
        ? refs.lightColor.value
        : `#${light.color.getHexString()}`;
    if (colorValue !== `#${light.color.getHexString()}`) {
        setActorColor(actor, colorValue);
    }

    const intensity = Number.parseFloat(refs.lightIntensity.value);
    if (Number.isFinite(intensity)) {
        light.intensity = Math.max(0, intensity);
    }

    const distance = Number.parseFloat(refs.lightDistance?.value);
    if (Number.isFinite(distance)) {
        light.distance = Math.max(0, distance);
    }

    const decay = Number.parseFloat(refs.lightDecay?.value);
    if (Number.isFinite(decay)) {
        light.decay = Math.max(0, decay);
    }

    light.castShadow = refs.lightShadow?.value !== 'off';
    requestLightShadowRefresh(light);

    if (light.isSpotLight) {
        const angleDegrees = Number.parseFloat(refs.lightAngle?.value);
        if (Number.isFinite(angleDegrees)) {
            light.angle = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(angleDegrees, 1, 89));
        }

        const penumbra = Number.parseFloat(refs.lightPenumbra?.value);
        if (Number.isFinite(penumbra)) {
            light.penumbra = THREE.MathUtils.clamp(penumbra, 0, 1);
        }

        light.target?.updateMatrixWorld?.(true);
    }

    syncActorLightStateFromObject(actor, light);
    syncActorLightHelperVisuals(actor);
    invalidateDDGI('light actor settings changed');
    updateSceneActorDetailsUI();
}

function createSceneActorItem(actor, { isChild = false } = {}) {
    const item = document.createElement('div');
    item.className = isChild ? 'scene-ui-item scene-ui-child-item' : 'scene-ui-item';
    item.dataset.id = actor.id;

    if (objectScriptState.targetPropId === actor.id) {
        item.style.background = 'linear-gradient(180deg, rgba(58, 43, 22, 0.98) 0%, rgba(42, 30, 15, 0.98) 100%)';
        item.style.borderColor = 'rgba(242, 163, 58, 0.58)';
        if (!blueprintState.active) {
            const actorBtnRow = document.createElement('div');
            actorBtnRow.className = 'scene-ui-item-actions';

            const blueprintBtn = document.createElement('button');
            blueprintBtn.className = 'btn btn-primary scene-ui-action-btn';
            blueprintBtn.textContent = 'Edit Blueprint';
            blueprintBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                enterBlueprintEditor();
                syncBlueprintPhysicsEditor(actor);
            });
            actorBtnRow.appendChild(blueprintBtn);

            const saveActorBtn = document.createElement('button');
            saveActorBtn.className = 'btn scene-ui-action-btn scene-ui-save-btn';
            saveActorBtn.textContent = 'Save';
            saveActorBtn.title = 'Download this actor as a .actor file';
            saveActorBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                exportActorToFile(actor);
            });
            actorBtnRow.appendChild(saveActorBtn);
            item.appendChild(actorBtnRow);
        }
    }

    const nameEl = document.createElement('div');
    nameEl.className = 'scene-ui-item-name';
    nameEl.textContent = actor.rootNode.name || actor.id || 'Actor';

    const typeEl = document.createElement('div');
    typeEl.className = 'scene-ui-item-type';
    typeEl.textContent = actorInheritsCore(actor) ? 'instance' : (actor.kind || 'Actor');

    item.appendChild(nameEl);
    item.appendChild(typeEl);
    item.addEventListener('click', () => selectShowcaseActor(actor.id));
    item.addEventListener('dblclick', () => focusSceneActor(actor));
    return item;
}

function refreshSceneUI() {
    if (collisionDebugState.enabled) {
        refreshCollisionDebugOverlays();
    }

    if (!sceneUiList || !sceneUiCount) return;

    sceneUiList.innerHTML = '';

    if (!sceneSystem || sceneSystem.actors.size === 0) {
        sceneUiCount.textContent = '0 Actors';
        updateSceneActorDetailsUI();
        return;
    }

    const actors = Array.from(sceneSystem.actors);
    sceneUiCount.textContent = `${actors.length} Actor${actors.length !== 1 ? 's' : ''}`;

    actors.forEach((actor) => sceneUiList.appendChild(createSceneActorItem(actor)));

    const cores = actors.filter((actor) => !actorInheritsCore(actor)
        && actors.some((entry) => actorInheritsCore(entry) && getActorCoreSource(entry)?.id === actor.id));
    if (cores.length) {
        const folder = document.createElement('div');
        folder.className = 'scene-ui-folder scene-ui-core-bin';
        if (refreshSceneUI.coreBinCollapsed) {
            folder.classList.add('scene-ui-folder-collapsed');
        }

        const header = document.createElement('button');
        header.className = 'scene-ui-folder-header';
        header.type = 'button';
        header.textContent = 'Core Actors';

        const count = document.createElement('span');
        count.textContent = `${cores.length} parent${cores.length !== 1 ? 's' : ''}`;
        header.appendChild(count);
        header.addEventListener('click', () => {
            refreshSceneUI.coreBinCollapsed = !refreshSceneUI.coreBinCollapsed;
            refreshSceneUI();
        });
        folder.appendChild(header);

        if (!refreshSceneUI.coreBinCollapsed) {
            cores.forEach((actor) => {
                const linked = actors.filter((entry) => actorInheritsCore(entry) && getActorCoreSource(entry)?.id === actor.id);
                const row = createSceneActorItem(actor);
                const type = row.querySelector('.scene-ui-item-type');
                if (type) type.textContent = `parent core · ${linked.length} linked`;
                folder.appendChild(row);
            });
        }

        sceneUiList.appendChild(folder);
    }
    updateSceneActorDetailsUI();
    return;

    /*
    actors.forEach(actor => {
        const item = document.createElement('div');
        item.className = 'scene-ui-item';
        item.dataset.id = actor.id;

        if (objectScriptState.targetPropId === actor.id) {
            item.style.background = 'linear-gradient(180deg, rgba(58, 43, 22, 0.98) 0%, rgba(42, 30, 15, 0.98) 100%)';
            item.style.borderColor = 'rgba(242, 163, 58, 0.58)';
            
            if (!blueprintState.active) {
                const actorBtnRow = document.createElement('div');
                actorBtnRow.className = 'scene-ui-item-actions';

                const blueprintBtn = document.createElement('button');
                blueprintBtn.className = 'btn btn-primary scene-ui-action-btn';
                blueprintBtn.textContent = 'Edit Blueprint';
                blueprintBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    enterBlueprintEditor();
                    syncBlueprintPhysicsEditor(actor);
                });
                actorBtnRow.appendChild(blueprintBtn);

                const saveActorBtn = document.createElement('button');
                saveActorBtn.className = 'btn scene-ui-action-btn scene-ui-save-btn';
                saveActorBtn.textContent = '⬇ Save';
                saveActorBtn.title = 'Download this actor as a .actor file';
                saveActorBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    exportActorToFile(actor);
                });
                actorBtnRow.appendChild(saveActorBtn);

                item.appendChild(actorBtnRow);
            }
        }

        const nameEl = document.createElement('div');
        nameEl.className = 'scene-ui-item-name';
        nameEl.textContent = actor.rootNode.name || actor.id || 'Actor';

        const typeEl = document.createElement('div');
        typeEl.className = 'scene-ui-item-type';
        typeEl.textContent = actor.kind || 'Actor';

        item.appendChild(nameEl);
        item.appendChild(typeEl);

        item.addEventListener('click', () => {
            selectShowcaseActor(actor.id);
        });

        item.addEventListener('dblclick', () => {
            const actorMesh = getActorRenderObject(actor);
            if (!gameplay.active && actorMesh) {
                const targetPos = new THREE.Vector3();
                actorMesh.getWorldPosition(targetPos);
                
                if (gsap) {
                    gsap.to(camera.position, {
                        x: targetPos.x + 2.5,
                        y: targetPos.y + 2.5,
                        z: targetPos.z + 2.5,
                        duration: 0.6,
                        ease: 'power2.out',
                        onUpdate: () => {
                            syncShowcaseAnglesFromTarget(targetPos);
                            applyShowcaseCameraRotation();
                        }
                    });
                } else {
                    camera.position.set(targetPos.x + 2.5, targetPos.y + 2.5, targetPos.z + 2.5);
                    syncShowcaseAnglesFromTarget(targetPos);
                    applyShowcaseCameraRotation();
                }
            }
        });

        sceneUiList.appendChild(item);
    });
    */
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
    document.getElementById('load-level')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const levelId = document.getElementById('level-select')?.value || 'soccerField';
        loadSample(levelId);
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
        bloomOff: document.getElementById('we-bloom-off'),
        bloomOn: document.getElementById('we-bloom-on'),
        bloomStrength: document.getElementById('we-bloom-strength'),
        bloomStrengthValue: document.getElementById('we-bloom-strength-value'),
        bloomRadius: document.getElementById('we-bloom-radius'),
        bloomRadiusValue: document.getElementById('we-bloom-radius-value'),
        bloomThreshold: document.getElementById('we-bloom-threshold'),
        bloomThresholdValue: document.getElementById('we-bloom-threshold-value'),
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
    worldEnvUiRefs?.masterCornellBtn?.addEventListener('click', () => setWorldEnvMaster('cornell'));
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

    wireToggle(worldEnvUiRefs?.ssgiOff, worldEnvUiRefs?.ssgiOn,
        () => { worldEnvState.ssgi.enabled = false; },
        () => { worldEnvState.ssgi.enabled = true; });

    wireToggle(worldEnvUiRefs?.fogOff, worldEnvUiRefs?.fogOn,
        () => { worldEnvState.fog.enabled = false; },
        () => { worldEnvState.fog.enabled = true; });
    wireSlider(worldEnvUiRefs?.fogDensity, 'fog.density', (v) => { worldEnvState.fog.density = v; });
    wireSlider(worldEnvUiRefs?.fogOpacity, 'fog.opacity', (v) => { worldEnvState.fog.opacity = v; });

    wireToggle(worldEnvUiRefs?.ddgiOff, worldEnvUiRefs?.ddgiOn,
        () => { worldEnvState.ddgi.enabled = false; },
        () => { worldEnvState.ddgi.enabled = true; });
    wireToggle(worldEnvUiRefs?.ddgiLiveBakeOff, worldEnvUiRefs?.ddgiLiveBakeOn,
        () => { worldEnvState.ddgi.liveBake = false; },
        () => { worldEnvState.ddgi.liveBake = true; });
    wireSlider(worldEnvUiRefs?.ddgiBakeEveryN, 'ddgi.bakeEveryN',
        (v) => {
            worldEnvState.ddgi.bakeEveryN = Math.max(1, Math.round(v));
            worldEnvState.ddgi.probesPerFrame = worldEnvState.ddgi.bakeEveryN;
        }, (s) => parseInt(s, 10));
    wireSlider(worldEnvUiRefs?.ddgiIntensity, 'ddgi.intensity', (v) => { worldEnvState.ddgi.intensity = v; });
    wireSlider(worldEnvUiRefs?.ddgiLightIntensity, 'ddgi.lightIntensity', (v) => { worldEnvState.ddgi.lightIntensity = v; });
    wireToggle(worldEnvUiRefs?.ddgiProbeDebugOff, worldEnvUiRefs?.ddgiProbeDebugOn,
        () => { worldEnvState.ddgi.debugProbes = false; },
        () => { worldEnvState.ddgi.debugProbes = true; });
    wireToggle(worldEnvUiRefs?.ddgiRayDebugOff, worldEnvUiRefs?.ddgiRayDebugOn,
        () => { worldEnvState.ddgi.rayDebug = false; },
        () => { worldEnvState.ddgi.rayDebug = true; });
    wireToggle(worldEnvUiRefs?.ddgiSolidTestOff, worldEnvUiRefs?.ddgiSolidTestOn,
        () => { worldEnvState.ddgi.solidTest = false; },
        () => { worldEnvState.ddgi.solidTest = true; });
    wireToggle(worldEnvUiRefs?.ddgiViewLit, worldEnvUiRefs?.ddgiViewContribution,
        () => { worldEnvState.ddgi.contributionView = false; },
        () => { worldEnvState.ddgi.contributionView = true; });

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

    renderer = new WebGPURenderer({ antialias: true, alpha: true, trackTimestamp: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.localClippingEnabled = true; // Essential for the reflection
    renderer.domElement.tabIndex = 0;
    container.appendChild(renderer.domElement);
    await renderer.init();
    debugConsoleState.gpuTimingMode = renderer.backend?.trackTimestamp ? 'gpu' : 'approximate';

    // ── Post-processing: bloom over the scene's emissive output ─────────────
    // Uses an MRT pass so bloom only picks up materials with non-zero emissive
    // (lights, headlights/taillights, accent stripes) instead of every bright
    // pixel — keeps the world from looking hazy.
    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({
        output: output,
        emissive: emissive,
        normal: normalView,
    }));
    const sceneColor = scenePass.getTextureNode('output');
    const sceneEmissive = scenePass.getTextureNode('emissive');
    const sceneNormal = scenePass.getTextureNode('normal');
    const sceneDepth = scenePass.getTextureNode('depth');
    const bloomNode = bloom(sceneEmissive, globalPostProcessUniforms.bloomStrength, globalPostProcessUniforms.bloomRadius, globalPostProcessUniforms.bloomThreshold);
    const ssgiNode = ssgi(sceneColor, sceneDepth, sceneNormal, camera);
    ssgiNode.useTemporalFiltering = false;
    const ssgiOutput = ssgiNode.getTextureNode();
    postProcessing = new RenderPipeline(renderer);
    postProcessNodes = { sceneColor, bloomNode, ssgiNode, ssgiOutput };
    applySSGISettings();
    rebuildPostProcessingOutputNode();

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
    mainDirectionalLight.shadow.mapSize.width = 4096;
    mainDirectionalLight.shadow.mapSize.height = 4096;
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
    if (!currentMesh) {
        loadSample();
    }
    updateGameplayUI();
    try {
        await renderer.compileAsync?.(scene, camera);
    } catch (e) {
        console.warn('[Renderer] initial compile warmup failed', e);
    }

    renderer.setAnimationLoop((timestamp) => {
        frameTimer.update(timestamp);
        const delta = Math.min(frameTimer.getDelta(), 0.05);

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

        updateSoccerGoalies(delta);

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
        const ddgiManager = getDDGIManager();
        // fix/ddgi-correctness: tick DDGI regardless of perf mode. The runtime
        // enabled flag (set by applyWorldEnvState) is the single source of truth.
        ddgiManager.tick(delta);
        const _ddgiMs = performance.now() - _ddgiStart;
        if (debugConsoleState?.latest) debugConsoleState.latest.ddgi = _ddgiMs;
        // Cornell ray debug: redraw the rays cast from the chosen probe
        // every frame so a moving / rebaking world stays in sync.
        updateCornellRayDebug();
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

            tickRaycastDebugLine();
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
                delta,
            });
        } catch (e) {
            console.error('Crash in animation loop:', e);
            throw e;
        }
        updateDebugStatPanels();
    });
}

function makeSampleLevelPart(name, shape, material, position, rotation = [0, 0, 0], { castShadow = true, receiveShadow = true, skipPhysicsCollision = false } = {}) {
    const kind = shape?.kind;
    const mesh = kind ? buildPrimitiveActorMesh(kind) : null;
    if (!mesh) return null;

    const defaultMaterial = mesh.material;
    if (Array.isArray(defaultMaterial)) {
        defaultMaterial.forEach((entry) => entry?.dispose?.());
    } else {
        defaultMaterial?.dispose?.();
    }

    mesh.material = material;
    mesh.name = name;
    mesh.position.fromArray(position);
    mesh.rotation.set(...rotation);
    if (Array.isArray(shape?.scale) && shape.scale.length === 3) {
        mesh.scale.fromArray(shape.scale);
    }
    mesh.userData.hasMaterialOverrides = true;
    mesh.userData.skipPhysicsCollision = !!skipPhysicsCollision;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;

    return createDynamicPropActor({
        body: null,
        mesh,
        kind,
        userData: {
            label: name,
            sampleLevelPart: true,
        },
        includeScripts: false,
    });
}

function makeSampleLevelMeshActor(name, mesh, {
    kind = 'imported',
    castShadow = false,
    receiveShadow = true,
    skipPhysicsCollision = false,
    userData = {},
} = {}) {
    if (!mesh) return null;

    mesh.name = name;
    mesh.userData = {
        ...(mesh.userData || {}),
        hasMaterialOverrides: true,
        skipPhysicsCollision: !!skipPhysicsCollision,
    };
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;

    return createDynamicPropActor({
        body: null,
        mesh,
        kind,
        userData: {
            label: name,
            sampleLevelPart: true,
            ...userData,
        },
        includeScripts: false,
    });
}

function createFpsStarterLevel() {
    const MAP_SCALE = 2;
    const scaleScalar = (value) => value * MAP_SCALE;
    const scaleVector = (values) => values.map((value) => value * MAP_SCALE);
    const makeBoxShape = (size) => ({
        kind: 'cube',
        scale: [scaleScalar(size[0]) * 0.5, scaleScalar(size[1]) * 0.5, scaleScalar(size[2]) * 0.5],
    });
    const makeCylinderShape = (radius, height) => ({
        kind: 'cylinder',
        scale: [scaleScalar(radius), scaleScalar(height) * 0.5, scaleScalar(radius)],
    });

    const root = new THREE.Group();
    root.name = 'PolyFlow_FPS_Starter_Level';
    root.userData.sampleType = 'fpsStarterLevel';
    root.userData.hideTerrainPresentation = true;
    root.userData.skipNormalization = true;
    root.userData.sampleMapScale = MAP_SCALE;

    root.userData.preferredSpawn = {
        position: scaleVector([0.0, 0.3, 8.6]),
        yaw: Math.PI,
        pitch: -0.06,
    };
    root.userData.preferredShowcase = {
        position: scaleVector([20.0, 13.5, 16.5]),
        target: scaleVector([0.0, 1.7, -1.0]),
    };

    const stylePresets = {
        light: { baseColor: '#d4cec8', roughness: 0.97, metalness: 0.02 },
        floor: { baseColor: '#a7adb4', roughness: 0.96, metalness: 0.02 },
        dark: { baseColor: '#5a5d61', roughness: 0.92, metalness: 0.05 },
        blue: { baseColor: '#149cff', roughness: 0.34, metalness: 0.04 },
    };

    const createGridMaterial = ({ baseColor, roughness = 0.95, metalness = 0.02 }) => {
        return new THREE.MeshStandardMaterial({
            color: new THREE.Color(baseColor),
            roughness,
            metalness,
        });
    };

    const createMaterial = (styleName) => {
        const style = stylePresets[styleName] ?? stylePresets.light;
        return createGridMaterial({
            baseColor: style.baseColor,
            roughness: style.roughness,
            metalness: style.metalness,
        });
    };

    const contactShadowMaterialCache = new Map();
    const smoothstep = (edge0, edge1, value) => {
        const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
        return t * t * (3 - 2 * t);
    };
    const createDistanceFieldContactShadowMaterial = (width, depth, spread = 2.2, strength = 0.55) => {
        const key = `${width.toFixed(2)}:${depth.toFixed(2)}:${spread.toFixed(2)}:${strength.toFixed(2)}`;
        if (contactShadowMaterialCache.has(key)) {
            return contactShadowMaterialCache.get(key).clone();
        }

        const canvas = document.createElement('canvas');
        canvas.width = 192;
        canvas.height = 192;
        const ctx = canvas.getContext('2d');
        const image = ctx.createImageData(canvas.width, canvas.height);
        const planeWidth = width + spread * 2;
        const planeDepth = depth + spread * 2;

        for (let y = 0; y < canvas.height; y++) {
            for (let x = 0; x < canvas.width; x++) {
                const u = (x + 0.5) / canvas.width - 0.5;
                const v = (y + 0.5) / canvas.height - 0.5;
                const px = u * planeWidth;
                const pz = v * planeDepth;
                const dx = Math.max(Math.abs(px) - width * 0.5, 0);
                const dz = Math.max(Math.abs(pz) - depth * 0.5, 0);
                const dist = Math.sqrt(dx * dx + dz * dz);
                const contact = 1 - smoothstep(0, spread, dist);
                const insideFade = smoothstep(-0.05, 0.45, Math.max(dx, dz));
                const alpha = Math.round(255 * strength * Math.max(contact, insideFade * contact));
                const index = (y * canvas.width + x) * 4;
                image.data[index] = 0;
                image.data[index + 1] = 0;
                image.data[index + 2] = 0;
                image.data[index + 3] = alpha;
            }
        }
        ctx.putImageData(image, 0, 0);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        const material = new THREE.MeshBasicMaterial({
            color: 0x000000,
            map: texture,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            opacity: 1,
            toneMapped: false,
        });
        material.userData = { ownedMaps: [texture] };
        contactShadowMaterialCache.set(key, material);
        return material.clone();
    };
    const addDistanceFieldContactShadow = (name, size, position, options = {}) => {
        if (options.contactShadow === false) return null;
        const rotation = Array.isArray(options.rotation) ? options.rotation : [0, 0, 0];
        if (Math.abs(rotation[0] || 0) > 1e-4 || Math.abs(rotation[2] || 0) > 1e-4) return null;
        if ((position[1] - size[1] * 0.5) > 0.25 || size[1] < 0.5) return null;

        const width = scaleScalar(Math.max(size[0], 0.35));
        const depth = scaleScalar(Math.max(size[2], 0.35));
        const spread = THREE.MathUtils.clamp(Math.min(width, depth) * 0.72, 2.0, 5.5);
        const mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(width + spread * 2, depth + spread * 2),
            createDistanceFieldContactShadowMaterial(width, depth, spread)
        );
        mesh.name = `${name}_DistanceFieldContactShadow`;
        const scaledPosition = scaleVector(position);
        mesh.position.set(scaledPosition[0], 0.455, scaledPosition[2]);
        mesh.rotation.set(-Math.PI / 2, 0, -(rotation[1] || 0));
        mesh.renderOrder = 6;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.userData.skipPhysicsCollision = true;
        markDDGISkipCapture(mesh);
        root.add(mesh);
        return mesh;
    };

    const createBoxNode = (name, size, position, styleName = 'light', options = {}) => {
        return makeSampleLevelPart(name, makeBoxShape(size), createMaterial(styleName), scaleVector(position), options.rotation || [0, 0, 0], options);
    };

    const createCylinderNode = (name, radius, height, position, styleName = 'light', options = {}) => {
        return makeSampleLevelPart(name, makeCylinderShape(radius, height), createMaterial(styleName), scaleVector(position), options.rotation || [0, 0, 0], options);
    };

    const addNode = (actor) => {
        const mesh = getActorRenderObject(actor);
        if (mesh) {
            root.add(mesh);
        }
        return actor;
    };

    const addBox = (name, size, position, styleName = 'light', options = {}) => {
        const actor = addNode(createBoxNode(name, size, position, styleName, options));
        addDistanceFieldContactShadow(name, size, position, options);
        return actor;
    };
    const addCylinder = (name, radius, height, position, styleName = 'light', options = {}) => addNode(createCylinderNode(name, radius, height, position, styleName, options));
    const addCollisionPlane = (name, size, position) => {
        const mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(scaleScalar(size[0]), scaleScalar(size[1])),
            new THREE.MeshBasicMaterial({ visible: false })
        );
        mesh.name = name;
        mesh.position.fromArray(scaleVector(position));
        mesh.rotation.x = -Math.PI / 2;
        mesh.visible = false;
        mesh.userData.collisionOnly = true;
        root.add(mesh);
        return mesh;
    };

    addBox('Graybox_Floor', [36, 0.2, 22], [0, 0.1, 0], 'floor', { skipPhysicsCollision: true, contactShadow: false });
    addCollisionPlane('Graybox_Floor_Collision', [36, 22], [0, 0.21, 0]);
    addBox('Graybox_LeftWall', [0.45, 5.4, 22], [-17.78, 2.7, 0], 'dark');
    addBox('Graybox_RightWall', [0.45, 5.4, 22], [17.78, 2.7, 0], 'dark');
    addBox('Graybox_BackWall', [36, 5.4, 0.45], [0, 2.7, -10.78], 'light');
    addBox('Graybox_FrontWall', [36, 5.4, 0.45], [0, 2.7, 10.78], 'light');
    addBox('Graybox_BackRightPanel', [10.5, 5.2, 0.18], [11.6, 2.6, -10.56], 'dark', { castShadow: false });
    addBox('Graybox_RightRearPanel', [0.18, 5.2, 8.4], [17.62, 2.6, -6.35], 'dark', { castShadow: false });

    addBox('Graybox_LeftBlock', [5.8, 2.6, 4.4], [-8.6, 1.3, -0.9], 'light');
    addBox('Graybox_LeftRamp', [4.2, 0.34, 6.0], [-12.4, 1.06, -2.7], 'dark', { rotation: [0.28, 0, 0] });
    addBox('Graybox_CenterBackBar', [11.0, 2.7, 2.2], [2.0, 1.35, -2.8], 'dark');
    addBox('Graybox_CenterFrontBar', [2.05, 2.25, 7.2], [2.0, 1.125, 3.0], 'dark');
    addBox('Graybox_RightFrontBar', [10.0, 2.5, 2.35], [10.6, 1.25, 4.2], 'dark');
    addCylinder('Graybox_RightCylinder', 1.8, 2.2, [9.4, 1.1, -2.7], 'light');
    addBox('Graybox_RightRearShelf', [6.6, 0.8, 2.2], [10.9, 0.4, -6.1], 'dark');

    return root;
}

const SOCCER_FIELD_LEVEL_SCALE = 3;

function createSoccerTargetFieldScene({
    name = 'PolyFlow_Soccer_Target_Field',
    hideTerrainPresentation = true,
} = {}) {
    const S = SOCCER_FIELD_LEVEL_SCALE;
    const FIELD_WIDTH = 18 * S;
    const FIELD_LENGTH = 28 * S;
    const GOAL_Z = FIELD_LENGTH * 0.5 - 0.45 * S;
    const LINE_Y = 0.145 * S;

    const root = new THREE.Group();
    root.name = name;
    root.userData.sampleType = 'soccerTargetField';
    root.userData.hideTerrainPresentation = hideTerrainPresentation;
    root.userData.skipNormalization = true;
    root.userData.preferredSpawn = {
        position: [0, 0.24 * S, FIELD_LENGTH * 0.34],
        yaw: Math.PI,
        pitch: -0.08,
    };
    root.userData.preferredShowcase = {
        position: [12.5 * S, 9.2 * S, 19.5 * S],
        target: [0, 0.45 * S, 0],
    };
    root.userData.soccerGoalTargets = [
        { position: [-2.2 * S, 1.35 * S, -GOAL_Z], rotationY: Math.PI, label: 'North Goal Target L', scale: S },
        { position: [2.2 * S, 1.35 * S, -GOAL_Z], rotationY: Math.PI, label: 'North Goal Target R', scale: S },
        { position: [-2.2 * S, 1.35 * S, GOAL_Z], rotationY: 0, label: 'South Goal Target L', scale: S },
        { position: [2.2 * S, 1.35 * S, GOAL_Z], rotationY: 0, label: 'South Goal Target R', scale: S },
    ];
    root.userData.soccerGoalies = [
        {
            position: [0, 0.78 * S, -GOAL_Z + 0.9 * S],
            size: [1.7 * S, 1.35 * S, 0.24 * S],
            axis: [1, 0, 0],
            amplitude: 1.65 * S,
            speed: 1.7,
            phase: 0,
            label: 'North Goalie Wall',
        },
        {
            position: [0, 0.78 * S, GOAL_Z - 0.9 * S],
            size: [1.7 * S, 1.35 * S, 0.24 * S],
            axis: [1, 0, 0],
            amplitude: 1.65 * S,
            speed: 1.7,
            phase: Math.PI,
            label: 'South Goalie Wall',
        },
    ];
    root.userData.soccerPlayerSpawns = [
        { playerIndex: 1, position: [0, 0.85, FIELD_LENGTH * 0.34], label: 'Player 1 Spawn', color: '#22c55e' },
        { playerIndex: 2, position: [0, 0.85, -FIELD_LENGTH * 0.34], label: 'Player 2 Spawn', color: '#38bdf8' },
    ];

    const materials = {
        turf: new THREE.MeshStandardMaterial({ color: 0x2f7d32, roughness: 0.86, metalness: 0.02 }),
        turfStripe: new THREE.MeshStandardMaterial({ color: 0x3f9a42, roughness: 0.88, metalness: 0.02 }),
        line: new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.62, metalness: 0.0 }),
        goalFrame: new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.54, metalness: 0.04 }),
        net: new THREE.MeshStandardMaterial({
            color: 0xdbeafe,
            roughness: 0.6,
            metalness: 0,
            transparent: true,
            opacity: 0.24,
            side: THREE.DoubleSide,
        }),
    };

    const addBox = (name, size, position, material, options = {}) => {
        const actor = makeSampleLevelPart(
            name,
            { kind: 'cube', scale: [size[0] * 0.5, size[1] * 0.5, size[2] * 0.5] },
            material,
            position,
            options.rotation || [0, 0, 0],
            options
        );
        const mesh = getActorRenderObject(actor);
        if (mesh) root.add(mesh);
        return mesh;
    };

    addBox('Soccer_Field_Surface', [FIELD_WIDTH, 0.12 * S, FIELD_LENGTH], [0, 0.06 * S, 0], materials.turf, {
        contactShadow: false,
        receiveShadow: true,
    });

    for (let index = -3; index <= 3; index += 1) {
        addBox(
            `Soccer_Turf_Stripe_${index + 4}`,
            [FIELD_WIDTH - 0.18 * S, 0.012 * S, FIELD_LENGTH / 7 - 0.08 * S],
            [0, 0.132 * S, index * FIELD_LENGTH / 7],
            index % 2 === 0 ? materials.turfStripe : materials.turf,
            { skipPhysicsCollision: true, castShadow: false, receiveShadow: false }
        );
    }

    const addLine = (name, size, position) => addBox(name, size, position, materials.line, {
        skipPhysicsCollision: true,
        castShadow: false,
        receiveShadow: false,
    });

    addLine('Soccer_Line_LeftTouch', [0.08 * S, 0.026 * S, FIELD_LENGTH], [-FIELD_WIDTH * 0.5, LINE_Y, 0]);
    addLine('Soccer_Line_RightTouch', [0.08 * S, 0.026 * S, FIELD_LENGTH], [FIELD_WIDTH * 0.5, LINE_Y, 0]);
    addLine('Soccer_Line_NorthGoal', [FIELD_WIDTH, 0.026 * S, 0.08 * S], [0, LINE_Y, -FIELD_LENGTH * 0.5]);
    addLine('Soccer_Line_SouthGoal', [FIELD_WIDTH, 0.026 * S, 0.08 * S], [0, LINE_Y, FIELD_LENGTH * 0.5]);
    addLine('Soccer_Line_Midfield', [FIELD_WIDTH, 0.026 * S, 0.07 * S], [0, LINE_Y, 0]);
    addLine('Soccer_Box_North_Back', [6.7 * S, 0.026 * S, 0.07 * S], [0, LINE_Y, -FIELD_LENGTH * 0.5 + 3.9 * S]);
    addLine('Soccer_Box_North_Left', [0.07 * S, 0.026 * S, 3.9 * S], [-3.35 * S, LINE_Y, -FIELD_LENGTH * 0.5 + 1.95 * S]);
    addLine('Soccer_Box_North_Right', [0.07 * S, 0.026 * S, 3.9 * S], [3.35 * S, LINE_Y, -FIELD_LENGTH * 0.5 + 1.95 * S]);
    addLine('Soccer_Box_South_Back', [6.7 * S, 0.026 * S, 0.07 * S], [0, LINE_Y, FIELD_LENGTH * 0.5 - 3.9 * S]);
    addLine('Soccer_Box_South_Left', [0.07 * S, 0.026 * S, 3.9 * S], [-3.35 * S, LINE_Y, FIELD_LENGTH * 0.5 - 1.95 * S]);
    addLine('Soccer_Box_South_Right', [0.07 * S, 0.026 * S, 3.9 * S], [3.35 * S, LINE_Y, FIELD_LENGTH * 0.5 - 1.95 * S]);

    const centerCircle = new THREE.Mesh(
        new THREE.TorusGeometry(2.25 * S, 0.035 * S, 8, 96),
        materials.line.clone()
    );
    centerCircle.name = 'Soccer_Line_CenterCircle';
    centerCircle.position.set(0, LINE_Y + 0.018 * S, 0);
    centerCircle.rotation.x = Math.PI / 2;
    centerCircle.castShadow = false;
    centerCircle.receiveShadow = false;
    centerCircle.userData.skipPhysicsCollision = true;
    root.add(centerCircle);

    const addGoalFrame = (prefix, z, dir) => {
        const depth = 1.2 * S;
        const mouthWidth = 5.6 * S;
        const postHeight = 1.85 * S;
        const postThickness = 0.12 * S;
        const backZ = z + dir * depth;
        const postY = 0.12 * S + postHeight * 0.5;
        const topY = 0.12 * S + postHeight;

        addBox(`${prefix}_LeftPost`, [postThickness, postHeight, postThickness], [-mouthWidth * 0.5, postY, z], materials.goalFrame, { skipPhysicsCollision: true });
        addBox(`${prefix}_RightPost`, [postThickness, postHeight, postThickness], [mouthWidth * 0.5, postY, z], materials.goalFrame, { skipPhysicsCollision: true });
        addBox(`${prefix}_Crossbar`, [mouthWidth + postThickness, postThickness, postThickness], [0, topY, z], materials.goalFrame, { skipPhysicsCollision: true });
        addBox(`${prefix}_BackBar`, [mouthWidth + postThickness, postThickness, postThickness], [0, topY, backZ], materials.goalFrame, { skipPhysicsCollision: true });
        addBox(`${prefix}_LeftDepth`, [postThickness, postThickness, depth], [-mouthWidth * 0.5, topY, z + dir * depth * 0.5], materials.goalFrame, { skipPhysicsCollision: true });
        addBox(`${prefix}_RightDepth`, [postThickness, postThickness, depth], [mouthWidth * 0.5, topY, z + dir * depth * 0.5], materials.goalFrame, { skipPhysicsCollision: true });
        addBox(`${prefix}_Net`, [mouthWidth, postHeight, 0.035], [0, postY, backZ], materials.net, {
            skipPhysicsCollision: true,
            castShadow: false,
            receiveShadow: false,
        });
    };

    addGoalFrame('Soccer_NorthGoal', -GOAL_Z, -1);
    addGoalFrame('Soccer_SouthGoal', GOAL_Z, 1);

    return root;
}

function spawnSoccerGoalTarget(spec) {
    const targetScale = Number.isFinite(spec.scale) && spec.scale > 0 ? spec.scale : 1;
    const actor = spawnDynamicPrimitive('cylinder', new THREE.Vector3(...spec.position), 0.6 * targetScale, {
        local: false,
        includeCollisionBody: true,
        simulatePhysics: false,
        includeScripts: false,
        skipImpulse: true,
        userData: { label: spec.label },
        returnActor: true,
    });
    const mesh = getActorRenderObject(actor);
    if (!actor || !mesh) return null;

    mesh.position.fromArray(spec.position);
    mesh.rotation.set(Math.PI / 2, spec.rotationY || 0, 0);
    mesh.scale.set(0.45 * targetScale, 0.06 * targetScale, 0.45 * targetScale);
    mesh.name = spec.label;
    tagGameplayPrefabActor(actor, 'target', { triggerRadius: 0.62 * targetScale, groundOffset: spec.position[1], scoreValue: 25 });
    mesh.position.fromArray(spec.position);
    mesh.updateMatrixWorld(true);
    actor.userData.label = spec.label;
    tintGameplayPrefabActor(actor, '#ef4444', '#ef4444', 1.4);
    rebuildActorPhysics(actor);
    setActorResetTransform(actor, spec.position, mesh.quaternion);
    return actor;
}

function spawnSoccerGoalie(spec) {
    if (!Array.isArray(spec?.position) || spec.position.length !== 3) return null;

    const size = Array.isArray(spec.size) && spec.size.length === 3
        ? spec.size
        : [SOCCER_FIELD_LEVEL_SCALE * 1.7, SOCCER_FIELD_LEVEL_SCALE * 1.35, SOCCER_FIELD_LEVEL_SCALE * 0.24];
    const actor = spawnDynamicPrimitive('cube', new THREE.Vector3(...spec.position), 1, {
        local: false,
        includeCollisionBody: true,
        simulatePhysics: false,
        includeScripts: false,
        skipImpulse: true,
        userData: {
            label: spec.label || 'Soccer Goalie Wall',
            soccerGoalie: true,
            kinematic: true,
            friction: 0.88,
            restitution: 0.12,
            soccerGoalieMotion: {
                homePosition: [...spec.position],
                axis: Array.isArray(spec.axis) && spec.axis.length === 3 ? [...spec.axis] : [1, 0, 0],
                amplitude: Number.isFinite(spec.amplitude) ? spec.amplitude : SOCCER_FIELD_LEVEL_SCALE * 1.65,
                speed: Number.isFinite(spec.speed) ? spec.speed : 1.7,
                phase: Number.isFinite(spec.phase) ? spec.phase : 0,
            },
        },
        returnActor: true,
    });
    const mesh = getActorRenderObject(actor);
    if (!actor || !mesh) return null;

    mesh.position.fromArray(spec.position);
    mesh.scale.set(
        Math.max(0.08, size[0] * 0.5),
        Math.max(0.08, size[1] * 0.5),
        Math.max(0.04, size[2] * 0.5)
    );
    mesh.name = spec.label || 'Soccer Goalie Wall';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    actor.userData.label = mesh.name;
    actor.userData.soccerGoalie = true;
    tintGameplayPrefabActor(actor, '#ef4444', '#7f1d1d', 0.42);
    rebuildActorPhysics(actor);
    setActorResetTransform(actor, spec.position, mesh.quaternion);
    return actor;
}

function spawnSoccerPlayerSpawn(spec) {
    const actor = spawnDynamicPrimitive('capsule', new THREE.Vector3(...spec.position), 0.75, {
        local: false,
        includeCollisionBody: false,
        includeScripts: false,
        skipImpulse: true,
        userData: { label: spec.label, playerIndex: spec.playerIndex },
        returnActor: true,
    });
    const mesh = getActorRenderObject(actor);
    if (!actor || !mesh) return null;

    mesh.position.fromArray(spec.position);
    mesh.name = spec.label;
    tagGameplayPrefabActor(actor, 'playerSpawn', { triggerRadius: 0.9, groundOffset: spec.position[1] });
    mesh.position.fromArray(spec.position);
    mesh.updateMatrixWorld(true);
    actor.userData.label = spec.label;
    actor.userData.playerIndex = spec.playerIndex;
    tintGameplayPrefabActor(actor, spec.color || '#22c55e', spec.color || '#22c55e', 1.8);
    setActorResetTransform(actor, spec.position, mesh.quaternion);
    if (spec.playerIndex === 1) {
        applyPlayerSpawnFromActor(actor);
    }
    return actor;
}

function spawnSoccerBall() {
    const actor = spawnDynamicPrimitive('sphere', new THREE.Vector3(0, 0.54, 0), 0.38, {
        local: false,
        includeCollisionBody: true,
        simulatePhysics: true,
        includeScripts: false,
        skipImpulse: true,
        mass: 0.45,
        restitution: 0.62,
        friction: 0.72,
        userData: { label: 'Soccer Ball' },
        returnActor: true,
    });
    if (!actor) return null;

    setActorColor(actor, '#f8fafc');
    const mesh = getActorRenderObject(actor);
    if (!mesh) return actor;

    mesh.name = 'Soccer Ball';
    setActorResetTransform(actor, [0, 0.54, 0], mesh.quaternion);
    const patchMaterial = new THREE.MeshStandardMaterial({
        color: 0x111827,
        roughness: 0.56,
        metalness: 0.02,
    });
    const patchPositions = [
        [0, 0.39, 0],
        [0.31, 0.14, 0.18],
        [-0.31, 0.14, 0.18],
        [0.0, 0.14, -0.36],
        [0.22, -0.22, -0.24],
        [-0.22, -0.22, 0.24],
    ];
    patchPositions.forEach((position, index) => {
        const patch = new THREE.Mesh(new THREE.CircleGeometry(0.105, 6), patchMaterial.clone());
        patch.name = `Soccer_Ball_Patch_${index + 1}`;
        patch.position.fromArray(position);
        patch.lookAt(position[0] * 2, position[1] * 2, position[2] * 2);
        patch.userData.skipPhysicsCollision = true;
        mesh.add(patch);
    });
    return actor;
}

function createSoccerLevelDefinition({
    id = 'soccerField',
    assetName = 'Soccer Field',
    sceneName = 'Soccer_Field',
    hideTerrainPresentation = true,
} = {}) {
    return {
        id,
        assetName,
        fileSize: 160000,
        create: () => createSoccerTargetFieldScene({
            name: sceneName,
            hideTerrainPresentation,
        }),
        afterLoad: () => {
            soccerGoalieState.elapsed = 0;
            const playerSpawns = Array.isArray(currentMesh.userData?.soccerPlayerSpawns)
                ? currentMesh.userData.soccerPlayerSpawns.map(spawnSoccerPlayerSpawn).filter(Boolean)
                : [];
            const goalTargets = Array.isArray(currentMesh.userData?.soccerGoalTargets)
                ? currentMesh.userData.soccerGoalTargets.map(spawnSoccerGoalTarget).filter(Boolean)
                : [];
            const goalies = Array.isArray(currentMesh.userData?.soccerGoalies)
                ? currentMesh.userData.soccerGoalies.map(spawnSoccerGoalie).filter(Boolean)
                : [];
            const soccerBall = spawnSoccerBall();
            updateSoccerGoalies(0);
            return playerSpawns[0] || goalTargets[0] || goalies[0] || soccerBall || null;
        },
    };
}

function createFlatTerrainLevelDefinition({
    id = 'soccerFieldTerrain',
    assetName = 'Terrain',
    sceneName = 'Terrain',
} = {}) {
    return {
        id,
        assetName,
        fileSize: 48000,
        create: () => {
            const root = new THREE.Group();
            root.name = sceneName;
            root.userData.sampleType = 'flatTerrainLevel';
            root.userData.hideTerrainPresentation = true;
            root.userData.skipNormalization = true;
            root.userData.preferredSpawn = {
                position: [0, 1.35, 18],
                yaw: Math.PI,
                pitch: -0.08,
            };
            root.userData.preferredShowcase = {
                position: [28, 18, 28],
                target: [0, 0.4, 0],
            };

            const terrain = createTerrainMesh();
            terrain.name = 'Flat_Terrain_Surface';
            terrain.castShadow = false;
            terrain.receiveShadow = true;
            const position = terrain.geometry?.getAttribute?.('position');
            if (position) {
                for (let index = 0; index < position.count; index += 1) {
                    position.setZ(index, 0);
                }
                position.needsUpdate = true;
                terrain.geometry.computeVertexNormals();
                terrain.geometry.computeBoundingSphere();
                terrain.geometry.computeBoundingBox();
            }
            setTerrainModeGrid(terrain);
            terrain.material.color.set('#ffffff');
            terrain.material.roughness = 0.96;
            terrain.material.metalness = 0.01;
            terrain.material.needsUpdate = true;
            const terrainActor = makeSampleLevelMeshActor('Flat_Terrain_Surface', terrain, {
                kind: 'imported',
                castShadow: false,
                receiveShadow: true,
                userData: {
                    flatTerrainActor: true,
                    terrainBrushTarget: true,
                },
            });
            const terrainMesh = getActorRenderObject(terrainActor);
            if (terrainMesh) root.add(terrainMesh);
            return root;
        },
        afterLoad: () => Array.from(sceneSystem?.actors || []).find((actor) => actorBelongsToCurrentMesh(actor)) || null,
    };
}

function getBuiltinLevelDefinition(levelId = 'soccerField') {
    if (levelId === 'fpsStarter') {
        return {
            id: 'fpsStarter',
            assetName: 'Sample Level',
            fileSize: 420000,
            create: createFpsStarterLevel,
        };
    }

    if (levelId === 'soccerFieldTerrain') {
        return createFlatTerrainLevelDefinition();
    }

    return createSoccerLevelDefinition();
}

function loadSample(levelId = 'soccerField') {
    clearCurrentMesh();

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
    renderer.setSize(container.clientWidth, container.clientHeight);
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

        if (worldFloor) worldFloor.visible = false;
        if (water?.mesh) water.mesh.visible = false;
        if (grassField?.setVisible) grassField.setVisible(false);
        else if (grassField?.mesh) grassField.mesh.visible = false;
        return;
    }

    if (!samplePresentationState.overridden) return;

    if (worldFloor) worldFloor.visible = samplePresentationState.terrainVisible;
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
    worldFloor?.add(helper);
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
    if (!sceneSystem?.actors?.size || !currentMesh) return false;
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

    return worldFloor || null;
}

function getTerrainHitFromEvent(event) {
    const target = getTerrainBrushTargetObject();
    if (!renderer || !target) return null;
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
    helper.material.color.set(terrainBrushState.tool.includes('foliage') ? foliagePreviewColor : terrainBrushState.tool === 'paint' ? terrainBrushState.paintColor : 0x00ffaa);
    return terrainHit;
}

function applyTerrainBrushFromEvent(event) {
    const terrainHit = updateTerrainBrushPreview(event);
    if (!terrainHit) return false;

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
    return {
        terrain: serializeTerrainState(worldFloor),
        foliage: grassField?.serializeFoliage?.() ?? null,
    };
}

function applyWorldTerrainState(data = {}) {
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

function setupTerrainPanel() {
    const modeSel = document.getElementById('terrain-mode');
    const colorIn = document.getElementById('terrain-color');
    const repeatIn = document.getElementById('terrain-repeat');
    const repeatVal = document.getElementById('terrain-repeat-value');
    const roughIn = document.getElementById('terrain-roughness');
    const roughVal = document.getElementById('terrain-roughness-value');
    const summary = document.getElementById('terrain-summary-value');
    const loadBtn = document.getElementById('terrain-load-image');
    const loadInput = document.getElementById('terrain-image-input');
    const sculptOff = document.getElementById('terrain-sculpt-off');
    const sculptOn = document.getElementById('terrain-sculpt-on');
    const sculptTool = document.getElementById('terrain-sculpt-tool');
    const sculptRadius = document.getElementById('terrain-sculpt-radius');
    const sculptRadiusVal = document.getElementById('terrain-sculpt-radius-value');
    const sculptStrength = document.getElementById('terrain-sculpt-strength');
    const sculptStrengthVal = document.getElementById('terrain-sculpt-strength-value');
    const sculptFlatten = document.getElementById('terrain-flatten-height');
    const sculptFlattenVal = document.getElementById('terrain-flatten-height-value');
    const sculptPaintColor = document.getElementById('terrain-paint-color');
    const foliageType = document.getElementById('terrain-foliage-type');
    const foliageDensity = document.getElementById('terrain-foliage-density');
    const foliageDensityVal = document.getElementById('terrain-foliage-density-value');

    const grassOff = document.getElementById('grass-off');
    const grassOn = document.getElementById('grass-on');
    const grassBase = document.getElementById('grass-base-color');
    const grassTip = document.getElementById('grass-tip-color');
    const grassWind = document.getElementById('grass-wind');
    const grassWindVal = document.getElementById('grass-wind-value');

    const updateSummary = () => {
        if (!summary) return;
        const mode = modeSel?.value ?? 'grid';
        summary.textContent = `${mode} · ${terrainBrushState.enabled ? 'sculpt' : colorIn?.value ?? '#fff'}`;
    };

    modeSel?.addEventListener('change', async () => {
        const mode = modeSel.value;
        if (mode === 'grid') await setTerrainModeGrid(worldFloor);
        else if (mode === 'solid') setTerrainModeSolid(worldFloor);
        else if (mode === 'grass') await setTerrainModeGrassPBR(worldFloor);
        else if (mode === 'custom') loadInput?.click();
        setTerrainRepeat(worldFloor, parseFloat(repeatIn?.value ?? 28));
        updateSummary();
    });

    colorIn?.addEventListener('input', () => {
        setTerrainTint(worldFloor, colorIn.value);
        updateSummary();
    });

    repeatIn?.addEventListener('input', () => {
        const v = parseFloat(repeatIn.value);
        if (repeatVal) repeatVal.textContent = String(v);
        setTerrainRepeat(worldFloor, v);
    });

    roughIn?.addEventListener('input', () => {
        const v = parseFloat(roughIn.value);
        if (roughVal) roughVal.textContent = v.toFixed(2);
        setTerrainRoughness(worldFloor, v);
    });

    loadBtn?.addEventListener('click', () => loadInput?.click());
    loadInput?.addEventListener('change', () => {
        const file = loadInput.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            setTerrainCustomImage(worldFloor, reader.result);
            if (modeSel) modeSel.value = 'custom';
            updateSummary();
        };
        reader.readAsDataURL(file);
    });

    const setSculptEnabled = (enabled) => {
        terrainBrushState.enabled = enabled;
        terrainBrushState.active = false;
        sculptOn?.classList.toggle('viewer-toggle-btn-active', enabled);
        sculptOff?.classList.toggle('viewer-toggle-btn-active', !enabled);
        if (!enabled && terrainBrushState.helper) terrainBrushState.helper.visible = false;
        updateSummary();
    };
    sculptOn?.addEventListener('click', () => setSculptEnabled(true));
    sculptOff?.addEventListener('click', () => setSculptEnabled(false));

    sculptTool?.addEventListener('change', () => {
        terrainBrushState.tool = sculptTool.value;
    });
    sculptRadius?.addEventListener('input', () => {
        const v = parseFloat(sculptRadius.value);
        terrainBrushState.radius = v;
        if (sculptRadiusVal) sculptRadiusVal.textContent = v.toFixed(1);
    });
    sculptStrength?.addEventListener('input', () => {
        const v = parseFloat(sculptStrength.value);
        terrainBrushState.strength = v;
        if (sculptStrengthVal) sculptStrengthVal.textContent = v.toFixed(2);
    });
    sculptFlatten?.addEventListener('input', () => {
        const v = parseFloat(sculptFlatten.value);
        terrainBrushState.flattenHeight = v;
        if (sculptFlattenVal) sculptFlattenVal.textContent = v.toFixed(1);
    });
    sculptPaintColor?.addEventListener('input', () => {
        terrainBrushState.paintColor = sculptPaintColor.value;
    });
    foliageType?.addEventListener('change', () => {
        terrainBrushState.foliageType = foliageType.value;
    });
    foliageDensity?.addEventListener('input', () => {
        const v = parseInt(foliageDensity.value, 10);
        terrainBrushState.foliageDensity = v;
        if (foliageDensityVal) foliageDensityVal.textContent = String(v);
    });

    const setGrassEnabled = (enabled) => {
        if (grassField?.setVisible) grassField.setVisible(enabled);
        else if (grassField?.mesh) grassField.mesh.visible = enabled;
        grassOn?.classList.toggle('viewer-toggle-btn-active', enabled);
        grassOff?.classList.toggle('viewer-toggle-btn-active', !enabled);
    };
    grassOn?.addEventListener('click', () => setGrassEnabled(true));
    grassOff?.addEventListener('click', () => setGrassEnabled(false));

    const applyGrassColors = () => {
        if (!grassField) return;
        const base = new THREE.Color(grassBase?.value ?? '#2f5a1c');
        const tip = new THREE.Color(grassTip?.value ?? '#a8d96b');
        grassField.setColors?.(base, tip);
    };
    grassBase?.addEventListener('input', applyGrassColors);
    grassTip?.addEventListener('input', applyGrassColors);

    grassWind?.addEventListener('input', () => {
        const v = parseFloat(grassWind.value);
        if (grassWindVal) grassWindVal.textContent = v.toFixed(2);
        grassField?.setWind?.(1, 0.3, v);
    });

    const spriteLoadBtn = document.getElementById('grass-sprite-load');
    const spriteClearBtn = document.getElementById('grass-sprite-clear');
    const spriteInput = document.getElementById('grass-sprite-input');
    const spriteStatus = document.getElementById('grass-sprite-status');
    const spriteTintIn = document.getElementById('grass-sprite-tint');
    const spriteTintVal = document.getElementById('grass-sprite-tint-value');
    const alphaCutoffIn = document.getElementById('grass-alpha-cutoff');
    const alphaCutoffVal = document.getElementById('grass-alpha-cutoff-value');

    spriteLoadBtn?.addEventListener('click', () => spriteInput?.click());
    spriteInput?.addEventListener('change', () => {
        const file = spriteInput.files?.[0];
        if (!file || !grassField) return;
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                await grassField.setSpriteFromUrl?.(reader.result);
                if (spriteStatus) spriteStatus.textContent = `Loaded: ${file.name}`;
            } catch (err) {
                console.error('Grass sprite load failed', err);
                if (spriteStatus) spriteStatus.textContent = `Failed to load ${file.name}`;
            }
        };
        reader.readAsDataURL(file);
    });
    spriteClearBtn?.addEventListener('click', () => {
        grassField?.clearSprite?.();
        if (spriteStatus) spriteStatus.textContent = 'Sprite cleared — using procedural blades.';
    });

    spriteTintIn?.addEventListener('input', () => {
        const v = parseFloat(spriteTintIn.value);
        if (spriteTintVal) spriteTintVal.textContent = v.toFixed(2);
        grassField?.setSpriteTint?.(v);
    });

    alphaCutoffIn?.addEventListener('input', () => {
        const v = parseFloat(alphaCutoffIn.value);
        if (alphaCutoffVal) alphaCutoffVal.textContent = v.toFixed(2);
        grassField?.setAlphaTest?.(v);
    });

    updateSummary();
}

function setupGameplayEvents() {
    const resumeAudio = () => {
        runtimeAudio.resume();
    };

    document.addEventListener('pointerdown', resumeAudio, { passive: true });
    document.addEventListener('touchend', resumeAudio, { passive: true });
    document.addEventListener('keydown', resumeAudio);
    document.addEventListener('pointerlockchange', handlePointerLockChange);
    document.addEventListener('mousemove', handleGameplayMouseMove);
    document.addEventListener('keydown', handleDebugConsoleKeydown, true);
    document.addEventListener('keydown', handleGameplayKeyEvent);
    document.addEventListener('keyup', handleGameplayKeyEvent);
    renderer.domElement.addEventListener('mousedown', handleShowcaseMouseButton);
    window.addEventListener('mouseup', handleShowcaseMouseButton);
    renderer.domElement.addEventListener('wheel', handleShowcaseWheel, { passive: false });
    renderer.domElement.addEventListener('contextmenu', handleShowcaseContextMenu);
    renderer.domElement.addEventListener('click', handleLightGridClick);
    // Blueprint mode: click on 3D viewport to select child components
    renderer.domElement.addEventListener('click', (event) => {
        if (!blueprintState.active) return;
        if (event.button !== 0) return;
        if (typeof transformControl !== 'undefined' && (transformControl.dragging || transformControl.justFinishedDragging || transformControl.axis !== null)) return;
        if (isTransformControlSphereHit(event)) return;
        
        const rect = renderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        
        pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointerNdc, camera);
        
        const rootMesh = getActorRenderObject(blueprintState.targetActor);
        if (!rootMesh) return;
        
        // Collect all meshes and lights in the actor tree
        const allChildren = [];
        rootMesh.traverse((child) => {
            if (child.isMesh || child.isLight) allChildren.push(child);
        });
        
        const hits = raycaster.intersectObjects(allChildren, false);
        if (hits.length > 0) {
            const hitObj = hits[0].object;
            blueprintState.selectedComponent = hitObj;
            blueprintState.selectedComponents.clear();
            blueprintState.materialMultiSelectActive = false;
            if (hitObj.isMesh) blueprintState.selectedComponents.add(hitObj);
            if (typeof transformControl !== 'undefined') transformControl.attach(hitObj);
            refreshBlueprintComponents();
        }
    });
    
    renderer.domElement.addEventListener('dblclick', (event) => {
        // Blueprint mode: double-click to focus camera on a component
        if (blueprintState.active) {
            const rect = renderer.domElement.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(pointerNdc, camera);
            
            const rootMesh = getActorRenderObject(blueprintState.targetActor);
            if (!rootMesh) return;
            const allChildren = [];
            rootMesh.traverse((child) => {
                if (child.isMesh || child.isLight) allChildren.push(child);
            });
            
            const hits = raycaster.intersectObjects(allChildren, false);
            if (hits.length > 0) {
                const hitObj = hits[0].object;
                blueprintState.selectedComponent = hitObj;
                blueprintState.selectedComponents.clear();
                blueprintState.materialMultiSelectActive = false;
                if (hitObj.isMesh) blueprintState.selectedComponents.add(hitObj);
                if (typeof transformControl !== 'undefined') transformControl.attach(hitObj);
                refreshBlueprintComponents();
                
                focusShowcaseCameraOnObject(hitObj, { duration: 0.5 });
            }
            return;
        }
        
        if (gameplay.active) return;
        const propHit = getDynamicPropHitFromEvent(event);
        if (propHit?.prop) {
            selectShowcaseActor(propHit.prop.id, propHit.hit?.object ?? null);
            focusShowcaseCameraOnObject(propHit.hit?.object ?? getActorRenderObject(propHit.prop), { duration: 0.55 });
            
            if (sceneUiList) {
                const activeItem = sceneUiList.querySelector(`[data-id="${propHit.prop.id}"]`);
                if (activeItem) {
                    activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        }
    });
    renderer.domElement.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse') return;
        if (gameplay.active) {
            if (runMouseAction('left', event)) {
                event.preventDefault();
            }
            return;
        }
        if (maybeOpenObjectScriptMenuFromMobileTap(event)) {
            const focusedProp = getDynamicPropById(objectScriptState.targetPropId);
            focusShowcaseCameraOnObject(getActorRenderObject(focusedProp), { duration: 0.55 });
            event.preventDefault();
        }
    }, { passive: false });
}

function adjustShowcaseSpeed(direction) {
    const factor = direction > 0 ? showcase.wheelSpeedStep : 1 / showcase.wheelSpeedStep;
    showcase.moveSpeed = THREE.MathUtils.clamp(
        showcase.moveSpeed * factor,
        showcase.minMoveSpeed,
        showcase.maxMoveSpeed
    );
    updateGameplayUI();
}

function updateShowcaseInput(event, isDown) {
    if (!showcase.looking && (event.code === 'KeyE' || event.code === 'KeyQ' || event.code === 'Space' || event.code === 'ControlLeft' || event.code === 'ControlRight')) {
        return false;
    }
    switch (event.code) {
        case 'KeyW':
        case 'ArrowUp':
            showcase.input.forward = isDown;
            return true;
        case 'KeyS':
        case 'ArrowDown':
            showcase.input.back = isDown;
            return true;
        case 'KeyA':
        case 'ArrowLeft':
            showcase.input.left = isDown;
            return true;
        case 'KeyD':
        case 'ArrowRight':
            showcase.input.right = isDown;
            return true;
        case 'KeyE':
        case 'Space':
            showcase.input.up = isDown;
            return true;
        case 'KeyQ':
        case 'ControlLeft':
        case 'ControlRight':
            showcase.input.down = isDown;
            return true;
        case 'ShiftLeft':
        case 'ShiftRight':
            showcase.input.boost = isDown;
            return true;
        default:
            return false;
    }
}

function handleGameplayKeyEvent(event) {
    const isDown = event.type === 'keydown';
    const eventTarget = event.target instanceof HTMLElement ? event.target : document.activeElement;

    if (debugConsoleState.visible) {
        if (gameplay.pointerLocked || gameplay.active) {
            event.preventDefault();
        }
        return;
    }

    if (isDown && !event.repeat && event.code === 'F8') {
        setCollisionDebugEnabled(!collisionDebugState.enabled);
        event.preventDefault();
        return;
    }

    if (isDown && !event.repeat && event.code === 'KeyL' && !isEditableElement(eventTarget)) {
        void playAudioTestCue();
        event.preventDefault();
        return;
    }

    if (!gameplay.active && !gameplay.pointerLocked && isDown) {
        if (event.code === 'Delete') {
            if (blueprintState.active) {
                editorHistory.captureState();
                document.getElementById('btn-delete-comp')?.click();
            } else {
                deleteSelectedActor();
            }
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            if (event.code === 'KeyC') {
                copySelectedToClipboard();
                return;
            } else if (event.code === 'KeyV') {
                pasteFromClipboard();
                return;
            } else if (event.code === 'KeyZ') {
                if (event.shiftKey) {
                    editorHistory.redo();
                } else {
                    editorHistory.undo();
                }
                return;
            } else if (event.code === 'KeyY') {
                editorHistory.redo();
                return;
            } else if (event.code === 'KeyD') {
                duplicateSelected();
                event.preventDefault();
                return;
            }
        }
        if (!event.repeat && event.code === 'KeyF' && !isEditableElement(eventTarget)) {
            if (focusCurrentShowcaseSelection()) {
                event.preventDefault();
            }
            return;
        }
        if (!showcase.looking && event.code === 'KeyW') {
            transformControl?.setMode('translate');
            if (blueprintState.active) updateBlueprintTransformUI();
        } else if (!showcase.looking && event.code === 'KeyE') {
            transformControl?.setMode('rotate');
            if (blueprintState.active) updateBlueprintTransformUI();
        } else if (!showcase.looking && event.code === 'KeyR') {
            transformControl?.setMode('scale');
            if (blueprintState.active) updateBlueprintTransformUI();
        } else if (!showcase.looking && event.code === 'Backquote') { // Tilde key for toggling space
            if (transformControl) {
                transformControl.setSpace(transformControl.space === 'local' ? 'world' : 'local');
                if (blueprintState.active) updateBlueprintTransformUI();
            }
        }
    }

    if (!gameplay.active && !gameplay.pointerLocked) {
        const acceptsShowcaseInput = renderer && (showcase.looking || document.activeElement === renderer.domElement);
        if (acceptsShowcaseInput && updateShowcaseInput(event, isDown)) {
            event.preventDefault();
            return;
        }
    }

    if (!gameplay.canPlay) return;

    switch (event.code) {
        case 'KeyW':
        case 'ArrowUp':
            gameplay.input.forward = isDown;
            break;
        case 'KeyS':
        case 'ArrowDown':
            gameplay.input.back = isDown;
            break;
        case 'KeyA':
        case 'ArrowLeft':
            gameplay.input.left = isDown;
            break;
        case 'KeyD':
        case 'ArrowRight':
            gameplay.input.right = isDown;
            break;
        case 'ShiftLeft':
        case 'ShiftRight':
            gameplay.input.sprint = isDown;
            break;
        case 'Space':
            if (gameplay.pointerLocked) event.preventDefault();
            if (isDown && !event.repeat && gameplay.active) {
                if (isDrivingVehicle()) {
                    vehicleState.brakeHeld = true;
                } else {
                    physics.jumpQueued = true;
                }
            } else if (!isDown) {
                vehicleState.brakeHeld = false;
            }
            break;
        case 'KeyE':
            if (isDown && !event.repeat && gameplay.active) {
                if (isDrivingVehicle()) {
                    exitVehicle();
                } else {
                    enterVehicle();
                }
            }
            break;
        case 'KeyV':
            if (isDown && !event.repeat && gameplay.active) {
                spawnDrivableCar();
            }
            break;
        case 'KeyR':
            if (isDown && gameplay.active) {
                if (isDrivingVehicle()) {
                    exitVehicle();
                }
                respawnPlayer();
            }
            break;
        default:
            return;
    }

    if (gameplay.pointerLocked) {
        event.preventDefault();
    }
}

function handleGameplayMouseMove(event) {
    if (!gameplay.pointerLocked) {
        if (terrainBrushState.enabled && !showcase.looking && !blueprintState.active && !gameplay.active) {
            if (terrainBrushState.active) {
                applyTerrainBrushFromEvent(event);
            } else {
                updateTerrainBrushPreview(event);
            }
            return;
        }
        if (!showcase.looking || gameplay.active) return;

        showcase.yaw -= event.movementX * 0.0022;
        showcase.pitch -= event.movementY * 0.0018;
        showcase.pitch = THREE.MathUtils.clamp(
            showcase.pitch,
            -PLAYER_SETTINGS.maxLookPitch,
            PLAYER_SETTINGS.maxLookPitch
        );

        applyShowcaseCameraRotation();
        return;
    }

    gameplay.yaw -= event.movementX * 0.0022;
    gameplay.pitch -= event.movementY * 0.0018;
    gameplay.pitch = THREE.MathUtils.clamp(
        gameplay.pitch,
        -PLAYER_SETTINGS.maxLookPitch,
        PLAYER_SETTINGS.maxLookPitch
    );

    applyGameplayCameraRotation();
}

function handleShowcaseMouseButton(event) {
    // In blueprint mode, don't let the normal actor selection logic
    // intercept clicks — TransformControls needs those events for gizmo drag
    if (blueprintState.active) {
        if (event.type === 'mousedown' && event.button === 2) {
            showcase.looking = true;
            event.preventDefault();
        } else if (event.type === 'mouseup' && event.button === 2) {
            showcase.looking = false;
        }
        return;
    }

    if (gameplay.active) {
        if (event.type === 'mousedown') {
            const buttonName = event.button === 2 ? 'right' : event.button === 0 ? 'left' : null;
            if (buttonName) {
                runMouseAction(buttonName, event);
            }
        }
        return;
    }

    if (gameplay.active || gameplay.pointerLocked || !renderer) return;

    if (event.type === 'mousedown') {
        renderer.domElement.focus();
        if (terrainBrushState.enabled && event.button === 0) {
            terrainBrushState.active = true;
            applyTerrainBrushFromEvent(event);
            event.preventDefault();
            return;
        }
        if (event.button === 0 && objectScriptState.menuOpen) {
            closeObjectScriptMenu();
        }
        // Left-click: select actor and attach gizmo
        if (event.button === 0) {
            if (isTransformControlSphereHit(event)) {
                event.preventDefault();
                return;
            }
            const propHit = getDynamicPropHitFromEvent(event);
            if (propHit?.prop) {
                selectShowcaseActor(propHit.prop.id, propHit.hit?.object ?? null);
            } else {
                // Clicked empty space — deselect
                selectShowcaseActor(null);
            }
            return;
        }
        if (event.button !== 2) return;
        closeObjectScriptMenu();
        showcase.looking = true;
        event.preventDefault();
        return;
    }

    if (event.button === 0 && terrainBrushState.active) {
        terrainBrushState.active = false;
        if (terrainBrushState.dirtyPhysics) {
            if (terrainBrushState.targetObject && terrainBrushState.targetObject !== worldFloor) {
                rebuildModelPhysicsBody();
            } else {
                rebuildTerrainPhysicsBody();
            }
            terrainBrushState.dirtyPhysics = false;
        }
        event.preventDefault();
        return;
    }

    if (event.button === 2) {
        showcase.looking = false;
    }
}

function handleShowcaseContextMenu(event) {
    if (gameplay.active || gameplay.pointerLocked || !renderer) {
        event.preventDefault();
        return;
    }

    if (isTransformControlSphereHit(event)) {
        event.preventDefault();
        return;
    }

    event.preventDefault();
    closeObjectScriptMenu();
}

function handleShowcaseWheel(event) {
    if (gameplay.active || gameplay.pointerLocked) return;

    event.preventDefault();
    adjustShowcaseSpeed(event.deltaY < 0 ? 1 : -1);
}

function handlePointerLockChange() {
    const isLocked = document.pointerLockElement === renderer.domElement;

    if (isLocked) {
        gameplay.pointerLocked = true;
        gameplay.active = true;
        showcase.looking = false;
        syncTransformControlState();
        closeObjectScriptMenu();
        closeObjectScriptEditor();
        updateWorldPresentation();
        updateGameplayUI();
        renderer.domElement.focus();
        return;
    }

    if (!gameplay.pointerLocked && !gameplay.active) return;

    gameplay.pointerLocked = false;
    gameplay.active = false;
    gameplay.velocity.set(0, 0, 0);
    physics.desiredVelocity.set(0, 0, 0);
    resetMovementInputState();
    restoreSceneState();
    repairSampleCollisionHierarchyAfterRestore();
    syncTransformControlState();

    updateWorldPresentation();
    resetShowcaseCamera(false);
    updateGameplayUI();
}

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

    if (!mobileState.enabled) {
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
    if (!mobileState.enabled && document.pointerLockElement === renderer.domElement) {
        document.exitPointerLock();
        return;
    }

    if (!gameplay.active && !gameplay.pointerLocked) return;

    gameplay.pointerLocked = false;
    gameplay.active = false;
    clearActiveVehicle();
    restoreSceneState();
    repairSampleCollisionHierarchyAfterRestore();
    resetSoccerLevelState();
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
    if (!mobileState.enabled && document.pointerLockElement === renderer?.domElement) {
        document.exitPointerLock?.();
    }

    gameplay.pointerLocked = false;
    gameplay.active = false;
    clearActiveVehicle();
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

function updateGameplayUI() {
    const hasAsset = !!currentMesh;
    const mobileActive = mobileState.enabled;
    const drivingVehicle = isDrivingVehicle();

    if (resetViewBtn) {
        resetViewBtn.textContent = gameplay.active ? 'Respawn' : 'Reset View';
    }

    updateCameraModeButtons();

    if (gameplayStatus) {
        if (mobileActive && drivingVehicle) {
            gameplayStatus.textContent = 'Mobile driving active';
        } else if (mobileActive && gameplay.active) {
            gameplayStatus.textContent = 'Mobile play active';
        } else if (mobileActive) {
            gameplayStatus.textContent = 'Mobile showcase ready';
        } else if (drivingVehicle) {
            gameplayStatus.textContent = 'Driving summoned car';
        } else if (!hasAsset && gameplay.active) {
            gameplayStatus.textContent = gameplay.grounded ? 'Exploring terrain' : 'Airborne';
        } else if (!hasAsset) {
            gameplayStatus.textContent = `Showcase free-fly ready. Camera speed ${showcase.moveSpeed.toFixed(1)}x.`;
        } else if (gameplay.active) {
            gameplayStatus.textContent = gameplay.grounded ? 'Exploring scene' : 'Airborne';
        } else {
            gameplayStatus.textContent = `Scene ready. Showcase speed ${showcase.moveSpeed.toFixed(1)}x.`;
        }
    }

    if (playHint) {
        if (mobileActive && drivingVehicle) {
            playHint.textContent = 'Touch left pad to drive, right pad to look, hold Brake to slow down, tap the scene for play scripts, and tap E on keyboard to hop out.';
        } else if (mobileActive && gameplay.active) {
            playHint.textContent = 'Touch left pad to move, right pad to look, tap the scene to run play scripts, and use Jump to hop.';
        } else if (mobileActive) {
            playHint.textContent = 'Touch left pad to move, right pad to look, double-tap a prop to open its script menu, and use Menu for assets.';
        } else if (drivingVehicle) {
            playHint.textContent = 'W/S drive, A/D steer, Shift boost, Space brake, E exit car, R respawn, Esc exit play mode.';
        } else if (!hasAsset && gameplay.active) {
            playHint.textContent = 'WASD move, mouse look, Space jump, Shift sprint, E enter nearby car, V summon car, R respawn, Esc exit.';
        } else if (!hasAsset) {
            playHint.textContent = 'Showcase: hold right mouse to look, use WASD to move, Q/E for down/up, Shift to boost, and mouse wheel to change camera speed.';
        } else if (gameplay.active) {
            playHint.textContent = 'WASD move, mouse look, Space jump, Shift sprint, E enter nearby car, V summon car, R respawn, Esc exit.';
        } else {
            playHint.textContent = 'Showcase: hold right mouse to look, use WASD to move, Q/E for down/up, Shift to boost, and mouse wheel to change camera speed. Play mode still uses pointer lock.';
        }
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

function updateShowcaseCamera(delta) {
    const moveRight = (showcase.input.right ? 1 : 0) - (showcase.input.left ? 1 : 0);
    const moveForward = (showcase.input.forward ? 1 : 0) - (showcase.input.back ? 1 : 0);
    const moveVertical = (showcase.input.up ? 1 : 0) - (showcase.input.down ? 1 : 0);

    tempVectorA.set(0, 0, 0);
    camera.getWorldDirection(tempVectorB);

    if (tempVectorB.lengthSq() < 1e-6) {
        tempVectorB.set(0, 0, -1);
    } else {
        tempVectorB.normalize();
    }

    tempVectorC.crossVectors(tempVectorB, upVector).normalize();

    tempVectorA
        .addScaledVector(tempVectorC, moveRight)
        .addScaledVector(tempVectorB, moveForward)
        .addScaledVector(upVector, moveVertical);

    if (tempVectorA.lengthSq() > 0) {
        tempVectorA.normalize();
    }

    const moveSpeed = showcase.moveSpeed * (showcase.input.boost ? showcase.boostMultiplier : 1);
    showcase.velocity.lerp(tempVectorA.multiplyScalar(moveSpeed), tempVectorA.lengthSq() > 0 ? 0.35 : 0.18);

    if (showcase.velocity.lengthSq() < 1e-5) {
        showcase.velocity.set(0, 0, 0);
        return;
    }

    camera.position.addScaledVector(showcase.velocity, delta);
}

function respawnPlayer(useStoredView = false) {
    if (!gameplay.canPlay && physics.ready) {
        gameplay.canPlay = true;
    }
    if (!gameplay.canPlay) return;

    resetGameplayPrefabs();

    if (isDrivingVehicle()) {
        clearActiveVehicle();
    }

    if (!physics.character) {
        ensurePlayerCharacter();
    }

    if (!physics.character) return;

    const spawnPosition = new physics.Jolt.RVec3(
        gameplay.spawnPoint.x,
        gameplay.spawnPoint.y,
        gameplay.spawnPoint.z
    );
    physics.character.SetPosition(spawnPosition);
    physics.Jolt.destroy(spawnPosition);
    physics.character.SetLinearVelocity(physics.Jolt.Vec3.prototype.sZero());
    gameplay.velocity.set(0, 0, 0);
    gameplay.grounded = true;

    if (useStoredView) {
        gameplay.yaw = gameplay.spawnYaw;
        gameplay.pitch = gameplay.spawnPitch;
    }

    syncCameraToCharacter();

    if (!useStoredView) {
        tempVectorA.copy(gameplayLookTarget).sub(camera.position);
        const flatDistance = Math.max(0.001, Math.hypot(tempVectorA.x, tempVectorA.z));
        gameplay.yaw = Math.atan2(tempVectorA.x, tempVectorA.z);
        gameplay.pitch = THREE.MathUtils.clamp(
            Math.atan2(-tempVectorA.y, flatDistance),
            -PLAYER_SETTINGS.maxLookPitch,
            PLAYER_SETTINGS.maxLookPitch
        );
        gameplay.spawnYaw = gameplay.yaw;
        gameplay.spawnPitch = gameplay.pitch;
    }

    applyGameplayCameraRotation();
    updateGameplayUI();
}

function applyGameplayCameraRotation() {
    camera.rotation.order = 'YXZ';
    camera.rotation.x = gameplay.pitch;
    camera.rotation.y = gameplay.yaw;
    camera.rotation.z = 0;
}

function updateVehicleGameplay(delta) {
    const vehicle = getActiveVehicleProp();
    if (!vehicle?.body) {
        clearActiveVehicle({ updateUi: true });
        return;
    }

    const { Jolt, bodyInterface } = physics;
    const bodyId = vehicle.body.GetID();
    const throttle = (gameplay.input.forward ? 1 : 0) - (gameplay.input.back ? 1 : 0);
    const steer = (gameplay.input.left ? 1 : 0) - (gameplay.input.right ? 1 : 0);
    const boostMultiplier = gameplay.input.sprint ? 1.35 : 1;
    const vehiclePosition = copyJoltVector(tempVectorA, bodyInterface.GetPosition(bodyId)).clone();
    const vehicleRotation = copyJoltQuaternion(tempQuaternionA, bodyInterface.GetRotation(bodyId)).clone();
    const flatForward = getVehicleForward(tempVectorB, vehicleRotation, true).clone();
    const vehicleUp = tempVectorC.set(0, 1, 0).applyQuaternion(vehicleRotation).normalize().clone();
    const vehicleForward = tempVectorA.set(0, 0, -1).applyQuaternion(vehicleRotation).normalize().clone();
    const vehicleRight = tempVectorB.set(1, 0, 0).applyQuaternion(vehicleRotation).normalize().clone();
    const linearVelocity = copyJoltVector(tempVectorD, bodyInterface.GetLinearVelocity(bodyId)).clone();
    const angularVelocity = copyJoltVector(tempVectorE, bodyInterface.GetAngularVelocity(bodyId)).clone();
    const flatRight = tempVectorC.crossVectors(flatForward, upVector).normalize().clone();
    const horizontalVelocity = tempVectorD.copy(linearVelocity).setY(0);
    const forwardSpeed = horizontalVelocity.dot(flatForward);
    const lateralSpeed = horizontalVelocity.dot(flatRight);
    const throttleInput = throttle;
    const speedRatio = THREE.MathUtils.clamp(Math.abs(forwardSpeed) / VEHICLE_SETTINGS.maxDriveSpeed, 0, 1);
    const driftInput = Math.abs(steer) > 0.1 && speedRatio > VEHICLE_SETTINGS.driftBoostThreshold;
    const drifting = driftInput && (throttle !== 0 || Math.abs(lateralSpeed) > 1.2);
    const halfWheelBase = VEHICLE_SETTINGS.wheelBase * 1.0;
    const halfTrackWidth = VEHICLE_SETTINGS.trackWidth * 0.5;
    const rideState = vehicle.mesh.userData.vehicleRideState || {
        sampleRideHeights: [null, null, null, null],
        compression: 0,
        contactRatio: 0,
        frontCompression: 0,
        rearCompression: 0,
        leftCompression: 0,
        rightCompression: 0,
        filteredGroundHeight: null,
    };
    vehicle.mesh.userData.vehicleRideState = rideState;
    const cornerSamples = [
        { forward: halfWheelBase, sideways: -halfTrackWidth },
        { forward: halfWheelBase, sideways: halfTrackWidth },
        { forward: -halfWheelBase, sideways: -halfTrackWidth },
        { forward: -halfWheelBase, sideways: halfTrackWidth },
    ].map((corner, index) => {
        const sampleX = vehiclePosition.x + flatForward.x * corner.forward + flatRight.x * corner.sideways;
        const sampleZ = vehiclePosition.z + flatForward.z * corner.forward + flatRight.z * corner.sideways;
        const sampleAnchorY = vehiclePosition.y
            + vehicleForward.y * corner.forward
            + vehicleRight.y * corner.sideways;
        const groundHeight = getGroundHeightAt(sampleX, sampleZ, true, {
            ignoreActor: vehicle,
            minSurfaceUpDot: 0.35,
            surfaceStepTolerance: 0,
            cullBackFaces: true,
            maxHitY: sampleAnchorY + 0.05,
        });
        const rideHeight = groundHeight === null ? null : vehiclePosition.y - groundHeight;
        rideState.sampleRideHeights[index] = rideHeight;
        const compression = rideHeight === null
            ? 0
            : THREE.MathUtils.clamp(VEHICLE_SETTINGS.suspensionRideHeight - rideHeight, 0, VEHICLE_SETTINGS.suspensionTravel);

        return {
            ...corner,
            rideHeight,
            compression,
        };
    });
    const contactSamples = cornerSamples.filter((corner) => corner.rideHeight !== null && corner.rideHeight <= VEHICLE_SETTINGS.suspensionRideHeight + VEHICLE_SETTINGS.suspensionTravel);
    const grounded = contactSamples.length > 0;
    const contactRatio = contactSamples.length / cornerSamples.length;
    const averageCompression = contactSamples.length
        ? Math.max(...contactSamples.map((corner) => corner.compression))
        : 0;
    const averageGroundHeight = contactSamples.length
        ? Math.max(...contactSamples.map((corner) => vehiclePosition.y - corner.rideHeight))
        : null;
    const frontCompression = Math.max(cornerSamples[0].compression, cornerSamples[1].compression);
    const rearCompression = Math.max(cornerSamples[2].compression, cornerSamples[3].compression);
    const leftCompression = Math.max(cornerSamples[0].compression, cornerSamples[2].compression);
    const rightCompression = Math.max(cornerSamples[1].compression, cornerSamples[3].compression);
    rideState.compression = averageCompression;
    rideState.contactRatio = contactRatio;
    rideState.frontCompression = frontCompression;
    rideState.rearCompression = rearCompression;
    rideState.leftCompression = leftCompression;
    rideState.rightCompression = rightCompression;
    const smoothedAverageCompression = averageCompression;
    const smoothedContactRatio = contactRatio;
    const smoothedFrontCompression = frontCompression;
    const smoothedRearCompression = rearCompression;
    const smoothedLeftCompression = leftCompression;
    const smoothedRightCompression = rightCompression;
    let filteredGroundHeight = averageGroundHeight;
    rideState.filteredGroundHeight = filteredGroundHeight;
    const targetForwardSpeed = grounded && throttle > 0
        ? VEHICLE_SETTINGS.maxDriveSpeed * boostMultiplier
        : grounded && throttle < 0
            ? -VEHICLE_SETTINGS.maxReverseSpeed
            : 0;
    const forwardLambda = grounded && throttle > 0
        ? (gameplay.input.sprint ? VEHICLE_SETTINGS.boostAcceleration : VEHICLE_SETTINGS.acceleration)
        : grounded && throttle < 0
            ? VEHICLE_SETTINGS.reverseAcceleration
            : grounded
                ? VEHICLE_SETTINGS.coastDrag
                : 0;
    let nextForwardSpeed = THREE.MathUtils.damp(forwardSpeed, targetForwardSpeed, forwardLambda, delta);
    nextForwardSpeed *= 1 - (VEHICLE_SETTINGS.rollingDrag * delta);
    const gripBase = speedRatio >= 0.5
        ? VEHICLE_SETTINGS.highSpeedGrip
        : VEHICLE_SETTINGS.lowSpeedGrip;

    const gripLambda = vehicleState.brakeHeld
        ? VEHICLE_SETTINGS.brakeGrip
        : drifting
            ? VEHICLE_SETTINGS.driftGrip
            : gripBase;

    const contactGrip = grounded
        ? gripLambda
        : VEHICLE_SETTINGS.partialContactGrip;
    const nextLateralSpeed = THREE.MathUtils.damp(lateralSpeed, 0, contactGrip, delta);
    const nextHorizontalVelocity = tempVectorE
        .copy(flatForward)
        .multiplyScalar(nextForwardSpeed)
        .addScaledVector(flatRight, nextLateralSpeed);

    if (vehicleState.brakeHeld) {
        nextHorizontalVelocity.multiplyScalar(VEHICLE_SETTINGS.brakeDamping);
    }

    let nextVerticalVelocity = linearVelocity.y;
    if (grounded && filteredGroundHeight !== null) {
        const targetBodyHeight = filteredGroundHeight + VEHICLE_SETTINGS.suspensionRideHeight - VEHICLE_SETTINGS.suspensionTravel * 0.5;
        const heightError = targetBodyHeight - vehiclePosition.y;
        const springForce = heightError * VEHICLE_SETTINGS.suspensionSpring * 9.81;
        const damperForce = -linearVelocity.y * VEHICLE_SETTINGS.suspensionDamping;
        nextVerticalVelocity = linearVelocity.y + (springForce + damperForce) * delta;
    }

    const nextVelocity = new Jolt.Vec3(nextHorizontalVelocity.x, nextVerticalVelocity, nextHorizontalVelocity.z);
    bodyInterface.SetLinearVelocity(bodyId, nextVelocity);
    Jolt.destroy(nextVelocity);

    const steerSpeedFactor = THREE.MathUtils.clamp(Math.abs(nextForwardSpeed) / VEHICLE_SETTINGS.maxDriveSpeed, 0, 1);
    const steeringDirection = nextForwardSpeed >= 0 ? 1 : -0.7;
    const steeringStrength = steerSpeedFactor >= 0.5
        ? VEHICLE_SETTINGS.steeringHighSpeedDamping
        : 1;
    const driftSteerBonus = drifting ? VEHICLE_SETTINGS.driftSteerBonus : 1;

    const targetYawRate = steer === 0
        ? 0
        : steer * steeringDirection * VEHICLE_SETTINGS.steeringRate * steeringStrength * driftSteerBonus;

    const yawLambda = steer === 0 ? VEHICLE_SETTINGS.steeringReturn : VEHICLE_SETTINGS.steeringGrip;

    const nextYawRate = THREE.MathUtils.damp(angularVelocity.y, targetYawRate, yawLambda, delta);
    const rollTilt = -steer * Math.max(0.08, Math.abs(nextForwardSpeed) / VEHICLE_SETTINGS.maxDriveSpeed) * 0.5;
    const pitchTilt = throttle === 0 ? 0 : -throttle * 0.08;
    const nextAngular = new Jolt.Vec3(
        THREE.MathUtils.damp(angularVelocity.x, pitchTilt, grounded ? VEHICLE_SETTINGS.pitchTorque * 0.01 : VEHICLE_SETTINGS.airtimeAngularBlend, delta),
        nextYawRate,
        THREE.MathUtils.damp(angularVelocity.z, rollTilt, grounded ? VEHICLE_SETTINGS.rollTorque * 0.01 : VEHICLE_SETTINGS.airtimeAngularBlend, delta)
    );
    bodyInterface.SetAngularVelocity(bodyId, nextAngular);
    Jolt.destroy(nextAngular);

    if (throttle !== 0 || steer !== 0 || vehicleState.brakeHeld || horizontalVelocity.lengthSq() > 0.01) {
        bodyInterface.ActivateBody(bodyId);
    }

    const vehicleRenderObject = getActorRenderObject(vehicle);
    const vehicleVisualState = vehicleRenderObject ? ensureVehicleVisualState(vehicleRenderObject) : null;
    const rearWheelWorldPositions = [];
    if (vehicleVisualState?.steeringPivots?.length >= 4) {
        const forwardOffset = VEHICLE_SETTINGS.wheelBase * 0.18;
        for (let i = 2; i < 4; i++) {
            const pivot = vehicleVisualState.steeringPivots[i];
            if (!pivot?.isObject3D) { rearWheelWorldPositions.push(null); continue; }
            const wheelPos = new THREE.Vector3();
            pivot.getWorldPosition(wheelPos);
            wheelPos.y -= vehicleVisualState.wheelRadius || 0;
            wheelPos.addScaledVector(flatForward, forwardOffset);
            rearWheelWorldPositions.push(wheelPos);
        }
    }

    emitVehicleSurfaceEffects(delta, {
        vehiclePosition,
        flatForward,
        flatRight,
        cornerSamples,
        grounded,
        drifting,
        brakeHeld: vehicleState.brakeHeld,
        forwardSpeed: nextForwardSpeed,
        lateralSpeed,
        averageCompression,
        verticalSpeed: linearVelocity.y,
        rearWheelWorldPositions,
    });

    const uprightCorrection = tempVectorA.copy(vehicleUp).cross(upVector).multiplyScalar(-VEHICLE_SETTINGS.uprightTorque * (grounded ? 1 : 0.05));
    if (uprightCorrection.lengthSq() > 1e-6) {
        const uprightTorque = new Jolt.Vec3(uprightCorrection.x, uprightCorrection.y, uprightCorrection.z);
        bodyInterface.AddTorque(bodyId, uprightTorque, Jolt.EActivation_Activate);
        Jolt.destroy(uprightTorque);
    }

    vehicle.mesh.position.copy(vehiclePosition);
    vehicle.mesh.quaternion.copy(vehicleRotation);
    updateVehicleEngineAudio(delta, vehicle, {
        throttleInput,
        brakeHeld: vehicleState.brakeHeld,
        grounded,
        forwardSpeed: nextForwardSpeed,
    });
    positionVehicleCamera(vehiclePosition, vehicleRotation, delta);
    gameplay.grounded = grounded;
    physics.jumpQueued = false;

    // Update example widgets with vehicle data
    if (window.exampleWidgets) {
        const speedKmh = Math.round(forwardSpeed * 3.6); // Convert m/s to km/h
        window.exampleWidgets.speed?.SetText(`Speed: ${speedKmh} km/h`);

        // Update health bar based on vehicle "health" (using contact ratio as proxy)
        window.exampleWidgets.health?.SetPercent(Math.max(0.1, smoothedContactRatio));

        // Update score
        if (window.gameScore !== undefined) {
            // Add points for driving

            // Bonus points for high speed
            if (forwardSpeed > 15) {
            }

            window.exampleWidgets.score?.SetText(`Score: ${Math.floor(window.gameScore)}`);
        }
    }

    if (vehiclePosition.y < worldFloor.position.y - 24) {
        exitVehicle();
        respawnPlayer(true);
        return;
    }

    processGameplayPrefabs();
}

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

    if (includeFloor && worldFloor && !currentMesh?.userData?.hideTerrainPresentation) {
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

function resolveHorizontalMovement(origin, movementDelta) {
    if (!currentMesh || movementDelta.lengthSq() === 0) {
        return movementDelta;
    }

    const adjustedMovement = movementDelta.clone();
    const direction = tempVectorA.copy(movementDelta).normalize();
    const probeHeights = [PLAYER_SETTINGS.eyeHeight * 0.35, PLAYER_SETTINGS.eyeHeight * 0.75];

    for (const probeHeight of probeHeights) {
        const rayOrigin = tempVectorB.copy(origin);
        rayOrigin.y += probeHeight - PLAYER_SETTINGS.eyeHeight;

        raycaster.set(rayOrigin, direction);

        const hit = raycaster.intersectObject(currentMesh, true).find(entry => (
            entry.distance <= movementDelta.length() + PLAYER_SETTINGS.collisionRadius
        ));
        updateRaycasterDebugLine(
            raycaster.ray,
            movementDelta.length() + PLAYER_SETTINGS.collisionRadius,
            hit?.point ?? null,
            !!hit,
        );

        if (!hit || !hit.face) continue;

        const wallNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        if (wallNormal.y > 0.6) continue;

        adjustedMovement.projectOnPlane(wallNormal);
        adjustedMovement.addScaledVector(wallNormal, PLAYER_SETTINGS.wallClearance);
    }

    return adjustedMovement;
}

function updateGameplay(delta) {
    if (isDrivingVehicle()) {
        updateVehicleGameplay(delta);
        return;
    }

    silenceVehicleEngineAudio();
    updateEngineAudioDebugOverlay('idle', null, null);

    if (!physics.character) return;

    const moveRight = (gameplay.input.right ? 1 : 0) - (gameplay.input.left ? 1 : 0);
    const moveForward = (gameplay.input.forward ? 1 : 0) - (gameplay.input.back ? 1 : 0);
    const moveSpeed = gameplay.input.sprint ? PLAYER_SETTINGS.sprintSpeed : PLAYER_SETTINGS.walkSpeed;
    const wasGrounded = gameplay.grounded;

    tempVectorA.set(0, 0, 0);
    if (moveRight !== 0 || moveForward !== 0) {
        camera.getWorldDirection(tempVectorB);
        tempVectorB.y = 0;

        if (tempVectorB.lengthSq() < 1e-6) {
            tempVectorB.set(0, 0, -1);
        } else {
            tempVectorB.normalize();
        }

        tempVectorC.crossVectors(tempVectorB, upVector).normalize();

        tempVectorA
            .addScaledVector(tempVectorC, moveRight)
            .addScaledVector(tempVectorB, moveForward);

        if (tempVectorA.lengthSq() > 0) {
            tempVectorA.normalize().multiplyScalar(moveSpeed);
        }
    }

    const desiredMovement = tempVectorE.copy(tempVectorA);

    physics.character.UpdateGroundVelocity();

    const linearVelocity = copyJoltVector(tempVectorB, physics.character.GetLinearVelocity());
    const currentVerticalVelocity = tempVectorC.copy(upVector).multiplyScalar(linearVelocity.dot(upVector));
    const currentHorizontalVelocity = tempVectorD.copy(linearVelocity).sub(currentVerticalVelocity);
    const groundVelocity = copyJoltVector(tempVectorA, physics.character.GetGroundVelocity());

    const onGround = physics.character.IsSupported();
    const movingTowardsGround = currentVerticalVelocity.y - groundVelocity.y <= 0.1;
    physics.allowSliding = desiredMovement.lengthSq() > 1e-8;

    let nextVelocity;
    if (onGround && movingTowardsGround) {
        nextVelocity = groundVelocity.clone();
        if (physics.jumpQueued) {
            nextVelocity.y += PLAYER_SETTINGS.jumpSpeed;
        }
    } else {
        nextVelocity = currentVerticalVelocity.clone();
    }

    nextVelocity.addScaledVector(copyJoltVector(tempVectorC, physics.gravity), delta);

    if (physics.allowSliding) {
        physics.desiredVelocity.lerp(desiredMovement, onGround ? 0.32 : 0.12);
        nextVelocity.add(physics.desiredVelocity);
    } else if (!onGround) {
        nextVelocity.add(currentHorizontalVelocity);
        physics.desiredVelocity.multiplyScalar(0.92);
    } else {
        physics.desiredVelocity.multiplyScalar(0.2);
    }

    const nextVelocityJolt = new physics.Jolt.Vec3(nextVelocity.x, nextVelocity.y, nextVelocity.z);
    physics.character.SetLinearVelocity(nextVelocityJolt);
    physics.Jolt.destroy(nextVelocityJolt);
    physics.character.ExtendedUpdate(
        delta,
        physics.gravity,
        physics.updateSettings,
        physics.movingBroadPhaseFilter,
        physics.movingLayerFilter,
        physics.bodyFilter,
        physics.shapeFilter,
        physics.jolt.GetTempAllocator()
    );

    syncCameraToCharacter();
    applyGameplayCameraRotation();
    gameplay.grounded = physics.character.IsSupported();
    physics.jumpQueued = false;

    const characterPosition = copyJoltVector(tempVectorA, physics.character.GetPosition());
    if (characterPosition.y < worldFloor.position.y - 24) {
        respawnPlayer();
    }

    processGameplayPrefabs();

    if (wasGrounded !== gameplay.grounded) {
        updateGameplayUI();
    }
}

// --- File Handling ---

// Reads all files from a dropped directory entry recursively, returns filename→{file,url} map
async function readDirectoryFiles(dirEntry) {
    const fileMap = {};
    const readEntries = (entry) => new Promise((resolve) => {
        if (entry.isFile) {
            entry.file(file => {
                const url = URL.createObjectURL(file);
                // Store by lowercase filename so we can match case-insensitively
                fileMap[file.name.toLowerCase()] = { file, url };
                resolve();
            });
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const readBatch = () => {
                reader.readEntries(async (entries) => {
                    if (entries.length === 0) return resolve();
                    await Promise.all(entries.map(readEntries));
                    readBatch(); // keep reading until empty batch
                });
            };
            readBatch();
        } else {
            resolve();
        }
    });
    await readEntries(dirEntry);
    return fileMap;
}

function setupDropHandlers() {
    container.addEventListener('dragover', (e) => {
        e.preventDefault();
        container.classList.add('drag-active');
    });

    container.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && container.contains(e.relatedTarget)) return;
        container.classList.remove('drag-active');
    });

    container.addEventListener('drop', async (e) => {
        e.preventDefault();
        container.classList.remove('drag-active');

        const items = [...e.dataTransfer.items];
        const firstEntry = items[0]?.webkitGetAsEntry?.();

        // --- Folder drop ---
        if (firstEntry?.isDirectory) {
            processingStep.textContent = 'Reading folder...';
            processingOverlay.style.display = 'flex';
            loaderBar.style.width = '10%';

            const fileMap = await readDirectoryFiles(firstEntry);
            const modelEntry = Object.values(fileMap).find(({ file }) =>
                /\.(fbx|glb|gltf|obj)$/i.test(file.name)
            );
            processingOverlay.style.display = 'none';

            if (!modelEntry) {
                alert('No supported 3D file found in folder (.glb, .gltf, .obj, .fbx)');
                return;
            }
            loadModel(modelEntry.file, fileMap);
            return;
        }

        // --- Multi-file drop (files dropped directly, no folder) ---
        if (items.length > 1) {
            processingStep.textContent = 'Reading files...';
            processingOverlay.style.display = 'flex';
            loaderBar.style.width = '10%';

            const fileMap = {};
            let mainFile = null;

            for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const file = e.dataTransfer.files[i];
                const url = URL.createObjectURL(file);
                fileMap[file.name.toLowerCase()] = { file, url };
                
                if (/\.(fbx|glb|gltf|obj)$/i.test(file.name)) {
                    mainFile = file;
                }
            }

            processingOverlay.style.display = 'none';

            if (!mainFile) {
                alert('No supported 3D file found in dropped files (.glb, .gltf, .obj, .fbx)');
                return;
            }
            loadModel(mainFile, fileMap);
            return;
        }

        // --- Single file drop ---
        const file = e.dataTransfer.files[0];
        if (file && /\.(glb|gltf|obj|fbx)$/i.test(file.name)) {
            loadModel(file, {});
        } else {
            alert('Please drop a .glb, .gltf, .obj, or .fbx file — or drag a whole folder to load FBX textures.');
        }
    });

    const fileInput = document.getElementById('file-input');

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) loadModel(file, {});
    });
}

async function loadModel(file, fileMap = {}) {
    try {
        const root = await loadObjectFromFile(file, fileMap);
        clearCurrentMesh();
        currentMesh = root;
        scene.add(currentMesh);
        normalizeCurrentMesh();
        playObjectAnimation(currentMesh);
        refreshGameplayWorld();
        updateLoadedAssetStats(file.name, file.size, currentMesh);
    } catch (error) {
        console.error('Failed to load model.', error);
        alert(error?.message === 'Unsupported file format'
            ? 'Unsupported file format'
            : 'Failed to load the selected model. Check the console for details.');
    }
}

// --- Optimization Pipeline ---
async function runOptimizationPipeline() {
    processingOverlay.style.display = 'flex';
    const isPro = false;

    // --- Analytics Pixel Tracking ---
    // Simple privacy-first ping to track how many users actually run the pipeline.
    // Replace with your actual analytics tracking pixel URL (e.g. Plausible, SimpleAnalytics, or custom).
    try {
        new Image().src = `https://your-analytics-domain.com/pixel.gif?event=run_pipeline&isPro=${isPro}&ts=${Date.now()}`;
        console.log('Analytics ping sent: run_pipeline');
    } catch (e) {
        /* Ignore analytics errors so it doesn't block the UI */
    }

    const steps = [
        { label: 'Initializing WebGPU kernels...', progress: 10 },
        { label: 'Analyzing mesh topology...', progress: 20 },
        { label: 'Executing Parallel Decimation...', progress: 45 },
        { label: isPro ? 'Optimizing PBR textures (KTX2 + BasisU)...' : 'Optimizing PBR textures (WebP)...', progress: 75 },
        { label: 'Baking PBR texture maps...', progress: 85 },
        { label: 'Exporting optimized GLB...', progress: 100 }
    ];

    for (const step of steps) {
        processingStep.textContent = step.label;
        if (step.label.includes('Decimation')) {
            startScanEffect();
        }
        await gsap.to(loaderBar, { width: `${step.progress}%`, duration: 0.8 });
        await new Promise(r => setTimeout(r, 400));
    }

    try {
        // Run WebGPU Benchmark for UI "Wow" factor
        const benchmark = await runWebGPUBenchmark(originalTriCount * 3);
        if (benchmark) {
            document.getElementById('webgpu-speedup').textContent = `${benchmark.speedup.toFixed(1)}x`;
        }

        // Actual Simplification
        const ratio = parseFloat(document.getElementById('ratio-slider').value);
        simplifyMesh(ratio);

        // Best current in-browser path: aggressive texture recompression + smaller export textures.
        await compressTextures(currentMesh, 0.8, EXPORT_MAX_TEXTURE_SIZE, isPro);

        // Export to get real size
        const exporter = new GLTFExporter();
        const gltfData = await new Promise((resolve, reject) => {
            exporter.parse(currentMesh, resolve, reject, {
                binary: true,
                maxTextureSize: EXPORT_MAX_TEXTURE_SIZE,
                onlyVisible: true,
            });
        });

        const blob = new Blob([gltfData], { type: 'application/octet-stream' });
        if (optimizedBlobUrl) URL.revokeObjectURL(optimizedBlobUrl);
        optimizedBlobUrl = URL.createObjectURL(blob);

        const optimizedSize = blob.size;
        document.getElementById('file-size').textContent = (optimizedSize / (1024 * 1024)).toFixed(1) + ' MB';
        document.getElementById('file-diff').textContent = `(-${Math.round((1 - (optimizedSize / originalFileSize)) * 100)}%)`;

        processingOverlay.style.display = 'none';
        downloadBtn.style.display = 'flex';
    } catch (err) {
        console.error('Optimization failed:', err);
        alert('Optimization failed. Check console for details.');
        processingOverlay.style.display = 'none';
        stopScanEffect();
    }
}

function simplifyMesh(ratio = 0.12) {
    if (!currentMesh) return;

    stopScanEffect();

    let totalReducedTris = 0;

    currentMesh.traverse((child) => {
        if (child.isMesh) {
            const geometry = child.geometry.clone();
            const positions = geometry.attributes.position.array;
            let indices = geometry.index ? geometry.index.array : null;

            if (!indices) {
                // If no index, create one (meshoptimizer needs indices)
                const count = positions.length / 3;
                indices = new Uint32Array(count);
                for (let i = 0; i < count; i++) indices[i] = i;
            } else if (!(indices instanceof Uint32Array)) {
                indices = new Uint32Array(indices);
            }

            const targetCount = Math.floor((indices.length / 3) * ratio) * 3;
            const targetError = 0.01;

            const [simplifiedIndices, error] = MeshoptSimplifier.simplify(
                indices,
                positions,
                3,
                targetCount,
                targetError
            );

            geometry.setIndex(new THREE.BufferAttribute(simplifiedIndices, 1));
            child.geometry = geometry;

            totalReducedTris += simplifiedIndices.length / 3;

            // Visual feedback: briefly show wireframe
            child.material.wireframe = true;
            setTimeout(() => { child.material.wireframe = false; }, 1000);
        }
    });

    optimizedTriCount = Math.round(totalReducedTris);
    document.getElementById('tri-diff').textContent = `(-${Math.round((1 - (optimizedTriCount / originalTriCount)) * 100)}%)`;

    const countObj = { val: originalTriCount };
    gsap.to(countObj, {
        val: optimizedTriCount,
        duration: 1.5,
        ease: "power2.out",
        onUpdate: () => {
            document.getElementById('tri-count').textContent = Math.ceil(countObj.val).toLocaleString();
        }
    });
}

// === extracted: textureCompression (was lines 9098-9301 of original main.js) ===
function downloadAsset() {
    if (!optimizedBlobUrl) return;

    const a = document.createElement('a');
    a.href = optimizedBlobUrl;

    let baseName = document.getElementById('asset-name').textContent;
    baseName = baseName.replace(/\.[^/.]+$/, ""); // Remove extension if exists
    a.download = `optimized_${baseName}.glb`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// Add download listener (using onclick to prevent duplicate listeners on HMR)
if (downloadBtn) {
    downloadBtn.onclick = downloadAsset;
}

function stopScanEffect() {
    if (scanPlane) {
        scene.remove(scanPlane);
        scanPlane = null;
    }
}

function startScanEffect() {
    const geometry = new THREE.PlaneGeometry(5, 5);
    const material = new THREE.MeshBasicMaterial({
        color: 0x00ffaa,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending
    });
    scanPlane = new THREE.Mesh(geometry, material);
    scanPlane.rotation.x = Math.PI / 2;
    scanPlane.position.y = -2;
    scene.add(scanPlane);

    gsap.to(scanPlane.position, {
        y: 2,
        duration: 2,
        repeat: -1,
        yoyo: true,
        ease: "power1.inOut"
    });
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
function exportWorldToUmap() {
    const umap = exportWorldToJSON();
    const blob = new Blob([JSON.stringify(umap, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scene.umap';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
}

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

async function exportWorldToSceneFolder() {
    const umap = exportWorldToJSON({ preferAssetPath: true });
    const vehicleTemplateIds = new Set();
    for (const actor of umap.actors || []) {
        if (actor?.kind !== 'vehicle') continue;
        if (actor.vehicleBodyTemplateId) vehicleTemplateIds.add(actor.vehicleBodyTemplateId);
        if (actor.vehicleWheelTemplateId) vehicleTemplateIds.add(actor.vehicleWheelTemplateId);
    }

    // Build a parallel GLB cache for every imported template referenced by the
    // bundle. GLB parses ~10x faster than text OBJ for huge models (e.g. a
    // 300 MB car), so on next load registerImportedPropTemplateFromSerializedData
    // can skip the OBJ path entirely. Fall back to the raw source file for any
    // template whose GLB export fails.
    const glbAssets = new Map(); // templateId -> { fileName, blob }
    const rawFiles = new Map();  // templateId -> File (fallback only)

    for (const t of umap.importedTemplates || []) {
        const template = importedPropState.templates.find((entry) => entry.id === t.id);
        if (!template?.root) continue;
        const sourceFile = importedPropState.sourceFiles[t.id];

        if (vehicleTemplateIds.has(t.id) && sourceFile) {
            rawFiles.set(t.id, sourceFile);
            t.assetPath = `assets/${sourceFile.name}`;
            t.assetType = 'raw';
            delete t.rootJson;
            continue;
        }

        try {
            const glbBlob = await exportRootToGlb(template.root);
            const glbName = `${t.id}.glb`;
            glbAssets.set(t.id, { fileName: glbName, blob: glbBlob });
            t.assetPath = `assets/${glbName}`;
            t.assetType = 'glb';
        } catch (err) {
            console.warn(`[scene] GLB export failed for template ${t.id}; falling back to raw source.`, err);
            if (sourceFile) {
                rawFiles.set(t.id, sourceFile);
                t.assetPath = `assets/${sourceFile.name}`;
                t.assetType = 'raw';
            } else {
                // No GLB and no raw file — re-inline rootJson so this template
                // still loads (slower but correct).
                delete t.assetPath;
                delete t.assetType;
                t.rootJson = template.root.toJSON();
            }
        }
    }

    const useFsAccess = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
    if (useFsAccess) {
        let dirHandle;
        try {
            dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        } catch (err) {
            if (err?.name === 'AbortError') return;
            console.error('Folder picker failed; falling back to multi-file download.', err);
            return downloadSceneFolderFallback(umap, glbAssets, rawFiles);
        }
        try {
            await writeFileToDirectory(dirHandle, 'scene.umap', JSON.stringify(umap, null, 2));
            if (glbAssets.size > 0 || rawFiles.size > 0) {
                const assetsDir = await dirHandle.getDirectoryHandle('assets', { create: true });
                for (const { fileName, blob } of glbAssets.values()) {
                    await writeFileToDirectory(assetsDir, fileName, blob);
                }
                for (const file of rawFiles.values()) {
                    await writeFileToDirectory(assetsDir, file.name, file);
                }
            }
            console.info('[scene] Saved scene folder to picked directory.');
        } catch (err) {
            console.error('Failed to write scene folder.', err);
            alert('Failed to write scene folder. See console for details.');
        }
        return;
    }

    // Fallback for browsers without File System Access API: drop separate
    // downloads. The user reassembles the folder manually.
    downloadSceneFolderFallback(umap, glbAssets, rawFiles);
}

function exportRootToGlb(root) {
    return new Promise((resolve, reject) => {
        const exporter = new GLTFExporter();
        exporter.parse(
            root,
            (result) => {
                if (result instanceof ArrayBuffer) {
                    resolve(new Blob([result], { type: 'model/gltf-binary' }));
                } else {
                    // Defensive: caller asked for binary, but if a runtime
                    // returns JSON anyway, ship it as a non-binary GLB blob.
                    resolve(new Blob([JSON.stringify(result)], { type: 'model/gltf+json' }));
                }
            },
            reject,
            { binary: true, onlyVisible: false }
        );
    });
}

async function writeFileToDirectory(dirHandle, name, contents) {
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(contents);
    await writable.close();
}

function downloadSceneFolderFallback(umap, glbAssets, rawFiles) {
    const triggerDownload = (blob, name) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 100);
    };

    triggerDownload(
        new Blob([JSON.stringify(umap, null, 2)], { type: 'application/json' }),
        'scene.umap'
    );
    if (glbAssets) {
        for (const { fileName, blob } of glbAssets.values()) {
            triggerDownload(blob, fileName);
        }
    }
    if (rawFiles) {
        for (const file of rawFiles.values()) {
            triggerDownload(file, file.name);
        }
    }
    alert('Saved scene.umap and its assets as separate downloads. Place them in a folder with assets/<file> next to scene.umap before loading.');
}

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

const PREFAB_MANIFEST_URL = './prefabs/manifest.json';
const PREFAB_CATEGORY_ORDER = ['Vehicles', 'Lights', 'Shapes', 'Gameplay'];
const BUILTIN_PREFAB_ITEMS = [
    { id: 'point-light', name: 'Point Light', category: 'Lights', kind: 'pointLight', image: 'light-point.svg' },
    { id: 'spot-light', name: 'Spot Light', category: 'Lights', kind: 'spotLight', image: 'light-spot.svg' },
    { id: 'sphere', name: 'Sphere', category: 'Shapes', kind: 'sphere', image: 'shape-sphere.svg' },
    { id: 'cube', name: 'Cube', category: 'Shapes', kind: 'cube', image: 'shape-cube.svg' },
    { id: 'cylinder', name: 'Cylinder', category: 'Shapes', kind: 'cylinder', image: 'shape-cylinder.svg' },
    { id: 'capsule', name: 'Capsule', category: 'Shapes', kind: 'capsule', image: 'shape-capsule.svg' },
    { id: 'player-spawn', name: 'Player Spawn', category: 'Gameplay', gameplayPrefab: 'playerSpawn', image: 'gameplay-spawn.svg' },
    { id: 'teleporter', name: 'Teleporter', category: 'Gameplay', gameplayPrefab: 'teleporter', image: 'gameplay-teleporter.svg' },
    { id: 'coin', name: 'Coin +10', category: 'Gameplay', gameplayPrefab: 'coin', image: 'gameplay-coin.svg' },
    { id: 'target', name: 'Target +25', category: 'Gameplay', gameplayPrefab: 'target', image: 'gameplay-target.svg' },
];
let prefabManifestCache = null;

async function loadPrefabManifest() {
    if (prefabManifestCache) return prefabManifestCache;
    const manifestResponse = await fetch(PREFAB_MANIFEST_URL);
    if (!manifestResponse.ok) {
        throw new Error(`Prefab manifest failed: ${manifestResponse.status}`);
    }
    prefabManifestCache = await manifestResponse.json();
    return prefabManifestCache;
}

async function loadPrefab(prefab) {
    const button = document.getElementById('load-prefab-btn');
    const previousText = button?.textContent;
    const status = document.getElementById('prefab-browser-status');
    if (button) {
        button.disabled = true;
        button.textContent = 'Loading...';
    }
    if (status) status.textContent = `Loading ${prefab?.name || 'prefab'}...`;

    try {
        if (!prefab?.file) {
            throw new Error('Prefab has no file.');
        }

        const prefabUrl = new URL(prefab.file, new URL(PREFAB_MANIFEST_URL, window.location.href));
        const prefabResponse = await fetch(prefabUrl);
        if (!prefabResponse.ok) {
            throw new Error(`Prefab failed: ${prefabResponse.status}`);
        }
        const blob = await prefabResponse.blob();
        const file = new File([blob], prefab.file, { type: 'application/json' });
        await loadActorFromFile(file, {
            askSpawnLocation: false,
            spawnInFrontOfPlayer: true,
        });
        closePrefabBrowser();
    } catch (err) {
        console.error('Failed to load prefab.', err);
        if (status) status.textContent = 'Failed to load prefab.';
        alert('Failed to load prefab.');
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = previousText || 'Load Prefab';
        }
    }
}

function prefabAssetUrl(path = 'car.svg') {
    return new URL(path, new URL(PREFAB_MANIFEST_URL, window.location.href));
}

function spawnBuiltinPrefab(prefab) {
    if (prefab?.gameplayPrefab) {
        spawnGameplayPrefab(prefab.gameplayPrefab);
        closePrefabBrowser();
        return;
    }

    const kind = prefab?.kind || 'sphere';
    const label = prefab?.name || getActorKindLabel(kind);
    let actor = null;

    if (isLightActorKind(kind)) {
        actor = spawnLightActor(kind, {
            userData: { label },
            includeScripts: true,
            scale: Number.parseFloat(getActorKindDefaultScale(kind)),
        });
    } else {
        const scale = Number.parseFloat(getActorKindDefaultScale(kind));
        actor = spawnDynamicPrimitive(kind, undefined, scale, {
            includeCollisionBody: true,
            simulatePhysics: true,
            includeScripts: true,
            userData: { label },
            returnActor: true,
        });
    }

    if (!actor) {
        const status = document.getElementById('prefab-browser-status');
        if (status) status.textContent = `Failed to spawn ${label}.`;
        return;
    }

    refreshSceneUI();
    selectShowcaseActor(actor.id);
    closePrefabBrowser();
}

function closePrefabBrowser() {
    const browser = document.getElementById('prefab-browser');
    if (browser) browser.hidden = true;
}

function createPrefabBrowserTile(prefab) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'prefab-browser-item';

    const img = document.createElement('img');
    img.className = 'prefab-browser-thumb';
    img.alt = prefab.name || 'Prefab';
    img.src = prefabAssetUrl(prefab.image || 'car.svg');

    const name = document.createElement('div');
    name.className = 'prefab-browser-name';
    name.textContent = prefab.name || prefab.file || 'Prefab';

    item.append(img, name);
    item.addEventListener('click', () => {
        if (prefab.file) {
            loadPrefab(prefab);
        } else {
            spawnBuiltinPrefab(prefab);
        }
    });
    return item;
}

async function openPrefabBrowser() {
    const browser = document.getElementById('prefab-browser');
    const grid = document.getElementById('prefab-browser-grid');
    const status = document.getElementById('prefab-browser-status');
    if (!browser || !grid) return;

    browser.hidden = false;
    grid.textContent = '';
    if (status) status.textContent = 'Loading prefabs...';

    try {
        const manifest = await loadPrefabManifest();
        const manifestPrefabs = Array.isArray(manifest.prefabs) ? manifest.prefabs : [];
        const prefabs = [
            ...manifestPrefabs.map((prefab) => ({
                category: 'Vehicles',
                ...prefab,
            })),
            ...BUILTIN_PREFAB_ITEMS,
        ];
        if (!prefabs.length) {
            if (status) status.textContent = 'No prefabs found.';
            return;
        }

        const grouped = new Map();
        prefabs.forEach((prefab) => {
            const category = prefab.category || 'Other';
            if (!grouped.has(category)) grouped.set(category, []);
            grouped.get(category).push(prefab);
        });

        const categories = [
            ...PREFAB_CATEGORY_ORDER.filter((category) => grouped.has(category)),
            ...Array.from(grouped.keys()).filter((category) => !PREFAB_CATEGORY_ORDER.includes(category)).sort(),
        ];

        categories.forEach((category) => {
            const items = grouped.get(category) || [];
            const heading = document.createElement('div');
            heading.className = 'prefab-category-heading';

            const title = document.createElement('div');
            title.className = 'prefab-category-title';
            title.textContent = category;

            const count = document.createElement('div');
            count.className = 'prefab-category-count';
            count.textContent = `${items.length}`;

            heading.append(title, count);
            grid.appendChild(heading);
            items.forEach((prefab) => grid.appendChild(createPrefabBrowserTile(prefab)));
        });

        if (status) status.textContent = `${prefabs.length} prefab${prefabs.length === 1 ? '' : 's'}`;
    } catch (err) {
        console.error('Failed to open prefab browser.', err);
        if (status) status.textContent = 'Failed to load prefabs.';
    }
}

document.getElementById('load-prefab-btn')?.addEventListener('click', () => {
    openPrefabBrowser();
});
document.getElementById('prefab-browser-close')?.addEventListener('click', () => {
    closePrefabBrowser();
});
document.getElementById('prefab-browser')?.addEventListener('click', (event) => {
    if (event.target?.id === 'prefab-browser') closePrefabBrowser();
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
    bindAppCore({
        scene: () => scene,
        camera: () => camera,
        renderer: () => renderer,
        currentMesh: () => currentMesh,
        transformControl: () => transformControl,
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
}

