// src/ui/mobileControls.js
// Extracted from main.js lines 6469–6741.
// Mobile control pads, thumb positioning, look/move input handlers,
// action button bindings, and initial DOM setup for mobile UI.

import * as THREE from 'three';
import { core } from '../runtime/appCore.js';

function inDrugTycoon() {
    return core.currentMesh?.userData?.sampleType === 'drugTycoon';
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
    applyGameplayCameraRotation, applyShowcaseCameraRotation, getActiveVehicleProp;

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
        applyGameplayCameraRotation,
        applyShowcaseCameraRotation,
        getActiveVehicleProp,
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
    mobileExitPlayBtn?.addEventListener('click', () => setCameraMode('showcase'));
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
        // Engine weapon OR the Drug Tycoon pistol: hold to fire, suppress the
        // default right mouse action so no ball is thrown while armed.
        if (gameplay.active && (gameplay.weapon?.type || (inDrugTycoon() && window.drugTycoon?.hasGun))) {
            event.preventDefault();
            gameplay.input.fire = true;
            gameplay.input.firePressed = true;
            mobileRightActionBtn.setPointerCapture?.(event.pointerId);
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
        // Drug Tycoon repurposes Action 2 as the interact (E) button.
        if (inDrugTycoon()) {
            event.preventDefault();
            window.drugTycoonApi?.queueInteract?.();
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

export function resetMobileMovePad() {
    mobileState.movePointerId = null;
    clearMobilePad(mobileMoveThumb);
    applyMobileMoveVector(0, 0);
}

// ─── Look pad ────────────────────────────────────────────────────────────────────

export function applyMobileLookDelta(deltaX, deltaY) {
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

    if (mobileExitPlayBtn) {
        mobileExitPlayBtn.hidden = !gameplay.active;
    }
}

export function updateMobileButtons() {
    if (mobileMenuToggleBtn) {
        mobileMenuToggleBtn.classList.toggle('viewer-toggle-btn-active', mobileState.menuOpen);
    }

    if (mobileJumpBtn) {
        mobileJumpBtn.textContent = isFlyingHelicopter() ? 'Up' : isDrivingVehicle() ? 'Brake' : 'Jump';
    }

    if (mobileRightActionBtn) {
        mobileRightActionBtn.textContent = isFlyingHelicopter() ? 'Down' : gameplay.weapon?.type ? 'Fire' : 'Action';
    }

    if (mobileAction2Btn) {
        mobileAction2Btn.textContent = inDrugTycoon() ? 'E' : isDrivingVehicle() ? 'Exit' : 'Enter';
    }

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
