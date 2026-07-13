// Control panel: hand-rolled glass UI (no widget library — the design is
// part of the showcase). Builds DOM, binds to the shared Params object, and
// keeps physics readouts (r_+, r_ISCO, physical units) live.

import type { OrbitCamera } from "./camera";
import { horizonRadius, riscoOf } from "./physics";

export interface PanelParams {
  spin: number;
  massMsun: number; // display-only: physical scale of M (solar masses)
  maxSteps: number;
  debugView: number;
  resolutionScale: number;
  diskOn: boolean;
  diskOuter: number;
  beaming: boolean;
  diskGain: number;
  bloomStrength: number;
  ergoOn: boolean;
  photonOn: boolean;
  skyShift: boolean; // starfield redshift/beaming for the camera frame
}

/** GM_sun / c^2 in kilometres — converts lengths in M to km. */
const KM_PER_MSUN = 1.476625;

interface Preset {
  readonly name: string;
  apply(p: PanelParams, cam: OrbitCamera): void;
}

const PRESETS: readonly Preset[] = [
  {
    name: "Schwarzschild (a=0)",
    apply: (p, cam) => {
      p.spin = 0;
      p.diskOn = true;
      p.diskOuter = 14;
      p.diskGain = 6;
      p.beaming = true;
      cam.azimuth = 0;
      cam.elevation = 0.12;
      cam.radius = 18;
    },
  },
  {
    name: "Interstellar-ish (a=0.6)",
    apply: (p, cam) => {
      p.spin = 0.6;
      p.diskOn = true;
      p.diskOuter = 12;
      p.diskGain = 9;
      p.beaming = true;
      cam.azimuth = 0;
      cam.elevation = 0.07;
      cam.radius = 16;
    },
  },
  {
    name: "Near-extremal (a=0.998)",
    apply: (p, cam) => {
      p.spin = 0.998;
      p.diskOn = true;
      p.diskOuter = 10;
      p.diskGain = 7;
      p.beaming = true;
      cam.azimuth = 0;
      cam.elevation = 0.2;
      cam.radius = 12;
    },
  },
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  html = "",
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(v: number): void;
  fmt(v: number): string;
}

function slider(spec: SliderSpec): { row: HTMLElement; refresh: () => void } {
  const row = el("label", { class: "row" });
  const input = el("input", {
    type: "range",
    min: String(spec.min),
    max: String(spec.max),
    step: String(spec.step),
  });
  input.value = String(spec.get());
  const val = el("span", { class: "val" }, spec.fmt(spec.get()));
  row.append(el("span", { class: "name" }, spec.label), input, val);
  input.addEventListener("input", () => {
    spec.set(Number(input.value));
    val.textContent = spec.fmt(Number(input.value));
  });
  return {
    row,
    refresh: () => {
      input.value = String(spec.get());
      val.textContent = spec.fmt(spec.get());
    },
  };
}

function toggle(label: string, get: () => boolean, set: (v: boolean) => void) {
  const row = el("label", { class: "row" });
  const input = el("input", { type: "checkbox" });
  input.checked = get();
  input.addEventListener("change", () => set(input.checked));
  row.append(el("span", { class: "name" }, label), input);
  return { row, refresh: () => (input.checked = get()) };
}

function section(title: string, open: boolean): { root: HTMLDetailsElement; body: HTMLElement } {
  const root = el("details", open ? { open: "" } : {});
  root.append(el("summary", {}, title));
  const body = el("div", { class: "body" });
  root.append(body);
  return { root, body };
}

