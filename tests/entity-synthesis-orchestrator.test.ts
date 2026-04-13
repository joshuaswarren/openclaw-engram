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
