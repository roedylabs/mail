#!/bin/sh
# Checks the first line of the commit message for Conventional Commits.
# Called by lefthook (commit-msg) with the path of the message file.
set -eu

first=$(sed -n '1p' "$1")

case $first in
  'Merge '* | 'Revert '* | 'fixup! '* | 'squash! '* | 'amend! '*) exit 0 ;;
esac

types='feat|fix|chore|docs|ci|build|refactor|perf|test|style|revert'
if printf '%s\n' "$first" | grep -Eq "^($types)(\([a-z0-9._/-]+\))?!?: [^ ].*"; then
  exit 0
fi

cat >&2 <<MSG
Commit message does not follow Conventional Commits:
  $first
Expected: <type>(<scope>): <description>, e.g. "feat(server): add health check endpoints"
Types: $(printf '%s' "$types" | tr '|' ' ')
MSG
exit 1
