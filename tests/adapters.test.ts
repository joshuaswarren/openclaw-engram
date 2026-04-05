import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { ReplitAdapter } from "../src/adapters/replit.js";
import { HermesAdapter } from "../src/adapters/hermes.js";

test("AdapterRegistry returns null when no adapter matches", () => {
  const registry = new AdapterRegistry();
  const result = registry.resolve({ headers: {} });
  assert.equal(result, null);
});

test("ClaudeCodeAdapter matches on client info containing 'claude'", () => {
  const adapter = new ClaudeCodeAdapter();
  assert.equal(adapter.matches({ headers: {}, clientInfo: { name: "claude-code", version: "1.0" } }), true);
  assert.equal(adapter.matches({ headers: {} }), false);
});

test("ClaudeCodeAdapter matches on X-Claude-Session-Id header", () => {
  const adapter = new ClaudeCodeAdapter();
  assert.equal(adapter.matches({ headers: { "x-claude-session-id": "sess-abc" } }), true);
});

test("ClaudeCodeAdapter resolves project path to namespace", () => {
  const adapter = new ClaudeCodeAdapter();
  const identity = adapter.resolveIdentity({
    headers: {
      "x-claude-session-id": "sess-abc",
      "x-claude-project-path": "/Users/dev/my-project",
    },
    clientInfo: { name: "claude-code" },
  });
  assert.equal(identity.adapterId, "claude-code");
  assert.equal(identity.namespace, "users-dev-my-project");
  assert.equal(identity.principal, "claude-code");
  assert.equal(identity.sessionKey, "sess-abc");
});

test("CodexAdapter matches on client info containing 'codex'", () => {
  const adapter = new CodexAdapter();
  assert.equal(adapter.matches({ headers: {}, clientInfo: { name: "codex-cli" } }), true);
  assert.equal(adapter.matches({ headers: {} }), false);
});

test("CodexAdapter matches on X-Codex-Agent-Name header", () => {
  const adapter = new CodexAdapter();
  assert.equal(adapter.matches({ headers: { "x-codex-agent-name": "project-manager" } }), true);
});

test("CodexAdapter resolves agent name to principal", () => {
  const adapter = new CodexAdapter();
  const identity = adapter.resolveIdentity({
    headers: { "x-codex-agent-name": "project-manager", "x-codex-project-dir": "/src/my-app" },
  });
  assert.equal(identity.adapterId, "codex");
  assert.equal(identity.namespace, "src-my-app");
  assert.equal(identity.principal, "project-manager");
});

test("ReplitAdapter matches on X-Replit-Project-Id header", () => {
  const adapter = new ReplitAdapter();
  assert.equal(adapter.matches({ headers: { "x-replit-project-id": "proj-123" } }), true);
  assert.equal(adapter.matches({ headers: {} }), false);
});

test("ReplitAdapter resolves project ID to namespace", () => {
  const adapter = new ReplitAdapter();
  const identity = adapter.resolveIdentity({
    headers: { "x-replit-project-id": "proj-123", "x-replit-user-id": "user-456" },
  });
  assert.equal(identity.adapterId, "replit");
  assert.equal(identity.namespace, "replit-proj-123");
  assert.equal(identity.principal, "replit-user-user-456");
});

test("HermesAdapter matches on X-Hermes-Session-Id header", () => {
  const adapter = new HermesAdapter();
  assert.equal(adapter.matches({ headers: { "x-hermes-session-id": "herm-abc" } }), true);
  assert.equal(adapter.matches({ headers: {} }), false);
});

test("HermesAdapter matches on X-Hermes-Profile header", () => {
  const adapter = new HermesAdapter();
  assert.equal(adapter.matches({ headers: { "x-hermes-profile": "research-agent" } }), true);
});

test("HermesAdapter resolves profile to namespace", () => {
  const adapter = new HermesAdapter();
  const identity = adapter.resolveIdentity({
    headers: { "x-hermes-session-id": "herm-abc", "x-hermes-profile": "Research Agent" },
  });
  assert.equal(identity.adapterId, "hermes");
  assert.equal(identity.namespace, "research-agent");
  assert.equal(identity.principal, "Research Agent");
  assert.equal(identity.sessionKey, "herm-abc");
});

test("AdapterRegistry resolves first matching adapter (Hermes before Claude Code)", () => {
  const registry = new AdapterRegistry();
  const result = registry.resolve({
    headers: { "x-hermes-session-id": "herm-abc" },
    clientInfo: { name: "claude-code" },
  });
  assert.equal(result?.adapterId, "hermes");
});

test("AdapterRegistry lists registered adapter IDs", () => {
  const registry = new AdapterRegistry();
  const ids = registry.list();
  assert.deepEqual(ids, ["hermes", "replit", "codex", "claude-code"]);
});

test("X-Engram-Principal header overrides adapter-resolved principal", () => {
  const adapter = new ClaudeCodeAdapter();
  const identity = adapter.resolveIdentity({
    headers: {
      "x-claude-session-id": "sess-abc",
      "x-engram-principal": "custom-principal",
    },
    clientInfo: { name: "claude-code" },
  });
  assert.equal(identity.principal, "custom-principal");
});
