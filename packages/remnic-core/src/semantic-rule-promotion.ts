import { StorageManager } from "./storage.js";
import type { MemoryFile, MemoryLink } from "./types.js";

export interface SemanticRulePromotionCandidate {
  id: string;
  sourceMemoryId: string;
  content: string;
  confidence: number;
  tags: string[];
  memoryKind: "note";
  lineage: string[];
}

export interface SemanticRulePromotionSkip {
  sourceMemoryId: string;
  reason:
    | "disabled"
    | "source-memory-missing"
    | "source-memory-not-episode"
    | "no-explicit-rule"
    | "duplicate-rule";
  existingRuleId?: string;
}

export interface SemanticRulePromotionReport {
  enabled: boolean;
  dryRun: boolean;
  promoted: SemanticRulePromotionCandidate[];
  skipped: SemanticRulePromotionSkip[];
}

function normalizeRuleWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTrailingClausePunctuation(value: string): string {
  return value.replace(/[,:;]+$/g, "").trim();
}

function canonicalizeRuleContent(value: string): string {
  return extractExplicitIfThenRule(value) ?? normalizeRuleWhitespace(value);
}

function canonicalizeRuleKey(value: string): string {
  return canonicalizeRuleContent(value).toLowerCase();
}

function extractExplicitIfThenRule(content: string): string | null {
  const match = content.match(/\bif\b([\s\S]+?)\bthen\b([\s\S]+?)(?:[.!?](?:\s|$)|$)/i);
  if (!match) return null;
  const condition = stripTrailingClausePunctuation(normalizeRuleWhitespace(match[1] ?? ""));
  const outcome = stripTrailingClausePunctuation(normalizeRuleWhitespace(match[2] ?? ""));
  if (condition.length === 0 || outcome.length === 0) return null;
  return `IF ${condition} THEN ${outcome}.`;
}

function promotionConfidence(memory: MemoryFile): number {
  const base = Number.isFinite(memory.frontmatter.confidence) ? memory.frontmatter.confidence : 0.8;
  return Math.max(0.6, Math.min(0.98, base));
}

function promotionTags(memory: MemoryFile): string[] {
  return Array.from(new Set([...(memory.frontmatter.tags ?? []), "semantic-rule", "promoted-rule"]));
}

function buildSupportLinks(sourceMemoryId: string, confidence: number): MemoryLink[] {
  return [
    {
      targetId: sourceMemoryId,
      linkType: "supports",
      strength: confidence,
      reason: "Promoted from verified episodic memory",
    },
  ];
}

export async function promoteSemanticRuleFromMemory(options: {
  memoryDir: string;
  enabled: boolean;
  sourceMemoryId: string;
  dryRun?: boolean;
}): Promise<SemanticRulePromotionReport> {
  const report: SemanticRulePromotionReport = {
    enabled: options.enabled,
    dryRun: options.dryRun === true,
    promoted: [],
    skipped: [],
  };
  if (!options.enabled) {
    report.skipped.push({
      sourceMemoryId: options.sourceMemoryId,
      reason: "disabled",
    });
    return report;
  }

  const storage = new StorageManager(options.memoryDir);
  const sourceMemory = await storage.getMemoryById(options.sourceMemoryId);
  if (!sourceMemory) {
    report.skipped.push({
      sourceMemoryId: options.sourceMemoryId,
      reason: "source-memory-missing",
    });
    return report;
  }
  if (sourceMemory.frontmatter.status === "archived" || sourceMemory.frontmatter.memoryKind !== "episode") {
    report.skipped.push({
      sourceMemoryId: options.sourceMemoryId,
      reason: "source-memory-not-episode",
    });
    return report;
  }

  const content = extractExplicitIfThenRule(sourceMemory.content);
  if (!content) {
    report.skipped.push({
      sourceMemoryId: options.sourceMemoryId,
      reason: "no-explicit-rule",
    });
    return report;
  }

  const ruleKey = canonicalizeRuleKey(content);
  const existingRule = (await storage.readAllMemories()).find(
    (memory) =>
      memory.frontmatter.category === "rule" &&
      memory.frontmatter.status !== "archived" &&
      canonicalizeRuleKey(memory.content) === ruleKey,
  );
  if (existingRule) {
    report.skipped.push({
      sourceMemoryId: options.sourceMemoryId,
      reason: "duplicate-rule",
      existingRuleId: existingRule.frontmatter.id,
    });
    return report;
  }

  const confidence = promotionConfidence(sourceMemory);
  const candidateBase = {
    sourceMemoryId: options.sourceMemoryId,
    content,
    confidence,
    tags: promotionTags(sourceMemory),
    memoryKind: "note" as const,
    lineage: [options.sourceMemoryId],
  };

  if (options.dryRun === true) {
    report.promoted.push({
      id: `dry-run:${options.sourceMemoryId}`,
      ...candidateBase,
    });
    return report;
  }

  const id = await storage.writeMemory("rule", content, {
    confidence,
    tags: candidateBase.tags,
    source: "semantic-rule-promotion",
    lineage: candidateBase.lineage,
    sourceMemoryId: options.sourceMemoryId,
    memoryKind: "note",
    links: buildSupportLinks(options.sourceMemoryId, confidence),
  });
  report.promoted.push({
    id,
    ...candidateBase,
  });
  return report;
}
