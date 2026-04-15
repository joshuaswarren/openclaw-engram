import type { CodexCompatConfig } from "./types.js";

export const CODEX_THREAD_KEY_PREFIX = "codex-thread:";

function readModelId(
  source: Record<string, unknown> | undefined,
): string | null {
  if (!source) return null;
  const provider = source.provider;
  if (provider && typeof provider === "object") {
    const model =
      (provider as Record<string, unknown>).model ??
      (provider as Record<string, unknown>).modelId;
    if (typeof model === "string" && model.length > 0) return model;
  }
  const directModel = source.modelId ?? source.model;
  return typeof directModel === "string" && directModel.length > 0
    ? directModel
    : null;
}

export function isCodexProvider(
  source: Record<string, unknown> | undefined,
): boolean {
  if (!source || typeof source !== "object") return false;
  const provider =
    source.provider && typeof source.provider === "object"
      ? (source.provider as Record<string, unknown>)
      : undefined;
  const providerId = provider?.id ?? source.providerId;
  if (providerId === "codex") return true;

  const providerName = provider?.name ?? source.providerName;
  if (
    typeof providerName === "string" &&
    (providerName === "codex" || providerName.startsWith("codex/"))
  ) {
    return true;
  }

  const modelId = readModelId(source);
  if (typeof modelId === "string" && modelId.startsWith("codex/")) {
    return true;
  }

  const providerThreadId =
    source.providerThreadId ??
    provider?.threadId ??
    (provider?.thread &&
    typeof provider.thread === "object" &&
    typeof (provider.thread as Record<string, unknown>).id === "string"
      ? (provider.thread as Record<string, unknown>).id
      : undefined) ??
    source.codexThreadId;

  return typeof providerThreadId === "string" && providerThreadId.length > 0;
}

export function extractCodexThreadId(
  source: Record<string, unknown> | undefined,
): string | null {
  if (!source || typeof source !== "object") return null;
  const provider =
    source.provider && typeof source.provider === "object"
      ? (source.provider as Record<string, unknown>)
      : undefined;
  const threadId =
    source.providerThreadId ??
    provider?.threadId ??
    (provider?.thread &&
    typeof provider.thread === "object" &&
    typeof (provider.thread as Record<string, unknown>).id === "string"
      ? (provider.thread as Record<string, unknown>).id
      : undefined) ??
    source.codexThreadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
}

export function codexLogicalSessionKey(providerThreadId: string): string {
  return `${CODEX_THREAD_KEY_PREFIX}${providerThreadId}`;
}

export function extractProviderMessageCount(
  source: Record<string, unknown> | undefined,
): number | null {
  if (!source || typeof source !== "object") return null;
  const directCount = source.messageCount;
  if (typeof directCount === "number" && Number.isFinite(directCount)) {
    return directCount;
  }
  if (Array.isArray(source.messages)) {
    return source.messages.length;
  }
  return null;
}

export interface CodexSessionIdentity {
  sessionKey: string;
  logicalSessionKey: string;
  isCodex: boolean;
  providerThreadId: string | null;
  modelId: string | null;
  messageCount: number | null;
}

export function resolveCodexSessionIdentity(input: {
  sessionKey?: string | null;
  event?: Record<string, unknown>;
  ctx?: Record<string, unknown>;
  codexCompat?: CodexCompatConfig;
}): CodexSessionIdentity {
  const sessionKey =
    typeof input.sessionKey === "string" && input.sessionKey.length > 0
      ? input.sessionKey
      : "default";
  const event = input.event ?? undefined;
  const ctx = input.ctx ?? undefined;
  const compat = input.codexCompat;
  const codex =
    compat?.enabled !== false && (isCodexProvider(ctx) || isCodexProvider(event));
  const providerThreadId =
    compat?.enabled === false
      ? null
      : extractCodexThreadId(ctx) ?? extractCodexThreadId(event);
  const logicalSessionKey =
    codex &&
    compat?.threadIdBufferKeying !== false &&
    typeof providerThreadId === "string"
      ? codexLogicalSessionKey(providerThreadId)
      : sessionKey;

  return {
    sessionKey,
    logicalSessionKey,
    isCodex: codex,
    providerThreadId,
    modelId: readModelId(ctx) ?? readModelId(event),
    messageCount:
      extractProviderMessageCount(ctx) ?? extractProviderMessageCount(event),
  };
}

export function buildTurnFingerprint(input: {
  role: "user" | "assistant";
  content: string;
  logicalSessionKey: string;
  providerThreadId?: string | null;
  messageCount?: number | null;
  turnIndex: number;
}): string {
  const normalizedContent = input.content.replace(/\s+/g, " ").trim();
  return [
    input.role,
    normalizedContent,
    input.providerThreadId ?? input.logicalSessionKey,
    typeof input.messageCount === "number" ? String(input.messageCount) : "na",
    String(input.turnIndex),
  ].join("\u0001");
}
