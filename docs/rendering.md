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
free interactive drag is superluminal in coordinate units, the velocity is
clamped to the local light cone (max Lorentz factor 10). The starfield is
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
