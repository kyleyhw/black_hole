# Phase 5 Test Report — Relativistic Accretion Disk

**Script:** `e2e/phase5.cjs` · **Runtime:** 42.2 s · **Result: PASS**

## What was done

In-browser tests of the disk model (240×180, SwiftShader WebGL2, 500-step
budget, camera r = 22 M at azimuth 0):

1. **Visibility** — difference image between disk-on and disk-off at
   identical camera/spin (the lensed starfield cancels exactly); the disk
   must change > 3% of pixels by more than 40 luminance levels.
2. **Beaming asymmetry with the correct sign** — camera on +x looking in,
   up +z: prograde matter at −y (screen left) moves toward the camera, so
   the left half must be brighter with beaming on; disabling g⁴ must
   collapse the asymmetry toward the residual color-ramp effect.
3. **ISCO lock** — face-on view (elevation 1.4 rad): the disk annulus'
   central hole (measured from the azimuthal-mean radial luminance profile
   at 50% of peak) must shrink markedly from a = 0 (r_ISCO = 6 M) to
   a = 0.998 (r_ISCO = 1.24 M, where the shadow becomes the bound).

## Why

These target the three physics ingredients added in this phase: the
plane-crossing/accumulation machinery (1), the redshift factor
g = 1/[u^t(1 − Ωλ)] entering as g⁴ (2 — the *sign* of the asymmetry checks
the sign conventions through the whole chain: prograde Ω, conserved λ from
past-directed rays, Doppler direction), and the live coupling of the inner
edge to the BPT r_ISCO(a) (3).

## Results

| Check | Value | Bound | Status |
|---|---|---|---|
| Disk-changed pixel fraction | 7.0% | > 3% | ✓ |
| Left/right brightness, beaming on | 2.29 | > 1.3 | ✓ |
| Left/right brightness, beaming off | 1.41 | residual < half of on-excess | ✓ |
| Hole radius, a = 0 | 49 px | — | — |
| Hole radius, a = 0.998 | 31 px | < 0.75 × a=0 | ✓ (0.63×) |

Screenshots: `phase5-disk-a09.png` (edge-on: beamed approaching side,
photon ring, lensed secondary image below the shadow),
`phase5-disk-nobeam-a09.png`, `phase5-disk-faceon-a0.png` (ISCO hole with
the thin photon ring visible inside it), `phase5-disk-faceon-a0998.png`.

## Failures encountered and fixes

1. **Disk invisible at first light.** The r⁻³ emissivity's dynamic range
   left everything but the beamed inner edge below ~10/255 before
   tonemapping exists (Phase 6). Fixes: display temperature normalized at
   the emissivity-peak radius (49/36 r_in) instead of the inner edge, and
   default gain raised to 6.
2. **Visibility metric swamped by the starfield.** Lensing streaks smear
   point stars across many pixels at full brightness (surface brightness
   is *not* conserved by the procedural star renderer — a known, accepted
   artifact of the cheap approach), so absolute bright-pixel counts could
   not separate the disk. Fixed with the difference-image metric; star
   brightness scale also reduced 0.55 → 0.3 (35% of star centers formerly
   saturated).
3. **Nearest-lit-pixel ISCO metric latched onto the photon ring** — the
   lensed secondary disk image hugs the shadow at *every* spin (correct
   physics defeating a naive metric). Replaced with the radial-profile
   half-peak inner edge.
