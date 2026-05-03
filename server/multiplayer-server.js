import { createServer } from 'node:http';
import { Server } from 'socket.io';

const PORT = Number(process.env.PORT || 3001);
const rooms = new Map();

function normalizeRoom(room) {
    const value = typeof room === 'string' ? room.trim() : '';
    return value ? value.slice(0, 48) : 'sandbox';
}

function ensureRoom(room) {
    if (!rooms.has(room)) {
        rooms.set(room, new Map());
    }

    return rooms.get(room);
}

function emitPresence(io, room) {
    const roomState = rooms.get(room);
    const count = roomState?.size ?? 0;
    io.to(room).emit('multiplayer:presence', { count });
}

function leaveRoom(io, socket) {
    const room = socket.data.room;
    if (!room) return;

    const roomState = rooms.get(room);
    if (roomState) {
        roomState.delete(socket.id);
        if (!roomState.size) {
            rooms.delete(room);
        }
    }

    socket.leave(room);
    socket.to(room).emit('multiplayer:peer-left', { id: socket.id });
    emitPresence(io, room);
    socket.data.room = '';
}

const httpServer = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, service: 'polyflow-3d-multiplayer' }));
});

const io = new Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});

function normalizeTransformState(value) {
    if (!value || typeof value !== 'object') return null;
    return {
        x: Number.isFinite(value.x) ? value.x : 0,
        y: Number.isFinite(value.y) ? value.y : 0,
        z: Number.isFinite(value.z) ? value.z : 0,
    };
}

function normalizeQuaternionState(value) {
    if (!value || typeof value !== 'object') return null;
    return {
        x: Number.isFinite(value.x) ? value.x : 0,
        y: Number.isFinite(value.y) ? value.y : 0,
        z: Number.isFinite(value.z) ? value.z : 0,
        w: Number.isFinite(value.w) ? value.w : 1,
    };
}

function normalizeVehicleState(value) {
    if (!value || typeof value !== 'object') return { active: false };
    const position = normalizeTransformState(value.position);
    const quaternion = normalizeQuaternionState(value.quaternion);
    return {
        active: !!value.active && !!position && !!quaternion,
        id: typeof value.id === 'string' ? value.id.slice(0, 64) : '',
        position,
        quaternion,
    };
}

io.on('connection', (socket) => {
    socket.on('multiplayer:join', (payload = {}) => {
        leaveRoom(io, socket);

        const room = normalizeRoom(payload.room);
        const roomState = ensureRoom(room);
        socket.data.room = room;
        socket.join(room);

        roomState.set(socket.id, {
            id: socket.id,
            state: null,
        });

        const peers = Array.from(roomState.values())
            .filter((peer) => peer.id !== socket.id && peer.state)
            .map((peer) => ({ id: peer.id, state: peer.state }));

        socket.emit('multiplayer:welcome', {
            id: socket.id,
            room,
            peers,
            count: roomState.size,
        });
        socket.to(room).emit('multiplayer:peer-joined', { id: socket.id });
        emitPresence(io, room);
    });

    socket.on('multiplayer:state', (state = null) => {
        const room = socket.data.room;
        if (!room || !state || typeof state !== 'object') return;

        const roomState = rooms.get(room);
        if (!roomState?.has(socket.id)) return;

        const normalizedState = {
            mode: typeof state.mode === 'string' ? state.mode : 'showcase',
            position: normalizeTransformState(state.position),
            quaternion: normalizeQuaternionState(state.quaternion),
            vehicle: normalizeVehicleState(state.vehicle),
            updatedAt: Date.now(),
        };

        roomState.set(socket.id, {
            id: socket.id,
            state: normalizedState,
        });

        socket.to(room).emit('multiplayer:peer-state', {
            id: socket.id,
            state: normalizedState,
        });
    });

    socket.on('disconnect', () => {
        leaveRoom(io, socket);
    });
});

httpServer.listen(PORT, () => {
    console.log(`PolyFlow multiplayer server listening on http://localhost:${PORT}`);
});
