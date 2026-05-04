// src/editor/terrainPanel.js
// Extracted from main.js (chore/main-js-shrink-2). Owns the terrain editor's
// brush helper, paint-from-event handlers, the terrain DOM panel wiring
// (`setupTerrainPanel()`), and the serialize/apply terrain-state hooks.
//
// `worldFloor` and `grassField` are assigned in init() AFTER wireExtractedModules
// runs, so they come through here as getter callbacks.

import * as THREE from 'three';

let terrainBrushState, gameplay, blueprintState;
let camera, renderer, pointerNdc, raycaster;
let getWorldFloor, getGrassField;
let applySerializedTerrainState, serializeTerrainState;
let rebuildTerrainPhysicsBody;
let applyTerrainSculptBrush;
let setTerrainCustomImage, setTerrainModeGrassPBR, setTerrainModeGrid, setTerrainModeSolid;
let setTerrainRepeat, setTerrainRoughness, setTerrainTint;
let ensurePlayerCharacter, updateWorldPresentation, updateGameplayUI;

export function installTerrainPanel(deps) {
    ({
        terrainBrushState, gameplay, blueprintState,
        camera, renderer, pointerNdc, raycaster,
        getWorldFloor, getGrassField,
        applySerializedTerrainState, serializeTerrainState,
        rebuildTerrainPhysicsBody,
        applyTerrainSculptBrush,
        setTerrainCustomImage, setTerrainModeGrassPBR, setTerrainModeGrid, setTerrainModeSolid,
        setTerrainRepeat, setTerrainRoughness, setTerrainTint,
        ensurePlayerCharacter, updateWorldPresentation, updateGameplayUI,
    } = deps);
}

export function ensureTerrainBrushHelper() {
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
    getWorldFloor()?.add(helper);
    return helper;
}

export function getTerrainHitFromEvent(event) {
    if (!renderer || !getWorldFloor()) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);
    const hit = raycaster.intersectObject(getWorldFloor(), false)[0];
    if (!hit) return null;
    const local = getWorldFloor().worldToLocal(hit.point.clone());
    return { hit, local };
}

export function updateTerrainBrushPreview(event) {
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

export function applyTerrainBrushFromEvent(event) {
    const terrainHit = updateTerrainBrushPreview(event);
    if (!terrainHit) return false;

    const { local } = terrainHit;
    const tool = terrainBrushState.tool;
    if (tool === 'foliage' || tool === 'erase-foliage') {
        getGrassField()?.paintFoliage?.({
            terrain: getWorldFloor(),
            localX: local.x,
            localY: local.y,
            radius: terrainBrushState.radius,
            density: terrainBrushState.foliageDensity,
            mode: event.shiftKey || tool === 'erase-foliage' ? 'erase' : 'add',
            type: terrainBrushState.foliageType,
        });
        return true;
    }

    const changed = applyTerrainSculptBrush(getWorldFloor(), {
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
        getGrassField()?.syncToTerrain?.(getWorldFloor(), {
            localX: local.x,
            localY: local.y,
            radius: terrainBrushState.radius + 2,
        });
        terrainBrushState.dirtyPhysics = true;
    }
    return changed;
}

export function serializeWorldTerrainState() {
    return {
        terrain: serializeTerrainState(getWorldFloor()),
        foliage: getGrassField()?.serializeFoliage?.() ?? null,
    };
}

export function applyWorldTerrainState(data = {}) {
    applySerializedTerrainState(getWorldFloor(), data.terrain);
    rebuildTerrainPhysicsBody();
    getGrassField()?.applySerializedFoliage?.(data.foliage ?? {}, getWorldFloor());
    getGrassField()?.syncToTerrain?.(getWorldFloor());
    if (physics.ready) {
        ensurePlayerCharacter();
        gameplay.canPlay = true;
        updateWorldPresentation();
        updateGameplayUI();
    }
}

export function setupTerrainPanel() {
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
        if (mode === 'grid') await setTerrainModeGrid(getWorldFloor());
        else if (mode === 'solid') setTerrainModeSolid(getWorldFloor());
        else if (mode === 'grass') await setTerrainModeGrassPBR(getWorldFloor());
        else if (mode === 'custom') loadInput?.click();
        setTerrainRepeat(getWorldFloor(), parseFloat(repeatIn?.value ?? 28));
        updateSummary();
    });

    colorIn?.addEventListener('input', () => {
        setTerrainTint(getWorldFloor(), colorIn.value);
        updateSummary();
    });

    repeatIn?.addEventListener('input', () => {
        const v = parseFloat(repeatIn.value);
        if (repeatVal) repeatVal.textContent = String(v);
        setTerrainRepeat(getWorldFloor(), v);
    });

    roughIn?.addEventListener('input', () => {
        const v = parseFloat(roughIn.value);
        if (roughVal) roughVal.textContent = v.toFixed(2);
        setTerrainRoughness(getWorldFloor(), v);
    });

    loadBtn?.addEventListener('click', () => loadInput?.click());
    loadInput?.addEventListener('change', () => {
        const file = loadInput.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            setTerrainCustomImage(getWorldFloor(), reader.result);
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
        if (getGrassField()?.setVisible) getGrassField().setVisible(enabled);
        else if (getGrassField()?.mesh) getGrassField().mesh.visible = enabled;
        grassOn?.classList.toggle('viewer-toggle-btn-active', enabled);
        grassOff?.classList.toggle('viewer-toggle-btn-active', !enabled);
    };
    grassOn?.addEventListener('click', () => setGrassEnabled(true));
    grassOff?.addEventListener('click', () => setGrassEnabled(false));

    const applyGrassColors = () => {
        if (!getGrassField()) return;
        const base = new THREE.Color(grassBase?.value ?? '#2f5a1c');
        const tip = new THREE.Color(grassTip?.value ?? '#a8d96b');
        getGrassField().setColors?.(base, tip);
    };
    grassBase?.addEventListener('input', applyGrassColors);
    grassTip?.addEventListener('input', applyGrassColors);

    grassWind?.addEventListener('input', () => {
        const v = parseFloat(grassWind.value);
        if (grassWindVal) grassWindVal.textContent = v.toFixed(2);
        getGrassField()?.setWind?.(1, 0.3, v);
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
        if (!file || !getGrassField()) return;
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                await getGrassField().setSpriteFromUrl?.(reader.result);
                if (spriteStatus) spriteStatus.textContent = `Loaded: ${file.name}`;
            } catch (err) {
                console.error('Grass sprite load failed', err);
                if (spriteStatus) spriteStatus.textContent = `Failed to load ${file.name}`;
            }
        };
        reader.readAsDataURL(file);
    });
    spriteClearBtn?.addEventListener('click', () => {
        getGrassField()?.clearSprite?.();
        if (spriteStatus) spriteStatus.textContent = 'Sprite cleared — using procedural blades.';
    });

    spriteTintIn?.addEventListener('input', () => {
        const v = parseFloat(spriteTintIn.value);
        if (spriteTintVal) spriteTintVal.textContent = v.toFixed(2);
        getGrassField()?.setSpriteTint?.(v);
    });

    alphaCutoffIn?.addEventListener('input', () => {
        const v = parseFloat(alphaCutoffIn.value);
        if (alphaCutoffVal) alphaCutoffVal.textContent = v.toFixed(2);
        getGrassField()?.setAlphaTest?.(v);
    });

    updateSummary();
}
