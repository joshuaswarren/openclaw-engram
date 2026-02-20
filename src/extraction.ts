import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { log } from "./logger.js";
import { LocalLlmClient } from "./local-llm.js";
import { FallbackLlmClient } from "./fallback-llm.js";
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
  GatewayConfig,
} from "./types.js";
import { ModelRegistry } from "./model-registry.js";
import { extractJsonCandidates } from "./json-extract.js";
import { sanitizeMemoryContent } from "./sanitize.js";

export class ExtractionEngine {
  private client: OpenAI | null;
  private localLlm: LocalLlmClient;
  private fallbackLlm: FallbackLlmClient;
  private modelRegistry: ModelRegistry;

  constructor(
    private readonly config: PluginConfig,
    localLlm?: LocalLlmClient,
    gatewayConfig?: GatewayConfig,
    modelRegistry?: ModelRegistry,
  ) {
    if (config.openaiApiKey) {
      this.client = new OpenAI({
        apiKey: config.openaiApiKey,
        ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
      });
    } else {
      this.client = null;
      log.warn("no OpenAI API key — extraction/consolidation disabled (retrieval still works)");
    }
    this.localLlm = localLlm ?? new LocalLlmClient(config, modelRegistry);
    this.fallbackLlm = new FallbackLlmClient(gatewayConfig);
    this.modelRegistry = modelRegistry ?? new ModelRegistry(config.memoryDir);
  }

  private emit(event: LlmTraceEvent): void {
    try {
      const cb = (globalThis as any).__openclawEngramTrace;
      if (typeof cb === "function") cb(event);
    } catch {
      // Never throw — broken subscriber must not crash extraction
    }
  }

  private sanitizeExtractionResult(result: ExtractionResult): ExtractionResult {
    const facts = result.facts.map((fact) => {
      const sanitized = sanitizeMemoryContent(fact.content);
      if (!sanitized.clean) {
        log.warn(`extraction fact sanitized; violations=${sanitized.violations.join(", ")}`);
      }
      return { ...fact, content: sanitized.text };
    });
    return { ...result, facts };
  }

  private sanitizeConsolidationResult(result: ConsolidationResult): ConsolidationResult {
    const items = result.items.map((item) => {
      if (!item.updatedContent) return item;
      const sanitized = sanitizeMemoryContent(item.updatedContent);
      if (!sanitized.clean) {
        log.warn(`consolidation item sanitized (${item.existingId}); violations=${sanitized.violations.join(", ")}`);
      }
      return { ...item, updatedContent: sanitized.text };
    });
    return { ...result, items };
  }

  private async parseWithGatewayFallback<T>(
    traceId: string,
    operation: LlmTraceEvent["operation"],
    startedAtMs: number,
    schema: { parse: (data: unknown) => T },
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: { temperature?: number; maxTokens?: number } = {},
  ): Promise<T | null> {
    const result = await this.fallbackLlm.parseWithSchema(messages, schema, options);
    if (result) {
      const durationMs = Date.now() - startedAtMs;
      this.emit({
        kind: "llm_end",
        traceId,
        model: "fallback",
        operation,
        durationMs,
        output: JSON.stringify(result).slice(0, 2000),
      });
      return result;
    }
    return null;
  }

