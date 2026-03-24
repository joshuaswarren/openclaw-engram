#!/usr/bin/env tsx
/**
 * Test the calibration engine against real production corrections.
 * Reads corrections from the production Engram memory, sends them to the LLM,
 * and displays the synthesized CalibrationRules.
 *
 * This does NOT write to production memory — it only reads corrections
 * and writes results to stdout.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { FallbackLlmClient } from "../src/fallback-llm.js";
import { synthesizeCalibrationRules } from "../src/calibration.js";

const MEMORY_DIR = path.join(process.env.HOME!, ".openclaw/workspace/memory/local");

async function main() {
  // Load gateway config
  const gatewayConfig = JSON.parse(
    readFileSync(path.join(process.env.HOME!, ".openclaw/openclaw.json"), "utf8"),
  );

  const llm = new FallbackLlmClient(gatewayConfig);
  console.log("LLM available:", llm.isAvailable());

  // Read corrections manually
  const fs = await import("node:fs");
  const correctionsDir = path.join(MEMORY_DIR, "corrections");
  const files = fs.readdirSync(correctionsDir).filter((f: string) => f.endsWith(".md"));
  console.log(`Found ${files.length} correction files`);

  const corrections: Array<{ id: string; content: string; created: string; confidence: number; entityRefs: string[]; tags: string[] }> = [];

  for (const file of files.slice(0, 40)) { // Limit to 40 for testing
    const raw = fs.readFileSync(path.join(correctionsDir, file), "utf8");
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) continue;
    const content = fmMatch[2].trim();
    if (!content || content.length < 10) continue;
    const idMatch = fmMatch[1].match(/^id:\s*(.+)$/m);
    const id = idMatch?.[1]?.trim() ?? file.replace(".md", "");
    corrections.push({ id, content, created: "", confidence: 0.95, entityRefs: [], tags: [] });
  }

  console.log(`Parsed ${corrections.length} corrections`);
  console.log("\nSample corrections:");
  for (const c of corrections.slice(0, 5)) {
    console.log(`  - ${c.content.slice(0, 120)}`);
  }

  console.log("\nSending to LLM for calibration analysis...");
  const rules = await synthesizeCalibrationRules(corrections, llm, []);

  console.log(`\n=== CALIBRATION RULES (${rules.length}) ===\n`);
  for (const rule of rules) {
    console.log(`[${rule.ruleType}] ${rule.condition}`);
    console.log(`  Model tends to: ${rule.modelTendency}`);
    console.log(`  User expects: ${rule.userExpectation}`);
    console.log(`  Calibration: ${rule.calibration}`);
    console.log(`  Confidence: ${rule.confidence}`);
    console.log("");
  }
}

main().catch(console.error);
