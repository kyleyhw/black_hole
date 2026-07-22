# Suite #15 Test Report — Real-Data Chirp Strip (no audio)

**Script:** `e2e/phase15.cjs` · **Runtime:** 59.8 s · **Result: PASS**

## What was done

The merger strip was reworked from a synthesized-and-played waveform into a
static plot of the **real GW150914 detection**, and all sound was removed.
The strip now draws the H1 observed strain (whitened with a Welch PSD,
band-passed 35–350 Hz) with the released numerical-relativity reconstruction
overlaid, aligned so the merger sits at t = 0. The data is embedded in
`src/gw150914_chirp.json` (600 samples over [−0.13, +0.04] s; GWOSC files
`H-H1_LOSC_4_V2-1126259446-32.hdf5` + `GW150914_4_template.hdf5`, DOI
10.7935/K5MW2F23). A playhead sweeps across it in step with the visual clock.

Checks:

1. **Real data present and chirps.** The embedded reconstruction's
   zero-crossing rate must rise from early inspiral to merger — a genuine
   frequency sweep in the real signal — and the observed trace must be present
   at the same length.
2. **Strip shows for GW150914** with a drawn trace (non-blank 2D canvas) and a
   readout naming the event and "strain".
3. **Other events hide the strip** (no real data for them) — the animation
   still runs silently.
4. **No audio**: the old `__bh.merger.audio()` hook is gone (the entire
   WebAudio path was deleted).
5. **Hide paths**: the strip's × hides it (re-select restores), and the
   sidebar collapse hides it too.

## Results

| Check | Value | Status |
|---|---|---|
| Reconstruction zero-crossings, early inspiral | 4 | — |
| Reconstruction zero-crossings, near merger | 23 | ✓ rises (> 1.5× early) |
| Real data present (n = 600, observed + reconstruction) | yes | ✓ |
| Chirp (zc rises into merger) | yes | ✓ |
| Strip shown for GW150914, trace drawn (3293 lit px), readout names event+strain | yes | ✓ |
| Other event (GW151226) hides the strip | yes | ✓ |
| No audio hook | yes | ✓ |
| Hide via × / re-select restores | yes | ✓ |
| Hide via sidebar collapse / restores | yes | ✓ |

## Why

The owner asked for the actual detection rather than a model of it. Plotting
the real strain (with the published reconstruction for legibility) makes the
strip honest — it is the one part of the merger view that is measured data,
not procedural — and it is still testable: the sweep check is an assertion on
the real signal's rising frequency, the same way every other subsystem is
pinned to a number. Removing audio was a direct request; the animation is now
silent by design and degrades to nothing on that axis.

## Notes

- Single-detector strain is genuinely noisy (SNR ~20 without matched
  filtering); the reconstruction overlay is what makes the chirp legible, and
  both are shown so the plot is real, not a clean model standing in for data.
- The strip only appears for GW150914 (the reference detection with embedded
  data); other catalog events animate without it.
