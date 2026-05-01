export type LcmMessagePartKind =
  | "text"
  | "tool_call"
  | "tool_result"
  | "patch"
  | "file_read"
  | "file_write"
  | "step_start"
  | "step_finish"
  | "snapshot"
  | "retry";

export const LCM_MESSAGE_PART_KINDS: readonly LcmMessagePartKind[] = [
  "text",
  "tool_call",
  "tool_result",
  "patch",
  "file_read",
  "file_write",
  "step_start",
  "step_finish",
  "snapshot",
  "retry",
] as const;

export type MessagePartSourceFormat =
  | "openai"
  | "anthropic"
  | "openclaw"
  | "lossless-claw"
  | "remnic";

export interface LcmMessagePartInput {
  ordinal?: number;
  kind: LcmMessagePartKind;
  payload: Record<string, unknown>;
  toolName?: string | null;
  filePath?: string | null;
  createdAt?: string | null;
}

export interface LcmMessagePartRow extends LcmMessagePartInput {
  id: number;
  messageId: number;
  ordinal: number;
  payloadJson: string;
  createdAt: string;
}

export interface ParseMessagePartsOptions {
  sourceFormat?: MessagePartSourceFormat;
  renderedContent?: string;
}

const SECRET_KEY_RE = /(api[_-]?key|authorization|bearer|credential|password|secret|token)/i;
const MAX_PAYLOAD_STRING = 8_000;
const FILE_PATH_RE =
  /(?:^|[\s"'`(])((?:\.{1,2}\/|\/|~\/)?[\w@.-][\w@./ -]*\.[A-Za-z0-9_+-]{1,12})(?=$|[\s"'`),:;])/g;

export function isLcmMessagePartKind(value: unknown): value is LcmMessagePartKind {
  return (
    typeof value === "string" &&
    (LCM_MESSAGE_PART_KINDS as readonly string[]).includes(value)
  );
}

export function parseMessageParts(
  input: unknown,
  options: ParseMessagePartsOptions = {},
): LcmMessagePartInput[] {
  const explicit = normalizeExplicitParts(input);
  if (explicit.length > 0) return explicit;

  const format = options.sourceFormat ?? inferSourceFormat(input);
  switch (format) {
    case "openai":
      return parseOpenAiMessageParts(input, options);
    case "anthropic":
      return parseAnthropicMessageParts(input, options);
    case "openclaw":
      return parseOpenClawMessageParts(input, options);
    case "lossless-claw":
    case "remnic":
      return normalizeExplicitParts(input);
    default:
      return [];
  }
}

export function normalizeExplicitParts(input: unknown): LcmMessagePartInput[] {
  const rawParts = pickArray(input, "parts") ?? pickArray(input, "message_parts");
  if (!rawParts) return [];

  const parts: LcmMessagePartInput[] = [];
  rawParts.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const obj = raw as Record<string, unknown>;
    const kind = normalizeKind(obj.kind ?? obj.type);
    if (!kind) return;

    const payload =
      obj.payload && typeof obj.payload === "object" && !Array.isArray(obj.payload)
        ? (obj.payload as Record<string, unknown>)
        : { value: sanitizePayload(obj) };
    const toolName = asNonEmptyString(obj.toolName ?? obj.tool_name ?? obj.name);
    const filePath = asNonEmptyString(obj.filePath ?? obj.file_path ?? obj.path);
    const ordinal =
      typeof obj.ordinal === "number" && Number.isInteger(obj.ordinal)
        ? Math.max(0, obj.ordinal)
        : index;

    parts.push({
      ordinal,
      kind,
      payload: sanitizePayload(payload) as Record<string, unknown>,
      toolName,
      filePath,
      createdAt: asNonEmptyString(obj.createdAt ?? obj.created_at),
    });
  });
  return parts;
}

export function parseOpenAiMessageParts(
  input: unknown,
  _options: ParseMessagePartsOptions = {},
): LcmMessagePartInput[] {
  const items = gatherOpenAiItems(input);
  const parts: LcmMessagePartInput[] = [];
  for (const item of items) {
    const type = asNonEmptyString(item.type) ?? asNonEmptyString(item.kind);
    if (!type) continue;
    if (type === "message") {
      for (const block of gatherContentBlocks(item.content)) {
        const text = asNonEmptyString(block.text ?? block.content);
        if (text) parts.push(makePart("text", { type, text }, { filePath: firstFilePath(text) }));
      }
      continue;
    }
    if (type === "function_call") {
      const toolName = asNonEmptyString(item.name ?? item.tool_name);
      const payload = {
        id: item.id ?? item.call_id,
        name: toolName,
        arguments: parseMaybeJson(item.arguments),
      };
      parts.push(classifyToolPart(toolName, payload));
      continue;
    }
    if (type === "function_call_output") {
      const output = asNonEmptyString(item.output) ?? JSON.stringify(sanitizePayload(item.output ?? item));
      parts.push(makePart("tool_result", { id: item.id ?? item.call_id, output }, {
        filePath: firstFilePath(output),
      }));
      continue;
    }
    if (type === "reasoning") {
      parts.push(makePart("step_start", { type, summary: sanitizePayload(item.summary ?? item) }));
      continue;
    }
    if (type === "retry") {
      parts.push(makePart("retry", { type, item: sanitizePayload(item) }));
    }
  }
  return withOrdinals(parts);
}

