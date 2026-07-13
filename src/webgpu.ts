// WebGPU progressive still renderer (Phase 11). Compute pass accumulates
// jittered samples (hq.wgsl) into a storage buffer; a small render pipeline
// presents mean radiance with the same ACES tonemap as the WebGL2 path.
// WebGL2 remains the default/fallback renderer everywhere.

import hqWgsl from "./shaders/hq.wgsl?raw";

const PRESENT_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> accum : array<vec4f>;
@group(0) @binding(1) var<storage, read> meta : array<f32>; // width, height, samples

@vertex fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn aces(x : vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14),
               vec3f(0.0), vec3f(1.0));
}

@fragment fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let w = u32(meta[0]);
  let idx = u32(pos.y) * w + u32(pos.x);
  let n = max(meta[2], 1.0);
  let hdr = accum[idx].rgb / n;
  return vec4f(pow(aces(hdr), vec3f(1.0 / 2.2)), 1.0);
}
`;

/** Everything the WGSL U-array needs, packed by pack() below. */
export interface HqState {
  camPos: readonly [number, number, number];
  right: readonly [number, number, number];
  up: readonly [number, number, number];
  forward: readonly [number, number, number];
  tanHalfFov: number;
  spin: number;
  maxSteps: number;
  diskInner: number;
  diskOuter: number;
  diskGain: number;
  beaming: boolean;
  diskOn: boolean;
  sense: number;
  diskNormal: readonly [number, number, number];
  diskE1: readonly [number, number, number];
  diskE2: readonly [number, number, number];
  time: number;
  skyShift: boolean;
  /** Tetrad legs as (x, y, z, t), matching the GLSL vec4 packing. */
  tetrad: readonly (readonly [number, number, number, number])[];
}

export function webGpuSupported(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

// Chromium invalidates the wire instance backing mapAsync callbacks if the
// last GPUAdapter reference is garbage-collected; sessions register their
// adapter here for their lifetime. (A bare `void adapter` gets tree-shaken.)
const retainedAdapters = new Set<GPUAdapter>();

export interface HqSession {
  /** Accumulate one more sample; resolves when submitted. */
  step(): void;
  readonly samples: () => number;
  /** Read back the mean radiance image (RGBA f32 per pixel) — used by the
   * parity test and available for tainted-canvas-free PNG export. */
  readback(): Promise<Float32Array>;
  destroy(): void;
}

/** canvas = null runs compute-only (no presentation): used by the parity
 * test — headless SwiftShader breaks mapAsync once a canvas context is
 * configured on the device — and usable anywhere readback suffices. */
export async function createHqSession(
  canvas: HTMLCanvasElement | null,
  width: number,
  height: number,
  state: HqState,
): Promise<HqSession> {
  if (!webGpuSupported()) throw new Error("WebGPU is not available in this browser.");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter found.");
  retainedAdapters.add(adapter);
  const device = await adapter.requestDevice();

  let ctx: GPUCanvasContext | null = null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  if (canvas) {
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext("webgpu");
    if (!ctx) throw new Error("Could not create a WebGPU canvas context.");
    ctx.configure({ device, format, alphaMode: "opaque" });
  }

  // Explicit ArrayBuffer backing: TS 5.7+ types Float32Array over
  // ArrayBufferLike, which GPUAllowSharedBufferSource rejects.
  const uData = new Float32Array(new ArrayBuffer(52 * 4));
  const pack = (sampleIndex: number): Float32Array<ArrayBuffer> => {
    uData.set(state.camPos, 0);
    uData[3] = state.tanHalfFov;
    uData.set(state.right, 4);
    uData[7] = state.spin;
    uData.set(state.up, 8);
    uData[11] = state.maxSteps;
    uData.set(state.forward, 12);
    uData[15] = state.diskInner;
    for (let k = 0; k < 4; k++) uData.set(state.tetrad[k] ?? [0, 0, 0, 0], 16 + 4 * k);
    uData[32] = state.diskOuter;
    uData[33] = state.diskGain;
    uData[34] = state.beaming ? 1 : 0;
    uData[35] = state.diskOn ? 1 : 0;
    uData[36] = state.sense;
    uData.set(state.diskNormal, 37);
    uData.set(state.diskE1, 40);
    uData.set(state.diskE2, 43);
    uData[46] = state.time;
    uData[47] = width;
    uData[48] = height;
    uData[49] = sampleIndex;
    uData[50] = state.skyShift ? 1 : 0;
    return uData;
  };

  const uBuf = device.createBuffer({
    size: uData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const accumBuf = device.createBuffer({
    size: width * height * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  const stagingBuf = device.createBuffer({
    size: width * height * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  device.queue.writeBuffer(accumBuf, 0, new Float32Array(width * height * 4));
  const metaBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const computeModule = device.createShaderModule({ code: hqWgsl });
  const computePipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: computeModule, entryPoint: "trace" },
  });
  const computeBind = device.createBindGroup({
    layout: computePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uBuf } },
      { binding: 1, resource: { buffer: accumBuf } },
    ],
  });

  const presentModule = device.createShaderModule({ code: PRESENT_WGSL });
  const presentPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: presentModule, entryPoint: "vs" },
    fragment: { module: presentModule, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const presentBind = device.createBindGroup({
    layout: presentPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: accumBuf } },
      { binding: 1, resource: { buffer: metaBuf } },
    ],
  });

  let n = 0;
  return {
    step(): void {
      device.queue.writeBuffer(uBuf, 0, pack(n));
      n += 1;
      device.queue.writeBuffer(metaBuf, 0, new Float32Array([width, height, n, 0]));
      const enc = device.createCommandEncoder();
      const cp = enc.beginComputePass();
      cp.setPipeline(computePipeline);
      cp.setBindGroup(0, computeBind);
      cp.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      cp.end();
      if (ctx) {
        const rp = enc.beginRenderPass({
          colorAttachments: [
            { view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
          ],
        });
        rp.setPipeline(presentPipeline);
        rp.setBindGroup(0, presentBind);
        rp.draw(3);
        rp.end();
      }
      device.queue.submit([enc.finish()]);
    },
    samples: () => n,
    async readback(): Promise<Float32Array> {
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(accumBuf, 0, stagingBuf, 0, width * height * 16);
      device.queue.submit([enc.finish()]);
      await stagingBuf.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(stagingBuf.getMappedRange().slice(0));
      stagingBuf.unmap();
      const inv = 1 / Math.max(n, 1);
      for (let i = 0; i < data.length; i++) data[i] = (data[i] ?? 0) * inv;
      return data;
    },
    destroy(): void {
      uBuf.destroy();
      accumBuf.destroy();
      stagingBuf.destroy();
      metaBuf.destroy();
      device.destroy();
      retainedAdapters.delete(adapter);
    },
  };
}
