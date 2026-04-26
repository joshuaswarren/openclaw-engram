/**
 * Peer registry storage primitives — issue #679 PR 1/5.
 *
 * Pure file-I/O helpers for the per-peer kernel files:
 *
 *   peers/{peer-id}/identity.md       — slow, human-edited identity facts
 *   peers/{peer-id}/profile.md        — evolving profile (reasoner-owned)
 *   peers/{peer-id}/interactions.log.md — append-only signal log
 *
 * No reasoner logic, no recall integration, no migration of existing
 * identity-anchor data — those land in PR 2/5 — 5/5.
 *
 * Path safety: `peerId` is validated against PEER_ID_PATTERN before any
 * filesystem operation. Reading a non-existent peer returns null (does not
 * throw). Reading malformed files throws — callers can catch and recover.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  PEER_ID_MAX_LENGTH,
  PEER_ID_PATTERN,
  type Peer,
  type PeerInteractionLogEntry,
  type PeerKind,
  type PeerProfile,
  type PeerProfileFieldProvenance,
} from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────

const ALLOWED_KINDS: ReadonlySet<PeerKind> = new Set<PeerKind>([
  "self",
  "human",
  "agent",
  "integration",
]);

/**
 * Validate a peer id. Throws `Error` with a descriptive message on failure.
 * Exported so callers can pre-check user input before constructing a Peer.
 */
export function assertValidPeerId(peerId: unknown): asserts peerId is string {
  if (typeof peerId !== "string") {
    throw new Error("peerId must be a string");
  }
  if (peerId.length === 0) {
    throw new Error("peerId must not be empty");
  }
  if (peerId.length > PEER_ID_MAX_LENGTH) {
    throw new Error(`peerId must be ≤ ${PEER_ID_MAX_LENGTH} characters`);
  }
  if (!PEER_ID_PATTERN.test(peerId)) {
    throw new Error(
      `peerId "${peerId}" is invalid — must match ${PEER_ID_PATTERN}`,
    );
  }
  // Defence-in-depth: reject consecutive dots/dashes/underscores. The
  // regex already prevents leading/trailing separators, but explicit
  // adjacency checks document intent and survive future regex refactors.
  if (/[.\-_]{2,}/.test(peerId)) {
    throw new Error(
      `peerId "${peerId}" is invalid — must not contain consecutive separators`,
    );
  }
}

