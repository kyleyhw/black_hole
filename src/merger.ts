// Merger-mode dynamics driver (PROJECT_PLAN sec. 10.3, derivations.md sec. 12).
//
// TaylorT4 quasi-circular inspiral integrated at event-selection time (a few
// hundred RK4 steps, precomputed arrays), then a C1 Hermite blend through the
// plunge to the published remnant. The TaylorT4 block is a LINE-PARALLEL
// mirror of validation/pn.py, whose transcription is pinned by the suite
// (0PN chirp-time identity to 3.5e-9, order convergence, GW150914 timing);
// the e2e suite cross-checks this TS mirror against the Python value.
//
// Units: detector-frame geometric units with M_total = 1 (the shader's
// binary mode renders in units of the CURRENT total mass). Physical seconds
// enter only through mTotalSec for f_low conversion and readouts.

import type { BinaryHole, Vec3 } from "./tetrad";

/** GM_sun/c^3 in seconds (mirrors validation/pn.py MSUN_S). */
export const MSUN_S = 4.925490947e-6;

/** PN termination x = (M w_orb)^(2/3) = 1/6 (r = 6M): beyond it the
 * expansion is meaningless and the schematic blend takes over. */
const X_ISCO = 1 / 6;

/** Plunge duration in units of the ISCO orbital period: NR mergers take
 * roughly one orbit from ISCO to peak; 1.5 gives the blend room to be C1
 * without dawdling. Schematic, labeled (derivations.md sec. 12). */
const PLUNGE_ORBITS = 1.5;

const EULER_GAMMA = 0.5772156649015329;

export interface GwEvent {
  readonly name: string;
  readonly date: string;
  readonly m1: number; // source-frame Msun
  readonly m2: number;
  readonly chiEff: number;
  readonly mFinal: number; // source-frame Msun
  readonly aFinal: number;
  readonly dlMpc: number;
  readonly z: number;
  readonly fLow: number; // Hz, detector frame
  readonly audioShiftOct: number;
  readonly note: string;
}

export type MergerPhase = "inspiral" | "plunge" | "ringdown";

export interface MergerState {
  readonly phase: MergerPhase;
  readonly holes: readonly [BinaryHole, BinaryHole];
  /** Barycentric separation in current-total-mass units (0 in ringdown). */
  readonly separation: number;
  /** Quadrupole GW frequency in Hz (detector frame); QNM value in ringdown. */
  readonly fGwHz: number;
  /** Physical seconds until the merger swap (negative after it). */
  readonly tToMergerS: number;
}

/** Leading (1.5PN) aligned spin-orbit parameter (mirrors pn.py). */
function spinOrbitBeta(m1: number, m2: number, chi1: number, chi2: number): number {
  const mt = m1 + m2;
  const nu = (m1 * m2) / (mt * mt);
  return (
    (113 / 12) * ((m1 * m1 * chi1 + m2 * m2 * chi2) / (mt * mt)) +
    (25 / 4) * nu * ((m1 * chi1 + m2 * chi2) / mt)
  );
}

/** TaylorT4 dx/dt at 3.5PN, geometric units M_total = 1 (mirrors pn.py). */
function dxdt(x: number, nu: number, beta: number): number {
  const pi = Math.PI;
  const c = [
    1,
    0,
    -(743 / 336 + (11 / 4) * nu),
    4 * pi - beta,
    34103 / 18144 + (13661 / 2016) * nu + (59 / 18) * nu * nu,
    -(4159 / 672 + (189 / 8) * nu) * pi,
    16447322263 / 139708800 -
      (1712 / 105) * EULER_GAMMA +
      (16 / 3) * pi * pi +
      (-56198689 / 217728 + (451 / 48) * pi * pi) * nu +
      (541 / 896) * nu * nu -
      (5605 / 2592) * nu * nu * nu -
      (856 / 105) * Math.log(16 * x),
    -(4415 / 4032 - (358675 / 6048) * nu - (91495 / 1512) * nu * nu) * pi,
  ];
  let series = 0;
  for (let k = 0; k <= 7; k++) series += c[k]! * Math.pow(x, k / 2);
  return (64 * nu) / 5 * Math.pow(x, 5) * series;
}

/** Hermite smoothstep and its cousins for the C1 plunge blend. */
function smooth01(s: number): number {
  const t = Math.min(Math.max(s, 0), 1);
  return t * t * (3 - 2 * t);
}

