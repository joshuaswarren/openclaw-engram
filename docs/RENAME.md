# Engram → Remnic Rename Plan

**Status:** In Progress
**Owner:** @joshuaswarren
**Target:** Execute before first 1.0.0 publish

---

## Summary

Rename Engram to **Remnic** — **R**ecall **E**ngine: **M**emory **N**etwork
for **I**ntelligent **C**ollaboration — before we cut the first 1.0.0 npm and
PyPI publish. Because the `@remnic/*` workspace packages and `remnic-hermes`
were never actually published, they rename for free. The only install base
that needs a migration path is `@joshuaswarren/openclaw-engram@9.2.7`.

The rename is the natural capstone for the EMO/OEO architecture split: the
product is no longer an OpenClaw plugin that happens to have standalone mode,
it's a standalone universal memory substrate that every agent in a user's
fleet shares. Remnic is that product. Engram was the prototype.

---

## Why (the story we tell)

There are four reasons for the rename, and they're ordered deliberately —
the first is about what the product *is*, the others are supporting evidence.

### 1. The product outgrew its original scope

Engram started as an OpenClaw plugin. It's still that — and OpenClaw remains
a first-class citizen, the deepest integration, the reference implementation
for how a host platform should connect. But the product is no longer *just*
an OpenClaw plugin.

It's a universal memory substrate that every agent in a user's fleet shares.
Claude Code, Codex, Cursor, Hermes, Replit, OpenClaw, and whatever ships next
— they all plug into one store. Tell one agent a preference, every agent
knows. The product is collective understanding across an agent fleet, not
a database for a single host.

The name "Engram" — borrowed from neuroscience, meaning a single memory
trace — describes a component. The product is the *network* those traces
live in, the *engine* that recalls them, and the *collaboration layer* that
lets every agent in the fleet work from the same understanding of the user.

**Remnic = Recall Engine: Memory Network for Intelligent Collaboration.**
The name describes what the product actually does, at the scope it actually
operates.

### 2. OpenClaw is a first-class citizen, not the whole world

The rename is about broadening scope without diminishing OpenClaw's role.
`@remnic/plugin-openclaw` is the bridge plugin — the deepest integration, the
one that ships by default, the one every other agent's memory eventually
unifies with when a user runs OpenClaw. Remnic works standalone, but OpenClaw
is how most users will first encounter it and how the product stays embedded
in the OpenClaw ecosystem.

The old name `openclaw-engram` made it sound like an OpenClaw appendage.
The new structure — Remnic as the product, `@remnic/plugin-openclaw` as the
reference bridge — says: OpenClaw is the flagship integration, and Remnic
is the layer underneath that every agent in your fleet can share.

### 3. Easy to recommend

A name you can say to a colleague and have them find it on the first Google
search is worth more than a clever name you have to spell out. "Engram"
returns neuroscience papers, a half-dozen note-taking apps, at least two AI
projects in adjacent spaces, and a cognitive psychology textbook. "Remnic"
returns Remnic.

This matters more than it sounds. The product's growth loop is
user-to-user recommendation: one developer tells another "my agents all
know my preferences because I run Remnic." If that name returns an
unambiguous first result, the recommendation converts. If it returns
thirty other things, the recommendation dies in the search bar.

### 4. The timing is free

Phase 9 merged the monorepo and the publish config, but `npm publish` never
ran. `@remnic/core`, `@remnic/server`, `@remnic/cli`, and `remnic-hermes`
are all 404 on their respective registries right now. We can rename every
workspace package *before first publish* and skip the shim work entirely
for them. Only one package — `@joshuaswarren/openclaw-engram@9.2.7` —
needs a migration path, because it's the only thing that ever shipped under
the old name.

Waiting makes this harder. Every day closer to 1.0.0 publish adds install
base we'd need to migrate. Today, the install base is one package and a
handful of early adopters. Tomorrow is worse.

---

## Current State (verified)

