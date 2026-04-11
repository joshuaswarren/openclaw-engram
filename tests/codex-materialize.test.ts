import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  materializeForNamespace,
  ensureSentinel,
  describeMemoriesDir,
  SENTINEL_FILE,
  TMP_DIR,
  MATERIALIZE_VERSION,
} from "../src/connectors/codex-materialize.js";
import type { MemoryFile } from "../src/types.js";

// Synthetic memory factory — NEVER use real user data in tests.
function makeMemory(overrides: {
  id?: string;
  category?: string;
  content?: string;
  created?: string;
  updated?: string;
  tags?: string[];
  status?: string;
  confidence?: number;
}): MemoryFile {
  const id = overrides.id ?? `fact-${Math.random().toString(36).slice(2, 8)}`;
  return {
    path: `/tmp/remnic-test/facts/${id}.md`,
    frontmatter: {
      id,
      category: (overrides.category ?? "fact") as any,
      created: overrides.created ?? "2026-04-01T00:00:00Z",
      updated: overrides.updated ?? "2026-04-01T00:00:00Z",
      source: "synthetic-test",
      confidence: overrides.confidence ?? 0.8,
      confidenceTier: "implied",
      tags: overrides.tags ?? [],
      ...(overrides.status ? { status: overrides.status as any } : {}),
    } as any,
    content: overrides.content ?? "synthetic test memory content",
  };
}

function makeTempCodexHome(): { root: string; memoriesDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-materialize-test-"));
  const memoriesDir = path.join(root, "memories");
  mkdirSync(memoriesDir, { recursive: true });
  return { root, memoriesDir };
}

