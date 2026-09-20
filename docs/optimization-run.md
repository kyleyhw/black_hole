# Shader optimisation run — evolutionary search over `render.frag.glsl`

A four-round evolutionary search (agent-evolve) over the Kerr null-geodesic fragment
shader, run with an explorer/reviewer protocol on isolated worktrees. The physics is
unchanged: same metric, same integrator order, same termination law. Only the arrangement
of the computation changed.

## Result

| | frame_ms | vs anchor |
|---|---|---|
| anchor (`a84379f`) | 341.6 | — |
| winner, as applied to this branch | **67.6** | **−80.2%** |

The merger frame, which the metric never times, went from 432.6 ms to 350.7 ms (−19%) as a
side effect of the phase13 fix below.

`frame_ms` is the median wall time of one full synchronous frame on a fixed Kerr scene
(a = 0.6, disk on, 160×120 internal, 400 steps) under headless SwiftShader. There is no GPU
in the harness: SwiftShader executes the same shader on the CPU, so the number is a fair
*relative* proxy for shader cost and the absolute value does not transfer to real hardware.

Behaviour gate: `pixel_parity` = the fraction of pixels within 8/255 of committed reference
renders, minimised over four deterministic scenes. The winner holds 0.99965, identical to
the anchor's lineage on every scene (0.99987 / 0.99973 / 0.99965 / 1.0).

## What actually produced the speedup

Four changes survived, in the order they were found.

| round | change | frame_ms | share of total gain |
|---|---|---|---|
| 2 | loop-level analytic/finite-difference specialisation per ray, plus an energy-sign fix | 210.2 | 48% |
| 3 | far-field step ceiling: an absolute cap of 4 M replaced by the rule's own ceiling | 170.6 | 15% |
| 3 | disk-hit resolution by cubic Hermite interpolation instead of four RK4 sub-steps | 104.6 | 24% |
| 4 | disk shading hoisted out of the march loop into a post-loop replay | 68.2 | 13% |

Three of the four are about what is *compiled into the march loop body*, not about
arithmetic. That is the run's central technical finding and it was not the hypothesis any
round started from.

## The measurement problem, and how it was handled

The first baseline measured 291.9 ms; the same anchor later measured 341.1, 341.5, 343.4,
341.6 and 340.0 ms in five separate sessions. The machine itself drifts between sessions by
more than most candidates' effects. Cross-session comparison is therefore invalid, and it
produced one false regression early in the run.

Every result quoted here comes from an **interleaved same-conditions remeasurement**:
`[anchor, *candidates] × N` repeats, one evaluation at a time on an otherwise idle machine,
cycled so drift hits every arm equally, with every repeat recorded and none discarded. Five
such sweeps were run; all repeats are stored in `evolve-state/1/remeasure.json`.

The noise floor was measured, not assumed. Candidate 12 is a comments-only diff that cannot
differ from its parent in any executed instruction, and it moved 0.96% in the same
interleave in which candidate 10 moved 2.10%. That is what let candidate 10 be correctly
called a null rather than a small win.

## What the gate could not see

`pixel_parity` was a weak instrument and grew weaker as the run went on. In round 3 three
candidates carrying three completely different disk-crossing schemes returned *identical*
per-scene parity to five decimals. The gate supplied no discriminating evidence about any
of them.

Reviewers closed that gap by rendering off-benchmark scenes with controls, and it changed
conclusions twice. Two structural blind spots are worth recording:

* **The benchmark's four scenes render only two of the four compiled shader variants.**
  `weakProg` and `retardedProg` are never rendered by any scene. The eval proves all four
  compile; it verifies the rendered output of two. The harness header claimed otherwise and
  that claim was repeated to every agent for four rounds.
* **The four scenes use the default disk orientation and camera radii of 14 and 18 M**,
  while the application allows a tilted disk and a camera out to 60 M.

A useful calibration came out of it: the procedural starfield is discontinuous at its
cube-cell boundaries (~4×10⁻³ rad) and the brightest stars' point-spread radius exceeds the
sampling window, so a sky-direction change of only 10⁻⁵ rad already flips ~0.1% of pixels
past 8/255. The far field is close to a bit-exactness prison. Note this bounds bit-exactness
rather than gate-passing: 0.1% flipped is parity 0.999, still above the 0.995 gate.

## The disconfirmed hypotheses

The run's negative-result ledger reached 16 items, each measured rather than argued. The
ones that cost the most to learn:

1. **Source-level elimination of duplicate pure sub-expressions buys nothing.** Two round-1
   candidates did verified bit-exact de-duplication and measured −0.15% and +2.6%. LLVM's
   EarlyCSE already merges those chains.
2. **Divergent branches cost the sum of both paths.** A per-step `if` inside the integrator
   measured 370 ms against 302 all-finite-difference and 164 all-analytic. A cheap guard
   placed *in front of* divergent work is a pessimisation: an annulus pre-test that skipped
   real work made the frame slower.
3. **The march loop is not spill-bound.** Removing six loop-carried floats made it 6.6%
   slower. The residual cost tracks what is compiled inside the loop body; code outside it
   is nearly free.
4. **The procedural sky is free.** Stubbing the entire starfield changed nothing — the
   march is three orders of magnitude more work.

## A physics bug the search found by accident

The round-1 specialisation classified each ray using the Kerr radial potential and wrote
`float E = pt`. But `pt` is the *covariant* p_t, so E = −p_t. The potential
R(r) = ((r²+a²)E − aL_z)² − Δ((L_z−aE)² + Q) is invariant only under flipping E and L_z
*together*; the a·E·L_z cross term is odd. The code was therefore evaluating the potential
for a hole of spin −a.

