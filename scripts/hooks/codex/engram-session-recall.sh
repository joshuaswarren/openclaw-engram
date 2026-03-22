#!/usr/bin/env bash
# Codex SessionStart hook: recall Engram context at session start.
# Tries auto mode (full recall, 45s) then falls back to minimal mode (20s).
# Injects matched memories as additionalContext before the first turn.
#
# Required env vars:
#   OPENCLAW_ENGRAM_ACCESS_TOKEN  — bearer token for the Engram REST API
#
# Optional env vars:
#   ENGRAM_HOST  — defaults to 127.0.0.1 (set to your Engram server if Codex
#                  runs on a different machine than the gateway)
#   ENGRAM_PORT  — defaults to 4318

ENGRAM_HOST="${ENGRAM_HOST:-127.0.0.1}"
ENGRAM_PORT="${ENGRAM_PORT:-4318}"
ENGRAM_TOKEN="${OPENCLAW_ENGRAM_ACCESS_TOKEN:-}"
ENGRAM_URL="http://${ENGRAM_HOST}:${ENGRAM_PORT}/engram/v1/recall"

LOG="${HOME}/.codex/logs/engram-session-recall.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

INPUT="$(cat)"
SESSION_ID="$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null || echo "")"
CWD="$(echo "$INPUT"        | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null || echo "")"
PROJECT_NAME="$(basename "$CWD" 2>/dev/null || echo "unknown")"

log "session-recall: session=$SESSION_ID project=$PROJECT_NAME"

if [ -z "$ENGRAM_TOKEN" ]; then
  log "skipping: OPENCLAW_ENGRAM_ACCESS_TOKEN not set"
  echo '{"continue":true,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[Engram: no OPENCLAW_ENGRAM_ACCESS_TOKEN set — skipping memory recall]"}}'
  exit 0
fi

QUERY="Starting a new coding session in project: ${PROJECT_NAME}. Recall relevant memories, preferences, decisions, patterns, and context about this project and the user's coding style."
export ENGRAM_QUERY="$QUERY"
export ENGRAM_SESSION_ID="$SESSION_ID"

REQUEST_BODY="$(python3 -c "
import json, os
print(json.dumps({
    'query': os.environ.get('ENGRAM_QUERY', ''),
    'sessionKey': os.environ.get('ENGRAM_SESSION_ID', ''),
    'topK': 12,
    'mode': 'auto',
}))" 2>/dev/null)"

[ -z "$REQUEST_BODY" ] && echo '{"continue":true}' && exit 0

log "attempting full recall (auto mode)..."
RESPONSE="$(curl -s --max-time 45 \
  -X POST "$ENGRAM_URL" \
  -H "Authorization: Bearer ${ENGRAM_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$REQUEST_BODY" 2>/dev/null)"
CURL_EXIT=$?

if [ $CURL_EXIT -ne 0 ] || [ -z "$RESPONSE" ]; then
  log "full recall failed (curl exit $CURL_EXIT) — falling back to minimal mode"
  MINIMAL_BODY="$(python3 -c "
import json, os
print(json.dumps({
    'query': os.environ.get('ENGRAM_QUERY', ''),
    'sessionKey': os.environ.get('ENGRAM_SESSION_ID', ''),
    'topK': 8,
    'mode': 'minimal',
}))" 2>/dev/null)"
  RESPONSE="$(curl -s --max-time 20 \
    -X POST "$ENGRAM_URL" \
    -H "Authorization: Bearer ${ENGRAM_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${MINIMAL_BODY:-$REQUEST_BODY}" 2>/dev/null)"
  CURL_EXIT=$?
  [ $CURL_EXIT -eq 0 ] && log "minimal recall succeeded" || log "minimal recall also failed (curl exit $CURL_EXIT)"
fi

if [ $CURL_EXIT -eq 0 ] && [ -n "$RESPONSE" ]; then
  CONTEXT="$(echo "$RESPONSE" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    ctx = d.get('context', '')
    count = d.get('count', 0)
    mode = d.get('mode', '')
    if ctx:
        label = f'[Engram Memory Recall — {count} memories' + (f', {mode} mode' if mode else '') + ']'
        print(f'{label}\n\n{ctx}')
    else:
        print('[Engram: no relevant memories found for this session]')
except Exception as e:
    print(f'[Engram: recall response parse error — {e}]')
" 2>/dev/null || echo "[Engram: recall failed]")"
  log "recall complete: $(echo "$CONTEXT" | head -1)"
else
  CONTEXT="[Engram: server unreachable (curl exit $CURL_EXIT) — continuing without memory recall]"
  log "$CONTEXT"
fi

python3 -c "
import json, sys
context = sys.stdin.read()
print(json.dumps({
    'continue': True,
    'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': context}
}))
" <<< "$CONTEXT"
