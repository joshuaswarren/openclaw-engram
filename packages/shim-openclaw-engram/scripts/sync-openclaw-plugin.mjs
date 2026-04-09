import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
const source = path.resolve(pkgDir, "../plugin-openclaw/openclaw.plugin.json");
const target = path.resolve(pkgDir, "openclaw.plugin.json");

await copyFile(source, target);
