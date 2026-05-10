// src/world/objectMaterial.js
// Extracted from main.js (setActorColor through applyObjectMaterialOverrides).
// Handles per-object / per-material state serialization and application.

import * as THREE from 'three';
import { getDDGIManager } from './gi/ddgiManager.js';

// ─── Module-scope deps populated by setupObjectMaterial ────────────────────────────
let getRenderComponent;

export function setupObjectMaterial(deps) {
    ({ getRenderComponent } = deps);
}

// ─── Internal helper (not exported – only used within this module) ────────────────────

function getActorRenderObject(prop) {
    return getRenderComponent(prop)?.mesh ?? prop?.mesh ?? null;
}

function invalidateDDGI(reason) {
    try {
        getDDGIManager().invalidate({ reason, fastWarmupFrames: 2 });
    } catch {
        // DDGI may not be initialized while serialized scene data is loading.
    }
}

// ─── Exported functions ───────────────────────────────────────────────────────────────────

export function setActorColor(actor, hexColor) {
    const mesh = getActorRenderObject(actor);
    if (!mesh) return;
    const color = new THREE.Color(hexColor);
    mesh.traverse((child) => {
        if (child.isLight && child.color) {
            child.color.copy(color);
        }
        if (child.isMesh && child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of mats) {
                if (mat.color) mat.color.copy(color);
                if (mat.emissive) mat.emissive.copy(color).multiplyScalar(0.35);
            }
        }
    });
    if (actor?.userData?.light) {
        actor.userData = {
            ...(actor.userData || {}),
            light: {
                ...(actor.userData.light || {}),
                color: `#${color.getHexString()}`,
            },
        };
    }
    // Mark this actor as having user-authored material edits so .actor save
    // includes the per-mesh overrides instead of taking the fast path that
    // relies on template defaults.
    mesh.userData.hasMaterialOverrides = true;
    invalidateDDGI('actor color changed');
}

export function markActorMaterialDirty(actor) {
    const mesh = getActorRenderObject(actor);
    if (mesh) mesh.userData.hasMaterialOverrides = true;
}

export function getObjectMaterialArray(object3D) {
    if (!object3D?.isMesh || !object3D.material) return [];
    return Array.isArray(object3D.material) ? object3D.material : [object3D.material];
}

export function clampMaterialStateValue(value, fallback, min = 0, max = 1) {
    const numericValue = Number.isFinite(value) ? value : fallback;
    return THREE.MathUtils.clamp(numericValue, min, max);
}

export function serializeMaterialSide(side) {
    if (side === THREE.BackSide) return 'back';
    if (side === THREE.DoubleSide) return 'double';
    return 'front';
}

export function deserializeMaterialSide(side) {
    if (side === 'back') return THREE.BackSide;
    if (side === 'double') return THREE.DoubleSide;
    if (side === 'front') return THREE.FrontSide;
    return null;
}

export function serializeSingleMaterialState(material) {
    if (!material) return null;

    const state = {};

    if (material.color) {
        state.color = `#${material.color.getHexString()}`;
    }
    if (material.emissive) {
        state.emissive = `#${material.emissive.getHexString()}`;
    }
    if ('emissiveIntensity' in material) {
        state.emissiveIntensity = material.emissiveIntensity ?? 1;
    }
    if ('roughness' in material) {
        state.roughness = material.roughness ?? 0.5;
    }
    if ('metalness' in material) {
        state.metalness = material.metalness ?? 0;
    }
    if ('opacity' in material) {
        state.opacity = material.opacity ?? 1;
    }
    if ('transparent' in material) {
        state.transparent = material.transparent === true;
    }
    if ('alphaTest' in material) {
        state.alphaTest = material.alphaTest ?? 0;
    }
    if ('envMapIntensity' in material) {
        state.envMapIntensity = material.envMapIntensity ?? 1;
    }
    if ('transmission' in material) {
        state.transmission = material.transmission ?? 0;
    }
    if ('thickness' in material) {
        state.thickness = material.thickness ?? 0;
    }
    if ('ior' in material) {
        state.ior = material.ior ?? 1.5;
    }
    if ('clearcoat' in material) {
        state.clearcoat = material.clearcoat ?? 0;
    }
    if ('clearcoatRoughness' in material) {
        state.clearcoatRoughness = material.clearcoatRoughness ?? 0;
    }
    if ('side' in material) {
        state.side = serializeMaterialSide(material.side);
    }

    return Object.keys(state).length ? state : null;
}

export function getObjectMaterialPreviewState(object3D) {
    const material = getObjectMaterialArray(object3D)[0] ?? null;
    return serializeSingleMaterialState(material);
}

export function serializeObjectMaterialState(object3D) {
    const materials = getObjectMaterialArray(object3D);
    if (!materials.length) return null;

    const slots = materials.map((material) => serializeSingleMaterialState(material) ?? {});
    const hasMaterialData = slots.some((slot) => Object.keys(slot).length > 0);
    if (!hasMaterialData) return null;

    return slots.length === 1 ? slots[0] : { slots };
}

