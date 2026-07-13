# Documentation Index

Documentation for the Kerr black hole ray tracer. The project-level overview
and directory structure live in the root [README](../README.md); the phased
development plan and full technical specification live in
[PROJECT_PLAN.md](../PROJECT_PLAN.md).

| Document | Contents |
|---|---|
| [derivations.md](derivations.md) | First-principles derivations of everything the shader implements: Kerr–Schild radial coordinate and metric inverse, Hamiltonian geodesic formulation, the $p_t$ quadratic and time-orientation root selection, finite-difference gradient scheme with f32 step-size analysis, disk kinematics ($\Omega$, $u^t$, ISCO), redshift factor, and the $g^4$ beaming law. Includes the correction of the blueprint's $u^t$ formula. |
| numerics.md *(Phase 7)* | Integrator choices, adaptive step-size heuristic, termination conditions, epsilon rationale. |
| rendering.md *(Phase 7)* | Disk shading model, procedural starfield construction, bloom and tonemapping. |

Test reports: [`../e2e/reports/`](../e2e/reports/) (browser end-to-end),
`../validation/reports/` (numerical validation suite, Phase 4).
