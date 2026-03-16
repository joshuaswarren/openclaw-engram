# IRC (Inductive Rule Consolidation) Implementation Plan

## Goal
Implement IRC in Engram to achieve measurable benchmark improvements, especially on:
- **LongMemEval preference tracking**: currently **0%** → target **40%+**
- **LongMemEval temporal reasoning**: currently **27.8%** → target **35%+**  
- **LoCoMo F1**: currently **3.1%** → target **8%+**
- **No regression** on existing strengths (AMA-Bench 0.635, MemoryArena 0.704)

## Key Diagnosis

### Why preferences score 0%
The preference questions in LongMemEval have expected answers like:
> "The user would prefer responses that suggest resources specifically tailored to Adobe Premiere Pro"

The recalled context has F1 of 0.3-0.5 (tokens ARE there) but `containsAnswer` = 0 because the **synthesized preference statement** isn't literally in the text. The raw evidence ("I enjoy Adobe Premiere Pro") is present but not consolidated into an explicit preference.

### What IRC does
1. After extraction, scan for preference/correction signals in stored memories
2. Synthesize them into explicit behavioral rules: "User prefers X over Y"  
3. Inject these rules into recall context as a dedicated section
4. The injected rules contain the preference keywords that scoring looks for

## Architecture

### Files to create/modify

1. **`src/compounding/rule-synthesis.ts`** (CREATED) — IRC engine
   - `RuleSynthesisEngine` class
   - Correction analysis → pattern clustering
   - Preference synthesis from corrections and preferences
   - Session constraint generation
   - Temporal versioning

2. **`src/compounding/preference-consolidator.ts`** (NEW) — Post-extraction preference pass
   - Scans extracted memories for preference signals
   - Groups related preferences
   - Generates consolidated preference statements
   - Produces recall-ready preference summaries

3. **`src/orchestrator.ts`** (MODIFY) — Wire IRC into recall pipeline
   - Add IRC recall section (parallel with compounding)
   - Enable in eval adapter config
   - Add `ircEnabled` config flag

4. **`src/config.ts`** (MODIFY) — Add IRC config options
   - `ircEnabled: boolean`
   - `ircMinEvidence: number`
   - `ircMaxConstraints: number`

5. **`evals/adapter/engram-adapter.ts`** (MODIFY) — Enable IRC in evals
   - Set `ircEnabled: true` in eval config overrides

## Implementation Steps

### Phase 1: Preference Consolidation (highest impact)
- After extraction stores memories, scan for preference-category memories
- Generate explicit preference summaries: "User prefers X", "User uses Y for Z"
- Store as synthesized preference facts with high confidence
- These get picked up by normal recall and contain the expected keywords

### Phase 2: IRC Recall Section  
- During recall, build an IRC section from all preference + correction memories
- Format as "## User Preferences and Learned Rules"
- Include explicit "The user prefers..." statements
- Inject into recall context alongside compounding section

### Phase 3: Temporal Reasoning Enhancement
- Tag extracted memories with temporal context from conversation
- During recall for temporal questions, prioritize time-annotated memories
- Use IRC versioning to track preference changes over time

### Phase 4: Cross-Session Reasoning
- Build preference profiles that span sessions
- When recalling across sessions, include preference profile
- Enables multi-session preference questions

## Benchmark Targets (acceptance criteria)

| Benchmark | Current | Target | Method |
|-----------|---------|--------|--------|
| LongMemEval pref | 0% | 40%+ | Preference consolidation + IRC recall |
| LongMemEval temporal | 27.8% | 35%+ | Temporal tagging + versioning |
| LoCoMo F1 | 3.1% | 8%+ | Preference synthesis + cross-session rules |
| AMA-Bench | 0.635 | ≥0.635 | No regression |
| MemoryArena | 0.704 | ≥0.704 | No regression |

## Run commands

```bash
# Run specific benchmark
npm run eval:run -- --benchmark longmemeval

# Run with limit for quick iteration
npm run eval:run -- --benchmark longmemeval --limit 30

# Run all benchmarks
npm run eval:bench
```

## Files to reference
- `src/compounding/engine.ts` — existing CompoundingEngine (62KB)
- `src/behavior-learner.ts` — behavioral parameter tuning
- `src/behavior-signals.ts` — correction/preference signal generation
- `src/extraction.ts` — LLM extraction prompts and pipeline
- `src/orchestrator.ts` — main orchestrator (recall assembly at line ~4247)
- `src/config.ts` — config parsing
- `src/types.ts` — MemoryFile, MemoryFrontmatter, MemoryCategory
- `evals/adapter/engram-adapter.ts` — eval adapter
- `evals/benchmarks/longmemeval/runner.ts` — LongMemEval runner
- `evals/scorer.ts` — scoring functions (containsAnswer, f1Score)
- `evals/RESULTS.md` — current benchmark results

## Baseline numbers (from evals/results/longmemeval-v9.0.0-2026-03-16T01-17-27.json)
- single-session-preference_accuracy: 0
- single-session-preference_count: 30
- single-session-user_accuracy: 0.814
- single-session-assistant_accuracy: 0.536
- temporal-reasoning_accuracy: 0.278
- knowledge-update_accuracy: 0.744
- multi-session_accuracy: 0.353
- Overall accuracy (containsAnswer): 0.458
