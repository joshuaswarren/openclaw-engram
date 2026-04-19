import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  registerBulkImportSource,
  getBulkImportSource,
  listBulkImportSources,
  clearBulkImportSources,
} from "./registry.js";
import type { BulkImportSource, BulkImportSourceAdapter } from "./types.js";

function makeAdapter(
  name: string,
): BulkImportSourceAdapter {
  return {
    name,
    parse: () => ({
      turns: [],
      metadata: {
        source: name,
        exportDate: "2024-06-15T00:00:00.000Z",
        messageCount: 0,
        dateRange: {
          from: "2024-01-01T00:00:00.000Z",
          to: "2024-06-15T00:00:00.000Z",
        },
      },
    }),
  };
}

describe("bulk-import registry", () => {
  beforeEach(() => {
    clearBulkImportSources();
  });

  it("registers and retrieves a source adapter", () => {
    const adapter = makeAdapter("weclone-telegram");
    registerBulkImportSource(adapter);
    const retrieved = getBulkImportSource("weclone-telegram");
    assert.equal(retrieved, adapter);
  });

  it("lists registered adapter names", () => {
    registerBulkImportSource(makeAdapter("source-a"));
    registerBulkImportSource(makeAdapter("source-b"));
    const names = listBulkImportSources();
    assert.deepEqual(names.sort(), ["source-a", "source-b"]);
  });

  it("rejects duplicate registration", () => {
    registerBulkImportSource(makeAdapter("dup-source"));
    assert.throws(
      () => registerBulkImportSource(makeAdapter("dup-source")),
      (err: Error) => {
        assert.ok(
          err.message.includes("already registered"),
          `expected 'already registered' in: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("returns undefined for unknown source", () => {
    const result = getBulkImportSource("nonexistent");
    assert.equal(result, undefined);
  });

  it("rejects empty adapter name", () => {
    assert.throws(
      () => registerBulkImportSource(makeAdapter("")),
      (err: Error) => {
        assert.ok(
          err.message.includes("non-empty string"),
          `expected 'non-empty string' in: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("rejects whitespace-only adapter name", () => {
    assert.throws(
      () => registerBulkImportSource(makeAdapter("   ")),
      (err: Error) => {
        assert.ok(
          err.message.includes("non-empty string"),
          `expected 'non-empty string' in: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("rejects null adapter", () => {
    assert.throws(
      () =>
        registerBulkImportSource(
          null as unknown as BulkImportSourceAdapter,
        ),
      (err: Error) => {
        assert.ok(err.message.includes("must be an object"));
        return true;
      },
    );
  });

  it("rejects adapter without parse function", () => {
    const bad = { name: "no-parse" } as unknown as BulkImportSourceAdapter;
    assert.throws(
      () => registerBulkImportSource(bad),
      (err: Error) => {
        assert.ok(err.message.includes("parse function"));
        return true;
      },
    );
  });

  it("clearBulkImportSources removes all adapters", () => {
    registerBulkImportSource(makeAdapter("x"));
    assert.equal(listBulkImportSources().length, 1);
    clearBulkImportSources();
    assert.equal(listBulkImportSources().length, 0);
  });

  it("getBulkImportSource trims the name on lookup", () => {
    registerBulkImportSource(makeAdapter("weclone"));
    // Lookup with leading/trailing whitespace should still find it
    const result = getBulkImportSource("  weclone  ");
    assert.ok(result, "expected adapter to be found with trimmed lookup key");
    assert.equal(result!.name, "weclone");
  });

  it("getBulkImportSource trims consistently with registration", () => {
    // Register with whitespace in name — registerBulkImportSource trims it
    registerBulkImportSource(makeAdapter("  padded-source  "));
    // Lookup with same whitespace should work
    const result1 = getBulkImportSource("  padded-source  ");
    assert.ok(result1, "expected adapter found via padded lookup");
    // Lookup with trimmed name should also work
    const result2 = getBulkImportSource("padded-source");
    assert.ok(result2, "expected adapter found via trimmed lookup");
  });

  it("stored adapter.name matches the registry key (trimmed)", () => {
    // Register adapter whose name has surrounding whitespace.
    registerBulkImportSource(makeAdapter("  padded-name  "));
    const names = listBulkImportSources();
    assert.deepEqual(names, ["padded-name"]);
    // The adapter returned from lookup must also report the trimmed name so
    // downstream code using `adapter.name` agrees with the registry key.
    const retrieved = getBulkImportSource("padded-name");
    assert.ok(retrieved);
    assert.equal(retrieved!.name, "padded-name");
  });

  it("preserves prototype-defined methods on class-based adapters with padded names", async () => {
    // A class whose `parse` lives on the prototype (not as an own property).
    class ClassAdapter implements BulkImportSourceAdapter {
      name: string;
      constructor(name: string) {
        this.name = name;
      }
      parse(): BulkImportSource {
        return {
          turns: [],
          metadata: {
            source: this.name.trim(),
            exportDate: "2024-06-15T00:00:00.000Z",
            messageCount: 0,
            dateRange: {
              from: "2024-01-01T00:00:00.000Z",
              to: "2024-06-15T00:00:00.000Z",
            },
          },
        };
      }
    }
    const instance = new ClassAdapter("  class-adapter  ");
    registerBulkImportSource(instance);
    const retrieved = getBulkImportSource("class-adapter");
    assert.ok(retrieved, "expected class-based adapter to be retrievable");
    assert.equal(retrieved!.name, "class-adapter");
    // The prototype-defined `parse` method must survive name normalization.
    assert.equal(typeof retrieved!.parse, "function");
    const parsed = await retrieved!.parse(null);
    assert.equal(parsed.metadata.source, "class-adapter");
  });
});