export class MergerDriver {
  readonly event: GwEvent;
  /** Detector-frame total mass in seconds: converts geometric time/frequency. */
  readonly mTotalSec: number;
  /** Physical seconds of inspiral from f_low to ISCO (e2e cross-check value). */
  readonly inspiralS: number;
  /** Physical seconds of the (schematic) plunge blend. */
  readonly plungeS: number;

  private readonly nu: number;
  private readonly mFrac1: number; // m1 / M_total (source ratios)
  private readonly mFrac2: number;
  private readonly chi: number;
  private readonly remnantM: number; // M_f / M_total
  private readonly remnantChi: number;
  // Precomputed inspiral arrays (geometric time, M_total = 1).
  private readonly ts: number[] = [];
  private readonly xs: number[] = [];
  private readonly phis: number[] = [];
  private readonly tIscoGeom: number;
  private readonly plungeGeom: number;
  private readonly omegaIsco: number;
  private readonly phiIsco: number;
  private readonly drdtIsco: number; // d(separation)/dt at ISCO, for C1 blend
  private readonly omegaCap: number; // dimensionless M*omega_orb at merger
  private readonly tMergerGeom: number;
  /** (2,2,0) QNM frequency (Hz) and damping time (s) of the remnant. */
  readonly fQnmHz: number;
  readonly qnmTauS: number;
  /** Physical duration of the synthesized chirp (inspiral+plunge+ringdown tail). */
  readonly audioDurationS: number;

