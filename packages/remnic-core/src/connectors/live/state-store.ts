/**
 * @remnic/core — Live Connectors State Store (issue #683 PR 1/N)
 *
 * Persists per-connector cursor + sync metadata to
 *   `<memoryDir>/state/connectors/<id>.json`
 *
 * Reasons this lives next to memory data, not in user config:
 *   - cursors are *operational* state that should travel with the memory
 *     directory when a user moves it across machines;
 *   - it keeps memory + ingest provenance co-located so tooling that backs up
 *     the memory directory captures cursor state too.
 *
 * Atomic-write contract (CLAUDE.md gotcha #54):
 *   - We NEVER `rmSync(target)` before `renameSync(tmp, target)`.
 *   - Writes go to a sibling tmp file and `rename()` swaps it in.
 *   - On error, the tmp file is best-effort cleaned up; the previous good
 *     state file is left untouched.
 *
 * Privacy: cursors are opaque connector-defined strings. We do not log them
 * and do not surface them through user-visible APIs. Document content NEVER
 * touches this module.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { expandTildePath } from "../../utils/path.js";

import {
  isValidConnectorId,
  type ConnectorCursor,
} from "./framework.js";

/**
 * Status of the most recent sync attempt for a connector.
 *
 * `"never"` is distinct from `"success"` so callers can detect
 * "registered but never run" without inspecting timestamps. Per CLAUDE.md
 * gotcha #34, we deliberately distinguish empty/unknown from failure states.
 */
export type ConnectorSyncStatus = "success" | "error" | "never";

/**
 * Persisted per-connector state.
 *
 * Stored as pretty-printed JSON for human inspection — the file is small
 * (one record per connector) and operators may need to debug stuck cursors
 * by hand.
 */
export interface ConnectorState {
  /** Connector id. Matches the filename stem. */
  readonly id: string;
  /** Last persisted cursor, or `null` if the connector has never synced. */
  readonly cursor: ConnectorCursor | null;
  /** ISO 8601 timestamp of the last completed sync attempt, or `null`. */
  readonly lastSyncAt: string | null;
  /** Status of the last completed sync attempt. */
  readonly lastSyncStatus: ConnectorSyncStatus;
  /** Optional error message from the last failed sync. Truncated to 1 KB. */
  readonly lastSyncError?: string;
  /** Cumulative count of documents successfully imported across all syncs. */
  readonly totalDocsImported: number;
  /** ISO 8601 timestamp of when this state record was last written. */
  readonly updatedAt: string;
}

const STATE_DIR_NAME = "state";
const CONNECTORS_DIR_NAME = "connectors";
const MAX_ERROR_LENGTH = 1024;

/**
 * Resolve `<memoryDir>/state/connectors/`, expanding `~` per CLAUDE.md #17.
 */
function resolveConnectorsDir(memoryDir: string): string {
  if (typeof memoryDir !== "string" || memoryDir.length === 0) {
    throw new TypeError("memoryDir must be a non-empty string");
  }
  return path.join(expandTildePath(memoryDir), STATE_DIR_NAME, CONNECTORS_DIR_NAME);
}

/**
 * Resolve the state file path for a single connector. Throws on invalid id
 * to prevent path traversal via crafted ids.
 */
function resolveConnectorStatePath(memoryDir: string, id: string): string {
  if (!isValidConnectorId(id)) {
    throw new TypeError(
      `invalid connector id ${JSON.stringify(id)} — must match /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/`,
    );
  }
  return path.join(resolveConnectorsDir(memoryDir), `${id}.json`);
}

/**
 * Type guard for parsed state records. Validates the on-disk shape so a
 * corrupted/edited file produces a clear error rather than crashing later.
 *
 * Per CLAUDE.md gotcha #18, JSON.parse('null') yields `null` which would
 * pass a naive truthy check. We explicitly require an object.
 */
function isConnectorStateShape(value: unknown): value is ConnectorState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string") return false;
  if (typeof v.lastSyncStatus !== "string") return false;
  if (!["success", "error", "never"].includes(v.lastSyncStatus)) return false;
  if (typeof v.totalDocsImported !== "number" || !Number.isFinite(v.totalDocsImported)) return false;
  if (typeof v.updatedAt !== "string") return false;
  if (v.lastSyncAt !== null && typeof v.lastSyncAt !== "string") return false;
  if (v.cursor !== null) {
    if (typeof v.cursor !== "object" || v.cursor === null) return false;
    const c = v.cursor as Record<string, unknown>;
    if (typeof c.kind !== "string" || typeof c.value !== "string" || typeof c.updatedAt !== "string") {
      return false;
    }
  }
  if (v.lastSyncError !== undefined && typeof v.lastSyncError !== "string") return false;
  return true;
}

