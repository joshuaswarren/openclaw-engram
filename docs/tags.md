# Tags

Tags are free-form labels stored on each memory's frontmatter. They give callers a lightweight way to slice recall results without committing to the rigid structure of the MECE taxonomy. Issue #689 wires tag filtering end-to-end across the CLI, HTTP, and MCP surfaces.

## Tags vs taxonomy

Remnic has two adjacent classification systems. Knowing which is which keeps reviews short.

| Aspect | Tags | Taxonomy (`packages/remnic-core/src/taxonomy/`) |
| --- | --- | --- |
| Purpose | Free-form, ad-hoc labels chosen by callers | Mutually exclusive, collectively exhaustive deterministic categorization |
| Cardinality | Many per memory | Exactly one path per memory |
| Schema | `tags: string[]` (frontmatter), max 50 entries, max 256 chars each | Resolved category directory tree |
| Source of truth | Caller-supplied at write time (or extraction-time labels) | Resolved by the taxonomy resolver from category + content |
| Filter semantics | `any` (default) or `all` match against caller-supplied tag set | Single-bucket lookup |
| Storage | Inline in frontmatter (`storage.ts`) | Path under `<memoryDir>/...` per resolved category |

If you need consistent, planner-friendly retrieval against a fixed shape, use the taxonomy. If you need ad-hoc slicing — `#weekly-review`, `#draft`, `#client-acme` — use tags.

## Recall surface (issue #689)

All three access surfaces accept the same two inputs:

- `tags`: a string array (max 50 entries, each 1–256 chars after trim).
- `tagMatch`: `"any"` (default when `tags` is provided and `tagMatch` is omitted) or `"all"`. Ignored when `tags` is absent or empty.

Comparison is case-sensitive exact match against tags stored on each memory's frontmatter. Empty / whitespace-only tag strings are dropped before matching. Duplicates are deduplicated.

### CLI

```bash
remnic recall "what did I plan?" --tag draft --tag weekly-review
remnic recall "decisions" --tag client-acme --tag-match all
```

`--tag` is repeatable. `--tag-match` accepts only `any` or `all`; any other value throws and lists valid options (CLAUDE.md rule 51 — never silently default).

### HTTP

`POST /engram/v1/recall` accepts the fields in the JSON body:

```json
{
  "query": "what did I plan?",
  "tags": ["draft", "weekly-review"],
  "tagMatch": "any"
}
```

For curl-friendly invocations the surface also accepts query-string parameters: `?tag=draft&tag=weekly-review&tag_match=all`. Body fields take precedence over query-string fallbacks.

### MCP

The `engram.recall` (and aliased `remnic.recall`) tool accepts `tags: string[]` and `tagMatch: "any" | "all"` in its input schema. Malformed values throw structured input errors.

## Where the filter runs

The filter is post-search and in-memory:

1. The orchestrator runs the usual recall pipeline (QMD search → MMR → rerank → assembly).
2. The access service hydrates each result's frontmatter via `serializeRecallResults`, so each candidate already carries its `tags` array.
3. `applyTagFilter` (in `recall-tag-filter.ts`) drops candidates whose tags don't satisfy the filter according to the requested mode.
4. Filtered `count`, `memoryIds`, and `results` are returned to the caller.

For X-ray (`/engram/v1/recall/xray`, `engram.recall_xray`, `remnic xray`) the filter additionally records a `tag-filter` entry in `snapshot.filters` with `considered → admitted` counts so operators can see how aggressive the filter was.

## Out of scope (explicitly deferred)

The v1 ships intentionally narrow:

- No QMD sidecar tag index. The filter is in-memory; deep result sets pay frontmatter I/O for every candidate.
- No LLM auto-tagging. Tags are caller-supplied at write time or via existing extraction.
- No tag hierarchies. Tags are flat strings with no nesting semantics.

These are deliberate carve-outs and may ship in follow-ups. The current implementation aims for a tight, predictable surface that callers can rely on without waiting for the structural work.
