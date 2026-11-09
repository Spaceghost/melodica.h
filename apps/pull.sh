#!/bin/sh
# Refresh apps/<dir> snapshots from their repositories. Usage: apps/pull.sh [dir...]
#
# Each snapshot is the full tree of the app's branch (git read-tree) minus the paths in
# apps.tsv's exclude column, replacing the previous
# one, with the source commit recorded in the commit message. Unlike `git subtree pull`
# this keeps working after the app's branch has been rebased onto its upstream.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean" >&2; exit 1; }
want="$*"
grep -v '^#' apps/apps.tsv | while IFS="$(printf '\t')" read -r dir repo branch _up _upbranch excl; do
  [ -n "$dir" ] || continue
  if [ -n "$want" ]; then case " $want " in *" $dir "*) ;; *) continue;; esac; fi
  echo "== apps/$dir <- $repo ($branch)"
  git fetch -q "https://github.com/$repo.git" "$branch"
  new=$(git rev-parse FETCH_HEAD)
  old=$(git log -1 --format=%B -- "apps/$dir" | sed -n 's/^Source-Commit: //p' | head -1)
  if [ "$old" = "$new" ]; then echo "   up to date ($new)"; continue; fi
  git rm -rq --ignore-unmatch "apps/$dir"
  git read-tree --prefix="apps/$dir/" -u FETCH_HEAD
  # Paths the app repository keeps private (apps.tsv column 6), e.g. melodica-web's site/.
  for p in $(printf '%s' "${excl:-}" | tr ',' ' '); do git rm -rq --ignore-unmatch "apps/$dir/$p"; done
  if git diff --cached --quiet; then echo "   tree unchanged ($new)"; continue; fi
  git commit -q -m "apps/$dir: snapshot of $repo $branch at ${new%????????????????????????????????}

Source-Repo: https://github.com/$repo
Source-Branch: $branch
Source-Commit: $new"
  echo "   $(git log -1 --format=%h) <- $new"
done
