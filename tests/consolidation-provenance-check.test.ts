/**
 * Tests for the consolidation-provenance integrity check (issue #561 PR 4).
 *
 * Covers:
 *   - Memories with valid `derived_from` + `derived_via` produce zero
 *     issues.
 *   - Memories whose `derived_from` points at a missing snapshot surface
 *     a `derived_from_missing_snapshot` warning.
 *   - Malformed entries (e.g. wrong shape, non-numeric version) surface a
 *     `derived_from_malformed_entry` warning.
 *   - Unknown `derived_via` values surface a
 *     `derived_via_unknown_operator` warning.
 *   - The operator-doctor summary wrapper maps clean reports to "ok" and
 *     issue-bearing reports to "warn".
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";
import {
  runConsolidationProvenanceCheck,
  type ConsolidationProvenanceReport,
} from "../src/consolidation-provenance-check.ts";
import { summarizeConsolidationProvenance } from "../src/operator-toolkit.ts";

const versioning = { enabled: true, maxVersionsPerPage: 10, sidecarDir: ".versions" } as const;

async function seedStorage(dir: string): Promise<StorageManager> {
  const storage = new StorageManager(dir);
  storage.setVersioningConfig({ ...versioning });
  await storage.ensureDirectories();
  return storage;
}

test("runConsolidationProvenanceCheck returns an empty report on a clean store", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-clean-"));
  try {
    const storage = await seedStorage(dir);
    // Write a canonical memory whose derived_from entries match snapshots
    // captured before writing — mirrors PR 2's happy path.
    const srcAId = await storage.writeMemory("fact", "alpha", { source: "extraction" });
    const srcBId = await storage.writeMemory("fact", "bravo", { source: "extraction" });
    const all = await storage.readAllMemories();
    const srcA = all.find((m) => m.frontmatter.id === srcAId);
    const srcB = all.find((m) => m.frontmatter.id === srcBId);
    assert.ok(srcA && srcB);

    const entryA = await storage.snapshotForProvenance(srcA.path);
    const entryB = await storage.snapshotForProvenance(srcB.path);
    assert.ok(entryA && entryB);

    await storage.writeMemory("fact", "canonical", {
      source: "semantic-consolidation",
      derivedFrom: [entryA, entryB],
      derivedVia: "merge",
    });

    const report: ConsolidationProvenanceReport = await runConsolidationProvenanceCheck({
      storage,
      memoryDir: dir,
    });

    assert.equal(report.issues.length, 0, `clean store should produce zero issues; got ${JSON.stringify(report.issues)}`);
    assert.equal(report.withProvenance, 1);
    assert.ok(report.scanned >= 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationProvenanceCheck flags derived_from entries pointing at missing snapshots", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-missing-"));
  try {
    const storage = await seedStorage(dir);

    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const id = "fact-bad-ref";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      'tags: ["consolidation"]',
      'derived_from: ["facts/ghost.md:99"]',
      "derived_via: merge",
      "---",
      "",
      "canonical body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });
    assert.equal(report.issues.length, 1);
    const issue = report.issues[0];
    assert.equal(issue.kind, "derived_from_missing_snapshot");
    assert.equal(issue.memoryId, id);
    assert.ok(issue.detail.includes("facts/ghost.md:99"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationProvenanceCheck flags unknown derived_via operators", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-unknown-op-"));
  try {
    const storage = await seedStorage(dir);

    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const id = "fact-unknown-op";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      "derived_via: annihilate",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });
    // The normalized read-path parser drops unknown operators to
    // undefined, but the doctor re-extracts the raw YAML value so
    // on-disk corruption is still surfaced (PR #634 review feedback).
    assert.equal(report.issues.length, 1);
    const issue = report.issues[0];
    assert.equal(issue.kind, "derived_via_unknown_operator");
    assert.ok(issue.detail.includes("annihilate"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("summarizeConsolidationProvenance returns ok when no issues are found", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-summary-ok-"));
  try {
    const storage = await seedStorage(dir);
    const check = await summarizeConsolidationProvenance(storage, { memoryDir: dir });
    assert.equal(check.key, "consolidation_provenance");
    assert.equal(check.status, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("summarizeConsolidationProvenance returns warn when integrity issues exist", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-summary-warn-"));
  try {
    const storage = await seedStorage(dir);

    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const id = "fact-bad";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      'derived_from: ["facts/ghost.md:99"]',
      "derived_via: merge",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const check = await summarizeConsolidationProvenance(storage, { memoryDir: dir });
    assert.equal(check.status, "warn");
    assert.ok(check.remediation);
    const detail = check.details as ConsolidationProvenanceReport;
    assert.ok(detail.issues.length >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationProvenanceCheck flags raw derived_from that the parser dropped (scalar form)", async () => {
  // Regression for PR #634 round-2 review feedback (codex P2): the
  // read-path parser drops non-list `derived_from` values to
  // `undefined`, so a scalar like `derived_from: facts/a.md:7` (no
  // list brackets) was previously silently ignored by the scan.  The
  // doctor re-extracts the raw YAML line and flags the drop as a
  // `derived_from_malformed_entry` issue.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-scalar-"));
  try {
    const storage = await seedStorage(dir);

    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const id = "fact-scalar-from";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      "derived_from: facts/a.md:7", // scalar — not a list
      "derived_via: merge",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });
    // One malformed_entry issue — the scalar form is preserved in
    // the detail message so operators can grep the offending line.
    const malformed = report.issues.filter(
      (i) => i.kind === "derived_from_malformed_entry",
    );
    assert.equal(malformed.length, 1);
    assert.ok(malformed[0].detail.includes("facts/a.md:7"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("summarizeConsolidationProvenance honors versioningSidecarDir from config", async () => {
  // Regression for PR #634 review feedback (codex P2 / cursor Medium):
  // the summarizer must thread the configured `versioningSidecarDir`
  // into the scan.  Deployments that override the default `.versions`
  // directory would otherwise see false-missing warnings for every
  // `derived_from` entry because the scan looks in the wrong directory.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-sidecar-"));
  try {
    const storage = new StorageManager(dir);
    // Use a non-default sidecar directory to prove threading works.
    storage.setVersioningConfig({
      enabled: true,
      maxVersionsPerPage: 10,
      sidecarDir: ".custom-versions",
    });
    await storage.ensureDirectories();

    const srcId = await storage.writeMemory("fact", "source body", { source: "extraction" });
    const all = await storage.readAllMemories();
    const src = all.find((m) => m.frontmatter.id === srcId)!;
    const entry = await storage.snapshotForProvenance(src.path);
    assert.ok(entry);

    await storage.writeMemory("fact", "canonical", {
      source: "semantic-consolidation",
      derivedFrom: [entry],
      derivedVia: "merge",
    });

    const check = await summarizeConsolidationProvenance(storage, {
      memoryDir: dir,
      versioningSidecarDir: ".custom-versions",
    });
    assert.equal(check.status, "ok", `got ${check.status}: ${check.summary}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationProvenanceCheck flags blank derived_from key (truncated frontmatter)", async () => {
  // Regression for PR #634 round-3 review (codex P2): a truncated
  // frontmatter that ends with `derived_from:` (key present, no
  // value) should surface as a malformed entry.  Previously the
  // `rawDerivedFrom.length > 0` guard dropped this case.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-blank-from-"));
  try {
    const storage = await seedStorage(dir);
    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });
    const id = "fact-blank-from";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      "derived_from:", // blank value
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });
    const malformed = report.issues.filter(
      (i) => i.kind === "derived_from_malformed_entry",
    );
    assert.equal(malformed.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationProvenanceCheck flags blank derived_via key (truncated frontmatter)", async () => {
  // Regression for PR #634 round-3 review (codex P2): a truncated
  // frontmatter that ends with `derived_via:` (key present, no
  // value) should surface as an unknown-operator issue.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-blank-via-"));
  try {
    const storage = await seedStorage(dir);
    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });
    const id = "fact-blank-via";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      "derived_via:", // blank
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });
    const unknown = report.issues.filter(
      (i) => i.kind === "derived_via_unknown_operator",
    );
    assert.equal(unknown.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
