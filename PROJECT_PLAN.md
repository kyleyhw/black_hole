# Project Development Plan

This document outlines the planned phases and tasks for developing the **Kerr Black Hole Ray Tracer** — a browser-based, real-time renderer integrating null geodesics of the Kerr metric (Kerr–Schild coordinates, Hamiltonian formulation, RK4) in a WebGL2 fragment shader. The technical blueprint, including the full physics specification, lives in [`PLAN.md`](PLAN.md); tasks below reference its sections (e.g. *PLAN §2.2*). Phases 2–8 each end at a **review checkpoint**: work pauses for explicit confirmation before the next phase begins.

## Phase 0: Repository and Planning

1. [completed] Initialize repository on branch `claude/kerr-black-hole-raytracer-02tz1w` with `.gitignore` (`.env`, `.DS_Store`, `venv/`, `node_modules/`, `dist/`).
2. [completed] Commit blueprint as `PLAN.md` and this development plan as `PROJECT_PLAN.md`.
3. [pending] Review this plan with the project owner; obtain explicit confirmation before Phase 1.

## Phase 1: Scaffold, Flat-Space Renderer, and Deployment (PLAN §3, §6 M1)

4. [pending] Vite + vanilla TypeScript scaffold; GLSL shaders as `?raw` imports; no framework, no engine.
    - Pre-commit hooks (`ruff`, `ty`, `detect-secrets` with baseline) configured once the Python toolchain exists in Phase 4; `detect-secrets` alone configured here.
5. [pending] WebGL2 boilerplate: context creation, shader compile/link with error surfacing, fullscreen triangle, `precision highp float` enforced, uniform plumbing.
6. [pending] Pinhole camera: orbit controls (drag azimuth/elevation, clamped ±89°; scroll zoom clamped to r ∈ [2.2 M, 60 M]), per-pixel flat-space ray directions.
7. [pending] Procedural starfield (PLAN §2.6): cube-map-style cell hashing, sub-cell jitter, power-law brightness, temperature color ramp.
8. [pending] GitHub Pages deployment via Actions on push (`vite build` → static site). Deliverable: navigable starfield on a live URL.
9. [pending] Commit; **checkpoint**: verify live deploy and camera feel before proceeding.

## Phase 2: Derivations (PLAN §7 — derive before implementing)

10. [pending] Write `docs/derivations.md` with full step-by-step derivations (LaTeX):
    - Kerr–Schild metric, inverse metric, and the r-coordinate root solve with degenerate-case guards (z → 0, small ρ).
    - Null-condition quadratic for p_t and the future-pointing root selection criterion.
    - Hamilton's equations with the finite-difference gradient scheme and its error/step-size trade-off.
    - Redshift factor g = 1/[u^t (1 − Ω λ)] for a prograde equatorial circular emitter and observer at infinity, including u^t and Ω derivations and sign conventions.
11. [pending] **Checkpoint**: derivations reviewed and signed off by the project owner before any physics GLSL is written. This is the highest-leverage review point in the project.

## Phase 3: Kerr Geodesic Integrator in the Shader (PLAN §2.1–2.4, §6 M2)

12. [pending] Kerr–Schild metric evaluation in GLSL (r-root with guarded square roots) and Hamiltonian H = ½ g^{μν} p_μ p_ν.
13. [pending] RK4 integration of Hamilton's equations with finite-difference ∂H/∂x (option (a)); adaptive dλ heuristic clamped to [dλ_min, dλ_max]; fixed max-step loop with early-out flag (driver-safe).
14. [pending] Termination logic: capture at r < 1.02 r_+, escape to starfield, budget-exceeded handling.
15. [pending] **Debug false-color views built before first full render**: step count, |H| drift, final r.
16. [pending] Spin uniform a/M ∈ [0, 0.998] wired to a provisional slider; verify shadow asymmetry appears with spin; Einstein ring and lensed stars visible.
17. [pending] Commit; **checkpoint**: inspect debug views (bounded |H| drift, sane step counts) and shadow morphology before validation phase.

## Phase 4: Python Validation Suite (PLAN §5, §6 M3)

