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

## 8. Camera tetrads, local-frame rays, and free fall

The coordinate-covector camera (§4) is replaced in Phase 8 by proper
local-frame ray initialization. An observer with 4-velocity $u$ carries an
orthonormal tetrad $\{e_{(0)}, e_{(1)}, e_{(2)}, e_{(3)}\}$,
$g(e_{(A)}, e_{(B)}) = \eta_{(A)(B)}$, with $e_{(0)} = u$.

**Construction.** Seed the spatial legs with the flat camera basis
(right, up, forward) and Gram–Schmidt them against $u$ and each other
*under the full metric g*:

$$v' = v + g(v, u)\, u \;\; (\text{projection orthogonal to } u,\ g(u,u) = -1),
\qquad e_{(i)} = \frac{v'_i - \sum_{j<i} g(v'_i, e_{(j)})\, e_{(j)}}
{\sqrt{g(\cdot,\cdot)}}.$$

A 4×4 Gram–Schmidt per frame on the CPU; the tetrad enters the shader as
uniforms.

**Ray initialization.** For a pixel whose view direction in the camera
frame is the unit 3-vector $\hat n$, the *arriving* photon propagates along
$-\hat n$ locally, with local angular frequency normalized to 1:

$$p_{\rm arr}^\mu = e_{(0)}^\mu - n^i e_{(i)}^\mu .$$

This is exactly null by orthonormality ($g(p,p) = -1 + |\hat n|^2 = 0$) —
no quadratic to solve, no root to select. The traced (past-directed) ray is
$q = -p_{\rm arr}$, i.e.

$$q^\mu = -e_{(0)}^\mu + n^i e_{(i)}^\mu, \qquad q_\mu = g_{\mu\nu} q^\nu .$$

Unlike the §4 normalization, $q_t$ now varies across pixels (it is still
constant along each ray); the integrator carries it as a per-ray constant.
The locally measured energy is normalized exactly:
$E_{\rm loc} = -p_{\rm arr} \cdot u = 1$.

**Consistency with §4:** for a static camera both constructions produce
valid null rays, but they parameterize the image differently — the tetrad
camera measures *proper* angles. The correct regression is therefore not
pixel-identity with the old camera but agreement with the local-frame
shadow formula: for Schwarzschild,
$\sin\theta_{\rm sh} = (3\sqrt3\, M/r_0)\sqrt{1 - 2M/r_0}$, which the §4
camera misses by 18% at $r_0 = 18M$ and the tetrad camera must hit.

**Static observer.** At rest in KS coordinates,
$u^\mu = \delta^\mu_t / \sqrt{-g_{tt}}$ with $-g_{tt} = 1 - f > 0$: static
observers exist only **outside the ergosphere** ($f < 1$). The camera's
zoom clamp (r ≥ 2.2 M > 2 M ≥ r_E) guarantees this for the orbit camera.

**Moving observer (the interactive orbit as a worldline).** Rather than a
sequence of static snapshots, the dragged camera is treated as a genuine
observer with coordinate 3-velocity $v^i = dx^i/dt$ (Cartesian, finite-
differenced from its per-frame motion). Its 4-velocity is
$u^\mu = u^t(1, v^i)$, and $g(u,u) = -1$ fixes $u^t$. In Kerr–Schild form
($g_{\mu\nu} = \eta_{\mu\nu} + f\,l_\mu l_\nu$, $l_t = 1$),

$$g(u,u) = (u^t)^2\big[-1 + |v|^2 + f\,(1 + \mathbf l\!\cdot\!\mathbf v)^2\big]
= -1
\;\Longrightarrow\;
u^t = \frac{1}{\sqrt{\,B\,}}, \quad
B \equiv 1 - |v|^2 - f\,(1 + \mathbf l\!\cdot\!\mathbf v)^2 .$$

$v = 0$ gives $B = 1 - f$ and recovers the static observer exactly, so a
camera at rest renders identically. The tetrad's Gram–Schmidt against
$e_{(0)} = u$ then tilts the spatial legs, producing **aberration and
Doppler** ($g_\star = 1/q_t$ shifts with the direction of motion) with no
extra machinery. This is a *stationary/accelerated* observer, not a geodesic
— a real observer with an engine — which is exactly what an arbitrarily-
steered camera is.

