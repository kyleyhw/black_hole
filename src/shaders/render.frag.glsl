#version 300 es
// ============================================================================
// Kerr black hole ray tracer — main fragment shader.
//
// All physics happens here: null geodesics of the Kerr metric in Kerr-Schild
// (Cartesian) coordinates, integrated as Hamiltonian flow with RK4 and
// central-difference gradients. Derivations for every expression are in
// docs/derivations.md; section numbers below refer to it.
//
// Sections: METRIC / INTEGRATOR / TERMINATION / STARFIELD / DEBUG / MAIN
//
// highp is mandatory: mediump silently destroys the integration.
// ============================================================================
precision highp float;
precision highp int;

out vec4 fragColor;

uniform vec2 uResolution;    // render target size in pixels
uniform vec3 uCamPos;        // camera position, units of M
uniform vec3 uCamRight;      // orthonormal camera basis
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform float uTanHalfFov;   // tan(fovY / 2)
uniform float uSpin;         // a/M in [0, 0.998]
uniform int uMaxSteps;       // integration step budget (quality)
uniform int uDebugView;      // 0 none | 1 step count | 2 |H| drift | 3 final r
uniform int uDiskOn;         // accretion disk toggle
uniform float uDiskInner;    // inner edge = r_ISCO(a), computed on the CPU
uniform float uDiskOuter;    // outer edge (M)
uniform int uBeaming;        // g^4 relativistic beaming toggle
uniform float uDiskGain;     // emission exposure multiplier
uniform float uTime;         // scene time (s) for differential rotation
uniform vec4 uE0;            // camera tetrad legs (contravariant): xyz spatial,
uniform vec4 uE1;            // w = t component. e0 = camera 4-velocity,
uniform vec4 uE2;            // e1/e2/e3 = right/up/forward (derivations.md §8)
uniform vec4 uE3;
uniform int uSkyShift;       // apply g* = 1/q_t redshift to the starfield

const float R_ESCAPE = 200.0;  // escape radius (M); camera max is 60 M
const int HARD_CAP = 1024;     // absolute loop bound (driver-safe)

// ============================================================================
// SECTION: METRIC — Kerr-Schild form (derivations.md §1–2)
//   g_munu = eta_munu + f l_mu l_nu ;  g^munu = eta^munu - f l^mu l^nu
// ============================================================================

// KS radius: largest root of r^4 - r^2(rho^2 - a^2) - a^2 z^2 = 0 (§1).
// max() guards f32 rounding near the degenerate disk; the 1e-8 floor on r^2
// protects transient FD probes only — rendered rays terminate at the horizon
// long before r ~ 0.
float ksRadius(vec3 x, float a) {
  float b = dot(x, x) - a * a;
  float r2 = 0.5 * (b + sqrt(max(b * b + 4.0 * a * a * x.z * x.z, 0.0)));
  return sqrt(max(r2, 1e-8));
}

// Scalar profile f and null covector l_mu at position x (§2).
void metricTerms(vec3 x, float a, out float f, out vec3 l) {
  float r = ksRadius(x, a);
  float r2 = r * r;
  f = 2.0 * r2 * r / max(r2 * r2 + a * a * x.z * x.z, 1e-12);
  float ra2 = r2 + a * a;
  l = vec3((r * x.x + a * x.y) / ra2, (r * x.y - a * x.x) / ra2, x.z / r);
}

// Hamiltonian H = 1/2 g^{munu} p_mu p_nu with p_t = pt (§3):
//   2H = -pt^2 + |p|^2 - f (l^mu p_mu)^2,  l^mu p_mu = dot(l,p) - pt.
float hamiltonian(vec3 x, vec3 p, float pt, float a) {
  float f;
  vec3 l;
  metricTerms(x, a, f, l);
  float lp = dot(l, p) - pt;
  return 0.5 * (-pt * pt + dot(p, p) - f * lp * lp);
}

// ============================================================================
// SECTION: INTEGRATOR — Hamilton's equations, RK4, FD gradients (§3, §5)
// ============================================================================

