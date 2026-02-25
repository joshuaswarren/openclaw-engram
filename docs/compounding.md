# Compounding Engine (v5.0)

The compounding engine turns feedback into persistent institutional learning.

Enable:
- `compoundingEnabled: true`

Optional injection into every prompt:
- `compoundingInjectEnabled` (default: true when compounding is enabled)

## Inputs

The engine reads shared feedback entries from:
- `shared-context/feedback/inbox.jsonl`

Write feedback via tool:
- `shared_feedback_record`

## Outputs

On each weekly synthesis run, Engram writes:
- `memoryDir/compounding/weekly/<YYYY-Www>.md`
- `memoryDir/compounding/mistakes.json`

The weekly report is written even if there are no feedback entries yet (day-one outcomes).

## Running Weekly Synthesis

Manual:

```bash
# via OpenClaw agent tool
compounding_weekly_synthesize
```

Recommended scheduling:
- Use OpenClaw cron with an isolated agent turn that calls `compounding_weekly_synthesize`.

## Continuity Audit Generation

When `identityContinuityEnabled=true`, `continuityAuditEnabled=true`, and `compoundingEnabled=true`, use:

- `continuity_audit_generate` with `period=weekly|monthly` and optional `key`.

Outputs:
- `memoryDir/identity/audits/weekly/<YYYY-Www>.md`
- `memoryDir/identity/audits/monthly/<YYYY-MM>.md`

When continuity audits are enabled, weekly compounding reports include a `Continuity Audits` section linking available weekly/monthly audit artifacts.
