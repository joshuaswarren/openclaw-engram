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
    .describe("If about an entity, its normalized name (e.g. person-joshua-warren)"),
});

export const EntityMentionSchema = z.object({
  name: z
    .string()
    .describe("Normalized entity name (e.g. joshua-warren, openclaw, qmd)"),
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

export type ExtractedFactParsed = z.infer<typeof ExtractedFactSchema>;
export type EntityMentionParsed = z.infer<typeof EntityMentionSchema>;
export type ExtractedQuestionParsed = z.infer<typeof ExtractedQuestionSchema>;
export type ExtractionResultParsed = z.infer<typeof ExtractionResultSchema>;
export type ConsolidationItemParsed = z.infer<typeof ConsolidationItemSchema>;
export type ConsolidationResultParsed = z.infer<
  typeof ConsolidationResultSchema
>;
