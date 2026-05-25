// Boot-time wiring of the world-env / post-process / shadow-debug / perf-mode
// panels. All addEventListener glue, no logic. Lifted out of init() to keep
// the boot function focused on orchestration.
//
// Every dep is injected so this module has zero module-scope state. Late-
// bound module-scope `let` vars (lightmapBaker, postProcessVolumeManager)
// are passed as getter functions; the panel handlers fire at user
// interaction time, well after those are initialized.

export function wirePanelHandlers(opts) {
    const {
        THREE,
        worldEnvUiRefs, worldEnvState,
        postProcessUiRefs, postProcessUiState, shadowDebugUiRefs, perfModeUiRefs,
        debugConsoleInput,
        getLightmapBaker, getPostProcessVolumeManager,
        loadWorldEnvFromStorage, applyWorldEnvState,
        resetWorldEnvDefaults, setWorldEnvMaster,
        syncPostProcessVolumeUi,
        updatePostProcessSliderLabels, applyPostProcessSettingsFromUi,
        setForceAllSceneMeshShadowsEnabled, forceAllSceneMeshShadows,
        updateShadowDebugUi,
        setPerfModeEnabled, updatePerfModeUi,
        renderDebugConsoleOutput, handleDebugConsoleInputKeydown,
    } = opts;

    // ── Lightmap bake controls ────────────────────────────────────────────
    if (worldEnvUiRefs.bakeRes && worldEnvUiRefs.bakeResValue) {
        worldEnvUiRefs.bakeRes.addEventListener('input', () => {
            worldEnvUiRefs.bakeResValue.textContent = worldEnvUiRefs.bakeRes.value;
        });
    }
    if (worldEnvUiRefs.bakeSamples && worldEnvUiRefs.bakeSamplesValue) {
        worldEnvUiRefs.bakeSamples.addEventListener('input', () => {
            worldEnvUiRefs.bakeSamplesValue.textContent = worldEnvUiRefs.bakeSamples.value;
        });
    }
    if (worldEnvUiRefs.bakeRun) {
        worldEnvUiRefs.bakeRun.addEventListener('click', async () => {
            const lightmapBaker = getLightmapBaker();
            if (!lightmapBaker) return;
            const btn = worldEnvUiRefs.bakeRun;
            const status = worldEnvUiRefs.bakeStatus;
            const requestedResolution = parseInt(worldEnvUiRefs.bakeRes?.value || '16', 10);
            const requestedSamples = parseInt(worldEnvUiRefs.bakeSamples?.value || '4', 10);
            const resolution = THREE.MathUtils.clamp(Number.isFinite(requestedResolution) ? requestedResolution : 16, 16, 512);
            const samples = THREE.MathUtils.clamp(Number.isFinite(requestedSamples) ? requestedSamples : 4, 1, 64);
            if (lightmapBaker.isActive()) {
                lightmapBaker.cancel();
                btn.textContent = 'Cancelling...';
                if (status) status.textContent = 'Cancelling bake...';
                return;
            }
            btn.disabled = false;
            btn.textContent = 'Cancel Bake';
            if (status) {
                const clamped = resolution !== requestedResolution || samples !== requestedSamples;
                status.textContent = clamped
                    ? `Preparing CPU bake (${resolution}px, ${samples} samples; clamped for safety)...`
                    : 'Preparing CPU bake...';
            }
            try {
                const result = await lightmapBaker.start({
                    resolution,
                    samples,
                    maxBounces: 2,
                    onProgress: (progress) => {
                        if (!status) return;
                        const meshIndex = (progress.index ?? 0) + 1;
                        const meshTotal = progress.total ?? 0;
                        const texel = Math.round((progress.texel ?? 0) * 100);
                        status.textContent = `Baking ${meshIndex}/${meshTotal}: ${progress.name || 'mesh'} ${texel}%`;
                    },
                });
                if (status) {
                    if (result?.refused) {
                        status.textContent = result.reason || 'Bake refused: scene too large.';
                    } else {
                        status.textContent = result?.cancelled
                            ? 'Bake cancelled.'
                            : `Baked ${result?.meshCount ?? 0} meshes at ${result?.resolution ?? resolution}px, ${result?.samples ?? samples} samples.`;
                    }
                }
            } catch (e) {
                console.error('[Lightmap] start failed', e);
                if (status) status.textContent = `Bake failed: ${e.message}`;
            } finally {
                btn.disabled = false;
                btn.textContent = 'Bake Lightmaps';
            }
        });
    }
    if (worldEnvUiRefs.bakeClear) {
        worldEnvUiRefs.bakeClear.addEventListener('click', () => {
            getLightmapBaker()?.clear();
            if (worldEnvUiRefs.bakeStatus) worldEnvUiRefs.bakeStatus.textContent = 'Lightmaps cleared.';
        });
    }

    renderDebugConsoleOutput();
    debugConsoleInput?.addEventListener('keydown', handleDebugConsoleInputKeydown);

    // ── Post-process panel: target select, sliders, place/remove volume ────
    postProcessUiRefs?.targetGlobalBtn?.addEventListener('click', () => {
        postProcessUiState.target = 'global';
        syncPostProcessVolumeUi();
    });
    postProcessUiRefs?.targetVolumeBtn?.addEventListener('click', () => {
        postProcessUiState.target = 'volume';
        syncPostProcessVolumeUi();
    });

    [
        postProcessUiRefs?.exposureInput,
        postProcessUiRefs?.bloomStrengthInput,
        postProcessUiRefs?.bloomRadiusInput,
        postProcessUiRefs?.bloomThresholdInput,
        postProcessUiRefs?.blendSpeedInput,
    ].forEach((input) => {
        input?.addEventListener('input', () => {
            updatePostProcessSliderLabels();
            applyPostProcessSettingsFromUi({ reloadInputs: false });
        });
    });

    [
        postProcessUiRefs?.priorityInput,
        postProcessUiRefs?.sizeXInput,
        postProcessUiRefs?.sizeYInput,
        postProcessUiRefs?.sizeZInput,
    ].forEach((input) => {
        input?.addEventListener('change', () => {
            applyPostProcessSettingsFromUi({ reloadInputs: false });
        });
    });

    postProcessUiRefs?.placeVolumeBtn?.addEventListener('click', () => {
        postProcessUiState.target = 'volume';
        applyPostProcessSettingsFromUi({ createVolumeIfNeeded: true, placeVolumeAtCamera: true, reloadInputs: true });
    });
    postProcessUiRefs?.removeVolumeBtn?.addEventListener('click', () => {
        const mgr = getPostProcessVolumeManager();
        mgr?.removeEditorVolume?.();
        mgr?.update?.(1);
        syncPostProcessVolumeUi();
    });
    postProcessUiRefs?.toggleBoundsBtn?.addEventListener('click', () => {
        const mgr = getPostProcessVolumeManager();
        const snapshot = mgr?.getSnapshot?.();
        mgr?.setDebugVisible?.(!snapshot?.debugVisible);
        syncPostProcessVolumeUi({ reloadInputs: false });
    });
    postProcessUiRefs?.applyBtn?.addEventListener('click', () => {
        applyPostProcessSettingsFromUi({ createVolumeIfNeeded: postProcessUiState.target === 'volume', reloadInputs: true });
    });

    // ── Shadow debug + perf mode ──────────────────────────────────────────
    shadowDebugUiRefs?.forceOffBtn?.addEventListener('click', () => {
        setForceAllSceneMeshShadowsEnabled(false);
    });
    shadowDebugUiRefs?.forceOnBtn?.addEventListener('click', () => {
        setForceAllSceneMeshShadowsEnabled(true);
    });
    shadowDebugUiRefs?.applyBtn?.addEventListener('click', () => {
        forceAllSceneMeshShadows();
    });
    updateShadowDebugUi();

    perfModeUiRefs?.offBtn?.addEventListener('click', () => {
        setPerfModeEnabled(false);
    });
    perfModeUiRefs?.onBtn?.addEventListener('click', () => {
        setPerfModeEnabled(true);
    });
    updatePerfModeUi();

    // ── World Environment panel: load saved state, wire all togglers +
    //    sliders, then call applyWorldEnvState once so the engine boots into
    //    the user's last-saved configuration. Each handler mutates the
    //    relevant slice of worldEnvState then re-applies — keeps the UI and
    //    runtime in sync without duplicating logic.
    loadWorldEnvFromStorage();

    const wireToggle = (offBtn, onBtn, getStateOff, getStateOn) => {
        offBtn?.addEventListener('click', () => { getStateOff(); applyWorldEnvState(); });
        onBtn?.addEventListener('click', () => { getStateOn(); applyWorldEnvState(); });
    };
    const wireSlider = (input, key, setter, parser = parseFloat) => {
        input?.addEventListener('input', () => {
            const v = parser(input.value);
            if (Number.isFinite(v)) {
                setter(v);
                applyWorldEnvState({ switchSky: false });
            }
        });
    };

    worldEnvUiRefs?.masterOnBtn?.addEventListener('click', () => setWorldEnvMaster('on'));
    worldEnvUiRefs?.masterOffBtn?.addEventListener('click', () => setWorldEnvMaster('off'));
    worldEnvUiRefs?.masterPerfBtn?.addEventListener('click', () => setWorldEnvMaster('perf'));
    worldEnvUiRefs?.masterDebugOffBtn?.addEventListener('click', () => setWorldEnvMaster('debug-off'));
    worldEnvUiRefs?.resetBtn?.addEventListener('click', () => resetWorldEnvDefaults());

    wireToggle(worldEnvUiRefs?.skyOff, worldEnvUiRefs?.skyOn,
        () => { worldEnvState.sky.enabled = false; },
        () => { worldEnvState.sky.enabled = true; });
    worldEnvUiRefs?.skyPreset?.addEventListener('change', () => {
        worldEnvState.sky.preset = worldEnvUiRefs.skyPreset.value;
        applyWorldEnvState();
    });
    wireSlider(worldEnvUiRefs?.skyBlurriness, 'sky.blurriness', (v) => { worldEnvState.sky.blurriness = v; });

    wireToggle(worldEnvUiRefs?.ambientOff, worldEnvUiRefs?.ambientOn,
        () => { worldEnvState.ambient.enabled = false; },
        () => { worldEnvState.ambient.enabled = true; });
    wireSlider(worldEnvUiRefs?.ambientIntensity, 'ambient.intensity', (v) => { worldEnvState.ambient.intensity = v; });

    wireToggle(worldEnvUiRefs?.hemiOff, worldEnvUiRefs?.hemiOn,
        () => { worldEnvState.hemi.enabled = false; },
        () => { worldEnvState.hemi.enabled = true; });
    wireSlider(worldEnvUiRefs?.hemiIntensity, 'hemi.intensity', (v) => { worldEnvState.hemi.intensity = v; });

    wireToggle(worldEnvUiRefs?.sunOff, worldEnvUiRefs?.sunOn,
        () => { worldEnvState.sun.enabled = false; },
        () => { worldEnvState.sun.enabled = true; });
    worldEnvUiRefs?.sunShadow?.addEventListener('change', () => {
        worldEnvState.sun.castShadow = !!worldEnvUiRefs.sunShadow.checked;
        applyWorldEnvState({ switchSky: false });
    });
    wireSlider(worldEnvUiRefs?.sunIntensity, 'sun.intensity', (v) => { worldEnvState.sun.intensity = v; });

    wireSlider(worldEnvUiRefs?.exposure, 'tonemap.exposure', (v) => { worldEnvState.tonemap.exposure = v; });

    wireToggle(worldEnvUiRefs?.aaOff, worldEnvUiRefs?.aaOn,
        () => { worldEnvState.aa.enabled = false; },
        () => { worldEnvState.aa.enabled = true; });

    wireToggle(worldEnvUiRefs?.renderResolutionOff, worldEnvUiRefs?.renderResolutionOn,
        () => { worldEnvState.renderResolution.enabled = false; },
        () => { worldEnvState.renderResolution.enabled = true; });
    wireSlider(worldEnvUiRefs?.renderResolutionScale, 'renderResolution.scale',
        (v) => { worldEnvState.renderResolution.scale = v; });
    wireSlider(worldEnvUiRefs?.renderResolutionMaxDpr, 'renderResolution.maxDpr',
        (v) => { worldEnvState.renderResolution.maxDpr = v; });

    wireToggle(worldEnvUiRefs?.adaptiveOff, worldEnvUiRefs?.adaptiveOn,
        () => { worldEnvState.adaptive.enabled = false; },
        () => { worldEnvState.adaptive.enabled = true; });

    wireToggle(worldEnvUiRefs?.bloomOff, worldEnvUiRefs?.bloomOn,
        () => { worldEnvState.bloom.enabled = false; },
        () => { worldEnvState.bloom.enabled = true; });
    wireSlider(worldEnvUiRefs?.bloomStrength, 'bloom.strength', (v) => { worldEnvState.bloom.strength = v; });
    wireSlider(worldEnvUiRefs?.bloomRadius, 'bloom.radius', (v) => { worldEnvState.bloom.radius = v; });
    wireSlider(worldEnvUiRefs?.bloomThreshold, 'bloom.threshold', (v) => { worldEnvState.bloom.threshold = v; });

    wireToggle(worldEnvUiRefs?.ssaoOff, worldEnvUiRefs?.ssaoOn,
        () => { worldEnvState.ssao.enabled = false; },
        () => { worldEnvState.ssao.enabled = true; });
    wireSlider(worldEnvUiRefs?.ssaoIntensity, 'ssao.intensity', (v) => { worldEnvState.ssao.intensity = v; });
    wireSlider(worldEnvUiRefs?.ssaoRadius, 'ssao.radius', (v) => { worldEnvState.ssao.radius = v; });

    wireToggle(worldEnvUiRefs?.ssrOff, worldEnvUiRefs?.ssrOn,
        () => { worldEnvState.ssr.enabled = false; },
        () => { worldEnvState.ssr.enabled = true; });
    wireSlider(worldEnvUiRefs?.ssrIntensity, 'ssr.intensity', (v) => { worldEnvState.ssr.intensity = v; });
    wireSlider(worldEnvUiRefs?.ssrMaxDistance, 'ssr.maxDistance', (v) => { worldEnvState.ssr.maxDistance = v; });
    wireSlider(worldEnvUiRefs?.ssrThickness, 'ssr.thickness', (v) => { worldEnvState.ssr.thickness = v; });
    wireSlider(worldEnvUiRefs?.ssrQuality, 'ssr.quality', (v) => { worldEnvState.ssr.quality = v; });

    wireToggle(worldEnvUiRefs?.probeOff, worldEnvUiRefs?.probeOn,
        () => { worldEnvState.reflectionProbe.enabled = false; },
        () => { worldEnvState.reflectionProbe.enabled = true; });
    wireSlider(worldEnvUiRefs?.probeIntensity, 'reflectionProbe.intensity', (v) => { worldEnvState.reflectionProbe.intensity = v; });
    wireSlider(worldEnvUiRefs?.probeRadius, 'reflectionProbe.radius', (v) => { worldEnvState.reflectionProbe.radius = v; });

    wireToggle(worldEnvUiRefs?.volOff, worldEnvUiRefs?.volOn,
        () => { worldEnvState.volumetric.enabled = false; },
        () => { worldEnvState.volumetric.enabled = true; });
    wireSlider(worldEnvUiRefs?.volDensity, 'volumetric.density', (v) => { worldEnvState.volumetric.density = v; });
    wireSlider(worldEnvUiRefs?.volHeight, 'volumetric.heightFalloff', (v) => { worldEnvState.volumetric.heightFalloff = v; });
    wireSlider(worldEnvUiRefs?.volSun, 'volumetric.sunIntensity', (v) => { worldEnvState.volumetric.sunIntensity = v; });
    wireSlider(worldEnvUiRefs?.volAniso, 'volumetric.anisotropy', (v) => { worldEnvState.volumetric.anisotropy = v; });

    wireToggle(worldEnvUiRefs?.ssgiOff, worldEnvUiRefs?.ssgiOn,
        () => { worldEnvState.ssgi.enabled = false; },
        () => { worldEnvState.ssgi.enabled = true; });

    wireToggle(worldEnvUiRefs?.fogOff, worldEnvUiRefs?.fogOn,
        () => { worldEnvState.fog.enabled = false; },
        () => { worldEnvState.fog.enabled = true; });
    wireSlider(worldEnvUiRefs?.fogDensity, 'fog.density', (v) => { worldEnvState.fog.density = v; });
    wireSlider(worldEnvUiRefs?.fogOpacity, 'fog.opacity', (v) => { worldEnvState.fog.opacity = v; });

    wireToggle(worldEnvUiRefs?.ddgiOff, worldEnvUiRefs?.ddgiOn,
        () => { worldEnvState.ddgi.enabled = false; },
        () => { worldEnvState.ddgi.enabled = true; });
    wireToggle(worldEnvUiRefs?.ddgiLiveBakeOff, worldEnvUiRefs?.ddgiLiveBakeOn,
        () => { worldEnvState.ddgi.liveBake = false; },
        () => { worldEnvState.ddgi.liveBake = true; });
    wireSlider(worldEnvUiRefs?.ddgiBakeEveryN, 'ddgi.bakeEveryN',
        (v) => {
            worldEnvState.ddgi.bakeEveryN = Math.max(1, Math.round(v));
            worldEnvState.ddgi.probesPerFrame = worldEnvState.ddgi.bakeEveryN;
        }, (s) => parseInt(s, 10));
    wireSlider(worldEnvUiRefs?.ddgiIntensity, 'ddgi.intensity', (v) => { worldEnvState.ddgi.intensity = v; });
    wireSlider(worldEnvUiRefs?.ddgiSpecular, 'ddgi.specularIntensity', (v) => { worldEnvState.ddgi.specularIntensity = v; });
    wireSlider(worldEnvUiRefs?.ddgiLightIntensity, 'ddgi.lightIntensity', (v) => { worldEnvState.ddgi.lightIntensity = v; });
    wireToggle(worldEnvUiRefs?.ddgiProbeDebugOff, worldEnvUiRefs?.ddgiProbeDebugOn,
        () => { worldEnvState.ddgi.debugProbes = false; },
        () => { worldEnvState.ddgi.debugProbes = true; });
    wireToggle(worldEnvUiRefs?.ddgiRayDebugOff, worldEnvUiRefs?.ddgiRayDebugOn,
        () => { worldEnvState.ddgi.rayDebug = false; },
        () => { worldEnvState.ddgi.rayDebug = true; });
    wireToggle(worldEnvUiRefs?.ddgiSolidTestOff, worldEnvUiRefs?.ddgiSolidTestOn,
        () => { worldEnvState.ddgi.solidTest = false; },
        () => { worldEnvState.ddgi.solidTest = true; });
    wireToggle(worldEnvUiRefs?.ddgiViewLit, worldEnvUiRefs?.ddgiViewContribution,
        () => { worldEnvState.ddgi.contributionView = false; },
        () => { worldEnvState.ddgi.contributionView = true; });

    wireToggle(worldEnvUiRefs?.shadowsOff, worldEnvUiRefs?.shadowsOn,
        () => { worldEnvState.shadows.enabled = false; },
        () => { worldEnvState.shadows.enabled = true; });
    wireSlider(worldEnvUiRefs?.shadowsBias, 'shadows.bias', (v) => { worldEnvState.shadows.bias = v; });
    wireSlider(worldEnvUiRefs?.shadowsNormalBias, 'shadows.normalBias', (v) => { worldEnvState.shadows.normalBias = v; });
    wireSlider(worldEnvUiRefs?.shadowsRadius, 'shadows.radius', (v) => { worldEnvState.shadows.radius = v; });
    wireSlider(worldEnvUiRefs?.shadowsMapSize, 'shadows.mapSize', (v) => { worldEnvState.shadows.mapSize = v | 0; });

    wireToggle(worldEnvUiRefs?.lightCullOff, worldEnvUiRefs?.lightCullOn,
        () => { worldEnvState.lightCull.enabled = false; },
        () => { worldEnvState.lightCull.enabled = true; });
    wireSlider(worldEnvUiRefs?.lightCullMax, 'lightCull.maxActive',
        (v) => { worldEnvState.lightCull.maxActive = Math.max(1, Math.round(v)); }, (s) => parseInt(s, 10));

    wireToggle(worldEnvUiRefs?.pomOff, worldEnvUiRefs?.pomOn,
        () => { worldEnvState.pom.enabled = false; },
        () => { worldEnvState.pom.enabled = true; });
    wireSlider(worldEnvUiRefs?.pomIntensity, 'pom.intensity', (v) => { worldEnvState.pom.intensity = v; });
    // Quality is a 3-button mutually-exclusive group; clicking any one sets
    // the matching string and re-applies. Wired manually because wireToggle
    // only handles 2-state pairs.
    const setPomQuality = (q) => {
        worldEnvState.pom.quality = q;
        applyWorldEnvState();
    };
    worldEnvUiRefs?.pomQualityLow?.addEventListener('click', () => setPomQuality('low'));
    worldEnvUiRefs?.pomQualityMedium?.addEventListener('click', () => setPomQuality('medium'));
    worldEnvUiRefs?.pomQualityHigh?.addEventListener('click', () => setPomQuality('high'));

    // Apply once now that all controllers + UI are wired. Pushes the
    // (possibly-restored-from-localStorage) state through every subsystem and
    // syncs the panel display. Any controllers not yet ready are no-ops
    // thanks to the optional-chaining inside applyWorldEnvState.
    applyWorldEnvState({ persist: false });
}
