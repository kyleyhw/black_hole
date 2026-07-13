# Architecture

How the code is organised and why. The *physics* lives in
[derivations.md](derivations.md); the *numerical method* in
[numerics.md](numerics.md); the *shading and post-processing* in
[rendering.md](rendering.md). This document covers the software structure that
carries them: the render pipeline, the module layout, the single-algorithm /
multiple-backend strategy, and the testing harness.

## One algorithm, three expressions

The central design constraint is that the same geodesic integrator must exist
in three places, and they must agree:

| Expression | File | Role |
|---|---|---|
| GLSL fragment shader (f32) | `src/shaders/render.frag.glsl` | the real-time renderer — one ray per pixel |
| WGSL compute shader (f32) | `src/shaders/hq.wgsl` | the progressive high-quality still (WebGPU) |
| Python (f64) | `validation/kerr.py` | the analytic-oracle validation mirror |

Keeping one algorithm in three languages is a liability unless it is actively
policed, so it is: the three are written **line-parallel with shared section
banners**, the physics-defining constants (capture-buffer scaling, the |p|²
blow-up threshold, the FD ε, the step clamp, starfield cell counts) are
required by an e2e check to appear **verbatim** in both shaders, and the WGSL
and GLSL outputs are compared **pixel-for-pixel** at matched sampling (see
[Testing](#testing)). The f64 mirror is validated against closed-form GR
([validation.md](validation.md)). Divergence in any one shows up as a failing
check rather than a silently wrong image.

The reason for three rather than one is that each answers a different need:
f32 shaders because GPUs render in f32 and real-time demands it; the f64 mirror
because isolating algorithm error from precision error requires higher
precision and a scriptable oracle; WGSL because WebGPU's compute path enables
progressive multi-sample accumulation the fragment pipeline cannot.

## Render pipeline (data flow)

Every frame, `src/main.ts` drives a three-target HDR pipeline. The physics is
one full-screen draw; everything after it is image processing:

```
 camera (orbit or free-fall)
        │  basis() → position + orthonormal (right,up,forward)
        ▼
 buildTetrad()  ── Gram–Schmidt under the metric g at the camera ──┐
        │                                                          │
        ▼                                                          │
 ┌──────────────────────────┐   uE0..uE3 (tetrad legs, packed)    │
 │ scene pass (RGBA16F)      │◀──────────────────────────────────┘
 │  render.frag.glsl  OR     │   one ray/pixel: build q = −e₀+nⁱeᵢ,
 │  render.frag.glsl+WEAK    │   integrate the null geodesic, shade
 └──────────┬───────────────┘   disk / starfield / capture
            │ scene.tex
            ├───────────────► bright-pass + H Gaussian (½ res) ─► bloomA
            │                          bloomB ◀── V Gaussian ────┘
            ▼
 ┌──────────────────────────┐
 │ composite pass → canvas   │  scene + strength·bloom
 │  composite.frag.glsl      │  → ACES tonemap → gamma 2.2
 └──────────────────────────┘  → schematic overlays (ergo/photon/grid)
```

Reading the diagram: the tetrad is the bridge between the CPU camera and the
GPU — it is what makes each pixel's ray a *locally measured* direction, so
aberration and redshift come out exactly (derivations.md §8). The scene target
is `RGBA16F` because bloom on an 8-bit target bands; bloom runs at half
resolution because the blur radius doubles for free and the passes cost a
quarter as much. The composite pass is the only one that writes the canvas, and
it draws the diagnostic overlays in **flat space** deliberately — they are
coordinate-surface markers, not photons, so lensing them would misrepresent
them (rendering.md §Overlays).

## Module map

```
src/
  main.ts       render loop, target management, uniform packing, free-fall
                integration, HQ-still modal, mass-drag, __bh test hooks
  camera.ts     OrbitCamera: spherical controls, inertial damping, idle drift
  physics.ts    CPU closed forms: r₊, r_ISCO(a,s), photon/ergosphere radii
  tetrad.ts     f64 metric ops + Gram–Schmidt tetrad under g (camera frame)
  geodesic.ts   FreeFall: CPU timelike geodesic for the free-fall camera
  gl.ts         WebGL2 boilerplate; #define injection for shader variants
  webgpu.ts     WebGPU HQ-still session (adapter/device, accumulation, readback)
  panel.ts      hand-rolled control panel, live readouts, learn-more popups
  shaders/      render.frag.glsl (all physics), hq.wgsl (WGSL port),
                blur / composite / fullscreen
```

The split between `physics.ts`/`tetrad.ts`/`geodesic.ts` (CPU, f64) and the
shaders (GPU, f32) is deliberate: quantities that are computed **once per
frame** and must be accurate (the ISCO fed to the disk, the camera tetrad, the
free-fall worldline) live on the CPU in f64; quantities computed **once per
pixel** live in the shader. This keeps per-frame accuracy high without paying
f64 cost per ray (and WebGL2 has no f64 in shaders regardless).

### Compile-time shader variants

The linearized multi-mass mode is the *same* shader source compiled with
`#define WEAK_FIELD` (injected by `gl.ts` after the `#version` line), which
swaps only the metric and the ray initial condition. There is no runtime
branch in the integration loop — the hot path is identical, so the exact-Kerr
renderer pays nothing for a mode it is not using. The two programs
(`sceneProg`, `weakProg`) are built once at startup.

## Testing

Two tiers verify the project; the philosophy behind the split is in
[validation.md](validation.md). This section documents the *behavioural* tier's
machinery.

**Harness** (`e2e/harness.cjs`). Each test serves the built `dist/` with
`vite preview` and drives it through the pre-installed headless Chromium via
Playwright. Servers use a **per-process port** (`4200 + pid % 600`) because
stale listeners from interrupted runs are invisible to `ss` in the sandbox;
`--strictPort` turns a collision into an explicit rejection rather than a
silent connect-to-wrong-server.

**Why software rasterisation is exact, not approximate.** Headless Chromium
rasterises WebGL2 with SwiftShader (CPU). This is not a lower-fidelity
stand-in: it executes the *same* IEEE-754 f32 GLSL the GPU would, so the pixel
values are the real renderer's output, just produced slowly. For WebGPU the
container exposes a full software adapter under
`--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader`, which is how the
GLSL↔WGSL pixel-parity check runs in-container at all.

**Test seams.** The build exposes controlled entry points so tests need no
synthetic input and stay deterministic:

- `window.__bh` — the live `{ camera, params, gl, freefall, … }`, so a test
  sets state directly instead of dispatching pointer events.
- `window.__bhTest` (set by the harness before page scripts run) — disables the
  cinematic idle-orbit drift and starts the renderer at resolution 0.75, the
  scale the pixel thresholds are calibrated against, so a full-res default
  frame cannot stall Playwright's actionability polling under software render.
- `window.__bhDiskTime` — pins the disk's fast-forwarded turbulence clock so a
  physical measurement (beaming, geometry) is read on a static pattern.
- `window.__bhHq`, `window.__bhHqFreeze` — expose and freeze the WebGPU
  accumulation session for the pixel-parity readback.

**Isolate the measured quantity.** Behavioural thresholds are kept honest by
measuring the isolated quantity rather than loosening bounds: e.g. disk-beaming
asymmetry is taken from a disk-on **minus** disk-off frame, cancelling the
starfield exactly, so a change to how stars are drawn cannot move the result.
The per-phase reports under [`../e2e/reports/`](../e2e/reports/) record each
suite's runtime, rationale, and any failure with its fix.
