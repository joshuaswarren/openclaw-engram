#!/usr/bin/env node
/**
 * CLI entrypoint for @remnic/connector-weclone.
 *
 * Reads config from ~/.remnic/connectors/weclone.json (or --config path)
 * and starts the OpenAI-compatible memory proxy.
 */

import { createWeCloneProxy } from "./proxy.js";
import { parseConfig } from "./config.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
let configPath = resolve(homedir(), ".remnic/connectors/weclone.json");

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--config") {
    if (!args[i + 1]) {
      console.error("Error: --config requires a path argument");
      process.exit(1);
    }
    configPath = resolve(args[i + 1]);
    i++;
  }
}

if (!existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  console.error("Run: remnic connectors install weclone");
  process.exit(1);
}

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(configPath, "utf-8"));
} catch (err) {
  console.error(`Failed to parse config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (typeof raw !== "object" || raw === null) {
  console.error(`Config at ${configPath} must be a JSON object`);
  process.exit(1);
}

const config = parseConfig(raw);
const proxy = createWeCloneProxy(config);

proxy.start().then(() => {
  console.log(`WeClone memory proxy listening on :${config.proxyPort}`);
  console.log(`  WeClone API: ${config.wecloneApiUrl}`);
  console.log(`  Remnic daemon: ${config.remnicDaemonUrl}`);
});

process.on("SIGINT", () => {
  proxy.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  proxy.stop();
  process.exit(0);
});
