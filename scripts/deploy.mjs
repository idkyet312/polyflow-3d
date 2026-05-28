#!/usr/bin/env node
// One-shot deploy: stage everything, commit (skipped cleanly if nothing
// changed), and push 23may26 — which triggers the "Deploy Pages from Branch"
// GitHub Action that builds and publishes the site. Run via `npm run deploy`.
// Cross-platform (no shell-specific chaining; works on Windows cmd + POSIX).

import { execFileSync } from 'node:child_process';

const BRANCH = '23may26';

function git(args, opts = {}) {
    return execFileSync('git', args, { stdio: 'inherit', ...opts });
}
function gitQuiet(args) {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

// 1) Stage all changes.
git(['add', '-A']);

// 2) Commit only if there's something staged (a clean tree is fine — we still push).
const staged = gitQuiet(['diff', '--cached', '--name-only']);
if (staged) {
    git(['commit', '-m', 'deploy']);
} else {
    console.log('Nothing to commit — pushing current branch.');
}

// 3) Push to the branch the Pages Action watches.
git(['push', 'origin', BRANCH]);

console.log('\nPushed. The Deploy Pages Action will build + publish:');
console.log('  https://idkyet312.github.io/polyflow-3d/');
