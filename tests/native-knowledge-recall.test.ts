import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

async function buildNativeKnowledgeRecallHarness(options: {
  enabled: boolean;
  recallSectionEnabled?: boolean;
  vaultDir?: string;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-native-knowledge-recall-"));
  const memoryDir = path.join(root, "memory");
  const workspaceDir = path.join(root, "workspace");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, "IDENTITY.md"),
    "# Identity\n\nPrefers concise responses.\n\n## Work Style\n\nLikes deterministic tests and short PR loops.\n",
    "utf-8",
  );
  await writeFile(
    path.join(workspaceDir, "MEMORY.md"),
    "# Memory\n\nThe API rate limit issue came from stale credentials during rollout.\n",
    "utf-8",
  );

  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    sharedContextEnabled: false,
    conversationIndexEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    nativeKnowledge: {
      enabled: options.enabled,
      includeFiles: ["IDENTITY.md", "MEMORY.md"],
      maxChunkChars: 400,
      maxResults: 3,
      maxChars: 1200,
      stateDir: "state/native-knowledge",
      obsidianVaults: options.vaultDir
        ? [
          {
            id: "vault",
            rootDir: options.vaultDir,
            includeGlobs: ["**/*.md"],
            excludeGlobs: [".obsidian/**"],
            folderRules: [],
            dailyNotePatterns: ["YYYY-MM-DD"],
            materializeBacklinks: false,
          },
        ]
        : [],
    },
    recallPipeline: [
      {
        id: "native-knowledge",
        enabled: options.recallSectionEnabled ?? true,
        maxResults: 3,
        maxChars: 1200,
      },
    ],
  });

  return new Orchestrator(cfg);
}

test("recall injects curated workspace knowledge when native knowledge is enabled", async () => {
  const orchestrator = await buildNativeKnowledgeRecallHarness({ enabled: true });

  const context = await (orchestrator as any).recallInternal(
    "What do you know about deterministic tests and our API rate limit issue?",
    "agent:main",
  );

  assert.match(context, /## Curated Workspace Knowledge/);
  assert.match(context, /Likes deterministic tests and short PR loops/i);
  assert.match(context, /API rate limit issue came from stale credentials/i);
});

test("recall omits native knowledge section when the feature flag is disabled", async () => {
  const orchestrator = await buildNativeKnowledgeRecallHarness({ enabled: false });

  const context = await (orchestrator as any).recallInternal(
    "What do you know about deterministic tests and our API rate limit issue?",
    "agent:main",
  );

  assert.equal(context.includes("## Curated Workspace Knowledge"), false);
});

test("recall omits native knowledge section when the pipeline section is disabled", async () => {
  const orchestrator = await buildNativeKnowledgeRecallHarness({
    enabled: true,
    recallSectionEnabled: false,
  });

  const context = await (orchestrator as any).recallInternal(
    "What do you know about deterministic tests and our API rate limit issue?",
    "agent:main",
  );

  assert.equal(context.includes("## Curated Workspace Knowledge"), false);
});

test("recall blends obsidian native knowledge results into the shared section", async () => {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), "engram-native-knowledge-obsidian-recall-"));
  await mkdir(vaultDir, { recursive: true });
  await writeFile(
    path.join(vaultDir, "2026-03-09.md"),
    [
      "---",
      "aliases:",
      "  - Deployment Retrospective",
      "---",
      "# Daily Note",
      "",
      "Deployment retrospective captured the release checklist for the March 9 ship.",
      "",
    ].join("\n"),
    "utf-8",
  );

  const orchestrator = await buildNativeKnowledgeRecallHarness({ enabled: true, vaultDir });
  const context = await (orchestrator as any).recallInternal(
    "What did the Deployment Retrospective say about the March 9 ship?",
    "agent:main",
  );

  assert.match(context, /## Curated Workspace Knowledge/);
  assert.match(context, /vault\/2026-03-09\.md:7-7/);
  assert.match(context, /date=2026-03-09/);
  assert.match(context, /Deployment retrospective captured the release checklist/i);
});
