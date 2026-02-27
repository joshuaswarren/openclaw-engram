import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { evaluateMemoryActionPolicy } from "../src/memory-action-policy.js";

test("evaluateMemoryActionPolicy applies deterministic precedence", () => {
  const disabled = evaluateMemoryActionPolicy({
    action: "discard",
    eligibility: {
      confidence: 0.95,
      importance: 0.95,
      lifecycleState: "active",
      source: "manual",
    },
    options: {
      actionsEnabled: false,
      maxCompressionTokensPerHour: 1500,
    },
  });
  assert.equal(disabled.decision, "deny");
  assert.equal(disabled.rationale, "contextCompressionActionsEnabled=false");

  const staleUpdate = evaluateMemoryActionPolicy({
    action: "update_note",
    eligibility: {
      confidence: 0.1,
      importance: 0.3,
      lifecycleState: "stale",
      source: "manual",
    },
    options: {
      actionsEnabled: true,
      maxCompressionTokensPerHour: 1500,
    },
  });
  assert.equal(staleUpdate.decision, "deny");
  assert.equal(staleUpdate.rationale, "lifecycle_state_stale_restricted");

  const zeroLimit = evaluateMemoryActionPolicy({
    action: "summarize_node",
    eligibility: {
      confidence: 0.9,
      importance: 0.7,
      lifecycleState: "active",
      source: "manual",
    },
    options: {
      actionsEnabled: true,
      maxCompressionTokensPerHour: 0,
    },
  });
  assert.equal(zeroLimit.decision, "defer");
  assert.equal(zeroLimit.rationale, "maxCompressionTokensPerHour=0");

  const unknownLowConfidence = evaluateMemoryActionPolicy({
    action: "store_note",
    eligibility: {
      confidence: 0,
      importance: 0,
      lifecycleState: "candidate",
      source: "unknown",
    },
    options: {
      actionsEnabled: true,
      maxCompressionTokensPerHour: 1500,
    },
  });
  assert.equal(unknownLowConfidence.decision, "allow");
  assert.equal(unknownLowConfidence.rationale, "eligible");
});

test("appendMemoryActionEvent persists policy denial trace when actions are disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memory-action-policy-disabled-"));
  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: memoryDir,
      contextCompressionActionsEnabled: false,
    });
    const orchestrator = new Orchestrator(cfg);

    const wrote = await orchestrator.appendMemoryActionEvent({
      action: "store_note",
      outcome: "applied",
      reason: "manual-test",
    });
    assert.equal(wrote, true);

    const storage = await orchestrator.getStorage();
    const events = await storage.readMemoryActionEvents(1);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.policyDecision, "deny");
    assert.equal(events[0]?.policyRationale, "contextCompressionActionsEnabled=false");
    assert.equal(events[0]?.outcome, "skipped");
    assert.match(events[0]?.reason ?? "", /policy:deny/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("appendMemoryActionEvent keeps default unknown-eligibility callers applied when enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memory-action-policy-default-"));
  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: memoryDir,
      contextCompressionActionsEnabled: true,
      maxCompressionTokensPerHour: 1500,
    });
    const orchestrator = new Orchestrator(cfg);

    const wrote = await orchestrator.appendMemoryActionEvent({
      action: "store_note",
      outcome: "applied",
      reason: "default-caller",
    });
    assert.equal(wrote, true);

    const storage = await orchestrator.getStorage();
    const events = await storage.readMemoryActionEvents(1);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.policyDecision, "allow");
    assert.equal(events[0]?.outcome, "applied");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("previewMemoryActionEvent applies policy normalization for dry-run parity", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memory-action-policy-preview-"));
  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: memoryDir,
      contextCompressionActionsEnabled: true,
    });
    const orchestrator = new Orchestrator(cfg);

    const preview = orchestrator.previewMemoryActionEvent({
      action: "discard",
      outcome: "applied",
      policyEligibility: {
        confidence: 0.9,
        lifecycleState: "active",
        importance: 0.95,
        source: "manual",
      },
    });

    assert.equal(preview.policyDecision, "deny");
    assert.equal(preview.outcome, "skipped");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("appendMemoryActionEvent enforces zero-limit defer semantics for summarize_node", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memory-action-policy-zero-limit-"));
  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: memoryDir,
      contextCompressionActionsEnabled: true,
      maxCompressionTokensPerHour: 0,
    });
    const orchestrator = new Orchestrator(cfg);

    const wrote = await orchestrator.appendMemoryActionEvent({
      action: "summarize_node",
      outcome: "applied",
      policyEligibility: {
        confidence: 0.9,
        lifecycleState: "active",
        importance: 0.9,
        source: "manual",
      },
    });
    assert.equal(wrote, true);

    const storage = await orchestrator.getStorage();
    const events = await storage.readMemoryActionEvents(1);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.policyDecision, "defer");
    assert.equal(events[0]?.policyRationale, "maxCompressionTokensPerHour=0");
    assert.equal(events[0]?.outcome, "skipped");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
