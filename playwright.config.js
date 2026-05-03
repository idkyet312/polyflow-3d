// Playwright config for the polyflow-3d smoke test (Phase 0 of the main.js refactor).
//
// Local usage:
//   npm run dev              # in one terminal
//   npm test                 # in another
//
// Or let Playwright spawn the dev server for you (default behavior below).

import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    timeout: 60_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        baseURL: 'http://localhost:5173',
        trace: 'on-first-retry',
        video: 'retain-on-failure',
        // WebGPU needs explicit Chromium flags. These are best-effort; if your
        // local machine has no GPU acceleration available the test will fail at
        // the canvas-visible assertion. Use `npm run test:headed` to debug.
        launchOptions: {
            args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
        },
    },
    projects: [
        {
            name: 'chromium',
            use: { browserName: 'chromium' },
        },
    ],
    webServer: {
        command: 'npm run dev',
        url: 'http://localhost:5173/polyflow-3d/',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
