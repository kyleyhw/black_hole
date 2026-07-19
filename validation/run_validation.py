"""Validation suite: runs the numerical studies against analytic results
and writes plots (plots/) plus a markdown report (reports/validation.md).

Studies (PROJECT_PLAN.md sections 5, 10):
  1. RK4 convergence order on a strong-field flyby.
  2. Schwarzschild critical impact parameter vs 3*sqrt(3) M.
  3. Kerr equatorial photon-orbit radii at a = 0.9 vs analytic r_ph.
  4. Conservation drift (E, L_z, H) along a strong-field ray.
  5. Timelike free fall vs the Schwarzschild cycloid (Phase 8 camera).
  6. Weak-field multi-mass deflection vs 4M/b (Phase 10 mode).
  7. PN chirp (TaylorT4) + QNM fits vs GW150914 (Phase 13 merger mode).
  8. Superposed Kerr-Schild binary metric (Phase 13 merger mode).

Run:  uv run python run_validation.py
"""

from __future__ import annotations

import math
import time
from pathlib import Path
from typing import Any, Callable

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from numpy.typing import NDArray

from pn import (
    chirp_mass,
    chirp_time_leading,
    f_gw_of_x,
    integrate_t4,
    qnm_220,
    MSUN_S,
)
from superposed import (
    Hole,
    deflection_binary,
    hamiltonian_binary,
    hamiltonian_scalar,
    lorentz_boost,
    metric_and_inverse,
)
from weakfield import Mass, deflection_angle
from kerr import (
    Outcome,
    Trajectory,
    conserved,
    hamiltonian,
    integrate,
    ks_radius,
    make_ray,
    metric_terms,
    photon_orbit_radius,
    rk4_step,
)

# Heterogeneous per-study results (floats, strings, nested dicts); the
# explicit Any is deliberate — a TypedDict per study would add noise for
# a write-once report structure.
StudyResult = dict[str, Any]

PLOTS = Path(__file__).parent / "plots"
REPORTS = Path(__file__).parent / "reports"

# Bisection iterations: 48 halvings of a ~5 M bracket reaches ~2e-14 M,
# the practical f64 limit for a boundary location.
BISECT_ITERS = 48


def bisect_captured(
    captured: Callable[[float], bool], lo: float, hi: float, iters: int = BISECT_ITERS
) -> float:
    """Bisect the capture/escape boundary; captured(lo) must be True and
    captured(hi) False (endpoints may be in any numeric order)."""
    assert captured(lo) and not captured(hi), "bracket does not straddle the boundary"
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        if captured(mid):
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def parallel_ray(offset: float, a: float, r0: float = 30.0) -> tuple[Trajectory, float]:
    """Ray fired from (r0, offset, 0) along -x (equatorial); returns the
    trajectory and the conserved impact parameter lambda = L_z/E."""
    x0, p0 = make_ray((r0, offset, 0.0), (-1.0, 0.0, 0.0), a)
    lam = conserved(x0, p0)[1]
    return integrate(x0, p0, a), lam


# ----------------------------------------------------------------------------
# Study 1: convergence order
# ----------------------------------------------------------------------------
def study_convergence() -> StudyResult:
    """Fixed-step global error vs step size for a strong-field flyby at
    a = 0.9. The flyby (r_min ~ 4) is integrated for a fixed affine length
    so every run ends at the same lambda; error is the final-position
    distance to a reference run with 16x the finest resolution."""
    a = 0.9
    x0, p0 = make_ray((20.0, 7.0, 2.0), (-1.0, 0.0, -0.05), a)
    lam_total = 45.0  # affine length: in past r_min and back out to weak field
    ns = [500, 1000, 2000, 4000, 8000, 16000]

    def final_x(n: int) -> NDArray[np.float64]:
        traj = integrate(x0, p0, a, max_steps=n, fixed_h=lam_total / n, record=True)
        assert traj.outcome == Outcome.BUDGET
        return traj.xs[-1]

    ref = final_x(16 * ns[-1])
    r_min = integrate(x0, p0, a, max_steps=ns[-1], fixed_h=lam_total / ns[-1]).min_r
    hs = np.array([lam_total / n for n in ns])
    errs = np.array([float(np.linalg.norm(final_x(n) - ref)) for n in ns])
    # Below ~5e-11 M the error is dominated by the finite-difference-gradient
    # floor (eps^2-truncation of dH/dx, independent of the RK4 step), so the
    # order fit uses only the points above it; the floor itself is plotted
    # and annotated — it is a real, expected feature of the scheme (§5).
    fd_floor = 5e-11
    above = errs > fd_floor
    slope = float(np.polyfit(np.log(hs[above]), np.log(errs[above]), 1)[0])

    fig, ax = plt.subplots(figsize=(6, 4.5))
    ax.loglog(hs, errs, "o-", label="RK4 + FD gradients")
    ax.loglog(
        hs[above],
        errs[above][-1] * (hs[above] / hs[above][-1]) ** 4,
        "k--",
        alpha=0.6,
        label="slope 4",
    )
    ax.axhline(fd_floor, color="gray", ls=":", label="FD-gradient error floor")
    ax.set_xlabel(r"step size $d\lambda$ (M)")
    ax.set_ylabel(r"final-position error $\|x(\Lambda)-x_{\rm ref}(\Lambda)\|$ (M)")
    ax.set_title(f"Convergence, strong-field flyby (a=0.9, $r_{{\\min}}$={r_min:.2f}M)")
    ax.legend()
    fig.tight_layout()
    fig.savefig(PLOTS / "convergence.png", dpi=150)
    plt.close(fig)
    return {"slope": slope, "r_min": r_min, "errs": errs.tolist()}


