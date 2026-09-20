# Shader optimisation run — evolutionary search over `render.frag.glsl`

A four-round evolutionary search (agent-evolve) over the Kerr null-geodesic fragment
shader, run with an explorer/reviewer protocol on isolated worktrees. The physics is
unchanged: same metric, same integrator order, same termination law. Only the arrangement
of the computation changed.

## Result

| | frame_ms | vs anchor |
|---|---|---|
| anchor (`8d34f1a`) | 340.0 | — |
| winner | **68.2** | **−79.9%** |

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

## One regression this run introduced, and it is not fixed

`e2e/phase13.cjs` asserts a designed invariant: binary mode with the second mass set to
zero must render **pixel-identical** to plain Kerr mode at the same spin and camera, because
the BINARY branches are built to reduce bit-for-bit when the second hole's f vanishes. Its
tolerance is 0.1% of pixels.

| tree | parity_diffFrac | result |
|---|---|---|
| anchor | 0 | PASS |
| c4 (round 2) | 0.0244140625 | FAIL |
| c7, c8, c11 | 0.024388020833 | FAIL |

I confirmed both ends myself: the anchor returns exactly 0 and the winner returns 0.02439.
The break dates from round 2's approved candidate, not from the winner, which inherits it
unchanged to sixteen significant figures. Candidate 11's other three phase-13 assertions
(two-hole scene, |H|-drift band, deep-overlap smoke) all pass, and the full suite is
otherwise green: phases 1, 3, 5, 6, 8, 9, 10, 11, 12, 14, 15, 16 PASS.

The cause is direct. The plain-Kerr march now uses the closed-form force and a step ceiling
of `0.1 * R_ESCAPE`, while the BINARY march keeps the anchor's finite-difference force and
its own inlined `clamp(..., 1e-4, 4.0)`. The two paths no longer agree in the limit where
they are supposed to coincide. Nothing about the physics is wrong in either path; the
*designed equivalence between them* is what broke, and phase13 exists precisely to catch
that.

The fix is not a waiver. Propagating the same specialisation and ceiling into the BINARY
march would restore the reduction AND speed up merger mode, which the benchmark never times
because its timing scene is plain Kerr. That converges with the follow-up item below about
the binary path's inlined step rule: they are the same work. It was correctly out of scope
during the run — a candidate that changed the BINARY path to chase a Kerr-scene metric would
have been optimising against a number that cannot see it.

**This should be fixed before the winning shader is merged anywhere.**

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
* The binary and weak-field march loops carry their own inlined step rules, both still using
  the absolute cap the plain-Kerr path shed, and the binary path still uses the
  finite-difference force. Invisible to `frame_ms`, which times a Kerr scene only, so it was
  correctly left alone during the run. This is the same work as the phase13 fix above.
* **The far-field asymptotic handoff is open, not dead.** A round-4 candidate concluded it
  was dead; its reviewer refuted the load-bearing step with an independent f64 replica. The
  mass tail is closed-form and confirmed to ~1%; the spin contribution falls at the same
  1/r⁴ rate and is subdominant, not two orders slower as claimed. A handoff at 70 M removes
  ~11 of 74.4 steps per ray for ~0.1% of pixels.

## Artifacts

* Run state, per-candidate metrics, verdicts and all raw repeats: `evolve-state/1/`
* Supervisor probe tables, hint corrections and the negative-result ledger:
  `evolve-state/1/notes/`
* Candidate branches: `evolve/1/candidate-1` … `candidate-12`
