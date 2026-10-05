#!/usr/bin/env bash
# Usage: merge-upstream.sh <tag>
# Merges a fetched upstream release (refs/upstream/<tag>) into the current branch
# with a merge commit. Fork-owned files keep ours, and pyproject.toml takes
# upstream's side of any conflict, with the fork's fields applied again.
# Exit 0: committed. Exit 3: other conflicts, left unresolved. They are listed
# in $CONFLICTS_FILE (default conflicts.txt). Notes for the PR go in $NOTES_FILE.
set -euo pipefail

tag="$1"
ref="refs/upstream/${tag}"
here="$(dirname "$0")"
conflicts_file="${CONFLICTS_FILE:-conflicts.txt}"
notes_file="${NOTES_FILE:-notes.txt}"
: >"$conflicts_file"
: >"$notes_file"

# Includes upstream files the fork deleted, so they stay deleted
fork_owned=(
  README.md CONTRIBUTING.md Maintainers.md LICENSE LICENSE.upstream CONTRIBUTORS
  '.github/ISSUE_TEMPLATE*/**' .github/PULL_REQUEST_TEMPLATE.md
  .github/workflows/build.yml .github/workflows/release.yml
  .github/workflows/release-master.yml .github/workflows/release-nightly.yml
  .github/workflows/wiki.yml .github/workflows/issue-lockdown.yml
  .github/workflows/sanitize-comment.yml .github/workflows/label-handler.yml
)

is_fork_owned() {
  local pattern
  for pattern in "${fork_owned[@]}"; do
    # shellcheck disable=SC2053
    [[ $1 == $pattern ]] && return 0
  done
  return 1
}

# Resolves conflicting hunks with upstream's side and keeps the clean merges
take_theirs_on_conflict() {
  local dir
  dir="$(mktemp -d)"
  git show ":2:$1" >"$dir/ours"
  git show ":3:$1" >"$dir/theirs"
  git show ":1:$1" >"$dir/base" 2>/dev/null || : >"$dir/base"
  git merge-file --theirs "$dir/ours" "$dir/base" "$dir/theirs"
  cp "$dir/ours" "$1"
  rm -r "$dir"
}

if [ -z "$(git config user.email)" ]; then
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
fi

git merge --no-ff --no-commit "$ref" || true
unmerged="$(git diff --name-only --diff-filter=U)"
if [ -z "$unmerged" ] && ! git rev-parse -q --verify MERGE_HEAD >/dev/null; then
  echo "::error::git merge failed without conflicts"
  exit 1
fi

while IFS= read -r file; do
  [ -n "$file" ] || continue
  if is_fork_owned "$file"; then
    if git cat-file -e "HEAD:${file}" 2>/dev/null; then
      git checkout --ours -- "$file"
      git add -- "$file"
    else
      git rm -q -- "$file"
    fi
    echo "- ${file}: kept ours" >>"$notes_file"
  elif [ "$file" = pyproject.toml ]; then
    take_theirs_on_conflict pyproject.toml
    echo "- pyproject.toml: took upstream's and applied the fork's fields again" >>"$notes_file"
  else
    echo "$file" >>"$conflicts_file"
  fi
done <<<"$unmerged"

# Also for a clean merge, so the fork's fields never drift
if ! python3 "$here/fork-pyproject.py"; then
  echo pyproject.toml >>"$conflicts_file"
fi

if [ -s "$conflicts_file" ]; then
  sort -u -o "$conflicts_file" "$conflicts_file"
  exit 3
fi

node packages/yt-dlp-wasm/scripts/update-pins.mjs
git add pyproject.toml packages/yt-dlp-wasm/src/pins.json
# One merge commit, so review-bot can review it against the upstream parent
git commit -q -m "Merge yt-dlp ${tag}"
