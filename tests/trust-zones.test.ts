import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  getTrustZoneStoreStatus,
  planTrustZonePromotion,
  promoteTrustZoneRecord,
  recordTrustZoneRecord,
  resolveTrustZoneStoreDir,
  validateTrustZoneRecord,
} from "../src/trust-zones.js";
import { runTrustZonePromoteCliCommand, runTrustZoneStatusCliCommand } from "../src/cli.js";

test("trust-zones config path resolves under memoryDir by default", () => {
  assert.equal(
    resolveTrustZoneStoreDir("/tmp/engram-memory"),
    path.join("/tmp/engram-memory", "state", "trust-zones"),
  );
  assert.equal(resolveTrustZoneStoreDir("/tmp/engram-memory", "  /tmp/custom-trust-zones  "), "/tmp/custom-trust-zones");
});

test("validateTrustZoneRecord accepts the normalized trust-zone contract", () => {
  const record = validateTrustZoneRecord({
    schemaVersion: 1,
    recordId: "trust-zone-1",
    zone: "quarantine",
    recordedAt: "2026-03-07T18:00:00.000Z",
    kind: "artifact",
    summary: "Captured raw web content before promotion into durable memory.",
    provenance: {
      sourceClass: "web_content",
      observedAt: "2026-03-07T17:59:00.000Z",
      sessionKey: "agent:main",
      sourceId: "https://example.com/runbook",
      evidenceHash: "sha256:abc123",
    },
    promotedFromZone: "working",
    entityRefs: ["project:engram"],
    tags: ["trust-zone", "quarantine"],
    metadata: {
      actor: "engram",
    },
  });

  assert.equal(record.zone, "quarantine");
  assert.equal(record.provenance.sourceClass, "web_content");
  assert.equal(record.promotedFromZone, "working");
  assert.deepEqual(record.tags, ["trust-zone", "quarantine"]);
});

test("recordTrustZoneRecord persists records into zoned dated storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-record-"));
  const filePath = await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-2",
      zone: "trusted",
      recordedAt: "2026-03-07T18:01:00.000Z",
      kind: "memory",
      summary: "Promoted corroborated preference memory into trusted storage.",
      provenance: {
        sourceClass: "system_memory",
        observedAt: "2026-03-07T18:00:00.000Z",
        sessionKey: "agent:main",
      },
      tags: ["promotion"],
    },
  });

  assert.equal(
    filePath,
    path.join(memoryDir, "state", "trust-zones", "zones", "trusted", "2026-03-07", "tz-2.json"),
  );
});

test("recordTrustZoneRecord rejects unsafe ids and malformed timestamps", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-reject-"));

  await assert.rejects(
    () =>
      recordTrustZoneRecord({
        memoryDir,
        record: {
          schemaVersion: 1,
          recordId: "../escape",
          zone: "working",
          recordedAt: "2026-03-07T18:01:00.000Z",
          kind: "state",
          summary: "invalid id",
          provenance: {
            sourceClass: "tool_output",
            observedAt: "2026-03-07T18:00:00.000Z",
          },
        },
      }),
    /recordId/i,
  );

  await assert.rejects(
    () =>
      recordTrustZoneRecord({
        memoryDir,
        record: {
          schemaVersion: 1,
          recordId: "tz-3",
          zone: "working",
          recordedAt: "2026-03-07",
          kind: "state",
          summary: "invalid date",
          provenance: {
            sourceClass: "tool_output",
            observedAt: "2026-03-07T18:00:00.000Z",
          },
        },
      }),
    /recordedAt/i,
  );
});

test("validateTrustZoneRecord reports the observedAt field name for invalid provenance timestamps", () => {
  assert.throws(
    () =>
      validateTrustZoneRecord({
        schemaVersion: 1,
        recordId: "tz-bad-observed-at",
        zone: "working",
        recordedAt: "2026-03-07T18:01:00.000Z",
        kind: "state",
        summary: "invalid observedAt",
        provenance: {
          sourceClass: "tool_output",
          observedAt: "not-an-iso-timestamp",
        },
      }),
    /observedAt/i,
  );
});

test("trust-zone status reports valid and invalid records by zone", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-status-"));
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-4",
      zone: "quarantine",
      recordedAt: "2026-03-07T18:02:00.000Z",
      kind: "external",
      summary: "Raw search result captured for later corroboration.",
      provenance: {
        sourceClass: "web_content",
        observedAt: "2026-03-07T18:01:00.000Z",
        sessionKey: "agent:main",
      },
    },
  });
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-5",
      zone: "trusted",
      recordedAt: "2026-03-07T18:03:00.000Z",
      kind: "trajectory",
      summary: "Corroborated causal trajectory promoted into trusted storage.",
      provenance: {
        sourceClass: "system_memory",
        observedAt: "2026-03-07T18:02:30.000Z",
        sessionKey: "agent:main",
      },
      promotedFromZone: "working",
    },
  });

  const invalidDir = path.join(memoryDir, "state", "trust-zones", "zones", "working", "2026-03-07");
  await mkdir(invalidDir, { recursive: true });
  await writeFile(path.join(invalidDir, "invalid.json"), "{\"schemaVersion\":2}", "utf8");

  const status = await getTrustZoneStoreStatus({
    memoryDir,
    enabled: true,
    promotionEnabled: false,
  });

  assert.equal(status.records.total, 3);
  assert.equal(status.records.valid, 2);
  assert.equal(status.records.invalid, 1);
  assert.equal(status.records.byZone.quarantine, 1);
  assert.equal(status.records.byZone.trusted, 1);
  assert.equal(status.records.latestRecordId, "tz-5");
  assert.equal(status.latestRecord?.zone, "trusted");
  assert.equal(status.invalidRecords[0]?.path.endsWith("invalid.json"), true);
});