// dx/dlambda = dH/dp (analytic); dp/dlambda = -dH/dx (central differences).
// pt is the ray's conserved p_t, fixed by the tetrad initialization (§8);
// it varies across pixels but is constant along each ray.
void rhs(vec3 x, vec3 p, float pt, float a, out vec3 dx, out vec3 dp) {
  float f;
  vec3 l;
  metricTerms(x, a, f, l);
  float lp = dot(l, p) - pt;
  dx = p - f * lp * l;

  // eps = 2e-3 max(r,1): optimal-order central-difference step for f32 (§5).
  float eps = 2e-3 * max(ksRadius(x, a), 1.0);
  float inv2e = 0.5 / eps;
  dp = -vec3(
      (hamiltonian(x + vec3(eps, 0, 0), p, pt, a) - hamiltonian(x - vec3(eps, 0, 0), p, pt, a)),
      (hamiltonian(x + vec3(0, eps, 0), p, pt, a) - hamiltonian(x - vec3(0, eps, 0), p, pt, a)),
      (hamiltonian(x + vec3(0, 0, eps), p, pt, a) - hamiltonian(x - vec3(0, 0, eps), p, pt, a))) *
      inv2e;
}

void rk4Step(inout vec3 x, inout vec3 p, float h, float pt, float a) {
  vec3 k1x, k1p, k2x, k2p, k3x, k3p, k4x, k4p;
  rhs(x, p, pt, a, k1x, k1p);
  rhs(x + 0.5 * h * k1x, p + 0.5 * h * k1p, pt, a, k2x, k2p);
  rhs(x + 0.5 * h * k2x, p + 0.5 * h * k2p, pt, a, k3x, k3p);
  rhs(x + h * k3x, p + h * k3p, pt, a, k4x, k4p);
  x += (h / 6.0) * (k1x + 2.0 * k2x + 2.0 * k3x + k4x);
  p += (h / 6.0) * (k1p + 2.0 * k2p + 2.0 * k3p + k4p);
}

// Ray initialization now uses the camera tetrad (§8): the traced ray is
// q^mu = -e0^mu + n^i e_i^mu, exactly null by orthonormality, normalized to
// unit locally-measured energy. The §4 quadratic survives in the validation
// suite as an independent cross-check of the same physics.

// ============================================================================
// SECTION: TERMINATION (§2.3 of PROJECT_PLAN)
// ============================================================================
// Adaptive affine step, displacement-bounded: dlambda is chosen so each
// step moves the ray a coordinate distance of ~10% of min(r - 0.9 r_H, r).
// Dividing by |dx/dlambda| is essential near the horizon, where |p| (and so
// the coordinate speed) blows up for past-directed shadow rays: a fixed
// dlambda there moves RK4 substates by many M and produces garbage states
// that misclassify as escaped. Bounds: floor 1e-4 (horizon huggers converge
// via the |p| capture guard), cap 4.0 (distant legs stay cheap).
float stepSize(float r, float rH, float speed) {
  return clamp(0.1 * min(r - 0.9 * rH, r) / max(speed, 1e-6), 1e-4, 4.0);
}

// ============================================================================
// SECTION: HASH UTILITIES (shared by disk noise and starfield)
// ============================================================================
// 3D fract-sin-free hash -> [0,1); adequate statistical quality for star
// placement and value noise, far cheaper than integer hashes.
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// ============================================================================
// SECTION: DISK — thin equatorial disk on prograde circular geodesics
// (PROJECT_PLAN §2.5; derivations.md §6–7)
// ============================================================================

// Orbital angular velocity Omega = 1/(r^{3/2} + a) and time-dilation factor
// u^t = (1 + a r^{-3/2}) / sqrt(1 - 3/r + 2 a r^{-3/2})   (M = 1, prograde).
// Valid for r >= r_ISCO, where the sqrt argument is strictly positive.
float diskOmega(float r, float a) {
  return 1.0 / (r * sqrt(r) + a);
}
float diskUt(float r, float a) {
  float inv32 = 1.0 / (r * sqrt(r));  // r^{-3/2}
  return (1.0 + a * inv32) / sqrt(max(1.0 - 3.0 / r + 2.0 * a * inv32, 1e-6));
}

// Value noise on a cylinder: q.x unbounded (log r), q.y periodic with
// integer period `period` so the pattern is seamless in phi.
float vnoiseCyl(vec2 q, float period) {
  vec2 i = floor(q);
  vec2 f = fract(q);
  f = f * f * (3.0 - 2.0 * f);
  float iy0 = mod(i.y, period);
  float iy1 = mod(i.y + 1.0, period);
  float v00 = hash13(vec3(i.x, iy0, 53.0));
  float v10 = hash13(vec3(i.x + 1.0, iy0, 53.0));
  float v01 = hash13(vec3(i.x, iy1, 53.0));
  float v11 = hash13(vec3(i.x + 1.0, iy1, 53.0));
  return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}