  async extract(turns: BufferTurn[], existingEntities?: string[]): Promise<ExtractionResult> {

    // Guard: skip if buffer is empty or all turns are whitespace-only
    const substantiveTurns = turns.filter((t) => t.content.trim().length > 0);
    if (substantiveTurns.length === 0) {
      log.debug("extraction skipped — no substantive turns in buffer");
      return { facts: [], profileUpdates: [], entities: [], questions: [] };
    }

    const conversation = substantiveTurns
      .map((t) => `[${t.role}] ${t.content}`)
      .join("\n\n");

    const traceId = crypto.randomUUID();
    this.emit({ kind: "llm_start", traceId, model: this.config.model, operation: "extraction", input: conversation });
    const startTime = Date.now();

    // Try local LLM first if enabled
    if (this.config.localLlmEnabled) {
      try {
        const localResult = await this.extractWithLocalLlm(conversation, existingEntities);
        if (localResult) {
          const durationMs = Date.now() - startTime;
          this.emit({ kind: "llm_end", traceId, model: this.config.localLlmModel, operation: "extraction", durationMs });
          log.debug(`extraction: used local LLM — ${localResult.facts.length} facts, ${localResult.entities.length} entities`);
          return this.sanitizeExtractionResult(localResult);
        }
        // Local failed, fall back if allowed
        if (!this.config.localLlmFallback) {
          log.warn("extraction: local LLM failed and fallback disabled");
          return { facts: [], profileUpdates: [], entities: [], questions: [] };
        }
        log.info("extraction: local LLM unavailable, falling back to gateway default AI");
      } catch (err) {
        if (!this.config.localLlmFallback) {
          log.warn("extraction: local LLM error and fallback disabled:", err);
          return { facts: [], profileUpdates: [], entities: [], questions: [] };
        }
        log.info("extraction: local LLM error, falling back to gateway default AI:", err);
      }
    }

    // Fall back to gateway's default AI
    log.info("extraction: falling back to gateway default AI");

    try {
      const messages = [
        { role: "system" as const, content: this.buildExtractionInstructions(existingEntities) },
        { role: "user" as const, content: conversation },
      ];

      const result = await this.fallbackLlm.parseWithSchema(
        messages,
        ExtractionResultSchema,
        { temperature: 0.3, maxTokens: 4096 },
      );

      const durationMs = Date.now() - startTime;

      if (result && Array.isArray(result.facts)) {
        this.emit({
          kind: "llm_end", traceId, model: "fallback", operation: "extraction", durationMs,
          output: JSON.stringify(result).slice(0, 2000),
        });
        log.debug(
          `extracted ${result.facts.length} facts, ${result.entities.length} entities, ${(result.questions ?? []).length} questions via fallback`,
        );
        return this.sanitizeExtractionResult({
          ...result,
          questions: result.questions ?? [],
          identityReflection: result.identityReflection ?? undefined,
        } as ExtractionResult);
      }

      log.warn("extraction fallback returned no parsed output");
      return { facts: [], profileUpdates: [], entities: [], questions: [] };
    } catch (err) {
      this.emit({
        kind: "llm_error", traceId, model: "fallback", operation: "extraction",
        durationMs: Date.now() - startTime, error: String(err),
      });
      log.error("extraction fallback failed", err);
      return { facts: [], profileUpdates: [], entities: [], questions: [] };
    }
  }

