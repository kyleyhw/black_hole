"""Superposed Kerr-Schild binary metric with exact Sherman-Morrison inverse
(merger mode, Phase 13; docs/derivations.md section 11).

g = eta + f1 l1 l1^T + f2 l2 l2^T, each term the KS data of one hole in its
own centered coordinates. The inverse is exact via two successive rank-1
Sherman-Morrison updates; the second denominator D = 1 - f1 f2 (l1.l2)^2
vanishes only deep in the two-horizon overlap (guarded).

Phase-13 scope is the STATIC superposition (holes at rest): it validates the
inverse, the single-hole limit, and far-field additivity. The instantaneous
boost of moving holes enters with the Phase-14 shader work and carries its
own check there. A static metric also keeps p_t exactly conserved, so the
(x, p_i) integrator state of kerr.py carries over unchanged.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from kerr import FD_EPS_SCALE, ks_radius

ETA_DIAG = np.array([-1.0, 1.0, 1.0, 1.0])

# Floor on the Sherman-Morrison denominator D = 1 - f1 f2 (l1.l2)^2. D < this
# requires both potentials strong at the same point (two-horizon overlap,
# inside the capture zone during inspiral); treated as captured in rendering.
D_MIN = 1e-6

Vec3 = tuple[float, float, float]


@dataclass(frozen=True)
class Hole:
    """One Kerr-Schild hole: mass, spin PER UNIT MASS times mass (a = chi*M,
    a length), and center position (static in Phase 13)."""

    mass: float
    a: float
    center: Vec3


def ks_term(x: Vec3, hole: Hole) -> tuple[float, NDArray[np.float64]]:
    """(f, l_mu) of one hole at field point x, in hole-centered coordinates.

    l_mu = (1, l_i) with the standard KS null covector; f = 2 M r^3 /
    (r^4 + a^2 z^2). Reduces to kerr.py's metric_terms for M = 1, center 0.
    """
    dx = (x[0] - hole.center[0], x[1] - hole.center[1], x[2] - hole.center[2])
    a = hole.a
    r = ks_radius(dx, a)
    r2 = r * r
    f = 2.0 * hole.mass * r2 * r / max(r2 * r2 + a * a * dx[2] * dx[2], 1e-24)
    ra2 = r2 + a * a
    l_mu = np.array(
        [
            1.0,
            (r * dx[0] + a * dx[1]) / ra2,
            (r * dx[1] - a * dx[0]) / ra2,
            dx[2] / r,
        ]
    )
    return f, l_mu


def metric_and_inverse(
    x: Vec3, h1: Hole, h2: Hole
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """(g, g^{-1}) of the superposed metric at x, inverse via two exact
    Sherman-Morrison rank-1 updates (derivations.md section 11)."""
    f1, l1 = ks_term(x, h1)
    f2, l2 = ks_term(x, h2)
    g = np.diag(ETA_DIAG) + f1 * np.outer(l1, l1) + f2 * np.outer(l2, l2)
    # Update 1: (eta + f1 l1 l1^T)^{-1} = eta^{-1} - f1 L1 L1^T with
    # L1 = eta^{-1} l1 (l1 is eta-null, so the denominator is exactly 1).
    l1_up = ETA_DIAG * l1
    a1_inv = np.diag(1.0 / ETA_DIAG) - f1 * np.outer(l1_up, l1_up)
    # Update 2: generic Sherman-Morrison with A = A1.
    w = a1_inv @ l2
    denom = 1.0 + f2 * float(l2 @ w)  # = 1 - f1 f2 (l1.l2)^2
    if abs(denom) < D_MIN:
        raise ValueError("Sherman-Morrison denominator underflow (horizon overlap)")
    g_inv = a1_inv - (f2 / denom) * np.outer(w, w)
    return g, g_inv


def hamiltonian_binary(x: Vec3, p: Vec3, pt: float, h1: Hole, h2: Hole) -> float:
    """H = (1/2) g^{mu nu} p_mu p_nu with p_mu = (pt, p)."""
    _, g_inv = metric_and_inverse(x, h1, h2)
    p4 = np.array([pt, p[0], p[1], p[2]])
    return 0.5 * float(p4 @ g_inv @ p4)


def initial_pt_binary(x: Vec3, p: Vec3, h1: Hole, h2: Hole) -> float:
    """Past-directed root of the null quadratic g^{munu} p_mu p_nu = 0 in p_t,
    matching kerr.py's convention (q_t > 0 for a traced ray)."""
    _, g_inv = metric_and_inverse(x, h1, h2)
    aa = g_inv[0, 0]
    bb = 2.0 * (g_inv[0, 1] * p[0] + g_inv[0, 2] * p[1] + g_inv[0, 3] * p[2])
    p3 = np.array(p)
    cc = float(p3 @ g_inv[1:, 1:] @ p3)
    disc = bb * bb - 4.0 * aa * cc
    # aa = g^{tt} < 0 outside horizons. The traced-ray root with q_t > 0 is
    # the MINUS-sqrt branch: dividing by negative 2 aa makes it positive, and
    # it reduces algebraically to kerr.py's (f s + sqrt(D))/(1 + f) in the
    # single-hole limit (flat-space check: q_t = |p|, not -|p|).
    return (-bb - math.sqrt(max(disc, 0.0))) / (2.0 * aa) if aa < 0 else 1.0


