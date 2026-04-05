#!/usr/bin/env bash
# Engram SessionStart hook for Claude Code.
# Recalls project context and user preferences at session start.
# Tries auto mode (45s) then falls back to minimal mode (20s).
# Starts daemon if not running.

set -euo pipefail

ENGRAM_HOST="${ENGRAM_HOST:-127.0.0.1}"
ENGRAM_PORT="${ENGRAM_PORT:-4318}"
ENGRAM_URL="http://${ENGRAM_HOST}:${ENGRAM_PORT}/engram/v1/recall"
TOKEN_FILE="${HOME}/.engram/tokens.json"

LOG="${HOME}/.engram/logs/engram-session-recall.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') [session-start] $*" >> "$LOG"; }

# Read token from per-plugin token store
ENGRAM_TOKEN=""
if [ -f "$TOKEN_FILE" ]; then
  ENGRAM_TOKEN="$(node -e "
    const t = JSON.parse(require('fs').readFileSync('$TOKEN_FILE','utf8'));
    process.stdout.write(t['claude-code'] || t['openclaw'] || '');
  " 2>/dev/null || echo "")"
fi

# Fallback to env var
[ -z "$ENGRAM_TOKEN" ] && ENGRAM_TOKEN="${OPENCLAW_ENGRAM_ACCESS_TOKEN:-}"

INPUT="$(cat)"
SESSION_ID="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.session_id||'')" "$INPUT" 2>/dev/null || echo "")"
CWD="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.cwd||'')" "$INPUT" 2>/dev/null || echo "")"
PROJECT_NAME="$(basename "$CWD" 2>/dev/null || echo "unknown")"

log "session=$SESSION_ID project=$PROJECT_NAME"

# Health check — start daemon if not running
if ! curl -sf --max-time 2 "http://${ENGRAM_HOST}:${ENGRAM_PORT}/engram/v1/health" >/dev/null 2>&1; then
  log "daemon not responding, attempting start..."
  command -v engram >/dev/null 2>&1 && engram daemon start >/dev/null 2>&1 &
  sleep 2
  if ! curl -sf --max-time 2 "http://${ENGRAM_HOST}:${ENGRAM_PORT}/engram/v1/health" >/dev/null 2>&1; then
    log "daemon still not responding after start attempt"
    echo '{"continue":true,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[Engram: daemon not running — start with: engram daemon start]"}}'
    exit 0
  fi
fi

if [ -z "$ENGRAM_TOKEN" ]; then
  log "skipping: no token found"
  echo '{"continue":true,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[Engram: no auth token — run: engram connectors install claude-code]"}}'
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
  -X POST "$ENGRAM_URL" \
  -H "Authorization: Bearer ${ENGRAM_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Engram-Client-Id: claude-code" \
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
    -X POST "$ENGRAM_URL" \
    -H "Authorization: Bearer ${ENGRAM_TOKEN}" \
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
      const label = '[Engram Memory Recall — ' + count + ' memories' + (mode ? ', ' + mode + ' mode' : '') + ']';
      process.stdout.write(label + '\n\n' + ctx);
    } else {
      process.stdout.write('[Engram: no relevant memories found for this session]');
    }
  " "$RESPONSE" 2>/dev/null || echo "[Engram: recall parse error]")"
  log "recall complete: $(echo "$CONTEXT" | head -1)"
else
  CONTEXT="[Engram: server unreachable — continuing without memory recall]"
  log "$CONTEXT"
fi

node -e "
  const context = process.argv[1];
  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context }
  }));
" "$CONTEXT"
