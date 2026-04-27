import * as THREE from 'three';

export const RUNTIME_COMPONENT_KEYS = {
    render: 'render',
    physicsBody: 'physicsBody',
    scripts: 'scripts',
    metadata: 'metadata',
};

export function getActorComponent(actor, key) {
    if (!actor?.entity) return null;
    return actor.entity.getComponent(key);
}

export function getRenderComponent(actor) {
    return getActorComponent(actor, RUNTIME_COMPONENT_KEYS.render);
}

export function getPhysicsBodyComponent(actor) {
    return getActorComponent(actor, RUNTIME_COMPONENT_KEYS.physicsBody);
}

export function getScriptComponent(actor) {
    return getActorComponent(actor, RUNTIME_COMPONENT_KEYS.scripts);
}

export function getMetadataComponent(actor) {
    return getActorComponent(actor, RUNTIME_COMPONENT_KEYS.metadata);
}

export class Entity {
    constructor(id = '') {
        this.id = id;
        this.components = new Map();
    }

    setComponent(key, value) {
        if (value === undefined) {
            this.components.delete(key);
            return this;
        }

        this.components.set(key, value);
        return this;
    }

    getComponent(key) {
        return this.components.get(key) ?? null;
    }

    removeComponent(key) {
        this.components.delete(key);
        return this;
    }
}

export class SceneNode {
    constructor(name = 'Node', object3D = null) {
        this.name = name;
        this.parent = null;
        this.children = [];
        this.object3D = object3D ?? new THREE.Group();
        this.object3D.name = this.object3D.name || name;
        this.object3D.userData.sceneNodeName = name;
    }

    setObject3D(nextObject3D) {
        const previousObject3D = this.object3D;
        if (previousObject3D === nextObject3D) {
            return previousObject3D;
        }

        const attachedParent = previousObject3D?.parent ?? null;
        if (attachedParent && previousObject3D) {
            attachedParent.remove(previousObject3D);
        }

        this.object3D = nextObject3D ?? new THREE.Group();
        this.object3D.name = this.object3D.name || this.name;
        this.object3D.userData.sceneNodeName = this.name;

        if (attachedParent) {
            attachedParent.add(this.object3D);
        }

        return previousObject3D;
    }

    addChild(node) {
        if (!node || node === this || this.children.includes(node)) return node;

        node.removeFromParent();
        this.children.push(node);
        node.parent = this;
        this.object3D.add(node.object3D);
        return node;
    }

    removeChild(node) {
        const childIndex = this.children.indexOf(node);
        if (childIndex === -1) return node;

        this.children.splice(childIndex, 1);
        if (node.object3D.parent === this.object3D) {
            this.object3D.remove(node.object3D);
        }
        node.parent = null;
        return node;
    }

    removeFromParent() {
        if (this.parent) {
            this.parent.removeChild(this);
            return this;
        }

        if (this.object3D.parent) {
            this.object3D.parent.remove(this.object3D);
        }

        return this;
    }
}

export function createRenderComponent(mesh = null) {
    return { mesh };
}

export function createPhysicsBodyComponent(body = null) {
    return { body };
}

export function createScriptComponent(state = null) {
    return { state };
}

export function createMetadataComponent({ kind = 'actor', templateId = '', userData = null } = {}) {
    return {
        kind,
        templateId,
        userData: userData ?? {},
    };
}

export class Actor {
    constructor({
        id = '',
        name = 'Actor',
        kind = 'actor',
        mesh = null,
        body = null,
        scripts = null,
        templateId = '',
        userData = null,
    } = {}) {
        this.entity = new Entity(id);
        this.rootNode = new SceneNode(name, mesh);
        this.sceneSystem = null;

        this.entity.setComponent(RUNTIME_COMPONENT_KEYS.render, createRenderComponent(mesh));
        this.entity.setComponent(RUNTIME_COMPONENT_KEYS.physicsBody, createPhysicsBodyComponent(body));
        this.entity.setComponent(RUNTIME_COMPONENT_KEYS.scripts, createScriptComponent(scripts));

        const meshUserData = mesh?.userData ?? null;
        const nextUserData = meshUserData
            ? Object.assign(meshUserData, userData ?? {})
            : (userData ?? {});

        this.entity.setComponent(
            RUNTIME_COMPONENT_KEYS.metadata,
            createMetadataComponent({
                kind,
                templateId,
                userData: nextUserData,
            })
        );

        if (mesh && nextUserData !== mesh.userData) {
            mesh.userData = nextUserData;
        }
    }

    get id() {
        return this.entity.id;
    }

    set id(value) {
        this.entity.id = value;
    }

    get mesh() {
        return this.entity.getComponent(RUNTIME_COMPONENT_KEYS.render)?.mesh ?? null;
    }

