import * as THREE from 'three';

export function createObjectLifecycle({ animationMixers }) {
    function getObjectAnimationClips(root) {
        if (!root) return [];

        const clips = [];
        const seen = new Set();
        const addClip = (clip) => {
            if (!clip || seen.has(clip.uuid || clip.name)) return;
            seen.add(clip.uuid || clip.name);
            clips.push(clip);
        };

        root.animations?.forEach(addClip);
        root.traverse?.((child) => child.animations?.forEach(addClip));
        return clips;
    }

    function stopObjectAnimations(root) {
        const entry = animationMixers.get(root);
        if (!entry) return;

        entry.mixer.stopAllAction();
        entry.mixer.uncacheRoot(root);
        animationMixers.delete(root);
    }

    function playObjectAnimation(root, clipName = '') {
        const clips = getObjectAnimationClips(root);
        if (!clips.length) return null;

        stopObjectAnimations(root);

        const clip = clipName
            ? THREE.AnimationClip.findByName(clips, clipName) || clips[0]
            : clips[0];
        const mixer = new THREE.AnimationMixer(root);
        const action = mixer.clipAction(clip);
        action.reset();
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
        action.enabled = true;
        action.play();

        root.userData.animation = {
            ...(root.userData.animation || {}),
            activeClip: clip.name || '',
            clipNames: clips.map((entry) => entry.name || 'Animation'),
            playing: true,
        };
        animationMixers.set(root, { mixer, action, clips });
        return action;
    }

    function updateObjectAnimations(delta) {
        animationMixers.forEach((entry) => entry.mixer.update(delta));
    }

    function disposeRenderableObject(root) {
        if (!root) return;

        stopObjectAnimations(root);

        const disposeMaterial = (material) => {
            if (!material) return;
            const ownedMaps = material.userData?.ownedMaps;
            if (Array.isArray(ownedMaps)) {
                ownedMaps.forEach((map) => map?.dispose?.());
            }
            material.dispose?.();
        };

        root.traverse((child) => {
            if (!child.isMesh) return;

            child.geometry?.dispose();

            if (Array.isArray(child.material)) {
                child.material.forEach(disposeMaterial);
            } else {
                disposeMaterial(child.material);
            }
        });
    }

    return {
        disposeRenderableObject,
        getObjectAnimationClips,
        playObjectAnimation,
        stopObjectAnimations,
        updateObjectAnimations,
    };
}
