const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
  page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));
  
  await page.goto('http://localhost:5175/polyflow-3d/');
  await page.waitForTimeout(1000);
  
  await page.click('#open-actor-editor');
  await page.waitForTimeout(500);
  
  await page.click('#actor-editor-create');
  await page.waitForTimeout(500);
  
  const buttons = await page.$$('button');
  for (const btn of buttons) {
    const text = await btn.textContent();
    if (text === 'Edit Blueprint') {
        console.log('Found Edit Blueprint button. Clicking...');
        await btn.click();
        break;
    }
  }
  
  await page.waitForTimeout(1000);
  console.log('Script finished.');
  await browser.close();
})();