test("writes memory_summary.md, MEMORY.md, raw_memories.md when sentinel present", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "synthetic-ns", new Date("2026-04-01T00:00:00Z"));

    const memories = [
      makeMemory({ id: "syn-1", category: "fact", content: "The synthetic fixture uses placeholder data only." }),
      makeMemory({ id: "syn-2", category: "preference", content: "Prefer structured synthetic fixtures over real data." }),
      makeMemory({ id: "syn-3", category: "correction", content: "Avoid coupling tests to real user history." }),
    ];

    const result = materializeForNamespace("synthetic-ns", {
      memories,
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
    });

    assert.equal(result.skippedNoSentinel, false);
    assert.equal(result.skippedIdempotent, false);
    assert.equal(result.wrote, true);
    assert.ok(result.filesWritten.includes("memory_summary.md"));
    assert.ok(result.filesWritten.includes("MEMORY.md"));
    assert.ok(result.filesWritten.includes("raw_memories.md"));

    assert.ok(existsSync(path.join(memoriesDir, "memory_summary.md")));
    assert.ok(existsSync(path.join(memoriesDir, "MEMORY.md")));
    assert.ok(existsSync(path.join(memoriesDir, "raw_memories.md")));
    assert.ok(existsSync(path.join(memoriesDir, SENTINEL_FILE)));

    const sentinelRaw = readFileSync(path.join(memoriesDir, SENTINEL_FILE), "utf-8");
    const sentinel = JSON.parse(sentinelRaw);
    assert.equal(sentinel.version, MATERIALIZE_VERSION);
    assert.equal(sentinel.namespace, "synthetic-ns");
    assert.equal(typeof sentinel.content_hash, "string");
    assert.ok(sentinel.content_hash.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips materialization when sentinel file is missing", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    // No sentinel written → materializer should skip.
    const result = materializeForNamespace("synthetic-ns", {
      memories: [makeMemory({ content: "synthetic fallback" })],
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
    });

    assert.equal(result.skippedNoSentinel, true);
    assert.equal(result.wrote, false);
    assert.equal(result.filesWritten.length, 0);
    assert.equal(existsSync(path.join(memoriesDir, "MEMORY.md")), false);
    assert.equal(existsSync(path.join(memoriesDir, "memory_summary.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("idempotent no-op when nothing changed since last run", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "idem-ns");
    const memories = [
      makeMemory({ id: "idem-1", content: "synthetic content A" }),
      makeMemory({ id: "idem-2", content: "synthetic content B" }),
    ];

    const first = materializeForNamespace("idem-ns", {
      memories,
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
    });
    assert.equal(first.wrote, true);

    const second = materializeForNamespace("idem-ns", {
      memories,
      codexHome: root,
      now: new Date("2026-04-03T00:00:00Z"),
    });
    assert.equal(second.skippedIdempotent, true);
    assert.equal(second.wrote, false);
    assert.equal(second.filesWritten.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renders rollout_summaries/*.md and respects retention days", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "rollout-ns");
    const now = new Date("2026-04-02T00:00:00Z");

    const result = materializeForNamespace("rollout-ns", {
      memories: [makeMemory({ content: "anchor" })],
      codexHome: root,
      rolloutRetentionDays: 30,
      rolloutSummaries: [
        {
          slug: "recent-session",
          cwd: "/fake/project",
          updatedAt: "2026-04-01T00:00:00Z",
          threadId: "synthetic-thread",
          body: "Synthetic recap of a recent session.",
          keywords: ["synthetic"],
        },
        {
          // Older than retention window — should be pruned.
          slug: "old-session",
          updatedAt: "2025-01-01T00:00:00Z",
          body: "Synthetic old recap.",
        },
      ],
      now,
    });

    assert.equal(result.wrote, true);
    assert.ok(result.filesWritten.some((f) => f.endsWith("recent-session.md")));
    assert.ok(!result.filesWritten.some((f) => f.endsWith("old-session.md")));
    assert.ok(existsSync(path.join(memoriesDir, "rollout_summaries", "recent-session.md")));
    assert.equal(existsSync(path.join(memoriesDir, "rollout_summaries", "old-session.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leaves no .remnic-tmp/ scratch directory after a successful run", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "cleanup-ns");
    materializeForNamespace("cleanup-ns", {
      memories: [makeMemory({ content: "synthetic cleanup" })],
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
    });
    assert.equal(existsSync(path.join(memoriesDir, TMP_DIR)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("describeMemoriesDir reports owned files and sentinel state", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    // Before sentinel → describe returns dir but no sentinel.
    let info = describeMemoriesDir(memoriesDir);
    assert.ok(info);
    assert.equal(info?.hasSentinel, false);

    ensureSentinel(memoriesDir, "describe-ns");
    info = describeMemoriesDir(memoriesDir);
    assert.ok(info);
    assert.equal(info?.hasSentinel, true);
    assert.equal(info?.sentinel?.namespace, "describe-ns");

    materializeForNamespace("describe-ns", {
      memories: [makeMemory({ content: "synthetic describe" })],
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
    });
    info = describeMemoriesDir(memoriesDir);
    assert.ok(info?.files.includes("memory_summary.md"));
    assert.ok(info?.files.includes("MEMORY.md"));
    assert.ok(info?.files.includes("raw_memories.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deduplicates rollouts whose slugs sanitize to the same filename", () => {
  // Regression: two different input slugs can sanitize to the same .md name
  // (e.g. "Session 1" and "session!!!1" both → "session-1.md"). The old
  // code would write the same tmp file twice and then crash with ENOENT
  // during rename. See Cursor Bugbot report on PR #392.
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "dedupe-ns");
    const result = materializeForNamespace("dedupe-ns", {
      memories: [makeMemory({ content: "synthetic dedupe anchor" })],
      codexHome: root,
      rolloutSummaries: [
        {
          slug: "Session 1",
          updatedAt: "2026-04-01T00:00:00Z",
          body: "first synthetic recap.",
        },
        {
          slug: "session!!!1",
          updatedAt: "2026-04-01T12:00:00Z",
          body: "second synthetic recap (collides on sanitized slug).",
        },
      ],
      now: new Date("2026-04-02T00:00:00Z"),
    });

    assert.equal(result.wrote, true);
    // Exactly one rollout file should be written for the collided name.
    const rolloutFiles = result.filesWritten.filter((f) => f.includes("rollout_summaries"));
    assert.equal(rolloutFiles.length, 1);
    assert.ok(rolloutFiles[0].endsWith("session-1.md"));
    assert.ok(existsSync(path.join(memoriesDir, "rollout_summaries", "session-1.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not overwrite a corrupted sentinel silently (treats as missing)", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    // Write a junk sentinel → readSentinel() returns null → skip with warning.
    writeFileSync(path.join(memoriesDir, SENTINEL_FILE), "not-json");
    const result = materializeForNamespace("corrupt-ns", {
      memories: [makeMemory({ content: "synthetic corrupt" })],
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
    });
    assert.equal(result.skippedNoSentinel, true);
    assert.equal(result.wrote, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