// 3-octave turbulence in co-rotating coordinates (log r, phi - Omega(r) t):
// each annulus advects at its own Keplerian rate, so the pattern shears
// differentially — structure for free, no textures.
float diskPattern(float r, float phi, float a) {
  float co = phi - diskOmega(r, a) * uTime;
  // 24 cells around the ring, 3 cells per e-fold of radius at base octave.
  float n = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int o = 0; o < 3; o++) {
    n += amp * vnoiseCyl(vec2(log(r) * 3.0 * freq, co * (24.0 * freq) / 6.2831853), 24.0 * freq);
    amp *= 0.5;
    freq *= 2.0;
  }
  return n;  // in [0, ~0.875]
}

// Blackbody-ish ramp for relative temperature t (1 = disk inner-edge rest
// temperature): deep red -> orange -> white -> blue-white. The monotone
// hue ordering is what matters physically (T_obs = g T scales it exactly);
// absolute calibration is aesthetic.
vec3 diskColor(float t) {
  vec3 c = vec3(0.0);
  c = mix(vec3(0.45, 0.05, 0.0), vec3(1.0, 0.45, 0.1), smoothstep(0.25, 0.65, t));
  c = mix(c, vec3(1.0, 0.93, 0.85), smoothstep(0.65, 1.05, t));
  c = mix(c, vec3(0.75, 0.82, 1.0), smoothstep(1.05, 1.5, t));
  return c;
}

// Shade a disk hit at equatorial point xh with ray momentum ph.
// Returns premultiplied-style (rgb, alpha) for front-to-back accumulation.
vec4 diskShade(vec3 xh, vec3 ph, float pt, float r, float a) {
  // Redshift g = 1 / [u^t (1 - Omega lambda)]; lambda = L_z/E of the
  // physical photon = -(x p_y - y p_x)/q_t for the traced ray (E = q_t).
  float lambda = -(xh.x * ph.y - xh.y * ph.x) / pt;
  float g = 1.0 / max(diskUt(r, a) * (1.0 - diskOmega(r, a) * lambda), 1e-3);
  g = min(g, 10.0);

  // Novikov-Thorne-ish emissivity (1 - sqrt(r_in/r)) / r^3, normalized to
  // ~1 at its own peak radius (49/36 r_in) so uDiskGain is scale-free.
  float e = max(1.0 - sqrt(uDiskInner / r), 0.0) / (r * r * r);
  float ePeak = (1.0 - sqrt(36.0 / 49.0)) / pow(uDiskInner * 49.0 / 36.0, 3.0);
  float emiss = e / max(ePeak, 1e-9);

  float noise = diskPattern(r, atan(xh.y, xh.x), a);
  float beam = (uBeaming == 1) ? g * g * g * g : 1.0;

  // Rest-frame temperature profile T ~ r^{-3/4} (thin disk), observed gT.
  // Normalized at the emissivity-peak radius 49/36 r_in, so tRel = g there:
  // the brightest annulus renders white at rest and shifts with g.
  float tRel = g * pow(uDiskInner * 49.0 / (36.0 * r), 0.75);
  vec3 col = diskColor(tRel) * (uDiskGain * emiss * beam * (0.55 + 0.9 * noise));

  // Wispy semi-transparency; fade the outer rim so the edge is soft.
  float alpha = (0.5 + 0.35 * noise) * smoothstep(uDiskOuter, 0.85 * uDiskOuter, r);
  return vec4(col, alpha);
}

// ============================================================================
// SECTION: STARFIELD — procedural celestial sphere (PROJECT_PLAN §2.6)
// ============================================================================

const float STAR_CELLS = 400.0;   // cells per cube-face edge
const float STAR_DENSITY = 0.04;  // fraction of cells containing a star

void cubeProject(vec3 d, out float face, out vec2 uv) {
  vec3 a = abs(d);
  if (a.x >= a.y && a.x >= a.z) {
    face = d.x > 0.0 ? 0.0 : 1.0;
    uv = vec2(d.y, d.z) / a.x;
  } else if (a.y >= a.z) {
    face = d.y > 0.0 ? 2.0 : 3.0;
    uv = vec2(d.x, d.z) / a.y;
  } else {
    face = d.z > 0.0 ? 4.0 : 5.0;
    uv = vec2(d.x, d.y) / a.z;
  }
  uv = uv * 0.5 + 0.5;
}

vec3 cubeUnproject(float face, vec2 uv) {
  vec2 c = uv * 2.0 - 1.0;
  if (face < 0.5) return normalize(vec3(1.0, c.x, c.y));
  if (face < 1.5) return normalize(vec3(-1.0, c.x, c.y));
  if (face < 2.5) return normalize(vec3(c.x, 1.0, c.y));
  if (face < 3.5) return normalize(vec3(c.x, -1.0, c.y));
  if (face < 4.5) return normalize(vec3(c.x, c.y, 1.0));
  return normalize(vec3(c.x, c.y, -1.0));
}

