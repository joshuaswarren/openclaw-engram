import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const PACKAGES = path.join(ROOT, "packages");

// ---------------------------------------------------------------------------
// Claude Code plugin structure
// ---------------------------------------------------------------------------

test("plugin-claude-code has required plugin manifest", () => {
  const manifest = path.join(PACKAGES, "plugin-claude-code", ".claude-plugin", "plugin.json");
  assert.ok(fs.existsSync(manifest), ".claude-plugin/plugin.json must exist");
  const pkg = JSON.parse(fs.readFileSync(manifest, "utf-8"));
  assert.equal(pkg.name, "remnic");
  assert.ok(pkg.version);
  assert.ok(pkg.description);
});

test("plugin-claude-code has hooks.json with required hook events", () => {
  const hooksFile = path.join(PACKAGES, "plugin-claude-code", "hooks", "hooks.json");
  assert.ok(fs.existsSync(hooksFile), "hooks/hooks.json must exist");
  const { hooks } = JSON.parse(fs.readFileSync(hooksFile, "utf-8"));
  assert.ok(hooks.SessionStart, "SessionStart hook required");
  assert.ok(hooks.PostToolUse, "PostToolUse hook required");
  assert.ok(hooks.UserPromptSubmit, "UserPromptSubmit hook required");
});

test("plugin-claude-code hook scripts are executable", () => {
  const binDir = path.join(PACKAGES, "plugin-claude-code", "hooks", "bin");
  const required = ["session-start.sh", "user-prompt-recall.sh", "post-tool-observe.sh", "session-end.sh"];
  for (const script of required) {
    const scriptPath = path.join(binDir, script);
    assert.ok(fs.existsSync(scriptPath), `${script} must exist`);
    const stat = fs.statSync(scriptPath);
    assert.ok(stat.mode & 0o111, `${script} must be executable`);
  }
});

test("plugin-claude-code has skills", () => {
  const skillsDir = path.join(PACKAGES, "plugin-claude-code", "skills");
  const required = ["remember.md", "recall.md", "search.md", "entities.md", "status.md"];
  for (const skill of required) {
    assert.ok(fs.existsSync(path.join(skillsDir, skill)), `skill ${skill} must exist`);
  }
});

test("plugin-claude-code has .mcp.json", () => {
  const mcpFile = path.join(PACKAGES, "plugin-claude-code", ".mcp.json");
  assert.ok(fs.existsSync(mcpFile));
  const mcp = JSON.parse(fs.readFileSync(mcpFile, "utf-8"));
  assert.ok(mcp.mcpServers?.remnic, "Must define remnic MCP server");
  assert.ok(mcp.mcpServers.remnic.url.includes("4318"), "Must point to RMO port");
});

// ---------------------------------------------------------------------------
// Codex plugin structure
// ---------------------------------------------------------------------------

test("plugin-codex has required plugin manifest", () => {
  const manifest = path.join(PACKAGES, "plugin-codex", ".codex-plugin", "plugin.json");
  assert.ok(fs.existsSync(manifest), ".codex-plugin/plugin.json must exist");
  const pkg = JSON.parse(fs.readFileSync(manifest, "utf-8"));
  assert.equal(pkg.name, "remnic");
});

test("plugin-codex has Stop hook (unique to Codex)", () => {
  const hooksFile = path.join(PACKAGES, "plugin-codex", "hooks", "hooks.json");
  const { hooks } = JSON.parse(fs.readFileSync(hooksFile, "utf-8"));
  assert.ok(hooks.SessionStart, "SessionStart required");
  assert.ok(hooks.PostToolUse, "PostToolUse required");
  assert.ok(hooks.UserPromptSubmit, "UserPromptSubmit required");
  assert.ok(hooks.Stop, "Stop hook required (Codex-specific)");
});

test("plugin-codex hooks use node not python3", () => {
  const binDir = path.join(PACKAGES, "plugin-codex", "hooks", "bin");
  const scripts = fs.readdirSync(binDir).filter((f) => f.endsWith(".sh"));
  for (const script of scripts) {
    const content = fs.readFileSync(path.join(binDir, script), "utf-8");
    assert.ok(!content.includes("python3"), `${script} must not use python3 (use node -e)`);
  }
});

// ---------------------------------------------------------------------------
// Hermes plugin structure (Python)
// ---------------------------------------------------------------------------

test("plugin-hermes has pyproject.toml", () => {
  const pyproject = path.join(PACKAGES, "plugin-hermes", "pyproject.toml");
  assert.ok(fs.existsSync(pyproject));
  const content = fs.readFileSync(pyproject, "utf-8");
  assert.ok(content.includes('name = "remnic-hermes"'));
});

