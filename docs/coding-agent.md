# Coding agent mode

Issue [#569](https://github.com/joshuaswarren/remnic/issues/569) teaches
Remnic to auto-scope memory by git project — and optionally by branch —
so that what an agent learns while working on project A does not surface
while working on project B. No environment variables, no per-client
scripting, no manual namespace flags. If the session has a working
directory inside a git repository, coding mode activates automatically.

This document covers the surfaces that ship today:

1. The `codingMode.projectScope` and `codingMode.branchScope` config
   knobs and their defaults.
2. How the overlay is computed from git (`GitContext`) and combined
   with the principal's base namespace.
3. How `remnic doctor` renders the effective scope.
4. The `engram.set_coding_context` MCP tool (with the
   `remnic.set_coding_context` alias) for MCP clients that do not ship
   `cwd` automatically.
5. The diff-aware **review-context** recall tier that boosts memories
   whose `entityRefs` mention a touched file.
6. Per-connector behavior (Claude Code, Codex CLI, Cursor / MCP).
7. How to opt out.

## Overview

Session-scoped overlay. When a session attaches a `CodingContext`
(`{ projectId, branch, rootPath, defaultBranch }`) Remnic computes an
overlay namespace using the pure resolver in
[`packages/remnic-core/src/coding/coding-namespace.ts`](../packages/remnic-core/src/coding/coding-namespace.ts).
The overlay is then combined with the principal's existing base
namespace so that principal isolation (rule 42) still holds:

```text
alice + project-origin-ab12  →  alice-project-origin-ab12
bob   + project-origin-ab12  →  bob-project-origin-ab12
```

Writes always land in the combined overlay namespace. Reads use the
overlay plus any declared read-fallbacks, which is how branch-scoped
sessions stay able to see project-level history.

Pure functions, deterministic hashes, no per-call I/O. The overlay only
changes when the connector hands Remnic a new `CodingContext`.

## Config surface

`codingMode` is a nested object under the plugin config:

| Key                       | Default | Behavior |
|---------------------------|---------|----------|
| `codingMode.projectScope` | `true`  | When true, every session with a resolved `CodingContext` uses a project-scoped namespace. When false, the principal's default namespace is used unchanged — exact pre-#569 behavior (CLAUDE.md rule 30 escape hatch). |
| `codingMode.branchScope`  | `false` | When true, additionally overlay the current branch on top of the project namespace. Project-level reads remain visible to a branch-scoped session through `readFallbacks`; branch writes do not leak up to project scope. |

Branch scope depends on project scope being on — there is no
branch-only mode. In detached-HEAD state (`branch === null`) the
branch overlay silently degrades to project-only; Remnic never
fabricates a branch name.

The types live in
[`packages/remnic-core/src/types.ts`](../packages/remnic-core/src/types.ts)
(`CodingModeConfig`, lines 215-229).

## How projectId is derived

[`packages/remnic-core/src/coding/git-context.ts`](../packages/remnic-core/src/coding/git-context.ts)
contains `resolveGitContext(cwd)` which, given a tilde-expanded
absolute cwd, runs a short sequence of `git` commands (2s timeout
each, see line 86) and returns a `GitContext`:

- `projectId` — a stable identifier for the repo. Formatted as
  `origin:<8hex>` when a remote origin is configured, or
  `root:<8hex>` when only a local repo exists. The hash is FNV-1a
  32-bit (line 120). Two clones of the same `github.com/foo/bar`
  repo collapse to the same id because the origin URL is normalized
  (`normalizeOriginUrl`, line 145): SSH, HTTPS, protocol-prefixed and
  scp-style forms of the same repo all produce one id.
- `branch` — the current branch, or `null` in detached HEAD.
- `rootPath` — the absolute repo root, tilde-expanded.
- `defaultBranch` — derived from
  `refs/remotes/origin/HEAD` when available, otherwise `null`.

`resolveGitContext` is documented as "never throws" (line 252). When
`git` is not on PATH, when the cwd is outside a git worktree, or when
an invoker fails, the resolver returns `null` and coding mode remains
inactive for that session.

## `remnic doctor` output

`remnic doctor` surfaces the effective coding scope. The description is
built by `describeCodingScope()` in
[`coding-namespace.ts`](../packages/remnic-core/src/coding/coding-namespace.ts)
(lines 327-387) and shows:

- The raw `projectId` / `branch` from the attached `CodingContext`.
- The resolved `scope` — `"none"`, `"project"`, or `"branch"`.
- The `effectiveNamespace` that writes will route through (the
  principal-combined form).
- Any `readFallbacks` (only populated when branch-scope is active).
- A `disabledReason` when `scope === "none"`, one of:
  - `"no-context"` — the connector did not attach a `CodingContext`
    (session started outside a repo, or using a connector that can't
    ship `cwd`).
  - `"disabled"` — `codingMode.projectScope` is `false`.
  - `"empty-project"` — the attached `CodingContext.projectId` was
    empty or whitespace (defensive).

Example doctor block (synthetic):

```
- [OK] coding_scope: project scope active
  projectId: origin:ab12cd34
  branch: feat/issue-569
  scope: project
  effectiveNamespace: alice-project-origin-ab12cd34
  readFallbacks: (none)
```

When branch-scope is on:

```
- [OK] coding_scope: branch scope active
  projectId: origin:ab12cd34
  branch: feat/issue-569
  scope: branch
  effectiveNamespace: alice-project-origin-ab12cd34-branch-feat-issue-569
  readFallbacks: alice-project-origin-ab12cd34
```

When the overlay is disabled:

```
- [WARN] coding_scope: no overlay applied
  disabledReason: no-context
```

## MCP tool: `engram.set_coding_context`

Registered by the MCP access surface at
[`packages/remnic-core/src/access-mcp.ts`](../packages/remnic-core/src/access-mcp.ts)
(lines 128-160, handler at 1182-1217). Canonical name
`engram.set_coding_context`; `withToolAliases` emits the canonical
`remnic.set_coding_context` alias automatically so both names work.

Purpose: attach or clear a session's `CodingContext` from an MCP client
that cannot ship `cwd` on its own (Cursor, generic MCP agents, etc.).

Input schema:

```json
{
  "sessionKey": "string",
  "codingContext": {
    "projectId": "origin:<8hex> or root:<8hex>",
    "branch": "main | null",
    "rootPath": "/abs/path",
    "defaultBranch": "main | null"
  }
}
```

Pass `codingContext: null` to clear the session's context — useful when
an agent moves between projects mid-session or when an operator wants to
drop back to the principal's default namespace without restarting.

Validation happens in
[`access-service.ts`](../packages/remnic-core/src/access-service.ts)
`setCodingContext(...)`; invalid inputs surface as
`EngramAccessInputError` (structured MCP tool-call errors) instead of
silent no-ops.

## Review-context recall tier

[`packages/remnic-core/src/coding/review-context.ts`](../packages/remnic-core/src/coding/review-context.ts)
(PR 4 of #569) ships a pure diff-aware packer that piggybacks on a
normal recall:

1. `isReviewPrompt(prompt)` — a case-insensitive whole-word match on
   `review`, `diff`, `what changed`, `look at this PR`, `code review`,
   and paraphrases (lines 75-82). When false, the tier is skipped.
2. `parseTouchedFiles(diff)` — accepts both `diff --git a/foo b/bar`
   and `--- a/foo / +++ b/bar` forms, honors git's C-quoted path
   escapes, and strips `a/` / `b/` prefixes. Returns deduplicated,
   sorted, repo-root-relative paths.
3. `rankReviewCandidates(candidates, touchedFiles)` — additive boost
   (`+0.5` per matching touched file, capped at `+1.0`) applied to
   candidates whose `entityRefs` substring-match any touched file.
   Sort is `(score + boost)` descending with a stable secondary key
   on the memory id (rule 19).

The tier is a **bias, not a filter**: it re-orders the existing
recall candidate list; it never removes candidates. Memories whose
`entityRefs` mention a touched file float up, so an agent reviewing a
PR sees prior decisions about those exact files first.

## Per-connector behavior

### Claude Code (ships today)

[`packages/plugin-claude-code/hooks/bin/session-start.sh`](../packages/plugin-claude-code/hooks/bin/session-start.sh)
(lines 54-150) reads `cwd` from the session-start payload, runs a
short local `git` sequence, and posts an
`engram.set_coding_context` tool call to the Remnic daemon. The hook
intentionally mirrors the pure logic of `resolveGitContext` in-shell
so it does not round-trip through the daemon before the first recall.
On any failure (`git` missing, cwd outside a repo, daemon unreachable)
it silently clears the context rather than blocking session startup.

### Codex CLI (ships today)

The Codex CLI connector's session-start hook follows the same pattern:
resolve the git context for the shell's cwd, post
`engram.set_coding_context`, silently no-op on failure. See
[`packages/plugin-codex/`](../packages/plugin-codex/) for the hook.

### Cursor / generic MCP (manual)

Cursor and other MCP clients that do not expose a cwd hook can still
attach a coding context by calling `engram.set_coding_context` as their
first action in a session. The operator (or the agent itself) passes a
`CodingContext` object matching the schema above. Pass
`codingContext: null` to clear it before switching projects.

## Opting out

Two paths:

- **Per-install:** set `codingMode.projectScope: false` in plugin
  config. No project overlay is applied anywhere. This exactly restores
  pre-#569 behavior (rule 30 escape hatch).
- **Per-session:** call `engram.set_coding_context` with
  `codingContext: null`. The session reverts to the principal's
  default namespace until a new context is attached.

`codingMode.branchScope` inherits the project-scope gate: setting
`projectScope: false` disables branch scope too, regardless of
`branchScope`.

## Troubleshooting

- **Cross-principal isolation** — two principals working in the same
  repo get distinct namespaces because the overlay is *combined* with
  the principal's base fragment (`sanitizeBaseFragment` preserves case
  so `Alice` and `alice` do not collapse). If you see two principals
  sharing memories, confirm `namespacesEnabled: true` — with
  namespaces disabled the storage router maps every namespace to the
  same `memoryDir`, so the overlay is deliberately a no-op to avoid a
  false-isolation trap (orchestrator lines 1420-1425).
- **Case-insensitive filesystems** — the overlay is always
  lowercased and `[A-Za-z0-9._-]`-sanitized, so a repo cloned with
  different casing on a case-insensitive filesystem produces the same
  `projectId` (origin URL is normalized) and the same overlay
  namespace.
- **Git timeouts** — each git invocation is bounded at 2 seconds
  (`DEFAULT_GIT_TIMEOUT_MS`, line 86). If `git` hangs longer than that
  the resolver returns `null` and the session proceeds without an
  overlay. Spurious "no overlay" entries in `remnic doctor` across
  slow filesystems usually trace here; increase filesystem responsiveness
  or pre-warm the repo rather than raising the timeout.
- **Detached HEAD** — `branch` is `null`. With `branchScope: true`
  the overlay silently falls back to project-only; the doctor output
  will show `scope: project` with `branch: null` as a hint.
- **Long branch names** — overlay namespaces are capped at 64
  characters with a deterministic hash suffix (`capLength`, line 113),
  so two distinct long branches never collapse to one namespace through
  simple prefix truncation.

## Related reading

- [`docs/namespaces.md`](./namespaces.md) — the underlying namespace
  system coding mode overlays on top of.
- [`packages/remnic-core/src/coding/git-context.ts`](../packages/remnic-core/src/coding/git-context.ts) — `resolveGitContext` and origin URL normalization.
- [`packages/remnic-core/src/coding/coding-namespace.ts`](../packages/remnic-core/src/coding/coding-namespace.ts) — overlay resolver and diagnostic surface.
- [`packages/remnic-core/src/coding/review-context.ts`](../packages/remnic-core/src/coding/review-context.ts) — diff-aware review-context packer.
