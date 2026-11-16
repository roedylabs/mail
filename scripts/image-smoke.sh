#!/bin/sh
# Smoke test for the image (release.yml before and after the push, locally `just smoke`):
# starts a container with a named volume, waits for the HEALTHCHECK and
# checks user, endpoints, embedded SPA, setup token and version.
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

docker run -d --name "$name" -p 127.0.0.1::8080 -v "$volume:/data" "$image" >/dev/null
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
pid=$(docker inspect -f '{{.State.Pid}}' "$name")
if [ -r "/proc/$pid/status" ]; then
  kib() { sed -n "s/^$1:[[:space:]]*\([0-9]*\) kB\$/\1/p" "/proc/$pid/status"; }
  mb() { awk -v k="$1" 'BEGIN { printf "%.1f", k * 1024 / 1000000 }'; }
  rss=$(kib VmRSS)
  peak=$(kib VmHWM)
  check "VmRSS in /proc/$pid/status" [ -n "$rss" ]
  check "VmHWM in /proc/$pid/status" [ -n "$peak" ]
  line="Idle RSS: $(mb "$rss") MB (peak since start $(mb "$peak") MB)"
  echo "$line"
  [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "$line" >>"$GITHUB_STEP_SUMMARY"
  check "idle RSS ≤ 40 MB (actual: $(mb "$rss") MB)" [ $((rss * 1024)) -le 40000000 ]
else
  echo "RSS not measured: /proc/$pid/status missing (e.g. Docker Desktop)"
fi

docker stop -t 10 "$name" >/dev/null
check "clean shutdown (exit code 0)" [ "$(docker inspect -f '{{.State.ExitCode}}' "$name")" = 0 ]
echo "Smoke test passed: $image"
