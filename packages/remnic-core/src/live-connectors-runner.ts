import {
  runConnectorPollOnce,
  type ConnectorRunResult,
} from "./connectors-cli.js";
import {
  createGitHubConnector,
  createGmailConnector,
  createGoogleDriveConnector,
  createNotionConnector,
  GITHUB_CONNECTOR_ID,
  GITHUB_DEFAULT_POLL_INTERVAL_MS,
  GMAIL_CONNECTOR_ID,
  GMAIL_DEFAULT_POLL_INTERVAL_MS,
  GOOGLE_DRIVE_CONNECTOR_ID,
  GOOGLE_DRIVE_DEFAULT_POLL_INTERVAL_MS,
  NOTION_CONNECTOR_ID,
  NOTION_DEFAULT_POLL_INTERVAL_MS,
  readConnectorState,
  writeConnectorState,
  validateGitHubConfig,
  validateGmailConfig,
  validateGoogleDriveConfig,
  validateNotionConfig,
  type ConnectorConfig,
  type ConnectorCursor,
  type ConnectorDocument,
  type ConnectorState,
  type LiveConnector,
} from "./connectors/live/index.js";
import type { LiveConnectorsConfig } from "./types.js";

export type LiveConnectorSkipReason =
  | "disabled"
  | "not_due"
  | "invalid_config";

export interface LiveConnectorRunItem {
  id: string;
  displayName: string;
  enabled: boolean;
  ran: boolean;
  skippedReason?: LiveConnectorSkipReason;
  docsImported: number;
  error?: string;
  stateWriteError?: string;
  lastSyncAt: string | null;
  nextDueAt: string | null;
}

export interface LiveConnectorsRunSummary {
  ranAt: string;
  force: boolean;
  totalDocsImported: number;
  ranCount: number;
  skippedCount: number;
  errorCount: number;
  results: LiveConnectorRunItem[];
}

export interface LiveConnectorDefinition {
  id: string;
  displayName: string;
  enabled: boolean;
  pollIntervalMs: number;
  rawConfig: unknown;
  createConnector: () => LiveConnector;
  validateConfig: (raw: unknown) => ConnectorConfig;
}

export function builtInLiveConnectorDefinitions(
  config: LiveConnectorsConfig,
): LiveConnectorDefinition[] {
  return [
    {
      id: GOOGLE_DRIVE_CONNECTOR_ID,
      displayName: "Google Drive",
      enabled: config.googleDrive.enabled,
      pollIntervalMs:
        config.googleDrive.pollIntervalMs ?? GOOGLE_DRIVE_DEFAULT_POLL_INTERVAL_MS,
      rawConfig: config.googleDrive,
      createConnector: createGoogleDriveConnector,
      validateConfig: (raw) =>
        validateGoogleDriveConfig(raw) as unknown as ConnectorConfig,
    },
    {
      id: NOTION_CONNECTOR_ID,
      displayName: "Notion",
      enabled: config.notion.enabled,
      pollIntervalMs: config.notion.pollIntervalMs ?? NOTION_DEFAULT_POLL_INTERVAL_MS,
      rawConfig: config.notion,
      createConnector: createNotionConnector,
      validateConfig: (raw) =>
        validateNotionConfig(raw) as unknown as ConnectorConfig,
    },
    {
      id: GMAIL_CONNECTOR_ID,
      displayName: "Gmail",
      enabled: config.gmail.enabled,
      pollIntervalMs: config.gmail.pollIntervalMs ?? GMAIL_DEFAULT_POLL_INTERVAL_MS,
      rawConfig: config.gmail,
      createConnector: createGmailConnector,
      validateConfig: (raw) => validateGmailConfig(raw) as unknown as ConnectorConfig,
    },
    {
      id: GITHUB_CONNECTOR_ID,
      displayName: "GitHub",
      enabled: config.github.enabled,
      pollIntervalMs:
        config.github.pollIntervalMs ?? GITHUB_DEFAULT_POLL_INTERVAL_MS,
      rawConfig: config.github,
      createConnector: createGitHubConnector,
      validateConfig: (raw) => validateGitHubConfig(raw) as unknown as ConnectorConfig,
    },
  ];
}

export function hasEnabledLiveConnector(config: LiveConnectorsConfig): boolean {
  return (
    config.googleDrive.enabled ||
    config.notion.enabled ||
    config.gmail.enabled ||
    config.github.enabled
  );
}

