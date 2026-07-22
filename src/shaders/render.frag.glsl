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
uniform float uSkyRich;      // 0 = sparse backdrop; 1 = dense Milky-Way sky (merger mode)
uniform float uDiskSense;    // +1 prograde, -1 retrograde orbital flow
uniform vec3 uDiskNormal;    // unit disk normal (tilted about y; z-hat at i=0)
uniform vec3 uDiskE1;        // in-plane basis for the noise angle
uniform vec3 uDiskE2;

// --- Weak-field multi-mass mode (compiled with #define WEAK_FIELD) ---
// Linearized metric g_00 = -(1+2 Phi), g_ij = (1-2 Phi) delta_ij with
// Phi = -sum_k M_k/|x-x_k| (derivations.md §10). Only H, dx/dlambda, ray
// init, and termination differ; RK4/FD machinery is shared.
const int MAX_MASSES = 6;
uniform int uNMasses;
uniform vec3 uMassPos[MAX_MASSES];
uniform float uMassM[MAX_MASSES];

float wfPhi(vec3 x) {
  float phi = 0.0;
  for (int k = 0; k < MAX_MASSES; k++) {
    if (k >= uNMasses) break;
    phi -= uMassM[k] / max(length(x - uMassPos[k]), 1e-6);
  }
  return phi;
}

// Distance to the nearest mass surfaceish (d - 2M_k); negative = captured.
float wfNearest(vec3 x) {
  float dmin = 1e9;
  for (int k = 0; k < MAX_MASSES; k++) {
    if (k >= uNMasses) break;
    dmin = min(dmin, length(x - uMassPos[k]) - 2.0 * uMassM[k]);
  }
  return dmin;
}

// --- Binary merger mode (compiled with #define BINARY) ---
// Superposed boosted Kerr-Schild metric with the exact Sherman-Morrison
// inverse in scalar form (derivations.md §11). Spins are +z-aligned per the
// aligned-spin model (PROJECT_PLAN §10.7). uB*A = chi*M (a length);
// velocities are instantaneous coordinate velocities of the frozen-metric
// snapshot — zero in the Phase 14 static preview, driven in Phase 15.
uniform vec3 uB1Pos;
uniform float uB1M;
uniform float uB1A;
uniform mat4 uB1Boost;  // lab -> rest boost of hole 1 (identity when static)
uniform vec3 uB2Pos;
uniform float uB2M;
uniform float uB2A;
uniform mat4 uB2Boost;

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

#ifdef BINARY
// Boosts enter as PER-HOLE mat4 UNIFORMS (lab -> rest, acting on (t,x,y,z)
// column vectors), computed CPU-side each frame. Rationale: the branchy
// in-shader boost (early return + gamma math), inlined ~56x through the
// RK4/FD call tree, blew up the software-rasterizer pipeline JIT (first
// draw blocked > 180 s on SwiftShader); a branchless matrix multiply
// compiles in ~0.2 s and is bit-exact for identity (static holes), which
// preserves the M2 -> 0 parity anchor. The covector pulls back with the
// transpose: l = B^T l' (derivations.md sec. 11).

// Rest-frame KS radius about one hole (termination + FD-eps guides).
float binaryRadius(vec3 x, vec3 c, float a, mat4 B) {
  return ksRadius((B * vec4(0.0, x - c)).yzw, a);
}

// One boosted-KS term: f and the FULL null covector, packed (l_xyz, l_t).
void binaryTerm(vec3 x, vec3 c, float M, float a, mat4 B, out float f, out vec4 l4) {
  vec3 dxr = (B * vec4(0.0, x - c)).yzw;
  float r = ksRadius(dxr, a);
  float r2 = r * r;
  f = 2.0 * M * r2 * r / max(r2 * r2 + a * a * dxr.z * dxr.z, 1e-12);
  float ra2 = r2 + a * a;
  vec3 ls = vec3((r * dxr.x + a * dxr.y) / ra2, (r * dxr.y - a * dxr.x) / ra2, dxr.z / r);
  vec4 lt = transpose(B) * vec4(1.0, ls);  // (t, x, y, z) ordering
  l4 = vec4(lt.yzw, lt.x);
}