export function parseAnthropicMessageParts(
  input: unknown,
  _options: ParseMessagePartsOptions = {},
): LcmMessagePartInput[] {
  const blocks = gatherContentBlocks(
    Array.isArray(input) ? input : input && typeof input === "object" ? (input as Record<string, unknown>).content : input,
  );
  const parts: LcmMessagePartInput[] = [];
  for (const block of blocks) {
    const type = asNonEmptyString(block.type);
    if (type === "text") {
      const text = asNonEmptyString(block.text);
      if (text) parts.push(makePart("text", { type, text }, { filePath: firstFilePath(text) }));
      continue;
    }
    if (type === "tool_use") {
      const toolName = asNonEmptyString(block.name);
      parts.push(classifyToolPart(toolName, {
        id: block.id,
        name: toolName,
        input: sanitizePayload(block.input),
      }));
      continue;
    }
    if (type === "tool_result") {
      const content = block.content;
      const rendered = renderUnknownContent(content);
      parts.push(makePart("tool_result", { id: block.tool_use_id, content: sanitizePayload(content) }, {
        filePath: firstFilePath(rendered),
      }));
      continue;
    }
    if (type === "thinking") {
      parts.push(makePart("step_start", {
        type,
        thinking: truncateString(asNonEmptyString(block.thinking) ?? ""),
        signature: asNonEmptyString(block.signature),
      }));
      continue;
    }
    if (type === "redacted_thinking") {
      parts.push(makePart("step_finish", { type }));
    }
  }
  return withOrdinals(parts);
}

export function parseOpenClawMessageParts(
  input: unknown,
  options: ParseMessagePartsOptions = {},
): LcmMessagePartInput[] {
  const explicit = normalizeExplicitParts(input);
  if (explicit.length > 0) return explicit;
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;

  const content = obj.content;
  if (Array.isArray(content)) {
    const hasAnthropicBlocks = content.some(
      (block) =>
        block &&
        typeof block === "object" &&
        typeof (block as Record<string, unknown>).type === "string",
    );
    if (hasAnthropicBlocks) return parseAnthropicMessageParts({ content }, options);
  }

  const toolName = asNonEmptyString(obj.toolName ?? obj.tool_name ?? obj.name);
  if (toolName) {
    return withOrdinals([
      classifyToolPart(toolName, {
        name: toolName,
        input: sanitizePayload(obj.input ?? obj.arguments ?? obj.params),
        output: sanitizePayload(obj.output ?? obj.result),
      }),
    ]);
  }

  const rendered = options.renderedContent ?? asNonEmptyString(obj.content);
  return rendered ? withOrdinals(partsFromRenderedText(rendered)) : [];
}

export function partsFromRenderedText(text: string): LcmMessagePartInput[] {
  if (!text.includes("*** Begin Patch") && !FILE_PATH_RE.test(text)) {
    FILE_PATH_RE.lastIndex = 0;
    return [];
  }
  FILE_PATH_RE.lastIndex = 0;
  const paths = extractFilePaths(text);
  if (text.includes("*** Begin Patch")) {
    const patchPaths = extractPatchPaths(text);
    return withOrdinals((patchPaths.length > 0 ? patchPaths : paths).map((filePath) =>
      makePart("patch", { text: truncateString(text) }, { filePath })
    ));
  }
  return withOrdinals(paths.map((filePath) =>
    makePart("file_read", { text: truncateString(text) }, { filePath })
  ));
}

function inferSourceFormat(input: unknown): MessagePartSourceFormat | undefined {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const explicit = asNonEmptyString(obj.sourceFormat ?? obj.source_format);
    if (explicit === "openai" || explicit === "anthropic" || explicit === "openclaw" || explicit === "lossless-claw" || explicit === "remnic") {
      return explicit;
    }
    if (Array.isArray(obj.output)) return "openai";
    if (Array.isArray(obj.content)) return "anthropic";
  }
  if (Array.isArray(input)) return "anthropic";
  return undefined;
}

