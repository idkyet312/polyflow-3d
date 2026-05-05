// src/audio/vehicleEngineAudio.js
// Extracted from main.js lines 673–1766.
// Vehicle engine audio subsystem: speaker test tones, positional sound helpers,
// legacy Web Audio engine synthesis, wasm engine-sound worklet integration,
// and audio debug overlay.
import * as THREE from 'three';
import {
    createTestSoundBuffer,
    createMediaTestSoundUrl,
    createEngineNoiseBuffer,
    createCombustionPulseBuffer,
    createCombustionDistortionCurve,
} from './synthesis.js';
import {
    SoundGeneratorAudioListener,
    EngineSoundGenerator as WasmEngineSoundGenerator,
} from '../../vendor/engine-sound/sound_generator_worklet_wasm.js';

// Module-scope deps populated by setupVehicleEngineAudio.
let scene, camera, vehicleState, vehicleEngineAudio, runtimeAudio, runtimeHud,
    vehicleFx, engineAudioDebugEl,
    VEHICLE_SETTINGS, TEST_SOUND_ID,
    getRuntimeHud, isDrivingVehicle, getActiveVehicleProp,
    gameplay, objectScriptState, playTestSoundStatus,
    getDynamicPropById, getActorRenderObject, getActorBody;

export function setupVehicleEngineAudio(deps) {
    ({
        scene, camera, vehicleState, vehicleEngineAudio, runtimeAudio,
        runtimeHud, vehicleFx, engineAudioDebugEl,
        VEHICLE_SETTINGS, TEST_SOUND_ID,
        getRuntimeHud, isDrivingVehicle, getActiveVehicleProp,
        gameplay, objectScriptState, playTestSoundStatus,
        getDynamicPropById, getActorRenderObject, getActorBody,
    } = deps);
}

// Allow main.js to update engineAudioDebugEl after initial setup
// (the element may be created after the first setupVehicleEngineAudio call).
export function setEngineAudioDebugEl(el) {
    engineAudioDebugEl = el;
}

export async function playSpeakerTestTone({ frequency = 660, duration = 0.55, volume = 0.22 } = {}) {
    const audioContext = runtimeAudio.listener?.context ?? null;
    if (!audioContext) {
        return false;
    }

    await runtimeAudio.resume();

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const startTime = audioContext.currentTime + 0.01;
    const endTime = startTime + Math.max(0.08, duration);

    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(frequency, startTime);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(220, frequency * 0.72), endTime);

    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.02, volume), startTime + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, endTime);

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.start(startTime);
    oscillator.stop(endTime + 0.02);
    oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
    };

    return true;
}

export async function playMediaElementTestSound() {
    if (typeof Audio === 'undefined') {
        return false;
    }

    if (!runtimeAudio.mediaTestUrl) {
        runtimeAudio.mediaTestUrl = createMediaTestSoundUrl();
    }

    const audio = new Audio(runtimeAudio.mediaTestUrl);
    audio.preload = 'auto';
    audio.volume = 1;

    try {
        await audio.play();
        return true;
    } catch (error) {
        console.warn('Failed to play media-element test sound.', error);
        return false;
    }
}

export function resolveSoundLocation(location, fallbackDistance = 3) {
    if (location?.isVector3) {
        return location.clone();
    }

    if (location && typeof location === 'object' && Number.isFinite(location.x) && Number.isFinite(location.y) && Number.isFinite(location.z)) {
        return new THREE.Vector3(location.x, location.y, location.z);
    }

    if (camera) {
        const worldLocation = new THREE.Vector3();
        const forward = new THREE.Vector3();
        camera.getWorldPosition(worldLocation);
        camera.getWorldDirection(forward);
        worldLocation.addScaledVector(forward, fallbackDistance);
        return worldLocation;
    }

    return new THREE.Vector3();
}

export function cleanupTransientAudio(anchor, sound) {
    if (!anchor) return;

    runtimeAudio.transientAnchors.delete(anchor);
    if (sound?.isPlaying) {
        sound.stop();
    }
    if (sound?.parent === anchor) {
        anchor.remove(sound);
    }
    sound?.disconnect?.();
    if (anchor.parent === scene) {
        scene.remove(anchor);
    }
}

export function clampVehicleEngineRpm(value) {
    return THREE.MathUtils.clamp(
        value,
        vehicleEngineAudio.minRpm,
        vehicleEngineAudio.maxRpm,
    );
}


export function resetVehicleEngineAudioState() {
    vehicleEngineAudio.activePropId = '';
    vehicleEngineAudio.rpm = vehicleEngineAudio.idleRpm;
    vehicleEngineAudio.targetRpm = vehicleEngineAudio.idleRpm;
    vehicleEngineAudio.gear = 1;
    vehicleEngineAudio.throttle = 0;
    vehicleEngineAudio.lastThrottle = 0;
    vehicleEngineAudio.overrun = 0;
    vehicleEngineAudio.lastGrounded = false;
    vehicleEngineAudio.backend = vehicleEngineAudio.wasmGenerator
        ? 'wasm'
        : vehicleEngineAudio.outputGain
            ? 'js'
            : 'none';
    vehicleEngineAudio.crackleCooldown = 0;
    vehicleEngineAudio.lastWorldPosition.set(0, 0, 0);
    vehicleEngineAudio.velocity.set(0, 0, 0);
}

export function createVehicleEngineWasmParameters() {
    // Values cribbed from the upstream demo's stable preset
    // (vendor/engine-sound-src/src/engine_sound_generator/sounds_worklet_wasm.htm:90).
    // The waveguide simulation is sensitive to reflection-factor build-up;
    // higher coefficients or longer guides cause the internal state to ring
    // out into silence (or NaN) after a few seconds, which is what the
    // "worked for 3 seconds then died" symptom looks like.
    return {
        cylinders: 4,
        intakeWaveguideLength: 100,
        exhaustWaveguideLength: 100,
        extractorWaveguideLength: 100,
        intakeOpenReflectionFactor: 0.01,
        intakeClosedReflectionFactor: 0.95,
        exhaustOpenReflectionFactor: 0.01,
        exhaustClosedReflectionFactor: 0.95,
        ignitionTime: 0.016,
        straightPipeWaveguideLength: 128,
        straightPipeReflectionFactor: 0.01,
        mufflerElementsLength: [10, 15, 20, 25],
        action: 0.1,
        outletWaveguideLength: 5,
        outletReflectionFactor: 0.01,
    };
}

export function describeVehicleEngineWasmError(error) {
    const message = error?.message ? String(error.message) : String(error ?? 'Unknown error');
    if (
        error?.name === 'AbortError'
        || message.includes('Unable to load a worklet')
        || message.includes('environment detection error')
        || message.includes('Chrome v2147483647')
    ) {
        return 'The vendored engine-sound worklet is still built for shell-only Emscripten output, so AudioWorklet startup aborts before the wasm engine can run.';
    }
    return message;
}