// Scalars of the closed-form inverse (derivations.md §11):
//   s_i = L_i.p4 = l_is.p - l_it pt,  c = eta(l1,l2),  D = 1 - f1 f2 c^2.
// The D floor keeps transient FD probes finite in the two-horizon overlap
// (that region is always inside the capture zone).
void binaryScalars(vec3 x, vec3 p, float pt,
                   out float f1, out vec4 l1, out float f2, out vec4 l2,
                   out float s1, out float s2, out float cc, out float D) {
  binaryTerm(x, uB1Pos, uB1M, uB1A, uB1Boost, f1, l1);
  binaryTerm(x, uB2Pos, uB2M, uB2A, uB2Boost, f2, l2);
  s1 = dot(l1.xyz, p) - l1.w * pt;
  s2 = dot(l2.xyz, p) - l2.w * pt;
  cc = dot(l1.xyz, l2.xyz) - l1.w * l2.w;
  D = max(1.0 - f1 * f2 * cc * cc, 1e-4);
}
#endif

#ifdef RETARDED
// --- Time-dependent (retarded) transport (compiled with BINARY + RETARDED) ---
// The frozen-metric approximation (above) evaluates the holes at their
// frame-instant positions for EVERY sample along a ray, which is wrong once
// the holes move appreciably during a light-crossing time. Here each hole
// rides its instantaneous uniform-velocity worldline c(t) = c0 + v (t - t0),
// with t0 the frame time (the camera sits at t = 0). Since a boosted-KS hole
// is the exact field of a UNIFORMLY MOVING hole, the linear worldline is the
// self-consistent companion to the boost that is already applied; orbital
// acceleration is still neglected (labeled). The metric is now genuinely
// time-dependent, so p_t is NOT conserved and coordinate time t must be
// carried as a fifth integrated quantity (with its conjugate pt = -p_t).
uniform vec3 uB1Vel;  // dc/dt of hole 1 (lab frame), matches uB1Boost
uniform vec3 uB2Vel;

// Worldline-advanced hole center at coordinate time tt. A ray escaping to
// large radius accumulates |tt| ~ hundreds of M, and near merger the light-
// crossing time is a sizeable fraction of the ORBITAL PERIOD, so the naive
// uniform-velocity line c0 + v tt is doubly wrong: it flings the hole off its
// bounded orbit AND misses that the hole has actually swung around. We instead
// advance the hole along its true CIRCULAR orbit about the barycenter, at the
// rigid rate omega = |v| / R (R = |c0|), in the frame spanned by the radial
// unit r_hat = c0/R and the tangential unit t_hat = v/|v|:
//     c(t) = R [ cos(omega t) r_hat + sin(omega t) t_hat ].
// This is exact for circular motion, stays on the orbit for all tt (|c| = R),
// and expands to c0 + v tt for |omega t| << 1 (the near-zone linear limit).
// With v = 0: omega = 0, t_hat = 0, and it returns c0 exactly (no NaN) —
// preserving the frozen static limit bit-for-bit. Orbital-plane precession and
// the shrinking of R during inspiral are neglected within a single ray (the
// metric is re-snapshotted every frame), and labeled.
vec3 retCenter(vec3 c0, vec3 v, float tt) {
  float R = length(c0);
  float sp = length(v);
  float ang = (sp / max(R, 1e-6)) * tt;
  vec3 rhat = c0 / max(R, 1e-6);
  vec3 that = v / max(sp, 1e-6);
  return R * (cos(ang) * rhat + sin(ang) * that);
}

// Hamiltonian at coordinate time tt: identical to the BINARY branch but with
// the hole centers advanced along their circular worldlines to tt.
float hamiltonianRT(vec3 x, vec3 p, float pt, float tt) {
  float f1, f2, s1, s2, cc, D;
  vec4 l1, l2;
  binaryTerm(x, retCenter(uB1Pos, uB1Vel, tt), uB1M, uB1A, uB1Boost, f1, l1);
  binaryTerm(x, retCenter(uB2Pos, uB2Vel, tt), uB2M, uB2A, uB2Boost, f2, l2);
  s1 = dot(l1.xyz, p) - l1.w * pt;
  s2 = dot(l2.xyz, p) - l2.w * pt;
  cc = dot(l1.xyz, l2.xyz) - l1.w * l2.w;
  D = max(1.0 - f1 * f2 * cc * cc, 1e-4);
  float wp = s2 - f1 * cc * s1;
  return 0.5 * (-pt * pt + dot(p, p) - f1 * s1 * s1 - (f2 / D) * wp * wp);
}

