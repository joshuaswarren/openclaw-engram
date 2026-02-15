import { z } from "zod";

export const ExtractedFactSchema = z.object({
  category: z.enum(["fact", "preference", "correction", "entity", "decision", "relationship", "principle", "commitment", "moment", "skill"]),
  content: z
    .string()
    .describe("The memory content — a clear, standalone statement"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How confident are you this is correct (0-1)"),
  tags: z.array(z.string()).describe("Relevant tags for categorization"),
  entityRef: z
    .string()
    .optional()
    .nullable()
    .describe("If about an entity, its normalized name (e.g. person-jane-doe)"),
});

export const EntityMentionSchema = z.object({
  name: z
    .string()
    .describe("Normalized entity name (e.g. jane-doe, acme-corp, my-project)"),
  type: z.enum(["person", "project", "tool", "company", "place", "other"]),
  facts: z
    .array(z.string())
    .describe("New facts learned about this entity in this conversation"),
});

export const ExtractedQuestionSchema = z.object({
  question: z.string().describe("A genuine question the AI is curious about based on this conversation"),
  context: z.string().describe("Why this question matters or what prompted it"),
  priority: z.number().min(0).max(1).describe("How important/urgent this question is (0-1)"),
});

export const ExtractedRelationshipSchema = z.object({
  source: z.string().describe("Source entity name (normalized, e.g. person-jane-doe)"),
  target: z.string().describe("Target entity name (normalized, e.g. company-acme-corp)"),
  label: z.string().describe("Relationship label (e.g. 'works at', 'created', 'manages')"),
});

export const ExtractionResultSchema = z.object({
  facts: z
    .array(ExtractedFactSchema)
    .describe(
      "Extracted memories from the conversation. Include facts, preferences, corrections, and decisions. Only extract genuinely new, durable information — skip transient task state.",
    ),
  profileUpdates: z
    .array(z.string())
    .describe(
      "Updates to the user's behavioral profile. Each string is a standalone statement about the user's preferences, habits, or personality. Only include genuinely new insights.",
    ),
  entities: z
    .array(EntityMentionSchema)
    .describe(
      "Entities mentioned in the conversation with new facts about them.",
    ),
  questions: z
    .array(ExtractedQuestionSchema)
    .describe(
      "1-3 genuine questions you're curious about from this conversation. These should be things you'd actually want to know the answer to in future sessions.",
    ),
  identityReflection: z
    .string()
    .optional()
    .nullable()
    .describe(
      "A brief reflection on what you learned about yourself as an agent in this interaction — patterns in your behavior, growth, things you did well or could improve.",
    ),
  relationships: z
    .array(ExtractedRelationshipSchema)
    .optional()
    .nullable()
    .describe(
      "Relationships between entities discovered in this conversation. Max 5 per extraction. Format: {source, target, label}.",
    ),
});

export const ConsolidationItemSchema = z.object({
  existingId: z
    .string()
    .describe("The ID of the existing memory being evaluated"),
  action: z.enum(["ADD", "MERGE", "UPDATE", "INVALIDATE", "SKIP"]),
  mergeWith: z
    .string()
    .optional()
    .nullable()
    .describe("If MERGE, the ID of the memory to merge with"),
  updatedContent: z
    .string()
    .optional()
    .nullable()
    .describe("If UPDATE or MERGE, the new content"),
  reason: z.string().describe("Brief reason for this decision"),
});

export const ConsolidationResultSchema = z.object({
  items: z
    .array(ConsolidationItemSchema)
    .describe(
      "Decisions for each existing memory: ADD (keep as-is), MERGE (combine with another), UPDATE (revise content), INVALIDATE (mark as outdated/wrong), SKIP (no action needed)",
    ),
  profileUpdates: z
    .array(z.string())
    .describe("New profile statements to add or update"),
  entityUpdates: z
    .array(EntityMentionSchema)
    .describe("Entity updates from consolidation analysis"),
});

export const ProfileConsolidationResultSchema = z.object({
  consolidatedProfile: z
    .string()
    .describe(
      "The full consolidated profile as markdown. Preserve all ## section headers. Merge duplicate or near-duplicate bullets into single clear statements. Remove stale or superseded information. Keep the most important and durable observations. Target roughly 400 lines.",
    ),
  removedCount: z
    .number()
    .describe("Number of bullets removed or merged during consolidation"),
  summary: z
    .string()
    .describe("Brief summary of what was consolidated"),
});

export const IdentityConsolidationResultSchema = z.object({
  learnedPatterns: z
    .array(z.string())
    .describe(
      "Consolidated behavioral patterns and lessons learned, each a concise standalone statement",
    ),
  summary: z
    .string()
    .describe(
      "A brief paragraph summarizing the agent's core identity insights",
    ),
});

export type IdentityConsolidationResultParsed = z.infer<
  typeof IdentityConsolidationResultSchema
>;

// Contradiction Verification (Phase 2B)
export const ContradictionVerificationSchema = z.object({
  isContradiction: z
    .boolean()
    .describe("Whether the two memories truly contradict each other"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How confident are you in this assessment (0-1)"),
  reasoning: z
    .string()
    .describe("Explanation of why these are or are not contradictory"),
  whichIsNewer: z
    .enum(["first", "second", "unclear"])
    .describe("Which memory represents the more recent/current state"),
});

export type ContradictionVerificationResult = z.infer<
  typeof ContradictionVerificationSchema
>;

// Memory Linking (Phase 3A)
export const MemoryLinkSchema = z.object({
  targetId: z
    .string()
    .describe("The ID of the memory this links to"),
  linkType: z
    .enum(["follows", "references", "contradicts", "supports", "related"])
    .describe("The type of relationship"),
  strength: z
    .number()
    .min(0)
    .max(1)
    .describe("How strong is this relationship (0-1)"),
  reason: z
    .string()
    .optional()
    .nullable()
    .describe("Why this link exists"),
});

export const SuggestedLinksSchema = z.object({
  links: z
    .array(MemoryLinkSchema)
    .describe("Suggested links between memories based on semantic analysis"),
});

export type MemoryLink = z.infer<typeof MemoryLinkSchema>;
export type SuggestedLinks = z.infer<typeof SuggestedLinksSchema>;

// Memory Summarization (Phase 4A)
export const MemorySummarySchema = z.object({
  summaryText: z
    .string()
    .describe("A concise summary of the batch of memories"),
  keyFacts: z
    .array(z.string())
    .describe("The most important facts extracted from these memories"),
  keyEntities: z
    .array(z.string())
    .describe("Key entities mentioned across these memories"),
});

export type MemorySummaryResult = z.infer<typeof MemorySummarySchema>;

export type ExtractedFactParsed = z.infer<typeof ExtractedFactSchema>;
export type EntityMentionParsed = z.infer<typeof EntityMentionSchema>;
export type ExtractedQuestionParsed = z.infer<typeof ExtractedQuestionSchema>;
export type ExtractionResultParsed = z.infer<typeof ExtractionResultSchema>;
export type ConsolidationItemParsed = z.infer<typeof ConsolidationItemSchema>;
export type ConsolidationResultParsed = z.infer<
  typeof ConsolidationResultSchema
>;
