import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import gsap from 'gsap';
import { createSocketMultiplayer } from './src/network/socketMultiplayer.js';
import { runWebGPUBenchmark } from './webgpu_utils.js';
import { createPhysicsCore } from './src/physics/core.js';
import { createPhysicsRuntime } from './src/physics/runtime.js';
import { createEnvironmentController } from './src/world/environment.js';
import { createLightGridController } from './src/world/lightGrid.js';
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
} from './src/runtime/sceneRuntime.js';
import {
    TERRAIN_Y_OFFSET,
    applyTerrainTextures,
    createTerrainMesh,
    sampleTerrainHeightAt as sampleTerrainHeightAtWorldFloor,
} from './src/world/terrain.js';
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

installUePrototypeMethods();

// --- Widget System (Unreal Engine Style) ---
class WidgetManager {
    constructor(container) {
        this.container = container;
        this.widgets = new Map();
        this.nextId = 1;

        // Create overlay container for UI widgets
        this.overlay = document.createElement('div');
        this.overlay.id = 'widget-overlay';
        this.overlay.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 1000;
        `;
        // Append overlay on top of the canvas (which should be the last child)
        this.container.appendChild(this.overlay);
    }

    createWidget(type, config = {}) {
        const id = this.nextId++;
        let widget;

        switch (type) {
            case 'text':
                widget = new TextWidget(id, config);
                break;
            case 'image':
                widget = new ImageWidget(id, config);
                break;
            case 'progress':
                widget = new ProgressBarWidget(id, config);
                break;
            case 'button':
                widget = new ButtonWidget(id, config);
                break;
            default:
                throw new Error(`Unknown widget type: ${type}`);
        }

        this.widgets.set(id, widget);
        this.overlay.appendChild(widget.element);
        return id;
    }

    updateWidget(id, updates) {
        const widget = this.widgets.get(id);
        if (!widget) return false;

        widget.update(updates);
        return true;
    }

    showWidget(id, visible = true) {
        const widget = this.widgets.get(id);
        if (!widget) return false;

        widget.element.style.display = visible ? 'block' : 'none';
        return true;
    }

    removeWidget(id) {
        const widget = this.widgets.get(id);
        if (!widget) return false;

        this.overlay.removeChild(widget.element);
        widget.dispose();
        this.widgets.delete(id);
        return true;
    }

    setWidgetPosition(id, position, space = 'screen') {
        const widget = this.widgets.get(id);
        if (!widget) return false;

        if (space === 'screen') {
            // Position as percentage of container
            const x = (position.x * 100) + '%';
            const y = (position.y * 100) + '%';
            widget.element.style.left = x;
            widget.element.style.top = y;
            widget.element.style.transform = 'translate(-50%, -50%)';
        } else {
            // World space positioning would require 3D to screen conversion
            console.warn('World space positioning not yet implemented for HTML widgets');
        }
        return true;
    }

    setWidgetScale(id, scale) {
        const widget = this.widgets.get(id);
        if (!widget) return false;

        const scaleValue = typeof scale === 'number' ? scale : scale.x || 1;
        widget.element.style.transform = widget.element.style.transform.replace(/scale\([^)]*\)/, '') + ` scale(${scaleValue})`;
        return true;
    }

    getWidget(id) {
        return this.widgets.get(id);
    }

    getAllWidgets() {
        return Array.from(this.widgets.values());
    }

    update(delta) {
        // Kept to prevent breaking the main render loop
    }

    dispose() {
        for (const widget of this.widgets.values()) {
            widget.dispose();
        }
        this.widgets.clear();
        if (this.overlay && this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
    }
}

// Base Widget Class
class BaseWidget {
    constructor(id, config = {}) {
        this.id = id;
        this.element = document.createElement('div');
        this.element.className = 'widget';
        this.element.style.cssText = `
            position: absolute;
            pointer-events: auto;
            user-select: none;
        `;

        this.config = {
            position: { x: 0.5, y: 0.5 }, // Normalized screen coordinates (0-1)
            scale: 1,
            visible: true,
            zOrder: 0,
            ...config
        };

        this.updatePosition();
        this.element.style.display = this.config.visible ? 'block' : 'none';
        this.element.style.zIndex = String(this.config.zOrder);
    }

    update(updates) {
        if (updates.position) {
            this.config.position = updates.position;
            this.updatePosition();
        }
        if (updates.scale !== undefined) {
            this.config.scale = updates.scale;
            this.updateScale();
        }
        if (updates.visible !== undefined) {
            this.config.visible = updates.visible;
            this.element.style.display = updates.visible ? 'block' : 'none';
        }
        if (updates.zOrder !== undefined) {
            this.config.zOrder = updates.zOrder;
            this.element.style.zIndex = String(updates.zOrder);
        }

        Object.assign(this.config, updates);
    }

    updatePosition() {
        const x = (this.config.position.x * 100) + '%';
        const y = (this.config.position.y * 100) + '%';
        this.element.style.left = x;
        this.element.style.top = y;
        this.element.style.transform = 'translate(-50%, -50%)';
        this.updateScale();
    }

    updateScale() {
        const currentTransform = this.element.style.transform;
        const translateMatch = currentTransform.match(/translate\([^)]+\)/);
        const translate = translateMatch ? translateMatch[0] : 'translate(-50%, -50%)';
        this.element.style.transform = `${translate} scale(${this.config.scale})`;
    }

    dispose() {
        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }
    }
}

// Text Widget
class TextWidget extends BaseWidget {
    constructor(id, config = {}) {
        super(id, config);

        this.config = {
            text: 'Hello World',
            fontSize: 24,
            color: '#ffffff',
            fontFamily: 'Arial, sans-serif',
            textAlign: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            padding: '8px 16px',
            borderRadius: '4px',
            ...this.config
        };

        this.element.innerHTML = `
            <div style="
                font-size: ${this.config.fontSize}px;
                color: ${this.config.color};
                font-family: ${this.config.fontFamily};
                text-align: ${this.config.textAlign};
                background-color: ${this.config.backgroundColor};
                padding: ${this.config.padding};
                border-radius: ${this.config.borderRadius};
                white-space: nowrap;
            ">${this.config.text}</div>
        `;
    }

    update(updates) {
        super.update(updates);

        if (updates.text !== undefined) {
            this.config.text = updates.text;
            this.element.querySelector('div').textContent = updates.text;
        }
        if (updates.fontSize !== undefined) {
            this.config.fontSize = updates.fontSize;
            this.element.querySelector('div').style.fontSize = updates.fontSize + 'px';
        }
        if (updates.color !== undefined) {
            this.config.color = updates.color;
            this.element.querySelector('div').style.color = updates.color;
        }
        if (updates.fontFamily !== undefined) {
            this.config.fontFamily = updates.fontFamily;
            this.element.querySelector('div').style.fontFamily = updates.fontFamily;
        }
        if (updates.textAlign !== undefined) {
            this.config.textAlign = updates.textAlign;
            this.element.querySelector('div').style.textAlign = updates.textAlign;
        }
        if (updates.backgroundColor !== undefined) {
            this.config.backgroundColor = updates.backgroundColor;
            this.element.querySelector('div').style.backgroundColor = updates.backgroundColor;
        }
        if (updates.padding !== undefined) {
            this.config.padding = updates.padding;
            this.element.querySelector('div').style.padding = updates.padding;
        }
        if (updates.borderRadius !== undefined) {
            this.config.borderRadius = updates.borderRadius;
            this.element.querySelector('div').style.borderRadius = updates.borderRadius;
        }
    }
}

// Image Widget
class ImageWidget extends BaseWidget {
    constructor(id, config = {}) {
        super(id, config);

        this.config = {
            imageUrl: null,
            width: 100,
            height: 100,
            ...this.config
        };

        this.element.innerHTML = `
            <img style="
                width: ${this.config.width}px;
                height: ${this.config.height}px;
                object-fit: contain;
                border-radius: 4px;
            " src="${this.config.imageUrl || ''}" alt="Widget Image">
        `;
    }

    update(updates) {
        super.update(updates);

        if (updates.imageUrl !== undefined) {
            this.config.imageUrl = updates.imageUrl;
            this.element.querySelector('img').src = updates.imageUrl;
        }
        if (updates.width !== undefined) {
            this.config.width = updates.width;
            this.element.querySelector('img').style.width = updates.width + 'px';
        }
        if (updates.height !== undefined) {
            this.config.height = updates.height;
            this.element.querySelector('img').style.height = updates.height + 'px';
        }
    }
}

// Progress Bar Widget
class ProgressBarWidget extends BaseWidget {
    constructor(id, config = {}) {
        super(id, config);

        this.config = {
            progress: 0.5,
            width: 200,
            height: 20,
            backgroundColor: '#333333',
            fillColor: '#00ff00',
            borderColor: '#ffffff',
            borderWidth: '2px',
            borderRadius: '4px',
            ...this.config
        };

        this.element.innerHTML = `
            <div style="
                width: ${this.config.width}px;
                height: ${this.config.height}px;
                background-color: ${this.config.backgroundColor};
                border: ${this.config.borderWidth} solid ${this.config.borderColor};
                border-radius: ${this.config.borderRadius};
                overflow: hidden;
            ">
                <div style="
                    width: ${this.config.progress * 100}%;
                    height: 100%;
                    background-color: ${this.config.fillColor};
                    transition: width 0.3s ease;
                "></div>
            </div>
        `;
    }

    update(updates) {
        super.update(updates);

        if (updates.progress !== undefined) {
            this.config.progress = Math.max(0, Math.min(1, updates.progress));
            this.element.querySelector('div > div').style.width = (this.config.progress * 100) + '%';
        }
        if (updates.width !== undefined) {
            this.config.width = updates.width;
            this.element.querySelector('div').style.width = updates.width + 'px';
        }
        if (updates.height !== undefined) {
            this.config.height = updates.height;
            this.element.querySelector('div').style.height = updates.height + 'px';
        }
        if (updates.backgroundColor !== undefined) {
            this.config.backgroundColor = updates.backgroundColor;
            this.element.querySelector('div').style.backgroundColor = updates.backgroundColor;
        }
        if (updates.fillColor !== undefined) {
            this.config.fillColor = updates.fillColor;
            this.element.querySelector('div > div').style.backgroundColor = updates.fillColor;
        }
        if (updates.borderColor !== undefined) {
            this.config.borderColor = updates.borderColor;
            this.element.querySelector('div').style.borderColor = updates.borderColor;
        }
        if (updates.borderWidth !== undefined) {
            this.config.borderWidth = updates.borderWidth;
            this.element.querySelector('div').style.borderWidth = updates.borderWidth;
        }
        if (updates.borderRadius !== undefined) {
            this.config.borderRadius = updates.borderRadius;
            this.element.querySelector('div').style.borderRadius = updates.borderRadius;
        }
    }
}

// Button Widget
class ButtonWidget extends BaseWidget {
    constructor(id, config = {}) {
        super(id, config);

        this.config = {
            text: 'Button',
            width: 120,
            height: 40,
            backgroundColor: '#444444',
            hoverColor: '#666666',
            textColor: '#ffffff',
            borderRadius: '4px',
            fontSize: 16,
            onClick: null,
            ...this.config
        };

        this.element.innerHTML = `
            <button style="
                width: ${this.config.width}px;
                height: ${this.config.height}px;
                background-color: ${this.config.backgroundColor};
                color: ${this.config.textColor};
                border: none;
                border-radius: ${this.config.borderRadius};
                font-size: ${this.config.fontSize}px;
                font-family: Arial, sans-serif;
                cursor: pointer;
                transition: background-color 0.2s ease;
            ">${this.config.text}</button>
        `;

        this.buttonElement = this.element.querySelector('button');
        this.buttonElement.addEventListener('click', () => {
            if (this.config.onClick) {
                this.config.onClick(this.id);
            }
        });

        this.buttonElement.addEventListener('mouseenter', () => {
            this.buttonElement.style.backgroundColor = this.config.hoverColor;
        });

        this.buttonElement.addEventListener('mouseleave', () => {
            this.buttonElement.style.backgroundColor = this.config.backgroundColor;
        });
    }

    update(updates) {
        super.update(updates);

        if (updates.text !== undefined) {
            this.config.text = updates.text;
            this.buttonElement.textContent = updates.text;
        }
        if (updates.width !== undefined) {
            this.config.width = updates.width;
            this.buttonElement.style.width = updates.width + 'px';
        }
        if (updates.height !== undefined) {
            this.config.height = updates.height;
            this.buttonElement.style.height = updates.height + 'px';
        }
        if (updates.backgroundColor !== undefined) {
            this.config.backgroundColor = updates.backgroundColor;
            this.buttonElement.style.backgroundColor = updates.backgroundColor;
        }
        if (updates.hoverColor !== undefined) {
            this.config.hoverColor = updates.hoverColor;
        }
        if (updates.textColor !== undefined) {
            this.config.textColor = updates.textColor;
            this.buttonElement.style.color = updates.textColor;
        }
        if (updates.borderRadius !== undefined) {
            this.config.borderRadius = updates.borderRadius;
            this.buttonElement.style.borderRadius = updates.borderRadius;
        }
        if (updates.fontSize !== undefined) {
            this.config.fontSize = updates.fontSize;
            this.buttonElement.style.fontSize = updates.fontSize + 'px';
        }
        if (updates.onClick !== undefined) {
            this.config.onClick = updates.onClick;
        }
    }
}

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

    const scoreWidget = hud.CreateWidget(UTextWidget, {
        Text: 'Score: 0',
        fontSize: 20,
        color: '#ffff00',
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        position: { x: 0.05, y: 0.9 }, // Top-left corner
        visible: true,
    });
    scoreWidget.AddToViewport(20);

    const healthBar = hud.CreateWidget(UProgressBarWidget, {
        Percent: 1.0,
        width: 200,
        height: 20,
        fillColor: '#00ff00',
        backgroundColor: '#333333',
        position: { x: 0.05, y: 0.8 }, // Below score
        visible: true,
    });
    healthBar.AddToViewport(19);

    const speedWidget = hud.CreateWidget(UTextWidget, {
        Text: 'Speed: 0 km/h',
        fontSize: 16,
        color: '#00ffff',
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        position: { x: 0.05, y: 0.7 }, // Below health bar
        visible: true,
    });
    speedWidget.AddToViewport(18);

    // Store widget handles globally for easy access
    window.exampleWidgets = {
        score: scoreWidget,
        health: healthBar,
        speed: speedWidget,
    };
    window.gameHud = hud;

    // Initialize score system
    window.gameScore = 0;

    console.log('Example widgets created:', window.exampleWidgets);
    console.log('Widget API available at window.WidgetAPI');
    console.log('Unreal widget API available at window.UnrealWidgetAPI');
    console.log('Example usage:');
    console.log('  WidgetAPI.createWidget("text", {text: "Hello!", position: {x: 0.5, y: 0.5}})');
    console.log('  UnrealWidgetAPI.CreateWidget(UTextWidget, { Text: "Hello HUD" }).AddToViewport(25)');
}

// --- Configuration ---
let scene, camera, renderer, currentMesh, transformControl;
let originalTriCount = 0;
let optimizedTriCount = 0;
let scanPlane;
let originalFileSize = 0;
let optimizedBlobUrl = null;
let environmentController;
let physicsCore;
let physicsRuntime;
let multiplayerController;
let sceneSystem;
const EXPORT_MAX_TEXTURE_SIZE = 1024;
const MODEL_TARGET_MAX_DIMENSION = 12;
const PROP_TARGET_MAX_DIMENSION = 2.35;
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
    spawnLift: 0.15,
    interactionRadius: 4.5,
    seatHeight: 1.15,
    followDistance: 5.6,
    followHeight: 2.4,
    lookAhead: 2.2,
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
    suspensionRideHeight: 0.55,
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
let playHint, gameplayStatus, resetViewBtn, showcaseModeBtn, playModeBtn, browseModelBtn, openActorEditorBtn;
let playTestSoundBtn, playTestSoundStatus;
let multiplayerServerUrlInput, multiplayerRoomInput, multiplayerConnectBtn, multiplayerDisconnectBtn, multiplayerStatusValue, multiplayerPlayerCountValue;
let importPropBtn, propFileInput, importedPropList, importedPropLibrary, propImportDefaultStatus, resetPropImportDefaultBtn;
let propCollisionPrompt, propCollisionCopy, propCollisionRemember, propCollisionSimpleBtn, propCollisionComplexBtn, propCollisionCancelBtn;
let inputActionsOpenBtn, inputActionsEditor, inputActionLeftBtn, inputActionRightBtn, inputActionMode, inputActionEditorInput, inputActionsEditorStatus, mouseActionApplyBtn, mouseActionResetBtn, inputActionsCloseBtn, mouseActionStatus;
let objectScriptMenu, objectScriptTickActionBtn, objectScriptCollisionActionBtn;
let objectScriptEditor, objectScriptEditorTitle, objectScriptEditorTarget, objectScriptEditorMode;
let objectScriptEditorInput, objectScriptEditorStatus, objectScriptEditorApplyBtn, objectScriptEditorClearBtn, objectScriptEditorCancelBtn;
let objectScriptTickToggleRow, objectScriptTickToggleInput;
let actorEditor, actorEditorSummary, actorEditorStatus, actorKindSelect, actorLabelInput, actorScaleInput, actorImportedTemplateSelect, actorVehicleBodyTemplateSelect, actorVehicleWheelTemplateSelect;
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
};
const actorEditorState = {
    open: false,
};
const blueprintState = {
    active: false,
    targetActor: null,
    selectedComponent: null,
    floorMesh: null,
    savedCameraPosition: null,
    savedShowcaseAngles: null,
    savedBackground: null
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
    .Add(new FVector(0, -0.35, 0));

const sphere = World.SpawnActor('Sphere', spawnLocation);
const phys = sphere?.GetComponentByClass(UPrimitiveComponent);

if (phys) {
    phys.AddImpulse(direction.Scale(36000));
}`,
    right: `const cubesPerSide = 5;
const totalCubes = 50;
const spacing = 0.34;
const baseYOffset = -0.8;
let spawned = 0;
const playerLocation = Character?.GetActorLocation?.() ?? new FVector(camera.position.x, camera.position.y, camera.position.z);
const forward = Character?.GetActorForwardVector?.()?.GetSafeNormal?.() ?? new FVector(0, 0, -1);
const right = Character?.GetActorRightVector?.()?.GetSafeNormal?.() ?? new FVector(1, 0, 0);
const up = Character?.GetActorUpVector?.()?.GetSafeNormal?.() ?? new FVector(0, 1, 0);
const baseCenter = playerLocation.Add(forward.Scale(2.6));

for (let layer = 0; spawned < totalCubes; layer++) {
    for (let row = 0; row < cubesPerSide && spawned < totalCubes; row++) {
        for (let col = 0; col < cubesPerSide && spawned < totalCubes; col++) {
            const xOffset = (col - (cubesPerSide - 1) * 0.5) * spacing;
            const yOffset = baseYOffset + layer * spacing;
            const zOffset = (row - (cubesPerSide - 1) * 0.5) * spacing;
            const spawnLocation = baseCenter
                .Add(right.Scale(xOffset))
                .Add(up.Scale(yOffset))
                .Add(forward.Scale(zOffset));
            World.SpawnActor('Cube', spawnLocation);

            spawned += 1;
        }
    }
}`,
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

function sampleTestTone(progress, sampleIndex, sampleRate) {
    const attack = Math.min(1, progress / 0.06);
    const release = Math.min(1, (1 - progress) / 0.24);
    const envelope = Math.min(attack, release);
    const frequency = THREE.MathUtils.lerp(880, 440, progress);
    const omega = (Math.PI * 2 * frequency * sampleIndex) / sampleRate;
    const overtone = (Math.PI * 2 * (frequency * 2.02) * sampleIndex) / sampleRate;
    return (Math.sin(omega) * 0.34 + Math.sin(overtone) * 0.14) * envelope;
}

function writeWaveAscii(view, offset, value) {
    for (let index = 0; index < value.length; index++) {
        view.setUint8(offset + index, value.charCodeAt(index));
    }
}

function createTestSoundBuffer(audioContext) {
    const sampleRate = audioContext.sampleRate || 44100;
    const duration = 0.6;
    const frameCount = Math.max(1, Math.floor(sampleRate * duration));
    const buffer = audioContext.createBuffer(1, frameCount, sampleRate);
    const channelData = buffer.getChannelData(0);

    for (let index = 0; index < frameCount; index++) {
        const progress = index / frameCount;
        channelData[index] = sampleTestTone(progress, index, sampleRate);
    }

    return buffer;
}

function createMediaTestSoundUrl() {
    const sampleRate = 44100;
    const duration = 0.6;
    const frameCount = Math.max(1, Math.floor(sampleRate * duration));
    const dataBytes = frameCount * 2;
    const waveBuffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(waveBuffer);

    writeWaveAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeWaveAscii(view, 8, 'WAVE');
    writeWaveAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeWaveAscii(view, 36, 'data');
    view.setUint32(40, dataBytes, true);

    for (let index = 0; index < frameCount; index++) {
        const progress = index / frameCount;
        const sample = THREE.MathUtils.clamp(sampleTestTone(progress, index, sampleRate), -1, 1);
        view.setInt16(44 + (index * 2), sample * 32767, true);
    }

    const blob = new Blob([waveBuffer], { type: 'audio/wav' });
    return URL.createObjectURL(blob);
}

async function playSpeakerTestTone({ frequency = 660, duration = 0.55, volume = 0.22 } = {}) {
    const audioContext = runtimeAudio.listener?.context ?? null;
    if (!audioContext) {
        return false;
    }

    await runtimeAudio.resume();

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const startTime = audioContext.currentTime + 0.01;
    const endTime = startTime + Math.max(0.08, duration);

    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(frequency, startTime);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(220, frequency * 0.72), endTime);

    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.02, volume), startTime + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, endTime);

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.start(startTime);
    oscillator.stop(endTime + 0.02);
    oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
    };

    return true;
}

async function playMediaElementTestSound() {
    if (typeof Audio === 'undefined') {
        return false;
    }

    if (!runtimeAudio.mediaTestUrl) {
        runtimeAudio.mediaTestUrl = createMediaTestSoundUrl();
    }

    const audio = new Audio(runtimeAudio.mediaTestUrl);
    audio.preload = 'auto';
    audio.volume = 1;

    try {
        await audio.play();
        return true;
    } catch (error) {
        console.warn('Failed to play media-element test sound.', error);
        return false;
    }
}

function resolveSoundLocation(location, fallbackDistance = 3) {
    if (location?.isVector3) {
        return location.clone();
    }

    if (location && typeof location === 'object' && Number.isFinite(location.x) && Number.isFinite(location.y) && Number.isFinite(location.z)) {
        return new THREE.Vector3(location.x, location.y, location.z);
    }

    if (camera) {
        const worldLocation = new THREE.Vector3();
        const forward = new THREE.Vector3();
        camera.getWorldPosition(worldLocation);
        camera.getWorldDirection(forward);
        worldLocation.addScaledVector(forward, fallbackDistance);
        return worldLocation;
    }

    return new THREE.Vector3();
}

function cleanupTransientAudio(anchor, sound) {
    if (!anchor) return;

    runtimeAudio.transientAnchors.delete(anchor);
    if (sound?.isPlaying) {
        sound.stop();
    }
    if (sound?.parent === anchor) {
        anchor.remove(sound);
    }
    sound?.disconnect?.();
    if (anchor.parent === scene) {
        scene.remove(anchor);
    }
}

function clampVehicleEngineRpm(value) {
    return THREE.MathUtils.clamp(
        value,
        vehicleEngineAudio.minRpm,
        vehicleEngineAudio.maxRpm,
    );
}

function createEngineNoiseBuffer(audioContext) {
    const duration = 2.6;
    const sampleRate = audioContext.sampleRate || 44100;
    const frameCount = Math.max(1, Math.floor(sampleRate * duration));
    const buffer = audioContext.createBuffer(1, frameCount, sampleRate);
    const data = buffer.getChannelData(0);

    // Paul Kellet's pink-noise filter — much more natural turbulence than RC-filtered white noise.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let index = 0; index < frameCount; index++) {
        const white = (Math.random() * 2) - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
        data[index] = THREE.MathUtils.clamp(pink, -1, 1);
    }

    return buffer;
}

function createCombustionPulseBuffer(audioContext) {
    // Heavy-duty V8 cylinder firing impulse — Warthog flavor.
    // Deep fundamental, long throaty tail, low-mid grit. Looped at firing frequency
    // produces a chunky burble instead of a thin blat.
    const sampleRate = audioContext.sampleRate || 44100;
    const duration = 0.12;
    const frameCount = Math.max(1, Math.floor(sampleRate * duration));
    const buffer = audioContext.createBuffer(1, frameCount, sampleRate);
    const data = buffer.getChannelData(0);

    let lpState = 0;
    for (let index = 0; index < frameCount; index++) {
        const t = index / frameCount;
        const attack = Math.min(1, t / 0.012);
        const decay = Math.exp(-t * 7.5);
        // Deep fundamental + chest-thump octave + low-mid harmonic
        const fundamental = Math.sin(t * Math.PI * 2 * 38);
        const sub = Math.sin(t * Math.PI * 2 * 19) * 0.6;
        const overtone = Math.sin(t * Math.PI * 2 * 110) * 0.28;
        // Grit — but lowpassed so it's "rumble", not "buzz"
        const white = (Math.random() * 2) - 1;
        lpState = lpState * 0.82 + white * 0.18;
        const rumble = lpState * 0.22;
        const sample = (fundamental + sub + overtone + rumble) * attack * decay * 0.6;
        data[index] = THREE.MathUtils.clamp(sample, -1, 1);
    }
    return buffer;
}

function createCombustionDistortionCurve(amount = 0.18) {
    // Very gentle soft-clip — just rounds peaks, doesn't add harmonic harshness.
    const samples = 2048;
    const curve = new Float32Array(samples);
    const k = amount * 6;
    for (let i = 0; i < samples; i++) {
        const x = (i / (samples - 1)) * 2 - 1;
        curve[i] = (1 + k) * x / (1 + k * Math.abs(x));
    }
    return curve;
}

function resetVehicleEngineAudioState() {
    vehicleEngineAudio.activePropId = '';
    vehicleEngineAudio.rpm = vehicleEngineAudio.idleRpm;
    vehicleEngineAudio.targetRpm = vehicleEngineAudio.idleRpm;
    vehicleEngineAudio.gear = 1;
    vehicleEngineAudio.throttle = 0;
    vehicleEngineAudio.lastThrottle = 0;
    vehicleEngineAudio.overrun = 0;
    vehicleEngineAudio.lastGrounded = false;
    vehicleEngineAudio.backend = vehicleEngineAudio.wasmGenerator
        ? 'wasm'
        : vehicleEngineAudio.outputGain
            ? 'js'
            : 'none';
    vehicleEngineAudio.crackleCooldown = 0;
    vehicleEngineAudio.lastWorldPosition.set(0, 0, 0);
    vehicleEngineAudio.velocity.set(0, 0, 0);
}

