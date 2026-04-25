// Request/response schema validation for the Remnic HTTP API.
// Uses zod for runtime validation — returns structured 400 errors with
// field-level detail so consumers get clear feedback on malformed requests.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

export interface SchemaValidationError {
  error: string;
  code: "validation_error";
  details: Array<{ field: string; message: string }>;
}

export function formatZodError(error: z.ZodError): SchemaValidationError {
  return {
    error: "request validation failed",
    code: "validation_error",
    details: error.issues.map((issue) => ({
      field: issue.path.join(".") || "(root)",
      message: issue.message,
    })),
  };
}

// ---------------------------------------------------------------------------
// Shared fields
// ---------------------------------------------------------------------------

const namespaceSchema = z.string().trim().max(256).optional();
const sessionKeySchema = z.string().trim().min(1).max(512).optional();
const idempotencyKeySchema = z.string().trim().min(1).max(256).optional();
const dryRunSchema = z.boolean().optional();
const schemaVersionSchema = z.number().int().optional();

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

/**
 * Coding-agent context (issue #569). Optional payload that connectors may
 * ship with a recall request so the project/branch namespace overlay
 * applies to that recall. All fields are validated per CLAUDE.md #51 —
 * empty-string projectId / rootPath is rejected, not silently accepted.
 */
export const codingContextSchema = z
  .object({
    projectId: z.string().trim().min(1, "codingContext.projectId is required").max(128),
    branch: z.string().trim().max(256).nullable(),
    rootPath: z.string().trim().min(1, "codingContext.rootPath is required").max(1024),
    defaultBranch: z.string().trim().max(256).nullable(),
  })
  .nullable();

/**
 * Recall disclosure depth (issue #677).  Mirrors the `RecallDisclosure`
 * type in `types.ts` — keep these in sync.  Default-application happens
 * inside `EngramAccessService.recall()`; the schema only accepts/rejects.
 * Invalid values throw a structured 400 instead of silently defaulting,
 * per CLAUDE.md rule 51.
 */
export const recallDisclosureSchema = z.enum(["chunk", "section", "raw"]);

export const recallRequestSchema = z.object({
  query: z.string().min(1, "query is required"),
  sessionKey: sessionKeySchema,
  namespace: namespaceSchema,
  topK: z.number().int().min(0).max(200).optional(),
  mode: z.enum(["auto", "no_recall", "minimal", "full", "graph_mode"]).optional(),
  includeDebug: z.boolean().optional(),
  disclosure: recallDisclosureSchema.optional(),
  codingContext: codingContextSchema.optional(),
});

export const recallExplainRequestSchema = z.object({
  sessionKey: sessionKeySchema,
  namespace: namespaceSchema,
});

/**
 * Standalone "set coding context" request. Used by the HTTP endpoint
 * `POST /engram/v1/coding-context` and the MCP `remnic.set_coding_context`
 * tool (PR 7). `codingContext: null` clears the attached context.
 */
export const setCodingContextRequestSchema = z.object({
  sessionKey: z.string().trim().min(1, "sessionKey is required").max(512),
  codingContext: codingContextSchema,
});

// ---------------------------------------------------------------------------
// Observe
// ---------------------------------------------------------------------------

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1, "message content must be non-empty"),
});

