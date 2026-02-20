import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { Orchestrator } from "./orchestrator.js";
import type { MemoryCategory } from "./types.js";

interface ToolApi {
  registerTool(
    spec: {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
      ) => Promise<{
        content: Array<{ type: string; text: string }>;
        details: undefined;
      }>;
    },
    options: { name: string },
  ): void;
}

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

export function registerTools(api: ToolApi, orchestrator: Orchestrator): void {
  function namespaceFromPath(p: string): string {
    const m = p.match(/[\\/]+namespaces[\\/]+([^\\/]+)[\\/]+/);
    return m && m[1] ? m[1] : orchestrator.config.defaultNamespace;
  }

  api.registerTool(
    {
      name: "memory_search",
      label: "Search Memory",
      description: `Search local memory files using QMD's semantic index. Returns matching memories with snippets and relevance scores.

Returns: Matching memory entries ranked by relevance
Cost: Free (local index query)
Speed: Fast

Best for:
- Finding previously learned facts about the user
- Checking what you know about a topic
- Locating past decisions or corrections`,
      parameters: Type.Object({
        query: Type.String({
          description: "Search query — keywords, phrases, or natural language",
        }),
        namespace: Type.Optional(
          Type.String({
            description:
              "Optional namespace filter. When set, only returns results under memoryDir/namespaces/<namespace>/ (default namespace uses legacy root).",
          }),
        ),
        maxResults: Type.Optional(
          Type.Number({
            description: "Maximum results (default: 8)",
            minimum: 1,
            maximum: 50,
          }),
        ),
        collection: Type.Optional(
          Type.String({
            description:
              "QMD collection to search. Omit for memory collection, use 'global' for all collections.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { query, maxResults, collection, namespace } = params as {
          query: string;
          maxResults?: number;
          collection?: string;
          namespace?: string;
        };

        const results =
          collection === "global"
            ? await orchestrator.qmd.searchGlobal(query, maxResults)
            : await orchestrator.qmd.search(query, undefined, maxResults);

        const filtered =
          namespace && namespace.length > 0
            ? results.filter((r) => namespaceFromPath(r.path) === namespace)
            : results;

        if (filtered.length === 0) {
          return toolResult(`No memories found matching: "${query}"`);
        }

        const formatted = filtered
          .map((r, i) => {
            const snippet = r.snippet
              ? r.snippet.slice(0, 800)
              : "(no preview)";
            return `### [${i + 1}] ${r.path}\nScore: ${r.score.toFixed(3)}\n\n\`\`\`\n${snippet}\n\`\`\``;
          })
          .join("\n\n");

        return toolResult(
          `## Memory Search: "${query}"\n\n${filtered.length} result(s)\n\n${formatted}`,
        );
      },
    },
    { name: "memory_search" },
  );

  api.registerTool(
    {
      name: "memory_feedback",
      label: "Memory Feedback",
      description:
        "Thumbs up/down a memory's relevance. Stored locally and used as a soft ranking bias when enabled.",
      parameters: Type.Object({
        memoryId: Type.String({
          description: "Memory ID (filename without .md), e.g. fact-123",
        }),
        vote: Type.String({
          enum: ["up", "down"],
          description: "up or down",
        }),
        note: Type.Optional(
          Type.String({
            description: "Optional note explaining the feedback (stored locally).",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { memoryId, vote, note } = params as {
          memoryId: string;
          vote: "up" | "down";
          note?: string;
        };

        if (!orchestrator.config.feedbackEnabled) {
          return toolResult(
            "Feedback is disabled. Enable `feedbackEnabled: true` in the Engram plugin config to store feedback.",
          );
        }

        await orchestrator.recordMemoryFeedback(memoryId, vote, note);
        return toolResult(
          `Recorded feedback for ${memoryId}: ${vote}${note ? ` (note: ${note})` : ""}`,
        );
      },
    },
    { name: "memory_feedback" },
  );

  api.registerTool(
    {
      name: "memory_last_recall",
      label: "Last Recall Snapshot",
      description:
        "Fetch the last set of memory IDs that were injected into context for a session. Useful when the user says things like 'why did you say that?' or 'that's not right' and you want to identify which memories may have misled the response.",
      parameters: Type.Object({
        sessionKey: Type.Optional(
          Type.String({
            description:
              "Session key to look up. If omitted, returns the most recent snapshot across all sessions (may be wrong under concurrency).",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { sessionKey } = params as { sessionKey?: string };

        const snap = sessionKey
          ? orchestrator.lastRecall.get(sessionKey)
          : orchestrator.lastRecall.getMostRecent();

        if (!snap) {
          return toolResult("No last-recall snapshot found yet.");
        }

        const prefix = sessionKey
          ? `## Last Recall (${snap.sessionKey})`
          : `## Last Recall (most recent: ${snap.sessionKey})\n\nNOTE: You did not provide sessionKey; under concurrency this may not match your current session.`;

        return toolResult(
          [
            prefix,
            "",
            `Recorded at: ${snap.recordedAt}`,
            `Query hash: ${snap.queryHash} (len=${snap.queryLen})`,
            `Memories (${snap.memoryIds.length}):`,
            ...snap.memoryIds.map((id) => `- ${id}`),
          ].join("\n"),
        );
      },
    },
    { name: "memory_last_recall" },
  );

  api.registerTool(
    {
      name: "memory_feedback_last_recall",
      label: "Feedback Last Recall",
      description:
        "Batch feedback tool for the last recall snapshot. Can mark retrieved memories as 'not useful' (negative examples) so they are softly penalized in future ranking when negative examples are enabled.",
      parameters: Type.Object({
        sessionKey: Type.Optional(
          Type.String({
            description:
              "Session key. If omitted, uses the most recent snapshot across all sessions (may be wrong under concurrency).",
          }),
        ),
        notUsefulMemoryIds: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Memory IDs to mark as not useful. If omitted, you may use usefulMemoryIds + autoMarkOthersNotUseful to mark the rest as not useful.",
          }),
        ),
        usefulMemoryIds: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Memory IDs that were useful. Only used when autoMarkOthersNotUseful=true.",
          }),
        ),
        autoMarkOthersNotUseful: Type.Optional(
          Type.Boolean({
            description:
              "If true, marks all last-recall memory IDs not listed in usefulMemoryIds as not useful. Safer than auto-marking without an explicit useful list.",
          }),
        ),
        note: Type.Optional(
          Type.String({
            description:
              "Optional note explaining why these were not useful (stored locally).",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const {
          sessionKey,
          notUsefulMemoryIds,
          usefulMemoryIds,
          autoMarkOthersNotUseful,
          note,
        } = params as {
          sessionKey?: string;
          notUsefulMemoryIds?: string[];
          usefulMemoryIds?: string[];
          autoMarkOthersNotUseful?: boolean;
          note?: string;
        };

        if (!orchestrator.config.negativeExamplesEnabled) {
          return toolResult(
            "Negative examples are disabled. Enable `negativeExamplesEnabled: true` in the Engram plugin config to store retrieved-but-not-useful feedback and apply penalties.",
          );
        }

        const snap = sessionKey
          ? orchestrator.lastRecall.get(sessionKey)
          : orchestrator.lastRecall.getMostRecent();

        if (!snap) {
          return toolResult("No last-recall snapshot found yet.");
        }

        let toMark: string[] | null = null;

        if (Array.isArray(notUsefulMemoryIds) && notUsefulMemoryIds.length > 0) {
          toMark = notUsefulMemoryIds;
        } else if (autoMarkOthersNotUseful) {
          if (!Array.isArray(usefulMemoryIds) || usefulMemoryIds.length === 0) {
            return toolResult(
              "autoMarkOthersNotUseful=true requires a non-empty usefulMemoryIds list (to avoid accidental mass-negative marking).",
            );
          }
          const useful = new Set(usefulMemoryIds);
          toMark = snap.memoryIds.filter((id) => !useful.has(id));
        }

        if (!toMark || toMark.length === 0) {
          return toolResult(
            "Nothing to record. Provide notUsefulMemoryIds, or provide usefulMemoryIds with autoMarkOthersNotUseful=true.",
          );
        }

        await orchestrator.recordNotUsefulMemories(toMark, note);

        const warn = sessionKey
          ? ""
          : "\n\nNOTE: You did not provide sessionKey; under concurrency this may not match your current session.";

        return toolResult(
          `Recorded ${toMark.length} not-useful memory ID(s) for last recall (${snap.sessionKey}).${warn}`,
        );
      },
    },
    { name: "memory_feedback_last_recall" },
  );

  api.registerTool(
    {
      name: "memory_store",
      label: "Store Memory",
      description: `Explicitly store a memory. Use this when the user directly asks you to remember something, or when you identify critical information that the automatic extraction might miss.

Cost: Free (local file write)
Speed: Instant

Best for:
- User says "remember that..." or "note that..."
- Critical corrections or preferences
- Important decisions or facts`,
      parameters: Type.Object({
        content: Type.String({
          description: "The memory to store — a clear, standalone statement",
        }),
        namespace: Type.Optional(
          Type.String({
            description:
              "Namespace to store into (v3.0+). Omit to store into defaultNamespace.",
          }),
        ),
        category: Type.Optional(
          Type.String({
            description:
              'Category: "fact", "preference", "correction", "entity", "decision", "relationship", "principle", "commitment", "moment", "skill" (default: "fact")',
            enum: ["fact", "preference", "correction", "entity", "decision", "relationship", "principle", "commitment", "moment", "skill"],
          }),
        ),
        tags: Type.Optional(
          Type.Array(Type.String(), {
            description: "Tags for categorization",
          }),
        ),
        entityRef: Type.Optional(
          Type.String({
            description:
              "Entity reference (e.g., person-jane-doe, project-my-app)",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const {
          content,
          namespace,
          category = "fact",
          tags = [],
          entityRef,
        } = params as {
          content: string;
          namespace?: string;
          category?: string;
          tags?: string[];
          entityRef?: string;
        };

        const storage = await orchestrator.getStorage(namespace);
        const id = await storage.writeMemory(
          category as MemoryCategory,
          content,
          {
            confidence: 0.95,
            tags,
            entityRef,
            source: "explicit",
          },
        );

        // Queue debounced QMD maintenance via orchestrator guardrails so new memory becomes searchable.
        orchestrator.requestQmdMaintenanceForTool("memory_store");

        return toolResult(`Memory stored: ${id}${namespace ? ` (namespace: ${namespace})` : ""}\n\nContent: ${content}`);
      },
    },
    { name: "memory_store" },
  );

  api.registerTool(
    {
      name: "memory_promote",
      label: "Promote Memory To Shared",
      description:
        "Copy a memory into the shared namespace (v3.0+). This is intended for curated promotion of agent-specific learning into a shared brain.",
      parameters: Type.Object({
        memoryId: Type.String({
          description: "Memory ID (filename without .md), e.g. fact-123",
        }),
        fromNamespace: Type.Optional(
          Type.String({
            description: "Source namespace (default: defaultNamespace).",
          }),
        ),
        toNamespace: Type.Optional(
          Type.String({
            description: "Target namespace (default: sharedNamespace).",
          }),
        ),
        note: Type.Optional(
          Type.String({
            description:
              "Optional note explaining why this should be shared (stored as a tag-like annotation).",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.config.namespacesEnabled) {
          return toolResult(
            "Namespaces are disabled. Enable `namespacesEnabled: true` to use memory promotion.",
          );
        }

        const { memoryId, fromNamespace, toNamespace, note } = params as {
          memoryId: string;
          fromNamespace?: string;
          toNamespace?: string;
          note?: string;
        };

        const srcNs = fromNamespace && fromNamespace.length > 0 ? fromNamespace : orchestrator.config.defaultNamespace;
        const dstNs = toNamespace && toNamespace.length > 0 ? toNamespace : orchestrator.config.sharedNamespace;

        const src = await orchestrator.getStorage(srcNs);
        const mem = await src.getMemoryById(memoryId);
        if (!mem) {
          return toolResult(`Memory not found in ${srcNs}: ${memoryId}`);
        }

        const dst = await orchestrator.getStorage(dstNs);
        const newId = await dst.writeMemory(mem.frontmatter.category, mem.content, {
          confidence: mem.frontmatter.confidence,
          tags: Array.from(new Set([...(mem.frontmatter.tags ?? []), "promoted", `promotedFrom:${srcNs}:${memoryId}`, ...(note ? [`note:${note}`] : [])])),
          entityRef: mem.frontmatter.entityRef,
          source: "promote",
          importance: mem.frontmatter.importance,
          supersedes: mem.frontmatter.supersedes,
          links: mem.frontmatter.links,
        });

        return toolResult(`Promoted ${srcNs}:${memoryId} → ${dstNs}:${newId}`);
      },
    },
    { name: "memory_promote" },
  );

  api.registerTool(
    {
      name: "memory_profile",
      label: "View User Profile",
      description: `Read the user's behavioral profile — a living document of their preferences, habits, and personality.

Cost: Free (local file read)
Speed: Instant

Best for:
- Understanding the user holistically
- Checking preferences before making decisions
- "What do you know about me?"`,
      parameters: Type.Object({}),
      async execute() {
        const profile = await orchestrator.storage.readProfile();
        if (!profile) {
          return toolResult(
            "No profile built yet. The profile builds automatically through conversations.",
          );
        }
        return toolResult(`## User Profile\n\n${profile}`);
      },
    },
    { name: "memory_profile" },
  );

  api.registerTool(
    {
      name: "memory_entities",
      label: "List Known Entities",
      description: `List all tracked entities (people, projects, tools, companies) with their facts.

Cost: Free (local file read)
Speed: Instant

Best for:
- Seeing all known entities
- Looking up facts about a specific entity`,
      parameters: Type.Object({
        name: Type.Optional(
          Type.String({
            description:
              "Specific entity to look up (e.g., person-jane-doe)",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { name } = params as { name?: string };

        if (name) {
          const content = await orchestrator.storage.readEntity(name);
          if (!content) {
            return toolResult(`Entity "${name}" not found.`);
          }
          return toolResult(content);
        }

        const entities = await orchestrator.storage.readEntities();
        if (entities.length === 0) {
          return toolResult(
            "No entities tracked yet. Entities build automatically through conversations.",
          );
        }

        return toolResult(
          `## Known Entities (${entities.length})\n\n${entities.map((e) => `- ${e}`).join("\n")}`,
        );
      },
    },
    { name: "memory_entities" },
  );

  api.registerTool(
    {
      name: "memory_questions",
      label: "View/Manage Questions",
      description: `View open questions the AI is curious about, or resolve answered questions.

Cost: Free (local file read)
Speed: Instant

Best for:
- Seeing what questions have been generated from past conversations
- Resolving questions that have been answered
- "What questions do you have for me?"`,
      parameters: Type.Object({
        action: Type.Optional(
          Type.String({
            description: '"list" (default) to show unresolved questions, "all" to show all, "resolve" to mark one as answered',
            enum: ["list", "all", "resolve"],
          }),
        ),
        questionId: Type.Optional(
          Type.String({
            description: "Question ID to resolve (required when action is 'resolve')",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { action = "list", questionId } = params as {
          action?: string;
          questionId?: string;
        };

        if (action === "resolve") {
          if (!questionId) {
            return toolResult("Error: questionId is required when action is 'resolve'");
          }
          const resolved = await orchestrator.storage.resolveQuestion(questionId);
          return toolResult(resolved ? `Question ${questionId} marked as resolved.` : `Question ${questionId} not found.`);
        }

        const unresolvedOnly = action !== "all";
        const questions = await orchestrator.storage.readQuestions({ unresolvedOnly });

        if (questions.length === 0) {
          return toolResult(unresolvedOnly
            ? "No unresolved questions. Questions are generated automatically during memory extraction."
            : "No questions found.");
        }

        const formatted = questions.map((q, i) =>
          `### [${i + 1}] ${q.id}\nPriority: ${q.priority.toFixed(2)} | Created: ${q.created}${q.resolved ? " | RESOLVED" : ""}\n\n${q.question}\n\n_Context: ${q.context}_`
        ).join("\n\n");

        return toolResult(`## Questions (${questions.length})\n\n${formatted}`);
      },
    },
    { name: "memory_questions" },
  );

  api.registerTool(
    {
      name: "memory_identity",
      label: "View Identity Reflections",
      description: `Read the agent's identity reflections from the workspace IDENTITY.md file.

Cost: Free (local file read)
Speed: Instant

Best for:
- Understanding the agent's self-model and growth
- "What have you learned about yourself?"
- Reviewing identity development over time`,
      parameters: Type.Object({}),
      async execute() {
        const workspaceDir = path.join(process.env.HOME ?? "~", ".openclaw", "workspace");
        const identity = await orchestrator.storage.readIdentity(workspaceDir);
        if (!identity) {
          return toolResult("No identity file found. Identity reflections build automatically through conversations when identityEnabled is true.");
        }
        return toolResult(`## Agent Identity\n\n${identity}`);
      },
    },
    { name: "memory_identity" },
  );

  api.registerTool(
    {
      name: "memory_summarize_hourly",
      label: "Generate Hourly Summaries",
      description: `Generate hourly summaries for the previous hour's conversations across all active sessions.

Cost: Low (uses configured summary model)
Speed: Fast

Best for:
- Cron job scheduled hourly summarization
- Manual trigger to summarize recent conversations
- Building conversation summaries for context preservation`,
      parameters: Type.Object({}),
      async execute() {
        try {
          await orchestrator.summarizer.runHourly();
          return toolResult("Hourly summarization completed. Check the summaries directory for results.");
        } catch (err) {
          return toolResult(`Hourly summarization failed: ${err}`);
        }
      },
    },
    { name: "memory_summarize_hourly" },
  );

  api.registerTool(
    {
      name: "conversation_index_update",
      label: "Update Conversation Index",
      description: `Chunk recent transcript history into "conversation chunk" documents and (best-effort) update the semantic index for past-conversation recall.

This is optional and default-off (see config: conversationIndexEnabled).

Best for:
- Cron jobs to keep the conversation index fresh
- Manual rebuild after changing chunk sizes or retention`,
      parameters: Type.Object({
        sessionKey: Type.Optional(
          Type.String({
            description:
              "Session key to index. If omitted, Engram will best-effort scan transcript storage and index all discovered sessionKeys.",
          }),
        ),
        hours: Type.Optional(
          Type.Number({
            description: "How many hours of transcript history to include (default: 24).",
            minimum: 1,
            maximum: 24 * 30,
          }),
        ),
        embed: Type.Optional(
          Type.Boolean({
            description:
              "If true, run QMD embed after update for this invocation. If omitted, uses conversationIndexEmbedOnUpdate config.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.config.conversationIndexEnabled) {
          return toolResult(
            "Conversation indexing is disabled. Enable `conversationIndexEnabled: true` in the Engram plugin config to use this tool.",
          );
        }

        const { sessionKey, hours, embed } = params as { sessionKey?: string; hours?: number; embed?: boolean };
        const h = typeof hours === "number" && Number.isFinite(hours) ? hours : 24;

        if (sessionKey) {
          const res = await orchestrator.updateConversationIndex(sessionKey, h, { embed });
          if (res.skipped && res.reason === "min_interval") {
            const retrySec = Math.max(1, Math.ceil((res.retryAfterMs ?? 0) / 1000));
            return toolResult(
              `Skipped for sessionKey=${sessionKey} due to min interval. Retry in ~${retrySec}s or pass a higher interval config.`,
            );
          }
          return toolResult(
            `Indexed ${res.chunks} chunk(s) for sessionKey=${sessionKey}.${res.embedded ? " Ran embed." : ""}`,
          );
        }

        const sessions = await orchestrator.transcript.listSessionKeys();
        let total = 0;
        let skipped = 0;
        const skippedIds: string[] = [];
        let embeddedRuns = 0;
        for (const sk of sessions) {
          const res = await orchestrator.updateConversationIndex(sk, h, { embed });
          total += res.chunks;
          if (res.skipped) {
            skipped += 1;
            skippedIds.push(sk);
          }
          if (res.embedded) embeddedRuns += 1;
        }
        const skippedSummary =
          skipped > 0
            ? ` Skipped ${skipped} session(s) due to min-interval gating: ${skippedIds.slice(0, 6).join(", ")}${skippedIds.length > 6 ? "..." : ""}.`
            : "";
        const embedSummary = embeddedRuns > 0 ? ` Ran embed for ${embeddedRuns} session update(s).` : "";
        return toolResult(
          `Indexed ${total} total chunk(s) across ${sessions.length} session(s).${skippedSummary}${embedSummary}`,
        );
      },
    },
    { name: "conversation_index_update" },
  );

  api.registerTool(
    {
      name: "shared_context_write_output",
      label: "Write Shared Agent Output",
      description:
        "Write an agent work product into the shared-context directory (v4.0). Other agents can read these files to coordinate without explicit message passing.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Agent ID producing this output (e.g., generalist, oracle, flash)." }),
        title: Type.String({ description: "Short title for the output." }),
        content: Type.String({ description: "Markdown content to write." }),
      }),
      async execute(_toolCallId, params) {
        const { agentId, title, content } = params as { agentId: string; title: string; content: string };
        if (!orchestrator.sharedContext) {
          return toolResult(
            "Shared context is disabled. Enable `sharedContextEnabled: true` to use shared-context tools.",
          );
        }
        const fp = await orchestrator.sharedContext.writeAgentOutput({ agentId, title, content });
        return toolResult(`Wrote shared agent output: ${fp}`);
      },
    },
    { name: "shared_context_write_output" },
  );

  api.registerTool(
    {
      name: "shared_feedback_record",
      label: "Record Shared Feedback",
      description:
        "Append an approval/rejection decision into shared-context feedback inbox (v4.0/v5.0). Intended to power compounding learning.",
      parameters: Type.Object({
        agent: Type.String({ description: "Agent name that produced the recommendation/output." }),
        decision: Type.String({
          enum: ["approved", "approved_with_feedback", "rejected"],
          description: "Decision outcome.",
        }),
        reason: Type.String({ description: "Why the decision was made (short but specific)." }),
        date: Type.Optional(Type.String({ description: "ISO timestamp. Defaults to now." })),
        learning: Type.Optional(Type.String({ description: "Optional distilled learning/pattern." })),
        outcome: Type.Optional(Type.String({ description: "Optional downstream outcome (day-one supported; may be empty initially)." })),
        refs: Type.Optional(Type.Array(Type.String(), { description: "Optional references (URLs, IDs, filenames)." })),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.sharedContext) {
          return toolResult(
            "Shared context is disabled. Enable `sharedContextEnabled: true` to record shared feedback.",
          );
        }
        const p = params as any;
        const entry = {
          agent: String(p.agent ?? ""),
          decision: p.decision as "approved" | "approved_with_feedback" | "rejected",
          reason: String(p.reason ?? ""),
          date: typeof p.date === "string" && p.date.length > 0 ? p.date : new Date().toISOString(),
          learning: typeof p.learning === "string" ? p.learning : undefined,
          outcome: typeof p.outcome === "string" ? p.outcome : undefined,
          refs: Array.isArray(p.refs) ? p.refs.map(String) : undefined,
        };
        await orchestrator.sharedContext.appendFeedback(entry);
        return toolResult("OK");
      },
    },
    { name: "shared_feedback_record" },
  );

  api.registerTool(
    {
      name: "shared_priorities_append",
      label: "Append Priorities Inbox",
      description:
        "Append text into shared-context priorities inbox. A curator run should merge this into priorities.md.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Agent ID appending priorities." }),
        text: Type.String({ description: "Priority notes to append (markdown)." }),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.sharedContext) {
          return toolResult(
            "Shared context is disabled. Enable `sharedContextEnabled: true` to write priorities inbox.",
          );
        }
        const { agentId, text } = params as { agentId: string; text: string };
        await orchestrator.sharedContext.appendPrioritiesInbox({ agentId, text });
        return toolResult("OK");
      },
    },
    { name: "shared_priorities_append" },
  );

  api.registerTool(
    {
      name: "shared_context_curate_daily",
      label: "Curate Daily Roundtable",
      description:
        "Curator tool: generate today's roundtable summary in shared-context/roundtable (deterministic baseline).",
      parameters: Type.Object({
        date: Type.Optional(Type.String({ description: "YYYY-MM-DD. Defaults to today." })),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.sharedContext) {
          return toolResult(
            "Shared context is disabled. Enable `sharedContextEnabled: true` to curate roundtables.",
          );
        }
        const { date } = params as { date?: string };
        const fp = await orchestrator.sharedContext.curateDaily({ date });
        return toolResult(`Wrote: ${fp}`);
      },
    },
    { name: "shared_context_curate_daily" },
  );

  api.registerTool(
    {
      name: "compounding_weekly_synthesize",
      label: "Synthesize Weekly Learning",
      description:
        "Generate weekly compounding outputs (v5.0): weekly report + mistakes.json. Designed to work from day one (writes even if no feedback exists yet).",
      parameters: Type.Object({
        weekId: Type.Optional(
          Type.String({
            description:
              "ISO week ID like YYYY-Www. Omit to use current week.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!orchestrator.compounding) {
          return toolResult(
            "Compounding engine is disabled. Enable `compoundingEnabled: true` to use this tool.",
          );
        }
        const { weekId } = params as { weekId?: string };
        const res = await orchestrator.compounding.synthesizeWeekly({ weekId });
        return toolResult(
          `OK\n\nweekId: ${res.weekId}\nreport: ${res.reportPath}\nmistakes: ${res.mistakesCount} patterns`,
        );
      },
    },
    { name: "compounding_weekly_synthesize" },
  );
}
