import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractUserPrompt, parseGeminiExport } from "./parser.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
}

describe("parseGeminiExport", () => {
  it("parses a top-level activity array and filters non-Gemini entries", () => {
    const parsed = parseGeminiExport(loadFixture("my-activity.json"));
    // 3 Gemini Apps + 1 Bard (legacy) = 4 kept, Search filtered out.
    assert.equal(parsed.activities.length, 4);
    for (const a of parsed.activities) {
      assert.ok(a.header === "Gemini Apps" || a.header === "Bard");
    }
  });

  it("parses a bundle object with activities key", () => {
    const parsed = parseGeminiExport(loadFixture("bundle.json"));
    assert.equal(parsed.activities.length, 1);
  });

  it("keepNonGemini retains filtered records when explicitly requested", () => {
    const parsed = parseGeminiExport(loadFixture("my-activity.json"), {
      keepNonGemini: true,
    });
    assert.equal(parsed.activities.length, 5);
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseGeminiExport("{not-json"), /not valid JSON/);
  });

  it("strict mode rejects non-object top-level entries", () => {
    assert.throws(
      () => parseGeminiExport(JSON.stringify(["bad"]), { strict: true }),
      /must be an object/,
    );
  });

  it("preserves filePath in output", () => {
    const parsed = parseGeminiExport(loadFixture("bundle.json"), {
      filePath: "/tmp/takeout/my-activity.json",
    });
    assert.equal(parsed.filePath, "/tmp/takeout/my-activity.json");
  });

  // Cursor review on PR #600 — parseGeminiExport MUST reject undefined /
  // null input (what runImportCommand passes when --file is omitted) with
  // a user-facing error. Silently returning 0 memories masks bad CLI
  // invocations.
  it("rejects missing input with a user-facing error (CLAUDE.md rule 51)", () => {
    assert.throws(() => parseGeminiExport(undefined), /requires a file/);
    assert.throws(() => parseGeminiExport(null), /requires a file/);
  });

  // Cursor review on PR #600 — the strict-mode error used `typeof raw`
  // which reports "object" for null (JS trap). The message must say
  // "null" instead.
  it("strict mode reports 'null' for JSON null input, not 'object'", () => {
    assert.throws(
      () => parseGeminiExport("null", { strict: true }),
      /received null/,
    );
  });

  // Codex review on PR #600 — pointing --file at a random JSON object
  // (e.g. a config file) was reported as "0 memories imported" instead
  // of surfacing an error. Now throws for objects that lack any of the
  // recognized activity keys.
  it("rejects object payloads without a recognized activity key", () => {
    assert.throws(
      () => parseGeminiExport({ foo: "bar" }),
      /no recognized activity key/,
    );
    assert.throws(
      () => parseGeminiExport(JSON.stringify({ random: [1, 2] })),
      /no recognized activity key/,
    );
  });
});

describe("extractUserPrompt", () => {
  it("prefers `text` when present", () => {
    assert.equal(
      extractUserPrompt({ header: "Gemini Apps", text: "hello" }),
      "hello",
    );
  });

  it("falls back to `title` and strips legacy Asked: prefix", () => {
    assert.equal(
      extractUserPrompt({ header: "Bard", title: "Asked: why is the sky blue?" }),
      "why is the sky blue?",
    );
  });

  it("returns undefined for records with no usable text", () => {
    assert.equal(extractUserPrompt({ header: "Gemini Apps" }), undefined);
    assert.equal(
      extractUserPrompt({ header: "Gemini Apps", title: "   " }),
      undefined,
    );
  });
});
