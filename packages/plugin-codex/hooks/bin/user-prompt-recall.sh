#!/usr/bin/env bash
# Engram UserPromptSubmit hook for Codex.
# Recalls per-prompt context using the user's message as query.
# Skips short prompts (<4 words). Minimal mode, 20s timeout.

set -euo pipefail

ENGRAM_HOST="${ENGRAM_HOST:-127.0.0.1}"
ENGRAM_PORT="${ENGRAM_PORT:-4318}"
ENGRAM_URL="http://${ENGRAM_HOST}:${ENGRAM_PORT}/engram/v1/recall"
TOKEN_FILE="${HOME}/.engram/tokens.json"

LOG="${HOME}/.engram/logs/engram-user-prompt-recall.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') [codex-user-prompt] $*" >> "$LOG"; }

# Read token
ENGRAM_TOKEN=""
if [ -f "$TOKEN_FILE" ]; then
  ENGRAM_TOKEN="$(node -e "
    const store = JSON.parse(require('fs').readFileSync('$TOKEN_FILE','utf8'));
    const tokens = store.tokens || [];
    const cx = tokens.find(t => t.connector === 'codex');
    const oc = tokens.find(t => t.connector === 'openclaw');
    let tok = (cx && cx.token) || (oc && oc.token) || '';
    if (!tok) { tok = store['codex'] || store['openclaw'] || ''; }
    process.stdout.write(tok);
  " 2>/dev/null || echo "")"
fi
[ -z "$ENGRAM_TOKEN" ] && ENGRAM_TOKEN="${OPENCLAW_ENGRAM_ACCESS_TOKEN:-}"

INPUT="$(cat)"

if [ -z "$ENGRAM_TOKEN" ]; then
  echo '{"continue":true}'
  exit 0
fi

SESSION_ID="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.session_id||'')" "$INPUT" 2>/dev/null || echo "")"
PROMPT="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.prompt||'')" "$INPUT" 2>/dev/null || echo "")"

# Skip very short prompts
WORD_COUNT="$(echo "$PROMPT" | wc -w | tr -d ' ')"
if [ "$WORD_COUNT" -lt 4 ]; then
  echo '{"continue":true}'
  exit 0
fi

log "session=$SESSION_ID words=$WORD_COUNT"

REQUEST_BODY="$(node -e "process.stdout.write(JSON.stringify({
  query: process.argv[1],
  sessionKey: process.argv[2],
  topK: 8,
  mode: 'minimal'
}))" "$PROMPT" "$SESSION_ID" 2>/dev/null)"

[ -z "$REQUEST_BODY" ] && echo '{"continue":true}' && exit 0

RAW="$(curl -s -w "\n%{http_code}" --max-time 20 \
  -X POST "$ENGRAM_URL" \
  -H "Authorization: Bearer ${ENGRAM_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Engram-Client-Id: codex" \
  -d "$REQUEST_BODY" 2>/dev/null)"
CURL_EXIT=$?
HTTP_STATUS="$(echo "$RAW" | tail -1)"
RESPONSE="$(echo "$RAW" | sed '$d')"

if [ $CURL_EXIT -ne 0 ] || ! [[ "$HTTP_STATUS" =~ ^2 ]] || [ -z "$RESPONSE" ]; then
  log "recall failed (curl=$CURL_EXIT http=$HTTP_STATUS)"
  echo '{"continue":true}'
  exit 0
fi

node -e "
  const d = JSON.parse(process.argv[1]);
  const ctx = d.context || '';
  const count = d.count || 0;
  if (!ctx || count === 0) {
    process.stdout.write(JSON.stringify({continue: true}));
  } else {
    process.stdout.write(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: '<engram-memory count=\"' + count + '\">\n' + ctx + '\n</engram-memory>'
      }
    }));
  }
" "$RESPONSE" 2>/dev/null || echo '{"continue":true}'

COUNT="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(String(d.count||0))" "$RESPONSE" 2>/dev/null || echo "?")"
log "done: ${COUNT} memories injected"
