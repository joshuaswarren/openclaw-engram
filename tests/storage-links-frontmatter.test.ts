import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";

test("StorageManager preserves escaped link reasons with backslashes/quotes/newlines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-link-reason-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const reason = String.raw`Path C:\Users\dev\notes says "keep it"` + "\nnext line";
    const id = await storage.writeMemory("fact", "payload", {
      source: "test",
      links: [
        {
          targetId: "fact-target",
          linkType: "references",
          strength: 0.9,
          reason,
        },
      ],
    });

    const first = await storage.getMemoryById(id);
    assert.ok(first);
    assert.equal(first.frontmatter.links?.[0]?.reason, reason);

    await storage.addLinksToMemory(id, [
      {
        targetId: "fact-other",
        linkType: "related",
        strength: 0.7,
        reason: String.raw`follow-up at D:\logs`,
      },
    ]);

    const second = await storage.getMemoryById(id);
    assert.ok(second);
    const persistedReasons = (second.frontmatter.links ?? []).map((link) => link.reason);
    assert.ok(persistedReasons.includes(reason));

    const raw = await readFile(second.path, "utf-8");
    assert.match(raw, /reason: "Path C:\\\\Users\\\\dev\\\\notes says \\"keep it\\"\\nnext line"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