// Full Hamilton flow with dynamical (t, pt):
//   dx^i/dl = g^{i nu} p_nu           (analytic, same combination as frozen)
//   dt/dl   = g^{t nu} p_nu = -dH/dpt (the t-component of that same 4-vector)
//   dp_i/dl = -dH/dx^i                (central FD in the 3 spatial dirs)
//   dpt/dl  = +dH/dt                  (central FD in coordinate time; pt=-p_t)
// With v1 = v2 = 0 the centers are static, dpt/dl = 0 (pt conserved), and this
// reduces bit-for-bit to the frozen BINARY flow — the static-limit anchor.
void rhsR(vec3 x, vec3 p, float pt, float tt,
          out vec3 dx, out vec3 dp, out float dtc, out float dptc) {
  vec3 c1 = retCenter(uB1Pos, uB1Vel, tt);
  vec3 c2 = retCenter(uB2Pos, uB2Vel, tt);
  float f1, f2, s1, s2, cc, D;
  vec4 l1, l2;
  binaryTerm(x, c1, uB1M, uB1A, uB1Boost, f1, l1);
  binaryTerm(x, c2, uB2M, uB2A, uB2Boost, f2, l2);
  s1 = dot(l1.xyz, p) - l1.w * pt;
  s2 = dot(l2.xyz, p) - l2.w * pt;
  cc = dot(l1.xyz, l2.xyz) - l1.w * l2.w;
  D = max(1.0 - f1 * f2 * cc * cc, 1e-4);
  float wp = s2 - f1 * cc * s1;
  vec3 wl = l2.xyz - f1 * cc * l1.xyz;
  dx = p - f1 * s1 * l1.xyz - (f2 / D) * wp * wl;
  dtc = pt - f1 * s1 * l1.w - (f2 / D) * wp * (l2.w - f1 * cc * l1.w);
  float epsR = binaryRadius(x, c1, uB1A, uB1Boost);
  if (uB2M > 0.0) epsR = min(epsR, binaryRadius(x, c2, uB2A, uB2Boost));
  float eps = 2e-3 * max(epsR, 1.0);
  float inv2e = 0.5 / eps;
  dp = -vec3(
      hamiltonianRT(x + vec3(eps, 0, 0), p, pt, tt) - hamiltonianRT(x - vec3(eps, 0, 0), p, pt, tt),
      hamiltonianRT(x + vec3(0, eps, 0), p, pt, tt) - hamiltonianRT(x - vec3(0, eps, 0), p, pt, tt),
      hamiltonianRT(x + vec3(0, 0, eps), p, pt, tt) - hamiltonianRT(x - vec3(0, 0, eps), p, pt, tt)) *
      inv2e;
  // dpt/dl = dH/dt: FD in coordinate time (moves both hole centers).
  dptc = (hamiltonianRT(x, p, pt, tt + eps) - hamiltonianRT(x, p, pt, tt - eps)) * inv2e;
}

void rk4StepR(inout vec3 x, inout vec3 p, inout float pt, inout float tt, float h) {
  vec3 k1x, k1p, k2x, k2p, k3x, k3p, k4x, k4p;
  float k1t, k1pt, k2t, k2pt, k3t, k3pt, k4t, k4pt;
  rhsR(x, p, pt, tt, k1x, k1p, k1t, k1pt);
  rhsR(x + 0.5 * h * k1x, p + 0.5 * h * k1p, pt + 0.5 * h * k1pt, tt + 0.5 * h * k1t, k2x, k2p, k2t, k2pt);
  rhsR(x + 0.5 * h * k2x, p + 0.5 * h * k2p, pt + 0.5 * h * k2pt, tt + 0.5 * h * k2t, k3x, k3p, k3t, k3pt);
  rhsR(x + h * k3x, p + h * k3p, pt + h * k3pt, tt + h * k3t, k4x, k4p, k4t, k4pt);
  x += (h / 6.0) * (k1x + 2.0 * k2x + 2.0 * k3x + k4x);
  p += (h / 6.0) * (k1p + 2.0 * k2p + 2.0 * k3p + k4p);
  pt += (h / 6.0) * (k1pt + 2.0 * k2pt + 2.0 * k3pt + k4pt);
  tt += (h / 6.0) * (k1t + 2.0 * k2t + 2.0 * k3t + k4t);
}
#endif

