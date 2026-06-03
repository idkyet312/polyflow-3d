// Warm the Drug Tycoon character FBX files into the HTTP cache as the very
// first thing at app boot, in parallel with the (heavy) runtime module graph
// loading. By the time the player enters Drug Tycoon the bytes are already
// fetched, so the FBX parse + pool prewarm has nothing to wait on — kills the
// first-load hitch. Fire-and-forget; failures are harmless (the real loader
// re-fetches and reports).
(() => {
  const base = import.meta.env?.BASE_URL || '/';
  const FBX = [
    'models/Emmy/Walking.fbx',
    'models/Man/Man.fbx',
    'models/Cop/CopWalk.fbx',
  ];
  for (const path of FBX) {
    try { fetch(base + path, { cache: 'force-cache' }).catch(() => {}); } catch (e) {}
  }
})();

import './src/app/runtime.js';

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const scope = import.meta.env.BASE_URL;
    navigator.serviceWorker.register(`${scope}sw.js`, { scope }).catch((error) => {
      console.warn('[pwa] service worker registration failed', error);
    });
  });
}
