// One-shot post-processing pipeline construction. Called from init() right
// after scene/camera/renderer/sceneSystem exist. Returns the freshly-built
// instances so the runtime can store them in its module-scope handles.
//
// Steps: MRT scenePass → bloom node (with name-sanitization workaround for
// WebGPU validation) → SSGI node → RenderPipeline → DDGI/lightmap init.

import { pass, mrt, output, emissive, normalView } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { RenderPipeline } from 'three/webgpu';

export function setupPostProcessing(opts) {
    const {
        scene, camera, renderer, sceneSystem, mainDirectionalLight,
        globalPostProcessUniforms,
        applySSGISettings, rebuildPostProcessingOutputNode,
        createPostProcessVolumeManager, syncPostProcessVolumeUi,
        getDDGIManager, createLightmapBaker,
        registerDebug,
    } = opts;

    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({
        output: output,
        emissive: emissive,
        normal: normalView,
    }));
    const sceneColor = scenePass.getTextureNode('output');
    const sceneEmissive = scenePass.getTextureNode('emissive');
    const sceneNormal = scenePass.getTextureNode('normal');
    const sceneDepth = scenePass.getTextureNode('depth');

    // Bloom from the HDR scene COLOR (not the emissive MRT). The emissive MRT
    // channel carried low-level noise on non-emissive surfaces; bloom amplified
    // it into grain on everything. Blooming the scene color and letting the
    // luminance threshold isolate bright pixels is the standard approach: only
    // genuinely bright pixels (emissive lights, whose emissiveIntensity makes
    // them HDR-bright) bloom; dim lit surfaces stay below threshold → no grain.
    const bloomNode = bloom(
        sceneColor,
        globalPostProcessUniforms.bloomStrength,
        globalPostProcessUniforms.bloomRadius,
        globalPostProcessUniforms.bloomThreshold,
    );

    // BloomNode names its internal render-target textures "UnrealBloomPass.*".
    // The WebGPU backend uses texture.name as the GPU resource label, and
    // Dawn rejects '.' in labels → uncaught validation errors on boot that
    // break bloom. Drop the "Unreal" prefix and the '.' so the labels are
    // valid (e.g. "BloomPass_bright"). Done in place (can't patch node_modules).
    const sanitize = (rt) => {
        const tex = rt?.texture;
        if (tex?.name) tex.name = tex.name.replace(/^Unreal/, '').replace(/\./g, '_');
    };
    sanitize(bloomNode?._renderTargetBright);
    (bloomNode?._renderTargetsHorizontal || []).forEach(sanitize);
    (bloomNode?._renderTargetsVertical || []).forEach(sanitize);

    const ssgiNode = ssgi(sceneColor, sceneDepth, sceneNormal, camera);
    // Temporal filtering converges the SSGI noise across frames. Without it the
    // raw GI is heavily grainy (it needs a manual DenoiseNode otherwise), which
    // showed up as static grain across the sky + walls. The sliceCount/stepCount
    // presets we use (1/12) are the recommended "Low" preset for temporal-on.
    ssgiNode.useTemporalFiltering = true;
    const ssgiOutput = ssgiNode.getTextureNode();

    const postProcessing = new RenderPipeline(renderer);
    const postProcessNodes = { sceneColor, bloomNode, ssgiNode, ssgiOutput };
    applySSGISettings();
    rebuildPostProcessingOutputNode();

    const postProcessVolumeManager = createPostProcessVolumeManager({
        scene, camera, renderer,
        globalUniforms: globalPostProcessUniforms,
    });
    syncPostProcessVolumeUi();

    getDDGIManager().init({
        scene, renderer, camera,
        getDirectionalLight: () => mainDirectionalLight,
    });
    const lightmapBaker = createLightmapBaker({
        scene,
        getDirectionalLight: () => mainDirectionalLight,
    });

    registerDebug('ddgi', getDDGIManager());
    registerDebug('lightmapBaker', lightmapBaker);
    // Entity bridge debug handle:
    //   __POLYFLOW_DEBUG__.scene.getEntity(id),
    //   __POLYFLOW_DEBUG__.scene.entityFromObject3D(obj).
    registerDebug('scene', sceneSystem);

    return { postProcessing, postProcessNodes, postProcessVolumeManager, lightmapBaker };
}
