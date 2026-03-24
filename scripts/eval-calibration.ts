#!/usr/bin/env tsx
/**
 * Evaluate calibration system using temporal holdout.
 *
 * 1. Train: Run calibration on corrections before Feb 20 → CalibrationRules
 * 2. Test: For each correction after Feb 20, ask LLM judge:
 *    "Given these calibration rules, would this correction have been preventable?"
 * 3. Report: What % of future corrections could have been prevented?
 *
 * This does NOT write to production memory.
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
  rules: CalibrationRule[],
  llm: FallbackLlmClient,
): Promise<{ preventable: boolean; explanation: string }> {
  const rulesText = rules
    .map((r) => `- ${r.condition}: ${r.calibration}`)
    .join("\n");

  const response = await llm.chatCompletion(
    [
      {
        role: "system",
        content: `You are evaluating whether a calibration rule would have prevented a specific user correction. Answer with JSON only: {"preventable": true/false, "explanation": "brief reason"}`,
      },
      {
        role: "user",
        content: `Calibration rules:\n${rulesText}\n\nCorrection that occurred later:\n"${correction.content}"\n\nWould any of these calibration rules have prevented this correction? A correction is "preventable" if the calibration rules, if followed, would have caused the model to avoid the mistake that led to the correction.`,
      },
    ],
    { temperature: 0.1, maxTokens: 200 },
  );

  if (!response?.content) return { preventable: false, explanation: "no LLM response" };

  try {
    let jsonStr = response.content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) jsonStr = fenceMatch[1];
    const parsed = JSON.parse(jsonStr);
    return {
      preventable: parsed.preventable === true,
      explanation: String(parsed.explanation ?? ""),
    };
  } catch {
    return { preventable: false, explanation: "parse error" };
  }
}

async function main() {
  const gatewayConfig = JSON.parse(
    readFileSync(path.join(process.env.HOME!, ".openclaw/openclaw.json"), "utf8"),
  );
  const llm = new FallbackLlmClient(gatewayConfig);

  // Read and split corrections
  const allCorrections = readAllCorrections();
  const train = allCorrections.filter((c) => c.created < SPLIT_DATE + "T");
  const test = allCorrections.filter((c) => c.created >= SPLIT_DATE + "T");

  console.log(`Total corrections: ${allCorrections.length}`);
  console.log(`Training (before ${SPLIT_DATE}): ${train.length}`);
  console.log(`Testing (${SPLIT_DATE} and after): ${test.length}`);

  // Phase 1: Calibrate on training corrections
  console.log("\nPhase 1: Running calibration on training corrections...");
  const trainEntries = train.map((c) => ({
    id: c.id,
    content: c.content,
    created: c.created,
    confidence: 0.95,
    entityRefs: [] as string[],
    tags: [] as string[],
  }));

  const rules = await synthesizeCalibrationRules(trainEntries, llm, []);
  console.log(`\nCalibration produced ${rules.length} rules:`);
  for (const rule of rules) {
    console.log(`  [${rule.ruleType}] ${rule.condition}`);
    console.log(`    → ${rule.calibration}`);
  }

  if (rules.length === 0) {
    console.log("No rules produced — cannot evaluate.");
    return;
  }

  // Phase 2: Judge preventability of test corrections
  console.log(`\nPhase 2: Judging ${test.length} test corrections...`);
  const testSample = test.slice(0, 50); // Test 50 corrections
  let preventable = 0;
  let total = 0;

  for (const correction of testSample) {
    const result = await judgePreventability(correction, rules, llm);
    total++;
    if (result.preventable) {
      preventable++;
      console.log(`  ✓ PREVENTABLE: "${correction.content.slice(0, 80)}..."`);
      console.log(`    Reason: ${result.explanation}`);
    } else {
      console.log(`  ✗ Not preventable: "${correction.content.slice(0, 80)}..."`);
    }
  }

  // Results
  const rate = total > 0 ? (preventable / total * 100).toFixed(1) : "0";
  console.log(`\n=== RESULTS ===`);
  console.log(`Rules produced from training data: ${rules.length}`);
  console.log(`Test corrections evaluated: ${total}`);
  console.log(`Preventable corrections: ${preventable}/${total} (${rate}%)`);
  console.log(`\nInterpretation: ${rate}% of future corrections could have been`);
  console.log(`prevented if the calibration rules had been active.`);
}

main().catch(console.error);
