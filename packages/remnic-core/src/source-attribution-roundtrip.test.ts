import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { StorageManager } from "./storage.js";
import {
  attachCitation,
  hasCitation,
  parseCitation,
  stripCitation,
} from "./source-attribution.js";

/**
 * Issue #369 — Inline source attribution round-trip.
 *
 * These tests verify that once a citation marker is embedded in the fact
 * body, it survives writing to disk and reading back via StorageManager —
 * which is the same path recall takes when it injects memories into a
 * prompt. The orchestrator-level `persistExtraction` is covered indirectly
 * through this round-trip: all three write sites (`writeMemory`,
 * `writeChunk`, `writeArtifact`) go through the same on-disk markdown file
 * and frontmatter parser.
 */

test("round-trip: citation-enriched fact content survives writeMemory → readAllMemories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-source-attr-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const factBody = "The foo service uses Redis for rate limiting.";
    const enriched = attachCitation(factBody, {
      agent: "planner",
      session: "agent:planner:main",
      ts: "2026-04-10T14:25:07Z",
    });

    assert.ok(hasCitation(enriched), "attachCitation must emit a marker");

    const id = await storage.writeMemory("fact", enriched, {
      confidence: 0.8,
      tags: ["test"],
    });
    assert.ok(id.length > 0);

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written, "writeMemory output must be readable");
    assert.ok(
      hasCitation(written!.content),
      "citation marker must survive the on-disk round-trip",
    );

    const parsed = parseCitation(written!.content);
    assert.ok(parsed);
    assert.equal(parsed!.agent, "planner");
    assert.equal(parsed!.session, "main");
    assert.equal(parsed!.ts, "2026-04-10T14:25:07Z");

    // stripCitation must recover the original fact body verbatim so
    // downstream consumers that want raw text have a clean escape hatch.
    assert.equal(stripCitation(written!.content), factBody);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy fact memories without a citation marker still read cleanly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-source-attr-legacy-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const legacyBody = "Legacy fact without inline provenance.";
    const id = await storage.writeMemory("fact", legacyBody, {
      confidence: 0.8,
      tags: ["legacy"],
    });

    const memories = await storage.readAllMemories();
    const written = memories.find((m) => m.frontmatter.id === id);
    assert.ok(written);
    assert.equal(hasCitation(written!.content), false);
    // Plain content is unchanged by strip, so recall sees the exact body.
    assert.equal(stripCitation(written!.content), legacyBody);
    assert.equal(parseCitation(written!.content), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
