# Peers

Issue [#679](https://github.com/joshuaswarren/remnic/issues/679) introduces a
**peer registry**: a generalization of Remnic's singular
identity-anchor model into a multi-peer schema. Every party that interacts
with a Remnic store — the operator themself, other humans, other agents,
and non-conversational integrations — can be represented as a `Peer` with
an evolving cognitive profile.

This page describes the **PR 1/5** schema slice. Async profile updates,
recall integration, and CLI/HTTP/MCP surfaces ship in later PRs.

## Concepts

A **peer** is a stable, opaque identity. Each peer has three on-disk
kernel files under `peers/{peer-id}/`:

| File | Purpose | Update cadence | Owner |
|------|---------|----------------|-------|
| `identity.md` | Slow-changing facts: `id`, `kind`, `displayName`, timestamps, free-form notes. | Manual / rare. | Operator. |
| `profile.md` | Evolving cognitive profile derived from session signals. JSON payload inside a fenced block, with per-field provenance. | Background reasoner (PR 2/5). | Reasoner. |
| `interactions.log.md` | Append-only signal log the reasoner reads. | Per turn / per signal. | Append-only. |

### Peer kinds

`Peer.kind` is one of:

- `self` — the current Remnic operator. Replaces the singular
  identity-anchor; PR 5/5 migrates existing identity-anchor data into
  `peers/self/identity.md`.
- `human` — another human collaborator distinct from `self`.
- `agent` — another AI agent (e.g. Claude Code, Codex, Hermes).
- `integration` — a non-conversational integration that produces signals
  but does not act on its own (cron, webhook, importer).

### Peer ids

`Peer.id` must match `^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`,
1–64 characters, with no leading/trailing/consecutive separators. The
storage layer validates this on every read and write — `..`, paths with
`/`, and other traversal-ish strings are rejected before any filesystem
operation.

## Distinguishing peers from `IDENTITY.md`

The pre-existing `IDENTITY.md` / identity-anchor model represents one
party — the operator. The peer registry is the multi-party
generalization:

- `IDENTITY.md` (today) → `peers/self/identity.md` after PR 5/5 migration.
- The `engram_identity_anchor_*` MCP tools continue to work unchanged
  during the migration window (PR 4/5 introduces deprecated aliases).
- `peers/self/profile.md` is the new home for the kind of evolving
  per-operator profile that the compounding engine maintains today;
  the reasoner in PR 2/5 will own writes there.

If you are reading this in PR 1/5: nothing has migrated yet. The peer
registry is purely additive on disk. No code path reads or writes peer
files outside of explicit calls to the new helpers in
`packages/remnic-core/src/peers/`.

## Privacy posture

- **Local-only by default.** Peer kernel files are stored under the
  same `memoryDir` tree as the rest of Remnic. They are not synced or
  exported anywhere automatically.
- **No personality inference.** The eventual reasoner (PR 2/5) only
  derives profile fields from observable signals — explicit
  preferences, communication-style cues, recurring concerns, decision
  patterns. Sentiment-based or affective inference is a non-goal.
- **Provenance everywhere.** Every profile field carries a list of
  `PeerProfileFieldProvenance` entries pointing back to the originating
  session/signal. Users can audit exactly why a profile claim exists.
- **Forget is destructive.** PR 5/5 will ship `remnic peer forget` —
  immediate file delete + archive purge + reasoner state cleanup for
  one peer.
- **Capsule export gating.** Capsule export (issue #676) controls
  whether peer data travels off-machine; peer profiles are not
  included in any capsule unless explicitly opted in.

## What ships in PR 1/5

Schema and storage primitives only:

- `Peer`, `PeerKind`, `PeerProfile`, `PeerProfileFieldProvenance`,
  `PeerInteractionLogEntry` types.
- `readPeer`, `writePeer`, `listPeers`, `readPeerProfile`,
  `writePeerProfile`, `appendInteractionLog`, `readInteractionLogRaw`,
  `assertValidPeerId` helpers.
- `PEER_ID_PATTERN`, `PEER_ID_MAX_LENGTH`, `PEERS_DIR_NAME` constants.

Public exports live on `@remnic/core`. Nothing in the orchestrator,
recall pipeline, extraction pipeline, or any access surface
(CLI/HTTP/MCP) consumes the peer registry yet — that wiring lands in
later PRs.

## What is deferred

- **PR 2/5** — async profile reasoner inside the Dreams REM phase.
  Disabled by default behind `peer.profileReasoner.enabled: false`.
- **PR 3/5** — recall integration: optional `peer` field on recall
  requests, profile excerpt injection, X-ray annotation.
- **PR 4/5** — CLI (`remnic peer list / show / set / forget`), HTTP
  endpoints under `/peers`, MCP tools `engram.peer_*`. Existing
  identity-anchor tools become deprecated aliases for `peers/self/`.
- **PR 5/5** — migration of existing identity-anchor data into
  `peers/self/`, plus the destructive `remnic peer forget` flow.