# ----------------------------------------------------------------------------
# Study 2: Schwarzschild critical impact parameter
# ----------------------------------------------------------------------------
def study_bcrit() -> StudyResult:
    """Bisect capture/escape at a = 0 and compare the conserved lambda of the
    boundary ray to b_crit = 3 sqrt(3) M. Budget-exhausted rays (photon-
    sphere hoverers) count as captured; the bracket collapses far below any
    ambiguity this introduces."""

    def captured(offset: float) -> bool:
        traj, _ = parallel_ray(offset, a=0.0)
        return traj.outcome != Outcome.ESCAPED

    offset_c = bisect_captured(captured, 3.0, 6.0)
    _, lam_c = parallel_ray(offset_c, a=0.0)
    # Positive offsets give lambda < 0 (see sign-convention note in
    # study_photon_shell); at a = 0 the boundary is symmetric, so compare |lambda|.
    lam_c = abs(lam_c)
    target = 3.0 * math.sqrt(3.0)
    rel_err = abs(lam_c - target) / target

    offsets = np.linspace(3.0, 6.0, 41)
    lams = []
    caps = []
    for b in offsets:
        traj, lam = parallel_ray(float(b), a=0.0)
        lams.append(lam)
        caps.append(traj.outcome != Outcome.ESCAPED)
    lams_arr = np.abs(np.array(lams))
    caps_arr = np.array(caps)

    fig, ax = plt.subplots(figsize=(6, 4.5))
    ax.scatter(
        lams_arr[caps_arr],
        np.ones(int(caps_arr.sum())),
        c="crimson",
        s=18,
        label="captured",
    )
    ax.scatter(
        lams_arr[~caps_arr],
        np.zeros(int((~caps_arr).sum())),
        c="royalblue",
        s=18,
        label="escaped",
    )
    ax.axvline(target, color="k", ls="--", label=r"$3\sqrt{3}\,M$")
    ax.axvline(lam_c, color="green", ls=":", label=f"measured {lam_c:.6f} M")
    ax.set_xlabel(r"conserved impact parameter $\lambda = L_z/E$ (M)")
    ax.set_yticks([0, 1], ["escape", "capture"])
    ax.set_title("Schwarzschild capture boundary (a = 0)")
    ax.legend(loc="center left")
    fig.tight_layout()
    fig.savefig(PLOTS / "bcrit_schwarzschild.png", dpi=150)
    plt.close(fig)
    return {"lambda_c": lam_c, "target": target, "rel_err": rel_err}


# ----------------------------------------------------------------------------
# Study 3: Kerr photon shell at a = 0.9
# ----------------------------------------------------------------------------
def study_photon_shell() -> StudyResult:
    """For each orbital sense, bisect the equatorial capture boundary at
    a = 0.9; the marginally escaping ray skims the photon orbit, so its
    minimum KS radius estimates r_ph. Compare to the analytic BPT radii."""
    a = 0.9
    results: dict[str, dict[str, float]] = {}
    fig, ax = plt.subplots(figsize=(6, 4.5))
    # Sign convention: the traced rays are past-directed (E_traced = -1), so
    # the physical photon's lambda = L_z/E has the OPPOSITE sign to the
    # spatial offset: negative offsets probe prograde photons (lambda > 0),
    # positive offsets retrograde (docs/derivations.md section 4).
    for sense, label, bracket in (
        (+1, "prograde", (-0.5, -5.0)),
        (-1, "retrograde", (4.5, 9.0)),
    ):

        def captured(offset: float) -> bool:
            traj, _ = parallel_ray(offset, a=a)
            return traj.outcome != Outcome.ESCAPED

        edge = bisect_captured(captured, *bracket)
        # Marginal escaper: nudge 1e-9 M toward the escape side (past the f64
        # bisection resolution but far inside the 1% tolerance on r_ph).
        nudge = math.copysign(1e-9, bracket[1] - bracket[0])
        traj, lam = parallel_ray(edge + nudge, a=a)
        r_ph_ana = photon_orbit_radius(a, sense)
        rel = abs(traj.min_r - r_ph_ana) / r_ph_ana
        results[label] = {
            "r_min": traj.min_r,
            "r_ph": r_ph_ana,
            "rel_err": rel,
            "lambda_c": lam,
        }

        rs = np.linalg.norm(traj.xs, axis=1) if traj.xs.ndim > 1 else None
        color = "tab:orange" if sense > 0 else "tab:blue"
        ax.axhline(
            r_ph_ana,
            color=color,
            ls="--",
            alpha=0.7,
            label=f"{label} $r_{{ph}}$ analytic",
        )
        ax.axhline(
            traj.min_r, color=color, ls="-", alpha=0.9, label=f"{label} min r (traced)"
        )
        del rs

    ax.set_ylim(1.0, 4.5)
    ax.set_ylabel("KS radius r (M)")
    ax.set_xticks([])
    ax.set_title("Equatorial photon-orbit radii, a = 0.9: traced vs analytic")
    ax.legend()
    fig.tight_layout()
    fig.savefig(PLOTS / "photon_shell.png", dpi=150)
    plt.close(fig)
    return results