export function markVehicleEngineWasmUnavailable(error) {
    const reason = describeVehicleEngineWasmError(error);
    const shouldLog = !vehicleEngineAudio.wasmFailed || vehicleEngineAudio.wasmFailureReason !== reason;
    vehicleEngineAudio.wasmModuleReady = false;
    vehicleEngineAudio.wasmFailed = true;
    vehicleEngineAudio.wasmFailureReason = reason;
    if (shouldLog) {
        console.warn('Vehicle engine wasm audio unavailable. Falling back to legacy engine audio.', reason, error);
    }
    shutdownVehicleEngineAudioWasm();
}

export function shutdownVehicleEngineAudioWasm() {
    const generator = vehicleEngineAudio.wasmGenerator;
    vehicleEngineAudio.wasmGenerator = null;
    vehicleEngineAudio.wasmThrottleParam = null;
    vehicleEngineAudio.wasmRpmParam = null;

    if (!generator) {
        return;
    }

    try { generator.stop(); } catch (_) {}
    try { generator.disconnect(); } catch (_) {}
    try { generator.removeFromParent(); } catch (_) {}
}

export function primeVehicleEngineAudioWasm() {
    const listener = runtimeAudio.listener;
    const audioContext = listener?.context ?? null;
    if (!listener || !audioContext || vehicleEngineAudio.wasmModuleReady || vehicleEngineAudio.wasmFailed || vehicleEngineAudio.wasmLoadPromise) {
        return vehicleEngineAudio.wasmLoadPromise;
    }

    const loadingManager = new THREE.LoadingManager();
    vehicleEngineAudio.wasmLoadPromise = WasmEngineSoundGenerator.load(
        loadingManager,
        listener,
    )
        .then(() => {
            vehicleEngineAudio.wasmModuleReady = true;
            vehicleEngineAudio.wasmFailureReason = '';
            return true;
        })
        .catch((error) => {
            markVehicleEngineWasmUnavailable(error);
            return false;
        })
        .finally(() => {
            vehicleEngineAudio.wasmLoadPromise = null;
        });

    return vehicleEngineAudio.wasmLoadPromise;
}

export function shutdownLegacyVehicleEngineAudio() {
    const context = runtimeAudio.listener?.context ?? null;
    const now = context?.currentTime ?? 0;
    const fadeOutTime = now + 0.08;

    if (vehicleEngineAudio.outputGain) {
        const gain = vehicleEngineAudio.outputGain.gain;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(Math.max(0.0001, gain.value || 0.0001), now);
        gain.exponentialRampToValueAtTime(0.0001, fadeOutTime);
    }

    const sourceNodes = [
        vehicleEngineAudio.combustionNode,
        vehicleEngineAudio.harmonic2Node,
        vehicleEngineAudio.harmonic3Node,
        vehicleEngineAudio.bodyNode,
        vehicleEngineAudio.subNode,
        vehicleEngineAudio.whineNode,
        vehicleEngineAudio.noiseNode,
        vehicleEngineAudio.crackleNode,
        vehicleEngineAudio.idleLfo,
    ];
    sourceNodes.forEach((node) => {
        if (!node) return;
        try { node.stop(fadeOutTime + 0.02); } catch (_) {}
        try { node.disconnect(); } catch (_) {}
    });

    const otherNodes = [
        vehicleEngineAudio.combustionGain,
        vehicleEngineAudio.harmonic2Gain,
        vehicleEngineAudio.harmonic3Gain,
        vehicleEngineAudio.bodyGain,
        vehicleEngineAudio.subGain,
        vehicleEngineAudio.whineGain,
        vehicleEngineAudio.intakeGain,
        vehicleEngineAudio.overrunGain,
        vehicleEngineAudio.crackleGain,
        vehicleEngineAudio.crackleEnvelope,
        vehicleEngineAudio.idleLfoGain,
        vehicleEngineAudio.idleLfoOffset,
        vehicleEngineAudio.outputGain,
        vehicleEngineAudio.compressor,
        vehicleEngineAudio.waveShaper,
        vehicleEngineAudio.exhaustFilter,
        vehicleEngineAudio.resonancePeak,
        vehicleEngineAudio.resonanceFilter,
        vehicleEngineAudio.intakeFilter,
        vehicleEngineAudio.hissFilter,
        vehicleEngineAudio.cabinFilter,
        vehicleEngineAudio.masterTone,
        vehicleEngineAudio.panner,
    ];
    otherNodes.forEach((node) => {
        if (!node) return;
        try { node.disconnect(); } catch (_) {}
    });

    [
        'combustionNode', 'harmonic2Node', 'harmonic3Node', 'bodyNode', 'subNode', 'whineNode', 'noiseNode',
        'crackleNode', 'idleLfo',
        'combustionGain', 'harmonic2Gain', 'harmonic3Gain', 'bodyGain', 'subGain', 'whineGain',
        'intakeGain', 'overrunGain', 'crackleGain', 'crackleEnvelope', 'idleLfoGain', 'idleLfoOffset',
        'outputGain', 'compressor', 'waveShaper',
        'exhaustFilter', 'resonancePeak', 'resonanceFilter', 'intakeFilter', 'hissFilter', 'cabinFilter', 'masterTone',
        'panner', 'listener',
    ].forEach((key) => { vehicleEngineAudio[key] = null; });
    resetVehicleEngineAudioState();
}

export function shutdownVehicleEngineAudio() {
    shutdownVehicleEngineAudioWasm();
    shutdownLegacyVehicleEngineAudio();
    vehicleEngineAudio.backend = 'none';
}

// Soft-silence the engine audio without tearing down the wasm worklet.
// Called when gameplay drops out so the worklet stays loaded for the next
// drive session (avoids re-initialising the AudioWorklet on every reseat).
export function silenceVehicleEngineAudio() {
    const ctx = runtimeAudio.listener?.context ?? null;
    const now = ctx?.currentTime ?? 0;
    const fadeOut = now + 0.12;

    const generator = vehicleEngineAudio.wasmGenerator;
    if (generator?.gain?.gain) {
        const gain = generator.gain.gain;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(Math.max(0.0001, gain.value || 0.0001), now);
        gain.exponentialRampToValueAtTime(0.0001, fadeOut);
    }
    if (vehicleEngineAudio.outputGain) {
        const gain = vehicleEngineAudio.outputGain.gain;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(Math.max(0.0001, gain.value || 0.0001), now);
        gain.exponentialRampToValueAtTime(0.0001, fadeOut);
    }
    resetVehicleEngineAudioState();
}

