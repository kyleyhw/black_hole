// ============================================================================
// WebGPU compute port of the Kerr ray tracer (Phase 11, PROJECT_PLAN §9.5).
//
// Structurally line-parallel with src/shaders/render.frag.glsl (Kerr path):
// METRIC / INTEGRATOR / DISK / STARFIELD sections translate 1:1 so the two
// backends can be diffed function-by-function. Differences by design:
//   - progressive accumulation: each dispatch adds one sub-pixel-jittered
//     sample into a storage buffer (Halton 2,3 sequence — deterministic);
//   - no bloom (the HQ still is tone-mapped accumulation only);
//   - f32 throughout, exactly like highp WebGL2 — same accuracy, different
//     throughput (WGSL core has no f64).
//
// Parameters arrive as a flat f32 storage array (indices below) to avoid
// WGSL uniform-struct alignment pitfalls; the CPU packs it in webgpu.ts.
// ============================================================================

// U layout (f32 indices):
//  0-2 camPos | 3 tanHalfFov | 4-6 right | 7 spin | 8-10 up | 11 maxSteps
// 12-14 forward | 15 diskInner | 16-19 e0 (xyz,t) | 20-23 e1 | 24-27 e2
// 28-31 e3 | 32 diskOuter | 33 diskGain | 34 beaming | 35 diskOn | 36 sense
// 37-39 diskNormal | 40-42 diskE1 | 43-45 diskE2 | 46 time | 47 width
// 48 height | 49 sampleIndex | 50 skyShift

@group(0) @binding(0) var<storage, read> U : array<f32>;
@group(0) @binding(1) var<storage, read_write> accum : array<vec4f>;

const R_ESCAPE : f32 = 200.0;
const HARD_CAP : i32 = 1024;

fn uVec3(i : u32) -> vec3f { return vec3f(U[i], U[i + 1u], U[i + 2u]); }
fn uVec4(i : u32) -> vec4f { return vec4f(U[i], U[i + 1u], U[i + 2u], U[i + 3u]); }

// ============================================================================
// SECTION: METRIC — Kerr-Schild form (mirrors GLSL exactly)
// ============================================================================
fn ksRadius(x : vec3f, a : f32) -> f32 {
  let b = dot(x, x) - a * a;
  let r2 = 0.5 * (b + sqrt(max(b * b + 4.0 * a * a * x.z * x.z, 0.0)));
  return sqrt(max(r2, 1e-8));
}

struct Metric { f : f32, l : vec3f }

fn metricTerms(x : vec3f, a : f32) -> Metric {
  let r = ksRadius(x, a);
  let r2 = r * r;
  let f = 2.0 * r2 * r / max(r2 * r2 + a * a * x.z * x.z, 1e-12);
  let ra2 = r2 + a * a;
  return Metric(f, vec3f((r * x.x + a * x.y) / ra2, (r * x.y - a * x.x) / ra2, x.z / r));
}

fn hamiltonian(x : vec3f, p : vec3f, pt : f32, a : f32) -> f32 {
  let m = metricTerms(x, a);
  let lp = dot(m.l, p) - pt;
  return 0.5 * (-pt * pt + dot(p, p) - m.f * lp * lp);
}

// ============================================================================
// SECTION: INTEGRATOR — RK4 with central-difference gradients
// ============================================================================
struct Deriv { dx : vec3f, dp : vec3f }

fn rhs(x : vec3f, p : vec3f, pt : f32, a : f32) -> Deriv {
  let m = metricTerms(x, a);
  let lp = dot(m.l, p) - pt;
  let dx = p - m.f * lp * m.l;
  let eps = 2e-3 * max(ksRadius(x, a), 1.0);
  let inv2e = 0.5 / eps;
  let ex = vec3f(eps, 0.0, 0.0);
  let ey = vec3f(0.0, eps, 0.0);
  let ez = vec3f(0.0, 0.0, eps);
  let dp = -vec3f(
      hamiltonian(x + ex, p, pt, a) - hamiltonian(x - ex, p, pt, a),
      hamiltonian(x + ey, p, pt, a) - hamiltonian(x - ey, p, pt, a),
      hamiltonian(x + ez, p, pt, a) - hamiltonian(x - ez, p, pt, a)) * inv2e;
  return Deriv(dx, dp);
}

