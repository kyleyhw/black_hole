# Project Development Plan

This document is both the technical specification and the phase-by-phase task tracker for the **Kerr Black Hole Ray Tracer** — a browser-based, real-time, interactive black hole renderer that integrates **actual null geodesics of the Kerr metric** in a WebGL2 fragment shader. Spin slider from a = 0 (Schwarzschild) to near-extremal. Free orbit camera, relativistic accretion disk, procedural starfield, polished UI, deployed as a static site anyone can open in a browser.

Portfolio thesis: *physics → numerics → validation → rendering*, in that order. The README leads with the equations being integrated and the plots proving the integrator works, not just pretty pictures.

Part I is the specification; Part II is the task list. Tasks reference specification sections (e.g. *§2.2*). Phases 1–11 each end at a **review checkpoint**: work pauses for explicit confirmation before the next phase begins. Phases 0–7 constitute the core release; Phases 8–11 are the extended features (§9), committed scope sequenced after the core release rather than optional stretch goals.

> **Status: all 12 phases complete.** Final certification (2026-07-13): all 9
> browser e2e suites pass against the final build and the float64 validation
> suite passes 12/12 checks. GitHub Pages is enabled (owner action done) and
> the WebGPU HQ path has been exercised end-to-end in-container via the
> SwiftShader software adapter: modal flow, PNG download, and numerical
> pixel parity between the GLSL and WGSL ports (8×8 block-mean difference
> 3.56/255 at matched sampling — see e2e/reports/phase11.md). Phase 12 added
> the owner-requested educational/UX + animation layer (mass scale-invariance
> explained, free-fall stop, coordinate grid, click-to-learn popups + a full
> notation glossary, collapsible sidebar, cinematic idle auto-orbit, visible
> Keplerian disk shear, half-size flux-conserving stars) — all 9 browser e2e
> suites re-certified PASS; see e2e/reports/phase12.md.

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
u^t = (1 + a √M / r^{3/2}) / √(1 − 3M/r + 2 a √M / r^{3/2})   (prograde equatorial circular orbit)
```

> Note: the original blueprint omitted the numerator (1 + a√M/r^{3/2}) in u^t.
> Corrected in Phase 2 by direct normalization of u = u^t(∂_t + Ω ∂_φ) against
> the BL metric — see docs/derivations.md §6 for the derivation and numerical check.

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
- A "free-fall" button that releases the camera onto a timelike geodesic (integrated on the CPU per frame) — specified in §9.1, built in Phase 8

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

**If behind schedule on the core release (Phases 0–7), cut in this order:** ergosphere overlay → bloom → transparent disk (make it opaque, single image) → adaptive stepping (fixed dλ with higher step count). **Never cut:** validation plots, debug views, the spin slider, README derivations. The extended features (§9, Phases 8–11) are committed scope but sequenced entirely after the core release, so schedule pressure defers them rather than cutting core quality.

## 9. Extended features specification (Phases 8–11)

### 9.1 Camera dynamics: tetrads and free-fall (Phase 8)

The static-camera initial conditions (§2.2) solve the p_t quadratic for a camera at rest. A moving camera requires initializing rays in the camera's **local orthonormal frame**, which also delivers relativistic aberration exactly:

- **Tetrad construction.** At camera position x with 4-velocity u^μ, set e_(0) = u and Gram–Schmidt-orthonormalize three coordinate-frame direction vectors against it under the full metric g, yielding an orthonormal tetrad {e_(0), e_(1), e_(2), e_(3)} with g(e_(A), e_(B)) = η_(AB). Computed on the CPU in TypeScript (a 4×4 Gram–Schmidt per frame is negligible) and passed as uniforms.
- **Ray initialization.** For pixel direction n̂ (unit 3-vector in the camera frame), p^μ = e_(0)^μ + n^i e_(i)^μ. This is exactly null by construction and normalizes the locally measured photon energy to E_loc = −p_μ u^μ = 1. It replaces the p_t quadratic; the quadratic path is retained as a cross-check for the static case (both must agree to numerical precision).
- **Free-fall mode.** Release from rest: u^i = 0, u^t = 1/√(−g_tt), well-defined only where g_tt < 0, i.e. **outside the ergosphere** — the release button is disabled inside it (a physics-made-visible touch worth a UI tooltip). The camera worldline is then integrated per frame on the CPU with the same Hamiltonian RK4 as the shader (timelike branch: H = ½ g^{μν} p_μ p_ν = −½ for unit mass), in a TypeScript mirror of the shader RHS. Frame dragging induces azimuthal drift from a pure-radial release automatically. Terminate the plunge (and reset) at r ≤ 1.05 r_+.
- **Validation.** At a = 0, compare the integrated plunge r(τ) from rest at r_0 against the analytic Schwarzschild cycloid solution.

### 9.2 Redshifted starfield (Phase 8)

With rays initialized to E_loc = 1 (§9.1), the conserved E = −p_t of the backward-traced ray directly encodes the shift for sources at infinity: a photon emitted by a distant static star with energy-at-infinity E is received with ν_obs/ν_em = E_loc/E = 1/E ≡ g_★.

- Apply per escaped pixel: star temperature T_obs = g_★ T_em (blackbody spectral shape is preserved under uniform frequency scaling), bolometric brightness × g_★⁴ (from the invariance of I_ν/ν³).
- Limits as sanity checks: distant static camera → g_★ → 1 (no shift); static camera at finite r → g_★ = 1/√(−g_tt) > 1 (gravitational blueshift of the sky, correct); infalling camera → forward-sky blueshift and aberration concentration, rear-sky redshift.

### 9.3 Disk extensions: retrograde flow and inclination (Phase 9)

**Retrograde disk.** Parameterize orbit sense by s = ±1 (s = +1 prograde, s = −1 retrograde); the §2.5 formulas generalize to

```
Ω      = s √M / (r^{3/2} + s a √M)
u^t    = (1 + s a √M / r^{3/2}) / √(1 − 3M/r + 2 s a √M / r^{3/2})
r_ISCO = M [ 3 + Z₂ − s √((3 − Z₁)(3 + Z₁ + 2 Z₂)) ]
```

with Z₁, Z₂ as in §2.5. The redshift expression g = 1/[u^t (1 − Ω λ)] is unchanged. Retrograde ISCO is larger (r_ISCO → 9M as a → M), so the retrograde disk visibly recedes from the shadow — state this in the UI/docs.

**Disk inclination.** Tilt the disk plane by angle i about a chosen axis: disk normal n̂(i), plane-crossing detection by sign change of x·n̂ with the same bisection refinement. **Honesty constraint:** in Kerr, circular geodesic orbits exist off the equatorial plane only trivially — a tilted Keplerian disk is not a self-consistent equilibrium for a ≠ 0 (Lense–Thirring precession; cf. Bardeen–Petterson alignment). Implementation: exact at a = 0 (spherical symmetry makes any plane equatorial); for a ≠ 0 carry the equatorial kinematic formulas over to the tilted plane and label the mode "kinematic approximation" in the UI and docs. The renderer's geodesics (light propagation) remain exact in all cases — only the emitter's orbital model is approximate.

**Validation.** Retrograde r_ISCO and photon-orbit radii vs the analytic s = −1 expressions (the photon-shell plot of §5.3 already contains the retrograde branch); visual check that the beaming asymmetry mirrors under s → −s at fixed camera.

### 9.4 Weak-field multi-mass mode (Phase 10)

A separate, clearly-labeled **linearized-gravity** mode: N draggable point masses with superposed weak-field metrics,

```
g_00 = −(1 + 2Φ),   g_ij = (1 − 2Φ) δ_ij,   g_0i = 0
Φ(x) = − Σ_k M_k / |x − x_k|        (|Φ| ≪ 1 required for validity)
```

- Same Hamiltonian machinery and RK4 integrator; only the metric evaluation function is swapped (compile-time shader variant, not a runtime branch in the hot loop).
- Superposition is **only** valid at linear order — the UI must display a validity indicator (e.g. max |Φ| encountered along rays, warning above ~0.1) and the mode is labeled "linearized approximation" on the panel, per the honesty framing of the whole project.
- No horizons exist in this metric (Φ diverges at each point mass); terminate rays instead at a capture radius r_k < 2 M_k per mass (the would-be Schwarzschild radius, where linearization has long since broken down).
- UI: mode switch, drag masses in the camera plane, per-mass M_k sliders, add/remove up to a fixed N_max (uniform array bound).
- **Validation.** Single mass: numerical deflection angle vs the standard weak-field result α = 4M/b on a log–log plot over b ∈ [10, 10³] M; two masses: deflection additivity in the far field.

### 9.5 WebGPU progressive renderer (Phase 11)

A WGSL compute-shader port of the same integrator for high-quality offline-style stills, with the WebGL2 path retained as the universal fallback:

- Feature-detect `navigator.gpu`; the WebGL2 real-time path remains the default renderer and the fallback everywhere WebGPU is unavailable.
- Progressive accumulation: per-frame sub-pixel jitter (hash-based sequence seeded by a frame counter — deterministic, no `Math.random` in the sample loop), accumulated into a storage buffer; accumulation resets on any camera/parameter change; sample count displayed live.
- Precision note: WebGPU guarantees only f32 (no f64 in WGSL core) — same effective precision as `highp` WebGL2, so the port changes throughput and quality-per-second, not accuracy. Order the integration's additive terms to minimize cancellation where cheap to do so.
- Divergence risk between GLSL and WGSL copies of the physics is managed by (i) keeping both ports structurally line-parallel with shared banner sections and (ii) a **parity test**: identical camera/parameters rendered on both backends, per-pixel difference imaged and bounded; recorded in the test report.
- High-quality screenshot mode: render at full device resolution to a target sample count, then PNG download.

---

# Part II: Development Phases

## Phase 0: Repository and Planning

1. [completed] Initialize repository on branch `claude/kerr-black-hole-raytracer-02tz1w` with `.gitignore` (`.env`, `.DS_Store`, `venv/`, `node_modules/`, `dist/`).
2. [completed] Commit this development plan as `PROJECT_PLAN.md` (specification + task tracker in one document).
3. [completed] Review this plan with the project owner; obtain explicit confirmation before Phase 1. (Owner directed full execution of the plan to completion, 2026-07-12.)

## Phase 1: Scaffold, Flat-Space Renderer, and Deployment (§3)

4. [completed] Vite + vanilla TypeScript scaffold; GLSL shaders as `?raw` imports; no framework, no engine.
    - Pre-commit hooks (`ruff`, `ty`, `detect-secrets` with baseline) configured once the Python toolchain exists in Phase 4; `detect-secrets` alone configured here.
5. [completed] WebGL2 boilerplate: context creation, shader compile/link with error surfacing, fullscreen triangle, `precision highp float` enforced, uniform plumbing.
6. [completed] Pinhole camera: orbit controls (drag azimuth/elevation, clamped ±89°; scroll zoom clamped to r ∈ [2.2 M, 60 M]), per-pixel flat-space ray directions (§4).
7. [completed] Procedural starfield (§2.6): cube-map-style cell hashing, sub-cell jitter, power-law brightness, temperature color ramp.
8. [completed] GitHub Pages deployment via Actions on push (`vite build` → static site). Deliverable: navigable starfield on a live URL. (Workflow committed; Pages must be enabled once in repo Settings → Pages → Source: GitHub Actions.)
9. [completed] Commit; **checkpoint**: e2e test `e2e/phase1.cjs` PASS (report: `e2e/reports/phase1.md`) — starfield renders, orbit camera responds.

## Phase 2: Derivations (§6 — derive before implementing)

10. [completed] Write `docs/derivations.md` with full step-by-step derivations (LaTeX):
    - Kerr–Schild metric, inverse metric, and the r-coordinate root solve with degenerate-case guards (z → 0, small ρ) (§2.1).
    - Null-condition quadratic for p_t and the future-pointing root selection criterion (§2.2). (Result: the two roots give dt/dλ = ∓√D exactly; imaging uses the past-directed root, and all shading observables are ratios invariant under p → −p.)
    - Hamilton's equations with the finite-difference gradient scheme and its error/step-size trade-off (§2.2). (Result: blueprint's ε = 1e−4·r is roundoff-dominated in f32; shader uses ε = 2e−3·max(r,1).)
    - Redshift factor g = 1/[u^t (1 − Ω λ)] for a prograde equatorial circular emitter and observer at infinity, including u^t and Ω derivations and sign conventions (§2.5). (Found and corrected the blueprint's u^t: missing numerator (1 + a√M/r^{3/2}), verified numerically.)
11. [completed] **Checkpoint**: derivations verified numerically (u^t normalization and Ω geodesic condition at M=1, a=0.9, r=4; discriminant positivity proven) and recorded in docs/derivations.md for owner review.

## Phase 3: Kerr Geodesic Integrator in the Shader (§2.1–2.4)

12. [completed] Kerr–Schild metric evaluation in GLSL (r-root with guarded square roots) and Hamiltonian H = ½ g^{μν} p_μ p_ν.
13. [completed] RK4 integration of Hamilton's equations with finite-difference ∂H/∂x (option (a)); adaptive dλ displacement-bounded heuristic dλ = 0.1 min(r − 0.9 r_H, r)/|dx/dλ|, clamped; fixed max-step loop with early-out (§6).
14. [completed] Termination logic (§2.3): capture at r < r_+(1 + 0.02√(1−a²)) — buffer scaled so it stays inside the prograde photon orbit near-extremal — plus |p|² > 10⁸ momentum-blowup capture (past-directed shadow rays hug the horizon with exponential blueshift); escape to starfield at r > 200 M; budget-exceeded treated as captured.
15. [completed] **Debug false-color views built before first full render** (§2.4): step count, |H| drift, final r.
16. [completed] Spin uniform a/M ∈ [0, 0.998] wired to a provisional slider; shadow asymmetry verified quantitatively (centroid shift 6.8% of width at a = 0.998, 0.2% at a = 0); Einstein ring and lensed stars visible.
17. [completed] Commit; **checkpoint**: e2e test `e2e/phase3.cjs` PASS (report: `e2e/reports/phase3.md`) — Schwarzschild shadow radius matches the coordinate-camera analytic prediction to 0.13%, |H| drift bounded, frame-dragging asymmetry confirmed.

## Phase 4: Python Validation Suite (§5)

18. [completed] `validation/` as a `uv` project (`uv init`, `uv add numpy matplotlib`, dev tools `ruff`, `ty`, `detect-secrets`); full type annotations; complete pre-commit hook configuration (ruff/ty via uv.lock-pinned local hooks).
19. [completed] NumPy/float64 mirror of the shader integrator (same Hamiltonian, same RK4, same FD gradients, same adaptive step and termination) in `validation/kerr.py`.
20. [completed] Produce four validation plots (§5), each with interpretation notes (axes, expected pattern, takeaway):
    - Convergence order: slope 4.08 above the (annotated) FD-gradient error floor.
    - Schwarzschild critical impact parameter: |λ_c| = 5.196155 vs 3√3 = 5.196152 M (rel. err. 5×10⁻⁷).
    - Kerr photon shell at a = 0.9: prograde 1.55787 vs 1.55785 M, retrograde 3.91031 vs 3.91027 M (≈10⁻⁵ both).
    - Conservation drift: generic flyby ~10⁻⁶ (production step policy), near-critical ray bounded < 2×10⁻⁵ despite e^{2π}-per-orbit error amplification; E conserved identically by construction.
21. [completed] Test report in `validation/reports/validation.md` (what/why/inputs/runtime; failures and fixes documented). Physics discrepancies found and fixed: past-directed rays flip the sign of λ (positive offsets are retrograde photons) — brackets and comparisons corrected.
22. [completed] Commit plots and report; **checkpoint**: 8/8 checks PASS; ruff, ruff-format, and ty all clean.

## Phase 5: Relativistic Accretion Disk (§2.5)

23. [completed] Equatorial plane-crossing detection (z sign change) with 3 bisection refinements + linear sub-step interpolation per hit.
24. [completed] Disk kinematics: Ω(r), r_ISCO(a) (BPT, CPU-side in `src/physics.ts`), corrected u^t; redshift g from conserved E, L_z per the Phase 2 derivation.
25. [completed] Shading: g⁴ beaming × Novikov–Thorne-ish emissivity (normalized at its 49/36 r_in peak); blackbody color ramp with temperature scaled by g; 3-octave cylindrical value noise in (log r, φ − Ω(r) t) for seamless differential rotation.
26. [completed] Semi-transparent accumulation: front-to-back compositing, ray continues after each hit (lensed upper/lower disk images and photon-ring structure visible in test renders).
27. [completed] Commit; **checkpoint**: e2e test `e2e/phase5.cjs` PASS (report: `e2e/reports/phase5.md`) — approaching side (screen left for prograde flow seen from +x) brighter by 2.29× with beaming on vs 1.41× off; ISCO hole shrinks 49 → 31 px from a = 0 to a = 0.998.

## Phase 6: UI, Overlays, and Post-processing (§3, §4)

28. [completed] Custom control panel (dark glass, collapsible sections, live physics-unit readouts): spin, mass-as-scale (display units: r_+ and r_ISCO in km/au for the chosen M☉ — mass is a pure rescale, stated honestly), disk controls with r_in locked to live r_ISCO(a), quality (max steps, resolution scale, bloom), beaming toggle.
29. [completed] Presets: Schwarzschild (a = 0), Interstellar-ish (a = 0.6), near-extremal (a = 0.998).
30. [completed] Overlays and diagnostics: ergosphere shell (flat-space schematic march, rim-emphasized) and photon-orbit rings (labeled coordinate-surface markers), r_+ readout, debug-view dropdown; FPS counter; PNG screenshot button.
31. [completed] RGBA16F render target with resolution scaling; bright-pass + two-pass separable Gaussian bloom at half resolution; ACES tonemap composite (debug views bypass the post pipeline — categorical colors reach the screen exactly).
32. [completed] Footer + About modal with the core equations and repo link.
33. [completed] Commit; **checkpoint**: e2e test `e2e/phase6.cjs` PASS (report: `e2e/reports/phase6.md`); phase 1/3/5 tests re-run and re-pass against the HDR pipeline.

## Phase 7: Documentation and Release (§7)

34. [completed] `docs/` folder: derivations (Phase 2 + Phase 8 extensions), numerics.md (integrator choices, step-size heuristic, FD epsilon rationale, termination, f32 policy), rendering.md (disk model, starfield + its magnification artifact, bloom/ACES, overlays, camera model), all cross-referenced from docs/README.md.
35. [completed] `README.md` (§7): hero render + spin-sweep GIF + live demo link; physics (KS metric, Hamiltonian, KS-over-BL rationale); numerics; the four validation plots each with interpretation; rendering; controls table; ASCII directory tree; documentation index; numbered references (BPT 1972, MTW, Chandrasekhar, James et al. 2015, Thorne 1974).
36. [completed] In-browser cross-check (§5.5): rendered shadow radius vs conserved-quantity prediction at r₀ = 18 M — 0.13% agreement (e2e/reports/phase3.md); recorded in README with the coordinate-camera caveat.
37. [completed] Final deploy config + social-preview image (docs/img/hero.png). NOTE: GitHub Pages must be enabled once by the repo owner (Settings → Pages → Source: GitHub Actions) — the workflow builds successfully but the deploy step 404s until then; the social preview image is likewise set manually in Settings.

## Phase 8: Relativistic Camera Dynamics (§9.1, §9.2)

38. [completed] Extend `docs/derivations.md` (§8–9): tetrad construction via Gram–Schmidt under g, arriving-photon initialization p = e_(0) − n^i e_(i) (traced ray q = −p; no quadratic, no root selection), the timelike Hamiltonian branch (H = −½) with the KS at-rest initial condition p_i = f l_i/√(1−f) ≠ 0, release-from-rest ergosphere restriction, cycloid validation target, and the starfield shift g_★ = 1/q_t with its three limit checks.
39. [completed] Refactor ray initialization to the camera-tetrad form (CPU Gram–Schmidt in `src/tetrad.ts`, tetrad as uniforms; per-ray p_t threaded through the integrator, disk λ = L_z/E corrected to /q_t). Regression *as derived in §8*: pixel-identity with the old camera is the wrong check (different angle conventions); instead the rendered shadow must match the textbook local-frame formula — measured 44.094 px vs 44.091 px predicted (0.006%), where the coordinate camera correctly gave 37.27 px against its own prediction.
40. [completed] CPU timelike geodesic integrator (`src/geodesic.ts`, f64 mirror of the shader RHS); free-fall Release button (ergosphere-restricted with tooltip; orbit clamp keeps the camera exterior), per-frame worldline update with proper-time substeps, plunge termination and reset at r ≤ 1.05 r_+.
41. [completed] Redshifted starfield: per-pixel g_★ = 1/q_t applied to star temperature and g_★⁴ brightness, panel toggle; central-pixel q_t verified against √(1−2M/r₀) to 2×10⁻¹⁶; toggle changes 17.6% of pixels at r = 12 M.
42. [completed] Validation: a = 0 plunge r(τ) vs the analytic Schwarzschild cycloid — max relative error 7×10⁻¹⁰ over 44,711 steps (`validation/plots/freefall_cycloid.png`); suite now 9/9.
43. [completed] Commit; **checkpoint**: e2e `e2e/phase8.cjs` PASS (report: `e2e/reports/phase8.md`) — free-fall radius monotone 6 → 2.27 M with azimuthal frame-dragging drift 0.018 rad at a = 0.9, reset works; phases 3/5/6 regressions re-pass (phase3 now checks the local-frame formula).

## Phase 9: Disk Extensions — Retrograde Flow and Inclination (§9.3)

44. [completed] Retrograde toggle: orbit-sense parameter s = ±1 threaded through Ω, u^t, r_ISCO; UI toggle with live r_ISCO readout (retrograde ISCO visibly larger — face-on hole 73 px vs 29 px at a = 0.9).
45. [completed] Disk inclination slider (0–29°): tilted-plane crossing test (sign change of x·n̂) with bisection; redshift via angular momentum about the disk normal at the hit (exact at a = 0); UI note and docs label the a ≠ 0 case a kinematic approximation.
46. [completed] Validation: retrograde r_ISCO vs BPT (8.71735 vs 8.7174 M) and retrograde photon-orbit radius already in the suite (study 3, err 10⁻⁵); beaming asymmetry flips under s → −s (1.65 → 0.75, with the physically expected weakening from the larger retrograde ISCO); report entry.
47. [completed] Commit; **checkpoint**: e2e `e2e/phase9.cjs` PASS (report: `e2e/reports/phase9.md`); renders show the star-filled gap between shadow and the receded retrograde inner edge.

## Phase 10: Weak-Field Multi-Mass Mode (§9.4)

48. [completed] Extend `docs/derivations.md` (§10): linearized metric, Hamiltonian specialization, static-metric ray initialization, validity condition |Φ| ≪ 1, capture-radius rationale (regularization of a broken approximation, not a horizon).
49. [completed] Linearized-metric shader variant via compile-time `#define WEAK_FIELD` (same source, no runtime branching in the hot loop; RK4/FD machinery shared); up to 6 masses via uniform arrays with per-mass 2M_k capture radii.
50. [completed] UI: mode switch, pointer-draggable masses in the camera plane (orbit suppressed during drag), per-mass M_k sliders, add/remove masses, pairwise-|Φ| validity indicator warning above 0.1, "linearized" labels in panel and docs.
51. [completed] Validation (float64, study 6): α = 4M/b to 0.28% at b = 10³ M, log–log slope −1.008, small-b residuals following the ~10M/b second-order envelope (the metric's own higher-order deflection); two-mass far-field additivity to 3.3% vs the per-mass 4Mₖ/bₖ sum. Suite 12/12.
52. [completed] Commit; **checkpoint**: e2e `e2e/phase10.cjs` PASS (report: `e2e/reports/phase10.md`) — capture disks at predicted screen positions with Einstein rings, drag works without orbiting, validity indicator behaves.

## Phase 11: WebGPU Progressive Renderer (§9.5)

53. [completed] WGSL compute port of the integrator (`src/shaders/hq.wgsl`, line-parallel with the GLSL, shared banner sections; full Kerr path incl. tetrad rays, disk sense/tilt, sky shift); adapter probing (navigator.gpu can exist with no adapter — handled) with WebGL2 as default and fallback everywhere.
54. [completed] Progressive accumulation: Halton(2,3) sub-pixel jitter (deterministic), storage-buffer accumulation, live sample counter; the HQ still is a modal with a frozen camera (progressive accumulation requires it), so "reset on change" is by construction.
55. [completed] High-quality screenshot mode: full-resolution 256-sample render → PNG download from the modal.
56. [completed] Parity validation: constant-parity between GLSL and WGSL enforced by test, plus **live numerical pixel parity executed in-container** via the SwiftShader WebGPU adapter (`--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader` on a secure origin): 8×8 block-mean difference 3.56/255 at matched single-sample sampling; the multi-sample brightening was isolated and shown to be the expected linear-space-accumulation effect. Environment quirks (headless mapAsync-after-canvas-configure, adapter GC invalidating map callbacks) handled in the product; details in `e2e/reports/phase11.md`.
57. [completed] docs/ and README updated for all extended features (controls table, six validation plots, ASCII tree, rendering.md camera/WebGPU sections); deploy config final (Pages enablement remains the one owner-side action).
58. [completed] Commit; **checkpoint**: e2e `e2e/phase11.cjs` PASS with the full WebGPU runtime path executed (modal, accumulation, download, readback parity) — no skipped checks remain.

## Phase 12: Educational / UX round (owner-requested)

59. [completed] Mass slider clarified: the null result is *physics* (Kerr geometry is scale-free), stated with an in-panel note and a "Why doesn't mass change the image?" popup that also resolves the stronger-lensing-with-mass intuition (α = 4M/b depends on M/b; the camera is anchored in M, so the ratio — and the image — is fixed). Encoded as a falsifiable e2e property: mass 10 → 10⁶ M☉ changes **zero** pixels while the km/au readout changes.
60. [completed] Free-fall **Stop**: `toggleFreefall()` halts the plunge in place (no reset unless inside R_MIN); the Release button relabels to "Stop free fall" while falling. Defaults changed to resolution 1.00× and bloom 0 per owner request.
61. [completed] Coordinate-grid overlay (`uGridOn`): equatorial constant-r circles every 2M + twelve 30° spokes, drawn unlensed like the other schematic markers; toggle in the Overlays section; documented in `docs/rendering.md`.
62. [completed] Click-to-learn: twelve accurate physics popups (ⓘ) on section headers and key rows, plus a **Units & notation** glossary defining every symbol used in the UI (M, a, r, θ, φ, r₊, r_ISCO, Ω, uᵗ, E, L_z, λ, g, g★, Φ, H) and the geometrized-unit convention; About modal cross-references it. Collapsible sidebar (`#panelToggle`).
63. [completed] Commit; **checkpoint**: e2e `e2e/phase12.cjs` PASS (5/5 — mass pixel-invariance, grid toggle, free-fall stop state machine, glossary-defines-symbols, sidebar collapse); phase6 panel regression re-passes. Report: `e2e/reports/phase12.md`.
64. [completed] Animation/realism round: cinematic idle auto-orbit (0.003125 rad/s azimuthal drift, ~34 min/rev, after 4 s of stillness; capture-phase interaction listeners reset it; Camera-section toggle; disabled under `__bhTest`). Visible Keplerian shear via `DISK_TIME_SCALE = 2` playback remap of the texture phase only (g and g⁴ unchanged — a pure fast-forward; `__bhDiskTime` seam freezes it for measurement). Star footprint halved (`STAR_SIZE = 0.5`) toward point sources with 1/STAR_SIZE² flux-conserving brightness. Default resolution 1.00× / bloom 0; `__bhTest` renders at 0.75 to keep the software-WebGL2 e2e responsive.
65. [completed] Notation/physics: mass popup now answers "shouldn't mass affect lensing/the disk/background" — α = 4M/b holds M/b fixed under an M-anchored camera; the one real M-dependence is disk color temperature T ∝ M^(−1/4) (deliberately not rendered); the starfield is a direction field at infinity (scale-free).
66. [completed] Test hardening (root-cause, not threshold nudges): phase 9 beaming measured disk-only (on−off cancels the frozen starfield; flip sharpened to 4.47/0.56); phase 10 validity polls the indicator instead of racing a fixed wait; phase 9 pins resolution 0.75; full 9-suite sweep re-certified PASS. Report updated: `e2e/reports/phase12.md`.
67. [completed] Standards audit against the global context: refreshed the stale `e2e/reports/phase9.md` (disk-only beaming) and `phase10.md` (polling validity) to match the reworked tests; added two documentation pages closing the code-coverage gap — `docs/architecture.md` (software structure, one-algorithm/three-expressions parity strategy, render-pipeline data flow, module map, testing harness) and `docs/validation.md` (two-tier verification philosophy, float64-mirror rationale) — wired into both the `docs/README.md` hub and the root README index and tree. Toolchain re-checked: ruff, ruff-format, ty all pass with `error-on-warning`.
68. [completed] Physical moving-observer camera: the interactive orbit is now a genuine observer worldline. Its coordinate 3-velocity v = dx/dt is finite-differenced (EMA-smoothed, teleport-guarded), and the tetrad e₀ is set from u = uᵗ(1, v) with uᵗ = 1/√(1 − |v|² − f(1 + l·v)²) (`movingObserver` in `tetrad.ts`; derivations.md §8) — so dragging shows real aberration and Doppler and reduces to the static observer exactly at rest. A free drag is superluminal in coordinate units, so v is clamped to the local light cone (max Lorentz factor 10). New phase-8 check verifies v = 0 ≡ static to 10⁻¹² and opposite toward/away Doppler shifts (q_t 0.673 / 1.360 about the static 0.943); full 9-suite sweep re-certified PASS. Docs updated (derivations §8, rendering camera model, Camera learn popup).
