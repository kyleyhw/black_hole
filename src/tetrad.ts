// CPU-side Kerr-Schild metric operations and camera tetrad construction.
// Mirrors the shader's metric section in float64; derivations.md §8.
//
// Four-vector convention here: [t, x, y, z], CONTRAVARIANT components.

export type Vec3 = readonly [number, number, number];
export type Vec4 = readonly [number, number, number, number];

export interface MetricTerms {
  readonly f: number;
  readonly l: Vec3; // spatial part of l_mu (l_t = 1)
  readonly r: number;
}

export function ksRadius(x: Vec3, a: number): number {
  const b = x[0] * x[0] + x[1] * x[1] + x[2] * x[2] - a * a;
  const r2 = 0.5 * (b + Math.sqrt(Math.max(b * b + 4 * a * a * x[2] * x[2], 0)));
  return Math.sqrt(Math.max(r2, 1e-12));
}

export function metricTerms(x: Vec3, a: number): MetricTerms {
  const r = ksRadius(x, a);
  const r2 = r * r;
  const f = (2 * r2 * r) / Math.max(r2 * r2 + a * a * x[2] * x[2], 1e-24);
  const ra2 = r2 + a * a;
  const l: Vec3 = [(r * x[0] + a * x[1]) / ra2, (r * x[1] - a * x[0]) / ra2, x[2] / r];
  return { f, l, r };
}

/** g(v, w) = eta(v, w) + f (l . v)(l . w) for contravariant v, w. */
export function gDot(v: Vec4, w: Vec4, m: MetricTerms): number {
  const eta = -v[0] * w[0] + v[1] * w[1] + v[2] * w[2] + v[3] * w[3];
  const lv = v[0] + m.l[0] * v[1] + m.l[1] * v[2] + m.l[2] * v[3];
  const lw = w[0] + m.l[0] * w[1] + m.l[1] * w[2] + m.l[2] * w[3];
  return eta + m.f * lv * lw;
}

/** Static observer u = dt / sqrt(-g_tt); only exists where f < 1 (outside
 * the ergosphere). Throws if asked for one inside. */
export function staticObserver(x: Vec3, a: number): Vec4 {
  const m = metricTerms(x, a);
  if (m.f >= 1) throw new Error("static observer requested inside the ergosphere");
  return [1 / Math.sqrt(1 - m.f), 0, 0, 0];
}

/**
 * Orthonormal tetrad at x for observer 4-velocity u (g(u,u) = -1):
 * e0 = u; spatial legs seeded from the flat camera basis (right, up,
 * forward) and Gram-Schmidt-orthonormalized under g. Returns
 * [e0, eRight, eUp, eForward], contravariant.
 */
export function buildTetrad(x: Vec3, u: Vec4, right: Vec3, up: Vec3, forward: Vec3, a: number): [Vec4, Vec4, Vec4, Vec4] {
  const m = metricTerms(x, a);
  const legs: Vec4[] = [u];
  const seeds: Vec4[] = [
    [0, right[0], right[1], right[2]],
    [0, up[0], up[1], up[2]],
    [0, forward[0], forward[1], forward[2]],
  ];
  const axpy = (v: Vec4, s: number, w: Vec4): Vec4 => [
    v[0] + s * w[0],
    v[1] + s * w[1],
    v[2] + s * w[2],
    v[3] + s * w[3],
  ];
  for (const seed of seeds) {
    // Project out u (g(u,u) = -1 flips the usual sign) and prior legs.
    let v: Vec4 = axpy(seed, gDot(seed, u, m), u);
    for (const leg of legs.slice(1)) v = axpy(v, -gDot(v, leg, m), leg);
    const norm = Math.sqrt(Math.max(gDot(v, v, m), 1e-16));
    legs.push([v[0] / norm, v[1] / norm, v[2] / norm, v[3] / norm]);
  }
  const [e0, e1, e2, e3] = legs;
  if (!e0 || !e1 || !e2 || !e3) throw new Error("tetrad construction failed");
  return [e0, e1, e2, e3];
}
