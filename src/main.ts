import { getGL, createProgram, uniforms } from "./gl";
import { OrbitCamera } from "./camera";
import { riscoOf } from "./physics";
import { buildPanel, type PanelParams } from "./panel";
import vertSrc from "./shaders/fullscreen.vert.glsl?raw";
import sceneSrc from "./shaders/render.frag.glsl?raw";
import blurSrc from "./shaders/blur.frag.glsl?raw";
import compositeSrc from "./shaders/composite.frag.glsl?raw";

const params: PanelParams = {
  spin: 0.6,
  massMsun: 10,
  maxSteps: 400,
  debugView: 0,
  resolutionScale: 0.75,
  diskOn: true,
  diskOuter: 12.0,
  beaming: true,
  // Exposure such that the emission peak reaches HDR > 1 before the ACES
  // tonemap; the r^-3 falloff otherwise leaves most of the disk invisible.
  diskGain: 9.0,
  bloomStrength: 0.55,
  ergoOn: false,
  photonOn: false,
};

const canvas = document.getElementById("view") as HTMLCanvasElement;
const gl = getGL(canvas);
// Float render targets for the HDR pipeline (verified available in all
// target browsers; hard requirement for bloom that doesn't band).
if (!gl.getExtension("EXT_color_buffer_float")) {
  throw new Error("EXT_color_buffer_float unavailable — HDR pipeline needs it.");
}

const sceneProg = createProgram(gl, vertSrc, sceneSrc);
const blurProg = createProgram(gl, vertSrc, blurSrc);
const compositeProg = createProgram(gl, vertSrc, compositeSrc);

const uScene = uniforms(gl, sceneProg, [
  "uResolution", "uCamPos", "uCamRight", "uCamUp", "uCamForward", "uTanHalfFov",
  "uSpin", "uMaxSteps", "uDebugView",
  "uDiskOn", "uDiskInner", "uDiskOuter", "uBeaming", "uDiskGain", "uTime",
]);
const uBlur = uniforms(gl, blurProg, ["uTex", "uTexelSize", "uDir", "uThreshold"]);
const uComp = uniforms(gl, compositeProg, [
  "uScene", "uBloom", "uResolution", "uBloomStrength",
  "uErgoOn", "uPhotonOn", "uSpin", "uDebugView",
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
camera.attach(canvas);

let lastT = performance.now();
let fpsEma = 0;
const fpsNode = document.getElementById("fps") as HTMLDivElement;
let fpsFrames = 0;

function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  camera.update(dt);
  ensureTargets();
  if (!scene || !bloomA || !bloomB) return;

  const b = camera.basis();
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
  gl.useProgram(sceneProg);
  setCam(uScene);
  gl.uniform2f(uScene.get("uResolution") ?? null, scene.w, scene.h);
  gl.uniform1f(uScene.get("uSpin") ?? null, params.spin);
  gl.uniform1i(uScene.get("uMaxSteps") ?? null, params.maxSteps);
  gl.uniform1i(uScene.get("uDebugView") ?? null, params.debugView);
  gl.uniform1i(uScene.get("uDiskOn") ?? null, params.diskOn ? 1 : 0);
  gl.uniform1f(uScene.get("uDiskInner") ?? null, riscoOf(params.spin));
  gl.uniform1f(uScene.get("uDiskOuter") ?? null, params.diskOuter);
  gl.uniform1i(uScene.get("uBeaming") ?? null, params.beaming ? 1 : 0);
  gl.uniform1f(uScene.get("uDiskGain") ?? null, params.diskGain);
  // Wrap scene time at 30 min to keep f32 precision in the noise advection.
  gl.uniform1f(uScene.get("uTime") ?? null, (now / 1000) % 1800);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

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

buildPanel(params, camera, screenshot);

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
    };
  }
}
window.__bh = { camera, params, gl };
