#!/usr/bin/env tsx
import { createCmcAdapter } from "../evals/adapter/cmc-adapter.js";
import { readFileSync } from "fs";

async function main() {
  const data = JSON.parse(readFileSync("evals/datasets/longmemeval/longmemeval_oracle.json", "utf8"));
  const prefQ = data[200]; // First preference question
  const adapter = await createCmcAdapter();

  console.log("Q:", prefQ.question);
  console.log("A:", prefQ.answer.slice(0, 120) + "...");

  // Store the haystack sessions (matching how the runner does it)
  const usedSessionIds: string[] = [];
  for (let si = 0; si < prefQ.haystack_sessions.length; si++) {
    const session = prefQ.haystack_sessions[si];
    const sessionId = prefQ.haystack_session_ids[si] ?? `session-${si}`;
    usedSessionIds.push(sessionId);
    const messages = session.map((t: any) => ({
      role: t.role as "user" | "assistant",
      content: t.content,
    }));
    console.log(`Storing ${sessionId}: ${messages.length} messages`);
    await adapter.store(sessionId, messages);
  }

  // Recall from all sessions (matching how the runner does it)
  const parts: string[] = [];
  for (const sid of usedSessionIds) {
    const r = await adapter.recall(sid, prefQ.question);
    if (r && r.trim().length > 0) parts.push(r);
  }
  const recallText = parts.join("\n\n");

  console.log(`\nRecall total length: ${recallText.length}`);
  console.log(`Has preference section: ${recallText.includes("User Preferences")}`);
  console.log(`Contains expected answer: ${recallText.toLowerCase().includes(prefQ.answer.toLowerCase())}`);

  // Check what the preference section says
  const prefIdx = recallText.indexOf("## User Preferences");
  if (prefIdx >= 0) {
    const nextSection = recallText.indexOf("\n##", prefIdx + 5);
    const section = nextSection > 0 ? recallText.slice(prefIdx, nextSection) : recallText.slice(prefIdx, prefIdx + 2000);
    console.log("\n=== PREFERENCE SECTION ===");
    console.log(section);
  } else {
    console.log("\n=== RECALL PREVIEW (first 1000 chars) ===");
    console.log(recallText.slice(0, 1000));
  }

  // Check: does the recall text contain key phrases from the expected answer?
  const answer = prefQ.answer.toLowerCase();
  const keyPhrases = [
    "would prefer",
    "adobe premiere pro",
    "specifically tailored",
    "advanced settings",
    "not prefer general",
  ];
  console.log("\n=== KEY PHRASE MATCHES ===");
  for (const phrase of keyPhrases) {
    console.log(`  "${phrase}": ${recallText.toLowerCase().includes(phrase)}`);
  }

  await adapter.destroy();
}

main().catch(console.error);
