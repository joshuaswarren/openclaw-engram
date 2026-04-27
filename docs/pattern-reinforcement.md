# Pattern Reinforcement

Pattern reinforcement (issue #687) generalizes the **procedural memory miner** into a universal mechanism: any observation that recurs across sessions is merged into a single *reinforced primitive* with a confidence boost, regardless of whether it is a procedure, a fact, or a preference.

This feature tracks [issue #687](https://github.com/joshuaswarren/remnic/issues/687).

Also see: [Procedural memory](procedural-memory.md) (the procedure-specific miner that ships alongside), [Recall X-ray](xray.md) (surfacing `reinforcementBoost` in score decomposition), [Config reference](config-reference.md#pattern-reinforcement-issue-687).

## Concept

The procedural miner already detects recurring multi-step runbooks. Pattern reinforcement extends that principle to all configurable memory categories:

- A user expressing the same preference across 30 sessions → reinforced preference primitive.
- A debugging pattern recurring across 20 sessions in different repos → reinforced engineering practice.
- The same project context referenced repeatedly → reinforced project anchor.

The procedural miner is unchanged. Pattern reinforcement runs as a **separate maintenance job** on a configurable cadence and considers only the categories you configure (default: `preference`, `fact`, `decision`).

## Reinforcement model

The job runs `runPatternReinforcement()` from `packages/remnic-core/src/maintenance/pattern-reinforcement.ts` using a storage interface that accepts any `StorageManager`-compatible implementation.

### Cluster key

Each memory is keyed by `category::normalizedContent`:

```
normalizedContent = content.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200)
key               = `${category}::${normalizedContent}`
```

Truncating to 200 characters means long-form content with a stable opening still clusters together even when the tail differs slightly. The category prefix ensures that identical text in different categories (e.g., a `fact` and a `decision` with the same wording) is never cross-superseded.

### What gets reinforced

The job:

1. **Clusters** all active and superseded memories in the configured categories by cluster key. Forgotten, archived, quarantined, pending_review, and rejected memories are excluded.
2. **Picks the most-recent active member** of each cluster with `cluster.size >= minCount` as the **canonical**.
3. **Stamps the canonical** with `reinforcement_count` (total cluster size) and `last_reinforced_at` (ISO 8601). Provenance fields `derived_from` (source IDs) and `derived_via: "pattern-reinforcement"` are also written.
4. **Marks older duplicates** `status: "superseded"` with a `supersededBy` pointer to the canonical's ID.

The job is idempotent: re-running on the same corpus does not double-bump `reinforcement_count`. The bump-only-on-change guard compares cluster size to the canonical's previous counter and writes only when the value changed.

### YAML frontmatter fields

Reinforced canonicals carry these additional fields:

```yaml
reinforcement_count: 12
last_reinforced_at: "2026-04-27T08:00:00.000Z"
derived_from:
  - mem_abc123
  - mem_def456
  - mem_ghi789
derived_via: "pattern-reinforcement"
```

Superseded duplicates carry:

```yaml
status: superseded
supersededBy: mem_jkl012
```

## Knobs

Enable the job in plugin config:

```json
{
  "patternReinforcementEnabled": true,
  "patternReinforcementCadenceMs": 604800000,
  "patternReinforcementMinCount": 3,
  "patternReinforcementCategories": ["preference", "fact", "decision"]
}
```

| Key | Default | Notes |
| --- | ------- | ----- |
| `patternReinforcementEnabled` | `false` | Master gate. Set to `true` to enable the maintenance job. |
| `patternReinforcementCadenceMs` | `604800000` (7 days) | Minimum milliseconds between runs. Set to `0` to disable cadence gating (run on every maintenance cycle). |
| `patternReinforcementMinCount` | `3` | Minimum cluster size before a canonical is promoted. Clamped to `[2, 1000]`; clusters of 1 are degenerate. |
| `patternReinforcementCategories` | `["preference", "fact", "decision"]` | Categories the job scans. Empty array means no categories are processed. |

The cadence guard is **entirely in-memory** and is NOT derived from the `last_reinforced_at` field written to memory frontmatter. The orchestrator keeps a `lastPatternReinforcementAtByNs` Map (keyed by namespace) that records the epoch-ms timestamp when each run completes. If `Date.now() - lastRunAt < patternReinforcementCadenceMs`, the job returns early with `skippedReason: "cadence"`.

Because the map is in-process, it resets on every process restart. A freshly restarted gateway will always run the job on the first maintenance cycle, regardless of when the previous process last ran it. Operators who need cross-restart cadence control should rely on external scheduling (cron, Dreams phase triggers) rather than the in-process gate alone. Set `patternReinforcementCadenceMs: 0` to disable cadence gating entirely and run on every maintenance cycle.

## Recall boost

Reinforced primitives can be weighted higher in recall. This is **opt-in** (`reinforcementRecallBoostEnabled: false` by default):

```json
{
  "reinforcementRecallBoostEnabled": true,
  "reinforcementRecallBoostMax": 0.3
}
```

| Key | Default | Notes |
| --- | ------- | ----- |
| `reinforcementRecallBoostEnabled` | `false` | When `true`, memories with `reinforcement_count > 0` receive an additive score boost. |
| `reinforcementRecallBoostMax` | `0.3` | Maximum additive reinforcement boost per result. Range `[0, 1]`. The raw boost is `reinforcementRecallBoostWeight × reinforcement_count`, clipped to this cap. |

A third key `reinforcementRecallBoostWeight` (default `0.05`) controls the per-unit boost. The formula:

```
boost = min(reinforcementRecallBoostMax, reinforcementRecallBoostWeight × reinforcement_count)
```

A memory reinforced 12 times with default weight and max would receive `min(0.3, 0.05 × 12) = min(0.3, 0.6) = 0.3` — the cap.

## X-ray surfacing

When `recallDirectAnswerEnabled` is on, Recall X-ray surfaces a `reinforcementBoost` field in the per-result score decomposition:

```json
{
  "memoryId": "mem_jkl012",
  "scores": {
    "base": 0.72,
    "reinforcementBoost": 0.30,
    "final": 1.02
  },
  "reinforcement_count": 12
}
```

This makes it easy to audit which results were boosted by pattern reinforcement vs. which won on raw relevance. See [Recall X-ray](xray.md) for the full decomposition schema.

## CLI surface

The `remnic patterns` command group exposes pattern-reinforcement output. Both subcommands read from the active `memoryDir` and require no extra config.

### `remnic patterns list`

Lists memories whose `reinforcement_count > 0`, sorted by count descending.

```bash
remnic patterns list [--limit N] [--category cat1,cat2] [--since ISO] [--format text|markdown|json]
```

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--limit N` | `50` | Maximum rows to show (positive integer). |
| `--category list` | all categories | Comma-separated category filter (e.g. `preference,fact`). |
| `--since ISO` | all time | Only include memories reinforced on or after this ISO 8601 timestamp. |
| `--format fmt` | `text` | Output format: `text`, `markdown`, or `json`. |

Example output (`--format text`):

```
reinforcement_count  category    id          last_reinforced_at   content (truncated)
─────────────────────────────────────────────────────────────────────────────────────
12                   preference  mem_jkl012  2026-04-27T08:00Z    prefer short inline comments over...
8                    fact        mem_abc456  2026-04-20T10:00Z    the project uses pnpm workspaces...
5                    decision    mem_def789  2026-04-15T14:30Z    decided to use the port/adapter pa...
```

### `remnic patterns explain <memoryId>`

Shows the full reinforcement picture for a single canonical:

- `reinforcement_count` and `last_reinforced_at`
- `derived_from` source memory IDs (each cluster member's `frontmatter.id`) stamped by the maintenance job
- Canonical body
- Cluster members — memories whose `supersededBy` points at this canonical

```bash
remnic patterns explain <memoryId> [--format text|markdown|json]
```

Exits with code `1` and a descriptive error if `<memoryId>` is not found or has no `reinforcement_count > 0`.

Invalid flag values (`--format xml`, `--limit 0`, `--since not-a-date`) throw a listed-options error rather than silently defaulting (see CLAUDE.md rule 51).

Example:

```bash
$ remnic patterns explain mem_jkl012
Canonical: mem_jkl012
  category:             preference
  reinforcement_count:  12
  last_reinforced_at:   2026-04-27T08:00:00.000Z
  content:              "prefer short inline comments over block comments for single-line..."

Provenance (derived_from):
  mem_abc123  2026-01-10T09:00Z  [superseded]
  mem_def456  2026-02-18T14:00Z  [superseded]
  ...10 more...

Run `remnic patterns explain mem_jkl012 --format json` for machine-readable output.
```

## Triggering the job

Pattern reinforcement is **not** triggered automatically by the Dreams REM phase. The runtime call site is `EngramAccessService.patternReinforcementRun`, which is exposed through:

- **MCP tool:** `remnic.pattern_reinforcement_run` (canonical) / `engram.pattern_reinforcement_run` (legacy alias)
- **Maintenance scheduler / cron:** the job can be registered as a standalone maintenance cron entry

To trigger an ad-hoc run, call the MCP tool directly:

```json
{ "name": "remnic.pattern_reinforcement_run", "arguments": {} }
```

Pass `"force": true` to bypass the in-process cadence gate for an immediate run regardless of when the last run completed.

See [Dreams: phased consolidation](dreams.md) for the Dreams pipeline; pattern reinforcement scheduling is independent of it.

## Relationship to procedural memory

Pattern reinforcement and the procedural miner are **siblings**, not replacements:

| Aspect | Procedural miner | Pattern reinforcement |
| ------ | ---------------- | --------------------- |
| Input | Causal trajectory records | All memories in configured categories |
| Cluster key | `${goal}\|${entityRefs}` from trajectory | `${category}::${normalizedContent(200)}` |
| Output | `category: procedure` with ordered steps | `reinforcement_count` + `last_reinforced_at` on any category |
| Min threshold | `procedural.minOccurrences` (default `3`) | `patternReinforcementMinCount` (default `3`) |
| Config gate | `procedural.enabled` (default `true`) | `patternReinforcementEnabled` (default `false`) |
| Recall injection | Task-initiation procedure block | Score boost via `reinforcementRecallBoostEnabled` |

Procedure memories themselves are not in the default `patternReinforcementCategories` list, so the two pipelines do not interfere.

## Examples

### Enabling pattern reinforcement

Minimal config to turn on the job with weekly cadence:

```json
{
  "patternReinforcementEnabled": true
}
```

### Enabling recall boost

```json
{
  "patternReinforcementEnabled": true,
  "reinforcementRecallBoostEnabled": true,
  "reinforcementRecallBoostMax": 0.25
}
```

### Restricting to preferences only

```json
{
  "patternReinforcementEnabled": true,
  "patternReinforcementCategories": ["preference"],
  "patternReinforcementMinCount": 5
}
```

### Running the job manually via MCP

Pattern reinforcement has its own MCP tool:

```json
{ "name": "remnic.pattern_reinforcement_run", "arguments": {} }
```

Pass `"force": true` to bypass the in-process cadence gate. The legacy alias `engram.pattern_reinforcement_run` also works.

For the separate procedural miner, use `remnic.procedure_mining_run`.

## Acceptance criteria (from issue #687)

- Bench fixture: 30 sessions repeating the same preference; reinforcement merges them into one primitive within one maintenance cycle.
- Reinforced primitives outrank one-shot equivalents in recall on a controlled fixture (requires `reinforcementRecallBoostEnabled: true`).
- `remnic patterns explain <id>` traces a reinforced primitive back to its sources.
- Procedural-miner behavior unchanged.