export function ensureLegacyVehicleEngineAudio() {
    const listener = runtimeAudio.listener;
    const audioContext = listener?.context ?? null;
    const listenerInput = typeof listener?.getInput === 'function' ? listener.getInput() : null;
    if (!listener || !audioContext) {
        return null;
    }

    if (vehicleEngineAudio.outputGain && vehicleEngineAudio.listener === listener) {
        vehicleEngineAudio.backend = 'js';
        return vehicleEngineAudio;
    }

    shutdownLegacyVehicleEngineAudio();

    // ── Spatializer ──────────────────────────────────────────────────────────────
    const panner = audioContext.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 5;
    panner.maxDistance = 120;
    panner.rolloffFactor = 0.85;
    panner.coneInnerAngle = 200;
    panner.coneOuterAngle = 320;
    panner.coneOuterGain = 0.72;

    // ── Master output ────────────────────────────────────────────────────────────
    const outputGain = audioContext.createGain();
    outputGain.gain.value = 0.0001;

    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -22;
    compressor.knee.value = 18;
    compressor.ratio.value = 2.4;
    compressor.attack.value = 0.012;
    compressor.release.value = 0.22;

    const waveShaper = audioContext.createWaveShaper();
    waveShaper.curve = createCombustionDistortionCurve(0.15);
    waveShaper.oversample = '4x';

    // Master tone-tamer — rolls off upper harshness, keeps Warthog growl below ~1.6 kHz.
    const masterTone = audioContext.createBiquadFilter();
    masterTone.type = 'lowpass';
    masterTone.frequency.value = 1600;
    masterTone.Q.value = 0.5;

    const cabinFilter = audioContext.createBiquadFilter();
    cabinFilter.type = 'lowshelf';
    cabinFilter.frequency.value = 280;
    cabinFilter.gain.value = 8;

    // ── Exhaust path (combustion thump + harmonics) ──────────────────────────────
    const exhaustFilter = audioContext.createBiquadFilter();
    exhaustFilter.type = 'lowpass';
    exhaustFilter.frequency.value = 360;
    exhaustFilter.Q.value = 0.9;

    const resonancePeak = audioContext.createBiquadFilter();
    resonancePeak.type = 'peaking';
    resonancePeak.frequency.value = 130;
    resonancePeak.Q.value = 3.0;
    resonancePeak.gain.value = 6;

    const resonanceFilter = audioContext.createBiquadFilter();
    resonanceFilter.type = 'lowpass';
    resonanceFilter.frequency.value = 800;
    resonanceFilter.Q.value = 0.7;

    // Combustion: looped pulse buffer at firing freq → throaty individual cylinder thumps.
    const combustionBuffer = createCombustionPulseBuffer(audioContext);
    const combustionNode = audioContext.createBufferSource();
    combustionNode.buffer = combustionBuffer;
    combustionNode.loop = true;
    combustionNode.playbackRate.value = 1;
    const combustionGain = audioContext.createGain();
    combustionGain.gain.value = 0.0001;

    // 2nd-order harmonic — triangle (gentler than saw, fewer high partials).
    const harmonic2Node = audioContext.createOscillator();
    harmonic2Node.type = 'triangle';
    harmonic2Node.frequency.value = 90;
    const harmonic2Gain = audioContext.createGain();
    harmonic2Gain.gain.value = 0.0001;

    // 3rd-order harmonic — sine (just adds gentle warmth, no buzz).
    const harmonic3Node = audioContext.createOscillator();
    harmonic3Node.type = 'sine';
    harmonic3Node.frequency.value = 130;
    const harmonic3Gain = audioContext.createGain();
    harmonic3Gain.gain.value = 0.0001;

    // Sub-octave for chest-thump body.
    const subNode = audioContext.createOscillator();
    subNode.type = 'sine';
    subNode.frequency.value = 32;
    const subGain = audioContext.createGain();
    subGain.gain.value = 0.0001;

    // Mid-body resonance (triangle).
    const bodyNode = audioContext.createOscillator();
    bodyNode.type = 'triangle';
    bodyNode.frequency.value = 110;
    const bodyGain = audioContext.createGain();
    bodyGain.gain.value = 0.0001;

    // ── Intake path (gear/belt rumble + soft turbulence) ─────────────────────────
    const intakeFilter = audioContext.createBiquadFilter();
    intakeFilter.type = 'bandpass';
    intakeFilter.frequency.value = 420;
    intakeFilter.Q.value = 0.9;

    const hissFilter = audioContext.createBiquadFilter();
    hissFilter.type = 'bandpass';
    hissFilter.frequency.value = 800;
    hissFilter.Q.value = 0.7;

    const whineNode = audioContext.createOscillator();
    whineNode.type = 'triangle';
    whineNode.frequency.value = 140;
    const whineGain = audioContext.createGain();
    whineGain.gain.value = 0.0001;

    const noiseBuffer = createEngineNoiseBuffer(audioContext);
    const noiseNode = audioContext.createBufferSource();
    noiseNode.buffer = noiseBuffer;
    noiseNode.loop = true;

    const intakeGain = audioContext.createGain();
    intakeGain.gain.value = 0.0001;

    const overrunGain = audioContext.createGain();
    overrunGain.gain.value = 0.0001;

    // Crackle/pop on overrun — separate noise tap with its own envelope.
    const crackleNode = audioContext.createBufferSource();
    crackleNode.buffer = noiseBuffer;
    crackleNode.loop = true;
    const crackleEnvelope = audioContext.createGain();
    crackleEnvelope.gain.value = 0.0001;
    const crackleGain = audioContext.createGain();
    crackleGain.gain.value = 0.18;

    // Idle LFO — slow wobble on combustion gain so idle isn't flat. Adds to combustionGain.gain.
    const idleLfo = audioContext.createOscillator();
    idleLfo.type = 'sine';
    idleLfo.frequency.value = 4.6;
    const idleLfoGain = audioContext.createGain();
    idleLfoGain.gain.value = 0;
    const idleLfoOffset = null;

    // ── Wiring ───────────────────────────────────────────────────────────────────
    // Combustion thump path
    combustionNode.connect(combustionGain);
    combustionGain.connect(exhaustFilter);
    harmonic2Node.connect(harmonic2Gain);
    harmonic2Gain.connect(exhaustFilter);
    harmonic3Node.connect(harmonic3Gain);
    harmonic3Gain.connect(exhaustFilter);
    bodyNode.connect(bodyGain);
    bodyGain.connect(resonancePeak);
    exhaustFilter.connect(resonancePeak);
    resonancePeak.connect(resonanceFilter);
    resonanceFilter.connect(waveShaper);

    // Sub thump goes around the saturator to keep low end clean.
    subNode.connect(subGain);
    subGain.connect(cabinFilter);

    // Intake path
    whineNode.connect(whineGain);
    whineGain.connect(intakeFilter);
    noiseNode.connect(intakeGain);
    intakeGain.connect(intakeFilter);
    intakeFilter.connect(panner);

    // Overrun hiss
    noiseNode.connect(overrunGain);
    overrunGain.connect(hissFilter);
    hissFilter.connect(panner);

    // Crackle path — gated noise into hiss filter for snappy pops.
    crackleNode.connect(crackleEnvelope);
    crackleEnvelope.connect(crackleGain);
    crackleGain.connect(hissFilter);

    // Saturated combustion + clean sub merge into cabin lowshelf.
    waveShaper.connect(cabinFilter);
    cabinFilter.connect(panner);

    // Idle LFO adds wobble directly to combustionGain.gain.
    idleLfo.connect(idleLfoGain);
    idleLfoGain.connect(combustionGain.gain);

    panner.connect(compressor);
    compressor.connect(masterTone);
    masterTone.connect(outputGain);
    outputGain.connect(listenerInput ?? audioContext.destination);

    const startTime = audioContext.currentTime + 0.01;
    combustionNode.start(startTime);
    harmonic2Node.start(startTime);
    harmonic3Node.start(startTime);
    bodyNode.start(startTime);
    subNode.start(startTime);
    whineNode.start(startTime);
    noiseNode.start(startTime);
    crackleNode.start(startTime);
    idleLfo.start(startTime);

    Object.assign(vehicleEngineAudio, {
        listener,
        combustionNode, harmonic2Node, harmonic3Node, bodyNode, subNode, whineNode, noiseNode,
        crackleNode, idleLfo,
        combustionGain, harmonic2Gain, harmonic3Gain, bodyGain, subGain, whineGain,
        intakeGain, overrunGain, crackleGain, crackleEnvelope, idleLfoGain, idleLfoOffset,
        outputGain, compressor, waveShaper, masterTone,
        exhaustFilter, resonancePeak, resonanceFilter, intakeFilter, hissFilter, cabinFilter,
        panner,
    });
    vehicleEngineAudio.rpm = vehicleEngineAudio.idleRpm;
    vehicleEngineAudio.targetRpm = vehicleEngineAudio.idleRpm;
    vehicleEngineAudio.gear = 1;
    vehicleEngineAudio.throttle = 0;
    vehicleEngineAudio.lastThrottle = 0;
    vehicleEngineAudio.overrun = 0;
    vehicleEngineAudio.crackleCooldown = 0;
    vehicleEngineAudio.lastWorldPosition.set(0, 0, 0);
    vehicleEngineAudio.velocity.set(0, 0, 0);
    vehicleEngineAudio.backend = 'js';
    return vehicleEngineAudio;
}

