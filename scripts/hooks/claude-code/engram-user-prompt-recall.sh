#!/usr/bin/env bash
# Claude Code UserPromptSubmit hook: recall Engram context for each user message.
# Uses the actual prompt text as the recall query (minimal mode, 20s).
# Injects memories as additionalContext before the turn. Skips short prompts.
#
# Required env vars:
#   OPENCLAW_ENGRAM_ACCESS_TOKEN  — bearer token for the Engram REST API
#
# Optional env vars:
#   ENGRAM_HOST  — defaults to 127.0.0.1
#   ENGRAM_PORT  — defaults to 4318

ENGRAM_HOST="${ENGRAM_HOST:-127.0.0.1}"
ENGRAM_PORT="${ENGRAM_PORT:-4318}"
ENGRAM_TOKEN="${OPENCLAW_ENGRAM_ACCESS_TOKEN:-}"
ENGRAM_URL="http://${ENGRAM_HOST}:${ENGRAM_PORT}/engram/v1/recall"

LOG="${HOME}/.claude/logs/engram-user-prompt-recall.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

INPUT="$(cat)"
SESSION_ID="$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null || echo "")"
PROMPT="$(echo "$INPUT"     | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('prompt',''))" 2>/dev/null || echo "")"
CWD="$(echo "$INPUT"        | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null || echo "")"
PROJECT_NAME="$(basename "$CWD" 2>/dev/null || echo "unknown")"

if [ -z "$ENGRAM_TOKEN" ]; then
  echo '{"continue":true}'
  exit 0
fi

# Skip very short prompts — not worth a round-trip
PROMPT_WORD_COUNT="$(echo "$PROMPT" | wc -w | tr -d ' ')"
if [ "$PROMPT_WORD_COUNT" -lt 4 ]; then
  echo '{"continue":true}'
  exit 0
fi

log "user-prompt-recall: session=$SESSION_ID project=$PROJECT_NAME words=$PROMPT_WORD_COUNT"

export ENGRAM_QUERY="$PROMPT"
export ENGRAM_SESSION_ID="$SESSION_ID"
REQUEST_BODY="$(python3 -c "
import json, os
print(json.dumps({
    'query': os.environ.get('ENGRAM_QUERY', ''),
    'sessionKey': os.environ.get('ENGRAM_SESSION_ID', ''),
    'topK': 8,
    'mode': 'minimal',
}))" 2>/dev/null)"

[ -z "$REQUEST_BODY" ] && echo '{"continue":true}' && exit 0

RAW="$(curl -s -w "\n%{http_code}" --max-time 20 \
  -X POST "$ENGRAM_URL" \
  -H "Authorization: Bearer ${ENGRAM_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$REQUEST_BODY" 2>/dev/null)"
CURL_EXIT=$?
HTTP_STATUS="$(echo "$RAW" | tail -1)"
RESPONSE="$(echo "$RAW" | sed '$d')"

if [ $CURL_EXIT -ne 0 ] || ! [[ "$HTTP_STATUS" =~ ^2 ]] || [ -z "$RESPONSE" ]; then
  log "recall failed (curl=$CURL_EXIT http=$HTTP_STATUS) — passing through"
  echo '{"continue":true}'
  exit 0
fi

python3 -c "
import json, sys
input_data = sys.stdin.read()
try:
    d = json.loads(input_data)
    ctx = d.get('context', '')
    count = d.get('count', 0)
    if not ctx or count == 0:
        print(json.dumps({'continue': True}))
        sys.exit(0)
    context_block = f'<engram-memory count=\"{count}\">\n{ctx}\n</engram-memory>'
    print(json.dumps({
        'continue': True,
        'hookSpecificOutput': {
            'hookEventName': 'UserPromptSubmit',
            'additionalContext': context_block,
        }
    }))
except Exception:
    print(json.dumps({'continue': True}))
" <<< "$RESPONSE"

COUNT="$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('count',0))" 2>/dev/null || echo "?")"
log "recall done: ${COUNT} memories injected"
