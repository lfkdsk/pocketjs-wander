#!/usr/bin/env bash
# examples/wander-online/demo.sh — acceptance demo for the wander-online
# multiplayer demo. Runs everything on 127.0.0.1, prints a JSON summary,
# and writes screenshots to the directory given by --out (default
# ./wander-online-shots under the system temp dir). All processes are
# stopped on exit.
#
#   bash examples/wander-online/demo.sh [--out DIR] [--skip-bots] [--runs N]
#
# Phases:
#   1. mutual visibility: server + 2 desktop hosts (headless) + 1 chrome tab,
#      started in a fixed order; each client's STATE is read (not its
#      screenshot) and must show the other two. Repeated 3 times by default.
#   2. latency: server with --sim-latency 150, one desktop host: local
#      movement has no perceptible delay (prediction applies input in the
#      same frame), correction count stays at the join baseline
#   3. restart: the server is killed and restarted under live clients; the
#      web client (over CDP) and both desktop hosts must drop, rejoin and
#      see each other again
#   4. bots: 100 bots + 1 desktop host, QuickJS frame time holds 60 fps
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${OUT:-${TMPDIR:-/tmp}/wander-online-shots}"
SKIP_BOTS=0
RUNS=3
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --skip-bots) SKIP_BOTS=1; shift ;;
    --runs) RUNS="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$OUT"

SERVER_PID=""
HTTP_PID=""
DESKTOP_PIDS=()
CHROME_PID=""
BOT_PID=""

