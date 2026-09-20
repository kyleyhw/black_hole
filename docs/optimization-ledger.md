# Negative-result ledger — shader optimisation run

Sixteen disconfirmed hypotheses from the four-round evolutionary search over
`src/shaders/render.frag.glsl`, in the form they were handed to each round's explorers.
Every item is a measurement on this target, not an argument. The run's narrative, the
result and the follow-up work are in [optimization-run.md](optimization-run.md).

Two items were later corrected by reviewers and say so in place: item 15 is a RETRACTION of
a negative result that did not survive independent checking, and item 16 carries a caveat
about what it actually bounds. Nothing here should be treated as settled because one agent
measured it once.

---

NINE disconfirmed hypotheses, all MEASURED on this target, not guessed. Do not re-propose a
dead direction; if you touch one, your hypothesis must name exactly what differs this time.
Items 1-5 come from rounds 1-2 (explorer + reviewer work). Items 6-9 are supervisor probes
run on candidate 4's tree between rounds 2 and 3 — throwaway hacks measured with the CPU
quiet, each one full eval, reported here verbatim so no round-3 slot is spent rediscovering
them.

1. DEAD — "eliminate redundant pure sub-expressions". Candidates 2 and 3 both did verified
   bit-exact de-duplication (fusing the double ksRadius solve per stage, hoisting the main
   loop's centre into RK4 stage 1, caching the disk-bisection derivative). Both preserved
   parity at exactly 1.0 and both bought 0% (-0.15% and +2.6%, vs ~0.6% noise). Reason:
   SwiftShader's LLVM EarlyCSE already merges those duplicated pure sqrt/max chains across
   the inlined call tree. Source-level CSE is not a win on this target.

2. DEAD unless bit-exact — any change to the FD probe arithmetic. Candidate 2 reformulated
   the probes in a way verified ALGEBRAICALLY IDENTICAL in f64 (rel diff ~1e-12) and it
   still FAILED the gate (BINARY scene 0.919, Schwarzschild 0.9926). The FD force is
   roundoff-dominated (~3e-5 relative/evaluation); over 200-400 chaotic steps that is
   amplified into ~8% of pixels. Parity-safe probe changes must be BIT-EXACT.

3. ARCHITECTURAL — never put a divergent branch inside the RK4 body. Candidate 1 measured
   all-FD 302 ms, all-analytic 164 ms, and a per-step `if (fd)` branch 370 ms: SwiftShader
   executes BOTH sides under lane masking, so a per-step branch costs the SUM. Any
   specialisation must be hoisted to loop level (two specialised loops), as c1 does.

4. FIXED (do not redo) — the energy sign in `kerrEntersShell`. `pt` is the COVARIANT p_t, so
   E = -pt; R(r) is invariant only under flipping E and L_z TOGETHER. The old `E = pt` and
   its comment claiming the sign is irrelevant evaluated the potential for a hole of spin
   -a, misrouting 159 rays at a=0.998 and 67 at a=0.6. Candidate 4 fixed it and a reviewer
   verified ZERO misroutes over ~26,000 sampled rays per scene. It is already in your parent.

5. DEAD — the analytic disk sub-step deviation flagged on c1. Candidate 5 made `diskCrossing`
   use the SAME force as the parent ray (FD for FD-classified rays). Measured cost: +17.3%
   frame time for ZERO parity gain (0.99965 either way). The sub-steps are local and never
   feed back into the ray state, so the analytic sub-step is the right call. Keep it.

6. DEAD — the procedural sky. `starfield()` (a 3x3 cell loop) and `milkyWay()` (3 fbm3 calls,
   each 4 octaves of trilinear value noise = 96 hash13 per pixel) together cost NOTHING
   measurable. Stubbing `milkyWay()` to zero: 212.5 ms. Stubbing all of `starfield()` to
   zero: 210.4 ms. Control on the same tree in the same session: 210.2 and 207.9 ms. The sky
   is evaluated once per escaped ray; the march is ~400 steps x 4 RK4 stages x (1 or 7)
   metric evaluations, which is three orders of magnitude more work. `milkyWay()` is
   multiplied by the `uSkyRich` uniform, which is 0 in every Kerr bench scene, and guarding
   it with `if (uSkyRich > 0.0)` is pointless for the same reason. Do not touch the sky.

7. DEAD — guarding the disk-plane crossing test with a cheap annulus pre-test. Adding
   `min(r_prev, r) - |dx| <= uDiskOuter && max(r_prev, r) + |dx| >= uDiskInner` (conservative,
   parity exactly unchanged at 0.99965) made it SLOWER: 178.9 ms vs 172.6 ms control. Same
   mechanism as item 3 — the branch is divergent, so a wavefront in which any lane crosses
   the plane still executes the body for all lanes, while the guard's two extra ksRadius
   calls and one length() are paid on EVERY step by EVERY ray. Cheap early-outs in front of
   divergent work are a pessimisation here.

8. DEAD — shrinking the disk bisection's iteration count. Cutting `for (int b = 0; b < 3;`
   to `b < 1` removes two of the four inlined RK4 sub-steps and changed nothing: 174.0 ms
   vs 172.6 ms control. The sub-steps are not where the disk block's cost lives (see the
   round-3 hint for where it does live). Shrinking `diskShade` is equally dead: stubbing
   `diskShade()` to a constant gave 175.3 ms, and stubbing `diskPattern()` gave 172.9 ms.

