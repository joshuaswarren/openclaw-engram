import test from "node:test";
import assert from "node:assert/strict";

/**
 * Regression test for: memory_store not triggering QMD sync after write.
 *
 * The bug: QmdClient.update() and embed() did not pass `-c <collection>`,
 * and memory_store never called update()/embed() after writing a file,
 * so new memories were never indexed and never searchable.
 */

test("QmdClient.update() passes collection flag to qmd subprocess", async () => {
  // We can't easily run the real qmd binary in tests, so we verify the
  // source code contains the collection-scoped flags.
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const qmdSource = readFileSync(
    resolve(import.meta.dirname, "..", "src", "qmd.ts"),
    "utf-8",
  );

  // update() must pass -c collection
  assert.match(
    qmdSource,
    /runQmd\(\["update",\s*"-c",\s*this\.collection\]/,
    "update() should pass -c this.collection to scope updates to the engram collection",
  );

  // embed() must pass -c collection
  assert.match(
    qmdSource,
    /runQmd\(\["embed",\s*"-c",\s*this\.collection\]/,
    "embed() should pass -c this.collection to scope embedding to the engram collection",
  );
});

test("memory_store tool triggers QMD sync after writing", async () => {
  // Verify the tools source calls qmd update+embed after writeMemory
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const toolsSource = readFileSync(
    resolve(import.meta.dirname, "..", "src", "tools.ts"),
    "utf-8",
  );

  // Find the memory_store section and verify it calls qmd sync after writeMemory
  const storeSection = toolsSource.slice(
    toolsSource.indexOf("memory_store"),
    toolsSource.indexOf("memory_promote"),
  );

  assert.ok(
    storeSection.includes("orchestrator.qmd.update()"),
    "memory_store should call orchestrator.qmd.update() after writing",
  );
  assert.ok(
    storeSection.includes(".embed()"),
    "memory_store should call embed() after update to index new memories",
  );
});