  /**
   * Extract memories using local LLM with JSON mode.
   * Uses a minimal prompt to fit within local model context limits (typically 4k-8k).
   */
  private async extractWithLocalLlm(conversation: string, existingEntities?: string[]): Promise<ExtractionResult | null> {
    log.debug(
      `extractWithLocalLlm: starting extraction, localLlmEnabled=${this.config.localLlmEnabled}, model=${this.config.localLlmModel}`,
    );

    // Get dynamic context sizes based on model capabilities (with optional user override)
    const contextSizes = this.modelRegistry.calculateContextSizes(
      this.config.localLlmModel,
      this.config.localLlmMaxContext
    );
    log.debug(`Model context: ${contextSizes.description}`);

    const maxConversationChars = contextSizes.maxInputChars;
    const truncatedConversation = conversation.length > maxConversationChars
      ? conversation.slice(0, maxConversationChars) + "\n\n[truncated]"
      : conversation;

    const localPrompt = `You are a memory extraction system. Extract durable, reusable memories from this conversation.

Memory categories — use the MOST SPECIFIC category that fits:
- fact: Objective information about the world
- preference: User likes, dislikes, or stylistic choices
- correction: User correcting a mistake (highest priority)
- entity: People, projects, tools, companies (use canonical hyphenated names like "my-project")
- decision: Choices made with rationale
- relationship: How entities relate (e.g., "Alice manages Bob")
- principle: Durable rules or operating beliefs (e.g., "never use X API")
- commitment: Promises, obligations, deadlines
- moment: Emotionally significant events
- skill: Demonstrated capabilities

IMPORTANT: Do NOT label everything as "fact". Use "decision" for architectural choices, "commitment" for deadlines/promises, "principle" for reusable rules, "correction" for when the user rejects a suggestion, etc.

=== DO NOT EXTRACT (negative examples) ===
These are operational noise - skip them:
- "The user has a cron job that runs every 30 minutes" (scheduled task descriptions)
- "The user encountered error XYZ at 3:45 PM" (temporary error states)
- "The file is located at /path/to/project/file" (transient file paths)
- "The system is using 4GB of memory" (current resource usage)
- "The user ran the 'git status' command" (individual command executions)
- "The conversation took place on Tuesday" (session metadata)
- "The agent read the file at /path/to/file.txt" (agent's own actions)
- "The user's OpenClaw automation posts to #channel on failures" (automation behavior descriptions)
- "The user stores state in /path/to/state.json" (implementation details)
- "The X-watch automation has been stalled for 58 hours" (system status updates)
- "The user processed 5 batch files and extracted insights" (processing summaries)
- "The user has a cron job that runs a Checkpoint Loop every 2 hours" (automation schedules)
- "The user runs a Morning Surprise cron job daily at 7:30 AM" (automation schedules)
- "The user runs an X Bookmarks → Insights pipeline hourly at :13" (automation schedules)
- "The user's system mines X/Twitter mentions for ideas every 10a/2p/6p" (automation schedules)
- "The user runs a Health Insights cron job weekday mornings" (automation schedules)
- "The system monitors the showcase page every 12 hours" (system monitoring configurations)

=== DO EXTRACT (positive examples) ===
These are durable insights - capture them:
- "The user prefers dark mode interfaces and finds light mode uncomfortable" (preference)
- "The user works primarily with TypeScript and avoids Python for frontend code" (long-term fact)
- "The user's side project 'alpha-trader' uses a custom algorithm for arbitrage" (entity + detail)
- "The user corrected that PostgreSQL 15 is required, not version 14" (correction)
- "The user never commits code without running tests first" (principle)
- "The user has a meeting with the design team every Friday at 2pm" (commitment)

=== Rules ===
- Extract only NEW information worth remembering across sessions
- Skip transient details (file paths, current errors, temporary states, agent actions)
- Confidence: Explicit (0.95-1.0), Implied (0.70-0.94), Inferred (0.40-0.69), Speculative (0.00-0.39)
- Corrections get highest confidence (0.95+)
- Each fact should be standalone and self-contained
- CRITICAL: Use canonical hyphenated entity names (e.g., "jane-doe" not "janedoe")
- CRITICAL: NEVER extract the same fact twice - check for duplicates before adding to facts array
- CRITICAL: NEVER extract cron job schedules, automation configurations, or system monitoring details (these are operational noise)
- If uncertain about relevance, prefer NOT extracting

Also generate:
1. 1-3 genuine questions you're curious about from this conversation
2. Profile updates about user patterns/behaviors (if any)
3. Relationships between entities (max 5). Use normalized names like "person-jane-doe", "company-acme-corp".

Output JSON:
{
  "facts": [{"category": "decision", "content": "Chose X over Y because...", "importance": 8, "confidence": 0.9}, {"category": "commitment", "content": "Must deliver X by date", "importance": 10, "confidence": 1.0}, {"category": "fact", "content": "X uses Y technology", "importance": 6, "confidence": 0.95}, {"category": "principle", "content": "Always do X to avoid Y", "importance": 8, "confidence": 0.9}],
  "entities": [{"name": "...", "type": "person|company|project|tool|other"}],
  "profileUpdates": ["..."],
  "questions": [{"question": "...", "context": "..."}],
  "relationships": [{"source": "person-jane-doe", "target": "company-acme-corp", "label": "works at"}]
}

Conversation:
${truncatedConversation}`;

    log.debug(
      `extractWithLocalLlm: calling localLlm.chatCompletion with prompt length ${localPrompt.length}...`,
    );
    const response = await this.localLlm.chatCompletion(
      [
        { role: "system", content: "You are a memory extraction system. Output valid JSON only." },
        { role: "user", content: localPrompt },
      ],
      { temperature: 0.1, maxTokens: contextSizes.maxOutputTokens, operation: "extraction" },
    );

    if (!response?.content) {
      log.debug("extractWithLocalLlm: chatCompletion returned null or empty content");
      return null;
    }

    const content = response.content.trim();
    // Avoid logging model output content by default (may contain user data).
    log.debug(`extractWithLocalLlm: got response content, length=${content.length}`);

    try {
      for (const candidate of extractJsonCandidates(content)) {
        try {
          log.debug(`extractWithLocalLlm: attempting JSON parse, candidate length=${candidate.length}`);
          const parsed = JSON.parse(candidate);

          // Validate and normalize
          const entities = Array.isArray((parsed as any).entities)
            ? (parsed as any).entities
                .map((e: any) => ({
                  name: typeof e?.name === "string" ? e.name : "",
                  type: typeof e?.type === "string" ? e.type : "other",
                  // Local models frequently omit or malform `facts`; harden to avoid runtime crashes downstream.
                  facts: Array.isArray(e?.facts)
                    ? e.facts.filter((f: any) => typeof f === "string")
                    : [],
                }))
                .filter((e: any) => e.name.length > 0)
            : [];

          const result: ExtractionResult = {
            facts: Array.isArray((parsed as any).facts) ? (parsed as any).facts : [],
            entities,
            profileUpdates: Array.isArray((parsed as any).profileUpdates)
              ? (parsed as any).profileUpdates
              : [],
            questions: Array.isArray((parsed as any).questions) ? (parsed as any).questions : [],
            identityReflection: (parsed as any).identityReflection ?? undefined,
            relationships: Array.isArray((parsed as any).relationships)
              ? (parsed as any).relationships.filter(
                  (r: any) => typeof r?.source === "string" && typeof r?.target === "string" && typeof r?.label === "string",
                )
              : undefined,
          };

          log.debug(
            `extractWithLocalLlm: successfully parsed response, facts=${result.facts.length}, entities=${result.entities.length}, profileUpdates=${result.profileUpdates.length}, questions=${result.questions.length}`,
          );
          return result;
        } catch {
          // keep trying candidates
        }
      }
      return null;
    } catch (err) {
      // Try to extract partial facts from truncated JSON
      log.debug("extractWithLocalLlm: JSON parse failed, attempting partial extraction...");
      const partial = this.extractPartialFacts(content);
      if (partial.facts.length > 0 || partial.entities.length > 0) {
        log.debug(
          `extractWithLocalLlm: extracted ${partial.facts.length} partial facts from truncated JSON`,
        );
        return partial;
      }

      // Could not extract anything
      const errMsg = err instanceof Error ? err.message : String(err);
      log.debug(`extractWithLocalLlm: JSON parse error: ${errMsg}`);
      return null;
    }
  }

