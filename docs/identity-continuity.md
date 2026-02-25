# Identity Continuity

Identity continuity adds recovery-oriented memory artifacts so the assistant can regain stable behavior after drift, context loss, or tool/runtime incidents.

This feature set is controlled by the v8.4 config surface and is designed to be fail-open: disabling continuity flags should return runtime behavior to baseline retrieval/extraction paths.

## Artifacts

When enabled, continuity files are stored under:

```text
<memoryDir>/identity/
```

Primary artifacts:

- `identity-anchor.md`: canonical continuity anchor sections.
- `incidents/*.md`: incident records with open/close lifecycle.
- `audits/*.md`: generated continuity audits.
- `improvement-loops.md`: recurring loop register and review metadata.

## Safety Boundaries

Continuity features must keep these invariants:

1. No mutation of OpenClaw session pointers/files.
2. Incident lifecycle is append-only except explicit close transition.
3. Identity injection respects `identityInjectionMode` and `identityMaxInjectChars`.
4. Disabled flags are compatibility guarantees, not hints:
   - `identityContinuityEnabled=false` disables continuity injection/tools.
   - `continuityIncidentLoggingEnabled=false` disables incident logging paths.
   - `continuityAuditEnabled=false` disables audit generation paths.
5. Fail-open behavior on parse/storage errors (log and continue).

## Template: Identity Anchor

Use this structure for safe merges via `identity_anchor_update`:

```markdown
# Identity Anchor

## Identity Traits
- Role:
- Core strengths:
- Reliability profile:

## Communication Preferences
- Tone:
- Detail level:
- Avoid:

## Operating Principles
- Principle 1:
- Principle 2:

## Continuity Notes
- Active risks:
- Recent corrections:
- Recovery guidance:
```

## Template: Continuity Incident

Incident files are markdown with frontmatter; open/close tools maintain lifecycle fields.

```markdown
---
id: incident-<ts>-<slug>
state: open
openedAt: 2026-02-25T00:00:00.000Z
closedAt:
---

## Timeline
- 2026-02-25T00:00:00.000Z opened

## Symptom
identity anchor omitted in recovery response

## Fix Applied

## Verification Result

## Notes
Observed during weekly continuity audit.
```

## Template: Continuity Audit

```markdown
---
id: continuity-audit-2026-02-25
period: weekly
generatedAt: 2026-02-25T00:00:00.000Z
signalSummary:
  openIncidents: 1
  staleLoops: 2
  anchorPresent: true
---

# Continuity Audit

## Signal Checks
- Anchor present: pass
- Incident backlog: warn
- Improvement-loop freshness: warn

## Findings
- Incident `incident-...` still open past target SLA.
- Two active loops exceeded cadence threshold.

## Recommended Actions
- Close incident after verification.
- Run `continuity_loop_review` for stale loops.
```

## Rollout by Risk Tier

1. Low risk:
   - Enable `identityContinuityEnabled`.
   - Keep `identityInjectionMode=recovery_only`.
   - Leave `continuityIncidentLoggingEnabled` and `continuityAuditEnabled` off.
2. Medium risk:
   - Enable incident logging and weekly audits.
   - Keep explicit alerting on stale loops and open incidents.
3. High risk:
   - Enable full continuity workflow with regular audit cadence.
   - Add operator review gate before any mode shift to `full`.
   - Require hardening checks before merge for continuity-path changes.
