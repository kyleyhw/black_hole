import { getGL, createProgram, uniforms } from "./gl";
import { OrbitCamera } from "./camera";
import vertSrc from "./shaders/fullscreen.vert.glsl?raw";
import fragSrc from "./shaders/render.frag.glsl?raw";

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
]);

const camera = new OrbitCamera();
camera.attach(canvas);

// Internal resolution scale (1 = native device pixels); becomes a quality
// slider in Phase 6.
let resolutionScale = 1.0;

function resize(): void {
  const w = Math.round(canvas.clientWidth * devicePixelRatio * resolutionScale);
  const h = Math.round(canvas.clientHeight * devicePixelRatio * resolutionScale);
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
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Exposed for end-to-end tests (e2e/): deterministic camera control and
// readiness probing without synthetic pointer events.
declare global {
  interface Window {
    __bh: {
      camera: OrbitCamera;
      setResolutionScale: (s: number) => void;
      gl: WebGL2RenderingContext;
    };
  }
}
window.__bh = {
  camera,
  setResolutionScale: (s: number): void => {
    resolutionScale = s;
  },
  gl,
};