/**
 * Read the persisted state for a single connector.
 *
 * Returns `null` if the file does not exist (ENOENT). Throws on any other
 * I/O error or on shape mismatch — operators should see corruption loudly.
 */
export async function readConnectorState(
  memoryDir: string,
  id: string,
): Promise<ConnectorState | null> {
  const filePath = resolveConnectorStatePath(memoryDir, id);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `connector state at ${filePath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!isConnectorStateShape(parsed)) {
    throw new Error(
      `connector state at ${filePath} does not match ConnectorState shape`,
    );
  }
  if (parsed.id !== id) {
    throw new Error(
      `connector state at ${filePath} has mismatched id ${JSON.stringify(parsed.id)}; expected ${JSON.stringify(id)}`,
    );
  }
  return parsed;
}

/**
 * Write state atomically: create-tmp + rename. Never destroys the previous
 * file before the new one is in place — see CLAUDE.md gotcha #54.
 *
 * We accept `Omit<ConnectorState, "updatedAt">` and stamp `updatedAt`
 * ourselves so callers can't accidentally persist a stale timestamp.
 */
export async function writeConnectorState(
  memoryDir: string,
  id: string,
  state: Omit<ConnectorState, "updatedAt">,
): Promise<ConnectorState> {
  if (!isValidConnectorId(id)) {
    throw new TypeError(
      `invalid connector id ${JSON.stringify(id)} — must match /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/`,
    );
  }
  if (state.id !== id) {
    throw new Error(
      `writeConnectorState(): state.id ${JSON.stringify(state.id)} does not match id argument ${JSON.stringify(id)}`,
    );
  }
  if (!Number.isFinite(state.totalDocsImported) || state.totalDocsImported < 0) {
    throw new Error(
      `writeConnectorState(): totalDocsImported must be a non-negative finite number`,
    );
  }
  if (state.lastSyncError !== undefined && typeof state.lastSyncError !== "string") {
    throw new Error(`writeConnectorState(): lastSyncError must be a string when provided`);
  }
  const truncatedError =
    state.lastSyncError !== undefined && state.lastSyncError.length > MAX_ERROR_LENGTH
      ? state.lastSyncError.slice(0, MAX_ERROR_LENGTH)
      : state.lastSyncError;

  const finalState: ConnectorState = {
    id: state.id,
    cursor: state.cursor,
    lastSyncAt: state.lastSyncAt,
    lastSyncStatus: state.lastSyncStatus,
    ...(truncatedError !== undefined ? { lastSyncError: truncatedError } : {}),
    totalDocsImported: state.totalDocsImported,
    updatedAt: new Date().toISOString(),
  };

  const dir = resolveConnectorsDir(memoryDir);
  await fs.mkdir(dir, { recursive: true });
  const targetPath = path.join(dir, `${id}.json`);
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const body = `${JSON.stringify(finalState, null, 2)}\n`;
  try {
    await fs.writeFile(tmpPath, body, { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup of the tmp file. Never touch `targetPath` — the
    // previous good state must remain readable on failure.
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
  return finalState;
}

/**
 * Enumerate every persisted connector state. Returns an empty array when
 * the directory does not exist yet (clean install, no syncs ever run).
 *
 * Files that do not match the `<id>.json` naming rule are skipped — this
 * keeps stray editor backups (`.json~`, `.swp`) from breaking enumeration.
 * Files whose contents fail validation are also skipped, with the caller
 * receiving the successfully parsed subset; this preserves availability
 * when one connector's state is corrupted.
 */
export async function listConnectorStates(memoryDir: string): Promise<ConnectorState[]> {
  const dir = resolveConnectorsDir(memoryDir);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: ConnectorState[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (!isValidConnectorId(id)) continue;
    try {
      const state = await readConnectorState(memoryDir, id);
      if (state !== null) out.push(state);
    } catch {
      // Skip corrupted state files rather than failing the whole listing.
      // Operators inspecting `state/connectors/` will still see the file.
      continue;
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Test-only helper: resolve where a given connector's state lives. Exported
 * so tests can assert the on-disk layout without duplicating the path math.
 * Not part of the stable public API.
 *
 * @internal
 */
export function _connectorStatePathForTest(memoryDir: string, id: string): string {
  return resolveConnectorStatePath(memoryDir, id);
}
