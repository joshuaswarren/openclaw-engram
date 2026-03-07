# Theory: Engram As A Measured Memory OS

## Problem

Engram is trying to become agent memory that improves actual work, not just
agent memory that can retrieve plausible text. That means the system needs to
remember objective state: what command ran, what file changed, what tool
failed, and what the resulting world state became. PR5 and PR6 built the
objective-state store and the first writer path, but without retrieval that
state still behaves like an operator ledger instead of agent-usable memory.

The current problem is therefore no longer outcome parsing itself. The parser
foundation is now good enough to store normalized file/process/tool snapshots.
The real gap is that recall still reasons almost entirely over semantic memory
documents. An agent can write objective-state snapshots and still fail to use
them in the next turn.

## Operating Theory

Objective-state retrieval should start as a separate, bounded section rather
than being mixed directly into the semantic-memory ranking path. That keeps the
new signal legible and makes it possible to evaluate whether objective-state
recall helps before it is blended into broader memory scoring.

The right first move is lightweight lexical retrieval over validated snapshots:
match prompt tokens against snapshot scope, summary, command, tool name, tags,
and entity refs; add a small recency/session bias; then inject only the top few
results as a distinct `## Objective State` section. This is intentionally
smaller than a full causal trajectory system. The goal is to make the stored
state usable now without prematurely committing to a more complex world-model
retriever.

## Strategy

The roadmap is still benchmark-first and flag-first. Each new memory surface
should be added behind a dedicated flag, covered by tests, and documented as a
bounded contract before being woven into the rest of recall.

For the current objective-state track, the sequence is:

1. Keep the writer/store layer conservative and stable.
2. Add a separate objective-state retrieval surface behind its own recall flag.
3. Use that retrieval layer as the foundation for later causal-trajectory work,
   where multiple objective-state records will need to be linked into
   goal-action-observation-outcome chains.

This preserves the larger thesis:
- memory that improves action outcomes
- memory that survives long horizons and failures
- memory that can defend itself

## Key Discoveries

- Objective-state memory becomes agentically useful only when it is recallable
  as its own surface. Storing snapshots alone is not enough.
- A separate recall section is a better first slice than immediate score
  blending. It keeps evaluation cleaner and prevents objective-state signals
  from silently distorting the existing semantic-memory path.
- Invalid snapshot artifacts should be ignored during retrieval but still
  surfaced by store-status inspection. That split keeps recall fail-open while
  preserving operator visibility into bad data.

## Open Questions

- At what point should objective-state retrieval graduate from lexical scoring
  to trajectory-aware ranking?
- How should future causal-memory slices combine objective-state recall with the
  existing graph recall path without over-injecting context?
- Which benchmark tasks will best show whether separate objective-state recall
  materially improves downstream agent action quality?