**Mapping a drag to a velocity (rendering layer).** Timelike-ness requires
$B > 0$, but a hand-drag is wildly superluminal in coordinate units: under
the ~1-second-$\approx$-1-$M$ mapping a camera at $r = 18M$ swept even
gently moves at 3–20 $c$ (measured). Feeding a raw per-frame finite
difference to $u$ fails in three measured ways: *binary saturation* (any
touch pegs the cap), *one-frame snaps* at gesture start and release
(≈0.5 $c$ per frame), and a *sawtooth* at the pointer-event cadence, since
input events do not land on every frame. The estimator therefore has four
stages, each tied to one failure mode:

1. **Sliding-window derivative** (0.32 s): $v_{\rm raw}$ is the position
   difference across a window *longer than the slowest pointer cadence*, so
   individual event steps bridge rather than spike; eviction always keeps
   one sample straddling the window edge so the derivative survives frame
   periods longer than the window (slow devices).
2. **Time-constant EMA** ($\tau = 0.15$ s, $k = 1 - e^{-\Delta t/\tau}$):
   fps-independent smoothing — no single-frame jumps at any refresh rate.
3. **Gesture gating**: the estimator runs while the pointer is down and for
   0.6 s after the last user input, so the velocity decays smoothly through
   the release coast instead of snapping to zero; programmatic camera writes
   (tests, presets, resets) are not motion — they render static, and any
   one-frame jump > 1.5 M outside a live gesture clears the estimator.
4. **Saturating map** $|v| \mapsto V_{\max}\tanh(|v|/V_{\rm ref})$ with
   $V_{\max} = 0.25$ and $V_{\rm ref} = 10\,M/\text{s}$ — chosen *inside*
   the real drag-speed range, so a slow drag gets mild aberration
   (~0.05–0.1 $c$) and only a fast sweep approaches the cap (~14° maximal
   aberration at screen center).

The $B \ge B_{\min}$ floor inside `movingObserver` then only ever acts as a
numerical backstop. $V_{\max}$ and $V_{\rm ref}$ are feel parameters, not
physics — the observer is a genuine timelike worldline at whatever speed
the map assigns, and $v = 0$ recovers the static observer exactly.

**Free fall.** Release from rest means initial $u^i = 0$,
$u^t = 1/\sqrt{-g_{tt}}$ — again requiring an exterior starting point; the
UI disables release inside the ergosphere. The subsequent worldline solves
the *timelike* branch of the same Hamiltonian flow,

$$H = \tfrac12 g^{\mu\nu} p_\mu p_\nu = -\tfrac12 \;(m = 1), \qquad
p_\mu = g_{\mu\nu} u^\nu,$$

integrated per frame on the CPU with the same RK4 + FD-gradient scheme
(a TypeScript mirror of the shader RHS). The same state reduction as for
null rays applies: $p_t$ is conserved (it *is* minus the orbital energy),
so the state is again $(x^i, p_i)$ with $p_t$ a constant set at release:
$p_t = g_{tt} u^t = -\sqrt{-g_{tt}}$. Frame dragging then induces azimuthal
drift automatically through $g^{i\nu} p_\nu$. The plunge terminates (and
the camera resets) at $r \le 1.05\, r_+$.

**Validation (a = 0).** Radial free fall from rest at $r_0$ in
Schwarzschild obeys the cycloid solution

$$r = \frac{r_0}{2}(1 + \cos\eta), \qquad
\tau = \sqrt{\frac{r_0^3}{8M}}\,(\eta + \sin\eta),$$

against which the integrated $r(\tau)$ is compared (Phase 8 validation
task). In KS coordinates the *coordinate* time differs from Schwarzschild
$t$, but proper time $\tau$ and the KS/Schwarzschild radius agree, so the
comparison is chart-safe.

## 9. Redshifted starfield

With tetrad-initialized rays ($E_{\rm loc} = 1$), consider a photon emitted
by a distant static star. Its conserved energy-at-infinity is
$E = -p_{{\rm arr},t} = q_t$, and the star's emission frame coincides with
the asymptotic static frame, so

$$g_\star \equiv \frac{\nu_{\rm obs}}{\nu_{\rm em}}
= \frac{E_{\rm loc}}{E} = \frac{1}{q_t}\quad\text{per pixel}.$$

