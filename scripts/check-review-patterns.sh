#!/usr/bin/env bash
# check-review-patterns.sh — Catch common issues that reviewers (Cursor Bugbot,
# Codex, CodeQL) repeatedly flagged across PRs #343-#408 (504+ review comments).
# Run this before pushing. Zero exit = clean.
# Updated: 2026-04-12 (added checks 7-10 from iteration 2 deep analysis).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ERRORS=0

warn() { echo "  WARN: $*"; }
fail() { echo "  FAIL: $*"; ERRORS=$((ERRORS + 1)); }

# ---- 1. Stale "engram" references in code (not in allowed legacy-fallback locations) ----
echo "[check] Stale 'engram' references outside legacy fallback paths..."

# Allow legitimate legacy references: migration code, legacy fallback chains,
# historical docs, changelog, and the rename plan doc.
STALE=$(grep -ri "engram" \
  --include="*.ts" --include="*.tsx" --include="*.js" --include="*.mjs" --include="*.cjs" \
  --include="*.json" --include="*.md" --include="*.sh" --include="*.py" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude="CHANGELOG.md" --exclude="RENAME.md" --exclude="package-lock.json" \
  --exclude="pnpm-lock.yaml" \
  -l . 2>/dev/null \
  | grep -v "from-engram" \
  | grep -v "migration" \
  | grep -v "migrate" \
  | grep -v "legacy" \
  | grep -v "shim-openclaw-engram" \
  | grep -v "CLAUDE.md" \
  | grep -v "AGENTS.md" \
  | grep -v "engram-adapter" \
  || true)

if [[ -n "$STALE" ]]; then
  # Check if the remaining references have legacy fallback context
  while IFS= read -r file; do
    # Count references - if more than a few, flag
    COUNT=$(grep -ci "engram" "$file" 2>/dev/null || true)
    if [[ "$COUNT" -gt 3 ]]; then
      warn "$file has $COUNT 'engram' references — verify these are intentional legacy fallbacks, not stale names"
    fi
  done <<< "$STALE"
else
  echo "  OK: No suspicious stale 'engram' references"
fi

# ---- 2. Shell command interpolation (security) ----
echo "[check] String interpolation in shell command construction..."

SHELL_INJECT=$(grep -rn '\${' \
  --include="*.ts" --include="*.js" \
  packages/remnic-core/src/connectors/ packages/remnic-cli/src/ \
  2>/dev/null \
  | grep -i -E "(exec|spawn|shell|command|script)" \
  | grep -v "process.env" \
  | grep -v "EnvironmentVariables" \
  | grep -v "// " \
  | grep -v "import.meta" \
  || true)

if [[ -n "$SHELL_INJECT" ]]; then
  warn "Potential shell interpolation in command construction:"
  echo "$SHELL_INJECT" | head -5
  echo "  → Use env vars instead of string interpolation for host/port/config values"
fi

# ---- 3. Duplicate helper detection ----
echo "[check] Duplicated utility functions across packages..."

for helper in "toolJsonResult" "parseConfig" "formatMemory"; do
  FILES=$(grep -rn "$helper" --include="*.ts" -l . 2>/dev/null \
    | grep -v node_modules \
    | grep -v ".test." \
    | grep -v dist \
    || true)
  COUNT=$(echo "$FILES" | grep -c "." 2>/dev/null || echo "0")
  if [[ "$COUNT" -gt 2 ]]; then
    warn "$helper defined in $COUNT files — consider extracting to shared utility:"
    echo "$FILES"
  fi
done

# ---- 4. Test quality: vacuous empty-array assertions ----
echo "[check] Vacuous empty-array test assertions..."

VACUOUS=$(grep -rn "toEqual(\[\])" --include="*.test.ts" . 2>/dev/null \
  | grep -v node_modules \
  | grep -v "// intentional" \
  || true)

if [[ -n "$VACUOUS" ]]; then
  COUNT=$(echo "$VACUOUS" | wc -l | tr -d ' ')
  warn "$COUNT tests assert .toEqual([]) — ensure these verify actual failure behavior, not vacuous passes:"
  echo "$VACUOUS" | head -5
fi

# ---- 5. Lock file sync check ----
echo "[check] Workspace dependency consistency..."

if command -v pnpm &>/dev/null; then
  # Check if pnpm-lock.yaml is stale
  LOCK_HASH=$(pnpm store files 2>/dev/null | head -1 || true)
  # Simple check: does running install change anything?
  DIFF=$(pnpm install --frozen-lockfile 2>&1 || true)
  if echo "$DIFF" | grep -q "ERR_PNPM_FROZEN_LOCKFILE"; then
    fail "pnpm-lock.yaml is out of sync — run 'pnpm install' and commit the updated lockfile"
  else
    echo "  OK: Lock file is in sync"
  fi