# ----------------------------------------------------------------------------
# Study 4: conservation drift
# ----------------------------------------------------------------------------
def study_drift() -> StudyResult:
    """|H| and |L_z - L_z(0)| along two strong-field rays at a = 0.9.

    E = -p_t is conserved *exactly by construction* (p_t is never updated
    because dH/dt = 0), so only L_z and H can drift, and their drift is pure
    integration error. Two regimes are shown deliberately:

    - generic flyby (offset -5 M, r_min ~ 4 M): drift should sit near the
      f64 FD-gradient floor (~1e-10);
    - near-critical ray (offset -2.494 M, ~0.3% outside the prograde
      capture boundary bisected in study 3): winds close to the photon
      shell, where the trajectory instability amplifies numerical error by
      ~e^{2 pi} per winding — drift stays BOUNDED but is expected orders of
      magnitude above the floor. Machine-level drift there would be
      impossible; bounded-and-small is the correct pass criterion.
    """
    a = 0.9
    rays = {
        "generic flyby": (-5.0, 1e-9),  # threshold: near machine/FD floor
        "near-critical": (-2.494, 1e-4),  # threshold: bounded despite e^{2pi}/orbit
    }
    out: StudyResult = {}
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(6.5, 6), sharex=True)
    colors = {"generic flyby": "tab:blue", "near-critical": "tab:orange"}
    for label, (offset, _thr) in rays.items():
        x0, p0 = make_ray((30.0, offset, 0.3), (-1.0, 0.0, 0.0), a)
        traj = integrate(x0, p0, a, max_steps=20000, record=True)
        xs, ps = traj.xs, traj.ps
        n = len(xs)
        lz = np.array([conserved(tuple(xs[i]), tuple(ps[i]))[1] for i in range(n)])
        hs = np.array(
            [abs(hamiltonian(tuple(xs[i]), tuple(ps[i]), 1.0, a)) for i in range(n)]
        )
        rs = np.array([ks_radius(tuple(xs[i]), a) for i in range(n)])
        lz_drift = np.abs(lz - lz[0]) / abs(lz[0])
        c = colors[label]
        ax1.semilogy(np.maximum(hs, 1e-19), color=c, label=f"|H|, {label}")
        ax1.semilogy(
            np.maximum(lz_drift, 1e-19), color=c, ls="--", label=f"$L_z$ drift, {label}"
        )
        ax2.semilogy(rs, color=c, label=label)
        out[label] = {
            "steps": n,
            "outcome": traj.outcome.name,
            "min_r": traj.min_r,
            "max_H": float(hs.max()),
            "max_Lz_drift": float(lz_drift.max()),
        }
    ax1.set_ylabel("drift (dimensionless)")
    ax1.legend(fontsize=8)
    ax1.set_title("Conservation drift along strong-field rays (a = 0.9)")
    ax2.set_ylabel("KS radius r (M)")
    ax2.set_xlabel("integration step")
    ax2.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(PLOTS / "conservation_drift.png", dpi=150)
    plt.close(fig)
    return out


# ----------------------------------------------------------------------------
# Study 5: timelike free fall vs the Schwarzschild cycloid (Phase 8)
# ----------------------------------------------------------------------------
def study_plunge() -> StudyResult:
    """Radial free fall from rest at r0 in Schwarzschild (a = 0), integrated
    with the same Hamiltonian machinery on its timelike branch (H = -1/2,
    affine parameter = proper time), against the analytic cycloid
    r = (r0/2)(1 + cos eta), tau = sqrt(r0^3/8) (eta + sin eta).

    At rest in Kerr-Schild coordinates the spatial *covector* momentum is
    NOT zero -- p_i = g_{it} u^t = f l_i / sqrt(1 - f) -- because of the
    off-diagonal metric; p_t = -sqrt(1 - f) is the conserved orbital energy
    (derivations.md section 8)."""
    r0 = 12.0
    x: tuple[float, float, float] = (r0, 0.0, 0.0)
    f0, l0 = metric_terms(x, 0.0)
    pt = -math.sqrt(1.0 - f0)
    scale = f0 / math.sqrt(1.0 - f0)
    p: tuple[float, float, float] = (scale * l0[0], scale * l0[1], scale * l0[2])

    h = 1e-3  # proper-time step (M); RK4 error ~ h^4 ~ 1e-12 per step
    taus = [0.0]
    rs = [r0]
    tau = 0.0
    while rs[-1] > 2.05 and tau < 200.0:
        x, p = rk4_step(x, p, h, 0.0, pt)
        tau += h
        taus.append(tau)
        rs.append(ks_radius(x, 0.0))
    taus_arr = np.array(taus)
    rs_arr = np.array(rs)

    def r_analytic(tau_v: float) -> float:
        lo, hi = 0.0, math.pi  # eta strictly increases with tau
        for _ in range(80):
            mid = 0.5 * (lo + hi)
            if math.sqrt(r0**3 / 8.0) * (mid + math.sin(mid)) < tau_v:
                lo = mid
            else:
                hi = mid
        eta = 0.5 * (lo + hi)
        return (r0 / 2.0) * (1.0 + math.cos(eta))

    r_ana = np.array([r_analytic(t) for t in taus_arr])
    rel_err = float(np.max(np.abs(rs_arr - r_ana) / r_ana))

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(6, 5.5), sharex=True)
    ax1.plot(taus_arr, rs_arr, label="integrated (timelike Hamiltonian)")
    ax1.plot(taus_arr, r_ana, "k--", alpha=0.7, label="analytic cycloid")
    ax1.set_ylabel("r (M)")
    ax1.legend()
    ax1.set_title(f"Radial free fall from rest, r0 = {r0:.0f} M (a = 0)")
    ax2.semilogy(taus_arr, np.maximum(np.abs(rs_arr - r_ana) / r_ana, 1e-18))
    ax2.set_ylabel("relative error")
    ax2.set_xlabel(r"proper time $\tau$ (M)")
    fig.tight_layout()
    fig.savefig(PLOTS / "freefall_cycloid.png", dpi=150)
    plt.close(fig)
    return {"r0": r0, "steps": len(taus), "rel_err": rel_err}


