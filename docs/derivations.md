# Derivations

Complete derivations for every physics expression implemented in the shader
and the validation suite. Conventions: geometrized units $G = c = 1$, metric
signature $(-,+,+,+)$, base mass scale $M = 1$ (mass enters only as a global
length rescale). Greek indices run over $(t,x,y,z)$, Latin over $(x,y,z)$.

Contents:

1. [Kerr–Schild radial coordinate](#1-kerr–schild-radial-coordinate)
2. [Metric and exact inverse](#2-metric-and-exact-inverse)
3. [Hamiltonian formulation and conserved quantities](#3-hamiltonian-formulation-and-conserved-quantities)
4. [Ray initial conditions: the $p_t$ quadratic and root selection](#4-ray-initial-conditions-the-p_t-quadratic-and-root-selection)
5. [Finite-difference gradient of the Hamiltonian](#5-finite-difference-gradient-of-the-hamiltonian)
6. [Disk kinematics: $\Omega$, $u^t$, ISCO, and the redshift factor](#6-disk-kinematics-omega-ut-isco-and-the-redshift-factor)
7. [Relativistic beaming and the $g^4$ law](#7-relativistic-beaming-and-the-g4-law)

---

## 1. Kerr–Schild radial coordinate

Kerr–Schild (KS) coordinates are Cartesian $(t,x,y,z)$ with the spin along
$+z$. The KS radius $r(x,y,z)$ is *not* the Euclidean radius; it is defined
implicitly by the confocal oblate-spheroidal relation

$$\frac{x^2 + y^2}{r^2 + a^2} + \frac{z^2}{r^2} = 1 .$$

Multiplying by $r^2(r^2+a^2)$ and writing $\rho^2 = x^2+y^2+z^2$:

$$r^2(x^2+y^2) + z^2(r^2+a^2) = r^2(r^2+a^2)
\;\Longrightarrow\;
r^4 - r^2(\rho^2 - a^2) - a^2 z^2 = 0 .$$

This is a quadratic in $r^2$; the non-negative root is

$$r^2 = \tfrac{1}{2}\left(\rho^2 - a^2\right)
      + \sqrt{\tfrac{1}{4}\left(\rho^2 - a^2\right)^2 + a^2 z^2}.$$

The other root of the quadratic is $\le 0$ for all $(x,y,z)$, so root
selection is unambiguous — this is one of the reasons KS coordinates need no
turning-point bookkeeping.

**Degenerate-case guards.** The surfaces $r = \text{const}$ are confocal
oblate spheroids that degenerate, as $r \to 0$, onto the disk
$\{z = 0,\ x^2+y^2 \le a^2\}$ bounded by the ring singularity at
$x^2+y^2 = a^2$. Two guards are needed in $32$-bit float arithmetic:

- The discriminant $\tfrac14(\rho^2-a^2)^2 + a^2z^2 \ge 0$ exactly, but
  rounding can produce a tiny negative argument; clamp with
  $\max(\cdot, 0)$ before the square root.
- $l_\mu$ (below) contains $z/r$; as $r \to 0$ this is singular on the
  degenerate disk. Physically the region $r \lesssim r_+$ is always behind
  the capture condition $r < 1.02\,r_+$ (the ring singularity lies inside
  the horizon for $a < M$), so the guard $r \to \max(r, \varepsilon_r)$ with
  $\varepsilon_r = 10^{-4}$ only protects against transient evaluation at
  invalid points (e.g. finite-difference probes near the ring), never
  against rendered physics.

## 2. Metric and exact inverse

The Kerr metric in KS form is

$$g_{\mu\nu} = \eta_{\mu\nu} + f\, l_\mu l_\nu,
\qquad
f = \frac{2 M r^3}{r^4 + a^2 z^2},$$

$$l_\mu = \left(1,\;
\frac{r x + a y}{r^2 + a^2},\;
\frac{r y - a x}{r^2 + a^2},\;
\frac{z}{r}\right).$$

**$l$ is null with respect to $\eta$** (and hence also with respect to $g$).
With $\eta = \mathrm{diag}(-1,1,1,1)$:

$$\eta^{\mu\nu} l_\mu l_\nu
 = -1 + \frac{(rx+ay)^2 + (ry-ax)^2}{(r^2+a^2)^2} + \frac{z^2}{r^2}.$$

The numerator expands as
$(rx+ay)^2 + (ry-ax)^2 = (r^2+a^2)(x^2+y^2)$ — the cross terms
$\pm 2raxy$ cancel — so

$$\eta^{\mu\nu} l_\mu l_\nu = -1 + \frac{x^2+y^2}{r^2+a^2} + \frac{z^2}{r^2} = 0$$

by the defining relation of $r$ in §1. In particular the *spatial* part
$\vec{l}$ is a Euclidean unit vector, a fact used in §4.

**Exact inverse.** Claim: $g^{\mu\nu} = \eta^{\mu\nu} - f\, l^\mu l^\nu$
with $l^\mu \equiv \eta^{\mu\nu} l_\nu$ (so $l^t = -1$, $l^i = l_i$). Check:

$$g_{\mu\alpha} g^{\alpha\nu}
 = (\eta_{\mu\alpha} + f l_\mu l_\alpha)(\eta^{\alpha\nu} - f l^\alpha l^\nu)
 = \delta_\mu^{\ \nu} - f l_\mu l^\nu + f l_\mu l^\nu
   - f^2 l_\mu (l_\alpha l^\alpha) l^\nu
 = \delta_\mu^{\ \nu},$$

where the last term vanishes because $l_\alpha l^\alpha = 0$. The inverse is
exact — no matrix inversion, and no approximation, appears anywhere in the
renderer.

## 3. Hamiltonian formulation and conserved quantities

Null geodesics are the integral curves of the Hamiltonian

$$H(x, p) = \tfrac{1}{2} g^{\mu\nu}(x)\, p_\mu p_\nu ,
\qquad
\dot{x}^\mu = \frac{\partial H}{\partial p_\mu} = g^{\mu\nu} p_\nu,
\qquad
\dot{p}_\mu = -\frac{\partial H}{\partial x^\mu}
            = -\tfrac{1}{2}\, \partial_\mu g^{\alpha\beta}\, p_\alpha p_\beta ,$$

with overdots denoting $d/d\lambda$ for affine parameter $\lambda$. This is
equivalent to the geodesic equation but requires no Christoffel symbols, and
$H$ itself is conserved: $H = 0$ identifies the null condition, and the
numerical drift $|H|$ along a ray is a direct, per-ray integration-error
monitor (rendered as a debug view).

Expanding with the KS inverse metric, writing $\vec{p}$ for the spatial
covector components and $s \equiv \vec{l}\cdot\vec{p}$ (Euclidean dot):

$$2H = g^{\mu\nu} p_\mu p_\nu
     = -p_t^2 + |\vec{p}\,|^2 - f\,(l^\mu p_\mu)^2,
\qquad
l^\mu p_\mu = s - p_t .$$

**Conserved quantities.** The metric components are independent of $t$
(stationarity) and invariant under rotations about $z$ (axisymmetry), so
$\xi = \partial_t$ and $\psi = \partial_\phi$ are Killing vectors and

$$E = -p_t, \qquad
L_z = p_\phi = x\, p_y - y\, p_x$$

are exactly conserved along every geodesic ($L_z$ written in its Cartesian
form). Numerically, $E$ is conserved to machine precision trivially
($\partial_t H = 0$ means $p_t$ is never updated), while $L_z$ and $H$ drift
at the level of the integration error — all three are validation targets.

The state actually integrated is 6-dimensional, $(x^i, p_i)$: $p_t$ is
constant, and the coordinate time $t(\lambda)$ is not needed for imaging.

## 4. Ray initial conditions: the $p_t$ quadratic and root selection

Per pixel, the camera at $x_{\rm cam}$ assigns a Euclidean unit viewing
direction $\hat{n}$ (pinhole model). Set the spatial momentum
$\vec{p} = \hat{n}$ and solve $H = 0$ for $p_t$:

$$-p_t^2 + |\vec{p}\,|^2 - f\,(s - p_t)^2 = 0
\;\Longrightarrow\;
(1+f)\,p_t^2 - 2 f s\, p_t - \left(|\vec{p}\,|^2 - f s^2\right) = 0,$$

$$\boxed{\;p_t = \frac{f s \pm \sqrt{D}}{1+f},
\qquad
D = (1+f)\,|\vec{p}\,|^2 - f s^2 .\;}$$

**The discriminant is always positive:** since $\vec{l}$ is a Euclidean unit
vector (§2), $s^2 = (\vec{l}\cdot\vec{p})^2 \le |\vec{p}\,|^2$, hence
$D \ge (1+f)|\vec{p}\,|^2 - f |\vec{p}\,|^2 = |\vec{p}\,|^2 > 0$. Both roots
are always real; no ray can fail initialization.

**Root selection.** The coordinate-time velocity of the ray is

$$\dot{t} = g^{t\nu} p_\nu = -p_t + f\,(s - p_t) = -(1+f)\,p_t + f s
 = \mp \sqrt{D},$$

substituting each root. So the two roots are exactly the future-directed
($-$ root, $\dot{t} = +\sqrt{D}$) and past-directed ($+$ root,
$\dot{t} = -\sqrt{D}$) solutions — a cleaner selection criterion than
inspecting signs case by case.

**Which root images the sky?** Imaging integrates the *past* light cone: the
rendered ray leaves the camera along $+\hat{n}$ tracing where arriving light
came from, i.e. backwards in time. The traced momentum $q$ therefore takes
the **past-directed root**

$$q_t = \frac{f s + \sqrt{D}}{1+f}, \qquad \dot{t} = -\sqrt{D} < 0,$$

and the physically arriving photon is $p = -q$ (future-directed, spatially
ingoing). Choosing the wrong root is *not* harmless in Kerr: reversing time
orientation reverses the sense of frame dragging (Kerr is stationary but not
static), flipping the shadow asymmetry. The affine normalization scales $q$
so that the physical photon has unit energy at infinity:
$E = -p_t = q_t = 1$.

**Apparent angles of the coordinate-pinhole camera.** Until the Phase 8
tetrad refactor, the camera assigns each pixel a unit *coordinate* covector
$\hat{n}$, not a direction in a local observer's orthonormal frame. The two
differ by metric factors, so textbook apparent-angle formulas (derived for
local static observers) must not be compared directly against rendered
angles. The correct prediction for this camera follows from conserved
quantities alone. Example used by the Phase 3 in-browser test
(Schwarzschild, camera at $r_0$, covector at angle $\alpha$ from the inward
radial axis): $s = \vec{l}\cdot\hat{n} = -\cos\alpha$, so

$$q_t(\alpha) = \frac{-f\cos\alpha + \sqrt{1 + f\sin^2\alpha}}{1+f},
\qquad f = \frac{2M}{r_0},
\qquad b(\alpha) = \frac{L_z}{E} = \frac{r_0 \sin\alpha}{q_t(\alpha)},$$

and the shadow edge is the $\alpha$ solving $b(\alpha) = 3\sqrt{3}\,M$. At
$r_0 = 18M$ this gives $\alpha_{\rm edge} = 0.2347$ rad (measured in-browser:
agreement to $0.13\%$), whereas the local-frame formula
$\sin\theta = (3\sqrt3 M/r_0)\sqrt{1-2M/r_0}$ gives $0.2757$ rad — an $18\%$
difference that is *camera convention*, not physics. After Phase 8 the
tetrad camera makes the local-frame formula the right prediction.

**Observables are invariant under $p \to -q$.** Every quantity used in
shading is a ratio that cancels the overall sign of the momentum: the
impact parameter $\lambda = L_z / E$ (both flip sign), and the redshift
$g = (p\cdot u_{\rm obs})/(p \cdot u_{\rm em})$ (sign cancels between
numerator and denominator). The traced ray's $(E, L_z)$ can therefore be
used directly in §6 without sign gymnastics.

## 5. Finite-difference gradient of the Hamiltonian

$\dot{p}_i = -\partial_i H$ is evaluated by central differences, re-using the
scalar $H(x,p)$ evaluator (6 extra metric evaluations per right-hand side):

$$\partial_i H \approx
\frac{H(x + \varepsilon\, e_i,\ p) - H(x - \varepsilon\, e_i,\ p)}{2\varepsilon}.$$

No $t$-derivative is needed ($\partial_t H = 0$), and $\partial H/\partial p$
is analytic ($g^{\mu\nu} p_\nu$), so the finite difference is confined to the
one place derivatives of the metric appear.

**Step-size choice for 32-bit floats.** The total error of a central
difference is

$$\mathcal{E}(\varepsilon) \approx
\underbrace{\frac{\varepsilon^2}{6}\,|\partial_i^3 H|}_{\text{truncation}}
+ \underbrace{\frac{\epsilon_{\rm m}\,|H|_{\rm terms}}{\varepsilon}}_{\text{roundoff}},$$

where $\epsilon_{\rm m} \approx 1.2\times 10^{-7}$ is the f32 machine epsilon
and $|H|_{\rm terms} \sim |\vec p|^2 \max(1, f)$ is the magnitude of the
summed terms (relevant because $H \approx 0$ arises by cancellation).
Minimizing over $\varepsilon$ gives
$\varepsilon^\ast \sim (3\epsilon_{\rm m})^{1/3} \ell \approx 7\times10^{-3}\,\ell$
for characteristic curvature length $\ell \sim r$. The blueprint's
$\varepsilon = 10^{-4} r$ is well chosen for f64 (where
$\epsilon_{\rm m} \approx 2\times10^{-16}$ pushes
$\varepsilon^\ast \sim 10^{-5} r$) but sits deep in the roundoff-dominated
regime for f32. The shader therefore uses

$$\varepsilon = 2\times10^{-3}\, \max(r, 1),$$

slightly below $\varepsilon^\ast$ to keep truncation error comfortably
subdominant; the Python validation suite (f64) uses $10^{-6} r$ and the
convergence-order plot confirms the scheme's accuracy independently of this
choice.

## 6. Disk kinematics: $\Omega$, $u^t$, ISCO, and the redshift factor

The disk is modeled as matter on circular equatorial geodesics. Formulas are
derived in Boyer–Lindquist (BL) coordinates and carried to KS; the
justification for that transfer is at the end of this section. Throughout,
$s = +1$ denotes prograde and $s = -1$ retrograde orbits ($s$ multiplies
$a$-odd terms).

Equatorial BL metric components ($\theta = \pi/2$):

$$g_{tt} = -\left(1 - \frac{2M}{r}\right), \quad
g_{t\phi} = -\frac{2Ma}{r}, \quad
g_{\phi\phi} = r^2 + a^2 + \frac{2Ma^2}{r}.$$

**Orbital angular velocity.** For a circular orbit,
$u = u^t(\partial_t + \Omega\, \partial_\phi)$ with constant $r$, the radial
geodesic equation reduces to (all $\Gamma$'s expressible through radial
derivatives of the metric on the equator)

$$\partial_r g_{tt} + 2\Omega\, \partial_r g_{t\phi}
+ \Omega^2\, \partial_r g_{\phi\phi} = 0 .$$

With $\partial_r g_{tt} = -2M/r^2$, $\partial_r g_{t\phi} = 2Ma/r^2$,
$\partial_r g_{\phi\phi} = 2r - 2Ma^2/r^2$, the quadratic solves to the
Kepler-like result

$$\boxed{\;\Omega = \frac{s\sqrt{M}}{r^{3/2} + s\, a \sqrt{M}}\;}$$

(numerically verified: $M=1$, $a=0.9$, $r=4$, $s=+1$ gives
$\Omega = 0.112360$ and the geodesic condition evaluates to $3\times10^{-6}$).

**Time dilation factor $u^t$.** From normalization $u\cdot u = -1$:

$$(u^t)^2 \left(g_{tt} + 2\Omega g_{t\phi} + \Omega^2 g_{\phi\phi}\right) = -1
\;\Longrightarrow\;
u^t = \frac{1}{\sqrt{-(g_{tt} + 2\Omega g_{t\phi} + \Omega^2 g_{\phi\phi})}}.$$

Substituting the components and $\Omega$ and simplifying yields the
Bardeen–Press–Teukolsky form [[1]](#ref-bpt-1972)

$$\boxed{\;u^t = \frac{1 + s\, a\sqrt{M}/r^{3/2}}
{\sqrt{1 - \dfrac{3M}{r} + \dfrac{2 s\, a\sqrt{M}}{r^{3/2}}}}\;}$$

> **Correction to the blueprint.** The project blueprint stated
> $u^t = 1/\sqrt{1 - 3M/r + 2a\sqrt{M}/r^{3/2}}$, omitting the numerator
> $(1 + s\,a\sqrt{M}/r^{3/2})$. Direct numerical normalization at
> $M=1$, $a=0.9$, $r=4$ gives $u^t = 1.61418$; the blueprint expression
> gives $1.45095$, the corrected expression $1.61419$. The corrected form
> (which reduces to the Schwarzschild $1/\sqrt{1-3M/r}$ at $a=0$) is what
> the shader implements. Had this gone unchecked, disk redshifts would have
> been overestimated by $\sim 10\%$ at these radii for high spin.

**ISCO radius** (BPT [[1]](#ref-bpt-1972)), with $\chi = a/M$:

$$Z_1 = 1 + (1-\chi^2)^{1/3}\left[(1+\chi)^{1/3} + (1-\chi)^{1/3}\right],
\qquad
Z_2 = \sqrt{3\chi^2 + Z_1^2},$$

$$r_{\rm ISCO} = M\left[3 + Z_2 - s\sqrt{(3-Z_1)(3+Z_1+2Z_2)}\right].$$

Limits: $a=0 \Rightarrow r_{\rm ISCO} = 6M$ (both senses);
$a \to M \Rightarrow r_{\rm ISCO} \to M$ (prograde), $9M$ (retrograde).

**Redshift factor.** A photon with momentum $p$ is measured by an observer
with 4-velocity $u$ to have angular frequency $\omega = -p_\mu u^\mu$. For
the emitter on the circular orbit and a static observer at infinity
($u_{\rm obs} = \partial_t$):

$$\omega_{\rm obs} = -p_t = E, \qquad
\omega_{\rm em} = -p_\mu u^\mu_{\rm em}
 = -u^t\left(p_t + \Omega\, p_\phi\right)
 = u^t E\left(1 - \Omega \lambda\right),
\qquad \lambda = \frac{L_z}{E},$$

$$\boxed{\;g \equiv \frac{\omega_{\rm obs}}{\omega_{\rm em}}
= \frac{1}{u^t\,(1 - \Omega \lambda)}\;}$$

This single exact expression contains gravitational redshift (through
$u^t$), orbital Doppler beaming (through $\Omega\lambda$, which is
positive on the receding side where $L_z$ has the orbital sign and negative
on the approaching side), and frame dragging (through the $a$-dependence of
both $\Omega$ and $u^t$). $E$ and $L_z$ are the conserved quantities carried
by the ray — no extra integration is needed at the hit point.

**Validity of the BL→KS transfer.** The KS chart is related to BL by
$t_{\rm KS} = t_{\rm BL} + h(r)$, $\phi_{\rm KS} = \phi_{\rm BL} + k(r)$
(with $h,k$ functions of $r$ only), and the radial coordinates coincide.
Therefore: (i) $\partial_t$ and $\partial_\phi$ are the *same* Killing
vector fields in both charts, so $E$ and $L_z$ are chart-independent
scalars; (ii) on a circular orbit $dr/d\tau = 0$, so
$u^{t}_{\rm KS} = u^{t}_{\rm BL} + h'(r)\, u^r = u^{t}_{\rm BL}$ and
likewise $\Omega_{\rm KS} = \Omega_{\rm BL}$. Every quantity in the redshift
formula is thus well-defined for hits detected in KS coordinates, with no
transformation applied.

## 7. Relativistic beaming and the $g^4$ law

Along a light ray, the phase-space density of photons is conserved
(Liouville), which in radiometric terms is the invariance of
$I_\nu / \nu^3$ between emission and observation. Consequently:

- **Specific intensity:** $I_\nu^{\rm obs}(\nu_{\rm obs}) = g^3\, I_\nu^{\rm em}(\nu_{\rm obs}/g)$.
- **Bolometric intensity:** integrating over frequency contributes one more
  power: $I^{\rm obs} = g^4\, I^{\rm em}$.
- **Blackbody emission:** since $B_\nu(\nu, T)/\nu^3$ is a function of
  $\nu/T$ alone, a blackbody at $T_{\rm em}$ observed with shift $g$ is
  *exactly* a blackbody at $T_{\rm obs} = g\, T_{\rm em}$.

The disk shader therefore multiplies the local emissivity by $g^4$ and looks
up the color ramp at $g\,T(r)$ — both steps exact consequences of Liouville,
not stylistic choices. The same law with $g_\star = 1/E$ (locally
normalized rays, §9.2 of the plan) applies to the background starfield for
a moving camera in Phase 8.

## References

<span id="ref-bpt-1972">[1]</span> Bardeen, J. M., Press, W. H., & Teukolsky, S. A. (1972). *Rotating Black Holes: Locally Nonrotating Frames, Energy Extraction, and Scalar Synchrotron Radiation.* ApJ, 178, 347. [Link](https://doi.org/10.1086/151796)

<span id="ref-mtw">[2]</span> Misner, C. W., Thorne, K. S., & Wheeler, J. A. (1973). *Gravitation.* W. H. Freeman. (Geodesics as Hamiltonian flow: §25.2; Kerr geometry: ch. 33.)

<span id="ref-chandra">[3]</span> Chandrasekhar, S. (1983). *The Mathematical Theory of Black Holes.* Oxford University Press. (Kerr geodesics: ch. 7; Kerr–Schild form: §58.)

<span id="ref-dngr">[4]</span> James, O., von Tunzelmann, E., Franklin, P., & Thorne, K. S. (2015). *Gravitational lensing by spinning black holes in astrophysics, and in the movie Interstellar.* Class. Quantum Grav., 32, 065001. [Link](https://doi.org/10.1088/0264-9381/32/6/065001)