fi

# ---- 6. Missing resetGlobals cleanup in test files ----
echo "[check] Test teardown completeness..."

TEST_FILES=$(grep -rl "resetGlobals" --include="*.test.ts" . 2>/dev/null \
  | grep -v node_modules \
  || true)

# Check if any test file creates orchestrator instances but doesn't call resetGlobals
ORCH_TEST=$(grep -rl "Orchestrator\|orchestrator" --include="*.test.ts" . 2>/dev/null \
  | grep -v node_modules \
  || true)

if [[ -n "$ORCH_TEST" ]]; then
  while IFS= read -r file; do
    if ! grep -q "resetGlobals\|afterEach\|afterAll\|tearDown" "$file" 2>/dev/null; then
      warn "$file uses Orchestrator but has no resetGlobals/afterEach cleanup"
    fi
  done <<< "$ORCH_TEST"
fi

# ---- 7. Tilde path without expandTilde ----
echo "[check] Tilde path expansion consistency..."

# Look for .replace(/^~/ or similar ad-hoc tilde expansion that isn't expandTilde
TILDE_HACK=$(grep -rn '\.replace(/\\^~/' \
  --include="*.ts" --include="*.js" \
  . 2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v expandTilde \
  || true)

if [[ -n "$TILDE_HACK" ]]; then
  COUNT=$(echo "$TILDE_HACK" | wc -l | tr -d ' ')
  warn "$COUNT ad-hoc tilde expansions (not using expandTilde) — use expandTilde() instead:"
  echo "$TILDE_HACK" | head -5
fi

# ---- 8. Sort comparator never returns 0 ----
echo "[check] Sort comparator stability..."

# Look for comparators that return 1 for both directions (missing return 0)
BAD_SORT=$(grep -rn 'return 1' --include="*.ts" . 2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -i "sort" \
  || true)

if [[ -n "$BAD_SORT" ]]; then
  # Check if the file containing sort+return 1 ever returns 0 or -1
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    if ! grep -q "return 0\|return -1" "$FILE" 2>/dev/null; then
      warn "$FILE has sort logic with 'return 1' but no 'return 0' or 'return -1' — likely violates comparator contract"
    fi
  done <<< "$BAD_SORT"
fi

# ---- 9. JSON.parse without type validation ----
echo "[check] JSON.parse result validation..."

# Look for JSON.parse without subsequent type check
PARSE_NO_CHECK=$(grep -rn 'JSON.parse(' \
  --include="*.ts" \
  . 2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  || true)

if [[ -n "$PARSE_NO_CHECK" ]]; then
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    LINENUM=$(echo "$line" | cut -d: -f2)
    # Check if next few lines have typeof/null check
    if ! sed -n "$((LINENUM)),$((LINENUM+5))p" "$FILE" 2>/dev/null | grep -q "typeof\|!== null\|=== null\|!== undefined\|isPlainObject\|isValid"; then
      # Only warn for config/settings files
      if echo "$FILE" | grep -qi "config\|setting\|install\|doctor"; then
        warn "$FILE:$LINENUM — JSON.parse without subsequent type/null validation in config path"
      fi
    fi
  done <<< "$PARSE_NO_CHECK"
fi

# ---- 10. Duplicated slot resolution logic ----
echo "[check] Config resolution deduplication..."

SLOT_RESOLVE=$(grep -rn "slots.*memory\|slots\.memory\|LEGACY_PLUGIN_ID\|resolveRemnicPluginEntry" \
  --include="*.ts" --include="*.cjs" --include="*.mjs" \
  . 2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "import.*from\|export" \
  || true)

RESOLVE_FILES=$(echo "$SLOT_RESOLVE" | cut -d: -f1 | sort -u 2>/dev/null || true)
RESOLVE_COUNT=$(echo "$RESOLVE_FILES" | grep -c "." 2>/dev/null || echo "0")

if [[ "$RESOLVE_COUNT" -gt 3 ]]; then
  warn "Slot resolution logic found in $RESOLVE_COUNT files — should be deduplicated to single shared module:"
  echo "$RESOLVE_FILES"
fi
if [[ $ERRORS -gt 0 ]]; then
  echo "[check] FAILED — $ERRORS issue(s) found. Fix before pushing."
  exit 1
else
  echo "[check] PASSED — no review-pattern issues detected"
  exit 0
fi
