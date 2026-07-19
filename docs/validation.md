# Validation and Verification

How the project establishes that the rendered images are correct, not merely
plausible. Two independent tiers do this, and it is worth being explicit about
which question each answers.

## Two tiers, two questions

| Tier | Location | Question it answers | Oracle |
|---|---|---|---|
| **Numerical validation** | `validation/` (Python, float64) | *Is the algorithm mathematically correct?* | closed-form strong-field GR results |
| **Behavioural end-to-end** | `e2e/` (Playwright, the real WebGL2 build) | *Does the shipped product do what the algorithm says?* | pixel statistics of the actual canvas |

The two are complementary. The validation suite can prove the integrator
recovers 3√3 M to seven digits but says nothing about whether the shader that
ships is wired up correctly; the e2e suite renders the real thing but can only
assert coarse pixel facts. Passing both is the argument that the physics is
right *and* reaches the screen. The architecture that connects them — the
shared algorithm expressed once in GLSL, once in WGSL, once in float64 Python —
is described in [architecture.md](architecture.md).

## Numerical validation — the float64 mirror

The core idea is a **mirror**: `validation/kerr.py` re-implements the shader's
exact algorithm — the same Hamiltonian H = ½ gᵘᵛ pᵤ pᵥ, the same RK4 step, the
same central-difference gradient, the same adaptive step rule and termination
conditions (derived in [derivations.md](derivations.md) and
[numerics.md](numerics.md)) — but in **float64** on the CPU, line-parallel with
`render.frag.glsl` so the two can be cross-read.

Why a mirror rather than testing the shader directly:

- **It isolates *algorithm* error from *precision* error.** The shader runs in
  f32 by hardware necessity; the mirror runs in f64. If a strong-field result
  is wrong in both, the algorithm is wrong; if it is right in f64 and only
  degrades in f32, the cause is precision, and the fix is a numerics decision
  (step floor, ε scaling) rather than a physics one. Conflating the two would
  make every discrepancy ambiguous.
- **It admits analytic oracles.** GR supplies exact answers for special cases
  (the Schwarzschild capture radius 3√3 M, the Kerr photon-shell radii, the
  radial-infall cycloid, the weak-field 4M/b deflection). A CPU integrator can
  be driven to those configurations and compared to machine precision; a
  real-time shader cannot be instrumented that finely.
- **`weakfield.py`** mirrors the linearized multi-mass metric the same way, so
  the `#define WEAK_FIELD` shader variant has its own float64 oracle.
- **`superposed.py`** mirrors the merger mode's superposed Kerr–Schild binary
  metric (Sherman–Morrison inverse; derivations.md §11), and **`pn.py`**
  implements the TaylorT4 phasing and QNM fits that drive the merger
  animation and chirp audio (derivations.md §12–13).

The eight studies and, crucially, **how to read each of their plots** (what
the axes are, what pattern confirms the result, and the measured numbers) are
documented in the run report:
[`validation/reports/validation.md`](../validation/reports/validation.md). In
summary they establish, respectively:

1. **Convergence order** — the RK4 + FD-gradient scheme is genuinely 4th order
   (measured slope 4.08), so the integrator has no order-reducing bug.
2. **Schwarzschild b_crit** — the capture boundary matches 3√3 M to 5×10⁻⁷.
3. **Kerr photon shell** — the spin-split prograde/retrograde photon radii
   match the analytic frame-dragging formula to ~10⁻⁵.
4. **Conservation drift** — the constants of motion (H, L_z) stay bounded and
   small under *production* stepping, including on a near-critical ray where
   orbit instability amplifies error.
5. **Free-fall cycloid** — the timelike branch (the free-fall camera) matches
   the closed-form radial-infall solution to 7×10⁻¹⁰.
6. **Weak-field deflection** — the linearized mode recovers 4M/b and two-mass
   far-field additivity, with small-b departures tracking the metric's *own*
   higher-order term, not integrator error.
7. **PN chirp + ringdown** — the TaylorT4 integrator reproduces the analytic
   leading-order chirp time at 0PN (3×10⁻⁹), converges order-by-order, and the
   QNM fits give GW150914's published ringdown (249 Hz, 4.1 ms).
8. **Superposed-KS binary** — the Sherman–Morrison inverse is exact to
   machine precision, the single-hole limit is approached at the expected
   first-order rate (slope 1.00004), and the far field is additive (0.4%).

Run it with `uv run python run_validation.py` from `validation/` (a `uv`
project; see [§9 of the workflow](../README.md#build)). It writes the plots
to `validation/plots/` and regenerates the report, exiting non-zero on any
failed check so it is CI-usable.

## Behavioural end-to-end

The e2e tier renders the actual build in a headless browser and asserts pixel
statistics. Its design — the `vite preview` + software-WebGL2 harness, why
software rasterisation gives *exact* f32 rather than an approximation, the
per-test seams (`__bhTest`, `__bhDiskTime`, …), and the GLSL↔WGSL parity
check — is documented in [architecture.md](architecture.md#testing). Each phase
has its own report under [`../e2e/reports/`](../e2e/reports/) recording runtime,
what was tested and why, and any failures with their fixes.

A recurring principle in those reports is worth stating once: **a behavioural
test must isolate the quantity it claims to measure.** Where a whole-frame
statistic would fold in an unrelated rendering choice — e.g. disk-beaming
asymmetry contaminated by the lensed starfield — the test is reworked to
measure the isolated quantity (disk-on minus disk-off cancels the stars
exactly) rather than to have its threshold loosened. A loosened threshold hides
a regression; an isolated measurement removes the confound.
