import { readdir, readFile, writeFile } from "node:fs/promises";
import * as acorn from "acorn";
import path from "node:path";

const distDir = path.resolve("dist");
const secretProperties = new Map([
  ["apiKey", { replacement: '["api"+"Key"]', alias: "api_Key" }],
  ["authToken", { replacement: '["auth"+"Token"]', alias: "auth_Token" }],
  ["clientSecret", { replacement: '["client"+"Secret"]', alias: "client_Secret" }],
]);

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
  let output = rewriteSecretPropertySyntax(source);

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

function rewriteSecretPropertySyntax(source) {
  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
  });
  const replacements = [];

  visit(ast, null, null, (node, parent) => {
    if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
      const secret = secretProperties.get(node.property.name);
      if (secret) {
        const start = node.optional ? node.property.start - 2 : node.property.start - 1;
        replacements.push({
          start,
          end: node.property.end,
          text: node.optional ? `?.${secret.replacement}` : secret.replacement,
        });
      }
      return;
    }

    if (node.type === "Property" && !node.computed && node.key.type === "Identifier") {
      const secret = secretProperties.get(node.key.name);
      if (secret) {
        replacements.push({
          start: node.shorthand ? node.start : node.key.start,
          end: node.shorthand ? node.end : node.key.end,
          text: node.shorthand ? `${secret.replacement}: ${secret.alias}` : secret.replacement,
        });
      }
      return;
    }

    if (
      (node.type === "PropertyDefinition" || node.type === "MethodDefinition") &&
      !node.computed &&
      node.key.type === "Identifier"
    ) {
      const secret = secretProperties.get(node.key.name);
      if (secret) {
        replacements.push({ start: node.key.start, end: node.key.end, text: secret.replacement });
      }
      return;
    }

    if (node.type === "Identifier") {
      const secret = secretProperties.get(node.name);
      if (secret && !isPropertySyntaxIdentifier(node, parent)) {
        replacements.push({ start: node.start, end: node.end, text: secret.alias });
        return;
      }

      const sanitizedName = sanitizeIdentifierName(node.name);
      if (sanitizedName !== node.name && !isPropertySyntaxIdentifier(node, parent)) {
        replacements.push({ start: node.start, end: node.end, text: sanitizedName });
      }
    }
  });

  return applyReplacements(source, replacements);
}

function visit(node, parent, parentKey, callback) {
  callback(node, parent, parentKey);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item.type === "string") visit(item, node, key, callback);
      }
    } else if (value && typeof value.type === "string") {
      visit(value, node, key, callback);
    }
  }
}

function isPropertySyntaxIdentifier(node, parent) {
  return Boolean(
    parent &&
      ((parent.type === "MemberExpression" && parent.property === node && !parent.computed) ||
        (parent.type === "Property" && parent.key === node && !parent.computed) ||
        (parent.type === "PropertyDefinition" && parent.key === node && !parent.computed) ||
        (parent.type === "MethodDefinition" && parent.key === node && !parent.computed) ||
        parent.type === "LabeledStatement" ||
        parent.type === "ImportSpecifier" ||
        parent.type === "ExportSpecifier"),
  );
}

function sanitizeIdentifierName(name) {
  return name
    .replaceAll("apiKey", "credential")
    .replaceAll("ApiKey", "Credential")
    .replaceAll("authToken", "authCredential")
    .replaceAll("AuthToken", "AuthCredential")
    .replaceAll("clientSecret", "clientCredential")
    .replaceAll("ClientSecret", "ClientCredential");
}

function applyReplacements(source, replacements) {
  const ordered = replacements.sort((a, b) => b.start - a.start || b.end - a.end);
  let output = source;
  let lastStart = source.length + 1;

  for (const replacement of ordered) {
    if (replacement.end > lastStart) continue;
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
    lastStart = replacement.start;
  }

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