function createVehicleEngineWasmParameters() {
    // Values cribbed from the upstream demo's stable preset
    // (vendor/engine-sound-src/src/engine_sound_generator/sounds_worklet_wasm.htm:90).
    // The waveguide simulation is sensitive to reflection-factor build-up;
    // higher coefficients or longer guides cause the internal state to ring
    // out into silence (or NaN) after a few seconds, which is what the
    // "worked for 3 seconds then died" symptom looks like.
    return {
        cylinders: 4,
        intakeWaveguideLength: 100,
        exhaustWaveguideLength: 100,
        extractorWaveguideLength: 100,
        intakeOpenReflectionFactor: 0.01,
        intakeClosedReflectionFactor: 0.95,
        exhaustOpenReflectionFactor: 0.01,
        exhaustClosedReflectionFactor: 0.95,
        ignitionTime: 0.016,
        straightPipeWaveguideLength: 128,
        straightPipeReflectionFactor: 0.01,
        mufflerElementsLength: [10, 15, 20, 25],
        action: 0.1,
        outletWaveguideLength: 5,
        outletReflectionFactor: 0.01,
    };
}

function describeVehicleEngineWasmError(error) {
    const message = error?.message ? String(error.message) : String(error ?? 'Unknown error');
    if (
        error?.name === 'AbortError'
        || message.includes('Unable to load a worklet')
        || message.includes('environment detection error')
        || message.includes('Chrome v2147483647')
    ) {
        return 'The vendored engine-sound worklet is still built for shell-only Emscripten output, so AudioWorklet startup aborts before the wasm engine can run.';
    }
    return message;
}

function markVehicleEngineWasmUnavailable(error) {
    const reason = describeVehicleEngineWasmError(error);
    const shouldLog = !vehicleEngineAudio.wasmFailed || vehicleEngineAudio.wasmFailureReason !== reason;
    vehicleEngineAudio.wasmModuleReady = false;
    vehicleEngineAudio.wasmFailed = true;
    vehicleEngineAudio.wasmFailureReason = reason;
    if (shouldLog) {
        console.warn('Vehicle engine wasm audio unavailable. Falling back to legacy engine audio.', reason, error);
    }
    shutdownVehicleEngineAudioWasm();
}

function shutdownVehicleEngineAudioWasm() {
    const generator = vehicleEngineAudio.wasmGenerator;
    vehicleEngineAudio.wasmGenerator = null;
    vehicleEngineAudio.wasmThrottleParam = null;
    vehicleEngineAudio.wasmRpmParam = null;

    if (!generator) {
        return;
    }

    try { generator.stop(); } catch (_) {}
    try { generator.disconnect(); } catch (_) {}
    try { generator.removeFromParent(); } catch (_) {}
}

function primeVehicleEngineAudioWasm() {
    const listener = runtimeAudio.listener;
    const audioContext = listener?.context ?? null;
    if (!listener || !audioContext || vehicleEngineAudio.wasmModuleReady || vehicleEngineAudio.wasmFailed || vehicleEngineAudio.wasmLoadPromise) {
        return vehicleEngineAudio.wasmLoadPromise;
    }

    const loadingManager = new THREE.LoadingManager();
    vehicleEngineAudio.wasmLoadPromise = WasmEngineSoundGenerator.load(
        loadingManager,
        listener,
    )
        .then(() => {
            vehicleEngineAudio.wasmModuleReady = true;
            vehicleEngineAudio.wasmFailureReason = '';
            return true;
        })
        .catch((error) => {
            markVehicleEngineWasmUnavailable(error);
            return false;
        })
        .finally(() => {
            vehicleEngineAudio.wasmLoadPromise = null;
        });

    return vehicleEngineAudio.wasmLoadPromise;
}

function shutdownLegacyVehicleEngineAudio() {
    const context = runtimeAudio.listener?.context ?? null;
    const now = context?.currentTime ?? 0;
    const fadeOutTime = now + 0.08;

    if (vehicleEngineAudio.outputGain) {
        const gain = vehicleEngineAudio.outputGain.gain;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(Math.max(0.0001, gain.value || 0.0001), now);
        gain.exponentialRampToValueAtTime(0.0001, fadeOutTime);
    }

    const sourceNodes = [
        vehicleEngineAudio.combustionNode,
        vehicleEngineAudio.harmonic2Node,
        vehicleEngineAudio.harmonic3Node,
        vehicleEngineAudio.bodyNode,
        vehicleEngineAudio.subNode,
        vehicleEngineAudio.whineNode,
        vehicleEngineAudio.noiseNode,
        vehicleEngineAudio.crackleNode,
        vehicleEngineAudio.idleLfo,
    ];
    sourceNodes.forEach((node) => {
        if (!node) return;
        try { node.stop(fadeOutTime + 0.02); } catch (_) {}
        try { node.disconnect(); } catch (_) {}
    });

    const otherNodes = [
        vehicleEngineAudio.combustionGain,
        vehicleEngineAudio.harmonic2Gain,
        vehicleEngineAudio.harmonic3Gain,
        vehicleEngineAudio.bodyGain,
        vehicleEngineAudio.subGain,
        vehicleEngineAudio.whineGain,
        vehicleEngineAudio.intakeGain,
        vehicleEngineAudio.overrunGain,
        vehicleEngineAudio.crackleGain,
        vehicleEngineAudio.crackleEnvelope,
        vehicleEngineAudio.idleLfoGain,
        vehicleEngineAudio.idleLfoOffset,
        vehicleEngineAudio.outputGain,
        vehicleEngineAudio.compressor,
        vehicleEngineAudio.waveShaper,
        vehicleEngineAudio.exhaustFilter,
        vehicleEngineAudio.resonancePeak,
        vehicleEngineAudio.resonanceFilter,
        vehicleEngineAudio.intakeFilter,
        vehicleEngineAudio.hissFilter,
        vehicleEngineAudio.cabinFilter,
        vehicleEngineAudio.masterTone,
        vehicleEngineAudio.panner,
    ];
    otherNodes.forEach((node) => {
        if (!node) return;
        try { node.disconnect(); } catch (_) {}
    });

    [
        'combustionNode', 'harmonic2Node', 'harmonic3Node', 'bodyNode', 'subNode', 'whineNode', 'noiseNode',
        'crackleNode', 'idleLfo',
        'combustionGain', 'harmonic2Gain', 'harmonic3Gain', 'bodyGain', 'subGain', 'whineGain',
        'intakeGain', 'overrunGain', 'crackleGain', 'crackleEnvelope', 'idleLfoGain', 'idleLfoOffset',
        'outputGain', 'compressor', 'waveShaper',
        'exhaustFilter', 'resonancePeak', 'resonanceFilter', 'intakeFilter', 'hissFilter', 'cabinFilter', 'masterTone',
        'panner', 'listener',
    ].forEach((key) => { vehicleEngineAudio[key] = null; });
    resetVehicleEngineAudioState();
}

function shutdownVehicleEngineAudio() {
    shutdownVehicleEngineAudioWasm();
    shutdownLegacyVehicleEngineAudio();
    vehicleEngineAudio.backend = 'none';
}

// Soft-silence the engine audio without tearing down the wasm worklet.
// Called when gameplay drops out so the worklet stays loaded for the next
// drive session (avoids re-initialising the AudioWorklet on every reseat).
function silenceVehicleEngineAudio() {
    const ctx = runtimeAudio.listener?.context ?? null;
    const now = ctx?.currentTime ?? 0;
    const fadeOut = now + 0.12;

    const generator = vehicleEngineAudio.wasmGenerator;
    if (generator?.gain?.gain) {
        const gain = generator.gain.gain;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(Math.max(0.0001, gain.value || 0.0001), now);
        gain.exponentialRampToValueAtTime(0.0001, fadeOut);
    }
    if (vehicleEngineAudio.outputGain) {
        const gain = vehicleEngineAudio.outputGain.gain;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(Math.max(0.0001, gain.value || 0.0001), now);
        gain.exponentialRampToValueAtTime(0.0001, fadeOut);
    }
    resetVehicleEngineAudioState();
}

function ensureLegacyVehicleEngineAudio() {
    const listener = runtimeAudio.listener;
    const audioContext = listener?.context ?? null;
    const listenerInput = typeof listener?.getInput === 'function' ? listener.getInput() : null;
    if (!listener || !audioContext) {
        return null;
    }

    if (vehicleEngineAudio.outputGain && vehicleEngineAudio.listener === listener) {
        vehicleEngineAudio.backend = 'js';
        return vehicleEngineAudio;
    }

    shutdownLegacyVehicleEngineAudio();

    // ── Spatializer ──────────────────────────────────────────────────────────────
    const panner = audioContext.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 5;
    panner.maxDistance = 120;
    panner.rolloffFactor = 0.85;
    panner.coneInnerAngle = 200;
    panner.coneOuterAngle = 320;
    panner.coneOuterGain = 0.72;

    // ── Master output ────────────────────────────────────────────────────────────
    const outputGain = audioContext.createGain();
    outputGain.gain.value = 0.0001;

    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -22;
    compressor.knee.value = 18;
    compressor.ratio.value = 2.4;
    compressor.attack.value = 0.012;
    compressor.release.value = 0.22;

    const waveShaper = audioContext.createWaveShaper();
    waveShaper.curve = createCombustionDistortionCurve(0.15);
    waveShaper.oversample = '4x';

    // Master tone-tamer — rolls off upper harshness, keeps Warthog growl below ~1.6 kHz.
    const masterTone = audioContext.createBiquadFilter();
    masterTone.type = 'lowpass';
    masterTone.frequency.value = 1600;
    masterTone.Q.value = 0.5;

    const cabinFilter = audioContext.createBiquadFilter();
    cabinFilter.type = 'lowshelf';
    cabinFilter.frequency.value = 280;
    cabinFilter.gain.value = 8;

    // ── Exhaust path (combustion thump + harmonics) ──────────────────────────────
    const exhaustFilter = audioContext.createBiquadFilter();
    exhaustFilter.type = 'lowpass';
    exhaustFilter.frequency.value = 360;
    exhaustFilter.Q.value = 0.9;

    const resonancePeak = audioContext.createBiquadFilter();
    resonancePeak.type = 'peaking';
    resonancePeak.frequency.value = 130;
    resonancePeak.Q.value = 3.0;
    resonancePeak.gain.value = 6;

    const resonanceFilter = audioContext.createBiquadFilter();
    resonanceFilter.type = 'lowpass';
    resonanceFilter.frequency.value = 800;
    resonanceFilter.Q.value = 0.7;

    // Combustion: looped pulse buffer at firing freq → throaty individual cylinder thumps.
    const combustionBuffer = createCombustionPulseBuffer(audioContext);
    const combustionNode = audioContext.createBufferSource();
    combustionNode.buffer = combustionBuffer;
    combustionNode.loop = true;
    combustionNode.playbackRate.value = 1;
    const combustionGain = audioContext.createGain();
    combustionGain.gain.value = 0.0001;

    // 2nd-order harmonic — triangle (gentler than saw, fewer high partials).
    const harmonic2Node = audioContext.createOscillator();
    harmonic2Node.type = 'triangle';
    harmonic2Node.frequency.value = 90;
    const harmonic2Gain = audioContext.createGain();
    harmonic2Gain.gain.value = 0.0001;

    // 3rd-order harmonic — sine (just adds gentle warmth, no buzz).
    const harmonic3Node = audioContext.createOscillator();
    harmonic3Node.type = 'sine';
    harmonic3Node.frequency.value = 130;
    const harmonic3Gain = audioContext.createGain();
    harmonic3Gain.gain.value = 0.0001;

    // Sub-octave for chest-thump body.
    const subNode = audioContext.createOscillator();
    subNode.type = 'sine';
    subNode.frequency.value = 32;
    const subGain = audioContext.createGain();
    subGain.gain.value = 0.0001;

    // Mid-body resonance (triangle).
    const bodyNode = audioContext.createOscillator();
    bodyNode.type = 'triangle';
    bodyNode.frequency.value = 110;
    const bodyGain = audioContext.createGain();
    bodyGain.gain.value = 0.0001;

    // ── Intake path (gear/belt rumble + soft turbulence) ─────────────────────────
    const intakeFilter = audioContext.createBiquadFilter();
    intakeFilter.type = 'bandpass';
    intakeFilter.frequency.value = 420;
    intakeFilter.Q.value = 0.9;

    const hissFilter = audioContext.createBiquadFilter();
    hissFilter.type = 'bandpass';
    hissFilter.frequency.value = 800;
    hissFilter.Q.value = 0.7;

    const whineNode = audioContext.createOscillator();
    whineNode.type = 'triangle';
    whineNode.frequency.value = 140;
    const whineGain = audioContext.createGain();
    whineGain.gain.value = 0.0001;

    const noiseBuffer = createEngineNoiseBuffer(audioContext);
    const noiseNode = audioContext.createBufferSource();
    noiseNode.buffer = noiseBuffer;
    noiseNode.loop = true;

    const intakeGain = audioContext.createGain();
    intakeGain.gain.value = 0.0001;

    const overrunGain = audioContext.createGain();
    overrunGain.gain.value = 0.0001;

    // Crackle/pop on overrun — separate noise tap with its own envelope.
    const crackleNode = audioContext.createBufferSource();
    crackleNode.buffer = noiseBuffer;
    crackleNode.loop = true;
    const crackleEnvelope = audioContext.createGain();
    crackleEnvelope.gain.value = 0.0001;
    const crackleGain = audioContext.createGain();
    crackleGain.gain.value = 0.18;

    // Idle LFO — slow wobble on combustion gain so idle isn't flat. Adds to combustionGain.gain.
    const idleLfo = audioContext.createOscillator();
    idleLfo.type = 'sine';
    idleLfo.frequency.value = 4.6;
    const idleLfoGain = audioContext.createGain();
    idleLfoGain.gain.value = 0;
    const idleLfoOffset = null;

    // ── Wiring ───────────────────────────────────────────────────────────────────
    // Combustion thump path
    combustionNode.connect(combustionGain);
    combustionGain.connect(exhaustFilter);
    harmonic2Node.connect(harmonic2Gain);
    harmonic2Gain.connect(exhaustFilter);
    harmonic3Node.connect(harmonic3Gain);
    harmonic3Gain.connect(exhaustFilter);
    bodyNode.connect(bodyGain);
    bodyGain.connect(resonancePeak);
    exhaustFilter.connect(resonancePeak);
    resonancePeak.connect(resonanceFilter);
    resonanceFilter.connect(waveShaper);

    // Sub thump goes around the saturator to keep low end clean.
    subNode.connect(subGain);
    subGain.connect(cabinFilter);

    // Intake path
    whineNode.connect(whineGain);
    whineGain.connect(intakeFilter);
    noiseNode.connect(intakeGain);
    intakeGain.connect(intakeFilter);
    intakeFilter.connect(panner);

    // Overrun hiss
    noiseNode.connect(overrunGain);
    overrunGain.connect(hissFilter);
    hissFilter.connect(panner);

    // Crackle path — gated noise into hiss filter for snappy pops.
    crackleNode.connect(crackleEnvelope);
    crackleEnvelope.connect(crackleGain);
    crackleGain.connect(hissFilter);

    // Saturated combustion + clean sub merge into cabin lowshelf.
    waveShaper.connect(cabinFilter);
    cabinFilter.connect(panner);

    // Idle LFO adds wobble directly to combustionGain.gain.
    idleLfo.connect(idleLfoGain);
    idleLfoGain.connect(combustionGain.gain);

    panner.connect(compressor);
    compressor.connect(masterTone);
    masterTone.connect(outputGain);
    outputGain.connect(listenerInput ?? audioContext.destination);

    const startTime = audioContext.currentTime + 0.01;
    combustionNode.start(startTime);
    harmonic2Node.start(startTime);
    harmonic3Node.start(startTime);
    bodyNode.start(startTime);
    subNode.start(startTime);
    whineNode.start(startTime);
    noiseNode.start(startTime);
    crackleNode.start(startTime);
    idleLfo.start(startTime);

    Object.assign(vehicleEngineAudio, {
        listener,
        combustionNode, harmonic2Node, harmonic3Node, bodyNode, subNode, whineNode, noiseNode,
        crackleNode, idleLfo,
        combustionGain, harmonic2Gain, harmonic3Gain, bodyGain, subGain, whineGain,
        intakeGain, overrunGain, crackleGain, crackleEnvelope, idleLfoGain, idleLfoOffset,
        outputGain, compressor, waveShaper, masterTone,
        exhaustFilter, resonancePeak, resonanceFilter, intakeFilter, hissFilter, cabinFilter,
        panner,
    });
    vehicleEngineAudio.rpm = vehicleEngineAudio.idleRpm;
    vehicleEngineAudio.targetRpm = vehicleEngineAudio.idleRpm;
    vehicleEngineAudio.gear = 1;
    vehicleEngineAudio.throttle = 0;
    vehicleEngineAudio.lastThrottle = 0;
    vehicleEngineAudio.overrun = 0;
    vehicleEngineAudio.crackleCooldown = 0;
    vehicleEngineAudio.lastWorldPosition.set(0, 0, 0);
    vehicleEngineAudio.velocity.set(0, 0, 0);
    vehicleEngineAudio.backend = 'js';
    return vehicleEngineAudio;
}

function ensureVehicleEngineAudioWasm(vehicle) {
    const listener = runtimeAudio.listener;
    const audioContext = listener?.context ?? null;
    const mesh = vehicle?.mesh ?? null;
    if (!listener || !audioContext || !mesh || !vehicleEngineAudio.wasmModuleReady || vehicleEngineAudio.wasmFailed) {
        return null;
    }

    const existingGenerator = vehicleEngineAudio.wasmGenerator;
    if (existingGenerator && vehicleEngineAudio.listener === listener) {
        if (existingGenerator.parent !== mesh) {
            vehicleEngineAudio.wasmReattachCount = (vehicleEngineAudio.wasmReattachCount || 0) + 1;
            console.warn('[wasm-engine] reparenting generator (count=', vehicleEngineAudio.wasmReattachCount, ')');
            try { existingGenerator.removeFromParent(); } catch (_) {}
            mesh.add(existingGenerator);
            existingGenerator.position.set(0, 0.45, 0);
            existingGenerator.reset?.();
        }
        vehicleEngineAudio.backend = 'wasm';
        return vehicleEngineAudio;
    }

    vehicleEngineAudio.wasmCreateCount = (vehicleEngineAudio.wasmCreateCount || 0) + 1;
    console.warn('[wasm-engine] creating new generator (count=', vehicleEngineAudio.wasmCreateCount, ')');
    shutdownLegacyVehicleEngineAudio();
    shutdownVehicleEngineAudioWasm();

    let generator;
    try {
        generator = new WasmEngineSoundGenerator({
            listener,
            parameters: createVehicleEngineWasmParameters(),
        });
    } catch (error) {
        markVehicleEngineWasmUnavailable(error);
        return null;
    }

    const throttleParam = generator.worklet?.parameters?.get('throttle') ?? null;
    const rpmParam = generator.worklet?.parameters?.get('rpm') ?? null;

    Object.assign(vehicleEngineAudio, {
        listener,
        wasmGenerator: generator,
        wasmThrottleParam: throttleParam,
        wasmRpmParam: rpmParam,
        backend: 'wasm',
    });

    if (!throttleParam || !rpmParam) {
        markVehicleEngineWasmUnavailable(new Error('The engine sound worklet did not expose the expected throttle/rpm parameters.'));
        return null;
    }

    // Seed the AudioParams so the very first process() call has firing-range
    // RPM. Defaults are 0/0 which produces silence and (with the previous
    // clamp WaveShaper) caused the "beep then silence" symptom.
    const ctxNow = audioContext.currentTime;
    throttleParam.setValueAtTime(0, ctxNow);
    rpmParam.setValueAtTime(vehicleEngineAudio.idleRpm, ctxNow);

    // Surface worklet processor errors. AudioWorklet.process() throwing
    // silently kills the node — browser stops calling process() forever and
    // the result is "audio worked for N seconds then died" with no console
    // output. Hook the error event so we know.
    if (generator.worklet) {
        generator.worklet.onprocessorerror = (event) => {
            vehicleEngineAudio.wasmProcessorError = String(event?.message || event || 'processor error');
            console.error('[wasm-engine] AudioWorklet processor error:', event);
            markVehicleEngineWasmUnavailable(new Error(vehicleEngineAudio.wasmProcessorError));
        };
    }
    console.info('[wasm-engine] generator created. sampleRate =', audioContext.sampleRate, 'state =', audioContext.state);

    generator.name = 'vehicle-engine-wasm-audio';
    generator.position.set(0, 0.45, 0);
    generator.setRefDistance(5);
    generator.setMaxDistance(120);
    generator.setRolloffFactor(0.85);
    generator.setDirectionalCone(200, 320, 0.72);
    generator.gain.gain.value = 0.4;
    generator.gainIntake.gain.value = 0.16;
    generator.gainEngineBlockVibrations.gain.value = 0.22;
    generator.gainOutlet.gain.value = 0.3;
    mesh.add(generator);

    try {
        generator.play();
    } catch (error) {
        markVehicleEngineWasmUnavailable(error);
        return null;
    }

    resetVehicleEngineAudioState();
    return vehicleEngineAudio;
}

function ensureVehicleEngineAudio(vehicle = null) {
    primeVehicleEngineAudioWasm();
    return ensureVehicleEngineAudioWasm(vehicle) ?? ensureLegacyVehicleEngineAudio();
}

