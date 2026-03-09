import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { ContentHashIndex, StorageManager } from "../src/storage.ts";

test("concurrent fact hash lookups wait for a single shared index load", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-fact-hash-"));
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir, { recursive: true });
  const content = "User prefers pourover coffee.";
  await writeFile(path.join(stateDir, "fact-hashes.ready"), "v1\n", "utf-8");
  await writeFile(
    path.join(stateDir, "fact-hashes.txt"),
    `${ContentHashIndex.computeHash(content)}\n`,
    "utf-8",
  );

  const originalLoad = ContentHashIndex.prototype.load;
  let loadCalls = 0;
  ContentHashIndex.prototype.load = async function patchedLoad(this: ContentHashIndex) {
    loadCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await originalLoad.call(this);
  };

  try {
    const storage = new StorageManager(dir);
    const [first, second] = await Promise.all([
      storage.hasFactContentHash(content),
      storage.hasFactContentHash(content),
    ]);

    assert.equal(first, true);
    assert.equal(second, true);
    assert.equal(loadCalls, 1);
  } finally {
    ContentHashIndex.prototype.load = originalLoad;
    await rm(dir, { recursive: true, force: true });
  }
});
