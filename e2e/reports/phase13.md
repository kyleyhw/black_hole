# Phase 14 Test Report (suite #13) — BINARY Shader Variant

**Script:** `e2e/phase13.cjs` · **Runtime:** 31.7 s · **Result: PASS**
(full 10-suite sweep re-certified green)

## What was done

The `#define BINARY` variant renders two black holes with the superposed
boosted Kerr–Schild metric, using the scalar Sherman–Morrison form of the
inverse derived in docs/derivations.md §11 and validated against the matrix
inverse in the Python mirror (study 8, machine precision). Four browser
checks:

1. **Single-hole limit, pixel parity.** Binary mode with M₂ = 0 vs Kerr
   mode at the same spin and camera. Every BINARY code path is engineered
   to reduce bit-for-bit when f₂ = 0 — the FD-eps and step-size guides
   include the second hole only when it is massive, the capture law
   reproduces the single-Kerr constants, the tetrad shares the same
   Gram–Schmidt core, and additions of exactly 0.0 are IEEE-exact — so the
   assertion is pixel identity, not similarity.
2. **Two-hole scene geometry.** Equal masses at barycentric ±8 M; the two
   capture shadows must appear at the pinhole-projected screen positions
   computed independently in the test, and the image must differ strongly
   from the single-hole frame (inter-hole lensing).
3. **Conservation-drift band.** The |H| debug view (log₁₀|H| false color)
   in the two-hole scene must sit in the same mean-luminance band as single
   Kerr — the superposed metric must not degrade the integrator.
4. **Deep-overlap smoke.** At separation 2 M the Sherman–Morrison D-guard
   and per-hole capture must keep the image finite: stars visible, merged
   dark core, no NaN blowout.

## Why

The binary metric swaps only the scalar H(x, p) behind the unchanged
RK4/FD machinery — precisely the seam the weak-field mode proved. What is
new and load-bearing: the closed-form inverse (checked in float64, then the
scalar transcription pinned here by parity), the per-hole termination, and
the binary camera tetrad. The M₂ → 0 anchor ties the entire new code path
to everything already validated.

## Results

| Check | Value | Bound | Status |
|---|---|---|---|
| M₂ = 0 pixel parity vs Kerr | diffFrac = **0** (pixel-identical) | < 0.001 | ✓ |
| Shadow at predicted left position | dark fraction 1.00 | > 0.4 | ✓ |
| Shadow at predicted right position | dark fraction 1.00 | > 0.4 | ✓ |
| Two-hole vs single-hole image change | 60% | > 15% | ✓ |
| \|H\|-drift band vs single Kerr | ratio 1.08 | [0.5, 2] | ✓ |
| Deep-overlap (sep = 2 M) finite | stars 33%, dark core, mean 56 | bands | ✓ |

## Failures encountered and fixes

The first cut hung the renderer: the in-shader Lorentz boost (an early-return
branch plus γ arithmetic inside `binaryTerm`, which the RK4/FD call tree
inlines ~56×) blew up SwiftShader's pipeline JIT — the first binary draw
blocked the main thread **> 180 s** (measured; every subsequent screenshot
was black, including post-switch Kerr frames, because the rAF loop never
ran again). Two fixes, verified by isolation probes:

1. **Disk compiled out of the BINARY variant** (`#ifndef BINARY`): merger
   mode has no disk by design, and the crossing-bisection block tripled the
   `rk4Step` inline sites. (Necessary but not sufficient.)
2. **Boosts moved to per-hole mat4 uniforms** (lab→rest, computed CPU-side
   per frame): the branchy in-shader boost became a branchless matrix
   multiply. First draw went from blocked > 180 s to **0.2 s**, and the
   identity matrix (static holes) keeps the arithmetic exact — the parity
   check still measures diffFrac = 0.

A test-harness note recorded for honesty: the original background run
reported "exit 0" because the exit code was piped through `tail`; the JSON
inside showed all checks failing. Foreground runs (or `PIPESTATUS`) avoid
that trap.

## Notes

- The boost machinery (per-hole lab→rest mat4 uniforms) is compiled and
  formula-validated in the Python mirror (Lᵀ g L identity, boosted-inverse
  exactness), but dormant in this static preview; it activates with the PN
  dynamics of Phase 15 and will be exercised in-browser there.
- Binary mode has no disk and suppresses the single-Kerr overlays; the
  moving-observer drag camera renders static in this mode (labeled in
  docs/rendering.md).
