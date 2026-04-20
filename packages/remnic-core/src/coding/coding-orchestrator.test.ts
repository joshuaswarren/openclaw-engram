/**
 * Integration tests for the orchestrator's coding-namespace overlay surface
 * (issue #569 PR 2).
 *
 * These tests use `Object.create(Orchestrator.prototype)` to exercise the
 * overlay helpers in isolation — no storage, no extraction. The end-to-end
 * contract being verified:
 *
 *   1. A session without a coding context gets the default namespace.
 *   2. A session with a coding context + `codingMode.projectScope: true`
 *      gets a `project:<id>` overlay on both read and write paths.
 *   3. Disabling `codingMode.projectScope: false` exactly restores the
 *      default namespace (CLAUDE.md #30 escape hatch).
 *   4. Rule 42 invariant: read-path overlay and write-path overlay return
 *      the same namespace for the same session + context.
 *   5. Isolation: two sessions on different projects resolve to different
 *      namespaces — cross-project leakage cannot occur at the routing layer.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Orchestrator } from "../orchestrator.js";
import type { CodingContext, CodingModeConfig, PluginConfig } from "../types.js";

// ──────────────────────────────────────────────────────────────────────────
// Minimal orchestrator stub
// ──────────────────────────────────────────────────────────────────────────

type OrchestratorLike = {
  config: PluginConfig;
  // The private map on the real orchestrator — we mirror its name so the
  // methods under test read from the same slot.
  _codingContextBySession: Map<string, CodingContext>;
  setCodingContextForSession: Orchestrator["setCodingContextForSession"];
  getCodingContextForSession: Orchestrator["getCodingContextForSession"];
  applyCodingNamespaceOverlay: Orchestrator["applyCodingNamespaceOverlay"];
  applyCodingRecallOverlay: Orchestrator["applyCodingRecallOverlay"];
  resolveSelfNamespace: Orchestrator["resolveSelfNamespace"];
  resolvePrincipal: Orchestrator["resolvePrincipal"];
};

function makeOrchestrator(codingMode: Partial<CodingModeConfig> = {}): OrchestratorLike {
  const orch = Object.create(Orchestrator.prototype) as OrchestratorLike;
  orch._codingContextBySession = new Map<string, CodingContext>();
  // Minimal PluginConfig — only the fields the overlay path reads.
  orch.config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    defaultRecallNamespaces: ["self", "shared"],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    codingMode: {
      projectScope: true,
      branchScope: false,
      ...codingMode,
    },
  } as unknown as PluginConfig;
  return orch;
}

function contextFor(projectId: string, branch: string | null = "main"): CodingContext {
  return {
    projectId,
    branch,
    rootPath: `/work/${projectId}`,
    defaultBranch: "main",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Basic setters / getters
// ──────────────────────────────────────────────────────────────────────────

test("setCodingContextForSession: stores context; getCodingContextForSession returns it", () => {
  const orch = makeOrchestrator();
  const ctx = contextFor("origin:a1");
  orch.setCodingContextForSession("session-A", ctx);
  assert.deepEqual(orch.getCodingContextForSession("session-A"), ctx);
});

test("setCodingContextForSession: null clears the context", () => {
  const orch = makeOrchestrator();
  orch.setCodingContextForSession("session-A", contextFor("origin:a1"));
  orch.setCodingContextForSession("session-A", null);
  assert.equal(orch.getCodingContextForSession("session-A"), null);
});

test("getCodingContextForSession: missing session returns null", () => {
  const orch = makeOrchestrator();
  assert.equal(orch.getCodingContextForSession("unknown"), null);
});

test("setCodingContextForSession: empty sessionKey is a no-op (defensive)", () => {
  const orch = makeOrchestrator();
  orch.setCodingContextForSession("", contextFor("origin:a1"));
  assert.equal(orch._codingContextBySession.size, 0);
});

// ──────────────────────────────────────────────────────────────────────────
// Overlay on write path
// ──────────────────────────────────────────────────────────────────────────

test("applyCodingNamespaceOverlay: returns base unchanged when no context attached", () => {
  const orch = makeOrchestrator();
  assert.equal(orch.applyCodingNamespaceOverlay("session-A", "default"), "default");
});

test("applyCodingNamespaceOverlay: returns project overlay when context is set and projectScope on", () => {
  const orch = makeOrchestrator();
  orch.setCodingContextForSession("session-A", contextFor("origin:abcdef12"));
  assert.equal(
    orch.applyCodingNamespaceOverlay("session-A", "default"),
    "project:origin:abcdef12",
  );
});

test("applyCodingNamespaceOverlay: projectScope=false returns base unchanged (escape hatch)", () => {
  const orch = makeOrchestrator({ projectScope: false });
  orch.setCodingContextForSession("session-A", contextFor("origin:abcdef12"));
  assert.equal(
    orch.applyCodingNamespaceOverlay("session-A", "default"),
    "default",
    "codingMode.projectScope=false must exactly restore pre-#569 behaviour",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Overlay on read path
// ──────────────────────────────────────────────────────────────────────────

test("applyCodingRecallOverlay: no context → null (caller uses its existing namespaces)", () => {
  const orch = makeOrchestrator();
  assert.equal(orch.applyCodingRecallOverlay("session-A"), null);
});

test("applyCodingRecallOverlay: project context → overlay with empty fallbacks", () => {
  const orch = makeOrchestrator();
  orch.setCodingContextForSession("session-A", contextFor("origin:aaaaaaaa"));
  const overlay = orch.applyCodingRecallOverlay("session-A");
  assert.deepEqual(overlay, { namespace: "project:origin:aaaaaaaa", readFallbacks: [] });
});

test("applyCodingRecallOverlay: projectScope=false → null (escape hatch)", () => {
  const orch = makeOrchestrator({ projectScope: false });
  orch.setCodingContextForSession("session-A", contextFor("origin:aaaaaaaa"));
  assert.equal(orch.applyCodingRecallOverlay("session-A"), null);
});

// ──────────────────────────────────────────────────────────────────────────
// Rule 42 — read path and write path agree (bit-for-bit)
// ──────────────────────────────────────────────────────────────────────────

test("CLAUDE.md #42: read and write paths resolve the same namespace for the same session", () => {
  const orch = makeOrchestrator();
  orch.setCodingContextForSession("session-A", contextFor("origin:deadbeef"));

  const writeNs = orch.applyCodingNamespaceOverlay("session-A", "default");
  const recallOverlay = orch.applyCodingRecallOverlay("session-A");
  assert.ok(recallOverlay);
  assert.equal(writeNs, recallOverlay!.namespace);
});

// ──────────────────────────────────────────────────────────────────────────
// Isolation invariant — two projects, two namespaces
// ──────────────────────────────────────────────────────────────────────────

test("two sessions on different projects resolve to different namespaces (no cross-project leakage)", () => {
  const orch = makeOrchestrator();
  orch.setCodingContextForSession("session-A", contextFor("origin:11111111"));
  orch.setCodingContextForSession("session-B", contextFor("origin:22222222"));

  const nsA = orch.applyCodingNamespaceOverlay("session-A", "default");
  const nsB = orch.applyCodingNamespaceOverlay("session-B", "default");
  assert.notEqual(nsA, nsB);
  assert.equal(nsA, "project:origin:11111111");
  assert.equal(nsB, "project:origin:22222222");
});