18. [pending] `validation/` as a `uv` project (`uv init`, `uv add numpy matplotlib`, dev tools `ruff`, `ty`, `detect-secrets`); full type annotations (`NDArray[np.float64]`); complete pre-commit hook configuration.
19. [pending] NumPy mirror of the shader integrator (same Hamiltonian, same RK4, same FD gradients), ~150 lines.
20. [pending] Produce four validation plots, each with interpretation notes (axes, expected pattern, takeaway):
    - Convergence order: global error vs dλ, log–log, slope-4 reference line.
    - Schwarzschild critical impact parameter via capture/escape bisection → b_crit vs 3√3 M.
    - Kerr photon shell at a = 0.9: prograde/retrograde equatorial photon orbit radii vs analytic r_ph.
    - Conservation drift: E, L_z, |H| along a 500-step strong-field ray.
21. [pending] Test report in `validation/reports/` (what/why/inputs/runtime; failures and fixes documented). Fix any physics discrepancies **now**, before the disk exists.
22. [pending] Commit plots and report; **checkpoint**: review plots together before Phase 5.

## Phase 5: Relativistic Accretion Disk (PLAN §2.5, §6 M4)

23. [pending] Equatorial plane-crossing detection (z sign change) with 2–3 bisection refinements per hit.
24. [pending] Disk kinematics: Ω(r), r_ISCO(a) (Bardeen–Press–Teukolsky), u^t; redshift g from conserved E, L_z per the Phase 2 derivation.
25. [pending] Shading: g⁴ beaming × radial emissivity; blackbody color ramp with temperature scaled by g; 2–3 octave value noise in (log r, φ − Ω t) for differential rotation.
26. [pending] Semi-transparent accumulation: deposit weighted color and continue integrating (lensed upper/lower disk images, photon-ring structure).
27. [pending] Commit; **checkpoint**: verify the approaching/receding brightness and color asymmetry matches the derived sign conventions.

## Phase 6: UI, Overlays, and Post-processing (PLAN §4, §6 M5)

28. [pending] Custom control panel (dark glass, collapsible sections, live physics-unit readouts): spin, mass-as-scale, disk controls with r_in locked to live r_ISCO(a), quality (max steps, resolution scale, bloom), beaming toggle.
29. [pending] Presets: Schwarzschild (a = 0), Interstellar-ish (a = 0.6), near-extremal (a = 0.998).
30. [pending] Overlays and diagnostics: ergosphere shell, photon-shell markers, r_+ readout, debug-view dropdown; FPS counter; PNG screenshot button.
31. [pending] Float-texture render target with resolution scaling; two-pass separable Gaussian bloom; ACES-ish tonemap composite.
32. [pending] Footer + About modal with the core equations and repo link.
33. [pending] Commit; **checkpoint**: full interaction pass on the live deploy.

## Phase 7: Documentation and Release (PLAN §8, §6 M6)

34. [pending] `docs/` folder: derivations (from Phase 2), numerics notes (integrator choices, step-size heuristic, FD epsilon rationale), rendering notes (disk model, starfield, bloom), all cross-referenced from a docs index.
35. [pending] `README.md`: hero image/GIF + live demo link; physics (KS metric, Hamiltonian, KS-over-BL rationale); numerics; the four validation plots each with interpretation; rendering; controls table; ASCII directory tree; documentation index; numbered references (MTW/Chandrasekhar, Bardeen–Press–Teukolsky 1972, James et al. 2015).
36. [pending] In-browser cross-check: rendered shadow angular size vs analytic prediction at known camera distance; record result in README.
37. [pending] Final deploy, social-preview image, final commit and push.

## Phase 8: Stretch Goals (explicitly out of scope until Phases 0–7 are complete and reviewed)

38. [pending] Free-fall camera on a timelike radial geodesic (CPU-integrated) — first if time permits.
39. [pending] Redshifted starfield for a moving camera; retrograde disk toggle; disk inclination.
40. [pending] WebGPU progressive-accumulation port for high-quality stills.

---

**Descoping ladder** (PLAN §6), if behind schedule, cut in order: ergosphere overlay → free-fall camera → bloom → transparent disk (opaque single image) → adaptive stepping (fixed dλ, more steps). **Never cut:** validation plots, debug views, the spin slider, README derivations.
