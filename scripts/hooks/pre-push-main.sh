#!/bin/sh
# Prevents direct pushes to main: changes go through a branch and a PR.
# Deliberate exception: ROEDY_PUSH_MAIN=1 git push …
# Git passes one line per ref: "<local ref> <local sha> <remote ref> <remote sha>".
set -eu

[ "${ROEDY_PUSH_MAIN:-0}" = 1 ] && exit 0

while read -r _local_ref _local_sha remote_ref _remote_sha; do
  if [ "$remote_ref" = refs/heads/main ]; then
    echo "Direct push to main is not allowed – please use a branch and a PR." >&2
    exit 1
  fi
done
exit 0
