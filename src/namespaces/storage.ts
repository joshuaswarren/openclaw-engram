import path from "node:path";
import { access } from "node:fs/promises";
import { StorageManager } from "../storage.js";
import type { PluginConfig } from "../types.js";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Storage routing for namespaces.
 *
 * Compatibility note:
 * - When namespaces are enabled, non-default namespaces live under `memoryDir/namespaces/<ns>`.
 * - The default namespace continues to use the legacy `memoryDir` root unless the caller
 *   has created `memoryDir/namespaces/<defaultNamespace>` (in which case we use that).
 *
 * This avoids surprising "lost memories" when an install flips namespaces on without
 * migrating existing data.
 */
export class NamespaceStorageRouter {
  private readonly cache = new Map<string, StorageManager>();
  private defaultNsRootResolved: string | null = null;

  constructor(private readonly config: PluginConfig) {}

  private async defaultNamespaceRoot(): Promise<string> {
    if (this.defaultNsRootResolved) return this.defaultNsRootResolved;
    if (!this.config.namespacesEnabled) {
      this.defaultNsRootResolved = this.config.memoryDir;
      return this.defaultNsRootResolved;
    }

    const nsDir = path.join(this.config.memoryDir, "namespaces", this.config.defaultNamespace);
    this.defaultNsRootResolved = (await exists(nsDir)) ? nsDir : this.config.memoryDir;
    return this.defaultNsRootResolved;
  }

  private namespaceRootSync(namespace: string): string {
    // NOTE: only used after defaultNamespaceRoot() resolution.
    if (!this.config.namespacesEnabled) return this.config.memoryDir;
    if (namespace === this.config.defaultNamespace) {
      return this.defaultNsRootResolved ?? this.config.memoryDir;
    }
    return path.join(this.config.memoryDir, "namespaces", namespace);
  }

  async storageFor(namespace: string): Promise<StorageManager> {
    const ns = namespace || this.config.defaultNamespace;
    if (this.cache.has(ns)) return this.cache.get(ns)!;

    if (ns === this.config.defaultNamespace) {
      await this.defaultNamespaceRoot();
    }

    const root = this.namespaceRootSync(ns);
    const sm = new StorageManager(root);
    this.cache.set(ns, sm);
    return sm;
  }
}

