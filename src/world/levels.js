import * as THREE from 'three';
import { DDGIMeshStandardNodeMaterial } from '../world/gi/DDGIMeshStandardNodeMaterial.js';
import { getProceduralBrickSet } from '../world/materials/proceduralBrickTexture.js';
import { registerBrickClone } from '../world/materials/brickTextures.js';

// Built-in level builders (FPS starter, soccer field, brick room, DOOM test
// & arena) plus DOOM enemy sprite-sheet generation. Extracted verbatim from
// runtime.js. Heavy THREE construction + actor spawning; engine deps are
// injected (same wireExtractedModules factory pattern as createRogueWaves).
export function createLevels(deps) {
    const {
        PLAYER_SETTINGS, physics, soccerGoalieState,
        actorBelongsToCurrentMesh, applyPlayerSpawnFromActor, buildPrimitiveActorMesh,
        configurePointLightShadow, createDoomMiniBarrierEntries, createDynamicPropActor,
        createTerrainMesh, getActorBody, getActorRenderObject, markDDGISkipCapture,
        rebuildActorPhysics, resetRogueState, setActorColor, setActorComponentFlags,
        setActorResetTransform, setActorWorldPositionExact, setTerrainModeGrid,
        spawnDynamicPrimitive, spawnGameplayPrefab, tagGameplayPrefabActor,
        tintGameplayPrefabActor, updateSoccerGoalies, getCurrentMesh,
    } = deps;
    // Live accessor: currentMesh is reassigned on every level load in
    // runtime.js, so always read it through the injected getter (never capture).
    const cm = () => getCurrentMesh();

    function makeSampleLevelPart(name, shape, material, position, rotation = [0, 0, 0], { castShadow = true, receiveShadow = true, skipPhysicsCollision = false } = {}) {
        const kind = shape?.kind;
        const mesh = kind ? buildPrimitiveActorMesh(kind) : null;
        if (!mesh) return null;

        const defaultMaterial = mesh.material;
        if (Array.isArray(defaultMaterial)) {
            defaultMaterial.forEach((entry) => entry?.dispose?.());
        } else {
            defaultMaterial?.dispose?.();
        }

        mesh.material = material;
        mesh.name = name;
        mesh.position.fromArray(position);
        mesh.rotation.set(...rotation);
        if (Array.isArray(shape?.scale) && shape.scale.length === 3) {
            mesh.scale.fromArray(shape.scale);
        }
        mesh.userData.hasMaterialOverrides = true;
        mesh.userData.skipPhysicsCollision = !!skipPhysicsCollision;
        mesh.castShadow = castShadow;
        mesh.receiveShadow = receiveShadow;

        return createDynamicPropActor({
            body: null,
            mesh,
            kind,
            userData: {
                label: name,
                sampleLevelPart: true,
            },
            includeScripts: false,
        });
    }

    function makeSampleLevelMeshActor(name, mesh, {
        kind = 'imported',
        castShadow = false,
        receiveShadow = true,
        skipPhysicsCollision = false,
        userData = {},
    } = {}) {
        if (!mesh) return null;

        mesh.name = name;
        mesh.userData = {
            ...(mesh.userData || {}),
            hasMaterialOverrides: true,
            skipPhysicsCollision: !!skipPhysicsCollision,
        };
        mesh.castShadow = castShadow;
        mesh.receiveShadow = receiveShadow;

        return createDynamicPropActor({
            body: null,
            mesh,
            kind,
            userData: {
                label: name,
                sampleLevelPart: true,
                ...userData,
            },
            includeScripts: false,
        });
    }

    function enableStaticMeshActorCollision(actor, { friction = 0.9, restitution = 0.08 } = {}) {
        const mesh = getActorRenderObject(actor);
        if (!actor || !mesh) return false;

        actor.userData.staticMeshActorCollision = true;
        actor.userData.physicsFriction = friction;
        actor.userData.physicsRestitution = restitution;
        mesh.userData.skipPhysicsCollision = true;
        setActorComponentFlags(actor, { collision: true, physics: false, scripts: false });
        rebuildActorPhysics(actor);
        return !!getActorBody(actor);
    }

    function createFpsStarterLevel() {
        const MAP_SCALE = 2;
        const scaleScalar = (value) => value * MAP_SCALE;
        const scaleVector = (values) => values.map((value) => value * MAP_SCALE);
        const makeBoxShape = (size) => ({
            kind: 'cube',
            scale: [scaleScalar(size[0]) * 0.5, scaleScalar(size[1]) * 0.5, scaleScalar(size[2]) * 0.5],
        });
        const makeCylinderShape = (radius, height) => ({
            kind: 'cylinder',
            scale: [scaleScalar(radius), scaleScalar(height) * 0.5, scaleScalar(radius)],
        });

        const root = new THREE.Group();
        root.name = 'PolyFlow_FPS_Starter_Level';
        root.userData.sampleType = 'fpsStarterLevel';
        root.userData.hideTerrainPresentation = true;
        root.userData.skipNormalization = true;
        root.userData.sampleMapScale = MAP_SCALE;

        root.userData.preferredSpawn = {
            position: scaleVector([0.0, 0.3, 8.6]),
            yaw: Math.PI,
            pitch: -0.06,
        };
        root.userData.preferredShowcase = {
            position: scaleVector([20.0, 13.5, 16.5]),
            target: scaleVector([0.0, 1.7, -1.0]),
        };

        const stylePresets = {
            light: { baseColor: '#d4cec8', roughness: 0.97, metalness: 0.02 },
            floor: { baseColor: '#a7adb4', roughness: 0.96, metalness: 0.02 },
            dark: { baseColor: '#5a5d61', roughness: 0.92, metalness: 0.05 },
            blue: { baseColor: '#149cff', roughness: 0.34, metalness: 0.04 },
        };

        const createGridMaterial = ({ baseColor, roughness = 0.95, metalness = 0.02 }) => {
            return new THREE.MeshStandardMaterial({
                color: new THREE.Color(baseColor),
                roughness,
                metalness,
            });
        };

        const createMaterial = (styleName) => {
            const style = stylePresets[styleName] ?? stylePresets.light;
            return createGridMaterial({
                baseColor: style.baseColor,
                roughness: style.roughness,
                metalness: style.metalness,
            });
        };

        const contactShadowMaterialCache = new Map();
        const smoothstep = (edge0, edge1, value) => {
            const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
            return t * t * (3 - 2 * t);
        };
        const createDistanceFieldContactShadowMaterial = (width, depth, spread = 2.2, strength = 0.55) => {
            const key = `${width.toFixed(2)}:${depth.toFixed(2)}:${spread.toFixed(2)}:${strength.toFixed(2)}`;
            if (contactShadowMaterialCache.has(key)) {
                return contactShadowMaterialCache.get(key).clone();
            }

            const canvas = document.createElement('canvas');
            canvas.width = 192;
            canvas.height = 192;
            const ctx = canvas.getContext('2d');
            const image = ctx.createImageData(canvas.width, canvas.height);
            const planeWidth = width + spread * 2;
            const planeDepth = depth + spread * 2;

            for (let y = 0; y < canvas.height; y++) {
                for (let x = 0; x < canvas.width; x++) {
                    const u = (x + 0.5) / canvas.width - 0.5;
                    const v = (y + 0.5) / canvas.height - 0.5;
                    const px = u * planeWidth;
                    const pz = v * planeDepth;
                    const dx = Math.max(Math.abs(px) - width * 0.5, 0);
                    const dz = Math.max(Math.abs(pz) - depth * 0.5, 0);
                    const dist = Math.sqrt(dx * dx + dz * dz);
                    const contact = 1 - smoothstep(0, spread, dist);
                    const insideFade = smoothstep(-0.05, 0.45, Math.max(dx, dz));
                    const alpha = Math.round(255 * strength * Math.max(contact, insideFade * contact));
                    const index = (y * canvas.width + x) * 4;
                    image.data[index] = 0;
                    image.data[index + 1] = 0;
                    image.data[index + 2] = 0;
                    image.data[index + 3] = alpha;
                }
            }
            ctx.putImageData(image, 0, 0);

            const texture = new THREE.CanvasTexture(canvas);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
            const material = new THREE.MeshBasicMaterial({
                color: 0x000000,
                map: texture,
                transparent: true,
                depthTest: true,
                depthWrite: false,
                opacity: 1,
                toneMapped: false,
            });
            material.userData = { ownedMaps: [texture] };
            contactShadowMaterialCache.set(key, material);
            return material.clone();
        };
        const addDistanceFieldContactShadow = (name, size, position, options = {}) => {
            if (options.contactShadow === false) return null;
            const rotation = Array.isArray(options.rotation) ? options.rotation : [0, 0, 0];
            if (Math.abs(rotation[0] || 0) > 1e-4 || Math.abs(rotation[2] || 0) > 1e-4) return null;
            if ((position[1] - size[1] * 0.5) > 0.25 || size[1] < 0.5) return null;

            const width = scaleScalar(Math.max(size[0], 0.35));
            const depth = scaleScalar(Math.max(size[2], 0.35));
            const spread = THREE.MathUtils.clamp(Math.min(width, depth) * 0.72, 2.0, 5.5);
            const mesh = new THREE.Mesh(
                new THREE.PlaneGeometry(width + spread * 2, depth + spread * 2),
                createDistanceFieldContactShadowMaterial(width, depth, spread)
            );
            mesh.name = `${name}_DistanceFieldContactShadow`;
            const scaledPosition = scaleVector(position);
            mesh.position.set(scaledPosition[0], 0.455, scaledPosition[2]);
            mesh.rotation.set(-Math.PI / 2, 0, -(rotation[1] || 0));
            mesh.renderOrder = 6;
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            mesh.userData.skipPhysicsCollision = true;
            markDDGISkipCapture(mesh);
            root.add(mesh);
            return mesh;
        };

        const createBoxNode = (name, size, position, styleName = 'light', options = {}) => {
            return makeSampleLevelPart(name, makeBoxShape(size), createMaterial(styleName), scaleVector(position), options.rotation || [0, 0, 0], options);
        };

        const createCylinderNode = (name, radius, height, position, styleName = 'light', options = {}) => {
            return makeSampleLevelPart(name, makeCylinderShape(radius, height), createMaterial(styleName), scaleVector(position), options.rotation || [0, 0, 0], options);
        };

        const addNode = (actor) => {
            const mesh = getActorRenderObject(actor);
            if (mesh) {
                root.add(mesh);
            }
            return actor;
        };

        const addBox = (name, size, position, styleName = 'light', options = {}) => {
            const actor = addNode(createBoxNode(name, size, position, styleName, options));
            addDistanceFieldContactShadow(name, size, position, options);
            return actor;
        };
        const addCylinder = (name, radius, height, position, styleName = 'light', options = {}) => addNode(createCylinderNode(name, radius, height, position, styleName, options));
        const addCollisionPlane = (name, size, position) => {
            const mesh = new THREE.Mesh(
                new THREE.PlaneGeometry(scaleScalar(size[0]), scaleScalar(size[1])),
                new THREE.MeshBasicMaterial({ visible: false })
            );
            mesh.name = name;
            mesh.position.fromArray(scaleVector(position));
            mesh.rotation.x = -Math.PI / 2;
            mesh.visible = false;
            mesh.userData.collisionOnly = true;
            root.add(mesh);
            return mesh;
        };

        addBox('Graybox_Floor', [36, 0.2, 22], [0, 0.1, 0], 'floor', { skipPhysicsCollision: true, contactShadow: false });
        addCollisionPlane('Graybox_Floor_Collision', [36, 22], [0, 0.21, 0]);
        addBox('Graybox_LeftWall', [0.45, 5.4, 22], [-17.78, 2.7, 0], 'dark');
        addBox('Graybox_RightWall', [0.45, 5.4, 22], [17.78, 2.7, 0], 'dark');
        addBox('Graybox_BackWall', [36, 5.4, 0.45], [0, 2.7, -10.78], 'light');
        addBox('Graybox_FrontWall', [36, 5.4, 0.45], [0, 2.7, 10.78], 'light');
        addBox('Graybox_BackRightPanel', [10.5, 5.2, 0.18], [11.6, 2.6, -10.56], 'dark', { castShadow: false });
        addBox('Graybox_RightRearPanel', [0.18, 5.2, 8.4], [17.62, 2.6, -6.35], 'dark', { castShadow: false });

        addBox('Graybox_LeftBlock', [5.8, 2.6, 4.4], [-8.6, 1.3, -0.9], 'light');
        addBox('Graybox_LeftRamp', [4.2, 0.34, 6.0], [-12.4, 1.06, -2.7], 'dark', { rotation: [0.28, 0, 0] });
        addBox('Graybox_CenterBackBar', [11.0, 2.7, 2.2], [2.0, 1.35, -2.8], 'dark');
        addBox('Graybox_CenterFrontBar', [2.05, 2.25, 7.2], [2.0, 1.125, 3.0], 'dark');
        addBox('Graybox_RightFrontBar', [10.0, 2.5, 2.35], [10.6, 1.25, 4.2], 'dark');
        addCylinder('Graybox_RightCylinder', 1.8, 2.2, [9.4, 1.1, -2.7], 'light');
        addBox('Graybox_RightRearShelf', [6.6, 0.8, 2.2], [10.9, 0.4, -6.1], 'dark');

        return root;
    }

    const SOCCER_FIELD_LEVEL_SCALE = 3;

    function createSoccerTargetFieldScene({
        name = 'PolyFlow_Soccer_Target_Field',
        hideTerrainPresentation = true,
    } = {}) {
        const S = SOCCER_FIELD_LEVEL_SCALE;
        const FIELD_WIDTH = 18 * S;
        const FIELD_LENGTH = 28 * S;
        const GOAL_Z = FIELD_LENGTH * 0.5 - 0.45 * S;
        const LINE_Y = 0.145 * S;

        const root = new THREE.Group();
        root.name = name;
        root.userData.sampleType = 'soccerTargetField';
        root.userData.hideTerrainPresentation = hideTerrainPresentation;
        root.userData.skipNormalization = true;
        root.userData.preferredSpawn = {
            position: [0, 0.24 * S, FIELD_LENGTH * 0.34],
            yaw: Math.PI,
            pitch: -0.08,
        };
        root.userData.preferredShowcase = {
            position: [12.5 * S, 9.2 * S, 19.5 * S],
            target: [0, 0.45 * S, 0],
        };
        root.userData.soccerGoalTargets = [
            { position: [-2.2 * S, 1.35 * S, -GOAL_Z], rotationY: Math.PI, label: 'North Goal Target L', scale: S },
            { position: [2.2 * S, 1.35 * S, -GOAL_Z], rotationY: Math.PI, label: 'North Goal Target R', scale: S },
            { position: [-2.2 * S, 1.35 * S, GOAL_Z], rotationY: 0, label: 'South Goal Target L', scale: S },
            { position: [2.2 * S, 1.35 * S, GOAL_Z], rotationY: 0, label: 'South Goal Target R', scale: S },
        ];
        root.userData.soccerGoalies = [
            {
                position: [0, 0.78 * S, -GOAL_Z + 0.9 * S],
                size: [1.7 * S, 1.35 * S, 0.24 * S],
                axis: [1, 0, 0],
                amplitude: 1.65 * S,
                speed: 1.7,
                phase: 0,
                label: 'North Goalie Wall',
            },
            {
                position: [0, 0.78 * S, GOAL_Z - 0.9 * S],
                size: [1.7 * S, 1.35 * S, 0.24 * S],
                axis: [1, 0, 0],
                amplitude: 1.65 * S,
                speed: 1.7,
                phase: Math.PI,
                label: 'South Goalie Wall',
            },
        ];
        root.userData.soccerPlayerSpawns = [
            { playerIndex: 1, position: [0, 0.85, FIELD_LENGTH * 0.34], label: 'Player 1 Spawn', color: '#22c55e' },
            { playerIndex: 2, position: [0, 0.85, -FIELD_LENGTH * 0.34], label: 'Player 2 Spawn', color: '#38bdf8' },
        ];

        const materials = {
            turf: new THREE.MeshStandardMaterial({ color: 0x2f7d32, roughness: 0.86, metalness: 0.02 }),
            turfStripe: new THREE.MeshStandardMaterial({ color: 0x3f9a42, roughness: 0.88, metalness: 0.02 }),
            line: new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.62, metalness: 0.0 }),
            goalFrame: new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.54, metalness: 0.04 }),
            net: new THREE.MeshStandardMaterial({
                color: 0xdbeafe,
                roughness: 0.6,
                metalness: 0,
                transparent: true,
                opacity: 0.24,
                side: THREE.DoubleSide,
            }),
        };

        const addBox = (name, size, position, material, options = {}) => {
            const actor = makeSampleLevelPart(
                name,
                { kind: 'cube', scale: [size[0] * 0.5, size[1] * 0.5, size[2] * 0.5] },
                material,
                position,
                options.rotation || [0, 0, 0],
                options
            );
            const mesh = getActorRenderObject(actor);
            if (mesh) root.add(mesh);
            return mesh;
        };

        addBox('Soccer_Field_Surface', [FIELD_WIDTH, 0.12 * S, FIELD_LENGTH], [0, 0.06 * S, 0], materials.turf, {
            contactShadow: false,
            receiveShadow: true,
        });

        for (let index = -3; index <= 3; index += 1) {
            addBox(
                `Soccer_Turf_Stripe_${index + 4}`,
                [FIELD_WIDTH - 0.18 * S, 0.012 * S, FIELD_LENGTH / 7 - 0.08 * S],
                [0, 0.132 * S, index * FIELD_LENGTH / 7],
                index % 2 === 0 ? materials.turfStripe : materials.turf,
                { skipPhysicsCollision: true, castShadow: false, receiveShadow: false }
            );
        }

        const addLine = (name, size, position) => addBox(name, size, position, materials.line, {
            skipPhysicsCollision: true,
            castShadow: false,
            receiveShadow: false,
        });

        addLine('Soccer_Line_LeftTouch', [0.08 * S, 0.026 * S, FIELD_LENGTH], [-FIELD_WIDTH * 0.5, LINE_Y, 0]);
        addLine('Soccer_Line_RightTouch', [0.08 * S, 0.026 * S, FIELD_LENGTH], [FIELD_WIDTH * 0.5, LINE_Y, 0]);
        addLine('Soccer_Line_NorthGoal', [FIELD_WIDTH, 0.026 * S, 0.08 * S], [0, LINE_Y, -FIELD_LENGTH * 0.5]);
        addLine('Soccer_Line_SouthGoal', [FIELD_WIDTH, 0.026 * S, 0.08 * S], [0, LINE_Y, FIELD_LENGTH * 0.5]);
        addLine('Soccer_Line_Midfield', [FIELD_WIDTH, 0.026 * S, 0.07 * S], [0, LINE_Y, 0]);
        addLine('Soccer_Box_North_Back', [6.7 * S, 0.026 * S, 0.07 * S], [0, LINE_Y, -FIELD_LENGTH * 0.5 + 3.9 * S]);
        addLine('Soccer_Box_North_Left', [0.07 * S, 0.026 * S, 3.9 * S], [-3.35 * S, LINE_Y, -FIELD_LENGTH * 0.5 + 1.95 * S]);
        addLine('Soccer_Box_North_Right', [0.07 * S, 0.026 * S, 3.9 * S], [3.35 * S, LINE_Y, -FIELD_LENGTH * 0.5 + 1.95 * S]);
        addLine('Soccer_Box_South_Back', [6.7 * S, 0.026 * S, 0.07 * S], [0, LINE_Y, FIELD_LENGTH * 0.5 - 3.9 * S]);
        addLine('Soccer_Box_South_Left', [0.07 * S, 0.026 * S, 3.9 * S], [-3.35 * S, LINE_Y, FIELD_LENGTH * 0.5 - 1.95 * S]);
        addLine('Soccer_Box_South_Right', [0.07 * S, 0.026 * S, 3.9 * S], [3.35 * S, LINE_Y, FIELD_LENGTH * 0.5 - 1.95 * S]);

        const centerCircle = new THREE.Mesh(
            new THREE.TorusGeometry(2.25 * S, 0.035 * S, 8, 96),
            materials.line.clone()
        );
        centerCircle.name = 'Soccer_Line_CenterCircle';
        centerCircle.position.set(0, LINE_Y + 0.018 * S, 0);
        centerCircle.rotation.x = Math.PI / 2;
        centerCircle.castShadow = false;
        centerCircle.receiveShadow = false;
        centerCircle.userData.skipPhysicsCollision = true;
        root.add(centerCircle);

        const addGoalFrame = (prefix, z, dir) => {
            const depth = 1.2 * S;
            const mouthWidth = 5.6 * S;
            const postHeight = 1.85 * S;
            const postThickness = 0.12 * S;
            const backZ = z + dir * depth;
            const postY = 0.12 * S + postHeight * 0.5;
            const topY = 0.12 * S + postHeight;

            addBox(`${prefix}_LeftPost`, [postThickness, postHeight, postThickness], [-mouthWidth * 0.5, postY, z], materials.goalFrame, { skipPhysicsCollision: true });
            addBox(`${prefix}_RightPost`, [postThickness, postHeight, postThickness], [mouthWidth * 0.5, postY, z], materials.goalFrame, { skipPhysicsCollision: true });
            addBox(`${prefix}_Crossbar`, [mouthWidth + postThickness, postThickness, postThickness], [0, topY, z], materials.goalFrame, { skipPhysicsCollision: true });
            addBox(`${prefix}_BackBar`, [mouthWidth + postThickness, postThickness, postThickness], [0, topY, backZ], materials.goalFrame, { skipPhysicsCollision: true });
            addBox(`${prefix}_LeftDepth`, [postThickness, postThickness, depth], [-mouthWidth * 0.5, topY, z + dir * depth * 0.5], materials.goalFrame, { skipPhysicsCollision: true });
            addBox(`${prefix}_RightDepth`, [postThickness, postThickness, depth], [mouthWidth * 0.5, topY, z + dir * depth * 0.5], materials.goalFrame, { skipPhysicsCollision: true });
            addBox(`${prefix}_Net`, [mouthWidth, postHeight, 0.035], [0, postY, backZ], materials.net, {
                skipPhysicsCollision: true,
                castShadow: false,
                receiveShadow: false,
            });
        };

        addGoalFrame('Soccer_NorthGoal', -GOAL_Z, -1);
        addGoalFrame('Soccer_SouthGoal', GOAL_Z, 1);

        return root;
    }

    function spawnSoccerGoalTarget(spec) {
        const targetScale = Number.isFinite(spec.scale) && spec.scale > 0 ? spec.scale : 1;
        const actor = spawnDynamicPrimitive('cylinder', new THREE.Vector3(...spec.position), 0.6 * targetScale, {
            local: false,
            includeCollisionBody: true,
            simulatePhysics: false,
            includeScripts: false,
            skipImpulse: true,
            userData: { label: spec.label },
            returnActor: true,
        });
        const mesh = getActorRenderObject(actor);
        if (!actor || !mesh) return null;

        mesh.position.fromArray(spec.position);
        mesh.rotation.set(Math.PI / 2, spec.rotationY || 0, 0);
        mesh.scale.set(0.45 * targetScale, 0.06 * targetScale, 0.45 * targetScale);
        mesh.name = spec.label;
        tagGameplayPrefabActor(actor, 'target', { triggerRadius: 0.62 * targetScale, groundOffset: spec.position[1], scoreValue: 25 });
        mesh.position.fromArray(spec.position);
        mesh.updateMatrixWorld(true);
        actor.userData.label = spec.label;
        tintGameplayPrefabActor(actor, '#ef4444', '#ef4444', 1.4);
        rebuildActorPhysics(actor);
        setActorResetTransform(actor, spec.position, mesh.quaternion);
        return actor;
    }

    function spawnSoccerGoalie(spec) {
        if (!Array.isArray(spec?.position) || spec.position.length !== 3) return null;

        const size = Array.isArray(spec.size) && spec.size.length === 3
            ? spec.size
            : [SOCCER_FIELD_LEVEL_SCALE * 1.7, SOCCER_FIELD_LEVEL_SCALE * 1.35, SOCCER_FIELD_LEVEL_SCALE * 0.24];
        const actor = spawnDynamicPrimitive('cube', new THREE.Vector3(...spec.position), 1, {
            local: false,
            includeCollisionBody: true,
            simulatePhysics: false,
            includeScripts: false,
            skipImpulse: true,
            userData: {
                label: spec.label || 'Soccer Goalie Wall',
                soccerGoalie: true,
                kinematic: true,
                friction: 0.88,
                restitution: 0.12,
                soccerGoalieMotion: {
                    homePosition: [...spec.position],
                    axis: Array.isArray(spec.axis) && spec.axis.length === 3 ? [...spec.axis] : [1, 0, 0],
                    amplitude: Number.isFinite(spec.amplitude) ? spec.amplitude : SOCCER_FIELD_LEVEL_SCALE * 1.65,
                    speed: Number.isFinite(spec.speed) ? spec.speed : 1.7,
                    phase: Number.isFinite(spec.phase) ? spec.phase : 0,
                },
            },
            returnActor: true,
        });
        const mesh = getActorRenderObject(actor);
        if (!actor || !mesh) return null;

        mesh.position.fromArray(spec.position);
        mesh.scale.set(
            Math.max(0.08, size[0] * 0.5),
            Math.max(0.08, size[1] * 0.5),
            Math.max(0.04, size[2] * 0.5)
        );
        mesh.name = spec.label || 'Soccer Goalie Wall';
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        actor.userData.label = mesh.name;
        actor.userData.soccerGoalie = true;
        tintGameplayPrefabActor(actor, '#ef4444', '#7f1d1d', 0.42);
        rebuildActorPhysics(actor);
        setActorResetTransform(actor, spec.position, mesh.quaternion);
        return actor;
    }

    function spawnSoccerPlayerSpawn(spec) {
        const actor = spawnDynamicPrimitive('capsule', new THREE.Vector3(...spec.position), 0.75, {
            local: false,
            includeCollisionBody: false,
            includeScripts: false,
            skipImpulse: true,
            userData: { label: spec.label, playerIndex: spec.playerIndex },
            returnActor: true,
        });
        const mesh = getActorRenderObject(actor);
        if (!actor || !mesh) return null;

        mesh.position.fromArray(spec.position);
        mesh.name = spec.label;
        tagGameplayPrefabActor(actor, 'playerSpawn', { triggerRadius: 0.9, groundOffset: spec.position[1] });
        mesh.position.fromArray(spec.position);
        mesh.updateMatrixWorld(true);
        actor.userData.label = spec.label;
        actor.userData.playerIndex = spec.playerIndex;
        tintGameplayPrefabActor(actor, spec.color || '#22c55e', spec.color || '#22c55e', 1.8);
        setActorResetTransform(actor, spec.position, mesh.quaternion);
        if (spec.playerIndex === 1) {
            applyPlayerSpawnFromActor(actor);
        }
        return actor;
    }

    function spawnSoccerBall() {
        const actor = spawnDynamicPrimitive('sphere', new THREE.Vector3(0, 0.54, 0), 0.38, {
            local: false,
            includeCollisionBody: true,
            simulatePhysics: true,
            includeScripts: false,
            skipImpulse: true,
            mass: 0.45,
            restitution: 0.62,
            friction: 0.72,
            userData: { label: 'Soccer Ball' },
            returnActor: true,
        });
        if (!actor) return null;

        setActorColor(actor, '#f8fafc');
        const mesh = getActorRenderObject(actor);
        if (!mesh) return actor;

        mesh.name = 'Soccer Ball';
        setActorResetTransform(actor, [0, 0.54, 0], mesh.quaternion);
        const patchMaterial = new THREE.MeshStandardMaterial({
            color: 0x111827,
            roughness: 0.56,
            metalness: 0.02,
        });
        const patchPositions = [
            [0, 0.39, 0],
            [0.31, 0.14, 0.18],
            [-0.31, 0.14, 0.18],
            [0.0, 0.14, -0.36],
            [0.22, -0.22, -0.24],
            [-0.22, -0.22, 0.24],
        ];
        patchPositions.forEach((position, index) => {
            const patch = new THREE.Mesh(new THREE.CircleGeometry(0.105, 6), patchMaterial.clone());
            patch.name = `Soccer_Ball_Patch_${index + 1}`;
            patch.position.fromArray(position);
            patch.lookAt(position[0] * 2, position[1] * 2, position[2] * 2);
            patch.userData.skipPhysicsCollision = true;
            mesh.add(patch);
        });
        return actor;
    }

    function createSoccerLevelDefinition({
        id = 'soccerField',
        assetName = 'Soccer Field',
        sceneName = 'Soccer_Field',
        hideTerrainPresentation = true,
    } = {}) {
        return {
            id,
            assetName,
            fileSize: 160000,
            create: () => createSoccerTargetFieldScene({
                name: sceneName,
                hideTerrainPresentation,
            }),
            afterLoad: () => {
                soccerGoalieState.elapsed = 0;
                const playerSpawns = Array.isArray(cm().userData?.soccerPlayerSpawns)
                    ? cm().userData.soccerPlayerSpawns.map(spawnSoccerPlayerSpawn).filter(Boolean)
                    : [];
                const goalTargets = Array.isArray(cm().userData?.soccerGoalTargets)
                    ? cm().userData.soccerGoalTargets.map(spawnSoccerGoalTarget).filter(Boolean)
                    : [];
                const goalies = Array.isArray(cm().userData?.soccerGoalies)
                    ? cm().userData.soccerGoalies.map(spawnSoccerGoalie).filter(Boolean)
                    : [];
                const soccerBall = spawnSoccerBall();
                updateSoccerGoalies(0);
                return playerSpawns[0] || goalTargets[0] || goalies[0] || soccerBall || null;
            },
        };
    }

    function createFlatTerrainLevelDefinition({
        id = 'soccerFieldTerrain',
        assetName = 'Terrain',
        sceneName = 'Terrain',
    } = {}) {
        return {
            id,
            assetName,
            fileSize: 48000,
            create: () => {
                const root = new THREE.Group();
                root.name = sceneName;
                root.userData.sampleType = 'flatTerrainLevel';
                root.userData.hideTerrainPresentation = true;
                root.userData.skipNormalization = true;
                root.userData.preferredSpawn = {
                    position: [0, 1.35, 18],
                    yaw: Math.PI,
                    pitch: -0.08,
                };
                root.userData.preferredShowcase = {
                    position: [28, 18, 28],
                    target: [0, 0.4, 0],
                };

                const terrain = createTerrainMesh();
                terrain.name = 'Flat_Terrain_Surface';
                terrain.castShadow = false;
                terrain.receiveShadow = true;
                const position = terrain.geometry?.getAttribute?.('position');
                if (position) {
                    for (let index = 0; index < position.count; index += 1) {
                        position.setZ(index, 0);
                    }
                    position.needsUpdate = true;
                    terrain.geometry.computeVertexNormals();
                    terrain.geometry.computeBoundingSphere();
                    terrain.geometry.computeBoundingBox();
                }
                setTerrainModeGrid(terrain);
                terrain.material.color.set('#ffffff');
                terrain.material.roughness = 0.96;
                terrain.material.metalness = 0.01;
                terrain.material.needsUpdate = true;
                const terrainActor = makeSampleLevelMeshActor('Flat_Terrain_Surface', terrain, {
                    kind: 'imported',
                    castShadow: false,
                    receiveShadow: true,
                    userData: {
                        flatTerrainActor: true,
                        terrainBrushTarget: true,
                    },
                });
                const terrainMesh = getActorRenderObject(terrainActor);
                if (terrainMesh) root.add(terrainMesh);
                return root;
            },
            afterLoad: () => Array.from(sceneSystem?.actors || []).find((actor) => actorBelongsToCurrentMesh(actor)) || null,
        };
    }

    // Stage 5 feed: point every SilPOM material's self-shadow uniform from a
    // world-space light position toward the mesh it's on. Levels here use
    // static lights, so a one-shot call at build time is sufficient.
    function applySilPomLighting(root, lightWorldPos) {
        const dir = new THREE.Vector3();
        root.updateWorldMatrix(true, true);
        root.traverse((obj) => {
            if (!obj.isMesh) return;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) {
                if (!m?.userData?.silPom || typeof m.setSilPomLightDirection !== 'function') continue;
                obj.getWorldPosition(dir);
                dir.subVectors(lightWorldPos, dir).normalize();
                m.setSilPomLightDirection(dir, obj);
            }
        });
    }

    function createBrickRoomLevel() {
        // Sample level that showcases Parallax Occlusion Mapping — every wall
        // and the floor get a procedurally-generated brick set (albedo + normal
        // + heightmap). Materials are spawned as DDGIMeshStandardNodeMaterial
        // up-front so the World Options "Parallax (POM)" toggle drives the
        // surfaces without needing a manual rebuild. The room is sealed, lit by
        // one warm point light, with a couple of free-standing partitions so the
        // user can walk past edges and see the parallax warp at grazing angles.
        const root = new THREE.Group();
        root.name = 'PolyFlow_Brick_Room';
        root.userData.sampleType = 'brickRoom';
        root.userData.hideTerrainPresentation = true;
        root.userData.skipNormalization = true;

        const ROOM_W = 14;
        const ROOM_D = 14;
        const ROOM_H = 5;
        const WALL_THICKNESS = 0.4;

        root.userData.preferredSpawn = {
            position: [0, 0.3, ROOM_D * 0.5 - 1.5],
            yaw: Math.PI,
            pitch: -0.05,
        };
        root.userData.preferredShowcase = {
            position: [ROOM_W * 0.32, ROOM_H * 0.55, ROOM_D * 0.32],
            target: [0, ROOM_H * 0.42, 0],
        };

        const floorSet = getProceduralBrickSet('white');
        // Showcase pillars use the standalone procedural brick set — a basic
        // canvas brick that is NEVER overwritten by a streamed PolyHaven photo
        // (getBrickTextureSet streams real PBR over its procedural draw, so its
        // procedural look is never actually seen). This is the visible
        // procedural brick.
        const accentSet = getProceduralBrickSet('accent');
        const wallSet = accentSet;

        const makeBrickMaterial = (set, {
            repeatU = 2, repeatV = 2, color = '#ffffff',
            normalScale = 1.2, pomIntensity = 0.03, tileM = null, untile = true,
        } = {}) => {
            // Clone the shared textures so per-material UV repeats don't fight
            // each other — three.js's repeat lives on the texture, not the
            // material. Cloning is cheap; the underlying canvas/image is shared.
            const albedo = set.albedo.clone();
            const normal = set.normal.clone();
            const height = set.height.clone();
            const roughness = set.roughness.clone();
            const ao = set.ao.clone();
            // Subscribe clones to the async PolyHaven PBR upgrade.
            registerBrickClone(set.albedo, albedo);
            registerBrickClone(set.normal, normal);
            registerBrickClone(set.height, height);
            registerBrickClone(set.roughness, roughness);
            registerBrickClone(set.ao, ao);
            for (const t of [albedo, normal, height, roughness, ao]) {
                t.wrapS = t.wrapT = THREE.RepeatWrapping;
                t.repeat.set(repeatU, repeatV);
                t.needsUpdate = true;
            }
            const mat = new DDGIMeshStandardNodeMaterial({
                color: new THREE.Color(color),
                roughness: 1.0, // roughnessMap is multiplicative — keep scalar at 1
                metalness: 0.0,
            });
            mat.map = albedo;
            mat.normalMap = normal;
            mat.normalScale = new THREE.Vector2(normalScale, normalScale);
            mat.roughnessMap = roughness;
            mat.heightMap = height;
            // pomAOMap → sampled at the parallax UV when POM is on. aoMap → the
            // built-in uv2 path used when POM is off (addBox copies uv→uv2).
            mat.pomAOMap = ao;
            mat.aoMap = ao;
            mat.aoMapIntensity = 1.0;
            // POM is opt-in via the global toggle; the material is fully equipped
            // here so flipping World Options → Parallax → On lights it up
            // immediately. Default-off so the level still looks correct without
            // the effect.
            mat.pomEnabled = false;
            // Real PolyHaven disp maps use the full 0..1 range, so a smaller
            // scale than the procedural heightfield needed. ~0.03 reads as
            // deep mortar joints without grazing-angle smearing.
            mat.pomIntensity = pomIntensity;
            mat.pomQuality = 'high';
            mat.pomClipMode = 'solid';
            mat.pomDepthWrite = true;
            mat.userData.ownedMaps = [albedo, normal, height, roughness, ao];
            mat.userData.silPom = true;
            // IQ untiling: heavily-tiled photo brick/cobble opt in so the
            // visible repeat grid is broken up (works POM on AND off). The
            // standalone PROCEDURAL brick set opts OUT (untile=false): it tiles
            // cleanly by construction, and the untiler's per-cell UV offset is
            // applied to color/normal/rough/AO but NOT to the raw-sampled POM
            // height — desyncing relief from color (sharp procedural edges make
            // the fractional-brick offset glaring; photo brick masks it).
            mat.untileMaps = untile;
            // Opt into world-scale UVs: addBox() derives texture.repeat from the
            // box dimensions so a brick is the same physical size on every
            // surface regardless of wall/floor extent. tileM overrides the
            // default BRICK_TILE_M per-material (cobble floor needs bigger
            // tiles than wall brick or it reads as noisy fish-scales).
            mat.userData.brickWorldScale = true;
            if (tileM) mat.userData.brickTileM = tileM;
            return mat;
        };

        // Meters of surface covered by one full brick-texture tile. Single knob
        // → constant brick size across the whole level. Larger ⇒ bigger, fewer
        // bricks. PolyHaven brick_wall_006 is ~6 courses/tile; 2.6 m ≈ 12 cm
        // courses (chunkier, requested).
        const BRICK_TILE_M = 2.6;

        const applyBrickWorldScale = (material, size) => {
            if (!material?.userData?.brickWorldScale) return;
            const [sx, sy, sz] = size;
            // BoxGeometry shares one UV set across all faces, so pick the two
            // dominant extents. Floor-like (thin in Y) tiles over X×Z; wall-like
            // tiles over its longest horizontal span × height.
            const isFloor = sy <= sx * 0.5 && sy <= sz * 0.5;
            const tileM = material.userData.brickTileM || BRICK_TILE_M;
            // Round to a WHOLE number of tiles per face. Fractional repeats cut
            // a tile mid-pattern at the box edge → visible seam where surfaces
            // meet; an integer count makes the RepeatWrapping wrap land exactly
            // on the edge, so adjacent faces line up seamlessly.
            const repU = Math.max(Math.round(Math.max(sx, sz) / tileM), 1);
            const repV = Math.max(
                Math.round((isFloor ? Math.min(sx, sz) : sy) / tileM), 1,
            );
            for (const t of material.userData.ownedMaps || []) {
                t.wrapS = t.wrapT = THREE.RepeatWrapping;
                t.repeat.set(repU, repV);
                t.needsUpdate = true;
            }
        };

        const addBox = (name, size, position, material, { rotationY = 0 } = {}) => {
            const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
            applyBrickWorldScale(material, size);
            // aoMap (POM-off path) samples uv2; BoxGeometry only ships uv, so
            // mirror it. POM-on path uses pomAOMap at the parallax UV instead.
            if (geometry.attributes.uv && !geometry.attributes.uv2) {
                geometry.setAttribute('uv2', geometry.attributes.uv);
            }
            // Real per-vertex tangents so silhouette POM uses a stable TBN
            // instead of the screen-derivative fallback.
            geometry.computeTangents();
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = name;
            mesh.position.set(position[0], position[1], position[2]);
            mesh.rotation.y = rotationY;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            root.add(mesh);
            return mesh;
        };

        // Floor
        addBox(
            'brick-floor',
            [ROOM_W, WALL_THICKNESS, ROOM_D],
            [0, -WALL_THICKNESS * 0.5, 0],
            // Cobblestone: bigger tile (4 m vs 1.6 m brick) so stones read at
            // human scale instead of a dense fish-scale shimmer; softer normal
            // and shallower parallax so grazing angles don't smear the relief.
            makeBrickMaterial(floorSet, {
                repeatU: 4, repeatV: 4,
                // Smaller tile ⇒ more cobble repeats across the floor (denser,
                // requested). Rounded to whole tiles by applyBrickWorldScale so
                // the X and Z edges stay seamless.
                tileM: BRICK_TILE_M, normalScale: 0.45, pomIntensity: 0.0, untile: false,
            }),
        );

        // Ceiling — keep DDGI surface; no parallax (it's overhead, not great
        // viewing angle for POM and saves shader cost).
        const ceilingMat = new DDGIMeshStandardNodeMaterial({
            color: new THREE.Color('#d4cec8'),
            roughness: 0.95,
            metalness: 0.02,
        });
        addBox(
            'brick-ceiling',
            [ROOM_W, WALL_THICKNESS, ROOM_D],
            [0, ROOM_H + WALL_THICKNESS * 0.5, 0],
            ceilingMat,
        );

        // Four perimeter walls
        const wallMaterial = () => makeBrickMaterial(wallSet, {
            repeatU: 4, repeatV: 1.5,
            normalScale: 0.9,
            pomIntensity: 0.012,
            untile: false,
        });
        addBox('brick-wall-north', [ROOM_W, ROOM_H, WALL_THICKNESS], [0, ROOM_H * 0.5, -ROOM_D * 0.5], wallMaterial());
        addBox('brick-wall-south', [ROOM_W, ROOM_H, WALL_THICKNESS], [0, ROOM_H * 0.5,  ROOM_D * 0.5], wallMaterial());
        addBox('brick-wall-east',  [WALL_THICKNESS, ROOM_H, ROOM_D], [ ROOM_W * 0.5, ROOM_H * 0.5, 0], wallMaterial());
        addBox('brick-wall-west',  [WALL_THICKNESS, ROOM_H, ROOM_D], [-ROOM_W * 0.5, ROOM_H * 0.5, 0], wallMaterial());

        // Two free-standing partitions with accent bricks — POM shows clearest
        // when you can walk past an edge at a grazing angle.
        // accentSet is the standalone PROCEDURAL brick set → untile:false so the
        // POM relief stays locked to the brick color (see mat.untileMaps note).
        const accentMaterial = () => makeBrickMaterial(accentSet, { repeatU: 2, repeatV: 1, untile: false });
        addBox('brick-pillar-a', [WALL_THICKNESS * 1.8, ROOM_H * 0.95, 2.8], [-2.5, ROOM_H * 0.475, -2], accentMaterial());
        addBox('brick-pillar-b', [WALL_THICKNESS * 1.8, ROOM_H * 0.95, 2.8], [ 2.5, ROOM_H * 0.475,  2], accentMaterial(), { rotationY: Math.PI * 0.1 });

        // Single warm point light to graze the brick. Positioned slightly off
        // center so the parallax bumps cast asymmetric highlights.
        const light = new THREE.PointLight(0xffd2a0, 8, 28, 1.4);
        light.position.set(2.5, ROOM_H - 1.2, 0);
        light.castShadow = true;
        configurePointLightShadow(light);
        light.name = 'brick-room-key-light';
        root.add(light);

        applySilPomLighting(root, light.position.clone());

        return root;
    }

    const DOOM_ENEMY_SPRITE_FRAME_W = 32;
    const DOOM_ENEMY_SPRITE_FRAME_H = 40;
    const DOOM_ENEMY_SPRITE_COLS = 3;
    const DOOM_ENEMY_SPRITE_ROWS = 2;
    const DOOM_ENEMY_IDLE_FRAME = 1;
    const DOOM_ENEMY_WALK_FRAMES = [0, 1, 2, 5, 4, 3];
    const DOOM_ENEMY_WALK_FPS = 9;

    function setDoomEnemySpriteFrame(sprite, frameIndex = DOOM_ENEMY_IDLE_FRAME) {
        const texture = sprite?.material?.map;
        if (!texture) return;
        const clampedFrame = Math.max(0, Math.min(DOOM_ENEMY_SPRITE_COLS * DOOM_ENEMY_SPRITE_ROWS - 1, frameIndex | 0));
        const col = clampedFrame % DOOM_ENEMY_SPRITE_COLS;
        const row = Math.floor(clampedFrame / DOOM_ENEMY_SPRITE_COLS);
        texture.repeat.set(1 / DOOM_ENEMY_SPRITE_COLS, 1 / DOOM_ENEMY_SPRITE_ROWS);
        texture.offset.set(col / DOOM_ENEMY_SPRITE_COLS, 1 - ((row + 1) / DOOM_ENEMY_SPRITE_ROWS));
        texture.needsUpdate = true;
        sprite.userData.frameIndex = clampedFrame;
    }

    function drawDoomEnemySpriteFrame(ctx, ox, oy, pose = {}) {
        const rect = (x, y, w, h, color) => {
            ctx.fillStyle = color;
            ctx.fillRect(ox + x, oy + y, w, h);
        };
        const px = (x, y, color) => rect(x, y, 1, 1, color);

        const lean = pose.lean || 0;
        const headShift = pose.headShift || 0;
        const gunShift = pose.gunShift || 0;
        const gunLift = pose.gunLift || 0;
        const leftArmShift = pose.leftArmShift || 0;
        const rightArmShift = pose.rightArmShift || 0;
        const leftLegLift = pose.leftLegLift || 0;
        const rightLegLift = pose.rightLegLift || 0;

        const FACE = '#0b0b0b';
        const FACE_D = '#000000';
        const FACE_L = '#2a2a2a';
        const SKIN = '#d5a07a';
        const SKIN_D = '#8e5b43';
        const SKIN_L = '#efc6aa';
        const ARMOR = '#27242c';
        const ARMOR_D = '#131118';
        const ARMOR_L = '#4a4650';
        const RED = '#8a1e1c';
        const RED_L = '#bb4036';
        const RED_D = '#4c0d0f';
        const PANTS = '#5f624c';
        const PANTS_D = '#3e4034';
        const GUN = '#6f737a';
        const GUN_L = '#a2a7af';
        const GUN_D = '#34383d';
        const BLACK = '#090909';

        // Head
        rect(11 + lean + headShift, 3, 9, 8, FACE);
        rect(11 + lean + headShift, 3, 9, 2, FACE_L);
        rect(11 + lean + headShift, 10, 9, 1, FACE_D);
        rect(13 + lean + headShift, 0, 5, 3, FACE_L);
        px(14 + lean + headShift, 5, BLACK);
        px(17 + lean + headShift, 5, BLACK);
        rect(14 + lean + headShift, 7, 3, 1, FACE_D);

        // Torso and shoulders
        rect(9 + lean, 11, 14, 13, ARMOR);
        rect(9 + lean, 11, 14, 2, ARMOR_L);
        rect(9 + lean, 22, 14, 2, ARMOR_D);
        rect(8 + lean, 12, 4, 4, RED);
        rect(20 + lean, 12, 4, 4, RED);
        rect(12 + lean, 15, 8, 5, ARMOR_L);
        rect(13 + lean, 16, 6, 3, '#1b191f');

        // Arms and gloves
        rect(5 + lean, 14 + leftArmShift, 4, 9, ARMOR);
        rect(23 + lean, 14 + rightArmShift, 4, 9, ARMOR);
        rect(5 + lean, 21 + leftArmShift, 4, 3, RED);
        rect(23 + lean, 21 + rightArmShift, 4, 3, RED);
        rect(6 + lean, 23 + leftArmShift, 3, 2, SKIN);
        rect(23 + lean, 23 + rightArmShift, 3, 2, SKIN);

        // Shotgun
        rect(8 + lean + gunShift, 19 + gunLift, 5, 2, '#65442a');
        rect(12 + lean + gunShift, 18 + gunLift, 8, 3, GUN_D);
        rect(19 + lean + gunShift, 17 + gunLift, 8, 3, GUN);
        rect(26 + lean + gunShift, 16 + gunLift, 3, 2, GUN_L);
        px(27 + lean + gunShift, 18 + gunLift, BLACK);

        // Waist and legs
        rect(10 + lean, 24, 12, 3, RED_D);
        rect(10 + lean, 25 - leftLegLift, 4, 9 + leftLegLift, PANTS);
        rect(18 + lean, 25 - rightLegLift, 4, 9 + rightLegLift, PANTS);
        rect(10 + lean, 25 - leftLegLift, 4, 2, PANTS_D);
        rect(18 + lean, 25 - rightLegLift, 4, 2, PANTS_D);
        rect(10 + lean, 30 - leftLegLift, 4, 2, RED);
        rect(18 + lean, 30 - rightLegLift, 4, 2, RED);
        rect(9 + lean, 34, 6, 4, RED_D);
        rect(17 + lean, 34, 6, 4, RED_D);
        rect(9 + lean, 34, 6, 1, RED_L);
        rect(17 + lean, 34, 6, 1, RED_L);
    }

    function makeDoomEnemySpriteSheet() {
        const canvas = document.createElement('canvas');
        canvas.width = DOOM_ENEMY_SPRITE_FRAME_W * DOOM_ENEMY_SPRITE_COLS;
        canvas.height = DOOM_ENEMY_SPRITE_FRAME_H * DOOM_ENEMY_SPRITE_ROWS;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const poses = [
            { lean: -1, headShift: -1, gunShift: -1, gunLift: -1, leftArmShift: -1, rightArmShift: 1, leftLegLift: 2, rightLegLift: 0 },
            { lean: -1, headShift: 0, gunShift: 0, gunLift: 0, leftArmShift: 0, rightArmShift: 0, leftLegLift: 1, rightLegLift: 1 },
            { lean: 0, headShift: 1, gunShift: 1, gunLift: 0, leftArmShift: 1, rightArmShift: -1, leftLegLift: 0, rightLegLift: 2 },
            { lean: 1, headShift: 1, gunShift: 1, gunLift: 1, leftArmShift: 1, rightArmShift: 0, leftLegLift: 0, rightLegLift: 2 },
            { lean: 1, headShift: 0, gunShift: 0, gunLift: 0, leftArmShift: 0, rightArmShift: 0, leftLegLift: 1, rightLegLift: 1 },
            { lean: 0, headShift: -1, gunShift: -1, gunLift: -1, leftArmShift: -1, rightArmShift: 1, leftLegLift: 2, rightLegLift: 0 },
        ];
        poses.forEach((pose, index) => {
            const ox = (index % DOOM_ENEMY_SPRITE_COLS) * DOOM_ENEMY_SPRITE_FRAME_W;
            const oy = Math.floor(index / DOOM_ENEMY_SPRITE_COLS) * DOOM_ENEMY_SPRITE_FRAME_H;
            drawDoomEnemySpriteFrame(ctx, ox, oy, pose);
        });

        const texture = new THREE.CanvasTexture(canvas);
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        return {
            texture,
            idleFrame: DOOM_ENEMY_IDLE_FRAME,
            walkFrames: DOOM_ENEMY_WALK_FRAMES.slice(),
            fps: DOOM_ENEMY_WALK_FPS,
        };
    }

    function updateDoomEnemySpriteAnimation(actor, delta = 0, moving = false) {
        const state = actor?.userData?.doomEnemy;
        const sprite = state?.sprite;
        if (!state || !sprite) return;

        if (!moving) {
            state.elapsed = 0;
            if (state.frameIndex !== state.idleFrame) {
                state.frameIndex = state.idleFrame;
                setDoomEnemySpriteFrame(sprite, state.idleFrame);
            }
            return;
        }

        state.elapsed = (state.elapsed || 0) + Math.max(0, delta);
        const walkFrames = Array.isArray(state.walkFrames) && state.walkFrames.length
            ? state.walkFrames
            : DOOM_ENEMY_WALK_FRAMES;
        const frameIndex = walkFrames[Math.floor(state.elapsed * (state.fps || DOOM_ENEMY_WALK_FPS)) % walkFrames.length];
        if (state.frameIndex !== frameIndex) {
            state.frameIndex = frameIndex;
            setDoomEnemySpriteFrame(sprite, frameIndex);
        }
    }

    function applyDoomEnemySpriteSkin(actor) {
        const mesh = getActorRenderObject(actor);
        if (!mesh) return actor;

        const staleSprites = [];
        mesh.traverse((child) => {
            if (child === mesh) return;
            if (child.name === 'doom-enemy-sprite' || child.name === 'doom-imp-sprite') {
                staleSprites.push(child);
            }
            if (child.name === 'Shooter Barrel'
                || child.isMesh && child.geometry?.type === 'CapsuleGeometry') {
                child.visible = false;
            }
        });

        for (const sprite of staleSprites) {
            sprite.parent?.remove(sprite);
            for (const tex of sprite.userData?.ownedTextures || []) tex?.dispose?.();
            sprite.material?.dispose?.();
        }

        if (mesh.isMesh && mesh.material) {
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const m of mats) {
                if (!m) continue;
                m.transparent = true;
                m.opacity = 0.0;
                m.depthWrite = false;
                m.needsUpdate = true;
            }
        }

        const spriteSheet = makeDoomEnemySpriteSheet();
        const impMat = new THREE.SpriteMaterial({
            map: spriteSheet.texture,
            transparent: true,
            alphaTest: 0.5,
            depthWrite: true,
            sizeAttenuation: true,
        });
        impMat.toneMapped = false;
        const impSprite = new THREE.Sprite(impMat);
        impSprite.name = 'doom-enemy-sprite';
        impSprite.scale.set(3.2, 4.0, 1);
        impSprite.position.set(0, -0.2, 0);
        impSprite.userData.ownedTextures = [spriteSheet.texture];
        impSprite.raycast = () => {};
        mesh.add(impSprite);
        setDoomEnemySpriteFrame(impSprite, spriteSheet.idleFrame);

        actor.userData.label = actor.userData.label || 'Doom Enemy';
        actor.userData.doomEnemy = {
            sprite: impSprite,
            frameIndex: spriteSheet.idleFrame,
            idleFrame: spriteSheet.idleFrame,
            walkFrames: spriteSheet.walkFrames,
            fps: spriteSheet.fps,
            elapsed: 0,
        };
        return actor;
    }

    function makeDoomShotgunSpriteTexture() {
        // 48x24 pixel-art shotgun (super-shotgun silhouette): wood stock, double
        // barrel, metallic receiver, brass shell sticking out.
        const W = 48, H = 24;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);

        const rect = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
        const px = (x, y, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, 1, 1); };

        const WOOD = '#6a3a1a';
        const WOOD_D = '#3a1f0a';
        const WOOD_L = '#9a5828';
        const STEEL = '#7a7a82';
        const STEEL_D = '#3a3a42';
        const STEEL_L = '#b8b8c0';
        const BLACK = '#0a0a0a';
        const BRASS = '#d8a838';
        const BRASS_L = '#ffd86a';
        const BRASS_D = '#8a6a18';

        // Stock (wood) — left side
        rect(2, 9, 14, 9, WOOD);
        rect(2, 9, 14, 1, WOOD_L);     // top highlight
        rect(2, 17, 14, 1, WOOD_D);    // bottom shadow
        rect(3, 11, 1, 5, WOOD_L);     // grain
        rect(8, 12, 1, 4, WOOD_D);
        // Butt curve
        px(1, 10, WOOD_D); px(1, 16, WOOD_D);
        px(2, 9, WOOD_D); px(2, 17, WOOD_D);

        // Receiver (metallic block) middle
        rect(15, 8, 9, 10, STEEL);
        rect(15, 8, 9, 1, STEEL_L);
        rect(15, 17, 9, 1, STEEL_D);
        // Trigger guard
        rect(17, 18, 4, 3, BLACK);
        rect(18, 19, 2, 2, STEEL_D);
        // Trigger
        px(19, 18, BLACK);
        // Shell ejector / port
        rect(20, 10, 3, 2, BLACK);

        // Pump action handle under barrel
        rect(22, 13, 7, 3, WOOD);
        rect(22, 13, 7, 1, WOOD_L);
        rect(22, 15, 7, 1, WOOD_D);

        // Double barrels (over/under)
        rect(23, 9, 23, 2, STEEL);
        rect(23, 11, 23, 2, STEEL_D);
        rect(23, 9, 23, 1, STEEL_L);
        // Muzzle
        rect(45, 9, 1, 4, BLACK);
        px(44, 9, STEEL_L); px(44, 12, STEEL_D);

        // Brass shell on top of receiver
        rect(16, 5, 3, 3, BRASS);
        rect(16, 5, 3, 1, BRASS_L);
        rect(15, 6, 1, 2, BRASS);
        rect(19, 6, 1, 2, BRASS_D);

        const tex = new THREE.CanvasTexture(canvas);
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        return tex;
    }

    function createDoomTestLevel() {
        // Compact Doom-style mini level: start room, combat arena, and a clear end room.
        const root = new THREE.Group();
        root.name = 'PolyFlow_Doom_Test';
        root.userData.sampleType = 'doomTest';
        root.userData.hideTerrainPresentation = true;
        root.userData.skipNormalization = true;

        const T = 0.4;                // wall thickness
        const CORR_W = 5;
        const CORR_H = 3.4;
        const CORR_LEN = 16;
        const ROOM_W = 28;
        const ROOM_D = 28;
        const ROOM_H = 5.6;
        const START_W = 14;
        const START_D = 14;
        const START_H = 4.4;
        const END_W = 14;
        const END_D = 14;
        const END_H = 4.4;
        const START_CENTER_Z = ROOM_D * 0.5 + CORR_LEN + START_D * 0.5;
        const END_CENTER_Z = -(ROOM_D * 0.5 + CORR_LEN + END_D * 0.5);
        const DOOM_WALL_COLOR = '#2b1514';
        const DOOM_RED_LIGHT = 0xff3030;
        const DOOM_RED_EMISSIVE = '#ff3030';

        root.userData.preferredSpawn = {
            position: [0, 0.3, START_CENTER_Z + START_D * 0.5 - 3.0],
            yaw: Math.PI,
            pitch: -0.05,
        };
        root.userData.preferredShowcase = {
            position: [0, PLAYER_SETTINGS.eyeHeight + 0.35, START_CENTER_Z + START_D * 0.5 - 4.5],
            target: [0, 1.4, 0],
        };

        const wallSet = getProceduralBrickSet('accent');
        const floorSet = getProceduralBrickSet('white');
        const accentSet = getProceduralBrickSet('accent');

        const brickMat = (set, { repeatU = 2, repeatV = 2, color = '#ffffff', rough = 0.9, metal = 0.05 } = {}) => {
            const albedo = set.albedo.clone();
            const normal = set.normal.clone();
            const height = set.height.clone();
            const roughness = set.roughness.clone();
            const ao = set.ao.clone();
            registerBrickClone(set.albedo, albedo);
            registerBrickClone(set.normal, normal);
            registerBrickClone(set.height, height);
            registerBrickClone(set.roughness, roughness);
            registerBrickClone(set.ao, ao);
            for (const t of [albedo, normal, height, roughness, ao]) {
                t.wrapS = t.wrapT = THREE.RepeatWrapping;
                t.repeat.set(repeatU, repeatV);
                t.needsUpdate = true;
            }
            const mat = new DDGIMeshStandardNodeMaterial({
                color: new THREE.Color(color),
                roughness: 1.0,
                metalness: metal,
            });
            mat.map = albedo;
            mat.normalMap = normal;
            mat.normalScale = new THREE.Vector2(1.1, 1.1);
            mat.roughnessMap = roughness;
            mat.heightMap = height;
            mat.pomAOMap = ao;
            mat.aoMap = ao;
            mat.aoMapIntensity = 1.0;
            mat.pomEnabled = true;
            mat.pomIntensity = 0.035;
            mat.pomQuality = 'high';
            mat.pomClipMode = 'solid';
            mat.pomDepthWrite = true;
            mat.untileMaps = false;
            mat.rebuildPomGraph?.();
            mat.userData.ownedMaps = [albedo, normal, height, roughness, ao];
            mat.userData.silPom = true;
            mat.userData.brickWorldScale = true;
            return mat;
        };

        const BRICK_TILE_M = 1.6;

        const applyBrickWorldScale = (material, size) => {
            if (!material?.userData?.brickWorldScale) return;
            const [sx, sy, sz] = size;
            const isFloor = sy <= sx * 0.5 && sy <= sz * 0.5;
            const tileM = material.userData.brickTileM || BRICK_TILE_M;
            const repU = Math.max(Math.round(Math.max(sx, sz) / tileM), 1);
            const repV = Math.max(
                Math.round((isFloor ? Math.min(sx, sz) : sy) / tileM), 1,
            );
            for (const t of material.userData.ownedMaps || []) {
                t.wrapS = t.wrapT = THREE.RepeatWrapping;
                t.repeat.set(repU, repV);
                t.needsUpdate = true;
            }
        };

        const flatMat = (color, { rough = 0.85, metal = 0.0, emissive = null, emissiveIntensity = 0 } = {}) => {
            const mat = new DDGIMeshStandardNodeMaterial({
                color: new THREE.Color(color),
                roughness: rough,
                metalness: metal,
            });
            if (emissive) {
                mat.emissive = new THREE.Color(emissive);
                mat.emissiveIntensity = emissiveIntensity;
            }
            return mat;
        };

        const addBox = (name, size, position, material, {
            rotationY = 0, cast = true, receive = true, actorSurface = '',
        } = {}) => {
            const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
            applyBrickWorldScale(material, size);
            if (geometry.attributes.uv && !geometry.attributes.uv2) {
                geometry.setAttribute('uv2', geometry.attributes.uv);
            }
            geometry.computeTangents();
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = name;
            mesh.position.set(position[0], position[1], position[2]);
            mesh.rotation.y = rotationY;
            mesh.castShadow = cast;
            mesh.receiveShadow = receive;
            if (actorSurface) mesh.userData.doomMapSurface = actorSurface;
            root.add(mesh);
            if (actorSurface) {
                const actor = makeSampleLevelMeshActor(name, mesh, {
                    kind: 'imported',
                    castShadow: cast,
                    receiveShadow: receive,
                    skipPhysicsCollision: true,
                    userData: {
                        doomMapSurface: actorSurface,
                    },
                });
                if (actorSurface === 'floor' || actorSurface === 'roof') {
                    enableStaticMeshActorCollision(actor);
                }
            }
            return mesh;
        };

        const roomCenterZ = 0;
        const southHallCenterZ = ROOM_D * 0.5 + CORR_LEN * 0.5;
        const northHallCenterZ = -(ROOM_D * 0.5 + CORR_LEN * 0.5);
        const startCenterZ = START_CENTER_Z;
        const endCenterZ = END_CENTER_Z;
        const portalGap = CORR_W;
        const southSegW = (ROOM_W - portalGap) * 0.5;
        const northSegW = (ROOM_W - portalGap) * 0.5;
        const startSegW = (START_W - portalGap) * 0.5;
        const endSegW = (END_W - portalGap) * 0.5;

        const addHallSconce = (name, x, y, z) => {
            addBox(name, [0.2, 0.6, 0.4], [x, y, z],
                flatMat('#2a0f0f', { emissive: DOOM_RED_EMISSIVE, emissiveIntensity: 1.6 }));
        };

        addBox('doom-start-floor', [START_W, T, START_D],
            [0, -T * 0.5, startCenterZ],
            brickMat(floorSet, { repeatU: 4, repeatV: 4, color: '#5a5048' }),
            { actorSurface: 'floor' });
        addBox('doom-start-ceiling', [START_W, T, START_D],
            [0, START_H + T * 0.5, startCenterZ],
            flatMat('#1a1816', { rough: 0.95 }),
            { actorSurface: 'roof' });
        addBox('doom-start-wall-south', [START_W, START_H, T],
            [0, START_H * 0.5, startCenterZ + START_D * 0.5],
            brickMat(wallSet, { repeatU: 4, repeatV: 1.4, color: DOOM_WALL_COLOR }));
        addBox('doom-start-wall-north-l', [startSegW, START_H, T],
            [-(portalGap * 0.5 + startSegW * 0.5), START_H * 0.5, startCenterZ - START_D * 0.5],
            brickMat(wallSet, { repeatU: 2, repeatV: 1.4, color: DOOM_WALL_COLOR }));
        addBox('doom-start-wall-north-r', [startSegW, START_H, T],
            [(portalGap * 0.5 + startSegW * 0.5), START_H * 0.5, startCenterZ - START_D * 0.5],
            brickMat(wallSet, { repeatU: 2, repeatV: 1.4, color: DOOM_WALL_COLOR }));
        addBox('doom-start-wall-east', [T, START_H, START_D],
            [START_W * 0.5, START_H * 0.5, startCenterZ],
            brickMat(wallSet, { repeatU: 4, repeatV: 1.4, color: DOOM_WALL_COLOR }));
        addBox('doom-start-wall-west', [T, START_H, START_D],
            [-START_W * 0.5, START_H * 0.5, startCenterZ],
            brickMat(wallSet, { repeatU: 4, repeatV: 1.4, color: DOOM_WALL_COLOR }));
        addBox('doom-start-pad', [3.2, 0.24, 3.2],
            [0, 0.12, startCenterZ + 2.6],
            flatMat('#241414', { rough: 0.35, emissive: '#6b1818', emissiveIntensity: 0.35 }));

        addBox('doom-south-hall-floor', [CORR_W, T, CORR_LEN],
            [0, -T * 0.5, southHallCenterZ],
            brickMat(floorSet, { repeatU: 2, repeatV: 4, color: '#5a5048' }),
            { actorSurface: 'floor' });
        addBox('doom-south-hall-ceiling', [CORR_W, T, CORR_LEN],
            [0, CORR_H + T * 0.5, southHallCenterZ],
            flatMat('#1a1816', { rough: 0.95 }),
            { actorSurface: 'roof' });
        addBox('doom-south-hall-wall-e', [T, CORR_H, CORR_LEN],
            [CORR_W * 0.5, CORR_H * 0.5, southHallCenterZ],
            brickMat(wallSet, { repeatU: 3, repeatV: 1, color: DOOM_WALL_COLOR }));
        addBox('doom-south-hall-wall-w', [T, CORR_H, CORR_LEN],
            [-CORR_W * 0.5, CORR_H * 0.5, southHallCenterZ],
            brickMat(wallSet, { repeatU: 3, repeatV: 1, color: DOOM_WALL_COLOR }));
        addHallSconce('doom-south-hall-light-l', -CORR_W * 0.5 + 0.15, CORR_H - 1.0, southHallCenterZ - CORR_LEN * 0.25);
        addHallSconce('doom-south-hall-light-r', CORR_W * 0.5 - 0.15, CORR_H - 1.0, southHallCenterZ + CORR_LEN * 0.25);

        addBox('doom-room-floor', [ROOM_W, T, ROOM_D],
            [0, -T * 0.5, roomCenterZ],
            brickMat(floorSet, { repeatU: 7, repeatV: 7, color: '#6c6258' }),
            { actorSurface: 'floor' });
        addBox('doom-room-ceiling', [ROOM_W, T, ROOM_D],
            [0, ROOM_H + T * 0.5, roomCenterZ],
            flatMat('#2a2724', { rough: 0.95 }),
            { actorSurface: 'roof' });
        addBox('doom-wall-south-l', [southSegW, ROOM_H, T],
            [-(portalGap * 0.5 + southSegW * 0.5), ROOM_H * 0.5, ROOM_D * 0.5],
            brickMat(wallSet, { repeatU: 4, repeatV: 1.5, color: DOOM_WALL_COLOR }));
        addBox('doom-wall-south-r', [southSegW, ROOM_H, T],
            [(portalGap * 0.5 + southSegW * 0.5), ROOM_H * 0.5, ROOM_D * 0.5],
            brickMat(wallSet, { repeatU: 4, repeatV: 1.5, color: DOOM_WALL_COLOR }));
        addBox('doom-wall-north-l', [northSegW, ROOM_H, T],
            [-(portalGap * 0.5 + northSegW * 0.5), ROOM_H * 0.5, -ROOM_D * 0.5],
            brickMat(wallSet, { repeatU: 4, repeatV: 1.5, color: DOOM_WALL_COLOR }));
        addBox('doom-wall-north-r', [northSegW, ROOM_H, T],
            [(portalGap * 0.5 + northSegW * 0.5), ROOM_H * 0.5, -ROOM_D * 0.5],
            brickMat(wallSet, { repeatU: 4, repeatV: 1.5, color: DOOM_WALL_COLOR }));
        addBox('doom-wall-east', [T, ROOM_H, ROOM_D],
            [ROOM_W * 0.5, ROOM_H * 0.5, roomCenterZ],
            brickMat(wallSet, { repeatU: 6, repeatV: 1.5, color: DOOM_WALL_COLOR }));
        addBox('doom-wall-west', [T, ROOM_H, ROOM_D],
            [-ROOM_W * 0.5, ROOM_H * 0.5, roomCenterZ],
            brickMat(wallSet, { repeatU: 6, repeatV: 1.5, color: DOOM_WALL_COLOR }));
        addBox('doom-cover-a', [2.2, 1.6, 1.2], [-5.5, 0.8, 2.5],
            brickMat(accentSet, { repeatU: 1, repeatV: 1, color: '#8a7050' }));
        addBox('doom-cover-b', [2.2, 1.6, 1.2], [5.5, 0.8, -1.5],
            brickMat(accentSet, { repeatU: 1, repeatV: 1, color: '#8a7050' }));
        addBox('doom-cover-c', [1.2, 3.0, 1.2], [0, 1.5, 6.5],
            brickMat(wallSet, { repeatU: 1, repeatV: 2, color: DOOM_WALL_COLOR }));
        addBox('doom-cover-d', [1.2, 3.0, 1.2], [0, 1.5, -6.5],
            brickMat(wallSet, { repeatU: 1, repeatV: 2, color: DOOM_WALL_COLOR }));

        addBox('doom-north-hall-floor', [CORR_W, T, CORR_LEN],
            [0, -T * 0.5, northHallCenterZ],
            brickMat(floorSet, { repeatU: 2, repeatV: 4, color: '#5a5048' }),
            { actorSurface: 'floor' });
        addBox('doom-north-hall-ceiling', [CORR_W, T, CORR_LEN],
            [0, CORR_H + T * 0.5, northHallCenterZ],
            flatMat('#1a1816', { rough: 0.95 }),
            { actorSurface: 'roof' });
        addBox('doom-north-hall-wall-e', [T, CORR_H, CORR_LEN],
            [CORR_W * 0.5, CORR_H * 0.5, northHallCenterZ],
            brickMat(wallSet, { repeatU: 3, repeatV: 1, color: DOOM_WALL_COLOR }));
        addBox('doom-north-hall-wall-w', [T, CORR_H, CORR_LEN],
            [-CORR_W * 0.5, CORR_H * 0.5, northHallCenterZ],
            brickMat(wallSet, { repeatU: 3, repeatV: 1, color: DOOM_WALL_COLOR }));
        addHallSconce('doom-north-hall-light-l', -CORR_W * 0.5 + 0.15, CORR_H - 1.0, northHallCenterZ - CORR_LEN * 0.25);
        addHallSconce('doom-north-hall-light-r', CORR_W * 0.5 - 0.15, CORR_H - 1.0, northHallCenterZ + CORR_LEN * 0.25);

        addBox('doom-end-floor', [END_W, T, END_D],
            [0, -T * 0.5, endCenterZ],
            brickMat(floorSet, { repeatU: 4, repeatV: 4, color: '#5a5048' }),
            { actorSurface: 'floor' });
        addBox('doom-end-ceiling', [END_W, T, END_D],
            [0, END_H + T * 0.5, endCenterZ],
            flatMat('#1a1816', { rough: 0.95 }),
            { actorSurface: 'roof' });
        addBox('doom-end-wall-north', [END_W, END_H, T],
            [0, END_H * 0.5, endCenterZ - END_D * 0.5],
            brickMat(wallSet, { repeatU: 4, repeatV: 1.4, color: DOOM_WALL_COLOR }));
        addBox('doom-end-wall-south-l', [endSegW, END_H, T],
            [-(portalGap * 0.5 + endSegW * 0.5), END_H * 0.5, endCenterZ + END_D * 0.5],
            brickMat(wallSet, { repeatU: 2, repeatV: 1.4, color: DOOM_WALL_COLOR }));
        addBox('doom-end-wall-south-r', [endSegW, END_H, T],
            [(portalGap * 0.5 + endSegW * 0.5), END_H * 0.5, endCenterZ + END_D * 0.5],
            brickMat(wallSet, { repeatU: 2, repeatV: 1.4, color: DOOM_WALL_COLOR }));
        addBox('doom-end-wall-east', [T, END_H, END_D],
            [END_W * 0.5, END_H * 0.5, endCenterZ],
            brickMat(wallSet, { repeatU: 4, repeatV: 1.4, color: DOOM_WALL_COLOR }));
        addBox('doom-end-wall-west', [T, END_H, END_D],
            [-END_W * 0.5, END_H * 0.5, endCenterZ],
            brickMat(wallSet, { repeatU: 4, repeatV: 1.4, color: DOOM_WALL_COLOR }));
        addBox('doom-end-dais', [4.2, 0.4, 4.2],
            [0, 0.2, endCenterZ - 1.8],
            flatMat('#221212', { rough: 0.3, emissive: DOOM_RED_EMISSIVE, emissiveIntensity: 0.45 }));

        root.userData.doomMiniLevel = {
            playerSpawn: [0, 0.85, startCenterZ + START_D * 0.5 - 3.2],
            shotgunPickup: [0, 0.75, startCenterZ - 1.6],
            exitTeleporter: [0, 0.42, endCenterZ - 1.8],
            exitTeleporterHidden: [0, -48, endCenterZ - 1.8],
            hallTriggerZ: startCenterZ - START_D * 0.5 + 1.0,
            arenaTriggerZ: ROOM_D * 0.5 - 1.5,
            hallWave: [
                [-1.25, 0, southHallCenterZ + 2.6],
                [1.25, 0, southHallCenterZ - 2.2],
            ],
            arenaWave: [
                [-6.0, 0, 4.0],
                [6.0, 0, -4.5],
                [0, 0, -6.0],
            ],
            finalWave: [
                [-1.2, 0, northHallCenterZ - 1.2],
                [1.2, 0, endCenterZ + 1.2],
            ],
            arenaBarrier: [0, 0.8, ROOM_D * 0.5 - 0.6],
        };

        addBox('doom-gun-pedestal', [1.0, 0.3, 1.0],
            [0, 0.15, startCenterZ - 1.6],
            flatMat('#1a1a1a', { rough: 0.4, metal: 0.6, emissive: '#222222', emissiveIntensity: 0.2 }));

        const gunGlow = new THREE.PointLight(DOOM_RED_LIGHT, 1.6, 4.5, 2.0);
        gunGlow.position.set(0, 0.75, startCenterZ - 1.6);
        gunGlow.castShadow = false;
        gunGlow.name = 'doom-gun-glow';
        root.add(gunGlow);

        const startLight = new THREE.PointLight(DOOM_RED_LIGHT, 3.6, 18, 1.8);
        startLight.position.set(0, START_H - 0.8, startCenterZ + 0.5);
        startLight.castShadow = false;
        startLight.name = 'doom-start-light';
        root.add(startLight);

        const keyLight = new THREE.PointLight(DOOM_RED_LIGHT, 9, 28, 1.6);
        keyLight.position.set(-5, ROOM_H - 1.2, -2);
        keyLight.castShadow = true;
        configurePointLightShadow(keyLight);
        keyLight.name = 'doom-room-key';
        root.add(keyLight);

        const fillLight = new THREE.PointLight(DOOM_RED_LIGHT, 4.2, 24, 2.0);
        fillLight.position.set(6, ROOM_H - 0.8, 6);
        fillLight.castShadow = false;
        fillLight.name = 'doom-room-fill';
        root.add(fillLight);

        const southHallLight = new THREE.PointLight(DOOM_RED_LIGHT, 3.2, 16, 1.8);
        southHallLight.position.set(0, CORR_H - 0.7, southHallCenterZ);
        southHallLight.castShadow = false;
        southHallLight.name = 'doom-south-hall-light';
        root.add(southHallLight);

        const northHallLight = new THREE.PointLight(DOOM_RED_LIGHT, 3.2, 16, 1.8);
        northHallLight.position.set(0, CORR_H - 0.7, northHallCenterZ);
        northHallLight.castShadow = false;
        northHallLight.name = 'doom-north-hall-light';
        root.add(northHallLight);

        const endLight = new THREE.PointLight(DOOM_RED_LIGHT, 4.8, 18, 1.8);
        endLight.position.set(0, END_H - 0.8, endCenterZ - 1.2);
        endLight.castShadow = true;
        configurePointLightShadow(endLight);
        endLight.name = 'doom-end-light';
        root.add(endLight);

        applySilPomLighting(root, keyLight.position.clone());

        return root;
    }

    // Rogue-like arena: ONE big square brick room (same doom material language as
    // createDoomTestLevel). Player spawns center, grabs the shotgun, then survives
    // escalating waves of enemies that spawn around the perimeter and walk in.
    // Clearing the final wave reveals the exit teleporter.
    function createDoomArenaLevel() {
        const root = new THREE.Group();
        root.name = 'PolyFlow_Doom_Arena';
        root.userData.sampleType = 'doomArena';
        root.userData.hideTerrainPresentation = true;
        root.userData.skipNormalization = true;

        const T = 0.4;            // wall thickness
        const ARENA = 44;         // room is ARENA x ARENA
        const ARENA_H = 7.5;      // ceiling height
        const HALF = ARENA * 0.5;
        const DOOM_WALL_COLOR = '#2b1514';
        const DOOM_RED_LIGHT = 0xff3030;
        const DOOM_RED_EMISSIVE = '#ff3030';

        root.userData.preferredSpawn = {
            position: [0, 0.3, 6.0],
            yaw: Math.PI,
            pitch: -0.05,
        };
        root.userData.preferredShowcase = {
            position: [0, PLAYER_SETTINGS.eyeHeight + 0.6, 9.0],
            target: [0, 1.4, -4.0],
        };

        const wallSet = getProceduralBrickSet('accent');
        const floorSet = getProceduralBrickSet('white');
        const accentSet = getProceduralBrickSet('accent');
        const BRICK_TILE_M = 1.6;

        const brickMat = (set, { color = '#ffffff', metal = 0.05 } = {}) => {
            const albedo = set.albedo.clone();
            const normal = set.normal.clone();
            const height = set.height.clone();
            const roughness = set.roughness.clone();
            const ao = set.ao.clone();
            registerBrickClone(set.albedo, albedo);
            registerBrickClone(set.normal, normal);
            registerBrickClone(set.height, height);
            registerBrickClone(set.roughness, roughness);
            registerBrickClone(set.ao, ao);
            for (const t of [albedo, normal, height, roughness, ao]) {
                t.wrapS = t.wrapT = THREE.RepeatWrapping;
                t.needsUpdate = true;
            }
            const mat = new DDGIMeshStandardNodeMaterial({
                color: new THREE.Color(color),
                roughness: 1.0,
                metalness: metal,
            });
            mat.map = albedo;
            mat.normalMap = normal;
            mat.normalScale = new THREE.Vector2(1.1, 1.1);
            mat.roughnessMap = roughness;
            mat.heightMap = height;
            mat.pomAOMap = ao;
            mat.aoMap = ao;
            mat.aoMapIntensity = 1.0;
            mat.pomEnabled = true;
            mat.pomIntensity = 0.035;
            mat.pomQuality = 'high';
            mat.pomClipMode = 'solid';
            mat.pomDepthWrite = true;
            mat.untileMaps = false;
            mat.rebuildPomGraph?.();
            mat.userData.ownedMaps = [albedo, normal, height, roughness, ao];
            mat.userData.silPom = true;
            mat.userData.brickWorldScale = true;
            return mat;
        };

        const applyBrickWorldScale = (material, size) => {
            if (!material?.userData?.brickWorldScale) return;
            const [sx, sy, sz] = size;
            const isFloor = sy <= sx * 0.5 && sy <= sz * 0.5;
            const tileM = material.userData.brickTileM || BRICK_TILE_M;
            const repU = Math.max(Math.round(Math.max(sx, sz) / tileM), 1);
            const repV = Math.max(Math.round((isFloor ? Math.min(sx, sz) : sy) / tileM), 1);
            for (const t of material.userData.ownedMaps || []) {
                t.wrapS = t.wrapT = THREE.RepeatWrapping;
                t.repeat.set(repU, repV);
                t.needsUpdate = true;
            }
        };

        const flatMat = (color, { rough = 0.85, metal = 0.0, emissive = null, emissiveIntensity = 0 } = {}) => {
            const mat = new DDGIMeshStandardNodeMaterial({
                color: new THREE.Color(color),
                roughness: rough,
                metalness: metal,
            });
            if (emissive) {
                mat.emissive = new THREE.Color(emissive);
                mat.emissiveIntensity = emissiveIntensity;
            }
            return mat;
        };

        const addBox = (name, size, position, material, { actorSurface = '' } = {}) => {
            const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
            applyBrickWorldScale(material, size);
            if (geometry.attributes.uv && !geometry.attributes.uv2) {
                geometry.setAttribute('uv2', geometry.attributes.uv);
            }
            geometry.computeTangents();
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = name;
            mesh.position.set(position[0], position[1], position[2]);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            if (actorSurface) mesh.userData.doomMapSurface = actorSurface;
            root.add(mesh);
            if (actorSurface) {
                const actor = makeSampleLevelMeshActor(name, mesh, {
                    kind: 'imported',
                    castShadow: true,
                    receiveShadow: true,
                    skipPhysicsCollision: true,
                    userData: { doomMapSurface: actorSurface },
                });
                if (actorSurface === 'floor' || actorSurface === 'roof') {
                    enableStaticMeshActorCollision(actor);
                }
            }
            return mesh;
        };

        // Shell: floor, ceiling, four walls.
        addBox('arena-floor', [ARENA, T, ARENA], [0, -T * 0.5, 0],
            brickMat(floorSet, { color: '#6c6258' }), { actorSurface: 'floor' });
        addBox('arena-ceiling', [ARENA, T, ARENA], [0, ARENA_H + T * 0.5, 0],
            flatMat('#241f1c', { rough: 0.95 }), { actorSurface: 'roof' });
        addBox('arena-wall-n', [ARENA, ARENA_H, T], [0, ARENA_H * 0.5, -HALF],
            brickMat(wallSet, { color: DOOM_WALL_COLOR }));
        addBox('arena-wall-s', [ARENA, ARENA_H, T], [0, ARENA_H * 0.5, HALF],
            brickMat(wallSet, { color: DOOM_WALL_COLOR }));
        addBox('arena-wall-e', [T, ARENA_H, ARENA], [HALF, ARENA_H * 0.5, 0],
            brickMat(wallSet, { color: DOOM_WALL_COLOR }));
        addBox('arena-wall-w', [T, ARENA_H, ARENA], [-HALF, ARENA_H * 0.5, 0],
            brickMat(wallSet, { color: DOOM_WALL_COLOR }));

        // Scattered cover pillars so the open room has line-of-sight breaks.
        const pillar = brickMat(accentSet, { color: '#8a7050' });
        const COVER = [
            [-12, -8], [12, -8], [-12, 10], [12, 10],
            [0, -14], [0, 14], [-16, 2], [16, 2],
        ];
        for (let i = 0; i < COVER.length; i++) {
            const [cx, cz] = COVER[i];
            addBox(`arena-cover-${i}`, [1.6, 3.2, 1.6], [cx, 1.6, cz], pillar);
        }

        // Center pad (where the player starts / shotgun sits).
        addBox('arena-pad', [4.0, 0.22, 4.0], [0, 0.11, 4.0],
            flatMat('#241414', { rough: 0.35, emissive: '#6b1818', emissiveIntensity: 0.4 }));
        addBox('arena-gun-pedestal', [1.0, 0.3, 1.0], [0, 0.15, 4.0],
            flatMat('#1a1a1a', { rough: 0.4, metal: 0.6, emissive: '#222222', emissiveIntensity: 0.2 }));
        // Exit dais at the north wall — teleporter hidden until waves cleared.
        addBox('arena-exit-dais', [4.4, 0.4, 4.4], [0, 0.2, -HALF + 3.0],
            flatMat('#221212', { rough: 0.3, emissive: DOOM_RED_EMISSIVE, emissiveIntensity: 0.45 }));

        root.userData.doomArenaLevel = {
            playerSpawn: [0, 0.85, 6.0],
            shotgunPickup: [0, 0.75, 4.0],
            exitTeleporter: [0, 0.42, -HALF + 3.0],
            exitTeleporterHidden: [0, -48, -HALF + 3.0],
            spawnRingRadius: HALF - 3.5,   // enemies appear just inside the walls
            spawnY: 0,
            waveCount: 4,                  // number of escalating waves
            baseWaveSize: 3,               // wave 1 enemy count
            wavePerStep: 2,                // +N enemies each subsequent wave
        };

        const gunGlow = new THREE.PointLight(DOOM_RED_LIGHT, 1.6, 4.5, 2.0);
        gunGlow.position.set(0, 0.75, 4.0);
        gunGlow.castShadow = false;
        gunGlow.name = 'arena-gun-glow';
        root.add(gunGlow);

        const keyLight = new THREE.PointLight(DOOM_RED_LIGHT, 11, 46, 1.6);
        keyLight.position.set(0, ARENA_H - 1.0, 0);
        keyLight.castShadow = true;
        configurePointLightShadow(keyLight);
        keyLight.name = 'arena-key-light';
        root.add(keyLight);

        const cornerOffsets = [[-HALF + 4, -HALF + 4], [HALF - 4, -HALF + 4],
            [-HALF + 4, HALF - 4], [HALF - 4, HALF - 4]];
        for (let i = 0; i < cornerOffsets.length; i++) {
            const [lx, lz] = cornerOffsets[i];
            const cl = new THREE.PointLight(DOOM_RED_LIGHT, 3.4, 22, 2.0);
            cl.position.set(lx, ARENA_H - 1.4, lz);
            cl.castShadow = false;
            cl.name = `arena-corner-light-${i}`;
            root.add(cl);
        }

        applySilPomLighting(root, keyLight.position.clone());
        return root;
    }

    function getBuiltinLevelDefinition(levelId = 'soccerField') {
        if (levelId === 'fpsStarter') {
            return {
                id: 'fpsStarter',
                assetName: 'Sample Level',
                fileSize: 420000,
                create: createFpsStarterLevel,
            };
        }

        if (levelId === 'brickRoom') {
            return {
                id: 'brickRoom',
                assetName: 'Brick Room (POM Demo)',
                fileSize: 120000,
                create: createBrickRoomLevel,
            };
        }

        if (levelId === 'doomTest') {
            return {
                id: 'doomTest',
                assetName: 'Doom Mini Level',
                fileSize: 340000,
                create: createDoomTestLevel,
                afterLoad: () => {
                    const layout = cm()?.userData?.doomMiniLevel || {};

                    const startActor = spawnGameplayPrefab('playerSpawn');
                    if (startActor) {
                        startActor.userData.label = 'Start';
                        const mesh = getActorRenderObject(startActor);
                        if (mesh && Array.isArray(layout.playerSpawn)) {
                            mesh.position.set(layout.playerSpawn[0], layout.playerSpawn[1], layout.playerSpawn[2]);
                            mesh.updateMatrixWorld(true);
                        }
                        applyPlayerSpawnFromActor(startActor);
                    }

                    const gunActor = spawnGameplayPrefab('doomShotgunSprite');
                    if (gunActor) {
                        const mesh = getActorRenderObject(gunActor);
                        if (mesh && Array.isArray(layout.shotgunPickup)) {
                            mesh.position.set(layout.shotgunPickup[0], layout.shotgunPickup[1], layout.shotgunPickup[2]);
                            mesh.updateMatrixWorld(true);
                        }
                    }

                    const endActor = spawnGameplayPrefab('teleporter');
                    if (endActor) {
                        endActor.userData.label = 'Level End';
                        tintGameplayPrefabActor(endActor, '#ef4444', '#ef4444', 2.8);
                        setActorWorldPositionExact(
                            endActor,
                            Array.isArray(layout.exitTeleporterHidden) ? layout.exitTeleporterHidden : layout.exitTeleporter,
                            { visible: false },
                        );
                    }

                    cm().userData.doomMiniLevelState = {
                        exitActor: endActor || null,
                        arenaBarrier: createDoomMiniBarrierEntries(layout.arenaBarrier),
                        hallWaveActors: [],
                        arenaWaveActors: [],
                        finalWaveActors: [],
                        hallTriggered: false,
                        arenaTriggered: false,
                        finalTriggered: false,
                        exitUnlocked: false,
                    };

                    return null;
                },
            };
        }

        if (levelId === 'doomArena') {
            return {
                id: 'doomArena',
                assetName: 'Rogue Waves',
                fileSize: 300000,
                create: createDoomArenaLevel,
                afterLoad: () => {
                    const layout = cm()?.userData?.doomArenaLevel || {};

                    const startActor = spawnGameplayPrefab('playerSpawn');
                    if (startActor) {
                        startActor.userData.label = 'Start';
                        const mesh = getActorRenderObject(startActor);
                        if (mesh && Array.isArray(layout.playerSpawn)) {
                            mesh.position.set(layout.playerSpawn[0], layout.playerSpawn[1], layout.playerSpawn[2]);
                            mesh.updateMatrixWorld(true);
                        }
                        applyPlayerSpawnFromActor(startActor);
                    }

                    // No auto gun pickup in Rogue Waves — the player picks one of
                    // three weapons from a card when they step off the start pad.

                    const endActor = spawnGameplayPrefab('teleporter');
                    if (endActor) {
                        endActor.userData.label = 'Level End';
                        tintGameplayPrefabActor(endActor, '#ef4444', '#ef4444', 2.8);
                        setActorWorldPositionExact(
                            endActor,
                            Array.isArray(layout.exitTeleporterHidden) ? layout.exitTeleporterHidden : layout.exitTeleporter,
                            { visible: false },
                        );
                    }

                    cm().userData.doomArenaState = {
                        exitActor: endActor || null,
                        // Wave flow now lives in the attached game-mode script
                        // (level blueprint). Engine only owns the weapon-pick gate.
                        started: false,           // player stepped off the start pad
                        weaponPromptShown: false, // weapon picker opened once
                    };
                    resetRogueState();

                    // The level blueprint / game mode: an invisible scripted actor
                    // that drives waves, bosses, HUD, and the death check.
                    const gm = spawnGameplayPrefab('rogueGameMode');
                    if (gm) gm.userData.label = 'Rogue Game Mode';
                    cm().userData.rogueGameModeActorId = gm?.id || '';

                    return null;
                },
            };
        }

        if (levelId === 'soccerFieldTerrain') {
            return createFlatTerrainLevelDefinition();
        }

        return createSoccerLevelDefinition();
    }

    return {
        makeSampleLevelPart, makeSampleLevelMeshActor, enableStaticMeshActorCollision,
        createFpsStarterLevel, createSoccerTargetFieldScene, spawnSoccerGoalTarget,
        spawnSoccerGoalie, spawnSoccerPlayerSpawn, spawnSoccerBall,
        createSoccerLevelDefinition, createFlatTerrainLevelDefinition, applySilPomLighting,
        createBrickRoomLevel, setDoomEnemySpriteFrame, drawDoomEnemySpriteFrame,
        makeDoomEnemySpriteSheet, updateDoomEnemySpriteAnimation, applyDoomEnemySpriteSkin,
        makeDoomShotgunSpriteTexture, createDoomTestLevel, createDoomArenaLevel,
        getBuiltinLevelDefinition,
    };
}