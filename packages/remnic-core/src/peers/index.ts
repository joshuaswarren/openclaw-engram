/**
 * Peer registry — public barrel.
 *
 * Issue #679 PR 1/5 — schema + storage primitives only. The async profile
 * reasoner (PR 2/5), recall injection (PR 3/5), CLI/HTTP/MCP surfaces
 * (PR 4/5), and migration of existing identity-anchor data (PR 5) are
 * deferred.
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
  assertValidPeerId,
  readPeer,
  writePeer,
  listPeers,
  appendInteractionLog,
  readInteractionLogRaw,
  readPeerProfile,
  writePeerProfile,
} from "./storage.js";
