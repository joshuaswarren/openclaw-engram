import crypto from "node:crypto";
import {
  type ObjectiveStateChangeKind,
  type ObjectiveStateOutcome,
  type ObjectiveStateSnapshot,
  recordObjectiveStateSnapshot,
} from "./objective-state.js";

interface ToolCallContext {
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
}

interface DerivedObjectiveStateResult {
  snapshots: ObjectiveStateSnapshot[];
  filePaths: string[];
}

function hashSha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toolNameTokens(toolName: string | undefined): string[] {
  if (!toolName) return [];
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function normalizedToolName(toolName: string | undefined): string {
  return toolNameTokens(toolName).join("_");
}

function parseToolArguments(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (typeof block === "string") return block.trim();
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          return block.text.trim();
        }
        return "";
      })
      .filter((item) => item.length > 0)
      .join("\n");
  }
  if (isRecord(value)) {
    return JSON.stringify(value);
  }
  return "";
}

function parseToolResultPayload(content: unknown): unknown {
  const text = extractTextContent(content);
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function resultHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const canonical =
    typeof value === "string" ? value : JSON.stringify(value);
  if (!canonical || canonical.length === 0) return undefined;
  return `sha256:${hashSha256(canonical)}`;
}

function getToolCallContexts(messages: Array<Record<string, unknown>>): Map<string, ToolCallContext> {
  const contexts = new Map<string, ToolCallContext>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const toolCalls = message.tool_calls ?? message.toolCalls;
    if (!Array.isArray(toolCalls)) continue;
    for (const call of toolCalls) {
      if (!isRecord(call)) continue;
      const toolCallId = optionalString(call.id) ?? optionalString(call.toolCallId);
      if (!toolCallId) continue;
      const fn = isRecord(call.function) ? call.function : undefined;
      const toolName =
        optionalString(fn?.name) ??
        optionalString(call.name);
      const args =
        parseToolArguments(fn?.arguments) ??
        parseToolArguments(call.arguments) ??
        parseToolArguments(call.args) ??
        parseToolArguments(call.input);
      contexts.set(toolCallId, { toolCallId, toolName, args });
    }
  }
  return contexts;
}

function toolCallIdForMessage(message: Record<string, unknown>): string | undefined {
  return (
    optionalString(message.tool_call_id) ??
    optionalString(message.toolCallId) ??
    optionalString(message.tool_use_id) ??
    optionalString(message.toolUseId)
  );
}

function toolNameForMessage(message: Record<string, unknown>, context?: ToolCallContext): string | undefined {
  return (
    optionalString(message.name) ??
    optionalString(message.toolName) ??
    optionalString(message.tool) ??
    context?.toolName
  );
}

function pickString(args: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = optionalString(args[key]);
    if (value) return value;
  }
  return undefined;
}

function pickFirstStringArrayValue(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const candidate = optionalString(item);
    if (candidate) return candidate;
  }
  return undefined;
}

function fileScopeFromArgs(args: Record<string, unknown> | undefined): {
  scope?: string;
  sourcePath?: string;
  destinationPath?: string;
} {
  const destinationPath =
    pickString(args, ["destination", "dest", "targetPath", "target", "to"]) ??
    pickString(args, ["path", "filePath", "workspacePath", "projectPath"]) ??
    pickFirstStringArrayValue(args, "paths");
  const sourcePath =
    pickString(args, ["source", "src", "from", "oldPath"]);
  const scope = destinationPath ?? sourcePath;
  return { scope, sourcePath, destinationPath };
}

function fileContentHash(args: Record<string, unknown> | undefined): string | undefined {
  const content =
    pickString(args, ["content", "patch", "diff", "text", "value"]) ??
    args?.updates;
  return resultHash(content);
}

