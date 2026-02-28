import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { clamp01, clampLifecycleThreshold } from "./lifecycle.js";
import { clampInstructionHeavyTokenCap } from "./recall-query-policy.js";
import type { BehaviorLoopPolicyState, PluginConfig } from "./types.js";

export interface RuntimePolicyValues {
  recencyWeight?: number;
  lifecyclePromoteHeatThreshold?: number;
  lifecycleStaleDecayThreshold?: number;
  cronRecallInstructionHeavyTokenCap?: number;
}

interface RuntimePolicySnapshot {
  version: number;
  updatedAt: string;
  values: RuntimePolicyValues;
  sourceAdjustmentCount: number;
}

const RUNTIME_POLICY_VERSION = 1;
const RUNTIME_POLICY_FILE = "policy-runtime.json";
const RUNTIME_POLICY_PREV_FILE = "policy-runtime.prev.json";

function sanitizeRuntimePolicyValues(values: RuntimePolicyValues): RuntimePolicyValues {
  const out: RuntimePolicyValues = {};
  if (typeof values.recencyWeight === "number") {
    out.recencyWeight = clamp01(values.recencyWeight);
  }
  if (typeof values.lifecyclePromoteHeatThreshold === "number") {
    out.lifecyclePromoteHeatThreshold = clampLifecycleThreshold(values.lifecyclePromoteHeatThreshold);
  }
  if (typeof values.lifecycleStaleDecayThreshold === "number") {
    out.lifecycleStaleDecayThreshold = clampLifecycleThreshold(values.lifecycleStaleDecayThreshold);
  }
  if (typeof values.cronRecallInstructionHeavyTokenCap === "number") {
    out.cronRecallInstructionHeavyTokenCap = clampInstructionHeavyTokenCap(
      values.cronRecallInstructionHeavyTokenCap,
    );
  }
  return out;
}

function isRuntimeParameter(parameter: string): parameter is keyof RuntimePolicyValues {
  return (
    parameter === "recencyWeight" ||
    parameter === "lifecyclePromoteHeatThreshold" ||
    parameter === "lifecycleStaleDecayThreshold" ||
    parameter === "cronRecallInstructionHeavyTokenCap"
  );
}

async function readSnapshot(filePath: string): Promise<RuntimePolicySnapshot | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RuntimePolicySnapshot>;
    if (
      !parsed ||
      typeof parsed.version !== "number" ||
      parsed.version < 1 ||
      typeof parsed.updatedAt !== "string" ||
      !parsed.values ||
      typeof parsed.values !== "object" ||
      typeof parsed.sourceAdjustmentCount !== "number" ||
      parsed.sourceAdjustmentCount < 0
    ) {
      return null;
    }
    return {
      version: parsed.version,
      updatedAt: parsed.updatedAt,
      values: sanitizeRuntimePolicyValues(parsed.values),
      sourceAdjustmentCount: parsed.sourceAdjustmentCount,
    };
  } catch {
    return null;
  }
}

async function writeSnapshotAtomic(filePath: string, snapshot: RuntimePolicySnapshot): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  await rename(tempPath, filePath);
}

export class PolicyRuntimeManager {
  private readonly runtimePath: string;
  private readonly runtimePrevPath: string;

  constructor(
    private readonly memoryDir: string,
    private readonly config: PluginConfig,
  ) {
    const stateDir = path.join(memoryDir, "state");
    this.runtimePath = path.join(stateDir, RUNTIME_POLICY_FILE);
    this.runtimePrevPath = path.join(stateDir, RUNTIME_POLICY_PREV_FILE);
  }

  async loadRuntimeValues(): Promise<RuntimePolicyValues | null> {
    const snapshot = await readSnapshot(this.runtimePath);
    if (!snapshot) return null;
    return snapshot.values;
  }

  async rollback(): Promise<boolean> {
    const previous = await readSnapshot(this.runtimePrevPath);
    if (!previous) return false;
    await writeSnapshotAtomic(this.runtimePath, {
      ...previous,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  async applyFromBehaviorState(
    state: BehaviorLoopPolicyState,
  ): Promise<{ applied: boolean; rolledBack: boolean; values: RuntimePolicyValues | null; reason: string }> {
    const adjustmentCount = state.adjustments.length;
    if (adjustmentCount === 0) {
      return { applied: false, rolledBack: false, values: await this.loadRuntimeValues(), reason: "no_adjustments" };
    }

    const protectedSet = new Set<string>([
      ...this.config.behaviorLoopProtectedParams,
      ...state.protectedParams,
    ]);
    const existing = await readSnapshot(this.runtimePath);
    const candidate: RuntimePolicyValues = {
      recencyWeight: existing?.values.recencyWeight ?? this.config.recencyWeight,
      lifecyclePromoteHeatThreshold:
        existing?.values.lifecyclePromoteHeatThreshold ?? this.config.lifecyclePromoteHeatThreshold,
      lifecycleStaleDecayThreshold:
        existing?.values.lifecycleStaleDecayThreshold ?? this.config.lifecycleStaleDecayThreshold,
      cronRecallInstructionHeavyTokenCap:
        existing?.values.cronRecallInstructionHeavyTokenCap ?? this.config.cronRecallInstructionHeavyTokenCap,
    };

    for (const adjustment of state.adjustments) {
      if (!isRuntimeParameter(adjustment.parameter)) {
        const rolledBack = existing ? (await writeSnapshotAtomic(this.runtimePath, existing), true) : await this.rollback();
        return {
          applied: false,
          rolledBack,
          values: await this.loadRuntimeValues(),
          reason: `invalid_parameter:${adjustment.parameter}`,
        };
      }
      if (protectedSet.has(adjustment.parameter)) {
        continue;
      }
      if (!Number.isFinite(adjustment.nextValue)) {
        const rolledBack = existing ? (await writeSnapshotAtomic(this.runtimePath, existing), true) : await this.rollback();
        return {
          applied: false,
          rolledBack,
          values: await this.loadRuntimeValues(),
          reason: `invalid_value:${adjustment.parameter}`,
        };
      }
      candidate[adjustment.parameter] = adjustment.nextValue;
    }

    const sanitized = sanitizeRuntimePolicyValues(candidate);
    if (existing) {
      await writeSnapshotAtomic(this.runtimePrevPath, existing);
    }
    const nextSnapshot: RuntimePolicySnapshot = {
      version: RUNTIME_POLICY_VERSION,
      updatedAt: new Date().toISOString(),
      values: sanitized,
      sourceAdjustmentCount: adjustmentCount,
    };
    await writeSnapshotAtomic(this.runtimePath, nextSnapshot);
    return { applied: true, rolledBack: false, values: sanitized, reason: "applied" };
  }
}
