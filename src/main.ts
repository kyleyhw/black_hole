import { getGL, createProgram, uniforms } from "./gl";
import { OrbitCamera } from "./camera";
import { riscoOf } from "./physics";
import { buildPanel, type PanelParams } from "./panel";
import {
  buildTetrad, staticObserver, movingObserver, metricTerms as metricTermsPublic, type Vec4,
} from "./tetrad";
import { FreeFall } from "./geodesic";
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
// observer worldline, so its coordinate velocity (finite-differenced from the
// per-frame position, EMA-smoothed) drives aberration and Doppler via the
// tetrad's e0. A large one-frame jump is a teleport (preset/reset), not motion;
// a camera at rest snaps to exactly static (movingObserver with v=0 ≡ static),
// which keeps a still frame pixel-identical to the previous static behaviour.
const CAM_VEL_SMOOTH = 0.3; // EMA weight on the new finite-difference velocity
const CAM_TELEPORT_M = 3.0; // |Δx| beyond this in one frame is a jump, not motion
const CAM_REST_EPS = 1e-4; // |Δx| below this is "at rest" → snap velocity to zero
let prevCamPos: [number, number, number] | null = null;
let camVel: [number, number, number] = [0, 0, 0];

let lastT = performance.now();
let fpsEma = 0;
const fpsNode = document.getElementById("fps") as HTMLDivElement;
let fpsFrames = 0;

function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  camera.update(dt);
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
    prevCamPos = null; // so the frame after release is not read as a jump
    camVel = [0, 0, 0];
  } else {
    if (prevCamPos && dt > 1e-4) {
      const dxx = b.pos[0] - prevCamPos[0];
      const dxy = b.pos[1] - prevCamPos[1];
      const dxz = b.pos[2] - prevCamPos[2];
      const jump = Math.hypot(dxx, dxy, dxz);
      if (jump < CAM_REST_EPS || jump > CAM_TELEPORT_M) {
        camVel = [0, 0, 0]; // at rest, or a preset/reset teleport — not motion
      } else {
        const k = CAM_VEL_SMOOTH;
        camVel = [
          camVel[0] + k * (dxx / dt - camVel[0]),
          camVel[1] + k * (dxy / dt - camVel[1]),
          camVel[2] + k * (dxz / dt - camVel[2]),
        ];
      }
    }
    prevCamPos = [b.pos[0], b.pos[1], b.pos[2]];
    u4 = movingObserver(b.pos, camVel, params.spin);
  }
  const tetrad = buildTetrad(b.pos, u4, b.right, b.up, b.forward, params.spin);
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
  gl.uniform1i(uComp.get("uErgoOn") ?? null, params.ergoOn ? 1 : 0);
  gl.uniform1i(uComp.get("uPhotonOn") ?? null, params.photonOn ? 1 : 0);
  gl.uniform1i(uComp.get("uGridOn") ?? null, params.gridOn ? 1 : 0);
  gl.uniform1f(uComp.get("uSpin") ?? null, params.spin);
  gl.uniform1i(uComp.get("uDebugView") ?? null, params.debugView);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

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
  if (params.mode === "multi") {
    alert("HQ stills render the Kerr scene; switch out of multi-mass mode.");
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
};
