import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

function resolveStatePath(memoryDir: string, stateFile: string): string {
  const root = path.resolve(memoryDir);
  const defaultPath = path.join(root, "state", "routing-rules.json");
  if (path.isAbsolute(stateFile)) {
    const absolute = path.resolve(stateFile);
    return absolute.startsWith(root + path.sep) || absolute === root ? absolute : defaultPath;
  }
  const resolved = path.resolve(root, stateFile);
  return resolved.startsWith(root + path.sep) || resolved === root ? resolved : defaultPath;
}

function normalizeRule(rule: RouteRule, options?: RoutingEngineOptions): RouteRule | null {
  if (!rule || typeof rule !== "object") return null;
  if (rule.enabled === false) return null;
  if (rule.patternType !== "keyword" && rule.patternType !== "regex") return null;
  if (typeof rule.pattern !== "string" || rule.pattern.trim().length === 0) return null;
  if (typeof rule.priority !== "number" || !Number.isFinite(rule.priority)) return null;

  const targetValidation = validateRouteTarget(rule.target, options);
  if (!targetValidation.ok || !targetValidation.target) return null;

  const normalizedPriority = Math.trunc(rule.priority);
  const normalizedTarget = targetValidation.target;
  const id = typeof rule.id === "string" && rule.id.trim().length > 0
    ? rule.id.trim()
    : stableRuleId({
      patternType: rule.patternType,
      pattern: rule.pattern.trim(),
      priority: normalizedPriority,
      target: normalizedTarget,
    });
  return {
    id,
    patternType: rule.patternType,
    pattern: rule.pattern.trim(),
    priority: normalizedPriority,
    target: normalizedTarget,
    enabled: true,
  };
}

export class RoutingRulesStore {
  private readonly statePath: string;
  private readonly lockPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(memoryDir: string, stateFile = "state/routing-rules.json") {
    this.statePath = resolveStatePath(memoryDir, stateFile);
    this.lockPath = `${this.statePath}.lock`;
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
    return this.withWriteLock(async () => this.writeNormalized(rules, options));
  }

  async upsert(rule: RouteRule, options?: RoutingEngineOptions): Promise<RouteRule[]> {
    return this.withWriteLock(async () => {
      const existing = await this.read(options);
      const normalized = normalizeRule(rule, options);
      if (!normalized) return existing;

      const next = existing.filter((entry) => entry.id !== normalized.id);
      next.push(normalized);
      return this.writeNormalized(next, options);
    });
  }

  async removeByPattern(pattern: string, options?: RoutingEngineOptions): Promise<RouteRule[]> {
    return this.withWriteLock(async () => {
      const trimmed = pattern.trim();
      const existing = await this.read(options);
      const next = existing.filter((entry) => entry.pattern !== trimmed);
      if (next.length === existing.length) return existing;
      return this.writeNormalized(next, options);
    });
  }

  async reset(): Promise<void> {
    await this.withWriteLock(async () => {
      const payload = defaultState();
      try {
        await mkdir(path.dirname(this.statePath), { recursive: true });
        await writeFile(this.statePath, JSON.stringify(payload, null, 2), "utf-8");
      } catch (err) {
        log.debug(`routing rules reset failed: ${err}`);
      }
    });
  }

  private dedupeById(rules: RouteRule[]): RouteRule[] {
    const byId = new Map<string, RouteRule>();
    for (const rule of rules) {
      byId.set(rule.id, rule);
    }
    return Array.from(byId.values());
  }

  private async writeNormalized(rules: RouteRule[], options?: RoutingEngineOptions): Promise<RouteRule[]> {
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

  private async withWriteLock<T>(op: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const unlock = await this.acquireFileLock();
    try {
      return await op();
    } finally {
      await unlock();
      release();
    }
  }

  private async acquireFileLock(): Promise<() => Promise<void>> {
    const start = Date.now();
    const staleMs = 30_000;
    const timeoutMs = 5_000;
    await mkdir(path.dirname(this.lockPath), { recursive: true });

    while (Date.now() - start < timeoutMs) {
      try {
        await mkdir(this.lockPath);
        return async () => {
          try {
            await rm(this.lockPath, { recursive: true, force: true });
          } catch {
            // Fail-open: lock cleanup should not fail writes.
          }
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          break;
        }
        try {
          const lockStat = await stat(this.lockPath);
          if (Date.now() - lockStat.mtimeMs > staleMs) {
            await rm(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          // Lock may have been released between stat/rm attempts.
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    return async () => {};
  }
}
