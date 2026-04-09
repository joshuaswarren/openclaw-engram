import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  migrateFromEngram,
  rollbackFromEngramMigration,
} from "../src/migrate/from-engram.js";

async function makeTempHome(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("migrateFromEngram returns fresh-install when no legacy Engram state exists", async () => {
  const homeDir = await makeTempHome("remnic-migrate-fresh-");

  const result = await migrateFromEngram({
    homeDir,
    cwd: homeDir,
    quiet: true,
  });

  assert.equal(result.status, "fresh-install");
  assert.deepEqual(result.copied, []);
  assert.equal(result.tokensRegenerated, 0);
  assert.equal(existsSync(path.join(homeDir, ".remnic", ".migrated-from-engram")), false);
});

test("migrateFromEngram copies legacy state, rewrites tokens, updates connector config, and installs remnic service files", async () => {
  const homeDir = await makeTempHome("remnic-migrate-legacy-");
  const cwd = path.join(homeDir, "repo");
  const claudeConfig = path.join(cwd, "packages", "plugin-claude-code", ".mcp.json");
  const codexConfig = path.join(cwd, "packages", "plugin-codex", ".mcp.json");
  const legacyRoot = path.join(homeDir, ".engram");
  const legacyConfig = path.join(homeDir, ".config", "engram", "config.json");
  const legacyLaunchAgent = path.join(homeDir, "Library", "LaunchAgents", "ai.engram.daemon.plist");
  const execCalls: Array<{ command: string; args: string[] }> = [];

  await mkdir(path.join(legacyRoot, "logs"), { recursive: true });
  await mkdir(path.dirname(legacyConfig), { recursive: true });
  await mkdir(path.dirname(claudeConfig), { recursive: true });
  await mkdir(path.dirname(codexConfig), { recursive: true });
  await mkdir(path.dirname(legacyLaunchAgent), { recursive: true });

  await writeFile(
    path.join(legacyRoot, "tokens.json"),
    JSON.stringify({
      tokens: [
        { connector: "claude-code", token: "engram_cc_abc123", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }),
    "utf8",
  );
  await writeFile(path.join(legacyRoot, "logs", "daemon.log"), "legacy log\n", "utf8");
  await writeFile(
    legacyConfig,
    JSON.stringify({
      engram: {
        memoryDir: path.join(homeDir, ".engram", "memory"),
      },
    }),
    "utf8",
  );
  await writeFile(
    claudeConfig,
    JSON.stringify({
      mcpServers: {
        engram: {
          headers: {
            Authorization: "Bearer {{ENGRAM_TOKEN}}",
            "X-Engram-Client-Id": "claude-code",
          },
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    codexConfig,
    JSON.stringify({
      mcpServers: {
        engram: {
          headers: {
            Authorization: "Bearer {{ENGRAM_TOKEN}}",
            "X-Engram-Client-Id": "codex",
          },
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    legacyLaunchAgent,
    [
      "<plist>",
      "<string>ai.engram.daemon</string>",
      "<string>~/.engram/server.log</string>",
      "<key>ENGRAM_CONFIG_PATH</key>",
      "</plist>",
    ].join("\n"),
    "utf8",
  );

  const result = await migrateFromEngram({
    homeDir,
    cwd,
    quiet: true,
    platform: "darwin",
    connectorConfigPaths: [claudeConfig, codexConfig],
    execCommand: (command, args) => execCalls.push({ command, args }),
  });

  assert.equal(result.status, "migrated");
  assert.equal(result.tokensRegenerated, 1);
  assert.ok(existsSync(path.join(homeDir, ".remnic", ".migrated-from-engram")));
  assert.ok(existsSync(path.join(homeDir, ".remnic", ".rollback.json")));
  assert.ok(existsSync(path.join(homeDir, ".remnic", "logs", "daemon.log")));
  assert.ok(existsSync(path.join(homeDir, ".config", "remnic", "config.json")));
  assert.ok(existsSync(path.join(homeDir, "Library", "LaunchAgents", "ai.remnic.daemon.plist")));
  assert.deepEqual(result.servicesReinstalled, ["ai.remnic.daemon"]);

  const tokens = JSON.parse(await readFile(path.join(homeDir, ".remnic", "tokens.json"), "utf8")) as {
    tokens: Array<{ token: string }>;
  };
  assert.equal(tokens.tokens[0]?.token, "remnic_cc_abc123");

  const migratedConfig = JSON.parse(await readFile(path.join(homeDir, ".config", "remnic", "config.json"), "utf8")) as {
    remnic?: { memoryDir?: string };
  };
  assert.equal(migratedConfig.remnic?.memoryDir, path.join(homeDir, ".remnic", "memory"));

  const claude = JSON.parse(await readFile(claudeConfig, "utf8")) as {
    mcpServers: Record<string, { headers: { Authorization: string } }>;
  };
  assert.ok(claude.mcpServers.remnic);
  assert.equal(claude.mcpServers.remnic.headers.Authorization, "Bearer {{REMNIC_TOKEN}}");
  assert.equal(claude.mcpServers.engram, undefined);

  const remnicLaunchAgent = await readFile(
    path.join(homeDir, "Library", "LaunchAgents", "ai.remnic.daemon.plist"),
    "utf8",
  );
  assert.match(remnicLaunchAgent, /ai\.remnic\.daemon/);
  assert.match(remnicLaunchAgent, /\.remnic\/server\.log/);
  assert.match(remnicLaunchAgent, /REMNIC_CONFIG_PATH/);

  assert.deepEqual(
    execCalls.map((entry) => [entry.command, ...entry.args]),
    [
      ["launchctl", "unload", legacyLaunchAgent],
      ["launchctl", "load", "-w", path.join(homeDir, "Library", "LaunchAgents", "ai.remnic.daemon.plist")],
    ],
  );
});

test("migrateFromEngram is idempotent after the marker is written", async () => {
  const homeDir = await makeTempHome("remnic-migrate-idempotent-");

  await mkdir(path.join(homeDir, ".engram"), { recursive: true });
  await writeFile(path.join(homeDir, ".engram", "tokens.json"), JSON.stringify({ tokens: [] }), "utf8");

  const first = await migrateFromEngram({ homeDir, cwd: homeDir, quiet: true });
  const second = await migrateFromEngram({ homeDir, cwd: homeDir, quiet: true });

  assert.equal(first.status, "migrated");
  assert.equal(second.status, "already-migrated");
});

test("rollbackFromEngramMigration restores backed up connector configs and removes created service files", async () => {
  const homeDir = await makeTempHome("remnic-migrate-rollback-");
  const cwd = path.join(homeDir, "repo");
  const claudeConfig = path.join(cwd, "packages", "plugin-claude-code", ".mcp.json");
  const legacyRoot = path.join(homeDir, ".engram");
  const legacyLaunchAgent = path.join(homeDir, "Library", "LaunchAgents", "ai.engram.daemon.plist");
  const remnicLaunchAgent = path.join(homeDir, "Library", "LaunchAgents", "ai.remnic.daemon.plist");
  const execCalls: Array<{ command: string; args: string[] }> = [];

  await mkdir(path.join(legacyRoot, "logs"), { recursive: true });
  await mkdir(path.dirname(claudeConfig), { recursive: true });
  await mkdir(path.dirname(legacyLaunchAgent), { recursive: true });
  await writeFile(
    path.join(legacyRoot, "tokens.json"),
    JSON.stringify({ tokens: [{ connector: "claude-code", token: "engram_cc_rollback", createdAt: "2026-04-08T00:00:00.000Z" }] }),
    "utf8",
  );
  await writeFile(
    claudeConfig,
    JSON.stringify({
      mcpServers: {
        engram: {
          headers: {
            Authorization: "Bearer {{ENGRAM_TOKEN}}",
          },
        },
      },
    }),
    "utf8",
  );
  await writeFile(legacyLaunchAgent, "<plist>ai.engram.daemon</plist>", "utf8");

  await migrateFromEngram({
    homeDir,
    cwd,
    quiet: true,
    platform: "darwin",
    connectorConfigPaths: [claudeConfig],
    execCommand: () => undefined,
  });

  const rollback = await rollbackFromEngramMigration({
    homeDir,
    quiet: true,
    platform: "darwin",
    execCommand: (command, args) => execCalls.push({ command, args }),
  });

  assert.ok(rollback.restored.includes(claudeConfig));
  assert.ok(rollback.removed.includes(remnicLaunchAgent));
  assert.equal(existsSync(path.join(homeDir, ".remnic", ".migrated-from-engram")), false);
  assert.deepEqual(execCalls, [{ command: "launchctl", args: ["unload", remnicLaunchAgent] }]);

  const restoredClaudeConfig = JSON.parse(await readFile(claudeConfig, "utf8")) as {
    mcpServers: Record<string, unknown>;
  };
  assert.ok(restoredClaudeConfig.mcpServers.engram);
  assert.equal(restoredClaudeConfig.mcpServers.remnic, undefined);
});

test("rollbackFromEngramMigration reloads systemd after removing migrated unit files", async () => {
  const homeDir = await makeTempHome("remnic-migrate-linux-rollback-");
  const cwd = path.join(homeDir, "repo");
  const legacyRoot = path.join(homeDir, ".engram");
  const legacyUnit = path.join(homeDir, ".config", "systemd", "user", "engram.service");
  const remnicUnit = path.join(homeDir, ".config", "systemd", "user", "remnic.service");
  const execCalls: Array<{ command: string; args: string[] }> = [];

  await mkdir(legacyRoot, { recursive: true });
  await mkdir(path.dirname(legacyUnit), { recursive: true });
  await writeFile(path.join(legacyRoot, "tokens.json"), JSON.stringify({ tokens: [] }), "utf8");
  await writeFile(legacyUnit, "[Unit]\nDescription=engram.service\n", "utf8");

  await migrateFromEngram({
    homeDir,
    cwd,
    quiet: true,
    platform: "linux",
    execCommand: () => undefined,
  });

  const rollback = await rollbackFromEngramMigration({
    homeDir,
    quiet: true,
    platform: "linux",
    execCommand: (command, args) => execCalls.push({ command, args }),
  });

  assert.ok(rollback.removed.includes(remnicUnit));
  assert.equal(existsSync(remnicUnit), false);
  assert.deepEqual(execCalls, [
    { command: "systemctl", args: ["--user", "stop", "remnic.service"] },
    { command: "systemctl", args: ["--user", "disable", "remnic.service"] },
    { command: "systemctl", args: ["--user", "daemon-reload"] },
  ]);
});
