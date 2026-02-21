import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";

test("artifact cache supports immediate recall for newly written artifacts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-artifact-cache-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    await storage.writeArtifact("alpha launch decision", { tags: ["launch"] });
    const alpha = await storage.searchArtifacts("alpha launch", 10);
    assert.equal(alpha.length > 0, true);

    // This write should be visible immediately even when artifact index cache is warm.
    await storage.writeArtifact("beta pricing constraint", { tags: ["pricing"] });
    const beta = await storage.searchArtifacts("beta pricing", 10);
    assert.equal(beta.some((m) => m.content.toLowerCase().includes("beta pricing constraint")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

