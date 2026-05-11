import * as THREE from 'three';

const VEHICLE_LIGHT_NAME_RE = /(head|tail|brake|reverse|signal|indicator|turn|lamp|light|emiss)/i;

function boostVehicleLightMaterial(node, material) {
    if (!material) return;
    const text = `${node?.name || ''} ${material.name || ''}`;
    const hasEmissive = !!material.emissive
        && (material.emissive.r > 0.01 || material.emissive.g > 0.01 || material.emissive.b > 0.01);
    if (!VEHICLE_LIGHT_NAME_RE.test(text) && !hasEmissive && !material.emissiveMap) return;

    const rear = /(tail|brake|rear|stop)/i.test(text);
    const signal = /(signal|indicator|turn|amber|orange)/i.test(text);
    const lightColor = new THREE.Color(signal ? 0xff9a2a : (rear ? 0xff1f1f : 0xfff1c4));
    material.emissive?.copy(lightColor);
    material.emissiveIntensity = Math.max(material.emissiveIntensity ?? 0, rear ? 4.5 : 6.0);
    material.toneMapped = false;
    material.needsUpdate = true;
}

export function createVehicleWheelAssembly({ tireMaterial, rimMaterial, wheelRadius, wheelWidth, wheelTemplate = null, mirrorX = false, cloneDisposableObject }) {
    const steeringPivot = new THREE.Group();
    const spinGroup = new THREE.Group();
    steeringPivot.userData.vehicleSteeringPivot = true;
    spinGroup.userData.vehicleSpinGroup = true;

    if (wheelTemplate?.root) {
        const customWheel = cloneDisposableObject(wheelTemplate.root);
        const bbox = new THREE.Box3().setFromObject(customWheel);
        const size = bbox.getSize(new THREE.Vector3());
        const center = bbox.getCenter(new THREE.Vector3());

        const axes = [
            { axis: 'x', size: size.x },
            { axis: 'y', size: size.y },
            { axis: 'z', size: size.z },
        ].sort((a, b) => a.size - b.size);
        const axleAxis = axes[0].axis;
        const diameter = Math.max(axes[1].size, axes[2].size);
        const targetDiameter = wheelRadius * 2.0;
        const fit = diameter > 1e-4 ? targetDiameter / diameter : 1;

        const orienter = new THREE.Group();
        customWheel.position.set(-center.x, -center.y, -center.z);
        orienter.add(customWheel);
        if (axleAxis === 'y') {
            orienter.rotation.z = Math.PI * 0.5;
        } else if (axleAxis === 'z') {
            orienter.rotation.y = Math.PI * 0.5;
        }
        orienter.scale.setScalar(fit);
        if (mirrorX) {
            orienter.scale.x *= -1;
        }
        customWheel.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow = true;
            child.receiveShadow = true;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((mat) => {
                if (!mat) return;
                mat.side = THREE.DoubleSide;
                mat.needsUpdate = true;
            });
        });
        spinGroup.add(orienter);
        steeringPivot.add(spinGroup);
        return { steeringPivot, spinGroup };
    }

    const wheelMesh = new THREE.Group();
    wheelMesh.rotation.z = Math.PI * 0.5;

    const tire = new THREE.Mesh(
        new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 24, 1),
        tireMaterial
    );
    tire.castShadow = true;
    tire.receiveShadow = true;
    wheelMesh.add(tire);

    const innerRim = new THREE.Mesh(
        new THREE.CylinderGeometry(wheelRadius * 0.65, wheelRadius * 0.65, wheelWidth * 1.05, 18, 1),
        new THREE.MeshStandardMaterial({
            color: 0x111111,
            roughness: 0.9,
            metalness: 0.1
        })
    );
    wheelMesh.add(innerRim);

    const spokeSize = wheelRadius * 1.35;
    const spoke1 = new THREE.Mesh(
        new THREE.BoxGeometry(spokeSize, wheelWidth * 1.1, wheelRadius * 0.25),
        rimMaterial
    );
    spoke1.castShadow = true;
    wheelMesh.add(spoke1);

    const spoke2 = new THREE.Mesh(
        new THREE.BoxGeometry(wheelRadius * 0.25, wheelWidth * 1.1, spokeSize),
        rimMaterial
    );
    spoke2.castShadow = true;
    wheelMesh.add(spoke2);

    const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(wheelRadius * 0.2, wheelRadius * 0.2, wheelWidth * 1.15, 14, 1),
        rimMaterial
    );
    wheelMesh.add(hub);

    spinGroup.add(wheelMesh);
    steeringPivot.add(spinGroup);

    return { steeringPivot, spinGroup };
}

