# Theory: Resume Bundles Need a Contract Before They Need a Builder

## Problem

Creation memory now has the two raw ingredients a recovery system needs:

- a typed work-product ledger for what the agent created
- a typed commitment ledger for what the agent still owes

What it still lacks is the recovery container itself. Without a stable resume
bundle contract, later automation would have to invent its own ad hoc shape for
handoff state and would make PR28 harder to verify or benchmark.

## Operating Theory

The right PR27 shape is format first.

Resume bundles should become a deterministic, typed store before Engram starts
assembling them from transcripts, objective-state snapshots, work products, or
commitments.

That means:

- define a bundle schema with explicit scope, summary, and linked refs
- persist bundles into dated storage like the other creation-memory ledgers
- expose operator-facing record and status commands
- stop short of any builder or recovery injection logic

## Strategy

PR27 stays narrow by shipping only the contract and tooling:

1. config flags for enabling resume-bundle storage
2. a typed `ResumeBundle` schema and deterministic file layout
3. status and write commands so operators can inspect and exercise the format

This keeps PR27 reviewable and leaves PR28 with one focused job: populate the
bundle from live session state instead of also debating what the bundle should
look like.

## Key Discoveries

- Resume bundles fit the same rollout discipline as the rest of the memory OS:
  format first, then builders, then recovery consumers.
- The format needs linked refs to objective-state snapshots, work products, and
  commitments on day one, even if this slice does not auto-populate them yet.
- A bundle format can be valuable before automation because it gives operators a
  stable handoff shell and gives CI something deterministic to validate later.

## Open Questions

- Should PR28 emit one bundle per session checkpoint, or should it replace the
  latest bundle for a session key?
- Should future recovery consumers prefer bundle `nextActions` directly, or
  recompute priorities from linked ledgers at restore time?
- When resume-bundle recall eventually lands, should bundles appear as a
  dedicated recall section or stay strictly in operator tooling?