Applied to the procedural stars exactly as the disk's $g$ (§7): temperature
$T_{\rm obs} = g_\star T_{\rm em}$ (blackbody shape preserved), bolometric
brightness $\times\, g_\star^4$.

Limit checks (all implemented as tests):
- distant static camera: $q_t \to 1$, no shift;
- static camera at finite $r$: $g_\star = 1/\sqrt{-g_{tt}} > 1$ — the sky
  is gravitationally *blueshifted* for a deep static observer, as it must
  be (infalling light gains energy);
- infalling camera: forward-sky blueshift and aberration concentration,
  rear-sky redshift.

## 10. Weak-field multi-mass mode

A separate, clearly labeled **linearized-gravity** mode with $N$ point
masses. To linear order in the potentials, a static mass distribution has

$$g_{00} = -(1 + 2\Phi), \qquad g_{ij} = (1 - 2\Phi)\,\delta_{ij},
\qquad g_{0i} = 0, \qquad
\Phi(\vec x) = -\sum_k \frac{M_k}{|\vec x - \vec x_k|},$$

valid for $|\Phi| \ll 1$. Because the metric is diagonal, the inverse is
immediate and the null Hamiltonian becomes

$$H = \tfrac12\left[-\frac{p_t^2}{1 + 2\Phi}
      + \frac{|\vec p\,|^2}{1 - 2\Phi}\right].$$

The same RK4 + central-difference machinery integrates it — only the
scalar $H(x,p)$ changes, which is the point of the Hamiltonian design.

**Ray initialization.** The spacetime is static (not merely stationary), so
time orientation is irrelevant to imaging and no tetrad is needed for a
static camera: set $\vec p = \hat n$ and solve $H = 0$:

$$p_t = |\hat n| \sqrt{\frac{1 + 2\Phi}{1 - 2\Phi}} .$$

