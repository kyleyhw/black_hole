# Numerics

How the geodesic integration is actually computed in the fragment shader,
and why each choice was made. The underlying mathematics is derived in
[derivations.md](derivations.md); the float64 mirror used for validation is
[`../validation/kerr.py`](../validation/kerr.py) and its results are in
[`../validation/reports/validation.md`](../validation/reports/validation.md).

## State and formulation

Each ray carries a 6-dimensional state (x, p): spatial position and spatial
covector momentum. The time components are eliminated exactly, not
approximated: stationarity makes p_t constant (fixed to 1 by the
past-directed normalization, derivations.md §4), and t(λ) is not needed for
imaging. Hamilton's equations for H = ½ g^{μν} p_μ p_ν require no
Christoffel symbols — only the inverse metric, which the Kerr–Schild form
gives in closed form with no matrix inversion (derivations.md §2).

## Integrator: classical RK4

- **Why RK4:** 4th order at 4 right-hand-side evaluations per step is the
  standard sweet spot; the validation suite measures slope 4.08 on a
  strong-field flyby. Symplectic integrators were not needed — rays are
  integrated for hundreds of steps, not millions, and the |H| monitor shows
  bounded drift at production step sizes (~10⁻⁶ in f64).
- **Gradient by central differences:** ∂H/∂xⁱ is evaluated as
  (H(x+εeᵢ) − H(x−εeᵢ))/2ε — six extra metric evaluations per RHS call,
  ~30 lines of code, no hand-derived metric derivatives to get wrong.
- **ε = 2×10⁻³ max(r, 1)** in the f32 shader. This comes from minimizing
  truncation (∝ ε²) against roundoff (∝ ε_machine/ε): the f32 optimum is
  ~7×10⁻³ ℓ, and the value sits slightly below it so truncation stays
  subdominant (derivations.md §5). The f64 validation mirror uses 10⁻⁵ r.
  The blueprint's original 10⁻⁴ r is an f64-appropriate value that is
  roundoff-dominated in f32 — a real precision trap this project hit and
  documented rather than papered over.

## Adaptive step size

dλ = clamp( 0.1 · min(r − 0.9 r_H, r) / |dx/dλ| , 10⁻⁴, 4 )

Each step moves the ray ~10% of the local length scale in *coordinate
distance*, not in affine parameter. Dividing by the coordinate speed is
essential: near the horizon, past-directed shadow rays blueshift
exponentially (|p| grows without bound), and a fixed-dλ step would move RK4
substates by many M, scattering them into fake escapes — the failure mode
found and fixed in Phase 3 (see e2e/reports/phase3.md). The clamp floor
10⁻⁴ bounds work per step; the cap 4 M keeps the weak-field legs cheap.

## Termination

| Condition | Trigger | Meaning |
|---|---|---|
| Capture (radius) | r < r_+ (1 + 0.02 √(1−a²)) + 10⁻³ | inside the horizon buffer |
| Capture (blueshift) | \|p\|² > 10⁸, written NaN-proof as `!(≤)` | horizon-hugging past-directed ray |
| Escape | r > 200 M | maps to the starfield by final velocity direction |
| Budget | uMaxSteps (quality slider) | treated as captured (photon-shell strugglers) |

Two non-obvious choices, both found by testing at a = 0.998:

1. **The capture buffer scales with √(1−a²)** (~ surface gravity). A fixed
   1.02 r_+ buffer sits *outside* the prograde photon orbit near-extremal
   (r_ph − r_+ = 0.014 M at a = 0.998) and would clip real photon-ring
   physics.
2. **The momentum capture exists because the traced rays are
   past-directed.** In ingoing-type Kerr–Schild coordinates they cannot
   cross the horizon backwards; they hug it with exponentially growing |p|.
   Huge blueshift relative to E = 1 is a physical shadow diagnostic, and
   terminating on it prevents f32 overflow from corrupting the state.

## Precision

`precision highp float` is forced in every shader: on mobile GPUs mediump
(often fp16) silently destroys the integration. All shader arithmetic is
f32 (WebGL2 has no f64); every guard (`max` under square roots, the r-floor
in l_μ = z/r, the NaN-proof capture comparison) exists to keep f32
edge-cases from propagating. The validation suite runs the identical
algorithm in f64 to separate algorithmic error from precision error: the
convergence study shows the method reaches ~10⁻¹¹ M at fine fixed steps,
i.e. the production error budget is set by the step policy and by f32, not
by the scheme.

## Loop structure (driver friendliness)

The integration loop has a compile-time bound (`HARD_CAP = 1024`) with the
runtime budget enforced by an early `break` — some GLSL drivers mishandle
fully dynamic loop bounds. Disk bisection re-integrates from the stored
previous state (3 halvings + linear interpolation), so hit points lie on
the true geodesic rather than on a chord.
