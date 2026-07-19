# Validation Suite Report

**Command:** `uv run python run_validation.py` · **Total runtime:** 23.4 s
(convergence 11.6 s, b_crit 1.2 s,
photon shell 6.2 s, drift 0.4 s,
plunge 2.4 s, deflection 0.6 s,
PN chirp 0.2 s, superposed KS 0.9 s)

**Result: PASS** — 20/20 checks.

The suite mirrors the shader's exact algorithm (Hamiltonian, RK4,
central-difference gradients, adaptive step, termination) in float64
(`kerr.py`) and tests it against analytic strong-field results. What each
study does, why, and how to read its plot:

## 1. Convergence order (`plots/convergence.png`)

**What/why:** fixed-step integration of a strong-field flyby (a = 0.9,
r_min = 6.68 M) for a fixed affine length; global error vs step size
against a 16x-finer reference. Tests that the RK4 + finite-difference
gradient combination actually achieves its design order — a wrong gradient
or step-update would show up as a shallower slope.

**Reading the plot:** both axes log; dots are measured final-position
errors, the dashed line has slope 4. Points parallel to the line confirm
4th order. **Measured slope: 4.082.**

**Inputs:** ray from (20, 7, 2) M aimed off-plane (genuinely 3D, no
symmetry to hide errors), step counts 500–16000 over affine length 45 M.

## 2. Schwarzschild critical impact parameter (`plots/bcrit_schwarzschild.png`)

**What/why:** at a = 0 the capture boundary is exactly b = 3√3 M ≈ 5.19615 M
— the classic strong-field benchmark. Rays are fired with graded impact
parameters; bisection (48 halvings) locates the boundary.

**Reading the plot:** each dot is a ray at its conserved λ = L_z/E;
top row captured, bottom escaped. The green dotted line (measured boundary)
should coincide with the black dashed analytic 3√3 M.
**Measured λ_c = 5.196155 M, relative error 4.90e-07.**

**Inputs:** equatorial rays from r₀ = 30 M; bracket [3, 6] M chosen to
straddle 5.196 M comfortably.

## 3. Kerr photon shell at a = 0.9 (`plots/photon_shell.png`)

**What/why:** frame dragging splits the photon orbit by orbital sense. The
marginally escaping ray of each sense skims its photon orbit, so its
minimum KS radius measures r_ph; compared against the analytic
r_ph = 2M(1 + cos(⅔ arccos(∓a/M))).

**Reading the plot:** per sense, dashed line = analytic radius, solid
line = traced minimum radius; coincident pairs confirm the spin-split
photon shell. **Prograde: traced 1.5579 vs analytic 1.5579 M
(err 8.64e-06); retrograde: 3.9103 vs 3.9103 M
(err 1.10e-05).**

**Inputs:** equatorial rays at a = 0.9, prograde bracket [0.5, 5] M,
retrograde [−4.5, −9] M (sign of the offset sets the sign of L_z).

## 4. Conservation drift (`plots/conservation_drift.png`)

**What/why:** E, L_z and H are exact constants of motion; their numerical
drift is pure integration error. E = −p_t is conserved *identically by
construction* (∂H/∂t = 0 means p_t is never updated), so the plot shows the
two nontrivial monitors along a near-critical ray that winds close to the
photon shell — the hardest sustained-strong-field case.

**Reading the plot:** top panel, log-scale |H| (solid) and relative L_z
drift (dashed) per step for both rays; bottom panel shows r(step) for
orientation. Both rays use the *production* adaptive stepping (10%
displacement per step) — this study validates the renderer's operating
accuracy, not the method's floor (the convergence study shows the same
scheme reaches ~1e-11 at fine fixed steps). The generic flyby (blue) sits
at the step-policy-dominated level ~1e-6. The near-critical ray (orange)
winds close to the photon shell, where the orbit instability amplifies
numerical error by ~e^(2π) per winding: its drift is expected to be
another order of magnitude larger — the pass criterion there is *bounded
and small*, not machine-level, which would be dynamically impossible.
**Generic: max |H| = 2.02e-06, max L_z drift =
3.98e-07 over 117 steps.
Near-critical: max |H| = 1.59e-05, max L_z drift =
3.43e-06 over 703 steps
(min r = 1.618 M).**

## 5. Free fall vs the cycloid (`plots/freefall_cycloid.png`)

**What/why:** the Phase 8 free-fall camera integrates a *timelike* geodesic
with the same Hamiltonian machinery (H = -1/2, affine parameter = proper
time). Radial infall from rest in Schwarzschild has the closed-form cycloid
solution r = (r0/2)(1+cos eta), tau = sqrt(r0^3/8M)(eta + sin eta), making
it the clean end-to-end test of the timelike branch, including the
non-obvious Kerr-Schild initial condition p_i = f l_i / sqrt(1-f) != 0 for
an observer at rest.

**Reading the plot:** top panel, integrated r(tau) over the analytic
cycloid (dashed) — they must be indistinguishable; bottom panel, relative
error on a log scale.
**Max relative error: 7.08e-10 over 44711 steps from r0 = 12 M.**