  /**
   * Extract partial facts from truncated JSON responses.
   * Local LLMs sometimes hit token limits mid-JSON. This tries to salvage valid facts.
   */
  private extractPartialFacts(jsonStr: string): ExtractionResult {
    const allowedCategories = new Set([
      "fact",
      "preference",
      "correction",
      "entity",
      "decision",
      "relationship",
      "principle",
      "commitment",
      "moment",
      "skill",
    ]);
    const allowedEntityTypes = new Set([
      "person",
      "project",
      "tool",
      "company",
      "place",
      "other",
    ]);

    const facts: ExtractionResult["facts"] = [];
    const entities: ExtractionResult["entities"] = [];

    try {
      // Find all complete fact objects (ones with all required fields)
      const factRegex = /\{\s*"category"\s*:\s*"([^"]+)"\s*,\s*"content"\s*:\s*"([^"]+)"\s*,\s*"confidence"\s*:\s*([0-9.]+)/g;
      let match;
      while ((match = factRegex.exec(jsonStr)) !== null) {
        const rawCat = match[1];
        const category = allowedCategories.has(rawCat) ? (rawCat as ExtractionResult["facts"][number]["category"]) : "fact";
        facts.push({
          category,
          content: match[2].replace(/\\n/g, '\n').replace(/\\"/g, '"'),
          confidence: parseFloat(match[3]),
          tags: [],
        });
      }

      // Find all complete entity objects
      const entityRegex = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"type"\s*:\s*"([^"]+)"/g;
      while ((match = entityRegex.exec(jsonStr)) !== null) {
        const rawType = match[2];
        const type = allowedEntityTypes.has(rawType) ? (rawType as ExtractionResult["entities"][number]["type"]) : "other";
        entities.push({
          name: match[1],
          type,
          facts: [],
        });
      }
    } catch {
      // Ignore regex errors
    }

    return { facts, entities, profileUpdates: [], questions: [] };
  }