9. DEAD at this base — forcing the whole frame onto one force evaluation, and widening the
   step. On top of the far-field cap fix described in your hint: forcing every ray analytic
   (`kerrEntersShell` -> false) gives 150.8 ms but parity 0.99293, BELOW the 0.995 gate.
   Raising the displacement fraction 0.1 -> 0.15 in `stepSize` gives 123.4 ms but parity
   0.99103, also below the gate. Both are real speedups that are not equivalent renders, so
   they are not available. Note what this bounds: the entire FD-vs-analytic span is now only
   ~22 ms, so further refinement of `kerrEntersShell`'s classifier is nearly exhausted.

--- Added after round 3 (measured by explorers and by their reviewers) ---

10. DEAD — hunting loop-carried live values in the march loop. Candidate 9 removed `xPrev`
    and `pPrev` entirely (carrying only the scalar `zPrev` and re-anchoring the bisection at
    the step's END, walking backward). Its reviewer verified the rewrite is an exact
    structural mirror and parity is bit-identical, and it was SLOWER: +4.8% on the
    explorer's own contention-matched control, +6.6% on the supervisor's quiet-CPU
    interleave (181.8 vs candidate 7's 170.6). The reviewer also refuted the explorer's
    proposed mechanism: `x` and `p` are loop-carried in the parent too and are therefore
    already live across the whole disk block there, while `xa = xPrev` coalesces to zero
    instructions, so peak pressure inside the block is identical either way. The ~123 ms
    that merely HAVING the disk block compiled into the loop costs is the four inlined RK4
    sub-steps as compiled CODE, not register spilling from loop-carried state. This is
    over-determined: the supervisor's own probe "bisection -> one linear interpolation"
    removed ~79 of those 123 ms with `xPrev`/`pPrev` still fully live.

11. DEAD — widening the far-field displacement FRACTION. Candidate 7 measured the change
    that error equidistribution actually demands, frac ~ (eps r/M)^(1/5) i.e. growing as
    r^0.2: 74.4 -> 72.5 steps per ray, 2.6%, truncation error unchanged. The 0.1 fraction's
    shape was already right; only its absolute ceiling was wrong, and that is now fixed.

12. DORMANT, not live logic — candidate 8's Fritsch-Carlson limiter. Its reviewer measured
    the two tangent scale factors staying inside [0.998, 1.001] in every configuration it
    could construct, including near-tangential crossings, so the cubic is a sub-per-mille
    perturbation of the chord and the limiter NEVER activates. It is a correct backstop.
    Do not build an optimisation that assumes it does anything, and do not remove it on the
    grounds that it never fires.

13. DEAD — removing the `steps` counter. It equals the loop induction variable `i` at every
    exit, but GLSL ES scopes `i` to the `for` statement, so eliminating `steps` means
    hoisting `i` to an outer int. That is a rename, not a freed register.

14. See item 1 before touching this: the march loop's step-size block and RK4 stage k1 both
    evaluate `metricTerms` at the SAME `x` every step. Candidate 9's reviewer flagged it as
    the loop's real duplication. Item 1 already measured source-level de-duplication of
    exactly this kind at 0% on this target, because LLVM's EarlyCSE gets there first. If you
    propose it anyway, say what differs.

15. RETRACTED — "the far-field asymptotic handoff is dead". Candidate 12 asserted this and
    it did NOT survive review. Its reviewer built an independent f64 replica (validated:
    H null to 1.7e-16, analytic force against a central difference of H to 4e-9, the
    Schwarzschild deflection series reproduced to four digits) and refuted the load-bearing
    step. Candidate 12 treated lp = l.p - p_t as O(E); it is not. `l` is the INGOING
    principal null direction, so an escaping ray has l^mu p_mu -> 0, and lp decays as 1/r^2
    (measured -1.13e-2 at r = 70 falling to -1.52e-3 at r = 190). The frame-dragging piece of
    `l` therefore reaches the direction multiplied by f*lp and contributes 9.35e-6 rad at
    r = 70, falling as 1/r^4 — the SAME rate as the mass tail and subdominant to it, not two
    orders slower. The claimed 2 M a (1/R_H^2 - 1/R_ESCAPE^2) is b-independent and
    sign-definite and was never observed: the measured residual turn over 7 geometries x 3
    spins is 3.4e-5 to 9.0e-5 rad, always within ~25% of the mass law, with the spin part
    ~20% and FLIPPING SIGN between prograde and retrograde, as any frame-dragging term must.
    Two tells candidate 12 already held: its linearity check varied only `a` and never the
    sense of angular momentum, which is the one control that separates a frame-dragging term
    from a coefficient error; and differencing the exact gauge term removed only 10-20% of
    the residual, which should have removed nearly all of it if the residual were that term.

    SO THE SLOT IS OPEN, not dead. With candidate 12's own (correct) mass-tail correction
    dTheta/dr = 3 M b^3/r^5 -> (3/4) M b^2 (1/r^4 - 1/R_ESCAPE^4) b_perp, confirmed to ~1%,
    the handoff error at R_H = 70 M is 4.5e-7 rad at a = 0, 6.4e-6 prograde and 8.2e-6
    retrograde at a = 0.6, and 1.04e-5 / 1.39e-5 at a = 0.998; at R_H = 100 M it is inside
    3e-6 even at a = 0.998. A handoff at 70 M removes about 11 of 74.4 steps per ray, ~15%,
    at a cost of ~0.1% of pixels, i.e. parity ~0.999 against a 0.995 gate. Candidate 12 was
    rejected partly because it would have written the false law, and the directive "both
    were measured dead", permanently into the shader.

16. THE FAR FIELD IS NEARLY A BIT-EXACTNESS PRISON — sound, and independently reproduced,
    but read the last sentence. Candidate 12 calibrated the gate's sensitivity by porting
    `starfield()` + ACES + gamma to f64; its reviewer reproduced the whole curve with an
    independent numpy port, including its odd plateau between 1e-5 and 3e-5:

      rotation  3e-6   1e-5     3e-5     7e-5    1e-4
      explorer   0%    0.094%   0.10%    1.4%    3.2%
      reviewer   0%    0.097%   0.116%   1.19%   2.74%

    The geometry checks out analytically: pixel 9.62e-3 rad, brightest star point-spread
    radius 1.985e-2 rad, cube cell 3.93e-3 rad, 3x3 half-window 5.89e-3 rad, so roughly the
    brightest 32% of stars are hard-clipped at the window edge and pop in and out. CAVEAT
    THAT MATTERS: 0.1% of pixels flipped is parity 0.999, which is comfortably ABOVE the
    0.995 gate. This item bounds BIT-EXACTNESS, not gate-passing. Candidate 12's self-imposed
    3e-6 budget was ~10x stricter than the gate requires, and that over-strict budget is part
    of what made its own slot look dead.
