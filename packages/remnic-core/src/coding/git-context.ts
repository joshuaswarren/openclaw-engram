/**
 * GitContextResolver — pure module for detecting the git project + branch
 * a session is operating in.
 *
 * Introduced by issue #569 (coding-agent project/branch-scoped namespaces).
 *
 * This module is deliberately pure:
 *   - no orchestrator references
 *   - no config side-effects
 *   - no namespace wiring
 *
 * Downstream slices (PR 2+ of #569) wire `resolveGitContext` into the
 * `NamespaceResolver` / `Orchestrator` so that memories are scoped to a
 * detected project / branch without leaking across repos.
 *
 * CLAUDE.md rule 17 (expand `~`): the `rootPath` returned here is always an
 * absolute, tilde-expanded path. Callers must not re-expand.
 *
 * CLAUDE.md rule 51 (reject invalid input): `cwd` must be an absolute path
 * and must exist. `resolveGitContext` returns `null` — rather than throwing —
 * when the directory is not inside a git worktree, because being outside a
 * repo is a normal runtime state (e.g. agent opened in a scratch dir).
 */
import path from "node:path";

import { expandTildePath } from "../utils/path.js";
import { launchProcessSync } from "../runtime/child-process.js";

// Re-export so existing callers / tests that imported `expandTildePath` from
// this module keep working. CLAUDE.md #17 requires consistent `~` expansion
// across every user-facing path input; the canonical implementation now
// lives in `utils/path.ts`.
export { expandTildePath };

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

export interface GitContext {
  /**
   * Stable identifier for the project. Derived from `git remote get-url origin`
   * when an origin remote is configured, otherwise from the repo root path.
   *
   * Formatted as `origin:<hex>` or `root:<hex>` so that the source is visible
   * to operators (see `remnic doctor`, issue #569 acceptance criteria).
   */
  projectId: string;
  /**
   * Current branch, e.g. `main`, `feat/foo`. `null` only in detached-HEAD
   * state (e.g. rebase in progress). Callers should treat `null` as "no
   * branch-scope overlay applies" without erroring.
   */
  branch: string | null;
  /**
   * Absolute path to the repository root (the directory containing `.git`).
   * Tilde-expanded per CLAUDE.md #17.
   */
  rootPath: string;
  /**
   * Best-effort default branch (usually `main` or `master`). Derived from the
   * `refs/remotes/origin/HEAD` symbolic ref. `null` when not available (e.g.
   * fresh clone without a default branch symref, or no origin remote).
   */
  defaultBranch: string | null;
}

/**
 * Injectable git-invocation surface. Only the commands `resolveGitContext`
 * actually needs are exposed. Tests inject a mock implementation to avoid
 * spawning a real git process.
 */
export interface GitInvoker {
  /**
   * Run `git <args>` with `cwd` as the working directory. Must return
   * `{ stdout, exitCode }` with `stdout` trimmed by the caller as needed.
   * Implementations should NOT throw for non-zero exit codes — they should
   * return the exit code so the resolver can decide how to recover.
   */
  (cwd: string, args: string[]): { stdout: string; exitCode: number };
}

// ──────────────────────────────────────────────────────────────────────────
// Default git invoker — spawns real `git` via the shared child-process helper
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_GIT_TIMEOUT_MS = 2_000;

export function defaultGitInvoker(): GitInvoker {
  return (cwd: string, args: string[]) => {
    const result = launchProcessSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: DEFAULT_GIT_TIMEOUT_MS,
      shell: false,
    });
    if (result.error) {
      // Spawn failure (git not on PATH, timeout, etc.). Surface as non-zero.
      return { stdout: "", exitCode: 127 };
    }
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      exitCode: typeof result.status === "number" ? result.status : 1,
    };
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Stable hashing
// ──────────────────────────────────────────────────────────────────────────

/**
 * Non-cryptographic stable hash. Used only to derive a deterministic
 * `projectId` from either the origin URL or the root path. The hash does not
 * need to be collision-resistant against adversarial input — it is purely a
 * namespace discriminator.
 *
 * Uses FNV-1a 32-bit so we don't pull in `node:crypto` for a simple bucket
 * key. Output is lowercase hex, zero-padded to 8 characters.
 */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ──────────────────────────────────────────────────────────────────────────
// Origin URL normalization
// ──────────────────────────────────────────────────────────────────────────

/**
 * Normalize a git remote URL so that equivalent SSH / HTTPS forms of the
 * same repo produce the same `projectId`. Handles:
 *   - `git@github.com:foo/bar.git`  → `github.com/foo/bar`
 *   - `https://github.com/foo/bar`  → `github.com/foo/bar`
 *   - `https://github.com/foo/bar.git` → `github.com/foo/bar`
 *   - `ssh://git@github.com/foo/bar` → `github.com/foo/bar`
 *   - `ssh://git@github.com:2222/foo/bar` → `github.com/foo/bar` (port stripped)
 *
 * Case-insensitive (remote hostnames and most repo paths on major forges are
 * case-insensitive in practice).
 */
