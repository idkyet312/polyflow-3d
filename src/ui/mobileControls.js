// src/ui/mobileControls.js
// Extracted from main.js lines 6469–6741.
// Mobile control pads, thumb positioning, look/move input handlers,
// action button bindings, and initial DOM setup for mobile UI.

import * as THREE from 'three';
import { core } from '../runtime/appCore.js';
import { look } from './settingsMenu.js';

function inDrugTycoon() {
    return core.currentMesh?.userData?.sampleType === 'drugTycoon';
}
function inShootingSim() {
    return core.currentMesh?.userData?.sampleType === 'shootingSim';
}

// Mirrors inGameMode() in inputHandlers.js. Used to suppress the default
// touch "throw ball" (sphere/cube) action while inside a game mode.
const GAME_MODE_SAMPLE_TYPES = new Set(['drugTycoon', 'doomArena', 'doomTest', 'shootingSim']);
function inGameMode() {
    const sampleType = core.currentMesh?.userData?.sampleType;
    if (sampleType && GAME_MODE_SAMPLE_TYPES.has(sampleType)) return true;
    return !!window.drugTycoon?.inRoom;
}

// Per-context mobile button spec: which of the three action buttons show, and
// their labels. Each game mode only spawns the buttons it actually uses, so the
// screen isn't cluttered with controls the mode ignores.
//   jump        — Jump / Up / Brake
//   rightAction — Fire / Action (throw) / Down (heli)
//   action2     — E (interact) / Enter-Exit (vehicle)
function getMobileButtonSpec() {
    if (!gameplay.active) {
        return { jump: false, rightAction: false, action2: false };
    }
    const sampleType = core.currentMesh?.userData?.sampleType;

    // Drug Tycoon: movement + the E interact button. The action button fires
    // when armed; otherwise it cycles the dealt product line (PC [Q]).
    if (sampleType === 'drugTycoon') {
        return {
            jump: false,
            rightAction: true,
            rightLabel: 'Q',
            action2: true,
            action2Label: isDrivingVehicle?.() ? 'Exit' : getNearbyVehicle?.() ? 'Enter' : 'E',
        };
    }

    // Rogue Waves / Doom arenas: shooter controls — Jump + Fire, no interact.
    if (sampleType === 'doomArena' || sampleType === 'doomTest') {
        return {
            jump: true,
            rightAction: true,
            rightLabel: gameplay.weapon?.type ? 'Fire' : 'Action',
            action2: false,
        };
    }

    // Shooting Simulator: Fire button + Action 2 opens the mode menu (R/M on PC).
    if (sampleType === 'shootingSim') {
        return {
            jump: false,
            rightAction: true,
            rightLabel: 'Fire',
            action2: true,
            action2Label: 'Menu',
        };
    }

    // Free/engine scene: full set — Jump, Action/Fire, Enter-Exit vehicle.
    return {
        jump: true,
        jumpLabel: isFlyingHelicopter() ? 'Up' : isDrivingVehicle() ? 'Brake' : 'Jump',
        rightAction: true,
        rightLabel: isFlyingHelicopter() ? 'Down' : gameplay.weapon?.type ? 'Fire' : 'Action',
        action2: true,
        action2Label: isDrivingVehicle() ? 'Exit' : 'Enter',
    };
}

// ─── Module-scope deps populated by setupMobileControls ─────────────────────
let mobileState, gameplay, showcase, vehicleState, physics;
let mobileMenuToggleBtn, mobileModeToggleBtn, mobileExitPlayBtn, mobileRotateMenuBtn;
let mobileMovePad, mobileMoveThumb, mobileLookPad, mobileLookThumb;
let mobileJumpBtn, mobileRightActionBtn, mobileAction2Btn;

// Constants
let MOBILE_MOVE_THRESHOLD, MOBILE_MOVE_RADIUS_FACTOR, MOBILE_LOOK_SENSITIVITY,
    PLAYER_SETTINGS;

// Functions from main.js
let isDrivingVehicle, setCameraMode, runMouseAction, exitVehicle, enterVehicle,
    getNearbyVehicle,
    applyGameplayCameraRotation, applyShowcaseCameraRotation, getActiveVehicleProp,
    handleMobileExitPlay;

