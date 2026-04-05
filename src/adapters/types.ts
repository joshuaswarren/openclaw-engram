/**
 * Adapter interface for external system identity resolution.
 *
 * Each adapter maps an external system's session/identity conventions
 * to Engram's namespace + principal model. Adapters are stateless and
 * lightweight — they don't manage lifecycles or load plugins.
 */

export interface AdapterContext {
  /** Raw HTTP headers from the incoming request */
  headers: Record<string, string | string[] | undefined>;
  /** MCP client info (from initialize handshake, if available) */
  clientInfo?: { name: string; version?: string };
  /** Explicit session key from request args */
  sessionKey?: string;
}

export interface ResolvedIdentity {
  /** Engram namespace (scopes memory access) */
  namespace: string;
  /** Engram principal (authorization subject) */
  principal: string;
  /** Session key for continuity tracking */
  sessionKey?: string;
  /** Which adapter resolved this identity */
  adapterId: string;
}

export interface EngramAdapter {
  /** Adapter identifier (e.g., "claude-code", "codex", "hermes", "replit") */
  readonly id: string;

  /** Whether this adapter recognizes the given request context */
  matches(context: AdapterContext): boolean;

  /** Map external session/identity to Engram namespace + principal */
  resolveIdentity(context: AdapterContext): ResolvedIdentity;
}
