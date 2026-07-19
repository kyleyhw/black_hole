# Rendering

How the physics output becomes pixels. Everything below is downstream of
the integrator ([numerics.md](numerics.md)); the physical expressions are
derived in [derivations.md](derivations.md) §6–7.

## Accretion disk

Geometrically thin, equatorial, matter on prograde circular geodesics from
r_ISCO(a) (computed CPU-side from the Bardeen–Press–Teukolsky formula and
fed as a uniform — the panel shows it live) to a user-set outer radius.

**Hit detection.** A crossing is a sign change of z across an integration
step; the step is then re-integrated in 3 halvings (each keeping the half
that still straddles z = 0) and finished with linear interpolation, so the
hit lies on the geodesic to sub-step accuracy. This prevents the banding a
chord-intersection test produces at grazing inclination.

**Shading at a hit** (all exact, per derivations.md §6–7):

- redshift g = 1 / [u^t (1 − Ω λ)] with λ = L_z/E from the ray's conserved
  quantities — gravitational redshift, orbital Doppler, and frame dragging
  in one expression;
- bolometric beaming: intensity × g⁴ (from Liouville invariance of I_ν/ν³);
  toggleable in the panel for the before/after comparison;
- color: blackbody-like ramp at temperature g·T(r), with the thin-disk
  profile T ∝ r^(−3/4) normalized to the emissivity-peak radius so the
  brightest annulus is white at rest and shifts blue/red with g;
- emissivity: Novikov–Thorne-like (1 − √(r_in/r))/r³, normalized at its own
  peak (at r = 49/36 r_in) so the exposure slider is scale-free;
- texture: 3-octave value noise on a cylinder in co-rotating coordinates
  (log r, φ − Ω(r) t). Because each annulus advects at its own Keplerian
  rate the pattern shears differentially — the disk visibly rotates
  differentially with zero stored textures. The φ direction wraps with an
  integer cell count per octave so there is no seam. The advection is played
  back at ×2 real coordinate-time (`DISK_TIME_SCALE`) so the shear is visible
  over tens of seconds rather than the ~minute-per-orbit a 1:1 rate would
  give; this is
  a pure time remap of the *texture phase* only — the instantaneous g and g⁴
  factors depend on Ω(r), not on the playback rate, so every pixel's color is
  unchanged. The e2e suite can pin the clock (`__bhDiskTime`) to measure the
  physics on a frozen pattern.

**Transparency.** Hits accumulate front-to-back with wispy, noise-modulated
opacity, and the ray *continues* — this is what produces the lensed image
of the disk's far side above/below the shadow and the higher-order rings
near the photon shell.

## Starfield

Procedural, zero assets (~40 lines): the escape direction is cube-projected
(dominant axis → face + uv, avoiding polar clustering), each face is a
400×400 cell grid, a hash decides star presence (4% of cells), sub-cell
jitter places the star, a power law (b = (1−0.97u)^(−2/3)) spreads
brightness over ~1 decade, a small temperature ramp colors it, and a
smoothstep falloff whose width tracks the local pixel footprint keeps stars
sub-pixel-crisp at any resolution. The footprint radius carries a `STAR_SIZE`
= 0.5 factor (stars are drawn at half the earlier size, closer to true
unresolved point sources) with 1/STAR_SIZE² peak compensation, i.e. flux
conservation: a point source's total flux is fixed, so a half-radius PSF —
a quarter the area — is four times brighter at its core. The sky keeps its
overall brightness; the stars are simply smaller and sharper. A non-zero
footprint is kept deliberately so stars anti-alias instead of twinkling
under the idle camera drift. Lensing of the field — Einstein-ring streaking,
multiple imaging near the photon shell — costs nothing: it is just the
geodesic map applied to the escape direction.

