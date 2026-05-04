import assert from "node:assert/strict";
import test from "node:test";
import { NamespaceSearchRouter } from "./search.js";
import type { SearchBackend } from "../search/port.js";
import type { PluginConfig, QmdSearchResult } from "../types.js";

class FakeBackend implements SearchBackend {
  updates = 0;

  constructor(private readonly globalUpdate: boolean) {}

  async probe(): Promise<boolean> {
    return true;
  }

  isAvailable(): boolean {
    return true;
  }

  debugStatus(): string {
    return "fake";
  }

  async search(): Promise<QmdSearchResult[]> {
    return [];
  }

  async searchGlobal(): Promise<QmdSearchResult[]> {
    return [];
  }

  async bm25Search(): Promise<QmdSearchResult[]> {
    return [];
  }

  async vectorSearch(): Promise<QmdSearchResult[]> {
    return [];
  }

  async hybridSearch(): Promise<QmdSearchResult[]> {
    return [];
  }

  async update(): Promise<void> {
    this.updates += 1;
  }

  async updateCollection(): Promise<void> {}

  updatesAllCollections(): boolean {
    return this.globalUpdate;
  }

  async embed(): Promise<void> {}

  async embedCollection(): Promise<void> {}

  async ensureCollection(): Promise<"present"> {
    return "present";
  }
}

function config(): PluginConfig {
  return {
    qmdCollection: "openclaw-engram",
    defaultNamespace: "main",
    qmdMaxResults: 10,
  } as PluginConfig;
}

test("updateNamespaces runs a global-update backend only once", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(true);
      created.push(backend);
      return backend;
    },
  );

  const updated = await router.updateNamespaces(["main", "shared", "main", "project"]);

  assert.equal(updated, 1);
  assert.equal(created.reduce((sum, backend) => sum + backend.updates, 0), 1);
});

test("updateNamespaces still updates every namespace for scoped backends", async () => {
  const created: FakeBackend[] = [];
  const router = new NamespaceSearchRouter(
    config(),
    { storageFor: async (namespace: string) => ({ dir: `/tmp/remnic/${namespace}` }) },
    () => {
      const backend = new FakeBackend(false);
      created.push(backend);
      return backend;
    },
  );

  const updated = await router.updateNamespaces(["main", "shared", "main", "project"]);

  assert.equal(updated, 3);
  assert.equal(created.reduce((sum, backend) => sum + backend.updates, 0), 3);
});
