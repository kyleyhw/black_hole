import { getGL, createProgram, uniforms } from "./gl";
import { OrbitCamera } from "./camera";
import vertSrc from "./shaders/fullscreen.vert.glsl?raw";
import fragSrc from "./shaders/render.frag.glsl?raw";

// Physics/render parameters shared between UI and render loop.
export interface Params {
  spin: number; // a/M in [0, 0.998] (Thorne limit)
  maxSteps: number; // integration budget per ray
  debugView: number; // 0 none | 1 steps | 2 |H| drift | 3 final r
  resolutionScale: number;
}

const params: Params = {
  spin: 0.0,
  maxSteps: 400,
  debugView: 0,
  resolutionScale: 1.0,
};

const canvas = document.getElementById("view") as HTMLCanvasElement;
const gl = getGL(canvas);
const program = createProgram(gl, vertSrc, fragSrc);
const u = uniforms(gl, program, [
  "uResolution",
  "uCamPos",
  "uCamRight",
  "uCamUp",
  "uCamForward",
  "uTanHalfFov",
  "uSpin",
  "uMaxSteps",
  "uDebugView",
]);

const camera = new OrbitCamera();
camera.attach(canvas);

function resize(): void {
  const w = Math.round(canvas.clientWidth * devicePixelRatio * params.resolutionScale);
  const h = Math.round(canvas.clientHeight * devicePixelRatio * params.resolutionScale);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

let lastT = performance.now();

function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  camera.update(dt);
  resize();

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(program);
  const b = camera.basis();
  gl.uniform2f(u.get("uResolution") ?? null, canvas.width, canvas.height);
  gl.uniform3f(u.get("uCamPos") ?? null, ...b.pos);
  gl.uniform3f(u.get("uCamRight") ?? null, ...b.right);
  gl.uniform3f(u.get("uCamUp") ?? null, ...b.up);
  gl.uniform3f(u.get("uCamForward") ?? null, ...b.forward);
  gl.uniform1f(u.get("uTanHalfFov") ?? null, Math.tan(camera.fovY / 2));
  gl.uniform1f(u.get("uSpin") ?? null, params.spin);
  gl.uniform1i(u.get("uMaxSteps") ?? null, params.maxSteps);
  gl.uniform1i(u.get("uDebugView") ?? null, params.debugView);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// --- Provisional controls (Phase 3): replaced by the styled panel in Phase 6.
const strip = document.createElement("div");
strip.id = "controls";
strip.innerHTML = `
  <label>a/M <input id="spin" type="range" min="0" max="0.998" step="0.002" value="0">
  <span id="spinVal">0.000</span></label>
  <label>debug
    <select id="debug">
      <option value="0">none</option>
      <option value="1">step count</option>
      <option value="2">|H| drift</option>
      <option value="3">final r</option>
    </select>
  </label>`;
strip.style.cssText =
  "position:fixed;top:8px;right:8px;color:#ccc;font:13px system-ui;" +
  "background:rgba(0,0,0,.5);padding:8px 10px;border-radius:6px;display:flex;gap:12px";
document.body.appendChild(strip);
const spinInput = document.getElementById("spin") as HTMLInputElement;
const spinVal = document.getElementById("spinVal") as HTMLSpanElement;
spinInput.addEventListener("input", () => {
  params.spin = Number(spinInput.value);
  spinVal.textContent = params.spin.toFixed(3);
});
const debugSelect = document.getElementById("debug") as HTMLSelectElement;
debugSelect.addEventListener("change", () => {
  params.debugView = Number(debugSelect.value);
});

// Exposed for end-to-end tests (e2e/): deterministic control and readiness
// probing without synthetic pointer events.
declare global {
  interface Window {
    __bh: {
      camera: OrbitCamera;
      params: Params;
      gl: WebGL2RenderingContext;
    };
  }
}
window.__bh = { camera, params, gl };