function isFlyingHelicopter() {
    return !!(isDrivingVehicle?.() && getActiveVehicleProp?.()?.userData?.prefabId === 'helicopter');
}

export function setupMobileControls(deps) {
    ({
        mobileState,
        gameplay,
        showcase,
        vehicleState,
        physics,
        MOBILE_MOVE_THRESHOLD,
        MOBILE_MOVE_RADIUS_FACTOR,
        MOBILE_LOOK_SENSITIVITY,
        PLAYER_SETTINGS,
        isDrivingVehicle,
        setCameraMode,
        runMouseAction,
        exitVehicle,
        enterVehicle,
        getNearbyVehicle,
        applyGameplayCameraRotation,
        applyShowcaseCameraRotation,
        getActiveVehicleProp,
        handleMobileExitPlay,
    } = deps);

    // DOM refs are resolved at setup time (same as original main.js)
    mobileMenuToggleBtn = document.getElementById('mobile-menu-toggle');
    mobileModeToggleBtn = document.getElementById('mobile-mode-toggle');
    mobileExitPlayBtn = document.getElementById('mobile-exit-play');
    mobileRotateMenuBtn = document.getElementById('mobile-rotate-menu');
    mobileMovePad = document.getElementById('mobile-move-pad');
    mobileMoveThumb = document.getElementById('mobile-move-thumb');
    mobileLookPad = document.getElementById('mobile-look-pad');
    mobileLookThumb = document.getElementById('mobile-look-thumb');
    mobileRightActionBtn = document.getElementById('mobile-right-action');
    mobileAction2Btn = document.getElementById('mobile-action2');
    mobileJumpBtn = document.getElementById('mobile-jump');

    mobileMenuToggleBtn?.addEventListener('click', () => setMobileMenuOpen(!mobileState.menuOpen));
    mobileModeToggleBtn?.addEventListener('click', () => setCameraMode(gameplay.active ? 'showcase' : 'play'));
    mobileExitPlayBtn?.addEventListener('click', () => {
        if (handleMobileExitPlay?.()) return;
        setCameraMode('showcase');
    });
    mobileRotateMenuBtn?.addEventListener('click', () => setMobileMenuOpen(!mobileState.menuOpen));

    mobileJumpBtn?.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        event.preventDefault();
        if (gameplay.active) {
            if (isFlyingHelicopter()) {
                gameplay.input.lift = true;
            } else if (isDrivingVehicle()) {
                vehicleState.brakeHeld = true;
            } else {
                physics.jumpQueued = true;
            }
        }
    });
    const releaseJumpBtn = () => {
        gameplay.input.lift = false;
        vehicleState.brakeHeld = false;
    };
    mobileJumpBtn?.addEventListener('pointerup', releaseJumpBtn);
    mobileJumpBtn?.addEventListener('pointercancel', releaseJumpBtn);

    mobileRightActionBtn?.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        if (gameplay.active && isFlyingHelicopter()) {
            event.preventDefault();
            gameplay.input.descend = true;
            mobileRightActionBtn.setPointerCapture?.(event.pointerId);
            return;
        }
        // Drug Tycoon: the top-right action button always cycles the dealt
        // product line — same as pressing [Q] on PC (firing is via the
        // look/tap zone). Armed or not, this button is [Q].
        if (gameplay.active && inDrugTycoon()) {
            event.preventDefault();
            window.drugTycoonApi?.cycleSellProduct?.();
            return;
        }
        // Engine weapon: hold to fire, suppress the default right mouse action
        // so no ball is thrown while armed.
        if (gameplay.active && (gameplay.weapon?.type || inShootingSim())) {
            event.preventDefault();
            gameplay.input.fire = true;
            gameplay.input.firePressed = true;
            mobileRightActionBtn.setPointerCapture?.(event.pointerId);
            return;
        }
        // In a game mode, suppress the default throw so tapping the action
        // button doesn't fling spheres/cubes. Free scenes still throw.
        if (gameplay.active && inGameMode()) {
            event.preventDefault();
            return;
        }
        runMouseAction('right', event);
    });
    const releaseRightActionBtn = () => {
        gameplay.input.fire = false;
        gameplay.input.descend = false;
    };
    mobileRightActionBtn?.addEventListener('pointerup', releaseRightActionBtn);
    mobileRightActionBtn?.addEventListener('pointercancel', releaseRightActionBtn);
    mobileRightActionBtn?.addEventListener('lostpointercapture', releaseRightActionBtn);

    mobileAction2Btn?.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        // Drug Tycoon repurposes Action 2 as the interact (E) button. But it
        // doubles as enter/exit car: if driving or stood next to a vehicle,
        // the button boards/leaves the car (same as PC E); else it interacts.
        if (inDrugTycoon()) {
            event.preventDefault();
            if (isDrivingVehicle?.()) { exitVehicle(); return; }
            if (getNearbyVehicle?.()) { enterVehicle(); return; }
            window.drugTycoonApi?.queueInteract?.();
            return;
        }
        // Shooting Sim: Action 2 opens the mode menu (Practice / Time Attack).
        if (inShootingSim()) {
            event.preventDefault();
            window.shootingSimApi?.openMenu?.();
            return;
        }
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

    // Right half of the screen = look around. A drag rotates the camera; a
    // quick tap (little/no movement) fires the weapon (shoot/bat) so the player
    // can aim with the right thumb and tap to fire in one zone.
    const _lookTap = { startX: 0, startY: 0, moved: 0, down: false };
    const LOOK_TAP_SLOP = 12; // px of total movement still counts as a tap
    bindMobilePad(mobileLookPad, mobileLookThumb, (event) => {
        const hasLast = !!mobileLookPad.dataset.lastX;
        if (!hasLast) {
            _lookTap.startX = event.clientX;
            _lookTap.startY = event.clientY;
            _lookTap.moved = 0;
            _lookTap.down = true;
        }
        const lastX = hasLast ? Number(mobileLookPad.dataset.lastX) : event.clientX;
        const lastY = hasLast ? Number(mobileLookPad.dataset.lastY) : event.clientY;
        const deltaX = event.clientX - lastX;
        const deltaY = event.clientY - lastY;
        _lookTap.moved += Math.abs(deltaX) + Math.abs(deltaY);
        mobileLookPad.dataset.lastX = String(event.clientX);
        mobileLookPad.dataset.lastY = String(event.clientY);
        updateMobileLookPad(event.clientX, event.clientY, deltaX, deltaY);
    }, () => {
        // Tap (no real drag) → one-shot fire.
        if (_lookTap.down && _lookTap.moved <= LOOK_TAP_SLOP && gameplay.active) {
            gameplay.input.firePressed = true;
            gameplay.input.fire = true;
            // Release the held flag next tick so auto weapons fire once per tap.
            window.setTimeout(() => { gameplay.input.fire = false; }, 60);
        }
        _lookTap.down = false;
        if (mobileLookPad?.dataset) {
            delete mobileLookPad.dataset.lastX;
            delete mobileLookPad.dataset.lastY;
        }
        resetMobileLookPad();
    });

    updateMobileButtons();
}

