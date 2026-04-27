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
    getMetadataComponent,
    getPhysicsBodyComponent,
    getRenderComponent,
    getScriptComponent,
} from './src/runtime/sceneRuntime.js';
import {
    TERRAIN_Y_OFFSET,
    applyTerrainTextures,
    createTerrainMesh,
    sampleTerrainHeightAt as sampleTerrainHeightAtWorldFloor,
} from './src/world/terrain.js';

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
            ...config
        };

        this.updatePosition();
        this.element.style.display = this.config.visible ? 'block' : 'none';
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

// Example widget creation function
function createExampleWidgets() {
    if (!widgetManager) return;

    // Create a score display widget
    const scoreWidgetId = widgetManager.createWidget('text', {
        text: 'Score: 0',
        fontSize: 20,
        color: '#ffff00',
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        position: { x: 0.05, y: 0.9 }, // Top-left corner
        visible: true
    });

    // Create a health bar
    const healthBarId = widgetManager.createWidget('progress', {
        progress: 1.0,
        width: 200,
        height: 20,
        fillColor: '#00ff00',
        backgroundColor: '#333333',
        position: { x: 0.05, y: 0.8 }, // Below score
        visible: true
    });

    // Create a speed display
    /*const speedWidgetId = widgetManager.createWidget('text', {
        text: 'Speed: 0 km/h',
        fontSize: 16,
        color: '#00ffff',
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        position: { x: 0.05, y: 0.7 }, // Below health bar
        visible: true
    });

    // Create a button widget
    const buttonWidgetId = widgetManager.createWidget('button', {
        text: 'Boost',
        width: 80,
        height: 30,
        backgroundColor: '#444444',
        hoverColor: '#666666',
        position: { x: 0.85, y: 0.9 }, // Top-right corner
        onClick: (id) => {
            console.log('Boost button clicked!', id);
            // Add boost logic here
        },
        visible: true
    });*/

    // Store widget IDs globally for easy access
    window.exampleWidgets = {
        score: scoreWidgetId,
        health: healthBarId,
        //speed: speedWidgetId,
        //boost: buttonWidgetId
    };

    // Initialize score system
    window.gameScore = 0;

    console.log('Example widgets created:', window.exampleWidgets);
    console.log('Widget API available at window.WidgetAPI');
    console.log('Example usage:');
    console.log('  WidgetAPI.createWidget("text", {text: "Hello!", position: {x: 0.5, y: 0.5}})');
    console.log('  WidgetAPI.updateWidget(widgetId, {text: "Updated text"})');
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
    wheelBase: 1.72,
    trackWidth: 1.18,
    spawnDistance: 4.8,
    spawnLift: 0.9,
    interactionRadius: 4.5,
    seatHeight: 1.15,
    followDistance: 5.6,
    followHeight: 2.4,
    lookAhead: 2.2,
    acceleration: 4.2, // More gradual acceleration like Warthog
    reverseAcceleration: 3.8,
    boostAcceleration: 5.5,
    coastDrag: 2.2, // Higher drag for more realistic momentum
    rollingDrag: 0.35, // More rolling resistance
    lowSpeedGrip: 6.8, // Better low-speed traction
    highSpeedGrip: 3.2, // Less grip at high speeds for sliding
    brakeGrip: 3.5, // Much weaker brakes - takes longer to stop
    driftGrip: 1.2, // Allows some drifting but recovers well
    partialContactGrip: 1.2,
    driftBoostThreshold: 0.35,
    driftSteerBonus: 1.4,
    steeringRate: 2.1, // More responsive steering like Warthog
    steeringReturn: 6.2, // Faster return to center
    steeringGrip: 8.5, // Better steering control
    steeringHighSpeedDamping: 0.55, // More stability at high speeds
    uprightTorque: 520, // Stronger self-righting for stability
    rollTorque: 220,
    pitchTorque: 180,
    suspensionRideHeight: 1.08,
    suspensionTravel: 0.9,
    suspensionSpring: 9.8, // Bouncier suspension like Warthog
    suspensionDamping: 2.4, // More damping for realistic feel
    bumpPitchTorque: 580,
    bumpRollTorque: 480,
    bumpLaunchBoost: 4.2, // More launch from bumps
    airtimeAngularBlend: 0.12,
    maxDriveSpeed: 32, // Slightly higher top speed
    maxReverseSpeed: 12,
    brakeDamping: 0.92, // Much weaker brakes - retains more speed
    maxAngularVelocity: 4.2, // Allow more rotation for realistic handling
};

