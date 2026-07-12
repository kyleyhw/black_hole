# Project Development Plan

This document is both the technical specification and the phase-by-phase task tracker for the **Kerr Black Hole Ray Tracer** — a browser-based, real-time, interactive black hole renderer that integrates **actual null geodesics of the Kerr metric** in a WebGL2 fragment shader. Spin slider from a = 0 (Schwarzschild) to near-extremal. Free orbit camera, relativistic accretion disk, procedural starfield, polished UI, deployed as a static site anyone can open in a browser.

Portfolio thesis: *physics → numerics → validation → rendering*, in that order. The README leads with the equations being integrated and the plots proving the integrator works, not just pretty pictures.

Part I is the specification; Part II is the task list. Tasks reference specification sections (e.g. *§2.2*). Phases 1–8 each end at a **review checkpoint**: work pauses for explicit confirmation before the next phase begins.

---

# Part I: Technical Specification

## 1. Headline architecture decision

**One integrator: full Kerr geodesics in Kerr–Schild (Cartesian) coordinates. Schwarzschild is the a = 0 special case for free.**

Rationale, worth stating in the README:

- The Schwarzschild plane-reduction trick (Binet equation) does not generalize to Kerr — frame dragging makes geodesics genuinely 3D. Since Kerr is in scope, build the general integrator once and get Schwarzschild as a slider position rather than a separate code path.
- **Kerr–Schild over Boyer–Lindquist.** BL coordinates are singular at the horizon and on the polar axis, and the first-order (E, L_z, Carter Q) formulation requires tracking turning-point signs of √R(r) and √Θ(θ) — a classic source of visual artifacts. Kerr–Schild coordinates are horizon-penetrating, Cartesian, axis-regular, and rays that cross the horizon simply keep integrating until a capture condition triggers. Fewer branches, fewer bugs, cleaner shader.
- Hamiltonian formulation: integrate `H = ½ g^{μν}(x) p_μ p_ν` with Hamilton's equations. No Christoffel symbols needed; conserved H ≈ 0 is a built-in per-ray error monitor.

## 2. Physics specification

### 2.1 Metric (Kerr–Schild form, geometrized units G = c = 1, M = 1 base scale)

```
g_μν = η_μν + f l_μ l_ν          g^{μν} = η^{μν} − f l^μ l^ν   (l is null, so the inverse is exact)
f = 2 M r³ / (r⁴ + a² z²)
l_μ = ( 1,  (r x + a y)/(r² + a²),  (r y − a x)/(r² + a²),  z/r )
```

where r is the Kerr–Schild radial coordinate, defined by the largest root of

```
r⁴ − r² (ρ² − a²) − a² z² = 0,   ρ² = x² + y² + z²
⇒ r² = ½ (ρ² − a²) + √( ¼ (ρ² − a²)² + a² z² )
```

Signature (−,+,+,+). Note M is scale-free: the mass "slider" is implemented as a global length rescale, which is exactly correct physics — say so in the README.

### 2.2 Equations of motion

Hamilton's equations for the null geodesic:

```
dx^μ/dλ = ∂H/∂p_μ = g^{μν} p_ν
dp_μ/dλ = −∂H/∂x^μ = −½ ∂_μ g^{αβ} p_α p_β
```

Two implementation options for `∂_μ g^{αβ}` — do **(a)** first:

- **(a) Finite-difference gradient of H.** Evaluate H at x ± ε per spatial axis (ε ≈ 1e-4 · r). 6 extra metric evaluations per RHS call, but ~30 lines of shader code and near-impossible to get wrong. Ship this.
- **(b) Analytic derivatives of f and l_μ.** ~2–3× faster. An optimization for the end of the day *if* profiling says you need it; derive on paper and diff against (a) numerically before trusting it.

Integrator: RK4, adaptive step `dλ ∝ min(r − r_horizon-ish, r)/|dr/dλ|`-style heuristic — small steps near the hole, large steps far away. Clamp to [dλ_min, dλ_max], hard cap ~400–600 steps/ray, exposed as a "quality" slider.

Initial conditions per pixel: camera at rest at radius r_cam; build the ray direction from the pixel through a standard pinhole camera basis; set p_i from the direction and solve the null condition `g^{μν} p_μ p_ν = 0` for p_t (quadratic; take the future-pointing root). Normalize so E ≡ −p_t = 1.

### 2.3 Termination conditions

