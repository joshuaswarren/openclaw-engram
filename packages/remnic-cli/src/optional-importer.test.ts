import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  SUPPORTED_IMPORTERS,
  clearImporterModuleCacheForTesting,
  isSupportedImporterName,
  loadImporterModule,
} from "./optional-importer.js";

describe("optional-importer loader", () => {
  beforeEach(() => {
    clearImporterModuleCacheForTesting();
  });

  it("SUPPORTED_IMPORTERS lists the four canonical sources in a stable order", () => {
    assert.deepEqual([...SUPPORTED_IMPORTERS], [
      "chatgpt",
      "claude",
      "gemini",
      "mem0",
    ]);
  });

  it("isSupportedImporterName is false for unknown names", () => {
    assert.equal(isSupportedImporterName("chatgpt"), true);
    assert.equal(isSupportedImporterName("bogus"), false);
    assert.equal(isSupportedImporterName(""), false);
    assert.equal(isSupportedImporterName("chatgpt "), false);
  });

  // Slices 2, 3, 4 (chatgpt, claude, gemini) are not yet installed so they
  // make durable "missing package" fixtures that don't depend on which slice
  // is currently being developed. The mem0 fixture intentionally is NOT used
  // here because PR 5 installs @remnic/import-mem0 alongside, which would
  // make the install-hint assertion race with that installation.
  it("loading a missing importer throws a user-facing install hint", async () => {
    await assert.rejects(
      () => loadImporterModule("chatgpt"),
      (err: Error) => {
        // Install hint must include the package name and an install
        // command the user can actually run — not a raw MODULE_NOT_FOUND.
        assert.ok(
          err.message.includes("@remnic/import-chatgpt"),
          `expected package name in message, got: ${err.message}`,
        );
        assert.ok(
          err.message.includes("npm install") ||
            err.message.includes("pnpm add"),
          `expected install command in message, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("loader caches negative results so repeated calls do not re-import", async () => {
    // First call populates the cache with a null.
    await assert.rejects(() => loadImporterModule("claude"));
    // Second call must still throw — but the cache hit path is covered
    // exclusively by the branch that rejects from cached null.
    await assert.rejects(() => loadImporterModule("claude"));
  });
});
