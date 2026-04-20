/**
 * Tests for `resolveCodingNamespaceOverlay` (issue #569 PR 2).
 *
 * All fixtures synthetic. These tests cover the resolver-level contract —
 * project overlay vs no-overlay, escape hatch, sanitization, read+write
 * symmetry invariant.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  branchNamespaceName,
  projectNamespaceName,
  resolveCodingNamespaceOverlay,
} from "./coding-namespace.js";
import type { CodingContext, CodingModeConfig } from "../types.js";

function ctx(overrides: Partial<CodingContext> = {}): CodingContext {
  return {
    projectId: "origin:abcd1234",
    branch: "main",
    rootPath: "/work/proj",
    defaultBranch: "main",
    ...overrides,
  };
}

function mode(overrides: Partial<CodingModeConfig> = {}): CodingModeConfig {
  return {
    projectScope: true,
    branchScope: false,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Name helpers
// ──────────────────────────────────────────────────────────────────────────

test("projectNamespaceName: stable form for origin-derived id", () => {
  assert.equal(projectNamespaceName("origin:abcd1234"), "project:origin:abcd1234");
});

test("projectNamespaceName: lowercases and strips unsafe characters", () => {
  assert.equal(projectNamespaceName("ORIGIN:ABCD!!"), "project:origin:abcd");
});

test("projectNamespaceName: empty input falls back to 'unknown'", () => {
  assert.equal(projectNamespaceName(""), "project:unknown");
  assert.equal(projectNamespaceName("   "), "project:unknown");
});

test("branchNamespaceName: layers branch on project (branch slashes collapsed to dashes)", () => {
  // `/` is not in the safe alphabet — it collapses to `-` so the resulting
  // name round-trips safely through the collection-name mapper in
  // namespaces/search.ts. The `project:<id>/branch:<name>` structural
  // separators remain.
  assert.equal(
    branchNamespaceName("origin:abcd1234", "feat/ui"),
    "project:origin:abcd1234/branch:feat-ui",
  );
});

test("branchNamespaceName: sanitizes branch name (lowercase + unsafe → dash)", () => {
  assert.equal(
    branchNamespaceName("origin:abcd", "FEAT/UI (wip)"),
    "project:origin:abcd/branch:feat-ui-wip",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// resolveCodingNamespaceOverlay — escape hatches
// ──────────────────────────────────────────────────────────────────────────

test("resolveCodingNamespaceOverlay: no context → null (connector didn't provide one)", () => {
  assert.equal(resolveCodingNamespaceOverlay(null, mode()), null);
  assert.equal(resolveCodingNamespaceOverlay(undefined, mode()), null);
});

test("resolveCodingNamespaceOverlay: projectScope=false → null (CLAUDE.md #30 escape hatch)", () => {
  const overlay = resolveCodingNamespaceOverlay(ctx(), mode({ projectScope: false }));
  assert.equal(overlay, null, "disabling projectScope must restore pre-#569 behaviour exactly");
});

test("resolveCodingNamespaceOverlay: projectScope=false even with branchScope=true → null", () => {
  const overlay = resolveCodingNamespaceOverlay(
    ctx(),
    mode({ projectScope: false, branchScope: true }),
  );
  assert.equal(overlay, null, "branchScope without projectScope must not apply");
});

test("resolveCodingNamespaceOverlay: empty projectId → null (defensive)", () => {
  const overlay = resolveCodingNamespaceOverlay(ctx({ projectId: "" }), mode());
  assert.equal(overlay, null);
});

// ──────────────────────────────────────────────────────────────────────────
// resolveCodingNamespaceOverlay — project scope
// ──────────────────────────────────────────────────────────────────────────

test("resolveCodingNamespaceOverlay: projectScope=true → project overlay, no fallbacks", () => {
  const overlay = resolveCodingNamespaceOverlay(ctx({ projectId: "origin:deadbeef" }), mode());
  assert.deepEqual(overlay, {
    namespace: "project:origin:deadbeef",
    readFallbacks: [],
    scope: "project",
  });
});

test("resolveCodingNamespaceOverlay: branchScope=true with branch=null → still project scope only", () => {
  const overlay = resolveCodingNamespaceOverlay(
    ctx({ projectId: "origin:aaaa0000", branch: null }),
    mode({ branchScope: true }),
  );
  assert.ok(overlay);
  assert.equal(overlay!.scope, "project");
  assert.equal(overlay!.namespace, "project:origin:aaaa0000");
  assert.deepEqual(overlay!.readFallbacks, []);
});

// ──────────────────────────────────────────────────────────────────────────
// resolveCodingNamespaceOverlay — branch scope (PR 3 preview, but logic is here)
// ──────────────────────────────────────────────────────────────────────────

test("resolveCodingNamespaceOverlay: branchScope=true + branch set → branch overlay with project fallback", () => {
  const overlay = resolveCodingNamespaceOverlay(
    ctx({ projectId: "origin:aaaa0000", branch: "feat/x" }),
    mode({ branchScope: true }),
  );
  assert.ok(overlay);
  assert.equal(overlay!.scope, "branch");
  assert.equal(overlay!.namespace, "project:origin:aaaa0000/branch:feat-x");
  assert.deepEqual(overlay!.readFallbacks, ["project:origin:aaaa0000"]);
});

test("resolveCodingNamespaceOverlay: branchScope=false → no branch layering even with branch set", () => {
  const overlay = resolveCodingNamespaceOverlay(ctx({ branch: "feat/x" }), mode({ branchScope: false }));
  assert.ok(overlay);
  assert.equal(overlay!.scope, "project");
  assert.ok(!overlay!.namespace.includes("branch:"));
});

// ──────────────────────────────────────────────────────────────────────────
// Cross-project isolation invariant (the core requirement of PR 2)
// ──────────────────────────────────────────────────────────────────────────

test("resolveCodingNamespaceOverlay: different projects resolve to different namespaces", () => {
  const a = resolveCodingNamespaceOverlay(ctx({ projectId: "origin:aaaaaaaa" }), mode());
  const b = resolveCodingNamespaceOverlay(ctx({ projectId: "origin:bbbbbbbb" }), mode());
  assert.ok(a && b);
  assert.notEqual(a!.namespace, b!.namespace, "cross-project isolation — different projectIds must map to different namespaces");
});

test("resolveCodingNamespaceOverlay: read path and write path see identical namespace (rule 42)", () => {
  // Simulate the read and write paths in orchestrator consulting the same
  // resolver with the same inputs. They must agree bit-for-bit.
  const input: [CodingContext, CodingModeConfig] = [
    ctx({ projectId: "origin:12345678", branch: "feat/y" }),
    mode({ branchScope: true }),
  ];
  const readOverlay = resolveCodingNamespaceOverlay(input[0], input[1]);
  const writeOverlay = resolveCodingNamespaceOverlay(input[0], input[1]);
  assert.deepEqual(readOverlay, writeOverlay);
});
