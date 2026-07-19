# Phase 8 Test Report — Tetrad Camera, Free Fall, Redshifted Starfield

**Script:** `e2e/phase8.cjs` · **Runtime:** 30.0 s · **Result: PASS**
(full 9-suite sweep re-certified green after the moving-observer camera)

## What was done

1. **Local-frame shadow (a = 0, r₀ = 18 M).** With tetrad ray
   initialization, the textbook apparent-angle formula
   sin θ = (3√3 M/r₀)√(1−2M/r₀) must apply directly (44.09 px here).
2. **q_t diagnostic.** For the central (radial) pixel of a static camera,
   q_t = √(1−2M/r₀) exactly — computed CPU-side from the same tetrad the
   shader receives.
2b. **Moving-observer Doppler.** The interactive orbit is a physical moving
   observer (derivations.md §8): a velocity toward the forward sky must shift
   its q_t oppositely to a velocity away (aberration/Doppler), and v = 0 must
   reproduce the static observer *exactly*.
3. **Sky redshift toggle** at r = 12 M (g\* = 1.095, brightness ×1.44):
   the background must change visibly.
4. **Free fall (a = 0.9, released at r = 6 M).** Radius must decrease
   monotonically, frame dragging must drift the azimuth (prograde), and
   plunge termination must reset the camera to orbit.

## Why

The tetrad refactor changes the meaning of every pixel (proper local-frame
angles instead of coordinate-covector angles), replaces the p_t quadratic
with q = −e₀ + nⁱe₍ᵢ₎, and threads a per-ray p_t through the whole
integrator — checks 1–2 pin all of that quantitatively. Check 2b pins the
*moving*-observer generalization used for the interactive orbit: with the
static q_t = √(8/9) = 0.9428, a 0.3c velocity toward the forward sky
blueshifts it to q_t = 0.673 (g\* = 1/q_t = 1.49) and away redshifts it to
1.360 (g\* = 0.74) — opposite, physically-correct shifts — while v = 0
returns 0.9428 to 16 digits, i.e. the moving observer reduces to the static
one exactly. Check 4 exercises the timelike branch end-to-end in the app
(its numerical accuracy is pinned separately by the validation suite's
cycloid study, rel. err. 7×10⁻¹⁰).

## Results

| Check | Value | Bound | Status |
|---|---|---|---|
| Shadow radius | 44.094 px vs 44.091 px predicted | ±3% | ✓ (err 0.006%) |
| Central q_t | 0.9428090415820632 vs √(8/9) | ±10⁻⁶ | ✓ (err 2×10⁻¹⁶) |
| Moving obs., v = 0 ≡ static | 0.94280904 vs static | < 10⁻¹² | ✓ |
| Doppler: q_t toward / away (0.3c) | 0.673 / 1.360 vs 0.943 | opposite shifts | ✓ |
| Sky-shift pixel change | 17.6% | > 2% | ✓ |
| Free-fall radius | 6 → 2.27 M, monotone | monotone | ✓ |
| Frame-dragging azimuth drift | 0.018 rad | > 10⁻³ | ✓ |
| Plunge → reset | observed | required | ✓ |

The 0.006% shadow agreement against the *textbook* formula — after the same
render measured 37.27 px (the coordinate-camera prediction) in Phase 3 — is
the cleanest possible demonstration that the tetrad construction is right:
same integrator, same spacetime, two camera conventions, each matching its
own analytic prediction.

## Failures encountered and fixes

1. **Sky-shift check initially measured zero difference** — at r = 6 M the
   shadow's 45° angular radius fills the entire 60° frame; there was no sky
   to shift. Moved to r = 12 M.
2. **phase3's shadow prediction updated** to the local-frame formula (its
   coordinate-camera derivation remains documented in derivations.md §4).
3. **phase5's ISCO bound recalibrated** (0.75 → 0.85 on the hole-radius
   ratio): proper-angle magnification enlarges the shadow-bounded a = 0.998
   hole relatively more; measured ratio 0.78, still a clear shrink. The
   test also now pins skyShift = false explicitly.
4. **phase6's button count** updated for the new free-fall Release button.