  /**
   * Build extraction instructions shared between local and cloud LLM.
   */
  private buildExtractionInstructions(existingEntities?: string[]): string {
    return `You are a memory extraction system. Analyze the following conversation and extract durable, reusable memories.

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
Also extract relationships between entities mentioned in the conversation.
- Format: {source: "entity-name", target: "entity-name", label: "relationship description"}
- Max 5 relationships per extraction
- Only include clear, durable relationships (e.g., "works at", "created", "manages", "uses")
- Use normalized entity names (e.g., "person-jane-doe", "company-acme-corp")

Also generate 1-3 genuine questions you're curious about based on this conversation. These should be things you'd actually want answers to in future sessions — not prompts, but real curiosity.

Finally, write a brief identity reflection about the AGENT who had this conversation (not about you, the extraction system). Based on what the agent said and did in the conversation:
- What communication patterns did the agent show? (e.g., proactive vs reactive, verbose vs concise)
- Did the agent handle the user's needs well or miss something?
- What behavioral tendencies are visible? (e.g., cautious, creative, thorough, impatient)
- What could the agent improve next time?
Do NOT write about the extraction process itself. Do NOT say things like "I extracted durable facts" — that's about YOUR job, not the agent's behavior.`;
  }

  async consolidate(
    newMemories: MemoryFile[],
    existingMemories: MemoryFile[],
    currentProfile: string,
  ): Promise<ConsolidationResult> {
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

    const cTraceId = crypto.randomUUID();
    this.emit({ kind: "llm_start", traceId: cTraceId, model: this.config.model, operation: "consolidation", input: newList });
    const cStartTime = Date.now();

    // Try local LLM first if enabled
    if (this.config.localLlmEnabled) {
      try {
        const localResult = await this.consolidateWithLocalLlm(newList, existingList, currentProfile);
        if (localResult) {
          const durationMs = Date.now() - cStartTime;
          this.emit({ kind: "llm_end", traceId: cTraceId, model: this.config.localLlmModel, operation: "consolidation", durationMs });
          log.debug(`consolidation: used local LLM — ${localResult.items.length} decisions`);
          return this.sanitizeConsolidationResult(localResult);
        }
        if (!this.config.localLlmFallback) {
          log.warn("consolidation: local LLM failed and fallback disabled");
          return { items: [], profileUpdates: [], entityUpdates: [] };
        }
        log.info("consolidation: local LLM unavailable, falling back to gateway AI");
      } catch (err) {
        if (!this.config.localLlmFallback) {
          log.warn("consolidation: local LLM error and fallback disabled:", err);
          return { items: [], profileUpdates: [], entityUpdates: [] };
        }
        log.info("consolidation: local LLM error, falling back to gateway AI:", err);
      }
    }

    const fallbackResult = await this.parseWithGatewayFallback(
      cTraceId,
      "consolidation",
      cStartTime,
      ConsolidationResultSchema,
      [
        {
          role: "system",
          content: `You are a memory consolidation system. Compare new memories against existing ones and decide what to do with each.

Actions:
- ADD: Keep the new memory as-is (no duplicate exists)
- MERGE: Combine with an existing memory (provide mergeWith ID and updated content)
- UPDATE: Replace existing memory content (provide updated content)
- INVALIDATE: Remove existing memory (it's been superseded or is wrong)
- SKIP: This new memory is redundant (exact duplicate or subset of existing)

Also:
- Suggest profile updates based on patterns across memories
- Identify entity updates for entity tracking`,
        },
        {
          role: "user",
          content: `Current behavioral profile:
${currentProfile || "(empty)"}

Existing memories:
${existingList || "(none)"}

New memories to consolidate:
${newList}

Consolidate the new memories against existing ones.`,
        },
      ],
      { temperature: 0.3, maxTokens: 4096 },
    );
    if (fallbackResult) {
      log.debug(`consolidation: ${fallbackResult.items.length} decisions via fallback`);
      return this.sanitizeConsolidationResult({
        items: fallbackResult.items.map((item) => ({
          ...item,
          mergeWith: item.mergeWith ?? undefined,
          updatedContent: item.updatedContent ?? undefined,
        })),
        profileUpdates: fallbackResult.profileUpdates,
        entityUpdates: fallbackResult.entityUpdates,
      });
    }

    // Fall back to OpenAI API
    if (!this.client) {
      log.warn("consolidation skipped — no OpenAI API key and local LLM failed/disabled");
      return { items: [], profileUpdates: [], entityUpdates: [] };
    }

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
        return this.sanitizeConsolidationResult(response.output_parsed as ConsolidationResult);
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
   * Consolidate memories using local LLM.
   */
  private async consolidateWithLocalLlm(
    newList: string,
    existingList: string,
    currentProfile: string,
  ): Promise<ConsolidationResult | null> {
    // Get dynamic context sizes
    const contextSizes = this.modelRegistry.calculateContextSizes(
      this.config.localLlmModel,
      this.config.localLlmMaxContext
    );
    log.debug(`Consolidation model context: ${contextSizes.description}`);

    const prompt = `You are a memory consolidation system. Compare new memories against existing ones and decide what to do with each.

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
${newList}

Respond with valid JSON matching this schema:
{
  "items": [
    {"memoryId": "id", "action": "ADD|MERGE|UPDATE|INVALIDATE|SKIP", "reason": "why", "updatedContent": "optional new content"}
  ],
  "profileUpdates": [{"section": "section name", "content": "new bullet"}],
  "entityUpdates": [{"entityId": "id", "updates": {"field": "value"}}]
}`;

    const response = await this.localLlm.chatCompletion(
      [
        { role: "system", content: "You are a memory consolidation system. Output valid JSON only." },
        { role: "user", content: prompt },
      ],
      { temperature: 0.3, maxTokens: contextSizes.maxOutputTokens, operation: "consolidation" },
    );

    if (!response?.content) {
      return null;
    }

    try {
      const content = response.content.trim();
      for (const candidate of extractJsonCandidates(content)) {
        try {
          const parsed = JSON.parse(candidate);
          return {
            items: Array.isArray((parsed as any).items) ? (parsed as any).items : [],
            profileUpdates: Array.isArray((parsed as any).profileUpdates)
              ? (parsed as any).profileUpdates
              : [],
            entityUpdates: Array.isArray((parsed as any).entityUpdates)
              ? (parsed as any).entityUpdates
              : [],
          } as ConsolidationResult;
        } catch {
          // keep trying candidates
        }
      }
      return null;
    } catch (err) {
      log.warn("local LLM consolidation: failed to parse JSON response:", err);
      return null;
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
    const pTraceId = crypto.randomUUID();
    this.emit({ kind: "llm_start", traceId: pTraceId, model: this.config.model, operation: "profile_consolidation", input: fullProfileContent.slice(0, 2000) });
    const pStartTime = Date.now();

    // Try local LLM first if enabled
    if (this.config.localLlmEnabled) {
      try {
        const localResult = await this.consolidateProfileWithLocalLlm(fullProfileContent);
        if (localResult) {
          const durationMs = Date.now() - pStartTime;
          this.emit({ kind: "llm_end", traceId: pTraceId, model: this.config.localLlmModel, operation: "profile_consolidation", durationMs });
          log.debug(`profile consolidation: used local LLM — removed ${localResult.removedCount} items`);
          return localResult;
        }
        if (!this.config.localLlmFallback) {
          log.warn("profile consolidation: local LLM failed and fallback disabled");
          return null;
        }
        log.info("profile consolidation: local LLM unavailable, falling back to gateway AI");
      } catch (err) {
        if (!this.config.localLlmFallback) {
          log.warn("profile consolidation: local LLM error and fallback disabled:", err);
          return null;
        }
        log.info("profile consolidation: local LLM error, falling back to gateway AI:", err);
      }
    }

    const profileFallback = await this.parseWithGatewayFallback(
      pTraceId,
      "profile_consolidation",
      pStartTime,
      ProfileConsolidationResultSchema,
      [
        {
          role: "system",
          content: `You are a profile consolidation system. You are given a behavioral profile (markdown) that has grown too large. Your job is to produce a CONSOLIDATED version that:

1. PRESERVES all ## section headers and their structure
2. MERGES duplicate or near-duplicate bullet points into single, clear statements
3. REMOVES stale information that has been superseded by newer bullets
4. REMOVES trivial or overly specific operational details that won't be useful across sessions
5. KEEPS the most important, durable observations about the user's preferences, habits, identity, and working style
6. Target roughly 400 lines — this is a soft target, prioritize quality over length
7. Write in the same style as the existing profile — concise bullets, no fluff

The output should be the COMPLETE consolidated profile as valid markdown, starting with "# Behavioral Profile".`,
        },
        { role: "user", content: fullProfileContent },
      ],
      { temperature: 0.3, maxTokens: 4096 },
    );
    if (profileFallback) {
      log.debug(
        `profile consolidation: removed ${profileFallback.removedCount} items — ${profileFallback.summary} (fallback)`,
      );
      return profileFallback;
    }

    // Fall back to OpenAI API
    if (!this.client) {
      log.warn("profile consolidation skipped — no OpenAI API key and local LLM failed/disabled");
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
   * Consolidate profile using local LLM.
   */
  private async consolidateProfileWithLocalLlm(
    fullProfileContent: string,
  ): Promise<{ consolidatedProfile: string; removedCount: number; summary: string } | null> {
    // Get dynamic context sizes
    const contextSizes = this.modelRegistry.calculateContextSizes(
      this.config.localLlmModel,
      this.config.localLlmMaxContext
    );
    log.debug(`Profile consolidation model context: ${contextSizes.description}`);

    const prompt = `You are a profile consolidation system. You are given a behavioral profile (markdown) that has grown too large. Your job is to produce a CONSOLIDATED version that:

1. PRESERVES all ## section headers and their structure
2. MERGES duplicate or near-duplicate bullet points into single, clear statements
3. REMOVES stale information that has been superseded by newer bullets
4. REMOVES trivial or overly specific operational details that won't be useful across sessions
5. KEEPS the most important, durable observations about the user's preferences, habits, identity, and working style
6. Target roughly 400 lines — this is a soft target, prioritize quality over length
7. Write in the same style as the existing profile — concise bullets, no fluff

Profile to consolidate:
${fullProfileContent}

Respond with valid JSON matching this schema:
{
  "consolidatedProfile": "# Behavioral Profile\\n\\n... (complete markdown)",
  "removedCount": 42,
  "summary": "brief summary of what was consolidated"
}`;

    const response = await this.localLlm.chatCompletion(
      [
        { role: "system", content: "You are a profile consolidation system. Output valid JSON only." },
        { role: "user", content: prompt },
      ],
      { temperature: 0.3, maxTokens: contextSizes.maxOutputTokens, operation: "profile_consolidation" },
    );

    if (!response?.content) {
      return null;
    }

    try {
      const content = response.content.trim();
      for (const candidate of extractJsonCandidates(content)) {
        try {
          const parsed = JSON.parse(candidate);
          return {
            consolidatedProfile: String((parsed as any).consolidatedProfile || ""),
            removedCount: Number((parsed as any).removedCount || 0),
            summary: String((parsed as any).summary || ""),
          };
        } catch {
          // keep trying candidates
        }
      }
      return null;
    } catch (err) {
      log.warn("local LLM profile consolidation: failed to parse JSON response:", err);
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
    const iTraceId = crypto.randomUUID();
    this.emit({ kind: "llm_start", traceId: iTraceId, model: this.config.model, operation: "identity_consolidation", input: fullIdentityContent.slice(0, 2000) });
    const iStartTime = Date.now();

    // Try local LLM first if enabled
    if (this.config.localLlmEnabled) {
      try {
        const localResult = await this.consolidateIdentityWithLocalLlm(fullIdentityContent);
        if (localResult) {
          const durationMs = Date.now() - iStartTime;
          this.emit({ kind: "llm_end", traceId: iTraceId, model: this.config.localLlmModel, operation: "identity_consolidation", durationMs });
          log.debug(`identity consolidation: used local LLM — ${localResult.learnedPatterns.length} patterns`);
          return localResult;
        }
        if (!this.config.localLlmFallback) {
          log.warn("identity consolidation: local LLM failed and fallback disabled");
          return null;
        }
        log.info("identity consolidation: local LLM unavailable, falling back to gateway AI");
      } catch (err) {
        if (!this.config.localLlmFallback) {
          log.warn("identity consolidation: local LLM error and fallback disabled:", err);
          return null;
        }
        log.info("identity consolidation: local LLM error, falling back to gateway AI:", err);
      }
    }

    const identityFallback = await this.parseWithGatewayFallback(
      iTraceId,
      "identity_consolidation",
      iStartTime,
      IdentityConsolidationResultSchema,
      [
        {
          role: "system",
          content: `You are an identity consolidation system. You are given the full contents of an IDENTITY.md file that contains many individual reflection entries. Your job is to:

1. Read all the reflection entries (sections starting with "## Reflection")
2. Extract the most important, durable behavioral patterns and lessons learned
3. Consolidate them into concise, standalone statements (aim for 10-25 key patterns)
4. Remove redundancy — if multiple reflections say the same thing, merge into one clear statement
5. Prioritize patterns that are actionable and recurring over one-off observations
6. Write a brief summary paragraph

The goal is to reduce a bloated file to a compact, high-signal set of learned patterns while preserving all genuinely useful self-knowledge.`,
        },
        { role: "user", content: fullIdentityContent },
      ],
      { temperature: 0.3, maxTokens: 4096 },
    );
    if (identityFallback) {
      log.debug(
        `identity consolidation: ${identityFallback.learnedPatterns.length} patterns (fallback)`,
      );
      return identityFallback;
    }

    // Fall back to OpenAI API
    if (!this.client) {
      log.warn("identity consolidation skipped — no OpenAI API key and local LLM failed/disabled");
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
   * Consolidate identity using local LLM.
   */
  private async consolidateIdentityWithLocalLlm(
    fullIdentityContent: string,
  ): Promise<{ learnedPatterns: string[]; summary: string } | null> {
    // Get dynamic context sizes
    const contextSizes = this.modelRegistry.calculateContextSizes(
      this.config.localLlmModel,
      this.config.localLlmMaxContext
    );
    log.debug(`Identity consolidation model context: ${contextSizes.description}`);

    const prompt = `You are an identity consolidation system. You are given the full contents of an IDENTITY.md file that contains many individual reflection entries. Your job is to:

1. Read all the reflection entries (sections starting with "## Reflection")
2. Extract the most important, durable behavioral patterns and lessons learned
3. Consolidate them into concise, standalone statements (aim for 10-25 key patterns)
4. Remove redundancy — if multiple reflections say the same thing, merge into one clear statement
5. Prioritize patterns that are actionable and recurring over one-off observations
6. Write a brief summary paragraph

The goal is to reduce a bloated file to a compact, high-signal set of learned patterns while preserving all genuinely useful self-knowledge.

IDENTITY.md content:
${fullIdentityContent}

Respond with valid JSON matching this schema:
{
  "learnedPatterns": ["pattern 1", "pattern 2", "pattern 3"],
  "summary": "brief summary of consolidation"
}`;

    const response = await this.localLlm.chatCompletion(
      [
        { role: "system", content: "You are an identity consolidation system. Output valid JSON only." },
        { role: "user", content: prompt },
      ],
      { temperature: 0.3, maxTokens: contextSizes.maxOutputTokens, operation: "identity_consolidation" },
    );

    if (!response?.content) {
      return null;
    }

    try {
      const content = response.content.trim();
      for (const candidate of extractJsonCandidates(content)) {
        try {
          const parsed = JSON.parse(candidate);
          return {
            learnedPatterns: Array.isArray((parsed as any).learnedPatterns)
              ? (parsed as any).learnedPatterns
              : [],
            summary: String((parsed as any).summary || ""),
          };
        } catch {
          // keep trying candidates
        }
      }
      return null;
    } catch (err) {
      log.warn("local LLM identity consolidation: failed to parse JSON response:", err);
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