// Hamiltonian H = 1/2 g^{munu} p_mu p_nu with p_t = pt (§3):
//   2H = -pt^2 + |p|^2 - f (l^mu p_mu)^2,  l^mu p_mu = dot(l,p) - pt.
float hamiltonian(vec3 x, vec3 p, float pt, float a) {
#ifdef WEAK_FIELD
  float phi = wfPhi(x);
  return 0.5 * (-pt * pt / (1.0 + 2.0 * phi) + dot(p, p) / (1.0 - 2.0 * phi));
#elif defined(BINARY)
  // 2H = -pt^2 + |p|^2 - f1 s1^2 - (f2/D)(s2 - f1 c s1)^2. With f2 = 0 this
  // reduces BIT-FOR-BIT to the single-Kerr branch (the M2 -> 0 pixel-parity
  // anchor); agreement with the matrix inverse is a suite check (study 8).
  float f1, f2, s1, s2, cc, D;
  vec4 l1, l2;
  binaryScalars(x, p, pt, f1, l1, f2, l2, s1, s2, cc, D);
  float wp = s2 - f1 * cc * s1;
  return 0.5 * (-pt * pt + dot(p, p) - f1 * s1 * s1 - (f2 / D) * wp * wp);
#else
  float f;
  vec3 l;
  metricTerms(x, a, f, l);
  float lp = dot(l, p) - pt;
  return 0.5 * (-pt * pt + dot(p, p) - f * lp * lp);
#endif
}

// ============================================================================
// SECTION: INTEGRATOR — Hamilton's equations, RK4, FD gradients (§3, §5)
// ============================================================================

