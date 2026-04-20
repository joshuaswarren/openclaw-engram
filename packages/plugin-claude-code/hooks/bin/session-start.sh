#!/usr/bin/env bash
# Remnic SessionStart hook for Claude Code.
# Recalls project context and user preferences at session start.
# Tries auto mode (45s) then falls back to minimal mode (20s).
# Starts daemon if not running.

set -euo pipefail

ensure_migrated() {
  if [ -f "${HOME}/.remnic/.migrated-from-engram" ]; then
    return 0
  fi
  if [ ! -d "${HOME}/.engram" ] && [ ! -f "${HOME}/.config/engram/config.json" ]; then
    return 0
  fi
  if command -v remnic >/dev/null 2>&1; then
    remnic migrate >/dev/null 2>&1 || true
  elif command -v engram >/dev/null 2>&1; then
    engram migrate >/dev/null 2>&1 || true
  fi
}

ensure_migrated

REMNIC_HOST="${REMNIC_HOST:-${ENGRAM_HOST:-127.0.0.1}}"
REMNIC_PORT="${REMNIC_PORT:-${ENGRAM_PORT:-4318}}"
REMNIC_URL="http://${REMNIC_HOST}:${REMNIC_PORT}/engram/v1/recall"
REMNIC_HEALTH_URL="http://${REMNIC_HOST}:${REMNIC_PORT}/engram/v1/health"
TOKEN_FILES=("${HOME}/.remnic/tokens.json" "${HOME}/.engram/tokens.json")

LOG="${HOME}/.remnic/logs/remnic-session-recall.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') [session-start] $*" >> "$LOG"; }

# Read token from per-plugin token store
REMNIC_TOKEN=""
for TOKEN_FILE in "${TOKEN_FILES[@]}"; do
  [ ! -f "$TOKEN_FILE" ] && continue
  REMNIC_TOKEN="$(node -e "
    const store = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
    const tokens = store.tokens || [];
    const cc = tokens.find(t => t.connector === 'claude-code');
    const oc = tokens.find(t => t.connector === 'openclaw');
    let tok = (cc && cc.token) || (oc && oc.token) || '';
    if (!tok) { tok = store['claude-code'] || store['openclaw'] || ''; }
    process.stdout.write(tok);
  " "$TOKEN_FILE" 2>/dev/null || echo "")"
  [ -n "$REMNIC_TOKEN" ] && break
done

# Fallback to env var
[ -z "$REMNIC_TOKEN" ] && REMNIC_TOKEN="${OPENCLAW_REMNIC_ACCESS_TOKEN:-${OPENCLAW_ENGRAM_ACCESS_TOKEN:-}}"

INPUT="$(cat)"
SESSION_ID="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.session_id||'')" "$INPUT" 2>/dev/null || echo "")"
CWD="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.cwd||'')" "$INPUT" 2>/dev/null || echo "")"
PROJECT_NAME="$(basename "$CWD" 2>/dev/null || echo "unknown")"

# Resolve git context for the session's cwd (issue #569 PR 5). Produces
# either a JSON object for the `codingContext` field, or an empty string
# when the cwd is not inside a git repo. All git calls are wrapped in &&
# so any failure silently drops back to no-context.
CODING_CONTEXT_JSON=""
if [ -n "$CWD" ] && [ -d "$CWD" ] && command -v git >/dev/null 2>&1; then
  # `git` calls are short-timeout and local. Any failure → empty.
  REMNIC_GIT_TOP="$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || echo "")"
  if [ -n "$REMNIC_GIT_TOP" ]; then
    REMNIC_GIT_BRANCH="$(git -C "$REMNIC_GIT_TOP" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")"
    [ "$REMNIC_GIT_BRANCH" = "HEAD" ] && REMNIC_GIT_BRANCH=""
    REMNIC_GIT_ORIGIN="$(git -C "$REMNIC_GIT_TOP" remote get-url origin 2>/dev/null || echo "")"
    REMNIC_GIT_DEFAULT_BRANCH="$(git -C "$REMNIC_GIT_TOP" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null | sed 's|^refs/remotes/origin/||' || echo "")"
    CODING_CONTEXT_JSON="$(REMNIC_GIT_TOP="$REMNIC_GIT_TOP" REMNIC_GIT_BRANCH="$REMNIC_GIT_BRANCH" REMNIC_GIT_ORIGIN="$REMNIC_GIT_ORIGIN" REMNIC_GIT_DEFAULT_BRANCH="$REMNIC_GIT_DEFAULT_BRANCH" node -e "
      // Mirror the pure logic from @remnic/core's resolveGitContext so the
      // hook produces the same projectId without calling into the daemon
      // first. FNV-1a 32-bit stable hash.
      const rootPath = process.env.REMNIC_GIT_TOP || '';
      const branch = process.env.REMNIC_GIT_BRANCH || null;
      const origin = process.env.REMNIC_GIT_ORIGIN || '';
      const defaultBranch = process.env.REMNIC_GIT_DEFAULT_BRANCH || null;
      function stableHash(input) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < input.length; i++) {
          hash ^= input.charCodeAt(i);
          hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash.toString(16).padStart(8, '0');
      }
      function normalizeOriginUrl(raw) {
        let u = (raw || '').trim();
        if (!u) return '';
        if (u.endsWith('.git')) u = u.slice(0, -4);
        const proto = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\\d+)?(\\/.*)?\$/i.exec(u);
        if (proto) {
          const host = proto[1] || '';
          const p = (proto[2] || '').replace(/^\\/+/, '');
          return (host + '/' + p).toLowerCase();
        }
        const scp = /^([^@\\s\\/]+)@([^:@\\s\\/]+):(.+)\$/.exec(u);
        if (scp) {
          const host = scp[2] || '';
          const p = (scp[3] || '').replace(/^\\/+/, '');
          return (host + '/' + p).toLowerCase();
        }
        return u.toLowerCase();
      }
      const normalized = normalizeOriginUrl(origin);
      const projectId = normalized ? 'origin:' + stableHash(normalized) : 'root:' + stableHash(rootPath);
      process.stdout.write(JSON.stringify({
        projectId,
        branch: branch || null,
        rootPath,
        defaultBranch: defaultBranch || null,
      }));
    " 2>/dev/null || echo "")"
  fi
