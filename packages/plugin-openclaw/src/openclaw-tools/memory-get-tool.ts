import {
  getMemoryForActiveMemory,
  type ActiveMemoryGetOutput,
} from "../../../remnic-core/src/index.js";
import { MemoryGetInputSchema } from "./shapes.js";

function toolJsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: undefined,
  };
}

export function buildMemoryGetTool(
  orchestrator: unknown,
  options: {
    getMemoryForActiveMemory?: typeof getMemoryForActiveMemory;
  } = {},
) {
  const getMemory = options.getMemoryForActiveMemory ?? getMemoryForActiveMemory;
  return {
    name: "memory_get",
    description: "Fetch one Remnic memory for the OpenClaw active-memory surface.",
    inputSchema: MemoryGetInputSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const id =
        typeof params.id === "string" && params.id.trim().length > 0 ? params.id : null;
      if (!id) {
        throw new Error("memory_get requires an id");
      }
      const result: ActiveMemoryGetOutput = await getMemory(orchestrator as never, id);
      return toolJsonResult(result);
    },
  };
}
