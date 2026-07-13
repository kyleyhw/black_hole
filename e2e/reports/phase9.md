# Phase 9 Test Report — Retrograde Disk and Inclination

**Script:** `e2e/phase9.cjs` · **Runtime:** 41.3 s · **Result: PASS**

## What was done

1. **BPT ISCO values** exposed from the app's own `riscoOf(a, s)`:
   prograde and retrograde at a = 0.9 vs the analytic 2.3209 / 8.7174 M.
2. **Beaming flip under s → −s** (a = 0.9, edge-on): the bright side must
   move from screen-left to screen-right when the flow is reversed.
3. **Retrograde ISCO hole** (face-on): the annulus hole must widen far
   beyond the prograde (shadow-bounded) hole when r_ISCO jumps to 8.72 M.
4. **Inclination** (a = 0, tilt 23°): large image change, disk still
   visible (tilted-plane crossing detection and bisection work).

## Why

The s = ±1 generalization threads through Ω, u^t, and r_ISCO — the flip
test checks the *sign* chain end-to-end, the hole test the ISCO coupling,
and the BPT check the formula itself. The tilt test exercises the
generalized crossing detection (x·n̂ instead of z) and the in-plane basis
used for the noise angle. The redshift for tilted disks uses the angular
momentum about the disk normal evaluated at the hit — exact at a = 0,
labeled a kinematic approximation for a ≠ 0 in the UI and docs.

## Results

| Check | Value | Bound | Status |
|---|---|---|---|
| r_ISCO(0.9, +1) | 2.32088 M | 2.3209 ± 0.002 | ✓ |
| r_ISCO(0.9, −1) | 8.71735 M | 8.7174 ± 0.002 | ✓ |
| Left/right, prograde | 1.65 | > 1.2 | ✓ |
| Left/right, retrograde | 0.75 | < 0.91 | ✓ |
| Face-on hole, prograde | 29 px | — | — |
| Face-on hole, retrograde | 73 px | > 1.4 × prograde | ✓ (2.5×) |
| Tilt image change | 40.7% | > 5% | ✓ |
| Tilt disk visibility | 53% bright | > 1% | ✓ |

Physics note visible in the numbers: the retrograde asymmetry (0.75) is
weaker than the prograde one (1/1.65 = 0.61) — retrograde matter at its
much larger ISCO orbits slower, so beaming is genuinely milder, not a bug.

Screenshots: `phase9-retro-a09.png`, `phase9-retro-faceon-a09.png` (the
star-filled gap between shadow and the receded disk inner edge is the
retrograde ISCO), `phase9-tilt-a0.png`.

## Failures encountered and fixes

None — first run passed. (The state-setting helper pins all Phase 8/9
parameters explicitly, a lesson from earlier phases' default-drift
regressions.)
