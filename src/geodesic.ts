// CPU float64 mirror of the shader's Hamiltonian RK4 right-hand side, used
// for the free-fall camera (timelike branch: H = -1/2, affine parameter =
// proper time). State is (x_i, p_i) with p_t a per-worldline constant.
// Derivations: docs/derivations.md §3, §8.

import { ksRadius, metricTerms, type Vec3 } from "./tetrad";

// f64 central-difference step (same analysis as the validation suite).
const FD_EPS_SCALE = 1e-5;

function hamiltonian(x: Vec3, p: Vec3, pt: number, a: number): number {
  const m = metricTerms(x, a);
  const lp = m.l[0] * p[0] + m.l[1] * p[1] + m.l[2] * p[2] - pt;
  return 0.5 * (-pt * pt + p[0] * p[0] + p[1] * p[1] + p[2] * p[2] - m.f * lp * lp);
}

function rhs(x: Vec3, p: Vec3, pt: number, a: number): [Vec3, Vec3] {
  const m = metricTerms(x, a);
  const lp = m.l[0] * p[0] + m.l[1] * p[1] + m.l[2] * p[2] - pt;
  const dx: Vec3 = [p[0] - m.f * lp * m.l[0], p[1] - m.f * lp * m.l[1], p[2] - m.f * lp * m.l[2]];
  const eps = FD_EPS_SCALE * Math.max(ksRadius(x, a), 1);
  const inv2e = 0.5 / eps;
  const dp: Vec3 = [
    -(hamiltonian([x[0] + eps, x[1], x[2]], p, pt, a) - hamiltonian([x[0] - eps, x[1], x[2]], p, pt, a)) * inv2e,
    -(hamiltonian([x[0], x[1] + eps, x[2]], p, pt, a) - hamiltonian([x[0], x[1] - eps, x[2]], p, pt, a)) * inv2e,
    -(hamiltonian([x[0], x[1], x[2] + eps], p, pt, a) - hamiltonian([x[0], x[1], x[2] - eps], p, pt, a)) * inv2e,
  ];
  return [dx, dp];
}

function rk4(x: Vec3, p: Vec3, h: number, pt: number, a: number): [Vec3, Vec3] {
  const add = (v: Vec3, w: Vec3, s: number): Vec3 => [v[0] + s * w[0], v[1] + s * w[1], v[2] + s * w[2]];
  const [k1x, k1p] = rhs(x, p, pt, a);
  const [k2x, k2p] = rhs(add(x, k1x, h / 2), add(p, k1p, h / 2), pt, a);
  const [k3x, k3p] = rhs(add(x, k2x, h / 2), add(p, k2p, h / 2), pt, a);
  const [k4x, k4p] = rhs(add(x, k3x, h), add(p, k3p, h), pt, a);
  const c = h / 6;
  const xn: Vec3 = [
    x[0] + c * (k1x[0] + 2 * k2x[0] + 2 * k3x[0] + k4x[0]),
    x[1] + c * (k1x[1] + 2 * k2x[1] + 2 * k3x[1] + k4x[1]),
    x[2] + c * (k1x[2] + 2 * k2x[2] + 2 * k3x[2] + k4x[2]),
  ];
  const pn: Vec3 = [
    p[0] + c * (k1p[0] + 2 * k2p[0] + 2 * k3p[0] + k4p[0]),
    p[1] + c * (k1p[1] + 2 * k2p[1] + 2 * k3p[1] + k4p[1]),
    p[2] + c * (k1p[2] + 2 * k2p[2] + 2 * k3p[2] + k4p[2]),
  ];
  return [xn, pn];
}

/** Free-fall camera worldline: released from rest, integrated in proper
 * time; terminates near the horizon. */
export class FreeFall {
  active = false;
  /** Proper seconds of camera time per wall-clock second. */
  timeScale = 3.0;
  private x: Vec3 = [0, 0, 0];
  private p: Vec3 = [0, 0, 0];
  private pt = -1;
  private a = 0;

  /** Release from rest at pos; requires f < 1 (outside the ergosphere). */
  release(pos: Vec3, a: number): void {
    const m = metricTerms(pos, a);
    if (m.f >= 1) throw new Error("cannot release from rest inside the ergosphere");
    // At rest: u = dt/sqrt(1-f); lowering gives p_t = -sqrt(1-f) (the
    // conserved orbital energy) and p_i = f l_i / sqrt(1-f) — nonzero
    // because of the Kerr-Schild off-diagonal metric (derivations.md §8).
    const s = m.f / Math.sqrt(1 - m.f);
    this.x = pos;
    this.p = [s * m.l[0], s * m.l[1], s * m.l[2]];
    this.pt = -Math.sqrt(1 - m.f);
    this.a = a;
    this.active = true;
  }

  /** Advance by wall dt (s). Returns false when the plunge terminates. */
  update(dt: number): boolean {
    if (!this.active) return false;
    let tau = dt * this.timeScale;
    // Substep at h <= 0.02 M of proper time for accuracy near the hole.
    while (tau > 0) {
      const h = Math.min(0.02, tau);
      [this.x, this.p] = rk4(this.x, this.p, h, this.pt, this.a);
      tau -= h;
      if (ksRadius(this.x, this.a) <= 1.05 * (1 + Math.sqrt(Math.max(1 - this.a * this.a, 0)))) {
        this.active = false;
        return false;
      }
    }
    return true;
  }

  position(): Vec3 {
    return this.x;
  }

  /** Contravariant 4-velocity u^mu = g^{mu nu} p_nu of the falling camera. */
  fourVelocity(): [number, number, number, number] {
    const m = metricTerms(this.x, this.a);
    const lp = -this.pt + m.l[0] * this.p[0] + m.l[1] * this.p[1] + m.l[2] * this.p[2];
    return [
      -this.pt + m.f * lp,
      this.p[0] - m.f * lp * m.l[0],
      this.p[1] - m.f * lp * m.l[1],
      this.p[2] - m.f * lp * m.l[2],
    ];
  }
}