Known artifact, accepted deliberately: the star renderer does not conserve
surface brightness under magnification (streaks render at full brightness
per pixel), so the sky near the critical curve is brighter than physical.
Doing this correctly requires filtering the star field over the
magnification tensor (the DNGR paper's approach) and is out of scope.

## Post-processing pipeline

scene (RGBA16F, at resolution-scale × device pixels)
→ bright-pass + horizontal Gaussian (half res)
→ vertical Gaussian (half res)
→ composite: scene + strength·bloom → ACES tonemap → gamma 2.2 → canvas.

- Bloom threshold 0.85 in HDR: the disk face and the brightest stars glow;
  the background field stays crisp.
- ACES (Narkowicz fit) compresses the disk's ~100:1 dynamic range into
  display range; the g⁴-beamed inner edge saturates to white exactly where
  it should.
- **Debug views bypass the whole pipeline** — categorical false colors
  (step count, |H| drift, final r) must reach the screen numerically
  intact, and the e2e suite reads them back as data.

## Overlays

The ergosphere shell (fixed-step march of F = r_KS − r_E(θ) with one
bisection refine, rim-emphasized by grazing angle), the equatorial
photon-orbit rings, and the equatorial **coordinate grid** (circles of
constant Kerr–Schild radius every 2M, from the plane intercept
t = −z_cam/dir_z, plus twelve 30° azimuthal spokes) are drawn in the
composite pass in **flat space**, deliberately: they are coordinate-surface
markers, i.e. diagnostics, not physical objects — lensing them would
misrepresent what they are. The About modal says so.

## Binary merger mode (Phases 14–15)

The `#define BINARY` shader variant renders **two** black holes with the
superposed boosted Kerr–Schild metric and its closed-form Sherman–Morrison
inverse (derivations.md §11). Design points:

- **Scalar form in the shader.** The inverse is never materialized as a
  matrix: H and dx/dλ use the expanded scalars (s₁, s₂, c, D), validated
  against the matrix inverse to machine precision in the Python mirror
  (suite study 8). The D floor (1e-4) only engages in the two-horizon
  overlap, which is always inside the capture region.
- **Bit-exact single-hole limit.** Every BINARY branch is engineered so
  f₂ = 0 reduces to the single-Kerr arithmetic bit-for-bit (guarded step
  and FD-eps terms, exact +0.0 additions); the e2e suite asserts pixel
  identity of binary-with-M₂=0 against Kerr mode.
- **Termination** is per-hole: rest-frame KS radius against each hole's own
  capture law (the single-Kerr buffer scaled by that hole's mass and spin),
  plus the shared |p|² blueshift guard.
- **Camera** is a static observer of the superposed metric with a tetrad
  built by the same Gram–Schmidt core under the binary g; the
  moving-observer drag camera is single-Kerr machinery and renders static
  in this mode (labeled; revisited with the dynamics phase).
- **No disk, no single-Kerr overlays** in binary mode (the ISCO/ergosphere
  concepts they mark are per-hole quantities that don't survive
  superposition); the starfield and its per-pixel g★ shift work unchanged.
- The boost enters as **per-hole lab→rest mat4 uniforms** computed
  CPU-side each frame, not as in-shader branch code: the branchy boost,
  inlined ~56× through the RK4/FD call tree, blew up software-rasterizer
  pipeline JIT (first draw blocked > 180 s on SwiftShader); the branchless
  matrix multiply compiles in 0.2 s, and the identity matrix keeps the
  static path bit-exact. Formula validated in the mirror (Lᵀ g L identity);
  live during the merger animation, where each hole's tangential orbital
  velocity v_i = r_i ω (up to √x ≈ 0.41 c at the ISCO) feeds its matrix
  each frame. For the same JIT reason the disk section is compiled out of
  the BINARY variant entirely.
- **The merger animation** (`src/merger.ts`) precomputes the TaylorT4
  inspiral at event-selection time (a few hundred RK4 steps, arrays
  interpolated per frame), blends through the plunge on the C¹ schedule of
  derivations.md §12, and swaps to the exact-Kerr remnant via the
  coincident-superposition identity. The wall clock maps to physical time
  through the slow-motion divisor; readouts show t − t_merger (physical),
  separation, and f_GW. The TS TaylorT4 mirror is pinned against the Python
  suite's validated GW150914 timing (0.0905 s, e2e cross-check to 1%).

## Camera model

Since Phase 8 the camera is a proper **tetrad camera**: rays are
initialized in an orthonormal frame carried by the observer, so pixels
measure proper local angles, aberration is exact, and textbook apparent-
angle formulas apply directly (verified to 0.006% on the Schwarzschild
shadow). The observer 4-velocity e₀ carried by that frame is: the
integrated geodesic velocity while **free-falling**; and, while **orbiting
interactively**, a *moving observer* whose velocity is the camera's own
finite-differenced coordinate motion (derivations.md §8). So dragging the
view is a genuine observer worldline — it exhibits aberration and Doppler
while moving and reduces to the static observer exactly at rest. Because a
free interactive drag is superluminal in coordinate units (3–20 c measured),
the velocity estimate is shaped: a 0.32 s sliding-window derivative bridges
the pointer-event cadence, a time-constant EMA (τ = 0.15 s) makes smoothing
fps-independent, the estimate stays live briefly after release so it decays
through the coast instead of snapping, and the magnitude maps through
V_max·tanh(|v|/V_ref) with V_max = 0.25 c, V_ref = 10 M/s — graded, bounded
aberration (≤ ~14° at screen center), smooth in and out (derivations.md §8,
which also records the measured failure modes this design removes). The
starfield is
red/blueshifted per pixel by g\* = 1/q_t (toggleable). The earlier
coordinate-covector camera and its distinct angle convention are derived
and quantified in derivations.md §4.

## WebGPU HQ stills

`hq.wgsl` is a compute-shader port of the Kerr path, structurally
line-parallel with the GLSL (a constant-parity test enforces the shared
physics constants). It accumulates Halton-jittered samples progressively
into a storage buffer and presents through the same ACES tonemap (no
bloom — the HQ still is tone-mapped accumulation only). WebGL2 remains the
default and the universal fallback; the HQ button disables itself when no
adapter exists, and the e2e pixel-parity test runs automatically in
WebGPU-capable browsers.