fi

log "session=$SESSION_ID project=$PROJECT_NAME coding-context=${CODING_CONTEXT_JSON:+yes}"

# Health check — start daemon if not running
if ! curl -sf --max-time 2 "$REMNIC_HEALTH_URL" >/dev/null 2>&1; then
  log "daemon not responding, attempting start..."
  if command -v remnic >/dev/null 2>&1; then
    remnic daemon start >/dev/null 2>&1 &
  elif command -v engram >/dev/null 2>&1; then
    engram daemon start >/dev/null 2>&1 &
  fi
  sleep 2
  if ! curl -sf --max-time 2 "$REMNIC_HEALTH_URL" >/dev/null 2>&1; then
    log "daemon still not responding after start attempt"
    echo '{"continue":true,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[Remnic: daemon not running — start with: remnic daemon start]"}}'
    exit 0
  fi
fi

if [ -z "$REMNIC_TOKEN" ]; then
  log "skipping: no token found"
  echo '{"continue":true,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[Remnic: no auth token — run: remnic connectors install claude-code]"}}'
  exit 0
fi

QUERY="Starting a new coding session in project: ${PROJECT_NAME}. Recall relevant memories, preferences, decisions, patterns, and context about this project and the user."

REQUEST_BODY="$(REMNIC_CODING_CONTEXT_JSON="$CODING_CONTEXT_JSON" node -e "
  const body = {
    query: process.argv[1],
    sessionKey: process.argv[2],
    topK: 12,
    mode: 'auto',
  };
  const raw = process.env.REMNIC_CODING_CONTEXT_JSON || '';
  if (raw) {
    try { body.codingContext = JSON.parse(raw); } catch (_) { /* ignore */ }
  }
  process.stdout.write(JSON.stringify(body));
" "$QUERY" "$SESSION_ID" 2>/dev/null)"

[ -z "$REQUEST_BODY" ] && echo '{"continue":true}' && exit 0

log "attempting full recall (auto mode)..."
RAW="$(curl -s -w "\n%{http_code}" --max-time 45 \
  -X POST "$REMNIC_URL" \
  -H "Authorization: Bearer ${REMNIC_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Engram-Client-Id: claude-code" \
  -d "$REQUEST_BODY" 2>/dev/null)"
CURL_EXIT=$?
HTTP_STATUS="$(echo "$RAW" | tail -1)"
RESPONSE="$(echo "$RAW" | sed '$d')"

if [ $CURL_EXIT -ne 0 ] || ! [[ "$HTTP_STATUS" =~ ^2 ]] || [ -z "$RESPONSE" ]; then
  log "full recall failed (curl=$CURL_EXIT http=$HTTP_STATUS) — falling back to minimal"
  MINIMAL_BODY="$(REMNIC_CODING_CONTEXT_JSON="$CODING_CONTEXT_JSON" node -e "
    const body = {
      query: process.argv[1],
      sessionKey: process.argv[2],
      topK: 8,
      mode: 'minimal',
    };
    const raw = process.env.REMNIC_CODING_CONTEXT_JSON || '';
    if (raw) {
      try { body.codingContext = JSON.parse(raw); } catch (_) { /* ignore */ }
    }
    process.stdout.write(JSON.stringify(body));
  " "$QUERY" "$SESSION_ID" 2>/dev/null)"
  RAW="$(curl -s -w "\n%{http_code}" --max-time 20 \
    -X POST "$REMNIC_URL" \
    -H "Authorization: Bearer ${REMNIC_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "X-Engram-Client-Id: claude-code" \
    -d "${MINIMAL_BODY:-$REQUEST_BODY}" 2>/dev/null)"
  CURL_EXIT=$?
  HTTP_STATUS="$(echo "$RAW" | tail -1)"
  RESPONSE="$(echo "$RAW" | sed '$d')"
  [[ "$CURL_EXIT" -eq 0 && "$HTTP_STATUS" =~ ^2 ]] && log "minimal recall succeeded" || { log "minimal recall also failed"; CURL_EXIT=1; }
fi

if [ $CURL_EXIT -eq 0 ] && [[ "$HTTP_STATUS" =~ ^2 ]] && [ -n "$RESPONSE" ]; then
  CONTEXT="$(node -e "
    const d = JSON.parse(process.argv[1]);
    const ctx = d.context || '';
    const count = d.count || 0;
    const mode = d.mode || '';
    if (ctx) {
      const label = '[Remnic Memory Recall — ' + count + ' memories' + (mode ? ', ' + mode + ' mode' : '') + ']';
      process.stdout.write(label + '\n\n' + ctx);
    } else {
      process.stdout.write('[Remnic: no relevant memories found for this session]');
    }
  " "$RESPONSE" 2>/dev/null || echo "[Remnic: recall parse error]")"
  log "recall complete: $(echo "$CONTEXT" | head -1)"
else
  CONTEXT="[Remnic: server unreachable — continuing without memory recall]"
  log "$CONTEXT"
fi

node -e "
  const context = process.argv[1];
  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context }
  }));
" "$CONTEXT"
