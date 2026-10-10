#!/usr/bin/env bash
# Usage: arm-automerge.sh <pr> <squash|merge>. Needs GH_TOKEN and GH_REPO.
# Arms auto-merge only when the base branch has a ruleset that requires an
# approving review and status checks. Without them GitHub merges at once.
set -euo pipefail

pr="$1"
method="$2"

base="$(gh pr view "$pr" --json baseRefName --jq .baseRefName)"
rules="$(gh api "repos/${GH_REPO}/rules/branches/${base}")"

jq -e 'any(.[]; .type == "pull_request" and .parameters.required_approving_review_count >= 1)' <<<"$rules" >/dev/null \
  || { echo "::error::${base} does not require an approving review, so auto-merge would not wait for the review gate. Not arming."; exit 1; }
jq -e 'any(.[]; .type == "required_status_checks" and (.parameters.required_status_checks | length) > 0)' <<<"$rules" >/dev/null \
  || { echo "::error::${base} has no required status checks, so auto-merge would not wait for CI. Not arming."; exit 1; }

if [ "$(gh pr view "$pr" --json autoMergeRequest --jq '.autoMergeRequest != null')" = true ]; then
  echo "Auto-merge is already armed on #${pr}."
  exit 0
fi

gh pr merge "$pr" --auto "--${method}"
echo "Armed auto-merge (${method}) on #${pr}."
