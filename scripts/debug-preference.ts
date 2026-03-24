#!/usr/bin/env tsx
import { createCmcAdapter } from "../evals/adapter/cmc-adapter.js";
import { readFileSync } from "fs";

async function main() {
  const data = JSON.parse(readFileSync("evals/datasets/longmemeval/longmemeval_oracle.json", "utf8"));
  const prefQ = data[200]; // First preference question
  const adapter = await createCmcAdapter();

  // Store the haystack sessions
  for (let i = 0; i < prefQ.haystack_sessions.length; i++) {
    const sessionId = prefQ.haystack_session_ids?.[i] ?? `session-${i}`;
    await adapter.store(sessionId, prefQ.haystack_sessions[i]);
  }

  // Recall with the question
  const result = await adapter.recall("session-0", prefQ.question);
  console.log("=== QUESTION ===");
  console.log(prefQ.question);
  console.log("");
  console.log("=== EXPECTED ANSWER ===");
  console.log(prefQ.answer);
  console.log("");

  // Check for preference section
  const prefSection = result.includes("User Preferences");
  console.log("=== HAS PREFERENCE SECTION? ===", prefSection);

  // Extract just the preference section if it exists
  const prefIdx = result.indexOf("## User Preferences");
  if (prefIdx >= 0) {
    const nextSection = result.indexOf("##", prefIdx + 5);
    const section = nextSection > 0 ? result.slice(prefIdx, nextSection) : result.slice(prefIdx, prefIdx + 2000);
    console.log("\n=== PREFERENCE SECTION ===");
    console.log(section);
  } else {
    console.log("\n=== RECALL (first 1500 chars) ===");
    console.log(result.slice(0, 1500));
  }

  console.log("\n=== CONTAINS EXPECTED? ===");
  console.log(result.toLowerCase().includes(prefQ.answer.toLowerCase()));

  await adapter.destroy();
}

main().catch(console.error);