export const observeRequestSchema = z.object({
  sessionKey: z.string().trim().min(1, "sessionKey is required").max(512),
  messages: z.array(messageSchema).min(1, "messages must be a non-empty array"),
  namespace: namespaceSchema,
  skipExtraction: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Memory store / suggestion submit
// ---------------------------------------------------------------------------

const writeContentSchema = z.string().min(1, "content is required").max(50000);
const categorySchema = z
  .enum([
    "fact", "preference", "correction", "entity", "decision",
    "relationship", "principle", "commitment", "moment", "skill", "rule", "procedure",
    "reasoning_trace",
  ])
  .optional();
const confidenceSchema = z.number().min(0).max(1).optional();
const tagsSchema = z.array(z.string().max(256)).max(50).optional();
const entityRefSchema = z.string().trim().max(512).optional();
const ttlSchema = z.string().trim().max(128).optional();
const sourceReasonSchema = z.string().trim().max(2000).optional();

export const memoryStoreRequestSchema = z.object({
  schemaVersion: schemaVersionSchema,
  idempotencyKey: idempotencyKeySchema,
  dryRun: dryRunSchema,
  sessionKey: sessionKeySchema,
  content: writeContentSchema,
  category: categorySchema,
  confidence: confidenceSchema,
  namespace: namespaceSchema,
  tags: tagsSchema,
  entityRef: entityRefSchema,
  ttl: ttlSchema,
  sourceReason: sourceReasonSchema,
});

export const suggestionSubmitRequestSchema = memoryStoreRequestSchema;

// ---------------------------------------------------------------------------
// Review disposition
// ---------------------------------------------------------------------------

export const reviewDispositionRequestSchema = z.object({
  memoryId: z.string().trim().min(1, "memoryId is required"),
  status: z.enum([
    "active", "pending_review", "quarantined", "rejected", "superseded", "archived",
  ]),
  reasonCode: z.string().trim().min(1, "reasonCode is required"),
  namespace: namespaceSchema,
});

// ---------------------------------------------------------------------------
// Trust-zone promote
// ---------------------------------------------------------------------------

export const trustZonePromoteRequestSchema = z.object({
  recordId: z.string().trim().min(1, "recordId is required"),
  targetZone: z.enum(["working", "trusted"], {
    errorMap: () => ({ message: "targetZone must be 'working' or 'trusted'" }),
  }),
  promotionReason: z.string().trim().min(1, "promotionReason is required"),
  recordedAt: z.string().trim().optional(),
  summary: z.string().trim().max(5000).optional(),
  dryRun: dryRunSchema,
  namespace: namespaceSchema,
});

// ---------------------------------------------------------------------------
// Trust-zone demo-seed
// ---------------------------------------------------------------------------

export const trustZoneDemoSeedRequestSchema = z.object({
  scenario: z.string().trim().max(256).optional(),
  recordedAt: z.string().trim().optional(),
  dryRun: dryRunSchema,
  namespace: namespaceSchema,
});

// ---------------------------------------------------------------------------
// LCM search
// ---------------------------------------------------------------------------

export const lcmSearchRequestSchema = z.object({
  query: z.string().min(1, "query is required"),
  sessionKey: sessionKeySchema,
  namespace: namespaceSchema,
  limit: z.number().int().min(1).max(100).optional(),
});

// ---------------------------------------------------------------------------
// Day summary
// ---------------------------------------------------------------------------

export const daySummaryRequestSchema = z.object({
  memories: z.string().max(100000).optional(),
  sessionKey: sessionKeySchema,
  namespace: namespaceSchema,
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type RecallRequest = z.infer<typeof recallRequestSchema>;
export type RecallExplainRequest = z.infer<typeof recallExplainRequestSchema>;
export type SetCodingContextRequest = z.infer<typeof setCodingContextRequestSchema>;
export type ObserveRequest = z.infer<typeof observeRequestSchema>;
export type MemoryStoreRequest = z.infer<typeof memoryStoreRequestSchema>;
export type SuggestionSubmitRequest = z.infer<typeof suggestionSubmitRequestSchema>;
export type ReviewDispositionRequest = z.infer<typeof reviewDispositionRequestSchema>;
export type TrustZonePromoteRequest = z.infer<typeof trustZonePromoteRequestSchema>;
export type TrustZoneDemoSeedRequest = z.infer<typeof trustZoneDemoSeedRequestSchema>;
export type LcmSearchRequest = z.infer<typeof lcmSearchRequestSchema>;
export type DaySummaryRequest = z.infer<typeof daySummaryRequestSchema>;

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

export type SchemaName =
  | "recall"
  | "recallExplain"
  | "setCodingContext"
  | "observe"
  | "memoryStore"
  | "suggestionSubmit"
  | "reviewDisposition"
  | "trustZonePromote"
  | "trustZoneDemoSeed"
  | "lcmSearch"
  | "daySummary";

export type SchemaTypeFor<N extends SchemaName> =
  N extends "recall" ? RecallRequest
  : N extends "recallExplain" ? RecallExplainRequest
  : N extends "setCodingContext" ? SetCodingContextRequest
  : N extends "observe" ? ObserveRequest
  : N extends "memoryStore" ? MemoryStoreRequest
  : N extends "suggestionSubmit" ? SuggestionSubmitRequest
  : N extends "reviewDisposition" ? ReviewDispositionRequest
  : N extends "trustZonePromote" ? TrustZonePromoteRequest
  : N extends "trustZoneDemoSeed" ? TrustZoneDemoSeedRequest
  : N extends "lcmSearch" ? LcmSearchRequest
  : N extends "daySummary" ? DaySummaryRequest
  : never;

const schemas: Record<SchemaName, z.ZodTypeAny> = {
  recall: recallRequestSchema,
  recallExplain: recallExplainRequestSchema,
  setCodingContext: setCodingContextRequestSchema,
  observe: observeRequestSchema,
  memoryStore: memoryStoreRequestSchema,
  suggestionSubmit: suggestionSubmitRequestSchema,
  reviewDisposition: reviewDispositionRequestSchema,
  trustZonePromote: trustZonePromoteRequestSchema,
  trustZoneDemoSeed: trustZoneDemoSeedRequestSchema,
  lcmSearch: lcmSearchRequestSchema,
  daySummary: daySummaryRequestSchema,
};

/**
 * Validate a request body against the named schema.
 * Returns `{ success: true, data }` on pass or
 * `{ success: false, error }` on failure with field-level detail.
 */
export function validateRequest<T = unknown>(
  schemaName: SchemaName,
  body: unknown,
): { success: true; data: T } | { success: false; error: SchemaValidationError } {
  const schema = schemas[schemaName];
  if (!schema) {
    return {
      success: false,
      error: {
        error: `unknown schema: ${schemaName}`,
        code: "validation_error",
        details: [],
      },
    };
  }
  const result = schema.safeParse(body);
  if (result.success) {
    return { success: true, data: result.data as T };
  }
  return { success: false, error: formatZodError(result.error) };
}