export function buildPanel(
  params: PanelParams,
  camera: OrbitCamera,
  onScreenshot: () => void,
  onRelease: () => void,
): void {
  const panel = el("div", { id: "panel" });
  const refreshers: (() => void)[] = [];
  const add = (parent: HTMLElement, r: { row: HTMLElement; refresh: () => void }) => {
    parent.append(r.row);
    refreshers.push(r.refresh);
  };

  // --- Black hole ---
  const bh = section("Black hole", true);
  add(bh.body, slider({
    label: "spin a/M",
    min: 0, max: 0.998, step: 0.002,
    get: () => params.spin,
    set: (v) => (params.spin = v),
    fmt: (v) => v.toFixed(3),
  }));
  add(bh.body, slider({
    label: "mass",
    min: 0, max: 9, step: 0.1,
    get: () => Math.log10(params.massMsun),
    set: (v) => (params.massMsun = 10 ** v),
    fmt: () => fmtMass(params.massMsun),
  }));
  const readout = el("div", { class: "readout" });
  bh.body.append(readout);

  // --- Disk ---
  const disk = section("Accretion disk", true);
  add(disk.body, toggle("enabled", () => params.diskOn, (v) => (params.diskOn = v)));
  add(disk.body, slider({
    label: "outer radius",
    min: 8, max: 20, step: 0.5,
    get: () => params.diskOuter,
    set: (v) => (params.diskOuter = v),
    fmt: (v) => `${v.toFixed(1)} M`,
  }));
  add(disk.body, slider({
    label: "exposure",
    min: 1, max: 20, step: 0.5,
    get: () => params.diskGain,
    set: (v) => (params.diskGain = v),
    fmt: (v) => v.toFixed(1),
  }));
  add(disk.body, toggle("g⁴ beaming", () => params.beaming, (v) => (params.beaming = v)));

  // --- Quality ---
  const q = section("Quality", false);
  add(q.body, slider({
    label: "max steps",
    min: 100, max: 1000, step: 50,
    get: () => params.maxSteps,
    set: (v) => (params.maxSteps = v),
    fmt: (v) => String(v),
  }));
  add(q.body, slider({
    label: "resolution",
    min: 0.25, max: 1, step: 0.25,
    get: () => params.resolutionScale,
    set: (v) => (params.resolutionScale = v),
    fmt: (v) => `${v.toFixed(2)}×`,
  }));
  add(q.body, slider({
    label: "bloom",
    min: 0, max: 2, step: 0.05,
    get: () => params.bloomStrength,
    set: (v) => (params.bloomStrength = v),
    fmt: (v) => v.toFixed(2),
  }));

  // --- Camera ---
  const cam = section("Camera", false);
  const rel = el("button", { class: "preset" }, "Release camera (free-fall)");
  rel.title =
    "Drop the camera onto a timelike geodesic from rest (valid outside the " +
    "ergosphere — the orbit camera always is). Double-click to reset.";
  rel.addEventListener("click", onRelease);
  cam.body.append(rel);
  add(cam.body, toggle("sky redshift", () => params.skyShift, (v) => (params.skyShift = v)));

  // --- Overlays ---
  const ov = section("Overlays", false);
  add(ov.body, toggle("ergosphere", () => params.ergoOn, (v) => (params.ergoOn = v)));
  add(ov.body, toggle("photon orbits", () => params.photonOn, (v) => (params.photonOn = v)));
  const dbg = el("label", { class: "row" });
  const sel = el("select");
  for (const [v, name] of [["0", "none"], ["1", "step count"], ["2", "|H| drift"], ["3", "final r"]] as const) {
    const o = el("option", { value: v }, name);
    sel.append(o);
  }
  sel.addEventListener("change", () => (params.debugView = Number(sel.value)));
  dbg.append(el("span", { class: "name" }, "debug view"), sel);
  ov.body.append(dbg);

  // --- Presets ---
  const pr = section("Presets", true);
  for (const preset of PRESETS) {
    const b = el("button", { class: "preset" }, preset.name);
    b.addEventListener("click", () => {
      preset.apply(params, camera);
      for (const r of refreshers) r();
    });
    pr.body.append(b);
  }
  const shot = el("button", { class: "preset" }, "Screenshot (PNG)");
  shot.addEventListener("click", onScreenshot);
  pr.body.append(shot);

  panel.append(bh.root, disk.root, cam.root, q.root, ov.root, pr.root);
  document.body.append(panel);

  // Live physics readouts, updated on every frame from the render loop.
  updateReadout(readout, params);
  setInterval(() => updateReadout(readout, params), 100);
}

function fmtMass(mSun: number): string {
  if (mSun >= 1e6) return `${(mSun / 1e6).toPrecision(3)}×10⁶ M☉`;
  if (mSun >= 1e3) return `${(mSun / 1e3).toPrecision(3)}×10³ M☉`;
  return `${mSun.toPrecision(3)} M☉`;
}

function fmtKm(lengthM: number, mSun: number): string {
  const km = lengthM * mSun * KM_PER_MSUN;
  if (km >= 1e6) return `${(km / 1.496e8).toPrecision(3)} au`;
  return `${km.toPrecision(3)} km`;
}

function updateReadout(node: HTMLElement, p: PanelParams): void {
  const rp = horizonRadius(p.spin);
  const ri = riscoOf(p.spin);
  node.innerHTML =
    `r<sub>+</sub> = ${rp.toFixed(3)} M = ${fmtKm(rp, p.massMsun)}<br>` +
    `r<sub>ISCO</sub> = ${ri.toFixed(3)} M = ${fmtKm(ri, p.massMsun)}` +
    `<span class="note"> (disk inner edge, live)</span>`;
}