**Superposition is a linear-order statement.** Adding the $\Phi$'s of
several masses solves the linearized field equations only; quadratic
corrections $O(\Phi^2)$ are dropped. The UI therefore shows a validity
indicator (the largest pairwise $(M_i + M_j)/|\vec x_i - \vec x_j|$, plus
the camera's own $|\Phi|$) and warns above $0.1$.

**No horizons exist in this metric** — $\Phi$ diverges at each point mass
and the linearization fails long before that. Rays are terminated at the
would-be Schwarzschild radius $|\vec x - \vec x_k| < 2 M_k$ and shaded
black; this is a *regularization of a broken approximation*, not a horizon.

**Validation target.** The classic weak-field deflection of a ray with
impact parameter $b$ past a single mass:

$$\alpha = \frac{4M}{b} + O\!\left(\frac{M^2}{b^2}\right),$$

checked over $b \in [10, 10^3]\,M$ (log–log slope $-1$, coefficient 4),
plus far-field additivity for two separated masses.

## 11. Superposed Kerr–Schild metric for binaries

Merger mode (PROJECT_PLAN §10) renders two black holes with the metric

$$g_{\mu\nu} = \eta_{\mu\nu} + f_1\, l^{(1)}_\mu l^{(1)}_\nu
            + f_2\, l^{(2)}_\mu l^{(2)}_\nu,$$

each term the Kerr–Schild data of one hole evaluated in coordinates
centered on (and boosted with) that hole's instantaneous position and
velocity. Superposed Kerr–Schild data is a standard construction for
binary-black-hole initial data in numerical relativity
[[5]](#ref-marronetti-2000); it is **not** an exact solution — the Einstein
tensor picks up cross terms of order $f_1 f_2 \sim M_1 M_2 / (r_1 r_2)$ —
but each single-hole limit is exact, and the error is controlled at
separation $d$: $\mathcal{O}(M_1 M_2 / d)$ near either hole.

**Boost.** A single boosted KS hole is still exact: apply the Lorentz map
$\Lambda(v)$ of the hole's instantaneous coordinate velocity to the rest-
frame $(f, l_\mu)$, i.e. evaluate $f$ and $l$ at the boosted-back point and
transform the covector, $l_\mu \to \Lambda^\nu{}_\mu\, l_\nu$. Using the
*instantaneous* velocity neglects acceleration over a light-crossing time —
a labeled approximation on top of the superposition error.

**Exact inverse by two Sherman–Morrison updates.** For a rank-1 update
$A + c\, w w^{\!\top}$,

$$(A + c\, w w^{\!\top})^{-1} = A^{-1}
 - \frac{c\, (A^{-1} w)(A^{-1} w)^{\!\top}}{1 + c\, w^{\!\top} A^{-1} w}.$$

Apply it twice. First with $A = \eta$, $w = l^{(1)}$: since $l^{(1)}$ is
$\eta$-null, $l^{(1)\top}\eta^{-1}l^{(1)} = 0$ and

$$A_1^{-1} = \eta^{-1} - f_1\, l_{(1)}^{\ \mu} l_{(1)}^{\ \nu}$$

— the familiar exact single-KS inverse (§2). Second with $A = A_1$,
$w = l^{(2)}$:

$$g^{-1} = A_1^{-1}
 - \frac{f_2\,(A_1^{-1} l^{(2)})(A_1^{-1} l^{(2)})^{\!\top}}
        {1 + f_2\, l^{(2)\top} A_1^{-1} l^{(2)}},
\qquad
l^{(2)\top} A_1^{-1} l^{(2)} = -f_1 \big(l_{(1)}\!\cdot l^{(2)}\big)^2,$$

where the last equality uses the $\eta$-nullity of $l^{(2)}$ and
$l_{(1)}\!\cdot l^{(2)} \equiv l_{(1)}^{\ \mu} l^{(2)}_\mu$. The
denominator is therefore

$$D = 1 - f_1 f_2 \big(l_{(1)}\!\cdot l^{(2)}\big)^2 .$$

$D \to 0$ requires $f_1 f_2 \gtrsim 1$, i.e. both holes' potentials strong
at the same point — deep in the two-horizon overlap, always inside the
capture region during inspiral. The implementation guards $D$ with a floor
and treats $D < D_{\min}$ as captured. Closed-form inverse means the
Hamiltonian, RK4, and finite-difference-gradient machinery (§3, §5) carry
over unchanged — only the scalar $H(x, p)$ differs, as in the weak-field
mode (§10).

**Transport caveat (frozen metric).** The binary metric depends on $t$
through the moving centers, so $\partial H/\partial t \neq 0$ and $p_t$ is
no longer conserved along rays. Real-time rendering uses the standard
frozen-metric approximation — each frame traces null geodesics of the
*instantaneous* metric snapshot. The neglected effect is of order (light-
crossing time of the scene) / (orbital period); it grows toward merger and
is labeled in the UI and README. Honest time-dependent transport
(integrating $t$ and $p_t$ with four-dimensional finite-difference
gradients) is specified as Phase 18, decision deferred.

**Validation targets.** (i) $g \cdot g^{-1} = \mathbb{1}$ to machine
precision at random field points; (ii) $M_2 \to 0$ reduces every metric
component and traced ray to the single-Kerr results of `kerr.py`;
(iii) far-field deflection of two well-separated holes matches the
weak-field mode's additive $\sum_k 4 M_k / b_k$.

## 12. Post-Newtonian inspiral and the chirp

**Phasing.** Quasi-circular TaylorT4 evolution of the PN parameter
$x \equiv (M \omega_{\rm orb})^{2/3}$, mass ratio $\nu = m_1 m_2 / M^2$,
$M = m_1 + m_2$:

$$\frac{dx}{dt} = \frac{64\,\nu}{5\,M}\, x^5 \Big[ 1 + c_1 x + c_{3/2}
x^{3/2} + c_2 x^2 + \dots + c_{7/2} x^{7/2} \Big],$$

with the nonspinning coefficients through 3.5PN transcribed from Boyle et
al. (2007) [[6]](#ref-boyle-2007) (not re-derived here; transcription is
checked by the convergence and chirp-time validations below). Aligned spin
enters at leading (1.5PN spin-orbit) order via
$c_{3/2} = 4\pi - \beta$ with

$$\beta = \frac{113}{12}\,\frac{m_1^2 \chi_1 + m_2^2 \chi_2}{M^2}
        + \frac{25}{4}\,\nu\,\frac{m_1\chi_1 + m_2\chi_2}{M},$$

evaluated with $\chi_1 = \chi_2 = \chi_{\rm eff}$ (the catalog's
best-measured spin combination; higher-order spin terms neglected — the
chosen events have $|\chi_{\rm eff}| \le 0.25$, and the visual/audio effect
of the omission is far below the schematic-blend error). Orbital phase from
$d\varphi/dt = \omega_{\rm orb} = x^{3/2}/M$; GW frequency
$f_{\rm GW} = \omega_{\rm orb}/\pi$ (quadrupole, $m = 2$).

**Chirp mass and the leading-order chirp time.** With
$\mathcal{M} = (m_1 m_2)^{3/5} / M^{1/5} = M \nu^{3/5}$, keeping only the
leading term of $dx/dt$ integrates in closed form to the time to
coalescence from GW frequency $f$:

$$\tau(f) = \frac{5}{256}\, \mathcal{M}^{-5/3}\, (\pi f)^{-8/3}.$$

**Detector frame.** Observed frequencies scale with the *redshifted*
masses: a source at redshift $z$ chirps as a binary of masses $(1+z)\,m$.
The catalog stores source-frame masses and $z$; the audio synthesis uses
$(1+z)\,m$ so the chirp matches what the detectors heard, while the panel
displays source-frame values. For GW150914 (source
$\mathcal{M} \approx 28.6\,M_\odot$, $z \approx 0.09$, detector-frame
$\mathcal{M} \approx 31\,M_\odot$) the leading-order formula gives
$\tau(35\ \text{Hz}) \approx 0.16$ s — already the observed $\sim 0.2$ s of
loud signal. The validation suite integrates the full series and checks
both the low-frequency agreement with $\tau(f)$ and the PN-order
convergence of the accumulated phase.

**Separation for visuals.** $r = (M/\omega_{\rm orb}^2)^{1/3}$ — the
Newtonian (Kepler) inversion, labeled as such; PN corrections to the
$r(\omega)$ map affect the *displayed* separation at the few-percent level
in the strong field and are dominated by the schematic merger blend anyway.
Hole positions on circles about the center of mass with radii
$r_{1,2} = (m_{2,1}/M)\, r$.

**Waveform for audio.** Restricted (quadrupole) inspiral amplitude,

$$h(t) \propto \mathcal{M}^{5/3} f_{\rm GW}^{2/3}(t)\,
\cos 2\varphi_{\rm orb}(t),$$

blended $C^1$ into the ringdown of §13. The overall amplitude is a volume
knob (we are not modeling the detector response); the *frequency
evolution* is the physics, and it is asserted numerically by an FFT of the
rendered audio buffer against the TaylorT4 sweep.

**Plunge blend schedule (schematic, labeled; Phase 15 implementation).**
When the PN description ends at the ISCO the animation blends to the
remnant over $T_{\rm plunge} = 1.5$ ISCO orbital periods (NR mergers take
roughly one orbit from ISCO to peak). With $s \in [0,1]$ the blend
parameter and $w(s) = 3s^2 - 2s^3$:
separation follows a $C^1$ Hermite from $r = 6$ (slope matched to the PN
$\dot r = -\dot x/x^2$ at ISCO) to $0$ with zero end slope; the orbital
rate ramps from $\omega_{\rm ISCO}$ to the $r = 2.2\,M$ Kepler rate (a cap
of order the light-ring rate — unbounded Kepler $\omega \to \infty$ as
$r \to 0$ would alias); total mass sheds the radiated fraction,
$M(s) = M[1 + (M_f/M - 1)w]$, and both spins blend to $a_f$. At $s = 1$
the two holes are coincident and aligned, and a coincident aligned
superposition is *exactly* a single Kerr hole
($f_1 l l + f_2 l l = (f_1{+}f_2) l l$), so the swap to the remnant (hole 1
with $M_2 = 0$, the validated single-hole limit) is seamless by
construction rather than by tuning. None of this interval is a solution of
the field equations — it is the labeled bridge across the one regime where
only numerical relativity is honest.

**Time mapping (design decision, owner-approved).** Near merger
$f_{\rm GW}$ exceeds 100 Hz; at a 60 fps display any true-rate rendering of
the orbit temporally aliases (Nyquist for visual rotation is 30 cycles/s).
The animation therefore runs the *visuals* in slow motion (adjustable
factor, with true-vs-displayed time shown), while the *audio chirp plays at
the true rate*, started so it completes exactly at the visual merger — the
sound is the physical timescale, the picture is a legible one, and the two
are phase-locked to the same $\varphi(t)$.

## 13. Remnant and ringdown

The remnant is rendered as exact Kerr with the **published** final mass and
spin $(M_f, a_f)$ of each catalog event — no remnant fit of our own. The
audio ringdown uses the fundamental $(\ell, m, n) = (2, 2, 0)$ quasinormal
mode of that remnant, with frequency and quality factor from the
Berti–Cardoso–Will fits [[7]](#ref-berti-2006):

$$M_f\, \omega_R = 1.5251 - 1.1568\,(1 - a_f)^{0.1292}, \qquad
Q = 0.7000 + 1.4187\,(1 - a_f)^{-0.4990},$$

$$h_{\rm ring}(t) \propto e^{-t/\tau_{\rm ring}}
\cos(\omega_R t + \phi_0), \qquad
\tau_{\rm ring} = \frac{2 Q}{\omega_R}.$$

For GW150914's remnant ($M_f \approx 63\,M_\odot$, $a_f \approx 0.69$)
these fits give $f_{\rm QNM} = \omega_R / 2\pi \approx 250$ Hz and
$\tau_{\rm ring} \approx 4$ ms — the published ringdown numbers, which the
validation suite asserts. The inspiral-to-ringdown join (frequency and
amplitude) is a $C^1$ schematic blend over the final $\sim$orbit: the one
regime where neither PN nor perturbation theory applies, and honestly
labeled — numerical relativity is the only correct tool there.

## References

<span id="ref-bpt-1972">[1]</span> Bardeen, J. M., Press, W. H., & Teukolsky, S. A. (1972). *Rotating Black Holes: Locally Nonrotating Frames, Energy Extraction, and Scalar Synchrotron Radiation.* ApJ, 178, 347. [Link](https://doi.org/10.1086/151796)

<span id="ref-mtw">[2]</span> Misner, C. W., Thorne, K. S., & Wheeler, J. A. (1973). *Gravitation.* W. H. Freeman. (Geodesics as Hamiltonian flow: §25.2; Kerr geometry: ch. 33.)

<span id="ref-chandra">[3]</span> Chandrasekhar, S. (1983). *The Mathematical Theory of Black Holes.* Oxford University Press. (Kerr geodesics: ch. 7; Kerr–Schild form: §58.)

<span id="ref-dngr">[4]</span> James, O., von Tunzelmann, E., Franklin, P., & Thorne, K. S. (2015). *Gravitational lensing by spinning black holes in astrophysics, and in the movie Interstellar.* Class. Quantum Grav., 32, 065001. [Link](https://doi.org/10.1088/0264-9381/32/6/065001)

<span id="ref-marronetti-2000">[5]</span> Marronetti, P., & Matzner, R. A. (2000). *Solving the Initial Value Problem of Two Black Holes.* Phys. Rev. Lett., 85, 5500. [Link](https://doi.org/10.1103/PhysRevLett.85.5500) — superposed Kerr–Schild data for binaries.

<span id="ref-boyle-2007">[6]</span> Boyle, M., et al. (2007). *High-accuracy comparison of numerical relativity simulations with post-Newtonian expansions.* Phys. Rev. D, 76, 124038. [Link](https://doi.org/10.1103/PhysRevD.76.124038) — TaylorT4 coefficients.

<span id="ref-berti-2006">[7]</span> Berti, E., Cardoso, V., & Will, C. M. (2006). *Gravitational-wave spectroscopy of massive black holes with the space interferometer LISA.* Phys. Rev. D, 73, 064030. [Link](https://doi.org/10.1103/PhysRevD.73.064030) — (2,2,0) QNM frequency/quality fits.

<span id="ref-gwtc21">[8]</span> Abbott, R., et al. (LIGO–Virgo Collaboration) (2024). *GWTC-2.1: Deep Extended Catalog of Compact Binary Coalescences.* Phys. Rev. D, 109, 022001. [Link](https://doi.org/10.1103/PhysRevD.109.022001) — event parameters, via the [GWOSC event portal](https://gwosc.org/eventapi/).

<span id="ref-peters-1964">[9]</span> Peters, P. C. (1964). *Gravitational Radiation and the Motion of Two Point Masses.* Phys. Rev., 136, B1224. [Link](https://doi.org/10.1103/PhysRev.136.B1224) — leading-order inspiral decay.
