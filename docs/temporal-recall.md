# Temporal recall: `valid_at`, `invalid_at`, and `as_of`

> Issue [#680](https://github.com/joshuaswarren/remnic/issues/680).
> Promote temporal supersession to a first-class fact lifecycle that
> callers can query historically.

Remnic now persists when a fact is "true" with two explicit ISO 8601
frontmatter fields:

| Field        | Meaning                                               |
| ------------ | ----------------------------------------------------- |
| `validAt`    | When the fact begins being authoritative.             |
| `invalidAt`  | When the fact stops being authoritative (exclusive).  |

A fact is considered authoritative for the half-open interval
`[validAt, invalidAt)`. Both fields are optional. When `validAt` is
absent, the fact's `created` timestamp is used as a read-time fallback
so legacy memories written before #680 participate in `as_of` filtering
without a backfill migration. When `invalidAt` is absent, the fact is
considered authoritative through "now".

## How `invalid_at` gets populated

The temporal supersession pipeline (`temporal-supersession.ts`) already
detects when a newer fact replaces an older one on the same
`(entityRef, attribute)` pair. As of #680 it now also stamps the
predecessor's `invalidAt`:

- The successor's `validAt` is copied verbatim onto the predecessor's
  `invalidAt` so the two facts dovetail at exactly the same instant.
- When the successor has no explicit `validAt`, the predecessor's
  `invalidAt` is set to the successor's persisted `created` timestamp.
- An existing `invalidAt` on the predecessor is preserved (idempotent),
  so manual or earlier supersession events are not overwritten.

## Recall as it existed at a point in time

Every recall surface accepts an `as_of` ISO 8601 timestamp:

| Surface | How to pass `as_of`                          |
| ------- | -------------------------------------------- |
| CLI     | `remnic recall "<query>" --as-of <iso>`      |
| HTTP    | `?as_of=<iso>` on `POST /engram/v1/recall`, or `asOf` in the JSON body |
| MCP     | `asOf` field on the `engram.recall` tool     |

Each surface validates the timestamp at the input boundary
(`Date.parse`) and rejects malformed values with a structured error.
There is no silent fallback (CLAUDE.md rule 51).

When `as_of` is set, recall drops candidates that were not
authoritative at that instant — i.e. those where
`effectiveValidAt(fm) > asOf` OR
`effectiveInvalidAt(fm) !== undefined && effectiveInvalidAt(fm) <= asOf`.
The upper bound is exclusive so a fact's exact end-of-life timestamp
hides it (CLAUDE.md gotcha #35: time-range filters use exclusive
upper bounds).

## Worked example

A user moved from Austin to NYC on 2026-04-01.

```yaml
# facts/preferences.md
---
id: 01HXY...
created: 2025-01-15T10:00:00.000Z
validAt: 2025-01-15T10:00:00.000Z
invalidAt: 2026-04-01T00:00:00.000Z
status: superseded
supersededBy: 01J0AB...
entityRef: project-x
structuredAttributes:
  city: Austin
---
project X is based in Austin
```

```yaml
# facts/preferences.md (newer fact, after supersession)
---
id: 01J0AB...
created: 2026-04-01T00:00:00.000Z
validAt: 2026-04-01T00:00:00.000Z
entityRef: project-x
structuredAttributes:
  city: NYC
---
project X relocated to NYC
```

A normal `remnic recall "where is project X based?"` returns the NYC
fact (the Austin fact is filtered as `superseded`).

A historical recall pinned to the day before the move returns the
Austin fact:

```bash
remnic recall "where is project X based?" --as-of 2026-03-31T00:00:00Z
# → "project X is based in Austin" (validAt <= asOf < invalidAt)
```

A recall pinned exactly at the supersession instant returns the NYC
fact (because `invalidAt` is exclusive):

```bash
remnic recall "where is project X based?" --as-of 2026-04-01T00:00:00Z
# → "project X relocated to NYC"
```

## What is intentionally out of scope

This slice does NOT include:

- Mass migration / backfill of `validAt` onto existing files. The
  read-time fallback to `created` covers legacy data.
- Vector clocks, branching timelines, or cross-fact causality.
- A new `temporal-supersession` policy. The existing pipeline is
  unchanged apart from emitting `invalidAt` on the predecessor.

See the test suite at
`packages/remnic-core/src/temporal-validity.test.ts` for the canonical
boundary cases.
