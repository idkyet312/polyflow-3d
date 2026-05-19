import * as THREE from 'three';

// Held-weapon visuals + equip/clear logic + the DOOM shotgun sprite HUD and
// pellet primitive, extracted from runtime.js. Pure THREE construction plus
// thin state writes into the shared `gameplay.weapon` slot. No weapon
// *behaviour* lives here — fire patterns/cooldown stay in prefab scripts;
// this module only builds meshes and the spawnDoomPellet/flash primitives the
// scripts call.
//
// Deps injected (same factory pattern as combatFx.js / vehicle/fx.js):
//   getCamera             - () => THREE.Camera | null   (held mesh parent)
//   gameplay              - shared { weapon, input } state object
//   getWeaponHudEl        - () => HTMLElement | null     (declared later in
//                            runtime.js; read only, to hide on clear)
//   getActorRenderObject  - (actor) => Object3D | null
//   spawnShooterProjectile- runtime projectile spawner (pellets reuse it)
//   spawnTracer           - combatFx tracer (pellet visual streak)
//   prefabs               - { STRAIGHT_GUN, DOOM_SHOTGUN } tuning consts
//   tmp                   - { a,c,d,e,f: THREE.Vector3 } shared scratch
export function createHeldWeapons({
    getCamera,
    gameplay,
    getWeaponHudEl,
    getActorRenderObject,
    spawnShooterProjectile,
    spawnTracer,
    prefabs,
    tmp,
}) {
    const { STRAIGHT_GUN, DOOM_SHOTGUN } = prefabs;

    // Bolt-on barrel/muzzle glow for a shooter actor that "carries" an SMG.
    function addStraightGunVisual(actor) {
        const mesh = getActorRenderObject(actor);
        if (!mesh) return;

        const barrel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.08, 0.11, 1.35, 18),
            new THREE.MeshStandardMaterial({
                color: 0x151923,
                metalness: 0.65,
                roughness: 0.24,
                emissive: 0x0f172a,
                emissiveIntensity: 0.35,
            })
        );
        barrel.name = 'SMG Barrel';
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, STRAIGHT_GUN.barrelHeight, -0.62);
        mesh.add(barrel);

        const muzzle = new THREE.Mesh(
            new THREE.SphereGeometry(0.14, 18, 12),
            new THREE.MeshBasicMaterial({ color: 0xfff1a8 })
        );
        muzzle.name = 'SMG Muzzle Glow';
        muzzle.position.set(0, STRAIGHT_GUN.barrelHeight, -1.28);
        mesh.add(muzzle);
        const light = new THREE.PointLight(0xffcc66, 1.1, 2.5);
        light.position.copy(muzzle.position);
        mesh.add(light);
    }

    // A small four-point shuriken held in the lower-right of the view. The
    // blade spins (animated in updateStraightGuns) so it reads as a thrown
    // weapon.
    function createHeldThrowingStarMesh() {
        const group = new THREE.Group();
        group.name = 'Held Throwing Star';
        group.position.set(0.34, -0.30, -0.66);
        group.rotation.set(-0.05, -0.12, 0);

        const spinner = new THREE.Group();
        spinner.name = 'Star Spinner';
        group.add(spinner);

        const mat = new THREE.MeshStandardMaterial({
            color: 0xcfe8ff, metalness: 0.85, roughness: 0.2,
            emissive: 0x0a3a5a, emissiveIntensity: 0.6,
        });
        // Two crossed diamond blades = a 4-point star.
        for (let i = 0; i < 2; i++) {
            const blade = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.02, 0.08), mat);
            blade.rotation.y = i * Math.PI / 2;
            spinner.add(blade);
        }
        const hub = new THREE.Mesh(
            new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12),
            new THREE.MeshStandardMaterial({ color: 0x7fd0ff, metalness: 0.7, roughness: 0.3 }),
        );
        hub.rotation.x = Math.PI / 2;
        spinner.add(hub);
        group.userData.spinner = spinner;
        return group;
    }

    function createHeldStraightGunMesh() {
        const group = new THREE.Group();
        group.name = 'Held SMG';
        group.position.set(0.32, -0.28, -0.62);
        group.rotation.set(-0.08, -0.16, 0.03);

        const grip = new THREE.Mesh(
            new THREE.BoxGeometry(0.16, 0.38, 0.18),
            new THREE.MeshStandardMaterial({ color: 0x1f2937, metalness: 0.35, roughness: 0.35 })
        );
        grip.name = 'Held Gun Grip';
        grip.position.set(0, -0.12, 0.14);
        grip.rotation.x = -0.28;
        group.add(grip);

        const body = new THREE.Mesh(
            new THREE.BoxGeometry(0.24, 0.18, 0.46),
            new THREE.MeshStandardMaterial({
                color: 0x334155,
                metalness: 0.6,
                roughness: 0.22,
                emissive: 0x201000,
                emissiveIntensity: 0.4,
            })
        );
        body.name = 'Held Gun Body';
        group.add(body);

        const barrel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.045, 0.058, 0.68, 18),
            new THREE.MeshStandardMaterial({
                color: 0x111827,
                metalness: 0.78,
                roughness: 0.18,
                emissive: 0x2b1600,
                emissiveIntensity: 0.4,
            })
        );
        barrel.name = 'Held Gun Barrel';
        barrel.rotation.x = Math.PI / 2;
        barrel.position.z = -0.48;
        group.add(barrel);

        const muzzle = new THREE.Mesh(
            new THREE.SphereGeometry(0.07, 16, 10),
            new THREE.MeshBasicMaterial({ color: 0xffd166 })
        );
        muzzle.name = 'Held Gun Muzzle';
        muzzle.position.z = -0.84;
        group.add(muzzle);

        const light = new THREE.PointLight(0xffcc66, 1.0, 2.0);
        light.position.copy(muzzle.position);
        group.add(light);
        return group;
    }

    function createHeldSniperRifleMesh() {
        const group = new THREE.Group();
        group.name = 'Held Bolt Action Sniper Rifle';
        group.position.set(0.25, -0.25, -0.82);
        group.rotation.set(-0.06, -0.12, 0.02);

        const stock = new THREE.Mesh(
            new THREE.BoxGeometry(0.18, 0.16, 0.46),
            new THREE.MeshStandardMaterial({ color: 0x31251b, metalness: 0.15, roughness: 0.55 })
        );
        stock.name = 'Sniper Stock';
        stock.position.z = 0.3;
        group.add(stock);

        const body = new THREE.Mesh(
            new THREE.BoxGeometry(0.18, 0.16, 0.58),
            new THREE.MeshStandardMaterial({ color: 0x1f2937, metalness: 0.62, roughness: 0.24 })
        );
        body.name = 'Sniper Body';
        body.position.z = -0.05;
        group.add(body);

        const barrel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.035, 0.045, 1.28, 18),
            new THREE.MeshStandardMaterial({
                color: 0x0f172a,
                metalness: 0.82,
                roughness: 0.18,
                emissive: 0x101827,
                emissiveIntensity: 0.25,
            })
        );
        barrel.name = 'Sniper Barrel';
        barrel.rotation.x = Math.PI / 2;
        barrel.position.z = -0.72;
        group.add(barrel);

        const scope = new THREE.Mesh(
            new THREE.CylinderGeometry(0.06, 0.06, 0.42, 16),
            new THREE.MeshStandardMaterial({ color: 0x020617, metalness: 0.5, roughness: 0.28 })
        );
        scope.name = 'Sniper Scope';
        scope.rotation.z = Math.PI / 2;
        scope.position.set(0, 0.13, -0.12);
        group.add(scope);

        const muzzle = new THREE.Mesh(
            new THREE.SphereGeometry(0.055, 16, 10),
            new THREE.MeshBasicMaterial({ color: 0xbde7ff })
        );
        muzzle.name = 'Sniper Muzzle';
        muzzle.position.z = -1.38;
        group.add(muzzle);
        return group;
    }

    function makeDoomShotgunHudTexture() {
        const W = 160, H = 112;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);
        ctx.imageSmoothingEnabled = false;

        const rect = (x, y, w, h, color) => {
            ctx.fillStyle = color;
            ctx.fillRect(x, y, w, h);
        };

        const poly = (points, color) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(points[0][0], points[0][1]);
            for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
            ctx.closePath();
            ctx.fill();
        };

        rect(25, 104, 110, 5, '#050505');

        poly([[52, 6], [73, 6], [82, 80], [43, 80]], '#020202');
        poly([[87, 6], [108, 6], [117, 80], [78, 80]], '#020202');
        poly([[57, 9], [68, 9], [75, 75], [51, 75]], '#1f2322');
        poly([[92, 9], [103, 9], [109, 75], [86, 75]], '#272a28');
        poly([[61, 11], [66, 11], [70, 71], [58, 71]], '#565852');
        poly([[94, 11], [100, 11], [104, 71], [92, 71]], '#60625b');
        rect(54, 5, 20, 8, '#080808');
        rect(86, 5, 20, 8, '#080808');
        rect(59, 7, 10, 3, '#000000');
        rect(91, 7, 10, 3, '#000000');

        poly([[73, 15], [87, 15], [88, 79], [72, 79]], '#090909');
        rect(76, 20, 8, 52, '#20201d');
        rect(78, 20, 4, 48, '#52524b');

        poly([[37, 66], [123, 66], [134, 101], [26, 101]], '#050505');
        poly([[45, 69], [115, 69], [123, 89], [37, 89]], '#1b1b18');
        poly([[51, 72], [109, 72], [114, 82], [46, 82]], '#55554e');
        poly([[46, 83], [114, 83], [126, 101], [34, 101]], '#0d0907');
        poly([[52, 84], [108, 84], [116, 96], [44, 96]], '#2e2118');
        rect(56, 88, 48, 4, '#5a4030');
        rect(62, 95, 36, 5, '#120d0a');

        poly([[17, 88], [43, 79], [62, 102], [25, 110]], '#80502f');
        poly([[143, 88], [117, 79], [98, 102], [135, 110]], '#8c5735');
        poly([[23, 90], [42, 85], [53, 99], [30, 104]], '#c58b61');
        poly([[137, 90], [118, 85], [107, 99], [130, 104]], '#d39666');
        rect(54, 100, 52, 8, '#050505');

        const tex = new THREE.CanvasTexture(canvas);
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        return tex;
    }

    function makeDoomShotgunFlashTexture() {
        const W = 64, H = 64;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);
        ctx.imageSmoothingEnabled = false;

        const rect = (x, y, w, h, color) => {
            ctx.fillStyle = color;
            ctx.fillRect(x, y, w, h);
        };

        rect(28, 4, 8, 52, '#fff7b8');
        rect(18, 12, 28, 32, '#ff2b16');
        rect(22, 8, 20, 42, '#ff6b1a');
        rect(27, 10, 10, 36, '#fff1a8');
        rect(10, 24, 44, 10, '#ff1a12');
        rect(16, 26, 32, 6, '#ffd35a');

        const tex = new THREE.CanvasTexture(canvas);
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        return tex;
    }

    function createHeldDoomShotgunMesh() {
        const group = new THREE.Group();
        group.name = 'Held Doom Shotgun Sprite';

        const gunTex = makeDoomShotgunHudTexture();
        const gunMat = new THREE.MeshBasicMaterial({
            map: gunTex,
            transparent: true,
            alphaTest: 0.05,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        gunMat.toneMapped = false;
        const gun = new THREE.Mesh(new THREE.PlaneGeometry(1.22, 0.86), gunMat);
        gun.name = 'Doom Shotgun HUD';
        gun.position.set(0, -0.52, -1.05);
        gun.rotation.x = -0.13;
        gun.renderOrder = 1000;
        group.add(gun);

        const flashTex = makeDoomShotgunFlashTexture();
        const flashMat = new THREE.MeshBasicMaterial({
            map: flashTex,
            transparent: true,
            alphaTest: 0.05,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        flashMat.toneMapped = false;
        const flash = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.68), flashMat);
        flash.name = 'Doom Shotgun Muzzle Flash';
        flash.position.set(0, -0.24, -1.55);
        flash.rotation.x = -0.13;
        flash.renderOrder = 999;
        flash.visible = false;
        group.add(flash);

        group.userData.ownedTextures = [gunTex, flashTex];
        group.userData.flash = flash;
        group.userData.flashUntil = 0;
        return group;
    }

    function clearHeldWeapon() {
        const heldMesh = gameplay.weapon.mesh;
        if (heldMesh) {
            heldMesh.parent?.remove(heldMesh);
            for (const tex of heldMesh.userData?.ownedTextures || []) {
                tex?.dispose?.();
            }
            heldMesh.traverse?.((node) => {
                node.geometry?.dispose?.();
                if (Array.isArray(node.material)) {
                    node.material.forEach((material) => material?.dispose?.());
                } else {
                    node.material?.dispose?.();
                }
            });
        }
        gameplay.weapon.type = '';
        gameplay.weapon.mesh = null;
        gameplay.weapon.nextShotAt = 0;
        gameplay.weapon.sourceActorId = '';
        gameplay.input.fire = false;
        gameplay.input.firePressed = false;
        gameplay.input.reloadPressed = false;
        const weaponHudEl = getWeaponHudEl?.();
        if (weaponHudEl) weaponHudEl.style.opacity = '0';
    }

    function equipStraightGun(sourceActor = null) {
        if (gameplay.weapon.type === 'smg') return;
        clearHeldWeapon();
        const heldMesh = createHeldStraightGunMesh();
        getCamera()?.add(heldMesh);
        gameplay.weapon.type = 'smg';
        gameplay.weapon.mesh = heldMesh;
        gameplay.weapon.nextShotAt = 0;
        gameplay.weapon.sourceActorId = sourceActor?.id || '';
    }

    function equipSniperRifle(sourceActor = null) {
        if (gameplay.weapon.type === 'sniperRifle') return;
        clearHeldWeapon();
        const heldMesh = createHeldSniperRifleMesh();
        getCamera()?.add(heldMesh);
        gameplay.weapon.type = 'sniperRifle';
        gameplay.weapon.mesh = heldMesh;
        gameplay.weapon.nextShotAt = 0;
        gameplay.weapon.sourceActorId = sourceActor?.id || '';
    }

    function equipDoomShotgun(sourceActor = null) {
        if (gameplay.weapon.type === 'doomShotgun') return;
        clearHeldWeapon();
        const heldMesh = createHeldDoomShotgunMesh();
        getCamera()?.add(heldMesh);
        gameplay.weapon.type = 'doomShotgun';
        gameplay.weapon.mesh = heldMesh;
        gameplay.weapon.nextShotAt = 0;
        gameplay.weapon.sourceActorId = sourceActor?.id || '';
    }

    function equipThrowingStar(sourceActor = null) {
        if (gameplay.weapon.type === 'throwingStar') return;
        clearHeldWeapon();
        const heldMesh = createHeldThrowingStarMesh();
        getCamera()?.add(heldMesh);
        gameplay.weapon.type = 'throwingStar';
        gameplay.weapon.mesh = heldMesh;
        gameplay.weapon.nextShotAt = 0;
        gameplay.weapon.sourceActorId = sourceActor?.id || '';
    }

    function updateDoomShotgunHud(now = performance.now?.() || Date.now()) {
        const flash = gameplay.weapon.mesh?.userData?.flash;
        if (flash) flash.visible = now < (gameplay.weapon.mesh.userData.flashUntil || 0);
    }

    // Low-level primitive: spawn ONE pellet from the camera, aimed forward with
    // an optional spread offset (in the camera's right/up plane). Every numeric
    // is overridable so the prefab user script owns ALL weapon behavior (pellet
    // count, spread pattern, burst, cooldown, damage). Engine keeps no weapon
    // logic — just camera math + projectile pooling. spreadX/spreadY are the
    // per-pellet aim offsets; pass them from whatever pattern the script wants.
    function spawnDoomPellet(opts = {}) {
        const camera = getCamera();
        if (!camera) return false;
        const d = DOOM_SHOTGUN;
        const spreadX = Number(opts.spreadX) || 0;
        const spreadY = Number(opts.spreadY) || 0;
        camera.getWorldDirection(tmp.c).normalize();
        tmp.d.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
        tmp.e.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
        const origin = camera.localToWorld(tmp.a.set(0, -0.08, -0.85));
        const velocity = tmp.f.copy(tmp.c)
            .addScaledVector(tmp.d, spreadX)
            .addScaledVector(tmp.e, spreadY)
            .normalize();
        // Snapshot before spawnShooterProjectile mutates the shared temp vectors.
        const ox = origin.x, oy = origin.y, oz = origin.z;
        const vx = velocity.x, vy = velocity.y, vz = velocity.z;
        spawnShooterProjectile(origin, null, {
            velocity,
            name: 'Doom Shotgun Pellet',
            poolKey: 'doomShotgunPellets',
            maxPoolSize: opts.poolSize ?? d.bulletPoolSize,
            radius: opts.radius ?? 0.065,
            color: opts.color ?? 0xfff1a8,
            speed: opts.speed ?? d.projectileSpeed,
            life: opts.life ?? d.projectileLife,
            damage: opts.damage ?? d.damage,
            hitRadius: opts.hitRadius ?? d.hitRadius,
            hitsPlayer: opts.hitsPlayer ?? false,
            damagesShooters: opts.damagesShooters ?? true,
            emissiveIntensity: opts.emissiveIntensity ?? 4.8,
            light: opts.light ?? false,
        });
        if (opts.tracer !== false) {
            spawnTracer(ox, oy, oz, vx, vy, vz, opts.tracerLen ?? 7, opts.color ?? 0xfff1a8);
        }
        return true;
    }

    // Show the held-weapon muzzle flash for `ms` from now (purely cosmetic).
    function flashDoomShotgun(ms = DOOM_SHOTGUN.flashMs, now = performance.now?.() || Date.now()) {
        if (gameplay.weapon.mesh?.userData) {
            gameplay.weapon.mesh.userData.flashUntil = now + ms;
        }
        updateDoomShotgunHud(now);
    }

    return {
        addStraightGunVisual,
        createHeldThrowingStarMesh,
        createHeldStraightGunMesh,
        createHeldSniperRifleMesh,
        makeDoomShotgunHudTexture,
        makeDoomShotgunFlashTexture,
        createHeldDoomShotgunMesh,
        clearHeldWeapon,
        equipStraightGun,
        equipSniperRifle,
        equipDoomShotgun,
        equipThrowingStar,
        updateDoomShotgunHud,
        spawnDoomPellet,
        flashDoomShotgun,
    };
}
