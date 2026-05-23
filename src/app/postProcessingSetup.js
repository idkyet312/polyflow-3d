// One-shot post-processing pipeline construction. Called from init() right
// after scene/camera/renderer/sceneSystem exist. Returns the freshly-built
// instances so the runtime can store them in its module-scope handles.
//
// Steps: scenePass → bloom node (with name-sanitization workaround for
// WebGPU validation) → RenderPipeline → DDGI/lightmap init.

import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { RenderPipeline } from 'three/webgpu';

export function setupPostProcessing(opts) {
    const {
        scene, camera, renderer, sceneSystem, mainDirectionalLight,
        globalPostProcessUniforms,
        applySSGISettings, applySSAOSettings, rebuildPostProcessingOutputNode,
        createPostProcessVolumeManager, syncPostProcessVolumeUi,
        getDDGIManager, createLightmapBaker,
        registerDebug,
    } = opts;

    // NOTE: no scene-pass MRT. SSR/TAA need extra G-buffer targets (normal/
    // metalness/roughness/velocity), but setting a multi-target MRT on the scene
    // pass also applies to the shadow-map renders that three runs INSIDE the
    // scene render (CSM cascades, spot depth) — their depth materials only write
    // one target, so WebGPU rejects the pipeline ("targets[1] no fragment
    // output"). That breaks all shadows. Bloom + GTAO work from color+depth only
    // (depth is always available), so the post stack stays single-target + safe.
    const scenePass = pass(scene, camera);
    const sceneColor = scenePass.getTextureNode('output');
    const sceneDepth = scenePass.getTextureNode('depth');

    // Ground Truth Ambient Occlusion (GTAO) — contact-shadow darkening in
    // creases/corners. Reconstructs normals from depth (null normalNode) → no
    // extra MRT needed.
    const aoNode = ao(sceneDepth, null, camera);
    const aoOutput = aoNode.getTextureNode();

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

    const postProcessing = new RenderPipeline(renderer);
    const postProcessNodes = {
        sceneColor, sceneDepth, bloomNode, aoNode, aoOutput,
        ssgiNode: null, ssgiOutput: null,
    };
    applySSGISettings();
    applySSAOSettings();
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
