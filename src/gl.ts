// Minimal WebGL2 helpers: context creation and shader program compilation
// with full error surfacing (compile/link logs thrown, never swallowed).

export function getGL(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    depth: false,
    stencil: false,
    // The physics integration must not be silently degraded; fail loudly
    // if the platform cannot give us a real WebGL2 context.
    failIfMajorPerformanceCaveat: false,
  });
  if (!gl) throw new Error("WebGL2 is not available in this browser.");
  return gl;
}

function compile(gl: WebGL2RenderingContext, type: GLenum, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader failed");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "(no log)";
    gl.deleteShader(shader);
    throw new Error(`Shader compile error:\n${numberLines(src, log)}\n${log}`);
  }
  return shader;
}

// Attach source line numbers around reported error lines to make GLSL
// compiler messages actionable from a thrown Error alone.
function numberLines(src: string, log: string): string {
  const match = /ERROR: \d+:(\d+)/.exec(log);
  if (!match) return "";
  const line = Number(match[1]);
  return src
    .split("\n")
    .slice(Math.max(0, line - 3), line + 2)
    .map((l, i) => `${Math.max(0, line - 3) + i + 1}: ${l}`)
    .join("\n");
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  const vs = compile(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "(no log)";
    gl.deleteProgram(program);
    throw new Error(`Program link error:\n${log}`);
  }
  return program;
}

// Uniform location lookup that tolerates uniforms optimized out by the
// GLSL compiler (returns null); setting a null location is a no-op.
export function uniforms(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: readonly string[],
): Map<string, WebGLUniformLocation | null> {
  const map = new Map<string, WebGLUniformLocation | null>();
  for (const name of names) map.set(name, gl.getUniformLocation(program, name));
  return map;
}
