/**
 * Operator-facing memory forgetting (issue #686 PR 4/6).
 *
 * `remnic forget <id>` marks a memory as forgotten — a soft-delete that:
 *
 *   1. Sets `status: "forgotten"`, `forgottenAt`, optional
 *      `forgottenReason` in YAML frontmatter via the existing
 *      `storage.writeMemoryFrontmatter` path (which logs the change
 *      to the lifecycle ledger and invalidates caches).
 *   2. Returns a structured result describing what changed so the
 *      CLI and downstream telemetry can render it.
 *
 * Memories with `status === "forgotten"` are excluded from recall,
 * browse, and entity attribution by the existing status filters
 * (storage.ts and access-service.ts already drop everything that
 * isn't `active` from default reads).  A future maintenance cron
 * will hard-delete forgotten memories after a configurable retention
 * window (default 90 days) — for this PR the file stays on disk and
 * the act is reversible by editing the YAML directly.
 *
 * This module ships the pure helper; the CLI wires it in `cli.ts` as
 * a new `remnic forget` subcommand.
 */

import type { StorageManager } from "../storage.js";
import type { MemoryFile } from "../types.js";

export interface ForgetMemoryRequest {
  /** Memory id (frontmatter `id`) to forget. */
  id: string;
  /** Optional human-readable reason. */
  reason?: string;
  /** Override the timestamp written to `forgottenAt`. Defaults to `new Date().toISOString()`. */
  now?: () => Date;
}

export interface ForgetMemoryResult {
  /** Memory id that was forgotten. */
  id: string;
  /** Filesystem path of the forgotten memory. */
  path: string;
  /** Prior status before the forget call, for audit. */
  priorStatus: string;
  /** Timestamp written to `forgottenAt`. */
  forgottenAt: string;
  /** Reason captured (or empty string if none). */
  reason: string;
}

export class ForgetMemoryNotFoundError extends Error {
  readonly code = "memory_not_found" as const;
  constructor(id: string) {
    super(`memory not found: ${id}`);
    this.name = "ForgetMemoryNotFoundError";
  }
}

export class ForgetMemoryAlreadyForgottenError extends Error {
  readonly code = "already_forgotten" as const;
  constructor(id: string, forgottenAt: string) {
    super(`memory ${id} was already forgotten at ${forgottenAt}`);
    this.name = "ForgetMemoryAlreadyForgottenError";
  }
}

/**
 * Mark a memory as forgotten.  Pure orchestration over storage —
 * caller supplies the storage instance and the request.  Status
 * filters elsewhere in the codebase already exclude
 * `status: "forgotten"` from default reads (memory-cache,
 * access-service browse, retrieval) because they enumerate the
 * `active` allow-list rather than excluding individual non-active
 * statuses (CLAUDE.md rule 53).
 */
export async function forgetMemory(
  storage: StorageManager,
  request: ForgetMemoryRequest,
): Promise<ForgetMemoryResult> {
  const id = typeof request.id === "string" ? request.id.trim() : "";
  if (id.length === 0) {
    throw new Error("forget: memory id is required and must be non-empty");
  }
  const memory = await findMemoryById(storage, id);
  if (!memory) {
    throw new ForgetMemoryNotFoundError(id);
  }
  if (memory.frontmatter.status === "forgotten") {
    throw new ForgetMemoryAlreadyForgottenError(
      id,
      memory.frontmatter.forgottenAt ?? "(unknown)",
    );
  }
  const priorStatus =
    typeof memory.frontmatter.status === "string" ? memory.frontmatter.status : "active";
  const now = (request.now ?? (() => new Date()))();
  const forgottenAt = now.toISOString();
  const reason = typeof request.reason === "string" ? request.reason.trim() : "";
  await storage.writeMemoryFrontmatter(memory, {
    status: "forgotten",
    forgottenAt,
    ...(reason.length > 0 ? { forgottenReason: reason } : {}),
    updated: forgottenAt,
  }, {
    actor: "remnic-forget",
    reasonCode: "operator_forget",
  });
  return {
    id,
    path: memory.path,
    priorStatus,
    forgottenAt,
    reason,
  };
}

async function findMemoryById(
  storage: StorageManager,
  id: string,
): Promise<MemoryFile | null> {
  const all = await storage.readAllMemories();
  return all.find((m) => m.frontmatter.id === id) ?? null;
}
