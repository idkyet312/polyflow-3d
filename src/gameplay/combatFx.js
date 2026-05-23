import * as THREE from 'three';

// Combat audio + impact/tracer/decal/muzzle particle FX, extracted from
// runtime.js. Procedural Web Audio one-shots (no asset loading) plus a few
// short-lived particle bursts pushed into the shared gameplay effects list.
//
// Deps are injected (same factory pattern as vehicle/fx.js) so the module
// stays free of runtime.js module-global coupling:
//   runtimeAudio        - { listener } (listener.context = AudioContext)
//   getScene            - () => THREE.Scene | null
//   getCamera           - () => THREE.Camera | null
//   gameplayPrefabState - { effects: [] } (FX queue, updated by runtime loop)
//   getActorRenderObject- (actor) => Object3D | null
//   tmp                 - { a,c,d,e: THREE.Vector3 } scratch vectors (shared
//                          with runtime.js; callers must not rely on their
//                          contents surviving these calls)
export function createCombatFx({
    runtimeAudio,
    getScene,
    getCamera,
    gameplayPrefabState,
    getActorRenderObject,
    tmp,
}) {
    const audioContext = () => {
        const context = runtimeAudio.listener?.context;
        return context && context.state === 'running' ? context : null;
    };
    const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
    const FX_POOL_LIMIT = 160;
    const fxPool = gameplayPrefabState.fxMeshPool || (gameplayPrefabState.fxMeshPool = new Map());

    function acquireFxMesh(key, create) {
        const bucket = fxPool.get(key);
        const mesh = bucket?.pop() || create();
        mesh.userData.fxPoolKey = key;
        mesh.visible = true;
        if (mesh.material) {
            mesh.material.opacity = mesh.userData.fxBaseOpacity ?? mesh.material.opacity ?? 1;
            mesh.material.needsUpdate = true;
        }
        return mesh;
    }

    function releaseFxMesh(mesh) {
        const key = mesh?.userData?.fxPoolKey;
        if (!key) return false;
        mesh.parent?.remove(mesh);
        mesh.visible = false;
        mesh.position.set(0, 0, 0);
        mesh.rotation.set(0, 0, 0);
        mesh.quaternion.identity();
        mesh.scale.set(1, 1, 1);
        if (mesh.material) {
            mesh.material.opacity = mesh.userData.fxBaseOpacity ?? 1;
        }
        let bucket = fxPool.get(key);
        if (!bucket) {
            bucket = [];
            fxPool.set(key, bucket);
        }
        if (bucket.length < FX_POOL_LIMIT) {
            bucket.push(mesh);
        } else {
            mesh.geometry?.dispose?.();
            mesh.material?.dispose?.();
        }
        return true;
    }

    gameplayPrefabState.releaseFxMesh = releaseFxMesh;

    // Build a PannerNode at world (x,y,z) so the sound is spatialized relative
    // to the camera-mounted listener. Returns the panner (connected to
    // destination), or context.destination if no position / panner unsupported.
    function makeSpatialSink(context, x, y, z, options = {}) {
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            return context.destination;
        }
        let panner;
        try {
            panner = context.createPanner();
        } catch (e) {
            return context.destination;
        }
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = Number.isFinite(options.refDistance) ? options.refDistance : 4;
        panner.maxDistance = Number.isFinite(options.maxDistance) ? options.maxDistance : 90;
        panner.rolloffFactor = Number.isFinite(options.rolloffFactor) ? options.rolloffFactor : 1.1;
        const tt = context.currentTime;
        if (panner.positionX) {
            panner.positionX.setValueAtTime(x, tt);
            panner.positionY.setValueAtTime(y, tt);
            panner.positionZ.setValueAtTime(z, tt);
        } else {
            panner.setPosition(x, y, z); // legacy
        }
        panner.connect(context.destination);
        return panner;
    }

    function playDoomShotgunSound(volume = 1) {
        const context = audioContext();
        if (!context) return;
        const t = context.currentTime;
        const vol = clamp01(volume);

        // Noise burst (the "crack").
        const dur = 0.22;
        const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * dur), context.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
        }
        const noise = context.createBufferSource();
        noise.buffer = buffer;
        const noiseFilter = context.createBiquadFilter();
        noiseFilter.type = 'lowpass';
        noiseFilter.frequency.setValueAtTime(2600, t);
        noiseFilter.frequency.exponentialRampToValueAtTime(420, t + dur);
        const noiseGain = context.createGain();
        noiseGain.gain.setValueAtTime(0.55 * vol, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        noise.connect(noiseFilter).connect(noiseGain).connect(context.destination);
        noise.start(t);
        noise.stop(t + dur);

        // Low thump (the "boom" body).
        const osc = context.createOscillator();
        const oscGain = context.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(140, t);
        osc.frequency.exponentialRampToValueAtTime(48, t + 0.16);
        oscGain.gain.setValueAtTime(0.5 * vol, t);
        oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        osc.connect(oscGain).connect(context.destination);
        osc.start(t);
        osc.stop(t + 0.19);
    }

    // Bright two-note pickup chime.
    function playDoomPickupSound(volume = 1, x, y, z) {
        const context = audioContext();
        if (!context) return;
        const t = context.currentTime;
        const vol = clamp01(volume);
        const sink = makeSpatialSink(context, x, y, z);
        [[660, 0], [990, 0.07]].forEach(([freq, dt]) => {
            const o = context.createOscillator();
            const g = context.createGain();
            o.type = 'triangle';
            o.frequency.setValueAtTime(freq, t + dt);
            g.gain.setValueAtTime(0.0001, t + dt);
            g.gain.exponentialRampToValueAtTime(0.28 * vol, t + dt + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.16);
            o.connect(g).connect(sink);
            o.start(t + dt);
            o.stop(t + dt + 0.18);
        });
    }

    // Enemy death: a descending sawtooth growl + a short noisy splat.
    function playEnemyDeathSound(volume = 1, x, y, z) {
        const context = audioContext();
        if (!context) return;
        const t = context.currentTime;
        const vol = clamp01(volume);
        const sink = makeSpatialSink(context, x, y, z);

        // Descending growl.
        const osc = context.createOscillator();
        const oscGain = context.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(320, t);
        osc.frequency.exponentialRampToValueAtTime(55, t + 0.34);
        oscGain.gain.setValueAtTime(0.32 * vol, t);
        oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.36);
        osc.connect(oscGain).connect(sink);
        osc.start(t);
        osc.stop(t + 0.37);

        // Noisy splat.
        const dur = 0.18;
        const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * dur), context.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
        }
        const noise = context.createBufferSource();
        noise.buffer = buffer;
        const nf = context.createBiquadFilter();
        nf.type = 'bandpass';
        nf.frequency.setValueAtTime(900, t);
        nf.frequency.exponentialRampToValueAtTime(220, t + dur);
        const ng = context.createGain();
        ng.gain.setValueAtTime(0.4 * vol, t);
        ng.gain.exponentialRampToValueAtTime(0.001, t + dur);
        noise.connect(nf).connect(ng).connect(sink);
        noise.start(t);
        noise.stop(t + dur);
    }

    // Short noisy "thud/spark" — bullet hitting a wall.
    function playImpactSound(volume = 1, x, y, z) {
        const context = audioContext();
        if (!context) return;
        const t = context.currentTime;
        const vol = clamp01(volume);
        const sink = makeSpatialSink(context, x, y, z, {
            refDistance: 12,
            maxDistance: 270,
        });

        // Lowpassed noise body (the dull thwack), darker + slightly longer.
        const dur = 0.16;
        const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * dur), context.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
        const noise = context.createBufferSource();
        noise.buffer = buffer;
        const f = context.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(900, t);
        f.frequency.exponentialRampToValueAtTime(220, t + dur);
        const g = context.createGain();
        g.gain.setValueAtTime(0.32 * vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        noise.connect(f).connect(g).connect(sink);
        noise.start(t);
        noise.stop(t + dur);

        // Low sine thump for weight.
        const osc = context.createOscillator();
        const og = context.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(120, t);
        osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
        og.gain.setValueAtTime(0.34 * vol, t);
        og.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
        osc.connect(og).connect(sink);
        osc.start(t);
        osc.stop(t + 0.15);
    }

    // Short grunt — enemy took non-fatal damage.
    function playEnemyHurtSound(volume = 1, x, y, z) {
        const context = audioContext();
        if (!context) return;
        const t = context.currentTime;
        const vol = clamp01(volume);
        const sink = makeSpatialSink(context, x, y, z);
        const o = context.createOscillator();
        const g = context.createGain();
        o.type = 'square';
        o.frequency.setValueAtTime(420, t);
        o.frequency.exponentialRampToValueAtTime(190, t + 0.11);
        g.gain.setValueAtTime(0.16 * vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        o.connect(g).connect(sink);
        o.start(t);
        o.stop(t + 0.13);
    }

    // Small spark/puff burst at a world point (reuses the effect particle system).
    function spawnImpactBurst(x, y, z, opts = {}) {
        const scene = getScene();
        if (!scene) return;
        const color = opts.color ?? 0xffd27a;
        const count = opts.count ?? 7;
        const spread = opts.spread ?? 2.6;
        const particles = [];
        for (let i = 0; i < count; i++) {
            const p = acquireFxMesh('impactSphere', () => new THREE.Mesh(
                new THREE.SphereGeometry(0.035, 6, 5),
                new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 })
            ));
            p.userData.fxBaseOpacity = 1;
            p.material.color.set(color);
            p.material.opacity = 1;
            p.position.set(x, y, z);
            scene.add(p);
            particles.push({
                mesh: p,
                velocity: new THREE.Vector3(
                    (Math.random() - 0.5) * spread,
                    Math.random() * spread * 0.6,
                    (Math.random() - 0.5) * spread
                ),
            });
        }
        gameplayPrefabState.effects.push({ type: 'impact', particles, ttl: 0.35, maxTtl: 0.35 });
    }

    // Bright stretched streak from (ox,oy,oz) along unit dir (dx,dy,dz). Static,
    // fades fast — reads as a bullet tracer without tracking the pooled bullet.
    function spawnTracer(ox, oy, oz, dx, dy, dz, len = 6, color = 0xfff1a8) {
        const scene = getScene();
        if (!scene) return;
        const dir = tmp.d.set(dx, dy, dz);
        if (dir.lengthSq() < 1e-6) return;
        dir.normalize();
        const length = Math.max(0.5, Number(len) || 6);
        // Thin box, length along local +Z, then orient +Z to dir.
        const mesh = acquireFxMesh('tracerBox', () => new THREE.Mesh(
            new THREE.BoxGeometry(0.03, 0.03, 1),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 })
        ));
        mesh.userData.fxBaseOpacity = 0.85;
        mesh.material.color.set(color);
        mesh.material.opacity = 0.85;
        mesh.material.toneMapped = false;
        // Center the streak so its tail is at the origin, head `length` ahead.
        mesh.position.set(ox + dir.x * length * 0.5, oy + dir.y * length * 0.5, oz + dir.z * length * 0.5);
        mesh.quaternion.setFromUnitVectors(tmp.e.set(0, 0, 1), dir);
        mesh.scale.set(1, 1, length);
        scene.add(mesh);
        gameplayPrefabState.effects.push({
            type: 'tracer',
            staticFx: true,
            particles: [{ mesh, baseOpacity: 0.85, velocity: new THREE.Vector3() }],
            ttl: 0.085,
            maxTtl: 0.085,
        });
    }

    // A flat scorch quad laid on a surface at (x,y,z), facing normal (nx,ny,nz).
    // Lingers, then fades. Stays put (staticFx).
    function spawnImpactDecal(x, y, z, nx = 0, ny = 1, nz = 0, opts = {}) {
        const scene = getScene();
        if (!scene) return;
        const n = tmp.d.set(nx, ny, nz);
        const dir = opts.dir;
        const hasDir = !!(dir && (dir.x || dir.y || dir.z));
        if (opts.hasNormal && n.lengthSq() > 1e-6) {
            // Real surface normal from the physics ray — trust it (correct for
            // floor, walls, ceiling, angled faces). Just flip it back toward the
            // shooter if it points into the surface.
            n.normalize();
            if (hasDir && (n.x * dir.x + n.y * dir.y + n.z * dir.z) > 0) n.negate();
        } else if (hasDir) {
            // No usable normal: arena is axis-aligned brick boxes, so snap the
            // outward normal to the world axis the bullet travelled most along.
            const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
            if (ax >= ay && ax >= az) n.set(-Math.sign(dir.x), 0, 0);
            else if (ay >= ax && ay >= az) n.set(0, -Math.sign(dir.y), 0);
            else n.set(0, 0, -Math.sign(dir.z));
        } else {
            if (n.lengthSq() < 1e-6) n.set(0, 1, 0);
            n.normalize();
        }
        // Grazing hits: if the shot came in nearly parallel to the surface (angle
        // between the bullet and the surface plane below ~22°), the skewed normal
        // makes the disc look edge-on. Snap it flat to the nearest world axis so
        // it lies cleanly on the wall/floor instead.
        if (hasDir) {
            const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
            const incidence = Math.abs(n.x * dir.x + n.y * dir.y + n.z * dir.z) / dl;
            const MIN_SIN = 0.38; // sin(~22°): below this = too grazing
            if (incidence < MIN_SIN) {
                const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
                if (ax >= ay && ax >= az) n.set(Math.sign(n.x) || 1, 0, 0);
                else if (ay >= ax && ay >= az) n.set(0, Math.sign(n.y) || 1, 0);
                else n.set(0, 0, Math.sign(n.z) || 1);
            }
        }
        const size = opts.size ?? 0.18;
        const mesh = acquireFxMesh('impactDecal', () => new THREE.Mesh(
            new THREE.CircleGeometry(1, 12),
            new THREE.MeshBasicMaterial({
                color: opts.color ?? 0x1a1206,
                transparent: true,
                opacity: 0.7,
                side: THREE.DoubleSide,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: -1,
            })
        ));
        mesh.userData.fxBaseOpacity = 0.7;
        mesh.material.color.set(opts.color ?? 0x1a1206);
        mesh.material.opacity = 0.7;
        mesh.scale.setScalar(size);
        // CircleGeometry faces +Z; align +Z to the (corrected) surface normal so
        // the disc lies flat on the wall/floor it hit.
        mesh.quaternion.setFromUnitVectors(tmp.e.set(0, 0, 1), n);
        // Nudge off the surface (along the outward normal) so it doesn't z-fight.
        mesh.position.set(x + n.x * 0.012, y + n.y * 0.012, z + n.z * 0.012);
        scene.add(mesh);
        gameplayPrefabState.effects.push({
            type: 'decal',
            staticFx: true,
            particles: [{ mesh, baseOpacity: 0.7, velocity: new THREE.Vector3() }],
            ttl: opts.ttl ?? 3.0,
            maxTtl: opts.ttl ?? 3.0,
        });
    }

    // Muzzle smoke puff + a tumbling ejected shell, at the held weapon's muzzle
    // (derived from the camera so it tracks aim). Cosmetic.
    function spawnMuzzleSmoke() {
        const scene = getScene();
        const camera = getCamera();
        if (!scene || !camera) return;
        const muzzle = camera.localToWorld(tmp.a.set(0.05, -0.05, -1.0));
        const right = tmp.d.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
        const fwd = tmp.c.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
        const particles = [];

        // Smoke: a few soft grey puffs drifting forward + up.
        for (let i = 0; i < 5; i++) {
            const p = acquireFxMesh('muzzleSmoke', () => new THREE.Mesh(
                new THREE.SphereGeometry(1, 6, 5),
                new THREE.MeshBasicMaterial({ color: 0x9a9a9a, transparent: true, opacity: 0.55 })
            ));
            p.userData.fxBaseOpacity = 0.55;
            p.material.opacity = 0.55;
            p.scale.setScalar(0.05 + Math.random() * 0.04);
            p.position.copy(muzzle);
            scene.add(p);
            particles.push({
                mesh: p,
                velocity: fwd.clone().multiplyScalar(1.6 + Math.random())
                    .add(new THREE.Vector3(0, 0.7 + Math.random() * 0.5, 0))
                    .addScaledVector(right, (Math.random() - 0.5) * 0.6),
            });
        }
        // Shell: one brassy box flicked to the right.
        const shell = acquireFxMesh('muzzleShell', () => new THREE.Mesh(
            new THREE.BoxGeometry(0.05, 0.05, 0.11),
            new THREE.MeshBasicMaterial({ color: 0xd9a441 })
        ));
        shell.userData.fxBaseOpacity = 1;
        shell.position.copy(muzzle).addScaledVector(right, 0.1);
        scene.add(shell);
        particles.push({
            mesh: shell,
            velocity: right.clone().multiplyScalar(2.4 + Math.random())
                .add(new THREE.Vector3(0, 1.2, 0)),
        });

        gameplayPrefabState.effects.push({ type: 'muzzle', particles, ttl: 0.5, maxTtl: 0.5 });
    }

    // Brief emissive flash on an actor's mesh (non-fatal hit feedback).
    function flashActorHit(actor, color = 0xffffff) {
        const mesh = getActorRenderObject(actor);
        if (!mesh) return;
        mesh.traverse?.((node) => {
            const mats = node?.material ? (Array.isArray(node.material) ? node.material : [node.material]) : [];
            mats.forEach((mat) => {
                if (!mat?.emissive) return;
                if (mat.userData._hitFlashRestore == null) {
                    mat.userData._hitFlashRestore = {
                        e: mat.emissive.getHex(),
                        i: mat.emissiveIntensity ?? 1,
                    };
                }
                mat.emissive.set(color);
                mat.emissiveIntensity = 1.8;
                clearTimeout(mat.userData._hitFlashTimer);
                mat.userData._hitFlashTimer = setTimeout(() => {
                    const r = mat.userData._hitFlashRestore;
                    if (r) { mat.emissive.setHex(r.e); mat.emissiveIntensity = r.i; }
                    mat.userData._hitFlashRestore = null;
                }, 90);
            });
        });
    }

    return {
        makeSpatialSink,
        playDoomShotgunSound,
        playDoomPickupSound,
        playEnemyDeathSound,
        playImpactSound,
        playEnemyHurtSound,
        spawnImpactBurst,
        spawnTracer,
        spawnImpactDecal,
        spawnMuzzleSmoke,
        flashActorHit,
    };
}
