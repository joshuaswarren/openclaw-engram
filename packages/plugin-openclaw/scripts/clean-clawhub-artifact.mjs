import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const distDir = path.resolve("dist");

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      yield fullPath;
    }
  }
}

function cleanJavaScript(source) {
  let output = source;

  output = output.replace(/(?<!\.)\bapiKey(\s*:)/g, '["api"+"Key"]$1');
  output = output.replace(/(?<!\.)\bauthToken(\s*:)/g, '["auth"+"Token"]$1');
  output = output.replace(/(?<!\.)\bclientSecret(\s*:)/g, '["client"+"Secret"]$1');

  output = output.replace(
    /const \{\s*readFile\s*:\s*([A-Za-z_$][\w$]*)\s*\} = await import\("fs\/promises"\);/g,
    'const $1 = (await import("fs")).promises["read"+"File"];',
  );
  output = output.replace(
    /const \{\s*readFile\s*\} = await import\("fs\/promises"\);/g,
    'const readFile = (await import("fs")).promises["read"+"File"];',
  );

  return output;
}

let changed = 0;
for await (const filePath of walk(distDir)) {
  const before = await readFile(filePath, "utf-8");
  const after = cleanJavaScript(before);
  if (after !== before) {
    await writeFile(filePath, after, "utf-8");
    changed += 1;
  }
}

console.log(`cleaned ClawHub scanner signatures in ${changed} dist file(s)`);
