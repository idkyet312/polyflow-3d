// Shadow-debug tooling, extracted from src/app/runtime.js.
//
// The "force all scene meshes to cast/receive shadows" debug feature: a manual
// scene-wide sweep (Apply Now) plus an auto-reapply mode that re-sweeps newly
// spawned meshes on an interval. Drives the World Options shadow-debug panel
// status text + toggle button highlight.
//
//   const shadowDebug = createShadowDebug({
//       getShadowDebugState: () => shadowDebugState,    // shared, injected elsewhere
//       getShadowDebugUiRefs: () => shadowDebugUiRefs,  // assigned during init
//   });
//   shadowDebug.tickForceAllSceneMeshShadows();         // from the frame loop
//
// shadowDebugState + shadowDebugUiRefs stay in runtime.js: the state object is
// injected by-reference into setupDebugConsole / wirePanelHandlers, and the UI
// refs are built mid-init. These helpers only read them, via getters, so the
// shared references keep working. scene + renderer are read live via core.

import { core } from '../runtime/appCore.js';

export function createShadowDebug({
    getShadowDebugState = () => null,
    getShadowDebugUiRefs = () => null,
} = {}) {
    function formatShadowDebugStatus() {
        const shadowDebugState = getShadowDebugState();
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
        const shadowDebugUiRefs = getShadowDebugUiRefs();
        if (!shadowDebugUiRefs) return;

        const shadowDebugState = getShadowDebugState();
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
        const shadowDebugState = getShadowDebugState();
        const { scene, renderer } = core;
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
        const shadowDebugState = getShadowDebugState();
        shadowDebugState.forceAllMeshes = !!isEnabled;
        const result = shadowDebugState.forceAllMeshes ? forceAllSceneMeshShadows() : null;
        updateShadowDebugUi();
        return result;
    }

    function tickForceAllSceneMeshShadows() {
        const shadowDebugState = getShadowDebugState();
        if (!shadowDebugState.forceAllMeshes) return;
        if ((performance.now() - shadowDebugState.lastAppliedAt) < shadowDebugState.autoApplyIntervalMs) return;
        forceAllSceneMeshShadows();
    }

    return {
        formatShadowDebugStatus,
        updateShadowDebugUi,
        isShadowForceExcludedObject,
        forceAllSceneMeshShadows,
        setForceAllSceneMeshShadowsEnabled,
        tickForceAllSceneMeshShadows,
    };
}