// ─── Menu ────────────────────────────────────────────────────────────────────────

export function setMobileMenuOpen(isOpen) {
    mobileState.menuOpen = !!isOpen;
    document.body.classList.toggle('mobile-menu-open', mobileState.menuOpen);

    if (mobileMenuToggleBtn) {
        mobileMenuToggleBtn.textContent = mobileState.menuOpen ? 'Close' : 'Menu';
        mobileMenuToggleBtn.classList.toggle('viewer-toggle-btn-active', mobileState.menuOpen);
    }
}

// ─── Thumb positioning ────────────────────────────────────────────────────────────

export function setTouchThumbPosition(thumbElement, offsetX, offsetY) {
    if (!thumbElement) return;
    thumbElement.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px))`;
}

export function clearMobilePad(thumbElement) {
    setTouchThumbPosition(thumbElement, 0, 0);
}

// ─── Move pad ────────────────────────────────────────────────────────────────────

export function applyMobileMoveVector(x, y) {
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

export function updateMobileMovePad(clientX, clientY) {
    if (!mobileMovePad) return;

    const rect = mobileMovePad.getBoundingClientRect();
    const radius = Math.max(1, Math.min(rect.width, rect.height) * MOBILE_MOVE_RADIUS_FACTOR);

    // Floating joystick: the stick anchors wherever the thumb first touched
    // down (captured in bindMobilePad), then moves relative to that point —
    // like a typical mobile game. Fall back to the pad center if no anchor.
    const hasAnchor = mobileState.moveAnchorX != null;
    const centerX = hasAnchor ? mobileState.moveAnchorX : rect.left + rect.width * 0.5;
    const centerY = hasAnchor ? mobileState.moveAnchorY : rect.top + rect.height * 0.5;
    const offsetX = clientX - centerX;
    const offsetY = clientY - centerY;
    const length = Math.hypot(offsetX, offsetY);
    const scale = length > radius ? radius / length : 1;
    const clampedX = offsetX * scale;
    const clampedY = offsetY * scale;

    // Thumb position is relative to the pad center, so re-base the visual
    // offset onto the anchor point.
    const padCenterX = rect.left + rect.width * 0.5;
    const padCenterY = rect.top + rect.height * 0.5;
    const visualX = (centerX - padCenterX) + clampedX;
    const visualY = (centerY - padCenterY) + clampedY;

    setTouchThumbPosition(mobileMoveThumb, visualX, visualY);
    applyMobileMoveVector(clampedX / radius, clampedY / radius);
}

export function resetMobileMovePad() {
    mobileState.movePointerId = null;
    mobileState.moveAnchorX = null;
    mobileState.moveAnchorY = null;
    clearMobilePad(mobileMoveThumb);
    applyMobileMoveVector(0, 0);
}

// ─── Look pad ────────────────────────────────────────────────────────────────────

export function applyMobileLookDelta(deltaX, deltaY) {
    const lookTarget = gameplay.active ? gameplay : showcase;

    // Live touch sensitivity from the settings menu (persisted). Falls back to
    // the runtime default if the settings module hasn't applied yet.
    const sens = Number.isFinite(look?.touch) ? look.touch : MOBILE_LOOK_SENSITIVITY;
    const pitchDir = look?.invertY ? -1 : 1;
    lookTarget.yaw -= deltaX * sens;
    lookTarget.pitch -= deltaY * sens * pitchDir;
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

export function updateMobileLookPad(clientX, clientY, deltaX = 0, deltaY = 0) {
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

export function resetMobileLookPad() {
    mobileState.lookPointerId = null;
    if (mobileLookPad?.dataset) {
        delete mobileLookPad.dataset.lastX;
        delete mobileLookPad.dataset.lastY;
    }
    clearMobilePad(mobileLookThumb);
}

// ─── Action buttons ────────────────────────────────────────────────────────────

export function syncMobileActionVisibility() {
    const spec = getMobileButtonSpec();

    if (mobileJumpBtn) mobileJumpBtn.hidden = !spec.jump;
    if (mobileRightActionBtn) mobileRightActionBtn.hidden = !spec.rightAction;
    if (mobileAction2Btn) mobileAction2Btn.hidden = !spec.action2;

    if (mobileModeToggleBtn) {
        mobileModeToggleBtn.textContent = gameplay.active ? 'Showcase' : 'Play';
        mobileModeToggleBtn.classList.toggle('viewer-toggle-btn-active', gameplay.active);
    }

    if (mobileExitPlayBtn) {
        mobileExitPlayBtn.hidden = !gameplay.active;
    }
}

export function updateMobileButtons() {
    if (mobileMenuToggleBtn) {
        mobileMenuToggleBtn.classList.toggle('viewer-toggle-btn-active', mobileState.menuOpen);
    }

    const spec = getMobileButtonSpec();
    if (mobileJumpBtn && spec.jumpLabel) mobileJumpBtn.textContent = spec.jumpLabel;
    if (mobileRightActionBtn && spec.rightLabel) mobileRightActionBtn.textContent = spec.rightLabel;
    if (mobileAction2Btn && spec.action2Label) mobileAction2Btn.textContent = spec.action2Label;

    syncMobileActionVisibility();
}

// ─── Hold-button helper ───────────────────────────────────────────────────────────

export function applyMobileHoldButton(button, onDown, onUp) {
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

// ─── Pad binding ──────────────────────────────────────────────────────────────

export function bindMobilePad(padElement, thumbElement, onMove, onRelease) {
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
            // Anchor the floating joystick at the touch-down point.
            mobileState.moveAnchorX = event.clientX;
            mobileState.moveAnchorY = event.clientY;
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