A reviewer quantified it against integrated ground truth: 159 rays per frame misrouted at
a = 0.998 and 67 at a = 0.6, with the worst missed pericenter at r = 0.864 — a ray that
plunges through the horizon being integrated as though it stayed clear of the photon shell.
At a = 0 the bug vanishes, because the cross term does. The parity gate was passing anyway,
by luck. With the sign corrected, zero misroutes over ~26,000 sampled rays per scene.

## The regression this run introduced, and how it was fixed

`e2e/phase13.cjs` asserts a designed invariant: binary mode with the second mass set to zero
must render **pixel-identical** to plain Kerr mode, because the BINARY branches are built to
reduce bit-for-bit when the second hole's f vanishes. That broke in round 2 and stayed broken
through the winner (anchor 0, every later tree 0.0244 against a 0.1% tolerance).

Two differences caused it, and measurement showed **both** were needed — neither alone
restored the limit:

| configuration | phase13 parity_diffFrac |
|---|---|
| winner as it stood | 0.02439 |
| binary step ceiling matched only | 0.02229 |
| generic force on both sides only | 0.02188 |
| both | **0** |

The fix is two parts, neither of which costs frame time.

**1. The BINARY march's own step ceiling, `4.0` -> `0.1 * R_ESCAPE`.** Its step rule already
uses the same r-based guide as `stepSize()`, so the same argument applies: an absolute length
in a scale-free rule bound for every ray beyond r ~ 40 M and bought no accuracy. Rendering
the merger frame against a converged reference (displacement fraction 0.02, 1000 steps) shows
the new ceiling is marginally *closer* to converged, not further — 9.61% of pixels beyond
8/255 versus 9.86%. It also makes merger mode **19% faster**: 432.6 ms -> 350.7 ms on the
benchmark's merger frame, which `frame_ms` never sees because it times a plain-Kerr scene.

**2. The comparison now runs from r_cam = 4 M instead of 30 M.** This is the part that
matters conceptually. The BINARY march always evaluates the force by finite difference, while
plain Kerr now specialises to the closed form for rays clearing the photon shell. Those are
two correct but different discretisations, so from a distant camera the old assertion had
stopped testing the metric reduction and started measuring the specialisation. Inside
`R_FD_KERR` = 5 M, `kerrEntersShell()` returns true for every ray on sight, so plain Kerr runs
the generic force too and both sides share one discretisation. The reduction is now asserted
at **zero** tolerance, stronger than the 0.1% it used to allow, and a new check 1b bounds the
specialisation's own effect from the 30 M camera.

A runtime uniform to force the generic force was tried first and **rejected on measurement**:
it cost 10-18% of frame time in every formulation, for one uniform read per ray. That is the
same sensitivity the whole run kept finding — this march punishes anything added to it. The
camera-radius route achieves the same comparison for nothing.

Regenerating `bench/reference/scene-4.png` was necessary, since the binary path deliberately
changed. Scenes 1-3 keep the anchor's references untouched. Worth recording: at the
benchmark's 200-step budget the merger frame sits ~10% of pixels away from a converged render
regardless of the ceiling, so scene 4's parity was always a same-code check rather than a
correct-image one.

Full suite green afterwards: phases 1, 3, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16 PASS.

## Process notes

Of twelve candidates, four were approved, and the four *most informative* results were
disconfirmations — including two briefs written by the supervisor that contained wrong
premises, each caught by the agent assigned to it, and one explorer's confident negative
result that a reviewer overturned with its own independent replica. Nothing in this run
should be treated as established because one agent measured it once.

Two candidates were re-run from scratch after a container restart and an API rate limit
killed their agents mid-task. In both cases the dead agent's partial work was preserved and
offered to the replacement as unverified input, with instructions to form its own hypothesis
first and to re-derive every number it reported.

## Follow-up work this run identified but could not do

* `src/shaders/hq.wgsl` (the WebGPU high-quality path) is outside the run's scope and still
  mirrors the anchor's step cap *and* the anchor's 3-bisection disk crossing. The two
  renderers now resolve the disk differently. `e2e/phase11.cjs` asserts GL-vs-WebGPU parity
  over that pairing and still passes with ~100× margin, but the divergence is real.
  `phase11`'s constant-parity assertion works over a fixed string list that does not include
  the step cap, so it cannot catch this class of drift.
* Add benchmark scenes that render the `WEAK_FIELD` and `BINARY+RETARDED` variants, with
  committed references, and correct the harness header.
* The weak-field march still carries its own inlined step rule with an absolute cap. Its
  scale is the potential, not r, so c7's argument does not transfer unchanged and it needs
  its own derivation. The binary march's ceiling was fixed with the phase13 regression above.
* **The far-field asymptotic handoff is open, not dead.** A round-4 candidate concluded it
  was dead; its reviewer refuted the load-bearing step with an independent f64 replica. The
  mass tail is closed-form and confirmed to ~1%; the spin contribution falls at the same
  1/r⁴ rate and is subdominant, not two orders slower as claimed. A handoff at 70 M removes
  ~11 of 74.4 steps per ray for ~0.1% of pixels.

## Artifacts

* The winning shader is applied to this branch; its unmodified form is `evolve/1/candidate-11`
* Run state, per-candidate metrics, verdicts and all raw repeats: `evolve-state/1/`
* Supervisor probe tables, hint corrections and the negative-result ledger:
  `evolve-state/1/notes/`
* Candidate branches: `evolve/1/candidate-1` … `candidate-12`