  constructor(event: GwEvent) {
    this.event = event;
    const mtSource = event.m1 + event.m2;
    this.mTotalSec = mtSource * (1 + event.z) * MSUN_S;
    this.nu = (event.m1 * event.m2) / (mtSource * mtSource);
    this.mFrac1 = event.m1 / mtSource;
    this.mFrac2 = event.m2 / mtSource;
    this.chi = event.chiEff; // chi1 = chi2 = chi_eff (aligned model, sec. 10.7)
    this.remnantM = event.mFinal / mtSource;
    this.remnantChi = event.aFinal;

    // Integrate TaylorT4 from f_low to ISCO (mirrors pn.py integrate_t4:
    // RK4 on (x, phi), adaptive dt = 0.01 x / (dx/dt)).
    const beta = spinOrbitBeta(event.m1, event.m2, this.chi, this.chi);
    let x = Math.pow(Math.PI * this.mTotalSec * event.fLow, 2 / 3);
    let t = 0;
    let phi = 0;
    this.ts.push(t);
    this.xs.push(x);
    this.phis.push(phi);
    while (x < X_ISCO) {
      const dt = (0.01 * x) / dxdt(x, this.nu, beta);
      const k1x = dxdt(x, this.nu, beta);
      const k1p = Math.pow(x, 1.5);
      const x2 = x + 0.5 * dt * k1x;
      const k2x = dxdt(x2, this.nu, beta);
      const k2p = Math.pow(x2, 1.5);
      const x3 = x + 0.5 * dt * k2x;
      const k3x = dxdt(x3, this.nu, beta);
      const k3p = Math.pow(x3, 1.5);
      const x4 = x + dt * k3x;
      const k4x = dxdt(x4, this.nu, beta);
      const k4p = Math.pow(x4, 1.5);
      x += (dt / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
      phi += (dt / 6) * (k1p + 2 * k2p + 2 * k3p + k4p);
      t += dt;
      this.ts.push(t);
      this.xs.push(x);
      this.phis.push(phi);
    }
    this.tIscoGeom = t;
    this.inspiralS = t * this.mTotalSec;
    this.omegaIsco = Math.pow(X_ISCO, 1.5);
    this.phiIsco = phi;
    this.plungeGeom = (PLUNGE_ORBITS * 2 * Math.PI) / this.omegaIsco;
    this.plungeS = this.plungeGeom * this.mTotalSec;
    // dr/dt = d(1/x)/dt = -xdot/x^2 at ISCO (r = 1/x, Newtonian map).
    this.drdtIsco = -dxdt(X_ISCO, this.nu, beta) / (X_ISCO * X_ISCO);
    this.omegaCap = Math.pow(2.2, -1.5); // Kepler rate at r = 2.2 M (light-ring-ish)
    this.tMergerGeom = this.tIscoGeom + this.plungeGeom;
    // (2,2,0) QNM of the remnant (Berti-Cardoso-Will; derivations.md sec. 13).
    const mfSec = this.remnantM * this.mTotalSec;
    const wR = (1.5251 - 1.1568 * Math.pow(1 - this.remnantChi, 0.1292)) / mfSec;
    const qFac = 0.7 + 1.4187 * Math.pow(1 - this.remnantChi, -0.499);
    this.fQnmHz = wR / (2 * Math.PI);
    this.qnmTauS = (2 * qFac) / wR;
    // Ringdown tail: 8 damping times, capped so distant events stay short.
    this.audioDurationS = this.inspiralS + this.plungeS + Math.min(0.06, 8 * this.qnmTauS);
  }

  /** Total physical duration to the merger swap (inspiral + plunge). */
  get toMergerS(): number {
    return this.inspiralS + this.plungeS;
  }

  /** Barycentric separation at f_low (r = 1/x_0), in total-mass units.
   * Used to frame the camera per event: lighter/lower-f_low systems start
   * wider, so the initial shot must pull back to keep both holes in view. */
  get initialSeparation(): number {
    return 1 / this.xs[0]!;
  }

  /** State at geometric time tGeom in [0, inf); tGeom = 0 is f_low. */
  state(tGeom: number): MergerState {
    if (tGeom < this.tIscoGeom) return this.inspiralState(tGeom);
    const s = (tGeom - this.tIscoGeom) / this.plungeGeom;
    if (s < 1) return this.plungeState(s, tGeom);
    return this.ringdownState(tGeom);
  }

  private inspiralState(tGeom: number): MergerState {
    // Binary search + linear interpolation in the precomputed arrays.
    let lo = 0;
    let hi = this.ts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.ts[mid]! <= tGeom) lo = mid;
      else hi = mid;
    }
    const t0 = this.ts[lo]!;
    const t1 = this.ts[hi]!;
    const w = t1 > t0 ? (tGeom - t0) / (t1 - t0) : 0;
    const x = this.xs[lo]! + w * (this.xs[hi]! - this.xs[lo]!);
    const phi = this.phis[lo]! + w * (this.phis[hi]! - this.phis[lo]!);
    const r = 1 / x; // Newtonian r(omega) map, labeled (derivations sec. 12)
    const omega = Math.pow(x, 1.5);
    return {
      phase: "inspiral",
      holes: this.holesAt(r, phi, omega, this.mFrac1, this.mFrac2, this.chi, this.chi),
      separation: r,
      fGwHz: omega / (Math.PI * this.mTotalSec),
      tToMergerS: this.toMergerS - tGeom * this.mTotalSec,
    };
  }

  private plungeState(s: number, tGeom: number): MergerState {
    // C1 Hermite: r from 6 with the PN slope, to 0 with zero slope; omega
    // ramps to the r ~ 2.2 Kepler rate; masses shed the radiated fraction
    // and spins blend to the remnant's. All schematic, labeled.
    const h00 = (1 + 2 * s) * (1 - s) * (1 - s);
    const h10 = s * (1 - s) * (1 - s);
    const r = h00 * 6 + h10 * this.plungeGeom * this.drdtIsco;
    const w = smooth01(s);
    const omegaCap = Math.pow(2.2, -1.5);
    const omega = this.omegaIsco + (omegaCap - this.omegaIsco) * w;
    const phi = this.phiIsco + (tGeom - this.tIscoGeom) * (this.omegaIsco + omega) * 0.5;
    const mScale = 1 + (this.remnantM - 1) * w; // radiate M_tot -> M_f
    const chi1 = this.chi + (this.remnantChi - this.chi) * w;
    return {
      phase: "plunge",
      holes: this.holesAt(
        Math.max(r, 0),
        phi,
        omega,
        this.mFrac1 * mScale,
        this.mFrac2 * mScale,
        chi1,
        chi1,
      ),
      separation: Math.max(r, 0),
      fGwHz: omega / (Math.PI * this.mTotalSec),
      tToMergerS: this.toMergerS - tGeom * this.mTotalSec,
    };
  }

  private ringdownState(tGeom: number): MergerState {
    // Coincident aligned superposition == exact single Kerr, so the remnant
    // is hole 1 with M2 = 0 — the shader's (validated) single-hole limit.
    const remnant: BinaryHole = {
      mass: this.remnantM,
      a: this.remnantChi * this.remnantM,
      center: [0, 0, 0],
      velocity: [0, 0, 0],
    };
    const ghost: BinaryHole = { mass: 0, a: 0, center: [0, 40, 0], velocity: [0, 0, 0] };
    return {
      phase: "ringdown",
      holes: [remnant, ghost],
      separation: 0,
      fGwHz: this.fQnmHz,
      tToMergerS: this.toMergerS - tGeom * this.mTotalSec,
    };
  }

  /** Linear interpolation of the PN parameter x at geometric time tGeom
   * (clamped to the precomputed inspiral range). */
  private interpX(tGeom: number): number {
    if (tGeom <= 0) return this.xs[0]!;
    let lo = 0;
    let hi = this.ts.length - 1;
    if (tGeom >= this.ts[hi]!) return this.xs[hi]!;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.ts[mid]! <= tGeom) lo = mid;
      else hi = mid;
    }
    const t0 = this.ts[lo]!;
    const t1 = this.ts[hi]!;
    const w = t1 > t0 ? (tGeom - t0) / (t1 - t0) : 0;
    return this.xs[lo]! + w * (this.xs[hi]! - this.xs[lo]!);
  }

  /** Quadrupole GW frequency (Hz) at geometric time tGeom, across all phases
   * (the continuous frequency track the chirp audio integrates). */
  private fGwAt(tGeom: number): number {
    let omega: number;
    if (tGeom < this.tIscoGeom) {
      omega = Math.pow(this.interpX(tGeom), 1.5);
    } else if (tGeom < this.tMergerGeom) {
      const w = smooth01((tGeom - this.tIscoGeom) / this.plungeGeom);
      omega = this.omegaIsco + (this.omegaCap - this.omegaIsco) * w;
    } else {
      return this.fQnmHz;
    }
    return omega / (Math.PI * this.mTotalSec);
  }

  /**
   * Synthesize the true-rate gravitational-wave strain h(t) as a mono audio
   * buffer (derivations.md sec. 12). The GW phase is accumulated from the
   * SAME frequency track that drives the animation, so audio and picture are
   * phase-locked; shiftOct raises every frequency by 2^shiftOct octaves
   * (pitch shift preserving duration, as LIGO's released audio does), applied
   * as a multiplier on the phase so there are no discontinuities. The
   * envelope follows the restricted-PN amplitude f^(2/3) into the merger,
   * then the QNM exponential decay; the whole buffer is peak-normalized.
   */
  synthesizeAudio(sampleRate: number, shiftOct: number): Float32Array {
    const shift = Math.pow(2, shiftOct);
    const n = Math.max(1, Math.ceil(this.audioDurationS * sampleRate));
    const out = new Float32Array(n);
    const env = new Float32Array(n);
    const dt = 1 / sampleRate;
    let psi = 0;
    let mergerEnv = 1e-9;
    for (let i = 0; i < n; i++) {
      const t = i * dt;
      let f: number;
      let e: number;
      if (t < this.toMergerS) {
        f = this.fGwAt(t / this.mTotalSec);
        e = Math.pow(Math.max(f, 1), 2 / 3);
        mergerEnv = e;
      } else {
        f = this.fQnmHz;
        e = mergerEnv * Math.exp(-(t - this.toMergerS) / this.qnmTauS);
      }
      psi += 2 * Math.PI * f * shift * dt;
      out[i] = Math.cos(psi);
      env[i] = e;
    }
    let mx = 0;
    for (let i = 0; i < n; i++) {
      const v = (out[i] as number) * (env[i] as number);
      out[i] = v;
      mx = Math.max(mx, Math.abs(v));
    }
    const g = mx > 0 ? 0.9 / mx : 0;
    for (let i = 0; i < n; i++) out[i] = (out[i] as number) * g;
    return out;
  }

  private holesAt(
    r: number,
    phi: number,
    omega: number,
    m1: number,
    m2: number,
    chi1: number,
    chi2: number,
  ): readonly [BinaryHole, BinaryHole] {
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const r1 = (m2 / (m1 + m2)) * r;
    const r2 = (m1 / (m1 + m2)) * r;
    // Tangential coordinate velocities v_i = r_i * omega (prograde, +z
    // angular momentum); these drive the shader's per-hole boost matrices.
    const tang: Vec3 = [-s, c, 0];
    const holes: [BinaryHole, BinaryHole] = [
      {
        mass: m1,
        a: chi1 * m1,
        center: [r1 * c, r1 * s, 0],
        velocity: [tang[0] * r1 * omega, tang[1] * r1 * omega, 0],
      },
      {
        mass: m2,
        a: chi2 * m2,
        center: [-r2 * c, -r2 * s, 0],
        velocity: [-tang[0] * r2 * omega, -tang[1] * r2 * omega, 0],
      },
    ];
    return holes;
  }
}
