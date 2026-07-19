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
  gridOn: boolean;
  skyShift: boolean; // starfield redshift/beaming for the camera frame
  autoOrbit: boolean; // cinematic idle drift when the user is not interacting
  diskSense: 1 | -1; // orbital flow: +1 prograde, -1 retrograde
  diskIncl: number; // disk tilt (rad); kinematic approximation for a != 0
  mode: "kerr" | "multi" | "binary"; // exact Kerr / linearized multi-mass / merger preview
  binarySep: number; // binary preview: barycentric separation (M)
  binaryQ: number; // binary preview: mass ratio M2/M1
  binaryChi1: number; // binary preview: aligned spin of the primary
  binaryChi2: number; // binary preview: aligned spin of the secondary
  masses: { m: number; pos: [number, number, number] }[];
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

// "Learn more" popups: a small (i) button that opens a shared modal with a
// short physics explanation — education without cluttering the panel.
let learnModal: HTMLDivElement | null = null;

function openLearn(title: string, html: string): void {
  if (!learnModal) {
    learnModal = el("div", { id: "learn" });
    const card = el("div", { class: "card" });
    learnModal.append(card);
    learnModal.addEventListener("click", (e) => {
      if (e.target === learnModal) learnModal?.classList.remove("open");
    });
    document.body.append(learnModal);
  }
  const card = learnModal.querySelector(".card") as HTMLDivElement;
  card.innerHTML = `<span class="close">×</span><h2>${title}</h2>${html}`;
  (card.querySelector(".close") as HTMLSpanElement).addEventListener("click", () =>
    learnModal?.classList.remove("open"),
  );
  learnModal.classList.add("open");
}

function infoBtn(title: string, html: string): HTMLButtonElement {
  const b = el("button", { class: "info", title: `About: ${title}` }, "i");
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openLearn(title, html);
  });
  return b;
}

function section(
  title: string,
  open: boolean,
  learn?: { title: string; html: string },
): { root: HTMLDetailsElement; body: HTMLElement } {
  const root = el("details", open ? { open: "" } : {});
  const summary = el("summary", {}, title);
  if (learn) summary.append(infoBtn(learn.title, learn.html));
  root.append(summary);
  const body = el("div", { class: "body" });
  root.append(body);
  return { root, body };
}

