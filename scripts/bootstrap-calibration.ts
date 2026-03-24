#!/usr/bin/env tsx
/**
 * Bootstrap calibration rules into production memory.
 * Reads corrections from production, generates rules, writes to production calibration index.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { runCalibrationConsolidation, readCalibrationIndex } from "../src/calibration.js";

const MEMORY_DIR = path.join(process.env.HOME!, ".openclaw/workspace/memory/local");

async function main() {
  const gatewayConfig = JSON.parse(
    readFileSync(path.join(process.env.HOME!, ".openclaw/openclaw.json"), "utf8"),
  );

  console.log("Running calibration consolidation against production corrections...");
  console.log(`Memory dir: ${MEMORY_DIR}`);

  const rules = await runCalibrationConsolidation({
    memoryDir: MEMORY_DIR,
    gatewayConfig,
  });

  console.log(`\nCalibration rules written: ${rules.length}`);
  for (const r of rules) {
    console.log(`  [${r.ruleType}] ${r.condition.slice(0, 80)}`);
    console.log(`    → ${r.calibration.slice(0, 100)}`);
  }

  // Verify the index was written
  const index = await readCalibrationIndex(MEMORY_DIR);
  console.log(`\nVerification: ${index.rules.length} rules in production index`);
  console.log(`Total corrections analyzed: ${index.totalCorrectionsAnalyzed}`);
}

main().catch(console.error);
