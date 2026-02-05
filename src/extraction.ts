import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { log } from "./logger.js";
import {
  ExtractionResultSchema,
  ConsolidationResultSchema,
  IdentityConsolidationResultSchema,
} from "./schemas.js";
import type {
  BufferTurn,
  ExtractionResult,
  ConsolidationResult,
  MemoryFile,
  PluginConfig,
} from "./types.js";

export class ExtractionEngine {
  private client: OpenAI | null;

  constructor(private readonly config: PluginConfig) {
    if (config.openaiApiKey) {
      this.client = new OpenAI({ apiKey: config.openaiApiKey });
    } else {
      this.client = null;
      log.warn("no OpenAI API key — extraction/consolidation disabled (retrieval still works)");
    }
  }

  async extract(turns: BufferTurn[]): Promise<ExtractionResult> {
    if (!this.client) {
      log.warn("extraction skipped — no OpenAI API key");
      return { facts: [], profileUpdates: [], entities: [], questions: [] };
    }

    const conversation = turns
      .map((t) => `[${t.role}] ${t.content}`)
      .join("\n\n");

    const reasoningParam =
      this.config.reasoningEffort !== "none"
        ? { reasoning: { effort: this.config.reasoningEffort as "low" | "medium" | "high" } }
        : {};

    try {
      const response = await this.client.responses.parse({
        model: this.config.model,
        ...reasoningParam,
        instructions: `You are a memory extraction system. Analyze the following conversation and extract durable, reusable memories.

Memory categories:
- fact: Objective information about the world
- preference: User likes, dislikes, or stylistic choices
- correction: User correcting a mistake or misconception (highest priority)
- entity: Information about a specific person, project, tool, or company
- decision: A choice that was made with rationale
- relationship: How two entities relate to each other (e.g., "Joshua is Jenna's husband", "Creatuity uses Adobe Commerce")
- principle: Durable rules, values, or operating beliefs (e.g., "never use Chat Completions API")
- commitment: Promises, obligations, or deadlines (e.g., "deploy by Friday", "call accountant Monday")
- moment: Emotionally significant events or milestones (e.g., "first successful deployment of engram")
- skill: Capabilities the user or agent has demonstrated (e.g., "Joshua knows Magento deeply")

Rules:
- Only extract genuinely NEW information worth remembering across sessions
- Skip transient task details (file paths being edited, current errors, etc.)
- Priority: corrections > principles > preferences > commitments > decisions > relationships > entities > moments > skills > facts
- Corrections (user saying "actually, don't do X" or "I prefer Y") get highest confidence
- Each fact should be a standalone, self-contained statement
- Entity references should use normalized names (lowercase, hyphenated: "joshua-warren", "openclaw")
- Tags should be concise and reusable (e.g., "coding-style", "personal", "tools")
- Set confidence using these tiers:
  * Explicit (0.95-1.0): Direct user statements — "I prefer X", "my name is Y"
  * Implied (0.70-0.94): Strong contextual inference — user consistently does X, clear from conversation flow
  * Inferred (0.40-0.69): Pattern recognition — reasonable guess from limited evidence
  * Speculative (0.00-0.39): Tentative hypothesis — weak signal, needs future confirmation. Speculative memories auto-expire after 30 days if not confirmed.
- For commitments: include any deadline or timeframe mentioned

Also generate 1-3 genuine questions you're curious about based on this conversation. These should be things you'd actually want answers to in future sessions — not prompts, but real curiosity.

Finally, write a brief identity reflection — what did you learn about yourself as an agent? How did you grow, what patterns do you notice in your own behavior, what could you improve?`,
        input: conversation,
        text: {
          format: zodTextFormat(ExtractionResultSchema, "extraction_result"),
        },
      });

      if (response.output_parsed) {
        log.debug(
          `extracted ${response.output_parsed.facts.length} facts, ${response.output_parsed.entities.length} entities, ${(response.output_parsed.questions ?? []).length} questions`,
        );
        return {
          ...response.output_parsed,
          questions: response.output_parsed.questions ?? [],
          identityReflection: response.output_parsed.identityReflection ?? undefined,
        } as ExtractionResult;
      }

      log.warn("extraction returned no parsed output");
      return { facts: [], profileUpdates: [], entities: [], questions: [] };
    } catch (err) {
      log.error("extraction failed", err);
      return { facts: [], profileUpdates: [], entities: [], questions: [] };
    }
  }