    set mesh(value) {
        const renderComponent = this.entity.getComponent(RUNTIME_COMPONENT_KEYS.render);
        const previousMesh = renderComponent?.mesh ?? null;
        if (renderComponent) {
            renderComponent.mesh = value;
        }

        this.rootNode.setObject3D(value);

        const metadataComponent = this.entity.getComponent(RUNTIME_COMPONENT_KEYS.metadata);
        if (value) {
            if (!value.userData) {
                value.userData = metadataComponent?.userData ?? {};
            } else if (metadataComponent?.userData && value.userData !== metadataComponent.userData) {
                Object.assign(value.userData, metadataComponent.userData);
                metadataComponent.userData = value.userData;
            }
        }

        this.sceneSystem?.notifyActorMeshChanged(this, previousMesh);
    }

    get body() {
        return this.entity.getComponent(RUNTIME_COMPONENT_KEYS.physicsBody)?.body ?? null;
    }

    set body(value) {
        const physicsBodyComponent = this.entity.getComponent(RUNTIME_COMPONENT_KEYS.physicsBody);
        if (physicsBodyComponent) {
            physicsBodyComponent.body = value;
        }
    }

    get scripts() {
        return this.entity.getComponent(RUNTIME_COMPONENT_KEYS.scripts)?.state ?? null;
    }

    set scripts(value) {
        const scriptComponent = this.entity.getComponent(RUNTIME_COMPONENT_KEYS.scripts);
        if (scriptComponent) {
            scriptComponent.state = value;
        }
    }

    get kind() {
        return this.entity.getComponent(RUNTIME_COMPONENT_KEYS.metadata)?.kind ?? 'actor';
    }

    set kind(value) {
        const metadataComponent = this.entity.getComponent(RUNTIME_COMPONENT_KEYS.metadata);
        if (metadataComponent) {
            metadataComponent.kind = value;
        }
    }

    get templateId() {
        return this.entity.getComponent(RUNTIME_COMPONENT_KEYS.metadata)?.templateId ?? '';
    }

    set templateId(value) {
        const metadataComponent = this.entity.getComponent(RUNTIME_COMPONENT_KEYS.metadata);
        if (metadataComponent) {
            metadataComponent.templateId = value;
        }
    }

    get userData() {
        return this.entity.getComponent(RUNTIME_COMPONENT_KEYS.metadata)?.userData ?? {};
    }

    set userData(value) {
        const metadataComponent = this.entity.getComponent(RUNTIME_COMPONENT_KEYS.metadata);
        if (metadataComponent) {
            metadataComponent.userData = value ?? {};
        }

        if (this.mesh) {
            this.mesh.userData = metadataComponent?.userData ?? {};
        }
    }

    getComponent(key) {
        return this.entity.getComponent(key);
    }

    setComponent(key, value) {
        this.entity.setComponent(key, value);
        return this;
    }

    removeComponent(key) {
        this.entity.removeComponent(key);
        return this;
    }
}

export function ensureActorScriptComponent(actor, state = null) {
    const existingComponent = getScriptComponent(actor);
    if (existingComponent) {
        existingComponent.state = state;
        return existingComponent;
    }

    const nextComponent = createScriptComponent(state);
    actor?.setComponent?.(RUNTIME_COMPONENT_KEYS.scripts, nextComponent);
    return nextComponent;
}

export class SceneSystem {
    constructor(scene) {
        this.scene = scene;
        this.actors = new Set();
        this.onActorsChanged = null;
    }

    addActor(actor) {
        if (!actor || this.actors.has(actor)) return actor;

        this.actors.add(actor);
        actor.sceneSystem = this;
        this.attachActorRoot(actor);
        if (this.onActorsChanged) this.onActorsChanged();
        return actor;
    }

    removeActor(actor) {
        if (!actor || !this.actors.has(actor)) return actor;

        const mesh = actor.mesh;
        if (mesh?.parent === this.scene) {
            this.scene.remove(mesh);
        }

        actor.sceneSystem = null;
        this.actors.delete(actor);
        if (this.onActorsChanged) this.onActorsChanged();
        return actor;
    }

    attachActorRoot(actor) {
        const mesh = actor?.mesh;
        if (!mesh) return;

        if (mesh.parent && mesh.parent !== this.scene) {
            mesh.parent.remove(mesh);
        }

        if (mesh.parent !== this.scene) {
            this.scene.add(mesh);
        }
    }

    notifyActorMeshChanged(actor, previousMesh) {
        if (previousMesh?.parent === this.scene) {
            this.scene.remove(previousMesh);
        }

        if (this.actors.has(actor)) {
            this.attachActorRoot(actor);
        }
    }
}

export function createActor(options = {}) {
    return new Actor(options);
}

export function createSceneSystem(scene) {
    return new SceneSystem(scene);
}