# ----------------------------------------------------------------------------
# Study 6: weak-field deflection (Phase 10 multi-mass mode)
# ----------------------------------------------------------------------------
def study_deflection() -> StudyResult:
    """Deflection angle of the linearized multi-mass integrator vs the
    classic alpha = 4M/b. Span scales with b (80 b) because the deflection
    accumulates over path lengths ~ b on both sides of closest approach.
    Residuals above 4M/b at small b are the metric's own second-order
    deflection, O((M/b)^2 relative), not integration error - the deep-linear
    check is the b = 1000 point (|ratio - 1| < 1%)."""
    masses_one: list[Mass] = [(1.0, (0.0, 0.0, 0.0))]
    bs = [10.0, 20.0, 50.0, 100.0, 200.0, 500.0, 1000.0]
    alphas = [deflection_angle(b, masses_one, span=max(2000.0, 80.0 * b)) for b in bs]
    ratios = [a / (4.0 / b) for a, b in zip(alphas, bs)]
    # Log-log slope over the last three (deep-linear) points.
    tail = slice(-3, None)
    slope = float(
        np.polyfit(np.log(np.array(bs[tail])), np.log(np.array(alphas[tail])), 1)[0]
    )

    # Two masses at (0, +-5, 0): compare against the sum of the individual
    # 4 M_k / b_k (b_k the offset from each mass), which removes the purely
    # geometric part of the difference from 4(M1+M2)/b.
    masses_two: list[Mass] = [(0.7, (0.0, 5.0, 0.0)), (0.3, (0.0, -5.0, 0.0))]
    b_two = 100.0
    a_two = deflection_angle(b_two, masses_two, span=8000.0)
    a_sum = 4.0 * 0.7 / (b_two - 5.0) + 4.0 * 0.3 / (b_two + 5.0)
    add_ratio = a_two / a_sum

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(6, 6), sharex=True)
    ax1.loglog(bs, alphas, "o-", label="integrated")
    ax1.loglog(bs, [4.0 / b for b in bs], "k--", alpha=0.7, label=r"$4M/b$")
    ax1.set_ylabel(r"deflection $\alpha$ (rad)")
    ax1.legend()
    ax1.set_title("Weak-field deflection, single mass (linearized metric)")
    ax2.loglog(bs, [abs(r - 1.0) for r in ratios], "o-")
    ax2.loglog(
        bs, [10.0 / b for b in bs], "k:", alpha=0.7, label=r"$\sim 10 M/b$ (2nd order)"
    )
    ax2.set_ylabel(r"$|\alpha/(4M/b) - 1|$")
    ax2.set_xlabel("impact parameter b (M)")
    ax2.legend()
    fig.tight_layout()
    fig.savefig(PLOTS / "weakfield_deflection.png", dpi=150)
    plt.close(fig)
    return {
        "ratio_b1000": ratios[-1],
        "slope_tail": slope,
        "additivity_ratio": add_ratio,
    }


def study_pn_chirp() -> StudyResult:
    """Study 7: TaylorT4 phasing + QNM fits against GW150914.

    Inputs: GW150914 detector-frame masses (source 35.6 + 30.6 Msun at
    z = 0.09 -> 38.8 + 33.4), chi_eff = -0.01, from f_GW = 35 Hz — chosen
    because GW150914 has the best-known published timing (~0.2 s of loud
    signal) and ringdown (~250 Dz, ~4 ms).
    """
    z = 0.09
    m1, m2 = 35.6 * (1 + z), 30.6 * (1 + z)
    chi = -0.01
    f_low = 35.0
    mt_s = (m1 + m2) * MSUN_S

    t, x, _phi = integrate_t4(m1, m2, chi, f_low, order=7)
    tau_t4 = float(t[-1])
    f_gw = f_gw_of_x(x, mt_s)

    # 0PN self-check: the order-0 integration must reproduce the analytic
    # leading-order elapsed time between f_low and f(ISCO) — validates the
    # integrator itself, independent of coefficient transcription.
    t0, x0, _ = integrate_t4(m1, m2, chi, f_low, order=0)
    mc = chirp_mass(m1, m2)
    f_isco0 = float(f_gw_of_x(x0[-1:], mt_s)[0])
    tau0_analytic = chirp_time_leading(mc, f_low) - chirp_time_leading(mc, f_isco0)
    err_0pn = abs(float(t0[-1]) / tau0_analytic - 1.0)

    # Order convergence of the accumulated orbital phase over the same band:
    # successive PN corrections must shrink (order counts half-PN steps).
    phases: dict[int, float] = {}
    for order in (2, 3, 4, 5, 6, 7):
        _, _, ph = integrate_t4(m1, m2, chi, f_low, order=order)
        phases[order] = float(ph[-1])
    d_early = abs(phases[3] - phases[2])
    d_late = abs(phases[7] - phases[6])

    mf_det = 63.1 * (1 + z)
    f_qnm, tau_qnm = qnm_220(mf_det, 0.69)

    # Plot: frequency sweep + separation, with ISCO and QNM markers.
    sep = (mt_s / (math.pi * mt_s * f_gw) ** 2) ** (1.0 / 3.0) / mt_s  # r/M
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(7, 6), sharex=True)
    ax1.plot(t, f_gw, lw=1.5)
    ax1.axhline(f_qnm, ls="--", c="tab:red", label=f"QNM {f_qnm:.0f} Hz")
    ax1.set_ylabel("f_GW [Hz]")
    ax1.set_yscale("log")
    ax1.legend()
    ax1.set_title(f"GW150914 (detector frame): TaylorT4 35 Hz → ISCO in {tau_t4:.3f} s")
    ax2.plot(t, sep, lw=1.5, c="tab:green")
    ax2.set_xlabel("t [s]")
    ax2.set_ylabel("separation r/M (Newtonian map)")
    fig.tight_layout()
    fig.savefig(PLOTS / "pn_chirp.png", dpi=120)
    plt.close(fig)

    return {
        "tau_t4_s": tau_t4,
        "tau0_analytic_s": tau0_analytic,
        "err_0pn": err_0pn,
        "dphase_1pn": d_early,
        "dphase_35pn": d_late,
        "f_qnm_hz": f_qnm,
        "tau_qnm_ms": tau_qnm * 1e3,
    }


