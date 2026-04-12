#!/usr/bin/env bash
# check-review-patterns.sh — Catch common issues that reviewers (Cursor Bugbot,
# Codex, CodeQL) repeatedly flagged across PRs #343-#408.
# Run this before pushing. Zero exit = clean.
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

echo ""
if [[ $ERRORS -gt 0 ]]; then
  echo "[check] FAILED — $ERRORS issue(s) found. Fix before pushing."
  exit 1
else
  echo "[check] PASSED — no review-pattern issues detected"
  exit 0
fi