// dx/dlambda = dH/dp (analytic); dp/dlambda = -dH/dx (central differences).
// pt is the ray's conserved p_t, fixed by the tetrad initialization (§8);
// it varies across pixels but is constant along each ray.
void rhs(vec3 x, vec3 p, float pt, float a, out vec3 dx, out vec3 dp) {
#ifdef WEAK_FIELD
  dx = p / (1.0 - 2.0 * wfPhi(x));
  float eps = 2e-3 * max(wfNearest(x), 1.0);
#elif defined(BINARY)
  // dx^i = g^{i nu} p_nu = p - f1 s1 l1s - (f2/D) wp (l2s - f1 c l1s).
  float f1, f2, s1, s2, cc, D;
  vec4 l1, l2;
  binaryScalars(x, p, pt, f1, l1, f2, l2, s1, s2, cc, D);
  float wp = s2 - f1 * cc * s1;
  dx = p - f1 * s1 * l1.xyz - (f2 / D) * wp * (l2.xyz - f1 * cc * l1.xyz);
  // FD eps from the nearer hole's rest radius; the second hole enters only
  // when massive, so the M2 = 0 limit matches the Kerr eps exactly.
  float epsR = binaryRadius(x, uB1Pos, uB1A, uB1Boost);
  if (uB2M > 0.0) epsR = min(epsR, binaryRadius(x, uB2Pos, uB2A, uB2Boost));
  float eps = 2e-3 * max(epsR, 1.0);
#else
  float f;
  vec3 l;
  metricTerms(x, a, f, l);
  float lp = dot(l, p) - pt;
  dx = p - f * lp * l;

  // eps = 2e-3 max(r,1): optimal-order central-difference step for f32 (§5).
  float eps = 2e-3 * max(ksRadius(x, a), 1.0);
#endif
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
// Compiled OUT of the BINARY variant: merger mode has no disk (§10.7), and
// the crossing-bisection block triples the rk4Step inline sites — with the
// heavier binary Hamiltonian that explodes software-rasterizer pipeline
// JIT time (observed: SwiftShader blocked > 180 s on the first draw).
// ============================================================================
#ifndef BINARY

// Orbital angular velocity Omega = s/(r^{3/2} + s a) and time-dilation
// factor u^t = (1 + s a r^{-3/2}) / sqrt(1 - 3/r + 2 s a r^{-3/2}), with
// s = +1 prograde / -1 retrograde (M = 1; derivations.md §6, PROJECT_PLAN
// §9.3). Valid for r >= r_ISCO(s), where the sqrt argument is positive.
float diskOmega(float r, float a) {
  return uDiskSense / (r * sqrt(r) + uDiskSense * a);
}
float diskUt(float r, float a) {
  float inv32 = 1.0 / (r * sqrt(r));  // r^{-3/2}
  float sa = uDiskSense * a;
  return (1.0 + sa * inv32) / sqrt(max(1.0 - 3.0 / r + 2.0 * sa * inv32, 1e-6));
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

// Visual playback rate: with 1 code-second == 1 M of coordinate time the
// inner edge takes ~a minute per orbit and the disk looks frozen. This
// factor fast-forwards the *texture phase* so the differential (Keplerian)
// shear is visible — the inner annuli visibly outrun the outer ones. It is
// only a time remap; the instantaneous redshift g and g^4 beaming use
// Omega(r) directly and are unchanged, so the physics of every pixel's
// color is exact — this is fast-forward, not a distortion.
const float DISK_TIME_SCALE = 2.0;

// 3-octave turbulence in co-rotating coordinates (log r, phi - Omega(r) t):
// each annulus advects at its own Keplerian rate, so the pattern shears
// differentially — structure for free, no textures.
float diskPattern(float r, float phi, float a) {
  float co = phi - diskOmega(r, a) * uTime * DISK_TIME_SCALE;
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
  // Redshift g = 1 / [u^t (1 - Omega lambda_n)] with lambda_n the angular
  // momentum about the DISK normal per unit energy, evaluated at the hit:
  // lambda_n = -((x cross p) . n)/q_t. Equals the conserved L_z/E for the
  // equatorial disk; for a tilted disk it is the natural kinematic choice
  // (exact at a = 0 by spherical symmetry; the tilted mode is labeled a
  // kinematic approximation for a != 0 — see docs/rendering.md).
  float lambda = -dot(cross(xh, ph), uDiskNormal) / pt;
  float g = 1.0 / max(diskUt(r, a) * (1.0 - diskOmega(r, a) * lambda), 1e-3);
  g = min(g, 10.0);

  // Novikov-Thorne-ish emissivity (1 - sqrt(r_in/r)) / r^3, normalized to
  // ~1 at its own peak radius (49/36 r_in) so uDiskGain is scale-free.
  float e = max(1.0 - sqrt(uDiskInner / r), 0.0) / (r * r * r);
  float ePeak = (1.0 - sqrt(36.0 / 49.0)) / pow(uDiskInner * 49.0 / 36.0, 3.0);
  float emiss = e / max(ePeak, 1e-9);

  float noise = diskPattern(r, atan(dot(xh, uDiskE2), dot(xh, uDiskE1)), a);
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

#endif  // ifndef BINARY (disk section)

// ============================================================================
// SECTION: STARFIELD — procedural celestial sphere (PROJECT_PLAN §2.6)
// ============================================================================

const float STAR_CELLS = 400.0;   // cells per cube-face edge
const float STAR_DENSITY = 0.04;  // fraction of cells containing a star
// Apparent-radius scale for the drawn stars. Real stars are unresolved point
// sources far below a pixel, so a smaller footprint is *physically* truer;
// 0.5 halves the old rendered size, toward points. The rendered spot is a
// point-spread footprint (an eye/telescope has one too), kept ~sub-pixel but
// non-zero so stars anti-alias instead of twinkling under camera motion.
// Peak brightness is scaled by 1/STAR_SIZE^2 (flux conservation: a point
// source's total flux is fixed, so a PSF of half the radius — a quarter the
// area — is four times brighter at its core). The sky keeps its overall
// brightness; the stars are simply smaller and sharper.
const float STAR_SIZE = 0.5;

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

// 3D trilinear value noise (from hash13) and a 4-octave fbm, for the diffuse
// Milky-Way band and its dust. Available in every variant (unlike the disk's
// cylinder noise, which is compiled out of BINARY).
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1, 0, 0));
  float n010 = hash13(i + vec3(0, 1, 0)), n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1)), n101 = hash13(i + vec3(1, 0, 1));
  float n011 = hash13(i + vec3(0, 1, 1)), n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) { s += a * vnoise3(p); p *= 2.02; a *= 0.5; }
  return s;
}

