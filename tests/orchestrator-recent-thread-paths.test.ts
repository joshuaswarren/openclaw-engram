import test from "node:test";
import assert from "node:assert/strict";

import { resolveRecentThreadMemoryPaths } from "../src/orchestrator.js";
import type { MemoryFile } from "../src/types.js";

function makeMemory(path: string, id: string): MemoryFile {
  return {
    path,
    content: "x",
    frontmatter: {
      id,
      category: "fact",
      confidence: 0.8,
      created: "2026-02-22T10:00:00.000Z",
      updated: "2026-02-22T10:00:00.000Z",
      tags: [],
      source: "extraction",
      status: "active",
    },
  };
}

test("resolveRecentThreadMemoryPaths uses real memory paths from allMemsForGraph", () => {
  const storageDir = "/tmp/memory";
  const allMems: MemoryFile[] = [
    makeMemory("/tmp/memory/facts/2026-02-22/fact-a.md", "fact-a"),
    makeMemory("/tmp/memory/corrections/correction-b.md", "correction-b"),
    makeMemory("/tmp/memory/facts/2026-02-21/fact-c.md", "fact-c"),
  ];

  const recent = resolveRecentThreadMemoryPaths({
    threadEpisodeIds: ["fact-a", "correction-b", "fact-c", "current-id"],
    currentMemoryId: "current-id",
    allMemsForGraph: allMems,
    storageDir,
    maxRecent: 3,
  });

  assert.deepEqual(recent, [
    "facts/2026-02-22/fact-a.md",
    "corrections/correction-b.md",
    "facts/2026-02-21/fact-c.md",
  ]);
});

test("resolveRecentThreadMemoryPaths drops unknown IDs instead of fabricating facts/ paths", () => {
  const storageDir = "/tmp/memory";
  const allMems: MemoryFile[] = [makeMemory("/tmp/memory/corrections/correction-b.md", "correction-b")];

  const recent = resolveRecentThreadMemoryPaths({
    threadEpisodeIds: ["missing-id", "correction-b"],
    currentMemoryId: "current-id",
    allMemsForGraph: allMems,
    storageDir,
    maxRecent: 3,
  });

  assert.deepEqual(recent, ["corrections/correction-b.md"]);
});
