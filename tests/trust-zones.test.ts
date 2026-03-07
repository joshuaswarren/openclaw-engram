import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  getTrustZoneStoreStatus,
  recordTrustZoneRecord,
  resolveTrustZoneStoreDir,
  validateTrustZoneRecord,
} from "../src/trust-zones.js";
import { runTrustZoneStatusCliCommand } from "../src/cli.js";

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