const LEARN = {
  notation: {
    title: "Units and notation",
    html: `<p>Everything uses <b>geometrized units</b> (G = c = 1), so the black
      hole mass M is also a <i>length</i> and a <i>time</i>: all distances are
      quoted as multiples of M (the "M" on the sliders), and the mass readout
      just converts that length into kilometres or au. The symbols:</p>
      <dl class="gloss">
        <dt>M</dt><dd>black hole mass — sets the one length scale; every
          radius below is a multiple of it.</dd>
        <dt>a = J/M</dt><dd>spin parameter (angular momentum per unit mass);
          shown as a/M ∈ [0, 0.998]. a = 0 is non-spinning (Schwarzschild).</dd>
        <dt>r</dt><dd>Kerr–Schild radial coordinate — an oblate radius:
          r⁴ − (ρ² − a²)r² − a²z² = 0, with ρ² = x² + y² + z². Reduces to the
          ordinary radius when a = 0.</dd>
        <dt>θ, φ</dt><dd>polar angle from the spin axis and azimuthal angle
          around it. The grid's spokes are lines of constant φ; its circles are
          constant r.</dd>
        <dt>r<sub>+</sub></dt><dd>outer event horizon radius,
          r<sub>+</sub> = M + √(M² − a²) — the point of no return.</dd>
        <dt>r<sub>ISCO</sub></dt><dd>innermost stable circular orbit — the
          disk's inner edge.</dd>
        <dt>Ω</dt><dd>angular velocity dφ/dt of disk matter as seen from
          infinity.</dd>
        <dt>u<sup>t</sup></dt><dd>time component of the disk matter's
          4-velocity — the time-dilation factor of an orbiting clock.</dd>
        <dt>E, L<sub>z</sub></dt><dd>a photon's conserved energy and angular
          momentum about the spin axis (Kerr's symmetries in t and φ).</dd>
        <dt>λ = L<sub>z</sub>/E</dt><dd>the photon's impact parameter, the
          quantity the disk redshift depends on.</dd>
        <dt>g</dt><dd>redshift factor: ratio of received to emitted frequency;
          g &lt; 1 is reddened, g &gt; 1 blueshifted. Intensity scales as g⁴.</dd>
        <dt>g<sub>★</sub> = 1/q<sub>t</sub></dt><dd>the same idea for
          starlight, set by q<sub>t</sub>, the ray's energy in the camera's
          frame.</dd>
        <dt>Φ</dt><dd>Newtonian potential in multi-mass mode; the linearization
          is valid while |Φ| ≪ 1.</dd>
        <dt>H, p<sub>μ</sub></dt><dd>the super-Hamiltonian and photon momentum
          the integrator evolves; null rays keep H = 0.</dd>
      </dl>`,
  },
  spin: {
    title: "Black hole spin",
    html: `<p>a/M is the angular momentum per unit mass. A spinning black hole
      <b>drags spacetime around with it</b> (frame dragging): watch the shadow
      grow asymmetric and D-shaped as you raise the spin, and the innermost
      stable orbit (r<sub>ISCO</sub>) walk inward — prograde matter can orbit
      much closer to a fast-spinning hole. The maximum here is a/M = 0.998,
      the Thorne limit: accretion cannot spin a hole up further, because the
      disk's own radiation carries away counteracting angular momentum.</p>`,
  },
  mass: {
    title: "Why doesn't mass change the image?",
    html: `<p>It shouldn't — and that's real physics, not a limitation. The
      Kerr geometry is <b>scale-free</b>: every length in the problem
      (horizon, ISCO, photon orbits, your distance) is proportional to M, so
      a black hole of any mass looks <i>identical</i> when viewed from the
      proportional distance. Only the physical scale changes: the readouts
      convert r<sub>+</sub> and r<sub>ISCO</sub> into kilometres or au for
      your chosen mass. A 10 M<sub>☉</sub> hole and M87* differ on screen
      only by the caption.</p>
      <p><b>But isn't lensing stronger for a bigger mass?</b> Yes — a ray
      passing at a <i>fixed physical impact parameter</i> b bends by
      α = 4M/b, which grows with M. The catch is what's held fixed. This
      camera sits at 18 <b>M</b>, so raising M pushes it proportionally
      farther away too; the ratio M/b that sets every bending angle never
      moves, and the picture is unchanged. To actually see stronger lensing
      you must hold something fixed in <i>absolute</i> units — anchor the
      camera at a fixed number of kilometres, or put a background star at a
      fixed distance, then a heavier hole looms larger and lenses more of the
      sky. Anchored in M, only the scale bar changes.</p>
      <p><b>Shouldn't mass at least affect the disk or background?</b> In this
      scale-free model, no — the disk is defined in units of M (inner edge at
      r<sub>ISCO</sub>, outer edge in M) and the stars are a direction field
      "at infinity" with no length scale, so both are invariant too. The one
      genuinely mass-dependent feature in reality is the disk's color
      temperature: at fixed Eddington ratio T ∝ M<sup>−1/4</sup>, so
      stellar-mass holes glow in X-rays and supermassive ones in the
      UV/optical. We don't render that absolute baseline (it needs an
      accretion rate and would just globally tint the disk); we show the exact
      <i>relative</i> redshift/Doppler variation g·T instead.</p>`,
  },
  disk: {
    title: "The accretion disk",
    html: `<p>Matter on circular geodesic orbits from r<sub>ISCO</sub> out to
      the chosen edge. Each hit is shaded with the exact redshift factor
      <code>g&nbsp;=&nbsp;1/[u<sup>t</sup>(1&nbsp;−&nbsp;Ωλ)]</code>, which
      combines gravitational redshift, orbital Doppler shift, and frame
      dragging. The approaching side is boosted by g⁴ (relativistic beaming)
      and blue-shifted; the receding side is dimmed and reddened — that's the
      iconic bright/dark asymmetry. The arcs above and below the shadow are
      the disk's far side, lensed over and under the hole. The fluid pattern
      orbits at each radius's own Keplerian rate Ω(r), so the inner annuli
      visibly outrun the outer ones (differential rotation) — shown in
      fast-forward, while the redshift colors stay exact.</p>`,
  },
  beaming: {
    title: "g⁴ beaming",
    html: `<p>A moving emitter concentrates its radiation forward. For
      bolometric (frequency-integrated) intensity the exact factor is g⁴,
      a consequence of Liouville's theorem (I<sub>ν</sub>/ν³ is invariant
      along rays). Toggle it off to see how much of the disk's asymmetry is
      beaming versus geometry.</p>`,
  },
  isco: {
    title: "r_ISCO — the innermost stable circular orbit",
    html: `<p>Inside this radius no stable circular orbit exists — matter
      spirals in quickly, so thin disks effectively end here. For a = 0 it
      sits at 6M; for prograde orbits it shrinks with spin (1.24M at
      a = 0.998) and for retrograde orbits it grows toward 9M. The disk's
      inner edge tracks this live as you move the spin slider
      (Bardeen–Press–Teukolsky 1972).</p>`,
  },
  camera: {
    title: "Cameras and free fall",
    html: `<p>The orbit camera is a genuine <b>observer worldline</b>: while
      you drag, it is a moving observer whose velocity is its own motion, so
      you see real aberration and Doppler; the instant you let go it is a
      "static observer" (which only exists outside the ergosphere). Rays are
      built in the camera's own orthonormal frame (a tetrad), so angles,
      aberration, and the sky's red/blueshift are exactly what that observer
      would measure. A free drag is superluminal in coordinate units, so the
      drag speed is mapped to a bounded sub-luminal velocity (smoothly, only
      while you are dragging) — you get graded aberration and Doppler rather
      than a light-speed lurch, and the view is exactly static at rest.
      <b>Release</b> drops the camera onto a timelike geodesic: it falls
      freely, and at a &gt; 0 frame dragging visibly swings it azimuthally
      even though it started at rest. Stop the fall any time, or let it
      plunge to near the horizon and reset. When you leave it alone,
      <b>auto-orbit</b> eases the camera into a slow drift so the shadow's
      D-shape and the disk's near/far asymmetry sweep past — it stops the
      moment you touch the view.</p>`,
  },
  skyshift: {
    title: "Sky redshift",
    html: `<p>Starlight reaching a deep or moving observer is shifted: each
      escaped ray carries g<sub>★</sub> = 1/q<sub>t</sub>, the ratio of
      locally measured to at-infinity frequency. Star temperatures scale by
      g<sub>★</sub> and brightness by g<sub>★</sub>⁴. Hovering deep in the
      potential the sky is <i>blueshifted</i> (infalling light gains energy);
      free-falling, the forward sky blueshifts and crowds together by
      aberration while the rear sky reddens.</p>`,
  },
  overlays: {
    title: "Overlays and debug views",
    html: `<p>The overlays are <b>schematic markers, drawn without lensing</b>
      — they label coordinate surfaces rather than showing photons.
      <b>Ergosphere</b>: inside this surface nothing can hover at fixed
      angles; everything is dragged around the hole. <b>Photon orbits</b>:
      radii of circular light orbits, prograde (orange) and retrograde
      (blue) — light passing inside the corresponding critical impact
      parameter is captured. <b>Grid</b>: circles of constant Kerr–Schild
      radius every 2M with 30° spokes, for reading off scales. The debug
      views false-color each ray's step count, energy-conservation error
      |H|, and final radius — the tools used to validate the integrator.</p>`,
  },
  quality: {
    title: "Quality controls",
    html: `<p><b>Max steps</b> caps the integration budget per ray; rays that
      run out are treated as captured (they are photon-shell strugglers
      winding near the critical orbit). <b>Resolution</b> renders the physics
      at a fraction of display resolution. <b>Bloom</b> is a purely cosmetic
      glow on bright HDR pixels.</p>`,
  },
  multi: {
    title: "Multi-mass mode (linearized)",
    html: `<p>Several point masses with their weak-field metrics
      <i>superposed</i> — valid only while |Φ| ≪ 1, which is why a validity
      meter is shown (superposition is a linear-order statement; full GR is
      nonlinear). Each mass lenses the background and casts an Einstein ring;
      drag them to watch the caustics move. The dark disks are drawn at the
      would-be Schwarzschild radii, where the approximation has long broken
      down — they are regularizations, not horizons.</p>`,
  },
  binary: {
    title: "Binary preview (superposed Kerr\u2013Schild)",
    html: `<p>Two black holes rendered with a <b>superposed Kerr\u2013Schild
      metric</b>: g = \u03b7 + f\u2081l\u2081l\u2081 + f\u2082l\u2082l\u2082, whose inverse stays
      closed-form via two Sherman\u2013Morrison updates. This is a controlled
      approximation \u2014 exact for each hole alone, with error of order
      M\u2081M\u2082/d at separation d \u2014 the same construction used to build
      binary initial data in numerical relativity. Light propagation through
      this metric is integrated exactly, so you see genuine inter-hole
      lensing: each shadow is deformed and multiply imaged by the other
      hole. This static preview becomes the LIGO-catalog merger animation
      (orbits, chirp audio) in the next phase.</p>`,
  },
  tilt: {
    title: "Disk tilt",
    html: `<p>Tilting the disk plane is exact at a = 0 (spherical symmetry
      makes every plane equatorial) but a <b>kinematic approximation</b> for
      a ≠ 0: circular orbits off the equator are not Kerr geodesics
      (Lense–Thirring precession would twist the disk — the Bardeen–Petterson
      effect). Light propagation stays exact; only the emitter's assumed
      motion is approximate.</p>`,
  },
} as const;