function updateLegacyVehicleEngineAudio(delta, vehicle, telemetry) {
    const engine = ensureLegacyVehicleEngineAudio();
    const audioContext = runtimeAudio.listener?.context ?? null;
    if (!engine || !audioContext || !vehicle?.id || !vehicle?.mesh) {
        shutdownLegacyVehicleEngineAudio();
        return;
    }

    const now = audioContext.currentTime;
    const isActiveVehicle = gameplay.active && vehicleState.activePropId === vehicle.id;
    const mesh = vehicle.mesh;
    const body = getActorBody(vehicle);
    const bodyId = body?.GetID?.() ?? null;

    if (!isActiveVehicle || !bodyId) {
        if (engine.outputGain) {
            const gain = engine.outputGain.gain;
            gain.cancelScheduledValues(now);
            gain.setValueAtTime(Math.max(0.0001, gain.value || 0.0001), now);
            gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
        }
        resetVehicleEngineAudioState();
        return;
    }

    runtimeAudio.resume();
    engine.activePropId = vehicle.id;

    const throttleInput = telemetry?.throttleInput ?? 0;
    const brakeHeld = telemetry?.brakeHeld === true;
    const grounded = telemetry?.grounded === true;
    const forwardSpeed = telemetry?.forwardSpeed ?? 0;
    const speedRatio = THREE.MathUtils.clamp(Math.abs(forwardSpeed) / VEHICLE_SETTINGS.maxDriveSpeed, 0, 1);
    const throttleDemand = Math.abs(throttleInput);
    const gearCount = 5;
    const targetGear = THREE.MathUtils.clamp(
        Math.floor(speedRatio * (gearCount - 0.15) + 1 + throttleDemand * 0.25),
        1,
        gearCount,
    );
    engine.gear = THREE.MathUtils.damp(engine.gear, targetGear, grounded ? 5.8 : 2.4, delta);
    const gearIndex = THREE.MathUtils.clamp(Math.round(engine.gear), 1, gearCount);
    const gearStartRatio = (gearIndex - 1) / gearCount;
    const gearEndRatio = gearIndex / gearCount;
    const gearBand = Math.max(0.0001, gearEndRatio - gearStartRatio);
    const gearProgress = THREE.MathUtils.clamp((speedRatio - gearStartRatio) / gearBand, 0, 1);
    const revKick = grounded ? throttleDemand * 1400 : throttleDemand * 650;
    const brakeDip = brakeHeld ? 220 : 0;
    const targetRpm = clampVehicleEngineRpm(
        engine.idleRpm + gearProgress * (engine.maxRpm - engine.idleRpm * 1.08) + revKick - brakeDip
    );
    const rpmLambda = throttleDemand > 0.04
        ? 6.5
        : brakeHeld
            ? 5.2
            : 2.8;
    engine.targetRpm = targetRpm;
    engine.rpm = THREE.MathUtils.damp(engine.rpm, targetRpm, rpmLambda, delta);
    engine.throttle = THREE.MathUtils.damp(engine.throttle, throttleDemand, grounded ? 7.5 : 3.5, delta);
    const throttleDrop = Math.max(0, engine.lastThrottle - throttleDemand);
    const overrunTarget = (!brakeHeld && throttleDemand < 0.08 && speedRatio > 0.18)
        ? THREE.MathUtils.clamp(0.22 + speedRatio * 0.9 + throttleDrop * 1.8, 0, 1)
        : 0;
    engine.overrun = THREE.MathUtils.damp(engine.overrun, overrunTarget, overrunTarget > 0 ? 9.5 : 4.5, delta);
    engine.lastThrottle = throttleDemand;
    engine.lastGrounded = grounded;

    const idleBlend = THREE.MathUtils.clamp((engine.rpm - engine.idleRpm) / 1600, 0, 1);
    const rpmRatio = THREE.MathUtils.clamp((engine.rpm - engine.minRpm) / (engine.maxRpm - engine.minRpm), 0, 1);
    // V8 4-stroke: 4 power strokes per rev → firing freq = rpm/60 * 4.
    // Halved further to land in chunky 18–140 Hz burble range so each cylinder is audible.
    const cylinders = 8;
    const firingFrequency = THREE.MathUtils.clamp((engine.rpm / 60) * (cylinders / 2), 18, 160);
    // Combustion buffer fundamental is 38 Hz; rate scales fundamental to firing freq.
    const combustionPlaybackRate = THREE.MathUtils.clamp(firingFrequency / 38, 0.45, 3.6);

    // Harmonic stack tracks combustion — kept low-mid, no top end.
    const harmonic2Frequency = firingFrequency * 1.5;
    const harmonic3Frequency = firingFrequency * 2.0;
    const subFrequency = THREE.MathUtils.clamp(firingFrequency * 0.5, 16, 70);
    const bodyFrequency = THREE.MathUtils.lerp(firingFrequency * 1.1, firingFrequency * 1.35, idleBlend);
    // No turbo whine — Warthog is naturally aspirated. This becomes a subtle gear/belt whine
    // that only appears under speed, low pitch.
    const intakeWhineFrequency = THREE.MathUtils.lerp(120, 480, Math.pow(speedRatio, 0.9));

    // ── Per-section levels — Warthog: massive low-end, throaty mids, no top whine ──
    const masterGain = 0.12 + speedRatio * 0.10 + engine.throttle * 0.16 + engine.overrun * 0.03 + (grounded ? 0.02 : 0);
    const combustionLevel = 0.36 + engine.throttle * 0.20 + speedRatio * 0.06 + idleBlend * 0.06;
    const harmonic2Level = 0.04 + engine.throttle * 0.10 + rpmRatio * 0.05;
    const harmonic3Level = 0.01 + engine.throttle * 0.05 + Math.pow(rpmRatio, 1.4) * 0.03;
    const bodyLevel = 0.10 + idleBlend * 0.10 + speedRatio * 0.06 + engine.overrun * 0.03;
    const subLevel = 0.32 + idleBlend * 0.12 + engine.throttle * 0.18;
    const whineLevel = 0.0005 + Math.max(0, speedRatio - 0.2) * 0.012;
    const intakeNoiseLevel = 0.004 + engine.throttle * 0.024 + speedRatio * 0.008;
    const overrunNoiseLevel = 0.001 + engine.overrun * 0.04 + (brakeHeld ? 0.008 : 0);

    // Filter frequencies — Warthog stays low-mid; only the upper roll-off opens with throttle.
    const exhaustFilterFrequency = 260 + rpmRatio * 320 + engine.throttle * 180;
    const resonancePeakFrequency = 110 + rpmRatio * 140 + idleBlend * 40;
    const resonanceCutoff = 600 + idleBlend * 380 + engine.throttle * 720 + speedRatio * 220;
    const intakeFilterFrequency = 360 + engine.throttle * 480 + speedRatio * 220;
    const hissCutoff = 1800 + engine.overrun * 800 + speedRatio * 400;

    // ── Apply ────────────────────────────────────────────────────────────────────
    engine.combustionNode.playbackRate.cancelScheduledValues(now);
    engine.combustionNode.playbackRate.setTargetAtTime(combustionPlaybackRate, now, 0.04);
    engine.harmonic2Node.frequency.cancelScheduledValues(now);
    engine.harmonic2Node.frequency.setTargetAtTime(harmonic2Frequency, now, 0.05);
    engine.harmonic3Node.frequency.cancelScheduledValues(now);
    engine.harmonic3Node.frequency.setTargetAtTime(harmonic3Frequency, now, 0.05);
    engine.bodyNode.frequency.cancelScheduledValues(now);
    engine.bodyNode.frequency.setTargetAtTime(bodyFrequency, now, 0.06);
    engine.subNode.frequency.cancelScheduledValues(now);
    engine.subNode.frequency.setTargetAtTime(subFrequency, now, 0.08);
    engine.whineNode.frequency.cancelScheduledValues(now);
    engine.whineNode.frequency.setTargetAtTime(intakeWhineFrequency, now, 0.06);

    engine.outputGain.gain.cancelScheduledValues(now);
    engine.outputGain.gain.setTargetAtTime(Math.max(0.0001, masterGain), now, grounded ? 0.06 : 0.12);
    engine.combustionGain.gain.cancelScheduledValues(now);
    engine.combustionGain.gain.setTargetAtTime(Math.max(0.0001, combustionLevel), now, 0.05);
    // Idle wobble LFO sums on top of combustionGain.gain; depth shrinks with throttle and revs.
    engine.idleLfoGain.gain.cancelScheduledValues(now);
    engine.idleLfoGain.gain.setTargetAtTime(0.06 * (1 - engine.throttle) * (1 - rpmRatio * 0.6), now, 0.1);

    engine.harmonic2Gain.gain.cancelScheduledValues(now);
    engine.harmonic2Gain.gain.setTargetAtTime(Math.max(0.0001, harmonic2Level), now, 0.06);
    engine.harmonic3Gain.gain.cancelScheduledValues(now);
    engine.harmonic3Gain.gain.setTargetAtTime(Math.max(0.0001, harmonic3Level), now, 0.06);
    engine.bodyGain.gain.cancelScheduledValues(now);
    engine.bodyGain.gain.setTargetAtTime(Math.max(0.0001, bodyLevel), now, 0.06);
    engine.subGain.gain.cancelScheduledValues(now);
    engine.subGain.gain.setTargetAtTime(Math.max(0.0001, subLevel), now, 0.08);
    engine.whineGain.gain.cancelScheduledValues(now);
    engine.whineGain.gain.setTargetAtTime(Math.max(0.0001, whineLevel), now, 0.06);
    engine.intakeGain.gain.cancelScheduledValues(now);
    engine.intakeGain.gain.setTargetAtTime(Math.max(0.0001, intakeNoiseLevel), now, 0.07);
    engine.overrunGain.gain.cancelScheduledValues(now);
    engine.overrunGain.gain.setTargetAtTime(Math.max(0.0001, overrunNoiseLevel), now, 0.04);

    engine.exhaustFilter.frequency.cancelScheduledValues(now);
    engine.exhaustFilter.frequency.setTargetAtTime(exhaustFilterFrequency, now, 0.05);
    engine.resonancePeak.frequency.cancelScheduledValues(now);
    engine.resonancePeak.frequency.setTargetAtTime(resonancePeakFrequency, now, 0.08);
    engine.resonancePeak.gain.cancelScheduledValues(now);
    engine.resonancePeak.gain.setTargetAtTime(2 + engine.throttle * 2, now, 0.08);
    engine.resonanceFilter.frequency.cancelScheduledValues(now);
    engine.resonanceFilter.frequency.setTargetAtTime(resonanceCutoff, now, 0.08);
    engine.intakeFilter.frequency.cancelScheduledValues(now);
    engine.intakeFilter.frequency.setTargetAtTime(intakeFilterFrequency, now, 0.07);
    engine.hissFilter.frequency.cancelScheduledValues(now);
    engine.hissFilter.frequency.setTargetAtTime(hissCutoff, now, 0.05);

    // ── Crackle / pop on lift-off — sparse and quiet, just texture ──────────────
    engine.crackleCooldown = Math.max(0, engine.crackleCooldown - delta);
    if (engine.overrun > 0.6 && engine.crackleCooldown <= 0 && Math.random() < 0.25) {
        const popTime = now + 0.005;
        const popDuration = 0.05 + Math.random() * 0.06;
        const popPeak = 0.12 + engine.overrun * 0.12 + Math.random() * 0.08;
        engine.crackleEnvelope.gain.cancelScheduledValues(popTime);
        engine.crackleEnvelope.gain.setValueAtTime(0.0001, popTime);
        engine.crackleEnvelope.gain.exponentialRampToValueAtTime(popPeak, popTime + 0.008);
        engine.crackleEnvelope.gain.exponentialRampToValueAtTime(0.0001, popTime + popDuration);
        engine.crackleCooldown = 0.18 + Math.random() * 0.32;
    }

    // ── Spatializer position + simple Doppler via velocity ──────────────────────
    const worldPosition = mesh.getWorldPosition(new THREE.Vector3());
    const worldForward = mesh.getWorldDirection(new THREE.Vector3()).normalize();
    if (delta > 0 && engine.lastWorldPosition.lengthSq() > 0) {
        engine.velocity.subVectors(worldPosition, engine.lastWorldPosition).divideScalar(delta);
    }
    engine.lastWorldPosition.copy(worldPosition);
    engine.panner.positionX.setValueAtTime(worldPosition.x, now);
    engine.panner.positionY.setValueAtTime(worldPosition.y + 0.45, now);
    engine.panner.positionZ.setValueAtTime(worldPosition.z, now);
    engine.panner.orientationX.setValueAtTime(worldForward.x, now);
    engine.panner.orientationY.setValueAtTime(worldForward.y, now);
    engine.panner.orientationZ.setValueAtTime(worldForward.z, now);
}

function updateVehicleEngineAudioWasm(delta, vehicle, telemetry) {
    const engine = ensureVehicleEngineAudioWasm(vehicle);
    const audioContext = runtimeAudio.listener?.context ?? null;
    const generator = engine?.wasmGenerator ?? null;
    if (!engine || !generator || !audioContext || !vehicle?.id || !vehicle?.mesh) {
        // Keep the worklet alive across transient vehicle drops; just skip
        // this tick. Tearing down here was the source of "wasm engine doesn't
        // stay" — every momentary gap recycled the AudioWorkletNode.
        return false;
    }

    const now = audioContext.currentTime;
    const isActiveVehicle = gameplay.active && vehicleState.activePropId === vehicle.id;
    const body = getActorBody(vehicle);
    const bodyId = body?.GetID?.() ?? null;

    if (!isActiveVehicle || !bodyId) {
        generator.gain.gain.cancelScheduledValues(now);
        generator.gain.gain.setValueAtTime(Math.max(0.0001, generator.gain.gain.value || 0.0001), now);
        generator.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
        resetVehicleEngineAudioState();
        return true;
    }

    runtimeAudio.resume();
    engine.activePropId = vehicle.id;

    const throttleInput = telemetry?.throttleInput ?? 0;
    const brakeHeld = telemetry?.brakeHeld === true;
    const grounded = telemetry?.grounded === true;
    const forwardSpeed = telemetry?.forwardSpeed ?? 0;
    const speedRatio = THREE.MathUtils.clamp(Math.abs(forwardSpeed) / VEHICLE_SETTINGS.maxDriveSpeed, 0, 1);
    const throttleDemand = Math.abs(throttleInput);
    const gearCount = 5;
    const targetGear = THREE.MathUtils.clamp(
        Math.floor(speedRatio * (gearCount - 0.15) + 1 + throttleDemand * 0.25),
        1,
        gearCount,
    );
    engine.gear = THREE.MathUtils.damp(engine.gear, targetGear, grounded ? 5.8 : 2.4, delta);
    const gearIndex = THREE.MathUtils.clamp(Math.round(engine.gear), 1, gearCount);
    const gearStartRatio = (gearIndex - 1) / gearCount;
    const gearEndRatio = gearIndex / gearCount;
    const gearBand = Math.max(0.0001, gearEndRatio - gearStartRatio);
    const gearProgress = THREE.MathUtils.clamp((speedRatio - gearStartRatio) / gearBand, 0, 1);
    const revKick = grounded ? throttleDemand * 1400 : throttleDemand * 650;
    const brakeDip = brakeHeld ? 220 : 0;
    const targetRpm = clampVehicleEngineRpm(
        engine.idleRpm + gearProgress * (engine.maxRpm - engine.idleRpm * 1.08) + revKick - brakeDip
    );
    const rpmLambda = throttleDemand > 0.04
        ? 6.5
        : brakeHeld
            ? 5.2
            : 2.8;
    engine.targetRpm = targetRpm;
    engine.rpm = THREE.MathUtils.damp(engine.rpm, targetRpm, rpmLambda, delta);
    engine.throttle = THREE.MathUtils.damp(engine.throttle, throttleDemand, grounded ? 7.5 : 3.5, delta);
    const throttleDrop = Math.max(0, engine.lastThrottle - throttleDemand);
    const overrunTarget = (!brakeHeld && throttleDemand < 0.08 && speedRatio > 0.18)
        ? THREE.MathUtils.clamp(0.22 + speedRatio * 0.9 + throttleDrop * 1.8, 0, 1)
        : 0;
    engine.overrun = THREE.MathUtils.damp(engine.overrun, overrunTarget, overrunTarget > 0 ? 9.5 : 4.5, delta);
    engine.lastThrottle = throttleDemand;
    engine.lastGrounded = grounded;

    const idleBlend = THREE.MathUtils.clamp((engine.rpm - engine.idleRpm) / 1600, 0, 1);
    const masterGain = 0.05 + speedRatio * 0.04 + engine.throttle * 0.06 + engine.overrun * 0.015 + (grounded ? 0.01 : 0);
    const intakeGain = 0.12 + engine.throttle * 0.16 + speedRatio * 0.04;
    const blockGain = 0.18 + idleBlend * 0.06 + engine.throttle * 0.14 + engine.overrun * 0.03;
    const outletGain = 0.24 + engine.throttle * 0.18 + speedRatio * 0.06 + engine.overrun * 0.04;

    generator.gain.gain.cancelScheduledValues(now);
    generator.gain.gain.setTargetAtTime(Math.max(0.0001, masterGain), now, grounded ? 0.06 : 0.12);
    generator.gainIntake.gain.cancelScheduledValues(now);
    generator.gainIntake.gain.setTargetAtTime(Math.max(0.0001, intakeGain), now, 0.08);
    generator.gainEngineBlockVibrations.gain.cancelScheduledValues(now);
    generator.gainEngineBlockVibrations.gain.setTargetAtTime(Math.max(0.0001, blockGain), now, 0.08);
    generator.gainOutlet.gain.cancelScheduledValues(now);
    generator.gainOutlet.gain.setTargetAtTime(Math.max(0.0001, outletGain), now, 0.08);

    engine.wasmThrottleParam.cancelScheduledValues(now);
    engine.wasmThrottleParam.setTargetAtTime(engine.throttle, now, grounded ? 0.04 : 0.09);
    engine.wasmRpmParam.cancelScheduledValues(now);
    engine.wasmRpmParam.setTargetAtTime(engine.rpm, now, 0.05);

    return true;
}

function updateVehicleEngineAudio(delta, vehicle, telemetry) {
    primeVehicleEngineAudioWasm();

    let backendUsed = 'legacy';
    if (vehicleEngineAudio.wasmModuleReady && !vehicleEngineAudio.wasmFailed) {
        const usedWasm = updateVehicleEngineAudioWasm(delta, vehicle, telemetry);
        if (usedWasm) {
            backendUsed = 'wasm';
        }
    }
    if (backendUsed !== 'wasm') {
        updateLegacyVehicleEngineAudio(delta, vehicle, telemetry);
    }
    updateEngineAudioDebugOverlay(backendUsed, vehicle, telemetry);
}

function updateEngineAudioDebugOverlay(backendUsed, vehicle, telemetry) {
    if (!engineAudioDebugEl) return;

    const ready = vehicleEngineAudio.wasmModuleReady;
    const failed = vehicleEngineAudio.wasmFailed;
    const loading = !!vehicleEngineAudio.wasmLoadPromise;
    const generator = vehicleEngineAudio.wasmGenerator;
    const node = generator?.worklet ?? null;
    const ctx = runtimeAudio.listener?.context ?? null;
    const isActiveVehicle = !!vehicle?.id && gameplay.active && vehicleState.activePropId === vehicle.id;

    let state;
    if (failed) state = 'failed';
    else if (loading) state = 'loading';
    else if (ready && backendUsed === 'wasm') state = 'wasm';
    else if (ready) state = 'wasm-idle';
    else state = 'legacy';

    const masterGainNow = generator?.gain?.gain?.value;
    const intakeGainNow = generator?.gainIntake?.gain?.value;
    const outletGainNow = generator?.gainOutlet?.gain?.value;
    const wasmRpmParamNow = vehicleEngineAudio.wasmRpmParam?.value;
    const wasmThrottleParamNow = vehicleEngineAudio.wasmThrottleParam?.value;
    const lines = [
        `Engine Audio: ${state.toUpperCase()}`,
        `backend     : ${backendUsed}`,
        `wasm ready  : ${ready ? 'yes' : 'no'}`,
        `wasm failed : ${failed ? 'yes' : 'no'}`,
        `worklet node: ${node ? 'attached' : 'none'}`,
        `parented to : ${generator?.parent?.name || generator?.parent ? (generator.parent.name || 'mesh') : 'detached'}`,
        `audio ctx   : ${ctx ? ctx.state : 'none'}`,
        `active veh  : ${isActiveVehicle ? vehicle.id : 'none'}`,
        `rpm/throttle: ${vehicleEngineAudio.rpm.toFixed(0)} / ${vehicleEngineAudio.throttle.toFixed(2)}`,
        `wasm params : rpm=${(wasmRpmParamNow ?? -1).toFixed(0)} thr=${(wasmThrottleParamNow ?? -1).toFixed(2)}`,
        `wasm gains  : m=${(masterGainNow ?? 0).toFixed(3)} i=${(intakeGainNow ?? 0).toFixed(2)} o=${(outletGainNow ?? 0).toFixed(2)}`,
        `creates/reattaches: ${vehicleEngineAudio.wasmCreateCount || 0} / ${vehicleEngineAudio.wasmReattachCount || 0}`,
        `sample rate : ${ctx?.sampleRate ?? '--'}`,
    ];
    if (vehicleEngineAudio.wasmProcessorError) {
        lines.push(`processor err: ${vehicleEngineAudio.wasmProcessorError}`);
    }
    if (failed && vehicleEngineAudio.wasmFailureReason) {
        lines.push(`reason      : ${vehicleEngineAudio.wasmFailureReason}`);
    }
    engineAudioDebugEl.textContent = lines.join('\n');

    engineAudioDebugEl.classList.toggle('is-wasm-ok', state === 'wasm');
    engineAudioDebugEl.classList.toggle('is-wasm-loading', state === 'loading');
    engineAudioDebugEl.classList.toggle('is-wasm-failed', state === 'failed');
    engineAudioDebugEl.classList.toggle('is-legacy', state === 'legacy');
    engineAudioDebugEl.classList.toggle('is-idle', state === 'wasm-idle' || !isActiveVehicle);
}

function resolveRuntimeSoundBuffer(soundSpec) {
    const audioContext = runtimeAudio.listener?.context ?? null;
    if (!audioContext) {
        return Promise.resolve(null);
    }

    if (typeof AudioBuffer !== 'undefined' && soundSpec instanceof AudioBuffer) {
        return Promise.resolve(soundSpec);
    }

    if (!soundSpec || soundSpec === TEST_SOUND_ID || soundSpec === 'test' || soundSpec === 'default') {
        if (!runtimeAudio.testBuffer) {
            runtimeAudio.testBuffer = createTestSoundBuffer(audioContext);
        }
        return Promise.resolve(runtimeAudio.testBuffer);
    }

    const url = String(soundSpec);
    return new Promise((resolve, reject) => {
        runtimeAudio.loader.load(url, resolve, undefined, reject);
    });
}

async function playSoundAtLocation(soundSpec = TEST_SOUND_ID, location = null, options = {}) {
    if (!scene || !runtimeAudio.listener) {
        return false;
    }

    await runtimeAudio.resume();

    const buffer = await resolveRuntimeSoundBuffer(soundSpec);
    if (!buffer) {
        return false;
    }

    const anchor = new THREE.Object3D();
    anchor.position.copy(resolveSoundLocation(location, options.fallbackDistance ?? 3));
    anchor.name = 'transient-audio-anchor';
    scene.add(anchor);
    runtimeAudio.transientAnchors.add(anchor);

    const sound = new THREE.PositionalAudio(runtimeAudio.listener);
    anchor.add(sound);
    sound.setBuffer(buffer);
    sound.setLoop(!!options.loop);
    sound.setVolume(Number.isFinite(options.volume) ? options.volume : 0.95);
    sound.setPlaybackRate(Number.isFinite(options.playbackRate) ? options.playbackRate : 1);
    sound.setRefDistance(Number.isFinite(options.refDistance) ? options.refDistance : 2.4);
    sound.setMaxDistance(Number.isFinite(options.maxDistance) ? options.maxDistance : 42);
    sound.setRolloffFactor(Number.isFinite(options.rolloffFactor) ? options.rolloffFactor : 1.2);

    try {
        sound.play(options.delay ?? 0);
    } catch (error) {
        cleanupTransientAudio(anchor, sound);
        console.warn('Failed to play positional sound.', error);
        return false;
    }

    if (!options.loop && sound.source) {
        const previousOnEnded = sound.source.onended;
        sound.source.onended = (...args) => {
            previousOnEnded?.(...args);
            cleanupTransientAudio(anchor, sound);
        };
    }

    return { anchor, sound };
}

function getAudioTestLocation() {
    const selectedActor = getDynamicPropById(objectScriptState.targetPropId);
    const selectedMesh = getActorRenderObject(selectedActor);
    if (selectedMesh) {
        return selectedMesh.getWorldPosition(new THREE.Vector3());
    }

    return resolveSoundLocation(null, gameplay.active ? 4 : 3);
}

