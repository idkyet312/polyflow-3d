import * as THREE from 'three';

// Player health, hit overlay/shake/flash, hurt sound, death-respawn queue.
// Pure-state-write logic — no THREE scene mutation other than tiny camera
// shake during hit feedback (delta-driven, runs on the gameplay loop).
//
// Deps:
//   gameplay         - shared state ({ health, dead, hitFeedback, yaw, ... })
//   physics          - shared physics state (jumpQueued/desiredVelocity)
//   SHOOTER_AI_PREFAB- tuning const (damage cap, damage cooldown)
//   getCamera        - () => THREE.Camera | null
//   getCurrentMesh   - () => Object3D | null (used to suppress auto-respawn
//                      in roguelike doomArena where the game-mode script
//                      owns the death screen)
//   getWidgetManager - () => widget manager (HUD bar lookup)
//   getRuntimeAudio  - () => { listener } (hit-sound oscillator parent)
//   showDamageIndicator - (rel) => void   (weaponHud.showDamageIndicator)
//   isDrivingVehicle    - () => bool
//   clearActiveVehicle  - () => void
//   resetMovementInputState - () => void
//   respawnPlayer       - (useStoredView=true) => void  (frame-loop respawn)
// `bus` is optional. If provided, damagePlayer emits 'player:damaged' with
// { amount, damageAngle (rad relative to facing), sourcePos } so HUD/audio/
// respawn subscribers can react independently. If absent, falls back to the
// inline chain (back-compat for boot order before the bus exists).
export function createPlayerCombat({
    gameplay,
    physics,
    SHOOTER_AI_PREFAB,
    getCamera,
    getCurrentMesh,
    getWidgetManager,
    getRuntimeAudio,
    showDamageIndicator,
    isDrivingVehicle,
    clearActiveVehicle,
    resetMovementInputState,
    respawnPlayer,
    bus = null,
}) {
    function setPlayerHealth(value = 1) {
        const numericValue = Number(value);
        gameplay.health = THREE.MathUtils.clamp(
            Number.isFinite(numericValue) ? numericValue : gameplay.health,
            0,
            1,
        );
        if (typeof window !== 'undefined') window.playerHealth = gameplay.health;
        const fillColor = gameplay.health > 0.35 ? '#00ff66' : '#ff3b30';
        const exampleWidgets = (typeof window !== 'undefined') ? window.exampleWidgets : null;
        const healthWidget = exampleWidgets?.health;
        healthWidget?.SetPercent(gameplay.health);
        healthWidget?._applyConfig?.({ fillColor });
        exampleWidgets?.healthText?.SetText(`Health: ${Math.round(gameplay.health * 100)}%`);
        exampleWidgets?.healthText?._applyConfig?.({ color: fillColor });

        const widgetId = healthWidget?.GetWidgetId?.();
        const widgetElement = widgetId ? getWidgetManager()?.getWidget?.(widgetId)?.element : null;
        const fillElement = widgetElement?.querySelector?.('div > div');
        if (fillElement) {
            fillElement.style.width = '100%';
            fillElement.style.transform = `scaleX(${gameplay.health})`;
            fillElement.style.transformOrigin = 'left center';
            fillElement.style.backgroundColor = fillColor;
        }

        if (gameplay.active && gameplay.health <= 0) {
            queuePlayerDeathRespawn();
        }
    }

    function damagePlayer(amount = SHOOTER_AI_PREFAB.damage, sourcePos = null) {
        if (gameplay.dead) return;

        const now = performance.now?.() || Date.now();
        if (now - (gameplay.lastDamageAt || 0) < SHOOTER_AI_PREFAB.playerDamageCooldownMs) return;
        gameplay.lastDamageAt = now;

        const rogueBuffs = (typeof window !== 'undefined') ? window.rogueBuffs : null;
        const damageAmount = THREE.MathUtils.clamp(Number(amount) || 0, 0, SHOOTER_AI_PREFAB.damage)
            * (rogueBuffs?.damageTaken ?? 1);
        setPlayerHealth((gameplay.health ?? 1) - damageAmount);

        // Compute directional angle (0 = front, +PI/2 = right, PI = behind)
        // up-front so all subscribers get a normalized payload.
        let damageAngle = null;
        const camera = getCamera();
        if (sourcePos && camera) {
            const dx = sourcePos.x - camera.position.x;
            const dz = sourcePos.z - camera.position.z;
            const worldAngle = Math.atan2(dx, -dz);
            damageAngle = worldAngle - (gameplay.yaw || 0);
        }

        if (bus) {
            // Decoupled path: HUD flash/shake, hit sound, damage indicator,
            // and user script all subscribe independently in runtime.js.
            bus.emit('player:damaged', { amount: damageAmount, damageAngle, sourcePos });
        } else {
            // Fallback chain (no bus wired): preserve legacy behavior.
            triggerPlayerHitFeedback();
            if (damageAngle != null) {
                if (typeof window !== 'undefined' && window.onPlayerDamaged) {
                    try { window.onPlayerDamaged(damageAngle, damageAmount); } catch (e) { /* script error */ }
                } else {
                    showDamageIndicator(damageAngle);
                }
            }
        }
    }

    function ensurePlayerHitOverlay() {
        if (gameplay.hitFeedback.overlay?.parentNode) return gameplay.hitFeedback.overlay;
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position:absolute;
            inset:0;
            pointer-events:none;
            opacity:0;
            background:rgba(255,0,0,0.28);
            z-index:999;
            transition:opacity 0.08s linear;
        `;
        (document.getElementById('canvas-container') || document.body)?.appendChild(overlay);
        gameplay.hitFeedback.overlay = overlay;
        return overlay;
    }

    function triggerPlayerHitFeedback() {
        gameplay.hitFeedback.flash = 1;
        gameplay.hitFeedback.shake = Math.max(gameplay.hitFeedback.shake, 1);
        const overlay = ensurePlayerHitOverlay();
        if (overlay) overlay.style.opacity = '1';
        playPlayerHitSound();
    }

    function playPlayerHitSound() {
        const context = getRuntimeAudio()?.listener?.context;
        if (!context || context.state !== 'running') return;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'square';
        oscillator.frequency.setValueAtTime(150, context.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(70, context.currentTime + 0.12);
        gain.gain.setValueAtTime(0.08, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + 0.13);
    }

    function updatePlayerHitFeedback(delta = 0) {
        const feedback = gameplay.hitFeedback;
        if (feedback.flash > 0) {
            feedback.flash = Math.max(0, feedback.flash - delta * 4.5);
            if (feedback.overlay) feedback.overlay.style.opacity = String(feedback.flash * 0.42);
        }
        const camera = getCamera();
        if (feedback.shake > 0 && gameplay.active && camera) {
            feedback.shake = Math.max(0, feedback.shake - delta * 5.5);
            const strength = 0.055 * feedback.shake;
            camera.position.x += (Math.random() - 0.5) * strength;
            camera.position.y += (Math.random() - 0.5) * strength;
        }
        if (gameplay.recoilPitch || gameplay.recoilYaw) {
            const k = Math.exp(-12 * delta);
            gameplay.recoilPitch *= k;
            gameplay.recoilYaw *= k;
            if (Math.abs(gameplay.recoilPitch) < 1e-4) gameplay.recoilPitch = 0;
            if (Math.abs(gameplay.recoilYaw) < 1e-4) gameplay.recoilYaw = 0;
        }
    }

    function queuePlayerDeathRespawn() {
        if (gameplay.dead) return;

        gameplay.dead = true;
        resetMovementInputState();
        physics.jumpQueued = false;
        physics.desiredVelocity.set(0, 0, 0);
        gameplay.velocity.set(0, 0, 0);
        if (isDrivingVehicle()) clearActiveVehicle();

        const sampleType = getCurrentMesh()?.userData?.sampleType || '';
        const autoRespawn = sampleType !== 'doomArena';

        if (bus) {
            // Game-mode scripts (rogue waves death screen) listen for this.
            bus.emit('player:died', { sampleType, autoRespawn });
        }

        // Rogue Waves: the game-mode script shows the death screen — don't
        // auto-respawn here.
        if (!autoRespawn) return;

        if (gameplay.respawnTimer) clearTimeout(gameplay.respawnTimer);
        gameplay.respawnTimer = setTimeout(() => {
            gameplay.respawnTimer = null;
            respawnPlayer(true);
        }, 450);
    }

    return {
        setPlayerHealth,
        damagePlayer,
        ensurePlayerHitOverlay,
        triggerPlayerHitFeedback,
        playPlayerHitSound,
        updatePlayerHitFeedback,
        queuePlayerDeathRespawn,
    };
}
