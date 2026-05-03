# Smoke tests

Phase 0 of the main.js refactor adds a Playwright-based smoke test that runs the
engine end-to-end. Every refactor PR (Phases 1-10) must keep this test green.

## Run locally

```bash
npm install
npm test               # headless
npm run test:headed    # see the browser
npm run test:ui        # interactive Playwright UI
```

## What it checks

1. The page loads at `/polyflow-3d/`.
2. The WebGPU canvas mounts inside `#canvas-container`.
3. Clicking `#camera-play` enters Play mode.
4. 3 seconds of `KeyW` (forward) input produces no console errors or page errors.
5. Pressing Escape exits Play mode cleanly.

## When it fails

- **Canvas never appears** — your machine probably can't initialize WebGPU.
  Check `chrome://gpu` in regular Chrome. The Chromium binary that ships with
  Playwright respects the same `--enable-unsafe-webgpu` flag we set in
  `playwright.config.js`.
- **Console errors** — open the trace from the failure (Playwright stores it
  on first retry) to see exactly what blew up.

## Future tests

This file is intentionally minimal. Add scenario-level specs to `tests/` as
features stabilize. Keep the smoke test fast (under 10 s on a warm cache)
because it runs on every PR.
