"""Kerr null-geodesic integrator mirroring the WebGL fragment shader.

Same algorithm as ``src/shaders/render.frag.glsl`` — Kerr-Schild Cartesian
coordinates, Hamiltonian H = (1/2) g^{mu nu} p_mu p_nu with p_t = 1
(past-directed normalization), RK4 with central-difference spatial
gradients, displacement-bounded adaptive step — but in float64, so the
shader's physics can be validated independently of f32 precision.

The hot loop deliberately uses plain Python floats and 3-tuples rather than
small NumPy arrays: per-element NumPy overhead dominates at this size
(~10x slower). Trajectories are returned as NDArray for analysis/plotting.

Derivations for every expression: ../docs/derivations.md.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum

import numpy as np
from numpy.typing import NDArray

Vec3 = tuple[float, float, float]

# Central-difference step for dH/dx in float64. Balances truncation
# O(eps^2) against roundoff O(eps_machine / eps): the optimum is
# ~(3 eps_m)^(1/3) ~ 1e-5 of the local length scale (derivations.md section 5).
FD_EPS_SCALE: float = 1e-5

# Escape radius in M; matches the shader's R_ESCAPE.
R_ESCAPE: float = 200.0

# Momentum-blowup capture threshold |p|^2; matches the shader. Past-directed
# shadow rays hug the horizon with exponentially growing blueshift.
P2_CAPTURE: float = 1e8


def ks_radius(x: Vec3, a: float) -> float:
    """Kerr-Schild radius: largest root of r^4 - r^2(rho^2 - a^2) - a^2 z^2 = 0."""
    b = x[0] * x[0] + x[1] * x[1] + x[2] * x[2] - a * a
    r2 = 0.5 * (b + math.sqrt(max(b * b + 4.0 * a * a * x[2] * x[2], 0.0)))
    return math.sqrt(max(r2, 1e-12))


def metric_terms(x: Vec3, a: float) -> tuple[float, Vec3]:
    """Scalar profile f = 2Mr^3/(r^4 + a^2 z^2) and null covector l_i (M = 1)."""
    r = ks_radius(x, a)
    r2 = r * r
    f = 2.0 * r2 * r / max(r2 * r2 + a * a * x[2] * x[2], 1e-24)
    ra2 = r2 + a * a
    l = ((r * x[0] + a * x[1]) / ra2, (r * x[1] - a * x[0]) / ra2, x[2] / r)
    return f, l


def hamiltonian(x: Vec3, p: Vec3, pt: float, a: float) -> float:
    """H = (1/2) g^{mu nu} p_mu p_nu ; l^mu p_mu = dot(l, p) - pt."""
    f, l = metric_terms(x, a)
    lp = l[0] * p[0] + l[1] * p[1] + l[2] * p[2] - pt
    return 0.5 * (-pt * pt + p[0] * p[0] + p[1] * p[1] + p[2] * p[2] - f * lp * lp)


def initial_pt(x: Vec3, p: Vec3, a: float) -> float:
    """Past-directed root of the null quadratic: q_t = (f s + sqrt(D)) / (1 + f)."""
    f, l = metric_terms(x, a)
    s = l[0] * p[0] + l[1] * p[1] + l[2] * p[2]
    p2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2]
    disc = (1.0 + f) * p2 - f * s * s
    return (f * s + math.sqrt(max(disc, 0.0))) / (1.0 + f)


def rhs(x: Vec3, p: Vec3, a: float) -> tuple[Vec3, Vec3]:
    """Hamilton's equations with p_t = 1: analytic dx, central-difference dp."""
    f, l = metric_terms(x, a)
    lp = l[0] * p[0] + l[1] * p[1] + l[2] * p[2] - 1.0
    dx = (p[0] - f * lp * l[0], p[1] - f * lp * l[1], p[2] - f * lp * l[2])

    eps = FD_EPS_SCALE * max(ks_radius(x, a), 1.0)
    inv2e = 0.5 / eps
    dp = (
        -(
            hamiltonian((x[0] + eps, x[1], x[2]), p, 1.0, a)
            - hamiltonian((x[0] - eps, x[1], x[2]), p, 1.0, a)
        )
        * inv2e,
        -(
            hamiltonian((x[0], x[1] + eps, x[2]), p, 1.0, a)
            - hamiltonian((x[0], x[1] - eps, x[2]), p, 1.0, a)
        )
        * inv2e,
        -(
            hamiltonian((x[0], x[1], x[2] + eps), p, 1.0, a)
            - hamiltonian((x[0], x[1], x[2] - eps), p, 1.0, a)
        )
        * inv2e,
    )
    return dx, dp