  async consolidate(
    newMemories: MemoryFile[],
    existingMemories: MemoryFile[],
    currentProfile: string,
  ): Promise<ConsolidationResult> {
    if (!this.client) {
      log.warn("consolidation skipped — no OpenAI API key");
      return { items: [], profileUpdates: [], entityUpdates: [] };
    }

    const newList = newMemories
      .map(
        (m) =>
          `[${m.frontmatter.id}] (${m.frontmatter.category}) ${m.content}`,
      )
      .join("\n");

    const existingList = existingMemories
      .slice(-50) // Only consolidate against recent memories
      .map(
        (m) =>
          `[${m.frontmatter.id}] (${m.frontmatter.category}) ${m.content}`,
      )
      .join("\n");

    const reasoningParam =
      this.config.reasoningEffort !== "none"
        ? { reasoning: { effort: this.config.reasoningEffort as "low" | "medium" | "high" } }
        : {};

    try {
      const response = await this.client.responses.parse({
        model: this.config.model,
        ...reasoningParam,
        instructions: `You are a memory consolidation system. Compare new memories against existing ones and decide what to do with each.

Actions:
- ADD: Keep the new memory as-is (no duplicate exists)
- MERGE: Combine with an existing memory (provide mergeWith ID and updated content)
- UPDATE: Replace existing memory content (provide updated content)
- INVALIDATE: Remove existing memory (it's been superseded or is wrong)
- SKIP: This new memory is redundant (exact duplicate or subset of existing)

Also:
- Suggest profile updates based on patterns across memories
- Identify entity updates for entity tracking

Current behavioral profile:
${currentProfile || "(empty)"}

Existing memories:
${existingList || "(none)"}

New memories to consolidate:
${newList}`,
        input: "Consolidate the new memories against existing ones.",
        text: {
          format: zodTextFormat(
            ConsolidationResultSchema,
            "consolidation_result",
          ),
        },
      });

      if (response.output_parsed) {
        log.debug(
          `consolidation: ${response.output_parsed.items.length} decisions`,
        );
        return response.output_parsed as ConsolidationResult;
      }

      log.warn("consolidation returned no parsed output");
      return { items: [], profileUpdates: [], entityUpdates: [] };
    } catch (err) {
      log.error("consolidation failed", err);
      return { items: [], profileUpdates: [], entityUpdates: [] };
    }
  }

  /**
   * Consolidate IDENTITY.md reflections into a concise "Learned Patterns" section.
   * Returns the new content for the IDENTITY.md file (everything below the static header).
   */
  async consolidateIdentity(
    fullIdentityContent: string,
    staticHeaderEndMarker: string,
  ): Promise<{ learnedPatterns: string[]; summary: string } | null> {
    if (!this.client) {
      log.warn("identity consolidation skipped — no OpenAI API key");
      return null;
    }

    const reasoningParam =
      this.config.reasoningEffort !== "none"
        ? { reasoning: { effort: this.config.reasoningEffort as "low" | "medium" | "high" } }
        : {};

    try {
      const response = await this.client.responses.parse({
        model: this.config.model,
        ...reasoningParam,
        instructions: `You are an identity consolidation system. You are given the full contents of an IDENTITY.md file that contains many individual reflection entries. Your job is to:

1. Read all the reflection entries (sections starting with "## Reflection")
2. Extract the most important, durable behavioral patterns and lessons learned
3. Consolidate them into concise, standalone statements (aim for 10-25 key patterns)
4. Remove redundancy — if multiple reflections say the same thing, merge into one clear statement
5. Prioritize patterns that are actionable and recurring over one-off observations
6. Write a brief summary paragraph

The goal is to reduce a bloated file to a compact, high-signal set of learned patterns while preserving all genuinely useful self-knowledge.`,
        input: fullIdentityContent,
        text: {
          format: zodTextFormat(
            IdentityConsolidationResultSchema,
            "identity_consolidation_result",
          ),
        },
      });

      if (response.output_parsed) {
        log.debug(
          `identity consolidation: ${response.output_parsed.learnedPatterns.length} patterns`,
        );
        return response.output_parsed;
      }

      log.warn("identity consolidation returned no parsed output");
      return null;
    } catch (err) {
      log.error("identity consolidation failed", err);
      return null;
    }
  }
}
