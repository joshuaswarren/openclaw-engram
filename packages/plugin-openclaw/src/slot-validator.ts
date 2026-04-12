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

function mismatchMessage(pluginId: string, actualSlot: string): string {
  return [
    `[remnic] plugins.slots.memory is set to "${actualSlot}", so ${pluginId} will not attach active memory hooks.`,
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
