# Validation Suite Report

**Command:** `uv run python run_validation.py` · **Total runtime:** 16.5 s
(convergence 9.8 s, b_crit 1.1 s,
photon shell 5.2 s, drift 0.3 s)

**Result: PASS** — 8/8 checks.

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

## Failure handling

Failures (any ✗ above) exit nonzero. See git history of this file for any
failures encountered during development and their fixes.
