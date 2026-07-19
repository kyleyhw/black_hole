# Phase 12 Test Report — Educational / UX + Animation Round

**Script:** `e2e/phase12.cjs` · **Runtime:** ~60 s · **Result: PASS**
(6/6 checks executed, no skips; full 9-suite sweep re-certified green)

## What this round added

Five requests, each verified against the built product (Chromium +
software WebGL2, served by `vite preview`):

1. **Mass slider does nothing visible — and that is the physics.** The Kerr
   geometry is scale-free: every length is proportional to M, so the image
   is invariant under a change of mass; only the physical-unit caption
   moves. This is now stated in the panel (a note row under the slider) and
   explained in a "Why doesn't mass change the image?" popup.
2. **Stop-free-fall button.** The Release button relabels itself to
   **Stop free fall** while the camera is on a geodesic; clicking it halts
   the plunge in place (no reset unless already inside R_MIN).
3. **Coordinate-grid overlay.** Equatorial circles of constant
   Kerr–Schild radius (every 2M) and 12 azimuthal spokes, drawn unlensed
   like the other schematic markers — a scale reference.
4. **Click-to-learn.** Small ⓘ buttons on section headers and key rows open
   a shared modal with a short, accurate physics blurb — education without
   panel clutter. Twelve blurbs in total.
5. **Collapsible sidebar.** A persistent tab (`#panelToggle`) hides/shows
   the whole panel.

A sixth request arrived mid-round — **every quantity must be defined**
(a, φ, …). A **Units & notation** glossary (ⓘ at the top of the panel)
now defines M, a, r, θ, φ, r₊, r_ISCO, Ω, uᵗ, E, L_z, λ, g, g★, Φ, H, and
fixes the geometrized-unit convention behind the "M" the sliders read; the
About modal points to it and defines a and M inline.

## How each check is made non-trivial

- **Mass invariance** is a *pixel-identity* assertion, not "looks similar":
  moving M from 10 to 10⁶ M☉ must change **exactly zero** pixels
  (`massPixelDiff === 0`) while the readout text **does** change
  (`26.6 km → 0.0178 au`). The disk is turned **off** for this check: its
  procedural noise advects with `uTime` between the two screenshots and
  would inject a spurious difference unrelated to mass. The static lensed
  sky is the clean scale-invariance witness.
- **Free-fall stop** checks the full state machine: button reads "Stop free
  fall" *during* the fall, `freefall.active` goes false on click, the
  camera radius **stays put** (|Δr| < 0.5, and r < 12 — i.e. it did *not*
  snap back to the default 18), and the label reverts to "Release".
- **Learn modal** is not just "opens": it asserts the notation glossary
  actually **defines the symbols** — the text must contain "spin
  parameter", "azimuthal angle", and "redshift factor" (a, φ, g).

## Results

| Check | Value | Status |
|---|---|---|
| Mass scale-invariance (pixel-identical, readout changes) | diff = 0; `26.6 km → 0.0178 au` | ✓ |
| Grid overlay toggles pixels | 5.5% of frame | ✓ |
| Free-fall stop (label, halt, stays put, revert) | "Stop free fall" → stopped, r held | ✓ |
| Learn modal opens, defines a/φ/g, closes | yes | ✓ |
| Sidebar collapse + reopen | yes | ✓ |
| Idle auto-orbit drifts, freezes when off | drift 0.2 rad, then frozen | ✓ |
| Physical camera: drag graded/bounded, smooth (max frame jump 0.0098 c), static at rest | max 0.049 c | ✓ |

Artifact: `screenshots/phase12-grid.png` (grid + shadow), and
`docs/img/grid-overlay.png` for the docs.

## Animation / realism additions (same round)

- **Cinematic idle orbit.** After `IDLE_ORBIT_DELAY` (4 s) without input the
  camera drifts azimuthally at 0.003125 rad/s (~34 min/rev); any discrete interaction (tracked
  by capture-phase `window` listeners) resets the idle clock, and toggling it
  off freezes the camera. The check lifts the harness freeze, confirms the
  azimuth advances monotonically, then confirms it stops dead when disabled.
  Disabled under the harness by default (`__bhTest`) so every other suite sees
  a still camera.
- **Visible Keplerian shear.** The disk texture already advected in
  co-rotating coordinates φ − Ω(r)·t; a ×2 playback scale (`DISK_TIME_SCALE`)
  makes the differential rotation legible — inner annuli outrun outer ones. It
  is a pure time remap; the instantaneous g and g⁴ beaming use Ω(r) directly
  and are unchanged (verified: phase 11 GLSL↔WGSL parity still 3.2/255).
