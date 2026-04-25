import * as THREE from 'three';
import { io } from 'socket.io-client';

function createPeerColor(peerId) {
    let hash = 0;
    for (let index = 0; index < peerId.length; index++) {
        hash = ((hash << 5) - hash) + peerId.charCodeAt(index);
        hash |= 0;
    }

    const hue = Math.abs(hash) % 360;
    return new THREE.Color(`hsl(${hue} 70% 58%)`);
}

function createRemoteAvatar(color) {
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.42,
        metalness: 0.12,
        emissive: color.clone().multiplyScalar(0.12),
    });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.72, 6, 12), material);
    body.castShadow = true;
    body.receiveShadow = true;
    body.position.y = 0.58;
    const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 16, 12),
        new THREE.MeshStandardMaterial({
            color: 0xf8fafc,
            roughness: 0.34,
            metalness: 0.05,
        })
    );
    head.castShadow = true;
    head.position.y = 1.18;
    root.add(body, head);
    return root;
}

function createRemoteVehicle(color) {
    const root = new THREE.Group();
    const chassis = new THREE.Mesh(
        new THREE.BoxGeometry(1.35, 0.6, 2.6),
        new THREE.MeshStandardMaterial({
            color,
            roughness: 0.56,
            metalness: 0.18,
            emissive: color.clone().multiplyScalar(0.08),
        })
    );
    chassis.castShadow = true;
    chassis.receiveShadow = true;
    const cabin = new THREE.Mesh(
        new THREE.BoxGeometry(0.95, 0.42, 1.1),
        new THREE.MeshStandardMaterial({
            color: 0xe2e8f0,
            roughness: 0.24,
            metalness: 0.06,
            transparent: true,
            opacity: 0.76,
        })
    );
    cabin.position.set(0, 0.48, -0.08);
    cabin.castShadow = true;
    root.add(chassis, cabin);
    return root;
}

function copyPlainVector(target, source) {
    target.set(source?.x ?? 0, source?.y ?? 0, source?.z ?? 0);
    return target;
}

function copyPlainQuaternion(target, source) {
    target.set(source?.x ?? 0, source?.y ?? 0, source?.z ?? 0, source?.w ?? 1);
    return target.normalize();
}