- **Capture:** r < r_+ = M + √(M² − a²) (outer horizon), with a small buffer (e.g. r < 1.02 r_+) → pixel is shadow black (before disk/bloom).
- **Escape:** r > r_esc (e.g. 30 · r_cam or 200 M) → map the final momentum direction to the starfield.
- **Budget exceeded:** color by a debug tint in debug mode; in normal mode treat as captured (these rays are photon-shell strugglers).

### 2.4 Conserved quantities (free diagnostics + needed for the disk)

Kerr–Schild has the same Killing vectors ∂_t and ∂_φ, so along every ray:

```
E  = −p_t                    (conserved)
L_z = x p_y − y p_x          (conserved, Cartesian form of p_φ)
H  ≈ 0                       (null condition; drift = integration error)
```

Debug view: render |H| drift as false color. This is the single best shader-debugging tool in the project — build it in Phase 3, not at the end.

### 2.5 Accretion disk (equatorial, geometrically thin)

Disk occupies z = 0, r ∈ [r_ISCO(a), r_out] (r_out ≈ 12–16 M, slider). Detect plane crossing by sign change of z between steps; on detection, bisect the step 2–3 times for a clean hit point (prevents banding at high inclination).

Prograde circular orbit kinematics at radius r (BL formulas, valid on the equator where BL and KS r coincide):

```
Ω = √M / (r^{3/2} + a √M)
r_ISCO = M [ 3 + Z₂ − √((3 − Z₁)(3 + Z₁ + 2 Z₂)) ]        (prograde)
  Z₁ = 1 + (1 − a²/M²)^{1/3} [ (1 + a/M)^{1/3} + (1 − a/M)^{1/3} ]
  Z₂ = √( 3 a²/M² + Z₁² )
```

**Redshift factor** — the payoff of carrying conserved quantities. For an observer at rest at infinity and an emitter on the circular orbit:

```
g = E_obs / E_em = 1 / [ u^t (1 − Ω λ) ],    λ = L_z / E   (per ray, both conserved)
u^t = 1 / √(1 − 3M/r + 2 a √M / r^{3/2})     (prograde equatorial circular orbit)
```

This packages gravitational redshift, orbital Doppler, and frame dragging in one exact expression. **Derive/verify this before implementing (Phase 2) — sign and convention errors here are the most likely failure mode, and checking it against the project owner's GR knowledge is the review layer.**

Shading on hit:

- Intensity ∝ g⁴ (bolometric relativistic beaming) × radial emissivity profile (e.g. ∝ r^{−2} or the Novikov–Thorne-ish (1 − √(r_ISCO/r))/r³ if feeling fancy)
- Color: blackbody ramp lookup with temperature scaled by g (approaching side blue-white, receding side deep red — the iconic asymmetry)
- Texture: 2–3 octaves of value noise in (log r, φ − Ω(r) t) coordinates so the pattern differentially rotates; gives the disk life for free
- Semi-transparent accumulation: on a hit, deposit color weighted by an opacity < 1 and **continue integrating** — this produces the lensed image of the disk wrapped above/below the shadow and the multiple-image rings near the photon shell

### 2.6 Starfield (procedural, zero assets)

Hash-based random stars on the celestial sphere: quantize the escape direction into ~10⁵–10⁶ cells (cube-map-style projection of the direction vector to avoid polar clustering), 3D hash per cell decides star presence (~2–5%), sub-cell jitter for position, power-law brightness distribution, color from a small temperature ramp (blue → white → orange → red), brightness rendered as a tight smoothstep falloff around the star center so stars stay sub-pixel-crisp. Optional: faint procedural Milky Way band (soft noise stripe along a tilted great circle). All ~40 lines of GLSL. Gravitational lensing of the field — including star streaks into the Einstein ring and multiple imaging near the photon shell — comes entirely for free from the ray tracer.

## 3. Tech stack

- **WebGL2 + raw GLSL fragment shader** doing all physics; one fullscreen triangle. No Three.js — the boilerplate is ~150 lines and "no engine" is part of the flex. `highp float` everywhere (mandatory — mediump silently destroys the integration on mobile GPUs).
- **Vite + vanilla TypeScript.** Shaders as `?raw` imports or `.glsl` files with a tiny plugin. No framework.
- Render at a scalable internal resolution (0.5×/0.75×/1× device pixels) into a float texture, then a cheap two-pass separable Gaussian bloom + tonemap (ACES-ish) composite pass. Bloom is ~60 lines and does enormous aesthetic work on the disk.
- **Deploy: GitHub Pages via Actions on push** (`vite build` → static files). The repo link and the live demo link go at the top of the README. Set this up in Phase 1, not at the end — deploys stay one-command all day.

