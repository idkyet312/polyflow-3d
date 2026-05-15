import { chromium } from 'playwright';

const URL = 'http://localhost:5173/polyflow-3d/';
const logs = [];
const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack||'').split('\n').slice(0,6).join('\n')}`));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('#level-select', { timeout: 30000 });
await page.waitForTimeout(3500);

// Load Doom Test Arena via the real handler.
await page.selectOption('#level-select', 'doomTest').catch(() => {});
await page.evaluate(() => document.getElementById('load-level')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForTimeout(7000);
await page.screenshot({ path: 'e:/JOBS/polyflow-3d/__shot_doom.png' });

console.log('=== ERRORS ===');
console.log(logs.filter(l => /pageerror|wgsl|shader|compil|invalid|validation|Tint|naga/i.test(l)).join('\n') || '(none)');
console.log('=== LEVEL LOG ===');
console.log(logs.filter(l => /Model loaded|Triangles|doom|Doom|refused|Bake/i.test(l)).slice(-6).join('\n') || '(none)');
await browser.close();
