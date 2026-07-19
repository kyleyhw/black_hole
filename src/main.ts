import { getGL, createProgram, uniforms } from "./gl";
import { OrbitCamera } from "./camera";
import { riscoOf } from "./physics";
import { buildPanel, type PanelParams } from "./panel";
import {
  buildTetrad, buildTetradBinary, staticObserver, staticObserverBinary, movingObserver,
  metricTerms as metricTermsPublic, type BinaryHole, type Vec4,
} from "./tetrad";
import { FreeFall } from "./geodesic";
import { MergerDriver, type GwEvent } from "./merger";
import gweventsRaw from "./gwevents.json";
import { createHqSession, webGpuSupported, type HqSession } from "./webgpu";
import vertSrc from "./shaders/fullscreen.vert.glsl?raw";
import sceneSrc from "./shaders/render.frag.glsl?raw";
import blurSrc from "./shaders/blur.frag.glsl?raw";
import compositeSrc from "./shaders/composite.frag.glsl?raw";

const params: PanelParams = {
  spin: 0.6,
  massMsun: 10,
  maxSteps: 400,
  debugView: 0,
  // Full internal resolution by default. Under the e2e harness (__bhTest set
  // via addInitScript before this runs) fall back to 0.75 — the long-standing
  // test-time scale the pixel thresholds are calibrated against — so the
  // software renderer stays responsive without a full-res 1.0 frame stalling
  // Playwright's actionability polling before each test sets its own scale.
  resolutionScale: (window as unknown as { __bhTest?: boolean }).__bhTest ? 0.75 : 1.0,
  diskOn: true,
  diskOuter: 12.0,
  beaming: true,
  // Exposure such that the emission peak reaches HDR > 1 before the ACES
  // tonemap; the r^-3 falloff otherwise leaves most of the disk invisible.
  diskGain: 9.0,
  bloomStrength: 0.0,
  ergoOn: false,
  photonOn: false,
  gridOn: false,
  skyShift: true,
  autoOrbit: true,
  diskSense: 1,
  diskIncl: 0,
  mode: "kerr",
  // Binary merger preview (Phase 14, static): mass ratio q = M2/M1 with
  // M1 = 1 (all lengths in units of M1), barycentric separation in M,
  // aligned dimensionless spins per hole.
  binarySep: 16,
  binaryQ: 1,
  binaryChi1: 0.7,
  binaryChi2: -0.3,
  masses: [
    { m: 1.0, pos: [0, -8, 0] },
    { m: 0.5, pos: [0, 8, 2] },
  ],
};

const canvas = document.getElementById("view") as HTMLCanvasElement;
const gl = getGL(canvas);
// Float render targets for the HDR pipeline (verified available in all
// target browsers; hard requirement for bloom that doesn't band).
if (!gl.getExtension("EXT_color_buffer_float")) {
  throw new Error("EXT_color_buffer_float unavailable — HDR pipeline needs it.");
}

const sceneProg = createProgram(gl, vertSrc, sceneSrc);
// Weak-field multi-mass variant: same source, compile-time metric swap.
const weakProg = createProgram(gl, vertSrc, sceneSrc, ["WEAK_FIELD"]);
// Binary merger variant (superposed boosted Kerr-Schild, derivations.md sec. 11).
const binaryProg = createProgram(gl, vertSrc, sceneSrc, ["BINARY"]);
const blurProg = createProgram(gl, vertSrc, blurSrc);
const compositeProg = createProgram(gl, vertSrc, compositeSrc);

const uScene = uniforms(gl, sceneProg, [
  "uResolution", "uCamPos", "uCamRight", "uCamUp", "uCamForward", "uTanHalfFov",
  "uSpin", "uMaxSteps", "uDebugView",
  "uDiskOn", "uDiskInner", "uDiskOuter", "uBeaming", "uDiskGain", "uTime",
  "uE0", "uE1", "uE2", "uE3", "uSkyShift",
  "uDiskSense", "uDiskNormal", "uDiskE1", "uDiskE2",
]);
const uWeak = uniforms(gl, weakProg, [
  "uResolution", "uCamPos", "uCamRight", "uCamUp", "uCamForward", "uTanHalfFov",
  "uMaxSteps", "uDebugView", "uDiskOn",
  "uNMasses", "uMassPos", "uMassM",
]);
const uBinary = uniforms(gl, binaryProg, [
  "uResolution", "uCamPos", "uCamRight", "uCamUp", "uCamForward", "uTanHalfFov",
  "uSpin", "uMaxSteps", "uDebugView", "uDiskOn",
  "uE0", "uE1", "uE2", "uE3", "uSkyShift",
  "uB1Pos", "uB1M", "uB1A", "uB1Boost", "uB2Pos", "uB2M", "uB2A", "uB2Boost",
]);
const uBlur = uniforms(gl, blurProg, ["uTex", "uTexelSize", "uDir", "uThreshold"]);
const uComp = uniforms(gl, compositeProg, [
  "uScene", "uBloom", "uResolution", "uBloomStrength",
  "uErgoOn", "uPhotonOn", "uGridOn", "uSpin", "uDebugView",
  "uCamPos", "uCamRight", "uCamUp", "uCamForward", "uTanHalfFov",
]);

interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

function makeTarget(w: number, h: number): Target {
  const tex = gl.createTexture();
  if (!tex) throw new Error("createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error("createFramebuffer failed");
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, w, h };
}

function destroyTarget(t: Target): void {
  gl.deleteFramebuffer(t.fbo);
  gl.deleteTexture(t.tex);
}

let scene: Target | null = null;
let bloomA: Target | null = null;
let bloomB: Target | null = null;

function ensureTargets(): void {
  const w = Math.max(8, Math.round(canvas.clientWidth * devicePixelRatio * params.resolutionScale));
  const h = Math.max(8, Math.round(canvas.clientHeight * devicePixelRatio * params.resolutionScale));
  const cw = Math.round(canvas.clientWidth * devicePixelRatio);
  const ch = Math.round(canvas.clientHeight * devicePixelRatio);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  if (!scene || scene.w !== w || scene.h !== h) {
    if (scene) destroyTarget(scene);
    if (bloomA) destroyTarget(bloomA);
    if (bloomB) destroyTarget(bloomB);
    scene = makeTarget(w, h);
    // Bloom at half the internal resolution: the blur radius doubles for
    // free and the passes cost a quarter as much.
    const bw = Math.max(4, w >> 1);
    const bh = Math.max(4, h >> 1);
    bloomA = makeTarget(bw, bh);
    bloomB = makeTarget(bw, bh);
  }
}

const camera = new OrbitCamera();

// Mass dragging (multi-mass mode): picks the nearest projected mass within
// 40 px and moves it in the camera plane at its depth. Attached before the
// orbit camera so stopImmediatePropagation suppresses orbiting during drag.
interface MassDrag {
  index: number;
  depth: number; // forward-axis distance, held fixed while dragging
}
let massDrag: MassDrag | null = null;

function projectMass(pos: readonly number[], b: ReturnType<OrbitCamera["basis"]>):
  { sx: number; sy: number; depth: number } | null {
  const q = [pos[0]! - b.pos[0], pos[1]! - b.pos[1], pos[2]! - b.pos[2]];
  const cz = q[0]! * b.forward[0] + q[1]! * b.forward[1] + q[2]! * b.forward[2];
  if (cz < 0.5) return null; // behind or too close to the camera
  const cx = q[0]! * b.right[0] + q[1]! * b.right[1] + q[2]! * b.right[2];
  const cy = q[0]! * b.up[0] + q[1]! * b.up[1] + q[2]! * b.up[2];
  const tanHF = Math.tan(camera.fovY / 2);
  const aspect = canvas.clientWidth / canvas.clientHeight;
  const sx = (cx / (cz * tanHF * aspect) + 1) * 0.5 * canvas.clientWidth;
  const sy = (1 - cy / (cz * tanHF)) * 0.5 * canvas.clientHeight;
  return { sx, sy, depth: cz };
}

canvas.addEventListener("pointerdown", (e: PointerEvent) => {
  if (params.mode !== "multi") return;
  const b = camera.basis();
  let best: { index: number; d: number; depth: number } | null = null;
  params.masses.forEach((mk, i) => {
    const pr = projectMass(mk.pos, b);
    if (!pr) return;
    const d = Math.hypot(pr.sx - e.clientX, pr.sy - e.clientY);
    if (d < 40 && (!best || d < best.d)) best = { index: i, d, depth: pr.depth };
  });
  if (best !== null) {
    massDrag = { index: (best as { index: number }).index, depth: (best as { depth: number }).depth };
    e.stopImmediatePropagation();
  }
});
canvas.addEventListener("pointermove", (e: PointerEvent) => {
  if (!massDrag) return;
  e.stopImmediatePropagation();
  const b = camera.basis();
  const tanHF = Math.tan(camera.fovY / 2);
  const aspect = canvas.clientWidth / canvas.clientHeight;
  const nx = (e.clientX / canvas.clientWidth) * 2 - 1;
  const ny = 1 - (e.clientY / canvas.clientHeight) * 2;
  const cz = massDrag.depth;
  const cx = nx * tanHF * aspect * cz;
  const cy = ny * tanHF * cz;
  const mk = params.masses[massDrag.index];
  if (!mk) return;
  mk.pos = [
    b.pos[0] + b.right[0] * cx + b.up[0] * cy + b.forward[0] * cz,
    b.pos[1] + b.right[1] * cx + b.up[1] * cy + b.forward[1] * cz,
    b.pos[2] + b.right[2] * cx + b.up[2] * cy + b.forward[2] * cz,
  ];
});
canvas.addEventListener("pointerup", () => (massDrag = null));

camera.attach(canvas);
const freefall = new FreeFall();

// Cinematic idle orbit: after a few seconds without input the camera eases
// into a slow azimuthal drift (slow rotation is what makes the D-shaped
// shadow and frame-dragging asymmetry legible). Any discrete interaction
// resets the idle clock via capture-phase listeners, so it stops instantly
// on touch and resumes only after stillness. `__bhTest` disables it so the
// e2e suites see a still camera.
const IDLE_ORBIT_DELAY = 4.0; // seconds of stillness before drifting
const IDLE_ORBIT_RATE = 0.003125; // rad/s — ~34 min per revolution, barely perceptible
for (const ev of ["pointerdown", "pointerup", "wheel", "touchstart", "touchend", "keydown"])
  window.addEventListener(ev, () => camera.markInteraction(), { capture: true, passive: true });