export function createDrivableCarVisual({ bodyTemplateId = '', wheelTemplateId = '', vehicleSettings, importedPropState, cloneDisposableObject }) {
    const root = new THREE.Group();
    const W = vehicleSettings.width;
    const L = vehicleSettings.length;
    const H = vehicleSettings.height;

    const visualGroup = new THREE.Group();
    visualGroup.position.y = H * 0.08;
    visualGroup.rotation.y = Math.PI;
    root.add(visualGroup);

    const tireMaterial = new THREE.MeshStandardMaterial({
        color: 0x17191d, metalness: 0.02, roughness: 0.92,
    });
    const rimMaterial = new THREE.MeshStandardMaterial({
        color: 0xc5ccd6, metalness: 0.86, roughness: 0.24,
    });

    const bodyTemplate = bodyTemplateId
        ? importedPropState.templates.find((entry) => entry.id === bodyTemplateId)
        : null;
    const wheelTemplate = wheelTemplateId
        ? importedPropState.templates.find((entry) => entry.id === wheelTemplateId)
        : null;

    const usingCustomBody = !!bodyTemplate?.root;

    if (usingCustomBody) {
        const customBody = cloneDisposableObject(bodyTemplate.root);
        const bbox = new THREE.Box3().setFromObject(customBody);
        const size = bbox.getSize(new THREE.Vector3());
        const center = bbox.getCenter(new THREE.Vector3());
        const targetW = W * 1.0;
        const targetL = L * 1.0;
        const sx = size.x > 1e-4 ? targetW / size.x : 1;
        const sz = size.z > 1e-4 ? targetL / size.z : 1;
        const fit = Math.min(sx, sz);
        customBody.scale.setScalar(fit);
        const groundLocal = -H * 0.5 - H * 0.28;
        customBody.position.set(
            -center.x * fit,
            groundLocal - bbox.min.y * fit,
            -center.z * fit - L * -0.04
        );
        customBody.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow = true;
            child.receiveShadow = true;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((mat) => {
                if (!mat) return;
                mat.side = THREE.DoubleSide;
                boostVehicleLightMaterial(child, mat);
                mat.needsUpdate = true;
            });
        });
        visualGroup.add(customBody);
    } else {
        const bodyMaterial = new THREE.MeshStandardMaterial({
            color: 0xf7f7f5, metalness: 0.18, roughness: 0.34,
        });
        const trimMaterial = new THREE.MeshStandardMaterial({
            color: 0x15171b, metalness: 0.42, roughness: 0.48,
        });
        const glassMaterial = new THREE.MeshStandardMaterial({
            color: 0xdce8f5, metalness: 0.08, roughness: 0.16, transparent: true, opacity: 0.72,
        });
        const lightMaterial = new THREE.MeshStandardMaterial({
            color: 0xf8f1d0, emissive: 0xfff1c4, emissiveIntensity: 6.0, roughness: 0.28, metalness: 0.02, fog: false, toneMapped: false,
        });

        const lowerBody = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.96, H * 0.38, L * 0.94),
            bodyMaterial
        );
        lowerBody.position.y = -H * 0.08;
        lowerBody.castShadow = true;
        lowerBody.receiveShadow = true;
        visualGroup.add(lowerBody);

        const cabin = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.72, H * 0.32, L * 0.38),
            glassMaterial
        );
        cabin.position.set(0, H * 0.22, -L * 0.06);
        cabin.castShadow = true;
        visualGroup.add(cabin);

        const roof = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.68, H * 0.06, L * 0.32),
            bodyMaterial
        );
        roof.position.set(0, H * 0.39, -L * 0.06);
        roof.castShadow = true;
        visualGroup.add(roof);

        const hood = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.88, H * 0.1, L * 0.28),
            bodyMaterial
        );
        hood.position.set(0, H * 0.06, L * 0.30);
        hood.rotation.x = -0.06;
        hood.castShadow = true;
        hood.receiveShadow = true;
        visualGroup.add(hood);

        const trunk = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.84, H * 0.1, L * 0.18),
            bodyMaterial
        );
        trunk.position.set(0, H * 0.06, -L * 0.36);
        trunk.rotation.x = 0.04;
        trunk.castShadow = true;
        visualGroup.add(trunk);

        const frontBumper = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.92, H * 0.12, L * 0.06),
            trimMaterial
        );
        frontBumper.position.set(0, -H * 0.16, L * 0.48);
        frontBumper.castShadow = true;
        visualGroup.add(frontBumper);

        const rearBumper = frontBumper.clone();
        rearBumper.position.z = -L * 0.48;
        visualGroup.add(rearBumper);

        const skirtLeft = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.04, H * 0.1, L * 0.7),
            trimMaterial
        );
        skirtLeft.position.set(-W * 0.48, -H * 0.2, 0);
        visualGroup.add(skirtLeft);
        const skirtRight = skirtLeft.clone();
        skirtRight.position.x *= -1;
        visualGroup.add(skirtRight);

        const grille = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.5, H * 0.1, L * 0.03),
            trimMaterial
        );
        grille.position.set(0, -H * 0.02, L * 0.49);
        visualGroup.add(grille);

        const headlightLeft = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.14, H * 0.06, L * 0.02),
            lightMaterial
        );
        headlightLeft.position.set(-W * 0.32, H * 0.02, L * 0.49);
        const headlightRight = headlightLeft.clone();
        headlightRight.position.x *= -1;
        visualGroup.add(headlightLeft, headlightRight);

        const taillightMat = new THREE.MeshStandardMaterial({
            color: 0xff2222, emissive: 0xff1f1f, emissiveIntensity: 4.5, roughness: 0.3, metalness: 0.02, fog: false, toneMapped: false,
        });
        const taillightLeft = new THREE.Mesh(
            new THREE.BoxGeometry(W * 0.12, H * 0.05, L * 0.02),
            taillightMat
        );
        taillightLeft.position.set(-W * 0.34, H * 0.02, -L * 0.49);
        const taillightRight = taillightLeft.clone();
        taillightRight.position.x *= -1;
        visualGroup.add(taillightLeft, taillightRight);
    }

    const wheelRadius = usingCustomBody ? H * 0.62 : H * 0.36;
    const wheelWidth = W * 0.16;
    const wheelY = usingCustomBody ? (-H * 0.78 + wheelRadius + H * 0.55) : -H * 0.42;
    const halfWheelBase = vehicleSettings.wheelBase * (usingCustomBody ? 0.86 : 0.5);
    const halfTrackWidth = vehicleSettings.trackWidth * (usingCustomBody ? 0.72 : 0.45);
    const wheelOffsets = [
        { x: -halfTrackWidth, z: halfWheelBase, steerable: true },
        { x: halfTrackWidth, z: halfWheelBase, steerable: true },
        { x: -halfTrackWidth, z: -halfWheelBase, steerable: false },
        { x: halfTrackWidth, z: -halfWheelBase, steerable: false },
    ];
    const steeringPivots = [];
    const spinGroups = [];

    const usingCustomWheels = !!wheelTemplate?.root;
    wheelOffsets.forEach((offset) => {
        const wheel = createVehicleWheelAssembly({
            tireMaterial,
            rimMaterial,
            wheelRadius,
            wheelWidth,
            wheelTemplate,
            mirrorX: offset.x < 0,
            cloneDisposableObject,
        });
        wheel.steeringPivot.position.set(offset.x, wheelY, offset.z);
        wheel.steeringPivot.userData.steerable = offset.steerable;
        if (usingCustomBody && !usingCustomWheels) {
            wheel.steeringPivot.visible = false;
        }
        visualGroup.add(wheel.steeringPivot);
        steeringPivots.push(wheel.steeringPivot);
        spinGroups.push(wheel.spinGroup);
    });

    visualGroup.traverse((object) => {
        if (!object.isMesh) return;
        object.castShadow = true;
        object.receiveShadow = true;
    });

    root.userData.vehicleVisual = {
        steeringPivots,
        spinGroups,
        wheelRadius,
        maxSteerAngle: 1.0,
        steerAngle: 0,
        spinAngle: 0,
        lastWorldPosition: new THREE.Vector3(),
        lastPositionInitialized: false,
    };

    return root;
}