def rhs_binary(
    x: Vec3, p: Vec3, h1: Hole, h2: Hole, pt: float = 1.0
) -> tuple[Vec3, Vec3]:
    """Hamilton's equations for the static binary: analytic dx = g^{i nu} p_nu,
    central-difference dp (same FD scheme and eps policy as kerr.py)."""
    _, g_inv = metric_and_inverse(x, h1, h2)
    p4 = np.array([pt, p[0], p[1], p[2]])
    v = g_inv @ p4
    dx = (float(v[1]), float(v[2]), float(v[3]))

    r_near = min(
        ks_radius((x[0] - h.center[0], x[1] - h.center[1], x[2] - h.center[2]), h.a)
        for h in (h1, h2)
    )
    eps = FD_EPS_SCALE * max(r_near, 1.0)
    inv2e = 0.5 / eps
    dp = tuple(
        -(
            hamiltonian_binary(_shift(x, i, eps), p, pt, h1, h2)
            - hamiltonian_binary(_shift(x, i, -eps), p, pt, h1, h2)
        )
        * inv2e
        for i in range(3)
    )
    return dx, (dp[0], dp[1], dp[2])


def _shift(x: Vec3, axis: int, d: float) -> Vec3:
    s = [x[0], x[1], x[2]]
    s[axis] += d
    return (s[0], s[1], s[2])


def deflection_binary(b: float, h1: Hole, h2: Hole, span: float = 4000.0) -> float:
    """Asymptotic deflection of a ray passing the pair at impact parameter b
    (measured from the origin; holes should straddle it). The ray starts at
    x = b, y = -span/2, travels along +y, and the deflection is the angle
    between the initial and final momentum directions. span >> b so both
    asymptotes are effectively flat."""
    x: Vec3 = (b, -0.5 * span, 0.0)
    p: Vec3 = (0.0, 1.0, 0.0)
    qt = initial_pt_binary(x, p, h1, h2)
    p = (0.0, 1.0 / qt, 0.0)
    y_end = 0.5 * span
    while x[1] < y_end:
        # Displacement-bounded step like kerr.step_size, on the nearer hole.
        r_near = min(
            math.dist(x, h1.center),
            math.dist(x, h2.center),
        )
        dxv, _ = rhs_binary(x, p, h1, h2)
        speed = math.sqrt(dxv[0] ** 2 + dxv[1] ** 2 + dxv[2] ** 2)
        h = min(max(0.1 * r_near / max(speed, 1e-9), 1e-3), 8.0)
        x, p = _rk4(x, p, h, h1, h2)
    dxv, _ = rhs_binary(x, p, h1, h2)
    n = math.sqrt(dxv[0] ** 2 + dxv[1] ** 2 + dxv[2] ** 2)
    return math.acos(max(-1.0, min(1.0, dxv[1] / n)))


def _rk4(x: Vec3, p: Vec3, h: float, h1: Hole, h2: Hole) -> tuple[Vec3, Vec3]:
    k1x, k1p = rhs_binary(x, p, h1, h2)
    x2 = _axpy(x, 0.5 * h, k1x)
    p2 = _axpy(p, 0.5 * h, k1p)
    k2x, k2p = rhs_binary(x2, p2, h1, h2)
    x3 = _axpy(x, 0.5 * h, k2x)
    p3 = _axpy(p, 0.5 * h, k2p)
    k3x, k3p = rhs_binary(x3, p3, h1, h2)
    x4 = _axpy(x, h, k3x)
    p4 = _axpy(p, h, k3p)
    k4x, k4p = rhs_binary(x4, p4, h1, h2)
    c = h / 6.0
    xn = tuple(x[i] + c * (k1x[i] + 2 * k2x[i] + 2 * k3x[i] + k4x[i]) for i in range(3))
    pn = tuple(p[i] + c * (k1p[i] + 2 * k2p[i] + 2 * k3p[i] + k4p[i]) for i in range(3))
    return (xn[0], xn[1], xn[2]), (pn[0], pn[1], pn[2])


def _axpy(v: Vec3, s: float, w: Vec3) -> Vec3:
    return (v[0] + s * w[0], v[1] + s * w[1], v[2] + s * w[2])