struct State { x : vec3f, p : vec3f }

fn rk4Step(s : State, h : f32, pt : f32, a : f32) -> State {
  let k1 = rhs(s.x, s.p, pt, a);
  let k2 = rhs(s.x + 0.5 * h * k1.dx, s.p + 0.5 * h * k1.dp, pt, a);
  let k3 = rhs(s.x + 0.5 * h * k2.dx, s.p + 0.5 * h * k2.dp, pt, a);
  let k4 = rhs(s.x + h * k3.dx, s.p + h * k3.dp, pt, a);
  return State(
      s.x + (h / 6.0) * (k1.dx + 2.0 * k2.dx + 2.0 * k3.dx + k4.dx),
      s.p + (h / 6.0) * (k1.dp + 2.0 * k2.dp + 2.0 * k3.dp + k4.dp));
}

fn stepSize(r : f32, rH : f32, speed : f32) -> f32 {
  return clamp(0.1 * min(r - 0.9 * rH, r) / max(speed, 1e-6), 1e-4, 4.0);
}

// ============================================================================
// SECTION: HASH UTILITIES
// ============================================================================
fn hash13(pin : vec3f) -> f32 {
  var p = fract(pin * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
fn hash33(pin : vec3f) -> vec3f {
  var p = fract(pin * vec3f(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// ============================================================================
// SECTION: DISK (sense and tilt included, mirroring the GLSL)
// ============================================================================
fn diskOmega(r : f32, a : f32) -> f32 {
  let sense = U[36];
  return sense / (r * sqrt(r) + sense * a);
}
fn diskUt(r : f32, a : f32) -> f32 {
  let inv32 = 1.0 / (r * sqrt(r));
  let sa = U[36] * a;
  return (1.0 + sa * inv32) / sqrt(max(1.0 - 3.0 / r + 2.0 * sa * inv32, 1e-6));
}

fn vnoiseCyl(q : vec2f, period : f32) -> f32 {
  let i = floor(q);
  var f = fract(q);
  f = f * f * (3.0 - 2.0 * f);
  let iy0 = (i.y % period + period) % period;
  let iy1 = ((i.y + 1.0) % period + period) % period;
  let v00 = hash13(vec3f(i.x, iy0, 53.0));
  let v10 = hash13(vec3f(i.x + 1.0, iy0, 53.0));
  let v01 = hash13(vec3f(i.x, iy1, 53.0));
  let v11 = hash13(vec3f(i.x + 1.0, iy1, 53.0));
  return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}

// Texture-phase fast-forward so the differential Keplerian shear is visible
// (see render.frag.glsl); a pure time remap — g and g^4 beaming are exact.
const DISK_TIME_SCALE : f32 = 8.0;

fn diskPattern(r : f32, phi : f32, a : f32) -> f32 {
  let co = phi - diskOmega(r, a) * U[46] * DISK_TIME_SCALE;
  var n = 0.0;
  var amp = 0.5;
  var freq = 1.0;
  for (var o = 0; o < 3; o++) {
    n += amp * vnoiseCyl(vec2f(log(r) * 3.0 * freq, co * (24.0 * freq) / 6.2831853), 24.0 * freq);
    amp *= 0.5;
    freq *= 2.0;
  }
  return n;
}

fn diskColor(t : f32) -> vec3f {
  var c = mix(vec3f(0.45, 0.05, 0.0), vec3f(1.0, 0.45, 0.1), smoothstep(0.25, 0.65, t));
  c = mix(c, vec3f(1.0, 0.93, 0.85), smoothstep(0.65, 1.05, t));
  c = mix(c, vec3f(0.75, 0.82, 1.0), smoothstep(1.05, 1.5, t));
  return c;
}

fn diskShade(xh : vec3f, ph : vec3f, pt : f32, r : f32, a : f32) -> vec4f {
  let diskNormal = uVec3(37u);
  let lambda = -dot(cross(xh, ph), diskNormal) / pt;
  var g = 1.0 / max(diskUt(r, a) * (1.0 - diskOmega(r, a) * lambda), 1e-3);
  g = min(g, 10.0);
  let diskInner = U[15];
  let e = max(1.0 - sqrt(diskInner / r), 0.0) / (r * r * r);
  let ePeak = (1.0 - sqrt(36.0 / 49.0)) / pow(diskInner * 49.0 / 36.0, 3.0);
  let emiss = e / max(ePeak, 1e-9);
  let noise = diskPattern(r, atan2(dot(xh, uVec3(43u)), dot(xh, uVec3(40u))), a);
  var beam = 1.0;
  if (U[34] > 0.5) { beam = g * g * g * g; }
  let tRel = g * pow(diskInner * 49.0 / (36.0 * r), 0.75);
  let col = diskColor(tRel) * (U[33] * emiss * beam * (0.55 + 0.9 * noise));
  let alpha = (0.5 + 0.35 * noise) * smoothstep(U[32], 0.85 * U[32], r);
  return vec4f(col, alpha);
}

// ============================================================================
// SECTION: STARFIELD
// ============================================================================
const STAR_CELLS : f32 = 400.0;
const STAR_DENSITY : f32 = 0.04;
// Half-size star footprint toward true point sources, with 1/STAR_SIZE^2
// flux-conserving peak compensation (see render.frag.glsl).
const STAR_SIZE : f32 = 0.5;

struct CubeProj { face : f32, uv : vec2f }

fn cubeProject(d : vec3f) -> CubeProj {
  let ad = abs(d);
  var face : f32;
  var uv : vec2f;
  if (ad.x >= ad.y && ad.x >= ad.z) {
    face = select(1.0, 0.0, d.x > 0.0);
    uv = vec2f(d.y, d.z) / ad.x;
  } else if (ad.y >= ad.z) {
    face = select(3.0, 2.0, d.y > 0.0);
    uv = vec2f(d.x, d.z) / ad.y;
  } else {
    face = select(5.0, 4.0, d.z > 0.0);
    uv = vec2f(d.x, d.y) / ad.z;
  }
  return CubeProj(face, uv * 0.5 + 0.5);
}

fn cubeUnproject(face : f32, uv : vec2f) -> vec3f {
  let c = uv * 2.0 - 1.0;
  if (face < 0.5) { return normalize(vec3f(1.0, c.x, c.y)); }
  if (face < 1.5) { return normalize(vec3f(-1.0, c.x, c.y)); }
  if (face < 2.5) { return normalize(vec3f(c.x, 1.0, c.y)); }
  if (face < 3.5) { return normalize(vec3f(c.x, -1.0, c.y)); }
  if (face < 4.5) { return normalize(vec3f(c.x, c.y, 1.0)); }
  return normalize(vec3f(c.x, c.y, -1.0));
}

fn starColor(t : f32) -> vec3f {
  let red = vec3f(1.0, 0.55, 0.35);
  let white = vec3f(1.0, 0.98, 0.95);
  let blue = vec3f(0.65, 0.75, 1.0);
  if (t < 0.5) { return mix(red, white, t * 2.0); }
  return mix(white, blue, (t - 0.5) * 2.0);
}

fn starfield(dir : vec3f, gstar : f32) -> vec3f {
  let proj = cubeProject(dir);
  let cellUv = proj.uv * STAR_CELLS;
  let baseCell = floor(cellUv);
  let pixAngle = 2.0 * U[3] / U[48];
  var col = vec3f(0.0);
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      let cell = baseCell + vec2f(f32(i), f32(j));
      let seed = vec3f(cell, proj.face * 101.0);
      if (hash13(seed) > STAR_DENSITY) { continue; }
      let rnd = hash33(seed + 17.0);
      let starDir = cubeUnproject(proj.face, (cell + rnd.xy) / STAR_CELLS);
      let b = pow(1.0 - 0.97 * rnd.z, -0.6667);
      let ang = acos(clamp(dot(dir, starDir), -1.0, 1.0));
      let radius = pixAngle * (0.5 + 0.35 * b) * STAR_SIZE;
      let fall = 1.0 - smoothstep(0.0, radius, ang);
      let tShift = clamp((0.5 + hash13(seed + 41.0)) * gstar - 0.5, 0.0, 1.0);
      let beam4 = gstar * gstar * gstar * gstar;
      col += fall * b * 0.3 * beam4 * starColor(tShift) / (STAR_SIZE * STAR_SIZE);
    }
  }
  return col;
}

// ============================================================================
// SECTION: SAMPLE — one jittered ray per pixel per dispatch
// ============================================================================
// Halton low-discrepancy sequence: deterministic sub-pixel jitter.
fn halton(index : u32, base : u32) -> f32 {
  var f = 1.0;
  var r = 0.0;
  var i = index;
  while (i > 0u) {
    f /= f32(base);
    r += f * f32(i % base);
    i /= base;
  }
  return r;
}

@compute @workgroup_size(8, 8)
fn trace(@builtin(global_invocation_id) gid : vec3u) {
  let width = u32(U[47]);
  let height = u32(U[48]);
  if (gid.x >= width || gid.y >= height) { return; }
  let sampleIndex = u32(U[49]);

  let jitter = vec2f(halton(sampleIndex + 1u, 2u), halton(sampleIndex + 1u, 3u));
  let pix = vec2f(f32(gid.x), f32(height - 1u - gid.y)) + jitter;
  let ndc = (pix / vec2f(f32(width), f32(height))) * 2.0 - 1.0;
  let aspect = f32(width) / f32(height);
  let tanHF = U[3];

  let a = U[7];
  let rH = 1.0 + sqrt(max(1.0 - a * a, 0.0));
  let rCapture = rH * (1.0 + 0.02 * sqrt(max(1.0 - a * a, 0.0))) + 1e-3;

  // Tetrad ray (derivations.md §8), identical to the GLSL path.
  let nloc = normalize(vec3f(ndc.x * aspect * tanHF, ndc.y * tanHF, 1.0));
  let q4 = -uVec4(16u) + nloc.x * uVec4(20u) + nloc.y * uVec4(24u) + nloc.z * uVec4(28u);
  let camPos = uVec3(0u);
  let mCam = metricTerms(camPos, a);
  let lq = q4.w + dot(mCam.l, q4.xyz);
  let pt = -q4.w + mCam.f * lq;
  var s = State(camPos, q4.xyz + mCam.f * lq * mCam.l);

  var accCol = vec3f(0.0);
  var accA = 0.0;
  let maxSteps = i32(U[11]);
  let diskNormal = uVec3(37u);
  var outcome = 0;

  for (var i = 0; i < HARD_CAP; i++) {
    if (i >= maxSteps) { break; }
    let r = ksRadius(s.x, a);
    if (r < rCapture) { outcome = 1; break; }
    if (r > R_ESCAPE) { outcome = 2; break; }
    if (!(dot(s.p, s.p) <= 1e8)) { outcome = 1; break; }
    let m = metricTerms(s.x, a);
    let v = s.p - m.f * (dot(m.l, s.p) - pt) * m.l;
    let h = stepSize(r, rH, length(v));
    let prev = s;
    s = rk4Step(s, h, pt, a);

    if (U[35] > 0.5 && dot(prev.x, diskNormal) * dot(s.x, diskNormal) < 0.0 && accA < 0.99) {
      var sa = prev;
      var hh = h;
      for (var bi = 0; bi < 3; bi++) {
        hh *= 0.5;
        let sm = rk4Step(sa, hh, pt, a);
        if (dot(sa.x, diskNormal) * dot(sm.x, diskNormal) >= 0.0) { sa = sm; }
      }
      let sb = rk4Step(sa, hh, pt, a);
      let za = dot(sa.x, diskNormal);
      var denom = za - dot(sb.x, diskNormal);
      if (abs(denom) < 1e-12) { denom = 1e-12; }
      let tf = clamp(za / denom, 0.0, 1.0);
      let xh = mix(sa.x, sb.x, tf);
      let ph = mix(sa.p, sb.p, tf);
      let rHit = ksRadius(xh, a);
      if (rHit > U[15] && rHit < U[32]) {
        let d = diskShade(xh, ph, pt, rHit, a);
        accCol += (1.0 - accA) * d.a * d.rgb;
        accA += (1.0 - accA) * d.a;
      }
    }
  }

  var background = vec3f(0.0);
  if (outcome == 2) {
    let m = metricTerms(s.x, a);
    let v = s.p - m.f * (dot(m.l, s.p) - pt) * m.l;
    var gstar = 1.0;
    if (U[50] > 0.5) { gstar = 1.0 / max(pt, 1e-3); }
    background = starfield(normalize(v), gstar);
  }

  let idx = gid.y * width + gid.x;
  accum[idx] += vec4f(accCol + (1.0 - accA) * background, 1.0);
}