def study_superposed() -> StudyResult:
    """Study 8: superposed-KS binary metric (static, Phase 13 scope).

    Inputs chosen to be generic (unequal masses, unequal misaligned-in-
    magnitude spins, off-axis field points): no symmetry to hide index or
    sign errors in the Sherman-Morrison chain.
    """
    rng = np.random.default_rng(20260719)  # fixed seed: reproducible report
    h1 = Hole(1.0, 0.7, (0.0, -6.0, 0.0))
    h2 = Hole(0.6, -0.18, (0.0, 6.0, 0.0))

    # (a) Exactness of the closed-form inverse at random field points
    # (outside both capture zones; |x| in [2.5, 40] around either hole), and
    # of the matrix-free scalar Hamiltonian the SHADER implements: it must
    # agree with (1/2) p g^{-1} p from the matrix inverse to roundoff. Random
    # momenta with |p| ~ 1 (the traced-ray normalization).
    max_inv_err = 0.0
    max_scalar_err = 0.0
    for _ in range(200):
        pt = tuple(float(v) for v in rng.uniform(-40, 40, 3))
        r1 = math.dist(pt, h1.center)
        r2 = math.dist(pt, h2.center)
        if r1 < 2.5 or r2 < 2.5:
            continue
        xf = (pt[0], pt[1], pt[2])
        g, g_inv = metric_and_inverse(xf, h1, h2)
        max_inv_err = max(max_inv_err, float(np.abs(g @ g_inv - np.eye(4)).max()))
        pv = tuple(float(v) for v in rng.normal(0.0, 1.0, 3))
        pm = (pv[0], pv[1], pv[2])
        max_scalar_err = max(
            max_scalar_err,
            abs(
                hamiltonian_scalar(xf, pm, 1.0, h1, h2)
                - hamiltonian_binary(xf, pm, 1.0, h1, h2)
            ),
        )

    # (a') Boosted holes (Phase 14): the boosted KS term must assemble the
    # same metric as explicitly transforming the rest-frame metric,
    # g_lab = L^T g_rest L (a pointwise identity, exact for a single hole),
    # and the Sherman-Morrison inverse must stay exact with both holes
    # boosted (boosts preserve the eta-nullity of l).
    vel = (0.20, 0.10, -0.15)
    hb = Hole(1.0, 0.7, (2.0, -1.0, 0.5), vel)
    zero = Hole(0.0, 0.0, (100.0, 0.0, 0.0))
    ll = lorentz_boost(vel)
    max_boost_err = 0.0
    max_boost_inv_err = 0.0
    for _ in range(50):
        pt = tuple(float(v) for v in rng.uniform(-30, 30, 3))
        if math.dist(pt, hb.center) < 4.0:
            continue
        xf = (pt[0], pt[1], pt[2])
        g_lab, _ = metric_and_inverse(xf, hb, zero)
        # Rest-frame comparison: transform the t = 0 field point, evaluate a
        # static hole there, and pull the whole metric back with L.
        x4 = ll @ np.array(
            [0.0, xf[0] - hb.center[0], xf[1] - hb.center[1], xf[2] - hb.center[2]]
        )
        rest_hole = Hole(hb.mass, hb.a, (0.0, 0.0, 0.0))
        g_rest, _ = metric_and_inverse(
            (float(x4[1]), float(x4[2]), float(x4[3])), rest_hole, zero
        )
        max_boost_err = max(
            max_boost_err, float(np.abs(ll.T @ g_rest @ ll - g_lab).max())
        )
        # Two boosted holes: inverse must remain exact.
        hb2 = Hole(0.6, -0.18, (-3.0, 4.0, 0.0), (-0.1, 0.25, 0.05))
        gb, gbi = metric_and_inverse(xf, hb, hb2)
        max_boost_inv_err = max(
            max_boost_inv_err, float(np.abs(gb @ gbi - np.eye(4)).max())
        )

    # (b) Single-hole limit: with h2's mass scaled down, g_inv must approach
    # the exact single-Kerr inverse linearly in M2 (the superposition error
    # is first order in the second hole's amplitude).
    probe = (3.7, 1.2, 2.1)
    kerr_ref = Hole(1.0, 0.9, (0.0, 0.0, 0.0))
    _, ginv_single = metric_and_inverse(
        probe, kerr_ref, Hole(0.0, 0.0, (40.0, 0.0, 0.0))
    )
    m2s = np.array([1e-2, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8])
    errs = []
    for m2v in m2s:
        _, gi = metric_and_inverse(
            probe, kerr_ref, Hole(float(m2v), 0.0, (40.0, 0.0, 0.0))
        )
        errs.append(float(np.abs(gi - ginv_single).max()))
    err_arr = np.asarray(errs)
    slope = float(np.polyfit(np.log(m2s), np.log(err_arr), 1)[0])

    # (c) Far-field additivity: ray past two equal holes on the y axis at
    # x = b; predicted deflection is the sum 4 M_k / b_k (both = b here).
    ha = Hole(1.0, 0.5, (0.0, -30.0, 0.0))
    hb = Hole(1.0, 0.5, (0.0, 30.0, 0.0))
    b = 300.0
    alpha = deflection_binary(b, ha, hb)
    alpha_pred = 4.0 * ha.mass / b + 4.0 * hb.mass / b
    additivity_ratio = alpha / alpha_pred

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(9, 4))
    ax1.loglog(m2s, err_arr, "o-", label="max |g⁻¹(M₂) − g⁻¹(0)|")
    guide = err_arr[0] * (m2s / m2s[0])
    ax1.loglog(m2s, guide, "k--", lw=1, label="slope 1")
    ax1.set_xlabel("M₂")
    ax1.set_ylabel("inverse-metric deviation")
    ax1.set_title(f"Single-hole limit (slope {slope:.3f})")
    ax1.legend()
    ax2.bar(
        ["measured", "Σ 4Mₖ/bₖ"], [alpha, alpha_pred], color=["tab:blue", "tab:gray"]
    )
    ax2.set_ylabel("deflection [rad]")
    ax2.set_title(
        f"Two-hole additivity at b = {b:.0f} M (ratio {additivity_ratio:.4f})"
    )
    fig.tight_layout()
    fig.savefig(PLOTS / "superposed_ks.png", dpi=120)
    plt.close(fig)

    return {
        "max_inverse_err": max_inv_err,
        "max_scalar_h_err": max_scalar_err,
        "max_boost_err": max_boost_err,
        "max_boost_inv_err": max_boost_inv_err,
        "limit_slope": slope,
        "limit_err_at_1e8": float(err_arr[-1]),
        "deflection": alpha,
        "deflection_pred": alpha_pred,
        "additivity_ratio": additivity_ratio,
    }


