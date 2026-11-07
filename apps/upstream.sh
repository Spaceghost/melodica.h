#!/bin/sh
# Track each app's upstream project and rebase our melodica.h work on top of it.
#
#   apps/upstream.sh status [dir...]   how far each fork is ahead of / behind its upstream
#   apps/upstream.sh fetch  [dir...]   clone or update the work checkouts, fetch origin + upstream
#   apps/upstream.sh rebase <dir>      tag the current head, rebase our branch onto upstream
#   apps/upstream.sh push   <dir>      push the rebased branch (--force-with-lease) and the
#                                      safety tag, then refresh apps/<dir> here
#
# Work checkouts live in $MELODICA_APPS_WORK (default: ../melodica-apps-work next to this
# repository), one clone per app with remotes `origin` (our fork) and `upstream`.
# The table is apps/apps.tsv. Nothing here touches a remote except `fetch` and `push`.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${MELODICA_APPS_WORK:-$ROOT/../melodica-apps-work}
TSV=$ROOT/apps/apps.tsv
cmd=${1:-status}; [ $# -gt 0 ] && shift

rows() { # rows [dir...] -> "dir repo branch uprepo upbranch" lines
  want="$*"
  grep -v '^#' "$TSV" | while IFS="$(printf '\t')" read -r dir repo branch uprepo upbranch; do
    [ -n "$dir" ] || continue
    if [ -n "$want" ]; then case " $want " in *" $dir "*) ;; *) continue;; esac; fi
    printf '%s %s %s %s %s\n' "$dir" "$repo" "$branch" "$uprepo" "$upbranch"
  done
}

checkout() { # checkout dir repo branch uprepo upbranch -> ensures $WORK/dir exists and is fetched
  dir=$1 repo=$2 branch=$3 uprepo=$4 upbranch=$5
  mkdir -p "$WORK"
  if [ ! -d "$WORK/$dir/.git" ]; then
    git clone -q --branch "$branch" "https://github.com/$repo.git" "$WORK/$dir"
  fi
  git -C "$WORK/$dir" remote set-url origin "https://github.com/$repo.git"
  git -C "$WORK/$dir" fetch -q origin "$branch"
  if [ "$uprepo" != "-" ]; then
    git -C "$WORK/$dir" remote get-url upstream >/dev/null 2>&1 || git -C "$WORK/$dir" remote add upstream "https://github.com/$uprepo.git"
    git -C "$WORK/$dir" remote set-url upstream "https://github.com/$uprepo.git"
    git -C "$WORK/$dir" fetch -q upstream "$upbranch"
  fi
}

case "$cmd" in
status)
  printf '%-17s %-22s %-6s %-6s %s\n' app upstream ours theirs base
  rows "$@" | while read -r dir repo branch uprepo upbranch; do
    if [ "$uprepo" = "-" ]; then printf '%-17s %-22s %s\n' "$dir" "(none)" "-"; continue; fi
    checkout "$dir" "$repo" "$branch" "$uprepo" "$upbranch"
    g="git -C $WORK/$dir"
    mb=$($g merge-base "origin/$branch" "upstream/$upbranch" 2>/dev/null || true)
    if [ -z "$mb" ]; then printf '%-17s %-22s %s\n' "$dir" "$uprepo" "no common history"; continue; fi
    printf '%-17s %-22s +%-5s +%-5s %s\n' "$dir" "$uprepo/$upbranch" \
      "$($g rev-list --count "upstream/$upbranch..origin/$branch")" \
      "$($g rev-list --count "origin/$branch..upstream/$upbranch")" \
      "$($g log -1 --format=%cs "$mb")"
  done ;;
fetch)
  rows "$@" | while read -r dir repo branch uprepo upbranch; do
    echo "== $dir"; checkout "$dir" "$repo" "$branch" "$uprepo" "$upbranch"
  done ;;
rebase)
  [ $# -eq 1 ] || { echo "usage: apps/upstream.sh rebase <dir>" >&2; exit 2; }
  set -- $(rows "$1"); [ $# -eq 5 ] || { echo "unknown app" >&2; exit 2; }
  dir=$1 repo=$2 branch=$3 uprepo=$4 upbranch=$5
  [ "$uprepo" != "-" ] || { echo "$dir has no upstream" >&2; exit 2; }
  checkout "$dir" "$repo" "$branch" "$uprepo" "$upbranch"
  cd "$WORK/$dir"
  git checkout -q "$branch"
  git reset -q --hard "origin/$branch"
  tag="pre-rebase/$(date -u +%Y-%m-%dT%H%M%SZ)"
  git tag "$tag" "origin/$branch"
  echo "== $dir: $branch (ours +$(git rev-list --count "upstream/$upbranch..origin/$branch")) onto $uprepo/$upbranch (theirs +$(git rev-list --count "origin/$branch..upstream/$upbranch")); safety tag $tag"
  if git rebase "upstream/$upbranch"; then
    echo "rebased cleanly. Review with: git -C $WORK/$dir log --oneline upstream/$upbranch..$branch"
    echo "then: apps/upstream.sh push $dir"
  else
    echo "conflicts. Resolve in $WORK/$dir (git status; edit; git add; git rebase --continue),"
    echo "or abort with: git -C $WORK/$dir rebase --abort && git -C $WORK/$dir tag -d $tag"
    exit 1
  fi ;;
push)
  [ $# -eq 1 ] || { echo "usage: apps/upstream.sh push <dir>" >&2; exit 2; }
  set -- $(rows "$1"); [ $# -eq 5 ] || { echo "unknown app" >&2; exit 2; }
  dir=$1 repo=$2 branch=$3
  cd "$WORK/$dir"
  [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] && { echo "a rebase is still in progress in $WORK/$dir" >&2; exit 1; }
  [ "$(git rev-parse --abbrev-ref HEAD)" = "$branch" ] || { echo "not on $branch" >&2; exit 1; }
  git push --force-with-lease=$branch:origin/$branch origin "$branch"
  git push -q origin 'refs/tags/pre-rebase/*'
  echo "pushed $repo $branch; refreshing apps/$dir"
  "$ROOT/apps/pull.sh" "$dir" ;;
*) echo "unknown command $cmd" >&2; exit 2 ;;
esac