async function playAudioTestCue() {
    const location = getAudioTestLocation();
    const [positionalResult, speakerResult, mediaResult] = await Promise.allSettled([
        playSoundAtLocation(TEST_SOUND_ID, location, {
            volume: 1,
            refDistance: 2.8,
            maxDistance: 48,
        }),
        playSpeakerTestTone(),
        playMediaElementTestSound(),
    ]);
    const didPlayPositional = positionalResult.status === 'fulfilled' && !!positionalResult.value;
    const didPlaySpeaker = speakerResult.status === 'fulfilled' && !!speakerResult.value;
    const didPlayMedia = mediaResult.status === 'fulfilled' && !!mediaResult.value;
    const result = didPlayPositional || didPlaySpeaker || didPlayMedia;

    if (playTestSoundStatus) {
        playTestSoundStatus.textContent = result
            ? `Played test sound at ${location.x.toFixed(1)}, ${location.y.toFixed(1)}, ${location.z.toFixed(1)}. WebAudio and media-element fallbacks also triggered.`
            : 'Test sound failed. Click inside the app once to unlock audio and try again.';
    }

    return result;
}

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

    if (gameplay.active && isDrivingVehicle()) {
        const vehicle = getActiveVehicleProp();
        if (!vehicle?.body) return null;

        const bodyId = vehicle.body.GetID();
        const vehiclePosition = copyJoltVector(tempVectorA, physics.bodyInterface.GetPosition(bodyId)).clone();
        const vehicleRotation = copyJoltQuaternion(tempQuaternionA, physics.bodyInterface.GetRotation(bodyId)).clone();

        return {
            mode: 'vehicle',
            position: serializeVector3(vehiclePosition),
            quaternion: serializeQuaternion(vehicleRotation),
        };
    }

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

    return {
        mode: gameplay.active ? 'player' : 'showcase',
        position: serializeVector3(localPosition),
        quaternion: serializeQuaternion(localRotation),
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

function disposeRenderableObject(root) {
    if (!root) return;

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

function cloneDisposableObject(root) {
    const clone = root.clone(true);

    clone.traverse((child) => {
        if (!child.isMesh) return;

        child.geometry = child.geometry.clone();
        child.material = Array.isArray(child.material)
            ? child.material.map((material) => material.clone())
            : child.material.clone();
        child.castShadow = true;
        child.receiveShadow = true;
    });

    return clone;
}

function formatImportedPropName(name) {
    const withoutExtension = name.replace(/\.[^.]+$/, '');
    const collapsed = withoutExtension.replace(/[\-_]+/g, ' ').trim();
    return collapsed || 'Imported Prop';
}

function normalizeObjectToDimension(root, targetDimension, centerOnFloor = true) {
    if (!root) return;

    root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(tempVectorA);
    const size = box.getSize(tempVectorB);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const targetScale = targetDimension / maxDim;

    root.scale.setScalar(targetScale);
    root.position.x = -center.x * targetScale;
    root.position.z = -center.z * targetScale;
    root.position.y = centerOnFloor ? -box.min.y * targetScale : -center.y * targetScale;
    root.updateMatrixWorld(true);
}

function createLoadingManager(fileMap = {}) {
    const manager = new THREE.LoadingManager();
    manager.addHandler(/\.tga$/i, new TGALoader(manager));
    manager.addHandler(/\.dds$/i, new DDSLoader(manager));
    manager.onLoad = () => console.log('[TextureManager] All textures loaded');
    manager.onError = (url) => console.warn('[TextureManager] Failed to load:', url);

    manager.setURLModifier((originalUrl) => {
        if (originalUrl.startsWith('data:') || originalUrl.startsWith('blob:')) {
            return originalUrl;
        }

        const filename = originalUrl.split(/[\\/]/).pop().split('?')[0].split('#')[0].toLowerCase();
        if (fileMap[filename]) {
            console.log(`[TextureResolver] Resolved: ${filename}`);
            return fileMap[filename].url;
        }

        const baseName = filename.replace(/\.[^.]+$/, '');
        const possibleExts = ['.png', '.jpg', '.jpeg', '.tga', '.dds', '.bmp', '.webp'];

        for (const ext of possibleExts) {
            const possibleName = baseName + ext;
            if (fileMap[possibleName]) {
                console.log(`[TextureResolver] Resolved ${filename} -> ${possibleName}`);
                return fileMap[possibleName].url;
            }
        }

        if (Object.keys(fileMap).length > 0) {
            console.warn(`[TextureResolver] Not found: ${filename}`);
        }

        return originalUrl;
    });

    return manager;
}

function convertLoadedObjectMaterials(root) {
    root.traverse((child) => {
        if (!child.isMesh) return;

        child.castShadow = true;
        child.receiveShadow = true;

        if (!child.geometry.attributes.normal) {
            child.geometry.computeVertexNormals();
        }

        const materials = Array.isArray(child.material) ? child.material : [child.material];
        child.material = materials.map((material) => {
            if (!material) return material;

            const hasAlphaMap = !!material.alphaMap;
            const isActuallyTransparent = (material.transparent || false) && ((material.opacity ?? 1.0) < 1.0 || hasAlphaMap);

            if (material.isMeshStandardMaterial || material.isMeshPhysicalMaterial) {
                material.side = THREE.FrontSide;
                material.envMapIntensity = Math.min(material.envMapIntensity ?? 0.6, 0.75);
                material.metalness = Math.min(material.metalness ?? 0.0, 0.25);
                material.roughness = Math.max(material.roughness ?? 0.5, 0.35);
                material.transparent = isActuallyTransparent;
                material.alphaTest = hasAlphaMap ? Math.max(material.alphaTest || 0, 0.5) : (material.alphaTest || 0);
                material.depthWrite = !isActuallyTransparent || hasAlphaMap;
                material.needsUpdate = true;
                return material;
            }

            const shininess = material.shininess ?? 30;
            const computedRoughness = Math.max(0.04, 1.0 - Math.sqrt(Math.min(shininess, 1000) / 1000));
            const specularIntensity = material.specular ? (material.specular.r + material.specular.g + material.specular.b) / 3 : 0;
            const computedMetalness = Math.min(0.5, specularIntensity * 0.5);

            const standardMaterial = new THREE.MeshStandardMaterial({
                name: material.name,
                color: material.color ? material.color.clone() : new THREE.Color(0x888888),
                map: material.map || null,
                normalMap: material.normalMap || material.bumpMap || null,
                emissive: material.emissive ? material.emissive.clone() : new THREE.Color(0x000000),
                emissiveMap: material.emissiveMap || null,
                emissiveIntensity: material.emissiveIntensity || 1.0,
                alphaMap: material.alphaMap || null,
                aoMap: material.aoMap || material.lightMap || null,
                aoMapIntensity: 1.0,
                roughness: material.specularMap ? 0.5 : computedRoughness,
                roughnessMap: null,
                metalness: computedMetalness,
                metalnessMap: null,
                transparent: isActuallyTransparent,
                opacity: material.opacity !== undefined ? material.opacity : 1.0,
                alphaTest: hasAlphaMap ? 0.5 : (material.alphaTest || 0),
                depthWrite: !isActuallyTransparent || hasAlphaMap,
                vertexColors: !!child.geometry.attributes.color,
                side: THREE.FrontSide,
                envMapIntensity: 0.6,
            });

            if (material.bumpMap && !material.normalMap) {
                standardMaterial.bumpMap = null;
                standardMaterial.bumpScale = 1.0;
            }

            if (standardMaterial.map) {
                standardMaterial.map.colorSpace = THREE.SRGBColorSpace;
                standardMaterial.map.needsUpdate = true;
            }

            if (standardMaterial.emissiveMap) {
                standardMaterial.emissiveMap.colorSpace = THREE.SRGBColorSpace;
                standardMaterial.emissiveMap.needsUpdate = true;
            }

            ['normalMap', 'alphaMap', 'roughnessMap', 'aoMap'].forEach((mapName) => {
                if (standardMaterial[mapName]) {
                    standardMaterial[mapName].colorSpace = THREE.NoColorSpace || '';
                    standardMaterial[mapName].needsUpdate = true;
                }
            });

            if (standardMaterial.color.getHex() === 0x000000 && !standardMaterial.map && !child.geometry.attributes.color) {
                standardMaterial.color.setHex(0x888888);
            }

            return standardMaterial;
        });

        if (child.material.length === 1) {
            child.material = child.material[0];
        }
    });
}

function loadObjectFromFile(file, fileMap = {}) {
    const extension = file.name.split('.').pop().toLowerCase();
    const url = URL.createObjectURL(file);
    const manager = createLoadingManager(fileMap);

    return new Promise((resolve, reject) => {
        const cleanup = () => URL.revokeObjectURL(url);
        const finishLoad = (object) => {
            cleanup();
            const root = object.scene || object;
            convertLoadedObjectMaterials(root);
            resolve(root);
        };

        const failLoad = (error) => {
            cleanup();
            reject(error);
        };

        try {
            if (extension === 'glb' || extension === 'gltf') {
                const loader = new GLTFLoader(manager);
                loader.load(url, finishLoad, undefined, failLoad);
            } else if (extension === 'obj') {
                const loader = new OBJLoader(manager);
                loader.load(url, finishLoad, undefined, failLoad);
            } else if (extension === 'fbx') {
                const loader = new FBXLoader(manager);
                loader.load(url, finishLoad, undefined, failLoad);
            } else {
                cleanup();
                reject(new Error('Unsupported file format'));
            }
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
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

function registerImportedPropTemplateFromSerializedData(templateData) {
    if (!templateData?.rootJson) return null;

    const existingTemplate = importedPropState.templates.find((entry) => entry.id === templateData.id);
    if (existingTemplate) {
        return existingTemplate;
    }

    const objectLoader = new THREE.ObjectLoader();
    const root = objectLoader.parse(templateData.rootJson);
    convertLoadedObjectMaterials(root);
    // Serialized imported templates already include the normalized root transform
    // that was authored at import time. Re-normalizing on scene load mutates the
    // source asset before any actor transform is restored.
    if (templateData.normalized === false) {
        normalizeObjectToDimension(root, PROP_TARGET_MAX_DIMENSION, false);
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

    const matchedId = /imported-prop-(\d+)$/.exec(template.id || '');
    if (matchedId) {
        importedPropState.nextId = Math.max(importedPropState.nextId, Number(matchedId[1]) + 1);
    }

    renderImportedPropButtons();
    updatePropImportStatus();
    return template;
}

function serializeImportedPropTemplate(template) {
    if (!template?.root) return null;

    return {
        id: template.id,
        fileName: template.fileName,
        displayName: template.displayName,
        normalized: true,
        collisionMode: template.collisionMode,
        triangleCount: template.triangleCount,
        rootJson: template.root.toJSON(),
    };
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
        } else {
            physics.staticBodies.push(actor);
        }
    }
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
        registerImportedPropTemplate(file.name, root, collision.mode, collision.shape, triangleCount);
        updatePropImportStatus();
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

function createStaticMeshBody(root) {
    return physicsCore?.createStaticMeshBody(root) ?? null;
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
    const cameraLerp = 1 - Math.exp(-delta * 8);

    camera.position.lerp(chasePosition, cameraLerp);
    camera.lookAt(lookTarget);

    tempVectorE.copy(lookTarget).sub(camera.position);
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

    for (const prop of physics.dynamicBodies) {
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

function createVehicleWheelAssembly({ tireMaterial, rimMaterial, wheelRadius, wheelWidth, wheelTemplate = null, mirrorX = false }) {
    const steeringPivot = new THREE.Group();
    const spinGroup = new THREE.Group();

    if (wheelTemplate?.root) {
        const customWheel = cloneDisposableObject(wheelTemplate.root);
        const bbox = new THREE.Box3().setFromObject(customWheel);
        const size = bbox.getSize(new THREE.Vector3());
        const center = bbox.getCenter(new THREE.Vector3());

        // Detect axle as the smallest extent; the other two axes form the
        // round face whose larger extent is the diameter.
        const axes = [
            { axis: 'x', size: size.x },
            { axis: 'y', size: size.y },
            { axis: 'z', size: size.z },
        ].sort((a, b) => a.size - b.size);
        const axleAxis = axes[0].axis;
        const diameter = Math.max(axes[1].size, axes[2].size);
        const targetDiameter = wheelRadius * 2.0;
        const fit = diameter > 1e-4 ? targetDiameter / diameter : 1;

        // Centre the wheel on its bbox, then orient so axle aligns with X
        // (which is what spinGroup.rotation.x rotates around).
        const orienter = new THREE.Group();
        customWheel.position.set(-center.x, -center.y, -center.z);
        orienter.add(customWheel);
        if (axleAxis === 'y') {
            orienter.rotation.z = Math.PI * 0.5;
        } else if (axleAxis === 'z') {
            orienter.rotation.y = Math.PI * 0.5;
        }
        orienter.scale.setScalar(fit);
        if (mirrorX) {
            orienter.scale.x *= -1;
        }
        customWheel.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow = true;
            child.receiveShadow = true;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((mat) => {
                if (!mat) return;
                mat.side = THREE.DoubleSide;
                mat.needsUpdate = true;
            });
        });
        spinGroup.add(orienter);
        steeringPivot.add(spinGroup);
        return { steeringPivot, spinGroup };
    }

    const wheelMesh = new THREE.Group();
    wheelMesh.rotation.z = Math.PI * 0.5;

    const tire = new THREE.Mesh(
        new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 24, 1),
        tireMaterial
    );
    tire.castShadow = true;
    tire.receiveShadow = true;
    wheelMesh.add(tire);

    const innerRim = new THREE.Mesh(
        new THREE.CylinderGeometry(wheelRadius * 0.65, wheelRadius * 0.65, wheelWidth * 1.05, 18, 1),
        new THREE.MeshStandardMaterial({
            color: 0x111111,
            roughness: 0.9,
            metalness: 0.1
        })
    );
    wheelMesh.add(innerRim);

    const spokeSize = wheelRadius * 1.35;
    const spoke1 = new THREE.Mesh(
        new THREE.BoxGeometry(spokeSize, wheelWidth * 1.1, wheelRadius * 0.25),
        rimMaterial
    );
    spoke1.castShadow = true;
    wheelMesh.add(spoke1);

    const spoke2 = new THREE.Mesh(
        new THREE.BoxGeometry(wheelRadius * 0.25, wheelWidth * 1.1, spokeSize),
        rimMaterial
    );
    spoke2.castShadow = true;
    wheelMesh.add(spoke2);

    const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(wheelRadius * 0.2, wheelRadius * 0.2, wheelWidth * 1.15, 14, 1),
        rimMaterial
    );
    wheelMesh.add(hub);

    spinGroup.add(wheelMesh);
    steeringPivot.add(spinGroup);

    return { steeringPivot, spinGroup };
}

function createDrivableCarVisual(bodyTemplateId = '', wheelTemplateId = '') {
    const root = new THREE.Group();
    const W = VEHICLE_SETTINGS.width;
    const L = VEHICLE_SETTINGS.length;
    const H = VEHICLE_SETTINGS.height;

    const visualGroup = new THREE.Group();
    visualGroup.position.y = H * 0.28;
    visualGroup.rotation.y = Math.PI;
    root.add(visualGroup);

    const tireMaterial = new THREE.MeshStandardMaterial({
        color: 0x17191d, metalness: 0.02, roughness: 0.92,
    });
    const rimMaterial = new THREE.MeshStandardMaterial({
        color: 0xc5ccd6, metalness: 0.86, roughness: 0.24,
    });

    const bodyTemplate = bodyTemplateId
        ? importedPropState.templates.find((entry) => entry.id === bodyTemplateId)
        : null;
    const wheelTemplate = wheelTemplateId
        ? importedPropState.templates.find((entry) => entry.id === wheelTemplateId)
        : null;

    const usingCustomBody = !!bodyTemplate?.root;

    if (usingCustomBody) {
        const customBody = cloneDisposableObject(bodyTemplate.root);
        const bbox = new THREE.Box3().setFromObject(customBody);
        const size = bbox.getSize(new THREE.Vector3());
        const center = bbox.getCenter(new THREE.Vector3());
        const targetW = W * 1.0;
        const targetL = L * 1.0;
        const sx = size.x > 1e-4 ? targetW / size.x : 1;
        const sz = size.z > 1e-4 ? targetL / size.z : 1;
        const fit = Math.min(sx, sz);
        customBody.scale.setScalar(fit);
        // Park bottom of model on chassis ground plane (chassis local y = -H/2,
        // visualGroup local y = -H/2 - 0.28*H).
        const groundLocal = -H * 0.5 - H * 0.28;
        customBody.position.set(
            -center.x * fit,
            groundLocal - bbox.min.y * fit,
            -center.z * fit - L * -0.04
        );
        customBody.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow = true;
            child.receiveShadow = true;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((mat) => {
                if (!mat) return;
                mat.side = THREE.DoubleSide;
                mat.needsUpdate = true;
            });
        });
        visualGroup.add(customBody);
    } else {
        const bodyMaterial = new THREE.MeshStandardMaterial({
            color: 0xf7f7f5, metalness: 0.18, roughness: 0.34,
        });
        const trimMaterial = new THREE.MeshStandardMaterial({
            color: 0x15171b, metalness: 0.42, roughness: 0.48,
        });
        const glassMaterial = new THREE.MeshStandardMaterial({
            color: 0xdce8f5, metalness: 0.08, roughness: 0.16, transparent: true, opacity: 0.72,
        });
        const lightMaterial = new THREE.MeshStandardMaterial({
            color: 0xf8f1d0, emissive: 0x8c6d1f, emissiveIntensity: 0.2, roughness: 0.28, metalness: 0.02,
        });

        const lowerBody = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.96, H * 0.38, L * 0.94),
            bodyMaterial
        );
        lowerBody.position.y = -H * 0.08;
        lowerBody.castShadow = true;
        lowerBody.receiveShadow = true;
        visualGroup.add(lowerBody);

        const cabin = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.72, H * 0.32, L * 0.38),
            glassMaterial
        );
        cabin.position.set(0, H * 0.22, -L * 0.06);
        cabin.castShadow = true;
        visualGroup.add(cabin);

        const roof = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.68, H * 0.06, L * 0.32),
            bodyMaterial
        );
        roof.position.set(0, H * 0.39, -L * 0.06);
        roof.castShadow = true;
        visualGroup.add(roof);

        const hood = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.88, H * 0.1, L * 0.28),
            bodyMaterial
        );
        hood.position.set(0, H * 0.06, L * 0.30);
        hood.rotation.x = -0.06;
        hood.castShadow = true;
        hood.receiveShadow = true;
        visualGroup.add(hood);

        const trunk = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.84, H * 0.1, L * 0.18),
            bodyMaterial
        );
        trunk.position.set(0, H * 0.06, -L * 0.36);
        trunk.rotation.x = 0.04;
        trunk.castShadow = true;
        visualGroup.add(trunk);

        const frontBumper = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.92, H * 0.12, L * 0.06),
            trimMaterial
        );
        frontBumper.position.set(0, -H * 0.16, L * 0.48);
        frontBumper.castShadow = true;
        visualGroup.add(frontBumper);

        const rearBumper = frontBumper.clone();
        rearBumper.position.z = -L * 0.48;
        visualGroup.add(rearBumper);

        const skirtLeft = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.04, H * 0.1, L * 0.7),
            trimMaterial
        );
        skirtLeft.position.set(-W * 0.48, -H * 0.2, 0);
        visualGroup.add(skirtLeft);
        const skirtRight = skirtLeft.clone();
        skirtRight.position.x *= -1;
        visualGroup.add(skirtRight);

        const grille = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.5, H * 0.1, L * 0.03),
            trimMaterial
        );
        grille.position.set(0, -H * 0.02, L * 0.49);
        visualGroup.add(grille);

        const headlightLeft = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.14, H * 0.06, L * 0.02),
            lightMaterial
        );
        headlightLeft.position.set(-W * 0.32, H * 0.02, L * 0.49);
        const headlightRight = headlightLeft.clone();
        headlightRight.position.x *= -1;
        visualGroup.add(headlightLeft, headlightRight);

        const taillightMat = new THREE.MeshStandardMaterial({
            color: 0xff2222, emissive: 0x991111, emissiveIntensity: 0.3, roughness: 0.3, metalness: 0.02,
        });
        const taillightLeft = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.12, H * 0.05, L * 0.02),
            taillightMat
        );
        taillightLeft.position.set(-W * 0.34, H * 0.02, -L * 0.49);
        const taillightRight = taillightLeft.clone();
        taillightRight.position.x *= -1;
        visualGroup.add(taillightLeft, taillightRight);
    }

    const wheelRadius = usingCustomBody ? H * 0.62 : H * 0.36;
    const wheelWidth = W * 0.16;
    // For custom body, raise wheel-axle so fully sized wheels straddle the
    // chassis ground plane (-H/2 in chassis local, -0.78H in visualGroup local).
    const wheelY = usingCustomBody ? (-H * 0.78 + wheelRadius + H * 0.55) : -H * 0.42;
    const halfWheelBase = VEHICLE_SETTINGS.wheelBase * (usingCustomBody ? 0.86 : 0.5);
    const halfTrackWidth = VEHICLE_SETTINGS.trackWidth * (usingCustomBody ? 0.72 : 0.45);
    const wheelOffsets = [
        { x: -halfTrackWidth, z: halfWheelBase, steerable: true },
        { x: halfTrackWidth, z: halfWheelBase, steerable: true },
        { x: -halfTrackWidth, z: -halfWheelBase, steerable: false },
        { x: halfTrackWidth, z: -halfWheelBase, steerable: false },
    ];
    const steeringPivots = [];
    const spinGroups = [];

    const usingCustomWheels = !!wheelTemplate?.root;
    wheelOffsets.forEach((offset) => {
        const wheel = createVehicleWheelAssembly({
            tireMaterial,
            rimMaterial,
            wheelRadius,
            wheelWidth,
            wheelTemplate,
            mirrorX: offset.x < 0,
        });
        wheel.steeringPivot.position.set(offset.x, wheelY, offset.z);
        wheel.steeringPivot.userData.steerable = offset.steerable;
        if (usingCustomBody && !usingCustomWheels) {
            wheel.steeringPivot.visible = false;
        }
        visualGroup.add(wheel.steeringPivot);
        steeringPivots.push(wheel.steeringPivot);
        spinGroups.push(wheel.spinGroup);
    });

    visualGroup.traverse((object) => {
        if (!object.isMesh) return;
        object.castShadow = true;
        object.receiveShadow = true;
    });

    root.userData.vehicleVisual = {
        steeringPivots,
        spinGroups,
        wheelRadius,
        maxSteerAngle: 1.0,
        steerAngle: 0,
        spinAngle: 0,
    };

    return root;
}

function updateVehicleVisuals(delta) {
    if (!physics.ready || !physics.dynamicBodies.length) return;

    const { bodyInterface } = physics;
    for (const prop of physics.dynamicBodies) {
        if (prop?.kind !== 'vehicle' || !getActorRenderObject(prop)) continue;

        const visualState = getActorRenderObject(prop).userData?.vehicleVisual;
        const body = getActorBody(prop);
        if (!visualState || !body) continue;

        const bodyId = body.GetID();
        const flatForward = tempVectorA.set(0, 0, -1).applyQuaternion(getActorRenderObject(prop).quaternion);
        flatForward.y = 0;
        if (flatForward.lengthSq() < 1e-6) {
            flatForward.set(0, 0, -1);
        } else {
            flatForward.normalize();
        }

        const linearVelocity = copyJoltVector(tempVectorB, bodyInterface.GetLinearVelocity(bodyId));
        const forwardSpeed = linearVelocity.dot(flatForward);

        visualState.spinAngle -= (forwardSpeed / visualState.wheelRadius) * delta;
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
        spawnPosition.y = Math.max(
            spawnPosition.y,
            groundHit.point.y + VEHICLE_SETTINGS.height * 0.6 + VEHICLE_SETTINGS.spawnLift
        );
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
    const chassis = createDrivableCarVisual(bodyTemplateId, wheelTemplateId);
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
    tempVectorA.copy(target).sub(camera.position);
    const flatDistance = Math.max(0.001, Math.hypot(tempVectorA.x, tempVectorA.z));
    showcase.yaw = Math.atan2(tempVectorA.x, tempVectorA.z);
    showcase.pitch = THREE.MathUtils.clamp(
        Math.atan2(-tempVectorA.y, flatDistance),
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
        refreshSceneUI();
    }
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
    
    if (bodyID) {
        bodyInterface.RemoveBody(bodyID);
        bodyInterface.DestroyBody(bodyID);
    }

    if (!componentFlags.collision) {
        prop.body = null;
        return;
    }
    
    const importedTemplate = prop.kind === 'imported'
        ? importedPropState.templates.find((entry) => entry.id === prop.templateId)
        : null;
    const useExactMeshCollision = importedTemplate?.collisionMode === 'complex';

    let bodyOptions = {
        rotation: getActorRenderObject(prop).quaternion,
        friction: prop.userData?.friction || 0.5,
        restitution: prop.userData?.restitution || 0.3,
        allowedDOFs: prop.userData?.allowedDOFs,
        kinematic: prop.userData?.kinematic,
        simulatePhysics: useExactMeshCollision ? false : componentFlags.physics,
        activate: true
    };
    
    const rootMesh = getActorRenderObject(prop);
    rootMesh.updateMatrixWorld(true);

    if (useExactMeshCollision) {
        const newBody = createStaticMeshBody(rootMesh);
        prop.body = newBody;
        setActorComponentFlags(prop, {
            ...componentFlags,
            collision: !!newBody,
            physics: false,
        });
        return;
    }

    const subShapes = [];
    const compoundSettings = new Jolt.MutableCompoundShapeSettings();
    let hasCompound = false;

    // A helper to traverse and collect collision shapes
    function traverseAndBuildShapes(node, isRoot) {
        if (!node.visible) return; // Skip hidden components
        
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
            } else if (geo?.type === 'CapsuleGeometry') {
                shapeSetting = new Jolt.CapsuleShapeSettings(scale.y, scale.x);
            } else if (isRoot && prop.kind === 'sphere') {
                shapeSetting = new Jolt.SphereShapeSettings(scale.x);
            } else if (isRoot && prop.kind === 'cube') {
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
                const pos = new Jolt.Vec3(node.position.x, node.position.y, node.position.z);
                const rot = new Jolt.Quat(node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w);
                
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
        setActorComponentFlags(prop, {
            ...componentFlags,
            collision: !!newBody,
            physics: !!newBody && componentFlags.physics,
        });
    }
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
        select.value = selectedId && importedPropState.templates.some((template) => template.id === selectedId)
            ? selectedId
            : '';
    };
    populateVehicleSelect(actorVehicleBodyTemplateSelect, selectedVehicleBodyTemplateId, 'Default Sedan');
    populateVehicleSelect(actorVehicleWheelTemplateSelect, selectedVehicleWheelTemplateId, 'Default Wheel');
}

function syncActorEditorUi() {
    if (!actorKindSelect || !actorEditorSummary || !actorEditorStatus || !actorImportedTemplateSelect || !actorComponentCollisionInput || !actorComponentPhysicsInput || !actorComponentScriptsInput) {
        return;
    }

    const kind = actorKindSelect.value || 'sphere';
    const isImported = kind === 'imported';
    const isVehicle = kind === 'vehicle';

    actorImportedTemplateSelect.disabled = !isImported;
    if (actorVehicleBodyTemplateSelect) {
        actorVehicleBodyTemplateSelect.disabled = !isVehicle;
    }
    if (actorVehicleWheelTemplateSelect) {
        actorVehicleWheelTemplateSelect.disabled = !isVehicle;
    }
    actorComponentCollisionInput.disabled = isVehicle;
    actorComponentPhysicsInput.disabled = isVehicle || !actorComponentCollisionInput.checked;
    if (isVehicle) {
        actorComponentCollisionInput.checked = true;
        actorComponentPhysicsInput.checked = true;
    } else if (!actorComponentCollisionInput.checked) {
        actorComponentPhysicsInput.checked = false;
    }

    const typeLabel = kind === 'vehicle'
        ? 'Vehicle Actor'
        : kind === 'imported'
            ? 'Imported Actor'
            : kind === 'sphere'
                ? 'Sphere Actor'
                : 'Cube Actor';

    actorEditorSummary.textContent = `Type: ${typeLabel}`;

    if (isImported && !importedPropState.templates.length) {
        actorEditorStatus.textContent = 'Import a prop source first, then create an imported actor instance from it.';
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
        actorScaleInput.value = kind === 'cube' ? '2.0' : '0.5';
    }
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

function setActorColor(actor, hexColor) {
    const mesh = getActorRenderObject(actor);
    if (!mesh) return;
    const color = new THREE.Color(hexColor);
    mesh.traverse((child) => {
        if (child.isMesh && child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of mats) {
                if (mat.color) mat.color.copy(color);
            }
        }
    });
}

function serializeObjectMaterialState(object3D) {
    if (!object3D?.isMesh || !object3D.material) return null;

    const materials = Array.isArray(object3D.material) ? object3D.material : [object3D.material];
    const firstColorableMaterial = materials.find((material) => material?.color);
    if (!firstColorableMaterial) return null;

    return {
        color: `#${firstColorableMaterial.color.getHexString()}`,
        roughness: firstColorableMaterial.roughness ?? 0.5,
        metalness: firstColorableMaterial.metalness ?? 0.0,
    };
}

function applyObjectMaterialState(object3D, materialState) {
    if (!object3D?.isMesh || !object3D.material || !materialState) return;

    const color = materialState.color ? new THREE.Color(materialState.color) : null;
    const materials = Array.isArray(object3D.material) ? object3D.material : [object3D.material];

    for (const material of materials) {
        if (!material) continue;
        if (color && material.color) {
            material.color.copy(color);
        }
        if ('roughness' in material && materialState.roughness !== undefined) {
            material.roughness = materialState.roughness;
        }
        if ('metalness' in material && materialState.metalness !== undefined) {
            material.metalness = materialState.metalness;
        }
        material.needsUpdate = true;
    }
}

function serializeObjectMaterialOverrides(rootObject) {
    if (!rootObject) return [];

    const overrides = [];

    function visit(node, path) {
        const materialState = serializeObjectMaterialState(node);
        if (materialState) {
            overrides.push({
                path,
                material: materialState,
            });
        }

        node.children.forEach((child, index) => {
            visit(child, [...path, index]);
        });
    }

    visit(rootObject, []);
    return overrides;
}

function getObjectByHierarchyPath(rootObject, path = []) {
    let current = rootObject;

    for (const childIndex of path) {
        if (!current?.children?.[childIndex]) {
            return null;
        }
        current = current.children[childIndex];
    }

    return current;
}

function applyObjectMaterialOverrides(rootObject, overrides = []) {
    if (!rootObject || !Array.isArray(overrides)) return;

    overrides.forEach((entry) => {
        const target = getObjectByHierarchyPath(rootObject, entry.path);
        if (!target) return;
        applyObjectMaterialState(target, entry.material);
    });
}

