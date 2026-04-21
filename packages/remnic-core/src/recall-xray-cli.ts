/**
 * Input-validation helpers for the `remnic xray` CLI command (issue
 * #570, PR 3).
 *
 * Pulled out of `cli.ts` so the validation paths can be unit-tested in
 * isolation — the full CLI handler is hard to exercise without booting
 * an orchestrator.  CLAUDE.md rules 14 + 51 require that `--format`,
 * `--budget`, `--namespace`, and `--out` reject missing-value /
 * unknown / non-positive arguments with a listed-options error, rather
 * than silently defaulting.
 */

import {
  parseXrayFormat,
  type RecallXrayFormat,
} from "./recall-xray-renderer.js";

export interface ParsedXrayCliOptions {
  format: RecallXrayFormat;
  /** Positive integer override, or undefined when not specified. */
  budget?: number;
  /** Trimmed namespace, or undefined when not specified. */
  namespace?: string;
  /** Trimmed, tilde-unexpanded output path, or undefined when stdout. */
  outPath?: string;
}

/**
 * Validate and coerce `--budget <chars>`.  Must be a positive integer;
 * throws a listed-options error otherwise.
 */
export function parseXrayBudgetFlag(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    !Number.isInteger(parsed)
  ) {
    throw new Error(
      `--budget expects a positive integer; got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

/**
 * Parse and validate the full option bag for `remnic xray`.  Extracted
 * so the CLI handler in `cli.ts` can stay thin and the validation can
 * be unit-tested without booting an orchestrator.
 */
export function parseXrayCliOptions(
  rawQuery: unknown,
  options: Record<string, unknown>,
): { query: string } & ParsedXrayCliOptions {
  if (typeof rawQuery !== "string" || rawQuery.trim().length === 0) {
    throw new Error("xray: <query> is required and must be non-empty");
  }
  const format = parseXrayFormat(options.format);
  const budget = parseXrayBudgetFlag(options.budget);
  const namespace =
    typeof options.namespace === "string" &&
    options.namespace.trim().length > 0
      ? options.namespace.trim()
      : undefined;
  const outPath =
    typeof options.out === "string" && options.out.trim().length > 0
      ? options.out.trim()
      : undefined;
  return {
    query: rawQuery,
    format,
    ...(budget !== undefined ? { budget } : {}),
    ...(namespace !== undefined ? { namespace } : {}),
    ...(outPath !== undefined ? { outPath } : {}),
  };
}
