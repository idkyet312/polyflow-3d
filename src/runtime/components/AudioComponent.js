import * as THREE from 'three';
import { ActorComponent } from './ActorComponent.js';

function isAudioBuffer(value) {
    return typeof AudioBuffer !== 'undefined' && value instanceof AudioBuffer;
}

export class AudioComponent extends ActorComponent {
    static componentKey = 'AudioComponent';

    constructor({
        positional = true,
        autoplay = false,
        loop = false,
        volume = 1,
        playbackRate = 1,
        refDistance = 1,
        maxDistance = 40,
        rolloffFactor = 1,
        sound = '',
    } = {}) {
        super();

        this.positional = positional;
        this.autoplay = autoplay;
        this.loop = loop;
        this.volume = volume;
        this.playbackRate = playbackRate;
        this.refDistance = refDistance;
        this.maxDistance = maxDistance;
        this.rolloffFactor = rolloffFactor;

        this._audioRuntime = null;
        this._sound = null;
        this._buffer = null;
        this._source = sound || '';
        this._loadPromise = null;
    }

    beginPlay() {
        this._ensureSoundNode();
        if (this._source && !this._buffer) {
            this.setSound(this._source, { autoplay: this.autoplay }).catch((error) => {
                console.warn('[AudioComponent] Failed to load sound.', error);
            });
        } else if (this.autoplay && this._buffer) {
            this.play();
        }
    }

    endPlay() {
        this.stop();
        if (this._sound?.parent) {
            this._sound.parent.remove(this._sound);
        }
        this._sound?.disconnect?.();
        this._sound = null;
        this._loadPromise = null;
    }

    setAudioRuntime(runtime) {
        this._audioRuntime = runtime ?? null;
        this._ensureSoundNode();
        return this;
    }

    getSound() {
        return this._source || this._buffer || null;
    }

    async setSound(soundOrUrl, { autoplay = this.autoplay } = {}) {
        if (!soundOrUrl) {
            this.stop();
            this._source = '';
            this._buffer = null;
            if (this._sound) {
                this._sound.setBuffer(null);
            }
            return null;
        }

        if (isAudioBuffer(soundOrUrl)) {
            this._source = '';
            this._applyBuffer(soundOrUrl, autoplay);
            return soundOrUrl;
        }

        const url = String(soundOrUrl);
        const loader = this._audioRuntime?.loader ?? null;
        if (!loader) {
            throw new Error('Audio loader unavailable.');
        }

        this._source = url;
        this._loadPromise = new Promise((resolve, reject) => {
            loader.load(
                url,
                (buffer) => {
                    if (this._source !== url) {
                        resolve(buffer);
                        return;
                    }
                    this._applyBuffer(buffer, autoplay);
                    resolve(buffer);
                },
                undefined,
                reject,
            );
        });

        return this._loadPromise;
    }

    play(delay = 0) {
        const sound = this._ensureSoundNode();
        if (!sound || !this._buffer) {
            return false;
        }

        this._audioRuntime?.resume?.();

        if (sound.isPlaying) {
            sound.stop();
        }

        try {
            sound.play(delay);
            return true;
        } catch (error) {
            console.warn('[AudioComponent] Failed to play sound.', error);
            return false;
        }
    }

    stop() {
        if (this._sound?.isPlaying) {
            this._sound.stop();
        }
        return this;
    }

    isPlaying() {
        return !!this._sound?.isPlaying;
    }

    setLoop(loop) {
        this.loop = !!loop;
        this._sound?.setLoop(this.loop);
        return this;
    }

    setVolume(volume) {
        const nextVolume = Number(volume);
        this.volume = Number.isFinite(nextVolume) ? THREE.MathUtils.clamp(nextVolume, 0, 4) : 1;
        this._sound?.setVolume(this.volume);
        return this;
    }

    setPlaybackRate(rate) {
        const nextRate = Number(rate);
        this.playbackRate = Number.isFinite(nextRate) ? THREE.MathUtils.clamp(nextRate, 0.05, 4) : 1;
        this._sound?.setPlaybackRate(this.playbackRate);
        return this;
    }

