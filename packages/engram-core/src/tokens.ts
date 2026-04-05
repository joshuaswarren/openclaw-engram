/**
 * Token management for Engram multi-connector auth.
 *
 * Manages per-connector tokens in ~/.engram/tokens.json.
 * Each connector gets a unique token with a recognizable prefix.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface TokenEntry {
  token: string;
  connector: string;
  createdAt: string;
}

export interface TokenStore {
  tokens: TokenEntry[];
}

const TOKEN_PREFIXES: Record<string, string> = {
  "openclaw": "engram_oc_",
  "claude-code": "engram_cc_",
  "codex": "engram_cx_",
  "hermes": "engram_hm_",
  "replit": "engram_rl_",
  "cursor": "engram_cu_",
  "cline": "engram_cl_",
  "github-copilot": "engram_gh_",
  "roo-code": "engram_rc_",
  "windsurf": "engram_ws_",
  "amp": "engram_am_",
  "generic-mcp": "engram_gm_",
};

function defaultTokensPath(): string {
  return path.join(process.env.HOME ?? "~", ".engram", "tokens.json");
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export function loadTokenStore(tokensPath?: string): TokenStore {
  const p = tokensPath ?? defaultTokensPath();
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (Array.isArray(raw.tokens)) {
      return { tokens: raw.tokens };
    }
    // Migrate legacy flat-map format: { "connector": "token_value", ... }
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const migrated: TokenEntry[] = [];
      for (const [key, value] of Object.entries(raw)) {
        if (key === "tokens") continue; // skip if tokens key exists but isn't array
        if (typeof value === "string" && value.length > 0) {
          migrated.push({ token: value, connector: key, createdAt: new Date().toISOString() });
        }
      }
      if (migrated.length > 0) {
        const store: TokenStore = { tokens: migrated };
        // Auto-migrate: rewrite in new format (best-effort, don't lose tokens on write failure)
        try {
          saveTokenStore(store, tokensPath);
        } catch {
          // Migration write failed (e.g., read-only fs) — still return parsed tokens
        }
        return store;
      }
    }
    return { tokens: [] };
  } catch {
    return { tokens: [] };
  }
}

export function saveTokenStore(store: TokenStore, tokensPath?: string): void {
  const p = tokensPath ?? defaultTokensPath();
  ensureDir(p);
  fs.writeFileSync(p, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}

export function generateToken(connector: string, tokensPath?: string): TokenEntry {
  const store = loadTokenStore(tokensPath);

  // Remove existing token for this connector
  store.tokens = store.tokens.filter((t) => t.connector !== connector);

  const prefix = TOKEN_PREFIXES[connector] ?? "engram_xx_";
  const token = prefix + randomBytes(24).toString("hex");
  const entry: TokenEntry = {
    token,
    connector,
    createdAt: new Date().toISOString(),
  };
  store.tokens.push(entry);
  saveTokenStore(store, tokensPath);
  return entry;
}

export function listTokens(tokensPath?: string): TokenEntry[] {
  return loadTokenStore(tokensPath).tokens;
}

export function revokeToken(connector: string, tokensPath?: string): boolean {
  const store = loadTokenStore(tokensPath);
  const before = store.tokens.length;
  store.tokens = store.tokens.filter((t) => t.connector !== connector);
  if (store.tokens.length < before) {
    saveTokenStore(store, tokensPath);
    return true;
  }
  return false;
}

export function getAllValidTokens(tokensPath?: string): string[] {
  return loadTokenStore(tokensPath).tokens.map((t) => t.token);
}

export function resolveConnectorFromToken(token: string, tokensPath?: string): string | undefined {
  return loadTokenStore(tokensPath).tokens.find((t) => t.token === token)?.connector;
}
