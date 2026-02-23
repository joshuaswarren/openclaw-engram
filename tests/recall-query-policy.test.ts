import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRecallQueryPolicy,
  classifyRecallPromptShape,
} from "../src/recall-query-policy.js";

const baseConfig = {
  cronRecallPolicyEnabled: true,
  cronRecallNormalizedQueryMaxChars: 320,
  cronRecallInstructionHeavyTokenCap: 24,
  cronConversationRecallMode: "auto" as const,
};

test("classifies instruction-heavy cron prompt shape", () => {
  const prompt = `
[cron:deckard-morning-briefing]
Goal: Generate a comprehensive morning briefing.
DATA GATHERING:
1. Read /Users/example/a.md
2. Read /Users/example/b.md
3. Extract section outputs
4. Parse ~/workspace/todo.md
5. Determine blockers and dependencies
6. Include only verified facts
OUTPUT FORMAT:
- Greeting
- Calendar
- Tasks
- Follow-ups
- Risks
- Priorities
GROUNDING RULES:
- Never invent details
- Omit sections with no data
- Skip stale items older than 7 days
- Return plain text only
FOLLOW-UP:
- Extract unresolved actions
- Include owners and due dates
Current time: Monday, February 23rd, 2026
`.trim();

  assert.equal(classifyRecallPromptShape(prompt), "instruction_heavy");
});

test("buildRecallQueryPolicy normalizes instruction-heavy cron prompts", () => {
  const prompt = `
[cron:deckard-morning-briefing] You are OpenClaw automation.
Goal: Generate briefing.
DATA GATHERING:
1. Read /Users/josh/really/long/path/to/file.md
2. Parse ~/workspace/notes/today.md
3. Include outputs
4. Read /Users/josh/operations/runbook.md
5. Determine unresolved incidents
6. Extract owners and deadlines
OUTPUT FORMAT:
- greeting
- tasks
- followups
- incidents
- blockers
GROUNDING RULES:
- Never invent details
- Skip empty sections
- Omit stale items
Return your summary as plain text.
`.trim();

  const result = buildRecallQueryPolicy(
    prompt,
    "agent:generalist:cron:deckard-morning-briefing",
    baseConfig,
  );

  assert.equal(result.promptShape, "instruction_heavy");
  assert.equal(result.skipConversationRecall, true);
  assert.equal(result.retrievalBudgetMode, "minimal");
  assert.ok(result.retrievalQuery.length > 0);
  assert.ok(result.retrievalQuery.length <= 320);
  assert.equal(result.retrievalQuery.includes("/Users/"), false);
  assert.equal(result.retrievalQuery.includes("~/"), false);
});

test("buildRecallQueryPolicy keeps standard non-cron prompts full", () => {
  const prompt = "Can you   remind me\nwhat we decided last week about API retries?  ";
  const result = buildRecallQueryPolicy(
    prompt,
    "agent:generalist:main",
    baseConfig,
  );

  assert.equal(result.promptShape, "standard");
  assert.equal(result.skipConversationRecall, false);
  assert.equal(result.retrievalBudgetMode, "full");
  assert.equal(result.retrievalQuery, prompt);
});

test("buildRecallQueryPolicy keeps raw prompt when cron policy is disabled", () => {
  const prompt = "  Keep   this\nas-is for recall query. ";
  const result = buildRecallQueryPolicy(
    prompt,
    "agent:generalist:cron:deckard-morning-briefing",
    { ...baseConfig, cronRecallPolicyEnabled: false },
  );

  assert.equal(result.promptShape, "standard");
  assert.equal(result.skipConversationRecall, false);
  assert.equal(result.retrievalBudgetMode, "full");
  assert.equal(result.retrievalQuery, prompt);
});

test("cron conversation mode override always keeps conversation recall", () => {
  const prompt = `
Goal: Generate report
DATA GATHERING:
1. Read /Users/example/report.md
2. Parse ~/workspace/briefing.md
3. Extract unresolved actions
OUTPUT FORMAT:
- Summary
- Tasks
- Risks
GROUNDING RULES:
- Never invent details
- Return plain text
`.trim();

  const result = buildRecallQueryPolicy(
    prompt,
    "agent:generalist:cron:job-123",
    { ...baseConfig, cronConversationRecallMode: "always" },
  );

  assert.equal(result.skipConversationRecall, false);
});