function inferOutcome(message: Record<string, unknown>, parsedPayload: unknown): ObjectiveStateOutcome {
  if (message.isError === true) return "failure";
  if (isRecord(parsedPayload)) {
    if (parsedPayload.partial === true || parsedPayload.status === "partial") return "partial";
    if (parsedPayload.success === false || parsedPayload.ok === false) return "failure";
    if (parsedPayload.success === true || parsedPayload.ok === true) return "success";
    if (typeof parsedPayload.exitCode === "number") {
      return parsedPayload.exitCode === 0 ? "success" : "failure";
    }
    if (optionalString(parsedPayload.error)) return "failure";
    if (parsedPayload.status === "error" || parsedPayload.status === "failed") return "failure";
    if (parsedPayload.status === "ok" || parsedPayload.status === "success") return "success";
  }
  if (typeof parsedPayload === "string") {
    const lowered = parsedPayload.toLowerCase();
    const loweredForFailure = lowered
      .replace(/\bpreviously failed\b/g, "")
      .replace(/\bfailed tests?\s+now\s+pass(?:es)?\b/g, "");
    const hasZeroErrors = /\b(?:0|no)\s+errors?\b/.test(lowered);
    const hasSuccessMarkers =
      /\b(success|succeeded|passes|passed|ok)\b/.test(lowered) ||
      hasZeroErrors;
    const hasFailureMarkers =
      /\b(exception|exceptions?|failed|failure|fatal|timeout|timed out)\b/.test(loweredForFailure) ||
      (/\berrors?\b/.test(loweredForFailure) && !hasZeroErrors) ||
      /\b[a-z]+error\b/.test(loweredForFailure) ||
      /\b[a-z]+exception\b/.test(loweredForFailure);

    if (hasFailureMarkers) return "failure";
    if (hasSuccessMarkers) return "success";
  }
  return "unknown";
}

function isProcessTool(toolName: string | undefined, args: Record<string, unknown> | undefined): boolean {
  const tokens = toolNameTokens(toolName);
  const normalizedName = normalizedToolName(toolName);
  if (pickString(args, ["cmd", "command", "script"])) return true;
  return ["exec", "shell", "bash", "terminal", "run_command", "exec_command"].some((token) =>
    token.includes("_") ? normalizedName === token : tokens.includes(token),
  );
}

function isFileTool(toolName: string | undefined, args: Record<string, unknown> | undefined): boolean {
  const tokens = toolNameTokens(toolName);
  const fileScope = fileScopeFromArgs(args);
  if (fileScope.scope) return true;
  return ["file", "path", "patch", "directory", "mkdir", "rename", "move"].some((token) =>
    tokens.includes(token),
  );
}

function inferFileChangeKind(toolName: string | undefined, outcome: ObjectiveStateOutcome): ObjectiveStateChangeKind {
  if (outcome === "failure") return "failed";
  const tokens = toolNameTokens(toolName);
  if (["delete", "remove", "unlink"].some((token) => tokens.includes(token))) return "deleted";
  if (["create", "mkdir", "new"].some((token) => tokens.includes(token))) return "created";
  if (["write", "edit", "patch", "update", "append", "move", "rename"].some((token) => tokens.includes(token))) {
    return "updated";
  }
  return "observed";
}

function buildFileValueRefs(
  args: Record<string, unknown> | undefined,
  changeKind: ObjectiveStateChangeKind,
): Pick<ObjectiveStateSnapshot, "before" | "after"> {
  const { sourcePath, destinationPath, scope } = fileScopeFromArgs(args);
  const contentHash = fileContentHash(args);

  if (changeKind === "failed") {
    if (sourcePath && destinationPath && sourcePath !== destinationPath) {
      return {
        before: { ref: sourcePath },
        after: { ref: destinationPath },
      };
    }
    return {
      before: sourcePath ? { ref: sourcePath } : undefined,
      after: scope ? { ref: scope } : undefined,
    };
  }

  if (changeKind === "deleted") {
    return {
      before: scope ? { exists: true, ref: scope } : undefined,
      after: { exists: false },
    };
  }

  if (changeKind === "created") {
    return {
      after: {
        exists: true,
        ref: scope,
        valueHash: contentHash,
      },
    };
  }

  if (sourcePath && destinationPath && sourcePath !== destinationPath) {
    return {
      before: { exists: true, ref: sourcePath },
      after: {
        exists: true,
        ref: destinationPath,
      },
    };
  }

  return {
    after: {
      exists: true,
      ref: scope,
      valueHash: contentHash,
    },
  };
}

function summarizeSnapshot(
  kind: ObjectiveStateSnapshot["kind"],
  changeKind: ObjectiveStateChangeKind,
  toolName: string,
  scope: string,
): string {
  const action =
    changeKind === "executed"
      ? "Executed"
      : changeKind === "failed"
        ? "Failed"
        : changeKind === "created"
          ? "Created"
          : changeKind === "deleted"
            ? "Deleted"
            : changeKind === "updated"
              ? "Updated"
              : "Observed";
  if (kind === "process") return `${action} process via ${toolName}: ${scope}`;
  if (kind === "file") return `${action} file via ${toolName}: ${scope}`;
  return `${action} tool result from ${toolName}: ${scope}`;
}