// Physical moving-observer camera: the interactive orbit is treated as a real
// observer worldline, so its coordinate velocity drives aberration and Doppler
// via the tetrad's e0. A hand-drag's raw coordinate speed is huge (measured
// 3–20 M/s ≡ 3–20 c at r = 18 M), so the drag→velocity mapping must be shaped
// or the aberration breaks. Per-frame instrumentation of the naive mapping
// showed three failure modes: binary saturation (any touch pegged the cap),
// one-frame snaps at drag start and release (~0.5 c jumps), and a sawtooth at
// the pointer-event cadence. The pipeline below addresses each:
//  - sliding-window position derivative (CAM_WINDOW_S): cadence-independent,
//    and drains smoothly to zero after motion stops. The window must exceed
//    the slowest real pointer cadence (~0.2 s for a slow hand plus event
//    latency) or single pointer steps spike-and-drain as a sawtooth;
//  - time-constant EMA (CAM_TAU_S, k = 1 − exp(−dt/τ)): fps-independent
//    smoothing, no single-frame jumps;
//  - estimation stays live for CAM_ACTIVE_S after the last user input, so the
//    velocity decays through the release coast instead of snapping to zero;
//  - tanh map with CAM_VEL_REF chosen INSIDE the real drag-speed range, so a
//    slow drag gets mild aberration and only a fast one approaches the cap;
//  - programmatic camera writes (tests, presets, resets) are not motion: they
//    are gated out by the user-input recency check, and any one-frame jump
//    larger than CAM_TELEPORT_M clears the estimator entirely. The teleport
//    check is skipped while the pointer is actually down — batched pointer
//    events legitimately move several M per frame during a drag, and only a
//    programmatic write can teleport the camera mid-gesture.
const CAM_WINDOW_S = 0.32; // sliding window for the position derivative (s)
const CAM_TAU_S = 0.15; // EMA time constant (s)
const CAM_VEL_MAX = 0.25; // asymptotic speed cap (units of c): max aberration ~14°
const CAM_VEL_REF = 10.0; // M/s at which the tanh map reaches tanh(1) ≈ 76% of cap
const CAM_ACTIVE_S = 0.6; // seconds after the last user input the estimator runs
const CAM_TELEPORT_M = 1.5; // one-frame |Δx| above this is a set/reset, not motion
const CAM_REST_SPEED = 0.05; // raw speeds below this (M/s) are rest jitter → static
let camTrail: { t: number; p: [number, number, number] }[] = [];
let camVelEma: [number, number, number] = [0, 0, 0];
let lastCamSpeed = 0; // |mapped velocity| last frame (units of c), exposed for tests

// --- Merger animation (Phase 15): PN-driven binary with the chirp clock ---
const GW_EVENTS: readonly GwEvent[] =
  (gweventsRaw as unknown as { events: GwEvent[] }).events;
const merger = {
  driver: null as MergerDriver | null,
  playing: false,
  tGeom: 0, // geometric time since f_low (M_total = 1 units)
  slowmo: 25, // visuals run 1/slowmo of physical rate (sec. 10.6: aliasing)
};

function mergerSelect(name: string | null): void {
  if (!name) {
    merger.driver = null;
    merger.playing = false;
    merger.tGeom = 0;
    return;
  }
  const ev = GW_EVENTS.find((e) => e.name === name);
  if (!ev) return;
  merger.driver = new MergerDriver(ev);
  merger.tGeom = 0;
  merger.playing = false;
  params.mode = "binary";
}

// Static-preview hole placement: barycentric on the y axis, M1 = 1 so all
// lengths are in units of the primary's mass; spins +z-aligned (a = chi * M).
function binaryHoles(): [BinaryHole, BinaryHole] {
  if (merger.driver) {
    const st = merger.driver.state(merger.tGeom);
    return [st.holes[0], st.holes[1]];
  }
  const m2 = params.binaryQ;
  const mt = 1 + m2;
  const sep = params.binarySep;
  return [
    {
      mass: 1,
      a: params.binaryChi1,
      center: [0, (-m2 / mt) * sep, 0],
      velocity: [0, 0, 0],
    },
    {
      mass: m2,
      a: params.binaryChi2 * m2,
      center: [0, (1 / mt) * sep, 0],
      velocity: [0, 0, 0],
    },
  ];
}

// Column-major lab->rest Lorentz boost acting on (t,x,y,z) columns, for the
// shader's mat4 uniforms; identity when at rest (exact static parity). The
// symmetric boost matrix equals its own column-major flattening.
function lorentzBoostColMajor(v: readonly [number, number, number]): Float32Array {
  const v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  if (v2 < 1e-24) return m;
  const gamma = 1 / Math.sqrt(1 - v2);
  for (let i = 0; i < 3; i++) {
    m[0 * 4 + (i + 1)] = -gamma * v[i]!; // column t, rows x..z
    m[(i + 1) * 4 + 0] = -gamma * v[i]!; // columns x..z, row t
    for (let j = 0; j < 3; j++)
      m[(i + 1) * 4 + (j + 1)] = (i === j ? 1 : 0) + ((gamma - 1) * v[i]! * v[j]!) / v2;
  }
  m[0] = gamma;
  return m;
}