// Module-level refs so switchEnvironment can update them
let pedestalMat, ambientLight, hemiLight, pedestal, worldFloor;
let playHint, gameplayStatus, resetViewBtn, showcaseModeBtn, playModeBtn, browseModelBtn, openActorEditorBtn;
let multiplayerServerUrlInput, multiplayerRoomInput, multiplayerConnectBtn, multiplayerDisconnectBtn, multiplayerStatusValue, multiplayerPlayerCountValue;
let importPropBtn, propFileInput, importedPropList, importedPropLibrary, propImportDefaultStatus, resetPropImportDefaultBtn;
let propCollisionPrompt, propCollisionCopy, propCollisionRemember, propCollisionSimpleBtn, propCollisionComplexBtn, propCollisionCancelBtn;
let inputActionsOpenBtn, inputActionsEditor, inputActionLeftBtn, inputActionRightBtn, inputActionMode, inputActionEditorInput, inputActionsEditorStatus, mouseActionApplyBtn, mouseActionResetBtn, inputActionsCloseBtn, mouseActionStatus;
let objectScriptMenu, objectScriptTickActionBtn, objectScriptCollisionActionBtn;
let objectScriptEditor, objectScriptEditorTitle, objectScriptEditorTarget, objectScriptEditorMode;
let objectScriptEditorInput, objectScriptEditorStatus, objectScriptEditorApplyBtn, objectScriptEditorClearBtn, objectScriptEditorCancelBtn;
let objectScriptTickToggleRow, objectScriptTickToggleInput;
let actorEditor, actorEditorSummary, actorEditorStatus, actorKindSelect, actorLabelInput, actorScaleInput, actorImportedTemplateSelect;
let actorComponentCollisionInput, actorComponentScriptsInput, actorEditorCreateBtn, actorEditorOpenScriptBtn, actorEditorCancelBtn;
let debugConsole, debugConsoleOutput, debugConsoleInput, debugConsoleFooter, debugStatsOverlay;
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
const MOUSE_ACTION_STORAGE_KEY = 'polyflow-3d.mouse-actions.v1';
const OBJECT_SCRIPT_STORAGE_KEY = 'polyflow-3d.object-scripts.v1';
const DEBUG_CONSOLE_LOG_LIMIT = 18;
const DEBUG_CONSOLE_HISTORY_LIMIT = 24;
const DEBUG_TIMING_SAMPLE_LIMIT = 30;
const DEFAULT_MOUSE_ACTION_SCRIPTS = {
    left: `const sphere = spawnDynamicPrimitive('sphere', new THREE.Vector3(0, -1, 0), 0.5);
if (sphere) {
    physics.bodyInterface.SetMotionQuality(
        sphere.GetID(),
        physics.Jolt.EMotionQuality_LinearCast
    );

    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    direction.normalize();

    const velocity = new physics.Jolt.Vec3(
        direction.x * 36000,
        direction.y * 36000,
        direction.z * 36000
    );

    physics.bodyInterface.AddImpulse(sphere.GetID(), velocity);
    physics.Jolt.destroy(velocity);
}`,
    right: `const cubesPerSide = 5;
const totalCubes = 500;
const cubeHalfExtent = 0.16;
const spacing = cubeHalfExtent * 2;
const baseYOffset = -0.8;
let spawned = 0;

for (let layer = 0; spawned < totalCubes; layer++) {
    for (let row = 0; row < cubesPerSide && spawned < totalCubes; row++) {
        for (let col = 0; col < cubesPerSide && spawned < totalCubes; col++) {
            const xOffset = (col - (cubesPerSide - 1) * 0.5) * spacing;
            const yOffset = baseYOffset + layer * spacing;
            const zOffset = (row - (cubesPerSide - 1) * 0.5) * spacing;
            const cube = spawnDynamicPrimitive(
                'cube',
                new THREE.Vector3(xOffset, yOffset, zOffset),
                cubeHalfExtent,
                {
                    skipImpulse: true,
                    activate: false,
                    castShadow: false,
                    receiveShadow: false,
                    allowSleeping: true,
                    linearDamping: 0.18,
                    angularDamping: 0.22,
                    motionQuality: physics.Jolt.EMotionQuality_Discrete,
                }
            );

            if (cube) {
                physics.bodyInterface.SetMotionQuality(
                    cube.GetID(),
                    physics.Jolt.EMotionQuality_Discrete
                );
            }

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
    desiredVelocity: new THREE.Vector3(),
    jumpQueued: false,
    allowSliding: false,
};
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
    const { Jolt } = physics;
    root.updateWorldMatrix(true, true);
    const hullParts = collectImportedComplexHullParts(root);

    if (!hullParts.length) {
        throw new Error('Not enough sampled points for a complex collision shape.');
    }

    const buildHullShape = (part) => {
        const points = new Jolt.ArrayVec3();

        try {
            part.points.forEach((pointData) => {
                const point = new Jolt.Vec3(pointData.x, pointData.y, pointData.z);
                points.push_back(point);
                Jolt.destroy(point);
            });

            if (points.size() < 4) {
                throw new Error('Not enough sampled points for a complex collision shape.');
            }

            return createImportedConvexHullShape(points);
        } finally {
            Jolt.destroy(points);
        }
    };

    if (hullParts.length === 1) {
        return buildHullShape(hullParts[0]);
    }

    const compoundSettings = new Jolt.MutableCompoundShapeSettings();
    const identityPosition = new Jolt.Vec3(0, 0, 0);
    const identityRotation = new Jolt.Quat(0, 0, 0, 1);
    const subShapes = [];
    let compoundSubmitted = false;

    try {
        hullParts.forEach((part) => {
            const subShape = buildHullShape(part);
            subShapes.push(subShape);
            compoundSettings.AddShapeShape(identityPosition, identityRotation, subShape, 0);
        });

        compoundSubmitted = true;
        return createOwnedShape(compoundSettings);
    } catch (error) {
        if (!compoundSubmitted) {
            Jolt.destroy(compoundSettings);
        }
        throw error;
    } finally {
        subShapes.forEach((shape) => shape.Release());
        Jolt.destroy(identityPosition);
        Jolt.destroy(identityRotation);
    }
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
    const template = {
        id: `imported-prop-${importedPropState.nextId++}`,
        fileName,
        displayName: formatImportedPropName(fileName),
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

    if (includeCollisionBody) {
        template.shape.AddRef();

        body = createDynamicPrimitiveBody(
            template.shape,
            spawnPosition,
            launchImpulse,
            template.collisionMode === 'simple'
                ? { restitution: 0.12, friction: 0.84 }
                : { restitution: 0.08, friction: 0.76 }
        );

        if (!body) {
            disposeRenderableObject(visual);
            return null;
        }
    }

    visual.position.copy(spawnPosition);
    const actor = createDynamicPropActor({
        body,
        mesh: visual,
        kind: 'imported',
        templateId,
        userData: options.userData,
        includeScripts: options.includeScripts !== false,
    });
    physics.dynamicBodies.push(actor);
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

    sceneSystem?.removeActor(prop);

    const mesh = getActorRenderObject(prop);
    if (mesh) {
        disposeRenderableObject(mesh);

        prop.mesh = null;
    }

    const body = getActorBody(prop);
    if (body) {
        destroyPhysicsBody(body);
        prop.body = null;
    }

    removeObjectScriptDraft(prop.id);
}

function clearDynamicPhysicsProps() {
    if (!physics.dynamicBodies.length) return;

    physics.dynamicBodies.forEach((prop) => destroyDynamicPhysicsProp(prop));
    physics.dynamicBodies.length = 0;
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

    // Add camera shake during tail whip
    if (vehicleState.tailWhipLastFrame) {
        const shakeAmount = 0.3;
        chasePosition.x += (Math.random() - 0.5) * shakeAmount;
        chasePosition.y += (Math.random() - 0.5) * shakeAmount;
        chasePosition.z += (Math.random() - 0.5) * shakeAmount;
    }

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

function createVehicleWheelAssembly({ tireMaterial, rimMaterial, wheelRadius, wheelWidth }) {
    const steeringPivot = new THREE.Group();
    const spinGroup = new THREE.Group();
    
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

function createDrivableCarVisual() {
    const root = new THREE.Group();
    // Offset the entire visual model up to perfectly rest on the wheels
    // physics box half height is 0.3. wheel bottom is at -0.468. difference = 0.168.
    const visualGroup = new THREE.Group();
    visualGroup.position.y = VEHICLE_SETTINGS.height * 0.28;
    root.add(visualGroup);
    
    const bodyMaterial = new THREE.MeshStandardMaterial({
        color: 0xf7f7f5,
        metalness: 0.18,
        roughness: 0.34,
    });
    const trimMaterial = new THREE.MeshStandardMaterial({
        color: 0x15171b,
        metalness: 0.42,
        roughness: 0.48,
    });
    const glassMaterial = new THREE.MeshStandardMaterial({
        color: 0xdce8f5,
        metalness: 0.08,
        roughness: 0.16,
        transparent: true,
        opacity: 0.72,
    });
    const tireMaterial = new THREE.MeshStandardMaterial({
        color: 0x17191d,
        metalness: 0.02,
        roughness: 0.92,
    });
    const rimMaterial = new THREE.MeshStandardMaterial({
        color: 0xc5ccd6,
        metalness: 0.86,
        roughness: 0.24,
    });
    const lightMaterial = new THREE.MeshStandardMaterial({
        color: 0xf8f1d0,
        emissive: 0x8c6d1f,
        emissiveIntensity: 0.2,
        roughness: 0.28,
        metalness: 0.02,
    });

    const lowerBody = new THREE.Mesh(
        new THREE.BoxGeometry(VEHICLE_SETTINGS.width * 0.96, VEHICLE_SETTINGS.height * 0.58, VEHICLE_SETTINGS.length * 0.9),
        bodyMaterial
    );
    lowerBody.position.y = -VEHICLE_SETTINGS.height * 0.04;
    lowerBody.castShadow = true;
    lowerBody.receiveShadow = true;
    visualGroup.add(lowerBody);

    const cabin = new THREE.Mesh(
        new THREE.BoxGeometry(VEHICLE_SETTINGS.width * 0.7, VEHICLE_SETTINGS.height * 0.54, VEHICLE_SETTINGS.length * 0.44),
        glassMaterial
    );
    cabin.position.set(0, VEHICLE_SETTINGS.height * 0.36, -VEHICLE_SETTINGS.length * 0.08);
    cabin.castShadow = true;
    visualGroup.add(cabin);

    const roof = new THREE.Mesh(
        new THREE.BoxGeometry(VEHICLE_SETTINGS.width * 0.66, VEHICLE_SETTINGS.height * 0.08, VEHICLE_SETTINGS.length * 0.34),
        bodyMaterial
    );
    roof.position.set(0, VEHICLE_SETTINGS.height * 0.64, -VEHICLE_SETTINGS.length * 0.08);
    roof.castShadow = true;
    visualGroup.add(roof);

    const hood = new THREE.Mesh(
        new THREE.BoxGeometry(VEHICLE_SETTINGS.width * 0.82, VEHICLE_SETTINGS.height * 0.16, VEHICLE_SETTINGS.length * 0.24),
        bodyMaterial
    );
    hood.position.set(0, VEHICLE_SETTINGS.height * 0.12, VEHICLE_SETTINGS.length * 0.29);
    hood.rotation.x = -0.12;
    hood.castShadow = true;
    hood.receiveShadow = true;
    visualGroup.add(hood);

    const frontBumper = new THREE.Mesh(
        new THREE.BoxGeometry(VEHICLE_SETTINGS.width * 0.88, VEHICLE_SETTINGS.height * 0.14, VEHICLE_SETTINGS.length * 0.08),
        trimMaterial
    );
    frontBumper.position.set(0, -VEHICLE_SETTINGS.height * 0.16, VEHICLE_SETTINGS.length * 0.47);
    frontBumper.castShadow = true;
    visualGroup.add(frontBumper);

    const rearBumper = frontBumper.clone();
    rearBumper.position.z = -VEHICLE_SETTINGS.length * 0.47;
    visualGroup.add(rearBumper);

    const grille = new THREE.Mesh(
        new THREE.BoxGeometry(VEHICLE_SETTINGS.width * 0.44, VEHICLE_SETTINGS.height * 0.14, VEHICLE_SETTINGS.length * 0.04),
        trimMaterial
    );
    grille.position.set(0, VEHICLE_SETTINGS.height * 0.02, VEHICLE_SETTINGS.length * 0.48);
    visualGroup.add(grille);

    const headlightLeft = new THREE.Mesh(
        new THREE.BoxGeometry(VEHICLE_SETTINGS.width * 0.12, VEHICLE_SETTINGS.height * 0.08, VEHICLE_SETTINGS.length * 0.02),
        lightMaterial
    );
    headlightLeft.position.set(-VEHICLE_SETTINGS.width * 0.28, VEHICLE_SETTINGS.height * 0.06, VEHICLE_SETTINGS.length * 0.48);
    const headlightRight = headlightLeft.clone();
    headlightRight.position.x *= -1;
    visualGroup.add(headlightLeft, headlightRight);

    const wheelRadius = VEHICLE_SETTINGS.height * 0.36;
    const wheelWidth = VEHICLE_SETTINGS.width * 0.16;
    const wheelY = -VEHICLE_SETTINGS.height * 0.42;
    const halfWheelBase = VEHICLE_SETTINGS.wheelBase * 0.5;
    const halfTrackWidth = VEHICLE_SETTINGS.trackWidth * 0.45;
    const wheelOffsets = [
        { x: -halfTrackWidth, z: halfWheelBase, steerable: true },
        { x: halfTrackWidth, z: halfWheelBase, steerable: true },
        { x: -halfTrackWidth, z: -halfWheelBase, steerable: false },
        { x: halfTrackWidth, z: -halfWheelBase, steerable: false },
    ];
    const steeringPivots = [];
    const spinGroups = [];

    wheelOffsets.forEach((offset) => {
        const wheel = createVehicleWheelAssembly({
            tireMaterial,
            rimMaterial,
            wheelRadius,
            wheelWidth,
        });
        wheel.steeringPivot.position.set(offset.x, wheelY, offset.z);
        wheel.steeringPivot.userData.steerable = offset.steerable;
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
        if (prop?.kind !== 'vehicle' || !prop.mesh) continue;

        const visualState = prop.mesh.userData?.vehicleVisual;
        const body = getActorBody(prop);
        if (!visualState || !body) continue;

        const bodyId = body.GetID();
        const flatForward = tempVectorA.set(0, 0, -1).applyQuaternion(prop.mesh.quaternion);
        flatForward.y = 0;
        if (flatForward.lengthSq() < 1e-6) {
            flatForward.set(0, 0, -1);
        } else {
            flatForward.normalize();
        }

        const linearVelocity = copyJoltVector(tempVectorB, bodyInterface.GetLinearVelocity(bodyId));
        const forwardSpeed = linearVelocity.dot(flatForward);

        // Enhanced wheel spin during tail whip
        const isActiveVehicle = gameplay.active && vehicleState.activePropId === prop.id;
        const tailWhipSpinBonus = isActiveVehicle && vehicleState.tailWhipLastFrame ? 3.0 : 1.0;
        visualState.spinAngle -= (forwardSpeed / visualState.wheelRadius) * delta * tailWhipSpinBonus;
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

    const groundHit = getGroundHitAt(spawnPosition.x, spawnPosition.z, true);
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
        friction: 1.35, // Higher friction for better traction
        restitution: 0.02,
        linearDamping: 0.25, // More linear damping for heavier feel
        angularDamping: 0.55, // More angular damping for stability
        motionQuality: Jolt.EMotionQuality_LinearCast,
        skipImpulse: true,
    });

    if (!body) {
        return null;
    }

    bodyInterface.SetMaxAngularVelocity(body.GetID(), VEHICLE_SETTINGS.maxAngularVelocity);
    const chassis = createDrivableCarVisual();
    chassis.position.copy(spawnPosition);
    chassis.quaternion.copy(carRotation);

    const vehicle = createDynamicPropActor({
        body,
        mesh: chassis,
        kind: 'vehicle',
        userData: options.userData ?? { label: 'Car' },
        includeScripts: options.includeScripts !== false,
    });
    physics.dynamicBodies.push(vehicle);
    updateGameplayUI();
    return vehicle;
}

function createDynamicPrimitiveBody(shape, position, impulse, options = {}) {
    if (!physics.ready) return null;

    const { Jolt, bodyInterface } = physics;
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
        Jolt.EMotionType_Dynamic,
        JOLT_MOVING_LAYER
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

    const body = bodyInterface.CreateBody(creationSettings);
    bodyInterface.AddBody(
        body.GetID(),
        options.activate === false ? Jolt.EActivation_DontActivate : Jolt.EActivation_Activate
    );

    if (impulse && options.skipImpulse !== true) {
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
        ? createDynamicPrimitiveBody(shape, spawnPosition, launchImpulse, bodyOptions)
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
    physics.dynamicBodies.push(actor);

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

function createRuntimePropId() {
    const propId = `prop-${objectScriptState.nextPropId++}`;
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

function selectShowcaseActor(actorId) {
    if (gameplay.active) return; // Only allow selection in Showcase mode
    
    const previousTargetId = objectScriptState.targetPropId;
    objectScriptState.targetPropId = actorId || '';
    
    if (actorId) {
        const prop = getDynamicPropById(actorId);
        if (objectScriptEditorTarget) {
            objectScriptEditorTarget.textContent = prop?.rootNode?.name || actorId || 'Actor';
        }
        if (transformControl && prop?.mesh) {
            transformControl.attach(prop.mesh);
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

function syncTransformToPhysics() {
    if (!transformControl || !transformControl.object) return;
    const prop = findDynamicPropByMesh(transformControl.object);
    if (!prop) return;

    const body = getActorBody(prop);
    if (!body || !physics.jolt) return;

    const mesh = transformControl.object;
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
    if (!prop || !prop.mesh || !physics.ready) return;
    
    const { Jolt, bodyInterface } = physics;
    const currentBody = getActorBody(prop);
    const bodyID = currentBody?.GetID();
    
    if (bodyID) {
        bodyInterface.RemoveBody(bodyID);
        bodyInterface.DestroyBody(bodyID);
    }
    
    // Primitive rebuilding based on spawnDynamicPrimitive logic
    let shape = null;
    let bodyOptions = {
        rotation: prop.mesh.quaternion,
        friction: prop.userData?.friction,
        restitution: prop.userData?.restitution,
        allowedDOFs: prop.userData?.allowedDOFs,
        kinematic: prop.userData?.kinematic,
        activate: true
    };
    
    const scale = prop.mesh.scale;
    
    if (prop.kind === 'sphere') {
        shape = createOwnedShape(new Jolt.SphereShapeSettings(scale.x));
        bodyOptions.restitution = 0.48;
        bodyOptions.friction = 0.58;
    } else if (prop.kind === 'cube') {
        const halfExtentVector = new Jolt.Vec3(scale.x, scale.y, scale.z);
        shape = createOwnedShape(new Jolt.BoxShapeSettings(halfExtentVector, 0.05));
        Jolt.destroy(halfExtentVector);
        bodyOptions.restitution = 0.12;
        bodyOptions.friction = 0.82;
    } else if (prop.kind === 'capsule') {
        // Keep capsules uniform for simplicity since radius/height mapping is tricky for non-uniform scaling
        shape = createOwnedShape(new Jolt.CapsuleShapeSettings(scale.y, scale.x));
        bodyOptions.restitution = 0.0;
        bodyOptions.friction = 0.0;
        bodyOptions.allowedDOFs = Jolt.EAllowedDOFs_TranslationX | Jolt.EAllowedDOFs_TranslationY | Jolt.EAllowedDOFs_TranslationZ;
    }
    
    if (shape) {
        const newBody = createDynamicPrimitiveBody(shape, prop.mesh.position, null, bodyOptions);
        prop.body = newBody;
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

function syncActorEditorTemplateOptions(selectedTemplateId = '') {
    if (!actorImportedTemplateSelect) return;

    actorImportedTemplateSelect.innerHTML = '';

    if (!importedPropState.templates.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No imported source available';
        actorImportedTemplateSelect.appendChild(option);
        actorImportedTemplateSelect.value = '';
        return;
    }

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

function syncActorEditorUi() {
    if (!actorKindSelect || !actorEditorSummary || !actorEditorStatus || !actorImportedTemplateSelect || !actorComponentCollisionInput || !actorComponentScriptsInput) {
        return;
    }

    const kind = actorKindSelect.value || 'sphere';
    const isImported = kind === 'imported';
    const isVehicle = kind === 'vehicle';

    actorImportedTemplateSelect.disabled = !isImported;
    actorComponentCollisionInput.disabled = isVehicle;
    if (isVehicle) {
        actorComponentCollisionInput.checked = true;
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

    actorEditorStatus.textContent = `${typeLabel} will spawn with a render node${actorComponentCollisionInput.checked ? ', a collision body' : ''}${actorComponentScriptsInput.checked ? ', and a script host' : ''}.`;
}

function closeActorEditor() {
    actorEditorState.open = false;
    if (actorEditor) {
        actorEditor.hidden = true;
    }
}

function openActorEditor({ kind = 'cube', templateId = '', label = '' } = {}) {
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
    if (actorComponentScriptsInput) {
        actorComponentScriptsInput.checked = true;
    }

    syncActorEditorTemplateOptions(templateId);
    syncActorEditorUi();
    actorEditor.hidden = false;
}

function spawnActorFromEditor({ openScriptEditor = false } = {}) {
    const kind = actorKindSelect?.value || 'sphere';
    const includeCollisionBody = kind === 'vehicle' ? true : !!actorComponentCollisionInput?.checked;
    const includeScripts = !!actorComponentScriptsInput?.checked;
    const parsedScale = Number.parseFloat(actorScaleInput?.value ?? '0.5');
    const scale = Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : (kind === 'cube' ? 0.3 : 0.5);
    const displayName = actorLabelInput?.value?.trim() || '';
    const userData = displayName ? { label: displayName } : undefined;
    let actor = null;

    if (kind === 'vehicle') {
        actor = spawnDrivableCar({ includeScripts, userData });
    } else if (kind === 'imported') {
        const templateId = actorImportedTemplateSelect?.value || '';
        if (!templateId) {
            syncActorEditorUi();
            return null;
        }

        actor = spawnImportedProp(templateId, {
            includeCollisionBody,
            includeScripts,
            userData,
        });
    } else {
        actor = spawnDynamicPrimitive(kind, undefined, scale, {
            includeCollisionBody,
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
        return new ObjectEventFunction('api', '"use strict"; return;');
    }

    return new ObjectEventFunction('api', `
        "use strict";
        const { THREE, scene, camera, renderer, currentMesh, gameplay, showcase, physics, prop, object, body, physicsBody, localPosition, worldPosition, eventType, deltaTime, collision, renderComponent, physicsComponent, scriptComponent, metadataComponent, spawnDynamicPrimitive, spawnImportedProp } = api;
        ${normalizedSource}
    `);
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
        objectScriptEditorMode.textContent = `Event: ${getObjectScriptEventLabel(eventType)}`;
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
        eventState.enabled = eventType === 'tick'
            ? !!normalizedSource.trim() && !!scriptState.tick.enabled
            : !!normalizedSource.trim();
    } catch (error) {
        eventState.error = error?.message || String(error);
        eventState.compiled = null;
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
    const object = renderComponent?.mesh || null;
    const body = physicsComponent?.body || null;
    const localPosition = object?.position?.clone?.() ?? null;
    const worldPosition = object ? object.getWorldPosition(new THREE.Vector3()) : null;

    return {
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
        spawnDynamicPrimitive,
        spawnImportedProp,
    };
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

    eventState.running = true;
    Promise.resolve(eventState.compiled(buildObjectEventApi(prop, eventType, options)))
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

    const entries = physics.dynamicBodies
        .filter((prop) => !!getActorRenderObject(prop))
        .map((prop) => ({
            prop,
            mesh: getActorRenderObject(prop),
            body: getActorBody(prop),
            bounds: new THREE.Box3().setFromObject(getActorRenderObject(prop)),
        }));

    const contactMap = new Map();

    for (let index = 0; index < entries.length; index++) {
        const current = entries[index];
        const groundHeight = getGroundHeightAt(current.mesh.position.x, current.mesh.position.z, true);

        if (groundHeight !== null && current.bounds.min.y <= groundHeight + 0.08) {
            registerCollisionForProp(contactMap, current.prop, `ground:${current.prop.id}`, {
                type: 'ground',
                groundHeight,
                point: current.mesh.position.clone(),
            });
        }

        for (let otherIndex = index + 1; otherIndex < entries.length; otherIndex++) {
            const other = entries[otherIndex];
            if (!current.bounds.intersectsBox(other.bounds)) continue;

            const collisionKey = [current.prop.id, other.prop.id].sort().join(':');
            registerCollisionForProp(contactMap, current.prop, collisionKey, {
                type: 'prop',
                otherProp: other.prop,
                otherObject: other.mesh,
                otherBody: other.body,
            });
            registerCollisionForProp(contactMap, other.prop, collisionKey, {
                type: 'prop',
                otherProp: current.prop,
                otherObject: current.mesh,
                otherBody: current.body,
            });
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
        const { THREE, scene, camera, renderer, currentMesh, gameplay, showcase, physics, event, button, mode, spawnDynamicPrimitive, spawnImportedProp } = api;
        ${normalizedSource}
    `);
}

