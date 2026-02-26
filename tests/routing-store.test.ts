import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { RoutingRulesStore } from "../src/routing/store.ts";
import type { RouteRule } from "../src/routing/engine.ts";

function sampleRule(overrides: Partial<RouteRule> = {}): RouteRule {
  return {
    id: overrides.id ?? "rule-1",
    patternType: overrides.patternType ?? "keyword",
    pattern: overrides.pattern ?? "incident",
    priority: overrides.priority ?? 5,
    target: overrides.target ?? { category: "fact", namespace: "default" },
    enabled: overrides.enabled ?? true,
  };
}

test("routing store round-trips valid rules", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-"));
  try {
    const store = new RoutingRulesStore(memoryDir);
    await store.write([sampleRule()]);

    const rules = await store.read();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, "rule-1");
    assert.equal(rules[0].target.namespace, "default");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store fail-opens malformed file", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-malformed-"));
  try {
    const statePath = path.join(memoryDir, "state", "routing-rules.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, "{bad-json", "utf-8");
    const store = new RoutingRulesStore(memoryDir);
    const rules = await store.read();
    assert.deepEqual(rules, []);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store skips invalid rule entries on read", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-invalid-"));
  try {
    const statePath = path.join(memoryDir, "state", "routing-rules.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          rules: [
            sampleRule({ id: "good" }),
            { id: "bad-1", patternType: "regex", pattern: "x", priority: 1, target: null },
            { id: "bad-2", patternType: "unknown", pattern: "x", priority: 1, target: { category: "fact" } },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const store = new RoutingRulesStore(memoryDir);
    const rules = await store.read();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, "good");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store upsert replaces by id", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-upsert-"));
  try {
    const store = new RoutingRulesStore(memoryDir);
    await store.write([sampleRule({ id: "r1", pattern: "incident" })]);
    await store.upsert(sampleRule({ id: "r1", pattern: "outage", priority: 9 }));

    const rules = await store.read();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].pattern, "outage");
    assert.equal(rules[0].priority, 9);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store removeByPattern persists removal", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-remove-"));
  try {
    const store = new RoutingRulesStore(memoryDir);
    await store.write([
      sampleRule({ id: "r1", pattern: "incident" }),
      sampleRule({ id: "r2", pattern: "outage" }),
    ]);

    await store.removeByPattern("incident");
    const rules = await store.read();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, "r2");

    const raw = await readFile(path.join(memoryDir, "state", "routing-rules.json"), "utf-8");
    assert.match(raw, /"outage"/);
    assert.doesNotMatch(raw, /"incident"/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store dedupes stable ids from normalized rule content", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-stable-id-"));
  try {
    const store = new RoutingRulesStore(memoryDir);
    const rules = await store.write([
      {
        ...sampleRule({ id: " " as unknown as string, priority: 5.7 }),
        target: { category: "fact", namespace: "default", extra: true } as unknown as RouteRule["target"],
      },
      {
        ...sampleRule({ id: "" as unknown as string, priority: 5 }),
        target: { category: "fact", namespace: "default" },
      },
    ]);

    assert.equal(rules.length, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("routing store keeps state file scoped under memoryDir", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-path-scope-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-path-outside-"));
  try {
    const outsidePath = path.join(outsideDir, "outside.json");
    const store = new RoutingRulesStore(memoryDir, "../outside.json");
    await store.write([sampleRule()]);

    await assert.rejects(async () => readFile(outsidePath, "utf-8"));
    const scopedRaw = await readFile(path.join(memoryDir, "state", "routing-rules.json"), "utf-8");
    assert.match(scopedRaw, /\"rules\"/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("routing store serializes concurrent upserts without lost updates", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-routing-store-concurrent-"));
  try {
    const store = new RoutingRulesStore(memoryDir);
    await Promise.all([
      store.upsert(sampleRule({ id: "r1", pattern: "one" })),
      store.upsert(sampleRule({ id: "r2", pattern: "two" })),
    ]);

    const rules = await store.read();
    const ids = new Set(rules.map((r) => r.id));
    assert.equal(ids.has("r1"), true);
    assert.equal(ids.has("r2"), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
