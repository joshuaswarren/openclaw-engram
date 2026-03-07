# Theory: Engram As A Measured Memory OS

## Problem

Engram is no longer just trying to retrieve plausible context. The roadmap is
turning it into a memory system that can prove it improves agent outcomes,
survives long-running work, and resists bad data. That shift makes review rigor
part of the product itself. If memory changes can regress subtle outcome
classification or evaluation behavior, the benchmark foundation becomes noisy
and later slices lose credibility.

The immediate issue is the PR137 follow-up on objective-state outcome inference.
The code now needs to classify plain-text tool output without inverting obvious
failure signals or dropping obvious success signals. The specific failure modes
have been small but serious: a generalized success regex started treating
phrases like `not ok` as success, and then the tightened parser still missed
plain success text like `all tests pass`. Either direction corrupts
objective-state memory, poisons evaluation data, and makes later recall slices
reason from false state. The latest review cycle extended that lesson: once
bare `pass` became a success marker, the parser also needed to recognize `did
not pass` as a failure and `failures` as the plural form of `failure`.

## Operating Theory

The current leverage point is the objective-state writer path. This is where raw
agent/tool messages first become structured state snapshots. If inference is too
loose here, every later layer inherits the error: the store records the wrong
outcome, the eval harness measures the wrong behavior, and recall surfaces the
wrong prior state.

That means the right strategy is conservative normalization backed by regression
tests. Each review comment is treated as a hypothesis about a silent data-quality
failure. The correct response is not to appease the reviewer but to tighten the
classification rule, add the narrowest test that proves the scenario, and keep
pipeline stable. In practice, that means testing natural-language markers in
pairs: positive and negated, singular and plural, recovered and unrecovered.

The review loop itself is also part of the operating theory now. A PR is not
merge-ready when CI is green; it is merge-ready only when the external review
systems are terminal and clean on the current head. For Engram work, review
latency must be tolerated because premature PR churn damages repo continuity and
obscures whether the underlying slice is actually stable.

## Strategy

The roadmap remains benchmark-first and flag-first. Each slice should add one
memory capability behind explicit config gates, then attach enough tests and
measurement to prove the slice improved the system rather than merely expanded
it.

The near-term sequence is:

1. Finish the PR137 follow-up cleanly on the existing PR so the objective-state
   foundation is trustworthy.
2. Continue the objective-state campaign with recall and retrieval slices, still
   behind flags.
3. Use the evaluation harness as the acceptance surface for every later memory
   feature, especially causal trajectories, trust zoning, and creation-memory.

This keeps Engram aligned with the larger thesis:
- memory that improves action outcomes
- memory that survives long horizons and failures
- memory that can defend itself

## Key Discoveries

- Outcome inference for free-form text is easy to misclassify in both
  directions. Negated success phrases like `not ok` need to be treated
  explicitly as failures before success-marker logic runs, but plain success
  phrases like `all tests pass` also need explicit coverage or the parser falls
  back to `unknown`.
- Parser broadening has a symmetry requirement. Adding `pass` without also
  covering `did not pass` or adding `failure` without `failures` creates
  regressions that are subtle in tests but severe in stored state.
- Test realism matters even for small parser coverage. A literal `\\n` fixture
  can accidentally pass while simulating the wrong runtime shape; multiline test
  data should match actual tool output.
- PR continuity is an engineering concern, not just a process preference. Slow
  Cursor reviews are normal, and replacing or closing an active PR creates noise
  without reducing uncertainty.

## Open Questions

- How much richer should outcome inference become before it needs a more formal
  parser or scoring model instead of layered regex heuristics?
- For upcoming objective-state recall, what is the minimum retrieval surface
  that improves agent behavior without flooding prompt context?
- Once the objective-state slices land, which benchmark tasks best expose causal
  memory improvements rather than generic retrieval improvements?