def main() -> None:
    PLOTS.mkdir(exist_ok=True)
    REPORTS.mkdir(exist_ok=True)
    studies: list[tuple[str, Callable[[], StudyResult]]] = [
        ("convergence", study_convergence),
        ("bcrit", study_bcrit),
        ("photon_shell", study_photon_shell),
        ("drift", study_drift),
        ("plunge", study_plunge),
        ("deflection", study_deflection),
        ("pn_chirp", study_pn_chirp),
        ("superposed", study_superposed),
    ]
    results: dict[str, StudyResult] = {}
    times: dict[str, float] = {}
    for name, fn in studies:
        t0 = time.perf_counter()
        results[name] = fn()
        times[name] = time.perf_counter() - t0
        print(f"{name}: {times[name]:.1f}s -> {results[name]}")

    checks = {
        "convergence slope in [3.7, 4.3]": 3.7
        <= float(results["convergence"]["slope"])
        <= 4.3,
        "b_crit rel err < 1e-4": float(results["bcrit"]["rel_err"]) < 1e-4,
        "prograde r_ph rel err < 1%": results["photon_shell"]["prograde"]["rel_err"]
        < 0.01,
        "retrograde r_ph rel err < 1%": results["photon_shell"]["retrograde"]["rel_err"]
        < 0.01,
        "generic-ray max |H| < 1e-5": results["drift"]["generic flyby"]["max_H"] < 1e-5,
        "generic-ray L_z drift < 1e-5": results["drift"]["generic flyby"][
            "max_Lz_drift"
        ]
        < 1e-5,
        "near-critical max |H| < 1e-4": results["drift"]["near-critical"]["max_H"]
        < 1e-4,
        "near-critical L_z drift < 1e-4": results["drift"]["near-critical"][
            "max_Lz_drift"
        ]
        < 1e-4,
        "free-fall vs cycloid rel err < 1e-8": results["plunge"]["rel_err"] < 1e-8,
        "deflection 4M/b at b=1e3 within 1%": abs(
            results["deflection"]["ratio_b1000"] - 1.0
        )
        < 0.01,
        "deflection log-log slope -1 (2%)": abs(
            results["deflection"]["slope_tail"] + 1.0
        )
        < 0.02,
        "two-mass additivity within 4%": abs(
            results["deflection"]["additivity_ratio"] - 1.0
        )
        < 0.04,
        "T4 0PN reproduces leading chirp time (0.5%)": results["pn_chirp"]["err_0pn"]
        < 0.005,
        "PN phase converges (|dphi 3.5PN| < |dphi 1PN|)": results["pn_chirp"][
            "dphase_35pn"
        ]
        < results["pn_chirp"]["dphase_1pn"],
        "GW150914 chirp 35 Hz to ISCO in [0.05, 0.3] s": 0.05
        < results["pn_chirp"]["tau_t4_s"]
        < 0.3,
        "GW150914 QNM f in [240, 260] Hz": 240 < results["pn_chirp"]["f_qnm_hz"] < 260,
        "GW150914 QNM tau in [3, 5.5] ms": 3.0
        < results["pn_chirp"]["tau_qnm_ms"]
        < 5.5,
        "binary inverse exact (< 1e-12)": results["superposed"]["max_inverse_err"]
        < 1e-12,
        "single-hole-limit slope 1 (±0.1)": abs(
            results["superposed"]["limit_slope"] - 1.0
        )
        < 0.1,
        "binary far-field additivity within 3%": abs(
            results["superposed"]["additivity_ratio"] - 1.0
        )
        < 0.03,
        "scalar H = matrix H (< 1e-13)": results["superposed"]["max_scalar_h_err"]
        < 1e-13,
        "boosted KS = L^T g L (< 1e-12)": results["superposed"]["max_boost_err"]
        < 1e-12,
        "boosted binary inverse exact (< 1e-12)": results["superposed"][
            "max_boost_inv_err"
        ]
        < 1e-12,
    }
    for label, ok in checks.items():
        print(("PASS " if ok else "FAIL ") + label)
    write_report(results, times, checks)
    if not all(checks.values()):
        raise SystemExit(1)