def rk4_step(x: Vec3, p: Vec3, h: float, a: float) -> tuple[Vec3, Vec3]:
    """One classical RK4 step of Hamilton's equations."""
    k1x, k1p = rhs(x, p, a)
    x2 = (x[0] + 0.5 * h * k1x[0], x[1] + 0.5 * h * k1x[1], x[2] + 0.5 * h * k1x[2])
    p2 = (p[0] + 0.5 * h * k1p[0], p[1] + 0.5 * h * k1p[1], p[2] + 0.5 * h * k1p[2])
    k2x, k2p = rhs(x2, p2, a)
    x3 = (x[0] + 0.5 * h * k2x[0], x[1] + 0.5 * h * k2x[1], x[2] + 0.5 * h * k2x[2])
    p3 = (p[0] + 0.5 * h * k2p[0], p[1] + 0.5 * h * k2p[1], p[2] + 0.5 * h * k2p[2])
    k3x, k3p = rhs(x3, p3, a)
    x4 = (x[0] + h * k3x[0], x[1] + h * k3x[1], x[2] + h * k3x[2])
    p4 = (p[0] + h * k3p[0], p[1] + h * k3p[1], p[2] + h * k3p[2])
    k4x, k4p = rhs(x4, p4, a)
    c = h / 6.0
    xn = (
        x[0] + c * (k1x[0] + 2.0 * k2x[0] + 2.0 * k3x[0] + k4x[0]),
        x[1] + c * (k1x[1] + 2.0 * k2x[1] + 2.0 * k3x[1] + k4x[1]),
        x[2] + c * (k1x[2] + 2.0 * k2x[2] + 2.0 * k3x[2] + k4x[2]),
    )
    pn = (
        p[0] + c * (k1p[0] + 2.0 * k2p[0] + 2.0 * k3p[0] + k4p[0]),
        p[1] + c * (k1p[1] + 2.0 * k2p[1] + 2.0 * k3p[1] + k4p[1]),
        p[2] + c * (k1p[2] + 2.0 * k2p[2] + 2.0 * k3p[2] + k4p[2]),
    )
    return xn, pn


def horizon_radius(a: float) -> float:
    """Outer horizon r_+ = M + sqrt(M^2 - a^2) (M = 1)."""
    return 1.0 + math.sqrt(max(1.0 - a * a, 0.0))


def capture_radius(a: float) -> float:
    """Capture threshold, scaled to stay inside the prograde photon orbit."""
    r_h = horizon_radius(a)
    return r_h * (1.0 + 0.02 * math.sqrt(max(1.0 - a * a, 0.0))) + 1e-3


def step_size(r: float, r_h: float, speed: float) -> float:
    """Displacement-bounded adaptive step; mirrors the shader exactly."""
    return min(max(0.1 * min(r - 0.9 * r_h, r) / max(speed, 1e-6), 1e-4), 4.0)


class Outcome(Enum):
    BUDGET = 0
    CAPTURED = 1
    ESCAPED = 2


@dataclass
class Trajectory:
    outcome: Outcome
    xs: NDArray[np.float64]  # (n, 3) positions
    ps: NDArray[np.float64]  # (n, 3) covector momenta (p_t = 1 throughout)
    min_r: float


def make_ray(x0: Vec3, direction: Vec3, a: float) -> tuple[Vec3, Vec3]:
    """Normalize a unit coordinate covector into a ray with physical E = 1."""
    n = math.sqrt(direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2)
    d = (direction[0] / n, direction[1] / n, direction[2] / n)
    qt = initial_pt(x0, d, a)
    return x0, (d[0] / qt, d[1] / qt, d[2] / qt)


def conserved(x: Vec3, p: Vec3) -> tuple[float, float]:
    """(E, L_z) of the traced ray: E = -p_t = -1... but the *physical* photon
    is -q, so E_phys = q_t = 1 and L_phys = -(x p_y - y p_x). Ratios such as
    lambda = L/E are invariant; we report the traced-ray L_z with the
    physical sign convention applied."""
    return 1.0, -(x[0] * p[1] - x[1] * p[0])


def integrate(
    x0: Vec3,
    p0: Vec3,
    a: float,
    max_steps: int = 60000,
    fixed_h: float | None = None,
    record: bool = False,
) -> Trajectory:
    """Integrate one ray to termination (or for max_steps if fixed_h is set).

    fixed_h disables the adaptive step and termination-by-radius is still
    applied; used by the convergence study where a controlled step is needed.
    """
    r_h = horizon_radius(a)
    r_cap = capture_radius(a)
    x, p = x0, p0
    xs: list[Vec3] = [x]
    ps: list[Vec3] = [p]
    min_r = ks_radius(x, a)
    outcome = Outcome.BUDGET
    for _ in range(max_steps):
        r = ks_radius(x, a)
        min_r = min(min_r, r)
        if r < r_cap:
            outcome = Outcome.CAPTURED
            break
        if r > R_ESCAPE:
            outcome = Outcome.ESCAPED
            break
        p2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2]
        if not p2 <= P2_CAPTURE:
            outcome = Outcome.CAPTURED
            break
        if fixed_h is None:
            f, l = metric_terms(x, a)
            lp = l[0] * p[0] + l[1] * p[1] + l[2] * p[2] - 1.0
            v = (p[0] - f * lp * l[0], p[1] - f * lp * l[1], p[2] - f * lp * l[2])
            h = step_size(r, r_h, math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2))
        else:
            h = fixed_h
        x, p = rk4_step(x, p, h, a)
        if record:
            xs.append(x)
            ps.append(p)
    return Trajectory(outcome, np.array(xs), np.array(ps), min_r)


def photon_orbit_radius(a: float, sense: int) -> float:
    """Analytic equatorial photon orbit: r_ph = 2M(1 + cos(2/3 arccos(-s a/M)))
    with s = +1 prograde, -1 retrograde (Bardeen-Press-Teukolsky 1972)."""
    return 2.0 * (1.0 + math.cos((2.0 / 3.0) * math.acos(-sense * a)))
