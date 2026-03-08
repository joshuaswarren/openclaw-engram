import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import {
  collectNativeKnowledgeChunks,
  formatNativeKnowledgeSection,
  searchNativeKnowledge,
} from "../src/native-knowledge.js";

test("collectNativeKnowledgeChunks reads configured workspace files and preserves heading ranges", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-native-knowledge-"));
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, "IDENTITY.md"),
    "# Identity\n\nPrefers concise responses.\n\n## Work Style\n\nLikes deterministic tests.\n",
    "utf-8",
  );
  await writeFile(
    path.join(workspaceDir, "MEMORY.md"),
    "# Memory\n\nThe API rate limit issue was caused by a stale token.\n",
    "utf-8",
  );

  const chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    config: {
      enabled: true,
      includeFiles: ["IDENTITY.md", "MEMORY.md"],
      maxChunkChars: 200,
      maxResults: 4,
      maxChars: 2400,
    },
    defaultNamespace: "default",
  });

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]?.sourcePath, "IDENTITY.md");
  assert.equal(chunks[1]?.title, "Work Style");
  assert.equal(chunks[2]?.sourcePath, "MEMORY.md");
});

test("collectNativeKnowledgeChunks includes namespaced identity files for allowed recall namespaces", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-native-knowledge-ns-"));
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(path.join(workspaceDir, "IDENTITY.shared.md"), "# Shared\n\nShared deployment notes.\n", "utf-8");

  const chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    config: {
      enabled: true,
      includeFiles: ["IDENTITY.md"],
      maxChunkChars: 200,
      maxResults: 4,
      maxChars: 2400,
    },
    recallNamespaces: ["shared"],
    defaultNamespace: "default",
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.sourcePath, "IDENTITY.shared.md");
});

test("collectNativeKnowledgeChunks preserves include file directory for namespaced identity variants", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-native-knowledge-subdir-"));
  await mkdir(path.join(workspaceDir, "docs"), { recursive: true });
  await writeFile(
    path.join(workspaceDir, "docs", "IDENTITY.shared.md"),
    "# Shared\n\nShared notes in docs.\n",
    "utf-8",
  );

  const chunks = await collectNativeKnowledgeChunks({
    workspaceDir,
    config: {
      enabled: true,
      includeFiles: ["docs/IDENTITY.md"],
      maxChunkChars: 200,
      maxResults: 4,
      maxChars: 2400,
    },
    recallNamespaces: ["shared"],
    defaultNamespace: "default",
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.sourcePath, "docs/IDENTITY.shared.md");
});

test("searchNativeKnowledge ranks identity and phrase matches highest", () => {
  const results = searchNativeKnowledge({
    query: "deterministic tests",
    maxResults: 3,
    chunks: [
      {
        chunkId: "a",
        sourcePath: "MEMORY.md",
        title: "Memory",
        sourceKind: "memory",
        startLine: 1,
        endLine: 2,
        content: "This mentions tests in passing.",
      },
      {
        chunkId: "b",
        sourcePath: "IDENTITY.md",
        title: "Work Style",
        sourceKind: "identity",
        startLine: 3,
        endLine: 4,
        content: "Likes deterministic tests and small review loops.",
      },
    ],
  });

  assert.equal(results[0]?.sourcePath, "IDENTITY.md");
  assert.match(formatNativeKnowledgeSection({ results, maxChars: 1000 }) ?? "", /Curated Workspace Knowledge/);
});
