// Phase 0 smoke test — verifies the engine boots and the play loop works.
//
// Notes:
// - WebGPU requires Chromium with --enable-unsafe-webgpu. If the canvas does
//   not appear within 30s the test fails fast — re-run with `npm run test:headed`
//   to see what went wrong.
// - This test is intentionally lightweight: load page, enter play mode, drive
//   forward for 3 seconds, assert no console errors. Subsequent refactor PRs
//   build on this contract — break it and the PR is rejected.

import { test, expect } from '@playwright/test';

test('engine boots, play mode works, no console errors during 3s of input', async ({ page }) => {
    const errors = [];
    const ignoredPatterns = [
        /THREE\.WebGLRenderer: WEBGL_debug_renderer_info/i,
        /Multiple instances of Three\.js being imported/i,
    ];

    page.on('pageerror', (err) => {
        errors.push(`pageerror: ${err.message}`);
    });
    page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (ignoredPatterns.some((re) => re.test(text))) return;
        errors.push(`console.error: ${text}`);
    });

    await page.goto('/polyflow-3d/');

    // Wait for the WebGPU canvas to mount inside the viewer container.
    const canvas = page.locator('#canvas-container canvas').first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // Give the engine time to finish HDR + terrain + physics init.
    await page.waitForTimeout(3000);

    // Switch to Play mode.
    const playButton = page.locator('#camera-play');
    await expect(playButton).toBeVisible();
    await playButton.click();
    await page.waitForTimeout(500);

    // Acquire focus on the canvas, then drive forward for 3 seconds.
    await canvas.click({ position: { x: 100, y: 100 } });
    await page.waitForTimeout(200);

    await page.keyboard.down('KeyW');
    await page.waitForTimeout(3000);
    await page.keyboard.up('KeyW');

    // Drop pointer lock so the test ends cleanly.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    expect(errors, `Console errors during smoke test:\n${errors.join('\n')}`).toEqual([]);
});
