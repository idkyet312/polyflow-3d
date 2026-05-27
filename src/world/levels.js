import * as THREE from 'three';
import { DDGIMeshStandardNodeMaterial } from '../world/gi/DDGIMeshStandardNodeMaterial.js';
import { getProceduralBrickSet } from '../world/materials/proceduralBrickTexture.js';
import { registerBrickClone } from '../world/materials/brickTextures.js';
import { core } from '../runtime/appCore.js';
import { SoccerGoalieComponent } from '../runtime/components/SoccerGoalieComponent.js';

// Built-in level builders (FPS starter, soccer field, brick room, DOOM test
// & arena) plus DOOM enemy sprite-sheet generation. Extracted verbatim from
// runtime.js. Heavy THREE construction + actor spawning; engine deps are
// injected (same wireExtractedModules factory pattern as createRogueWaves).
export function createLevels(deps) {
    const {
        PLAYER_SETTINGS, physics, soccerGoalieState, gameplay,
        actorBelongsToCurrentMesh, applyPlayerSpawnFromActor, buildPrimitiveActorMesh,
        configurePointLightShadow, createDoomMiniBarrierEntries, createDynamicPropActor,
        createTerrainMesh, getActorBody, getActorRenderObject, markDDGISkipCapture,
        rebuildActorPhysics, resetRogueState, setActorColor, setActorComponentFlags,
        setActorResetTransform, setActorWorldPositionExact, setTerrainModeGrid,
        spawnDynamicPrimitive, spawnGameplayPrefab, syncActorBodyToRenderTransform,
        tagGameplayPrefabActor, tintGameplayPrefabActor, updateSoccerGoalies,
        applyShowcaseGraphics,
    } = deps;
    // Live accessor: currentMesh is reassigned on every level load in
    // runtime.js. Read it through the shared engine keystone (appCore.core),
    // which is bound eagerly at runtime.js load — always live, never stale.
    const cm = () => core.currentMesh;

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

        // ECS: attach a SoccerGoalieComponent so the SceneSystem tick pass
        // drives the sin-bob motion. The imperative updateSoccerGoalies loop
        // in runtime.js now only advances the shared soccerGoalieState.elapsed
        // clock (kept here for phase-locking across all goalies + reset).
        const motion = actor.userData.soccerGoalieMotion;
        if (motion) {
            actor.addComponent(new SoccerGoalieComponent({
                homePosition: motion.homePosition,
                axis: motion.axis,
                amplitude: motion.amplitude,
                speed: motion.speed,
                phase: motion.phase,
                getElapsed: () => soccerGoalieState.elapsed,
                getActivation: () => (gameplay?.active && physics?.ready
                    ? physics.Jolt.EActivation_Activate
                    : physics?.Jolt?.EActivation_DontActivate),
                syncBody: syncActorBodyToRenderTransform,
            }));
        }
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

        const brickMat = (set, { color = '#ffffff', metal = 0.05, rough = 1.0, envIntensity = 1.0 } = {}) => {
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
                roughness: rough,
                metalness: metal,
            });
            if ('envMapIntensity' in mat) mat.envMapIntensity = envIntensity;
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
            brickMat(floorSet, { color: '#4c4240', metal: 0.55, rough: 0.16, envIntensity: 0.04 }), { actorSurface: 'floor' });
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

    // Rogue Pit: a second self-contained Rogue Waves arena with a distinct
    // octagonal layout (vs. the square doomArena). It sets sampleType to
    // 'doomArena' so the entire wave/status/HUD/death game mode applies with
    // zero extra wiring — only the geometry + layout constants differ.
    function createRoguePitLevel() {
        const root = new THREE.Group();
        root.name = 'PolyFlow_Rogue_Pit';
        // Reuse the doomArena game-mode contract (wave loop reads this tag).
        root.userData.sampleType = 'doomArena';
        root.userData.hideTerrainPresentation = true;
        root.userData.skipNormalization = true;

        const T = 0.4;            // wall thickness
        const ARENA = 50;         // octagon bounding box
        const ARENA_H = 8.5;      // ceiling height
        const HALF = ARENA * 0.5;
        const WALL_COLOR = '#15202b';
        const BLUE_LIGHT = 0x3da6ff;
        const BLUE_EMISSIVE = '#3da6ff';

        root.userData.preferredSpawn = {
            position: [0, 0.3, 6.0],
            yaw: Math.PI,
            pitch: -0.05,
        };
        root.userData.preferredShowcase = {
            position: [0, PLAYER_SETTINGS.eyeHeight + 0.6, 10.0],
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

        const addBox = (name, size, position, material, { actorSurface = '', rotY = 0 } = {}) => {
            const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
            applyBrickWorldScale(material, size);
            if (geometry.attributes.uv && !geometry.attributes.uv2) {
                geometry.setAttribute('uv2', geometry.attributes.uv);
            }
            geometry.computeTangents();
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = name;
            mesh.position.set(position[0], position[1], position[2]);
            if (rotY) mesh.rotation.y = rotY;
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

        // Floor + ceiling.
        addBox('pit-floor', [ARENA, T, ARENA], [0, -T * 0.5, 0],
            brickMat(floorSet, { color: '#4a5560' }), { actorSurface: 'floor' });
        addBox('pit-ceiling', [ARENA, T, ARENA], [0, ARENA_H + T * 0.5, 0],
            flatMat('#10161c', { rough: 0.95 }), { actorSurface: 'roof' });

        // Octagonal wall ring: 8 angled wall segments forming the perimeter.
        const SEGMENTS = 8;
        const ringRadius = HALF - 1.0;
        // Segment length so neighbours overlap slightly at the corners.
        const segLen = (2 * Math.PI * ringRadius / SEGMENTS) * 1.12;
        const wallMat = brickMat(wallSet, { color: WALL_COLOR });
        for (let i = 0; i < SEGMENTS; i++) {
            const ang = (i / SEGMENTS) * Math.PI * 2;
            const wx = Math.cos(ang) * ringRadius;
            const wz = Math.sin(ang) * ringRadius;
            // Wall faces inward: rotate so its long axis is tangent to the ring.
            addBox(`pit-wall-${i}`, [segLen, ARENA_H, T], [wx, ARENA_H * 0.5, wz],
                wallMat, { rotY: -ang + Math.PI * 0.5 });
        }

        // Ring of cover pillars at a mid radius for line-of-sight breaks.
        const pillar = brickMat(accentSet, { color: '#2f6f9a' });
        const COVER_COUNT = 6;
        const coverRadius = ringRadius * 0.5;
        for (let i = 0; i < COVER_COUNT; i++) {
            const ang = (i / COVER_COUNT) * Math.PI * 2 + Math.PI / COVER_COUNT;
            const cx = Math.cos(ang) * coverRadius;
            const cz = Math.sin(ang) * coverRadius;
            addBox(`pit-cover-${i}`, [1.5, 3.4, 1.5], [cx, 1.7, cz], pillar);
        }

        // Center start pad.
        addBox('pit-pad', [4.0, 0.22, 4.0], [0, 0.11, 4.0],
            flatMat('#142028', { rough: 0.35, emissive: '#185a78', emissiveIntensity: 0.45 }));
        // Exit dais opposite the spawn.
        addBox('pit-exit-dais', [4.4, 0.4, 4.4], [0, 0.2, -ringRadius + 3.5],
            flatMat('#122028', { rough: 0.3, emissive: BLUE_EMISSIVE, emissiveIntensity: 0.45 }));

        // Same layout contract the doomArena game mode reads.
        root.userData.doomArenaLevel = {
            playerSpawn: [0, 0.85, 6.0],
            exitTeleporter: [0, 0.42, -ringRadius + 3.5],
            exitTeleporterHidden: [0, -48, -ringRadius + 3.5],
            spawnRingRadius: ringRadius - 3.5,
            spawnY: 0,
            waveCount: 4,
            baseWaveSize: 3,
            wavePerStep: 2,
        };

        // Cool blue lighting to distinguish the pit from the red doomArena.
        const keyLight = new THREE.PointLight(BLUE_LIGHT, 11, 52, 1.6);
        keyLight.position.set(0, ARENA_H - 1.0, 0);
        keyLight.castShadow = true;
        configurePointLightShadow(keyLight);
        keyLight.name = 'pit-key-light';
        root.add(keyLight);

        const RIM_LIGHTS = 4;
        for (let i = 0; i < RIM_LIGHTS; i++) {
            const ang = (i / RIM_LIGHTS) * Math.PI * 2 + Math.PI / RIM_LIGHTS;
            const lx = Math.cos(ang) * (ringRadius - 4);
            const lz = Math.sin(ang) * (ringRadius - 4);
            const cl = new THREE.PointLight(BLUE_LIGHT, 3.4, 24, 2.0);
            cl.position.set(lx, ARENA_H - 1.4, lz);
            cl.castShadow = false;
            cl.name = `pit-rim-light-${i}`;
            root.add(cl);
        }

        applySilPomLighting(root, keyLight.position.clone());
        return root;
    }

    // Drug Tycoon level: an open block with a central cook station, an upgrade
    // pad, and a perimeter wall. NPC buyers + police wander the "street". The
    // game loop lives in the self-contained drugTycoon module (driven per frame
    // from the frame loop); this just builds geometry + the layout contract.
    function createDrugTycoonLevel() {
        const root = new THREE.Group();
        root.name = 'PolyFlow_Drug_Tycoon';
        root.userData.sampleType = 'drugTycoon';
        root.userData.hideTerrainPresentation = true;
        root.userData.skipNormalization = true;

        const T = 0.4;
        const BLOCK = 80;        // open neighbourhood block
        const WALL_H = 4.0;
        const HALF = BLOCK * 0.5;

        root.userData.preferredSpawn = { position: [0, 0.3, 0], yaw: 0, pitch: -0.05 };
        root.userData.preferredShowcase = {
            position: [0, PLAYER_SETTINGS.eyeHeight + 0.6, 12.0],
            target: [0, 1.2, 0],
        };

        const flatMat = (color, { rough = 0.9, metal = 0.0, emissive = null, emissiveIntensity = 0 } = {}) => {
            const mat = new DDGIMeshStandardNodeMaterial({
                color: new THREE.Color(color), roughness: rough, metalness: metal,
            });
            if (emissive) { mat.emissive = new THREE.Color(emissive); mat.emissiveIntensity = emissiveIntensity; }
            return mat;
        };

        // `solid:true` gives the box player-blocking collision (used for house
        // walls so you can't walk through buildings). `actorSurface` keeps the
        // existing floor/roof walkable-collision behaviour.
        const addBox = (name, size, position, material, { actorSurface = '', solid = false, rotY = 0 } = {}) => {
            const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = name;
            mesh.position.set(position[0], position[1], position[2]);
            if (rotY) mesh.rotation.y = rotY;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            if (actorSurface) mesh.userData.doomMapSurface = actorSurface;
            root.add(mesh);
            if (actorSurface || solid) {
                const actor = makeSampleLevelMeshActor(name, mesh, {
                    kind: 'imported', castShadow: true, receiveShadow: true,
                    skipPhysicsCollision: true, userData: actorSurface ? { doomMapSurface: actorSurface } : {},
                });
                if (solid || actorSurface === 'floor' || actorSurface === 'roof') {
                    enableStaticMeshActorCollision(actor);
                }
            }
            return mesh;
        };

        // ---- materials -------------------------------------------------
        const grassMat   = flatMat('#3f7d34', { rough: 0.97 });
        const roadMat    = flatMat('#2b2e32', { rough: 0.95 });
        const lineMat    = flatMat('#d8c45a', { rough: 0.7, emissive: '#d8c45a', emissiveIntensity: 0.15 });
        const curbMat    = flatMat('#9aa0a6', { rough: 0.85 });
        const sidewalkMat= flatMat('#7e8388', { rough: 0.9 });

        // ---- ground -----------------------------------------------------
        // ONE collision floor for the whole block (its top sits flush at y=0).
        // Roads / sidewalks / lines are visual-only decals laid on top with NO
        // collision, so the player walks a single seamless plane — stacking
        // multiple thin coplanar colliders here snags the player capsule.
        addBox('tycoon-grass', [BLOCK, T, BLOCK], [0, -T * 0.5, 0], grassMat, { actorSurface: 'floor' });

        // Thin visual decal helper: a flat slab whose TOP face rests at y=0.
        // Tiny per-layer y offset avoids z-fighting between overlapping decals.
        const DECAL_T = 0.04;
        const decal = (name, size, x, z, mat, lift = 0) =>
            addBox(name, [size[0], DECAL_T, size[1]], [x, -DECAL_T * 0.5 + 0.005 + lift, z], mat);

        const ROAD_W = 9;        // road width
        // N-S and E-W roads forming a cross through the centre (visual only).
        decal('tycoon-road-ns', [ROAD_W, BLOCK], 0, 0, roadMat, 0.001);
        decal('tycoon-road-ew', [BLOCK, ROAD_W], 0, 0, roadMat, 0.001);
        // Centre dashed lines (short segments per axis), above the asphalt.
        // Skip any dash that falls inside the central intersection so the two
        // axes don't overlap into a big yellow "X" at the crossing.
        const CLEAR = ROAD_W * 0.5 + 1.2;   // keep the junction box marking-free
        for (let i = -HALF + 4; i < HALF; i += 6) {
            if (Math.abs(i) > CLEAR) decal(`tycoon-line-ns-${i}`, [0.35, 2.4], 0, i, lineMat, 0.004);
            if (Math.abs(i) > CLEAR) decal(`tycoon-line-ew-${i}`, [2.4, 0.35], i, 0, lineMat, 0.004);
        }
        // Sidewalks flanking each road + raised curbs at the grass edge.
        const SW = 2.0, half = ROAD_W * 0.5;
        [-1, 1].forEach((s) => {
            decal(`tycoon-sw-ns-${s}`, [SW, BLOCK], s * (half + SW * 0.5), 0, sidewalkMat, 0.002);
            decal(`tycoon-sw-ew-${s}`, [BLOCK, SW], 0, s * (half + SW * 0.5), sidewalkMat, 0.002);
            // Curbs: thin raised visual lips at the lot edge (no collision, so
            // the player crosses roads freely — a 0.2m curb would wall in a
            // capsule character at every intersection).
            addBox(`tycoon-curb-ns-${s}`, [0.2, 0.12, BLOCK], [s * (half + SW), 0.06, 0], curbMat);
            addBox(`tycoon-curb-ew-${s}`, [BLOCK, 0.12, 0.2], [0, 0.06, s * (half + SW)], curbMat);
        });

        // ---- houses around the four corner lots ------------------------
        const HOUSE_TONES = ['#b5654d', '#c9a26b', '#7d96a8', '#a8728c', '#6f9e6a', '#c2bba0'];
        const ROOF_TONES  = ['#3b2a24', '#4a3b2e', '#2e3a44', '#402a36'];
        const pick = (arr, i) => arr[i % arr.length];
        let hIdx = 0;
        // Houses are built as flat (non-nested) meshes parented straight to
        // root. The engine's sample-collision restore pass reparents every
        // collidable part to currentMesh, dropping any intermediate Group
        // transform — so we bake the house's rotation into each child's own
        // position/rotation instead of using a wrapper Group.
        const addHouse = (cx, cz, w, d, h, faceY = 0, { home = false } = {}) => {
            const i = hIdx++;
            const cos = Math.cos(faceY), sin = Math.sin(faceY);
            // Local (x,y,z) → world, rotated about the house centre by faceY.
            const place = (mesh, lx, ly, lz) => {
                mesh.position.set(cx + lx * cos + lz * sin, ly, cz - lx * sin + lz * cos);
                mesh.rotation.y = faceY;
                mesh.castShadow = true; mesh.receiveShadow = true;
                root.add(mesh);
                return mesh;
            };
            // The home is always the green house with a prominent door.
            const wallMat = flatMat(home ? '#4f8f4a' : pick(HOUSE_TONES, i), { rough: 0.92 });
            const roofMat = flatMat(home ? '#274a2a' : pick(ROOF_TONES, i), { rough: 0.85 });
            const winMat  = flatMat('#bfe6ff', { rough: 0.2, metal: 0.1, emissive: '#9fd0ff', emissiveIntensity: 0.25 });

            // Solid wall box — the only collidable part.
            const body = place(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat), 0, h * 0.5, 0);
            body.name = `tycoon-house-${i}`;
            // Pitched roof (flattened 4-sided cone), centred on top.
            const roof = place(new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.78, h * 0.55, 4), roofMat), 0, h + h * 0.27, 0);
            roof.rotation.set(0, faceY + Math.PI * 0.25, 0);

            // Door on the front (+Z) face. The home gets a larger, framed,
            // glowing door so it's obviously the one you can enter.
            const frontZ = d * 0.5 + 0.02;
            if (home) {
                const frameMat = flatMat('#caa15a', { rough: 0.5, emissive: '#caa15a', emissiveIntensity: 0.2 });
                const doorMat  = flatMat('#5b3a1c', { rough: 0.55, emissive: '#7a5224', emissiveIntensity: 0.35 });
                const knobMat  = flatMat('#ffe08a', { rough: 0.3, metal: 0.6, emissive: '#ffd24a', emissiveIntensity: 0.6 });
                place(new THREE.Mesh(new THREE.BoxGeometry(1.7, 2.7, 0.1), frameMat), 0, 1.35, frontZ);          // frame
                place(new THREE.Mesh(new THREE.BoxGeometry(1.35, 2.4, 0.16), doorMat), 0, 1.2, frontZ + 0.04);   // door slab
                place(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), knobMat), 0.5, 1.15, frontZ + 0.14); // knob
                // Porch light above the door so it reads as "home".
                const light = new THREE.PointLight(0xffd9a0, 4, 8, 1.6);
                place(light, 0, 2.9, frontZ + 0.3);
                light.name = 'home-porch-light';
            } else {
                const doorMat = flatMat('#2a1d14', { rough: 0.7 });
                place(new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.9, 0.12), doorMat), 0, 0.95, frontZ);
            }
            place(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.1), winMat), -w * 0.28, h * 0.6, frontZ);
            place(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.1), winMat),  w * 0.28, h * 0.6, frontZ);

            // Register only the wall as a solid static actor (collision baked
            // from its already-correct world transform).
            body.updateMatrixWorld(true);
            const actor = makeSampleLevelMeshActor(`tycoon-house-${i}`, body, {
                kind: 'imported', castShadow: true, receiveShadow: true,
            });
            enableStaticMeshActorCollision(actor);
        };

        // Place houses on the grass lots between the roads and the perimeter,
        // facing the nearest road. Keep the centre (cook/upgrade/gun) clear.
        const LOT = HALF - 9;
        addHouse(-LOT, -LOT, 9, 7, 5, Math.PI * 0.75);
        addHouse(-LOT,  LOT, 8, 7, 5, Math.PI * 0.25);
        addHouse( LOT, -LOT, 9, 8, 6, Math.PI * 1.25);
        addHouse( LOT,  LOT, 8, 7, 5, Math.PI * 1.75);
        // "Your house" — west lot, the green house with a prominent door.
        // faceY = +PI/2 maps the local +Z front to world +X, so the door faces
        // the centre road (east) where HOME_DOOR sits.
        const HOME = [-LOT, 0];
        addHouse(HOME[0], HOME[1], 8, 10, 5.5, Math.PI * 0.5, { home: true });
        addHouse( LOT,    0, 7, 9, 5, -Math.PI * 0.5);  // east lot

        // Door interaction point: just outside the home's front face. With
        // faceY +PI/2 the front (+Z) maps to world +X, so it's at HOME.x + d/2.
        const HOME_DOOR = [HOME[0] + 10 * 0.5 + 0.6, HOME[1]];

        // ---- interior grow room (built far off-map; same level) ---------
        // The player is teleported here on entering the home. A small sealed
        // room with weed plants to harvest and a packaging bench.
        const ROOM_ORIGIN = [0, 0, 300];
        // Bigger room. ROOM_W / ROOM_D drive the pot layout + anchors below.
        const ROOM_W = 26, ROOM_D = 22;
        // Packaging bench sits in the NE corner (away from the plant rows and
        // the entrance, which is on the +Z / south wall).
        const BENCH_LOCAL = [ROOM_W * 0.5 - 2.4, ROOM_D * 0.5 - 12];
        const buildGrowRoom = (ox, oy, oz) => {
            const W = ROOM_W, D = ROOM_D, H = 4.6, WT = 0.4;
            // Dim grow-tent surfaces — dark enough to stay moody but light enough
            // for the purple fill to read across the whole room.
            const floorMat = flatMat('#3a3030', { rough: 0.95 });
            const rWallMat = flatMat('#363a30', { rough: 0.93 });
            const ceilMat  = flatMat('#262820', { rough: 0.95 });
            // Floor (walkable) + ceiling.
            addBox('grow-floor', [W, WT, D], [ox, oy - WT * 0.5, oz], floorMat, { actorSurface: 'floor' });
            addBox('grow-ceil',  [W, WT, D], [ox, oy + H, oz], ceilMat);
            // Four solid walls.
            addBox('grow-wall-n', [W, H, WT], [ox, oy + H * 0.5, oz - D * 0.5], rWallMat, { solid: true });
            addBox('grow-wall-s', [W, H, WT], [ox, oy + H * 0.5, oz + D * 0.5], rWallMat, { solid: true });
            addBox('grow-wall-e', [WT, H, D], [ox + W * 0.5, oy + H * 0.5, oz], rWallMat, { solid: true });
            addBox('grow-wall-w', [WT, H, D], [ox - W * 0.5, oy + H * 0.5, oz], rWallMat, { solid: true });
            // Purple grow lamps: a glowing emissive bar + a rectangular area
            // light under each. Emissive kept modest so the panels read PURPLE
            // (not blown-out white) while still blooming.
            const lampMat = flatMat('#a34dff', { rough: 0.4, emissive: '#8f35ff', emissiveIntensity: 1.4 });
            [-7, 0, 7].forEach((lx, k) => {
                addBox(`grow-lamp-${k}`, [3.2, 0.08, 1.35], [ox + lx, oy + H - WT - 0.12, oz - 4], lampMat);
                const rect = new THREE.RectAreaLight(0xffffff, 12.0, 3.6, 2.0);
                rect.position.set(ox + lx, oy + H - WT - 0.22, oz - 4);
                rect.lookAt(ox + lx, oy, oz - 4);   // aim straight down at the plants
                rect.name = `grow-rect-light-${k}`;
                root.add(rect);
            });
            // Bright white rect light hanging low in middle of room.
            const whitePanelMat = flatMat('#ffffff', { rough: 0.3, emissive: '#ffffff', emissiveIntensity: 3.0 });
            addBox('grow-white-panel', [4.0, 0.1, 2.2], [ox, oy + H - WT - 0.12, oz], whitePanelMat);
            const whiteRect = new THREE.RectAreaLight(0xffffff, 20.0, 4.0, 2.2);
            whiteRect.position.set(ox, oy + H - WT - 0.22, oz);
            whiteRect.lookAt(ox, oy, oz);
            whiteRect.name = 'grow-white-rect';
            root.add(whiteRect);
            // Purple ambient fill across the WHOLE room — ambient lights every
            // surface equally, so this is what spreads the purple everywhere
            // (walls, pots, bench, door) instead of just under the lamps.
            const growAmbient = new THREE.AmbientLight(0x8a66c8, 1.4);
            growAmbient.name = 'grow-ambient';
            root.add(growAmbient);
            // A gentle purple hemisphere too, so up-facing surfaces (pot rims,
            // bench top) catch a touch more light than down-facing ones.
            const growHemi = new THREE.HemisphereLight(0xa884ff, 0x140a20, 0.6);
            growHemi.position.set(ox, oy + H, oz);
            growHemi.name = 'grow-hemi';
            root.add(growHemi);
            // Props use darker, low/no-emissive materials so they sit inside the
            // moody purple lighting instead of glowing/popping out of it. Only
            // the small interaction signs keep a faint glow as way-finding hints.
            // Packaging bench (steel) in the NE corner.
            const benchMat = flatMat('#2a2f36', { rough: 0.6, metal: 0.3 });
            addBox('grow-bench', [4, 1.0, 1.6], [ox + BENCH_LOCAL[0] - 1.0, oy + 0.5, oz + BENCH_LOCAL[1]], benchMat, { solid: true });

            // Exit door on the south (+Z) wall. Non-solid so the player can walk
            // into it to leave. Dark wood, no glow.
            const doorFrameMat = flatMat('#5a4424', { rough: 0.6 });
            const doorSlabMat  = flatMat('#3a2614', { rough: 0.7 });
            const exitZ = oz + D * 0.5 - WT * 0.5 - 0.02;
            addBox('grow-exit-frame', [2.0, 3.0, 0.12], [ox, oy + 1.5, exitZ], doorFrameMat);
            addBox('grow-exit-door',  [1.6, 2.6, 0.18], [ox, oy + 1.3, exitZ - 0.05], doorSlabMat);
            const exitKnob = flatMat('#9a8050', { rough: 0.4, metal: 0.5 });
            addBox('grow-exit-knob', [0.16, 0.16, 0.16], [ox + 0.55, oy + 1.25, exitZ - 0.14], exitKnob);
            // Small white glow strip under the door — the only way-finding marker.
            const exitStrip = flatMat('#ffffff', { rough: 0.4, emissive: '#ffffff', emissiveIntensity: 1.2 });
            addBox('grow-exit-strip', [1.4, 0.06, 0.1], [ox, oy + 0.05, exitZ], exitStrip);

            // Bed in the SW corner — sleep here to skip to morning. Muted fabric.
            const bedFrameMat = flatMat('#2a1f15', { rough: 0.9 });
            const mattressMat = flatMat('#4a5058', { rough: 0.9 });
            const pillowMat   = flatMat('#5a6068', { rough: 0.85 });
            const bx = ox - W * 0.5 + 1.6, bz = oz + D * 0.5 - 2.2;
            addBox('grow-bed-frame', [2.2, 0.5, 3.4], [bx, oy + 0.25, bz], bedFrameMat, { solid: true });
            addBox('grow-bed-mattress', [2.0, 0.3, 3.0], [bx, oy + 0.6, bz], mattressMat);
            addBox('grow-bed-pillow', [1.7, 0.22, 0.7], [bx, oy + 0.82, bz - 1.05], pillowMat);

            // Upgrade desk in the SE corner — open the upgrade shop here. Dark
            // wood, faint sign glow only.
            const upgMat = flatMat('#2a2410', { rough: 0.5 });
            const ux = ox + W * 0.5 - 2.4, uz = oz + D * 0.5 - 2.4;
            addBox('grow-upgrade', [2.4, 1.0, 1.6], [ux, oy + 0.5, uz], upgMat, { solid: true });

            // ---- shop dressing (south half, between entrance and plants) ----
            // Make the interior read as an actual WEED SHOP storefront. Sales
            // counter L-shape flanks the entry door, glass display cases line
            // the west wall, jar shelves run along the east wall, posters on
            // the back, welcome mat at the door. Purely cosmetic — none of
            // these change gameplay anchors (bench / bed / upgrade desk / pots).
            const woodWarmMat   = flatMat('#5a3a1f', { rough: 0.55 });   // counter wood
            const woodTopMat    = flatMat('#2a1a0e', { rough: 0.35, emissive: '#0a0604', emissiveIntensity: 0.0 });
            const glassMat      = flatMat('#bfe8ff', { rough: 0.05, metal: 0.4, emissive: '#5fc8ff', emissiveIntensity: 0.55 });
            const jarLidMat     = flatMat('#161616', { rough: 0.5, metal: 0.4 });
            const budGreenMat   = flatMat('#3fa852', { rough: 0.6, emissive: '#2a8040', emissiveIntensity: 0.35 });
            const budPurpleMat  = flatMat('#8a52d4', { rough: 0.6, emissive: '#6a32b8', emissiveIntensity: 0.4 });
            const budOrangeMat  = flatMat('#d4a850', { rough: 0.6, emissive: '#a07020', emissiveIntensity: 0.35 });
            const matFloorMat   = flatMat('#1a3a20', { rough: 0.9, emissive: '#0a2a14', emissiveIntensity: 0.4 });
            const registerMat   = flatMat('#16181c', { rough: 0.4, metal: 0.6 });
            const registerScreenMat = flatMat('#6fffaa', { rough: 0.2, emissive: '#3aff90', emissiveIntensity: 1.6 });
            const posterGreenMat = flatMat('#0a2410', { rough: 0.6, emissive: '#3fa852', emissiveIntensity: 0.9 });
            const posterPurpleMat = flatMat('#1a0a2a', { rough: 0.6, emissive: '#8a52d4', emissiveIntensity: 0.9 });

            // Welcome mat in front of the entrance door.
            addBox('grow-welcome-mat', [2.6, 0.03, 1.4], [ox, oy + 0.015, exitZ - 1.2], matFloorMat);

            // L-shape sales counter east of the entrance, parallel to + perpendicular
            // to the south wall. Long leg runs north-south, short leg runs east-west.
            const cLongX = ox + 3.2, cLongZ = oz + D * 0.5 - 4.6;
            addBox('grow-counter-long', [1.2, 1.0, 3.4], [cLongX, oy + 0.5, cLongZ], woodWarmMat, { solid: true });
            addBox('grow-counter-long-top', [1.3, 0.08, 3.5], [cLongX, oy + 1.04, cLongZ], woodTopMat);
            const cShortX = ox + 1.8, cShortZ = oz + D * 0.5 - 3.0;
            addBox('grow-counter-short', [1.6, 1.0, 1.2], [cShortX, oy + 0.5, cShortZ], woodWarmMat, { solid: true });
            addBox('grow-counter-short-top', [1.7, 0.08, 1.3], [cShortX, oy + 1.04, cShortZ], woodTopMat);

            // Cash register on the corner of the counter.
            addBox('grow-register-base', [0.7, 0.4, 0.5], [cLongX, oy + 1.28, cLongZ - 1.2], registerMat);
            addBox('grow-register-screen', [0.5, 0.32, 0.05], [cLongX - 0.1, oy + 1.52, cLongZ - 1.0], registerScreenMat);

            // Three display jars on the long counter top.
            const addJar = (jx, jz, budMat) => {
                const jarBody = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.32, 16), glassMat);
                jarBody.position.set(jx, oy + 1.24, jz);
                jarBody.castShadow = true; jarBody.receiveShadow = true;
                root.add(jarBody);
                const jarBud = new THREE.Mesh(new THREE.IcosahedronGeometry(0.14, 0), budMat);
                jarBud.position.set(jx, oy + 1.22, jz);
                root.add(jarBud);
                const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.06, 16), jarLidMat);
                lid.position.set(jx, oy + 1.43, jz);
                root.add(lid);
            };
            addJar(cLongX, cLongZ + 0.4, budGreenMat);
            addJar(cLongX, cLongZ + 1.2, budPurpleMat);
            addJar(cLongX - 0.05, cLongZ - 0.3, budOrangeMat);

            // West-wall display case: a long glass-fronted cabinet with three
            // shelves of jars. Sits flush against the west wall, south of the bed.
            // Bed occupies bz - 1.7 .. bz + 1.7 (z = oz + D*0.5 - 2.2 ± 1.7), so
            // case ends just north of it.
            const dcX = ox - W * 0.5 + 1.0;
            const dcZ = oz + 1.0;
            addBox('grow-displaycase-back', [0.2, 2.6, 5.0], [dcX - 0.1, oy + 1.3, dcZ], woodWarmMat, { solid: true });
            addBox('grow-displaycase-base', [1.0, 0.4, 5.0], [dcX + 0.4, oy + 0.2, dcZ], woodWarmMat);
            addBox('grow-displaycase-shelf1', [1.0, 0.05, 5.0], [dcX + 0.4, oy + 1.0, dcZ], woodTopMat);
            addBox('grow-displaycase-shelf2', [1.0, 0.05, 5.0], [dcX + 0.4, oy + 1.8, dcZ], woodTopMat);
            addBox('grow-displaycase-glass', [0.04, 2.0, 5.0], [dcX + 0.92, oy + 1.4, dcZ], glassMat);
            // Two jars per shelf, three shelves, alternating colours.
            for (let row = 0; row < 3; row++) {
                const jy = oy + 0.55 + row * 0.8;
                for (let col = 0; col < 4; col++) {
                    const jz = dcZ - 2.0 + col * 1.3;
                    const bm = [budGreenMat, budPurpleMat, budOrangeMat][(row + col) % 3];
                    const jb = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.28, 12), glassMat);
                    jb.position.set(dcX + 0.4, jy, jz);
                    root.add(jb);
                    const jbud = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 0), bm);
                    jbud.position.set(dcX + 0.4, jy - 0.02, jz);
                    root.add(jbud);
                    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.05, 12), jarLidMat);
                    lid.position.set(dcX + 0.4, jy + 0.16, jz);
                    root.add(lid);
                }
            }

            // East-wall jar shelves (open). Between the entry and the upgrade
            // desk / bench column on the east side. Three floating shelves.
            const esX = ox + W * 0.5 - 0.7;
            const esZ = oz + 2.0;
            for (let s2 = 0; s2 < 3; s2++) {
                const sy = oy + 1.0 + s2 * 0.8;
                addBox(`grow-eshelf-${s2}`, [0.8, 0.06, 4.6], [esX - 0.4, sy, esZ], woodTopMat);
                addBox(`grow-eshelf-bracket-${s2}`, [0.3, 0.06, 0.3], [esX - 0.4, sy - 0.1, esZ - 2.0], woodWarmMat);
                addBox(`grow-eshelf-bracket-${s2}b`, [0.3, 0.06, 0.3], [esX - 0.4, sy - 0.1, esZ + 2.0], woodWarmMat);
                for (let col = 0; col < 4; col++) {
                    const jz = esZ - 1.8 + col * 1.2;
                    const bm = [budGreenMat, budOrangeMat, budPurpleMat][(s2 * 2 + col) % 3];
                    const jb = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.26, 12), glassMat);
                    jb.position.set(esX - 0.4, sy + 0.16, jz);
                    root.add(jb);
                    const jbud = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), bm);
                    jbud.position.set(esX - 0.4, sy + 0.14, jz);
                    root.add(jbud);
                }
            }

            // Wall posters along the south wall, either side of the door.
            addBox('grow-poster-l', [0.04, 1.4, 1.0], [ox - 3.0, oy + 1.8, exitZ - 0.15], posterGreenMat);
            addBox('grow-poster-r', [0.04, 1.4, 1.0], [ox + 3.0, oy + 1.8, exitZ - 0.15], posterPurpleMat);

            // Pendant lights above the counter — warm spots that read as shop lighting.
            const pendantMat = flatMat('#ffd07a', { rough: 0.3, emissive: '#ffb050', emissiveIntensity: 2.2 });
            for (let p = 0; p < 2; p++) {
                const pz = cLongZ - 0.8 + p * 1.6;
                addBox(`grow-pendant-${p}`, [0.3, 0.2, 0.3], [cLongX, oy + H - 1.2, pz], pendantMat);
                const cord = flatMat('#1a1a1a', { rough: 0.9 });
                addBox(`grow-pendant-cord-${p}`, [0.04, 1.1, 0.04], [cLongX, oy + H - 0.55, pz], cord);
                const pendantLight = new THREE.PointLight(0xffb060, 2.4, 6, 1.8);
                pendantLight.position.set(cLongX, oy + H - 1.4, pz);
                pendantLight.name = `grow-pendant-light-${p}`;
                root.add(pendantLight);
            }
        };
        buildGrowRoom(...ROOM_ORIGIN);

        // Plant spots: two rows in the north half of the room. The visible
        // fabric grow bag is drawn by the drugTycoon plant mesh itself, so no
        // placeholder box here — just the floor positions for each plant.
        const POTS = [];
        [-8, -4.6, -1.2, 2.2, 5.6].forEach((px) => {
            [-6.5, -3.0].forEach((pz) => {
                const wx = ROOM_ORIGIN[0] + px, wz = ROOM_ORIGIN[2] + pz;
                POTS.push([wx, 0, wz]);
            });
        });

        // Trees: a trunk + foliage sphere scattered on the grass.
        const trunkMat = flatMat('#5b3a21', { rough: 0.95 });
        const leafMat  = flatMat('#2f6d2c', { rough: 0.95 });
        const TREES = [[-LOT + 6, -6], [LOT - 6, 6], [-6, LOT - 6], [6, -LOT + 6], [-LOT + 5, LOT - 5]];
        TREES.forEach(([tx, tz], i) => {
            const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 2.2, 6), trunkMat);
            trunk.position.set(tx, 1.1, tz); trunk.castShadow = true; root.add(trunk);
            const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5, 0), leafMat);
            leaves.position.set(tx, 3.0, tz); leaves.castShadow = true; root.add(leaves);
        });

        // Cook station (green lab bench) — in the SW grass lot.
        const COOK = [-LOT + 2, -LOT + 5];
        addBox('tycoon-cook', [3.0, 1.0, 2.0], [COOK[0], 0.5, COOK[1]],
            flatMat('#0f3d22', { rough: 0.4, metal: 0.3, emissive: '#1f9c52', emissiveIntensity: 0.5 }), { solid: true });
        // ---- text-sign helper -----------------------------------------
        // Renders one or two lines of bold text into a CanvasTexture and
        // returns a flat double-sided plane mesh you can park in front of a
        // wall / on top of a kiosk. Emissive so it reads in night lighting.
        // text:    main heading
        // sub:     optional secondary line (smaller)
        // bg/fg:   panel + text colour
        const makeSignMesh = (text, {
            sub = '',
            width = 2.4,
            height = 0.8,
            bg = '#0a2410',
            fg = '#b6ff6a',
            sigil = '',                  // optional emoji-style prefix
        } = {}) => {
            const W = 512, H = Math.round(W * height / width);
            const canvas = document.createElement('canvas');
            canvas.width = W; canvas.height = H;
            const ctx = canvas.getContext('2d');
            // Rounded panel background.
            ctx.fillStyle = bg;
            const r = 24;
            ctx.beginPath();
            ctx.moveTo(r, 0);
            ctx.lineTo(W - r, 0); ctx.quadraticCurveTo(W, 0, W, r);
            ctx.lineTo(W, H - r); ctx.quadraticCurveTo(W, H, W - r, H);
            ctx.lineTo(r, H);     ctx.quadraticCurveTo(0, H, 0, H - r);
            ctx.lineTo(0, r);     ctx.quadraticCurveTo(0, 0, r, 0);
            ctx.closePath(); ctx.fill();
            // Inner border.
            ctx.strokeStyle = fg;
            ctx.lineWidth = 6;
            ctx.stroke();
            // Heading. Auto-shrink if it overflows the panel.
            const main = sigil ? `${sigil} ${text}` : text;
            ctx.fillStyle = fg;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            let fs = sub ? Math.floor(H * 0.42) : Math.floor(H * 0.58);
            ctx.font = `900 ${fs}px "Trebuchet MS", system-ui, sans-serif`;
            while (ctx.measureText(main).width > W - 40 && fs > 14) {
                fs -= 2;
                ctx.font = `900 ${fs}px "Trebuchet MS", system-ui, sans-serif`;
            }
            ctx.fillText(main, W / 2, sub ? H * 0.36 : H * 0.5);
            if (sub) {
                let ss = Math.floor(H * 0.24);
                ctx.font = `700 ${ss}px "Trebuchet MS", system-ui, sans-serif`;
                while (ctx.measureText(sub).width > W - 40 && ss > 10) {
                    ss -= 2;
                    ctx.font = `700 ${ss}px "Trebuchet MS", system-ui, sans-serif`;
                }
                ctx.fillStyle = '#eaffea';
                ctx.fillText(sub, W / 2, H * 0.74);
            }
            const tex = new THREE.CanvasTexture(canvas);
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.anisotropy = 4;
            tex.needsUpdate = true;
            const mat = new THREE.MeshStandardMaterial({
                map: tex,
                emissive: new THREE.Color(fg),
                emissiveMap: tex,
                emissiveIntensity: 1.1,
                roughness: 0.55,
                metalness: 0.0,
                side: THREE.DoubleSide,
                transparent: false,
            });
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            return mesh;
        };

        // Both outdoor shops face the world centre (where the player spawns
        // and the road runs), so the plaque + counter front always greet the
        // approach instead of pointing at the perimeter wall. `faceY` makes
        // the kiosk's local +Z (front face / plaque side) point at origin.
        const faceOrigin = (kx, kz) => Math.atan2(-kx, -kz);
        // Mark a mesh/group as a yaw-only billboard. Drug-tycoon's per-frame
        // update walks the level scene and rotates each tagged object so its
        // +Z always points at the camera (in the XZ plane only — no pitch).
        // Used for the shop signs + cook label so the text never goes oblique.
        const billboard = (obj) => { obj.userData.billboardY = true; return obj; };

        // Seed shop kiosk (outside) — SE grass lot, opposite the cook bench.
        // Boxy stall + a glowing readable sign mounted on top, plus a smaller
        // "buy here" plaque on the front face of the kiosk.
        const SEED = [LOT - 3, -LOT + 5];
        const SEED_FACE = faceOrigin(SEED[0], SEED[1]);
        addBox('tycoon-seedshop', [3.4, 2.4, 2.4], [SEED[0], 1.2, SEED[1]],
            flatMat('#13351c', { rough: 0.55, emissive: '#3bd16a', emissiveIntensity: 0.45 }),
            { solid: true, rotY: SEED_FACE });
        // Big roof sign — single billboarded plane that yaws to face the
        // player every frame, so it always reads clearly no matter where you
        // approach from.
        {
            const sign = makeSignMesh('SEED SHOP', { sub: 'WEED SEEDS · 3 TIERS', width: 2.6, height: 0.9, sigil: '🌱' });
            sign.position.set(SEED[0], 3.05, SEED[1]);
            sign.name = 'tycoon-seedshop-sign';
            billboard(sign);
            root.add(sign);
        }
        // Front-face plaque — static, mounted on the kiosk's front face. Sits
        // just in front of the rotated box along its facing direction so it
        // doesn't z-fight, and inherits the kiosk's orientation (no billboard).
        {
            const plaque = makeSignMesh('BUY SEEDS', { sub: 'Walk up · press E', width: 1.8, height: 0.7, fg: '#cdeaff', bg: '#0a1e10' });
            const off = 1.21;
            plaque.position.set(SEED[0] + Math.sin(SEED_FACE) * off, 1.7, SEED[1] + Math.cos(SEED_FACE) * off);
            plaque.rotation.y = SEED_FACE;
            plaque.name = 'tycoon-seedshop-plaque';
            root.add(plaque);
        }
        // Cook-station label — billboarded too.
        {
            const cookSign = makeSignMesh('COOK', { sub: 'Stash → product', width: 1.6, height: 0.6, fg: '#9dffa0', bg: '#0a2410' });
            cookSign.position.set(COOK[0], 1.9, COOK[1]);
            cookSign.name = 'tycoon-cook-sign';
            billboard(cookSign);
            root.add(cookSign);
        }
        // ---- grow-juice shop (the "other house", NE grass lot) -------------
        // Across the street from the seed shop. Built in a single Group placed
        // at JUICE + rotated so the counter front faces the world centre.
        // All wall/roof/counter coords below are LOCAL to that group, so the
        // facing rotation hits the whole building at once.
        const JUICE = [LOT - 3, LOT - 5];
        const JUICE_FACE = faceOrigin(JUICE[0], JUICE[1]);
        const juiceWallMat = flatMat('#1a2a3a', { rough: 0.7 });
        const juiceRoofMat = flatMat('#0c1a26', { rough: 0.5, emissive: '#3aa6d6', emissiveIntensity: 0.35 });
        const juiceCounterMat = flatMat('#0e3548', { rough: 0.5, metal: 0.25, emissive: '#3aa6d6', emissiveIntensity: 0.5 });

        const juiceGroup = new THREE.Group();
        juiceGroup.name = 'tycoon-juiceshop-building';
        juiceGroup.position.set(JUICE[0], 0, JUICE[1]);
        juiceGroup.rotation.y = JUICE_FACE;
        root.add(juiceGroup);

        // Helper — adds a local box to the juice group AND registers a static
        // collision body at the world-transformed position so physics still
        // matches the rotated visuals.
        const addJuicePart = (name, size, localPos, material, { solid = false } = {}) => {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
            mesh.name = name;
            mesh.position.set(localPos[0], localPos[1], localPos[2]);
            mesh.castShadow = true; mesh.receiveShadow = true;
            juiceGroup.add(mesh);
            if (solid) {
                // Bake the rotation into a world-space collider box. We rotate
                // the bounding extents to keep the physics shape axis-aligned
                // for the underlying static mesh actor, while the visual still
                // tilts with the group.
                juiceGroup.updateMatrixWorld(true);
                const worldPos = mesh.getWorldPosition(new THREE.Vector3());
                const sized = [size[0], size[1], size[2]];
                // For a Y-rotation, swap X/Z extents if the rotation is closer
                // to ±90° than 0/180°. JUICE_FACE depends on lot position;
                // compute the better fit.
                const c = Math.abs(Math.cos(JUICE_FACE));
                const collider = (c < 0.5) ? [sized[2], sized[1], sized[0]] : sized;
                const phys = new THREE.Mesh(new THREE.BoxGeometry(collider[0], collider[1], collider[2]), material);
                phys.position.copy(worldPos);
                phys.visible = false;
                phys.name = `${name}-collider`;
                root.add(phys);
                const actor = makeSampleLevelMeshActor(phys.name, phys, {
                    kind: 'imported', castShadow: false, receiveShadow: false, skipPhysicsCollision: true,
                });
                enableStaticMeshActorCollision(actor);
            }
            return mesh;
        };

        // Back + side walls fake a building footprint behind the counter (local coords).
        addJuicePart('tycoon-juiceshop-backwall', [4.6, 3.2, 0.3], [0, 1.6, -1.8], juiceWallMat, { solid: true });
        addJuicePart('tycoon-juiceshop-sidewall', [0.3, 3.2, 3.8], [2.15, 1.6, 0], juiceWallMat, { solid: true });
        // Flat roof slab on top — emissive trim hints at neon underlighting.
        addJuicePart('tycoon-juiceshop-roof', [4.8, 0.2, 4.0], [0, 3.3, 0], juiceRoofMat);
        // The counter kiosk itself (solid for collision + interaction radius anchor).
        addJuicePart('tycoon-juiceshop', [3.4, 1.6, 1.8], [0, 0.8, 0.6], juiceCounterMat, { solid: true });
        // Overhead sign + plaque attach to ROOT (not the rotated juiceGroup) so
        // the per-frame billboard tick can spin them freely. Their world
        // positions sit above + in front of the rotated counter.
        {
            const sign = makeSignMesh('GROW JUICE', { sub: 'POUR-ON SPEED BOOST', width: 2.8, height: 0.9, sigil: '🧪', fg: '#7fd0ff', bg: '#0a1e2a' });
            sign.position.set(JUICE[0], 3.6, JUICE[1]);
            sign.name = 'tycoon-juiceshop-sign';
            billboard(sign);
            root.add(sign);
        }
        {
            const plaque = makeSignMesh('BUY JUICE', { sub: 'Walk up · press E', width: 1.8, height: 0.7, fg: '#cdeaff', bg: '#0a1828' });
            // Plaque hovers in front of the counter; the front of the counter
            // is along the +localZ axis of juiceGroup, which is JUICE + 1.51 *
            // (sin(JUICE_FACE), 0, cos(JUICE_FACE)) in world space. Static
            // rotation matches the kiosk facing (no billboard — it's a wall sign).
            const off = 1.51;
            plaque.position.set(JUICE[0] + Math.sin(JUICE_FACE) * off, 1.4, JUICE[1] + Math.cos(JUICE_FACE) * off);
            plaque.rotation.y = JUICE_FACE;
            plaque.name = 'tycoon-juiceshop-plaque';
            root.add(plaque);
        }
        // Upgrades now live INSIDE the grow room (SE corner desk). Anchor mirrors
        // the grow-upgrade box built in buildGrowRoom.
        const UPG = [ROOM_ORIGIN[0] + ROOM_W * 0.5 - 2.4, ROOM_ORIGIN[2] + ROOM_D * 0.5 - 2.4];
        // Gun pickup pedestal — on the player's front yard, beside the door.
        const GUN = [HOME_DOOR[0] + 1.0, HOME_DOOR[1] - 3.0];
        addBox('tycoon-gun-pedestal', [1.2, 0.6, 1.2], [GUN[0], 0.3, GUN[1]],
            flatMat('#1a1a1a', { rough: 0.4, metal: 0.6, emissive: '#444', emissiveIntensity: 0.2 }));

        root.userData.drugTycoonLevel = {
            playerSpawn: [0, 0.85, 0],
            cookStation: [COOK[0], 1.0, COOK[1]],
            seedShop: [SEED[0], 1.0, SEED[1]],   // outdoor seed-shop kiosk
            juiceShop: [JUICE[0], 1.0, JUICE[1]], // outdoor grow-juice kiosk (the "other house")
            upgradePad: [UPG[0], 1.0, UPG[1]],   // inside the grow room
            gunPickup: [GUN[0], 1.0, GUN[1]],
            streetRadius: HALF - 6,   // buyers/police wander the roads + lots
            mapHalf: HALF,            // half block size; cops spawn at this edge
            spawnY: 0,
            // Interior grow room (same level, off-map).
            homeDoor: [HOME_DOOR[0], 0.85, HOME_DOOR[1]],   // outside, enters room
            growRoomSpawn: [ROOM_ORIGIN[0], 0.85, ROOM_ORIGIN[2] + ROOM_D * 0.5 - 2],  // just inside south wall
            growExitDoor: [ROOM_ORIGIN[0], 0.85, ROOM_ORIGIN[2] + ROOM_D * 0.5 - 1],   // at south wall, back to street
            growPots: POTS,
            packagingBench: [ROOM_ORIGIN[0] + BENCH_LOCAL[0] - 1.0, 1.0, ROOM_ORIGIN[2] + BENCH_LOCAL[1]],
            // Bed (SW corner) — sleep to skip the night. Matches buildGrowRoom.
            bed: [ROOM_ORIGIN[0] - ROOM_W * 0.5 + 1.6, 1.0, ROOM_ORIGIN[2] + ROOM_D * 0.5 - 2.2],
        };

        // ---- Procedural cloudy skybox (large inverted sphere) -------------
        // Canvas texture: vertical gradient (blue → pale) + soft white cloud
        // blobs. Wraps the level so it reads as sky from any camera position.
        const skyCanvas = document.createElement('canvas');
        skyCanvas.width = 1024; skyCanvas.height = 512;
        const skyCtx = skyCanvas.getContext('2d');
        const grad = skyCtx.createLinearGradient(0, 0, 0, 512);
        grad.addColorStop(0.0, '#6fa8d6');
        grad.addColorStop(0.55, '#a7c8e0');
        grad.addColorStop(1.0, '#dde7ee');
        skyCtx.fillStyle = grad;
        skyCtx.fillRect(0, 0, 1024, 512);
        // Cloud blobs — overlapping soft white circles. Draw each cloud THREE
        // times (at cx-1024, cx, cx+1024) so blobs that straddle the seam wrap
        // around the texture cleanly — no hard line at u=0.
        const drawBlob = (cx, cy, r) => {
            const g = skyCtx.createRadialGradient(cx, cy, 0, cx, cy, r);
            g.addColorStop(0, 'rgba(255,255,255,0.85)');
            g.addColorStop(1, 'rgba(255,255,255,0)');
            skyCtx.fillStyle = g;
            skyCtx.beginPath();
            skyCtx.arc(cx, cy, r, 0, Math.PI * 2);
            skyCtx.fill();
        };
        const drawCloud = (cx, cy, scale) => {
            for (let p = 0; p < 7; p++) {
                const dx = (Math.random() - 0.5) * 90 * scale;
                const dy = (Math.random() - 0.5) * 22 * scale;
                const r = (24 + Math.random() * 26) * scale;
                const x = cx + dx, y = cy + dy;
                drawBlob(x, y, r);
                drawBlob(x - 1024, y, r);
                drawBlob(x + 1024, y, r);
            }
        };
        for (let i = 0; i < 14; i++) {
            drawCloud(Math.random() * 1024, 80 + Math.random() * 220, 0.8 + Math.random() * 0.9);
        }
        const skyTex = new THREE.CanvasTexture(skyCanvas);
        skyTex.colorSpace = THREE.SRGBColorSpace;
        skyTex.minFilter = THREE.LinearFilter;
        skyTex.magFilter = THREE.LinearFilter;
        skyTex.wrapS = THREE.RepeatWrapping;
        skyTex.wrapT = THREE.ClampToEdgeWrapping;
        skyTex.needsUpdate = true;
        const skyDome = new THREE.Mesh(
            new THREE.SphereGeometry(400, 64, 32),
            new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false }),
        );
        skyDome.name = 'tycoon-skybox';
        skyDome.renderOrder = -1;
        skyDome.userData.skipPhysicsCollision = true;
        skyDome.userData.skipLightmap = true;
        root.add(skyDome);

        // Daylight: warm sun high above lighting the whole block.
        // No shadow on the sun — point-light cubemap shadows over a large area
        // strobe with TAA + cost a lot. Day/night cycle still tints it.
        const sun = new THREE.PointLight(0xfff0d0, 14, 160, 1.2);
        sun.position.set(BLOCK * 0.25, WALL_H + 26, BLOCK * 0.2);
        sun.castShadow = false;
        sun.name = 'tycoon-sun';
        root.add(sun);
        const dayAmbient = new THREE.AmbientLight(0xc8d8ee, 0.55);
        dayAmbient.name = 'tycoon-day-ambient';
        root.add(dayAmbient);
        const dayHemi = new THREE.HemisphereLight(0xbfd6ee, 0x6a7060, 0.5);
        dayHemi.name = 'tycoon-day-hemi';
        root.add(dayHemi);

        // ---- WEED SHOP storefront wraps the home house --------------------
        // HOME = [-LOT, 0], faceY = +PI/2 so front (+Z local) = +X world.
        const SHOP_X = HOME[0];
        const SHOP_Z = HOME[1];
        const SHOP_FRONT_X = SHOP_X + 10 * 0.5 + 0.05;  // just in front of house wall
        // Dark facade panel covering the front of the home.
        const facadeMat = flatMat('#1a1410', { rough: 0.85 });
        addBox('weedshop-facade', [0.15, 6.2, 11], [SHOP_FRONT_X + 0.05, 3.1, SHOP_Z], facadeMat);
        // Bright lit storefront windows (full-height glass either side of door).
        const storefrontMat = flatMat('#6ab268', { rough: 0.25, metal: 0.1, emissive: '#3a8a48', emissiveIntensity: 0.6 });
        addBox('weedshop-window-l', [0.06, 3.0, 3.2], [SHOP_FRONT_X + 0.12, 1.7, SHOP_Z - 3.2], storefrontMat);
        addBox('weedshop-window-r', [0.06, 3.0, 3.2], [SHOP_FRONT_X + 0.12, 1.7, SHOP_Z + 3.2], storefrontMat);
        // Dark window frames between glass and facade.
        const frameMat = flatMat('#0a0806', { rough: 0.7 });
        addBox('weedshop-frame-top', [0.18, 0.2, 11], [SHOP_FRONT_X + 0.08, 3.3, SHOP_Z], frameMat);
        addBox('weedshop-frame-bot', [0.18, 0.2, 11], [SHOP_FRONT_X + 0.08, 0.15, SHOP_Z], frameMat);
        // Door (open) — dark recess with warm interior glow behind.
        const doorRecessMat = flatMat('#3a2818', { rough: 0.6, emissive: '#ffb060', emissiveIntensity: 1.4 });
        addBox('weedshop-door', [0.06, 2.6, 1.6], [SHOP_FRONT_X + 0.13, 1.3, SHOP_Z], doorRecessMat);
        // Interior point light spilling out through windows + door.
        const shopInterior = new THREE.PointLight(0xfff0c8, 6, 10, 1.5);
        shopInterior.position.set(SHOP_FRONT_X - 1.5, 2.2, SHOP_Z);
        shopInterior.name = 'weedshop-interior';
        root.add(shopInterior);
        // Big neon "WEED SHOP" sign — bright green emissive panel above windows.
        const signBgMat = flatMat('#0a1a0a', { rough: 0.6 });
        addBox('weedshop-sign-bg', [0.18, 1.5, 8.5], [SHOP_FRONT_X + 0.1, 4.6, SHOP_Z], signBgMat);
        // Text sign reads "WEED SHOP". Plane faces +X (out from front of shop).
        const weedSignMesh = makeSignMesh('WEED SHOP', {
            width: 7.5, height: 1.1, fg: '#9dffa0', bg: '#0a2410',
        });
        weedSignMesh.position.set(SHOP_FRONT_X + 0.5, 4.6, SHOP_Z);
        weedSignMesh.rotation.y = Math.PI * 0.5;  // face +X
        weedSignMesh.name = 'weedshop-sign-text';
        root.add(weedSignMesh);
        // Leaf icon (smaller bright square left of sign).
        const shopLeafMat = flatMat('#5ce05a', { rough: 0.35, emissive: '#6ce06a', emissiveIntensity: 1.6 });
        addBox('weedshop-leaf', [0.08, 0.9, 0.9], [SHOP_FRONT_X + 0.22, 4.6, SHOP_Z - 3.2], shopLeafMat);
        // Two area lights wash the sign + spill onto the sidewalk.
        const signLight1 = new THREE.PointLight(0x6cff7a, 4, 14, 1.6);
        signLight1.position.set(SHOP_FRONT_X + 2.0, 4.6, SHOP_Z - 2);
        signLight1.name = 'weedshop-sign-light-1';
        root.add(signLight1);
        const signLight2 = new THREE.PointLight(0x6cff7a, 4, 14, 1.6);
        signLight2.position.set(SHOP_FRONT_X + 2.0, 4.6, SHOP_Z + 2);
        signLight2.name = 'weedshop-sign-light-2';
        root.add(signLight2);
        // Ground spill — small green glow pool at shop entrance.
        const spillLight = new THREE.PointLight(0x5cff8a, 2.5, 7, 1.8);
        spillLight.position.set(SHOP_FRONT_X + 2.5, 0.4, SHOP_Z);
        spillLight.name = 'weedshop-spill';
        root.add(spillLight);

        // ---- Palm trees along sidewalks ----------------------------------
        const palmTrunkMat = flatMat('#3a2a1a', { rough: 0.95 });
        const palmFrondMat = flatMat('#2f5a2a', { rough: 0.9, emissive: '#1a3a18', emissiveIntensity: 0.2 });
        const addPalm = (px, pz) => {
            const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 4.2, 8), palmTrunkMat);
            trunk.position.set(px, 2.1, pz);
            trunk.castShadow = true; trunk.receiveShadow = true;
            trunk.name = `tycoon-palm-trunk-${px}-${pz}`;
            root.add(trunk);
            // Fronds: 6 stretched boxes radiating from top.
            for (let f = 0; f < 6; f++) {
                const ang = (f / 6) * Math.PI * 2;
                const frond = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.08, 0.6), palmFrondMat);
                frond.position.set(px + Math.cos(ang) * 1.1, 4.2, pz + Math.sin(ang) * 1.1);
                frond.rotation.set(0, -ang, -0.25);
                frond.castShadow = true;
                root.add(frond);
            }
        };
        // Place palms at sidewalk edges, spaced along the N-S road.
        [-28, -14, 14, 28].forEach((pz) => {
            addPalm(-(ROAD_W * 0.5 + SW + 0.6), pz);
            addPalm(  ROAD_W * 0.5 + SW + 0.6, pz);
        });

        // ---- Street lamps along the roads (warm pools) -------------------
        const lampPoleMat = flatMat('#2a2a2e', { rough: 0.6, metal: 0.5 });
        const lampHeadMat = flatMat('#ffe0a0', { rough: 0.4, emissive: '#ffd070', emissiveIntensity: 1.2 });
        const addLamp = (lx, lz) => {
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 4.0, 8), lampPoleMat);
            pole.position.set(lx, 2.0, lz);
            pole.castShadow = true;
            root.add(pole);
            const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.25, 0.5), lampHeadMat);
            head.position.set(lx, 4.05, lz);
            root.add(head);
            const lampLight = new THREE.PointLight(0xffd090, 4, 10, 1.6);
            lampLight.position.set(lx, 3.9, lz);
            lampLight.name = `tycoon-lamp-${lx}-${lz}`;
            root.add(lampLight);
        };
        [-22, 0, 22].forEach((lz) => {
            addLamp(-(ROAD_W * 0.5 + SW + 0.4), lz);
            addLamp(  ROAD_W * 0.5 + SW + 0.4, lz);
        });

        applySilPomLighting(root, sun.position.clone());
        return root;
    }

    // Shooting Simulator level: an indoor firing-range bay. A long hall with a
    // firing line near the player and a row of target stands downrange. The game
    // loop (scoring, target reactions, time-attack) lives in the self-contained
    // shootingSim module; this just builds geometry + the lane layout contract.
    function createShootingSimLevel() {
        const root = new THREE.Group();
        root.name = 'PolyFlow_Shooting_Sim';
        root.userData.sampleType = 'shootingSim';
        root.userData.hideTerrainPresentation = true;
        root.userData.skipNormalization = true;

        const HALL_W = 22;       // width across the lanes
        const HALL_L = 60;       // length downrange (player at +Z end, targets at -Z)
        const WALL_H = 6.0;
        const T = 0.4;

        root.userData.preferredSpawn = { position: [0, 0.3, HALL_L * 0.5 - 4], yaw: Math.PI, pitch: -0.02 };
        root.userData.preferredShowcase = {
            position: [0, PLAYER_SETTINGS.eyeHeight + 1.0, HALL_L * 0.5 - 2],
            target: [0, 1.4, -HALL_L * 0.3],
        };

        const mat = (color, { rough = 0.9, metal = 0.0, emissive = null, emissiveIntensity = 0, envIntensity = 1.0 } = {}) => {
            const m = new DDGIMeshStandardNodeMaterial({ color: new THREE.Color(color), roughness: rough, metalness: metal });
            if (emissive) { m.emissive = new THREE.Color(emissive); m.emissiveIntensity = emissiveIntensity; }
            if ('envMapIntensity' in m) m.envMapIntensity = envIntensity;
            return m;
        };
        const addBox = (name, size, position, material, { actorSurface = '', solid = false, rotY = 0 } = {}) => {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
            mesh.name = name;
            mesh.position.set(position[0], position[1], position[2]);
            if (rotY) mesh.rotation.y = rotY;
            mesh.castShadow = true; mesh.receiveShadow = true;
            root.add(mesh);
            if (actorSurface || solid) {
                const actor = makeSampleLevelMeshActor(name, mesh, {
                    kind: 'imported', castShadow: true, receiveShadow: true, skipPhysicsCollision: true,
                    userData: actorSurface ? { doomMapSurface: actorSurface } : {},
                });
                if (solid || actorSurface === 'floor' || actorSurface === 'roof') enableStaticMeshActorCollision(actor);
            }
            return mesh;
        };

        // ---- materials, tuned for the new post stack -------------------
        // SSR rewards low roughness + a touch of metalness → a polished epoxy
        // floor that mirrors the lights/targets. SSAO rewards crevices → trims,
        // baseboards, coves. Bloom rewards HDR emissives → punchy strip lights +
        // neon accents (emissiveIntensity well above 1 so they cross threshold).
        const floorMat = mat('#2a2f38', { rough: 0.12, metal: 0.35, envIntensity: 0.18 }); // wet/polished — strong SSR
        const wallMat  = mat('#262b33', { rough: 0.85 });
        const wallAccentMat = mat('#171a20', { rough: 0.7, metal: 0.15 });    // darker recessed panels
        const baseMat  = mat('#15181d', { rough: 0.6, metal: 0.25 });         // glossy baseboard (catches reflections)
        const pillarMat = mat('#33373f', { rough: 0.45, metal: 0.3 });        // semi-gloss pillars → reflect
        const trimMat  = mat('#ffd24a', { rough: 0.35, emissive: '#ffd24a', emissiveIntensity: 1.1 });   // gently bloom-bright
        const benchMat = mat('#2b3038', { rough: 0.4, metal: 0.45 });         // brushed metal bench
        const ceilMat  = mat('#101319', { rough: 0.9 });
        const lampMat  = mat('#ffffff', { rough: 0.3, emissive: '#fff4e6', emissiveIntensity: 1.5 });    // tubes — just over bloom threshold
        const neonCyan = mat('#9fefff', { rough: 0.3, emissive: '#3fd0ff', emissiveIntensity: 1.4 });
        const neonRed  = mat('#ff6b6b', { rough: 0.3, emissive: '#ff3a3a', emissiveIntensity: 1.6 });
        const mirrorMat = mat('#dbeafe', { rough: 0.025, metal: 1.0, envIntensity: 0.03 });
        const blackMirrorMat = mat('#080d16', { rough: 0.035, metal: 0.95, envIntensity: 0.02 });
        const chromeMat = mat('#f1f5f9', { rough: 0.045, metal: 1.0, envIntensity: 0.03 });
        const neonPink = mat('#ff9cf3', { rough: 0.25, emissive: '#ff35d4', emissiveIntensity: 1.8 });
        const neonGreen = mat('#bbf7d0', { rough: 0.25, emissive: '#4cff9a', emissiveIntensity: 1.7 });
        const railMat  = mat('#3a4049', { rough: 0.3, metal: 0.6 });          // chrome-ish rails → SSR

        // ---- shell: floor, ceiling, four walls ----
        addBox('shootsim-floor', [HALL_W, T, HALL_L], [0, -T * 0.5, 0], floorMat, { actorSurface: 'floor' });
        addBox('shootsim-ceil', [HALL_W, T, HALL_L], [0, WALL_H, 0], ceilMat, { actorSurface: 'roof' });
        addBox('shootsim-wall-back', [HALL_W, WALL_H, T], [0, WALL_H * 0.5, -HALL_L * 0.5], wallMat, { solid: true });
        addBox('shootsim-wall-front', [HALL_W, WALL_H, T], [0, WALL_H * 0.5, HALL_L * 0.5], wallMat, { solid: true });
        addBox('shootsim-wall-l', [T, WALL_H, HALL_L], [-HALL_W * 0.5, WALL_H * 0.5, 0], wallMat, { solid: true });
        addBox('shootsim-wall-r', [T, WALL_H, HALL_L], [HALL_W * 0.5, WALL_H * 0.5, 0], wallMat, { solid: true });

        // Glossy baseboards along both side walls — give SSAO a contact crease
        // and SSR a low strip to reflect the floor lights.
        for (const sx of [-1, 1]) {
            addBox(`shootsim-base-${sx}`, [0.3, 0.5, HALL_L], [sx * (HALL_W * 0.5 - 0.15), 0.25, 0], baseMat);
            // Recessed wall panels (depth for SSAO + darker reflection breakup).
            for (let z = -HALL_L * 0.5 + 6; z < HALL_L * 0.5; z += 8) {
                addBox(`shootsim-panel-${sx}-${z}`, [0.12, WALL_H - 2.2, 4.6], [sx * (HALL_W * 0.5 - 0.12), WALL_H * 0.5, z], wallAccentMat);
            }
        }

        // Structural pillars down both sides — depth + AO + SSR catchers.
        for (const sx of [-1, 1]) {
            for (let z = -HALL_L * 0.5 + 8; z < HALL_L * 0.5 - 4; z += 12) {
                addBox(`shootsim-pillar-${sx}-${z}`, [0.9, WALL_H, 0.9], [sx * (HALL_W * 0.5 - 0.7), WALL_H * 0.5, z], pillarMat, { solid: true });
                // Cyan neon strip up each pillar — vertical bloom accents.
                addBox(`shootsim-pillar-neon-${sx}-${z}`, [0.14, WALL_H - 1.4, 0.14], [sx * (HALL_W * 0.5 - 1.18), WALL_H * 0.5, z], neonCyan);
            }
        }

        // Downrange backstop: angled, with rubber-baffle look + a glowing red
        // "RANGE HOT" bar so there's HDR colour at the far end for bloom + SSR.
        addBox('shootsim-backstop', [HALL_W - 0.6, WALL_H - 1.0, 0.5], [0, (WALL_H - 1.0) * 0.5, -HALL_L * 0.5 + 0.5], mat('#101216', { rough: 1.0 }));
        addBox('shootsim-hotbar', [HALL_W - 3, 0.5, 0.2], [0, WALL_H - 1.1, -HALL_L * 0.5 + 0.85], neonRed);

        const LANES = 5;
        const laneSpacing = (HALL_W - 4) / (LANES - 1);
        const laneXs = [];
        for (let i = 0; i < LANES; i++) laneXs.push(-((HALL_W - 4) / 2) + i * laneSpacing);
        for (let i = 0; i < LANES; i++) {
            const lx = laneXs[i];
            // Chrome divider rail between firing positions (offset to the left of
            // each lane), reflective for SSR.
            if (i > 0) {
                addBox(`shootsim-rail-${i}`, [0.1, 1.05, HALL_L * 0.5], [lx - laneSpacing * 0.5, 0.52, HALL_L * 0.08], railMat, { solid: true });
            }
            // Glowing lane-number puck set into the floor at each firing position.
            addBox(`shootsim-lanemark-${i}`, [0.5, 0.04, 0.5], [lx, 0.03, HALL_L * 0.5 - 6.2], neonCyan);
        }

        // ---- firing line: brushed-metal bench + glowing line ----
        const lineZ = HALL_L * 0.5 - 8;
        addBox('shootsim-bench', [HALL_W - 2, 1.0, 1.0], [0, 0.5, lineZ], benchMat, { solid: true });
        addBox('shootsim-bench-trim', [HALL_W - 2, 0.12, 1.06], [0, 1.03, lineZ], trimMat);
        addBox('shootsim-line', [HALL_W - 1, 0.04, 0.22], [0, 0.03, lineZ + 1.4], trimMat);   // glowing "do not cross" line

        // ---- SSR calibration bay ---------------------------------------
        // Keep reflectors and reflected objects on-screen together: this makes
        // SSR limits, edge fading, and roughness blur obvious while testing.
        const ssrZ = lineZ - 4.0;
        const ssrX = HALL_W * 0.5 - 2.0;
        addBox('shootsim-ssr-pad', [4.8, 0.05, 5.8], [ssrX, 0.055, ssrZ], blackMirrorMat);
        addBox('shootsim-ssr-mirror', [0.08, 2.8, 5.4], [HALL_W * 0.5 - 0.26, 1.75, ssrZ], mirrorMat);
        addBox('shootsim-ssr-neon-cyan', [0.12, 0.18, 4.6], [HALL_W * 0.5 - 0.72, 2.55, ssrZ], neonCyan);
        addBox('shootsim-ssr-neon-pink', [0.12, 0.18, 4.6], [HALL_W * 0.5 - 0.72, 1.75, ssrZ], neonPink);
        addBox('shootsim-ssr-neon-green', [0.12, 0.18, 4.6], [HALL_W * 0.5 - 0.72, 0.95, ssrZ], neonGreen);
        for (let i = 0; i < 3; i++) {
            const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.42 - i * 0.06, 32, 18), chromeMat);
            sphere.name = `shootsim-ssr-chrome-sphere-${i}`;
            sphere.position.set(ssrX - 1.25 + i * 1.15, 0.5 + i * 0.18, ssrZ + 1.25 - i * 1.15);
            sphere.castShadow = true;
            sphere.receiveShadow = true;
            root.add(sphere);
        }
        addBox('shootsim-ssr-white-card', [1.25, 1.0, 0.06], [ssrX - 1.8, 1.0, ssrZ - 2.3], lampMat);
        addBox('shootsim-ssr-dark-card', [1.25, 1.0, 0.06], [ssrX + 1.8, 1.0, ssrZ - 2.3], wallAccentMat);

        // ---- ceiling: recessed cove + bright tube lights (bloom + SSR) ----
        // A dark recessed channel so the bright tubes sit in shadow (AO/contrast),
        // and each tube is HDR-bright so it blooms + reflects in the epoxy floor.
        for (let z = -HALL_L * 0.42; z <= HALL_L * 0.42; z += 7.5) {
            addBox(`shootsim-cove-${z}`, [HALL_W - 5, 0.4, 2.0], [0, WALL_H - 0.02, z], ceilMat);
            addBox(`shootsim-lamp-${z}`, [HALL_W - 7, 0.12, 1.1], [0, WALL_H - 0.32, z], lampMat);
            const lp = new THREE.PointLight(0xfff6ec, 3.2, 26, 1.7);   // cooler + dimmer so the bay isn't flooded warm
            lp.position.set(0, WALL_H - 0.8, z);
            lp.castShadow = false;
            lp.name = `shootsim-light-${z}`;
            root.add(lp);
        }

        // ---- target spotlights: a focused warm spot per lane onto the targets,
        // so targets are dramatically lit (CSM-style cone shadows + crisp SSAO).
        const lanes = laneXs.map((lx, i) => [lx, 0, -HALL_L * 0.5 + 6 + (i % 2) * 4]);
        lanes.forEach(([lx, , lz], i) => {
            const sp = new THREE.SpotLight(0xfff0d8, 4.5, 24, Math.PI / 7, 0.4, 1.6);
            sp.position.set(lx, WALL_H - 0.8, lz + 5);
            sp.target.position.set(lx, 1.4, lz);
            sp.castShadow = i < 2;   // a couple cast real shadows; light-cull/clustered handles the rest
            if (sp.castShadow) configurePointLightShadow(sp);
            sp.name = `shootsim-spot-${i}`;
            root.add(sp);
            root.add(sp.target);
        });

        // ---- lane layout contract (unchanged — gameplay module reads this) ----
        root.userData.shootingSimLevel = {
            playerSpawn: [0, 0.85, lineZ + 2.2],
            firingLineZ: lineZ,
            lanes,
            hallWidth: HALL_W,
            hallLength: HALL_L,
        };

        // Cool ambient fill so shadowed areas read blue-grey (contrast vs warm
        // tubes), kept low so SSAO + spot pools stay punchy.
        const amb = new THREE.AmbientLight(0x8a9bc0, 0.35);
        root.add(amb);
        const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x14171c, 0.4);
        root.add(hemi);
        const key = new THREE.PointLight(0xffffff, 3, 70, 1.4);
        key.position.set(0, WALL_H - 0.5, lineZ);
        key.castShadow = true;
        configurePointLightShadow(key);
        key.name = 'shootsim-key';
        root.add(key);

        applySilPomLighting(root, key.position.clone());
        return root;
    }

    // Shared afterLoad for any Rogue Waves arena (doomArena + roguePit). Spawns
    // the player start, hidden exit teleporter, and the invisible game-mode actor
    // that drives waves/HUD/death.
    function rogueArenaAfterLoad() {
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
            started: false,
            weaponPromptShown: false,
        };
        resetRogueState();

        const gm = spawnGameplayPrefab('rogueGameMode');
        if (gm) gm.userData.label = 'Rogue Game Mode';
        cm().userData.rogueGameModeActorId = gm?.id || '';

        try { applyShowcaseGraphics?.({ indoor: true, sun: false, ambient: true, hemi: false }); } catch (e) {}
        return null;
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
                // No auto gun pickup — the player picks a weapon from a card when
                // they step off the start pad. Wave flow lives in the attached
                // game-mode script; afterLoad just wires the shared actors.
                afterLoad: rogueArenaAfterLoad,
            };
        }

        if (levelId === 'drugTycoon') {
            return {
                id: 'drugTycoon',
                assetName: 'Drug Tycoon',
                fileSize: 280000,
                create: createDrugTycoonLevel,
                afterLoad: () => {
                    const layout = cm()?.userData?.drugTycoonLevel || {};
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
                    // Fresh economy each load. The module owns its own state.
                    try { window.drugTycoonApi?.resetState?.(); } catch (e) {}
                    return null;
                },
            };
        }

        if (levelId === 'shootingSim') {
            return {
                id: 'shootingSim',
                assetName: 'Shooting Simulator',
                fileSize: 180000,
                create: createShootingSimLevel,
                afterLoad: () => {
                    const layout = cm()?.userData?.shootingSimLevel || {};
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
                    // Fresh range each load. The module owns its own state.
                    try { window.shootingSimApi?.resetState?.(); } catch (e) {}
                    // Showcase scene: switch on the full post stack (SSR + TAA +
                    // SSAO + bloom) so the range shows the renderer at its best.
                    try { applyShowcaseGraphics?.({ indoor: true, globalLights: false }); } catch (e) {}
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
        createRoguePitLevel, createDrugTycoonLevel, createShootingSimLevel, getBuiltinLevelDefinition,
    };
}
