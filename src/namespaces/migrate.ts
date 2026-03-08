import path from "node:path";
import { access, mkdir, readdir, rename } from "node:fs/promises";
import type { PluginConfig } from "../types.js";
import { NamespaceStorageRouter } from "./storage.js";
import { namespaceCollectionName } from "./search.js";
import { isSafeRouteNamespace } from "../routing/engine.js";

const LEGACY_NAMESPACE_CHILDREN = [
  "facts",
  "corrections",
  "entities",
  "questions",
  "artifacts",
  "identity",
  "state",
  "config",
  "summaries",
  "profile.md",
] as const;

export interface NamespaceInventoryEntry {
  namespace: string;
  rootDir: string;
  exists: boolean;
  usesLegacyRoot: boolean;
  hasMemoryData: boolean;
  collection: string;
}

export interface NamespaceVerifyReport {
  ok: boolean;
  problems: string[];
  namespaces: NamespaceInventoryEntry[];
}

export interface NamespaceMigrationMove {
  from: string;
  to: string;
}

export interface NamespaceMigrationReport {
  dryRun: boolean;
  fromRoot: string;
  targetRoot: string;
  moved: NamespaceMigrationMove[];
  collection: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function hasAnyLegacyData(rootDir: string): Promise<boolean> {
  for (const child of LEGACY_NAMESPACE_CHILDREN) {
    if (await exists(path.join(rootDir, child))) return true;
  }
  return false;
}

async function discoverConfiguredNamespaces(
  config: PluginConfig,
): Promise<string[]> {
  const discovered = new Set<string>([
    config.defaultNamespace,
    config.sharedNamespace,
    ...config.namespacePolicies.map((policy) => policy.name),
  ]);

  const namespacesDir = path.join(config.memoryDir, "namespaces");
  try {
    const entries = await readdir(namespacesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && isSafeRouteNamespace(entry.name)) {
        discovered.add(entry.name);
      }
    }
  } catch {
    // No namespace directory yet.
  }

  return [...discovered];
}

export async function listNamespaces(options: {
  config: PluginConfig;
  storageRouter?: NamespaceStorageRouter;
}): Promise<NamespaceInventoryEntry[]> {
  const storageRouter = options.storageRouter ?? new NamespaceStorageRouter(options.config);
  const namespaces = await discoverConfiguredNamespaces(options.config);
  const items = await Promise.all(
    namespaces.map(async (namespace) => {
      const storage = await storageRouter.storageFor(namespace);
      const usesLegacyRoot =
        namespace === options.config.defaultNamespace &&
        storage.dir === options.config.memoryDir;
      return {
        namespace,
        rootDir: storage.dir,
        exists: await exists(storage.dir),
        usesLegacyRoot,
        hasMemoryData: await hasAnyLegacyData(storage.dir),
        collection: namespaceCollectionName(options.config.qmdCollection, namespace, {
          defaultNamespace: options.config.defaultNamespace,
          useLegacyDefaultCollection: usesLegacyRoot,
        }),
      } satisfies NamespaceInventoryEntry;
    }),
  );

  return items.sort((a, b) => a.namespace.localeCompare(b.namespace));
}

export async function verifyNamespaces(options: {
  config: PluginConfig;
  storageRouter?: NamespaceStorageRouter;
}): Promise<NamespaceVerifyReport> {
  const namespaces = await listNamespaces(options);
  const problems: string[] = [];

  for (const entry of namespaces) {
    if (entry.exists && !entry.hasMemoryData) {
      problems.push(`${entry.namespace}: root exists but contains no Engram data`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    namespaces,
  };
}

export async function runNamespaceMigration(options: {
  config: PluginConfig;
  to: string;
  dryRun?: boolean;
}): Promise<NamespaceMigrationReport> {
  if (!options.config.namespacesEnabled) {
    throw new Error("Namespaces are disabled.");
  }

  const targetNamespace = options.to.trim();
  if (!isSafeRouteNamespace(targetNamespace)) {
    throw new Error(`Invalid namespace: ${options.to}`);
  }

  const targetRoot = path.join(options.config.memoryDir, "namespaces", targetNamespace);
  const moved: NamespaceMigrationMove[] = [];

  for (const child of LEGACY_NAMESPACE_CHILDREN) {
    const from = path.join(options.config.memoryDir, child);
    if (!(await exists(from))) continue;
    const to = path.join(targetRoot, child);
    if (await exists(to)) {
      throw new Error(`Target already contains ${child}: ${to}`);
    }
    moved.push({ from, to });
  }

  if (!options.dryRun && moved.length > 0) {
    await mkdir(targetRoot, { recursive: true });
    for (const move of moved) {
      await rename(move.from, move.to);
    }
  }

  return {
    dryRun: options.dryRun === true,
    fromRoot: options.config.memoryDir,
    targetRoot,
    moved,
    collection: namespaceCollectionName(options.config.qmdCollection, targetNamespace, {
      defaultNamespace: options.config.defaultNamespace,
      useLegacyDefaultCollection: false,
    }),
  };
}