function gatherOpenAiItems(input: unknown): Record<string, unknown>[] {
  if (Array.isArray(input)) return input.filter(isRecord);
  if (!isRecord(input)) return [];
  if (Array.isArray(input.output)) return input.output.filter(isRecord);
  if (Array.isArray(input.items)) return input.items.filter(isRecord);
  return [input];
}

function gatherContentBlocks(input: unknown): Record<string, unknown>[] {
  if (Array.isArray(input)) return input.filter(isRecord);
  if (typeof input === "string") return [{ type: "text", text: input }];
  if (isRecord(input)) return [input];
  return [];
}

function classifyToolPart(
  toolName: string | null | undefined,
  payload: Record<string, unknown>,
): LcmMessagePartInput {
  const normalized = (toolName ?? "").toLowerCase();
  const rendered = renderUnknownContent(payload);
  const filePath =
    firstFilePathFromObject(payload) ?? firstFilePath(rendered) ?? null;

  if (normalized.includes("apply_patch") || rendered.includes("*** Begin Patch")) {
    return makePart("patch", payload, { toolName, filePath: filePath ?? extractPatchPaths(rendered)[0] ?? null });
  }
  if (/(write|edit|multiedit|create|save)/i.test(normalized)) {
    return makePart("file_write", payload, { toolName, filePath });
  }
  if (/(read|grep|glob|search|list|ls)/i.test(normalized)) {
    return makePart("file_read", payload, { toolName, filePath });
  }
  return makePart("tool_call", payload, { toolName, filePath });
}

function makePart(
  kind: LcmMessagePartKind,
  payload: Record<string, unknown>,
  options: { toolName?: string | null; filePath?: string | null } = {},
): LcmMessagePartInput {
  return {
    kind,
    payload: sanitizePayload(payload) as Record<string, unknown>,
    toolName: options.toolName ?? null,
    filePath: options.filePath ?? null,
  };
}

function withOrdinals(parts: LcmMessagePartInput[]): LcmMessagePartInput[] {
  return parts.map((part, ordinal) => ({ ...part, ordinal: part.ordinal ?? ordinal }));
}

function normalizeKind(value: unknown): LcmMessagePartKind | null {
  if (isLcmMessagePartKind(value)) return value;
  if (value === "tool_use" || value === "function_call") return "tool_call";
  if (value === "function_call_output") return "tool_result";
  if (value === "thinking" || value === "reasoning") return "step_start";
  return null;
}

function pickArray(input: unknown, key: string): unknown[] | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return sanitizePayload(value);
  try {
    return sanitizePayload(JSON.parse(value));
  } catch {
    return truncateString(value);
  }
}

function sanitizePayload(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= 4) return "[truncated]";
    return value.slice(0, 100).map((item) => sanitizePayload(item, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 4) return "[truncated]";
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : sanitizePayload(child, depth + 1);
    }
    return out;
  }
  return String(value);
}

function truncateString(value: string): string {
  return value.length > MAX_PAYLOAD_STRING
    ? `${value.slice(0, MAX_PAYLOAD_STRING)}...[truncated]`
    : value;
}

function renderUnknownContent(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function firstFilePathFromObject(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const keys = ["file_path", "filePath", "path", "filename", "cwd"];
  for (const key of keys) {
    const candidate = asNonEmptyString(value[key]);
    if (candidate) return candidate;
  }
  for (const child of Object.values(value)) {
    if (typeof child === "string") {
      const fromText = extractPatchPaths(child)[0] ?? firstFilePath(child);
      if (fromText) return fromText;
    }
    if (isRecord(child)) {
      const nested = firstFilePathFromObject(child);
      if (nested) return nested;
    }
  }
  return null;
}

function firstFilePath(text: string): string | null {
  return extractFilePaths(text)[0] ?? null;
}

function extractFilePaths(text: string): string[] {
  const out = new Set<string>();
  FILE_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    const candidate = normalizeFilePathCandidate(match[1] ?? "");
    if (candidate.length > 0 && !candidate.includes("://")) out.add(candidate);
  }
  return [...out].slice(0, 20);
}

function normalizeFilePathCandidate(raw: string): string {
  const trimmed = raw.trim();
  if (!/\s/.test(trimmed)) return trimmed;
  const tokens = trimmed.split(/\s+/).reverse();
  return tokens.find((token) => token.includes("/") || /\.[A-Za-z0-9_+-]{1,12}$/.test(token)) ?? trimmed;
}

function extractPatchPaths(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match?.[1]) out.add(match[1].trim());
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (move?.[1]) out.add(move[1].trim());
  }
  return [...out].slice(0, 20);
}
