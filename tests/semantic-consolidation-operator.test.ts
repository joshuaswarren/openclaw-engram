/**
 * Tests for operator-aware consolidation prompt + parse (issue #561 PR 3).
 *
 * Covers:
 *   - `chooseConsolidationOperator` heuristic (cluster size → operator).
 *   - `buildOperatorAwareConsolidationPrompt` shape and operator vocab.
 *   - `parseOperatorAwareConsolidationResponse` accepts strict JSON,
 *     fenced code blocks, and prose-prefixed JSON — and falls back to the
 *     heuristic for malformed / unknown / plain-text responses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOperatorAwareConsolidationPrompt,
  parseOperatorAwareConsolidationResponse,
  chooseConsolidationOperator,
  type ConsolidationCluster,
} from "../src/semantic-consolidation.ts";
import type { MemoryFile } from "../src/types.ts";

function makeMemory(id: string, content: string, created = "2026-04-19T00:00:00Z"): MemoryFile {
  return {
    path: `/memory/facts/${id}.md`,
    frontmatter: {
      id,
      category: "fact" as any,
      created,
      updated: created,
      source: "extraction",
      confidence: 0.8,
      confidenceTier: "implied" as any,
      tags: [],
    },
    content,
  };
}

function makeCluster(n: number): ConsolidationCluster {
  return {
    category: "fact",
    memories: Array.from({ length: n }, (_, i) =>
      makeMemory(`fact-${i + 1}`, `Source content #${i + 1}`),
    ),
    overlapScore: 0.8,
  };
}

// ─── chooseConsolidationOperator ─────────────────────────────────────────────

test("chooseConsolidationOperator returns update for single-memory clusters", () => {
  assert.equal(chooseConsolidationOperator(makeCluster(1)), "update");
});

test("chooseConsolidationOperator returns merge for multi-memory clusters", () => {
  assert.equal(chooseConsolidationOperator(makeCluster(2)), "merge");
  assert.equal(chooseConsolidationOperator(makeCluster(5)), "merge");
});

// ─── buildOperatorAwareConsolidationPrompt ───────────────────────────────────

test("buildOperatorAwareConsolidationPrompt names all three operators", () => {
  const prompt = buildOperatorAwareConsolidationPrompt(makeCluster(3));
  assert.ok(prompt.includes('"merge"'));
  assert.ok(prompt.includes('"update"'));
  assert.ok(prompt.includes('"split"'));
});

test("buildOperatorAwareConsolidationPrompt asks for JSON-only output", () => {
  const prompt = buildOperatorAwareConsolidationPrompt(makeCluster(2));
  assert.ok(prompt.includes('"operator"'));
  assert.ok(prompt.includes('"output"'));
  assert.ok(prompt.toLowerCase().includes("json"));
});

test("buildOperatorAwareConsolidationPrompt embeds every source memory", () => {
  const cluster = makeCluster(3);
  const prompt = buildOperatorAwareConsolidationPrompt(cluster);
  for (const m of cluster.memories) {
    assert.ok(prompt.includes(m.frontmatter.id));
    assert.ok(prompt.includes(m.content));
  }
});

// ─── parseOperatorAwareConsolidationResponse ─────────────────────────────────

test("parseOperatorAwareConsolidationResponse accepts strict JSON", () => {
  const cluster = makeCluster(3);
  const res = parseOperatorAwareConsolidationResponse(
    '{"operator":"merge","output":"canonical body"}',
    cluster,
  );
  assert.equal(res.operator, "merge");
  assert.equal(res.output, "canonical body");
});

test("parseOperatorAwareConsolidationResponse accepts update and split operators", () => {
  const cluster = makeCluster(2);
  for (const op of ["update", "split"] as const) {
    const res = parseOperatorAwareConsolidationResponse(
      `{"operator":"${op}","output":"body-${op}"}`,
      cluster,
    );
    assert.equal(res.operator, op);
    assert.equal(res.output, `body-${op}`);
  }
});

test("parseOperatorAwareConsolidationResponse tolerates fenced code blocks", () => {
  const cluster = makeCluster(2);
  const fenced = [
    "```json",
    '{"operator":"merge","output":"fenced body"}',
    "```",
  ].join("\n");
  const res = parseOperatorAwareConsolidationResponse(fenced, cluster);
  assert.equal(res.operator, "merge");
  assert.equal(res.output, "fenced body");
});

test("parseOperatorAwareConsolidationResponse tolerates prose-prefixed JSON", () => {
  const cluster = makeCluster(2);
  const withProse =
    'Here is the consolidation result:\n\n{"operator":"update","output":"updated body"}\n';
  const res = parseOperatorAwareConsolidationResponse(withProse, cluster);
  assert.equal(res.operator, "update");
  assert.equal(res.output, "updated body");
});

test("parseOperatorAwareConsolidationResponse falls back to heuristic on plain text", () => {
  const cluster = makeCluster(3);
  const plain = "Joshua prefers TypeScript for backend work.";
  const res = parseOperatorAwareConsolidationResponse(plain, cluster);
  // Multi-memory cluster → heuristic returns "merge".
  assert.equal(res.operator, "merge");
  assert.equal(res.output, plain);
});

test("parseOperatorAwareConsolidationResponse falls back to heuristic for unknown operator", () => {
  const cluster = makeCluster(1);
  // Single-memory cluster → heuristic returns "update".
  const res = parseOperatorAwareConsolidationResponse(
    '{"operator":"annihilate","output":"body"}',
    cluster,
  );
  assert.equal(res.operator, "update");
  assert.equal(res.output, "body");
});

test("parseOperatorAwareConsolidationResponse falls back on malformed JSON", () => {
  const cluster = makeCluster(4);
  const broken = '{"operator":"merge","output":"body"'; // missing closing brace
  const res = parseOperatorAwareConsolidationResponse(broken, cluster);
  // Heuristic fallback: multi-memory → merge; output is the raw trimmed text.
  assert.equal(res.operator, "merge");
  assert.equal(res.output, broken.trim());
});

test("parseOperatorAwareConsolidationResponse falls back when output field is empty", () => {
  const cluster = makeCluster(2);
  const res = parseOperatorAwareConsolidationResponse(
    '{"operator":"merge","output":""}',
    cluster,
  );
  assert.equal(res.operator, "merge");
  // Empty output field → use raw trimmed response instead of dropping the
  // cluster.  Callers still write something rather than losing data.
  assert.equal(res.output, '{"operator":"merge","output":""}');
});

test("parseOperatorAwareConsolidationResponse never throws on weird inputs", () => {
  const cluster = makeCluster(2);
  const inputs = ["", "   ", "{}", "null", "[]", "not json at all"];
  for (const input of inputs) {
    const res = parseOperatorAwareConsolidationResponse(input, cluster);
    assert.ok(res.operator === "merge" || res.operator === "update" || res.operator === "split");
    assert.equal(typeof res.output, "string");
  }
});

test("parseOperatorAwareConsolidationResponse handles mixed-case operator values", () => {
  const cluster = makeCluster(2);
  const res = parseOperatorAwareConsolidationResponse(
    '{"operator":"MERGE","output":"upper case"}',
    cluster,
  );
  assert.equal(res.operator, "merge");
  assert.equal(res.output, "upper case");
});

// ─── Config coercion (regression for PR #632 review feedback) ────────────────
// codex P1 / cursor Medium: `operatorAwareConsolidationEnabled` must
// coerce string-valued falsey config inputs (e.g.
// `--config operatorAwareConsolidationEnabled=false`) so the documented
// rollback escape hatch actually works when the CLI passes string
// values.

test("operatorAwareConsolidationEnabled coerces string 'false' to disabled", async () => {
  const { parseConfig } = await import("../src/config.ts");
  const parsed = parseConfig({ operatorAwareConsolidationEnabled: "false" } as any);
  assert.equal(parsed.operatorAwareConsolidationEnabled, false);
});

test("operatorAwareConsolidationEnabled defaults to true when unset", async () => {
  const { parseConfig } = await import("../src/config.ts");
  const parsed = parseConfig({});
  assert.equal(parsed.operatorAwareConsolidationEnabled, true);
});

test("operatorAwareConsolidationEnabled honors boolean false", async () => {
  const { parseConfig } = await import("../src/config.ts");
  const parsed = parseConfig({ operatorAwareConsolidationEnabled: false });
  assert.equal(parsed.operatorAwareConsolidationEnabled, false);
});
