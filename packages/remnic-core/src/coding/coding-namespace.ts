/**
 * Coding-agent namespace overlay (issue #569 PR 2 + PR 3).
 *
 * Given a `CodingContext` (from `resolveGitContext`) and a `CodingModeConfig`,
 * returns the namespace that recall + write paths should use — or `null` when
 * no overlay should apply (coding mode disabled, no context supplied, or
 * feature flags off).
 *
 * PR 2 ships the project overlay. PR 3 will add the branch overlay; the
 * function here already handles both flags so the schema / types / plumbing
 * don't have to change a second time when branch-scope lands.
 *
 * Pure function — no orchestrator, no config side-effects. Callers keep rule
 * 42 (read + write through same namespace layer) by consulting the same
 * function on both paths.
 */

import type { CodingContext, CodingModeConfig } from "../types.js";

export interface CodingNamespaceOverlay {
  /**
   * Effective namespace to use for this session's memory operations. When
   * `branchScope` is on, takes the form `project:<id>/branch:<b>`; otherwise
   * `project:<id>`.
   */
  namespace: string;
  /**
   * Read fallbacks — additional namespaces a caller should include in recall
   * so that, for example, a branch-scoped session still sees project-level
   * memories that were written before the branch scope was enabled.
   *
   * Writes MUST go to `namespace` only; these are read-side only.
   *
   * Introduced to carry PR 3's branch→project fallback; PR 2 returns an empty
   * array here.
   */
  readFallbacks: string[];
  /**
   * `"project"` when only project scope applies, `"branch"` when branch scope
   * is also layered on. Used for diagnostics (`remnic doctor`) and logging.
   */
  scope: "project" | "branch";
}

// ──────────────────────────────────────────────────────────────────────────
// Sanitization
// ──────────────────────────────────────────────────────────────────────────

/**
 * Normalize a projectId / branch fragment so the resulting namespace passes
 * the router's `isSafeRouteNamespace` check (`[A-Za-z0-9._-]{1,64}`).
 *
 * Namespaces are used as filesystem directory names and must not contain
 * path separators (`/`, `\`) or colons — so both `:` and `/` collapse to `-`.
 * The project-id format `origin:<8hex>` and branch names like `feat/x` both
 * flow through this helper before hitting the storage layer.
 *
 * NOT a security boundary — projectIds come from `resolveGitContext` (known
 * hex), and branch names come from local git. This defends against corrupt
 * input only.
 */
function sanitizeFragment(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Cap to the router's per-namespace upper bound. Trim trailing `-` introduced
 * by truncation so the final character is always alphanumeric or `.`, `_`.
 */
const MAX_NAMESPACE_LEN = 64;
function capLength(value: string): string {
  if (value.length <= MAX_NAMESPACE_LEN) return value;
  return value.slice(0, MAX_NAMESPACE_LEN).replace(/-+$/g, "");
}

/**
 * Produce the project-scope namespace name. Exported for tests and for
 * `remnic doctor` to render. Guaranteed to satisfy `isSafeRouteNamespace`:
 * no `/`, no `:`, lowercase only, length-capped to 64 chars.
 */
export function projectNamespaceName(projectId: string): string {
  const frag = sanitizeFragment(projectId);
  return capLength(`project-${frag || "unknown"}`);
}

/**
 * Produce the branch-scope namespace name. Format:
 * `project-<id>-branch-<name>`. Uses `-` as the structural separator rather
 * than `/` or `:` so the result is a single safe route-namespace token that
 * can be used directly as a filesystem directory.
 */
export function branchNamespaceName(projectId: string, branch: string): string {
  const projectFrag = sanitizeFragment(projectId);
  const branchFrag = sanitizeFragment(branch);
  return capLength(
    `project-${projectFrag || "unknown"}-branch-${branchFrag || "unknown"}`,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Overlay resolver
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compute the namespace overlay for a session.
 *
 * Returns `null` when no overlay applies — callers should then use their
 * existing `defaultNamespaceForPrincipal(...)` result unchanged. This keeps
 * CLAUDE.md #30 (escape hatch): setting `codingMode.projectScope: false`
 * exactly restores pre-#569 behaviour at every call site.
 */
export function resolveCodingNamespaceOverlay(
  codingContext: CodingContext | null | undefined,
  config: Pick<CodingModeConfig, "projectScope" | "branchScope">,
): CodingNamespaceOverlay | null {
  // No context supplied (session isn't in a git repo, or connector didn't
  // attach one) → no overlay.
  if (!codingContext) return null;

  // Project scope disabled → no overlay at all. Branch scope depends on
  // project scope being on; there is no branch-only mode.
  if (!config.projectScope) return null;

  // Require a non-empty projectId — defensive.
  const projectId = typeof codingContext.projectId === "string" ? codingContext.projectId.trim() : "";
  if (!projectId) return null;

  const projectNs = projectNamespaceName(projectId);

  // Branch-scope layering (PR 3):
  //   - only when config.branchScope is explicitly true
  //   - only when we actually have a branch (null in detached HEAD)
  //   - project namespace becomes a read fallback so project-level memories
  //     remain visible from any branch (deliberate asymmetry — branch writes
  //     don't leak up, but project reads leak down).
  if (config.branchScope && typeof codingContext.branch === "string" && codingContext.branch.length > 0) {
    const branchNs = branchNamespaceName(projectId, codingContext.branch);
    return {
      namespace: branchNs,
      readFallbacks: [projectNs],
      scope: "branch",
    };
  }

  return {
    namespace: projectNs,
    readFallbacks: [],
    scope: "project",
  };
}