export function applyObjectMaterialState(object3D, materialState) {
    const materials = getObjectMaterialArray(object3D);
    if (!materials.length || !materialState) return;
    let changed = false;

    const slotStates = Array.isArray(materialState?.slots) ? materialState.slots : null;

    for (let index = 0; index < materials.length; index++) {
        const material = materials[index];
        if (!material) continue;
        const nextState = slotStates ? (slotStates[index] ?? slotStates[0] ?? null) : materialState;
        if (!nextState) continue;
        if (!Object.keys(nextState).length) continue;

        const color = nextState.color ? new THREE.Color(nextState.color) : null;
        const emissive = nextState.emissive ? new THREE.Color(nextState.emissive) : null;
        const side = deserializeMaterialSide(nextState.side);
        const roughness = nextState.roughness !== undefined
            ? clampMaterialStateValue(nextState.roughness, 0.5, 0, 1)
            : undefined;
        const metalness = nextState.metalness !== undefined
            ? clampMaterialStateValue(nextState.metalness, 0, 0, 1)
            : undefined;
        const emissiveIntensity = nextState.emissiveIntensity !== undefined
            ? clampMaterialStateValue(nextState.emissiveIntensity, 1, 0, 8)
            : undefined;
        const opacity = nextState.opacity !== undefined
            ? clampMaterialStateValue(nextState.opacity, 1, 0, 1)
            : undefined;
        const alphaTest = nextState.alphaTest !== undefined
            ? clampMaterialStateValue(nextState.alphaTest, 0, 0, 1)
            : undefined;
        const envMapIntensity = nextState.envMapIntensity !== undefined
            ? clampMaterialStateValue(nextState.envMapIntensity, 1, 0, 4)
            : undefined;
        const transmission = nextState.transmission !== undefined
            ? clampMaterialStateValue(nextState.transmission, 0, 0, 1)
            : undefined;
        const thickness = nextState.thickness !== undefined
            ? clampMaterialStateValue(nextState.thickness, 0, 0, 10)
            : undefined;
        const ior = nextState.ior !== undefined
            ? clampMaterialStateValue(nextState.ior, 1.5, 1, 2.5)
            : undefined;
        const clearcoat = nextState.clearcoat !== undefined
            ? clampMaterialStateValue(nextState.clearcoat, 0, 0, 1)
            : undefined;
        const clearcoatRoughness = nextState.clearcoatRoughness !== undefined
            ? clampMaterialStateValue(nextState.clearcoatRoughness, 0, 0, 1)
            : undefined;

        if (color && material.color) {
            material.color.copy(color);
            changed = true;
        }
        if (emissive && material.emissive) {
            material.emissive.copy(emissive);
            changed = true;
        }
        if ('emissiveIntensity' in material && emissiveIntensity !== undefined) {
            material.emissiveIntensity = emissiveIntensity;
            changed = true;
        }
        if ('roughness' in material && roughness !== undefined) {
            material.roughness = roughness;
            changed = true;
        }
        if ('metalness' in material && metalness !== undefined) {
            material.metalness = metalness;
            changed = true;
        }
        if ('opacity' in material && opacity !== undefined) {
            material.opacity = opacity;
            changed = true;
        }
        if ('alphaTest' in material && alphaTest !== undefined) {
            material.alphaTest = alphaTest;
            changed = true;
        }
        const hasTransparencyState = nextState.transparent !== undefined
            || opacity !== undefined
            || transmission !== undefined;
        if ('transparent' in material && hasTransparencyState) {
            const shouldBeTransparent = nextState.transparent === true
                || (opacity !== undefined && opacity < 0.999)
                || (transmission !== undefined && transmission > 0);
            material.transparent = shouldBeTransparent;
            changed = true;
        }
        if ('depthWrite' in material && hasTransparencyState) {
            material.depthWrite = !(material.transparent && (material.alphaTest ?? 0) <= 0);
            changed = true;
        }
        if ('envMapIntensity' in material && envMapIntensity !== undefined) {
            material.envMapIntensity = envMapIntensity;
            changed = true;
        }
        if ('transmission' in material && transmission !== undefined) {
            material.transmission = transmission;
            changed = true;
        }
        if ('thickness' in material && thickness !== undefined) {
            material.thickness = thickness;
            changed = true;
        }
        if ('ior' in material && ior !== undefined) {
            material.ior = ior;
            changed = true;
        }
        if ('clearcoat' in material && clearcoat !== undefined) {
            material.clearcoat = clearcoat;
            changed = true;
        }
        if ('clearcoatRoughness' in material && clearcoatRoughness !== undefined) {
            material.clearcoatRoughness = clearcoatRoughness;
            changed = true;
        }
        if ('side' in material && side !== null) {
            material.side = side;
            changed = true;
        }
        // Intentionally not setting material.needsUpdate. The fields touched
        // above (color, roughness, metalness, opacity, emissive, etc.) are
        // uniform updates — none of them require a shader recompile. Marking
        // every material dirty triggers re-link work on the next frame, which
        // is the difference between "instant" and "multi-second hitch" when
        // restoring a 100k-mesh actor. Side changes flip culling, also no
        // recompile.
    }
    if (changed) invalidateDDGI('material changed');
}

export function serializeObjectMaterialOverrides(rootObject) {
    if (!rootObject) return [];

    const overrides = [];

    function visit(node, path) {
        const materialState = serializeObjectMaterialState(node);
        if (materialState) {
            overrides.push({
                path,
                material: materialState,
            });
        }

        node.children.forEach((child, index) => {
            visit(child, [...path, index]);
        });
    }

    visit(rootObject, []);
    return overrides;
}

export function getObjectByHierarchyPath(rootObject, path = []) {
    let current = rootObject;

    for (const childIndex of path) {
        if (!current?.children?.[childIndex]) {
            return null;
        }
        current = current.children[childIndex];
    }

    return current;
}

export function applyObjectMaterialOverrides(rootObject, overrides = []) {
    if (!rootObject || !Array.isArray(overrides)) return;

    overrides.forEach((entry) => {
        const target = getObjectByHierarchyPath(rootObject, entry.path);
        if (!target) return;
        applyObjectMaterialState(target, entry.material);
    });
    if (overrides.length) invalidateDDGI('material overrides changed');
}