export function createSocketMultiplayer({ scene, onStateChange }) {
    const remoteRoot = new THREE.Group();
    remoteRoot.name = 'multiplayer-remotes';
    scene.add(remoteRoot);

    const peers = new Map();
    const tempVector = new THREE.Vector3();
    const state = {
        socket: null,
        selfId: '',
        connected: false,
        lastEmitTime: 0,
        playerCount: 1,
        emitIntervalMs: 90,
        pendingSnapshot: null,
    };

    function pushUi(statusText) {
        onStateChange?.({
            statusText,
            playerCount: state.playerCount,
            connected: state.connected,
            selfId: state.selfId,
        });
    }

    function removePeer(peerId) {
        const peer = peers.get(peerId);
        if (!peer) return;

        remoteRoot.remove(peer.avatar);
        remoteRoot.remove(peer.vehicle);
        peers.delete(peerId);
    }

    function setPlayerCount(count) {
        state.playerCount = Number.isFinite(count) && count > 0 ? count : Math.max(1, peers.size + (state.connected ? 1 : 0));
        pushUi(state.connected ? `Connected as ${state.selfId.slice(0, 6)}` : 'Offline');
    }

    function ensurePeer(peerId) {
        if (peers.has(peerId)) {
            return peers.get(peerId);
        }

        const color = createPeerColor(peerId);
        const avatar = createRemoteAvatar(color);
        const vehicle = createRemoteVehicle(color);
        avatar.visible = false;
        vehicle.visible = false;
        remoteRoot.add(avatar, vehicle);

        const peer = {
            id: peerId,
            mode: 'showcase',
            avatar,
            vehicle,
            currentPosition: new THREE.Vector3(),
            targetPosition: new THREE.Vector3(),
            currentQuaternion: new THREE.Quaternion(),
            targetQuaternion: new THREE.Quaternion(),
            initialized: false,
        };
        peers.set(peerId, peer);
        return peer;
    }

    function applyPeerState(peerId, snapshot) {
        if (!snapshot?.position || !snapshot?.quaternion) return;

        const peer = ensurePeer(peerId);
        peer.mode = snapshot.mode || 'showcase';
        copyPlainVector(peer.targetPosition, snapshot.position);
        copyPlainQuaternion(peer.targetQuaternion, snapshot.quaternion);

        if (!peer.initialized) {
            peer.currentPosition.copy(peer.targetPosition);
            peer.currentQuaternion.copy(peer.targetQuaternion);
            peer.initialized = true;
        }
    }

    function disconnect(statusText = 'Offline') {
        state.pendingSnapshot = null;
        state.selfId = '';
        state.connected = false;
        state.lastEmitTime = 0;
        if (state.socket) {
            state.socket.removeAllListeners();
            state.socket.disconnect();
            state.socket = null;
        }

        peers.forEach((_peer, peerId) => removePeer(peerId));
        state.playerCount = 1;
        pushUi(statusText);
    }

    function connect({ serverUrl, room }) {
        const trimmedServerUrl = typeof serverUrl === 'string' ? serverUrl.trim() : '';
        if (!trimmedServerUrl) {
            pushUi('Enter a server URL');
            return;
        }

        disconnect('Connecting...');
        pushUi('Connecting...');

        const socket = io(trimmedServerUrl, {
            transports: ['websocket', 'polling'],
            timeout: 5000,
        });

        state.socket = socket;

        socket.on('connect', () => {
            socket.emit('multiplayer:join', {
                room: typeof room === 'string' && room.trim() ? room.trim() : 'sandbox',
            });
        });

        socket.on('multiplayer:welcome', (payload) => {
            state.connected = true;
            state.selfId = payload.id || socket.id || '';
            setPlayerCount(payload.count);
            payload.peers?.forEach((peer) => applyPeerState(peer.id, peer.state));
            pushUi(`Connected as ${state.selfId.slice(0, 6)}`);
            if (state.pendingSnapshot) {
                socket.emit('multiplayer:state', state.pendingSnapshot);
            }
        });

        socket.on('multiplayer:presence', (payload) => {
            setPlayerCount(payload?.count);
        });

        socket.on('multiplayer:peer-state', (payload) => {
            if (!payload?.id || payload.id === state.selfId) return;
            applyPeerState(payload.id, payload.state);
        });

        socket.on('multiplayer:peer-left', (payload) => {
            if (!payload?.id) return;
            removePeer(payload.id);
            setPlayerCount(Math.max(1, peers.size + (state.connected ? 1 : 0)));
        });

        socket.on('disconnect', () => {
            disconnect('Disconnected');
        });

        socket.on('connect_error', () => {
            disconnect('Connection failed');
        });
    }

    function syncLocalSnapshot(snapshot) {
        if (!snapshot) return;

        state.pendingSnapshot = snapshot;
        if (!state.connected || !state.socket) return;

        const now = performance.now();
        if (now - state.lastEmitTime < state.emitIntervalMs) return;

        state.lastEmitTime = now;
        state.socket.emit('multiplayer:state', snapshot);
    }

    function update(delta) {
        const blend = 1 - Math.exp(-delta * 10);
        peers.forEach((peer) => {
            if (!peer.initialized) return;

            peer.currentPosition.lerp(peer.targetPosition, blend);
            peer.currentQuaternion.slerp(peer.targetQuaternion, blend);

            const renderTarget = peer.mode === 'vehicle' ? peer.vehicle : peer.avatar;
            peer.avatar.visible = peer.mode !== 'vehicle';
            peer.vehicle.visible = peer.mode === 'vehicle';

            renderTarget.position.copy(peer.currentPosition);
            renderTarget.quaternion.copy(peer.currentQuaternion);

            if (peer.mode !== 'vehicle') {
                tempVector.copy(peer.currentPosition);
                tempVector.y = Math.max(tempVector.y, 0);
                peer.avatar.position.copy(tempVector);
            }
        });
    }

    return {
        connect,
        disconnect,
        syncLocalSnapshot,
        update,
    };
}