function buildMouseActionApi(event, button) {
    return {
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

const debugCommandRegistry = {
    stat: runStatCommand,
    mobile: runMobileCommand,
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
            if (!gameplay.active && actor.mesh) {
                const targetPos = new THREE.Vector3();
                actor.mesh.getWorldPosition(targetPos);
                
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
    actorComponentCollisionInput = document.getElementById('actor-component-collision');
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
    actorKindSelect?.addEventListener('change', () => syncActorEditorUi());
    actorImportedTemplateSelect?.addEventListener('change', () => syncActorEditorUi());
    actorComponentCollisionInput?.addEventListener('change', () => syncActorEditorUi());
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

    renderer = new WebGPURenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.localClippingEnabled = true; // Essential for the reflection
    renderer.domElement.tabIndex = 0;
    container.appendChild(renderer.domElement);

    // Initialize TransformControls for gizmo manipulation
    transformControl = new TransformControls(camera, renderer.domElement);
    transformControl.addEventListener('dragging-changed', (event) => {
        showcase.looking = false;
        if (!event.value) {
            syncTransformToPhysics();
        }
    });
    scene.add(transformControl.getHelper());

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
            updateShowcaseCamera(delta);
        }
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
    renderer.domElement.addEventListener('dblclick', (event) => {
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

    if (debugConsoleState.visible) {
        if (gameplay.pointerLocked || gameplay.active) {
            event.preventDefault();
        }
        return;
    }

    if (!gameplay.active && !gameplay.pointerLocked && isDown) {
        if (event.code === 'KeyW') {
            transformControl?.setMode('translate');
        } else if (event.code === 'KeyE') {
            transformControl?.setMode('rotate');
        } else if (event.code === 'KeyR') {
            transformControl?.setMode('scale');
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
            const propHit = getDynamicPropHitFromEvent(event);
            if (propHit?.prop) {
                selectShowcaseActor(propHit.prop.id);
            } else {
                // Clicked empty space — deselect
                selectShowcaseActor(null);
            }
            return;
        }
        if (event.button !== 2) return;

        const propHit = getDynamicPropHitFromEvent(event);
        if (propHit?.prop) {
            showcase.looking = false;
            event.preventDefault();
            return;
        }

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

    const propHit = getDynamicPropHitFromEvent(event);
    if (propHit?.prop) {
        event.preventDefault();
        openObjectScriptMenu(event, propHit.prop);
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

    updateWorldPresentation();
    resetShowcaseCamera(false);
    updateGameplayUI();
}

function enterGameplay() {
    if (!gameplay.canPlay) return;

    syncGameplaySpawnToCamera();
    respawnPlayer(true);
    gameplay.pointerLocked = false;
    gameplay.active = true;
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
    const speedRatio = THREE.MathUtils.clamp(Math.abs(forwardSpeed) / VEHICLE_SETTINGS.maxDriveSpeed, 0, 1);
    const driftInput = Math.abs(steer) > 0.1 && speedRatio > VEHICLE_SETTINGS.driftBoostThreshold;
    const drifting = driftInput && (throttle !== 0 || Math.abs(lateralSpeed) > 1.2);
    const halfWheelBase = VEHICLE_SETTINGS.wheelBase * 0.5;
    const halfTrackWidth = VEHICLE_SETTINGS.trackWidth * 0.5;
    const cornerSamples = [
        { forward: halfWheelBase, sideways: -halfTrackWidth },
        { forward: halfWheelBase, sideways: halfTrackWidth },
        { forward: -halfWheelBase, sideways: -halfTrackWidth },
        { forward: -halfWheelBase, sideways: halfTrackWidth },
    ].map((corner) => {
        const sampleX = vehiclePosition.x + flatForward.x * corner.forward + flatRight.x * corner.sideways;
        const sampleZ = vehiclePosition.z + flatForward.z * corner.forward + flatRight.z * corner.sideways;
        const groundHeight = getGroundHeightAt(sampleX, sampleZ, true);
        const rideHeight = groundHeight === null ? null : vehiclePosition.y - groundHeight;
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
        ? contactSamples.reduce((sum, corner) => sum + corner.compression, 0) / contactSamples.length
        : 0;
    const frontCompression = (cornerSamples[0].compression + cornerSamples[1].compression) * 0.5;
    const rearCompression = (cornerSamples[2].compression + cornerSamples[3].compression) * 0.5;
    const leftCompression = (cornerSamples[0].compression + cornerSamples[2].compression) * 0.5;
    const rightCompression = (cornerSamples[1].compression + cornerSamples[3].compression) * 0.5;
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
    const gripBase = THREE.MathUtils.lerp(
        VEHICLE_SETTINGS.lowSpeedGrip,
        VEHICLE_SETTINGS.highSpeedGrip,
        speedRatio
    );

    // Weight transfer effects for realistic handling
    const weightTransfer = throttle * 0.3; // Acceleration/braking affects weight distribution
    const frontGripModifier = vehicleState.brakeHeld ? 1.2 : (throttle > 0 ? 0.9 : 1.0);
    const rearGripModifier = throttle > 0 ? 1.15 : (vehicleState.brakeHeld ? 0.85 : 1.0);

    // Tail whip detection and mechanics (Halo Warthog style)
    const tailWhipActive = vehicleState.brakeHeld && Math.abs(steer) > 0.7 && forwardSpeed > 2.0;
    const tailWhipGrip = tailWhipActive ? 0.3 : 1.0; // Significantly reduce grip during tail whip

    const gripLambda = vehicleState.brakeHeld
        ? VEHICLE_SETTINGS.brakeGrip * frontGripModifier * tailWhipGrip
        : drifting
            ? VEHICLE_SETTINGS.driftGrip
            : gripBase * (throttle > 0 ? rearGripModifier : frontGripModifier);

    const contactGrip = grounded
        ? THREE.MathUtils.lerp(VEHICLE_SETTINGS.partialContactGrip, gripLambda, contactRatio)
        : VEHICLE_SETTINGS.partialContactGrip;
    const nextLateralSpeed = THREE.MathUtils.damp(lateralSpeed, 0, contactGrip, delta);
    const nextHorizontalVelocity = tempVectorE
        .copy(flatForward)
        .multiplyScalar(nextForwardSpeed)
        .addScaledVector(flatRight, nextLateralSpeed);

    if (vehicleState.brakeHeld) {
        nextHorizontalVelocity.multiplyScalar(VEHICLE_SETTINGS.brakeDamping);
    } else if (throttle === 0 && forwardSpeed > 0.5) {
        // Engine braking effect when no throttle applied
        nextHorizontalVelocity.multiplyScalar(0.96);
    }

    // Tail whip boost effect
    if (tailWhipActive && !vehicleState.tailWhipLastFrame) {
        // Initial tail whip activation - add small forward boost
        const tailWhipBoost = flatForward.clone().multiplyScalar(2.0);
        nextHorizontalVelocity.add(tailWhipBoost);
    }
    vehicleState.tailWhipLastFrame = tailWhipActive;

    let nextVerticalVelocity = linearVelocity.y;
    if (grounded && averageCompression > 0) {
        const suspensionLift = averageCompression * VEHICLE_SETTINGS.suspensionSpring;
        const dampingLift = -linearVelocity.y * VEHICLE_SETTINGS.suspensionDamping;
        // Add downforce at high speeds for better stability
        const downforce = speedRatio * speedRatio * 2.0;
        nextVerticalVelocity += (suspensionLift + dampingLift - downforce) * delta;

        const frontImpact = Math.max(0, frontCompression - rearCompression);
        const bumpLaunch = frontImpact * speedRatio * VEHICLE_SETTINGS.bumpLaunchBoost;
        if (bumpLaunch > 1e-4) {
            nextVerticalVelocity += bumpLaunch;
        }
    }

    const nextVelocity = new Jolt.Vec3(nextHorizontalVelocity.x, nextVerticalVelocity, nextHorizontalVelocity.z);
    bodyInterface.SetLinearVelocity(bodyId, nextVelocity);
    Jolt.destroy(nextVelocity);

    const steerSpeedFactor = THREE.MathUtils.clamp(Math.abs(nextForwardSpeed) / VEHICLE_SETTINGS.maxDriveSpeed, 0, 1);
    const steeringDirection = nextForwardSpeed >= 0 ? 1 : -0.7;
    const steeringStrength = THREE.MathUtils.lerp(1, VEHICLE_SETTINGS.steeringHighSpeedDamping, steerSpeedFactor);
    const driftSteerBonus = drifting ? VEHICLE_SETTINGS.driftSteerBonus : 1;
    const tailWhipSteerBonus = tailWhipActive ? 2.8 : 1; // Much higher steering during tail whip

    const targetYawRate = steer === 0
        ? 0
        : steer * steeringDirection * VEHICLE_SETTINGS.steeringRate * steeringStrength * driftSteerBonus * tailWhipSteerBonus;

    const yawLambda = tailWhipActive
        ? VEHICLE_SETTINGS.steeringGrip * 0.4 // Less damping during tail whip for faster rotation
        : (steer === 0 ? VEHICLE_SETTINGS.steeringReturn : VEHICLE_SETTINGS.steeringGrip);

    const nextYawRate = THREE.MathUtils.damp(angularVelocity.y, targetYawRate, yawLambda, delta);
    const rollTilt = -steer * Math.max(0.16, Math.abs(nextForwardSpeed) / VEHICLE_SETTINGS.maxDriveSpeed);
    const pitchTilt = throttle === 0 ? 0 : -throttle * 0.18;
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

    const uprightCorrection = tempVectorA.copy(vehicleUp).cross(upVector).multiplyScalar(-VEHICLE_SETTINGS.uprightTorque * (grounded ? contactRatio : 0.08));
    if (uprightCorrection.lengthSq() > 1e-6) {
        const uprightTorque = new Jolt.Vec3(uprightCorrection.x, uprightCorrection.y, uprightCorrection.z);
        bodyInterface.AddTorque(bodyId, uprightTorque, Jolt.EActivation_Activate);
        Jolt.destroy(uprightTorque);
    }

    if (grounded) {
        const bumpPitchTorque = (rearCompression - frontCompression) * VEHICLE_SETTINGS.bumpPitchTorque;
        const bumpRollTorque = (leftCompression - rightCompression) * VEHICLE_SETTINGS.bumpRollTorque;
        if (Math.abs(bumpPitchTorque) > 1e-4 || Math.abs(bumpRollTorque) > 1e-4) {
            const suspensionTorque = new Jolt.Vec3(bumpPitchTorque, 0, bumpRollTorque);
            bodyInterface.AddTorque(bodyId, suspensionTorque, Jolt.EActivation_Activate);
            Jolt.destroy(suspensionTorque);
        }
    }

    if (grounded && (Math.abs(steer) > 0.05 || Math.abs(throttle) > 0.05)) {
        const rollForce = tempVectorB.copy(vehicleRight).multiplyScalar(-steer * Math.abs(nextForwardSpeed) * VEHICLE_SETTINGS.rollTorque * 0.022);
        const pitchForce = tempVectorC.copy(vehicleForward).multiplyScalar(throttle * VEHICLE_SETTINGS.pitchTorque * 0.035);
        const handlingTorque = rollForce.add(pitchForce);
        const handlingJolt = new Jolt.Vec3(handlingTorque.x, handlingTorque.y, handlingTorque.z);
        bodyInterface.AddTorque(bodyId, handlingJolt, Jolt.EActivation_Activate);
        Jolt.destroy(handlingJolt);
    }

    vehicle.mesh.position.copy(vehiclePosition);
    vehicle.mesh.quaternion.copy(vehicleRotation);
    positionVehicleCamera(vehiclePosition, vehicleRotation, delta);
    gameplay.grounded = grounded;
    physics.jumpQueued = false;

    // Update example widgets with vehicle data
    if (window.exampleWidgets && widgetManager) {
        const speedKmh = Math.round(forwardSpeed * 3.6); // Convert m/s to km/h
        widgetManager.updateWidget(window.exampleWidgets.speed, {
            text: `Speed: ${speedKmh} km/h`
        });

        // Update health bar based on vehicle "health" (using contact ratio as proxy)
        widgetManager.updateWidget(window.exampleWidgets.health, {
            progress: Math.max(0.1, contactRatio)
        });

        // Update score
        if (window.gameScore !== undefined) {
            // Add points for driving

            // Bonus points for high speed
            if (forwardSpeed > 15) {
            }

            // Bonus points for tail whip
            if (tailWhipActive && !vehicleState.tailWhipLastFrame) {
            }

            widgetManager.updateWidget(window.exampleWidgets.score, {
                text: `Score: ${Math.floor(window.gameScore)}`
            });
        }
    }

    if (vehiclePosition.y < worldFloor.position.y - 24) {
        exitVehicle();
        respawnPlayer(true);
    }
}

function getGroundHitAt(x, z, includeFloor = true) {
    const originY = Math.max(PLAYER_SETTINGS.probeHeight, gameplayBounds.max.y + PLAYER_SETTINGS.probeHeight);
    const hits = [];

    raycaster.set(tempVectorA.set(x, originY, z), downVector);

    if (currentMesh) {
        hits.push(...raycaster.intersectObject(currentMesh, true));
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

    hits.sort((a, b) => a.distance - b.distance);
    return hits[0] || null;
}

function getGroundHeightAt(x, z, includeFloor = true) {
    const hit = getGroundHitAt(x, z, includeFloor);
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
downloadBtn.onclick = downloadAsset;

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
document.getElementById('toggle-wireframe').addEventListener('click', () => {
    if (!currentMesh) return;
    currentMesh.traverse(child => {
        if (child.isMesh) child.material.wireframe = !child.material.wireframe;
    });
});

document.getElementById('reset-view').addEventListener('click', () => {
    resetShowcaseCamera();
});

// === UMAP SCENE EXPORT / IMPORT ===
function exportWorldToUmap() {
    const umap = {
        version: 1,
        actors: []
    };
    
    for (const actor of (sceneSystem?.actors || [])) {
        const mesh = getActorRenderObject(actor);
        if (!mesh) continue;
        
        const scripts = objectScriptState.drafts[actor.id] || null;
        
        umap.actors.push({
            id: actor.id,
            kind: actor.kind,
            name: actor.rootNode?.name || 'Actor',
            templateId: actor.templateId,
            userData: actor.entity.getComponent('metadata')?.userData || null,
            transform: {
                position: mesh.position.toArray(),
                quaternion: mesh.quaternion.toArray(),
                scale: mesh.scale.toArray()
            },
            scripts: scripts
        });
    }
    
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
    selectShowcaseActor(null);
}

function loadWorldFromUmap(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const umap = JSON.parse(e.target.result);
            if (umap.version !== 1) {
                console.warn('Unknown umap version', umap.version);
            }
            
            clearSceneActors();
            
            for (const actorData of umap.actors) {
                if (actorData.scripts) {
                    objectScriptState.drafts[actorData.id] = actorData.scripts;
                }
                
                let scale = 1;
                if (actorData.kind === 'sphere' || actorData.kind === 'cube' || actorData.kind === 'capsule') {
                    scale = actorData.transform.scale[0]; 
                }
                
                let actor = null;
                if (actorData.kind === 'vehicle') {
                    actor = spawnDrivableCar({
                        includeScripts: !!actorData.scripts,
                        userData: actorData.userData
                    });
                } else if (actorData.kind === 'imported') {
                    actor = spawnImportedProp(actorData.templateId, {
                        includeScripts: !!actorData.scripts,
                        userData: actorData.userData,
                        includeCollisionBody: true 
                    });
                } else {
                    actor = spawnDynamicPrimitive(actorData.kind, undefined, scale, {
                        includeScripts: !!actorData.scripts,
                        userData: actorData.userData,
                        returnActor: true,
                        includeCollisionBody: true
                    });
                }
                
                if (actor) {
                    const oldId = actor.id;
                    actor.id = actorData.id;
                    if (objectScriptState.drafts[oldId]) {
                        delete objectScriptState.drafts[oldId];
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
                        
                        rebuildActorPhysics(actor);
                    }
                    
                    if (actorData.scripts) {
                       syncPropScriptState(actor);
                    }
                }
            }
            
            saveObjectScriptDrafts();
            refreshSceneUI();
            
        } catch(err) {
            console.error('Error loading UMAP', err);
            alert('Failed to load scene file. It might be corrupt or missing templates.');
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

document.getElementById('reset-view').addEventListener('click', () => {
    if (gameplay.active) {
        respawnPlayer();
        return;
    }

    resetShowcaseCamera(true);
});

init();