test("trust-zone-status CLI command returns the store summary", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-cli-"));
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-cli-1",
      zone: "working",
      recordedAt: "2026-03-07T18:05:00.000Z",
      kind: "state",
      summary: "Ephemeral working-state snapshot awaiting promotion decision.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: "2026-03-07T18:04:00.000Z",
        sessionKey: "agent:main",
      },
    },
  });

  const summary = await runTrustZoneStatusCliCommand({
    memoryDir,
    trustZonesEnabled: true,
    quarantinePromotionEnabled: false,
  });
  assert.equal(summary.records.valid, 1);
  assert.equal(summary.latestRecord.recordId, "tz-cli-1");
});

test("planTrustZonePromotion blocks direct quarantine to trusted promotion", () => {
  const plan = planTrustZonePromotion({
    record: validateTrustZoneRecord({
      schemaVersion: 1,
      recordId: "tz-plan-1",
      zone: "quarantine",
      recordedAt: "2026-03-07T18:06:00.000Z",
      kind: "external",
      summary: "Raw web result awaiting corroboration.",
      provenance: {
        sourceClass: "web_content",
        observedAt: "2026-03-07T18:05:00.000Z",
      },
    }),
    targetZone: "trusted",
  });

  assert.equal(plan.allowed, false);
  assert.match(plan.reasons.join(" "), /quarantine/i);
  assert.match(plan.reasons.join(" "), /trusted/i);
});

test("planTrustZonePromotion requires provenance anchors before promoting working records to trusted", () => {
  const denied = planTrustZonePromotion({
    record: validateTrustZoneRecord({
      schemaVersion: 1,
      recordId: "tz-plan-2",
      zone: "working",
      recordedAt: "2026-03-07T18:07:00.000Z",
      kind: "state",
      summary: "Intermediate state derived from tool output.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: "2026-03-07T18:06:30.000Z",
      },
    }),
    targetZone: "trusted",
  });
  assert.equal(denied.allowed, false);
  assert.match(denied.reasons.join(" "), /sourceId/i);
  assert.match(denied.reasons.join(" "), /evidenceHash/i);

  const allowed = planTrustZonePromotion({
    record: validateTrustZoneRecord({
      schemaVersion: 1,
      recordId: "tz-plan-3",
      zone: "working",
      recordedAt: "2026-03-07T18:08:00.000Z",
      kind: "state",
      summary: "Intermediate state with anchored provenance.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: "2026-03-07T18:07:30.000Z",
        sourceId: "tool:build",
        evidenceHash: "sha256:trust-anchor",
      },
    }),
    targetZone: "trusted",
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reasons.length, 0);
});

test("promoteTrustZoneRecord writes a lineage-aware promoted record", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-promote-"));
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-promote-source",
      zone: "working",
      recordedAt: "2026-03-07T18:09:00.000Z",
      kind: "artifact",
      summary: "Candidate artifact promoted after manual review.",
      provenance: {
        sourceClass: "manual",
        observedAt: "2026-03-07T18:08:30.000Z",
        sourceId: "review:ops",
        evidenceHash: "sha256:manual-review",
      },
      tags: ["reviewed"],
    },
  });

  const result = await promoteTrustZoneRecord({
    memoryDir,
    enabled: true,
    promotionEnabled: true,
    sourceRecordId: "tz-promote-source",
    targetZone: "trusted",
    recordedAt: "2026-03-07T18:10:00.000Z",
    promotionReason: "Manual review approved the artifact for trusted recall.",
  });

  assert.equal(result.record.zone, "trusted");
  assert.equal(result.record.promotedFromZone, "working");
  assert.equal(result.record.metadata?.sourceRecordId, "tz-promote-source");
  assert.equal(result.record.metadata?.promotionReason?.includes("Manual review approved"), true);
  assert.equal(result.filePath.endsWith(".json"), true);

  const status = await getTrustZoneStoreStatus({
    memoryDir,
    enabled: true,
    promotionEnabled: true,
  });
  assert.equal(status.records.valid, 2);
  assert.equal(status.records.byZone.working, 1);
  assert.equal(status.records.byZone.trusted, 1);
  assert.equal(status.latestRecord?.recordId, result.record.recordId);
});

test("trust-zone-promote CLI dry-run returns the promotion plan without writing", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-trust-zone-cli-promote-"));
  await recordTrustZoneRecord({
    memoryDir,
    record: {
      schemaVersion: 1,
      recordId: "tz-cli-promote-source",
      zone: "quarantine",
      recordedAt: "2026-03-07T18:11:00.000Z",
      kind: "external",
      summary: "Raw fetch result with anchored provenance.",
      provenance: {
        sourceClass: "web_content",
        observedAt: "2026-03-07T18:10:30.000Z",
        sourceId: "https://example.com/source",
        evidenceHash: "sha256:web-proof",
      },
    },
  });

  const plan = await runTrustZonePromoteCliCommand({
    memoryDir,
    trustZonesEnabled: true,
    quarantinePromotionEnabled: true,
    sourceRecordId: "tz-cli-promote-source",
    targetZone: "working",
    promotionReason: "Promote into working memory for corroboration.",
    dryRun: true,
  });

  assert.equal(plan.dryRun, true);
  assert.equal(plan.plan.allowed, true);
  assert.equal(plan.wroteRecord, false);

  const status = await getTrustZoneStoreStatus({
    memoryDir,
    enabled: true,
    promotionEnabled: true,
  });
  assert.equal(status.records.valid, 1);
  assert.equal(status.records.byZone.quarantine, 1);
});
