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
  integer cell count per octave so there is no seam.

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
sub-pixel-crisp at any resolution. Lensing of the field — Einstein-ring
streaking, multiple imaging near the photon shell — costs nothing: it is
just the geodesic map applied to the escape direction.

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
bisection refine, rim-emphasized by grazing angle) and the equatorial
photon-orbit rings are drawn in the composite pass in **flat space**,
deliberately: they are coordinate-surface markers, i.e. diagnostics, not
physical objects — lensing them would misrepresent what they are. The
About modal says so.

## Camera model

Through Phase 7 the camera assigns each pixel a unit *coordinate* covector
(the blueprint's specification). Apparent angles therefore differ from a
local static observer's by metric factors — quantified and validated in
derivations.md §4 (18% at r₀ = 18 M for the shadow radius). The Phase 8
tetrad camera replaces this with proper local-frame ray initialization,
after which textbook apparent-angle formulas apply directly.