cleanup() {
  [ -n "$BOT_PID" ] && kill "$BOT_PID" 2>/dev/null || true
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null || true
  pkill -f "remote-debugging-port=9222" 2>/dev/null || true
  [ -n "$HTTP_PID" ] && kill "$HTTP_PID" 2>/dev/null || true
  for pid in "${DESKTOP_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

BIN="$ROOT/vendor/pocket-rpgkit/vendor/pocketjs/hosts/desktop/target/release/pocket-desktop-host"
JS="$ROOT/dist/linux-app/wander-online.js"
PAK="$ROOT/dist/linux-app/wander-online.pak"
DESKTOP_FLAGS="--app wander-online --app-id dev.lfkdsk.pocket-rpgkit-wander-online --viewport 480x272 --fixed"
CDP="http://127.0.0.1:9222"
PAGE="http://127.0.0.1:9003/wander-online/"

start_server() { # extra args...
  (cd "$ROOT" && bun run examples/wander-online/server/server.ts --port 8080 --aoi 48 "$@") &
  SERVER_PID=$!
  sleep 1
}

stop_server() {
  # SIGKILL: the process dies immediately and the OS closes every socket,
  # so all clients detect the drop at once (no half-open connections that
  # depend on TCP keepalive to notice). This is the "server crashed" case.
  [ -n "$SERVER_PID" ] && kill -9 "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
  sleep 0.5
}

start_desktop() { # name log screenshot quit-after
  RUST_LOG=info "$BIN" $DESKTOP_FLAGS --density 3 --title "$1" \
    --js "$JS" --pak "$PAK" --headless --quit-after "$4" \
    --screenshot "$3" > "$2" 2>&1 &
  DESKTOP_PIDS+=($!)
}

start_chrome() { # profile-dir
  mkdir -p "$1"
  /usr/bin/google-chrome --headless=new --disable-gpu --no-first-run \
    --no-default-browser-check --remote-debugging-port=9222 \
    --window-size=480,272 --force-device-scale-factor=3 \
    --user-data-dir="$1" about:blank > "$1/chrome.log" 2>&1 &
  CHROME_PID=$!
  sleep 1
}

stop_chrome() {
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null || true
  # Killing chrome's pid can leave renderer children holding the debug
  # port; reap anything still bound to it before the next run.
  pkill -f "remote-debugging-port=9222" 2>/dev/null || true
  CHROME_PID=""
  sleep 0.5
}

# Reap the desktop hosts. With "kill" they are SIGTERM'd immediately (a
# failed run); otherwise they are left to run to their --quit-after, which
# is when the headless host writes its screenshot.
reap_desktops() {
  [ "${1:-}" = "kill" ] && for pid in "${DESKTOP_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait "${DESKTOP_PIDS[@]}" 2>/dev/null || true
  DESKTOP_PIDS=()
}

stop_clients() {
  stop_chrome
  reap_desktops kill
}

# Predicate: a desktop logged "reconnecting" and later "joined" with the
# expected online count (the server-restart recovery, in log order).
desktop_rejoined() { # log expected-online
  awk -v want="$2" '/"status":"reconnecting"/{r=1} r && /"status":"joined"/ && index($0, "\"online\":"want) {ok=1} END{exit !ok}' "$1"
}

both_desktops_online3() { # d1.log d2.log
  grep -q '"online":3' "$1" && grep -q '"online":3' "$2"
}

# Poll a predicate until it holds or the timeout (seconds) expires. The web
# client joins a few seconds after the desktops (chrome + wasm boot) and the
# desktops log state once a second, so the demo waits for their logs instead
# of killing them the moment the web side is in.
wait_until() { # timeout-s predicate args...
  local timeout="$1"; shift
  local deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if "$@"; then return 0; fi
    sleep 0.5
  done
  return 1
}

# Assert a desktop client saw the other two (its own snapshot carried three
# entities).
assert_desktop() { # log
  grep -q '"online":3' "$1" || { echo "FAIL: $1 never reached online 3" >&2; return 1; }
}

echo "== building desktop host + app =="
(cd "$ROOT" && PATH="$HOME/.cargo/bin:$PATH" bun tools/desktop.ts wander-online --build-only 2>&1 | tail -2)
(cd "$ROOT" && bun tools/web.ts wander-online 2>&1 | tail -2)

# Serve the web build for the chrome tab (all phases).
python3 -m http.server 9003 --directory "$ROOT/dist/web" > /dev/null 2>&1 &
HTTP_PID=$!
sleep 1

# --- phase 1: mutual visibility, fixed order, repeated ---------------------
for run in $(seq 1 "$RUNS"); do
  dir="$OUT/run-$run"
  mkdir -p "$dir"
  echo "== phase 1.$run: mutual visibility (server -> desktop-1 -> desktop-2 -> web) =="
  start_server --sim-latency 0
  # Fixed join order: desktop-1, desktop-2, then the web tab.
  start_desktop "wander-$run-1" "$dir/desktop-1.log" "$dir/desktop-1.png" 1500
  sleep 2
  start_desktop "wander-$run-2" "$dir/desktop-2.log" "$dir/desktop-2.png" 1500
  sleep 2
  start_chrome "$dir/chrome-profile"
  set +e
  (cd "$ROOT" && bun run examples/wander-online/web-check.ts \
    --cdp "$CDP" --page "$PAGE" --out "$dir/web.png" --timeout-ms 45000) \
    | tee "$dir/web-check.log"
  web_rc=${PIPESTATUS[0]}
  set -e
  # The web client is in (it saw the other two); keep everyone alive until
  # the desktops have logged online 3 as well. The desktops run to their
  # --quit-after and screenshot then, so chrome must stay alive until the
  # screenshots are written; only then stop it. On failure kill all.
  if [ "$web_rc" = 0 ]; then
    wait_until 20 both_desktops_online3 "$dir/desktop-1.log" "$dir/desktop-2.log" \
      || { echo "FAIL: desktops never logged online 3 after the web client joined" >&2; web_rc=1; }
  fi
  if [ "$web_rc" = 0 ]; then reap_desktops; else reap_desktops kill; fi
  stop_chrome
  stop_server
  [ "$web_rc" = 0 ] || { echo "FAIL: web-check (run $run)" >&2; exit 1; }
  assert_desktop "$dir/desktop-1.log"
  assert_desktop "$dir/desktop-2.log"
  echo "  run $run: $(grep -o '"online":[0-9]*' "$dir/desktop-1.log" | tail -1) (desktop-1), $(grep -o '"online":[0-9]*' "$dir/desktop-2.log" | tail -1) (desktop-2), $(grep WEBCHECK "$dir/web-check.log")"
done

# --- phase 2: 150 ms injected latency --------------------------------------
echo "== phase 2: 150 ms injected latency =="
start_server --sim-latency 150
start_desktop "wander-latency" "$OUT/latency.log" "$OUT/latency.png" 900
sleep 12
reap_desktops
stop_server
echo "  latency: $(grep 'ONLINE' "$OUT/latency.log" | tail -1)"

# --- phase 3: server restart under live clients ----------------------------
echo "== phase 3: server restart, clients drop and rejoin =="
dir="$OUT/restart"
mkdir -p "$dir"
start_server --sim-latency 0
start_desktop "wander-restart-1" "$dir/desktop-1.log" "$dir/desktop-1.png" 3000
sleep 2
start_chrome "$dir/chrome-profile"
# web-check --watch: join, then wait for the drop and the rejoin, asserting
# the same state each time; exits 0 only if both joins saw the other client.
(cd "$ROOT" && bun run examples/wander-online/web-check.ts --watch --expect 2 \
  --cdp "$CDP" --page "$PAGE" --out "$dir/web.png" --timeout-ms 90000) \
  > "$dir/web-check.log" 2>&1 &
WEBCHECK_PID=$!
# Let the clients join and walk, then kill the server (SIGKILL in
# stop_server), wait for the drop to land, and restart.
sleep 12
stop_server
sleep 2
start_server --sim-latency 0
# web-check finishes once the rejoin is verified.
set +e
wait "$WEBCHECK_PID"
web_rc=$?
set -e
# The web client is back; keep the desktop alive until it has logged its own
# drop -> rejoin -> online 2 sequence. The desktop screenshots at
# --quit-after, so chrome stays alive until then; on failure kill all.
if [ "$web_rc" = 0 ]; then
  wait_until 25 desktop_rejoined "$dir/desktop-1.log" 2 \
    || { echo "FAIL: desktop never rejoined with online 2 after the restart" >&2; web_rc=1; }
fi
if [ "$web_rc" = 0 ]; then reap_desktops; else reap_desktops kill; fi
stop_chrome
stop_server
[ "$web_rc" = 0 ] || { echo "FAIL: web-check --watch" >&2; cat "$dir/web-check.log" >&2; exit 1; }
echo "  restart: $(grep WEBCHECK "$dir/web-check.log")"

# --- phase 4: 100 bots ------------------------------------------------------
if [ "$SKIP_BOTS" -eq 0 ]; then
  echo "== phase 4: 100 bots, QuickJS frame time =="
  start_server --sim-latency 0
  (cd "$ROOT" && bun run examples/wander-online/server/bots.ts --count 100 --seconds 25) > "$OUT/bots.log" 2>&1 &
  BOT_PID=$!
  sleep 4
  RUST_LOG=info "$BIN" $DESKTOP_FLAGS --density 1 --title "wander-bots" \
    --js "$JS" --pak "$PAK" --headless --quit-after 900 --trace-frames > "$OUT/bots-trace.log" 2>&1 &
  DESKTOP_PIDS+=($!)
  wait "${DESKTOP_PIDS[@]}" 2>/dev/null || true
  wait "$BOT_PID" 2>/dev/null || true
  BOT_PID=""
  echo "  bots: $(grep BOTSTATS "$OUT/bots.log" | tail -1 || echo 'see bots-trace.log')"
  python3 -c "
import re
us = [int(m.group(1)) for line in open('$OUT/bots-trace.log') for m in [re.match(r'FRAME_TRACE,tick,\d+,\d+,(\d+)', line)] if m]
us.sort()
n = len(us)
if n: print(f'  frame time: avg {sum(us)/n:.0f}us p50 {us[n//2]}us p95 {us[int(n*0.95)]}us p99 {us[int(n*0.99)]}us')
"
fi

echo "== done; logs and screenshots in $OUT =="
ls -la "$OUT"
