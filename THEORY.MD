# Theory: Poisoning Defense Needs Independent Evidence Before Trust

## Problem

Engram now has real trust tiers, explicit promotion rules, bounded trust-zone
recall, and deterministic provenance trust scoring. That still leaves one
defensive gap: a risky record can look structurally well-formed and still come
from a single source.

For poisoning defense, anchored provenance alone is not enough. If `tool_output`,
`web_content`, or `subagent_trace` material can become `trusted` without any
independent confirmation, then the trust zone is still too easy to poison with a
single bad input.

## Operating Theory

The trust-zone rollout is working because it has stayed ordered:

1. store trust tiers
2. define promotion boundaries
3. expose bounded recall
4. surface deterministic trust signals
5. require independent corroboration for risky promotions
6. only then benchmark attacks and tune policy

PR14 completed step 4 by making provenance quality measurable. PR15 is step 5:
consume the existing trust substrate and require independent corroboration
before risky `working -> trusted` promotions succeed.

That keeps the system explainable. Trust is no longer just "did this record
have anchors?" It becomes "did at least one independent, non-quarantine source
support the same claim cluster?"

## Strategy

Keep the corroboration rule narrow and deterministic:

- only gate risky `working -> trusted` promotions
- leave `quarantine -> working` flow unchanged
- require corroboration from stored records, not fresh model judgment
- treat `quarantine` as non-corroborating by design
- use explicit overlap on `entityRefs` or `tags`, not semantic fuzziness
- record corroboration metadata on successful promotions

This preserves small-slice discipline. PR15 is not a full trust engine. It is
the smallest bounded policy that converts provenance signals into an actual
promotion defense.

## Key Discoveries

- The first corroboration rule should be structural, not inferential. Explicit
  overlap plus anchored provenance is easier to test, explain, and benchmark
  than semantic similarity or another model call.
- `quarantine` records cannot count as corroboration without collapsing the
  trust boundary. The tier only works if low-trust evidence stays low-trust
  until a cleaner source confirms it.
- Independent source class matters. Two records from the same source class are
  weak confirmation for poisoning defense because they often share the same
  failure mode.
- Corroboration belongs in promotion policy before retrieval policy. The system
  should decide what can become `trusted` before it decides how trust should
  alter ranking or filtering.

## Open Questions

- Should PR16's attack benchmarks focus first on false promotions, or also on
  false denials where good evidence lacks enough explicit overlap metadata?
- Should later slices let multiple medium-trust corroborators outweigh a single
  high-trust corroborator, or keep the first generation rule purely count-based?
- Should future retrieval use corroboration metadata only for operator
  observability, or eventually as a ranking/filtering input once benchmark data
  justifies it?
