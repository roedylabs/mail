#!/usr/bin/env bash
# Releases in two steps; run via `just`:
#
#   just release 0.2.0       Branch chore/release-0.2.0 from origin/main, version in
#                            package.json, Cargo.toml and Cargo.lock, CHANGELOG.md
#                            (git-cliff), commit, push and PR. A maintainer merges.
#   just release-tag 0.2.0   After the merge: checks version and CHANGELOG on
#                            origin/main, sets the annotated tag v0.2.0 on
#                            origin/main and pushes it. That starts release.yml.
#
# This way the release commit also goes through PR and CI; the pre-push hook
# keeps no exception. Versions stay 0.x for now; pre-releases such as
# 0.2.0-rc.1 appear without "latest".
#
# ROEDY_COMMIT_TRAILERS (optional): lines appended to the commit message,
# e.g. Co-Authored-By.
set -euo pipefail

die() {
  echo "Error: $*" >&2
  exit 1
}

usage="usage: scripts/release.sh prepare|tag <version>, e.g. prepare 0.2.0"
cmd=${1:-}
version=${2:-}
[[ $cmd == prepare || $cmd == tag ]] || die "$usage"
[[ $version =~ ^0\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$ ]] ||
  die "version '$version' invalid – expected 0.x.y or 0.x.y-rc.1, without 'v'"
tag="v$version"

cd "$(git rev-parse --show-toplevel)"

# Version from [workspace.package] in Cargo.toml (stdin).
cargo_version() { sed -n '/^\[workspace\.package\]/,/^\[/ s/^version = "\(.*\)"$/\1/p'; }
# Version from package.json (stdin).
package_version() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).version)'; }
# Exit code 0 if $1 is greater than $2 per SemVer 2.0 (0.2.0-rc.1 < 0.2.0).
semver_gt() {
  node -e '
    const [a, b] = process.argv.slice(1).map((v) => {
      const i = v.indexOf("-");
      return { core: (i < 0 ? v : v.slice(0, i)).split(".").map(Number), pre: i < 0 ? [] : v.slice(i + 1).split(".") };
    });
    const id = (x, y) => {
      const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
      if (nx && ny) return Number(x) - Number(y);
      if (nx !== ny) return nx ? -1 : 1;
      return x < y ? -1 : x > y ? 1 : 0;
    };
    let c = 0;
    for (let k = 0; k < 3 && !c; k++) c = a.core[k] - b.core[k];
    if (!c && (!a.pre.length || !b.pre.length)) c = !a.pre.length - !b.pre.length;
    for (let k = 0; !c && k < Math.min(a.pre.length, b.pre.length); k++) c = id(a.pre[k], b.pre[k]);
    if (!c) c = a.pre.length - b.pre.length;
    process.exit(c > 0 ? 0 : 1);
  ' "$1" "$2"
}
# Escape dots for regular expressions.
version_re=${version//./\\.}

if ! git diff --quiet || ! git diff --cached --quiet; then
  die "working tree has uncommitted changes"
fi
git fetch --quiet origin main --tags
! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "tag $tag already exists"

case $cmd in
prepare)
  current=$(git show origin/main:package.json | package_version)
  [[ $current != "$version" ]] || die "origin/main already has version $version – continue with 'just release-tag $version'"
  # Otherwise "latest" (default in deploy/compose.yml) would move to an older version.
  semver_gt "$version" "$current" || die "version $version is not greater than $current on origin/main"
  branch="chore/release-$version"
  original=$(git symbolic-ref --quiet --short HEAD || git rev-parse HEAD)
  # --no-track: the release branch needs no upstream configuration
  git switch --quiet --no-track -c "$branch" origin/main
  # If a step up to the commit fails, discard branch and changes.
  rollback() {
    local status=$?
    [[ $status -eq 0 ]] && return
    echo "Aborted – discarding $branch and switching back to $original" >&2
    git add -- package.json Cargo.toml Cargo.lock CHANGELOG.md 2>/dev/null || true
    git reset --quiet --hard
    git switch --quiet "$original"
    git branch --quiet -D "$branch"
    exit "$status"
  }
  trap rollback EXIT

  node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    pkg.version = process.argv[1];
    fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  ' "$version"
  sed -i '/^\[workspace\.package\]/,/^\[/ s/^version = ".*"$/version = "'"$version"'"/' Cargo.toml
  [[ $(cargo_version <Cargo.toml) == "$version" ]] || die "version in Cargo.toml not set"
  # Only our own crates in the lockfile; offline if the registry cache suffices.
  cargo update --workspace --offline --quiet 2>/dev/null || cargo update --workspace --quiet

  notes=$(pnpm exec git-cliff --unreleased --tag "$tag" --strip all) || die "git-cliff failed (did you run pnpm install?)"
  # Prepend only the new section, so hand-edited earlier entries stay as they are.
  pnpm exec git-cliff --unreleased --tag "$tag" --prepend CHANGELOG.md || die "git-cliff failed"
  # git-cliff appends blank lines; `git diff --check` (pre-commit) allows none.
  node -e '
    const fs = require("fs");
    fs.writeFileSync("CHANGELOG.md", fs.readFileSync("CHANGELOG.md", "utf8").trimEnd() + "\n");
  '

  git add package.json Cargo.toml Cargo.lock CHANGELOG.md
  message="chore(release): $tag

Version $version in package.json, Cargo.toml and Cargo.lock, CHANGELOG.md
with git-cliff. After the merge \`just release-tag $version\` sets the tag
on main; release.yml then builds and publishes the image."
  if [[ -n ${ROEDY_COMMIT_TRAILERS:-} ]]; then
    message+=$'\n\n'"$ROEDY_COMMIT_TRAILERS"
  fi
  git commit --quiet -m "$message"
  trap - EXIT
  git push --quiet origin "$branch"

  body="Release **$tag**: version in \`package.json\`, \`Cargo.toml\` and \`Cargo.lock\`, \`CHANGELOG.md\` from the commits since the last tag (git-cliff).

After the merge: \`just release-tag $version\` sets the tag on the release commit on \`main\`; \`release.yml\` builds, checks and publishes \`ghcr.io/roedylabs/mail:$version\`.

## Changes

$notes"
  gh pr create --base main --head "$branch" --title "chore(release): $tag" --body "$body"
  ;;

tag)
  # The squash merge appends "(#<PR>)" to the title.
  release=$(git log origin/main -1 --format=%H --extended-regexp \
    --grep="^chore\(release\): v$version_re( \(#[0-9]+\))?$")
  [[ -n $release ]] || die "no commit 'chore(release): $tag' on origin/main – merge the release PR first"
  release_package=$(git show "$release:package.json" | package_version)
  release_cargo=$(git show "$release:Cargo.toml" | cargo_version)
  [[ $release_package == "$version" && $release_cargo == "$version" ]] ||
    die "release commit ${release:0:7} has version $release_package (package.json) or $release_cargo (Cargo.toml), not $version"
  # Without -q grep reads everything; otherwise `git show` aborts with SIGPIPE (pipefail).
  git show "$release:CHANGELOG.md" | grep "^## \[$version_re\]" >/dev/null ||
    die "CHANGELOG.md in release commit ${release:0:7} has no section $version"
  git tag -a "$tag" -m "$tag" "$release"
  git push --quiet origin "refs/tags/$tag"
  echo "Tag $tag pushed on ${release:0:7}; release.yml is running: gh run list --workflow release.yml"
  later=$(git rev-list --count "$release..origin/main")
  if [[ $later -gt 0 ]]; then
    echo "Note: $later newer commits on main do not belong to $tag but to the next release."
  fi
  ;;
esac