function spawnActorFromEditor({ openScriptEditor = false } = {}) {
    const kind = actorKindSelect?.value || 'sphere';
    const includeCollisionBody = kind === 'vehicle' ? true : !!actorComponentCollisionInput?.checked;
    const simulatePhysics = kind === 'vehicle' ? true : !!actorComponentPhysicsInput?.checked;
    const includeScripts = !!actorComponentScriptsInput?.checked;
    const parsedScale = Number.parseFloat(actorScaleInput?.value ?? '0.5');
    const scale = Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : (kind === 'cube' ? 0.3 : 0.5);
    const displayName = actorLabelInput?.value?.trim() || '';
    const userData = displayName ? { label: displayName } : undefined;
    let actor = null;

    if (kind === 'vehicle') {
        const bodyTemplateId = actorVehicleBodyTemplateSelect?.value || '';
        const wheelTemplateId = actorVehicleWheelTemplateSelect?.value || '';
        actor = spawnDrivableCar({ includeScripts, userData, bodyTemplateId, wheelTemplateId });
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
    if (actorColorInput) {
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

function compileObjectEventScript(source) {
    const normalizedSource = typeof source === 'string' ? source.trim() : '';

    if (!normalizedSource) {
        const empty = new ObjectEventFunction('api', '"use strict"; return;');
        empty.__ueLifecycle = false;
        return empty;
    }

    // UE lifecycle mode: source defines BeginPlay / Tick / OnHit / EndPlay.
    // Compile a wrapper that runs the source once to register them and returns
    // a handles map. Old flat-body scripts fall through to the legacy path so
    // existing .umap saves continue to work unchanged.
    if (detectsUeLifecycle(normalizedSource)) {
        const wrapped = new ObjectEventFunction('api', `
            "use strict";
            const { THREE, scene, camera, renderer, currentMesh, gameplay, showcase, physics, prop, actor, object, body, physicsBody, localPosition, worldPosition, eventType, deltaTime, collision, renderComponent, physicsComponent, scriptComponent, metadataComponent, PhysicsComponent, TransformComponent, spawnDynamicPrimitive, spawnImportedProp,
                FVector, FRotator, FTransform, FHitResult, ECollisionChannel, AActor, AHUD, UAudioComponent, UUserWidget, UTextWidget, UImageWidget, UProgressBarWidget, UButtonWidget, UPrimitiveComponent, UTransformComponent, UGameInstance, UWorld, AGameModeBase, AGameMode, APlayerController, APawn, ACharacter, Self, HUD, WidgetAPI, UnrealWidgetAPI, World, GameInstance, GameMode, PlayerController, Pawn, Character, CreateWidget, GetHUD, GetWorld, GetGameInstance, GetGameMode, GetPlayerController, GetPlayerPawn, GetPlayerCharacter, DeltaTime, Hit } = api;
            ${normalizedSource}
            return {
                BeginPlay: typeof BeginPlay === 'function' ? BeginPlay : undefined,
                Tick: typeof Tick === 'function' ? Tick : undefined,
                OnHit: typeof OnHit === 'function' ? OnHit : undefined,
                EndPlay: typeof EndPlay === 'function' ? EndPlay : undefined,
            };
        `);
        wrapped.__ueLifecycle = true;
        return wrapped;
    }

    const flat = new ObjectEventFunction('api', `
        "use strict";
        const { THREE, scene, camera, renderer, currentMesh, gameplay, showcase, physics, prop, actor, object, body, physicsBody, localPosition, worldPosition, eventType, deltaTime, collision, renderComponent, physicsComponent, scriptComponent, metadataComponent, PhysicsComponent, TransformComponent, spawnDynamicPrimitive, spawnImportedProp,
            FVector, FRotator, FTransform, FHitResult, ECollisionChannel, AActor, AHUD, UAudioComponent, UUserWidget, UTextWidget, UImageWidget, UProgressBarWidget, UButtonWidget, UPrimitiveComponent, UTransformComponent, UGameInstance, UWorld, AGameModeBase, AGameMode, APlayerController, APawn, ACharacter, Self, HUD, WidgetAPI, UnrealWidgetAPI, World, GameInstance, GameMode, PlayerController, Pawn, Character, CreateWidget, GetHUD, GetWorld, GetGameInstance, GetGameMode, GetPlayerController, GetPlayerPawn, GetPlayerCharacter, DeltaTime, Hit } = api;
        ${normalizedSource}
    `);
    flat.__ueLifecycle = false;
    return flat;
}

function syncPropScriptState(prop) {
    if (!prop) return prop;

    ensureActorIdentity(prop);
    const propId = prop.id;
    const drafts = ensureObjectScriptDraftEntry(propId);
    const scriptState = createObjectScriptState(propId);

    scriptState.tick.source = drafts.tick;
    scriptState.collision.source = drafts.collision;

    try {
        scriptState.tick.compiled = compileObjectEventScript(scriptState.tick.source);
        scriptState.tick.enabled = !!scriptState.tick.source.trim() && drafts.tickEnabled === true;
    } catch (error) {
        scriptState.tick.error = error?.message || String(error);
        scriptState.tick.compiled = null;
        scriptState.tick.enabled = false;
    }

    try {
        scriptState.collision.compiled = compileObjectEventScript(scriptState.collision.source);
        scriptState.collision.enabled = !!scriptState.collision.source.trim();
    } catch (error) {
        scriptState.collision.error = error?.message || String(error);
        scriptState.collision.compiled = null;
        scriptState.collision.enabled = false;
    }

    prop.scripts = scriptState;
    ensureActorScriptComponent(prop, scriptState);

    const mesh = getActorRenderObject(prop);
    if (mesh?.userData) {
        mesh.userData.dynamicPropId = propId;
    }

    return prop;
}

function createDynamicPropActor({
    body,
    mesh,
    kind,
    templateId = '',
    userData = null,
    includeScripts = true,
}) {
    const actor = createActor({
        body,
        mesh,
        kind,
        templateId,
        userData,
        name: userData?.label || `${kind || 'actor'}-actor`,
    });
    // Auto-attach UE-style components so GetComponent() works on every actor.
    if (!actor.hasComponent(TransformComponent)) {
        actor.addComponent(new TransformComponent());
    }
    if (!actor.hasComponent(PhysicsComponent)) {
        const phys = new PhysicsComponent();
        phys.setPhysicsContext(physics);
        if (body) phys.setBody(body);
        actor.addComponent(phys);
    }
    if (!actor.hasComponent(AudioComponent)) {
        const audio = new AudioComponent();
        audio.setAudioRuntime(runtimeAudio);
        actor.addComponent(audio);
    }

    sceneSystem?.addActor(actor);
    ensureActorIdentity(actor);
    return includeScripts ? syncPropScriptState(actor) : actor;
}

function removeObjectScriptDraft(propId) {
    if (!propId || !objectScriptState.drafts[propId]) return;

    delete objectScriptState.drafts[propId];
    saveObjectScriptDrafts();
}

function findDynamicPropByMesh(target) {
    if (!target) return null;

    if (sceneSystem) {
        for (const actor of sceneSystem.actors) {
            const mesh = getActorRenderObject(actor);
            let current = target;
            while (current) {
                if (current === mesh) return actor;
                current = current.parent;
            }
        }
    }

    return physics.dynamicBodies.find((prop) => {
        const mesh = getActorRenderObject(prop);
        let current = target;

        while (current) {
            if (current === mesh) {
                return true;
            }

            current = current.parent;
        }

        return false;
    }) || null;
}

function getObjectScriptEventLabel(eventType) {
    return eventType === 'collision' ? 'Collision' : 'Tick';
}

function getDynamicPropDisplayName(prop) {
    if (!prop) return 'No prop selected';

    const metadata = getActorMetadata(prop);
    if (metadata?.userData?.label) {
        return metadata.userData.label;
    }

    if (prop.kind === 'imported') {
        const template = importedPropState.templates.find((entry) => entry.id === prop.templateId);
        return template?.displayName || 'Imported Prop';
    }

    if (prop.kind === 'vehicle') {
        return prop.userData?.label || 'Vehicle Prop';
    }

    return prop.kind === 'sphere' ? 'Sphere Prop' : 'Cube Prop';
}

function getDynamicPropById(propId) {
    if (sceneSystem) {
        for (const actor of sceneSystem.actors) {
            if (actor.id === propId) return actor;
        }
    }
    return physics.dynamicBodies.find((prop) => prop.id === propId) || null;
}

function isTransformControlSphereHit(event, { mode = null } = {}) {
    if (!transformControl || !transformControl.enabled || !transformControl.object || !renderer || !camera) {
        return false;
    }

    if (mode && transformControl.getMode?.() !== mode) {
        return false;
    }

    const helper = transformControl.getHelper?.() ?? null;
    if (helper && helper.visible === false) {
        return false;
    }

    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return false;
    }

    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);

    const gizmoCenter = tempVectorA;
    transformControl.object.getWorldPosition(gizmoCenter);

    const activeMode = transformControl.getMode?.() ?? 'translate';
    const cameraDistance = camera.position.distanceTo(gizmoCenter);
    const modeScale = activeMode === 'scale'
        ? 1.15
        : activeMode === 'rotate'
            ? 1.35
            : 1.5;
    const sphereRadius = Math.max(0.8, cameraDistance * 0.085 * (transformControl.size || 1) * modeScale);
    const distanceToRay = Math.sqrt(raycaster.ray.distanceSqToPoint(gizmoCenter));

    return distanceToRay <= sphereRadius;
}

function getDynamicPropHitFromEvent(event) {
    const hasActors = (sceneSystem && sceneSystem.actors.size > 0) || physics.dynamicBodies.length > 0;
    if (!renderer || !camera || !hasActors) return null;

    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);

    const targets = [];
    if (sceneSystem) {
        for (const actor of sceneSystem.actors) {
            const mesh = getActorRenderObject(actor);
            if (mesh) targets.push(mesh);
        }
    }
    physics.dynamicBodies.forEach((prop) => {
        const mesh = getActorRenderObject(prop);
        if (mesh && !targets.includes(mesh)) targets.push(mesh);
    });

    if (targets.length === 0) return null;

    const hits = raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
        const prop = findDynamicPropByMesh(hit.object);
        if (prop) {
            return { prop, hit };
        }
    }

    return null;
}

function updateObjectScriptEditorStatus(extraMessage = '') {
    if (!objectScriptEditorStatus) return;

    const prop = getDynamicPropById(objectScriptState.targetPropId);
    const eventType = objectScriptState.targetEvent;
    const eventState = getActorScriptState(prop)?.[eventType];
    let baseMessage;

    if (eventState?.error) {
        baseMessage = `${getObjectScriptEventLabel(eventType)} code error: ${eventState.error}`;
    } else if (eventType === 'tick' && eventState?.source?.trim() && !eventState.enabled) {
        baseMessage = 'Tick code is saved but disabled. Turn on the tick toggle to run it in Play mode.';
    } else {
        baseMessage = `${getObjectScriptEventLabel(eventType)} code is ${eventState?.enabled ? 'ready' : 'empty'}.`;
    }

    objectScriptEditorStatus.textContent = extraMessage ? `${baseMessage} ${extraMessage}` : baseMessage;
}

function syncObjectScriptEditor() {
    const prop = getDynamicPropById(objectScriptState.targetPropId);
    const eventType = objectScriptState.targetEvent;
    const eventState = getActorScriptState(prop)?.[eventType];

    if (objectScriptEditorTitle) {
        objectScriptEditorTitle.textContent = `Attach ${getObjectScriptEventLabel(eventType)} Script`;
    }

    if (objectScriptEditorTarget) {
        objectScriptEditorTarget.textContent = `Target: ${getDynamicPropDisplayName(prop)}`;
    }

    if (objectScriptEditorMode) {
        objectScriptEditorMode.value = eventType === 'collision' ? 'collision' : 'tick';
    }

    if (objectScriptTickToggleRow) {
        objectScriptTickToggleRow.hidden = eventType !== 'tick';
    }

    if (objectScriptTickToggleInput) {
        objectScriptTickToggleInput.checked = eventType === 'tick' ? !!eventState?.enabled : false;
    }

    if (objectScriptEditorInput) {
        objectScriptEditorInput.value = eventState?.source || '';
    }

    updateObjectScriptEditorStatus();
}

function closeObjectScriptMenu() {
    objectScriptState.menuOpen = false;

    if (objectScriptMenu) {
        objectScriptMenu.hidden = true;
    }
}

function closeObjectScriptEditor() {
    objectScriptState.editorOpen = false;

    if (objectScriptEditor) {
        objectScriptEditor.hidden = true;
    }
}

function maybeOpenObjectScriptMenuFromMobileTap(event) {
    if (!mobileState.enabled || gameplay.active || gameplay.pointerLocked || !renderer) {
        return false;
    }

    const now = performance.now();
    const withinTimeWindow = now - mobileState.lastWorldTapTime <= 320;
    const withinDistanceWindow = Math.hypot(
        event.clientX - mobileState.lastWorldTapX,
        event.clientY - mobileState.lastWorldTapY
    ) <= 28;

    mobileState.lastWorldTapTime = now;
    mobileState.lastWorldTapX = event.clientX;
    mobileState.lastWorldTapY = event.clientY;

    if (!withinTimeWindow || !withinDistanceWindow) {
        return false;
    }

    const propHit = getDynamicPropHitFromEvent(event);
    if (!propHit?.prop) {
        return false;
    }

    openObjectScriptMenu(event, propHit.prop);
    return true;
}

function openObjectScriptMenu(event, prop) {
    if (!objectScriptMenu || !container || !prop) return;

    selectShowcaseActor(prop.id);
    objectScriptState.menuOpen = true;
    objectScriptState.menuScreenX = event.clientX;
    objectScriptState.menuScreenY = event.clientY;

    objectScriptMenu.hidden = false;

    const containerRect = container.getBoundingClientRect();
    const menuWidth = objectScriptMenu.offsetWidth || 220;
    const menuHeight = objectScriptMenu.offsetHeight || 120;
    const left = THREE.MathUtils.clamp(
        event.clientX - containerRect.left,
        12,
        Math.max(12, containerRect.width - menuWidth - 12)
    );
    const top = THREE.MathUtils.clamp(
        event.clientY - containerRect.top,
        12,
        Math.max(12, containerRect.height - menuHeight - 12)
    );

    objectScriptMenu.style.left = `${left}px`;
    objectScriptMenu.style.top = `${top}px`;
}

function openObjectScriptEditor(eventType) {
    const prop = getDynamicPropById(objectScriptState.targetPropId);
    if (!prop || !objectScriptEditor) return;

    ensureActorScriptState(prop);

    objectScriptState.targetEvent = eventType;
    objectScriptState.editorOpen = true;
    closeObjectScriptMenu();
    syncObjectScriptEditor();
    objectScriptEditor.hidden = false;

    if (objectScriptEditorInput) {
        objectScriptEditorInput.focus();
        objectScriptEditorInput.setSelectionRange(
            objectScriptEditorInput.value.length,
            objectScriptEditorInput.value.length
        );
    }
}

function updatePropScriptSource(prop, eventType, source, { persist = true, notify = true } = {}) {
    const scriptState = ensureActorScriptState(prop);
    if (!scriptState?.[eventType]) return false;

    const normalizedSource = typeof source === 'string' ? source : '';
    const eventState = scriptState[eventType];
    eventState.source = normalizedSource;
    eventState.error = '';

    try {
        eventState.compiled = compileObjectEventScript(normalizedSource);
        eventState.handles = null;
        eventState.beganPlay = false;
        eventState.enabled = eventType === 'tick'
            ? !!normalizedSource.trim() && !!scriptState.tick.enabled
            : !!normalizedSource.trim();
    } catch (error) {
        eventState.error = error?.message || String(error);
        eventState.compiled = null;
        eventState.handles = null;
        eventState.beganPlay = false;
        eventState.enabled = false;
        if (notify) {
            alert(`error: ${eventState.error}`);
        }
    }

    const drafts = ensureObjectScriptDraftEntry(prop.id);
    drafts[eventType] = normalizedSource;
    if (eventType === 'tick') {
        drafts.tickEnabled = !!scriptState.tick.enabled;
    }

    if (persist) {
        saveObjectScriptDrafts();
    }

    updateObjectScriptEditorStatus(
        eventState.error
            ? `${getObjectScriptEventLabel(eventType)} code failed to compile.`
            : `${getObjectScriptEventLabel(eventType)} code applied.`
    );

    return !eventState.error;
}

function clearPropScriptSource(prop, eventType) {
    return updatePropScriptSource(prop, eventType, '', { persist: true, notify: false });
}

function setPropTickEventEnabled(prop, isEnabled, { persist = true } = {}) {
    const scriptState = ensureActorScriptState(prop);
    if (!scriptState?.tick) return;

    const tickState = scriptState.tick;
    tickState.enabled = !!isEnabled && !!tickState.source.trim() && !tickState.error;

    const drafts = ensureObjectScriptDraftEntry(prop.id);
    drafts.tickEnabled = !!isEnabled;

    if (persist) {
        saveObjectScriptDrafts();
    }

    updateObjectScriptEditorStatus(
        tickState.enabled
            ? 'Tick event enabled for Play mode.'
            : 'Tick event disabled.'
    );
}

function buildObjectEventApi(prop, eventType, { deltaTime = 0, collision = null } = {}) {
    const renderComponent = getRenderComponent(prop);
    const physicsComponent = getPhysicsBodyComponent(prop);
    const scriptComponent = getScriptComponent(prop);
    const metadataComponent = getMetadataComponent(prop);
    const audioComponent = prop?.getComponentByClass?.(AudioComponent) ?? null;
    const object = renderComponent?.mesh || null;
    const body = physicsComponent?.body || null;
    const localPosition = object?.position?.clone?.() ?? null;
    const worldPosition = object ? object.getWorldPosition(new THREE.Vector3()) : null;

    const legacyApi = {
        THREE,
        scene,
        camera,
        renderer,
        currentMesh,
        gameplay,
        showcase,
        physics,
        prop,
        object,
        body,
        physicsBody: body,
        localPosition,
        worldPosition,
        eventType,
        deltaTime,
        collision,
        renderComponent,
        physicsComponent,
        scriptComponent,
        metadataComponent,
        audioComponent,
        audio: runtimeAudio,
        playSoundAtLocation,
        AudioComponent,
        PhysicsComponent,
        TransformComponent,
        TEST_SOUND_ID,
        actor: prop,
        spawnDynamicPrimitive,
        spawnImportedProp,
    };

    return buildUeContext(
        legacyApi,
        {
            scene,
            camera,
            renderer,
            sceneSystem,
            physics,
            gameplay,
            audio: runtimeAudio,
            hud: getRuntimeHud(),
            getHUD: getRuntimeHud,
            widgetApi: window.WidgetAPI,
            unrealWidgetApi: window.UnrealWidgetAPI,
            playSoundAtLocation,
            raycastWorld: typeof raycastWorld === 'function' ? raycastWorld : null,
            spawnDynamicPrimitive,
            spawnImportedProp,
            spawnDrivableCar: typeof spawnDrivableCar === 'function' ? spawnDrivableCar : null,
            destroyActor: typeof destroyDynamicPhysicsProp === 'function' ? destroyDynamicPhysicsProp : null,
            enterGameplay: typeof enterGameplay === 'function' ? enterGameplay : null,
            exitGameplay: typeof exitGameplay === 'function' ? exitGameplay : null,
            respawnPlayer: typeof respawnPlayer === 'function' ? respawnPlayer : null,
            syncCameraToCharacter: typeof syncCameraToCharacter === 'function' ? syncCameraToCharacter : null,
            applyGameplayCameraRotation: typeof applyGameplayCameraRotation === 'function' ? applyGameplayCameraRotation : null,
            deltaTime,
        },
        prop,
        collision,
    );
}

function handleObjectScriptRuntimeError(prop, eventType, error) {
    const eventState = getActorScriptState(prop)?.[eventType];
    if (!eventState) return;

    const errorMessage = error?.message || String(error);
    eventState.error = errorMessage;
    eventState.enabled = false;
    eventState.running = false;
    alert(`error: ${errorMessage}`);

    if (objectScriptState.targetPropId === prop.id && objectScriptState.targetEvent === eventType) {
        updateObjectScriptEditorStatus(`${getObjectScriptEventLabel(eventType)} code failed at runtime.`);
    }
}

function runObjectEventScript(prop, eventType, options = {}) {
    const eventState = getActorScriptState(prop)?.[eventType];
    if (!eventState?.enabled || !eventState.compiled || eventState.running) {
        return false;
    }

    const compiled = eventState.compiled;
    const api = buildObjectEventApi(prop, eventType, options);

    // UE lifecycle path: invoke the compiled wrapper once to harvest handles,
    // then dispatch the appropriate lifecycle method for this event type.
    if (compiled.__ueLifecycle) {
        try {
            if (!eventState.handles) {
                eventState.handles = compiled(api) || {};
            }
            const handles = eventState.handles;

            // BeginPlay fires once when the tick event slot first runs in play mode.
            if (eventType === 'tick' && !eventState.beganPlay) {
                eventState.beganPlay = true;
                if (typeof handles.BeginPlay === 'function') {
                    eventState.running = true;
                    Promise.resolve(handles.BeginPlay.call(api.Self ?? null))
                        .catch((error) => handleObjectScriptRuntimeError(prop, eventType, error))
                        .finally(() => { eventState.running = false; });
                }
            }

            const target = eventType === 'collision' ? handles.OnHit : handles.Tick;
            if (typeof target !== 'function') return false;

            eventState.running = true;
            Promise.resolve(target.call(api.Self ?? null, eventType === 'collision' ? api.Hit : api.DeltaTime))
                .then(() => {
                    eventState.running = false;
                    if (objectScriptState.targetPropId === prop.id && objectScriptState.targetEvent === eventType) {
                        updateObjectScriptEditorStatus(`${getObjectScriptEventLabel(eventType)} code ran.`);
                    }
                })
                .catch((error) => {
                    handleObjectScriptRuntimeError(prop, eventType, error);
                });
            return true;
        } catch (error) {
            handleObjectScriptRuntimeError(prop, eventType, error);
            return false;
        }
    }

    // Legacy flat-body path: execute the whole script every event.
    eventState.running = true;
    Promise.resolve(compiled(api))
        .then(() => {
            eventState.running = false;
            if (objectScriptState.targetPropId === prop.id && objectScriptState.targetEvent === eventType) {
                updateObjectScriptEditorStatus(`${getObjectScriptEventLabel(eventType)} code ran.`);
            }
        })
        .catch((error) => {
            handleObjectScriptRuntimeError(prop, eventType, error);
        });

    return true;
}

function runObjectTickScripts(delta) {
    if (!gameplay.active || !hasEnabledDynamicPropEvent('tick')) {
        return;
    }

    for (let index = 0; index < physics.dynamicBodies.length; index++) {
        const prop = physics.dynamicBodies[index];
        if (!getActorRenderObject(prop)) continue;
        runObjectEventScript(prop, 'tick', { deltaTime: delta });
    }
}

/**
 * Look up the dynamic-body actor whose Jolt body matches the given bodyId.
 * Returns null for terrain/world-static hits.
 */
function getActorByBodyId(bodyId) {
    if (bodyId == null || bodyId < 0) return null;
    const actors = [...physics.dynamicBodies, ...physics.staticBodies];
    for (let i = 0; i < actors.length; i++) {
        const actor = actors[i];
        const body = getActorBody(actor);
        const id = body?.GetID?.();
        if (id?.GetIndexAndSequenceNumber?.() === bodyId) return actor;
    }
    return null;
}

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

