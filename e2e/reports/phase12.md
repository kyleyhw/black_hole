# Phase 12 Test Report — Educational / UX Round

**Script:** `e2e/phase12.cjs` · **Runtime:** 35.3 s · **Result: PASS**
(5/5 checks executed, no skips)

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

Artifact: `screenshots/phase12-grid.png` (grid + shadow), and
`docs/img/grid-overlay.png` for the docs.

## Note on the mass question specifically

The user asked whether it is "normal for the mass slider to not show any
visible change." It is not a bug — it is the defining feature of the Kerr
solution's one-parameter (a/M) family of *shapes*. The test encodes this as
a falsifiable property: were the renderer to secretly depend on M beyond the
unit conversion, the pixel-identity assertion would fail.
