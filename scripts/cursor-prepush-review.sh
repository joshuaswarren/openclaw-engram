#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "${SKIP_CURSOR_PREPUSH:-0}" == "1" ]]; then
  echo "[cursor-review] skipped (SKIP_CURSOR_PREPUSH=1)"
  exit 0
fi

if ! command -v cursor-agent >/dev/null 2>&1; then
  echo "[cursor-review] skipped (cursor-agent not installed)"
  exit 0
fi

BASE_REF="${CURSOR_PREPUSH_BASE_REF:-origin/main}"
if git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  BASE_SHA="$(git merge-base HEAD "$BASE_REF")"
else
  BASE_SHA="$(git rev-parse HEAD~1 2>/dev/null || git rev-parse HEAD)"
fi

CHANGED_FILES="$(git diff --name-only "$BASE_SHA"...HEAD)"
if [[ -z "$CHANGED_FILES" ]]; then
  echo "[cursor-review] no changed files against $BASE_SHA; skipping"
  exit 0
fi

PROMPT_FILE="$(mktemp)"
OUTPUT_FILE="$(mktemp)"
ERROR_FILE="$(mktemp)"
cleanup() {
  rm -f "$PROMPT_FILE" "$OUTPUT_FILE" "$ERROR_FILE"
}
trap cleanup EXIT

cat >"$PROMPT_FILE" <<EOF
You are reviewing a git diff for potential defects before push.

Repository: $(basename "$ROOT_DIR")
Base commit: $BASE_SHA
Head commit: $(git rev-parse HEAD)

Changed files:
$CHANGED_FILES

Use repository context and git history as needed.
Focus on bug-finding only (logic errors, regressions, runtime failures, security issues, data loss, race conditions, broken assumptions).
Do not report style, naming, formatting, or optional refactors.

Output format (strict):
- If no issues: output exactly "NO_ISSUES_FOUND"
- Otherwise output one finding per line with this format:
  SEVERITY|path:line|title|why it is a real bug
  where SEVERITY is one of CRITICAL,HIGH,MEDIUM,LOW
EOF

CURSOR_MODEL="${CURSOR_PREPUSH_MODEL:-auto}"
echo "[cursor-review] running cursor-agent --model $CURSOR_MODEL"

if ! cursor-agent --print --output-format text --model "$CURSOR_MODEL" "$(cat "$PROMPT_FILE")" >"$OUTPUT_FILE" 2>"$ERROR_FILE"; then
  echo "[cursor-review] unavailable (command failed); skipping"
  if [[ -s "$ERROR_FILE" ]]; then
    sed 's/^/[cursor-review] /' "$ERROR_FILE"
  fi
  exit 0
fi

if grep -Eq '^NO_ISSUES_FOUND$' "$OUTPUT_FILE"; then
  echo "[cursor-review] no issues found"
  exit 0
fi

if grep -Eq '^(CRITICAL|HIGH|MEDIUM|LOW)\|' "$OUTPUT_FILE"; then
  echo "[cursor-review] potential issues detected:"
  sed 's/^/[cursor-review] /' "$OUTPUT_FILE"
  echo "[cursor-review] block push; resolve issues or bypass with SKIP_CURSOR_PREPUSH=1"
  exit 1
fi

echo "[cursor-review] unparseable response; treating as advisory and continuing"
sed 's/^/[cursor-review] /' "$OUTPUT_FILE"
exit 0
