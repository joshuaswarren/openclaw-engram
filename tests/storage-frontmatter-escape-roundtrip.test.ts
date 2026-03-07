import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";

test("StorageManager round-trips escaped backslashes and quotes for importance reasons and link reasons", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-escape-roundtrip-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const reasonWithEscapes = String.raw`Path C:\work\"quoted"`;
    const linkReasonWithEscapes = String.raw`See C:\docs\"policy" for context`;

    const id = await storage.writeMemory("fact", "payload", {
      source: "test",
      importance: {
        score: 0.9,
        level: "high",
        reasons: [reasonWithEscapes],
        keywords: ["escaping"],
      },
      links: [
        {
          targetId: "fact-target",
          linkType: "supports",
          strength: 0.7,
          reason: linkReasonWithEscapes,
        },
      ],
    });

    const firstRead = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(firstRead);
    assert.deepEqual(firstRead.frontmatter.importance?.reasons, [reasonWithEscapes]);
    assert.equal(firstRead.frontmatter.links?.[0]?.reason, linkReasonWithEscapes);

    const added = await storage.addLinksToMemory(id, [
      {
        targetId: "fact-target-2",
        linkType: "elaborates",
        strength: 0.5,
        reason: linkReasonWithEscapes,
      },
    ]);
    assert.equal(added, true);

    const secondRead = (await storage.readAllMemories()).find((m) => m.frontmatter.id === id);
    assert.ok(secondRead);
    assert.deepEqual(secondRead.frontmatter.importance?.reasons, [reasonWithEscapes]);
    assert.equal(secondRead.frontmatter.links?.[0]?.reason, linkReasonWithEscapes);
    assert.equal(secondRead.frontmatter.links?.[1]?.reason, linkReasonWithEscapes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