export function ensureVehicleEngineAudioWasm(vehicle) {
    const listener = runtimeAudio.listener;
    const audioContext = listener?.context ?? null;
    const mesh = vehicle?.mesh ?? null;
    if (!listener || !audioContext || !mesh || !vehicleEngineAudio.wasmModuleReady || vehicleEngineAudio.wasmFailed) {
        return null;
    }

    const existingGenerator = vehicleEngineAudio.wasmGenerator;
    if (existingGenerator && vehicleEngineAudio.listener === listener) {
        if (existingGenerator.parent !== mesh) {
            vehicleEngineAudio.wasmReattachCount = (vehicleEngineAudio.wasmReattachCount || 0) + 1;
            console.warn('[wasm-engine] reparenting generator (count=', vehicleEngineAudio.wasmReattachCount, ')');
            try { existingGenerator.removeFromParent(); } catch (_) {}
            mesh.add(existingGenerator);
            existingGenerator.position.set(0, 0.45, 0);
            existingGenerator.reset?.();
        }
        vehicleEngineAudio.backend = 'wasm';
        return vehicleEngineAudio;
    }

    vehicleEngineAudio.wasmCreateCount = (vehicleEngineAudio.wasmCreateCount || 0) + 1;
    console.warn('[wasm-engine] creating new generator (count=', vehicleEngineAudio.wasmCreateCount, ')');
    shutdownLegacyVehicleEngineAudio();
    shutdownVehicleEngineAudioWasm();

    let generator;
    try {
        generator = new WasmEngineSoundGenerator({
            listener,
            parameters: createVehicleEngineWasmParameters(),
        });
    } catch (error) {
        markVehicleEngineWasmUnavailable(error);
        return null;
    }

    const throttleParam = generator.worklet?.parameters?.get('throttle') ?? null;
    const rpmParam = generator.worklet?.parameters?.get('rpm') ?? null;

    Object.assign(vehicleEngineAudio, {
        listener,
        wasmGenerator: generator,
        wasmThrottleParam: throttleParam,
        wasmRpmParam: rpmParam,
        backend: 'wasm',
    });

    if (!throttleParam || !rpmParam) {
        markVehicleEngineWasmUnavailable(new Error('The engine sound worklet did not expose the expected throttle/rpm parameters.'));
        return null;
    }

    // Seed the AudioParams so the very first process() call has firing-range
    // RPM. Defaults are 0/0 which produces silence and (with the previous
    // clamp WaveShaper) caused the "beep then silence" symptom.
    const ctxNow = audioContext.currentTime;
    throttleParam.setValueAtTime(0, ctxNow);
    rpmParam.setValueAtTime(vehicleEngineAudio.idleRpm, ctxNow);

    // Surface worklet processor errors. AudioWorklet.process() throwing
    // silently kills the node — browser stops calling process() forever and
    // the result is "audio worked for N seconds then died" with no console
    // output. Hook the error event so we know.
    if (generator.worklet) {
        generator.worklet.onprocessorerror = (event) => {
            vehicleEngineAudio.wasmProcessorError = String(event?.message || event || 'processor error');
            console.error('[wasm-engine] AudioWorklet processor error:', event);
            markVehicleEngineWasmUnavailable(new Error(vehicleEngineAudio.wasmProcessorError));
        };
    }
    console.info('[wasm-engine] generator created. sampleRate =', audioContext.sampleRate, 'state =', audioContext.state);

    generator.name = 'vehicle-engine-wasm-audio';
    generator.position.set(0, 0.45, 0);
    generator.setRefDistance(5);
    generator.setMaxDistance(120);
    generator.setRolloffFactor(0.85);
    generator.setDirectionalCone(200, 320, 0.72);
    generator.gain.gain.value = 0.4;
    generator.gainIntake.gain.value = 0.16;
    generator.gainEngineBlockVibrations.gain.value = 0.22;
    generator.gainOutlet.gain.value = 0.3;
    mesh.add(generator);

    try {
        generator.play();
    } catch (error) {
        markVehicleEngineWasmUnavailable(error);
        return null;
    }

    resetVehicleEngineAudioState();
    return vehicleEngineAudio;
}

export function ensureVehicleEngineAudio(vehicle = null) {
    primeVehicleEngineAudioWasm();
    return ensureVehicleEngineAudioWasm(vehicle) ?? ensureLegacyVehicleEngineAudio();
}

