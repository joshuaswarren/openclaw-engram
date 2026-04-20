import type { Readable, Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { EngramAccessService, EngramAccessRecallResponse } from "./access-service.js";
import { readEnvVar } from "./runtime/env.js";
import type { RecallPlanMode } from "./types.js";
import { validateBriefingFormat } from "./briefing.js";
import { buildCitationGuidance, type CitationMetadata } from "./citations.js";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const MCP_PROTOCOL_VERSION = "2024-11-05";
const LEGACY_MCP_PREFIX = "engram.";
const CANONICAL_MCP_PREFIX = "remnic.";

function toCanonicalToolName(name: string): string {
  return name.startsWith(LEGACY_MCP_PREFIX)
    ? `${CANONICAL_MCP_PREFIX}${name.slice(LEGACY_MCP_PREFIX.length)}`
    : name;
}

function toLegacyToolName(name: string): string {
  return name.startsWith(CANONICAL_MCP_PREFIX)
    ? `${LEGACY_MCP_PREFIX}${name.slice(CANONICAL_MCP_PREFIX.length)}`
    : name;
}

function withToolAliases(tool: McpTool): McpTool[] {
  const canonicalName = toCanonicalToolName(tool.name);
  const canonicalTool = canonicalName === tool.name ? tool : { ...tool, name: canonicalName };
  if (canonicalName === tool.name) return [canonicalTool];
  return [canonicalTool, tool];
}

async function getMcpServerVersion(): Promise<string> {
  const envVersion =
    readEnvVar("OPENCLAW_ENGRAM_VERSION")?.trim() ||
    readEnvVar("npm_package_version")?.trim();
  if (envVersion) return envVersion;
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    const raw = await readFile(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version?.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export class EngramMcpServer {
  private buffer = Buffer.alloc(0);
  private flushTask: Promise<void> | null = null;
  private readonly tools: McpTool[];
  private readonly authenticatedPrincipal?: string;
  /**
   * MCP client info keyed by server-assigned session ID. On each `initialize`
   * handshake the server generates a UUID, stores the client's clientInfo
   * against it, and returns the ID as `Mcp-Session-Id` in the response
   * metadata. Subsequent requests from the same client include this header,
   * allowing per-session clientInfo lookup without cross-session leaks.
   */
  private clientInfoBySession = new Map<string, { name: string; version?: string }>();
  /**
   * Session IDs generated during initialize, keyed by caller-supplied correlation
   * ID (unique per HTTP request) to avoid collisions when multiple clients send
   * initialize with the same JSON-RPC id concurrently.
   */
  private initSessionIds = new Map<string, string>();

  /** Whether oai-mem-citation guidance is explicitly enabled via config. */
  private readonly citationsEnabled: boolean;
  /** Whether to auto-enable citations for Codex adapter connections. */
  private readonly citationsAutoDetect: boolean;

  constructor(
    private readonly service: EngramAccessService,
    options: { principal?: string; citationsEnabled?: boolean; citationsAutoDetect?: boolean } = {},
  ) {
    this.citationsEnabled = options.citationsEnabled === true;
    this.citationsAutoDetect = options.citationsAutoDetect !== false;
    this.authenticatedPrincipal =
      options.principal?.trim() ||
      readEnvVar("OPENCLAW_ENGRAM_ACCESS_PRINCIPAL")?.trim() ||
      undefined;
    this.tools = [
      {
        name: "engram.recall",
        description: "Recall Engram context for a query.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            sessionKey: { type: "string" },
            namespace: { type: "string" },
            topK: { type: "number" },
            mode: { type: "string", enum: ["auto", "no_recall", "minimal", "full", "graph_mode"] },
            includeDebug: { type: "boolean" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.recall_explain",
        description: "Return the last recall snapshot for a session or the most recent one.",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: { type: "string" },
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.recall_tier_explain",
        description:
          "Return a structured tier-explain payload for the last direct-answer-eligible recall (issue #518). Orthogonal to engram.recall_explain, which returns a graph-path explanation.",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: {
              type: "string",
              description: "Optional session key. Omit to read the most recent snapshot.",
            },
            namespace: {
              type: "string",
              description: "Optional namespace to scope the returned snapshot.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.day_summary",
        description:
          "Generate a structured end-of-day summary. When memories is omitted or empty, auto-gathers today's facts and hourly summaries from storage.",
        inputSchema: {
          type: "object",
          properties: {
            memories: { type: "string" },
            sessionKey: { type: "string" },
            namespace: { type: "string" },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_governance_run",
        description: "Run Remnic memory governance in a bounded shadow/apply pass.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            mode: { type: "string", enum: ["shadow", "apply"] },
            recentDays: { type: "number" },
            maxMemories: { type: "number" },
            batchSize: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.procedure_mining_run",
        description:
          "Run procedural memory mining from causal trajectories (issue #519). Respects procedural.enabled; writes under procedures/ when clusters qualify.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        // The canonical `remnic.procedural_stats` alias is added automatically
        // by `withToolAliases` — the dual-naming invariant keeps both names
        // alive for the legacy surface.
        name: "engram.procedural_stats",
        description:
          "Procedural memory stats (issue #567): counts by status, recent write activity, and the active procedural.* config. Read-only, namespace-scoped.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_get",
        description: "Fetch one Remnic memory by id.",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" },
            namespace: { type: "string" },
          },
          required: ["memoryId"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_timeline",
        description: "Fetch one Remnic memory timeline by id.",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" },
            namespace: { type: "string" },
            limit: { type: "number" },
          },
          required: ["memoryId"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_store",
        description: "Store an explicit Remnic memory through the access layer.",
        inputSchema: {
          type: "object",
          properties: {
            schemaVersion: { type: "number" },
            idempotencyKey: { type: "string" },
            dryRun: { type: "boolean" },
            sessionKey: { type: "string" },
            content: { type: "string" },
            category: { type: "string" },
            confidence: { type: "number" },
            namespace: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            entityRef: { type: "string" },
            ttl: { type: "string" },
            sourceReason: { type: "string" },
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.suggestion_submit",
        description: "Queue a suggested Remnic memory for review.",
        inputSchema: {
          type: "object",
          properties: {
            schemaVersion: { type: "number" },
            idempotencyKey: { type: "string" },
            dryRun: { type: "boolean" },
            sessionKey: { type: "string" },
            content: { type: "string" },
            category: { type: "string" },
            confidence: { type: "number" },
            namespace: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            entityRef: { type: "string" },
            ttl: { type: "string" },
            sourceReason: { type: "string" },
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.entity_get",
        description: "Fetch one Engram entity by name.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            namespace: { type: "string" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.review_queue_list",
        description: "Fetch the latest Engram review queue artifact bundle.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string" },
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.observe",
        description: "Feed conversation messages into Engram's memory pipeline (LCM archive + extraction).",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: { type: "string", description: "Conversation session identifier" },
            messages: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["user", "assistant"] },
                  content: { type: "string" },
                },
                required: ["role", "content"],
              },
              description: "Conversation messages to observe",
            },
            namespace: { type: "string" },
            skipExtraction: { type: "boolean" },
          },
          required: ["sessionKey", "messages"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.lcm_search",
        description: "Search the LCM conversation archive for matching content.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            sessionKey: { type: "string", description: "Optional session filter" },
            namespace: { type: "string" },
            limit: { type: "number", description: "Max results to return" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      // ── Continuity / Identity tools ─────────────────────────────────────
      {
        name: "engram.continuity_audit_generate",
        description: "Generate a deterministic identity continuity audit report (weekly/monthly).",
        inputSchema: {
          type: "object",
          properties: {
            period: { type: "string", enum: ["weekly", "monthly"] },
            key: { type: "string", description: "Period key (weekly: YYYY-Www, monthly: YYYY-MM). Defaults to current." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.continuity_incident_open",
        description: "Create a new continuity incident record in append-only storage.",
        inputSchema: {
          type: "object",
          properties: {
            symptom: { type: "string", description: "Observed continuity failure symptom." },
            namespace: { type: "string" },
            triggerWindow: { type: "string", description: "Time window when incident occurred." },
            suspectedCause: { type: "string" },
          },
          required: ["symptom"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.continuity_incident_close",
        description: "Close an open continuity incident with verification details.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Incident ID to close." },
            namespace: { type: "string" },
            fixApplied: { type: "string", description: "What fix was applied." },
            verificationResult: { type: "string", description: "How closure was verified." },
            preventiveRule: { type: "string", description: "Optional preventive follow-up rule." },
          },
          required: ["id", "fixApplied", "verificationResult"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.continuity_incident_list",
        description: "List continuity incidents, optionally filtered by state.",
        inputSchema: {
          type: "object",
          properties: {
            state: { type: "string", enum: ["open", "closed", "all"] },
            namespace: { type: "string" },
            limit: { type: "number", description: "Max incidents (default 25, max 200)." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.continuity_loop_add_or_update",
        description: "Add or update a continuity improvement loop entry.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable loop identifier." },
            cadence: { type: "string", enum: ["daily", "weekly", "monthly", "quarterly"] },
            purpose: { type: "string", description: "What this recurring loop improves." },
            status: { type: "string", enum: ["active", "paused", "retired"] },
            killCondition: { type: "string", description: "Clear condition for retiring this loop." },
            namespace: { type: "string" },
            lastReviewed: { type: "string", description: "ISO timestamp for last review." },
            notes: { type: "string" },
          },
          required: ["id", "cadence", "purpose", "status", "killCondition"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.continuity_loop_review",
        description: "Update review metadata for an existing continuity improvement loop.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Loop ID to review." },
            namespace: { type: "string" },
            status: { type: "string", enum: ["active", "paused", "retired"] },
            notes: { type: "string" },
            reviewedAt: { type: "string", description: "ISO timestamp for review event." },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.identity_anchor_get",
        description: "Read the identity continuity anchor document (recovery-safe identity context).",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.identity_anchor_update",
        description: "Conservatively merge identity anchor sections without overwriting existing material.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            identityTraits: { type: "string", description: "Updates for 'Identity Traits' section." },
            communicationPreferences: { type: "string", description: "Updates for 'Communication Preferences' section." },
            operatingPrinciples: { type: "string", description: "Updates for 'Operating Principles' section." },
            continuityNotes: { type: "string", description: "Updates for 'Continuity Notes' section." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_identity",
        description: "Read the agent's identity reflections from the workspace IDENTITY.md file.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      // ── Work Layer tools ─────────────────────────────────────────────────
      {
        name: "engram.work_task",
        description: "Manage work-layer tasks (create, get, list, update, transition, delete). Excluded from memory extraction.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "get", "list", "update", "transition", "delete"] },
            id: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["todo", "in_progress", "blocked", "done", "cancelled"] },
            priority: { type: "string", enum: ["low", "medium", "high"] },
            owner: { type: "string" },
            assignee: { type: "string" },
            projectId: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            dueAt: { type: "string" },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.work_project",
        description: "Manage work-layer projects (create, get, list, update, delete, link_task). Excluded from memory extraction.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "get", "list", "update", "delete", "link_task"] },
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["active", "on_hold", "completed", "archived"] },
            owner: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            taskId: { type: "string", description: "Task ID for link_task." },
            projectId: { type: "string", description: "Project ID for link_task." },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.work_board",
        description: "Export/import work-layer board snapshots and markdown.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["export_markdown", "export_snapshot", "import_snapshot"] },
            projectId: { type: "string" },
            snapshotJson: { type: "string", description: "Snapshot JSON for import_snapshot." },
            linkToMemory: { type: "boolean", description: "If true, output can be retained as long-term memory." },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      // ── Shared Context / Compounding tools ────────────────────────────
      {
        name: "engram.shared_context_write_output",
        description: "Write agent work product into shared-context directory for cross-agent coordination.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Agent ID producing this output." },
            title: { type: "string", description: "Short title for the output." },
            content: { type: "string", description: "Markdown content to write." },
          },
          required: ["agentId", "title", "content"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.shared_feedback_record",
        description: "Append approval/rejection decision into shared-context feedback inbox for compounding learning.",
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string", description: "Agent name that produced the output." },
            decision: { type: "string", enum: ["approved", "approved_with_feedback", "rejected"] },
            reason: { type: "string" },
            date: { type: "string", description: "ISO timestamp. Defaults to now." },
            learning: { type: "string" },
            outcome: { type: "string" },
            severity: { type: "string", enum: ["low", "medium", "high"] },
            confidence: { type: "number", description: "Confidence 0-1." },
            workflow: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            evidenceWindowStart: { type: "string" },
            evidenceWindowEnd: { type: "string" },
            refs: { type: "array", items: { type: "string" } },
          },
          required: ["agent", "decision", "reason"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.shared_priorities_append",
        description: "Append priorities text into shared-context inbox for curator merge.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            text: { type: "string", description: "Priority notes (markdown)." },
          },
          required: ["agentId", "text"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.shared_context_cross_signals_run",
        description: "Generate cross-signal markdown + JSON artifacts from agent outputs and feedback.",
        inputSchema: {
          type: "object",
          properties: {
            date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.shared_context_curate_daily",
        description: "Generate daily roundtable summary (deterministic baseline aggregation).",
        inputSchema: {
          type: "object",
          properties: {
            date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.compounding_weekly_synthesize",
        description: "Generate weekly compounding outputs: reports, mistake registry, rubrics, and promotion candidates.",
        inputSchema: {
          type: "object",
          properties: {
            weekId: { type: "string", description: "ISO week ID (YYYY-Www). Defaults to current week." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.compounding_promote_candidate",
        description: "Promote a compounding candidate from weekly report into durable rule/principle memory.",
        inputSchema: {
          type: "object",
          properties: {
            weekId: { type: "string" },
            candidateId: { type: "string" },
            dryRun: { type: "boolean", description: "Preview without writing." },
          },
          required: ["weekId", "candidateId"],
          additionalProperties: false,
        },
      },
      // ── Compression Guidelines tools ────────────────────────────────────
      {
        name: "engram.compression_guidelines_optimize",
        description: "Run compression guideline optimizer, optionally persisting new guidelines.",
        inputSchema: {
          type: "object",
          properties: {
            dryRun: { type: "boolean" },
            eventLimit: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.compression_guidelines_activate",
        description: "Promote staged compression guideline draft to active (after review).",
        inputSchema: {
          type: "object",
          properties: {
            expectedContentHash: { type: "string" },
            expectedGuidelineVersion: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      // ── Memory search & debug tools ────────────────────────────────────
      {
        name: "engram.memory_search",
        description: "Direct semantic search over memory files using the QMD index. Returns matching memories with relevance scores.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            namespace: { type: "string" },
            maxResults: { type: "number" },
            collection: { type: "string", description: "QMD collection (omit for memory, 'global' for all)" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_profile",
        description: "Read the user's behavioral profile — a living document of their preferences, habits, and personality.",
        inputSchema: {
          type: "object",
          properties: { namespace: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_entities_list",
        description: "List all tracked entities (people, projects, tools, companies).",
        inputSchema: {
          type: "object",
          properties: { namespace: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_questions",
        description: "List open questions the system is curious about from past conversations.",
        inputSchema: {
          type: "object",
          properties: { namespace: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_last_recall",
        description: "Return the last recall snapshot for a session (debug introspection).",
        inputSchema: {
          type: "object",
          properties: { sessionKey: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_intent_debug",
        description: "Return the last intent classification debug snapshot.",
        inputSchema: {
          type: "object",
          properties: { namespace: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_qmd_debug",
        description: "Return QMD search index debug information from the last recall.",
        inputSchema: {
          type: "object",
          properties: { namespace: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_graph_explain",
        description: "Explain the last entity graph recall — which entities were activated and why.",
        inputSchema: {
          type: "object",
          properties: { namespace: { type: "string" } },
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_feedback",
        description: "Record relevance feedback (thumbs up/down) for a specific memory.",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" },
            vote: { type: "string", enum: ["up", "down"] },
            note: { type: "string" },
          },
          required: ["memoryId", "vote"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.memory_promote",
        description: "Promote a memory's lifecycle state (e.g. from draft to active).",
        inputSchema: {
          type: "object",
          properties: {
            memoryId: { type: "string" },
            namespace: { type: "string" },
            sessionKey: { type: "string" },
          },
          required: ["memoryId"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.context_checkpoint",
        description: "Save a structured context checkpoint for a session (preserves conversation state to disk).",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: { type: "string" },
            context: { type: "string", description: "Context content to checkpoint" },
            namespace: { type: "string" },
          },
          required: ["sessionKey", "context"],
          additionalProperties: false,
        },
      },
      // ── Daily Context Briefing (#370) ───────────────────────────────────
      // Uses the legacy "engram.*" prefix like every other tool in this array;
      // withToolAliases (applied via .flatMap below) generates the canonical
      // "remnic.briefing" alias automatically.
      ...(service.briefingEnabled ? [{
        name: "engram.briefing",
        description: "Generate a daily context briefing by cross-referencing active entities, recent facts, open commitments, and optional calendar events.",
        inputSchema: {
          type: "object",
          properties: {
            since: { type: "string", description: "Lookback window (e.g. 'yesterday', '3d', '1w', '24h')." },
            focus: { type: "string", description: "Optional focus filter (e.g. 'person:Jane Doe', 'project:remnic-core', 'topic:retrieval')." },
            namespace: { type: "string" },
            format: { type: "string", enum: ["markdown", "json"] },
            maxFollowups: { type: "number", description: "Maximum LLM-suggested follow-ups (0 disables that section)." },
          },
          additionalProperties: false,
        },
      }] : []),
      // ── Contradiction Review (issue #520) ────────────────────────────────
      {
        name: "engram.review_list",
        description: "List contradiction review items pending user resolution.",
        inputSchema: {
          type: "object",
          properties: {
            filter: { type: "string", enum: ["all", "unresolved", "contradicts", "independent", "duplicates", "needs-user"], description: "Filter by verdict type. Default: unresolved." },
            namespace: { type: "string" },
            limit: { type: "number", description: "Max items to return (default 50)." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "engram.review_resolve",
        description: "Resolve a contradiction pair with a chosen verb.",
        inputSchema: {
          type: "object",
          properties: {
            pairId: { type: "string", description: "The contradiction pair ID to resolve." },
            verb: { type: "string", enum: ["keep-a", "keep-b", "merge", "both-valid", "needs-more-context"], description: "Resolution action." },
          },
          required: ["pairId", "verb"],
          additionalProperties: false,
        },
      },
      {
        name: "engram.contradiction_scan_run",
        description: "Run an on-demand contradiction scan over the memory corpus.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    ].flatMap((tool) => withToolAliases(tool));
  }

  /** Get clientInfo for a specific MCP session. Returns undefined for non-MCP requests. */
  getClientInfo(sessionId?: string): { name: string; version?: string } | undefined {
    if (sessionId) {
      return this.clientInfoBySession.get(sessionId);
    }
    return undefined;
  }

  /** Pop the session ID generated during an initialize handshake, keyed by correlation ID. */
  popInitSessionId(correlationId: string): string | undefined {
    const sid = this.initSessionIds.get(correlationId);
    if (sid !== undefined) this.initSessionIds.delete(correlationId);
    return sid;
  }

  async handleRequest(request: JsonRpcRequest, options?: { principalOverride?: string; sessionId?: string; correlationId?: string }): Promise<Record<string, unknown> | null> {
    const id = request.id ?? null;
    const method = request.method ?? "";

    if (method === "notifications/initialized") return null;
    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (method === "initialize") {
      const params = request.params ?? {};
      const rawClientInfo = params.clientInfo as { name?: string; version?: string } | undefined;
      // Generate a server-side session ID for this MCP session.
      // The caller should send this back as Mcp-Session-Id on subsequent requests.
      const newSessionId = randomUUID();
      if (rawClientInfo && typeof rawClientInfo.name === "string") {
        const info = { name: rawClientInfo.name, version: rawClientInfo.version as string | undefined };
        this.clientInfoBySession.set(newSessionId, info);
        // Evict oldest sessions if map exceeds limit
        if (this.clientInfoBySession.size > 1000) {
          const firstKey = this.clientInfoBySession.keys().next().value;
          if (firstKey) this.clientInfoBySession.delete(firstKey);
        }
      }
      const version = await getMcpServerVersion();
      // Store session ID keyed by correlation ID (unique per HTTP request) so
      // concurrent initializes with the same JSON-RPC id don't collide.
      const corrId = options?.correlationId;
      if (corrId) this.initSessionIds.set(corrId, newSessionId);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "remnic",
            version,
          },
        },
      };
    }
    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: this.tools,
        },
      };
    }
    if (method === "tools/call") {
      const params = request.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      const argumentsObject =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};

      try {
        const effectivePrincipal = options?.principalOverride ?? this.authenticatedPrincipal;
        const result = await this.callTool(name, argumentsObject, effectivePrincipal, options?.sessionId);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
            isError: false,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: message }],
            isError: true,
          },
        };
      }
    }

    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    };
  }

  async runStdio(input: Readable, output: Writable): Promise<void> {
    input.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      this.scheduleFlush(output);
    });
    await new Promise<void>((resolve, reject) => {
      input.on("end", resolve);
      input.on("error", reject);
    });
    while (this.flushTask) {
      await this.flushTask;
    }
  }

  private scheduleFlush(output: Writable): void {
    if (this.flushTask) return;
    const task = this.flushBuffer(output)
      .catch((err) => {
        this.writeMessage(output, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      })
      .finally(() => {
        if (this.flushTask === task) {
          this.flushTask = null;
        }
        if (this.buffer.length > 0) {
          this.scheduleFlush(output);
        }
      });
    this.flushTask = task;
  }

  private async flushBuffer(output: Writable): Promise<void> {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headerText = this.buffer.slice(0, headerEnd).toString("utf-8");
      const headers = headerText.split("\r\n");
      const contentLengthHeader = headers.find((line) => line.toLowerCase().startsWith("content-length:"));
      if (!contentLengthHeader) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const contentLength = parseInt(contentLengthHeader.split(":")[1]?.trim() ?? "0", 10);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) return;
      const body = this.buffer.slice(messageStart, messageEnd).toString("utf-8");
      this.buffer = this.buffer.slice(messageEnd);

      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(body) as JsonRpcRequest;
      } catch {
        this.writeMessage(output, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Parse error",
          },
        });
        continue;
      }
      const response = await this.handleRequest(parsed);
      if (response) {
        this.writeMessage(output, response);
      }
    }
  }

  private writeMessage(output: Writable, payload: Record<string, unknown>): void {
    const body = JSON.stringify(payload);
    const message = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
    output.write(message);
  }

  /**
   * Determine whether oai-mem-citation guidance should be appended to recall.
   * Returns true when explicitly enabled via config OR when auto-detect is
   * active and the current MCP session belongs to a Codex adapter client.
   *
   * When no sessionId is provided (e.g., stdio transport where there are no
   * HTTP headers carrying mcp-session-id), fall back to checking if there is
   * exactly one known session whose clientInfo matches the Codex pattern.
   * This covers the common stdio case where a single client connection exists.
   */
  private shouldEmitCitations(mcpSessionId?: string): boolean {
    if (this.citationsEnabled) return true;
    if (!this.citationsAutoDetect) return false;

    // Direct session lookup (HTTP transport with mcp-session-id header).
    if (mcpSessionId) {
      const info = this.clientInfoBySession.get(mcpSessionId);
      if (!info) return false;
      return this.isCodexClient(info);
    }

    // Stdio fallback: no session ID available. If there is exactly one session
    // registered (the typical stdio pattern), check that session's clientInfo.
    if (this.clientInfoBySession.size === 1) {
      const [info] = [...this.clientInfoBySession.values()];
      if (info) return this.isCodexClient(info);
    }

    return false;
  }

  /** Check whether a clientInfo record identifies a Codex adapter client. */
  private isCodexClient(info: { name: string; version?: string }): boolean {
    const lowerName = info.name.toLowerCase();
    return lowerName === "codex-mcp-client" || lowerName.includes("codex");
  }

  /**
   * Build citation metadata for each recall result that has a path.
   * Line range defaults to 1-1 when not determinable from the summary.
   */
  private buildRecallCitations(response: EngramAccessRecallResponse): CitationMetadata[] {
    return response.results
      .filter((r) => r.path && r.path.length > 0)
      .map((r) => ({
        memoryId: r.id,
        path: r.path,
        lineStart: 1,
        lineEnd: 1,
        noteDefault: r.preview?.slice(0, 60) || r.id,
      }));
  }

  private async callTool(name: string, args: Record<string, unknown>, effectivePrincipal?: string, mcpSessionId?: string): Promise<unknown> {
    switch (toLegacyToolName(name)) {
      case "engram.recall": {
        const response = await this.service.recall({
          query: typeof args.query === "string" ? args.query : "",
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          topK: typeof args.topK === "number" && Number.isFinite(args.topK) ? args.topK : undefined,
          mode: typeof args.mode === "string" ? args.mode as RecallPlanMode | "auto" : undefined,
          includeDebug: args.includeDebug === true,
        });

        if (this.shouldEmitCitations(mcpSessionId)) {
          const citations = this.buildRecallCitations(response);
          const guidance = buildCitationGuidance(citations);
          if (guidance.length > 0) {
            return {
              ...response,
              context: response.context + guidance,
              citations,
            };
          }
        }
        return response;
      }
      case "engram.recall_explain":
        return this.service.recallExplain({
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
        });
      case "engram.recall_tier_explain":
        return this.service.recallTierExplain(
          typeof args.sessionKey === "string" && args.sessionKey.length > 0
            ? args.sessionKey
            : undefined,
          typeof args.namespace === "string" && args.namespace.length > 0
            ? args.namespace
            : undefined,
          effectivePrincipal,
        );
      case "engram.day_summary":
        return this.service.daySummary({
          memories: typeof args.memories === "string" ? args.memories : "",
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
        });
      case "engram.memory_governance_run":
        return this.service.governanceRun({
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          mode: args.mode === "apply" ? "apply" : "shadow",
          recentDays: typeof args.recentDays === "number" && Number.isFinite(args.recentDays) ? args.recentDays : undefined,
          maxMemories: typeof args.maxMemories === "number" && Number.isFinite(args.maxMemories) ? args.maxMemories : undefined,
          batchSize: typeof args.batchSize === "number" && Number.isFinite(args.batchSize) ? args.batchSize : undefined,
          authenticatedPrincipal: effectivePrincipal,
        }, effectivePrincipal);
      case "engram.procedure_mining_run":
        return this.service.procedureMiningRun(
          {
            namespace: typeof args.namespace === "string" ? args.namespace : undefined,
            authenticatedPrincipal: effectivePrincipal,
          },
          effectivePrincipal,
        );
      case "remnic.procedural_stats":
      case "engram.procedural_stats":
        return this.service.procedureStats(
          {
            namespace:
              typeof args.namespace === "string" ? args.namespace : undefined,
          },
          effectivePrincipal,
        );
      case "engram.memory_get":
        return this.service.memoryGet(
          typeof args.memoryId === "string" ? args.memoryId : "",
          typeof args.namespace === "string" ? args.namespace : undefined,
          effectivePrincipal,
        );
      case "engram.memory_timeline": {
        const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 200;
        return this.service.memoryTimeline(
          typeof args.memoryId === "string" ? args.memoryId : "",
          typeof args.namespace === "string" ? args.namespace : undefined,
          limit,
          effectivePrincipal,
        );
      }
      case "engram.memory_store":
        return this.service.memoryStore({
          schemaVersion: typeof args.schemaVersion === "number" ? args.schemaVersion : undefined,
          idempotencyKey: typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined,
          dryRun: args.dryRun === true,
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          authenticatedPrincipal: effectivePrincipal,
          content: typeof args.content === "string" ? args.content : "",
          category: typeof args.category === "string" ? args.category : undefined,
          confidence: typeof args.confidence === "number" ? args.confidence : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          tags: Array.isArray(args.tags) ? args.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
          entityRef: typeof args.entityRef === "string" ? args.entityRef : undefined,
          ttl: typeof args.ttl === "string" ? args.ttl : undefined,
          sourceReason: typeof args.sourceReason === "string" ? args.sourceReason : undefined,
        });
      case "engram.suggestion_submit":
        return this.service.suggestionSubmit({
          schemaVersion: typeof args.schemaVersion === "number" ? args.schemaVersion : undefined,
          idempotencyKey: typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined,
          dryRun: args.dryRun === true,
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          authenticatedPrincipal: effectivePrincipal,
          content: typeof args.content === "string" ? args.content : "",
          category: typeof args.category === "string" ? args.category : undefined,
          confidence: typeof args.confidence === "number" ? args.confidence : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          tags: Array.isArray(args.tags) ? args.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
          entityRef: typeof args.entityRef === "string" ? args.entityRef : undefined,
          ttl: typeof args.ttl === "string" ? args.ttl : undefined,
          sourceReason: typeof args.sourceReason === "string" ? args.sourceReason : undefined,
        });
      case "engram.entity_get":
        return this.service.entityGet(
          typeof args.name === "string" ? args.name : "",
          typeof args.namespace === "string" ? args.namespace : undefined,
        );
      case "engram.review_queue_list":
        return this.service.reviewQueue(
          typeof args.runId === "string" ? args.runId : undefined,
          typeof args.namespace === "string" ? args.namespace : undefined,
          effectivePrincipal,
        );
      case "engram.observe":
        return this.service.observe({
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : "",
          messages: Array.isArray(args.messages) ? args.messages : [],
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          authenticatedPrincipal: effectivePrincipal,
          skipExtraction: args.skipExtraction === true,
        });
      case "engram.lcm_search":
        return this.service.lcmSearch({
          query: typeof args.query === "string" ? args.query : "",
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          limit: typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : undefined,
          authenticatedPrincipal: effectivePrincipal,
        });
      // ── Continuity / Identity tools ───────────────────────────────────
      case "engram.continuity_audit_generate":
        return this.service.continuityAuditGenerate({
          period: args.period === "monthly" ? "monthly" : args.period === "weekly" ? "weekly" : undefined,
          key: typeof args.key === "string" ? args.key : undefined,
        });
      case "engram.continuity_incident_open":
        return this.service.continuityIncidentOpen({
          symptom: typeof args.symptom === "string" ? args.symptom : "",
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
          triggerWindow: typeof args.triggerWindow === "string" ? args.triggerWindow : undefined,
          suspectedCause: typeof args.suspectedCause === "string" ? args.suspectedCause : undefined,
        });
      case "engram.continuity_incident_close":
        return this.service.continuityIncidentClose({
          id: typeof args.id === "string" ? args.id : "",
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
          fixApplied: typeof args.fixApplied === "string" ? args.fixApplied : "",
          verificationResult: typeof args.verificationResult === "string" ? args.verificationResult : "",
          preventiveRule: typeof args.preventiveRule === "string" ? args.preventiveRule : undefined,
        });
      case "engram.continuity_incident_list":
        return this.service.continuityIncidentList({
          state: args.state === "closed" ? "closed" : args.state === "all" ? "all" : args.state === "open" ? "open" : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        });
      case "engram.continuity_loop_add_or_update":
        return this.service.continuityLoopAddOrUpdate({
          id: typeof args.id === "string" ? args.id : "",
          cadence: (args.cadence as "daily" | "weekly" | "monthly" | "quarterly") ?? "weekly",
          purpose: typeof args.purpose === "string" ? args.purpose : "",
          status: (args.status as "active" | "paused" | "retired") ?? "active",
          killCondition: typeof args.killCondition === "string" ? args.killCondition : "",
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
          lastReviewed: typeof args.lastReviewed === "string" ? args.lastReviewed : undefined,
          notes: typeof args.notes === "string" ? args.notes : undefined,
        });
      case "engram.continuity_loop_review":
        return this.service.continuityLoopReview({
          id: typeof args.id === "string" ? args.id : "",
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
          status: args.status === "active" || args.status === "paused" || args.status === "retired" ? args.status : undefined,
          notes: typeof args.notes === "string" ? args.notes : undefined,
          reviewedAt: typeof args.reviewedAt === "string" ? args.reviewedAt : undefined,
        });
      case "engram.identity_anchor_get":
        return this.service.identityAnchorGet({
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
        });
      case "engram.identity_anchor_update":
        return this.service.identityAnchorUpdate({
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
          identityTraits: typeof args.identityTraits === "string" ? args.identityTraits : undefined,
          communicationPreferences: typeof args.communicationPreferences === "string" ? args.communicationPreferences : undefined,
          operatingPrinciples: typeof args.operatingPrinciples === "string" ? args.operatingPrinciples : undefined,
          continuityNotes: typeof args.continuityNotes === "string" ? args.continuityNotes : undefined,
        });
      case "engram.memory_identity":
        return this.service.memoryIdentity({
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
        });
      // ── Work Layer tools ──────────────────────────────────────────────
      case "engram.work_task":
        return this.service.workTask({
          action: (args.action as any) ?? "list",
          id: typeof args.id === "string" ? args.id : undefined,
          title: typeof args.title === "string" ? args.title : undefined,
          description: typeof args.description === "string" ? args.description : undefined,
          status: typeof args.status === "string" ? args.status : undefined,
          priority: typeof args.priority === "string" ? args.priority : undefined,
          owner: typeof args.owner === "string" ? args.owner : undefined,
          assignee: typeof args.assignee === "string" ? args.assignee : undefined,
          projectId: typeof args.projectId === "string" ? args.projectId : undefined,
          tags: Array.isArray(args.tags) ? args.tags.filter((x: unknown): x is string => typeof x === "string") : undefined,
          dueAt: typeof args.dueAt === "string" ? args.dueAt : undefined,
        });
      case "engram.work_project":
        return this.service.workProject({
          action: (args.action as any) ?? "list",
          id: typeof args.id === "string" ? args.id : undefined,
          name: typeof args.name === "string" ? args.name : undefined,
          description: typeof args.description === "string" ? args.description : undefined,
          status: typeof args.status === "string" ? args.status : undefined,
          owner: typeof args.owner === "string" ? args.owner : undefined,
          tags: Array.isArray(args.tags) ? args.tags.filter((x: unknown): x is string => typeof x === "string") : undefined,
          taskId: typeof args.taskId === "string" ? args.taskId : undefined,
          projectId: typeof args.projectId === "string" ? args.projectId : undefined,
        });
      case "engram.work_board":
        return this.service.workBoard({
          action: (args.action as any) ?? "export_markdown",
          projectId: typeof args.projectId === "string" ? args.projectId : undefined,
          snapshotJson: typeof args.snapshotJson === "string" ? args.snapshotJson : undefined,
          linkToMemory: args.linkToMemory === true,
        });
      // ── Shared Context / Compounding tools ─────────────────────────
      case "engram.shared_context_write_output":
        return this.service.sharedContextWriteOutput({
          agentId: typeof args.agentId === "string" ? args.agentId : "",
          title: typeof args.title === "string" ? args.title : "",
          content: typeof args.content === "string" ? args.content : "",
        });
      case "engram.shared_feedback_record":
        return this.service.sharedFeedbackRecord({
          agent: typeof args.agent === "string" ? args.agent : "",
          decision: (args.decision as any) ?? "approved",
          reason: typeof args.reason === "string" ? args.reason : "",
          date: typeof args.date === "string" ? args.date : undefined,
          learning: typeof args.learning === "string" ? args.learning : undefined,
          outcome: typeof args.outcome === "string" ? args.outcome : undefined,
          severity: args.severity === "low" || args.severity === "medium" || args.severity === "high" ? args.severity : undefined,
          confidence: typeof args.confidence === "number" ? args.confidence : undefined,
          workflow: typeof args.workflow === "string" ? args.workflow : undefined,
          tags: Array.isArray(args.tags) ? args.tags.filter((x: unknown): x is string => typeof x === "string") : undefined,
          evidenceWindowStart: typeof args.evidenceWindowStart === "string" ? args.evidenceWindowStart : undefined,
          evidenceWindowEnd: typeof args.evidenceWindowEnd === "string" ? args.evidenceWindowEnd : undefined,
          refs: Array.isArray(args.refs) ? args.refs.filter((x: unknown): x is string => typeof x === "string") : undefined,
        });
      case "engram.shared_priorities_append":
        return this.service.sharedPrioritiesAppend({
          agentId: typeof args.agentId === "string" ? args.agentId : "",
          text: typeof args.text === "string" ? args.text : "",
        });
      case "engram.shared_context_cross_signals_run":
        return this.service.sharedContextCrossSignalsRun({
          date: typeof args.date === "string" ? args.date : undefined,
        });
      case "engram.shared_context_curate_daily":
        return this.service.sharedContextCurateDaily({
          date: typeof args.date === "string" ? args.date : undefined,
        });
      case "engram.compounding_weekly_synthesize":
        return this.service.compoundingWeeklySynthesize({
          weekId: typeof args.weekId === "string" ? args.weekId : undefined,
        });
      case "engram.compounding_promote_candidate":
        return this.service.compoundingPromoteCandidate({
          weekId: typeof args.weekId === "string" ? args.weekId : "",
          candidateId: typeof args.candidateId === "string" ? args.candidateId : "",
          dryRun: args.dryRun === true,
        });
      // ── Compression Guidelines tools ───────────────────────────────────
      case "engram.compression_guidelines_optimize":
        return this.service.compressionGuidelinesOptimize({
          dryRun: args.dryRun === true,
          eventLimit: typeof args.eventLimit === "number" ? args.eventLimit : undefined,
        });
      case "engram.compression_guidelines_activate":
        return this.service.compressionGuidelinesActivate({
          expectedContentHash: typeof args.expectedContentHash === "string" ? args.expectedContentHash : undefined,
          expectedGuidelineVersion: typeof args.expectedGuidelineVersion === "number" ? args.expectedGuidelineVersion : undefined,
        });
      // ── Memory search & debug tools ──────────────────────────────────
      case "engram.memory_search":
        return this.service.memorySearch({
          query: typeof args.query === "string" ? args.query : "",
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          maxResults: typeof args.maxResults === "number" && Number.isFinite(args.maxResults) ? args.maxResults : undefined,
          collection: typeof args.collection === "string" ? args.collection : undefined,
          principal: effectivePrincipal,
        });
      case "engram.memory_profile":
        return this.service.memoryProfile(
          typeof args.namespace === "string" ? args.namespace : undefined,
          effectivePrincipal,
        );
      case "engram.memory_entities_list":
        return this.service.memoryEntitiesList(
          typeof args.namespace === "string" ? args.namespace : undefined,
          effectivePrincipal,
        );
      case "engram.memory_questions":
        return this.service.memoryQuestions(
          typeof args.namespace === "string" ? args.namespace : undefined,
          effectivePrincipal,
        );
      case "engram.memory_last_recall":
        return this.service.lastRecallSnapshot(
          typeof args.sessionKey === "string" ? args.sessionKey : undefined,
        );
      case "engram.memory_intent_debug":
        return this.service.intentDebug(
          typeof args.namespace === "string" ? args.namespace : undefined,
        );
      case "engram.memory_qmd_debug":
        return this.service.qmdDebug(
          typeof args.namespace === "string" ? args.namespace : undefined,
        );
      case "engram.memory_graph_explain":
        return this.service.graphExplainLastRecall(
          typeof args.namespace === "string" ? args.namespace : undefined,
        );
      case "engram.memory_feedback":
        return this.service.memoryFeedback({
          memoryId: typeof args.memoryId === "string" ? args.memoryId : "",
          vote: args.vote === "down" ? "down" : "up",
          note: typeof args.note === "string" ? args.note : undefined,
        });
      case "engram.memory_promote":
        return this.service.memoryPromote({
          memoryId: typeof args.memoryId === "string" ? args.memoryId : "",
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : undefined,
        });
      case "engram.context_checkpoint":
        return this.service.contextCheckpoint({
          sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : "",
          context: typeof args.context === "string" ? args.context : "",
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          principal: effectivePrincipal,
        });
      // ── Daily Context Briefing (#370) ───────────────────────────────────
      case "engram.briefing": {
        // Validate the format value upfront — unsupported values (e.g. "xml")
        // must be rejected with a descriptive error rather than silently
        // falling back to the default format.
        const rawFormat = typeof args.format === "string" ? args.format : undefined;
        const formatErr = validateBriefingFormat(rawFormat);
        if (formatErr) throw new Error(formatErr);
        return this.service.briefing({
          since: typeof args.since === "string" ? args.since : undefined,
          focus: typeof args.focus === "string" ? args.focus : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          format: rawFormat as "json" | "markdown" | undefined,
          maxFollowups:
            typeof args.maxFollowups === "number" ? args.maxFollowups : undefined,
          principal: effectivePrincipal,
        });
      }
      // ── Contradiction Review (issue #520) ──────────────────────────────────
      case "engram.review_list":
      case "remnic.review_list": {
        const { listPairs } = await import("./contradiction/contradiction-review.js");
        const VALID_REVIEW_FILTERS = new Set(["all", "unresolved", "contradicts", "independent", "duplicates", "needs-user"]);
        const rawFilter = typeof args.filter === "string" ? args.filter : "unresolved";
        if (!VALID_REVIEW_FILTERS.has(rawFilter)) {
          throw new Error(`Invalid filter '${rawFilter}'. Valid: ${[...VALID_REVIEW_FILTERS].join(", ")}`);
        }
        const filter = rawFilter as "all" | "unresolved" | "contradicts" | "independent" | "duplicates" | "needs-user";
        const ns = typeof args.namespace === "string" ? args.namespace : undefined;
        const limit = typeof args.limit === "number" ? args.limit : 50;
        return listPairs(this.service.memoryDir, { filter, namespace: ns, limit });
      }
      case "engram.review_resolve":
      case "remnic.review_resolve": {
        const pairId = typeof args.pairId === "string" ? args.pairId : "";
        const verb = typeof args.verb === "string" ? args.verb : "";
        if (!pairId) throw new Error("pairId is required");
        if (!verb) throw new Error("verb is required");
        const { isValidResolutionVerb } = await import("./contradiction/resolution.js");
        if (!isValidResolutionVerb(verb)) throw new Error(`Invalid verb: ${verb}. Must be one of: keep-a, keep-b, merge, both-valid, needs-more-context`);
        const { executeResolution } = await import("./contradiction/resolution.js");
        return executeResolution(this.service.memoryDir, this.service.storageRef, pairId, verb);
      }
      case "engram.contradiction_scan_run":
      case "remnic.contradiction_scan_run": {
        const { runContradictionScan } = await import("./contradiction/contradiction-scan.js");
        return runContradictionScan({
          storage: this.service.storageRef,
          config: this.service.configRef,
          memoryDir: this.service.memoryDir,
          embeddingLookupFactory: this.service.embeddingLookupFactoryRef,
          localLlm: this.service.localLlmRef,
          fallbackLlm: this.service.fallbackLlmRef,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
        });
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
}
