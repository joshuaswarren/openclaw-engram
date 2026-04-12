#!/usr/bin/env bash
# check-review-patterns.sh — Catch common issues that reviewers (Cursor Bugbot,
# Codex, CodeQL) repeatedly flagged across PRs #343-#408 (504+ review comments).
# Run this before pushing. Zero exit = clean.
# Updated: 2026-04-12 (added checks 7-10 from iteration 2, 11-14 from iteration 3, 15-17 from iteration 4).
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

# ---- 11. Cross-package relative imports (breaks package boundaries) ----
echo "[check] Cross-package relative imports..."

CROSS_PKG=$(grep -rn 'from "\.\./\.\./\.\./\.\./' \
  --include="*.ts" --include="*.js" --include="*.mjs" \
  packages/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  || true)

if [[ -n "$CROSS_PKG" ]]; then
  COUNT=$(echo "$CROSS_PKG" | wc -l | tr -d ' ')
  warn "$COUNT deep relative imports (4+ levels) in packages/ — likely bypassing package boundaries. Use package name imports instead:"
  echo "$CROSS_PKG" | head -10
fi

# ---- 12. slice(-expr) without zero guard ----
echo "[check] slice(-expr) without zero/negative guard..."

SLICE_NEG=$(grep -rn 'slice(-' \
  --include="*.ts" \
  . 2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  || true)

if [[ -n "$SLICE_NEG" ]]; then
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    LINENUM=$(echo "$line" | cut -d: -f2)
    # Check if surrounding context has a <= 0 or < 1 guard
    if ! sed -n "$((LINENUM > 3 ? LINENUM-3 : 1)),$((LINENUM+1))p" "$FILE" 2>/dev/null | grep -q "<= 0\|< 1\|=== 0\|!== 0\| > 0"; then
      warn "$FILE:$LINENUM — slice(-expr) without nearby zero guard. When expr is 0, slice(-0) returns ALL items."
    fi
  done <<< "$SLICE_NEG"
fi

# ---- 13. typeof === "number" on config values that may be strings ----
echo "[check] Fragile typeof === 'number' on persisted config values..."

TYPEOF_NUM=$(grep -rn 'typeof.*===.*"number"' \
  --include="*.ts" \
  packages/ \
  2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "isInteger\|Number(" \
  | grep -i "port\|config\|prev\|saved\|stored\|options\." \
  || true)

if [[ -n "$TYPEOF_NUM" ]]; then
  COUNT=$(echo "$TYPEOF_NUM" | wc -l | tr -d ' ')
  warn "$COUNT typeof === 'number' checks on config/port/prev values — CLI values arrive as strings. Consider coercing first:"
  echo "$TYPEOF_NUM" | head -5
fi

# ---- 14. Force flush / explicit operations missing skipDedupe ----
echo "[check] Explicit flush paths missing skipDedupeCheck..."

FLUSH_NO_SKIP=$(grep -rn 'flushSession\|forceFlush\|queueBufferedExtraction' \
  --include="*.ts" \
  . 2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -v "// " \
  || true)

if [[ -n "$FLUSH_NO_SKIP" ]]; then
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    LINENUM=$(echo "$line" | cut -d: -f2)
    # Check if this call or its function passes skipDedupeCheck
    if ! sed -n "$((LINENUM)),$((LINENUM+3))p" "$FILE" 2>/dev/null | grep -q "skipDedupeCheck\|skipDedupe"; then
      # Only warn for flush paths that look explicit (not auto-extraction)
      if echo "$line" | grep -qi "flush\|force\|reset\|replay"; then
        warn "$FILE:$LINENUM — flush/force/replay call without skipDedupeCheck. Explicit operations should bypass dedup."
      fi
    fi
  done <<< "$FLUSH_NO_SKIP"
fi

# ---- 15. Host-prefixed files in core package (architecture boundary) ----
echo "[check] Host-prefixed files in @remnic/core..."

HOST_PREFIXED=$(find packages/remnic-core/src -name "openclaw-*" -o -name "hermes-*" 2>/dev/null || true)

if [[ -n "$HOST_PREFIXED" ]]; then
  while IFS= read -r file; do
    warn "$file — host-prefixed file in @remnic/core violates architecture boundary. Use a generic name."
  done <<< "$HOST_PREFIXED"
fi

# ---- 16. indexOf in line parsers (position tracking) ----
echo "[check] indexOf usage in parser/position-tracking code..."

INDEXOF_PARSER=$(grep -rn '\.indexOf(' \
  --include="*.ts" \
  packages/remnic-core/src/surfaces/ packages/remnic-core/src/parsers/ \
  . 2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v ".test." \
  | grep -i "offset\|position\|source\|line\|parse\|block" \
  || true)

if [[ -n "$INDEXOF_PARSER" ]]; then
  COUNT=$(echo "$INDEXOF_PARSER" | wc -l | tr -d ' ')
  if [[ "$COUNT" -gt 0 ]]; then
    warn "$COUNT uses of indexOf in parser/position-tracking code — may return wrong position for duplicate lines. Track offset during iteration instead."
    echo "$INDEXOF_PARSER" | head -5
  fi
fi

# ---- 17. Test mocks with fewer parameters than production interface ----
echo "[check] Test mock signature fidelity..."

# Look for mock function definitions that might ignore parameters.
# Pattern: jest.fn(() => ...) or vi.fn(() => ...) where the function
# ignores its arguments in test files near interface implementations.
MOCK_NO_ARGS=$(grep -rn 'fn(()\s*=>\s*{' \
  --include="*.test.ts" \
  . 2>/dev/null \
  | grep -v node_modules \
  | grep -v dist \
  | grep -v "_\s*:" \
  || true)

if [[ -n "$MOCK_NO_ARGS" ]]; then
  # Only warn if the production interface nearby takes arguments
  while IFS= read -r line; do
    FILE=$(echo "$line" | cut -d: -f1)
    # Check if the same file references a runtime interface that takes arguments
    if grep -q "getLastRecall\|getSession\|getBuffer\|getRecall" "$FILE" 2>/dev/null; then
      # Check if any mock in the file accepts parameters
      if ! grep -q 'fn((.*:.*)\s*=>' "$FILE" 2>/dev/null; then
        warn "$FILE — contains zero-argument mocks for functions that take parameters in production. Verify mock signatures match."
        break
      fi
    fi
  done <<< "$MOCK_NO_ARGS"
fi
if [[ $ERRORS -gt 0 ]]; then
  echo "[check] FAILED — $ERRORS issue(s) found. Fix before pushing."
  exit 1
else
  echo "[check] PASSED — no review-pattern issues detected"
  exit 0
fi
