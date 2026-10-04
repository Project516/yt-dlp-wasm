#!/usr/bin/env bash
# Checks what SYNC_TOKEN can do and reports each permission in the job summary.
# Needs GH_TOKEN (the token under test), GH_REPO and GITHUB_RUN_ID, and a
# checkout whose origin the token can push to. Cleans up on every exit.
set -uo pipefail

branch="token-check/${GITHUB_RUN_ID}"
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
contents=FAIL
workflows=FAIL
pull_requests=FAIL
pr=""

cleanup() {
  [ -z "$pr" ] || gh pr close "$pr" >/dev/null 2>&1 || true
  git push origin --delete "$branch" >/dev/null 2>&1 || true
  {
    echo "### SYNC_TOKEN check"
    echo
    echo "| Permission | Proof | Result |"
    echo "| --- | --- | --- |"
    echo "| Contents: write | push a branch | ${contents} |"
    echo "| Workflows: write | push a change to a workflow file | ${workflows} |"
    echo "| Pull requests: write | open and close a draft PR | ${pull_requests} |"
  } >>"$summary"
}
trap cleanup EXIT

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git switch -q -c "$branch"

# [skip ci] keeps the temporary branch and PR from starting workflow runs
date -u >.github/sync/.token-check
git add .github/sync/.token-check
git commit -q -m "Check SYNC_TOKEN contents access [skip ci]"
if git push -q origin "$branch"; then contents=PASS; fi

echo "# token check ${GITHUB_RUN_ID}" >>.github/workflows/upstream-sync.yml
git commit -q -am "Check SYNC_TOKEN workflows access [skip ci]"
if git push -q origin "$branch"; then workflows=PASS; fi

if [ "$contents" = PASS ]; then
  if url="$(gh pr create --draft --base master --head "$branch" \
      --title "Check SYNC_TOKEN" --body "Temporary. Closed by the token check." 2>/dev/null)"; then
    pr="${url##*/}"
    gh pr close "$pr" >/dev/null 2>&1 && pull_requests=PASS
  fi
fi

[ "$contents$workflows$pull_requests" = PASSPASSPASS ] || { echo "::error::SYNC_TOKEN is missing a permission, see the job summary."; exit 1; }