// Diffuse warm galactic band + dust — a Milky-Way backdrop that gives the
// lensing something textured to warp (the SXS/LIGO merger look). Purely
// aesthetic, exactly like the stars: the structure is invented (procedural,
// zero-asset); only its gravitational deflection along the ray is exact.
vec3 milkyWay(vec3 dir, float gstar) {
  vec3 pole = normalize(vec3(-0.31, 0.82, 0.48));  // galactic north pole
  float b = asin(clamp(dot(dir, pole), -1.0, 1.0)); // galactic latitude
  // A DEFINED warm band (narrow, dim) — a stripe across a dark sky, not an
  // all-over glow; the strong-lensing magnification near each shadow brightens
  // it into the Einstein arcs, so the base level stays low on purpose.
  float band = exp(-b * b * 13.0) * 0.28 + exp(-b * b * 80.0) * 0.42;
  // Mottled clouds and darker dust lanes from fbm on the sphere.
  float clouds = fbm3(dir * 5.0 + 11.0);
  float lanes = smoothstep(0.28, 0.72, fbm3(dir * 2.3 + 4.0));
  band *= (0.35 + 1.0 * clouds) * (1.0 - 0.7 * lanes);
  // Very faint all-sky haze so deep sky is near-black, not pure void.
  float haze = 0.015 * (0.5 + 0.5 * fbm3(dir * 8.0));
  vec3 warm = vec3(0.58, 0.49, 0.41);
  float beam4 = gstar * gstar * gstar * gstar;
  return (warm * band + vec3(0.6, 0.62, 0.72) * haze) * beam4;
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

  // Merger mode (uSkyRich = 1) packs MORE but DIMMER stars: a richer field
  // that still reads as a dark sky with distinct points (the per-star flux
  // already peaks near white, so a lower gain keeps the field from washing to
  // grey while the higher density fills it in). Normal disk mode (uSkyRich = 0)
  // keeps the original sparse, dim backdrop untouched.
  float density = STAR_DENSITY * (1.0 + 2.2 * uSkyRich);
  float starGain = mix(1.0, 0.4, uSkyRich);

  vec3 col = vec3(0.0);
  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      vec2 cell = baseCell + vec2(float(i), float(j));
      vec3 seed = vec3(cell, face * 101.0);
      if (hash13(seed) > density) continue;
      vec3 rnd = hash33(seed + 17.0);
      vec3 starDir = cubeUnproject(face, (cell + rnd.xy) / STAR_CELLS);
      float b = pow(1.0 - 0.97 * rnd.z, -0.6667);
      float ang = acos(clamp(dot(dir, starDir), -1.0, 1.0));
      float radius = pixAngle * (0.5 + 0.35 * b) * STAR_SIZE;
      float fall = 1.0 - smoothstep(0.0, radius, ang);
      // 0.3 keeps all but the brightest ~5% of stars below saturation, so
      // the sky reads as a backdrop rather than competing with the disk.
      // Temperature parameter mapped to T_rel = 0.5 + t, shifted by gstar.
      float tShift = clamp((0.5 + hash13(seed + 41.0)) * gstar - 0.5, 0.0, 1.0);
      float beam4 = gstar * gstar * gstar * gstar;
      col += fall * b * 0.3 * starGain * beam4 * starColor(tShift) / (STAR_SIZE * STAR_SIZE);
    }
  }
  // Diffuse Milky-Way band behind the point stars (merger mode only).
  col += uSkyRich * milkyWay(dir, gstar);
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

#ifdef BINARY
  // Per-hole horizon/capture radii: the single-Kerr law scaled by each mass
  // (chi = a/M). With M1 = 1, chi1 = uSpin these reproduce rH/rCapture above
  // bit-for-bit — part of the M2 -> 0 parity anchor.
  float chi1 = uB1A / max(uB1M, 1e-12);
  float s1g = sqrt(max(1.0 - chi1 * chi1, 0.0));
  float bRh1 = uB1M * (1.0 + s1g);
  float bCap1 = bRh1 * (1.0 + 0.02 * s1g) + 1e-3;
  float chi2 = uB2A / max(uB2M, 1e-12);
  float s2g = sqrt(max(1.0 - chi2 * chi2, 0.0));
  float bRh2 = uB2M * (1.0 + s2g);
  float bCap2 = bRh2 * (1.0 + 0.02 * s2g) + 1e-3;
#endif

#ifdef WEAK_FIELD
  // Static spacetime: time orientation is irrelevant to imaging and angles
  // differ from proper ones only at O(Phi); coordinate-covector rays with
  // the exact null pt suffice for this deliberately-approximate mode.
  vec3 x = uCamPos;
  vec3 p = dir;
  float phiCam = wfPhi(x);
  float pt = sqrt(max((1.0 + 2.0 * phiCam) / (1.0 - 2.0 * phiCam), 1e-6));
#else
  // Ray from the camera tetrad (§8): local view direction nloc in the
  // (right, up, forward) frame; traced ray q = -e0 + n^i e_i, lowered with
  // the metric at the camera. q_t (the conserved p_t) now varies per pixel.
  vec3 nloc = normalize(vec3(ndc.x * aspect * uTanHalfFov, ndc.y * uTanHalfFov, 1.0));
  vec4 q4 = -uE0 + nloc.x * uE1 + nloc.y * uE2 + nloc.z * uE3;
