# Phase 18 Test Report (suite #16) — Time-Dependent (Retarded) Ray Transport

**Script:** `e2e/phase16.cjs` · **Runtime:** 26.6 s · **Result: PASS**

## What was done

The binary metric is time-dependent, but the default renderer freezes it per
frame (every ray sample sees the two holes at their frame-instant positions).
Phase 18 adds a `RETARDED` shader variant (compiled with `BINARY`) that honors
the time dependence: it carries the full null-geodesic state
$(t, \mathbf x, p_t, \mathbf p)$, integrates coordinate time
$dt/d\lambda = g^{t\nu}p_\nu$ and its no-longer-conserved conjugate
$d p_t/d\lambda = -\partial_t H$ (a fourth, temporal central difference), and
advances each hole along its **circular worldline**
$\mathbf c(t) = R[\cos\omega t\,\hat{\mathbf r} + \sin\omega t\,\hat{\mathbf t}]$
so a ray sampling the metric at its local time finds the hole where it
actually was. A Merger-panel toggle selects frozen vs. retarded; the physics
and honesty caveats are in `docs/derivations.md §14` and the `LEARN.retarded`
popup.

Three checks:

1. **Static-limit anchor.** With $\mathbf v = 0$ (the static two-hole preview)
   the worldline advance is identically zero, $\partial_t H = 0$, and the
   retarded program must reproduce the frozen image **bit-for-bit**. This also
   proves the retarded GLSL compiles and renders under SwiftShader without the
   branchy-inline JIT blow-up that plagued the boosted metric earlier — a hang
   here would time the test out.
2. **Retardation is real and grows with the orbit.** For a moving system
   (GW150914) the retarded and frozen images must differ, and the difference
   must be larger at a tighter/faster orbital point (bigger $\omega \times$
   light-crossing time) than at a wide/slow one.
3. **Finiteness.** Every frame stays in a sane luminance band (no NaN/garbage).

## Results

| Check | Value | Bound | Status |
|---|---|---|---|
| Compile + first retarded draw | 4.0 s | < 30 s (no JIT blow-up) | ✓ |
| Static-limit pixel difference | **0.000** | < 2×10⁻³ | ✓ |
| Static render finite | yes | — | ✓ |
| Diff, wide/slow orbit (0.08 t_merger) | 0.708 | > 2×10⁻³ | ✓ |
| Diff, tight/fast orbit (0.60 t_merger) | 0.734 | > 0.02 and > wide | ✓ |
| Retardation grows as orbit tightens | 0.734 > 0.708 | — | ✓ |
| All moving renders finite | yes | — | ✓ |

The static-limit difference is **exactly zero** — not merely within tolerance —
because with $\mathbf v = 0$ the circular-advance term vanishes and every
arithmetic operation collapses to the frozen flow. That is the strongest form
of the anchor: the retarded machinery is provably a superset that contains the
frozen renderer as its $\mathbf v \to 0$ special case.

## What the difference looks like

At the tight orbital point the two renders are qualitatively distinct and both
physically coherent (`phase16-tight-{frozen,retarded}.png`):

- **Frozen** shows the expected **two side-by-side shadows** — the holes pinned
  at their frame positions.
- **Retarded** shows a **single, rounder, orbit-smeared shadow**: because the
  light-crossing time is a real fraction of the orbital period, different rays
  sample the holes at different orbital phases, blending the pair. The lensing
  rings around it are clean — this is a reorganized image, not noise.

That ~70% of pixels change is the honest magnitude of the effect at this
framing: retardation here is first-order, not a small perturbation, which is
exactly why the frozen approximation is worth flagging and worth having a fix
for.

## Why

"Frozen-metric" was the one rung of the merger honesty ladder that described a
shortcut without offering the alternative. Phase 18 closes it: the alternative
now exists, is one toggle away, is documented as itself approximate (circular
worldline, frame-frozen boost, per-frame $R$), and is pinned by a
bit-exact static-limit test — the same standard every other subsystem is held
to.

## Failures encountered and fixes

1. **Unbounded worldline extrapolation (first cut).** A naive linear worldline
   $\mathbf c_0 + \mathbf v\,t$ let far-travelling rays (with $|t|\sim$ hundreds
   of $M$) fling the holes off their bounded orbit, producing an incoherent
   whole-frame difference (early diff 0.63 while late was 0.02 — the wrong
   ordering). Replaced with the exact **circular** worldline, which stays on the
   orbit for all $t$, reduces to the linear form for $|\omega t|\ll1$, and made
   the effect grow with the orbit as physics requires.
2. **DOM panel diluting the diff.** Full-page screenshots included the (unchanged)
   control panel, halving the measured difference. Switched to the canvas-only
   `__bh.capture()` seam so the comparison is pure scene physics.

## Notes

- The retarded path is ~2× the frozen cost (a fourth FD direction); it is an
  opt-in comparison mode, not the default.
- Deterministic: binary mode has no time-varying starfield, so frozen and
  retarded differ only by the transport, and the numbers reproduce exactly.
