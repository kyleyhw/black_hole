# Kerr Black Hole Ray Tracer

A browser-based, real-time, interactive black hole renderer. Every pixel is
computed by numerically integrating a **null geodesic of the Kerr metric**
in a WebGL2 fragment shader — the light bending, frame dragging, disk
Doppler/redshift, and shadow are all exact solutions of general relativity,
not approximations or artistic effects.

**[Live demo](https://kyleyhw.github.io/black_hole/)** · spin slider from
Schwarzschild (a = 0) to near-extremal (a = 0.998 M), free orbit camera,
relativistic accretion disk, procedural starfield, validation suite.

![Kerr black hole with accretion disk, a = 0.6](docs/img/hero.png)

*a/M sweep 0 → 0.998 — watch the shadow go asymmetric and the ISCO walk
inward:*

![Spin sweep](docs/img/spin-sweep.gif)

---

## The physics

The metric is used in **Kerr–Schild (Cartesian) form**,

$$g_{\mu\nu} = \eta_{\mu\nu} + f\, l_\mu l_\nu, \qquad
f = \frac{2 M r^3}{r^4 + a^2 z^2}, \qquad
g^{\mu\nu} = \eta^{\mu\nu} - f\, l^\mu l^\nu \ \text{(exact, } l \text{ null)},$$

with $r$ the Kerr–Schild radius, $r^4 - r^2(\rho^2{-}a^2) - a^2z^2 = 0$.
Why Kerr–Schild over Boyer–Lindquist: it is horizon-penetrating (no
coordinate singularity at $r_+$), regular on the polar axis, and needs no
turning-point bookkeeping — fewer branches, fewer bugs, cleaner shader.
Rays follow Hamilton's equations for $H = \tfrac12 g^{\mu\nu}(x)p_\mu p_\nu$,
so no Christoffel symbols appear anywhere, and $H \approx 0$ doubles as a
per-ray error monitor you can render (debug views).

The accretion disk is matter on circular equatorial geodesics between
$r_{\rm ISCO}(a)$ (Bardeen–Press–Teukolsky, live in the UI) and a chosen
outer edge. Its shading uses the exact redshift factor

$$g = \frac{1}{u^t\,(1 - \Omega \lambda)}, \qquad
\lambda = \frac{L_z}{E}, \qquad
\Omega = \frac{\sqrt{M}}{r^{3/2} + a\sqrt{M}}, \qquad
u^t = \frac{1 + a\sqrt{M}/r^{3/2}}{\sqrt{1 - 3M/r + 2a\sqrt{M}/r^{3/2}}},$$

which packages gravitational redshift, orbital Doppler beaming
(intensity $\propto g^4$), and frame dragging in one conserved-quantity
expression. Everything rendered is exact GR; the deliberate exceptions
(schematic overlays, the starfield's magnification artifact) are labeled as
such in the docs. Full derivations: [docs/derivations.md](docs/derivations.md).

The mass "slider" is a pure display rescale — $M$ is scale-free in
geometrized units, which is itself the physics: the readouts convert
$r_+$ and $r_{\rm ISCO}$ to km/au for your chosen mass.

## The numerics

RK4 integration of Hamilton's equations with central-difference gradients
of $H$ (6 extra metric evaluations per step — nothing hand-derived to get
wrong), a displacement-bounded adaptive step
$d\lambda = 0.1\,\min(r - 0.9 r_H,\, r)/|dx/d\lambda|$, and termination by
horizon capture, escape, or blueshift blow-up ($|p|^2 > 10^8$ — a
past-directed shadow ray hugs the horizon with exponentially growing
momentum; catching it is both physically meaningful and what keeps f32
alive). The FD step $\varepsilon = 2{\times}10^{-3}\max(r,1)$ comes from an
explicit f32 truncation/roundoff optimum. Details:
[docs/numerics.md](docs/numerics.md).

## Validation

A float64 mirror of the exact shader algorithm
([`validation/kerr.py`](validation/kerr.py)) is tested against analytic
strong-field results — all 8 checks pass
([full report](validation/reports/validation.md)):

| | |
|---|---|
| ![Convergence](validation/plots/convergence.png) | ![Critical impact parameter](validation/plots/bcrit_schwarzschild.png) |
| **Convergence:** global error vs step size on a strong-field flyby; the points ride the slope-4 line until the finite-difference-gradient floor (annotated) — the scheme is genuinely 4th order (measured 4.08). | **Schwarzschild capture boundary:** bisection on capture/escape recovers the critical impact parameter to 5×10⁻⁷ relative: measured 5.196155 M vs 3√3 = 5.196152 M. |
| ![Photon shell](validation/plots/photon_shell.png) | ![Conservation drift](validation/plots/conservation_drift.png) |
| **Kerr photon shell (a = 0.9):** the marginally-escaping ray's minimum radius matches the analytic prograde/retrograde photon-orbit radii to ~10⁻⁵ — frame dragging quantitatively right, both senses. | **Conservation drift:** E is conserved identically by construction; L_z and H stay bounded at ~10⁻⁶ (production stepping) on a generic flyby and <2×10⁻⁵ on a near-critical ray that winds the photon shell, where instability amplifies error by ~e^{2π} per orbit. |

**In-browser cross-check:** the rendered Schwarzschild shadow radius at
r₀ = 18 M matches the conserved-quantity prediction for this camera model
to **0.13%** (37.22 px measured vs 37.27 px predicted, measured from pixel
statistics of the final-r debug view in headless Chromium — see
[e2e/reports/phase3.md](e2e/reports/phase3.md), including why the textbook
local-frame formula differs by 18% for a coordinate-covector camera).

## Rendering

Thin-disk shading (bisected geodesic hits, $g^4$ beaming, blackbody ramp at
$g\,T(r)$, differentially-rotating 3-octave noise, semi-transparent
accumulation that keeps integrating — that's where the lensed
above/below-shadow images come from), a zero-asset procedural starfield
(cube-projected hash cells; lensed streaking comes free from the geodesic
map), and an HDR pipeline: RGBA16F targets → bright-pass separable Gaussian
bloom → ACES tonemap. Details: [docs/rendering.md](docs/rendering.md).

## Controls

| Control | Action |
|---|---|
| Left-drag | orbit (azimuth/elevation, clamped ±89°) |
| Scroll / pinch | zoom, r ∈ [2.2, 60] M |
| Double-click | reset camera |
| Spin slider | a/M ∈ [0, 0.998] (Thorne limit) |
| Mass slider | display scale (readouts in km/au) |
| Disk section | toggle, outer radius, exposure, g⁴ beaming toggle |
| Quality section | max integration steps, resolution scale, bloom |
| Overlays | ergosphere shell, photon-orbit rings, debug views (step count, \|H\| drift, final r) |
| Presets | Schwarzschild · Interstellar-ish (a = 0.6) · Near-extremal (a = 0.998) |
| Screenshot | canvas → PNG download |

## Repository layout

```
black_hole/
├── index.html               # shell, panel styling, About modal
├── src/
│   ├── main.ts              # render pipeline (scene → bloom → composite)
│   ├── camera.ts            # orbit camera
│   ├── physics.ts           # CPU-side: r_+, r_ISCO, photon orbits
│   ├── panel.ts             # control panel (hand-rolled, no widget lib)
│   ├── gl.ts                # WebGL2 boilerplate
│   └── shaders/
│       ├── render.frag.glsl # ALL the physics: metric, integrator, disk, stars
│       ├── blur.frag.glsl   # bright-pass separable Gaussian
│       ├── composite.frag.glsl # ACES tonemap + overlays
│       └── fullscreen.vert.glsl
├── validation/              # float64 mirror + analytic tests (uv project)
│   ├── kerr.py              # the integrator, line-parallel with the shader
│   ├── run_validation.py    # 4 studies → plots/ + reports/
│   ├── plots/  reports/
├── e2e/                     # Playwright browser tests, one per phase
│   ├── harness.cjs  phase*.cjs
│   ├── reports/  screenshots/
├── docs/                    # documentation (index: docs/README.md)
│   ├── derivations.md  numerics.md  rendering.md  img/
└── PROJECT_PLAN.md          # full technical spec + phased task tracker
```

## Documentation index

- [docs/README.md](docs/README.md) — documentation hub
- [docs/derivations.md](docs/derivations.md) — all the mathematics, from first principles
- [docs/numerics.md](docs/numerics.md) — integrator, step control, termination, precision
- [docs/rendering.md](docs/rendering.md) — disk, starfield, post-processing, overlays
- [validation/reports/validation.md](validation/reports/validation.md) — numerical validation report
- [e2e/reports/](e2e/reports/) — per-phase browser test reports
- [PROJECT_PLAN.md](PROJECT_PLAN.md) — specification and task tracker

## Build

```bash
npm install
npm run dev        # local dev server
npm run build      # typecheck + production build to dist/
cd validation && uv run python run_validation.py   # regenerate plots
```

Deployed to GitHub Pages by `.github/workflows/deploy.yml` on push.

## References

<span id="ref-bpt-1972">[1]</span> Bardeen, J. M., Press, W. H., & Teukolsky, S. A. (1972). *Rotating Black Holes: Locally Nonrotating Frames, Energy Extraction, and Scalar Synchrotron Radiation.* ApJ, 178, 347. [Link](https://doi.org/10.1086/151796) — circular-orbit kinematics, ISCO, photon orbits.

<span id="ref-mtw">[2]</span> Misner, C. W., Thorne, K. S., & Wheeler, J. A. (1973). *Gravitation.* W. H. Freeman. — geodesics as Hamiltonian flow; Kerr geometry.

<span id="ref-chandra">[3]</span> Chandrasekhar, S. (1983). *The Mathematical Theory of Black Holes.* Oxford University Press. — Kerr geodesics; Kerr–Schild form.

<span id="ref-dngr">[4]</span> James, O., von Tunzelmann, E., Franklin, P., & Thorne, K. S. (2015). *Gravitational lensing by spinning black holes in astrophysics, and in the movie Interstellar.* Class. Quantum Grav., 32, 065001. [Link](https://doi.org/10.1088/0264-9381/32/6/065001) — the lineage of this technique, and the correct treatment of the starfield-magnification problem this project consciously approximates.

<span id="ref-thorne-1974">[5]</span> Thorne, K. S. (1974). *Disk-Accretion onto a Black Hole. II. Evolution of the Hole.* ApJ, 191, 507. [Link](https://doi.org/10.1086/152991) — the a = 0.998 spin-up limit used as the slider maximum.
