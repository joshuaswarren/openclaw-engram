// ---------------------------------------------------------------------------
// WeClone preprocessed export parser
// ---------------------------------------------------------------------------

import type { BulkImportSource, ImportTurn } from "@remnic/core";
import { validateImportTurn, parseIsoTimestamp } from "@remnic/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WeClonePlatform = "telegram" | "whatsapp" | "discord" | "slack";

const VALID_PLATFORMS: ReadonlySet<string> = new Set([
  "telegram",
  "whatsapp",
  "discord",
  "slack",
]);

export interface WeClonePreprocessedMessage {
  sender: string;
  text: string;
  timestamp: string;
  reply_to_id?: string;
  message_id?: string;
}

export interface WeClonePreprocessedExport {
  platform: WeClonePlatform;
  messages: WeClonePreprocessedMessage[];
  export_date?: string;
}

export interface ParseOptions {
  /** Override the platform field from the export. */
  platform?: WeClonePlatform;
  /** When true, throw on any validation failure instead of skipping. */
  strict?: boolean;
  /**
   * Sender name that identifies the user (i.e. "self").
   * Defaults to the first sender encountered in the messages array.
   */
  selfSender?: string;
  /**
   * Sender names that should be treated as "assistant" (bot/AI).
   * Messages from other senders are assigned the "other" role.
   */
  assistantSenders?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AI_SENDER_HINTS: ReadonlySet<string> = new Set([
  "bot",
  "assistant",
  "ai",
  "chatgpt",
  "gpt",
  "claude",
  "copilot",
]);

function looksLikeBot(sender: string): boolean {
  const lower = sender.toLowerCase();
  for (const hint of AI_SENDER_HINTS) {
    if (lower.includes(hint)) return true;
  }
  return false;
}

function resolveRole(
  sender: string,
  selfSender: string,
  assistantSenders: ReadonlySet<string>,
): ImportTurn["role"] {
  if (sender === selfSender) return "user";
  if (assistantSenders.has(sender) || looksLikeBot(sender)) return "assistant";
  return "other";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidMessage(
  msg: unknown,
): msg is WeClonePreprocessedMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return isNonEmptyString(m.sender) && isNonEmptyString(m.text) && isNonEmptyString(m.timestamp);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a WeClone preprocessed export into a `BulkImportSource`.
 *
 * Accepts either:
 * - A `WeClonePreprocessedExport` object with `messages` array
 * - A raw array of `WeClonePreprocessedMessage` items
 */
export function parseWeCloneExport(
  input: unknown,
  options?: ParseOptions,
): BulkImportSource {
  if (!input || typeof input !== "object") {
    throw new Error(
      "WeClone import: input must be a non-null object or array",
    );
  }

  const strict = options?.strict === true;

  // Accept raw array or object-with-messages
  let rawMessages: unknown[];
  let platformStr: string | undefined;
  let exportDate: string | undefined;

  if (Array.isArray(input)) {
    rawMessages = input;
  } else {
    const obj = input as Record<string, unknown>;
    if (!Array.isArray(obj.messages)) {
      throw new Error(
        "WeClone import: input must have a 'messages' array",
      );
    }
    rawMessages = obj.messages;
    platformStr = typeof obj.platform === "string"
      ? obj.platform
      : undefined;
    exportDate = typeof obj.export_date === "string"
      ? obj.export_date
      : undefined;
  }

  if (rawMessages.length === 0) {
    throw new Error("WeClone import: messages array must not be empty");
  }

  // Resolve platform
  const platform: WeClonePlatform = resolvePlatform(
    options?.platform,
    platformStr,
  );

  // Determine self sender
  const firstValidMsg = rawMessages.find(isValidMessage);
  const selfSender = options?.selfSender
    ?? (firstValidMsg ? firstValidMsg.sender : "");
  const assistantSet = new Set<string>(options?.assistantSenders ?? []);

  // Map messages to ImportTurn[]
  const turns: ImportTurn[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < rawMessages.length; i += 1) {
    const raw = rawMessages[i];
    if (!isValidMessage(raw)) {
      const msg =
        `WeClone import: message at index ${i} is invalid ` +
        `(must have sender, text, timestamp as non-empty strings)`;
      if (strict) throw new Error(msg);
      warnings.push(msg);
      continue;
    }

    const turn: ImportTurn = {
      role: resolveRole(raw.sender, selfSender, assistantSet),
      content: raw.text,
      timestamp: raw.timestamp,
      participantId: raw.sender,
      participantName: raw.sender,
      ...(raw.reply_to_id != null ? { replyToId: raw.reply_to_id } : {}),
    };

    // Validate the turn using core's validator
    const issues = validateImportTurn(turn, i);
    if (issues.length > 0) {
      const detail = issues.map((iss) => iss.message).join("; ");
      if (strict) {
        throw new Error(
          `WeClone import: turn at index ${i} failed validation: ${detail}`,
        );
      }
      warnings.push(
        `WeClone import: skipping message at index ${i}: ${detail}`,
      );
      continue;
    }

    turns.push(turn);
  }

  if (turns.length === 0) {
    throw new Error(
      "WeClone import: no valid turns after parsing all messages",
    );
  }

  // Log warnings (non-strict mode)
  if (warnings.length > 0) {
    for (const w of warnings) {
      // eslint-disable-next-line no-console
      console.warn(w);
    }
  }

  // Build metadata
  const timestamps = turns
    .map((t) => parseIsoTimestamp(t.timestamp))
    .filter((ts): ts is number => ts !== null);
  timestamps.sort((a, b) => a - b);

  const from = timestamps.length > 0
    ? new Date(timestamps[0]).toISOString()
    : turns[0].timestamp;
  const to = timestamps.length > 0
    ? new Date(timestamps[timestamps.length - 1]).toISOString()
    : turns[turns.length - 1].timestamp;

  return {
    turns,
    metadata: {
      source: `weclone-${platform}`,
      exportDate: exportDate ?? new Date().toISOString(),
      messageCount: turns.length,
      dateRange: { from, to },
    },
  };
}

// ---------------------------------------------------------------------------
// Platform resolution
// ---------------------------------------------------------------------------

function resolvePlatform(
  optionsPlatform: WeClonePlatform | undefined,
  exportPlatform: string | undefined,
): WeClonePlatform {
  if (optionsPlatform !== undefined) {
    if (!VALID_PLATFORMS.has(optionsPlatform)) {
      throw new Error(
        `WeClone import: invalid platform '${optionsPlatform}'. ` +
        `Valid: ${[...VALID_PLATFORMS].join(", ")}`,
      );
    }
    return optionsPlatform;
  }
  if (exportPlatform !== undefined && VALID_PLATFORMS.has(exportPlatform)) {
    return exportPlatform as WeClonePlatform;
  }
  // Default to telegram if unspecified
  return "telegram";
}