export function updateLegacyVehicleEngineAudio(delta, vehicle, telemetry) {
    const engine = ensureLegacyVehicleEngineAudio();
    const audioContext = runtimeAudio.listener?.context ?? null;
    if (!engine || !audioContext || !vehicle?.id || !vehicle?.mesh) {
        shutdownLegacyVehicleEngineAudio();
        return;
    }

    const now = audioContext.currentTime;
    const isActiveVehicle = gameplay.active && vehicleState.activePropId === vehicle.id;
    const mesh = vehicle.mesh;
    const body = getActorBody(vehicle);
    const bodyId = body?.GetID?.() ?? null;

    if (!isActiveVehicle || !bodyId) {
        if (engine.outputGain) {
            const gain = engine.outputGain.gain;
            gain.cancelScheduledValues(now);
            gain.setValueAtTime(Math.max(0.0001, gain.value || 0.0001), now);
            gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
        }
        resetVehicleEngineAudioState();
        return;
    }

    runtimeAudio.resume();
    engine.activePropId = vehicle.id;

    const throttleInput = telemetry?.throttleInput ?? 0;
    const brakeHeld = telemetry?.brakeHeld === true;
    const grounded = telemetry?.grounded === true;
    const forwardSpeed = telemetry?.forwardSpeed ?? 0;
    const speedRatio = THREE.MathUtils.clamp(Math.abs(forwardSpeed) / VEHICLE_SETTINGS.maxDriveSpeed, 0, 1);
    const throttleDemand = Math.abs(throttleInput);
    const gearCount = 5;
    const targetGear = THREE.MathUtils.clamp(
        Math.floor(speedRatio * (gearCount - 0.15) + 1 + throttleDemand * 0.25),
        1,
        gearCount,
    );
    engine.gear = THREE.MathUtils.damp(engine.gear, targetGear, grounded ? 5.8 : 2.4, delta);
    const gearIndex = THREE.MathUtils.clamp(Math.round(engine.gear), 1, gearCount);
    const gearStartRatio = (gearIndex - 1) / gearCount;
    const gearEndRatio = gearIndex / gearCount;
    const gearBand = Math.max(0.0001, gearEndRatio - gearStartRatio);
    const gearProgress = THREE.MathUtils.clamp((speedRatio - gearStartRatio) / gearBand, 0, 1);
    const revKick = grounded ? throttleDemand * 1400 : throttleDemand * 650;
    const brakeDip = brakeHeld ? 220 : 0;
    const targetRpm = clampVehicleEngineRpm(
        engine.idleRpm + gearProgress * (engine.maxRpm - engine.idleRpm * 1.08) + revKick - brakeDip
    );
    const rpmLambda = throttleDemand > 0.04
        ? 6.5
        : brakeHeld
            ? 5.2
            : 2.8;
    engine.targetRpm = targetRpm;
    engine.rpm = THREE.MathUtils.damp(engine.rpm, targetRpm, rpmLambda, delta);
    engine.throttle = THREE.MathUtils.damp(engine.throttle, throttleDemand, grounded ? 7.5 : 3.5, delta);
    const throttleDrop = Math.max(0, engine.lastThrottle - throttleDemand);
    const overrunTarget = (!brakeHeld && throttleDemand < 0.08 && speedRatio > 0.18)
        ? THREE.MathUtils.clamp(0.22 + speedRatio * 0.9 + throttleDrop * 1.8, 0, 1)
        : 0;
    engine.overrun = THREE.MathUtils.damp(engine.overrun, overrunTarget, overrunTarget > 0 ? 9.5 : 4.5, delta);
    engine.lastThrottle = throttleDemand;
    engine.lastGrounded = grounded;

    const idleBlend = THREE.MathUtils.clamp((engine.rpm - engine.idleRpm) / 1600, 0, 1);
    const rpmRatio = THREE.MathUtils.clamp((engine.rpm - engine.minRpm) / (engine.maxRpm - engine.minRpm), 0, 1);
    // V8 4-stroke: 4 power strokes per rev → firing freq = rpm/60 * 4.
    // Halved further to land in chunky 18–140 Hz burble range so each cylinder is audible.
    const cylinders = 8;
    const firingFrequency = THREE.MathUtils.clamp((engine.rpm / 60) * (cylinders / 2), 18, 160);
    // Combustion buffer fundamental is 38 Hz; rate scales fundamental to firing freq.
    const combustionPlaybackRate = THREE.MathUtils.clamp(firingFrequency / 38, 0.45, 3.6);

    // Harmonic stack tracks combustion — kept low-mid, no top end.
    const harmonic2Frequency = firingFrequency * 1.5;
    const harmonic3Frequency = firingFrequency * 2.0;
    const subFrequency = THREE.MathUtils.clamp(firingFrequency * 0.5, 16, 70);
    const bodyFrequency = THREE.MathUtils.lerp(firingFrequency * 1.1, firingFrequency * 1.35, idleBlend);
    // No turbo whine — Warthog is naturally aspirated. This becomes a subtle gear/belt whine
    // that only appears under speed, low pitch.
    const intakeWhineFrequency = THREE.MathUtils.lerp(120, 480, Math.pow(speedRatio, 0.9));

    // ── Per-section levels — Warthog: massive low-end, throaty mids, no top whine ──
    const masterGain = 0.12 + speedRatio * 0.10 + engine.throttle * 0.16 + engine.overrun * 0.03 + (grounded ? 0.02 : 0);
    const combustionLevel = 0.36 + engine.throttle * 0.20 + speedRatio * 0.06 + idleBlend * 0.06;
    const harmonic2Level = 0.04 + engine.throttle * 0.10 + rpmRatio * 0.05;
    const harmonic3Level = 0.01 + engine.throttle * 0.05 + Math.pow(rpmRatio, 1.4) * 0.03;
    const bodyLevel = 0.10 + idleBlend * 0.10 + speedRatio * 0.06 + engine.overrun * 0.03;
    const subLevel = 0.32 + idleBlend * 0.12 + engine.throttle * 0.18;
    const whineLevel = 0.0005 + Math.max(0, speedRatio - 0.2) * 0.012;
    const intakeNoiseLevel = 0.004 + engine.throttle * 0.024 + speedRatio * 0.008;
    const overrunNoiseLevel = 0.001 + engine.overrun * 0.04 + (brakeHeld ? 0.008 : 0);

    // Filter frequencies — Warthog stays low-mid; only the upper roll-off opens with throttle.
    const exhaustFilterFrequency = 260 + rpmRatio * 320 + engine.throttle * 180;
    const resonancePeakFrequency = 110 + rpmRatio * 140 + idleBlend * 40;
    const resonanceCutoff = 600 + idleBlend * 380 + engine.throttle * 720 + speedRatio * 220;
    const intakeFilterFrequency = 360 + engine.throttle * 480 + speedRatio * 220;
    const hissCutoff = 1800 + engine.overrun * 800 + speedRatio * 400;

    // ── Apply ────────────────────────────────────────────────────────────────────
    engine.combustionNode.playbackRate.cancelScheduledValues(now);
    engine.combustionNode.playbackRate.setTargetAtTime(combustionPlaybackRate, now, 0.04);
    engine.harmonic2Node.frequency.cancelScheduledValues(now);
    engine.harmonic2Node.frequency.setTargetAtTime(harmonic2Frequency, now, 0.05);
    engine.harmonic3Node.frequency.cancelScheduledValues(now);
    engine.harmonic3Node.frequency.setTargetAtTime(harmonic3Frequency, now, 0.05);
    engine.bodyNode.frequency.cancelScheduledValues(now);
    engine.bodyNode.frequency.setTargetAtTime(bodyFrequency, now, 0.06);
    engine.subNode.frequency.cancelScheduledValues(now);
    engine.subNode.frequency.setTargetAtTime(subFrequency, now, 0.08);
    engine.whineNode.frequency.cancelScheduledValues(now);
    engine.whineNode.frequency.setTargetAtTime(intakeWhineFrequency, now, 0.06);

    engine.outputGain.gain.cancelScheduledValues(now);
    engine.outputGain.gain.setTargetAtTime(Math.max(0.0001, masterGain), now, grounded ? 0.06 : 0.12);
    engine.combustionGain.gain.cancelScheduledValues(now);
    engine.combustionGain.gain.setTargetAtTime(Math.max(0.0001, combustionLevel), now, 0.05);
    // Idle wobble LFO sums on top of combustionGain.gain; depth shrinks with throttle and revs.
    engine.idleLfoGain.gain.cancelScheduledValues(now);
    engine.idleLfoGain.gain.setTargetAtTime(0.06 * (1 - engine.throttle) * (1 - rpmRatio * 0.6), now, 0.1);

    engine.harmonic2Gain.gain.cancelScheduledValues(now);
    engine.harmonic2Gain.gain.setTargetAtTime(Math.max(0.0001, harmonic2Level), now, 0.06);
    engine.harmonic3Gain.gain.cancelScheduledValues(now);
    engine.harmonic3Gain.gain.setTargetAtTime(Math.max(0.0001, harmonic3Level), now, 0.06);
    engine.bodyGain.gain.cancelScheduledValues(now);
    engine.bodyGain.gain.setTargetAtTime(Math.max(0.0001, bodyLevel), now, 0.06);
    engine.subGain.gain.cancelScheduledValues(now);
    engine.subGain.gain.setTargetAtTime(Math.max(0.0001, subLevel), now, 0.08);
    engine.whineGain.gain.cancelScheduledValues(now);
    engine.whineGain.gain.setTargetAtTime(Math.max(0.0001, whineLevel), now, 0.06);
    engine.intakeGain.gain.cancelScheduledValues(now);
    engine.intakeGain.gain.setTargetAtTime(Math.max(0.0001, intakeNoiseLevel), now, 0.07);
    engine.overrunGain.gain.cancelScheduledValues(now);
    engine.overrunGain.gain.setTargetAtTime(Math.max(0.0001, overrunNoiseLevel), now, 0.04);

    engine.exhaustFilter.frequency.cancelScheduledValues(now);
    engine.exhaustFilter.frequency.setTargetAtTime(exhaustFilterFrequency, now, 0.05);
    engine.resonancePeak.frequency.cancelScheduledValues(now);
    engine.resonancePeak.frequency.setTargetAtTime(resonancePeakFrequency, now, 0.08);
    engine.resonancePeak.gain.cancelScheduledValues(now);
    engine.resonancePeak.gain.setTargetAtTime(2 + engine.throttle * 2, now, 0.08);
    engine.resonanceFilter.frequency.cancelScheduledValues(now);
    engine.resonanceFilter.frequency.setTargetAtTime(resonanceCutoff, now, 0.08);
    engine.intakeFilter.frequency.cancelScheduledValues(now);
    engine.intakeFilter.frequency.setTargetAtTime(intakeFilterFrequency, now, 0.07);
    engine.hissFilter.frequency.cancelScheduledValues(now);
    engine.hissFilter.frequency.setTargetAtTime(hissCutoff, now, 0.05);

    // ── Crackle / pop on lift-off — sparse and quiet, just texture ──────────────
    engine.crackleCooldown = Math.max(0, engine.crackleCooldown - delta);
    if (engine.overrun > 0.6 && engine.crackleCooldown <= 0 && Math.random() < 0.25) {
        const popTime = now + 0.005;
        const popDuration = 0.05 + Math.random() * 0.06;
        const popPeak = 0.12 + engine.overrun * 0.12 + Math.random() * 0.08;
        engine.crackleEnvelope.gain.cancelScheduledValues(popTime);
        engine.crackleEnvelope.gain.setValueAtTime(0.0001, popTime);
        engine.crackleEnvelope.gain.exponentialRampToValueAtTime(popPeak, popTime + 0.008);
        engine.crackleEnvelope.gain.exponentialRampToValueAtTime(0.0001, popTime + popDuration);
        engine.crackleCooldown = 0.18 + Math.random() * 0.32;
    }

    // ── Spatializer position + simple Doppler via velocity ──────────────────────
    const worldPosition = mesh.getWorldPosition(new THREE.Vector3());
    const worldForward = mesh.getWorldDirection(new THREE.Vector3()).normalize();
    if (delta > 0 && engine.lastWorldPosition.lengthSq() > 0) {
        engine.velocity.subVectors(worldPosition, engine.lastWorldPosition).divideScalar(delta);
    }
    engine.lastWorldPosition.copy(worldPosition);
    engine.panner.positionX.setValueAtTime(worldPosition.x, now);
    engine.panner.positionY.setValueAtTime(worldPosition.y + 0.45, now);
    engine.panner.positionZ.setValueAtTime(worldPosition.z, now);
    engine.panner.orientationX.setValueAtTime(worldForward.x, now);
    engine.panner.orientationY.setValueAtTime(worldForward.y, now);
    engine.panner.orientationZ.setValueAtTime(worldForward.z, now);
}

