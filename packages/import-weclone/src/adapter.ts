// ---------------------------------------------------------------------------
// WeClone bulk-import source adapter
// ---------------------------------------------------------------------------

import type { BulkImportSourceAdapter, BulkImportSource } from "@remnic/core";
import { parseWeCloneExport, type ParseOptions } from "./parser.js";

/**
 * Adapter that conforms to `BulkImportSourceAdapter` from `@remnic/core`.
 * Delegates parsing to `parseWeCloneExport`.
 */
export const wecloneImportAdapter: BulkImportSourceAdapter = {
  name: "weclone",
  parse(
    input: unknown,
    options?: { strict?: boolean },
  ): BulkImportSource {
    const parseOpts: ParseOptions | undefined = options
      ? { strict: options.strict }
      : undefined;
    return parseWeCloneExport(input, parseOpts);
  },
};
