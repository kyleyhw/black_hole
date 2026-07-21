# Phase 17 Report — Merger Mode: Polish, Docs, Release

**Scope:** cinematic per-event framing, README merger section + animation GIF,
the "what's physical and what isn't" honesty ladder (docs + in-app popup), and
a full re-certification of every suite. No new e2e suite of its own — Phase 17
is polish and documentation over the Phase 14–16 engine, certified by
re-running the whole battery against the final build.

## What was done

- **Cinematic per-event framing** (`src/main.ts` `mergerSelect`). Selecting an
  event sets a fixed 3/4 view above the orbital plane, but the pull-back
  `radius ≈ clamp(1.6·d₀ + 8, 18, 34)` scales with that event's initial
  barycentric separation `d₀` (exposed as `MergerDriver.initialSeparation`).
  Light, low-`f_low` systems (GW151226 starts ~18 M wide) no longer crop, and
  heavy ones (GW190521, ~6 M) no longer render as specks.
- **README merger section** with the superposed-KS equation, the PN/chirp-mass
  /QNM chain, and `docs/img/merger.gif` (a GW150914 playthrough captured
  deterministically via the new `__bh.merger.seek` + `__bh.capture` tooling
  seams and assembled with Pillow; the waveform strip is composited in).
- **Honesty ladder.** The README "What's physical and what isn't" section gains
  a five-rung merger entry (metric / orbit / plunge / ringdown / time+sound)
  plus the transport caveat; the in-app `ⓘ` popup (`LEARN.binary`) was rewritten
  from the stale "static preview" text to the same ladder.
- **References** [6–8] added (GWTC-2.1, Boyle et al. TaylorT4, Berti–Cardoso–Will
  QNM); repository-layout tree and doc index updated for `merger.ts`,
  `gwevents.json`, `validation/pn.py`, `validation/superposed.py`.

## Re-certification

Full battery re-run against the production build:

| Suite | Result |
|---|---|
| Python float64 validation (all studies, incl. superposed-KS + PN) | PASS |
| e2e phase1 / phase3 / phase5 (core geodesics, disk, camera) | PASS |
| e2e phase6 (panel DOM, overlays, presets, download) | PASS |
| e2e phase8 / phase9 (tetrad shadow, free fall) | PASS |
| e2e phase10 / phase11 / phase12 (multi-mass, WebGPU HQ, UX layer) | PASS |
| e2e phase13 / phase14 / phase15 (binary metric, dynamics, chirp) | PASS |

The panel-DOM suite (phase6) is the one most exposed to the `LEARN.binary`
rewrite and the new retarded toggle; it passes, confirming the added control
and popup did not disturb the existing panel structure.

## Why

The merger feature is only honest if every approximation is visible to the
viewer, not just correct in the code. The five-rung ladder — in the README, in
the derivations, and one click away in the UI — is the deliverable as much as
the animation is: a portfolio piece about *physics → numerics → validation →
rendering* has to say plainly where the physics stops and the schematic begins.

## Notes

- Suites are run individually (each starts its own `vite preview` on a
  per-PID port); a lingering server from an interrupted run causes a one-off
  port-collision crash on the next suite, which clears on a standalone re-run.
- `docs/img/merger.gif` is ~1.6 MB (40 frames, 360×230, 64-color) — comparable
  to the existing `spin-sweep.gif`; the starfield's high-frequency detail
  bounds the GIF compression.
