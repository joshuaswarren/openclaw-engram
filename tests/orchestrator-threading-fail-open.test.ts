import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("runExtraction handles pre-persist threading errors fail-open", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");

  assert.match(
    source,
    /try\s*\{\s*threadIdForExtraction\s*=\s*await\s*this\.threading\.processTurn\(lastTurn,\s*\[\]\);\s*\}\s*catch\s*\(err\)\s*\{[\s\S]*?non-fatal/m,
    "threading.processTurn before persistence should be wrapped in fail-open try/catch",
  );
});

test("persistExtraction appends each new memory ID to the active thread before graph edge construction", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");

  const appendIdx = source.indexOf("await this.threading.appendEpisodeIds(threadIdForExtraction, [memoryId]);");
  const buildIdx = source.search(
    /await this\.buildGraphEdge\(\s*storage,\s*memoryRelPath,\s*entityRef,\s*memoryId/m,
  );

  assert.notEqual(appendIdx, -1, "expected appendEpisodeIds call for non-chunked memory writes");
  assert.notEqual(buildIdx, -1, "expected buildGraphEdge call for non-chunked memory writes");
  assert.ok(
    appendIdx < buildIdx,
    "appendEpisodeIds should execute before buildGraphEdge so same-batch memories can form time/causal edges",
  );
});

test("persistExtraction gates per-memory thread appends behind multiGraphMemoryEnabled", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");

  assert.match(
    source,
    /if\s*\(\s*this\.config\.multiGraphMemoryEnabled\s*&&\s*threadIdForExtraction\s*\)\s*\{\s*try\s*\{\s*await this\.threading\.appendEpisodeIds\(threadIdForExtraction,\s*\[memoryId\]\);/m,
    "non-chunked per-memory append should only run when graphing is enabled",
  );
  assert.match(
    source,
    /if\s*\(\s*this\.config\.multiGraphMemoryEnabled\s*&&\s*threadIdForExtraction\s*\)\s*\{\s*try\s*\{\s*await this\.threading\.appendEpisodeIds\(threadIdForExtraction,\s*\[parentId\]\);/m,
    "chunked parent per-memory append should only run when graphing is enabled",
  );
});

test("buildGraphEdge does not read global current thread ID", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");

  assert.doesNotMatch(
    source,
    /this\.threading\.getCurrentThreadId\(\)/,
    "graph edge construction should use explicit extraction thread context, not global mutable thread state",
  );
});

test("buildGraphEdge does not reload thread file per memory write", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");

  assert.doesNotMatch(
    source,
    /await this\.threading\.loadThread\(threadIdForEdge\)/,
    "buildGraphEdge should use in-memory thread episode IDs and avoid per-fact thread reloads",
  );
  assert.match(
    source,
    /threadEpisodeIdsForGraph:\s*string\[\]\s*\|\s*undefined/,
    "buildGraphEdge should accept in-memory thread episode IDs",
  );
});

test("persisted path resolution does not call getMemoryById in per-fact write flow", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");
  const helperMatch = source.match(
    /export function resolvePersistedMemoryRelativePath\([\s\S]*?\n\}\n\nexport class Orchestrator/m,
  );
  assert.ok(helperMatch, "expected resolvePersistedMemoryRelativePath helper in orchestrator.ts");
  const helperSource = helperMatch[0];

  assert.match(helperSource, /pathById:\s*Map<string,\s*string>/);
  assert.doesNotMatch(helperSource, /getMemoryById\(/);
});

test("persisted path resolution is not short-circuited by set-before-resolve", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");
  assert.doesNotMatch(
    source,
    /memoryPathById\.set\([^)]*\);\s*const (?:parentRelPath|memoryRelPath) = resolvePersistedMemoryRelativePath\(/m,
    "pathById should not be seeded with fallback immediately before resolvePersistedMemoryRelativePath",
  );
});

test("buildGraphEdge forwards fallback causal predecessor when thread context is absent", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");
  assert.match(
    source,
    /const causalPredecessor = recentInThread\[recentInThread\.length - 1\] \?\? fallbackCausalPredecessor;/,
    "expected causal predecessor to fall back to same-extraction ordering when no thread history is available",
  );
});

test("persistExtraction includes written question IDs in persistedIds", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");
  assert.match(
    source,
    /const id = await storage\.writeQuestion\(q\.question,\s*q\.context,\s*q\.priority\);\s*if \(id\) persistedIds\.push\(id\);/m,
    "question IDs should be added to persistedIds so thread batch append can include them",
  );
});
