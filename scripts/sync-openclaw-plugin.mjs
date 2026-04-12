import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const source = path.resolve(
  repoRoot,
  "packages",
  "plugin-openclaw",
  "openclaw.plugin.json",
);
const target = path.resolve(repoRoot, "openclaw.plugin.json");

const raw = await readFile(source, "utf-8");
await writeFile(target, `${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