- **Half-size stars.** Star footprint halved toward true point sources
  (`STAR_SIZE = 0.5`) with 1/STAR_SIZE² flux-conserving peak compensation, so
  the sky keeps its brightness while the stars sharpen.

## Test hardening this round (root causes, not threshold nudges)

- **`__bhDiskTime` seam** freezes the fast-forwarded turbulence so physics
  suites measure a static pattern.
- **phase 9 beaming is now disk-only** (on-frame minus off-frame cancels the
  frozen starfield exactly): the flip signal sharpened from 1.5/0.95 —
  marginal — to **4.47 / 0.56**, immune to any star-rendering change.
- **phase 10 validity now polls** for the indicator text instead of racing a
  fixed 400 ms wait that a slow multi-mass frame could overrun.
- **Test-mode resolution pinned to 0.75** (the long-standing calibration): the
  new product default is 1.00×, which a software-WebGL2 frame cannot sustain
  under Playwright's actionability polling; `__bhTest` falls back to 0.75 so
  the pixel thresholds in phase 5/9 (which pin nothing) stay valid.

## Camera-drag regression (two shipped bugs this check now catches)

The moving-observer camera shipped broken **twice**, each time because the
verification did not match how a human drives it. The final check is built
from per-frame instrumentation of real pointer gestures.

**Round 1 (physics-only test, shipped broken).** Verified via
`centerQtMoving` with a synthetic velocity only. In use, the raw per-frame
finite-difference velocity of a drag is superluminal (~1.6 c), clamped to
0.995 c — maximal aberration — and strobed on/off because pointer events do
not land on every frame (`0 0 0 1.5 0 0 0 1.5`).

**Round 2 (batch-sampled drag test, still broken).** An
`isManipulating`-gated EMA with a `tanh` map passed a batch-sampled drag
test but per-frame tracing exposed three defects a user feels immediately:
*binary saturation* — `V_ref = 1 M/s` sits an order of magnitude below real
drag speeds (3–20 M/s), so any touch pegged the 0.5 c cap (≈29° of
aberration); *one-frame snaps* — speed 0 → 0.47 c at gesture start and
0.49 c → 0 at release (measured max frame-to-frame jump **0.494 c**); and a
*sawtooth* at the pointer cadence (`0.50 0.49 0.47 0.43 | 0.50 …`). Two
further regime bugs surfaced under tracing: the teleport guard fired on
legitimate batched drag steps (> 1.5 M per frame), repeatedly zeroing the
estimator mid-gesture, and on slow devices a frame period longer than the
sliding window left the window with a single sample — velocity silently
always zero.

**Final design** (each stage tied to a measured failure): 0.32 s
sliding-window derivative with a straddling-sample eviction rule (bridges
pointer cadence; survives slow frames), time-constant EMA
`k = 1 − exp(−dt/τ)`, τ = 0.15 s (fps-independent, no one-frame jumps),
gesture gating with a 0.6 s post-input grace (decays through the release
coast; programmatic writes render static; teleport guard only outside live
gestures), and `V_max·tanh(|v|/V_ref)` with `V_max = 0.25 c`,
`V_ref = 10 M/s` (graded: slow drag ≈ 0.05–0.1 c, fast sweep → cap).

**Measured after the fix** (per-frame traces, three cadences): smooth ramp
→ steady plateau → smooth decay; max frame-to-frame jump **0.024–0.031 c**
(was 0.494); no sawtooth; still camera pixel-identical (diff = 0); slow-frame
regime produces a working estimate.

**Check 5b** drives a real Playwright pointer drag **paced by wall clock**
(the velocity is a wall-clock quantity — frame-paced dragging on a slow
software renderer is a genuinely slow gesture, which the estimator rightly
reports as near-static; the earlier check failed for exactly that reason)
under a lightened render config, and asserts via `__bh.camSpeed()`: speed
exactly 0 at rest, bounded < 0.5 c and actually moving during the drag,
**max frame-to-frame jump < 0.15 c** (the smoothness invariant violated by
both shipped bugs), and decay to < 0.02 c after release.

## Note on the mass question specifically

The user asked whether it is "normal for the mass slider to not show any
visible change." It is not a bug — it is the defining feature of the Kerr
solution's one-parameter (a/M) family of *shapes*. The test encodes this as
a falsifiable property: were the renderer to secretly depend on M beyond the
unit conversion, the pixel-identity assertion would fail.
