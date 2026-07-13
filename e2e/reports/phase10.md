# Phase 10 Test Report — Weak-Field Multi-Mass Mode

**Script:** `e2e/phase10.cjs` · **Runtime:** 153 s (browser) plus the
float64 deflection study in the validation suite (0.9 s; suite now 12/12) ·
**Result: PASS**

## What was done

Browser tests of the linearized multi-mass mode (compile-time
`#define WEAK_FIELD` shader variant — no runtime branching in the hot
loop):

1. Two equal masses at (0, ±8, 0), camera at r = 30: dark capture disks
   render at both *predicted projected screen positions* (computed
   independently in the test from the pinhole model), each surrounded by
   Einstein-ring star streaking; the image differs from Kerr mode over 70%
   of pixels.
2. Pointer-dragging a mass moves it in the camera plane (7.7 M for a 40 px
   drag at depth 30) without orbiting the camera.
3. The pairwise-|Φ| validity indicator reads "linear regime" at
   (0.5+0.5)/24 = 0.04 and warns "⚠ linearization degrading" at 1/3 = 0.33.
4. Switching back to Kerr restores the disk render.

The mode's *physics* is validated in float64 (validation study 6):
deflection α = 4M/b to 0.28% at b = 10³ M, log–log slope −1.008, and
two-mass far-field additivity to 3.3% against the per-mass 4Mₖ/bₖ sum —
with the small-b residuals following the ~10M/b second-order envelope
(the linearized metric's own higher-order deflection, not integrator
error; see `validation/plots/weakfield_deflection.png`).

## Results

| Check | Value | Bound | Status |
|---|---|---|---|
| Dark fraction at mass 1 / 2 | 0.93 / 0.82 | > 0.5 | ✓ |
| Kerr↔multi image change | 70% | > 15% | ✓ |
| Drag displacement | 7.7 M | > 2 M | ✓ |
| Camera azimuth during drag | 0 | < 10⁻⁹ | ✓ |
| Validity far / near | 0.042 / 0.333 ⚠ | warn only near | ✓ |
| Back-to-Kerr image change | > 15% | > 15% | ✓ |

Screenshot: `phase10-two-masses.png` — two lensing centers with their
Einstein rings and the caustic structure between them.

## Failures encountered and fixes

1. **Mean-luminance darkness metric failed on one mass** — lensed star
   arcs graze the small sample box asymmetrically (correct physics, fragile
   metric). Replaced with a dark-pixel fraction over a disk.
2. **The "far" validity state already warned**: two M = 1 masses at
   separation 16 give pairwise |Φ| = 0.125 > 0.1 — the test's own
   configuration was outside the linear regime, which is exactly what the
   indicator is for. The test now uses 0.5 M masses at separation 24.
