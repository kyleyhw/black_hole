# Phase 3 Test Report — Kerr Geodesic Integrator

**Script:** `e2e/phase3.cjs` · **Runtime:** 13.4 s · **Result: PASS**

## What was done

Quantitative in-browser validation of the shader's Kerr–Schild Hamiltonian
RK4 integrator, rendered headless (SwiftShader WebGL2, 240×180, 600-step
budget) and measured from the false-color debug views via pixel analysis.

1. **Schwarzschild shadow radius (a = 0).** Captured-pixel disk in the
   "final r" debug view, equivalent radius √(area/π), compared to the
   analytic prediction *for the coordinate-pinhole camera*: the shadow edge
   angle solves b(α) = r₀ sin α / q_t(α) = 3√3 M (derivations.md §4).
2. **|H| drift bounded (a = 0.9).** Fraction of pixels in the drift view
   with drift ≳ 10⁻² must be small.
3. **Frame-dragging asymmetry.** Shadow centroid horizontal shift: ~0 at
   a = 0, significant at a = 0.998 (equatorial camera).

## Why

These are the three observables that separate a correct geodesic integrator
from a plausible-looking one: the shadow size pins the critical impact
parameter (a global, cumulative property of the integration), the H drift
pins local integration error, and the centroid shift pins the sign and
presence of frame dragging (which a time-reversed integration would flip).

## Test inputs and rationale

- Camera at r₀ = 18 M, fovY 60°, equatorial (elevation 0) for shadow
  measurements — mid-range distance where the shadow spans ~40% of the
  frame height (good pixel statistics at small viewport).
- a = 0: analytic Schwarzschild reference. a = 0.9: generic strong spin for
  the drift map. a = 0.998: Thorne limit, the numerically hardest case.
- Tolerance 3% on shadow radius: dominated by pixel quantization at
  240×180 (±1 px ≈ 2.7%).

## Results

| Check | Value | Bound | Status |
|---|---|---|---|
| Shadow radius (measured) | 37.22 px | — | — |
| Shadow radius (predicted) | 37.27 px | ±3% | ✓ (err 0.13%) |
| \|H\| drift red fraction (a=0.9) | 9.3% | < 15% | ✓ |
| Centroid shift, a = 0 | 0.21% of width | < 0.5% | ✓ |
| Centroid shift, a = 0.998 | 6.8% of width | > 1% | ✓ |

Screenshots: `phase3-finalr-a0.png`, `phase3-hdrift-a09.png`,
`phase3-finalr-a0998.png`, `phase3-shadow-a09.png` (lensed starfield with
Einstein-ring streaking around the shadow).

## Failures encountered and fixes

1. **First run: shadow 25% small, a = 0 centroid off.** The provisional DOM
   controls overlay occluded part of the 240×180 canvas, corrupting the
   pixel statistics. Fix: tests hide `#controls` (with `!important`, since
   the strip sets an inline `display`).
2. **Extreme spin (a = 0.998): fragmented capture region, rays "escaping"
   from inside the shadow, |H| saturated.** Two compounding causes.
   (i) The fixed capture buffer 1.02 r₊ sat *outside* the prograde photon
   orbit (r_ph = 1.077 vs 1.084) — the buffer now scales as
   r₊(1 + 0.02√(1−a²)). (ii) Past-directed shadow rays hug the horizon with
   exponentially growing |p|; at fixed dλ the RK4 substates then move by
   coordinate distances ≫ M and blow up into garbage states classified as
   escaped. Fix: displacement-bounded adaptive step
   dλ = 0.1 min(r − 0.9 r_H, r)/|dx/dλ| (the blueprint's heuristic, which
   an earlier simplification had dropped) plus a NaN-proof capture guard on
   |p|² > 10⁸ (huge blueshift relative to E = 1 ⇒ horizon-asymptotic ray).
3. **Predicted shadow radius initially wrong by 18%.** The textbook
   local-frame formula does not apply to a coordinate-covector camera; the
   correct per-camera prediction (via conserved b(α)) agrees to 0.13%.
   Documented in derivations.md §4; the Phase 8 tetrad camera will make the
   local-frame formula applicable.
