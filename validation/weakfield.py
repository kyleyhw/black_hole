"""Weak-field (linearized) multi-mass integrator mirroring the shader's
Phase 10 mode: diagonal metric g_00 = -(1+2 Phi), g_ij = (1-2 Phi) delta_ij
with Phi = -sum_k M_k / |x - x_k|, integrated with the same RK4 +
central-difference Hamiltonian scheme. Derivations: docs/derivations.md §10.
"""

from __future__ import annotations

import math

Vec3 = tuple[float, float, float]
Mass = tuple[float, Vec3]  # (M_k, position)

FD_EPS_SCALE: float = 1e-5


def potential(x: Vec3, masses: list[Mass]) -> float:
    """Phi(x) = -sum M_k / |x - x_k|."""
    phi = 0.0
    for mk, xk in masses:
        d = math.sqrt((x[0] - xk[0]) ** 2 + (x[1] - xk[1]) ** 2 + (x[2] - xk[2]) ** 2)
        phi -= mk / max(d, 1e-12)
    return phi


def hamiltonian(x: Vec3, p: Vec3, pt: float, masses: list[Mass]) -> float:
    """H = (1/2)[-pt^2/(1+2Phi) + |p|^2/(1-2Phi)]."""
    phi = potential(x, masses)
    p2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2]
    return 0.5 * (-pt * pt / (1.0 + 2.0 * phi) + p2 / (1.0 - 2.0 * phi))


def initial_pt(x: Vec3, p: Vec3, masses: list[Mass]) -> float:
    """Null condition for the static metric: pt = |p| sqrt((1+2Phi)/(1-2Phi))."""
    phi = potential(x, masses)
    p2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2]
    return math.sqrt(p2 * (1.0 + 2.0 * phi) / (1.0 - 2.0 * phi))


def rhs(x: Vec3, p: Vec3, pt: float, masses: list[Mass]) -> tuple[Vec3, Vec3]:
    """dx/dl = p/(1-2Phi) (analytic); dp/dl = -dH/dx (central differences)."""
    phi = potential(x, masses)
    inv = 1.0 / (1.0 - 2.0 * phi)
    dx = (p[0] * inv, p[1] * inv, p[2] * inv)
    # Distance to the nearest mass sets the FD length scale.
    dmin = min(
        math.sqrt((x[0] - xk[0]) ** 2 + (x[1] - xk[1]) ** 2 + (x[2] - xk[2]) ** 2)
        for _, xk in masses
    )
    eps = FD_EPS_SCALE * max(dmin, 1.0)
    inv2e = 0.5 / eps
    dp = (
        -(
            hamiltonian((x[0] + eps, x[1], x[2]), p, pt, masses)
            - hamiltonian((x[0] - eps, x[1], x[2]), p, pt, masses)
        )
        * inv2e,
        -(
            hamiltonian((x[0], x[1] + eps, x[2]), p, pt, masses)
            - hamiltonian((x[0], x[1] - eps, x[2]), p, pt, masses)
        )
        * inv2e,
        -(
            hamiltonian((x[0], x[1], x[2] + eps), p, pt, masses)
            - hamiltonian((x[0], x[1], x[2] - eps), p, pt, masses)
        )
        * inv2e,
    )
    return dx, dp


def rk4_step(
    x: Vec3, p: Vec3, h: float, pt: float, masses: list[Mass]
) -> tuple[Vec3, Vec3]:
    k1x, k1p = rhs(x, p, pt, masses)
    x2 = (x[0] + 0.5 * h * k1x[0], x[1] + 0.5 * h * k1x[1], x[2] + 0.5 * h * k1x[2])
    p2 = (p[0] + 0.5 * h * k1p[0], p[1] + 0.5 * h * k1p[1], p[2] + 0.5 * h * k1p[2])
    k2x, k2p = rhs(x2, p2, pt, masses)
    x3 = (x[0] + 0.5 * h * k2x[0], x[1] + 0.5 * h * k2x[1], x[2] + 0.5 * h * k2x[2])
    p3 = (p[0] + 0.5 * h * k2p[0], p[1] + 0.5 * h * k2p[1], p[2] + 0.5 * h * k2p[2])
    k3x, k3p = rhs(x3, p3, pt, masses)
    x4 = (x[0] + h * k3x[0], x[1] + h * k3x[1], x[2] + h * k3x[2])
    p4 = (p[0] + h * k3p[0], p[1] + h * k3p[1], p[2] + h * k3p[2])
    k4x, k4p = rhs(x4, p4, pt, masses)
    c = h / 6.0
    xn = (
        x[0] + c * (k1x[0] + 2 * k2x[0] + 2 * k3x[0] + k4x[0]),
        x[1] + c * (k1x[1] + 2 * k2x[1] + 2 * k3x[1] + k4x[1]),
        x[2] + c * (k1x[2] + 2 * k2x[2] + 2 * k3x[2] + k4x[2]),
    )
    pn = (
        p[0] + c * (k1p[0] + 2 * k2p[0] + 2 * k3p[0] + k4p[0]),
        p[1] + c * (k1p[1] + 2 * k2p[1] + 2 * k3p[1] + k4p[1]),
        p[2] + c * (k1p[2] + 2 * k2p[2] + 2 * k3p[2] + k4p[2]),
    )
    return xn, pn


def deflection_angle(b: float, masses: list[Mass], span: float = 2000.0) -> float:
    """Trace a ray from (-span/2, b, 0) along +x past the masses and return
    the angle between the initial and final coordinate directions."""
    x: Vec3 = (-span / 2.0, b, 0.0)
    p: Vec3 = (1.0, 0.0, 0.0)
    pt = initial_pt(x, p, masses)
    while x[0] < span / 2.0:
        dmin = min(
            math.sqrt((x[0] - xk[0]) ** 2 + (x[1] - xk[1]) ** 2 + (x[2] - xk[2]) ** 2)
            for _, xk in masses
        )
        phi = potential(x, masses)
        inv = 1.0 / (1.0 - 2.0 * phi)
        speed = math.sqrt(p[0] ** 2 + p[1] ** 2 + p[2] ** 2) * inv
        # 2% of the distance to the nearest mass per step: fine near closest
        # approach, coarse on the long straight legs.
        h = min(max(0.02 * dmin / max(speed, 1e-9), 1e-3), 20.0)
        x, p = rk4_step(x, p, h, pt, masses)
    norm0 = 1.0
    norm1 = math.sqrt(p[0] ** 2 + p[1] ** 2 + p[2] ** 2)
    cosang = max(-1.0, min(1.0, p[0] / (norm0 * norm1)))
    return math.acos(cosang)
