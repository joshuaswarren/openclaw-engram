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

