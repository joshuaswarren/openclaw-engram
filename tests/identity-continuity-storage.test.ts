import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";

test("identity continuity storage writes/reads anchor and improvement loop artifacts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-identity-anchor-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    assert.equal(await storage.readIdentityAnchor(), null);
    assert.equal(await storage.readIdentityImprovementLoops(), null);

    await storage.writeIdentityAnchor("# Identity Anchor\n\n- durable trait\n");
    await storage.writeIdentityImprovementLoops("# Improvement Loops\n\n- weekly audit\n");

    assert.match((await storage.readIdentityAnchor()) ?? "", /Identity Anchor/);
    assert.match((await storage.readIdentityImprovementLoops()) ?? "", /Improvement Loops/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("identity continuity incidents are append-only with explicit close transition", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-identity-incident-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const opened = await storage.appendContinuityIncident({
      triggerWindow: "2026-02-24T00:00:00Z..2026-02-24T02:00:00Z",
      symptom: "identity context missing from recovery prompt",
      suspectedCause: "budget overrun truncation",
    });

    assert.equal(opened.state, "open");
    assert.ok(opened.filePath && opened.filePath.endsWith(".md"));

    const listed = await storage.readContinuityIncidents(10);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, opened.id);
    assert.equal(listed[0]?.state, "open");

    const closed = await storage.closeContinuityIncident(opened.id, {
      fixApplied: "raised identityMaxInjectChars and trimmed low-priority sections",
      verificationResult: "identity section appears in recovery-mode recall output",
      preventiveRule: "require budget telemetry check before release",
    });

    assert.ok(closed);
    assert.equal(closed?.state, "closed");
    assert.ok(closed?.closedAt);
    assert.match(closed?.fixApplied ?? "", /raised identityMaxInjectChars/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("identity continuity incident reader ignores malformed files (fail-open)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-identity-malformed-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    await storage.appendContinuityIncident({
      symptom: "degraded identity continuity",
    });

    const malformedPath = path.join(dir, "identity", "incidents", "2026-02-24-bad.md");
    await appendFile(malformedPath, "not-frontmatter\n", "utf-8");

    const incidents = await storage.readContinuityIncidents(20);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.state, "open");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("identity continuity audit artifacts round-trip", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-identity-audits-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    await storage.writeIdentityAudit("weekly", "2026-W09", "# Weekly Audit\n");
    await storage.writeIdentityAudit("monthly", "2026-02", "# Monthly Audit\n");

    assert.equal(await storage.readIdentityAudit("weekly", "2026-W09"), "# Weekly Audit\n");
    assert.equal(await storage.readIdentityAudit("monthly", "2026-02"), "# Monthly Audit\n");
    assert.equal(await storage.readIdentityAudit("weekly", "2026-W10"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
