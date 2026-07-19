# Documentation Index

Documentation for the Kerr black hole ray tracer. The project-level overview
and directory structure live in the root [README](../README.md); the phased
development plan and full technical specification live in
[PROJECT_PLAN.md](../PROJECT_PLAN.md).

### Physics and method

| Document | Contents |
|---|---|
| [derivations.md](derivations.md) | First-principles derivations of everything the shader implements: Kerr–Schild radial coordinate and metric inverse, Hamiltonian geodesic formulation, the $p_t$ quadratic and time-orientation root selection, the coordinate-camera apparent-angle relation, finite-difference gradient scheme with f32 step-size analysis, disk kinematics ($\Omega$, $u^t$, ISCO), redshift factor, and the $g^4$ beaming law. Includes the correction of the blueprint's $u^t$ formula. Merger mode (§11–13): superposed Kerr–Schild binary metric with the exact Sherman–Morrison inverse, TaylorT4 PN phasing and the chirp, remnant/QNM fits, and the time-mapping design. |
| [numerics.md](numerics.md) | Integrator choices, adaptive step-size heuristic, termination conditions (including the near-extremal capture-buffer scaling and momentum-blowup capture), FD epsilon rationale, f32 precision policy, loop structure. |
| [rendering.md](rendering.md) | Disk shading model (hit bisection, g, g⁴, blackbody ramp, differential-rotation noise, transparency), procedural starfield and its known magnification artifact, HDR bloom + ACES pipeline, overlays, camera model. |

### Software and verification

| Document | Contents |
|---|---|
| [architecture.md](architecture.md) | Software structure: the one-algorithm/three-expressions strategy (GLSL, WGSL, float64) and how parity is policed, the render-pipeline data flow, the module map, the CPU-f64/GPU-f32 split, compile-time shader variants, and the e2e testing harness (software WebGL2, test seams). |
| [validation.md](validation.md) | The two-tier verification philosophy (numerical-analytic vs behavioural-browser), the float64 mirror rationale, and a summary of the six validation studies. |

Test reports: [`../e2e/reports/`](../e2e/reports/) (browser end-to-end, one
per phase), [`../validation/reports/validation.md`](../validation/reports/validation.md)
(numerical validation suite, with per-plot interpretation).