## 4. Interaction & UI spec

### Camera

- Left-drag: orbit around the hole (azimuth/elevation, elevation clamped to ±89°)
- Scroll / pinch: zoom, clamped to r ∈ [2.2 M, 60 M] — allowing inside the photon shell (r < ~3M) is fine in KS coordinates, but keep outside the horizon buffer
- Optional inertia with exponential damping; double-click to reset
- Stretch: a "free-fall" button that releases the camera onto a timelike radial geodesic (integrated on the CPU, trivially, per frame) — viscerally cool, cheap to add

### Control panel (custom, not lil-gui — the design is part of the showcase)

Dark theme; right-side floating glass panel (backdrop-filter blur, 1px light border, ~13px Inter/system font, tabular-lining numerals for readouts); collapsible sections; every slider shows its live value in physics units (e.g. `a = 0.94 M`, `r_in = r_ISCO = 2.04 M`).

- **Black hole:** spin a/M ∈ [0, 0.998] (Thorne limit — cite it, it's a nice touch); mass as scene-scale
- **Disk:** on/off; outer radius; inner radius display locked to r_ISCO(a) and updating live as spin changes (great physics-made-visible moment); emissivity/exposure; beaming on/off toggle (dramatic before/after)
- **Quality:** max steps slider; resolution scale; bloom strength
- **Overlays:** ergosphere surface (ρ_E: r = M + √(M² − a² cos²θ), faint wireframe/translucent shell); photon-shell radii markers; horizon readout r_+ ; debug view dropdown (none / step count / |H| drift / final r)
- **Presets:** `Schwarzschild (a=0)` · `Interstellar-ish (a=0.6, thin bright disk)` · `Near-extremal (a=0.998)` — one click each, they make the demo instantly legible to non-experts
- FPS counter (top corner, subtle) and a screenshot button (canvas → PNG download)

### Layout

Full-bleed canvas; panel top-right; a one-line footer ("Real-time integration of null geodesics in the Kerr metric — Kerr–Schild coordinates, RK4 — *About*") where *About* opens a small modal with the core equations and a link to the repo. The modal is your elevator pitch embedded in the artifact itself.

## 5. Validation suite (`validation/`, Python + matplotlib)

Mirror the integrator in ~150 lines of NumPy (same Hamiltonian, same RK4) and produce four plots for the README:

1. **Convergence order:** fixed-step error vs dλ for a strong-field flyby, log–log, against a tiny-step reference. Slope 4 line overlaid. One plot, thousand words.
2. **Schwarzschild critical impact parameter:** bisection on capture/escape at a = 0 → b_crit → 3√3 M ≈ 5.196 M.
3. **Kerr photon shell:** at a = 0.9, equatorial prograde/retrograde photon orbit radii vs the analytic `r_ph = 2M(1 + cos(⅔ arccos(∓a/M)))`; and/or the shadow's asymmetric edge vs analytic critical impact parameters.
4. **Conservation drift:** E, L_z, and H along a 500-step strong-field ray (should sit at machine-noise level for E, L_z; small bounded drift for H).
5. In-browser cross-check: measure the rendered shadow's angular size at a known camera distance vs the analytic prediction; one sentence + screenshot in the README.

Run this at Phase 4, *before* building the disk — physics bugs are much easier to isolate while the shader is still just shadow-and-stars.

## 6. Implementation working notes

- One commit per phase (at minimum) so shader breakage is bisectable.
- **Derive before implementing:** write out in `docs/derivations.md` the null-condition solve for p_t, the FD-Hamiltonian gradient scheme, and the redshift factor g — reviewed and signed off before any GLSL is written. This is the highest-leverage review point in the whole project.
- Build the **debug false-color views in Phase 3, before the first "why is the screen black" moment**, because that moment is otherwise guaranteed to cost an hour.
- Known pitfalls, stated upfront:
  - `mediump` precision (force `precision highp float;` and test on an integrated GPU early)
  - r-coordinate root selection near z = 0 and small ρ (guard the sqrt arguments)
  - step size too large near the photon shell → banded/noisy ring (adaptive dλ, quality slider)
  - plane-crossing tests that miss the disk when a step straddles z = 0 at high curvature (sign-change check + bisection)
  - future-pointing root selection in the p_t quadratic (wrong root = time-reversed rays = subtle nonsense)
  - loop unrolling / uniform-controlled loop bounds in GLSL (some drivers hate dynamic `break` patterns — use a fixed max with an early-out flag)
- Keep the fragment shader in one file with clearly banner-commented sections (metric / integrator / disk / starfield / shading); reviewers will read this file.

## 7. README skeleton (write it last, structure it now)

1. Hero GIF + live demo link
2. **The physics:** the KS metric, the Hamiltonian, why KS over BL (3 sentences), what's exact (everything rendered) — a deliberate contrast with typical "black hole shaders"
3. **The numerics:** RK4, adaptive stepping, FD gradients, conserved-quantity monitoring
4. **Validation:** the four plots, each with one sentence
5. **Rendering:** disk model (Ω, g, g⁴, blackbody), starfield, bloom
6. Controls table, build instructions, references (MTW/Chandrasekhar for geodesics; Bardeen–Press–Teukolsky 1972 for ISCO/photon orbits; James et al. 2015 *Gravitational lensing by spinning black holes in astrophysics, and in the movie Interstellar* — citing the DNGR paper signals you know the lineage of the technique)

## 8. Scoping

Honest scoping note: Kerr + disk + polish on a tight schedule is aggressive but achievable *because* of the KS/Hamiltonian/FD-gradient choices above, which minimize derivation and debugging surface.

**If behind schedule, cut in this order:** ergosphere overlay → free-fall camera → bloom → transparent disk (make it opaque, single image) → adaptive stepping (fixed dλ with higher step count). **Never cut:** validation plots, debug views, the spin slider, README derivations.

---

# Part II: Development Phases

## Phase 0: Repository and Planning

1. [completed] Initialize repository on branch `claude/kerr-black-hole-raytracer-02tz1w` with `.gitignore` (`.env`, `.DS_Store`, `venv/`, `node_modules/`, `dist/`).
2. [completed] Commit this development plan as `PROJECT_PLAN.md` (specification + task tracker in one document).
3. [in-progress] Review this plan with the project owner; obtain explicit confirmation before Phase 1.

## Phase 1: Scaffold, Flat-Space Renderer, and Deployment (§3)

4. [pending] Vite + vanilla TypeScript scaffold; GLSL shaders as `?raw` imports; no framework, no engine.
    - Pre-commit hooks (`ruff`, `ty`, `detect-secrets` with baseline) configured once the Python toolchain exists in Phase 4; `detect-secrets` alone configured here.
5. [pending] WebGL2 boilerplate: context creation, shader compile/link with error surfacing, fullscreen triangle, `precision highp float` enforced, uniform plumbing.
6. [pending] Pinhole camera: orbit controls (drag azimuth/elevation, clamped ±89°; scroll zoom clamped to r ∈ [2.2 M, 60 M]), per-pixel flat-space ray directions (§4).
7. [pending] Procedural starfield (§2.6): cube-map-style cell hashing, sub-cell jitter, power-law brightness, temperature color ramp.
8. [pending] GitHub Pages deployment via Actions on push (`vite build` → static site). Deliverable: navigable starfield on a live URL.
9. [pending] Commit; **checkpoint**: verify live deploy and camera feel before proceeding.

## Phase 2: Derivations (§6 — derive before implementing)

10. [pending] Write `docs/derivations.md` with full step-by-step derivations (LaTeX):
    - Kerr–Schild metric, inverse metric, and the r-coordinate root solve with degenerate-case guards (z → 0, small ρ) (§2.1).
    - Null-condition quadratic for p_t and the future-pointing root selection criterion (§2.2).
    - Hamilton's equations with the finite-difference gradient scheme and its error/step-size trade-off (§2.2).
    - Redshift factor g = 1/[u^t (1 − Ω λ)] for a prograde equatorial circular emitter and observer at infinity, including u^t and Ω derivations and sign conventions (§2.5).
11. [pending] **Checkpoint**: derivations reviewed and signed off by the project owner before any physics GLSL is written. This is the highest-leverage review point in the project.

## Phase 3: Kerr Geodesic Integrator in the Shader (§2.1–2.4)

12. [pending] Kerr–Schild metric evaluation in GLSL (r-root with guarded square roots) and Hamiltonian H = ½ g^{μν} p_μ p_ν.
13. [pending] RK4 integration of Hamilton's equations with finite-difference ∂H/∂x (option (a)); adaptive dλ heuristic clamped to [dλ_min, dλ_max]; fixed max-step loop with early-out flag (driver-safe, §6).
14. [pending] Termination logic (§2.3): capture at r < 1.02 r_+, escape to starfield, budget-exceeded handling.
15. [pending] **Debug false-color views built before first full render** (§2.4): step count, |H| drift, final r.
16. [pending] Spin uniform a/M ∈ [0, 0.998] wired to a provisional slider; verify shadow asymmetry appears with spin; Einstein ring and lensed stars visible.
17. [pending] Commit; **checkpoint**: inspect debug views (bounded |H| drift, sane step counts) and shadow morphology before validation phase.

## Phase 4: Python Validation Suite (§5)

18. [pending] `validation/` as a `uv` project (`uv init`, `uv add numpy matplotlib`, dev tools `ruff`, `ty`, `detect-secrets`); full type annotations (`NDArray[np.float64]`); complete pre-commit hook configuration.
19. [pending] NumPy mirror of the shader integrator (same Hamiltonian, same RK4, same FD gradients), ~150 lines.
20. [pending] Produce four validation plots (§5), each with interpretation notes (axes, expected pattern, takeaway):
    - Convergence order: global error vs dλ, log–log, slope-4 reference line.
    - Schwarzschild critical impact parameter via capture/escape bisection → b_crit vs 3√3 M.
    - Kerr photon shell at a = 0.9: prograde/retrograde equatorial photon orbit radii vs analytic r_ph.
    - Conservation drift: E, L_z, |H| along a 500-step strong-field ray.
21. [pending] Test report in `validation/reports/` (what/why/inputs/runtime; failures and fixes documented). Fix any physics discrepancies **now**, before the disk exists.
22. [pending] Commit plots and report; **checkpoint**: review plots together before Phase 5.

## Phase 5: Relativistic Accretion Disk (§2.5)

23. [pending] Equatorial plane-crossing detection (z sign change) with 2–3 bisection refinements per hit.
24. [pending] Disk kinematics: Ω(r), r_ISCO(a) (Bardeen–Press–Teukolsky), u^t; redshift g from conserved E, L_z per the Phase 2 derivation.
25. [pending] Shading: g⁴ beaming × radial emissivity; blackbody color ramp with temperature scaled by g; 2–3 octave value noise in (log r, φ − Ω t) for differential rotation.
26. [pending] Semi-transparent accumulation: deposit weighted color and continue integrating (lensed upper/lower disk images, photon-ring structure).
27. [pending] Commit; **checkpoint**: verify the approaching/receding brightness and color asymmetry matches the derived sign conventions.

## Phase 6: UI, Overlays, and Post-processing (§3, §4)

28. [pending] Custom control panel (dark glass, collapsible sections, live physics-unit readouts): spin, mass-as-scale, disk controls with r_in locked to live r_ISCO(a), quality (max steps, resolution scale, bloom), beaming toggle.
29. [pending] Presets: Schwarzschild (a = 0), Interstellar-ish (a = 0.6), near-extremal (a = 0.998).
30. [pending] Overlays and diagnostics: ergosphere shell, photon-shell markers, r_+ readout, debug-view dropdown; FPS counter; PNG screenshot button.
31. [pending] Float-texture render target with resolution scaling; two-pass separable Gaussian bloom; ACES-ish tonemap composite.
32. [pending] Footer + About modal with the core equations and repo link.
33. [pending] Commit; **checkpoint**: full interaction pass on the live deploy.

## Phase 7: Documentation and Release (§7)

34. [pending] `docs/` folder: derivations (from Phase 2), numerics notes (integrator choices, step-size heuristic, FD epsilon rationale), rendering notes (disk model, starfield, bloom), all cross-referenced from a docs index.
35. [pending] `README.md` (§7): hero image/GIF + live demo link; physics (KS metric, Hamiltonian, KS-over-BL rationale); numerics; the four validation plots each with interpretation; rendering; controls table; ASCII directory tree; documentation index; numbered references (MTW/Chandrasekhar, Bardeen–Press–Teukolsky 1972, James et al. 2015).
36. [pending] In-browser cross-check (§5.5): rendered shadow angular size vs analytic prediction at known camera distance; record result in README.
37. [pending] Final deploy, social-preview image, final commit and push.

## Phase 8: Stretch Goals (explicitly out of scope until Phases 0–7 are complete and reviewed)

38. [pending] Free-fall camera on a timelike radial geodesic (CPU-integrated) — first if time permits.
39. [pending] Redshifted starfield for a moving camera (apply g to background stars); retrograde disk toggle; disk inclination.
40. [pending] Weak-field multi-mass mode (superposed linearized metrics, draggable masses, clearly labeled "linearized approximation").
41. [pending] WebGPU compute port with progressive high-quality accumulation for screenshots.
