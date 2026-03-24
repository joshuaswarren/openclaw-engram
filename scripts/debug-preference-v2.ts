#!/usr/bin/env tsx
import { createCmcAdapter } from "../evals/adapter/cmc-adapter.js";
import { readFileSync } from "fs";

async function main() {
  const data = JSON.parse(readFileSync("evals/datasets/longmemeval/longmemeval_oracle.json", "utf8"));
  const prefQ = data[200]; // First preference question
  const adapter = await createCmcAdapter();

  console.log("Q:", prefQ.question);
  console.log("Sessions:", prefQ.haystack_sessions.length);
  console.log("Session IDs:", prefQ.haystack_session_ids);

  // Store the haystack sessions
  for (let i = 0; i < prefQ.haystack_sessions.length; i++) {
    const sessionId = prefQ.haystack_session_ids?.[i] ?? `session-${i}`;
    const msgs = prefQ.haystack_sessions[i];
    console.log(`\nStoring session ${sessionId}: ${msgs.length} messages`);
    await adapter.store(sessionId, msgs);

    // Check stats after store
    const stats = await adapter.getStats(sessionId);
    console.log(`  Stats after store: totalMessages=${stats.totalMessages}`);
  }

  // Search to verify data is stored
  const searchResults = await adapter.search(prefQ.question, 5);
  console.log(`\nSearch results: ${searchResults.length}`);
  for (const r of searchResults.slice(0, 3)) {
    console.log(`  [${r.role}] ${r.snippet?.slice(0, 100) ?? "(no snippet)"}`);
  }

  // Try recall
  const result = await adapter.recall("session-0", prefQ.question);
  console.log(`\nRecall length: ${result.length}`);
  console.log(`Has preference section: ${result.includes("User Preferences")}`);
  console.log(`Recall preview: ${result.slice(0, 500)}`);

  // Check user messages for preference signals
  const allMsgs = prefQ.haystack_sessions.flat();
  const userMsgs = allMsgs.filter((m: any) => m.role === "user");
  console.log(`\nUser messages with preference signals:`);
  for (const msg of userMsgs) {
    if (/prefer|enjoy|like|love|use|interested/i.test(msg.content)) {
      console.log(`  "${msg.content.slice(0, 150)}"`);
    }
  }

  await adapter.destroy();
}

main().catch(console.error);
