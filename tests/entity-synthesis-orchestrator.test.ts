import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { parseConfig } from "../packages/remnic-core/src/config.js";
import { Orchestrator } from "../packages/remnic-core/src/orchestrator.js";
import {
  normalizeEntityName,
  parseEntityFile,
} from "../packages/remnic-core/src/storage.js";

test("processEntitySynthesisQueue refreshes stale entities in bounded batches", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 120,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const primaryName = "Jane Doe";
    const primaryCanonical = normalizeEntityName(primaryName, "person");
    await storage.writeEntity(primaryName, "person", ["Led the roadmap."], {
      timestamp: "2026-04-13T09:00:00.000Z",
      sessionKey: "session-1",
      principal: "agent:main",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(primaryCanonical, "Jane Doe led the roadmap.", {
      updatedAt: "2026-04-13T09:30:00.000Z",
    });
    await storage.writeEntity(primaryName, "person", ["Now owns release approvals."], {
      timestamp: "2026-04-13T11:00:00.000Z",
      sessionKey: "session-2",
      principal: "agent:main",
      source: "extraction",
    });

    const secondaryName = "Project Beta";
    const secondaryCanonical = normalizeEntityName(secondaryName, "project");
    await storage.writeEntity(secondaryName, "project", ["Tracks a cleanup stream."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
    });

    let capturedPrompt = "";
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      capturedPrompt = messages.map((message) => message.content).join("\n\n");
      return { content: "Jane Doe now owns release approvals and still leads roadmap work." };
    };

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);

    const rawPrimary = await readFile(path.join(memoryDir, "entities", `${primaryCanonical}.md`), "utf-8");
    const primary = parseEntityFile(rawPrimary);
    const queue = await storage.readEntitySynthesisQueue();

    assert.equal(processed, 1);
    assert.equal(primary.synthesis, "Jane Doe now owns release approvals and still leads roadmap work.");
    assert.equal(primary.synthesisVersion, 2);
    assert.match(capturedPrompt, /Previous synthesis:\nJane Doe led the roadmap\./);
    assert.match(capturedPrompt, /Now owns release approvals\./);
    assert.doesNotMatch(capturedPrompt, /Led the roadmap\.\n- timestamp=/);
    assert.deepEqual(queue, [secondaryCanonical]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue sorts freshest evidence before truncating", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-sort-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-sort-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 120,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Newest event should survive truncation."], {
      timestamp: "2026-04-13T18:00:00.000Z",
      source: "extraction",
    });
    for (let hour = 10; hour <= 17; hour += 1) {
      await storage.writeEntity("Jane Doe", "person", [`Older event ${hour}.`], {
        timestamp: `2026-04-13T${String(hour).padStart(2, "0")}:00:00.000Z`,
        source: "extraction",
      });
    }
    await storage.updateEntitySynthesis(canonical, "Jane Doe had an earlier synthesis.", {
      updatedAt: "2026-04-13T09:00:00.000Z",
    });

    let capturedPrompt = "";
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      capturedPrompt = messages.map((message) => message.content).join("\n\n");
      return { content: "Jane Doe has refreshed synthesis." };
    };

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);

    assert.equal(processed, 1);
    assert.match(capturedPrompt, /Newest event should survive truncation\./);
    assert.doesNotMatch(capturedPrompt, /Older event 10\./);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue skips failed targets and continues through the stale queue", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-skip-fail-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-skip-fail-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 120,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const failingName = "Alice Failure";
    const failingCanonical = normalizeEntityName(failingName, "person");
    await storage.writeEntity(failingName, "person", ["Newest entity keeps failing synthesis."], {
      timestamp: "2026-04-13T18:00:00.000Z",
      source: "extraction",
    });

    const succeedingName = "Project Success";
    const succeedingCanonical = normalizeEntityName(succeedingName, "project");
    await storage.writeEntity(succeedingName, "project", ["Second stale entity should still refresh."], {
      timestamp: "2026-04-13T17:00:00.000Z",
      source: "extraction",
    });

    let completionCalls = 0;
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      completionCalls += 1;
      const prompt = messages.map((message) => message.content).join("\n\n");
      if (prompt.includes("Alice Failure")) {
        throw new Error("simulated synthesis failure");
      }
      return { content: "Project Success has refreshed synthesis." };
    };

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);
    const rawSuccess = await readFile(
      path.join(memoryDir, "entities", `${succeedingCanonical}.md`),
      "utf-8",
    );
    const success = parseEntityFile(rawSuccess);
    const queue = await storage.readEntitySynthesisQueue();

    assert.equal(processed, 1);
    assert.equal(completionCalls, 2);
    assert.equal(success.synthesis, "Project Success has refreshed synthesis.");
    assert.deepEqual(queue, [failingCanonical]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue deduplicates repeated facts before truncating evidence", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-dedupe-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-dedupe-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 120,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Seed fact before synthesis."], {
      timestamp: "2026-04-13T08:00:00.000Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe had an earlier synthesis.", {
      updatedAt: "2026-04-13T09:00:00.000Z",
    });
    for (let hour = 20; hour >= 13; hour -= 1) {
      await storage.writeEntity("Jane Doe", "person", ["Repeated recent fact."], {
        timestamp: `2026-04-13T${String(hour).padStart(2, "0")}:00:00.000Z`,
        source: "extraction",
      });
    }
    await storage.writeEntity("Jane Doe", "person", ["Unique older fact should still be included."], {
      timestamp: "2026-04-13T12:00:00.000Z",
      source: "extraction",
    });

    let capturedPrompt = "";
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      capturedPrompt = messages.map((message) => message.content).join("\n\n");
      return { content: "Jane Doe has refreshed synthesis." };
    };

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);

    assert.equal(processed, 1);
    assert.match(capturedPrompt, /Repeated recent fact\./);
    assert.match(capturedPrompt, /Unique older fact should still be included\./);
    assert.doesNotMatch(capturedPrompt, /Seed fact before synthesis\./);
    assert.equal((capturedPrompt.match(/Repeated recent fact\./g) ?? []).length, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue treats offset timestamps as newer when filtering evidence", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-offset-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-offset-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 120,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Older event should stay filtered out."], {
      timestamp: "2026-04-13T14:15:00Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe had an earlier synthesis.", {
      updatedAt: "2026-04-13T14:30:00Z",
    });
    await storage.writeEntity("Jane Doe", "person", ["Offset timestamp should count as new evidence."], {
      timestamp: "2026-04-13T10:00:00-05:00",
      source: "extraction",
    });

    let capturedPrompt = "";
    orchestrator.fastChatCompletion = async (messages: Array<{ role: string; content: string }>) => {
      capturedPrompt = messages.map((message) => message.content).join("\n\n");
      return { content: "Jane Doe has refreshed synthesis." };
    };

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);

    assert.equal(processed, 1);
    assert.match(capturedPrompt, /Offset timestamp should count as new evidence\./);
    assert.doesNotMatch(capturedPrompt, /Older event should stay filtered out\./);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("processEntitySynthesisQueue treats zero max tokens as disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-zero-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-orch-zero-workspace-"));
  try {
    const orchestrator = new Orchestrator(parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      sharedContextEnabled: false,
      hourlySummariesEnabled: false,
      entitySummaryEnabled: true,
      entitySynthesisMaxTokens: 0,
    })) as any;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    await storage.writeEntity("Jane Doe", "person", ["Leads roadmap work."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
    });

    let completionCalls = 0;
    orchestrator.fastChatCompletion = async () => {
      completionCalls += 1;
      return { content: "should not be called" };
    };

    const processed = await orchestrator.processEntitySynthesisQueue("default", 1);

    assert.equal(processed, 0);
    assert.equal(completionCalls, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
