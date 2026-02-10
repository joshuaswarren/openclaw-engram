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
        const { query, maxResults, collection } = params as {
          query: string;
          maxResults?: number;
          collection?: string;
        };

        const results =
          collection === "global"
            ? await orchestrator.qmd.searchGlobal(query, maxResults)
            : await orchestrator.qmd.search(query, undefined, maxResults);

        if (results.length === 0) {
          return toolResult(`No memories found matching: "${query}"`);
        }

        const formatted = results
          .map((r, i) => {
            const snippet = r.snippet
              ? r.snippet.slice(0, 800)
              : "(no preview)";
            return `### [${i + 1}] ${r.path}\nScore: ${r.score.toFixed(3)}\n\n\`\`\`\n${snippet}\n\`\`\``;
          })
          .join("\n\n");

        return toolResult(
          `## Memory Search: "${query}"\n\n${results.length} result(s)\n\n${formatted}`,
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
          category = "fact",
          tags = [],
          entityRef,
        } = params as {
          content: string;
          category?: string;
          tags?: string[];
          entityRef?: string;
        };

        const id = await orchestrator.storage.writeMemory(
          category as MemoryCategory,
          content,
          {
            confidence: 0.95,
            tags,
            entityRef,
            source: "explicit",
          },
        );

        return toolResult(`Memory stored: ${id}\n\nContent: ${content}`);
      },
    },
    { name: "memory_store" },
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
}
