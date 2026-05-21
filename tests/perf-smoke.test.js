import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const RUN_BROWSER_PERF = process.env.RUN_BROWSER_PERF === '1';

async function waitForServer(url, timeoutMs = 20000) {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeoutMs) {
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw lastError || new Error(`Server did not answer: ${url}`);
}

test('browser perf smoke: 10s run has bounded heap and system timings', {
    skip: RUN_BROWSER_PERF ? false : 'set RUN_BROWSER_PERF=1 to run browser perf smoke',
    timeout: 45000,
}, async () => {
    const port = Number(process.env.PERF_PORT || 4179);
    const viteBin = path.join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');
    const server = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port)], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.resume();
    server.stderr?.resume();

    let browser = null;
    try {
        const url = `http://127.0.0.1:${port}/polyflow-3d/?debug=1`;
        await waitForServer(url);

        const { chromium } = await import('playwright');
        browser = await chromium.launch({
            headless: true,
            args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
        });
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!globalThis.__POLYFLOW_DEBUG__?.gameplaySystems);
        await page.waitForFunction(
            () => globalThis.__POLYFLOW_DEBUG__.gameplaySystems.getLastMetrics().systems.length > 0,
            { timeout: 20000 },
        );

        const beforeHeap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
        await page.waitForTimeout(10000);
        const afterHeap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
        const metrics = await page.evaluate(() => globalThis.__POLYFLOW_DEBUG__.gameplaySystems.getLastMetrics());

        assert.ok(metrics.systems.length > 0, 'system registry should record per-system timings');
        assert.ok((metrics.phases.gameplay?.total ?? 0) < 16, 'gameplay systems should stay under one 60fps frame');
        assert.ok(!metrics.slow.some((entry) => entry.duration > 16), 'no individual system should exceed 16ms');

        if (beforeHeap != null && afterHeap != null) {
            const heapDeltaMb = (afterHeap - beforeHeap) / (1024 * 1024);
            assert.ok(heapDeltaMb < 32, `heap grew ${heapDeltaMb.toFixed(1)}MB`);
        }
    } finally {
        await browser?.close?.();
        server.kill();
    }
});