vec3 starColor(float t) {
  vec3 red = vec3(1.0, 0.55, 0.35);
  vec3 white = vec3(1.0, 0.98, 0.95);
  vec3 blue = vec3(0.65, 0.75, 1.0);
  return t < 0.5 ? mix(red, white, t * 2.0) : mix(white, blue, (t - 0.5) * 2.0);
}

// gstar = 1/q_t: frequency ratio observed/emitted for stars at infinity
// (derivations.md §9). Temperature scales by gstar (blackbody shape is
// preserved); bolometric brightness by gstar^4.
vec3 starfield(vec3 dir, float gstar) {
  float face;
  vec2 uv;
  cubeProject(dir, face, uv);
  vec2 cellUv = uv * STAR_CELLS;
  vec2 baseCell = floor(cellUv);
  float pixAngle = 2.0 * uTanHalfFov / uResolution.y;

  vec3 col = vec3(0.0);
  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      vec2 cell = baseCell + vec2(float(i), float(j));
      vec3 seed = vec3(cell, face * 101.0);
      if (hash13(seed) > STAR_DENSITY) continue;
      vec3 rnd = hash33(seed + 17.0);
      vec3 starDir = cubeUnproject(face, (cell + rnd.xy) / STAR_CELLS);
      float b = pow(1.0 - 0.97 * rnd.z, -0.6667);
      float ang = acos(clamp(dot(dir, starDir), -1.0, 1.0));
      float radius = pixAngle * (0.5 + 0.35 * b);
      float fall = 1.0 - smoothstep(0.0, radius, ang);
      // 0.3 keeps all but the brightest ~5% of stars below saturation, so
      // the sky reads as a backdrop rather than competing with the disk.
      // Temperature parameter mapped to T_rel = 0.5 + t, shifted by gstar.
      float tShift = clamp((0.5 + hash13(seed + 41.0)) * gstar - 0.5, 0.0, 1.0);
      float beam4 = gstar * gstar * gstar * gstar;
      col += fall * b * 0.3 * beam4 * starColor(tShift);
    }
  }
  return col;
}

// ============================================================================
// SECTION: DEBUG — false-color diagnostics (§2.4 of PROJECT_PLAN)
// ============================================================================
// Three-stop ramp blue -> green -> red over t in [0,1].
vec3 debugRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  return t < 0.5 ? mix(vec3(0.1, 0.2, 0.9), vec3(0.1, 0.9, 0.3), t * 2.0)
                 : mix(vec3(0.1, 0.9, 0.3), vec3(0.95, 0.15, 0.1), t * 2.0 - 1.0);
}

