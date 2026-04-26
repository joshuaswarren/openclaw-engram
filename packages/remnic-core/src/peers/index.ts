/**
 * Peer registry — public barrel.
 *
 * Issue #679 PR 1/5 — schema + storage primitives only.
 * Issue #679 PR 2/5 — async peer profile reasoner (re-exports
 * `runPeerProfileReasoner`; implementation in `./profile-reasoner.ts`).
 *
 * Recall injection (PR 3/5), CLI/HTTP/MCP surfaces (PR 4/5), and
 * migration of existing identity-anchor data (PR 5) are deferred.
 */

export type {
  Peer,
  PeerKind,
  PeerProfile,
  PeerProfileFieldProvenance,
  PeerInteractionLogEntry,
} from "./types.js";

export { PEER_ID_PATTERN, PEER_ID_MAX_LENGTH } from "./types.js";

export {
  PEERS_DIR_NAME,
  ALLOWED_PEER_KINDS,
  assertValidPeerId,
  readPeer,
  writePeer,
  deletePeer,
  listPeers,
  appendInteractionLog,
  readInteractionLogRaw,
  readPeerInteractionLog,
  readPeerProfile,
  writePeerProfile,
} from "./storage.js";

export {
  runPeerProfileReasoner,
  parsePeerProfileReasonerResponse,
  buildPeerProfileReasonerPrompt,
  type PeerProfileReasonerOptions,
  type PeerProfileReasonerResult,
  type PeerProfileReasonerPeerResult,
  type PeerProfileReasonerLlm,
  type PeerProfileReasonerProposal,
} from "./profile-reasoner.js";
