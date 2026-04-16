/**
 * Tests for memory extension discovery (#382).
 *
 * Covers: discovery, slug validation, instructions.md requirement,
 * schema.json parsing, example capping, sorting, scripts/ safety,
 * renderExtensionsBlock token budget, and consolidation wiring.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  discoverMemoryExtensions,
  renderExtensionsBlock,
  renderExtensionsFooter,
  REMNIC_EXTENSIONS_TOTAL_TOKEN_LIMIT,
} from "../packages/remnic-core/src/memory-extension-host/index.ts";
import type { DiscoveredExtension } from "../packages/remnic-core/src/memory-extension-host/types.ts";
import {
  buildConsolidationPrompt,
  buildExtensionsBlockForConsolidation,
  resolveExtensionsRoot,
} from "../packages/remnic-core/src/semantic-consolidation.ts";
import type { PluginConfig } from "../packages/remnic-core/src/types.ts";
import { parseConfig } from "../packages/remnic-core/src/config.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "remnic-ext-test-"));
}

function createExtension(
  root: string,
  name: string,
  opts: {
    instructions?: string;
    schema?: Record<string, unknown>;
    exampleCount?: number;
    includeScripts?: boolean;
  } = {},
): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });

  if (opts.instructions !== undefined) {
    fs.writeFileSync(path.join(dir, "instructions.md"), opts.instructions, "utf-8");
  }

  if (opts.schema !== undefined) {
    fs.writeFileSync(path.join(dir, "schema.json"), JSON.stringify(opts.schema), "utf-8");
  }

  if (opts.exampleCount && opts.exampleCount > 0) {
    const exDir = path.join(dir, "examples");
    fs.mkdirSync(exDir, { recursive: true });
    for (let i = 0; i < opts.exampleCount; i++) {
      fs.writeFileSync(
        path.join(exDir, `example-${String(i).padStart(3, "0")}.md`),
        `Example ${i}`,
        "utf-8",
      );
    }
  }

  if (opts.includeScripts) {
    const scriptsDir = path.join(dir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, "install.sh"), "#!/bin/bash\necho hi", "utf-8");
  }
}

const silentLog = { warn: () => {}, debug: () => {} };

function collectWarnings(): { log: { warn: (msg: string) => void; debug: () => void }; warnings: string[] } {
  const warnings: string[] = [];
  return {
    log: {
      warn: (msg: string) => warnings.push(msg),
      debug: () => {},
    },
    warnings,
  };
}

// ── discoverMemoryExtensions ─────────────────────────────────────────────────

test("empty root returns []", async () => {
  const root = makeTempDir();
  const result = await discoverMemoryExtensions(root, silentLog);
  assert.deepStrictEqual(result, []);
  fs.rmSync(root, { recursive: true });
});

test("missing root returns [] without warning", async () => {
  const root = path.join(os.tmpdir(), `nonexistent-${Date.now()}`);
  const { log, warnings } = collectWarnings();
  const result = await discoverMemoryExtensions(root, log);
  assert.deepStrictEqual(result, []);
  assert.equal(warnings.length, 0);
});

test("one valid extension returns one entry with correct fields", async () => {
  const root = makeTempDir();
  createExtension(root, "github-issues", {
    instructions: "Track GitHub issues as reference memories.",
    schema: {
      memoryTypes: ["reference"],
      groupingHints: ["repository"],
      version: "1.0.0",
    },
    exampleCount: 2,
  });

  const result = await discoverMemoryExtensions(root, silentLog);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "github-issues");
  assert.equal(result[0].root, path.join(root, "github-issues"));
  assert.equal(result[0].instructionsPath, path.join(root, "github-issues", "instructions.md"));
  assert.equal(result[0].instructions, "Track GitHub issues as reference memories.");
  assert.deepStrictEqual(result[0].schema, {
    memoryTypes: ["reference"],
    groupingHints: ["repository"],
    version: "1.0.0",
  });
  assert.equal(result[0].examplesPaths.length, 2);

  fs.rmSync(root, { recursive: true });
});

test("extension missing instructions.md is skipped with warning", async () => {
  const root = makeTempDir();
  // Create directory but no instructions.md
  fs.mkdirSync(path.join(root, "no-instructions"), { recursive: true });

  const { log, warnings } = collectWarnings();
  const result = await discoverMemoryExtensions(root, log);
  assert.equal(result.length, 0);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("missing instructions.md"));

  fs.rmSync(root, { recursive: true });
});

test("invalid slug is skipped with warning", async () => {
  const root = makeTempDir();
  // Capital letters are invalid
  createExtension(root, "BadSlug", { instructions: "test" });

  const { log, warnings } = collectWarnings();
  const result = await discoverMemoryExtensions(root, log);
  assert.equal(result.length, 0);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("invalid slug"));

  fs.rmSync(root, { recursive: true });
});

test("malformed schema.json results in entry with schema undefined", async () => {
  const root = makeTempDir();
  const dir = path.join(root, "bad-schema");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "instructions.md"), "Test", "utf-8");
  fs.writeFileSync(path.join(dir, "schema.json"), "not valid json{{{", "utf-8");

  const { log, warnings } = collectWarnings();
  const result = await discoverMemoryExtensions(root, log);
  assert.equal(result.length, 1);
  assert.equal(result[0].schema, undefined);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("malformed schema.json"));

  fs.rmSync(root, { recursive: true });
});

test("15 example files: only first 10 collected", async () => {
  const root = makeTempDir();
  createExtension(root, "many-examples", {
    instructions: "Test",
    exampleCount: 15,
  });

  const result = await discoverMemoryExtensions(root, silentLog);
  assert.equal(result.length, 1);
  assert.equal(result[0].examplesPaths.length, 10);

  fs.rmSync(root, { recursive: true });
});

test("discovery results sorted by name", async () => {
  const root = makeTempDir();
  createExtension(root, "zeta-ext", { instructions: "Zeta" });
  createExtension(root, "alpha-ext", { instructions: "Alpha" });
  createExtension(root, "middle-ext", { instructions: "Middle" });

  const result = await discoverMemoryExtensions(root, silentLog);
  assert.equal(result.length, 3);
  assert.equal(result[0].name, "alpha-ext");
  assert.equal(result[1].name, "middle-ext");
  assert.equal(result[2].name, "zeta-ext");

  fs.rmSync(root, { recursive: true });
});

test("discovery never reads scripts/ directory", async () => {
  const root = makeTempDir();
  createExtension(root, "has-scripts", {
    instructions: "Test",
    includeScripts: true,
  });

  // Track all readFile/readdir calls via spying on fs
  const originalReadFile = fs.promises.readFile;
  const readPaths: string[] = [];
  // @ts-expect-error -- spy override for test
  fs.promises.readFile = async function (filePath: string, ...args: unknown[]) {
    readPaths.push(String(filePath));
    return (originalReadFile as Function).call(fs.promises, filePath, ...args);
  };

  try {
    await discoverMemoryExtensions(root, silentLog);
    // Verify no path under scripts/ was read
    const scriptsReads = readPaths.filter((p) => p.includes("/scripts/"));
    assert.equal(scriptsReads.length, 0, `Unexpected reads from scripts/: ${scriptsReads.join(", ")}`);
  } finally {
    fs.promises.readFile = originalReadFile;
  }

  fs.rmSync(root, { recursive: true });
});

// ── renderExtensionsBlock ────────────────────────────────────────────────────

test("renderExtensionsBlock: empty list returns empty string", () => {
  const result = renderExtensionsBlock([]);
  assert.equal(result, "");
});

test("renderExtensionsBlock: two small extensions both inlined", () => {
  const extensions: DiscoveredExtension[] = [
    {
      name: "alpha",
      root: "/tmp/alpha",
      instructionsPath: "/tmp/alpha/instructions.md",
      instructions: "Alpha extension instructions.",
      examplesPaths: [],
    },
    {
      name: "beta",
      root: "/tmp/beta",
      instructionsPath: "/tmp/beta/instructions.md",
      instructions: "Beta extension instructions.",
      examplesPaths: [],
    },
  ];

  const result = renderExtensionsBlock(extensions);
  assert.ok(result.includes("## Active memory extensions"));
  assert.ok(result.includes("### remnic-extension/alpha"));
  assert.ok(result.includes("### remnic-extension/beta"));
  assert.ok(result.includes("Alpha extension instructions."));
  assert.ok(result.includes("Beta extension instructions."));
  assert.ok(!result.includes("omitted"));
});

test("renderExtensionsBlock: exceeds token budget adds truncation footer", () => {
  // Create extensions that collectively exceed the budget
  const bigInstruction = "x".repeat(REMNIC_EXTENSIONS_TOTAL_TOKEN_LIMIT * 4);
  const extensions: DiscoveredExtension[] = [
    {
      name: "big-one",
      root: "/tmp/big-one",
      instructionsPath: "/tmp/big-one/instructions.md",
      instructions: bigInstruction,
      examplesPaths: [],
    },
    {
      name: "small-one",
      root: "/tmp/small-one",
      instructionsPath: "/tmp/small-one/instructions.md",
      instructions: "Small extension.",
      examplesPaths: [],
    },
  ];

  const result = renderExtensionsBlock(extensions);
  // Big one takes all budget, small one is omitted (or vice versa depending on order)
  assert.ok(result.includes("omitted"));
});

// ── renderExtensionsFooter ──────────────────────────────────────────────────

test("renderExtensionsFooter: empty list returns empty string", () => {
  assert.equal(renderExtensionsFooter([]), "");
});

test("renderExtensionsFooter: returns comma-separated names", () => {
  const exts: DiscoveredExtension[] = [
    { name: "alpha", root: "", instructionsPath: "", instructions: "", examplesPaths: [] },
    { name: "beta", root: "", instructionsPath: "", instructions: "", examplesPaths: [] },
  ];
  const footer = renderExtensionsFooter(exts);
  assert.equal(footer, "Active extensions: alpha, beta");
});

// ── resolveExtensionsRoot ────────────────────────────────────────────────────

test("resolveExtensionsRoot: uses memoryExtensionsRoot when set", () => {
  const config = parseConfig({ memoryExtensionsRoot: "/custom/extensions" });
  const root = resolveExtensionsRoot(config);
  assert.equal(root, "/custom/extensions");
});

test("resolveExtensionsRoot: derives from memoryDir when empty", () => {
  const config = parseConfig({ memoryDir: "/home/user/.openclaw/workspace/memory/local" });
  const root = resolveExtensionsRoot(config);
  assert.equal(root, "/home/user/.openclaw/workspace/memory/memory_extensions");
});

// ── Config parsing ──────────────────────────────────────────────────────────

test("parseConfig: memoryExtensionsEnabled defaults to true", () => {
  const config = parseConfig({});
  assert.equal(config.memoryExtensionsEnabled, true);
});

test("parseConfig: memoryExtensionsEnabled can be set to false", () => {
  const config = parseConfig({ memoryExtensionsEnabled: false });
  assert.equal(config.memoryExtensionsEnabled, false);
});

test("parseConfig: memoryExtensionsRoot defaults to empty string", () => {
  const config = parseConfig({});
  assert.equal(config.memoryExtensionsRoot, "");
});

test("parseConfig: memoryExtensionsRoot preserves custom value", () => {
  const config = parseConfig({ memoryExtensionsRoot: "/my/extensions" });
  assert.equal(config.memoryExtensionsRoot, "/my/extensions");
});

// ── Consolidation wiring ────────────────────────────────────────────────────

test("consolidation prompt includes extensions block when extensions exist", async () => {
  const root = makeTempDir();
  createExtension(root, "test-ext", {
    instructions: "Test extension for consolidation wiring.",
  });

  const config = parseConfig({
    memoryExtensionsEnabled: true,
    memoryExtensionsRoot: root,
  });

  const block = await buildExtensionsBlockForConsolidation(config);
  assert.ok(block.includes("## Active memory extensions"));
  assert.ok(block.includes("### remnic-extension/test-ext"));
  assert.ok(block.includes("Test extension for consolidation wiring."));

  fs.rmSync(root, { recursive: true });
});

test("consolidation prompt unchanged when no extensions", async () => {
  const root = makeTempDir();

  const config = parseConfig({
    memoryExtensionsEnabled: true,
    memoryExtensionsRoot: root,
  });

  const block = await buildExtensionsBlockForConsolidation(config);
  assert.equal(block, "");

  fs.rmSync(root, { recursive: true });
});

test("consolidation prompt empty when extensions disabled", async () => {
  const root = makeTempDir();
  createExtension(root, "test-ext", {
    instructions: "Should not appear.",
  });

  const config = parseConfig({
    memoryExtensionsEnabled: false,
    memoryExtensionsRoot: root,
  });

  const block = await buildExtensionsBlockForConsolidation(config);
  assert.equal(block, "");

  fs.rmSync(root, { recursive: true });
});
