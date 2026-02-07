import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { log } from "./logger.js";
import {
  ExtractionResultSchema,
  ConsolidationResultSchema,
  IdentityConsolidationResultSchema,
  ProfileConsolidationResultSchema,
  ContradictionVerificationSchema,
  SuggestedLinksSchema,
  MemorySummarySchema,
  type ContradictionVerificationResult,
  type SuggestedLinks,
  type MemorySummaryResult,
} from "./schemas.js";
import type {
  BufferTurn,
  ExtractionResult,
  ConsolidationResult,
  MemoryFile,
  PluginConfig,
  LlmTraceEvent,
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

  private emit(event: LlmTraceEvent): void {
    try {
      const cb = (globalThis as any).__openclawEngramTrace;
      if (typeof cb === "function") cb(event);
    } catch {
      // Never throw — broken subscriber must not crash extraction
    }
  }

  async extract(turns: BufferTurn[], existingEntities?: string[]): Promise<ExtractionResult> {
    if (!this.client) {
      log.warn("extraction skipped — no OpenAI API key");
      return { facts: [], profileUpdates: [], entities: [], questions: [] };
    }

    // Guard: skip if buffer is empty or all turns are whitespace-only
    const substantiveTurns = turns.filter((t) => t.content.trim().length > 0);
    if (substantiveTurns.length === 0) {
      log.debug("extraction skipped — no substantive turns in buffer");
      return { facts: [], profileUpdates: [], entities: [], questions: [] };
    }

    const conversation = substantiveTurns
      .map((t) => `[${t.role}] ${t.content}`)
      .join("\n\n");

    const reasoningParam =
      this.config.reasoningEffort !== "none"
        ? { reasoning: { effort: this.config.reasoningEffort as "low" | "medium" | "high" } }
        : {};

    const traceId = crypto.randomUUID();
    this.emit({ kind: "llm_start", traceId, model: this.config.model, operation: "extraction", input: conversation });
    const startTime = Date.now();

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
- relationship: How two entities relate to each other (e.g., "Alice is Bob's manager", "Acme Corp uses Shopify")
- principle: Durable rules, values, or operating beliefs (e.g., "never use Chat Completions API")
- commitment: Promises, obligations, or deadlines (e.g., "deploy by Friday", "call accountant Monday")
- moment: Emotionally significant events or milestones (e.g., "first successful deployment of engram")
- skill: Capabilities the user or agent has demonstrated (e.g., "user is proficient with Kubernetes")

Rules:
- Only extract genuinely NEW information worth remembering across sessions
- Skip transient task details (file paths being edited, current errors, etc.)
- Priority: corrections > principles > preferences > commitments > decisions > relationships > entities > moments > skills > facts
- Corrections (user saying "actually, don't do X" or "I prefer Y") get highest confidence
- Each fact should be a standalone, self-contained statement
- Entity references should use normalized names (lowercase, hyphenated: "jane-doe", "acme-corp")
- CRITICAL: Entity names must be CANONICAL. Always use the hyphenated multi-word form: "acme-corp" NOT "acmecorp" or "acme". "jane-doe" NOT "janedoe" or "jane". If unsure, prefer the most specific full name.
- Avoid creating entities typed as "other" when a more specific type fits (company, project, tool, person, place)
- Tags should be concise and reusable (e.g., "coding-style", "personal", "tools")
- Set confidence using these tiers:
  * Explicit (0.95-1.0): Direct user statements — "I prefer X", "my name is Y"
  * Implied (0.70-0.94): Strong contextual inference — user consistently does X, clear from conversation flow
  * Inferred (0.40-0.69): Pattern recognition — reasonable guess from limited evidence
  * Speculative (0.00-0.39): Tentative hypothesis — weak signal, needs future confirmation. Speculative memories auto-expire after 30 days if not confirmed.
- For commitments: include any deadline or timeframe mentioned

Entity creation rules (STRICT):
- Only create entities for DURABLE things: real people, companies, products, tools, ongoing projects
- NEVER create entities for transient items: individual PRs, branches, Jira tickets, meetings, agent task IDs, log files, database tables, cron job runs, sessions
- When you learn something about a transient item (e.g., PR #58 fixed a bug), store it as a FACT with an entityRef to the parent project — do NOT create an entity for the PR itself
- Prefer attaching facts to broad parent entities rather than creating sub-entities. E.g., "acme-store uses Algolia for search" is a fact on entity "acme-store", NOT a new entity "acme-store-algolia-connector"
- The entity list should be SHORT — think "things that would have their own Wikipedia page" not "things mentioned in passing"

${existingEntities && existingEntities.length > 0 ? `
KNOWN ENTITIES (use these exact names when referencing existing things):
${existingEntities.join(", ")}

When you see something that matches a known entity, use THAT name exactly. Only create a NEW entity if nothing in this list represents it.
` : ""}
Also generate 1-3 genuine questions you're curious about based on this conversation. These should be things you'd actually want answers to in future sessions — not prompts, but real curiosity.

Finally, write a brief identity reflection about the AGENT who had this conversation (not about you, the extraction system). Based on what the agent said and did in the conversation:
- What communication patterns did the agent show? (e.g., proactive vs reactive, verbose vs concise)
- Did the agent handle the user's needs well or miss something?
- What behavioral tendencies are visible? (e.g., cautious, creative, thorough, impatient)
- What could the agent improve next time?
Do NOT write about the extraction process itself. Do NOT say things like "I extracted durable facts" — that's about YOUR job, not the agent's behavior.`,
        input: conversation,
        text: {
          format: zodTextFormat(ExtractionResultSchema, "extraction_result"),
        },
      });

      const durationMs = Date.now() - startTime;
      const usage = (response as any).usage;
      this.emit({
        kind: "llm_end", traceId, model: this.config.model, operation: "extraction", durationMs,
        output: response.output_parsed ? JSON.stringify(response.output_parsed).slice(0, 2000) : undefined,
        tokenUsage: usage ? { input: usage.input_tokens, output: usage.output_tokens, total: usage.total_tokens } : undefined,
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
      this.emit({
        kind: "llm_error", traceId, model: this.config.model, operation: "extraction",
        durationMs: Date.now() - startTime, error: String(err),
      });
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

    const cTraceId = crypto.randomUUID();
    this.emit({ kind: "llm_start", traceId: cTraceId, model: this.config.model, operation: "consolidation", input: newList });
    const cStartTime = Date.now();

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

      const cDurationMs = Date.now() - cStartTime;
      const cUsage = (response as any).usage;
      this.emit({
        kind: "llm_end", traceId: cTraceId, model: this.config.model, operation: "consolidation", durationMs: cDurationMs,
        output: response.output_parsed ? JSON.stringify(response.output_parsed).slice(0, 2000) : undefined,
        tokenUsage: cUsage ? { input: cUsage.input_tokens, output: cUsage.output_tokens, total: cUsage.total_tokens } : undefined,
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
      this.emit({
        kind: "llm_error", traceId: cTraceId, model: this.config.model, operation: "consolidation",
        durationMs: Date.now() - cStartTime, error: String(err),
      });
      log.error("consolidation failed", err);
      return { items: [], profileUpdates: [], entityUpdates: [] };
    }
  }

  /**
   * Consolidate a bloated profile.md into a compact version.
   * The LLM merges duplicates, removes stale info, and preserves section structure.
   * Returns the consolidated markdown or null on failure.
   */
  async consolidateProfile(
    fullProfileContent: string,
  ): Promise<{ consolidatedProfile: string; removedCount: number; summary: string } | null> {
    if (!this.client) {
      log.warn("profile consolidation skipped — no OpenAI API key");
      return null;
    }

    const reasoningParam =
      this.config.reasoningEffort !== "none"
        ? { reasoning: { effort: this.config.reasoningEffort as "low" | "medium" | "high" } }
        : {};

    const pTraceId = crypto.randomUUID();
    this.emit({ kind: "llm_start", traceId: pTraceId, model: this.config.model, operation: "profile_consolidation", input: fullProfileContent.slice(0, 2000) });
    const pStartTime = Date.now();

    try {
      const response = await this.client.responses.parse({
        model: this.config.model,
        ...reasoningParam,
        instructions: `You are a profile consolidation system. You are given a behavioral profile (markdown) that has grown too large. Your job is to produce a CONSOLIDATED version that:

1. PRESERVES all ## section headers and their structure
2. MERGES duplicate or near-duplicate bullet points into single, clear statements
3. REMOVES stale information that has been superseded by newer bullets
4. REMOVES trivial or overly specific operational details that won't be useful across sessions
5. KEEPS the most important, durable observations about the user's preferences, habits, identity, and working style
6. Target roughly 400 lines — this is a soft target, prioritize quality over length
7. Write in the same style as the existing profile — concise bullets, no fluff

The output should be the COMPLETE consolidated profile as valid markdown, starting with "# Behavioral Profile".`,
        input: fullProfileContent,
        text: {
          format: zodTextFormat(ProfileConsolidationResultSchema, "profile_consolidation_result"),
        },
      });

      const pDurationMs = Date.now() - pStartTime;
      const pUsage = (response as any).usage;
      this.emit({
        kind: "llm_end", traceId: pTraceId, model: this.config.model, operation: "profile_consolidation", durationMs: pDurationMs,
        output: response.output_parsed ? response.output_parsed.summary : undefined,
        tokenUsage: pUsage ? { input: pUsage.input_tokens, output: pUsage.output_tokens, total: pUsage.total_tokens } : undefined,
      });

      if (response.output_parsed) {
        log.debug(
          `profile consolidation: removed ${response.output_parsed.removedCount} items — ${response.output_parsed.summary}`,
        );
        return response.output_parsed;
      }

      log.warn("profile consolidation returned no parsed output");
      return null;
    } catch (err) {
      this.emit({
        kind: "llm_error", traceId: pTraceId, model: this.config.model, operation: "profile_consolidation",
        durationMs: Date.now() - pStartTime, error: String(err),
      });
      log.error("profile consolidation failed", err);
      return null;
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

    const iTraceId = crypto.randomUUID();
    this.emit({ kind: "llm_start", traceId: iTraceId, model: this.config.model, operation: "identity_consolidation", input: fullIdentityContent.slice(0, 2000) });
    const iStartTime = Date.now();

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

      const iDurationMs = Date.now() - iStartTime;
      const iUsage = (response as any).usage;
      this.emit({
        kind: "llm_end", traceId: iTraceId, model: this.config.model, operation: "identity_consolidation", durationMs: iDurationMs,
        output: response.output_parsed ? response.output_parsed.summary : undefined,
        tokenUsage: iUsage ? { input: iUsage.input_tokens, output: iUsage.output_tokens, total: iUsage.total_tokens } : undefined,
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
      this.emit({
        kind: "llm_error", traceId: iTraceId, model: this.config.model, operation: "identity_consolidation",
        durationMs: Date.now() - iStartTime, error: String(err),
      });
      log.error("identity consolidation failed", err);
      return null;
    }
  }

  /**
   * Verify if two memories contradict each other using LLM.
   * Called when QMD finds semantically similar memories (Phase 2B).
   */
  async verifyContradiction(
    newMemory: { content: string; category: string },
    existingMemory: { id: string; content: string; category: string; created: string },
  ): Promise<ContradictionVerificationResult | null> {
    if (!this.client) {
      log.warn("contradiction verification skipped — no OpenAI API key");
      return null;
    }

    const input = `Memory 1 (existing, created ${existingMemory.created}):
Category: ${existingMemory.category}
Content: ${existingMemory.content}

Memory 2 (new):
Category: ${newMemory.category}
Content: ${newMemory.content}`;

    try {
      const response = await this.client.responses.parse({
        model: this.config.model,
        instructions: `You are a contradiction detection system. Analyze whether two memories contradict each other.

IMPORTANT: Not all similar memories are contradictions!
- "User likes TypeScript" and "User likes Python" are NOT contradictions (preferences can coexist)
- "User prefers dark mode" and "User prefers light mode" ARE contradictions (mutually exclusive)
- "User's email is a@b.com" and "User's email is c@d.com" ARE contradictions (only one email)
- "User works at Acme" and "User used to work at Acme" might be a contradiction (temporal change)

Only mark as contradiction if the two statements CANNOT both be true at the same time.

If they ARE contradictory, determine which represents the more recent/current state based on:
- Explicit time references ("now", "currently", "used to", "no longer")
- The fact that newer corrections often start with "actually" or "correction"
- Context clues about change over time`,
        input,
        text: {
          format: zodTextFormat(ContradictionVerificationSchema, "contradiction_verification"),
        },
      });

      if (response.output_parsed) {
        log.debug(
          `contradiction check: ${response.output_parsed.isContradiction ? "YES" : "NO"} (confidence: ${response.output_parsed.confidence})`,
        );
        return response.output_parsed as ContradictionVerificationResult;
      }

      return null;
    } catch (err) {
      log.error("contradiction verification failed", err);
      return null;
    }
  }

  /**
   * Suggest links between a new memory and existing memories (Phase 3A).
   * Called during extraction to build the knowledge graph.
   */
  async suggestLinks(
    newMemory: { content: string; category: string },
    candidateMemories: Array<{ id: string; content: string; category: string }>,
  ): Promise<SuggestedLinks | null> {
    if (!this.client) {
      log.warn("link suggestion skipped — no OpenAI API key");
      return null;
    }

    if (candidateMemories.length === 0) {
      return { links: [] };
    }

    const candidateList = candidateMemories
      .map((m, i) => `[${i + 1}] ID: ${m.id}\nCategory: ${m.category}\nContent: ${m.content}`)
      .join("\n\n");

    const input = `New memory:
Category: ${newMemory.category}
Content: ${newMemory.content}

Candidate memories to link to:
${candidateList}`;

    try {
      const response = await this.client.responses.parse({
        model: this.config.model,
        instructions: `You are a memory linking system. Analyze the new memory and suggest relationships to existing memories.

Link types:
- follows: This memory is a continuation or next step (e.g., decision follows discussion)
- references: This memory mentions or refers to the other (e.g., fact references entity)
- contradicts: This memory conflicts with the other (use sparingly, only for true contradictions)
- supports: This memory provides evidence or reinforcement (e.g., example supports principle)
- related: General topical relationship

Rules:
- Only suggest links with strength > 0.5
- Quality over quantity — 0-3 links is typical
- Prefer specific link types over generic "related"
- Consider entity references, topics, and causal relationships`,
        input,
        text: {
          format: zodTextFormat(SuggestedLinksSchema, "suggested_links"),
        },
      });

      if (response.output_parsed) {
        log.debug(`suggested ${response.output_parsed.links.length} links`);
        return response.output_parsed as SuggestedLinks;
      }

      return { links: [] };
    } catch (err) {
      log.error("link suggestion failed", err);
      return { links: [] };
    }
  }

  /**
   * Summarize a batch of old memories into a compact summary (Phase 4A).
   */
  async summarizeMemories(
    memories: Array<{ id: string; content: string; category: string; created: string }>,
  ): Promise<MemorySummaryResult | null> {
    if (!this.client) {
      log.warn("summarization skipped — no OpenAI API key");
      return null;
    }

    if (memories.length === 0) return null;

    const memoryList = memories
      .map((m) => `[${m.id}] (${m.category}, ${m.created.slice(0, 10)})\n${m.content}`)
      .join("\n\n");

    try {
      const response = await this.client.responses.parse({
        model: this.config.model,
        instructions: `You are a memory summarization system. You are given a batch of old memories that need to be compressed into a summary.

Your task:
1. Write a concise summary paragraph (2-4 sentences) capturing the essence of these memories
2. Extract the 5-10 most important facts that should be preserved
3. List the key entities mentioned

Guidelines:
- Preserve specific, actionable information
- Merge redundant details into single statements
- Focus on durable insights, not transient details
- Maintain any preferences, decisions, or corrections as key facts`,
        input: `Summarize these ${memories.length} memories:\n\n${memoryList}`,
        text: {
          format: zodTextFormat(MemorySummarySchema, "memory_summary"),
        },
      });

      if (response.output_parsed) {
        log.debug(`summarized ${memories.length} memories into ${response.output_parsed.keyFacts.length} key facts`);
        return response.output_parsed as MemorySummaryResult;
      }

      return null;
    } catch (err) {
      log.error("memory summarization failed", err);
      return null;
    }
  }
}
