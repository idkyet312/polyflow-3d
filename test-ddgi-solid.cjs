const { chromium } = require('playwright');
const path = require('path');

const URL = process.env.POLYFLOW_URL || 'http://127.0.0.1:4174/polyflow-3d/';

function assert(condition, message, details = {}) {
  if (!condition) {
    const err = new Error(message);
    err.details = details;
    throw err;
  }
}

async function waitForDDGI(page, minInitialized = 24) {
  await page.waitForFunction(
    (min) => {
      const snap = window.__ddgi?.getSnapshot?.();
      return snap && snap.initializedProbes >= min && snap.activeVolumeType === 'ddgiVolume';
    },
    minInitialized,
    { timeout: 90000 },
  );
}

async function captureCanvasSamples(page, fileName) {
  const filePath = path.join(__dirname, fileName);
  const buffer = await page.locator('canvas').screenshot({
    path: filePath,
    timeout: 120000,
    animations: 'disabled',
  });

  return page.evaluate(async ({ b64 }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const sample = (x, y, name) => {
      const px = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
      return { name, x: Math.floor(x), y: Math.floor(y), r: px[0], g: px[1], b: px[2] };
    };

    const redPatch = [];
    const greenPatch = [];
    const floorPatch = [];
    for (let oy = -2; oy <= 2; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        redPatch.push(sample(w * 0.30 + ox, h * 0.50 + oy, 'red-wall'));
        greenPatch.push(sample(w * 0.76 + ox, h * 0.44 + oy, 'green-wall'));
        floorPatch.push(sample(w * 0.50 + ox, h * 0.73 + oy, 'floor'));
      }
    }

    const avg = (items, name) => {
      const sum = items.reduce((acc, p) => {
        acc.r += p.r;
        acc.g += p.g;
        acc.b += p.b;
        return acc;
      }, { r: 0, g: 0, b: 0 });
      return {
        name,
        r: sum.r / items.length,
        g: sum.g / items.length,
        b: sum.b / items.length,
      };
    };

    return {
      width: w,
      height: h,
      snap: window.__ddgi?.getSnapshot?.() || {},
      redWall: avg(redPatch, 'red-wall'),
      greenWall: avg(greenPatch, 'green-wall'),
      floor: avg(floorPatch, 'floor'),
    };
  }, { b64: buffer.toString('base64') });
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const consoleErrors = [];

  page.on('console', (m) => {
    const text = m.text();
    if (/\[DDGI\]|setupLightMap|patchMaterials|snapshot/i.test(text)) console.log('CON:', text);
    if (/THREE\.TSL: TypeError|material patch failed|pageerror/i.test(text)) consoleErrors.push(text);
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  try {
    await page.goto(URL);
    await page.waitForLoadState('networkidle').catch(() => {});
    await waitForDDGI(page);

    await page.evaluate(() => window.__ddgi?.setEnabled?.(false));
    await page.waitForTimeout(500);
    const off = await captureCanvasSamples(page, 'ddgi-off.png');

    await page.evaluate(() => {
      window.__ddgi?.setEnabled?.(true);
      window.__ddgi?.setSolidTestEnabled?.(false);
      window.__ddgi?.invalidate?.({ reason: 'ddgi color bleed test', fastWarmupFrames: 2 });
    });
    await waitForDDGI(page, 48);
    await page.waitForTimeout(1500);

    const on = await captureCanvasSamples(page, 'ddgi-solid.png');

    console.log('PIXELS-OFF:', JSON.stringify(off));
    console.log('PIXELS-DDGI:', JSON.stringify(on));

    assert(consoleErrors.length === 0, 'Console errors found', { consoleErrors });
    assert(on.redWall.r > on.redWall.g + 25, 'Red wall sample lacks red dominance', on.redWall);
    assert(on.greenWall.g > on.greenWall.r + 20, 'Green wall sample lacks green dominance', on.greenWall);
    assert(
      (on.floor.r - off.floor.r) > 2 || (on.floor.g - off.floor.g) > 2,
      'DDGI floor sample did not gain visible bounced color',
      { off: off.floor, on: on.floor },
    );

    await browser.close();
  } catch (err) {
    console.error('TEST-FAIL:', err.message, JSON.stringify(err.details || {}, null, 2));
    await browser.close();
    process.exit(1);
  }
})();
