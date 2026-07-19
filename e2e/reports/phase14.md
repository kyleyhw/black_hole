# Phase 15 Test Report (suite #14) — PN-Driven Merger Animation

**Script:** `e2e/phase14.cjs` · **Runtime:** 26.1 s · **Result: PASS**

## What was done

`src/merger.ts` drives the binary shader through a full LIGO-event merger:
TaylorT4 inspiral (precomputed at event selection, interpolated per frame),
C¹ Hermite plunge blend, seamless swap to the exact-Kerr remnant via the
coincident-superposition identity (derivations.md §12), with the per-hole
boost matrices live (tangential v_i = r_i ω, reaching ~0.2 c each at the
ISCO for equal masses). Five checks against GW150914:

1. **Cross-language PN parity.** The TS TaylorT4 mirror's inspiral duration
   (35 Hz → ISCO, detector frame) vs the Python suite's validated value.
2. **Initial state.** Separation 1/x(f_low) and f_GW at the 35 Hz start.
3. **Dynamics.** Playing, separation must shrink and f_GW rise
   monotonically through inspiral into plunge.
4. **Merger completes.** Timeline reaches ringdown at the remnant's
   (2,2,0) QNM frequency; the image collapses to a single central shadow;
   every sampled frame stays finite while the boost matrices are live.
5. **Controls.** Pause freezes the clock exactly; restart rewinds to f_low.

## Why

The driver is the bridge between the validated physics (Python suite) and
the screen. The cross-language check pins the coefficient transcription;
the initial-state check pins the unit chain (Hz → geometric x → M-units
separation); monotonicity pins the timeline integration; the ringdown
checks pin the blend endpoint and the remnant swap; frame finiteness is the
first in-browser exercise of the live (non-identity) boost matrices.

## Results

| Check | Value | Bound | Status |
|---|---|---|---|
| TS inspiral duration vs Python | 0.09052 s vs 0.0905 s | 1% | ✓ (0.02%) |
| Initial separation | 8.684 M | 8.68 ± 0.15 | ✓ |
| Initial f_GW | 35.000 Hz | 35 ± 0.3 | ✓ |
| Separation monotone ↓ / f_GW monotone ↑ | 5 samples through inspiral+plunge | required | ✓ |
| Reaches ringdown at QNM | 249.34 Hz | 249.3 ± 5 | ✓ |
| Remnant: single central shadow | center dark fraction 1.00 | > 0.5 | ✓ |
| All sampled frames finite (live boosts) | mean lum in (2, 220) every frame | required | ✓ |
| Pause freezes / restart rewinds | Δsep = 0 paused; sep back to 8.68 | exact / ± 0.15 | ✓ |

Screenshots: `phase14-inspiral.png`, `phase14-plunge.png`,
`phase14-ringdown.png` (single shadow + Einstein ring of the remnant);
`docs/img/merger-inspiral.png` (close-in pair, sep 6.4 M at 55 Hz).

## Failures encountered and fixes

First run failed only the sample-count floor (2 samples): at slow-motion
×10, the wall-time cost of per-iteration screenshots advanced the clock
through the 140 ms timeline in ~3 iterations. Slow-motion ×30 in the test
(with the frame-time dt clamp this is ~3.3 ms physical per rendered frame)
yields enough samples; a test-pacing fix, not a physics change.

## Notes

- Full 11-suite certification after this phase: 9 suites passed in the
  batch sweep; phase 6 and phase 10 hit Playwright actionability timeouts
  under batch resource contention (the whole sweep ran ~20-25% slower than
  usual) and passed cleanly when re-run standalone with no code changes —
  11/11 green.
- The slow-motion default in the UI is ×25; the readout shows physical
  t − t_merger, separation, f_GW, and the slow-motion factor, per the
  approved time-mapping design (visuals slow, chirp — Phase 16 — at true
  rate).