export function normalizeOriginUrl(rawUrl: string): string {
  let url = rawUrl.trim();
  if (!url) return "";

  // Strip trailing `.git`
  if (url.endsWith(".git")) url = url.slice(0, -4);

  // Protocol-prefixed: ssh://, https://, http://, git://, file://
  // Must be tried FIRST so that scp-style detection below doesn't
  // incorrectly swallow an ssh:// URL that happens to contain `:port/`.
  //
  // Matching groups:
  //   1: host (userinfo stripped)
  //   2: port (optional, discarded — same repo on :22 vs :2222 is the
  //      same repo for memory-routing purposes)
  //   3: path (optional)
  const protoMatch = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?(\/.*)?$/i.exec(url);
  if (protoMatch) {
    const host = protoMatch[1] ?? "";
    const repoPath = (protoMatch[2] ?? "").replace(/^\/+/, "");
    return `${host}/${repoPath}`.toLowerCase();
  }

  // scp-like syntax: user@host:path. Deliberately rejects anything that
  // contains `://` (handled above), and uses `[^:@/\s]+` for the host so that
  // `git@host:port/repo` is only treated as scp when the part after `:` is
  // non-numeric — scp paths start with a path component, not a port number.
  const scpMatch = /^([^@\s/]+)@([^:@\s/]+):(.+)$/.exec(url);
  if (scpMatch) {
    const host = scpMatch[2] ?? "";
    const repoPath = scpMatch[3] ?? "";
    return `${host}/${repoPath.replace(/^\/+/, "")}`.toLowerCase();
  }

  // Fallback: use raw lowercased
  return url.toLowerCase();
}

// ──────────────────────────────────────────────────────────────────────────
// Resolver
// ──────────────────────────────────────────────────────────────────────────

export interface ResolveGitContextOptions {
  /** Inject a git invoker (tests). Defaults to spawning real `git`. */
  invoker?: GitInvoker;
}

/**
 * Detect the git project + branch for `cwd`.
 *
 * Returns `null` when:
 *   - `cwd` is not an absolute path (invalid input, CLAUDE.md #51)
 *   - `cwd` is not inside a git worktree
 *   - `git` is not available on PATH
 *
 * Never throws.
 */
export async function resolveGitContext(
  cwd: string,
  options: ResolveGitContextOptions = {},
): Promise<GitContext | null> {
  // Validate input: must be a non-empty string.
  if (typeof cwd !== "string" || cwd.length === 0) return null;

  // Expand `~` per CLAUDE.md #17, then require absolute path.
  const expanded = expandTildePath(cwd);
  if (!path.isAbsolute(expanded)) return null;

  const invoker = options.invoker ?? defaultGitInvoker();

  // 1. Locate the repo root. `rev-parse --show-toplevel` returns the absolute
  //    path to the top of the working tree, or exits non-zero when outside a
  //    repo.
  const topLevel = invoker(expanded, ["rev-parse", "--show-toplevel"]);
  if (topLevel.exitCode !== 0) return null;
  const rootPath = topLevel.stdout.trim();
  if (!rootPath) return null;

  // 2. Current branch. `--abbrev-ref HEAD` returns `HEAD` in detached state,
  //    which we normalize to `null`.
  const branchResult = invoker(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let branch: string | null = null;
  if (branchResult.exitCode === 0) {
    const raw = branchResult.stdout.trim();
    branch = raw && raw !== "HEAD" ? raw : null;
  }

  // 3. Origin URL — optional. Used to derive a stable `projectId`.
  const originResult = invoker(rootPath, ["remote", "get-url", "origin"]);
  let projectId: string;
  if (originResult.exitCode === 0) {
    const normalized = normalizeOriginUrl(originResult.stdout);
    projectId = normalized ? `origin:${stableHash(normalized)}` : `root:${stableHash(rootPath)}`;
  } else {
    // No origin remote — fall back to hashing the root path.
    projectId = `root:${stableHash(rootPath)}`;
  }

  // 4. Default branch — best effort. `symbolic-ref refs/remotes/origin/HEAD`
  //    returns e.g. `refs/remotes/origin/main`.
  const headRef = invoker(rootPath, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  let defaultBranch: string | null = null;
  if (headRef.exitCode === 0) {
    const raw = headRef.stdout.trim();
    const prefix = "refs/remotes/origin/";
    if (raw.startsWith(prefix)) {
      const candidate = raw.slice(prefix.length);
      if (candidate) defaultBranch = candidate;
    }
  }

  return {
    projectId,
    branch,
    rootPath,
    defaultBranch,
  };
}
