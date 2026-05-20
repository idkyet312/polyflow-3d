// Weapon HUD + directional damage indicator. Pure DOM/THREE-independent.
// Lazily creates and reuses two DOM elements attached to #canvas-container
// (or document.body as fallback). State is encapsulated — no module globals
// leak into runtime.js.
//
// API:
//   const { setWeaponHud, showDamageIndicator, getWeaponHudEl } = createWeaponHud();
//
// setWeaponHud(text)        - empty/null hides; otherwise shows centered.
// showDamageIndicator(rad)  - 0 = front, +PI/2 = right, PI = behind.
// getWeaponHudEl()          - underlying element (read-only, for heldWeapons).
export function createWeaponHud() {
    let weaponHudEl = null;
    let dmgIndicatorEl = null;

    function ensureWeaponHud() {
        if (weaponHudEl?.parentNode) return weaponHudEl;
        const el = document.createElement('div');
        el.style.cssText = `
            position:absolute;
            right:28px;
            bottom:22px;
            pointer-events:none;
            font:700 30px/1 "Trebuchet MS",system-ui,sans-serif;
            color:#ffe27a;
            text-shadow:0 2px 6px rgba(0,0,0,0.85);
            letter-spacing:1px;
            opacity:0;
            transition:opacity 0.12s linear;
            z-index:998;
        `;
        (document.getElementById('canvas-container') || document.body)?.appendChild(el);
        weaponHudEl = el;
        return el;
    }

    function setWeaponHud(text) {
        const el = ensureWeaponHud();
        if (!el) return;
        if (text == null || text === '') {
            el.style.opacity = '0';
            return;
        }
        el.textContent = String(text);
        el.style.opacity = '1';
    }

    function showDamageIndicator(angleRad = Math.PI) {
        if (!dmgIndicatorEl?.parentNode) {
            const el = document.createElement('div');
            el.style.cssText = `
                position:absolute;
                left:50%;
                top:50%;
                width:240px;
                height:240px;
                margin:-120px 0 0 -120px;
                pointer-events:none;
                opacity:0;
                transition:opacity 0.18s linear;
                z-index:997;
                background:conic-gradient(from -20deg, rgba(255,30,30,0) 0deg,
                    rgba(255,30,30,0.55) 20deg, rgba(255,30,30,0) 40deg);
                border-radius:50%;
                mask:radial-gradient(circle, transparent 58%, #000 70%);
                -webkit-mask:radial-gradient(circle, transparent 58%, #000 70%);
            `;
            (document.getElementById('canvas-container') || document.body)?.appendChild(el);
            dmgIndicatorEl = el;
        }
        const el = dmgIndicatorEl;
        el.style.transform = `rotate(${(Number(angleRad) || 0) * 180 / Math.PI}deg)`;
        el.style.opacity = '1';
        clearTimeout(el._hideTimer);
        el._hideTimer = setTimeout(() => { el.style.opacity = '0'; }, 320);
    }

    return {
        setWeaponHud,
        showDamageIndicator,
        getWeaponHudEl: () => weaponHudEl,
    };
}