test("plugin-hermes has MemoryProvider module", () => {
  const initPy = path.join(PACKAGES, "plugin-hermes", "remnic_hermes", "__init__.py");
  assert.ok(fs.existsSync(initPy));
  const content = fs.readFileSync(initPy, "utf-8");
  assert.ok(content.includes("RemnicMemoryProvider"), "Must export RemnicMemoryProvider");
  assert.ok(
    content.includes("EngramMemoryProvider"),
    "Must keep the EngramMemoryProvider alias during the compat window",
  );
  assert.ok(content.includes("def register"), "Must have register() entry point");
});

test("plugin-hermes provider implements MemoryProvider protocol", () => {
  const provider = path.join(PACKAGES, "plugin-hermes", "remnic_hermes", "provider.py");
  assert.ok(fs.existsSync(provider));
  const content = fs.readFileSync(provider, "utf-8");
  const requiredMethods = ["pre_llm_call", "sync_turn", "extract_memories", "shutdown", "initialize"];
  for (const method of requiredMethods) {
    assert.ok(content.includes(`async def ${method}`), `Must implement ${method}()`);
  }
});

// ---------------------------------------------------------------------------
// Replit connector structure
// ---------------------------------------------------------------------------

test("connector-replit has setup snippet", () => {
  const snippet = path.join(PACKAGES, "connector-replit", "setup-snippet.json");
  assert.ok(fs.existsSync(snippet));
  const config = JSON.parse(fs.readFileSync(snippet, "utf-8"));
  assert.ok(config.url.includes("4318"));
  assert.ok(config.headers["X-Engram-Client-Id"] === "replit");
});

// ---------------------------------------------------------------------------
// plugin-openclaw backward compatibility
// ---------------------------------------------------------------------------

test("plugin-openclaw publishes under the Remnic scope", () => {
  const pkgJson = path.join(PACKAGES, "plugin-openclaw", "package.json");
  assert.ok(fs.existsSync(pkgJson));
  const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
  assert.equal(pkg.name, "@remnic/plugin-openclaw", "Must use canonical Remnic npm name");
});

// ---------------------------------------------------------------------------
// Daemon service templates
// ---------------------------------------------------------------------------

test("CLI has launchd plist template", () => {
  const plist = path.join(PACKAGES, "remnic-cli", "templates", "launchd", "ai.remnic.daemon.plist");
  assert.ok(fs.existsSync(plist));
  const content = fs.readFileSync(plist, "utf-8");
  assert.ok(content.includes("ai.remnic.daemon"), "Must have correct launchd label");
  assert.ok(content.includes("RunAtLoad"), "Must run at load");
  assert.ok(content.includes("KeepAlive"), "Must keep alive");
});

test("CLI has systemd service template", () => {
  const service = path.join(PACKAGES, "remnic-cli", "templates", "systemd", "remnic.service");
  assert.ok(fs.existsSync(service));
  const content = fs.readFileSync(service, "utf-8");
  assert.ok(content.includes("Remnic Memory Orchestrator"), "Must have description");
  assert.ok(content.includes("Restart=on-failure"), "Must restart on failure");
  assert.ok(content.includes("WantedBy=default.target"), "Must be wanted by default target");
});

// ---------------------------------------------------------------------------
// Server has no root src/ leak
// ---------------------------------------------------------------------------

test("server imports from @remnic/core, not ../../../src/", () => {
  const serverIndex = path.join(PACKAGES, "remnic-server", "src", "index.ts");
  const content = fs.readFileSync(serverIndex, "utf-8");
  assert.ok(!content.includes("../../../src/"), "Must not import from root src/");
  assert.ok(content.includes("@remnic/core"), "Must import from @remnic/core");
});

// ---------------------------------------------------------------------------
// Hook scripts use per-plugin tokens
// ---------------------------------------------------------------------------

test("Claude Code hooks prefer ~/.remnic/tokens.json with Engram fallback", () => {
  const sessionStart = path.join(PACKAGES, "plugin-claude-code", "hooks", "bin", "session-start.sh");
  const content = fs.readFileSync(sessionStart, "utf-8");
  assert.ok(content.includes("tokens.json"), "Must read from token file");
  assert.ok(content.includes(".remnic"), "Must prefer Remnic token path");
  assert.ok(content.includes(".engram"), "Must preserve Engram token fallback");
  assert.ok(content.includes("claude-code"), "Must look for claude-code token key");
  assert.ok(content.includes("X-Engram-Client-Id"), "Must send client ID header");
});

test("Codex hooks prefer ~/.remnic/tokens.json with Engram fallback", () => {
  const sessionStart = path.join(PACKAGES, "plugin-codex", "hooks", "bin", "session-start.sh");
  const content = fs.readFileSync(sessionStart, "utf-8");
  assert.ok(content.includes("tokens.json"), "Must read from token file");
  assert.ok(content.includes(".remnic"), "Must prefer Remnic token path");
  assert.ok(content.includes(".engram"), "Must preserve Engram token fallback");
  assert.ok(content.includes("codex"), "Must look for codex token key");
});
