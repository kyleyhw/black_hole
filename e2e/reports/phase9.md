# Phase 9 Test Report — Retrograde Disk and Inclination

**Script:** `e2e/phase9.cjs` · **Runtime:** 43.5 s · **Result: PASS**

## What was done

1. **BPT ISCO values** exposed from the app's own `riscoOf(a, s)`:
   prograde and retrograde at a = 0.9 vs the analytic 2.3209 / 8.7174 M.
2. **Beaming flip under s → −s** (a = 0.9, edge-on), measured **disk-only**:
   the bright side must move from screen-left to screen-right when the flow
   is reversed. The asymmetry is the left/right ratio of the disk's own
   luminance, isolated by subtracting a disk-off frame from a disk-on frame
   at the identical camera and (frozen) time.
3. **Retrograde ISCO hole** (face-on): the annulus hole must widen far
   beyond the prograde (shadow-bounded) hole when r_ISCO jumps to 8.72 M.
4. **Inclination** (a = 0, tilt 23°): large image change, disk still
   visible (tilted-plane crossing detection and bisection work).

## Why

The s = ±1 generalization threads through Ω, u^t, and r_ISCO — the flip
test checks the *sign* chain end-to-end, the hole test the ISCO coupling,
and the BPT check the formula itself. The tilt test exercises the
generalized crossing detection (x·n̂ instead of z) and the in-plane basis
used for the noise angle. The redshift for tilted disks uses the angular
momentum about the disk normal evaluated at the hit — exact at a = 0,
labeled a kinematic approximation for a ≠ 0 in the UI and docs.

## Methodology notes (why the measurement is disk-only and frozen)

Beaming is a property of the **disk**, but a whole-frame left/right mean
also sums the lensed starfield, whose brightness and per-star placement are
a rendering choice (they changed when the stars were resized). Two seams
make the measurement report the physics and nothing else:

- **Disk-only via on−off subtraction.** For each sense the test captures a
  disk-on and a disk-off frame at the same camera and time; the per-pixel
  `max(0, lum_on − lum_off)` is the disk's contribution, with the starfield
  cancelled exactly. This is the correct isolation of the quantity under
  test and is immune to any change in how stars are drawn.
- **Frozen turbulence** (`window.__bhDiskTime = 0`). The disk texture is
  fast-forwarded ×2 in the product for visible Keplerian shear; freezing the
  clock removes advection variance between screenshots so the geometry and
  beaming are read on a static pattern.
- **Pinned resolution 0.75.** The test sets `resolutionScale = 0.75`
  explicitly rather than relying on the default (now 1.00×), matching the
  scale the pixel bounds are calibrated to and keeping the software renderer
  responsive.

## Results

| Check | Value | Bound | Status |
|---|---|---|---|
| r_ISCO(0.9, +1) | 2.32088 M | 2.3209 ± 0.002 | ✓ |
| r_ISCO(0.9, −1) | 8.71735 M | 8.7174 ± 0.002 | ✓ |
| Disk-only left/right, prograde | 4.47 | > 1.2 | ✓ |
| Disk-only left/right, retrograde | 0.56 | < 0.91 | ✓ |
| Face-on hole, prograde | 29 px | — | — |
| Face-on hole, retrograde | 75 px | > 1.4 × prograde | ✓ (2.6×) |
| Tilt image change | 31% | > 5% | ✓ |
| Tilt disk visibility | 57% bright | > 1% | ✓ |

Physics note visible in the numbers: the retrograde asymmetry (0.56, i.e.
the right side ~1.8× the left) is *weaker* than the prograde one
(1/4.47 = 0.22, i.e. the left side ~4.5× the right) — retrograde matter at
its much larger ISCO orbits slower, so beaming is genuinely milder, not a
bug. The disk-only isolation makes both signals far cleaner than a
whole-frame mean (which had read a marginal 1.65 / 0.75).

Screenshots: `phase9-retro-a09.png`, `phase9-retro-faceon-a09.png` (the
star-filled gap between shadow and the receded disk inner edge is the
retrograde ISCO), `phase9-tilt-a0.png`.

## Failures encountered and fixes

The original whole-frame `halfMeans` asymmetry passed when first written,
but the later star-resize (half-size, flux-conserving) changed the
background's left/right contribution enough to push the marginal retrograde
ratio (0.95) above its 0.909 bound. **Root-cause fix, not a threshold
nudge:** the measurement was reworked to disk-only (on−off), which both
removes the star dependence and sharpens the signal to 4.47 / 0.56. The
disk clock was frozen and resolution pinned at the same time so the
geometry checks (`annulusInnerRadius`) are equally deterministic.
