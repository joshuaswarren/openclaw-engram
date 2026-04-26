import { z } from "zod";

export const ExportManifestV1Schema = z.object({
  format: z.literal("openclaw-engram-export"),
  schemaVersion: z.literal(1),
  createdAt: z.string(),
  pluginVersion: z.string(),
  includesTranscripts: z.boolean(),
  files: z.array(
    z.object({
      path: z.string(),
      sha256: z.string(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
});

export type ExportManifestV1 = z.infer<typeof ExportManifestV1Schema>;

export const ExportMemoryRecordV1Schema = z.object({
  path: z.string(),
  content: z.string(),
});

export type ExportMemoryRecordV1 = z.infer<typeof ExportMemoryRecordV1Schema>;

export const ExportBundleV1Schema = z.object({
  manifest: ExportManifestV1Schema,
  records: z.array(ExportMemoryRecordV1Schema),
});

export type ExportBundleV1 = z.infer<typeof ExportBundleV1Schema>;

// ---------------------------------------------------------------------------
// V2 capsule manifest (issue #676 PR 1/6)
// ---------------------------------------------------------------------------
//
// The V2 manifest extends V1 with a `capsule` block describing a reusable,
// shareable bundle of memory state ("capsule"). This PR introduces ONLY the
// schema and a backward-compatible reader. Actual export/import pipelines and
// CLI surfaces are deferred to subsequent PRs (2/6 through 6/6).

/**
 * Allowed pattern for a user-chosen capsule id.
 *
 * - lowercase or uppercase alphanumerics and dashes
 * - must start and end with an alphanumeric (no leading/trailing dashes)
 * - no consecutive dashes
 * - 1..64 characters
 *
 * The constraints are intentionally narrow so capsule ids round-trip cleanly
 * through filesystem paths, URLs, and registry slugs without escaping.
 */
export const CAPSULE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?!-))*[A-Za-z0-9]$|^[A-Za-z0-9]$/;

const CapsuleIdSchema = z
  .string()
  .min(1, "capsule.id must not be empty")
  .max(64, "capsule.id must be 64 characters or fewer")
  .regex(
    CAPSULE_ID_PATTERN,
    "capsule.id must be alphanumeric with single dashes (no spaces, no leading/trailing dashes)",
  );

/**
 * Permissive semver-ish validator. We accept the common subset
 * `MAJOR.MINOR.PATCH` with optional pre-release / build suffixes. This is
 * intentionally looser than full semver 2.0 so capsule authors can use simple
 * versions like `1.0.0` or `0.1.0-rc.1` without pulling in a parser.
 */
const SemverLikeSchema = z
  .string()
  .min(1, "capsule.version must not be empty")
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    "capsule.version must be a semver-like string (e.g. 1.0.0)",
  );

export const CapsuleRetrievalPolicySchema = z.object({
  /**
   * Per-tier weight overrides applied during recall when the capsule is the
   * active scope. Keys are tier names (e.g. `bm25`, `vector`, `graph`); values
   * are non-negative finite multipliers. The set of valid keys is left open
   * for now so future tiers do not break older manifests.
   */
  tierWeights: z.record(
    z.string().min(1),
    z.number().finite().nonnegative(),
  ),
  /**
   * Whether the direct-answer fast path is allowed when this capsule is
   * active. Operators may disable it for capsules whose contents should
   * always flow through the full retrieval pipeline.
   */
  directAnswerEnabled: z.boolean(),
});

export type CapsuleRetrievalPolicy = z.infer<typeof CapsuleRetrievalPolicySchema>;

export const CapsuleIncludesSchema = z.object({
  taxonomy: z.boolean(),
  identityAnchors: z.boolean(),
  peerProfiles: z.boolean(),
  procedural: z.boolean(),
});

export type CapsuleIncludes = z.infer<typeof CapsuleIncludesSchema>;

export const CapsuleBlockSchema = z.object({
  id: CapsuleIdSchema,
  version: SemverLikeSchema,
  /**
   * Taxonomy schema version the capsule was authored against. Free-form for
   * now; later PRs may tighten this to a known taxonomy registry.
   */
  schemaVersion: z.string().min(1, "capsule.schemaVersion must not be empty"),
  /**
   * Optional reference to the parent capsule this one was forked or derived
   * from. `null` (not `undefined`) is the explicit "no parent" sentinel so
   * that round-trips through JSON do not silently drop the field.
   */
  parentCapsule: z.string().min(1).nullable(),
  description: z.string(),
  retrievalPolicy: CapsuleRetrievalPolicySchema,
  includes: CapsuleIncludesSchema,
});

export type CapsuleBlock = z.infer<typeof CapsuleBlockSchema>;

export const ExportManifestV2Schema = z.object({
  format: z.literal("openclaw-engram-export"),
  schemaVersion: z.literal(2),
  createdAt: z.string(),
  pluginVersion: z.string(),
  includesTranscripts: z.boolean(),
  files: z.array(
    z.object({
      path: z.string(),
      sha256: z.string(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  capsule: CapsuleBlockSchema,
});

export type ExportManifestV2 = z.infer<typeof ExportManifestV2Schema>;

export const ExportBundleV2Schema = z.object({
  manifest: ExportManifestV2Schema,
  records: z.array(ExportMemoryRecordV1Schema),
});

export type ExportBundleV2 = z.infer<typeof ExportBundleV2Schema>;

// ---------------------------------------------------------------------------
// Backward-compatible reader
// ---------------------------------------------------------------------------

export type AnyExportManifest = ExportManifestV1 | ExportManifestV2;
export type AnyExportBundle = ExportBundleV1 | ExportBundleV2;

/**
 * Normalized form returned by {@link parseExportManifest}. Callers that don't
 * care about the wire-format version can branch on `capsuleVersion` (1 or 2)
 * and trust that V1 manifests surface as `{ capsuleVersion: 1, capsule: null }`.
 */
export interface NormalizedExportManifest {
  capsuleVersion: 1 | 2;
  manifest: AnyExportManifest;
  capsule: CapsuleBlock | null;
}

/**
 * Parse an unknown manifest payload as either V1 or V2.
 *
 * Dispatch is driven by `schemaVersion` so we surface the most relevant
 * validation error per branch. If `schemaVersion` is missing or unknown we
 * fall back to V1 first (the historical wire format) and only report the V2
 * error if both branches fail.
 */
export function parseExportManifest(input: unknown): NormalizedExportManifest {
  const version =
    typeof input === "object" && input !== null
      ? (input as { schemaVersion?: unknown }).schemaVersion
      : undefined;

  if (version === 2) {
    const manifest = ExportManifestV2Schema.parse(input);
    return {
      capsuleVersion: 2,
      manifest,
      capsule: manifest.capsule,
    };
  }

  if (version === 1) {
    const manifest = ExportManifestV1Schema.parse(input);
    return { capsuleVersion: 1, manifest, capsule: null };
  }

  // Unknown / missing schemaVersion: try V1 then V2 so the reader stays
  // forgiving for hand-authored payloads but still produces a clear error.
  const v1 = ExportManifestV1Schema.safeParse(input);
  if (v1.success) {
    return { capsuleVersion: 1, manifest: v1.data, capsule: null };
  }
  const v2 = ExportManifestV2Schema.safeParse(input);
  if (v2.success) {
    return {
      capsuleVersion: 2,
      manifest: v2.data,
      capsule: v2.data.capsule,
    };
  }
  // Surface the V2 error since callers introducing capsules likely care most
  // about that branch's diagnostics.
  throw v2.error;
}

/**
 * Convenience: parse a full bundle (manifest + records) accepting either V1
 * or V2 manifests. Records currently share the V1 shape across both versions.
 */
export function parseExportBundle(input: unknown): {
  capsuleVersion: 1 | 2;
  bundle: AnyExportBundle;
  capsule: CapsuleBlock | null;
} {
  if (typeof input !== "object" || input === null) {
    // Defer to V1 schema so the user sees a familiar zod error.
    ExportBundleV1Schema.parse(input);
    throw new Error("unreachable");
  }
  const manifestRaw = (input as { manifest?: unknown }).manifest;
  const normalized = parseExportManifest(manifestRaw);
  if (normalized.capsuleVersion === 2) {
    const bundle = ExportBundleV2Schema.parse(input);
    return { capsuleVersion: 2, bundle, capsule: bundle.manifest.capsule };
  }
  const bundle = ExportBundleV1Schema.parse(input);
  return { capsuleVersion: 1, bundle, capsule: null };
}
