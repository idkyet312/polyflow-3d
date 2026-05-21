// Input-state reset helpers. Pure setters — flip every input-axis flag back
// to neutral for the showcase + gameplay + physics input pools. Used after
// pointer lock loss, mobile suspend, gameplay enter/exit, etc.
//
// Deps:
//   showcase           - shared { input: {...} } state
//   gameplay           - shared { input: {...} } state
//   physics            - shared { jumpQueued } state
//   resetMobileMovePad - touch-stick reset
//   resetMobileLookPad - touch-stick reset
export function createInputReset({
    showcase,
    gameplay,
    physics,
    resetMobileMovePad,
    resetMobileLookPad,
}) {
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
        gameplay.input.fire = false;
        gameplay.input.firePressed = false;
        physics.jumpQueued = false;
    }

    function resetMobileInputState() {
        resetMovementInputState();
        resetMobileMovePad?.();
        resetMobileLookPad?.();
    }

    return { resetMovementInputState, resetMobileInputState };
}

// Pure DOM predicate — does the event target type text? Used to suppress
// keyboard movement bindings when the user is typing in a panel/editor.
export function isEditableElement(target) {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