function createCollisionOverlayFromObject(sourceRoot, color) {
    if (!sourceRoot) return null;

    const overlayRoot = sourceRoot.isMesh && sourceRoot.geometry
        ? createCollisionLineSegments(sourceRoot.geometry, color)
        : new THREE.Group();
    const sourceMap = new Map([[sourceRoot, overlayRoot]]);

    sourceRoot.traverse((source) => {
        const overlayParent = sourceMap.get(source);
        if (!overlayParent) return;

        source.children.forEach((child) => {
            let overlayChild;
            if (child.isMesh && child.geometry) {
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
        return createCollisionLineSegments(
            new THREE.BoxGeometry(VEHICLE_SETTINGS.width, VEHICLE_SETTINGS.height, VEHICLE_SETTINGS.length),
            color,
        );
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

    for (const actor of sceneSystem?.actors || []) {
        const actorMesh = getActorRenderObject(actor);
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
function resetAllScriptLifecycleHandles() {
    for (let i = 0; i < physics.dynamicBodies.length; i++) {
        const prop = physics.dynamicBodies[i];
        const state = getActorScriptState(prop);
        if (!state) continue;
        if (state.tick) { state.tick.beganPlay = false; }
        if (state.collision) { state.collision.beganPlay = false; }
    }
}

function registerCollisionForProp(contactMap, prop, collisionKey, collision) {
    if (!getActorScriptState(prop)?.collision?.enabled) return;

    let propContacts = contactMap.get(prop.id);
    if (!propContacts) {
        propContacts = new Map();
        contactMap.set(prop.id, propContacts);
    }

    propContacts.set(collisionKey, collision);
}

function updateDynamicBodyCollisionScripts() {
    if (!gameplay.active || !physics.dynamicBodies.length || !hasEnabledDynamicPropEvent('collision')) return;
    const COLLISION_SPEED_THRESHOLD = 0.1;

    const isBodyAwake = (prop, body) => {
        if (!body) return true;

        const physicsComponent = getPhysicsBodyComponent(prop);
        return physicsComponent?.isAwake?.()
            ?? (typeof physics.bodyInterface?.IsActive === 'function'
                ? physics.bodyInterface.IsActive(body.GetID())
                : true);
    };

    const wakeBody = (prop, body) => {
        if (!body || isBodyAwake(prop, body)) return;

        const physicsComponent = getPhysicsBodyComponent(prop);
        physicsComponent?.activate?.();
        if (!physicsComponent?.activate && typeof physics.bodyInterface?.ActivateBody === 'function') {
            physics.bodyInterface.ActivateBody(body.GetID());
        }
    };

    const getBodySpeed = (body) => {
        if (!body) return Number.POSITIVE_INFINITY;
        const velocity = copyJoltVector(tempVectorA, physics.bodyInterface.GetLinearVelocity(body.GetID()));
        return velocity.length();
    };

    const targetEntries = physics.dynamicBodies
        .flatMap((prop) => {
            const mesh = getActorRenderObject(prop);
            if (!mesh) return [];

            return [{
                prop,
                mesh,
                body: getActorBody(prop),
                bounds: new THREE.Box3().setFromObject(mesh),
            }];
        });

    const entries = physics.dynamicBodies
        .flatMap((prop) => {
            const scriptState = getActorScriptState(prop);
            if (!scriptState?.collision?.enabled) return [];

            const mesh = getActorRenderObject(prop);
            if (!mesh) return [];

            const body = getActorBody(prop);
            if (!isBodyAwake(prop, body)) return [];

            const speed = getBodySpeed(body);
            if (speed <= COLLISION_SPEED_THRESHOLD) return [];

            const bounds = new THREE.Box3().setFromObject(mesh);
            const wakeBounds = bounds.clone();
            if (prop.kind === 'vehicle') {
                const wakePadding = THREE.MathUtils.clamp(speed * 0.05, 0.18, 0.75);
                wakeBounds.expandByScalar(wakePadding);
            }

            return [{
                prop,
                mesh,
                body,
                bounds,
                wakeBounds,
            }];
        });

    const contactMap = new Map();
    const processedPairs = new Set();

    for (let index = 0; index < entries.length; index++) {
        const current = entries[index];

        for (let otherIndex = 0; otherIndex < targetEntries.length; otherIndex++) {
            const other = targetEntries[otherIndex];
            if (other.prop.id === current.prop.id) continue;

            const directHit = current.bounds.intersectsBox(other.bounds);
            const nearWakeHit = !directHit && current.wakeBounds?.intersectsBox(other.bounds);
            if (!directHit && !nearWakeHit) continue;

            if (nearWakeHit) {
                wakeBody(other.prop, other.body);
                continue;
            }

            const collisionKey = [current.prop.id, other.prop.id].sort().join(':');
            if (processedPairs.has(collisionKey)) continue;
            processedPairs.add(collisionKey);

            wakeBody(other.prop, other.body);

            registerCollisionForProp(contactMap, current.prop, collisionKey, {
                type: 'prop',
                otherProp: other.prop,
                otherObject: other.mesh,
                otherBody: other.body,
            });

            if (getActorScriptState(other.prop)?.collision?.enabled) {
                registerCollisionForProp(contactMap, other.prop, collisionKey, {
                    type: 'prop',
                    otherProp: current.prop,
                    otherObject: current.mesh,
                    otherBody: current.body,
                });
            }
        }
    }

    physics.dynamicBodies.forEach((prop) => {
        const scriptState = getActorScriptState(prop);
        const eventState = scriptState?.collision;
        if (!eventState?.enabled) return;

        const activeCollisions = scriptState.activeCollisions || new Set();
        const nextCollisions = contactMap.get(prop.id) || new Map();

        nextCollisions.forEach((collision, collisionKey) => {
            if (!activeCollisions.has(collisionKey)) {
                runObjectEventScript(prop, 'collision', { collision });
            }
        });

        scriptState.activeCollisions = new Set(nextCollisions.keys());
    });
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

function readMouseActionDrafts() {
    try {
        const rawValue = window.localStorage.getItem(MOUSE_ACTION_STORAGE_KEY);
        if (!rawValue) return null;
        const parsedValue = JSON.parse(rawValue);
        return parsedValue && typeof parsedValue === 'object' ? parsedValue : null;
    } catch (error) {
        console.warn('Failed to load mouse action drafts.', error);
        return null;
    }
}

function saveMouseActionDrafts() {
    try {
        window.localStorage.setItem(MOUSE_ACTION_STORAGE_KEY, JSON.stringify({
            leftSource: mouseActionState.leftSource,
            rightSource: mouseActionState.rightSource,
        }));
    } catch (error) {
        console.warn('Failed to save mouse action drafts.', error);
    }
}

function getMouseActionLabel(button) {
    return button === 'right' ? 'Right' : 'Left';
}

function getMouseActionMessage() {
    const leftState = mouseActionState.leftError ? `Left error: ${mouseActionState.leftError}` : 'Left ready';
    const rightState = mouseActionState.rightError ? `Right error: ${mouseActionState.rightError}` : 'Right ready';
    const modeState = gameplay.active ? 'Play mode: mouse actions are armed.' : 'Showcase mode: mouse actions are disabled.';
    return `${modeState} ${leftState}. ${rightState}.`;
}

function updateMouseActionStatus(extraMessage = '') {
    if (!mouseActionStatus) return;
    mouseActionStatus.textContent = extraMessage ? `${getMouseActionMessage()} ${extraMessage}` : getMouseActionMessage();
}

function syncInputActionsEditor() {
    if (inputActionLeftBtn) {
        inputActionLeftBtn.classList.toggle('viewer-toggle-btn-active', mouseActionState.selectedButton === 'left');
    }

    if (inputActionRightBtn) {
        inputActionRightBtn.classList.toggle('viewer-toggle-btn-active', mouseActionState.selectedButton === 'right');
    }

    if (inputActionMode) {
        inputActionMode.textContent = `Trigger: ${mouseActionState.selectedButton === 'right' ? 'Right' : 'Left'} Mouse Button`;
    }

    if (inputActionEditorInput) {
        inputActionEditorInput.value = mouseActionState.selectedButton === 'right'
            ? mouseActionState.rightSource
            : mouseActionState.leftSource;
    }

    if (inputActionsEditorStatus) {
        const error = mouseActionState.selectedButton === 'right' ? mouseActionState.rightError : mouseActionState.leftError;
        inputActionsEditorStatus.textContent = error
            ? `${getMouseActionLabel(mouseActionState.selectedButton)} mouse action error: ${error}`
            : `${getMouseActionLabel(mouseActionState.selectedButton)} mouse action ready.`;
    }
}

function openInputActionsEditor(button = mouseActionState.selectedButton) {
    mouseActionState.selectedButton = button === 'right' ? 'right' : 'left';
    syncInputActionsEditor();
    if (inputActionsEditor) {
        inputActionsEditor.hidden = false;
    }
}

function closeInputActionsEditor() {
    if (inputActionsEditor) {
        inputActionsEditor.hidden = true;
    }
}

function updateSelectedMouseActionSource() {
    if (!inputActionEditorInput) return;

    if (mouseActionState.selectedButton === 'right') {
        mouseActionState.rightSource = inputActionEditorInput.value;
    } else {
        mouseActionState.leftSource = inputActionEditorInput.value;
    }
}

function compileMouseActionScript(source) {
    const normalizedSource = typeof source === 'string' ? source.trim() : '';

    if (!normalizedSource) {
        return new MouseActionFunction('api', '"use strict"; return;');
    }

    return new MouseActionFunction('api', `
        "use strict";
        const { THREE, scene, camera, renderer, currentMesh, gameplay, showcase, physics, event, button, mode, spawnDynamicPrimitive, spawnImportedProp,
            FVector, FRotator, FTransform, FHitResult, ECollisionChannel, AActor, AHUD, UAudioComponent, UUserWidget, UTextWidget, UImageWidget, UProgressBarWidget, UButtonWidget, UPrimitiveComponent, UTransformComponent, UGameInstance, UWorld, AGameModeBase, AGameMode, APlayerController, APawn, ACharacter, Self, HUD, WidgetAPI, UnrealWidgetAPI, World, GameInstance, GameMode, PlayerController, Pawn, Character, CreateWidget, GetHUD, GetWorld, GetGameInstance, GetGameMode, GetPlayerController, GetPlayerPawn, GetPlayerCharacter, DeltaTime, Hit } = api;
        ${normalizedSource}
    `);
}

function buildMouseActionApi(event, button) {
    const legacyApi = {
        THREE,
        scene,
        camera,
        renderer,
        currentMesh,
        gameplay,
        showcase,
        physics,
        event,
        button,
        mode: gameplay.active ? 'play' : 'showcase',
        spawnDynamicPrimitive,
        spawnImportedProp,
    };

    return buildUeContext(
        legacyApi,
        {
            scene,
            camera,
            sceneSystem,
            physics,
            audio: runtimeAudio,
            hud: getRuntimeHud(),
            getHUD: getRuntimeHud,
            widgetApi: window.WidgetAPI,
            unrealWidgetApi: window.UnrealWidgetAPI,
            playSoundAtLocation,
            raycastWorld: typeof raycastWorld === 'function' ? raycastWorld : null,
            spawnDynamicPrimitive,
            spawnImportedProp,
            spawnDrivableCar: typeof spawnDrivableCar === 'function' ? spawnDrivableCar : null,
            destroyActor: typeof destroyDynamicPhysicsProp === 'function' ? destroyDynamicPhysicsProp : null,
            enterGameplay: typeof enterGameplay === 'function' ? enterGameplay : null,
            exitGameplay: typeof exitGameplay === 'function' ? exitGameplay : null,
            respawnPlayer: typeof respawnPlayer === 'function' ? respawnPlayer : null,
            syncCameraToCharacter: typeof syncCameraToCharacter === 'function' ? syncCameraToCharacter : null,
            applyGameplayCameraRotation: typeof applyGameplayCameraRotation === 'function' ? applyGameplayCameraRotation : null,
            deltaTime: 0,
        },
        null,
        null,
    );
}

function applyMouseActionScripts({ persist = true } = {}) {
    updateSelectedMouseActionSource();

    mouseActionState.leftError = '';
    mouseActionState.rightError = '';

    try {
        mouseActionState.leftCompiled = compileMouseActionScript(mouseActionState.leftSource);
    } catch (error) {
        mouseActionState.leftError = error?.message || String(error);
        mouseActionState.leftCompiled = null;
        alert(`error: ${mouseActionState.leftError}`);
    }

    try {
        mouseActionState.rightCompiled = compileMouseActionScript(mouseActionState.rightSource);
    } catch (error) {
        mouseActionState.rightError = error?.message || String(error);
        mouseActionState.rightCompiled = null;
        alert(`error: ${mouseActionState.rightError}`);
    }

    if (persist) {
        saveMouseActionDrafts();
    }

    syncInputActionsEditor();
    updateMouseActionStatus(persist ? 'Snippets applied.' : '');
}

function resetMouseActionScripts() {
    mouseActionState.leftSource = DEFAULT_MOUSE_ACTION_SCRIPTS.left;
    mouseActionState.rightSource = DEFAULT_MOUSE_ACTION_SCRIPTS.right;
    syncInputActionsEditor();
    applyMouseActionScripts({ persist: true });
    updateMouseActionStatus('Defaults restored.');
}

function initializeMouseActionScripts() {
    objectScriptState.drafts = readObjectScriptDrafts();
    mouseActionState.leftSource = DEFAULT_MOUSE_ACTION_SCRIPTS.left;
    mouseActionState.rightSource = DEFAULT_MOUSE_ACTION_SCRIPTS.right;
    syncInputActionsEditor();
    applyMouseActionScripts({ persist: true });
    updateMouseActionStatus();
}

function runMouseAction(button, event) {
    if (!gameplay.active || !renderer) return false;

    const compiledAction = button === 'right' ? mouseActionState.rightCompiled : mouseActionState.leftCompiled;
    if (!compiledAction) return false;

    event.preventDefault();
    event.stopPropagation();

    Promise.resolve(compiledAction(buildMouseActionApi(event, button)))
        .then(() => {
            updateMouseActionStatus(`${getMouseActionLabel(button)} mouse action ran in Play mode.`);
        })
        .catch((error) => {
            const errorMessage = error?.message || String(error);
            if (button === 'right') {
                mouseActionState.rightError = errorMessage;
            } else {
                mouseActionState.leftError = errorMessage;
            }
            alert(`error: ${errorMessage}`);
            updateMouseActionStatus(`${getMouseActionLabel(button)} mouse action failed: ${errorMessage}`);
        });

    return true;
}

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

function pushTimingSample(metric, value) {
    const series = debugConsoleState.samples[metric];
    if (!series) return;

    series.push(value);
    if (series.length > DEBUG_TIMING_SAMPLE_LIMIT) {
        series.shift();
    }
}

function getAverageTiming(metric) {
    const series = debugConsoleState.samples[metric];
    if (!series || !series.length) return 0;
    return series.reduce((sum, value) => sum + value, 0) / series.length;
}

function formatTimingMs(value) {
    return `${value.toFixed(value >= 10 ? 1 : 2)} ms`;
}

function renderDebugConsoleOutput() {
    if (!debugConsoleOutput) return;

    const fragment = document.createDocumentFragment();
    debugConsoleState.lines.forEach((line) => {
        const row = document.createElement('div');
        row.className = 'debug-console-line';
        row.dataset.tone = line.tone || 'info';

        const prefix = document.createElement('span');
        prefix.className = 'debug-console-prefix';
        prefix.textContent = line.prefix;

        const text = document.createElement('span');
        text.className = 'debug-console-text';
        text.textContent = line.text;

        row.append(prefix, text);
        fragment.appendChild(row);
    });

    debugConsoleOutput.replaceChildren(fragment);
    debugConsoleOutput.scrollTop = debugConsoleOutput.scrollHeight;
}

function pushDebugConsoleLine(text, tone = 'info', prefix = 'sys') {
    debugConsoleState.lines.push({ prefix, text, tone });
    if (debugConsoleState.lines.length > DEBUG_CONSOLE_LOG_LIMIT) {
        debugConsoleState.lines.shift();
    }
    renderDebugConsoleOutput();
}

function focusDebugConsoleInput() {
    if (!debugConsoleInput) return;
    window.requestAnimationFrame(() => {
        debugConsoleInput.focus();
        debugConsoleInput.select();
    });
}

function setDebugConsoleVisible(isVisible, { focusInput = true } = {}) {
    debugConsoleState.visible = !!isVisible;

    if (debugConsole) {
        debugConsole.hidden = !debugConsoleState.visible;
    }

    document.body.classList.toggle('console-open', debugConsoleState.visible);

    if (debugConsoleState.visible) {
        closeObjectScriptMenu();
        closeObjectScriptEditor();
        resetMovementInputState();

        if (document.pointerLockElement === renderer?.domElement) {
            document.exitPointerLock?.();
        }

        if (focusInput) {
            focusDebugConsoleInput();
        }
        return;
    }

    debugConsoleInput?.blur();
}

function createDebugStatRow(label) {
    const row = document.createElement('div');
    row.className = 'debug-stat-row';

    const title = document.createElement('div');
    title.className = 'debug-stat-label';
    title.textContent = label;

    const value = document.createElement('div');
    value.className = 'debug-stat-value';
    value.textContent = '--';

    row.append(title, value);
    return { row, value };
}

function createDebugStatPanel(name) {
    if (!debugStatsOverlay) return null;

    const panel = document.createElement('section');
    panel.className = 'debug-stat-panel';
    panel.dataset.panel = name;

    const header = document.createElement('div');
    header.className = 'debug-stat-header';

    const titleWrap = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'debug-stat-title';
    title.textContent = name === 'unit' ? 'Stat Unit' : name === 'physics' ? 'Stat Physics' : 'Stat GPU';

    const meta = document.createElement('div');
    meta.className = 'debug-stat-meta';
    meta.textContent = 'Waiting for frame samples...';
    titleWrap.append(title, meta);
    header.appendChild(titleWrap);

    let badge = null;
    if (name === 'gpu') {
        badge = document.createElement('div');
        badge.className = 'debug-stat-badge';
        badge.textContent = 'Approx';
        header.appendChild(badge);
    }

    const grid = document.createElement('div');
    grid.className = 'debug-stat-grid';
    const rows = {};

    const labels = name === 'unit'
        ? ['Frame', 'FPS', 'Update', 'Physics', 'Render', 'Scripts']
        : name === 'physics'
            ? ['Step', 'Sync', 'Collisions', 'Bodies', 'Passes', 'Delta']
            : ['GPU', 'Render', 'Frame', 'FPS'];

    labels.forEach((label) => {
        const key = label.toLowerCase();
        const rowRef = createDebugStatRow(label);
        rows[key] = rowRef.value;
        grid.appendChild(rowRef.row);
    });

    panel.append(header, grid);
    debugStatsOverlay.appendChild(panel);

    return { panel, meta, badge, rows };
}

function syncDebugStatPanels() {
    if (!debugStatsOverlay) return;

    debugConsoleState.panelRefs.forEach((ref, name) => {
        if (!debugConsoleState.panels.has(name)) {
            ref.panel.remove();
            debugConsoleState.panelRefs.delete(name);
        }
    });

    Array.from(debugConsoleState.panels).forEach((name) => {
        if (debugConsoleState.panelRefs.has(name)) return;
        const ref = createDebugStatPanel(name);
        if (ref) {
            debugConsoleState.panelRefs.set(name, ref);
        }
    });
}

function updateDebugStatPanels() {
    if (!debugConsoleState.panels.size) return;

    const averageFrame = getAverageTiming('frame');
    const averageUpdate = getAverageTiming('update');
    const averagePhysics = getAverageTiming('physics');
    const averagePhysicsStep = getAverageTiming('physicsStep');
    const averagePhysicsSync = getAverageTiming('physicsSync');
    const averagePhysicsCollisions = getAverageTiming('physicsCollisions');
    const averageScripts = getAverageTiming('scripts');
    const averageRender = getAverageTiming('render');
    const averageFps = averageFrame > 0 ? 1000 / averageFrame : 0;

    debugConsoleState.panelRefs.forEach((ref, name) => {
        if (name === 'unit') {
            ref.meta.textContent = gameplay.active ? 'Play mode frame timings' : 'Showcase frame timings';
            ref.rows.frame.textContent = formatTimingMs(averageFrame);
            ref.rows.fps.textContent = `${averageFps.toFixed(1)} fps`;
            ref.rows.update.textContent = formatTimingMs(averageUpdate);
            ref.rows.physics.textContent = formatTimingMs(averagePhysics);
            ref.rows.render.textContent = formatTimingMs(averageRender);
            ref.rows.scripts.textContent = formatTimingMs(averageScripts);
            return;
        }

        if (name === 'physics') {
            ref.meta.textContent = physics.ready ? 'Jolt step vs. post-step overhead' : 'Physics still initializing';
            ref.rows.step.textContent = formatTimingMs(averagePhysicsStep);
            ref.rows.sync.textContent = formatTimingMs(averagePhysicsSync);
            ref.rows.collisions.textContent = formatTimingMs(averagePhysicsCollisions);
            ref.rows.bodies.textContent = `${physics.dynamicBodies.length}`;
            ref.rows.passes.textContent = `${debugConsoleState.latest.collisionSteps}`;
            ref.rows.delta.textContent = `${(debugConsoleState.latest.delta * 1000).toFixed(1)} ms`;
            return;
        }

        ref.meta.textContent = 'WebGPU render submission timing';
        if (ref.badge) {
            ref.badge.textContent = debugConsoleState.gpuTimingMode === 'approximate' ? 'Approx' : 'GPU';
        }
        ref.rows.gpu.textContent = formatTimingMs(averageRender);
        ref.rows.render.textContent = formatTimingMs(averageRender);
        ref.rows.frame.textContent = formatTimingMs(averageFrame);
        ref.rows.fps.textContent = `${averageFps.toFixed(1)} fps`;
    });
}

function setDebugStatPanel(name, isEnabled) {
    if (isEnabled) {
        debugConsoleState.panels.add(name);
    } else {
        debugConsoleState.panels.delete(name);
    }

    syncDebugStatPanels();
}

function runStatCommand(args) {
    if (!args.length) {
        pushDebugConsoleLine('Available stat commands: gpu, physics, unit, none.', 'warn');
        return;
    }

    const panel = args[0].toLowerCase();
    const mode = args[1]?.toLowerCase() || 'on';
    const disableTokens = new Set(['0', 'false', 'hide', 'none', 'off']);

    if (disableTokens.has(panel) || panel === 'clear') {
        debugConsoleState.panels.clear();
        syncDebugStatPanels();
        pushDebugConsoleLine('All stat panels hidden.', 'success');
        return;
    }

    if (!['gpu', 'physics', 'unit'].includes(panel)) {
        pushDebugConsoleLine(`Unknown stat target: ${panel}.`, 'error');
        return;
    }

    const isEnabled = !disableTokens.has(mode);
    setDebugStatPanel(panel, isEnabled);

    if (panel === 'gpu' && isEnabled) {
        pushDebugConsoleLine('Stat GPU enabled. This currently reports approximate WebGPU render submission time.', 'warn');
        return;
    }

    pushDebugConsoleLine(`Stat ${panel} ${isEnabled ? 'enabled' : 'hidden'}.`, 'success');
}

function applyMobileModeState() {
    const nextEnabled = mobileState.detected || mobileState.forced;
    const changed = mobileState.enabled !== nextEnabled;

    mobileState.enabled = nextEnabled;
    document.body.classList.toggle('is-mobile', nextEnabled);
    document.body.classList.toggle('mobile-ui-preview', mobileState.forced && !mobileState.detected);

    if (changed && nextEnabled && document.pointerLockElement === renderer?.domElement) {
        document.exitPointerLock?.();
    }

    resetMobileInputState();
    updateWorldPresentation();
    updateGameplayUI();
    updateMobileButtons();
}

function runMobileCommand(args) {
    const action = args[0]?.toLowerCase() || 'toggle';

    if (mobileState.detected) {
        pushDebugConsoleLine('Mobile UI is already active on this device.', 'warn');
        return;
    }

    if (['on', '1', 'true', 'show', 'enable'].includes(action)) {
        mobileState.forced = true;
        applyMobileModeState();
        pushDebugConsoleLine('Mobile UI preview enabled. Use `mobile off` to restore desktop mode.', 'success');
        return;
    }

    if (['off', '0', 'false', 'hide', 'disable'].includes(action)) {
        mobileState.forced = false;
        applyMobileModeState();
        pushDebugConsoleLine('Mobile UI preview disabled. Click the scene again if you want desktop pointer lock back.', 'success');
        return;
    }

    if (['toggle', 'switch'].includes(action)) {
        mobileState.forced = !mobileState.forced;
        applyMobileModeState();
        pushDebugConsoleLine(
            `Mobile UI preview ${mobileState.forced ? 'enabled' : 'disabled'}.`,
            'success'
        );
        return;
    }

    pushDebugConsoleLine('Usage: mobile on, mobile off, or mobile toggle.', 'warn');
}

function runRayDebugCommand(args) {
    const action = args[0]?.toLowerCase() || 'toggle';

    if (['on', '1', 'true', 'show', 'enable'].includes(action)) {
        setRayDebugEnabled(true);
        pushDebugConsoleLine('Ray debug enabled.', 'success');
        return;
    }

    if (['off', '0', 'false', 'hide', 'disable'].includes(action)) {
        setRayDebugEnabled(false);
        pushDebugConsoleLine('Ray debug disabled.', 'success');
        return;
    }

    if (['toggle', 'switch'].includes(action)) {
        setRayDebugEnabled(!raycastDebugState.enabled);
        pushDebugConsoleLine(`Ray debug ${raycastDebugState.enabled ? 'enabled' : 'disabled'}.`, 'success');
        return;
    }

    pushDebugConsoleLine('Usage: raydebug on, raydebug off, or raydebug toggle.', 'warn');
}

const debugCommandRegistry = {
    stat: runStatCommand,
    mobile: runMobileCommand,
    raydebug: runRayDebugCommand,
};

function executeDebugConsoleCommand(rawCommand) {
    const commandText = rawCommand.trim();
    if (!commandText) return;

    debugConsoleState.history.push(commandText);
    if (debugConsoleState.history.length > DEBUG_CONSOLE_HISTORY_LIMIT) {
        debugConsoleState.history.shift();
    }
    debugConsoleState.historyIndex = debugConsoleState.history.length;

    pushDebugConsoleLine(commandText, 'command', '>');

    const [commandName, ...args] = commandText.split(/\s+/);
    const handler = debugCommandRegistry[commandName.toLowerCase()];

    if (!handler) {
        pushDebugConsoleLine(`Unknown command: ${commandName}.`, 'error');
        return;
    }

    handler(args);
}

function handleDebugConsoleInputKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        executeDebugConsoleCommand(debugConsoleInput.value);
        debugConsoleInput.value = '';
        return;
    }

    if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (!debugConsoleState.history.length) return;
        debugConsoleState.historyIndex = Math.max(0, debugConsoleState.historyIndex - 1);
        debugConsoleInput.value = debugConsoleState.history[debugConsoleState.historyIndex] || '';
        return;
    }

    if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (!debugConsoleState.history.length) return;
        debugConsoleState.historyIndex = Math.min(debugConsoleState.history.length, debugConsoleState.historyIndex + 1);
        debugConsoleInput.value = debugConsoleState.history[debugConsoleState.historyIndex] || '';
        return;
    }

    if (event.key === 'Escape') {
        event.preventDefault();
        setDebugConsoleVisible(false, { focusInput: false });
    }
}

function handleDebugConsoleKeydown(event) {
    if (event.code === 'Backquote' && !event.repeat) {
        if (!debugConsoleState.visible && isEditableElement(event.target) && event.target !== debugConsoleInput) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        setDebugConsoleVisible(!debugConsoleState.visible);
        return;
    }

    if (!debugConsoleState.visible) return;

    if (event.code === 'Escape') {
        event.preventDefault();
        setDebugConsoleVisible(false, { focusInput: false });
        return;
    }

    if (event.target !== debugConsoleInput) {
        event.preventDefault();
        focusDebugConsoleInput();
    }
}

function recordDebugFrameMetrics(metrics) {
    debugConsoleState.latest.frame = metrics.frame;
    debugConsoleState.latest.update = metrics.update;
    debugConsoleState.latest.physics = metrics.physics;
    debugConsoleState.latest.physicsStep = metrics.physicsStep;
    debugConsoleState.latest.physicsSync = metrics.physicsSync;
    debugConsoleState.latest.physicsCollisions = metrics.physicsCollisions;
    debugConsoleState.latest.scripts = metrics.scripts;
    debugConsoleState.latest.render = metrics.render;
    debugConsoleState.latest.fps = metrics.frame > 0 ? 1000 / metrics.frame : 0;
    debugConsoleState.latest.delta = metrics.delta;

    pushTimingSample('frame', metrics.frame);
    pushTimingSample('update', metrics.update);
    pushTimingSample('physics', metrics.physics);
    pushTimingSample('physicsStep', metrics.physicsStep);
    pushTimingSample('physicsSync', metrics.physicsSync);
    pushTimingSample('physicsCollisions', metrics.physicsCollisions);
    pushTimingSample('scripts', metrics.scripts);
    pushTimingSample('render', metrics.render);
}

function setMobileMenuOpen(isOpen) {
    mobileState.menuOpen = !!isOpen;
    document.body.classList.toggle('mobile-menu-open', mobileState.menuOpen);

    if (mobileMenuToggleBtn) {
        mobileMenuToggleBtn.textContent = mobileState.menuOpen ? 'Close' : 'Menu';
        mobileMenuToggleBtn.classList.toggle('viewer-toggle-btn-active', mobileState.menuOpen);
    }
}

function setTouchThumbPosition(thumbElement, offsetX, offsetY) {
    if (!thumbElement) return;
    thumbElement.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px))`;
}

function clearMobilePad(thumbElement) {
    setTouchThumbPosition(thumbElement, 0, 0);
}

function applyMobileMoveVector(x, y) {
    const forward = y < -MOBILE_MOVE_THRESHOLD;
    const back = y > MOBILE_MOVE_THRESHOLD;
    const left = x < -MOBILE_MOVE_THRESHOLD;
    const right = x > MOBILE_MOVE_THRESHOLD;

    if (gameplay.active) {
        gameplay.input.forward = forward;
        gameplay.input.back = back;
        gameplay.input.left = left;
        gameplay.input.right = right;
        return;
    }

    showcase.input.forward = forward;
    showcase.input.back = back;
    showcase.input.left = left;
    showcase.input.right = right;
}

function updateMobileMovePad(clientX, clientY) {
    if (!mobileMovePad) return;

    const rect = mobileMovePad.getBoundingClientRect();
    const radius = Math.max(1, Math.min(rect.width, rect.height) * MOBILE_MOVE_RADIUS_FACTOR);
    const centerX = rect.left + rect.width * 0.5;
    const centerY = rect.top + rect.height * 0.5;
    const offsetX = clientX - centerX;
    const offsetY = clientY - centerY;
    const length = Math.hypot(offsetX, offsetY);
    const scale = length > radius ? radius / length : 1;
    const clampedX = offsetX * scale;
    const clampedY = offsetY * scale;

    setTouchThumbPosition(mobileMoveThumb, clampedX, clampedY);
    applyMobileMoveVector(clampedX / radius, clampedY / radius);
}

function resetMobileMovePad() {
    mobileState.movePointerId = null;
    clearMobilePad(mobileMoveThumb);
    applyMobileMoveVector(0, 0);
}

function applyMobileLookDelta(deltaX, deltaY) {
    const lookTarget = gameplay.active ? gameplay : showcase;

    lookTarget.yaw -= deltaX * MOBILE_LOOK_SENSITIVITY;
    lookTarget.pitch -= deltaY * MOBILE_LOOK_SENSITIVITY;
    lookTarget.pitch = THREE.MathUtils.clamp(
        lookTarget.pitch,
        -PLAYER_SETTINGS.maxLookPitch,
        PLAYER_SETTINGS.maxLookPitch
    );

    if (gameplay.active) {
        applyGameplayCameraRotation();
    } else {
        applyShowcaseCameraRotation();
    }
}

function updateMobileLookPad(clientX, clientY, deltaX = 0, deltaY = 0) {
    if (!mobileLookPad) return;

    const rect = mobileLookPad.getBoundingClientRect();
    const radius = Math.max(1, Math.min(rect.width, rect.height) * MOBILE_MOVE_RADIUS_FACTOR);
    const centerX = rect.left + rect.width * 0.5;
    const centerY = rect.top + rect.height * 0.5;
    const offsetX = clientX - centerX;
    const offsetY = clientY - centerY;
    const length = Math.hypot(offsetX, offsetY);
    const scale = length > radius ? radius / length : 1;

    setTouchThumbPosition(mobileLookThumb, offsetX * scale, offsetY * scale);

    if (deltaX || deltaY) {
        applyMobileLookDelta(deltaX, deltaY);
    }
}

function resetMobileLookPad() {
    mobileState.lookPointerId = null;
    if (mobileLookPad?.dataset) {
        delete mobileLookPad.dataset.lastX;
        delete mobileLookPad.dataset.lastY;
    }
    clearMobilePad(mobileLookThumb);
}

function syncMobileActionVisibility() {
    if (mobileJumpBtn) {
        mobileJumpBtn.hidden = !gameplay.active;
    }

    if (mobileRightActionBtn) {
        mobileRightActionBtn.hidden = !gameplay.active;
    }

    if (mobileAction2Btn) {
        mobileAction2Btn.hidden = !gameplay.active;
    }

    if (mobileModeToggleBtn) {
        mobileModeToggleBtn.textContent = gameplay.active ? 'Showcase' : 'Play';
        mobileModeToggleBtn.classList.toggle('viewer-toggle-btn-active', gameplay.active);
    }

}

function updateMobileButtons() {
    if (mobileMenuToggleBtn) {
        mobileMenuToggleBtn.classList.toggle('viewer-toggle-btn-active', mobileState.menuOpen);
    }

    if (mobileJumpBtn) {
        mobileJumpBtn.textContent = isDrivingVehicle() ? 'Brake' : 'Jump';
    }

    if (mobileAction2Btn) {
        mobileAction2Btn.textContent = isDrivingVehicle() ? 'Exit' : 'Enter';
    }

    syncMobileActionVisibility();
}

function applyMobileHoldButton(button, onDown, onUp) {
    if (!button) return;

    let isPressed = false;

    const release = () => {
        if (!isPressed) return;
        isPressed = false;
        onUp?.();
    };

    button.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        event.preventDefault();
        isPressed = true;
        button.setPointerCapture?.(event.pointerId);
        onDown?.(event);
    });

    button.addEventListener('pointerup', () => release());
    button.addEventListener('pointercancel', () => release());
    button.addEventListener('lostpointercapture', () => release());
    button.addEventListener('contextmenu', (event) => event.preventDefault());
}

function bindMobilePad(padElement, thumbElement, onMove, onRelease) {
    if (!padElement) return;

    const handleMove = (event) => {
        if (event.pointerId !== mobileState[padElement === mobileMovePad ? 'movePointerId' : 'lookPointerId']) return;
        event.preventDefault();
        onMove(event);
    };

    padElement.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        event.preventDefault();
        padElement.setPointerCapture?.(event.pointerId);
        if (padElement === mobileMovePad) {
            mobileState.movePointerId = event.pointerId;
        } else {
            mobileState.lookPointerId = event.pointerId;
        }
        onMove(event);
    });

    padElement.addEventListener('pointermove', handleMove);
    padElement.addEventListener('pointerup', (event) => {
        if (padElement === mobileMovePad && event.pointerId !== mobileState.movePointerId) return;
        if (padElement === mobileLookPad && event.pointerId !== mobileState.lookPointerId) return;
        event.preventDefault();
        onRelease?.();
    });
    padElement.addEventListener('pointercancel', () => onRelease?.());
    padElement.addEventListener('lostpointercapture', () => onRelease?.());
    padElement.addEventListener('contextmenu', (event) => event.preventDefault());
}

function setupMobileControls() {
    mobileMenuToggleBtn = document.getElementById('mobile-menu-toggle');
    mobileModeToggleBtn = document.getElementById('mobile-mode-toggle');
    mobileMovePad = document.getElementById('mobile-move-pad');
    mobileMoveThumb = document.getElementById('mobile-move-thumb');
    mobileLookPad = document.getElementById('mobile-look-pad');
    mobileLookThumb = document.getElementById('mobile-look-thumb');
    mobileRightActionBtn = document.getElementById('mobile-right-action');
    mobileAction2Btn = document.getElementById('mobile-action2');
    mobileJumpBtn = document.getElementById('mobile-jump');

    mobileMenuToggleBtn?.addEventListener('click', () => setMobileMenuOpen(!mobileState.menuOpen));
    mobileModeToggleBtn?.addEventListener('click', () => setCameraMode(gameplay.active ? 'showcase' : 'play'));

    mobileJumpBtn?.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        event.preventDefault();
        if (gameplay.active) {
            if (isDrivingVehicle()) {
                vehicleState.brakeHeld = true;
            } else {
                physics.jumpQueued = true;
            }
        }
    });
    mobileJumpBtn?.addEventListener('pointerup', () => {
        vehicleState.brakeHeld = false;
    });
    mobileJumpBtn?.addEventListener('pointercancel', () => {
        vehicleState.brakeHeld = false;
    });

    mobileRightActionBtn?.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        runMouseAction('right', event);
    });

    mobileAction2Btn?.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        if (isDrivingVehicle()) {
            exitVehicle();
        } else {
            enterVehicle();
        }
    });

    bindMobilePad(mobileMovePad, mobileMoveThumb, (event) => {
        updateMobileMovePad(event.clientX, event.clientY);
    }, () => {
        resetMobileMovePad();
    });

    bindMobilePad(mobileLookPad, mobileLookThumb, (event) => {
        const lastX = mobileLookPad.dataset.lastX ? Number(mobileLookPad.dataset.lastX) : event.clientX;
        const lastY = mobileLookPad.dataset.lastY ? Number(mobileLookPad.dataset.lastY) : event.clientY;
        const deltaX = event.clientX - lastX;
        const deltaY = event.clientY - lastY;
        mobileLookPad.dataset.lastX = String(event.clientX);
        mobileLookPad.dataset.lastY = String(event.clientY);
        updateMobileLookPad(event.clientX, event.clientY, deltaX, deltaY);
    }, () => {
        if (mobileLookPad?.dataset) {
            delete mobileLookPad.dataset.lastX;
            delete mobileLookPad.dataset.lastY;
        }
        resetMobileLookPad();
    });

    updateMobileButtons();
}

function refreshSceneUI() {
    if (collisionDebugState.enabled) {
        refreshCollisionDebugOverlays();
    }

    if (!sceneUiList || !sceneUiCount) return;

    sceneUiList.innerHTML = '';

    if (!sceneSystem || sceneSystem.actors.size === 0) {
        sceneUiCount.textContent = '0 Actors';
        return;
    }

    const actors = Array.from(sceneSystem.actors);
    sceneUiCount.textContent = `${actors.length} Actor${actors.length !== 1 ? 's' : ''}`;

    actors.forEach(actor => {
        const item = document.createElement('div');
        item.className = 'scene-ui-item';
        item.dataset.id = actor.id;

        if (objectScriptState.targetPropId === actor.id) {
            item.style.background = 'rgba(255, 255, 255, 0.12)';
            item.style.borderColor = 'rgba(112, 0, 255, 0.45)';
            
            if (!blueprintState.active) {
                const actorBtnRow = document.createElement('div');
                actorBtnRow.className = 'scene-ui-item-actions';

                const blueprintBtn = document.createElement('button');
                blueprintBtn.className = 'btn btn-primary scene-ui-action-btn';
                blueprintBtn.textContent = 'Edit Blueprint';
                blueprintBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    enterBlueprintEditor();
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
}

// --- Initialization ---
async function init() {
    // Mobile Detection
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.matchMedia('(pointer: coarse)').matches;
    mobileState.detected = isMobile;
    mobileState.forced = false;
    applyMobileModeState();

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

    renderDebugConsoleOutput();
    debugConsoleInput?.addEventListener('keydown', handleDebugConsoleInputKeydown);

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
    actorKindSelect?.addEventListener('change', () => syncActorEditorUi());
    actorImportedTemplateSelect?.addEventListener('change', () => syncActorEditorUi());
    actorVehicleBodyTemplateSelect?.addEventListener('change', () => syncActorEditorUi());
    actorVehicleWheelTemplateSelect?.addEventListener('change', () => syncActorEditorUi());
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
    setupMobileControls();

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
    runtimeAudio.listener = new SoundGeneratorAudioListener();
    camera.add(runtimeAudio.listener);

    renderer = new WebGPURenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.localClippingEnabled = true; // Essential for the reflection
    renderer.domElement.tabIndex = 0;
    container.appendChild(renderer.domElement);

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
            syncTransformToPhysics();
            transformControl.justFinishedDragging = true;
            editorHistory.captureState();
            setTimeout(() => transformControl.justFinishedDragging = false, 100);
        }
    });
    scene.add(transformControl.getHelper());
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

    const mainLight = new THREE.DirectionalLight(0xffffff, 2.5);
    mainLight.position.set(5, 10, 5);
    mainLight.castShadow = true;
    mainLight.shadow.mapSize.width = 2048;
    mainLight.shadow.mapSize.height = 2048;
    mainLight.shadow.camera.near = 0.5;
    mainLight.shadow.camera.far = 15;
    mainLight.shadow.camera.left = -3;
    mainLight.shadow.camera.right = 3;
    mainLight.shadow.camera.top = 3;
    mainLight.shadow.camera.bottom = -3;
    mainLight.shadow.bias = -0.001;
    scene.add(mainLight);

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
        updateGameplayDebugRay();
        const updateDuration = performance.now() - updateStart;

        let physicsMetrics = { total: 0, step: 0, sync: 0, collisions: 0 };
        if (gameplay.active) {
            physicsMetrics = stepPhysics(delta);
            updateVehicleVisuals(delta);
        }
        
        multiplayerController?.syncLocalSnapshot(getLocalMultiplayerSnapshot());
        multiplayerController?.update(delta);

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
            renderer.renderAsync(scene, camera);

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

function loadSample() {
    clearCurrentMesh();

    // Create a very dense Torus Knot to simulate a "heavy" file
    const geometry = new THREE.TorusKnotGeometry(1, 0.3, 300, 100);
    const material = new THREE.MeshStandardMaterial({
        color: 0x7000ff,
        metalness: 0.8,
        roughness: 0.2,
        emissive: 0x200040
    });

    const object = new THREE.Mesh(geometry, material);
    object.castShadow = true;
    object.receiveShadow = true;

    currentMesh = object;
    scene.add(currentMesh);
    normalizeCurrentMesh();
    refreshGameplayWorld();

    document.getElementById('asset-name').textContent = 'Heavy_Industrial_Part_RAW.glb';
    document.getElementById('tri-count').textContent = 'Counting...';

    // Calculate Triangles correctly
    let totalTris = 0;
    if (geometry.index) {
        totalTris = geometry.index.count / 3;
    } else {
        totalTris = geometry.attributes.position.count / 3;
    }

    originalTriCount = Math.round(totalTris);
    console.log("Sample loaded. Triangles:", originalTriCount);

    // Animate the count-up safely using a proxy object
    const countObj = { val: 0 };
    gsap.to(countObj, {
        val: originalTriCount,
        duration: 1.5,
        ease: "power2.out",
        onUpdate: () => {
            document.getElementById('tri-count').textContent = Math.ceil(countObj.val).toLocaleString();
        }
    });

    originalFileSize = 5400000; // ~5.4 MB for the sample
    document.getElementById('file-size').textContent = (originalFileSize / (1024 * 1024)).toFixed(1) + ' MB';
    document.getElementById('file-diff').textContent = '';
    document.getElementById('webgpu-speedup').textContent = '--';

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
    clearDynamicPhysicsProps();

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

function refreshGameplayWorld() {
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
    resetShowcaseCamera(false);
    updateGameplayUI();
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
                if (typeof transformControl !== 'undefined') transformControl.attach(hitObj);
                refreshBlueprintComponents();
                
                // Fly camera to the component
                const targetPos = new THREE.Vector3();
                hitObj.getWorldPosition(targetPos);
                const forward = new THREE.Vector3().subVectors(targetPos, camera.position).normalize();
                const dist = camera.position.distanceTo(targetPos);
                const newDist = Math.max(dist * 0.5, 3);
                
                if (typeof gsap !== 'undefined') {
                    gsap.to(camera.position, {
                        x: targetPos.x - forward.x * newDist,
                        y: targetPos.y - forward.y * newDist + 1,
                        z: targetPos.z - forward.z * newDist,
                        duration: 0.5,
                        ease: 'power2.out',
                        onUpdate: () => {
                            syncShowcaseAnglesFromTarget(targetPos);
                            applyShowcaseCameraRotation();
                        }
                    });
                }
            }
            return;
        }
        
        if (gameplay.active) return;
        const propHit = getDynamicPropHitFromEvent(event);
        if (propHit?.prop) {
            selectShowcaseActor(propHit.prop.id);
            
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
    syncTransformControlState();

    updateWorldPresentation();
    resetShowcaseCamera(false);
    updateGameplayUI();
}

function enterGameplay() {
    if (!gameplay.canPlay) return;

    snapshotSceneState();
    syncGameplaySpawnToCamera();
    respawnPlayer(true);
    gameplay.pointerLocked = false;
    gameplay.active = true;
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
    resetShowcaseCamera(false);
    updateGameplayUI();
}

function updateWorldPresentation() {
    if (pedestal) pedestal.visible = !gameplay.active;
    document.body.classList.toggle('play-ready', gameplay.canPlay);
    document.body.classList.toggle('play-active', gameplay.active);
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
    if (!gameplay.canPlay) return;

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
    }
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

function getTextureCompressionProfile(name, quality, maxSize) {
    const profiles = {
        map: { quality, maxSize, allowJpeg: true, detectAlpha: true },
        normalMap: { quality: Math.min(quality, 0.72), maxSize: Math.min(maxSize, 1024), allowJpeg: false, detectAlpha: false },
        roughnessMap: { quality: Math.min(quality, 0.68), maxSize: Math.min(maxSize, 1024), allowJpeg: true, detectAlpha: false },
        metalnessMap: { quality: Math.min(quality, 0.68), maxSize: Math.min(maxSize, 1024), allowJpeg: true, detectAlpha: false },
        emissiveMap: { quality: Math.min(quality, 0.78), maxSize: Math.min(maxSize, 1024), allowJpeg: true, detectAlpha: true },
        aoMap: { quality: Math.min(quality, 0.68), maxSize: Math.min(maxSize, 1024), allowJpeg: true, detectAlpha: false },
        alphaMap: { quality: Math.min(quality, 0.72), maxSize: Math.min(maxSize, 1024), allowJpeg: false, detectAlpha: false },
    };

    return profiles[name] || { quality, maxSize, allowJpeg: true, detectAlpha: true };
}

async function getImageSourceSize(image) {
    const sourceUrl = image?.currentSrc || image?.src;
    if (!sourceUrl) return null;

    try {
        const response = await fetch(sourceUrl);
        const blob = await response.blob();
        return blob.size;
    } catch {
        return null;
    }
}

function createTextureCanvas(width, height) {
    if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(width, height);
        return {
            canvas,
            ctx: canvas.getContext('2d', { alpha: true }),
            useOffscreen: true,
        };
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return {
        canvas,
        ctx: canvas.getContext('2d', { alpha: true }),
        useOffscreen: false,
    };
}

async function canvasToBlob(canvas, mimeType, quality, useOffscreen) {
    if (useOffscreen) {
        return canvas.convertToBlob({ type: mimeType, quality });
    }

    return new Promise(resolve => {
        canvas.toBlob(resolve, mimeType, quality);
    });
}

function hasTransparency(ctx, width, height) {
    const step = Math.max(1, Math.floor(Math.max(width, height) / 128));
    const { data } = ctx.getImageData(0, 0, width, height);

    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            const alphaIndex = ((y * width) + x) * 4 + 3;
            if (data[alphaIndex] < 255) {
                return true;
            }
        }
    }

    return false;
}

function cloneTextureSettings(source, target, mimeType, colorSpace) {
    target.name = source.name;
    target.wrapS = source.wrapS;
    target.wrapT = source.wrapT;
    target.magFilter = THREE.LinearFilter;
    target.minFilter = THREE.LinearMipmapLinearFilter;
    target.generateMipmaps = true;
    target.flipY = source.flipY;
    target.colorSpace = colorSpace;
    target.repeat.copy(source.repeat);
    target.offset.copy(source.offset);
    target.center.copy(source.center);
    target.rotation = source.rotation;
    target.anisotropy = source.anisotropy;
    target.channel = source.channel;
    target.userData = { ...source.userData, mimeType };
    target.needsUpdate = true;
}

// === TEXTURE OPTIMIZATION (Best-in-class 2026 pipeline) ===
async function compressTextures(object, quality = 0.85, maxSize = 2048, useKTX2 = false) {
    const textureMap = new Map();
    const texturePromises = [];

    object.traverse(child => {
        if (!child.isMesh) return;

        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(mat => {
            if (!mat) return;

            const mapNames = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap'];
            mapNames.forEach(name => {
                const tex = mat[name];
                if (tex && tex.isTexture && tex.image && !textureMap.has(tex.uuid)) {
                    const isNormal = name === 'normalMap' || (tex.name && tex.name.toLowerCase().includes('normal'));
                    const profile = getTextureCompressionProfile(name, quality, maxSize);
                    const promise = (useKTX2
                        ? compressTextureToKTX2(tex, profile.quality, profile.maxSize, isNormal)
                        : compressTextureToWebP(tex, profile, isNormal)
                    ).then(newTex => {
                        textureMap.set(tex.uuid, newTex);
                        mat[name] = newTex;
                    });
                    texturePromises.push(promise);
                } else if (tex && tex.isTexture) {
                    mat[name] = textureMap.get(tex.uuid) || tex;
                }
            });
        });
    });

    await Promise.all(texturePromises);
    console.log(`Texture optimization complete (${useKTX2 ? 'KTX2/BasisU' : 'WebP'})`);
}

async function compressTextureToWebP(texture, profile, isNormal) {
    const img = texture.image;
    let width = img.width || img.videoWidth || 512;
    let height = img.height || img.videoHeight || 512;

    if (width > profile.maxSize || height > profile.maxSize) {
        const ratio = Math.min(profile.maxSize / width, profile.maxSize / height);
        width = Math.floor(width * ratio);
        height = Math.floor(height * ratio);
    }

    const { canvas, ctx, useOffscreen } = createTextureCanvas(width, height);

    if (!ctx) return texture;

    ctx.drawImage(img, 0, 0, width, height);

    const hasAlpha = profile.detectAlpha ? hasTransparency(ctx, width, height) : false;
    const candidates = [{ mimeType: 'image/webp', quality: profile.quality }];

    if (!isNormal && profile.allowJpeg && !hasAlpha) {
        candidates.push({ mimeType: 'image/jpeg', quality: Math.max(0.55, profile.quality - 0.08) });
    }

    const blobs = await Promise.all(candidates.map(async candidate => {
        const blob = await canvasToBlob(canvas, candidate.mimeType, candidate.quality, useOffscreen);
        return blob ? { ...candidate, blob } : null;
    }));

    const validCandidates = blobs.filter(Boolean);
    if (validCandidates.length === 0) return texture;

    let bestCandidate = validCandidates[0];
    for (const candidate of validCandidates) {
        if (candidate.blob.size < bestCandidate.blob.size) {
            bestCandidate = candidate;
        }
    }

    const originalSize = await getImageSourceSize(img);
    if (originalSize && bestCandidate.blob.size >= originalSize) {
        return texture;
    }

    return new Promise(resolve => {
        const url = URL.createObjectURL(bestCandidate.blob);
        const loader = new THREE.TextureLoader();
        loader.load(url, newTexture => {
            cloneTextureSettings(
                texture,
                newTexture,
                bestCandidate.mimeType,
                isNormal ? THREE.NoColorSpace : THREE.SRGBColorSpace
            );
            resolve(newTexture);
            URL.revokeObjectURL(url);
        }, undefined, () => {
            URL.revokeObjectURL(url);
            resolve(texture);
        });
    });
}

// === KTX2 + Basis Universal (Pro tier – 70-95% reduction + GPU-native) ===
// Uncomment and implement when you add the Basis encoder WASM.
async function compressTextureToKTX2(texture, quality, maxSize, isNormal) {
    console.warn('KTX2 Pro feature – using WebP fallback for now');
    return compressTextureToWebP(texture, {
        quality,
        maxSize,
        allowJpeg: !isNormal,
        detectAlpha: !isNormal,
    }, isNormal);
}

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

// === ACTOR EXPORT / IMPORT ===
function getActorComponentFlags(actor) {
    if (!actor) {
        return { collision: false, physics: false, scripts: false };
    }

    const storedFlags = actor._componentFlags || null;
    const hasBody = !!getActorBody(actor);
    const includeCollisionBody = typeof storedFlags?.collision === 'boolean'
        ? storedFlags.collision
        : hasBody;
    const includeScripts = typeof storedFlags?.scripts === 'boolean'
        ? storedFlags.scripts
        : !!getActorScriptState(actor);

    let simulatePhysics = false;
    if (includeCollisionBody) {
        if (typeof storedFlags?.physics === 'boolean') {
            simulatePhysics = storedFlags.physics;
        } else if (physics.dynamicBodies.includes(actor)) {
            simulatePhysics = true;
        } else if (physics.staticBodies.includes(actor)) {
            simulatePhysics = false;
        } else {
            simulatePhysics = true;
        }
    }

    return {
        collision: !!includeCollisionBody,
        physics: !!includeCollisionBody && !!simulatePhysics,
        scripts: !!includeScripts,
    };
}

function setActorComponentFlags(actor, flags = {}) {
    if (!actor) {
        return { collision: false, physics: false, scripts: false };
    }

    const normalizedFlags = {
        collision: flags.collision !== false,
        physics: flags.collision === false ? false : flags.physics !== false,
        scripts: !!flags.scripts,
    };

    actor._componentFlags = normalizedFlags;
    return normalizedFlags;
}

function normalizeSerializedActorComponentFlags(actorData = {}) {
    const rawFlags = actorData.componentFlags || actorData.componentState || null;
    const includeCollisionBody = actorData.kind === 'vehicle'
        ? true
        : typeof rawFlags?.collision === 'boolean'
            ? rawFlags.collision
            : typeof rawFlags?.includeCollisionBody === 'boolean'
                ? rawFlags.includeCollisionBody
                : true;
    const simulatePhysics = includeCollisionBody && (actorData.kind === 'vehicle'
        ? true
        : typeof rawFlags?.physics === 'boolean'
            ? rawFlags.physics
            : typeof rawFlags?.simulatePhysics === 'boolean'
                ? rawFlags.simulatePhysics
                : true);
    const includeScripts = typeof rawFlags?.scripts === 'boolean'
        ? rawFlags.scripts
        : typeof rawFlags?.includeScripts === 'boolean'
            ? rawFlags.includeScripts
            : !!actorData.scripts;

    return {
        collision: !!includeCollisionBody,
        physics: !!includeCollisionBody && !!simulatePhysics,
        scripts: !!includeScripts,
    };
}

function serializeActorData(actor) {
    if (!actor) return null;

    const mesh = getActorRenderObject(actor);
    if (!mesh) return null;

    return {
        id: actor.id,
        kind: actor.kind,
        name: actor.rootNode?.name || 'Actor',
        templateId: actor.templateId,
        vehicleBodyTemplateId: actor.vehicleBodyTemplateId || null,
        vehicleWheelTemplateId: actor.vehicleWheelTemplateId || null,
        userData: actor.entity.getComponent('metadata')?.userData || null,
        transform: {
            position: mesh.position.toArray(),
            quaternion: mesh.quaternion.toArray(),
            scale: mesh.scale.toArray(),
        },
        material: serializeObjectMaterialState(mesh),
        materialOverrides: serializeObjectMaterialOverrides(mesh),
        scripts: objectScriptState.drafts[actor.id] || null,
        componentFlags: getActorComponentFlags(actor),
        components: serializeComponentTree(mesh),
    };
}

function spawnActorFromSerializedData(actorData, { preserveId = false } = {}) {
    if (!actorData) return null;

    const componentFlags = normalizeSerializedActorComponentFlags(actorData);
    const savedScripts = actorData.scripts
        ? JSON.parse(JSON.stringify(actorData.scripts))
        : null;
    let tempScriptId = '';

    if (savedScripts) {
        tempScriptId = `loaded-actor-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        objectScriptState.drafts[tempScriptId] = savedScripts;
    }

    let scale = 1;
    if (actorData.kind === 'sphere' || actorData.kind === 'cube' || actorData.kind === 'capsule') {
        scale = actorData.transform.scale[0];
    }

    let actor = null;
    if (actorData.kind === 'vehicle') {
        const savedBodyTemplateId = actorData.vehicleBodyTemplateId
            && importedPropState.templates.some((template) => template.id === actorData.vehicleBodyTemplateId)
            ? actorData.vehicleBodyTemplateId
            : '';
        const savedWheelTemplateId = actorData.vehicleWheelTemplateId
            && importedPropState.templates.some((template) => template.id === actorData.vehicleWheelTemplateId)
            ? actorData.vehicleWheelTemplateId
            : '';
        actor = spawnDrivableCar({
            includeScripts: componentFlags.scripts,
            userData: actorData.userData,
            bodyTemplateId: savedBodyTemplateId,
            wheelTemplateId: savedWheelTemplateId,
        });
    } else if (actorData.kind === 'imported') {
        if (!actorData.templateId || !importedPropState.templates.some((template) => template.id === actorData.templateId)) {
            if (tempScriptId) {
                delete objectScriptState.drafts[tempScriptId];
            }
            alert('This actor requires an imported prop source (template) that is not currently loaded. Import the matching prop file first, then try loading this actor again.');
            return null;
        }

        actor = spawnImportedProp(actorData.templateId, {
            includeScripts: componentFlags.scripts,
            userData: actorData.userData,
            includeCollisionBody: componentFlags.collision,
            simulatePhysics: componentFlags.physics,
        });
    } else {
        actor = spawnDynamicPrimitive(actorData.kind, undefined, scale, {
            includeScripts: componentFlags.scripts,
            userData: actorData.userData,
            returnActor: true,
            includeCollisionBody: componentFlags.collision,
            simulatePhysics: componentFlags.physics,
        });
    }

    if (!actor) {
        if (tempScriptId) {
            delete objectScriptState.drafts[tempScriptId];
        }
        return null;
    }

    const previousId = actor.id;
    if (preserveId && actorData.id) {
        actor.id = actorData.id;
        syncRuntimePropIdCounter(actor.id);
    }

    setActorComponentFlags(actor, componentFlags);

    if (tempScriptId) {
        const restoredScripts = objectScriptState.drafts[tempScriptId];
        delete objectScriptState.drafts[tempScriptId];
        if (restoredScripts) {
            objectScriptState.drafts[actor.id] = restoredScripts;
        }
    }

    if (previousId !== actor.id && objectScriptState.drafts[previousId]) {
        delete objectScriptState.drafts[previousId];
    }

    if (actorData.name) {
        actor.rootNode.name = actorData.name;
    }

    const mesh = getActorRenderObject(actor);
    if (mesh) {
        mesh.userData.dynamicPropId = actor.id;
        mesh.position.fromArray(actorData.transform.position);
        mesh.quaternion.fromArray(actorData.transform.quaternion);
        mesh.scale.fromArray(actorData.transform.scale);
        deserializeComponentTree(mesh, actorData.components);
        if (Array.isArray(actorData.materialOverrides) && actorData.materialOverrides.length > 0) {
            applyObjectMaterialOverrides(mesh, actorData.materialOverrides);
        } else {
            applyObjectMaterialState(mesh, actorData.material);
        }
        mesh.updateMatrixWorld(true);
        rebuildActorPhysics(actor);
    }

    if (componentFlags.scripts) {
        syncPropScriptState(actor);
    }

    return actor;
}

function exportActorToFile(actor) {
    if (!actor) return;

    const actorData = {
        version: 1,
        type: 'polyflow-actor',
        actor: serializeActorData(actor)
    };

    const displayName = getDynamicPropDisplayName(actor)
        .replace(/[^a-zA-Z0-9_\- ]/g, '')
        .replace(/\s+/g, '_')
        .toLowerCase() || 'actor';
    const blob = new Blob([JSON.stringify(actorData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${displayName}.actor`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
}

function loadActorFromFile(file) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (data.type !== 'polyflow-actor' || !data.actor) {
                alert('This file is not a valid PolyFlow actor file.');
                return;
            }

            const actorData = data.actor;
            const actor = spawnActorFromSerializedData(actorData);

            if (actor) {
                saveObjectScriptDrafts();
                refreshSceneUI();
                selectShowcaseActor(actor.id);
            } else {
                alert('Failed to spawn the loaded actor. Physics may not be ready yet.');
            }
        } catch (err) {
            console.error('Error loading actor file', err);
            alert('Failed to load actor file. It may be corrupt or in an unsupported format.');
        }
    };
    reader.readAsText(file);
}

function clearSceneActors() {
    if (!sceneSystem) return;
    const actorsToDestroy = Array.from(sceneSystem.actors);
    for (const actor of actorsToDestroy) {
        const body = getActorBody(actor);
        if (body && physics.bodyInterface) {
            physics.bodyInterface.RemoveBody(body.GetID());
            physics.bodyInterface.DestroyBody(body.GetID());
        }
        
        const mesh = getActorRenderObject(actor);
        if (mesh && mesh.parent) {
            mesh.parent.remove(mesh);
            mesh.geometry?.dispose();
            mesh.material?.dispose();
        }
        
        sceneSystem.removeActor(actor);
    }
    
    physics.dynamicBodies = [];
    physics.staticBodies = [];
    selectShowcaseActor(null);
}

function loadWorldFromUmap(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const umap = JSON.parse(e.target.result);
            editorHistory.captureState();
            loadWorldFromJSON(umap);
        } catch (err) {
            console.error('Error loading scene file', err);
            alert('Failed to load scene file.');
        }
    };
    reader.readAsText(file);
}

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
function enterBlueprintEditor() {
    const actorId = objectScriptState.targetPropId;
    if (!actorId) return;
    const prop = getDynamicPropById(actorId);
    if (!prop || !getActorRenderObject(prop)) return;

    blueprintState.active = true;
    if (typeof transformControl !== 'undefined') {
        transformControl.setSpace('local');
        transformControl.setMode('translate');
    }
    if (typeof updateBlueprintTransformUI === 'function') updateBlueprintTransformUI();
    blueprintState.targetActor = prop;
    blueprintState.selectedComponent = getActorRenderObject(prop);
    
    blueprintState.savedCameraPosition = camera.position.clone();
    blueprintState.savedShowcaseAngles = { yaw: showcase.yaw, pitch: showcase.pitch };
    blueprintState.savedBackground = scene.background;
    scene.background = new THREE.Color(0x1a1a1a);
    
    for (const actor of sceneSystem.actors) {
        if (actor !== prop) {
            const mesh = getActorRenderObject(actor);
            if (mesh) mesh.visible = false;
        }
    }
    
    // Clean up previous blueprint objects
    if (blueprintState.floorMesh) {
        scene.remove(blueprintState.floorMesh);
    }
    if (blueprintState.gridHelper) {
        scene.remove(blueprintState.gridHelper);
    }
    if (blueprintState.editorLights) {
        blueprintState.editorLights.forEach(l => scene.remove(l));
    }
    
    const targetPos = getActorRenderObject(prop).position.clone();
    const floorY = targetPos.y - 1;
    
    // Floor plane
    const floorGeo = new THREE.PlaneGeometry(50, 50);
    const floorMat = new THREE.MeshStandardMaterial({ 
        color: 0x2a2a2a, 
        roughness: 0.95,
        metalness: 0.0
    });
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.set(targetPos.x, floorY, targetPos.z);
    floorMesh.receiveShadow = true;
    scene.add(floorMesh);
    blueprintState.floorMesh = floorMesh;
    
    // Grid helper (added directly to scene, not as child of rotated plane)
    const gridHelper = new THREE.GridHelper(50, 50, 0x555555, 0x333333);
    gridHelper.position.set(targetPos.x, floorY + 0.01, targetPos.z);
    scene.add(gridHelper);
    blueprintState.gridHelper = gridHelper;
    
    // Blueprint editor lights (so the actor is visible against the dark background)
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(targetPos.x + 5, targetPos.y + 8, targetPos.z + 5);
    dirLight.target.position.copy(targetPos);
    scene.add(dirLight.target);
    scene.add(ambientLight);
    scene.add(dirLight);
    blueprintState.editorLights = [ambientLight, dirLight, dirLight.target];
    
    // Snap camera to look at the actor
    const camTarget = targetPos.clone();
    camera.position.set(camTarget.x + 4, camTarget.y + 3, camTarget.z + 4);
    
    // Compute yaw/pitch from camera position to target
    // The showcase camera uses: rotation.y = yaw, rotation.x = pitch (YXZ order)
    // Forward direction = target - camera
    const forward = new THREE.Vector3().subVectors(camTarget, camera.position).normalize();
    showcase.yaw = Math.atan2(-forward.x, -forward.z);
    showcase.pitch = Math.asin(forward.y);
    applyShowcaseCameraRotation();

    const panel = document.getElementById('blueprint-editor-panel');
    const menuSections = document.querySelector('.viewer-menu-sections-card');
    const actorsMenu = document.querySelector('.viewer-menu-card:nth-child(2)');
    const cameraMenu = document.querySelector('.viewer-menu-card:first-child');
    const sceneUi = document.getElementById('scene-ui-panel');
    
    if (panel) {
        document.getElementById('blueprint-actor-name').textContent = prop.rootNode.name || actorId;
        panel.style.display = 'block';
        if (menuSections) menuSections.style.display = 'none';
        if (actorsMenu) actorsMenu.style.display = 'none';
        if (cameraMenu) cameraMenu.style.display = 'none';
        if (sceneUi) sceneUi.style.display = 'none';
        refreshBlueprintComponents();
    }
    
    refreshSceneUI();
}

function exitBlueprintEditor() {
    blueprintState.active = false;
    blueprintState.targetActor = null;
    blueprintState.selectedComponent = null;
    
    if (typeof sceneSystem !== 'undefined') {
        for (const actor of sceneSystem.actors) {
            const mesh = getActorRenderObject(actor);
            if (mesh) mesh.visible = true;
        }
    }
    
    if (blueprintState.floorMesh) {
        scene.remove(blueprintState.floorMesh);
        blueprintState.floorMesh = null;
    }
    if (blueprintState.gridHelper) {
        scene.remove(blueprintState.gridHelper);
        blueprintState.gridHelper = null;
    }
    if (blueprintState.editorLights) {
        blueprintState.editorLights.forEach(l => scene.remove(l));
        blueprintState.editorLights = null;
    }
    
    if (blueprintState.savedCameraPosition && typeof gsap !== 'undefined') {
        gsap.to(camera.position, {
            x: blueprintState.savedCameraPosition.x,
            y: blueprintState.savedCameraPosition.y,
            z: blueprintState.savedCameraPosition.z,
            duration: 0.5
        });
        showcase.yaw = blueprintState.savedShowcaseAngles.yaw;
        showcase.pitch = blueprintState.savedShowcaseAngles.pitch;
        applyShowcaseCameraRotation();
    }
    
    if (blueprintState.savedBackground) {
        scene.background = blueprintState.savedBackground;
    }

    const panel = document.getElementById('blueprint-editor-panel');
    const menuSections = document.querySelector('.viewer-menu-sections-card');
    const actorsMenu = document.querySelector('.viewer-menu-card:nth-child(2)');
    const cameraMenu = document.querySelector('.viewer-menu-card:first-child');
    const sceneUi = document.getElementById('scene-ui-panel');
    
    if (panel) {
        panel.style.display = 'none';
        if (menuSections) menuSections.style.display = 'block';
        if (actorsMenu) actorsMenu.style.display = 'block';
        if (cameraMenu) cameraMenu.style.display = 'block';
        if (sceneUi) sceneUi.style.display = 'flex';
    }
    
    const propId = objectScriptState.targetPropId;
    if (propId) {
        const prop = getDynamicPropById(propId);
        if (typeof transformControl !== 'undefined' && prop && getActorRenderObject(prop)) {
            transformControl.attach(getActorRenderObject(prop));
        }
        rebuildActorPhysics(prop);
    }
    
    refreshSceneUI();
}

function syncBlueprintColorPicker() {
    const picker = document.getElementById('bp-color-picker');
    if (!picker) return;
    const comp = blueprintState.selectedComponent;
    if (comp?.isMesh && comp.material) {
        const mat = Array.isArray(comp.material) ? comp.material[0] : comp.material;
        if (mat?.color) picker.value = '#' + mat.color.getHexString();
    }
}

function refreshBlueprintComponents() {
    updateBlueprintDetailsUI();
    syncBlueprintColorPicker();
    const container = document.getElementById('selected-actor-components');
    if (!container) return;
    container.innerHTML = '';
    
    const propId = objectScriptState.targetPropId;
    if (!propId) return;
    
    const prop = getDynamicPropById(propId);
    const rootMesh = getActorRenderObject(prop);
    if (!rootMesh) return;
    
    function renderComponentItem(object3D, depth, isRoot) {
        const item = document.createElement('div');
        item.style.padding = `4px 4px 4px ${4 + depth * 12}px`;
        item.style.cursor = 'pointer';
        item.style.borderRadius = '4px';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.justifyContent = 'space-between';
        item.style.background = blueprintState.selectedComponent === object3D ? 'rgba(112, 0, 255, 0.4)' : 'rgba(255,255,255,0.05)';
        item.style.border = blueprintState.selectedComponent === object3D ? '1px solid rgba(112, 0, 255, 0.8)' : '1px solid transparent';
        
        const label = document.createElement('span');
        let typeName = 'Mesh';
        if (isRoot) typeName = 'Root Mesh';
        else if (object3D.isPointLight) typeName = 'Point Light';
        else if (object3D.geometry?.type === 'BoxGeometry') typeName = 'Cube Component';
        else if (object3D.geometry?.type === 'SphereGeometry') typeName = 'Sphere Component';
        
        label.textContent = object3D.name || typeName;
        label.style.fontSize = '13px';
        item.appendChild(label);
        
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            blueprintState.selectedComponent = object3D;
            if (typeof transformControl !== 'undefined') transformControl.attach(object3D);
            refreshBlueprintComponents();
        });
        
        container.appendChild(item);
        
        for (const child of object3D.children) {
            if (child.isMesh || child.isLight) {
                renderComponentItem(child, depth + 1, false);
            }
        }
    }
    
    renderComponentItem(rootMesh, 0, true);
}

document.getElementById('btn-exit-blueprint')?.addEventListener('click', () => {
    exitBlueprintEditor();
});

document.getElementById('btn-edit-actor-script')?.addEventListener('click', () => {
    openObjectScriptEditor('tick');
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
    if (typeof transformControl !== 'undefined') transformControl.attach(mesh);
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
        if (typeof transformControl !== 'undefined') transformControl.attach(rootMesh);
        refreshBlueprintComponents();
    }
});

init();

// Blueprint Transform Controls
function updateBlueprintTransformUI() {
    if (!transformControl) return;
    
    const mode = transformControl.getMode();
    const space = transformControl.space;
    
    const btnTranslate = document.getElementById('btn-bp-translate');
    const btnRotate = document.getElementById('btn-bp-rotate');
    const btnScale = document.getElementById('btn-bp-scale');
    const btnLocal = document.getElementById('btn-bp-space-local');
    const btnWorld = document.getElementById('btn-bp-space-world');
    
    if (btnTranslate) btnTranslate.style.background = mode === 'translate' ? 'rgba(112,0,255,0.4)' : '';
    if (btnRotate) btnRotate.style.background = mode === 'rotate' ? 'rgba(112,0,255,0.4)' : '';
    if (btnScale) btnScale.style.background = mode === 'scale' ? 'rgba(112,0,255,0.4)' : '';
    
    if (btnLocal) btnLocal.style.background = space === 'local' ? 'rgba(112,0,255,0.4)' : '';
    if (btnWorld) btnWorld.style.background = space === 'world' ? 'rgba(112,0,255,0.4)' : '';
}

document.getElementById('btn-bp-translate')?.addEventListener('click', () => {
    if (typeof transformControl !== 'undefined') {
        transformControl.setMode('translate');
        updateBlueprintTransformUI();
    }
});
document.getElementById('btn-bp-rotate')?.addEventListener('click', () => {
    if (typeof transformControl !== 'undefined') {
        transformControl.setMode('rotate');
        updateBlueprintTransformUI();
    }
});
document.getElementById('btn-bp-scale')?.addEventListener('click', () => {
    if (typeof transformControl !== 'undefined') {
        transformControl.setMode('scale');
        updateBlueprintTransformUI();
    }
});
document.getElementById('btn-bp-space-local')?.addEventListener('click', () => {
    if (typeof transformControl !== 'undefined') {
        transformControl.setSpace('local');
        updateBlueprintTransformUI();
    }
});
document.getElementById('btn-bp-space-world')?.addEventListener('click', () => {
    if (typeof transformControl !== 'undefined') {
        transformControl.setSpace('world');
        updateBlueprintTransformUI();
    }
});

// Update UI initially if needed, we'll hook it up when blueprint mode opens

// Details Panel Sync
function updateBlueprintDetailsUI() {
    if (!blueprintState.active || !blueprintState.selectedComponent) return;
    const comp = blueprintState.selectedComponent;
    
    document.getElementById('bp-loc-x').value = comp.position.x.toFixed(3);
    document.getElementById('bp-loc-y').value = comp.position.y.toFixed(3);
    document.getElementById('bp-loc-z').value = comp.position.z.toFixed(3);
    
    document.getElementById('bp-rot-x').value = THREE.MathUtils.radToDeg(comp.rotation.x).toFixed(1);
    document.getElementById('bp-rot-y').value = THREE.MathUtils.radToDeg(comp.rotation.y).toFixed(1);
    document.getElementById('bp-rot-z').value = THREE.MathUtils.radToDeg(comp.rotation.z).toFixed(1);
    
    document.getElementById('bp-scl-x').value = comp.scale.x.toFixed(3);
    document.getElementById('bp-scl-y').value = comp.scale.y.toFixed(3);
    document.getElementById('bp-scl-z').value = comp.scale.z.toFixed(3);
}

function applyBlueprintDetailsFromUI() {
    if (!blueprintState.active || !blueprintState.selectedComponent) return;
    const comp = blueprintState.selectedComponent;
    
    comp.position.x = parseFloat(document.getElementById('bp-loc-x').value) || 0;
    comp.position.y = parseFloat(document.getElementById('bp-loc-y').value) || 0;
    comp.position.z = parseFloat(document.getElementById('bp-loc-z').value) || 0;
    
    comp.rotation.x = THREE.MathUtils.degToRad(parseFloat(document.getElementById('bp-rot-x').value) || 0);
    comp.rotation.y = THREE.MathUtils.degToRad(parseFloat(document.getElementById('bp-rot-y').value) || 0);
    comp.rotation.z = THREE.MathUtils.degToRad(parseFloat(document.getElementById('bp-rot-z').value) || 0);
    
    comp.scale.x = parseFloat(document.getElementById('bp-scl-x').value) || 1;
    comp.scale.y = parseFloat(document.getElementById('bp-scl-y').value) || 1;
    comp.scale.z = parseFloat(document.getElementById('bp-scl-z').value) || 1;
}

['bp-loc-x', 'bp-loc-y', 'bp-loc-z', 'bp-rot-x', 'bp-rot-y', 'bp-rot-z', 'bp-scl-x', 'bp-scl-y', 'bp-scl-z'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applyBlueprintDetailsFromUI);
});

// Blueprint panel: Save/Load Actor buttons
document.getElementById('btn-bp-apply-color')?.addEventListener('click', () => {
    const prop = getDynamicPropById(objectScriptState.targetPropId);
    if (!prop) return;
    const picker = document.getElementById('bp-color-picker');
    if (!picker) return;
    setActorColor(prop, picker.value);
});

document.getElementById('btn-bp-save-actor')?.addEventListener('click', () => {
    if (blueprintState.targetActor) {
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
let pieSceneSnapshot = null;

function snapshotSceneState() {
    if (!sceneSystem) return;

    pieSceneSnapshot = {
        activeActorId: objectScriptState.targetPropId || '',
        scene: exportWorldToJSON(),
    };
}

function restoreSceneState() {
    if (!pieSceneSnapshot || !sceneSystem) return;

    loadWorldFromJSON(pieSceneSnapshot.scene);

    if (pieSceneSnapshot.activeActorId) {
        selectShowcaseActor(pieSceneSnapshot.activeActorId);
    } else {
        selectShowcaseActor(null);
    }

    pieSceneSnapshot = null;
}

// === GLOBAL SERIALIZATION HELPER ===

function serializeComponentTree(object3D) {
    if (!object3D) return [];
    const comps = [];
    for (const child of object3D.children) {
        if (child.isMesh || child.isLight) {
            const entry = {
                type: child.isPointLight ? 'PointLight' : (child.geometry?.type || 'Mesh'),
                name: child.name,
                position: child.position.toArray(),
                quaternion: child.quaternion.toArray(),
                scale: child.scale.toArray(),
                children: serializeComponentTree(child)
            };
            if (child.isMesh && child.material) {
                entry.material = {
                    color: '#' + child.material.color.getHexString(),
                    roughness: child.material.roughness ?? 0.5,
                    metalness: child.material.metalness ?? 0.0
                };
            }
            if (child.isPointLight) {
                entry.light = {
                    color: '#' + child.color.getHexString(),
                    intensity: child.intensity,
                    distance: child.distance
                };
            }
            comps.push(entry);
        }
    }
    return comps;
}


function deserializeComponentTree(parent, comps) {
    if (!comps || !comps.length) return;
    comps.forEach((compData, index) => {
        const existing = parent.children[index];
        const existingMatches = existing && (existing.isMesh || existing.isLight);
        let comp = existingMatches ? existing : null;

        if (!comp) {
            if (compData.type === 'PointLight') {
                const lightColor = compData.light?.color ? new THREE.Color(compData.light.color) : 0xffddaa;
                const lightIntensity = compData.light?.intensity ?? 2;
                const lightDistance = compData.light?.distance ?? 10;
                comp = new THREE.PointLight(lightColor, lightIntensity, lightDistance);
                comp.castShadow = true;
            } else if (compData.type === 'BoxGeometry') {
                comp = buildPrimitiveActorMesh('cube');
            } else if (compData.type === 'SphereGeometry') {
                comp = buildPrimitiveActorMesh('sphere');
            }

            if (comp) {
                parent.add(comp);
            }
        }

        if (!comp) return;

        if (compData.name) comp.name = compData.name;
        if (Array.isArray(compData.position)) comp.position.fromArray(compData.position);
        if (Array.isArray(compData.quaternion)) comp.quaternion.fromArray(compData.quaternion);
        if (Array.isArray(compData.scale)) comp.scale.fromArray(compData.scale);

        if (comp.isMesh && compData.material) {
            applyObjectMaterialState(comp, compData.material);
        }
        if (comp.isPointLight && compData.light) {
            if (compData.light.color) comp.color = new THREE.Color(compData.light.color);
            if (Number.isFinite(compData.light.intensity)) comp.intensity = compData.light.intensity;
            if (Number.isFinite(compData.light.distance)) comp.distance = compData.light.distance;
        }

        deserializeComponentTree(comp, compData.children);
    });
}


let editorClipboard = null;

function serializeActorToJSON(actor) {
    return serializeActorData(actor);
}

function spawnActorFromJSON(actorData) {
    const actor = spawnActorFromSerializedData(actorData);
    if (actor) {
        saveObjectScriptDrafts();
        refreshSceneUI();
        selectShowcaseActor(actor.id);
    }
    return actor;
}

function deleteSelectedActor() {
    editorHistory.captureState();
    const propId = objectScriptState.targetPropId;
    if (!propId) return;
    const prop = getDynamicPropById(propId);
    if (!prop) return;
    const body = getActorBody(prop);
    if (body && physics.bodyInterface) {
        physics.bodyInterface.RemoveBody(body.GetID());
        physics.bodyInterface.DestroyBody(body.GetID());
    }
    const mesh = getActorRenderObject(prop);
    if (mesh) scene.remove(mesh);
    sceneSystem.actors.delete(prop);
    if (transformControl) transformControl.detach();
    selectShowcaseActor(null);
    refreshSceneUI();
}

function copySelectedToClipboard() {
    if (blueprintState.active) {
        const comp = blueprintState.selectedComponent;
        const rootMesh = getActorRenderObject(getDynamicPropById(objectScriptState.targetPropId));
        if (!comp || comp === rootMesh) return;
        // Mock a root to serialize just the child
        const mockParent = { children: [comp] };
        editorClipboard = { type: 'component', data: serializeComponentTree(mockParent)[0] };
    } else {
        const propId = objectScriptState.targetPropId;
        if (!propId) return;
        const actor = getDynamicPropById(propId);
        if (!actor) return;
        editorClipboard = { type: 'actor', data: serializeActorToJSON(actor) };
    }
}

function pasteFromClipboard() {
    editorHistory.captureState();
    if (!editorClipboard) return;
    if (blueprintState.active && editorClipboard.type === 'component') {
        const parent = blueprintState.selectedComponent || getActorRenderObject(getDynamicPropById(objectScriptState.targetPropId));
        if (!parent) return;
        const compData = JSON.parse(JSON.stringify(editorClipboard.data));
        // Add slight offset so it doesn't overlap exactly
        compData.position[1] += 0.5;
        deserializeComponentTree(parent, [compData]);
        refreshBlueprintComponents();
    } else if (!blueprintState.active && editorClipboard.type === 'actor') {
        const actorData = JSON.parse(JSON.stringify(editorClipboard.data));
        actorData.transform.position[1] += 1;
        actorData.transform.position[0] += 1;
        actorData.name += ' (Copy)';
        spawnActorFromJSON(actorData);
    }
}

function duplicateSelected() {
    copySelectedToClipboard();
    editorHistory.captureState();
    pasteFromClipboard();
}

// === UNDO / REDO HISTORY SYSTEM ===
const editorHistory = {
    undoStack: [],
    redoStack: [],
    maxStates: 50,
    isRestoring: false,

    captureState() {
        if (this.isRestoring || (typeof gameplay !== 'undefined' && gameplay.active)) return;
        const state = {
            activeActorId: objectScriptState.targetPropId,
            blueprintActive: blueprintState.active,
            blueprintComponentUuid: blueprintState.selectedComponent?.uuid,
            scene: exportWorldToJSON()
        };
        this.undoStack.push(state);
        if (this.undoStack.length > this.maxStates) {
            this.undoStack.shift();
        }
        this.redoStack = [];
    },

    undo() {
        if (this.undoStack.length === 0 || (typeof gameplay !== 'undefined' && gameplay.active)) return;
        this.isRestoring = true;
        
        const currentState = {
            activeActorId: objectScriptState.targetPropId,
            blueprintActive: blueprintState.active,
            blueprintComponentUuid: blueprintState.selectedComponent?.uuid,
            scene: exportWorldToJSON()
        };
        this.redoStack.push(currentState);
        
        const state = this.undoStack.pop();
        this.restoreState(state);
        this.isRestoring = false;
    },

    redo() {
        if (this.redoStack.length === 0 || (typeof gameplay !== 'undefined' && gameplay.active)) return;
        this.isRestoring = true;

        const currentState = {
            activeActorId: objectScriptState.targetPropId,
            blueprintActive: blueprintState.active,
            blueprintComponentUuid: blueprintState.selectedComponent?.uuid,
            scene: exportWorldToJSON()
        };
        this.undoStack.push(currentState);
        
        const state = this.redoStack.pop();
        this.restoreState(state);
        this.isRestoring = false;
    },

    restoreState(state) {
        if (typeof transformControl !== 'undefined' && transformControl) transformControl.detach();
        loadWorldFromJSON(state.scene);
        
        if (state.activeActorId) {
            selectShowcaseActor(state.activeActorId);
            if (state.blueprintActive) {
                enterBlueprintEditor();
            } else {
                exitBlueprintEditor();
            }
        } else {
            selectShowcaseActor(null);
            exitBlueprintEditor();
        }
    }
};

function exportWorldToJSON() {
    const umap = { version: 2, actors: [], importedTemplates: [] };
    const usedTemplateIds = new Set();
    for (const actor of (sceneSystem?.actors || [])) {
        const serializedActor = serializeActorData(actor);
        if (!serializedActor) continue;
        umap.actors.push(serializedActor);
        if (serializedActor.kind === 'imported' && serializedActor.templateId) {
            usedTemplateIds.add(serializedActor.templateId);
        }
        if (serializedActor.kind === 'vehicle' && serializedActor.vehicleBodyTemplateId) {
            usedTemplateIds.add(serializedActor.vehicleBodyTemplateId);
        }
        if (serializedActor.kind === 'vehicle' && serializedActor.vehicleWheelTemplateId) {
            usedTemplateIds.add(serializedActor.vehicleWheelTemplateId);
        }
    }

    usedTemplateIds.forEach((templateId) => {
        const template = importedPropState.templates.find((entry) => entry.id === templateId);
        const serializedTemplate = serializeImportedPropTemplate(template);
        if (serializedTemplate) {
            umap.importedTemplates.push(serializedTemplate);
        }
    });

    if (umap.importedTemplates.length === 0) {
        delete umap.importedTemplates;
    }

    return umap;
}

function loadWorldFromJSON(umap) {
    if (umap.version !== 1 && umap.version !== 2) console.warn('Unknown umap version', umap.version);
    clearSceneActors();

    if (Array.isArray(umap.importedTemplates)) {
        umap.importedTemplates.forEach((templateData) => {
            try {
                registerImportedPropTemplateFromSerializedData(templateData);
            } catch (error) {
                console.error('Failed to restore imported template from .umap.', error, templateData);
            }
        });
    }

    for (const actorData of umap.actors) {
        spawnActorFromSerializedData(actorData, { preserveId: true });
    }
    saveObjectScriptDrafts();
    refreshSceneUI();
}