export function updateVehicleEngineAudioWasm(delta, vehicle, telemetry) {
    const engine = ensureVehicleEngineAudioWasm(vehicle);
    const audioContext = runtimeAudio.listener?.context ?? null;
    const generator = engine?.wasmGenerator ?? null;
    if (!engine || !generator || !audioContext || !vehicle?.id || !vehicle?.mesh) {
        // Keep the worklet alive across transient vehicle drops; just skip
        // this tick. Tearing down here was the source of "wasm engine doesn't
        // stay" — every momentary gap recycled the AudioWorkletNode.
        return false;
    }

    const now = audioContext.currentTime;
    const isActiveVehicle = gameplay.active && vehicleState.activePropId === vehicle.id;
    const body = getActorBody(vehicle);
    const bodyId = body?.GetID?.() ?? null;

    if (!isActiveVehicle || !bodyId) {
        generator.gain.gain.cancelScheduledValues(now);
        generator.gain.gain.setValueAtTime(Math.max(0.0001, generator.gain.gain.value || 0.0001), now);
        generator.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
        resetVehicleEngineAudioState();
        return true;
    }

    runtimeAudio.resume();
    engine.activePropId = vehicle.id;

    const throttleInput = telemetry?.throttleInput ?? 0;
    const brakeHeld = telemetry?.brakeHeld === true;
    const grounded = telemetry?.grounded === true;
    const forwardSpeed = telemetry?.forwardSpeed ?? 0;
    const speedRatio = THREE.MathUtils.clamp(Math.abs(forwardSpeed) / VEHICLE_SETTINGS.maxDriveSpeed, 0, 1);
    const throttleDemand = Math.abs(throttleInput);
    const gearCount = 5;
    const targetGear = THREE.MathUtils.clamp(
        Math.floor(speedRatio * (gearCount - 0.15) + 1 + throttleDemand * 0.25),
        1,
        gearCount,
    );
    engine.gear = THREE.MathUtils.damp(engine.gear, targetGear, grounded ? 5.8 : 2.4, delta);
    const gearIndex = THREE.MathUtils.clamp(Math.round(engine.gear), 1, gearCount);
    const gearStartRatio = (gearIndex - 1) / gearCount;
    const gearEndRatio = gearIndex / gearCount;
    const gearBand = Math.max(0.0001, gearEndRatio - gearStartRatio);
    const gearProgress = THREE.MathUtils.clamp((speedRatio - gearStartRatio) / gearBand, 0, 1);
    const revKick = grounded ? throttleDemand * 1400 : throttleDemand * 650;
    const brakeDip = brakeHeld ? 220 : 0;
    const targetRpm = clampVehicleEngineRpm(
        engine.idleRpm + gearProgress * (engine.maxRpm - engine.idleRpm * 1.08) + revKick - brakeDip
    );
    const rpmLambda = throttleDemand > 0.04
        ? 6.5
        : brakeHeld
            ? 5.2
            : 2.8;
    engine.targetRpm = targetRpm;
    engine.rpm = THREE.MathUtils.damp(engine.rpm, targetRpm, rpmLambda, delta);
    engine.throttle = THREE.MathUtils.damp(engine.throttle, throttleDemand, grounded ? 7.5 : 3.5, delta);
    const throttleDrop = Math.max(0, engine.lastThrottle - throttleDemand);
    const overrunTarget = (!brakeHeld && throttleDemand < 0.08 && speedRatio > 0.18)
        ? THREE.MathUtils.clamp(0.22 + speedRatio * 0.9 + throttleDrop * 1.8, 0, 1)
        : 0;
    engine.overrun = THREE.MathUtils.damp(engine.overrun, overrunTarget, overrunTarget > 0 ? 9.5 : 4.5, delta);
    engine.lastThrottle = throttleDemand;
    engine.lastGrounded = grounded;

    const idleBlend = THREE.MathUtils.clamp((engine.rpm - engine.idleRpm) / 1600, 0, 1);
    const masterGain = 0.05 + speedRatio * 0.04 + engine.throttle * 0.06 + engine.overrun * 0.015 + (grounded ? 0.01 : 0);
    const intakeGain = 0.12 + engine.throttle * 0.16 + speedRatio * 0.04;
    const blockGain = 0.18 + idleBlend * 0.06 + engine.throttle * 0.14 + engine.overrun * 0.03;
    const outletGain = 0.24 + engine.throttle * 0.18 + speedRatio * 0.06 + engine.overrun * 0.04;

    generator.gain.gain.cancelScheduledValues(now);
    generator.gain.gain.setTargetAtTime(Math.max(0.0001, masterGain), now, grounded ? 0.06 : 0.12);
    generator.gainIntake.gain.cancelScheduledValues(now);
    generator.gainIntake.gain.setTargetAtTime(Math.max(0.0001, intakeGain), now, 0.08);
    generator.gainEngineBlockVibrations.gain.cancelScheduledValues(now);
    generator.gainEngineBlockVibrations.gain.setTargetAtTime(Math.max(0.0001, blockGain), now, 0.08);
    generator.gainOutlet.gain.cancelScheduledValues(now);
    generator.gainOutlet.gain.setTargetAtTime(Math.max(0.0001, outletGain), now, 0.08);

    engine.wasmThrottleParam.cancelScheduledValues(now);
    engine.wasmThrottleParam.setTargetAtTime(engine.throttle, now, grounded ? 0.04 : 0.09);
    engine.wasmRpmParam.cancelScheduledValues(now);
    engine.wasmRpmParam.setTargetAtTime(engine.rpm, now, 0.05);

    return true;
}

