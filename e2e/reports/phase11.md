# Phase 11 Test Report — WebGPU Progressive Renderer

**Script:** `e2e/phase11.cjs` · **Runtime:** 16.1 s · **Result: PASS**
(with the pixel-parity check honestly SKIPPED in this environment — see
below)

## What was done

1. **WGSL validity:** `src/shaders/hq.wgsl` parses (wgsl_reflect), exports
   the `trace` compute entry point with exactly the two expected storage
   bindings (flat parameter array + accumulation buffer).
2. **Constant parity, enforced:** the physics-defining constants —
   capture-buffer scaling `0.02 * sqrt`, momentum threshold `1e8`,
   FD epsilon `2e-3`, adaptive step `0.1 * min(r - 0.9`, star cells
   `400.0`, star density `0.04`, emissivity normalization `36.0 / 49.0`,
   noise modulation `0.55 + 0.9`, and the disk-pattern `6.2831853` — must
   appear verbatim in **both** the GLSL and the WGSL. This mechanizes the
   "line-parallel structure" guarantee against silent drift between the
   two ports.
3. **Fallback and honest capability detection:** this container's
   Chromium exposes `navigator.gpu` on secure origins but returns **no
   adapter** (verified by direct probing; custom `--enable-unsafe-webgpu`
   flag combinations remove `navigator.gpu` entirely). The app now probes
   the adapter asynchronously and downgrades the HQ button to
   disabled + "WebGPU unavailable" — which is exactly what the test
   observes — while the WebGL2 renderer runs untouched.
4. **Pixel parity: SKIPPED (gpu-no-adapter).** The live comparison
   (4+ samples of the HQ accumulation vs the WebGL2 frame at identical
   static parameters — disk off so the time-advected noise cannot differ,
   bloom 0, full resolution, mean |diff| < 20) is implemented in the test
   and executes automatically in any WebGPU-capable browser. It **cannot
   execute in this container** — no software WebGPU adapter exists in the
   bundled Chromium — and the test reports the skip explicitly rather
   than passing vacuously or failing spuriously.

## Results

| Check | Value | Status |
|---|---|---|
| WGSL parses, entry `trace`, 2 storage bindings | yes | ✓ |
| Constant parity misses | none | ✓ |
| Adapter state | gpu-no-adapter | (environment) |
| HQ button state | disabled, "(WebGPU unavailable)" | ✓ |
| WebGL2 fallback renders | mean lum > 2 | ✓ |
| Pixel parity | SKIPPED (documented; auto-runs on real hardware) | — |

## Honest limitations

The WebGPU path's *runtime* behavior (device creation, pipeline setup,
accumulation loop, PNG export) has not been executed end-to-end in this
environment and should be exercised once in a WebGPU-capable browser
(Chrome/Edge on a machine with a GPU); the pixel-parity harness will run
automatically there. Everything statically verifiable — WGSL syntax,
entry-point/binding shape, physics-constant parity with the validated
GLSL, capability detection, fallback — is verified here.
