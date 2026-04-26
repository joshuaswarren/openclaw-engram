/**
 * `remnic connectors` CLI helpers (issue #683 PR 6/N).
 *
 * Three subcommands:
 *
 *   remnic connectors list
 *     Lists all configured live connectors, their enabled state, last poll
 *     time, and last error.  Output formats: text (default), markdown, json.
 *
 *   remnic connectors status
 *     Identical data to `list` but defaults to JSON output so scripts can
 *     reliably parse it.  Accepts `--format` to override.
 *
 *   remnic connectors run <name>
 *     Manually triggers a single `syncIncremental()` pass for the named
 *     connector.  Operator debug surface — useful when you want to test
 *     credentials without waiting for the scheduler tick.  Prints the
 *     number of new documents imported plus any error.
 *
 * Design decisions:
 *
 *   - Pure functions for list / status / run option parsing so they can be
 *     unit-tested without booting an orchestrator (CLAUDE.md rules 14 + 51).
 *   - Rendering lives here (not in cli.ts) so HTTP/MCP surfaces can reuse the
 *     same output without forking formatting (CLAUDE.md rule 22).
 *   - The `run` command requires the caller to pass a `pollFn` callback
 *     (wrapping the actual connector's `syncIncremental`).  This keeps the
 *     helper module free of direct orchestrator / live-connector imports while
 *     still being testable (CLAUDE.md rule 33 — mock signatures must match
 *     production).
 *   - CLAUDE.md rule 51: invalid `--format` throws with listed options; unknown
 *     connector name in `run` throws a descriptive error; `--format` without a
 *     value is caught by Commander's built-in argument check.
 */

import {
  type ConnectorState,
  type ConnectorSyncStatus,
} from "./connectors/live/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types that cross the module boundary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A lightweight descriptor for one live connector, assembled from the parsed
 * config and any persisted state.  The CLI handler builds this from
 * `orchestrator.config.connectors` + `listConnectorStates(memoryDir)`.
 */
export interface ConnectorRow {
  /** Stable connector id (e.g. `"google-drive"`, `"notion"`). */
  id: string;
  /** Human-readable display name. */
  displayName: string;
  /** Whether the operator has enabled this connector in config. */
  enabled: boolean;
  /** Persisted sync state, or `null` if no sync has ever run. */
  state: ConnectorState | null;
}

/**
 * Result returned by the `run` command's poll function.
 */
export interface ConnectorRunResult {
  /** Number of new documents imported in this pass. */
  docsImported: number;
  /** Error message if the sync failed, undefined on success. */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output formats
// ─────────────────────────────────────────────────────────────────────────────

export const CONNECTORS_OUTPUT_FORMATS = ["text", "markdown", "json"] as const;
export type ConnectorsOutputFormat = (typeof CONNECTORS_OUTPUT_FORMATS)[number];

/**
 * Validate `--format <fmt>`.  Throws a listed-options error for any value not
 * in `CONNECTORS_OUTPUT_FORMATS`.  Returns the given default when the value is
 * `undefined` (no flag supplied).
 */
export function parseConnectorsFormat(
  value: unknown,
  defaultFormat: ConnectorsOutputFormat = "text",
): ConnectorsOutputFormat {
  if (value === undefined || value === null) return defaultFormat;
  if (
    typeof value !== "string" ||
    !(CONNECTORS_OUTPUT_FORMATS as readonly string[]).includes(value)
  ) {
    throw new Error(
      `--format expects one of ${CONNECTORS_OUTPUT_FORMATS.join(", ")}; got ${JSON.stringify(value)}`,
    );
  }
  return value as ConnectorsOutputFormat;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsed option types
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedConnectorsListOptions {
  format: ConnectorsOutputFormat;
}

export interface ParsedConnectorsStatusOptions {
  /** `status` defaults to JSON for scripting; `--format` can override. */
  format: ConnectorsOutputFormat;
}

// ─────────────────────────────────────────────────────────────────────────────
// Option parsers (pure, unit-testable)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate the option bag for `remnic connectors list`.
 */
export function parseConnectorsListOptions(
  options: Record<string, unknown>,
): ParsedConnectorsListOptions {
  return {
    format: parseConnectorsFormat(options.format, "text"),
  };
}

/**
 * Validate the option bag for `remnic connectors status`.
 * Defaults to `json` (machine-readable) unless `--format` overrides.
 */
export function parseConnectorsStatusOptions(
  options: Record<string, unknown>,
): ParsedConnectorsStatusOptions {
  return {
    format: parseConnectorsFormat(options.format, "json"),
  };
}

/**
 * Validate the positional `<name>` argument for `remnic connectors run`.
 */
export function parseConnectorsRunName(rawName: unknown): string {
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    throw new Error(
      "connectors run: <name> is required and must be a non-empty connector id",
    );
  }
  return rawName.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters: shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Human-readable summary of `ConnectorSyncStatus`.
 */
function statusLabel(
  status: ConnectorSyncStatus,
  enabled: boolean,
): string {
  if (!enabled) return "disabled";
  switch (status) {
    case "never":
      return "never synced";
    case "success":
      return "ok";
    case "error":
      return "error";
    default:
      return status;
  }
}

/**
 * Format a UTC ISO timestamp for display.  If the value is `null` / `undefined`
 * returns the given fallback string.
 */
function fmtTimestamp(value: string | null | undefined, fallback = "—"): string {
  if (!value) return fallback;
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render connector rows for `remnic connectors list` / `remnic connectors status`.
 */
export function renderConnectorsList(
  rows: readonly ConnectorRow[],
  format: ConnectorsOutputFormat,
): string {
  if (format === "json") {
    const out = rows.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      enabled: row.enabled,
      lastSyncAt: row.state?.lastSyncAt ?? null,
      lastSyncStatus: row.state?.lastSyncStatus ?? "never",
      lastSyncError: row.state?.lastSyncError ?? null,
      totalDocsImported: row.state?.totalDocsImported ?? 0,
      updatedAt: row.state?.updatedAt ?? null,
    }));
    return JSON.stringify(out, null, 2);
  }