export function updateVehicleEngineAudio(delta, vehicle, telemetry) {
    primeVehicleEngineAudioWasm();

    let backendUsed = 'legacy';
    if (vehicleEngineAudio.wasmModuleReady && !vehicleEngineAudio.wasmFailed) {
        const usedWasm = updateVehicleEngineAudioWasm(delta, vehicle, telemetry);
        if (usedWasm) {
            backendUsed = 'wasm';
        }
    }
    if (backendUsed !== 'wasm') {
        updateLegacyVehicleEngineAudio(delta, vehicle, telemetry);
    }
    updateEngineAudioDebugOverlay(backendUsed, vehicle, telemetry);
}

export function updateEngineAudioDebugOverlay(backendUsed, vehicle, telemetry) {
    if (!engineAudioDebugEl) return;

    const ready = vehicleEngineAudio.wasmModuleReady;
    const failed = vehicleEngineAudio.wasmFailed;
    const loading = !!vehicleEngineAudio.wasmLoadPromise;
    const generator = vehicleEngineAudio.wasmGenerator;
    const node = generator?.worklet ?? null;
    const ctx = runtimeAudio.listener?.context ?? null;
    const isActiveVehicle = !!vehicle?.id && gameplay.active && vehicleState.activePropId === vehicle.id;

    let state;
    if (failed) state = 'failed';
    else if (loading) state = 'loading';
    else if (ready && backendUsed === 'wasm') state = 'wasm';
    else if (ready) state = 'wasm-idle';
    else state = 'legacy';

    const debugForcedVisible = typeof window !== 'undefined' && window.DEBUG_ENGINE_AUDIO_OVERLAY === true;
    const shouldShow = failed || debugForcedVisible;
    engineAudioDebugEl.hidden = !shouldShow;
    if (!shouldShow) return;

    const masterGainNow = generator?.gain?.gain?.value;
    const intakeGainNow = generator?.gainIntake?.gain?.value;
    const outletGainNow = generator?.gainOutlet?.gain?.value;
    const wasmRpmParamNow = vehicleEngineAudio.wasmRpmParam?.value;
    const wasmThrottleParamNow = vehicleEngineAudio.wasmThrottleParam?.value;
    const lines = [
        `Engine Audio: ${state.toUpperCase()}`,
        `backend     : ${backendUsed}`,
        `wasm ready  : ${ready ? 'yes' : 'no'}`,
        `wasm failed : ${failed ? 'yes' : 'no'}`,
        `worklet node: ${node ? 'attached' : 'none'}`,
        `parented to : ${generator?.parent?.name || generator?.parent ? (generator.parent.name || 'mesh') : 'detached'}`,
        `audio ctx   : ${ctx ? ctx.state : 'none'}`,
        `active veh  : ${isActiveVehicle ? vehicle.id : 'none'}`,
        `rpm/throttle: ${vehicleEngineAudio.rpm.toFixed(0)} / ${vehicleEngineAudio.throttle.toFixed(2)}`,
        `wasm params : rpm=${(wasmRpmParamNow ?? -1).toFixed(0)} thr=${(wasmThrottleParamNow ?? -1).toFixed(2)}`,
        `wasm gains  : m=${(masterGainNow ?? 0).toFixed(3)} i=${(intakeGainNow ?? 0).toFixed(2)} o=${(outletGainNow ?? 0).toFixed(2)}`,
        `creates/reattaches: ${vehicleEngineAudio.wasmCreateCount || 0} / ${vehicleEngineAudio.wasmReattachCount || 0}`,
        `sample rate : ${ctx?.sampleRate ?? '--'}`,
    ];
    if (vehicleEngineAudio.wasmProcessorError) {
        lines.push(`processor err: ${vehicleEngineAudio.wasmProcessorError}`);
    }
    if (failed && vehicleEngineAudio.wasmFailureReason) {
        lines.push(`reason      : ${vehicleEngineAudio.wasmFailureReason}`);
    }
    engineAudioDebugEl.textContent = lines.join('\n');

    engineAudioDebugEl.classList.toggle('is-wasm-ok', state === 'wasm');
    engineAudioDebugEl.classList.toggle('is-wasm-loading', state === 'loading');
    engineAudioDebugEl.classList.toggle('is-wasm-failed', state === 'failed');
    engineAudioDebugEl.classList.toggle('is-legacy', state === 'legacy');
    engineAudioDebugEl.classList.toggle('is-idle', state === 'wasm-idle' || !isActiveVehicle);
}

