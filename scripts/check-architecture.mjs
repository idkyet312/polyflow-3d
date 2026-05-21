#!/usr/bin/env node
// Architecture guard. Run via `npm run check:arch` or as part of `npm test`.
// Catches regressions on the refactor we just landed:
//   1. New `window.__*` writes outside debugRegistry.js
//   2. runtime.js bloating back past the cap
//
// Failures print actionable messages and exit non-zero so CI fails.

import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUNTIME_PATH = path.join(ROOT, 'src/app/runtime.js');
const RUNTIME_MAX_LINES = 7400;          // current ≈7344; ratchet down each refactor pass
const DEBUG_REGISTRY_PATH = path.join(ROOT, 'src/runtime/debugRegistry.js');

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

if (errors.length) {
    for (const e of errors) console.error(e + '\n');
    process.exit(1);
}

console.log('[arch] OK');