function assertValidKind(kind: unknown): asserts kind is PeerKind {
  if (typeof kind !== "string" || !ALLOWED_KINDS.has(kind as PeerKind)) {
    throw new Error(
      `peer kind must be one of ${Array.from(ALLOWED_KINDS).join(", ")}`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────
// Path helpers
// ──────────────────────────────────────────────────────────────────────

/** Root directory holding the peer registry, relative to memoryDir. */
export const PEERS_DIR_NAME = "peers";

function peersRoot(memoryDir: string): string {
  return path.join(memoryDir, PEERS_DIR_NAME);
}

function peerDir(memoryDir: string, peerId: string): string {
  // Guard against path traversal on top of regex validation. After
  // assertValidPeerId, peerId cannot contain `/`, `..`, or NUL — but we
  // re-check defensively here.
  assertValidPeerId(peerId);
  const candidate = path.join(peersRoot(memoryDir), peerId);
  const root = peersRoot(memoryDir);
  // Ensure resolved path stays within peersRoot. Note: this is a
  // lexical check only — a symlinked peer directory can still escape.
  // I/O sites must additionally call `assertPeerDirNotEscaped` (below)
  // before reading or writing, which uses lstat to reject symlinks
  // and realpath to confirm physical containment (codex P1 #723).
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`peerId "${peerId}" resolves outside peers root`);
  }
  return candidate;
}

/**
 * Reject the peers root if it is itself a symlink. Called BEFORE any
 * `fs.mkdir`, so a `peers → /tmp/outside` symlink can't get its
 * target mutated by a recursive mkdir before subsequent checks fire
 * (codex P2 + cursor M on PR #723).
 */
async function assertPeersRootNotSymlink(memoryDir: string): Promise<void> {
  const root = peersRoot(memoryDir);
  let rootStat: import("node:fs").Stats | null = null;
  try {
    rootStat = await fs.lstat(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (rootStat && rootStat.isSymbolicLink()) {
    throw new Error(`peers root "${root}" is a symlink and is rejected`);
  }
}

/**
 * Reject any path that exists and is a symlink. Used to gate every
 * file-level I/O so a malicious `peers/<id>/identity.md → /etc/passwd`
 * can't redirect a read or a write to an arbitrary file (codex P1 #2
 * on PR #723). Returns silently when the path does not exist (writes
 * create files under directories that have already been validated).
 */
async function assertPathNotSymlink(p: string): Promise<void> {
  let stat: import("node:fs").Stats | null = null;
  try {
    stat = await fs.lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`path "${p}" is a symlink and is rejected`);
  }
}

/**
 * Codex P1 on PR #723: `peerDir` only enforces a lexical
 * `path.relative` check, so a symlinked peer directory like
 * `peers/self → /tmp/outside` would slip through. Run this guard
 * AFTER the peer directory has been (or is known to) exist, so we
 * can lstat it and realpath-check containment. For first-time writes,
 * call `assertPeersRootNotSymlink` BEFORE `fs.mkdir` and this AFTER.
 */
async function assertPeerDirNotEscaped(memoryDir: string, peerId: string): Promise<void> {
  const candidate = peerDir(memoryDir, peerId);
  const root = peersRoot(memoryDir);
  // 1. The peers root must not be a symlink (defensive — writers
  // already checked this before mkdir, but reads must still verify).
  await assertPeersRootNotSymlink(memoryDir);
  // 2. lstat on the candidate itself. If it's a symlink, refuse.
  let candidateStat: import("node:fs").Stats | null = null;
  try {
    candidateStat = await fs.lstat(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (candidateStat && candidateStat.isSymbolicLink()) {
    throw new Error(`peer directory "${peerId}" is a symlink and is rejected`);
  }
  // 3. Real-path containment. Only meaningful if the candidate exists.
  if (candidateStat) {
    const realRoot = await fs.realpath(root);
    const realCandidate = await fs.realpath(candidate);
    const rel = path.relative(realRoot, realCandidate);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`peer directory "${peerId}" escapes the peers root`);
    }
  }
}

function identityPath(memoryDir: string, peerId: string): string {
  return path.join(peerDir(memoryDir, peerId), "identity.md");
}

function profilePath(memoryDir: string, peerId: string): string {
  return path.join(peerDir(memoryDir, peerId), "profile.md");
}

function interactionsPath(memoryDir: string, peerId: string): string {
  return path.join(peerDir(memoryDir, peerId), "interactions.log.md");
}

// ──────────────────────────────────────────────────────────────────────
// Minimal YAML helpers (peer files only)
// ──────────────────────────────────────────────────────────────────────
//
// We deliberately do not depend on the codebase's primary YAML parser
// (`storage.ts`) because the peer schema is small and structured. We emit
// a strict, predictable subset:
//
//   ---
//   id: my-peer
//   kind: agent
//   displayName: "Codex"
//   createdAt: 2026-04-25T00:00:00.000Z
//   updatedAt: 2026-04-25T00:00:00.000Z
//   ---
//   {free-form markdown notes}
//
// String values are always double-quoted with `\\` and `\"` escapes. ISO
// timestamps and the kind enum are emitted bare. This keeps round-trip
// behaviour deterministic and easy to validate.

function escapeYamlString(value: string): string {
  // Cursor Medium: must escape newlines / carriage returns / tabs so a
  // value like `displayName: "first\nsecond"` doesn't blow up the
  // line-oriented parsePeerFrontmatter. Backslash → `\\`, double-quote
  // → `\"`, newline → `\n`, carriage return → `\r`, tab → `\t`.
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

function unescapeYamlString(quoted: string): string {
  // Caller has already verified `quoted` starts and ends with a double quote.
  const body = quoted.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && i + 1 < body.length) {
      const next = body[i + 1];
      if (next === "\\" || next === '"') {
        out += next;
        i++;
        continue;
      }
      if (next === "n") {
        out += "\n";
        i++;
        continue;
      }
      if (next === "r") {
        out += "\r";
        i++;
        continue;
      }
      if (next === "t") {
        out += "\t";
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

interface ParsedFrontmatter {
  fields: Record<string, string>;
  body: string;
}

function parsePeerFrontmatter(raw: string): ParsedFrontmatter {
  // Frontmatter must begin with a `---` line. We tolerate a leading BOM
  // and trailing newlines but otherwise require a strict, line-oriented
  // YAML subset of `key: value` pairs.
  const text = raw.replace(/^﻿/, "");
  if (!text.startsWith("---")) {
    throw new Error("peer file is missing YAML frontmatter delimiter");
  }
  // Split on the first occurrence of `\n---` after the leading `---`.
  const after = text.slice(3);
  const close = after.indexOf("\n---");
  if (close === -1) {
    throw new Error("peer file frontmatter is not terminated");
  }
  const fmBlock = after.slice(0, close).replace(/^\n/, "");
  const body = after.slice(close + 4).replace(/^\n/, "");
  const fields: Record<string, string> = {};
  for (const lineRaw of fmBlock.split("\n")) {
    const line = lineRaw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`peer frontmatter line is malformed: ${line}`);
    }
    const key = line.slice(0, colon).trim();
    const valueRaw = line.slice(colon + 1).trim();
    if (key === "") {
      throw new Error(`peer frontmatter has empty key: ${line}`);
    }
    let value: string;
    if (valueRaw.startsWith('"') && valueRaw.endsWith('"') && valueRaw.length >= 2) {
      value = unescapeYamlString(valueRaw);
    } else {
      value = valueRaw;
    }
    fields[key] = value;
  }
  return { fields, body };
}

function emitPeerIdentity(peer: Peer): string {
  const lines: string[] = ["---"];
  lines.push(`id: ${escapeYamlString(peer.id)}`);
  lines.push(`kind: ${peer.kind}`);
  lines.push(`displayName: ${escapeYamlString(peer.displayName)}`);
  // Cursor M: emit timestamps as quoted YAML strings — bare emission
  // would let a `createdAt` value containing a newline inject extra
  // frontmatter fields when round-tripped through `parsePeerFrontmatter`.
  // (`writePeer` validates these are non-empty strings, but the type
  // doesn't constrain content.)
  lines.push(`createdAt: ${escapeYamlString(peer.createdAt)}`);
  lines.push(`updatedAt: ${escapeYamlString(peer.updatedAt)}`);
  lines.push("---");
  lines.push("");
  lines.push(peer.notes ?? "");
  // Trailing newline for POSIX friendliness.
  return lines.join("\n").replace(/\n+$/, "\n") + "\n";
}

// ──────────────────────────────────────────────────────────────────────
// Public storage API
// ──────────────────────────────────────────────────────────────────────

/**
 * Read a peer's identity kernel.
 *
 * Returns `null` (does not throw) when the peer directory or identity
 * file does not exist. Throws on filesystem errors other than ENOENT and
 * on malformed files.
 */
export async function readPeer(
  memoryDir: string,
  peerId: string,
): Promise<Peer | null> {
  assertValidPeerId(peerId);
  await assertPeerDirNotEscaped(memoryDir, peerId);
  const file = identityPath(memoryDir, peerId);
  // Codex P1 #2: even with the directory validated, a symlinked
  // identity.md inside a real peer dir would let us read arbitrary
  // out-of-scope files. Reject symlinks at the file level too.
  await assertPathNotSymlink(file);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const { fields, body } = parsePeerFrontmatter(raw);
  const id = fields.id ?? peerId;
  if (id !== peerId) {
    throw new Error(
      `peer identity file mismatch — expected id "${peerId}", file claims "${id}"`,
    );
  }
  const kind = fields.kind;
  assertValidKind(kind);
  const displayName = fields.displayName ?? "";
  const createdAt = fields.createdAt ?? "";
  const updatedAt = fields.updatedAt ?? createdAt;
  if (createdAt === "") {
    throw new Error(`peer "${peerId}" is missing createdAt`);
  }
  // Codex P2 + CodeQL: previously used `body.replace(/^\s+/, "")`
  // which stripped ALL leading whitespace — including indentation in
  // notes. The `\s+` patterns also flagged as polynomial-regex risk
  // (CodeQL alert #74) because they can backtrack on adversarial
  // inputs. Strip exactly one leading separator newline and one
  // trailing newline — internal AND user-authored leading
  // indentation are preserved verbatim, and the regex is bounded.
  let trimmedBody = body;
  if (trimmedBody.startsWith("\r\n")) trimmedBody = trimmedBody.slice(2);
  else if (trimmedBody.startsWith("\n")) trimmedBody = trimmedBody.slice(1);
  if (trimmedBody.endsWith("\r\n")) trimmedBody = trimmedBody.slice(0, -2);
  else if (trimmedBody.endsWith("\n")) trimmedBody = trimmedBody.slice(0, -1);
  return {
    id: peerId,
    kind,
    displayName,
    createdAt,
    updatedAt,
    notes: trimmedBody === "" ? undefined : trimmedBody,
  };
}

/**
 * Write (create or overwrite) a peer's identity kernel.
 *
 * Creates `peers/{id}/` if it does not exist. Does not touch the peer's
 * profile or interaction log. Atomic-write semantics are deferred to
 * later PRs — for the schema slice we simply write the file.
 */
export async function writePeer(memoryDir: string, peer: Peer): Promise<void> {
  assertValidPeerId(peer.id);
  assertValidKind(peer.kind);
  if (typeof peer.displayName !== "string") {
    throw new Error("peer.displayName must be a string");
  }
  if (typeof peer.createdAt !== "string" || peer.createdAt === "") {
    throw new Error("peer.createdAt must be a non-empty ISO-8601 string");
  }
  if (typeof peer.updatedAt !== "string" || peer.updatedAt === "") {
    throw new Error("peer.updatedAt must be a non-empty ISO-8601 string");
  }
  // Codex P2 + cursor M: validate the peers root BEFORE mkdir so a
  // symlinked `peers/` root can't get its target mutated by the
  // recursive mkdir even though the post-check would later throw.
  await assertPeersRootNotSymlink(memoryDir);
  const dir = peerDir(memoryDir, peer.id);
  await fs.mkdir(dir, { recursive: true });
  await assertPeerDirNotEscaped(memoryDir, peer.id);
  const file = identityPath(memoryDir, peer.id);
  // Codex P1 #2: reject if identity.md exists as a symlink so we
  // don't follow it on overwrite.
  await assertPathNotSymlink(file);
  await fs.writeFile(file, emitPeerIdentity(peer), "utf8");
}

/**
 * Enumerate all peers under `memoryDir/peers/`.
 *
 * Returns an empty array if the peers root does not exist. Subdirectories
 * whose name fails `PEER_ID_PATTERN` are skipped (defensive: the user
 * may have hand-edited the directory). Directories that exist but lack
 * `identity.md` are also skipped.
 */
export async function listPeers(memoryDir: string): Promise<Peer[]> {
  // Codex P1 (round 2): `fs.readdir(root)` follows a symlinked
  // peers root, so without checking first, listing on a malicious
  // `peers → /tmp/outside` symlink would enumerate out-of-scope
  // contents and feed them to readPeer. Reject the symlinked root
  // BEFORE the readdir.
  await assertPeersRootNotSymlink(memoryDir);
  const root = peersRoot(memoryDir);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const peers: Peer[] = [];
  // Sort for deterministic ordering — callers that need a different
  // sort order can re-sort the result.
  entries.sort();
  for (const name of entries) {
    if (!PEER_ID_PATTERN.test(name) || name.length > PEER_ID_MAX_LENGTH) {
      continue;
    }
    let stat;
    try {
      // Codex P1: use `lstat` so we don't follow symlinks. A
      // `peers/<valid-id>` symlink pointing at an arbitrary directory
      // would otherwise let listPeers (and the readPeer that
      // follows) traverse outside the peers root.
      stat = await fs.lstat(path.join(root, name));
    } catch {
      continue;
    }
    // Skip symlinks entirely — only real directories are peers.
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    let peer: Peer | null = null;
    try {
      peer = await readPeer(memoryDir, name);
    } catch {
      // Skip malformed peer directories rather than failing the whole list.
      continue;
    }
    if (peer !== null) {
      peers.push(peer);
    }
  }
  return peers;
}

// ──────────────────────────────────────────────────────────────────────
// Interaction log (append-only)
// ──────────────────────────────────────────────────────────────────────

function sanitizeLogField(value: string): string {
  // Cursor Medium: every interaction-log field — not just summary —
  // must collapse newlines so a malicious or buggy `timestamp` /
  // `kind` / `sessionId` value can't break the one-line-per-entry
  // invariant the append-only log relies on. Replace CR/LF/Tab with
  // a single space; trim leading/trailing whitespace.
  return value.replace(/[\r\n\t]+/g, " ").trim();
}

function formatLogEntry(entry: PeerInteractionLogEntry): string {
  // One line per entry. We use a leading bullet so the file remains
  // readable as ordinary markdown. Order: timestamp, kind, optional
  // session id, summary. ALL fields are passed through `sanitizeLogField`
  // so a stray newline anywhere can't shatter the append-only invariant
  // (cursor Medium on PR #723).
  const ts = sanitizeLogField(entry.timestamp);
  const kind = sanitizeLogField(entry.kind);
  const summary = sanitizeLogField(entry.summary);
  const session = entry.sessionId
    ? ` session=${sanitizeLogField(entry.sessionId)}`
    : "";
  return `- [${ts}] (${kind})${session} ${summary}`;
}

/**
 * Append one entry to a peer's interaction log.
 *
 * Creates `peers/{id}/` and `interactions.log.md` if needed. The file is
 * append-only by contract — this helper never rewrites prior entries.
 * Returns the absolute path of the log file (useful for tests).
 */
export async function appendInteractionLog(
  memoryDir: string,
  peerId: string,
  entry: PeerInteractionLogEntry,
): Promise<string> {
  assertValidPeerId(peerId);
  if (typeof entry.timestamp !== "string" || entry.timestamp === "") {
    throw new Error("interaction entry must have a non-empty timestamp");
  }
  if (typeof entry.kind !== "string" || entry.kind === "") {
    throw new Error("interaction entry must have a non-empty kind");
  }
  if (typeof entry.summary !== "string") {
    throw new Error("interaction entry must have a string summary");
  }
  await assertPeersRootNotSymlink(memoryDir);
  const dir = peerDir(memoryDir, peerId);
  await fs.mkdir(dir, { recursive: true });
  await assertPeerDirNotEscaped(memoryDir, peerId);
  const file = interactionsPath(memoryDir, peerId);
  await assertPathNotSymlink(file);
  const line = formatLogEntry(entry) + "\n";
  // `appendFile` creates the file if it does not exist. POSIX guarantees
  // writes < PIPE_BUF are atomic; entries on this path are well under
  // that bound. Ordering across concurrent writers is the caller's
  // responsibility for now — the reasoner runs serially in PR 2/5.
  await fs.appendFile(file, line, "utf8");
  return file;
}

// ──────────────────────────────────────────────────────────────────────
// Profile read/write (schema scaffold; reasoner ships in PR 2/5)
// ──────────────────────────────────────────────────────────────────────

interface ProfileFile {
  updatedAt: string;
  fields: Record<string, string>;
  provenance: Record<string, PeerProfileFieldProvenance[]>;
}

function emitPeerProfile(profile: PeerProfile): string {
  // Profiles use a JSON-in-fenced-code-block payload inside a markdown
  // file so they remain human-readable. The frontmatter holds the
  // updatedAt stamp; the body holds the full structured payload.
  const payload: ProfileFile = {
    updatedAt: profile.updatedAt,
    fields: { ...profile.fields },
    provenance: Object.fromEntries(
      Object.entries(profile.provenance).map(([k, v]) => [k, [...v]]),
    ),
  };
  const json = JSON.stringify(payload, null, 2);
  return [
    "---",
    `peerId: ${escapeYamlString(profile.peerId)}`,
    `updatedAt: ${escapeYamlString(profile.updatedAt)}`,
    "---",
    "",
    "<!-- peer profile — managed by the async reasoner. Manual edits will be overwritten. -->",
    "",
    "```json",
    json,
    "```",
    "",
  ].join("\n");
}

function parsePeerProfile(raw: string, peerId: string): PeerProfile {
  const { fields: fm, body } = parsePeerFrontmatter(raw);
  if (fm.peerId !== undefined && fm.peerId !== peerId) {
    throw new Error(
      `peer profile mismatch — expected "${peerId}", file claims "${fm.peerId}"`,
    );
  }
  const fenceMatch = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`peer profile for "${peerId}" is missing JSON payload`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenceMatch[1]);
  } catch (err) {
    throw new Error(
      `peer profile for "${peerId}" has invalid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`peer profile for "${peerId}" is not an object`);
  }
  const payload = parsed as Partial<ProfileFile>;
  // Codex P2: only accept string updatedAt values. A malformed payload
  // like `{ "updatedAt": 123 }` would previously short-circuit through
  // `payload.updatedAt ?? fm.updatedAt ?? ""` and produce a `PeerProfile`
  // whose updatedAt is a number — corrupting any downstream code that
  // assumes the contract.
  const payloadUpdatedAt = typeof payload.updatedAt === "string" ? payload.updatedAt : undefined;
  const updatedAt = payloadUpdatedAt ?? fm.updatedAt ?? "";
  if (typeof updatedAt !== "string" || updatedAt === "") {
    throw new Error(`peer profile for "${peerId}" is missing updatedAt`);
  }
  const fieldsObj =
    typeof payload.fields === "object" && payload.fields !== null ? payload.fields : {};
  const provenanceObj =
    typeof payload.provenance === "object" && payload.provenance !== null
      ? payload.provenance
      : {};
  // Coerce values defensively. We never trust the on-disk shape.
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(fieldsObj)) {
    if (typeof v === "string") fields[k] = v;
  }
  const provenance: Record<string, PeerProfileFieldProvenance[]> = {};
  for (const [k, v] of Object.entries(provenanceObj)) {
    if (!Array.isArray(v)) continue;
    const list: PeerProfileFieldProvenance[] = [];
    for (const item of v) {
      if (
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item)
      ) {
        continue;
      }
      const r = item as unknown as Record<string, unknown>;
      if (typeof r.observedAt !== "string" || typeof r.signal !== "string") {
        continue;
      }
      // Codex P2: previously the optional fields were never type-
      // checked, so a hand-edited `{sourceSessionId: 123}` survived
      // and corrupted the PeerProfileFieldProvenance contract for
      // downstream consumers. Build a clean record with only
      // string-typed optional fields included.
      const clean: PeerProfileFieldProvenance = {
        observedAt: r.observedAt,
        signal: r.signal,
        ...(typeof r.sourceSessionId === "string"
          ? { sourceSessionId: r.sourceSessionId }
          : {}),
        ...(typeof r.note === "string" ? { note: r.note } : {}),
      };
      list.push(clean);
    }
    provenance[k] = list;
  }
  return { peerId, updatedAt, fields, provenance };
}

/**
 * Read a peer's profile. Returns null if the profile file does not exist.
 *
 * The PR-1 surface only ships the structured read/write so the reasoner
 * (PR 2/5) and recall integration (PR 3/5) have a stable target. We do
 * not yet expose any field-update helpers.
 */
export async function readPeerProfile(
  memoryDir: string,
  peerId: string,
): Promise<PeerProfile | null> {
  assertValidPeerId(peerId);
  await assertPeerDirNotEscaped(memoryDir, peerId);
  const file = profilePath(memoryDir, peerId);
  await assertPathNotSymlink(file);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  return parsePeerProfile(raw, peerId);
}

/**
 * Write (create or overwrite) a peer's profile.
 */
export async function writePeerProfile(
  memoryDir: string,
  profile: PeerProfile,
): Promise<void> {
  assertValidPeerId(profile.peerId);
  if (typeof profile.updatedAt !== "string" || profile.updatedAt === "") {
    throw new Error("profile.updatedAt must be a non-empty ISO-8601 string");
  }
  await assertPeersRootNotSymlink(memoryDir);
  const dir = peerDir(memoryDir, profile.peerId);
  await fs.mkdir(dir, { recursive: true });
  await assertPeerDirNotEscaped(memoryDir, profile.peerId);
  const file = profilePath(memoryDir, profile.peerId);
  await assertPathNotSymlink(file);
  await fs.writeFile(file, emitPeerProfile(profile), "utf8");
}

/**
 * Read the raw interaction log for a peer.
 *
 * Returns the empty string if the log does not yet exist. Callers parse
 * the log themselves — this PR does not ship structured log parsing.
 * Exposed primarily so tests can verify monotonic append semantics.
 */
export async function readInteractionLogRaw(
  memoryDir: string,
  peerId: string,
): Promise<string> {
  assertValidPeerId(peerId);
  await assertPeerDirNotEscaped(memoryDir, peerId);
  const file = interactionsPath(memoryDir, peerId);
  await assertPathNotSymlink(file);
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw err;
  }
}
