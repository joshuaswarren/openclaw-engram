import { LEGACY_PLUGIN_ID, PLUGIN_ID } from "../../remnic-core/src/plugin-id.js";

export type SlotMismatchMode = "error" | "warn" | "silent";
export type SlotValidationResult = "ok" | "passive";

export interface SlotValidationContext {
  pluginId: string;
  runtimeConfig: unknown;
  requireExclusive: boolean;
  onMismatch: SlotMismatchMode;
  logger: {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}

function resolveMemorySlot(runtimeConfig: unknown): string | undefined {
  if (!runtimeConfig || typeof runtimeConfig !== "object") return undefined;
  const plugins = (runtimeConfig as Record<string, unknown>).plugins;
  if (!plugins || typeof plugins !== "object") return undefined;
  const slots = (plugins as Record<string, unknown>).slots;
  if (!slots || typeof slots !== "object") return undefined;
  const memory = (slots as Record<string, unknown>).memory;
  return typeof memory === "string" && memory.trim().length > 0
    ? memory.trim()
    : undefined;
}

function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i += 1) {
    matrix[i]![0] = i;
  }
  for (let j = 0; j < cols; j += 1) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + substitutionCost,
      );
    }
  }

  return matrix[rows - 1]![cols - 1]!;
}

function suggestLikelyRemnicSlot(pluginId: string, actualSlot: string): string {
  const candidates = Array.from(new Set([pluginId, PLUGIN_ID, LEGACY_PLUGIN_ID]));
  let best = candidates[0] ?? pluginId;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = levenshteinDistance(actualSlot, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

function mismatchMessage(pluginId: string, actualSlot: string): string {
  const suggestedSlot = suggestLikelyRemnicSlot(pluginId, actualSlot);
  return [
    `[remnic] plugins.slots.memory is set to "${actualSlot}", so ${pluginId} will not attach active memory hooks.`,
    `If you meant Remnic here, the closest known memory-slot plugin id is "${suggestedSlot}".`,
    `Set plugins.slots.memory to "${pluginId}" to make Remnic the active memory plugin,`,
    `or set slotBehavior.onSlotMismatch = "silent" to load passively on purpose.`,
    "See docs/plugins/openclaw.md#slot-selection for the full contract.",
  ].join(" ");
}

export function validateSlotSelection(
  ctx: SlotValidationContext,
): SlotValidationResult {
  const actualSlot = resolveMemorySlot(ctx.runtimeConfig);
  if (!actualSlot) {
    if (
      ctx.requireExclusive &&
      ctx.runtimeConfig &&
      typeof ctx.runtimeConfig === "object"
    ) {
      ctx.logger.warn?.(
        `[remnic] plugins.slots.memory is unset; set it to "${ctx.pluginId}" for explicit memory-slot ownership.`,
      );
    }
    return "ok";
  }

  if (actualSlot === ctx.pluginId) {
    return "ok";
  }

  const message = mismatchMessage(ctx.pluginId, actualSlot);
  if (ctx.onMismatch === "error") {
    throw new Error(message);
  }
  if (ctx.onMismatch === "warn") {
    ctx.logger.warn?.(message);
  }
  return "passive";
}