    setPositional(positional) {
        const nextPositional = !!positional;
        if (this.positional === nextPositional) {
            return this;
        }

        this.positional = nextPositional;
        const buffer = this._buffer;
        const wasPlaying = this.isPlaying();
        this.endPlay();
        this._ensureSoundNode();
        if (buffer) {
            this._applyBuffer(buffer, wasPlaying);
        }
        return this;
    }

    setAttenuation({ refDistance, maxDistance, rolloffFactor } = {}) {
        if (Number.isFinite(refDistance)) this.refDistance = refDistance;
        if (Number.isFinite(maxDistance)) this.maxDistance = maxDistance;
        if (Number.isFinite(rolloffFactor)) this.rolloffFactor = rolloffFactor;

        if (this._sound?.isPositionalAudio) {
            this._sound.setRefDistance(this.refDistance);
            this._sound.setMaxDistance(this.maxDistance);
            this._sound.setRolloffFactor(this.rolloffFactor);
        }

        return this;
    }

    playTone(frequency = 440, duration = 0.2, type = 'sine') {
        const audioContext = this._audioRuntime?.listener?.context ?? null;
        if (!audioContext) {
            return false;
        }

        const sampleRate = audioContext.sampleRate || 44100;
        const clampedDuration = Math.max(0.01, Number(duration) || 0.2);
        const frameCount = Math.max(1, Math.floor(sampleRate * clampedDuration));
        const buffer = audioContext.createBuffer(1, frameCount, sampleRate);
        const channelData = buffer.getChannelData(0);
        const omega = (Math.PI * 2 * (Number(frequency) || 440)) / sampleRate;

        for (let index = 0; index < frameCount; index++) {
            const progress = index / frameCount;
            const envelope = Math.sin(progress * Math.PI);
            if (type === 'square') {
                channelData[index] = Math.sign(Math.sin(omega * index)) * envelope * 0.2;
            } else if (type === 'saw') {
                channelData[index] = ((((index * (Number(frequency) || 440)) / sampleRate) % 1) * 2 - 1) * envelope * 0.12;
            } else {
                channelData[index] = Math.sin(omega * index) * envelope * 0.18;
            }
        }

        this._source = '';
        this._applyBuffer(buffer, true);
        return true;
    }

    _applyBuffer(buffer, autoplay = false) {
        this._buffer = buffer ?? null;
        const sound = this._ensureSoundNode();
        if (!sound || !buffer) {
            return;
        }

        const wasPlaying = sound.isPlaying;
        if (wasPlaying) {
            sound.stop();
        }

        sound.setBuffer(buffer);
        sound.setLoop(this.loop);
        sound.setVolume(this.volume);
        sound.setPlaybackRate(this.playbackRate);
        if (sound.isPositionalAudio) {
            sound.setRefDistance(this.refDistance);
            sound.setMaxDistance(this.maxDistance);
            sound.setRolloffFactor(this.rolloffFactor);
        }

        if (autoplay || wasPlaying) {
            this.play();
        }
    }

    _ensureSoundNode() {
        const listener = this._audioRuntime?.listener ?? null;
        if (!listener) {
            return null;
        }

        const needsNewNode = !this._sound || (!!this._sound.isPositionalAudio !== !!this.positional);
        if (needsNewNode) {
            const existingBuffer = this._buffer;
            if (this._sound?.parent) {
                this._sound.parent.remove(this._sound);
            }
            this._sound?.disconnect?.();
            this._sound = this.positional ? new THREE.PositionalAudio(listener) : new THREE.Audio(listener);
            if (existingBuffer) {
                this._applyBuffer(existingBuffer, false);
            }
        }

        const target = this.owner?.mesh ?? this.owner?.rootNode?.object3D ?? null;
        if (target && this._sound.parent !== target) {
            this._sound.parent?.remove(this._sound);
            target.add(this._sound);
        }

        this._sound.setLoop(this.loop);
        this._sound.setVolume(this.volume);
        this._sound.setPlaybackRate(this.playbackRate);
        if (this._sound.isPositionalAudio) {
            this._sound.setRefDistance(this.refDistance);
            this._sound.setMaxDistance(this.maxDistance);
            this._sound.setRolloffFactor(this.rolloffFactor);
        }

        return this._sound;
    }
}