| Artifact | State |
|---|---|
| Phase 9 code (monorepo + publish config) | ✅ Merged to `main` (PRs #348–352) |
| `@remnic/core`, `@remnic/server`, `@remnic/cli`, etc. | ❌ Never published — 404 on npm |
| `remnic-hermes` on PyPI | ❌ Does not exist |
| `openclaw-engram` on npm (unscoped) | ⚠️ Owned by a different, unrelated project |
| `@joshuaswarren/openclaw-engram` | ✅ Published at 9.2.7 — **the only live artifact** |
| `@remnic/*` npm scope | ✅ Claimed (empty) |
| `remnic` on PyPI | ✅ Claimed at 0.0.1 placeholder |
| `remnic.ai` | ✅ Live landing page |
| GitHub repo | ✅ Renamed to `joshuaswarren/remnic` |

**Install base to migrate: one package.** Everything else is free namespace.

---

## Naming Map

| Domain | Engram | Remnic |
|---|---|---|
| Product | Engram | Remnic |
| Backronym | — | Recall Engine: Memory Network for Intelligent Collaboration |
| GitHub repo | `joshuaswarren/openclaw-engram` | `joshuaswarren/remnic` |
| npm scope | `@remnic/*` (unpublished) | `@remnic/*` |
| `packages/remnic-core` | `@remnic/core` | `@remnic/core` |
| `packages/remnic-server` | `@remnic/server` | `@remnic/server` |
| `packages/remnic-cli` | `@remnic/cli` | `@remnic/cli` |
| `packages/plugin-openclaw` | `openclaw-engram` | `@remnic/plugin-openclaw` |
| `packages/plugin-claude-code` | `@remnic/plugin-claude-code` | `@remnic/plugin-claude-code` |
| `packages/plugin-codex` | `@remnic/plugin-codex` | `@remnic/plugin-codex` |
| `packages/plugin-hermes` (Python) | `remnic-hermes` (unpublished) | `remnic-hermes` |
| `packages/connector-replit` | `@remnic/replit` | `@remnic/replit` |
| `packages/hermes-provider` | `@remnic/hermes-provider` | `@remnic/hermes-provider` |
| `packages/bench` | `@remnic/bench` | `@remnic/bench` |
| CLI binary | `engram` | `remnic` (+ `engram` forwarder through v1.x, removed in v2.0.0) |
| Config dir | `~/.engram/` | `~/.remnic/` (auto-migrated) |
| Log dir | `~/.engram/logs/` | `~/.remnic/logs/` |
| Env vars | `ENGRAM_*` | `REMNIC_*` (reads `ENGRAM_*` as fallback through v1.x, removed in v2.0.0) |
| Token prefixes | `engram_cc_*`, `engram_cx_*`, … | `remnic_cc_*`, `remnic_cx_*`, … (regenerated) |
| launchd label | `ai.engram.daemon` | `ai.remnic.daemon` |
| systemd unit | `engram.service` | `remnic.service` |
| HTTP port | 4318 | unchanged |
| Memory store | `~/.openclaw/workspace/memory/local/` | unchanged (OpenClaw-owned path) |
| MCP tool names | `engram_recall`, `engram_observe`, … | **dual-registered**: both `remnic_*` and `engram_*` work through v1.x, removed in v2.0.0 |

---

## Migration Model

### Migration module: `@remnic/core/src/migrate/from-engram.ts`

```typescript
export interface MigrationResult {
  status: "fresh-install" | "already-migrated" | "migrated";
  copied: string[];
  tokensRegenerated: number;
  servicesReinstalled: string[];
  rollbackCommand: string;
}

export async function migrateFromEngram(): Promise<MigrationResult> {
  // 1. Check marker: ~/.remnic/.migrated-from-engram
  //    If present → { status: "already-migrated" }
  // 2. Check ~/.engram/
  //    If absent → { status: "fresh-install" }
  // 3. Copy (never move) config, tokens, logs → ~/.remnic/
  // 4. Rewrite token prefixes in tokens.json: engram_* → remnic_*
  // 5. Update .mcp.json in all connector dirs to reference new tokens
  // 6. Unload launchd ai.engram.daemon, install ai.remnic.daemon
  //    (or equivalent for systemd on Linux)
  // 7. Touch marker file
  // 8. Return summary
}
```

**Properties:**
- **Idempotent** — safe to run twice, early-exit via marker file
- **Never destructive** — `~/.engram/` is copied, not moved. Rollback is
  `remnic migrate --rollback` followed by `rm -rf ~/.remnic` and reloading
  the preserved old daemon (full sequence in the user-facing log above).
- **Lazy** — only runs on first post-rename invocation
- **Cheap check** — all call sites do a non-throwing existence probe
  (`fs.existsSync(markerPath)` or `fs.stat` with explicit `ENOENT` handling)
  before invoking the full module. Never `statSync` raw — the expected
  first-run state is "marker missing", which would throw and crash startup.
- **Interprocess-locked** — the full migration body runs under an exclusive
  file lock at `~/.remnic/.migration.lock` (acquired via `proper-lockfile` or
  equivalent `flock`-based primitive). Multiple entry points (`@remnic/cli`,
  `@remnic/core` init, `@remnic/plugin-openclaw` register, hook preambles)
  can fire concurrently on first post-rename invocation; the lock ensures
  exactly one process copies files, rewrites tokens, and installs the new
  daemon. Contenders block until the holder finishes, then re-check the
  marker and exit via the `already-migrated` path. Stale locks (holder
  crashed) are detected via PID liveness and reclaimed.

**Called from:**
- `@remnic/cli` entry (every command)
- `@remnic/core` `Orchestrator.initialize()`
- `@remnic/plugin-openclaw` first `register()` call
- Hook preamble scripts (Claude Code and Codex)

### User-facing migration log

```
[remnic] First run after Engram → Remnic rename. Migrating…
[remnic] ✓ ~/.engram/config.yaml  → ~/.remnic/config.yaml
[remnic] ✓ ~/.engram/tokens.json  → ~/.remnic/tokens.json  (prefixes regenerated)
[remnic] ✓ Updated .mcp.json in Claude Code plugin dir
[remnic] ✓ Updated .mcp.json in Codex plugin dir
[remnic] ✓ launchd: ai.engram.daemon unloaded, ai.remnic.daemon installed
[remnic] ✓ Memory store untouched: ~/.openclaw/workspace/memory/local/
[remnic] ✓ ~/.engram/ preserved as rollback (safe to delete once verified)
[remnic] Migration complete. Welcome to Remnic.
[remnic] Rollback (macOS):
[remnic]   1. launchctl unload ~/Library/LaunchAgents/ai.remnic.daemon.plist
[remnic]   2. rm ~/Library/LaunchAgents/ai.remnic.daemon.plist
[remnic]   3. remnic migrate --rollback   (restores .mcp.json from backup manifest)
[remnic]   4. rm -rf ~/.remnic
[remnic]   5. launchctl load ~/Library/LaunchAgents/ai.engram.daemon.plist
[remnic]      (preserved by migration — not deleted)
[remnic] Rollback (Linux):
[remnic]   1. systemctl --user stop remnic.service
[remnic]   2. systemctl --user disable remnic.service
[remnic]   3. rm ~/.config/systemd/user/remnic.service
[remnic]   4. remnic migrate --rollback   (restores .mcp.json from backup manifest)
[remnic]   5. rm -rf ~/.remnic
[remnic]   6. systemctl --user enable --now engram.service
```

**Connector config backup + restore.** Before mutating any `.mcp.json` file,
the migration module copies the original to
`~/.remnic/.backup/mcp/<hash>.json` and records the mapping in
`~/.remnic/.rollback.json`. Every token/tool-name/env-var mutation the
migration makes to a connector config is logged as a reversible entry.
`remnic migrate --rollback` replays that manifest in reverse: restores each
`.mcp.json` from its backup, re-deletes any files migration created, and
exits cleanly so the subsequent `rm -rf ~/.remnic` leaves no dangling
connector state pointing at the deleted Remnic token store.

**Migration preserves the old service file.** On macOS, `ai.engram.daemon.plist`
is unloaded but left on disk at `~/Library/LaunchAgents/`. On Linux,
`engram.service` is disabled but the unit file is preserved. This is what
makes rollback to the old daemon possible without reinstalling Engram. The
migration module writes a rollback manifest to `~/.remnic/.rollback.json`
with the exact `launchctl`/`systemctl` commands needed to restore the
previous state.

---

## Package Strategy

### Workspace packages — fresh publish
All `@remnic/*` packages ship as 1.0.0 to npm. No shim work required because
`@remnic/*` never existed on the registry.

### PyPI
- `remnic-hermes@1.0.0` — real package (Python MemoryProvider for Hermes)
- `remnic@1.0.0` — real metapackage. `pip install remnic` pulls in
  `remnic-hermes` (and any future Python components). Replaces the current
  0.0.1 placeholder.

### Shim: `@joshuaswarren/openclaw-engram@9.3.0`
**The only shim.** One final release of the existing published package that:

1. Depends on the new bridge plugin (`@remnic/plugin-openclaw`)
2. Re-exports everything — zero behavior change
3. Emits a loud postinstall banner
4. Is marked deprecated via `npm deprecate`

```bash
npm deprecate "@joshuaswarren/openclaw-engram@<9.3.0" \
  "Renamed to Remnic. See https://remnic.ai/rename"
npm deprecate "@joshuaswarren/openclaw-engram@9.3.0" \
  "Renamed to Remnic. Auto-migrates on first run. See https://remnic.ai/rename"
```

The shim stays on the registry **forever**. Never unpublished. Just frozen
after v2.0.0 of the new packages when we drop the dependency fan-in.

### GitHub repo rename
The repo is now `joshuaswarren/remnic`. GitHub auto-redirects old clone URLs,
PR URLs, issue URLs, and raw file URLs. Existing clones continue to work, but
all canonical links should now use the new repo path.

---

## User-Facing Migration Surfaces

Four independent surfaces ensure every existing user sees the rename on their
next interaction, regardless of how they interact.

### 1. npm deprecation warning (passive, on install)
```
npm warn deprecated @joshuaswarren/openclaw-engram@9.3.0:
  Renamed to Remnic. See https://remnic.ai/rename
```

### 2. postinstall banner (loud, on install)
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Engram is now Remnic
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Same product. New name. One-time auto-migration runs
  on first use. Your memories, config, and tokens carry over.

  Why: namespace conflicts and a clearer identity for what
  the product actually is — a Recall Engine for Memory
  Networks powering Intelligent Collaboration across your
  entire agent fleet.

  Next step: nothing. The plugin auto-migrates on first run.

  Learn more: https://remnic.ai/rename
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 3. Runtime migration log (on first daemon/plugin/CLI invocation)
See migration log example above. This is the surface that catches users who
installed globally months ago and never reinstall.

### 4. `engram` CLI forwarder (on command invocation)
```
$ engram recall "typescript preferences"
⚠  'engram' is now 'remnic'. This alias will be removed in v2.0.0.
→ remnic recall "typescript preferences"
```

---

## MCP Tool Dual-Registration

All tools registered under both `engram_*` and `remnic_*` names. Same handler,
same signature. On `engram_*` invocation, the server log emits a one-shot
warning (not returned to the model — would spam prompts).

```typescript
const canonicalTools = [
  { name: "remnic_recall",  impl: recall  },
  { name: "remnic_observe", impl: observe },
  { name: "remnic_memory_store", impl: store },
  // … all tools
];

// Register canonical
for (const tool of canonicalTools) server.registerTool(tool);

// Register engram_* aliases (deprecated)
for (const tool of canonicalTools) {
  server.registerTool({
    name: tool.name.replace(/^remnic_/, "engram_"),
    impl: (args) => {
      logger.warnOnce(`[remnic] MCP tool ${tool.name.replace(/^remnic_/, "engram_")} is deprecated — use ${tool.name}`);
      return tool.impl(args);
    },
  });
}
```

`engram_*` aliases removed in v2.0.0 alongside the CLI forwarder and env var fallback.

---

## Rollout

Compressed cadence. Not days-with-slack — hours-with-verification.

### Phase A — Repo rename
1. GitHub UI: rename `joshuaswarren/openclaw-engram` → `joshuaswarren/remnic`
2. Update local remotes
3. Verify GitHub redirect from old URL
4. Update `package.json` `repository`, `homepage`, `bugs` URLs
5. Update `remnic.ai/rename` landing to link new repo

### Phase B — Rename PR against `main`
Single coordinated PR. No publishes during this phase.

- Rename all `packages/engram-*` → `packages/remnic-*`
- Update every `package.json` `name` field → `@remnic/*`
- Update every import, identifier, env var, label, path, binary name
- Preserve read-fallbacks for `~/.engram/` and `ENGRAM_*`
- Dual-register MCP tools
- Add `@remnic/core/src/migrate/from-engram.ts`
- Hook migration into CLI entry, `Orchestrator.initialize()`, plugin `register()`, hook preambles
- Add `engram` CLI forwarder binary
- Update `README.md`, `CHANGELOG.md`, all `docs/**/*.md`
- Update `.github/workflows/*.yml`
- Update `CLAUDE.md` project instructions
- Add migration tests (fresh install, existing `~/.engram/`, idempotent re-run, rollback)
- Full test suite green
- `pnpm -r publish --dry-run` validates publish config

### Phase C — Shim package
- `packages/shim-openclaw-engram/` with `@joshuaswarren/openclaw-engram@9.3.0`
- `dependencies: { "@remnic/plugin-openclaw": "^1.0.0" }`
- Postinstall banner script
- Re-exports everything from the new bridge plugin

### Phase D — Publish
- `pnpm -r publish --access public` for all `@remnic/*`
- `twine upload dist/*` for `remnic-hermes`
- `npm publish` for the shim
- `npm deprecate` incantations for all old versions and the new shim

### Phase E — Brand surfaces
- Publish `remnic.ai/rename` landing page
- Pin rename banner on `joshuaswarren/remnic` README
- CHANGELOG 1.0.0 "The Remnic Release" section
- GitHub release notes
- User posts to Discords they're on

### Phase F — Monitor & tighten
- Watch shim download stats, GitHub issues, runtime migration telemetry
- Ship `@remnic/*@1.1.0` that tightens deprecations:
  - Louder `engram` CLI forwarder warning
  - Louder `ENGRAM_*` env var warning
  - Louder `engram_*` MCP tool warning

### Phase G — Drop shims
- `@remnic/*@2.0.0` removes:
  - `engram` CLI forwarder binary
  - `ENGRAM_*` env var fallback
  - `engram_*` MCP tool aliases
- **`~/.engram/` migration path is NOT removed in 2.0.0.** Long-tail users on
  frozen `@joshuaswarren/openclaw-engram@9.2.7` may jump directly from a
  legacy install to 2.x, and auto-migration is the only thing that carries
  their tokens, config, and service state forward. The migration module stays
  shipped in 2.x and beyond; only the *interactive banners* around it get
  quieter. If/when we ever drop it, 2.x must first hard-gate on a missing
  marker and refuse to start with an explicit "run `remnic migrate` or
  reinstall via the 1.x bridge" error — never silently skip.
- `@joshuaswarren/openclaw-engram` stays frozen — never removed, but no longer
  updated

The spacing between phases is measured in hours-to-a-day, not weeks. Stop
conditions are evidence-based, not calendar-based.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Migration corrupts `~/.engram/` | Copy only, never move. Marker prevents re-runs. Rollback = `rm -rf ~/.remnic` |
| Locked-pin users never reinstall | Their `9.2.7` keeps working untouched. The shim is additive, not a forced break |
| Regenerated tokens break running daemon | Migration atomically updates `.mcp.json` files, unloads old daemon, installs new |
| launchd label collision | Migration unloads `ai.engram.daemon` before installing `ai.remnic.daemon`; port 4318 unchanged so only one binds |
| User runs both `engram` and `remnic` simultaneously (shim users) | Shim `9.3.0` re-exports `@remnic/cli`, so both binaries load the same code and read `~/.remnic/`. Divergence impossible for this cohort |
| User runs `engram` (locked `@joshuaswarren/openclaw-engram@9.2.7`) AND `remnic` side-by-side | Genuinely separate codepaths and config roots: 9.2.7 reads/writes `~/.engram/`, remnic reads/writes `~/.remnic/`. Memories stored via 9.2.7 will NOT appear in Remnic. Mitigation: (a) OpenClaw memory store at `~/.openclaw/workspace/memory/local/` is shared — OEO-mode writes land in both; (b) `remnic migrate --merge` ships in 1.1 to fold post-migration `~/.engram/` deltas back into `~/.remnic/`; (c) release notes explicitly call out that locked-pin users must either upgrade to the 9.3.0 shim or accept the split |
| MCP clients cache old tool list | Dual-registration means cached `engram_*` lists stay valid through v1.x |
| SEO loss on "engram memory" searches | `remnic.ai/rename` canonicalizes. GitHub repo redirects. CHANGELOG crosslinks both names |
| Fork CI breaks on repo rename | GitHub redirect covers clone URLs. Fork owners get a UI banner offering to update |
| Someone misses every surface | Four independent surfaces — npm warn, postinstall banner, runtime log, CLI forwarder. Any one of them catches the user |
| First-publish bugs in `@remnic/*@1.0.0` | Normal patch cycle applies. Phase F monitoring is explicitly for this |

---

## Out of Scope

- ❌ Changing memory file formats or schemas
- ❌ Changing HTTP API contracts
- ❌ Changing MCP tool signatures (only names are dual-registered)
- ❌ Renaming `~/.openclaw/workspace/memory/local/` — OpenClaw owns this path
- ❌ Rewriting git history — breaks forks
- ❌ Unpublishing old packages — shims stay forever, frozen after v2.0.0
- ❌ Auto-deleting `~/.engram/` post-migration — user decides when

---

## Decisions Locked

- ✅ Repo: `joshuaswarren/remnic` (drop "openclaw" from repo name)
- ✅ MCP tools: dual-register `remnic_*` and `engram_*` through v1.x, removed in v2.0.0
- ✅ Timeline: hours and days, not weeks or months
- ✅ Four migration surfaces (npm warn, postinstall, runtime, CLI forwarder)
- ✅ Shim package `@joshuaswarren/openclaw-engram@9.3.0` stays on registry forever

## Decisions Locked (continued)

- ✅ **Bridge plugin:** `@remnic/plugin-openclaw` — whole product under one
  scope, keeps the namespace coherent, OpenClaw is a first-class citizen
  without owning the product's identity.

- ✅ **`remnic` PyPI metapackage:** real 1.0.0 metapackage. `pip install remnic`
  installs `remnic-hermes` and any future Python components.
- ✅ **Shim version:** `@joshuaswarren/openclaw-engram@9.3.0` (minor bump) so
  `npm update` picks it up for semver-locked users and triggers the migration
  surfaces.

## Decisions Open

_None — plan is fully locked. Execution is underway; publish and brand rollout remain._

---

## Related

- `~/src/remnic-site/` — Astro site at remnic.ai
- `packages/` — monorepo layout that becomes the `@remnic/*` workspace
- PRs #348–352 — Phase 9 (merged) that prepared the monorepo and publish config
- `docs/architecture/` — existing architecture docs (update in Phase B PR)
