import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHeartbeatSurface } from "./heartbeat.js";

test("heartbeat surface reads section-based entries with schedule and tags", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-surface-"));
  const heartbeatPath = path.join(root, "HEARTBEAT.md");
  await writeFile(
    heartbeatPath,
    [
      "# Heartbeat Tasks",
      "",
      "## check-test-suite",
      "",
      "Every hour, run the test suite and flag any new failures.",
      "",
      "Schedule: hourly",
      "Tags: #ci #tests",
      "",
      "---",
      "",
      "## sync-secrets",
      "",
      "Every day at 09:00, refresh dev secrets from the vault.",
      "",
      "Schedule: daily 09:00",
      "Tags: #secrets #ops",
      "",
    ].join("\n"),
    "utf8",
  );

  const surface = createHeartbeatSurface();
  const entries = await surface.read(heartbeatPath);

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.slug, "check-test-suite");
  assert.equal(entries[0]?.schedule, "hourly");
  assert.deepEqual(entries[0]?.tags, ["ci", "tests"]);
  assert.equal(entries[1]?.slug, "sync-secrets");
  assert.equal(entries[1]?.schedule, "daily 09:00");
  assert.match(entries[1]?.body ?? "", /refresh dev secrets/);
});

test("heartbeat surface reads tasks blocks from upstream-style HEARTBEAT.md", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-tasks-"));
  const heartbeatPath = path.join(root, "HEARTBEAT.md");
  await writeFile(
    heartbeatPath,
    [
      "# Keep this file empty to skip heartbeat API calls.",
      "",
      "tasks:",
      "  - name: email-check",
      "    interval: 30m",
      "    prompt: \"Check for urgent unread emails\"",
      "  - name: test-suite",
      "    interval: 1h",
      "    prompt: \"Run the test suite and report new failures\"",
      "",
    ].join("\n"),
    "utf8",
  );

  const surface = createHeartbeatSurface();
  const entries = await surface.read(heartbeatPath);

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.slug, "email-check");
  assert.equal(entries[0]?.schedule, "30m");
  assert.equal(entries[0]?.title, "email-check");
  assert.equal(entries[1]?.slug, "test-suite");
  assert.match(entries[1]?.body ?? "", /new failures/);
});

test("heartbeat surface tracks source offsets for repeated task lines correctly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-offsets-"));
  const heartbeatPath = path.join(root, "HEARTBEAT.md");
  const content = [
    "# Notes",
    "",
    "Example repeated line:",
    "  - name: email-check",
    "",
    "tasks:",
    "  - name: email-check",
    "    interval: 30m",
    "    prompt: \"Check for urgent unread emails\"",
    "",
  ].join("\n");
  await writeFile(heartbeatPath, content, "utf8");

  const surface = createHeartbeatSurface();
  const entries = await surface.read(heartbeatPath);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.slug, "email-check");
  assert.equal(entries[0]?.sourceOffset, content.lastIndexOf("  - name: email-check"));
});

test("heartbeat surface resolves entries by slug", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-find-"));
  const heartbeatPath = path.join(root, "HEARTBEAT.md");
  await writeFile(
    heartbeatPath,
    [
      "## check-health",
      "",
      "Ping the health endpoint.",
      "",
      "Schedule: hourly",
      "",
    ].join("\n"),
    "utf8",
  );

  const surface = createHeartbeatSurface();
  const entries = await surface.read(heartbeatPath);

  assert.equal(surface.findBySlug(entries, "check-health")?.title, "check-health");
  assert.equal(surface.findBySlug(entries, "missing"), null);
});