export function resolveRuntimeSoundBuffer(soundSpec) {
    const audioContext = runtimeAudio.listener?.context ?? null;
    if (!audioContext) {
        return Promise.resolve(null);
    }

    if (typeof AudioBuffer !== 'undefined' && soundSpec instanceof AudioBuffer) {
        return Promise.resolve(soundSpec);
    }

    if (!soundSpec || soundSpec === TEST_SOUND_ID || soundSpec === 'test' || soundSpec === 'default') {
        if (!runtimeAudio.testBuffer) {
            runtimeAudio.testBuffer = createTestSoundBuffer(audioContext);
        }
        return Promise.resolve(runtimeAudio.testBuffer);
    }

    const url = String(soundSpec);
    return new Promise((resolve, reject) => {
        runtimeAudio.loader.load(url, resolve, undefined, reject);
    });
}

export async function playSoundAtLocation(soundSpec = TEST_SOUND_ID, location = null, options = {}) {
    if (!scene || !runtimeAudio.listener) {
        return false;
    }

    await runtimeAudio.resume();

    const buffer = await resolveRuntimeSoundBuffer(soundSpec);
    if (!buffer) {
        return false;
    }

    const anchor = new THREE.Object3D();
    anchor.position.copy(resolveSoundLocation(location, options.fallbackDistance ?? 3));
    anchor.name = 'transient-audio-anchor';
    scene.add(anchor);
    runtimeAudio.transientAnchors.add(anchor);

    const sound = new THREE.PositionalAudio(runtimeAudio.listener);
    anchor.add(sound);
    sound.setBuffer(buffer);
    sound.setLoop(!!options.loop);
    sound.setVolume(Number.isFinite(options.volume) ? options.volume : 0.95);
    sound.setPlaybackRate(Number.isFinite(options.playbackRate) ? options.playbackRate : 1);
    sound.setRefDistance(Number.isFinite(options.refDistance) ? options.refDistance : 2.4);
    sound.setMaxDistance(Number.isFinite(options.maxDistance) ? options.maxDistance : 42);
    sound.setRolloffFactor(Number.isFinite(options.rolloffFactor) ? options.rolloffFactor : 1.2);

    try {
        sound.play(options.delay ?? 0);
    } catch (error) {
        cleanupTransientAudio(anchor, sound);
        console.warn('Failed to play positional sound.', error);
        return false;
    }

    if (!options.loop && sound.source) {
        const previousOnEnded = sound.source.onended;
        sound.source.onended = (...args) => {
            previousOnEnded?.(...args);
            cleanupTransientAudio(anchor, sound);
        };
    }

    return { anchor, sound };
}

export function getAudioTestLocation() {
    const selectedActor = getDynamicPropById(objectScriptState.targetPropId);
    const selectedMesh = getActorRenderObject(selectedActor);
    if (selectedMesh) {
        return selectedMesh.getWorldPosition(new THREE.Vector3());
    }

    return resolveSoundLocation(null, gameplay.active ? 4 : 3);
}

export async function playAudioTestCue() {
    const location = getAudioTestLocation();
    const [positionalResult, speakerResult, mediaResult] = await Promise.allSettled([
        playSoundAtLocation(TEST_SOUND_ID, location, {
            volume: 1,
            refDistance: 2.8,
            maxDistance: 48,
        }),
        playSpeakerTestTone(),
        playMediaElementTestSound(),
    ]);
    const didPlayPositional = positionalResult.status === 'fulfilled' && !!positionalResult.value;
    const didPlaySpeaker = speakerResult.status === 'fulfilled' && !!speakerResult.value;
    const didPlayMedia = mediaResult.status === 'fulfilled' && !!mediaResult.value;
    const result = didPlayPositional || didPlaySpeaker || didPlayMedia;

    if (playTestSoundStatus) {
        playTestSoundStatus.textContent = result
            ? `Played test sound at ${location.x.toFixed(1)}, ${location.y.toFixed(1)}, ${location.z.toFixed(1)}. WebAudio and media-element fallbacks also triggered.`
            : 'Test sound failed. Click inside the app once to unlock audio and try again.';
    }

    return result;
}
