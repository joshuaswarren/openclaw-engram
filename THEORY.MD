# Theory: Engram Is Adding Trust Boundaries To The New Memory Surfaces

## Problem

Engram now has benchmark storage, objective-state memory, and causal
trajectories. That progress increases the next risk: those newer memory
surfaces can accumulate raw tool output, web captures, and subagent traces
faster than they accumulate trust.

The immediate problem is therefore not promotion logic yet. It is establishing
explicit storage boundaries so later promotion and poisoning-defense work has a
real substrate. Without separate quarantine, working, and trusted stores,
future trust logic would still be policy layered over one undifferentiated
memory mass.

## Operating Theory

The roadmap is still working because each new memory surface has arrived in a
disciplined order:

1. store the typed source of truth
2. make the source observable and testable
3. only then add writers, recall, and ranking behavior
4. add trust boundaries before aggressive automation

That means PR11 should not try to solve promotion or retrieval enforcement in
one pass. The right first move is a typed trust-zone store:

- `quarantine` for raw, unpromoted material
- `working` for operator-useful but not fully trusted state
- `trusted` for future corroborated/promoted records

That keeps current behavior stable while making later promotion and retrieval
enforcement mechanically possible.

## Strategy

The broader thesis remains:

- memory that improves action outcomes
- memory that survives long horizons and failures
- memory that can defend itself

For the trust-zone track, the strategy is now:

1. ship defaults-off storage paths and typed provenance first
2. keep promotion logic out of this slice
3. make operator visibility available through status commands
4. use the stored provenance contract as the base for PR12 and PR13

This keeps PR11 small and reviewable while preserving the roadmap sequence:

1. PR11: trust-zone schemas and storage
2. PR12: promotion rules and provenance enforcement
3. PR13: trust-zone-aware retrieval filters

## Key Discoveries

- The objective-state and causal-trajectory slices already established the
  right pattern for this work: store contracts first, behavior later.
- Trust-zone records need provenance fields in the first version; otherwise the
  later promotion layer would have to backfill missing origin data.
- A zoned status command is enough operator visibility for this slice. Retrieval
  behavior can stay untouched until trust-aware filtering exists.

## Open Questions

- Which stored surfaces should write directly into `working` rather than
  `quarantine` by default once writers arrive?
- Should promotion history remain embedded in trust-zone records, or should it
  become a separate append-only ledger in PR12?
- Which future retrieval sections should be trust-filtered first: objective
  state, causal trajectories, or both together?
