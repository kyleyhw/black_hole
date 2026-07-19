"""Post-Newtonian inspiral phasing and ringdown fits (merger mode, Phase 13).

TaylorT4 quasi-circular evolution of the PN parameter x = (M w_orb)^(2/3):

    dx/dt = (64 nu / 5 M) x^5 [ 1 + c_1 x + c_{3/2} x^{3/2} + ... + c_{7/2} x^{7/2} ]

with nonspinning coefficients through 3.5PN transcribed from Boyle et al.
2007, PRD 76, 124038 (docs/derivations.md section 12; transcription is
validated by the 0PN-limit and order-convergence checks in the suite, not
re-derived), plus the leading (1.5PN) aligned spin-orbit term beta. The
(2,2,0) quasinormal-mode fits are from Berti, Cardoso & Will 2006, PRD 73,
064030. Geometric units G = c = 1; masses converted to seconds via MSUN_S
where physical units are required.
"""

from __future__ import annotations

import math

import numpy as np
from numpy.typing import NDArray

# GM_sun / c^3 in seconds: converts solar masses to geometric time units.
MSUN_S = 4.925490947e-6
EULER_GAMMA = 0.5772156649015329

# ISCO of the comparable-mass system in the test-particle normalization
# x = 1/6 (r = 6M): the conventional PN termination point. Beyond it the
# expansion has no meaning and merger mode blends to the remnant.
X_ISCO = 1.0 / 6.0


def spin_orbit_beta(m1: float, m2: float, chi1: float, chi2: float) -> float:
    """Leading (1.5PN) aligned spin-orbit phasing parameter beta.

    beta = (113/12) (m1^2 chi1 + m2^2 chi2)/M^2 + (25/4) nu (m1 chi1 + m2 chi2)/M
    """
    mt = m1 + m2
    nu = m1 * m2 / mt**2
    return (113.0 / 12.0) * (m1 * m1 * chi1 + m2 * m2 * chi2) / mt**2 + (
        25.0 / 4.0
    ) * nu * (m1 * chi1 + m2 * chi2) / mt


def dxdt(x: float, nu: float, m_total_s: float, beta: float, order: int) -> float:
    """TaylorT4 right-hand side truncated at PN order `order`/2 (order 0..7).

    `order` counts half-PN steps: 0 = leading (Peters), 3 = 1.5PN, 7 = 3.5PN.
    """
    pi = math.pi
    c: list[float] = [
        1.0,
        0.0,  # no 0.5PN term
        -(743.0 / 336.0 + 11.0 / 4.0 * nu),
        4.0 * pi - beta,
        34103.0 / 18144.0 + 13661.0 / 2016.0 * nu + 59.0 / 18.0 * nu * nu,
        -(4159.0 / 672.0 + 189.0 / 8.0 * nu) * pi,
        (
            16447322263.0 / 139708800.0
            - 1712.0 / 105.0 * EULER_GAMMA
            + 16.0 / 3.0 * pi * pi
            + (-56198689.0 / 217728.0 + 451.0 / 48.0 * pi * pi) * nu
            + 541.0 / 896.0 * nu * nu
            - 5605.0 / 2592.0 * nu**3
            - 856.0 / 105.0 * math.log(16.0 * x)
        ),
        -(4415.0 / 4032.0 - 358675.0 / 6048.0 * nu - 91495.0 / 1512.0 * nu * nu) * pi,
    ]
    series = sum(c[k] * x ** (k / 2.0) for k in range(0, min(order, 7) + 1))
    return (64.0 * nu / (5.0 * m_total_s)) * x**5 * series


def integrate_t4(
    m1_msun: float,
    m2_msun: float,
    chi_eff: float,
    f_low_hz: float,
    order: int = 7,
) -> tuple[NDArray[np.float64], NDArray[np.float64], NDArray[np.float64]]:
    """Integrate the TaylorT4 inspiral from GW frequency f_low to the ISCO.

    Masses are DETECTOR-frame (redshift already applied by the caller when
    physical timing is wanted). Returns (t, x, phi_orb) arrays; RK4 with an
    adaptive step dt = 0.01 x/(dx/dt), i.e. ~1% of the local evolution
    timescale — small enough that halving it changes the final phase by
    < 1e-6 rad (checked during development).
    """
    mt = (m1_msun + m2_msun) * MSUN_S
    nu = m1_msun * m2_msun / (m1_msun + m2_msun) ** 2
    beta = spin_orbit_beta(m1_msun, m2_msun, chi_eff, chi_eff)
    # f_GW = w_orb/pi for the quadrupole (m = 2) mode -> x at f_low:
    x = (math.pi * mt * f_low_hz) ** (2.0 / 3.0)
    t = 0.0
    phi = 0.0
    ts: list[float] = [t]
    xs: list[float] = [x]
    phis: list[float] = [phi]
    while x < X_ISCO:
        dt = 0.01 * x / dxdt(x, nu, mt, beta, order)
        # RK4 on the coupled (x, phi) system; d(phi)/dt = x^{3/2}/M.
        k1x = dxdt(x, nu, mt, beta, order)
        k1p = x**1.5 / mt
        x2 = x + 0.5 * dt * k1x
        k2x = dxdt(x2, nu, mt, beta, order)
        k2p = x2**1.5 / mt
        x3 = x + 0.5 * dt * k2x
        k3x = dxdt(x3, nu, mt, beta, order)
        k3p = x3**1.5 / mt
        x4 = x + dt * k3x
        k4x = dxdt(x4, nu, mt, beta, order)
        k4p = x4**1.5 / mt
        x += dt / 6.0 * (k1x + 2 * k2x + 2 * k3x + k4x)
        phi += dt / 6.0 * (k1p + 2 * k2p + 2 * k3p + k4p)
        t += dt
        ts.append(t)
        xs.append(x)
        phis.append(phi)
    return (
        np.asarray(ts, dtype=np.float64),
        np.asarray(xs, dtype=np.float64),
        np.asarray(phis, dtype=np.float64),
    )


def f_gw_of_x(x: NDArray[np.float64], m_total_s: float) -> NDArray[np.float64]:
    """Quadrupole GW frequency f_GW = x^{3/2}/(pi M)."""
    return x**1.5 / (math.pi * m_total_s)


def chirp_time_leading(mchirp_msun: float, f_hz: float) -> float:
    """Leading-order (Peters) time to coalescence from GW frequency f:
    tau = (5/256) Mc^{-5/3} (pi f)^{-8/3}."""
    mc = mchirp_msun * MSUN_S
    return (5.0 / 256.0) * mc ** (-5.0 / 3.0) * (math.pi * f_hz) ** (-8.0 / 3.0)


def chirp_mass(m1: float, m2: float) -> float:
    return (m1 * m2) ** 0.6 / (m1 + m2) ** 0.2


def qnm_220(mf_msun: float, af: float) -> tuple[float, float]:
    """(l,m,n) = (2,2,0) quasinormal mode of a Kerr remnant.

    Berti-Cardoso-Will fits: M w_R = 1.5251 - 1.1568 (1-a)^0.1292,
    Q = 0.7000 + 1.4187 (1-a)^-0.4990. Returns (f_Hz, tau_s) with
    tau = 2Q/w_R. mf is DETECTOR-frame for observed frequencies.
    """
    mf = mf_msun * MSUN_S
    w_r = (1.5251 - 1.1568 * (1.0 - af) ** 0.1292) / mf
    q = 0.7000 + 1.4187 * (1.0 - af) ** (-0.4990)
    return w_r / (2.0 * math.pi), 2.0 * q / w_r