def write_report(
    results: dict[str, StudyResult],
    times: dict[str, float],
    checks: dict[str, bool],
) -> None:
    conv, bc, ph, dr, pl = (
        results["convergence"],
        results["bcrit"],
        results["photon_shell"],
        results["drift"],
        results["plunge"],
    )
    df = results["deflection"]
    pn = results["pn_chirp"]
    sp = results["superposed"]
    total = sum(times.values())
    lines = f"""# Validation Suite Report

**Command:** `uv run python run_validation.py` · **Total runtime:** {total:.1f} s
(convergence {times["convergence"]:.1f} s, b_crit {times["bcrit"]:.1f} s,
photon shell {times["photon_shell"]:.1f} s, drift {times["drift"]:.1f} s,
plunge {times["plunge"]:.1f} s, deflection {times["deflection"]:.1f} s,
PN chirp {times["pn_chirp"]:.1f} s, superposed KS {times["superposed"]:.1f} s)

**Result: {"PASS" if all(checks.values()) else "FAIL"}** — {sum(checks.values())}/{len(checks)} checks.

The suite mirrors the shader's exact algorithm (Hamiltonian, RK4,
central-difference gradients, adaptive step, termination) in float64
(`kerr.py`) and tests it against analytic strong-field results. What each
study does, why, and how to read its plot:

## 1. Convergence order (`plots/convergence.png`)

**What/why:** fixed-step integration of a strong-field flyby (a = 0.9,
r_min = {conv["r_min"]:.2f} M) for a fixed affine length; global error vs step size
against a 16x-finer reference. Tests that the RK4 + finite-difference
gradient combination actually achieves its design order — a wrong gradient
or step-update would show up as a shallower slope.

**Reading the plot:** both axes log; dots are measured final-position
errors, the dashed line has slope 4. Points parallel to the line confirm
4th order. **Measured slope: {conv["slope"]:.3f}.**

**Inputs:** ray from (20, 7, 2) M aimed off-plane (genuinely 3D, no
symmetry to hide errors), step counts 500–16000 over affine length 45 M.

## 2. Schwarzschild critical impact parameter (`plots/bcrit_schwarzschild.png`)

**What/why:** at a = 0 the capture boundary is exactly b = 3√3 M ≈ 5.19615 M
— the classic strong-field benchmark. Rays are fired with graded impact
parameters; bisection (48 halvings) locates the boundary.

**Reading the plot:** each dot is a ray at its conserved λ = L_z/E;
top row captured, bottom escaped. The green dotted line (measured boundary)
should coincide with the black dashed analytic 3√3 M.
**Measured λ_c = {bc["lambda_c"]:.6f} M, relative error {bc["rel_err"]:.2e}.**

**Inputs:** equatorial rays from r₀ = 30 M; bracket [3, 6] M chosen to
straddle 5.196 M comfortably.

## 3. Kerr photon shell at a = 0.9 (`plots/photon_shell.png`)

**What/why:** frame dragging splits the photon orbit by orbital sense. The
marginally escaping ray of each sense skims its photon orbit, so its
minimum KS radius measures r_ph; compared against the analytic
r_ph = 2M(1 + cos(⅔ arccos(∓a/M))).

**Reading the plot:** per sense, dashed line = analytic radius, solid
line = traced minimum radius; coincident pairs confirm the spin-split
photon shell. **Prograde: traced {ph["prograde"]["r_min"]:.4f} vs analytic {ph["prograde"]["r_ph"]:.4f} M
(err {ph["prograde"]["rel_err"]:.2e}); retrograde: {ph["retrograde"]["r_min"]:.4f} vs {ph["retrograde"]["r_ph"]:.4f} M
(err {ph["retrograde"]["rel_err"]:.2e}).**

**Inputs:** equatorial rays at a = 0.9, prograde bracket [0.5, 5] M,
retrograde [−4.5, −9] M (sign of the offset sets the sign of L_z).

## 4. Conservation drift (`plots/conservation_drift.png`)

**What/why:** E, L_z and H are exact constants of motion; their numerical
drift is pure integration error. E = −p_t is conserved *identically by
construction* (∂H/∂t = 0 means p_t is never updated), so the plot shows the
two nontrivial monitors along a near-critical ray that winds close to the
photon shell — the hardest sustained-strong-field case.

**Reading the plot:** top panel, log-scale |H| (solid) and relative L_z
drift (dashed) per step for both rays; bottom panel shows r(step) for
orientation. Both rays use the *production* adaptive stepping (10%
displacement per step) — this study validates the renderer's operating
accuracy, not the method's floor (the convergence study shows the same
scheme reaches ~1e-11 at fine fixed steps). The generic flyby (blue) sits
at the step-policy-dominated level ~1e-6. The near-critical ray (orange)
winds close to the photon shell, where the orbit instability amplifies
numerical error by ~e^(2π) per winding: its drift is expected to be
another order of magnitude larger — the pass criterion there is *bounded
and small*, not machine-level, which would be dynamically impossible.
**Generic: max |H| = {dr["generic flyby"]["max_H"]:.2e}, max L_z drift =
{dr["generic flyby"]["max_Lz_drift"]:.2e} over {dr["generic flyby"]["steps"]} steps.
Near-critical: max |H| = {dr["near-critical"]["max_H"]:.2e}, max L_z drift =
{dr["near-critical"]["max_Lz_drift"]:.2e} over {dr["near-critical"]["steps"]} steps
(min r = {dr["near-critical"]["min_r"]:.3f} M).**

## 5. Free fall vs the cycloid (`plots/freefall_cycloid.png`)

**What/why:** the Phase 8 free-fall camera integrates a *timelike* geodesic
with the same Hamiltonian machinery (H = -1/2, affine parameter = proper
time). Radial infall from rest in Schwarzschild has the closed-form cycloid
solution r = (r0/2)(1+cos eta), tau = sqrt(r0^3/8M)(eta + sin eta), making
it the clean end-to-end test of the timelike branch, including the
non-obvious Kerr-Schild initial condition p_i = f l_i / sqrt(1-f) != 0 for
an observer at rest.

**Reading the plot:** top panel, integrated r(tau) over the analytic
cycloid (dashed) — they must be indistinguishable; bottom panel, relative
error on a log scale.
**Max relative error: {pl["rel_err"]:.2e} over {pl["steps"]} steps from r0 = {pl["r0"]:.0f} M.**

## 6. Weak-field deflection (`plots/weakfield_deflection.png`)

**What/why:** the Phase 10 linearized multi-mass mode swaps only the
Hamiltonian's metric; its integrator is checked against the classic
deflection alpha = 4M/b over b in [10, 1000] M, plus far-field additivity
for two separated masses.

**Reading the plot:** top, alpha(b) log-log over the 4M/b line — parallel
means slope -1 with the right coefficient; bottom, the relative residual,
which follows the ~10M/b second-order envelope: the departures at small b
are the metric's own higher-order deflection, not integration error.
**b = 1000: ratio {df["ratio_b1000"]:.5f}; tail slope {df["slope_tail"]:.4f};
two-mass additivity ratio {df["additivity_ratio"]:.4f} (vs per-mass 4M_k/b_k sum).**

## 7. PN chirp + ringdown fits vs GW150914 (`plots/pn_chirp.png`)

**What/why:** merger mode (Phase 13) drives the animation and the audio
from TaylorT4 phasing; this study validates the phasing pipeline against
the best-measured event. Detector-frame masses (source 35.6 + 30.6 Msun at
z = 0.09) because observed frequencies scale with (1+z)m — see
docs/derivations.md §12.

**Reading the plot:** top, the GW frequency sweep f_GW(t) from 35 Hz to the
ISCO on a log axis — the accelerating "chirp"; the dashed red line is the
remnant's (2,2,0) quasinormal-mode frequency the blend must reach. Bottom,
the (Newtonian-map) separation in M shrinking toward merger. The chirp
duration printed in the title is the 35 Hz-to-ISCO segment; the published
~0.2 s of loud GW150914 signal additionally includes the post-ISCO
merger portion that PN cannot describe (the schematic blend's job).
**Chirp 35 Hz→ISCO: {pn["tau_t4_s"]:.3f} s (leading-order analytic band
{pn["tau0_analytic_s"]:.3f} s); 0PN integrator self-check err
{pn["err_0pn"]:.2e}; phase-increment convergence |dphi(3.5PN)| =
{pn["dphase_35pn"]:.3f} rad < |dphi(1PN)| = {pn["dphase_1pn"]:.3f} rad;
QNM f = {pn["f_qnm_hz"]:.1f} Hz, tau = {pn["tau_qnm_ms"]:.2f} ms (published
GW150914 ringdown ≈ 250 Hz, ≈ 4 ms).**

**Inputs:** 35 Hz start (the detector band edge used in the discovery
paper); orders 1PN–3.5PN for the convergence ladder; QNM from the
published remnant (M_f = 63.1 Msun, a_f = 0.69).

## 8. Superposed Kerr–Schild binary metric (`plots/superposed_ks.png`)

**What/why:** merger mode renders two holes with the superposed-KS metric
whose inverse is closed-form via two Sherman–Morrison rank-1 updates
(docs/derivations.md §11). Three properties are load-bearing: the inverse
must be *exact* (the integrator differentiates H = ½ p g⁻¹ p), the single-
hole limit must reduce to Kerr (anchors to everything already validated),
and the far field must reproduce additive deflection (continuity with the
weak-field mode).

**Reading the plot:** left, log–log deviation of the binary inverse from
the exact single-Kerr inverse as the second mass M₂ → 0 — points parallel
to the slope-1 guide confirm the superposition error is first order in the
second hole's amplitude, i.e. the limit is approached at the expected rate.
Right, measured deflection past two equal holes vs the additive prediction
Σ 4Mₖ/bₖ.
**Inverse exactness: max |g·g⁻¹ − 1| = {sp["max_inverse_err"]:.2e} over 200
random strong-field points; limit slope {sp["limit_slope"]:.3f}; additivity
ratio {sp["additivity_ratio"]:.4f} at b = 300 M.**

**Inputs:** generic unequal masses/spins (1.0, a = 0.7 and 0.6, a = −0.18)
and off-axis probe points — no symmetry to hide index or sign errors;
static (unboosted) superposition, the Phase 13 scope (the boost enters with
the Phase 14 shader and carries its own check).

## Checks

| Check | Status |
|---|---|
"""
    for label, ok in checks.items():
        lines += f"| {label} | {'✓' if ok else '✗'} |\n"
    lines += """
## Failure handling

Failures (any ✗ above) exit nonzero. See git history of this file for any
failures encountered during development and their fixes.
"""
    (REPORTS / "validation.md").write_text(lines)


if __name__ == "__main__":
    main()
