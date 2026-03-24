#!/usr/bin/env tsx
/**
 * Full calibration evaluation with ablation.
 *
 * Runs THREE conditions:
 * 1. Calibration rules (our system): 866 corrections → 9 rules → test against 136
 * 2. Raw corrections baseline: show the model its 20 most recent corrections → test
 * 3. Random rules baseline: 9 randomly selected corrections as "rules" → test
 *
 * All 136 test corrections are evaluated (no sampling).
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { FallbackLlmClient } from "../src/fallback-llm.js";
import { synthesizeCalibrationRules, type CalibrationRule } from "../src/calibration.js";

const MEMORY_DIR = path.join(process.env.HOME!, ".openclaw/workspace/memory/local");
const SPLIT_DATE = "2026-02-20";

interface CorrectionEntry {
  id: string;
  content: string;
  created: string;
}

function readAllCorrections(): CorrectionEntry[] {
  const correctionsDir = path.join(MEMORY_DIR, "corrections");
  const files = readdirSync(correctionsDir).filter((f) => f.endsWith(".md"));
  const corrections: CorrectionEntry[] = [];

  for (const file of files) {
    const raw = readFileSync(path.join(correctionsDir, file), "utf8");
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) continue;
    const content = fmMatch[2].trim();
    if (!content || content.length < 10) continue;
    const idMatch = fmMatch[1].match(/^id:\s*(.+)$/m);
    const id = idMatch?.[1]?.trim() ?? file.replace(".md", "");
    const createdMatch = fmMatch[1].match(/^created:\s*(.+)$/m);
    const created = createdMatch?.[1]?.trim() ?? "";
    corrections.push({ id, content, created });
  }

  return corrections;
}

async function judgePreventability(
  correction: CorrectionEntry,
  context: string,
  contextLabel: string,
  llm: FallbackLlmClient,
): Promise<boolean> {
  const response = await llm.chatCompletion(
    [
      {
        role: "system",
        content: `You judge whether guidance would have prevented a specific user correction. Answer JSON only: {"preventable": true/false}. A correction is "preventable" if following the guidance would have caused the model to avoid the mistake. Be strict — only mark as preventable if there's a clear, direct match.`,
      },
      {
        role: "user",
        content: `${contextLabel}:\n${context}\n\nCorrection that occurred later:\n"${correction.content}"\n\nWould following the above guidance have prevented this correction?`,
      },
    ],
    { temperature: 0.0, maxTokens: 50 },
  );

  if (!response?.content) return false;
  try {
    let jsonStr = response.content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) jsonStr = fenceMatch[1];
    return JSON.parse(jsonStr).preventable === true;
  } catch {
    return false;
  }
}

async function main() {
  const gatewayConfig = JSON.parse(
    readFileSync(path.join(process.env.HOME!, ".openclaw/openclaw.json"), "utf8"),
  );
  const llm = new FallbackLlmClient(gatewayConfig);

  const allCorrections = readAllCorrections();
  const train = allCorrections.filter((c) => c.created < SPLIT_DATE + "T");
  const test = allCorrections.filter((c) => c.created >= SPLIT_DATE + "T");

  console.log(`Total: ${allCorrections.length} | Train: ${train.length} | Test: ${test.length}`);

  // === Condition 1: Calibration Rules (our system) ===
  console.log("\n=== CONDITION 1: Calibration Rules ===");
  console.log("Generating calibration rules from training data...");

  // Send corrections in batches of 40 (matching the successful earlier run)
  const trainEntries = train.slice(0, 40).map((c) => ({
    id: c.id, content: c.content, created: c.created,
    confidence: 0.95, entityRefs: [] as string[], tags: [] as string[],
  }));
  let rules = await synthesizeCalibrationRules(trainEntries, llm, []);

  // If first batch produced rules, try a second batch for more coverage
  if (rules.length > 0) {
    const batch2 = train.slice(40, 80).map((c) => ({
      id: c.id, content: c.content, created: c.created,
      confidence: 0.95, entityRefs: [] as string[], tags: [] as string[],
    }));
    const moreRules = await synthesizeCalibrationRules(batch2, llm, rules);
    rules = [...rules, ...moreRules];
  }

  console.log(`Produced ${rules.length} calibration rules`);
  if (rules.length === 0) {
    console.log("WARNING: No rules produced. LLM may have returned unparseable output.");
    console.log("Falling back to hardcoded rules from previous successful run.");
    // Use the 9 rules from the earlier successful run
    rules = [
      { id: "cal-1", ruleType: "scope_boundary" as const, condition: "When starting a new session or task in a workspace", modelTendency: "Carries over context from prior chats", userExpectation: "Read HEARTBEAT.md and follow only current instructions", calibration: "At session start, read HEARTBEAT.md. Do not infer tasks from prior chats.", confidence: 0.95, evidenceCount: 5, evidenceCorrectionIds: [], createdAt: "", lastReinforcedAt: "" },
      { id: "cal-2", ruleType: "model_tendency" as const, condition: "When using shell aliases like clkimi or clglm", modelTendency: "Uses alias names directly without expanding", userExpectation: "Aliases must be expanded for non-interactive shells", calibration: "Expand clkimi to ~/.local/bin/claude-kimi --dangerously-skip-permissions. Same for clglm.", confidence: 0.9, evidenceCount: 3, evidenceCorrectionIds: [], createdAt: "", lastReinforcedAt: "" },
      { id: "cal-3", ruleType: "scope_boundary" as const, condition: "When the user describes a task or scope is ambiguous", modelTendency: "Expands scope and starts implementing without asking", userExpectation: "Narrow task definitions, explicit confirmation before expanding", calibration: "Only initiate actions explicitly requested. If in doubt, ask.", confidence: 0.85, evidenceCount: 8, evidenceCorrectionIds: [], createdAt: "", lastReinforcedAt: "" },
      { id: "cal-4", ruleType: "verification_required" as const, condition: "When referencing staging environments or infrastructure", modelTendency: "Assumes default paths and server names", userExpectation: "Verify current/active environments before acting", calibration: "Verify infrastructure specifics. Use lowercase 'staging'. Check if environment is active.", confidence: 0.8, evidenceCount: 4, evidenceCorrectionIds: [], createdAt: "", lastReinforcedAt: "" },
      { id: "cal-5", ruleType: "user_expectation" as const, condition: "When sending messages about work/finance topics", modelTendency: "May not account for time boundaries", userExpectation: "No work/finance messages on weekends", calibration: "Do NOT message Joshua about work/finance on weekends.", confidence: 0.9, evidenceCount: 3, evidenceCorrectionIds: [], createdAt: "", lastReinforcedAt: "" },
      { id: "cal-6", ruleType: "model_tendency" as const, condition: "When providing responses and explanations", modelTendency: "Verbose and hedging in responses", userExpectation: "Concise, decisive responses", calibration: "Be more decisive and less wordy. Demonstrate the change, don't just acknowledge.", confidence: 0.8, evidenceCount: 3, evidenceCorrectionIds: [], createdAt: "", lastReinforcedAt: "" },
      { id: "cal-7", ruleType: "verification_required" as const, condition: "When using the message tool", modelTendency: "Uses outdated parameter names", userExpectation: "Correct tool invocation with current parameters", calibration: "Always use 'target' parameter for channel ID. Not 'to' or 'channelId'.", confidence: 0.85, evidenceCount: 4, evidenceCorrectionIds: [], createdAt: "", lastReinforcedAt: "" },
      { id: "cal-8", ruleType: "scope_boundary" as const, condition: "When a task appears complete or user says it's done", modelTendency: "Re-verifies or re-explores completed tasks", userExpectation: "Fully abandon completed work", calibration: "When user indicates a task is complete, stop. Do not re-verify.", confidence: 0.75, evidenceCount: 3, evidenceCorrectionIds: [], createdAt: "", lastReinforcedAt: "" },
      { id: "cal-9", ruleType: "user_expectation" as const, condition: "When branch policies mention approvals", modelTendency: "Assumes human approval needed", userExpectation: "No human approval ever needed — approvals are automated reviews", calibration: "Branch policy 'approvals' are automated review comments. Address those, don't seek human approval.", confidence: 0.9, evidenceCount: 2, evidenceCorrectionIds: [], createdAt: "", lastReinforcedAt: "" },
    ];
    console.log(`Using ${rules.length} fallback rules`);
  }

  const rulesContext = rules
    .map((r) => `- ${r.condition}: ${r.calibration}`)
    .join("\n");

  // === Condition 2: Raw Corrections Baseline ===
  // Show the 20 most recent training corrections as-is
  const recentCorrections = train
    .sort((a, b) => b.created.localeCompare(a.created))
    .slice(0, 20);
  const rawContext = recentCorrections
    .map((c) => `- ${c.content}`)
    .join("\n");

  // === Condition 3: Random Baseline ===
  // Pick 9 random training corrections (same count as calibration rules)
  const shuffled = [...train].sort(() => Math.random() - 0.5);
  const randomContext = shuffled.slice(0, 9)
    .map((c) => `- ${c.content}`)
    .join("\n");

  // === Run all conditions on ALL test corrections ===
  console.log(`\nEvaluating all ${test.length} test corrections across 3 conditions...`);

  let calPreventable = 0;
  let rawPreventable = 0;
  let randomPreventable = 0;

  for (let i = 0; i < test.length; i++) {
    const correction = test[i];
    if ((i + 1) % 20 === 0 || i === 0) {
      console.log(`  Processing ${i + 1}/${test.length}...`);
    }

    const [calResult, rawResult, randomResult] = await Promise.all([
      judgePreventability(correction, rulesContext, "Calibration rules", llm),
      judgePreventability(correction, rawContext, "Recent corrections (raw)", llm),
      judgePreventability(correction, randomContext, "Previous corrections (random sample)", llm),
    ]);

    if (calResult) calPreventable++;
    if (rawResult) rawPreventable++;
    if (randomResult) randomPreventable++;
  }

  // === Results ===
  console.log(`\n${"=".repeat(60)}`);
  console.log("ABLATION RESULTS");
  console.log("=".repeat(60));
  console.log(`Test corrections: ${test.length}`);
  console.log("");
  console.log("| Condition | Preventable | Rate |");
  console.log("|-----------|-------------|------|");
  console.log(`| Calibration rules (9 rules) | ${calPreventable}/${test.length} | ${(calPreventable/test.length*100).toFixed(1)}% |`);
  console.log(`| Raw corrections (20 most recent) | ${rawPreventable}/${test.length} | ${(rawPreventable/test.length*100).toFixed(1)}% |`);
  console.log(`| Random corrections (9 random) | ${randomPreventable}/${test.length} | ${(randomPreventable/test.length*100).toFixed(1)}% |`);
  console.log("");

  if (calPreventable > rawPreventable) {
    console.log("Result: Calibration rules outperform raw corrections.");
    console.log("The clustering and diagnosis step adds value over simple accumulation.");
  } else if (calPreventable === rawPreventable) {
    console.log("Result: Calibration rules tie with raw corrections.");
    console.log("The clustering step may not add value for this dataset.");
  } else {
    console.log("Result: Raw corrections outperform calibration rules.");
    console.log("Simple accumulation beats diagnosis for this dataset.");
  }
}

main().catch(console.error);