#ifdef BINARY
  // Lower with the BINARY metric at the camera: q_mu = eta q + sum f_i (l_i.q) l_i.
  float fc1, fc2;
  vec4 lc1, lc2;
  binaryTerm(uCamPos, uB1Pos, uB1M, uB1A, uB1Boost, fc1, lc1);
  binaryTerm(uCamPos, uB2Pos, uB2M, uB2A, uB2Boost, fc2, lc2);
  float lq1 = lc1.w * q4.w + dot(lc1.xyz, q4.xyz);
  float lq2 = lc2.w * q4.w + dot(lc2.xyz, q4.xyz);
  float pt = -q4.w + fc1 * lq1 * lc1.w + fc2 * lq2 * lc2.w;
  vec3 x = uCamPos;
  vec3 p = q4.xyz + fc1 * lq1 * lc1.xyz + fc2 * lq2 * lc2.xyz;
#else
  float fCam;
  vec3 lCam;
  metricTerms(uCamPos, a, fCam, lCam);
  float lq = q4.w + dot(lCam, q4.xyz);  // l_mu q^mu, l_t = 1
  float pt = -q4.w + fCam * lq;         // q_t = g_{t nu} q^nu
  vec3 x = uCamPos;
  vec3 p = q4.xyz + fCam * lq * lCam;   // q_i = g_{i nu} q^nu
#endif
#endif

  // Front-to-back transparent accumulation over disk crossings.
  vec3 accCol = vec3(0.0);
  float accA = 0.0;

  int steps = 0;
  int outcome = 0;  // 0 budget-exceeded, 1 captured, 2 escaped
#ifdef RETARDED
  // Coordinate time along the ray, referenced to the frame instant (camera at
  // t = 0). Drives the holes' worldline positions c(tt) = c0 + v tt.
  float tt = 0.0;