  if (rows.length === 0) {
    if (format === "markdown") {
      return "# Live connectors\n\n_No live connectors are configured._\n";
    }
    return "No live connectors configured.";
  }

  if (format === "markdown") {
    const lines: string[] = ["# Live connectors", ""];
    lines.push("| ID | Display name | Enabled | Last poll | Docs imported | Status |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const row of rows) {
      const lastPoll = fmtTimestamp(row.state?.lastSyncAt);
      const docs = row.state?.totalDocsImported ?? 0;
      const status = statusLabel(row.state?.lastSyncStatus ?? "never", row.enabled);
      lines.push(
        `| \`${row.id}\` | ${row.displayName} | ${row.enabled ? "yes" : "no"} | ${lastPoll} | ${docs} | ${status} |`,
      );
      if (row.state?.lastSyncError) {
        lines.push(
          `| | | | | | _Error: ${escapePipes(row.state.lastSyncError)}_ |`,
        );
      }
    }
    return lines.join("\n") + "\n";
  }

  // text
  const lines: string[] = [`Live connectors (${rows.length}):`];
  lines.push("");
  for (const row of rows) {
    const enabledStr = row.enabled ? "enabled" : "disabled";
    const status = statusLabel(row.state?.lastSyncStatus ?? "never", row.enabled);
    const lastPoll = fmtTimestamp(row.state?.lastSyncAt, "(never polled)");
    const docs = row.state?.totalDocsImported ?? 0;
    lines.push(`  ${row.id}  (${row.displayName})`);
    lines.push(`    state:         ${enabledStr}, ${status}`);
    lines.push(`    last_poll:     ${lastPoll}`);
    lines.push(`    docs_imported: ${docs}`);
    if (row.state?.lastSyncError) {
      lines.push(`    last_error:    ${row.state.lastSyncError}`);
    }
  }
  return lines.join("\n");
}

/**
 * Render the result of a manual `remnic connectors run <name>` invocation.
 */
export function renderConnectorsRunResult(
  connectorId: string,
  result: ConnectorRunResult,
  format: ConnectorsOutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(
      {
        connector: connectorId,
        docsImported: result.docsImported,
        error: result.error ?? null,
        ok: result.error === undefined,
      },
      null,
      2,
    );
  }

  const ok = result.error === undefined;
  if (format === "markdown") {
    const lines: string[] = [`# connectors run: \`${connectorId}\``, ""];
    lines.push(`- **Status:** ${ok ? "success" : "error"}`);
    lines.push(`- **Docs imported:** ${result.docsImported}`);
    if (!ok) {
      lines.push(`- **Error:** ${result.error}`);
    }
    return lines.join("\n") + "\n";
  }

  // text
  const lines: string[] = [];
  if (ok) {
    lines.push(`connectors run: ${connectorId} — OK`);
    lines.push(`  docs_imported: ${result.docsImported}`);
  } else {
    lines.push(`connectors run: ${connectorId} — FAILED`);
    lines.push(`  docs_imported: ${result.docsImported}`);
    lines.push(`  error:         ${result.error}`);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escape characters that would break a Markdown table cell (backslash first,
 * then pipe).  Same pattern as in `patterns-cli.ts`.
 */
function escapePipes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}