// ============================================================================
// SECTION: MAIN — ray construction, integration loop, shading dispatch
// ============================================================================
void main() {
  vec2 ndc = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  float aspect = uResolution.x / uResolution.y;
  vec3 dir = normalize(
      uCamForward + uTanHalfFov * (ndc.x * aspect * uCamRight + ndc.y * uCamUp));

  float a = uSpin;
  float rH = 1.0 + sqrt(max(1.0 - a * a, 0.0));  // outer horizon r_+
  // Capture buffer scales with sqrt(1-a^2) (~ surface gravity) so that it
  // stays inside the prograde photon orbit even near-extremal: at a = 0.998
  // a fixed 1.02 r_+ would sit OUTSIDE r_ph = 1.077 and clip real physics.
  float rCapture = rH * (1.0 + 0.02 * sqrt(max(1.0 - a * a, 0.0))) + 1e-3;

  // Ray from the camera tetrad (§8): local view direction nloc in the
  // (right, up, forward) frame; traced ray q = -e0 + n^i e_i, lowered with
  // the metric at the camera. q_t (the conserved p_t) now varies per pixel.
  vec3 nloc = normalize(vec3(ndc.x * aspect * uTanHalfFov, ndc.y * uTanHalfFov, 1.0));
  vec4 q4 = -uE0 + nloc.x * uE1 + nloc.y * uE2 + nloc.z * uE3;
  float fCam;
  vec3 lCam;
  metricTerms(uCamPos, a, fCam, lCam);
  float lq = q4.w + dot(lCam, q4.xyz);  // l_mu q^mu, l_t = 1
  float pt = -q4.w + fCam * lq;         // q_t = g_{t nu} q^nu
  vec3 x = uCamPos;
  vec3 p = q4.xyz + fCam * lq * lCam;   // q_i = g_{i nu} q^nu

  // Front-to-back transparent accumulation over disk crossings.
  vec3 accCol = vec3(0.0);
  float accA = 0.0;

  int steps = 0;
  int outcome = 0;  // 0 budget-exceeded, 1 captured, 2 escaped
  for (int i = 0; i < HARD_CAP; i++) {
    if (i >= uMaxSteps) break;
    float r = ksRadius(x, a);
    if (r < rCapture) {
      outcome = 1;
      break;
    }
    if (r > R_ESCAPE) {
      outcome = 2;
      break;
    }
    // Momentum-blowup capture: traced rays are past-directed, and in these
    // (ingoing-type) coordinates a past-directed shadow ray never crosses
    // the horizon — it hugs it with exponentially growing |p| (blueshift
    // relative to E = 1). Terminating on |p|^2 > 1e8 classifies such rays
    // as shadow before f32 error can scatter them; legitimate escaping and
    // photon-shell rays stay below |p| ~ 10^2. Written as !(<=) so a NaN
    // state (belt and braces) also terminates as captured.
    if (!(dot(p, p) <= 1e8)) {
      outcome = 1;
      break;
    }
    float f;
    vec3 l;
    metricTerms(x, a, f, l);
    vec3 v = p - f * (dot(l, p) - pt) * l;  // dx/dlambda
    float h = stepSize(r, rH, length(v));
    vec3 xPrev = x;
    vec3 pPrev = p;
    rk4Step(x, p, h, pt, a);
    steps++;

    // Disk plane crossing: sign change of z across the step. Bisect the
    // step 3 times (each halving re-integrates, so the hit point lies on
    // the true geodesic), then linearly interpolate the final sub-step.
    // A high-curvature step straddling z = 0 twice can be missed — the
    // adaptive step keeps steps ~10% of the local scale, making that rare.
    if (uDiskOn == 1 && xPrev.z * x.z < 0.0 && accA < 0.99) {
      vec3 xa = xPrev;
      vec3 pa = pPrev;
      float hh = h;
      for (int b = 0; b < 3; b++) {
        hh *= 0.5;
        vec3 xm = xa;
        vec3 pm = pa;
        rk4Step(xm, pm, hh, pt, a);
        if (xa.z * xm.z >= 0.0) {  // crossing is in the second half
          xa = xm;
          pa = pm;
        }
      }
      vec3 xb = xa;
      vec3 pb = pa;
      rk4Step(xb, pb, hh, pt, a);
      float denom = xa.z - xb.z;
      if (abs(denom) < 1e-12) denom = 1e-12;
      float tf = clamp(xa.z / denom, 0.0, 1.0);
      vec3 xh = mix(xa, xb, tf);
      vec3 ph = mix(pa, pb, tf);
      // Equatorial KS radius: r^2 = rho^2 - a^2 exactly at z = 0.
      float rh2 = xh.x * xh.x + xh.y * xh.y - a * a;
      float rHit = sqrt(max(rh2, 0.0));
      if (rHit > uDiskInner && rHit < uDiskOuter) {
        vec4 d = diskShade(xh, ph, pt, rHit, a);
        accCol += (1.0 - accA) * d.a * d.rgb;
        accA += (1.0 - accA) * d.a;
      }
    }
  }

  // --- Debug views override normal shading ---
  if (uDebugView == 1) {  // step count / budget
    fragColor = vec4(debugRamp(float(steps) / float(uMaxSteps)), 1.0);
    return;
  }
  if (uDebugView == 2) {  // |H| drift, log scale: 1e-7 (blue) .. 1e-1 (red)
    float drift = abs(hamiltonian(x, p, pt, a));
    float t = (log(max(drift, 1e-9)) / log(10.0) + 7.0) / 6.0;
    fragColor = vec4(debugRamp(t), 1.0);
    return;
  }
  if (uDebugView == 3) {  // final r, log scale: r_H .. R_ESCAPE
    float t = log(ksRadius(x, a) / rH) / log(R_ESCAPE / rH);
    fragColor = vec4(debugRamp(t), 1.0);
    return;
  }

  vec3 background = vec3(0.0);
  if (outcome == 2) {
    // Escaped: map the final coordinate velocity direction to the sky.
    float f;
    vec3 l;
    metricTerms(x, a, f, l);
    vec3 v = p - f * (dot(l, p) - pt) * l;
    float gstar = (uSkyShift == 1) ? 1.0 / max(pt, 1e-3) : 1.0;
    background = starfield(normalize(v), gstar);
  }
  // Captured or budget-exceeded: black background behind any disk layers.
  fragColor = vec4(accCol + (1.0 - accA) * background, 1.0);
}
