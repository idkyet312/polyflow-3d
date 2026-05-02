import * as THREE from 'three';

export function sampleTestTone(progress, sampleIndex, sampleRate) {
    const attack = Math.min(1, progress / 0.06);
    const release = Math.min(1, (1 - progress) / 0.24);
    const envelope = Math.min(attack, release);
    const frequency = THREE.MathUtils.lerp(880, 440, progress);
    const omega = (Math.PI * 2 * frequency * sampleIndex) / sampleRate;
    const overtone = (Math.PI * 2 * (frequency * 2.02) * sampleIndex) / sampleRate;
    return (Math.sin(omega) * 0.34 + Math.sin(overtone) * 0.14) * envelope;
}

export function writeWaveAscii(view, offset, value) {
    for (let index = 0; index < value.length; index++) {
        view.setUint8(offset + index, value.charCodeAt(index));
    }
}

export function createTestSoundBuffer(audioContext) {
    const sampleRate = audioContext.sampleRate || 44100;
    const duration = 0.6;
    const frameCount = Math.max(1, Math.floor(sampleRate * duration));
    const buffer = audioContext.createBuffer(1, frameCount, sampleRate);
    const channelData = buffer.getChannelData(0);

    for (let index = 0; index < frameCount; index++) {
        const progress = index / frameCount;
        channelData[index] = sampleTestTone(progress, index, sampleRate);
    }

    return buffer;
}

export function createMediaTestSoundUrl() {
    const sampleRate = 44100;
    const duration = 0.6;
    const frameCount = Math.max(1, Math.floor(sampleRate * duration));
    const dataBytes = frameCount * 2;
    const waveBuffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(waveBuffer);

    writeWaveAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeWaveAscii(view, 8, 'WAVE');
    writeWaveAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeWaveAscii(view, 36, 'data');
    view.setUint32(40, dataBytes, true);

    for (let index = 0; index < frameCount; index++) {
        const progress = index / frameCount;
        const sample = THREE.MathUtils.clamp(sampleTestTone(progress, index, sampleRate), -1, 1);
        view.setInt16(44 + (index * 2), sample * 32767, true);
    }

    const blob = new Blob([waveBuffer], { type: 'audio/wav' });
    return URL.createObjectURL(blob);
}

export function createEngineNoiseBuffer(audioContext) {
    const duration = 2.6;
    const sampleRate = audioContext.sampleRate || 44100;
    const frameCount = Math.max(1, Math.floor(sampleRate * duration));
    const buffer = audioContext.createBuffer(1, frameCount, sampleRate);
    const data = buffer.getChannelData(0);

    // Paul Kellet pink-noise filter
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let index = 0; index < frameCount; index++) {
        const white = (Math.random() * 2) - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
        data[index] = THREE.MathUtils.clamp(pink, -1, 1);
    }

    return buffer;
}

export function createCombustionPulseBuffer(audioContext) {
    const sampleRate = audioContext.sampleRate || 44100;
    const duration = 0.12;
    const frameCount = Math.max(1, Math.floor(sampleRate * duration));
    const buffer = audioContext.createBuffer(1, frameCount, sampleRate);
    const data = buffer.getChannelData(0);

    let lpState = 0;
    for (let index = 0; index < frameCount; index++) {
        const t = index / frameCount;
        const attack = Math.min(1, t / 0.012);
        const decay = Math.exp(-t * 7.5);
        const fundamental = Math.sin(t * Math.PI * 2 * 38);
        const sub = Math.sin(t * Math.PI * 2 * 19) * 0.6;
        const overtone = Math.sin(t * Math.PI * 2 * 110) * 0.28;
        const white = (Math.random() * 2) - 1;
        lpState = lpState * 0.82 + white * 0.18;
        const rumble = lpState * 0.22;
        const sample = (fundamental + sub + overtone + rumble) * attack * decay * 0.6;
        data[index] = THREE.MathUtils.clamp(sample, -1, 1);
    }
    return buffer;
}

export function createCombustionDistortionCurve(amount = 0.18) {
    const samples = 2048;
    const curve = new Float32Array(samples);
    const k = amount * 6;
    for (let i = 0; i < samples; i++) {
        const x = (i / (samples - 1)) * 2 - 1;
        curve[i] = (1 + k) * x / (1 + k * Math.abs(x));
    }
    return curve;
}
