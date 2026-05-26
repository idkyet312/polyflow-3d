// Unreal-style HUD / widget bridge, extracted from src/app/runtime.js.
//
// Owns the lazy AHUD singleton + installs the two global widget APIs that
// user scripts (eval'd in the Three.js command console) call:
//   - window.WidgetAPI       — thin delegate to the WidgetManager (DOM widgets)
//   - window.UnrealWidgetAPI — UE-style CreateWidget/GetHUD over AHUD
// and builds the example HUD overlay (score / health / speed).
//
// Why a factory and not module-scope: the WidgetManager is constructed mid-init
// (after the renderer/container exist), and `gameplay` state + setPlayerHealth
// live in runtime.js. So:
//
//   const hudBridge = createHudBridge({
//       getWidgetManager: () => widgetManager,   // set later via init
//       gameplay,
//       setPlayerHealth,
//   });
//   // ...after `widgetManager = new WidgetManager(container)`:
//   hudBridge.createExampleWidgets();
//
// The example widgets are published on window.* (window.exampleWidgets,
// window.gameHud, window.gameScore) — that contract is unchanged so the
// score/visibility helpers still in runtime.js keep reading them as-is.

import {
    AHUD,
    UButtonWidget,
    UImageWidget,
    UProgressBarWidget,
    UTextWidget,
    UUserWidget,
} from '../scripting/ueApi.js';

export function createHudBridge({
    getWidgetManager = () => null,
    gameplay = { active: false, health: 1 },
    setPlayerHealth = () => {},
} = {}) {
    let runtimeHud = null;

    function getRuntimeHud() {
        if (!runtimeHud) {
            runtimeHud = new AHUD({ widgetApi: window.WidgetAPI });
        }
        return runtimeHud;
    }

    // window.WidgetAPI — thin delegate to the live WidgetManager. Each call
    // re-reads the manager so it works even though the manager is constructed
    // after this bridge.
    function installWidgetApi() {
        if (typeof window === 'undefined') return;
        window.WidgetAPI = {
            createWidget: (type, config) => getWidgetManager()?.createWidget(type, config) ?? null,
            updateWidget: (id, updates) => getWidgetManager()?.updateWidget(id, updates) ?? false,
            showWidget: (id, visible) => getWidgetManager()?.showWidget(id, visible) ?? false,
            removeWidget: (id) => getWidgetManager()?.removeWidget(id) ?? false,
            setWidgetPosition: (id, position, space) => getWidgetManager()?.setWidgetPosition(id, position, space) ?? false,
            setWidgetScale: (id, scale) => getWidgetManager()?.setWidgetScale(id, scale) ?? false,
            getWidget: (id) => getWidgetManager()?.getWidget(id) ?? null,
            getAllWidgets: () => getWidgetManager()?.getAllWidgets() ?? [],
        };

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
    }

    function createExampleWidgets() {
        if (!getWidgetManager()) return;

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

    installWidgetApi();

    return { getRuntimeHud, createExampleWidgets };
}