export function buildPanel(
  params: PanelParams,
  camera: OrbitCamera,
  onScreenshot: () => void,
  onRelease: () => void,
  onHqStill: () => void,
  webGpuAvailable: boolean,
  isFreefalling: () => boolean,
): void {
  const panel = el("div", { id: "panel" });
  const refreshers: (() => void)[] = [];
  const add = (parent: HTMLElement, r: { row: HTMLElement; refresh: () => void }) => {
    parent.append(r.row);
    refreshers.push(r.refresh);
  };

  // --- Black hole ---
  const bh = section("Black hole", true, LEARN.spin);
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
  const massNote = el("div", { class: "note-row" });
  massNote.append(
    el("span", {}, "mass rescales units only — the image is scale-invariant "),
    infoBtn(LEARN.mass.title, LEARN.mass.html),
  );
  bh.body.append(massNote);

  // --- Disk ---
  const disk = section("Accretion disk", true, LEARN.disk);
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
  {
    const r = toggle("g⁴ beaming", () => params.beaming, (v) => (params.beaming = v));
    r.row.append(infoBtn(LEARN.beaming.title, LEARN.beaming.html));
    add(disk.body, r);
  }
  add(disk.body, toggle("retrograde", () => params.diskSense === -1, (v) => (params.diskSense = v ? -1 : 1)));
  {
    const r = slider({
      label: "tilt",
      min: 0, max: 0.5, step: 0.01,
      get: () => params.diskIncl,
      set: (v) => (params.diskIncl = v),
      fmt: (v) => `${((v * 180) / Math.PI).toFixed(0)}°`,
    });
    r.row.append(infoBtn(LEARN.tilt.title, LEARN.tilt.html));
    add(disk.body, r);
  }

  // --- Quality ---
  const q = section("Quality", false, LEARN.quality);
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
  const cam = section("Camera", false, LEARN.camera);
  const rel = el("button", { class: "preset", id: "freefallBtn" }, "Release camera (free-fall)");
  rel.title =
    "Drop the camera onto a timelike geodesic from rest (valid outside the " +
    "ergosphere — the orbit camera always is). Click again to stop the fall.";
  rel.addEventListener("click", onRelease);
  cam.body.append(rel);
  setInterval(() => {
    rel.textContent = isFreefalling() ? "Stop free fall" : "Release camera (free-fall)";
  }, 150);
  add(cam.body, toggle("auto-orbit (idle)", () => params.autoOrbit, (v) => (params.autoOrbit = v)));
  {
    const r = toggle("sky redshift", () => params.skyShift, (v) => (params.skyShift = v));
    r.row.append(infoBtn(LEARN.skyshift.title, LEARN.skyshift.html));
    add(cam.body, r);
  }

  // --- Overlays ---
  const ov = section("Overlays", false, LEARN.overlays);
  add(ov.body, toggle("ergosphere", () => params.ergoOn, (v) => (params.ergoOn = v)));
  add(ov.body, toggle("photon orbits", () => params.photonOn, (v) => (params.photonOn = v)));
  add(ov.body, toggle("coordinate grid", () => params.gridOn, (v) => (params.gridOn = v)));
  const dbg = el("label", { class: "row" });
  const sel = el("select");
  for (const [v, name] of [["0", "none"], ["1", "step count"], ["2", "|H| drift"], ["3", "final r"]] as const) {
    const o = el("option", { value: v }, name);
    sel.append(o);
  }
  sel.addEventListener("change", () => (params.debugView = Number(sel.value)));
  dbg.append(el("span", { class: "name" }, "debug view"), sel);
  ov.body.append(dbg);

  // --- Multi-mass (linearized) mode ---
  const mm = section("Multi-mass (linearized)", false, LEARN.multi);
  add(mm.body, toggle("enable mode", () => params.mode === "multi", (v) => {
    params.mode = v ? "multi" : "kerr";
    renderMasses();
  }));
  const mmNote = el("div", { class: "readout" },
    "Superposed <i>linearized</i> point-mass metrics (|Φ| ≪ 1). Drag " +
    "masses on the canvas. Not exact GR — validity shown below.");
  mm.body.append(mmNote);
  const massList = el("div");
  mm.body.append(massList);
  const massBtns = el("div", { class: "row" });
  const addBtn = el("button", { class: "preset" }, "+ mass");
  const rmBtn = el("button", { class: "preset" }, "− mass");
  addBtn.addEventListener("click", () => {
    if (params.masses.length >= 6) return;
    // Place new masses on a ring so they never spawn coincident.
    const k = params.masses.length;
    params.masses.push({ m: 0.5, pos: [0, 10 * Math.cos(k), 10 * Math.sin(k)] });
    renderMasses();
  });
  rmBtn.addEventListener("click", () => {
    if (params.masses.length > 1) params.masses.pop();
    renderMasses();
  });
  massBtns.append(addBtn, rmBtn);
  mm.body.append(massBtns);
  const validity = el("div", { class: "readout", id: "validity" });
  mm.body.append(validity);

  function renderMasses(): void {
    massList.innerHTML = "";
    params.masses.forEach((mk, i) => {
      const row = el("label", { class: "row" });
      const input = el("input", { type: "range", min: "0.1", max: "3", step: "0.1" });
      input.value = String(mk.m);
      const val = el("span", { class: "val" }, `${mk.m.toFixed(1)} M`);
      input.addEventListener("input", () => {
        mk.m = Number(input.value);
        val.textContent = `${mk.m.toFixed(1)} M`;
      });
      row.append(el("span", { class: "name" }, `mass ${i + 1}`), input, val);
      massList.append(row);
    });
  }
  renderMasses();

  function updateValidity(): void {
    // Largest pairwise (M_i + M_j)/|x_i - x_j| — the leading superposition
    // error scale — plus each mass alone contributes |Phi| ~ 1/2 at its own
    // capture radius (regularized, not displayed).
    let worst = 0;
    for (let i = 0; i < params.masses.length; i++)
      for (let j = i + 1; j < params.masses.length; j++) {
        const A = params.masses[i];
        const B = params.masses[j];
        if (!A || !B) continue;
        const d = Math.hypot(A.pos[0] - B.pos[0], A.pos[1] - B.pos[1], A.pos[2] - B.pos[2]);
        worst = Math.max(worst, (A.m + B.m) / Math.max(d, 1e-6));
      }
    const warn = worst > 0.1;
    validity.innerHTML =
      `pairwise |Φ| ≤ ${worst.toFixed(3)} ` +
      (warn ? '<b style="color:#ff9d66">⚠ linearization degrading</b>' : "(linear regime)");
  }
  setInterval(updateValidity, 200);
  updateValidity();

  // --- Merger mode: LIGO-catalog animation + static preview (Phases 14-15) ---
  const bin = section("Merger (LIGO events)", false, LEARN.binary);
  add(bin.body, toggle("enable mode", () => params.mode === "binary", (v) => {
    params.mode = v ? "binary" : "kerr";
  }));
  {
    const mrow = el("label", { class: "row" });
    const msel = el("select", { id: "gwEventSel" });
    msel.append(el("option", { value: "" }, "static preview"));
    // Event names come from the runtime API (lazy: __bh is assigned after
    // buildPanel returns).
    setTimeout(() => {
      for (const name of window.__bh.merger.events) msel.append(el("option", { value: name }, name));
    }, 0);
    msel.addEventListener("change", () => {
      window.__bh.merger.select(msel.value || null);
      if (msel.value) params.mode = "binary";
      for (const r of refreshers) r();
    });
    mrow.append(el("span", { class: "name" }, "event"), msel);
    bin.body.append(mrow);
  }
  {
    const btns = el("div", { class: "row" });
    const play = el("button", { class: "preset", id: "mergerPlay" }, "Play");
    play.addEventListener("click", () => {
      window.__bh.merger.setPlaying(!window.__bh.merger.playing());
    });
    setInterval(() => {
      play.textContent = window.__bh.merger.playing() ? "Pause" : "Play";
    }, 150);
    const rst = el("button", { class: "preset", id: "mergerRestart" }, "Restart");
    rst.addEventListener("click", () => window.__bh.merger.restart());
    btns.append(play, rst);
    bin.body.append(btns);
  }
  add(bin.body, slider({
    label: "slow-motion",
    min: 5, max: 100, step: 5,
    get: () => 25,
    set: (v) => window.__bh.merger.setSlowmo(v),
    fmt: (v) => `×${v.toFixed(0)}`,
  }));
  bin.body.append(el("div", { class: "readout", id: "mergerReadout" },
    "select an event, then Play"));
  add(bin.body, slider({
    label: "separation",
    min: 4, max: 30, step: 0.5,
    get: () => params.binarySep,
    set: (v) => (params.binarySep = v),
    fmt: (v) => `${v.toFixed(1)} M`,
  }));
  add(bin.body, slider({
    label: "mass ratio q",
    min: 0.1, max: 1, step: 0.05,
    get: () => params.binaryQ,
    set: (v) => (params.binaryQ = v),
    fmt: (v) => v.toFixed(2),
  }));
  const binNote = el("div", { class: "note-row" });
  binNote.append(el("span", {}, "superposed-KS approximation \u2014 error \u223c M\u2081M\u2082/d "));
  bin.body.append(binNote);

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
  const hq = el("button", { class: "preset", id: "hqBtn" }, "HQ still (WebGPU)");
  if (webGpuAvailable) {
    hq.title = "Progressive 256-sample accumulation at full resolution";
    hq.addEventListener("click", onHqStill);
  } else {
    hq.setAttribute("disabled", "");
    hq.title = "WebGPU is not available in this browser — the WebGL2 renderer remains fully functional.";
    hq.innerHTML = "HQ still <span style='opacity:.6'>(WebGPU unavailable)</span>";
  }
  pr.body.append(hq);

  // Header: fixes the unit convention (why sliders read "M") and links the
  // notation glossary so every symbol used below is defined in one place.
  const header = el("div", { class: "note-row", id: "notation" });
  header.append(
    el("span", {}, "units: G = c = 1, lengths in M "),
    infoBtn(LEARN.notation.title, LEARN.notation.html),
  );

  panel.append(header, bh.root, disk.root, cam.root, q.root, ov.root, mm.root, bin.root, pr.root);
  document.body.append(panel);

  // Sidebar show/hide: a persistent tab that collapses the whole panel.
  const paneToggle = el("button", { id: "panelToggle", title: "Hide/show controls" }, "⟩");
  paneToggle.addEventListener("click", () => {
    const hidden = panel.classList.toggle("hidden");
    paneToggle.textContent = hidden ? "⟨" : "⟩";
  });
  document.body.append(paneToggle);

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
  const ri = riscoOf(p.spin, p.diskSense);
  node.innerHTML =
    `r<sub>+</sub> = ${rp.toFixed(3)} M = ${fmtKm(rp, p.massMsun)}<br>` +
    `r<sub>ISCO</sub> = ${ri.toFixed(3)} M = ${fmtKm(ri, p.massMsun)}` +
    `<span class="note"> (disk inner edge, live)</span>`;
}