let lastT = performance.now();
let fpsEma = 0;
const fpsNode = document.getElementById("fps") as HTMLDivElement;
let fpsFrames = 0;

function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  camera.update(dt);
  // Merger clock: wall time -> physical time (slow-motion divisor, sec. 10.6)
  // -> geometric time (divide by M_total in seconds).
  if (merger.driver && merger.playing) {
    merger.tGeom += dt / merger.slowmo / merger.driver.mTotalSec;
  }
  // Free-fall mode: the camera worldline is a timelike geodesic integrated
  // on the CPU; the orbit camera's angles track the falling position so the
  // view keeps facing the hole. On plunge termination, reset to orbit.
  if (freefall.active) {
    const alive = freefall.update(dt);
    const [px, py, pz] = freefall.position();
    camera.radius = Math.hypot(px, py, pz);
    camera.azimuth = Math.atan2(py, px);
    camera.elevation = Math.asin(pz / Math.max(camera.radius, 1e-9));
    if (!alive) camera.reset();
  }
  // Idle cinematic drift (see above): only when enabled, at rest, and not
  // manipulating, free-falling, or dragging a mass.
  const testMode = (window as unknown as { __bhTest?: boolean }).__bhTest;
  if (
    params.autoOrbit && !testMode && !freefall.active && !massDrag &&
    !camera.isManipulating && camera.idleSeconds() > IDLE_ORBIT_DELAY
  ) {
    camera.azimuth += IDLE_ORBIT_RATE * dt;
  }
  ensureTargets();
  if (!scene || !bloomA || !bloomB) return;

  const b = camera.basis();
  // Camera tetrad: e0 is the observer 4-velocity, so aberration and Doppler
  // fall out automatically. Free-fall uses the integrated geodesic velocity;
  // the interactive orbit is a moving (stationary/accelerated) observer whose
  // velocity is its own finite-differenced coordinate motion.
  let u4: Vec4;
  if (freefall.active) {
    u4 = freefall.fourVelocity();
    camTrail = [];
    camVelEma = [0, 0, 0];
    lastCamSpeed = 0;
  } else {
    // Drag → velocity estimation (see the constant block above for rationale).
    const tSec = now / 1000;
    const userActive = camera.isManipulating || camera.idleSeconds() < CAM_ACTIVE_S;
    const tail = camTrail[camTrail.length - 1];
    const jumped = !camera.isManipulating && tail !== undefined &&
      Math.hypot(b.pos[0] - tail.p[0], b.pos[1] - tail.p[1], b.pos[2] - tail.p[2]) >
        CAM_TELEPORT_M;
    if (!userActive || jumped) {
      camTrail = [];
      camVelEma = [0, 0, 0];
    }
    if (dt > 1e-4) camTrail.push({ t: tSec, p: [b.pos[0], b.pos[1], b.pos[2]] });
    // Evict old samples but always KEEP one sample at or beyond the window
    // edge (evict only while the runner-up is also old): if the frame period
    // ever exceeds the window (slow devices), the derivative then spans the
    // last two frames instead of silently having no pair to difference.
    let runnerUp = camTrail[1];
    while (runnerUp !== undefined && runnerUp.t <= tSec - CAM_WINDOW_S) {
      camTrail.shift();
      runnerUp = camTrail[1];
    }
    const head = camTrail[0];
    const last = camTrail[camTrail.length - 1];
    let vraw: [number, number, number] = [0, 0, 0];
    if (head !== undefined && last !== undefined && last.t - head.t > 0.02) {
      const span = last.t - head.t;
      vraw = [
        (last.p[0] - head.p[0]) / span,
        (last.p[1] - head.p[1]) / span,
        (last.p[2] - head.p[2]) / span,
      ];
    }
    const k = 1 - Math.exp(-dt / CAM_TAU_S);
    camVelEma = [
      camVelEma[0] + k * (vraw[0] - camVelEma[0]),
      camVelEma[1] + k * (vraw[1] - camVelEma[1]),
      camVelEma[2] + k * (vraw[2] - camVelEma[2]),
    ];
    const speed = Math.hypot(camVelEma[0], camVelEma[1], camVelEma[2]);
    let vUsed: [number, number, number] = [0, 0, 0];
    if (speed > CAM_REST_SPEED) {
      const scale = (CAM_VEL_MAX * Math.tanh(speed / CAM_VEL_REF)) / speed;
      vUsed = [camVelEma[0] * scale, camVelEma[1] * scale, camVelEma[2] * scale];
    }
    lastCamSpeed = Math.hypot(vUsed[0], vUsed[1], vUsed[2]);
    u4 = movingObserver(b.pos, vUsed, params.spin);
  }
  // Binary mode builds its tetrad under the superposed metric with a static
  // observer (the moving-observer camera uses the single-Kerr metric and is
  // deferred to the merger-mode dynamics phase; labeled in docs).
  const tetrad = params.mode === "binary"
    ? buildTetradBinary(
        b.pos,
        staticObserverBinary(b.pos, binaryHoles()),
        b.right, b.up, b.forward,
        binaryHoles(),
      )
    : buildTetrad(b.pos, u4, b.right, b.up, b.forward, params.spin);
  // Shader packing: vec4 = (xyz spatial, w = t).
  const packLeg = (e: Vec4): [number, number, number, number] => [e[1], e[2], e[3], e[0]];
  const setCam = (u: Map<string, WebGLUniformLocation | null>): void => {
    gl.uniform3f(u.get("uCamPos") ?? null, ...b.pos);
    gl.uniform3f(u.get("uCamRight") ?? null, ...b.right);
    gl.uniform3f(u.get("uCamUp") ?? null, ...b.up);
    gl.uniform3f(u.get("uCamForward") ?? null, ...b.forward);
    gl.uniform1f(u.get("uTanHalfFov") ?? null, Math.tan(camera.fovY / 2));
  };

  // --- 1. Scene (physics) into the HDR target at internal resolution ---
  gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
  gl.viewport(0, 0, scene.w, scene.h);
  if (params.mode === "multi") {
    gl.useProgram(weakProg);
    setCam(uWeak);
    gl.uniform2f(uWeak.get("uResolution") ?? null, scene.w, scene.h);
    gl.uniform1i(uWeak.get("uMaxSteps") ?? null, params.maxSteps);
    gl.uniform1i(uWeak.get("uDebugView") ?? null, params.debugView);
    gl.uniform1i(uWeak.get("uDiskOn") ?? null, 0);
    const n = Math.min(params.masses.length, 6);
    gl.uniform1i(uWeak.get("uNMasses") ?? null, n);
    const pos = new Float32Array(18);
    const ms = new Float32Array(6);
    for (let k = 0; k < n; k++) {
      const mk = params.masses[k];
      if (!mk) continue;
      pos.set(mk.pos, 3 * k);
      ms[k] = mk.m;
    }
    gl.uniform3fv(uWeak.get("uMassPos") ?? null, pos);
    gl.uniform1fv(uWeak.get("uMassM") ?? null, ms);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  } else if (params.mode === "binary") {
    gl.useProgram(binaryProg);
    setCam(uBinary);
    gl.uniform2f(uBinary.get("uResolution") ?? null, scene.w, scene.h);
    // uSpin only feeds the shared debug-view radius reference in this mode.
    gl.uniform1f(uBinary.get("uSpin") ?? null, params.binaryChi1);
    gl.uniform1i(uBinary.get("uMaxSteps") ?? null, params.maxSteps);
    gl.uniform1i(uBinary.get("uDebugView") ?? null, params.debugView);
    gl.uniform1i(uBinary.get("uDiskOn") ?? null, 0); // no disk during merger (sec. 10.7)
    gl.uniform4f(uBinary.get("uE0") ?? null, ...packLeg(tetrad[0]));
    gl.uniform4f(uBinary.get("uE1") ?? null, ...packLeg(tetrad[1]));
    gl.uniform4f(uBinary.get("uE2") ?? null, ...packLeg(tetrad[2]));
    gl.uniform4f(uBinary.get("uE3") ?? null, ...packLeg(tetrad[3]));
    gl.uniform1i(uBinary.get("uSkyShift") ?? null, params.skyShift ? 1 : 0);
    const [bh1, bh2] = binaryHoles();
    gl.uniform3f(uBinary.get("uB1Pos") ?? null, ...bh1.center);
    gl.uniform1f(uBinary.get("uB1M") ?? null, bh1.mass);
    gl.uniform1f(uBinary.get("uB1A") ?? null, bh1.a);
    gl.uniformMatrix4fv(uBinary.get("uB1Boost") ?? null, false, lorentzBoostColMajor(bh1.velocity));
    gl.uniform3f(uBinary.get("uB2Pos") ?? null, ...bh2.center);
    gl.uniform1f(uBinary.get("uB2M") ?? null, bh2.mass);
    gl.uniform1f(uBinary.get("uB2A") ?? null, bh2.a);
    gl.uniformMatrix4fv(uBinary.get("uB2Boost") ?? null, false, lorentzBoostColMajor(bh2.velocity));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  } else {
  gl.useProgram(sceneProg);
  setCam(uScene);
  gl.uniform2f(uScene.get("uResolution") ?? null, scene.w, scene.h);
  gl.uniform1f(uScene.get("uSpin") ?? null, params.spin);
  gl.uniform1i(uScene.get("uMaxSteps") ?? null, params.maxSteps);
  gl.uniform1i(uScene.get("uDebugView") ?? null, params.debugView);
  gl.uniform1i(uScene.get("uDiskOn") ?? null, params.diskOn ? 1 : 0);
  gl.uniform1f(uScene.get("uDiskInner") ?? null, riscoOf(params.spin, params.diskSense));
  gl.uniform1f(uScene.get("uDiskOuter") ?? null, params.diskOuter);
  gl.uniform1i(uScene.get("uBeaming") ?? null, params.beaming ? 1 : 0);
  gl.uniform1f(uScene.get("uDiskGain") ?? null, params.diskGain);
  // Wrap scene time at 30 min to keep f32 precision in the noise advection.
  // Test seam: __bhDiskTime pins the disk clock so the procedural pattern is
  // identical across screenshots, letting the e2e suite measure the physical
  // beaming/geometry without the fast-forwarded turbulence adding variance.
  const diskClock = (window as unknown as { __bhDiskTime?: number }).__bhDiskTime;
  gl.uniform1f(uScene.get("uTime") ?? null, typeof diskClock === "number" ? diskClock : (now / 1000) % 1800);
  gl.uniform4f(uScene.get("uE0") ?? null, ...packLeg(tetrad[0]));
  gl.uniform4f(uScene.get("uE1") ?? null, ...packLeg(tetrad[1]));
  gl.uniform4f(uScene.get("uE2") ?? null, ...packLeg(tetrad[2]));
  gl.uniform4f(uScene.get("uE3") ?? null, ...packLeg(tetrad[3]));
  gl.uniform1i(uScene.get("uSkyShift") ?? null, params.skyShift ? 1 : 0);
  gl.uniform1f(uScene.get("uDiskSense") ?? null, params.diskSense);
  // Disk tilted about the y-axis by diskIncl: normal, plus the in-plane
  // basis used for the noise angle.
  const ci = Math.cos(params.diskIncl);
  const si = Math.sin(params.diskIncl);
  gl.uniform3f(uScene.get("uDiskNormal") ?? null, si, 0, ci);
  gl.uniform3f(uScene.get("uDiskE1") ?? null, ci, 0, -si);
  gl.uniform3f(uScene.get("uDiskE2") ?? null, 0, 1, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // --- 2. Bloom: bright-pass horizontal blur, then vertical ---
  gl.useProgram(blurProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(uBlur.get("uTex") ?? null, 0);

  gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fbo);
  gl.viewport(0, 0, bloomA.w, bloomA.h);
  gl.bindTexture(gl.TEXTURE_2D, scene.tex);
  gl.uniform2f(uBlur.get("uTexelSize") ?? null, 1 / bloomA.w, 1 / bloomA.h);
  gl.uniform2f(uBlur.get("uDir") ?? null, 1, 0);
  // Bright-pass threshold: only HDR values above ~0.85 bloom, so the star
  // background stays crisp while the disk face glows.
  gl.uniform1f(uBlur.get("uThreshold") ?? null, 0.85);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  gl.bindFramebuffer(gl.FRAMEBUFFER, bloomB.fbo);
  gl.viewport(0, 0, bloomB.w, bloomB.h);
  gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
  gl.uniform2f(uBlur.get("uDir") ?? null, 0, 1);
  gl.uniform1f(uBlur.get("uThreshold") ?? null, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // --- 3. Composite to the canvas at device resolution ---
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(compositeProg);
  setCam(uComp);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, scene.tex);
  gl.uniform1i(uComp.get("uScene") ?? null, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, bloomB.tex);
  gl.uniform1i(uComp.get("uBloom") ?? null, 1);
  gl.uniform2f(uComp.get("uResolution") ?? null, canvas.width, canvas.height);
  gl.uniform1f(uComp.get("uBloomStrength") ?? null, params.bloomStrength);
  // The single-Kerr overlays (ergosphere, photon rings, grid) are undefined
  // for the superposed binary metric; suppress them in binary mode.
  const noOverlays = params.mode === "binary";
  gl.uniform1i(uComp.get("uErgoOn") ?? null, params.ergoOn && !noOverlays ? 1 : 0);
  gl.uniform1i(uComp.get("uPhotonOn") ?? null, params.photonOn && !noOverlays ? 1 : 0);
  gl.uniform1i(uComp.get("uGridOn") ?? null, params.gridOn && !noOverlays ? 1 : 0);
  gl.uniform1f(uComp.get("uSpin") ?? null, params.spin);
  gl.uniform1i(uComp.get("uDebugView") ?? null, params.debugView);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // --- Merger readout (physical time to merger, separation, f_GW) ---
  if (merger.driver && fpsFrames % 6 === 0) {
    const node = document.getElementById("mergerReadout");
    if (node) {
      const st = merger.driver.state(merger.tGeom);
      const tms = st.tToMergerS * 1e3;
      node.innerHTML =
        `t − t<sub>merger</sub> = ${tms >= 0 ? "−" : "+"}${Math.abs(tms).toFixed(1)} ms` +
        ` <span class="note">(×${merger.slowmo} slow-mo)</span><br>` +
        (st.phase === "ringdown"
          ? `ringdown: f<sub>QNM</sub> = ${st.fGwHz.toFixed(0)} Hz`
          : `${st.phase}: sep = ${st.separation.toFixed(2)} M · f<sub>GW</sub> = ${st.fGwHz.toFixed(1)} Hz`);
    }
  }

  // --- FPS (EMA), updated a few times a second ---
  fpsEma = fpsEma === 0 ? 1 / dt : fpsEma * 0.95 + (1 / dt) * 0.05;
  if (++fpsFrames % 15 === 0) fpsNode.textContent = `${fpsEma.toFixed(0)} fps`;
}

function loop(now: number): void {
  frame(now);
  requestAnimationFrame(loop);
}

function screenshot(): void {
  // The context has preserveDrawingBuffer disabled, so re-render
  // synchronously and read the buffer back within the same task.
  frame(performance.now());
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `kerr-a${params.spin.toFixed(3)}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

function toggleFreefall(): void {
  // The free-fall integrator is single-Kerr; not meaningful in binary mode.
  if (params.mode === "binary") return;
  if (freefall.active) {
    // Stop mid-fall: keep the current position (the frame loop has synced
    // the orbit camera to it) unless we are already deep enough that a
    // static observer no longer exists there — then reset to orbit.
    freefall.active = false;
    if (camera.radius < 2.2) camera.reset();
    return;
  }
  freefall.release(camera.basis().pos, params.spin);
}

// --- HQ still (WebGPU): modal overlay with progressive accumulation ---
const HQ_SAMPLES = 256;

// The exact scene state the WebGPU port renders — shared by the HQ modal
// and the parity test so both backends see identical inputs.
function buildHqState(): import("./webgpu").HqState {
  const b = camera.basis();
  const u4: Vec4 = freefall.active ? freefall.fourVelocity() : staticObserver(b.pos, params.spin);
  const tetrad = buildTetrad(b.pos, u4, b.right, b.up, b.forward, params.spin);
  const ci = Math.cos(params.diskIncl);
  const si = Math.sin(params.diskIncl);
  return {
    camPos: b.pos,
    right: b.right,
    up: b.up,
    forward: b.forward,
    tanHalfFov: Math.tan(camera.fovY / 2),
    spin: params.spin,
    maxSteps: params.maxSteps,
    diskInner: riscoOf(params.spin, params.diskSense),
    diskOuter: params.diskOuter,
    diskGain: params.diskGain,
    beaming: params.beaming,
    diskOn: params.diskOn,
    sense: params.diskSense,
    diskNormal: [si, 0, ci],
    diskE1: [ci, 0, -si],
    diskE2: [0, 1, 0],
    time: (performance.now() / 1000) % 1800,
    skyShift: params.skyShift,
    tetrad: tetrad.map((e): [number, number, number, number] => [e[1], e[2], e[3], e[0]]),
  };
}

// Numerical parity entry point for the e2e suite: compute-only WebGPU
// session (headless-presentation-safe), N samples, tonemapped readback.
async function hqParity(w: number, h: number, samples: number): Promise<number[]> {
  const session = await createHqSession(null, w, h, buildHqState());
  for (let i = 0; i < samples; i++) session.step();
  const mean = await session.readback();
  session.destroy();
  const aces = (x: number): number =>
    Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
  const out: number[] = new Array(w * h);
  for (let i = 0; i < w * h; i++)
    out[i] = Math.round(255 * Math.pow(aces(mean[i * 4] ?? 0), 1 / 2.2));
  return out;
}

async function openHqStill(): Promise<void> {
  if (params.mode !== "kerr") {
    alert("HQ stills render the single-Kerr scene; switch out of multi-mass/binary mode.");
    return;
  }
  const overlay = document.createElement("div");
  overlay.id = "hq";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:20;display:flex;" +
    "flex-direction:column;align-items:center;justify-content:center;gap:10px";
  const hqCanvas = document.createElement("canvas");
  const w = Math.min(1600, Math.round(canvas.clientWidth * devicePixelRatio));
  const h = Math.round((w * canvas.clientHeight) / canvas.clientWidth);
  hqCanvas.style.cssText = "max-width:92vw;max-height:80vh;border:1px solid #333";
  const status = document.createElement("div");
  status.id = "hqStatus";
  status.style.cssText = "color:#d6d9e0;font:13px system-ui";
  const row = document.createElement("div");
  const save = document.createElement("button");
  save.textContent = "Save PNG";
  const close = document.createElement("button");
  close.textContent = "Close";
  for (const b of [save, close])
    b.style.cssText = "margin:0 6px;padding:6px 14px;font:13px system-ui;cursor:pointer";
  row.append(save, close);
  overlay.append(hqCanvas, status, row);
  document.body.append(overlay);

  let session: HqSession | null = null;
  let stopped = false;
  close.addEventListener("click", () => {
    stopped = true;
    session?.destroy();
    overlay.remove();
  });
  save.addEventListener("click", () => {
    hqCanvas.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `kerr-hq-a${params.spin.toFixed(3)}.png`;
      link.click();
      URL.revokeObjectURL(link.href);
    });
  });

  try {
    session = await createHqSession(hqCanvas, w, h, buildHqState());
    // Test hook: the parity e2e reads the accumulation buffer directly
    // (headless presentation can be blank while compute is fine).
    (window as unknown as { __bhHq?: HqSession }).__bhHq = session;
    const tick = (): void => {
      if (stopped || !session) return;
      // Test hook: freezing stops further dispatches so a readback cannot
      // race in-flight submissions (a Dawn/SwiftShader mapAsync pitfall).
      if ((window as unknown as { __bhHqFreeze?: boolean }).__bhHqFreeze) {
        status.textContent = `frozen at ${session.samples()} samples (test hook)`;
        return;
      }
      if (session.samples() < HQ_SAMPLES) {
        session.step();
        status.textContent = `accumulating: ${session.samples()} / ${HQ_SAMPLES} samples`;
        requestAnimationFrame(tick);
      } else {
        status.textContent = `done: ${HQ_SAMPLES} samples — Save PNG to download`;
      }
    };
    tick();
  } catch (err) {
    status.textContent = `WebGPU error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

buildPanel(params, camera, screenshot, toggleFreefall, openHqStill, webGpuSupported(), () => freefall.active);

// navigator.gpu can exist while no adapter does (headless/software
// environments); probe asynchronously and downgrade the HQ button honestly.
if (webGpuSupported()) {
  void navigator.gpu.requestAdapter().then((adapter) => {
    if (adapter) return;
    const hqBtn = document.getElementById("hqBtn");
    if (!hqBtn) return;
    hqBtn.setAttribute("disabled", "");
    hqBtn.setAttribute(
      "title",
      "WebGPU adapter unavailable on this device — the WebGL2 renderer remains fully functional.",
    );
    hqBtn.innerHTML = "HQ still <span style='opacity:.6'>(WebGPU unavailable)</span>";
  });
}

const about = document.getElementById("about") as HTMLDivElement;
(document.getElementById("aboutLink") as HTMLAnchorElement).addEventListener("click", () =>
  about.classList.add("open"),
);
(document.getElementById("aboutClose") as HTMLSpanElement).addEventListener("click", () =>
  about.classList.remove("open"),
);
about.addEventListener("click", (e) => {
  if (e.target === about) about.classList.remove("open");
});

requestAnimationFrame(loop);

// Exposed for end-to-end tests (e2e/): deterministic control and readiness
// probing without synthetic pointer events.
declare global {
  interface Window {
    __bh: {
      camera: OrbitCamera;
      params: PanelParams;
      gl: WebGL2RenderingContext;
      freefall: FreeFall;
      release: () => void;
      risco: (a: number, sense: 1 | -1) => number;
      hqParity: (w: number, h: number, samples: number) => Promise<number[]>;
      /** Diagnostic: q_t of the central pixel's traced ray (g* = 1/q_t). */
      centerQt: () => number;
      /** Diagnostic: central-pixel q_t for a moving observer, Cartesian
       *  velocity v (coordinate units). v = [0,0,0] must equal centerQt(). */
      centerQtMoving: (v: [number, number, number]) => number;
      /** Diagnostic: |mapped camera velocity| used last frame (units of c);
       *  0 when static, bounded well below 1 while dragging. */
      camSpeed: () => number;
      /** Merger animation control (Phase 15). */
      merger: {
        events: readonly string[];
        select: (name: string | null) => void;
        setPlaying: (v: boolean) => void;
        restart: () => void;
        setSlowmo: (v: number) => void;
        playing: () => boolean;
        /** Driver timing (physical seconds) for cross-language checks. */
        info: () => { inspiralS: number; plungeS: number } | null;
        state: () => import("./merger").MergerState | null;
      };
    };
  }
}
window.__bh = {
  camera,
  params,
  gl,
  freefall,
  release: toggleFreefall,
  risco: riscoOf,
  hqParity,
  centerQt: (): number => {
    const b = camera.basis();
    const u4: Vec4 = freefall.active ? freefall.fourVelocity() : staticObserver(b.pos, params.spin);
    const [e0, , , e3] = buildTetrad(b.pos, u4, b.right, b.up, b.forward, params.spin);
    // Central pixel: nloc = (0, 0, 1) -> q = -e0 + e3; lower with g.
    const q: Vec4 = [e3[0] - e0[0], e3[1] - e0[1], e3[2] - e0[2], e3[3] - e0[3]];
    const m = metricTermsPublic(b.pos, params.spin);
    const lq = q[0] + m.l[0] * q[1] + m.l[1] * q[2] + m.l[2] * q[3];
    return -q[0] + m.f * lq;
  },
  centerQtMoving: (v: [number, number, number]): number => {
    const b = camera.basis();
    const u4: Vec4 = movingObserver(b.pos, v, params.spin);
    const [e0, , , e3] = buildTetrad(b.pos, u4, b.right, b.up, b.forward, params.spin);
    const q: Vec4 = [e3[0] - e0[0], e3[1] - e0[1], e3[2] - e0[2], e3[3] - e0[3]];
    const m = metricTermsPublic(b.pos, params.spin);
    const lq = q[0] + m.l[0] * q[1] + m.l[1] * q[2] + m.l[2] * q[3];
    return -q[0] + m.f * lq;
  },
  camSpeed: (): number => lastCamSpeed,
  merger: {
    events: GW_EVENTS.map((e) => e.name),
    select: mergerSelect,
    setPlaying: (v: boolean): void => {
      merger.playing = v && merger.driver !== null;
    },
    restart: (): void => {
      merger.tGeom = 0;
    },
    setSlowmo: (v: number): void => {
      merger.slowmo = Math.max(1, v);
    },
    playing: (): boolean => merger.playing,
    info: (): { inspiralS: number; plungeS: number } | null =>
      merger.driver
        ? { inspiralS: merger.driver.inspiralS, plungeS: merger.driver.plungeS }
        : null,
    state: (): import("./merger").MergerState | null =>
      merger.driver ? merger.driver.state(merger.tGeom) : null,
  },
};
