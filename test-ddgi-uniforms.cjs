const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage();
  page.on('console', m => { const t = m.text(); if (/DDGI|setupLightMap/i.test(t)) console.log('CON:', t); });
  page.on('pageerror', e => console.log('ERR:', e.message));

  await page.goto('http://127.0.0.1:4174/polyflow-3d/');
  await page.waitForTimeout(6000);

  const before = await page.evaluate(() => {
    const m = window.__ddgi;
    const snap = m?.getSnapshot?.();
    return { snap };
  });
  console.log('BEFORE:', JSON.stringify(before));

  await page.evaluate(() => window.__ddgi.setSolidTestEnabled(true));
  await page.waitForTimeout(1000);

  const after = await page.evaluate(() => {
    const m = window.__ddgi;
    const snap = m?.getSnapshot?.();

    // Walk scene to find a Cornell wall and inspect its material
    const scene = window.__scene || window.scene;
    let info = { sceneFound: !!scene, mats: [] };
    if (scene) {
      scene.traverse(o => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) {
          if (!mat) continue;
          if (mat.isDDGIMeshStandardNodeMaterial && info.mats.length < 5) {
            info.mats.push({
              name: mat.name || o.name || '(unnamed)',
              hasIrradianceNode: !!mat.ddgiIrradianceNode,
              irradianceNodeType: mat.ddgiIrradianceNode?.constructor?.name || null,
              patchVersion: mat.userData?._ddgiPatchVersion,
              needsUpdate: mat.needsUpdate,
              setupLightMapLogged: !!mat._ddgiSetupLightMapLogged,
            });
          }
        }
      });
    }
    return { snap, info };
  });
  console.log('AFTER:', JSON.stringify(after, null, 2));

  await browser.close();
})();
