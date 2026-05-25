// One-shot post-processing pipeline construction. Called from init() right
// after scene/camera/renderer/sceneSystem exist. Returns the freshly-built
// instances so the runtime can store them in its module-scope handles.
//
// Steps: scenePass → bloom node (with name-sanitization workaround for
// WebGPU validation) → RenderPipeline → DDGI/lightmap init.

import {
    materialMetalness, materialRoughness,
    mrt, normalView, pass, vec4, velocity,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { RenderPipeline } from 'three/webgpu';
import { createReflectionProbe } from '../world/lighting/reflectionProbe.js';
import { createVolumetricLighting } from '../world/lighting/volumetricLightingNode.js';

export function setupPostProcessing(opts) {
    const {
        scene, camera, renderer, sceneSystem, mainDirectionalLight,
        globalPostProcessUniforms,
        applySSGISettings, applySSAOSettings, rebuildPostProcessingOutputNode,
        createPostProcessVolumeManager, syncPostProcessVolumeUi,
        getDDGIManager, createLightmapBaker,
        registerDebug,
    } = opts;

    // NOTE: keep the main scene pass single-target. The forward lighting pass is
    // the stable one that feeds shadows, bloom, and GTAO. Temporal AA gets its
    // motion vectors from a dedicated auxiliary pass instead of forcing extra MRT
    // attachments onto the main beauty pass.
    const scenePass = pass(scene, camera);
    const sceneColor = scenePass.getTextureNode('output');
    const sceneDepth = scenePass.getTextureNode('depth');


    // Auxiliary SSR scene-data pass. Dormant until SSR consumes it, but keeps
    // the forward beauty pass shadow-safe. RGB stores view normal; A carries
    // roughness. A second target keeps roughness/metalness cheap to
    // sample without unpacking normals.
    const normalMaterialPass = pass(scene, camera);
    normalMaterialPass.setMRT(mrt({
        output: vec4(0, 0, 0, 1),
        normalMaterial: vec4(normalView, materialRoughness),
        materialData: vec4(materialRoughness, materialMetalness, 0, 1),
    }));
    const sceneNormalMaterial = normalMaterialPass.getTextureNode('normalMaterial');
    const sceneMaterialData = normalMaterialPass.getTextureNode('materialData');

    // Auxiliary motion-vector pass for temporal AA. It re-renders the scene with
    // the original materials so alpha masking/discard stays correct, but only
    // writes an inert color target plus velocity.
    const velocityPass = pass(scene, camera);
    velocityPass.setMRT(mrt({
        output: vec4(0, 0, 0, 1),
        velocity,
    }));
    const sceneVelocity = velocityPass.getTextureNode('velocity');

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

    const ssrNode = ssr(
        sceneColor,
        sceneDepth,
        sceneNormalMaterial,
        sceneMaterialData.g,
        sceneNormalMaterial.a,
        camera,
    );
    ssrNode.opacity.value = 0.95;
    ssrNode.maxDistance.value = 16.0;
    ssrNode.thickness.value = 0.65;
    ssrNode.quality.value = 0.85;
    ssrNode.resolutionScale = 1.0;
    // Sphere reflection probe. Reflection SOURCE = scene.environment PMREM
    // (read live), sphere-parallax corrected. Doubles as the SSR fallback: where
    // the SSR ray misses (a < 1) the probe fills in, so off-screen/sky
    // reflections no longer vanish. The probe G-buffer inputs are the same MRT
    // targets SSR consumes (depth, view normal, roughness in normal.a).
    const reflectionProbe = createReflectionProbe({
        getEnvironment: () => scene.environment || null,
    });
    // SSR composited with the probe fallback (vec4 reflection to ADD on top of
    // the lit scene, same role as the raw ssrNode add).
    const ssrProbeNode = reflectionProbe.composeSSRWithProbe(ssrNode, {
        depthNode: sceneDepth,
        viewNormalNode: sceneNormalMaterial,
        roughnessNode: sceneNormalMaterial.a,
    });

    // Volumetric lighting / height fog. Analytic directional in-scatter applied
    // over the lit scene BEFORE tonemap+bloom so bright sun haze blooms. Built
    // as a function of the (already SSR/probe-composited) lit color so reflections
    // are fogged correctly; the runtime swaps which lit-color input it wraps.
    const volumetric = createVolumetricLighting();

    const traaNode = traa(sceneColor, sceneDepth, sceneVelocity, camera);
    const traaSsrNode = traa(sceneColor.add(ssrNode), sceneDepth, sceneVelocity, camera);
    const traaSsrProbeNode = traa(sceneColor.add(ssrProbeNode), sceneDepth, sceneVelocity, camera);

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
    sanitize(traaNode?._historyRenderTarget);
    sanitize(traaNode?._resolveRenderTarget);
    sanitize(traaSsrNode?._historyRenderTarget);
    sanitize(traaSsrNode?._resolveRenderTarget);
    sanitize(traaSsrProbeNode?._historyRenderTarget);
    sanitize(traaSsrProbeNode?._resolveRenderTarget);
    sanitize(ssrNode?._ssrRenderTarget);
    sanitize(ssrNode?._blurRenderTarget);

    const postProcessing = new RenderPipeline(renderer);
    const postProcessRenderData = {
        main: { pass: scenePass, color: sceneColor, depth: sceneDepth },
        normalMaterial: {
            pass: normalMaterialPass,
            texture: sceneNormalMaterial,
            materialTexture: sceneMaterialData,
        },
        velocity: { pass: velocityPass, texture: sceneVelocity },
        history: {
            colorA: traaNode?._historyRenderTarget?.texture ?? null,
            colorB: traaNode?._resolveRenderTarget?.texture ?? null,
            valid: false,
        },
        jitter: { frame: 0, x: 0, y: 0 },
        taa: {
            node: traaNode,
            nodeWithSSR: traaSsrNode,
            nodeWithSSRProbe: traaSsrProbeNode,
            output: traaNode?.getTextureNode?.() ?? traaNode,
            enabled: false,
            resetHistory() {
                if (postProcessRenderData.history) postProcessRenderData.history.valid = false;
                if (traaNode && Number.isFinite(traaNode._jitterIndex)) traaNode._jitterIndex = 0;
                if (traaSsrNode && Number.isFinite(traaSsrNode._jitterIndex)) traaSsrNode._jitterIndex = 0;
                if (traaSsrProbeNode && Number.isFinite(traaSsrProbeNode._jitterIndex)) traaSsrProbeNode._jitterIndex = 0;
            },
        },
        ssr: {
            node: ssrNode,
            output: ssrNode?.getTextureNode?.() ?? ssrNode,
            enabled: false,
        },
        reflectionProbe: {
            instance: reflectionProbe,
            node: ssrProbeNode,
            enabled: false,
        },
        volumetric: {
            instance: volumetric,
            enabled: false,
        },
    };
    const postProcessNodes = {
        sceneColor, sceneDepth,
        sceneNormalMaterial, sceneMaterialData, normalMaterialPass,
        sceneVelocity, velocityPass,
        bloomNode, aoNode, aoOutput, traaNode, traaSsrNode, traaSsrProbeNode, ssrNode,
        ssrOutput: ssrNode?.getTextureNode?.() ?? ssrNode,
        reflectionProbe, ssrProbeNode,
        volumetric,
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
    registerDebug('reflectionProbe', reflectionProbe);
    registerDebug('volumetricLighting', volumetric);
    registerDebug('lightmapBaker', lightmapBaker);
    registerDebug('postProcessRenderData', postProcessRenderData);
    // Entity bridge debug handle:
    //   __POLYFLOW_DEBUG__.scene.getEntity(id),
    //   __POLYFLOW_DEBUG__.scene.entityFromObject3D(obj).
    registerDebug('scene', sceneSystem);

    return { postProcessing, postProcessNodes, postProcessRenderData, postProcessVolumeManager, lightmapBaker };
}
