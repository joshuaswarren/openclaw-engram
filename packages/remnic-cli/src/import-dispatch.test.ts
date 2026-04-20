import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultWriteMemoriesToOrchestrator,
  runImporter,
  type ImportedMemory,
  type ImporterAdapter,
  type ImporterWriteTarget,
  type ImportTurn,
} from "@remnic/core";

import {
  parseImportArgs,
  runImportCommand,
  type ImportDispatchArgs,
  type ImportDispatchIO,
} from "./import-dispatch.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(): { target: ImporterWriteTarget; received: ImportTurn[][] } {
  const received: ImportTurn[][] = [];
  return {
    target: {
      async ingestBulkImportBatch(turns) {
        received.push(turns.map((t) => ({ ...t })));
      },
      bulkImportWriteNamespace() {
        return "default";
      },
    },
    received,
  };
}

function makeIo(opts: {
  fileContents?: string;
  adapter: ImporterAdapter<unknown>;
  target: ImporterWriteTarget;
}): {
  io: ImportDispatchIO;
  stdoutLines: string[];
  stderrLines: string[];
} {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    io: {
      readFile: async () => opts.fileContents ?? "{}",
      loadAdapter: async () => opts.adapter,
      runImporter,
      target: opts.target,
      stdout: (line) => stdoutLines.push(line),
      stderr: (line) => stderrLines.push(line),
    },
    stdoutLines,
    stderrLines,
  };
}

function makeFakeAdapter(memories: ImportedMemory[]): ImporterAdapter<ImportedMemory[]> {
  return {
    name: "chatgpt",
    sourceLabel: "chatgpt",
    parse: () => memories,
    transform: (parsed) => parsed,
    async writeTo(target, batch) {
      return defaultWriteMemoriesToOrchestrator(target, batch);
    },
  };
}

// ---------------------------------------------------------------------------
// parseImportArgs — flag validation (CLAUDE.md rules 14, 51)
// ---------------------------------------------------------------------------

describe("parseImportArgs", () => {
  it("requires --adapter", () => {
    assert.throws(() => parseImportArgs([]), /--adapter/);
  });

  it("rejects an unknown adapter with the valid list", () => {
    assert.throws(
      () => parseImportArgs(["--adapter", "bogus"]),
      /chatgpt, claude, gemini, mem0/,
    );
  });

  it("accepts the four canonical adapters", () => {
    for (const name of ["chatgpt", "claude", "gemini", "mem0"] as const) {
      const parsed = parseImportArgs(["--adapter", name]);
      assert.equal(parsed.adapter, name);
    }
  });

  it("rejects --adapter with no following value", () => {
    assert.throws(() => parseImportArgs(["--adapter"]), /requires a value/);
  });

  it("rejects --file with no following value", () => {
    assert.throws(
      () => parseImportArgs(["--adapter", "chatgpt", "--file"]),
      /requires a value/,
    );
  });

  it("rejects --batch-size with non-numeric value", () => {
    assert.throws(
      () =>
        parseImportArgs([
          "--adapter",
          "chatgpt",
          "--batch-size",
          "not-a-number",
        ]),
      /--batch-size/,
    );
  });

  it("rejects --rate-limit of zero", () => {
    assert.throws(
      () =>
        parseImportArgs([
          "--adapter",
          "mem0",
          "--rate-limit",
          "0",
        ]),
      /rateLimit/,
    );
  });

  it("accepts --dry-run as a boolean flag", () => {
    const parsed = parseImportArgs([
      "--adapter",
      "chatgpt",
      "--file",
      "/tmp/x.json",
      "--dry-run",
    ]);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.file, "/tmp/x.json");
  });

  it("accepts --include-conversations", () => {
    const parsed = parseImportArgs([
      "--adapter",
      "chatgpt",
      "--include-conversations",
    ]);
    assert.equal(parsed.includeConversations, true);
  });

  it("rejects unknown flags rather than silently ignoring", () => {
    assert.throws(
      () => parseImportArgs(["--adapter", "chatgpt", "--unknown-opt", "x"]),
      /Unknown flag/,
    );
  });
});

// ---------------------------------------------------------------------------
// runImportCommand — dry-run + full integration (slice 1 contract)
// ---------------------------------------------------------------------------

describe("runImportCommand — slice 1 integration", () => {
  it("dry-run with 3 fake memories reports a plan and never writes", async () => {
    const memories: ImportedMemory[] = [1, 2, 3].map((i) => ({
      content: `memory-${i}`,
      sourceLabel: "chatgpt",
    }));
    const adapter = makeFakeAdapter(memories);
    const { target, received } = makeTarget();
    const { io, stdoutLines } = makeIo({ adapter, target });

    const args: ImportDispatchArgs = {
      adapter: "chatgpt",
      file: "/tmp/fake.json",
      dryRun: true,
      includeConversations: false,
    };
    const result = await runImportCommand(args, io);
    assert.ok(result);
    assert.equal(result.dryRun, true);
    assert.equal(result.memoriesPlanned, 3);
    assert.equal(result.memoriesWritten, 0);
    assert.equal(received.length, 0);
    assert.ok(
      stdoutLines.some((l) => l.includes("Dry-run") && l.includes("3")),
      `expected dry-run stdout, got: ${stdoutLines.join("\n")}`,
    );
  });

  it("non-dry-run hands memories to the orchestrator target", async () => {
    const memories: ImportedMemory[] = [1, 2, 3].map((i) => ({
      content: `memory-${i}`,
      sourceLabel: "chatgpt",
    }));
    const adapter = makeFakeAdapter(memories);
    const { target, received } = makeTarget();
    const { io, stdoutLines } = makeIo({ adapter, target });

    const args: ImportDispatchArgs = {
      adapter: "chatgpt",
      file: "/tmp/fake.json",
      dryRun: false,
      batchSize: 2,
      includeConversations: false,
    };
    const result = await runImportCommand(args, io);
    assert.ok(result);
    assert.equal(result.dryRun, false);
    assert.equal(result.memoriesWritten, 3);
    assert.equal(received.length, 2);
    assert.ok(
      stdoutLines.some((l) => l.includes("Imported 3 memories")),
      `expected success stdout, got: ${stdoutLines.join("\n")}`,
    );
  });

  it("surfaces the loader's install-hint error when the adapter is missing", async () => {
    const { target } = makeTarget();
    const io: ImportDispatchIO = {
      readFile: async () => "{}",
      loadAdapter: async () => {
        throw new Error(
          "The 'chatgpt' importer requires the optional @remnic/import-chatgpt package.",
        );
      },
      runImporter,
      target,
      stdout: () => {},
      stderr: () => {},
    };
    await assert.rejects(
      () =>
        runImportCommand(
          {
            adapter: "chatgpt",
            file: "/tmp/fake.json",
            dryRun: true,
            includeConversations: false,
          },
          io,
        ),
      /optional @remnic\/import-chatgpt/,
    );
  });
});
