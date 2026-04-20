import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  SUPPORTED_IMPORTERS,
  clearImporterModuleCacheForTesting,
  isSupportedImporterName,
  loadImporterModule,
  setImporterDynamicImportForTesting,
} from "./optional-importer.js";

/**
 * Build a synthetic `ERR_MODULE_NOT_FOUND` error that matches the shape
 * `isSpecifierNotFoundError` checks for. Used to simulate a missing
 * `@remnic/import-*` package deterministically — the real install state
 * of the workspace is irrelevant for this test's contract.
 */
function makeModuleNotFoundError(specifier: string): Error {
  const err = new Error(`Cannot find package '${specifier}'`) as Error & {
    code?: string;
  };
  err.code = "ERR_MODULE_NOT_FOUND";
  return err;
}

describe("optional-importer loader", () => {
  beforeEach(() => {
    clearImporterModuleCacheForTesting();
    setImporterDynamicImportForTesting(undefined);
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

  // Codex + Cursor reviews on PR #600: once all four importer packages
  // are installed in the workspace, we can't rely on a real "missing
  // package" fixture. Instead we inject a deterministic loader via
  // setImporterDynamicImportForTesting and have it throw the same
  // ERR_MODULE_NOT_FOUND that Node produces on a missing specifier.
  // This exercises the install-hint path independent of workspace state.
  it("loading a missing importer throws a user-facing install hint", async () => {
    setImporterDynamicImportForTesting(async (specifier) => {
      throw makeModuleNotFoundError(specifier);
    });
    await assert.rejects(
      () => loadImporterModule("gemini"),
      (err: Error) => {
        // Install hint must include the package name and an install
        // command the user can actually run — not a raw MODULE_NOT_FOUND.
        assert.ok(
          err.message.includes("@remnic/import-gemini"),
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
    let importAttempts = 0;
    setImporterDynamicImportForTesting(async (specifier) => {
      importAttempts += 1;
      throw makeModuleNotFoundError(specifier);
    });
    // First call hits the import and populates the cache with null.
    await assert.rejects(() => loadImporterModule("gemini"));
    // Second call must still throw, but from the cache hit — the
    // injected loader should NOT be invoked again.
    await assert.rejects(() => loadImporterModule("gemini"));
    assert.equal(
      importAttempts,
      1,
      "second loadImporterModule call must be served from negative cache",
    );
  });
});