## 6. Weak-field deflection (`plots/weakfield_deflection.png`)

**What/why:** the Phase 10 linearized multi-mass mode swaps only the
Hamiltonian's metric; its integrator is checked against the classic
deflection alpha = 4M/b over b in [10, 1000] M, plus far-field additivity
for two separated masses.

**Reading the plot:** top, alpha(b) log-log over the 4M/b line — parallel
means slope -1 with the right coefficient; bottom, the relative residual,
which follows the ~10M/b second-order envelope: the departures at small b
are the metric's own higher-order deflection, not integration error.
**b = 1000: ratio 1.00279; tail slope -1.0080;
two-mass additivity ratio 1.0330 (vs per-mass 4M_k/b_k sum).**

## 7. PN chirp + ringdown fits vs GW150914 (`plots/pn_chirp.png`)

**What/why:** merger mode (Phase 13) drives the animation and the audio
from TaylorT4 phasing; this study validates the phasing pipeline against
the best-measured event. Detector-frame masses (source 35.6 + 30.6 Msun at
z = 0.09) because observed frequencies scale with (1+z)m — see
docs/derivations.md §12.

**Reading the plot:** top, the GW frequency sweep f_GW(t) from 35 Hz to the
ISCO on a log axis — the accelerating "chirp"; the dashed red line is the
remnant's (2,2,0) quasinormal-mode frequency the blend must reach. Bottom,
the (Newtonian-map) separation in M shrinking toward merger. The chirp
duration printed in the title is the 35 Hz-to-ISCO segment; the published
~0.2 s of loud GW150914 signal additionally includes the post-ISCO
merger portion that PN cannot describe (the schematic blend's job).
**Chirp 35 Hz→ISCO: 0.091 s (leading-order analytic band
0.124 s); 0PN integrator self-check err
3.49e-09; phase-increment convergence |dphi(3.5PN)| =
0.462 rad < |dphi(1PN)| = 14.410 rad;
QNM f = 249.3 Hz, tau = 4.14 ms (published
GW150914 ringdown ≈ 250 Hz, ≈ 4 ms).**

**Inputs:** 35 Hz start (the detector band edge used in the discovery
paper); orders 1PN–3.5PN for the convergence ladder; QNM from the
published remnant (M_f = 63.1 Msun, a_f = 0.69).

## 8. Superposed Kerr–Schild binary metric (`plots/superposed_ks.png`)

**What/why:** merger mode renders two holes with the superposed-KS metric
whose inverse is closed-form via two Sherman–Morrison rank-1 updates
(docs/derivations.md §11). Three properties are load-bearing: the inverse
must be *exact* (the integrator differentiates H = ½ p g⁻¹ p), the single-
hole limit must reduce to Kerr (anchors to everything already validated),
and the far field must reproduce additive deflection (continuity with the
weak-field mode).

**Reading the plot:** left, log–log deviation of the binary inverse from
the exact single-Kerr inverse as the second mass M₂ → 0 — points parallel
to the slope-1 guide confirm the superposition error is first order in the
second hole's amplitude, i.e. the limit is approached at the expected rate.
Right, measured deflection past two equal holes vs the additive prediction
Σ 4Mₖ/bₖ.
**Inverse exactness: max |g·g⁻¹ − 1| = 4.44e-16 over 200
random strong-field points; limit slope 1.000; additivity
ratio 0.9958 at b = 300 M.**

**Inputs:** generic unequal masses/spins (1.0, a = 0.7 and 0.6, a = −0.18)
and off-axis probe points — no symmetry to hide index or sign errors;
static (unboosted) superposition, the Phase 13 scope (the boost enters with
the Phase 14 shader and carries its own check).

## Checks

| Check | Status |
|---|---|
| convergence slope in [3.7, 4.3] | ✓ |
| b_crit rel err < 1e-4 | ✓ |
| prograde r_ph rel err < 1% | ✓ |
| retrograde r_ph rel err < 1% | ✓ |
| generic-ray max |H| < 1e-5 | ✓ |
| generic-ray L_z drift < 1e-5 | ✓ |
| near-critical max |H| < 1e-4 | ✓ |
| near-critical L_z drift < 1e-4 | ✓ |
| free-fall vs cycloid rel err < 1e-8 | ✓ |
| deflection 4M/b at b=1e3 within 1% | ✓ |
| deflection log-log slope -1 (2%) | ✓ |
| two-mass additivity within 4% | ✓ |
| T4 0PN reproduces leading chirp time (0.5%) | ✓ |
| PN phase converges (|dphi 3.5PN| < |dphi 1PN|) | ✓ |
| GW150914 chirp 35 Hz to ISCO in [0.05, 0.3] s | ✓ |
| GW150914 QNM f in [240, 260] Hz | ✓ |
| GW150914 QNM tau in [3, 5.5] ms | ✓ |
| binary inverse exact (< 1e-12) | ✓ |
| single-hole-limit slope 1 (±0.1) | ✓ |
| binary far-field additivity within 3% | ✓ |

## Failure handling

Failures (any ✗ above) exit nonzero. See git history of this file for any
failures encountered during development and their fixes.
