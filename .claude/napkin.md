# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|
| 2026-02-20 | self | Assumed napkin file existed in this repo | Create and maintain `.claude/napkin.md` at session start when missing |

## User Preferences
- Keep PR checks/review threads fully clean; proactively prevent repeat feedback loops.

## Patterns That Work
- Resolve review-thread guard failures by querying exact unresolved thread IDs via GraphQL and resolving each thread explicitly.

## Patterns That Don't Work
- Assuming external bot status (Cursor Bugbot) will settle quickly; must continue polling and re-check thread count.

## Domain Notes
- Repo: `extensions/openclaw-engram`
- Release flow uses protected-main-safe tag-only publishing from GitHub Actions.
| 2026-02-20 | self | Assumed merged PR included later branch fixes | Verify `origin/main..branch` commit range after merges; merged title can hide missing follow-up commits |
| 2026-02-20 | self | Used backticks in shell command body for `gh pr close --comment`, causing command substitution (`YamlSyntaxError` command-not-found) | Avoid backticks in shell-literal comment strings; use plain quotes or heredoc files for PR comments |
| 2026-02-21 | self | Tried patching `src/types.ts` with stale context and failed apply | Re-read exact ranges first, then patch in smaller hunks to avoid drift in active repos |
| 2026-02-21 | self | Forgot `additionalProperties: false` in plugin schema means every new config key must be added to `openclaw.plugin.json` | Update runtime parser + TypeScript config + plugin schema in the same pass |

## Patterns That Work
- For feature-flagged behavior changes, keep defaults conservative and wire docs/changelog in the same commit to reduce reviewer loops.
| 2026-02-21 | self | Used backticks in `gh pr create --body` and zsh executed command substitutions | Always use `--body-file` with a single-quoted heredoc for multiline PR bodies |
| 2026-02-21 | self | Resolved review threads did not automatically clear all prior `Review Thread Guard` failures | Rerun stale failed `Review Thread Guard` runs so branch protection reflects current thread state |
| 2026-02-21 | self | Initial `no_recall` heuristic was too aggressive for short imperative prompts | Keep `no_recall` limited to acknowledgement-only utterances; default task prompts to minimal recall |
| 2026-02-21 | self | Default non-neutral intent labels (`general`/`execute`) created accidental compatibility boosts | Use neutral `unknown` fallback and require concrete signals before applying intent-based ranking boosts |
| 2026-02-21 | self | Reviewers can flag per-recall full scans even when they replaced N×scans | Add bounded TTL caches for expensive status maps in recall paths; prefer cache+safe fallback semantics |
