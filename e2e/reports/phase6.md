# Phase 6 Test Report — UI, Overlays, Post-processing

**Script:** `e2e/phase6.cjs` · **Runtime:** 74.5 s (plus regression runs:
phase1 56 s, phase3 20 s, phase5 26 s) · **Result: PASS** (and all three
prior phase tests re-pass against the new pipeline)

## What was done

Full interaction pass in headless Chromium (480×360):

1. **Chrome present:** panel, FPS counter, footer exist; 7 sliders, 4
   buttons; no page errors; the HDR pipeline (RGBA16F scene target →
   bright-pass separable Gaussian bloom at half resolution → ACES tonemap
   composite) renders a non-black frame.
2. **Controls drive state:** clicking the "Near-extremal" preset sets
   a = 0.998 and moves the camera; dragging the spin slider sets
   params.spin.
3. **Overlays:** enabling ergosphere shell + photon-orbit rings changes
   > 2% of pixels (marched/analytic flat-space schematic surfaces).
4. **Bloom:** strength 0 → 1.8 changes ~26% of pixels.
5. **Resolution scale 0.25×** still renders (FBO reallocation path).
6. **Screenshot button** produces a `.png` download (`kerr-a0.900.png`).

## Why

Phase 6 rewires the whole output path (direct-to-canvas → three-pass HDR
pipeline), so beyond testing the new UI the earlier physics tests were
re-run as regressions — they measure pixels and must survive tonemapping.

## Results

| Check | Value | Bound | Status |
|---|---|---|---|
| Chrome elements | all present | — | ✓ |
| Preset → params | a = 0.998, r = 12 | exact | ✓ |
| Slider → params | a = 0.200 | exact | ✓ |
| Overlay pixel change | 3.4% | > 2% | ✓ |
| Bloom pixel change | 26% | > 0.5% | ✓ |
| 0.25× resolution renders | mean lum 68 | > 2 | ✓ |
| Screenshot download | kerr-a0.900.png | .png | ✓ |
| phase1/3/5 regressions | all PASS | — | ✓ |

## Failures encountered and fixes

1. **Overlay diff initially 0.19%.** The 264 px panel occluded most of the
   small test viewport, and overlay alpha was low. Fixes: pixel tests hide
   `#panel/#fps/#footer`; ergosphere alpha raised (0.18 + 0.35·rim).
2. **Debug-view classifiers broke under ACES+gamma** (phase3 regression:
   captured-pixel mask matched nothing). Fix in the renderer, not the
   test: debug views bypass bloom/tonemap entirely in the composite pass —
   categorical false colors must reach the screen exactly.
3. **Old tests hid the defunct `#controls` strip** (replaced by the panel)
   and relied on old defaults (disk now on by default, default spin 0.6).
   Tests now set their full state explicitly.
4. **Tonemap recalibration:** phase1 star-coverage upper bound 20% → 35%
   (gamma lifts faint stars); phase5 beaming ratios compress under ACES
   (2.29 → 1.54 on, 1.41 → 1.19 off) but remain well within bounds.
