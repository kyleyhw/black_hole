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
// The traced ray carries p_t = 1 (past-directed root normalized so the
// physical photon has E = 1; see §4).
void rhs(vec3 x, vec3 p, float a, out vec3 dx, out vec3 dp) {
  float f;
  vec3 l;
  metricTerms(x, a, f, l);
  float lp = dot(l, p) - 1.0;
  dx = p - f * lp * l;

  // eps = 2e-3 max(r,1): optimal-order central-difference step for f32 (§5).
  float eps = 2e-3 * max(ksRadius(x, a), 1.0);
  float inv2e = 0.5 / eps;
  dp = -vec3(
      (hamiltonian(x + vec3(eps, 0, 0), p, 1.0, a) - hamiltonian(x - vec3(eps, 0, 0), p, 1.0, a)),
      (hamiltonian(x + vec3(0, eps, 0), p, 1.0, a) - hamiltonian(x - vec3(0, eps, 0), p, 1.0, a)),
      (hamiltonian(x + vec3(0, 0, eps), p, 1.0, a) - hamiltonian(x - vec3(0, 0, eps), p, 1.0, a))) *
      inv2e;
}

void rk4Step(inout vec3 x, inout vec3 p, float h, float a) {
  vec3 k1x, k1p, k2x, k2p, k3x, k3p, k4x, k4p;
  rhs(x, p, a, k1x, k1p);
  rhs(x + 0.5 * h * k1x, p + 0.5 * h * k1p, a, k2x, k2p);
  rhs(x + 0.5 * h * k2x, p + 0.5 * h * k2p, a, k3x, k3p);
  rhs(x + h * k3x, p + h * k3p, a, k4x, k4p);
  x += (h / 6.0) * (k1x + 2.0 * k2x + 2.0 * k3x + k4x);
  p += (h / 6.0) * (k1p + 2.0 * k2p + 2.0 * k3p + k4p);
}

// Initial p_t: past-directed root of the null quadratic (§4),
//   q_t = (f s + sqrt(D)) / (1+f),  D = (1+f)|p|^2 - f s^2 > 0 always.
// The whole momentum is then rescaled by 1/q_t so p_t = 1 exactly.
float initialPt(vec3 x, vec3 p, float a) {
  float f;
  vec3 l;
  metricTerms(x, a, f, l);
  float s = dot(l, p);
  float D = (1.0 + f) * dot(p, p) - f * s * s;
  return (f * s + sqrt(max(D, 0.0))) / (1.0 + f);
}

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
// SECTION: STARFIELD — procedural celestial sphere (PROJECT_PLAN §2.6)
// ============================================================================

const float STAR_CELLS = 400.0;   // cells per cube-face edge
const float STAR_DENSITY = 0.04;  // fraction of cells containing a star

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

vec3 starfield(vec3 dir) {
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
      col += fall * b * 0.55 * starColor(hash13(seed + 41.0));
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

  // Ray state: x, spatial covector p, with p_t = 1 after normalization (§4).
  vec3 x = uCamPos;
  vec3 p = dir / initialPt(uCamPos, dir, a);

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
    vec3 v = p - f * (dot(l, p) - 1.0) * l;  // dx/dlambda
    rk4Step(x, p, stepSize(r, rH, length(v)), a);
    steps++;
  }

  // --- Debug views override normal shading ---
  if (uDebugView == 1) {  // step count / budget
    fragColor = vec4(debugRamp(float(steps) / float(uMaxSteps)), 1.0);
    return;
  }
  if (uDebugView == 2) {  // |H| drift, log scale: 1e-7 (blue) .. 1e-1 (red)
    float drift = abs(hamiltonian(x, p, 1.0, a));
    float t = (log(max(drift, 1e-9)) / log(10.0) + 7.0) / 6.0;
    fragColor = vec4(debugRamp(t), 1.0);
    return;
  }
  if (uDebugView == 3) {  // final r, log scale: r_H .. R_ESCAPE
    float t = log(ksRadius(x, a) / rH) / log(R_ESCAPE / rH);
    fragColor = vec4(debugRamp(t), 1.0);
    return;
  }

  vec3 color;
  if (outcome == 2) {
    // Escaped: map the final coordinate velocity direction to the sky.
    float f;
    vec3 l;
    metricTerms(x, a, f, l);
    vec3 v = p - f * (dot(l, p) - 1.0) * l;
    color = starfield(normalize(v));
  } else {
    // Captured, or budget-exceeded (photon-shell strugglers): shadow black.
    color = vec3(0.0);
  }
  fragColor = vec4(color, 1.0);
}
