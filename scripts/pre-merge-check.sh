#!/usr/bin/env bash
set -euo pipefail

# Pre-merge guard: ensures AI reviewers have posted and all threads are resolved.
#
# Usage: scripts/pre-merge-check.sh <PR_NUMBER>
#
# Why this exists: PRs were being merged seconds after creation, before
# cursor[bot] and chatgpt-codex-connector[bot] had time to post reviews.
# This script blocks merging until reviewers have weighed in and all
# threads are resolved.

PR_NUMBER="${1:?Usage: scripts/pre-merge-check.sh <PR_NUMBER>}"
REPO="${REMNIC_REPO:-joshuaswarren/remnic}"
MIN_REVIEW_THREADS="${MIN_REVIEW_THREADS:-0}"
REQUIRED_REVIEWERS=("cursor[bot]" "chatgpt-codex-connector[bot]")

echo "[pre-merge] Checking PR #${PR_NUMBER} on ${REPO}..."

# 1. Check for unresolved review threads
UNRESOLVED=$(gh api graphql \
  -f query='query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          totalCount
          nodes { isResolved }
        }
      }
    }
  }' \
  -f owner="${REPO%%/*}" \
  -f name="${REPO##*/}" \
  -F pr="$PR_NUMBER" \
  --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length' \
  2>/dev/null)

TOTAL_THREADS=$(gh api graphql \
  -f query='query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) { totalCount }
      }
    }
  }' \
  -f owner="${REPO%%/*}" \
  -f name="${REPO##*/}" \
  -F pr="$PR_NUMBER" \
  --jq '.data.repository.pullRequest.reviewThreads.totalCount' \
  2>/dev/null)

echo "[pre-merge] Review threads: ${TOTAL_THREADS} total, ${UNRESOLVED} unresolved"

if [[ "$UNRESOLVED" -gt 0 ]]; then
  echo "[pre-merge] BLOCKED: ${UNRESOLVED} unresolved review thread(s). Resolve before merging."
  exit 1
fi

# 2. Check that AI reviewers have actually posted
REVIEWS=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" --jq '.[].user.login' 2>/dev/null || echo "")
COMMENTS=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/comments" --paginate --jq '.[].user.login' 2>/dev/null || echo "")
ALL_REVIEWERS=$(printf '%s\n%s' "$REVIEWS" "$COMMENTS" | sort -u)

MISSING_REVIEWERS=()
for reviewer in "${REQUIRED_REVIEWERS[@]}"; do
  if ! echo "$ALL_REVIEWERS" | grep -qF "$reviewer"; then
    MISSING_REVIEWERS+=("$reviewer")
  fi
done

if [[ ${#MISSING_REVIEWERS[@]} -gt 0 ]]; then
  echo "[pre-merge] BLOCKED: Missing reviews from: ${MISSING_REVIEWERS[*]}"
  echo "[pre-merge] AI reviewers need time to analyze the diff. Wait 2-5 minutes after PR creation."
  exit 1
fi

echo "[pre-merge] OK: All reviewers posted, 0 unresolved threads. Safe to merge."
