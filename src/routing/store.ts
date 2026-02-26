import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { log } from "../logger.js";
import { validateRouteTarget, type RouteRule, type RoutingEngineOptions } from "./engine.js";

type RoutingRulesState = {
  version: 1;
  updatedAt: string;
  rules: RouteRule[];
};

function defaultState(): RoutingRulesState {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    rules: [],
  };
}

function stableRuleId(rule: Pick<RouteRule, "patternType" | "pattern" | "priority" | "target">): string {
  const seed = JSON.stringify({
    patternType: rule.patternType,
    pattern: rule.pattern.trim(),
    priority: rule.priority,
    target: rule.target,
  });
  return `route-${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}

function normalizeRule(rule: RouteRule, options?: RoutingEngineOptions): RouteRule | null {
  if (!rule || typeof rule !== "object") return null;
  if (rule.enabled === false) return null;
  if (rule.patternType !== "keyword" && rule.patternType !== "regex") return null;
  if (typeof rule.pattern !== "string" || rule.pattern.trim().length === 0) return null;
  if (typeof rule.priority !== "number" || !Number.isFinite(rule.priority)) return null;

  const targetValidation = validateRouteTarget(rule.target, options);
  if (!targetValidation.ok || !targetValidation.target) return null;

  const id = typeof rule.id === "string" && rule.id.trim().length > 0 ? rule.id.trim() : stableRuleId(rule);
  return {
    id,
    patternType: rule.patternType,
    pattern: rule.pattern.trim(),
    priority: Math.trunc(rule.priority),
    target: targetValidation.target,
    enabled: true,
  };
}

export class RoutingRulesStore {
  private readonly statePath: string;

  constructor(memoryDir: string, stateFile = "state/routing-rules.json") {
    this.statePath = path.isAbsolute(stateFile) ? stateFile : path.join(memoryDir, stateFile);
  }

  async read(options?: RoutingEngineOptions): Promise<RouteRule[]> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<RoutingRulesState>;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rules)) return [];
      const normalized = parsed.rules
        .map((rule) => normalizeRule(rule, options))
        .filter((rule): rule is RouteRule => rule !== null);
      return this.dedupeById(normalized);
    } catch {
      return [];
    }
  }

  async write(rules: RouteRule[], options?: RoutingEngineOptions): Promise<RouteRule[]> {
    const normalized = this.dedupeById(
      rules
        .map((rule) => normalizeRule(rule, options))
        .filter((rule): rule is RouteRule => rule !== null),
    );

    const payload: RoutingRulesState = {
      version: 1,
      updatedAt: new Date().toISOString(),
      rules: normalized,
    };

    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, JSON.stringify(payload, null, 2), "utf-8");
    } catch (err) {
      log.debug(`routing rules write failed: ${err}`);
    }

    return normalized;
  }

  async upsert(rule: RouteRule, options?: RoutingEngineOptions): Promise<RouteRule[]> {
    const existing = await this.read(options);
    const normalized = normalizeRule(rule, options);
    if (!normalized) return existing;

    const next = existing.filter((entry) => entry.id !== normalized.id);
    next.push(normalized);
    return this.write(next, options);
  }

  async removeByPattern(pattern: string, options?: RoutingEngineOptions): Promise<RouteRule[]> {
    const trimmed = pattern.trim();
    const existing = await this.read(options);
    const next = existing.filter((entry) => entry.pattern !== trimmed);
    if (next.length === existing.length) return existing;
    return this.write(next, options);
  }

  async reset(): Promise<void> {
    const payload = defaultState();
    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, JSON.stringify(payload, null, 2), "utf-8");
    } catch (err) {
      log.debug(`routing rules reset failed: ${err}`);
    }
  }

  private dedupeById(rules: RouteRule[]): RouteRule[] {
    const byId = new Map<string, RouteRule>();
    for (const rule of rules) {
      byId.set(rule.id, rule);
    }
    return Array.from(byId.values());
  }
}
