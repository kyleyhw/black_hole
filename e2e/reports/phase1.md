# Phase 1 Test Report — Scaffold, Flat-Space Renderer, Starfield

**Script:** `e2e/phase1.cjs` · **Runtime:** 2.99 s · **Result: PASS**

## What was done

End-to-end smoke test of the built site (`vite build` output served by `vite preview`),
driven in headless Chromium (SwiftShader WebGL2) via Playwright:

1. Load the page; fail on any uncaught page error; wait for the `window.__bh`
   test handle, which only appears after a live WebGL2 context and compiled
   shader program exist.
2. Screenshot the initial view and compute pixel statistics.
3. Rotate the orbit camera azimuth by 30° through the test handle, wait 3
   presented frames, screenshot again, and compute the changed-pixel fraction.

## Why

Phase 1's deliverable is a navigable procedural starfield. The two failure
modes this guards against are (a) a black/errored canvas (shader compile or
context failure renders nothing) and (b) a dead render loop or broken camera
basis (view does not respond to camera state).

## Test inputs and rationale

- **Viewport 800×600, default camera** (r = 18 M, elevation 0.12 rad): the
  landing view every visitor sees first.
- **Bright-pixel fraction bounds (0.1%, 20%):** stars are sparse sub-pixel
  points, so a correct render sits in low single digits; ~0 means blank and
  >20% means a washed-out/degenerate render. Threshold luminance 32/255
  separates stars from the black sky background.
- **30° azimuth rotation:** large enough to move every star field cell by many
  pixels; changed-pixel fraction must exceed 0.05%.

## Results

| Check | Value | Bound | Status |
|---|---|---|---|
| Page errors | none | none | ✓ |
| Star coverage (initial) | 3.43% | (0.1%, 20%) | ✓ |
| Star coverage (rotated) | 3.86% | (0.1%, 20%) | ✓ |
| Pixels changed by rotation | 8.18% | > 0.05% | ✓ |

Screenshot: `e2e/screenshots/phase1-starfield.png` — sparse point stars with
power-law brightness spread and blue/orange temperature tinting, no aliasing
smear, no banding.

## Failures encountered and fixes

- First run attempt failed with `vite preview exited: 1`: a preview server
  from an earlier interrupted run still held port 4173. Fix: the harness kills
  its server on exit (`process.exit()` added so the Node process does not
  linger on the child's stdio), and stale servers are killed before re-runs.