function buildGenericToolAfterRef(outcome: ObjectiveStateOutcome, parsedPayload: unknown): ObjectiveStateSnapshot["after"] {
  const valueHash = resultHash(parsedPayload);
  return valueHash ? { valueHash } : { exists: outcome !== "failure" };
}

function snapshotIdFor(
  sessionKey: string,
  recordedAt: string,
  index: number,
  toolName: string,
  scope: string,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${sessionKey}|${recordedAt}|${index}|${toolName}|${scope}`)
    .digest("hex")
    .slice(0, 12);
  return `obj-${digest}`;
}

export function deriveObjectiveStateSnapshotsFromAgentMessages(options: {
  sessionKey: string;
  recordedAt: string;
  messages: Array<Record<string, unknown>>;
}): ObjectiveStateSnapshot[] {
  const toolCallsById = getToolCallContexts(options.messages);
  const snapshots: ObjectiveStateSnapshot[] = [];

  for (const message of options.messages) {
    if (message.role !== "tool") continue;
    const toolCallId = toolCallIdForMessage(message);
    const context = toolCallId ? toolCallsById.get(toolCallId) : undefined;
    const toolName = toolNameForMessage(message, context);
    if (!toolName) continue;

    const parsedPayload = parseToolResultPayload(message.content);
    const outcome = inferOutcome(message, parsedPayload);
    const args = context?.args;
    const command = pickString(args, ["cmd", "command", "script"]);

    let kind: ObjectiveStateSnapshot["kind"] = "tool";
    let changeKind: ObjectiveStateChangeKind = outcome === "failure" ? "failed" : "observed";
    let scope = toolName;
    let before: ObjectiveStateSnapshot["before"];
    let after: ObjectiveStateSnapshot["after"];

    if (isProcessTool(toolName, args)) {
      kind = "process";
      changeKind = outcome === "failure" ? "failed" : "executed";
      scope = command ?? toolName;
      after = { exists: outcome !== "failure", valueHash: resultHash(parsedPayload) };
    } else if (isFileTool(toolName, args)) {
      kind = "file";
      changeKind = inferFileChangeKind(toolName, outcome);
      const fileScope = fileScopeFromArgs(args);
      scope = fileScope.scope ?? toolName;
      const refs = buildFileValueRefs(args, changeKind);
      before = refs.before;
      after = refs.after;
    } else {
      after = buildGenericToolAfterRef(outcome, parsedPayload);
    }

    snapshots.push({
      schemaVersion: 1,
      snapshotId: snapshotIdFor(options.sessionKey, options.recordedAt, snapshots.length, toolName, scope),
      recordedAt: options.recordedAt,
      sessionKey: options.sessionKey,
      source: "tool_result",
      kind,
      changeKind,
      scope,
      summary: summarizeSnapshot(kind, changeKind, toolName, scope),
      toolName,
      command,
      outcome,
      before,
      after,
      tags: ["agent-end", `tool:${toolName}`],
      metadata: toolCallId ? { toolCallId } : undefined,
    });
  }

  return snapshots;
}

export async function recordObjectiveStateSnapshotsFromAgentMessages(options: {
  memoryDir: string;
  objectiveStateStoreDir?: string;
  objectiveStateMemoryEnabled: boolean;
  objectiveStateSnapshotWritesEnabled: boolean;
  sessionKey: string;
  recordedAt: string;
  messages: Array<Record<string, unknown>>;
}): Promise<DerivedObjectiveStateResult> {
  if (!options.objectiveStateMemoryEnabled || !options.objectiveStateSnapshotWritesEnabled) {
    return { snapshots: [], filePaths: [] };
  }

  const snapshots = deriveObjectiveStateSnapshotsFromAgentMessages({
    sessionKey: options.sessionKey,
    recordedAt: options.recordedAt,
    messages: options.messages,
  });

  const filePaths: string[] = [];
  for (const snapshot of snapshots) {
    filePaths.push(
      await recordObjectiveStateSnapshot({
        memoryDir: options.memoryDir,
        objectiveStateStoreDir: options.objectiveStateStoreDir,
        snapshot,
      }),
    );
  }

  return { snapshots, filePaths };
}