export async function runLiveConnectorsOnce(options: {
  memoryDir: string;
  connectors: LiveConnectorsConfig;
  ingestDocuments: (docs: ConnectorDocument[]) => Promise<void>;
  force?: boolean;
  now?: Date;
  abortSignal?: AbortSignal;
  definitions?: LiveConnectorDefinition[];
}): Promise<LiveConnectorsRunSummary> {
  const now = options.now ?? new Date();
  const force = options.force === true;
  const definitions =
    options.definitions ?? builtInLiveConnectorDefinitions(options.connectors);
  const results: LiveConnectorRunItem[] = [];

  for (const definition of definitions) {
    if (!definition.enabled) {
      results.push(skipResult(definition, null, now, "disabled"));
      continue;
    }
    const state = await readConnectorState(options.memoryDir, definition.id);
    if (!force && !isConnectorDue(state, definition.pollIntervalMs, now)) {
      results.push(skipResult(definition, state, now, "not_due"));
      continue;
    }

    let validatedConfig: ConnectorConfig;
    try {
      validatedConfig = definition.validateConfig(definition.rawConfig);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let stateWriteError: string | undefined;
      try {
        await writeConnectorErrorState({
          memoryDir: options.memoryDir,
          connectorId: definition.id,
          state,
          error: message,
          now,
        });
      } catch (writeErr) {
        stateWriteError =
          writeErr instanceof Error ? writeErr.message : String(writeErr);
      }
      results.push({
        id: definition.id,
        displayName: definition.displayName,
        enabled: true,
        ran: false,
        skippedReason: "invalid_config",
        docsImported: 0,
        error: message,
        ...(stateWriteError !== undefined ? { stateWriteError } : {}),
        lastSyncAt: state?.lastSyncAt ?? null,
        nextDueAt: nextDueAt(state, definition.pollIntervalMs),
      });
      continue;
    }

    const connector = definition.createConnector();
    const runResult = await runConnectorPollOnce({
      connectorId: definition.id,
      priorState: state,
      syncFn: (cursor: ConnectorCursor | null) =>
        connector.syncIncremental({
          cursor,
          config: validatedConfig,
          abortSignal: options.abortSignal,
        }),
      ingestFn: options.ingestDocuments,
      writeCursorFn: (writeState) =>
        writeConnectorState(options.memoryDir, definition.id, {
          id: definition.id,
          cursor: writeState.cursor,
          lastSyncAt: now.toISOString(),
          lastSyncStatus: writeState.lastSyncStatus,
          ...(writeState.lastSyncError !== undefined
            ? { lastSyncError: writeState.lastSyncError }
            : {}),
          totalDocsImported: writeState.totalDocsImported,
        }).then(() => undefined),
    });
    results.push(runItemFromResult(definition, runResult, now));
  }

  return {
    ranAt: now.toISOString(),
    force,
    totalDocsImported: results.reduce((sum, item) => sum + item.docsImported, 0),
    ranCount: results.filter((item) => item.ran).length,
    skippedCount: results.filter((item) => !item.ran).length,
    errorCount: results.filter(
      (item) => item.error !== undefined || item.stateWriteError !== undefined,
    ).length,
    results,
  };
}

function isConnectorDue(
  state: ConnectorState | null,
  pollIntervalMs: number,
  now: Date,
): boolean {
  if (state?.lastSyncAt === null || state?.lastSyncAt === undefined) return true;
  const lastMs = Date.parse(state.lastSyncAt);
  if (!Number.isFinite(lastMs)) return true;
  return now.getTime() - lastMs >= Math.max(1, Math.floor(pollIntervalMs));
}

function nextDueAt(
  state: ConnectorState | null,
  pollIntervalMs: number,
): string | null {
  if (state?.lastSyncAt === null || state?.lastSyncAt === undefined) return null;
  const lastMs = Date.parse(state.lastSyncAt);
  if (!Number.isFinite(lastMs)) return null;
  return new Date(lastMs + Math.max(1, Math.floor(pollIntervalMs))).toISOString();
}

function skipResult(
  definition: LiveConnectorDefinition,
  state: ConnectorState | null,
  now: Date,
  skippedReason: LiveConnectorSkipReason,
): LiveConnectorRunItem {
  return {
    id: definition.id,
    displayName: definition.displayName,
    enabled: definition.enabled,
    ran: false,
    skippedReason,
    docsImported: 0,
    lastSyncAt: state?.lastSyncAt ?? null,
    nextDueAt:
      skippedReason === "not_due"
        ? nextDueAt(state, definition.pollIntervalMs)
        : null,
  };
}

function runItemFromResult(
  definition: LiveConnectorDefinition,
  result: ConnectorRunResult,
  now: Date,
): LiveConnectorRunItem {
  return {
    id: definition.id,
    displayName: definition.displayName,
    enabled: definition.enabled,
    ran: true,
    docsImported: result.docsImported,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.stateWriteError !== undefined
      ? { stateWriteError: result.stateWriteError }
      : {}),
    lastSyncAt: now.toISOString(),
    nextDueAt: new Date(
      now.getTime() + Math.max(1, Math.floor(definition.pollIntervalMs)),
    ).toISOString(),
  };
}

async function writeConnectorErrorState(options: {
  memoryDir: string;
  connectorId: string;
  state: ConnectorState | null;
  error: string;
  now: Date;
}): Promise<void> {
  await writeConnectorState(options.memoryDir, options.connectorId, {
    id: options.connectorId,
    cursor: options.state?.cursor ?? null,
    lastSyncAt: options.now.toISOString(),
    lastSyncStatus: "error",
    lastSyncError: options.error,
    totalDocsImported: options.state?.totalDocsImported ?? 0,
  });
}
