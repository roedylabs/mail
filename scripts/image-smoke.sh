#!/bin/sh
# Smoke test for the image (release.yml before and after the push, locally `just smoke`):
# starts a container with a named volume and the restrictions of
# deploy/compose.yml, waits for the HEALTHCHECK and checks user and privileges
# of the process, endpoints, embedded SPA, setup token and version.
#
#   scripts/image-smoke.sh <image> [<version>]
set -eu

image=${1:?usage: scripts/image-smoke.sh <image> [<version>]}
version=${2:-}
name="roedy-mail-smoke-$$"
volume="$name-data"

fail() {
  echo "Smoke test failed: $*" >&2
  docker logs "$name" >&2 2>&1 || true
  exit 1
}
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

[ "$(docker image inspect -f '{{.Config.User}}' "$image")" = 65532:65532 ] || fail "USER is not 65532:65532"

# The same restrictions as deploy/compose.yml: read-only file system apart from
# /data and a tmpfs on /tmp, no capabilities, no privilege escalation.
docker run -d --name "$name" -p 127.0.0.1::8080 -v "$volume:/data" \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  "$image" >/dev/null
url="http://$(docker port "$name" 8080/tcp | head -n 1)"

# HEALTHCHECK (roedy-mail healthcheck) must report "healthy" within 30 s.
i=0
while :; do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$name")
  [ "$status" = healthy ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || fail "container exited"
  i=$((i + 1))
  [ "$i" -le 30 ] || fail "not healthy after 30 s (status $status)"
  sleep 1
done

check() { # <description> <command …>
  what=$1
  shift
  "$@" || fail "$what"
}
body() { curl -fsS "$url$1"; }
status() { curl -s -o /dev/null -w '%{http_code}' "$url$1"; }

# The server process as the host sees it (the image has no shell): UID and GID
# 65532 (real, effective, saved, file system), no capabilities, no_new_privs.
# Without /proc (Docker Desktop) only a note; in CI the check is mandatory.
pid=$(docker inspect -f '{{.State.Pid}}' "$name")
proc="/proc/$pid/status"
# With user namespace remapping (userns-remap) the host sees the remapped IDs,
# not 65532: then only Config.User applies; not on GitHub's runners.
userns=$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -c 'name=userns' || true)
if [ -r "$proc" ]; then
  field() { sed -n "s/^$1:[[:space:]]*//p" "$proc" | tr -s '[:space:]' ' ' | sed 's/ $//'; }
  if [ "$userns" = 0 ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
    check "UID 65532 (Uid: $(field Uid))" [ "$(field Uid)" = "65532 65532 65532 65532" ]
    check "GID 65532 (Gid: $(field Gid))" [ "$(field Gid)" = "65532 65532 65532 65532" ]
  else
    echo "UID and GID of the process not checked: the Docker daemon remaps user namespaces"
  fi
  check "no effective capabilities (CapEff: $(field CapEff))" [ "$(field CapEff)" = 0000000000000000 ]
  check "empty capability bounding set (CapBnd: $(field CapBnd))" [ "$(field CapBnd)" = 0000000000000000 ]
  check "no_new_privs (NoNewPrivs: $(field NoNewPrivs))" [ "$(field NoNewPrivs)" = 1 ]
elif [ -n "${GITHUB_ACTIONS:-}" ]; then
  fail "$proc missing, user and privileges of the process not checked"
else
  echo "User and privileges of the process not checked: $proc missing (e.g. Docker Desktop)"
fi

check "/healthz" sh -c "curl -fsS '$url/healthz' | grep -q '\"ok\"'"
check "/readyz" sh -c "curl -fsS '$url/readyz' | grep -q '\"ok\"'"
check "index.html embedded" sh -c "curl -fsS '$url/' | grep -q '<html'"
check "SPA fallback" sh -c "curl -fsS '$url/login' | grep -q '<html'"
check "licenses.json" sh -c "curl -fsS '$url/licenses.json' | grep -q 'axum'"
check "missing asset → 404" [ "$(status /_app/immutable/missing.js)" = 404 ]
check "/api → 404" [ "$(status /api/v1/does-not-exist)" = 404 ]
asset=$(body / | grep -o '/_app/immutable/[^"]*\.js' | head -n 1)
check "asset from index.html ($asset)" sh -c "curl -fsS -D - -o /dev/null '$url$asset' | grep -qi 'cache-control: public, max-age=31536000, immutable'"
# SvelteKit's startup script is inline; the CSP must name its hash.
check "CSP with the hash of the startup script" sh -c "curl -fsS -D - -o /dev/null '$url/' | grep -qi \"^content-security-policy: .*script-src 'self' 'sha256-\""
check "key file created in the data directory" sh -c "docker logs '$name' 2>&1 | grep -q 'secret.key (newly created)'"

logged=$(docker logs "$name" 2>&1 | sed -n 's/.*Setup-Token: \([A-Z2-9-]*\).*/\1/p' | head -n 1)
shown=$(docker exec "$name" roedy-mail setup-token | sed -n 's/^Setup-Token: //p')
check "setup token in the log" [ -n "$logged" ]
check "setup token via 'docker exec … roedy-mail setup-token'" [ "$logged" = "$shown" ]

if [ -n "$version" ]; then
  actual=$(docker exec "$name" roedy-mail --version)
  check "version $version (actual: $actual)" [ "$actual" = "roedy-mail $version" ]
fi

# Idle memory after the requests above (goal: RSS ≤ 40 MB):
# VmRSS of the server process via the host's /proc, in MB = 10^6 bytes like the
# image size in release.yml. Without /proc (Docker Desktop) only a note.
sleep 1
if [ -r "$proc" ]; then
  kib() { sed -n "s/^$1:[[:space:]]*\([0-9]*\) kB\$/\1/p" "$proc"; }
  mb() { awk -v k="$1" 'BEGIN { printf "%.1f", k * 1024 / 1000000 }'; }
  rss=$(kib VmRSS)
  peak=$(kib VmHWM)
  check "VmRSS in $proc" [ -n "$rss" ]
  check "VmHWM in $proc" [ -n "$peak" ]
  line="Idle RSS: $(mb "$rss") MB (peak since start $(mb "$peak") MB)"
  echo "$line"
  [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "$line" >>"$GITHUB_STEP_SUMMARY"
  check "idle RSS ≤ 40 MB (actual: $(mb "$rss") MB)" [ $((rss * 1024)) -le 40000000 ]
else
  echo "RSS not measured: $proc missing (e.g. Docker Desktop)"
fi

docker stop -t 10 "$name" >/dev/null
check "clean shutdown (exit code 0)" [ "$(docker inspect -f '{{.State.ExitCode}}' "$name")" = 0 ]
echo "Smoke test passed: $image"
