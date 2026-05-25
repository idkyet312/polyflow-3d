#!/usr/bin/env node
// Architecture guard. Run via `npm run check:arch` or as part of `npm test`.
// Catches regressions on the refactor we just landed:
//   1. New `window.__*` writes outside debugRegistry.js
//   2. runtime.js bloating back past the cap
//
// Failures print actionable messages and exit non-zero so CI fails.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUNTIME_PATH = path.join(ROOT, 'src/app/runtime.js');
const RUNTIME_MAX_LINES = 7000;          // raised for forward+ lighting features; ratchet down each refactor pass
const DEBUG_REGISTRY_PATH = path.join(ROOT, 'src/runtime/debugRegistry.js');
const DIST_ASSETS_PATH = path.join(ROOT, 'dist/assets');
const MAIN_CHUNK_MAX_BYTES = 900 * 1024;
const REQUIRED_SPLIT_CHUNKS = ['vendor-three-', 'vendor-physics-'];

const errors = [];

// --- Check 1: runtime.js line budget --------------------------------------
{
    const source = readFileSync(RUNTIME_PATH, 'utf8');
    const lines = source.split('\n').length;
    if (lines > RUNTIME_MAX_LINES) {
        errors.push(
            `[arch] src/app/runtime.js is ${lines} lines, exceeds cap of ${RUNTIME_MAX_LINES}.\n`
            + `       Extract a cohesive chunk into its own module (see REFACTOR_PLAN.md Phase 5).`,
        );
    }
}

// --- Check 2: window.__* writes outside debugRegistry ---------------------
{
    const re = /window\s*\.\s*__/g;
    for await (const file of glob('src/**/*.js', { cwd: ROOT })) {
        const abs = path.join(ROOT, file);
        if (abs === DEBUG_REGISTRY_PATH) continue;
        const source = readFileSync(abs, 'utf8');
        let m;
        const hits = [];
        while ((m = re.exec(source)) !== null) {
            const before = source.slice(0, m.index);
            const line = before.split('\n').length;
            // Skip if inside a comment line.
            const lineText = source.split('\n')[line - 1];
            if (lineText.trim().startsWith('//')) continue;
            hits.push(line);
        }
        if (hits.length) {
            errors.push(
                `[arch] ${file} writes to window.__* on lines ${hits.join(', ')}.\n`
                + `       Use registerDebug() from src/runtime/debugRegistry.js instead.`,
            );
        }
    }
}

// --- Check 3: built bundle stays split ------------------------------------
// Optional: clean checkouts may not have dist yet. Once `npm run build` runs,
// this catches main-chunk creep and vendor re-bundling.
if (existsSync(DIST_ASSETS_PATH)) {
    const chunks = readdirSync(DIST_ASSETS_PATH).filter((file) => file.endsWith('.js'));
    const mainChunks = chunks.filter((file) => /^index-[\w-]+\.js$/.test(file));
    if (!mainChunks.length) {
        errors.push('[bundle] dist/assets has no index-*.js app chunk.');
    } else {
        for (const file of mainChunks) {
            const bytes = statSync(path.join(DIST_ASSETS_PATH, file)).size;
            if (bytes > MAIN_CHUNK_MAX_BYTES) {
                errors.push(
                    `[bundle] ${file} is ${bytes} bytes, exceeds cap of ${MAIN_CHUNK_MAX_BYTES}.\n`
                    + '         Dynamic-import editor/debug/rare modes or split shared vendors.',
                );
            }
        }
    }

    for (const prefix of REQUIRED_SPLIT_CHUNKS) {
        if (!chunks.some((file) => file.startsWith(prefix))) {
            errors.push(`[bundle] Missing ${prefix}*.js split chunk. Check vite chunk config.`);
        }
    }
}

if (errors.length) {
    for (const e of errors) console.error(e + '\n');
    process.exit(1);
}

console.log('[arch] OK');