#endif
  for (int i = 0; i < HARD_CAP; i++) {
    if (i >= uMaxSteps) break;
#ifdef WEAK_FIELD
    float r = length(x);
    // "Capture" at the would-be Schwarzschild radius of each mass: a
    // regularization of the broken linear approximation, not a horizon.
    if (wfNearest(x) < 0.0) {
      outcome = 1;
      break;
    }
#elif defined(BINARY)
    // r is the rest radius about hole 1 (equal to the Kerr r when M2 = 0,
    // and a valid escape measure since both holes sit near the origin).
    // Under RETARDED the centers ride their worldlines to the ray's time tt.
#ifdef RETARDED
    vec3 bc1 = retCenter(uB1Pos, uB1Vel, tt);
    vec3 bc2 = retCenter(uB2Pos, uB2Vel, tt);
#else
    vec3 bc1 = uB1Pos;
    vec3 bc2 = uB2Pos;
#endif
    float r = binaryRadius(x, bc1, uB1A, uB1Boost);
    if (r < bCap1) {
      outcome = 1;
      break;
    }
    if (uB2M > 0.0 && binaryRadius(x, bc2, uB2A, uB2Boost) < bCap2) {
      outcome = 1;
      break;
    }
#else
    float r = ksRadius(x, a);
    if (r < rCapture) {
      outcome = 1;
      break;
    }
#endif
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
#ifdef WEAK_FIELD
    vec3 v = p / (1.0 - 2.0 * wfPhi(x));
    float h = clamp(0.08 * max(wfNearest(x), 0.05) / max(length(v), 1e-6), 1e-4, 6.0);
#elif defined(BINARY)
    float f1s, f2s, ss1, ss2, ccs, Ds;
    vec4 l1s, l2s;
#ifdef RETARDED
    // Scalars at the ray-time hole positions bc1, bc2 (worldline-advanced).
    binaryTerm(x, bc1, uB1M, uB1A, uB1Boost, f1s, l1s);
    binaryTerm(x, bc2, uB2M, uB2A, uB2Boost, f2s, l2s);
    ss1 = dot(l1s.xyz, p) - l1s.w * pt;
    ss2 = dot(l2s.xyz, p) - l2s.w * pt;
    ccs = dot(l1s.xyz, l2s.xyz) - l1s.w * l2s.w;
    Ds = max(1.0 - f1s * f2s * ccs * ccs, 1e-4);
#else
    binaryScalars(x, p, pt, f1s, l1s, f2s, l2s, ss1, ss2, ccs, Ds);
#endif
    float wps = ss2 - f1s * ccs * ss1;
    vec3 v = p - f1s * ss1 * l1s.xyz - (f2s / Ds) * wps * (l2s.xyz - f1s * ccs * l1s.xyz);
    // Displacement-bounded step, guided by the NEARER hole's local scale
    // (single-Kerr law when M2 = 0 — the second min only enters when massive).
    float guide = min(r - 0.9 * bRh1, r);
    if (uB2M > 0.0) {
      float r2b = binaryRadius(x, bc2, uB2A, uB2Boost);
      guide = min(guide, min(r2b - 0.9 * bRh2, r2b));
    }
    float h = clamp(0.1 * guide / max(length(v), 1e-6), 1e-4, 4.0);
#else
    float f;
    vec3 l;
    metricTerms(x, a, f, l);
    vec3 v = p - f * (dot(l, p) - pt) * l;  // dx/dlambda
    float h = stepSize(r, rH, length(v));
#endif
    vec3 xPrev = x;
    vec3 pPrev = p;
#ifdef RETARDED
    rk4StepR(x, p, pt, tt, h);  // advances (x, p, pt, tt) together
#else
    rk4Step(x, p, h, pt, a);
#endif
    steps++;

#ifndef BINARY
    // Disk plane crossing: sign change of (x . n) across the step. Bisect
    // the step 3 times (each halving re-integrates, so the hit point lies
    // on the true geodesic), then linearly interpolate the final sub-step.
    // A high-curvature step straddling the plane twice can be missed — the
    // adaptive step keeps steps ~10% of the local scale, making that rare.
    if (uDiskOn == 1 && dot(xPrev, uDiskNormal) * dot(x, uDiskNormal) < 0.0 && accA < 0.99) {
      vec3 xa = xPrev;
      vec3 pa = pPrev;
      float hh = h;
      for (int b = 0; b < 3; b++) {
        hh *= 0.5;
        vec3 xm = xa;
        vec3 pm = pa;
        rk4Step(xm, pm, hh, pt, a);
        if (dot(xa, uDiskNormal) * dot(xm, uDiskNormal) >= 0.0) {
          xa = xm;  // crossing is in the second half
          pa = pm;
        }
      }
      vec3 xb = xa;
      vec3 pb = pa;
      rk4Step(xb, pb, hh, pt, a);
      float za = dot(xa, uDiskNormal);
      float denom = za - dot(xb, uDiskNormal);
      if (abs(denom) < 1e-12) denom = 1e-12;
      float tf = clamp(za / denom, 0.0, 1.0);
      vec3 xh = mix(xa, xb, tf);
      vec3 ph = mix(pa, pb, tf);
      float rHit = ksRadius(xh, a);
      if (rHit > uDiskInner && rHit < uDiskOuter) {
        vec4 d = diskShade(xh, ph, pt, rHit, a);
        accCol += (1.0 - accA) * d.a * d.rgb;
        accA += (1.0 - accA) * d.a;
      }
    }
#endif  // ifndef BINARY (disk crossing)
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
#ifdef WEAK_FIELD
    vec3 v = p / (1.0 - 2.0 * wfPhi(x));
    background = starfield(normalize(v), 1.0);  // |Phi| << 1: shift negligible
#elif defined(BINARY)
    float f1e, f2e, se1, se2, cce, De;
    vec4 l1e, l2e;
    binaryScalars(x, p, pt, f1e, l1e, f2e, l2e, se1, se2, cce, De);
    float wpe = se2 - f1e * cce * se1;
    vec3 v = p - f1e * se1 * l1e.xyz - (f2e / De) * wpe * (l2e.xyz - f1e * cce * l1e.xyz);
    float gstar = (uSkyShift == 1) ? 1.0 / max(pt, 1e-3) : 1.0;
    background = starfield(normalize(v), gstar);
#else
    float f;
    vec3 l;
    metricTerms(x, a, f, l);
    vec3 v = p - f * (dot(l, p) - pt) * l;
    float gstar = (uSkyShift == 1) ? 1.0 / max(pt, 1e-3) : 1.0;
    background = starfield(normalize(v), gstar);
#endif
  }
  // Captured or budget-exceeded: black background behind any disk layers.
  fragColor = vec4(accCol + (1.0 - accA) * background, 1.0);
}
