#!/usr/bin/env bash
# Remnic SessionStart hook for Codex.
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
log() { echo "$(date '+%F %T') [codex-session-start] $*" >> "$LOG"; }

# Read token from per-plugin token store
REMNIC_TOKEN=""
for TOKEN_FILE in "${TOKEN_FILES[@]}"; do
  [ ! -f "$TOKEN_FILE" ] && continue
  REMNIC_TOKEN="$(node -e "
    const store = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
    const tokens = store.tokens || [];
    const cx = tokens.find(t => t.connector === 'codex');
    const oc = tokens.find(t => t.connector === 'openclaw');
    let tok = (cx && cx.token) || (oc && oc.token) || '';
    if (!tok) { tok = store['codex'] || store['openclaw'] || ''; }
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

log "session=$SESSION_ID project=$PROJECT_NAME"

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
  echo '{"continue":true,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[Remnic: no auth token — run: remnic connectors install codex]"}}'
  exit 0
fi

QUERY="Starting a new coding session in project: ${PROJECT_NAME}. Recall relevant memories, preferences, decisions, patterns, and context about this project and the user."

REQUEST_BODY="$(node -e "process.stdout.write(JSON.stringify({
  query: process.argv[1],
  sessionKey: process.argv[2],
  topK: 12,
  mode: 'auto'
}))" "$QUERY" "$SESSION_ID" 2>/dev/null)"

[ -z "$REQUEST_BODY" ] && echo '{"continue":true}' && exit 0

log "attempting full recall (auto mode)..."
RAW="$(curl -s -w "\n%{http_code}" --max-time 45 \
  -X POST "$REMNIC_URL" \
  -H "Authorization: Bearer ${REMNIC_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Engram-Client-Id: codex" \
  -d "$REQUEST_BODY" 2>/dev/null)"
CURL_EXIT=$?
HTTP_STATUS="$(echo "$RAW" | tail -1)"
RESPONSE="$(echo "$RAW" | sed '$d')"

if [ $CURL_EXIT -ne 0 ] || ! [[ "$HTTP_STATUS" =~ ^2 ]] || [ -z "$RESPONSE" ]; then
  log "full recall failed (curl=$CURL_EXIT http=$HTTP_STATUS) — falling back to minimal"
  MINIMAL_BODY="$(node -e "process.stdout.write(JSON.stringify({
    query: process.argv[1],
    sessionKey: process.argv[2],
    topK: 8,
    mode: 'minimal'
  }))" "$QUERY" "$SESSION_ID" 2>/dev/null)"
  RAW="$(curl -s -w "\n%{http_code}" --max-time 20 \
    -X POST "$REMNIC_URL" \
    -H "Authorization: Bearer ${REMNIC_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "X-Engram-Client-Id: codex" \
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
